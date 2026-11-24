// #88：索引元素必须恰好是列或非空表达式之一，elements 不能为空；
// mutator 参数校验与 addIndex 都要拒绝非法元素，不能写出 validate() 不认可的模型。
import { describe, expect, test } from 'vitest';

import * as E from '../src/index.ts';

const SCHEMA: Record<E.Dialect, string> = { pg: 'public', mysql: 'default', sqlite: 'main', mssql: 'dbo' };
const DIALECTS = Object.keys(SCHEMA) as E.Dialect[];
/** MSSQL 不支持表达式键（请改用计算列） */
const EXPR_DIALECTS: E.Dialect[] = ['pg', 'mysql', 'sqlite'];

const setup = (dialect: E.Dialect) => {
  const m = E.emptyModel(dialect);
  const s = E.createSchema(m, SCHEMA[dialect], 's1');
  const t = E.createTable(m, s, 'users', 't1');
  E.addColumn(m, t, { id: 'c1', name: 'email', type: dialect === 'mssql' ? 'nvarchar(255)' : 'text' });
  return m;
};

const INVALID_ELEMENTS: [string, Partial<E.IndexElement>][] = [
  ['空对象', {}],
  ['column 与 expr 都为 null', { column: null, expr: null }],
  ['空表达式', { expr: '' }],
  ['纯空白表达式', { expr: '   ' }],
  ['column 与 expr 同时提供', { column: 'c1', expr: 'lower(email)' }],
  ['column 与空表达式同时提供', { column: 'c1', expr: '' }],
];

describe.each(DIALECTS)('addIndex 元素校验（%s）', (dialect) => {
  test.each(INVALID_ELEMENTS)('runMutator 拒绝非法元素：%s', (_, el) => {
    const m = setup(dialect);
    const before = structuredClone(m);
    expect(() => E.runMutator(m, 'addIndex', { id: 'ix1', table: 't1', elements: [el] })).toThrow(
      E.EditError,
    );
    expect(m).toEqual(before);
    expect(E.validate(m)).toEqual([]);
  });

  test.each(INVALID_ELEMENTS)('E.addIndex 拒绝非法元素：%s', (_, el) => {
    const m = setup(dialect);
    const before = structuredClone(m);
    expect(() => E.addIndex(m, 't1', [el], {}, 'ix1')).toThrow(E.EditError);
    expect(m).toEqual(before);
  });

  test('合法元素后跟非法元素时整体拒绝', () => {
    const m = setup(dialect);
    expect(() =>
      E.runMutator(m, 'addIndex', { id: 'ix1', table: 't1', elements: [{ column: 'c1' }, { expr: ' ' }] }),
    ).toThrow(E.EditError);
    expect(() => E.addIndex(m, 't1', [{ column: 'c1' }, {}], {}, 'ix1')).toThrow(E.EditError);
    expect(E.find(m, 'ix1')).toBeUndefined();
  });

  test('elements 为空时拒绝', () => {
    const m = setup(dialect);
    expect(() => E.runMutator(m, 'addIndex', { id: 'ix1', table: 't1', elements: [] })).toThrow(E.EditError);
    expect(() => E.addIndex(m, 't1', [], {}, 'ix1')).toThrow(E.EditError);
    expect(E.find(m, 'ix1')).toBeUndefined();
  });

  test('列索引正常创建并可规划', () => {
    const m0 = setup(dialect);
    const m1 = structuredClone(m0);
    E.runMutator(m1, 'addIndex', { id: 'ix1', table: 't1', elements: [{ column: 'c1' }] });
    E.addIndex(m1, 't1', [{ column: 'c1', desc: true }], {}, 'ix2');
    expect(E.get(m1, 'ix1', 'index').elements[0]).toMatchObject({ column: 'c1', expr: null });
    expect(E.validate(m1)).toEqual([]);
    const steps = E.plan(m0, m1);
    expect(steps.filter((s) => /CREATE\s+(UNIQUE\s+)?(NONCLUSTERED\s+)?INDEX/i.test(s.sql))).toHaveLength(2);
  });
});

describe.each(EXPR_DIALECTS)('表达式索引（%s）', (dialect) => {
  test('表达式索引正常创建并可规划', () => {
    const m0 = setup(dialect);
    const m1 = structuredClone(m0);
    E.runMutator(m1, 'addIndex', { id: 'ix1', table: 't1', elements: [{ expr: 'lower(email)' }] });
    E.addIndex(m1, 't1', [{ column: null, expr: 'upper(email)' }], {}, 'ix2');
    expect(E.get(m1, 'ix1', 'index').elements[0]).toMatchObject({ column: null, expr: 'lower(email)' });
    expect(E.validate(m1)).toEqual([]);
    const sql = E.plan(m0, m1)
      .map((s) => s.sql)
      .join('\n');
    expect(sql).toMatch(/lower\(/i);
    expect(sql).toMatch(/upper\(/i);
    expect(sql).not.toMatch(/\(\s*null\s*\)/i);
  });
});

test('validate() 与 addIndex 使用同一规则：纯空白表达式、列与表达式并存都视为非法', () => {
  const m = setup('pg');
  E.addIndex(m, 't1', [{ column: 'c1' }], {}, 'ix1');
  const ix = E.get(m, 'ix1', 'index');
  ix.elements = [{ ...ix.elements[0]!, column: null, expr: '   ' }];
  expect(E.validate(m)).toEqual([`索引 ${ix.name}：元素必须是列或表达式之一`]);
  ix.elements = [{ ...ix.elements[0]!, column: 'c1', expr: 'lower(email)' }];
  expect(E.validate(m)).toEqual([`索引 ${ix.name}：元素必须是列或表达式之一`]);
});
