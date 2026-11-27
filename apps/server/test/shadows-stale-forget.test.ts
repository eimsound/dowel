// 跨副本 shadows.forget 晚到（Issue #148）：副本 A 改完配置、发出 shadows.forget，副本 B 在事件送达之前
// 已经按新配置 forProject 建好了新的缓存条目并开始用它；晚到的事件不能把这个按最新配置建立的条目关掉
// （否则 B 上正在进行的验证会以“影子库不可用：连接失败：write CONNECTION_ENDED”失败，而数据库本身好好的）。
// 同时保持原有的失效语义：配置确实变了、环境 / 项目被删、读配置失败时照样关闭并移除。
//
// 不连真实数据库：平台库用 SQLite :memory:，pg 驱动的 prepareShadow 换成假的影子库，事件总线用可控的假总线，
// 事件何时送达完全由测试决定。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ClusterEvent, ClusterEventHandler, EventBus, ReconnectHandler } from '../src/bus.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { encrypt } from '../src/secrets.ts';
import type { Shadow } from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import { registerTargetDriver } from '../src/targets.ts';
import { pgTargetDriver } from '../src/targets/pg.ts';

const PID = 'p-stale';
const EID = 'e-stale';
const URL_1 = 'postgres://u:p@db-1.invalid:5432/app';
const URL_2 = 'postgres://u:p@db-2.invalid:5432/app';
const URL_3 = 'postgres://u:p@db-3.invalid:5432/app';

