// 测试里访问 PG：PG_URL 为空表示没有可用的 PG（没有 Docker），相关测试用 skipIf(!PG_URL) 跳过。
import { type Db, fromPostgres } from '@dowel/engines';
import postgres from 'postgres';
import { afterAll, beforeAll, inject } from 'vitest';

export const PG_URL = inject('pgUrl');

/** PG_URL 所在实例上另一个库的连接串 */
export const dbUrl = (name: string) => {
  const u = new URL(PG_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

export const connect = (url: string) => {
  const sql = postgres(url, { max: 1, onnotice: () => {}, prepare: false });
  return { db: fromPostgres(sql), close: () => sql.end({ timeout: 5 }) };
};

/** 在测试实例上建一个新库（名字带随机后缀，测试文件之间互不干扰），close 时删掉 */
export const createTestDb = async (
  prefix: string,
): Promise<{ url: string; db: Db; close: () => Promise<void> }> => {
  const name = `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = connect(PG_URL);
  await admin.db.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = dbUrl(name);
  const c = connect(url);
  return {
    url,
    db: c.db,
    close: async () => {
      await c.close();
      const a = connect(PG_URL);
      await a.db.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.close();
    },
  };
};

/** 在当前测试文件里注册 beforeAll / afterAll：建一个新库，返回取连接的函数 */
export const useTestDb = (prefix: string) => {
  let t: Awaited<ReturnType<typeof createTestDb>> | undefined;
  beforeAll(async () => {
    if (PG_URL) t = await createTestDb(prefix);
  });
  afterAll(async () => {
    await t?.close();
  });
  return () => t!.db;
};
