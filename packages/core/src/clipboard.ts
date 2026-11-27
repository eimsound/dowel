// 画布复制粘贴（ADR 0013 第 2 节）：剪贴板载荷、复制提取与粘贴计划编译。纯函数、无 I/O，前后端共用。
// 粘贴计划编译成一组普通 mutator 调用，经单个原子 mutator `paste` 提交（见 mutators.ts），
// 因此沿用全部方言校验、乐观冲突、只读拒绝与画布历史（一次粘贴 = 一条历史记录）。
// 方言差异（命名空间、推导名、类型 / 自增 / 聚集索引兼容性、分区等）一律经 DialectSpec.clipboard 适配器（clipboard-dialect.ts）。
import { z } from 'zod';

import {
  type ClipboardDialect,
  type ClipboardNamespace,
  type DeferredExt,
  type DerivedNameInput,
  type QualifiedTypeRename,
  utf8ByteLen,
} from './clipboard-dialect.ts';
import type { DialectSpec } from './dialect.ts';
import { newId } from './ids.ts';
import {
  Check,
  Column,
  type ColumnDefault,
  type ColumnExt,
  Dialect,
  Enum,
  Extension,
  ForeignKey,
  Index,
  type IndexElement,
  isValidIndexElement,
  type Model,
  type Obj,
  Opaque,
  type PartitionKey,
  type PartitionSpec,
  PrimaryKey,
  Schema,
  Sequence,
  Table,
  Unique,
} from './ir.ts';
import { clonePlain, deepEqual } from './json.ts';
import {
  childrenOf,
  columnsOf,
  effectiveColumnsOf,
  type ModelIndex,
  partitionAncestors,
  rootTableId,
  withModelIndex,
} from './model.ts';
import { runMutator } from './mutators.ts';
import { getDialect } from './registry.ts';

export const CLIPBOARD_FORMAT = 'dowel/clipboard';
export const CLIPBOARD_VERSION = 1;
/** 序列化后的载荷上限（localStorage 镜像与 WS 单条消息都要装得下） */
export const MAX_CLIPBOARD_BYTES = 4 * 1024 * 1024;
/** 单次粘贴最多展开的子操作数（防止单条 WS 消息与服务端重放过大） */
export const MAX_PASTE_OPS = 20_000;

const id = z.string().min(1).max(64);
const point = z.object({ x: z.number().finite(), y: z.number().finite() });

/** PG 非数组枚举列的 type 为空串、仅靠 typeRef 指向枚举，剪贴板校验需放行该情况 */
const ClipboardColumn = Column.extend({ type: z.string() });
const ClipboardObj = z.discriminatedUnion('kind', [
  Extension,
  Opaque,
  Schema,
  Enum,
  Sequence,
  Table,
  ClipboardColumn,
  PrimaryKey,
  Unique,
  ForeignKey,
  Check,
  Index,
]);

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
  fragment: z.record(z.string(), ClipboardObj),
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

// ───── 通用工具与标识符/表达式辅助 ─────

const normIdent = (cb: ClipboardDialect, name: string): string =>
  cb.caseInsensitiveIdents ? name.toLowerCase() : name;

/**
 * 单趟改写表达式里的多个列名引用（避免 a→a_copy 与 a_copy→a_copy2 发生级联替换）。
 * 跳过字符串字面量、注释、函数名与 CAST/:: 类型名（复用方言自己的 columnRefs 分词）。
 */
export const renameManyInExpr = (
  dialect: Dialect,
  expr: string,
  renames: ReadonlyMap<string, string>,
): string => {
  if (renames.size === 0) return expr;
  const d = getDialect(dialect);
  const ci = d.clipboard.caseInsensitiveIdents;
  const lookup = new Map<string, string>();
  for (const [from, to] of renames) {
    const key = ci ? from.toLowerCase() : from;
    if (from !== to) lookup.set(key, to);
  }
  if (lookup.size === 0) return expr;
  let out = expr;
  for (const tok of d.columnRefs(expr).reverse()) {
    const key = ci ? tok.text.toLowerCase() : tok.text;
    const to = lookup.get(key);
    if (to !== undefined) {
      out = out.slice(0, tok.start) + d.quoteIdent(to) + out.slice(tok.end);
    }
  }
  return out;
};

/** 单趟改写表达式里的限定类型名 `schema.enum`（方言不支持限定类型引用时原样返回） */
const renameQualifiedManyInExpr = (
  cb: ClipboardDialect,
  expr: string,
  renames: readonly QualifiedTypeRename[],
): string => {
  if (renames.length === 0 || !cb.rewriteQualifiedTypeRefs) return expr;
  return cb.rewriteQualifiedTypeRefs(expr, renames);
};

const findUnknownExprColumns = (
  d: DialectSpec,
  expr: string,
  allowedNormNames: ReadonlySet<string>,
): string[] => {
  const ci = d.clipboard.caseInsensitiveIdents;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of d.columnRefs(expr)) {
    const k = ci ? t.text.toLowerCase() : t.text;
    if (!allowedNormNames.has(k) && !(t.kind === 'ident' && d.keywords.has(t.text.toLowerCase()))) {
      if (!seen.has(t.text)) {
        seen.add(t.text);
        out.push(t.text);
      }
    }
  }
  return out;
};

// ───── 复制提取 ─────

const putClone = (fragment: Record<string, Obj>, obj: Obj | undefined) => {
  if (!obj || obj.id in fragment) return;
  fragment[obj.id] = clonePlain(obj);
};

const ensureSchemaInFragment = (m: Model, fragment: Record<string, Obj>, schemaId: string) => {
  const s = m.objects[schemaId];
  if (s?.kind === 'schema') putClone(fragment, s);
};

const collectExternalStubs = (
  m: Model,
  idx: ModelIndex,
  fragment: Record<string, Obj>,
  externalRefs: Map<string, Set<string>>,
): string[] => {
  const external: string[] = [];
  for (const [refTableId, refColSet] of externalRefs) {
    const refTbl = m.objects[refTableId];
    if (refTbl?.kind !== 'table') continue;
    putClone(fragment, refTbl);
    ensureSchemaInFragment(m, fragment, refTbl.parent);
    external.push(refTableId);

    for (const colId of refColSet) {
      const col = m.objects[colId];
      if (col?.kind !== 'column') continue;
      putClone(fragment, col);
      if (col.typeRef) {
        const en = m.objects[col.typeRef];
        if (en?.kind === 'enum') {
          putClone(fragment, en);
          ensureSchemaInFragment(m, fragment, en.parent);
        }
      }
    }

    for (const pk of idx.childrenRef(refTableId, 'primaryKey')) {
      if (pk.columns.every((c) => refColSet.has(c))) putClone(fragment, pk);
    }
    for (const u of idx.childrenRef(refTableId, 'unique')) {
      if (u.columns.every((c) => refColSet.has(c))) putClone(fragment, u);
    }
    for (const ix of idx.childrenRef(refTableId, 'index')) {
      if (
        ix.unique &&
        !ix.where &&
        ix.elements.every((e) => e.column !== null && refColSet.has(e.column)) &&
        ix.include.every((c) => refColSet.has(c))
      ) {
        putClone(fragment, ix);
      }
    }
  }
  return external;
};

/** 复制一张或多张表（分区子表归并到根表），生成剪贴板载荷 */
export const copyTables = (m: Model, tableIds: string[], opts: CopyOptions): ClipboardPayload => {
  const seenRoots = new Set<string>();
  const rootIds: string[] = [];
  for (const rawId of tableIds) {
    const o = m.objects[rawId];
    if (o?.kind !== 'table') continue;
    const rid = rootTableId(m, o.id);
    const rootObj = m.objects[rid];
    if (rootObj?.kind !== 'table' || seenRoots.has(rid)) continue;
    seenRoots.add(rid);
    rootIds.push(rid);
  }
  if (rootIds.length === 0) {
    throw new ClipboardError('empty');
  }

  return withModelIndex(m, (idx) => {
    const copiedTableIds = new Set<string>();
    const orderedTableIds: string[] = [];
    for (const rid of rootIds) {
      if (!copiedTableIds.has(rid)) {
        copiedTableIds.add(rid);
        orderedTableIds.push(rid);
      }
      for (const desc of idx.partitionDescendants(rid)) {
        if (!copiedTableIds.has(desc.id)) {
          copiedTableIds.add(desc.id);
          orderedTableIds.push(desc.id);
        }
      }
    }

    const fragment: Record<string, Obj> = {};
    const copiedColIds = new Set<string>();
    const referencedEnumIds = new Set<string>();
    const referencedSeqIds = new Set<string>();
    const externalRefs = new Map<string, Set<string>>();

    for (const tid of orderedTableIds) {
      const t = m.objects[tid];
      if (t?.kind !== 'table') continue;
      putClone(fragment, t);
      ensureSchemaInFragment(m, fragment, t.parent);

      for (const ch of idx.allChildrenOf(tid)) {
        if (ch.kind === 'opaque') continue;
        putClone(fragment, ch);
        if (ch.kind === 'column') {
          copiedColIds.add(ch.id);
          if (ch.typeRef) referencedEnumIds.add(ch.typeRef);
          if (ch.default && 'nextval' in ch.default) referencedSeqIds.add(ch.default.nextval);
        } else if (ch.kind === 'foreignKey' && !copiedTableIds.has(ch.refTable)) {
          let set = externalRefs.get(ch.refTable);
          if (!set) {
            set = new Set();
            externalRefs.set(ch.refTable, set);
          }
          for (const rc of ch.refColumns) set.add(rc);
        }
      }
    }

    for (const eid of referencedEnumIds) {
      const en = m.objects[eid];
      if (en?.kind === 'enum') {
        putClone(fragment, en);
        ensureSchemaInFragment(m, fragment, en.parent);
      }
    }
    for (const sid of referencedSeqIds) {
      const seq = m.objects[sid];
      if (seq?.kind === 'sequence') {
        putClone(fragment, seq);
        ensureSchemaInFragment(m, fragment, seq.parent);
      }
    }

    const external = collectExternalStubs(m, idx, fragment, externalRefs);

    let skippedOpaque = 0;
    for (const opq of idx.allRef('opaque')) {
      if (
        copiedTableIds.has(opq.parent) ||
        opq.deps.some((d) => copiedTableIds.has(d) || copiedColIds.has(d))
      ) {
        skippedOpaque++;
      }
    }

    const layout: Record<string, { x: number; y: number }> = {};
    if (opts.layout) {
      for (const rid of rootIds) {
        const pt = opts.layout[rid];
        if (pt) layout[rid] = clonePlain(pt);
      }
    }
    const sections: Record<string, string> = {};
    if (opts.sections) {
      for (const rid of rootIds) {
        const sec = opts.sections[rid];
        if (sec !== undefined) sections[rid] = sec;
      }
    }

    return {
      format: CLIPBOARD_FORMAT,
      v: CLIPBOARD_VERSION,
      dialect: m.dialect,
      kind: 'tables',
      source: clonePlain(opts.source),
      copiedAt: (opts.now?.() ?? new Date()).toISOString(),
      fragment,
      tables: rootIds,
      table: null,
      items: [],
      external,
      layout,
      sections,
      skippedOpaque,
    };
  });
};

const ITEM_ORDER_RANK: Record<string, number> = {
  column: 0,
  primaryKey: 1,
  unique: 2,
  check: 3,
  index: 4,
  foreignKey: 5,
};

