// ADR 0015 第 2 节：MCP 编译型复合宏 defineTable / alterColumn（零 DB 四方言矩阵）。
// 宏只存在于 MCP 输入编译层：展开结果必须与把同一串原语交给 batch mutator 执行完全等价。
import { describe, expect, test } from 'vitest';

import {
  addColumn,
  addPrimaryKey,
  childrenOf,
  columnsOf,
  createEnum,
  createSchema,
  createSequence,
  createTable,
  EditError,
  emptyModel,
  get,
  isMacro,
  MacroError,
  macros,
  type Dialect,
  type Model,
  runMacro,
  runMutator,
} from '../src/index.ts';

/** 在两份副本上分别执行宏与等价的 batch，断言结果完全一致，返回宏执行后的模型与展开的原语 */
const expand = (m: Model, name: string, args: unknown, refs = new Map<string, string>()) => {
  const a = structuredClone(m);
  const b = structuredClone(m);
  const r = runMacro(a, name, args, refs);
  if (r.ops.length) runMutator(b, 'batch', { ops: r.ops });
  expect(a).toEqual(b);
  return { m: a, ops: r.ops, names: r.ops.map((o) => o.name), refs: r.refs, extraReads: r.extraReads };
};

const macroErr = (m: Model, name: string, args: unknown, refs = new Map<string, string>()): MacroError => {
  try {
    runMacro(structuredClone(m), name, args, refs);
  } catch (e) {
    expect(e).toBeInstanceOf(MacroError);
    expect(e).toBeInstanceOf(EditError);
    return e as MacroError;
  }
  throw new Error('预期宏报错');
};

const base = (dialect: Dialect, schema: string) => {
  const m = emptyModel(dialect);
  const s = createSchema(m, schema, 's1');
  return { m, s };
};

const tableByName = (m: Model, name: string) =>
  Object.values(m.objects).find((o) => o.kind === 'table' && o.name === name)!;

describe('宏注册表边界', () => {
  test('宏不在同步层 mutator 注册表里，isMacro 用 hasOwn 防原型键', () => {
    const { m } = base('pg', 'public');
    expect(Object.keys(macros)).toEqual(['defineTable', 'alterColumn']);
    expect(isMacro('defineTable')).toBe(true);
    for (const n of ['constructor', 'toString', '__proto__', 'createTable', 'batch'])
      expect(isMacro(n)).toBe(false);
    expect(() => runMutator(m, 'defineTable', { name: 't', columns: [{ name: 'a', type: 'int' }] })).toThrow(
      '未知的操作：defineTable',
    );
    expect(() => runMutator(m, 'batch', { ops: [{ name: 'alterColumn', args: {} }] })).toThrow(
      '未知的操作：alterColumn',
    );
  });

  test('strict：未知字段（含嵌套 ext）一律拒绝并给出子路径', () => {
    const { m } = base('pg', 'public');
    expect(
      macroErr(m, 'defineTable', { name: 't', columns: [{ name: 'a', type: 'int', foo: 1 }] }).path,
    ).toBe('columns[0]');
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [{ name: 'a', type: 'int', ext: { sqlite: { autoinc: true } } }],
      }).path,
    ).toBe('columns[0].ext.sqlite');
    expect(macroErr(m, 'defineTable', { name: 't', columns: [] }).path).toBe('columns');
    expect(macroErr(m, 'alterColumn', { id: 'x' }).rawMessage).toContain('至少需要一个要修改的字段');
  });
});

