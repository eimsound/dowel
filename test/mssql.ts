// 测试用 MSSQL（SQL Server 2019 / 2022 / 2025）辅助封装：
// - 优先读取 globalSetup 注入的共享 `mssqlUrl`；
// - DOWEL_TEST_MSSQL=skip|0|false|none|off 或未设置 MSSQL_VERSION/DOWEL_TEST_MSSQL 时干净跳过，绝不把跳过标记当 URL 或多 worker 并行拉容器；
// - 每个测试通过独立 CREATE DATABASE / DROP DATABASE 隔离。
import { type Db, fromMssql } from '@dowel/engines';
import sql from 'mssql';
import { afterAll, beforeAll, inject } from 'vitest';

import { toMssqlConfig, withMssqlDb } from '../apps/server/src/targets/mssql.ts';
import { mssqlIdent, mssqlLiteral } from '../packages/core/src/mssql/quote.ts';
import { MSSQL_IMAGE, MSSQL_VERSION, type MssqlTestVersion, startMssql } from './mssql-container.ts';

export { MSSQL_IMAGE, MSSQL_VERSION, type MssqlTestVersion };

const SKIP_RE = /^(?:skip|0|false|none|off)$/i;

let fallbackPromise: Promise<{ url: string; stop: () => Promise<void> } | null> | null = null;
let cleanupRegistered = false;

const injectedMssqlUrl = (): string => {
  try {
    return inject('mssqlUrl') ?? '';
  } catch {
    return '';
  }
};

/** 获取全局共享 MSSQL 测试实例的 master 管理连接串；跳过或不可用时返回 null */
export const getMssqlAdminUrl = async (): Promise<string | null> => {
  const given = process.env.DOWEL_TEST_MSSQL?.trim();
  if (given) {
    if (SKIP_RE.test(given)) return null;
    return given;
  }

  const provided = injectedMssqlUrl().trim();
  if (provided) {
    if (SKIP_RE.test(provided)) return null;
    return provided;
  }

  if (!process.env.MSSQL_VERSION?.trim() && !process.env.DOWEL_MSSQL_IMAGE?.trim()) return null;

  fallbackPromise ??= (async () => {
    const started = await startMssql();
    if (started && !cleanupRegistered) {
      cleanupRegistered = true;
      const stop = () => {
        void started.stop().catch(() => {});
      };
      process.once('beforeExit', stop);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    return started;
  })();
  const res = await fallbackPromise;
  return res?.url ?? null;
};

/** 关闭本进程按需回退拉起的 MSSQL 容器（由 globalSetup 托管时无需调用） */
export const stopMssqlContainer = async (): Promise<void> => {
  const p = fallbackPromise;
  fallbackPromise = null;
  if (!p) return;
  const res = await p.catch(() => null);
  await res?.stop().catch(() => {});
};

/** 连接指定 MSSQL URL（返回 Db 与 close()） */
export const connectTestMssql = async (
  url: string,
): Promise<{ db: Db; pool: sql.ConnectionPool; close: () => Promise<void> }> => {
  const config = toMssqlConfig(url, { connectTimeoutSec: 15, requestTimeoutMs: 60_000, maxPool: 2 });
  const pool = new sql.ConnectionPool(config);
  pool.on('error', () => {});
  try {
    await pool.connect();
  } catch (e) {
    await pool.close().catch(() => {});
    throw e;
  }
  return {
    db: fromMssql(pool, config),
    pool,
    close: async () => {
      await pool.close().catch(() => {});
    },
  };
};

/** 在共享 MSSQL 实例上创建一个独立隔离库，close() 时强制切单用户并删除 */
export const createTestMssqlDb = async (
  prefix: string,
): Promise<{ name: string; url: string; db: Db; close: () => Promise<void> }> => {
  const adminUrl = await getMssqlAdminUrl();
  if (!adminUrl) throw new Error('没有可用的 MSSQL 测试实例');
  const name = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = await connectTestMssql(adminUrl);
  try {
    await admin.db.exec(`CREATE DATABASE ${mssqlIdent(name)}`);
  } finally {
    await admin.close();
  }
  const url = withMssqlDb(adminUrl, name);
  const conn = await connectTestMssql(url);
  return {
    name,
    url,
    db: conn.db,
    close: async () => {
      await conn.close();
      const a = await connectTestMssql(adminUrl);
      try {
        const q = mssqlIdent(name);
        await a.db.exec(
          `IF DB_ID(${mssqlLiteral(name)}) IS NOT NULL
           BEGIN
             ALTER DATABASE ${q} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
             DROP DATABASE ${q};
           END`,
        );
      } finally {
        await a.close();
      }
    },
  };
};

/** 在当前测试文件中注册 beforeAll / afterAll：建独立测试库，返回获取句柄的函数 */
export const useTestMssqlDb = (prefix: string) => {
  let handle: Awaited<ReturnType<typeof createTestMssqlDb>> | undefined;
  beforeAll(async () => {
    const adminUrl = await getMssqlAdminUrl();
    if (adminUrl) handle = await createTestMssqlDb(prefix);
  }, 120_000);
  afterAll(async () => {
    await handle?.close();
  }, 60_000);
  return () => handle!;
};
