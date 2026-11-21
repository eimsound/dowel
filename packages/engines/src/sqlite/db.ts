// SQLite 数据库适配器：基于 Node 26 内置 node:sqlite（DatabaseSync），零原生编译依赖。
// 支持 :memory: 内存影子库与本地文件路径目标库；提供按规范路径隔离的进程内互斥锁。
import { constants, DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { Db } from '../types.ts';

const BLOCKED_PRAGMAS = new Set(['writable_schema', 'temp_store_directory', 'data_store_directory']);

export const SQLITE_SESSION_SETTINGS = [
  'PRAGMA foreign_keys = ON',
  'PRAGMA legacy_alter_table = OFF',
] as const;

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;

/** 为 SqliteDb 挂载的内部标识，供 withProjectLock 区分物理文件与独立内存库 */
const DB_LOCK_KEY = Symbol('sqliteDbLockKey');
const DB_RAW = Symbol('sqliteDbRaw');

let memorySeq = 0;

interface TaggedSqliteDb extends Db {
  [DB_LOCK_KEY]: string;
  [DB_RAW]: DatabaseSync;
}

export const sqliteDbKey = (db: Db): string =>
  (db as Partial<TaggedSqliteDb>)[DB_LOCK_KEY] ?? 'sqlite:external';

export const sqliteRawOf = (db: Db): DatabaseSync | null => (db as Partial<TaggedSqliteDb>)[DB_RAW] ?? null;

/** 把参数归一化为 node:sqlite 支持的标量类型（boolean 转为 0/1，undefined 转为 null） */
const toSqlInput = (v: unknown): SQLInputValue => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
};

/** 把单条 query() 返回的行转为普通对象（避免 null-prototype 影响深比较） */
const toPlainRow = <T>(row: unknown): T =>
  row && typeof row === 'object' ? ({ ...(row as Record<string, unknown>) } as T) : (row as T);

/** 包装已打开的 node:sqlite DatabaseSync 为统一的 Db 接口 */
export const fromSqlite = (raw: DatabaseSync, lockKey?: string): Db => {
  const key = lockKey ?? `memory:${++memorySeq}`;
  const db: TaggedSqliteDb = {
    [DB_LOCK_KEY]: key,
    [DB_RAW]: raw,
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      const stmt = raw.prepare(sql);
      const args = (params ?? []).map(toSqlInput);
      const rows = stmt.all(...args);
      return rows.map((r) => toPlainRow<T>(r));
    },
    exec: async (sql: string): Promise<void> => {
      raw.exec(sql);
    },
  };
  return db;
};

export interface SqliteDbHandle {
  db: Db;
  raw: DatabaseSync;
  filename: string;
  close(): void;
}

/**
 * 打开一个 SQLite 数据库连接（`:memory:` 或本地绝对路径）。
 * 打开后立即启用 `PRAGMA foreign_keys = ON`、`PRAGMA legacy_alter_table = OFF` 与 `PRAGMA busy_timeout`。
 */
export const openSqliteDb = (
  filename = ':memory:',
  opts: { busyTimeoutMs?: number; readOnly?: boolean } = {},
): SqliteDbHandle => {
  const raw = opts.readOnly ? new DatabaseSync(filename, { readOnly: true }) : new DatabaseSync(filename);
  try {
    // 引擎级纵深防御：开启 defensive 模式并安装 authorizer，彻底禁止 ATTACH / DETACH 及高危 PRAGMA
    raw.enableDefensive(true);
    raw.setAuthorizer((actionCode, arg1) => {
      if (actionCode === constants.SQLITE_ATTACH || actionCode === constants.SQLITE_DETACH) {
        return constants.SQLITE_DENY;
      }
      if (
        actionCode === constants.SQLITE_PRAGMA &&
        typeof arg1 === 'string' &&
        BLOCKED_PRAGMAS.has(arg1.toLowerCase())
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    const busyMs = Math.max(0, Math.trunc(opts.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS));
    raw.exec(`PRAGMA busy_timeout = ${busyMs}`);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('PRAGMA legacy_alter_table = OFF');
  } catch (e) {
    try {
      raw.close();
    } catch {}
    throw e;
  }
  const lockKey = filename === ':memory:' ? `memory:${++memorySeq}` : `file:${filename}`;
  const db = fromSqlite(raw, lockKey);
  let closed = false;
  return {
    db,
    raw,
    filename,
    close: () => {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
};

// ───── 进程内互斥锁（按“数据库路径 + 项目 ID”隔离） ─────

const heldLocks = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const acquireSqliteMutex = async (key: string, timeoutMs: number): Promise<() => void> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (heldLocks.has(key)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('SQLITE_MUTEX_TIMEOUT');
    await sleep(Math.min(25, left));
  }
  heldLocks.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldLocks.delete(key);
  };
};
