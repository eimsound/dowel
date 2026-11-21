// 编辑操作：在模型上做一次有语义的修改（直接修改传入的模型）。
// 这些操作就是同步层的 mutator（04-ir-design.md 第 2 节）：客户端乐观执行，服务器在最新状态上重新执行并校验。
import { generateKeyBetween } from 'fractional-indexing';

import { EditError } from './errors.ts';
import { newId } from './ids.ts';
import type {
  Check,
  Column,
  ColumnDefault,
  Enum,
  ForeignKey,
  Index,
  IndexElement,
  Model,
  Obj,
  PartitionSpec,
  PrimaryKey,
  Schema,
  Sequence,
  SequenceOptions,
  Table,
  Unique,
} from './ir.ts';
import { deepEqual } from './json.ts';
import {
  all,
  childrenOf,
  colName,
  columnsOf,
  effectiveColumnsOf,
  find,
  get,
  indexElementNames,
  partitionDescendants,
  partitionsOf,
  rootTableId,
} from './model.ts';
import {
  columnRefs,
  exprReferences,
  renameInExpr,
  renameQualifiedInExpr,
  type Token,
  tokenize,
} from './pg/expr.ts';
import { chooseName, joinNames } from './pg/naming.ts';
import {
  derivedUuid,
  parsePartitionBound,
  partitionKeyColumns,
  resolvePartitionBy,
  validatePartitionBound,
} from './pg/partition.ts';
import { KEYWORDS } from './pg/quote.ts';

export { EditError, exprReferences, renameInExpr, renameQualifiedInExpr, type Token, tokenize };

// ───── 表达式里的标识符 ─────

/**
 * 校验表达式里的列引用都是本表存在的列（关键字除外）。
 * 只能发现明显的错误（如列已被改名、删除）；完整的语义校验由影子库完成。
 */
export const checkExprColumns = (m: Model, table: string, expr: string) => {
  const names = new Set(effectiveColumnsOf(m, table).map((c) => c.name));
  const unknown = columnRefs(expr)
    .filter((t) => !names.has(t.text) && !(t.kind === 'ident' && KEYWORDS.has(t.text)))
    .map((t) => t.text);
  if (unknown.length) throw new EditError(`表达式引用了不存在的列：${[...new Set(unknown)].join('、')}`);
};

/** 对模型里所有表达式应用同一个改写 */
export const rewriteExprs = (m: Model, f: (expr: string) => string) => {
  for (const o of Object.values(m.objects)) {
    if (o.kind === 'table' && o.partitionBy && typeof o.partitionBy !== 'string') {
      for (const k of o.partitionBy.keys) if (k.expr) k.expr = f(k.expr);
    }
    if (o.kind === 'check') o.expr = f(o.expr);
    if (o.kind === 'index') {
      for (const e of o.elements) if (e.expr) e.expr = f(e.expr);
      if (o.where) o.where = f(o.where);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = f(o.generated.expr);
      if (o.default && 'expr' in o.default) o.default.expr = f(o.default.expr);
    }
  }
};

// ───── 命名 ─────

const schemaOf = (m: Model, tableId: string) => get(m, tableId, 'table').parent;

/** 某个名字在关系命名空间（同 schema 的表、序列、索引）里是否被别的对象占用 */
const relTaken = (m: Model, schema: string, name: string, self: string) =>
  Object.values(m.objects).some((o) => {
    if (o.id === self) return false;
    if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schema) return o.name === name;
    if (
      (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') &&
      schemaOf(m, o.parent) === schema
    )
      return o.name === name;
    if (o.kind === 'column' && o.identity && self !== `${o.id}#seq` && schemaOf(m, o.parent) === schema)
      return o.identity.sequenceName === name;
    return false;
  });
