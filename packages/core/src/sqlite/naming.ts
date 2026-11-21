// SQLite 自动命名规则（字符上限 128）。

const MAX_SQLITE_IDENT = 128;

const clipChars = (s: string, max: number): string => Array.from(s).slice(0, Math.max(0, max)).join('');
const charLen = (s: string): number => Array.from(s).length;

export const sqliteMakeObjectName = (name1: string, name2: string | null, label: string | null): string => {
  let n1 = charLen(name1);
  let n2 = name2 ? charLen(name2) : 0;
  let overhead = 0;
  if (label) overhead += charLen(label) + 1;
  if (name2) overhead += 1;
  const avail = MAX_SQLITE_IDENT - overhead;
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  let name = clipChars(name1, n1);
  if (name2) name += `_${clipChars(name2, n2)}`;
  if (label) name += `_${label}`;
  return name;
};

export const sqliteChooseName = (
  name1: string,
  name2: string | null,
  label: string,
  taken: (n: string) => boolean = () => false,
): string => {
  let mod = label;
  for (let pass = 0; ;) {
    const n = sqliteMakeObjectName(name1, name2, mod);
    if (!taken(n)) return n;
    mod = `${label}${++pass}`;
  }
};

export const sqliteJoinNames = (names: string[]): string => {
  let buf = '';
  for (const n of names) {
    if (buf) buf += '_';
    buf += n;
    if (charLen(buf) >= MAX_SQLITE_IDENT) break;
  }
  return clipChars(buf, MAX_SQLITE_IDENT);
};

export const sqliteDerivedNames = {
  primaryKey: (table: string) => sqliteMakeObjectName(table, null, 'pkey'),
  unique: (table: string, cols: string[]) => sqliteMakeObjectName(table, sqliteJoinNames(cols), 'key'),
  foreignKey: (table: string, cols: string[]) => sqliteMakeObjectName(table, sqliteJoinNames(cols), 'fkey'),
  check: (table: string, onlyColumn: string | null) => sqliteMakeObjectName(table, onlyColumn, 'check'),
  index: (table: string, elementNames: string[]) =>
    sqliteMakeObjectName(table, sqliteJoinNames(elementNames), 'idx'),
};
