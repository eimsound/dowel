// SQLite CREATE TABLE / CREATE INDEX DDL 词法与结构解析器：
// 补充 PRAGMA 无法提供的信息：STRICT / WITHOUT ROWID、AUTOINCREMENT、CHECK 约束、
// 显式 CONSTRAINT 名、列 COLLATE、GENERATED 表达式、外键 DEFERRABLE、索引表达式与 WHERE 条件。
import { sqliteTokenize, type Token } from '@dowel/core';

export interface ParsedCheck {
  name: string | null;
  expr: string;
}

export interface ParsedUnique {
  name: string | null;
  columns: string[];
}

export interface ParsedFkMeta {
  name: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface ParsedTableDdl {
  withoutRowid: boolean;
  strict: boolean;
  pkName: string | null;
  pkColumns: string[];
  autoincrementColumn: string | null;
  columnCollations: Record<string, string>;
  generatedExprs: Record<string, { expr: string; stored: boolean }>;
  uniques: ParsedUnique[];
  checks: ParsedCheck[];
  foreignKeys: ParsedFkMeta[];
}

export interface ParsedIndexDdl {
  elements: { expr: string | null; column: string | null; collation: string | null; desc: boolean }[];
  where: string | null;
}

const isWs = (t: Token) =>
  t.kind === 'other' && (/^\s+$/.test(t.text) || t.text.startsWith('--') || t.text.startsWith('/*'));

/** 去掉空白和注释后的 token 流，保留在原文中的 start/end 偏移 */
const significantTokens = (sql: string): Token[] => sqliteTokenize(sql).filter((t) => !isWs(t));

const kw = (t: Token | undefined, word: string): boolean =>
  !!t && t.kind === 'ident' && t.text.toLowerCase() === word;

const identText = (t: Token | undefined): string | null =>
  t && (t.kind === 'ident' || t.kind === 'qident') ? t.text : null;

const BUILTIN_COLLATIONS = new Set(['binary', 'nocase', 'rtrim']);
const normalizeCollation = (raw: string | null): string | null =>
  raw && BUILTIN_COLLATIONS.has(raw.toLowerCase()) ? raw.toUpperCase() : raw;

/** 找到从 openIdx（指向 '('）开始匹配的 ')' 的下标 */
const findCloseParen = (toks: Token[], openIdx: number): number => {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    if (toks[i]!.text === '(') depth++;
    else if (toks[i]!.text === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return toks.length - 1;
};

/** 剥掉最外层多余的一对平衡括号 */
export const unwrapOuterParens = (expr: string): string => {
  let s = expr.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    const toks = significantTokens(s);
    if (toks.length >= 2 && toks[0]!.text === '(' && findCloseParen(toks, 0) === toks.length - 1) {
      s = s.slice(1, -1).trim();
    } else {
      break;
    }
  }
  return s;
};

/** 把 ( ... ) 内部按顶层逗号切分为若干 token 切片 */
const splitTopLevelComma = (toks: Token[]): Token[][] => {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.text === '(') depth++;
    else if (t.text === ')') depth = Math.max(0, depth - 1);
    if (t.text === ',' && depth === 0) {
      if (cur.length) parts.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) parts.push(cur);
  return parts;
};

/** 从原文提取 toks[from..to] 之间的精确子串 */
const sliceText = (sql: string, toks: Token[], from: number, to: number): string => {
  if (from > to || from >= toks.length) return '';
  return sql.slice(toks[from]!.start, toks[Math.min(to, toks.length - 1)]!.end).trim();
};

/** 读取一个由括号包裹的列名列表 `(col1, col2)`，返回列名列表与右括号下标 */
const parseParenColList = (toks: Token[], openIdx: number): { cols: string[]; end: number } => {
  const close = findCloseParen(toks, openIdx);
  const inner = toks.slice(openIdx + 1, close);
  const cols: string[] = [];
  for (const part of splitTopLevelComma(inner)) {
    const first = identText(part[0]);
    if (first) cols.push(first);
  }
  return { cols, end: close };
};

/** 解析 DEFERRABLE [INITIALLY DEFERRED | INITIALLY IMMEDIATE] */
const parseDeferrable = (
  toks: Token[],
  from: number,
): { deferrable: boolean; initiallyDeferred: boolean } => {
  let deferrable = false;
  let initiallyDeferred = false;
  for (let i = from; i < toks.length; i++) {
    if (kw(toks[i], 'not') && kw(toks[i + 1], 'deferrable')) {
      deferrable = false;
      initiallyDeferred = false;
      i++;
    } else if (kw(toks[i], 'deferrable')) {
      deferrable = true;
      if (kw(toks[i + 1], 'initially')) {
        if (kw(toks[i + 2], 'deferred')) initiallyDeferred = true;
        else if (kw(toks[i + 2], 'immediate')) initiallyDeferred = false;
      }
    }
  }
  return { deferrable, initiallyDeferred };
};

/**
 * 解析 SQLite `CREATE TABLE` DDL（来自 `sqlite_master.sql`）。
 */
