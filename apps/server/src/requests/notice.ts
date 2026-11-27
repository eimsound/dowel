// 通知与 Webhook 的内容：收件箱通知（中文快照 + 结构化参数）与各类 Webhook 事件的标题、正文和数据。
// 这里只拼内容、读版本号，不写库：写收件箱、持久化入队 Webhook 都由调用方在自己的事务里做（见 service.ts）。
import type {
  RequestKind,
  RequestStatus,
  RequestVersionRef,
  WebhookEventInput,
  WebhookEventType,
} from '@dowel/api';
import type { Db } from '@dowel/engines';

import { inList } from '../db.ts';
import { scrubSecrets } from '../secrets.ts';
import { actionLabel, execDirectionOf, type NoticeData, type RequestRow, requestKindOf } from './model.ts';
import type { RequestScope } from './scope.ts';

/** 一条申请通知的输入（事件、结果状态、操作人、说明、环节） */
export interface NoticeInput {
  event: string;
  status?: RequestStatus;
  action?: 'approve' | 'execute';
  actor?: string | null;
  reason?: string | null;
  stage?: number;
}

/** 申请涉及的版本：起点、目标与切换时的公共祖先（LCA） */
export interface VersionRefs {
  from: RequestVersionRef | null;
  to: RequestVersionRef;
  lca: RequestVersionRef | null;
}

export const versionRefs = async (
  db: Db,
  req: Pick<RequestRow, 'direction' | 'from_version_id' | 'to_version_id' | 'migrations'>,
): Promise<VersionRefs> => {
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
};

export const noticeData = (
  req: RequestRow,
  s: RequestScope,
  refs: VersionRefs,
  n: NoticeInput,
): NoticeData => {
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
};

/** 申请相关 Webhook 事件的附加信息 */
export interface RequestHookExtra {
  actor?: string | null;
  reason?: string | null;
  status?: RequestStatus;
  ok?: boolean;
  error?: string | null;
}

/** 申请相关的 Webhook 事件。消息里只有项目、环境、版本号、人名、状态和原因，没有连接信息 */
export const requestHookEvent = (
  type: WebhookEventType,
  req: RequestRow,
  s: RequestScope,
  refs: VersionRefs,
  url: string | null,
  extra: RequestHookExtra,
): WebhookEventInput => {
  const kind = requestKindOf(req);
  const execDir = execDirectionOf(req);
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
  return {
    type,
    title: `${titles[type]}：${s.project.name} / ${s.env.name}`,
    lines,
    url,
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
  };
};

/** 直接执行 / 回滚的参数 */
export interface DirectRun {
  to: string;
  direction: 'up' | 'down' | 'switch';
}

/** 直接执行 / 回滚的结果 */
export interface DirectRunResult {
  ok: boolean;
  current: RequestVersionRef | null;
  ran: number;
  lca?: RequestVersionRef | null;
  error: { error: string; code?: string } | null;
}

/** 不经申请的直接执行 / 回滚结束后的 execution.finished 事件 */
export const directRunHookEvent = (
  user: { id: string; name: string },
  s: RequestScope,
  run: DirectRun,
  r: DirectRunResult,
  toRef: RequestVersionRef | undefined,
): WebhookEventInput => {
  const kind: RequestKind =
    run.direction === 'down' ? 'rollback' : run.direction === 'switch' ? 'switch' : 'execute';
  const what = actionLabel(kind, toRef?.number ?? null, r.lca?.number ?? null);
  return {
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
      direction: run.direction,
      ...(r.lca ? { lca: r.lca } : {}),
      toVersionId: run.to,
      actor: user.name,
      ok: r.ok,
      code: r.error?.code ?? null,
    },
  };
};

/** CI 令牌（P6） */
export interface TokenRef {
  id: string;
  name: string;
  prefix: string;
  createdByName: string | null;
}

/** CI 令牌执行的结果 */
export interface TokenRunResult {
  ok: boolean;
  noop?: boolean;
  current: RequestVersionRef | null;
  ran: number[];
  error: { error: string; code: string } | null;
}

/** CI 令牌执行结束后的 token.executed 事件（所有环境） */
export const tokenRunHookEvent = (
  token: TokenRef,
  s: RequestScope,
  target: RequestVersionRef,
  r: TokenRunResult,
): WebhookEventInput => {
  const where = `${s.project.name} / ${s.env.name}`;
  return {
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
};

/** 生产环境 CI 令牌执行的收件箱通知内容（token_execution） */
export const tokenNoticeData = (
  token: TokenRef,
  s: RequestScope,
  target: RequestVersionRef,
  r: TokenRunResult,
) => {
  const who = `CI 令牌 ${token.name}（${token.prefix}…）`;
  const where = `${s.project.name} / ${s.env.name}`;
  return {
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
};
