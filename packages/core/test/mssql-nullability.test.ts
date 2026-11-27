// SQL Server 持久化计算列：显式 NOT NULL 与引擎推断的非空分开存（Issue #161，ADR 0019）。零数据库。
// - DDL 只渲染显式 notNull；ext.mssql.inferredNotNull 从不渲染；
// - 规划器（也是执行读回比较）按有效可空性 notNull || inferredNotNull 比较；
// - inferredNotNull 是派生字段：addColumn / setColumnExt / alterColumn 宏都不能由调用方设置；
// - 主键校验按有效可空性；其他方言不读 ext.mssql。
import { describe, expect, test } from 'vitest';

import {
  type Column,
  effectiveNotNull,
  emptyModel,
  type Model,
  mssqlEffectiveNotNull,
  plan,
  runMacro,
  runMutator,
  setMssqlInferredNotNull,
  validate,
} from '../src/index.ts';

/** dbo.items(id int NOT NULL PK, code nvarchar(10) [NOT NULL], cp AS ([code]) PERSISTED) */
const base = (opts: { codeNotNull?: boolean; cpNotNull?: boolean; inferred?: boolean } = {}): Model => {
  const m = emptyModel('mssql');
  runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
  runMutator(m, 'addColumn', { table: 't', column: { id: 'id', name: 'id', type: 'int', notNull: true } });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'code', name: 'code', type: 'nvarchar(10)', notNull: opts.codeNotNull ?? false },
  });
  runMutator(m, 'addColumn', {
    table: 't',
    column: {
      id: 'cp',
      name: 'cp',
      type: 'nvarchar(10)',
      notNull: opts.cpNotNull ?? false,
      generated: { expr: '([code])', stored: true },
    },
  });
  if (opts.inferred) setMssqlInferredNotNull(col(m, 'cp'), true);
  return m;
};

const col = (m: Model, id: string) => m.objects[id] as Column;
const sqlOf = (from: Model, to: Model) => plan(from, to).map((s) => s.sql);
const empty = () => {
  const m = emptyModel('mssql');
  runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
  return m;
};

describe('DDL 渲染：只看显式 notNull', () => {
  test('推断非空不渲染 NOT NULL，显式声明渲染 PERSISTED NOT NULL', () => {
    const inferred = base({ codeNotNull: true, inferred: true });
    const ddl = sqlOf(empty(), inferred).join('\n');
    expect(ddl).toContain('[cp] AS (([code])) PERSISTED\n)');
    expect(ddl).not.toContain('PERSISTED NOT NULL');

    const explicit = base({ codeNotNull: true, cpNotNull: true, inferred: true });
    expect(sqlOf(empty(), explicit).join('\n')).toContain('[cp] AS (([code])) PERSISTED NOT NULL');
  });

  test('重建计算列（表达式变了）时同样只渲染显式声明', () => {
    const from = base({ codeNotNull: true, inferred: true });
    const to = structuredClone(from);
    col(to, 'cp').generated = { expr: '(upper([code]))', stored: true };
    const steps = sqlOf(from, to);
    expect(steps).toContain('ALTER TABLE [dbo].[items] ADD [cp] AS ((upper([code]))) PERSISTED');
  });
});

