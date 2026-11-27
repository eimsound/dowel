// 普通列类型与 SQLite 内置排序规则的静态规范化（Issue #132 路径 C）：
// - addColumn / setColumnType 按方言 normalizeType 写入（枚举列、空类型原样保留），MCP 宏与粘贴都经过它们；
// - SQLite 内置排序规则（BINARY / NOCASE / RTRIM）写入时大写；
// - SQLite 规划器比较列类型与内置排序规则时不区分大小写（已存的小写模型与引擎读回的大写写法不再算改动）；
// - PG normalizeType 补齐 bit / varbit / float(p)，双引号里的标识符不转小写。
import { describe, expect, test } from 'vitest';

import {
  addColumn,
  addIndex,
  createSchema,
  createTable,
  emptyModel,
  type Model,
  normalizeType,
  plan,
  runMacro,
  setColumnType,
} from '../src/index.ts';

type Dialect = Model['dialect'];

const withTable = (dialect: Dialect, strict = false) => {
  const m = emptyModel(dialect);
  const schemaName = { pg: 'public', sqlite: 'main', mysql: 'default', mssql: 'dbo' }[dialect];
  const s = createSchema(m, schemaName, 's');
  const t = createTable(m, s, 'items', 't', null, strict ? { sqlite: { strict: true } } : undefined);
  return { m, t };
};

const col = (m: Model, id: string) => m.objects[id] as Extract<Model['objects'][string], { kind: 'column' }>;

describe('PG normalizeType', () => {
  test.each([
    ['int', 'integer'],
    ['INT4', 'integer'],
    ['varchar(255)', 'character varying(255)'],
    ['timestamptz', 'timestamp with time zone'],
    ['bit', 'bit(1)'],
    ['bit(8)', 'bit(8)'],
    ['varbit', 'bit varying'],
    ['varbit(16)', 'bit varying(16)'],
    ['bit varying(16)', 'bit varying(16)'],
    ['float(10)', 'real'],
    ['float(24)', 'real'],
    ['float(25)', 'double precision'],
    ['float(53)', 'double precision'],
    ['float', 'double precision'],
    ['bit[]', 'bit(1)[]'],
    ['float(10)[]', 'real[]'],
    ['"MyDomain"', '"MyDomain"'],
    ['public."MyDomain"', 'public."MyDomain"'],
    ['PUBLIC."My  Domain"[]', 'public."My  Domain"[]'],
    ['  Text  ', 'text'],
  ])('%s → %s', (input, out) => {
    expect(normalizeType(input, 'pg')).toBe(out);
  });
});

