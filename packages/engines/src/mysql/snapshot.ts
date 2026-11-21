// 从 MySQL information_schema 读取完整结构快照，支持规范化、差异比较与结构指纹。
import { createHash } from 'node:crypto';

import {
  deepEqual,
  isMysqlNumericType,
  MYSQL_SHADOW_MARK_TABLE,
  mysqlIdent,
  mysqlLiteral,
  mysqlNormalizeType,
  splitMysqlTypeModifiers,
  stableJson,
} from '@dowel/core';

import type { Db } from '../types.ts';
import { pinMysqlSession } from './db.ts';

export interface MysqlColSnap {
  ordinalPosition: number;
  type: string;
  unsigned: boolean;
  zerofill: boolean;
  notNull: boolean;
  default: string | null;
  generated: { expr: string; stored: boolean } | null;
  charset: string | null;
  collation: string | null;
  autoIncrement: boolean;
  onUpdateCurrentTimestamp: boolean;
  comment: string | null;
}

export interface MysqlPkSnap {
  columns: string[];
}

export interface MysqlUniqueSnap {
  name: string;
  columns: string[];
}

export interface MysqlCheckSnap {
  name: string;
  expr: string;
}

export interface MysqlFkSnap {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
}

export interface MysqlIdxElemSnap {
  column: string | null;
  expr: string | null;
  length: number | null;
  desc: boolean;
}

export interface MysqlIdxSnap {
  unique: boolean;
  indexType: 'BTREE' | 'HASH' | 'FULLTEXT' | 'SPATIAL';
  elements: MysqlIdxElemSnap[];
  comment: string | null;
}

export interface MysqlTableSnap {
  name: string;
  engine: string;
  charset: string;
  collation: string;
  comment: string | null;
  columns: Record<string, MysqlColSnap>;
  primaryKey: MysqlPkSnap | null;
  uniques: Record<string, MysqlUniqueSnap>;
  checks: Record<string, MysqlCheckSnap>;
  foreignKeys: Record<string, MysqlFkSnap>;
  indexes: Record<string, MysqlIdxSnap>;
}

export interface MysqlOpaqueSnap {
  objType: 'view' | 'trigger' | 'function' | 'procedure';
  name: string;
  tblName: string | null;
  ddl: string;
  drop: string;
  order: number;
}

export interface MysqlSnapshot {
  version: string;
  versionNum: number;
  defaultCharset: string;
  defaultCollation: string;
  tables: Record<string, MysqlTableSnap>;
  opaques: Record<string, MysqlOpaqueSnap>;
}

const FK_ACTION_MAP: Record<string, string> = {
  'NO ACTION': 'noAction',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  'SET DEFAULT': 'setDefault',
};

/** 解析 MySQL 版本字符串（如 "8.4.13" / "9.7.0-commercial"）为简洁版本串与数值版本号（80413 / 90700） */
export const parseMysqlVersion = (raw: string): { version: string; versionNum: number } => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return { version: raw.trim() || '8.4.0', versionNum: 80400 };
  const maj = Number.parseInt(m[1]!, 10);
  const min = Number.parseInt(m[2]!, 10);
  const pat = Number.parseInt(m[3]!, 10);
  return {
    version: `${maj}.${min}.${pat}`,
    versionNum: maj * 10000 + min * 100 + pat,
  };
};

