// MySQL EngineAdapter 实现：快照、导入、历史、超时、风险分析、影子库清理与非事务 DDL 崩溃恢复探测。
import {
  all,
  childrenOf,
  get,
  type Model,
  mysqlLiteral,
  type MysqlPlanOptions,
  mysqlTokenize,
  type PlanOptions,
  splitMysqlStatements,
  type Token,
} from '@dowel/core';

import type { ScriptStep } from '../steps.ts';
import type { AppliedTimeouts, Db, EngineAdapter, TargetSnapshot, TimeoutInfo, TxHooks } from '../types.ts';
import { MYSQL_SESSION_SETTINGS, pinMysqlSession } from './db.ts';
import { mysqlHistory } from './history.ts';
import { importMysqlSnapshot } from './import.ts';
import { analyzeMysqlStepRisk, resetMysqlShadow } from './risk.ts';
import {
  diffMysqlSnapshots,
  mysqlFingerprint,
  type MysqlSnapshot,
  normalizeMysqlSnapshot,
  parseMysqlVersion,
  readMysqlSnapshot,
} from './snapshot.ts';

const mysqlErrno = (e: unknown): number | null => {
  const n = (e as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : null;
};

const findKeyIgnoreCase = <V>(rec: Record<string, V>, name: string): string | undefined => {
  if (name in rec) return name;
  const low = name.toLowerCase();
  return Object.keys(rec).find((k) => k.toLowerCase() === low);
};

/**
 * 对齐线上快照与参考模型中的纯 UNIQUE 索引表示：
 * MySQL 目录无法区分 `ADD CONSTRAINT u UNIQUE (c)` 与 `CREATE UNIQUE INDEX u ON t (c)`；
 * 若参考模型将该对象建模为 `Index (unique: true)`，则把快照中对应的 `uniques` 项迁移到 `indexes`，
 * 避免 `diffAgainst` 误报差异（支持表名与索引名大小写不敏感回退匹配）。
 */
const alignUniqueIndexesWithModel = (snap: MysqlSnapshot, reference: Model): MysqlSnapshot => {
  let tablesCopy: MysqlSnapshot['tables'] | null = null;
  for (const t of all(reference, 'table')) {
    const tableKey = findKeyIgnoreCase(snap.tables, t.name);
    if (!tableKey) continue;
    const snapTable = snap.tables[tableKey]!;
    for (const ix of childrenOf(reference, t.id, 'index')) {
      if (!ix.unique) continue;
      const uKey = findKeyIgnoreCase(snapTable.uniques, ix.name);
      if (!uKey) continue;
      const u = snapTable.uniques[uKey]!;
      const refCols = ix.elements.map((e) => (e.column ? get(reference, e.column, 'column').name : null));
      if (
        refCols.length === u.columns.length &&
        refCols.every((c, i) => c !== null && c.toLowerCase() === u.columns[i]!.toLowerCase())
      ) {
        tablesCopy ??= { ...snap.tables };
        const curT =
          tablesCopy[tableKey] === snapTable
            ? { ...snapTable, uniques: { ...snapTable.uniques }, indexes: { ...snapTable.indexes } }
            : tablesCopy[tableKey]!;
        delete curT.uniques[uKey];
        curT.indexes[uKey] = {
          unique: true,
          indexType: 'BTREE',
          elements: u.columns.map((c) => ({ column: c, expr: null, length: null, desc: false })),
          comment: null,
        };
        tablesCopy[tableKey] = curT;
      }
    }
  }
  return tablesCopy ? { ...snap, tables: tablesCopy } : snap;
};

// ───── 表达式规范化等价比对（alignImportedLive，消除 MySQL 反引号/字符集前导/外层括号等纯格式差异） ─────

const isSigToken = (t: Token): boolean =>
  !/^\s+$/.test(t.text) &&
  !t.text.startsWith('--') &&
  !t.text.startsWith('#') &&
  !t.text.startsWith('/*') &&
  t.text !== '*/';

const decodeMysqlStringLiteral = (raw: string): string => {
  const q = raw[0];
  if ((q !== "'" && q !== '"') || raw.length < 2 || raw[raw.length - 1] !== q) return raw;
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\' && i + 1 < inner.length) {
      const nxt = inner[++i]!;
      switch (nxt) {
        case '0':
          out += '\0';
          break;
        case 'b':
          out += '\b';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'Z':
          out += '\x1a';
          break;
        default:
          out += nxt;
      }
    } else if (ch === q && inner[i + 1] === q) {
      out += q;
      i++;
    } else {
      out += ch;
    }
  }
  return mysqlLiteral(out);
};

