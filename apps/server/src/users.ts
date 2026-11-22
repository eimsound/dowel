// 用户的读写：建用户（管理员直接建、接受邀请、初始化）和用户名规则。
// 登录、会话在 auth.ts；这里是账户数据的入口，路由不直接拼 users 的 SQL。
// 参数用 engines 的 Db 而不是 PlatformDb：这样也能在 db.transaction() 的回调里调用。

import type { InstanceRole } from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';

import { hashPassword, type RawUserRow, toUser, USER_COLUMNS, type User } from './auth.ts';
import { normalizeUsername } from './usernames.ts';

export interface NewUser {
  username: string;
  name: string;
  email?: string | null;
  /** 不给密码时创建的用户暂时不能密码登录（以后由 OIDC 或重置链接设置） */
  password?: string | null;
  role?: InstanceRole;
  mustChangePassword?: boolean;
}

/** 用户名在库里只存小写；比较前统一规范化 */
export { normalizeUsername };

export const usernameTaken = async (db: Db, username: string, exceptId?: string) => {
  // 分开写：PG 里 `$1 is null` 这种用法无法推断参数类型
  const [row] = exceptId
    ? await db.query('select 1 from users where username = $1 and id <> $2', [
        normalizeUsername(username),
        exceptId,
      ])
    : await db.query('select 1 from users where username = $1', [normalizeUsername(username)]);
  return !!row;
};

export const userById = async (db: Db, id: string): Promise<User | null> => {
  const [u] = await db.query<RawUserRow>(
    `select ${USER_COLUMNS}, u.password_hash from users u where u.id = $1`,
    [id],
  );
  return u ? toUser(u) : null;
};

export const userByUsername = async (db: Db, username: string): Promise<User | null> => {
  const [u] = await db.query<RawUserRow>(
    `select ${USER_COLUMNS}, u.password_hash from users u where u.username = $1`,
    [normalizeUsername(username)],
  );
  return u ? toUser(u) : null;
};

export const createUser = async (db: Db, input: NewUser): Promise<User> => {
  const id = newId();
  const email = input.email?.trim() || null;
  await db.query(
    `insert into users (id, username, name, email, password_hash, role, status, must_change_password)
     values ($1, $2, $3, $4, $5, $6, 'active', $7)`,
    [
      id,
      normalizeUsername(input.username),
      input.name.trim(),
      email,
      input.password ? await hashPassword(input.password) : null,
      input.role ?? 'member',
      Boolean(input.mustChangePassword),
    ],
  );
  return (await userById(db, id))!;
};

/** 实例里有没有用户：没有就需要初始化（02-consensus.md 11.1） */
export const countUsers = async (db: Db): Promise<number> => {
  const [row] = await db.query<{ n: number }>('select count(*) as n from users');
  return Number(row?.n ?? 0);
};
