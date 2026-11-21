// MSSQL 标识符长度上限（128 字符）、保留 schema 规则与带名约束/索引推导命名规则。

export const MAX_MSSQL_IDENT = 128;

const RESERVED_SCHEMAS = new Set(['dowel', 'sys', 'information_schema', 'guest', 'cdc']);

/** 判断 schema 名是否为 SQL Server / Dowel 保留 schema（禁止作为用户 schema 创建或修改） */
export const isReservedMssqlSchema = (name: string): boolean => {
  const low = name.toLowerCase();
  return RESERVED_SCHEMAS.has(low) || low.startsWith('db_');
};

const clipChars = (s: string, max: number): string => Array.from(s).slice(0, Math.max(0, max)).join('');
const charLen = (s: string): number => Array.from(s).length;

/**
 * 构造前缀风格对象名：`<prefix>_<name1>[_<name2>][_<suffix>]`，确保总字符数不超过 128。
 */
export const mssqlMakeObjectName = (
  prefix: string,
  name1: string,
  name2: string | null,
  suffix: string | null = null,
): string => {
  let n1 = charLen(name1);
  let n2 = name2 ? charLen(name2) : 0;
  let overhead = charLen(prefix) + 1; // `${prefix}_`
  if (name2) overhead += 1; // `_${name2}`
  if (suffix) overhead += charLen(suffix) + 1; // `_${suffix}`
  const avail = Math.max(1, MAX_MSSQL_IDENT - overhead);
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  let name = `${prefix}_${clipChars(name1, n1)}`;
  if (name2) name += `_${clipChars(name2, n2)}`;
  if (suffix) name += `_${suffix}`;
  return name;
};

export const mssqlChooseName = (
  prefix: string,
  name1: string,
  name2: string | null,
  taken: (n: string) => boolean = () => false,
): string => {
  for (let pass = 0; ; pass++) {
    const suffix = pass === 0 ? null : String(pass);
    const n = mssqlMakeObjectName(prefix, name1, name2, suffix);
    if (!taken(n)) return n;
  }
};

export const mssqlJoinNames = (names: string[]): string => {
  let buf = '';
  for (const n of names) {
    if (buf) buf += '_';
    buf += n;
    if (charLen(buf) >= MAX_MSSQL_IDENT) break;
  }
  return clipChars(buf, MAX_MSSQL_IDENT);
};

export const mssqlDerivedNames = {
  default: (table: string, column: string) => mssqlMakeObjectName('DF', table, column),
  primaryKey: (table: string) => mssqlMakeObjectName('PK', table, null),
  unique: (table: string, cols: string[]) => mssqlMakeObjectName('UQ', table, mssqlJoinNames(cols)),
  foreignKey: (table: string, cols: string[]) => mssqlMakeObjectName('FK', table, mssqlJoinNames(cols)),
  check: (table: string, onlyColumn: string | null) => mssqlMakeObjectName('CK', table, onlyColumn),
  index: (table: string, elementNames: string[]) =>
    mssqlMakeObjectName('IX', table, mssqlJoinNames(elementNames)),
};
