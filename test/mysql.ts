// 测试用 MySQL 数据库隔离封装：
// - 全局单容器由 test/global-setup.ts（通过 test/mysql-container.ts）统一启停，并通过 inject('mysqlUrl') 注入到各 worker；
// - 未设置 MYSQL_VERSION / DOWEL_MYSQL_IMAGE / 有效 DOWEL_TEST_MYSQL 时 MYSQL_URL 为空字符串，相关测试自动跳过；
// - 每个测试或测试套件通过独立 CREATE DATABASE / DROP DATABASE 隔离，互不干扰。
import { type Db, fromMysql2, MYSQL_POOL_DEFAULTS, parseMysqlVersion } from '@dowel/engines';
import { createPool } from 'mysql2/promise';
import { afterAll, beforeAll, inject } from 'vitest';

export const MYSQL_URL = inject('mysqlUrl');

interface ManagedMysql {
  adminUrl: string;
  version: string;
  versionNum: number;
}

let cachedMeta: ManagedMysql | null = null;
let loadingMeta: Promise<ManagedMysql | null> | null = null;

export const ensureMysqlInstance = async (): Promise<ManagedMysql | null> => {
  if (!MYSQL_URL) return null;
  if (cachedMeta) return cachedMeta;
  loadingMeta ??= (async () => {
    const conn = connectMysqlPool(MYSQL_URL);
    try {
      const [r] = await conn.db.query<{ v: string }>('SELECT VERSION() AS v');
      const parsed = parseMysqlVersion(String(r?.v ?? '8.4.0'));
      cachedMeta = { adminUrl: MYSQL_URL, ...parsed };
      return cachedMeta;
    } finally {
      await conn.close();
    }
  })();
  return loadingMeta;
};

export const mysqlDbUrl = (adminUrl: string, dbName: string): string => {
  const u = new URL(adminUrl);
  u.pathname = `/${encodeURIComponent(dbName)}`;
  return u.toString();
};

export const connectMysqlPool = (url: string) => {
  const u = new URL(url);
  const host = u.hostname.startsWith('[') && u.hostname.endsWith(']') ? u.hostname.slice(1, -1) : u.hostname;
  const pool = createPool({
    ...MYSQL_POOL_DEFAULTS,
    host,
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

/** 在全局测试 MySQL 实例里创建独立隔离库，close() 时自动清理该库 */
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

/** 在 Vitest 测试文件内注册独立的 MySQL 测试库，并在套件结束时自动销毁该库（全局容器由 globalSetup 统一回收） */
export const useMysqlTestDb = (prefix: string) => {
  let handle: MysqlTestDb | null = null;
  beforeAll(async () => {
    handle = await createMysqlTestDb(prefix);
  }, 120_000);
  afterAll(async () => {
    await handle?.close();
    handle = null;
  }, 60_000);
  return () => handle;
};
