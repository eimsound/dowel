// MySQL 8.4 / 9.7 迁移规划器：
// - 完整 MODIFY COLUMN 定义渲染（绝不遗漏 NOT NULL / DEFAULT / AUTO_INCREMENT / ON UPDATE / UNSIGNED / CHARSET / COLLATE / COMMENT）
// - AUTO_INCREMENT 键依赖与单列约束安全编排
// - InnoDB 外键隐式辅助索引确定性闭环管理
// - 外键拓扑与循环外键解耦、不透明对象（视图/触发器/函数/存储过程）拓扑删建
// - MySQL 8.4 vs 9.0+ VECTOR 版本能力检查
import type { Check, Column, ForeignKey, Index, Model, Opaque, PrimaryKey, Table, Unique } from '../ir.ts';
import { EARLY_OPAQUE } from '../ir.ts';
import { deepEqual } from '../json.ts';
import { all, childrenOf, columnsOf, get } from '../model.ts';
import type { PlanOptions } from '../pg/capabilities.ts';
import { PlanError, type Step } from '../plan-types.ts';
import { mysqlExprReferences, mysqlIdent, mysqlLiteral, mysqlRenameInExpr, mysqlTokenize } from './quote.ts';
import {
  isMysqlExprOnlyDefaultType,
  isMysqlVectorType,
  mysqlTemporalPrecision,
  splitMysqlTypeModifiers,
} from './types.ts';

export interface MysqlPlanOptions extends PlanOptions {
  /** 目标 MySQL 数值版本号（如 80400 = 8.4.0、90700 = 9.7.0） */
  mysqlVersionNum?: number | null;
}

const same = deepEqual;

const FK_ACTION: Record<ForeignKey['onDelete'], string> = {
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

/** 判断字符串是否已由一对最外层平衡括号包裹（注意区分 `(a) OR (b)`） */
const isOuterParenthesized = (t: string): boolean => {
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quote) {
      if (ch === '\\' && quote !== '`') {
        i++;
      } else if (ch === quote) {
        if (t[i + 1] === quote) i++;
        else quote = null;
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && i < t.length - 1) return false;
    }
  }
  return depth === 0;
};

/** 判断表达式是否是 MySQL 允许在普通列上不带括号直接写的字面量/时间默认值 */
const isBareMysqlDefault = (expr: string): boolean => {
  const t = expr.trim();
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return true;
  if (/^'(?:\\.|''|[^'\\])*'$/.test(t)) return true;
  if (/^[xXbB]'[0-9a-fA-F]*'$/.test(t)) return true;
  if (/^(?:null|true|false)$/i.test(t)) return true;
  if (/^current_timestamp(?:\(\d+\))?$/i.test(t)) return true;
  return false;
};

export const formatMysqlDefault = (expr: string, colType: string): string => {
  const t = expr.trim();
  if (/^null$/i.test(t)) return 'NULL';
  if (isOuterParenthesized(t)) return t;
  if (isMysqlExprOnlyDefaultType(colType)) return `(${t})`;
  return isBareMysqlDefault(t) ? t : `(${t})`;
};

/** 规范化列的类型字符串与 unsigned/zerofill 标记 */
const effectiveColType = (c: Column): { baseType: string; unsigned: boolean; zerofill: boolean } => {
  const split = splitMysqlTypeModifiers(c.type);
  const zerofill = Boolean(c.ext?.mysql?.zerofill || split.zerofill);
  const unsigned = Boolean(c.ext?.mysql?.unsigned || split.unsigned || zerofill);
  return { baseType: split.baseType, unsigned, zerofill };
};

/** 渲染完整 MySQL 列定义（用于 CREATE TABLE / ADD COLUMN / MODIFY COLUMN） */
export const renderMysqlColumnDef = (c: Column, opts: { suppressAutoIncrement?: boolean } = {}): string => {
  const { baseType, unsigned, zerofill } = effectiveColType(c);
  const parts: string[] = [mysqlIdent(c.name)];

  let typeSql = baseType;
  if (unsigned) typeSql += ' UNSIGNED';
  if (zerofill) typeSql += ' ZEROFILL';
  parts.push(typeSql);

  if (c.ext?.mysql?.charset) {
    parts.push(`CHARACTER SET ${c.ext.mysql.charset}`);
  }
  if (c.collation) {
    parts.push(`COLLATE ${c.collation}`);
  }

  if (c.generated) {
    parts.push(`GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`);
    if (c.notNull) parts.push('NOT NULL');
  } else {
    if (c.notNull) {
      parts.push('NOT NULL');
    } else if (/^timestamp(?:\(\d+\))?$/i.test(baseType)) {
      parts.push('NULL');
    }
    if (c.default) {
      if ('nextval' in c.default) throw new PlanError(`MySQL 不支持序列默认值（列 ${c.name}）`);
      parts.push(`DEFAULT ${formatMysqlDefault(c.default.expr, baseType)}`);
    }
    if (c.ext?.mysql?.onUpdateCurrentTimestamp) {
      const fsp = mysqlTemporalPrecision(baseType);
      parts.push(
        fsp !== null && fsp > 0 ? `ON UPDATE CURRENT_TIMESTAMP(${fsp})` : 'ON UPDATE CURRENT_TIMESTAMP',
      );
    }
    if (c.ext?.mysql?.autoIncrement && !opts.suppressAutoIncrement) {
      parts.push('AUTO_INCREMENT');
    }
  }

  if (c.comment !== null && c.comment !== '') {
    parts.push(`COMMENT ${mysqlLiteral(c.comment)}`);
  }

  return parts.join(' ');
};

const renderTableOptions = (t: Table): string => {
  const opts: string[] = [];
  const engine = t.ext?.mysql?.engine ?? 'InnoDB';
  opts.push(`ENGINE=${engine}`);
  if (t.ext?.mysql?.charset) opts.push(`DEFAULT CHARSET=${t.ext.mysql.charset}`);
  if (t.ext?.mysql?.collation) opts.push(`COLLATE=${t.ext.mysql.collation}`);
  if (t.comment !== null && t.comment !== '') opts.push(`COMMENT=${mysqlLiteral(t.comment)}`);
  return opts.join(' ');
};

/** 渲染建表语句（含列、PRIMARY KEY、UNIQUE、CHECK，外键统一在建完表和显式索引后添加） */
export const renderMysqlCreateTable = (m: Model, tableId: string): string => {
  const t = get(m, tableId, 'table');
  const cols = columnsOf(m, tableId);
  const colN = (id: string) => get(m, id, 'column').name;

  // 若表上的 AUTO_INCREMENT 列仅靠独立二级索引覆盖（而非 PK/UNIQUE），在 CREATE TABLE 时暂抑 AUTO_INCREMENT，等二级索引建好后再补
  const pk = childrenOf(m, tableId, 'primaryKey')[0] ?? null;
  const uniques = childrenOf(m, tableId, 'unique').sort((a, b) => a.name.localeCompare(b.name));
  const checks = childrenOf(m, tableId, 'check').sort((a, b) => a.name.localeCompare(b.name));

  const inlineIndexedFirstCols = new Set<string>();
  if (pk && pk.columns[0]) inlineIndexedFirstCols.add(pk.columns[0]);
  for (const u of uniques) if (u.columns[0]) inlineIndexedFirstCols.add(u.columns[0]);

  const items: string[] = cols.map((c) =>
    renderMysqlColumnDef(c, {
      suppressAutoIncrement: Boolean(c.ext?.mysql?.autoIncrement && !inlineIndexedFirstCols.has(c.id)),
    }),
  );

  if (pk) {
    items.push(`PRIMARY KEY (${pk.columns.map((c) => mysqlIdent(colN(c))).join(', ')})`);
  }
  for (const u of uniques) {
    items.push(
      `CONSTRAINT ${mysqlIdent(u.name)} UNIQUE (${u.columns.map((c) => mysqlIdent(colN(c))).join(', ')})`,
    );
  }
  for (const ck of checks) {
    items.push(`CONSTRAINT ${mysqlIdent(ck.name)} CHECK (${ck.expr})`);
  }

  return `CREATE TABLE ${mysqlIdent(t.name)} (${items.join(', ')}) ${renderTableOptions(t)}`;
};

