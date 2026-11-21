// SQLite EngineAdapter 实现（基于 Node 26 内置 node:sqlite）。
import {
  createAll,
  type Model,
  splitSqliteStatements,
  sqliteIdent,
  type Step,
  stripSqliteSql,
} from '@dowel/core';

import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  EngineStepError,
  type StepRisk,
  type TimeoutInfo,
  type TxHooks,
} from '../types.ts';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, SQLITE_SESSION_SETTINGS } from './db.ts';
import { sqliteHistory } from './history.ts';
import { importSqliteSnapshot } from './import.ts';
import {
  diffSqliteSnapshots,
  normalizeSqliteSnapshot,
  readSqliteSnapshot,
  sqliteFingerprint,
  type SqliteSnapshot,
} from './snapshot.ts';

const isForeignKeyCheck = (stmt: string): boolean =>
  /^\s*pragma\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?foreign_key_check\b/i.test(stripSqliteSql(stmt));

const isBeginStmt = (stmt: string): boolean => /^\s*begin\b/i.test(stripSqliteSql(stmt));
const isCommitStmt = (stmt: string): boolean => /^\s*(?:commit|end)\b/i.test(stripSqliteSql(stmt));
const isRollbackStmt = (stmt: string): boolean => /^\s*rollback\b/i.test(stripSqliteSql(stmt));
const disablesForeignKeys = (sql: string): boolean =>
  /\bpragma\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?foreign_keys\s*=\s*(?:off|0|false|no)\b/i.test(
    stripSqliteSql(sql),
  );

/**
 * 执行一条 SQLite 迁移步骤（可含 12 步表重建的 `PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE; ... PRAGMA foreign_key_check; COMMIT; PRAGMA foreign_keys = ON`）：
 * - 按顶层语句顺序执行；
 * - 遇到 `PRAGMA foreign_key_check` 时通过 `query()` 校验返回行，非空即抛错并回滚事务；
 * - 若步骤自行开启了 `BEGIN` 且中途失败，自动 `ROLLBACK`；
 * - 若步骤关闭了 `foreign_keys`，`finally` 必然兜底恢复 `PRAGMA foreign_keys = ON`。
 */
export const execSqliteStepSql = async (conn: Db, sql: string): Promise<void> => {
  const stmts = splitSqliteStatements(sql);
  const touchedFk = disablesForeignKeys(sql);
  let openedTx = false;
  try {
    for (const stmt of stmts) {
      if (isBeginStmt(stmt)) {
        await conn.exec(stmt);
        openedTx = true;
        continue;
      }
      if (isCommitStmt(stmt)) {
        await conn.exec(stmt);
        openedTx = false;
        continue;
      }
      if (isRollbackStmt(stmt)) {
        await conn.exec(stmt);
        openedTx = false;
        continue;
      }
      if (isForeignKeyCheck(stmt)) {
        const violations = await conn.query<{ table?: string; rowid?: number | string; parent?: string }>(
          stmt,
        );
        if (violations.length > 0) {
          const sample = violations
            .slice(0, 5)
            .map((v) => `${v.table ?? '?'}(rowid=${v.rowid ?? '?'} -> ${v.parent ?? '?'})`)
            .join(', ');
          throw new Error(`PRAGMA foreign_key_check 发现 ${violations.length} 处外键约束冲突：${sample}`);
        }
        continue;
      }
      await conn.exec(stmt);
    }
  } catch (e) {
    if (openedTx) await conn.exec('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (touchedFk) {
      await conn.exec('PRAGMA foreign_keys = ON').catch(() => {});
    }
  }
};

/** 清空 SQLite 影子库中的全部用户对象（表、视图、触发器、索引） */
export const resetSqliteShadow = async (db: Db): Promise<void> => {
  await db.exec('PRAGMA foreign_keys = OFF');
  try {
    const objs = await db.query<{ type: string; name: string }>(
      `SELECT type, name FROM sqlite_master
        WHERE type IN ('trigger', 'view', 'index', 'table')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'trigger' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END`,
    );
    for (const o of objs) {
      if (o.type === 'trigger') await db.exec(`DROP TRIGGER IF EXISTS ${sqliteIdent(o.name)}`);
      else if (o.type === 'view') await db.exec(`DROP VIEW IF EXISTS ${sqliteIdent(o.name)}`);
      else if (o.type === 'index') await db.exec(`DROP INDEX IF EXISTS ${sqliteIdent(o.name)}`);
      else if (o.type === 'table') await db.exec(`DROP TABLE IF EXISTS ${sqliteIdent(o.name)}`);
    }
  } finally {
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('PRAGMA legacy_alter_table = OFF');
  }
};

