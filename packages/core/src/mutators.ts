// mutator 注册表：同步层里每个修改都是“操作名 + 参数”（04-ir-design.md 第 2 节）。
// 客户端乐观执行，服务器在最新状态上重新执行；参数由服务器用 zod 校验，不信任客户端。
import { z } from 'zod';

import * as E from './edit.ts';
import {
  ColumnDefault,
  ColumnExt,
  FkAction,
  IndexElement,
  IndexExt,
  type Model,
  type Obj,
  PartitionSpec,
  PrimaryKeyExt,
  SequenceOptions,
  TableExt,
  UniqueExt,
} from './ir.ts';
import { columnsOf, effectiveColumnsOf, rootTableId } from './model.ts';
import { getDialect } from './registry.ts';

const id = z.string().min(1).max(64);
const name = z.string().min(1).max(128);

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

  createEnum: def(z.object({ id, schema: id, name, values: z.array(z.string().min(1)).min(1) }), (m, a) =>
    E.createEnum(m, a.schema, a.name, a.values, a.id),
  ),
  renameEnum: def(z.object({ id, name }), (m, a) => E.renameEnum(m, a.id, a.name)),
  addEnumValue: def(
    z.object({ id, value: z.string().min(1), index: z.number().int().min(0).optional() }),
    (m, a) => E.addEnumValue(m, a.id, a.value, a.index),
  ),
  dropEnum: def(z.object({ id }), (m, a) => E.dropEnum(m, a.id)),

  createSequence: def(
    z.object({ id, schema: id, name, options: SequenceOptions.partial().optional() }),
    (m, a) => E.createSequence(m, a.schema, a.name, a.options ?? {}, a.id),
  ),
  renameSequence: def(z.object({ id, name }), (m, a) => E.renameSequence(m, a.id, a.name)),
  dropSequence: def(z.object({ id }), (m, a) => E.dropSequence(m, a.id)),

  createTable: def(
    z.object({
      id,
      schema: id,
      name,
      partitionBy: PartitionSpec.nullable().optional(),
      ext: TableExt.optional(),
    }),
    (m, a) => E.createTable(m, a.schema, a.name, a.id, a.partitionBy ?? null, a.ext),
  ),
  renameTable: def(z.object({ id, name }), (m, a) => E.renameTable(m, a.id, a.name)),
  dropTable: def(z.object({ id }), (m, a) => E.dropTable(m, a.id)),
  setTableExt: def(z.object({ id, ext: TableExt.nullable() }), (m, a) => E.setTableExt(m, a.id, a.ext)),

  setPartitionBy: def(z.object({ id, partitionBy: PartitionSpec.nullable() }), (m, a) =>
    E.setPartitionBy(m, a.id, a.partitionBy),
  ),
  createPartition: def(
    z.object({ id, parent: id, name, bound: z.string().min(1), schema: id.optional() }),
    (m, a) => E.createPartition(m, a.parent, a.name, a.bound, a.id, a.schema),
  ),
  setPartitionBound: def(z.object({ id, bound: z.string().min(1) }), (m, a) =>
    E.setPartitionBound(m, a.id, a.bound),
  ),
  attachPartition: def(z.object({ parent: id, child: id, bound: z.string().min(1) }), (m, a) =>
    E.attachPartition(m, a.parent, a.child, a.bound),
  ),
  detachPartition: def(z.object({ id }), (m, a) => E.detachPartition(m, a.id)),

  addColumn: def(
    z.object({
      table: id,
      column: z.object({
        id,
        name,
        type: z.string(),
        typeRef: id.nullable().optional(),
        notNull: z.boolean().optional(),
        default: ColumnDefault.nullable().optional(),
        identity: z.object({ always: z.boolean() }).nullable().optional(),
        generated: z
          .object({ expr: z.string().min(1), stored: z.boolean() })
          .nullable()
          .optional(),
        collation: z.string().nullable().optional(),
        before: id.optional(),
        ext: ColumnExt.optional(),
      }),
    }),
    (m, a) => E.addColumn(m, a.table, a.column),
  ),
  renameColumn: def(z.object({ id, name }), (m, a) => E.renameColumn(m, a.id, a.name)),
  dropColumn: def(z.object({ id }), (m, a) => E.dropColumn(m, a.id)),
  setColumnType: def(z.object({ id, type: z.string(), typeRef: id.nullable() }), (m, a) =>
    E.setColumnType(m, a.id, a.type, a.typeRef),
  ),
  setNotNull: def(z.object({ id, notNull: z.boolean() }), (m, a) => E.setNotNull(m, a.id, a.notNull)),
  setDefault: def(z.object({ id, default: ColumnDefault.nullable() }), (m, a) =>
    E.setDefault(m, a.id, a.default),
  ),
  setIdentity: def(z.object({ id, identity: z.object({ always: z.boolean() }).nullable() }), (m, a) =>
    E.setIdentity(m, a.id, a.identity),
  ),
  setColumnExt: def(z.object({ id, ext: ColumnExt.nullable() }), (m, a) => E.setColumnExt(m, a.id, a.ext)),
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
  addCheck: def(z.object({ id, table: id, expr: z.string().min(1) }), (m, a) =>
    E.addCheck(m, a.table, a.expr, a.id),
  ),
  setCheckExpr: def(z.object({ id, expr: z.string().min(1) }), (m, a) => setCheckExpr(m, a.id, a.expr)),
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
      elements: z.array(IndexElement.partial()).min(1),
      unique: z.boolean().optional(),
      method: z.string().optional(),
      include: z.array(id).optional(),
      where: z.string().nullable().optional(),
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

  setComment: def(z.object({ id, comment: z.string().nullable() }), (m, a) =>
    E.setComment(m, a.id, a.comment),
  ),
};

export type MutatorName = keyof typeof mutators;
export type MutatorArgs<K extends MutatorName> = z.infer<(typeof mutators)[K]['args']>;

/** 执行一个修改：校验参数后在模型上执行（直接修改传入的模型）。参数不合法或操作不合法抛 EditError */
export const runMutator = (m: Model, name: string, args: unknown) => {
  const mu = (mutators as Record<string, { args: z.ZodType; run: (m: Model, a: unknown) => unknown }>)[name];
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
export const readsOf = (m: Model, args: unknown): string[] => {
  const out = new Set<string>();
  const exprs: string[] = [];
  const walk = (x: unknown, k?: string) => {
    if (typeof x === 'string') {
      if (x in m.objects) out.add(x);
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
    for (const t of tables)
      for (const c of effectiveColumnsOf(m, t))
        if (exprs.some((e) => d.exprReferences(e, c.name))) out.add(c.id);
  }
  return [...out];
};
