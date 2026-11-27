// mutator 注册表：同步层里每个修改都是“操作名 + 参数”（04-ir-design.md 第 2 节）。
// 客户端乐观执行，服务器在最新状态上重新执行；参数由服务器用 zod 校验，不信任客户端。
import { z } from 'zod';

import { exprRefNames, refsHaveName } from './derived-names.ts';
import * as E from './edit.ts';
import { isReservedId } from './ids.ts';
import {
  ColumnExt,
  FkAction,
  IndexElement,
  IndexExt,
  isValidIndexElement,
  type Model,
  MssqlColumnExt,
  MysqlColumnExt,
  type Obj,
  PartitionSpec,
  PrimaryKeyExt,
  SequenceOptions,
  TableExt,
  UniqueExt,
} from './ir.ts';
import { columnsOf, effectiveColumnsOf, rootTableId } from './model.ts';
import { PG_SERIAL_TYPE_NOTE } from './pg/serial.ts';
import { getDialect } from './registry.ts';
import { SQLITE_COLUMN_TYPE_NOTE } from './sqlite/types.ts';

/** mutator 参数里的对象 ID：1-64 个字符，不能是 Object.prototype 上的保留名（宏编译层复用） */
export const objectIdArg = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => !isReservedId(s), { message: '对象 ID 不能是保留名' });
/** mutator 参数里的对象名：1-128 个字符（具体方言上限由 validateIdent 校验；宏编译层复用） */
export const objectNameArg = z.string().min(1).max(128);
const id = objectIdArg;
const name = objectNameArg;
/**
 * mutator 参数里单个自由文本字段（类型、表达式、分区边界、注释、排序规则……）的字符上限（Issue #150）。
 * 与冻结脚本单步 SQL 的上限（stepsPatchSchema，100 万字符）一致：合法内容远小于它，
 * 超长的单个字段在 zod 校验处就被拒绝，不进入 normalizeType / 表达式扫描，也不会写进模型
 */
export const MAX_TEXT_ARG_LENGTH = 1_000_000;
const text = z.string().max(MAX_TEXT_ARG_LENGTH, '文本太长：单个字段最多 100 万个字符');

const columnDefaultArg = z.union([z.object({ expr: text.min(1) }), z.object({ nextval: id })]);
const sequenceOptionsArg = SequenceOptions.extend({
  increment: text.default('1'),
  min: text.nullable().default(null),
  max: text.nullable().default(null),
  start: text.nullable().default(null),
  cache: text.default('1'),
});
const partitionKeyArg = z
  .object({
    column: id.nullable().default(null),
    expr: text.min(1).nullable().default(null),
    opclass: text.min(1).nullable().default(null),
    collation: text.min(1).nullable().default(null),
  })
  .refine((k) => (k.column !== null) !== (k.expr !== null), {
    message: '分区键必须且只能指定 column 或 expr 之一',
  });
const partitionSpecArg = PartitionSpec.extend({
  keys: z.array(partitionKeyArg).min(1),
});
// setColumnExt / setPartitionBy 会整块提交子对象，此上限也会校验存量模型中原样带回的旧字段
// （例如 Inspector 切换 MySQL UNSIGNED 时重发 ext.mysql.enumValues）；真实库中合法值远低于 100 万字符
// （如 MySQL ENUM 单项最多 255 字符），可接受，不额外拆分局部校验。
const columnExtArg = ColumnExt.extend({
  mysql: MysqlColumnExt.extend({
    enumValues: z.array(text).optional(),
    setValues: z.array(text).optional(),
  }).optional(),
  mssql: MssqlColumnExt.extend({
    identity: z.object({ seed: text, increment: text }).optional(),
  }).optional(),
});
const indexElementArg = IndexElement.extend({
  expr: text.nullable().default(null),
  opclass: text.nullable().default(null),
  collation: text.nullable().default(null),
})
  .partial()
  .refine(isValidIndexElement, {
    message: '索引元素必须是列或非空表达式之一',
  });

