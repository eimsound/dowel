// 授权：角色 × 范围（实例 / 组的全部项目 / 项目 / 环境）× 对象（用户 / 组）。
// 角色是项目角色（查看者 / 编辑者 / 项目管理员）或“执行者”（P5a）；环境范围只用于执行者。
import type { DefaultAccess, GrantInfo, GrantRole, GrantScopeKind, GrantSubjectKind, Role } from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';

import { defaultRoleOf, type GrantRow, type ProjectRow } from './roles.ts';

export interface GrantInput {
  subjectKind: GrantSubjectKind;
  subjectId: string;
  role: GrantRole;
  scopeKind: GrantScopeKind;
  scopeId: string;
  createdBy?: string | null;
  /** 授予者此刻是不是实例管理员（“仅限执行者”的生产环境只认这种执行者，见 policy.ts 的 isExecutor） */
  byInstanceAdmin?: boolean;
}

/** subject 的信息一起查出来，界面直接显示名字（用户显示名 / 组名） */
const SELECT = `select gr.id, gr.subject_kind as "subjectKind", gr.subject_id as "subjectId", gr.role,
    gr.scope_kind as "scopeKind", gr.scope_id as "scopeId", gr.created_at as "createdAt",
    gr.by_instance_admin as "byInstanceAdmin", e.name as "environmentName",
    coalesce(u.name, g.name) as "subjectName", coalesce(u.username, g.slug) as "subjectSlug"
  from grants gr
  left join users u on gr.subject_kind = 'user' and u.id = gr.subject_id
  left join groups g on gr.subject_kind = 'group' and g.id = gr.subject_id
  left join environments e on gr.scope_kind = 'environment' and e.id = gr.scope_id`;

type GrantRowWithSubject = Pick<GrantRow, 'subjectKind' | 'subjectId' | 'role' | 'scopeKind' | 'scopeId'> & {
  id: string;
  createdAt: string;
  subjectName: string | null;
  subjectSlug: string | null;
  byInstanceAdmin: boolean;
  environmentName: string | null;
};

const toInfo = (r: GrantRowWithSubject): GrantInfo => ({
  id: r.id,
  subject: {
    kind: r.subjectKind,
    id: r.subjectId,
    // 对象被删掉时（列上没有外键）仍然显示一个占位名，避免界面空白
    name: r.subjectName ?? '（已删除）',
    slug: r.subjectSlug ?? r.subjectId,
  },
  role: r.role,
  scopeKind: r.scopeKind,
  scopeId: r.scopeId,
  environmentName: r.environmentName ?? null,
  byInstanceAdmin: r.byInstanceAdmin === true,
  createdAt: r.createdAt,
});

export const listGrants = async (
  db: Db,
  scopeKind: GrantScopeKind,
  scopeId: string,
): Promise<GrantInfo[]> => {
  const rows = await db.query<GrantRowWithSubject>(
    `${SELECT} where gr.scope_kind = $1 and gr.scope_id = $2 order by gr.created_at, gr.id`,
    [scopeKind, scopeId],
  );
  return rows.map(toInfo);
};

/** 项目的授权：项目范围的，加上这个项目各环境上的执行者授权 */
export const listProjectGrants = async (db: Db, pid: string): Promise<GrantInfo[]> => {
  const rows = await db.query<GrantRowWithSubject>(
    `${SELECT} where (gr.scope_kind = 'project' and gr.scope_id = $1)
        or (gr.scope_kind = 'environment' and e.project_id = $1)
      order by gr.created_at, gr.id`,
    [pid],
  );
  return rows.map(toInfo);
};

export const grantById = async (db: Db, id: string): Promise<GrantInfo | null> => {
  const [row] = await db.query<GrantRowWithSubject>(`${SELECT} where gr.id = $1`, [id]);
  return row ? toInfo(row) : null;
};

export const insertGrant = async (db: Db, input: GrantInput): Promise<string> => {
  const id = newId();
  await db.query(
    `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id, created_by, by_instance_admin)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.subjectKind,
      input.subjectId,
      input.role,
      input.scopeKind,
      input.scopeId,
      input.createdBy ?? null,
      input.byInstanceAdmin === true,
    ],
  );
  return id;
};

export const updateGrantRole = async (db: Db, id: string, role: Role) => {
  await db.query('update grants set role = $2 where id = $1', [id, role]);
};

export const deleteGrant = async (db: Db, id: string) => {
  await db.query('delete from grants where id = $1', [id]);
};

/** 授权对象是否存在（用户或组）：允许授权给任意用户 / 任意组，但不能是不存在的 */
export const subjectExists = async (db: Db, kind: GrantSubjectKind, id: string): Promise<boolean> => {
  const [row] =
    kind === 'user'
      ? await db.query('select 1 from users where id = $1', [id])
      : await db.query('select 1 from groups where id = $1', [id]);
  return !!row;
};

/** 项目的“来自组默认权限的成员”：组里的所有人，以及他们通过默认权限拿到的角色 */
export const defaultMembers = async (db: Db, project: ProjectRow): Promise<DefaultAccess[]> => {
  const rows = await db.query<{
    userId: string;
    username: string;
    name: string;
    role: 'admin' | 'member';
  }>(
    `select u.id as "userId", u.username, u.name, gm.role
       from group_members gm join users u on u.id = gm.user_id
      where gm.group_id = $1 order by u.name, u.username`,
    [project.groupId],
  );
  const def = defaultRoleOf(project);
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    name: r.name,
    // 组管理员的项目角色是 admin（来源 2），组成员的角色来自默认权限
    role: r.role === 'admin' ? 'admin' : def,
    groupAdmin: r.role === 'admin',
  }));
};

/**
 * 项目还有没有管理员：组管理员，或通过授权（用户 / 组）拿到 admin 的人。
 * 实例管理员不参与——他们本来就不在项目成员列表里，算进来的话这条保护永远不会触发
 * （迁移出来的组可能一个组管理员都没有，这条检查才有意义）。
 * 一条 SQL 判断是否存在，不做 N+1。
 */
export const projectHasAdmin = async (db: Db, project: ProjectRow): Promise<boolean> => {
  const rows = await db.query<{ ok: number }>(
    `select 1 as ok from group_members where group_id = $1 and role = 'admin'
     union all
     select 1 from grants gr
      where gr.role = 'admin'
        and (gr.scope_kind = 'instance'
             or (gr.scope_kind = 'group' and gr.scope_id = $1)
             or (gr.scope_kind = 'project' and gr.scope_id = $2))
        and (gr.subject_kind = 'user'
             or exists (select 1 from group_members gm where gm.group_id = gr.subject_id))
     limit 1`,
    [project.groupId, project.id],
  );
  return rows.length > 0;
};
