// 执行申请、审批与收件箱（P5b，E3 / E4 / E5 / E7）的接口契约。规则见 ADR 0006，实现在 apps/server/src/requests.ts。
import { z } from 'zod';
import type { Approver } from './policy.ts';

/**
 * 申请的状态：
 * - pending：待审批（stage 是当前环节）；approved：所有环节都通过了，等待执行；executing：正在执行；
 * - executed：执行成功；failed：执行失败（绑定仍然成立时可以重试，否则会转成 invalid）；
 * - rejected（驳回）/ withdrawn（撤回）/ invalid（失效）/ expired（过期）：终态。
 */
export const REQUEST_STATUSES = [
  'pending',
  'approved',
  'executing',
  'executed',
  'failed',
  'rejected',
  'withdrawn',
  'invalid',
  'expired',
] as const;
export const requestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/** 还没结束的状态（环境页的“待处理申请”、绑定检查都只看这些） */
export const OPEN_REQUEST_STATUSES: readonly RequestStatus[] = ['pending', 'approved', 'executing', 'failed'];

const reasonText = z.string().trim().max(2000, '最多 2000 个字');

/** 提交执行申请：执行（向前）或回滚到 to；起始版本取提交时环境的当前版本，服务端先跑一次预演，不通过不能提交 */
export const requestCreateSchema = z
  .object({
    kind: z.enum(['execute', 'rollback']),
    to: z.string().min(1),
    reason: reasonText.default(''),
  })
  .strict();
export type RequestCreate = z.infer<typeof requestCreateSchema>;

/** 通过某个环节：stage 必须等于申请当前的环节（每个环节单独确认，不能一次点击跨多个环节） */
export const requestApproveSchema = z
  .object({ stage: z.number().int().min(0), comment: reasonText.default('') })
  .strict();
export type RequestApprove = z.infer<typeof requestApproveSchema>;

/** 驳回：必须写意见 */
export const requestRejectSchema = z
  .object({ stage: z.number().int().min(0), comment: reasonText.min(1, '驳回需要填写意见') })
  .strict();
export type RequestReject = z.infer<typeof requestRejectSchema>;

/**
 * 执行申请（SSE，事件和直接执行相同）。approve：“通过并执行”——先在同一个事务里通过最后一个环节，再执行。
 * 生产环境要在 confirm 里填环境名。
 */
export const requestExecuteSchema = z
  .object({ confirm: z.string().optional(), approve: requestApproveSchema.optional() })
  .strict();
export type RequestExecute = z.infer<typeof requestExecuteSchema>;

/** 紧急执行（只有实例管理员）：绕过审批，不绕过漂移、完整性、前置环境等检查；必须写原因 */
export const emergencyExecuteSchema = z
  .object({
    kind: z.enum(['execute', 'rollback']),
    to: z.string().min(1),
    reason: reasonText.min(1, '紧急执行必须填写原因'),
    confirm: z.string().optional(),
  })
  .strict();
export type EmergencyExecute = z.infer<typeof emergencyExecuteSchema>;

/** 审批人范围（视图）：配置的范围，或默认流程的“有执行权限的人”（can_execute） */
export type RequestApprovers = Approver | { kind: 'can_execute' };

export interface ApprovalView {
  stage: number;
  userId: string | null;
  userName: string | null;
  decision: 'approve' | 'reject';
  comment: string;
  at: string;
}

export interface RequestStageView {
  index: number;
  approvers: RequestApprovers;
  /** 审批人范围的中文说明（含组名 / 用户名） */
  label: string;
  /** 需要几人通过 */
  count: number;
  lastApproverExecutes: boolean;
  approvals: ApprovalView[];
  /** 凑够人数了 */
  done: boolean;
  /** 现在有资格批这个环节的人数（按当前的成员关系，不含申请人）；少于 count 时这个环节批不完 */
  eligible: number;
}

/** 申请绑定的一个迁移（提交时的快照） */
export interface RequestMigration {
  versionId: string;
  number: number;
  name: string;
  direction: 'up' | 'down';
  checksum: string;
  steps: number;
  nonTransactional: number;
}

