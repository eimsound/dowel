// Inspector 的“非空”复选框与 NN 徽标（Issue #161，ADR 0019）：复选框只绑显式 notNull；
// SQL Server 持久化计算列由引擎推断为非空时不勾选、显示只读提示，徽标与画布按有效可空性显示。
import { type Column, emptyModel, type Model, runMutator, setMssqlInferredNotNull } from '@dowel/core';
import { afterEach, describe, expect, test } from 'vitest';

import i18n from '../src/i18n.ts';
import { columnNullability } from '../src/nullability.ts';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

const mssql = (cp: { notNull?: boolean; inferred?: boolean; stored?: boolean } = {}): Model => {
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
      notNull: cp.notNull ?? false,
      generated: { expr: '([code])', stored: cp.stored ?? true },
    },
  });
  if (cp.inferred) setMssqlInferredNotNull(m.objects.cp as Column, true);
  return m;
};
const state = (m: Model, id = 'cp') => columnNullability(m, m.objects[id] as Column);

describe('columnNullability', () => {
  test('显式声明：勾选、徽标、无推断提示（不论是否也推断为非空）', () => {
    expect(state(mssql({ notNull: true }))).toEqual({ explicit: true, effective: true, inferredOnly: false });
    expect(state(mssql({ notNull: true, inferred: true }))).toEqual({
      explicit: true,
      effective: true,
      inferredOnly: false,
    });
  });

  test('只由引擎推断：不勾选、显示推断提示、徽标仍显示', () => {
    expect(state(mssql({ inferred: true }))).toEqual({
      explicit: false,
      effective: true,
      inferredOnly: true,
    });
  });

  test('可空：不勾选、无提示、无徽标', () => {
    expect(state(mssql())).toEqual({ explicit: false, effective: false, inferredOnly: false });
  });

  test('勾选推断列 → 显式；再取消 → 回到推断提示（推断值不变）', () => {
    const m = mssql({ inferred: true });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: true });
    expect(state(m)).toEqual({ explicit: true, effective: true, inferredOnly: false });
    runMutator(m, 'setNotNull', { id: 'cp', notNull: false });
    expect(state(m)).toEqual({ explicit: false, effective: true, inferredOnly: true });
  });

  test('非持久化计算列与普通列：不看推断标记', () => {
    const m = mssql({ stored: false });
    (m.objects.cp as Column).ext = { mssql: { inferredNotNull: true } };
    expect(state(m)).toEqual({ explicit: false, effective: false, inferredOnly: false });
    expect(state(m, 'code')).toEqual({ explicit: true, effective: true, inferredOnly: false });
  });

  test('其他方言不读 ext.mssql', () => {
    const m = emptyModel('pg');
    runMutator(m, 'createSchema', { id: 's', name: 'public' });
    runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
    runMutator(m, 'addColumn', {
      table: 't',
      column: { id: 'g', name: 'g', type: 'integer', generated: { expr: '(1)', stored: true } },
    });
    (m.objects.g as Column).ext = { mssql: { inferredNotNull: true } };
    expect(state(m, 'g')).toEqual({ explicit: false, effective: false, inferredOnly: false });
  });

  test('提示与徽标文案（中 / 英）', async () => {
    expect(i18n.t('insp.notNullInferredHint')).toBe(
      '由表达式推断为非空，DDL 不写 NOT NULL；勾选才是显式声明。推断结果在规范化时更新。',
    );
    expect(i18n.t('insp.notNullInferred')).toBe('由表达式推断为非空（未显式声明）');
    await i18n.changeLanguage('en');
    expect(i18n.t('insp.notNullInferredHint')).toBe(
      'Inferred non-null from the expression; the DDL does not add NOT NULL. Check the box to declare it explicitly. Updated on normalization.',
    );
    expect(i18n.t('insp.notNullInferred')).toBe('Inferred non-null from the expression (not explicit)');
  });
});
