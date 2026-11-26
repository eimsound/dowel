// 执行申请行与它的派生信息：行结构、读取、连接指纹、申请类型 / 方向、状态文案、中断判断与巡检条件、
// 事务内收集的副作用（Effects）与通知内容（NoticeData）。
import { createHash } from 'node:crypto';

import type { ExecRequestDetail, RequestKind, RequestMigration, RequestStatus } from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import type { PlatformDb } from '../db.ts';
import type { EnvRow } from '../envs.ts';
import { decrypt, keyedDigest } from '../secrets.ts';
import type { FlowSnapshot } from './flow.ts';

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

export const actionLabel = (kind: RequestKind, toNum: number | null, lcaNum: number | null): string => {
  if (kind === 'switch') {
    const toText = toNum !== null ? ` v${toNum}` : '';
    const lcaText = lcaNum !== null ? `（先回滚到 v${lcaNum}）` : '';
    return `切换到${toText}${lcaText}`;
  }
  return `${kind === 'rollback' ? '回滚' : '执行'}${toNum !== null ? `到 v${toNum}` : ''}`;
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
