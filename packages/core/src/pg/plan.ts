// 比较两个版本的 IR，生成 PG 迁移语句。
// 规划时维护一份“当前状态” cur：每生成一步就把它更新到执行这一步之后的样子，
// 所以每条语句引用的都是当时实际存在的名字；结束时断言 cur 等于目标版本。

import { exprReferences, normalizeAllPartitionFamilies, renameInExpr } from '../edit.ts';
import type {
  Check,
  Column,
  Constraint,
  Enum,
  ForeignKey,
  Index,
  Model,
  Obj,
  Opaque,
  PartitionSpec,
  PrimaryKey,
  Schema,
  Sequence,
  SequenceOptions,
  Table,
  Unique,
} from '../ir.ts';
import { EARLY_OPAQUE } from '../ir.ts';
import { clonePlain, deepEqual } from '../json.ts';
import {
  all,
  buildModelIndex,
  childrenOf,
  columnsOf,
  find,
  get,
  indexElementNames,
  partitionAncestors,
  partitionBySql,
  partitionDepth,
  partitionDescendants,
  qname,
  rootTableId,
  withModelIndex,
} from '../model.ts';
import { PlanError, type Step } from '../plan-types.ts';
import { checkPgCompatibility, LATEST_PG_MAJOR, pgCapabilities, type PlanOptions } from './capabilities.ts';
import { qualifiedRefs, remapQualifiedInExpr, tokenize } from './expr.ts';
import { chooseName, joinNames } from './naming.ts';
import { derivedUuid, partitionKeyColumns } from './partition.ts';
import { ident, literal, qualified } from './quote.ts';

export { PlanError, type Step };

const clone = clonePlain;
/** 新建的对象此时还没有注释，注释在最后一个阶段统一加 */
const fresh = <T extends Obj>(o: T): T => ({ ...clonePlain(o), comment: null });
const same = deepEqual;

const sameStrArr = (a: readonly string[], b: readonly string[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const sameSeqOpts = (a: SequenceOptions, b: SequenceOptions): boolean =>
  a === b ||
  (a.type === b.type &&
    a.increment === b.increment &&
    a.min === b.min &&
    a.max === b.max &&
    a.start === b.start &&
    a.cache === b.cache &&
    a.cycle === b.cycle);

const sameDefault = (a: Column['default'], b: Column['default']): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  if ('expr' in a && 'expr' in b) return a.expr === b.expr;
  if ('nextval' in a && 'nextval' in b) return a.nextval === b.nextval;
  return false;
};

const sameIdentity = (a: Column['identity'], b: Column['identity']): boolean =>
  a === b ||
  (Boolean(a && b) &&
    a!.always === b!.always &&
    a!.sequenceName === b!.sequenceName &&
    a!.sequenceNameMode === b!.sequenceNameMode &&
    sameSeqOpts(a!.options, b!.options));

const sameGenerated = (a: Column['generated'], b: Column['generated']): boolean =>
  a === b || (Boolean(a && b) && a!.expr === b!.expr && a!.stored === b!.stored);

const samePartitionOf = (a: Table['partitionOf'], b: Table['partitionOf']): boolean =>
  a === b || (Boolean(a && b) && a!.parent === b!.parent && a!.bound === b!.bound);

const sameIndexElements = (a: Index['elements'], b: Index['elements']): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x !== y &&
      (x.column !== y.column ||
        x.expr !== y.expr ||
        x.desc !== y.desc ||
        x.nullsFirst !== y.nullsFirst ||
        x.opclass !== y.opclass ||
        x.collation !== y.collation)
    ) {
      return false;
    }
  }
  return true;
};

const sameColType = (a: Column, b: Column): boolean =>
  a.type === b.type && a.typeRef === b.typeRef && a.collation === b.collation;

/** 零分配判断两个同类对象定义是否相等，语义与 deepEqual(definition(a), definition(b)) 完全一致 */
const sameDef = (a: Obj, b: Obj, mA?: Model, mB?: Model, fallbackA?: Model): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'schema':
      return true;
    case 'table': {
      const tb = b as Table;
      if (!samePartitionOf(a.partitionOf, tb.partitionOf)) return false;
      if (a.partitionBy === null && tb.partitionBy === null) return true;
      const pa = mA ? partitionBySql(mA, a, fallbackA) : a.partitionBy;
      const pb = mB ? partitionBySql(mB, tb) : tb.partitionBy;
      return typeof pa === 'string' || typeof pb === 'string' ? pa === pb : same(pa, pb);
    }
    case 'extension':
      return a.name === (b as typeof a).name && a.parent === (b as typeof a).parent;
    case 'opaque': {
      const ob = b as Opaque;
      return (
        a.objType === ob.objType && a.name === ob.name && a.drop === ob.drop && sameStrArr(a.ddl, ob.ddl)
      );
    }
    case 'enum':
      return sameStrArr(a.values, (b as Enum).values);
    case 'sequence': {
      const sb = b as Sequence;
      return a.ownedBy === sb.ownedBy && sameSeqOpts(a.options, sb.options);
    }
    case 'column': {
      const cb = b as Column;
      return (
        a.type === cb.type &&
        a.typeRef === cb.typeRef &&
        a.collation === cb.collation &&
        a.notNull === cb.notNull &&
        sameDefault(a.default, cb.default) &&
        sameIdentity(a.identity, cb.identity) &&
        sameGenerated(a.generated, cb.generated)
      );
    }
    case 'primaryKey':
      return sameStrArr(a.columns, (b as PrimaryKey).columns);
    case 'unique': {
      const ub = b as Unique;
      return a.nullsNotDistinct === ub.nullsNotDistinct && sameStrArr(a.columns, ub.columns);
    }
    case 'foreignKey': {
      const fb = b as ForeignKey;
      return (
        a.refTable === fb.refTable &&
        a.onDelete === fb.onDelete &&
        a.onUpdate === fb.onUpdate &&
        a.match === fb.match &&
        a.deferrable === fb.deferrable &&
        a.initiallyDeferred === fb.initiallyDeferred &&
        sameStrArr(a.columns, fb.columns) &&
        sameStrArr(a.refColumns, fb.refColumns)
      );
    }
    case 'check': {
      const kb = b as Check;
      return a.expr === kb.expr && a.noInherit === kb.noInherit;
    }
    case 'index': {
      const ib = b as Index;
      return (
        a.unique === ib.unique &&
        a.method === ib.method &&
        a.where === ib.where &&
        a.nullsNotDistinct === ib.nullsNotDistinct &&
        sameStrArr(a.include, ib.include) &&
        sameIndexElements(a.elements, ib.elements)
      );
    }
  }
};

/** 表达式文本里出现的标识符（粗略：去掉字符串字面量后按词切分），用于判断表达式是否引用了某列 */
const identsIn = (expr: string): Set<string> => {
  const s = expr.replace(/'(?:[^']|'')*'/g, ' ');
  const out = new Set<string>();
  for (const m of s.matchAll(/"((?:[^"]|"")+)"|([A-Za-z_][A-Za-z0-9_$]*)/g)) {
    out.add(m[1] !== undefined ? m[1].replaceAll('""', '"') : m[2]!.toLowerCase());
  }
  return out;
};

const NUMERIC = new Set(['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision']);
const TEXTLIKE = new Set(['text', 'character varying', 'character']);
const baseType = (t: string) =>
  t
    .replace(/\([^)]*\)/g, '')
    .replace(/(\[\])+$/, '')
    .trim();
const arrayDims = (t: string) => /(\[\])*$/.exec(t)![0];
/**
 * 两种类型之间是否一定有直接转换（pg_cast）。没把握时经由 text 转换：
 * 任何类型都能转成 text，text 也能通过输入函数转成任何类型。
 */
export const hasDirectCast = (from: string, to: string): boolean => {
  if (arrayDims(from) !== arrayDims(to)) return false;
  const a = baseType(from);
  const b = baseType(to);
  return a === b || (NUMERIC.has(a) && NUMERIC.has(b)) || TEXTLIKE.has(a) || TEXTLIKE.has(b);
};

const FK_ACTION: Record<ForeignKey['onDelete'], string> = {
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

const pickExprs = (o: Obj): Partial<Obj> =>
  o.kind === 'check'
    ? { expr: o.expr }
    : o.kind === 'index'
      ? { elements: clonePlain(o.elements), where: o.where }
      : {};

const OPAQUE_KIND_LABEL: Record<Opaque['objType'], string> = {
  domain: '域',
  type: '复合类型',
  function: '函数',
  procedure: '存储过程',
  aggregate: '聚合函数',
  view: '视图',
  materializedView: '物化视图',
  trigger: '触发器',
  policy: '策略',
  exclusion: '排他约束',
};

const ROUTINE_OPTION_WORDS = new Set([
  'language',
  'transform',
  'window',
  'immutable',
  'stable',
  'volatile',
  'leakproof',
  'called',
  'strict',
  'external',
  'security',
  'parallel',
  'cost',
  'rows',
  'support',
  'set',
  'as',
  'begin',
]);

/** 提取函数 / 过程 DDL 的签名头部（参数列表与 RETURNS 子句，不含属性与函数体），用于判断能否原地 CREATE OR REPLACE */
const routineSignatureHeader = (ddl: string): string => {
  const toks = tokenize(ddl).filter((t) => !(t.kind === 'other' && /^\s+$/.test(t.text)));
  let depth = 0;
  let seenParams = false;
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'other' && t.text === '(') {
      depth++;
    } else if (t.kind === 'other' && t.text === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) seenParams = true;
    } else if (depth === 0 && seenParams && t.kind === 'ident') {
      const next = toks[i + 1];
      if (
        ROUTINE_OPTION_WORDS.has(t.text) ||
        (t.text === 'not' && next?.kind === 'ident' && next.text === 'leakproof') ||
        (t.text === 'returns' && next?.kind === 'ident' && next.text === 'null')
      ) {
        break;
      }
    }
    out.push(t.kind === 'qident' ? `"${t.text}"` : t.text);
  }
  return out.join(' ');
};

const aggregateStype = (ddl: string): string => {
  const m = /\bSTYPE\s*=\s*([^,)]+)/i.exec(ddl);
  return m ? m[1]!.trim().toLowerCase() : '';
};

const earlyNeedsDropBeforeCreate = (w: Opaque, o: Opaque): boolean => {
  if (o.objType === 'domain' || o.objType === 'type') return true;
  if (w.drop !== o.drop) return true;
  if (o.objType === 'function' || o.objType === 'procedure') {
    return routineSignatureHeader(w.ddl[0] ?? '') !== routineSignatureHeader(o.ddl[0] ?? '');
  }
  if (o.objType === 'aggregate') {
    return aggregateStype(w.ddl[0] ?? '') !== aggregateStype(o.ddl[0] ?? '');
  }
  return false;
};

export const plan = (rawFrom: Model, rawTo: Model, opts?: PlanOptions): Step[] => {
  const from = normalizeAllPartitionFamilies(rawFrom);
  const to = normalizeAllPartitionFamilies(rawTo);
  const fromIdx = buildModelIndex(from);
  const toIdx = buildModelIndex(to);
  return withModelIndex(
    from,
    () => withModelIndex(to, () => planWithIndexes(from, to, fromIdx, toIdx, opts), toIdx),
    fromIdx,
  );
};

