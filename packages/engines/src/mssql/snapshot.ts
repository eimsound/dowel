// 从 SQL Server 系统目录（sys.*）读出完整结构快照，支持多 schema 过滤、跨范围依赖校验、规范化与指纹比对。
// 兼容 SQL Server 2019 (15) / 2022 (16) / 2025 (17，含原生 json 与 vector(n))。
import { createHash } from 'node:crypto';

import {
  deepEqual,
  mssqlIdent,
  mssqlLiteral,
  mssqlNormalizeType,
  mssqlQualified,
  stableJson,
} from '@dowel/core';

import { ScopeError, type ScopeViolation } from '../pg/scope.ts';
import type { Db } from '../types.ts';
import { pinMssqlSession } from './db.ts';

export const MSSQL_DOWEL_SCHEMA = 'dowel';

export interface MssqlColSnap {
  columnId: number;
  type: string;
  notNull: boolean;
  default: string | null;
  defaultName: string | null;
  identity: { seed: string; increment: string } | null;
  generated: { expr: string; stored: boolean } | null;
  collation: string | null;
  sparse: boolean;
  rowguidcol: boolean;
  comment: string | null;
}

export interface MssqlConSnap {
  type: 'PK' | 'UQ' | 'FK' | 'CK';
  columns: string[];
  clustered: boolean;
  refTable: string | null;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  expr: string | null;
  comment: string | null;
}

export interface MssqlIdxElemSnap {
  column: string;
  desc: boolean;
}

export interface MssqlIdxSnap {
  unique: boolean;
  clustered: boolean;
  elements: MssqlIdxElemSnap[];
  include: string[];
  where: string | null;
  fillFactor: number | null;
  comment: string | null;
}

export interface MssqlTableSnap {
  schema: string;
  name: string;
  comment: string | null;
  columns: Record<string, MssqlColSnap>;
  constraints: Record<string, MssqlConSnap>;
  indexes: Record<string, MssqlIdxSnap>;
}

export interface MssqlSeqSnap {
  schema: string;
  name: string;
  type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
  comment: string | null;
}

export interface MssqlOpaqueSnap {
  objType: 'view' | 'trigger' | 'function' | 'procedure';
  schema: string;
  table: string | null;
  name: string;
  ddl: string[];
  drop: string;
  deps: string[];
  order: number;
}

export interface MssqlSnapshot {
  version: string;
  versionNum: number;
  major: number;
  schemas: Record<string, { comment: string | null }>;
  sequences: Record<string, MssqlSeqSnap>;
  tables: Record<string, MssqlTableSnap>;
  opaques: Record<string, MssqlOpaqueSnap>;
}

const FK_ACTION_MAP: Record<string, string> = {
  NO_ACTION: 'noAction',
  CASCADE: 'cascade',
  SET_NULL: 'setNull',
  SET_DEFAULT: 'setDefault',
};

const key = (schema: string, name: string) => `${schema}.${name}`;

const SYSTEM_SCHEMA_FILTER = `s.schema_id < 16384 AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc', N'${MSSQL_DOWEL_SCHEMA}') AND s.name NOT LIKE N'db[_]%'`;

const schemaFilter = (only?: string[] | null): string => {
  if (!only?.length) return SYSTEM_SCHEMA_FILTER;
  const list = only.map((n) => mssqlLiteral(n)).join(', ');
  return `${SYSTEM_SCHEMA_FILTER} AND s.name IN (${list})`;
};

/** 按 sys.columns + sys.types 的元数据反解标准 MSSQL 类型文本（兼容 2019/2022/2025 的 json 与 vector(n)） */
export const formatMssqlColType = (
  typeName: string,
  maxLength: number,
  precision: number,
  scale: number,
): string => {
  const low = typeName.toLowerCase();
  if (low === 'nvarchar' || low === 'nchar') {
    if (maxLength === -1) return `${low}(max)`;
    return `${low}(${Math.floor(maxLength / 2)})`;
  }
  if (low === 'varchar' || low === 'char' || low === 'varbinary' || low === 'binary') {
    if (maxLength === -1) return `${low}(max)`;
    return `${low}(${maxLength})`;
  }
  if (low === 'decimal' || low === 'numeric') {
    return `${low}(${precision},${scale})`;
  }
  if (low === 'time' || low === 'datetime2' || low === 'datetimeoffset') {
    return `${low}(${scale})`;
  }
  if (low === 'float') {
    return precision <= 24 ? 'real' : 'float';
  }
  if (low === 'json') return 'json';
  if (low === 'vector') {
    // SQL Server 2025 vector(n) 存储布局：8 字节头 + 4 * n 字节 float32
    const dims = maxLength >= 12 ? Math.floor((maxLength - 8) / 4) : 0;
    return dims > 0 ? `vector(${dims})` : 'vector';
  }
  return mssqlNormalizeType(low);
};