interface NormTok {
  kind: 'word' | 'str' | 'op';
  text: string;
}

const stripOuterParenTokens = (toks: NormTok[]): NormTok[] => {
  let cur = toks;
  while (cur.length >= 2 && cur[0]!.text === '(' && cur[cur.length - 1]!.text === ')') {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < cur.length; i++) {
      if (cur[i]!.text === '(') depth++;
      else if (cur[i]!.text === ')') {
        depth--;
        if (depth === 0 && i < cur.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (!balanced || depth !== 0) break;
    cur = cur.slice(1, -1);
  }
  return cur;
};

const COMPARE_OPS = new Set(['=', '<>', '<', '>', '<=', '>=', '<=>', 'is', 'like', 'regexp', 'in']);
const LOGICAL_BOUNDARIES = new Set(['and', 'or', 'xor', '(', ')']);

const isSimpleComparison = (inner: NormTok[]): boolean => {
  if (inner.length === 0) return false;
  let depth = 0;
  let hasCompare = false;
  for (const t of inner) {
    if (t.text === '(') depth++;
    else if (t.text === ')') depth--;
    else if (depth === 0) {
      if (t.kind === 'word' && (t.text === 'and' || t.text === 'or' || t.text === 'xor')) return false;
      if (COMPARE_OPS.has(t.text)) hasCompare = true;
    }
  }
  return hasCompare;
};

const canonicalizeMysqlExprTokens = (expr: string): string[] => {
  const sig = mysqlTokenize(expr).filter(isSigToken);
  const norm: NormTok[] = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]!;
    // 跳过字符集前导（如 _utf8mb4'open'）
    if (
      t.kind === 'ident' &&
      t.text.startsWith('_') &&
      sig[i + 1]?.kind === 'other' &&
      (sig[i + 1]!.text.startsWith("'") || sig[i + 1]!.text.startsWith('"'))
    ) {
      continue;
    }
    if (t.kind === 'ident' || t.kind === 'qident') {
      norm.push({ kind: 'word', text: t.text.toLowerCase() });
      continue;
    }
    if (t.text.startsWith("'") || t.text.startsWith('"')) {
      norm.push({ kind: 'str', text: decodeMysqlStringLiteral(t.text) });
      continue;
    }
    // 合并双字符/三字符比较运算符与数字
    if (t.text === '!' && sig[i + 1]?.text === '=') {
      norm.push({ kind: 'op', text: '<>' });
      i++;
      continue;
    }
    if (t.text === '<' && sig[i + 1]?.text === '=' && sig[i + 2]?.text === '>') {
      norm.push({ kind: 'op', text: '<=>' });
      i += 2;
      continue;
    }
    if (
      (t.text === '<' && (sig[i + 1]?.text === '=' || sig[i + 1]?.text === '>')) ||
      (t.text === '>' && sig[i + 1]?.text === '=')
    ) {
      norm.push({ kind: 'op', text: `${t.text}${sig[i + 1]!.text}` });
      i++;
      continue;
    }
    if (/^\d$/.test(t.text)) {
      let num = t.text;
      let k = i + 1;
      while (
        k < sig.length &&
        sig[k]!.start === sig[k - 1]!.end &&
        (/^\d$/.test(sig[k]!.text) || sig[k]!.text === '.')
      ) {
        num += sig[k]!.text;
        k++;
      }
      i = k - 1;
      norm.push({ kind: 'op', text: num });
      continue;
    }
    norm.push({ kind: 'op', text: t.text });
  }

  let cur = stripOuterParenTokens(norm);
  // 剥离 MySQL 在逻辑连接内为简单比较子句额外包裹的括号：例如 `((a > 0) and (b = 'x'))` -> `a > 0 and b = 'x'`
  let changed = true;
  while (changed) {
    changed = false;
    const next: NormTok[] = [];
    for (let i = 0; i < cur.length; i++) {
      const tk = cur[i]!;
      const prev = next.at(-1);
      if (tk.text === '(' && (!prev || LOGICAL_BOUNDARIES.has(prev.text))) {
        let depth = 0;
        let close = -1;
        for (let j = i; j < cur.length; j++) {
          if (cur[j]!.text === '(') depth++;
          else if (cur[j]!.text === ')') {
            depth--;
            if (depth === 0) {
              close = j;
              break;
            }
          }
        }
        if (close > i + 1) {
          const after = cur[close + 1];
          const inner = cur.slice(i + 1, close);
          if ((!after || LOGICAL_BOUNDARIES.has(after.text)) && isSimpleComparison(inner)) {
            next.push(...inner);
            i = close;
            changed = true;
            continue;
          }
        }
      }
      next.push(tk);
    }
    cur = stripOuterParenTokens(next);
  }
  return cur.map((x) => x.text);
};

