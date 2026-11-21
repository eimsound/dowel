// MySQL 标识符引用、字面量转义、关键字、词法分析、表达式列引用扫描与顶层语句切分。
import type { Token } from '../plan-types.ts';

/** MySQL 8.4 / 9.7 保留关键字及表达式常用关键字 */
export const MYSQL_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'accessible add all alter analyze and as asc asensitive before between bigint binary blob both by call cascade case change char character check collate column condition constraint continue convert create cross cube cume_dist current_date current_time current_timestamp current_user cursor database databases day_hour day_microsecond day_minute day_second dec decimal declare default delayed delete dense_rank desc describe deterministic distinct distinctrow div double drop dual each else elseif empty enclosed escaped except exists exit explain false fetch first_value float float4 float8 for force foreign from fulltext function generated get grant group grouping groups having high_priority hour_microsecond hour_minute hour_second if ignore in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer intersect interval into io_after_gtids io_before_gtids is iterate join json_table key keys kill lag last_value lateral lead leading leave left like limit linear lines load localtime localtimestamp lock long longblob longtext loop low_priority manual master_bind master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint minute_microsecond minute_second mod modifies natural not no_write_to_binlog nth_value ntile null numeric of on optimize optimizer_costs option optionally or order out outer outfile over parallel partition percent_rank persist persist_only precision primary procedure purge qualify range rank read reads read_write real recursive references regexp release rename repeat replace require resignal restrict return revoke right rlike row rows row_number schema schemas second_microsecond select sensitive separator set show signal small smallint spatial specific sql sqlexception sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stored straight_join system table terminated then tinyblob tinyint tinytext to trailing trigger true undo union unique unlock unsigned update usage use using utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying vector virtual when where while window with write xor year_month zerofill ' +
    'signed datetime date time timestamp year json text bit bool boolean enum set geometry point linestring polygon multipoint multilinestring multipolygon geometrycollection utf8mb4 utf8mb3 utf8 latin1 ascii day month hour minute second microsecond week quarter'
  ).split(' '),
);

/** MySQL 标识符引用：统一使用反引号并转义内部反引号为 ``，彻底免疫 8.4 / 9.7 新增保留字 */
export const mysqlIdent = (name: string): string => `\`${name.replaceAll('`', '``')}\``;

/** MySQL 单 schema（逻辑固定为 default）；default 时直接输出对象名 */
export const mysqlQualified = (schema: string, name: string): string =>
  !schema || schema === 'default' ? mysqlIdent(name) : `${mysqlIdent(schema)}.${mysqlIdent(name)}`;

/**
 * MySQL 字符串字面量转义：
 * 同时转义反斜杠（默认 NO_BACKSLASH_ESCAPES 关闭语义）与单引号（''，无论开关均安全），并转义控制字符。
 */
export const mysqlLiteral = (s: string): string => {
  let out = "'";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case "'":
        out += "''";
        break;
      case '\0':
        out += '\\0';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\x1a':
        out += '\\Z';
        break;
      default:
        out += ch;
    }
  }
  out += "'";
  return out;
};

const isMysqlLineCommentAt = (sql: string, i: number): boolean => {
  if (sql[i] === '#') return true;
  if (sql[i] === '-' && sql[i + 1] === '-') {
    const next = sql[i + 2];
    return next === undefined || next === ' ' || next === '\t' || next === '\n' || next === '\r';
  }
  return false;
};

/** 匹配 MySQL 版本条件注释前缀 `/*!` 或 `/*!80000`，返回跳过的长度；普通块注释返回 0 */
const conditionalCommentPrefixLen = (sql: string, i: number): number => {
  if (sql[i] !== '/' || sql[i + 1] !== '*' || sql[i + 2] !== '!') return 0;
  let j = i + 3;
  while (j < sql.length && sql[j]! >= '0' && sql[j]! <= '9') j++;
  return j - i;
};