/** 修改一个 CHECK 约束的表达式（推导名会随引用的列变化） */
export const setCheckExpr = (m: Model, checkId: string, expr: string) => {
  const o = m.objects[checkId];
  if (o?.kind !== 'check') throw new E.EditError('不是 CHECK 约束');
  E.normalizePartitionFamily(m, o.parent);
  E.checkExprColumns(m, o.parent, expr);
  o.expr = expr;
  E.refreshDerivedNames(m, o.parent);
};

const def = <A extends z.ZodType>(args: A, run: (m: Model, a: z.infer<A>) => unknown) => ({ args, run });

export const mutators = {
  createSchema: def(z.object({ id, name }), (m, a) => E.createSchema(m, a.name, a.id)),
  renameSchema: def(z.object({ id, name }), (m, a) => E.renameSchema(m, a.id, a.name)),
  dropSchema: def(z.object({ id }), (m, a) => E.dropSchema(m, a.id)),

  createEnum: def(z.object({ id, schema: id, name, values: z.array(text.min(1)).min(1) }), (m, a) =>
    E.createEnum(m, a.schema, a.name, a.values, a.id),
  ),
  renameEnum: def(z.object({ id, name }), (m, a) => E.renameEnum(m, a.id, a.name)),
  addEnumValue: def(z.object({ id, value: text.min(1), index: z.number().int().min(0).optional() }), (m, a) =>
    E.addEnumValue(m, a.id, a.value, a.index),
  ),
  dropEnum: def(z.object({ id }), (m, a) => E.dropEnum(m, a.id)),

  createSequence: def(
    z.object({ id, schema: id, name, options: sequenceOptionsArg.partial().optional() }),
    (m, a) => E.createSequence(m, a.schema, a.name, a.options ?? {}, a.id),
  ),
  renameSequence: def(z.object({ id, name }), (m, a) => E.renameSequence(m, a.id, a.name)),
  dropSequence: def(z.object({ id }), (m, a) => E.dropSequence(m, a.id)),
  setSequenceOwnedBy: def(z.object({ id, column: id.nullable() }), (m, a) =>
    E.setSequenceOwnedBy(m, a.id, a.column),
  ),

  createTable: def(
    z.object({
      id,
      schema: id,
      name,
      partitionBy: partitionSpecArg.nullable().optional(),
      ext: TableExt.optional(),
    }),
    (m, a) => E.createTable(m, a.schema, a.name, a.id, a.partitionBy ?? null, a.ext),
  ),
  renameTable: def(z.object({ id, name }), (m, a) => E.renameTable(m, a.id, a.name)),
  dropTable: def(z.object({ id }), (m, a) => E.dropTable(m, a.id)),
  setTableExt: def(z.object({ id, ext: TableExt.nullable() }), (m, a) => E.setTableExt(m, a.id, a.ext)),

  setPartitionBy: def(z.object({ id, partitionBy: partitionSpecArg.nullable() }), (m, a) =>
    E.setPartitionBy(m, a.id, a.partitionBy),
  ),
  createPartition: def(
    z.object({ id, parent: id, name, bound: text.min(1), schema: id.optional() }),
    (m, a) => E.createPartition(m, a.parent, a.name, a.bound, a.id, a.schema),
  ),
  setPartitionBound: def(z.object({ id, bound: text.min(1) }), (m, a) =>
    E.setPartitionBound(m, a.id, a.bound),
  ),
  attachPartition: def(z.object({ parent: id, child: id, bound: text.min(1) }), (m, a) =>
    E.attachPartition(m, a.parent, a.child, a.bound),
  ),
  detachPartition: def(z.object({ id }), (m, a) => E.detachPartition(m, a.id)),

  addColumn: def(
    z.object({
      table: id,
      column: z.object({
        id,
        name,
        type: text.describe(`Column type text. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`),
        typeRef: id.nullable().optional(),
        notNull: z.boolean().optional(),
        default: columnDefaultArg.nullable().optional(),
        identity: z
          .object({ always: z.boolean(), options: sequenceOptionsArg.partial().optional() })
          .nullable()
          .optional(),
        generated: z
          .object({ expr: text.min(1), stored: z.boolean() })
          .nullable()
          .optional(),
        collation: text.nullable().optional(),
        before: id.optional(),
        ext: columnExtArg.optional(),
      }),
    }),
    (m, a) => E.addColumn(m, a.table, a.column),
  ),
  renameColumn: def(z.object({ id, name }), (m, a) => E.renameColumn(m, a.id, a.name)),
  dropColumn: def(z.object({ id }), (m, a) => E.dropColumn(m, a.id)),
  setColumnType: def(
    z.object({
      id,
      type: text.describe(`Column type text. ${PG_SERIAL_TYPE_NOTE} ${SQLITE_COLUMN_TYPE_NOTE}`),
      typeRef: id.nullable(),
    }),
    (m, a) => E.setColumnType(m, a.id, a.type, a.typeRef),
  ),
  setNotNull: def(z.object({ id, notNull: z.boolean() }), (m, a) => E.setNotNull(m, a.id, a.notNull)),
  setDefault: def(z.object({ id, default: columnDefaultArg.nullable() }), (m, a) =>
    E.setDefault(m, a.id, a.default),
  ),
  setIdentity: def(z.object({ id, identity: z.object({ always: z.boolean() }).nullable() }), (m, a) =>
    E.setIdentity(m, a.id, a.identity),
  ),
  setColumnExt: def(z.object({ id, ext: columnExtArg.nullable() }), (m, a) => E.setColumnExt(m, a.id, a.ext)),
  moveColumn: def(z.object({ id, before: id.nullable() }), (m, a) => E.moveColumn(m, a.id, a.before)),

  addPrimaryKey: def(
    z.object({ id, table: id, columns: z.array(id).min(1), ext: PrimaryKeyExt.optional() }),
    (m, a) => E.addPrimaryKey(m, a.table, a.columns, a.id, a.ext),
  ),
  setPrimaryKey: def(
    z.object({ id: id.optional(), table: id, columns: z.array(id), ext: PrimaryKeyExt.optional() }),
    (m, a) => E.setPrimaryKey(m, a.table, a.columns, a.id, a.ext),
  ),
  addUnique: def(
    z.object({
      id,
      table: id,
      columns: z.array(id).min(1),
      nullsNotDistinct: z.boolean().optional(),
      ext: UniqueExt.optional(),
    }),
    (m, a) => E.addUnique(m, a.table, a.columns, a.nullsNotDistinct ?? false, a.id, a.ext),
  ),
  addCheck: def(z.object({ id, table: id, expr: text.min(1), noInherit: z.boolean().optional() }), (m, a) =>
    E.addCheck(m, a.table, a.expr, a.id, a.noInherit ?? false),
  ),
  setCheckExpr: def(z.object({ id, expr: text.min(1) }), (m, a) => setCheckExpr(m, a.id, a.expr)),
  addForeignKey: def(
    z.object({
      id,
      table: id,
      columns: z.array(id).min(1),
      refTable: id,
      refColumns: z.array(id).min(1),
      onDelete: FkAction.optional(),
      onUpdate: FkAction.optional(),
      match: z.enum(['simple', 'full']).optional(),
      deferrable: z.boolean().optional(),
      initiallyDeferred: z.boolean().optional(),
    }),
    (m, { id, table, columns, refTable, refColumns, ...opts }) =>
      E.addForeignKey(
        m,
        table,
        columns,
        refTable,
        refColumns,
        Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
        id,
      ),
  ),
  addIndex: def(
    z.object({
      id,
      table: id,
      elements: z.array(indexElementArg).min(1, { message: '索引至少需要一个元素' }),
      unique: z.boolean().optional(),
      method: text.optional(),
      include: z.array(id).optional(),
      where: text.nullable().optional(),
      nullsNotDistinct: z.boolean().optional(),
      ext: IndexExt.optional(),
    }),
    (m, { id, table, elements, ...opts }) =>
      E.addIndex(
        m,
        table,
        elements,
        Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
        id,
      ),
  ),
  dropKey: def(z.object({ id }), (m, a) => E.dropKey(m, a.id)),
  renameKey: def(z.object({ id, name }), (m, a) => E.renameKey(m, a.id, a.name)),
  resetKeyName: def(z.object({ id }), (m, a) => E.resetKeyName(m, a.id)),

  setComment: def(z.object({ id, comment: text.nullable() }), (m, a) => E.setComment(m, a.id, a.comment)),
};

