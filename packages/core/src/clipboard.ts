// 画布复制粘贴（ADR 0013 第 2 节）：剪贴板载荷、复制提取与粘贴计划编译。纯函数、无 I/O，前后端共用。
// 粘贴计划编译成一组普通 mutator 调用，经单个原子 mutator `paste` 提交（见 mutators.ts），
// 因此沿用全部方言校验、乐观冲突、只读拒绝与画布历史（一次粘贴 = 一条历史记录）。
import { z } from 'zod';

import { Dialect, type Model, Obj } from './ir.ts';

export const CLIPBOARD_FORMAT = 'dowel/clipboard';
export const CLIPBOARD_VERSION = 1;
/** 序列化后的载荷上限（localStorage 镜像与 WS 单条消息都要装得下） */
export const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
/** 单次粘贴最多展开的子操作数（防止单条 WS 消息与服务端重放过大） */
export const MAX_PASTE_OPS = 20_000;

const id = z.string().min(1).max(64);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });

export const ClipboardSource = z.object({
  /** 复制来源项目（跨项目粘贴时用于板块提示；历史快照同样填当前项目） */
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  origin: z.enum(['canvas', 'history']),
  /** 来自画布历史时的 seq */
  seq: z.number().int().min(0).nullable(),
});
export type ClipboardSource = z.infer<typeof ClipboardSource>;

/**
 * 剪贴板载荷（版本 1）。fragment 是来源模型的一个子集（扁平对象表，按 ID 索引）：
 * - kind = 'tables'：tables 列出复制的顶层表（分区子表随根表一起带上），fragment 含这些表及其全部子对象、
 *   所在 schema、被列引用的枚举 / 序列，以及 external 列出的“外部被引用表”存根（只含被外键引用的列与其主键 / 唯一约束 / 唯一索引）。
 * - kind = 'items'：table 是来源表，items 是要粘贴的列 / 约束 / 索引 ID；fragment 含来源表的全部列（按列名映射用）
 *   与 items 本身，以及它们引用的枚举 / 序列 / 外部表存根。
 * layout / sections 只是布局层提示，绝不进入 IR。
 */
export const ClipboardPayload = z.object({
  format: z.literal(CLIPBOARD_FORMAT),
  v: z.literal(CLIPBOARD_VERSION),
  dialect: Dialect,
  kind: z.enum(['tables', 'items']),
  source: ClipboardSource,
  copiedAt: z.string(),
  fragment: z.record(z.string(), Obj),
  tables: z.array(id).default([]),
  table: id.nullable().default(null),
  items: z.array(id).default([]),
  external: z.array(id).default([]),
  layout: z.record(z.string(), point).default({}),
  sections: z.record(z.string(), z.string()).default({}),
  /** 复制时没有带上的不透明对象（视图、触发器等）个数，粘贴时提示 */
  skippedOpaque: z.number().int().min(0).default(0),
});
export type ClipboardPayload = z.infer<typeof ClipboardPayload>;

export type ClipboardErrorCode = 'unsupported_version' | 'invalid_payload' | 'too_large' | 'empty';
export class ClipboardError extends Error {
  readonly code: ClipboardErrorCode;
  constructor(code: ClipboardErrorCode, message = code) {
    super(message);
    this.code = code;
  }
}

export type PasteErrorCode =
  | 'dialect_mismatch'
  | 'no_target'
  | 'target_not_table'
  | 'target_is_partition'
  | 'nothing_to_paste'
  | 'too_many_ops';
export class PasteError extends Error {
  readonly code: PasteErrorCode;
  readonly params: Record<string, string | number>;
  constructor(code: PasteErrorCode, params: Record<string, string | number> = {}, message = code) {
    super(message);
    this.code = code;
    this.params = params;
  }
}

export type PasteObjectKind =
  | 'table'
  | 'column'
  | 'primaryKey'
  | 'unique'
  | 'check'
  | 'foreignKey'
  | 'index'
  | 'enum'
  | 'sequence';

export type PasteSkipReason =
  /** 外键引用的表在目标模型里找不到（按 schema 名 + 表名） */
  | 'missingRefTable'
  /** 外键引用的列在目标表里找不到 */
  | 'missingRefColumns'
  /** 目标被引用列没有主键 / 唯一约束 / 唯一索引支撑 */
  | 'refNotUnique'
  /** 目标被引用列类型与来源不一致 */
  | 'refTypeMismatch'
  /** 表内粘贴：约束 / 索引用到的列在目标表里找不到 */
  | 'missingColumns'
  /** 表内粘贴：目标表已有主键 */
  | 'targetHasPrimaryKey'
  /** 表内粘贴：目标表上已有完全相同定义的约束 / 索引 */
  | 'duplicate'
  /** 表达式引用了目标表不存在的列 */
  | 'invalidExpr'
  /** 方言能力或其他校验不允许（detail 给出原因） */
  | 'unsupported';

