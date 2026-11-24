// SQLite 迁移规划器：生成标准 SQLite DDL 与官方 12 步表重建步骤。
// 规划时维护当前状态 cur，确保每条语句引用的都是当时实际存在的表/列名。
import type { Check, Column, ForeignKey, Index, Model, Opaque, PrimaryKey, Table, Unique } from '../ir.ts';
import { deepEqual } from '../json.ts';
import { all, childrenOf, columnsOf, get, withModelIndex } from '../model.ts';
import { PlanError, type Step } from '../plan-types.ts';
import {
  sqliteExprReferences,
  sqliteIdent,
  sqliteLiteral,
  sqliteRenameInExpr,
  sqliteTokenize,
} from './quote.ts';

const same = deepEqual;

const FK_ACTION: Record<ForeignKey['onDelete'], string> = {
  noAction: 'NO ACTION',
  restrict: 'RESTRICT',
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  setDefault: 'SET DEFAULT',
};

/**
 * 判断表达式是否是 SQLite 允许在 `DEFAULT <expr>` 不加括号的字面量/时间关键字。
 * 其它任意表达式必须写成 `DEFAULT (<expr>)`。
 */
const isBareSqliteDefault = (expr: string): boolean => {
  const t = expr.trim();
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return true;
  if (/^'(?:[^']|'')*'$/.test(t)) return true;
  if (/^[xX]'[0-9a-fA-F]*'$/.test(t)) return true;
  if (/^(?:null|true|false|current_time|current_date|current_timestamp)$/i.test(t)) return true;
  // 已由最外层平衡括号包裹
  if (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i]!;
      if (inStr) {
        if (ch === "'" && t[i + 1] === "'") i++;
        else if (ch === "'") inStr = false;
      } else if (ch === "'") {
        inStr = true;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0 && i < t.length - 1) return false;
      }
    }
    return depth === 0;
  }
  return false;
};

/** SQLite ALTER TABLE ADD COLUMN 只允许字面量常量默认值（不允许 CURRENT_TIMESTAMP 或表达式） */
const isSimpleConstantDefault = (expr: string): boolean => {
  const t = expr.trim();
  return (
    /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t) ||
    /^'(?:[^']|'')*'$/.test(t) ||
    /^[xX]'[0-9a-fA-F]*'$/.test(t) ||
    /^(?:null|true|false)$/i.test(t)
  );
};

export const formatSqliteDefault = (expr: string): string =>
  isBareSqliteDefault(expr) ? expr.trim() : `(${expr.trim()})`;

/** 渲染单列定义；若该列承载 inline AUTOINCREMENT 主键则一并输出 */
const renderColumnDef = (c: Column, inlinePk: PrimaryKey | null): string => {
  const parts: string[] = [sqliteIdent(c.name), c.type];
  if (c.notNull) parts.push('NOT NULL');
  if (inlinePk) {
    if (inlinePk.nameMode === 'explicit' && inlinePk.name) {
      parts.push(`CONSTRAINT ${sqliteIdent(inlinePk.name)}`);
    }
    parts.push('PRIMARY KEY');
    if (c.ext?.sqlite?.autoincrement) parts.push('AUTOINCREMENT');
  }
  if (c.generated) {
    parts.push(`GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`);
  } else if (c.default) {
    if ('nextval' in c.default) throw new PlanError(`SQLite 不支持序列默认值（列 ${c.name}）`);
    parts.push(`DEFAULT ${formatSqliteDefault(c.default.expr)}`);
  }
  if (c.collation) parts.push(`COLLATE ${sqliteIdent(c.collation)}`);
  return parts.join(' ');
};

const constraintPrefix = (o: { name: string; nameMode: 'derived' | 'explicit' }): string =>
  o.nameMode === 'explicit' && o.name ? `CONSTRAINT ${sqliteIdent(o.name)} ` : '';