/**
 * 粘贴（ADR 0013 第 2 节）允许组合的普通 mutator：只有新建类操作和命名 / 注释，不能删除或改动既有对象，
 * 也不能嵌套 paste。整批在同一份草稿上依次执行，任何一步不合法整批作废（原子）。
 */
export const PASTE_MUTATORS = [
  'createEnum',
  'createSequence',
  'setSequenceOwnedBy',
  'createTable',
  'setTableExt',
  'setPartitionBy',
  'createPartition',
  'addColumn',
  'setColumnExt',
  'addPrimaryKey',
  'addUnique',
  'addCheck',
  'addForeignKey',
  'addIndex',
  'renameKey',
  'setComment',
] as const satisfies readonly (keyof typeof mutators)[];

/** 单次粘贴最多展开的子操作数（与 clipboard.ts 的 MAX_PASTE_OPS 一致） */
const PASTE_OPS_LIMIT = 20_000;

const pasteArgs = z.object({
  ops: z
    .array(z.object({ name: z.enum(PASTE_MUTATORS), args: z.unknown() }))
    .min(1)
    .max(PASTE_OPS_LIMIT),
});

/** 新建对象类操作在 paste 里的参数必须给出新 ID：只能建新对象，绝不复用模型里已有的 ID */
const PASTE_NEW_ID_OPS: ReadonlySet<string> = new Set([
  'createEnum',
  'createSequence',
  'createTable',
  'createPartition',
  'addPrimaryKey',
  'addUnique',
  'addCheck',
  'addForeignKey',
  'addIndex',
]);

