// MSSQL EngineAdapter 实现（SQL Server 2019 / 2022 / 2025）。
import { mssqlIdent, mssqlQualified } from '@dowel/core';

import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  type TimeoutInfo,
  type TxHooks,
} from '../types.ts';
import {
  MSSQL_SESSION_SETTINGS,
  mssqlErrorCode,
  mssqlErrorNumber,
  pinMssqlSession,
  runMssqlTransaction,
  setMssqlRequestTimeout,
} from './db.ts';
import { mssqlHistory } from './history.ts';
import { importMssqlSnapshot } from './import.ts';
import { analyzeMssqlStepRisk } from './risk.ts';
import {
  diffMssqlSnapshots,
  mssqlFingerprint,
  type MssqlSnapshot,
  normalizeMssqlSnapshot,
  readMssqlSnapshot,
} from './snapshot.ts';

/**
 * 清空 MSSQL 影子库中全部非系统对象（保留 dbo 与系统 schema）：
 * 依赖顺序：外键 → 触发器 → 视图/存储过程/函数 → 表 → 序列 → 用户类型 → 非 dbo 用户 schema（含 dowel）。
 */
export const resetMssqlShadow = async (db: Db): Promise<void> => {
  await pinMssqlSession(db);

  // 1. 删除所有非系统外键
  const fks = await db.query<{ schema: string; table: string; name: string }>(
    `SELECT s.name AS [schema], t.name AS [table], fk.name
       FROM sys.foreign_keys fk
       JOIN sys.tables t ON t.object_id = fk.parent_object_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const fk of fks) {
    await db.exec(
      `ALTER TABLE ${mssqlQualified(fk.schema, fk.table)} DROP CONSTRAINT ${mssqlIdent(fk.name)}`,
    );
  }

  // 2. 删除所有表级触发器
  const trigs = await db.query<{ schema: string; name: string }>(
    `SELECT s.name AS [schema], tr.name
       FROM sys.triggers tr
       JOIN sys.tables t ON t.object_id = tr.parent_id
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE tr.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const tr of trigs) {
    await db.exec(`DROP TRIGGER ${mssqlQualified(tr.schema, tr.name)}`);
  }

  // 3. 删除所有视图、存储过程、函数（多轮清理以处理嵌套视图/函数引用）
  const routines = await db.query<{ schema: string; name: string; type: string }>(
    `SELECT s.name AS [schema], o.name, o.type
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'
        AND o.type IN ('V', 'P', 'FN', 'IF', 'TF')
      ORDER BY o.object_id DESC`,
  );
  let remaining = [...routines];
  for (let pass = 0; pass < 5 && remaining.length > 0; pass++) {
    const failed: typeof remaining = [];
    for (const r of remaining) {
      const t = r.type.trim();
      const kind = t === 'V' ? 'VIEW' : t === 'P' ? 'PROCEDURE' : 'FUNCTION';
      try {
        await db.exec(`DROP ${kind} IF EXISTS ${mssqlQualified(r.schema, r.name)}`);
      } catch {
        failed.push(r);
      }
    }
    if (failed.length === remaining.length) break;
    remaining = failed;
  }

  // 4. 删除所有用户表
  const tables = await db.query<{ schema: string; name: string }>(
    `SELECT s.name AS [schema], t.name
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const t of tables) {
    await db.exec(`DROP TABLE ${mssqlQualified(t.schema, t.name)}`);
  }

  // 5. 删除所有序列
  const seqs = await db.query<{ schema: string; name: string }>(
    `SELECT s.name AS [schema], q.name
       FROM sys.sequences q
       JOIN sys.schemas s ON s.schema_id = q.schema_id
      WHERE q.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const q of seqs) {
    await db.exec(`DROP SEQUENCE ${mssqlQualified(q.schema, q.name)}`);
  }

  // 6. 删除所有用户自定义类型
  const types = await db.query<{ schema: string; name: string }>(
    `SELECT s.name AS [schema], ty.name
       FROM sys.types ty
       JOIN sys.schemas s ON s.schema_id = ty.schema_id
      WHERE ty.is_user_defined = 1 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const ty of types) {
    await db.exec(`DROP TYPE ${mssqlQualified(ty.schema, ty.name)}`);
  }

  // 7. 删除所有非 dbo 用户 schema（含 dowel）
  const schemas = await db.query<{ name: string }>(
    `SELECT s.name
       FROM sys.schemas s
      WHERE s.schema_id < 16384
        AND s.name NOT IN (N'dbo', N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const s of schemas) {
    await db.exec(`DROP SCHEMA ${mssqlIdent(s.name)}`);
  }
};

export const readMssqlVersionNum = async (db: Db): Promise<number | null> => {
  const [r] = await db.query<{ major: number; minor: number }>(
    `SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
            CAST(SERVERPROPERTY('ProductMinorVersion') AS int) AS minor`,
  );
  if (!r || !Number.isInteger(Number(r.major))) return null;
  return Number(r.major) * 10000 + Number(r.minor ?? 0);
};

export const mssqlEngine: EngineAdapter = {
  dialect: 'mssql',
  history: mssqlHistory,
  sessionSettings: MSSQL_SESSION_SETTINGS,

  sessionHeader: () => `${MSSQL_SESSION_SETTINGS.join(';\n')};\nGO\n`,

  pinSession: pinMssqlSession,

  resetSession: async (db) => {
    setMssqlRequestTimeout(db, null);
    await db.exec('SET LOCK_TIMEOUT -1');
    await pinMssqlSession(db);
  },

  inTransaction: async <T>(conn: Db, fn: () => Promise<T>, hooks: TxHooks = {}): Promise<T> =>
    runMssqlTransaction(conn, fn, hooks),

  execStepSql: async (conn, sql) => {
    await conn.exec(sql);
  },

  readSnapshot: async (db, only) => {
    const snap = await readMssqlSnapshot(db, only);
    return {
      dialect: 'mssql',
      version: snap.version,
      versionNum: snap.versionNum,
      payload: snap,
    };
  },

  importSnapshot: (snap) => importMssqlSnapshot(snap.payload as MssqlSnapshot),

  normalizeSnapshot: (snap) => normalizeMssqlSnapshot(snap.payload as MssqlSnapshot),

  normalizeLiveSnapshot: (snap) => snap,

  diffSnapshots: (a, b) => diffMssqlSnapshots(a.payload as MssqlSnapshot, b.payload as MssqlSnapshot),

  fingerprint: (snap) => mssqlFingerprint(snap.payload as MssqlSnapshot),

  readVersionNum: readMssqlVersionNum,

  resetShadow: resetMssqlShadow,

  prepareImportShadow: async (db) => {
    await pinMssqlSession(db);
  },

  stripImportNoise: (sql) =>
    sql
      .split('\n')
      .filter((l) => !/^\s*USE\s+(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][A-Za-z0-9_$#]*)\s*;?\s*$/i.test(l))
      .join('\n'),

  analyzeStepRisk: (db, from, steps) => analyzeMssqlStepRisk(db, from, steps, resetMssqlShadow),

  applyTimeouts: async (conn, timeouts): Promise<AppliedTimeouts> => {
    const ms = (n: number) => Math.max(0, Math.trunc(n));
    const statementMs = timeouts ? ms(timeouts.statementMs) : 0;
    const lockMs = timeouts ? ms(timeouts.lockMs) : 0;
    if (lockMs > 0) await conn.exec(`SET LOCK_TIMEOUT ${lockMs}`);
    if (statementMs > 0) setMssqlRequestTimeout(conn, statementMs);
    return { statementMs, lockMs };
  },

  restoreTimeouts: async (conn, applied) => {
    if (applied.lockMs > 0) await conn.exec('SET LOCK_TIMEOUT -1');
    if (applied.statementMs > 0) setMssqlRequestTimeout(conn, null);
  },

  classifyTimeout: (err, applied): TimeoutInfo | undefined => {
    const num = mssqlErrorNumber(err);
    const code = mssqlErrorCode(err);
    if (num === 1222 && applied.lockMs > 0) return { kind: 'lock', ms: applied.lockMs };
    if ((code === 'ETIMEOUT' || code === 'ECANCEL') && applied.statementMs > 0) {
      return { kind: 'statement', ms: applied.statementMs };
    }
    return undefined;
  },
};
