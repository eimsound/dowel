// 执行策略保存之后的缓存失效：任何一层保存，所有依赖生效策略的查询（环境列表、环境状态、各环境 / 各层的配置页）都要失效，
// 刚保存的那一个（已经用响应写回）不失效；无关的查询不动。
import { QueryClient } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { invalidatePolicyDependents } from '../src/policy-cache.ts';

test('保存项目层后：环境列表、环境状态、环境层配置页、其他层配置页都失效，刚保存的和无关的不动', async () => {
  const qc = new QueryClient();
  const keys = {
    saved: ['exec-policy', 'project', 'p1'],
    group: ['exec-policy', 'group', 'g'],
    envs: ['envs', 'p1'],
    otherEnvs: ['envs', 'p2'],
    status: ['env-status', 'p1', 'e1'],
    envPolicy: ['env-policy', 'p1', 'e1'],
    history: ['env-history', 'p1', 'e1'],
    versions: ['versions', 'p1'],
  };
  for (const k of Object.values(keys)) qc.setQueryData(k, { x: 1 });
  invalidatePolicyDependents(qc, keys.saved);
  const invalid = (k: unknown[]) => qc.getQueryState(k)!.isInvalidated;
  for (const k of [keys.group, keys.envs, keys.otherEnvs, keys.status, keys.envPolicy])
    expect(invalid(k), String(k)).toBe(true);
  for (const k of [keys.saved, keys.history, keys.versions]) expect(invalid(k), String(k)).toBe(false);
});

test('转组后（没有“刚保存的那一个”）：所有依赖生效策略的查询都失效，包括项目层自己的配置页', async () => {
  const qc = new QueryClient();
  const keys = [
    ['exec-policy', 'project', 'p1'],
    ['exec-policy', 'group', 'old'],
    ['envs', 'p1'],
    ['env-status', 'p1', 'e1'],
    ['env-policy', 'p1', 'e1'],
  ];
  const untouched = [
    ['project', 'p1'],
    ['env-history', 'p1', 'e1'],
  ];
  for (const k of [...keys, ...untouched]) qc.setQueryData(k, { x: 1 });
  await invalidatePolicyDependents(qc);
  for (const k of keys) expect(qc.getQueryState(k)!.isInvalidated, String(k)).toBe(true);
  for (const k of untouched) expect(qc.getQueryState(k)!.isInvalidated, String(k)).toBe(false);
});
