// 审批人与执行权的资格判断（按审批时锁内重新读到的成员关系），以及计算资格需要的用户角色上下文 / 项目受众的读取。
import type { RequestApprovers, ResolvedPolicy } from '@dowel/api';
import type { Db } from '@dowel/engines';

import { can, userActor } from '../authz.ts';
import { inList } from '../db.ts';
import { isExecutor } from '../policy.ts';
import { effectiveRole, type GrantRow, type ProjectRow, type RoleContext } from '../roles.ts';
import type { Role } from '../rooms.ts';
import { loadTokenRules, tokenRulesFor } from '../token-rules.ts';
import type { StageSpec } from './flow.ts';

// ───── 资格判断 ─────

/** 角色上下文 + 显示名（全部启用的用户一次读出：审批人列表、通知） */
export interface UserContext extends RoleContext {
  name: string;
}

/**
 * 指定用户（只算启用的）的角色上下文：三条查询（用户、组成员、和他们有关的授权），在内存里拼。
 * 调用方总是给出一小批用户（要通知的人、项目的“受众”，见 loadAudience），不读全实例。
 */
export const loadRoleContexts = async (db: Db, ids: string[]): Promise<Map<string, UserContext>> => {
  if (!ids.length) return new Map();
  const list = inList(ids);
  const users = await db.query<{ id: string; role: string; name: string }>(
    `select id, role, name from users where status = 'active' and id in (${list})`,
    ids,
  );
  const members = await db.query<{ groupId: string; userId: string; role: 'admin' | 'member' }>(
    `select group_id as "groupId", user_id as "userId", role from group_members where user_id in (${list})`,
    ids,
  );
  const grants = await db.query<GrantRow>(
    `select gr.subject_kind as "subjectKind", gr.subject_id as "subjectId", gr.role,
            gr.scope_kind as "scopeKind", gr.scope_id as "scopeId", gr.by_instance_admin as "byInstanceAdmin",
            e.project_id as "envProjectId"
       from grants gr
       left join environments e on gr.scope_kind = 'environment' and e.id = gr.scope_id
      where (gr.subject_kind = 'user' and gr.subject_id in (${list}))
         or (gr.subject_kind = 'group'
             and gr.subject_id in (select group_id from group_members where user_id in (${list})))`,
    ids,
  );
  // “谁能创建令牌”的规则（P6）：所有用户共用一份，被允许创建令牌的人对项目有只读可见性
  const tokenRules = await loadTokenRules(db);
  const out = new Map<string, UserContext>();
  for (const u of users)
    out.set(u.id, {
      userId: u.id,
      instanceAdmin: u.role === 'admin',
      groups: new Map(),
      grants: [],
      tokenRules,
      name: u.name,
    });
  for (const m of members) out.get(m.userId)?.groups.set(m.groupId, m.role);
  for (const g of grants) {
    if (g.subjectKind === 'user') out.get(g.subjectId)?.grants.push(g);
    else for (const u of out.values()) if (u.groups.has(g.subjectId)) u.grants.push(g);
  }
  return out;
};

/**
 * 项目的“受众”：可能看得到这个项目的用户（实例管理员、所属组的成员、范围覆盖这个项目的授权对象——本人或授权组的成员）
 * 的角色上下文。审批人必须能看到项目，所以算审批人、通知审批人只需要看这些人，不用读全实例的用户（第一轮审查）。
 */
export const loadAudience = async (
  db: Db,
  p: { id: string; groupId: string },
): Promise<Map<string, UserContext>> => {
  const rows = await db.query<{ id: string }>(
    `select id from users where status = 'active' and role = 'admin'
     union select user_id as id from group_members where group_id = $1
     union select gr.subject_id as id from grants gr
            left join environments e on gr.scope_kind = 'environment' and e.id = gr.scope_id
      where gr.subject_kind = 'user'
        and (gr.scope_kind = 'instance' or (gr.scope_kind = 'group' and gr.scope_id = $1)
             or (gr.scope_kind = 'project' and gr.scope_id = $2) or e.project_id = $2)
     union select m.user_id as id from grants gr
            join group_members m on m.group_id = gr.subject_id
            left join environments e on gr.scope_kind = 'environment' and e.id = gr.scope_id
      where gr.subject_kind = 'group'
        and (gr.scope_kind = 'instance' or (gr.scope_kind = 'group' and gr.scope_id = $1)
             or (gr.scope_kind = 'project' and gr.scope_id = $2) or e.project_id = $2)`,
    [p.groupId, p.id],
  );
  // P6：“谁能创建令牌”的组条件也给只读可见性——这些组的成员也是受众（最终是否看得到仍由 effectiveRole 判断）
  const rules = await loadTokenRules(db);
  const groupIds = [
    ...new Set(
      Object.values(tokenRulesFor(rules, p)).flatMap((r) => (r ? r.groups.map((g) => g.groupId) : [])),
    ),
  ];
  const extra = groupIds.length
    ? await db.query<{ id: string }>(
        `select user_id as id from group_members where group_id in (${inList(groupIds)})`,
        groupIds,
      )
    : [];
  return loadRoleContexts(db, [...new Set([...rows, ...extra].map((r) => r.id))]);
};