/** 某个名字在表的约束命名空间里是否被别的对象占用 */
const conTaken = (m: Model, table: string, name: string, self: string) =>
  Object.values(m.objects).some((o) => {
    if (o.id === self) return false;
    if (
      (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
      o.parent === table
    )
      return o.name === name;
    if (o.kind === 'column' && o.parent === table && o.notNull && self !== `${o.id}#nn`)
      return o.notNullName === name;
    return false;
  });

/** 重新计算一张表上所有推导名（改表名、改列名、改约束列之后调用） */
export const refreshDerivedNames = (m: Model, tableId: string) => {
  const t = get(m, tableId, 'table');
  const schema = t.parent;
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    chooseName(
      n1,
      n2,
      label,
      (n) => (rel && relTaken(m, schema, n, id)) || (con && conTaken(m, tableId, n, id)),
    );
  for (const c of columnsOf(m, tableId)) {
    if (c.notNull && c.notNullNameMode === 'derived')
      c.notNullName = choose(`${c.id}#nn`, t.name, c.name, 'not_null', false, true);
    if (c.identity?.sequenceNameMode === 'derived')
      c.identity.sequenceName = choose(`${c.id}#seq`, t.name, c.name, 'seq', true, false);
    for (const s of all(m, 'sequence'))
      if (s.ownedBy === c.id && s.nameMode === 'derived')
        s.name = choose(s.id, t.name, c.name, 'seq', true, false);
  }
  for (const o of Object.values(m.objects)) {
    if (!('parent' in o) || o.parent !== tableId || !('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey':
        o.name = choose(o.id, t.name, null, 'pkey', true, true);
        break;
      case 'unique':
        o.name = choose(o.id, t.name, joinCols(m, o.columns), 'key', true, true);
        break;
      case 'foreignKey':
        o.name = choose(o.id, t.name, joinCols(m, o.columns), 'fkey', false, true);
        break;
      case 'check': {
        const refs = effectiveColumnsOf(m, tableId).filter((c) => exprReferences(o.expr, c.name));
        o.name = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        break;
      }
      case 'index':
        o.name = choose(o.id, t.name, joinIdx(indexElementNames(m, o)), 'idx', true, false);
        break;
    }
  }
};
const joinCols = (m: Model, ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
const joinIdx = (names: string[]) => joinNames(names);

// ───── schema ─────

export const createSchema = (m: Model, name: string, id = newId()): string => {
  if (all(m, 'schema').some((s) => s.name === name)) throw new EditError(`schema ${name} 已存在`);
  const o: Schema = { id, kind: 'schema', name, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameSchema = (m: Model, id: string, name: string) => {
  if (all(m, 'schema').some((s) => s.name === name && s.id !== id))
    throw new EditError(`schema ${name} 已存在`);
  const s = get(m, id, 'schema');
  const old = s.name;
  s.name = name;
  rewriteExprs(m, (e) => renameQualifiedInExpr(e, old, null, { schema: name, name: null }));
};

export const dropSchema = (m: Model, id: string) => {
  for (const t of childrenOf(m, id, 'table')) dropTable(m, t.id);
  for (const s of childrenOf(m, id, 'sequence')) dropSequence(m, s.id);
  for (const e of childrenOf(m, id, 'enum')) dropEnum(m, e.id);
  delete m.objects[id];
};

// ───── 枚举、序列 ─────

const typeTaken = (m: Model, schema: string, name: string, self: string) =>
  Object.values(m.objects).some(
    (o) =>
      o.id !== self && (o.kind === 'enum' || o.kind === 'table') && o.parent === schema && o.name === name,
  );

export const createEnum = (
  m: Model,
  schema: string,
  name: string,
  values: string[],
  id = newId(),
): string => {
  get(m, schema, 'schema');
  if (typeTaken(m, schema, name, '')) throw new EditError(`类型名 ${name} 已被占用`);
  if (!values.length || new Set(values).size !== values.length) throw new EditError('枚举值不能为空或重复');
  const o: Enum = { id, kind: 'enum', parent: schema, name, values, comment: null };
  m.objects[o.id] = o;
  return o.id;
};

export const renameEnum = (m: Model, id: string, name: string) => {
  const e = get(m, id, 'enum');
  if (typeTaken(m, e.parent, name, id)) throw new EditError(`类型名 ${name} 已被占用`);
  const schema = get(m, e.parent, 'schema').name;
  const old = e.name;
  e.name = name;
  rewriteExprs(m, (x) => renameQualifiedInExpr(x, schema, old, { schema, name }));
};

/** 在第 index 个位置插入新值（PG 只支持新增，不支持删除或重排） */
export const addEnumValue = (m: Model, id: string, value: string, index?: number) => {
  const e = get(m, id, 'enum');
  if (e.values.includes(value)) throw new EditError(`枚举值 ${value} 已存在`);
  e.values.splice(index ?? e.values.length, 0, value);
};

export const dropEnum = (m: Model, id: string) => {
  get(m, id, 'enum');
  if (all(m, 'column').some((c) => c.typeRef === id)) throw new EditError('枚举仍被列使用');
  delete m.objects[id];
};

export const createSequence = (
  m: Model,
  schema: string,
  name: string,
  options: Partial<SequenceOptions> = {},
  id = newId(),
): string => {
  get(m, schema, 'schema');
  if (relTaken(m, schema, name, '')) throw new EditError(`名字 ${name} 已被占用`);
  const o: Sequence = {
    id,
    kind: 'sequence',
    parent: schema,
    name,
    nameMode: 'explicit',
    ownedBy: null,
    options: {
      type: 'bigint',
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
      ...options,
    },
    comment: null,
  };
  m.objects[o.id] = o;
  return o.id;
};

export const renameSequence = (m: Model, id: string, name: string) => {
  const s = get(m, id, 'sequence');
  if (relTaken(m, s.parent, name, id)) throw new EditError(`名字 ${name} 已被占用`);
  s.name = name;
  s.nameMode = 'explicit';
};

export const dropSequence = (m: Model, id: string) => {
  get(m, id, 'sequence');
  for (const c of all(m, 'column'))
    if (c.default && 'nextval' in c.default && c.default.nextval === id) c.default = null;
  delete m.objects[id];
};

// ───── 表 ─────

export const createTable = (
  m: Model,
  schema: string,
  name: string,
  id = newId(),
  partitionBy: PartitionSpec | null = null,
): string => {
  get(m, schema, 'schema');
  if (relTaken(m, schema, name, '') || typeTaken(m, schema, name, ''))
    throw new EditError(`名字 ${name} 已被占用`);
  const o: Table = {
    id,
    kind: 'table',
    parent: schema,
    name,
    partitionBy: null,
    partitionOf: null,
    comment: null,
  };
  m.objects[o.id] = o;
  if (partitionBy !== null) {
    try {
      setPartitionBy(m, o.id, partitionBy);
    } catch (e) {
      delete m.objects[o.id];
      throw e;
    }
  }
  return o.id;
};

export const renameTable = (m: Model, id: string, name: string) => {
  const t = get(m, id, 'table');
  if (relTaken(m, t.parent, name, id) || typeTaken(m, t.parent, name, id))
    throw new EditError(`名字 ${name} 已被占用`);
  t.name = name;
  refreshDerivedNames(m, id);
};

/** 删除依赖这些对象的不透明对象（视图、触发器等），与 PG 的 CASCADE 一致 */
const dropDependentOpaques = (m: Model, ids: Set<string>) => {
  for (let changed = true; changed;) {
    changed = false;
    for (const o of all(m, 'opaque')) {
      if (o.deps.some((d) => ids.has(d)) || ids.has(o.parent)) {
        ids.add(o.id);
        delete m.objects[o.id];
        changed = true;
      }
    }
  }
};

export const dropTable = (m: Model, id: string) => {
  get(m, id, 'table');
  // 级联删除其下所有子分区（支持多级），不留悬空 partitionOf
  for (const child of partitionsOf(m, id)) dropTable(m, child.id);
  dropDependentOpaques(m, new Set([id, ...childrenOf(m, id, 'column').map((c) => c.id)]));
  for (const fk of all(m, 'foreignKey')) if (fk.refTable === id && fk.parent !== id) delete m.objects[fk.id];
  for (const c of childrenOf(m, id, 'column')) {
    for (const s of all(m, 'sequence')) if (s.ownedBy === c.id) delete m.objects[s.id];
    delete m.objects[c.id];
  }
  for (const o of Object.values(m.objects)) if ('parent' in o && o.parent === id) delete m.objects[o.id];
  delete m.objects[id];
};

// ───── 分区 ─────

const assertNotPartitionChild = (m: Model, tableId: string) => {
  const t = get(m, tableId, 'table');
  if (t.partitionOf !== null)
    throw new EditError(`分区子表 ${t.name} 继承父表的列定义，不能直接添加、修改或删除列`);
};

const assertNotPartitionKeyCol = (m: Model, colId: string, action: string) => {
  const c = get(m, colId, 'column');
  const tables = [get(m, c.parent, 'table'), ...partitionDescendants(m, c.parent)];
  for (const t of tables) {
    if (!t.partitionBy) continue;
    const refs = partitionKeyColumns(m, t);
    if (refs.all.includes(colId)) {
      throw new EditError(`列 ${c.name} 被分区表 ${t.name} 的分区键引用，不能${action}`);
    }
  }
};

const assertSpecKeysValid = (m: Model, tableId: string, spec: PartitionSpec) => {
  if (!spec.keys.length) throw new EditError('至少需要一个分区键');
  if (spec.strategy === 'list' && spec.keys.length !== 1) throw new EditError('LIST 分区只能有 1 个分区键');
  const root = rootTableId(m, tableId);
  for (const k of spec.keys) {
    if (!!k.column === !!k.expr) throw new EditError('分区键必须且只能指定列或表达式之一');
    if (k.column) {
      const col = get(m, k.column, 'column');
      if (col.parent !== root && col.parent !== tableId) throw new EditError('分区键列不属于这张表');
      if (col.generated) throw new EditError(`生成列 ${col.name} 不能作为分区键`);
    } else if (k.expr) {
      checkExprColumns(m, tableId, k.expr);
    }
  }
};

const assertPartitionConstraintCompat = (
  spec: PartitionSpec,
  kind: 'primaryKey' | 'unique' | 'index',
  cols: string[],
  elements?: IndexElement[],
) => {
  const hasExprKey = spec.keys.some((k) => k.expr !== null);
  const directCols = spec.keys.flatMap((k) => (k.column ? [k.column] : []));
  if (kind === 'primaryKey' || kind === 'unique') {
    const label = kind === 'primaryKey' ? '主键' : '唯一约束';
    if (hasExprKey) throw new EditError(`包含表达式分区键的分区表不能创建${label}`);
    if (directCols.some((c) => !cols.includes(c)))
      throw new EditError(`分区表的${label}必须包含全部分区键列`);
    return;
  }
  if (hasExprKey) throw new EditError('包含表达式分区键的分区表不支持唯一索引');
  const els = elements ?? [];
  if (directCols.some((c) => !els.some((e) => e.column === c)))
    throw new EditError('分区表的唯一索引必须包含全部分区键');
};

const nextDetId = (m: Model, seed: string): string => {
  for (let i = 0; ; i++) {
    const candidate = derivedUuid(i === 0 ? seed : `${seed}#${i}`);
    if (!(candidate in m.objects)) return candidate;
  }
};

export const setPartitionBy = (m: Model, tableId: string, spec: PartitionSpec | null) => {
  const t = get(m, tableId, 'table');
  const children = partitionsOf(m, tableId);
  if (spec === null) {
    if (children.length > 0) throw new EditError('表下仍有子分区，请先删除或脱离全部子分区再取消分区');
    t.partitionBy = null;
    return;
  }
  assertSpecKeysValid(m, tableId, spec);
  for (const child of children) {
    const err = validatePartitionBound(spec.strategy, child.partitionOf!.bound, spec.keys.length);
    if (err) throw new EditError(`现有子分区 ${child.name} 与新分区策略不兼容：${err}`);
  }
  for (const pk of childrenOf(m, tableId, 'primaryKey'))
    assertPartitionConstraintCompat(spec, 'primaryKey', pk.columns);
  for (const u of childrenOf(m, tableId, 'unique'))
    assertPartitionConstraintCompat(spec, 'unique', u.columns);
  for (const x of childrenOf(m, tableId, 'index'))
    if (x.unique) assertPartitionConstraintCompat(spec, 'index', [], x.elements);
  for (const ck of childrenOf(m, tableId, 'check'))
    if (ck.noInherit) throw new EditError(`检查约束 ${ck.name} 设为 NO INHERIT，分区父表不支持`);
  t.partitionBy = structuredClone(spec);
};

export const createPartition = (
  m: Model,
  parentId: string,
  name: string,
  bound: string,
  id = newId(),
  schemaId?: string,
): string => {
  const parent = get(m, parentId, 'table');
  if (!parent.partitionBy) throw new EditError(`表 ${parent.name} 不是分区父表`);
  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parentId).some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default')
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }
  const schema = schemaId ?? parent.parent;
  get(m, schema, 'schema');
  if (relTaken(m, schema, name, '') || typeTaken(m, schema, name, ''))
    throw new EditError(`名字 ${name} 已被占用`);
  const o: Table = {
    id,
    kind: 'table',
    parent: schema,
    name,
    partitionBy: null,
    partitionOf: { parent: parentId, bound: trimmed },
    comment: null,
  };
  m.objects[o.id] = o;
  return o.id;
};

export const setPartitionBound = (m: Model, childId: string, bound: string) => {
  const child = get(m, childId, 'table');
  if (!child.partitionOf) throw new EditError(`表 ${child.name} 不是分区子表`);
  const parent = get(m, child.partitionOf.parent, 'table');
  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parent.id).some(
      (c) => c.id !== childId && parsePartitionBound(c.partitionOf!.bound)?.kind === 'default',
    )
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }
  child.partitionOf = { parent: child.partitionOf.parent, bound: trimmed };
};

const ancestorsOf = (m: Model, tableId: string): Table[] => {
  const out: Table[] = [];
  const seen = new Set<string>();
  let cur: string | null = tableId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t: Obj | undefined = m.objects[cur];
    if (t?.kind !== 'table') break;
    out.push(t);
    cur = t.partitionOf?.parent ?? null;
  }
  return out;
};