/** 若表达式最外层由单对平衡括号包裹，则剥离这一层括号（与 MySQL CHECK_CLAUSE 的外层括号对称） */
const stripSingleOuterParens = (expr: string): string => {
  const t = expr.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return t;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') i++;
      else if (ch === quote) {
        if (t[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return t;
    }
  }
  return depth === 0 ? t.slice(1, -1).trim() : t;
};

/** 判断是否由一对最外层平衡括号包裹 */
const isOuterParen = (expr: string): boolean => {
  const t = expr.trim();
  return t.startsWith('(') && t.endsWith(')') && stripSingleOuterParens(t) !== t;
};

/** 剥离 SHOW CREATE VIEW / TRIGGER / FUNCTION / PROCEDURE 中的 DEFINER 子句以保证跨账号可移植 */
const stripDefiner = (ddl: string): string =>
  ddl.replace(/\s+DEFINER\s*=\s*`(?:[^`]|``)+`@`(?:[^`]|``)+`/i, '').trim();

const formatColumnDefault = (rawDefault: string | null, extra: string, baseType: string): string | null => {
  if (rawDefault === null || rawDefault === undefined) return null;
  const val = String(rawDefault);
  if (/\bDEFAULT_GENERATED\b/i.test(extra)) {
    const trimmed = val.trim();
    if (/^CURRENT_TIMESTAMP(?:\(\d+\))?$/i.test(trimmed)) return trimmed.toUpperCase();
    return isOuterParen(trimmed) ? trimmed : `(${trimmed})`;
  }
  if (/^bit(?:\(\d+\))?$/i.test(baseType)) {
    return val;
  }
  if (isMysqlNumericType(baseType)) {
    return val;
  }
  return mysqlLiteral(val);
};

const normalizeIndexType = (raw: string | null | undefined): MysqlIdxSnap['indexType'] => {
  const u = (raw ?? 'BTREE').toUpperCase();
  if (u === 'HASH' || u === 'FULLTEXT' || u === 'SPATIAL') return u;
  return 'BTREE';
};

const fieldIgnoreCase = (row: Record<string, unknown>, target: string): string | null => {
  const low = target.toLowerCase();
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === low && typeof v === 'string') return v;
  }
  return null;
};

