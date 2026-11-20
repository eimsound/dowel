// 组级 Webhook（P5b，E8）的接口契约：请求体 schema、事件类型、响应形状。服务端 apps/server/src/webhooks.ts 实现投递。
import { z } from 'zod';

/** 预设格式：通用 JSON（HMAC 签名头）、钉钉、飞书、企业微信、Slack */
export const webhookFormatSchema = z.enum(['json', 'dingtalk', 'feishu', 'wecom', 'slack']);
export type WebhookFormat = z.infer<typeof webhookFormatSchema>;

/**
 * 可订阅的事件。消息里只有项目 / 环境 / 版本 / 人名 / 状态和原因这类信息，不含连接串、密码等（发送前还会统一脱敏）。
 * - request.created：提交了执行申请；
 * - request.approved：申请的所有环节都通过了（等待执行）；
 * - request.rejected：申请被驳回；
 * - request.withdrawn：申请人撤回；
 * - request.invalidated：申请失效（环境状态变了、审批流程变严……）或过期；
 * - request.executed：申请执行结束（成功或失败，data.ok）；
 * - execution.finished：不经申请的直接执行 / 回滚结束（成功或失败）；
 * - emergency.executed：实例管理员的紧急执行（绕过审批）结束；
 * - token.executed：CI 令牌的执行结束（成功或失败，data.ok；P6）。令牌执行不经审批，单独一个事件方便只订阅它。
 */
export const WEBHOOK_EVENTS = [
  'request.created',
  'request.approved',
  'request.rejected',
  'request.withdrawn',
  'request.invalidated',
  'request.executed',
  'execution.finished',
  'emergency.executed',
  'token.executed',
] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEventType = z.infer<typeof webhookEventSchema>;

const webhookUrl = z
  .string()
  .trim()
  .min(1, '请填写 URL')
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'URL 必须以 http:// 或 https:// 开头');

export const webhookCreateSchema = z
  .object({
    name: z.string().trim().min(1, '请填写名称').max(100),
    format: webhookFormatSchema,
    url: webhookUrl,
    /** 签名密钥（通用 JSON 的 HMAC、钉钉 / 飞书的加签）；企业微信 / Slack 不签名（密钥就在 URL 里） */
    secret: z.string().max(500).nullable().optional(),
    events: z.array(webhookEventSchema).min(1, '至少订阅一个事件').max(WEBHOOK_EVENTS.length),
    enabled: z.boolean().default(true),
  })
  .strict();
export type WebhookCreate = z.infer<typeof webhookCreateSchema>;

/** 修改：不给的字段不变；url 不给就保留原来的（界面不回显）；secret：字符串 = 换成新的，null = 清除，不给 = 不变 */
export const webhookPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    format: webhookFormatSchema.optional(),
    url: webhookUrl.optional(),
    secret: z.string().max(500).nullable().optional(),
    events: z.array(webhookEventSchema).min(1).max(WEBHOOK_EVENTS.length).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type WebhookPatch = z.infer<typeof webhookPatchSchema>;

/** 一次投递尝试的结果（最近若干次保存在平台库里） */
export interface WebhookDelivery {
  id: string;
  /** 同一个事件的多次重试共用一个 deliveryId */
  deliveryId: string;
  event: WebhookEventType | 'test';
  /** 第几次尝试（1 起） */
  attempt: number;
  ok: boolean;
  /** HTTP 状态码；没有收到响应（连不上、超时、被出站限制拒绝）为 null */
  status: number | null;
  /** 失败原因（已脱敏） */
  error: string | null;
  durationMs: number | null;
  test: boolean;
  at: string;
}

export interface WebhookInfo {
  id: string;
  name: string;
  format: WebhookFormat;
  /** 遮掉了路径和查询参数的 URL（只留协议和主机）：URL 里常常带着令牌，界面不回显 */
  urlMasked: string;
  /** 设置了签名密钥（密钥本身从不返回） */
  hasSecret: boolean;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 最近一次投递 */
  lastDelivery: WebhookDelivery | null;
}

/**
 * 服务端内部投递的事件（apps/server 构造，webhooks.ts 按格式渲染）。title / lines 已经是给人看的中文；
 * data 是结构化信息（通用 JSON 格式原样带上）。
 */
export interface WebhookEventInput {
  type: WebhookEventType;
  title: string;
  /** 正文：每行一段（Markdown 子集：**粗体**、`代码`）；各预设格式自己拼接 */
  lines: string[];
  /** 详情页的绝对链接（设置了 DOWEL_PUBLIC_URL 时）；否则 null */
  url: string | null;
  data: Record<string, unknown>;
}