/** 渲染 CREATE INDEX 语句 */
export const renderMysqlCreateIndex = (m: Model, idx: Index, tableNameOverride?: string): string => {
  const t = get(m, idx.parent, 'table');
  const tName = tableNameOverride ?? t.name;
  const indexType = (
    idx.ext?.mysql?.indexType ?? (idx.method.toUpperCase() === 'HASH' ? 'HASH' : 'BTREE')
  ).toUpperCase();
  const lengths = idx.ext?.mysql?.lengths;
  const els = idx.elements.map((e, i) => {
    let s: string;
    if (e.column) {
      s = mysqlIdent(get(m, e.column, 'column').name);
      const len = lengths?.[i];
      if (len && len > 0) s += `(${len})`;
    } else {
      s = `(${e.expr})`;
    }
    if (e.desc && indexType !== 'FULLTEXT' && indexType !== 'SPATIAL') s += ' DESC';
    return s;
  });

  let prefix = 'CREATE ';
  if (indexType === 'FULLTEXT') prefix += 'FULLTEXT ';
  else if (indexType === 'SPATIAL') prefix += 'SPATIAL ';
  else if (idx.unique) prefix += 'UNIQUE ';

  let sql = `${prefix}INDEX ${mysqlIdent(idx.name)} ON ${mysqlIdent(tName)} (${els.join(', ')})`;
  if (indexType === 'HASH') sql += ' USING HASH';
  if (idx.comment !== null && idx.comment !== '') sql += ` COMMENT ${mysqlLiteral(idx.comment)}`;
  return sql;
};

/** 渲染外键添加语句 */
const renderMysqlAddForeignKey = (
  fk: ForeignKey,
  tableName: string,
  colNameOf: (id: string) => string,
  refTableName: string,
  refColNameOf: (id: string) => string,
): string => {
  const cols = fk.columns.map((c) => mysqlIdent(colNameOf(c))).join(', ');
  const refCols = fk.refColumns.map((c) => mysqlIdent(refColNameOf(c))).join(', ');
  let sql = `ALTER TABLE ${mysqlIdent(tableName)} ADD CONSTRAINT ${mysqlIdent(fk.name)} FOREIGN KEY (${cols}) REFERENCES ${mysqlIdent(refTableName)} (${refCols})`;
  if (fk.onDelete !== 'noAction') sql += ` ON DELETE ${FK_ACTION[fk.onDelete]}`;
  if (fk.onUpdate !== 'noAction') sql += ` ON UPDATE ${FK_ACTION[fk.onUpdate]}`;
  return sql;
};

/** 校验目标 MySQL 版本是否支持模型中用到的类型特性（如 9.0+ VECTOR） */
export const checkMysqlVersionCompatibility = (m: Model, versionNum: number | null | undefined): void => {
  if (versionNum === null || versionNum === undefined) return;
  if (versionNum < 90000) {
    for (const c of all(m, 'column')) {
      if (isMysqlVectorType(c.type)) {
        const t = get(m, c.parent, 'table');
        const major = Math.floor(versionNum / 10000);
        const minor = Math.floor((versionNum % 10000) / 100);
        throw new PlanError(
          `列 ${t.name}.${c.name} 使用了 VECTOR 类型（${c.type}），需要 MySQL 9.0+（当前目标 MySQL ${major}.${minor}）`,
        );
      }
    }
  }
};

/** 检查一个键/索引的前缀列是否能覆盖外键列（顺序一致） */
const prefixMatches = (keyCols: readonly string[], fkCols: readonly string[]): boolean => {
  if (keyCols.length < fkCols.length) return false;
  for (let i = 0; i < fkCols.length; i++) {
    if (keyCols[i] !== fkCols[i]) return false;
  }
  return true;
};

/** 提取一个二级索引能否作为 InnoDB 外键覆盖索引的纯列前缀（非 FULLTEXT/SPATIAL、无前缀长度、非表达式） */
const fkEligibleIndexCols = (ix: Index): string[] | null => {
  const indexType = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
  if (indexType === 'FULLTEXT' || indexType === 'SPATIAL') return null;
  const cols: string[] = [];
  for (let i = 0; i < ix.elements.length; i++) {
    const el = ix.elements[i]!;
    if (!el.column || el.expr !== null) break;
    const len = ix.ext?.mysql?.lengths?.[i];
    if (len && len > 0) break;
    cols.push(el.column);
  }
  return cols.length > 0 ? cols : null;
};

/** 获取表上所有能覆盖外键的显式键列前缀（PK / UNIQUE / 合法二级索引） */
const explicitCoveringKeyPrefixes = (
  m: Model,
  tableId: string,
  excludeIds?: ReadonlySet<string>,
): string[][] => {
  const out: string[][] = [];
  for (const pk of childrenOf(m, tableId, 'primaryKey')) {
    if (!excludeIds?.has(pk.id)) out.push(pk.columns);
  }
  for (const u of childrenOf(m, tableId, 'unique')) {
    if (!excludeIds?.has(u.id)) out.push(u.columns);
  }
  for (const ix of childrenOf(m, tableId, 'index')) {
    if (excludeIds?.has(ix.id)) continue;
    const cols = fkEligibleIndexCols(ix);
    if (cols) out.push(cols);
  }
  return out;
};

/**
 * 确定性推导某张表上哪些 FK 拥有 InnoDB 自动创建的隐式辅助索引（名字与 FK 同名）。
 * 与 `mysqlCreateAll` 建外键的顺序（按 fk.name 升序，在建完显式索引后加外键）严格一致。
 */
const computeImplicitFkOwners = (m: Model, tableId: string): Set<string> => {
  const covering = explicitCoveringKeyPrefixes(m, tableId);
  const owners = new Set<string>();
  const fks = childrenOf(m, tableId, 'foreignKey').sort((a, b) => a.name.localeCompare(b.name));
  for (const fk of fks) {
    if (!covering.some((k) => prefixMatches(k, fk.columns))) {
      owners.add(fk.id);
      covering.push(fk.columns);
    }
  }
  return owners;
};

/** 拓扑排序不透明对象（被依赖的在前，其次按 order 和名字） */
const topoOpaques = (opaques: Opaque[]): Opaque[] => {
  const byId = new Map(opaques.map((o) => [o.id, o]));
  const visited = new Set<string>();
  const out: Opaque[] = [];
  const sorted = [...opaques].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const visit = (o: Opaque) => {
    if (visited.has(o.id)) return;
    visited.add(o.id);
    for (const d of o.deps) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    out.push(o);
  };
  for (const o of sorted) visit(o);
  return out;
};