describe('addColumn / setColumnType 写入规范类型', () => {
  test.each([
    ['sqlite', 'integer', 'INTEGER'],
    ['sqlite', 'text', 'TEXT'],
    ['sqlite', 'varchar(10)', 'VARCHAR(10)'],
    ['pg', 'int', 'integer'],
    ['pg', 'varchar(255)', 'character varying(255)'],
    ['mysql', 'INT', 'int'],
    ['mssql', 'INT', 'int'],
  ] as const)('%s：%s → %s', (dialect, input, out) => {
    const { m, t } = withTable(dialect);
    const c = addColumn(m, t, { name: 'x', type: input });
    expect(col(m, c).type).toBe(out);
    const c2 = addColumn(m, t, { name: 'y', type: 'text' });
    setColumnType(m, c2, input);
    expect(col(m, c2).type).toBe(out);
  });

  test('空类型、枚举列（typeRef，type 只是数组维度）原样保留', () => {
    const { m, t } = withTable('pg');
    expect(col(m, addColumn(m, t, { name: 'x', type: '' })).type).toBe('');
    const schema = Object.values(m.objects).find((o) => o.kind === 'schema')!.id;
    m.objects.e = { id: 'e', kind: 'enum', parent: schema, name: 'mood', values: ['a'], comment: null };
    const c = addColumn(m, t, { name: 'y', type: '[]', typeRef: 'e' });
    expect(col(m, c).type).toBe('[]');
    setColumnType(m, c, '[][]', 'e');
    expect(col(m, c).type).toBe('[][]');
  });

  test('PG identity 列的序列类型按规范类型推导（int → integer，不是 bigint）', () => {
    const { m, t } = withTable('pg');
    const c = addColumn(m, t, { name: 'id', type: 'int', identity: { always: false } });
    expect(col(m, c).identity?.options.type).toBe('integer');
    setColumnType(m, c, 'int2');
    expect(col(m, c).type).toBe('smallint');
    expect(col(m, c).identity?.options.type).toBe('smallint');
  });

  test('MCP alterColumn：只换写法的类型（int → integer）不产生操作；真正改类型写入规范写法', () => {
    const { m, t } = withTable('pg');
    const c = addColumn(m, t, { name: 'x', type: 'integer' });
    expect(runMacro(structuredClone(m), 'alterColumn', { id: c, type: 'int' }, new Map()).ops).toEqual([]);
    const r = runMacro(m, 'alterColumn', { id: c, type: 'int8' }, new Map());
    expect(r.ops).toHaveLength(1);
    expect(col(m, c).type).toBe('bigint');
  });

  test('SQLite STRICT 表按规范类型检查，报错里仍是用户写的类型', () => {
    const { m, t } = withTable('sqlite', true);
    expect(col(m, addColumn(m, t, { name: 'x', type: 'int' })).type).toBe('INTEGER');
    expect(() => addColumn(m, t, { name: 'y', type: 'varchar(10)' })).toThrow(/varchar\(10\)/);
  });
});

describe('SQLite 内置排序规则', () => {
  test('列与索引元素写入时内置排序规则大写，自定义排序规则原样保留；其他方言不动', () => {
    const { m, t } = withTable('sqlite');
    expect(col(m, addColumn(m, t, { name: 'a', type: 'TEXT', collation: 'nocase' })).collation).toBe(
      'NOCASE',
    );
    expect(col(m, addColumn(m, t, { name: 'b', type: 'TEXT', collation: 'Rtrim' })).collation).toBe('RTRIM');
    expect(col(m, addColumn(m, t, { name: 'c', type: 'TEXT', collation: 'my_coll' })).collation).toBe(
      'my_coll',
    );
    const a = Object.values(m.objects).find((o) => o.kind === 'column' && o.name === 'a')!.id;
    const ix = addIndex(m, t, [{ column: a, collation: 'binary' }]);
    expect((m.objects[ix] as { elements: { collation: string | null }[] }).elements[0]!.collation).toBe(
      'BINARY',
    );
    const pg = withTable('pg');
    expect(col(pg.m, addColumn(pg.m, pg.t, { name: 'a', type: 'text', collation: 'C' })).collation).toBe('C');
  });
});

describe('SQLite 规划器：类型与内置排序规则不区分大小写', () => {
  /** 绕过 mutator 直接写原文，模拟升级前已经存下的小写模型 */
  const stored = (type: string, collation: string | null) => {
    const { m, t } = withTable('sqlite');
    const c = addColumn(m, t, { id: 'c', name: 'x', type: 'TEXT' });
    col(m, c).type = type;
    col(m, c).collation = collation;
    const ix = addIndex(m, t, [{ column: c }], {}, 'ix');
    (m.objects[ix] as { elements: { collation: string | null }[] }).elements[0]!.collation = collation;
    return m;
  };

  test('小写 integer / nocase 与读回的大写写法之间没有迁移步骤', () => {
    expect(plan(stored('integer', 'nocase'), stored('INTEGER', 'NOCASE'))).toEqual([]);
    expect(plan(stored('INTEGER', 'NOCASE'), stored('integer', 'nocase'))).toEqual([]);
  });

  test('真正的类型或排序规则变化仍然重建表', () => {
    expect(plan(stored('integer', null), stored('TEXT', null)).map((s) => s.kind)).toContain('rebuildTable');
    expect(plan(stored('TEXT', 'nocase'), stored('TEXT', 'RTRIM')).map((s) => s.kind)).toContain(
      'rebuildTable',
    );
  });
});