describe('defineTable：PG 全特性', () => {
  const setup = () => {
    const { m, s } = base('pg', 'public');
    createEnum(m, s, 'status', ['new', 'done'], 'e1');
    createSequence(m, s, 'code_seq', {}, 'q1');
    return m;
  };

  test('枚举 / 序列 / 自引用外键 / 命名约束 / 注释，固定展开顺序且与 batch 等价', () => {
    const m = setup();
    const {
      m: out,
      names,
      ops,
    } = expand(m, 'defineTable', {
      id: '$ref:cust',
      name: 'customers',
      comment: '客户',
      columns: [
        { id: '$ref:cust.id', name: 'id', type: 'bigint', identity: { always: true }, comment: '主键' },
        { name: 'status', typeRef: 'public.status', type: 'status[]' },
        { name: 'code', type: 'integer', default: { nextval: 'code_seq' }, notNull: true },
        { name: 'referrer_id', type: 'bigint' },
        { name: 'note', type: 'text', comment: '$ref:literal 不展开' },
      ],
      primaryKey: { name: 'customers_pk', columns: ['id'] },
      uniques: [{ columns: ['code'], comment: '唯一编码' }],
      checks: [{ name: 'ck_code', expr: 'code > 0' }],
      indexes: [{ elements: [{ column: 'status' }, { expr: 'lower(note)' }], where: 'code > 0' }],
      foreignKeys: [
        { columns: ['referrer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'setNull' },
      ],
    });
    expect(names).toEqual([
      'createTable',
      'addColumn',
      'addColumn',
      'addColumn',
      'addColumn',
      'addColumn',
      'addPrimaryKey',
      'renameKey',
      'addUnique',
      'addCheck',
      'renameKey',
      'addIndex',
      'addForeignKey',
      'setComment',
      'setComment',
      'setComment',
      'setComment',
    ]);
    const t = tableByName(out, 'customers');
    expect(t.comment).toBe('客户');
    const cols = columnsOf(out, t.id);
    expect(cols.map((c) => c.name)).toEqual(['id', 'status', 'code', 'referrer_id', 'note']);
    expect(cols[1]).toMatchObject({ typeRef: 'e1', type: '[]' });
    expect(cols[2]!.default).toEqual({ nextval: 'q1' });
    expect(cols[0]!.identity?.always).toBe(true);
    // 自由文本里的 `$ref:` 原样保留
    expect(cols[4]!.comment).toBe('$ref:literal 不展开');
    expect(childrenOf(out, t.id, 'primaryKey')[0]).toMatchObject({
      name: 'customers_pk',
      nameMode: 'explicit',
    });
    const fk = childrenOf(out, t.id, 'foreignKey')[0]!;
    expect(fk).toMatchObject({ refTable: t.id, refColumns: [cols[0]!.id], onDelete: 'setNull' });
    // createTable 不内联 partitionBy / ext
    expect(ops[0]!.args).toEqual({ id: t.id, schema: 's1', name: 'customers' });
  });

  test('分区表：setPartitionBy 在列之后约束之前，子分区与注释最后', () => {
    const m = setup();
    const { m: out, names } = expand(m, 'defineTable', {
      name: 'events',
      columns: [
        { name: 'id', type: 'bigint' },
        { name: 'at', type: 'date', notNull: true },
      ],
      partitionBy: { strategy: 'range', keys: [{ column: 'at' }] },
      primaryKey: { columns: ['id', 'at'] },
      partitions: [
        { name: 'events_2026', bound: "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')", comment: 'p' },
      ],
    });
    expect(names).toEqual([
      'createTable',
      'addColumn',
      'addColumn',
      'setPartitionBy',
      'addPrimaryKey',
      'createPartition',
      'setComment',
    ]);
    const p = tableByName(out, 'events_2026');
    expect(p.kind === 'table' && p.partitionOf?.parent).toBe(tableByName(out, 'events').id);

    // 违反分区键要求的主键准确报错到 primaryKey
    const e = macroErr(m, 'defineTable', {
      name: 'events',
      columns: [
        { name: 'id', type: 'bigint' },
        { name: 'at', type: 'date' },
      ],
      partitionBy: { strategy: 'range', keys: [{ column: 'at' }] },
      primaryKey: { columns: ['id'] },
    });
    expect(e.path).toBe('primaryKey');
    expect(e.mutator).toBe('addPrimaryKey');
    // 有 partitions 缺 partitionBy
    expect(
      macroErr(m, 'defineTable', {
        name: 'x',
        columns: [{ name: 'a', type: 'int' }],
        partitions: [{ name: 'x1', bound: 'DEFAULT' }],
      }).path,
    ).toBe('partitions');
  });

  test('列编译期互斥与类型校验', () => {
    const m = setup();
    const col = (c: Record<string, unknown>) => ({ name: 't', columns: [{ name: 'a', ...c }] });
    expect(
      macroErr(
        m,
        'defineTable',
        col({ type: 'int', identity: { always: true }, generated: { expr: '1', stored: true } }),
      ).rawMessage,
    ).toContain('生成列');
    expect(
      macroErr(m, 'defineTable', col({ type: 'int', identity: { always: true }, default: { expr: '1' } }))
        .rawMessage,
    ).toContain('默认值');
    expect(
      macroErr(
        m,
        'defineTable',
        col({ type: 'int', generated: { expr: '1', stored: true }, default: { expr: '1' } }),
      ).rawMessage,
    ).toContain('生成列不能有默认值');
    expect(
      macroErr(m, 'defineTable', col({ type: 'int', identity: { always: false }, notNull: false }))
        .rawMessage,
    ).toContain('NOT NULL');
    expect(macroErr(m, 'defineTable', col({ type: '  ' })).path).toBe('columns[0].type');
    expect(macroErr(m, 'defineTable', col({ typeRef: 'status', type: 'integer' })).path).toBe(
      'columns[0].type',
    );
    // typeRef 存在时 type 可省略，或写成 `[schema.]枚举名` 加维度
    const ok = expand(m, 'defineTable', col({ typeRef: 'e1', type: 'public.status[][]' }));
    expect(columnsOf(ok.m, tableByName(ok.m, 't').id)[0]).toMatchObject({ type: '[][]', typeRef: 'e1' });
    expect(expand(m, 'defineTable', col({ typeRef: 'status' })).ops[1]!.args).toMatchObject({
      column: { type: '', typeRef: 'e1' },
    });
  });

  test('引用解析：同批前序表 $ref、未定义 $ref 给出循环外键提示，按名解析的 schema 记入 extraReads', () => {
    const m = setup();
    const refs = new Map<string, string>();
    const after = expand(
      m,
      'defineTable',
      {
        id: '$ref:users',
        name: 'users',
        columns: [{ id: '$ref:users.id', name: 'id', type: 'bigint' }],
        primaryKey: { columns: ['id'] },
      },
      refs,
    ).m;
    const r = expand(
      after,
      'defineTable',
      {
        name: 'orders',
        columns: [{ name: 'user_id', type: 'bigint' }],
        foreignKeys: [
          { columns: ['user_id'], refTable: '$ref:users', refColumns: ['$ref:users.id'] },
          { columns: ['user_id'], refTable: 'public.users', refColumns: ['id'] },
        ],
      },
      refs,
    );
    expect(r.names.filter((n) => n === 'addForeignKey')).toHaveLength(2);

    const e = macroErr(after, 'defineTable', {
      name: 'orders',
      columns: [{ name: 'user_id', type: 'bigint' }],
      foreignKeys: [{ columns: ['user_id'], refTable: '$ref:later', refColumns: ['id'] }],
    });
    expect(e.path).toBe('foreignKeys[0].refTable');
    expect(e.rawMessage).toContain('$ref:later');
    expect(e.rawMessage).toContain('addForeignKey');
  });

  test('步骤 extraReads：按 schema.name 解析的外部 schema ID', () => {
    const m = setup();
    createTable(m, 's1', 'users', 'tu');
    addColumn(m, 'tu', { id: 'cu', name: 'id', type: 'bigint' });
    addPrimaryKey(m, 'tu', ['cu'], 'pku');
    const plan = runMacro(structuredClone(m), 'defineTable', {
      schema: 'public',
      name: 'orders',
      columns: [{ name: 'user_id', type: 'bigint' }],
      foreignKeys: [{ columns: ['user_id'], refTable: 'public.users', refColumns: ['id'] }],
    });
    expect(plan.ops.at(-1)!.args).toMatchObject({ refTable: 'tu', refColumns: ['cu'] });
    expect(plan.steps[0]).toMatchObject({ name: 'createTable', extraReads: ['s1'] });
    expect(plan.steps.at(-1)).toMatchObject({
      name: 'addForeignKey',
      path: 'foreignKeys[0]',
      extraReads: ['s1'],
    });
  });
});

describe('defineTable：歧义、原型键与新建 ID 查重', () => {
  test('多 schema 同名表报歧义并列候选；限定名可消歧', () => {
    const { m } = base('pg', 'public');
    createSchema(m, 'audit', 's2');
    for (const [s, t, c] of [
      ['s1', 't1', 'c1'],
      ['s2', 't2', 'c2'],
    ] as const) {
      createTable(m, s, 'users', t);
      addColumn(m, t, { id: c, name: 'id', type: 'bigint' });
      addPrimaryKey(m, t, [c], `pk_${t}`);
    }
    const args = (refTable: string) => ({
      name: 'orders',
      columns: [{ name: 'uid', type: 'bigint' }],
      foreignKeys: [{ columns: ['uid'], refTable, refColumns: ['id'] }],
    });
    const e = macroErr(m, 'defineTable', args('users'));
    expect(e.path).toBe('foreignKeys[0].refTable');
    expect(e.rawMessage).toContain('public.users');
    expect(e.rawMessage).toContain('audit.users');
    expect(expand(m, 'defineTable', args('audit.users')).ops.at(-1)!.args).toMatchObject({ refTable: 't2' });
    // 未指定 schema 时使用方言默认 schema（public）
    expect(expand(m, 'defineTable', args('t1')).ops[0]!.args).toMatchObject({ schema: 's1' });
  });

  test('列 ID 与另一列名同时命中报歧义', () => {
    const { m } = base('pg', 'public');
    const e = macroErr(m, 'defineTable', {
      name: 't',
      columns: [
        { id: 'c_a', name: 'title', type: 'text' },
        { id: 'title', name: 'other', type: 'text' },
      ],
      primaryKey: { columns: ['title'] },
    });
    expect(e.path).toBe('primaryKey.columns[0]');
    expect(e.rawMessage).toContain('歧义');
  });

  test('原型键既不当作对象 ID 也不当作名字', () => {
    const { m } = base('pg', 'public');
    for (const k of ['constructor', 'toString', '__proto__']) {
      expect(
        macroErr(m, 'defineTable', { schema: k, name: 't', columns: [{ name: 'a', type: 'int' }] }).path,
      ).toBe('schema');
      expect(
        macroErr(m, 'defineTable', { id: k, name: 't', columns: [{ name: 'a', type: 'int' }] }).path,
      ).toBe('id');
      expect(
        macroErr(m, 'defineTable', {
          name: 't',
          columns: [{ name: 'a', type: 'int' }],
          foreignKeys: [{ columns: ['a'], refTable: k, refColumns: ['a'] }],
        }).path,
      ).toBe('foreignKeys[0].refTable');
      expect(macroErr(m, 'alterColumn', { id: k, comment: 'x' }).path).toBe('id');
    }
  });

  test('新建 ID 不能已存在于模型或本宏已建集合', () => {
    const { m } = base('pg', 'public');
    createTable(m, 's1', 'old', 't_old');
    expect(
      macroErr(m, 'defineTable', { id: 't_old', name: 't', columns: [{ name: 'a', type: 'int' }] }).path,
    ).toBe('id');
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [
          { id: '$ref:a', name: 'a', type: 'int' },
          { id: '$ref:a', name: 'b', type: 'int' },
        ],
      }).path,
    ).toBe('columns[1].id');
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [{ name: 'a', type: 'int' }],
        checks: [{ id: 's1', expr: 'a > 0' }],
      }).path,
    ).toBe('checks[0].id');
    expect(
      macroErr(m, 'defineTable', { id: '$ref:bad alias', name: 't', columns: [{ name: 'a', type: 'int' }] })
        .path,
    ).toBe('id');
  });
});

