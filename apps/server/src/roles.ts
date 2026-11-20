// 生效的项目角色（02-consensus.md 11.2）：取下面四项里最高的一个，结果为空表示项目对这个用户不可见。
// 1. 实例管理员 → admin；
// 2. 项目所属组的组管理员 → admin；
// 3. 项目所属组的成员 → 项目的 default_role（没设就用组的 default_role，none 表示没有）；
// 4. 授权：对象是这个用户或他所在的任一组，范围是这个项目、这个组或整个实例。
//
// 计算放在 JS 里做：每个用户的组成员关系和授权都很小（自托管、单公司），
// 一次读出来可以同时用于项目列表里的所有项目，也比在两种方言里拼一段等价的 SQL 更好读。
import type { DefaultRole, GroupRole, ProjectListItem, Role } from '@dowel/api';
import type { Db } from '@dowel/engines';
import type { PlatformDb } from './db.ts';

/** 项目的关键列：生效角色计算要用组的默认权限，路径要用组的 slug */
export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  dialect: string;
  groupId: string;
  groupSlug: string;
  groupName: string;
  groupDefaultRole: DefaultRole;
  /** 项目自己的默认权限；null 表示沿用组 */
  projectDefaultRole: DefaultRole | null;
  branch: string;
  createdAt: string;
  /** schema 范围：null 表示全部（dowel 永远排除） */
  schemas: string[] | null;
}

/** cast(... as text)：SQLite 里这一列可能按列类型推断，PG 里是 text，统一成字符串 */
const PROJECT_COLUMNS = `p.id, p.name, p.slug, p.dialect, p.group_id as "groupId",
  g.slug as "groupSlug", g.name as "groupName",
  cast(g.default_role as text) as "groupDefaultRole",
  cast(p.default_role as text) as "projectDefaultRole",
  b.id as branch, p.created_at as "createdAt", p.schemas`;

const PROJECT_FROM = `from projects p
  join groups g on g.id = p.group_id
  join branches b on b.project_id = p.id and b.name = 'main'`;

export const projectRow = async (db: Db, pid: string): Promise<ProjectRow | null> => {
  const [row] = await db.query<ProjectRow>(`select ${PROJECT_COLUMNS} ${PROJECT_FROM} where p.id = $1`, [
    pid,
  ]);
  return row ?? null;
};

export const projectRows = (db: Db, scope?: { groupId: string }): Promise<ProjectRow[]> =>
  db.query<ProjectRow>(
    scope
      ? `select ${PROJECT_COLUMNS} ${PROJECT_FROM} where p.group_id = $1 order by p.name`
      : `select ${PROJECT_COLUMNS} ${PROJECT_FROM} order by g.name, p.name`,
    scope ? [scope.groupId] : [],
  );

/**
 * 授权的最小形状（roles.ts 只用来算角色，不关心是谁在什么时候授的）。
 * role = executor 是“执行者”授权（P5a）：只给项目的只读可见性（查看者），特权操作由 policy.ts 的 isExecutor 判断。
 * 环境范围的授权只有执行者；envProjectId 是那个环境所属的项目（可见性按项目算）。
 */
export interface GrantRow {
  subjectKind: 'user' | 'group';
  subjectId: string;
  role: Role | 'executor';
  scopeKind: 'instance' | 'group' | 'project' | 'environment';
  scopeId: string;
  /** 授权时授予者是实例管理员（“仅限执行者”的生产环境只认这种执行者） */
  byInstanceAdmin?: boolean;
  envProjectId?: string | null;
}

/** 一个用户的角色输入：组成员关系 + 和他有关的授权；算多个项目时只读一次 */
export interface RoleContext {
  userId: string;
  instanceAdmin: boolean;
  /** group id → admin / member */
  groups: Map<string, GroupRole>;
  grants: GrantRow[];
}

