// 用户和组的选择器：所有已登录用户都能用（组本来就对所有人可见）。
// 只返回公开信息：用户是显示名 + 用户名，组是组名 + slug。
import type { Directory, DirectoryEntry } from '@dowel/api';
import type { Hono } from 'hono';

import type { AppContext, Env } from './context.ts';

const LIMIT = 20;

export const registerDirectory = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/directory', async (c) => {
    const q = c.req.query('q')?.trim().toLowerCase() ?? '';
    // 条件按 q 是否为空拼，避免 PG 推断不出 `$1 is null` 的参数类型
    const users = await db.query<DirectoryEntry>(
      `select id, name, username as slug from users where status = 'active'
         ${q ? 'and (lower(username) like $1 or lower(name) like $1)' : ''}
       order by name, username limit ${LIMIT}`,
      q ? [`%${q}%`] : [],
    );
    const groups = await db.query<DirectoryEntry>(
      `select id, name, slug from groups
         ${q ? 'where lower(slug) like $1 or lower(name) like $1' : ''}
       order by name, slug limit ${LIMIT}`,
      q ? [`%${q}%`] : [],
    );
    return c.json<Directory>({ users, groups });
  });
};
