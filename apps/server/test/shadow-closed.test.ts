// 影子库句柄关闭之后不能再用、也不能悄悄重连（Issue #154）：
// - serialShadowConnection（PG / MySQL / MSSQL 共用）的关闭语义：关闭后新操作 / 排队中的操作拒绝且不建连，
//   在途操作以 ShadowConfigChangedError 结束，close() 进行中开始的操作拿不到正在关闭的连接；
// - 三个外部影子库实现的真实接线：用“连接前检查”（guard）当建连计数器，不连任何真实数据库；
// - 生产环境的例子：环境改成禁止同实例影子库时，拿着旧句柄、正在做多步操作的请求连不回旧影子库；
// - Shadows.forProject 每次 await 之后都重新检查 closed 与失效代际，不把旧配置句柄或关闭之后建出的句柄放进缓存。
import { emptyModel } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ClusterEvent, ClusterEventHandler, EventBus, ReconnectHandler } from '../src/bus.ts';
import { openPlatformDb } from '../src/db.ts';
import { encrypt } from '../src/secrets.ts';
import {
  type ImportableSql,
  type Shadow,
  ShadowConfigChangedError,
  ShadowError,
  ShadowUnavailableError,
} from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import { registerTargetDriver } from '../src/targets.ts';
import { mssqlShadow } from '../src/targets/mssql.ts';
import { mysqlShadow } from '../src/targets/mysql.ts';
import { pgShadow, pgTargetDriver } from '../src/targets/pg.ts';
import { serialShadowConnection } from '../src/targets/shadow-handle.ts';
import type {
  ConnectionGuard,
  PreparedShadow,
  ShadowSource,
  TargetConnection,
} from '../src/targets/types.ts';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** 立刻挂上处理器（避免未处理的 rejection），返回 resolve 值或 rejection 原因 */
const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    (v) => v,
    (e: unknown) => e,
  );

const empty = emptyModel('pg');

/** 依次调用句柄的全部操作，返回每个操作的结果 / 错误 */
const everyOp = (s: Shadow) =>
  Promise.all([
    settle(s.importSql('select 1' as ImportableSql)),
    settle(s.verify(empty, empty)),
    settle(s.verifyScripts(empty, empty, [], [])),
    settle(s.canonicalize(empty, empty)),
  ]);

describe('serialShadowConnection：关闭语义', () => {
  const fakeConnections = () => {
    const opened: (TargetConnection & { close: ReturnType<typeof vi.fn<() => Promise<void>>> })[] = [];
    let closeGate: Promise<void> | null = null;
    const connect = () => {
      const c = {
        db: {} as Db,
        close: vi.fn(async () => {
          await closeGate;
        }),
      };
      opened.push(c);
      return c;
    };
    return {
      opened,
      connect,
      holdClose: (p: Promise<void>) => {
        closeGate = p;
      },
    };
  };

  test('关闭后：新操作与排队中的操作都拒绝、不建连；在途操作即使成功也丢弃结果', async () => {
    const { opened, connect } = fakeConnections();
    const s = serialShadowConnection(connect);
    expect(await s.run(async () => 'first')).toBe('first');
    expect(opened).toHaveLength(1);

    const entered = deferred();
    const gate = deferred();
    const inFlight = settle(
      s.run(async () => {
        entered.resolve();
        await gate.promise;
        return 'stale result';
      }),
    );
    const queuedOp = vi.fn(async () => 'queued');
    const queued = settle(s.run(queuedOp));
    await entered.promise;

    await s.close();
    expect(opened[0]!.close).toHaveBeenCalledTimes(1);
    const afterOp = vi.fn(async () => 'after');
    const after = settle(s.run(afterOp));

    gate.resolve();
    expect(await inFlight).toBeInstanceOf(ShadowConfigChangedError);
    expect(await queued).toBeInstanceOf(ShadowConfigChangedError);
    expect(await after).toBeInstanceOf(ShadowConfigChangedError);
    expect(queuedOp).not.toHaveBeenCalled();
    expect(afterOp).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
  });

  test('在途操作失败（连接被关掉引发的驱动错误）：同样以“配置已变更”结束，不是“影子库不可用”', async () => {
    const { opened, connect } = fakeConnections();
    const s = serialShadowConnection(connect);
    const entered = deferred();
    const gate = deferred();
    const inFlight = settle(
      s.run(async () => {
        entered.resolve();
        await gate.promise;
        throw new ShadowUnavailableError('连接失败：write CONNECTION_ENDED');
      }),
    );
    await entered.promise;
    await s.close();
    gate.resolve();
    const e = await inFlight;
    expect(e).toBeInstanceOf(ShadowConfigChangedError);
    expect((e as Error).message).toBe('影子库配置已变更，请重试');
    expect(opened).toHaveLength(1);
  });

  test('close() 进行中（还在等旧连接关完）开始的操作直接拒绝，拿不到正在关闭的连接', async () => {
    const { opened, connect, holdClose } = fakeConnections();
    const s = serialShadowConnection(connect);
    await s.run(async () => {});
    const closeGate = deferred();
    holdClose(closeGate.promise);

    const closing = s.close();
    const op = vi.fn(async () => 'x');
    const during = settle(s.run(op));
    expect(await during).toBeInstanceOf(ShadowConfigChangedError);
    expect(op).not.toHaveBeenCalled();
    closeGate.resolve();
    await closing;
    // 重复关闭无害
    await s.close();
    expect(opened).toHaveLength(1);
  });

  test('未关闭时：出错丢弃连接，下一次操作照常重新建连（原有行为）', async () => {
    const { opened, connect } = fakeConnections();
    const s = serialShadowConnection(connect);
    const e = await settle(
      s.run(async (_c, discard) => {
        await discard();
        throw new ShadowUnavailableError('连接失败');
      }),
    );
    expect(e).toBeInstanceOf(ShadowUnavailableError);
    expect(e).not.toBeInstanceOf(ShadowConfigChangedError);
    expect(await s.run(async () => 'ok')).toBe('ok');
    expect(opened).toHaveLength(2);
    expect(opened[0]!.close).toHaveBeenCalledTimes(1);
  });
});

