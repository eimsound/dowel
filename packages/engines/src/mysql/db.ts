// MySQL 数据库适配器：封装 mysql2/promise 连接池与独占连接。
// 强制 multipleStatements: false，exec() 经由词法切分器逐条执行语句。
import { splitMysqlStatements } from '@dowel/core';
import type { Pool, PoolConnection, PoolOptions } from 'mysql2/promise';

import type { Db } from '../types.ts';

/** MySQL 会话固定参数（UTC 时区、严格模式、实时 information_schema 统计） */
export const MYSQL_SESSION_SETTINGS = [
  "SET SESSION time_zone = '+00:00'",
  "SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
  'SET SESSION information_schema_stats_expiry = 0',
] as const;

/** mysql2/promise 连接池安全默认项 */
export const MYSQL_POOL_DEFAULTS: Partial<PoolOptions> = {
  multipleStatements: false,
  timezone: 'Z',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  namedPlaceholders: false,
  charset: 'utf8mb4',
};

const DESTROY_CONN = Symbol('mysqlDestroyConn');

interface DestroyableDb extends Db {
  [DESTROY_CONN]?: () => void;
}

/** 销毁异常独占连接（例如 RELEASE_LOCK 失败时防止会话级锁随连接归还到连接池泄漏） */
export const destroyMysqlConn = (db: Db | null | undefined): boolean => {
  const fn = (db as DestroyableDb | null | undefined)?.[DESTROY_CONN];
  if (!fn) return false;
  fn();
  return true;
};

type MysqlQueryable = Pick<Pool | PoolConnection, 'query'> & {
  getConnection?: () => Promise<PoolConnection>;
  release?: () => void;
  destroy?: () => void;
};

const execSingle = async (q: MysqlQueryable, sql: string): Promise<void> => {
  const stmts = splitMysqlStatements(sql);
  for (const stmt of stmts) {
    await q.query(stmt);
  }
};

/** 将 mysql2/promise 的 Pool 或 PoolConnection 适配为统一的 Db 接口 */
export const fromMysql2 = (poolOrConn: MysqlQueryable): Db => {
  const db: DestroyableDb = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      const [rows] = params !== undefined ? await poolOrConn.query(sql, params) : await poolOrConn.query(sql);
      return Array.isArray(rows) ? (rows as T[]) : [];
    },
    exec: async (sql: string): Promise<void> => {
      await execSingle(poolOrConn, sql);
    },
  };

  if (typeof poolOrConn.getConnection === 'function') {
    db.reserve = async () => {
      const conn = await poolOrConn.getConnection!();
      let released = false;
      const wrapped = fromMysql2(conn) as DestroyableDb;
      wrapped.release = () => {
        if (released) return;
        released = true;
        conn.release();
      };
      wrapped[DESTROY_CONN] = () => {
        if (released) return;
        released = true;
        conn.destroy();
      };
      return wrapped;
    };
  } else if (typeof poolOrConn.release === 'function') {
    let released = false;
    db.release = () => {
      if (released) return;
      released = true;
      poolOrConn.release!();
    };
    if (typeof poolOrConn.destroy === 'function') {
      db[DESTROY_CONN] = () => {
        if (released) return;
        released = true;
        poolOrConn.destroy!();
      };
    }
  }

  return db;
};

export const pinMysqlSession = async (db: Db): Promise<void> => {
  for (const s of MYSQL_SESSION_SETTINGS) await db.exec(s);
};