describe('alterColumn：PG', () => {
  const setup = () => {
    const { m, s } = base('pg', 'public');
    createEnum(m, s, 'status', ['new', 'done'], 'e1');
    createSequence(m, s, 'seq', {}, 'q1');
    createTable(m, 's1', 'users', 't1');
    addColumn(m, 't1', { id: 'c1', name: 'email', type: 'text', default: { expr: "''" } });
    addColumn(m, 't1', { id: 'c2', name: 'n', type: 'bigint', identity: { always: true } });
    addColumn(m, 't1', { id: 'c3', name: 'st', type: '', typeRef: 'e1' });
    return m;
  };

  test('默认值 → identity：先清默认值再设 identity', () => {
    const r = expand(setup(), 'alterColumn', { id: 'c1', type: 'bigint', identity: { always: false } });
    expect(r.names).toEqual(['setDefault', 'setColumnType', 'setIdentity']);
    expect(get(r.m, 'c1', 'column')).toMatchObject({ default: null, notNull: true, type: 'bigint' });
    expect(r.extraReads).toEqual(['c1']);
  });

  test('identity → 默认值：先取消 identity 再设默认值', () => {
    const r = expand(setup(), 'alterColumn', {
      id: 'c2',
      identity: null,
      default: { nextval: 'public.seq' },
      notNull: false,
      name: 'num',
      comment: '编号',
    });
    expect(r.names).toEqual(['setIdentity', 'renameColumn', 'setNotNull', 'setDefault', 'setComment']);
    expect(get(r.m, 'c2', 'column')).toMatchObject({
      identity: null,
      default: { nextval: 'q1' },
      notNull: false,
      name: 'num',
      comment: '编号',
    });
  });

  test('编译期拒绝互斥组合', () => {
    const m = setup();
    expect(
      macroErr(m, 'alterColumn', { id: 'c1', identity: { always: true }, default: { expr: '1' } }).rawMessage,
    ).toContain('默认值');
    expect(
      macroErr(m, 'alterColumn', { id: 'c1', identity: { always: true }, notNull: false }).rawMessage,
    ).toContain('NOT NULL');
    expect(macroErr(m, 'alterColumn', { id: 'c3', typeRef: null }).path).toBe('type');
    expect(macroErr(m, 'alterColumn', { id: 'c3', typeRef: null, type: '[]' }).path).toBe('type');
  });

  test('typeRef / type 联合语义：只切数组维度保留枚举；切普通类型清除枚举', () => {
    const m = setup();
    expect(expand(m, 'alterColumn', { id: 'c3', type: '[]' }).ops).toEqual([
      { name: 'setColumnType', args: { id: 'c3', type: '[]', typeRef: 'e1' } },
    ]);
    expect(expand(m, 'alterColumn', { id: 'c3', type: 'status[]' }).ops[0]!.args).toEqual({
      id: 'c3',
      type: '[]',
      typeRef: 'e1',
    });
    expect(expand(m, 'alterColumn', { id: 'c3', type: 'text' }).ops[0]!.args).toEqual({
      id: 'c3',
      type: 'text',
      typeRef: null,
    });
    expect(expand(m, 'alterColumn', { id: 'c3', typeRef: null, type: 'text' }).ops[0]!.args).toEqual({
      id: 'c3',
      type: 'text',
      typeRef: null,
    });
    expect(expand(m, 'alterColumn', { id: 'c1', typeRef: 'status' }).ops[0]!.args).toEqual({
      id: 'c1',
      type: '',
      typeRef: 'e1',
    });
  });

  test('值已一致的字段全部跳过（0 展开，extraReads 仍含列 ID）', () => {
    const r = expand(setup(), 'alterColumn', {
      id: 'c1',
      name: 'email',
      type: 'text',
      default: { expr: "''" },
      notNull: false,
      comment: null,
      ext: null,
    });
    expect(r.ops).toEqual([]);
    expect(r.extraReads).toEqual(['c1']);
  });

  test('只认列 ID 或同批前序 $ref，绝不按列名解析', () => {
    const m = setup();
    const e = macroErr(m, 'alterColumn', { id: 'email', comment: 'x' });
    expect(e.path).toBe('id');
    expect(e.rawMessage).toContain('不按列名解析');
    expect(macroErr(m, 'alterColumn', { id: '$ref:nope', comment: 'x' }).rawMessage).toContain(
      '未定义的占位符',
    );
    expect(macroErr(m, 'alterColumn', { id: 't1', comment: 'x' }).path).toBe('id');

    const refs = new Map<string, string>();
    const a = expand(
      m,
      'defineTable',
      { name: 'n', columns: [{ id: '$ref:nc', name: 'x', type: 'int' }] },
      refs,
    ).m;
    const r = expand(a, 'alterColumn', { id: '$ref:nc', notNull: true }, refs);
    expect(r.ops).toEqual([{ name: 'setNotNull', args: { id: refs.get('nc'), notNull: true } }]);
  });

  test('步骤失败带子路径与 mutator', () => {
    const e = macroErr(setup(), 'alterColumn', { id: 'c2', default: { expr: '1' } });
    expect(e.path).toBe('default');
    expect(e.mutator).toBe('setDefault');
  });
});

