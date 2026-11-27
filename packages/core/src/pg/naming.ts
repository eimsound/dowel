// PG 自动命名规则的复现（src/backend/commands/indexcmds.c 的 makeObjectName / ChooseRelationName 等）。
// 实验依据见 .agents/docs/01-research.md 5.1。
const NAMEDATALEN = 64;
const enc = new TextEncoder();
// 可打印 ASCII 时字节数等于字符数，免去逐字符编码（推导名热点路径）；其他字符走原逻辑
const ASCII_RE = /^[ -~]*$/;

/** 按字节截断到 n 字节以内，不截断多字节字符（等价于 pg_mbcliplen） */
const clip = (s: string, maxBytes: number): string => {
  if (ASCII_RE.test(s)) return s.length <= maxBytes ? s : s.slice(0, Math.max(0, maxBytes));
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = enc.encode(ch).length;
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
};
const len = (s: string) => (ASCII_RE.test(s) ? s.length : enc.encode(s).length);

/** makeObjectName(name1, name2, label)：总长不超过 63 字节，较长的一段先截 */
export const makeObjectName = (name1: string, name2: string | null, label: string | null): string => {
  let n1 = len(name1);
  let n2 = name2 ? len(name2) : 0;
  let overhead = 0;
  if (label) overhead += len(label) + 1;
  if (name2) overhead += 1;
  const avail = NAMEDATALEN - 1 - overhead;
  while (n1 + n2 > avail) {
    if (n1 > n2) n1--;
    else n2--;
  }
  let name = clip(name1, n1);
  if (name2) name += `_${clip(name2, n2)}`;
  if (label) name += `_${label}`;
  return name;
};

/**
 * ChooseRelationName / ChooseConstraintName：重名时在 label 后加 1、2、3……
 * taken 是同一命名空间里已被占用的名字。
 */
export const chooseName = (
  name1: string,
  name2: string | null,
  label: string,
  taken: (n: string) => boolean = () => false,
): string => {
  let mod = label;
  for (let pass = 0; ;) {
    const n = makeObjectName(name1, name2, mod);
    if (!taken(n)) return n;
    mod = `${label}${++pass}`;
  }
};

/** 多列名用下划线连接（ChooseIndexNameAddition / ChooseForeignKeyConstraintNameAddition），总长不超过 63 字节 */
export const joinNames = (names: string[]): string => {
  let buf = '';
  for (const n of names) {
    if (buf) buf += '_';
    buf += n;
    if (len(buf) >= NAMEDATALEN) break;
  }
  return clip(buf, NAMEDATALEN - 1);
};

export const derivedNames = {
  primaryKey: (table: string) => makeObjectName(table, null, 'pkey'),
  unique: (table: string, cols: string[]) => makeObjectName(table, joinNames(cols), 'key'),
  foreignKey: (table: string, cols: string[]) => makeObjectName(table, joinNames(cols), 'fkey'),
  /** 只引用一列时带列名，否则只有表名 */
  check: (table: string, onlyColumn: string | null) => makeObjectName(table, onlyColumn, 'check'),
  notNull: (table: string, col: string) => makeObjectName(table, col, 'not_null'),
  /** 索引元素：列取列名，表达式取最外层函数名，否则为 expr */
  index: (table: string, elementNames: string[]) => makeObjectName(table, joinNames(elementNames), 'idx'),
  sequence: (table: string, col: string) => makeObjectName(table, col, 'seq'),
};
