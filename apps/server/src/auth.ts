// 最小的内置认证：用户名 + 密码（scrypt），会话令牌存哈希，cookie 传递。
// 实验性项目不需要 SSO 等功能，暂不引入 Better Auth（2026-11-18 决定，见 02-consensus.md）。
// 邮箱只是用户资料里的一个字段，不是登录凭据（02-consensus.md 11.1）。
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import type { InstanceRole, UserStatus } from '@dowel/api';
import { newId } from '@dowel/core';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { PlatformDb } from './db.ts';
import { clientIp, type SecurityConfig, securityConfigFromEnv } from './security.ts';
import { normalizeUsername } from './usernames.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const COOKIE = 'dowel_session';
const SESSION_DAYS = 30;
/** 多久更新一次 last_seen_at：每个请求都写一次没必要 */
const SEEN_EVERY_MS = 60_000;

/** 当前登录用户（HTTP 和 WebSocket 共用） */
export interface User {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: InstanceRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  /** 是否设置了密码；密码哈希本身绝不出现在响应里 */
  hasPassword: boolean;
}

/** 查询用户时统一用这组列，保证 HTTP 响应和 WebSocket 里的形状一致 */
export const USER_COLUMNS = `u.id, u.username, u.email, u.name, u.role, u.status,
  u.created_at as "createdAt", u.last_login_at as "lastLoginAt"`;

/** 把查询里的 password_hash 换成 hasPassword：哈希值不能离开这一层 */
export const toUser = (row: User & { password_hash: string | null }): User => {
  const { password_hash, ...u } = row;
  return { ...u, hasPassword: !!password_hash };
};

export const hashPassword = async (pw: string): Promise<string> => {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
};

export const verifyPassword = async (pw: string, stored: string): Promise<boolean> => {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(got, expected);
};

/** 会话令牌、邀请令牌都只存哈希 */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** 新令牌：32 字节随机数，base64url 便于放进链接 */
export const newToken = () => randomBytes(32).toString('base64url');

export type LoginResult = { ok: true; user: User } | { ok: false; reason: 'invalid' | 'disabled' };

/**
 * 用户不存在 / 没有密码时用来“陪跑”的假哈希：失败也要付同样的 scrypt 代价，
 * 否则可以按响应时间判断用户名是否存在。惰性生成，避免模块加载时就跑 scrypt。
 */
let timingHash: string | null = null;
const dummyPasswordHash = async () =>
  (timingHash ??= await hashPassword(randomBytes(16).toString('base64url')));

/** 登录成功时更新 last_login_at（初始化、接受邀请后直接登录也算） */
export const markLogin = async (db: PlatformDb, userId: string) => {
  const at = new Date().toISOString();
  await db.query('update users set last_login_at = $2 where id = $1', [userId, at]);
  return at;
};

/**
 * 用户名 + 密码登录。停用的用户不能登录（返回 disabled，路由据此给 403）。
 * 登录成功时更新 last_login_at。
 */
export const login = async (db: PlatformDb, username: string, password: string): Promise<LoginResult> => {
  const [u] = await db.query<User & { password_hash: string | null }>(
    `select ${USER_COLUMNS}, u.password_hash from users u where u.username = $1`,
    [normalizeUsername(username)],
  );
  // 没有密码（以后的 OIDC 用户）和密码错误一样处理；没有用户时也拿假哈希跑一次，
  // 这样两条失败路径的耗时差不多，不能按响应时间判断用户名是否存在。
  const stored = u?.password_hash ?? (await dummyPasswordHash());
  const passwordOk = await verifyPassword(password, stored);
  if (!u?.password_hash || !passwordOk) return { ok: false, reason: 'invalid' };
  if (u.status !== 'active') return { ok: false, reason: 'disabled' };
  const lastLoginAt = await markLogin(db, u.id);
  return { ok: true, user: { ...toUser(u), lastLoginAt } };
};

/** 登录 / 初始化 / 接受邀请后开一个新会话 */
export const startSession = async (
  db: PlatformDb,
  c: Context,
  user: User,
  security: SecurityConfig = securityConfigFromEnv(),
) => {
  // 会话令牌轮换：请求里如果还带着旧 cookie，先删掉旧会话再发新的
  const old = getCookie(c, COOKIE);
  if (old) await db.query('delete from sessions where token_hash = $1', [hashToken(old)]);
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.query(
    `insert into sessions (id, token_hash, user_id, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      newId(),
      hashToken(token),
      user.id,
      expires.toISOString(),
      c.req.header('user-agent')?.slice(0, 300) ?? null,
      clientIp(c, security),
    ],
  );
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', expires });
};

export const endSession = async (db: PlatformDb, c: Context) => {
  const token = getCookie(c, COOKIE);
  if (token) await db.query('delete from sessions where token_hash = $1', [hashToken(token)]);
  deleteCookie(c, COOKIE, { path: '/' });
};

/** 当前请求带的会话令牌（改密码时用来保留当前会话） */
export const sessionToken = (c: Context) => getCookie(c, COOKIE);

/** 吊销一个用户的会话；except 给出时保留那一个（改密码时保留当前会话） */
export const revokeSessions = async (db: PlatformDb, userId: string, except?: string) => {
  if (except) {
    await db.query('delete from sessions where user_id = $1 and token_hash <> $2', [
      userId,
      hashToken(except),
    ]);
    return;
  }
  await db.query('delete from sessions where user_id = $1', [userId]);
};

/**
 * 用会话令牌换用户：会话未过期**并且**用户是 active。
 * 停用用户时虽然会删掉他的会话，这里再查一次状态，保证漏掉的令牌也立即失效。
 */
export const userOfToken = async (db: PlatformDb, token: string | undefined): Promise<User | null> => {
  if (!token) return null;
  const [u] = await db.query<User & { password_hash: string | null; lastSeen: string | null }>(
    `select ${USER_COLUMNS}, u.password_hash, s.last_seen_at as "lastSeen" from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > $2 and u.status = 'active'`,
    [hashToken(token), new Date()],
  );
  if (!u) return null;
  const { lastSeen, ...user } = u;
  // last_seen_at 只用来在会话列表里显示最近活动，不必每个请求都写
  if (!lastSeen || Date.now() - Date.parse(lastSeen) > SEEN_EVERY_MS)
    await db.query('update sessions set last_seen_at = $2 where token_hash = $1', [
      hashToken(token),
      new Date().toISOString(),
    ]);
  return toUser(user);
};

export const currentUser = (db: PlatformDb, c: Context) => userOfToken(db, sessionToken(c));