export interface PasteRename {
  kind: PasteObjectKind;
  /** 所在表的新名字（列 / 约束 / 索引时） */
  table: string | null;
  from: string;
  to: string;
}

export interface PasteSkip {
  kind: PasteObjectKind;
  /** 来源对象名 */
  name: string;
  /** 所在表名（来源表名；表内粘贴时为目标表名） */
  table: string | null;
  reason: PasteSkipReason;
  /** 附加信息：缺失的表 / 列名、类型等，原样显示 */
  detail: string | null;
}

export type PasteNote =
  /** 来源 schema 在目标模型不存在，表放进了 to */
  | { code: 'schemaFallback'; from: string; to: string; tables: number }
  /** 复用了目标模型里的同名枚举 / 序列；valuesDiffer 表示枚举值不同 */
  | { code: 'reusedType'; kind: 'enum' | 'sequence'; name: string; valuesDiffer: boolean }
  /** 在目标模型新建了枚举 / 序列 */
  | { code: 'createdType'; kind: 'enum' | 'sequence'; name: string }
  /** 视图、触发器等不透明对象不复制 */
  | { code: 'opaqueSkipped'; count: number }
  /** 分区子表上的额外约束 / 索引没有复制 */
  | { code: 'partitionObjectsSkipped'; count: number }
  /** 序列默认值找不到对应序列，已清空默认值 */
  | { code: 'defaultCleared'; table: string; column: string };

export interface PasteReport {
  renamed: PasteRename[];
  skipped: PasteSkip[];
  notes: PasteNote[];
}

export interface PasteOp {
  name: string;
  args: unknown;
}

export interface PastePlan {
  /** 依次执行的普通 mutator 调用，作为 `paste` mutator 的参数提交 */
  ops: PasteOp[];
  /** 来源表 ID → 新表 ID（kind = 'tables'，只含顶层表与分区子表） */
  tableMap: Record<string, string>;
  /** 新建的顶层表 ID（按来源顺序；用于布局与选中） */
  newTables: string[];
  /** 表内粘贴新建的列 / 约束 / 索引 ID */
  newItems: string[];
  /** 目标表（kind = 'items'） */
  targetTable: string | null;
  report: PasteReport;
}

export interface CopyOptions {
  source: ClipboardSource;
  /** 来源画布布局（只取复制的表） */
  layout?: Record<string, { x: number; y: number }>;
  /** 表 ID → 板块 ID（只取复制的表） */
  sections?: Record<string, string>;
  /** 测试注入时间 */
  now?: () => Date;
}

export interface PasteOptions {
  /** kind = 'items' 时粘贴进的目标表 */
  targetTable?: string | null;
  /** 测试注入 ID 生成器；默认 newId()（UUIDv7） */
  newId?: () => string;
}

/** 复制一张或多张表（分区子表归并到根表），生成剪贴板载荷 */
export const copyTables = (_m: Model, _tableIds: string[], _opts: CopyOptions): ClipboardPayload => {
  throw new Error('not implemented');
};

/** 复制一张表上的若干列 / 约束 / 索引，生成剪贴板载荷 */
export const copyItems = (
  _m: Model,
  _tableId: string,
  _itemIds: string[],
  _opts: CopyOptions,
): ClipboardPayload => {
  throw new Error('not implemented');
};

/** 序列化载荷；超过 MAX_CLIPBOARD_BYTES 抛 ClipboardError('too_large') */
export const serializeClipboard = (_p: ClipboardPayload): string => {
  throw new Error('not implemented');
};

/**
 * 解析剪贴板文本：不是 Dowel 载荷（非 JSON、format 不符）返回 null；
 * format 相符但版本不认识抛 ClipboardError('unsupported_version')，结构不合法抛 ClipboardError('invalid_payload')。
 */
export const parseClipboard = (_text: string): ClipboardPayload | null => {
  throw new Error('not implemented');
};

/** 把载荷编译成在 target 上执行的粘贴计划；方言不同抛 PasteError('dialect_mismatch') */
export const planPaste = (
  _target: Model,
  _payload: ClipboardPayload,
  _opts: PasteOptions = {},
): PastePlan => {
  throw new Error('not implemented');
};