export const parseSqliteTableDdl = (sql: string): ParsedTableDdl => {
  const res: ParsedTableDdl = {
    withoutRowid: false,
    strict: false,
    pkName: null,
    pkColumns: [],
    autoincrementColumn: null,
    columnCollations: {},
    generatedExprs: {},
    uniques: [],
    checks: [],
    foreignKeys: [],
  };
  const toks = significantTokens(sql);
  // 找到表体左括号 '('
  const openIdx = toks.findIndex((t) => t.text === '(');
  if (openIdx < 0) return res;
  const closeIdx = findCloseParen(toks, openIdx);

  // 解析尾部表选项（WITHOUT ROWID, STRICT）
  const tail = toks.slice(closeIdx + 1);
  for (let i = 0; i < tail.length; i++) {
    if (kw(tail[i], 'without') && kw(tail[i + 1], 'rowid')) {
      res.withoutRowid = true;
      i++;
    } else if (kw(tail[i], 'strict')) {
      res.strict = true;
    }
  }

  // 解析表体每一项（列定义或表级约束）
  const body = toks.slice(openIdx + 1, closeIdx);
  for (const item of splitTopLevelComma(body)) {
    if (!item.length) continue;
    let i = 0;
    let constraintName: string | null = null;
    if (kw(item[i], 'constraint')) {
      constraintName = identText(item[i + 1]);
      i += 2;
    }

    // 表级约束：PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY
    if (kw(item[i], 'primary') && kw(item[i + 1], 'key')) {
      const pIdx = item.findIndex((t, idx) => idx >= i + 2 && t.text === '(');
      if (pIdx >= 0) {
        res.pkName = constraintName;
        res.pkColumns = parseParenColList(item, pIdx).cols;
      }
      continue;
    }
    if (kw(item[i], 'unique')) {
      const pIdx = item.findIndex((t, idx) => idx >= i + 1 && t.text === '(');
      if (pIdx >= 0) {
        res.uniques.push({ name: constraintName, columns: parseParenColList(item, pIdx).cols });
      }
      continue;
    }
    if (kw(item[i], 'check')) {
      const pIdx = item.findIndex((t, idx) => idx >= i + 1 && t.text === '(');
      if (pIdx >= 0) {
        const end = findCloseParen(item, pIdx);
        const rawExpr = sliceText(sql, item, pIdx + 1, end - 1);
        res.checks.push({ name: constraintName, expr: rawExpr });
      }
      continue;
    }
    if (kw(item[i], 'foreign') && kw(item[i + 1], 'key')) {
      const pIdx = item.findIndex((t, idx) => idx >= i + 2 && t.text === '(');
      if (pIdx >= 0) {
        const { cols, end } = parseParenColList(item, pIdx);
        const refIdx = item.findIndex((t, idx) => idx > end && kw(t, 'references'));
        if (refIdx >= 0) {
          const refTable = identText(item[refIdx + 1]) ?? '';
          let refCols: string[] = [];
          let afterRef = refIdx + 2;
          if (item[afterRef]?.text === '(') {
            const parsed = parseParenColList(item, afterRef);
            refCols = parsed.cols;
            afterRef = parsed.end + 1;
          }
          const def = parseDeferrable(item, afterRef);
          res.foreignKeys.push({
            name: constraintName,
            columns: cols,
            refTable,
            refColumns: refCols,
            ...def,
          });
        }
      }
      continue;
    }

    // 列定义：item[0] 是列名
    const colName = identText(item[0]);
    if (!colName) continue;
    // 跳过列名与类型名（可能含参数如 VARCHAR(255)），扫描列级约束关键字
    let j = 1;
    // 跳过类型名（非列约束关键字且非引号）
    const COL_STOP = new Set([
      'constraint',
      'primary',
      'not',
      'null',
      'unique',
      'check',
      'default',
      'collate',
      'references',
      'generated',
      'as',
    ]);
    while (j < item.length && !COL_STOP.has(item[j]!.kind === 'ident' ? item[j]!.text : '')) {
      if (item[j]!.text === '(') j = findCloseParen(item, j) + 1;
      else j++;
    }

    let pendingName: string | null = null;
    while (j < item.length) {
      if (kw(item[j], 'constraint')) {
        pendingName = identText(item[j + 1]);
        j += 2;
        continue;
      }
      if (kw(item[j], 'primary') && kw(item[j + 1], 'key')) {
        res.pkName = pendingName;
        res.pkColumns = [colName];
        pendingName = null;
        j += 2;
        if (kw(item[j], 'asc') || kw(item[j], 'desc')) j++;
        if (kw(item[j], 'on') && kw(item[j + 1], 'conflict')) j += 3;
        if (kw(item[j], 'autoincrement')) {
          res.autoincrementColumn = colName;
          j++;
        }
        continue;
      }
      if (kw(item[j], 'not') && kw(item[j + 1], 'null')) {
        pendingName = null;
        j += 2;
        if (kw(item[j], 'on') && kw(item[j + 1], 'conflict')) j += 3;
        continue;
      }
      if (kw(item[j], 'null')) {
        pendingName = null;
        j++;
        continue;
      }
      if (kw(item[j], 'unique')) {
        res.uniques.push({ name: pendingName, columns: [colName] });
        pendingName = null;
        j++;
        if (kw(item[j], 'on') && kw(item[j + 1], 'conflict')) j += 3;
        continue;
      }
      if (kw(item[j], 'check') && item[j + 1]?.text === '(') {
        const end = findCloseParen(item, j + 1);
        const rawExpr = sliceText(sql, item, j + 2, end - 1);
        res.checks.push({ name: pendingName, expr: rawExpr });
        pendingName = null;
        j = end + 1;
        continue;
      }
      if (kw(item[j], 'default')) {
        pendingName = null;
        j++;
        if (item[j]?.text === '(') {
          j = findCloseParen(item, j) + 1;
        } else {
          if (item[j]?.text === '+' || item[j]?.text === '-') j++;
          j++;
        }
        continue;
      }
      if (kw(item[j], 'collate')) {
        const coll = normalizeCollation(identText(item[j + 1]));
        if (coll) res.columnCollations[colName.toLowerCase()] = coll;
        pendingName = null;
        j += 2;
        continue;
      }
      if (kw(item[j], 'references')) {
        const refTable = identText(item[j + 1]) ?? '';
        let refCols: string[] = [];
        let k = j + 2;
        if (item[k]?.text === '(') {
          const parsed = parseParenColList(item, k);
          refCols = parsed.cols;
          k = parsed.end + 1;
        }
        // 找到下一个列约束起点以便解析 ON DELETE / ON UPDATE / DEFERRABLE
        let nextStop = k;
        while (
          nextStop < item.length &&
          !(
            kw(item[nextStop], 'constraint') ||
            kw(item[nextStop], 'primary') ||
            kw(item[nextStop], 'unique') ||
            kw(item[nextStop], 'check') ||
            kw(item[nextStop], 'default') ||
            kw(item[nextStop], 'collate') ||
            kw(item[nextStop], 'generated') ||
            kw(item[nextStop], 'as') ||
            (kw(item[nextStop], 'not') && kw(item[nextStop + 1], 'null'))
          )
        ) {
          nextStop++;
        }
        const def = parseDeferrable(item.slice(0, nextStop), k);
        res.foreignKeys.push({
          name: pendingName,
          columns: [colName],
          refTable,
          refColumns: refCols,
          ...def,
        });
        pendingName = null;
        j = nextStop;
        continue;
      }
      if (
        (kw(item[j], 'generated') && kw(item[j + 1], 'always') && kw(item[j + 2], 'as')) ||
        kw(item[j], 'as')
      ) {
        const asIdx = kw(item[j], 'as') ? j : j + 2;
        if (item[asIdx + 1]?.text === '(') {
          const end = findCloseParen(item, asIdx + 1);
          const expr = sliceText(sql, item, asIdx + 2, end - 1);
          let stored = false;
          let next = end + 1;
          if (kw(item[next], 'stored')) {
            stored = true;
            next++;
          } else if (kw(item[next], 'virtual')) {
            stored = false;
            next++;
          }
          res.generatedExprs[colName.toLowerCase()] = { expr, stored };
          pendingName = null;
          j = next;
          continue;
        }
      }
      j++;
    }
  }
  return res;
};

