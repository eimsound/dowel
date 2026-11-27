import {
  type DialectNaming,
  exprRefNames,
  nameKey,
  type NameSpec,
  runDerivedNames,
  singleReferencedColumn,
} from '../derived-names.ts';
// PostgreSQL 方言规格实现（包装既有 PG 模块，保证 100% 向后兼容）。
import type { DialectCapabilities, DialectSpec, IdentKind } from '../dialect.ts';
import { type Column, emptyModel, type Model, type Obj, type Sequence } from '../ir.ts';
import {
  all,
  allChildrenOf,
  childrenOf,
  colName,
  columnsOf,
  effectiveColumnsOf,
  find,
  get,
  getActiveModelIndex,
  indexElementNames,
  OverlayModelIndex,
  partitionAncestors,
  partitionDescendants,
  partitionsOf,
  requiredUniquePartitionKeys,
  rootTableId,
} from '../model.ts';
import { nameEntriesOf, type NsEntry, pgAllConNs, pgPropConNs, pgRelNs } from '../naming-ns.ts';
import { pgClipboard } from './clipboard.ts';
import { columnRefs, exprReferences, renameInExpr, renameQualifiedInExpr, tokenize } from './expr.ts';
import { joinNames, makeObjectName } from './naming.ts';
import {
  findInstanceLevelStatement as pgFindInstanceLevelStatement,
  INSTANCE_LEVEL_DESCRIPTION as PG_INSTANCE_LEVEL_DESCRIPTION,
  isConcurrentDdlSql as pgIsConcurrentDdlSql,
  isNontransactionalSql as pgIsNontransactionalSql,
} from './nontx.ts';
import { parsePartitionBound, validatePartitionBound } from './partition.ts';
import { createAll as pgCreateAll, plan as pgPlan } from './plan.ts';
import { ident, KEYWORDS, literal, qualified } from './quote.ts';
import { COMMON_TYPES, normalizeType as pgNormalizeType } from './types.ts';
import { pgVersioning } from './versioning.ts';

const EMPTY_PUBLIC_ID = 'dowel:empty-database:public';
const PG_MAX_BYTES = 63;
const textEncoder = new TextEncoder();

export const PG_CAPABILITIES: DialectCapabilities = {
  schemas: true,
  defaultSchema: 'public',
  maxIdentLength: PG_MAX_BYTES,
  maxIdentUnit: 'bytes',
  enums: true,
  sequences: true,
  partitioning: true,
  transactionalDdl: true,
  requiresTableRebuild: false,
  supportsColumnOrder: false,
  requiresExternalShadow: true,
  historyStorage: 'schema',
  nullsNotDistinct: true,
  comments: true,
};

const schemaOf = (m: Model, tableId: string) => get(m, tableId, 'table').parent;