export const loadRoleContext = async (db: Db, user: { id: string; role: string }): Promise<RoleContext> => {
  const memberships = await db.query<{ groupId: string; role: GroupRole }>(
    'select group_id as "groupId", role from group_members where user_id = $1',
    [user.id],
  );
  // 组授权的范围是“这个用户所在的任一组”，用子查询一次拿到，不用在 JS 里拼 IN 列表
  const grants = await db.query<GrantRow>(
    `select gr.subject_kind as "subjectKind", gr.subject_id as "subjectId", gr.role,
            gr.scope_kind as "scopeKind", gr.scope_id as "scopeId", gr.by_instance_admin as "byInstanceAdmin",
            e.project_id as "envProjectId"
       from grants gr
       left join environments e on gr.scope_kind = 'environment' and e.id = gr.scope_id
      where (gr.subject_kind = 'user' and gr.subject_id = $1)
         or (gr.subject_kind = 'group'
             and gr.subject_id in (select group_id from group_members where user_id = $1))`,
    [user.id],
  );
  return {
    userId: user.id,
    instanceAdmin: user.role === 'admin',
    groups: new Map(memberships.map((m) => [m.groupId, m.role])),
    grants,
  };
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** 算生效角色需要的项目字段（列表、房间刷新都不需要名字和分支） */
export type ProjectRoleInput = Pick<ProjectRow, 'id' | 'groupId' | 'groupDefaultRole' | 'projectDefaultRole'>;

/** 项目的默认权限：项目另设了就用项目的，否则用组的 */
export const defaultRoleOf = (p: Pick<ProjectRow, 'projectDefaultRole' | 'groupDefaultRole'>): DefaultRole =>
  p.projectDefaultRole ?? p.groupDefaultRole;

/** 纯函数：一个项目对一个用户的生效角色；null 表示不可见（所有地方都用这一份规则） */
export const effectiveRole = (rc: RoleContext, p: ProjectRoleInput): Role | null => {
  let best: Role | null = null;
  const raise = (role: Role | null) => {
    if (role && (best === null || RANK[role] > RANK[best])) best = role;
  };

  if (rc.instanceAdmin) raise('admin');
  const membership = rc.groups.get(p.groupId);
  if (membership === 'admin') raise('admin');
  if (membership) {
    const def = defaultRoleOf(p);
    if (def !== 'none') raise(def);
  }
  for (const g of rc.grants) {
    const inScope =
      g.scopeKind === 'instance' ||
      (g.scopeKind === 'group' && g.scopeId === p.groupId) ||
      (g.scopeKind === 'project' && g.scopeId === p.id) ||
      // 环境范围只有执行者授权：按环境所属的项目给可见性
      (g.scopeKind === 'environment' && g.role === 'executor' && g.envProjectId === p.id);
    if (!inScope) continue;
    const applies = g.subjectKind === 'user' ? g.subjectId === rc.userId : rc.groups.has(g.subjectId);
    // 执行者不因此获得模型的编辑权限，只能只读查看项目（查看者）：它要看得到环境、版本和脚本才能执行
    if (applies) raise(g.role === 'executor' ? 'viewer' : g.role);
  }
  return best;
};

/** 列表接口用的形状：带上组信息和调用者的项目角色 */
export const toProjectListItem = (p: ProjectRow, role: Role): ProjectListItem => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  dialect: p.dialect,
  role,
  createdAt: p.createdAt,
  group: { id: p.groupId, slug: p.groupSlug, name: p.groupName },
});

/** 只看得到（生效角色非空）的项目 */
export const visibleProjects = async (
  db: Db,
  rc: RoleContext,
  scope?: { groupId: string },
): Promise<ProjectListItem[]> => {
  const rows = await projectRows(db, scope);
  return rows.flatMap((p) => {
    const role = effectiveRole(rc, p);
    return role ? [toProjectListItem(p, role)] : [];
  });
};

/**
 * 一次批量刷新里共享的缓存：用户角色上下文按 user 缓存，项目按 id 缓存。
 * Rooms.refreshLoaded 用它，避免每个 peer 重复查库。
 */
export interface RoleLookup {
  contexts: Map<string, RoleContext>;
  projects: Map<string, ProjectRow>;
}

/**
 * 单个项目的生效角色：WebSocket 升级 / join 复查 / 房间刷新都用这一份实现。
 * 传入 lookup 时复用整次刷新里已经读过的角色上下文和项目。
 */
export const effectiveProjectRole = async (
  db: PlatformDb,
  user: { id: string; role: string },
  pid: string,
  lookup?: RoleLookup,
): Promise<Role | null> => {
  let project = lookup?.projects.get(pid);
  if (!project) {
    project = (await projectRow(db, pid)) ?? undefined;
    if (!project) return null;
    lookup?.projects.set(pid, project);
  }
  let rc = lookup?.contexts.get(user.id);
  if (!rc) {
    rc = await loadRoleContext(db, user);
    lookup?.contexts.set(user.id, rc);
  }
  return effectiveRole(rc, project);
};
