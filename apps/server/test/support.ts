// 测试辅助：公开注册接口已经删除（只接受邀请注册），测试里直接写库建用户，再走登录接口拿会话。
import { addColumn, all, createSchema, createTable, type Model } from '@dowel/core';

import type { PlatformDb } from '../src/db.ts';
import type { Rooms } from '../src/rooms.ts';
import { createUser, type NewUser } from '../src/users.ts';

export const PASSWORD = 'password1';

/** 直接在平台库里建一个用户；默认密码 PASSWORD、显示名与用户名相同 */
export const makeUser = (db: PlatformDb, username: string, options: Partial<NewUser> = {}) =>
  createUser(db, { username, name: username, password: PASSWORD, ...options });

/** 直接改项目的工作副本（替换房间里的模型，不走 WebSocket）；fn 就地修改传入的模型副本 */
export const editModel = async (
  rooms: Pick<Rooms, 'model' | 'replace'>,
  db: PlatformDb,
  pid: string,
  fn: (m: Model) => void,
) => {
  const [b] = await db.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  const m = structuredClone((await rooms.model(b!.id)).model);
  fn(m);
  await rooms.replace(b!.id, 'test', m, 'seed');
};

/**
 * 给项目的工作副本加一张表。空的工作副本发布会得到 422“没有变更”，需要发布版本的测试先调用它。
 */
export const addTable = (
  rooms: Pick<Rooms, 'model' | 'replace'>,
  db: PlatformDb,
  pid: string,
  name = 'orders',
) =>
  editModel(rooms, db, pid, (m) => {
    const schema = all(m, 'schema').find((s) => s.name === 'public')?.id ?? createSchema(m, 'public');
    const t = createTable(m, schema, name);
    addColumn(m, t, { name: 'id', type: 'bigint', notNull: true });
  });
