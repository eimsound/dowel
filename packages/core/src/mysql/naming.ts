// MySQL 自动命名规则（字符上限 64；主键约束名固定为 PRIMARY）。

export const MAX_MYSQL_IDENT = 64;

export const MYSQL_SHADOW_MARK_TABLE = '__dowel_shadow_mark';

/** MySQL 表/列选项（ENGINE / CHARACTER SET / COLLATE）允许的安全标识符格式 */
export const MYSQL_SAFE_IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;

const clipChars = (s: string, max: number): string => Array.from(s).slice(0, Math.max(0, max)).join('');
const charLen = (s: string): number => Array.from(s).length;

export const mysqlMakeObjectName = (name1: string, name2: string | null, label: string | null): string => {
  let n1 = charLen(name1);
  let n2 = name2 ? charLen(name2) : 0;
  let overhead = 0;
  if (label) overhead += charLen(label) + 1;
  if (name2) overhead += 1;
  const avail = MAX_MYSQL_IDENT - overhead;
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  let name = clipChars(name1, n1);
  if (name2) name += `_${clipChars(name2, n2)}`;
  if (label) name += `_${label}`;
  return name;
};

export const mysqlChooseName = (
  name1: string,
  name2: string | null,
  label: string,
  taken: (n: string) => boolean = () => false,
): string => {
  let mod = label;
  for (let pass = 0; ;) {
    const n = mysqlMakeObjectName(name1, name2, mod);
    if (!taken(n)) return n;
    mod = `${label}${++pass}`;
  }
};

export const mysqlJoinNames = (names: string[]): string => {
  let buf = '';
  for (const n of names) {
    if (buf) buf += '_';
    buf += n;
    if (charLen(buf) >= MAX_MYSQL_IDENT) break;
  }
  return clipChars(buf, MAX_MYSQL_IDENT);
};

export const mysqlDerivedNames = {
  primaryKey: (): string => 'PRIMARY',
  unique: (table: string, cols: string[]): string => mysqlMakeObjectName(table, mysqlJoinNames(cols), 'key'),
  foreignKey: (table: string, cols: string[]): string =>
    mysqlMakeObjectName(table, mysqlJoinNames(cols), 'fkey'),
  check: (table: string, onlyColumn: string | null): string =>
    mysqlMakeObjectName(table, onlyColumn, 'check'),
  index: (table: string, elementNames: string[]): string =>
    mysqlMakeObjectName(table, mysqlJoinNames(elementNames), 'idx'),
};
