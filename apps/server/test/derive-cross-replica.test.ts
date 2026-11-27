// OpaqueRefresher 的 forget 跨副本同步（Issue #153）：
// - 副本 A 删除项目后经 EventBus 广播 derive.forget，副本 B 清掉内存基线、给在途任务打 forgotten 标记；
// - 事件晚到 / 丢失（B 的 LISTEN 断线）时，B 的在途任务从平台库观察到分支已删也不误报：失败路径复核 branches，
//   保存基线更新 0 行视作已删；flush → skipped('forgotten')，normalize → BranchForgottenError（HTTP 404）；
// - bus.onReconnect 时按 branches 复核本地跟踪的分支，补齐断线期间错过的删除；
// - reset / runWithReset 不再清掉 forgotten 标记（Issue #153 评论）。
// 全部用假总线 + 共享的假 branches 表 + deferred 控制事件与 await 的先后，零 sleep、零 Docker。
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  type ClusterEvent,
  type ClusterEventHandler,
  type ClusterEventPayload,
  EventBus,
  type ReconnectHandler,
} from '../src/bus.ts';
import type { PlatformDb } from '../src/db.ts';
import {
  type BaselineStore,
  BranchForgottenError,
  OpaqueRefresher,
  type RefresherBus,
} from '../src/derive.ts';
import type { HaCoordinator } from '../src/ha.ts';
import type { Rooms } from '../src/rooms.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';

const BRANCH = 'b';

const base = () => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'orders' });
  runMutator(m, 'addColumn', { table: 't', column: { id: 'c', name: 'total', type: 'integer' } });
  return m;
};

const canonical = (next: Model): Obj[] =>
  Object.values(next.objects)
    .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
    .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj);

const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** 两个副本共用的“线路”：publish 只是排进 wire，测试决定什么时候投递给谁、投递还是丢掉 */
class FakeBus implements RefresherBus {
  readonly replicaId: string;
  readonly published: ClusterEvent[] = [];
  private events = new Set<ClusterEventHandler>();
  private reconnects = new Set<ReconnectHandler>();
  private wire: ClusterEvent[];
  failPublish = false;

  constructor(replicaId: string, wire: ClusterEvent[]) {
    this.replicaId = replicaId;
    this.wire = wire;
  }
  onEvent(h: ClusterEventHandler) {
    this.events.add(h);
    return () => void this.events.delete(h);
  }
  onReconnect(h: ReconnectHandler) {
    this.reconnects.add(h);
    return () => void this.reconnects.delete(h);
  }
  async publish(e: ClusterEventPayload) {
    if (this.failPublish) throw new Error('NOTIFY 失败');
    const full = { ...e, origin: this.replicaId } as ClusterEvent;
    this.published.push(full);
    this.wire.push(full);
  }
  /** 把线路上的事件按顺序投递给本副本（与 EventBus.dispatch 一样同步调用处理器，不等异步处理结束） */
  deliverAll() {
    const pending = this.wire.splice(0);
    for (const e of pending) for (const h of [...this.events]) void h(e);
  }
  /** 模拟断线期间错过的事件：直接丢掉 */
  dropAll() {
    this.wire.splice(0);
  }
  /** 模拟 PG LISTEN 重建：触发重连回调并等它们跑完 */
  async reconnect() {
    for (const h of [...this.reconnects]) await h();
  }
}

/** 共享的平台库：branches 表（存在性）+ branches.baseline */
const platform = () => {
  const rows = new Set<string>([BRANCH]);
  const baselines = new Map<string, Model>();
  let existingCalls = 0;
  let failExisting = false;
  const store: Required<BaselineStore> = {
    load: async (b: string) => structuredClone(baselines.get(b) ?? null),
    // update branches set baseline = … where id = $1 returning id
    save: async (b: string, m: Model) => {
      if (!rows.has(b)) return false;
      baselines.set(b, structuredClone(m));
      return true;
    },
    existing: async (ids: string[]) => {
      existingCalls++;
      if (failExisting) throw new Error('平台库连接失败');
      return new Set(ids.filter((id) => rows.has(id)));
    },
  };
  return {
    rows,
    baselines,
    store,
    existingCalls: () => existingCalls,
    setFailExisting: (v: boolean) => {
      failExisting = v;
    },
  };
};

interface Live {
  m: Model;
  seq: number;
}

