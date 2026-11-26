// 申请的视图：列表摘要、详情（环节、时间线、当前用户能做的事）、“等我处理”的申请。只读，不改状态。
import type {
  ExecRequestDetail,
  ExecRequestSummary,
  PendingRequest,
  RequestActions,
  RequestStageView,
  RequestTimelineEntry,
  RequestVersionRef,
} from '@dowel/api';
import type { Db } from '@dowel/engines';

import { inList } from '../db.ts';
import { iso } from '../envs.ts';
import { policyNames } from '../policy.ts';
import { effectiveRole, type RoleContext } from '../roles.ts';
import { approversLabel, eligibleFor, hasExecRight, loadAudience, type StageScope } from './eligibility.ts';
import { stagesOf } from './flow.ts';
import { isInterrupted, type RequestRow, requestKindOf } from './model.ts';
import type { RequestScope } from './scope.ts';

/**
 * 详情与“等我处理”经 Requests 实例调用的公开方法：保持原来经实例（this）的方法分派，
 * 实例上覆写或 spy 这些方法时内部路径同样生效。
 */
export interface ViewHost {
  summaries(db: Db, rows: RequestRow[]): Promise<ExecRequestSummary[]>;
  scopeOf(db: Db, req: Pick<RequestRow, 'project_id' | 'environment_id'>): Promise<RequestScope | null>;
  stageScope(s: RequestScope, req: Pick<RequestRow, 'direction' | 'migrations'>): StageScope;
  actionsFor(
    req: RequestRow,
    rc: RoleContext,
    scope: StageScope | null,
    approvals: { stage: number; user_id: string | null }[],
  ): RequestActions;
}

export const summaries = async (db: Db, rows: RequestRow[]): Promise<ExecRequestSummary[]> => {
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
};

/** 当前用户在这个申请上能做的事 */
export const actionsFor = (
  req: RequestRow,
  rc: RoleContext,
  scope: StageScope | null,
  approvals: { stage: number; user_id: string | null }[],
): RequestActions => {
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
  const withdraw = mine && (req.status === 'pending' || req.status === 'approved' || req.status === 'failed');
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
};

/** 审批时间线：这个申请的全部审计记录（谁、什么时候、做了什么、意见） */
const loadTimeline = async (db: Db, rid: string): Promise<RequestTimelineEntry[]> => {
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
};

export const detail = async (
  host: ViewHost,
  db: Db,
  req: RequestRow,
  user: { id: string; role: string },
  rc: RoleContext,
): Promise<ExecRequestDetail> => {
  const [summary] = await host.summaries(db, [req]);
  const s = await host.scopeOf(db, req);
  const scope = s ? host.stageScope(s, req) : null;
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
  const timeline = await loadTimeline(db, req.id);
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
    actions: host.actionsFor(req, { ...rc, userId: user.id }, scope, approvals),
  };
};

/** 等我处理的申请：当前环节我能批，或者已经全部通过、我有执行权限 */
export const pendingFor = async (
  host: ViewHost,
  db: Db,
  user: { id: string; role: string },
  rc: RoleContext,
): Promise<PendingRequest[]> => {
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
      s = await host.scopeOf(db, r);
      scopes.set(r.environment_id, s);
    }
    if (!s || !effectiveRole(rc, s.project)) continue;
    const act = host.actionsFor(
      r,
      { ...rc, userId: user.id },
      host.stageScope(s, r),
      byRequest.get(r.id) ?? [],
    );
    if (act.approve || act.approveAndExecute) out.push({ row: r, action: 'approve' });
    else if (act.execute && r.status === 'approved') out.push({ row: r, action: 'execute' });
  }
  const sums = await host.summaries(
    db,
    out.map((o) => o.row),
  );
  return sums.map((s, i) => ({ ...s, myAction: out[i]!.action }));
};
