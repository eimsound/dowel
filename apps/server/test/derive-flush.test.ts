// OpaqueRefresher.flush() 的结果契约（Issue #135、#132 N1 / N2）：
// - 写回冲突的重试预算只属于一次 flush，give_up 之后不跨调用泄漏；
// - 只有至少一次写回被接受、且已无待规范化对象时才报 normalized；写回全被拒后别人的编辑消除了待规范化对象报 clean；
// - 跑满 MAX_CATCHUP_ROUNDS 仍有待规范化对象时如实报 skipped（round_limit），不论期间是否写回过；
// - 返回的 model / seq 就是判定所针对的房间状态（调用方不必、也不该再读一次房间）。
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { describe, expect, test } from 'vitest';

import { OpaqueRefresher } from '../src/derive.ts';
import type { Rooms } from '../src/rooms.ts';
import type { Shadow } from '../src/shadow.ts';

const base = () => {
  const m = emptyModel();
  runMutator(m, 'createSchema', { id: 's', name: 'public' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'orders' });
  runMutator(m, 'addColumn', { table: 't', column: { id: 'c', name: 'total', type: 'integer' } });
  return m;
};

const exprOf = (m: Model, id: string) => (m.objects[id] as { expr: string } | undefined)?.expr;

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

interface Live {
  m: Model;
  seq: number;
}

/**
 * 内存版房间。ctl.reject：接下来要拒绝的写回次数；onReject / onAccept：写回被拒 / 被接受之后
 * 模拟一次并发编辑（直接改 live，seq + 1）。
 */
const ctlRooms = (
  live: Live,
  ctl: { reject: number; onReject?: (live: Live) => void; onAccept?: (live: Live) => void },
) =>
  ({
    state: async () => ({ model: structuredClone(live.m), versions: {}, seq: live.seq }),
    model: async () => ({ model: structuredClone(live.m), seq: live.seq }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      if (ctl.reject > 0) {
        ctl.reject--;
        ctl.onReject?.(live);
        return { committed: false, rejected: true, seq: live.seq };
      }
      for (const o of objects) live.m.objects[o.id] = o;
      live.seq++;
      ctl.onAccept?.(live);
      return { committed: true, rejected: false, seq: live.seq };
    },
  }) as unknown as Rooms;

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

describe('OpaqueRefresher.flush 结果契约', () => {
  test('#135 问题 1：give_up 之后，下一次独立的 flush 仍有完整的写回冲突重试预算', async () => {
    const live: Live = { m: base(), seq: 0 };
    const ctl = { reject: 4 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    // 第一次：连续 4 次被拒（> MAX_REJECT_RETRIES = 3）→ 放弃
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'write_conflict' });
    expect(saved).toHaveLength(1);
    // 第二次独立的 flush：被拒 3 次仍在预算内，第 4 次写回成功
    ctl.reject = 3;
    const out = await r.flush('b');
    expect(out.kind).toBe('normalized');
    expect(exprOf(live.m, 'k')).toBe('(total > 0::integer)');
    expect(saved).toHaveLength(2);
  });

  test('#135 问题 2：首轮写回被拒、并发编辑消除了待规范化对象 → clean（没有写回被接受，不报 normalized）', async () => {
    const live: Live = { m: base(), seq: 0 };
    const ctl = {
      reject: 1,
      // 写回被拒的原因：别人同时把这条 CHECK 删了
      onReject: (l: Live) => {
        delete l.m.objects.k;
        l.seq++;
      },
    };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'clean', seq: live.seq });
    expect(out.model).toEqual(live.m);
    // 没有写回被接受：基线不动
    expect(saved).toHaveLength(1);
  });

  test('N2：跑满 MAX_CATCHUP_ROUNDS 仍有待规范化对象 → skipped(round_limit)，即便期间有写回被接受', async () => {
    const live: Live = { m: base(), seq: 0 };
    let n = 0;
    const ctl = {
      reject: 0,
      // 每次写回之后都有人马上再加一条未规范化的 CHECK（持续编辑造成活锁）
      onAccept: (l: Live) => {
        runMutator(l.m, 'addCheck', { id: `k${++n}`, table: 't', expr: `total > ${n}` });
        l.seq++;
      },
    };
    const calls = { n: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(calls), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(calls.n).toBe(5);
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'round_limit', seq: live.seq });
    // 返回的模型里确实还有待规范化的对象
    expect(exprOf(out.model, `k${n}`)).toBe(`total > ${n}`);
    // 被接受的写回照常推进了基线（I3：saves <= accepted）
    expect(saved.length - 1).toBe(5);
  });

  test('N2 / #135 边界：写回全被拒时到不了轮数上限（MAX_REJECT_RETRIES 3 < MAX_CATCHUP_ROUNDS 5），第 4 次被拒即放弃', async () => {
    const live: Live = { m: base(), seq: 0 };
    const calls = { n: 0 };
    const { saved, store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 100 }), async () => canonicalShadow(calls), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    await expect(r.flush('b')).resolves.toMatchObject({ kind: 'skipped', skippedReason: 'write_conflict' });
    expect(calls.n).toBe(4);
    expect(saved).toHaveLength(1);
  });

  test('写回被接受后连续被拒计数清零：拒 2 次 → 接受（又冒出待规范化对象）→ 再拒 2 次 → 跑满轮数（不清零则第 4 次被拒就报 write_conflict）', async () => {
    const live: Live = { m: base(), seq: 0 };
    let added = false;
    const ctl = {
      reject: 2,
      onAccept: (l: Live) => {
        if (added) return;
        added = true;
        runMutator(l.m, 'addCheck', { id: 'k2', table: 't', expr: 'total < 100' });
        l.seq++;
        ctl.reject = 2;
      },
    };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, ctl), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    // 轮次：拒、拒、接受（k2 冒出来）、拒、拒 → 跑满 5 轮
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'round_limit' });
    expect(exprOf(live.m, 'k')).toBe('(total > 0::integer)');
  });

  test('N1：返回的 model / seq 就是判定过的那一份；flush 之后的编辑不在里面', async () => {
    const live: Live = { m: base(), seq: 0 };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), store);
    await r.reset('b', live.m);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    const out = await r.flush('b');
    expect(out.kind).toBe('normalized');
    expect(out.seq).toBe(live.seq);
    expect(out.model).toEqual(live.m);
    expect(exprOf(out.model, 'k')).toBe('(total > 0::integer)');
    // 之后别人又加了一条：返回值不受影响，修改返回值也不影响房间
    runMutator(live.m, 'addCheck', { id: 'k2', table: 't', expr: 'total < 100' });
    live.seq++;
    expect(out.model.objects.k2).toBeUndefined();
    delete out.model.objects.k;
    expect(live.m.objects.k).toBeDefined();
  });

  test('停机后 flush 报 skipped(stopped)，模型原样返回', async () => {
    const live: Live = { m: base(), seq: 3 };
    const { store } = memStore();
    const r = new OpaqueRefresher(ctlRooms(live, { reject: 0 }), async () => canonicalShadow(), store);
    runMutator(live.m, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
    r.stop();
    const out = await r.flush('b');
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'stopped', seq: 3 });
    expect(exprOf(out.model, 'k')).toBe('total > 0');
  });
});
