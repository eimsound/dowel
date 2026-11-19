// 组：一层的用户集合，可以拥有项目（02-consensus.md 11.2）。
// 这里的查询不涉及权限判断，路由负责用 authz.ts 的 can() 判断。
import type { DefaultRole, GroupRole, ProjectCreation } from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { uniqueSlug } from './usernames.ts';

export interface GroupRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  defaultRole: DefaultRole;
  projectCreation: ProjectCreation;
  createdAt: string;
}

export const GROUP_COLUMNS = `g.id, g.slug, g.name, g.description,
  cast(g.default_role as text) as "defaultRole", cast(g.project_creation as text) as "projectCreation",
  g.created_at as "createdAt"`;

export const groupById = async (db: Db, id: string): Promise<GroupRow | null> => {
  const [row] = await db.query<GroupRow>(`select ${GROUP_COLUMNS} from groups g where g.id = $1`, [id]);
  return row ?? null;
};

export const groupBySlug = async (db: Db, slug: string): Promise<GroupRow | null> => {
  const [row] = await db.query<GroupRow>(`select ${GROUP_COLUMNS} from groups g where g.slug = $1`, [
    slug.trim().toLowerCase(),
  ]);
  return row ?? null;
};

export interface GroupCounts {
  memberCount: number;
  projectCount: number;
}

/**
 * 按组统计成员数和项目数，返回 group id → 数量。
 * 传 groupId 时只统计这一个组（详情接口用），不传时一次分组统计所有组（列表用）。
 */
export const groupCounts = async (db: Db, groupId?: string): Promise<Map<string, GroupCounts>> => {
  const where = groupId === undefined ? '' : ' where group_id = $1';
  const params = groupId === undefined ? [] : [groupId];
  const members = await db.query<{ groupId: string; n: number }>(
    `select group_id as "groupId", count(*) as n from group_members${where} group by group_id`,
    params,
  );
  const projects = await db.query<{ groupId: string; n: number }>(
    `select group_id as "groupId", count(*) as n from projects${where} group by group_id`,
    params,
  );
  const out = new Map<string, GroupCounts>();
  for (const r of members) out.set(r.groupId, { memberCount: Number(r.n), projectCount: 0 });
  for (const r of projects) {
    const cur = out.get(r.groupId);
    out.set(r.groupId, {
      memberCount: cur?.memberCount ?? 0,
      projectCount: Number(r.n),
    });
  }
  return out;
};

export const groupRoleOf = async (db: Db, groupId: string, userId: string): Promise<GroupRole | null> => {
  const [row] = await db.query<{ role: GroupRole }>(
    'select role from group_members where group_id = $1 and user_id = $2',
    [groupId, userId],
  );
  return row?.role ?? null;
};

/** 组 slug 全实例唯一 */
export const slugTaken = async (db: Db, slug: string, exceptId?: string) => {
  // 分开写：PG 里 `$1 is null` 推断不出参数类型
  const [row] = exceptId
    ? await db.query('select 1 from groups where slug = $1 and id <> $2', [slug, exceptId])
    : await db.query('select 1 from groups where slug = $1', [slug]);
  return !!row;
};

/** 项目 slug 在组内唯一 */
export const projectSlugTaken = async (db: Db, groupId: string, slug: string, exceptId?: string) => {
  const [row] = (await exceptId)
    ? await db.query('select 1 from projects where group_id = $1 and slug = $2 and id <> $3', [
        groupId,
        slug,
        exceptId,
      ])
    : await db.query('select 1 from projects where group_id = $1 and slug = $2', [groupId, slug]);
  return !!row;
};

/**
 * 建项目时决定 slug（普通建项目与向导共用）：显式给出时要求组内唯一（409），
 * 由名字生成时冲突自动加后缀。
 */
export const pickProjectSlug = async (
  db: Db,
  groupId: string,
  name: string,
  slug?: string,
): Promise<string> => {
  if (slug) {
    if (await projectSlugTaken(db, groupId, slug))
      throw new HTTPException(409, { message: '这个组里已经有相同的标识' });
    return slug;
  }
  const taken = new Set(
    (await db.query<{ slug: string }>('select slug from projects where group_id = $1', [groupId])).map(
      (r) => r.slug,
    ),
  );
  return uniqueSlug(name, taken, 'project');
};
