// 从已有 SQL Server 数据库导入 / 拉取后拆分持久化计算列的显式 NOT NULL 与推断非空（ADR 0019 决定 4）。零数据库：
// 影子库用假对象，只断言调用与拆分结果。真实 SQL Server 上的探测见 mssql-target.test.ts。
import { type Column, emptyModel, type Model, runMutator, setMssqlInferredNotNull } from '@dowel/core';
import { mssqlAlignedColumnIds } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, test, vi } from 'vitest';

import { splitImportedMssqlNullability } from '../src/mssql-nullability.ts';
import { type Shadow, ShadowConfigChangedError, ShadowError } from '../src/shadow.ts';

/**
 * 导入形态的 dbo.items：k 主键成员、cp / cu 读回非空（导入记成推断）、n 可空的持久化计算列、v 非持久化、code 普通列
 */
const imported = (): Model => {
  const m = emptyModel('mssql');
  runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'code', name: 'code', type: 'nvarchar(10)', notNull: true },
  });
  const computed = (id: string, expr: string, stored = true) =>
    runMutator(m, 'addColumn', {
      table: 't',
      column: { id, name: id, type: 'nvarchar(10)', generated: { expr, stored } },
    });
  computed('k', '(CONVERT([varchar](10),[code]))');
  computed('cp', '([code])');
  computed('cu', '(upper([code]))');
  computed('n', '(upper([code]))');
  computed('v', '([code])', false);
  runMutator(m, 'addPrimaryKey', { id: 'pk', table: 't', columns: ['k'] });
  // 导入形态：读回非空的持久化计算列一律 notNull: false + inferredNotNull: true（主键成员也一样）
  for (const id of ['k', 'cp', 'cu']) {
    const c = m.objects[id] as Column;
    c.notNull = false;
    setMssqlInferredNotNull(c, true);
  }
  return m;
};

const col = (m: Model, id: string) => m.objects[id] as Column;
const split = (m: Model, id: string) => ({
  notNull: col(m, id).notNull,
  inferred: col(m, id).ext?.mssql?.inferredNotNull === true,
});

const fakeShadow = (result: Record<string, boolean>) => {
  const probe = vi.fn(async (_m: Model, ids: readonly string[]) => {
    return new Map(ids.map((id) => [id, result[id]!]));
  });
  return { shadow: { probeMssqlNotNull: probe } as unknown as Shadow, probe };
};

describe('splitImportedMssqlNullability', () => {
  test('主键成员直接记显式、不探测；其余按影子库探测拆分；无需提示', async () => {
    const { shadow, probe } = fakeShadow({ cp: true, cu: false });
    const r = await splitImportedMssqlNullability(imported(), async () => shadow);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![1]).toEqual(['cp', 'cu']);
    expect(split(r.model, 'k')).toEqual({ notNull: true, inferred: false });
    expect(split(r.model, 'cp')).toEqual({ notNull: false, inferred: true });
    expect(split(r.model, 'cu')).toEqual({ notNull: true, inferred: false });
    expect(split(r.model, 'n')).toEqual({ notNull: false, inferred: false });
    expect(split(r.model, 'v')).toEqual({ notNull: false, inferred: false });
    expect(r.fallback).toEqual([]);
  });

  test('没有可用的影子库：不拦截，非主键的候选列全部记显式并列出完整限定名', async () => {
    const r = await splitImportedMssqlNullability(imported(), async () => {
      throw new ShadowError('生产环境默认不在同一实例上建影子库');
    });
    expect(split(r.model, 'k')).toEqual({ notNull: true, inferred: false });
    expect(split(r.model, 'cp')).toEqual({ notNull: true, inferred: false });
    expect(split(r.model, 'cu')).toEqual({ notNull: true, inferred: false });
    expect(r.fallback).toEqual(['dbo.items.cp', 'dbo.items.cu']);
  });

  test('探测本身失败（例如影子库里建不出模型）同样按显式兜底并提示', async () => {
    const shadow = {
      probeMssqlNotNull: async () => {
        throw new Error('CREATE TABLE failed');
      },
    } as unknown as Shadow;
    const r = await splitImportedMssqlNullability(imported(), async () => shadow);
    expect(r.fallback).toEqual(['dbo.items.cp', 'dbo.items.cu']);
  });

  test('白名单拒绝（HTTPException）照常抛出', async () => {
    await expect(
      splitImportedMssqlNullability(imported(), async () => {
        throw new HTTPException(403, { message: 'blocked' });
      }),
    ).rejects.toBeInstanceOf(HTTPException);
  });

  test('影子库句柄因配置变更被关闭（ShadowConfigChangedError）：可重试，照常抛出，不按显式记录', async () => {
    const shadow = {
      probeMssqlNotNull: async () => {
        throw new ShadowConfigChangedError();
      },
    } as unknown as Shadow;
    await expect(splitImportedMssqlNullability(imported(), async () => shadow)).rejects.toBeInstanceOf(
      ShadowConfigChangedError,
    );
  });

  test('只有主键成员要拆分（或根本没有候选列）：不连影子库', async () => {
    const m = imported();
    for (const id of ['cp', 'cu']) setMssqlInferredNotNull(col(m, id), false);
    const shadowOf = vi.fn(async () => fakeShadow({}).shadow);
    const r = await splitImportedMssqlNullability(m, shadowOf);
    expect(shadowOf).not.toHaveBeenCalled();
    expect(split(r.model, 'k')).toEqual({ notNull: true, inferred: false });
    expect(r.fallback).toEqual([]);

    const pg = emptyModel('pg');
    const same = await splitImportedMssqlNullability(pg, shadowOf);
    expect(same.model).toBe(pg);
    expect(shadowOf).not.toHaveBeenCalled();
  });

  test('拉取：能从工作副本沿用拆分的列不动、不探测；新增 / 变更的列才探测', async () => {
    const working = imported();
    // 工作副本里 cp 是用户显式声明的，cu 已被改成另一个表达式
    col(working, 'cp').notNull = true;
    col(working, 'cu').generated = { expr: '(lower([code]))', stored: true };
    const live = imported();
    const keep = mssqlAlignedColumnIds(live, working);
    // 非持久化的 v 不参与；cu 的表达式变了，不能沿用
    expect([...keep].sort()).toEqual(['cp', 'k', 'n']);
    const { shadow, probe } = fakeShadow({ cu: true });
    const r = await splitImportedMssqlNullability(live, async () => shadow, keep);
    expect(probe.mock.calls[0]![1]).toEqual(['cu']);
    // keep 里的列保持导入形态（readLive 的 alignMssqlImportedLive 已经按工作副本对齐过）
    expect(split(r.model, 'cp')).toEqual({ notNull: false, inferred: true });
    expect(split(r.model, 'cu')).toEqual({ notNull: false, inferred: true });
  });
});
