// 普通列类型与 SQLite 内置排序规则的静态规范化（Issue #132 路径 C）：
// - addColumn / setColumnType 按方言 normalizeType 写入（枚举列、空类型原样保留），MCP 宏与粘贴都经过它们；
// - SQLite 内置排序规则（BINARY / NOCASE / RTRIM）写入时大写；
// - SQLite 规划器比较列类型与内置排序规则时不区分大小写（已存的小写模型与引擎读回的大写写法不再算改动）；
// - PG normalizeType 补齐 bit / varbit / float(p)，双引号里的标识符与非纯数字类型修饰符不转小写。
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

const PG_CASES: readonly [string, string][] = [
  ['int', 'integer'],
  ['INT4', 'integer'],
  ['varchar(255)', 'character varying(255)'],
  ['timestamptz', 'timestamp with time zone'],
  ['bit', 'bit(1)'],
  ['bit(8)', 'bit(8)'],
  ['varbit', 'bit varying'],
  ['varbit(16)', 'bit varying(16)'],
  ['bit varying(16)', 'bit varying(16)'],
  ['BIT VARYING(8)', 'bit varying(8)'],
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
  ['"My(Type)"', '"My(Type)"'],
  ['  Text  ', 'text'],
  ['geometry(Point,4326)', 'geometry(Point,4326)'],
  ['GEOMETRY(Point,4326)', 'geometry(Point,4326)'],
  ['geometry(Point,4326)[]', 'geometry(Point,4326)[]'],
  ['GEOMETRY (PointZ, 4326) [ ]', 'geometry(PointZ, 4326)[]'],
  ['public.GEOMETRY(Point,4326)', 'public.geometry(Point,4326)'],
  ['PUBLIC."GeoType"(Point,4326)[]', 'public."GeoType"(Point,4326)[]'],
  ['NUMERIC(10, 2)', 'numeric(10,2)'],
  ['TIMESTAMP(3) WITH TIME ZONE', 'timestamp(3) with time zone'],
  ['timestamp(3)', 'timestamp(3) without time zone'],
  ['TIMESTAMPTZ(3)[]', 'timestamp(3) with time zone[]'],
  ['TIME(3) WITH TIME ZONE', 'time(3) with time zone'],
  ['TIMETZ(2)', 'time(2) with time zone'],
  ['INTERVAL YEAR TO MONTH', 'interval year to month'],
  ['INTERVAL DAY TO SECOND(3)', 'interval day to second(3)'],
  ['"char"', '"char"'],
  ['interval', 'interval'],
  ['interval(3)', 'interval(3)'],
  ["custom(Nested(Arg), 'A')", "custom(Nested(Arg), 'A')"],
  ['foo(Bar) BAZ(Qux)', 'foo(Bar) baz(Qux)'],
];

describe('PG normalizeType', () => {
  test.each(PG_CASES)('%s → %s', (input, out) => {
    expect(normalizeType(input, 'pg')).toBe(out);
  });
});