/** 检查多 schema 范围导入时是否存在指向范围外非系统对象的引用 */
const checkMssqlScope = async (db: Db, scope: string[]): Promise<void> => {
  if (!scope.length) return;
  const inScope = scope.map((s) => mssqlLiteral(s)).join(', ');
  const violations: ScopeViolation[] = [];
  const seen = new Set<string>();

  const fkRows = await db.query<{
    srcSchema: string;
    srcTable: string;
    fkName: string;
    refSchema: string;
    refTable: string;
  }>(
    `SELECT ss.name AS srcSchema, st.name AS srcTable, fk.name AS fkName,
            rs.name AS refSchema, rt.name AS refTable
       FROM sys.foreign_keys fk
       JOIN sys.tables st ON st.object_id = fk.parent_object_id
       JOIN sys.schemas ss ON ss.schema_id = st.schema_id
       JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
       JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      WHERE ss.name IN (${inScope})
        AND rs.name NOT IN (${inScope})`,
  );
  for (const r of fkRows) {
    const msg = `表 ${r.srcSchema}.${r.srcTable} 的外键 ${r.fkName} 引用了表 ${r.refSchema}.${r.refTable}`;
    if (!seen.has(msg)) {
      seen.add(msg);
      violations.push({ message: msg, schema: r.refSchema });
    }
  }

  const depRows = await db.query<{
    srcSchema: string;
    srcName: string;
    srcType: string;
    refSchema: string;
    refName: string;
  }>(
    `SELECT DISTINCT ss.name AS srcSchema, so.name AS srcName, so.type AS srcType,
            rs.name AS refSchema, ro.name AS refName
       FROM sys.sql_expression_dependencies d
       JOIN sys.objects so ON so.object_id = d.referencing_id
       JOIN sys.schemas ss ON ss.schema_id = so.schema_id
       JOIN sys.objects ro ON ro.object_id = d.referenced_id
       JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
      WHERE so.is_ms_shipped = 0 AND ro.is_ms_shipped = 0
        AND ss.name IN (${inScope})
        AND rs.name NOT IN (${inScope})
        AND rs.name NOT IN (N'sys', N'INFORMATION_SCHEMA')`,
  );
  for (const r of depRows) {
    const msg = `${r.srcType.trim()} ${r.srcSchema}.${r.srcName} 引用了 ${r.refSchema}.${r.refName}`;
    if (!seen.has(msg)) {
      seen.add(msg);
      violations.push({ message: msg, schema: r.refSchema });
    }
  }

  if (violations.length > 0) throw new ScopeError(violations, scope);
};