/** 内存版房间；patch / state 钩子模拟“房间被踢 / 平台库行已删”时的抛错 */
const fakeRooms = (live: Live, hooks: { patch?: () => Promise<void> } = {}) =>
  ({
    state: async () => ({ model: structuredClone(live.m), versions: {}, seq: live.seq }),
    model: async () => ({ model: structuredClone(live.m), seq: live.seq }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      await hooks.patch?.();
      for (const o of objects) live.m.objects[o.id] = o;
      live.seq++;
      return { committed: true, rejected: false, seq: live.seq };
    },
  }) as unknown as Rooms;

/**
 * 双副本夹具：A、B 各一个 OpaqueRefresher，共用平台库与线路。
 * B 的影子库由 canon 决定（默认立即返回规范形式）；B 的工作副本带一条待规范化的 CHECK。
 */
const cluster = (
  opts: {
    canon?: (next: Model) => Promise<Obj[]>;
    shadowOfB?: () => Promise<Shadow | null>;
    patchB?: () => Promise<void>;
    /** B 按 PG 多副本模式运行（loadGood 始终读库） */
    distributedB?: boolean;
  } = {},
) => {
  const wire: ClusterEvent[] = [];
  const db = platform();
  const busA = new FakeBus('A', wire);
  const busB = new FakeBus('B', wire);
  const live: Live = { m: base(), seq: 0 };
  db.baselines.set(BRANCH, structuredClone(live.m));
  runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
  const shadowB = {
    canonicalize: async (_prev: Model, next: Model) => (opts.canon ? opts.canon(next) : canonical(next)),
  } as unknown as Shadow;
  const refA = new OpaqueRefresher(fakeRooms(live), async () => null, db.store, undefined, busA);
  const refB = new OpaqueRefresher(
    fakeRooms(live, { patch: opts.patchB }),
    opts.shadowOfB ?? (async () => (db.rows.has(BRANCH) ? shadowB : null)),
    db.store,
    opts.distributedB ? fakeHa : undefined,
    busB,
  );
  /** 副本 A 删除项目：事务提交（branches 行没了）后 forget 并广播 */
  const deleteOnA = async () => {
    db.rows.delete(BRANCH);
    await refA.forgetBranches([BRANCH]);
  };
  return { db, wire, busA, busB, live, refA, refB, shadowB, deleteOnA };
};

/** B 上正在影子库里 canonicalize 的在途任务：entered 后由测试决定 canonicalize 的结局 */
const gatedCanon = () => {
  const entered = deferred();
  const result = deferred<Obj[]>();
  return {
    entered,
    result,
    canon: async (next: Model) => {
      entered.resolve();
      const out = await result.promise;
      return out.length ? canonical(next) : [];
    },
  };
};

const ONE: Obj[] = [{} as Obj];

/** PG 多副本模式的 HaCoordinator 替身：锁总能拿到 */
const fakeHa = {
  isDistributed: true,
  withJobLock: async <T>(_k: string, fn: () => Promise<T>) => ({
    acquired: true as const,
    value: await fn(),
  }),
} as unknown as HaCoordinator;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('derive.forget 广播（副本 A）', () => {
  test('forgetBranches 先同步清本地，再广播 derive.forget（带分支 ID）', async () => {
    const { busA, refA, db } = cluster();
    await refA.reset(BRANCH, base());
    expect(refA.tracked(BRANCH)).toBe(true);
    db.rows.delete(BRANCH);
    const p = refA.forgetBranches([BRANCH]);
    // 同步部分已经生效：广播还没落地前本地就不再跟踪
    expect(refA.tracked(BRANCH)).toBe(false);
    await p;
    expect(busA.published).toEqual([{ t: 'derive.forget', origin: 'A', branchIds: [BRANCH] }]);
  });

  test('广播失败不抛错（删除已提交，不能因此让 DELETE 报 500），本地照样清掉', async () => {
    const { busA, refA } = cluster();
    await refA.reset(BRANCH, base());
    busA.failPublish = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(refA.forgetBranches([BRANCH])).resolves.toBeUndefined();
    expect(refA.tracked(BRANCH)).toBe(false);
    expect(err).toHaveBeenCalled();
  });

  test('空列表不广播', async () => {
    const { busA, refA } = cluster();
    await refA.forgetBranches([]);
    expect(busA.published).toEqual([]);
  });

  test('自己发出的 derive.forget 回环到本副本时忽略（不重复处理、不触发复核查询）', async () => {
    const { busA, refA, db } = cluster();
    await refA.forgetBranches([BRANCH]);
    busA.deliverAll();
    expect(db.existingCalls()).toBe(0);
  });
});

