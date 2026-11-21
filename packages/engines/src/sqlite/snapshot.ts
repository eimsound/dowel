// 从 SQLite sqlite_master + PRAGMA 读出结构快照，支持规范化与结构相等比对。
import { createHash } from 'node:crypto';

import { deepEqual, sqliteIdent, sqliteNormalizeType, stableJson } from '@dowel/core';

import type { Db } from '../types.ts';
import { parseSqliteIndexDdl, parseSqliteTableDdl } from './ddl-parser.ts';

export interface SqliteColSnap {
  cid: number;
  type: string;
  notNull: boolean;
  default: string | null;
  generated: { expr: string; stored: boolean } | null;
  collation: string | null;
  autoincrement: boolean;
}

export interface SqlitePkSnap {
  name: string | null;
  columns: string[];
}

export interface SqliteUniqueSnap {
  name: string | null;
  columns: string[];
}

export interface SqliteCheckSnap {
  name: string | null;
  expr: string;
}

export interface SqliteFkSnap {
  name: string | null;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface SqliteIdxElemSnap {
  column: string | null;
  expr: string | null;
  desc: boolean;
  collation: string | null;
}

export interface SqliteIdxSnap {
  unique: boolean;
  elements: SqliteIdxElemSnap[];
  where: string | null;
}

export interface SqliteTableSnap {
  name: string;
  strict: boolean;
  withoutRowid: boolean;
  columns: Record<string, SqliteColSnap>;
  primaryKey: SqlitePkSnap | null;
  uniques: SqliteUniqueSnap[];
  checks: SqliteCheckSnap[];
  foreignKeys: SqliteFkSnap[];
  indexes: Record<string, SqliteIdxSnap>;
}

export interface SqliteOpaqueSnap {
  objType: 'view' | 'trigger';
  name: string;
  tblName: string;
  ddl: string;
  drop: string;
  order: number;
}

export interface SqliteSnapshot {
  version: string;
  versionNum: number;
  tables: Record<string, SqliteTableSnap>;
  opaques: Record<string, SqliteOpaqueSnap>;
}

const FK_ACTION_MAP: Record<string, string> = {
  'NO ACTION': 'noAction',
  RESTRICT: 'restrict',
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  'SET DEFAULT': 'setDefault',
};

/** 解析 SQLite 版本号 "3.54.1" → 3054001 */
export const parseSqliteVersionNum = (ver: string): number => {
  const [maj = 0, min = 0, pat = 0] = ver.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return maj * 1_000_000 + min * 1_000 + pat;
};

const isSystemOrDowel = (name: string): boolean => {
  const low = name.toLowerCase();
  return low.startsWith('sqlite_') || low.startsWith('dowel_');
};

/** 从 SQLite 库读取完整结构快照（自动排除 sqlite_* 系统对象与 dowel_* 迁移历史表） */
export const readSqliteSnapshot = async (db: Db): Promise<SqliteSnapshot> => {
  const [verRow] = await db.query<{ v: string }>('SELECT sqlite_version() AS v');
  const version = String(verRow?.v ?? '3.0.0');
  const versionNum = parseSqliteVersionNum(version);

  const masters = await db.query<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>(
    `SELECT type, name, tbl_name, sql
       FROM sqlite_master
      WHERE type IN ('table', 'index', 'view', 'trigger')
      ORDER BY rowid`,
  );

  const tables: Record<string, SqliteTableSnap> = {};
  const opaques: Record<string, SqliteOpaqueSnap> = {};
  const indexSqlByName = new Map<string, string>();
  for (const row of masters) {
    if (row.type === 'index' && row.sql) indexSqlByName.set(row.name, row.sql);
  }

  let opaqueOrder = 0;
  for (const row of masters) {
    if (isSystemOrDowel(row.name) || isSystemOrDowel(row.tbl_name)) continue;

    if (row.type === 'view' || row.type === 'trigger') {
      if (!row.sql) continue;
      const key = `${row.type}:${row.name}`;
      opaques[key] = {
        objType: row.type,
        name: row.name,
        tblName: row.tbl_name,
        ddl: row.sql.trim(),
        drop:
          row.type === 'view'
            ? `DROP VIEW ${sqliteIdent(row.name)}`
            : `DROP TRIGGER ${sqliteIdent(row.name)}`,
        order: ++opaqueOrder,
      };
      continue;
    }

    if (row.type !== 'table' || !row.sql) continue;
    const tbl = row.name;
    const parsed = parseSqliteTableDdl(row.sql);

    // 1. 列（PRAGMA table_xinfo 含 VIRTUAL hidden=2 与 STORED hidden=3）
    const xinfo = await db.query<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
      hidden: number;
    }>(`PRAGMA table_xinfo(${sqliteIdent(tbl)})`);

    const columns: Record<string, SqliteColSnap> = {};
    const pkColsByOrder: { pk: number; name: string }[] = [];
    for (const c of xinfo) {
      if (c.hidden === 1) continue; // 隐藏系统列
      const low = c.name.toLowerCase();
      const isGen = c.hidden === 2 || c.hidden === 3;
      const genMeta = parsed.generatedExprs[low];
      const generated = isGen ? { expr: genMeta?.expr ?? '', stored: c.hidden === 3 } : null;
      if (c.pk > 0) pkColsByOrder.push({ pk: c.pk, name: c.name });
      columns[c.name] = {
        cid: Number(c.cid),
        type: sqliteNormalizeType(c.type || 'ANY'),
        // SQLite 主键列在 Dowel IR 中统一视作 notNull: true（与 PG 及 validate() 保持一致）
        notNull: c.notnull === 1 || c.pk > 0,
        default: generated ? null : (c.dflt_value ?? null),
        generated,
        collation: parsed.columnCollations[low] ?? null,
        autoincrement:
          parsed.autoincrementColumn !== null && parsed.autoincrementColumn.toLowerCase() === low,
      };
    }

    pkColsByOrder.sort((a, b) => a.pk - b.pk);
    const primaryKey: SqlitePkSnap | null =
      pkColsByOrder.length > 0 ? { name: parsed.pkName, columns: pkColsByOrder.map((p) => p.name) } : null;

    // 2. 索引与 UNIQUE 约束（PRAGMA index_list + index_xinfo）
    const idxList = await db.query<{
      seq: number;
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>(`PRAGMA index_list(${sqliteIdent(tbl)})`);

    const indexes: Record<string, SqliteIdxSnap> = {};
    const pragmaUniques: string[][] = [];
    for (const ix of idxList) {
      if (ix.origin === 'pk') continue;
      const xcols = await db.query<{
        seqno: number;
        cid: number;
        name: string | null;
        desc: number;
        coll: string;
        key: number;
      }>(`PRAGMA index_xinfo(${sqliteIdent(ix.name)})`);
      const keyCols = xcols.filter((x) => x.key === 1).sort((a, b) => a.seqno - b.seqno);

      if (ix.origin === 'u') {
        pragmaUniques.push(keyCols.map((x) => x.name!).filter(Boolean));
        continue;
      }
      if (ix.origin !== 'c') continue;
      if (isSystemOrDowel(ix.name)) continue;

      const ddlSql = indexSqlByName.get(ix.name);
      const parsedIdx = ddlSql ? parseSqliteIndexDdl(ddlSql) : null;
      const elements: SqliteIdxElemSnap[] = keyCols.map((kc, i) => {
        const pe = parsedIdx?.elements[i];
        const colName = kc.cid >= 0 ? kc.name : null;
        const expr = kc.cid === -2 ? (pe?.expr ?? null) : null;
        // 仅当索引上显式指定了非列默认的 COLLATE（或非 BINARY）时记录
        const colDefaultColl = colName ? (columns[colName]?.collation ?? null) : null;
        const explicitColl =
          pe?.collation ??
          (kc.coll && kc.coll.toUpperCase() !== 'BINARY' && kc.coll !== colDefaultColl ? kc.coll : null);
        return {
          column: colName,
          expr,
          desc: kc.desc === 1,
          collation: explicitColl,
        };
      });
      indexes[ix.name] = {
        unique: ix.unique === 1,
        elements,
        where: parsedIdx?.where ?? null,
      };
    }

    // 合并 UNIQUE 约束（结合 DDL 中提取的显式约束名）
    const usedParsedUq = new Set<number>();
    const uniques: SqliteUniqueSnap[] = pragmaUniques.map((cols) => {
      const lowCols = cols.map((c) => c.toLowerCase()).join('\0');
      const idx = parsed.uniques.findIndex(
        (u, i) => !usedParsedUq.has(i) && u.columns.map((c) => c.toLowerCase()).join('\0') === lowCols,
      );
      if (idx >= 0) {
        usedParsedUq.add(idx);
        return { name: parsed.uniques[idx]!.name, columns: cols };
      }
      return { name: null, columns: cols };
    });

    // 3. 外键（PRAGMA foreign_key_list，按 id 分组、seq 排序）
    const fkRows = await db.query<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
      match: string;
    }>(`PRAGMA foreign_key_list(${sqliteIdent(tbl)})`);

    const fkGroups = new Map<number, typeof fkRows>();
    for (const r of fkRows) {
      const list = fkGroups.get(r.id) ?? [];
      list.push(r);
      fkGroups.set(r.id, list);
    }

    const usedParsedFk = new Set<number>();
    const foreignKeys: SqliteFkSnap[] = [];
    for (const group of fkGroups.values()) {
      group.sort((a, b) => a.seq - b.seq);
      const first = group[0]!;
      const cols = group.map((g) => g.from);
      // 若 DDL 省略了被引用列名，SQLite 默认引用目标表的主键列（后续解析）
      const refCols = group.map((g) => g.to ?? '');
      const refTable = first.table;
      const lowKey = `${refTable.toLowerCase()}:${cols.map((c) => c.toLowerCase()).join(',')}`;
      const hasExplicitRefCols = refCols.every(Boolean);
      const refColsKey = refCols.map((c) => c.toLowerCase()).join(',');
      const matchIdx = parsed.foreignKeys.findIndex((pf, i) => {
        if (usedParsedFk.has(i)) return false;
        if (`${pf.refTable.toLowerCase()}:${pf.columns.map((c) => c.toLowerCase()).join(',')}` !== lowKey) {
          return false;
        }
        if (hasExplicitRefCols && pf.refColumns.length > 0) {
          return pf.refColumns.map((c) => c.toLowerCase()).join(',') === refColsKey;
        }
        return true;
      });
      const meta = matchIdx >= 0 ? parsed.foreignKeys[matchIdx]! : null;
      if (matchIdx >= 0) usedParsedFk.add(matchIdx);
      foreignKeys.push({
        name: meta?.name ?? null,
        columns: cols,
        refTable,
        refColumns: refCols,
        onDelete: FK_ACTION_MAP[first.on_delete.toUpperCase()] ?? 'noAction',
        onUpdate: FK_ACTION_MAP[first.on_update.toUpperCase()] ?? 'noAction',
        deferrable: meta?.deferrable ?? false,
        initiallyDeferred: meta?.initiallyDeferred ?? false,
      });
    }

    tables[tbl] = {
      name: tbl,
      strict: parsed.strict,
      withoutRowid: parsed.withoutRowid,
      columns,
      primaryKey,
      uniques,
      checks: parsed.checks,
      foreignKeys,
      indexes,
    };
  }

