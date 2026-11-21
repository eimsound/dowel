// 比较两个版本的 IR，生成 PG 迁移语句。
// 规划时维护一份“当前状态” cur：每生成一步就把它更新到执行这一步之后的样子，
// 所以每条语句引用的都是当时实际存在的名字；结束时断言 cur 等于目标版本。

import { renameInExpr, renameQualifiedInExpr } from '../edit.ts';
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
  PrimaryKey,
  Schema,
  Sequence,
  SequenceOptions,
  Table,
  Unique,
} from '../ir.ts';
import { EARLY_OPAQUE } from '../ir.ts';
import { deepEqual } from '../json.ts';
import { all, childrenOf, columnsOf, find, get, qname } from '../model.ts';
import { ident, literal, qualified } from './quote.ts';

export interface Step {
  /** 步骤种类，用于界面展示和测试 */
  kind: string;
  /** 主要涉及的对象 */
  target: string;
  sql: string;
  /**
   * 冻结脚本里这一步的 transactional 标记（规划器自己不填）：验证时带着它一路传到风险分析，
   * 只用于“用户标了非事务、但文本看不出来”的兜底，不决定要不要放进事务。
   */
  transactional?: boolean;
}

export class PlanError extends Error {}

const clone = <T>(x: T): T => structuredClone(x);
/** 新建的对象此时还没有注释，注释在最后一个阶段统一加 */
const fresh = <T extends Obj>(o: T): T => ({ ...structuredClone(o), comment: null });
const same = deepEqual;
const pick = <T extends object>(o: T, keys: (keyof T)[]) => keys.map((k) => o[k]);

