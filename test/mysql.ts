// 测试用 MySQL 容器与数据库隔离封装：
// - 支持 DOWEL_TEST_MYSQL 直接指向外部 MySQL 实例（如 mysql://root:pass@127.0.0.1:3306/mysql）；
// - 否则使用 @testcontainers/mysql 启动全局单容器，支持 MYSQL_VERSION=8.4|9.7（默认 8.4，镜像 mysql:${ver}）；
// - 每个测试或测试套件通过独立 CREATE DATABASE / DROP DATABASE 隔离，互不干扰。
import { type Db, fromMysql2, MYSQL_POOL_DEFAULTS, parseMysqlVersion } from '@dowel/engines';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { createPool } from 'mysql2/promise';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';

const MYSQL_VERSION = process.env.MYSQL_VERSION ?? '8.4';
export const MYSQL_IMAGE = process.env.DOWEL_MYSQL_IMAGE ?? `mysql:${MYSQL_VERSION}`;

interface ManagedMysql {
  adminUrl: string;
  version: string;
  versionNum: number;
  container: StartedMySqlContainer | null;
}

let shared: ManagedMysql | null = null;
let starting: Promise<ManagedMysql | null> | null = null;
let activeRefs = 0;

export const ensureMysqlInstance = async (): Promise<ManagedMysql | null> => {
  if (shared) return shared;
  starting ??= (async () => {
    const given = process.env.DOWEL_TEST_MYSQL;
    if (given) {
      const pool = createPool({ uri: given, ...MYSQL_POOL_DEFAULTS, connectionLimit: 1 });
      try {
        const db = fromMysql2(pool);
        const [r] = await db.query<{ v: string }>('SELECT VERSION() AS v');
        const parsed = parseMysqlVersion(String(r?.v ?? '8.4.0'));
        shared = { adminUrl: given, ...parsed, container: null };
        return shared;
      } finally {
        await pool.end();
      }
    }

    try {
      await getContainerRuntimeClient();
    } catch (e) {
      if (process.env.CI) throw e;
      console.warn(
        `\n⚠ 没有可用的 Docker（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）：跳过需要 MySQL 的测试。` +
          '\n  启动 Docker 或设置 DOWEL_TEST_MYSQL=mysql://root:pass@127.0.0.1:3306/mysql。\n',
      );
      return null;
    }

    const container = await new MySqlContainer(MYSQL_IMAGE)
      .withDatabase('mysql')
      .withUsername('dowel')
      .withUserPassword('dowel-test-secret')
      .withRootPassword('dowel-root-secret')
      .start();

    const adminUrl = `mysql://root:${encodeURIComponent(container.getRootPassword())}@${container.getHost()}:${container.getPort()}/mysql`;
    const pool = createPool({ uri: adminUrl, ...MYSQL_POOL_DEFAULTS, connectionLimit: 1 });
    try {
      const db = fromMysql2(pool);
      const [r] = await db.query<{ v: string }>('SELECT VERSION() AS v');
      const parsed = parseMysqlVersion(String(r?.v ?? '8.4.0'));
      shared = { adminUrl, ...parsed, container };
      return shared;
    } finally {
      await pool.end();
    }
  })();
  return starting;
};

export const stopMysqlInstance = async (): Promise<void> => {
  const cur = shared;
  shared = null;
  starting = null;
  if (cur?.container) {
    await cur.container.stop().catch(() => {});
  }
};

export const mysqlDbUrl = (adminUrl: string, dbName: string): string => {
  const u = new URL(adminUrl);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
};

export const connectMysqlPool = (url: string) => {
  const u = new URL(url);
  const pool = createPool({
    ...MYSQL_POOL_DEFAULTS,
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\/+/, '')) || undefined,
    connectionLimit: 4,
  });
  return { db: fromMysql2(pool), pool, close: () => pool.end() };
};

export interface MysqlTestDb {
  name: string;
  url: string;
  adminUrl: string;
  version: string;
  versionNum: number;
  db: Db;
  close: () => Promise<void>;
}

/** 在全局测试 MySQL 容器里创建独立隔离库，close() 时自动清理库 */
export const createMysqlTestDb = async (prefix: string): Promise<MysqlTestDb | null> => {
  const inst = await ensureMysqlInstance();
  if (!inst) return null;
  const name = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = connectMysqlPool(inst.adminUrl);
  try {
    await admin.db.exec(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  } finally {
    await admin.close();
  }
  const url = mysqlDbUrl(inst.adminUrl, name);
  const conn = connectMysqlPool(url);
  return {
    name,
    url,
    adminUrl: inst.adminUrl,
    version: inst.version,
    versionNum: inst.versionNum,
    db: conn.db,
    close: async () => {
      await conn.close();
      const a = connectMysqlPool(inst.adminUrl);
      try {
        await a.db.exec(`DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await a.close();
      }
    },
  };
};

/** 在 Vitest 测试文件内注册独立的 MySQL 测试库，并在套件结束时自动销毁库与容器 */
export const useMysqlTestDb = (prefix: string) => {
  let handle: MysqlTestDb | null = null;
  beforeAll(async () => {
    activeRefs++;
    handle = await createMysqlTestDb(prefix);
  }, 120_000);
  afterAll(async () => {
    await handle?.close();
    handle = null;
    activeRefs = Math.max(0, activeRefs - 1);
    if (activeRefs === 0) await stopMysqlInstance();
  }, 60_000);
  return () => handle;
};
