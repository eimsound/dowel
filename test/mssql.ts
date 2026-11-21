// 测试用 MSSQL（SQL Server 2019 / 2022 / 2025）容器封装：
// - 优先使用 DOWEL_TEST_MSSQL 连接串；否则按 MSSQL_VERSION=2019|2022|2025（默认 2022）用 @testcontainers/mssqlserver 拉起全局单容器；
// - 每个测试通过独立 CREATE DATABASE / DROP DATABASE 隔离，避免同一进程内并行拉起多个 2GiB 容器。
import { type Db, fromMssql } from '@dowel/engines';
import { MSSQLServerContainer, type StartedMSSQLServerContainer } from '@testcontainers/mssqlserver';
import sql from 'mssql';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';

import { toMssqlConfig, withMssqlDb } from '../apps/server/src/targets/mssql.ts';
import { mssqlIdent, mssqlLiteral } from '../packages/core/src/mssql/quote.ts';

export type MssqlTestVersion = '2019' | '2022' | '2025';

export const MSSQL_VERSION: MssqlTestVersion =
  process.env.MSSQL_VERSION === '2019' || process.env.MSSQL_VERSION === '2025'
    ? process.env.MSSQL_VERSION
    : '2022';

export const MSSQL_IMAGE =
  process.env.DOWEL_MSSQL_IMAGE ?? `mcr.microsoft.com/mssql/server:${MSSQL_VERSION}-latest`;

const TEST_PASSWORD = process.env.DOWEL_MSSQL_PASSWORD ?? 'DowelTest!2026';

let containerPromise: Promise<{
  adminUrl: string;
  container: StartedMSSQLServerContainer | null;
} | null> | null = null;
let cleanupRegistered = false;

/** 获取或按需启动全局唯一 MSSQL 测试容器，返回带 trustServerCertificate=true 的 master 管理连接串 */
export const getMssqlAdminUrl = async (): Promise<string | null> => {
  if (process.env.DOWEL_TEST_MSSQL) return process.env.DOWEL_TEST_MSSQL;
  containerPromise ??= (async () => {
    try {
      await getContainerRuntimeClient();
    } catch (e) {
      if (process.env.CI) throw e;
      console.warn(
        `\n⚠ 没有可用的 Docker（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）：跳过所有需要 MSSQL 的测试。\n`,
      );
      return null;
    }
    const container = await new MSSQLServerContainer(MSSQL_IMAGE)
      .acceptLicense()
      .withPassword(TEST_PASSWORD)
      .start();
    const host = container.getHost();
    const port = container.getPort();
    const user = encodeURIComponent(container.getUsername());
    const pass = encodeURIComponent(container.getPassword());
    const adminUrl = `mssql://${user}:${pass}@${host}:${port}/master?encrypt=true&trustServerCertificate=true`;
    if (!cleanupRegistered) {
      cleanupRegistered = true;
      const stop = () => {
        void container.stop().catch(() => {});
      };
      process.once('beforeExit', stop);
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
    return { adminUrl, container };
  })();
  const res = await containerPromise;
  return res?.adminUrl ?? null;
};

/** 主动关闭由本模块拉起的共享 MSSQL 容器（测试套件结束后可调用） */
export const stopMssqlContainer = async (): Promise<void> => {
  const p = containerPromise;
  containerPromise = null;
  if (!p) return;
  const res = await p.catch(() => null);
  await res?.container?.stop().catch(() => {});
};

/** 连接指定 MSSQL URL（返回 Db 与 close()） */
export const connectTestMssql = async (
  url: string,
): Promise<{ db: Db; pool: sql.ConnectionPool; close: () => Promise<void> }> => {
  const config = toMssqlConfig(url, { connectTimeoutSec: 15, requestTimeoutMs: 60_000, maxPool: 2 });
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
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