/** 只能修改本次 paste 新建对象的操作（防止通过 paste 篡改模型中既有对象） */
const PASTE_CREATED_ONLY_OPS: ReadonlySet<string> = new Set([
  'setSequenceOwnedBy',
  'setTableExt',
  'setPartitionBy',
  'setColumnExt',
  'renameKey',
  'setComment',
]);

const runPaste = (m: Model, a: z.infer<typeof pasteArgs>) => {
  const created = new Set<string>();
  const fresh = (newId: unknown) => {
    if (typeof newId !== 'string') return;
    if (Object.hasOwn(m.objects, newId) || created.has(newId))
      throw new E.EditError(`对象 ID ${newId} 已存在`);
    created.add(newId);
  };
  for (const op of a.ops) {
    const args = op.args as Record<string, unknown> | null;
    if (args && typeof args === 'object') {
      if (PASTE_NEW_ID_OPS.has(op.name)) fresh(args.id);
      if (op.name === 'addColumn') fresh((args.column as Record<string, unknown> | undefined)?.id);
      if (PASTE_CREATED_ONLY_OPS.has(op.name)) {
        if (typeof args.id !== 'string' || !created.has(args.id)) {
          throw new E.EditError(`操作 ${op.name} 只能作用于本次粘贴新建的对象`);
        }
        if (
          op.name === 'setSequenceOwnedBy' &&
          typeof args.column === 'string' &&
          !created.has(args.column)
        ) {
          throw new E.EditError('序列归属列必须是本次粘贴新建的列');
        }
      }
    }
    runMutator(m, op.name, op.args);
  }
};