export const mysqlExprCanonEqual = (a: string, b: string): boolean => {
  if (a.trim() === b.trim()) return true;
  const ta = canonicalizeMysqlExprTokens(a);
  const tb = canonicalizeMysqlExprTokens(b);
  return ta.length === tb.length && ta.every((v, i) => v === tb[i]);
};

/**
 * 将读回的 MySQL 模型表达式（CHECK、列默认值、生成列表达式、函数索引表达式）与参考模型对齐：
 * 若仅存在 MySQL 规范化造成的纯格式差异（字符集前导 `_utf8mb4`、反引号、字符串转义、外层括号与空白），
 * 沿用参考模型里的表达式写法，避免未经过影子库规范化的脚本在执行读回核对时误报 `readback_mismatch`。
 */
export const alignMysqlImportedLive = (live: Model, reference: Model): Model => {
  let objects: Model['objects'] | null = null;
  const setObj = (id: string, next: Model['objects'][string]) => {
    objects ??= { ...live.objects };
    objects[id] = next;
  };

  for (const rObj of Object.values(reference.objects)) {
    const lObj = live.objects[rObj.id];
    if (!lObj || lObj.kind !== rObj.kind) continue;

    if (rObj.kind === 'check' && lObj.kind === 'check') {
      if (lObj.expr !== rObj.expr && mysqlExprCanonEqual(lObj.expr, rObj.expr)) {
        setObj(rObj.id, { ...lObj, expr: rObj.expr });
      }
      continue;
    }

    if (rObj.kind === 'column' && lObj.kind === 'column') {
      let nextCol = lObj;
      let colChanged = false;
      if (
        rObj.default &&
        'expr' in rObj.default &&
        lObj.default &&
        'expr' in lObj.default &&
        lObj.default.expr !== rObj.default.expr &&
        mysqlExprCanonEqual(lObj.default.expr, rObj.default.expr)
      ) {
        nextCol = { ...nextCol, default: { expr: rObj.default.expr } };
        colChanged = true;
      }
      if (
        rObj.generated &&
        lObj.generated &&
        lObj.generated.stored === rObj.generated.stored &&
        lObj.generated.expr !== rObj.generated.expr &&
        mysqlExprCanonEqual(lObj.generated.expr, rObj.generated.expr)
      ) {
        nextCol = { ...nextCol, generated: { ...lObj.generated, expr: rObj.generated.expr } };
        colChanged = true;
      }
      if (colChanged) setObj(rObj.id, nextCol);
      continue;
    }

    if (rObj.kind === 'index' && lObj.kind === 'index' && lObj.elements.length === rObj.elements.length) {
      let idxChanged = false;
      const nextEls = lObj.elements.map((le, i) => {
        const re = rObj.elements[i]!;
        if (
          le.expr !== null &&
          re.expr !== null &&
          le.expr !== re.expr &&
          mysqlExprCanonEqual(le.expr, re.expr)
        ) {
          idxChanged = true;
          return { ...le, expr: re.expr };
        }
        return le;
      });
      if (idxChanged) setObj(rObj.id, { ...lObj, elements: nextEls });
    }
  }

  return objects ? { ...live, objects } : live;
};