describe('normalizeType 幂等性（四方言）', () => {
  const samples: Record<Dialect, readonly string[]> = {
    pg: [
      ...new Set([...PG_CASES.flat(), 'char', 'character', 'double   precision', 'varchar', 'text[]', '']),
    ],
    sqlite: [
      'int',
      'integer',
      'BIGINT',
      'boolean',
      'text',
      'varchar(255)',
      'decimal(10, 2)',
      'real',
      'double precision',
      'blob',
      'numeric',
      'any',
      '  int  ',
      '',
    ],
    mysql: [
      'INT',
      'INT(11)',
      'INTEGER',
      'BIGINT(20) UNSIGNED',
      'TINYINT(1)',
      'TINYINT(4)',
      'BOOLEAN',
      'DECIMAL',
      'NUMERIC(12, 4)',
      'DOUBLE PRECISION',
      'REAL',
      'CHAR',
      'VARCHAR(255)',
      'BIT',
      'BINARY',
      'DATETIME(0)',
      'DATETIME(6)',
      'TIMESTAMP(3)',
      "ENUM('Open', 'Closed')",
      "SET('A', 'B')",
      'VECTOR(1536)',
      'JSON',
      'INT ZEROFILL',
      '',
    ],
    mssql: [
      'INT',
      'INTEGER',
      'INT8',
      'BIT',
      'BOOL',
      'DECIMAL',
      'DECIMAL(10)',
      'DECIMAL(10, 2)',
      'NUMERIC(18, 0)',
      'FLOAT(10)',
      'FLOAT(24)',
      'FLOAT(25)',
      'FLOAT(53)',
      'NVARCHAR',
      'NVARCHAR( 255 )',
      'NVARCHAR(MAX)',
      'CHARACTER VARYING(50)',
      'DATETIME2',
      'DATETIME2(3)',
      'DATETIMEOFFSET',
      'TIME',
      'UUID',
      'TIMESTAMP',
      'JSON',
      'VECTOR( 1536 )',
      '',
    ],
  };

  test.each(['pg', 'sqlite', 'mysql', 'mssql'] as const)(
    '%s：normalizeType(normalizeType(x)) === normalizeType(x)',
    (dialect) => {
      for (const raw of samples[dialect]) {
        const once = normalizeType(raw, dialect);
        expect(normalizeType(once, dialect), `${dialect}: ${raw}`).toBe(once);
      }
    },
  );
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

  test('PG 非纯数字类型修饰符（geometry(Point,4326)）在写入与 alterColumn 中保留原文', () => {
    const { m, t } = withTable('pg');
    const g = addColumn(m, t, { name: 'geom', type: 'geometry(Point,4326)' });
    expect(col(m, g).type).toBe('geometry(Point,4326)');
    expect(
      runMacro(structuredClone(m), 'alterColumn', { id: g, type: 'GEOMETRY(Point,4326)' }, new Map()).ops,
    ).toEqual([]);
    const changed = runMacro(
      structuredClone(m),
      'alterColumn',
      { id: g, type: 'geometry(Polygon,4326)' },
      new Map(),
    );
    expect(changed.ops).toHaveLength(1);
    setColumnType(m, g, 'geometry(Polygon,4326)');
    expect(col(m, g).type).toBe('geometry(Polygon,4326)');
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

describe('normalizeType 线性时间守卫', () => {
  // 线性实现在 20 万字符级别仅耗时几到几十毫秒，二次方实现（如未锚定回溯或反复尾部正则替换）需要数秒至数十秒。
  // 不做“4 倍输入耗时比”墙钟断言，避免并行负载下分子分母抖动导致误报；直接要求 20 万字符级输入远低于 1 秒上限。
  const N = 200_000;
  const LIMIT_MS = 1_000;

  const measureMs = (fn: () => void): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      fn();
      const dt = performance.now() - t0;
      best = Math.min(best, dt);
      if (best < LIMIT_MS || dt >= LIMIT_MS * 3) break;
    }
    return best;
  };

  const cases: readonly [Dialect, string, string, string][] = [
    ['pg', '长连续空格', `int${' '.repeat(N)}x`, 'int x'],
    ['pg', '长连续制表符', `int${'\t'.repeat(N)}x`, 'int x'],
    ['pg', '大量 [] 后接非括号', `${'[]'.repeat(N / 2)}x`, `${'[]'.repeat(N / 2)}x`],
    ['pg', '合法大量带空格数组后缀', `int${' [ ]'.repeat(N / 4)}`, `integer${'[]'.repeat(N / 4)}`],
    ['pg', '双引号标识符内长空白', `"a${' '.repeat(N)}b"`, `"a${' '.repeat(N)}b"`],
    ['pg', '大量未闭合左括号', '('.repeat(N), '('.repeat(N)],
    ['pg', '长未闭合双引号', `"${'a'.repeat(N)}`, `"${'a'.repeat(N)}`],
    [
      'pg',
      '括号内长数字与空白',
      `numeric(${'1'.repeat(N / 2)}${' '.repeat(N / 2)}x)`,
      `numeric(${'1'.repeat(N / 2)}${' '.repeat(N / 2)}x)`,
    ],
    ['mysql', '大量重复 unsigned 后缀', `int${' unsigned'.repeat(22_000)}`, 'int unsigned'],
    ['mysql', '大量重复 zerofill 后缀', `int${' zerofill'.repeat(22_000)}`, 'int unsigned zerofill'],
    ['mysql', '长连续空格', `int${' '.repeat(N)}x`, 'int x'],
    ['sqlite', '长连续空格', `int${' '.repeat(N)}x`, 'INT X'],
    ['sqlite', '大量 [] 后接非括号', `${'[]'.repeat(N / 2)}x`, `${'[]'.repeat(N / 2)}X`],
    ['mssql', '长连续空格', `int${' '.repeat(N)}x`, 'int x'],
    ['mssql', '大量 [] 后接非括号', `${'[]'.repeat(N / 2)}x`, `${'[]'.repeat(N / 2)}x`],
  ];

  test.each(cases)('%s：%s（20 万字符 < 1000ms）', (dialect, _label, input, expected) => {
    let out = '';
    const elapsed = measureMs(() => {
      out = normalizeType(input, dialect);
    });
    expect(out).toBe(expected);
    expect(elapsed).toBeLessThan(LIMIT_MS);
  });
});