/** 渲染表级约束（不含已 inline 到列的 AUTOINCREMENT 主键；推导名省略 CONSTRAINT 子句以契合 SQLite 惯例并支持原地改表/改列名） */
const renderTableConstraints = (m: Model, tableId: string, inlinePkId: string | null): string[] => {
  const out: string[] = [];
  const colN = (id: string) => get(m, id, 'column').name;
  for (const pk of childrenOf(m, tableId, 'primaryKey')) {
    if (pk.id === inlinePkId) continue;
    out.push(
      `${constraintPrefix(pk)}PRIMARY KEY (${pk.columns.map((c) => sqliteIdent(colN(c))).join(', ')})`,
    );
  }
  for (const u of childrenOf(m, tableId, 'unique').sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`${constraintPrefix(u)}UNIQUE (${u.columns.map((c) => sqliteIdent(colN(c))).join(', ')})`);
  }
  for (const ck of childrenOf(m, tableId, 'check').sort((a, b) => a.name.localeCompare(b.name))) {
    out.push(`${constraintPrefix(ck)}CHECK (${ck.expr})`);
  }
  for (const fk of childrenOf(m, tableId, 'foreignKey').sort((a, b) => a.name.localeCompare(b.name))) {
    const refTable = get(m, fk.refTable, 'table');
    const cols = fk.columns.map((c) => sqliteIdent(colN(c))).join(', ');
    const refCols = fk.refColumns.map((c) => sqliteIdent(colN(c))).join(', ');
    let s = `${constraintPrefix(fk)}FOREIGN KEY (${cols}) REFERENCES ${sqliteIdent(refTable.name)} (${refCols})`;
    if (fk.onDelete !== 'noAction') s += ` ON DELETE ${FK_ACTION[fk.onDelete]}`;
    if (fk.onUpdate !== 'noAction') s += ` ON UPDATE ${FK_ACTION[fk.onUpdate]}`;
    if (fk.deferrable) {
      s += fk.initiallyDeferred ? ' DEFERRABLE INITIALLY DEFERRED' : ' DEFERRABLE INITIALLY IMMEDIATE';
    }
    out.push(s);
  }
  return out;
};

/** 渲染完整 CREATE TABLE 语句（可选替换表名用于 12 步重建临时表） */
export const renderSqliteCreateTable = (m: Model, tableId: string, overrideName?: string): string => {
  const t = get(m, tableId, 'table');
  const cols = columnsOf(m, tableId);
  const pks = childrenOf(m, tableId, 'primaryKey');
  const pk = pks[0] ?? null;
  let inlinePkColId: string | null = null;
  if (pk && pk.columns.length === 1) {
    const c = get(m, pk.columns[0]!, 'column');
    if (c.ext?.sqlite?.autoincrement) inlinePkColId = c.id;
  }
  const items = [
    ...cols.map((c) => renderColumnDef(c, c.id === inlinePkColId ? pk : null)),
    ...renderTableConstraints(m, tableId, inlinePkColId ? pk!.id : null),
  ];
  const opts: string[] = [];
  if (t.ext?.sqlite?.withoutRowid) opts.push('WITHOUT ROWID');
  if (t.ext?.sqlite?.strict) opts.push('STRICT');
  const suffix = opts.length ? ` ${opts.join(', ')}` : '';
  return `CREATE TABLE ${sqliteIdent(overrideName ?? t.name)} (${items.join(', ')})${suffix}`;
};

/** 渲染 CREATE [UNIQUE] INDEX 语句 */
export const renderSqliteCreateIndex = (m: Model, idx: Index): string => {
  const t = get(m, idx.parent, 'table');
  const els = idx.elements.map((e) => {
    let s = e.column ? sqliteIdent(get(m, e.column, 'column').name) : `(${e.expr})`;
    if (e.collation) s += ` COLLATE ${sqliteIdent(e.collation)}`;
    if (e.desc) s += ' DESC';
    return s;
  });
  let sql = `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${sqliteIdent(idx.name)} ON ${sqliteIdent(t.name)} (${els.join(', ')})`;
  if (idx.where) sql += ` WHERE ${idx.where}`;
  return sql;
};

/** 按外键依赖对一组表做拓扑排序（被引用表在前；有环时退回稳定字母序） */
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

/** Tarjan 强连通分量 + 逆拓扑序（依赖目标先产出） */
const topoSccs = (nodes: string[], depsOf: (id: string) => Iterable<string>): string[][] => {
  const nodeSet = new Set(nodes);
  let idx = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string) => {
    index.set(v, idx);
    lowlink.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of depsOf(v)) {
      if (!nodeSet.has(w) || w === v) continue;
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp);
    }
  };

  for (const n of nodes) if (!index.has(n)) strongconnect(n);
  return sccs;
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

/** 按表达式语义归一化（用于比对列改名后是否仅是改名导致的变化） */
const migrateExprForRenames = (expr: string, renames: [string, string][]): string => {
  let out = expr;
  for (const [oldName, newName] of renames) out = sqliteRenameInExpr(out, oldName, newName);
  return out;
};

const indexDef = (idx: Index, renames: [string, string][]): unknown => ({
  name: idx.name,
  unique: idx.unique,
  elements: idx.elements.map((e) => ({
    column: e.column,
    expr: e.expr ? migrateExprForRenames(e.expr, renames) : null,
    desc: e.desc,
    collation: e.collation,
  })),
  where: idx.where ? migrateExprForRenames(idx.where, renames) : null,
});

const explicitConName = (o: { name: string; nameMode: 'derived' | 'explicit' }): string | null =>
  o.nameMode === 'explicit' ? o.name : null;