/** 按外键依赖对表拓扑排序（被引用表在前） */
const topoTables = (m: Model, tableIds: string[]): string[] => {
  const set = new Set(tableIds);
  const deps = new Map<string, Set<string>>();
  for (const id of tableIds) deps.set(id, new Set());
  for (const fk of all(m, 'foreignKey')) {
    if (set.has(fk.parent) && set.has(fk.refTable) && fk.parent !== fk.refTable) {
      deps.get(fk.parent)!.add(fk.refTable);
    }
  }
  const visited = new Set<string>();
  const out: string[] = [];
  const sorted = [...tableIds].sort((a, b) => get(m, a, 'table').name.localeCompare(get(m, b, 'table').name));
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const d of [...deps.get(id)!].sort((a, b) =>
      get(m, a, 'table').name.localeCompare(get(m, b, 'table').name),
    )) {
      visit(d);
    }
    out.push(id);
  };
  for (const id of sorted) visit(id);
  return out;
};

const migrateExprForRenames = (expr: string, renames: [string, string][]): string => {
  if (!renames.length) return expr;
  let out = expr;
  renames.forEach(([oldName], i) => {
    out = mysqlRenameInExpr(out, oldName, `__dowel_ph_${i}__`);
  });
  renames.forEach(([, newName], i) => {
    out = mysqlRenameInExpr(out, `__dowel_ph_${i}__`, newName);
  });
  return out;
};

const colSignature = (c: Column): unknown => {
  const { baseType, unsigned, zerofill } = effectiveColType(c);
  return {
    baseType,
    unsigned,
    zerofill,
    notNull: c.notNull,
    default: c.default && 'expr' in c.default ? formatMysqlDefault(c.default.expr, baseType) : c.default,
    generated: c.generated,
    charset: c.ext?.mysql?.charset ?? null,
    collation: c.collation ?? null,
    onUpdateCurrentTimestamp: Boolean(c.ext?.mysql?.onUpdateCurrentTimestamp),
    autoIncrement: Boolean(c.ext?.mysql?.autoIncrement),
    comment: c.comment ?? null,
  };
};

const colTypeKeySignature = (c: Column): unknown => {
  const { baseType, unsigned, zerofill } = effectiveColType(c);
  return {
    baseType,
    unsigned,
    zerofill,
    charset: c.ext?.mysql?.charset ?? null,
    collation: c.collation ?? null,
  };
};

const indexDefSignature = (idx: Index, renames: [string, string][]): unknown => ({
  unique: idx.unique,
  indexType: (
    idx.ext?.mysql?.indexType ?? (idx.method.toUpperCase() === 'HASH' ? 'HASH' : 'BTREE')
  ).toUpperCase(),
  lengths: idx.ext?.mysql?.lengths ?? null,
  comment: idx.comment ?? null,
  elements: idx.elements.map((e) => ({
    column: e.column,
    expr: e.expr ? migrateExprForRenames(e.expr, renames) : null,
    desc: e.desc,
  })),
});

const fkSignature = (fk: ForeignKey): unknown => ({
  name: fk.name,
  columns: fk.columns,
  refTable: fk.refTable,
  refColumns: fk.refColumns,
  onDelete: fk.onDelete,
  onUpdate: fk.onUpdate,
});

const normTableExt = (t: Table) => ({
  engine: (t.ext?.mysql?.engine ?? 'InnoDB').toLowerCase(),
  charset: t.ext?.mysql?.charset?.toLowerCase() ?? null,
  collation: t.ext?.mysql?.collation?.toLowerCase() ?? null,
  comment: t.comment ?? null,
});

/** 将一个 MySQL 模型从空库建出 */
export const mysqlCreateAll = (m: Model, opts?: MysqlPlanOptions): Step[] => {
  if (m.dialect !== 'mysql') throw new PlanError(`预期 mysql 模型，实际为 ${m.dialect}`);
  checkMysqlVersionCompatibility(m, opts?.mysqlVersionNum);

  const steps: Step[] = [];
  const emit = (kind: string, target: string, sql: string) =>
    steps.push({ kind, target, sql, transactional: false });

  // 1. 建表（含列、PK、UNIQUE、CHECK）
  const tableIds = topoTables(
    m,
    all(m, 'table').map((t) => t.id),
  );
  const deferredAutoInc: { table: Table; col: Column }[] = [];
  for (const tid of tableIds) {
    const t = get(m, tid, 'table');
    emit('createTable', t.name, renderMysqlCreateTable(m, tid));
    const inlineFirst = new Set<string>();
    for (const pk of childrenOf(m, tid, 'primaryKey')) if (pk.columns[0]) inlineFirst.add(pk.columns[0]);
    for (const u of childrenOf(m, tid, 'unique')) if (u.columns[0]) inlineFirst.add(u.columns[0]);
    for (const c of columnsOf(m, tid)) {
      if (c.ext?.mysql?.autoIncrement && !inlineFirst.has(c.id)) {
        deferredAutoInc.push({ table: t, col: c });
      }
    }
  }

  // 2. 建二级索引（在加外键前创建，确保 InnoDB 复用显式覆盖索引）
  const indexes = all(m, 'index').sort(
    (a, b) =>
      get(m, a.parent, 'table').name.localeCompare(get(m, b.parent, 'table').name) ||
      a.name.localeCompare(b.name),
  );
  for (const idx of indexes) {
    emit('createIndex', idx.name, renderMysqlCreateIndex(m, idx));
  }

  // 2b. 补齐仅靠二级索引覆盖的 AUTO_INCREMENT
  for (const { table, col } of deferredAutoInc) {
    emit(
      'alterColumn',
      `${table.name}.${col.name}`,
      `ALTER TABLE ${mysqlIdent(table.name)} MODIFY COLUMN ${renderMysqlColumnDef(col)}`,
    );
  }

  // 3. 加外键（按表名 + 外键名排序，确定性处理循环与自引用外键）
  const fks = all(m, 'foreignKey').sort(
    (a, b) =>
      get(m, a.parent, 'table').name.localeCompare(get(m, b.parent, 'table').name) ||
      a.name.localeCompare(b.name),
  );
  for (const fk of fks) {
    const t = get(m, fk.parent, 'table');
    const refT = get(m, fk.refTable, 'table');
    emit(
      'addForeignKey',
      fk.name,
      renderMysqlAddForeignKey(
        fk,
        t.name,
        (id) => get(m, id, 'column').name,
        refT.name,
        (id) => get(m, id, 'column').name,
      ),
    );
  }

  // 4. 不透明对象（先 routine，再 view 拓扑序，最后 trigger）
  const opaques = all(m, 'opaque');
  const routines = topoOpaques(opaques.filter((o) => EARLY_OPAQUE.has(o.objType)));
  const views = topoOpaques(opaques.filter((o) => o.objType === 'view'));
  const triggers = topoOpaques(opaques.filter((o) => o.objType !== 'view' && !EARLY_OPAQUE.has(o.objType)));
  for (const op of [...routines, ...views, ...triggers]) {
    for (const ddl of op.ddl) emit('createOpaque', op.name, ddl);
  }

  return steps;
};

