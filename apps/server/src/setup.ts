// 首次初始化：实例里一个用户都没有时，用一次性令牌创建第一个实例管理员（02-consensus.md 11.1）。
// 令牌只放内存，服务重启会重新生成；另一种方式是无人值守，见 autoSetup()。

import { passwordSchema, usernameSchema } from '@dowel/api';
import type { User } from './auth.ts';
import { newToken } from './auth.ts';
import type { PlatformDb } from './db.ts';
import { countUsers, createUser } from './users.ts';

export const newSetupToken = newToken;

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
  return createUser(db, {
    username: username.data,
    name: username.data,
    password: password.data,
    role: 'admin',
  });
};
