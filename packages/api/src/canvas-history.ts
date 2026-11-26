// 画布修改历史（C4）：共享接口契约。
// 对应服务端 routes/canvas-history.ts 与前端 components/CanvasHistory.tsx。
import { z } from 'zod';

/**
 * 人类连续手工编辑的读时会话归组阈值（ADR 0015 §4，前后端共用）：
 * 同一用户、非 MCP、连续普通单步编辑，相邻两步间隔 ≤ GAP、单组总跨度 ≤ SPAN 且 ≤ MAX_STEPS 步时归为 1 组。
 */
export const CANVAS_HISTORY_GROUP_GAP_MS = 5 * 60_000;
export const CANVAS_HISTORY_GROUP_SPAN_MS = 30 * 60_000;
export const CANVAS_HISTORY_GROUP_MAX_STEPS = 50;
/** 确定性回扫兜底锚点：seq 为其整数倍处强制断开（1000 / 1001、2000 / 2001…），使最长连续段有界 */
export const CANVAS_HISTORY_RUN_ANCHOR = 1000;
/** 编辑会话组条目的 opName */
export const CANVAS_HISTORY_SESSION_OP = 'editSession';

/** 结构差异项：与 DriftItem 形状一致，复用 planDiff 输出 */
export const canvasHistoryDiffItemSchema = z.object({
  kind: z.string(),
  target: z.string(),
  sql: z.string(),
});
export type CanvasHistoryDiffItem = z.infer<typeof canvasHistoryDiffItemSchema>;

/** planDiff 结果：最多返回前 100 项，total 为完整项数 */
export const canvasHistoryDiffSchema = z.object({
  total: z.number().int().min(0),
  items: z.array(canvasHistoryDiffItemSchema),
});
export type CanvasHistoryDiff = z.infer<typeof canvasHistoryDiffSchema>;

/** 若该 seq 恰好对应某个已发布版本，附带版本引用 */
export const canvasHistoryVersionRefSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
});
export type CanvasHistoryVersionRef = z.infer<typeof canvasHistoryVersionRefSchema>;

/** 编辑会话组内的操作计数（按出现次数降序，最多 5 项） */
export const canvasHistoryOpCountSchema = z.object({
  name: z.string(),
  count: z.number().int().min(1),
});
export type CanvasHistoryOpCount = z.infer<typeof canvasHistoryOpCountSchema>;

/**
 * 时间线上的一条记录：单步修改，或同一用户连续手工编辑归成的编辑会话组（seq = 0 代表初始状态）。
 * 组的 `seq` 即组尾 seqTo（恢复目标、版本与当前标识都按它），`seqFrom` 为组首；单步时 seqFrom === seq。
 */
export const canvasHistoryEntrySchema = z.object({
  seq: z.number().int().min(0),
  /** 组首 seq；单步记录等于 seq，初始状态为 0 */
  seqFrom: z.number().int().min(0),
  /** 组内步数；单步为 1，初始状态为 0 */
  stepCount: z.number().int().min(0),
  /** 组尾时间（单步即提交时间） */
  at: z.string(),
  /** 组首时间；单步等于 at */
  startedAt: z.string(),
  /** 组尾提交者的展示名 */
  user: z.string(),
  /** 单步为操作名；多步编辑会话组为 'editSession' */
  opName: z.string(),
  /** 涉及的去重对象数（多步组按对象去重折叠） */
  changeCount: z.number().int().min(0),
  summary: z.array(z.string()),
  isCurrent: z.boolean(),
  version: canvasHistoryVersionRefSchema.nullable(),
  via: z.literal('mcp').optional(),
  mcpTokenPrefix: z.string().optional(),
  /** MCP batch 提交的意图说明（apply_changes 的 summary）；与自动生成的 summary 对象列表独立 */
  opSummary: z.string().optional(),
  /** 多步编辑会话组内的操作计数（按出现次数降序，最多 5 项）；单步记录不带 */
  ops: z.array(canvasHistoryOpCountSchema).optional(),
});
export type CanvasHistoryEntry = z.infer<typeof canvasHistoryEntrySchema>;

/** 分页历史列表响应 */
export const canvasHistoryListSchema = z.object({
  entries: z.array(canvasHistoryEntrySchema),
  currentSeq: z.number().int().min(0),
  /** 下一页的 beforeSeq 游标；已到最早记录时为 null */
  nextBeforeSeq: z.number().int().min(0).nullable(),
  /** 是否为编辑会话归组视图（`?grouped=0` 时为逐条原始单步） */
  grouped: z.boolean(),
});
export type CanvasHistoryList = z.infer<typeof canvasHistoryListSchema>;

/** 展开编辑会话组：组内逐条单步（倒序，不含 seq = 0） */
export const canvasHistoryStepsSchema = z.object({
  steps: z.array(canvasHistoryEntrySchema),
  currentSeq: z.number().int().min(0),
});
export type CanvasHistorySteps = z.infer<typeof canvasHistoryStepsSchema>;

/** 选中某次修改（或整组编辑会话）后的完整详情：本次修改（组为 seqFrom - 1 → seq 的净差异）、当时模型、与当前画布差异 */
export const canvasHistoryDetailSchema = z.object({
  entry: canvasHistoryEntrySchema,
  opDiff: canvasHistoryDiffSchema,
  model: z.unknown(),
  diffToCurrent: canvasHistoryDiffSchema,
  currentSeq: z.number().int().min(0),
});
export interface CanvasHistoryDetail<TModel = unknown> {
  entry: CanvasHistoryEntry;
  opDiff: CanvasHistoryDiff;
  model: TModel;
  diffToCurrent: CanvasHistoryDiff;
  currentSeq: number;
}

/** 恢复到此状态的请求体；必须传入查看时的 workingSeq 做乐观并发校验 */
export const canvasHistoryRestoreSchema = z
  .object({
    workingSeq: z.number().int().min(0),
  })
  .strict();
export type CanvasHistoryRestore = z.infer<typeof canvasHistoryRestoreSchema>;

/** 恢复时若工作副本已发生变化（409），返回最新 seq 与最新差异供用户重新确认 */
export const canvasHistoryConflictSchema = z.object({
  error: z.string(),
  code: z.literal('working_changed'),
  currentSeq: z.number().int().min(0),
  diffToCurrent: canvasHistoryDiffSchema,
});
export type CanvasHistoryConflict = z.infer<typeof canvasHistoryConflictSchema>;
