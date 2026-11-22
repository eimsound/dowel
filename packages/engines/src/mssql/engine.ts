// MSSQL EngineAdapter 实现（SQL Server 2019 / 2022 / 2025）。
import { mssqlIdent, mssqlMajorOf, mssqlQualified, mssqlTokenize } from '@dowel/core';

import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  type TimeoutInfo,
  type TxHooks,
} from '../types.ts';
import {
  getMssqlShadowGuard,
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

const SYSTEM_DATABASES = new Set(['master', 'tempdb', 'model', 'msdb']);

const isSqlStringToken = (t: { kind: string; text: string } | undefined): boolean => {
  if (!t || t.kind !== 'other') return false;
  const s = t.text;
  return (
    ((s.startsWith("N'") || s.startsWith("n'")) && s.endsWith("'") && s.length >= 3) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  );
};

/**
 * 词法级剥离导入 SQL 中顶层的 `USE <ident>[;]` 语句（支持无分号连续出现、与下一条语句位于同一行、带注释/方括号/双引号）。
 * 排除查询提示 `OPTION (USE HINT (...))` 与 `OPTION (USE PLAN N'...')`，绝不误删字符串字面量、注释或标识符内部的 `USE`。
 */
export const stripMssqlImportNoise = (sql: string): string => {
  const toks = mssqlTokenize(sql);
  const sigIdx: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (!/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*')) {
      sigIdx.push(i);
    }
  }
  const removals: [number, number][] = [];
  for (let s = 0; s < sigIdx.length; s++) {
    const t = toks[sigIdx[s]!]!;
    if (t.kind !== 'ident' || t.text !== 'use') continue;
    const prev = s > 0 ? toks[sigIdx[s - 1]!] : undefined;
    if (prev?.text === '.') continue;
    const next = s + 1 < sigIdx.length ? toks[sigIdx[s + 1]!] : undefined;
    if (!next || (next.kind !== 'ident' && next.kind !== 'qident')) continue;
    const after = s + 2 < sigIdx.length ? toks[sigIdx[s + 2]!] : undefined;
    const isUseHint = next.kind === 'ident' && next.text === 'hint' && after?.text === '(';
    const isUsePlan = next.kind === 'ident' && next.text === 'plan' && isSqlStringToken(after);
    if (isUseHint || isUsePlan) continue;
    let end = next.end;
    if (after?.text === ';') {
      end = after.end;
      s += 2;
    } else {
      s += 1;
    }
    removals.push([t.start, end]);
  }
  if (removals.length === 0) return sql;
  let out = sql;
  for (let i = removals.length - 1; i >= 0; i--) {
    const [start, end] = removals[i]!;
    out = out.slice(0, start) + ' ' + out.slice(end);
  }
  return out;
};

/**
 * 清空 MSSQL 影子库中全部非系统对象（保留 dbo 与系统 schema）：
 * - 安全护栏：拒绝清空任何系统库（master/tempdb/model/msdb）；若连接挂载了 shadowGuard，严格校验当前 DB_NAME() 与 dowel_shadow 扩展属性；
 * - 依赖顺序：数据库级触发器 → 外键 → 表级触发器 → 视图/存储过程/函数 → 表 → 序列 → 同义词 → 用户类型 → 非 dbo 用户 schema（含 dowel）。
 */
