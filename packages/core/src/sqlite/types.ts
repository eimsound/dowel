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

const PLAIN_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z0-9_]+)*$/;

/**
 * 若整段字符串是一个合法的单段引号标识符（"..."、'...'、`...`、[... ]），
 * 还原其去转义后的内容；含未闭合引号或引号外还有其他字符时返回 null。
 */
const unquoteSingleToken = (s: string): string | null => {
  if (s.length < 2) return null;
  const open = s[0]!;
  if (open === '[') {
    if (s[s.length - 1] !== ']') return null;
    return s.indexOf(']', 1) === s.length - 1 ? s.slice(1, -1) : null;
  }
  if (open !== '"' && open !== "'" && open !== '`') return null;
  const end = s.length - 1;
  if (s[end] !== open) return null;
  const parts: string[] = [];
  let i = 1;
  while (i < end) {
    const next = s.indexOf(open, i);
    if (next === -1 || next >= end) {
      parts.push(s.slice(i, end));
      break;
    }
    if (next + 1 < end && s[next + 1] === open) {
      parts.push(s.slice(i, next), open);
      i = next + 2;
    } else {
      return null;
    }
  }
  return parts.join('');
};

/**
 * 规范化 SQLite 列类型名（只做不改语义的写法统一，不做任何别名折叠）：
 * - 去首尾空白并把连续空白折叠为单空格，整体大写；
 * - 若整段是一个带引号的普通类型名（"MyType"、[weird]、`bt`、'Text'）则去掉引号，与 PRAGMA table_xinfo 读回一致；
 * - 含数字/符号/未闭合或外部带参数（如 "varchar"(10)、"a""b"）时保留引号；
 * - 空串或纯空白返回 ''（非 STRICT 表允许的无类型列）。
 */
export const sqliteNormalizeType = (input: string): string => {
  let s = input.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  s = s.toUpperCase();
  const unquoted = unquoteSingleToken(s);
  if (unquoted !== null) {
    const inner = unquoted.trim().replace(/\s+/g, ' ');
    if (PLAIN_TYPE_RE.test(inner)) return inner;
  }
  return s;
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

/** 给 MCP / AI 调用方的 SQLite 列类型写入规则说明（宏与原语 mutator 的参数描述共用） */
export const SQLITE_COLUMN_TYPE_NOTE =
  'SQLite: the declared type is kept as written (uppercased, whitespace collapsed; a fully quoted plain name is unquoted). Aliases are not folded — INT / BIGINT / BOOLEAN / VARCHAR(n) stay as given. Only a single-column INTEGER primary key is a rowid alias and only it may use ext.sqlite.autoincrement; INT / BIGINT primary keys are not rowid aliases. On non-STRICT tables `type: ""` declares an untyped column (BLOB affinity, not the same as ANY or TEXT); STRICT tables require INT, INTEGER, REAL, TEXT, BLOB or ANY.';