/** 从 MySQL 当前库读取完整结构快照（自动排除 dowel_* 与 __dowel_shadow_mark） */
export const readMysqlSnapshot = async (db: Db): Promise<MysqlSnapshot> => {
  await pinMysqlSession(db);

  const [metaRow] = await db.query<{
    ver: string;
    defaultCharset: string;
    defaultCollation: string;
  }>(
    `SELECT VERSION() AS ver,
            @@character_set_database AS defaultCharset,
            @@collation_database AS defaultCollation`,
  );
  const { version, versionNum } = parseMysqlVersion(String(metaRow?.ver ?? '8.4.0'));
  const defaultCharset = String(metaRow?.defaultCharset ?? 'utf8mb4');
  const defaultCollation = String(metaRow?.defaultCollation ?? 'utf8mb4_0900_ai_ci');

  const collationRows = await db.query<{ collationName: string; charsetName: string }>(
    `SELECT COLLATION_NAME AS collationName, CHARACTER_SET_NAME AS charsetName
       FROM information_schema.COLLATIONS`,
  );
  const charsetByCollation = new Map(
    collationRows.map((r) => [r.collationName.toLowerCase(), r.charsetName]),
  );

  const tableRows = await db.query<{
    tableName: string;
    engine: string | null;
    tableCollation: string | null;
    tableComment: string | null;
  }>(
    `SELECT TABLE_NAME AS tableName,
            ENGINE AS engine,
            TABLE_COLLATION AS tableCollation,
            TABLE_COMMENT AS tableComment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  const tables: Record<string, MysqlTableSnap> = {};
  for (const tr of tableRows) {
    const collation = tr.tableCollation || defaultCollation;
    const charset = charsetByCollation.get(collation.toLowerCase()) ?? defaultCharset;
    tables[tr.tableName] = {
      name: tr.tableName,
      engine: tr.engine || 'InnoDB',
      charset,
      collation,
      comment: tr.tableComment ? tr.tableComment : null,
      columns: {},
      primaryKey: null,
      uniques: {},
      checks: {},
      foreignKeys: {},
      indexes: {},
    };
  }

  // 1. 列
  const colRows = await db.query<{
    tableName: string;
    columnName: string;
    ordinalPosition: number | string;
    columnDefault: string | null;
    isNullable: string;
    columnType: string;
    charsetName: string | null;
    collationName: string | null;
    extra: string | null;
    generationExpr: string | null;
    columnComment: string | null;
  }>(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            ORDINAL_POSITION AS ordinalPosition,
            COLUMN_DEFAULT AS columnDefault,
            IS_NULLABLE AS isNullable,
            COLUMN_TYPE AS columnType,
            CHARACTER_SET_NAME AS charsetName,
            COLLATION_NAME AS collationName,
            EXTRA AS extra,
            GENERATION_EXPRESSION AS generationExpr,
            COLUMN_COMMENT AS columnComment
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  for (const cr of colRows) {
    const tbl = tables[cr.tableName];
    if (!tbl) continue;
    const extra = cr.extra ?? '';
    const { baseType, unsigned, zerofill } = splitMysqlTypeModifiers(cr.columnType);
    const isStored = /\bSTORED GENERATED\b/i.test(extra);
    const isVirtual = /\bVIRTUAL GENERATED\b/i.test(extra);
    const generated =
      isStored || isVirtual ? { expr: (cr.generationExpr ?? '').trim(), stored: isStored } : null;

    const colCharset =
      cr.charsetName && cr.charsetName.toLowerCase() !== tbl.charset.toLowerCase() ? cr.charsetName : null;
    const colCollation =
      cr.collationName && cr.collationName.toLowerCase() !== tbl.collation.toLowerCase()
        ? cr.collationName
        : null;

    tbl.columns[cr.columnName] = {
      ordinalPosition: Number(cr.ordinalPosition),
      type: mysqlNormalizeType(baseType),
      unsigned,
      zerofill,
      notNull: cr.isNullable.toUpperCase() === 'NO',
      default: generated ? null : formatColumnDefault(cr.columnDefault, extra, baseType),
      generated,
      charset: colCharset,
      collation: colCollation,
      autoIncrement: /\bauto_increment\b/i.test(extra),
      onUpdateCurrentTimestamp: /\bon update current_timestamp\b/i.test(extra),
      comment: cr.columnComment ? cr.columnComment : null,
    };
  }

  // 2. 约束（PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK）
  const tcRows = await db.query<{
    tableName: string;
    constraintName: string;
    constraintType: string;
  }>(
    `SELECT TABLE_NAME AS tableName,
            CONSTRAINT_NAME AS constraintName,
            CONSTRAINT_TYPE AS constraintType
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  const kcuRows = await db.query<{
    tableName: string;
    constraintName: string;
    columnName: string;
    ordinalPosition: number | string;
    refTableName: string | null;
    refColumnName: string | null;
  }>(
    `SELECT TABLE_NAME AS tableName,
            CONSTRAINT_NAME AS constraintName,
            COLUMN_NAME AS columnName,
            ORDINAL_POSITION AS ordinalPosition,
            REFERENCED_TABLE_NAME AS refTableName,
            REFERENCED_COLUMN_NAME AS refColumnName
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  const rcRows = await db.query<{
    constraintName: string;
    tableName: string;
    updateRule: string;
    deleteRule: string;
  }>(
    `SELECT CONSTRAINT_NAME AS constraintName,
            TABLE_NAME AS tableName,
            UPDATE_RULE AS updateRule,
            DELETE_RULE AS deleteRule
       FROM information_schema.REFERENTIAL_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  const ccRows = await db.query<{
    constraintName: string;
    checkClause: string;
  }>(
    `SELECT CONSTRAINT_NAME AS constraintName,
            CHECK_CLAUSE AS checkClause
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()`,
  );

  const kcuMap = new Map<string, typeof kcuRows>();
  for (const r of kcuRows) {
    const key = `${r.tableName}\0${r.constraintName}`;
    const list = kcuMap.get(key) ?? [];
    list.push(r);
    kcuMap.set(key, list);
  }
  const rcMap = new Map<string, (typeof rcRows)[number]>();
  for (const r of rcRows) rcMap.set(`${r.tableName}\0${r.constraintName}`, r);
  const ccMap = new Map<string, string>();
  for (const r of ccRows) ccMap.set(r.constraintName, r.checkClause);

  // 先读 STATISTICS 以便区分纯 UNIQUE 约束与带前缀/降序/表达式/注释/HASH 的 UNIQUE INDEX
  const statRows = await db.query<{
    tableName: string;
    nonUnique: number | string;
    indexName: string;
    seqInIndex: number | string;
    columnName: string | null;
    collation: string | null;
    subPart: number | string | null;
    indexType: string | null;
    indexComment: string | null;
    expression: string | null;
  }>(
    `SELECT TABLE_NAME AS tableName,
            NON_UNIQUE AS nonUnique,
            INDEX_NAME AS indexName,
            SEQ_IN_INDEX AS seqInIndex,
            COLUMN_NAME AS columnName,
            COLLATION AS collation,
            SUB_PART AS subPart,
            INDEX_TYPE AS indexType,
            INDEX_COMMENT AS indexComment,
            EXPRESSION AS expression
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND TABLE_NAME <> ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [MYSQL_SHADOW_MARK_TABLE],
  );

  const statsByTableAndIdx = new Map<string, typeof statRows>();
  for (const s of statRows) {
    const key = `${s.tableName}\0${s.indexName}`;
    const list = statsByTableAndIdx.get(key) ?? [];
    list.push(s);
    statsByTableAndIdx.set(key, list);
  }

  /** 判断一个 UNIQUE 索引是否可表示为纯 UNIQUE 约束（BTREE、无前缀长度、无表达式、无 DESC、无注释） */
  const isPlainUniqueConstraint = (tableName: string, indexName: string): boolean => {
    const rows = statsByTableAndIdx.get(`${tableName}\0${indexName}`);
    if (!rows || rows.length === 0) return true;
    const first = rows[0]!;
    if (normalizeIndexType(first.indexType) !== 'BTREE') return false;
    if (first.indexComment) return false;
    return rows.every(
      (r) =>
        r.columnName !== null &&
        r.expression === null &&
        (r.subPart === null || r.subPart === undefined) &&
        r.collation !== 'D',
    );
  };

  const uniqueConstraintKeys = new Set<string>();
  for (const tc of tcRows) {
    const tbl = tables[tc.tableName];
    if (!tbl) continue;
    const key = `${tc.tableName}\0${tc.constraintName}`;
    const cols = kcuMap.get(key) ?? [];

    if (tc.constraintType === 'PRIMARY KEY') {
      tbl.primaryKey = { columns: cols.map((c) => c.columnName) };
    } else if (tc.constraintType === 'UNIQUE') {
      if (isPlainUniqueConstraint(tc.tableName, tc.constraintName)) {
        tbl.uniques[tc.constraintName] = {
          name: tc.constraintName,
          columns: cols.map((c) => c.columnName),
        };
        uniqueConstraintKeys.add(key);
      }
    } else if (tc.constraintType === 'FOREIGN KEY') {
      const rc = rcMap.get(key);
      if (cols.length > 0 && cols[0]!.refTableName) {
        tbl.foreignKeys[tc.constraintName] = {
          name: tc.constraintName,
          columns: cols.map((c) => c.columnName),
          refTable: cols[0]!.refTableName,
          refColumns: cols.map((c) => c.refColumnName!),
          onDelete: FK_ACTION_MAP[(rc?.deleteRule ?? 'NO ACTION').toUpperCase()] ?? 'noAction',
          onUpdate: FK_ACTION_MAP[(rc?.updateRule ?? 'NO ACTION').toUpperCase()] ?? 'noAction',
        };
      }
    } else if (tc.constraintType === 'CHECK') {
      const clause = ccMap.get(tc.constraintName);
      if (clause !== undefined) {
        tbl.checks[tc.constraintName] = {
          name: tc.constraintName,
          expr: stripSingleOuterParens(clause),
        };
      }
    }
  }

  // 3. 二级索引（排除 PRIMARY、纯 UNIQUE 约束与与 computeImplicitFkOwners 对称的 InnoDB 隐式 FK 辅助索引）
  interface CandidateIndex {
    indexName: string;
    unique: boolean;
    indexType: MysqlIdxSnap['indexType'];
    elements: MysqlIdxElemSnap[];
    comment: string | null;
    matchesFkName: string | null;
  }
  const candidatesByTable = new Map<string, CandidateIndex[]>();
  for (const [key, rows] of statsByTableAndIdx) {
    const first = rows[0]!;
    const tbl = tables[first.tableName];
    if (!tbl) continue;
    if (first.indexName.toUpperCase() === 'PRIMARY') continue;
    if (uniqueConstraintKeys.has(key)) continue;

    const unique = Number(first.nonUnique) === 0;
    const indexType = normalizeIndexType(first.indexType);
    const comment = first.indexComment ? first.indexComment : null;
    const elements: MysqlIdxElemSnap[] = rows.map((r) => ({
      column: r.expression ? null : r.columnName,
      expr: r.expression ? r.expression.trim() : null,
      length: r.subPart !== null && r.subPart !== undefined ? Number(r.subPart) : null,
      desc: r.collation === 'D',
    }));

    let matchesFkName: string | null = null;
    if (
      !unique &&
      indexType === 'BTREE' &&
      !comment &&
      elements.every((e) => e.column !== null && e.expr === null && e.length === null && !e.desc)
    ) {
      const idxCols = elements.map((e) => e.column!);
      const matched = Object.values(tbl.foreignKeys).find(
        (fk) =>
          fk.name.toLowerCase() === first.indexName.toLowerCase() &&
          fk.columns.length === idxCols.length &&
          fk.columns.every((c, i) => c.toLowerCase() === idxCols[i]!.toLowerCase()),
      );
      if (matched) matchesFkName = matched.name.toLowerCase();
    }

    const list = candidatesByTable.get(first.tableName) ?? [];
    list.push({ indexName: first.indexName, unique, indexType, elements, comment, matchesFkName });
    candidatesByTable.set(first.tableName, list);
  }

  const snapPrefixMatches = (keyCols: readonly string[], fkCols: readonly string[]): boolean => {
    if (keyCols.length < fkCols.length) return false;
    for (let i = 0; i < fkCols.length; i++) {
      if (keyCols[i]!.toLowerCase() !== fkCols[i]!.toLowerCase()) return false;
    }
    return true;
  };

  for (const [tableName, candidates] of candidatesByTable) {
    const tbl = tables[tableName]!;
    // 先收集所有明确为显式的覆盖键前缀（PK / UNIQUE / 不与 FK 同名的合法二级索引）
    const covering: string[][] = [];
    if (tbl.primaryKey) covering.push(tbl.primaryKey.columns);
    for (const u of Object.values(tbl.uniques)) covering.push(u.columns);
    for (const cand of candidates) {
      if (cand.matchesFkName !== null) continue;
      if (cand.indexType === 'FULLTEXT' || cand.indexType === 'SPATIAL') continue;
      const cols: string[] = [];
      for (const el of cand.elements) {
        if (!el.column || el.expr !== null || (el.length && el.length > 0)) break;
        cols.push(el.column);
      }
      if (cols.length > 0) covering.push(cols);
    }

    // 与 computeImplicitFkOwners 严格对称：按 fk.name 升序计算哪些 FK 应当拥有隐式索引
    const expectedImplicitFkNames = new Set<string>();
    const sortedFks = Object.values(tbl.foreignKeys).sort((a, b) => a.name.localeCompare(b.name));
    for (const fk of sortedFks) {
      if (!covering.some((k) => snapPrefixMatches(k, fk.columns))) {
        expectedImplicitFkNames.add(fk.name.toLowerCase());
        covering.push(fk.columns);
      }
    }

    for (const cand of candidates) {
      if (cand.matchesFkName !== null && expectedImplicitFkNames.has(cand.matchesFkName)) {
        continue;
      }
      tbl.indexes[cand.indexName] = {
        unique: cand.unique,
        indexType: cand.indexType,
        elements: cand.elements,
        comment: cand.comment,
      };
    }
  }

  // 4. 不透明对象（视图、触发器、函数、存储过程）
  const opaques: Record<string, MysqlOpaqueSnap> = {};
  let opaqueOrder = 0;

  // 4a. 函数与存储过程
  const routineRows = await db.query<{ routineName: string; routineType: string }>(
    `SELECT ROUTINE_NAME AS routineName, ROUTINE_TYPE AS routineType
       FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = DATABASE()
        AND ROUTINE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
      ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
  );
  for (const r of routineRows) {
    const isFunc = r.routineType.toUpperCase() === 'FUNCTION';
    const objType = isFunc ? 'function' : 'procedure';
    const [show] = await db.query<Record<string, unknown>>(
      `SHOW CREATE ${isFunc ? 'FUNCTION' : 'PROCEDURE'} ${mysqlIdent(r.routineName)}`,
    );
    const ddl = show ? fieldIgnoreCase(show, isFunc ? 'Create Function' : 'Create Procedure') : null;
    if (!ddl) continue;
    opaques[`${objType}:${r.routineName}`] = {
      objType,
      name: r.routineName,
      tblName: null,
      ddl: stripDefiner(ddl),
      drop: `DROP ${isFunc ? 'FUNCTION' : 'PROCEDURE'} ${mysqlIdent(r.routineName)}`,
      order: ++opaqueOrder,
    };
  }

  // 4b. 视图
  const viewRows = await db.query<{ viewName: string }>(
    `SELECT TABLE_NAME AS viewName
       FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
      ORDER BY TABLE_NAME`,
  );
  for (const v of viewRows) {
    const [show] = await db.query<Record<string, unknown>>(`SHOW CREATE VIEW ${mysqlIdent(v.viewName)}`);
    const ddl = show ? fieldIgnoreCase(show, 'Create View') : null;
    if (!ddl) continue;
    opaques[`view:${v.viewName}`] = {
      objType: 'view',
      name: v.viewName,
      tblName: null,
      ddl: stripDefiner(ddl),
      drop: `DROP VIEW ${mysqlIdent(v.viewName)}`,
      order: ++opaqueOrder,
    };
  }

  // 4c. 触发器
  const triggerRows = await db.query<{ triggerName: string; eventTable: string }>(
    `SELECT TRIGGER_NAME AS triggerName, EVENT_OBJECT_TABLE AS eventTable
       FROM information_schema.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME NOT LIKE 'dowel!_%' ESCAPE '!'
        AND EVENT_OBJECT_TABLE NOT LIKE 'dowel!_%' ESCAPE '!'
        AND EVENT_OBJECT_TABLE <> ?
      ORDER BY TRIGGER_NAME`,
    [MYSQL_SHADOW_MARK_TABLE],
  );
  for (const tr of triggerRows) {
    const [show] = await db.query<Record<string, unknown>>(
      `SHOW CREATE TRIGGER ${mysqlIdent(tr.triggerName)}`,
    );
    const ddl = show ? fieldIgnoreCase(show, 'SQL Original Statement') : null;
    if (!ddl) continue;
    opaques[`trigger:${tr.triggerName}`] = {
      objType: 'trigger',
      name: tr.triggerName,
      tblName: tr.eventTable,
      ddl: stripDefiner(ddl),
      drop: `DROP TRIGGER ${mysqlIdent(tr.triggerName)}`,
      order: ++opaqueOrder,
    };
  }

  return { version, versionNum, defaultCharset, defaultCollation, tables, opaques };
};

/** 规范化 MySQL 快照：忽略版本号、列物理顺序 ordinalPosition 与表级 AUTO_INCREMENT 计数器 */
export const normalizeMysqlSnapshot = (snap: MysqlSnapshot): unknown => {
  const normTables: Record<string, unknown> = {};
  for (const [tname, t] of Object.entries(snap.tables).sort(([a], [b]) => a.localeCompare(b))) {
    const cols: Record<string, unknown> = {};
    for (const [cname, c] of Object.entries(t.columns).sort(([a], [b]) => a.localeCompare(b))) {
      cols[cname] = {
        type: c.type,
        unsigned: c.unsigned,
        zerofill: c.zerofill,
        notNull: c.notNull,
        default: c.default,
        generated: c.generated,
        charset: c.charset,
        collation: c.collation,
        autoIncrement: c.autoIncrement,
        onUpdateCurrentTimestamp: c.onUpdateCurrentTimestamp,
        comment: c.comment,
      };
    }
    const sortRecord = <V>(rec: Record<string, V>) =>
      Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
    normTables[tname] = {
      name: t.name,
      engine: t.engine.toLowerCase(),
      charset: t.charset.toLowerCase(),
      collation: t.collation.toLowerCase(),
      comment: t.comment,
      columns: cols,
      primaryKey: t.primaryKey,
      uniques: sortRecord(t.uniques),
      checks: sortRecord(t.checks),
      foreignKeys: sortRecord(t.foreignKeys),
      indexes: sortRecord(t.indexes),
    };
  }
  const normOpaques: Record<string, unknown> = {};
  for (const [k, o] of Object.entries(snap.opaques).sort(([a], [b]) => a.localeCompare(b))) {
    normOpaques[k] = {
      objType: o.objType,
      name: o.name,
      tblName: o.tblName,
      ddl: o.ddl,
      drop: o.drop,
    };
  }
  return { tables: normTables, opaques: normOpaques };
};

/** 比较两份 MySQL 快照的结构差异（空数组表示完全一致） */
export const diffMysqlSnapshots = (a: MysqlSnapshot, b: MysqlSnapshot): string[] => {
  const diffs: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (deepEqual(x, y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      const keys = new Set([...Object.keys(xo), ...Object.keys(yo)]);
      for (const k of [...keys].sort()) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in xo)) diffs.push(`缺少 ${p}: ${JSON.stringify(yo[k])}`);
        else if (!(k in yo)) diffs.push(`多出 ${p}: ${JSON.stringify(xo[k])}`);
        else walk(xo[k], yo[k], p);
      }
      return;
    }
    diffs.push(`${path} 不同:\n  实际: ${JSON.stringify(x)}\n  期望: ${JSON.stringify(y)}`);
  };
  walk(normalizeMysqlSnapshot(a), normalizeMysqlSnapshot(b), '');
  return diffs;
};

export const mysqlFingerprint = (snap: MysqlSnapshot): string =>
  createHash('sha256')
    .update(stableJson(normalizeMysqlSnapshot(snap)))
    .digest('hex');
