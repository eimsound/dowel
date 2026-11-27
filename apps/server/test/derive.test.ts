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
    await expect(r.flush('b')).resolves.toEqual({ kind: 'clean', seq: 1, model: live.m });
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
    await expect(r.flush('b')).resolves.toMatchObject({
      kind: 'skipped',
      seq: 0,
      skippedReason: 'shadow_unavailable',
    });
    mode = 'step';
    await expect(r.flush('b')).resolves.toMatchObject({
      kind: 'skipped',
      seq: 0,
      skippedReason: 'canonicalize_failed',
    });
    expect(saved).toHaveLength(0);
    expect((live.m.objects.k as { expr: string }).expr).toBe('total > 0');
    // 没有影子库（shadowOf 返回 null）同样跳过
    const r2 = new OpaqueRefresher(memRooms(live), async () => null, store);
    await expect(r2.flush('b')).resolves.toMatchObject({
      kind: 'skipped',
      seq: 0,
      skippedReason: 'no_shadow',
    });
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
    release();
    await blocker;
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toMatchObject({ kind: 'normalized' });
    expect(o2).toEqual(o1);
    // 共用一次结果，但各拿一份模型副本
    expect(o2.model).not.toBe(o1.model);
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
    await expect(p).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    await r.drain();
    expect(saved).toHaveLength(0);
    expect(r.tracked('b')).toBe(false);
  });
});

// ───── 待规范化判定的漏判修复（#133 同表列名绑定、#134 分区子表按根父表解析列、#136 不透明对象依赖闭包） ─────

const setType = (m: Model, id: string, type: string) =>
  runMutator(m, 'setColumnType', { id, type, typeRef: null });

