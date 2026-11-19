// 派生数据刷新：规范化期间对象被别人改过、写回被拒绝时，不能把原文当成已规范化（要自动重试）。
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

test('写回被拒绝的表达式不进基线，并自动重试直到规范化', async () => {
  const live: Model = base();
  const saved: Model[] = [];
  let rejectNext = true;
  const rooms = {
    state: async () => ({ model: structuredClone(live), versions: {}, seq: 0 }),
    // 第一次写回时模拟“期间被别人改过”：版本检查拒绝，模型不变
    patch: async (_b: string, _u: string, objects: Obj[]) => {
      if (rejectNext) {
        rejectNext = false;
        return;
      }
      for (const o of objects) live.objects[o.id] = o;
    },
  } as unknown as Rooms;
  const shadow = {
    // 引擎的规范形式：给 CHECK 加括号和类型转换
    canonicalize: async (_prev: Model, next: Model) =>
      Object.values(next.objects)
        .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
        .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj),
  } as unknown as Shadow;
  const r = new OpaqueRefresher(rooms, async () => shadow, {
    load: async () => saved.at(-1) ?? null,
    save: async (_b, m) => void saved.push(structuredClone(m)),
  });
  r.delayMs = 1;
  await r.reset('b', live);

  runMutator(live, 'addCheck', { id: 'k', table: 't', expr: 'total > 0' });
  r.schedule('b');
  for (let i = 0; i < 50 && (live.objects.k as { expr: string }).expr === 'total > 0'; i++) {
    await new Promise((res) => setTimeout(res, 10));
    await r.flush('b');
  }
  expect((live.objects.k as { expr: string }).expr).toBe('(total > 0::integer)');
  // 基线里从来没有出现过“原文当成已规范化”的状态
  expect(saved.every((m) => !m.objects.k || (m.objects.k as { expr: string }).expr.startsWith('('))).toBe(
    true,
  );
});