describe('defineTable / alterColumn：SQLite', () => {
  test('STRICT + autoincrement 延后到主键与表扩展之后，名称大小写不敏感', () => {
    const { m } = base('sqlite', 'main');
    const r = expand(m, 'defineTable', {
      schema: 'MAIN',
      name: 'items',
      ext: { sqlite: { strict: true } },
      columns: [
        { name: 'ID', type: 'INTEGER', ext: { sqlite: { autoincrement: true } } },
        { name: 'title', type: 'TEXT', notNull: true },
      ],
      primaryKey: { columns: ['id'] },
      uniques: [{ columns: ['TITLE'] }],
    });
    expect(r.names).toEqual([
      'createTable',
      'addColumn',
      'addColumn',
      'addPrimaryKey',
      'setTableExt',
      'setColumnExt',
      'addUnique',
    ]);
    expect(r.ops[1]!.args).not.toHaveProperty('column.ext');
    const t = tableByName(r.m, 'items');
    expect(t.kind === 'table' && t.ext).toEqual({ sqlite: { strict: true } });
    expect(columnsOf(r.m, t.id)[0]!.ext).toEqual({ sqlite: { autoincrement: true } });
  });

  test('WITHOUT ROWID 与 autoincrement 冲突精确报错到列 ext；STRICT 类型违规报错到表 ext', () => {
    const { m } = base('sqlite', 'main');
    const e1 = macroErr(m, 'defineTable', {
      name: 'items',
      ext: { sqlite: { withoutRowid: true } },
      columns: [{ name: 'id', type: 'INTEGER', ext: { sqlite: { autoincrement: true } } }],
      primaryKey: { columns: ['id'] },
    });
    expect([e1.path, e1.mutator]).toEqual(['columns[0].ext', 'setColumnExt']);
    const e2 = macroErr(m, 'defineTable', {
      name: 'items',
      ext: { sqlite: { strict: true } },
      columns: [{ name: 'id', type: 'varchar(10)' }],
    });
    expect([e2.path, e2.mutator]).toEqual(['ext', 'setTableExt']);
    const e3 = macroErr(m, 'defineTable', {
      name: 'items',
      ext: { sqlite: { withoutRowid: true } },
      columns: [{ name: 'id', type: 'INTEGER' }],
    });
    expect([e3.path, e3.mutator]).toEqual(['ext', 'setTableExt']);
  });

  test('拒绝 PG 特性（identity / 枚举 / 分区）', () => {
    const { m } = base('sqlite', 'main');
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [{ name: 'a', type: 'INTEGER', identity: { always: true } }],
      }).path,
    ).toBe('columns[0].identity');
    expect(macroErr(m, 'defineTable', { name: 't', columns: [{ name: 'a', typeRef: 'x' }] }).path).toBe(
      'columns[0].typeRef',
    );
    createTable(m, 's1', 'u', 'tu');
    addColumn(m, 'tu', { id: 'cu', name: 'a', type: 'TEXT' });
    expect(macroErr(m, 'alterColumn', { id: 'cu', identity: { always: true } }).path).toBe('identity');
    expect(expand(m, 'alterColumn', { id: 'cu', name: 'A' }).names).toEqual(['renameColumn']);
  });
});

