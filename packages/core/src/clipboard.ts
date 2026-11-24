// 画布复制粘贴（ADR 0013 第 2 节）：剪贴板载荷、复制提取与粘贴计划编译。纯函数、无 I/O，前后端共用。
// 粘贴计划编译成一组普通 mutator 调用，经单个原子 mutator `paste` 提交（见 mutators.ts），
// 因此沿用全部方言校验、乐观冲突、只读拒绝与画布历史（一次粘贴 = 一条历史记录）。
import { z } from 'zod';

import type { IdentKind } from './dialect.ts';
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
  type Model,
  type Obj,
  Opaque,
  type PartitionKey,
  type PartitionSpec,
  PrimaryKey,
  Schema,
  Sequence,
  Table,
  type TableExt,
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
import { mssqlChooseName, mssqlJoinNames } from './mssql/naming.ts';
import { isMssqlPkClustered, mssqlDefaultNameOf } from './mssql/plan.ts';
import { isMssqlIdentityEligibleType } from './mssql/types.ts';
import { runMutator } from './mutators.ts';
import { mysqlChooseName, mysqlJoinNames } from './mysql/naming.ts';
import { isMysqlAutoIncrementType, splitMysqlTypeModifiers } from './mysql/types.ts';
import { chooseName, joinNames } from './pg/naming.ts';
import { resolvePartitionBy } from './pg/partition.ts';
import { ident as pgQuoteIdent } from './pg/quote.ts';
import { getDialect } from './registry.ts';
import { sqliteChooseName, sqliteJoinNames } from './sqlite/naming.ts';
import { SQLITE_STRICT_TYPES } from './sqlite/types.ts';

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

const textEncoder = new TextEncoder();

const utf8ByteLen = (s: string): number => textEncoder.encode(s).length;

const isCaseInsensitiveDialect = (dialect: Dialect): boolean =>
  dialect === 'sqlite' || dialect === 'mysql' || dialect === 'mssql';

const normIdent = (dialect: Dialect, name: string): string =>
  isCaseInsensitiveDialect(dialect) ? name.toLowerCase() : name;

const stripCopySuffix = (name: string): string => name.replace(/_copy\d*$/, '');

const clipByUnit = (s: string, maxLen: number, unit: 'bytes' | 'chars'): string => {
  if (maxLen <= 0) return '';
  if (unit === 'chars') return Array.from(s).slice(0, maxLen).join('');
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const chBytes = utf8ByteLen(ch);
    if (bytes + chBytes > maxLen) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
};

const identUnitLen = (s: string, unit: 'bytes' | 'chars'): number =>
  unit === 'bytes' ? utf8ByteLen(s) : Array.from(s).length;

/** 清理对象的空方言扩展槽位，避免向 mutator 传入空对象 */
const cleanExt = <T extends Record<string, unknown>>(ext: T | null | undefined): T | undefined => {
  if (!ext) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ext)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, iv]) => iv !== undefined),
      );
      if (Object.keys(inner).length > 0) out[k] = inner;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
};

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
  const ci = isCaseInsensitiveDialect(dialect);
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

/** 单趟改写 PG 表达式里的限定枚举名 `schema.enum` */
const renameQualifiedManyInExpr = (
  dialect: Dialect,
  expr: string,
  renames: readonly { fromSchema: string; fromName: string; toSchema: string; toName: string }[],
): string => {
  if (dialect !== 'pg' || renames.length === 0) return expr;
  const effective = renames.filter((r) => r.fromSchema !== r.toSchema || r.fromName !== r.toName);
  if (effective.length === 0) return expr;
  const d = getDialect(dialect);
  const tokens = d.tokenize(expr);
  const bySchema = new Map<string, Map<string, { toSchema: string; toName: string }>>();
  for (const r of effective) {
    let inner = bySchema.get(r.fromSchema);
    if (!inner) {
      inner = new Map();
      bySchema.set(r.fromSchema, inner);
    }
    inner.set(r.fromName, { toSchema: r.toSchema, toName: r.toName });
  }
  let out = expr;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t0 = tokens[i];
    if (!t0 || (t0.kind !== 'ident' && t0.kind !== 'qident')) continue;
    if (tokens[i + 1]?.text !== '.') continue;
    const t2 = tokens[i + 2];
    if (!t2 || (t2.kind !== 'ident' && t2.kind !== 'qident')) continue;
    const target = bySchema.get(t0.text)?.get(t2.text);
    if (!target) continue;
    out = `${out.slice(0, t0.start)}${pgQuoteIdent(target.toSchema)}.${pgQuoteIdent(target.toName)}${out.slice(t2.end)}`;
  }
  return out;
};