describe('EventBus：超长 derive.forget 退化', () => {
  test('分支 ID 太多超过 NOTIFY 上限 → 去掉 branchIds 发出（接收方改为按 branches 复核），不整包丢弃', async () => {
    const sent: string[] = [];
    const db = {
      dialect: 'pg',
      notify: async (_c: string, p: string) => void sent.push(p),
    } as unknown as PlatformDb;
    const bus = new EventBus(db, { replicaId: 'A' });
    const branchIds = Array.from({ length: 400 }, (_, i) => `branch-${i}-${'x'.repeat(20)}`);
    await bus.publish({ t: 'derive.forget', branchIds });
    expect(sent.map((p) => JSON.parse(p))).toEqual([{ t: 'derive.forget', origin: 'A' }]);
    await bus.publish({ t: 'derive.forget', branchIds: ['b1'] });
    expect(JSON.parse(sent[1]!)).toEqual({ t: 'derive.forget', branchIds: ['b1'], origin: 'A' });
  });
});

describe('副本 B 收到 derive.forget', () => {
  test('清掉内存基线：B 不再跟踪已删分支（不残留 good 条目）', async () => {
    const { busB, refB, deleteOnA } = cluster();
    await refB.flush(BRANCH);
    expect(refB.tracked(BRANCH)).toBe(true);
    await deleteOnA();
    busB.deliverAll();
    expect(refB.tracked(BRANCH)).toBe(false);
  });

  test('不带 branchIds（超长事件退化）→ 同步清掉全部内存基线（不查库），在途分支按 branches 复核', async () => {
    const g = gatedCanon();
    const { busB, refB, db, wire } = cluster({ canon: g.canon });
    // 活分支 b2 只有内存基线；被删的 BRANCH 有在途 flush
    db.rows.add('b2');
    await refB.reset('b2', base());
    db.store.save = async () => {}; // 旧式 store：保存不报告行数，只靠复核打标记
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    db.rows.delete(BRANCH);
    // 别的副本发出的退化事件（超过 NOTIFY 上限时去掉 branchIds）
    wire.push({ t: 'derive.forget', origin: 'A' });
    busB.deliverAll();
    expect(refB.tracked('b2')).toBe(false);
    await vi.waitFor(() => expect(db.existingCalls()).toBe(1));
    g.result.resolve(ONE);
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
  });

  test.each([
    ['单副本缓存路径', false],
    ['PG 多副本路径', true],
  ])(
    '只读 status() 读基线期间收到 derive.forget：读回来的旧基线不写回内存（不复活已删分支，%s）',
    async (_n, distributedB) => {
      const { busB, refB, db, deleteOnA } = cluster({ distributedB });
      const loadGate = deferred();
      const loadEntered = deferred();
      const origLoad = db.store.load;
      db.store.load = async (b: string) => {
        const m = await origLoad(b);
        loadEntered.resolve();
        await loadGate.promise;
        return m;
      };
      const st = refB.status(BRANCH);
      await loadEntered.promise;
      await deleteOnA();
      busB.deliverAll();
      loadGate.resolve();
      await st;
      expect(refB.tracked(BRANCH)).toBe(false);
    },
  );
});

