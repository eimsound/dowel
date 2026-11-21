// MSSQL（tedious / mssql）数据库适配器：
// - 参数按 @p1, @p2, ... 绑定，避免跨池裸 BEGIN TRAN；
// - reserve() 基于同配置创建独立单连接 ConnectionPool（max: 1, min: 1），使 Session 级 sp_getapplock、
//   SET LOCK_TIMEOUT、事务（sql.Transaction）与非事务步骤严格绑定在同一个物理连接（@@SPID）上；
// - exec() 通过 splitMssqlBatches() 按独占行 GO 切批后逐批调用 request.batch() 提交。
import { splitMssqlBatches } from '@dowel/core';
import sql from 'mssql';

import type { Db, TxHooks } from '../types.ts';

export const MSSQL_SESSION_SETTINGS = [
  'SET ANSI_NULLS ON',
  'SET QUOTED_IDENTIFIER ON',
  'SET XACT_ABORT ON',
] as const;

const MSSQL_STATE = Symbol('mssqlConnState');

export interface MssqlShadowGuard {
  expectedDb: string;
  mark: string;
}

const SHADOW_GUARDS = new WeakMap<Db, MssqlShadowGuard>();

export const setMssqlShadowGuard = (db: Db, guard: MssqlShadowGuard | null): void => {
  if (guard) SHADOW_GUARDS.set(db, guard);
  else SHADOW_GUARDS.delete(db);
};

export const getMssqlShadowGuard = (db: Db): MssqlShadowGuard | null => SHADOW_GUARDS.get(db) ?? null;

export interface MssqlConnState {
  pool: sql.ConnectionPool;
  config?: sql.config;
  activeTx: sql.Transaction | null;
  requestTimeoutMs: number | null;
}

interface TaggedMssqlDb extends Db {
  [MSSQL_STATE]: MssqlConnState;
}

export const getMssqlState = (db: Db): MssqlConnState | null =>
  (db as Partial<TaggedMssqlDb>)[MSSQL_STATE] ?? null;

export const setMssqlRequestTimeout = (db: Db, ms: number | null): void => {
  const st = getMssqlState(db);
  if (st) st.requestTimeoutMs = ms && ms > 0 ? Math.trunc(ms) : null;
};

/** 从 mssql / tedious 嵌套错误对象中提取 SQL Server 错误号（number） */
export const mssqlErrorNumber = (err: unknown): number | null => {
  if (!err || typeof err !== 'object') return null;
  const e = err as { number?: unknown; originalError?: unknown; precedingErrors?: unknown[] };
  if (typeof e.number === 'number') return e.number;
  if (e.originalError && typeof e.originalError === 'object') {
    const inner =
      (e.originalError as { number?: unknown; info?: { number?: unknown } }).number ??
      (e.originalError as { info?: { number?: unknown } }).info?.number;
    if (typeof inner === 'number') return inner;
  }
  if (Array.isArray(e.precedingErrors)) {
    for (const pe of e.precedingErrors) {
      const n = mssqlErrorNumber(pe);
      if (n !== null) return n;
    }
  }
  return null;
};

/** 提取 mssql / tedious 错误码字符串（如 ELOGIN / ETIMEOUT / ESOCKET / ECONNCLOSED / EREQUEST） */
export const mssqlErrorCode = (err: unknown): string | null => {
  if (!err || typeof err !== 'object') return null;
  const e = err as { code?: unknown; originalError?: { code?: unknown } };
  if (typeof e.code === 'string') return e.code;
  if (typeof e.originalError?.code === 'string') return e.originalError.code;
  return null;
};

const bindParams = (req: sql.Request, params?: unknown[]): void => {
  if (!params?.length) return;
  for (let i = 0; i < params.length; i++) {
    const name = `p${i + 1}`;
    const v = params[i];
    if (v === null || v === undefined) {
      req.input(name, sql.NVarChar(sql.MAX), null);
    } else if (typeof v === 'boolean') {
      req.input(name, sql.Bit, v);
    } else if (typeof v === 'number') {
      if (Number.isInteger(v)) {
        if (v >= -2_147_483_648 && v <= 2_147_483_647) req.input(name, sql.Int, v);
        else req.input(name, sql.BigInt, String(v));
      } else {
        req.input(name, sql.Float, v);
      }
    } else if (typeof v === 'bigint') {
      req.input(name, sql.BigInt, v.toString());
    } else if (typeof v === 'string') {
      req.input(name, sql.NVarChar(sql.MAX), v);
    } else if (v instanceof Uint8Array) {
      req.input(name, sql.VarBinary(sql.MAX), Buffer.from(v));
    } else if (v instanceof Date) {
      req.input(name, sql.DateTimeOffset, v);
    } else {
      req.input(name, sql.NVarChar(sql.MAX), JSON.stringify(v));
    }
  }
};

