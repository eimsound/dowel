// 执行申请与审批（P5b：E3 执行申请、E4 审批流程、E5 紧急执行、E7 收件箱；规则见 ADR 0006、0007）。
//
// 一个申请绑定“起止版本 + 各迁移校验和”（提交时预演得到的计划），并快照提交时生效的审批流程：
// - 审批按快照的环节走，**审批人资格按审批时（锁内重新读到的）成员关系判断**；
// - 当前生效流程比快照严（快照不再包含它）→ 申请失效；变宽或不变 → 继续按快照（更严的那份）走；
// - 环境当前版本变了、检测到漂移、连接设置变了、生产标记变了、链上相关版本的脚本变了、目标版本没了 → 失效；过了有效期 → 过期；
// - 执行时执行器还会在目标库的项目锁里按目标库历史核对一遍（ExecuteOptions.expect），平台库缓存落后也越不过失效。
//
// 执行权限不因审批而来：无论哪种流程，真正执行（“通过并执行”或通过后的“执行”）的人都要满足环境的“谁能执行”
// （或是执行者）。审批流程只会多加限制、不会给谁执行权，所以下级追加环节（ADR 0005 里算收紧）不可能借审批绕过上级的“仅限执行者”。
//
// 状态变化、审批人资格判断都在执行策略锁（withPolicyLock）里，用锁内重新读到的申请、策略、成员关系和环境状态；
// 收件箱的通知、审计与 Webhook 持久化入队（webhook_jobs）在同一个事务里原子写库，实时推送与 Webhook 队列唤醒在提交之后发（Effects）。
import { createHash } from 'node:crypto';