export const readMssqlSnapshot = async (db: Db, only?: string[] | null): Promise<MssqlSnapshot> => {
  await pinMssqlSession(db);
  const sf = schemaFilter(only);

  const [verRow] = await db.query<{
    version: string;
    major: number;
    minor: number;
    dbCollation: string | null;
  }>(
    `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,
            CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
            CAST(SERVERPROPERTY('ProductMinorVersion') AS int) AS minor,
            CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)) AS dbCollation`,
  );
  const version = String(verRow?.version ?? '16.0.0.0');
  const major = Number(verRow?.major ?? 16);
  const minor = Number(verRow?.minor ?? 0);
  const versionNum = major * 10000 + minor;
  const dbCollation = verRow?.dbCollation ?? null;

  const snap: MssqlSnapshot = {
    version,
    versionNum,
    major,
    schemas: {},
    sequences: {},
    tables: {},
    opaques: {},
  };

  // 1. Schemas
  const schemaRows = await db.query<{ name: string; comment: string | null }>(
    `SELECT s.name, CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.schemas s
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 3 AND ep.major_id = s.schema_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE ${sf}
      ORDER BY s.name`,
  );
  for (const r of schemaRows) {
    snap.schemas[r.name] = { comment: r.comment ?? null };
  }

  // 2. Sequences
  const seqById = new Map<number, string>();
  const seqRows = await db.query<{
    objectId: number;
    schema: string;
    name: string;
    typeName: string;
    startVal: string;
    incVal: string;
    minVal: string;
    maxVal: string;
    isCached: boolean;
    cacheSize: string | null;
    isCycling: boolean;
    comment: string | null;
  }>(
    `SELECT q.object_id AS objectId, s.name AS [schema], q.name,
            ty.name AS typeName,
            CAST(q.start_value AS nvarchar(64)) AS startVal,
            CAST(q.increment AS nvarchar(64)) AS incVal,
            CAST(q.minimum_value AS nvarchar(64)) AS minVal,
            CAST(q.maximum_value AS nvarchar(64)) AS maxVal,
            q.is_cached AS isCached,
            CAST(q.cache_size AS nvarchar(64)) AS cacheSize,
            q.is_cycling AS isCycling,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.sequences q
       JOIN sys.schemas s ON s.schema_id = q.schema_id
       JOIN sys.types ty ON ty.user_type_id = q.user_type_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = q.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE q.is_ms_shipped = 0 AND ${sf}
      ORDER BY s.name, q.name`,
  );
  for (const r of seqRows) {
    const k = key(r.schema, r.name);
    seqById.set(Number(r.objectId), k);
    const tLow = r.typeName.toLowerCase();
    const seqType = tLow === 'int' ? 'integer' : tLow === 'smallint' ? 'smallint' : 'bigint';
    const cache = !r.isCached ? '0' : r.cacheSize !== null ? String(r.cacheSize) : '1';
    snap.sequences[k] = {
      schema: r.schema,
      name: r.name,
      type: seqType,
      start: String(r.startVal),
      increment: String(r.incVal),
      min: String(r.minVal),
      max: String(r.maxVal),
      cache,
      cycle: Boolean(r.isCycling),
      comment: r.comment ?? null,
    };
  }

  // 3. Tables
  const tableById = new Map<number, MssqlTableSnap>();
  const tableRows = await db.query<{
    objectId: number;
    schema: string;
    name: string;
    comment: string | null;
  }>(
    `SELECT t.object_id AS objectId, s.name AS [schema], t.name,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
      ORDER BY s.name, t.name`,
  );
  for (const r of tableRows) {
    const tbl: MssqlTableSnap = {
      schema: r.schema,
      name: r.name,
      comment: r.comment ?? null,
      columns: {},
      constraints: {},
      indexes: {},
    };
    snap.tables[key(r.schema, r.name)] = tbl;
    tableById.set(Number(r.objectId), tbl);
  }

  // 4. Columns
  const colNameById = new Map<string, string>(); // `${objectId}:${columnId}` -> colName
  const colRows = await db.query<{
    objectId: number;
    columnId: number;
    name: string;
    typeName: string;
    maxLength: number;
    precision: number;
    scale: number;
    isNullable: boolean;
    collationName: string | null;
    isSparse: boolean;
    isRowguidcol: boolean;
    isIdentity: boolean;
    seedValue: string | null;
    incrementValue: string | null;
    defaultName: string | null;
    defaultDef: string | null;
    isComputed: boolean;
    computedDef: string | null;
    isPersisted: boolean | null;
    comment: string | null;
  }>(
    `SELECT c.object_id AS objectId, c.column_id AS columnId, c.name,
            ty.name AS typeName, c.max_length AS maxLength, c.precision, c.scale,
            c.is_nullable AS isNullable, c.collation_name AS collationName,
            c.is_sparse AS isSparse, c.is_rowguidcol AS isRowguidcol,
            c.is_identity AS isIdentity,
            CAST(ic.seed_value AS nvarchar(64)) AS seedValue,
            CAST(ic.increment_value AS nvarchar(64)) AS incrementValue,
            dc.name AS defaultName, dc.definition AS defaultDef,
            c.is_computed AS isComputed, cc.definition AS computedDef, cc.is_persisted AS isPersisted,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.columns c
       JOIN sys.tables t ON t.object_id = c.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
       LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
       LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
      ORDER BY c.object_id, c.column_id`,
  );
  for (const r of colRows) {
    const objId = Number(r.objectId);
    const tbl = tableById.get(objId);
    if (!tbl) continue;
    colNameById.set(`${objId}:${Number(r.columnId)}`, r.name);
    const collation =
      r.collationName && dbCollation && r.collationName.toLowerCase() !== dbCollation.toLowerCase()
        ? r.collationName
        : null;
    tbl.columns[r.name] = {
      columnId: Number(r.columnId),
      type: formatMssqlColType(r.typeName, Number(r.maxLength), Number(r.precision), Number(r.scale)),
      notNull: !r.isNullable,
      default: r.isComputed ? null : (r.defaultDef ?? null),
      defaultName: r.isComputed ? null : (r.defaultName ?? null),
      identity: r.isIdentity
        ? { seed: String(r.seedValue ?? '1'), increment: String(r.incrementValue ?? '1') }
        : null,
      generated: r.isComputed ? { expr: String(r.computedDef ?? ''), stored: Boolean(r.isPersisted) } : null,
      collation,
      sparse: Boolean(r.isSparse),
      rowguidcol: Boolean(r.isRowguidcol),
      comment: r.comment ?? null,
    };
  }

  // 5. Key constraints (PK / UQ)
  const kcRows = await db.query<{
    objectId: number;
    parentObjectId: number;
    name: string;
    type: string;
    indexType: number;
    columnId: number;
    keyOrdinal: number;
    comment: string | null;
  }>(
    `SELECT kc.object_id AS objectId, kc.parent_object_id AS parentObjectId, kc.name,
            kc.type, ix.type AS indexType,
            ixc.column_id AS columnId, ixc.key_ordinal AS keyOrdinal,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.key_constraints kc
       JOIN sys.tables t ON t.object_id = kc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.indexes ix ON ix.object_id = kc.parent_object_id AND ix.index_id = kc.unique_index_id
       JOIN sys.index_columns ixc ON ixc.object_id = ix.object_id AND ixc.index_id = ix.index_id AND ixc.is_included_column = 0
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = kc.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
      ORDER BY kc.parent_object_id, kc.name, ixc.key_ordinal`,
  );
  for (const r of kcRows) {
    const tbl = tableById.get(Number(r.parentObjectId));
    if (!tbl) continue;
    const col = colNameById.get(`${Number(r.parentObjectId)}:${Number(r.columnId)}`);
    if (!col) continue;
    const existing = tbl.constraints[r.name];
    if (existing) {
      existing.columns.push(col);
    } else {
      tbl.constraints[r.name] = {
        type: r.type.trim() === 'PK' ? 'PK' : 'UQ',
        columns: [col],
        clustered: Number(r.indexType) === 1,
        refTable: null,
        refColumns: [],
        onDelete: '',
        onUpdate: '',
        expr: null,
        comment: r.comment ?? null,
      };
    }
  }

  // 6. Foreign keys
  const fkRows = await db.query<{
    parentObjectId: number;
    refObjectId: number;
    name: string;
    deleteAction: string;
    updateAction: string;
    parentColumnId: number;
    refColumnId: number;
    ordinal: number;
    comment: string | null;
  }>(
    `SELECT fk.parent_object_id AS parentObjectId, fk.referenced_object_id AS refObjectId,
            fk.name, fk.delete_referential_action_desc AS deleteAction,
            fk.update_referential_action_desc AS updateAction,
            fkc.parent_column_id AS parentColumnId, fkc.referenced_column_id AS refColumnId,
            fkc.constraint_column_id AS ordinal,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.foreign_keys fk
       JOIN sys.tables t ON t.object_id = fk.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = fk.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
      ORDER BY fk.parent_object_id, fk.name, fkc.constraint_column_id`,
  );
  for (const r of fkRows) {
    const tbl = tableById.get(Number(r.parentObjectId));
    const refTbl = tableById.get(Number(r.refObjectId));
    if (!tbl || !refTbl) continue;
    const col = colNameById.get(`${Number(r.parentObjectId)}:${Number(r.parentColumnId)}`);
    const refCol = colNameById.get(`${Number(r.refObjectId)}:${Number(r.refColumnId)}`);
    if (!col || !refCol) continue;
    const existing = tbl.constraints[r.name];
    if (existing) {
      existing.columns.push(col);
      existing.refColumns.push(refCol);
    } else {
      tbl.constraints[r.name] = {
        type: 'FK',
        columns: [col],
        clustered: false,
        refTable: key(refTbl.schema, refTbl.name),
        refColumns: [refCol],
        onDelete: FK_ACTION_MAP[r.deleteAction] ?? 'noAction',
        onUpdate: FK_ACTION_MAP[r.updateAction] ?? 'noAction',
        expr: null,
        comment: r.comment ?? null,
      };
    }
  }

  // 7. Check constraints
  const ckRows = await db.query<{
    parentObjectId: number;
    name: string;
    definition: string;
    comment: string | null;
  }>(
    `SELECT ck.parent_object_id AS parentObjectId, ck.name, ck.definition,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.check_constraints ck
       JOIN sys.tables t ON t.object_id = ck.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 1 AND ep.major_id = ck.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
      ORDER BY ck.parent_object_id, ck.name`,
  );
  for (const r of ckRows) {
    const tbl = tableById.get(Number(r.parentObjectId));
    if (!tbl) continue;
    tbl.constraints[r.name] = {
      type: 'CK',
      columns: [],
      clustered: false,
      refTable: null,
      refColumns: [],
      onDelete: '',
      onUpdate: '',
      expr: r.definition,
      comment: r.comment ?? null,
    };
  }

  // 8. Standalone Indexes (non-PK, non-UQ)
  const ixRows = await db.query<{
    objectId: number;
    indexId: number;
    name: string;
    indexType: number;
    isUnique: boolean;
    fillFactor: number;
    filterDef: string | null;
    columnId: number;
    keyOrdinal: number;
    indexColumnId: number;
    isIncluded: boolean;
    isDesc: boolean;
    comment: string | null;
  }>(
    `SELECT ix.object_id AS objectId, ix.index_id AS indexId, ix.name,
            ix.type AS indexType, ix.is_unique AS isUnique, ix.fill_factor AS fillFactor,
            ix.filter_definition AS filterDef,
            ixc.column_id AS columnId, ixc.key_ordinal AS keyOrdinal,
            ixc.index_column_id AS indexColumnId, ixc.is_included_column AS isIncluded,
            ixc.is_descending_key AS isDesc,
            CAST(ep.value AS nvarchar(max)) AS comment
       FROM sys.indexes ix
       JOIN sys.tables t ON t.object_id = ix.object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       JOIN sys.index_columns ixc ON ixc.object_id = ix.object_id AND ixc.index_id = ix.index_id
       LEFT JOIN sys.extended_properties ep
         ON ep.class = 7 AND ep.major_id = ix.object_id AND ep.minor_id = ix.index_id AND ep.name = N'MS_Description'
      WHERE t.is_ms_shipped = 0 AND ${sf}
        AND ix.type IN (1, 2)
        AND ix.is_primary_key = 0
        AND ix.is_unique_constraint = 0
        AND ix.name IS NOT NULL
      ORDER BY ix.object_id, ix.name, ixc.is_included_column, ixc.key_ordinal, ixc.index_column_id`,
  );
  for (const r of ixRows) {
    const tbl = tableById.get(Number(r.objectId));
    if (!tbl) continue;
    const col = colNameById.get(`${Number(r.objectId)}:${Number(r.columnId)}`);
    if (!col) continue;
    let ix = tbl.indexes[r.name];
    if (!ix) {
      const ff = Number(r.fillFactor);
      ix = {
        unique: Boolean(r.isUnique),
        clustered: Number(r.indexType) === 1,
        elements: [],
        include: [],
        where: r.filterDef ?? null,
        fillFactor: ff > 0 ? ff : null,
        comment: r.comment ?? null,
      };
      tbl.indexes[r.name] = ix;
    }
    if (r.isIncluded) {
      ix.include.push(col);
    } else {
      ix.elements.push({ column: col, desc: Boolean(r.isDesc) });
    }
  }

  // 9. Opaque objects (views, triggers, functions, procedures)
  const opaqueById = new Map<number, string>();
  const opaqueRows = await db.query<{
    objectId: number;
    parentObjectId: number;
    schema: string;
    name: string;
    type: string;
    definition: string | null;
  }>(
    `SELECT o.object_id AS objectId, o.parent_object_id AS parentObjectId,
            s.name AS [schema], o.name, o.type, sm.definition
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.sql_modules sm ON sm.object_id = o.object_id
      WHERE o.is_ms_shipped = 0 AND ${sf}
        AND o.type IN ('V', 'TR', 'FN', 'IF', 'TF', 'P')
      ORDER BY o.create_date, o.object_id`,
  );
  let order = 0;
  for (const r of opaqueRows) {
    if (!r.definition) continue;
    const tCode = r.type.trim();
    const objType: MssqlOpaqueSnap['objType'] =
      tCode === 'V' ? 'view' : tCode === 'TR' ? 'trigger' : tCode === 'P' ? 'procedure' : 'function';
    const parentTbl = objType === 'trigger' ? tableById.get(Number(r.parentObjectId)) : undefined;
    const opKey = `${objType}:${r.schema}.${r.name}`;
    opaqueById.set(Number(r.objectId), opKey);
    const dropKind =
      objType === 'view'
        ? 'VIEW'
        : objType === 'trigger'
          ? 'TRIGGER'
          : objType === 'procedure'
            ? 'PROCEDURE'
            : 'FUNCTION';
    snap.opaques[opKey] = {
      objType,
      schema: r.schema,
      table: parentTbl ? key(parentTbl.schema, parentTbl.name) : null,
      name: r.name,
      ddl: [r.definition.trim()],
      drop: `DROP ${dropKind} ${mssqlQualified(r.schema, r.name)}`,
      deps: parentTbl ? [`table:${key(parentTbl.schema, parentTbl.name)}`] : [],
      order: ++order,
    };
  }

  if (opaqueById.size > 0) {
    const depRows = await db.query<{
      referencingId: number;
      referencedId: number;
      referencedMinorId: number;
    }>(
      `SELECT d.referencing_id AS referencingId, d.referenced_id AS referencedId,
              d.referenced_minor_id AS referencedMinorId
         FROM sys.sql_expression_dependencies d
         JOIN sys.objects o ON o.object_id = d.referencing_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id
        WHERE o.is_ms_shipped = 0 AND ${sf} AND d.referenced_id IS NOT NULL`,
    );
    for (const d of depRows) {
      const opKey = opaqueById.get(Number(d.referencingId));
      if (!opKey) continue;
      const op = snap.opaques[opKey]!;
      const refId = Number(d.referencedId);
      const minorId = Number(d.referencedMinorId);
      let refStr: string | null = null;
      const rt = tableById.get(refId);
      if (rt) {
        if (minorId > 0) {
          const cn = colNameById.get(`${refId}:${minorId}`);
          if (cn) refStr = `column:${key(rt.schema, rt.name)}\u0000${cn}`;
        } else {
          refStr = `table:${key(rt.schema, rt.name)}`;
        }
      } else if (seqById.has(refId)) {
        refStr = `sequence:${seqById.get(refId)!}`;
      } else if (opaqueById.has(refId) && opaqueById.get(refId) !== opKey) {
        refStr = `opaque:${opaqueById.get(refId)!}`;
      }
      if (refStr && !op.deps.includes(refStr)) op.deps.push(refStr);
    }
    for (const op of Object.values(snap.opaques)) op.deps.sort();
  }

  if (only?.length) await checkMssqlScope(db, only);
  return snap;
};

