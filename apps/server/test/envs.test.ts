// envs.ts 里的纯函数：漂移摘要的清洗（旧格式兼容）、按全部执行记录算“碰过目标库的版本”
import type { DriftSummary } from '@dowel/api';
import { runTouched, runVersionId } from '@dowel/executor';
import { expect, test } from 'vitest';
import { sanitizeSummary } from '../src/envs.ts';

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
