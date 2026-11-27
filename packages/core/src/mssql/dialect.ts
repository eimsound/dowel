import {
  type DialectNaming,
  exprRefNames,
  nameKey,
  type NameSpec,
  runDerivedNames,
  singleReferencedColumn,
} from '../derived-names.ts';
// MSSQL（SQL Server 2019 / 2022 / 2025）方言规格实现（注册到 @dowel/core registry）。
import type { DialectCapabilities, DialectSpec, IdentKind } from '../dialect.ts';
import { emptyModel, type Model, type Obj } from '../ir.ts';
import {
  all,
  allChildrenOf,
  childrenOf,
  childrenOfKinds,
  columnsOf,
  find,
  get,
  getActiveModelIndex,
  indexElementNames,
  objectsOfKinds,
  OverlayModelIndex,
} from '../model.ts';
import { mssqlIdxNs, mssqlObjNs, nameEntriesOf } from '../naming-ns.ts';
import { formatMssqlScript } from './batch.ts';
import { mssqlClipboard } from './clipboard.ts';
import { isReservedMssqlSchema, MAX_MSSQL_IDENT, mssqlJoinNames, mssqlMakeObjectName } from './naming.ts';
import {
  MSSQL_INSTANCE_LEVEL_DESCRIPTION,
  mssqlFindInstanceLevelStatement,
  mssqlIsConcurrentDdlSql,
  mssqlIsNontransactionalSql,
} from './nontx.ts';
import { isMssqlPkClustered, mssqlCreateAll, mssqlDefaultNameOf, mssqlPlan } from './plan.ts';
import {
  MSSQL_KEYWORDS,
  mssqlColumnRefs,
  mssqlExprReferences,
  mssqlIdent,
  mssqlLiteral,
  mssqlQualified,
  mssqlRenameInExpr,
  mssqlRenameQualifiedInExpr,
  mssqlTokenize,
} from './quote.ts';
import { isMssqlIdentityEligibleType, MSSQL_COMMON_TYPES, mssqlNormalizeType } from './types.ts';
import { mssqlVersioning } from './versioning.ts';

const EMPTY_DBO_ID = 'dowel:empty-database:dbo';

export const MSSQL_CAPABILITIES: DialectCapabilities = {
  schemas: true,
  defaultSchema: 'dbo',
  maxIdentLength: MAX_MSSQL_IDENT,
  maxIdentUnit: 'chars',
  enums: false,
  sequences: true,
  partitioning: false,
  transactionalDdl: true,
  requiresTableRebuild: false,
  supportsColumnOrder: false,
  requiresExternalShadow: true,
  historyStorage: 'schema',
  nullsNotDistinct: false,
  comments: true,
};

const schemaOfTable = (m: Model, tableId: string): string => get(m, tableId, 'table').parent;

/** 判断对象名在 schema 级 `sys.objects` 命名空间是否已被占用（大小写不敏感） */
const isMssqlObjTaken = (m: Model, schemaId: string, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return objectsOfKinds(m, [
    'table',
    'sequence',
    'primaryKey',
    'unique',
    'foreignKey',
    'check',
    'column',
    'opaque',
  ]).some((o) => {
    if (o.id === selfId) return false;
    if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schemaId) {
      return o.name.toLowerCase() === low;
    }
    if (
      (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'foreignKey' || o.kind === 'check') &&
      schemaOfTable(m, o.parent) === schemaId
    ) {
      return o.name.toLowerCase() === low;
    }
    if (
      o.kind === 'column' &&
      o.default &&
      selfId !== `${o.id}#df` &&
      schemaOfTable(m, o.parent) === schemaId
    ) {
      const df = mssqlDefaultNameOf(o, get(m, o.parent, 'table').name);
      return df.toLowerCase() === low;
    }
    if (o.kind === 'opaque') {
      const parentObj = m.objects[o.parent];
      const sch =
        parentObj?.kind === 'schema' ? parentObj.id : parentObj?.kind === 'table' ? parentObj.parent : null;
      if (sch === schemaId) return o.name.toLowerCase() === low;
    }
    return false;
  });
};