describe('副本 B 在途 normalize() 期间副本 A 删除项目：一律 BranchForgottenError（HTTP 404），绝不报成功 / 影子库错误', () => {
  test('事件先到、影子库随后被关闭（canonicalize 抛 ShadowError）', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA, shadowB } = cluster({ canon: g.canon });
    const p = refB.normalize(BRANCH, { shadow: shadowB, label: 's' });
    await g.entered.promise;
    await deleteOnA();
    busB.deliverAll();
    g.result.reject(new ShadowError('影子库连接已关闭'));
    await expect(p).rejects.toBeInstanceOf(BranchForgottenError);
  });

  test('事件丢失、canonicalize 抛 ShadowError → 复核 branches 发现已删', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA, shadowB } = cluster({ canon: g.canon });
    const p = refB.normalize(BRANCH, { shadow: shadowB, label: 's' });
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.reject(new ShadowError('影子库连接已关闭'));
    await expect(p).rejects.toBeInstanceOf(BranchForgottenError);
  });

  test('事件丢失、canonicalize 返回空（影子库还开着）→ 保存基线更新 0 行，不报 verified', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA, shadowB } = cluster({ canon: g.canon });
    const p = refB.normalize(BRANCH, { shadow: shadowB, label: 's' });
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.resolve([]);
    await expect(p).rejects.toBeInstanceOf(BranchForgottenError);
    await refB.drain();
    expect(refB.tracked(BRANCH)).toBe(false);
  });

  test('事件丢失、写回时房间已被踢（rooms.patch 抛错）→ 不报写回失败', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA, shadowB } = cluster({
      canon: g.canon,
      patchB: async () => {
        throw new Error('分支不存在');
      },
    });
    const p = refB.normalize(BRANCH, { shadow: shadowB, label: 's' });
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.resolve(ONE);
    await expect(p).rejects.toBeInstanceOf(BranchForgottenError);
  });

  test('对照：分支还在时影子库错误照常抛出（复核查询失败也保守按原错误处理）', async () => {
    const g = gatedCanon();
    const { refB, shadowB, db } = cluster({ canon: g.canon });
    const p = refB.normalize(BRANCH, { shadow: shadowB, label: 's' });
    await g.entered.promise;
    g.result.reject(new ShadowError('连不上'));
    await expect(p).rejects.toBeInstanceOf(ShadowError);

    const g2 = gatedCanon();
    const c2 = cluster({ canon: g2.canon });
    c2.db.setFailExisting(true);
    c2.db.rows.delete(BRANCH);
    const p2 = c2.refB.normalize(BRANCH, { shadow: c2.shadowB, label: 's' });
    await g2.entered.promise;
    g2.result.reject(new ShadowError('连不上'));
    await expect(p2).rejects.toBeInstanceOf(ShadowError);
    expect(db.existingCalls()).toBe(1);
  });
});

describe('副本 B 在途 flush() 期间副本 A 删除项目：一律 skipped(forgotten)，不打失败告警', () => {
  test.each([
    ['事件先到、随后影子库被关闭', true],
    ['事件丢失、影子库被关闭', false],
  ])('%s（canonicalize 抛 ShadowError）', async (_name, deliver) => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA } = cluster({ canon: g.canon });
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    if (deliver) busB.deliverAll();
    else busB.dropAll();
    g.result.reject(new ShadowError('影子库连接已关闭'));
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await refB.drain();
    expect(refB.tracked(BRANCH)).toBe(false);
  });

  test('事件丢失、canonicalize 报表达式错误（影子库里的对象跟着项目被清掉）→ 不报 canonicalize_failed', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA } = cluster({ canon: g.canon });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.reject(new Error('relation "orders" does not exist'));
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('事件丢失、写回时房间已被踢（rooms.patch 抛错）→ 不报 store_failed、不打告警', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA } = cluster({
      canon: g.canon,
      patchB: async () => {
        throw new Error('分支不存在');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.resolve(ONE);
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    expect(warn).not.toHaveBeenCalled();
  });

  test('事件丢失、canonicalize 返回空 → 保存基线更新 0 行，不报 normalized，也不留内存基线', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA } = cluster({ canon: g.canon });
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    g.result.resolve([]);
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await refB.drain();
    expect(refB.tracked(BRANCH)).toBe(false);
  });

  test('解析影子库时分支行已删（shadowOf 返回 null）→ 不报 no_shadow', async () => {
    const { refB, deleteOnA, busB } = cluster();
    await deleteOnA();
    busB.dropAll();
    await expect(refB.flush(BRANCH)).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
  });

  test('对照：分支还在时 no_shadow / shadow_unavailable 语义不变', async () => {
    const c1 = cluster({ shadowOfB: async () => null });
    await expect(c1.refB.flush(BRANCH)).resolves.toMatchObject({
      kind: 'skipped',
      skippedReason: 'no_shadow',
    });
    const c2 = cluster({
      canon: async () => {
        throw new ShadowError('连不上');
      },
    });
    await expect(c2.refB.flush(BRANCH)).resolves.toMatchObject({
      kind: 'skipped',
      skippedReason: 'shadow_unavailable',
    });
  });
});

