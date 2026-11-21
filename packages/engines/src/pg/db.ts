// 访问 PG 的最小接口（服务端和测试都用 postgres.js 适配）。
import type { Db } from '../types.ts';

export type { Db };

/**
 * 影子库会话固定的参数（04-ir-design.md 1.6）。
 * 规范形式里的字面量自带完整信息；search_path 为空时所有非 pg_catalog 的名字都带 schema 前缀。
 */
export const SESSION_SETTINGS = [
  "SET TimeZone = 'UTC'",
  "SET DateStyle = 'ISO, MDY'",
  "SET IntervalStyle = 'postgres'",
  "SET search_path = ''",
  'SET extra_float_digits = 3',
  // 与 pg_dump 相同：函数可能在它引用的表之前创建，创建时不检查函数体
  'SET check_function_bodies = false',
];

export const pinSession = async (db: Db) => {
  for (const s of SESSION_SETTINGS) await db.exec(s);
};

/** 适配 postgres.js（只用到 unsafe / reserve，不引入依赖） */
export const fromPostgres = (sql: {
  unsafe: (query: string, params?: never[]) => PromiseLike<unknown>;
  reserve?: () => PromiseLike<{
    unsafe: (query: string, params?: never[]) => PromiseLike<unknown>;
    release(): void;
  }>;
}): Db => {
  const db: Db = {
    query: async <T>(q: string, params?: unknown[]) => (await sql.unsafe(q, params as never[])) as T[],
    exec: async (q: string) => {
      await sql.unsafe(q);
    },
  };
  // reserve() 拿到的就是连接池里的单个连接，包装成同样的 Db；release 归还它
  if (sql.reserve)
    db.reserve = async () => {
      const reserved = await sql.reserve!();
      const one = fromPostgres(reserved);
      one.release = () => reserved.release();
      return one;
    };
  return db;
};