import {
  type ApprovalStage,
  approvalAtLeast,
  type ExecRequestDetail,
  type ExecRequestSummary,
  type InboxEvent,
  type InboxItem,
  type InboxKind,
  type PendingRequest,
  type RequestActions,
  type RequestApprovers,
  type RequestKind,
  type RequestMigration,
  type RequestStageView,
  type RequestStatus,
  type RequestTimelineEntry,
  type RequestVersionRef,
  type ResolvedPolicy,
  type WebhookEventInput,
  type WebhookEventType,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { auditIn } from './audit.ts';
import { can, userActor } from './authz.ts';
import type { EventBus } from './bus.ts';
import { inList, type PlatformDb } from './db.ts';
import { type EnvRow, iso } from './envs.ts';
import type { ExecContext } from './executions.ts';
import type { HaCoordinator } from './ha.ts';
import {
  isExecutor,
  loadPolicies,
  type PolicyStore,
  policyNames,
  resolveEnv,
  withPolicyLock,
} from './policy.ts';
import {
  effectiveRole,
  type GrantRow,
  loadRoleContext,
  type ProjectRow,
  projectRow,
  type RoleContext,
  visibleProjects,
} from './roles.ts';
import type { Role } from './rooms.ts';
import { decrypt, keyedDigest, scrubSecrets } from './secrets.ts';
import type { SecurityConfig } from './security.ts';
import { loadTokenRules, tokenRulesFor } from './token-rules.ts';
import type { Webhooks } from './webhooks.ts';

// ───── 审批流程快照 ─────

/** 提交时生效审批流程的快照。implicit：没有配置环节的默认流程（一个环节、一人、审批人 = 有执行权限的人、通过即执行） */
export interface FlowSnapshot {
  implicit: boolean;
  stages: ApprovalStage[];
}

export interface StageSpec {
  approvers: RequestApprovers;
  count: number;
  lastApproverExecutes: boolean;
}

/** 默认流程的那一个环节 */
export const IMPLICIT_STAGE: StageSpec = {
  approvers: { kind: 'can_execute' },
  count: 1,
  lastApproverExecutes: true,
};

export const stagesOf = (f: FlowSnapshot): StageSpec[] => (f.implicit ? [IMPLICIT_STAGE] : f.stages);

export const flowOf = (r: ResolvedPolicy): FlowSnapshot => {
  const stages = r.approval.stages.map((s) => s.stage);
  return { implicit: stages.length === 0, stages };
};

/**
 * 策略中途变化的规则（ADR 0006）：当前生效流程不比快照严——快照的环节按顺序包含当前流程的每个环节——就继续按快照走；
 * 当前流程变严（多了环节、换了环节、人数变了）→ 申请失效，要按新流程重新提交。默认流程的快照只有当前也没配置环节时才成立。
 */
export const flowStillHolds = (snap: FlowSnapshot, current: ApprovalStage[]): boolean =>
  snap.implicit ? current.length === 0 : approvalAtLeast(snap.stages, current);

// ───── 申请行 ─────

export interface RequestRow {
  id: string;
  project_id: string;
  environment_id: string;
  requested_by: string | null;
  direction: 'up' | 'down';
  from_version_id: string | null;
  to_version_id: string;
  migrations: RequestMigration[];
  dry_run: ExecRequestDetail['dryRun'];
  reason: string;
  flow: FlowSnapshot;
  conn_hash: string;
  production: boolean;
  status: RequestStatus;
  stage: number;
  status_reason: string | null;
  expires_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  executed_by: string | null;
  executed_at: unknown;
  emergency: boolean;
  result: ExecRequestDetail['result'];
  worker_id?: string | null;
}

export const loadRequest = async (db: Db, pid: string, rid: string): Promise<RequestRow> => {
  const [r] = await db.query<RequestRow>('select * from exec_requests where id = $1 and project_id = $2', [
    rid,
    pid,
  ]);
  if (!r) throw new HTTPException(404, { message: '执行申请不存在' });
  return r;
};

/**
 * 连接设置的指纹：申请绑定的是“这个库”，换了连接串就不是同一个库了。连接串里有密码，所以不能是普通哈希
 * （第一轮审查：无盐 SHA-256 可以离线撞出密码）——用 DOWEL_SECRET 派生的密钥做 HMAC（secrets.ts 的 keyedDigest）。
 */
export const connHash = (env: Pick<EnvRow, 'url_enc'>): string => {
  try {
    return keyedDigest('exec-request.conn', decrypt(env.url_enc));
  } catch {
    // 解不开（DOWEL_SECRET 换了）：用密文本身的摘要；之后再改连接串，密文一定会变。密文的摘要不泄露任何东西
    return `enc:${createHash('sha256').update(env.url_enc).digest('hex')}`;
  }
};

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

/** 从存储的 direction（'up'|'down'）与绑定的迁移快照推导 API 申请类型（ADR 0013） */
export const requestKindOf = (req: Pick<RequestRow, 'direction' | 'migrations'>): RequestKind =>
  req.direction === 'down'
    ? 'rollback'
    : req.migrations.some((m) => m.direction === 'down')
      ? 'switch'
      : 'execute';

/** 从申请推导传给执行器的路线方向 */
export const execDirectionOf = (
  req: Pick<RequestRow, 'direction' | 'migrations'>,
): 'up' | 'down' | 'switch' => {
  const kind = requestKindOf(req);
  return kind === 'rollback' ? 'down' : kind === 'switch' ? 'switch' : 'up';
};

const actionLabel = (kind: RequestKind, toNum: number | null, lcaNum: number | null): string => {
  if (kind === 'switch') {
    const toText = toNum !== null ? ` v${toNum}` : '';
    const lcaText = lcaNum !== null ? `（先回滚到 v${lcaNum}）` : '';
    return `切换到${toText}${lcaText}`;
  }
  return `${kind === 'rollback' ? '回滚' : '执行'}${toNum !== null ? `到 v${toNum}` : ''}`;
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

// ───── 绑定检查 ─────

export interface BindingProblem {
  status: 'invalid' | 'expired';
  reason: string;
}

const vlabel = (v: { number: number } | null | undefined) =>
  v ? `v${v.number}` : '（还没有执行过任何版本）';

/**
 * 一轮检查里共用的读取结果（第二轮审查：同一个环境 / 项目的申请不要每个都重新查环境行、版本、项目和策略）。
 * 只在同一个事务 / 同一轮只读检查里共用，不跨轮。
 */
export interface BindingCache {
  envs: Map<string, EnvRow | null>;
  versions: Map<string, Map<string, { id: string; number: number; checksum: string; retiredAt: unknown }>>;
  projects: Map<string, ProjectRow | null>;
  stores: Map<string, PolicyStore>;
}
export const newBindingCache = (): BindingCache => ({
  envs: new Map(),
  versions: new Map(),
  projects: new Map(),
  stores: new Map(),
});
const cached = async <V>(m: Map<string, V>, k: string, load: () => Promise<V>): Promise<V> => {
  if (m.has(k)) return m.get(k) as V;
  const v = await load();
  m.set(k, v);
  return v;
};

/**
 * 申请绑定的环境状态还成立吗（ADR 0007）。在执行策略锁里调用（审批、执行、定时清理），用传入的 db 重新读一切
 * （cache 只在同一轮里共用）。返回 null = 仍然有效；否则是该转成的状态和原因。正在执行（executing）的不检查。
 */
export const bindingProblem = async (
  db: Db,
  req: RequestRow,
  now = new Date(),
  cache: BindingCache = newBindingCache(),
): Promise<BindingProblem | null> => {
  const invalid = (reason: string): BindingProblem => ({ status: 'invalid', reason });
  const expires = new Date(iso(req.expires_at)!);
  if (expires.getTime() <= now.getTime())
    return { status: 'expired', reason: `申请已过期（有效期到 ${expires.toISOString()}）` };
  const env = await cached(
    cache.envs,
    req.environment_id,
    async () =>
      (await db.query<EnvRow>('select * from environments where id = $1', [req.environment_id]))[0] ?? null,
  );
  if (!env) return invalid('环境已经不存在');
  const versions = await cached(
    cache.versions,
    req.project_id,
    async () =>
      new Map(
        (
          await db.query<{ id: string; number: number; checksum: string; retiredAt: unknown }>(
            'select id, number, checksum, retired_at as "retiredAt" from versions where project_id = $1',
            [req.project_id],
          )
        ).map((v) => [v.id, v]),
      ),
  );
  if ((env.current_version_id ?? null) !== (req.from_version_id ?? null))
    return invalid(
      `环境的当前版本变了：提交时是 ${vlabel(req.from_version_id ? versions.get(req.from_version_id) : null)}，现在是 ${vlabel(env.current_version_id ? versions.get(env.current_version_id) : null)}`,
    );
  if (env.drift_status === 'drifted') return invalid('检测到漂移：目标库的结构和环境当前版本不一致');
  if (env.production !== req.production) return invalid('环境的“生产”标记变了');
  if (connHash(env) !== req.conn_hash) return invalid('环境的连接设置变了');
  const toVer = versions.get(req.to_version_id);
  if (!toVer) return invalid('目标版本已经不存在');
  // (a) 非回滚申请（执行 / 切换）：目标版本已作废 → 失效
  if (req.direction !== 'down' && iso(toVer.retiredAt) !== null)
    return invalid(`目标版本 v${toVer.number} 已作废`);
  const reqCreatedMs = new Date(iso(req.created_at)!).getTime();
  for (const m of req.migrations) {
    const v = versions.get(m.versionId);
    if (!v) return invalid(`版本 v${m.number} 已经不存在`);
    if (v.checksum !== m.checksum) return invalid(`版本 v${m.number} 的脚本在提交之后被修改过`);
    const retiredAtIso = iso(v.retiredAt);
    if (retiredAtIso !== null) {
      // (b) 绑定的升级迁移对应版本已作废 → 失效
      if (m.direction === 'up') return invalid(`版本 v${m.number} 已作废`);
      // (c) 绑定的回滚迁移对应版本在提交申请之后才被作废 → 失效；提交前已作废的（作废后发起的切换 / 回滚申请）保持有效
      if (new Date(retiredAtIso).getTime() > reqCreatedMs)
        return invalid(`版本 v${m.number} 在提交申请后被作废`);
    }
  }
  const project = await cached(cache.projects, req.project_id, () => projectRow(db, req.project_id));
  if (!project) return invalid('项目已经不存在');
  const store = await cached(cache.stores, project.id, () => loadPolicies(db, project));
  const resolved = resolveEnv(store, env);
  if (
    !flowStillHolds(
      req.flow,
      resolved.approval.stages.map((s) => s.stage),
    )
  )
    return invalid('环境的审批流程变严了：请按新的审批流程重新提交');
  return null;
};

// ───── 副作用：事务提交之后才触发 ─────

/** 在事务里收集、提交之后再触发的东西：实时推送给哪些用户、事务内已持久化入队的 Webhook 任务数 */
export class Effects {
  users = new Set<string>();
  enqueuedHooksCount = 0;
  requestsChanged = false;
}

/** 通知的内容（中文快照；界面按 event 和 params 再用自己的语言显示） */
export interface NoticeData {
  title: string;
  body: string;
  event: string;
  status?: RequestStatus;
  action?: 'approve' | 'execute';
  actor?: string | null;
  params?: Record<string, string | number | null>;
}

/** 服务重启或执行节点离线时被中断的执行（result.code） */
export const INTERRUPTED = 'interrupted';

/** 是否是执行中被中断（结果未知）的申请：不参与巡检/重检失效改写，也不允许直接重试，仅保留原节点 finish() 兜底覆盖 */
export const isInterrupted = (req: Pick<RequestRow, 'status' | 'result'>): boolean =>
  req.status === 'failed' && req.result?.code === INTERRUPTED;

/**
 * 还要做绑定检查的申请：待审批、已通过、执行失败（可以重试，不含中断）的**普通**申请。
 * - 紧急执行的记录一旦失败 / 中断就是终态（不能经申请的流程重试，第一轮审查），不再检查、不再转成失效 / 过期，也不再发通知和 Webhook（第二轮审查）；
 * - 执行中被中断（status = 'failed' 且 result.code = 'interrupted'）的申请结果未知，需保留中断原因供人工核对，
 *   并保留原节点心跳抖动恢复后由 finish() 覆盖真实结果的能力，同样不再被巡检/重检改写为失效 / 过期（#18）。
 */
const SWEEP_WHERE = "status in ('pending', 'approved', 'failed') and not emergency";
export const sweepWhere = (dialect: PlatformDb['dialect']): string => {
  const codeExpr = dialect === 'pg' ? "result->>'code'" : "json_extract(result, '$.code')";
  return `${SWEEP_WHERE} and (status <> 'failed' or coalesce(${codeExpr}, '') <> '${INTERRUPTED}')`;
};

/** 状态 → 审计动作 / 中文 */
const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  executing: '执行中',
  executed: '已执行',
  failed: '执行失败',
  rejected: '已驳回',
  withdrawn: '已撤回',
  invalid: '已失效',
  expired: '已过期',
};
export const statusLabel = (s: RequestStatus) => STATUS_LABEL[s];

/** 收件箱实时推送的本副本订阅回调（内存维护本节点 SSE 连接；跨副本变更经 EventBus 的 inbox.changed 广播并在各副本本地扇出） */
type Listener = (e: InboxEvent) => void;

/** 重检的范围：全部，或者受影响的环境 / 项目 / 组（组层策略变了：组里所有项目） */
export interface SweepTarget {
  all?: boolean;
  envIds?: string[];
  projectIds?: string[];
  groupIds?: string[];
}

/** 定时清理的默认间隔：30 秒（过期、失效的申请转成终态并通知申请人） */
export const REQUEST_SWEEP_MS = 30_000;
/** 显式 sweep() 等待分布式巡检锁的默认超时时间 */
const SWEEP_LOCK_TIMEOUT_MS = 30_000;
/** 事件驱动 kick 未拿到分布式锁时的默认重试间隔 */
const SWEEP_KICK_RETRY_MS = 200;
/** 事件驱动 kick 连续撞锁时的最大重试次数（避免锁长期被占时无限自旋；另有 30 秒周期巡检兜底） */
const MAX_SWEEP_KICK_RETRIES = 25;

interface SweepScope {
  all: boolean;
  envs: Set<string>;
  projects: Set<string>;
  groups: Set<string>;
}

interface PendingSweep extends SweepScope {
  /** 是否有显式 await sweep() 调用者在等待：需要阻塞等锁直到跑完 */
  blocking: boolean;
  /** 是否包含事件驱动的 kick（非单纯定时心跳）：未获锁时需要短延迟重试而非静默丢弃 */
  retryOnContention: boolean;
}

interface SweepOnceResult {
  acquired: boolean;
  count: number;
}

const emptyScope = (): SweepScope => ({
  all: false,
  envs: new Set(),
  projects: new Set(),
  groups: new Set(),
});

const mergeScope = (dst: SweepScope, src: SweepTarget | SweepScope): void => {
  if (src.all) dst.all = true;
  if ('envs' in src) {
    for (const id of src.envs) dst.envs.add(id);
    for (const id of src.projects) dst.projects.add(id);
    for (const id of src.groups) dst.groups.add(id);
  } else {
    for (const id of src.envIds ?? []) dst.envs.add(id);
    for (const id of src.projectIds ?? []) dst.projects.add(id);
    for (const id of src.groupIds ?? []) dst.groups.add(id);
  }
};

export interface RequestScope {
  project: ProjectRow;
  env: EnvRow;
  /** 四层配置（同一次读出，算执行者身份、超时时复用） */
  store: PolicyStore;
  resolved: ResolvedPolicy;
}

export interface RequestsOptions {
  /** 跨副本事件总线（可选）：收件箱变更与 requests.kick 跨副本同步 */
  bus?: EventBus;
  /** 副本租约与分布式任务协调器（可选）：按副本租约恢复中断申请与巡检互斥 */
  ha?: HaCoordinator;
  /** 显式 sweep() 等待分布式巡检锁的超时时间（毫秒，默认 30000） */
  sweepLockTimeoutMs?: number;
  /** 事件驱动 kick 未获锁时的短延迟重试间隔（毫秒，默认 200） */
  kickRetryMs?: number;
}

const INBOX_CHANGED_BATCH = 100;

export class Requests {
  readonly db: PlatformDb;
  readonly exec: ExecContext;
  readonly webhooks: Webhooks;
  readonly security: SecurityConfig;
  readonly bus: EventBus | null;
  readonly ha: HaCoordinator | null;
  private readonly sweepLockTimeoutMs: number;
  private readonly kickRetryMs: number;
  private listeners = new Map<string, Set<Listener>>();
  private stopListeners = new Set<() => void>();
  private stopped = false;
  private busUnsubs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPending: SweepScope | null = null;
  private retryAttempts = 0;
  /** 排着的检查范围（合并）；queued / done 是代数：sweep() 等到包含自己那一次的一轮跑完 */
  private pending: PendingSweep | null = null;
  private queued = 0;
  private done = 0;
  private draining: Promise<number> | null = null;
  /** 正在执行收尾写库与通知（finish / afterDirectRun / afterTokenRun）的异步任务 */
  private readonly inFlight = new Set<Promise<unknown>>();
  /**
   * 本进程开始的时间：无 HA 租约或历史无 worker_id 的记录仍据此区分重启前遗留与本进程刚发起的执行。
   * 在 createApp 里构造，早于开始接受连接。
   */
  readonly bootAt = new Date();

  constructor(
    db: PlatformDb,
    exec: ExecContext,
    webhooks: Webhooks,
    security: SecurityConfig,
    options: RequestsOptions = {},
  ) {
    this.db = db;
    this.exec = exec;
    this.webhooks = webhooks;
    this.security = security;
    this.bus = options.bus ?? null;
    this.ha = options.ha ?? null;
    this.sweepLockTimeoutMs = options.sweepLockTimeoutMs ?? SWEEP_LOCK_TIMEOUT_MS;
    this.kickRetryMs = options.kickRetryMs ?? SWEEP_KICK_RETRY_MS;
    this.attachBus();
  }

  /** 当前副本 ID（写入 exec_requests.worker_id；无 HA 时为 null） */
  get workerId(): string | null {
    return this.ha?.replicaId ?? null;
  }

  /** 是否已调用 stop() 进入停机状态 */
  isStopped(): boolean {
    return this.stopped;
  }

  private attachBus(): void {
    if (!this.bus || this.busUnsubs.length) return;
    const replicaId = this.bus.replicaId;
    this.busUnsubs.push(
      this.bus.onEvent(async (event) => {
        if (this.stopped || event.origin === replicaId) return;
        if (event.t === 'inbox.changed') {
          if (!event.userIds.length) {
            this.broadcastLocal({ requests: true });
            return;
          }
          for (const uid of event.userIds) {
            if (this.stopped) return;
            if (this.listeners.has(uid)) await this.publishUnreadLocal(uid);
          }
          return;
        }
        if (event.t === 'requests.kick') {
          this.kickLocal({
            all: event.all,
            envIds: event.envIds,
            projectIds: event.projectIds,
            groupIds: event.groupIds,
          });
        }
      }),
      this.bus.onReconnect(async () => {
        if (this.stopped) return;
        // 断线期间可能错过了 requests.kick，重连后补跑一次全量巡检（非阻塞、撞锁自动短延迟重试）
        this.kickLocal({ all: true });
        const activeUsers = [...this.listeners.keys()];
        for (const uid of activeUsers) {
          if (this.stopped) return;
          await this.publishUnreadLocal(uid);
        }
        if (!this.stopped && activeUsers.length) this.broadcastLocal({ requests: true });
      }),
    );
  }

  private detachBus(): void {
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
  }

  // ───── 定时清理 ─────

  /**
   * 启动定时清理（main.ts，在 ha.start() / bus.start() 之后、开始接受连接之前调用）。
   * 先恢复已离线节点遗留的“执行中”申请，再按间隔巡检过期、失效与中断的申请。
   */
  async start(intervalMs = REQUEST_SWEEP_MS) {
    this.stop();
    this.stopped = false;
    this.attachBus();
    await this.recoverInterrupted();
    if (this.stopped || !(intervalMs > 0)) return;
    this.timer = setInterval(() => this.triggerPeriodicSweep(), intervalMs);
    this.timer.unref?.();
  }

  /** 判断一条 executing 申请是否已经因原执行副本离线/重启而中断 */
  private async isInterruptedRow(row: RequestRow, aliveCache: Map<string, boolean>): Promise<boolean> {
    const updatedMs = new Date(iso(row.updated_at)!).getTime();
    const olderThanBoot = updatedMs < this.bootAt.getTime();
    if (!this.ha) return olderThanBoot;
    const wid = row.worker_id ?? null;
    // 无 worker_id（升级前遗留或单测手工造数据）或属于本副本 ID：仅按早于本进程启动时间判断，避免误杀本进程正在执行的申请
    if (!wid || wid === this.ha.replicaId) return olderThanBoot;
    let alive = aliveCache.get(wid);
    if (alive === undefined) {
      alive = await this.ha.isNodeAlive(wid);
      aliveCache.set(wid, alive);
    }
    return !alive;
  }

  /**
   * 恢复卡死的“执行中”申请 → 执行失败（result.code = interrupted）。
   * - 有 HaCoordinator 时：按 worker_id 检查所属副本心跳租约是否仍存活，绝不误杀其他存活副本正在跑的迁移；
   * - 无 HaCoordinator 或历史无 worker_id 记录时：退回 updated_at < bootAt 判断。
   * 之后真正的执行结果如果还能送到，finish() 仍然接受这种状态，用真实结果覆盖。返回处理了几个。
   */
  async recoverInterrupted(): Promise<number> {
    const candidates = await this.db.query<RequestRow>(
      "select * from exec_requests where status = 'executing'",
    );
    if (!candidates.length) return 0;
    const preCache = new Map<string, boolean>();
    const staleIds: string[] = [];
    for (const r of candidates) {
      if (await this.isInterruptedRow(r, preCache)) staleIds.push(r.id);
    }
    if (!staleIds.length) return 0;

    const fx = await withPolicyLock(this.db, async (tx) => {
      const fx = Object.assign(new Effects(), { n: 0 });
      const rows = await tx.query<RequestRow>(
        `select * from exec_requests where status = 'executing' and id in (${inList(staleIds)})`,
        staleIds,
      );
      const lockCache = new Map<string, boolean>();
      for (const r of rows) {
        if (!(await this.isInterruptedRow(r, lockCache))) continue;
        const reason = '服务重启或执行节点离线时这个申请正在执行，结果未知：请到环境页查看执行历史';
        const ok = await this.setStatus(tx, null, r, 'failed', reason, null, fx, {
          result: { ok: false, code: INTERRUPTED, error: reason, current: null },
          onlyIf: 'executing',
        });
        if (ok) fx.n++;
      }
      return fx;
    });
    await this.flushEffects(fx);
    return fx.n;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
    this.clearRetry();
    this.retryAttempts = 0;
    if (this.pending && !this.pending.blocking) this.pending = null;
    this.detachBus();
    const closers = [...this.stopListeners];
    this.stopListeners.clear();
    this.listeners.clear();
    for (const close of closers) {
      try {
        close();
      } catch {}
    }
  }

  /** 等待正在进行的巡检与执行收尾任务全部完成（优雅停机排空用） */
  async drain(): Promise<void> {
    while (this.draining || this.inFlight.size > 0) {
      const tasks: Promise<unknown>[] = [...this.inFlight];
      if (this.draining) tasks.push(this.draining);
      await Promise.allSettled(tasks);
    }
  }

  private trackInFlight<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const drop = () => this.inFlight.delete(p);
    p.then(drop, drop);
    return p;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryPending = null;
  }

  private scheduleRetry(t: SweepScope): void {
    if (this.stopped || this.retryAttempts >= MAX_SWEEP_KICK_RETRIES) {
      this.clearRetry();
      return;
    }
    this.retryAttempts++;
    this.retryPending ??= emptyScope();
    mergeScope(this.retryPending, t);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const retry = this.retryPending;
      this.retryPending = null;
      if (this.stopped || !retry) return;
      this.enqueue(retry, 'kick');
      void this.drainPending().catch((e) => {
        console.error('重试检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }, this.kickRetryMs);
    this.retryTimer.unref?.();
  }

  private enqueue(t: SweepTarget | SweepScope, mode: 'periodic' | 'kick' | 'blocking'): number {
    this.pending ??= { ...emptyScope(), blocking: false, retryOnContention: false };
    mergeScope(this.pending, t);
    if (mode === 'blocking') this.pending.blocking = true;
    if (mode === 'kick') this.pending.retryOnContention = true;
    // 非单纯定时心跳触发时，若已有挂起的短延迟重试目标则顺手并入本轮
    if (this.retryPending && mode !== 'periodic') {
      mergeScope(this.pending, this.retryPending);
      this.pending.retryOnContention = true;
      this.clearRetry();
    }
    return ++this.queued;
  }

  private triggerPeriodicSweep(): void {
    if (this.stopped) return;
    this.enqueue({ all: true }, 'periodic');
    void this.drainPending().catch((e) => {
      console.error('定时检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
    });
  }

  private kickLocal(t: SweepTarget) {
    if (this.stopped) return;
    this.retryAttempts = 0;
    this.enqueue(t, 'kick');
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      if (this.stopped) return;
      void this.drainPending().catch((e) => {
        console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }, 0);
    this.kickTimer.unref?.();
  }

  /**
   * 环境状态或执行策略可能变了（执行结束、漂移检查、读历史同步、改脚本、改策略、改连接、转组……）：
   * 由相应的路由**显式**调用，带上受影响的范围，尽快检查这个范围里还没结束的申请（合并成一轮；检查进行中又来的会再跑一轮），
   * 并广播给其他副本。正确性不依赖它：审批、执行时都在锁内重新检查绑定，另有定时检查。
   */
  kick(t: SweepTarget) {
    this.kickLocal(t);
    if (this.bus) {
      void this.bus
        .publish({
          t: 'requests.kick',
          ...(t.all ? { all: true } : {}),
          ...(t.envIds?.length ? { envIds: t.envIds } : {}),
          ...(t.projectIds?.length ? { projectIds: t.projectIds } : {}),
          ...(t.groupIds?.length ? { groupIds: t.groupIds } : {}),
        })
        .catch((e) => {
          console.error('广播 requests.kick 失败', e instanceof Error ? scrubSecrets(e.message) : e);
        });
    }
  }

  /** 检查一个范围（默认全部）里还没结束的申请，失效 / 过期的转成终态并通知申请人；等到包含这次请求的那一轮跑完，返回处理了几个 */
  async sweep(t: SweepTarget = { all: true }): Promise<number> {
    const mine = this.enqueue(t, 'blocking');
    let n = 0;
    while (this.done < mine) n += await this.drainPending();
    return n;
  }

  private pendingBlocking(): PendingSweep | null {
    return this.pending?.blocking ? this.pending : null;
  }

  private drainPending(): Promise<number> {
    this.draining ??= (async () => {
      let n = 0;
      while (this.pending) {
        if (this.kickTimer) {
          clearTimeout(this.kickTimer);
          this.kickTimer = null;
        }
        const t = this.pending;
        const gen = this.queued;
        this.pending = null;
        let res: SweepOnceResult;
        try {
          res = await this.sweepOnce(t);
        } catch (e) {
          console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
          this.done = gen;
          if (this.stopped) break;
          continue;
        }
        if (res.acquired) {
          n += res.count;
          this.done = gen;
          this.retryAttempts = 0;
          if (t.all) this.clearRetry();
        } else if (t.blocking) {
          // 显式 sweep() 阻塞等锁超时：绝不误推进 done，也不丢弃合并进来的 kick 重试
          if (t.retryOnContention && !this.stopped) this.scheduleRetry(t);
          throw new Error('等待执行申请巡检锁超时');
        } else if (t.retryOnContention && !this.stopped) {
          // 事件驱动 kick 未拿到锁：若已有后续显式 sweep() 排队则直接并入，否则短延迟重试，防止跨副本撞锁/总线瞬断丢弃
          const queuedBlocking = this.pendingBlocking();
          if (queuedBlocking) {
            mergeScope(queuedBlocking, t);
            queuedBlocking.retryOnContention = true;
          } else {
            this.scheduleRetry(t);
          }
        }
        if (this.stopped) break;
      }
      return n;
    })().finally(() => {
      this.draining = null;
      // 循环结束和这里之间又排进来的：再跑一轮，不能丢（停机后不再续跑）
      if (!this.stopped && this.pending) {
        void this.drainPending().catch((e) => {
          console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
        });
      }
    });
    return this.draining;
  }

  /**
   * 分布式巡检入口：多副本下通过 advisory lock 互斥，同一时刻只有一个副本跑巡检。
   * - 显式 sweep()（blocking = true）使用阻塞等锁，确保等待锁释放并跑完目标范围后再推进 done；
   * - 后台定时 / kick 巡检使用非阻塞 tryWithJobLock，避免后台周期巡检互相阻塞。
   */
  private async sweepOnce(t: PendingSweep): Promise<SweepOnceResult> {
    const run = () => this.runSweep(t);
    if (!this.ha) return { acquired: true, count: await run() };
    const res = t.blocking
      ? await this.ha.withJobLock('requests.sweep', run, { timeoutMs: this.sweepLockTimeoutMs })
      : await this.ha.tryWithJobLock('requests.sweep', run);
    return res.acquired ? { acquired: true, count: res.value } : { acquired: false, count: 0 };
  }

  /**
   * 一轮检查：全量巡检时先按副本租约恢复卡死的 executing 申请，
   * 再在锁外只读地找出绑定已经不成立的申请（大多数时候一个都没有，不拿全局锁），
   * 最后在执行策略锁里逐个重新读、重新判断、条件更新。
   */
  private async runSweep(t: SweepScope): Promise<number> {
    let n = 0;
    if (t.all) n += await this.recoverInterrupted();
    const params: string[] = [];
    const conds: string[] = [];
    if (!t.all) {
      const add = (ids: Set<string>, sql: (list: string) => string) => {
        if (!ids.size) return;
        conds.push(sql(inList([...ids], params.length + 1)));
        params.push(...ids);
      };
      add(t.envs, (l) => `environment_id in (${l})`);
      add(t.projects, (l) => `project_id in (${l})`);
      add(t.groups, (l) => `project_id in (select id from projects where group_id in (${l}))`);
      if (!conds.length) return n;
    }
    const rows = await this.db.query<RequestRow>(
      `select * from exec_requests where ${sweepWhere(this.db.dialect)}${conds.length ? ` and (${conds.join(' or ')})` : ''}`,
      params,
    );
    const stale: string[] = [];
    const cache = newBindingCache();
    const now = new Date();
    for (const r of rows) {
      if (isInterrupted(r)) continue;
      if (await bindingProblem(this.db, r, now, cache)) stale.push(r.id);
    }
    if (!stale.length) return n;
    return n + (await this.closeStale(stale));
  }

  /** 锁内重新读、重新判断、条件更新：只读判断之后状态可能又变了（被执行、被撤回……） */
  private async closeStale(ids: string[]): Promise<number> {
    const where = sweepWhere(this.db.dialect);
    const fx = await withPolicyLock(this.db, async (tx) => {
      const fx = Object.assign(new Effects(), { n: 0 });
      const cache = newBindingCache();
      const now = new Date();
      for (const id of ids) {
        const [r] = await tx.query<RequestRow>(`select * from exec_requests where id = $1 and ${where}`, [
          id,
        ]);
        if (!r || isInterrupted(r)) continue;
        const p = await bindingProblem(tx, r, now, cache);
        if (p && (await this.setStatus(tx, null, r, p.status, p.reason, null, fx, { onlyIf: r.status })))
          fx.n++;
      }
      return fx;
    });
    await this.flushEffects(fx);
    return fx.n;
  }

  // ───── 状态变化 ─────

  /**
   * 改申请状态（在锁内的事务里）：写状态和原因、审计、通知申请人、排上 Webhook。
   * actor：做这件事的人（系统清理为 null）。
   */
  async setStatus(
    tx: Db,
    c: Context | null,
    req: RequestRow,
    status: RequestStatus,
    reason: string | null,
    actor: { id: string; name: string } | null,
    fx: Effects,
    extra: { result?: RequestRow['result']; comment?: string; onlyIf?: RequestStatus } = {},
  ): Promise<boolean> {
    // 紧急执行的记录只有“执行结束”（finish）和启动恢复会改它的状态，两者都带着结果；已经结束的紧急记录不再被别的路径改动
    // （第二轮审查：否则定时检查会把失败的紧急记录转成失效，再发一次通知和 Webhook）
    if (req.emergency && req.status !== 'executing' && !extra.result) return false;
    // 执行中被中断（result.code = interrupted）的记录同样不能被巡检/重检改写为失效或过期，仅允许原节点 finish() 带真实结果覆盖（#18）
    if (isInterrupted(req) && !extra.result) return false;
    const now = new Date().toISOString();
    // onlyIf：条件更新（状态仍是读到时的那个才改），没改到就什么副作用都不做
    const updated = await tx.query<{ id: string }>(
      `update exec_requests set status = $2, status_reason = $3, updated_at = $4,
              result = coalesce($5::text::jsonb, result)
        where id = $1${extra.onlyIf ? ' and status = $6' : ''} returning id`,
      [
        req.id,
        status,
        reason,
        now,
        extra.result ? JSON.stringify(extra.result) : null,
        ...(extra.onlyIf ? [extra.onlyIf] : []),
      ],
    );
    if (!updated.length) return false;
    const action =
      status === 'invalid'
        ? 'exec_request.invalidate'
        : status === 'expired'
          ? 'exec_request.expire'
          : status === 'withdrawn'
            ? 'exec_request.withdraw'
            : status === 'rejected'
              ? 'exec_request.reject'
              : status === 'executed' || status === 'failed'
                ? 'exec_request.finish'
                : `exec_request.${status}`;
    await auditIn(
      tx,
      c,
      {
        action,
        actorKind: actor ? 'user' : 'system',
        actorId: actor?.id ?? null,
        targetKind: 'exec_request',
        targetId: req.id,
        projectId: req.project_id,
        data: {
          environmentId: req.environment_id,
          from: status === 'failed' || status === 'executed' ? undefined : req.status,
          status,
          reason,
          ...(extra.comment ? { comment: extra.comment } : {}),
          ...(extra.result ? { ok: extra.result.ok, code: extra.result.code } : {}),
          ...(req.emergency ? { emergency: true } : {}),
        },
      },
      this.security,
    );
    req.status = status;
    req.status_reason = reason;
    if (extra.result) req.result = extra.result;
    fx.requestsChanged = true;
    const ctx = await this.scopeOf(tx, req);
    if (!ctx) return true;
    // 紧急执行的结果（成功、失败、执行器判为状态已变）通知这个环境审批流程里的审批人，和开始时一样（第一轮审查补上）
    if (req.emergency && (status === 'executed' || status === 'failed' || status === 'invalid'))
      await this.notifyApprovers(tx, req, ctx, fx, actor?.id ?? null, {
        event: `emergency_${status}`,
        status,
        actor: actor?.name ?? null,
        reason: status === 'executed' ? req.reason : reason,
      });
    // 申请人收到结果（撤回是他自己做的，不用通知）
    const event =
      status === 'executed' || status === 'failed'
        ? status
        : status === 'rejected' || status === 'invalid' || status === 'expired'
          ? status
          : null;
    // 执行结果总是通知申请人（他自己执行的也记一条，收件箱里能看到“我的申请结果”）；其他结果是别人做的才通知
    const finished = status === 'executed' || status === 'failed';
    if (req.requested_by && event && !req.emergency && (finished || req.requested_by !== actor?.id))
      await this.notify(tx, [req.requested_by], 'request_result', req, ctx, fx, {
        event,
        status,
        actor: actor?.name ?? null,
        reason,
      });
    const hook: WebhookEventType | null = req.emergency
      ? status === 'executed' || status === 'failed' || status === 'invalid'
        ? 'emergency.executed'
        : null
      : status === 'rejected'
        ? 'request.rejected'
        : status === 'withdrawn'
          ? 'request.withdrawn'
          : status === 'invalid' || status === 'expired'
            ? 'request.invalidated'
            : status === 'executed' || status === 'failed'
              ? 'request.executed'
              : null;
    if (hook)
      await this.queueHook(tx, fx, hook, req, ctx, {
        actor: actor?.name ?? null,
        reason: req.emergency && status === 'executed' ? req.reason : reason,
        status,
        ...(req.emergency ? { ok: status === 'executed' } : {}),
      });
    return true;
  }

  /**
   * 通知这个申请的审批流程（快照）里每个环节现在有资格的人（紧急执行的开始和结果）。只读项目的受众，不读全实例的用户。
   */
  async notifyApprovers(
    tx: Db,
    req: RequestRow,
    s: RequestScope,
    fx: Effects,
    except: string | null,
    n: Parameters<Requests['notify']>[6],
  ) {
    const audience = await loadAudience(tx, s.project);
    const scope = this.stageScope(s, req);
    const ids = [...audience.values()]
      .filter((u) => u.userId !== except && stagesOf(req.flow).some((spec) => eligibleFor(u, spec, scope)))
      .map((u) => u.userId);
    await this.notify(tx, ids, 'emergency_execution', req, s, fx, n, audience);
  }

  /** 申请所在的项目、环境和当前生效策略（环境 / 项目已删除时 null） */
  async scopeOf(
    db: Db,
    req: Pick<RequestRow, 'project_id' | 'environment_id'>,
  ): Promise<RequestScope | null> {
    const project = await projectRow(db, req.project_id);
    if (!project) return null;
    const [env] = await db.query<EnvRow>('select * from environments where id = $1', [req.environment_id]);
    if (!env) return null;
    const store = await loadPolicies(db, project);
    return { project, env, store, resolved: resolveEnv(store, env) };
  }

  stageScope(s: RequestScope, req: Pick<RequestRow, 'direction' | 'migrations'>): StageScope {
    return {
      project: s.project,
      env: { id: s.env.id, production: s.env.production },
      resolved: s.resolved,
      direction: execDirectionOf(req),
    };
  }

  /** 现在有资格批第 stage 个环节的用户（能看到项目、在审批人范围内、不是申请人） */
  async eligibleUsers(
    tx: Db,
    req: RequestRow,
    s: RequestScope,
    stage: number,
    all?: Map<string, UserContext>,
  ): Promise<UserContext[]> {
    const spec = stagesOf(req.flow)[stage];
    if (!spec) return [];
    const users = all ?? (await loadAudience(tx, s.project));
    const scope = this.stageScope(s, req);
    return [...users.values()].filter((u) => u.userId !== req.requested_by && eligibleFor(u, spec, scope));
  }

  /** 有执行权限、能看到项目的用户 */
  async executors(tx: Db, req: RequestRow, s: RequestScope, all?: Map<string, UserContext>) {
    const users = all ?? (await loadAudience(tx, s.project));
    const scope = this.stageScope(s, req);
    return [...users.values()].filter((u) => hasExecRight(u, scope));
  }

  /** 写收件箱（同一个事务）：只发给现在还能看到这个项目的人 */
  async notify(
    tx: Db,
    userIds: Iterable<string>,
    kind: InboxKind,
    req: RequestRow,
    s: RequestScope,
    fx: Effects,
    n: {
      event: string;
      status?: RequestStatus;
      action?: 'approve' | 'execute';
      actor?: string | null;
      reason?: string | null;
      stage?: number;
    },
    /** 调用方已经读过的角色上下文（受众）：复用，不再查；没给就只读这几个用户的 */
    known?: Map<string, UserContext>,
  ) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const missing = ids.filter((id) => !known?.has(id));
    const all = missing.length
      ? new Map([...(known ?? []), ...(await loadRoleContexts(tx, missing))])
      : known!;
    const refs = await this.versionRefs(tx, req);
    const data = this.noticeData(req, s, refs, n);
    for (const id of ids) {
      const rc = all.get(id);
      if (!rc || !effectiveRole(rc, s.project)) continue;
      await tx.query(
        `insert into inbox_items (id, user_id, kind, project_id, environment_id, request_id, data, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)`,
        [
          newId(),
          id,
          kind,
          req.project_id,
          req.environment_id,
          req.id,
          JSON.stringify(data),
          new Date().toISOString(),
        ],
      );
      fx.users.add(id);
    }
  }

  private async versionRefs(
    db: Db,
    req: Pick<RequestRow, 'direction' | 'from_version_id' | 'to_version_id' | 'migrations'>,
  ) {
    const lastDown = [...req.migrations].reverse().find((m) => m.direction === 'down');
    const uniqueIds = [
      ...new Set(
        [
          req.to_version_id,
          ...(req.from_version_id ? [req.from_version_id] : []),
          ...(lastDown ? [lastDown.versionId] : []),
        ].filter(Boolean),
      ),
    ];
    const rows = await db.query<RequestVersionRef & { parentId: string | null }>(
      `select id, number, name, parent_id as "parentId" from versions where id in (${inList(uniqueIds)})`,
      uniqueIds,
    );
    const m = new Map(rows.map((r) => [r.id, r]));
    const lcaId = lastDown ? (m.get(lastDown.versionId)?.parentId ?? null) : null;
    let lca: RequestVersionRef | null = lcaId ? (m.get(lcaId) ?? null) : null;
    if (lcaId && !lca) {
      const [row] = await db.query<RequestVersionRef>('select id, number, name from versions where id = $1', [
        lcaId,
      ]);
      lca = row ?? null;
    }
    const strip = (r: RequestVersionRef | null): RequestVersionRef | null =>
      r ? { id: r.id, number: r.number, name: r.name } : null;
    return {
      from: req.from_version_id ? strip(m.get(req.from_version_id) ?? null) : null,
      to: strip(m.get(req.to_version_id) ?? null) ?? { id: req.to_version_id, number: -1, name: '' },
      lca: requestKindOf(req) === 'switch' ? strip(lca) : null,
    };
  }

  private noticeData(
    req: RequestRow,
    s: RequestScope,
    refs: { from: RequestVersionRef | null; to: RequestVersionRef; lca: RequestVersionRef | null },
    n: {
      event: string;
      status?: RequestStatus;
      action?: 'approve' | 'execute';
      actor?: string | null;
      reason?: string | null;
      stage?: number;
    },
  ): NoticeData {
    const where = `${s.project.name} / ${s.env.name}`;
    const kind = requestKindOf(req);
    const execDir = execDirectionOf(req);
    const what = actionLabel(kind, refs.to.number >= 0 ? refs.to.number : null, refs.lca?.number ?? null);
    const titles: Record<string, string> = {
      approve: `待你审批：${where} ${what}`,
      execute: `待你执行：${where} ${what}（已全部通过）`,
      approved: `你的申请已全部通过：${where} ${what}`,
      rejected: `你的申请被驳回：${where} ${what}`,
      invalid: `你的申请已失效：${where} ${what}`,
      expired: `你的申请已过期：${where} ${what}`,
      executed: `你的申请已执行：${where} ${what}`,
      failed: `你的申请执行失败：${where} ${what}`,
      emergency: `紧急执行：${where} ${what}`,
      emergency_executed: `紧急执行完成：${where} ${what}`,
      emergency_failed: `紧急执行失败：${where} ${what}`,
      emergency_invalid: `紧急执行没有进行（环境状态变了）：${where} ${what}`,
    };
    const key = n.event === 'needs' ? (n.action ?? 'approve') : n.event;
    const parts = [
      n.actor ? `操作人：${n.actor}` : null,
      n.stage !== undefined ? `环节：第 ${n.stage + 1} 个` : null,
      n.reason ? `说明：${n.reason}` : null,
      req.reason && !n.event.startsWith('emergency') ? `申请说明：${req.reason}` : null,
    ].filter(Boolean);
    return {
      title: titles[key] ?? `${where} ${what}`,
      body: scrubSecrets(parts.join('\n')),
      event: key,
      ...(n.status ? { status: n.status } : {}),
      ...(n.action ? { action: n.action } : {}),
      actor: n.actor ?? null,
      params: {
        project: s.project.name,
        env: s.env.name,
        direction: execDir,
        to: refs.to.number,
        from: refs.from?.number ?? null,
        lca: refs.lca?.number ?? null,
        reason: n.reason ?? null,
        stage: n.stage !== undefined ? n.stage + 1 : null,
      },
    };
  }

  /** 详情页的绝对链接（设置了 DOWEL_PUBLIC_URL 时） */
  requestUrl(s: RequestScope, rid: string): string | null {
    if (!this.security.publicUrl) return null;
    const base = this.security.publicUrl.replace(/\/+$/, '');
    return `${base}/project/${s.project.groupSlug}/${s.project.slug}/requests/${rid}`;
  }

  /** 在当前事务内持久化入队一个 Webhook 事件（提交后再由 flushEffects 唤醒投递）。消息里只有项目、环境、版本号、人名、状态和原因，没有连接信息 */
  async queueHook(
    tx: Db,
    fx: Effects,
    type: WebhookEventType,
    req: RequestRow,
    s: RequestScope,
    extra: {
      actor?: string | null;
      reason?: string | null;
      status?: RequestStatus;
      ok?: boolean;
      error?: string | null;
    } = {},
  ): Promise<number> {
    const kind = requestKindOf(req);
    const execDir = execDirectionOf(req);
    const refs = await this.versionRefs(tx, req);
    const what = actionLabel(kind, refs.to.number >= 0 ? refs.to.number : null, refs.lca?.number ?? null);
    const titles: Record<WebhookEventType, string> = {
      'request.created': '新的执行申请',
      'request.approved': '执行申请已全部通过',
      'request.rejected': '执行申请被驳回',
      'request.withdrawn': '执行申请已撤回',
      'request.invalidated': extra.status === 'expired' ? '执行申请已过期' : '执行申请已失效',
      'request.executed':
        extra.ok === false || extra.status === 'failed' ? '执行申请执行失败' : '执行申请已执行',
      'execution.finished': extra.ok === false ? '执行失败' : '执行完成',
      'emergency.executed': extra.ok === false || extra.status === 'failed' ? '紧急执行失败' : '紧急执行完成',
      'token.executed': extra.ok === false ? 'CI 令牌执行失败' : 'CI 令牌执行完成',
    };
    const lines = [
      `**项目**：${s.project.name}（${s.project.groupSlug}/${s.project.slug}）`,
      `**环境**：${s.env.name}${s.env.production ? '（生产）' : ''}`,
      `**操作**：${what}`,
      ...req.migrations.map(
        (m) => `- v${m.number} ${m.name}（${m.direction === 'down' ? '回滚' : '升级'}，${m.steps} 步）`,
      ),
      ...(extra.actor ? [`**操作人**：${extra.actor}`] : []),
      ...(extra.reason ? [`**说明**：${extra.reason}`] : []),
      ...(req.reason && !extra.reason ? [`**申请说明**：${req.reason}`] : []),
      ...(extra.error ? [`**错误**：${extra.error}`] : []),
    ].map((l) => scrubSecrets(l));
    const inserted = await this.webhooks.enqueueIn(tx, s.project.groupId, {
      type,
      title: `${titles[type]}：${s.project.name} / ${s.env.name}`,
      lines,
      url: this.requestUrl(s, req.id),
      data: {
        requestId: req.id,
        emergency: req.emergency,
        status: extra.status ?? req.status,
        project: {
          id: s.project.id,
          name: s.project.name,
          slug: s.project.slug,
          group: s.project.groupSlug,
        },
        environment: { id: s.env.id, name: s.env.name, production: s.env.production },
        kind,
        direction: execDir,
        fromVersionId: req.from_version_id,
        toVersionId: req.to_version_id,
        ...(refs.lca ? { lca: refs.lca } : {}),
        migrations: req.migrations.map((m) => ({ number: m.number, name: m.name, direction: m.direction })),
        actor: extra.actor ?? null,
        reason: extra.reason ?? null,
        ...(extra.ok !== undefined ? { ok: extra.ok } : {}),
      },
    });
    fx.enqueuedHooksCount += inserted;
    return inserted;
  }

  /** 事务提交之后：唤醒已入队的 Webhook 投递、实时推送未读数、广播“申请有变化”与跨副本通知 */
  async flushEffects(fx: Effects) {
    if (fx.enqueuedHooksCount > 0) this.webhooks.wake(true);
    const userIds = [...fx.users];
    for (const u of userIds) await this.publishUnreadLocal(u);
    if (userIds.length) await this.publishInboxChanged(userIds);
    if (fx.requestsChanged) {
      this.broadcastLocal({ requests: true });
      await this.publishInboxChanged([]);
    }
  }

  // ───── 执行结束 ─────

  /**
   * 申请的执行结束：转成已执行 / 执行失败（执行器报 request_stale 时转成失效），通知申请人（紧急执行通知审批人），发 Webhook。
   * 在锁里条件更新：只接受仍是 executing 的申请，以及被恢复逻辑记为“中断”的申请（result.code = interrupted，
   * 例如执行节点租约抖动短暂失联后真实结果才送达时，用真实结果覆盖）。
   */
  finish(
    c: Context | null,
    rid: string,
    user: { id: string; name: string },
    r: { ok: boolean; current: RequestVersionRef | null; error: { error: string; code?: string } | null },
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        const fx = new Effects();
        let envId: string | null = null;
        await withPolicyLock(this.db, async (tx) => {
          const [req] = await tx.query<RequestRow>('select * from exec_requests where id = $1', [rid]);
          if (!req) return;
          const interrupted = isInterrupted(req);
          if (req.status !== 'executing' && !interrupted) return;
          envId = req.environment_id;
          await tx.query('update exec_requests set executed_at = $2 where id = $1', [
            rid,
            new Date().toISOString(),
          ]);
          const result = {
            ok: r.ok,
            code: r.error?.code ?? null,
            error: r.error?.error ?? null,
            current: r.current,
          };
          const status: RequestStatus = r.ok
            ? 'executed'
            : r.error?.code === 'request_stale'
              ? 'invalid'
              : 'failed';
          await this.setStatus(tx, c, req, status, r.ok ? null : (r.error?.error ?? null), user, fx, {
            result,
            onlyIf: req.status,
          });
        });
        await this.flushEffects(fx);
        // 环境状态变了：同一个环境上别的申请要重新检查
        if (envId) this.kick({ envIds: [envId] });
      })(),
    );
  }

  // ───── 直接执行之后 ─────

  /**
   * 不经申请的直接执行 / 回滚 / 写基线结束之后：发 execution.finished 的 Webhook（执行和回滚），
   * 并让这个环境上还没结束的申请马上重新检查（环境状态变了的会失效）。
   */
  afterDirectRun(
    user: { id: string; name: string },
    a: { pid: string; env: EnvRow },
    run: { mode: 'migrate' | 'baseline'; to?: string; direction?: 'up' | 'down' | 'switch' },
    r: {
      ok: boolean;
      current: RequestVersionRef | null;
      ran: number;
      lca?: RequestVersionRef | null;
      error: { error: string; code?: string } | null;
    },
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        // 环境状态变了：这个环境上还没结束的申请要重新检查
        this.kick({ envIds: [a.env.id] });
        if (run.mode !== 'migrate') return;
        const s = await this.scopeOf(this.db, { project_id: a.pid, environment_id: a.env.id });
        if (!s) return;
        const toRef = run.to
          ? (
              await this.db.query<RequestVersionRef>('select id, number, name from versions where id = $1', [
                run.to,
              ])
            )[0]
          : undefined;
        const kind: RequestKind =
          run.direction === 'down' ? 'rollback' : run.direction === 'switch' ? 'switch' : 'execute';
        const what = actionLabel(kind, toRef?.number ?? null, r.lca?.number ?? null);
        const hookEvent: WebhookEventInput = {
          type: 'execution.finished',
          title: `${r.ok ? '执行完成' : '执行失败'}：${s.project.name} / ${s.env.name}`,
          lines: [
            `**项目**：${s.project.name}（${s.project.groupSlug}/${s.project.slug}）`,
            `**环境**：${s.env.name}${s.env.production ? '（生产）' : ''}`,
            `**操作**：${what}`,
            `**操作人**：${user.name}`,
            ...(r.ok ? [`**当前版本**：${r.current ? `v${r.current.number}` : '（无）'}`] : []),
            ...(r.error ? [`**错误**：${scrubSecrets(r.error.error)}`] : []),
          ],
          url: null,
          data: {
            project: {
              id: s.project.id,
              name: s.project.name,
              slug: s.project.slug,
              group: s.project.groupSlug,
            },
            environment: { id: s.env.id, name: s.env.name, production: s.env.production },
            direction: run.direction ?? 'up',
            ...(r.lca ? { lca: r.lca } : {}),
            toVersionId: run.to ?? null,
            actor: user.name,
            ok: r.ok,
            code: r.error?.code ?? null,
          },
        };
        try {
          const inserted = await this.webhooks.enqueueIn(this.db, s.project.groupId, hookEvent);
          if (inserted > 0) this.webhooks.wake(true);
        } catch (e) {
          console.error('直接执行 Webhook 入队失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      })(),
    );
  }

  // ───── CI 令牌执行之后（P6） ─────

  /**
   * CI 令牌的执行结束之后（成功或失败；预演不算）：
   * - 这个环境上还没结束的执行申请马上重新检查（环境状态变了的会失效，P5b 的规则）；
   * - 组级 Webhook 发 token.executed（所有环境）；
   * - **生产环境**给收件箱发 token_execution：项目管理员（含组管理员、实例管理员，和审批人范围里的“项目管理员”同一个定义）
   *   和环境当前审批流程里每个环节现在有资格的审批人（没配环节时是有执行权限的人）。非生产不发站内通知（太频繁），只有 Webhook。
   * 自己的错误只记日志，不影响已经返回给 CI 的结果。
   */
  afterTokenRun(
    token: { id: string; name: string; prefix: string; createdByName: string | null },
    a: { pid: string; env: EnvRow },
    target: RequestVersionRef,
    r: {
      ok: boolean;
      noop?: boolean;
      current: RequestVersionRef | null;
      ran: number[];
      error: { error: string; code: string } | null;
    },
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        this.kick({ envIds: [a.env.id] });
        const s = await this.scopeOf(this.db, { project_id: a.pid, environment_id: a.env.id });
        if (!s) return;
        const who = `CI 令牌 ${token.name}（${token.prefix}…）`;
        const where = `${s.project.name} / ${s.env.name}`;
        const hookEvent: WebhookEventInput = {
          type: 'token.executed',
          title: `${r.ok ? 'CI 令牌执行完成' : 'CI 令牌执行失败'}：${where}`,
          lines: [
            `**项目**：${s.project.name}（${s.project.groupSlug}/${s.project.slug}）`,
            `**环境**：${s.env.name}${s.env.production ? '（生产）' : ''}`,
            `**操作**：执行到 v${target.number}${r.noop ? '（已在目标版本，无变更）' : ''}`,
            `**令牌**：${token.name}（\`${token.prefix}…\`）${token.createdByName ? `，创建者 ${token.createdByName}` : ''}`,
            ...(r.ok ? [`**当前版本**：${r.current ? `v${r.current.number}` : '（无）'}`] : []),
            ...(r.error ? [`**错误**：${scrubSecrets(r.error.error)}`] : []),
          ],
          url: null,
          data: {
            project: {
              id: s.project.id,
              name: s.project.name,
              slug: s.project.slug,
              group: s.project.groupSlug,
            },
            environment: { id: s.env.id, name: s.env.name, production: s.env.production },
            token: {
              id: token.id,
              name: token.name,
              prefix: token.prefix,
              createdBy: token.createdByName,
            },
            toVersion: target.number,
            current: r.current?.number ?? null,
            ran: r.ran,
            noop: r.noop ?? false,
            ok: r.ok,
            code: r.error?.code ?? null,
          },
        };
        // 生产环境无变更的幂等空跑（noop）或非生产环境：不向收件箱刷屏，同步持久化 Webhook 后立即唤醒
        if (!s.env.production || (r.ok && r.noop)) {
          try {
            const inserted = await this.webhooks.enqueueIn(this.db, s.project.groupId, hookEvent);
            if (inserted > 0) this.webhooks.wake(true);
          } catch (e) {
            console.error('令牌执行 Webhook 入队失败', e instanceof Error ? scrubSecrets(e.message) : e);
          }
          return;
        }
        const fx = new Effects();
        try {
          await this.db.transaction(async (tx) => {
            fx.enqueuedHooksCount += await this.webhooks.enqueueIn(tx, s.project.groupId, hookEvent);
            const audience = await loadAudience(tx, s.project);
            const scope: StageScope = {
              project: s.project,
              env: { id: s.env.id, production: s.env.production },
              resolved: s.resolved,
              direction: 'up',
            };
            const stages = stagesOf(flowOf(s.resolved));
            const data = {
              title: `${r.ok ? 'CI 令牌执行了生产环境' : 'CI 令牌执行生产环境失败'}：${where}`,
              body: `${who} 执行到 v${target.number}${
                r.ok
                  ? `，当前版本 ${r.current ? `v${r.current.number}` : '（无）'}`
                  : `：${scrubSecrets(r.error?.error ?? '')}`
              }`,
              event: r.ok ? 'token_executed' : 'token_failed',
              actor: who,
              params: {
                project: s.project.name,
                env: s.env.name,
                to: target.number,
                current: r.current?.number ?? null,
                token: token.name,
                prefix: token.prefix,
                code: r.error?.code ?? null,
              },
            };
            for (const u of audience.values()) {
              const role = effectiveRole(u, s.project);
              if (!role) continue;
              if (role !== 'admin' && !stages.some((spec) => eligibleFor(u, spec, scope))) continue;
              await tx.query(
                `insert into inbox_items (id, user_id, kind, project_id, environment_id, request_id, data, created_at)
                 values ($1, $2, 'token_execution', $3, $4, null, $5::text::jsonb, $6)`,
                [newId(), u.userId, s.project.id, s.env.id, JSON.stringify(data), new Date().toISOString()],
              );
              fx.users.add(u.userId);
            }
          });
          await this.flushEffects(fx);
        } catch (e) {
          console.error('令牌执行通知写库失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      })(),
    );
  }

  // ───── 实时推送（收件箱） ─────

  subscribe(userId: string, fn: Listener, onClose?: () => void): () => void {
    if (this.stopped) {
      onClose?.();
      return () => {};
    }
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    this.listeners.set(userId, set);
    set.add(fn);
    if (onClose) this.stopListeners.add(onClose);
    return () => {
      set.delete(fn);
      if (!set.size && this.listeners.get(userId) === set) this.listeners.delete(userId);
      if (onClose) this.stopListeners.delete(onClose);
    };
  }

  /**
   * 未读数：和收件箱列表同一条可见性规则（第一轮审查：直接数全部未读会泄露“看不到的项目里有动静”）。
   * 过滤在 SQL 里做（第二轮审查）：先算出这个用户现在看得到的项目，再 count。rc 不给就按这个用户现在的角色读一次；
   * 账号不存在 / 停用时是 0。
   */
  async unread(db: Db, userId: string, rc?: RoleContext): Promise<number> {
    const ctx = rc ?? (await this.roleContextOf(db, userId));
    if (!ctx) return 0;
    const v = await this.visibleFilter(db, ctx, '', 2);
    const [r] = await db.query<{ n: number | string }>(
      `select count(*) as n from inbox_items where user_id = $1 and read_at is null and ${v.sql}`,
      [userId, ...v.params],
    );
    return Number(r?.n ?? 0);
  }

  /** 全部标为已读：只作用于现在看得到的通知（看不到的项目的通知保持原样，重新看得到时仍是未读） */
  async readAll(db: Db, userId: string, rc: RoleContext): Promise<void> {
    const v = await this.visibleFilter(db, rc, '', 3);
    await db.query(
      `update inbox_items set read_at = $2 where user_id = $1 and read_at is null and ${v.sql}`,
      [userId, new Date().toISOString(), ...v.params],
    );
  }

  private async roleContextOf(db: Db, userId: string): Promise<RoleContext | null> {
    const [u] = await db.query<{ id: string; role: string; status: string }>(
      'select id, role, status from users where id = $1',
      [userId],
    );
    return u && u.status === 'active' ? loadRoleContext(db, u) : null;
  }

  /**
   * “这条通知现在看得到”的 SQL 条件：没有项目的（以后的实例级通知）总是可见，有项目的要在这个用户现在看得到的项目里
   * （生效角色非空，和其他地方同一个规则：roles.ts 的 visibleProjects）。prefix 是表别名（带点），start 是第一个参数的序号。
   */
  private async visibleFilter(db: Db, rc: RoleContext, prefix: string, start: number) {
    // 实例管理员看得到全部项目，不需要过滤（也避免把全实例的项目 id 展开成超长的 IN 列表）
    if (rc.instanceAdmin) return { sql: 'true', params: [] as string[] };
    // 只取这个用户的通知里出现过的项目，再与可见项目求交：IN 列表的长度受通知涉及的项目数约束，而不是可见项目总数
    const mine = new Set(
      (
        await db.query<{ project_id: string }>(
          'select distinct project_id from inbox_items where user_id = $1 and project_id is not null',
          [rc.userId],
        )
      ).map((r) => r.project_id),
    );
    const ids = mine.size
      ? (await visibleProjects(db, rc)).map((p) => p.id).filter((id) => mine.has(id))
      : [];
    return {
      sql: ids.length
        ? `(${prefix}project_id is null or ${prefix}project_id in (${inList(ids, start)}))`
        : `${prefix}project_id is null`,
      params: ids,
    };
  }

  /** 仅推送未读数给本副本上这个用户的实时连接；调用方已经算好的值直接用，不再查 */
  private async publishUnreadLocal(userId: string, known?: number) {
    const set = this.listeners.get(userId);
    if (!set?.size) return;
    const unread = known ?? (await this.unread(this.db, userId).catch(() => null));
    if (unread === null) return;
    for (const fn of set) fn({ unread });
  }

  /** 向其他副本广播收件箱变更（分批防止超过 PG NOTIFY 8 KB 上限；空数组表示“申请列表有变化”） */
  private async publishInboxChanged(userIds: string[]) {
    if (!this.bus) return;
    if (!userIds.length) {
      await this.bus.publish({ t: 'inbox.changed', userIds: [] }).catch((e) => {
        console.error('广播收件箱变更失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
      return;
    }
    for (let i = 0; i < userIds.length; i += INBOX_CHANGED_BATCH) {
      const chunk = userIds.slice(i, i + INBOX_CHANGED_BATCH);
      await this.bus.publish({ t: 'inbox.changed', userIds: chunk }).catch((e) => {
        console.error('广播收件箱变更失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }
  }

  /** 推送未读数给这个用户的实时连接（本副本立即推送 + 跨副本广播）；调用方已经算好的值直接用，不再查 */
  async publishUnread(userId: string, known?: number) {
    await this.publishUnreadLocal(userId, known);
    await this.publishInboxChanged([userId]);
  }

  /** 仅向本副本活跃 SSE 订阅者广播一个不带内容的“申请有变化” */
  private broadcastLocal(e: InboxEvent) {
    for (const set of this.listeners.values()) for (const fn of set) fn(e);
  }

  /** 广播一个不带内容的“申请有变化”（界面据此重新拉自己能看到的列表；不泄露是哪个项目） */
  broadcast(e: InboxEvent) {
    this.broadcastLocal(e);
  }

  // ───── 视图 ─────

  async summaries(db: Db, rows: RequestRow[]): Promise<ExecRequestSummary[]> {
    if (!rows.length) return [];
    const pids = [...new Set(rows.map((r) => r.project_id))];
    const projects = new Map(
      (
        await db.query<{ id: string; name: string; slug: string; groupSlug: string }>(
          `select p.id, p.name, p.slug, g.slug as "groupSlug" from projects p join groups g on g.id = p.group_id
            where p.id in (${inList(pids)})`,
          pids,
        )
      ).map((p) => [p.id, p]),
    );
    const eids = [...new Set(rows.map((r) => r.environment_id))];
    const envs = new Map(
      (
        await db.query<{ id: string; name: string; production: boolean }>(
          `select id, name, production from environments where id in (${inList(eids)})`,
          eids,
        )
      ).map((e) => [e.id, e]),
    );
    const vids = [
      ...new Set(rows.flatMap((r) => [r.to_version_id, r.from_version_id].filter((x): x is string => !!x))),
    ];
    const versions = new Map(
      (
        await db.query<RequestVersionRef>(
          `select id, number, name from versions where id in (${inList(vids)})`,
          vids,
        )
      ).map((v) => [v.id, v]),
    );
    const uids = [...new Set(rows.map((r) => r.requested_by).filter((x): x is string => !!x))];
    const users = new Map(
      uids.length
        ? (
            await db.query<{ id: string; name: string }>(
              `select id, name from users where id in (${inList(uids)})`,
              uids,
            )
          ).map((u) => [u.id, u])
        : [],
    );
    return rows.map((r) => {
      const p = projects.get(r.project_id);
      const e = envs.get(r.environment_id);
      return {
        id: r.id,
        project: p ?? { id: r.project_id, name: '', slug: '', groupSlug: '' },
        environment: e ?? { id: r.environment_id, name: '', production: r.production },
        kind: requestKindOf(r),
        from: r.from_version_id ? (versions.get(r.from_version_id) ?? null) : null,
        to: versions.get(r.to_version_id) ?? { id: r.to_version_id, number: -1, name: '' },
        status: r.status,
        statusReason: r.status_reason,
        stage: r.stage,
        stageCount: stagesOf(r.flow).length,
        requestedBy: r.requested_by
          ? (users.get(r.requested_by) ?? { id: r.requested_by, name: r.requested_by })
          : null,
        reason: r.reason,
        emergency: r.emergency,
        createdAt: iso(r.created_at)!,
        expiresAt: iso(r.expires_at)!,
        updatedAt: iso(r.updated_at)!,
      };
    });
  }

  /** 当前用户在这个申请上能做的事 */
  actionsFor(
    req: RequestRow,
    rc: RoleContext,
    scope: StageScope | null,
    approvals: { stage: number; user_id: string | null }[],
  ): RequestActions {
    const none: RequestActions = {
      approve: false,
      reject: false,
      approveAndExecute: false,
      execute: false,
      withdraw: false,
      note: null,
    };
    // 紧急执行的记录不能经申请的流程重试或撤回（第一轮审查：否则失败后任何有执行权的人都能绕过全部审批重试）
    if (req.emergency)
      return {
        ...none,
        note:
          req.status === 'failed'
            ? '紧急执行失败后不能在这里重试：需要的话请重新发起紧急执行，或提交执行申请'
            : null,
      };
    // 执行中被中断（结果未知）的申请不能直接重试或撤回：避免状态未明时重复执行或破坏原节点 finish() 兜底回写（#18）
    if (isInterrupted(req))
      return {
        ...none,
        note: '执行中服务重启或执行节点离线，结果未知，不能直接重试：请到环境页查看执行历史后重新提交执行申请',
      };
    const mine = req.requested_by === rc.userId;
    const withdraw =
      mine && (req.status === 'pending' || req.status === 'approved' || req.status === 'failed');
    if (!scope) return { ...none, withdraw };
    const stages = stagesOf(req.flow);
    const right = hasExecRight(rc, scope);
    if (req.status === 'pending') {
      const spec = stages[req.stage]!;
      const decided = approvals.some((a) => a.stage === req.stage && a.user_id === rc.userId);
      const eligible = eligibleFor(rc, spec, scope);
      const done = approvals.filter((a) => a.stage === req.stage).length;
      const completes = req.stage === stages.length - 1 && done + 1 >= spec.count;
      const mustExecute = completes && spec.lastApproverExecutes;
      const can = !mine && eligible && !decided;
      const note = mine
        ? '申请人不能审批自己的申请'
        : !eligible
          ? '你不在当前环节的审批人范围内'
          : decided
            ? '你已经处理过这个环节'
            : mustExecute && !right
              ? '最后一个环节的审批人要同时执行迁移：你没有这个环境的执行权限'
              : null;
      return {
        approve: can && !mustExecute,
        reject: can,
        approveAndExecute: can && mustExecute && right,
        execute: false,
        withdraw,
        note,
      };
    }
    if (req.status === 'approved' || req.status === 'failed')
      return {
        ...none,
        execute: right,
        withdraw,
        note: right ? null : '已全部通过，等待有执行权限的人执行',
      };
    return { ...none, withdraw };
  }

  async detail(
    db: Db,
    req: RequestRow,
    user: { id: string; role: string },
    rc: RoleContext,
  ): Promise<ExecRequestDetail> {
    const [summary] = await this.summaries(db, [req]);
    const s = await this.scopeOf(db, req);
    const scope = s ? this.stageScope(s, req) : null;
    const approvals = await db.query<{
      stage: number;
      user_id: string | null;
      name: string | null;
      decision: 'approve' | 'reject';
      comment: string;
      at: unknown;
    }>(
      `select a.stage, a.user_id, u.name, a.decision, a.comment, a.at
         from exec_approvals a left join users u on u.id = a.user_id
        where a.request_id = $1 order by a.at`,
      [req.id],
    );
    const names = await policyNames(db, [{ approval: req.flow.stages }]);
    const open = req.status === 'pending';
    // 只读项目的受众（审批人必须能看到项目），不读全实例的用户
    const all = open && s ? await loadAudience(db, s.project) : null;
    const stages: RequestStageView[] = stagesOf(req.flow).map((spec, index) => {
      const mine = approvals.filter((a) => a.stage === index);
      return {
        index,
        approvers: spec.approvers,
        label: approversLabel(spec.approvers, names),
        count: spec.count,
        lastApproverExecutes: spec.lastApproverExecutes,
        approvals: mine.map((a) => ({
          stage: a.stage,
          userId: a.user_id,
          userName: a.name,
          decision: a.decision,
          comment: a.comment,
          at: iso(a.at)!,
        })),
        done: mine.filter((a) => a.decision === 'approve').length >= spec.count,
        eligible:
          all && scope
            ? [...all.values()].filter((u) => u.userId !== req.requested_by && eligibleFor(u, spec, scope))
                .length
            : 0,
      };
    });
    const timeline = await this.timeline(db, req.id);
    const [executor] = req.executed_by
      ? await db.query<{ id: string; name: string }>('select id, name from users where id = $1', [
          req.executed_by,
        ])
      : [];
    return {
      ...summary!,
      migrations: req.migrations,
      dryRun: req.dry_run,
      implicit: req.flow.implicit,
      stages,
      timeline,
      executedBy: executor ?? (req.executed_by ? { id: req.executed_by, name: req.executed_by } : null),
      executedAt: iso(req.executed_at),
      result: req.result,
      actions: this.actionsFor(req, { ...rc, userId: user.id }, scope, approvals),
    };
  }

  /** 审批时间线：这个申请的全部审计记录（谁、什么时候、做了什么、意见） */
  private async timeline(db: Db, rid: string): Promise<RequestTimelineEntry[]> {
    const rows = await db.query<{
      at: unknown;
      action: string;
      name: string | null;
      data: Record<string, unknown> | null;
    }>(
      `select a.at, a.action, u.name, a.data from audit_events a left join users u on u.id = a.actor_id
        where a.target_kind = 'exec_request' and a.target_id = $1 order by a.at, a.id`,
      [rid],
    );
    const KIND: Record<string, string> = {
      'exec_request.create': 'created',
      'exec_request.approve': 'approve',
      'exec_request.reject': 'reject',
      'exec_request.withdraw': 'withdraw',
      'exec_request.invalidate': 'invalid',
      'exec_request.expire': 'expire',
      'exec_request.execute': 'execute',
      'exec_request.finish': 'finish',
      'environment.emergency': 'emergency',
    };
    // 同一个事务里的几条审计可能落在同一毫秒：按动作的先后关系排（通过 → 开始执行 → 结束）
    const RANK: Record<string, number> = {
      'exec_request.create': 0,
      'environment.emergency': 0,
      'exec_request.approve': 1,
      'exec_request.reject': 1,
      'exec_request.execute': 2,
      'exec_request.finish': 3,
    };
    const time = (v: unknown) => new Date(iso(v)!).getTime();
    rows.sort((x, y) => time(x.at) - time(y.at) || (RANK[x.action] ?? 4) - (RANK[y.action] ?? 4));
    return rows.map((r) => {
      const d = r.data ?? {};
      const kind =
        r.action === 'exec_request.finish'
          ? d.ok === false
            ? 'failed'
            : 'executed'
          : (KIND[r.action] ?? r.action);
      return {
        at: iso(r.at)!,
        kind,
        userName: r.name,
        stage: typeof d.stage === 'number' ? d.stage : null,
        comment:
          typeof d.comment === 'string' && d.comment
            ? d.comment
            : typeof d.reason === 'string'
              ? d.reason
              : null,
      };
    });
  }

  // ───── 收件箱 ─────

  /** 收件箱列表（新的在前）：可见性过滤和条数限制都在 SQL 里（第二轮审查） */
  async inbox(
    db: Db,
    user: { id: string; role: string },
    rc: RoleContext,
    limit = 100,
  ): Promise<InboxItem[]> {
    const v = await this.visibleFilter(db, rc, 'i.', 2);
    const rows = await db.query<{
      id: string;
      kind: InboxKind;
      created_at: unknown;
      read_at: unknown;
      project_id: string | null;
      environment_id: string | null;
      request_id: string | null;
      data: InboxItem['data'];
      pname: string | null;
      pslug: string | null;
      gslug: string | null;
      ename: string | null;
    }>(
      `select i.id, i.kind, i.created_at, i.read_at, i.project_id, i.environment_id, i.request_id, i.data,
              p.name as pname, p.slug as pslug, g.slug as gslug, e.name as ename
         from inbox_items i
         left join projects p on p.id = i.project_id
         left join groups g on g.id = p.group_id
         left join environments e on e.id = i.environment_id
        where i.user_id = $1 and ${v.sql}
        order by i.created_at desc, i.id desc
        limit ${Math.max(1, Math.floor(limit))}`,
      [user.id, ...v.params],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: iso(r.created_at)!,
      readAt: iso(r.read_at),
      project:
        r.project_id && r.pname
          ? { id: r.project_id, name: r.pname, slug: r.pslug ?? '', groupSlug: r.gslug ?? '' }
          : null,
      environment: r.environment_id && r.ename ? { id: r.environment_id, name: r.ename } : null,
      requestId: r.request_id,
      data: r.data,
    }));
  }

  /** 等我处理的申请：当前环节我能批，或者已经全部通过、我有执行权限 */
  async pendingFor(db: Db, user: { id: string; role: string }, rc: RoleContext): Promise<PendingRequest[]> {
    const rows = await db.query<RequestRow>(
      `select * from exec_requests where status in ('pending', 'approved', 'failed') order by created_at`,
    );
    const out: { row: RequestRow; action: 'approve' | 'execute' }[] = [];
    const scopes = new Map<string, RequestScope | null>();
    // 一次读出这些申请的全部审批记录（第一轮审查：不要每个申请一条查询）
    const byRequest = new Map<string, { stage: number; user_id: string | null }[]>();
    const rids = rows.map((r) => r.id);
    for (let i = 0; i < rids.length; i += 500) {
      const chunk = rids.slice(i, i + 500);
      for (const a of await db.query<{ request_id: string; stage: number; user_id: string | null }>(
        `select request_id, stage, user_id from exec_approvals where request_id in (${inList(chunk)})`,
        chunk,
      ))
        byRequest.set(a.request_id, [...(byRequest.get(a.request_id) ?? []), a]);
    }
    for (const r of rows) {
      let s = scopes.get(r.environment_id);
      if (s === undefined) {
        s = await this.scopeOf(db, r);
        scopes.set(r.environment_id, s);
      }
      if (!s || !effectiveRole(rc, s.project)) continue;
      const act = this.actionsFor(
        r,
        { ...rc, userId: user.id },
        this.stageScope(s, r),
        byRequest.get(r.id) ?? [],
      );
      if (act.approve || act.approveAndExecute) out.push({ row: r, action: 'approve' });
      else if (act.execute && r.status === 'approved') out.push({ row: r, action: 'execute' });
    }
    const sums = await this.summaries(
      db,
      out.map((o) => o.row),
    );
    return sums.map((s, i) => ({ ...s, myAction: out[i]!.action }));
  }

  /** 单个申请的绑定检查（详情页打开时）：失效 / 过期的当场转成终态并通知 */
  async recheck(rid: string) {
    // 先只读判断（不拿全局锁，第一轮审查）；发现不成立再在锁内重新读、条件更新
    const [r] = await this.db.query<RequestRow>(
      `select * from exec_requests where id = $1 and ${sweepWhere(this.db.dialect)}`,
      [rid],
    );
    if (r && !isInterrupted(r) && (await bindingProblem(this.db, r))) await this.closeStale([rid]);
  }

  /** 申请的有效期（小时 → 到期时间） */
  static expiry(resolved: ResolvedPolicy, from = new Date()): string {
    return new Date(from.getTime() + resolved.requestTtlHours.value * 3600_000).toISOString();
  }
}
