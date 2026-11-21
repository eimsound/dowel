// 首次初始化：实例里一个用户都没有时，用一次性令牌创建第一个实例管理员（02-consensus.md 11.1）。
// 多副本冷启动时通过 instance_settings('setup_token') 共享同一个初始化令牌，并在创建首个管理员的同一事务中删除；
// 另一种方式是无人值守初始化，见 autoSetup()。

import { passwordSchema, usernameSchema } from '@dowel/api';
import type { Db } from '@dowel/engines';

import type { User } from './auth.ts';
import { newToken } from './auth.ts';
import { isUniqueViolation, type PlatformDb } from './db.ts';
import { decrypt, encrypt, SecretError } from './secrets.ts';
import { countUsers, createUser } from './users.ts';

export const newSetupToken = newToken;

/** 共享初始化令牌在 instance_settings 里的 key */
export const SETUP_TOKEN_KEY = 'setup_token';
/** PG 事务级 advisory lock 键：串行化多副本首次初始化 */
export const SETUP_LOCK_KEY = 'dowel:setup';

type StoredSetupToken = { enc: string } | { plain: string };

const encodeSetupToken = (token: string): StoredSetupToken => {
  try {
    return { enc: encrypt(token) };
  } catch (e) {
    // 测试或未配置 DOWEL_SECRET 的单机环境：降级为明文存储
    if (e instanceof SecretError) return { plain: token };
    throw e;
  }
};

const decodeSetupToken = (value: unknown): string | null => {
  if (typeof value === 'string') return value || null;
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.enc === 'string') {
    try {
      return decrypt(v.enc);
    } catch (e) {
      if (e instanceof SecretError) return null;
      throw e;
    }
  }
  if (typeof v.plain === 'string') return v.plain || null;
  return null;
};

/** 从平台库读取已持久化的共享 setupToken（若尚未写入则 exists = false） */
export const readStoredSetupToken = async (db: Db): Promise<{ exists: boolean; token: string | null }> => {
  const [row] = await db.query<{ value: unknown }>('select value from instance_settings where key = $1', [
    SETUP_TOKEN_KEY,
  ]);
  if (!row) return { exists: false, token: null };
  return { exists: true, token: decodeSetupToken(row.value) };
};

/**
 * 持久化并获取多副本共享的初始化令牌（仅在实例尚无用户时写入）。
 * 多个副本同时冷启动时，通过 PG 事务锁 + INSERT ON CONFLICT DO NOTHING 保证拿到完全一致的令牌；
 * 若已有密文因 DOWEL_SECRET 变更无法解密，安全降级替换为新令牌。
 */
export const ensureSetupToken = async (
  db: PlatformDb,
  candidate = newSetupToken(),
): Promise<string | null> => {
  if (!(await needsSetup(db))) return null;
  return db.transaction(async (tx) => {
    if (db.dialect === 'pg') {
      await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
    }
    if ((await countUsers(tx)) > 0) return null;
    const encoded = JSON.stringify(encodeSetupToken(candidate));
    await tx.query(
      `insert into instance_settings (key, value) values ($1, $2::text::jsonb)
       on conflict (key) do nothing`,
      [SETUP_TOKEN_KEY, encoded],
    );
    const stored = await readStoredSetupToken(tx);
    if (stored.token) return stored.token;
    // 已有密文无法解密（例如 DOWEL_SECRET 轮换后尚未初始化）：安全重写为新的共享令牌
    await tx.query(
      `insert into instance_settings (key, value) values ($1, $2::text::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [SETUP_TOKEN_KEY, encoded],
    );
    return candidate;
  });
};

/** 实例里还没有用户，需要初始化 */
export const needsSetup = async (db: PlatformDb) => (await countUsers(db)) === 0;

/** 令牌比较：长度不同时直接失败，避免 timingSafeEqual 抛异常 */
export const setupTokenMatches = (given: string, expected: string | null) => {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};

/**
 * 无人值守初始化：启动时给了 DOWEL_ADMIN_USERNAME / DOWEL_ADMIN_PASSWORD，
 * 并且实例里还没有用户，就直接建管理员。已经有用户时什么都不做。
 * 多副本同时冷启动时通过事务锁与唯一冲突兜底保持幂等（其余副本优雅返回 null）。
 * 两个值都按和接口一样的规则校验（用户名还会转成小写）；不合法直接抛错，让服务启动失败。
 */
export const autoSetup = async (
  db: PlatformDb,
  env: NodeJS.ProcessEnv = process.env,
): Promise<User | null> => {
  const rawUsername = env.DOWEL_ADMIN_USERNAME?.trim();
  const rawPassword = env.DOWEL_ADMIN_PASSWORD;
  if (!rawUsername || !rawPassword) return null;
  const username = usernameSchema.safeParse(rawUsername);
  if (!username.success)
    throw new Error(`DOWEL_ADMIN_USERNAME 不合法：${username.error.issues[0]?.message ?? '格式错误'}`);
  const password = passwordSchema.safeParse(rawPassword);
  if (!password.success)
    throw new Error(`DOWEL_ADMIN_PASSWORD 不合法：${password.error.issues[0]?.message ?? '格式错误'}`);
  if (!(await needsSetup(db))) return null;
  try {
    return await db.transaction(async (tx) => {
      if (db.dialect === 'pg') {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
      }
      if ((await countUsers(tx)) > 0) return null;
      const user = await createUser(tx, {
        username: username.data,
        name: username.data,
        password: password.data,
        role: 'admin',
      });
      await tx.query('delete from instance_settings where key = $1', [SETUP_TOKEN_KEY]);
      return user;
    });
  } catch (e) {
    if (isUniqueViolation(e) && !(await needsSetup(db))) return null;
    throw e;
  }
};
