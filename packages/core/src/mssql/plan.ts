// MSSQL（SQL Server 2019 / 2022 / 2025）迁移规划器。
// 规划时维护实时状态 cur，每生成一步就同步推进 cur，确保每条语句引用的都是当时实际存在的名字；
// 结束时严格断言 cur === to。
import type {
  Check,
  Column,
  ForeignKey,
  Index,
  Model,
  Obj,
  Opaque,
  PrimaryKey,
  Schema,
  SequenceOptions,
  Table,
  Unique,
} from '../ir.ts';
import { EARLY_OPAQUE } from '../ir.ts';
import { deepEqual } from '../json.ts';
import { all, childrenOf, columnsOf, find, get } from '../model.ts';
import type { PlanOptions } from '../pg/capabilities.ts';
import { PlanError, type Step } from '../plan-types.ts';
import { isReservedMssqlSchema, mssqlDerivedNames } from './naming.ts';
import {
  mssqlColumnRefs,
  mssqlIdent,
  mssqlLiteral,
  mssqlQualified,
  mssqlRenameInExpr,
  mssqlRenameQualifiedInExpr,
} from './quote.ts';
import { checkMssqlVersionCompatibility, mssqlNormalizeType } from './types.ts';

export interface MssqlPlanOptions extends PlanOptions {
  mssqlMajor?: number | null;
}

const clone = <T>(x: T): T => structuredClone(x);
const fresh = <T extends Obj>(o: T): T => ({ ...structuredClone(o), comment: null });
const same = deepEqual;
const pick = <T extends object>(o: T, keys: (keyof T)[]) => keys.map((k) => o[k]);

const FK_ACTION: Record<ForeignKey['onDelete'], string> = {
  noAction: 'NO ACTION',
  restrict: 'NO ACTION',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

const SEQ_TYPE_SQL: Record<SequenceOptions['type'], string> = {
  smallint: 'smallint',
  integer: 'int',
  bigint: 'bigint',
};

const SEQ_DEFAULT_BOUNDS: Record<SequenceOptions['type'], [string, string]> = {
  smallint: ['-32768', '32767'],
  integer: ['-2147483648', '2147483647'],
  bigint: ['-9223372036854775808', '9223372036854775807'],
};

const isBalancedWrapped = (expr: string): boolean => {
  const t = expr.trim();
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  let inSingle = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (inSingle) {
      if (ch === "'" && t[i + 1] === "'") i++;
      else if (ch === "'") inSingle = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return false;
    }
  }
  return depth === 0;
};

/** 包装 DEFAULT 表达式（已有平衡外层括号则直接复用，避免多重套娃） */
export const formatMssqlDefaultExpr = (expr: string): string => {
  const t = expr.trim();
  return isBalancedWrapped(t) ? t : `(${t})`;
};

/** 判断某张表上是否有显式指定为 CLUSTERED 的 UNIQUE 或 INDEX */
const hasExplicitClusteredNonPk = (m: Model, tableId: string): boolean =>
  childrenOf(m, tableId, 'unique').some((u) => u.ext?.mssql?.clustered === true) ||
  childrenOf(m, tableId, 'index').some((ix) => ix.ext?.mssql?.clustered === true);

/** 解析主键在 MSSQL 下是否应为 CLUSTERED（未显式指定时默认 CLUSTERED，除非表上已有其他 CLUSTERED 键/索引） */
export const isMssqlPkClustered = (m: Model, pk: PrimaryKey): boolean => {
  if (pk.ext?.mssql?.clustered !== undefined) return pk.ext.mssql.clustered;
  return !hasExplicitClusteredNonPk(m, pk.parent);
};

const isKeyOrIndexClustered = (m: Model, o: PrimaryKey | Unique | Index): boolean => {
  if (o.kind === 'primaryKey') return isMssqlPkClustered(m, o);
  return o.ext?.mssql?.clustered === true;
};

/** 计算列上默认约束的实际名字（显式或自动推导 `DF_<table>_<col>`） */
export const mssqlDefaultNameOf = (c: Column, tableName: string): string =>
  c.ext?.mssql?.defaultName ?? mssqlDerivedNames.default(tableName, c.name);

const identitySpecOf = (c: Column): { seed: string; increment: string } | null =>
  c.ext?.mssql?.identity ?? null;

/** 对象中决定语义定义的字段（不含名字、注释、展示顺序） */
const definition = (o: Obj, m: Model): unknown => {
  switch (o.kind) {
    case 'schema':
      return null;
    case 'table':
      return null;
    case 'extension':
      return [o.name, o.parent];
    case 'opaque':
      return [o.objType, o.name, o.ddl, o.drop];
    case 'enum':
      return o.values;
    case 'sequence':
      return [o.options];
    case 'column':
      return [
        mssqlNormalizeType(o.type),
        o.collation,
        o.notNull,
        o.default,
        o.generated,
        identitySpecOf(o),
        Boolean(o.ext?.mssql?.sparse),
        Boolean(o.ext?.mssql?.rowguidcol),
      ];
    case 'primaryKey':
      return [o.columns, isMssqlPkClustered(m, o)];
    case 'unique':
      return [o.columns, Boolean(o.ext?.mssql?.clustered)];
    case 'foreignKey':
      return pick(o, ['columns', 'refTable', 'refColumns', 'onDelete', 'onUpdate']);
    case 'check':
      return o.expr;
    case 'index':
      return [
        o.unique,
        o.elements.map((e) => [e.column, e.expr, e.desc]),
        o.include,
        o.where,
        Boolean(o.ext?.mssql?.clustered),
        o.ext?.mssql?.fillFactor ?? null,
      ];
  }
};

const exprIdentsLower = (expr: string): Set<string> =>
  new Set(mssqlColumnRefs(expr).map((t) => t.text.toLowerCase()));

/** 构造 sp_rename 调用（第一个参数可带方括号限定，第二个新名必须是裸名且不可加方括号） */
const spRename = (oldTarget: string, newName: string, objType: 'OBJECT' | 'COLUMN' | 'INDEX'): string =>
  `EXEC sys.sp_rename ${mssqlLiteral(oldTarget)}, ${mssqlLiteral(newName)}, N'${objType}'`;