/** 比较两个 MySQL 模型，生成安全、可闭环回滚的 MySQL DDL 步骤 */
export const mysqlPlan = (from: Model, to: Model, opts?: MysqlPlanOptions): Step[] => {
  if (from.dialect !== 'mysql' || to.dialect !== 'mysql') {
    throw new PlanError(`mysqlPlan 需要 mysql 模型，收到 ${from.dialect} -> ${to.dialect}`);
  }
  checkMysqlVersionCompatibility(to, opts?.mysqlVersionNum);

  const steps: Step[] = [];
  const emit = (kind: string, target: string, sql: string) =>
    steps.push({ kind, target, sql, transactional: false });

  const inFrom = (id: string) => id in from.objects;
  const inTo = (id: string) => id in to.objects;

  // 收集所有已占用名用于生成永不冲突的临时名
  const usedLower = new Set<string>();
  for (const m of [from, to]) {
    for (const o of Object.values(m.objects)) usedLower.add(o.name.toLowerCase());
  }
  let tmpSeq = 0;
  const allocTmp = () => {
    for (;;) {
      const candidate = `_dowel_tmp_${++tmpSeq}`;
      if (!usedLower.has(candidate)) {
        usedLower.add(candidate);
        return candidate;
      }
    }
  };

  const fromTables = all(from, 'table');
  const toTables = all(to, 'table');
  const removedTables = fromTables.filter((t) => !inTo(t.id));
  const addedTables = toTables.filter((t) => !inFrom(t.id));
  const commonTables = toTables.filter((t) => inFrom(t.id));
  const removedTableIds = new Set(removedTables.map((t) => t.id));

  // 每张公共表的列改名与列类型变更分析
  const colRenamesByTable = new Map<string, [string, string][]>();
  const renamedColIds = new Set<string>();
  const typeChangedCols = new Set<string>();
  const regenCols = new Set<string>();

  for (const t of commonTables) {
    const renames: [string, string][] = [];
    for (const tc of columnsOf(to, t.id)) {
      const fc = from.objects[tc.id];
      if (fc?.kind !== 'column' || fc.parent !== t.id) continue;
      if (fc.name !== tc.name) {
        renames.push([fc.name, tc.name]);
        renamedColIds.add(tc.id);
      }
      if (!same(colTypeKeySignature(fc), colTypeKeySignature(tc))) {
        typeChangedCols.add(tc.id);
      }
    }
    colRenamesByTable.set(t.id, renames);
  }

  // 生成列：普通列↔生成列互转、生成表达式变化、VIRTUAL↔STORED 变化、类型/非空/注释变化或依赖列改名/改类型/重建 -> 删后重建（不动点闭包支持链式生成列）
  for (let changed = true; changed;) {
    changed = false;
    for (const t of commonTables) {
      const renames = colRenamesByTable.get(t.id) ?? [];
      const renamedNamesOld = renames.map(([oldN]) => oldN);
      const unstableNamesOld = columnsOf(from, t.id)
        .filter((c) => typeChangedCols.has(c.id) || regenCols.has(c.id))
        .map((c) => c.name);
      for (const tc of columnsOf(to, t.id)) {
        if (regenCols.has(tc.id)) continue;
        const fc = from.objects[tc.id];
        if (fc?.kind !== 'column' || fc.parent !== t.id) continue;
        if (!fc.generated && !tc.generated) continue;
        const bothGen = Boolean(fc.generated && tc.generated);
        const exprTouchesUnstable =
          fc.generated !== null &&
          (renamedNamesOld.some((n) => mysqlExprReferences(fc.generated!.expr, n)) ||
            unstableNamesOld.some((n) => mysqlExprReferences(fc.generated!.expr, n)));
        if (
          !bothGen ||
          fc.generated!.stored !== tc.generated!.stored ||
          migrateExprForRenames(fc.generated!.expr, renames) !== tc.generated!.expr ||
          exprTouchesUnstable ||
          !same(colSignature(fc), colSignature(tc))
        ) {
          regenCols.add(tc.id);
          changed = true;
        }
      }
    }
  }

  // 键/约束/索引重建集合（PK / UNIQUE / CHECK / INDEX）
  const keyRebuild = new Set<string>();
  const keyRenameOnly = new Set<string>(); // 仅改名的 UNIQUE / INDEX（走 RENAME INDEX）

  for (const t of commonTables) {
    const renames = colRenamesByTable.get(t.id) ?? [];
    const renamedOldNames = renames.map(([oldN]) => oldN);
    const touchedColIds = new Set<string>([...typeChangedCols, ...regenCols]);

    for (const pk of childrenOf(to, t.id, 'primaryKey')) {
      if (!inFrom(pk.id)) continue;
      const fpk = from.objects[pk.id] as PrimaryKey;
      if (!same(fpk.columns, pk.columns) || fpk.columns.some((c) => regenCols.has(c))) {
        keyRebuild.add(pk.id);
      }
    }

    for (const u of childrenOf(to, t.id, 'unique')) {
      if (!inFrom(u.id)) continue;
      const fu = from.objects[u.id] as Unique;
      if (!same(fu.columns, u.columns) || fu.columns.some((c) => regenCols.has(c))) {
        keyRebuild.add(u.id);
      } else if (fu.name !== u.name) {
        keyRenameOnly.add(u.id);
      }
    }

    for (const ck of childrenOf(to, t.id, 'check')) {
      if (!inFrom(ck.id)) continue;
      const fck = from.objects[ck.id] as Check;
      const touchesRenamed = renamedOldNames.some((n) => mysqlExprReferences(fck.expr, n));
      const touchesTyped = columnsOf(from, t.id).some(
        (c) => touchedColIds.has(c.id) && mysqlExprReferences(fck.expr, c.name),
      );
      if (fck.name !== ck.name || fck.expr !== ck.expr || touchesRenamed || touchesTyped) {
        keyRebuild.add(ck.id);
      }
    }

    for (const ix of childrenOf(to, t.id, 'index')) {
      if (!inFrom(ix.id)) continue;
      const fix = from.objects[ix.id] as Index;
      const touchesRenamedExpr = fix.elements.some(
        (e) => e.expr !== null && renamedOldNames.some((n) => mysqlExprReferences(e.expr!, n)),
      );
      const touchesTypedExpr = fix.elements.some(
        (e) =>
          e.expr !== null &&
          columnsOf(from, t.id).some((c) => touchedColIds.has(c.id) && mysqlExprReferences(e.expr!, c.name)),
      );
      const touchesRegen = fix.elements.some((e) => e.column !== null && regenCols.has(e.column));
      const touchesTypeOnPrefix =
        Boolean(fix.ext?.mysql?.lengths?.some((l) => l && l > 0)) &&
        fix.elements.some((e) => e.column !== null && typeChangedCols.has(e.column));
      if (
        !same(indexDefSignature(fix, renames), indexDefSignature(ix, [])) ||
        touchesRenamedExpr ||
        touchesTypedExpr ||
        touchesRegen ||
        touchesTypeOnPrefix
      ) {
        keyRebuild.add(ix.id);
      } else if (fix.name !== ix.name) {
        keyRenameOnly.add(ix.id);
      }
    }
  }

  // 计算源模型中每张表的隐式 FK 索引拥有者
  const fromImplicitOwnersByTable = new Map<string, Set<string>>();
  for (const t of fromTables) {
    fromImplicitOwnersByTable.set(t.id, computeImplicitFkOwners(from, t.id));
  }

  // 键/索引即将被删除或重建的集合
  const droppedOrRebuiltKeys = new Set<string>([
    ...keyRebuild,
    ...all(from, 'primaryKey')
      .filter((k) => !inTo(k.id))
      .map((k) => k.id),
    ...all(from, 'unique')
      .filter((k) => !inTo(k.id))
      .map((k) => k.id),
    ...all(from, 'index')
      .filter((k) => !inTo(k.id))
      .map((k) => k.id),
  ]);

  // 计算需要删建的外键
  const fkRebuild = new Set<string>();
  const refKeyInvalidated = (fk: ForeignKey): boolean => {
    const refTable = fk.refTable;
    const survivingRefKeys = explicitCoveringKeyPrefixes(from, refTable, droppedOrRebuiltKeys);
    return !survivingRefKeys.some((k) => prefixMatches(k, fk.refColumns));
  };

  for (const fk of all(to, 'foreignKey')) {
    if (!inFrom(fk.id)) continue;
    const ffk = from.objects[fk.id] as ForeignKey;
    const colChanged =
      ffk.columns.some((c) => typeChangedCols.has(c) || regenCols.has(c)) ||
      ffk.refColumns.some((c) => typeChangedCols.has(c) || regenCols.has(c));
    if (!same(fkSignature(ffk), fkSignature(fk)) || colChanged || refKeyInvalidated(ffk)) {
      fkRebuild.add(fk.id);
    }
  }

  // 不动点闭包：
  // 1) 若某存活 FK 在 from 中依赖显式覆盖索引，而所有显式覆盖索引都被删/重建（且无其他存活隐式索引覆盖它），必须重建该 FK；
  // 2) 若某隐式索引拥有者 FK 被删除/重建，同表上依赖该隐式索引的存活 FK 也必须重建。
  for (let changed = true; changed;) {
    changed = false;
    for (const t of commonTables) {
      const owners = fromImplicitOwnersByTable.get(t.id) ?? new Set<string>();
      const survivingExplicit = explicitCoveringKeyPrefixes(from, t.id, droppedOrRebuiltKeys);
      const survivingImplicit = childrenOf(from, t.id, 'foreignKey')
        .filter((f) => inTo(f.id) && !fkRebuild.has(f.id) && owners.has(f.id))
        .map((f) => f.columns);
      for (const fk of childrenOf(from, t.id, 'foreignKey')) {
        if (!inTo(fk.id) || fkRebuild.has(fk.id)) continue;
        const stillCovered =
          survivingExplicit.some((k) => prefixMatches(k, fk.columns)) ||
          survivingImplicit.some((k) => prefixMatches(k, fk.columns));
        if (!stillCovered) {
          fkRebuild.add(fk.id);
          changed = true;
        }
      }
    }
  }

  // ───── P1: 删除被移除 / 变更 / 依赖变更对象的不透明对象 ─────
  const touchedTableIds = new Set<string>([
    ...removedTableIds,
    ...commonTables.filter((t) => (from.objects[t.id] as Table).name !== t.name).map((t) => t.id),
  ]);
  const touchedColIds = new Set<string>([
    ...all(from, 'column')
      .filter((c) => !inTo(c.id))
      .map((c) => c.id),
    ...renamedColIds,
    ...typeChangedCols,
    ...regenCols,
  ]);
  const touchedNamesLower = new Set<string>();
  for (const tid of touchedTableIds) {
    const ft = from.objects[tid];
    const tt = to.objects[tid];
    if (ft?.kind === 'table') touchedNamesLower.add(ft.name.toLowerCase());
    if (tt?.kind === 'table') touchedNamesLower.add(tt.name.toLowerCase());
  }
  const ddlMentionsTouched = (ddl: string[]): boolean => {
    if (touchedNamesLower.size === 0) return false;
    for (const sql of ddl) {
      for (const tok of mysqlTokenize(sql)) {
        if (
          (tok.kind === 'ident' || tok.kind === 'qident') &&
          touchedNamesLower.has(tok.text.toLowerCase())
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const opaqueChanged = (op: Opaque): boolean => {
    const next = to.objects[op.id];
    if (!next || next.kind !== 'opaque') return true;
    return !same([op.objType, op.name, op.ddl, op.drop], [next.objType, next.name, next.ddl, next.drop]);
  };
  const opaquesToDrop = new Set<string>();
  for (const op of all(from, 'opaque')) {
    if (
      opaqueChanged(op) ||
      touchedTableIds.has(op.parent) ||
      op.deps.some((d) => touchedTableIds.has(d) || touchedColIds.has(d)) ||
      (touchedTableIds.size > 0 && ddlMentionsTouched(op.ddl))
    ) {
      opaquesToDrop.add(op.id);
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const op of all(from, 'opaque')) {
      if (opaquesToDrop.has(op.id)) continue;
      if (op.deps.some((d) => opaquesToDrop.has(d))) {
        opaquesToDrop.add(op.id);
        changed = true;
      }
    }
  }
  const dropOpaques = topoOpaques(all(from, 'opaque').filter((o) => opaquesToDrop.has(o.id))).reverse();
  for (const op of dropOpaques) {
    emit('dropOpaque', op.name, op.drop);
  }

  // ───── P2: 删除被移除 / 需重建的外键（以及指向被删表的外键），并清理其孤立隐式索引 ─────
  const fksToDrop = all(from, 'foreignKey')
    .filter((fk) => {
      if (removedTableIds.has(fk.parent)) {
        // 若被删表之间存在循环外键，或指向另一张表，后面删表前也会断环；这里先删存活表上移除/重建/指向被删表的外键
        return false;
      }
      return !inTo(fk.id) || fkRebuild.has(fk.id) || removedTableIds.has(fk.refTable);
    })
    .sort(
      (a, b) =>
        get(from, a.parent, 'table').name.localeCompare(get(from, b.parent, 'table').name) ||
        a.name.localeCompare(b.name),
    );

  // 被删表之间的外键：若存在多张被删表，先解掉它们之间的外键，彻底免疫删除顺序环路
  const removedTableCycleFks = all(from, 'foreignKey').filter(
    (fk) => removedTableIds.has(fk.parent) && removedTableIds.has(fk.refTable) && fk.parent !== fk.refTable,
  );
  for (const fk of removedTableCycleFks) {
    const t = get(from, fk.parent, 'table');
    emit(
      'dropForeignKey',
      fk.name,
      `ALTER TABLE ${mysqlIdent(t.name)} DROP FOREIGN KEY ${mysqlIdent(fk.name)}`,
    );
  }

  for (const fk of fksToDrop) {
    const t = get(from, fk.parent, 'table');
    emit(
      'dropForeignKey',
      fk.name,
      `ALTER TABLE ${mysqlIdent(t.name)} DROP FOREIGN KEY ${mysqlIdent(fk.name)}`,
    );
  }
  // 清理被删/重建外键遗留的 InnoDB 隐式索引
  for (const fk of fksToDrop) {
    const owners = fromImplicitOwnersByTable.get(fk.parent);
    if (owners?.has(fk.id)) {
      const t = get(from, fk.parent, 'table');
      emit('dropIndex', fk.name, `DROP INDEX ${mysqlIdent(fk.name)} ON ${mysqlIdent(t.name)}`);
    }
  }

  // ───── P3: 预先剥离即将失去索引保护或取消 AUTO_INCREMENT 的列上的 AUTO_INCREMENT ─────
  const strippedAutoInc = new Set<string>();
  for (const t of commonTables) {
    const survivingKeyFirstCols = new Set<string>();
    for (const pk of childrenOf(from, t.id, 'primaryKey')) {
      if (!droppedOrRebuiltKeys.has(pk.id) && pk.columns[0]) survivingKeyFirstCols.add(pk.columns[0]);
    }
    for (const u of childrenOf(from, t.id, 'unique')) {
      if (!droppedOrRebuiltKeys.has(u.id) && u.columns[0]) survivingKeyFirstCols.add(u.columns[0]);
    }
    for (const ix of childrenOf(from, t.id, 'index')) {
      if (!droppedOrRebuiltKeys.has(ix.id) && ix.elements[0]?.column) {
        survivingKeyFirstCols.add(ix.elements[0]!.column);
      }
    }
    for (const fc of columnsOf(from, t.id)) {
      if (!fc.ext?.mysql?.autoIncrement) continue;
      const tc = inTo(fc.id) ? (to.objects[fc.id] as Column) : null;
      const losesAutoInc = !tc || !tc.ext?.mysql?.autoIncrement || regenCols.has(fc.id);
      const losesKey = !survivingKeyFirstCols.has(fc.id);
      if (losesAutoInc || losesKey) {
        const ft = get(from, t.id, 'table');
        emit(
          'alterColumn',
          `${ft.name}.${fc.name}`,
          `ALTER TABLE ${mysqlIdent(ft.name)} MODIFY COLUMN ${renderMysqlColumnDef(fc, { suppressAutoIncrement: true })}`,
        );
        strippedAutoInc.add(fc.id);
      }
    }
  }

  // ───── P4: 删除被移除或需重建的 CHECK、二级索引、UNIQUE、PRIMARY KEY（仅针对存活表） ─────
  for (const t of commonTables) {
    const ft = get(from, t.id, 'table');
    for (const ck of childrenOf(from, t.id, 'check').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inTo(ck.id) || keyRebuild.has(ck.id)) {
        emit('dropCheck', ck.name, `ALTER TABLE ${mysqlIdent(ft.name)} DROP CHECK ${mysqlIdent(ck.name)}`);
      }
    }
    for (const ix of childrenOf(from, t.id, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inTo(ix.id) || keyRebuild.has(ix.id)) {
        emit('dropIndex', ix.name, `DROP INDEX ${mysqlIdent(ix.name)} ON ${mysqlIdent(ft.name)}`);
      }
    }
    for (const u of childrenOf(from, t.id, 'unique').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inTo(u.id) || keyRebuild.has(u.id)) {
        emit('dropUnique', u.name, `ALTER TABLE ${mysqlIdent(ft.name)} DROP INDEX ${mysqlIdent(u.name)}`);
      }
    }
    for (const pk of childrenOf(from, t.id, 'primaryKey')) {
      if (!inTo(pk.id) || keyRebuild.has(pk.id)) {
        emit('dropPrimaryKey', pk.name, `ALTER TABLE ${mysqlIdent(ft.name)} DROP PRIMARY KEY`);
      }
    }
  }

  // ───── P5: 删除即将重建或移除的生成列（避免挡住列改名/改类型） ─────
  const droppedGenColIds = new Set<string>();
  for (const t of commonTables) {
    const ft = get(from, t.id, 'table');
    for (const fc of columnsOf(from, t.id)) {
      if (fc.generated && (!inTo(fc.id) || regenCols.has(fc.id))) {
        emit(
          'dropColumn',
          `${ft.name}.${fc.name}`,
          `ALTER TABLE ${mysqlIdent(ft.name)} DROP COLUMN ${mysqlIdent(fc.name)}`,
        );
        droppedGenColIds.add(fc.id);
      }
    }
  }

  // ───── P6: 删除已移除的表 ─────
  const dropTableOrder = topoTables(
    from,
    removedTables.map((t) => t.id),
  ).reverse();
  for (const tid of dropTableOrder) {
    const ft = get(from, tid, 'table');
    emit('dropTable', ft.name, `DROP TABLE ${mysqlIdent(ft.name)}`);
  }

  // ───── P7: 表改名（两阶段防环与碰撞） ─────
  const curTableName = new Map<string, string>();
  for (const t of commonTables) curTableName.set(t.id, (from.objects[t.id] as Table).name);
  const activeTableLower = () => {
    const map = new Map<string, string>();
    for (const [id, name] of curTableName) map.set(name.toLowerCase(), id);
    return map;
  };
  for (const t of commonTables) {
    if (curTableName.get(t.id) === t.name) continue;
    const occupant = activeTableLower().get(t.name.toLowerCase());
    if (occupant && occupant !== t.id) {
      const occName = curTableName.get(occupant)!;
      const tmp = allocTmp();
      emit('renameTable', occName, `RENAME TABLE ${mysqlIdent(occName)} TO ${mysqlIdent(tmp)}`);
      curTableName.set(occupant, tmp);
    }
    const actual = curTableName.get(t.id)!;
    if (actual !== t.name) {
      emit('renameTable', t.name, `RENAME TABLE ${mysqlIdent(actual)} TO ${mysqlIdent(t.name)}`);
      curTableName.set(t.id, t.name);
    }
  }
  for (const t of commonTables) {
    const actual = curTableName.get(t.id)!;
    if (actual !== t.name) {
      emit('renameTable', t.name, `RENAME TABLE ${mysqlIdent(actual)} TO ${mysqlIdent(t.name)}`);
      curTableName.set(t.id, t.name);
    }
  }

  // ───── P8: 创建新表（含列、PK、UNIQUE、CHECK，不含外键与二级索引） ─────
  const deferredAutoInc: { table: Table; col: Column }[] = [];
  for (const tid of topoTables(
    to,
    addedTables.map((t) => t.id),
  )) {
    const t = get(to, tid, 'table');
    emit('createTable', t.name, renderMysqlCreateTable(to, tid));
    const inlineFirst = new Set<string>();
    for (const pk of childrenOf(to, tid, 'primaryKey')) if (pk.columns[0]) inlineFirst.add(pk.columns[0]);
    for (const u of childrenOf(to, tid, 'unique')) if (u.columns[0]) inlineFirst.add(u.columns[0]);
    for (const c of columnsOf(to, tid)) {
      if (c.ext?.mysql?.autoIncrement && !inlineFirst.has(c.id)) {
        deferredAutoInc.push({ table: t, col: c });
      }
    }
  }

  // ───── P9: 修改既有表的列与表选项 ─────
  for (const t of commonTables) {
    const ft = from.objects[t.id] as Table;
    const fromCols = columnsOf(from, t.id);
    const toCols = columnsOf(to, t.id);

    // 计算当前仍在表上且未删的列
    const curColName = new Map<string, string>();
    for (const fc of fromCols) {
      if (!droppedGenColIds.has(fc.id)) curColName.set(fc.id, fc.name);
    }
    const activeColLower = () => {
      const map = new Map<string, string>();
      for (const [id, name] of curColName) map.set(name.toLowerCase(), id);
      return map;
    };

    const survivingFromIds = new Set(
      fromCols.filter((fc) => inTo(fc.id) && !droppedGenColIds.has(fc.id)).map((fc) => fc.id),
    );
    const toDropCols = fromCols.filter((fc) => !inTo(fc.id) && !droppedGenColIds.has(fc.id));
    const addedRegularCols = toCols.filter((tc) => !inFrom(tc.id) && !tc.generated);
    const addedOrRegenGenCols = toCols.filter(
      (tc) => tc.generated && (!inFrom(tc.id) || regenCols.has(tc.id)),
    );

    // 若所有旧列都要删除且有新列加入，先加第一列（避免 MySQL 拒绝删光所有列 ER_CANT_REMOVE_ALL_FIELDS）
    const addedEarly = new Set<string>();
    if (survivingFromIds.size === 0 && toDropCols.length > 0 && addedRegularCols.length > 0) {
      const firstNew = addedRegularCols[0]!;
      const occupant = activeColLower().get(firstNew.name.toLowerCase());
      if (occupant) {
        const occName = curColName.get(occupant)!;
        const tmp = allocTmp();
        emit(
          'renameColumn',
          `${t.name}.${occName}`,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME COLUMN ${mysqlIdent(occName)} TO ${mysqlIdent(tmp)}`,
        );
        curColName.set(occupant, tmp);
      }
      const suppressAi = Boolean(firstNew.ext?.mysql?.autoIncrement);
      emit(
        'addColumn',
        `${t.name}.${firstNew.name}`,
        `ALTER TABLE ${mysqlIdent(t.name)} ADD COLUMN ${renderMysqlColumnDef(firstNew, { suppressAutoIncrement: suppressAi })}`,
      );
      if (suppressAi) deferredAutoInc.push({ table: t, col: firstNew });
      curColName.set(firstNew.id, firstNew.name);
      addedEarly.add(firstNew.id);
    }

    // 9a. 删除已移除的普通列
    for (const dc of toDropCols) {
      const curName = curColName.get(dc.id)!;
      emit(
        'dropColumn',
        `${t.name}.${curName}`,
        `ALTER TABLE ${mysqlIdent(t.name)} DROP COLUMN ${mysqlIdent(curName)}`,
      );
      curColName.delete(dc.id);
    }

    // 9b. 列改名（两阶段防环、防碰撞）
    const survivingToCols = toCols.filter((tc) => curColName.has(tc.id) && !addedEarly.has(tc.id));
    for (const tc of survivingToCols) {
      if (curColName.get(tc.id) === tc.name) continue;
      const occupant = activeColLower().get(tc.name.toLowerCase());
      if (occupant && occupant !== tc.id) {
        const occName = curColName.get(occupant)!;
        const tmp = allocTmp();
        emit(
          'renameColumn',
          `${t.name}.${occName}`,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME COLUMN ${mysqlIdent(occName)} TO ${mysqlIdent(tmp)}`,
        );
        curColName.set(occupant, tmp);
      }
      const actual = curColName.get(tc.id)!;
      if (actual !== tc.name) {
        emit(
          'renameColumn',
          `${t.name}.${tc.name}`,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME COLUMN ${mysqlIdent(actual)} TO ${mysqlIdent(tc.name)}`,
        );
        curColName.set(tc.id, tc.name);
      }
    }
    for (const tc of survivingToCols) {
      const actual = curColName.get(tc.id)!;
      if (actual !== tc.name) {
        emit(
          'renameColumn',
          `${t.name}.${tc.name}`,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME COLUMN ${mysqlIdent(actual)} TO ${mysqlIdent(tc.name)}`,
        );
        curColName.set(tc.id, tc.name);
      }
    }

    // 检查当前表上依然存活的键的首列（用于判断此时是否能直接带 AUTO_INCREMENT）
    const survivingKeyFirstCols = new Set<string>();
    for (const pk of childrenOf(from, t.id, 'primaryKey')) {
      if (!droppedOrRebuiltKeys.has(pk.id) && pk.columns[0]) survivingKeyFirstCols.add(pk.columns[0]);
    }
    for (const u of childrenOf(from, t.id, 'unique')) {
      if (!droppedOrRebuiltKeys.has(u.id) && u.columns[0]) survivingKeyFirstCols.add(u.columns[0]);
    }
    for (const ix of childrenOf(from, t.id, 'index')) {
      if (!droppedOrRebuiltKeys.has(ix.id) && ix.elements[0]?.column) {
        survivingKeyFirstCols.add(ix.elements[0]!.column);
      }
    }

    // 9c. 修改已有普通列（完整 MODIFY COLUMN 定义；若是从生成列转回普通列，此时列已被 P5 删除，改为 ADD COLUMN）
    for (const tc of toCols) {
      if (tc.generated || !inFrom(tc.id)) continue;
      if (droppedGenColIds.has(tc.id)) {
        const suppressAi = Boolean(tc.ext?.mysql?.autoIncrement && !survivingKeyFirstCols.has(tc.id));
        emit(
          'addColumn',
          `${t.name}.${tc.name}`,
          `ALTER TABLE ${mysqlIdent(t.name)} ADD COLUMN ${renderMysqlColumnDef(tc, { suppressAutoIncrement: suppressAi })}`,
        );
        if (suppressAi) deferredAutoInc.push({ table: t, col: tc });
        continue;
      }
      const fc = from.objects[tc.id] as Column;
      const wantsAutoInc = Boolean(tc.ext?.mysql?.autoIncrement);
      const canSetAutoIncNow = !wantsAutoInc || survivingKeyFirstCols.has(tc.id);
      const needsModify =
        !same(colSignature(fc), colSignature(tc)) || (strippedAutoInc.has(fc.id) && wantsAutoInc);
      if (needsModify) {
        if (wantsAutoInc && !canSetAutoIncNow) {
          // 若仅是剥离了 AUTO_INCREMENT 而其他定义相同，无需重复 MODIFY，留给 P12 恢复 AUTO_INCREMENT
          const fcNoAi = { ...fc, ext: { ...fc.ext, mysql: { ...fc.ext?.mysql, autoIncrement: false } } };
          const tcNoAi = { ...tc, ext: { ...tc.ext, mysql: { ...tc.ext?.mysql, autoIncrement: false } } };
          if (!same(colSignature(fcNoAi), colSignature(tcNoAi))) {
            emit(
              'alterColumn',
              `${t.name}.${tc.name}`,
              `ALTER TABLE ${mysqlIdent(t.name)} MODIFY COLUMN ${renderMysqlColumnDef(tc, { suppressAutoIncrement: true })}`,
            );
          }
          deferredAutoInc.push({ table: t, col: tc });
        } else {
          emit(
            'alterColumn',
            `${t.name}.${tc.name}`,
            `ALTER TABLE ${mysqlIdent(t.name)} MODIFY COLUMN ${renderMysqlColumnDef(tc)}`,
          );
        }
      }
    }

    // 9d. 新增普通列
    for (const ac of addedRegularCols) {
      if (addedEarly.has(ac.id)) continue;
      const suppressAi = Boolean(ac.ext?.mysql?.autoIncrement);
      emit(
        'addColumn',
        `${t.name}.${ac.name}`,
        `ALTER TABLE ${mysqlIdent(t.name)} ADD COLUMN ${renderMysqlColumnDef(ac, { suppressAutoIncrement: suppressAi })}`,
      );
      if (suppressAi) deferredAutoInc.push({ table: t, col: ac });
    }

    // 9e. 新增或重建生成列（按拓扑序，避免生成列引用另一生成列时顺序错误）
    const pendingGen = [...addedOrRegenGenCols];
    const emittedGen = new Set<string>();
    while (pendingGen.length > 0) {
      const idx = pendingGen.findIndex((g) =>
        pendingGen.every((other) => other.id === g.id || !mysqlExprReferences(g.generated!.expr, other.name)),
      );
      const g = pendingGen.splice(Math.max(idx, 0), 1)[0]!;
      if (emittedGen.has(g.id)) continue;
      emittedGen.add(g.id);
      emit(
        'addColumn',
        `${t.name}.${g.name}`,
        `ALTER TABLE ${mysqlIdent(t.name)} ADD COLUMN ${renderMysqlColumnDef(g)}`,
      );
    }

    // 9f. 表级选项（ENGINE / CHARSET / COLLATE / COMMENT）
    const prevOpt = normTableExt(ft);
    const nextOpt = normTableExt(t);
    if (!same(prevOpt, nextOpt)) {
      const clauses: string[] = [];
      if (prevOpt.engine !== nextOpt.engine) clauses.push(`ENGINE=${t.ext?.mysql?.engine ?? 'InnoDB'}`);
      if (prevOpt.charset !== nextOpt.charset || prevOpt.collation !== nextOpt.collation) {
        const cs = t.ext?.mysql?.charset ?? 'utf8mb4';
        const coll =
          t.ext?.mysql?.collation ?? (cs.toLowerCase() === 'utf8mb4' ? 'utf8mb4_0900_ai_ci' : null);
        clauses.push(`DEFAULT CHARACTER SET ${cs}${coll ? ` COLLATE ${coll}` : ''}`);
      }
      if (prevOpt.comment !== nextOpt.comment) {
        clauses.push(`COMMENT=${mysqlLiteral(t.comment ?? '')}`);
      }
      if (clauses.length > 0) {
        emit('alterTable', t.name, `ALTER TABLE ${mysqlIdent(t.name)} ${clauses.join(', ')}`);
      }
    }
  }

  // ───── P10: 仅改名的 UNIQUE / INDEX（两阶段防命名冲突） ─────
  for (const t of commonTables) {
    const renameItems: { id: string; oldName: string; newName: string }[] = [];
    for (const u of childrenOf(to, t.id, 'unique')) {
      if (keyRenameOnly.has(u.id)) {
        renameItems.push({ id: u.id, oldName: (from.objects[u.id] as Unique).name, newName: u.name });
      }
    }
    for (const ix of childrenOf(to, t.id, 'index')) {
      if (keyRenameOnly.has(ix.id)) {
        renameItems.push({ id: ix.id, oldName: (from.objects[ix.id] as Index).name, newName: ix.name });
      }
    }
    if (renameItems.length === 0) continue;

    // 追踪当前表上现存的所有索引名（包含未改名的 UNIQUE/INDEX）
    const curIdxName = new Map<string, string>();
    for (const u of childrenOf(from, t.id, 'unique')) {
      if (!droppedOrRebuiltKeys.has(u.id)) curIdxName.set(u.id, u.name);
    }
    for (const ix of childrenOf(from, t.id, 'index')) {
      if (!droppedOrRebuiltKeys.has(ix.id)) curIdxName.set(ix.id, ix.name);
    }
    const activeIdxLower = () => {
      const map = new Map<string, string>();
      for (const [id, name] of curIdxName) map.set(name.toLowerCase(), id);
      return map;
    };
    for (const item of renameItems) {
      const occ = activeIdxLower().get(item.newName.toLowerCase());
      if (occ && occ !== item.id) {
        const occName = curIdxName.get(occ)!;
        const tmp = allocTmp();
        emit(
          'renameIndex',
          occName,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME INDEX ${mysqlIdent(occName)} TO ${mysqlIdent(tmp)}`,
        );
        curIdxName.set(occ, tmp);
      }
      const actual = curIdxName.get(item.id)!;
      if (actual !== item.newName) {
        emit(
          'renameIndex',
          item.newName,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME INDEX ${mysqlIdent(actual)} TO ${mysqlIdent(item.newName)}`,
        );
        curIdxName.set(item.id, item.newName);
      }
    }
    for (const item of renameItems) {
      const actual = curIdxName.get(item.id)!;
      if (actual !== item.newName) {
        emit(
          'renameIndex',
          item.newName,
          `ALTER TABLE ${mysqlIdent(t.name)} RENAME INDEX ${mysqlIdent(actual)} TO ${mysqlIdent(item.newName)}`,
        );
        curIdxName.set(item.id, item.newName);
      }
    }
  }

  // ───── P11: 新增或重建 PRIMARY KEY、UNIQUE、二级索引、CHECK ─────
  for (const t of commonTables) {
    const colN = (id: string) => get(to, id, 'column').name;
    for (const pk of childrenOf(to, t.id, 'primaryKey')) {
      if (!inFrom(pk.id) || keyRebuild.has(pk.id)) {
        emit(
          'addPrimaryKey',
          pk.name,
          `ALTER TABLE ${mysqlIdent(t.name)} ADD PRIMARY KEY (${pk.columns.map((c) => mysqlIdent(colN(c))).join(', ')})`,
        );
      }
    }
    for (const u of childrenOf(to, t.id, 'unique').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inFrom(u.id) || keyRebuild.has(u.id)) {
        emit(
          'addUnique',
          u.name,
          `ALTER TABLE ${mysqlIdent(t.name)} ADD CONSTRAINT ${mysqlIdent(u.name)} UNIQUE (${u.columns.map((c) => mysqlIdent(colN(c))).join(', ')})`,
        );
      }
    }
    for (const ix of childrenOf(to, t.id, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inFrom(ix.id) || keyRebuild.has(ix.id)) {
        emit('createIndex', ix.name, renderMysqlCreateIndex(to, ix));
      }
    }
    for (const ck of childrenOf(to, t.id, 'check').sort((a, b) => a.name.localeCompare(b.name))) {
      if (!inFrom(ck.id) || keyRebuild.has(ck.id)) {
        emit(
          'addCheck',
          ck.name,
          `ALTER TABLE ${mysqlIdent(t.name)} ADD CONSTRAINT ${mysqlIdent(ck.name)} CHECK (${ck.expr})`,
        );
      }
    }
  }
  // 新建表的二级索引（在加外键之前）
  for (const t of addedTables.sort((a, b) => a.name.localeCompare(b.name))) {
    for (const ix of childrenOf(to, t.id, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
      emit('createIndex', ix.name, renderMysqlCreateIndex(to, ix));
    }
  }

  // ───── P12: 恢复/补齐延迟的 AUTO_INCREMENT ─────
  for (const { table, col } of deferredAutoInc) {
    emit(
      'alterColumn',
      `${table.name}.${col.name}`,
      `ALTER TABLE ${mysqlIdent(table.name)} MODIFY COLUMN ${renderMysqlColumnDef(col)}`,
    );
  }

  // ───── P13: MySQL 8.0+/8.4/9.7 在 CREATE INDEX / ADD UNIQUE / ADD PRIMARY KEY 新增显式覆盖索引时，
  // 会由 InnoDB 自动移除原有的 KEY_GENERATED 隐式外键索引，因此此处不再重复发射 DROP INDEX。 ─────

  // ───── P14: 新增或重建外键 ─────
  const fksToAdd = all(to, 'foreignKey')
    .filter((fk) => !inFrom(fk.id) || fkRebuild.has(fk.id))
    .sort(
      (a, b) =>
        get(to, a.parent, 'table').name.localeCompare(get(to, b.parent, 'table').name) ||
        a.name.localeCompare(b.name),
    );
  for (const fk of fksToAdd) {
    const t = get(to, fk.parent, 'table');
    const refT = get(to, fk.refTable, 'table');
    emit(
      'addForeignKey',
      fk.name,
      renderMysqlAddForeignKey(
        fk,
        t.name,
        (id) => get(to, id, 'column').name,
        refT.name,
        (id) => get(to, id, 'column').name,
      ),
    );
  }

  // ───── P15: 创建新增或重建的不透明对象 ─────
  const opaquesToCreate = all(to, 'opaque').filter((o) => !inFrom(o.id) || opaquesToDrop.has(o.id));
  const createRoutines = topoOpaques(opaquesToCreate.filter((o) => EARLY_OPAQUE.has(o.objType)));
  const createViews = topoOpaques(opaquesToCreate.filter((o) => o.objType === 'view'));
  const createTriggers = topoOpaques(
    opaquesToCreate.filter((o) => o.objType !== 'view' && !EARLY_OPAQUE.has(o.objType)),
  );
  for (const op of [...createRoutines, ...createViews, ...createTriggers]) {
    for (const ddl of op.ddl) emit('createOpaque', op.name, ddl);
  }

  return steps;
};