const remapColRefsOnTable = (m: Model, tableId: string, colMap: Map<string, string>) => {
  const mapCol = (c: string) => colMap.get(c) ?? c;
  const targets = new Set([tableId, ...partitionDescendants(m, tableId).map((d) => d.id)]);
  for (const o of Object.values(m.objects)) {
    if (o.kind === 'table' && targets.has(o.id) && o.partitionBy && typeof o.partitionBy !== 'string') {
      for (const k of o.partitionBy.keys) if (k.column) k.column = mapCol(k.column);
    }
    if (!('parent' in o) || !targets.has(o.parent)) continue;
    if (o.kind === 'primaryKey' || o.kind === 'unique') o.columns = o.columns.map(mapCol);
    else if (o.kind === 'foreignKey') {
      o.columns = o.columns.map(mapCol);
      if (targets.has(o.refTable)) o.refColumns = o.refColumns.map(mapCol);
    } else if (o.kind === 'index') {
      for (const el of o.elements) if (el.column) el.column = mapCol(el.column);
      o.include = o.include.map(mapCol);
    }
  }
};

export const attachPartition = (m: Model, parentId: string, childId: string, bound: string) => {
  const parent = get(m, parentId, 'table');
  const child = get(m, childId, 'table');
  if (parentId === childId) throw new EditError('不能将表挂载为自身的子分区');
  if (!parent.partitionBy) throw new EditError(`表 ${parent.name} 不是分区父表`);
  if (child.partitionOf !== null) throw new EditError(`表 ${child.name} 已经是子分区`);
  const ancestors = ancestorsOf(m, parentId);
  if (ancestors.some((a) => a.id === childId)) throw new EditError('不能形成循环分区引用');

  const spec = resolvePartitionBy(m, parent);
  if (!spec) throw new EditError(`无法解析表 ${parent.name} 的分区定义`);
  const trimmed = bound.trim();
  const err = validatePartitionBound(spec.strategy, trimmed, spec.keys.length);
  if (err) throw new EditError(err);
  if (
    parsePartitionBound(trimmed)?.kind === 'default' &&
    partitionsOf(m, parentId).some((c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default')
  ) {
    throw new EditError(`表 ${parent.name} 已有 DEFAULT 子分区`);
  }

  // 校验外部外键与序列归属
  if (all(m, 'foreignKey').some((fk) => fk.refTable === childId && fk.parent !== childId))
    throw new EditError(`表 ${child.name} 被其他表的外键引用，不能挂载为子分区`);
  const childCols = columnsOf(m, childId);
  const childColIds = new Set(childCols.map((c) => c.id));
  if (all(m, 'sequence').some((s) => s.ownedBy && childColIds.has(s.ownedBy)))
    throw new EditError(`表 ${child.name} 存在归属列的序列，请先解除序列归属后再挂载`);

  // 校验列与根父表一致
  const rootId = rootTableId(m, parentId);
  const rootCols = columnsOf(m, rootId);
  if (childCols.length !== rootCols.length)
    throw new EditError(
      `表 ${child.name} 的列数（${childCols.length}）与分区父表（${rootCols.length}）不一致`,
    );
  const colMap = new Map<string, string>();
  for (const rc of rootCols) {
    const cc = childCols.find((x) => x.name === rc.name);
    if (!cc) throw new EditError(`表 ${child.name} 缺少分区父表的列 ${rc.name}`);
    if (cc.identity)
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 为 IDENTITY，不能直接挂载为子分区`);
    if (
      cc.type !== rc.type ||
      cc.typeRef !== rc.typeRef ||
      cc.collation !== rc.collation ||
      !deepEqual(cc.generated, rc.generated)
    ) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 类型定义与分区父表不一致`);
    }
    if (cc.notNull !== rc.notNull) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 非空属性与分区父表不一致`);
    }
    if (!deepEqual(cc.default, rc.default)) {
      throw new EditError(`表 ${child.name} 的列 ${cc.name} 默认值与分区父表不一致`);
    }
    colMap.set(cc.id, rc.id);
  }

  // 校验子表主键与父表/祖先主键不冲突
  const ancestorIds = new Set(ancestors.map((a) => a.id));
  const ancPks = all(m, 'primaryKey').filter((k) => ancestorIds.has(k.parent));
  const childPk = childrenOf(m, childId, 'primaryKey')[0];
  if (childPk && ancPks.length > 0) {
    const mapped = childPk.columns.map((c) => colMap.get(c) ?? c);
    if (!ancPks.some((pk) => deepEqual(pk.columns, mapped))) {
      throw new EditError(`表 ${child.name} 的主键与分区父表不一致`);
    }
  }

  // 映射子表及其后代上的列引用
  remapColRefsOnTable(m, childId, colMap);
  for (const o of all(m, 'opaque')) {
    if (o.deps.some((d) => colMap.has(d))) {
      o.deps = [...new Set(o.deps.map((d) => colMap.get(d) ?? d))];
    }
  }

  // 移除将被父表吸收的重复约束/索引
  const ancUniques = all(m, 'unique').filter((u) => ancestorIds.has(u.parent));
  const ancChecks = all(m, 'check').filter((k) => ancestorIds.has(k.parent));
  const ancFks = all(m, 'foreignKey').filter((f) => ancestorIds.has(f.parent));
  const ancIdxs = all(m, 'index').filter((x) => ancestorIds.has(x.parent));

  if (childPk && ancPks.length > 0) delete m.objects[childPk.id];
  for (const u of childrenOf(m, childId, 'unique')) {
    if (
      ancUniques.some((au) => au.nullsNotDistinct === u.nullsNotDistinct && deepEqual(au.columns, u.columns))
    )
      delete m.objects[u.id];
  }
  for (const ck of childrenOf(m, childId, 'check')) {
    if (ancChecks.some((ak) => ak.name === ck.name && ak.expr === ck.expr)) delete m.objects[ck.id];
  }
  for (const fk of childrenOf(m, childId, 'foreignKey')) {
    if (
      ancFks.some(
        (af) =>
          deepEqual(af.columns, fk.columns) &&
          af.refTable === fk.refTable &&
          deepEqual(af.refColumns, fk.refColumns) &&
          af.onDelete === fk.onDelete &&
          af.onUpdate === fk.onUpdate &&
          af.match === fk.match &&
          af.deferrable === fk.deferrable &&
          af.initiallyDeferred === fk.initiallyDeferred,
      )
    ) {
      delete m.objects[fk.id];
    }
  }
  for (const idx of childrenOf(m, childId, 'index')) {
    if (
      ancIdxs.some(
        (ax) =>
          ax.unique === idx.unique &&
          ax.method === idx.method &&
          deepEqual(ax.elements, idx.elements) &&
          deepEqual(ax.include, idx.include) &&
          ax.where === idx.where &&
          ax.nullsNotDistinct === idx.nullsNotDistinct,
      )
    ) {
      delete m.objects[idx.id];
    }
  }

  // 删除子表自有列对象，改为继承父表列定义
  for (const cc of childCols) delete m.objects[cc.id];
  child.partitionOf = { parent: parentId, bound: trimmed };
};

export const detachPartition = (m: Model, childId: string) => {
  const child = get(m, childId, 'table');
  if (!child.partitionOf) throw new EditError(`表 ${child.name} 不是分区子表`);
  const parentId = child.partitionOf.parent;
  const ancestors = ancestorsOf(m, parentId);
  const rootId = rootTableId(m, childId);
  const rootCols = columnsOf(m, rootId);

  child.partitionOf = null;

  // 物化根父表的列到脱离后的独立表（使用确定性 ID 保证协作同步一致）
  const colMap = new Map<string, string>();
  for (const rc of rootCols) {
    const cid = nextDetId(m, `${childId}:col:${rc.id}`);
    colMap.set(rc.id, cid);
    const col: Column = {
      id: cid,
      kind: 'column',
      parent: childId,
      name: rc.name,
      pos: rc.pos,
      type: rc.type,
      typeRef: rc.typeRef,
      notNull: rc.notNull,
      notNullName: null,
      notNullNameMode: 'derived',
      default: rc.default ? structuredClone(rc.default) : null,
      identity: null, // PG 子分区不继承 attidentity
      generated: rc.generated ? structuredClone(rc.generated) : null,
      collation: rc.collation,
      comment: null,
    };
    m.objects[cid] = col;
  }

  // 先将子表已有本地约束/索引及后代分区键的列引用映射到新物化的列 ID
  remapColRefsOnTable(m, childId, colMap);
  const childTree = new Set([childId, ...partitionDescendants(m, childId).map((d) => d.id)]);
  for (const o of all(m, 'opaque')) {
    if (childTree.has(o.parent) && o.deps.some((d) => colMap.has(d))) {
      o.deps = [...new Set(o.deps.map((d) => colMap.get(d) ?? d))];
    }
  }

  // 物化父表/祖先表上由 PG DETACH 自动转正为独立对象的约束与索引
  const mapCol = (c: string) => colMap.get(c) ?? c;
  for (const anc of ancestors) {
    for (const pk of childrenOf(m, anc.id, 'primaryKey')) {
      if (childrenOf(m, childId, 'primaryKey').length > 0) continue;
      const pid = nextDetId(m, `${childId}:con:${pk.id}`);
      m.objects[pid] = {
        id: pid,
        kind: 'primaryKey',
        parent: childId,
        name: '',
        nameMode: 'derived',
        columns: pk.columns.map(mapCol),
        comment: null,
      };
    }
    for (const u of childrenOf(m, anc.id, 'unique')) {
      const uid = nextDetId(m, `${childId}:con:${u.id}`);
      m.objects[uid] = {
        id: uid,
        kind: 'unique',
        parent: childId,
        name: '',
        nameMode: 'derived',
        columns: u.columns.map(mapCol),
        nullsNotDistinct: u.nullsNotDistinct,
        comment: null,
      };
    }
    for (const ck of childrenOf(m, anc.id, 'check')) {
      if (childrenOf(m, childId, 'check').some((x) => x.name === ck.name)) continue;
      const cid = nextDetId(m, `${childId}:con:${ck.id}`);
      m.objects[cid] = {
        id: cid,
        kind: 'check',
        parent: childId,
        name: ck.name,
        nameMode: 'explicit',
        expr: ck.expr,
        noInherit: false,
        comment: null,
      };
    }
    for (const fk of childrenOf(m, anc.id, 'foreignKey')) {
      if (childrenOf(m, childId, 'foreignKey').some((x) => x.name === fk.name)) continue;
      const fid = nextDetId(m, `${childId}:con:${fk.id}`);
      m.objects[fid] = {
        id: fid,
        kind: 'foreignKey',
        parent: childId,
        name: fk.name,
        nameMode: 'explicit',
        columns: fk.columns.map(mapCol),
        refTable: fk.refTable,
        refColumns: [...fk.refColumns],
        onDelete: fk.onDelete,
        onUpdate: fk.onUpdate,
        match: fk.match,
        deferrable: fk.deferrable,
        initiallyDeferred: fk.initiallyDeferred,
        comment: null,
      };
    }
    for (const idx of childrenOf(m, anc.id, 'index')) {
      const iid = nextDetId(m, `${childId}:idx:${idx.id}`);
      m.objects[iid] = {
        id: iid,
        kind: 'index',
        parent: childId,
        name: '',
        nameMode: 'derived',
        unique: idx.unique,
        method: idx.method,
        elements: idx.elements.map((e) => ({ ...e, column: e.column ? mapCol(e.column) : null })),
        include: idx.include.map(mapCol),
        where: idx.where,
        nullsNotDistinct: idx.nullsNotDistinct,
        comment: null,
      };
    }
  }

  refreshDerivedNames(m, childId);
};

// ───── 列 ─────

export interface ColumnSpec {
  name: string;
  type: string;
  typeRef?: string | null;
  notNull?: boolean;
  default?: ColumnDefault | null;
  identity?: { always: boolean } | null;
  generated?: { expr: string; stored: boolean } | null;
  collation?: string | null;
  /** 放在这一列之前；不传则放在最后 */
  before?: string;
  /** 指定 ID（同步层要求客户端和服务器执行同一修改时生成相同的 ID） */
  id?: string;
}

export const addColumn = (m: Model, table: string, spec: ColumnSpec): string => {
  const t = get(m, table, 'table');
  assertNotPartitionChild(m, table);
  const cols = columnsOf(m, table);
  if (cols.some((c) => c.name === spec.name)) throw new EditError(`列 ${spec.name} 已存在`);
  let pos: string;
  if (spec.before) {
    const i = cols.findIndex((c) => c.id === spec.before);
    pos = generateKeyBetween(cols[i - 1]?.pos ?? null, cols[i]!.pos);
  } else pos = generateKeyBetween(cols.at(-1)?.pos ?? null, null);
  const c: Column = {
    id: spec.id ?? newId(),
    kind: 'column',
    parent: table,
    name: spec.name,
    pos,
    type: spec.type,
    typeRef: spec.typeRef ?? null,
    notNull: !!(spec.notNull || spec.identity),
    notNullName: null,
    notNullNameMode: 'derived',
    default: spec.identity || spec.generated ? null : (spec.default ?? null),
    identity: spec.identity
      ? {
          always: spec.identity.always,
          sequenceName: '',
          sequenceNameMode: 'derived',
          options: {
            type: 'bigint',
            increment: '1',
            min: null,
            max: null,
            start: null,
            cache: '1',
            cycle: false,
          },
        }
      : null,
    generated: spec.generated ?? null,
    collation: spec.collation ?? null,
    comment: null,
  };
  if (c.identity) c.identity.options.type = identityType(c.type);
  m.objects[c.id] = c;
  refreshDerivedNames(m, t.id);
  return c.id;
};

const identityType = (type: string): SequenceOptions['type'] =>
  type === 'smallint' ? 'smallint' : type === 'integer' ? 'integer' : 'bigint';

export const renameColumn = (m: Model, id: string, name: string) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (columnsOf(m, c.parent).some((x) => x.name === name && x.id !== id))
    throw new EditError(`列 ${name} 已存在`);
  const old = c.name;
  c.name = name;
  // 同表及所有后代子分区表达式里对这一列的引用一起改写
  const affected = new Set([c.parent, ...partitionDescendants(m, c.parent).map((d) => d.id)]);
  for (const tid of affected) {
    const table = get(m, tid, 'table');
    if (table.partitionBy && typeof table.partitionBy !== 'string') {
      for (const k of table.partitionBy.keys) if (k.expr) k.expr = renameInExpr(k.expr, old, name);
    }
  }
  for (const o of Object.values(m.objects)) {
    if (!('parent' in o) || !affected.has(o.parent)) continue;
    if (o.kind === 'check') o.expr = renameInExpr(o.expr, old, name);
    if (o.kind === 'index') {
      for (const e of o.elements) if (e.expr) e.expr = renameInExpr(e.expr, old, name);
      if (o.where) o.where = renameInExpr(o.where, old, name);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = renameInExpr(o.generated.expr, old, name);
      if (o.default && 'expr' in o.default) o.default.expr = renameInExpr(o.default.expr, old, name);
    }
  }
  for (const tid of affected) refreshDerivedNames(m, tid);
};

/** 删列：依赖它的约束、索引、外键、生成列、属于它的序列一并删除 */
export const dropColumn = (m: Model, id: string) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  assertNotPartitionKeyCol(m, id, '删除');
  const affected = new Set([c.parent, ...partitionDescendants(m, c.parent).map((d) => d.id)]);
  const uses = (o: Obj): boolean => {
    switch (o.kind) {
      case 'primaryKey':
      case 'unique':
        return o.columns.includes(id);
      case 'foreignKey':
        return o.columns.includes(id) || o.refColumns.includes(id);
      case 'check':
        return affected.has(o.parent) && exprReferences(o.expr, c.name);
      case 'index':
        return (
          affected.has(o.parent) &&
          (o.elements.some((e) => e.column === id || (e.expr && exprReferences(e.expr, c.name))) ||
            o.include.includes(id) ||
            (!!o.where && exprReferences(o.where, c.name)))
        );
      case 'column':
        return (
          o.id !== id && o.parent === c.parent && !!o.generated && exprReferences(o.generated.expr, c.name)
        );
      case 'sequence':
        return o.ownedBy === id;
      default:
        return false;
    }
  };
  for (const o of Object.values(m.objects)) {
    if (!uses(o)) continue;
    if (o.kind === 'column') dropColumn(m, o.id);
    else delete m.objects[o.id];
  }
  dropDependentOpaques(m, new Set([id]));
  delete m.objects[id];
};

export const setColumnType = (m: Model, id: string, type: string, typeRef: string | null = null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  assertNotPartitionKeyCol(m, id, '修改类型');
  if (typeRef) get(m, typeRef, 'enum');
  c.type = type;
  c.typeRef = typeRef;
  if (c.identity) c.identity.options.type = identityType(type);
};

export const setNotNull = (m: Model, id: string, notNull: boolean) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (!notNull) {
    if (c.identity) throw new EditError('identity 列必须 NOT NULL');
    if (all(m, 'primaryKey').some((k) => k.columns.includes(id))) throw new EditError('主键列必须 NOT NULL');
  }
  c.notNull = notNull;
  c.notNullName = null;
  c.notNullNameMode = 'derived';
  refreshDerivedNames(m, c.parent);
};

export const setDefault = (m: Model, id: string, def: ColumnDefault | null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (def && (c.identity || c.generated)) throw new EditError('identity 列和生成列不能有默认值');
  if (def && 'nextval' in def) get(m, def.nextval, 'sequence');
  c.default = def;
};

export const setIdentity = (m: Model, id: string, identity: { always: boolean } | null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (!identity) {
    c.identity = null;
    return;
  }
  if (c.generated) throw new EditError('生成列不能是 identity');
  if (c.identity) {
    c.identity.always = identity.always;
    return;
  }
  c.default = null;
  c.notNull = true;
  c.identity = {
    always: identity.always,
    sequenceName: '',
    sequenceNameMode: 'derived',
    options: {
      type: identityType(c.type),
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
    },
  };
  refreshDerivedNames(m, c.parent);
};

export const moveColumn = (m: Model, id: string, before: string | null) => {
  const c = get(m, id, 'column');
  assertNotPartitionChild(m, c.parent);
  if (before === id) return;
  const cols = columnsOf(m, c.parent).filter((x) => x.id !== id);
  let i = before ? cols.findIndex((x) => x.id === before) : -1;
  if (i < 0) i = cols.length;
  c.pos = generateKeyBetween(cols[i - 1]?.pos ?? null, cols[i]?.pos ?? null);
};

// ───── 约束和索引 ─────

const keyBase = (table: string, id = newId()) => ({
  id,
  parent: table,
  name: '',
  nameMode: 'derived' as const,
  comment: null,
});
const checkCols = (m: Model, table: string, cols: string[]) => {
  if (!cols.length) throw new EditError('至少需要一列');
  const root = rootTableId(m, table);
  for (const c of cols) {
    const col = get(m, c, 'column');
    if (col.parent !== table && col.parent !== root) throw new EditError('列不属于这张表');
  }
};

export const addPrimaryKey = (m: Model, table: string, columns: string[], id = newId()): string => {
  checkCols(m, table, columns);
  const t = get(m, table, 'table');
  if (t.partitionBy && typeof t.partitionBy !== 'string')
    assertPartitionConstraintCompat(t.partitionBy, 'primaryKey', columns);
  if (childrenOf(m, table, 'primaryKey').length) throw new EditError('表已有主键');
  for (const c of columns) {
    const col = get(m, c, 'column');
    if (!col.notNull) {
      col.notNull = true;
      col.notNullNameMode = 'derived';
    }
  }
  const o: PrimaryKey = { ...keyBase(table, id), kind: 'primaryKey', columns };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  if (t.partitionOf) refreshDerivedNames(m, rootTableId(m, table));
  return o.id;
};

export const addUnique = (
  m: Model,
  table: string,
  columns: string[],
  nullsNotDistinct = false,
  id = newId(),
): string => {
  checkCols(m, table, columns);
  const t = get(m, table, 'table');
  if (t.partitionBy && typeof t.partitionBy !== 'string')
    assertPartitionConstraintCompat(t.partitionBy, 'unique', columns);
  const o: Unique = { ...keyBase(table, id), kind: 'unique', columns, nullsNotDistinct };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addCheck = (m: Model, table: string, expr: string, id = newId(), noInherit = false): string => {
  const t = get(m, table, 'table');
  if (noInherit && t.partitionBy !== null) throw new EditError('分区父表的 CHECK 约束不能设为 NO INHERIT');
  checkExprColumns(m, table, expr);
  const o: Check = { ...keyBase(table, id), kind: 'check', expr, noInherit };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addForeignKey = (
  m: Model,
  table: string,
  columns: string[],
  refTable: string,
  refColumns: string[],
  opts: Partial<
    Pick<ForeignKey, 'onDelete' | 'onUpdate' | 'match' | 'deferrable' | 'initiallyDeferred'>
  > = {},
  id = newId(),
): string => {
  checkCols(m, table, columns);
  checkCols(m, refTable, refColumns);
  if (columns.length !== refColumns.length) throw new EditError('两边列数必须相同');
  const o: ForeignKey = {
    ...keyBase(table, id),
    kind: 'foreignKey',
    columns,
    refTable,
    refColumns,
    onDelete: 'noAction',
    onUpdate: 'noAction',
    match: 'simple',
    deferrable: false,
    initiallyDeferred: false,
    ...opts,
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

export const addIndex = (
  m: Model,
  table: string,
  elements: Partial<IndexElement>[],
  opts: Partial<Pick<Index, 'unique' | 'method' | 'include' | 'where' | 'nullsNotDistinct'>> = {},
  id = newId(),
): string => {
  const t = get(m, table, 'table');
  const fullElements: IndexElement[] = elements.map((e) => ({
    column: null,
    expr: null,
    desc: false,
    nullsFirst: null,
    opclass: null,
    collation: null,
    ...e,
  }));
  const elCols = fullElements.flatMap((e) => (e.column ? [e.column] : []));
  if (elCols.length) checkCols(m, table, elCols);
  if (opts.include?.length) checkCols(m, table, opts.include);
  for (const e of fullElements) if (e.expr) checkExprColumns(m, table, e.expr);
  if (opts.where) checkExprColumns(m, table, opts.where);
  if (opts.unique && t.partitionBy && typeof t.partitionBy !== 'string') {
    assertPartitionConstraintCompat(t.partitionBy, 'index', [], fullElements);
  }
  const o: Index = {
    ...keyBase(table, id),
    kind: 'index',
    unique: false,
    method: 'btree',
    include: [],
    where: null,
    nullsNotDistinct: false,
    ...opts,
    elements: fullElements,
  };
  m.objects[o.id] = o;
  refreshDerivedNames(m, table);
  return o.id;
};

/** 删约束或索引；删主键、唯一约束、唯一索引时，依赖它的外键一并删除 */
export const dropKey = (m: Model, id: string) => {
  const o = get(m, id);
  if (
    !(
      o.kind === 'primaryKey' ||
      o.kind === 'unique' ||
      o.kind === 'foreignKey' ||
      o.kind === 'check' ||
      o.kind === 'index'
    )
  )
    throw new EditError('不是约束或索引');
  const keyCols =
    o.kind === 'primaryKey' || o.kind === 'unique'
      ? o.columns
      : o.kind === 'index' && o.unique && o.elements.every((e) => e.column) && !o.where
        ? o.elements.map((e) => e.column!)
        : null;
  if (keyCols) {
    const set = [...keyCols].sort().join();
    for (const fk of all(m, 'foreignKey'))
      if (fk.refTable === o.parent && [...fk.refColumns].sort().join() === set) delete m.objects[fk.id];
  }
  delete m.objects[id];
};

/** 给约束或索引起一个显式名字（之后不再跟着改名） */
export const renameKey = (m: Model, id: string, name: string) => {
  const o = get(m, id);
  if (
    !(
      o.kind === 'primaryKey' ||
      o.kind === 'unique' ||
      o.kind === 'foreignKey' ||
      o.kind === 'check' ||
      o.kind === 'index'
    )
  )
    throw new EditError('不是约束或索引');
  const rel = o.kind !== 'check' && o.kind !== 'foreignKey';
  const con = o.kind !== 'index';
  if ((rel && relTaken(m, schemaOf(m, o.parent), name, id)) || (con && conTaken(m, o.parent, name, id)))
    throw new EditError(`名字 ${name} 已被占用`);
  o.name = name;
  o.nameMode = 'explicit';
};

/** 把名字恢复为自动推导 */
export const resetKeyName = (m: Model, id: string) => {
  const o = get(m, id);
  if ('nameMode' in o && o.kind !== 'sequence') {
    o.nameMode = 'derived';
    refreshDerivedNames(m, o.parent);
  }
};

export const setComment = (m: Model, id: string, comment: string | null) => {
  get(m, id).comment = comment;
};

export const findTable = (m: Model, schema: string, name: string): Table | undefined =>
  all(m, 'table').find((t) => t.name === name && find(m, t.parent)?.name === schema);