const findUnknownExprColumns = (
  dialect: Dialect,
  expr: string,
  allowedNormNames: ReadonlySet<string>,
): string[] => {
  const d = getDialect(dialect);
  const ci = isCaseInsensitiveDialect(dialect);
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
 * format 相符但版本不认识抛 ClipboardError('unsupported_version')，结构不合法抛 ClipboardError('invalid_payload')。
 */
export const parseClipboard = (text: string): ClipboardPayload | null => {
  if (typeof text !== 'string') return null;
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

  if (data.kind === 'tables') {
    if (data.table !== null || data.items.length > 0) {
      throw new ClipboardError('invalid_payload');
    }
    for (const tid of data.tables) {
      const t = frag[tid];
      if (!t || t.kind !== 'table') {
        throw new ClipboardError('invalid_payload');
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
    for (const iid of data.items) {
      const it = frag[iid];
      if (!it || !VALID_ITEM_KINDS.has(it.kind)) {
        throw new ClipboardError('invalid_payload');
      }
    }
  }

  for (const eid of data.external) {
    const extTbl = frag[eid];
    if (!extTbl || extTbl.kind !== 'table') {
      throw new ClipboardError('invalid_payload');
    }
  }

  return data;
};

// ───── 命名空间跟踪与后缀分配 ─────

const addToSetMap = (map: Map<string, Set<string>>, container: string, name: string) => {
  let set = map.get(container);
  if (!set) {
    set = new Set();
    map.set(container, set);
  }
  set.add(name);
};

const delFromSetMap = (map: Map<string, Set<string>>, container: string, name: string) => {
  const set = map.get(container);
  if (!set) return;
  set.delete(name);
  if (set.size === 0) map.delete(container);
};

const hasInSetMap = (map: Map<string, Set<string>>, container: string, name: string): boolean =>
  map.get(container)?.has(name) ?? false;

/**
 * 跟踪目标模型与本次粘贴已占用的全部标识符命名空间（按各方言精确规则）。
 * - PG：按 schema / table 的 rel / type / con / col，依赖 targetIdx 进行 O(1) 查询 + 本地新建集合。
 * - SQLite / MySQL / MSSQL：在构造时单趟扫描 target.objects 构建哈希集，所有冲突判定均 O(1)。
 */
class NamespaceTracker {
  private readonly dialect: Dialect;
  private readonly target: Model;
  private readonly targetIdx: ModelIndex;

  private readonly colsByTable = new Map<string, Set<string>>();

  // PG
  private readonly pgRel = new Map<string, Set<string>>();
  private readonly pgType = new Map<string, Set<string>>();
  private readonly pgCon = new Map<string, Set<string>>();
  private readonly pgPropCon = new Map<string, Set<string>>();

  // SQLite
  private readonly sqliteRel = new Set<string>();
  private readonly sqliteCon = new Map<string, Set<string>>();

  // MySQL
  private readonly mysqlRel = new Set<string>();
  private readonly mysqlSchemaCon = new Set<string>();
  private readonly mysqlIdx = new Map<string, Set<string>>();

  // MSSQL
  private readonly mssqlObj = new Map<string, Set<string>>();
  private readonly mssqlIdx = new Map<string, Set<string>>();

  constructor(target: Model, targetIdx: ModelIndex) {
    this.dialect = target.dialect;
    this.target = target;
    this.targetIdx = targetIdx;

    if (this.dialect === 'sqlite') {
      for (const o of Object.values(target.objects)) {
        const low = o.name.toLowerCase();
        if (o.kind === 'table' || o.kind === 'index' || o.kind === 'opaque') {
          this.sqliteRel.add(low);
        } else if (
          o.kind === 'primaryKey' ||
          o.kind === 'unique' ||
          o.kind === 'check' ||
          o.kind === 'foreignKey'
        ) {
          addToSetMap(this.sqliteCon, o.parent, low);
        }
      }
    } else if (this.dialect === 'mysql') {
      for (const o of Object.values(target.objects)) {
        const low = o.name.toLowerCase();
        if (o.kind === 'table' || (o.kind === 'opaque' && o.objType === 'view')) {
          this.mysqlRel.add(low);
        } else if (o.kind === 'unique' || o.kind === 'index') {
          addToSetMap(this.mysqlIdx, o.parent, low);
        } else if (o.kind === 'foreignKey') {
          this.mysqlSchemaCon.add(low);
          addToSetMap(this.mysqlIdx, o.parent, low);
        } else if (o.kind === 'check') {
          this.mysqlSchemaCon.add(low);
        }
      }
    } else if (this.dialect === 'mssql') {
      const tableSchema = new Map<string, string>();
      const tableName = new Map<string, string>();
      for (const t of targetIdx.allRef('table')) {
        tableSchema.set(t.id, t.parent);
        tableName.set(t.id, t.name);
      }
      for (const o of Object.values(target.objects)) {
        const low = o.name.toLowerCase();
        if (o.kind === 'table' || o.kind === 'sequence') {
          addToSetMap(this.mssqlObj, o.parent, low);
        } else if (o.kind === 'primaryKey' || o.kind === 'unique') {
          const sch = tableSchema.get(o.parent);
          if (sch) addToSetMap(this.mssqlObj, sch, low);
          addToSetMap(this.mssqlIdx, o.parent, low);
        } else if (o.kind === 'foreignKey' || o.kind === 'check') {
          const sch = tableSchema.get(o.parent);
          if (sch) addToSetMap(this.mssqlObj, sch, low);
        } else if (o.kind === 'index') {
          addToSetMap(this.mssqlIdx, o.parent, low);
        } else if (o.kind === 'column' && o.default) {
          const sch = tableSchema.get(o.parent);
          const tname = tableName.get(o.parent);
          if (sch && tname) {
            const df = mssqlDefaultNameOf(o, tname);
            addToSetMap(this.mssqlObj, sch, df.toLowerCase());
          }
        } else if (o.kind === 'opaque') {
          const sch = tableSchema.has(o.parent) ? tableSchema.get(o.parent) : o.parent;
          if (sch) addToSetMap(this.mssqlObj, sch, low);
        }
      }
    }
  }

  /** 为现有表预载列名（items 模式使用） */
  initTableColumns(tableId: string) {
    for (const c of effectiveColumnsOf(this.target, tableId)) {
      addToSetMap(this.colsByTable, tableId, normIdent(this.dialect, c.name));
    }
  }

  isColTaken(tableId: string, name: string): boolean {
    return hasInSetMap(this.colsByTable, tableId, normIdent(this.dialect, name));
  }

  addColumn(tableId: string, name: string) {
    addToSetMap(this.colsByTable, tableId, normIdent(this.dialect, name));
  }

  removeColumn(tableId: string, name: string) {
    delFromSetMap(this.colsByTable, tableId, normIdent(this.dialect, name));
  }

  isTableTaken(schemaId: string, name: string): boolean {
    if (this.dialect === 'pg') {
      return (
        hasInSetMap(this.pgRel, schemaId, name) ||
        hasInSetMap(this.pgType, schemaId, name) ||
        this.targetIdx.isPgRelTaken(schemaId, name, '') ||
        this.targetIdx.isPgTypeTaken(schemaId, name, '')
      );
    }
    if (this.dialect === 'sqlite') return this.sqliteRel.has(name.toLowerCase());
    if (this.dialect === 'mysql') return this.mysqlRel.has(name.toLowerCase());
    return hasInSetMap(this.mssqlObj, schemaId, name.toLowerCase());
  }

  addTable(schemaId: string, name: string) {
    if (this.dialect === 'pg') {
      addToSetMap(this.pgRel, schemaId, name);
      addToSetMap(this.pgType, schemaId, name);
    } else if (this.dialect === 'sqlite') {
      this.sqliteRel.add(name.toLowerCase());
    } else if (this.dialect === 'mysql') {
      this.mysqlRel.add(name.toLowerCase());
    } else {
      addToSetMap(this.mssqlObj, schemaId, name.toLowerCase());
    }
  }

  isEnumTaken(schemaId: string, name: string): boolean {
    if (this.dialect !== 'pg') return false;
    return hasInSetMap(this.pgType, schemaId, name) || this.targetIdx.isPgTypeTaken(schemaId, name, '');
  }

  addEnum(schemaId: string, name: string) {
    if (this.dialect === 'pg') addToSetMap(this.pgType, schemaId, name);
  }

  isSequenceTaken(schemaId: string, name: string): boolean {
    if (this.dialect === 'pg') {
      return hasInSetMap(this.pgRel, schemaId, name) || this.targetIdx.isPgRelTaken(schemaId, name, '');
    }
    if (this.dialect === 'mssql') {
      return hasInSetMap(this.mssqlObj, schemaId, name.toLowerCase());
    }
    return false;
  }

  addSequence(schemaId: string, name: string) {
    if (this.dialect === 'pg') addToSetMap(this.pgRel, schemaId, name);
    else if (this.dialect === 'mssql') addToSetMap(this.mssqlObj, schemaId, name.toLowerCase());
  }

  isPgRelTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.pgRel, schemaId, name) || this.targetIdx.isPgRelTaken(schemaId, name, '');
  }

  addPgRel(schemaId: string, name: string) {
    addToSetMap(this.pgRel, schemaId, name);
  }

  isPgConTaken(tableId: string, name: string, propagates: boolean): boolean {
    if (hasInSetMap(this.pgCon, tableId, name)) return true;
    if (propagates) {
      return this.targetIdx.isPgConTaken(tableId, name, '');
    }
    // 非继承约束（PK / UNIQUE）仅检查本表约束、本表列 NOT NULL 及祖先下传的 CHECK / FK / NOT NULL
    for (const o of this.targetIdx.allChildrenOf(tableId)) {
      if (o.kind === 'column') {
        if (o.notNull && o.notNullName === name) return true;
      } else if (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.name === name
      ) {
        return true;
      }
    }
    if (tableId in this.target.objects) {
      for (const anc of partitionAncestors(this.target, tableId)) {
        for (const c of this.targetIdx.childrenRef(anc.id, 'column')) {
          if (c.notNull && c.notNullName === name) return true;
        }
        for (const ck of this.targetIdx.childrenRef(anc.id, 'check')) {
          if (ck.name === name) return true;
        }
        for (const fk of this.targetIdx.childrenRef(anc.id, 'foreignKey')) {
          if (fk.name === name) return true;
        }
      }
    }
    return false;
  }

  addPgNotNull(tableId: string, name: string) {
    addToSetMap(this.pgCon, tableId, name);
    addToSetMap(this.pgPropCon, tableId, name);
  }

  isMssqlDefaultTaken(schemaId: string, name: string): boolean {
    return hasInSetMap(this.mssqlObj, schemaId, name.toLowerCase());
  }

  addMssqlDefault(schemaId: string, name: string) {
    addToSetMap(this.mssqlObj, schemaId, name.toLowerCase());
  }

  isIndexTaken(schemaId: string, tableId: string, name: string): boolean {
    if (this.dialect === 'pg') {
      return this.isPgRelTaken(schemaId, name);
    }
    if (this.dialect === 'sqlite') {
      return this.sqliteRel.has(name.toLowerCase());
    }
    if (this.dialect === 'mysql') {
      const low = name.toLowerCase();
      return low === 'primary' || hasInSetMap(this.mysqlIdx, tableId, low);
    }
    const low = name.toLowerCase();
    return hasInSetMap(this.mssqlObj, schemaId, low) || hasInSetMap(this.mssqlIdx, tableId, low);
  }

  addIndex(schemaId: string, tableId: string, name: string) {
    if (this.dialect === 'pg') {
      this.addPgRel(schemaId, name);
    } else if (this.dialect === 'sqlite') {
      this.sqliteRel.add(name.toLowerCase());
    } else if (this.dialect === 'mysql') {
      addToSetMap(this.mysqlIdx, tableId, name.toLowerCase());
    } else {
      addToSetMap(this.mssqlIdx, tableId, name.toLowerCase());
    }
  }

  isKeyTaken(
    schemaId: string,
    tableId: string,
    kind: 'primaryKey' | 'unique' | 'check' | 'foreignKey',
    name: string,
    pgAncestorIds: readonly string[] = [],
  ): boolean {
    if (this.dialect === 'pg') {
      const propagates = kind === 'check' || kind === 'foreignKey';
      if (this.isPgConTaken(tableId, name, propagates)) return true;
      for (const aid of pgAncestorIds) {
        if (hasInSetMap(this.pgPropCon, aid, name)) return true;
      }
      if ((kind === 'primaryKey' || kind === 'unique') && this.isPgRelTaken(schemaId, name)) {
        return true;
      }
      return false;
    }
    if (this.dialect === 'sqlite') {
      return hasInSetMap(this.sqliteCon, tableId, name.toLowerCase());
    }
    if (this.dialect === 'mysql') {
      const low = name.toLowerCase();
      if (kind === 'primaryKey') return false;
      if (kind === 'unique') return low === 'primary' || hasInSetMap(this.mysqlIdx, tableId, low);
      if (kind === 'check') return this.mysqlSchemaCon.has(low);
      return low === 'primary' || this.mysqlSchemaCon.has(low) || hasInSetMap(this.mysqlIdx, tableId, low);
    }
    const low = name.toLowerCase();
    return hasInSetMap(this.mssqlObj, schemaId, low) || hasInSetMap(this.mssqlIdx, tableId, low);
  }

  addKey(
    schemaId: string,
    tableId: string,
    kind: 'primaryKey' | 'unique' | 'check' | 'foreignKey',
    name: string,
  ) {
    if (this.dialect === 'pg') {
      addToSetMap(this.pgCon, tableId, name);
      if (kind === 'primaryKey' || kind === 'unique') {
        addToSetMap(this.pgRel, schemaId, name);
      } else {
        addToSetMap(this.pgPropCon, tableId, name);
      }
    } else if (this.dialect === 'sqlite') {
      addToSetMap(this.sqliteCon, tableId, name.toLowerCase());
    } else if (this.dialect === 'mysql') {
      if (kind === 'primaryKey') return;
      const low = name.toLowerCase();
      if (kind === 'unique') {
        addToSetMap(this.mysqlIdx, tableId, low);
      } else if (kind === 'check') {
        this.mysqlSchemaCon.add(low);
      } else {
        this.mysqlSchemaCon.add(low);
        addToSetMap(this.mysqlIdx, tableId, low);
      }
    } else {
      const low = name.toLowerCase();
      addToSetMap(this.mssqlObj, schemaId, low);
      if (kind === 'primaryKey' || kind === 'unique') {
        addToSetMap(this.mssqlIdx, tableId, low);
      }
    }
  }

  /** 为一个新名做冲突后缀与方言长度裁剪；原名可用直接返回 */
  allocateName(original: string, identKind: IdentKind, isTaken: (candidate: string) => boolean): string {
    const d = getDialect(this.dialect);
    const { maxIdentLength, maxIdentUnit } = d.capabilities;

    if (
      identUnitLen(original, maxIdentUnit) <= maxIdentLength &&
      d.validateIdent(original, identKind) === null &&
      !isTaken(original)
    ) {
      return original;
    }

    const stripped = stripCopySuffix(original);
    let baseRoot = stripped.length > 0 ? stripped : 'c';
    // 若原始前缀触发保留字/保留前缀校验（如 sqlite_ / dowel_），前置安全前缀避免死循环
    if (d.validateIdent(`${baseRoot}_copy`, identKind) !== null) {
      baseRoot = `c_${baseRoot}`;
    }

    for (let i = 1; ; i++) {
      const suffix = i === 1 ? '_copy' : `_copy${i}`;
      const suffixLen = identUnitLen(suffix, maxIdentUnit);
      const clippedBase = clipByUnit(baseRoot, maxIdentLength - suffixLen, maxIdentUnit) || 'c';
      const candidate = `${clippedBase}${suffix}`;
      if (d.validateIdent(candidate, identKind) === null && !isTaken(candidate)) {
        return candidate;
      }
    }
  }
}

/** 模拟各方的推导名规则并预占到 NamespaceTracker（用于表粒度批量规划） */
const reserveDerivedKeyOrIndex = (
  ns: NamespaceTracker,
  dialect: Dialect,
  schemaId: string,
  tableId: string,
  tableName: string,
  obj: Obj,
  newColNameById: ReadonlyMap<string, string>,
  exprColNames: readonly string[],
) => {
  const d = getDialect(dialect);
  const colNames = (ids: string[]) => ids.map((cid) => newColNameById.get(cid) ?? '');
  const idxElNames = (ix: Pick<Index, 'elements' | 'include'>): string[] => {
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
    const refs = exprColNames.filter((cname) => d.exprReferences(expr, cname));
    return refs.length === 1 ? refs[0]! : null;
  };

  if (dialect === 'pg') {
    switch (obj.kind) {
      case 'primaryKey':
        ns.addKey(
          schemaId,
          tableId,
          'primaryKey',
          chooseName(tableName, null, 'pkey', (n) => ns.isKeyTaken(schemaId, tableId, 'primaryKey', n)),
        );
        break;
      case 'unique':
        ns.addKey(
          schemaId,
          tableId,
          'unique',
          chooseName(tableName, joinNames(colNames(obj.columns)), 'key', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        ns.addKey(
          schemaId,
          tableId,
          'foreignKey',
          chooseName(tableName, joinNames(colNames(obj.columns)), 'fkey', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        ns.addKey(
          schemaId,
          tableId,
          'check',
          chooseName(tableName, singleCheckRef(obj.expr), 'check', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        ns.addIndex(
          schemaId,
          tableId,
          chooseName(tableName, joinNames(idxElNames(obj)), 'idx', (n) =>
            ns.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
    return;
  }

  if (dialect === 'sqlite') {
    switch (obj.kind) {
      case 'primaryKey':
        ns.addKey(
          schemaId,
          tableId,
          'primaryKey',
          sqliteChooseName(tableName, null, 'pkey', (n) => ns.isKeyTaken(schemaId, tableId, 'primaryKey', n)),
        );
        break;
      case 'unique':
        ns.addKey(
          schemaId,
          tableId,
          'unique',
          sqliteChooseName(tableName, sqliteJoinNames(colNames(obj.columns)), 'key', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        ns.addKey(
          schemaId,
          tableId,
          'foreignKey',
          sqliteChooseName(tableName, sqliteJoinNames(colNames(obj.columns)), 'fkey', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        ns.addKey(
          schemaId,
          tableId,
          'check',
          sqliteChooseName(tableName, singleCheckRef(obj.expr), 'check', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        ns.addIndex(
          schemaId,
          tableId,
          sqliteChooseName(tableName, sqliteJoinNames(idxElNames(obj)), 'idx', (n) =>
            ns.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
    return;
  }

  if (dialect === 'mysql') {
    switch (obj.kind) {
      case 'primaryKey':
        break;
      case 'unique':
        ns.addKey(
          schemaId,
          tableId,
          'unique',
          mysqlChooseName(tableName, mysqlJoinNames(colNames(obj.columns)), 'key', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'unique', n),
          ),
        );
        break;
      case 'foreignKey':
        ns.addKey(
          schemaId,
          tableId,
          'foreignKey',
          mysqlChooseName(tableName, mysqlJoinNames(colNames(obj.columns)), 'fkey', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'foreignKey', n),
          ),
        );
        break;
      case 'check':
        ns.addKey(
          schemaId,
          tableId,
          'check',
          mysqlChooseName(tableName, singleCheckRef(obj.expr), 'check', (n) =>
            ns.isKeyTaken(schemaId, tableId, 'check', n),
          ),
        );
        break;
      case 'index':
        ns.addIndex(
          schemaId,
          tableId,
          mysqlChooseName(tableName, mysqlJoinNames(idxElNames(obj)), 'idx', (n) =>
            ns.isIndexTaken(schemaId, tableId, n),
          ),
        );
        break;
    }
    return;
  }

  // MSSQL
  switch (obj.kind) {
    case 'primaryKey':
      ns.addKey(
        schemaId,
        tableId,
        'primaryKey',
        mssqlChooseName('PK', tableName, null, (n) => ns.isKeyTaken(schemaId, tableId, 'primaryKey', n)),
      );
      break;
    case 'unique':
      ns.addKey(
        schemaId,
        tableId,
        'unique',
        mssqlChooseName('UQ', tableName, mssqlJoinNames(colNames(obj.columns)), (n) =>
          ns.isKeyTaken(schemaId, tableId, 'unique', n),
        ),
      );
      break;
    case 'foreignKey':
      ns.addKey(
        schemaId,
        tableId,
        'foreignKey',
        mssqlChooseName('FK', tableName, mssqlJoinNames(colNames(obj.columns)), (n) =>
          ns.isMssqlDefaultTaken(schemaId, n),
        ),
      );
      break;
    case 'check':
      ns.addKey(
        schemaId,
        tableId,
        'check',
        mssqlChooseName('CK', tableName, singleCheckRef(obj.expr), (n) =>
          ns.isMssqlDefaultTaken(schemaId, n),
        ),
      );
      break;
    case 'index':
      ns.addIndex(
        schemaId,
        tableId,
        mssqlChooseName('IX', tableName, mssqlJoinNames(idxElNames(obj)), (n) =>
          ns.isIndexTaken(schemaId, tableId, n),
        ),
      );
      break;
  }
};

// ───── 计划编译公共上下文与外部外键重连 ─────

interface PasteContext {
  target: Model;
  targetIdx: ModelIndex;
  frag: Record<string, Obj>;
  fragModel: Model;
  fragIdx: ModelIndex;
  ns: NamespaceTracker;
  allocId: () => string;
  ops: PasteOp[];
  report: PasteReport;
  commentQueue: { id: string; comment: string }[];
  enumResolutionCache: Map<string, { id: string; name: string; schemaName: string }>;
  qualifiedEnumRenames: { fromSchema: string; fromName: string; toSchema: string; toName: string }[];
  seqResolutionCache: Map<string, string>;
  copiedColIds: Set<string>;
}

const findExactSchemaInTarget = (target: Model, targetIdx: ModelIndex, name: string): Schema | undefined => {
  const cap = getDialect(target.dialect).capabilities;
  if (!cap.schemas) {
    return targetIdx.allRef('schema')[0];
  }
  const ci = target.dialect === 'mssql';
  return targetIdx
    .allRef('schema')
    .find((s) => (ci ? s.name.toLowerCase() === name.toLowerCase() : s.name === name));
};

const defaultTargetSchema = (target: Model, targetIdx: ModelIndex): Schema => {
  const cap = getDialect(target.dialect).capabilities;
  const schemas = targetIdx.allRef('schema');
  const ci = target.dialect === 'mssql';
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
    const ci = ctx.target.dialect === 'mssql';
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

const columnTypeLabel = (dialect: Dialect, col: Column, lookupObjects: Record<string, Obj>): string => {
  if (col.typeRef) {
    const en = lookupObjects[col.typeRef];
    const enumName = en?.kind === 'enum' ? en.name : '?';
    return `${enumName}${col.type.trim().replace(/\s+/g, '')}`;
  }
  const d = getDialect(dialect);
  if (dialect === 'mysql') {
    const split = splitMysqlTypeModifiers(col.type);
    const unsigned = Boolean(col.ext?.mysql?.unsigned || split.unsigned || col.ext?.mysql?.zerofill);
    return `${split.baseType}${unsigned ? ' unsigned' : ''}`.trim().replace(/\s+/g, ' ').toLowerCase();
  }
  return d.normalizeType(col.type).trim().replace(/\s+/g, ' ').toLowerCase();
};

const sameColumnSet = (actual: readonly string[], expectedSet: ReadonlySet<string>): boolean =>
  actual.length === expectedSet.size && actual.every((c) => expectedSet.has(c));

const sameLeadingColumns = (actual: readonly string[], expectedSet: ReadonlySet<string>): boolean => {
  const k = expectedSet.size;
  if (actual.length < k) return false;
  const seen = new Set<string>();
  for (let i = 0; i < k; i++) {
    const cid = actual[i]!;
    if (!expectedSet.has(cid) || seen.has(cid)) return false;
    seen.add(cid);
  }
  return seen.size === k;
};

const isTargetColsUniqueBacked = (
  target: Model,
  targetIdx: ModelIndex,
  refTableId: string,
  refColIds: readonly string[],
): boolean => {
  const refSet = new Set(refColIds);
  if (refSet.size !== refColIds.length) return false;

  const tablesToCheck = [refTableId, ...partitionAncestors(target, refTableId).map((a) => a.id)];
  const isMysql = target.dialect === 'mysql';

  for (const tid of tablesToCheck) {
    for (const pk of targetIdx.childrenRef(tid, 'primaryKey')) {
      if (isMysql ? sameLeadingColumns(pk.columns, refSet) : sameColumnSet(pk.columns, refSet)) return true;
    }
    for (const u of targetIdx.childrenRef(tid, 'unique')) {
      if (isMysql ? sameLeadingColumns(u.columns, refSet) : sameColumnSet(u.columns, refSet)) return true;
    }
    for (const ix of targetIdx.childrenRef(tid, 'index')) {
      if (ix.where) continue;
      if (isMysql) {
        const idxType = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
        if (idxType === 'FULLTEXT' || idxType === 'SPATIAL') continue;
        if (ix.elements.length < refSet.size) continue;
        const leadCols: string[] = [];
        let ok = true;
        for (let i = 0; i < refSet.size; i++) {
          const c = ix.elements[i]?.column;
          if (!c) {
            ok = false;
            break;
          }
          leadCols.push(c);
        }
        if (ok && sameLeadingColumns(leadCols, refSet)) return true;
      } else {
        if (!ix.unique) continue;
        if (ix.elements.some((e) => e.column === null)) continue;
        const cols = ix.elements.map((e) => e.column!);
        if (sameColumnSet(cols, refSet)) return true;
      }
    }
  }
  return false;
};

const reconnectExternalFk = (
  ctx: PasteContext,
  fk: ForeignKey,
  reportTableName: string,
): { refTable: string; refColumns: string[] } | null => {
  const d = getDialect(ctx.target.dialect);
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

  const tgtSchema = findExactSchemaInTarget(ctx.target, ctx.targetIdx, srcSchemaName);
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

  const ci = isCaseInsensitiveDialect(ctx.target.dialect);
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
  const tgtColByName = new Map(tgtRefCols.map((c) => [normIdent(ctx.target.dialect, c.name), c]));

  const mappedRefCols: Column[] = [];
  const srcRefCols: Column[] = [];
  const missingNames: string[] = [];

  for (const srcRefColId of fk.refColumns) {
    const srcCol = ctx.frag[srcRefColId];
    if (srcCol?.kind !== 'column') {
      missingNames.push(srcRefColId);
      continue;
    }
    const tgtCol = tgtColByName.get(normIdent(ctx.target.dialect, srcCol.name));
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
    const srcType = columnTypeLabel(ctx.target.dialect, srcCol, ctx.frag);
    const tgtType = columnTypeLabel(ctx.target.dialect, tgtCol, ctx.target.objects);
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
  if (!isTargetColsUniqueBacked(ctx.target, ctx.targetIdx, tgtRefTbl.id, mappedRefIds)) {
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
  const d = getDialect(ctx.target.dialect);
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
    const exact = findExactSchemaInTarget(ctx.target, ctx.targetIdx, srcName);
    if (exact) return exact.id;
    const fallback = defaultTargetSchema(ctx.target, ctx.targetIdx);
    if (countFallback) {
      const k = `${srcName}\0${fallback.name}`;
      const entry = schemaFallbackCounts.get(k);
      if (entry) entry.tables++;
      else schemaFallbackCounts.set(k, { from: srcName, to: fallback.name, tables: 1 });
    }
    return fallback.id;
  };

  const colIdMap = new Map<string, string>();
  const newColNameById = new Map<string, string>();
  const deferredFks: {
    fk: ForeignKey;
    newTableId: string;
    newTableName: string;
    newSchemaId: string;
    srcTableName: string;
    colRenameMap: Map<string, string>;
  }[] = [];
  let partitionObjectsSkipped = 0;

  for (const srcRootId of payload.tables) {
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

    // SQLite WITHOUT ROWID 需要等主键创建后通过 setTableExt 设置
    const hasSqliteWithoutRowid = Boolean(srcTbl.ext?.sqlite?.withoutRowid);
    const createTableExt = hasSqliteWithoutRowid
      ? (cleanExt({
          ...srcTbl.ext,
          sqlite: srcTbl.ext?.sqlite ? { ...srcTbl.ext.sqlite, withoutRowid: undefined } : undefined,
        } as Record<string, unknown>) as TableExt | undefined)
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
      colIdMap.set(srcCol.id, newColId);
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
          defExpr = renameQualifiedManyInExpr(ctx.target.dialect, defExpr, ctx.qualifiedEnumRenames);
          mappedDefault = { expr: defExpr };
        }
      }

      // 扩展属性（SQLite autoincrement 延后；MSSQL defaultName 校验与后缀）
      let colExt = srcCol.ext ? clonePlain(srcCol.ext) : undefined;
      if (ctx.target.dialect === 'sqlite' && srcCol.ext?.sqlite?.autoincrement) {
        deferredAutoIncCols.push({ colId: newColId, ext: clonePlain(srcCol.ext) });
        colExt = cleanExt({
          ...colExt,
          sqlite: colExt?.sqlite ? { ...colExt.sqlite, autoincrement: undefined } : undefined,
        } as Record<string, unknown>) as ColumnExt | undefined;
      }

      if (ctx.target.dialect === 'mssql' && mappedDefault) {
        const mssqlExt = colExt?.mssql;
        if (mssqlExt?.defaultNameMode === 'explicit' && mssqlExt.defaultName) {
          const newDfName = ctx.ns.allocateName(mssqlExt.defaultName, 'constraint', (n) =>
            ctx.ns.isMssqlDefaultTaken(newSchemaId, n),
          );
          ctx.ns.addMssqlDefault(newSchemaId, newDfName);
          if (newDfName !== mssqlExt.defaultName) {
            ctx.report.renamed.push({
              kind: 'column',
              table: newTableName,
              from: mssqlExt.defaultName,
              to: newDfName,
            });
          }
          colExt = {
            ...colExt,
            mssql: { ...mssqlExt, defaultName: newDfName, defaultNameMode: 'explicit' },
          };
        } else {
          // 推导默认约束名由 addColumn -> refreshDerivedNames 重算
          const derivedDf = mssqlChooseName('DF', newTableName, newColName, (n) =>
            ctx.ns.isMssqlDefaultTaken(newSchemaId, n),
          );
          ctx.ns.addMssqlDefault(newSchemaId, derivedDf);
          if (colExt?.mssql) {
            colExt = cleanExt({
              ...colExt,
              mssql: { ...colExt.mssql, defaultName: undefined, defaultNameMode: undefined },
            } as Record<string, unknown>) as ColumnExt | undefined;
          }
        }
      } else if (ctx.target.dialect === 'mssql' && !mappedDefault && colExt?.mssql) {
        colExt = cleanExt({
          ...colExt,
          mssql: { ...colExt.mssql, defaultName: undefined, defaultNameMode: undefined },
        } as Record<string, unknown>) as ColumnExt | undefined;
      }

      let mappedGenerated: { expr: string; stored: boolean } | null = null;
      if (srcCol.generated) {
        let genExpr = renameManyInExpr(ctx.target.dialect, srcCol.generated.expr, colRenameMap);
        genExpr = renameQualifiedManyInExpr(ctx.target.dialect, genExpr, ctx.qualifiedEnumRenames);
        mappedGenerated = { expr: genExpr, stored: srcCol.generated.stored };
      }

      const mappedIdentity = srcCol.identity
        ? { always: srcCol.identity.always, options: clonePlain(srcCol.identity.options) }
        : null;

      // PG addColumn 会触发推导 NOT NULL 名与 IDENTITY 序列名，同步预占
      if (ctx.target.dialect === 'pg') {
        if (srcCol.notNull || mappedIdentity) {
          const nnName = chooseName(newTableName, newColName, 'not_null', (n) =>
            ctx.ns.isPgConTaken(newTableId, n, true),
          );
          ctx.ns.addPgNotNull(newTableId, nnName);
        }
        if (mappedIdentity) {
          const seqName = chooseName(newTableName, newColName, 'seq', (n) =>
            ctx.ns.isPgRelTaken(newSchemaId, n),
          );
          ctx.ns.addPgRel(newSchemaId, seqName);
        }
      }

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
    for (const pk of ctx.fragIdx.childrenRef(srcRootId, 'primaryKey')) {
      const newPkId = ctx.allocId();
      const mappedCols = pk.columns.map((c) => colIdMap.get(c)!);
      ctx.ops.push({
        name: 'addPrimaryKey',
        args: {
          id: newPkId,
          table: newTableId,
          columns: mappedCols,
          ...(pk.ext ? { ext: clonePlain(pk.ext) } : {}),
        },
      });
      if (pk.nameMode === 'explicit' && ctx.target.dialect !== 'mysql') {
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
          ctx.ns,
          ctx.target.dialect,
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

    // SQLite 延迟的 WITHOUT ROWID 与 AUTOINCREMENT 扩展
    if (hasSqliteWithoutRowid && srcTbl.ext) {
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

    // PG 分区设置与全部后代子分区（BFS 顺序）
    const mapPartitionSpec = (spec: PartitionSpec): PartitionSpec => ({
      strategy: spec.strategy,
      keys: spec.keys.map((k): PartitionKey => {
        let expr = k.expr;
        if (expr) {
          expr = renameManyInExpr(ctx.target.dialect, expr, colRenameMap);
          expr = renameQualifiedManyInExpr(ctx.target.dialect, expr, ctx.qualifiedEnumRenames);
        }
        return {
          column: k.column ? colIdMap.get(k.column)! : null,
          expr,
          opclass: k.opclass,
          collation: k.collation,
        };
      }),
    });

    if (d.capabilities.partitioning && srcTbl.partitionBy !== null) {
      const rootSpec = resolvePartitionBy(ctx.fragModel, srcTbl);
      if (rootSpec) {
        ctx.ops.push({
          name: 'setPartitionBy',
          args: { id: newTableId, partitionBy: mapPartitionSpec(rootSpec) },
        });
      }
      for (const srcDesc of ctx.fragIdx.partitionDescendants(srcRootId)) {
        const newDescId = ctx.allocId();
        const descParentNewId = tableMap[srcDesc.partitionOf!.parent]!;
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
            bound: srcDesc.partitionOf!.bound,
            schema: descSchemaId,
          },
        });
        if (srcDesc.partitionBy !== null) {
          const descSpec = resolvePartitionBy(ctx.fragModel, srcDesc);
          if (descSpec) {
            ctx.ops.push({
              name: 'setPartitionBy',
              args: { id: newDescId, partitionBy: mapPartitionSpec(descSpec) },
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

    // UNIQUE / CHECK / INDEX
    for (const u of ctx.fragIdx.childrenRef(srcRootId, 'unique')) {
      const newUid = ctx.allocId();
      const mappedCols = u.columns.map((c) => colIdMap.get(c)!);
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
          ctx.ns,
          ctx.target.dialect,
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
      expr = renameQualifiedManyInExpr(ctx.target.dialect, expr, ctx.qualifiedEnumRenames);
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
          ctx.ns,
          ctx.target.dialect,
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
      const newIxId = ctx.allocId();
      const mappedElements = ix.elements.map((e) => ({
        column: e.column ? colIdMap.get(e.column)! : null,
        expr: e.expr
          ? renameQualifiedManyInExpr(
              ctx.target.dialect,
              renameManyInExpr(ctx.target.dialect, e.expr, colRenameMap),
              ctx.qualifiedEnumRenames,
            )
          : null,
        desc: e.desc,
        nullsFirst: e.nullsFirst,
        opclass: e.opclass,
        collation: e.collation,
      }));
      const mappedInclude = ix.include.map((c) => colIdMap.get(c)!);
      const mappedWhere = ix.where
        ? renameQualifiedManyInExpr(
            ctx.target.dialect,
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
          ctx.ns,
          ctx.target.dialect,
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
      });
    }
  }

  // 所有表建完后再处理全部外键（内部重连 + 外部按 schema.table.col 重连）
  for (const item of deferredFks) {
    const { fk, newTableId, newTableName, newSchemaId, srcTableName } = item;
    const mappedCols = fk.columns.map((c) => colIdMap.get(c)!);
    let refTable: string;
    let refColumns: string[];

    if (fk.refTable in tableMap) {
      refTable = tableMap[fk.refTable]!;
      refColumns = fk.refColumns.map((c) => colIdMap.get(c)!);
    } else {
      const reconnected = reconnectExternalFk(ctx, fk, srcTableName);
      if (!reconnected) continue;
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
        ctx.ns,
        ctx.target.dialect,
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

const hasMssqlClusteredOnTable = (m: Model, tableId: string): boolean => {
  for (const pk of childrenOf(m, tableId, 'primaryKey')) {
    if (isMssqlPkClustered(m, pk)) return true;
  }
  for (const u of childrenOf(m, tableId, 'unique')) {
    if (u.ext?.mssql?.clustered === true) return true;
  }
  for (const ix of childrenOf(m, tableId, 'index')) {
    if (ix.ext?.mssql?.clustered === true) return true;
  }
  return false;
};

const normExprText = (s: string | null): string | null => (s === null ? null : s.trim().replace(/\s+/g, ' '));

const planItemsPaste = (ctx: PasteContext, payload: ClipboardPayload, tgtTbl: Table): PastePlan => {
  const d = getDialect(ctx.target.dialect);
  const tgtSchemaId = tgtTbl.parent;
  const srcTbl = ctx.frag[payload.table!] as Table;
  const srcRootId = rootTableId(ctx.fragModel, srcTbl.id);

  ctx.ns.initTableColumns(tgtTbl.id);

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

  const itemObjs = payload.items.map((iid) => ctx.frag[iid]).filter((o): o is Obj => Boolean(o));
  const srcColItems = itemObjs.filter((o): o is Column => o.kind === 'column');
  const srcKeyItems = itemObjs.filter((o) => o.kind !== 'column');

  for (const sc of srcColItems) ctx.copiedColIds.add(sc.id);

  // 预检已有列与表级约束
  const existingCols = columnsOf(scratch, tgtTbl.id);
  const existingColByNormName = new Map(existingCols.map((c) => [normIdent(ctx.target.dialect, c.name), c]));
  let hasTargetPk = childrenOf(scratch, tgtTbl.id, 'primaryKey').length > 0;
  let hasSqliteAutoInc = existingCols.some((c) => Boolean(c.ext?.sqlite?.autoincrement));
  let hasMysqlAutoInc = existingCols.some((c) => Boolean(c.ext?.mysql?.autoIncrement));
  let hasMssqlIdentity = existingCols.some((c) => Boolean(c.ext?.mssql?.identity));

  const batchPkItem = srcKeyItems.find((o): o is PrimaryKey => o.kind === 'primaryKey');
  const batchUniqueItems = srcKeyItems.filter((o): o is Unique => o.kind === 'unique');
  const batchIndexItems = srcKeyItems.filter((o): o is Index => o.kind === 'index');

  const hasMysqlCoveringKeyInBatch = (srcColId: string): boolean => {
    if (!hasTargetPk && batchPkItem && batchPkItem.columns[0] === srcColId) return true;
    if (batchUniqueItems.some((u) => u.columns[0] === srcColId)) return true;
    return batchIndexItems.some((ix) => {
      const idxType = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
      return idxType !== 'FULLTEXT' && idxType !== 'SPATIAL' && ix.elements[0]?.column === srcColId;
    });
  };

  // 第 1 趟：单列能力检查与新列名分配
  interface CandidateCol {
    src: Column;
    newId: string;
    newName: string;
    renamed: boolean;
    deferredSqliteAutoInc: boolean;
  }
  const candidates: CandidateCol[] = [];
  const colRenameMap = new Map<string, string>();

  for (const sc of srcColItems) {
    if (ctx.target.dialect === 'sqlite') {
      if (tgtTbl.ext?.sqlite?.strict && !SQLITE_STRICT_TYPES.has(sc.type.trim().toUpperCase())) {
        ctx.report.skipped.push({
          kind: 'column',
          name: sc.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: `STRICT 表不支持列类型 ${sc.type}`,
        });
        continue;
      }
      if (sc.ext?.sqlite?.autoincrement) {
        if (tgtTbl.ext?.sqlite?.withoutRowid) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'WITHOUT ROWID 表不能使用 AUTOINCREMENT',
          });
          continue;
        }
        if (sc.type.trim().toUpperCase() !== 'INTEGER') {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'AUTOINCREMENT 只能用于 INTEGER 类型列',
          });
          continue;
        }
        if (hasSqliteAutoInc || hasTargetPk) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: '目标表已有主键或 AUTOINCREMENT 列',
          });
          continue;
        }
        if (!batchPkItem || batchPkItem.columns.length !== 1 || batchPkItem.columns[0] !== sc.id) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'AUTOINCREMENT 列必须同批粘贴对应的单列主键',
          });
          continue;
        }
        hasSqliteAutoInc = true;
      }
    } else if (ctx.target.dialect === 'mysql') {
      if (sc.ext?.mysql?.autoIncrement) {
        if (hasMysqlAutoInc) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'MySQL 每张表最多只能有一列 AUTO_INCREMENT',
          });
          continue;
        }
        if (!isMysqlAutoIncrementType(sc.type) || sc.generated || sc.default || !sc.notNull) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: `列 ${sc.name} 不满足 AUTO_INCREMENT 条件`,
          });
          continue;
        }
        if (!hasMysqlCoveringKeyInBatch(sc.id)) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'AUTO_INCREMENT 列需同批粘贴以其为首列的主键、唯一约束或索引',
          });
          continue;
        }
        hasMysqlAutoInc = true;
      }
    } else if (ctx.target.dialect === 'mssql') {
      if (sc.ext?.mssql?.identity) {
        if (hasMssqlIdentity) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'SQL Server 每张表最多只能有一个 IDENTITY 列',
          });
          continue;
        }
        if (!isMssqlIdentityEligibleType(sc.type) || !sc.notNull || sc.default || sc.generated) {
          ctx.report.skipped.push({
            kind: 'column',
            name: sc.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: `列 ${sc.name} 不满足 MSSQL IDENTITY 条件`,
          });
          continue;
        }
        hasMssqlIdentity = true;
      }
      if (sc.generated && !sc.generated.stored && sc.notNull) {
        ctx.report.skipped.push({
          kind: 'column',
          name: sc.name,
          table: tgtTbl.name,
          reason: 'unsupported',
          detail: 'SQL Server 非 PERSISTED 计算列不能声明 NOT NULL',
        });
        continue;
      }
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
      deferredSqliteAutoInc: Boolean(ctx.target.dialect === 'sqlite' && sc.ext?.sqlite?.autoincrement),
    });
  }

  // 第 1.5 趟：不动点检查生成列表达式引用（保证无悬空引用与 MySQL 生成列不引用 AUTO_INCREMENT 列）
  let surviving = candidates;
  for (;;) {
    const allowedNormNames = new Set<string>(existingCols.map((c) => normIdent(ctx.target.dialect, c.name)));
    const autoIncNames = new Set<string>(
      existingCols.filter((c) => c.ext?.mysql?.autoIncrement).map((c) => c.name.toLowerCase()),
    );
    for (const c of surviving) {
      allowedNormNames.add(normIdent(ctx.target.dialect, c.newName));
      if (ctx.target.dialect === 'mysql' && c.src.ext?.mysql?.autoIncrement) {
        autoIncNames.add(c.newName.toLowerCase());
      }
    }
    const nextSurviving: CandidateCol[] = [];
    let droppedAny = false;
    for (const c of surviving) {
      if (c.src.generated) {
        const rewritten = renameManyInExpr(ctx.target.dialect, c.src.generated.expr, colRenameMap);
        const unknown = findUnknownExprColumns(ctx.target.dialect, rewritten, allowedNormNames);
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
        if (
          ctx.target.dialect === 'mysql' &&
          [...autoIncNames].some((aiName) => getDialect('mysql').exprReferences(rewritten, aiName))
        ) {
          ctx.ns.removeColumn(tgtTbl.id, c.newName);
          colRenameMap.delete(c.src.name);
          ctx.report.skipped.push({
            kind: 'column',
            name: c.src.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: 'MySQL 生成列不能引用 AUTO_INCREMENT 列',
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
  let pendingSqliteAutoInc: { colId: string; srcColId: string; ext: ColumnExt } | null = null;

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
        defExpr = renameQualifiedManyInExpr(ctx.target.dialect, defExpr, ctx.qualifiedEnumRenames);
        mappedDefault = { expr: defExpr };
      }
    }

    let colExt = sc.ext ? clonePlain(sc.ext) : undefined;
    if (cand.deferredSqliteAutoInc) {
      colExt = cleanExt({
        ...colExt,
        sqlite: colExt?.sqlite ? { ...colExt.sqlite, autoincrement: undefined } : undefined,
      } as Record<string, unknown>) as ColumnExt | undefined;
    }

    let reservedDfName: string | null = null;
    if (ctx.target.dialect === 'mssql' && mappedDefault) {
      const mssqlExt = colExt?.mssql;
      if (mssqlExt?.defaultNameMode === 'explicit' && mssqlExt.defaultName) {
        const newDfName = ctx.ns.allocateName(mssqlExt.defaultName, 'constraint', (n) =>
          ctx.ns.isMssqlDefaultTaken(tgtSchemaId, n),
        );
        reservedDfName = newDfName;
        if (newDfName !== mssqlExt.defaultName) {
          ctx.report.renamed.push({
            kind: 'column',
            table: tgtTbl.name,
            from: mssqlExt.defaultName,
            to: newDfName,
          });
        }
        colExt = {
          ...colExt,
          mssql: { ...mssqlExt, defaultName: newDfName, defaultNameMode: 'explicit' },
        };
      } else if (colExt?.mssql) {
        colExt = cleanExt({
          ...colExt,
          mssql: { ...colExt.mssql, defaultName: undefined, defaultNameMode: undefined },
        } as Record<string, unknown>) as ColumnExt | undefined;
      }
    } else if (ctx.target.dialect === 'mssql' && !mappedDefault && colExt?.mssql) {
      colExt = cleanExt({
        ...colExt,
        mssql: { ...colExt.mssql, defaultName: undefined, defaultNameMode: undefined },
      } as Record<string, unknown>) as ColumnExt | undefined;
    }

    let mappedGenerated: { expr: string; stored: boolean } | null = null;
    if (sc.generated) {
      let genExpr = renameManyInExpr(ctx.target.dialect, sc.generated.expr, colRenameMap);
      genExpr = renameQualifiedManyInExpr(ctx.target.dialect, genExpr, ctx.qualifiedEnumRenames);
      mappedGenerated = { expr: genExpr, stored: sc.generated.stored };
    }

    const mappedIdentity = sc.identity
      ? { always: sc.identity.always, options: clonePlain(sc.identity.options) }
      : null;

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
    if (reservedDfName) ctx.ns.addMssqlDefault(tgtSchemaId, reservedDfName);
    const createdCol = scratch.objects[cand.newId];
    if (createdCol?.kind === 'column') {
      if (ctx.target.dialect === 'pg') {
        if (createdCol.notNull && createdCol.notNullName)
          ctx.ns.addPgNotNull(tgtTbl.id, createdCol.notNullName);
        if (createdCol.identity?.sequenceName) ctx.ns.addPgRel(tgtSchemaId, createdCol.identity.sequenceName);
      } else if (ctx.target.dialect === 'mssql' && createdCol.default && !reservedDfName) {
        const df = mssqlDefaultNameOf(createdCol, tgtTbl.name);
        ctx.ns.addMssqlDefault(tgtSchemaId, df);
      }
    }
    if (cand.deferredSqliteAutoInc && sc.ext) {
      pendingSqliteAutoInc = { colId: cand.newId, srcColId: sc.id, ext: clonePlain(sc.ext) };
    }
    if (sc.comment !== null) {
      ctx.commentQueue.push({ id: cand.newId, comment: sc.comment });
    }
  }

  // 批后允许的全部列名（用于 CHECK / INDEX 表达式引用校验）
  const postBatchCols = columnsOf(scratch, tgtTbl.id);
  const postBatchAllowedNames = new Set(postBatchCols.map((c) => normIdent(ctx.target.dialect, c.name)));

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
      const existing = existingColByNormName.get(normIdent(ctx.target.dialect, srcCol.name));
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
      if (ctx.target.dialect === 'mssql' && item.ext?.mssql?.clustered === true) {
        if (hasMssqlClusteredOnTable(scratch, tgtTbl.id)) {
          ctx.report.skipped.push({
            kind: 'primaryKey',
            name: item.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: '目标表已有 CLUSTERED 约束或索引',
          });
          continue;
        }
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
      if (item.nameMode === 'explicit' && ctx.target.dialect !== 'mysql') {
        explicitName = ctx.ns.allocateName(item.name, 'constraint', (n) =>
          ctx.ns.isKeyTaken(tgtSchemaId, tgtTbl.id, 'primaryKey', n),
        );
        if (explicitName !== item.name) {
          renamedInfo = { kind: 'primaryKey', table: tgtTbl.name, from: item.name, to: explicitName };
        }
        candidateOps.push({ name: 'renameKey', args: { id: newPkId, name: explicitName } });
      }
      if (pendingSqliteAutoInc && mapped.length === 1 && mapped[0] === pendingSqliteAutoInc.colId) {
        candidateOps.push({
          name: 'setColumnExt',
          args: { id: pendingSqliteAutoInc.colId, ext: pendingSqliteAutoInc.ext },
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
      if (ctx.target.dialect === 'mssql' && item.ext?.mssql?.clustered === true) {
        if (hasMssqlClusteredOnTable(scratch, tgtTbl.id)) {
          ctx.report.skipped.push({
            kind: 'unique',
            name: item.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: '目标表已有 CLUSTERED 约束或索引',
          });
          continue;
        }
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
      expr = renameQualifiedManyInExpr(ctx.target.dialect, expr, ctx.qualifiedEnumRenames);
      const unknown = findUnknownExprColumns(ctx.target.dialect, expr, postBatchAllowedNames);
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
          mappedElExpr = renameQualifiedManyInExpr(
            ctx.target.dialect,
            mappedElExpr,
            ctx.qualifiedEnumRenames,
          );
        }
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

      const unknownExprCols: string[] = [];
      for (const el of mappedElements) {
        if (el.expr !== null) {
          unknownExprCols.push(...findUnknownExprColumns(ctx.target.dialect, el.expr, postBatchAllowedNames));
        }
      }
      let mappedWhere = item.where;
      if (mappedWhere !== null) {
        mappedWhere = renameManyInExpr(ctx.target.dialect, mappedWhere, colRenameMap);
        mappedWhere = renameQualifiedManyInExpr(ctx.target.dialect, mappedWhere, ctx.qualifiedEnumRenames);
        unknownExprCols.push(
          ...findUnknownExprColumns(ctx.target.dialect, mappedWhere, postBatchAllowedNames),
        );
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
          deepEqual(ix.ext?.mysql?.indexType, item.ext?.mysql?.indexType),
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

      if (ctx.target.dialect === 'mssql' && item.ext?.mssql?.clustered === true) {
        if (hasMssqlClusteredOnTable(scratch, tgtTbl.id)) {
          ctx.report.skipped.push({
            kind: 'index',
            name: item.name,
            table: tgtTbl.name,
            reason: 'unsupported',
            detail: '目标表已有 CLUSTERED 约束或索引',
          });
          continue;
        }
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

  return withModelIndex(target, (targetIdx) =>
    withModelIndex(fragModel, (fragIdx) => {
      const ctx: PasteContext = {
        target,
        targetIdx,
        frag,
        fragModel,
        fragIdx,
        ns: new NamespaceTracker(target, targetIdx),
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