// ───── 崩溃恢复探测（detectStepAlreadyApplied） ─────

const CREATE_ALREADY_EXISTS_ERRNOS = new Set([1050, 1060, 1061, 1068, 1826, 3822]);
const DROP_MISSING_ERRNOS = new Set([1051, 1054, 1091, 1146, 1176, 1305, 1360, 3940]);

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === 'ident' && t.text === w;
const isIdent = (t: Token | undefined): t is Token => !!t && (t.kind === 'ident' || t.kind === 'qident');

/** 仅接受当前库内的非限定对象名；明确拒绝 `db.obj` 跨库限定 */
const readObjName = (toks: Token[], start: number): { name: string; next: number } | null => {
  const first = toks[start];
  if (!isIdent(first)) return null;
  if (toks[start + 1]?.text === '.') return null;
  return { name: first.text, next: start + 1 };
};

/** 解析括号内的纯标识符列名列表 `(col1, col2)`；遇到表达式或前缀长度等无法精确比对形式返回 null */
const readParenIdentList = (toks: Token[], start: number): { cols: string[]; next: number } | null => {
  if (toks[start]?.text !== '(') return null;
  const cols: string[] = [];
  let pos = start + 1;
  while (pos < toks.length) {
    const col = readObjName(toks, pos);
    if (!col) return null;
    cols.push(col.name);
    pos = col.next;
    if (toks[pos]?.text === ',') {
      pos++;
      continue;
    }
    if (toks[pos]?.text === ')') {
      return cols.length > 0 ? { cols, next: pos + 1 } : null;
    }
    return null;
  }
  return null;
};

const skipIfClause = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'if')) return start;
  if (isWord(toks[start + 1], 'not') && isWord(toks[start + 2], 'exists')) return start + 3;
  if (isWord(toks[start + 1], 'exists')) return start + 2;
  return start;
};

const errMatchesKind = (stepErr: unknown, kind: 'create' | 'drop' | 'rename'): boolean => {
  if (stepErr === undefined) return true;
  const errno = mysqlErrno(stepErr);
  if (errno === null) return false;
  if (kind === 'create') return CREATE_ALREADY_EXISTS_ERRNOS.has(errno);
  if (kind === 'drop') return DROP_MISSING_ERRNOS.has(errno);
  return DROP_MISSING_ERRNOS.has(errno) || CREATE_ALREADY_EXISTS_ERRNOS.has(errno);
};