const pgRelTaken = (m: Model, schema: string, name: string, self: string): boolean => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.isPgRelTaken(schema, name, self);
  return Object.values(m.objects).some((o) => {
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
};

const pgConTaken = (m: Model, table: string, name: string, self: string): boolean => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.isPgConTaken(table, name, self);
  const selfObj = self && !self.endsWith('#nn') ? m.objects[self] : undefined;
  const selfPropagates =
    self === '' || self.endsWith('#nn') || selfObj?.kind === 'check' || selfObj?.kind === 'foreignKey';
  const ancIds = new Set(partitionAncestors(m, table).map((a) => a.id));
  const descIds = selfPropagates
    ? new Set(partitionDescendants(m, table).map((d) => d.id))
    : new Set<string>();
  return Object.values(m.objects).some((o) => {
    if (o.id === self) return false;
    if (o.kind === 'column' && o.notNull && self !== `${o.id}#nn` && o.notNullName === name) {
      return o.parent === table || ancIds.has(o.parent) || descIds.has(o.parent);
    }
    if (!('parent' in o)) return false;
    if (o.parent === table) {
      return (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.name === name
      );
    }
    if (ancIds.has(o.parent)) {
      return (o.kind === 'check' || o.kind === 'foreignKey') && o.name === name;
    }
    if (descIds.has(o.parent)) {
      return (
        (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
        o.name === name
      );
    }
    return false;
  });
};

const pgTypeTaken = (m: Model, schema: string, name: string, self: string): boolean => {
  const idx = getActiveModelIndex(m);
  if (idx) return idx.isPgTypeTaken(schema, name, self);
  return Object.values(m.objects).some(
    (o) =>
      o.id !== self && (o.kind === 'enum' || o.kind === 'table') && o.parent === schema && o.name === name,
  );
};

interface PgNamingCache {
  tName: string;
  rel: string[];
  relCon: string[];
  conProp: string[];
  effColNames: string[];
}

const pgSpec = (
  tableId: string,
  ns: string[],
  self: string,
  cur: string | null | undefined,
  n1: string,
  n2: string | null,
  label: string,
): NameSpec => ({
  table: tableId,
  key: nameKey(tableId, label, n1, n2, ns),
  cand: (j) => makeObjectName(n1, n2, j === 0 ? label : `${label}${j}`),
  norm: (n) => n,
  ns,
  self,
  cur,
});

/** 本表推导名用到的命名空间：关系（schema 级）、本表全部约束 + 祖先继承约束、（会继承的约束还要避让）后代全部约束 */
const pgNsLists = (m: Model, tableId: string, schema: string) => {
  const anc = partitionAncestors(m, tableId).map((a) => a.id);
  const desc = partitionDescendants(m, tableId).map((d) => d.id);
  const rel = [pgRelNs(schema)];
  const conLocal = [pgAllConNs(tableId), ...anc.map(pgPropConNs)];
  const conProp = [...conLocal, ...desc.map(pgAllConNs)];
  return { rel, relCon: [...rel, ...conLocal], conProp };
};

const pgEntriesOf = (m: Model) => (o: Obj, out: NsEntry[]) =>
  nameEntriesOf(
    'pg',
    o,
    (id) => {
      const t = find(m, id);
      return t?.kind === 'table' ? t : undefined;
    },
    out,
  );

const pgNaming: DialectNaming = {
  dialect: 'pg',
  wantNs: (m, tableId) => {
    const { relCon, conProp } = pgNsLists(m, tableId, get(m, tableId, 'table').parent);
    const want = new Set([...relCon, ...conProp]);
    return (ns) => want.has(ns);
  },
  entriesOf: pgEntriesOf,
  fullPass: (m, tableId, ctx) => {
    const t = get(m, tableId, 'table');
    const schema = t.parent;
    const { rel, relCon, conProp } = pgNsLists(m, tableId, schema);
    const joinCols = (ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
    const activeIdx = getActiveModelIndex(m);
    // 遍历顺序与原实现一致：叠加索引走索引顺序，否则按 m.objects 顺序单趟收集
    let cols: Column[];
    let children: Obj[];
    let ownedSeqs: (colId: string) => Sequence[];
    let effCols: Column[];
    if (activeIdx instanceof OverlayModelIndex) {
      cols = columnsOf(m, tableId);
      ownedSeqs = (cid) => activeIdx.sequencesOwnedBy(cid);
      effCols = [];
      children = [];
    } else {
      children = [];
      const ownedSeqsByCol = new Map<string, Sequence[]>();
      for (const o of Object.values(m.objects)) {
        if ('parent' in o && o.parent === tableId) children.push(o);
        if (o.kind === 'sequence' && o.ownedBy) {
          const list = ownedSeqsByCol.get(o.ownedBy);
          if (list) list.push(o);
          else ownedSeqsByCol.set(o.ownedBy, [o]);
        }
      }
      cols = children
        .filter((o): o is Column => o.kind === 'column')
        .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1));
      ownedSeqs = (cid) => ownedSeqsByCol.get(cid) ?? [];
      effCols = t.partitionOf ? effectiveColumnsOf(m, tableId) : cols;
    }
    for (const c of cols) {
      if (c.notNull && c.notNullNameMode === 'derived') {
        c.notNullName = ctx.choose(
          pgSpec(tableId, conProp, `${c.id}#nn`, c.notNullName, t.name, c.name, 'not_null'),
        );
        ctx.written(c);
      }
      if (c.identity?.sequenceNameMode === 'derived') {
        c.identity.sequenceName = ctx.choose(
          pgSpec(tableId, rel, `${c.id}#seq`, c.identity.sequenceName, t.name, c.name, 'seq'),
        );
        ctx.written(c);
      }
      for (const s of ownedSeqs(c.id)) {
        if (s.nameMode === 'derived') {
          s.name = ctx.choose(pgSpec(tableId, rel, s.id, s.name, t.name, c.name, 'seq'));
          ctx.written(s);
        }
      }
    }
    if (activeIdx instanceof OverlayModelIndex) {
      effCols = effectiveColumnsOf(m, tableId);
      children = allChildrenOf(m, tableId);
    }
    const effColNames = effCols.map((c) => c.name);
    for (const o of children) {
      if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
      switch (o.kind) {
        case 'primaryKey':
          o.name = ctx.choose(pgSpec(tableId, relCon, o.id, o.name, t.name, null, 'pkey'));
          break;
        case 'unique':
          o.name = ctx.choose(pgSpec(tableId, relCon, o.id, o.name, t.name, joinCols(o.columns), 'key'));
          break;
        case 'foreignKey':
          o.name = ctx.choose(pgSpec(tableId, conProp, o.id, o.name, t.name, joinCols(o.columns), 'fkey'));
          break;
        case 'check': {
          const ref = singleReferencedColumn('pg', exprRefNames('pg', o.expr, columnRefs), effColNames);
          o.name = ctx.choose(pgSpec(tableId, conProp, o.id, o.name, t.name, ref, 'check'));
          break;
        }
        case 'index':
          o.name = ctx.choose(
            pgSpec(tableId, rel, o.id, o.name, t.name, joinNames(indexElementNames(m, o)), 'idx'),
          );
          break;
        default:
          continue;
      }
      ctx.written(o);
    }
    const cache: PgNamingCache = { tName: t.name, rel, relCon, conProp, effColNames };
    return cache;
  },
  slotSpec: (m, tableId, o, raw) => {
    const c = raw as PgNamingCache;
    const joinCols = (ids: string[]) => joinNames(ids.map((x) => colName(m, x)));
    switch (o.kind) {
      case 'primaryKey':
        return pgSpec(tableId, c.relCon, o.id, o.name, c.tName, null, 'pkey');
      case 'unique':
        return pgSpec(tableId, c.relCon, o.id, o.name, c.tName, joinCols(o.columns), 'key');
      case 'foreignKey':
        return pgSpec(tableId, c.conProp, o.id, o.name, c.tName, joinCols(o.columns), 'fkey');
      case 'check': {
        const ref = singleReferencedColumn('pg', exprRefNames('pg', o.expr, columnRefs), c.effColNames);
        return pgSpec(tableId, c.conProp, o.id, o.name, c.tName, ref, 'check');
      }
      case 'index':
        return pgSpec(tableId, c.rel, o.id, o.name, c.tName, joinNames(indexElementNames(m, o)), 'idx');
      default:
        return null;
    }
  },
};

