// SQL Server 持久化计算列的显式 / 推断非空（Issue #161，ADR 0019）：快照导入映射、线上结构对齐与读回比较。零数据库。
// 系统目录分不出 `PERSISTED NOT NULL` 与推断非空（is_nullable 都是 0），导入一律记成推断；有参考模型时沿用它的拆分。
import { type Column, emptyModel, type Model, runMutator, setMssqlInferredNotNull } from '@dowel/core';
import {
  alignMssqlImportedLive,
  importMssqlSnapshot,
  type MssqlColSnap,
  type MssqlSnapshot,
  type TargetSnapshot,
} from '@dowel/engines';
import { describe, expect, test } from 'vitest';

import { diffAgainst, importLive } from '../src/index.ts';

const colSnap = (columnId: number, over: Partial<MssqlColSnap>): MssqlColSnap => ({
  columnId,
  type: 'nvarchar(10)',
  notNull: false,
  default: null,
  defaultName: null,
  identity: null,
  generated: null,
  collation: null,
  sparse: false,
  rowguidcol: false,
  comment: null,
  ...over,
});

/** 线上 dbo.items：code NOT NULL、cp AS ([code]) PERSISTED（读回 is_nullable = 0）、total AS ([a]+[b]) PERSISTED（可空）、v 非持久化 */
const snapshot = (): TargetSnapshot<MssqlSnapshot> => {
  const payload: MssqlSnapshot = {
    version: '16.0.4135.4',
    versionNum: 160000,
    major: 16,
    schemas: { dbo: { comment: null } },
    sequences: {},
    opaques: {},
    tables: {
      'dbo.items': {
        schema: 'dbo',
        name: 'items',
        comment: null,
        constraints: {},
        indexes: {},
        columns: {
          code: colSnap(1, { notNull: true }),
          cp: colSnap(2, { notNull: true, generated: { expr: '([code])', stored: true } }),
          total: colSnap(3, { type: 'int', generated: { expr: '([a]+[b])', stored: true } }),
          v: colSnap(4, { generated: { expr: '([code])', stored: false } }),
        },
      },
    },
  };
  return { dialect: 'mssql', version: payload.version, versionNum: payload.versionNum, payload };
};

const colByName = (m: Model, name: string) =>
  Object.values(m.objects).find((o): o is Column => o.kind === 'column' && o.name === name)!;

/** 与 snapshot() 同结构的版本模型；cp 的显式 / 推断由参数决定 */
const model = (cp: { notNull: boolean; inferred: boolean }): Model => {
  const m = emptyModel('mssql');
  runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
  runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'code', name: 'code', type: 'nvarchar(10)', notNull: true },
  });
  runMutator(m, 'addColumn', {
    table: 't',
    column: {
      id: 'cp',
      name: 'cp',
      type: 'nvarchar(10)',
      notNull: cp.notNull,
      generated: { expr: '([code])', stored: true },
    },
  });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'total', name: 'total', type: 'int', generated: { expr: '([a]+[b])', stored: true } },
  });
  runMutator(m, 'addColumn', {
    table: 't',
    column: { id: 'v', name: 'v', type: 'nvarchar(10)', generated: { expr: '([code])', stored: false } },
  });
  if (cp.inferred) setMssqlInferredNotNull(m.objects.cp as Column, true);
  return m;
};

describe('快照导入：持久化计算列的非空一律记成推断', () => {
  test('is_nullable = 0 的持久化计算列 → notNull: false + inferredNotNull: true；其他列不变', () => {
    const m = importMssqlSnapshot(snapshot().payload);
    expect(colByName(m, 'cp')).toMatchObject({ notNull: false, ext: { mssql: { inferredNotNull: true } } });
    expect(colByName(m, 'total').notNull).toBe(false);
    expect(colByName(m, 'total').ext).toBeUndefined();
    expect(colByName(m, 'v').notNull).toBe(false);
    expect(colByName(m, 'v').ext).toBeUndefined();
    expect(colByName(m, 'code')).toMatchObject({ notNull: true });
    expect(colByName(m, 'code').ext).toBeUndefined();
  });
});

describe('线上结构对齐与读回比较', () => {
  test('参考模型显式声明 PERSISTED NOT NULL：拉取 / 漂移读回沿用显式声明，读回比较无差异', () => {
    const ref = model({ notNull: true, inferred: true });
    const live = importLive(snapshot(), ref);
    expect(live.objects.cp).toMatchObject({ notNull: true, ext: { mssql: { inferredNotNull: true } } });
    expect(diffAgainst(snapshot(), ref).total).toBe(0);
  });

  test('参考模型是推断非空：读回保持推断形态，读回比较无差异', () => {
    const ref = model({ notNull: false, inferred: true });
    const live = importLive(snapshot(), ref);
    expect(live.objects.cp).toMatchObject({ notNull: false, ext: { mssql: { inferredNotNull: true } } });
    expect(diffAgainst(snapshot(), ref).total).toBe(0);
  });

  test('有效可空性不一致时不对齐、读回比较报差异（严格，不容忍）', () => {
    const ref = model({ notNull: false, inferred: false });
    const live = importLive(snapshot(), ref);
    expect(live.objects.cp).toMatchObject({ notNull: false, ext: { mssql: { inferredNotNull: true } } });
    expect(diffAgainst(snapshot(), ref).total).toBeGreaterThan(0);
  });

  test('表达式变了（线上被改过）不沿用参考模型的显式声明', () => {
    const ref = model({ notNull: true, inferred: true });
    (ref.objects.cp as Column).generated = { expr: '(upper([code]))', stored: true };
    const imported = importMssqlSnapshot(snapshot().payload);
    const aligned = alignMssqlImportedLive(
      { ...imported, objects: { ...imported.objects } },
      { ...ref, objects: { ...ref.objects, [colByName(imported, 'cp').id]: ref.objects.cp! } },
    );
    expect(colByName(aligned, 'cp').notNull).toBe(false);
  });
});