/**
 * 受控原子批处理（ADR 0015 第 3 节）：MCP `apply_changes` 把整批展开后的普通 mutator 收敛为 1 个同步层 op
 * （1 个 seq / 1 条 room_commits / 1 次广播）。与 paste 同构：只允许 `mutators` 注册表里的普通操作，
 * 禁止嵌套 batch 与 paste；整批在同一份草稿上依次执行，任何一步不合法整批作废（原子）。
 */
export const BATCH_MUTATOR = 'batch';
/** 单个 batch 最多展开的子操作数（与 @dowel/api 的 MCP_MAX_EXPANDED_OPS 一致） */
export const BATCH_OPS_LIMIT = 500;
/** batch 可选意图说明的最大长度 */
export const BATCH_SUMMARY_MAX = 500;
/** 复合 mutator：一个 op 内部展开为多个子操作，不在 `mutators` 注册表里，由 runMutator 单独分派 */
export const COMPOSITE_MUTATORS: ReadonlySet<string> = new Set(['paste', BATCH_MUTATOR]);

export const batchArgs = z
  .object({
    ops: z
      .array(z.object({ name: z.string().min(1), args: z.unknown() }).strict())
      .min(1)
      .max(BATCH_OPS_LIMIT),
    summary: z.string().trim().min(1).max(BATCH_SUMMARY_MAX).optional(),
  })
  .strict();
export type BatchArgs = z.infer<typeof batchArgs>;

/** batch 子操作失败：index 为子操作下标（从 0 开始），rawMessage 为子操作本身的错误文本 */
export class BatchOpError extends E.EditError {
  readonly index: number;
  readonly opName: string;
  readonly rawMessage: string;
  constructor(index: number, opName: string, rawMessage: string) {
    super(`ops[${index}] ${opName}：${rawMessage}`);
    this.name = 'BatchOpError';
    this.index = index;
    this.opName = opName;
    this.rawMessage = rawMessage;
  }
}

/** 取 batch 参数里的意图说明（去首尾空白，空串视为没有；超长截断），不是合法字符串时返回 null */
export const batchSummaryOf = (args: unknown): string | null => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const raw = (args as Record<string, unknown>).summary;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s ? s.slice(0, BATCH_SUMMARY_MAX) : null;
};

const runBatch = (m: Model, a: BatchArgs) => {
  for (let i = 0; i < a.ops.length; i++) {
    const op = a.ops[i]!;
    if (COMPOSITE_MUTATORS.has(op.name)) {
      throw new BatchOpError(i, op.name, `batch 不能嵌套 ${op.name}`);
    }
    if (!Object.hasOwn(mutators, op.name)) {
      throw new BatchOpError(i, op.name, `未知的操作：${op.name}`);
    }
    try {
      runMutator(m, op.name, op.args);
    } catch (e) {
      if (e instanceof E.EditError) throw new BatchOpError(i, op.name, e.message);
      throw e;
    }
  }
};

export type MutatorName = keyof typeof mutators;
export type PasteArgs = z.infer<typeof pasteArgs>;
export type MutatorArgs<K extends MutatorName> = z.infer<(typeof mutators)[K]['args']>;

/** 执行一个修改：校验参数后在模型上执行（直接修改传入的模型）。参数不合法或操作不合法抛 EditError */
export const runMutator = (m: Model, name: string, args: unknown) => {
  if (name === 'paste') {
    const parsed = pasteArgs.safeParse(args);
    if (!parsed.success) throw new E.EditError(`参数不合法：${parsed.error.issues[0]?.message ?? ''}`);
    runPaste(m, parsed.data);
    return;
  }
  if (name === BATCH_MUTATOR) {
    const parsed = batchArgs.safeParse(args);
    if (!parsed.success) throw new E.EditError(`参数不合法：${parsed.error.issues[0]?.message ?? ''}`);
    runBatch(m, parsed.data);
    return;
  }
  const registry = mutators as Record<string, { args: z.ZodType; run: (m: Model, a: unknown) => unknown }>;
  const mu = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!mu) throw new E.EditError(`未知的操作：${name}`);
  const parsed = mu.args.safeParse(args);
  if (!parsed.success) throw new E.EditError(`参数不合法：${parsed.error.issues[0]?.message ?? ''}`);
  mu.run(m, parsed.data);
};