describe('defineTable：MySQL', () => {
  test('engine / charset / unsigned / autoIncrement', () => {
    const { m } = base('mysql', 'default');
    const r = expand(m, 'defineTable', {
      name: 'orders',
      ext: { mysql: { engine: 'InnoDB', charset: 'utf8mb4' } },
      columns: [
        { name: 'id', type: 'bigint', ext: { mysql: { unsigned: true, autoIncrement: true } } },
        { name: 'Code', type: 'varchar(32)' },
      ],
      primaryKey: { columns: ['ID'] },
      indexes: [{ name: 'ix_code', elements: [{ column: 'code' }], ext: { mysql: { indexType: 'BTREE' } } }],
    });
    expect(r.names).toEqual([
      'createTable',
      'addColumn',
      'addColumn',
      'addPrimaryKey',
      'setTableExt',
      'addIndex',
      'renameKey',
    ]);
    const t = tableByName(r.m, 'orders');
    expect(t.kind === 'table' && t.ext).toEqual({ mysql: { engine: 'InnoDB', charset: 'utf8mb4' } });
    expect(columnsOf(r.m, t.id)[0]!.ext).toEqual({ mysql: { unsigned: true, autoIncrement: true } });
  });

  test('拒绝 PG 特性', () => {
    const { m } = base('mysql', 'default');
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [{ name: 'a', type: 'int', identity: { always: true } }],
      }).rawMessage,
    ).toContain('autoIncrement');
    expect(macroErr(m, 'defineTable', { name: 't', columns: [{ name: 'a', typeRef: 'x' }] }).path).toBe(
      'columns[0].typeRef',
    );
    const e = macroErr(m, 'defineTable', {
      name: 't',
      columns: [{ name: 'a', type: 'int' }],
      partitionBy: { strategy: 'hash', keys: [{ column: 'a' }] },
    });
    expect([e.path, e.mutator]).toEqual(['partitionBy', 'setPartitionBy']);
  });
});

