// 执行策略的存储与鉴权接线（P5a，ADR 0005）。合并规则和严格程度在 @dowel/api 的 policy.ts（纯函数，界面共用）；
// 这里只负责：从平台库读写四层配置、算某个环境的生效策略、判断调用者是不是这个范围的“执行者”。
//
// 存储：exec_policies(scope_kind, scope_id, policy json)，每个范围一行。实例 / 组 / 项目层是 LayerPolicy
// （生产 / 非生产各一套），环境层是它自己的那一套（PolicySettings）；字段不出现 = 继承。前置环境在 environments.prerequisite_id。
//
// 改策略算不算特权操作：**收紧不算，放宽算**。放宽（任何字段的生效值变宽、审批流程不再包含原流程、去掉或换掉前置环境）
// 削弱了环境保护——GLOSSARY 对特权操作的定义——所以除了这一层的管理身份，还要满足这一层**改动前**生效的“谁能执行”：
// 设成“仅限执行者”之后，不是执行者的组管理员 / 项目管理员不能自己把它撤掉，否则“仅限执行者”就形同虚设。
import {
  type EnvPolicyView,
  type LayerPolicy,
  layerPolicySchema,
  normalizeSettings,
  type PolicyInput,
  type PolicyNames,
  type PolicySettings,
  pickSet,
  policySettingsSchema,
  type ResolvedPolicy,
  resolvePolicy,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { type EnvAction, isEnvConfigAction } from './authz.ts';
import { inList, type PlatformDb } from './db.ts';
import { effectiveRole, loadRoleContext, type ProjectRow, projectRow, type RoleContext } from './roles.ts';
import type { Role } from './rooms.ts';

/**
 * 执行策略的所有写入（四层配置、改生产标记、转组时的固定、前置环境、删除被引用的环境）都在这把锁里做：
 * 一个平台库事务，事务里重新读当前值 → 校验 / 放宽检测 → 写入 → 严格审计，读和写之间不会插进另一次写入
 * （否则一次收紧可能被另一个基于旧状态、没经过放宽检查的写入覆盖）。
 * - PG：事务级 advisory lock（pg_advisory_xact_lock），所有策略写入串行；量很小，全局一把锁最简单，也覆盖跨层的组合；
 * - SQLite：平台库的事务本来就互斥（db.ts 的 exclusive + BEGIN IMMEDIATE）。
 * fn 里只能用 tx，不能再用 db（SQLite 上会等自己持有的互斥锁，死锁）；也不要在里面连外部的库。
 */
export const POLICY_LOCK_KEY = 'dowel.exec_policy';

/**
 * 锁内重新读访问信息：项目**当前**所属的组、调用者的角色上下文（组成员关系、授权）和项目角色。
 * 策略写入要用它，不能用请求开始时（锁外）读到的：转组和改策略都在执行策略锁里，锁外读到的组可能已经换了——
 * 用旧组的组层校验、算执行者身份和放宽权限，等于绕过了转组时的固定。看不见项目了就 404。
 */
export const accessIn = async (
  tx: Db,
  user: { id: string; role: string },
  pid: string,
): Promise<{ project: ProjectRow; rc: RoleContext; role: Role }> => {
  const project = await projectRow(tx, pid);
  const rc = project ? await loadRoleContext(tx, user) : null;
  const role = project && rc ? effectiveRole(rc, project) : null;
  if (!project || !rc || !role) throw new HTTPException(404, { message: '项目不存在' });
  return { project, rc, role };
};
export const withPolicyLock = <T>(db: PlatformDb, fn: (tx: Db) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    if (db.dialect === 'pg') await tx.query('select pg_advisory_xact_lock(hashtext($1))', [POLICY_LOCK_KEY]);
    return fn(tx);
  });

export type PolicyScopeKind = 'instance' | 'group' | 'project' | 'environment';

/** 一个项目用到的全部配置：实例、所属组、项目本身，以及它每个环境的环境层 */
export interface PolicyStore {
  instance: LayerPolicy | null;
  group: LayerPolicy | null;
  project: LayerPolicy | null;
  environments: Map<string, PolicySettings>;
}

/**
 * 库里的值只由校验过的接口写入；解析不了说明数据被改坏了。**宁可拒绝也不放宽**：抛 500，而不是当作“没设置”
 * （那会让被改坏的“仅限执行者”变成默认档位）。
 */
const parseLayer = (raw: unknown, where: string): LayerPolicy => {
  const r = layerPolicySchema.safeParse(raw);
  if (!r.success) {
    console.error(`执行策略数据无法解析（${where}）`, r.error.issues[0]);
    throw new HTTPException(500, { message: '执行策略数据损坏，请联系实例管理员' });
  }
  return r.data;
};
const parseSettings = (raw: unknown, where: string): PolicySettings => {
  const r = policySettingsSchema.safeParse(raw);
  if (!r.success) {
    console.error(`执行策略数据无法解析（${where}）`, r.error.issues[0]);
    throw new HTTPException(500, { message: '执行策略数据损坏，请联系实例管理员' });
  }
  return r.data;
};