  // 补齐省略了 refColumns 的外键（指向目标表主键列）
  for (const t of Object.values(tables)) {
    for (const fk of t.foreignKeys) {
      if (fk.refColumns.some((c) => !c)) {
        const refT = Object.values(tables).find((rt) => rt.name.toLowerCase() === fk.refTable.toLowerCase());
        if (refT?.primaryKey) fk.refColumns = [...refT.primaryKey.columns];
      }
      // 把 refTable 规范为目标表的实际大小写名
      const refT = Object.values(tables).find((rt) => rt.name.toLowerCase() === fk.refTable.toLowerCase());
      if (refT) fk.refTable = refT.name;
    }
  }

  return { version, versionNum, tables, opaques };
};

/** 规范化 SQLite 快照：剔除 version 与列物理顺序 cid，对无序约束集合做稳定排序，供指纹和结构比对共用 */
export const normalizeSqliteSnapshot = (snap: SqliteSnapshot): unknown => {
  const normTables: Record<string, unknown> = {};
  for (const [tname, t] of Object.entries(snap.tables).sort(([a], [b]) => a.localeCompare(b))) {
    const cols: Record<string, unknown> = {};
    for (const [cname, c] of Object.entries(t.columns).sort(([a], [b]) => a.localeCompare(b))) {
      cols[cname] = {
        type: c.type,
        notNull: c.notNull,
        default: c.default,
        generated: c.generated,
        collation: c.collation,
        autoincrement: c.autoincrement,
      };
    }
    const uniques = [...t.uniques].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const checks = [...t.checks].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const foreignKeys = [...t.foreignKeys].sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
    const indexes: Record<string, unknown> = {};
    for (const [iname, ix] of Object.entries(t.indexes).sort(([a], [b]) => a.localeCompare(b))) {
      indexes[iname] = ix;
    }
    normTables[tname] = {
      name: t.name,
      strict: t.strict,
      withoutRowid: t.withoutRowid,
      columns: cols,
      primaryKey: t.primaryKey,
      uniques,
      checks,
      foreignKeys,
      indexes,
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

/** 比较两份 SQLite 快照的规范结构差异（空数组表示结构完全一致） */
export const diffSqliteSnapshots = (a: SqliteSnapshot, b: SqliteSnapshot): string[] => {
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
  walk(normalizeSqliteSnapshot(a), normalizeSqliteSnapshot(b), '');
  return diffs;
};

export const sqliteFingerprint = (snap: SqliteSnapshot): string =>
  createHash('sha256')
    .update(stableJson(normalizeSqliteSnapshot(snap)))
    .digest('hex');