describe('defineTable / alterColumn：MSSQL', () => {
  const setup = () => {
    const m = emptyModel('mssql');
    createSchema(m, 'dbo', 'dbo');
    createSchema(m, 'sales', 'sales');
    return m;
  };

  test('多 schema、ext.mssql.identity、clustered、跨 schema 外键（大小写不敏感）', () => {
    const m = setup();
    const refs = new Map<string, string>();
    const a = expand(
      m,
      'defineTable',
      {
        schema: 'SALES',
        name: 'Customers',
        columns: [
          {
            name: 'Id',
            type: 'int',
            notNull: true,
            ext: { mssql: { identity: { seed: '1', increment: '1' } } },
          },
        ],
        primaryKey: { columns: ['id'], ext: { mssql: { clustered: true } } },
      },
      refs,
    );
    expect(a.ops[0]!.args).toMatchObject({ schema: 'sales' });
    const b = expand(a.m, 'defineTable', {
      name: 'Orders',
      columns: [
        { name: 'Id', type: 'int', notNull: true },
        { name: 'CustomerId', type: 'int', default: { expr: '0' } },
      ],
      primaryKey: { columns: ['Id'], ext: { mssql: { clustered: false } } },
      foreignKeys: [{ columns: ['customerid'], refTable: 'sales.customers', refColumns: ['ID'] }],
    });
    expect(b.ops[0]!.args).toMatchObject({ schema: 'dbo' });
    const orders = tableByName(b.m, 'Orders');
    const cust = columnsOf(b.m, orders.id)[1]!;
    expect(cust.ext?.mssql?.defaultName).toBe('DF_Orders_CustomerId');
    const custTable = tableByName(b.m, 'Customers');
    expect(columnsOf(b.m, custTable.id)[0]!.ext?.mssql?.identity).toEqual({ seed: '1', increment: '1' });
    expect(childrenOf(b.m, custTable.id, 'primaryKey')[0]!.ext).toEqual({ mssql: { clustered: true } });
  });

  test('拒绝 PG identity；alterColumn 改 default + ext 保留 DF_ 推导名', () => {
    const m = setup();
    expect(
      macroErr(m, 'defineTable', {
        name: 't',
        columns: [{ name: 'a', type: 'int', identity: { always: true } }],
      }).rawMessage,
    ).toContain('ext.mssql.identity');
    const r = expand(m, 'defineTable', {
      name: 'T',
      columns: [{ id: 'cx', name: 'Flag', type: 'int', default: { expr: '0' } }],
    });
    expect(get(r.m, 'cx', 'column').ext?.mssql?.defaultName).toBe('DF_T_Flag');
    const alt = expand(r.m, 'alterColumn', {
      id: 'cx',
      default: { expr: '1' },
      ext: { mssql: { sparse: true } },
    });
    expect(alt.names).toEqual(['setDefault', 'setColumnExt']);
    expect(get(alt.m, 'cx', 'column').ext?.mssql).toEqual({
      sparse: true,
      defaultName: 'DF_T_Flag',
      defaultNameMode: 'derived',
    });
    // 只差自动推导的 defaultName：视为一致，0 展开
    expect(expand(alt.m, 'alterColumn', { id: 'cx', ext: { mssql: { sparse: true } } }).ops).toEqual([]);
    expect(macroErr(r.m, 'alterColumn', { id: 'cx', identity: { always: true } }).rawMessage).toContain(
      'ext.mssql.identity',
    );
  });
  test('alterColumn.ext 整体替换时自动保留 MSSQL 显式默认约束名；ext: null 仍可清除', () => {
    const m = setup();
    const r = expand(m, 'defineTable', {
      name: 't',
      columns: [
        {
          id: 'ca',
          name: 'a',
          type: 'int',
          default: { expr: '0' },
          ext: { mssql: { defaultName: 'DF_custom', defaultNameMode: 'explicit' } },
        },
      ],
    });
    expect(get(r.m, 'ca', 'column').ext?.mssql).toEqual({
      defaultName: 'DF_custom',
      defaultNameMode: 'explicit',
    });

    const kept = expand(r.m, 'alterColumn', { id: 'ca', ext: { mssql: { sparse: true } } });
    expect(kept.ops).toEqual([
      {
        name: 'setColumnExt',
        args: {
          id: 'ca',
          ext: { mssql: { sparse: true, defaultName: 'DF_custom', defaultNameMode: 'explicit' } },
        },
      },
    ]);
    expect(get(kept.m, 'ca', 'column').ext?.mssql).toEqual({
      sparse: true,
      defaultName: 'DF_custom',
      defaultNameMode: 'explicit',
    });
    // 再次传同样的 ext：已一致，0 展开
    expect(expand(kept.m, 'alterColumn', { id: 'ca', ext: { mssql: { sparse: true } } }).ops).toEqual([]);

    // 显式指定 defaultNameMode：按调用方请求改回推导名
    const derived = expand(kept.m, 'alterColumn', {
      id: 'ca',
      ext: { mssql: { defaultNameMode: 'derived' } },
    });
    expect(get(derived.m, 'ca', 'column').ext?.mssql).toEqual({
      defaultName: 'DF_t_a',
      defaultNameMode: 'derived',
    });

    // ext: null 清除整个 ext（默认值仍在，推导名随即重新生成）
    const cleared = expand(kept.m, 'alterColumn', { id: 'ca', ext: null });
    expect(cleared.ops).toEqual([{ name: 'setColumnExt', args: { id: 'ca', ext: null } }]);
    expect(get(cleared.m, 'ca', 'column').ext?.mssql).toEqual({
      defaultName: 'DF_t_a',
      defaultNameMode: 'derived',
    });

    // 同时改 default 与 ext：按本次修改后的默认值判断，仍有默认值 → 保留显式名
    const both = expand(kept.m, 'alterColumn', {
      id: 'ca',
      default: { expr: '1' },
      ext: { mssql: { rowguidcol: false } },
    });
    expect(both.names).toEqual(['setDefault', 'setColumnExt']);
    expect(get(both.m, 'ca', 'column')).toMatchObject({
      default: { expr: '1' },
      ext: { mssql: { rowguidcol: false, defaultName: 'DF_custom', defaultNameMode: 'explicit' } },
    });

    // default: null + ext：默认值已被清除，没有默认约束可命名 → 不再保留显式名
    const dropped = expand(kept.m, 'alterColumn', {
      id: 'ca',
      default: null,
      ext: { mssql: { sparse: true } },
    });
    expect(dropped.names).toEqual(['setDefault', 'setColumnExt']);
    expect(get(dropped.m, 'ca', 'column')).toMatchObject({ default: null, ext: { mssql: { sparse: true } } });
  });
});
