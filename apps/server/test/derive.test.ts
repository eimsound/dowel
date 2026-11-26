// 派生数据按需规范化（ADR 0016）：pendingRefreshIds 判定、黄金基线不变量、flush 合并与 0 I/O、
// 写回被拒绝时不覆盖基线并自动重试、runWithReset / runWithoutReset、normalize / status、forget / stop。
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { describe, expect, test } from 'vitest';

import {
  NormalizeConflictError,
  needsRefresh,
  OpaqueRefresher,
  pendingRefreshIds,
  RefresherStoppedError,
} from '../src/derive.ts';
import type { Rooms } from '../src/rooms.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';

const base = () => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'orders' });
  runMutator(m, 'addColumn', { table: 't', column: { id: 'c', name: 'total', type: 'integer' } });
  return m;
};

const opaqueView = (deps: string[]): Obj =>
  ({
    id: 'v',
    kind: 'opaque',
    objType: 'view',
    parent: 's',
    name: 'big_orders',
    ddl: ['CREATE VIEW public.big_orders AS SELECT total FROM public.orders'],
    drop: 'DROP VIEW public.big_orders',
    deps,
    order: 0,
    comment: null,
  }) as Obj;

/** 引擎的规范形式：给 CHECK 加括号和类型转换；记下调用次数 */
const canonicalShadow = (calls = { n: 0 }): Shadow =>
  ({
    canonicalize: async (_prev: Model, next: Model) => {
      calls.n++;
      return Object.values(next.objects)
        .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
        .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj);
    },
  }) as unknown as Shadow;

/** 内存版房间：state / model / patch（patch 支持模拟版本检查拒绝） */
const memRooms = (live: { m: Model; seq: number }, opts: { rejectTimes?: number } = {}) => {
  let reject = opts.rejectTimes ?? 0;
  return {
    state: async () => ({ model: structuredClone(live.m), versions: {}, seq: live.seq }),
    model: async () => ({ model: structuredClone(live.m), seq: live.seq }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      if (reject > 0) {
        reject--;
        return { committed: false, rejected: true, seq: live.seq };
      }
      for (const o of objects) live.m.objects[o.id] = o;
      live.seq++;
      return { committed: true, rejected: false, seq: live.seq };
    },
  } as unknown as Rooms;
};

const memStore = () => {
  const saved: Model[] = [];
  return {
    saved,
    store: {
      load: async () => structuredClone(saved.at(-1) ?? null),
      save: async (_b: string, m: Model) => void saved.push(structuredClone(m)),
    },
  };
};