/**
 * 修改“依据”的对象（用于先到先得的冲突判断，见 04-ir-design.md 2.3）：
 * 参数里出现的、模型中存在的对象，加上参数里表达式（expr / where）引用到的本表的列。
 * 修改实际写到的对象由同步层另行计算，也算在依据里。
 */
export const readsOf = (m: Model, args: unknown, name?: string): string[] => {
  if (name === BATCH_MUTATOR) return batchReadsOf(m, args);
  const out = new Set<string>();
  const exprs: string[] = [];
  const walk = (x: unknown, k?: string) => {
    if (typeof x === 'string') {
      if (Object.hasOwn(m.objects, x)) out.add(x);
      if (k === 'expr' || k === 'where') exprs.push(x);
    } else if (Array.isArray(x)) for (const v of x) walk(v, k);
    else if (x && typeof x === 'object') for (const [kk, v] of Object.entries(x)) walk(v, kk);
  };
  walk(args);
  // 分区表操作涉及祖先父表和有效列（用于并发冲突检测）
  for (const i of [...out]) {
    const o = m.objects[i];
    if (o?.kind === 'table' && o.partitionOf) {
      let cur: string | null = o.partitionOf.parent;
      const seen = new Set<string>([o.id]);
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const p: Obj | undefined = m.objects[cur];
        if (p?.kind !== 'table') break;
        out.add(p.id);
        cur = p.partitionOf?.parent ?? null;
      }
      for (const c of columnsOf(m, rootTableId(m, o.id))) out.add(c.id);
    }
  }
  if (exprs.length) {
    const d = getDialect(m.dialect);
    // 表达式所在的表：参数里的表，或参数里对象所在的表
    const tables = new Set<string>();
    for (const i of out) {
      const o = m.objects[i]!;
      if (o.kind === 'table') tables.add(o.id);
      else if ('parent' in o && m.objects[o.parent]?.kind === 'table') tables.add(o.parent);
    }
    // 每个表达式只分词一次，再与各列名求交（原先按列逐个重新分词）
    const refSets = exprs.map((e) => exprRefNames(m.dialect, e, (x) => d.columnRefs(x)));
    for (const t of tables)
      for (const c of effectiveColumnsOf(m, t))
        if (refSets.some((r) => refsHaveName(m.dialect, r, c.name))) out.add(c.id);
  }
  return [...out];
};

/**
 * batch 的依据：在模型副本上逐步执行子操作，每一步执行前按该子操作计算依据，
 * 只保留整批开始前就存在的对象（本批新建的对象不是外部依据）。绝不扫描 summary（自由文本可能恰好等于某个对象 ID）。
 * 某一步执行失败就停止（整批注定会被拒绝），已收集的依据照常返回。
 */
const batchReadsOf = (m: Model, args: unknown): string[] => {
  const parsed = batchArgs.safeParse(args);
  if (!parsed.success) return [];
  const out = new Set<string>();
  const stepModel = structuredClone(m);
  for (const op of parsed.data.ops) {
    if (COMPOSITE_MUTATORS.has(op.name)) break;
    for (const id of readsOf(stepModel, op.args, op.name)) {
      if (Object.hasOwn(m.objects, id)) out.add(id);
    }
    try {
      runMutator(stepModel, op.name, op.args);
    } catch (e) {
      if (e instanceof E.EditError) break;
      throw e;
    }
  }
  return [...out];
};