/** 规范化 MSSQL 快照：剔除 version / versionNum / major / columnId / order，按键递归排序 */
export const normalizeMssqlSnapshot = (snap: MssqlSnapshot): unknown => {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x)
          .filter(
            (k) =>
              k !== 'version' && k !== 'versionNum' && k !== 'major' && k !== 'columnId' && k !== 'order',
          )
          .sort()
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return sort(snap);
};

export const diffMssqlSnapshots = (a: MssqlSnapshot, b: MssqlSnapshot): string[] => {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (deepEqual(x, y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const xo = x as Record<string, unknown>;
      const yo = y as Record<string, unknown>;
      const keys = new Set([...Object.keys(xo), ...Object.keys(yo)]);
      for (const k of [...keys].sort()) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in xo)) out.push(`缺少 ${p}: ${JSON.stringify(yo[k])}`);
        else if (!(k in yo)) out.push(`多出 ${p}: ${JSON.stringify(xo[k])}`);
        else walk(xo[k], yo[k], p);
      }
      return;
    }
    out.push(`${path} 不同:\n  实际: ${JSON.stringify(x)}\n  期望: ${JSON.stringify(y)}`);
  };
  walk(normalizeMssqlSnapshot(a), normalizeMssqlSnapshot(b), '');
  return out;
};

export const mssqlFingerprint = (snap: MssqlSnapshot): string =>
  createHash('sha256')
    .update(stableJson(normalizeMssqlSnapshot(snap)))
    .digest('hex');

/** 供测试和辅助工具构造 [s].[n] 的便捷再导出 */
export { mssqlIdent };