/** 一次查出项目用到的四层配置（实例、组、项目、项目的所有环境） */
export const loadPolicies = async (db: Db, p: { id: string; groupId: string }): Promise<PolicyStore> => {
  const rows = await db.query<{ scopeKind: PolicyScopeKind; scopeId: string; policy: unknown }>(
    `select scope_kind as "scopeKind", scope_id as "scopeId", policy from exec_policies
      where scope_kind = 'instance'
         or (scope_kind = 'group' and scope_id = $1)
         or (scope_kind = 'project' and scope_id = $2)
         or (scope_kind = 'environment' and scope_id in (select id from environments where project_id = $2))`,
    [p.groupId, p.id],
  );
  const store: PolicyStore = { instance: null, group: null, project: null, environments: new Map() };
  for (const r of rows) {
    const where = `${r.scopeKind}:${r.scopeId}`;
    if (r.scopeKind === 'environment') store.environments.set(r.scopeId, parseSettings(r.policy, where));
    else store[r.scopeKind] = parseLayer(r.policy, where);
  }
  return store;
};

/** 读一层（实例 / 组 / 项目）的配置；没有为空配置 */
export const loadLayer = async (
  db: Db,
  kind: 'instance' | 'group' | 'project',
  id: string,
): Promise<LayerPolicy> => {
  const [row] = await db.query<{ policy: unknown }>(
    'select policy from exec_policies where scope_kind = $1 and scope_id = $2',
    [kind, id],
  );
  return row ? parseLayer(row.policy, `${kind}:${id}`) : { production: {}, nonProduction: {} };
};

const emptyLayer = (l: LayerPolicy) =>
  !Object.keys(normalizeSettings(l.production)).length &&
  !Object.keys(normalizeSettings(l.nonProduction)).length;