export const resetMssqlShadow = async (db: Db): Promise<void> => {
  const [ctx] = await db.query<{ dbName: string | null }>(`SELECT DB_NAME() AS dbName`);
  const currentDb = ctx?.dbName ?? '';
  if (!currentDb || SYSTEM_DATABASES.has(currentDb.toLowerCase())) {
    throw new Error(`拒绝清空 SQL Server 系统库或未指定数据库：${currentDb || '(empty)'}`);
  }
  const guard = getMssqlShadowGuard(db);
  if (guard) {
    if (guard.expectedDb && currentDb.toLowerCase() !== guard.expectedDb.toLowerCase()) {
      throw new Error(
        `拒绝清空 MSSQL 影子库：当前会话数据库（${currentDb}）与预期影子库（${guard.expectedDb}）不一致`,
      );
    }
    const [markRow] = await db.query<{ v: string | null }>(
      `SELECT CAST(value AS nvarchar(max)) AS v
         FROM sys.extended_properties
        WHERE class = 0 AND major_id = 0 AND minor_id = 0 AND name = N'dowel_shadow'`,
    );
    if (markRow?.v !== guard.mark) {
      throw new Error(`拒绝清空 MSSQL 影子库（${currentDb}）：缺少有效的 Dowel 影子库标记`);
    }
  }

  await pinMssqlSession(db);

  // 0. 删除所有数据库级触发器
  const dbTrigs = await db.query<{ name: string }>(
    `SELECT name FROM sys.triggers WHERE parent_class = 0 AND is_ms_shipped = 0`,
  );
  for (const tr of dbTrigs) {
    await db.exec(`DROP TRIGGER ${mssqlIdent(tr.name)} ON DATABASE`);
  }

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
  const dropRoutines = async (
    items: { schema: string; name: string; type: string }[],
  ): Promise<{ remaining: typeof items; lastErr: unknown }> => {
    let rem = [...items];
    let lastErr: unknown = null;
    while (rem.length > 0) {
      const failed: typeof items = [];
      for (const r of rem) {
        const t = r.type.trim();
        const kind = t === 'V' ? 'VIEW' : t === 'P' ? 'PROCEDURE' : 'FUNCTION';
        try {
          await db.exec(`DROP ${kind} IF EXISTS ${mssqlQualified(r.schema, r.name)}`);
        } catch (e) {
          lastErr = e;
          failed.push(r);
        }
      }
      if (failed.length === rem.length) break;
      rem = failed;
    }
    return { remaining: rem, lastErr };
  };
  const { remaining } = await dropRoutines(routines);

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

  // 4b. 补删因表约束或计算列引用而在 Step 3 暂未能删除的残留例程
  if (remaining.length > 0) {
    const afterTables = await dropRoutines(remaining);
    if (afterTables.remaining.length > 0) {
      const names = afterTables.remaining.map((r) => `${r.schema}.${r.name}`).join(', ');
      const reason =
        afterTables.lastErr instanceof Error
          ? afterTables.lastErr.message
          : typeof afterTables.lastErr === 'string'
            ? afterTables.lastErr
            : afterTables.lastErr === null || afterTables.lastErr === undefined
              ? 'unknown error'
              : JSON.stringify(afterTables.lastErr);
      const err = new Error(`清理 MSSQL 影子库残留例程失败（${names}）：${reason}`, {
        cause: afterTables.lastErr,
      });
      const num = mssqlErrorNumber(afterTables.lastErr);
      const code = mssqlErrorCode(afterTables.lastErr);
      if (num !== null) Object.assign(err, { number: num });
      if (code !== null) Object.assign(err, { code });
      if (afterTables.lastErr && typeof afterTables.lastErr === 'object') {
        Object.assign(err, { originalError: afterTables.lastErr });
      }
      throw err;
    }
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

  // 5b. 删除所有同义词
  const syns = await db.query<{ schema: string; name: string }>(
    `SELECT s.name AS [schema], sy.name
       FROM sys.synonyms sy
       JOIN sys.schemas s ON s.schema_id = sy.schema_id
      WHERE sy.is_ms_shipped = 0 AND s.schema_id < 16384
        AND s.name NOT IN (N'sys', N'INFORMATION_SCHEMA', N'guest', N'cdc')
        AND s.name NOT LIKE N'db[_]%'`,
  );
  for (const sy of syns) {
    await db.exec(`DROP SYNONYM ${mssqlQualified(sy.schema, sy.name)}`);
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

  planOptionsForVersion: (versionNum) => {
    const m = mssqlMajorOf(versionNum);
    return m !== null ? { mssqlMajor: m } : undefined;
  },

  resetShadow: resetMssqlShadow,

  prepareImportShadow: async (db) => {
    await pinMssqlSession(db);
  },

  stripImportNoise: stripMssqlImportNoise,

  analyzeStepRisk: (db, from, steps, opts) => analyzeMssqlStepRisk(db, from, steps, resetMssqlShadow, opts),

  applyTimeouts: async (conn, timeouts): Promise<AppliedTimeouts> => {
    const ms = (n: number) => Math.max(0, Math.trunc(n));
    const statementMs = timeouts ? ms(timeouts.statementMs) : 0;
    const lockMs = timeouts ? ms(timeouts.lockMs) : 0;
    if (lockMs > 0) await conn.exec(`SET LOCK_TIMEOUT ${lockMs}`);
    if (statementMs > 0) setMssqlRequestTimeout(conn, statementMs);
    return { statementMs, lockMs };
  },

  restoreTimeouts: async (conn, applied) => {
    if (applied.statementMs > 0) setMssqlRequestTimeout(conn, null);
    if (applied.lockMs > 0) await conn.exec('SET LOCK_TIMEOUT -1');
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