/** 复制一张表上的若干列 / 约束 / 索引，生成剪贴板载荷 */
export const copyItems = (
  m: Model,
  tableId: string,
  itemIds: string[],
  opts: CopyOptions,
): ClipboardPayload => {
  const tbl = m.objects[tableId];
  if (tbl?.kind !== 'table') {
    throw new ClipboardError('invalid_payload');
  }

  return withModelIndex(m, (idx) => {
    const rootId = rootTableId(m, tableId);
    const seen = new Set<string>();
    const selected: Obj[] = [];

    for (const iid of itemIds) {
      if (seen.has(iid)) continue;
      const o = m.objects[iid];
      if (!o) continue;
      const isValidCol = o.kind === 'column' && (o.parent === tableId || o.parent === rootId);
      const isValidSub =
        (o.kind === 'primaryKey' ||
          o.kind === 'unique' ||
          o.kind === 'check' ||
          o.kind === 'index' ||
          o.kind === 'foreignKey') &&
        o.parent === tableId;
      if (!isValidCol && !isValidSub) continue;
      seen.add(iid);
      selected.push(o);
    }

    if (selected.length === 0) {
      throw new ClipboardError('empty');
    }

    const inputOrder = new Map<string, number>(selected.map((o, i) => [o.id, i]));
    selected.sort((a, b) => {
      const ra = ITEM_ORDER_RANK[a.kind]!;
      const rb = ITEM_ORDER_RANK[b.kind]!;
      if (ra !== rb) return ra - rb;
      if (a.kind === 'column' && b.kind === 'column') {
        if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
      return inputOrder.get(a.id)! - inputOrder.get(b.id)!;
    });

    const fragment: Record<string, Obj> = {};
    // 若来源为分区子表，补齐沿 partitionOf 到根表的链及其 schema
    let curId: string | null = tableId;
    const chainSeen = new Set<string>();
    while (curId && !chainSeen.has(curId)) {
      chainSeen.add(curId);
      const t: Obj | undefined = m.objects[curId];
      if (t?.kind !== 'table') break;
      putClone(fragment, t);
      ensureSchemaInFragment(m, fragment, t.parent);
      curId = t.partitionOf?.parent ?? null;
    }

    // 放入来源表全部有效列，供粘贴时按列名映射
    for (const c of effectiveColumnsOf(m, tableId)) {
      putClone(fragment, c);
    }

    const referencedEnumIds = new Set<string>();
    const referencedSeqIds = new Set<string>();
    const externalRefs = new Map<string, Set<string>>();

    for (const o of selected) {
      putClone(fragment, o);
      if (o.kind === 'column') {
        if (o.typeRef) referencedEnumIds.add(o.typeRef);
        if (o.default && 'nextval' in o.default) referencedSeqIds.add(o.default.nextval);
      } else if (o.kind === 'foreignKey' && o.refTable !== tableId && o.refTable !== rootId) {
        let set = externalRefs.get(o.refTable);
        if (!set) {
          set = new Set();
          externalRefs.set(o.refTable, set);
        }
        for (const rc of o.refColumns) set.add(rc);
      }
    }

    for (const eid of referencedEnumIds) {
      const en = m.objects[eid];
      if (en?.kind === 'enum') {
        putClone(fragment, en);
        ensureSchemaInFragment(m, fragment, en.parent);
      }
    }
    for (const sid of referencedSeqIds) {
      const seq = m.objects[sid];
      if (seq?.kind === 'sequence') {
        putClone(fragment, seq);
        ensureSchemaInFragment(m, fragment, seq.parent);
      }
    }

    const external = collectExternalStubs(m, idx, fragment, externalRefs);

    return {
      format: CLIPBOARD_FORMAT,
      v: CLIPBOARD_VERSION,
      dialect: m.dialect,
      kind: 'items',
      source: clonePlain(opts.source),
      copiedAt: (opts.now?.() ?? new Date()).toISOString(),
      fragment,
      tables: [],
      table: tableId,
      items: selected.map((o) => o.id),
      external,
      layout: {},
      sections: {},
      skippedOpaque: 0,
    };
  });
};

// ───── 序列化与反序列化 ─────

/** 序列化载荷；超过 MAX_CLIPBOARD_BYTES 抛 ClipboardError('too_large') */
export const serializeClipboard = (p: ClipboardPayload): string => {
  const json = JSON.stringify(p);
  if (utf8ByteLen(json) > MAX_CLIPBOARD_BYTES) {
    throw new ClipboardError('too_large');
  }
  return json;
};

const VALID_ITEM_KINDS: ReadonlySet<string> = new Set([
  'column',
  'primaryKey',
  'unique',
  'check',
  'foreignKey',
  'index',
]);

/**
 * 解析剪贴板文本：不是 Dowel 载荷（非 JSON、format 不符）返回 null；
 * 超过 MAX_CLIPBOARD_BYTES 在 JSON.parse 前抛 ClipboardError('too_large')；
 * format 相符但版本不认识抛 ClipboardError('unsupported_version')，结构或内部引用不合法抛 ClipboardError('invalid_payload')。
 */
export const parseClipboard = (text: string): ClipboardPayload | null => {
  if (typeof text !== 'string') return null;
  if (
    text.length > MAX_CLIPBOARD_BYTES ||
    (text.length * 3 > MAX_CLIPBOARD_BYTES && utf8ByteLen(text) > MAX_CLIPBOARD_BYTES)
  ) {
    throw new ClipboardError('too_large');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.format !== CLIPBOARD_FORMAT) return null;
  if (obj.v !== CLIPBOARD_VERSION) {
    throw new ClipboardError('unsupported_version');
  }

  const parsed = ClipboardPayload.safeParse(raw);
  if (!parsed.success) {
    throw new ClipboardError('invalid_payload');
  }

  const data = parsed.data;
  const frag = data.fragment;

  for (const [k, item] of Object.entries(frag)) {
    if (item.id !== k) {
      throw new ClipboardError('invalid_payload');
    }
    if (item.kind === 'column' && item.type.length === 0 && item.typeRef === null) {
      throw new ClipboardError('invalid_payload');
    }
  }

  const fragRootOf = (tableId: string): string => {
    let cur = tableId;
    const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const curObj = frag[cur];
      if (!curObj || curObj.kind !== 'table' || !curObj.partitionOf) break;
      const parentObj = frag[curObj.partitionOf.parent];
      if (!parentObj || parentObj.kind !== 'table') break;
      cur = parentObj.id;
    }
    return cur;
  };

  const hasColumnOfTable = (tableId: string, colId: string): boolean => {
    const col = frag[colId];
    if (!col || col.kind !== 'column') return false;
    return col.parent === tableId || col.parent === fragRootOf(tableId);
  };

  const copiedTables = new Set<string>();
  if (data.kind === 'tables') {
    if (data.table !== null || data.items.length > 0) {
      throw new ClipboardError('invalid_payload');
    }
    for (const tid of data.tables) {
      if (copiedTables.has(tid)) {
        throw new ClipboardError('invalid_payload');
      }
      const t = frag[tid];
      if (!t || t.kind !== 'table') {
        throw new ClipboardError('invalid_payload');
      }
      copiedTables.add(tid);
    }
    // 补充纳入被复制表的分区子表，以便校验内部外键与列归属
    for (const item of Object.values(frag)) {
      if (item.kind === 'table' && item.partitionOf && copiedTables.has(fragRootOf(item.id))) {
        copiedTables.add(item.id);
      }
    }
  } else {
    if (!data.table) {
      throw new ClipboardError('invalid_payload');
    }
    const tbl = frag[data.table];
    if (!tbl || tbl.kind !== 'table') {
      throw new ClipboardError('invalid_payload');
    }
    const srcRoot = fragRootOf(data.table);
    const seenItems = new Set<string>();
    for (const iid of data.items) {
      if (seenItems.has(iid)) {
        throw new ClipboardError('invalid_payload');
      }
      seenItems.add(iid);
      const it = frag[iid];
      if (!it || !VALID_ITEM_KINDS.has(it.kind)) {
        throw new ClipboardError('invalid_payload');
      }
      if (it.kind === 'column') {
        if (it.parent !== data.table && it.parent !== srcRoot) {
          throw new ClipboardError('invalid_payload');
        }
      } else if ('parent' in it && it.parent !== data.table) {
        throw new ClipboardError('invalid_payload');
      }
    }
  }

  const seenExternal = new Set<string>();
  for (const eid of data.external) {
    if (seenExternal.has(eid)) {
      throw new ClipboardError('invalid_payload');
    }
    seenExternal.add(eid);
    const extTbl = frag[eid];
    if (!extTbl || extTbl.kind !== 'table') {
      throw new ClipboardError('invalid_payload');
    }
  }

  // 校验 fragment 内部列与父表引用完整性，防止篡改载荷生成缺列索引/约束导致非法模型
  for (const item of Object.values(frag)) {
    switch (item.kind) {
      case 'column': {
        const parentTbl = frag[item.parent];
        if (!parentTbl || parentTbl.kind !== 'table') {
          throw new ClipboardError('invalid_payload');
        }
        break;
      }
      case 'table': {
        if (copiedTables.has(item.id) && item.partitionBy !== null && typeof item.partitionBy === 'object') {
          for (const k of item.partitionBy.keys) {
            if (k.column !== null && !hasColumnOfTable(item.id, k.column)) {
              throw new ClipboardError('invalid_payload');
            }
          }
        }
        break;
      }
      case 'primaryKey':
      case 'unique': {
        const parentTbl = frag[item.parent];
        if (!parentTbl || parentTbl.kind !== 'table') {
          throw new ClipboardError('invalid_payload');
        }
        for (const cid of item.columns) {
          if (!hasColumnOfTable(item.parent, cid)) {
            throw new ClipboardError('invalid_payload');
          }
        }
        break;
      }
      case 'check': {
        const parentTbl = frag[item.parent];
        if (!parentTbl || parentTbl.kind !== 'table') {
          throw new ClipboardError('invalid_payload');
        }
        break;
      }
      case 'index': {
        const parentTbl = frag[item.parent];
        if (!parentTbl || parentTbl.kind !== 'table') {
          throw new ClipboardError('invalid_payload');
        }
        for (const el of item.elements) {
          if (!isValidIndexElement(el)) {
            throw new ClipboardError('invalid_payload');
          }
          if (el.column !== null && !hasColumnOfTable(item.parent, el.column)) {
            throw new ClipboardError('invalid_payload');
          }
        }
        for (const cid of item.include) {
          if (!hasColumnOfTable(item.parent, cid)) {
            throw new ClipboardError('invalid_payload');
          }
        }
        break;
      }
      case 'foreignKey': {
        const parentTbl = frag[item.parent];
        if (!parentTbl || parentTbl.kind !== 'table') {
          throw new ClipboardError('invalid_payload');
        }
        if (item.columns.length !== item.refColumns.length) {
          throw new ClipboardError('invalid_payload');
        }
        for (const cid of item.columns) {
          if (!hasColumnOfTable(item.parent, cid)) {
            throw new ClipboardError('invalid_payload');
          }
        }
        if (copiedTables.has(item.refTable)) {
          for (const rc of item.refColumns) {
            if (!hasColumnOfTable(item.refTable, rc)) {
              throw new ClipboardError('invalid_payload');
            }
          }
        }
        break;
      }
    }
  }

  return data;
};

// ───── 推导名预占 ─────