/**
 * 解析 SQLite `CREATE [UNIQUE] INDEX` DDL（来自 `sqlite_master.sql`），提取元素表达式、COLLATE、DESC 与 WHERE 子句。
 */
export const parseSqliteIndexDdl = (sql: string): ParsedIndexDdl => {
  const toks = significantTokens(sql);
  const openIdx = toks.findIndex((t) => t.text === '(');
  if (openIdx < 0) return { elements: [], where: null };
  const closeIdx = findCloseParen(toks, openIdx);
  const inner = toks.slice(openIdx + 1, closeIdx);
  const elements: ParsedIndexDdl['elements'] = [];

  for (const part of splitTopLevelComma(inner)) {
    if (!part.length) continue;
    let end = part.length - 1;
    let desc = false;
    let collation: string | null = null;
    if (kw(part[end], 'desc')) {
      desc = true;
      end--;
    } else if (kw(part[end], 'asc')) {
      end--;
    }
    if (end >= 1 && kw(part[end - 1], 'collate')) {
      collation = normalizeCollation(identText(part[end]));
      end -= 2;
    }
    const core = part.slice(0, end + 1);
    if (core.length === 1 && (core[0]!.kind === 'ident' || core[0]!.kind === 'qident')) {
      elements.push({ column: core[0]!.text, expr: null, collation, desc });
    } else {
      const rawExpr = sliceText(sql, core, 0, core.length - 1);
      elements.push({ column: null, expr: unwrapOuterParens(rawExpr), collation, desc });
    }
  }

  let where: string | null = null;
  const whereIdx = toks.findIndex((t, idx) => idx > closeIdx && kw(t, 'where'));
  if (whereIdx >= 0 && whereIdx + 1 < toks.length) {
    where = sliceText(sql, toks, whereIdx + 1, toks.length - 1)
      .replace(/;\s*$/, '')
      .trim();
  }
  return { elements, where };
};