const constraintDef = (o: PrimaryKey | Unique | ForeignKey | Check, renames: [string, string][]): unknown => {
  switch (o.kind) {
    case 'primaryKey':
      return { kind: o.kind, name: explicitConName(o), columns: o.columns };
    case 'unique':
      return { kind: o.kind, name: explicitConName(o), columns: o.columns };
    case 'check':
      return { kind: o.kind, name: explicitConName(o), expr: migrateExprForRenames(o.expr, renames) };
    case 'foreignKey':
      return {
        kind: o.kind,
        name: explicitConName(o),
        columns: o.columns,
        refTable: o.refTable,
        refColumns: o.refColumns,
        onDelete: o.onDelete,
        onUpdate: o.onUpdate,
        deferrable: o.deferrable,
        initiallyDeferred: o.initiallyDeferred,
      };
  }
};

const columnDef = (c: Column, renames: [string, string][]): unknown => ({
  type: c.type,
  notNull: c.notNull,
  default:
    c.default && 'expr' in c.default ? { expr: migrateExprForRenames(c.default.expr, renames) } : c.default,
  generated: c.generated
    ? { expr: migrateExprForRenames(c.generated.expr, renames), stored: c.generated.stored }
    : null,
  collation: c.collation,
  autoincrement: Boolean(c.ext?.sqlite?.autoincrement),
});

