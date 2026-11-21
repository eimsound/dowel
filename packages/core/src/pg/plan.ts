// 比较两个版本的 IR，生成 PG 迁移语句。
// 规划时维护一份“当前状态” cur：每生成一步就把它更新到执行这一步之后的样子，
// 所以每条语句引用的都是当时实际存在的名字；结束时断言 cur 等于目标版本。

import { exprReferences, renameInExpr, renameQualifiedInExpr } from '../edit.ts';
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
import { deepEqual } from '../json.ts';
import {
  all,
  childrenOf,
  columnsOf,
  find,
  get,
  indexElementNames,
  partitionBySql,
  partitionDepth,
  partitionDescendants,
  qname,
  rootTableId,
} from '../model.ts';
import { checkPgCompatibility, LATEST_PG_MAJOR, pgCapabilities, type PlanOptions } from './capabilities.ts';
import { chooseName, joinNames } from './naming.ts';
import { derivedUuid, partitionKeyColumns } from './partition.ts';
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
const definition = (o: Obj, m?: Model, fallback?: Model): unknown => {
  switch (o.kind) {
    case 'schema':
      return null;
    case 'table':
      return [m ? partitionBySql(m, o, fallback) : o.partitionBy, o.partitionOf];
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

export const plan = (from: Model, to: Model, opts?: PlanOptions): Step[] => {
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

  const inFrom = (id: string) => id in from.objects;
  const inTo = (id: string) => id in to.objects;
  const removed = Object.values(from.objects).filter((o) => !inTo(o.id));
  const added = Object.values(to.objects).filter((o) => !inFrom(o.id));
  const common = Object.values(to.objects).filter((o) => inFrom(o.id));
  const was = <T extends Obj>(o: T): T => from.objects[o.id] as T;
  const isRemoved = (id: string) => inFrom(id) && !inTo(id);

  // ───── 分区挂载/脱离/改边界关系预分析 ─────
  const detaching = new Set<string>();
  const attaching = new Set<string>();
  const rebinding = new Set<string>();
  for (const o of common) {
    if (o.kind !== 'table') continue;
    const w = was(o);
    if (w.partitionOf && !o.partitionOf) detaching.add(o.id);
    else if (!w.partitionOf && o.partitionOf) attaching.add(o.id);
    else if (w.partitionOf && o.partitionOf && !same(w.partitionOf, o.partitionOf)) rebinding.add(o.id);
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

  // 存量旧格式子分区冗余列升级清理：from 和 to 均为子分区、但 to 已移除冗余列对象，不发 DROP COLUMN
  const legacyChildCols = new Set<string>();
  const legacyColMap = new Map<string, Map<string, string>>(); // tableId → (fromLegacyColId → toRootColId)
  for (const o of removed) {
    if (o.kind !== 'column') continue;
    const ft = find(from, o.parent);
    const tt = find(to, o.parent);
    if (ft?.kind === 'table' && tt?.kind === 'table' && ft.partitionOf && tt.partitionOf) {
      legacyChildCols.add(o.id);
      const rc = columnsOf(to, rootTableId(to, tt.id)).find((x) => x.name === o.name);
      if (rc) {
        let map = legacyColMap.get(tt.id);
        if (!map) {
          map = new Map();
          legacyColMap.set(tt.id, map);
        }
        map.set(o.id, rc.id);
      }
    }
  }

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
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (tc.name !== rc.name)
      colRenames.set(tc.parent, [...(colRenames.get(tc.parent) ?? []), [rc.name, tc.name]]);
  }
  const migrateExpr = (expr: string, table: string): string => {
    let e = expr;
    for (const [a, b] of schemaRenames) e = renameQualifiedInExpr(e, a, null, { schema: b, name: null });
    for (const [sch, a, b] of enumRenames) e = renameQualifiedInExpr(e, sch, a, { schema: sch, name: b });
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
    attachColMap.get(tableId) ?? detachRootToNewCol.get(tableId) ?? legacyColMap.get(tableId);
  const migrated = <T extends Obj>(w: T): T => {
    const o = clone(w) as Obj;
    if (o.kind === 'table' && o.partitionBy && typeof o.partitionBy !== 'string') {
      const rm = remapIdsForTable(o.id);
      for (const k of o.partitionBy.keys) {
        if (k.column && rm?.has(k.column)) k.column = rm.get(k.column)!;
        if (k.expr) k.expr = migrateExpr(k.expr, o.id);
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
        if (!samePartBy) {
          throw new PlanError(`暂不支持修改已存在表的分区策略或分区键：${o.name}`);
        }
      }
    }
    if (o.kind === 'extension' && !same(definition(o), definition(was(o))))
      throw new PlanError(`扩展暂不支持修改：${o.name}`);
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
  const typeChanged = new Set(
    common
      .filter((o): o is Column => o.kind === 'column')
      .filter(
        (c) =>
          !same(pick(c, ['type', 'typeRef', 'collation']), pick(was(c), ['type', 'typeRef', 'collation'])),
      )
      .map((c) => c.id),
  );
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (!same(pick(tc, ['type', 'typeRef', 'collation']), pick(rc, ['type', 'typeRef', 'collation'])))
      typeChanged.add(toColId);
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
  for (const [toColId, rc] of detachToRootCol) {
    const tc = get(to, toColId, 'column');
    if (!tc.generated && !rc.generated) continue;
    const mrc = { ...clone(rc), parent: tc.parent };
    if (mrc.generated) mrc.generated.expr = migrateExpr(mrc.generated.expr, tc.parent);
    if (
      !same(tc.generated, mrc.generated) ||
      typeChanged.has(toColId) ||
      (tc.generated && exprTouches(tc.generated.expr, colsOfTable(tc.parent, typeChanged)))
    )
      regen.add(toColId);
  }
  for (const id of regen) typeChanged.delete(id);

  // 分区键引用的列不允许改类型（PG 报错 cannot alter type of column named in partition key）
  for (const o of common) {
    if (o.kind !== 'table' || !o.partitionBy) continue;
    const refs = partitionKeyColumns(to, o);
    for (const colId of refs.all) {
      if (typeChanged.has(colId) || regen.has(colId)) {
        const colName = find(to, colId)?.name ?? colId;
        throw new PlanError(`列 ${colName} 被分区表 ${o.name} 的分区键引用，不能修改类型`);
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
    ...detaching,
    ...attaching,
    ...rebinding,
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
  const conTakenCur = (tableId: string, name: string) =>
    Object.values(cur.objects).some((o) => {
      if (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.parent === tableId
      )
        return o.name === name;
      if (o.kind === 'column' && o.parent === tableId && o.notNull && cap.namedNotNull)
        return o.notNullName === name;
      return false;
    });
  const chooseInCur = (
    schema: string,
    tableId: string,
    n1: string,
    n2: string | null,
    label: string,
    rel: boolean,
    con: boolean,
  ) => chooseName(n1, n2, label, (n) => (rel && relTakenCur(schema, n)) || (con && conTakenCur(tableId, n)));

  const materialized = new Set<string>();
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
  for (const tId of [...willDetach].sort((a, b) => partitionDepth(from, b) - partitionDepth(from, a))) {
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
    const subTree = new Set([tId, ...partitionDescendants(cur, tId).map((d) => d.id)]);
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
        if (!toMatch) {
          toMatch = toOnT.find((x) => {
            if (x.kind !== detObj.kind || matchedToObjs.has(x.id) || x.id in cur.objects) return false;
            if (x.kind === 'primaryKey') return true;
            if (x.kind === 'check' && detObj.kind === 'check')
              return x.name === detObj.name || x.expr === migrateExpr(detObj.expr, tId);
            if (x.kind === 'foreignKey' && detObj.kind === 'foreignKey') return x.name === detObj.name;
            return same(definition(x), definition(migrated(detObj)));
          });
        }
        if (toMatch) {
          matchedToObjs.add(toMatch.id);
          const placed = { ...detObj, id: toMatch.id };
          cur.objects[toMatch.id] = placed;
          materialized.add(toMatch.id);
          if (
            !same(definition(toMatch), definition(migrated(placed))) ||
            usesCols(placed, regen) ||
            usesCols(placed, typeChanged) ||
            (placed.kind === 'foreignKey' && (usesCols(placed, enumCols) || refKeyGone(placed.refTable)))
          ) {
            rebuild.add(toMatch.id);
          }
          return;
        }
      }
      const synId = `__dowel_det_obj_${++synSeq}`;
      cur.objects[synId] = { ...detObj, id: synId };
      syntheticDetached.add(synId);
      if (
        sameParentRebind &&
        inTo(ancObj.id) &&
        !rebuild.has(ancObj.id) &&
        ((ancObj.kind !== 'check' && ancObj.kind !== 'foreignKey') ||
          ancObj.name === to.objects[ancObj.id]!.name)
      ) {
        retainedForReattach.add(synId);
      }
    };

    for (const anc of oldAncestors) {
      for (const pk of childrenOf(cur, anc.id, 'primaryKey')) {
        if (childrenOf(cur, tId, 'primaryKey').length > 0) continue;
        const mappedCols = pk.columns.map(mapCol);
        const detName = chooseInCur(t.parent, tId, t.name, null, 'pkey', true, true);
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
      for (const u of childrenOf(cur, anc.id, 'unique')) {
        const mappedCols = u.columns.map(mapCol);
        const colNames = mappedCols.map((c) => get(cur, c, 'column').name);
        const detName = chooseInCur(t.parent, tId, t.name, joinNames(colNames), 'key', true, true);
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
      for (const idx of childrenOf(cur, anc.id, 'index')) {
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
        mappedIdx.name = chooseInCur(
          t.parent,
          tId,
          t.name,
          joinNames(indexElementNames(cur, mappedIdx)),
          'idx',
          true,
          false,
        );
        registerDetached(idx, mappedIdx, 'idx');
      }
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
      if (isRemoved(ck.id) && ancChecks.some((ak) => ak.name === ck.name && ak.expr === ck.expr)) {
        keptForAttachCheck.add(ck.id);
      }
    }
  }

  // ───── P1 删外键 ─────
  for (const o of Object.values(cur.objects)) {
    if (o.kind !== 'foreignKey') continue;
    const shouldDrop = syntheticDetached.has(o.id)
      ? !retainedForReattach.has(o.id)
      : isRemoved(o.id) || rebuild.has(o.id);
    if (!shouldDrop) continue;
    emit('dropForeignKey', o.id, `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${ident(o.name)}`);
    delete cur.objects[o.id];
  }
  // ───── P2 删其他约束和索引（所在表要删的跳过，删表时一起删掉） ─────
  for (const o of Object.values(cur.objects)) {
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
    if (!(o.id in cur.objects)) continue;
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
    if (!(o.id in cur.objects)) continue;
    if (attachKeptCols.has(o.id)) continue; // 将在 P12h 随 ATTACH 吸收
    if (legacyChildCols.has(o.id)) {
      delete cur.objects[o.id];
      continue;
    }
    emit('dropColumn', o.id, `ALTER TABLE ${T(o.parent)} DROP COLUMN ${C(o.id)}`);
    dropWithColumn(o.id);
    delete cur.objects[o.id];
  }
  for (const id of autoDropped) delete cur.objects[id];

  // ───── P5b 提前去掉 identity 和 NOT NULL：它们占用的序列名、约束名可能是后面改名的目标 ─────
  const liveTargets = Object.values(to.objects).filter((o) => inFrom(o.id) || materialized.has(o.id));
  for (const o of liveTargets) {
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
  for (const o of liveTargets) {
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
          spaces: [`con:${o.parent}`],
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
        if (cap.namedNotNull && o.notNull && o.notNullName === name && space === `con:${o.parent}`)
          return `${o.id}#nn`;
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
  for (const o of liveTargets) {
    const c = cur.objects[o.id];
    if (!c) continue;
    const base = inFrom(o.id) ? was(o) : c;
    const m = migrated(base);
    if (
      c.kind === 'table' &&
      o.kind === 'table' &&
      m.kind === 'table' &&
      same(partitionBySql(cur, m, from), partitionBySql(to, o))
    ) {
      c.partitionBy = clone(o.partitionBy);
    }
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
          if (get(cur, col.parent, 'table').partitionBy !== null) {
            for (const desc of partitionDescendants(cur, col.parent)) {
              emit('dropDefault', col.id, `ALTER TABLE ${T(desc.id)} ALTER COLUMN ${C(col.id)} DROP DEFAULT`);
            }
          }
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
  // ───── P10 建表（列内联；约束和索引后面统一加；按分区深度升序，父表先于子表，天然支持多级分区） ─────
  const addedTables = added
    .filter((o): o is Table => o.kind === 'table')
    .sort((x, y) => partitionDepth(to, x.id) - partitionDepth(to, y.id));
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
    if (o.kind === 'primaryKey' || o.kind === 'unique') return o.columns.every((c) => c in cur.objects);
    return (
      o.elements.every((e) => !e.column || e.column in cur.objects) &&
      o.include.every((c) => c in cur.objects)
    );
  };
  for (const o of addedTables) {
    cur.objects[o.id] = fresh(o);
    const columns = columnsOf(to, o.id);
    if (o.partitionOf && columns.length === 0) {
      const partSql = partitionBySql(cur, o);
      const part = partSql ? ` PARTITION BY ${partSql}` : '';
      // 标准分区子表：不冗余存列，直接使用 CREATE TABLE ... PARTITION OF 继承父表列与约束
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
      // 兼容存量旧格式（子分区带冗余列）：先作为普通表建出来，再 ATTACH 到父表上
      if (o.partitionOf)
        emit(
          'attachPartition',
          o.id,
          `ALTER TABLE ${T(o.partitionOf.parent)} ATTACH PARTITION ${T(o.id)} ${o.partitionOf.bound}`,
        );
    }
    // 新建分区父表时，在创建其子分区之前先把父表自身的 PK / UNIQUE / INDEX 建好，
    // 防止后续先建子分区再建索引时 PG 自动生成的子分区继承索引名抢占父表显式索引名（63 字节截断重名）
    if (o.partitionBy !== null && !o.partitionOf) {
      for (const kind of ['primaryKey', 'unique', 'index'] as const) {
        for (const k of childrenOf(to, o.id, kind)) {
          if (k.id in cur.objects || !allColRefsInCur(k)) continue;
          emitConstraintOrIndex(k);
        }
      }
    }
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
  const altered = liveTargets.filter((o): o is Column => o.kind === 'column' && !regen.has(o.id));
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
    if (c.default && (!same(c.default, o.default) || typeChanged.has(o.id))) {
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
          return (
            rc &&
            !same(pick(cc, ['type', 'typeRef', 'collation']), pick(rc, ['type', 'typeRef', 'collation']))
          );
        })
        .map((cc) => cc.name),
    );
    const colsToDropOnChild = childCols
      .filter((cc) => {
        const rc = rootCols.find((x) => x.name === cc.name);
        if (!rc) return true;
        if (!same(cc.generated, rc.generated)) return true;
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
    // 2. 补齐缺失的非生成列，并对齐已存在的非生成列
    for (const rc of rootCols) {
      const cc = curChildCols.find((x) => x.name === rc.name);
      if (!cc) {
        if (rc.generated) continue;
        const addedCol: Column = {
          ...clone(rc),
          id: `__dowel_att_col_${++synSeq}`,
          parent: tId,
          identity: null,
          notNullName: cap.namedNotNull ? rc.notNullName : null,
          comment: null,
        };
        emit('addColumn', tId, `ALTER TABLE ${T(tId)} ADD COLUMN ${columnDef(addedCol, childTable)}`);
        continue;
      }
      childToRootCol.set(cc.id, rc.id);
      if (cc.generated) continue;
      const Ac = `ALTER TABLE ${T(tId)} ALTER COLUMN ${ident(cc.name)}`;
      if (cc.identity) {
        emit('dropIdentity', cc.id, `${Ac} DROP IDENTITY`);
        cc.identity = null;
      }
      if (cc.default && !same(cc.default, rc.default)) {
        emit('dropDefault', cc.id, `${Ac} DROP DEFAULT`);
        cc.default = null;
      }
      if (!same(pick(cc, ['type', 'typeRef', 'collation']), pick(rc, ['type', 'typeRef', 'collation']))) {
        const viaText = !!(cc.typeRef || rc.typeRef) || !hasDirectCast(cc.type, rc.type);
        const targetType = rc.typeRef ? qname(cur, get(cur, rc.typeRef, 'enum')) + rc.type : rc.type;
        emit(
          'alterType',
          cc.id,
          `${Ac} TYPE ${typeOf(rc)} USING ${ident(cc.name)}${viaText ? `::text${arrayDims(cc.type) === arrayDims(rc.type) ? arrayDims(cc.type) : ''}` : ''}::${targetType}`,
        );
        Object.assign(cc, { type: rc.type, typeRef: rc.typeRef, collation: rc.collation });
      }
      if (cc.notNull && !rc.notNull) {
        emit('dropNotNull', cc.id, `${Ac} DROP NOT NULL`);
        cc.notNull = false;
        cc.notNullName = null;
      }
      if (!cc.notNull && rc.notNull) {
        emit(
          'setNotNull',
          cc.id,
          cap.namedNotNull && rc.notNullName
            ? `ALTER TABLE ${T(tId)} ADD CONSTRAINT ${ident(rc.notNullName)} NOT NULL ${ident(cc.name)}`
            : `${Ac} SET NOT NULL`,
        );
        cc.notNull = true;
        cc.notNullName = cap.namedNotNull ? rc.notNullName : null;
      } else if (
        cap.namedNotNull &&
        cc.notNull &&
        rc.notNull &&
        cc.notNullName &&
        rc.notNullName &&
        cc.notNullName !== rc.notNullName &&
        !conTakenCur(tId, rc.notNullName)
      ) {
        emit(
          'rename',
          `${cc.id}#nn`,
          `ALTER TABLE ${T(tId)} RENAME CONSTRAINT ${ident(cc.notNullName)} TO ${ident(rc.notNullName)}`,
        );
        cc.notNullName = rc.notNullName;
      }
      if (rc.default && !same(cc.default, rc.default)) {
        cc.default = clone(rc.default);
        emit('setDefault', cc.id, `${Ac} SET DEFAULT ${defaultOf(rc)}`);
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
        notNullName: cap.namedNotNull ? rc.notNullName : null,
        comment: null,
      };
      emit('addColumn', tId, `ALTER TABLE ${T(tId)} ADD COLUMN ${columnDef(addedCol, childTable)}`);
    }

    // 补齐目标父表/祖先表上已存在的 CHECK 约束（PG ATTACH PARTITION 要求子表先具备父表 CHECK）
    for (const anc of ancestorsCur(targetParentId)) {
      for (const ancCk of childrenOf(cur, anc.id, 'check')) {
        const existing = childrenOf(cur, tId, 'check').find((x) => x.name === ancCk.name);
        if (existing) {
          if (existing.expr === ancCk.expr || retainedForReattach.has(existing.id)) continue;
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
  // cur 里没有的就是新增的或前面删掉待重建的；子表本地对象先于父表创建，
  // 且当在已有子分区的父表上建 PK / UNIQUE / INDEX 时，若 PG 自动生成的子分区继承索引名抢占了待建对象的名字，立即改名为非冲突派生名
  const pendingRelNames = new Set<string>();
  for (const o of Object.values(to.objects)) {
    if ((o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'index') && !(o.id in cur.objects)) {
      pendingRelNames.add(`${get(to, o.parent, 'table').parent}:${o.name}`);
    }
  }
  const implicitRels = new Set<string>();
  const implicitNameOf = (o: PrimaryKey | Unique | Index, desc: Table, skipPending: boolean): string => {
    const colPart =
      o.kind === 'primaryKey'
        ? null
        : o.kind === 'unique'
          ? joinNames(o.columns.map((c) => get(cur, c, 'column').name))
          : joinNames(indexElementNames(cur, o));
    const label = o.kind === 'primaryKey' ? 'pkey' : o.kind === 'unique' ? 'key' : 'idx';
    return chooseName(
      desc.name,
      colPart,
      label,
      (n) =>
        relTakenCur(desc.parent, n) ||
        implicitRels.has(`${desc.parent}:${n}`) ||
        (skipPending && pendingRelNames.has(`${desc.parent}:${n}`)),
    );
  };
  // 先登记 cur 中已存在的分区父表 PK / UNIQUE / INDEX 在其后代上已占用的隐式继承索引名
  for (const kind of ['primaryKey', 'unique', 'index'] as const) {
    for (const o of Object.values(cur.objects)) {
      if (o.kind !== kind) continue;
      const tbl = get(cur, o.parent, 'table');
      if (tbl.partitionBy === null) continue;
      for (const desc of partitionDescendants(cur, tbl.id)) {
        implicitRels.add(`${desc.parent}:${implicitNameOf(o, desc, false)}`);
      }
    }
  }
  for (const kind of ['primaryKey', 'unique', 'check', 'index'] as const) {
    const todo = Object.values(to.objects)
      .filter((o): o is PrimaryKey | Unique | Check | Index => o.kind === kind && !(o.id in cur.objects))
      .sort((a, b) => partitionDepth(to, b.parent) - partitionDepth(to, a.parent));
    for (const o of todo) {
      emitConstraintOrIndex(o);
      if (o.kind === 'check') continue;
      const tbl = get(cur, o.parent, 'table');
      pendingRelNames.delete(`${tbl.parent}:${o.name}`);
      if (tbl.partitionBy === null) continue;
      for (const desc of partitionDescendants(cur, tbl.id)) {
        const pgName = implicitNameOf(o, desc, false);
        if (pendingRelNames.has(`${desc.parent}:${pgName}`)) {
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
        } else {
          implicitRels.add(`${desc.parent}:${pgName}`);
        }
      }
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
    if (c.name !== o.name || !same(definition(c, cur), definition(o, to)))
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
export const createAll = (m: Model, opts?: PlanOptions): Step[] => plan({ ...m, objects: {} }, m, opts);
