// envs.ts 里的纯函数：漂移摘要的清洗（旧格式兼容）、按全部执行记录算“碰过目标库的版本”
import type { DriftSummary } from '@dowel/api';
import { runTouched, runVersionId } from '@dowel/executor';
import { expect, test } from 'vitest';

import { sanitizeSummary, toEnvVersion, type VersionMeta, versionStates } from '../src/envs.ts';

const base: DriftSummary = { versionId: 'v', versionNumber: 2, total: 1, items: [], message: '短句' };

test('sanitizeSummary：用 needsManualSchema 校验，不合格的丢掉，合格的原样保留', () => {
  expect(sanitizeSummary(null)).toBeNull();
  expect(sanitizeSummary(base)).toEqual(base);
  const ok = { direction: 'down', versionId: 'x', versionNumber: 3 } as const;
  expect(sanitizeSummary({ ...base, needsManual: ok })?.needsManual).toEqual(ok);
  // versionNumber 可以缺省 / 为 null；versionId 可以为 null
  expect(
    sanitizeSummary({ ...base, needsManual: { direction: 'up', versionId: null } })?.needsManual,
  ).toEqual({
    direction: 'up',
    versionId: null,
  });
  // 额外字段被校验器去掉
  const extra = sanitizeSummary({ ...base, needsManual: { ...ok, junk: 1 } as never });
  expect(extra?.needsManual).toEqual(ok);
  // 旧格式 true、方向不合法、缺 versionId、类型不对：丢掉，其他字段保留
  for (const bad of [
    true,
    false,
    1,
    'up',
    {},
    { direction: 'sideways', versionId: null },
    { direction: 'up' },
    [],
  ]) {
    const r = sanitizeSummary({ ...base, needsManual: bad as never })!;
    expect(r, JSON.stringify(bad)).not.toHaveProperty('needsManual');
    expect(r).toMatchObject({ total: 1, message: '短句' });
  }
});

test('runVersionId：回滚取 fromVersion，升级 / 基线取 toVersion；对应字段是 null 就返回 null，不回退到另一个', () => {
  const run = (over: Record<string, unknown>) =>
    ({ id: 1, status: 'done', stepIndex: null, error: null, ...over }) as never;
  expect(runVersionId(run({ direction: 'up', fromVersion: 'a', toVersion: 'b' }))).toBe('b');
  expect(runVersionId(run({ direction: 'baseline', fromVersion: null, toVersion: 'b' }))).toBe('b');
  expect(runVersionId(run({ direction: 'down', fromVersion: 'b', toVersion: 'a' }))).toBe('b');
  expect(runVersionId(run({ direction: 'down', fromVersion: null, toVersion: 'a' }))).toBeNull();
  expect(runVersionId(run({ direction: 'up', fromVersion: 'a', toVersion: null }))).toBeNull();
});

test('runTouched：完成、做了一部分（含 -1）、读回失败都算碰过；干净的失败、没开始的 running 不算', () => {
  const run = (over: Record<string, unknown>) =>
    ({ id: 1, status: 'failed', stepIndex: null, error: null, direction: 'up', ...over }) as never;
  expect(runTouched(run({ status: 'done' }))).toBe(true);
  expect(runTouched(run({ stepIndex: 0 }))).toBe(true);
  expect(runTouched(run({ stepIndex: -1 }))).toBe(true);
  expect(runTouched(run({ error: '[readback_mismatch] x' }))).toBe(true);
  expect(runTouched(run({}))).toBe(false);
  expect(runTouched(run({ status: 'running' }))).toBe(false);
});

const meta = (id: string, number: number, parentId: string | null, retired = false): VersionMeta => ({
  id,
  number,
  parentId,
  retired,
  name: `v${number}`,
  verifiedAt: null,
  edited: false,
  upSteps: [],
  downSteps: [],
  verifyReport: null,
});

test('versionStates：按树结构计算 applied / current / pending / retired（含停在已作废岔路）', () => {
  // 树：v1(root) → v2 → v3(retired) → v4(retired, current)
  //                ↘ v5(active) → v6(active)
  //                ↘ v7(retired 另一条旧岔路)
  const tree = [
    meta('v1', 1, null, false),
    meta('v2', 2, 'v1', false),
    meta('v3', 3, 'v2', true),
    meta('v4', 4, 'v3', true),
    meta('v5', 5, 'v2', false),
    meta('v6', 6, 'v5', false),
    meta('v7', 7, 'v2', true),
  ];

  // 空库（currentId = null）：未作废均为 pending，已作废均为 retired
  expect(Object.fromEntries(versionStates(tree, null))).toEqual({
    v1: 'pending',
    v2: 'pending',
    v3: 'retired',
    v4: 'retired',
    v5: 'pending',
    v6: 'pending',
    v7: 'retired',
  });

  // 环境停在已作废岔路 v4：v1/v2/v3 是严格祖先（applied，即使 v3 已作废），v4 是 current，v5/v6 是 pending，v7 是 retired
  expect(Object.fromEntries(versionStates(tree, 'v4'))).toEqual({
    v1: 'applied',
    v2: 'applied',
    v3: 'applied',
    v4: 'current',
    v5: 'pending',
    v6: 'pending',
    v7: 'retired',
  });

  // 环境在活跃版本 v5：v1/v2 applied，v5 current，v6 pending，所有岔路已作废均为 retired
  expect(Object.fromEntries(versionStates(tree, 'v5'))).toEqual({
    v1: 'applied',
    v2: 'applied',
    v3: 'retired',
    v4: 'retired',
    v5: 'current',
    v6: 'pending',
    v7: 'retired',
  });

  // toEnvVersion 填充 parentId / retired 并使用 versionStates
  const states = versionStates(tree, 'v4');
  const v3Env = toEnvVersion(tree[2]!, tree[3], new Set(['v3']), 'pg', states);
  const v5Env = toEnvVersion(tree[4]!, tree[3], new Set(), 'pg', states);
  expect(v3Env).toMatchObject({
    id: 'v3',
    parentId: 'v2',
    retired: true,
    state: 'applied',
    executedHere: true,
  });
  expect(v5Env).toMatchObject({
    id: 'v5',
    parentId: 'v2',
    retired: false,
    state: 'pending',
    executedHere: false,
  });
});
