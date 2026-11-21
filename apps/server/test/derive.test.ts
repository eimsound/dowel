// 派生数据刷新：写回被拒绝时不覆盖基线并自动重试、runWithReset 异常回滚与并发提交不污染基线。
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { expect, test } from 'vitest';

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

const canonicalShadow = (): Shadow =>
  ({
    // 引擎的规范形式：给 CHECK 加括号和类型转换
    canonicalize: async (_prev: Model, next: Model) =>
      Object.values(next.objects)
        .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
        .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj),
  }) as unknown as Shadow;

test('写回被拒绝的表达式不进基线，不覆盖已有基线并自动重试直到规范化', async () => {
  const live: Model = base();
  const saved: Model[] = [];
  let rejectNext = true;
  const rooms = {
    state: async () => ({ model: structuredClone(live), versions: {}, seq: 0 }),
    // 第一次写回时模拟“期间被别人改过”：版本检查拒绝，模型不变
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      if (rejectNext) {
        rejectNext = false;
        return { committed: false, rejected: true, seq: 0 };
      }
      for (const o of objects) live.objects[o.id] = o;
      return { committed: true, rejected: false, seq: 1 };
    },
  } as unknown as Rooms;
  const r = new OpaqueRefresher(rooms, async () => canonicalShadow(), {
    load: async () => saved.at(-1) ?? null,
    save: async (_b, m) => void saved.push(structuredClone(m)),
  });
  r.delayMs = 1;
  await r.reset('b', live);
  expect(saved).toHaveLength(1);

  runMutator(live, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
  r.schedule('b');
  await r.flush('b');

  expect((live.objects.k as { expr: string }).expr).toBe('(total > 0::integer)');
  // 首次被拒时未写入基线，最终成功时才写入：saved 仅有初始基线与规范化后基线两次
  expect(saved).toHaveLength(2);
  expect(saved.every((m) => !m.objects.k || (m.objects.k as { expr: string }).expr.startsWith('('))).toBe(
    true,
  );
});

test('runWithReset 在 replace 抛错时不修改基线，且保留原有挂起刷新定时器', async () => {
  const live: Model = base();
  const saved: Model[] = [];
  const rooms = {
    state: async () => ({ model: structuredClone(live), versions: {}, seq: 0 }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      for (const o of objects) live.objects[o.id] = o;
      return { committed: true, rejected: false, seq: 1 };
    },
  } as unknown as Rooms;
  const r = new OpaqueRefresher(rooms, async () => canonicalShadow(), {
    load: async () => saved.at(-1) ?? null,
    save: async (_b, m) => void saved.push(structuredClone(m)),
  });
  r.delayMs = 60_000;
  await r.reset('b', live);
  const initialBaseline = structuredClone(live);

  runMutator(live, 'addCheck', { id: 'k1', table: 't', expr: 'total > 0' });
  r.schedule('b');

  const otherModel = emptyModel();
  await expect(
    r.runWithReset('b', otherModel, async () => {
      throw new Error('working changed');
    }),
  ).rejects.toThrow('working changed');

  // 基线未被 otherModel 覆盖
  expect(saved).toHaveLength(1);
  expect(saved[0]).toEqual(initialBaseline);
  // 原挂起定时器已恢复，flush 能完成规范化
  await r.flush('b');
  expect((live.objects.k1 as { expr: string }).expr).toBe('(total > 0::integer)');
  r.stop();
});

test('runWithReset 直接用入参 model 作为基线，replace 后并发提交不污染基线且后续正常规范化', async () => {
  let live: Model = base();
  const saved: Model[] = [];
  const rooms = {
    state: async () => ({ model: structuredClone(live), versions: {}, seq: 1 }),
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      for (const o of objects) live.objects[o.id] = o;
      return { committed: true, rejected: false, seq: 2 };
    },
  } as unknown as Rooms;
  const r = new OpaqueRefresher(rooms, async () => canonicalShadow(), {
    load: async () => saved.at(-1) ?? null,
    save: async (_b, m) => void saved.push(structuredClone(m)),
  });
  r.delayMs = 60_000;

  const target = base();
  runMutator(target, 'addColumn', { table: 't', column: { id: 'c2', name: 'note', type: 'text' } });

  await r.runWithReset('b', target, async () => {
    live = structuredClone(target);
    // 模拟 rooms.replace 刚释放锁、setGood 尚未执行期间有并发用户提交未规范化表达式
    runMutator(live, 'addCheck', { id: 'k_conc', table: 't', expr: 'total > 5' });
    r.schedule('b');
  });

  // 写入基线的是 target 本身，绝不含并发提交 k_conc
  expect(saved).toHaveLength(1);
  expect(saved[0]).toEqual(target);
  expect(saved[0]!.objects.k_conc).toBeUndefined();

  // 随后 flush 必须能识别并规范化 k_conc
  await r.flush('b');
  expect((live.objects.k_conc as { expr: string }).expr).toBe('(total > 5::integer)');
  r.stop();
});