const withRequestTimeout = async <T>(
  req: sql.Request,
  timeoutMs: number | null,
  run: () => Promise<T>,
): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) return run();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      req.cancel();
    } catch {
      // 忽略取消异常
    }
  }, timeoutMs);
  timer.unref?.();
  try {
    return await run();
  } catch (e) {
    if (timedOut) {
      const err = new Error(`MSSQL 语句执行超过 ${timeoutMs}ms（已取消）`) as Error & { code?: string };
      err.code = 'ETIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

const toPlainRow = <T>(row: unknown): T =>
  row && typeof row === 'object' ? ({ ...(row as Record<string, unknown>) } as T) : (row as T);

/** 将已连接的 mssql ConnectionPool 适配为统一的 Db 接口（传入 config 以启用独立单连接 reserve()） */
export const fromMssql = (pool: sql.ConnectionPool, config?: sql.config): Db => {
  const state: MssqlConnState = {
    pool,
    config,
    activeTx: null,
    requestTimeoutMs: null,
  };

  const makeRequest = (): sql.Request =>
    state.activeTx ? new sql.Request(state.activeTx) : new sql.Request(state.pool);

  const db: TaggedMssqlDb = {
    [MSSQL_STATE]: state,

    query: async <T = Record<string, unknown>>(sqlText: string, params?: unknown[]): Promise<T[]> => {
      const req = makeRequest();
      bindParams(req, params);
      const res = await withRequestTimeout(req, state.requestTimeoutMs, () => req.query(sqlText));
      const rows = res.recordset ?? [];
      return rows.map((r) => toPlainRow<T>(r));
    },

    exec: async (sqlText: string): Promise<void> => {
      const batches = splitMssqlBatches(sqlText);
      for (const batch of batches) {
        const req = makeRequest();
        await withRequestTimeout(req, state.requestTimeoutMs, () => req.batch(batch));
      }
    },
  };

  if (config) {
    db.reserve = async (): Promise<Db> => {
      const dedicatedConfig: sql.config = {
        ...config,
        pool: {
          ...config.pool,
          max: 1,
          min: 1,
        },
      };
      const dedicatedPool = new sql.ConnectionPool(dedicatedConfig);
      dedicatedPool.on('error', () => {});
      try {
        await dedicatedPool.connect();
      } catch (e) {
        await dedicatedPool.close().catch(() => {});
        throw e;
      }
      const one = fromMssql(dedicatedPool, dedicatedConfig);
      let released = false;
      one.release = () => {
        if (released) return;
        released = true;
        void dedicatedPool.close().catch(() => {});
      };
      return one;
    };
  }

  return db;
};

/** 在 MSSQL 连接上运行显式 sql.Transaction（挂到当前 Db state，使内部 query/exec 全部复用同一事务） */
export const runMssqlTransaction = async <T>(
  conn: Db,
  fn: () => Promise<T>,
  hooks: TxHooks = {},
): Promise<T> => {
  const st = getMssqlState(conn);
  if (!st) {
    await conn.exec('BEGIN TRANSACTION');
    let r: T;
    try {
      r = await fn();
      hooks.beforeCommit?.();
      await conn.exec('COMMIT TRANSACTION');
    } catch (e) {
      await conn.exec('IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION').catch(() => {});
      throw e;
    }
    hooks.afterCommit?.();
    return r;
  }
  const tx = new sql.Transaction(st.pool);
  await tx.begin();
  const prev = st.activeTx;
  st.activeTx = tx;
  let r: T;
  try {
    r = await fn();
    hooks.beforeCommit?.();
    await tx.commit();
    st.activeTx = prev;
  } catch (e) {
    st.activeTx = prev;
    await tx.rollback().catch(() => {});
    throw e;
  }
  hooks.afterCommit?.();
  return r;
};

export const pinMssqlSession = async (db: Db): Promise<void> => {
  for (const s of MSSQL_SESSION_SETTINGS) await db.exec(s);
};