describe('pendingRefreshIds：同表列按列名对齐（#133）', () => {
  /** orders(total integer, note text)，CHECK 引用 total；基线已规范化 */
  const swapBase = () => {
    const m = base();
    runMutator(m, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });
    runMutator(m, 'addCheck', { id: 'k', table: 't', expr: '(total > 0)' });
    return m;
  };

  test('列名对调：表达式原文与基线相同，但同名列换成了另一种类型的列', () => {
    const good = swapBase();
    const cur = structuredClone(good);
    // 恢复历史 / 应用版本换入的快照：total 现在指 c2(text)，CHECK 原文逐字不变
    (cur.objects.c as { name: string }).name = 'note';
    (cur.objects.c2 as { name: string }).name = 'total';
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
    expect(needsRefresh(good, cur)).toBe(true);
  });

  test('删列后新建同名、不同 ID、不同类型的列', () => {
    const good = swapBase();
    const cur = structuredClone(good);
    delete cur.objects.c;
    cur.objects.c9 = { ...structuredClone(good.objects.c!), id: 'c9', type: 'text' } as Obj;
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
    // 反方向（基线是重建后的模型，换回删列前的快照）同样检出
    expect(pendingRefreshIds(cur, good)).toEqual(['k']);
  });

  test('不误报：新增列、删列、改名到基线里没有的名字、同类型列对调', () => {
    const good = swapBase();
    runMutator(good, 'addColumn', { table: 't', column: { id: 'c3', name: 'qty', type: 'integer' } });
    const added = structuredClone(good);
    runMutator(added, 'addColumn', { table: 't', column: { id: 'c4', name: 'extra', type: 'bigint' } });
    expect(pendingRefreshIds(good, added)).toEqual([]);
    const dropped = structuredClone(good);
    runMutator(dropped, 'dropColumn', { id: 'c2' });
    expect(pendingRefreshIds(good, dropped)).toEqual([]);
    const renamed = structuredClone(good);
    runMutator(renamed, 'renameColumn', { id: 'c2', name: 'memo' });
    expect(pendingRefreshIds(good, renamed)).toEqual([]);
    // total / qty 都是 integer：按名字看上下文没变（按 ID 也没变）
    const swapped = structuredClone(good);
    (swapped.objects.c as { name: string }).name = 'qty';
    (swapped.objects.c3 as { name: string }).name = 'total';
    expect(pendingRefreshIds(good, swapped)).toEqual([]);
  });

  test('列自身的默认值 / 生成列：列改名的同时改类型也检出', () => {
    const good = base();
    runMutator(good, 'addColumn', {
      table: 't',
      column: { id: 'g', name: 'doubled', type: 'integer', generated: { expr: '(total * 2)', stored: true } },
    });
    const cur = structuredClone(good);
    (cur.objects.g as { name: string; type: string }).name = 'twice';
    (cur.objects.g as { type: string }).type = 'bigint';
    expect(pendingRefreshIds(good, cur)).toEqual(['g']);
  });

  test('大小写不敏感的方言（MySQL）按忽略大小写对齐列名', () => {
    const good = emptyModel('mysql');
    runMutator(good, 'createSchema', { id: 's', name: 'default' });
    runMutator(good, 'createTable', { id: 't', schema: 's', name: 'orders' });
    runMutator(good, 'addColumn', { table: 't', column: { id: 'c', name: 'Total', type: 'int' } });
    runMutator(good, 'addCheck', { id: 'k', table: 't', expr: '(total > 0)' });
    const cur = structuredClone(good);
    delete cur.objects.c;
    cur.objects.c9 = {
      ...structuredClone(good.objects.c!),
      id: 'c9',
      name: 'total',
      type: 'decimal(10,2)',
    } as Obj;
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
  });

  test('出口 flush 与 onlyIfClean：换回删列重建前的快照不漏判', async () => {
    // B：删掉 c 后重建同名 text 列 c9；H：c 仍是 integer
    const h = swapBase();
    const b = structuredClone(h);
    delete b.objects.c;
    b.objects.c9 = { ...structuredClone(h.objects.c!), id: 'c9', type: 'text' } as Obj;
    const live = { m: structuredClone(b), seq: 0 };
    const { saved, store } = memStore();
    let asked = 0;
    const r = new OpaqueRefresher(
      memRooms(live),
      async () => {
        asked++;
        return canonicalShadow();
      },
      store,
    );
    await r.reset('b', b);
    // onlyIfClean：H 相对 B 有待规范化对象 → 只换房间、不推进基线
    await r.runWithReset(
      'b',
      h,
      async () => {
        live.m = structuredClone(h);
        live.seq++;
      },
      { onlyIfClean: true },
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.objects.c9).toBeDefined();
    await expect(r.status('b')).resolves.toMatchObject({ pendingCount: 1 });
    // 出口 flush 必须回影子库，而不是 0 I/O 返回 clean
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'normalized' });
    expect(asked).toBe(1);
  });
});

/** PG 分区家族：events(day integer 分区键, amount integer) → ch(二级分区父表) → leaf */
const partitionFamily = () => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createTable', { id: 'p', schema: 's', name: 'events' });
  runMutator(m, 'addColumn', {
    table: 'p',
    column: { id: 'pd', name: 'day', type: 'integer', notNull: true },
  });
  runMutator(m, 'addColumn', { table: 'p', column: { id: 'pa', name: 'amount', type: 'integer' } });
  const byDay = {
    strategy: 'range' as const,
    keys: [{ column: 'pd', expr: null, opclass: null, collation: null }],
  };
  runMutator(m, 'setPartitionBy', { id: 'p', partitionBy: byDay });
  runMutator(m, 'createPartition', {
    id: 'ch',
    parent: 'p',
    name: 'events_a',
    bound: 'FOR VALUES FROM (0) TO (100)',
  });
  runMutator(m, 'setPartitionBy', { id: 'ch', partitionBy: byDay });
  runMutator(m, 'createPartition', {
    id: 'lf',
    parent: 'ch',
    name: 'events_a1',
    bound: 'FOR VALUES FROM (0) TO (10)',
  });
  return m;
};

