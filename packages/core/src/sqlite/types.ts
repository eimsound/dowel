// SQLite 类型亲和性与规范化。
// SQLite 非 STRICT 表按类型亲和性存储，STRICT 表仅允许 INT / INTEGER / REAL / TEXT / BLOB / ANY。

export const SQLITE_STRICT_TYPES: ReadonlySet<string> = new Set([
  'INT',
  'INTEGER',
  'REAL',
  'TEXT',
  'BLOB',
  'ANY',
]);

const CANONICAL_SIMPLE: Record<string, string> = {
  int: 'INTEGER',
  integer: 'INTEGER',
  tinyint: 'INTEGER',
  smallint: 'INTEGER',
  mediumint: 'INTEGER',
  bigint: 'INTEGER',
  int2: 'INTEGER',
  int8: 'INTEGER',
  text: 'TEXT',
  clob: 'TEXT',
  varchar: 'TEXT',
  real: 'REAL',
  double: 'REAL',
  'double precision': 'REAL',
  float: 'REAL',
  blob: 'BLOB',
  numeric: 'NUMERIC',
  decimal: 'NUMERIC',
  boolean: 'INTEGER',
  bool: 'INTEGER',
  any: 'ANY',
};

/**
 * 规范化 SQLite 类型名：
 * - 统一大写、压缩空白；
 * - 保留带参数写法（如 VARCHAR(255) / DECIMAL(10,2)）以便从既有库导入不失真；
 * - 常见纯类型名归一到 SQLite 标准写法（INTEGER / TEXT / REAL / BLOB / NUMERIC / ANY）。
 */
export const sqliteNormalizeType = (input: string): string => {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return 'TEXT';
  const low = s.toLowerCase();
  if (low in CANONICAL_SIMPLE) return CANONICAL_SIMPLE[low]!;
  return s.toUpperCase();
};

const BUILTIN_COLLATIONS: ReadonlySet<string> = new Set(['binary', 'nocase', 'rtrim']);

/**
 * 内置排序规则（BINARY / NOCASE / RTRIM）统一大写，与引擎读回的写法一致；自定义排序规则原样保留。
 * SQLite 的排序规则名不区分大小写，所以这只是换个写法，不改语义。
 */
export const sqliteNormalizeCollation = (collation: string | null): string | null =>
  collation && BUILTIN_COLLATIONS.has(collation.toLowerCase()) ? collation.toUpperCase() : collation;

/** 界面里推荐的 SQLite 常用类型 */
export const SQLITE_COMMON_TYPES: readonly string[] = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'NUMERIC', 'ANY'];
