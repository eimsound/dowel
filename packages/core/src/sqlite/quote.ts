// SQLite 标识符引用、关键字、词法分析与表达式列引用扫描。
import type { Token } from '../plan-types.ts';

/** SQLite 官方保留关键字（https://www.sqlite.org/lang_keywords.html） */
export const SQLITE_KEYWORDS: ReadonlySet<string> = new Set(
  'abort action add after all alter always analyze and as asc attach autoincrement before begin between by cascade case cast check collate column commit conflict constraint create cross current current_date current_time current_timestamp database default deferrable deferred delete desc detach distinct do drop each else end escape except exclude exists explain fail filter first following for foreign from full generated glob group groups having if ignore immediate in index indexed initially inner insert instead intersect into is isnull join key last left like limit match materialized natural no not nothing notnull null nulls of offset on or order others outer over partition plan pragma preceding primary query raise range recursive references regexp reindex release rename replace restrict returning right rollback row rows savepoint select set table temp temporary then ties to transaction trigger unbounded union unique update using vacuum values view virtual when where window with without'.split(
    ' ',
  ),
);

/** SQLite 标识符引用：仅全小写 ASCII 合法标识符且非关键字时不加引号，其余用双引号并转义 "" */
export const sqliteIdent = (name: string): string =>
  /^[a-z_][a-z0-9_]*$/.test(name) && !SQLITE_KEYWORDS.has(name) ? name : `"${name.replaceAll('"', '""')}"`;

/** SQLite 逻辑 schema 固定为 main，生成 SQL 时通常直接输出表/索引名；非 main 时输出 schema.name */
export const sqliteQualified = (schema: string, name: string): string =>
  schema === 'main' ? sqliteIdent(name) : `${sqliteIdent(schema)}.${sqliteIdent(name)}`;

export const sqliteLiteral = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * 单遍扫 SQLite SQL：剥离单引号字符串、双引号/反引号/方括号标识符、行注释 `--` 与块注释 `/* ... *\/`，
 * 替换为安全占位符并保留语句分隔符 `;`，用于可靠判断语句类型与拆分语句。
 */