// 连接前检查（guard）在每条新连接第一次用之前调用一次：用它数“建了几条连接”，并让它失败或挂起，不连任何真实数据库
describe.each([
  { engine: 'PG', make: (g: ConnectionGuard) => pgShadow('postgres://u:p@127.0.0.1:1/app_dowel', null, g) },
  {
    engine: 'MySQL',
    make: (g: ConnectionGuard) => mysqlShadow('mysql://u:p@127.0.0.1:1/app_dowel', null, g),
  },
  {
    engine: 'MSSQL',
    make: (g: ConnectionGuard) => mssqlShadow('mssql://u:p@127.0.0.1:1/app_dowel', null, g),
  },
])('$engine 影子库句柄：关闭后不重连', ({ make }) => {
  test('关闭后每个操作都以“配置已变更”拒绝，且不再建连', async () => {
    const guard = vi.fn(async () => {
      throw new Error('test: blocked before connecting');
    });
    const s = make(guard);
    // 关闭前：照常建连（这里被 guard 拦下），报的是“影子库不可用”
    const before = await settle(s.verify(empty, empty));
    expect(before).toBeInstanceOf(ShadowUnavailableError);
    expect(guard).toHaveBeenCalledTimes(1);

    await s.close();
    for (const r of await everyOp(s)) expect(r).toBeInstanceOf(ShadowConfigChangedError);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  test('正在建连的在途操作被 close() 打断：以“配置已变更”结束；关闭期间和之后的操作不建新连接', async () => {
    const entered = deferred();
    const gate = deferred();
    const guard = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const s = make(guard);
    const inFlight = settle(s.verify(empty, empty));
    await entered.promise;

    // MySQL / MSSQL 的连接关闭要等正在进行的建连结束，所以先不 await
    const closing = s.close();
    const during = settle(s.verifyScripts(empty, empty, [], []));
    gate.resolve();
    await closing;

    expect(await inFlight).toBeInstanceOf(ShadowConfigChangedError);
    expect(await during).toBeInstanceOf(ShadowConfigChangedError);
    for (const r of await everyOp(s)) expect(r).toBeInstanceOf(ShadowConfigChangedError);
    expect(guard).toHaveBeenCalledTimes(1);
  });
});

// ───── Shadows 缓存 ─────

const PID = 'p-closed';
const EID = 'e-closed';
const URL_1 = 'postgres://u:p@db-1.invalid:5432/app';
const URL_2 = 'postgres://u:p@db-2.invalid:5432/app';
const URL_3 = 'postgres://u:p@db-3.invalid:5432/app';

type Prepare = (env: ShadowSource, schemas: string[] | null) => Promise<PreparedShadow>;
let prepareImpl: Prepare | null = null;
const prevSecret = process.env.DOWEL_SECRET;

beforeAll(() => {
  process.env.DOWEL_SECRET = 'shadow-closed-test-16chars';
  registerTargetDriver({
    ...pgTargetDriver,
    prepareShadow: (env, schemas) => prepareImpl!(env!, schemas),
  });
});

afterAll(() => {
  registerTargetDriver(pgTargetDriver);
  if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
  else process.env.DOWEL_SECRET = prevSecret;
});

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

const setup = async (env: { production: boolean; allowSameInstance: boolean }) => {
  const db = await openPlatformDb(':memory:');
  await db.query("insert into groups (id, slug, name) values ('g-closed', 'g-closed', '组')");
  await db.query(
    "insert into projects (id, name, group_id, slug) values ($1, '项目', 'g-closed', 'p-closed')",
    [PID],
  );
  await db.query(
    `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
     values ($1, $2, 'prod', $3, $4, $5, null)`,
    [EID, PID, encrypt(URL_1), env.production, env.allowSameInstance],
  );
  const fb = fakeBus();
  // 不注入 guard：forProject 自己的白名单复查不参与计数，建连只由影子库句柄自己的 guard 计数
  const shadows = new Shadows(db, undefined, fb.bus);
  return { db, shadows, deliver: fb.deliver };
};

describe('生产环境的例子：改为禁止同实例影子库后，拿着旧句柄的请求连不回旧影子库', () => {
  const SAME_INSTANCE = 'postgres://u:p@127.0.0.1:1/app_dowel';
  let ctx: Awaited<ReturnType<typeof setup>>;
  let entered: Deferred;
  let gate: Deferred;
  let connGuard: ReturnType<typeof vi.fn<ConnectionGuard>>;

  beforeEach(async () => {
    ctx = await setup({ production: true, allowSameInstance: true });
    entered = deferred();
    gate = deferred();
    // 旧句柄的第一条连接“正在建立”（多步操作的第一步在途）
    connGuard = vi.fn<ConnectionGuard>(async () => {
      entered.resolve();
      await gate.promise;
    });
    prepareImpl = async (env, schemas) => {
      // 生产且不允许同实例：交给真实的 PG 驱动，它在连库之前就拒绝（preConnect）
      if (env.production && !env.allowSameInstance) return pgTargetDriver.prepareShadow(env, schemas);
      return {
        shadow: pgShadow(SAME_INSTANCE, schemas, connGuard),
        label: `${env.name}：app_dowel`,
        url: SAME_INSTANCE,
        created: null,
      };
    };
  });

  afterEach(async () => {
    gate.resolve();
    prepareImpl = null;
    await ctx.shadows.close();
    await ctx.db.close();
  });

  const forbidSameInstance = () =>
    ctx.db.query('update environments set allow_same_instance = false where id = $1', [EID]);

  test.each([
    { via: '本副本改配置（路由调用 shadows.forget）', evict: () => ctx.shadows.forget(EID) },
    {
      via: '其他副本改配置（shadows.forget 事件按最新配置复核）',
      evict: () => ctx.deliver({ t: 'shadows.forget', envIds: [EID] }),
    },
  ])('$via', async ({ evict }) => {
    const held = await ctx.shadows.forProject(PID, EID);
    const step1 = settle(held.shadow.verify(empty, empty));
    await entered.promise;

    await forbidSameInstance();
    await evict();
    expect(ctx.shadows.size).toBe(0);
    gate.resolve();

    expect(await step1).toBeInstanceOf(ShadowConfigChangedError);
    // 多步操作的下一步：拿着旧句柄，也连不回旧的同实例影子库
    expect(await settle(held.shadow.verifyScripts(empty, empty, [], []))).toBeInstanceOf(
      ShadowConfigChangedError,
    );
    expect(await settle(held.shadow.canonicalize(empty, empty))).toBeInstanceOf(ShadowConfigChangedError);
    expect(connGuard).toHaveBeenCalledTimes(1);

    // 重新取影子库：按最新配置，生产环境禁止同实例
    const again = await settle(ctx.shadows.forProject(PID, EID));
    expect(again).toBeInstanceOf(ShadowError);
    expect((again as ShadowError).preConnect).toBe(true);
    expect(connGuard).toHaveBeenCalledTimes(1);
    expect(ctx.shadows.size).toBe(0);
  });
});

interface FakeShadow extends Shadow {
  url: string;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  /** 让下一次 close() 挂起，直到 release */
  holdClose(): { entered: Promise<void>; release: () => void };
}

describe('Shadows.forProject：每次 await 之后都重新检查 closed 与失效代际', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  const built: FakeShadow[] = [];
  /** 按 prepareShadow 调用顺序挂起：hooks[i] 存在就在第 i 次调用里等它 */
  let hooks: (() => Promise<void>)[] = [];
  let calls = 0;

  const holdPrepare = (index: number) => {
    const entered = deferred();
    const gate = deferred();
    hooks[index] = async () => {
      entered.resolve();
      await gate.promise;
    };
    return { entered: entered.promise, release: () => gate.resolve() };
  };

  beforeEach(async () => {
    ctx = await setup({ production: false, allowSameInstance: false });
    built.length = 0;
    hooks = [];
    calls = 0;
    prepareImpl = async (env) => {
      const url = env.url;
      await hooks[calls++]?.();
      let hold: { entered: Deferred; gate: Deferred } | null = null;
      const shadow: FakeShadow = {
        url,
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
        close: vi.fn(async () => {
          const h = hold;
          hold = null;
          if (h) {
            h.entered.resolve();
            await h.gate.promise;
          }
        }),
        holdClose: () => {
          const h = { entered: deferred(), gate: deferred() };
          hold = h;
          return { entered: h.entered.promise, release: () => h.gate.resolve() };
        },
      };
      built.push(shadow);
      return { shadow, label: env.name, url, created: null };
    };
  });

  afterEach(async () => {
    prepareImpl = null;
    await ctx.shadows.close();
    await ctx.db.close();
  });

  const changeUrl = (url: string) =>
    ctx.db.query('update environments set url_enc = $2 where id = $1', [EID, encrypt(url)]);

  /** 挂起下一次读环境配置的 SQL（forProject 的复核查库） */
  const holdNextEnvQuery = () => {
    const entered = deferred();
    const gate = deferred();
    const origQuery = ctx.db.query.bind(ctx.db);
    let intercepted = false;
    const spy = vi.spyOn(ctx.db, 'query').mockImplementation((async (sql: string, params?: unknown[]) => {
      if (!intercepted && sql.includes('from environments e join projects p')) {
        intercepted = true;
        entered.resolve();
        await gate.promise;
      }
      return origQuery(sql, params);
    }) as typeof ctx.db.query);
    return {
      entered: entered.promise,
      release: () => gate.resolve(),
      restore: () => {
        gate.resolve();
        spy.mockRestore();
      },
    };
  };

  test('旧配置的请求晚完成：不关掉缓存里按新配置建好的条目，自己的旧句柄关掉并返回新条目', async () => {
    // 请求 A 读到旧连接串、卡在建连
    const a = holdPrepare(0);
    const pA = ctx.shadows.forProject(PID, EID);
    await a.entered;
    // 配置改了；另一个请求按新配置建好条目放进缓存
    await changeUrl(URL_2);
    const b = (await ctx.shadows.forProject(PID, EID)).shadow as FakeShadow;
    expect(b.url).toBe(URL_2);

    a.release();
    const res = await pA;
    const sA = built.find((s) => s.url === URL_1)!;
    expect(built).toHaveLength(2);
    expect(res.shadow).toBe(b);
    expect(sA.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    expect(ctx.shadows.size).toBe(1);
    expect((await ctx.shadows.forProject(PID, EID)).shadow).toBe(b);
  });

  /**
   * 共同前奏：请求 C 读到 URL_1 卡在建连；配置改成 URL_2（事件还没到）；请求 A 读到 URL_2 也卡在建连；
   * C 先完成，把 URL_1 的条目放进缓存；A 完成时发现缓存里的条目和自己不一致、复核后确认自己才是最新配置，
   * 于是去关 C 的条目——这次关闭被挂起，返回挂起时的状态。
   */
  const staleEntryBeingClosed = async () => {
    const c = holdPrepare(0);
    const pC = ctx.shadows.forProject(PID, EID);
    await c.entered;
    await changeUrl(URL_2);
    const a = holdPrepare(1);
    const pA = settle(ctx.shadows.forProject(PID, EID));
    await a.entered;
    c.release();
    const sC = (await pC).shadow as FakeShadow;
    expect(sC.url).toBe(URL_1);
    const closingC = sC.holdClose();
    a.release();
    await closingC.entered;
    const sA = built[1]!;
    expect(sA.url).toBe(URL_2);
    return { pA, sA, sC, releaseCloseC: closingC.release };
  };

  test('关旧条目期间晚到的失效事件（配置又变了）：不把已过期的句柄放进缓存，按最新配置重建', async () => {
    const { pA, sA, sC, releaseCloseC } = await staleEntryBeingClosed();
    await changeUrl(URL_3);
    // 晚到的事件：此时缓存已空，复核什么都没做就返回
    await ctx.deliver({ t: 'shadows.forget', envIds: [EID] });
    releaseCloseC();

    const res = (await pA) as { shadow: FakeShadow };
    expect(res.shadow.url).toBe(URL_3);
    expect(sA.close).toHaveBeenCalledTimes(1);
    expect(sC.close).toHaveBeenCalledTimes(1);
    expect(res.shadow.close).not.toHaveBeenCalled();
    expect(ctx.shadows.size).toBe(1);
    expect((await ctx.shadows.forProject(PID, EID)).shadow).toBe(res.shadow);
  });

  test('关旧条目期间 Shadows.close()：不把句柄放进已关闭的缓存，关掉它并报服务正在关闭', async () => {
    const { pA, sA, releaseCloseC } = await staleEntryBeingClosed();
    const closing = ctx.shadows.close();
    releaseCloseC();
    await closing;

    const e = await pA;
    expect(e).toBeInstanceOf(ShadowUnavailableError);
    expect((e as Error).message).toContain('服务正在关闭');
    expect(sA.close).toHaveBeenCalledTimes(1);
    expect(ctx.shadows.size).toBe(0);
  });

  test('复核最新配置（读平台库）期间 Shadows.close()：同样关掉新建的句柄，缓存保持为空', async () => {
    const a = holdPrepare(0);
    const pA = settle(ctx.shadows.forProject(PID, EID));
    await a.entered;
    // 建连期间收到失效事件（缓存为空，只推进代际），A 完成后要复核最新配置
    await ctx.deliver({ t: 'shadows.forget', envIds: [EID] });
    const held = holdNextEnvQuery();
    try {
      a.release();
      await held.entered;
      await ctx.shadows.close();
      held.release();

      const e = await pA;
      expect(e).toBeInstanceOf(ShadowUnavailableError);
      expect(built[0]!.close).toHaveBeenCalledTimes(1);
      expect(ctx.shadows.size).toBe(0);
    } finally {
      held.restore();
    }
  });

  test('Shadows.close() 之后再取影子库：直接拒绝，不建任何影子库', async () => {
    await ctx.shadows.close();
    expect(await settle(ctx.shadows.forProject(PID, EID))).toBeInstanceOf(ShadowUnavailableError);
    expect(built).toHaveLength(0);
    expect(ctx.shadows.size).toBe(0);
  });

  test('配置一直在变、重试用尽：报“配置已变更，请重试”，不带“影子库不可用”前缀', async () => {
    // 每次建连期间都来一次失效事件并改配置
    const urls = [URL_2, URL_3, URL_1, URL_2];
    for (let i = 0; i < 4; i++) {
      hooks[i] = async () => {
        await changeUrl(urls[i]!);
        await ctx.deliver({ t: 'shadows.forget', envIds: [EID] });
      };
    }
    const e = await settle(ctx.shadows.forProject(PID, EID));
    expect(e).toBeInstanceOf(ShadowConfigChangedError);
    expect((e as Error).message).toBe('影子库配置已变更，请重试');
    expect(ctx.shadows.size).toBe(0);
    for (const s of built) expect(s.close).toHaveBeenCalledTimes(1);
  });

  test('多版本选影：候选环境报“配置已变更”时整体抛出重试，不把这个版本组记成没有可用影子库', async () => {
    const urls = [URL_2, URL_3, URL_1, URL_2];
    for (let i = 0; i < 4; i++) {
      hooks[i] = async () => {
        await changeUrl(urls[i]!);
        await ctx.deliver({ t: 'shadows.forget', envIds: [EID] });
      };
    }
    expect(await settle(ctx.shadows.forProjectVersions(PID))).toBeInstanceOf(ShadowConfigChangedError);
    expect(ctx.shadows.size).toBe(0);
  });
});