/** 将一个 SQLite 模型从空库建出 */
export const sqliteCreateAll = (m: Model): Step[] => {
  if (m.dialect !== 'sqlite') throw new PlanError(`预期 sqlite 模型，实际为 ${m.dialect}`);
  return withModelIndex(m, () => {
    const steps: Step[] = [];
    const tableIds = topoTables(
      m,
      all(m, 'table').map((t) => t.id),
    );
    for (const tid of tableIds) {
      const t = get(m, tid, 'table');
      steps.push({ kind: 'createTable', target: t.name, sql: renderSqliteCreateTable(m, tid) });
    }
    for (const idx of all(m, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
      steps.push({ kind: 'createIndex', target: idx.name, sql: renderSqliteCreateIndex(m, idx) });
    }
    for (const op of topoOpaques(all(m, 'opaque'))) {
      for (const ddl of op.ddl) {
        steps.push({ kind: 'createOpaque', target: op.name, sql: ddl });
      }
    }
    return steps;
  });
};

/** 比较两个 SQLite 模型，生成最小且安全可回滚的迁移步骤（按需触发官方 12 步表重建） */
export const sqlitePlan = (from: Model, to: Model): Step[] => {
  if (from.dialect !== 'sqlite' || to.dialect !== 'sqlite') {
    throw new PlanError(`sqlitePlan 需要 sqlite 模型，收到 ${from.dialect} -> ${to.dialect}`);
  }
  return withModelIndex(from, () =>
    withModelIndex(to, () => {
      const steps: Step[] = [];
      const emit = (kind: string, target: string, sql: string, transactional?: boolean) =>
        steps.push(
          transactional === undefined ? { kind, target, sql } : { kind, target, sql, transactional },
        );

      const inFrom = (id: string) => Object.hasOwn(from.objects, id);
      const inTo = (id: string) => Object.hasOwn(to.objects, id);

      // 维护当前真实表名与已占用名，保证临时名永不冲突
      const usedNamesLower = new Set<string>();
      const registerUsed = (m: Model) => {
        for (const o of Object.values(m.objects)) {
          if (o.kind === 'table' || o.kind === 'index' || o.kind === 'opaque') {
            usedNamesLower.add(o.name.toLowerCase());
          }
        }
      };
      registerUsed(from);
      registerUsed(to);
      let tmpSeq = 0;
      const allocTmp = () => {
        for (;;) {
          const candidate = `_dowel_tmp_${++tmpSeq}`;
          if (!usedNamesLower.has(candidate)) {
            usedNamesLower.add(candidate);
            return candidate;
          }
        }
      };

      const fromTables = all(from, 'table');
      const toTables = all(to, 'table');
      const removedTables = fromTables.filter((t) => !inTo(t.id));
      const addedTables = toTables.filter((t) => !inFrom(t.id));
      const commonTables = toTables.filter((t) => inFrom(t.id));

      // 每张公共表的列改名映射
      const colRenamesByTable = new Map<string, [string, string][]>();
      for (const t of commonTables) {
        const renames: [string, string][] = [];
        for (const tc of columnsOf(to, t.id)) {
          const fc = from.objects[tc.id];
          if (fc?.kind === 'column' && fc.parent === t.id && fc.name !== tc.name) {
            renames.push([fc.name, tc.name]);
          }
        }
        colRenamesByTable.set(t.id, renames);
      }

      // 判断索引是否需要删建
      const removedIndexes = all(from, 'index').filter((ix) => !inTo(ix.id));
      const changedIndexIds = new Set<string>();
      for (const ix of all(to, 'index')) {
        if (!inFrom(ix.id)) continue;
        const prev = from.objects[ix.id] as Index;
        const renames = colRenamesByTable.get(ix.parent) ?? [];
        if (!same(indexDef(prev, renames), indexDef(ix, []))) {
          changedIndexIds.add(ix.id);
        }
      }

      // 判断每张公共表是否必须走 12 步表重建
      const rebuilding = new Set<string>();
      const tableRenameIds = new Set<string>();
      for (const t of commonTables) {
        const prev = from.objects[t.id] as Table;
        if (prev.name !== t.name) tableRenameIds.add(t.id);
        const renames = colRenamesByTable.get(t.id) ?? [];

        const needsRebuild = (): boolean => {
          // 1. 表选项变更（STRICT / WITHOUT ROWID）
          if (Boolean(prev.ext?.sqlite?.strict) !== Boolean(t.ext?.sqlite?.strict)) return true;
          if (Boolean(prev.ext?.sqlite?.withoutRowid) !== Boolean(t.ext?.sqlite?.withoutRowid)) return true;

          // 2. 任意表级约束（PK / UNIQUE / FK / CHECK）增删改名改定义
          for (const kind of ['primaryKey', 'unique', 'foreignKey', 'check'] as const) {
            const prevList = childrenOf(from, t.id, kind);
            const nextList = childrenOf(to, t.id, kind);
            if (prevList.length !== nextList.length) return true;
            const prevMap = new Map(prevList.map((x) => [x.id, x]));
            for (const nx of nextList) {
              const px = prevMap.get(nx.id);
              if (!px) return true;
              if (!same(constraintDef(px, renames), constraintDef(nx, []))) return true;
            }
          }

          // 3. 公共列定义变更
          const fromCols = columnsOf(from, t.id);
          const toCols = columnsOf(to, t.id);
          const fromColMap = new Map(fromCols.map((c) => [c.id, c]));
          const toColMap = new Map(toCols.map((c) => [c.id, c]));
          for (const tc of toCols) {
            const fc = fromColMap.get(tc.id);
            if (fc) {
              if (!same(columnDef(fc, renames), columnDef(tc, []))) return true;
            } else {
              // 新增列：是否满足 ALTER TABLE ADD COLUMN 的严格安全条件
              if (tc.generated) return true;
              if (tc.ext?.sqlite?.autoincrement) return true;
              if (tc.notNull && !tc.default) return true;
              if (tc.default) {
                if ('nextval' in tc.default || !isSimpleConstantDefault(tc.default.expr)) return true;
              }
            }
          }

          // 4. 删除列：是否满足 ALTER TABLE DROP COLUMN 的严格安全条件
          const droppedCols = fromCols.filter((fc) => !toColMap.has(fc.id));
          if (droppedCols.length > 0) {
            // 如果删完剩余列为 0（随后又加新列），SQLite 不允许表无列，走重建
            if (fromCols.length - droppedCols.length === 0) return true;
            const droppedIds = new Set(droppedCols.map((c) => c.id));
            const droppedNames = droppedCols.map((c) => c.name);
            // 检查是否被本表保留约束/生成列/保留索引引用
            for (const pk of childrenOf(to, t.id, 'primaryKey')) {
              if (pk.columns.some((c) => droppedIds.has(c))) return true;
            }
            for (const u of childrenOf(to, t.id, 'unique')) {
              if (u.columns.some((c) => droppedIds.has(c))) return true;
            }
            for (const fk of childrenOf(to, t.id, 'foreignKey')) {
              if (fk.columns.some((c) => droppedIds.has(c))) return true;
            }
            for (const ck of childrenOf(to, t.id, 'check')) {
              if (droppedNames.some((n) => sqliteExprReferences(ck.expr, n))) return true;
            }
            for (const tc of toCols) {
              if (tc.generated && droppedNames.some((n) => sqliteExprReferences(tc.generated!.expr, n))) {
                return true;
              }
            }
            for (const ix of childrenOf(from, t.id, 'index')) {
              if (!inTo(ix.id) || changedIndexIds.has(ix.id)) continue;
              if (
                ix.elements.some(
                  (e) =>
                    (e.column && droppedIds.has(e.column)) ||
                    (e.expr && droppedNames.some((n) => sqliteExprReferences(e.expr!, n))),
                ) ||
                (ix.where && droppedNames.some((n) => sqliteExprReferences(ix.where!, n)))
              ) {
                return true;
              }
            }
            // 被非重建、非删除的其它表的外键引用
            for (const fk of all(from, 'foreignKey')) {
              if (fk.refTable === t.id && fk.refColumns.some((c) => droppedIds.has(c)) && inTo(fk.id)) {
                return true;
              }
            }
          }

          // 5. 若列改名涉及到大小写冲突或与其他被删除/新增列复杂交互，安全起见也可走原地（下面有两阶段改名）
          return false;
        };

        if (needsRebuild()) rebuilding.add(t.id);
      }

      // H3 不动点闭包：若被引用表走 12 步重建且其被引用列同时改名，由于被引用表跳过 S5a 的 RENAME COLUMN，
      // SQLite 不会自动改写子表外键中的被引用列名，必须将引用表一并纳入重建集合并在同一原子事务中重建。
      for (let changed = true; changed;) {
        changed = false;
        for (const fk of all(to, 'foreignKey')) {
          if (!inFrom(fk.parent) || rebuilding.has(fk.parent)) continue;
          if (!rebuilding.has(fk.refTable)) continue;
          const refColRenamed = fk.refColumns.some((rcId) => {
            const fc = from.objects[rcId];
            const tc = to.objects[rcId];
            return fc?.kind === 'column' && tc?.kind === 'column' && fc.name !== tc.name;
          });
          if (refColRenamed) {
            rebuilding.add(fk.parent);
            changed = true;
          }
        }
      }

      // ───── S1: 删除被移除 / 变更 / 依赖变更表的不透明对象（视图、触发器） ─────
      const touchedTableIds = new Set<string>([
        ...removedTables.map((t) => t.id),
        ...rebuilding,
        ...tableRenameIds,
      ]);
      const touchedColIds = new Set<string>();
      for (const c of all(from, 'column')) {
        if (touchedTableIds.has(c.parent) || !inTo(c.id)) {
          touchedColIds.add(c.id);
          continue;
        }
        const next = to.objects[c.id];
        if (next?.kind === 'column' && next.name !== c.name) touchedColIds.add(c.id);
      }
      const touchedTableNamesLower = new Set<string>();
      for (const tid of touchedTableIds) {
        const ft = from.objects[tid];
        const tt = to.objects[tid];
        if (ft?.kind === 'table') touchedTableNamesLower.add(ft.name.toLowerCase());
        if (tt?.kind === 'table') touchedTableNamesLower.add(tt.name.toLowerCase());
      }
      const ddlMentionsTouchedTable = (ddl: string[]): boolean => {
        if (touchedTableNamesLower.size === 0) return false;
        for (const sql of ddl) {
          for (const tok of sqliteTokenize(sql)) {
            if (
              (tok.kind === 'ident' || tok.kind === 'qident') &&
              touchedTableNamesLower.has(tok.text.toLowerCase())
            ) {
              return true;
            }
          }
        }
        return false;
      };
      const opaquesToDrop = new Set<string>();
      const opaqueChanged = (op: Opaque): boolean => {
        const next = to.objects[op.id];
        if (!next || next.kind !== 'opaque') return true;
        return !same([op.objType, op.name, op.ddl, op.drop], [next.objType, next.name, next.ddl, next.drop]);
      };
      for (const op of all(from, 'opaque')) {
        if (
          opaqueChanged(op) ||
          touchedTableIds.has(op.parent) ||
          op.deps.some((d) => touchedTableIds.has(d) || touchedColIds.has(d)) ||
          (touchedTableIds.size > 0 && (op.objType === 'view' || ddlMentionsTouchedTable(op.ddl)))
        ) {
          opaquesToDrop.add(op.id);
        }
      }
      // 级联：依赖了要删除的不透明对象的其它不透明对象也先删后建
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
      const dropOpaqueList = topoOpaques(
        all(from, 'opaque').filter((o) => opaquesToDrop.has(o.id)),
      ).reverse();
      for (const op of dropOpaqueList) {
        emit('dropOpaque', op.name, op.drop);
      }

      // ───── S2: 删除被移除 / 变更 / 名字冲突的索引 ─────
      // 注意：若某索引属于即将 DROP 的表且名字不与新表冲突，DROP TABLE 会自动删除它；
      // 但为了彻底避免表名/索引名跨表复用时的冲突（SQLite 表和索引共享命名空间），显式删除全部移除或变更的索引。
      const droppedIndexIds = new Set<string>();
      for (const ix of [...removedIndexes, ...all(from, 'index').filter((x) => changedIndexIds.has(x.id))]) {
        if (droppedIndexIds.has(ix.id)) continue;
        droppedIndexIds.add(ix.id);
        emit('dropIndex', ix.name, `DROP INDEX ${sqliteIdent(ix.name)}`);
      }

      // ───── S3: 删除无存活表外键指向的已移除表（其余记入 deferredDropTables） ─────
      const removedTableIds = new Set(removedTables.map((t) => t.id));
      const blockedRemoved = new Set<string>();
      for (const fk of all(from, 'foreignKey')) {
        if (!removedTableIds.has(fk.parent) && removedTableIds.has(fk.refTable)) {
          blockedRemoved.add(fk.refTable);
        }
      }
      // 若被移除表 A 引用了被移除表 B 且 B 被存活表引用，A 可以先删（A 引用 B，删 A 不影响 B）
      const immediateDropIds = topoTables(
        from,
        removedTables.filter((t) => !blockedRemoved.has(t.id)).map((t) => t.id),
      ).reverse();
      for (const tid of immediateDropIds) {
        const t = get(from, tid, 'table');
        emit('dropTable', t.name, `DROP TABLE ${sqliteIdent(t.name)}`);
      }

      // 追踪当前库中每个未删除表的实际名字（含 deferredDropTables）
      const curTableName = new Map<string, string>();
      for (const t of fromTables) {
        if (!removedTableIds.has(t.id) || blockedRemoved.has(t.id)) {
          curTableName.set(t.id, t.name);
        }
      }

      // 如果 deferredDropTables 中某张表的名字会与新表或改名后的表/索引冲突，先暂存到临时表名
      const targetNamesLower = new Set<string>([
        ...toTables.map((t) => t.name.toLowerCase()),
        ...all(to, 'index').map((i) => i.name.toLowerCase()),
      ]);
      for (const tid of blockedRemoved) {
        const cur = curTableName.get(tid)!;
        if (targetNamesLower.has(cur.toLowerCase())) {
          const tmp = allocTmp();
          emit('renameTable', cur, `ALTER TABLE ${sqliteIdent(cur)} RENAME TO ${sqliteIdent(tmp)}`);
          curTableName.set(tid, tmp);
        }
      }

      // ───── S4: 表改名（处理环与碰撞，含大小写变更） ─────
      const activeLowerToId = (): Map<string, string> => {
        const map = new Map<string, string>();
        for (const [id, name] of curTableName) map.set(name.toLowerCase(), id);
        return map;
      };
      const pendingRenames = commonTables.filter((t) => curTableName.get(t.id) !== t.name);
      if (pendingRenames.length > 0) {
        // 第一轮：目标名被另一张存活表占用的，先移到临时名
        for (const t of pendingRenames) {
          const occupant = activeLowerToId().get(t.name.toLowerCase());
          if (occupant && occupant !== t.id) {
            const occName = curTableName.get(occupant)!;
            const tmp = allocTmp();
            emit('renameTable', occName, `ALTER TABLE ${sqliteIdent(occName)} RENAME TO ${sqliteIdent(tmp)}`);
            curTableName.set(occupant, tmp);
          }
          // 再次检查 cur（可能刚刚自己被挪到了 tmp）
          const actualCur = curTableName.get(t.id)!;
          if (actualCur !== t.name) {
            emit(
              'renameTable',
              t.name,
              `ALTER TABLE ${sqliteIdent(actualCur)} RENAME TO ${sqliteIdent(t.name)}`,
            );
            curTableName.set(t.id, t.name);
          }
        }
        // 兜底：若还有被挪到临时名但本身无需改名的表（例如 A->B 且 B->A），把它归位到目标名
        for (const t of commonTables) {
          const actualCur = curTableName.get(t.id)!;
          if (actualCur !== t.name) {
            emit(
              'renameTable',
              t.name,
              `ALTER TABLE ${sqliteIdent(actualCur)} RENAME TO ${sqliteIdent(t.name)}`,
            );
            curTableName.set(t.id, t.name);
          }
        }
      }

      // ───── S5a: 非重建表的列改名与列追加（先于 S6，确保新建/重建表的外键能引用新/改名列） ─────
      const droppedColFinalNames = new Map<string, string>();
      for (const t of commonTables) {
        if (rebuilding.has(t.id)) continue;
        const fromCols = columnsOf(from, t.id);
        const toCols = columnsOf(to, t.id);
        const curColName = new Map(fromCols.map((c) => [c.id, c.name]));
        const activeColLower = () => {
          const map = new Map<string, string>();
          for (const [id, name] of curColName) map.set(name.toLowerCase(), id);
          return map;
        };

        // 列改名（两阶段防环、防与即将删除列重名）
        const colRenames = toCols.filter((tc) => curColName.has(tc.id) && curColName.get(tc.id) !== tc.name);
        for (const tc of colRenames) {
          const occupant = activeColLower().get(tc.name.toLowerCase());
          if (occupant && occupant !== tc.id) {
            const occName = curColName.get(occupant)!;
            const tmp = allocTmp();
            emit(
              'renameColumn',
              `${t.name}.${occName}`,
              `ALTER TABLE ${sqliteIdent(t.name)} RENAME COLUMN ${sqliteIdent(occName)} TO ${sqliteIdent(tmp)}`,
            );
            curColName.set(occupant, tmp);
          }
          const actualCur = curColName.get(tc.id)!;
          if (actualCur !== tc.name) {
            emit(
              'renameColumn',
              `${t.name}.${tc.name}`,
              `ALTER TABLE ${sqliteIdent(t.name)} RENAME COLUMN ${sqliteIdent(actualCur)} TO ${sqliteIdent(tc.name)}`,
            );
            curColName.set(tc.id, tc.name);
          }
        }
        // 归位可能被临时挪开的保留列
        for (const tc of toCols) {
          if (!curColName.has(tc.id)) continue;
          const actualCur = curColName.get(tc.id)!;
          if (actualCur !== tc.name) {
            emit(
              'renameColumn',
              `${t.name}.${tc.name}`,
              `ALTER TABLE ${sqliteIdent(t.name)} RENAME COLUMN ${sqliteIdent(actualCur)} TO ${sqliteIdent(tc.name)}`,
            );
            curColName.set(tc.id, tc.name);
          }
        }

        // 若新增列与即将删除的列重名，先把待删除列挪走，或者等 S6c 删完再加；这里直接先挪到临时名更简单
        const addedCols = toCols.filter((tc) => !curColName.has(tc.id));
        for (const ac of addedCols) {
          const occupant = activeColLower().get(ac.name.toLowerCase());
          if (occupant) {
            const occName = curColName.get(occupant)!;
            const tmp = allocTmp();
            emit(
              'renameColumn',
              `${t.name}.${occName}`,
              `ALTER TABLE ${sqliteIdent(t.name)} RENAME COLUMN ${sqliteIdent(occName)} TO ${sqliteIdent(tmp)}`,
            );
            curColName.set(occupant, tmp);
          }
          emit(
            'addColumn',
            `${t.name}.${ac.name}`,
            `ALTER TABLE ${sqliteIdent(t.name)} ADD COLUMN ${renderColumnDef(ac, null)}`,
          );
          curColName.set(ac.id, ac.name);
        }

        // 记下最终待删除列名供 S6c 使用
        for (const fc of fromCols) {
          if (!inTo(fc.id)) {
            droppedColFinalNames.set(fc.id, curColName.get(fc.id)!);
          }
        }
      }

      // ───── S6: SCC 拓扑排序执行 CREATE TABLE（新表）与 12 步 rebuildTable（重建表） ─────
      const s6Nodes = [...addedTables.map((t) => t.id), ...rebuilding].sort((a, b) =>
        get(to, a, 'table').name.localeCompare(get(to, b, 'table').name),
      );
      const s6Set = new Set(s6Nodes);
      const s6Deps = new Map<string, Set<string>>();
      for (const id of s6Nodes) s6Deps.set(id, new Set());

      // 依赖边 u -> v 表示“v 必须在 u 之前完成”：
      // 1) 在目标模型 to 中，如果表 u 有 FK 指向表 v，则 v 必须在 u 之前（保证 PRAGMA foreign_key_check 时目标表与键已就绪）
      for (const fk of all(to, 'foreignKey')) {
        if (s6Set.has(fk.parent) && s6Set.has(fk.refTable) && fk.parent !== fk.refTable) {
          s6Deps.get(fk.parent)!.add(fk.refTable);
        }
      }
      // 2) 在源模型 from 中，如果重建表 c 有 FK 指向重建表 p，且该 FK 在目标模型中被移除或变更（或 p 的被引用键变了），
      //    则 c 应在 p 之前重建（或与 p 合并为同一个 SCC 原子重建），避免 p 重建完跑 foreign_key_check 时 c 的旧 FK 报错
      for (const fk of all(from, 'foreignKey')) {
        if (rebuilding.has(fk.parent) && rebuilding.has(fk.refTable) && fk.parent !== fk.refTable) {
          s6Deps.get(fk.refTable)!.add(fk.parent);
        }
      }

      // 记录哪些索引已在 rebuildTable 事务块内重建，S7 跳过它们
      const indexesRecreatedInRebuild = new Set<string>();

      const buildRebuildStmts = (tid: string): string[] => {
        const t = get(to, tid, 'table');
        const tmpName = allocTmp();
        const stmts: string[] = [];
        stmts.push(renderSqliteCreateTable(to, tid, tmpName));

        // 拷贝交集非生成列（按列 ID 映射，支持列改名）
        const fromCols = new Map(columnsOf(from, tid).map((c) => [c.id, c]));
        const copyPairs: [string, string][] = [];
        for (const tc of columnsOf(to, tid)) {
          if (tc.generated) continue;
          const fc = fromCols.get(tc.id);
          if (fc) copyPairs.push([tc.name, fc.name]);
        }
        if (copyPairs.length > 0) {
          const dstCols = copyPairs.map(([dst]) => sqliteIdent(dst)).join(', ');
          const srcCols = copyPairs.map(([, src]) => sqliteIdent(src)).join(', ');
          stmts.push(
            `INSERT INTO ${sqliteIdent(tmpName)} (${dstCols}) SELECT ${srcCols} FROM ${sqliteIdent(t.name)}`,
          );
        }
        // 保留 AUTOINCREMENT 高水位（sqlite_sequence）：防止清空或删除末尾行后重建导致主键 ID 回退复用
        if (columnsOf(to, tid).some((c) => c.ext?.sqlite?.autoincrement)) {
          const oldLit = sqliteLiteral(t.name);
          const tmpLit = sqliteLiteral(tmpName);
          stmts.push(
            `UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = ${oldLit}), 0)) WHERE name = ${tmpLit}`,
            `INSERT INTO sqlite_sequence (name, seq) SELECT ${tmpLit}, seq FROM sqlite_sequence WHERE name = ${oldLit} AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ${tmpLit})`,
          );
        }
        stmts.push(`DROP TABLE ${sqliteIdent(t.name)}`);
        stmts.push(`ALTER TABLE ${sqliteIdent(tmpName)} RENAME TO ${sqliteIdent(t.name)}`);

        // 在同一原子事务内重建该表上的未变更索引（被 DROP TABLE 带走）
        for (const ix of childrenOf(to, tid, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
          if (inFrom(ix.id) && !changedIndexIds.has(ix.id)) {
            stmts.push(renderSqliteCreateIndex(to, ix));
            indexesRecreatedInRebuild.add(ix.id);
          }
        }
        return stmts;
      };

      const sccs = topoSccs(s6Nodes, (id) => s6Deps.get(id) ?? []);
      for (const comp of sccs) {
        const hasRebuild = comp.some((id) => rebuilding.has(id));
        if (!hasRebuild && comp.length === 1) {
          const tid = comp[0]!;
          const t = get(to, tid, 'table');
          emit('createTable', t.name, renderSqliteCreateTable(to, tid));
          continue;
        }
        // 单个或多个表需要 12 步表重建（或相互 FK 环需要原子重建）：
        // 官方 12 步：事务外关闭外键检查 -> BEGIN IMMEDIATE -> 建新表/拷贝/删旧表/改名/重建索引 -> PRAGMA foreign_key_check -> COMMIT -> 事务外开启外键检查
        const stmts: string[] = ['PRAGMA foreign_keys = OFF', 'BEGIN IMMEDIATE'];
        const orderedComp = topoTables(to, comp);
        for (const tid of orderedComp) {
          if (rebuilding.has(tid)) {
            stmts.push(...buildRebuildStmts(tid));
          } else {
            stmts.push(renderSqliteCreateTable(to, tid));
          }
        }
        // PRAGMA foreign_key_check 供执行器产出明细错误；紧随的 _dowel_fk_guard 保证离线 sqlite3 CLI 遇违例也能强制中止并回滚事务
        stmts.push(
          'PRAGMA foreign_key_check',
          'CREATE TEMP TABLE _dowel_fk_guard (x INT NOT NULL)',
          'INSERT INTO temp._dowel_fk_guard SELECT NULL FROM pragma_foreign_key_check LIMIT 1',
          'DROP TABLE temp._dowel_fk_guard',
          'COMMIT',
          'PRAGMA foreign_keys = ON',
        );
        const targetLabel = orderedComp.map((id) => get(to, id, 'table').name).join(', ');
        emit('rebuildTable', targetLabel, stmts.join(';\n'), false);
      }

      // ───── S6b: 删除延迟移除的表（其存活引用表已在 S6 中完成重建脱离外键） ─────
      if (blockedRemoved.size > 0) {
        const deferredOrder = topoTables(from, [...blockedRemoved]).reverse();
        for (const tid of deferredOrder) {
          const name = curTableName.get(tid)!;
          emit('dropTable', get(from, tid, 'table').name, `DROP TABLE ${sqliteIdent(name)}`);
        }
      }

      // ───── S6c: 非重建表的安全 DROP COLUMN ─────
      for (const t of commonTables) {
        if (rebuilding.has(t.id)) continue;
        for (const fc of columnsOf(from, t.id)) {
          if (inTo(fc.id)) continue;
          const actualName = droppedColFinalNames.get(fc.id) ?? fc.name;
          emit(
            'dropColumn',
            `${t.name}.${fc.name}`,
            `ALTER TABLE ${sqliteIdent(t.name)} DROP COLUMN ${sqliteIdent(actualName)}`,
          );
        }
      }

      // ───── S7: 创建新增或变更的索引 ─────
      for (const ix of all(to, 'index').sort((a, b) => a.name.localeCompare(b.name))) {
        if (indexesRecreatedInRebuild.has(ix.id)) continue;
        if (!inFrom(ix.id) || changedIndexIds.has(ix.id)) {
          emit('createIndex', ix.name, renderSqliteCreateIndex(to, ix));
        }
      }

      // ───── S8: 创建新增或被删除重放的不透明对象（视图、触发器） ─────
      const opaquesToCreate = all(to, 'opaque').filter((op) => !inFrom(op.id) || opaquesToDrop.has(op.id));
      for (const op of topoOpaques(opaquesToCreate)) {
        for (const ddl of op.ddl) {
          emit('createOpaque', op.name, ddl);
        }
      }

      return steps;
    }),
  );
};