const refreshPgDerivedNames = (m: Model, tableId: string): void => {
  const idx = getActiveModelIndex(m);
  runDerivedNames(m, tableId, pgNaming, idx instanceof OverlayModelIndex ? idx.nameTracker() : undefined);
};

const validatePgModel = (m: Model): string[] => {
  const errs: string[] = [];
  const colOfTable = (o: Obj, table: string, cols: string[], what: string) => {
    const root = rootTableId(m, table);
    for (const c of cols) {
      const col = m.objects[c];
      if (col?.kind !== 'column' || (col.parent !== table && col.parent !== root))
        errs.push(`${o.kind} ${o.name}：${what} 引用的列 ${c} 不在表 ${table} 中`);
    }
  };
  const ns = new Map<string, string>();
  const claim = (space: string, name: string, o: Obj) => {
    const k = `${space}\u0000${name}`;
    const prev = ns.get(k);
    if (prev && prev !== o.id) errs.push(`名字冲突：${name}（${space}）`);
    ns.set(k, o.id);
  };
  const checkBytes = (o: Obj, val: string) => {
    if (o.kind !== 'opaque' && textEncoder.encode(val).length > PG_MAX_BYTES) {
      errs.push(`${o.kind} ${val}：超出 PostgreSQL 标识符长度上限（${PG_MAX_BYTES} 字节）`);
    }
  };

  for (const o of Object.values(m.objects)) {
    checkBytes(o, o.name);
    switch (o.kind) {
      case 'schema':
        if (o.name === 'dowel') errs.push('schema dowel：dowel 保留给 Dowel 迁移历史');
        claim('schema', o.name, o);
        break;
      case 'extension':
        claim('extension', o.name, o);
        break;
      case 'opaque':
        claim(`opaque:${o.objType}:${o.parent}`, o.name, o);
        break;
      case 'enum':
        claim(`type:${o.parent}`, o.name, o);
        break;
      case 'sequence':
        claim(`rel:${o.parent}`, o.name, o);
        break;
      case 'table': {
        if (o.partitionOf) {
          const parentTable = m.objects[o.partitionOf.parent];
          if (parentTable?.kind === 'table') {
            if (parentTable.partitionBy === null)
              errs.push(`table ${o.name}：partitionOf 指向的表 ${parentTable.name} 不是分区父表`);
            const seen = new Set<string>([o.id]);
            let cur: string | null = o.partitionOf.parent;
            while (cur) {
              if (seen.has(cur)) {
                errs.push(`table ${o.name}：partitionOf 存在环引用`);
                break;
              }
              seen.add(cur);
              const next: Obj | undefined = m.objects[cur];
              cur = next?.kind === 'table' && next.partitionOf ? next.partitionOf.parent : null;
            }
            if (parentTable.partitionBy && typeof parentTable.partitionBy !== 'string') {
              const boundErr = validatePartitionBound(
                parentTable.partitionBy.strategy,
                o.partitionOf.bound,
                parentTable.partitionBy.keys.length,
              );
              if (boundErr) errs.push(`table ${o.name}：${boundErr}`);
            } else if (!o.partitionOf.bound.trim()) {
              errs.push(`table ${o.name}：partitionOf.bound 不能为空`);
            }
          }
        }
        if (typeof o.partitionBy === 'string') {
          if (o.partitionBy.trim() === '') errs.push(`table ${o.name}：partitionBy 不能为空字符串`);
        } else if (o.partitionBy !== null) {
          if (o.partitionBy.keys.length === 0) errs.push(`table ${o.name}：partitionBy 至少需要一个分区键`);
          if (o.partitionBy.strategy === 'list' && o.partitionBy.keys.length !== 1)
            errs.push(`table ${o.name}：LIST 分区策略只能有 1 个分区键`);
          for (const k of o.partitionBy.keys) {
            if (!!k.column === !!k.expr) errs.push(`table ${o.name}：分区键必须且只能指定列或表达式之一`);
            if (k.column) {
              colOfTable(o, o.id, [k.column], 'partitionBy');
              const col = m.objects[k.column];
              if (col?.kind === 'column' && col.generated)
                errs.push(`table ${o.name}：生成列 ${col.name} 不能作为分区键`);
            }
          }
        }
        claim(`rel:${o.parent}`, o.name, o);
        claim(`type:${o.parent}`, o.name, o);
        break;
      }
      case 'column': {
        const parentTable = m.objects[o.parent];
        if (parentTable?.kind === 'table' && parentTable.partitionOf !== null) {
          const root = m.objects[rootTableId(m, parentTable.id)];
          if (!(root?.kind === 'table' && typeof root.partitionBy === 'string')) {
            errs.push(`列 ${o.name}：分区子表 ${parentTable.name} 不能直接拥有列，列应定义在根分区父表上`);
          }
        }
        claim(`col:${o.parent}`, o.name, o);
        if (o.notNull && o.notNullName) {
          checkBytes(o, o.notNullName);
          const isLegacyChildSameNn =
            parentTable?.kind === 'table' &&
            parentTable.partitionOf !== null &&
            columnsOf(m, rootTableId(m, parentTable.id)).some(
              (rc) => rc.name === o.name && rc.notNull && rc.notNullName === o.notNullName,
            );
          if (!isLegacyChildSameNn) {
            claim(`con:${o.parent}`, o.notNullName, o);
            for (const desc of partitionDescendants(m, o.parent)) {
              claim(`con:${desc.id}`, o.notNullName, o);
            }
          }
        }
        if (o.identity) {
          checkBytes(o, o.identity.sequenceName);
          if (parentTable?.kind === 'table') claim(`rel:${parentTable.parent}`, o.identity.sequenceName, o);
        }
        break;
      }
      case 'primaryKey':
      case 'unique':
      case 'foreignKey':
      case 'check':
      case 'index': {
        const t = m.objects[o.parent];
        if (t?.kind === 'table' && t.partitionBy !== null) {
          if (o.kind === 'check' && o.noInherit) {
            errs.push(`检查约束 ${o.name}：分区父表的 CHECK 约束不能设为 NO INHERIT`);
          }
          const req = requiredUniquePartitionKeys(m, t.id);
          if (o.kind === 'primaryKey' || o.kind === 'unique') {
            const label = o.kind === 'primaryKey' ? '主键' : '唯一约束';
            if (req.hasExprKey) {
              errs.push(`${label} ${o.name}：包含表达式分区键的分区表不能创建主键或唯一约束`);
            } else if (req.directCols.some((c) => !o.columns.includes(c))) {
              errs.push(`${label} ${o.name}：分区表的主键或唯一约束必须包含全部分区键列`);
            }
          } else if (o.kind === 'index' && o.unique) {
            if (req.hasExprKey) {
              errs.push(`唯一索引 ${o.name}：包含表达式分区键的分区表不支持唯一索引`);
            } else if (req.directCols.some((c) => !o.elements.some((e) => e.column === c))) {
              errs.push(`唯一索引 ${o.name}：分区表的唯一索引必须包含全部分区键`);
            }
          }
        }
        if (o.kind !== 'index') {
          claim(`con:${o.parent}`, o.name, o);
          if (o.kind === 'check' || o.kind === 'foreignKey') {
            for (const desc of partitionDescendants(m, o.parent)) {
              claim(`con:${desc.id}`, o.name, o);
            }
          }
        }
        if ((o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'index') && t?.kind === 'table')
          claim(`rel:${t.parent}`, o.name, o);
        break;
      }
    }
  }

  for (const t of all(m, 'table')) {
    const pks = childrenOf(m, t.id, 'primaryKey');
    if (t.partitionBy !== null) {
      if (pks.length > 0) {
        for (const desc of partitionDescendants(m, t.id)) {
          if (childrenOf(m, desc.id, 'primaryKey').length > 0) {
            errs.push(`表 ${desc.name}：祖先分区表 ${t.name} 已有主键，子分区不能再定义主键`);
          }
        }
      }
      const defaults = partitionsOf(m, t.id).filter(
        (c) => parsePartitionBound(c.partitionOf!.bound)?.kind === 'default',
      );
      if (defaults.length > 1) errs.push(`表 ${t.name}：最多只能有 1 个 DEFAULT 子分区`);
    }
  }
  return errs;
};