/** 未显式命名的约束 / 索引：按方言推导名规则预占到命名空间（用于表粒度批量规划） */
const reserveDerivedKeyOrIndex = (
  ctx: PasteContext,
  schemaId: string,
  tableId: string,
  tableName: string,
  obj: DerivedNameInput['obj'],
  newColNameById: ReadonlyMap<string, string>,
  exprColNames: readonly string[],
) => {
  const colNames = (ids: readonly string[]) => ids.map((cid) => newColNameById.get(cid) ?? '');
  const indexElementNames = (ix: Pick<Index, 'elements' | 'include'>): string[] => {
    const raw = [
      ...ix.elements.map((e) => {
        if (e.column) return newColNameById.get(e.column) ?? '';
        const fn = /^\s*(?:[a-z_][a-z0-9_$]*\.)?([a-z_][a-z0-9_$]*)\s*\(/i.exec(e.expr ?? '');
        return fn ? fn[1]!.toLowerCase() : 'expr';
      }),
      ...ix.include.map((cid) => newColNameById.get(cid) ?? ''),
    ];
    const out: string[] = [];
    for (const n of raw) {
      let cur = n;
      for (let i = 1; out.includes(cur); i++) cur = `${n}${i}`;
      out.push(cur);
    }
    return out;
  };
  const singleCheckRef = (expr: string): string | null => {
    const refs = exprColNames.filter((cname) => ctx.d.exprReferences(expr, cname));
    return refs.length === 1 ? refs[0]! : null;
  };
  ctx.ns.reserveDerivedName({
    schemaId,
    tableId,
    tableName,
    obj,
    columnNames: colNames,
    indexElementNames,
    singleCheckRef,
  });
};

// ───── 计划编译公共上下文与外部外键重连 ─────

interface PasteContext {
  target: Model;
  targetIdx: ModelIndex;
  /** 目标方言规格与其剪贴板适配器 */
  d: DialectSpec;
  cb: ClipboardDialect;
  frag: Record<string, Obj>;
  fragModel: Model;
  fragIdx: ModelIndex;
  ns: ClipboardNamespace;
  allocId: () => string;
  ops: PasteOp[];
  report: PasteReport;
  commentQueue: { id: string; comment: string }[];
  enumResolutionCache: Map<string, { id: string; name: string; schemaName: string }>;
  qualifiedEnumRenames: QualifiedTypeRename[];
  seqResolutionCache: Map<string, string>;
  copiedColIds: Set<string>;
}

const findExactSchemaInTarget = (ctx: PasteContext, name: string): Schema | undefined => {
  if (!ctx.d.capabilities.schemas) {
    return ctx.targetIdx.allRef('schema')[0];
  }
  const ci = ctx.cb.caseInsensitiveCatalog;
  return ctx.targetIdx
    .allRef('schema')
    .find((s) => (ci ? s.name.toLowerCase() === name.toLowerCase() : s.name === name));
};

const defaultTargetSchema = (ctx: PasteContext): Schema => {
  const cap = ctx.d.capabilities;
  const schemas = ctx.targetIdx.allRef('schema');
  const ci = ctx.cb.caseInsensitiveCatalog;
  const def = schemas.find((s) =>
    ci ? s.name.toLowerCase() === cap.defaultSchema.toLowerCase() : s.name === cap.defaultSchema,
  );
  if (def) return def;
  if (schemas.length > 0) return schemas[0]!;
  throw new PasteError('nothing_to_paste');
};

const resolveEnumInTarget = (
  ctx: PasteContext,
  srcEnumId: string,
  targetSchemaId: string,
): { id: string; name: string; schemaName: string } | null => {
  const cacheKey = `${srcEnumId}\0${targetSchemaId}`;
  const cached = ctx.enumResolutionCache.get(cacheKey);
  if (cached) return cached;

  const srcEnum = ctx.frag[srcEnumId];
  if (srcEnum?.kind !== 'enum') return null;

  const tgtSchema = ctx.target.objects[targetSchemaId];
  if (tgtSchema?.kind !== 'schema') return null;

  const existing = ctx.targetIdx.childrenRef(targetSchemaId, 'enum').find((e) => e.name === srcEnum.name);

  if (existing) {
    const existingSet = new Set(existing.values);
    const isSuperset = srcEnum.values.every((v) => existingSet.has(v));
    if (isSuperset) {
      const valuesDiffer = !deepEqual(existing.values, srcEnum.values);
      ctx.report.notes.push({
        code: 'reusedType',
        kind: 'enum',
        name: existing.name,
        valuesDiffer,
      });
      const res = { id: existing.id, name: existing.name, schemaName: tgtSchema.name };
      ctx.enumResolutionCache.set(cacheKey, res);
      return res;
    }
  }

  const newEnumId = ctx.allocId();
  const newName = ctx.ns.allocateName(srcEnum.name, 'enum', (n) => ctx.ns.isEnumTaken(targetSchemaId, n));
  ctx.ns.addEnum(targetSchemaId, newName);
  if (newName !== srcEnum.name) {
    ctx.report.renamed.push({ kind: 'enum', table: null, from: srcEnum.name, to: newName });
  }
  ctx.ops.push({
    name: 'createEnum',
    args: { id: newEnumId, schema: targetSchemaId, name: newName, values: [...srcEnum.values] },
  });
  if (srcEnum.comment !== null) {
    ctx.commentQueue.push({ id: newEnumId, comment: srcEnum.comment });
  }
  ctx.report.notes.push({ code: 'createdType', kind: 'enum', name: newName });

  const srcSchema = ctx.frag[srcEnum.parent];
  if (srcSchema?.kind === 'schema' && (srcSchema.name !== tgtSchema.name || srcEnum.name !== newName)) {
    ctx.qualifiedEnumRenames.push({
      fromSchema: srcSchema.name,
      fromName: srcEnum.name,
      toSchema: tgtSchema.name,
      toName: newName,
    });
  }

  const res = { id: newEnumId, name: newName, schemaName: tgtSchema.name };
  ctx.enumResolutionCache.set(cacheKey, res);
  return res;
};

const resolveSequenceInTarget = (
  ctx: PasteContext,
  srcSeqId: string,
  targetSchemaId: string,
): { newSeqId: string; isOwnedByCopiedCol: boolean; srcOwnerColId: string | null } | null => {
  const srcSeq = ctx.frag[srcSeqId];
  if (srcSeq?.kind !== 'sequence') return null;

  const isOwnedByCopiedCol = srcSeq.ownedBy !== null && ctx.copiedColIds.has(srcSeq.ownedBy);
  if (!isOwnedByCopiedCol) {
    const cacheKey = `${srcSeqId}\0${targetSchemaId}`;
    const cached = ctx.seqResolutionCache.get(cacheKey);
    if (cached) {
      return { newSeqId: cached, isOwnedByCopiedCol: false, srcOwnerColId: null };
    }
    const ci = ctx.cb.caseInsensitiveCatalog;
    const existing = ctx.targetIdx
      .childrenRef(targetSchemaId, 'sequence')
      .find((s) => (ci ? s.name.toLowerCase() === srcSeq.name.toLowerCase() : s.name === srcSeq.name));
    if (existing) {
      ctx.seqResolutionCache.set(cacheKey, existing.id);
      ctx.report.notes.push({
        code: 'reusedType',
        kind: 'sequence',
        name: existing.name,
        valuesDiffer: false,
      });
      return { newSeqId: existing.id, isOwnedByCopiedCol: false, srcOwnerColId: null };
    }
  }

  const newSeqId = ctx.allocId();
  const newName = ctx.ns.allocateName(srcSeq.name, 'sequence', (n) =>
    ctx.ns.isSequenceTaken(targetSchemaId, n),
  );
  ctx.ns.addSequence(targetSchemaId, newName);
  if (newName !== srcSeq.name) {
    ctx.report.renamed.push({ kind: 'sequence', table: null, from: srcSeq.name, to: newName });
  }
  ctx.ops.push({
    name: 'createSequence',
    args: {
      id: newSeqId,
      schema: targetSchemaId,
      name: newName,
      options: clonePlain(srcSeq.options),
    },
  });
  if (srcSeq.comment !== null) {
    ctx.commentQueue.push({ id: newSeqId, comment: srcSeq.comment });
  }
  ctx.report.notes.push({ code: 'createdType', kind: 'sequence', name: newName });

  if (!isOwnedByCopiedCol) {
    ctx.seqResolutionCache.set(`${srcSeqId}\0${targetSchemaId}`, newSeqId);
  }
  return {
    newSeqId,
    isOwnedByCopiedCol,
    srcOwnerColId: isOwnedByCopiedCol ? srcSeq.ownedBy : null,
  };
};

const columnTypeLabel = (cb: ClipboardDialect, col: Column, lookupObjects: Record<string, Obj>): string => {
  if (col.typeRef) {
    const en = lookupObjects[col.typeRef];
    const enumName = en?.kind === 'enum' ? en.name : '?';
    return `${enumName}${col.type.trim().replace(/\s+/g, '')}`;
  }
  return cb.typeLabel(col);
};

const isTargetColsUniqueBacked = (
  ctx: PasteContext,
  refTableId: string,
  refColIds: readonly string[],
): boolean => {
  const refSet = new Set(refColIds);
  if (refSet.size !== refColIds.length) return false;

  const tablesToCheck = [refTableId, ...partitionAncestors(ctx.target, refTableId).map((a) => a.id)];
  return ctx.cb.isUniqueBacked(ctx.targetIdx, tablesToCheck, refSet);
};

const reconnectExternalFk = (
  ctx: PasteContext,
  fk: ForeignKey,
  reportTableName: string,
): { refTable: string; refColumns: string[] } | null => {
  const d = ctx.d;
  const srcRefTbl = ctx.frag[fk.refTable];
  if (srcRefTbl?.kind !== 'table') {
    ctx.report.skipped.push({
      kind: 'foreignKey',
      name: fk.name,
      table: reportTableName,
      reason: 'missingRefTable',
      detail: fk.refTable,
    });
    return null;
  }
  const srcRefSchema = ctx.frag[srcRefTbl.parent];
  const srcSchemaName = srcRefSchema?.kind === 'schema' ? srcRefSchema.name : d.capabilities.defaultSchema;
  const displayTable = d.capabilities.schemas ? `${srcSchemaName}.${srcRefTbl.name}` : srcRefTbl.name;

  const tgtSchema = findExactSchemaInTarget(ctx, srcSchemaName);
  if (!tgtSchema) {
    ctx.report.skipped.push({
      kind: 'foreignKey',
      name: fk.name,
      table: reportTableName,
      reason: 'missingRefTable',
      detail: displayTable,
    });
    return null;
  }

  const ci = ctx.cb.caseInsensitiveIdents;
  const tgtRefTbl = ctx.targetIdx
    .childrenRef(tgtSchema.id, 'table')
    .find((t) => (ci ? t.name.toLowerCase() === srcRefTbl.name.toLowerCase() : t.name === srcRefTbl.name));

  if (!tgtRefTbl) {
    ctx.report.skipped.push({
      kind: 'foreignKey',
      name: fk.name,
      table: reportTableName,
      reason: 'missingRefTable',
      detail: displayTable,
    });
    return null;
  }

  const tgtRefCols = effectiveColumnsOf(ctx.target, tgtRefTbl.id);
  const tgtColByName = new Map(tgtRefCols.map((c) => [normIdent(ctx.cb, c.name), c]));

  const mappedRefCols: Column[] = [];
  const srcRefCols: Column[] = [];
  const missingNames: string[] = [];

  for (const srcRefColId of fk.refColumns) {
    const srcCol = ctx.frag[srcRefColId];
    if (srcCol?.kind !== 'column') {
      missingNames.push(srcRefColId);
      continue;
    }
    const tgtCol = tgtColByName.get(normIdent(ctx.cb, srcCol.name));
    if (!tgtCol) {
      missingNames.push(srcCol.name);
      continue;
    }
    srcRefCols.push(srcCol);
    mappedRefCols.push(tgtCol);
  }

  if (missingNames.length > 0) {
    ctx.report.skipped.push({
      kind: 'foreignKey',
      name: fk.name,
      table: reportTableName,
      reason: 'missingRefColumns',
      detail: [...new Set(missingNames)].join(', '),
    });
    return null;
  }

  for (let i = 0; i < srcRefCols.length; i++) {
    const srcCol = srcRefCols[i]!;
    const tgtCol = mappedRefCols[i]!;
    const srcType = columnTypeLabel(ctx.cb, srcCol, ctx.frag);
    const tgtType = columnTypeLabel(ctx.cb, tgtCol, ctx.target.objects);
    if (srcType !== tgtType) {
      ctx.report.skipped.push({
        kind: 'foreignKey',
        name: fk.name,
        table: reportTableName,
        reason: 'refTypeMismatch',
        detail: `${srcCol.name}: ${srcType} ≠ ${tgtType}`,
      });
      return null;
    }
  }

  const mappedRefIds = mappedRefCols.map((c) => c.id);
  if (!isTargetColsUniqueBacked(ctx, tgtRefTbl.id, mappedRefIds)) {
    ctx.report.skipped.push({
      kind: 'foreignKey',
      name: fk.name,
      table: reportTableName,
      reason: 'refNotUnique',
      detail: mappedRefCols.map((c) => c.name).join(', '),
    });
    return null;
  }

  return { refTable: tgtRefTbl.id, refColumns: mappedRefIds };
};

// ───── 表粒度粘贴规划 ─────

const planTablesPaste = (ctx: PasteContext, payload: ClipboardPayload): PastePlan => {
  const d = ctx.d;
  const tableMap: Record<string, string> = {};
  const newTables: string[] = [];
  const schemaFallbackCounts = new Map<string, { from: string; to: string; tables: number }>();

  // 登记全部被复制表的列 ID，以判定序列是否为表内列所属（ownedBy）
  for (const obj of Object.values(ctx.frag)) {
    if (obj.kind === 'column') ctx.copiedColIds.add(obj.id);
  }

  const mapSchema = (srcSchemaId: string, countFallback: boolean): string => {
    const srcSchema = ctx.frag[srcSchemaId];
    const srcName = srcSchema?.kind === 'schema' ? srcSchema.name : d.capabilities.defaultSchema;
    const exact = findExactSchemaInTarget(ctx, srcName);
    if (exact) return exact.id;
    const fallback = defaultTargetSchema(ctx);
    if (countFallback) {
      const k = `${srcName}\0${fallback.name}`;
      const entry = schemaFallbackCounts.get(k);
      if (entry) entry.tables++;
      else schemaFallbackCounts.set(k, { from: srcName, to: fallback.name, tables: 1 });
    }
    return fallback.id;
  };

  const colIdsByTable = new Map<string, Map<string, string>>();
  const newColNameById = new Map<string, string>();
  const deferredFks: {
    fk: ForeignKey;
    newTableId: string;
    newTableName: string;
    newSchemaId: string;
    srcTableName: string;
    colRenameMap: Map<string, string>;
    tableColIdMap: Map<string, string>;
  }[] = [];
  let partitionObjectsSkipped = 0;

  const mapCols = (
    colIds: readonly string[],
    colMap: Map<string, string>,
  ): { mapped: string[]; missing: string[] } => {
    const mapped: string[] = [];
    const missing: string[] = [];
    for (const cid of colIds) {
      const nextId = colMap.get(cid);
      if (!nextId) {
        const obj = ctx.frag[cid];
        missing.push(obj?.kind === 'column' ? obj.name : cid);
      } else {
        mapped.push(nextId);
      }
    }
    return { mapped, missing };
  };

  const seenTables = new Set<string>();
  for (const srcRootId of payload.tables) {
    if (seenTables.has(srcRootId)) continue;
    seenTables.add(srcRootId);
    const srcTbl = ctx.frag[srcRootId];
    if (srcTbl?.kind !== 'table') continue;

    const newTableId = ctx.allocId();
    const newSchemaId = mapSchema(srcTbl.parent, true);
    const newTableName = ctx.ns.allocateName(srcTbl.name, 'table', (n) =>
      ctx.ns.isTableTaken(newSchemaId, n),
    );
    ctx.ns.addTable(newSchemaId, newTableName);
    if (newTableName !== srcTbl.name) {
      ctx.report.renamed.push({ kind: 'table', table: null, from: srcTbl.name, to: newTableName });
    }
    tableMap[srcRootId] = newTableId;
    newTables.push(newTableId);
    const tableColIdMap = new Map<string, string>();
    colIdsByTable.set(srcRootId, tableColIdMap);

    // 依赖主键的表扩展（如 SQLite WITHOUT ROWID）需要等主键创建后通过 setTableExt 设置
    const deferredTableExt =
      srcTbl.ext && ctx.cb.deferTableExtUntilPk ? ctx.cb.deferTableExtUntilPk(clonePlain(srcTbl.ext)) : null;
    const createTableExt = deferredTableExt
      ? deferredTableExt.stripped
      : srcTbl.ext
        ? clonePlain(srcTbl.ext)
        : undefined;

    ctx.ops.push({
      name: 'createTable',
      args: {
        id: newTableId,
        schema: newSchemaId,
        name: newTableName,
        ...(createTableExt ? { ext: createTableExt } : {}),
      },
    });
    if (srcTbl.comment !== null) {
      ctx.commentQueue.push({ id: newTableId, comment: srcTbl.comment });
    }

    // 处理列（按 pos 顺序）
    const srcCols = ctx.fragIdx.columnsRef(srcRootId);
    const colRenameMap = new Map<string, string>();
    const exprColNames: string[] = [];
    const deferredAutoIncCols: { colId: string; ext: ColumnExt }[] = [];

    for (const srcCol of srcCols) {
      const newColId = ctx.allocId();
      const newColName = ctx.ns.allocateName(srcCol.name, 'column', (n) => ctx.ns.isColTaken(newTableId, n));
      ctx.ns.addColumn(newTableId, newColName);
      if (newColName !== srcCol.name) {
        ctx.report.renamed.push({
          kind: 'column',
          table: newTableName,
          from: srcCol.name,
          to: newColName,
        });
        colRenameMap.set(srcCol.name, newColName);
      }
      tableColIdMap.set(srcCol.id, newColId);
      newColNameById.set(newColId, newColName);
      exprColNames.push(newColName);

      // typeRef 枚举解析
      let mappedTypeRef: string | null = null;
      if (srcCol.typeRef) {
        const srcEnum = ctx.frag[srcCol.typeRef];
        const enumSchemaId = srcEnum?.kind === 'enum' ? mapSchema(srcEnum.parent, false) : newSchemaId;
        const resolvedEnum = resolveEnumInTarget(ctx, srcCol.typeRef, enumSchemaId);
        mappedTypeRef = resolvedEnum?.id ?? null;
      }

      // default 解析（序列 vs 表达式）
      let mappedDefault: ColumnDefault | null = null;
      let ownedSeqToBind: string | null = null;
      if (!srcCol.identity && !srcCol.generated && srcCol.default) {
        if ('nextval' in srcCol.default) {
          if (!d.capabilities.sequences || !(srcCol.default.nextval in ctx.frag)) {
            ctx.report.notes.push({
              code: 'defaultCleared',
              table: newTableName,
              column: newColName,
            });
          } else {
            const seqRes = resolveSequenceInTarget(ctx, srcCol.default.nextval, newSchemaId);
            if (!seqRes) {
              ctx.report.notes.push({
                code: 'defaultCleared',
                table: newTableName,
                column: newColName,
              });
            } else {
              mappedDefault = { nextval: seqRes.newSeqId };
              if (seqRes.isOwnedByCopiedCol && seqRes.srcOwnerColId === srcCol.id) {
                ownedSeqToBind = seqRes.newSeqId;
              }
            }
          }
        } else {
          let defExpr = renameManyInExpr(ctx.target.dialect, srcCol.default.expr, colRenameMap);
          defExpr = renameQualifiedManyInExpr(ctx.cb, defExpr, ctx.qualifiedEnumRenames);
          mappedDefault = { expr: defExpr };
        }
      }

      // 扩展属性：依赖主键的列扩展（如 SQLite AUTOINCREMENT）延后到主键之后设置
      let colExt = srcCol.ext ? clonePlain(srcCol.ext) : undefined;
      const deferredColExt =
        colExt && ctx.cb.deferColumnExtUntilPk ? ctx.cb.deferColumnExtUntilPk(colExt) : null;
      if (deferredColExt && srcCol.ext) {
        deferredAutoIncCols.push({ colId: newColId, ext: clonePlain(srcCol.ext) });
        colExt = deferredColExt.stripped;
      }

      let mappedGenerated: { expr: string; stored: boolean } | null = null;
      if (srcCol.generated) {
        let genExpr = renameManyInExpr(ctx.target.dialect, srcCol.generated.expr, colRenameMap);
        genExpr = renameQualifiedManyInExpr(ctx.cb, genExpr, ctx.qualifiedEnumRenames);
        mappedGenerated = { expr: genExpr, stored: srcCol.generated.stored };
      }

      const mappedIdentity = srcCol.identity
        ? { always: srcCol.identity.always, options: clonePlain(srcCol.identity.options) }
        : null;

      // addColumn 会按方言推导附属名字（如 PG NOT NULL / IDENTITY 序列名、MSSQL 默认约束名），同步预占
      colExt = ctx.ns.prepareTableColumn(
        {
          schemaId: newSchemaId,
          tableId: newTableId,
          tableName: newTableName,
          columnName: newColName,
          type: srcCol.type,
          typeRef: mappedTypeRef,
          ext: colExt,
          hasDefault: mappedDefault !== null,
          notNull: srcCol.notNull,
          hasIdentity: mappedIdentity !== null,
        },
        (from, to) => ctx.report.renamed.push({ kind: 'column', table: newTableName, from, to }),
      );

      ctx.ops.push({
        name: 'addColumn',
        args: {
          table: newTableId,
          column: {
            id: newColId,
            name: newColName,
            type: srcCol.type,
            typeRef: mappedTypeRef,
            notNull: srcCol.notNull || Boolean(mappedIdentity),
            default: mappedDefault,
            identity: mappedIdentity,
            generated: mappedGenerated,
            collation: srcCol.collation,
            ...(colExt ? { ext: colExt } : {}),
          },
        },
      });

      if (ownedSeqToBind) {
        ctx.ops.push({
          name: 'setSequenceOwnedBy',
          args: { id: ownedSeqToBind, column: newColId },
        });
      }
      if (srcCol.comment !== null) {
        ctx.commentQueue.push({ id: newColId, comment: srcCol.comment });
      }
    }

    // 主键
    let createdPk = false;
    for (const pk of ctx.fragIdx.childrenRef(srcRootId, 'primaryKey')) {
      const { mapped: mappedCols, missing } = mapCols(pk.columns, tableColIdMap);
      if (missing.length > 0 || mappedCols.length === 0) {
        ctx.report.skipped.push({
          kind: 'primaryKey',
          name: pk.name,
          table: newTableName,
          reason: 'missingColumns',
          detail: missing.length > 0 ? [...new Set(missing)].join(', ') : null,
        });
        continue;
      }
      const newPkId = ctx.allocId();
      ctx.ops.push({
        name: 'addPrimaryKey',
        args: {
          id: newPkId,
          table: newTableId,
          columns: mappedCols,
          ...(pk.ext ? { ext: clonePlain(pk.ext) } : {}),
        },
      });
      createdPk = true;
      if (pk.nameMode === 'explicit' && ctx.cb.explicitPrimaryKeyNames) {
        const newName = ctx.ns.allocateName(pk.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(newSchemaId, newTableId, 'primaryKey', n),
        );
        ctx.ns.addKey(newSchemaId, newTableId, 'primaryKey', newName);
        if (newName !== pk.name) {
          ctx.report.renamed.push({
            kind: 'primaryKey',
            table: newTableName,
            from: pk.name,
            to: newName,
          });
        }
        ctx.ops.push({ name: 'renameKey', args: { id: newPkId, name: newName } });
      } else {
        reserveDerivedKeyOrIndex(
          ctx,
          newSchemaId,
          newTableId,
          newTableName,
          { ...pk, columns: mappedCols },
          newColNameById,
          exprColNames,
        );
      }
      if (pk.comment !== null) {
        ctx.commentQueue.push({ id: newPkId, comment: pk.comment });
      }
    }

    // 延后的依赖主键的表 / 列扩展（如 SQLite WITHOUT ROWID 与 AUTOINCREMENT）
    if (deferredTableExt && createdPk && srcTbl.ext) {
      ctx.ops.push({
        name: 'setTableExt',
        args: { id: newTableId, ext: clonePlain(srcTbl.ext) },
      });
    }
    for (const item of deferredAutoIncCols) {
      ctx.ops.push({
        name: 'setColumnExt',
        args: { id: item.colId, ext: item.ext },
      });
    }

    // 分区设置与全部后代子分区（BFS 顺序）
    const mapPartitionSpec = (spec: PartitionSpec): PartitionSpec | null => {
      const keys: PartitionKey[] = [];
      for (const k of spec.keys) {
        let mappedCol: string | null = null;
        if (k.column !== null) {
          const nextId = tableColIdMap.get(k.column);
          if (!nextId) return null;
          mappedCol = nextId;
        }
        let expr = k.expr;
        if (expr) {
          expr = renameManyInExpr(ctx.target.dialect, expr, colRenameMap);
          expr = renameQualifiedManyInExpr(ctx.cb, expr, ctx.qualifiedEnumRenames);
        }
        if ((mappedCol !== null) === (expr !== null && expr.length > 0)) return null;
        keys.push({
          column: mappedCol,
          expr,
          opclass: k.opclass,
          collation: k.collation,
        });
      }
      return keys.length > 0 ? { strategy: spec.strategy, keys } : null;
    };

    const partitionSpecOf = d.capabilities.partitioning ? ctx.cb.partitionSpecOf : undefined;
    if (partitionSpecOf && srcTbl.partitionBy !== null) {
      const rootSpec = partitionSpecOf(ctx.fragModel, srcTbl);
      const mappedRootSpec = rootSpec ? mapPartitionSpec(rootSpec) : null;
      if (mappedRootSpec) {
        ctx.ops.push({
          name: 'setPartitionBy',
          args: { id: newTableId, partitionBy: mappedRootSpec },
        });
        for (const srcDesc of ctx.fragIdx.partitionDescendants(srcRootId)) {
          const partOf = srcDesc.partitionOf;
          const descParentNewId =
            partOf && Object.hasOwn(tableMap, partOf.parent) ? tableMap[partOf.parent] : undefined;
          if (!partOf || !descParentNewId) continue;
          const newDescId = ctx.allocId();
          const descSchemaId = mapSchema(srcDesc.parent, srcDesc.parent !== srcTbl.parent);
          const newDescName = ctx.ns.allocateName(srcDesc.name, 'table', (n) =>
            ctx.ns.isTableTaken(descSchemaId, n),
          );
          ctx.ns.addTable(descSchemaId, newDescName);
          if (newDescName !== srcDesc.name) {
            ctx.report.renamed.push({ kind: 'table', table: null, from: srcDesc.name, to: newDescName });
          }
          tableMap[srcDesc.id] = newDescId;

          ctx.ops.push({
            name: 'createPartition',
            args: {
              id: newDescId,
              parent: descParentNewId,
              name: newDescName,
              bound: partOf.bound,
              schema: descSchemaId,
            },
          });
          if (srcDesc.partitionBy !== null) {
            const descSpec = partitionSpecOf(ctx.fragModel, srcDesc);
            const mappedDescSpec = descSpec ? mapPartitionSpec(descSpec) : null;
            if (mappedDescSpec) {
              ctx.ops.push({
                name: 'setPartitionBy',
                args: { id: newDescId, partitionBy: mappedDescSpec },
              });
            }
          }
          if (srcDesc.comment !== null) {
            ctx.commentQueue.push({ id: newDescId, comment: srcDesc.comment });
          }

          for (const ch of ctx.fragIdx.allChildrenOf(srcDesc.id)) {
            if (
              ch.kind === 'primaryKey' ||
              ch.kind === 'unique' ||
              ch.kind === 'check' ||
              ch.kind === 'foreignKey' ||
              ch.kind === 'index'
            ) {
              partitionObjectsSkipped++;
            }
          }
        }
      }
    }

    // UNIQUE / CHECK / INDEX
    for (const u of ctx.fragIdx.childrenRef(srcRootId, 'unique')) {
      const { mapped: mappedCols, missing } = mapCols(u.columns, tableColIdMap);
      if (missing.length > 0 || mappedCols.length === 0) {
        ctx.report.skipped.push({
          kind: 'unique',
          name: u.name,
          table: newTableName,
          reason: 'missingColumns',
          detail: missing.length > 0 ? [...new Set(missing)].join(', ') : null,
        });
        continue;
      }
      const newUid = ctx.allocId();
      ctx.ops.push({
        name: 'addUnique',
        args: {
          id: newUid,
          table: newTableId,
          columns: mappedCols,
          nullsNotDistinct: u.nullsNotDistinct,
          ...(u.ext ? { ext: clonePlain(u.ext) } : {}),
        },
      });
      if (u.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(u.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(newSchemaId, newTableId, 'unique', n),
        );
        ctx.ns.addKey(newSchemaId, newTableId, 'unique', newName);
        if (newName !== u.name) {
          ctx.report.renamed.push({ kind: 'unique', table: newTableName, from: u.name, to: newName });
        }
        ctx.ops.push({ name: 'renameKey', args: { id: newUid, name: newName } });
      } else {
        reserveDerivedKeyOrIndex(
          ctx,
          newSchemaId,
          newTableId,
          newTableName,
          { ...u, columns: mappedCols },
          newColNameById,
          exprColNames,
        );
      }
      if (u.comment !== null) {
        ctx.commentQueue.push({ id: newUid, comment: u.comment });
      }
    }

    for (const ck of ctx.fragIdx.childrenRef(srcRootId, 'check')) {
      const newCkId = ctx.allocId();
      let expr = renameManyInExpr(ctx.target.dialect, ck.expr, colRenameMap);
      expr = renameQualifiedManyInExpr(ctx.cb, expr, ctx.qualifiedEnumRenames);
      ctx.ops.push({
        name: 'addCheck',
        args: { id: newCkId, table: newTableId, expr, noInherit: ck.noInherit },
      });
      if (ck.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(ck.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(newSchemaId, newTableId, 'check', n),
        );
        ctx.ns.addKey(newSchemaId, newTableId, 'check', newName);
        if (newName !== ck.name) {
          ctx.report.renamed.push({ kind: 'check', table: newTableName, from: ck.name, to: newName });
        }
        ctx.ops.push({ name: 'renameKey', args: { id: newCkId, name: newName } });
      } else {
        reserveDerivedKeyOrIndex(
          ctx,
          newSchemaId,
          newTableId,
          newTableName,
          { ...ck, expr },
          newColNameById,
          exprColNames,
        );
      }
      if (ck.comment !== null) {
        ctx.commentQueue.push({ id: newCkId, comment: ck.comment });
      }
    }

    for (const ix of ctx.fragIdx.childrenRef(srcRootId, 'index')) {
      const missingCols: string[] = [];
      let invalidElement = false;
      const mappedElements: IndexElement[] = [];
      for (const e of ix.elements) {
        let mappedCol: string | null = null;
        if (e.column) {
          const nextId = tableColIdMap.get(e.column);
          if (!nextId) {
            const obj = ctx.frag[e.column];
            missingCols.push(obj?.kind === 'column' ? obj.name : e.column);
          } else {
            mappedCol = nextId;
          }
        }
        const mappedExpr =
          e.expr !== null
            ? renameQualifiedManyInExpr(
                ctx.cb,
                renameManyInExpr(ctx.target.dialect, e.expr, colRenameMap),
                ctx.qualifiedEnumRenames,
              )
            : null;
        if (!isValidIndexElement({ column: e.column, expr: mappedExpr })) {
          invalidElement = true;
        }
        mappedElements.push({
          column: mappedCol,
          expr: mappedExpr,
          desc: e.desc,
          nullsFirst: e.nullsFirst,
          opclass: e.opclass,
          collation: e.collation,
        });
      }
      const incRes = mapCols(ix.include, tableColIdMap);
      if (incRes.missing.length > 0) missingCols.push(...incRes.missing);
      if (missingCols.length > 0) {
        ctx.report.skipped.push({
          kind: 'index',
          name: ix.name,
          table: newTableName,
          reason: 'missingColumns',
          detail: [...new Set(missingCols)].join(', '),
        });
        continue;
      }
      if (invalidElement || mappedElements.length === 0) {
        ctx.report.skipped.push({
          kind: 'index',
          name: ix.name,
          table: newTableName,
          reason: 'unsupported',
          detail: null,
        });
        continue;
      }
      const mappedInclude = incRes.mapped;
      const newIxId = ctx.allocId();
      const mappedWhere = ix.where
        ? renameQualifiedManyInExpr(
            ctx.cb,
            renameManyInExpr(ctx.target.dialect, ix.where, colRenameMap),
            ctx.qualifiedEnumRenames,
          )
        : null;
      ctx.ops.push({
        name: 'addIndex',
        args: {
          id: newIxId,
          table: newTableId,
          elements: mappedElements,
          unique: ix.unique,
          method: ix.method,
          include: mappedInclude,
          where: mappedWhere,
          nullsNotDistinct: ix.nullsNotDistinct,
          ...(ix.ext ? { ext: clonePlain(ix.ext) } : {}),
        },
      });
      if (ix.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(ix.name, 'index', (n) =>
          ctx.ns.isIndexTaken(newSchemaId, newTableId, n),
        );
        ctx.ns.addIndex(newSchemaId, newTableId, newName);
        if (newName !== ix.name) {
          ctx.report.renamed.push({ kind: 'index', table: newTableName, from: ix.name, to: newName });
        }
        ctx.ops.push({ name: 'renameKey', args: { id: newIxId, name: newName } });
      } else {
        reserveDerivedKeyOrIndex(
          ctx,
          newSchemaId,
          newTableId,
          newTableName,
          { ...ix, elements: mappedElements, include: mappedInclude, where: mappedWhere },
          newColNameById,
          exprColNames,
        );
      }
      if (ix.comment !== null) {
        ctx.commentQueue.push({ id: newIxId, comment: ix.comment });
      }
    }

    for (const fk of ctx.fragIdx.childrenRef(srcRootId, 'foreignKey')) {
      deferredFks.push({
        fk,
        newTableId,
        newTableName,
        newSchemaId,
        srcTableName: srcTbl.name,
        colRenameMap,
        tableColIdMap,
      });
    }
  }

  // 所有表建完后再处理全部外键（内部重连 + 外部按 schema.table.col 重连）
  for (const item of deferredFks) {
    const { fk, newTableId, newTableName, newSchemaId, srcTableName, tableColIdMap } = item;
    const localRes = mapCols(fk.columns, tableColIdMap);
    if (localRes.missing.length > 0 || localRes.mapped.length === 0) {
      ctx.report.skipped.push({
        kind: 'foreignKey',
        name: fk.name,
        table: newTableName,
        reason: 'missingColumns',
        detail: localRes.missing.length > 0 ? [...new Set(localRes.missing)].join(', ') : null,
      });
      continue;
    }
    const mappedCols = localRes.mapped;
    let refTable: string;
    let refColumns: string[];

    if (Object.hasOwn(tableMap, fk.refTable)) {
      const mappedRefTable = tableMap[fk.refTable];
      const refRootId = rootTableId(ctx.fragModel, fk.refTable);
      const refColMap = colIdsByTable.get(refRootId);
      const refRes = refColMap
        ? mapCols(fk.refColumns, refColMap)
        : { mapped: [], missing: [...fk.refColumns] };
      if (
        !mappedRefTable ||
        refRes.missing.length > 0 ||
        refRes.mapped.length === 0 ||
        refRes.mapped.length !== mappedCols.length
      ) {
        ctx.report.skipped.push({
          kind: 'foreignKey',
          name: fk.name,
          table: newTableName,
          reason: 'missingRefColumns',
          detail: refRes.missing.length > 0 ? [...new Set(refRes.missing)].join(', ') : null,
        });
        continue;
      }
      refTable = mappedRefTable;
      refColumns = refRes.mapped;
    } else {
      const reconnected = reconnectExternalFk(ctx, fk, srcTableName);
      if (!reconnected) continue;
      if (reconnected.refColumns.length !== mappedCols.length) {
        ctx.report.skipped.push({
          kind: 'foreignKey',
          name: fk.name,
          table: newTableName,
          reason: 'missingRefColumns',
          detail: null,
        });
        continue;
      }
      refTable = reconnected.refTable;
      refColumns = reconnected.refColumns;
    }

    const newFkId = ctx.allocId();
    ctx.ops.push({
      name: 'addForeignKey',
      args: {
        id: newFkId,
        table: newTableId,
        columns: mappedCols,
        refTable,
        refColumns,
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        match: fk.match,
        deferrable: fk.deferrable,
        initiallyDeferred: fk.initiallyDeferred,
      },
    });
    if (fk.nameMode === 'explicit') {
      const newName = ctx.ns.allocateName(fk.name, 'constraint', (n) =>
        ctx.ns.isKeyTaken(newSchemaId, newTableId, 'foreignKey', n),
      );
      ctx.ns.addKey(newSchemaId, newTableId, 'foreignKey', newName);
      if (newName !== fk.name) {
        ctx.report.renamed.push({ kind: 'foreignKey', table: newTableName, from: fk.name, to: newName });
      }
      ctx.ops.push({ name: 'renameKey', args: { id: newFkId, name: newName } });
    } else {
      reserveDerivedKeyOrIndex(
        ctx,
        newSchemaId,
        newTableId,
        newTableName,
        { ...fk, columns: mappedCols },
        newColNameById,
        [],
      );
    }
    if (fk.comment !== null) {
      ctx.commentQueue.push({ id: newFkId, comment: fk.comment });
    }
  }

  for (const c of ctx.commentQueue) {
    ctx.ops.push({ name: 'setComment', args: { id: c.id, comment: c.comment } });
  }

  for (const fb of schemaFallbackCounts.values()) {
    ctx.report.notes.push({ code: 'schemaFallback', from: fb.from, to: fb.to, tables: fb.tables });
  }
  if (payload.skippedOpaque > 0) {
    ctx.report.notes.push({ code: 'opaqueSkipped', count: payload.skippedOpaque });
  }
  if (partitionObjectsSkipped > 0) {
    ctx.report.notes.push({ code: 'partitionObjectsSkipped', count: partitionObjectsSkipped });
  }

  if (ctx.ops.length > MAX_PASTE_OPS) {
    throw new PasteError('too_many_ops', { ops: ctx.ops.length, max: MAX_PASTE_OPS });
  }

  return {
    ops: ctx.ops,
    tableMap,
    newTables,
    newItems: [],
    targetTable: null,
    report: ctx.report,
  };
};

// ───── 表内粒度粘贴规划 ─────

const normExprText = (s: string | null): string | null => (s === null ? null : s.trim().replace(/\s+/g, ' '));

const planItemsPaste = (ctx: PasteContext, payload: ClipboardPayload, tgtTbl: Table): PastePlan => {
  const d = ctx.d;
  const tgtSchemaId = tgtTbl.parent;
  const rawSrcTbl = payload.table ? ctx.frag[payload.table] : undefined;
  if (!rawSrcTbl || rawSrcTbl.kind !== 'table') {
    throw new PasteError('nothing_to_paste');
  }
  const srcTbl = rawSrcTbl;
  const srcRootId = rootTableId(ctx.fragModel, srcTbl.id);

  for (const c of effectiveColumnsOf(ctx.target, tgtTbl.id)) ctx.ns.addColumn(tgtTbl.id, c.name);

  // 构造轻量级本地草稿模型（只深拷贝目标表及其家族、新建对象与涉事 schema），绝不修改 target
  const scratch: Model = {
    format: ctx.target.format,
    dialect: ctx.target.dialect,
    objects: { ...ctx.target.objects },
  };
  const touchedFamilyIds = new Set<string>([tgtSchemaId, tgtTbl.id]);
  for (const ch of ctx.targetIdx.allChildrenOf(tgtTbl.id)) touchedFamilyIds.add(ch.id);
  for (const desc of ctx.targetIdx.partitionDescendants(tgtTbl.id)) {
    touchedFamilyIds.add(desc.id);
    for (const ch of ctx.targetIdx.allChildrenOf(desc.id)) touchedFamilyIds.add(ch.id);
  }
  for (const seq of ctx.targetIdx.allRef('sequence')) {
    if (seq.parent === tgtSchemaId) touchedFamilyIds.add(seq.id);
  }
  for (const fid of touchedFamilyIds) {
    if (fid in scratch.objects) scratch.objects[fid] = clonePlain(scratch.objects[fid]!);
  }

  const batchExtraTrackedIds = new Set<string>();
  const runScratchOps = (candidateOps: PasteOp[]): string | null => {
    const backup = new Map<string, Obj>();
    for (const fid of touchedFamilyIds) {
      if (fid in scratch.objects) backup.set(fid, clonePlain(scratch.objects[fid]!));
    }
    for (const bid of batchExtraTrackedIds) {
      if (bid in scratch.objects) backup.set(bid, clonePlain(scratch.objects[bid]!));
    }
    const addedKeys: string[] = [];
    try {
      for (const op of candidateOps) {
        const a = op.args as Record<string, unknown>;
        if (op.name === 'addColumn') {
          const cid = (a.column as Record<string, unknown>).id as string;
          addedKeys.push(cid);
        } else if (typeof a.id === 'string' && !(a.id in scratch.objects)) {
          addedKeys.push(a.id);
        }
        runMutator(scratch, op.name, op.args);
      }
      for (const ak of addedKeys) batchExtraTrackedIds.add(ak);
      return null;
    } catch (e) {
      for (const ak of addedKeys) delete scratch.objects[ak];
      for (const [k, v] of backup) scratch.objects[k] = v;
      return e instanceof Error ? e.message : String(e);
    }
  };

  const seenItems = new Set<string>();
  const itemObjs: Obj[] = [];
  for (const iid of payload.items) {
    if (seenItems.has(iid)) continue;
    seenItems.add(iid);
    const o = ctx.frag[iid];
    if (o) itemObjs.push(o);
  }
  const srcColItems = itemObjs.filter((o): o is Column => o.kind === 'column');
  const srcKeyItems = itemObjs.filter((o) => o.kind !== 'column');

  for (const sc of srcColItems) ctx.copiedColIds.add(sc.id);

  // 预检已有列与表级约束
  const existingCols = columnsOf(scratch, tgtTbl.id);
  const existingColByNormName = new Map(existingCols.map((c) => [normIdent(ctx.cb, c.name), c]));
  let hasTargetPk = childrenOf(scratch, tgtTbl.id, 'primaryKey').length > 0;

  const batchPkItem = srcKeyItems.find((o): o is PrimaryKey => o.kind === 'primaryKey');
  const checkColumn = ctx.cb.createItemColumnGuard?.({
    table: tgtTbl,
    existingCols,
    hasTargetPk,
    batchPk: batchPkItem,
    batchUniques: srcKeyItems.filter((o): o is Unique => o.kind === 'unique'),
    batchIndexes: srcKeyItems.filter((o): o is Index => o.kind === 'index'),
  });

  // 第 1 趟：单列能力检查与新列名分配
  interface CandidateCol {
    src: Column;
    newId: string;
    newName: string;
    renamed: boolean;
    /** 依赖主键、需延后到主键之后设置的列扩展（如 SQLite AUTOINCREMENT） */
    deferredExt: DeferredExt<ColumnExt> | null;
  }
  const candidates: CandidateCol[] = [];
  const colRenameMap = new Map<string, string>();

  for (const sc of srcColItems) {
    const unsupported = checkColumn ? checkColumn(sc) : null;
    if (unsupported !== null) {
      ctx.report.skipped.push({
        kind: 'column',
        name: sc.name,
        table: tgtTbl.name,
        reason: 'unsupported',
        detail: unsupported,
      });
      continue;
    }

    const newColId = ctx.allocId();
    const newName = ctx.ns.allocateName(sc.name, 'column', (n) => ctx.ns.isColTaken(tgtTbl.id, n));
    ctx.ns.addColumn(tgtTbl.id, newName);
    const renamed = newName !== sc.name;
    if (renamed) colRenameMap.set(sc.name, newName);
    candidates.push({
      src: sc,
      newId: newColId,
      newName,
      renamed,
      deferredExt:
        sc.ext && ctx.cb.deferColumnExtUntilPk ? ctx.cb.deferColumnExtUntilPk(clonePlain(sc.ext)) : null,
    });
  }

  // 第 1.5 趟：不动点检查生成列表达式引用（保证无悬空引用，并满足方言的额外引用限制，如 MySQL 生成列不引用 AUTO_INCREMENT 列）
  let surviving = candidates;
  for (;;) {
    const allowedNormNames = new Set<string>(existingCols.map((c) => normIdent(ctx.cb, c.name)));
    for (const c of surviving) {
      allowedNormNames.add(normIdent(ctx.cb, c.newName));
    }
    const checkGeneratedRefs = ctx.cb.createGeneratedRefGuard?.(existingCols, surviving);
    const nextSurviving: CandidateCol[] = [];
    let droppedAny = false;
    for (const c of surviving) {
      if (c.src.generated) {
        const rewritten = renameManyInExpr(ctx.target.dialect, c.src.generated.expr, colRenameMap);
        const unknown = findUnknownExprColumns(ctx.d, rewritten, allowedNormNames);
        if (unknown.length > 0) {
          ctx.ns.removeColumn(tgtTbl.id, c.newName);
          colRenameMap.delete(c.src.name);
          ctx.report.skipped.push({
            kind: 'column',
            name: c.src.name,
            table: tgtTbl.name,
            reason: 'invalidExpr',
            detail: unknown.join(', '),
          });
          droppedAny = true;
          continue;
        }
        const refViolation = checkGeneratedRefs ? checkGeneratedRefs(rewritten) : null;
        if (refViolation !== null) {
          ctx.ns.removeColumn(tgtTbl.id, c.newName);
          colRenameMap.delete(c.src.name);
          ctx.report.skipped.push({
            kind: 'column',
            name: c.src.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: refViolation,
          });
          droppedAny = true;
          continue;
        }
      }
      nextSurviving.push(c);
    }
    surviving = nextSurviving;
    if (!droppedAny) break;
  }

  // 第 2 趟：在 scratch 上逐列预演并提交
  const pastedColBySrcId = new Map<string, { id: string; name: string }>();
  const newItems: string[] = [];
  let pendingDeferredExt: { colId: string; srcColId: string; ext: ColumnExt } | null = null;

  for (const cand of surviving) {
    const sc = cand.src;
    // 保存枚举/序列备注与缓存前先收集候选 ops（若失败避免产生多余 note）
    const prevRenamedLen = ctx.report.renamed.length;
    const prevNotesLen = ctx.report.notes.length;
    const prevCommentLen = ctx.commentQueue.length;
    const prevQualLen = ctx.qualifiedEnumRenames.length;
    const prevEnumCacheKeys = new Set(ctx.enumResolutionCache.keys());
    const prevSeqCacheKeys = new Set(ctx.seqResolutionCache.keys());
    const candidateOps: PasteOp[] = [];
    const localContext: PasteContext = {
      ...ctx,
      ops: candidateOps,
    };

    let mappedTypeRef: string | null = null;
    if (sc.typeRef) {
      const resolvedEnum = resolveEnumInTarget(localContext, sc.typeRef, tgtSchemaId);
      mappedTypeRef = resolvedEnum?.id ?? null;
    }

    let mappedDefault: ColumnDefault | null = null;
    let ownedSeqToBind: string | null = null;
    if (!sc.identity && !sc.generated && sc.default) {
      if ('nextval' in sc.default) {
        if (!d.capabilities.sequences || !(sc.default.nextval in ctx.frag)) {
          ctx.report.notes.push({ code: 'defaultCleared', table: tgtTbl.name, column: cand.newName });
        } else {
          const seqRes = resolveSequenceInTarget(localContext, sc.default.nextval, tgtSchemaId);
          if (!seqRes) {
            ctx.report.notes.push({ code: 'defaultCleared', table: tgtTbl.name, column: cand.newName });
          } else {
            mappedDefault = { nextval: seqRes.newSeqId };
            if (seqRes.isOwnedByCopiedCol && seqRes.srcOwnerColId === sc.id) {
              ownedSeqToBind = seqRes.newSeqId;
            }
          }
        }
      } else {
        let defExpr = renameManyInExpr(ctx.target.dialect, sc.default.expr, colRenameMap);
        defExpr = renameQualifiedManyInExpr(ctx.cb, defExpr, ctx.qualifiedEnumRenames);
        mappedDefault = { expr: defExpr };
      }
    }

    let colExt = cand.deferredExt ? cand.deferredExt.stripped : sc.ext ? clonePlain(sc.ext) : undefined;

    const mappedIdentity = sc.identity
      ? { always: sc.identity.always, options: clonePlain(sc.identity.options) }
      : null;

    // 方言附属名字（如 MSSQL 显式默认约束名的冲突后缀）；推导名在预演成功后由 commit 登记
    const preparedCol = ctx.ns.prepareItemColumn(
      {
        schemaId: tgtSchemaId,
        tableId: tgtTbl.id,
        tableName: tgtTbl.name,
        columnName: cand.newName,
        type: sc.type,
        typeRef: mappedTypeRef,
        ext: colExt,
        hasDefault: mappedDefault !== null,
        notNull: sc.notNull,
        hasIdentity: mappedIdentity !== null,
      },
      (from, to) => ctx.report.renamed.push({ kind: 'column', table: tgtTbl.name, from, to }),
    );
    colExt = preparedCol.ext;

    let mappedGenerated: { expr: string; stored: boolean } | null = null;
    if (sc.generated) {
      let genExpr = renameManyInExpr(ctx.target.dialect, sc.generated.expr, colRenameMap);
      genExpr = renameQualifiedManyInExpr(ctx.cb, genExpr, ctx.qualifiedEnumRenames);
      mappedGenerated = { expr: genExpr, stored: sc.generated.stored };
    }

    candidateOps.push({
      name: 'addColumn',
      args: {
        table: tgtTbl.id,
        column: {
          id: cand.newId,
          name: cand.newName,
          type: sc.type,
          typeRef: mappedTypeRef,
          notNull: sc.notNull || Boolean(mappedIdentity),
          default: mappedDefault,
          identity: mappedIdentity,
          generated: mappedGenerated,
          collation: sc.collation,
          ...(colExt ? { ext: colExt } : {}),
        },
      },
    });
    if (ownedSeqToBind) {
      candidateOps.push({
        name: 'setSequenceOwnedBy',
        args: { id: ownedSeqToBind, column: cand.newId },
      });
    }

    const errMsg = runScratchOps(candidateOps);
    if (errMsg !== null) {
      ctx.report.renamed.length = prevRenamedLen;
      ctx.report.notes.length = prevNotesLen;
      ctx.commentQueue.length = prevCommentLen;
      ctx.qualifiedEnumRenames.length = prevQualLen;
      for (const k of [...ctx.enumResolutionCache.keys()]) {
        if (!prevEnumCacheKeys.has(k)) ctx.enumResolutionCache.delete(k);
      }
      for (const k of [...ctx.seqResolutionCache.keys()]) {
        if (!prevSeqCacheKeys.has(k)) ctx.seqResolutionCache.delete(k);
      }
      colRenameMap.delete(sc.name);
      ctx.ns.removeColumn(tgtTbl.id, cand.newName);
      ctx.report.skipped.push({
        kind: 'column',
        name: sc.name,
        table: tgtTbl.name,
        reason: 'unsupported',
        detail: errMsg,
      });
      continue;
    }

    // 提交该列及 scratch 上产生的推导名（PG notNullName / seqName，MSSQL derived defaultName）
    ctx.ops.push(...candidateOps);
    newItems.push(cand.newId);
    pastedColBySrcId.set(sc.id, { id: cand.newId, name: cand.newName });
    if (cand.renamed) {
      ctx.report.renamed.push({
        kind: 'column',
        table: tgtTbl.name,
        from: sc.name,
        to: cand.newName,
      });
    }
    const createdCol = scratch.objects[cand.newId];
    preparedCol.commit(createdCol?.kind === 'column' ? createdCol : undefined);
    if (cand.deferredExt && sc.ext) {
      pendingDeferredExt = { colId: cand.newId, srcColId: sc.id, ext: clonePlain(sc.ext) };
    }
    if (sc.comment !== null) {
      ctx.commentQueue.push({ id: cand.newId, comment: sc.comment });
    }
  }

  // 批后允许的全部列名（用于 CHECK / INDEX 表达式引用校验）
  const postBatchCols = columnsOf(scratch, tgtTbl.id);
  const postBatchAllowedNames = new Set(postBatchCols.map((c) => normIdent(ctx.cb, c.name)));

  const resolveItemColumns = (
    srcColIds: readonly string[],
  ): { mapped: string[] | null; missing: string[] } => {
    const mapped: string[] = [];
    const missing: string[] = [];
    for (const srcColId of srcColIds) {
      const pasted = pastedColBySrcId.get(srcColId);
      if (pasted) {
        mapped.push(pasted.id);
        continue;
      }
      const srcCol = ctx.frag[srcColId];
      if (srcCol?.kind !== 'column') {
        missing.push(srcColId);
        continue;
      }
      const existing = existingColByNormName.get(normIdent(ctx.cb, srcCol.name));
      if (!existing) {
        missing.push(srcCol.name);
        continue;
      }
      mapped.push(existing.id);
    }
    return { mapped: missing.length === 0 ? mapped : null, missing };
  };

  // 第 3 趟：约束与索引项逐个预演
  for (const item of srcKeyItems) {
    if (item.kind === 'primaryKey') {
      if (hasTargetPk) {
        ctx.report.skipped.push({
          kind: 'primaryKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'targetHasPrimaryKey',
          detail: null,
        });
        continue;
      }
      const { mapped, missing } = resolveItemColumns(item.columns);
      if (!mapped) {
        ctx.report.skipped.push({
          kind: 'primaryKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'missingColumns',
          detail: [...new Set(missing)].join(', '),
        });
        continue;
      }
      const keyViolation = ctx.cb.checkKeyItem ? ctx.cb.checkKeyItem(scratch, tgtTbl.id, item) : null;
      if (keyViolation !== null) {
        ctx.report.skipped.push({
          kind: 'primaryKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: keyViolation,
        });
        continue;
      }

      const newPkId = ctx.allocId();
      const candidateOps: PasteOp[] = [
        {
          name: 'addPrimaryKey',
          args: {
            id: newPkId,
            table: tgtTbl.id,
            columns: mapped,
            ...(item.ext ? { ext: clonePlain(item.ext) } : {}),
          },
        },
      ];
      let renamedInfo: PasteRename | null = null;
      let explicitName: string | null = null;
      if (item.nameMode === 'explicit' && ctx.cb.explicitPrimaryKeyNames) {
        explicitName = ctx.ns.allocateName(item.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(tgtSchemaId, tgtTbl.id, 'primaryKey', n),
        );
        if (explicitName !== item.name) {
          renamedInfo = { kind: 'primaryKey', table: tgtTbl.name, from: item.name, to: explicitName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newPkId, name: explicitName } });
      }
      if (pendingDeferredExt && mapped.length === 1 && mapped[0] === pendingDeferredExt.colId) {
        candidateOps.push({
          name: 'setColumnExt',
          args: { id: pendingDeferredExt.colId, ext: pendingDeferredExt.ext },
        });
      }

      const errMsg = runScratchOps(candidateOps);
      if (errMsg !== null) {
        ctx.report.skipped.push({
          kind: 'primaryKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: errMsg,
        });
        continue;
      }
      hasTargetPk = true;
      ctx.ops.push(...candidateOps);
      newItems.push(newPkId);
      const createdPk = scratch.objects[newPkId];
      if (createdPk?.kind === 'primaryKey') {
        ctx.ns.addKey(tgtSchemaId, tgtTbl.id, 'primaryKey', createdPk.name);
      }
      if (renamedInfo) ctx.report.renamed.push(renamedInfo);
      if (item.comment !== null) ctx.commentQueue.push({ id: newPkId, comment: item.comment });
      continue;
    }

    if (item.kind === 'unique') {
      const { mapped, missing } = resolveItemColumns(item.columns);
      if (!mapped) {
        ctx.report.skipped.push({
          kind: 'unique',
          name: item.name,
          table: tgtTbl.name,
          reason: 'missingColumns',
          detail: [...new Set(missing)].join(', '),
        });
        continue;
      }
      const isDup = childrenOf(scratch, tgtTbl.id, 'unique').some(
        (u) => deepEqual(u.columns, mapped) && u.nullsNotDistinct === item.nullsNotDistinct,
      );
      if (isDup) {
        ctx.report.skipped.push({
          kind: 'unique',
          name: item.name,
          table: tgtTbl.name,
          reason: 'duplicate',
          detail: null,
        });
        continue;
      }
      const keyViolation = ctx.cb.checkKeyItem ? ctx.cb.checkKeyItem(scratch, tgtTbl.id, item) : null;
      if (keyViolation !== null) {
        ctx.report.skipped.push({
          kind: 'unique',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: keyViolation,
        });
        continue;
      }

      const newUid = ctx.allocId();
      const candidateOps: PasteOp[] = [
        {
          name: 'addUnique',
          args: {
            id: newUid,
            table: tgtTbl.id,
            columns: mapped,
            nullsNotDistinct: item.nullsNotDistinct,
            ...(item.ext ? { ext: clonePlain(item.ext) } : {}),
          },
        },
      ];
      let renamedInfo: PasteRename | null = null;
      if (item.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(item.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(tgtSchemaId, tgtTbl.id, 'unique', n),
        );
        if (newName !== item.name) {
          renamedInfo = { kind: 'unique', table: tgtTbl.name, from: item.name, to: newName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newUid, name: newName } });
      }
      const errMsg = runScratchOps(candidateOps);
      if (errMsg !== null) {
        ctx.report.skipped.push({
          kind: 'unique',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: errMsg,
        });
        continue;
      }
      ctx.ops.push(...candidateOps);
      newItems.push(newUid);
      const createdU = scratch.objects[newUid];
      if (createdU?.kind === 'unique') {
        ctx.ns.addKey(tgtSchemaId, tgtTbl.id, 'unique', createdU.name);
      }
      if (renamedInfo) ctx.report.renamed.push(renamedInfo);
      if (item.comment !== null) ctx.commentQueue.push({ id: newUid, comment: item.comment });
      continue;
    }

    if (item.kind === 'check') {
      let expr = renameManyInExpr(ctx.target.dialect, item.expr, colRenameMap);
      expr = renameQualifiedManyInExpr(ctx.cb, expr, ctx.qualifiedEnumRenames);
      const unknown = findUnknownExprColumns(ctx.d, expr, postBatchAllowedNames);
      if (unknown.length > 0) {
        ctx.report.skipped.push({
          kind: 'check',
          name: item.name,
          table: tgtTbl.name,
          reason: 'invalidExpr',
          detail: unknown.join(', '),
        });
        continue;
      }
      const normNewExpr = normExprText(expr);
      const isDup = childrenOf(scratch, tgtTbl.id, 'check').some(
        (ck) => normExprText(ck.expr) === normNewExpr && ck.noInherit === item.noInherit,
      );
      if (isDup) {
        ctx.report.skipped.push({
          kind: 'check',
          name: item.name,
          table: tgtTbl.name,
          reason: 'duplicate',
          detail: null,
        });
        continue;
      }

      const newCkId = ctx.allocId();
      const candidateOps: PasteOp[] = [
        { name: 'addCheck', args: { id: newCkId, table: tgtTbl.id, expr, noInherit: item.noInherit } },
      ];
      let renamedInfo: PasteRename | null = null;
      if (item.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(item.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(tgtSchemaId, tgtTbl.id, 'check', n),
        );
        if (newName !== item.name) {
          renamedInfo = { kind: 'check', table: tgtTbl.name, from: item.name, to: newName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newCkId, name: newName } });
      }
      const errMsg = runScratchOps(candidateOps);
      if (errMsg !== null) {
        ctx.report.skipped.push({
          kind: 'check',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: errMsg,
        });
        continue;
      }
      ctx.ops.push(...candidateOps);
      newItems.push(newCkId);
      const createdCk = scratch.objects[newCkId];
      if (createdCk?.kind === 'check') {
        ctx.ns.addKey(tgtSchemaId, tgtTbl.id, 'check', createdCk.name);
      }
      if (renamedInfo) ctx.report.renamed.push(renamedInfo);
      if (item.comment !== null) ctx.commentQueue.push({ id: newCkId, comment: item.comment });
      continue;
    }

    if (item.kind === 'index') {
      const missingCols: string[] = [];
      let invalidElement = false;
      const mappedElements: IndexElement[] = [];
      for (const el of item.elements) {
        let mappedCol: string | null = null;
        if (el.column) {
          const res = resolveItemColumns([el.column]);
          if (!res.mapped) missingCols.push(...res.missing);
          else mappedCol = res.mapped[0]!;
        }
        let mappedElExpr = el.expr;
        if (mappedElExpr !== null) {
          mappedElExpr = renameManyInExpr(ctx.target.dialect, mappedElExpr, colRenameMap);
          mappedElExpr = renameQualifiedManyInExpr(ctx.cb, mappedElExpr, ctx.qualifiedEnumRenames);
        }
        if (!isValidIndexElement({ column: el.column, expr: mappedElExpr })) invalidElement = true;
        mappedElements.push({
          column: mappedCol,
          expr: mappedElExpr,
          desc: el.desc,
          nullsFirst: el.nullsFirst,
          opclass: el.opclass,
          collation: el.collation,
        });
      }
      const incRes = resolveItemColumns(item.include);
      if (!incRes.mapped) missingCols.push(...incRes.missing);
      if (missingCols.length > 0) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'missingColumns',
          detail: [...new Set(missingCols)].join(', '),
        });
        continue;
      }
      if (invalidElement || mappedElements.length === 0) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: null,
        });
        continue;
      }

      const unknownExprCols: string[] = [];
      for (const el of mappedElements) {
        if (el.expr !== null) {
          unknownExprCols.push(...findUnknownExprColumns(ctx.d, el.expr, postBatchAllowedNames));
        }
      }
      let mappedWhere = item.where;
      if (mappedWhere !== null) {
        mappedWhere = renameManyInExpr(ctx.target.dialect, mappedWhere, colRenameMap);
        mappedWhere = renameQualifiedManyInExpr(ctx.cb, mappedWhere, ctx.qualifiedEnumRenames);
        unknownExprCols.push(...findUnknownExprColumns(ctx.d, mappedWhere, postBatchAllowedNames));
      }
      if (unknownExprCols.length > 0) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'invalidExpr',
          detail: [...new Set(unknownExprCols)].join(', '),
        });
        continue;
      }

      const indexVariant = (ix: Index): unknown =>
        ctx.cb.indexVariant ? ctx.cb.indexVariant(ix) : undefined;
      const normEls = (els: readonly IndexElement[]) =>
        els.map((e) => ({ ...e, expr: normExprText(e.expr) }));
      const isDup = childrenOf(scratch, tgtTbl.id, 'index').some(
        (ix) =>
          ix.unique === item.unique &&
          ix.method.toLowerCase() === item.method.toLowerCase() &&
          normExprText(ix.where) === normExprText(mappedWhere) &&
          ix.nullsNotDistinct === item.nullsNotDistinct &&
          deepEqual(ix.include, incRes.mapped!) &&
          deepEqual(normEls(ix.elements), normEls(mappedElements)) &&
          deepEqual(indexVariant(ix), indexVariant(item)),
      );
      if (isDup) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'duplicate',
          detail: null,
        });
        continue;
      }

      const keyViolation = ctx.cb.checkKeyItem ? ctx.cb.checkKeyItem(scratch, tgtTbl.id, item) : null;
      if (keyViolation !== null) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: keyViolation,
        });
        continue;
      }

      const newIxId = ctx.allocId();
      const candidateOps: PasteOp[] = [
        {
          name: 'addIndex',
          args: {
            id: newIxId,
            table: tgtTbl.id,
            elements: mappedElements,
            unique: item.unique,
            method: item.method,
            include: incRes.mapped!,
            where: mappedWhere,
            nullsNotDistinct: item.nullsNotDistinct,
            ...(item.ext ? { ext: clonePlain(item.ext) } : {}),
          },
        },
      ];
      let renamedInfo: PasteRename | null = null;
      if (item.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(item.name, 'index', (n) =>
          ctx.ns.isIndexTaken(tgtSchemaId, tgtTbl.id, n),
        );
        if (newName !== item.name) {
          renamedInfo = { kind: 'index', table: tgtTbl.name, from: item.name, to: newName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newIxId, name: newName } });
      }
      const errMsg = runScratchOps(candidateOps);
      if (errMsg !== null) {
        ctx.report.skipped.push({
          kind: 'index',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: errMsg,
        });
        continue;
      }
      ctx.ops.push(...candidateOps);
      newItems.push(newIxId);
      const createdIx = scratch.objects[newIxId];
      if (createdIx?.kind === 'index') {
        ctx.ns.addIndex(tgtSchemaId, tgtTbl.id, createdIx.name);
      }
      if (renamedInfo) ctx.report.renamed.push(renamedInfo);
      if (item.comment !== null) ctx.commentQueue.push({ id: newIxId, comment: item.comment });
      continue;
    }

    if (item.kind === 'foreignKey') {
      const { mapped, missing } = resolveItemColumns(item.columns);
      if (!mapped) {
        ctx.report.skipped.push({
          kind: 'foreignKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'missingColumns',
          detail: [...new Set(missing)].join(', '),
        });
        continue;
      }

      let refTable: string;
      let refColumns: string[];
      if (item.refTable === srcTbl.id || item.refTable === srcRootId) {
        refTable = tgtTbl.id;
        const refRes = resolveItemColumns(item.refColumns);
        if (!refRes.mapped) {
          ctx.report.skipped.push({
            kind: 'foreignKey',
            name: item.name,
            table: tgtTbl.name,
            reason: 'missingColumns',
            detail: [...new Set(refRes.missing)].join(', '),
          });
          continue;
        }
        refColumns = refRes.mapped;
      } else {
        const reconnected = reconnectExternalFk(ctx, item, tgtTbl.name);
        if (!reconnected) continue;
        refTable = reconnected.refTable;
        refColumns = reconnected.refColumns;
      }

      const isDup = childrenOf(scratch, tgtTbl.id, 'foreignKey').some(
        (fk) =>
          deepEqual(fk.columns, mapped) && fk.refTable === refTable && deepEqual(fk.refColumns, refColumns),
      );
      if (isDup) {
        ctx.report.skipped.push({
          kind: 'foreignKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'duplicate',
          detail: null,
        });
        continue;
      }

      const newFkId = ctx.allocId();
      const candidateOps: PasteOp[] = [
        {
          name: 'addForeignKey',
          args: {
            id: newFkId,
            table: tgtTbl.id,
            columns: mapped,
            refTable,
            refColumns,
            onDelete: item.onDelete,
            onUpdate: item.onUpdate,
            match: item.match,
            deferrable: item.deferrable,
            initiallyDeferred: item.initiallyDeferred,
          },
        },
      ];
      let renamedInfo: PasteRename | null = null;
      if (item.nameMode === 'explicit') {
        const newName = ctx.ns.allocateName(item.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(tgtSchemaId, tgtTbl.id, 'foreignKey', n),
        );
        if (newName !== item.name) {
          renamedInfo = { kind: 'foreignKey', table: tgtTbl.name, from: item.name, to: newName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newFkId, name: newName } });
      }
      const errMsg = runScratchOps(candidateOps);
      if (errMsg !== null) {
        ctx.report.skipped.push({
          kind: 'foreignKey',
          name: item.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: errMsg,
        });
        continue;
      }
      ctx.ops.push(...candidateOps);
      newItems.push(newFkId);
      const createdFk = scratch.objects[newFkId];
      if (createdFk?.kind === 'foreignKey') {
        ctx.ns.addKey(tgtSchemaId, tgtTbl.id, 'foreignKey', createdFk.name);
      }
      if (renamedInfo) ctx.report.renamed.push(renamedInfo);
      if (item.comment !== null) ctx.commentQueue.push({ id: newFkId, comment: item.comment });
    }
  }

  for (const c of ctx.commentQueue) {
    ctx.ops.push({ name: 'setComment', args: { id: c.id, comment: c.comment } });
  }

  if (ctx.ops.length > MAX_PASTE_OPS) {
    throw new PasteError('too_many_ops', { ops: ctx.ops.length, max: MAX_PASTE_OPS });
  }

  return {
    ops: ctx.ops,
    tableMap: {},
    newTables: [],
    newItems,
    targetTable: tgtTbl.id,
    report: ctx.report,
  };
};