/** 判断资格需要的环境信息：项目、环境、当前生效策略、方向 */
export interface StageScope {
  project: ProjectRow;
  env: { id: string; production: boolean };
  resolved: ResolvedPolicy;
  direction: 'up' | 'down' | 'switch';
}

/** 这个人现在能不能在这个环境上执行（回滚 / 切换）：满足生效的“谁能执行”，或是执行者（审批不给执行权） */
export const hasExecRight = (rc: RoleContext, s: StageScope): boolean => {
  const role = effectiveRole(rc, s.project);
  if (!role) return false;
  const exec = isExecutor(
    rc,
    { groupId: s.project.groupId, projectId: s.project.id, envId: s.env.id },
    s.env.production && s.resolved.whoCanExecute.value === 'executor',
  );
  const actor = userActor({ id: rc.userId, role: rc.instanceAdmin ? 'admin' : 'member' });
  const resource = {
    kind: 'environment' as const,
    role,
    production: s.env.production,
    execPolicy: s.resolved.whoCanExecute.value,
    isExecutor: exec,
  };
  if (s.direction === 'down') return can(actor, 'environment.rollback', resource);
  if (s.direction === 'switch')
    return can(actor, 'environment.execute', resource) && can(actor, 'environment.rollback', resource);
  return can(actor, 'environment.execute', resource);
};

/**
 * 这个人是不是这个环节的审批人（按现在的成员关系）。前提是能看到这个项目（可见性规则沿用 P1）：
 * 看不到项目的人不会收到通知、也不能审批——要让 DBA 组审批，给它执行者或查看者授权。
 * 范围的含义：group_admins = 项目所属组（现在的组）的组管理员；project_admins = 生效角色是项目管理员的人
 * （含组管理员和实例管理员，和其他地方的“项目管理员”同一个定义）；executors = 这个环境的执行者；
 * group_members / group_admins_of = 指定组的成员 / 组管理员；users = 指定的用户；can_execute = 有执行权限的人（默认流程）。
 */
export const eligibleFor = (rc: RoleContext, spec: StageSpec, s: StageScope): boolean => {
  const role: Role | null = effectiveRole(rc, s.project);
  if (!role) return false;
  const a = spec.approvers;
  switch (a.kind) {
    case 'group_admins':
      return rc.groups.get(s.project.groupId) === 'admin';
    case 'project_admins':
      return role === 'admin';
    case 'executors':
      return isExecutor(
        rc,
        { groupId: s.project.groupId, projectId: s.project.id, envId: s.env.id },
        s.env.production && s.resolved.whoCanExecute.value === 'executor',
      );
    case 'group_members':
      return rc.groups.has(a.groupId);
    case 'group_admins_of':
      return rc.groups.get(a.groupId) === 'admin';
    case 'users':
      return a.userIds.includes(rc.userId);
    case 'can_execute':
      return hasExecRight(rc, s);
  }
  return false;
};

/** 审批人范围的中文说明（names：组 / 用户的显示名） */
export const approversLabel = (a: RequestApprovers, names: Record<string, string>): string => {
  switch (a.kind) {
    case 'group_admins':
      return '项目所属组的组管理员';
    case 'project_admins':
      return '项目管理员';
    case 'executors':
      return '这个环境的执行者';
    case 'group_members':
      return `组“${names[a.groupId] ?? a.groupId}”的成员`;
    case 'group_admins_of':
      return `组“${names[a.groupId] ?? a.groupId}”的组管理员`;
    case 'users':
      return a.userIds.map((u) => names[u] ?? u).join('、');
    case 'can_execute':
      return '有执行权限的人';
  }
  return '';
};