describe('pendingRefreshIds：分区子表按根父表解析列（#134）', () => {
  test('一级 / 二级子分区上的本地 CHECK、表达式索引、部分索引在根父表列改类型或排序规则时检出', () => {
    const good = partitionFamily();
    runMutator(good, 'addCheck', { id: 'k1', table: 'ch', expr: '(amount >= 0)' });
    runMutator(good, 'addCheck', { id: 'k2', table: 'lf', expr: '(amount >= 0)' });
    runMutator(good, 'addIndex', { id: 'ix', table: 'lf', elements: [{ expr: '(amount + 1)' }] });
    runMutator(good, 'addIndex', {
      id: 'iw',
      table: 'ch',
      elements: [{ column: 'pd' }],
      where: '(amount >= 0)',
    });
    expect(pendingRefreshIds(good, structuredClone(good))).toEqual([]);
    const typed = structuredClone(good);
    setType(typed, 'pa', 'numeric');
    expect(pendingRefreshIds(good, typed)).toEqual(['k1', 'k2', 'ix', 'iw']);
    const collated = structuredClone(good);
    (collated.objects.pa as { collation: string | null }).collation = 'C';
    expect(pendingRefreshIds(good, collated)).toEqual(['k1', 'k2', 'ix', 'iw']);
  });

  test('只在 deps 里依赖子分区表的不透明对象在根父表列改类型时检出', () => {
    const good = partitionFamily();
    good.objects.v = {
      ...opaqueView(['lf']),
      ddl: ['CREATE VIEW public.big_orders AS SELECT amount FROM public.events_a1'],
    } as Obj;
    const typed = structuredClone(good);
    setType(typed, 'pa', 'numeric');
    expect(pendingRefreshIds(good, typed)).toEqual(['v']);
  });

  test('attach：基线里是独立表、当前挂到分区父表下（根不同），按列名对齐两边的根表列', () => {
    const good = partitionFamily();
    runMutator(good, 'createTable', { id: 'x', schema: 's', name: 'events_b' });
    runMutator(good, 'addColumn', {
      table: 'x',
      column: { id: 'xd', name: 'day', type: 'integer', notNull: true },
    });
    runMutator(good, 'addColumn', { table: 'x', column: { id: 'xa', name: 'amount', type: 'integer' } });
    runMutator(good, 'addCheck', { id: 'k', table: 'x', expr: '(amount >= 0)' });
    const attached = structuredClone(good);
    runMutator(attached, 'attachPartition', {
      parent: 'p',
      child: 'x',
      bound: 'FOR VALUES FROM (100) TO (200)',
    });
    expect(attached.objects.xa).toBeUndefined();
    // 新出现的分区边界本身待规范化；挂上去之后列的名字和类型都没变，CHECK 不误报
    expect(pendingRefreshIds(good, attached)).toEqual(['x']);
    setType(attached, 'pa', 'numeric');
    expect(pendingRefreshIds(good, attached)).toEqual(['x', 'k']);
  });

  test('detach：基线里是子分区、当前脱离成独立表（列被物化成新 ID）', () => {
    const good = partitionFamily();
    runMutator(good, 'addCheck', { id: 'k', table: 'lf', expr: '(amount >= 0)' });
    const detached = structuredClone(good);
    runMutator(detached, 'detachPartition', { id: 'lf' });
    const amount = Object.values(detached.objects).find(
      (o) => o.kind === 'column' && o.parent === 'lf' && o.name === 'amount',
    )!;
    expect(pendingRefreshIds(good, detached)).toEqual([]);
    setType(detached, amount.id, 'numeric');
    expect(pendingRefreshIds(good, detached)).toEqual(['k']);
  });

  test('detach 改写视图 deps（列依赖指向新物化的列）：DDL 原文不变也检出，flush 后不误报', async () => {
    const good = partitionFamily();
    good.objects.v = {
      ...opaqueView(['lf', 'pa']),
      ddl: ['CREATE VIEW public.big_orders AS SELECT amount FROM public.events_a1'],
    } as Obj;
    const detached = structuredClone(good);
    runMutator(detached, 'detachPartition', { id: 'lf' });
    const vDetached = detached.objects.v as Extract<Obj, { kind: 'opaque' }>;
    expect(vDetached.deps).not.toContain('pa');
    expect(vDetached.ddl).toEqual((good.objects.v as Extract<Obj, { kind: 'opaque' }>).ddl);
    expect(pendingRefreshIds(good, detached)).toEqual(['v']);

    // flush 一次规范化后推进基线，再次 flush 0 I/O 返回 clean（非稳态误报）
    const live = { m: structuredClone(detached), seq: 0 };
    const { saved, store } = memStore();
    const calls = { n: 0 };
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(calls), store);
    await r.reset('b', good);
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'normalized' });
    expect(calls.n).toBe(1);
    expect(needsRefresh(saved.at(-1)!, live.m)).toBe(false);
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'clean', seq: live.seq });
    expect(calls.n).toBe(1);
  });

  test('反例 A：有子分区时直接 setPartitionBy 换分区键列，只带边界的子分区检出并在 flush 后归零', async () => {
    const good = emptyModel();
    runMutator(good, 'createSchema', { id: 's', name: 'public' });
    runMutator(good, 'createTable', { id: 'p', schema: 's', name: 'events' });
    runMutator(good, 'addColumn', {
      table: 'p',
      column: { id: 'pd', name: 'day', type: 'date', notNull: true },
    });
    runMutator(good, 'addColumn', {
      table: 'p',
      column: { id: 'pt', name: 'ts', type: 'timestamp', notNull: true },
    });
    runMutator(good, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pd', expr: null, opclass: null, collation: null }],
      },
    });
    runMutator(good, 'createPartition', {
      id: 'c',
      parent: 'p',
      name: 'events_2020',
      bound: "FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')",
    });

    const cur = structuredClone(good);
    runMutator(cur, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pt', expr: null, opclass: null, collation: null }],
      },
    });
    expect(pendingRefreshIds(good, cur)).toEqual(['c']);

    const live = { m: structuredClone(cur), seq: 0 };
    const { saved, store } = memStore();
    const calls = { n: 0 };
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(calls), store);
    await r.reset('b', good);
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'normalized' });
    expect(calls.n).toBe(1);
    expect(needsRefresh(saved.at(-1)!, live.m)).toBe(false);
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'clean', seq: live.seq });
    expect(calls.n).toBe(1);
  });

  test('反例 A2：detach → 取消分区 → 改键列类型 → 重新分区 → attach（全走普通 mutator）检出并在稳态归零', () => {
    const good = emptyModel();
    runMutator(good, 'createSchema', { id: 's', name: 'public' });
    runMutator(good, 'createTable', { id: 'p', schema: 's', name: 'events' });
    runMutator(good, 'addColumn', {
      table: 'p',
      column: { id: 'pd', name: 'day', type: 'date', notNull: true },
    });
    runMutator(good, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pd', expr: null, opclass: null, collation: null }],
      },
    });
    runMutator(good, 'createPartition', {
      id: 'c',
      parent: 'p',
      name: 'events_2020',
      bound: "FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')",
    });

    const cur = structuredClone(good);
    runMutator(cur, 'detachPartition', { id: 'c' });
    runMutator(cur, 'setPartitionBy', { id: 'p', partitionBy: null });
    setType(cur, 'pd', 'timestamp');
    runMutator(cur, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pd', expr: null, opclass: null, collation: null }],
      },
    });
    const childDay = Object.values(cur.objects).find(
      (o) => o.kind === 'column' && o.parent === 'c' && o.name === 'day',
    )!;
    setType(cur, childDay.id, 'timestamp');
    runMutator(cur, 'attachPartition', {
      parent: 'p',
      child: 'c',
      bound: "FOR VALUES FROM ('2020-01-01') TO ('2021-01-01')",
    });

    expect(pendingRefreshIds(good, cur)).toEqual(['c']);
    expect(pendingRefreshIds(cur, structuredClone(cur))).toEqual([]);
  });

  test('多级分区只比较直接父表分区键，非键列改类型不对只有边界的子分区误报', () => {
    const good = partitionFamily();
    runMutator(good, 'addColumn', {
      table: 'p',
      column: { id: 'pts', name: 'ts', type: 'timestamp', notNull: true },
    });
    // 改非分区键列 amount 类型：只有边界的 ch / lf 不误报
    const nonKeyChanged = structuredClone(good);
    setType(nonKeyChanged, 'pa', 'numeric');
    expect(pendingRefreshIds(good, nonKeyChanged)).toEqual([]);

    // 仅二级父表 ch 换分区键列：只检出直接子分区 lf，不误报 ch
    const subKeyChanged = structuredClone(good);
    runMutator(subKeyChanged, 'setPartitionBy', {
      id: 'ch',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'pts', expr: null, opclass: null, collation: null }],
      },
    });
    expect(pendingRefreshIds(good, subKeyChanged)).toEqual(['lf']);
  });

  test('表达式分区键父表列类型变化与单边缺失父表时检出子分区', () => {
    const good = emptyModel();
    runMutator(good, 'createSchema', { id: 's', name: 'public' });
    runMutator(good, 'createTable', { id: 'p', schema: 's', name: 'tags' });
    runMutator(good, 'addColumn', {
      table: 'p',
      column: { id: 'pc', name: 'code', type: 'text', notNull: true },
    });
    runMutator(good, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: null, expr: 'lower(code)', opclass: null, collation: null }],
      },
    });
    runMutator(good, 'createPartition', {
      id: 'c',
      parent: 'p',
      name: 'tags_a',
      bound: "FOR VALUES FROM ('a') TO ('m')",
    });

    // 模拟快照替换：表达式原文不变，父表键引用的列类型变为 varchar(20)
    const typed = structuredClone(good);
    (typed.objects.pc as { type: string }).type = 'varchar(20)';
    expect(pendingRefreshIds(good, typed)).toEqual(['p', 'c']);

    // 父表仅在一边缺失
    const missingParent = structuredClone(good);
    delete missingParent.objects.p;
    expect(pendingRefreshIds(good, missingParent)).toEqual(['c']);
    expect(pendingRefreshIds(missingParent, structuredClone(missingParent))).toEqual([]);
  });
});