// ───── 粘贴计划编译主入口 ─────

/** 把载荷编译成在 target 上执行的粘贴计划；方言不同抛 PasteError('dialect_mismatch') */
export const planPaste = (target: Model, payload: ClipboardPayload, opts: PasteOptions = {}): PastePlan => {
  if (payload.dialect !== target.dialect) {
    throw new PasteError('dialect_mismatch', { from: payload.dialect, to: target.dialect });
  }

  if (payload.kind === 'tables' && payload.tables.length === 0) {
    throw new PasteError('nothing_to_paste');
  }

  let tgtTbl: Table | null = null;
  if (payload.kind === 'items') {
    if (!opts.targetTable) {
      throw new PasteError('no_target');
    }
    const o = target.objects[opts.targetTable];
    if (!o || o.kind !== 'table') {
      throw new PasteError('target_not_table', { target: opts.targetTable });
    }
    if (o.partitionOf !== null) {
      throw new PasteError('target_is_partition', { table: o.name });
    }
    tgtTbl = o;
  }

  const rawNewId = opts.newId ?? newId;
  const allocatedIds = new Set<string>();
  const allocId = (): string => {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const candidate = rawNewId();
      if (
        !(candidate in target.objects) &&
        !(candidate in payload.fragment) &&
        !allocatedIds.has(candidate)
      ) {
        allocatedIds.add(candidate);
        return candidate;
      }
    }
    throw new PasteError('too_many_ops', { reason: '无法分配唯一对象 ID' });
  };

  const frag = payload.fragment as Record<string, Obj>;
  const fragModel: Model = { format: 1, dialect: payload.dialect, objects: frag };
  const d = getDialect(target.dialect);

  return withModelIndex(target, (targetIdx) =>
    withModelIndex(fragModel, (fragIdx) => {
      const ctx: PasteContext = {
        target,
        targetIdx,
        frag,
        fragModel,
        fragIdx,
        d,
        cb: d.clipboard,
        ns: d.clipboard.createNamespace(target, targetIdx, d),
        allocId,
        ops: [],
        report: { renamed: [], skipped: [], notes: [] },
        commentQueue: [],
        enumResolutionCache: new Map(),
        qualifiedEnumRenames: [],
        seqResolutionCache: new Map(),
        copiedColIds: new Set(),
      };

      if (payload.kind === 'tables') {
        return planTablesPaste(ctx, payload);
      }
      return planItemsPaste(ctx, payload, tgtTbl!);
    }),
  );
};