const planWithIndexes = (
  from: Model,
  to: Model,
  fromIdx: ReturnType<typeof buildModelIndex>,
  toIdx: ReturnType<typeof buildModelIndex>,
  opts?: PlanOptions,
): Step[] => {
  const targetMajor = opts?.pgMajor ?? null;
  if (targetMajor !== null && (!Number.isInteger(targetMajor) || targetMajor <= 0)) {
    throw new PlanError(`无效的目标 PostgreSQL 主版本号：${String(targetMajor)}`);
  }
  const cap = pgCapabilities(targetMajor ?? LATEST_PG_MAJOR);
  if (targetMajor !== null) {
    const errors = checkPgCompatibility(to, targetMajor).filter((i) => i.severity === 'error');
    if (errors.length > 0) {
      throw new PlanError(
        `目标 PostgreSQL ${targetMajor} 不支持以下特性：\n${errors.map((e) => `- ${e.message}`).join('\n')}`,
      );
    }
  }
  const cur = clone(from);
  const steps: Step[] = [];
  const emit = (kind: string, target: string, sql: string) => steps.push({ kind, target, sql });

  const inFrom = (id: string) => Object.hasOwn(from.objects, id);
  const inTo = (id: string) => Object.hasOwn(to.objects, id);
  const removed: Obj[] = [];
  for (const id in from.objects) {
    if (!inTo(id)) removed.push(from.objects[id]!);
  }
  const added: Obj[] = [];
  const common: Obj[] = [];
  for (const id in to.objects) {
    const o = to.objects[id]!;
    if (inFrom(id)) common.push(o);
    else added.push(o);
  }
  const was = <T extends Obj>(o: T): T => from.objects[o.id] as T;
  const isRemoved = (id: string) => inFrom(id) && !inTo(id);

  // ───── 分区挂载/脱离/改边界关系预分析 ─────
  const detaching = new Set<string>();
  const attaching = new Set<string>();
  const rebinding = new Set<string>();
  for (const o of toIdx.allRef('table')) {
    if (!inFrom(o.id)) continue;
    const w = was(o);
    if (w.partitionOf && !o.partitionOf) detaching.add(o.id);
    else if (!w.partitionOf && o.partitionOf) attaching.add(o.id);
    else if (w.partitionOf && o.partitionOf && !samePartitionOf(w.partitionOf, o.partitionOf))
      rebinding.add(o.id);
  }
  const willDetach = new Set([...detaching, ...rebinding]);
  const willAttach = new Set([...attaching, ...rebinding]);

  // 脱离为独立表的子分区：把 to 中新物化的列匹配回 from 根父表的列
  const detachToRootCol = new Map<string, Column>(); // toColId → fromRootCol
  const detachRootToNewCol = new Map<string, Map<string, string>>(); // tableId → (fromRootColId → toColId)
  for (const tId of detaching) {
    const oldRootCols = columnsOf(from, rootTableId(from, tId));
    const toCols = columnsOf(to, tId);
    const used = new Set<string>();
    const map = new Map<string, string>();
    for (const rc of oldRootCols) {
      const detCandidate = derivedUuid(`${tId}:col:${rc.id}`);
      const byDet = toCols.find((x) => x.id === detCandidate && !used.has(x.id));
      const matched = byDet ?? toCols.find((x) => x.name === rc.name && !used.has(x.id));
      if (matched) {
        used.add(matched.id);
        detachToRootCol.set(matched.id, rc);
        map.set(rc.id, matched.id);
      }
    }
    detachRootToNewCol.set(tId, map);
  }

  // 挂载为子分区的普通表：其与目标根父表同名的列不在 P5 中删除，而在 P12h 中随 ATTACH 吸收
  const attachKeptCols = new Set<string>();
  const attachColMap = new Map<string, Map<string, string>>(); // tableId → (fromChildColId → toRootColId)
  for (const tId of attaching) {
    const targetRootCols = columnsOf(to, rootTableId(to, tId));
    const map = new Map<string, string>();
    for (const cc of columnsOf(from, tId)) {
      const rc = targetRootCols.find((x) => x.name === cc.name);
      if (rc) {
        // 生成列（含普通列↔生成列互转）不在 attachKeptCols 保留：P5 统一先删生成列避免挡住普通列删除/改类型，P12h 再按目标根表重建
        if (!cc.generated && !rc.generated) attachKeptCols.add(cc.id);
        map.set(cc.id, rc.id);
      }
    }
    attachColMap.set(tId, map);
  }

  // 枚举要重建（删值或重排值）：旧类型改临时名 → 建新类型 → 列转到新类型 → 删旧类型，OID 会变
  const enumRebuild = new Set<string>();
  for (const o of common) {
    if (o.kind !== 'enum') continue;
    const old = was(o).values;
    if (
      !sameStrArr(
        o.values.filter((v) => old.includes(v)),
        old,
      )
    ) {
      enumRebuild.add(o.id);
    }
  }

  // ───── 改名带来的表达式变化：PG 按 OID 记录引用，改名时会自动更新表达式，不需要重建 ─────
  // 把旧版本表达式里的 schema、枚举、列名换成新名字后再比较；相同就说明只是改名带来的变化。
  // 表达式按名字写、数据库按 OID 绑定：旧表达式里的 `schema.枚举` 先按**旧模型**解析成枚举 ID，再换成该 ID 在新模型里的名字
  // （一趟替换，对调、轮换都正确）。枚举被删除或要重建时，旧 OID 在迁移后不复存在，换成一个不可能出现的名字，
  // 于是引用它的表达式一定和新模型对不上 → 重建，重建后按新模型的名字绑定到当时同名的那个类型。
  const schemaRenames = common
    .filter((o): o is Schema => o.kind === 'schema' && o.name !== was(o).name)
    .map((o) => [was(o).name, o.name] as const);
  const exprSchemaMap = new Map<string, string>(schemaRenames);
  const exprTypeMap = new Map<string, Map<string, { schema: string; name: string }>>();
  for (const e of fromIdx.allRef('enum')) {
    const fromSchema = get(from, e.parent, 'schema').name;
    const now = to.objects[e.id];
    let target: { schema: string; name: string };
    if (now?.kind === 'enum' && !enumRebuild.has(e.id)) {
      target = { schema: get(to, now.parent, 'schema').name, name: now.name };
      if (target.schema === fromSchema && target.name === e.name) continue;
    } else {
      target = { schema: fromSchema, name: `__dowel_rebound_${e.id}__` };
    }
    let m = exprTypeMap.get(fromSchema);
    if (!m) exprTypeMap.set(fromSchema, (m = new Map()));
    m.set(e.name, target);
  }
  const exprRemap = { schemas: exprSchemaMap, types: exprTypeMap };
  /** 旧模型里的表达式引用了哪些在本次迁移中改名、被删除或重建的枚举（旧的显示名，用于报错） */
  const remappedEnumsIn = (expr: string | null | undefined): string[] => {
    if (!expr || exprTypeMap.size === 0) return [];
    const out: string[] = [];
    for (const { schema, name } of qualifiedRefs(expr)) {
      if (exprTypeMap.get(schema.text)?.has(name.text)) out.push(`${schema.text}.${name.text}`);
    }
    return out;
  };
  const colRenames = new Map<string, [string, string][]>();
  for (const o of common)
    if (o.kind === 'column' && o.name !== was(o).name)
      colRenames.set(o.parent, [...(colRenames.get(o.parent) ?? []), [was(o).name, o.name]]);
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (tc.name !== rc.name)
      colRenames.set(tc.parent, [...(colRenames.get(tc.parent) ?? []), [rc.name, tc.name]]);
  }
  const hasGlobalRename = exprSchemaMap.size > 0 || exprTypeMap.size > 0;
  const hasAnyExprMigration =
    hasGlobalRename || colRenames.size > 0 || willDetach.size > 0 || willAttach.size > 0;
  const migrateExpr = (expr: string, table: string): string => {
    let e = hasGlobalRename ? remapQualifiedInExpr(expr, exprRemap) : expr;
    // 两阶段：先换成占位名，再换成目标名（处理互换）
    const rs = colRenames.get(table) ?? colRenames.get(rootTableId(from, table)) ?? [];
    rs.forEach(([a], i) => {
      e = renameInExpr(e, a, `__dowel_ph_${i}__`);
    });
    rs.forEach(([, b], i) => {
      e = renameInExpr(e, `__dowel_ph_${i}__`, b);
    });
    return e;
  };
  const remapIdsForTable = (tableId: string): Map<string, string> | undefined =>
    attachColMap.get(tableId) ?? detachRootToNewCol.get(tableId);
  const tableNeedsMigration = (tableId: string): boolean => {
    if (hasGlobalRename) return true;
    if (attachColMap.has(tableId) || detachRootToNewCol.has(tableId)) return true;
    if (colRenames.has(tableId) || colRenames.has(rootTableId(from, tableId))) return true;
    return false;
  };
  const migrated = <T extends Obj>(w: T): T => {
    if (!hasAnyExprMigration) return w;
    if (
      w.kind === 'schema' ||
      w.kind === 'extension' ||
      w.kind === 'enum' ||
      w.kind === 'sequence' ||
      w.kind === 'opaque'
    ) {
      return w;
    }
    const tblId = w.kind === 'table' ? w.id : w.parent;
    if (
      !hasGlobalRename &&
      !tableNeedsMigration(tblId) &&
      !(w.kind === 'foreignKey' && tableNeedsMigration(w.refTable))
    ) {
      return w;
    }
    const o = clone(w) as Obj;
    if (o.kind === 'table' && o.partitionBy) {
      if (typeof o.partitionBy === 'string') {
        o.partitionBy = migrateExpr(o.partitionBy, o.id);
      } else {
        const rm = remapIdsForTable(o.id);
        for (const k of o.partitionBy.keys) {
          if (k.column && rm?.has(k.column)) k.column = rm.get(k.column)!;
          if (k.expr) k.expr = migrateExpr(k.expr, o.id);
        }
      }
    }
    if (o.kind === 'check') o.expr = migrateExpr(o.expr, o.parent);
    if (o.kind === 'primaryKey' || o.kind === 'unique') {
      const rm = remapIdsForTable(o.parent);
      if (rm) o.columns = o.columns.map((c) => rm.get(c) ?? c);
    }
    if (o.kind === 'foreignKey') {
      const rm = remapIdsForTable(o.parent);
      if (rm) o.columns = o.columns.map((c) => rm.get(c) ?? c);
      const rrm = remapIdsForTable(o.refTable);
      if (rrm) o.refColumns = o.refColumns.map((c) => rrm.get(c) ?? c);
    }
    if (o.kind === 'index') {
      const rm = remapIdsForTable(o.parent);
      for (const el of o.elements) {
        if (el.column && rm?.has(el.column)) el.column = rm.get(el.column)!;
        if (el.expr) el.expr = migrateExpr(el.expr, o.parent);
      }
      if (rm) o.include = o.include.map((c) => rm.get(c) ?? c);
      if (o.where) o.where = migrateExpr(o.where, o.parent);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = migrateExpr(o.generated.expr, o.parent);
      if (o.default && 'expr' in o.default) o.default.expr = migrateExpr(o.default.expr, o.parent);
    }
    return o as T;
  };

  for (const o of common) {
    if (o.kind !== was(o).kind) throw new PlanError(`对象 ${o.id} 的种类从 ${was(o).kind} 变成了 ${o.kind}`);
    if ('parent' in o && o.parent !== (was(o) as typeof o).parent && o.kind !== 'column')
      throw new PlanError(`暂不支持把 ${o.kind} ${o.name} 移到其他 schema 或表`);
    if (o.kind === 'column' && o.parent !== was(o).parent)
      throw new PlanError(`不能把列 ${o.name} 移到其他表`);
    if (o.kind === 'table') {
      const w = was(o);
      if ((w.partitionBy === null) !== (o.partitionBy === null)) {
        throw new PlanError(`暂不支持将普通表与分区表互转：${o.name}`);
      }
      if (w.partitionBy !== null && o.partitionBy !== null) {
        const mw = migrated(w);
        let samePartBy = partitionBySql(to, o) === partitionBySql(to, mw, from);
        // Stage 0 复审要求：两侧同为结构化 PartitionSpec 时额外校验 column ID 一致且未被删/换绑
        if (samePartBy && typeof w.partitionBy !== 'string' && typeof o.partitionBy !== 'string') {
          const mwSpec = mw.partitionBy as PartitionSpec;
          const oSpec = o.partitionBy;
          samePartBy =
            mwSpec.strategy === oSpec.strategy &&
            mwSpec.keys.length === oSpec.keys.length &&
            oSpec.keys.every((ok, i) => {
              const wk = mwSpec.keys[i]!;
              if (ok.column !== wk.column) return false;
              if (ok.column !== null && isRemoved(ok.column)) return false;
              if (ok.opclass !== wk.opclass || ok.collation !== wk.collation) return false;
              if ((ok.expr === null) !== (wk.expr === null)) return false;
              return ok.expr === wk.expr;
            });
        }
        // 防绕过检查（覆盖表达式分区键与存量字符串 partitionBy）：核验 from 分区键引用的全部列 ID 在 to 中均存活且未换绑
        if (samePartBy) {
          const fromKeyCols = partitionKeyColumns(from, w).all;
          const toKeyCols = new Set(partitionKeyColumns(to, o).all);
          const fromRoot = rootTableId(from, w.id);
          const toRoot = rootTableId(to, o.id);
          const mapFromColToTo = (fromColId: string): string | null => {
            const mapped =
              attachColMap.get(o.id)?.get(fromColId) ??
              attachColMap.get(fromRoot)?.get(fromColId) ??
              detachRootToNewCol.get(o.id)?.get(fromColId) ??
              detachRootToNewCol.get(toRoot)?.get(fromColId);
            if (mapped && inTo(mapped)) return mapped;
            if (!isRemoved(fromColId)) return fromColId;
            return null;
          };
          const mappedFromCols = fromKeyCols.map(mapFromColToTo);
          const mappedSet = new Set(mappedFromCols.filter((cid): cid is string => cid !== null));
          if (
            mappedFromCols.some((cid) => cid === null || !toKeyCols.has(cid)) ||
            mappedSet.size !== toKeyCols.size
          ) {
            samePartBy = false;
          }
        }
        if (!samePartBy) {
          const keyExprs =
            typeof w.partitionBy === 'string' ? [w.partitionBy] : w.partitionBy.keys.map((k) => k.expr);
          const enums = [...new Set(keyExprs.flatMap(remappedEnumsIn))];
          if (enums.length > 0) {
            throw new PlanError(
              `分区表 ${o.name} 的分区键表达式引用了枚举 ${enums.join('、')}，它在本次迁移中改名、与其他枚举对调名字、被删除或重建，` +
                '分区键在迁移后会绑定到与新版本不同的类型；PG 不能修改已有表的分区键。' +
                '请先让分区键不再引用该枚举，或手工重建这张分区表',
            );
          }
          throw new PlanError(`暂不支持修改已存在表的分区策略或分区键：${o.name}`);
        }
      }
    }
    if (o.kind === 'extension' && !sameDef(o, was(o))) throw new PlanError(`扩展暂不支持修改：${o.name}`);
  }

  // ───── 渲染（都基于 cur） ─────
  const T = (id: string) => qname(cur, get(cur, id, 'table'));
  const C = (id: string) => ident(get(cur, id, 'column').name);
  const cols = (ids: string[]) => ids.map(C).join(', ');
  const relIn = (tableId: string, name: string) =>
    qualified(get(cur, get(cur, tableId, 'table').parent, 'schema').name, name);

  const typeOf = (c: Column): string => {
    const base = c.typeRef ? qname(cur, get(cur, c.typeRef, 'enum')) + c.type : c.type;
    return c.collation ? `${base} COLLATE ${c.collation}` : base;
  };
  const defaultOf = (c: Column): string | null =>
    !c.default
      ? null
      : 'expr' in c.default
        ? c.default.expr
        : `nextval(${literal(qname(cur, get(cur, c.default.nextval, 'sequence')))}::regclass)`;
  /** PG 的默认起始值：升序取 min（缺省 1），降序取 max（缺省 -1），与类型无关 */
  const defaultSeqStart = (o: SequenceOptions): string =>
    o.increment.trim().startsWith('-') ? (o.max ?? '-1') : (o.min ?? '1');
  /**
   * ALTER 序列时要写的 START WITH（null 表示不写）。PG 省略 START WITH 时保留旧 seqstart，
   * 不会按新的 min/max/递增方向重算默认值：旧值落在新范围外直接报错，落在范围内也会读回成显式 start。
   * 所以目标 start 为 null 但有效起始值（显式 start 或默认值）变了时，要显式写出目标默认值。
   */
  const alterSeqStart = (from: SequenceOptions, to: SequenceOptions): string | null => {
    if (to.start !== null) return to.start;
    const target = defaultSeqStart(to);
    return (from.start ?? defaultSeqStart(from)) === target ? null : target;
  };
  const seqOptions = (o: SequenceOptions, withType: boolean, start = o.start): string => {
    const p: string[] = [];
    if (withType) p.push(`AS ${o.type}`);
    p.push(`INCREMENT BY ${o.increment}`);
    p.push(o.min === null ? 'NO MINVALUE' : `MINVALUE ${o.min}`);
    p.push(o.max === null ? 'NO MAXVALUE' : `MAXVALUE ${o.max}`);
    if (start !== null) p.push(`START WITH ${start}`);
    p.push(`CACHE ${o.cache}`);
    p.push(o.cycle ? 'CYCLE' : 'NO CYCLE');
    return p.join(' ');
  };
  const identityClause = (c: Column, table: Table): string => {
    const id = c.identity!;
    const seq = qualified(get(cur, table.parent, 'schema').name, id.sequenceName);
    return `GENERATED ${id.always ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY (SEQUENCE NAME ${seq} ${seqOptions(id.options, false)})`;
  };
  const columnDef = (c: Column, table: Table): string => {
    let s = `${ident(c.name)} ${typeOf(c)}`;
    if (c.generated)
      s += ` GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
    if (c.identity) s += ` ${identityClause(c, table)}`;
    const d = defaultOf(c);
    if (d) s += ` DEFAULT ${d}`;
    if (c.notNull)
      s += cap.namedNotNull && c.notNullName ? ` CONSTRAINT ${ident(c.notNullName)} NOT NULL` : ' NOT NULL';
    return s;
  };
  const constraintDef = (k: PrimaryKey | Unique | Check | ForeignKey): string => {
    switch (k.kind) {
      case 'primaryKey':
        return `PRIMARY KEY (${cols(k.columns)})`;
      case 'unique':
        return `UNIQUE${k.nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''} (${cols(k.columns)})`;
      case 'check':
        return `CHECK (${k.expr})${k.noInherit ? ' NO INHERIT' : ''}`;
      case 'foreignKey': {
        let s = `FOREIGN KEY (${cols(k.columns)}) REFERENCES ${T(k.refTable)} (${cols(k.refColumns)})`;
        if (k.match === 'full') s += ' MATCH FULL';
        if (k.onDelete !== 'noAction') s += ` ON DELETE ${FK_ACTION[k.onDelete]}`;
        if (k.onUpdate !== 'noAction') s += ` ON UPDATE ${FK_ACTION[k.onUpdate]}`;
        if (k.deferrable) s += k.initiallyDeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE';
        return s;
      }
    }
  };
  const indexDef = (x: Index): string => {
    const els = x.elements
      .map((e) => {
        let s = e.column ? C(e.column) : `(${e.expr})`;
        if (e.collation) s += ` COLLATE ${e.collation}`;
        if (e.opclass) s += ` ${e.opclass}`;
        if (e.desc) s += ' DESC';
        if (e.nullsFirst !== null && e.nullsFirst !== e.desc)
          s += e.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
        return s;
      })
      .join(', ');
    let s = `CREATE ${x.unique ? 'UNIQUE ' : ''}INDEX ${ident(x.name)} ON ${T(x.parent)} USING ${x.method} (${els})`;
    if (x.include.length) s += ` INCLUDE (${cols(x.include)})`;
    if (x.nullsNotDistinct) s += ' NULLS NOT DISTINCT';
    if (x.where) s += ` WHERE ${x.where}`;
    return s;
  };

  // ───── 预先计算：需要重建的约束 / 索引、需要重建的生成列、类型变化的列 ─────
  const typeChanged = new Set<string>();
  const renamedColIds = new Set<string>();
  const opaqueChanged = new Set<string>();
  for (let i = 0; i < common.length; i++) {
    const o = common[i]!;
    if (o.kind === 'column') {
      const w = was(o);
      if (!sameColType(o, w)) typeChanged.add(o.id);
      if (o.name !== w.name) renamedColIds.add(o.id);
    } else if (o.kind === 'opaque') {
      if (!sameDef(o, was(o))) opaqueChanged.add(o.id);
    }
  }
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (!sameColType(tc, rc)) typeChanged.add(toColId);
  }
  /** 表达式是否引用了某些列（按旧名或新名） */
  const exprTouches = (expr: string | null | undefined, colIds: Iterable<string>) => {
    if (!expr) return false;
    const ids = identsIn(expr);
    for (const c of colIds) {
      const names = [find(from, c)?.name, find(to, c)?.name, detachToRootCol.get(c)?.name];
      if (names.some((n) => n && ids.has(n))) return true;
    }
    return false;
  };
  const colsOfTable = (table: string, set: Set<string>) => {
    const rootTo = rootTableId(to, table);
    const rootFrom = rootTableId(from, table);
    return [...set].filter((c) => {
      const col = find(to, c) ?? find(from, c);
      return (
        col?.kind === 'column' && (col.parent === table || col.parent === rootTo || col.parent === rootFrom)
      );
    });
  };

  // 类型是被重建枚举的列：重建时会改到新类型（OID 变了）。外键必须先删；引用它的生成列、视图要重建；不能是分区键
  const enumCols = new Set<string>();
  if (enumRebuild.size > 0) {
    for (const c of fromIdx.allRef('column')) {
      if (c.typeRef && enumRebuild.has(c.typeRef)) enumCols.add(c.id);
    }
  }

  // 生成列：定义变了、或表达式引用的列类型变了 → 删掉重建（生成列的值可以重新算出，不丢数据）
  const regen = new Set<string>();
  for (const c of toIdx.allRef('column')) {
    if (!inFrom(c.id)) continue;
    const w = was(c);
    if (!c.generated && !w.generated) continue;
    if (
      !sameGenerated(c.generated, migrated(w).generated) ||
      typeChanged.has(c.id) ||
      enumCols.has(c.id) ||
      (c.generated && exprTouches(c.generated.expr, colsOfTable(c.parent, typeChanged))) ||
      (c.generated && enumCols.size > 0 && exprTouches(c.generated.expr, colsOfTable(c.parent, enumCols)))
    )
      regen.add(c.id);
  }
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (!tc.generated && !rc.generated) continue;
    const mrc = { ...clone(rc), parent: tc.parent };
    if (mrc.generated) mrc.generated.expr = migrateExpr(mrc.generated.expr, tc.parent);
    if (
      !sameGenerated(tc.generated, mrc.generated) ||
      typeChanged.has(toColId) ||
      (tc.generated && exprTouches(tc.generated.expr, colsOfTable(tc.parent, typeChanged)))
    )
      regen.add(toColId);
  }
  for (const id of regen) typeChanged.delete(id);

  // 默认值文本没变、但它引用的枚举换了绑定（两个枚举 / schema 对调名字、删后重建同名枚举、枚举重建）：
  // 文本比较看不出来，要显式重设，让它按新模型的名字重新绑定（P12 先 DROP DEFAULT 再 SET DEFAULT）。
  // 默认值不能引用列（PG 限制），所以只看全局改名
  const rebindDefault = new Set<string>();
  if (hasGlobalRename) {
    const check = (c: Column, old: Column['default'], moved: Column['default']) => {
      if (regen.has(c.id) || !c.default || !('expr' in c.default)) return;
      if (sameDefault(old, c.default) && !sameDefault(moved, c.default)) rebindDefault.add(c.id);
    };
    for (const c of toIdx.allRef('column'))
      if (inFrom(c.id)) check(c, was(c).default, migrated(was(c)).default);
    // 脱离为独立表的子分区：列从根父表物化出来，默认值文本也来自根父表
    for (const [toColId, rc] of detachToRootCol) {
      const tc = get(to, toColId, 'column');
      const moved =
        rc.default && 'expr' in rc.default ? { expr: migrateExpr(rc.default.expr, tc.parent) } : rc.default;
      check(tc, rc.default, moved);
    }
  }

  // 分区键引用的列不允许改类型（PG 报错 cannot alter type of column named in partition key）
  if (typeChanged.size > 0 || regen.size > 0 || enumCols.size > 0) {
    for (const o of toIdx.allRef('table')) {
      if (!o.partitionBy || !inFrom(o.id)) continue;
      const refIds = new Set([...partitionKeyColumns(to, o).all, ...partitionKeyColumns(from, was(o)).all]);
      for (const colId of refIds) {
        if (typeChanged.has(colId) || regen.has(colId) || enumCols.has(colId)) {
          const colName = find(to, colId)?.name ?? find(from, colId)?.name ?? colId;
          throw new PlanError(
            enumCols.has(colId)
              ? `列 ${colName} 被分区表 ${o.name} 的分区键引用，它的枚举类型要删值或重排值（需重建类型），PG 不能修改分区键列的类型`
              : `列 ${colName} 被分区表 ${o.name} 的分区键引用，不能修改类型`,
          );
        }
      }
    }
  }

  const usesCols = (o: Obj, set: Set<string>): boolean => {
    switch (o.kind) {
      case 'primaryKey':
      case 'unique':
        return o.columns.some((c) => set.has(c));
      case 'foreignKey':
        return o.columns.some((c) => set.has(c)) || o.refColumns.some((c) => set.has(c));
      case 'check':
        return exprTouches(o.expr, colsOfTable(o.parent, set));
      case 'index':
        return (
          o.elements.some((e) =>
            e.column ? set.has(e.column) : exprTouches(e.expr, colsOfTable(o.parent, set)),
          ) ||
          o.include.some((c) => set.has(c)) ||
          exprTouches(o.where, colsOfTable(o.parent, set))
        );
      default:
        return false;
    }
  };

  const mentionsRebuiltEnum = (expr: string | null | undefined) => {
    if (!expr || !enumRebuild.size) return false;
    const ids = identsIn(expr);
    return [...enumRebuild].some(
      (e) => ids.has(was(from.objects[e] as Enum).name) || ids.has((to.objects[e] as Enum).name),
    );
  };

  // PG 中 ALTER TABLE RENAME COLUMN 不会更新分区父表索引关系（relkind='I'）上的 pg_attribute.attname，
  // 导致后续新建或重挂子分区时 PG 仍按旧列名生成继承 UNIQUE/INDEX 约束与索引名；
  // 当分区父表的 UNIQUE 或 INDEX 直接引用的列改名时重建该约束/索引，确保索引 attname 与当前列名一致。
  const usesRenamedDirectCol = (o: Unique | Index): boolean =>
    o.kind === 'unique'
      ? o.columns.some((c) => renamedColIds.has(c))
      : o.elements.some((e) => e.column !== null && renamedColIds.has(e.column)) ||
        o.include.some((c) => renamedColIds.has(c));

  const rebuild = new Set<string>();
  const isKey = (o: Obj): o is Constraint | Index =>
    o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'index';
  const refTablesWithGoneKey = new Set<string>();
  for (const pk of fromIdx.allRef('primaryKey')) {
    if (isRemoved(pk.id)) refTablesWithGoneKey.add(pk.parent);
  }
  for (const u of fromIdx.allRef('unique')) {
    if (isRemoved(u.id)) refTablesWithGoneKey.add(u.parent);
  }
  for (const ix of fromIdx.allRef('index')) {
    if (ix.unique && isRemoved(ix.id)) refTablesWithGoneKey.add(ix.parent);
  }
  for (const kind of ['primaryKey', 'unique', 'check', 'index'] as const) {
    for (const o of toIdx.allRef(kind)) {
      if (!inFrom(o.id)) continue;
      const w = was(o);
      const exprs =
        enumRebuild.size > 0
          ? w.kind === 'check'
            ? [w.expr]
            : w.kind === 'index'
              ? [...w.elements.map((e) => e.expr), w.where]
              : []
          : [];
      const partParentRenamedKeyCol =
        renamedColIds.size > 0 &&
        (w.kind === 'unique' || w.kind === 'index') &&
        (to.objects[o.parent] as Table).partitionBy !== null &&
        usesRenamedDirectCol(w);
      if (
        !sameDef(o, migrated(w)) ||
        (regen.size > 0 && usesCols(w, regen)) ||
        (typeChanged.size > 0 && usesCols(w, typeChanged)) ||
        (exprs.length > 0 && exprs.some(mentionsRebuiltEnum)) ||
        partParentRenamedKeyCol
      ) {
        rebuild.add(o.id);
        if (o.kind === 'primaryKey' || o.kind === 'unique' || (o.kind === 'index' && o.unique)) {
          refTablesWithGoneKey.add(o.parent);
        }
      }
    }
  }
  // 外键：自身变了、两端列类型变了、或被引用表上的主键 / 唯一约束 / 唯一索引要删掉或重建
  const refKeyGone = (refTable: string) => refTablesWithGoneKey.has(refTable);
  for (const o of toIdx.allRef('foreignKey')) {
    if (!inFrom(o.id)) continue;
    const w = was(o);
    if (
      !sameDef(o, w) ||
      (typeChanged.size > 0 && usesCols(w, typeChanged)) ||
      (regen.size > 0 && usesCols(w, regen)) ||
      (enumCols.size > 0 && usesCols(w, enumCols)) ||
      refKeyGone(w.refTable)
    )
      rebuild.add(o.id);
  }

  const tableRemoved = (o: { parent: string }) => isRemoved(o.parent);

  // ───── 不透明对象：哪些要重建 ─────
  /**
   * 晚期对象：视图、触发器等，以及依赖了表、列、序列或其他晚期对象的早期种类（如返回表行类型的函数）。
   * 按所在模型判断（from 里的对象用 from，to 里的用 to）。
   */
  const lateMemo = new Map<string, boolean>();
  const isLate = (o: Opaque): boolean => {
    const m = inTo(o.id) && to.objects[o.id] === o ? to : from;
    const k = `${m === to ? 't' : 'f'}:${o.id}`;
    const hit = lateMemo.get(k);
    if (hit !== undefined) return hit;
    lateMemo.set(k, false); // 防环
    const late =
      !EARLY_OPAQUE.has(o.objType) ||
      o.deps.some((d) => {
        const x = m.objects[d];
        return (
          x?.kind === 'table' ||
          x?.kind === 'column' ||
          x?.kind === 'sequence' ||
          (x?.kind === 'opaque' && isLate(x))
        );
      });
    lateMemo.set(k, late);
    return late;
  };
  // 晚期对象（视图、触发器等）所依赖的对象被删除、重建、改类型时，要先删掉、最后重建
  const unstable = new Set<string>([
    ...removed.map((o) => o.id),
    ...rebuild,
    ...typeChanged,
    ...regen,
    ...enumRebuild,
    ...enumCols,
    ...opaqueChanged,
    ...detaching,
    ...attaching,
    ...rebinding,
  ]);
  const lateRebuild = new Set([...opaqueChanged].filter((id) => isLate(from.objects[id] as Opaque)));
  // DDL 文本没变、但依赖的枚举换成了另一个（按 ID）：PG 里它仍绑定旧类型，要删掉重建才会按新版本绑定
  const enumDepsOf = (m: Model, o: Opaque) => o.deps.filter((d) => m.objects[d]?.kind === 'enum').sort();
  for (const o of toIdx.allRef('opaque')) {
    if (!inFrom(o.id) || lateRebuild.has(o.id)) continue;
    const w = was(o);
    if (isLate(w) && !sameStrArr(enumDepsOf(to, o), enumDepsOf(from, w))) {
      lateRebuild.add(o.id);
      unstable.add(o.id);
    }
  }
  // 早期不透明对象（域、复合类型、函数、存储过程、聚合函数）依赖被删除或重建的枚举：
  // - 枚举要重建（enumRebuild）：P8 在 P8b / P14 之前就删旧类型，无论该对象是否改动或删除都无法直接通过，明确报错；
  // - 枚举被删除（isRemoved）：若同一版本把该对象一并删除或重定义为不再依赖该枚举（及其同名重建枚举），
  //   且对函数 / 存储过程 / 聚合函数而言该枚举的类型名未被新对象复用（否则 P6 先把旧枚举改临时名导致静态 DROP 语句失效），
  //   则允许放行（P8b 先删后建或 P14 先于 DROP TYPE 删除）；其余情况明确报错。
  for (const w of fromIdx.allRef('opaque')) {
    if (isLate(w)) continue;
    const blocked: string[] = [];
    for (const d of w.deps) {
      const e = from.objects[d];
      if (e?.kind !== 'enum') continue;
      if (enumRebuild.has(d)) {
        blocked.push(d);
        continue;
      }
      if (!isRemoved(d)) continue;
      const replacement = toIdx.allRef('enum').find((x) => x.parent === e.parent && x.name === e.name);
      const reusedTypeSlot =
        !!replacement || toIdx.allRef('table').some((x) => x.parent === e.parent && x.name === e.name);
      const isTypeObj = w.objType === 'domain' || w.objType === 'type';
      if (!inTo(w.id)) {
        if (!isTypeObj && reusedTypeSlot) blocked.push(d);
        continue;
      }
      const o = to.objects[w.id] as Opaque;
      const allowed =
        opaqueChanged.has(o.id) &&
        !isLate(o) &&
        !o.deps.includes(d) &&
        (!replacement || !o.deps.includes(replacement.id)) &&
        (isTypeObj || !reusedTypeSlot);
      if (!allowed) blocked.push(d);
    }
    if (blocked.length > 0) {
      const kindLabel = OPAQUE_KIND_LABEL[w.objType];
      const names = blocked.map((d) => qname(from, from.objects[d] as Enum)).join('、');
      throw new PlanError(
        `${kindLabel} ${w.name} 依赖的枚举 ${names} 在本次迁移中被删除或要重建（删值 / 重排值），暂不支持自动重建依赖它的${kindLabel}；` +
          '请先在一个版本里删掉该对象（或改为不依赖这个枚举），再在后续版本里重建枚举或该对象',
      );
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const o of all(from, 'opaque')) {
      if (!isLate(o) || !inTo(o.id) || lateRebuild.has(o.id)) continue;
      if (o.deps.some((d) => unstable.has(d))) {
        lateRebuild.add(o.id);
        unstable.add(o.id);
        changed = true;
      }
    }
  }
  /** 按依赖排序（依赖不完整或有环时按原库中的创建顺序） */
  const topo = (objs: Opaque[]): Opaque[] => {
    const ids = new Set(objs.map((o) => o.id));
    const done = new Set<string>();
    const rest = [...objs].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1));
    const out: Opaque[] = [];
    while (rest.length) {
      const i = rest.findIndex((o) => o.deps.every((d) => !ids.has(d) || done.has(d)));
      const o = rest.splice(Math.max(i, 0), 1)[0]!;
      out.push(o);
      done.add(o.id);
    }
    return out;
  };
  const createOpaque = (o: Opaque) => {
    for (const sql of o.ddl) emit('createOpaque', o.id, sql);
    cur.objects[o.id] = fresh(o);
  };
  const dropOpaque = (o: Opaque) => {
    emit('dropOpaque', o.id, o.drop);
    delete cur.objects[o.id];
  };

  let tmp = 0; // 临时名计数器
  const ancestorsCur = (tableId: string): Table[] => {
    const out: Table[] = [];
    const seen = new Set<string>();
    let curId: string | null = tableId;
    while (curId && !seen.has(curId)) {
      seen.add(curId);
      const t: Obj | undefined = cur.objects[curId];
      if (t?.kind !== 'table') break;
      out.push(t);
      curId = t.partitionOf?.parent ?? null;
    }
    return out;
  };
  const relTakenCur = (schema: string, name: string) =>
    Object.values(cur.objects).some((o) => {
      if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schema) return o.name === name;
      if (
        (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') &&
        get(cur, o.parent, 'table').parent === schema
      )
        return o.name === name;
      if (o.kind === 'column' && o.identity && get(cur, o.parent, 'table').parent === schema)
        return o.identity.sequenceName === name;
      return false;
    });
  const conTakenIn = (m: Model, tableId: string, name: string): boolean => {
    const ancIds = new Set(partitionAncestors(m, tableId).map((a) => a.id));
    return Object.values(m.objects).some((o) => {
      if (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.parent === tableId
      )
        return o.name === name;
      if (cap.namedNotNull && o.kind === 'column' && o.parent === tableId && o.notNull)
        return o.notNullName === name;
      if (ancIds.size > 0 && 'parent' in o && ancIds.has(o.parent)) {
        if ((o.kind === 'check' || o.kind === 'foreignKey') && o.name === name) return true;
        if (cap.namedNotNull && o.kind === 'column' && o.notNull && o.notNullName === name) return true;
      }
      return false;
    });
  };
  const conTakenCur = (tableId: string, name: string) => conTakenIn(cur, tableId, name);
  const chooseInCur = (
    schema: string,
    tableId: string,
    n1: string,
    n2: string | null,
    label: string,
    rel: boolean,
    con: boolean,
  ) => chooseName(n1, n2, label, (n) => (rel && relTakenCur(schema, n)) || (con && conTakenCur(tableId, n)));

  const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const cmpTableIn = (m: Model, a: Table, b: Table): number =>
    partitionDepth(m, a.id) - partitionDepth(m, b.id) ||
    cmpStr(get(m, a.parent, 'schema').name, get(m, b.parent, 'schema').name) ||
    cmpStr(a.name, b.name) ||
    cmpStr(a.id, b.id);
  const cmpKeyIn = (
    m: Model,
    a: PrimaryKey | Unique | Check | Index,
    b: PrimaryKey | Unique | Check | Index,
  ): number => {
    const ta = get(m, a.parent, 'table');
    const tb = get(m, b.parent, 'table');
    // 非分区表（含叶子分区本地对象）优先于分区父表创建，防止父表隐式索引名抢占子表本地对象名；
    // 同为分区父表时按分区深度升序（根父表先于二级子父表），与 createAll (P10→P15) 及 PG 实际继承建索引顺序严格一致。
    const partDiff = (ta.partitionBy !== null ? 1 : 0) - (tb.partitionBy !== null ? 1 : 0);
    if (partDiff !== 0) return partDiff;
    const depthDiff =
      ta.partitionBy !== null
        ? partitionDepth(m, ta.id) - partitionDepth(m, tb.id)
        : partitionDepth(m, tb.id) - partitionDepth(m, ta.id);
    return (
      depthDiff ||
      cmpStr(get(m, ta.parent, 'schema').name, get(m, tb.parent, 'schema').name) ||
      cmpStr(ta.name, tb.name) ||
      cmpStr(a.name, b.name) ||
      cmpStr(a.id, b.id)
    );
  };
  const conTakenSim = (
    m: Model,
    idx: ReturnType<typeof buildModelIndex>,
    tableId: string,
    name: string,
  ): boolean => {
    for (const kind of ['primaryKey', 'unique', 'check', 'foreignKey'] as const) {
      for (const o of idx.childrenRef(tableId, kind)) {
        if (o.name === name) return true;
      }
    }
    if (cap.namedNotNull) {
      for (const c of idx.childrenRef(tableId, 'column')) {
        if (c.notNull && c.notNullName === name) return true;
      }
    }
    for (const anc of partitionAncestors(m, tableId)) {
      for (const k of idx.childrenRef(anc.id, 'check')) if (k.name === name) return true;
      for (const k of idx.childrenRef(anc.id, 'foreignKey')) if (k.name === name) return true;
      if (cap.namedNotNull) {
        for (const c of idx.childrenRef(anc.id, 'column')) {
          if (c.notNull && c.notNullName === name) return true;
        }
      }
    }
    return false;
  };
  const simulateImplicitNames = (m: Model, idx: ReturnType<typeof buildModelIndex>): Map<string, string> => {
    const out = new Map<string, string>();
    if (!idx.allRef('table').some((t) => t.partitionOf !== null)) return out;
    const takenRel = new Set<string>();
    const takenCon = new Set<string>();
    for (const kind of ['primaryKey', 'unique', 'index'] as const) {
      const label = kind === 'primaryKey' ? 'pkey' : kind === 'unique' ? 'key' : 'idx';
      const isCon = kind !== 'index';
      const ancObjs = idx
        .allRef(kind)
        .filter((o): o is PrimaryKey | Unique | Index => get(m, o.parent, 'table').partitionBy !== null)
        .sort((a, b) => cmpKeyIn(m, a, b));
      for (const ancObj of ancObjs) {
        const colPart =
          kind === 'primaryKey'
            ? null
            : kind === 'unique'
              ? joinNames((ancObj as Unique).columns.map((c) => get(m, c, 'column').name))
              : joinNames(indexElementNames(m, ancObj as Index));
        const descs = idx.partitionDescendants(ancObj.parent).sort((a, b) => cmpTableIn(m, a, b));
        for (const desc of descs) {
          const name = chooseName(
            desc.name,
            colPart,
            label,
            (n) =>
              idx.isPgRelTaken(desc.parent, n, '') ||
              takenRel.has(`${desc.parent}:${n}`) ||
              (isCon && (conTakenSim(m, idx, desc.id, n) || takenCon.has(`${desc.id}:${n}`))),
          );
          takenRel.add(`${desc.parent}:${name}`);
          if (isCon) takenCon.add(`${desc.id}:${name}`);
          out.set(`${desc.id}#imp#${ancObj.id}`, name);
        }
      }
    }
    return out;
  };
  const fromImplicitNames = simulateImplicitNames(from, fromIdx);
  const toImplicitNames = simulateImplicitNames(to, toIdx);

  const materialized = new Set<string>();
  const detachedOrigin = new Map<string, string>();
  const syntheticDetached = new Set<string>();
  const retainedForReattach = new Set<string>();
  const keptForAttachCheck = new Set<string>();

  // ───── P0 删晚期不透明对象（被删除的、要重建的），依赖它的先删 ─────
  const lateDrops = all(from, 'opaque').filter(
    (o) => isLate(o) && (isRemoved(o.id) || lateRebuild.has(o.id)),
  );
  for (const o of topo(lateDrops).reverse()) dropOpaque(o);

  // ───── P0b 脱离需要脱离或改边界的子分区（按深度降序，先脱离最深层子分区） ─────
  let synSeq = 0;
  for (const tId of [...willDetach].sort(
    (a, b) =>
      partitionDepth(from, b) - partitionDepth(from, a) ||
      cmpTableIn(from, get(from, a, 'table'), get(from, b, 'table')),
  )) {
    const t = get(cur, tId, 'table');
    const oldParentId = t.partitionOf!.parent;
    const oldAncestors = ancestorsCur(oldParentId);
    const oldRootId = rootTableId(cur, tId);
    const oldRootCols = columnsOf(cur, oldRootId);
    const isFullDetach = detaching.has(tId);
    const targetPartOf = (to.objects[tId] as Table).partitionOf;
    const sameParentRebind = rebinding.has(tId) && targetPartOf?.parent === oldParentId;

    emit('detachPartition', tId, `ALTER TABLE ${T(oldParentId)} DETACH PARTITION ${T(tId)}`);
    t.partitionOf = null;

    // 1. 物化列到 cur（与 PG DETACH 后的实际列状态一致）
    const rootToCurCol = new Map<string, string>();
    const detMap = detachRootToNewCol.get(tId);
    for (const rc of oldRootCols) {
      const matchedToId = isFullDetach ? detMap?.get(rc.id) : undefined;
      const cid = matchedToId ?? `__dowel_det_col_${++synSeq}`;
      rootToCurCol.set(rc.id, cid);
      cur.objects[cid] = {
        id: cid,
        kind: 'column',
        parent: tId,
        name: rc.name,
        pos: rc.pos,
        type: rc.type,
        typeRef: rc.typeRef,
        notNull: rc.notNull,
        notNullName: cap.namedNotNull && rc.notNull ? rc.notNullName : null,
        notNullNameMode: 'explicit',
        default: rc.default ? clone(rc.default) : null,
        identity: null,
        generated: rc.generated ? clone(rc.generated) : null,
        collation: rc.collation,
        comment: null,
      };
      if (matchedToId) materialized.add(matchedToId);
      else syntheticDetached.add(cid);
    }

    // 2. 把该子分区（及其后代）原有本地约束/索引的列引用映射到新物化的列 ID
    const subDescendants = partitionDescendants(cur, tId);
    const subTree = new Set([tId, ...subDescendants.map((d) => d.id)]);
    const mapCol = (c: string) => rootToCurCol.get(c) ?? c;
    for (const o of Object.values(cur.objects)) {
      if (o.kind === 'table' && subTree.has(o.id) && o.partitionBy && typeof o.partitionBy !== 'string') {
        for (const k of o.partitionBy.keys) if (k.column) k.column = mapCol(k.column);
      }
      if (!('parent' in o) || !subTree.has(o.parent)) continue;
      if (o.kind === 'primaryKey' || o.kind === 'unique') o.columns = o.columns.map(mapCol);
      else if (o.kind === 'foreignKey') {
        o.columns = o.columns.map(mapCol);
        if (subTree.has(o.refTable)) o.refColumns = o.refColumns.map(mapCol);
      } else if (o.kind === 'index') {
        for (const el of o.elements) if (el.column) el.column = mapCol(el.column);
        o.include = o.include.map(mapCol);
      }
    }

    // 3. 物化祖先表被 PG DETACH 转为独立对象的约束与索引
    const ancIds = new Set(oldAncestors.map((a) => a.id));
    const ancFksOnOld = Object.values(cur.objects).filter(
      (o): o is ForeignKey => o.kind === 'foreignKey' && ancIds.has(o.parent),
    );
    const ancUniquesOnOld = Object.values(cur.objects).filter(
      (o): o is Unique => o.kind === 'unique' && ancIds.has(o.parent),
    );
    const ancIdxsOnOld = Object.values(cur.objects).filter(
      (o): o is Index => o.kind === 'index' && ancIds.has(o.parent),
    );
    const hasDupAncDef = (ancObj: ForeignKey | Unique | Index): boolean => {
      const list =
        ancObj.kind === 'foreignKey'
          ? ancFksOnOld
          : ancObj.kind === 'unique'
            ? ancUniquesOnOld
            : ancIdxsOnOld;
      return list.filter((x) => sameDef(x, ancObj)).length > 1;
    };
    const matchedToObjs = new Set<string>();
    const toOnT = Object.values(to.objects).filter((o) => 'parent' in o && o.parent === tId);
    const registerDetached = (
      ancObj: PrimaryKey | Unique | Check | ForeignKey | Index,
      detObj: PrimaryKey | Unique | Check | ForeignKey | Index,
      seedPrefix: 'con' | 'idx',
    ) => {
      if (isFullDetach) {
        const detId = derivedUuid(`${tId}:${seedPrefix}:${ancObj.id}`);
        let toMatch = toOnT.find((x) => x.id === detId && x.kind === detObj.kind && !matchedToObjs.has(x.id));
        if (!toMatch && (detObj.kind === 'unique' || detObj.kind === 'index')) {
          toMatch = toOnT.find(
            (x) =>
              x.kind === detObj.kind &&
              !matchedToObjs.has(x.id) &&
              !Object.hasOwn(cur.objects, x.id) &&
              x.name === detObj.name &&
              sameDef(x, migrated(detObj)),
          );
        }
        if (!toMatch) {
          toMatch = toOnT.find((x) => {
            if (x.kind !== detObj.kind || matchedToObjs.has(x.id) || Object.hasOwn(cur.objects, x.id))
              return false;
            if (x.kind === 'primaryKey') return true;
            if (x.kind === 'check' && detObj.kind === 'check')
              return x.name === detObj.name || x.expr === migrateExpr(detObj.expr, tId);
            if (x.kind === 'foreignKey' && detObj.kind === 'foreignKey') return x.name === detObj.name;
            return sameDef(x, migrated(detObj));
          });
        }
        if (toMatch) {
          matchedToObjs.add(toMatch.id);
          const placed = { ...detObj, id: toMatch.id };
          cur.objects[toMatch.id] = placed;
          materialized.add(toMatch.id);
          detachedOrigin.set(toMatch.id, ancObj.id);
          if (
            !sameDef(toMatch, migrated(placed)) ||
            usesCols(placed, regen) ||
            usesCols(placed, typeChanged) ||
            (placed.kind === 'foreignKey' && (usesCols(placed, enumCols) || refKeyGone(placed.refTable)))
          ) {
            rebuild.add(toMatch.id);
            if (
              placed.kind === 'primaryKey' ||
              placed.kind === 'unique' ||
              (placed.kind === 'index' && placed.unique)
            ) {
              refTablesWithGoneKey.add(placed.parent);
            }
          }
          return;
        }
      }
      const synId = `__dowel_det_obj_${++synSeq}`;
      cur.objects[synId] = { ...detObj, id: synId };
      syntheticDetached.add(synId);
      const childRenamed = t.name !== (to.objects[tId] as Table | undefined)?.name;
      const colRenamedInKey =
        ancObj.kind === 'primaryKey' || ancObj.kind === 'unique'
          ? ancObj.columns.some((cid) => cur.objects[cid]?.name !== to.objects[cid]?.name)
          : ancObj.kind === 'foreignKey'
            ? ancObj.columns.some((cid) => cur.objects[cid]?.name !== to.objects[cid]?.name) ||
              ancObj.refColumns.some((cid) => cur.objects[cid]?.name !== to.objects[cid]?.name)
            : ancObj.kind === 'check'
              ? ancObj.expr !== (to.objects[ancObj.id] as Check | undefined)?.expr
              : ancObj.elements.some((e, i) =>
                  e.column
                    ? cur.objects[e.column]?.name !== to.objects[e.column]?.name
                    : e.expr !== (to.objects[ancObj.id] as Index | undefined)?.elements[i]?.expr,
                ) ||
                ancObj.include.some((cid) => cur.objects[cid]?.name !== to.objects[cid]?.name) ||
                ancObj.where !== (to.objects[ancObj.id] as Index | undefined)?.where;
      const keepImplicitName =
        ancObj.kind === 'check'
          ? ancObj.name === to.objects[ancObj.id]?.name && !colRenamedInKey
          : ancObj.kind === 'foreignKey'
            ? ancObj.name === to.objects[ancObj.id]?.name &&
              !colRenamedInKey &&
              !hasDupAncDef(ancObj) &&
              !Object.values(cur.objects).some(
                (x) =>
                  x.kind === 'foreignKey' &&
                  x.parent === tId &&
                  x.id !== synId &&
                  !syntheticDetached.has(x.id) &&
                  sameDef(x, detObj),
              )
            : !childRenamed &&
              !colRenamedInKey &&
              detObj.name === toImplicitNames.get(`${tId}#imp#${ancObj.id}`) &&
              subDescendants.every(
                (d) =>
                  fromImplicitNames.get(`${d.id}#imp#${detachedOrigin.get(ancObj.id) ?? ancObj.id}`) ===
                  toImplicitNames.get(`${d.id}#imp#${ancObj.id}`),
              ) &&
              (ancObj.kind === 'primaryKey' || !hasDupAncDef(ancObj));
      if (sameParentRebind && inTo(ancObj.id) && !rebuild.has(ancObj.id) && keepImplicitName) {
        retainedForReattach.add(synId);
      }
    };

    for (const pk of Object.values(cur.objects)
      .filter((o): o is PrimaryKey => o.kind === 'primaryKey' && ancIds.has(o.parent))
      .sort((a, b) => cmpKeyIn(cur, a, b))) {
      if (childrenOf(cur, tId, 'primaryKey').length > 0) continue;
      const mappedCols = pk.columns.map(mapCol);
      const detName =
        fromImplicitNames.get(`${tId}#imp#${detachedOrigin.get(pk.id) ?? pk.id}`) ??
        chooseInCur(t.parent, tId, t.name, null, 'pkey', true, true);
      registerDetached(
        pk,
        {
          id: '',
          kind: 'primaryKey',
          parent: tId,
          name: detName,
          nameMode: 'derived',
          columns: mappedCols,
          comment: null,
        },
        'con',
      );
    }
    for (const u of Object.values(cur.objects)
      .filter((o): o is Unique => o.kind === 'unique' && ancIds.has(o.parent))
      .sort((a, b) => cmpKeyIn(cur, a, b))) {
      const mappedCols = u.columns.map(mapCol);
      const colNames = mappedCols.map((c) => get(cur, c, 'column').name);
      const detName =
        fromImplicitNames.get(`${tId}#imp#${detachedOrigin.get(u.id) ?? u.id}`) ??
        chooseInCur(t.parent, tId, t.name, joinNames(colNames), 'key', true, true);
      registerDetached(
        u,
        {
          id: '',
          kind: 'unique',
          parent: tId,
          name: detName,
          nameMode: 'derived',
          columns: mappedCols,
          nullsNotDistinct: u.nullsNotDistinct,
          comment: null,
        },
        'con',
      );
    }
    for (const anc of oldAncestors) {
      for (const ck of childrenOf(cur, anc.id, 'check')) {
        if (childrenOf(cur, tId, 'check').some((x) => x.name === ck.name)) continue;
        registerDetached(
          ck,
          {
            id: '',
            kind: 'check',
            parent: tId,
            name: ck.name,
            nameMode: 'explicit',
            expr: ck.expr,
            noInherit: false,
            comment: null,
          },
          'con',
        );
      }
      for (const fk of childrenOf(cur, anc.id, 'foreignKey')) {
        if (childrenOf(cur, tId, 'foreignKey').some((x) => x.name === fk.name)) continue;
        registerDetached(
          fk,
          {
            id: '',
            kind: 'foreignKey',
            parent: tId,
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
          },
          'con',
        );
      }
    }
    for (const idx of Object.values(cur.objects)
      .filter((o): o is Index => o.kind === 'index' && ancIds.has(o.parent))
      .sort((a, b) => cmpKeyIn(cur, a, b))) {
      const mappedIdx: Index = {
        id: '',
        kind: 'index',
        parent: tId,
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
      mappedIdx.name =
        fromImplicitNames.get(`${tId}#imp#${detachedOrigin.get(idx.id) ?? idx.id}`) ??
        chooseInCur(t.parent, tId, t.name, joinNames(indexElementNames(cur, mappedIdx)), 'idx', true, false);
      registerDetached(idx, mappedIdx, 'idx');
    }
  }

  // 对 attaching 表上在 to 中已被吸收的 CHECK：若与目标父表/祖先表上未重建的 CHECK 同名同表达式，则保留至 P12h 由 ATTACH 吸收
  for (const tId of attaching) {
    const targetParentId = (to.objects[tId] as Table).partitionOf!.parent;
    const ancIds = new Set(ancestorsCur(targetParentId).map((a) => a.id));
    const ancChecks = Object.values(cur.objects).filter(
      (o): o is Check =>
        o.kind === 'check' &&
        ancIds.has(o.parent) &&
        inTo(o.id) &&
        !rebuild.has(o.id) &&
        o.name === to.objects[o.id]!.name,
    );
    for (const ck of childrenOf(cur, tId, 'check')) {
      if (
        !ck.noInherit &&
        isRemoved(ck.id) &&
        ancChecks.some((ak) => ak.name === ck.name && ak.expr === ck.expr)
      ) {
        keptForAttachCheck.add(ck.id);
      }
    }
  }

  // ───── P1 删外键 ─────
  for (const id in cur.objects) {
    const o = cur.objects[id]!;
    if (o.kind !== 'foreignKey') continue;
    const shouldDrop = syntheticDetached.has(o.id)
      ? !retainedForReattach.has(o.id)
      : isRemoved(o.id) || rebuild.has(o.id);
    if (!shouldDrop) continue;
    emit('dropForeignKey', o.id, `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${ident(o.name)}`);
    delete cur.objects[o.id];
  }
  // ───── P2 删其他约束和索引（所在表要删的跳过，删表时一起删掉） ─────
  for (const id in cur.objects) {
    const o = cur.objects[id]!;
    if (!isKey(o) || tableRemoved(o) || keptForAttachCheck.has(o.id)) continue;
    const shouldDrop = syntheticDetached.has(o.id)
      ? !retainedForReattach.has(o.id)
      : isRemoved(o.id) || rebuild.has(o.id);
    if (!shouldDrop) continue;
    if (o.kind === 'index') emit('dropIndex', o.id, `DROP INDEX ${relIn(o.parent, o.name)}`);
    else
      emit(
        `drop${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}`,
        o.id,
        `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${ident(o.name)}`,
      );
    delete cur.objects[o.id];
  }
  // 删表 / 删列会顺带删掉的对象：其上的约束和索引、属于它的序列
  const autoDropped = new Set<string>();
  const dropWithColumn = (colId: string) => {
    const col = cur.objects[colId];
    for (const s of all(cur, 'sequence')) if (s.ownedBy === colId) autoDropped.add(s.id);
    for (const o of Object.values(cur.objects)) {
      if (!isKey(o)) continue;
      if (o.kind === 'primaryKey' || o.kind === 'unique') {
        if (o.columns.includes(colId)) delete cur.objects[o.id];
      } else if (o.kind === 'check') {
        if (
          col?.kind === 'column' &&
          (o.parent === col.parent || rootTableId(cur, o.parent) === col.parent) &&
          exprReferences(o.expr, col.name)
        ) {
          delete cur.objects[o.id];
        }
      } else if (o.kind === 'index') {
        const sameFamily =
          col?.kind === 'column' && (o.parent === col.parent || rootTableId(cur, o.parent) === col.parent);
        if (
          o.elements.some(
            (e) =>
              e.column === colId ||
              (sameFamily && !e.column && e.expr !== null && exprReferences(e.expr, col.name)),
          ) ||
          o.include.includes(colId) ||
          (sameFamily && o.where !== null && exprReferences(o.where, col.name))
        ) {
          delete cur.objects[o.id];
        }
      }
    }
  };
  // ───── P3 删需要重建的生成列 ─────
  for (const id of regen) {
    const c = get(cur, id, 'column');
    emit('dropColumn', id, `ALTER TABLE ${T(c.parent)} DROP COLUMN ${ident(c.name)}`);
    dropWithColumn(id);
    delete cur.objects[id];
  }
  // ───── P4 删表（按分区深度降序，深层子分区先于父表） ─────
  const hasReferencingFkOnAncestor = (tableId: string) => {
    const ancIds = new Set(
      ancestorsCur(tableId)
        .slice(1)
        .map((a) => a.id),
    );
    return ancIds.size > 0 && all(cur, 'foreignKey').some((fk) => ancIds.has(fk.refTable));
  };
  const removedTables = removed
    .filter((o): o is Table => o.kind === 'table')
    .sort((x, y) => partitionDepth(from, y.id) - partitionDepth(from, x.id));
  for (const o of removedTables) {
    if (!Object.hasOwn(cur.objects, o.id)) continue;
    const curT = get(cur, o.id, 'table');
    // 若父表或祖先表仍被外键引用，PG 禁止直接 DROP 子分区，需先 DETACH 再 DROP
    if (curT.partitionOf && hasReferencingFkOnAncestor(o.id)) {
      emit('detachPartition', o.id, `ALTER TABLE ${T(curT.partitionOf.parent)} DETACH PARTITION ${T(o.id)}`);
      curT.partitionOf = null;
    }
    emit('dropTable', o.id, `DROP TABLE ${T(o.id)}`);
    for (const c of childrenOf(cur, o.id, 'column')) {
      dropWithColumn(c.id);
      delete cur.objects[c.id];
    }
    for (const k of Object.values(cur.objects))
      if ('parent' in k && k.parent === o.id) delete cur.objects[k.id];
    delete cur.objects[o.id];
  }
  // ───── P5 删列（生成列先删，它们依赖普通列） ─────
  const colsToDrop = [
    ...removed.filter((o): o is Column => o.kind === 'column'),
    ...Object.values(cur.objects).filter(
      (o): o is Column => o.kind === 'column' && syntheticDetached.has(o.id) && detaching.has(o.parent),
    ),
  ].sort((x, y) => (x.generated ? 0 : 1) - (y.generated ? 0 : 1));
  for (const o of colsToDrop) {
    if (!Object.hasOwn(cur.objects, o.id)) continue;
    if (attachKeptCols.has(o.id)) continue; // 将在 P12h 随 ATTACH 吸收
    emit('dropColumn', o.id, `ALTER TABLE ${T(o.parent)} DROP COLUMN ${C(o.id)}`);
    dropWithColumn(o.id);
    delete cur.objects[o.id];
  }
  for (const id of autoDropped) delete cur.objects[id];

  // ───── P5b 提前去掉 identity 和 NOT NULL：它们占用的序列名、约束名可能是后面改名的目标 ─────
  for (const o of toIdx.allRef('column')) {
    if (regen.has(o.id) || (!inFrom(o.id) && !materialized.has(o.id))) continue;
    const c = cur.objects[o.id];
    if (c?.kind !== 'column') continue;
    const A0 = `ALTER TABLE ${T(c.parent)} ALTER COLUMN ${C(c.id)}`;
    if (c.identity && !o.identity) {
      emit('dropIdentity', o.id, `${A0} DROP IDENTITY`);
      c.identity = null;
    }
    if (c.notNull && !o.notNull) {
      emit('dropNotNull', o.id, `${A0} DROP NOT NULL`);
      c.notNull = false;
      c.notNullName = null;
    }
  }

  // ───── P6 改名（含为腾出名字而临时改名） ─────
  type Renamable = {
    id: string;
    spaces: string[];
    target: string;
    apply: (name: string) => void;
    rename: (name: string) => string;
  };
  const items: Renamable[] = [];
  const schemaOfTable = (tableId: string) => get(cur, tableId, 'table').parent;
  let curPartChildren: Map<string, string[]> | null = null;
  const conFamilySpacesCache = new Map<string, string[]>();
  const conFamilySpacesCur = (tableId: string): string[] => {
    const cached = conFamilySpacesCache.get(tableId);
    if (cached) return cached;
    if (!curPartChildren) {
      curPartChildren = new Map();
      for (const o of Object.values(cur.objects)) {
        if (o.kind !== 'table' || !o.partitionOf) continue;
        let list = curPartChildren.get(o.partitionOf.parent);
        if (!list) curPartChildren.set(o.partitionOf.parent, (list = []));
        list.push(o.id);
      }
    }
    const out = [`con:${tableId}`];
    if (curPartChildren.has(tableId)) {
      const seen = new Set<string>([tableId]);
      const queue = [tableId];
      for (let head = 0; head < queue.length; head++) {
        const pid = queue[head]!;
        const kids = curPartChildren.get(pid);
        if (!kids) continue;
        for (const cid of kids) {
          if (seen.has(cid)) continue;
          seen.add(cid);
          out.push(`con:${cid}`);
          queue.push(cid);
        }
      }
    }
    conFamilySpacesCache.set(tableId, out);
    return out;
  };
  const spacesOf = (o: Obj): string[] => {
    switch (o.kind) {
      case 'schema':
        return ['schema'];
      case 'extension':
        return ['extension'];
      case 'opaque':
        return [`opaque:${o.objType}:${o.parent}`];
      case 'table':
        return [`rel:${o.parent}`, `type:${o.parent}`];
      case 'enum':
        return [`type:${o.parent}`];
      case 'sequence':
        return [`rel:${o.parent}`];
      case 'column':
        return [`col:${o.parent}`];
      case 'index':
        return [`rel:${schemaOfTable(o.parent)}`];
      case 'primaryKey':
      case 'unique':
        return [`rel:${schemaOfTable(o.parent)}`, `con:${o.parent}`];
      case 'check':
        return conFamilySpacesCur(o.parent);
      case 'foreignKey':
        return [`con:${o.parent}`];
    }
  };
  const renameSql = (o: Obj, name: string): string => {
    switch (o.kind) {
      case 'schema':
        return `ALTER SCHEMA ${ident(o.name)} RENAME TO ${ident(name)}`;
      case 'table':
        return `ALTER TABLE ${T(o.id)} RENAME TO ${ident(name)}`;
      case 'enum':
        return `ALTER TYPE ${qname(cur, o)} RENAME TO ${ident(name)}`;
      case 'sequence':
        return `ALTER SEQUENCE ${qname(cur, o)} RENAME TO ${ident(name)}`;
      case 'column':
        return `ALTER TABLE ${T(o.parent)} RENAME COLUMN ${ident(o.name)} TO ${ident(name)}`;
      case 'index':
        return `ALTER INDEX ${relIn(o.parent, o.name)} RENAME TO ${ident(name)}`;
      default:
        return `ALTER TABLE ${T(o.parent)} RENAME CONSTRAINT ${ident(o.name)} TO ${ident(name)}`;
    }
  };
  for (const id in to.objects) {
    if (!inFrom(id) && !materialized.has(id)) continue;
    const o = to.objects[id]!;
    const c = cur.objects[id];
    if (!c) continue; // 已在前面被删掉重建
    if (c.name !== o.name && c.kind !== 'opaque' && c.kind !== 'extension') {
      items.push({
        id: o.id,
        spaces: spacesOf(c),
        target: o.name,
        rename: (n) => renameSql(cur.objects[o.id]!, n),
        apply: (n) => {
          cur.objects[o.id]!.name = n;
        },
      });
    }
    // 列附带的两个名字：NOT NULL 约束、identity 序列
    if (o.kind === 'column' && c.kind === 'column') {
      if (
        cap.namedNotNull &&
        c.notNull &&
        o.notNull &&
        c.notNullName &&
        o.notNullName &&
        c.notNullName !== o.notNullName
      ) {
        items.push({
          id: `${o.id}#nn`,
          spaces: conFamilySpacesCur(o.parent),
          target: o.notNullName,
          rename: (n) =>
            `ALTER TABLE ${T(o.parent)} RENAME CONSTRAINT ${ident(get(cur, o.id, 'column').notNullName!)} TO ${ident(n)}`,
          apply: (n) => {
            get(cur, o.id, 'column').notNullName = n;
          },
        });
      }
      if (c.identity && o.identity && c.identity.sequenceName !== o.identity.sequenceName) {
        items.push({
          id: `${o.id}#seq`,
          spaces: [`rel:${schemaOfTable(o.parent)}`],
          target: o.identity.sequenceName,
          rename: (n) =>
            `ALTER SEQUENCE ${relIn(o.parent, get(cur, o.id, 'column').identity!.sequenceName)} RENAME TO ${ident(n)}`,
          apply: (n) => {
            get(cur, o.id, 'column').identity!.sequenceName = n;
          },
        });
      }
    }
  }
  // 分区子表改名或父表约束/索引引用列改名时，同步重命名 PG 在后代子分区上自动生成的隐式继承 PK/UNIQUE/INDEX，
  // 避免旧名继续占用关系命名空间导致同迁移占名冲突，或跨版本 DETACH 时与派生名失步。
  const implicitState = new Map<string, { name: string; spaces: string[] }>();
  const attachedChildrenInCur: Table[] = [];
  for (const id in cur.objects) {
    const t = cur.objects[id]!;
    if (t.kind === 'table' && t.partitionOf !== null && inTo(t.id)) attachedChildrenInCur.push(t);
  }
  attachedChildrenInCur.sort((a, b) => cmpTableIn(cur, a, b));
  if (attachedChildrenInCur.length > 0) {
    const oldNameMap = fromImplicitNames;
    const newNameMap = toImplicitNames;
    const curKeysByParent = new Map<
      string,
      Record<'primaryKey' | 'unique' | 'index', (PrimaryKey | Unique | Index)[]>
    >();
    const curFksByParent = new Map<string, ForeignKey[]>();
    for (const id in cur.objects) {
      const o = cur.objects[id]!;
      if ((o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'index') && inTo(o.id)) {
        let g = curKeysByParent.get(o.parent);
        if (!g) curKeysByParent.set(o.parent, (g = { primaryKey: [], unique: [], index: [] }));
        g[o.kind].push(o);
      } else if (o.kind === 'foreignKey') {
        let g = curFksByParent.get(o.parent);
        if (!g) curFksByParent.set(o.parent, (g = []));
        g.push(o);
      }
    }
    for (const desc of attachedChildrenInCur) {
      const ancs = ancestorsCur(desc.partitionOf!.parent);
      for (const kind of ['primaryKey', 'unique', 'index'] as const) {
        const isCon = kind !== 'index';
        const ancObjs: (PrimaryKey | Unique | Index)[] = [];
        for (const a of ancs) {
          const list = curKeysByParent.get(a.id)?.[kind];
          if (list) ancObjs.push(...list);
        }
        ancObjs.sort((a, b) => cmpKeyIn(cur, a, b));
        for (const ancObj of ancObjs) {
          const origId = detachedOrigin.get(ancObj.id) ?? ancObj.id;
          const oldName = oldNameMap.get(`${desc.id}#imp#${origId}`);
          const newName = newNameMap.get(`${desc.id}#imp#${ancObj.id}`);
          if (!oldName || !newName) continue;
          const impId = `${desc.id}#imp#${ancObj.id}`;
          const spaces = isCon ? [`rel:${desc.parent}`, `con:${desc.id}`] : [`rel:${desc.parent}`];
          implicitState.set(impId, { name: oldName, spaces });
          if (oldName !== newName) {
            items.push({
              id: impId,
              spaces,
              target: newName,
              rename: (n) =>
                kind === 'index'
                  ? `ALTER INDEX ${relIn(desc.id, implicitState.get(impId)!.name)} RENAME TO ${ident(n)}`
                  : `ALTER TABLE ${T(desc.id)} RENAME CONSTRAINT ${ident(implicitState.get(impId)!.name)} TO ${ident(n)}`,
              apply: (n) => {
                implicitState.get(impId)!.name = n;
              },
            });
          }
        }
      }
    }
    // PG 在子分区上克隆的继承 FOREIGN KEY 不会随父表 RENAME CONSTRAINT 自动改名，
    // 在此显式将其纳入 P6 改名图与 con:${desc.id} 命名空间，随父表同步改名并安全处理跨层互换。
    for (const desc of attachedChildrenInCur) {
      const ancs = ancestorsCur(desc.partitionOf!.parent);
      const ancFks: ForeignKey[] = [];
      for (const a of ancs) {
        const list = curFksByParent.get(a.id);
        if (list) ancFks.push(...list);
      }
      ancFks.sort((a, b) => cmpStr(a.id, b.id));
      for (const ancFk of ancFks) {
        const impId = `${desc.id}#impfk#${ancFk.id}`;
        const spaces = [`con:${desc.id}`];
        implicitState.set(impId, { name: ancFk.name, spaces });
        const targetFk = to.objects[ancFk.id];
        if (targetFk?.kind === 'foreignKey' && ancFk.name !== targetFk.name) {
          items.push({
            id: impId,
            spaces,
            target: targetFk.name,
            rename: (n) =>
              `ALTER TABLE ${T(desc.id)} RENAME CONSTRAINT ${ident(implicitState.get(impId)!.name)} TO ${ident(n)}`,
            apply: (n) => {
              implicitState.get(impId)!.name = n;
            },
          });
        }
      }
    }
  }
  // 后面才删除的对象（枚举、序列、schema）如果占着新对象要用的名字，先改成临时名腾出来
  const removedNeedTmp = removed.filter(
    (o) => (o.kind === 'enum' || o.kind === 'sequence' || o.kind === 'schema') && cur.objects[o.id],
  );
  if (removedNeedTmp.length > 0) {
    const toNames = new Set<string>();
    for (const o of Object.values(to.objects))
      for (const s of spacesOfTo(to, o)) toNames.add(`${s}\u0000${o.name}`);
    for (const it of items) {
      if (it.target) for (const s of it.spaces) toNames.add(`${s}\u0000${it.target}`);
    }
    for (const o of removedNeedTmp) {
      const c = cur.objects[o.id]!;
      if (spacesOf(c).some((s) => toNames.has(`${s}\u0000${c.name}`)))
        items.push({
          id: o.id,
          spaces: spacesOf(c),
          target: '',
          rename: (n) => renameSql(cur.objects[o.id]!, n),
          apply: (n) => {
            cur.objects[o.id]!.name = n;
          },
        });
    }
  }
  if (items.length > 0) {
    const targetNames = new Set<string>();
    const targetKeys = new Set<string>();
    for (const it of items) {
      if (!it.target) continue;
      targetNames.add(it.target);
      for (const s of it.spaces) targetKeys.add(`${s}\u0000${it.target}`);
    }
    const hasTargetRenames = targetNames.size > 0;
    // 仅收集目标命名空间键的占用情况，避免全量构建数万个无冲突 Set/Array
    const occMap = new Map<string, Set<string>>();
    const idToKeys = new Map<string, string[]>();
    const addOcc = (id: string, space: string, name: string) => {
      const k = `${space}\u0000${name}`;
      if (!targetKeys.has(k)) return;
      let set = occMap.get(k);
      if (!set) occMap.set(k, (set = new Set()));
      set.add(id);
      let arr = idToKeys.get(id);
      if (!arr) idToKeys.set(id, (arr = []));
      arr.push(k);
    };
    const moveOcc = (id: string, spaces: string[], name: string) => {
      const oldKeys = idToKeys.get(id);
      if (oldKeys) {
        for (const k of oldKeys) {
          const set = occMap.get(k);
          if (set) {
            set.delete(id);
            if (set.size === 0) occMap.delete(k);
          }
        }
      }
      idToKeys.delete(id);
      for (const s of spaces) addOcc(id, s, name);
    };
    if (hasTargetRenames) {
      for (const id in cur.objects) {
        const o = cur.objects[id]!;
        if (targetNames.has(o.name)) {
          for (const s of spacesOf(o)) addOcc(o.id, s, o.name);
        }
        if (o.kind === 'column') {
          if (cap.namedNotNull && o.notNull && o.notNullName && targetNames.has(o.notNullName)) {
            for (const s of conFamilySpacesCur(o.parent)) addOcc(`${o.id}#nn`, s, o.notNullName);
          }
          if (o.identity?.sequenceName && targetNames.has(o.identity.sequenceName)) {
            addOcc(`${o.id}#seq`, `rel:${schemaOfTable(o.parent)}`, o.identity.sequenceName);
          }
        }
      }
      for (const [impId, st] of implicitState) {
        if (targetNames.has(st.name)) {
          for (const s of st.spaces) addOcc(impId, s, st.name);
        }
      }
    }
    const occupant = (space: string, name: string, selfId: string): string | undefined => {
      const set = occMap.get(`${space}\u0000${name}`);
      if (!set) return undefined;
      for (const id of set) if (id !== selfId) return id;
      return undefined;
    };
    const byId = new Map(items.map((i) => [i.id, i]));
    const applyRename = (it: Renamable, n: string) => {
      emit('rename', it.id, it.rename(n));
      it.apply(n);
      if (hasTargetRenames) moveOcc(it.id, it.spaces, n);
    };
    const toTemp = (it: Renamable) => applyRename(it, `_dowel_tmp_${++tmp}`);
    // 先让出被占用的名字（互换、链式改名），再一次改到目标名
    for (const it of items) if (!it.target) toTemp(it);
    if (hasTargetRenames) {
      for (let changed = true; changed;) {
        changed = false;
        for (const it of items) {
          if (!it.target) continue;
          for (const s of it.spaces) {
            const occ = occupant(s, it.target, it.id);
            if (occ) {
              const blocker = byId.get(occ);
              if (!blocker) throw new PlanError(`名字 ${it.target} 已被占用，无法改名`);
              if (blocker.target === it.target) throw new PlanError(`名字冲突：${it.target}`);
              toTemp(blocker);
              changed = true;
            }
          }
        }
      }
      for (const it of items) {
        if (!it.target) continue;
        applyRename(it, it.target);
      }
    }
  }

  // 改名完成后，PG 已自动更新了引用这些名字的表达式：把当前状态里的表达式同步成新文本
  if (hasAnyExprMigration) {
    for (const id in to.objects) {
      if (!inFrom(id) && !materialized.has(id)) continue;
      const o = to.objects[id]!;
      const c = cur.objects[id];
      if (!c) continue;
      if (
        !(
          (c.kind === 'table' && Boolean(c.partitionBy) && o.kind === 'table' && Boolean(o.partitionBy)) ||
          (c.kind === 'check' && o.kind === 'check') ||
          (c.kind === 'index' && o.kind === 'index') ||
          (c.kind === 'column' &&
            o.kind === 'column' &&
            (Boolean(c.generated) || Boolean(c.default && 'expr' in c.default)))
        )
      ) {
        continue;
      }
      const tblId = o.kind === 'table' ? o.id : o.parent;
      if (!hasGlobalRename && !tableNeedsMigration(tblId)) continue;
      const base = inFrom(o.id) ? was(o) : c;
      const m = migrated(base);
      if (
        c.kind === 'table' &&
        c.partitionBy &&
        o.kind === 'table' &&
        o.partitionBy &&
        m.kind === 'table' &&
        same(partitionBySql(cur, m, from), partitionBySql(to, o))
      ) {
        c.partitionBy = clone(o.partitionBy);
      }
      if ((c.kind === 'check' || c.kind === 'index') && sameDef(m, o))
        cur.objects[o.id] = { ...c, ...pickExprs(o) } as Obj;
      if (c.kind === 'column' && o.kind === 'column' && m.kind === 'column') {
        if (c.generated && same(m.generated, o.generated)) c.generated = clone(o.generated);
        if (c.default && 'expr' in c.default && same(m.default, o.default)) c.default = clone(o.default);
      }
    }
  }

  // ───── P7 建 schema ─────
  for (const o of added) {
    if (o.kind !== 'schema') continue;
    emit('createSchema', o.id, `CREATE SCHEMA ${ident(o.name)}`);
    cur.objects[o.id] = fresh(o);
  }
  for (const o of added) {
    if (o.kind !== 'extension') continue;
    cur.objects[o.id] = fresh(o);
    const schema = ident(get(cur, o.parent, 'schema').name);
    emit('createExtension', o.id, `CREATE EXTENSION ${ident(o.name)} WITH SCHEMA ${schema}`);
  }
  // ───── P8 建枚举、给枚举加值 ─────
  const dropDefaultCascade = (col: Column) => {
    emit('dropDefault', col.id, `ALTER TABLE ${T(col.parent)} ALTER COLUMN ${C(col.id)} DROP DEFAULT`);
    if (get(cur, col.parent, 'table').partitionBy !== null) {
      for (const desc of partitionDescendants(cur, col.parent)) {
        emit('dropDefault', col.id, `ALTER TABLE ${T(desc.id)} ALTER COLUMN ${C(col.id)} DROP DEFAULT`);
      }
    }
    col.default = null;
  };
  for (const o of added) {
    if (o.kind !== 'enum') continue;
    cur.objects[o.id] = fresh(o);
    emit('createEnum', o.id, `CREATE TYPE ${qname(cur, o)} AS ENUM (${o.values.map(literal).join(', ')})`);
  }
  for (const o of toIdx.allRef('enum')) {
    if (!inFrom(o.id)) continue;
    const c = get(cur, o.id, 'enum');
    const old = c.values;
    if (same(old, o.values)) continue;
    if (enumRebuild.has(o.id)) {
      // 重建：旧类型改成临时名 → 建新类型 → 用到它的列经由 text 转到新类型 → 删旧类型
      const real = c.name;
      const tmpName = `_dowel_tmp_${++tmp}`;
      emit('rename', o.id, `ALTER TYPE ${qname(cur, c)} RENAME TO ${ident(tmpName)}`);
      const oldQ = qualified(get(cur, c.parent, 'schema').name, tmpName);
      c.name = real;
      c.values = [...o.values];
      c.comment = null; // 新类型没有注释，最后统一加
      emit('createEnum', o.id, `CREATE TYPE ${qname(cur, c)} AS ENUM (${o.values.map(literal).join(', ')})`);
      // 引用旧类型的其他列默认值（如 text 列的 'a'::枚举::text）也要先去掉，否则删不掉旧类型；P12 再按新模型重设
      const w = was(o);
      const wSchema = get(from, w.parent, 'schema').name;
      for (const col of all(cur, 'column')) {
        if (
          col.typeRef === o.id ||
          !col.default ||
          !('expr' in col.default) ||
          !qualifiedRefs(col.default.expr).some((r) => r.schema.text === wSchema && r.name.text === w.name)
        )
          continue;
        dropDefaultCascade(col);
      }
      for (const col of all(cur, 'column')) {
        if (col.typeRef !== o.id) continue;
        if (col.default) dropDefaultCascade(col);
        const arr = col.type;
        emit(
          'alterType',
          col.id,
          `ALTER TABLE ${T(col.parent)} ALTER COLUMN ${C(col.id)} TYPE ${qname(cur, c)}${arr} USING ${C(col.id)}::text${arr}::${qname(cur, c)}${arr}`,
        );
      }
      emit('dropEnum', o.id, `DROP TYPE ${oldQ}`);
      continue;
    }
    const now = [...old];
    o.values.forEach((v, i) => {
      if (now.includes(v)) return;
      const sql =
        i === 0
          ? `ALTER TYPE ${qname(cur, c)} ADD VALUE ${literal(v)} BEFORE ${literal(now[0]!)}`
          : `ALTER TYPE ${qname(cur, c)} ADD VALUE ${literal(v)} AFTER ${literal(o.values[i - 1]!)}`;
      emit('addEnumValue', o.id, sql);
      now.splice(i, 0, v);
    });
    c.values = now;
  }
  // ───── P8b 早期不透明对象（域、类型、函数、聚合）：新建的，以及定义变了的 ─────
  const earlyCreates = all(to, 'opaque').filter(
    (o) => !isLate(o) && (!inFrom(o.id) || opaqueChanged.has(o.id)),
  );
  const earlyRedefDrops = earlyCreates
    .filter((o) => inFrom(o.id) && earlyNeedsDropBeforeCreate(was(o), o))
    .map((o) => was(o));
  for (const w of topo(earlyRedefDrops).reverse()) dropOpaque(get(cur, w.id, 'opaque'));
  for (const o of topo(earlyCreates)) createOpaque(o);
  // ───── P9 建序列（属于哪一列在列建好之后再设）、改序列选项 ─────
  for (const o of added) {
    if (o.kind !== 'sequence') continue;
    cur.objects[o.id] = { ...fresh(o), ownedBy: null };
    emit('createSequence', o.id, `CREATE SEQUENCE ${qname(cur, o)} ${seqOptions(o.options, true)}`);
  }
  for (const o of toIdx.allRef('sequence')) {
    if (!inFrom(o.id)) continue;
    const c = get(cur, o.id, 'sequence');
    if (sameSeqOpts(c.options, o.options)) continue;
    emit(
      'alterSequence',
      o.id,
      `ALTER SEQUENCE ${qname(cur, c)} ${seqOptions(o.options, true, alterSeqStart(c.options, o.options))}`,
    );
    c.options = clone(o.options);
  }
  // ───── P10 建表（列内联；约束和索引后面统一加；按分区深度升序，父表先于子表，天然支持多级分区） ─────
  const addedTables = added
    .filter((o): o is Table => o.kind === 'table')
    .sort((x, y) => cmpTableIn(to, x, y));
  const emitConstraintOrIndex = (o: PrimaryKey | Unique | Check | Index) => {
    cur.objects[o.id] = fresh(o);
    if (o.kind === 'index') emit('createIndex', o.id, indexDef(o));
    else
      emit(
        `add${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}`,
        o.id,
        `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${ident(o.name)} ${constraintDef(o)}`,
      );
  };
  const allColRefsInCur = (o: PrimaryKey | Unique | Index): boolean => {
    if (o.kind === 'primaryKey' || o.kind === 'unique')
      return o.columns.every((c) => Object.hasOwn(cur.objects, c));
    return (
      o.elements.every((e) => !e.column || Object.hasOwn(cur.objects, e.column)) &&
      o.include.every((c) => Object.hasOwn(cur.objects, c))
    );
  };
  for (const o of addedTables) {
    cur.objects[o.id] = fresh(o);
    const columns = columnsOf(to, o.id);
    if (o.partitionOf) {
      const partSql = partitionBySql(cur, o);
      const part = partSql ? ` PARTITION BY ${partSql}` : '';
      // 标准分区子表（含入口归一化后的存量旧格式）：直接使用 CREATE TABLE ... PARTITION OF 继承父表列与约束
      emit(
        'createTable',
        o.id,
        `CREATE TABLE ${T(o.id)} PARTITION OF ${T(o.partitionOf.parent)} ${o.partitionOf.bound}${part}`,
      );
    } else {
      for (const c of columns) cur.objects[c.id] = fresh(c);
      const partSql = partitionBySql(cur, o);
      const part = partSql ? ` PARTITION BY ${partSql}` : '';
      const body = columns.length ? `\n  ${columns.map((c) => columnDef(c, o)).join(',\n  ')}\n` : '';
      emit('createTable', o.id, `CREATE TABLE ${T(o.id)} (${body})${part}`);
    }
    // 新建分区父表时，在创建其子分区之前先把父表自身的 PK / UNIQUE / INDEX 建好，
    // 防止后续先建子分区再建索引时 PG 自动生成的子分区继承索引名抢占父表显式索引名（63 字节截断重名）
    if (o.partitionBy !== null && !o.partitionOf) {
      for (const kind of ['primaryKey', 'unique', 'index'] as const) {
        for (const k of childrenOf(to, o.id, kind).sort((a, b) => cmpKeyIn(to, a, b))) {
          if (Object.hasOwn(cur.objects, k.id) || !allColRefsInCur(k)) continue;
          emitConstraintOrIndex(k);
        }
      }
    }
  }
  const collectPendingNames = (mode: 'preP11' | 'p15') => {
    const pendingRelNames = new Set<string>();
    const pendingConNames = new Set<string>();
    const triggerConNames = new Set<string>();
    for (const kind of ['primaryKey', 'unique', 'check', 'foreignKey', 'index'] as const) {
      for (const o of toIdx.allRef(kind)) {
        if (!Object.hasOwn(cur.objects, o.id)) {
          if (kind !== 'index') {
            pendingConNames.add(`${o.parent}:${o.name}`);
            if ((kind === 'check' || kind === 'foreignKey') && toIdx.partitionsRef(o.parent).length > 0) {
              for (const desc of toIdx.partitionDescendants(o.parent)) {
                pendingConNames.add(`${desc.id}:${o.name}`);
              }
            }
          }
          if (kind === 'primaryKey' || kind === 'unique' || kind === 'index') {
            pendingRelNames.add(`${get(to, o.parent, 'table').parent}:${o.name}`);
          }
        } else if (
          mode === 'preP11' &&
          (kind === 'check' || kind === 'foreignKey') &&
          toIdx.partitionsRef(o.parent).length > 0
        ) {
          for (const desc of toIdx.partitionDescendants(o.parent)) {
            const attachedInCur =
              Object.hasOwn(cur.objects, desc.id) && ancestorsCur(desc.id).some((a) => a.id === o.parent);
            if (!attachedInCur) {
              pendingConNames.add(`${desc.id}:${o.name}`);
              triggerConNames.add(`${desc.id}:${o.name}`);
            }
          }
        }
      }
    }
    if (mode === 'preP11') {
      for (const o of toIdx.allRef('column')) {
        const curCol = cur.objects[o.id];
        if (o.identity && (curCol?.kind !== 'column' || !curCol.identity)) {
          pendingRelNames.add(`${get(to, o.parent, 'table').parent}:${o.identity.sequenceName}`);
        }
        if (cap.namedNotNull && o.notNull && o.notNullName) {
          const colPending =
            curCol?.kind !== 'column' || !curCol.notNull || curCol.notNullName !== o.notNullName;
          if (colPending) {
            pendingConNames.add(`${o.parent}:${o.notNullName}`);
            triggerConNames.add(`${o.parent}:${o.notNullName}`);
          }
          if (toIdx.partitionsRef(o.parent).length > 0) {
            for (const desc of toIdx.partitionDescendants(o.parent)) {
              const attachedInCur =
                Object.hasOwn(cur.objects, desc.id) && ancestorsCur(desc.id).some((a) => a.id === o.parent);
              if (colPending || !attachedInCur) {
                pendingConNames.add(`${desc.id}:${o.notNullName}`);
                triggerConNames.add(`${desc.id}:${o.notNullName}`);
              }
            }
          }
        }
      }
    }
    return { pendingRelNames, pendingConNames, triggerConNames };
  };
  const prepareExistingImplicits = (mode: 'preP11' | 'p15') => {
    const { pendingRelNames, pendingConNames, triggerConNames } = collectPendingNames(mode);
    const implicitRels = new Set<string>();
    const implicitCons = new Set<string>();
    const noopRecord: (o: Obj) => void = () => {};
    const emptyPartDescs: (parentId: string) => Table[] = () => [];
    const unusedImplicitNameOf: (
      o: PrimaryKey | Unique | Index,
      desc: Table,
      skipPending: boolean,
    ) => string = () => '';

    if (
      (mode === 'p15' && pendingRelNames.size === 0 && pendingConNames.size === 0) ||
      (mode === 'preP11' && triggerConNames.size === 0 && addedTables.length === 0 && willDetach.size === 0)
    ) {
      return {
        hasCurPartitions: false,
        pendingRelNames,
        pendingConNames,
        implicitRels,
        implicitCons,
        implicitNameOf: unusedImplicitNameOf,
        partDescs: emptyPartDescs,
        recordCurAdded: noopRecord,
      };
    }

    const partChildren = new Map<string, Table[]>();
    const existingParentKeys: Record<'primaryKey' | 'unique' | 'index', (PrimaryKey | Unique | Index)[]> = {
      primaryKey: [],
      unique: [],
      index: [],
    };
    let hasCurPartitions = false;
    for (const id in cur.objects) {
      const o = cur.objects[id]!;
      if (o.kind === 'table') {
        if (o.partitionBy !== null) hasCurPartitions = true;
        if (o.partitionOf !== null) {
          hasCurPartitions = true;
          let list = partChildren.get(o.partitionOf.parent);
          if (!list) partChildren.set(o.partitionOf.parent, (list = []));
          list.push(o);
        }
      } else if (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'index') {
        if (get(cur, o.parent, 'table').partitionBy !== null) {
          existingParentKeys[o.kind].push(o);
        }
      }
    }
    if (!hasCurPartitions) {
      return {
        hasCurPartitions: false,
        pendingRelNames,
        pendingConNames,
        implicitRels,
        implicitCons,
        implicitNameOf: unusedImplicitNameOf,
        partDescs: emptyPartDescs,
        recordCurAdded: noopRecord,
      };
    }

    const partDescs = (parentId: string): Table[] => {
      if (!partChildren.has(parentId)) return [];
      const out: Table[] = [];
      const seen = new Set<string>([parentId]);
      const queue = [parentId];
      for (let head = 0; head < queue.length; head++) {
        const kids = partChildren.get(queue[head]!);
        if (!kids) continue;
        for (const child of kids) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          out.push(child);
          queue.push(child.id);
        }
      }
      return out;
    };

    let nsReady = false;
    const relOwners = new Map<string, Set<string>>();
    const conLocal = new Map<string, Set<string>>();
    const conProp = new Map<string, Set<string>>();
    const addName = (map: Map<string, Set<string>>, k: string, name: string) => {
      let s = map.get(k);
      if (!s) map.set(k, (s = new Set()));
      s.add(name);
    };
    const recordObj = (o: Obj) => {
      if (o.kind === 'table' || o.kind === 'sequence') {
        addName(relOwners, o.parent, o.name);
      } else if (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') {
        addName(relOwners, get(cur, o.parent, 'table').parent, o.name);
        if (o.kind !== 'index') addName(conLocal, o.parent, o.name);
      } else if (o.kind === 'check' || o.kind === 'foreignKey') {
        addName(conLocal, o.parent, o.name);
        addName(conProp, o.parent, o.name);
      } else if (o.kind === 'column') {
        if (o.identity) {
          addName(relOwners, get(cur, o.parent, 'table').parent, o.identity.sequenceName);
        }
        if (cap.namedNotNull && o.notNull && o.notNullName) {
          addName(conLocal, o.parent, o.notNullName);
          addName(conProp, o.parent, o.notNullName);
        }
      }
    };
    const ensureNamespaces = () => {
      if (nsReady) return;
      nsReady = true;
      for (const id in cur.objects) recordObj(cur.objects[id]!);
    };
    const relTaken = (schema: string, name: string) => relOwners.get(schema)?.has(name) ?? false;
    const conTaken = (tableId: string, name: string): boolean => {
      if (conLocal.get(tableId)?.has(name)) return true;
      for (const anc of ancestorsCur(tableId)) {
        if (anc.id !== tableId && conProp.get(anc.id)?.has(name)) return true;
      }
      return false;
    };
    const implicitNameOf = (o: PrimaryKey | Unique | Index, desc: Table, skipPending: boolean): string => {
      ensureNamespaces();
      const colPart =
        o.kind === 'primaryKey'
          ? null
          : o.kind === 'unique'
            ? joinNames(o.columns.map((c) => get(cur, c, 'column').name))
            : joinNames(indexElementNames(cur, o));
      const label = o.kind === 'primaryKey' ? 'pkey' : o.kind === 'unique' ? 'key' : 'idx';
      const isCon = o.kind !== 'index';
      return chooseName(
        desc.name,
        colPart,
        label,
        (n) =>
          relTaken(desc.parent, n) ||
          implicitRels.has(`${desc.parent}:${n}`) ||
          (skipPending && pendingRelNames.has(`${desc.parent}:${n}`)) ||
          (isCon &&
            (conTaken(desc.id, n) ||
              implicitCons.has(`${desc.id}:${n}`) ||
              (skipPending && pendingConNames.has(`${desc.id}:${n}`)))),
      );
    };

    const existingImplicits: {
      o: PrimaryKey | Unique | Index;
      desc: Table;
      name: string;
      isCon: boolean;
    }[] = [];
    for (const kind of ['primaryKey', 'unique', 'index'] as const) {
      const isCon = kind !== 'index';
      const existingParents = existingParentKeys[kind].sort((a, b) => cmpKeyIn(cur, a, b));
      for (const o of existingParents) {
        const tbl = get(cur, o.parent, 'table');
        for (const desc of partDescs(tbl.id).sort((a, b) => cmpTableIn(cur, a, b))) {
          const impKey = `${desc.id}#imp#${o.id}`;
          const imp = implicitState.get(impKey);
          const name = imp ? imp.name : implicitNameOf(o, desc, false);
          if (!imp) {
            implicitState.set(impKey, {
              name,
              spaces: isCon ? [`rel:${desc.parent}`, `con:${desc.id}`] : [`rel:${desc.parent}`],
            });
          }
          implicitRels.add(`${desc.parent}:${name}`);
          if (isCon) implicitCons.add(`${desc.id}:${name}`);
          existingImplicits.push({ o, desc, name, isCon });
        }
      }
    }
    for (const { o, desc, name, isCon } of existingImplicits) {
      const shouldYield =
        mode === 'preP11'
          ? isCon && triggerConNames.has(`${desc.id}:${name}`)
          : pendingRelNames.has(`${desc.parent}:${name}`) ||
            (isCon && pendingConNames.has(`${desc.id}:${name}`));
      if (shouldYield) {
        const safeName = implicitNameOf(o, desc, true);
        if (o.kind === 'index') {
          emit('rename', `${o.id}#ci`, `ALTER INDEX ${relIn(desc.id, name)} RENAME TO ${ident(safeName)}`);
        } else {
          emit(
            'rename',
            `${o.id}#cc`,
            `ALTER TABLE ${T(desc.id)} RENAME CONSTRAINT ${ident(name)} TO ${ident(safeName)}`,
          );
        }
        const imp = implicitState.get(`${desc.id}#imp#${o.id}`);
        if (imp) imp.name = safeName;
        implicitRels.add(`${desc.parent}:${safeName}`);
        if (isCon) implicitCons.add(`${desc.id}:${safeName}`);
      }
    }
    return {
      hasCurPartitions: true,
      pendingRelNames,
      pendingConNames,
      implicitRels,
      implicitCons,
      implicitNameOf,
      partDescs,
      recordCurAdded: (o: Obj) => {
        if (nsReady) recordObj(o);
      },
    };
  };
  prepareExistingImplicits('preP11');
  // ───── P11 加列（生成列在改完列之后再加，见 P12g） ─────
  const addColumn = (c: Column) => {
    const table = get(cur, c.parent, 'table');
    cur.objects[c.id] = fresh(c);
    emit('addColumn', c.id, `ALTER TABLE ${T(c.parent)} ADD COLUMN ${columnDef(c, table)}`);
  };
  for (const c of added) {
    if (c.kind !== 'column' || Object.hasOwn(cur.objects, c.id) || c.generated) continue;
    addColumn(c);
  }
  const lateGenerated = () => {
    for (const c of [...added, ...[...regen].map((id) => to.objects[id]!)]) {
      if (c.kind !== 'column' || Object.hasOwn(cur.objects, c.id)) continue;
      addColumn(c);
    }
  };

  // ───── P12 改列：分几轮，保证依赖顺序 ─────
  const altered: Column[] = [];
  for (const o of toIdx.allRef('column')) {
    if (regen.has(o.id) || (!inFrom(o.id) && !materialized.has(o.id))) continue;
    if (typeChanged.has(o.id)) {
      altered.push(o);
      continue;
    }
    const c = cur.objects[o.id];
    if (c?.kind !== 'column') continue;
    if (
      c.notNull !== o.notNull ||
      c.pos !== o.pos ||
      c.notNullNameMode !== o.notNullNameMode ||
      (cap.namedNotNull && o.notNull && c.notNullName !== o.notNullName) ||
      !sameIdentity(c.identity, o.identity) ||
      !sameDefault(c.default, o.default) ||
      rebindDefault.has(o.id)
    ) {
      altered.push(o);
    }
  }
  const A = (c: Column) => `ALTER TABLE ${T(c.parent)} ALTER COLUMN ${C(c.id)}`;
  const emitDefaultCascade = (c: Column, kind: 'dropDefault' | 'setDefault', clause: string) => {
    emit(kind, c.id, `${A(c)} ${clause}`);
    // PG 修改分区父表列默认值不会自动级联已有子分区，必须对已附着的所有后代子分区补发以保证闭环一致
    if (get(cur, c.parent, 'table').partitionBy !== null) {
      for (const desc of partitionDescendants(cur, c.parent)) {
        emit(kind, c.id, `ALTER TABLE ${T(desc.id)} ALTER COLUMN ${C(c.id)} ${clause}`);
      }
    }
  };
  // a. 去掉 identity
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (c.identity && !o.identity) {
      emit('dropIdentity', o.id, `${A(c)} DROP IDENTITY`);
      c.identity = null;
    }
  }
  // b. 去掉默认值（默认值要变、或类型要变时先去掉，避免旧默认值无法转换）
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (c.default && (!same(c.default, o.default) || typeChanged.has(o.id) || rebindDefault.has(o.id))) {
      emitDefaultCascade(c, 'dropDefault', 'DROP DEFAULT');
      c.default = null;
    }
  }
  // c. 改类型
  for (const o of altered) {
    if (!typeChanged.has(o.id)) continue;
    const c = get(cur, o.id, 'column');
    const viaText = !!(c.typeRef || o.typeRef) || !hasDirectCast(c.type, o.type);
    const next = { ...c, type: o.type, typeRef: o.typeRef, collation: o.collation };
    const target = next.typeRef ? qname(cur, get(cur, next.typeRef, 'enum')) + next.type : next.type;
    emit(
      'alterType',
      o.id,
      `${A(c)} TYPE ${typeOf(next)} USING ${ident(c.name)}${viaText ? `::text${arrayDims(c.type) === arrayDims(o.type) ? arrayDims(c.type) : ''}` : ''}::${target}`,
    );
    Object.assign(c, { type: o.type, typeRef: o.typeRef, collation: o.collation });
  }
  // d. NOT NULL：先删后加
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (c.notNull && !o.notNull) {
      emit('dropNotNull', o.id, `${A(c)} DROP NOT NULL`);
      c.notNull = false;
      c.notNullName = null;
    }
  }
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (!c.notNull && o.notNull) {
      emit(
        'setNotNull',
        o.id,
        cap.namedNotNull && o.notNullName
          ? `ALTER TABLE ${T(c.parent)} ADD CONSTRAINT ${ident(o.notNullName)} NOT NULL ${C(c.id)}`
          : `${A(c)} SET NOT NULL`,
      );
      c.notNull = true;
      c.notNullName = cap.namedNotNull ? o.notNullName : null;
    }
    c.notNullNameMode = o.notNullNameMode;
  }
  // e. 设默认值
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (o.default && !same(c.default, o.default)) {
      c.default = clone(o.default);
      emitDefaultCascade(c, 'setDefault', `SET DEFAULT ${defaultOf(c)}`);
    }
  }
  // f. 加 identity、改 identity
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (!o.identity) continue;
    const table = get(cur, c.parent, 'table');
    if (!c.identity) {
      emit('addIdentity', o.id, `${A(c)} ADD ${identityClause(o, table)}`);
      c.identity = clone(o.identity);
      continue;
    }
    if (c.identity.always !== o.identity.always)
      emit('alterIdentity', o.id, `${A(c)} SET GENERATED ${o.identity.always ? 'ALWAYS' : 'BY DEFAULT'}`);
    if (!same(c.identity.options, o.identity.options)) {
      const p = o.identity.options;
      const sets = [
        `SET INCREMENT BY ${p.increment}`,
        p.min === null ? 'SET NO MINVALUE' : `SET MINVALUE ${p.min}`,
        p.max === null ? 'SET NO MAXVALUE' : `SET MAXVALUE ${p.max}`,
        `SET CACHE ${p.cache}`,
        p.cycle ? 'SET CYCLE' : 'SET NO CYCLE',
      ];
      const start = alterSeqStart(c.identity.options, p);
      if (start !== null) sets.push(`SET START WITH ${start}`);
      emit('alterIdentity', o.id, `${A(c)} ${sets.join(' ')}`);
    }
    c.identity = clone(o.identity);
  }
  // 其余不产生 SQL 的列属性
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    c.pos = o.pos;
    c.notNullNameMode = o.notNullNameMode;
    if (c.identity && o.identity) c.identity.sequenceNameMode = o.identity.sequenceNameMode;
  }
  // g. 加生成列（新增的和重建的）：必须在它引用的列改完类型之后
  lateGenerated();

  // ───── P12h 挂载子分区（普通表 → 子分区，或改边界/换父表后的重新挂载；按目标深度升序） ─────
  for (const tId of [...willAttach].sort((a, b) => partitionDepth(to, a) - partitionDepth(to, b))) {
    const targetTable = get(to, tId, 'table');
    const targetParentId = targetTable.partitionOf!.parent;
    const targetBound = targetTable.partitionOf!.bound;
    const targetRootId = rootTableId(cur, targetParentId);
    const rootCols = columnsOf(cur, targetRootId);
    const childCols = columnsOf(cur, tId);
    const childTable = get(cur, tId, 'table');

    // 对齐列定义（处理挂载前差异或脱离期间父表列发生变更的情况）
    // 1. 先删除多余列、生成表达式不一致的列、以及引用了将要改类型列的生成列；必须先删生成列再删普通列
    const typeChangingNames = new Set(
      childCols
        .filter((cc) => {
          const rc = rootCols.find((x) => x.name === cc.name);
          return rc && !sameColType(cc, rc);
        })
        .map((cc) => cc.name),
    );
    const colsToDropOnChild = childCols
      .filter((cc) => {
        const rc = rootCols.find((x) => x.name === cc.name);
        if (!rc) return true;
        if (!same(cc.generated, rc.generated)) return true;
        if (cc.generated && typeChangingNames.has(cc.name)) return true;
        if (cc.generated && [...typeChangingNames].some((n) => exprReferences(cc.generated!.expr, n)))
          return true;
        return false;
      })
      .sort((x, y) => (x.generated ? 0 : 1) - (y.generated ? 0 : 1));
    for (const cc of colsToDropOnChild) {
      emit('dropColumn', cc.id, `ALTER TABLE ${T(tId)} DROP COLUMN ${ident(cc.name)}`);
      dropWithColumn(cc.id);
      delete cur.objects[cc.id];
    }
    for (const id of autoDropped) delete cur.objects[id];
    const curChildCols = columnsOf(cur, tId);
    const childToRootCol = new Map<string, string>();
    const nnTakenOnSubtree = (name: string) =>
      conTakenCur(tId, name) || partitionDescendants(cur, tId).some((d) => conTakenCur(d.id, name));
    const targetAncsCur = ancestorsCur(targetParentId);
    const ancConNames = new Set<string>();
    for (const anc of targetAncsCur) {
      for (const k of [...childrenOf(cur, anc.id, 'check'), ...childrenOf(cur, anc.id, 'foreignKey')]) {
        ancConNames.add(k.name);
      }
    }
    for (const anc of partitionAncestors(to, tId)) {
      for (const k of [...childrenOf(to, anc.id, 'check'), ...childrenOf(to, anc.id, 'foreignKey')]) {
        ancConNames.add(k.name);
      }
    }
    const rootNnNames = new Set<string>();
    if (cap.namedNotNull) {
      for (const rc of rootCols) {
        if (rc.notNull && rc.notNullName) rootNnNames.add(rc.notNullName);
      }
    }
    // 1.5 先去掉多余 identity 与 NOT NULL（须先 DROP IDENTITY 再 DROP NOT NULL），
    // 并把与目标祖先 CHECK/FK 或目标根列 NOT NULL 名冲突的现有 NOT NULL 约束改到临时名
    for (const cc of curChildCols) {
      const rc = rootCols.find((x) => x.name === cc.name);
      if (!rc) continue;
      const Ac = `ALTER TABLE ${T(tId)} ALTER COLUMN ${ident(cc.name)}`;
      if (!cc.generated && cc.identity) {
        emit('dropIdentity', cc.id, `${Ac} DROP IDENTITY`);
        cc.identity = null;
      }
      if (cc.notNull && !rc.notNull) {
        emit('dropNotNull', cc.id, `${Ac} DROP NOT NULL`);
        cc.notNull = false;
        cc.notNullName = null;
      }
    }
    if (cap.namedNotNull) {
      for (const cc of curChildCols) {
        const rc = rootCols.find((x) => x.name === cc.name);
        if (!rc || !cc.notNull || !cc.notNullName) continue;
        if (
          ancConNames.has(cc.notNullName) ||
          (cc.notNullName !== rc.notNullName && rootNnNames.has(cc.notNullName))
        ) {
          const tmpNn = `_dowel_tmp_${++tmp}`;
          emit(
            'rename',
            `${cc.id}#nn`,
            `ALTER TABLE ${T(tId)} RENAME CONSTRAINT ${ident(cc.notNullName)} TO ${ident(tmpNn)}`,
          );
          cc.notNullName = tmpNn;
        }
      }
    }
    const chooseAttachNnName = (rc: Column): string | null => {
      if (!cap.namedNotNull || !rc.notNull) return null;
      if (rc.notNullName && !nnTakenOnSubtree(rc.notNullName)) return rc.notNullName;
      const autoName = chooseName(childTable.name, rc.name, 'not_null', (n) => conTakenCur(tId, n));
      return ancConNames.has(autoName) || nnTakenOnSubtree(autoName) ? `_dowel_tmp_${++tmp}` : null;
    };
    // 2. 补齐缺失的非生成列，并对齐已存在的列（含生成列的 NOT NULL 与列注释）
    for (const rc of rootCols) {
      const cc = curChildCols.find((x) => x.name === rc.name);
      if (!cc) {
        if (rc.generated) continue;
        const addedCol: Column = {
          ...clone(rc),
          id: `__dowel_att_col_${++synSeq}`,
          parent: tId,
          identity: null,
          notNullName: chooseAttachNnName(rc),
          comment: null,
        };
        emit('addColumn', tId, `ALTER TABLE ${T(tId)} ADD COLUMN ${columnDef(addedCol, childTable)}`);
        continue;
      }
      childToRootCol.set(cc.id, rc.id);
      const Ac = `ALTER TABLE ${T(tId)} ALTER COLUMN ${ident(cc.name)}`;
      if (!cc.generated) {
        if (cc.default && !same(cc.default, rc.default)) {
          emitDefaultCascade(cc, 'dropDefault', 'DROP DEFAULT');
          cc.default = null;
        }
        if (!sameColType(cc, rc)) {
          const viaText = !!(cc.typeRef || rc.typeRef) || !hasDirectCast(cc.type, rc.type);
          const targetType = rc.typeRef ? qname(cur, get(cur, rc.typeRef, 'enum')) + rc.type : rc.type;
          emit(
            'alterType',
            cc.id,
            `${Ac} TYPE ${typeOf(rc)} USING ${ident(cc.name)}${viaText ? `::text${arrayDims(cc.type) === arrayDims(rc.type) ? arrayDims(cc.type) : ''}` : ''}::${targetType}`,
          );
          Object.assign(cc, { type: rc.type, typeRef: rc.typeRef, collation: rc.collation });
        }
      }
      if (!cc.notNull && rc.notNull) {
        const nnName = chooseAttachNnName(rc);
        emit(
          'setNotNull',
          cc.id,
          nnName
            ? `ALTER TABLE ${T(tId)} ADD CONSTRAINT ${ident(nnName)} NOT NULL ${ident(cc.name)}`
            : `${Ac} SET NOT NULL`,
        );
        cc.notNull = true;
        cc.notNullName = nnName;
      } else if (
        cap.namedNotNull &&
        cc.notNull &&
        rc.notNull &&
        cc.notNullName &&
        rc.notNullName &&
        cc.notNullName !== rc.notNullName &&
        !nnTakenOnSubtree(rc.notNullName)
      ) {
        emit(
          'rename',
          `${cc.id}#nn`,
          `ALTER TABLE ${T(tId)} RENAME CONSTRAINT ${ident(cc.notNullName)} TO ${ident(rc.notNullName)}`,
        );
        cc.notNullName = rc.notNullName;
      }
      if (!cc.generated && rc.default && !same(cc.default, rc.default)) {
        cc.default = clone(rc.default);
        emitDefaultCascade(cc, 'setDefault', `SET DEFAULT ${defaultOf(rc)}`);
      }
      if (cc.comment !== null) {
        emit('comment', cc.id, `COMMENT ON COLUMN ${T(tId)}.${ident(cc.name)} IS NULL`);
        cc.comment = null;
      }
    }
    // 3. 最后补齐缺失或刚删除重建的生成列（此时其引用的普通列均已到位且类型已对齐）
    for (const rc of rootCols) {
      if (!rc.generated) continue;
      if (curChildCols.some((x) => x.name === rc.name)) continue;
      const addedCol: Column = {
        ...clone(rc),
        id: `__dowel_att_col_${++synSeq}`,
        parent: tId,
        identity: null,
        notNullName: chooseAttachNnName(rc),
        comment: null,
      };
      emit('addColumn', tId, `ALTER TABLE ${T(tId)} ADD COLUMN ${columnDef(addedCol, childTable)}`);
    }

    // 补齐目标父表/祖先表上已存在的 CHECK 约束（PG ATTACH PARTITION 要求子表先具备父表 CHECK）
    for (const anc of targetAncsCur) {
      for (const ancCk of childrenOf(cur, anc.id, 'check')) {
        const existing = childrenOf(cur, tId, 'check').find((x) => x.name === ancCk.name);
        if (existing) {
          if (!existing.noInherit && (existing.expr === ancCk.expr || retainedForReattach.has(existing.id)))
            continue;
          emit('dropCheck', existing.id, `ALTER TABLE ${T(tId)} DROP CONSTRAINT ${ident(existing.name)}`);
          delete cur.objects[existing.id];
        }
        emit(
          'addCheck',
          tId,
          `ALTER TABLE ${T(tId)} ADD CONSTRAINT ${ident(ancCk.name)} CHECK (${ancCk.expr})`,
        );
      }
    }

    emit(
      'attachPartition',
      tId,
      `ALTER TABLE ${T(targetParentId)} ATTACH PARTITION ${T(tId)} ${targetBound}`,
    );
    childTable.partitionOf = clone(targetTable.partitionOf);

    // 映射子表及其后代保留的本地约束/索引列引用至根父表列 ID
    const subTree = new Set([tId, ...partitionDescendants(cur, tId).map((d) => d.id)]);
    const mapCol = (c: string) => childToRootCol.get(c) ?? c;
    for (const o of Object.values(cur.objects)) {
      if (o.kind === 'table' && subTree.has(o.id) && o.partitionBy && typeof o.partitionBy !== 'string') {
        for (const k of o.partitionBy.keys) if (k.column) k.column = mapCol(k.column);
      }
      if (!('parent' in o) || !subTree.has(o.parent)) continue;
      if (o.kind === 'primaryKey' || o.kind === 'unique') o.columns = o.columns.map(mapCol);
      else if (o.kind === 'foreignKey') {
        o.columns = o.columns.map(mapCol);
        if (subTree.has(o.refTable)) o.refColumns = o.refColumns.map(mapCol);
      } else if (o.kind === 'index') {
        for (const el of o.elements) if (el.column) el.column = mapCol(el.column);
        o.include = o.include.map(mapCol);
      }
    }

    // 清理被 ATTACH 吸收的列、保留重挂对象与同名 CHECK
    for (const cc of columnsOf(cur, tId)) delete cur.objects[cc.id];
    for (const o of Object.values(cur.objects)) {
      if (
        'parent' in o &&
        o.parent === tId &&
        (retainedForReattach.has(o.id) || keptForAttachCheck.has(o.id))
      ) {
        delete cur.objects[o.id];
      }
    }
  }
  // ───── P13 序列属于哪一列 ─────
  for (const o of [...added, ...common]) {
    if (o.kind !== 'sequence') continue;
    const c = get(cur, o.id, 'sequence');
    if (c.ownedBy === o.ownedBy) continue;
    const owner = o.ownedBy ? `${T(get(cur, o.ownedBy, 'column').parent)}.${C(o.ownedBy)}` : 'NONE';
    emit('sequenceOwnedBy', o.id, `ALTER SEQUENCE ${qname(cur, c)} OWNED BY ${owner}`);
    c.ownedBy = o.ownedBy;
  }
  // ───── P14 删早期不透明对象、序列、枚举、扩展、schema ─────
  const earlyDrops = all(from, 'opaque').filter(
    (o) => !isLate(o) && isRemoved(o.id) && Object.hasOwn(cur.objects, o.id),
  );
  for (const o of topo(earlyDrops).reverse()) dropOpaque(get(cur, o.id, 'opaque'));
  for (const o of removed) {
    if (o.kind !== 'extension' || !Object.hasOwn(cur.objects, o.id)) continue;
    emit('dropExtension', o.id, `DROP EXTENSION ${ident(o.name)}`);
    delete cur.objects[o.id];
  }
  for (const kind of ['sequence', 'enum', 'schema'] as const) {
    for (const o of removed) {
      if (o.kind !== kind || !Object.hasOwn(cur.objects, o.id)) continue;
      const c = cur.objects[o.id] as Sequence | Enum | Schema;
      const sql =
        c.kind === 'sequence'
          ? `DROP SEQUENCE ${qname(cur, c)}`
          : c.kind === 'enum'
            ? `DROP TYPE ${qname(cur, c)}`
            : `DROP SCHEMA ${ident(c.name)}`;
      emit(`drop${kind[0]!.toUpperCase()}${kind.slice(1)}`, o.id, sql);
      delete cur.objects[o.id];
    }
  }
  // ───── P15 加主键、唯一、CHECK，建索引 ─────
  // cur 里没有的就是新增的或前面删掉待重建的；子表本地对象先于父表创建，
  // 且当在已有子分区的父表上建 PK / UNIQUE / INDEX 时，若 PG 自动生成的子分区继承索引名抢占了待建对象的名字，立即改名为非冲突派生名
  const {
    hasCurPartitions,
    pendingRelNames,
    pendingConNames,
    implicitRels,
    implicitCons,
    implicitNameOf,
    partDescs,
    recordCurAdded,
  } = prepareExistingImplicits('p15');
  if (pendingRelNames.size > 0 || pendingConNames.size > 0) {
    if (!hasCurPartitions) {
      for (const kind of ['primaryKey', 'unique', 'check', 'index'] as const) {
        const todo = toIdx
          .allRef(kind)
          .filter((o) => !Object.hasOwn(cur.objects, o.id))
          .sort((a, b) => cmpKeyIn(to, a, b));
        for (const o of todo) {
          emitConstraintOrIndex(o);
        }
      }
    } else {
      for (const kind of ['primaryKey', 'unique', 'check', 'index'] as const) {
        const todo = toIdx
          .allRef(kind)
          .filter((o) => !Object.hasOwn(cur.objects, o.id))
          .sort((a, b) => cmpKeyIn(to, a, b));
        for (const o of todo) {
          emitConstraintOrIndex(o);
          recordCurAdded(cur.objects[o.id]!);
          if (o.kind !== 'index') {
            pendingConNames.delete(`${o.parent}:${o.name}`);
            if (o.kind === 'check') {
              for (const desc of partDescs(o.parent)) {
                pendingConNames.delete(`${desc.id}:${o.name}`);
              }
            }
          }
          if (o.kind === 'check') continue;
          const tbl = get(cur, o.parent, 'table');
          pendingRelNames.delete(`${tbl.parent}:${o.name}`);
          if (tbl.partitionBy === null) continue;
          const isCon = o.kind !== 'index';
          for (const desc of partDescs(tbl.id).sort((a, b) => cmpTableIn(cur, a, b))) {
            const pgName = implicitNameOf(o, desc, false);
            if (
              pendingRelNames.has(`${desc.parent}:${pgName}`) ||
              (isCon && pendingConNames.has(`${desc.id}:${pgName}`))
            ) {
              const safeName = implicitNameOf(o, desc, true);
              if (o.kind === 'index') {
                emit(
                  'rename',
                  `${o.id}#ci`,
                  `ALTER INDEX ${relIn(desc.id, pgName)} RENAME TO ${ident(safeName)}`,
                );
              } else {
                emit(
                  'rename',
                  `${o.id}#cc`,
                  `ALTER TABLE ${T(desc.id)} RENAME CONSTRAINT ${ident(pgName)} TO ${ident(safeName)}`,
                );
              }
              implicitRels.add(`${desc.parent}:${safeName}`);
              if (isCon) implicitCons.add(`${desc.id}:${safeName}`);
            } else {
              implicitRels.add(`${desc.parent}:${pgName}`);
              if (isCon) implicitCons.add(`${desc.id}:${pgName}`);
            }
          }
        }
      }
    }
  }
  // ───── P16 加外键 ─────
  for (const o of toIdx.allRef('foreignKey')) {
    if (Object.hasOwn(cur.objects, o.id)) continue;
    cur.objects[o.id] = fresh(o);
    emit(
      'addForeignKey',
      o.id,
      `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${ident(o.name)} ${constraintDef(o)}`,
    );
  }
  // ───── P16b 建晚期不透明对象（视图、触发器、策略、排他约束） ─────
  const lateCreates = all(to, 'opaque').filter((o) => isLate(o) && !Object.hasOwn(cur.objects, o.id));
  for (const o of topo(lateCreates)) createOpaque(o);
  // ───── P17 注释，以及不产生 SQL 的属性（nameMode 等）。不透明对象的注释已包含在它的 DDL 里 ─────
  const commentTarget = (o: Obj): string => {
    switch (o.kind) {
      case 'schema':
        return `SCHEMA ${ident(o.name)}`;
      case 'extension':
        return `EXTENSION ${ident(o.name)}`;
      case 'enum':
        return `TYPE ${qname(cur, o)}`;
      case 'sequence':
        return `SEQUENCE ${qname(cur, o)}`;
      case 'table':
        return `TABLE ${T(o.id)}`;
      case 'column':
        return `COLUMN ${T(o.parent)}.${C(o.id)}`;
      case 'index':
        return `INDEX ${relIn(o.parent, o.name)}`;
      case 'opaque':
        throw new PlanError('不透明对象的注释在 DDL 里');
      default:
        return `CONSTRAINT ${ident(o.name)} ON ${T(o.parent)}`;
    }
  };
  for (const id in to.objects) {
    const o = to.objects[id]!;
    const c = cur.objects[id];
    if (!c) throw new PlanError(`内部错误：规划结束时缺少对象 ${o.kind} ${o.name}`);
    if (c.name !== o.name || !sameDef(c, o, cur, to, from))
      throw new PlanError(`内部错误：规划结束时 ${o.kind} ${o.name} 与目标不一致`);
    if ((c.comment ?? null) !== (o.comment ?? null) && o.kind !== 'opaque') {
      const what = commentTarget(o);
      emit('comment', o.id, `COMMENT ON ${what} IS ${o.comment === null ? 'NULL' : literal(o.comment)}`);
    }
  }

  // 自检：规划结束时的状态必须等于目标版本
  for (const id of Object.keys(cur.objects)) if (!inTo(id)) throw new PlanError(`内部错误：多出对象 ${id}`);
  return steps;
};