interface FakeShadow extends Shadow {
  url: string;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const built: FakeShadow[] = [];
let beforePrepare: (() => Promise<void> | void) | undefined;

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** 假总线：事件只在测试调用 deliver 时送达，并等处理器跑完 */
const fakeBus = () => {
  const events = new Set<ClusterEventHandler>();
  const reconnects = new Set<ReconnectHandler>();
  const bus = {
    replicaId: 'rep-b',
    onEvent: (h: ClusterEventHandler) => {
      events.add(h);
      return () => events.delete(h);
    },
    onReconnect: (h: ReconnectHandler) => {
      reconnects.add(h);
      return () => reconnects.delete(h);
    },
    publish: async () => {},
  };
  const deliver = async (event: Omit<ClusterEvent & { t: 'shadows.forget' }, 'origin'>) => {
    for (const h of events) await h({ ...event, origin: 'rep-a' });
  };
  return { bus: bus as unknown as EventBus, deliver };
};

const prevSecret = process.env.DOWEL_SECRET;

beforeAll(() => {
  process.env.DOWEL_SECRET = 'shadows-stale-forget-16chars';
  registerTargetDriver({
    ...pgTargetDriver,
    prepareShadow: async (env) => {
      await beforePrepare?.();
      const shadow = {
        url: env!.shadowUrl ?? env!.url,
        importSql: async () => {
          throw new Error('not used');
        },
        verify: async () => {
          throw new Error('not used');
        },
        verifyScripts: async () => {
          throw new Error('not used');
        },
        canonicalize: async () => [],
        close: vi.fn(async () => {}),
      } as FakeShadow;
      built.push(shadow);
      return { shadow, label: env!.name, url: shadow.url, created: null };
    },
  });
});

afterAll(() => {
  registerTargetDriver(pgTargetDriver);
  if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
  else process.env.DOWEL_SECRET = prevSecret;
});

describe('Shadows：跨副本 shadows.forget 晚到时按最新配置复核缓存（Issue #148）', () => {
  let db: PlatformDb;
  let shadows: Shadows;
  let deliver: ReturnType<typeof fakeBus>['deliver'];

  beforeEach(async () => {
    built.length = 0;
    beforePrepare = undefined;
    db = await openPlatformDb(':memory:');
    await db.query("insert into groups (id, slug, name) values ('g-stale', 'g-stale', '组')");
    await db.query(
      "insert into projects (id, name, group_id, slug) values ($1, '项目', 'g-stale', 'p-stale')",
      [PID],
    );
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
       values ($1, $2, 'dev', $3, false, false, null)`,
      [EID, PID, encrypt(URL_1)],
    );
    const fb = fakeBus();
    deliver = fb.deliver;
    shadows = new Shadows(db, undefined, fb.bus);
  });

  afterEach(async () => {
    beforePrepare = undefined;
    await shadows.close();
    await db.close();
  });

  /** 模拟副本 A 改连接串（A 的路由随后会广播 shadows.forget，送达时间由测试决定） */
  const changeUrl = (url: string) =>
    db.query('update environments set url_enc = $2 where id = $1', [EID, encrypt(url)]);

  /** 挂起下一次读环境配置的 SQL（revalidateLocal 查库），返回进入信号、放行函数与恢复 spy 函数 */
  const holdNextEnvQuery = () => {
    const entered = deferred();
    const gate = deferred();
    const origQuery = db.query.bind(db);
    let intercepted = false;
    const spy = vi.spyOn(db, 'query').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (!intercepted && sql.includes('from environments e join projects p')) {
        intercepted = true;
        entered.resolve();
        await gate.promise;
      }
      return origQuery(sql, params);
    }) as typeof db.query);
    return {
      entered: entered.promise,
      release: () => gate.resolve(),
      restore: () => {
        gate.resolve();
        spy.mockRestore();
      },
    };
  };

  test('B 已按新配置重建缓存后，晚到的 envIds 事件不关闭新条目；旧条目照样只关一次', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    expect(s1.url).toBe(URL_1);

    await changeUrl(URL_2);
    // 事件还没到，B 先来了下一次请求：指纹不一致，关掉旧的、按新配置重建
    const s2 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    expect(s2).not.toBe(s1);
    expect(s2.url).toBe(URL_2);
    expect(s1.close).toHaveBeenCalledTimes(1);

    // A 的 shadows.forget 这时才送达
    await deliver({ t: 'shadows.forget', envIds: [EID] });

    expect(s2.close).not.toHaveBeenCalled();
    expect(shadows.has(EID)).toBe(true);
    expect((await shadows.forProject(PID, EID)).shadow).toBe(s2);
    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(2);
  });

  test('B 已按新 schema 范围重建缓存后，晚到的 projectId 事件同样不关闭新条目', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await db.query('update projects set schemas = $2 where id = $1', [PID, JSON.stringify(['app'])]);
    const s2 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    expect(s2).not.toBe(s1);
    expect(s1.close).toHaveBeenCalledTimes(1);

    await deliver({ t: 'shadows.forget', projectId: PID, envIds: [EID] });

    expect(s2.close).not.toHaveBeenCalled();
    expect((await shadows.forProject(PID, EID)).shadow).toBe(s2);
  });

  test('配置确实变了而 B 还没重建：事件照样主动关闭并移除旧条目', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await changeUrl(URL_2);

    await deliver({ t: 'shadows.forget', envIds: [EID] });

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(shadows.has(EID)).toBe(false);
    const s2 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    expect(s2.url).toBe(URL_2);
  });

  test('项目范围变了（只带 projectId）而 B 还没重建：关闭该项目下的条目', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await db.query('update projects set schemas = $2 where id = $1', [PID, JSON.stringify(['app'])]);

    await deliver({ t: 'shadows.forget', projectId: PID });

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(shadows.size).toBe(0);
  });

  test('环境已删除：事件关闭并移除条目', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await db.query('delete from environments where id = $1', [EID]);

    await deliver({ t: 'shadows.forget', envIds: [EID] });

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(shadows.size).toBe(0);
  });

  test('复核时读不到配置（平台库出错）：保守地关闭并移除条目', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    const query = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('平台库挂了'));
    try {
      await deliver({ t: 'shadows.forget', envIds: [EID] });
    } finally {
      query.mockRestore();
    }

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(shadows.size).toBe(0);
  });

  test('all 事件不复核，直接清空全部缓存', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;

    await deliver({ t: 'shadows.forget', all: true });

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(shadows.size).toBe(0);
  });

  test('prepareShadow 期间缓存为空时收到远端 shadows.forget：关闭旧配置句柄并按最新配置重建', async () => {
    const entered = deferred();
    const gate = deferred();
    beforePrepare = async () => {
      beforePrepare = undefined;
      entered.resolve();
      await gate.promise;
    };

    try {
      const pending = shadows.forProject(PID, EID);
      await entered.promise;
      expect(shadows.has(EID)).toBe(false);

      await changeUrl(URL_2);
      await deliver({ t: 'shadows.forget', envIds: [EID] });

      gate.resolve();
      const res = await pending;

      expect(built).toHaveLength(2);
      const [s1, s2] = built;
      expect(s1!.url).toBe(URL_1);
      expect(s1!.close).toHaveBeenCalledTimes(1);
      expect(res.shadow).toBe(s2);
      expect(s2!.url).toBe(URL_2);
      expect(s2!.close).not.toHaveBeenCalled();
      expect(shadows.has(EID)).toBe(true);
      expect((await shadows.forProject(PID, EID)).shadow).toBe(s2);
    } finally {
      beforePrepare = undefined;
      gate.resolve();
    }
  });

  test('revalidateLocal 读配置期间条目被并发替换为最新条目：不按旧条目误关新条目并保留在缓存', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await changeUrl(URL_2);

    const held = holdNextEnvQuery();
    try {
      const delivered = deliver({ t: 'shadows.forget', envIds: [EID] });
      await held.entered;

      const s2 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
      expect(s2).not.toBe(s1);
      expect(s2.url).toBe(URL_2);
      expect(s1.close).toHaveBeenCalledTimes(1);

      held.release();
      await delivered;

      expect(s2.close).not.toHaveBeenCalled();
      expect(shadows.has(EID)).toBe(true);
      expect((await shadows.forProject(PID, EID)).shadow).toBe(s2);
      expect(s1.close).toHaveBeenCalledTimes(1);
    } finally {
      held.restore();
    }
  });

  test('revalidateLocal 读配置期间条目被并发替换，若新条目相对最新配置仍过期则继续复核并关闭', async () => {
    const s1 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
    await changeUrl(URL_2);

    const held = holdNextEnvQuery();
    try {
      const delivered = deliver({ t: 'shadows.forget', envIds: [EID] });
      await held.entered;

      const s2 = (await shadows.forProject(PID, EID)).shadow as FakeShadow;
      expect(s2.url).toBe(URL_2);
      expect(s1.close).toHaveBeenCalledTimes(1);

      await changeUrl(URL_3);
      held.release();
      await delivered;

      expect(s2.close).toHaveBeenCalledTimes(1);
      expect(shadows.has(EID)).toBe(false);
      expect(((await shadows.forProject(PID, EID)).shadow as FakeShadow).url).toBe(URL_3);
    } finally {
      held.restore();
    }
  });
});