export interface RequestVersionRef {
  id: string;
  number: number;
  name: string;
}

export interface ExecRequestSummary {
  id: string;
  project: { id: string; name: string; slug: string; groupSlug: string };
  environment: { id: string; name: string; production: boolean };
  kind: 'execute' | 'rollback';
  from: RequestVersionRef | null;
  to: RequestVersionRef;
  status: RequestStatus;
  /** 失效 / 过期 / 驳回 / 执行失败的原因（给人看的中文） */
  statusReason: string | null;
  /** 当前环节（0 起）；approved 之后等于 stageCount */
  stage: number;
  stageCount: number;
  requestedBy: { id: string; name: string } | null;
  reason: string;
  emergency: boolean;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export interface RequestTimelineEntry {
  at: string;
  /** created / approve / reject / withdraw / invalid / expire / execute（开始）/ executed / failed / emergency */
  kind: string;
  userName: string | null;
  stage: number | null;
  comment: string | null;
}

/** 当前用户在这个申请上能做的事（按钮），以及不能做时的说明 */
export interface RequestActions {
  approve: boolean;
  reject: boolean;
  /** “通过并执行”：最后一个环节、设置了“最后一个审批人即执行者”、本人有执行权限 */
  approveAndExecute: boolean;
  /** 全部通过（或执行失败可重试）后的“执行”：有执行权限的人 */
  execute: boolean;
  withdraw: boolean;
  /** 为什么不能审批 / 执行（例如“申请人不能审批自己的申请”“你没有这个环境的执行权限”） */
  note: string | null;
}

export interface ExecRequestDetail extends ExecRequestSummary {
  migrations: RequestMigration[];
  /** 提交时预演的摘要 */
  dryRun: {
    firstRun: 'baseline' | 'empty' | null;
    createsHistory: boolean;
    resume: { versionId: string; afterStep: number } | null;
    checks: string[];
  } | null;
  /** 默认流程（没有配置审批环节）：一个环节、一人、审批人 = 有执行权限的人，通过即执行 */
  implicit: boolean;
  stages: RequestStageView[];
  timeline: RequestTimelineEntry[];
  executedBy: { id: string; name: string } | null;
  executedAt: string | null;
  result: {
    ok: boolean;
    code: string | null;
    error: string | null;
    current: RequestVersionRef | null;
  } | null;
  actions: RequestActions;
}

// ───── 收件箱（E7） ─────

/**
 * - approval_needed：待我审批（action = approve）/ 已全部通过、等有执行权限的人执行（action = execute）；
 * - request_result：我的申请有了结果（通过、驳回、失效、过期、执行成功 / 失败）；
 * - emergency_execution：有人对我审批的环境做了紧急执行；
 * - token_execution：CI 令牌执行了生产环境（P6 预留）。
 */
export const INBOX_KINDS = [
  'approval_needed',
  'request_result',
  'emergency_execution',
  'token_execution',
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export interface InboxItem {
  id: string;
  kind: InboxKind;
  createdAt: string;
  readAt: string | null;
  project: { id: string; name: string; slug: string; groupSlug: string } | null;
  environment: { id: string; name: string } | null;
  requestId: string | null;
  /** 显示用的快照（生成通知时的状态） */
  data: {
    title: string;
    body: string;
    status?: RequestStatus;
    action?: 'approve' | 'execute';
    actor?: string | null;
    /** 通知的种类（approve / execute / approved / rejected / invalid / expired / executed / failed / emergency）：界面按它用自己的语言显示 */
    event?: string;
    params?: Record<string, string | number | null>;
  };
}

export interface InboxList {
  items: InboxItem[];
  unread: number;
}

/** 等我处理的申请：当前环节我能批（approve），或已经全部通过、我有执行权限（execute） */
export interface PendingRequest extends ExecRequestSummary {
  myAction: 'approve' | 'execute';
}

/** 收件箱的实时事件（SSE）：未读数变了，或者有申请状态变了（界面据此刷新） */
export interface InboxEvent {
  unread?: number;
  requests?: true;
}