const hasBaseTable = async (conn: Db, name: string): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME = ?`,
    [name],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasColumn = async (conn: Db, table: string, col: string): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, col],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasIndex = async (conn: Db, table: string, index: string): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasConstraint = async (
  conn: Db,
  table: string,
  constraint: string,
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK',
): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = ?`,
    [table, constraint, type],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasConstraintWithColumns = async (
  conn: Db,
  table: string,
  constraint: string,
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY',
  expectedCols: string[],
  expectedRef?: { refTable: string; refCols: string[] },
): Promise<boolean> => {
  if (!(await hasConstraint(conn, table, constraint, type))) return false;
  const rows = await conn.query<{
    columnName: string;
    refTableName: string | null;
    refColumnName: string | null;
  }>(
    `SELECT COLUMN_NAME AS columnName,
            REFERENCED_TABLE_NAME AS refTableName,
            REFERENCED_COLUMN_NAME AS refColumnName
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table, constraint],
  );
  if (rows.length !== expectedCols.length) return false;
  if (!rows.every((r, i) => r.columnName.toLowerCase() === expectedCols[i]!.toLowerCase())) return false;
  if (expectedRef) {
    if (rows.length !== expectedRef.refCols.length) return false;
    if (
      !rows.every(
        (r, i) =>
          r.refTableName?.toLowerCase() === expectedRef.refTable.toLowerCase() &&
          r.refColumnName?.toLowerCase() === expectedRef.refCols[i]!.toLowerCase(),
      )
    ) {
      return false;
    }
  }
  return true;
};

const hasView = async (conn: Db, name: string): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [name],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasTrigger = async (conn: Db, name: string): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = ?`,
    [name],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

const hasRoutine = async (conn: Db, name: string, type: 'FUNCTION' | 'PROCEDURE'): Promise<boolean> => {
  const rows = await conn.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?`,
    [name, type],
  );
  return Number(rows[0]?.n ?? 0) > 0;
};

/**
 * 面向 MySQL DDL 自动提交下“DDL 已提交但 markStep 落盘前进程崩溃”的恢复窗口：
 * - 若传入 `stepErr`，先校验 errno 属于对应的幂等冲突码（已存在 / 不存在），拒绝权限/语法/约束数据冲突等非幂等错误；
 * - 明确拒绝跨库限定名（`db.tbl`）；
 * - 对 PK / UNIQUE / FOREIGN KEY 额外核对 `KEY_COLUMN_USAGE` 列序（及 FK 引用目标）；
 * - 对多语句、DML、MODIFY/CHANGE COLUMN 或任何无法 100% 确定的语句保守返回 false。
 */
export const detectMysqlStepAlreadyApplied = async (
  conn: Db,
  step: ScriptStep,
  stepErr?: unknown,
): Promise<boolean> => {
  const stmts = splitMysqlStatements(step.sql);
  if (stmts.length !== 1) return false;
  const toks = mysqlTokenize(stmts[0]!).filter(isSigToken);
  if (toks.length < 3) return false;

  const first = toks[0]!;

  // CREATE TABLE [IF NOT EXISTS] <tbl> ...
  if (isWord(first, 'create') && isWord(toks[1], 'table')) {
    if (!errMatchesKind(stepErr, 'create')) return false;
    const t = readObjName(toks, skipIfClause(toks, 2));
    return t ? hasBaseTable(conn, t.name) : false;
  }

  // DROP TABLE [IF EXISTS] <tbl> (仅单表)
  if (isWord(first, 'drop') && isWord(toks[1], 'table')) {
    if (!errMatchesKind(stepErr, 'drop')) return false;
    const t = readObjName(toks, skipIfClause(toks, 2));
    if (!t || toks[t.next]?.text === ',') return false;
    return !(await hasBaseTable(conn, t.name));
  }

  // RENAME TABLE <old> TO <new> (仅单对)
  if (isWord(first, 'rename') && isWord(toks[1], 'table')) {
    if (!errMatchesKind(stepErr, 'rename')) return false;
    const oldT = readObjName(toks, 2);
    if (!oldT || !isWord(toks[oldT.next], 'to')) return false;
    const newT = readObjName(toks, oldT.next + 1);
    if (!newT || toks[newT.next]?.text === ',') return false;
    return !(await hasBaseTable(conn, oldT.name)) && (await hasBaseTable(conn, newT.name));
  }

  // CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX <idx> ON <tbl> ...
  if (isWord(first, 'create')) {
    let j = 1;
    if (isWord(toks[j], 'unique') || isWord(toks[j], 'fulltext') || isWord(toks[j], 'spatial')) j++;
    if (isWord(toks[j], 'index')) {
      if (!errMatchesKind(stepErr, 'create')) return false;
      const idx = readObjName(toks, j + 1);
      if (idx && isWord(toks[idx.next], 'on')) {
        const tbl = readObjName(toks, idx.next + 1);
        if (tbl) return hasIndex(conn, tbl.name, idx.name);
      }
    }
    return false;
  }

  // DROP INDEX <idx> ON <tbl>
  if (isWord(first, 'drop') && isWord(toks[1], 'index')) {
    if (!errMatchesKind(stepErr, 'drop')) return false;
    const idx = readObjName(toks, 2);
    if (idx && isWord(toks[idx.next], 'on')) {
      const tbl = readObjName(toks, idx.next + 1);
      if (tbl) return !(await hasIndex(conn, tbl.name, idx.name));
    }
    return false;
  }

  // DROP VIEW / TRIGGER / FUNCTION / PROCEDURE [IF EXISTS] <name>
  if (isWord(first, 'drop')) {
    if (!errMatchesKind(stepErr, 'drop')) return false;
    const kind = toks[1];
    const obj = readObjName(toks, skipIfClause(toks, 2));
    if (!obj) return false;
    if (isWord(kind, 'view')) return !(await hasView(conn, obj.name));
    if (isWord(kind, 'trigger')) return !(await hasTrigger(conn, obj.name));
    if (isWord(kind, 'function')) return !(await hasRoutine(conn, obj.name, 'FUNCTION'));
    if (isWord(kind, 'procedure')) return !(await hasRoutine(conn, obj.name, 'PROCEDURE'));
    return false;
  }

  // ALTER TABLE <tbl> <single deterministic action>
  if (isWord(first, 'alter') && isWord(toks[1], 'table')) {
    const tbl = readObjName(toks, 2);
    if (!tbl) return false;
    const act = toks[tbl.next];
    const pos = tbl.next + 1;

    // 确认不是多子句逗号拼接的 ALTER TABLE（检查括号深度为 0 时是否还有后续动作）
    const hasTopLevelComma = (fromIdx: number): boolean => {
      let depth = 0;
      for (let i = fromIdx; i < toks.length; i++) {
        const tx = toks[i]!.text;
        if (tx === '(') depth++;
        else if (tx === ')') depth = Math.max(0, depth - 1);
        else if (tx === ',' && depth === 0) return true;
      }
      return false;
    };

    if (isWord(act, 'add')) {
      if (!errMatchesKind(stepErr, 'create')) return false;
      if (hasTopLevelComma(pos)) return false;
      // ADD PRIMARY KEY (<cols>)
      if (isWord(toks[pos], 'primary') && isWord(toks[pos + 1], 'key')) {
        const cols = readParenIdentList(toks, pos + 2);
        if (!cols) return false;
        return hasConstraintWithColumns(conn, tbl.name, 'PRIMARY', 'PRIMARY KEY', cols.cols);
      }
      // ADD CONSTRAINT <c> UNIQUE|FOREIGN KEY|CHECK ...
      if (isWord(toks[pos], 'constraint')) {
        const con = readObjName(toks, pos + 1);
        if (!con) return false;
        const conKind = toks[con.next];
        if (isWord(conKind, 'unique')) {
          let listPos = con.next + 1;
          if (isWord(toks[listPos], 'key') || isWord(toks[listPos], 'index')) listPos++;
          const cols = readParenIdentList(toks, listPos);
          if (!cols) return false;
          return hasConstraintWithColumns(conn, tbl.name, con.name, 'UNIQUE', cols.cols);
        }
        if (isWord(conKind, 'foreign') && isWord(toks[con.next + 1], 'key')) {
          const cols = readParenIdentList(toks, con.next + 2);
          if (!cols || !isWord(toks[cols.next], 'references')) return false;
          const refTbl = readObjName(toks, cols.next + 1);
          if (!refTbl) return false;
          const refCols = readParenIdentList(toks, refTbl.next);
          if (!refCols) return false;
          return hasConstraintWithColumns(conn, tbl.name, con.name, 'FOREIGN KEY', cols.cols, {
            refTable: refTbl.name,
            refCols: refCols.cols,
          });
        }
        if (isWord(conKind, 'check')) return hasConstraint(conn, tbl.name, con.name, 'CHECK');
        return false;
      }
      // ADD [COLUMN] <col> ...
      if (
        isWord(toks[pos], 'unique') ||
        isWord(toks[pos], 'foreign') ||
        isWord(toks[pos], 'check') ||
        isWord(toks[pos], 'index') ||
        isWord(toks[pos], 'key') ||
        isWord(toks[pos], 'fulltext') ||
        isWord(toks[pos], 'spatial')
      ) {
        return false;
      }
      const colStart = isWord(toks[pos], 'column') ? pos + 1 : pos;
      const col = readObjName(toks, colStart);
      return col ? hasColumn(conn, tbl.name, col.name) : false;
    }

    if (isWord(act, 'drop')) {
      if (!errMatchesKind(stepErr, 'drop')) return false;
      if (hasTopLevelComma(pos)) return false;
      if (isWord(toks[pos], 'primary') && isWord(toks[pos + 1], 'key')) {
        return !(await hasConstraint(conn, tbl.name, 'PRIMARY', 'PRIMARY KEY'));
      }
      if (isWord(toks[pos], 'foreign') && isWord(toks[pos + 1], 'key')) {
        const con = readObjName(toks, pos + 2);
        return con ? !(await hasConstraint(conn, tbl.name, con.name, 'FOREIGN KEY')) : false;
      }
      if (isWord(toks[pos], 'check')) {
        const con = readObjName(toks, pos + 1);
        return con ? !(await hasConstraint(conn, tbl.name, con.name, 'CHECK')) : false;
      }
      if (isWord(toks[pos], 'index') || isWord(toks[pos], 'key')) {
        const idx = readObjName(toks, pos + 1);
        return idx ? !(await hasIndex(conn, tbl.name, idx.name)) : false;
      }
      if (isWord(toks[pos], 'constraint')) return false;
      const colStart = isWord(toks[pos], 'column') ? pos + 1 : pos;
      const col = readObjName(toks, colStart);
      return col ? !(await hasColumn(conn, tbl.name, col.name)) : false;
    }

    if (isWord(act, 'rename')) {
      if (!errMatchesKind(stepErr, 'rename')) return false;
      if (hasTopLevelComma(pos)) return false;
      if (isWord(toks[pos], 'column')) {
        const oldC = readObjName(toks, pos + 1);
        if (!oldC || !isWord(toks[oldC.next], 'to')) return false;
        const newC = readObjName(toks, oldC.next + 1);
        if (!newC) return false;
        return !(await hasColumn(conn, tbl.name, oldC.name)) && (await hasColumn(conn, tbl.name, newC.name));
      }
      if (isWord(toks[pos], 'index') || isWord(toks[pos], 'key')) {
        const oldI = readObjName(toks, pos + 1);
        if (!oldI || !isWord(toks[oldI.next], 'to')) return false;
        const newI = readObjName(toks, oldI.next + 1);
        if (!newI) return false;
        return !(await hasIndex(conn, tbl.name, oldI.name)) && (await hasIndex(conn, tbl.name, newI.name));
      }
      if (isWord(toks[pos], 'to') || isWord(toks[pos], 'as')) {
        const newT = readObjName(toks, pos + 1);
        if (!newT) return false;
        return !(await hasBaseTable(conn, tbl.name)) && (await hasBaseTable(conn, newT.name));
      }
    }
  }

  return false;
};

export const mysqlEngine: EngineAdapter = {
  dialect: 'mysql',
  history: mysqlHistory,
  sessionSettings: MYSQL_SESSION_SETTINGS,

  sessionHeader: () => `${MYSQL_SESSION_SETTINGS.join(';\n')};\n`,

  pinSession: pinMysqlSession,

  resetSession: async (db) => {
    await db.exec('SET SESSION lock_wait_timeout = DEFAULT');
    await db.exec('SET SESSION max_execution_time = DEFAULT');
    await db.exec('SET FOREIGN_KEY_CHECKS = 1');
  },

  inTransaction: async <T>(conn: Db, fn: () => Promise<T>, hooks: TxHooks = {}): Promise<T> => {
    await conn.exec('START TRANSACTION');
    try {
      const r = await fn();
      hooks.beforeCommit?.();
      await conn.exec('COMMIT');
      hooks.afterCommit?.();
      return r;
    } catch (e) {
      await conn.exec('ROLLBACK').catch(() => {});
      throw e;
    }
  },

  execStepSql: async (conn, sql) => {
    await conn.exec(sql);
  },

  readSnapshot: async (db) => {
    const snap = await readMysqlSnapshot(db);
    return {
      dialect: 'mysql',
      version: snap.version,
      versionNum: snap.versionNum,
      payload: snap,
    };
  },

  importSnapshot: (snap) => importMysqlSnapshot(snap.payload as MysqlSnapshot),

  normalizeSnapshot: (snap) => normalizeMysqlSnapshot(snap.payload as MysqlSnapshot),

  normalizeLiveSnapshot: (snap: TargetSnapshot, reference: Model): TargetSnapshot => ({
    ...snap,
    payload: alignUniqueIndexesWithModel(snap.payload as MysqlSnapshot, reference),
  }),

  alignImportedLive: alignMysqlImportedLive,

  diffSnapshots: (a, b) => diffMysqlSnapshots(a.payload as MysqlSnapshot, b.payload as MysqlSnapshot),

  fingerprint: (snap) => mysqlFingerprint(snap.payload as MysqlSnapshot),

  readVersionNum: async (db) => {
    const [r] = await db.query<{ v: string }>('SELECT VERSION() AS v');
    if (!r?.v) return null;
    return parseMysqlVersion(String(r.v)).versionNum;
  },

  planOptionsForVersion: (versionNum) => ({ mysqlVersionNum: versionNum }) as MysqlPlanOptions as PlanOptions,

  resetShadow: resetMysqlShadow,

  prepareImportShadow: async (db) => {
    await pinMysqlSession(db);
  },

  stripImportNoise: (sql) =>
    sql
      .split('\n')
      .filter((l) => !/^\s*(?:LOCK\s+TABLES\b.+;|UNLOCK\s+TABLES\s*;)\s*$/i.test(l))
      .join('\n'),

  analyzeStepRisk: (db, from, steps, opts) =>
    analyzeMysqlStepRisk(db, from, steps, opts as MysqlPlanOptions | undefined),

  applyTimeouts: async (conn, timeouts): Promise<AppliedTimeouts> => {
    const ms = (n: number) => Math.max(0, Math.trunc(n));
    const applied = {
      statementMs: timeouts ? ms(timeouts.statementMs) : 0,
      lockMs: timeouts ? ms(timeouts.lockMs) : 0,
    };
    if (applied.lockMs > 0) {
      const secs = Math.max(1, Math.ceil(applied.lockMs / 1000));
      await conn.exec(`SET SESSION lock_wait_timeout = ${secs}`);
    }
    if (applied.statementMs > 0) {
      await conn.exec(`SET SESSION max_execution_time = ${applied.statementMs}`);
    }
    return applied;
  },

  restoreTimeouts: async (conn, applied) => {
    if (applied.lockMs > 0) await conn.exec('SET SESSION lock_wait_timeout = DEFAULT');
    if (applied.statementMs > 0) await conn.exec('SET SESSION max_execution_time = DEFAULT');
  },

  classifyTimeout: (err, applied): TimeoutInfo | undefined => {
    const errno = mysqlErrno(err);
    if (errno === 1205 && applied.lockMs > 0) return { kind: 'lock', ms: applied.lockMs };
    if ((errno === 3024 || errno === 1969) && applied.statementMs > 0) {
      return { kind: 'statement', ms: applied.statementMs };
    }
    return undefined;
  },

  detectStepAlreadyApplied: detectMysqlStepAlreadyApplied,
};