describe('规划器按有效可空性比较', () => {
  test('显式 NOT NULL ↔ 推断非空互换（有效值不变）：不生成迁移', () => {
    const explicit = base({ codeNotNull: true, cpNotNull: true, inferred: true });
    const inferred = base({ codeNotNull: true, inferred: true });
    expect(sqlOf(explicit, inferred)).toEqual([]);
    expect(sqlOf(inferred, explicit)).toEqual([]);
    // 旧规则写回、没有 inferredNotNull 的存量模型（notNull: true）与新形态之间也不生成迁移
    expect(sqlOf(base({ codeNotNull: true, cpNotNull: true }), inferred)).toEqual([]);
  });

  test('有效可空性变了（推断非空 → 可空）：重建计算列，不带 NOT NULL', () => {
    const from = base({ codeNotNull: true, inferred: true });
    const to = structuredClone(from);
    setMssqlInferredNotNull(col(to, 'cp'), false);
    expect(sqlOf(from, to)).toEqual([
      'ALTER TABLE [dbo].[items] DROP COLUMN [cp]',
      'ALTER TABLE [dbo].[items] ADD [cp] AS (([code])) PERSISTED',
    ]);
  });

  test('读回比较（plan(线上, 模型)）：线上读回成推断形态，显式与推断的模型都一致；有效值不同就有差异', () => {
    const live = base({ codeNotNull: true, inferred: true });
    expect(plan(live, base({ codeNotNull: true, cpNotNull: true }))).toEqual([]);
    expect(plan(live, base({ codeNotNull: true, cpNotNull: true, inferred: true }))).toEqual([]);
    const stale = base({ codeNotNull: true });
    expect(plan(live, stale).length).toBeGreaterThan(0);
    expect(plan(stale, live).length).toBeGreaterThan(0);
  });

  test('Issue #161 场景：code 改回可空后不再生成用户没声明的 NOT NULL', () => {
    // 1. code 可空、cp AS ([code]) PERSISTED（推断可空）
    const v1 = base();
    // 2. code 改成 NOT NULL，规范化写回推断非空（只写 inferredNotNull，显式 notNull 仍是 false）
    const v2 = structuredClone(v1);
    runMutator(v2, 'setNotNull', { id: 'code', notNull: true });
    setMssqlInferredNotNull(col(v2, 'cp'), true);
    expect(col(v2, 'cp').notNull).toBe(false);
    // 3. code 改回可空，规范化写回推断可空
    const v3 = structuredClone(v2);
    runMutator(v3, 'setNotNull', { id: 'code', notNull: false });
    setMssqlInferredNotNull(col(v3, 'cp'), false);
    const steps = sqlOf(v2, v3);
    expect(steps).toContain('ALTER TABLE [dbo].[items] ADD [cp] AS (([code])) PERSISTED');
    expect(steps.join('\n')).not.toContain('NOT NULL\n');
    expect(steps.some((s) => /\[cp\].*NOT NULL/.test(s))).toBe(false);
    // 即使规范化没来得及跑（推断值还是旧的），DDL 也不会出现 NOT NULL
    const stale = structuredClone(v2);
    runMutator(stale, 'setNotNull', { id: 'code', notNull: false });
    expect(sqlOf(v2, stale).some((s) => /\[cp\].*NOT NULL/.test(s))).toBe(false);
  });

  test('显式 PERSISTED NOT NULL 在重建时保留', () => {
    const from = base({ codeNotNull: true, cpNotNull: true, inferred: true });
    const to = structuredClone(from);
    runMutator(to, 'setNotNull', { id: 'code', notNull: false });
    setMssqlInferredNotNull(col(to, 'cp'), false);
    expect(sqlOf(from, to)).toContain('ALTER TABLE [dbo].[items] ADD [cp] AS (([code])) PERSISTED NOT NULL');
  });

  test('非持久化计算列与普通列不受影响：推断标记被忽略', () => {
    const m = base({ codeNotNull: true });
    const virt = structuredClone(m);
    col(virt, 'cp').generated = { expr: '([code])', stored: false };
    const tagged = structuredClone(virt);
    col(tagged, 'cp').ext = { mssql: { inferredNotNull: true } };
    col(tagged, 'code').ext = { mssql: { inferredNotNull: true } };
    expect(mssqlEffectiveNotNull(col(tagged, 'cp'))).toBe(false);
    expect(mssqlEffectiveNotNull(col(tagged, 'code'))).toBe(true);
    expect(sqlOf(virt, tagged)).toEqual([]);
    const ordinary = structuredClone(m);
    runMutator(ordinary, 'setNotNull', { id: 'code', notNull: false });
    expect(sqlOf(m, ordinary)).toContain('ALTER TABLE [dbo].[items] ALTER COLUMN [code] nvarchar(10) NULL');
  });
});