const view = (id: string, deps: string[], extra: Partial<Obj> = {}): Obj =>
  ({ ...opaqueView(deps), id, name: id, ddl: [`CREATE VIEW public.${id} AS SELECT 1`], ...extra }) as Obj;

describe('pendingRefreshIds：不透明对象沿依赖传递（#136）', () => {
  /** v1 → orders.total，v2 → v1，v3 → v2 */
  const chain = () => {
    const m = base();
    m.objects.v1 = view('v1', ['t', 'c']);
    m.objects.v2 = view('v2', ['v1']);
    m.objects.v3 = view('v3', ['v2']);
    return m;
  };

  test('底层列改类型、依赖改名、上游 DDL 变化：下游视图一并检出（多跳）', () => {
    const good = chain();
    expect(pendingRefreshIds(good, structuredClone(good))).toEqual([]);
    const typed = structuredClone(good);
    setType(typed, 'c', 'numeric');
    expect(pendingRefreshIds(good, typed)).toEqual(['v1', 'v2', 'v3']);
    const renamed = structuredClone(good);
    runMutator(renamed, 'renameColumn', { id: 'c', name: 'amount' });
    expect(pendingRefreshIds(good, renamed)).toEqual(['v1', 'v2', 'v3']);
    const ddl = structuredClone(good);
    (ddl.objects.v1 as { ddl: string[] }).ddl = ['CREATE VIEW public.v1 AS SELECT 2'];
    expect(pendingRefreshIds(good, ddl)).toEqual(['v1', 'v2', 'v3']);
    // 只改链条中间：上游不受影响
    const mid = structuredClone(good);
    (mid.objects.v2 as { ddl: string[] }).ddl = ['CREATE VIEW public.v2 AS SELECT 2'];
    expect(pendingRefreshIds(good, mid)).toEqual(['v2', 'v3']);
  });

  test('环状依赖不死循环', () => {
    const good = base();
    good.objects.v1 = view('v1', ['c', 'v2']);
    good.objects.v2 = view('v2', ['v1']);
    expect(pendingRefreshIds(good, structuredClone(good))).toEqual([]);
    const typed = structuredClone(good);
    setType(typed, 'c', 'numeric');
    expect(pendingRefreshIds(good, typed)).toEqual(['v1', 'v2']);
  });

  test('表级父对象不在 deps 里：父表列改类型也检出', () => {
    const good = base();
    good.objects.tr = view('tr', [], {
      objType: 'trigger',
      parent: 't',
      ddl: ['CREATE TRIGGER tr ...'],
    } as Partial<Obj>);
    const typed = structuredClone(good);
    setType(typed, 'c', 'numeric');
    expect(pendingRefreshIds(good, typed)).toEqual(['tr']);
  });

  test('status：pendingCount 与对象列表包含下游视图', async () => {
    const good = chain();
    const live = { m: structuredClone(good), seq: 0 };
    const { store } = memStore();
    const r = new OpaqueRefresher(memRooms(live), async () => canonicalShadow(), store);
    await r.reset('b', good);
    setType(live.m, 'c', 'numeric');
    const st = await r.status('b');
    expect(st.pendingCount).toBe(3);
    expect(st.objects.map((o) => o.id)).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('pendingRefreshIds：列签名的补充规则（枚举限定名、大小写、改挂分区父表）', () => {
  test('两个枚举对调名字：列的 typeRef 不变，表达式里的类型名换了绑定', () => {
    const good = base();
    runMutator(good, 'createEnum', { id: 'e1', schema: 's', name: 'mood', values: ['ok', 'bad'] });
    runMutator(good, 'createEnum', { id: 'e2', schema: 's', name: 'tone', values: ['ok', 'lo'] });
    runMutator(good, 'addColumn', {
      table: 't',
      column: { id: 'cm', name: 'm', type: 'mood', typeRef: 'e1' },
    });
    runMutator(good, 'addCheck', { id: 'k', table: 't', expr: "(m = 'ok'::mood)" });
    const cur = structuredClone(good);
    (cur.objects.e1 as { name: string }).name = 'tone';
    (cur.objects.e2 as { name: string }).name = 'mood';
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
  });

  test('大小写不敏感的方言：列名只改大小写也算变化（读回的引用写法可能跟着变）', () => {
    const good = emptyModel('mysql');
    runMutator(good, 'createSchema', { id: 's', name: 'default' });
    runMutator(good, 'createTable', { id: 't', schema: 's', name: 'orders' });
    runMutator(good, 'addColumn', { table: 't', column: { id: 'c', name: 'Total', type: 'int' } });
    runMutator(good, 'addCheck', { id: 'k', table: 't', expr: '(`Total` > 0)' });
    const cur = structuredClone(good);
    (cur.objects.c as { name: string }).name = 'total';
    expect(pendingRefreshIds(good, cur)).toEqual(['k']);
  });

  test('子分区改挂到另一个分区父表下：边界原文不变也待规范化', () => {
    const good = partitionFamily();
    runMutator(good, 'createTable', { id: 'q', schema: 's', name: 'events2' });
    runMutator(good, 'addColumn', {
      table: 'q',
      column: { id: 'qd', name: 'day', type: 'integer', notNull: true },
    });
    runMutator(good, 'addColumn', { table: 'q', column: { id: 'qa', name: 'amount', type: 'integer' } });
    runMutator(good, 'setPartitionBy', {
      id: 'q',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'qd', expr: null, opclass: null, collation: null }],
      },
    });
    const cur = structuredClone(good);
    (cur.objects.lf as { partitionOf: { parent: string; bound: string } }).partitionOf.parent = 'q';
    expect(pendingRefreshIds(good, cur)).toEqual(['lf']);
  });
});