describe('pendingRefreshIds', () => {
  test('无基线按空基线：带表达式的对象都待规范化，纯列不算', () => {
    const m = base();
    expect(pendingRefreshIds(null, m)).toEqual([]);
    runMutator(m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    expect(pendingRefreshIds(null, m)).toEqual(['k']);
  });

  test('表达式变化 / 同表已有列类型变化 / 新增列不算', () => {
    const good = base();
    runMutator(good, 'addCheck', { id: 'k', table: 't', expr: '(total > 0)' });
    const cur = structuredClone(good);
    expect(needsRefresh(good, cur)).toBe(false);
    // 新增普通列：不影响已有表达式
    runMutator(cur, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    expect(pendingRefreshIds(good, cur)).toEqual([]);
    // 同表已有列改类型：CHECK 的规范形式可能跟着变
    (cur.objects.c as { type: string }).type = 'bigint';
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
    // 排序规则变化同理
    const cur2 = structuredClone(good);
    (cur2.objects.c as { collation: string | null }).collation = 'C';
    expect(pendingRefreshIds(good, cur2)).toEqual(['k']);
  });

  test('不透明对象：依赖改名、依赖列类型变化、DDL 变化', () => {
    const good = base();
    good.objects.v = opaqueView(['t', 'c']);
    const renamed = structuredClone(good);
    renamed.objects.t = { ...renamed.objects.t!, name: 'orders2' } as Obj;
    expect(pendingRefreshIds(good, renamed)).toEqual(['v']);
    const typed = structuredClone(good);
    (typed.objects.c as { type: string }).type = 'numeric';
    expect(pendingRefreshIds(good, typed)).toEqual(['v']);
    const ddl = structuredClone(good);
    (ddl.objects.v as { ddl: string[] }).ddl = ['CREATE VIEW x AS SELECT 1'];
    expect(pendingRefreshIds(good, ddl)).toEqual(['v']);
    expect(pendingRefreshIds(good, structuredClone(good))).toEqual([]);
  });
});

describe('OpaqueRefresher', () => {
  test('flush：无待规范化对象时 0 影子库 I/O、0 基线写入（黄金基线不被未验证模型覆盖）', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let shadowAsked = 0;
    const r = new OpaqueRefresher(
      memRooms(live),
      async () => {
        shadowAsked++;
        return canonicalShadow();
      },
      store,
    );
    await r.reset('b', live.m);
    expect(saved).toHaveLength(1);
    // 只加普通列：不需要规范化
    runMutator(live.m, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    live.seq = 1;
    await expect(r.flush('b')).resolves.toEqual({ kind: 'clean', seq: 1 });
    expect(shadowAsked).toBe(0);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.objects.c2).toBeUndefined();
  });

  test('flush：写回被拒绝的表达式不进基线，自动重试直到规范化', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live, { rejectTimes: 1 }), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out.kind).toBe('normalized');
    expect(out.seq).toBe(live.seq);
    expect((live.m.objects.k as { expr: string }).expr).toBe('(total > 0::integer)');
    // 首次被拒时未写入基线：仅初始基线与规范化后基线两次
    expect(saved).toHaveLength(2);
    expect((saved[1]!.objects.k as { expr: string }).expr).toBe('(total > 0::integer)');
  });

  test('flush：影子库不可用 / canonicalize 失败时安静跳过且不改基线', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let mode: 'shadow' | 'step' = 'shadow';
    const failing = {
      canonicalize: async () => {
        throw mode === 'shadow' ? new ShadowError('影子库不可用：连不上') : new Error('syntax error');
      },
    } as unknown as Shadow;
    const r = new OpaqueRefresher(memRooms(live), async () => failing, store);
    // 没有基线、表达式待规范化：失败时不能拿当前模型充当基线
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await expect(r.flush('b')).resolves.toEqual({ kind: 'skipped', seq: 0 });
    mode = 'step';
    await expect(r.flush('b')).resolves.toEqual({ kind: 'skipped', seq: 0 });
    expect(saved).toHaveLength(0);
    expect((live.m.objects.k as { expr: string }).expr).toBe('total > 0');
    // 没有影子库（shadowOf 返回 null）同样跳过
    const r2 = new OpaqueRefresher(memRooms(live), async () => null, store);
    await expect(r2.flush('b')).resolves.toEqual({ kind: 'skipped', seq: 0 });
  });

  test('flush：同分支排队中尚未开始的调用合并成一次', async () => {
    const live = { m: base(), seq: 0 };
    const { store } = memStore();
    const calls = { n: 0 };
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(calls), store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    // 先占住队列
    const blocker = r.runWithoutReset('b', () => gate);
    const p1 = r.flush('b');
    const p2 = r.flush('b');
    expect(p1).toBe(p2);
    release();
    await blocker;
    await expect(p1).resolves.toMatchObject({ kind: 'normalized' });
    expect(calls.n).toBe(1);
  });

  test('runWithReset 在 replace 抛错时不修改基线；之后 flush 仍能规范化', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    const initialBaseline = structuredClone(live.m);
    runMutator(live.m, 'addCheck', { id: 'k1', table: 't', expr: 'total > 0' });
    await expect(
      r.runWithReset('b', emptyModel(), async () => {
        throw new Error('working changed');
      }),
    ).rejects.toThrow('working changed');
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(initialBaseline);
    await r.flush('b');
    expect((live.m.objects.k1 as { expr: string }).expr).toBe('(total > 0::integer)');
  });

  test('runWithReset 直接用入参 model 作为基线，replace 后的并发提交不污染基线', async () => {
    const live = { m: base(), seq: 1 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(), store);
    const target = base();
    runMutator(target, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    await r.runWithReset('b', target, async () => {
      live.m = structuredClone(target);
      // 模拟 rooms.replace 刚释放锁、setGood 尚未执行期间有并发用户提交未规范化表达式
      runMutator(live.m, 'addCheck', { id: 'k_conc', table: 't', expr: 'total > 5' });
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(target);
    expect(saved[0]!.objects.k_conc).toBeUndefined();
    await r.flush('b');
    expect((live.m.objects.k_conc as { expr: string }).expr).toBe('(total > 5::integer)');
  });

  test('runWithReset onlyIfClean：模型相对基线有待规范化对象时只替换、不推进基线；没有时推进', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    // “已验证”版本的模型里仍有未规范化的 CHECK：不得写成黄金基线
    const dirty = base();
    runMutator(dirty, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await r.runWithReset('b', dirty, async () => void (live.m = structuredClone(dirty)), {
      onlyIfClean: true,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.objects.k).toBeUndefined();
    // 只多了普通列：表达式都和基线一致，可以推进
    const plain = base();
    runMutator(plain, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    await r.runWithReset('b', plain, async () => void (live.m = structuredClone(plain)), {
      onlyIfClean: true,
    });
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual(plain);
  });

  test('normalize 传入解析函数：clean 时不解析影子库；需要时才在锁内解析', async () => {
    const live = { m: base(), seq: 0 };
    const { store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => null, store);
    await r.reset('b', live.m);
    let resolved = 0;
    const resolve = async () => {
      resolved++;
      return { shadow: canonicalShadow(), label: 'lazy' };
    };
    await expect(r.normalize('b', resolve)).resolves.toMatchObject({ outcome: 'clean', shadow: null });
    expect(resolved).toBe(0);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await expect(r.normalize('b', resolve)).resolves.toMatchObject({ outcome: 'normalized', shadow: 'lazy' });
    expect(resolved).toBe(1);
  });

  test('runWithoutReset 只替换房间、不改写黄金基线', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    const restored = base();
    runMutator(restored, 'addCheck', { id: 'k', table: 't', expr: 'total > 1' });
    await r.runWithoutReset('b', async () => {
      live.m = structuredClone(restored);
      live.seq++;
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.objects.k).toBeUndefined();
    await expect(r.status('b')).resolves.toMatchObject({ pendingCount: 1, baseline: true });
  });

  test('status：0 影子库 I/O，列出待规范化对象', async () => {
    const live = { m: base(), seq: 3 };
    const { store } = memStore();
    let asked = 0;
    const r = new OpaqueRefresher(
      memRooms(live),
      async () => {
        asked++;
        return canonicalShadow();
      },
      store,
    );
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const st = await r.status('b');
    expect(st).toMatchObject({ seq: 3, pendingCount: 1, truncated: false, baseline: false });
    expect(st.objects).toEqual([{ id: 'k', kind: 'check', name: expect.stringContaining('orders.') }]);
    expect(asked).toBe(0);
  });

  test('normalize：clean / normalized / verified 与写回冲突', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const handle = { shadow: canonicalShadow(), label: 'test-shadow' };
    const r = new OpaqueRefresher(memRooms(live), async () => null, store);
    await r.reset('b', live.m);
    await expect(r.normalize('b', handle)).resolves.toMatchObject({
      ok: true,
      outcome: 'clean',
      normalizedCount: 0,
      checkedInShadow: false,
      shadow: 'test-shadow',
    });
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const res = await r.normalize('b', handle);
    expect(res).toMatchObject({ outcome: 'normalized', normalizedCount: 1, checkedInShadow: true, seq: 1 });
    expect(res.normalizedObjects.map((o) => o.id)).toEqual(['k']);
    expect(saved.at(-1)).toEqual(live.m);
    // 只加普通列：显式规范化仍去影子库校验，没有改写就是 verified，并推进基线
    runMutator(live.m, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    await expect(r.normalize('b', handle)).resolves.toMatchObject({
      outcome: 'verified',
      normalizedCount: 0,
    });
    expect(saved.at(-1)!.objects.c2).toBeDefined();
    // 写回被拒：抛冲突，基线不变
    const live2 = { m: base(), seq: 0 };
    const { saved: saved2, store: store2 } = memStore();
    const r2 = new OpaqueRefresher(memRooms(live2, { rejectTimes: 1 }), async () => null, store2);
    runMutator(live2.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await expect(r2.normalize('b', handle)).rejects.toBeInstanceOf(NormalizeConflictError);
    expect(saved2).toHaveLength(0);
  });

  test('normalize：canonicalize 报错原样抛出且基线不变；停机后拒绝', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => null, store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total >' });
    const bad = {
      shadow: {
        canonicalize: async () => {
          throw new ShadowError('影子库不可用：x');
        },
      } as unknown as Shadow,
      label: 'bad',
    };
    await expect(r.normalize('b', bad)).rejects.toBeInstanceOf(ShadowError);
    expect(saved).toHaveLength(0);
    r.stop();
    await expect(r.normalize('b', bad)).rejects.toBeInstanceOf(RefresherStoppedError);
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'skipped' });
  });

  test('forget：在途任务结束不复活内存 / 库基线', async () => {
    const live = { m: base(), seq: 0 };
    const { saved, store } = memStore();
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const slow = {
      canonicalize: async (_p: Model, next: Model) => {
        await gate;
        return canonicalShadow().canonicalize(_p, next);
      },
    } as unknown as Shadow;
    const r = new OpaqueRefresher(memRooms(live), async () => slow, store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const p = r.flush('b');
    await new Promise((res) => setTimeout(res, 5));
    r.forget('b');
    release();
    await p;
    await r.drain();
    expect(saved).toHaveLength(0);
    expect(r.tracked('b')).toBe(false);
  });
});