/** 识别冻结 SQLite 脚本中的 12 步重建表目标表名 */
const extractRebuiltTables = (sql: string): string[] => {
  const re =
    /ALTER\s+TABLE\s+"?_dowel_tmp_\d+"?\s+RENAME\s+TO\s+(?:"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
  const out: string[] = [];
  for (const m of sql.matchAll(re)) {
    const name = m[1] !== undefined ? m[1].replaceAll('""', '"') : m[2]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
};

const analyzeSqliteStepRisk = async (db: Db, from: Model, steps: Step[]): Promise<StepRisk[]> => {
  await resetSqliteShadow(db);
  for (const s of createAll(from)) {
    await execSqliteStepSql(db, s.sql);
  }
  const existingTables = new Set(
    (
      await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'dowel_%'`,
      )
    ).map((r) => r.name.toLowerCase()),
  );

  const out: StepRisk[] = [];
  for (const s of steps) {
    const t0 = performance.now();
    try {
      await execSqliteStepSql(db, s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
    const rebuilt =
      s.kind === 'rebuildTable'
        ? s.target
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : extractRebuiltTables(s.sql);
    if (rebuilt.length > 0) {
      out.push({
        locks: rebuilt.map((t) => ({ relation: t, mode: 'EXCLUSIVE' })),
        rewrites: rebuilt,
        scans: rebuilt,
        level: 'high',
      });
      continue;
    }
    const stripped = stripSqliteSql(s.sql);
    const alterDrop = /^\s*alter\s+table\s+(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_]*))\s+drop\s+column\b/i.exec(
      s.sql,
    );
    const createIdx =
      /^\s*create\s+(?:unique\s+)?index\b[\s\S]*?\bon\s+(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_]*))/i.exec(s.sql);
    const targetName = alterDrop
      ? (alterDrop[1] ?? alterDrop[2] ?? '')
      : createIdx
        ? (createIdx[1] ?? createIdx[2] ?? '')
        : '';
    if (targetName && existingTables.has(targetName.toLowerCase())) {
      out.push({
        locks: [{ relation: targetName, mode: 'RESERVED' }],
        rewrites: [],
        scans: createIdx ? [targetName] : [],
        level: 'medium',
      });
      continue;
    }
    if (/^\s*vacuum\b/i.test(stripped)) {
      out.push({
        locks: [],
        rewrites: ['database'],
        scans: [],
        level: 'high',
      });
      continue;
    }
    out.push({ locks: [], rewrites: [], scans: [], level: 'low' });
  }
  return out;
};

export const sqliteEngine: EngineAdapter = {
  dialect: 'sqlite',
  history: sqliteHistory,
  sessionSettings: SQLITE_SESSION_SETTINGS,

  sessionHeader: () => `${SQLITE_SESSION_SETTINGS.join(';\n')};\n`,

  pinSession: async (db) => {
    for (const s of SQLITE_SESSION_SETTINGS) await db.exec(s);
  },

  resetSession: async (db) => {
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('PRAGMA legacy_alter_table = OFF');
    await db.exec(`PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
  },

  inTransaction: async <T>(conn: Db, fn: () => Promise<T>, hooks: TxHooks = {}): Promise<T> => {
    await conn.exec('BEGIN IMMEDIATE');
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

  execStepSql: execSqliteStepSql,

  readSnapshot: async (db) => {
    const snap = await readSqliteSnapshot(db);
    return {
      dialect: 'sqlite',
      version: snap.version,
      versionNum: snap.versionNum,
      payload: snap,
    };
  },

  importSnapshot: (snap) => importSqliteSnapshot(snap.payload as SqliteSnapshot),

  normalizeSnapshot: (snap) => normalizeSqliteSnapshot(snap.payload as SqliteSnapshot),

  normalizeLiveSnapshot: (snap) => snap,

  diffSnapshots: (a, b) => diffSqliteSnapshots(a.payload as SqliteSnapshot, b.payload as SqliteSnapshot),

  fingerprint: (snap) => sqliteFingerprint(snap.payload as SqliteSnapshot),

  readVersionNum: async (db) => {
    const [r] = await db.query<{ v: string }>('SELECT sqlite_version() AS v');
    if (!r?.v) return null;
    const [maj = 0, min = 0, pat = 0] = String(r.v)
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
    return maj * 1_000_000 + min * 1_000 + pat;
  },

  resetShadow: resetSqliteShadow,

  prepareImportShadow: async (db) => {
    await db.exec('PRAGMA foreign_keys = ON');
    await db.exec('PRAGMA legacy_alter_table = OFF');
  },

  stripImportNoise: (sql) =>
    sql
      .split('\n')
      .filter((l) => !/^\s*(?:BEGIN\s+TRANSACTION|COMMIT)\s*;\s*$/i.test(l))
      .join('\n'),

  analyzeStepRisk: (db, from, steps) => analyzeSqliteStepRisk(db, from, steps),

  applyTimeouts: async (conn, timeouts): Promise<AppliedTimeouts> => {
    const ms = (n: number) => Math.max(0, Math.trunc(n));
    const lockMs = timeouts ? ms(timeouts.lockMs) : 0;
    const statementMs = timeouts ? ms(timeouts.statementMs) : 0;
    if (lockMs > 0) await conn.exec(`PRAGMA busy_timeout = ${lockMs}`);
    return { statementMs, lockMs };
  },

  restoreTimeouts: async (conn, applied) => {
    if (applied.lockMs > 0) {
      await conn.exec(`PRAGMA busy_timeout = ${DEFAULT_SQLITE_BUSY_TIMEOUT_MS}`);
    }
  },

  classifyTimeout: (err, applied): TimeoutInfo | undefined => {
    if (applied.lockMs <= 0) return undefined;
    const msg = err instanceof Error ? err.message : String(err);
    const errcode = (err as { errcode?: unknown } | null)?.errcode;
    if (errcode === 5 || /SQLITE_BUSY|database is locked|database table is locked/i.test(msg)) {
      return { kind: 'lock', ms: applied.lockMs };
    }
    return undefined;
  },

  afterNonTxStep: async (conn) => {
    await conn.exec('PRAGMA foreign_keys = ON').catch(() => {});
  },
};