/**
 * 单遍扫 MySQL SQL：
 * - 剥离单引号/双引号字符串（含反斜杠与双写转义）、反引号标识符、行注释 `-- ` / `#`、普通块注释 `/* ... *\/`；
 * - 解包 MySQL 可执行条件注释 `/*!...*\/`（保留其中 SQL 语句，防止将危险语句藏进条件注释绕过检测）；
 * - 保留顶层分号 `;`。
 */
export const stripMysqlSql = (sql: string): string => {
  let out = '';
  const n = sql.length;
  let i = 0;
  let inConditional = false;
  while (i < n) {
    const c = sql[i]!;
    if (inConditional && c === '*' && sql[i + 1] === '/') {
      inConditional = false;
      i += 2;
      out += ' ';
    } else if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2;
        } else if (sql[i] === q) {
          if (sql[i + 1] === q) i += 2;
          else break;
        } else {
          i++;
        }
      }
      i++;
      out += q === "'" ? "''" : '""';
    } else if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') i += 2;
          else break;
        } else {
          i++;
        }
      }
      i++;
      out += '``';
    } else if (isMysqlLineCommentAt(sql, i)) {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const condLen = conditionalCommentPrefixLen(sql, i);
      if (condLen > 0) {
        inConditional = true;
        i += condLen;
        out += ' ';
      } else {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        out += ' ';
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

/**
 * MySQL 词法分析器：
 * - 单引号 / 双引号字符串（含 `\` 转义与双写转义）→ `other`
 * - 反引号标识符（含 `` 转义）→ `qident`（保留原始大小写）
 * - `-- ` / `#` 行注释、`/* ... *\/` 普通块注释 → `other`
 * - `/*!...*\/` 条件注释 → 解包并对其内部 SQL 正常分词
 * - 普通标识符 → `ident`（统一转小写）
 */
export const mysqlTokenize = (s: string): Token[] => {
  const out: Token[] = [];
  const n = s.length;
  let i = 0;
  let inConditional = false;
  while (i < n) {
    const ch = s[i]!;
    const start = i;
    if (inConditional && ch === '*' && s[i + 1] === '/') {
      inConditional = false;
      i += 2;
      out.push({ text: '*/', kind: 'other', start, end: i });
    } else if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < n) {
        if (s[i] === '\\') {
          i = Math.min(n, i + 2);
        } else if (s[i] === q) {
          if (s[i + 1] === q) i += 2;
          else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '`') {
      i++;
      while (i < n) {
        if (s[i] === '`') {
          if (s[i + 1] === '`') i += 2;
          else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      const rawInner = i > start + 1 && s[i - 1] === '`' ? s.slice(start + 1, i - 1) : s.slice(start + 1, i);
      out.push({ text: rawInner.replaceAll('``', '`'), kind: 'qident', start, end: i });
    } else if (isMysqlLineCommentAt(s, i)) {
      while (i < n && s[i] !== '\n') i++;
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '/' && s[i + 1] === '*') {
      const condLen = conditionalCommentPrefixLen(s, i);
      if (condLen > 0) {
        inConditional = true;
        i += condLen;
        out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
      } else {
        i += 2;
        while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
      }
    } else if (/[A-Za-z_\u0080-\uFFFD]/.test(ch)) {
      while (i < n && /[A-Za-z0-9_$\u0080-\uFFFD]/.test(s[i]!)) i++;
      out.push({ text: s.slice(start, i).toLowerCase(), kind: 'ident', start, end: i });
    } else {
      i++;
      out.push({ text: ch, kind: 'other', start, end: i });
    }
  }
  return out;
};

const isTriviaToken = (t: Token): boolean =>
  /^\s+$/.test(t.text) ||
  t.text.startsWith('--') ||
  t.text.startsWith('#') ||
  t.text.startsWith('/*') ||
  t.text === '*/';

const isStringLiteralToken = (t: Token | undefined): boolean =>
  !!t && t.kind === 'other' && (t.text.startsWith("'") || t.text.startsWith('"'));

/**
 * 表达式中出现的列引用（跳过函数名、限定前缀、字符集前导如 `_utf8mb4'x'`、
 * `COLLATE`、`CHARACTER SET`、`CAST(... AS type)`、`CONVERT(... USING charset)`）。
 */
export const mysqlColumnRefs = (expr: string): Token[] => {
  const sig = mysqlTokenize(expr).filter((x) => !isTriviaToken(x));
  const out: Token[] = [];
  let inCastAs = 0;
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]!;
    if (x.kind === 'ident' && x.text === 'collate') {
      i++;
      continue;
    }
    if (
      x.kind === 'ident' &&
      x.text === 'character' &&
      sig[i + 1]?.kind === 'ident' &&
      sig[i + 1]!.text === 'set'
    ) {
      i += 2;
      continue;
    }
    if (x.kind === 'ident' && x.text === 'charset') {
      i++;
      continue;
    }
    if (x.kind === 'ident' && x.text === 'using') {
      i++;
      continue;
    }
    if (x.kind === 'ident' && x.text === 'cast' && sig[i + 1]?.text === '(') {
      inCastAs++;
      continue;
    }
    if (inCastAs > 0 && x.kind === 'ident' && x.text === 'as') {
      let depth = 0;
      while (i + 1 < sig.length) {
        const nxt = sig[i + 1]!;
        if (nxt.text === '(') depth++;
        else if (nxt.text === ')') {
          if (depth === 0) break;
          depth--;
        }
        i++;
      }
      inCastAs = Math.max(0, inCastAs - 1);
      continue;
    }
    if (x.kind === 'other') continue;
    // 跳过字符集前缀 introducer，例如 `_utf8mb4'abc'`、`x'01'`、`b'10'`
    if (
      x.kind === 'ident' &&
      (x.text.startsWith('_') || x.text === 'x' || x.text === 'b' || x.text === 'n') &&
      isStringLiteralToken(sig[i + 1])
    ) {
      continue;
    }
    const next = sig[i + 1]?.text;
    if (next === '(' || next === '.') continue;
    out.push(x);
  }
  return out;
};

export const mysqlExprReferences = (expr: string, name: string): boolean => {
  const low = name.toLowerCase();
  return mysqlColumnRefs(expr).some((x) => x.text.toLowerCase() === low);
};

export const mysqlRenameInExpr = (expr: string, from: string, to: string): string => {
  const low = from.toLowerCase();
  let out = expr;
  for (const x of mysqlColumnRefs(expr).reverse()) {
    if (x.text.toLowerCase() === low) out = out.slice(0, x.start) + mysqlIdent(to) + out.slice(x.end);
  }
  return out;
};

export const mysqlRenameQualifiedInExpr = (
  expr: string,
  schema: string,
  name: string | null,
  to: { schema: string; name: string | null },
): string => {
  const t = mysqlTokenize(expr);
  let out = expr;
  const match = (x: Token | undefined, n: string) =>
    !!x && (x.kind === 'ident' || x.kind === 'qident') && x.text.toLowerCase() === n.toLowerCase();
  for (let i = t.length - 1; i >= 0; i--) {
    if (!match(t[i], schema) || t[i + 1]?.text !== '.') continue;
    if (name === null) {
      out = out.slice(0, t[i]!.start) + mysqlIdent(to.schema) + out.slice(t[i]!.end);
    } else if (match(t[i + 2], name)) {
      out = `${out.slice(0, t[i]!.start)}${mysqlIdent(to.schema)}.${mysqlIdent(to.name!)}${out.slice(t[i + 2]!.end)}`;
    }
  }
  return out;
};

const END_COMPOUND_TAIL = new Set(['if', 'loop', 'while', 'repeat', 'case']);

/**
 * 将 MySQL 多语句脚本文本拆分为单条顶层语句（禁止依赖 `multipleStatements: true`）：
 * - 跳过单/双引号字符串、反引号标识符与注释内的分号；
 * - 正确保留 `CREATE [DEFINER=...] TRIGGER / FUNCTION / PROCEDURE / EVENT ... BEGIN ... END;`
 *   复合语句块内部的分号（含嵌套 `BEGIN ... END`、`IF ... END IF`、`CASE ... END [CASE]`、`LOOP/WHILE/REPEAT`）；
 * - 兼容导入脚本里的客户端 `DELIMITER <delim>` 指令。
 */
export const splitMysqlStatements = (sql: string): string[] => {
  const out: string[] = [];
  const n = sql.length;
  let delimiter = ';';
  let start = 0;
  let i = 0;
  let inRoutineHeader = false;
  let blockDepth = 0;
  let caseDepth = 0;
  let stmtWords: string[] = [];
  let inConditional = false;

  const resetStmt = () => {
    inRoutineHeader = false;
    blockDepth = 0;
    caseDepth = 0;
    stmtWords = [];
  };

  const flush = (end: number, delimLen: number) => {
    const piece = sql.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end + delimLen;
    resetStmt();
  };

  const peekNextWord = (from: number): { word: string; end: number } | null => {
    let j = from;
    while (j < n) {
      const c = sql[j]!;
      if (/\s/.test(c)) {
        j++;
      } else if (isMysqlLineCommentAt(sql, j)) {
        while (j < n && sql[j] !== '\n') j++;
      } else if (c === '/' && sql[j + 1] === '*') {
        j += 2;
        while (j < n && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
        j = Math.min(n, j + 2);
      } else {
        break;
      }
    }
    if (j >= n || !/[A-Za-z_]/.test(sql[j]!)) return null;
    const wStart = j;
    while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
    return { word: sql.slice(wStart, j).toLowerCase(), end: j };
  };

  while (i < n) {
    // 顶层行首支持客户端 DELIMITER 指令
    if (blockDepth === 0 && stmtWords.length === 0 && (i === 0 || sql[i - 1] === '\n')) {
      const m = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(sql.slice(i));
      if (m) {
        const piece = sql.slice(start, i).trim();
        if (piece) out.push(piece);
        delimiter = m[1]!;
        i += m[0].length;
        start = i;
        resetStmt();
        continue;
      }
    }

    const c = sql[i]!;
    if (inConditional && c === '*' && sql[i + 1] === '/') {
      inConditional = false;
      i += 2;
    } else if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\') i = Math.min(n, i + 2);
        else if (sql[i] === q) {
          if (sql[i + 1] === q) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else if (isMysqlLineCommentAt(sql, i)) {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const condLen = conditionalCommentPrefixLen(sql, i);
      if (condLen > 0) {
        inConditional = true;
        i += condLen;
      } else {
        i += 2;
        while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
      }
    } else if (blockDepth === 0 && sql.startsWith(delimiter, i)) {
      flush(i, delimiter.length);
      i = start;
    } else if (/[A-Za-z_]/.test(c)) {
      const s0 = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const word = sql.slice(s0, i).toLowerCase();
      if (stmtWords.length < 10) {
        stmtWords.push(word);
        if (
          stmtWords[0] === 'create' &&
          (word === 'trigger' || word === 'function' || word === 'procedure' || word === 'event')
        ) {
          inRoutineHeader = true;
        }
      }
      if (inRoutineHeader && word === 'begin') {
        blockDepth++;
      } else if (blockDepth > 0) {
        if (word === 'case') {
          caseDepth++;
        } else if (word === 'end') {
          const nxt = peekNextWord(i);
          if (nxt && END_COMPOUND_TAIL.has(nxt.word)) {
            if (nxt.word === 'case' && caseDepth > 0) caseDepth--;
            i = nxt.end;
          } else if (caseDepth > 0) {
            caseDepth--;
          } else {
            blockDepth--;
            if (blockDepth === 0) inRoutineHeader = false;
          }
        }
      }
    } else {
      i++;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
};