/** 构造 MS_Description 扩展属性操作语句 */
const extendedPropSql = (
  action: 'add' | 'update' | 'drop',
  value: string | null,
  levels: { type: string; name: string }[],
): string => {
  const proc =
    action === 'add'
      ? 'sys.sp_addextendedproperty'
      : action === 'update'
        ? 'sys.sp_updateextendedproperty'
        : 'sys.sp_dropextendedproperty';
  const args: string[] = [`@name = N'MS_Description'`];
  if (action !== 'drop') args.push(`@value = ${mssqlLiteral(value ?? '')}`);
  levels.forEach((lv, idx) => {
    args.push(`@level${idx}type = N'${lv.type}'`, `@level${idx}name = ${mssqlLiteral(lv.name)}`);
  });
  return `EXEC ${proc} ${args.join(', ')}`;
};

export const mssqlPlan = (from: Model, to: Model, opts?: MssqlPlanOptions): Step[] => {
  if (from.dialect !== 'mssql' || to.dialect !== 'mssql') {
    throw new PlanError(`mssqlPlan 需要 mssql 模型，收到 ${from.dialect} -> ${to.dialect}`);
  }

  const targetMajor = opts?.mssqlMajor ?? null;
  if (targetMajor !== null) {
    if (!Number.isInteger(targetMajor) || targetMajor < 11) {
      throw new PlanError(`无效的目标 SQL Server 主版本号：${String(targetMajor)}`);
    }
    const compatErrs = checkMssqlVersionCompatibility(to, targetMajor);
    if (compatErrs.length > 0) {
      throw new PlanError(
        `目标 SQL Server ${targetMajor} 不支持以下特性：\n${compatErrs.map((e) => `- ${e}`).join('\n')}`,
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

  // ───── 合法性预检 ─────
  for (const s of all(to, 'schema')) {
    if (isReservedMssqlSchema(s.name)) {
      throw new PlanError(`schema ${s.name} 为 SQL Server / Dowel 保留 schema，不允许创建或修改`);
    }
  }

  for (const t of all(to, 'table')) {
    let clusteredCount = 0;
    for (const pk of childrenOf(to, t.id, 'primaryKey')) {
      if (isMssqlPkClustered(to, pk)) clusteredCount++;
    }
    for (const u of childrenOf(to, t.id, 'unique')) {
      if (u.ext?.mssql?.clustered) clusteredCount++;
    }
    for (const ix of childrenOf(to, t.id, 'index')) {
      if (ix.ext?.mssql?.clustered) clusteredCount++;
    }
    if (clusteredCount > 1) {
      throw new PlanError(`表 ${t.name} 定义了 ${clusteredCount} 个 CLUSTERED 约束或索引，每表最多允许 1 个`);
    }
  }

  for (const o of common) {
    const w = was(o);
    if (o.kind !== w.kind) {
      throw new PlanError(`对象 ${o.id} 的种类从 ${w.kind} 变成了 ${o.kind}`);
    }
    if (o.kind === 'column' && o.parent !== (w as Column).parent) {
      throw new PlanError(`不能把列 ${o.name} 移到其他表`);
    }
    if (
      (o.kind === 'primaryKey' ||
        o.kind === 'unique' ||
        o.kind === 'foreignKey' ||
        o.kind === 'check' ||
        o.kind === 'index') &&
      o.parent !== (w as typeof o).parent
    ) {
      throw new PlanError(`不能把 ${o.kind} ${o.name} 移到其他表`);
    }
    if (o.kind === 'column') {
      const wc = w as Column;
      const oldId = identitySpecOf(wc);
      const newId = identitySpecOf(o);
      if (!same(oldId, newId)) {
        const tbl = get(to, o.parent, 'table');
        throw new PlanError(
          `SQL Server 不允许原地增删或修改已有列 ${tbl.name}.${o.name} 的 IDENTITY 属性（需新建列并迁移数据或重建表）`,
        );
      }
    }
  }

  // ───── 改名引起的表达式差异分析 ─────
  const schemaRenames = common
    .filter((o): o is Schema => o.kind === 'schema' && o.name !== was(o).name)
    .map((o) => [was(o).name, o.name] as const);
  const colRenames = new Map<string, [string, string][]>();
  const renamedColIds = new Set<string>();
  for (const o of common) {
    if (o.kind === 'column' && o.name !== was(o).name) {
      renamedColIds.add(o.id);
      colRenames.set(o.parent, [...(colRenames.get(o.parent) ?? []), [was(o).name, o.name]]);
    }
  }

  const migrateExpr = (expr: string, tableId: string): string => {
    let e = expr;
    for (const [a, b] of schemaRenames) e = mssqlRenameQualifiedInExpr(e, a, null, { schema: b, name: null });
    const rs = colRenames.get(tableId) ?? [];
    rs.forEach(([a], i) => {
      e = mssqlRenameInExpr(e, a, `__dowel_ph_${i}__`);
    });
    rs.forEach(([, b], i) => {
      e = mssqlRenameInExpr(e, `__dowel_ph_${i}__`, b);
    });
    return e;
  };

  // ───── 基于 cur 的渲染器 ─────
  const schemaOf = (id: string) => get(cur, id, 'schema').name;
  const tableOf = (id: string) => get(cur, id, 'table');
  const T = (id: string) => {
    const t = tableOf(id);
    return mssqlQualified(schemaOf(t.parent), t.name);
  };
  const S = (id: string) => {
    const s = get(cur, id, 'sequence');
    return mssqlQualified(schemaOf(s.parent), s.name);
  };
  const C = (id: string) => mssqlIdent(get(cur, id, 'column').name);
  const cols = (ids: string[]) => ids.map(C).join(', ');

  const typeClause = (c: Column): string => {
    const base = mssqlNormalizeType(c.type);
    return c.collation ? `${base} COLLATE ${c.collation}` : base;
  };

  const defaultExprOf = (c: Column): string | null => {
    if (!c.default) return null;
    if ('expr' in c.default) return formatMssqlDefaultExpr(c.default.expr);
    return `(NEXT VALUE FOR ${S(c.default.nextval)})`;
  };

  const columnDef = (c: Column, table: Table): string => {
    if (c.generated) {
      let s = `${mssqlIdent(c.name)} AS (${c.generated.expr})`;
      if (c.generated.stored) {
        s += ' PERSISTED';
        if (c.notNull) s += ' NOT NULL';
      }
      return s;
    }
    const parts: string[] = [mssqlIdent(c.name), typeClause(c)];
    const idSpec = identitySpecOf(c);
    if (idSpec) parts.push(`IDENTITY(${idSpec.seed}, ${idSpec.increment})`);
    if (c.ext?.mssql?.sparse) parts.push('SPARSE');
    if (c.ext?.mssql?.rowguidcol) parts.push('ROWGUIDCOL');
    parts.push(c.notNull ? 'NOT NULL' : 'NULL');
    const def = defaultExprOf(c);
    if (def) {
      const dfName = mssqlDefaultNameOf(c, table.name);
      parts.push(`CONSTRAINT ${mssqlIdent(dfName)} DEFAULT ${def}`);
    }
    return parts.join(' ');
  };

  const seqOptionsSql = (o: SequenceOptions, mode: 'create' | 'alter'): string => {
    const parts: string[] = [];
    if (mode === 'create') parts.push(`AS ${SEQ_TYPE_SQL[o.type]}`);
    const [tmin, tmax] = SEQ_DEFAULT_BOUNDS[o.type];
    const asc = !o.increment.startsWith('-');
    const effMin = o.min ?? tmin;
    const effMax = o.max ?? tmax;
    const effStart = o.start ?? (asc ? effMin : effMax);
    if (mode === 'create') {
      parts.push(`START WITH ${effStart}`);
    } else if (o.start !== null) {
      parts.push(`RESTART WITH ${o.start}`);
    }
    parts.push(`INCREMENT BY ${o.increment}`);
    parts.push(o.min === null ? 'NO MINVALUE' : `MINVALUE ${o.min}`);
    parts.push(o.max === null ? 'NO MAXVALUE' : `MAXVALUE ${o.max}`);
    parts.push(o.cycle ? 'CYCLE' : 'NO CYCLE');
    parts.push(o.cache === '0' ? 'NO CACHE' : `CACHE ${o.cache}`);
    return parts.join(' ');
  };

  const constraintDef = (k: PrimaryKey | Unique | Check | ForeignKey, targetModel: Model): string => {
    switch (k.kind) {
      case 'primaryKey': {
        const cl = isMssqlPkClustered(targetModel, k) ? 'CLUSTERED' : 'NONCLUSTERED';
        return `PRIMARY KEY ${cl} (${cols(k.columns)})`;
      }
      case 'unique': {
        const cl = k.ext?.mssql?.clustered ? 'CLUSTERED' : 'NONCLUSTERED';
        return `UNIQUE ${cl} (${cols(k.columns)})`;
      }
      case 'check':
        return `CHECK (${k.expr})`;
      case 'foreignKey': {
        let s = `FOREIGN KEY (${cols(k.columns)}) REFERENCES ${T(k.refTable)} (${cols(k.refColumns)})`;
        if (k.onDelete !== 'noAction' && k.onDelete !== 'restrict')
          s += ` ON DELETE ${FK_ACTION[k.onDelete]}`;
        if (k.onUpdate !== 'noAction' && k.onUpdate !== 'restrict')
          s += ` ON UPDATE ${FK_ACTION[k.onUpdate]}`;
        return s;
      }
    }
  };

  const indexDef = (x: Index): string => {
    const els = x.elements
      .map((e) => {
        if (!e.column) {
          throw new PlanError(`索引 ${x.name} 使用了表达式键，SQL Server 请改用计算列建索引`);
        }
        return `${C(e.column)}${e.desc ? ' DESC' : ''}`;
      })
      .join(', ');
    const cl = x.ext?.mssql?.clustered ? 'CLUSTERED' : 'NONCLUSTERED';
    let s = `CREATE ${x.unique ? 'UNIQUE ' : ''}${cl} INDEX ${mssqlIdent(x.name)} ON ${T(x.parent)} (${els})`;
    if (x.include.length) s += ` INCLUDE (${cols(x.include)})`;
    if (x.where) s += ` WHERE ${x.where}`;
    if (x.ext?.mssql?.fillFactor !== undefined) s += ` WITH (FILLFACTOR = ${x.ext.mssql.fillFactor})`;
    return s;
  };

  // ───── 预分析：列修改、计算列重建、序列重建、依赖拆除集合 ─────
  const colAltered = new Set<string>();
  const rowguidChanged = new Set<string>();
  for (const o of common) {
    if (o.kind !== 'column') continue;
    const w = was(o);
    if (o.generated || w.generated) continue;
    const oldNorm = [mssqlNormalizeType(w.type), w.collation, w.notNull, Boolean(w.ext?.mssql?.sparse)];
    const newNorm = [mssqlNormalizeType(o.type), o.collation, o.notNull, Boolean(o.ext?.mssql?.sparse)];
    if (!same(oldNorm, newNorm)) colAltered.add(o.id);
    if (Boolean(w.ext?.mssql?.rowguidcol) !== Boolean(o.ext?.mssql?.rowguidcol)) rowguidChanged.add(o.id);
  }

  const exprTouches = (expr: string | null | undefined, colIds: Iterable<string>): boolean => {
    if (!expr) return false;
    const ids = exprIdentsLower(expr);
    for (const cid of colIds) {
      const fn = find(from, cid)?.name;
      const tn = find(to, cid)?.name;
      if ((fn && ids.has(fn.toLowerCase())) || (tn && ids.has(tn.toLowerCase()))) return true;
    }
    return false;
  };

  const colsOfTableIn = (tableId: string, set: Set<string>): string[] =>
    [...set].filter((cid) => {
      const c = find(to, cid) ?? find(from, cid);
      return c?.kind === 'column' && c.parent === tableId;
    });

  // 计算列（generated）：定义变了、或引用的列改了类型/可空性/改名 → 先删后建（计算列不存用户输入数据）
  const regen = new Set<string>();
  for (const o of common) {
    if (o.kind !== 'column') continue;
    const w = was(o);
    if (!o.generated && !w.generated) continue;
    const oldGen = w.generated ? { ...w.generated, expr: migrateExpr(w.generated.expr, o.parent) } : null;
    const refsRenamed = w.generated && exprTouches(w.generated.expr, colsOfTableIn(o.parent, renamedColIds));
    const refsAltered =
      (o.generated && exprTouches(o.generated.expr, colsOfTableIn(o.parent, colAltered))) ||
      (w.generated && exprTouches(w.generated.expr, colsOfTableIn(o.parent, colAltered)));
    if (
      !same(o.generated, oldGen) ||
      o.notNull !== w.notNull ||
      refsRenamed ||
      refsAltered ||
      Boolean(o.generated) !== Boolean(w.generated)
    ) {
      regen.add(o.id);
    }
  }
  // 计算列级联（虽然 SQL Server 不允许计算列引用计算列，仍做防御闭环）
  for (let changed = true; changed;) {
    changed = false;
    for (const o of common) {
      if (o.kind !== 'column' || !o.generated || regen.has(o.id)) continue;
      if (exprTouches(o.generated.expr, colsOfTableIn(o.parent, regen))) {
        regen.add(o.id);
        changed = true;
      }
    }
  }
  for (const id of regen) colAltered.delete(id);

  // 序列类型变化需要重建（SQL Server 不允许 ALTER SEQUENCE 改数据类型）
  const seqRebuild = new Set<string>();
  for (const o of common) {
    if (o.kind !== 'sequence') continue;
    const w = was(o);
    if (w.options.type !== o.options.type) seqRebuild.add(o.id);
  }

  const usesCols = (o: Obj, set: Set<string>): boolean => {
    switch (o.kind) {
      case 'primaryKey':
      case 'unique':
        return o.columns.some((c) => set.has(c));
      case 'foreignKey':
        return o.columns.some((c) => set.has(c)) || o.refColumns.some((c) => set.has(c));
      case 'check':
        return exprTouches(o.expr, colsOfTableIn(o.parent, set));
      case 'index':
        return (
          o.elements.some((e) =>
            e.column ? set.has(e.column) : exprTouches(e.expr, colsOfTableIn(o.parent, set)),
          ) ||
          o.include.some((c) => set.has(c)) ||
          exprTouches(o.where, colsOfTableIn(o.parent, set))
        );
      default:
        return false;
    }
  };

  // 判断哪些 PK/UQ/CHECK/INDEX/FK 需要拆除重建
  const isKey = (o: Obj): o is PrimaryKey | Unique | Check | Index =>
    o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'index';
  const rebuild = new Set<string>();

  for (const o of common) {
    if (!isKey(o)) continue;
    const w = was(o);
    // SQL Server sp_rename 改列名时不允许被 CHECK 或过滤索引引用，故先删后建
    const exprBlockedByRename =
      (w.kind === 'check' && exprTouches(w.expr, colsOfTableIn(o.parent, renamedColIds))) ||
      (w.kind === 'index' && !!w.where && exprTouches(w.where, colsOfTableIn(o.parent, renamedColIds)));
    if (
      !same(definition(o, to), definition(w, from)) ||
      usesCols(w, colAltered) ||
      usesCols(w, regen) ||
      exprBlockedByRename
    ) {
      rebuild.add(o.id);
    }
  }

  // 如果某张表上发生了 CLUSTERED 归属切换，确保旧 CLUSTERED 对象先删
  for (const t of all(to, 'table')) {
    if (!inFrom(t.id)) continue;
    const oldClustered = [
      ...childrenOf(from, t.id, 'primaryKey'),
      ...childrenOf(from, t.id, 'unique'),
      ...childrenOf(from, t.id, 'index'),
    ].find((k) => isKeyOrIndexClustered(from, k));
    const newClustered = [
      ...childrenOf(to, t.id, 'primaryKey'),
      ...childrenOf(to, t.id, 'unique'),
      ...childrenOf(to, t.id, 'index'),
    ].find((k) => isKeyOrIndexClustered(to, k));
    if (oldClustered && (!newClustered || oldClustered.id !== newClustered.id)) {
      if (inTo(oldClustered.id)) rebuild.add(oldClustered.id);
    }
  }

  const refKeyGone = (refTable: string): boolean =>
    Object.values(from.objects).some(
      (k) =>
        (k.kind === 'primaryKey' || k.kind === 'unique' || (k.kind === 'index' && k.unique)) &&
        k.parent === refTable &&
        (isRemoved(k.id) || rebuild.has(k.id)),
    );

  for (const o of common) {
    if (o.kind !== 'foreignKey') continue;
    const w = was(o);
    if (
      !same(definition(o, to), definition(w, from)) ||
      usesCols(w, colAltered) ||
      usesCols(w, regen) ||
      refKeyGone(w.refTable)
    ) {
      rebuild.add(o.id);
    }
  }

  // ───── 不透明对象拓扑与重建分析 ─────
  const lateMemo = new Map<string, boolean>();
  const isLate = (o: Opaque): boolean => {
    const m = inTo(o.id) && to.objects[o.id] === o ? to : from;
    const k = `${m === to ? 't' : 'f'}:${o.id}`;
    const hit = lateMemo.get(k);
    if (hit !== undefined) return hit;
    lateMemo.set(k, false);
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
    common
      .filter((o) => o.kind === 'opaque' && !same(definition(o, to), definition(was(o), from)))
      .map((o) => o.id),
  );
  const unstable = new Set<string>([
    ...removed.map((o) => o.id),
    ...rebuild,
    ...colAltered,
    ...regen,
    ...seqRebuild,
    ...renamedColIds,
    ...opaqueChanged,
    ...common
      .filter((o) => (o.kind === 'table' || o.kind === 'schema') && o.name !== was(o).name)
      .map((o) => o.id),
  ]);
  const lateRebuild = new Set([...opaqueChanged].filter((id) => isLate(from.objects[id] as Opaque)));
  for (let changed = true; changed;) {
    changed = false;
    for (const o of all(from, 'opaque')) {
      if (!isLate(o) || !inTo(o.id) || lateRebuild.has(o.id)) continue;
      if (o.deps.some((d) => unstable.has(d)) || unstable.has(o.parent)) {
        lateRebuild.add(o.id);
        unstable.add(o.id);
        changed = true;
      }
    }
  }

  const topo = (objs: Opaque[]): Opaque[] => {
    const ids = new Set(objs.map((o) => o.id));
    const done = new Set<string>();
    const rest = [...objs].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
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

  const tableRemoved = (o: { parent: string }) => isRemoved(o.parent);
  let tmp = 0;

  // ───── P0 删晚期不透明对象（视图、触发器等） ─────
  const lateDrops = all(from, 'opaque').filter(
    (o) => isLate(o) && (isRemoved(o.id) || lateRebuild.has(o.id)),
  );
  for (const o of topo(lateDrops).reverse()) dropOpaque(o);

  // ───── P1 删外键（被删除或需重建的） ─────
  for (const o of Object.values(cur.objects)) {
    if (o.kind !== 'foreignKey') continue;
    if (!isRemoved(o.id) && !rebuild.has(o.id)) continue;
    emit('dropForeignKey', o.id, `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${mssqlIdent(o.name)}`);
    delete cur.objects[o.id];
  }

  // ───── P2 删其他约束和索引（所在表将删的跳过，DROP TABLE 会一并清理） ─────
  for (const o of Object.values(cur.objects)) {
    if (!isKey(o) || tableRemoved(o)) continue;
    if (!isRemoved(o.id) && !rebuild.has(o.id)) continue;
    if (o.kind === 'index') {
      emit('dropIndex', o.id, `DROP INDEX ${mssqlIdent(o.name)} ON ${T(o.parent)}`);
    } else {
      emit(
        `drop${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}`,
        o.id,
        `ALTER TABLE ${T(o.parent)} DROP CONSTRAINT ${mssqlIdent(o.name)}`,
      );
    }
    delete cur.objects[o.id];
  }

  // ───── P2b 提前拆除受影响列上的带名 DEFAULT 约束（删列、改列、换默认值、引用待重建序列、列转计算列前必须先删 DF） ─────
  const dropDefaultOnCur = (c: Column) => {
    if (!c.default) return;
    const t = tableOf(c.parent);
    const dfName = mssqlDefaultNameOf(c, t.name);
    emit('dropDefault', c.id, `ALTER TABLE ${T(c.parent)} DROP CONSTRAINT ${mssqlIdent(dfName)}`);
    c.default = null;
    if (c.ext?.mssql) {
      delete c.ext.mssql.defaultName;
      delete c.ext.mssql.defaultNameMode;
    }
  };

  for (const c of all(cur, 'column')) {
    if (!c.default || tableRemoved(c)) continue;
    const target = inTo(c.id) ? (to.objects[c.id] as Column) : null;
    const refsSeqRebuild =
      'nextval' in c.default && (seqRebuild.has(c.default.nextval) || isRemoved(c.default.nextval));
    const defaultValueChanged =
      !target ||
      !target.default ||
      'nextval' in c.default !== 'nextval' in target.default ||
      ('nextval' in c.default &&
        'nextval' in target.default &&
        c.default.nextval !== target.default.nextval) ||
      ('expr' in c.default && 'expr' in target.default && c.default.expr !== target.default.expr);

    if (isRemoved(c.id) || colAltered.has(c.id) || regen.has(c.id) || refsSeqRebuild || defaultValueChanged) {
      dropDefaultOnCur(c);
    }
  }

  // ───── P3 删需重建的计算列 ─────
  for (const id of regen) {
    const c = get(cur, id, 'column');
    emit('dropColumn', id, `ALTER TABLE ${T(c.parent)} DROP COLUMN ${mssqlIdent(c.name)}`);
    delete cur.objects[id];
  }

  // ───── P4 删表 ─────
  for (const o of removed) {
    if (o.kind !== 'table' || !(o.id in cur.objects)) continue;
    emit('dropTable', o.id, `DROP TABLE ${T(o.id)}`);
    for (const k of Object.values(cur.objects)) {
      if ('parent' in k && k.parent === o.id) delete cur.objects[k.id];
    }
    delete cur.objects[o.id];
  }

  // ───── P5 删列（计算列先删，普通列后删） ─────
  const colsToDrop = removed
    .filter((o): o is Column => o.kind === 'column' && o.id in cur.objects)
    .sort((x, y) => (x.generated ? 0 : 1) - (y.generated ? 0 : 1));
  for (const o of colsToDrop) {
    const c = get(cur, o.id, 'column');
    if (c.default) dropDefaultOnCur(c);
    emit('dropColumn', o.id, `ALTER TABLE ${T(c.parent)} DROP COLUMN ${mssqlIdent(c.name)}`);
    delete cur.objects[o.id];
  }

  // ───── P5c 删除需要改类型重建的序列（新序列在 P9 重建） ─────
  for (const id of seqRebuild) {
    get(cur, id, 'sequence');
    emit('dropSequence', id, `DROP SEQUENCE ${S(id)}`);
    delete cur.objects[id];
  }

  // ───── P6a 建新增 schema（含用于 schema 改名与跨 schema 迁移的目标 schema） ─────
  const createdSchemas = new Set<string>();
  const ensureSchemaCreated = (name: string, targetId: string) => {
    const low = name.toLowerCase();
    if (low === 'dbo' || createdSchemas.has(low)) return;
    const existsInCur = all(cur, 'schema').some((s) => s.name.toLowerCase() === low);
    if (!existsInCur) {
      emit('createSchema', targetId, `CREATE SCHEMA ${mssqlIdent(name)}`);
      createdSchemas.add(low);
    }
  };

  for (const o of added) {
    if (o.kind !== 'schema') continue;
    ensureSchemaCreated(o.name, o.id);
    cur.objects[o.id] = fresh(o);
  }

  // ───── P6b Schema 改名（MSSQL 无 ALTER SCHEMA RENAME → 建新 schema + TRANSFER 对象 + 删旧 schema） ─────
  const renamedSchemas = common.filter((o): o is Schema => o.kind === 'schema' && o.name !== was(o).name);
  if (renamedSchemas.length > 0) {
    // 收集需要改名的旧 schema 名字集合，解决 A->B / B->A 互换或与待删 schema 重名
    const oldSchemaById = new Map<string, string>();
    for (const s of renamedSchemas) {
      const c = get(cur, s.id, 'schema');
      oldSchemaById.set(s.id, c.name);
    }
    // 对被其他旧 schema 占用的目标名，先经由临时 schema 中转
    const pendingTransfers: { schemaId: string; fromName: string; toName: string }[] = [];
    const curSchemaNamesLower = () => new Set(all(cur, 'schema').map((s) => s.name.toLowerCase()));

    for (const s of renamedSchemas) {
      const c = get(cur, s.id, 'schema');
      if (curSchemaNamesLower().has(s.name.toLowerCase())) {
        const tmpSch = `_dowel_tmp_sch_${++tmp}`;
        ensureSchemaCreated(tmpSch, s.id);
        for (const obj of Object.values(cur.objects)) {
          if ((obj.kind === 'table' || obj.kind === 'sequence') && obj.parent === s.id) {
            emit(
              'transferSchema',
              obj.id,
              `ALTER SCHEMA ${mssqlIdent(tmpSch)} TRANSFER ${mssqlQualified(c.name, obj.name)}`,
            );
          }
        }
        if (c.name.toLowerCase() !== 'dbo') {
          emit('dropSchema', s.id, `DROP SCHEMA ${mssqlIdent(c.name)}`);
        }
        c.name = tmpSch;
        c.comment = null;
      }
      pendingTransfers.push({ schemaId: s.id, fromName: c.name, toName: s.name });
    }

    for (const tr of pendingTransfers) {
      const c = get(cur, tr.schemaId, 'schema');
      if (c.name === tr.toName) continue;
      ensureSchemaCreated(tr.toName, tr.schemaId);
      for (const obj of Object.values(cur.objects)) {
        if ((obj.kind === 'table' || obj.kind === 'sequence') && obj.parent === tr.schemaId) {
          emit(
            'transferSchema',
            obj.id,
            `ALTER SCHEMA ${mssqlIdent(tr.toName)} TRANSFER ${mssqlQualified(c.name, obj.name)}`,
          );
        }
      }
      if (c.name.toLowerCase() !== 'dbo') {
        emit('dropSchema', tr.schemaId, `DROP SCHEMA ${mssqlIdent(c.name)}`);
      }
      c.name = tr.toName;
      c.comment = null;
    }
  }

  // ───── P6c 跨 schema 迁移表或序列（ALTER SCHEMA [new] TRANSFER [old].[obj]） ─────
  for (const o of common) {
    if (o.kind !== 'table' && o.kind !== 'sequence') continue;
    const c = cur.objects[o.id];
    if (!c || (c.kind !== 'table' && c.kind !== 'sequence')) continue;
    if (c.parent === o.parent) continue;
    const oldSch = schemaOf(c.parent);
    const newSch = schemaOf(o.parent);
    emit(
      'transferSchema',
      o.id,
      `ALTER SCHEMA ${mssqlIdent(newSch)} TRANSFER ${mssqlQualified(oldSch, c.name)}`,
    );
    c.parent = o.parent;
  }

  // ───── P6d 对象/列/约束/索引/默认约束改名（sp_rename + 两阶段临时名防冲突） ─────
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
      case 'table':
      case 'sequence':
        return [`obj:${o.parent}`];
      case 'primaryKey':
      case 'unique':
        return [`obj:${schemaOfTable(o.parent)}`, `idx:${o.parent}`];
      case 'foreignKey':
      case 'check':
        return [`obj:${schemaOfTable(o.parent)}`];
      case 'index':
        return [`idx:${o.parent}`];
      case 'column':
        return [`col:${o.parent}`];
      case 'opaque':
        return [`obj:${o.parent}`];
      default:
        return [];
    }
  };

  const renameSql = (o: Obj, newName: string): string => {
    switch (o.kind) {
      case 'table':
        return spRename(T(o.id), newName, 'OBJECT');
      case 'sequence':
        return spRename(S(o.id), newName, 'OBJECT');
      case 'column':
        return spRename(`${T(o.parent)}.${mssqlIdent(o.name)}`, newName, 'COLUMN');
      case 'index':
        return spRename(`${T(o.parent)}.${mssqlIdent(o.name)}`, newName, 'INDEX');
      case 'primaryKey':
      case 'unique':
      case 'foreignKey':
      case 'check':
        return spRename(mssqlQualified(schemaOf(schemaOfTable(o.parent)), o.name), newName, 'OBJECT');
      default:
        throw new PlanError(`不支持使用 sp_rename 改名对象种类：${o.kind}`);
    }
  };

  for (const o of common) {
    const c = cur.objects[o.id];
    if (!c || c.kind === 'schema' || c.kind === 'opaque' || c.kind === 'extension') continue;
    if (c.name !== o.name) {
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
    // 保留的带名默认约束仅改名时（默认值表达式与列类型未变，P2b 未拆除）
    if (o.kind === 'column' && c.kind === 'column' && c.default && o.default) {
      const curDf = mssqlDefaultNameOf(c, tableOf(c.parent).name);
      const tgtDf = mssqlDefaultNameOf(o, get(to, o.parent, 'table').name);
      if (curDf !== tgtDf) {
        items.push({
          id: `${o.id}#df`,
          spaces: [`obj:${schemaOfTable(o.parent)}`],
          target: tgtDf,
          rename: (n) => {
            const curCol = get(cur, o.id, 'column');
            const oldDf = mssqlDefaultNameOf(curCol, tableOf(curCol.parent).name);
            return spRename(mssqlQualified(schemaOf(schemaOfTable(curCol.parent)), oldDf), n, 'OBJECT');
          },
          apply: (n) => {
            const curCol = get(cur, o.id, 'column');
            curCol.ext = { ...curCol.ext, mssql: { ...curCol.ext?.mssql, defaultName: n } };
          },
        });
      }
    }
  }

  // 待后续 P14 删除的序列如果占着目标新名，先临时改名让位
  const toNamesLower = new Set<string>();
  for (const o of Object.values(to.objects)) {
    if (o.kind === 'table' || o.kind === 'sequence') {
      toNamesLower.add(`obj:${o.parent}\0${o.name.toLowerCase()}`);
    } else if (
      o.kind === 'primaryKey' ||
      o.kind === 'unique' ||
      o.kind === 'foreignKey' ||
      o.kind === 'check'
    ) {
      const sch = get(to, o.parent, 'table').parent;
      toNamesLower.add(`obj:${sch}\0${o.name.toLowerCase()}`);
    } else if (o.kind === 'column' && o.default) {
      const tbl = get(to, o.parent, 'table');
      toNamesLower.add(`obj:${tbl.parent}\0${mssqlDefaultNameOf(o, tbl.name).toLowerCase()}`);
    }
  }
  for (const o of removed) {
    const c = cur.objects[o.id];
    if (!c || c.kind !== 'sequence') continue;
    if (toNamesLower.has(`obj:${c.parent}\0${c.name.toLowerCase()}`)) {
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

  const occupant = (space: string, name: string): string | undefined => {
    const low = name.toLowerCase();
    for (const o of Object.values(cur.objects)) {
      if (o.name.toLowerCase() === low && spacesOf(o).includes(space)) return o.id;
      if (o.kind === 'column' && o.default && space === `obj:${schemaOfTable(o.parent)}`) {
        const df = mssqlDefaultNameOf(o, tableOf(o.parent).name);
        if (df.toLowerCase() === low) return `${o.id}#df`;
      }
    }
    return undefined;
  };

  const byId = new Map(items.map((it) => [it.id, it]));
  const toTemp = (it: Renamable) => {
    const n = `_dowel_tmp_${++tmp}`;
    emit('rename', it.id, it.rename(n));
    it.apply(n);
  };

  for (const it of items) if (!it.target) toTemp(it);
  for (let changed = true; changed;) {
    changed = false;
    for (const it of items) {
      if (!it.target) continue;
      for (const sp of it.spaces) {
        const occ = occupant(sp, it.target);
        if (occ && occ !== it.id) {
          const blocker = byId.get(occ);
          if (!blocker) throw new PlanError(`名字 ${it.target} 已被占用，无法改名`);
          if (blocker.target.toLowerCase() === it.target.toLowerCase()) {
            throw new PlanError(`名字冲突：${it.target}`);
          }
          toTemp(blocker);
          changed = true;
        }
      }
    }
  }
  for (const it of items) {
    if (!it.target) continue;
    // 纯大小写变更在 CI 排序规则下也要安全完成：若当前名与目标名仅大小写不同，先转临时名再改回
    const curObj = it.id.endsWith('#df') ? null : cur.objects[it.id];
    const curName = curObj
      ? curObj.name
      : mssqlDefaultNameOf(
          get(cur, it.id.slice(0, -3), 'column'),
          tableOf(get(cur, it.id.slice(0, -3), 'column').parent).name,
        );
    if (curName === it.target) continue;
    if (curName.toLowerCase() === it.target.toLowerCase()) toTemp(it);
    emit('rename', it.id, it.rename(it.target));
    it.apply(it.target);
  }

  // ───── P8b 早期不透明对象（函数、存储过程等无表依赖对象） ─────
  const earlyCreates = all(to, 'opaque').filter(
    (o) => !isLate(o) && (!inFrom(o.id) || opaqueChanged.has(o.id)),
  );
  for (const o of topo(earlyCreates)) {
    if (inFrom(o.id) && o.id in cur.objects) dropOpaque(get(cur, o.id, 'opaque'));
    createOpaque(o);
  }

  // ───── P9 建序列、改序列选项 ─────
  for (const o of [...added, ...common]) {
    if (o.kind !== 'sequence') continue;
    if (!(o.id in cur.objects)) {
      cur.objects[o.id] = fresh(o);
      emit('createSequence', o.id, `CREATE SEQUENCE ${S(o.id)} ${seqOptionsSql(o.options, 'create')}`);
    } else {
      const c = get(cur, o.id, 'sequence');
      if (!same(c.options, o.options)) {
        emit('alterSequence', o.id, `ALTER SEQUENCE ${S(o.id)} ${seqOptionsSql(o.options, 'alter')}`);
        c.options = clone(o.options);
      }
    }
  }

  // ───── P10 建表（内联全部列与带名 DEFAULT 约束；PK/UQ/CK/IX/FK 在 P15/P16 添加） ─────
  for (const o of added) {
    if (o.kind !== 'table') continue;
    cur.objects[o.id] = fresh(o);
    const tableCols = columnsOf(to, o.id);
    for (const c of tableCols) {
      const fc = fresh(c);
      if (fc.default) {
        fc.ext = {
          ...fc.ext,
          mssql: {
            ...fc.ext?.mssql,
            defaultName: mssqlDefaultNameOf(fc, o.name),
            defaultNameMode: fc.ext?.mssql?.defaultNameMode ?? 'derived',
          },
        };
      }
      cur.objects[c.id] = fc;
    }
    const body = tableCols.map((c) => columnDef(c, o)).join(',\n  ');
    emit('createTable', o.id, `CREATE TABLE ${T(o.id)} (\n  ${body}\n)`);
  }

  // ───── P11 加普通列（新增计算列延后到 P12g，在普通列改完之后添加） ─────
  const emitAddColumn = (c: Column) => {
    const tbl = tableOf(c.parent);
    const fc = fresh(c);
    if (fc.default) {
      fc.ext = {
        ...fc.ext,
        mssql: {
          ...fc.ext?.mssql,
          defaultName: mssqlDefaultNameOf(fc, tbl.name),
          defaultNameMode: fc.ext?.mssql?.defaultNameMode ?? 'derived',
        },
      };
    }
    cur.objects[c.id] = fc;
    emit('addColumn', c.id, `ALTER TABLE ${T(c.parent)} ADD ${columnDef(fc, tbl)}`);
  };

  for (const c of added) {
    if (c.kind !== 'column' || c.id in cur.objects || c.generated) continue;
    emitAddColumn(c);
  }

  // ───── P12 改列（类型 / NOT NULL / COLLATE / SPARSE / ROWGUIDCOL / 重建带名 DEFAULT 约束） ─────
  const alteredCols = common.filter((o): o is Column => o.kind === 'column' && !regen.has(o.id));
  for (const o of alteredCols) {
    const c = get(cur, o.id, 'column');
    if (colAltered.has(o.id)) {
      const parts: string[] = [typeClause(o)];
      if (o.ext?.mssql?.sparse) parts.push('SPARSE');
      parts.push(o.notNull ? 'NOT NULL' : 'NULL');
      emit('alterColumn', o.id, `ALTER TABLE ${T(c.parent)} ALTER COLUMN ${C(c.id)} ${parts.join(' ')}`);
      c.type = o.type;
      c.collation = o.collation;
      c.notNull = o.notNull;
      if (o.ext?.mssql?.sparse) {
        c.ext = { ...c.ext, mssql: { ...c.ext?.mssql, sparse: true } };
      } else if (c.ext?.mssql) {
        delete c.ext.mssql.sparse;
      }
    }
    if (rowguidChanged.has(o.id)) {
      const addRg = Boolean(o.ext?.mssql?.rowguidcol);
      emit(
        'alterColumn',
        o.id,
        `ALTER TABLE ${T(c.parent)} ALTER COLUMN ${C(c.id)} ${addRg ? 'ADD' : 'DROP'} ROWGUIDCOL`,
      );
      if (addRg) c.ext = { ...c.ext, mssql: { ...c.ext?.mssql, rowguidcol: true } };
      else if (c.ext?.mssql) delete c.ext.mssql.rowguidcol;
    }
  }

  // P12e 重建或新增带名 DEFAULT 约束
  for (const o of alteredCols) {
    const c = get(cur, o.id, 'column');
    if (!o.default || c.default) continue;
    const tbl = tableOf(c.parent);
    const dfName = mssqlDefaultNameOf(o, tbl.name);
    c.default = clone(o.default);
    c.ext = {
      ...c.ext,
      mssql: {
        ...c.ext?.mssql,
        defaultName: dfName,
        defaultNameMode: o.ext?.mssql?.defaultNameMode ?? 'derived',
      },
    };
    const defSql = defaultExprOf(c)!;
    emit(
      'setDefault',
      o.id,
      `ALTER TABLE ${T(c.parent)} ADD CONSTRAINT ${mssqlIdent(dfName)} DEFAULT ${defSql} FOR ${C(c.id)}`,
    );
  }

  for (const o of alteredCols) {
    const c = get(cur, o.id, 'column');
    c.pos = o.pos;
  }

  // P12g 添加新增或需重建的计算列
  for (const c of [...added, ...[...regen].map((id) => to.objects[id]!)]) {
    if (c.kind !== 'column' || c.id in cur.objects) continue;
    emitAddColumn(c);
  }

  // ───── P14 删早期不透明对象、序列、用户 schema ─────
  const earlyDrops = all(from, 'opaque').filter((o) => !isLate(o) && isRemoved(o.id) && o.id in cur.objects);
  for (const o of topo(earlyDrops).reverse()) dropOpaque(get(cur, o.id, 'opaque'));

  for (const o of removed) {
    if (o.kind !== 'sequence' || !(o.id in cur.objects)) continue;
    emit('dropSequence', o.id, `DROP SEQUENCE ${S(o.id)}`);
    delete cur.objects[o.id];
  }

  for (const o of removed) {
    if (o.kind !== 'schema' || !(o.id in cur.objects)) continue;
    const c = get(cur, o.id, 'schema');
    if (c.name.toLowerCase() !== 'dbo') {
      emit('dropSchema', o.id, `DROP SCHEMA ${mssqlIdent(c.name)}`);
    }
    delete cur.objects[o.id];
  }

  // ───── P15 加主键、唯一约束、CHECK 与索引（每表 CLUSTERED 优先于 NONCLUSTERED） ─────
  const pendingKeys: (PrimaryKey | Unique | Check | Index)[] = [];
  for (const o of Object.values(to.objects)) {
    if (isKey(o) && !(o.id in cur.objects)) pendingKeys.push(o);
  }
  const keyOrder = (o: PrimaryKey | Unique | Check | Index): number => {
    const cl = o.kind !== 'check' && isKeyOrIndexClustered(to, o) ? 0 : 10;
    const kindRank = o.kind === 'primaryKey' ? 1 : o.kind === 'unique' ? 2 : o.kind === 'index' ? 3 : 4;
    return cl + kindRank;
  };
  pendingKeys.sort((a, b) => keyOrder(a) - keyOrder(b) || a.name.localeCompare(b.name));

  for (const o of pendingKeys) {
    cur.objects[o.id] = fresh(o);
    if (o.kind === 'index') {
      emit('createIndex', o.id, indexDef(o));
    } else {
      emit(
        `add${o.kind[0]!.toUpperCase()}${o.kind.slice(1)}`,
        o.id,
        `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${mssqlIdent(o.name)} ${constraintDef(o, to)}`,
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
      `ALTER TABLE ${T(o.parent)} ADD CONSTRAINT ${mssqlIdent(o.name)} ${constraintDef(o, to)}`,
    );
  }

  // ───── P16b 建晚期不透明对象（视图、触发器等） ─────
  const lateCreates = all(to, 'opaque').filter((o) => isLate(o) && !(o.id in cur.objects));
  for (const o of topo(lateCreates)) createOpaque(o);

  // ───── P17 对象注释（MS_Description 扩展属性）与终态自检 ─────
  const commentLevels = (o: Obj): { type: string; name: string }[] | null => {
    switch (o.kind) {
      case 'schema':
        return [{ type: 'SCHEMA', name: o.name }];
      case 'table':
        return [
          { type: 'SCHEMA', name: schemaOf(o.parent) },
          { type: 'TABLE', name: o.name },
        ];
      case 'sequence':
        return [
          { type: 'SCHEMA', name: schemaOf(o.parent) },
          { type: 'SEQUENCE', name: o.name },
        ];
      case 'column': {
        const tbl = tableOf(o.parent);
        return [
          { type: 'SCHEMA', name: schemaOf(tbl.parent) },
          { type: 'TABLE', name: tbl.name },
          { type: 'COLUMN', name: o.name },
        ];
      }
      case 'index': {
        const tbl = tableOf(o.parent);
        return [
          { type: 'SCHEMA', name: schemaOf(tbl.parent) },
          { type: 'TABLE', name: tbl.name },
          { type: 'INDEX', name: o.name },
        ];
      }
      case 'primaryKey':
      case 'unique':
      case 'foreignKey':
      case 'check': {
        const tbl = tableOf(o.parent);
        return [
          { type: 'SCHEMA', name: schemaOf(tbl.parent) },
          { type: 'TABLE', name: tbl.name },
          { type: 'CONSTRAINT', name: o.name },
        ];
      }
      default:
        return null;
    }
  };

  for (const o of Object.values(to.objects)) {
    const c = cur.objects[o.id];
    if (!c) throw new PlanError(`内部错误：MSSQL 规划结束时缺少对象 ${o.kind} ${o.name}`);
    if (c.name !== o.name || !same(definition(c, cur), definition(o, to))) {
      throw new PlanError(`内部错误：MSSQL 规划结束时 ${o.kind} ${o.name} 与目标不一致`);
    }
    const prevComment = c.comment ?? null;
    const nextComment = o.comment ?? null;
    if (prevComment !== nextComment && o.kind !== 'opaque') {
      const levels = commentLevels(o);
      if (levels) {
        const action = prevComment === null ? 'add' : nextComment === null ? 'drop' : 'update';
        emit('comment', o.id, extendedPropSql(action, nextComment, levels));
      }
    }
    cur.objects[o.id] = clone(o);
  }

  for (const id of Object.keys(cur.objects)) {
    if (!inTo(id)) throw new PlanError(`内部错误：MSSQL 规划结束时多出对象 ${id}`);
  }
  return steps;
};

/** 从空模型建出完整 MSSQL 模型（保留内置 dbo schema，不生成 CREATE SCHEMA [dbo]） */
export const mssqlCreateAll = (m: Model, opts?: MssqlPlanOptions): Step[] =>
  mssqlPlan({ ...m, objects: {} }, m, opts);
