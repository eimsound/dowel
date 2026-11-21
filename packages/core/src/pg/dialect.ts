// PostgreSQL 方言规格实现（包装既有 PG 模块，保证 100% 向后兼容）。
import type { DialectCapabilities, DialectSpec } from '../dialect.ts';
import { emptyModel, type Model, type Obj } from '../ir.ts';
import {
  all,
  childrenOf,
  colName,
  columnsOf,
  effectiveColumnsOf,
  get,
  indexElementNames,
  partitionDescendants,
  partitionsOf,
  requiredUniquePartitionKeys,
  rootTableId,
} from '../model.ts';
import { columnRefs, exprReferences, renameInExpr, renameQualifiedInExpr, tokenize } from './expr.ts';
import { chooseName, joinNames } from './naming.ts';
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

const pgRelTaken = (m: Model, schema: string, name: string, self: string): boolean =>
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

const pgConTaken = (m: Model, table: string, name: string, self: string): boolean =>
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

const pgTypeTaken = (m: Model, schema: string, name: string, self: string): boolean =>
  Object.values(m.objects).some(
    (o) =>
      o.id !== self && (o.kind === 'enum' || o.kind === 'table') && o.parent === schema && o.name === name,
  );

const refreshPgDerivedNames = (m: Model, tableId: string): void => {
  const t = get(m, tableId, 'table');
  const schema = t.parent;
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    chooseName(
      n1,
      n2,
      label,
      (n) => (rel && pgRelTaken(m, schema, n, id)) || (con && pgConTaken(m, tableId, n, id)),
    );
  const joinCols = (ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
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
        o.name = choose(o.id, t.name, joinCols(o.columns), 'key', true, true);
        break;
      case 'foreignKey':
        o.name = choose(o.id, t.name, joinCols(o.columns), 'fkey', false, true);
        break;
      case 'check': {
        const refs = effectiveColumnsOf(m, tableId).filter((c) => exprReferences(o.expr, c.name));
        o.name = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        break;
      }
      case 'index':
        o.name = choose(o.id, t.name, joinNames(indexElementNames(m, o)), 'idx', true, false);
        break;
    }
  }
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
          claim(`con:${o.parent}`, o.notNullName, o);
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
        if (o.kind !== 'index') claim(`con:${o.parent}`, o.name, o);
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
};