/** 判断索引/约束名在表级 `sys.indexes` 命名空间是否已被占用（大小写不敏感） */
const isMssqlIdxTaken = (m: Model, tableId: string, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return childrenOfKinds(m, tableId, ['index', 'primaryKey', 'unique']).some((o) => {
    if (o.id === selfId) return false;
    if ((o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') && o.parent === tableId) {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

interface MssqlNamingCache {
  tName: string;
  obj: string[];
  objIdx: string[];
  idx: string[];
  colNames: string[];
}

const mssqlSpec = (
  tableId: string,
  ns: string[],
  self: string,
  cur: string | null | undefined,
  prefix: string,
  n1: string,
  n2: string | null,
): NameSpec => ({
  table: tableId,
  key: nameKey(tableId, prefix, n1, n2, ns),
  cand: (j) => mssqlMakeObjectName(prefix, n1, n2, j === 0 ? null : String(j)),
  norm: (n) => n.toLowerCase(),
  ns,
  self,
  cur,
});

/** 约束避让 schema 级 sys.objects（PK / UQ 还要避让表级 sys.indexes），索引只避让 sys.indexes */
const mssqlSlotSpec = (m: Model, tableId: string, o: Obj, c: MssqlNamingCache): NameSpec | null => {
  const joinCols = (ids: string[]) => mssqlJoinNames(ids.map((x) => get(m, x, 'column').name));
  switch (o.kind) {
    case 'primaryKey':
      return mssqlSpec(tableId, c.objIdx, o.id, o.name, 'PK', c.tName, null);
    case 'unique':
      return mssqlSpec(tableId, c.objIdx, o.id, o.name, 'UQ', c.tName, joinCols(o.columns));
    case 'foreignKey':
      return mssqlSpec(tableId, c.obj, o.id, o.name, 'FK', c.tName, joinCols(o.columns));
    case 'check': {
      const ref = singleReferencedColumn('mssql', exprRefNames('mssql', o.expr, mssqlColumnRefs), c.colNames);
      return mssqlSpec(tableId, c.obj, o.id, o.name, 'CK', c.tName, ref);
    }
    case 'index':
      return mssqlSpec(tableId, c.idx, o.id, o.name, 'IX', c.tName, mssqlJoinNames(indexElementNames(m, o)));
    default:
      return null;
  }
};

/** 重新计算一张表上所有推导名（包括带名 DEFAULT 约束 DF_<table>_<col>、PK、UQ、FK、CK、IX） */
const mssqlNaming: DialectNaming = {
  dialect: 'mssql',
  wantNs: (m, tableId) => {
    const obj = mssqlObjNs(schemaOfTable(m, tableId));
    const idx = mssqlIdxNs(tableId);
    return (ns) => ns === obj || ns === idx;
  },
  entriesOf: (m) => (o, out) =>
    nameEntriesOf(
      'mssql',
      o,
      (id) => {
        const t = find(m, id);
        return t?.kind === 'table' ? t : undefined;
      },
      out,
    ),
  fullPass: (m, tableId, ctx) => {
    const t = get(m, tableId, 'table');
    const obj = [mssqlObjNs(t.parent)];
    const idx = [mssqlIdxNs(tableId)];
    const tableCols = columnsOf(m, tableId);
    const cache: MssqlNamingCache = {
      tName: t.name,
      obj,
      objIdx: [...obj, ...idx],
      idx,
      colNames: tableCols.map((c) => c.name),
    };

    // 同步列上的带名 DEFAULT 约束推导名
    for (const c of tableCols) {
      if (c.default) {
        const mode = c.ext?.mssql?.defaultNameMode ?? 'derived';
        if (mode === 'derived') {
          const dfName = ctx.choose(
            mssqlSpec(tableId, obj, `${c.id}#df`, c.ext?.mssql?.defaultName, 'DF', t.name, c.name),
          );
          c.ext = {
            ...c.ext,
            mssql: {
              ...c.ext?.mssql,
              defaultName: dfName,
              defaultNameMode: 'derived',
            },
          };
          ctx.written(c);
        }
      } else if (c.ext?.mssql?.defaultNameMode === 'derived' && c.ext.mssql.defaultName !== undefined) {
        delete c.ext.mssql.defaultName;
        delete c.ext.mssql.defaultNameMode;
        if (Object.keys(c.ext.mssql).length === 0) {
          delete c.ext.mssql;
          if (Object.keys(c.ext).length === 0) delete c.ext;
        }
        ctx.written(c);
      }
    }

    for (const o of allChildrenOf(m, tableId)) {
      if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
      const spec = mssqlSlotSpec(m, tableId, o, cache);
      if (!spec) continue;
      o.name = ctx.choose(spec);
      ctx.written(o);
    }
    return cache;
  },
  slotSpec: (m, tableId, o, cache) => mssqlSlotSpec(m, tableId, o, cache as MssqlNamingCache),
};

const refreshMssqlDerivedNames = (m: Model, tableId: string): void => {
  const idx = getActiveModelIndex(m);
  runDerivedNames(m, tableId, mssqlNaming, idx instanceof OverlayModelIndex ? idx.nameTracker() : undefined);
};

const validateMssqlIdent = (name: string, kind: IdentKind): string | null => {
  if (!name.trim()) return '标识符不能为空';
  if (Array.from(name).length > MAX_MSSQL_IDENT) {
    return `标识符 ${name} 超出 SQL Server 长度上限（${MAX_MSSQL_IDENT} 字符）`;
  }
  if (kind === 'schema' && isReservedMssqlSchema(name)) {
    return `schema 名称 ${name} 为 SQL Server / Dowel 保留 schema，不能使用`;
  }
  return null;
};

const validateMssqlModel = (m: Model): string[] => {
  const errs: string[] = [];
  const ns = new Map<string, string>();
  const claim = (space: string, name: string, id: string) => {
    const k = `${space}\u0000${name.toLowerCase()}`;
    const prev = ns.get(k);
    if (prev && prev !== id) errs.push(`名字冲突（SQL Server 默认不区分大小写）：${name}（${space}）`);
    ns.set(k, id);
  };
  const checkLen = (label: string, val: string) => {
    if (Array.from(val).length > MAX_MSSQL_IDENT) {
      errs.push(`${label} ${val}：超出 SQL Server 标识符长度上限（${MAX_MSSQL_IDENT} 字符）`);
    }
  };

  for (const o of Object.values(m.objects)) {
    if (o.kind !== 'opaque') checkLen(o.kind, o.name);
    switch (o.kind) {
      case 'schema':
        if (isReservedMssqlSchema(o.name)) {
          errs.push(`schema ${o.name}：为 SQL Server / Dowel 保留 schema，不能使用`);
        }
        claim('schema', o.name, o.id);
        break;
      case 'enum':
        errs.push(`enum ${o.name}：SQL Server 不支持独立枚举类型`);
        break;
      case 'extension':
        errs.push(`extension ${o.name}：SQL Server 不支持扩展对象`);
        break;
      case 'sequence':
        claim(`obj:${o.parent}`, o.name, o.id);
        break;
      case 'table':
        if (o.partitionBy !== null || o.partitionOf !== null) {
          errs.push(`table ${o.name}：SQL Server 暂不支持声明式分区表`);
        }
        claim(`obj:${o.parent}`, o.name, o.id);
        break;
      case 'column': {
        claim(`col:${o.parent}`, o.name, o.id);
        if (o.identity) {
          errs.push(
            `列 ${o.name}：SQL Server 请使用 ext.mssql.identity（IDENTITY(seed, increment)）而非 PG IDENTITY`,
          );
        }
        if (o.typeRef) errs.push(`列 ${o.name}：SQL Server 不支持枚举类型引用`);
        const mssqlExt = o.ext?.mssql;
        if (mssqlExt?.identity) {
          if (!isMssqlIdentityEligibleType(o.type)) {
            errs.push(
              `列 ${o.name}：IDENTITY 仅支持 tinyint / smallint / int / bigint / decimal(p,0) / numeric(p,0)（当前为 ${o.type}）`,
            );
          }
          if (!o.notNull) errs.push(`列 ${o.name}：IDENTITY 列必须为 NOT NULL`);
          if (o.default) errs.push(`列 ${o.name}：IDENTITY 列不能同时设置 DEFAULT 约束`);
          if (o.generated) errs.push(`列 ${o.name}：IDENTITY 列不能同时是计算列`);
        }
        if (o.generated && !o.generated.stored && o.notNull) {
          errs.push(`列 ${o.name}：SQL Server 非 PERSISTED 计算列不能声明 NOT NULL`);
        }
        if (o.default) {
          const parentTbl = m.objects[o.parent];
          if (parentTbl?.kind === 'table') {
            const dfName = mssqlDefaultNameOf(o, parentTbl.name);
            checkLen('defaultConstraint', dfName);
            claim(`obj:${parentTbl.parent}`, dfName, `${o.id}#df`);
          }
        }
        break;
      }
      case 'primaryKey':
      case 'unique': {
        const t = m.objects[o.parent];
        if (t?.kind === 'table') {
          claim(`obj:${t.parent}`, o.name, o.id);
          claim(`idx:${t.id}`, o.name, o.id);
        }
        if (o.kind === 'unique' && o.nullsNotDistinct) {
          errs.push(`唯一约束 ${o.name}：SQL Server 不支持 NULLS NOT DISTINCT`);
        }
        break;
      }
      case 'foreignKey': {
        const t = m.objects[o.parent];
        if (t?.kind === 'table') claim(`obj:${t.parent}`, o.name, o.id);
        if (o.deferrable || o.initiallyDeferred) {
          errs.push(`外键 ${o.name}：SQL Server 不支持 DEFERRABLE 外键约束`);
        }
        if (o.match === 'full') errs.push(`外键 ${o.name}：SQL Server 不支持 MATCH FULL`);
        break;
      }
      case 'check': {
        const t = m.objects[o.parent];
        if (t?.kind === 'table') claim(`obj:${t.parent}`, o.name, o.id);
        break;
      }
      case 'index': {
        claim(`idx:${o.parent}`, o.name, o.id);
        if (o.nullsNotDistinct) errs.push(`索引 ${o.name}：SQL Server 不支持 NULLS NOT DISTINCT`);
        if (o.elements.some((e) => e.expr !== null)) {
          errs.push(`索引 ${o.name}：SQL Server 不支持直接建表达式索引，请使用计算列建索引`);
        }
        break;
      }
      case 'opaque': {
        const p = m.objects[o.parent];
        const sch = p?.kind === 'schema' ? p.id : p?.kind === 'table' ? p.parent : null;
        if (sch) claim(`obj:${sch}`, o.name, o.id);
        break;
      }
    }
  }

  for (const t of all(m, 'table')) {
    const cols = columnsOf(m, t.id);
    if (cols.length === 0) errs.push(`表 ${t.name}：SQL Server 表至少需要一列`);
    const idCols = cols.filter((c) => Boolean(c.ext?.mssql?.identity));
    if (idCols.length > 1) {
      errs.push(`表 ${t.name}：SQL Server 每表最多只能有一个 IDENTITY 列（发现 ${idCols.length} 个）`);
    }
    let clustered = 0;
    for (const pk of childrenOf(m, t.id, 'primaryKey')) {
      if (isMssqlPkClustered(m, pk)) clustered++;
    }
    for (const u of childrenOf(m, t.id, 'unique')) {
      if (u.ext?.mssql?.clustered) clustered++;
    }
    for (const ix of childrenOf(m, t.id, 'index')) {
      if (ix.ext?.mssql?.clustered) clustered++;
    }
    if (clustered > 1) {
      errs.push(`表 ${t.name}：每表最多只能有 1 个 CLUSTERED 约束或索引（当前有 ${clustered} 个）`);
    }
  }

  return errs;
};

export const mssqlDialect: DialectSpec = {
  id: 'mssql',
  capabilities: MSSQL_CAPABILITIES,
  quoteIdent: mssqlIdent,
  quoteQualified: mssqlQualified,
  literal: mssqlLiteral,
  keywords: MSSQL_KEYWORDS,
  tokenize: mssqlTokenize,
  columnRefs: mssqlColumnRefs,
  exprReferences: mssqlExprReferences,
  renameInExpr: mssqlRenameInExpr,
  renameQualifiedInExpr: mssqlRenameQualifiedInExpr,
  normalizeType: mssqlNormalizeType,
  commonTypes: MSSQL_COMMON_TYPES,
  emptyBase: (like, scope) => {
    const m = emptyModel('mssql');
    if (scope?.length && !scope.some((s) => s.toLowerCase() === 'dbo')) return m;
    const dbo = Object.values(like.objects).find(
      (o) => o.kind === 'schema' && o.name.toLowerCase() === 'dbo',
    );
    const id = dbo?.id ?? EMPTY_DBO_ID;
    m.objects[id] = { id, kind: 'schema', name: dbo?.name ?? 'dbo', comment: null };
    return m;
  },
  validateIdent: validateMssqlIdent,
  formatScript: formatMssqlScript,
  validateModel: validateMssqlModel,
  refreshDerivedNames: refreshMssqlDerivedNames,
  isNameTaken: (m, space, containerId, name, selfId) => {
    if (space === 'con') {
      const tbl = m.objects[containerId];
      if (tbl?.kind === 'table') {
        return isMssqlObjTaken(m, tbl.parent, name, selfId) || isMssqlIdxTaken(m, tbl.id, name, selfId);
      }
      return false;
    }
    return isMssqlObjTaken(m, containerId, name, selfId);
  },
  plan: (from, to, opts) => mssqlPlan(from, to, opts),
  createAll: (m, opts) => mssqlCreateAll(m, opts),
  isNontransactionalSql: mssqlIsNontransactionalSql,
  isConcurrentDdlSql: mssqlIsConcurrentDdlSql,
  findInstanceLevelStatement: mssqlFindInstanceLevelStatement,
  instanceLevelDescription: MSSQL_INSTANCE_LEVEL_DESCRIPTION,
  clipboard: mssqlClipboard,
  versioning: mssqlVersioning,
};