/** 目标版本中对象占用的命名空间（与 plan 内部的 spacesOf 相同，但基于 to） */
const spacesOfTo = (m: Model, o: Obj): string[] => {
  const sch = (tableId: string) =>
    find(m, tableId)?.kind === 'table' ? (m.objects[tableId] as Table).parent : '?';
  switch (o.kind) {
    case 'schema':
      return ['schema'];
    case 'extension':
      return ['extension'];
    case 'opaque':
      return [`opaque:${o.objType}:${o.parent}`];
    case 'table':
      return [`rel:${o.parent}`, `type:${o.parent}`];
    case 'enum':
      return [`type:${o.parent}`];
    case 'sequence':
      return [`rel:${o.parent}`];
    case 'column':
      return [`col:${o.parent}`];
    case 'index':
      return [`rel:${sch(o.parent)}`];
    case 'primaryKey':
    case 'unique':
      return [`rel:${sch(o.parent)}`, `con:${o.parent}`];
    case 'check':
      return [`con:${o.parent}`, ...partitionDescendants(m, o.parent).map((d) => `con:${d.id}`)];
    case 'foreignKey':
      return [`con:${o.parent}`];
  }
};

/** 把整个模型从零建出来的语句（导出 DDL 用） */
export const createAll = (m: Model, opts?: PlanOptions): Step[] => plan({ ...m, objects: {} }, m, opts);