describe('副本 B 断线期间错过删除：bus.onReconnect 复核', () => {
  test('重连后内存基线清掉（已删分支不再残留），没有在途任务时不查库', async () => {
    const { busB, refB, deleteOnA, db } = cluster();
    await refB.flush(BRANCH);
    await deleteOnA();
    busB.dropAll();
    expect(refB.tracked(BRANCH)).toBe(true);
    await busB.reconnect();
    expect(refB.tracked(BRANCH)).toBe(false);
    expect(db.existingCalls()).toBe(0);
  });

  test('重连时 B 上还有在途任务：已删分支打 forgotten 标记、结束后不回写基线；活分支照常完成', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA, db } = cluster({ canon: g.canon });
    db.store.save = async () => {}; // 旧式 store：保存不报告行数，只靠复核打标记
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    busB.dropAll();
    await busB.reconnect();
    expect(db.existingCalls()).toBe(1);
    g.result.resolve(ONE);
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await refB.drain();
    expect(refB.tracked(BRANCH)).toBe(false);

    const g2 = gatedCanon();
    const live = cluster({ canon: g2.canon });
    const p2 = live.refB.flush(BRANCH);
    await g2.entered.promise;
    await live.busB.reconnect();
    g2.result.resolve(ONE);
    await expect(p2).resolves.toMatchObject({ kind: 'normalized' });
  });

  test('复核查询失败：只记告警不抛错；在途任务仍在自己的失败路径 / 保存基线时发现分支已删', async () => {
    const g = gatedCanon();
    const { busB, refB, db } = cluster({ canon: g.canon });
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    db.rows.delete(BRANCH);
    db.setFailExisting(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(busB.reconnect()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    g.result.resolve(ONE);
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
  });

  test('排队的 flush 轮到时房间已被踢、读房间抛错 → 已删报 forgotten；分支还在照旧抛出', async () => {
    const live: Live = { m: base(), seq: 0 };
    const db = platform();
    const rooms = Object.assign(fakeRooms(live), {
      state: async () => {
        throw new Error('分支没有初始快照');
      },
    });
    const r = new OpaqueRefresher(rooms, async () => null, db.store);
    await expect(r.flush(BRANCH)).rejects.toThrow('分支没有初始快照');
    db.rows.delete(BRANCH);
    await expect(r.flush(BRANCH)).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
  });
});

describe('forgotten 标记的生命周期', () => {
  test('远端 forget 一个本副本没有在途任务的分支：不留标记（标记集合只随在途队列存在）', async () => {
    const { busB, refB, deleteOnA } = cluster();
    await deleteOnA();
    busB.deliverAll();
    expect((refB as unknown as { forgotten: Set<string> }).forgotten.size).toBe(0);
  });

  test('在途任务结束、队列排空后标记清除', async () => {
    const g = gatedCanon();
    const { busB, refB, deleteOnA } = cluster({ canon: g.canon });
    const p = refB.flush(BRANCH);
    await g.entered.promise;
    await deleteOnA();
    busB.deliverAll();
    expect((refB as unknown as { forgotten: Set<string> }).forgotten.has(BRANCH)).toBe(true);
    g.result.resolve(ONE);
    await p;
    await refB.drain();
    expect((refB as unknown as { forgotten: Set<string> }).forgotten.size).toBe(0);
  });
});

describe('reset / runWithReset 不清 forgotten 标记（Issue #153 评论）', () => {
  /** 单副本内存平台库：save 不报告行数（与旧 store 一致），只靠 forgotten 标记挡住回写 */
  const single = () => {
    const live: Live = { m: base(), seq: 0 };
    const saved: Model[] = [];
    const store = {
      load: async () => structuredClone(saved.at(-1) ?? null),
      save: async (_b: string, m: Model) => void saved.push(structuredClone(m)),
    };
    const g = gatedCanon();
    const shadow = { canonicalize: async (_p: Model, next: Model) => g.canon(next) } as unknown as Shadow;
    const r = new OpaqueRefresher(fakeRooms(live), async () => shadow, store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    return { live, saved, r, g };
  };

  test('删除前已过权限检查的导入（runWithReset）晚到：旧任务不回写基线，导入也不给已删分支留内存基线', async () => {
    const { live, saved, r, g } = single();
    const flushP = r.flush(BRANCH);
    await g.entered.promise;
    r.forget(BRANCH);
    let ran = false;
    const resetP = r.runWithReset(BRANCH, live.m, async () => {
      ran = true;
      return 'replaced';
    });
    g.result.resolve(ONE);
    await expect(flushP).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await expect(resetP).resolves.toBe('replaced');
    expect(ran).toBe(true);
    await r.drain();
    expect(saved).toHaveLength(0);
    expect(r.tracked(BRANCH)).toBe(false);
  });

  test('reset 同理', async () => {
    const { live, saved, r, g } = single();
    const flushP = r.flush(BRANCH);
    await g.entered.promise;
    r.forget(BRANCH);
    const resetP = r.reset(BRANCH, live.m);
    g.result.resolve(ONE);
    await expect(flushP).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await resetP;
    await r.drain();
    expect(saved).toHaveLength(0);
    expect(r.tracked(BRANCH)).toBe(false);
  });
});