/** 写一层：整层替换；全空时删掉这一行（= 全部继承） */
export const saveLayer = async (
  db: Db,
  kind: PolicyScopeKind,
  id: string,
  policy: LayerPolicy | PolicySettings,
  userId: string | null,
) => {
  const isEnv = kind === 'environment';
  const value = isEnv
    ? normalizeSettings(policy as PolicySettings)
    : {
        production: normalizeSettings((policy as LayerPolicy).production),
        nonProduction: normalizeSettings((policy as LayerPolicy).nonProduction),
      };
  const empty = isEnv ? !Object.keys(value).length : emptyLayer(value as LayerPolicy);
  if (empty) {
    await db.query('delete from exec_policies where scope_kind = $1 and scope_id = $2', [kind, id]);
    return;
  }
  await db.query(
    `insert into exec_policies (scope_kind, scope_id, policy, updated_by, updated_at)
     values ($1, $2, $3::text::jsonb, $4, $5)
     on conflict (scope_kind, scope_id) do update
       set policy = excluded.policy, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [kind, id, JSON.stringify(value), userId, new Date().toISOString()],
  );
};

/** 删除范围时清理它的策略（范围是多态的，没有外键） */
export const deletePolicies = async (db: Db, kind: PolicyScopeKind, ids: string[]) => {
  if (!ids.length) return;
  await db.query(`delete from exec_policies where scope_kind = $1 and scope_id in (${inList(ids, 2)})`, [
    kind,
    ...ids,
  ]);
};

/** 某个环境的四层输入（按它的生产标记选好那一套） */
export const envInput = (
  s: PolicyStore,
  env: { id: string; production: boolean },
  override?: PolicySettings,
): PolicyInput => ({
  instance: pickSet(s.instance, env.production),
  group: pickSet(s.group, env.production),
  project: pickSet(s.project, env.production),
  environment: override ?? s.environments.get(env.id),
});

/** 上级三层（不含环境层），用于环境层的写入校验和改生产标记时的固定 */
export const upperInput = (s: PolicyStore, production: boolean): PolicyInput => ({
  instance: pickSet(s.instance, production),
  group: pickSet(s.group, production),
  project: pickSet(s.project, production),
});

export const resolveEnv = (s: PolicyStore, env: { id: string; production: boolean }): ResolvedPolicy =>
  resolvePolicy(envInput(s, env), env.production);

/** 判断“执行者”用的目标：环境（envId 有值）或某一层（组层只看 group / instance 范围的授权，以此类推） */
export interface ExecutorTarget {
  groupId: string;
  projectId?: string;
  envId?: string;
}

/**
 * 调用者是不是这个范围的执行者：执行者授权（对象是本人或他所在的组）的范围覆盖目标。
 * onlyInstanceAdminGrants：目标是“仅限执行者”的生产环境时，只认实例管理员授予的执行者（02-consensus.md 11.2 的例外）。
 * 授权时记下的 by_instance_admin 是事实，之后授予者身份变化不影响；反过来，策略之后才收紧成“仅限执行者”，
 * 原来由项目管理员授予的执行者在生产环境上也就自动不算了。
 */
export const isExecutor = (rc: RoleContext, t: ExecutorTarget, onlyInstanceAdminGrants: boolean): boolean =>
  rc.grants.some((g) => {
    if (g.role !== 'executor') return false;
    if (onlyInstanceAdminGrants && !g.byInstanceAdmin) return false;
    const subject = g.subjectKind === 'user' ? g.subjectId === rc.userId : rc.groups.has(g.subjectId);
    if (!subject) return false;
    switch (g.scopeKind) {
      case 'instance':
        return true;
      case 'group':
        return g.scopeId === t.groupId;
      case 'project':
        return t.projectId !== undefined && g.scopeId === t.projectId;
      case 'environment':
        return t.envId !== undefined && g.scopeId === t.envId;
    }
    return false;
  });

/** 环境的鉴权输入：生效策略 + 调用者是不是这个环境的执行者 */
export interface EnvAuth {
  resolved: ResolvedPolicy;
  isExecutor: boolean;
}

export const envAuthOf = (
  s: PolicyStore,
  rc: RoleContext,
  project: { id: string; groupId: string },
  env: { id: string; production: boolean },
): EnvAuth => {
  const resolved = resolveEnv(s, env);
  return {
    resolved,
    isExecutor: isExecutor(
      rc,
      { groupId: project.groupId, projectId: project.id, envId: env.id },
      env.production && resolved.whoCanExecute.value === 'executor',
    ),
  };
};

/** 审批人范围里引用到的组 / 用户的显示名（配置页直接显示，不用另查） */
export const policyNames = async (db: Db, settings: PolicySettings[]): Promise<PolicyNames> => {
  const groups = new Set<string>();
  const users = new Set<string>();
  for (const s of settings)
    for (const st of s.approval ?? []) {
      const a = st.approvers;
      if (a.kind === 'group_members' || a.kind === 'group_admins_of') groups.add(a.groupId);
      if (a.kind === 'users') for (const u of a.userIds) users.add(u);
    }
  const out: PolicyNames = {};
  if (groups.size) {
    const ids = [...groups];
    for (const r of await db.query<{ id: string; name: string }>(
      `select id, name from groups where id in (${inList(ids)})`,
      ids,
    ))
      out[r.id] = r.name;
  }
  if (users.size) {
    const ids = [...users];
    for (const r of await db.query<{ id: string; name: string; username: string }>(
      `select id, name, username from users where id in (${inList(ids)})`,
      ids,
    ))
      out[r.id] = `${r.name}（${r.username}）`;
  }
  return out;
};

/** 审批人范围里引用的组 / 用户必须存在（写入时检查，422） */
export const assertApproversExist = async (db: Db, settings: PolicySettings[]) => {
  const names = await policyNames(db, settings);
  for (const s of settings)
    for (const st of s.approval ?? []) {
      const a = st.approvers;
      const missing =
        (a.kind === 'group_members' || a.kind === 'group_admins_of') && !names[a.groupId]
          ? '组'
          : a.kind === 'users' && a.userIds.some((u) => !names[u])
            ? '用户'
            : null;
      if (missing) throw new HTTPException(422, { message: `审批流程里引用的${missing}不存在` });
    }
};

export type { EnvPolicyView };

const LAYER_NAME = { instance: '实例', group: '组', project: '项目', environment: '环境' } as const;

/** 403 的说明：按环境生效的“谁能执行”说清楚谁能做，并说明来自哪一层 */
export const deniedMessage = (action: EnvAction, auth: EnvAuth): string => {
  const w = auth.resolved.whoCanExecute;
  const from = w.source === 'default' ? '' : `（由${LAYER_NAME[w.source]}的执行策略设定）`;
  if (w.value === 'executor') {
    const prodNote = auth.resolved.production ? '；生产环境上只认实例管理员授予的执行者' : '';
    return isEnvConfigAction(action)
      ? `这个环境设置为“仅限执行者”${from}：这个操作需要同时是执行者和项目管理员${prodNote}`
      : `这个环境设置为“仅限执行者”${from}：只有被授予“执行者”的用户或组可以做这个操作${prodNote}`;
  }
  const need = w.value === 'admin' || isEnvConfigAction(action) ? '项目管理员' : '项目编辑者';
  return `这个环境需要${need}（或执行者）才能做这个操作${from}`;
};