/** 对象中决定“定义”的字段（不含名字、注释、展示顺序），这些字段变了需要重建或修改 */
const definition = (o: Obj): unknown => {
  switch (o.kind) {
    case 'schema':
      return null;
    case 'table':
      return [o.partitionBy, o.partitionOf];
    case 'extension':
      return [o.name, o.parent];
    case 'opaque':
      return [o.objType, o.name, o.ddl, o.drop];
    case 'enum':
      return o.values;
    case 'sequence':
      return [o.options, o.ownedBy];
    case 'column':
      return pick(o, ['type', 'typeRef', 'collation', 'notNull', 'default', 'identity', 'generated']);
    case 'primaryKey':
      return o.columns;
    case 'unique':
      return pick(o, ['columns', 'nullsNotDistinct']);
    case 'foreignKey':
      return pick(o, [
        'columns',
        'refTable',
        'refColumns',
        'onDelete',
        'onUpdate',
        'match',
        'deferrable',
        'initiallyDeferred',
      ]);
    case 'check':
      return pick(o, ['expr', 'noInherit']);
    case 'index':
      return pick(o, ['unique', 'method', 'elements', 'include', 'where', 'nullsNotDistinct']);
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
      ? { elements: structuredClone(o.elements), where: o.where }
      : {};

export const plan = (from: Model, to: Model): Step[] => {
  const cur = clone(from);
  const steps: Step[] = [];
  const emit = (kind: string, target: string, sql: string) => steps.push({ kind, target, sql });

  const inFrom = (id: string) => id in from.objects;
  const inTo = (id: string) => id in to.objects;
  const removed = Object.values(from.objects).filter((o) => !inTo(o.id));
  const added = Object.values(to.objects).filter((o) => !inFrom(o.id));
  const common = Object.values(to.objects).filter((o) => inFrom(o.id));
  const was = <T extends Obj>(o: T): T => from.objects[o.id] as T;
  const isRemoved = (id: string) => inFrom(id) && !inTo(id);

  for (const o of common) {
    if (o.kind !== was(o).kind) throw new PlanError(`对象 ${o.id} 的种类从 ${was(o).kind} 变成了 ${o.kind}`);
    if ('parent' in o && o.parent !== (was(o) as typeof o).parent && o.kind !== 'column')
      throw new PlanError(`暂不支持把 ${o.kind} ${o.name} 移到其他 schema 或表`);
    if (o.kind === 'column' && o.parent !== was(o).parent)
      throw new PlanError(`不能把列 ${o.name} 移到其他表`);
    if ((o.kind === 'table' || o.kind === 'extension') && !same(definition(o), definition(was(o))))
      throw new PlanError(`${o.kind === 'table' ? '分区设置' : '扩展'}暂不支持修改：${o.name}`);
  }
  // 分区表（父表和子表）在 M1 中只读：整张表的新增、删除可以，表内结构不能改
  const partitioned = (tableId: string) => {
    const t = (to.objects[tableId] ?? from.objects[tableId]) as Table | undefined;
    return !!t && (!!t.partitionBy || !!t.partitionOf);
  };
  for (const o of [...added, ...removed, ...common]) {
    if (o.kind === 'table' || o.kind === 'opaque' || !('parent' in o)) continue;
    const table = o.parent;
    if (!partitioned(table) || !inFrom(table) || !inTo(table)) continue;
    const changed =
      !inFrom(o.id) || !inTo(o.id) || o.name !== was(o).name || !same(definition(o), definition(was(o)));
    if (changed) throw new PlanError(`分区表在 M1 中只读，不能修改其结构：${o.kind} ${o.name}`);
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
  const seqOptions = (o: SequenceOptions, withType: boolean): string => {
    const p: string[] = [];
    if (withType) p.push(`AS ${o.type}`);
    p.push(`INCREMENT BY ${o.increment}`);
    p.push(o.min === null ? 'NO MINVALUE' : `MINVALUE ${o.min}`);
    p.push(o.max === null ? 'NO MAXVALUE' : `MAXVALUE ${o.max}`);
    if (o.start !== null) p.push(`START WITH ${o.start}`);
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
    if (c.notNull) s += c.notNullName ? ` CONSTRAINT ${ident(c.notNullName)} NOT NULL` : ' NOT NULL';
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

  // ───── 改名带来的表达式变化：PG 按 OID 记录引用，改名时会自动更新表达式，不需要重建 ─────
  // 把旧版本表达式里的 schema、枚举、列名换成新名字后再比较；相同就说明只是改名带来的变化
  const schemaRenames = common
    .filter((o): o is Schema => o.kind === 'schema' && o.name !== was(o).name)
    .map((o) => [was(o).name, o.name] as const);
  const enumRenames = common
    .filter((o): o is Enum => o.kind === 'enum' && o.name !== was(o).name)
    .map((o) => [(to.objects[o.parent] as Schema).name, was(o).name, o.name] as const);
  const colRenames = new Map<string, [string, string][]>();
  for (const o of common)
    if (o.kind === 'column' && o.name !== was(o).name)
      colRenames.set(o.parent, [...(colRenames.get(o.parent) ?? []), [was(o).name, o.name]]);
  const migrateExpr = (expr: string, table: string): string => {
    let e = expr;
    for (const [a, b] of schemaRenames) e = renameQualifiedInExpr(e, a, null, { schema: b, name: null });
    for (const [sch, a, b] of enumRenames) e = renameQualifiedInExpr(e, sch, a, { schema: sch, name: b });
    // 两阶段：先换成占位名，再换成目标名（处理互换）
    const rs = colRenames.get(table) ?? [];
    rs.forEach(([a], i) => {
      e = renameInExpr(e, a, `__dowel_ph_${i}__`);
    });
    rs.forEach(([, b], i) => {
      e = renameInExpr(e, `__dowel_ph_${i}__`, b);
    });
    return e;
  };
  const migrated = <T extends Obj>(w: T): T => {
    const o = clone(w) as Obj;
    if (o.kind === 'check') o.expr = migrateExpr(o.expr, o.parent);
    if (o.kind === 'index') {
      for (const el of o.elements) if (el.expr) el.expr = migrateExpr(el.expr, o.parent);
      if (o.where) o.where = migrateExpr(o.where, o.parent);
    }
    if (o.kind === 'column') {
      if (o.generated) o.generated.expr = migrateExpr(o.generated.expr, o.parent);
      if (o.default && 'expr' in o.default) o.default.expr = migrateExpr(o.default.expr, o.parent);
    }
    return o as T;
  };

  // ───── 预先计算：需要重建的约束 / 索引、需要重建的生成列、类型变化的列 ─────
  const typeChanged = new Set(
    common
      .filter((o): o is Column => o.kind === 'column')
      .filter(
        (c) =>
          !same(pick(c, ['type', 'typeRef', 'collation']), pick(was(c), ['type', 'typeRef', 'collation'])),
      )
      .map((c) => c.id),
  );
  /** 表达式是否引用了某些列（按旧名或新名） */
  const exprTouches = (expr: string | null | undefined, colIds: Iterable<string>) => {
    if (!expr) return false;
    const ids = identsIn(expr);
    for (const c of colIds) {
      const names = [find(from, c)?.name, find(to, c)?.name];
      if (names.some((n) => n && ids.has(n))) return true;
    }
    return false;
  };
  const colsOfTable = (table: string, set: Set<string>) =>
    [...set].filter((c) => {
      const col = find(to, c) ?? find(from, c);
      return col?.kind === 'column' && col.parent === table;
    });

  // 生成列：定义变了、或表达式引用的列类型变了 → 删掉重建（生成列的值可以重新算出，不丢数据）
  const regen = new Set<string>();
  for (const c of common) {
    if (c.kind !== 'column') continue;
    const w = was(c);
    if (!c.generated && !w.generated) continue;
    if (
      !same(c.generated, migrated(w).generated) ||
      typeChanged.has(c.id) ||
      (c.generated && exprTouches(c.generated.expr, colsOfTable(c.parent, typeChanged)))
    )
      regen.add(c.id);
  }
  for (const id of regen) typeChanged.delete(id);

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

  // 枚举值被删除或重排：PG 不支持，只能重建类型（见 P8）
  const enumRebuild = new Set(
    common
      .filter((o): o is Enum => o.kind === 'enum')
      .filter((e) => {
        const old = was(e).values;
        return !same(
          e.values.filter((v) => old.includes(v)),
          old,
        );
      })
      .map((e) => e.id),
  );
  const mentionsRebuiltEnum = (expr: string | null | undefined) => {
    if (!expr || !enumRebuild.size) return false;
    const ids = identsIn(expr);
    return [...enumRebuild].some(
      (e) => ids.has(was(from.objects[e] as Enum).name) || ids.has((to.objects[e] as Enum).name),
    );
  };

  // 类型是被重建枚举的列：重建时会改到新类型，外键必须先删
  const enumCols = new Set(
    all(from, 'column')
      .filter((c) => c.typeRef && enumRebuild.has(c.typeRef))
      .map((c) => c.id),
  );

  const rebuild = new Set<string>();
  const isKey = (o: Obj): o is Constraint | Index =>
    o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'index';
  for (const o of common) {
    if (!isKey(o)) continue;
    const w = was(o);
    const exprs =
      w.kind === 'check' ? [w.expr] : w.kind === 'index' ? [...w.elements.map((e) => e.expr), w.where] : [];
    if (
      !same(definition(o), definition(migrated(w))) ||
      usesCols(w, regen) ||
      usesCols(w, typeChanged) ||
      exprs.some(mentionsRebuiltEnum)
    )
      rebuild.add(o.id);
  }
  // 外键：自身变了、两端列类型变了、或被引用表上的主键 / 唯一约束 / 唯一索引要删掉或重建
  const refKeyGone = (refTable: string) =>
    Object.values(from.objects).some(
      (k) =>
        (k.kind === 'primaryKey' || k.kind === 'unique' || (k.kind === 'index' && k.unique)) &&
        k.parent === refTable &&
        (isRemoved(k.id) || rebuild.has(k.id)),
    );
  for (const o of common) {
    if (o.kind !== 'foreignKey') continue;
    if (
      !same(definition(o), definition(was(o))) ||
      usesCols(was(o), typeChanged) ||
      usesCols(was(o), regen) ||
      usesCols(was(o), enumCols) ||
      refKeyGone(was(o).refTable)
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
  const opaqueChanged = new Set(
    common.filter((o) => o.kind === 'opaque' && !same(definition(o), definition(was(o)))).map((o) => o.id),
  );
  // 晚期对象（视图、触发器等）所依赖的对象被删除、重建、改类型时，要先删掉、最后重建
  const unstable = new Set<string>([
    ...removed.map((o) => o.id),
    ...rebuild,
    ...typeChanged,
    ...regen,
    ...enumRebuild,
    ...opaqueChanged,
  ]);
  const lateRebuild = new Set([...opaqueChanged].filter((id) => isLate(from.objects[id] as Opaque)));
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
  // ───── P0 删晚期不透明对象（被删除的、要重建的），依赖它的先删 ─────
  const lateDrops = all(from, 'opaque').filter(
    (o) => isLate(o) && (isRemoved(o.id) || lateRebuild.has(o.id)),
  );
  for (const o of topo(lateDrops).reverse()) dropOpaque(o);
  // ───── P1 删外键 ─────
  for (const o of [...removed, ...common.map(was)]) {
    if (o.kind !== 'foreignKey' || !(isRemoved(o.id) || rebuild.has(o.id))) continue;
    emit('dropForeignKey', o.id, `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${ident(get(cur, o.id).name)}`);
    delete cur.objects[o.id];
  }
  // ───── P2 删其他约束和索引（所在表要删的跳过，删表时一起删掉） ─────
  for (const o of [...removed, ...common.map(was)]) {
    if (!isKey(o) || !(isRemoved(o.id) || rebuild.has(o.id)) || tableRemoved(o)) continue;
    const name = get(cur, o.id).name;
    if (o.kind === 'index') emit('dropIndex', o.id, `DROP INDEX ${relIn(o.parent, name)}`);
    else
      emit(
        `drop${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}`,
        o.id,
        `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${ident(name)}`,
      );
    delete cur.objects[o.id];
  }
  // 删表 / 删列会顺带删掉的对象：其上的约束和索引、属于它的序列
  const autoDropped = new Set<string>();
  const dropWithColumn = (colId: string) => {
    for (const s of all(cur, 'sequence')) if (s.ownedBy === colId) autoDropped.add(s.id);
    for (const o of Object.values(cur.objects))
      if (isKey(o) && usesCols(o, new Set([colId]))) delete cur.objects[o.id];
  };
  // ───── P3 删需要重建的生成列 ─────
  for (const id of regen) {
    const c = get(cur, id, 'column');
    emit('dropColumn', id, `ALTER TABLE ${T(c.parent)} DROP COLUMN ${ident(c.name)}`);
    dropWithColumn(id);
    delete cur.objects[id];
  }
  // ───── P4 删表（分区子表先于父表） ─────
  const childFirst = (o: Obj) => (o.kind === 'table' && o.partitionOf ? 0 : 1);
  for (const o of [...removed].sort((x, y) => childFirst(x) - childFirst(y))) {
    if (o.kind !== 'table' || !(o.id in cur.objects)) continue;
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
  const generatedFirst = (o: Obj) => (o.kind === 'column' && o.generated ? 0 : 1);
  for (const o of [...removed].sort((x, y) => generatedFirst(x) - generatedFirst(y))) {
    if (o.kind !== 'column' || !(o.id in cur.objects)) continue;
    emit('dropColumn', o.id, `ALTER TABLE ${T(o.parent)} DROP COLUMN ${C(o.id)}`);
    dropWithColumn(o.id);
    delete cur.objects[o.id];
  }
  for (const id of autoDropped) delete cur.objects[id];

  // ───── P5b 提前去掉 identity 和 NOT NULL：它们占用的序列名、约束名可能是后面改名的目标 ─────
  for (const o of common) {
    if (o.kind !== 'column' || regen.has(o.id)) continue;
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
  for (const o of common) {
    const c = cur.objects[o.id];
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
      const w = was(o);
      if (w.notNull && o.notNull && c.notNullName && o.notNullName && c.notNullName !== o.notNullName) {
        items.push({
          id: `${o.id}#nn`,
          spaces: [`con:${o.parent}`],
          target: o.notNullName,
          rename: (n) =>
            `ALTER TABLE ${T(o.parent)} RENAME CONSTRAINT ${ident(get(cur, o.id, 'column').notNullName!)} TO ${ident(n)}`,
          apply: (n) => {
            get(cur, o.id, 'column').notNullName = n;
          },
        });
      }
      if (w.identity && o.identity && c.identity && c.identity.sequenceName !== o.identity.sequenceName) {
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
  // 后面才删除的对象（枚举、序列、schema）如果占着新对象要用的名字，先改成临时名腾出来
  const toNames = new Set<string>();
  for (const o of Object.values(to.objects))
    for (const s of spacesOfTo(to, o)) toNames.add(`${s}\u0000${o.name}`);
  for (const o of removed) {
    const c = cur.objects[o.id];
    if (!c || !(c.kind === 'enum' || c.kind === 'sequence' || c.kind === 'schema')) continue;
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
  // 当前各命名空间里谁占着哪个名字
  const occupant = (space: string, name: string): string | undefined => {
    for (const o of Object.values(cur.objects)) {
      if (o.name === name && spacesOf(o).includes(space)) return o.id;
      if (o.kind === 'column') {
        if (o.notNull && o.notNullName === name && space === `con:${o.parent}`) return `${o.id}#nn`;
        if (o.identity?.sequenceName === name && space === `rel:${schemaOfTable(o.parent)}`)
          return `${o.id}#seq`;
      }
    }
    return undefined;
  };
  const byId = new Map(items.map((i) => [i.id, i]));
  const toTemp = (it: Renamable) => {
    const n = `_dowel_tmp_${++tmp}`;
    emit('rename', it.id, it.rename(n));
    it.apply(n);
  };
  // 先让出被占用的名字（互换、链式改名），再一次改到目标名
  for (const it of items) if (!it.target) toTemp(it);
  for (let changed = true; changed;) {
    changed = false;
    for (const it of items) {
      if (!it.target) continue;
      for (const s of it.spaces) {
        const occ = occupant(s, it.target);
        if (occ && occ !== it.id) {
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
    emit('rename', it.id, it.rename(it.target));
    it.apply(it.target);
  }

  // 改名完成后，PG 已自动更新了引用这些名字的表达式：把当前状态里的表达式同步成新文本
  for (const o of common) {
    const c = cur.objects[o.id];
    if (!c) continue;
    const m = migrated(was(o));
    if ((c.kind === 'check' || c.kind === 'index') && same(definition(m), definition(o)))
      cur.objects[o.id] = { ...c, ...pickExprs(o) } as Obj;
    if (c.kind === 'column' && o.kind === 'column' && m.kind === 'column') {
      if (c.generated && same(m.generated, o.generated)) c.generated = clone(o.generated);
      if (c.default && 'expr' in c.default && same(m.default, o.default)) c.default = clone(o.default);
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
  for (const o of added) {
    if (o.kind !== 'enum') continue;
    cur.objects[o.id] = fresh(o);
    emit('createEnum', o.id, `CREATE TYPE ${qname(cur, o)} AS ENUM (${o.values.map(literal).join(', ')})`);
  }
  for (const o of common) {
    if (o.kind !== 'enum') continue;
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
      for (const col of all(cur, 'column')) {
        if (col.typeRef !== o.id) continue;
        if (col.default) {
          emit('dropDefault', col.id, `ALTER TABLE ${T(col.parent)} ALTER COLUMN ${C(col.id)} DROP DEFAULT`);
          col.default = null;
        }
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
  for (const o of topo(earlyCreates)) {
    if (inFrom(o.id) && (o.objType === 'domain' || o.objType === 'type'))
      dropOpaque(get(cur, o.id, 'opaque'));
    createOpaque(o); // 函数、聚合的 DDL 是 CREATE OR REPLACE，可以直接覆盖
  }
  // ───── P9 建序列（属于哪一列在列建好之后再设）、改序列选项 ─────
  for (const o of added) {
    if (o.kind !== 'sequence') continue;
    cur.objects[o.id] = { ...fresh(o), ownedBy: null };
    emit('createSequence', o.id, `CREATE SEQUENCE ${qname(cur, o)} ${seqOptions(o.options, true)}`);
  }
  for (const o of common) {
    if (o.kind !== 'sequence') continue;
    const c = get(cur, o.id, 'sequence');
    if (same(c.options, o.options)) continue;
    emit('alterSequence', o.id, `ALTER SEQUENCE ${qname(cur, c)} ${seqOptions(o.options, true)}`);
    c.options = clone(o.options);
  }
  // ───── P10 建表（列内联；约束和索引后面统一加；分区父表先于子表） ─────
  const parentFirst = (o: Obj) => (o.kind === 'table' && o.partitionOf ? 1 : 0);
  for (const o of [...added].sort((x, y) => parentFirst(x) - parentFirst(y))) {
    if (o.kind !== 'table') continue;
    cur.objects[o.id] = fresh(o);
    const columns = columnsOf(to, o.id);
    for (const c of columns) cur.objects[c.id] = fresh(c);
    const body = columns.length ? `\n  ${columns.map((c) => columnDef(c, o)).join(',\n  ')}\n` : '';
    const part = o.partitionBy ? ` PARTITION BY ${o.partitionBy}` : '';
    emit('createTable', o.id, `CREATE TABLE ${T(o.id)} (${body})${part}`);
    // 分区子表与 pg_dump 一样：先作为普通表建出来（保留自己的列定义和约束名），再挂到父表上
    if (o.partitionOf)
      emit(
        'attachPartition',
        o.id,
        `ALTER TABLE ${T(o.partitionOf.parent)} ATTACH PARTITION ${T(o.id)} ${o.partitionOf.bound}`,
      );
  }
  // ───── P11 加列（生成列在改完列之后再加，见 P12g） ─────
  const addColumn = (c: Column) => {
    const table = get(cur, c.parent, 'table');
    cur.objects[c.id] = fresh(c);
    emit('addColumn', c.id, `ALTER TABLE ${T(c.parent)} ADD COLUMN ${columnDef(c, table)}`);
  };
  for (const c of added) {
    if (c.kind !== 'column' || c.id in cur.objects || c.generated) continue;
    addColumn(c);
  }
  const lateGenerated = () => {
    for (const c of [...added, ...[...regen].map((id) => to.objects[id]!)]) {
      if (c.kind !== 'column' || c.id in cur.objects) continue;
      addColumn(c);
    }
  };

  // ───── P12 改列：分几轮，保证依赖顺序 ─────
  const altered = common.filter((o): o is Column => o.kind === 'column' && !regen.has(o.id));
  const A = (c: Column) => `ALTER TABLE ${T(c.parent)} ALTER COLUMN ${C(c.id)}`;
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
    if (c.default && (!same(c.default, o.default) || typeChanged.has(o.id))) {
      emit('dropDefault', o.id, `${A(c)} DROP DEFAULT`);
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
        o.notNullName
          ? `ALTER TABLE ${T(c.parent)} ADD CONSTRAINT ${ident(o.notNullName)} NOT NULL ${C(c.id)}`
          : `${A(c)} SET NOT NULL`,
      );
      c.notNull = true;
      c.notNullName = o.notNullName;
    }
    c.notNullNameMode = o.notNullNameMode;
  }
  // e. 设默认值
  for (const o of altered) {
    const c = get(cur, o.id, 'column');
    if (o.default && !same(c.default, o.default)) {
      c.default = clone(o.default);
      emit('setDefault', o.id, `${A(c)} SET DEFAULT ${defaultOf(c)}`);
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
      if (p.start !== null) sets.push(`SET START WITH ${p.start}`);
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
  const earlyDrops = all(from, 'opaque').filter((o) => !isLate(o) && isRemoved(o.id) && o.id in cur.objects);
  for (const o of topo(earlyDrops).reverse()) dropOpaque(get(cur, o.id, 'opaque'));
  for (const o of removed) {
    if (o.kind !== 'extension' || !(o.id in cur.objects)) continue;
    emit('dropExtension', o.id, `DROP EXTENSION ${ident(o.name)}`);
    delete cur.objects[o.id];
  }
  for (const kind of ['sequence', 'enum', 'schema'] as const) {
    for (const o of removed) {
      if (o.kind !== kind || !(o.id in cur.objects)) continue;
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
  // cur 里没有的就是新增的或前面删掉待重建的
  for (const kind of ['primaryKey', 'unique', 'check', 'index'] as const) {
    for (const o of Object.values(to.objects)) {
      if (o.kind !== kind || o.id in cur.objects) continue;
      cur.objects[o.id] = fresh(o);
      if (o.kind === 'index') emit('createIndex', o.id, indexDef(o));
      else
        emit(
          `add${kind[0]!.toUpperCase()}${kind.slice(1)}`,
          o.id,
          `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${ident(o.name)} ${constraintDef(o)}`,
        );
    }
  }
  // ───── P16 加外键 ─────
  for (const o of Object.values(to.objects)) {
    if (o.kind !== 'foreignKey' || o.id in cur.objects) continue;
    cur.objects[o.id] = fresh(o);
    emit(
      'addForeignKey',
      o.id,
      `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${ident(o.name)} ${constraintDef(o)}`,
    );
  }
  // ───── P16b 建晚期不透明对象（视图、触发器、策略、排他约束） ─────
  const lateCreates = all(to, 'opaque').filter((o) => isLate(o) && !(o.id in cur.objects));
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
  for (const o of Object.values(to.objects)) {
    const c = cur.objects[o.id];
    if (!c) throw new PlanError(`内部错误：规划结束时缺少对象 ${o.kind} ${o.name}`);
    if (c.name !== o.name || !same(definition(c), definition(o)))
      throw new PlanError(`内部错误：规划结束时 ${o.kind} ${o.name} 与目标不一致`);
    if ((c.comment ?? null) !== (o.comment ?? null) && o.kind !== 'opaque') {
      const what = commentTarget(o);
      emit('comment', o.id, `COMMENT ON ${what} IS ${o.comment === null ? 'NULL' : literal(o.comment)}`);
    }
    cur.objects[o.id] = clone(o);
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
    case 'foreignKey':
      return [`con:${o.parent}`];
  }
};

/** 把整个模型从零建出来的语句（导出 DDL 用） */
export const createAll = (m: Model): Step[] => plan({ ...m, objects: {} }, m);
