// 画布修改历史（C4）：共享接口契约。
// 对应服务端 routes/canvas-history.ts 与前端 components/CanvasHistory.tsx。
import { z } from 'zod';

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

/** 时间线上的单条修改记录（seq = 0 代表初始状态） */
export const canvasHistoryEntrySchema = z.object({
  seq: z.number().int().min(0),
  at: z.string(),
  user: z.string(),
  opName: z.string(),
  changeCount: z.number().int().min(0),
  summary: z.array(z.string()),
  isCurrent: z.boolean(),
  version: canvasHistoryVersionRefSchema.nullable(),
  via: z.literal('mcp').optional(),
  mcpTokenPrefix: z.string().optional(),
  /** MCP batch 提交的意图说明（apply_changes 的 summary）；与自动生成的 summary 对象列表独立 */
  opSummary: z.string().optional(),
});
export type CanvasHistoryEntry = z.infer<typeof canvasHistoryEntrySchema>;

/** 分页历史列表响应 */
export const canvasHistoryListSchema = z.object({
  entries: z.array(canvasHistoryEntrySchema),
  currentSeq: z.number().int().min(0),
  /** 下一页的 beforeSeq 游标；已到最早记录时为 null */
  nextBeforeSeq: z.number().int().min(0).nullable(),
});
export type CanvasHistoryList = z.infer<typeof canvasHistoryListSchema>;

/** 选中某次修改后的完整详情：单次修改、当时模型、与当前画布差异 */
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
