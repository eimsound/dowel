// ADR 0015 第 3 / 5 节：受控 batch mutator（整批原子、禁止嵌套、按子操作定位错误、依据只含外部对象）与 diagnoseModel 写后静态自检。
import { describe, expect, test } from 'vitest';

import {
  BATCH_MUTATOR,
  BATCH_OPS_LIMIT,
  BATCH_SUMMARY_MAX,
  batchArgs,
  BatchOpError,
  batchSummaryOf,
  COMPOSITE_MUTATORS,
  createSchema,
  createTable,
  addColumn,
  DIAGNOSTICS_ITEMS_LIMIT,
  diagnoseModel,
  EditError,
  emptyModel,
  get,
  type Model,
  readsOf,
  runMutator,
} from '../src/index.ts';

const setup = (): Model => {
  const m = emptyModel('pg');
  createSchema(m, 'public', 's1');
  createTable(m, 's1', 'users', 't1');
  addColumn(m, 't1', { id: 'c1', name: 'email', type: 'text' });
  addColumn(m, 't1', { id: 'c2', name: 'age', type: 'integer' });
  return m;
};

describe('batch mutator', () => {
  test('常量与复合 mutator 集合', () => {
    expect(BATCH_MUTATOR).toBe('batch');
    expect(BATCH_OPS_LIMIT).toBe(500);
    expect(BATCH_SUMMARY_MAX).toBe(500);
    expect([...COMPOSITE_MUTATORS].sort()).toEqual(['batch', 'paste']);
  });

  test('依次执行全部子操作（后一步可引用前一步新建的对象）', () => {
    const m = setup();
    runMutator(m, 'batch', {
      summary: '新增 orders',
      ops: [
        { name: 'createTable', args: { id: 't2', schema: 's1', name: 'orders' } },
        { name: 'addColumn', args: { table: 't2', column: { id: 'c3', name: 'user_id', type: 'bigint' } } },
        { name: 'setComment', args: { id: 't1', comment: '用户' } },
      ],
    });
    expect(get(m, 't2', 'table').name).toBe('orders');
    expect(get(m, 'c3', 'column').parent).toBe('t2');
    expect(get(m, 't1', 'table').comment).toBe('用户');
  });

  test('子操作失败抛 BatchOpError（EditError 子类），带子操作下标、名字与原始错误', () => {
    const m = setup();
    let err: unknown;
    try {
      runMutator(m, 'batch', {
        ops: [
          { name: 'createTable', args: { id: 't2', schema: 's1', name: 'orders' } },
          { name: 'addColumn', args: { table: 't1', column: { id: 'c9', name: 'email', type: 'text' } } },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchOpError);
    expect(err).toBeInstanceOf(EditError);
    const be = err as BatchOpError;
    expect(be.index).toBe(1);
    expect(be.opName).toBe('addColumn');
    expect(be.rawMessage.length).toBeGreaterThan(0);
    expect(be.message).toContain('ops[1] addColumn');
    expect(be.message).toContain(be.rawMessage);
  });

  test('禁止嵌套 batch / paste，未知操作与原型属性名一律拒绝', () => {
    for (const name of ['batch', 'paste', 'nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const m = setup();
      let err: unknown;
      try {
        runMutator(m, 'batch', {
          ops: [
            { name: 'createTable', args: { id: 't2', schema: 's1', name: 'orders' } },
            { name, args: { ops: [{ name: 'createSchema', args: { id: 's9', name: 'x' } }] } },
          ],
        });
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(BatchOpError);
      expect((err as BatchOpError).index).toBe(1);
      expect((err as BatchOpError).opName).toBe(name);
    }
  });

  test('参数校验：ops 非空且不超过上限、summary 去空白后非空且不超长、不允许多余字段', () => {
    const op = { name: 'createSchema', args: { id: 's2', name: 'x' } };
    expect(batchArgs.safeParse({ ops: [op] }).success).toBe(true);
    expect(batchArgs.safeParse({ ops: [] }).success).toBe(false);
    expect(batchArgs.safeParse({ ops: Array.from({ length: BATCH_OPS_LIMIT }, () => op) }).success).toBe(
      true,
    );
    expect(batchArgs.safeParse({ ops: Array.from({ length: BATCH_OPS_LIMIT + 1 }, () => op) }).success).toBe(
      false,
    );
    expect(batchArgs.safeParse({ ops: [op], summary: '   ' }).success).toBe(false);
    expect(batchArgs.safeParse({ ops: [op], summary: 'x'.repeat(BATCH_SUMMARY_MAX + 1) }).success).toBe(
      false,
    );
    expect(batchArgs.safeParse({ ops: [op], extra: 1 }).success).toBe(false);
    expect(batchArgs.safeParse({ ops: [{ ...op, extra: 1 }] }).success).toBe(false);
    expect(() => runMutator(setup(), 'batch', { ops: [] })).toThrow(EditError);
    expect(() => runMutator(setup(), 'batch', { ops: [] })).not.toThrow(BatchOpError);
  });

  test('batchSummaryOf：去首尾空白，空值或非字符串返回 null，超长截断', () => {
    expect(batchSummaryOf({ ops: [], summary: '  加索引  ' })).toBe('加索引');
    expect(batchSummaryOf({ ops: [], summary: '   ' })).toBeNull();
    expect(batchSummaryOf({ ops: [] })).toBeNull();
    expect(batchSummaryOf({ summary: 1 })).toBeNull();
    expect(batchSummaryOf(null)).toBeNull();
    expect(batchSummaryOf(['x'])).toBeNull();
    expect(batchSummaryOf({ summary: 'x'.repeat(BATCH_SUMMARY_MAX + 10) })).toHaveLength(BATCH_SUMMARY_MAX);
  });
});

describe('readsOf(batch)', () => {
  test('只包含整批开始前就存在的对象：本批新建的对象不是外部依据', () => {
    const m = setup();
    const reads = readsOf(
      m,
      {
        ops: [
          { name: 'createTable', args: { id: 't2', schema: 's1', name: 'orders' } },
          { name: 'addColumn', args: { table: 't2', column: { id: 'c3', name: 'user_id', type: 'bigint' } } },
          { name: 'setComment', args: { id: 't2', comment: 'x' } },
        ],
      },
      'batch',
    );
    expect(reads.sort()).toEqual(['s1']);
  });

  test('在既有表上加 CHECK：捕获表达式引用的既有列；引用本批新建列不算外部依据', () => {
    const m = setup();
    const reads = readsOf(
      m,
      {
        ops: [
          { name: 'addColumn', args: { table: 't1', column: { id: 'c3', name: 'score', type: 'integer' } } },
          { name: 'addCheck', args: { id: 'k1', table: 't1', expr: 'age > 0 and score > 0' } },
        ],
      },
      'batch',
    );
    expect(reads.sort()).toEqual(['c2', 't1']);
  });

  test('绝不扫描 summary（即使恰好等于对象 ID 或原型属性名）', () => {
    const m = setup();
    for (const summary of ['t1', 'c1', 'constructor', 'toString']) {
      const reads = readsOf(
        m,
        { summary, ops: [{ name: 'createSchema', args: { id: 's2', name: 'other' } }] },
        'batch',
      );
      expect(reads, summary).toEqual([]);
    }
  });

  test('不传 name 时按普通参数扫描（兼容旧调用）；某一步执行失败后停止收集', () => {
    const m = setup();
    expect(readsOf(m, { id: 't1', comment: 'x' })).toEqual(['t1']);
    const reads = readsOf(
      m,
      {
        ops: [
          { name: 'setComment', args: { id: 'c1', comment: 'x' } },
          { name: 'dropTable', args: { id: 'missing' } },
          { name: 'setComment', args: { id: 'c2', comment: 'y' } },
        ],
      },
      'batch',
    );
    expect(reads).toEqual(['c1']);
  });

  test('不修改传入的模型', () => {
    const m = setup();
    const before = structuredClone(m);
    readsOf(m, { ops: [{ name: 'dropTable', args: { id: 't1' } }] }, 'batch');
    expect(m).toEqual(before);
  });
});

describe('diagnoseModel', () => {
  test('SQLite / 没有缓存的环境版本：target 为 null，只做 validate', () => {
    const m = emptyModel('sqlite');
    createSchema(m, 'main', 's1');
    createTable(m, 's1', 't', 't1');
    addColumn(m, 't1', { id: 'c1', name: 'id', type: 'integer' });
    const d = diagnoseModel(m, [3054001]);
    expect(d).toEqual({
      target: null,
      validation: { total: 0, items: [] },
      compatibility: { errors: { total: 0, items: [] }, warnings: { total: 0, items: [] } },
      blocksPublish: false,
    });
    expect(diagnoseModel(setup()).target).toBeNull();
    expect(diagnoseModel(setup(), [null, undefined]).target).toBeNull();
  });

  test('validate 错误阻塞发布，每个列表最多返回 50 条但 total 准确', () => {
    const m = setup();
    for (let i = 0; i < DIAGNOSTICS_ITEMS_LIMIT + 5; i++) {
      m.objects[`bad${i}`] = {
        ...structuredClone(get(m, 'c1', 'column')),
        id: `bad${i}`,
        name: `bad${i}`,
        parent: 'gone',
      };
    }
    const d = diagnoseModel(m, [150000]);
    expect(d.blocksPublish).toBe(true);
    expect(d.validation.total).toBeGreaterThan(DIAGNOSTICS_ITEMS_LIMIT);
    expect(d.validation.items).toHaveLength(DIAGNOSTICS_ITEMS_LIMIT);
    expect(d.target).toBe('PG 15');
  });
});