const validatePgIdent = (name: string, kind: IdentKind): string | null => {
  if (!name.trim()) return '标识符不能为空';
  if (textEncoder.encode(name).length > PG_MAX_BYTES) {
    return `标识符 ${name} 超出 PostgreSQL 长度上限（${PG_MAX_BYTES} 字节）`;
  }
  if (kind === 'schema' && name === 'dowel') {
    return 'schema 名称 dowel 保留给 Dowel 迁移历史，不能使用';
  }
  return null;
};

const formatPgScript = (steps: readonly { sql: string }[]): string =>
  steps.map((s) => `${s.sql};`).join('\n\n');

export const pgDialect: DialectSpec = {
  id: 'pg',
  capabilities: PG_CAPABILITIES,
  quoteIdent: ident,
  quoteQualified: qualified,
  literal,
  keywords: KEYWORDS,
  tokenize,
  columnRefs,
  exprReferences,
  renameInExpr,
  renameQualifiedInExpr,
  normalizeType: pgNormalizeType,
  commonTypes: COMMON_TYPES,
  emptyBase: (like, scope) => {
    const m = emptyModel('pg');
    if (scope?.length && !scope.includes('public')) return m;
    const pub = Object.values(like.objects).find((o) => o.kind === 'schema' && o.name === 'public');
    const id = pub?.id ?? EMPTY_PUBLIC_ID;
    m.objects[id] = { id, kind: 'schema', name: 'public', comment: null };
    return m;
  },
  validateIdent: validatePgIdent,
  formatScript: formatPgScript,
  validateModel: validatePgModel,
  refreshDerivedNames: refreshPgDerivedNames,
  isNameTaken: (m, space, containerId, name, selfId) => {
    if (space === 'rel') return pgRelTaken(m, containerId, name, selfId);
    if (space === 'con') return pgConTaken(m, containerId, name, selfId);
    return pgTypeTaken(m, containerId, name, selfId);
  },
  plan: (from, to, opts) => pgPlan(from, to, opts),
  createAll: (m, opts) => pgCreateAll(m, opts),
  isNontransactionalSql: pgIsNontransactionalSql,
  isConcurrentDdlSql: pgIsConcurrentDdlSql,
  findInstanceLevelStatement: pgFindInstanceLevelStatement,
  instanceLevelDescription: PG_INSTANCE_LEVEL_DESCRIPTION,
  clipboard: pgClipboard,
  versioning: pgVersioning,
};