export const stripSqliteSql = (sql: string): string => {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else break;
        } else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
      out += '""';
    } else if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') i += 2;
          else break;
        } else i++;
      }
      i++;
      out += '""';
    } else if (c === '[') {
      i++;
      while (i < n && sql[i] !== ']') i++;
      i++;
      out += '""';
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

/** SQLite 表达式词法分析：识别字符串、双引号/反引号/方括号标识符、普通标识符、注释 */
export const sqliteTokenize = (s: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    const start = i;
    if (ch === "'") {
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") i += 2;
        else if (s[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '"') {
      i++;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') i += 2;
        else if (s[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start + 1, i - 1).replaceAll('""', '"'), kind: 'qident', start, end: i });
    } else if (ch === '`') {
      i++;
      while (i < s.length) {
        if (s[i] === '`' && s[i + 1] === '`') i += 2;
        else if (s[i] === '`') {
          i++;
          break;
        } else i++;
      }
      out.push({ text: s.slice(start + 1, i - 1).replaceAll('``', '`'), kind: 'qident', start, end: i });
    } else if (ch === '[') {
      i++;
      while (i < s.length && s[i] !== ']') i++;
      const endInner = i;
      if (i < s.length && s[i] === ']') i++;
      out.push({ text: s.slice(start + 1, endInner), kind: 'qident', start, end: i });
    } else if (ch === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (ch === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i = Math.min(s.length, i + 2);
      out.push({ text: s.slice(start, i), kind: 'other', start, end: i });
    } else if (/[A-Za-z_\u0080-\uFFFD]/.test(ch)) {
      while (i < s.length && /[A-Za-z0-9_$\u0080-\uFFFD]/.test(s[i]!)) i++;
      out.push({ text: s.slice(start, i).toLowerCase(), kind: 'ident', start, end: i });
    } else {
      i++;
      out.push({ text: ch, kind: 'other', start, end: i });
    }
  }
  return out;
};

/** 表达式中出现的列引用（跳过函数名、限定名前缀、CAST(... AS type) 中的类型名、COLLATE 后的排序规则名） */
export const sqliteColumnRefs = (expr: string): Token[] => {
  const sig = sqliteTokenize(expr).filter(
    (x) => !/^\s+$/.test(x.text) && !x.text.startsWith('--') && !x.text.startsWith('/*'),
  );
  const out: Token[] = [];
  let inCastAs = 0;
  for (let i = 0; i < sig.length; i++) {
    const x = sig[i]!;
    if (x.kind === 'ident' && x.text === 'collate') {
      i++; // 跳过排序规则名
      continue;
    }
    if (x.kind === 'ident' && x.text === 'cast' && sig[i + 1]?.text === '(') {
      inCastAs++;
      continue;
    }
    if (inCastAs > 0 && x.kind === 'ident' && x.text === 'as') {
      // 跳过 CAST(... AS <type>) 里的类型词直至 ')'
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
    const next = sig[i + 1]?.text;
    if (next === '(' || next === '.') continue;
    out.push(x);
  }
  return out;
};

export const sqliteExprReferences = (expr: string, name: string): boolean => {
  const low = name.toLowerCase();
  return sqliteColumnRefs(expr).some((x) => x.text.toLowerCase() === low);
};

export const sqliteRenameInExpr = (expr: string, from: string, to: string): string => {
  const low = from.toLowerCase();
  let out = expr;
  for (const x of sqliteColumnRefs(expr).reverse()) {
    if (x.text.toLowerCase() === low) out = out.slice(0, x.start) + sqliteIdent(to) + out.slice(x.end);
  }
  return out;
};

export const sqliteRenameQualifiedInExpr = (
  expr: string,
  schema: string,
  name: string | null,
  to: { schema: string; name: string | null },
): string => {
  const t = sqliteTokenize(expr);
  let out = expr;
  const match = (x: Token | undefined, n: string) =>
    !!x && (x.kind === 'ident' || x.kind === 'qident') && x.text.toLowerCase() === n.toLowerCase();
  for (let i = t.length - 1; i >= 0; i--) {
    if (!match(t[i], schema) || t[i + 1]?.text !== '.') continue;
    if (name === null) {
      out = out.slice(0, t[i]!.start) + sqliteIdent(to.schema) + out.slice(t[i]!.end);
    } else if (match(t[i + 2], name)) {
      out = `${out.slice(0, t[i]!.start)}${sqliteIdent(to.schema)}.${sqliteIdent(to.name!)}${out.slice(t[i + 2]!.end)}`;
    }
  }
  return out;
};

/**
 * 将 SQLite 多语句脚本文本拆分为单条顶层语句：
 * - 跳过字符串、引号/反引号/方括号标识符与注释内的分号；
 * - 正确处理 `CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END;` 内部的语句分号（以及 `CASE ... END` 嵌套）。
 */
export const splitSqliteStatements = (sql: string): string[] => {
  const out: string[] = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  let inTriggerHeader = false;
  let triggerBodyDepth = 0;
  let caseDepth = 0;
  let stmtTokens: string[] = [];

  const flush = (end: number) => {
    const piece = sql.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end + 1;
    inTriggerHeader = false;
    triggerBodyDepth = 0;
    caseDepth = 0;
    stmtTokens = [];
  };

  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (c === '`') {
      i++;
      while (i < n) {
        if (sql[i] === '`' && sql[i + 1] === '`') i += 2;
        else if (sql[i] === '`') {
          i++;
          break;
        } else i++;
      }
    } else if (c === '[') {
      i++;
      while (i < n && sql[i] !== ']') i++;
      if (i < n) i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
    } else if (/[A-Za-z_]/.test(c)) {
      const s0 = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i]!)) i++;
      const word = sql.slice(s0, i).toLowerCase();
      if (stmtTokens.length < 4) {
        stmtTokens.push(word);
        if (
          stmtTokens[0] === 'create' &&
          (stmtTokens[1] === 'trigger' ||
            ((stmtTokens[1] === 'temp' || stmtTokens[1] === 'temporary') && stmtTokens[2] === 'trigger'))
        ) {
          inTriggerHeader = true;
        }
      }
      if (inTriggerHeader && triggerBodyDepth === 0 && word === 'begin') {
        triggerBodyDepth = 1;
      } else if (triggerBodyDepth > 0) {
        if (word === 'case') caseDepth++;
        else if (word === 'end') {
          if (caseDepth > 0) caseDepth--;
          else {
            triggerBodyDepth = 0;
            inTriggerHeader = false;
          }
        }
      }
    } else if (c === ';' && triggerBodyDepth === 0) {
      flush(i);
      i++;
    } else {
      i++;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
};