describe('inferredNotNull 是派生字段：写入入口都不接受调用方的值', () => {
  test('addColumn 丢掉传入的 inferredNotNull', () => {
    const m = base();
    runMutator(m, 'addColumn', {
      table: 't',
      column: {
        id: 'cp2',
        name: 'cp2',
        type: 'nvarchar(10)',
        generated: { expr: '([code])', stored: true },
        ext: { mssql: { inferredNotNull: true, sparse: undefined } },
      },
    });
    expect(col(m, 'cp2').ext).toBeUndefined();
  });

  test('setColumnExt 忽略传入值、保留当前值', () => {
    const m = base({ codeNotNull: true, inferred: true });
    runMutator(m, 'setColumnExt', { id: 'cp', ext: null });
    expect(col(m, 'cp').ext).toEqual({ mssql: { inferredNotNull: true } });
    const n = base({ codeNotNull: true });
    runMutator(n, 'setColumnExt', { id: 'cp', ext: { mssql: { inferredNotNull: true } } });
    expect(col(n, 'cp').ext).toBeUndefined();
  });

  test('alterColumn 宏：回传读到的 ext（含 inferredNotNull）不产生 setColumnExt，值保持不变', () => {
    const m = base({ codeNotNull: true, inferred: true });
    const r = runMacro(m, 'alterColumn', { id: 'cp', ext: { mssql: {} } });
    expect(r.ops).toEqual([]);
    const r2 = runMacro(m, 'alterColumn', { id: 'cp', ext: { mssql: { inferredNotNull: false } } });
    expect(r2.ops).toEqual([]);
    expect(col(m, 'cp').ext?.mssql?.inferredNotNull).toBe(true);
  });

  test('显式 notNull 的开关只改 notNull，不动推断值', () => {
    const m = base({ codeNotNull: true, inferred: true });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: true });
    expect(col(m, 'cp')).toMatchObject({ notNull: true, ext: { mssql: { inferredNotNull: true } } });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: false });
    expect(col(m, 'cp')).toMatchObject({ notNull: false, ext: { mssql: { inferredNotNull: true } } });
  });
});

describe('主键与有效可空性', () => {
  test('推断非空的持久化计算列可以作主键；去掉显式 NOT NULL 后仍由推断兜住', () => {
    const m = base({ codeNotNull: true, inferred: true });
    runMutator(m, 'dropColumn', { id: 'id' });
    runMutator(m, 'addPrimaryKey', { id: 'pk', table: 't', columns: ['cp'] });
    expect(validate(m)).toEqual([]);
    // addPrimaryKey 把主键列设为显式 NOT NULL；再去掉显式声明，推断非空仍满足主键
    runMutator(m, 'setNotNull', { id: 'cp', notNull: false });
    expect(validate(m)).toEqual([]);
    // 推断可空时不允许
    const n = base({ codeNotNull: true, cpNotNull: true });
    runMutator(n, 'dropColumn', { id: 'id' });
    runMutator(n, 'addPrimaryKey', { id: 'pk', table: 't', columns: ['cp'] });
    expect(() => runMutator(n, 'setNotNull', { id: 'cp', notNull: false })).toThrow('主键列必须 NOT NULL');
  });
});

describe('其他方言不读 ext.mssql.inferredNotNull', () => {
  test.each(['pg', 'mysql', 'sqlite'] as const)('%s：有效可空性只看 notNull', (dialect) => {
    const c = {
      kind: 'column',
      notNull: false,
      generated: { expr: 'a', stored: true },
      ext: { mssql: { inferredNotNull: true } },
    } as unknown as Column;
    expect(effectiveNotNull(dialect, c)).toBe(false);
    expect(effectiveNotNull('mssql', c)).toBe(true);
  });
});
