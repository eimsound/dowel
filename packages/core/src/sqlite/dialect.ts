import {
  type DialectNaming,
  exprRefNames,
  nameKey,
  type NameSpec,
  runDerivedNames,
  singleReferencedColumn,
} from '../derived-names.ts';
// SQLite 方言规格实现（注册到 @dowel/core registry）。
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
import { nameEntriesOf, SQLITE_REL_NS, sqliteConNs } from '../naming-ns.ts';
import { sqliteClipboard } from './clipboard.ts';
import { sqliteJoinNames, sqliteMakeObjectName } from './naming.ts';
import {
  SQLITE_INSTANCE_LEVEL_DESCRIPTION,
  sqliteFindInstanceLevelStatement,
  sqliteIsConcurrentDdlSql,
  sqliteIsNontransactionalSql,
} from './nontx.ts';
import { sqliteCreateAll, sqlitePlan } from './plan.ts';
import {
  SQLITE_KEYWORDS,
  sqliteColumnRefs,
  sqliteExprReferences,
  sqliteIdent,
  sqliteLiteral,
  sqliteQualified,
  sqliteRenameInExpr,
  sqliteRenameQualifiedInExpr,
  sqliteTokenize,
} from './quote.ts';
import { SQLITE_COMMON_TYPES, SQLITE_STRICT_TYPES, sqliteNormalizeType } from './types.ts';
import { sqliteVersioning } from './versioning.ts';

const EMPTY_MAIN_ID = 'dowel:empty-database:main';
const MAX_IDENT_CHARS = 128;

export const SQLITE_CAPABILITIES: DialectCapabilities = {
  schemas: false,
  defaultSchema: 'main',
  maxIdentLength: MAX_IDENT_CHARS,
  maxIdentUnit: 'chars',
  enums: false,
  sequences: false,
  partitioning: false,
  transactionalDdl: true,
  requiresTableRebuild: true,
  supportsColumnOrder: true,
  requiresExternalShadow: false,
  historyStorage: 'prefix',
  nullsNotDistinct: false,
  comments: false,
};

const isSqliteRelTaken = (m: Model, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return objectsOfKinds(m, ['table', 'index', 'opaque']).some((o) => {
    if (o.id === selfId) return false;
    if (o.kind === 'table' || o.kind === 'index' || o.kind === 'opaque') {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

const isSqliteConTaken = (m: Model, tableId: string, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return childrenOfKinds(m, tableId, ['primaryKey', 'unique', 'check', 'foreignKey']).some((o) => {
    if (o.id === selfId) return false;
    if (
      (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
      o.parent === tableId
    ) {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

interface SqliteNamingCache {
  tName: string;
  colNames: string[];
}

const SQLITE_REL_ONLY = [SQLITE_REL_NS];

const sqliteSpec = (
  tableId: string,
  ns: string[],
  self: string,
  cur: string,
  n1: string,
  n2: string | null,
  label: string,
): NameSpec => ({
  table: tableId,
  key: nameKey(tableId, label, n1, n2, ns),
  cand: (j) => sqliteMakeObjectName(n1, n2, j === 0 ? label : `${label}${j}`),
  norm: (n) => n.toLowerCase(),
  ns,
  self,
  cur,
});

/** 约束避让表级约束名，索引避让全库关系名（与 isSqliteConTaken / isSqliteRelTaken 一致） */
const sqliteSlotSpec = (m: Model, tableId: string, o: Obj, c: SqliteNamingCache): NameSpec | null => {
  const joinCols = (ids: string[]) => sqliteJoinNames(ids.map((x) => get(m, x, 'column').name));
  const con = [sqliteConNs(tableId)];
  switch (o.kind) {
    case 'primaryKey':
      return sqliteSpec(tableId, con, o.id, o.name, c.tName, null, 'pkey');
    case 'unique':
      return sqliteSpec(tableId, con, o.id, o.name, c.tName, joinCols(o.columns), 'key');
    case 'foreignKey':
      return sqliteSpec(tableId, con, o.id, o.name, c.tName, joinCols(o.columns), 'fkey');
    case 'check': {
      const ref = singleReferencedColumn(
        'sqlite',
        exprRefNames('sqlite', o.expr, sqliteColumnRefs),
        c.colNames,
      );
      return sqliteSpec(tableId, con, o.id, o.name, c.tName, ref, 'check');
    }
    case 'index':
      return sqliteSpec(
        tableId,
        SQLITE_REL_ONLY,
        o.id,
        o.name,
        c.tName,
        sqliteJoinNames(indexElementNames(m, o)),
        'idx',
      );
    default:
      return null;
  }
};

const sqliteNaming: DialectNaming = {
  dialect: 'sqlite',
  wantNs: (_m, tableId) => {
    const con = sqliteConNs(tableId);
    return (ns) => ns === SQLITE_REL_NS || ns === con;
  },
  entriesOf: (m) => (o, out) =>
    nameEntriesOf(
      'sqlite',
      o,
      (id) => {
        const t = find(m, id);
        return t?.kind === 'table' ? t : undefined;
      },
      out,
    ),
  fullPass: (m, tableId, ctx) => {
    const t = get(m, tableId, 'table');
    const cache: SqliteNamingCache = { tName: t.name, colNames: columnsOf(m, tableId).map((c) => c.name) };
    for (const o of allChildrenOf(m, tableId)) {
      if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
      const spec = sqliteSlotSpec(m, tableId, o, cache);
      if (!spec) continue;
      o.name = ctx.choose(spec);
      ctx.written(o);
    }
    return cache;
  },
  slotSpec: (m, tableId, o, cache) => sqliteSlotSpec(m, tableId, o, cache as SqliteNamingCache),
};

const refreshSqliteDerivedNames = (m: Model, tableId: string): void => {
  const idx = getActiveModelIndex(m);
  runDerivedNames(m, tableId, sqliteNaming, idx instanceof OverlayModelIndex ? idx.nameTracker() : undefined);
};

const validateSqliteModel = (m: Model): string[] => {
  const errs: string[] = [];
  const ns = new Map<string, string>();
  const claim = (space: string, name: string, o: Obj) => {
    const k = `${space}\u0000${name.toLowerCase()}`;
    const prev = ns.get(k);
    if (prev && prev !== o.id) errs.push(`名字冲突（SQLite 不区分大小写）：${name}（${space}）`);
    ns.set(k, o.id);
  };
  const checkLen = (o: Obj, label: string, val: string) => {
    if (Array.from(val).length > MAX_IDENT_CHARS) {
      errs.push(`${label} ${val}：超出 SQLite 标识符长度上限（${MAX_IDENT_CHARS} 字符）`);
    }
  };
  const checkReservedPrefix = (o: Obj, val: string) => {
    const low = val.toLowerCase();
    if (low.startsWith('sqlite_')) errs.push(`${o.kind} ${val}：SQLite 保留前缀 sqlite_ 不允许使用`);
    if (low.startsWith('dowel_')) errs.push(`${o.kind} ${val}：前缀 dowel_ 保留给 Dowel 迁移历史表`);
  };

  const schemas = all(m, 'schema');
  if (schemas.length > 1) errs.push(`SQLite 仅支持单一逻辑 schema（main），发现 ${schemas.length} 个 schema`);
  for (const s of schemas) {
    if (s.name !== 'main') errs.push(`SQLite schema 名必须为 main（当前为 ${s.name}）`);
  }

  for (const o of Object.values(m.objects)) {
    checkLen(o, o.kind, o.name);
    switch (o.kind) {
      case 'enum':
        errs.push(`enum ${o.name}：SQLite 不支持独立枚举类型`);
        break;
      case 'sequence':
        errs.push(`sequence ${o.name}：SQLite 不支持独立序列`);
        break;
      case 'extension':
        errs.push(`extension ${o.name}：SQLite 不支持扩展对象`);
        break;
      case 'table':
        checkReservedPrefix(o, o.name);
        if (o.partitionBy !== null || o.partitionOf !== null) {
          errs.push(`table ${o.name}：SQLite 不支持声明式分区表`);
        }
        claim('rel', o.name, o);
        break;
      case 'column':
        claim(`col:${o.parent}`, o.name, o);
        if (o.identity)
          errs.push(`列 ${o.name}：SQLite 不支持 PG IDENTITY，请使用 INTEGER PRIMARY KEY AUTOINCREMENT`);
        if (o.typeRef) errs.push(`列 ${o.name}：SQLite 不支持枚举类型引用`);
        if (o.default && 'nextval' in o.default) errs.push(`列 ${o.name}：SQLite 不支持序列默认值`);
        break;
      case 'primaryKey':
      case 'unique':
      case 'foreignKey':
      case 'check':
        claim(`con:${o.parent}`, o.name, o);
        if (o.kind === 'unique' && o.nullsNotDistinct) {
          errs.push(`唯一约束 ${o.name}：SQLite 不支持 NULLS NOT DISTINCT`);
        }
        break;
      case 'index':
        checkReservedPrefix(o, o.name);
        claim('rel', o.name, o);
        if (o.include.length > 0) errs.push(`索引 ${o.name}：SQLite 不支持 INCLUDE 覆盖列`);
        if (o.nullsNotDistinct) errs.push(`索引 ${o.name}：SQLite 不支持 NULLS NOT DISTINCT`);
        break;
      case 'opaque':
        checkReservedPrefix(o, o.name);
        claim('rel', o.name, o);
        break;
    }
  }

  for (const t of all(m, 'table')) {
    const pks = childrenOf(m, t.id, 'primaryKey');
    const pk = pks[0] ?? null;
    const cols = columnsOf(m, t.id);
    if (cols.length === 0) errs.push(`表 ${t.name}：SQLite 表至少需要一列`);
    if (t.ext?.sqlite?.withoutRowid && !pk) {
      errs.push(`表 ${t.name}：WITHOUT ROWID 表必须定义 PRIMARY KEY`);
    }
    for (const c of cols) {
      if (t.ext?.sqlite?.strict && !SQLITE_STRICT_TYPES.has(c.type.trim().toUpperCase())) {
        errs.push(
          `表 ${t.name} 列 ${c.name}：STRICT 表仅支持 INT / INTEGER / REAL / TEXT / BLOB / ANY 类型（当前为 ${c.type}）`,
        );
      }
      if (c.ext?.sqlite?.autoincrement) {
        if (t.ext?.sqlite?.withoutRowid) {
          errs.push(`表 ${t.name} 列 ${c.name}：WITHOUT ROWID 表不能使用 AUTOINCREMENT`);
        }
        if (c.type.trim().toUpperCase() !== 'INTEGER') {
          errs.push(`表 ${t.name} 列 ${c.name}：AUTOINCREMENT 只能用于 INTEGER 类型列`);
        }
        if (!pk || pk.columns.length !== 1 || pk.columns[0] !== c.id) {
          errs.push(`表 ${t.name} 列 ${c.name}：AUTOINCREMENT 只能用于单列 PRIMARY KEY`);
        }
      }
    }
  }
  return errs;
};

const validateSqliteIdent = (name: string, kind: IdentKind): string | null => {
  if (!name.trim()) return '标识符不能为空';
  if (Array.from(name).length > MAX_IDENT_CHARS) {
    return `标识符 ${name} 超出 SQLite 长度上限（${MAX_IDENT_CHARS} 字符）`;
  }
  if (kind === 'table' || kind === 'index') {
    const low = name.toLowerCase();
    if (low.startsWith('sqlite_')) return `名称 ${name} 不能使用 SQLite 保留前缀 sqlite_`;
    if (low.startsWith('dowel_')) return `名称 ${name} 不能使用 Dowel 迁移历史保留前缀 dowel_`;
  }
  return null;
};

const formatSqliteScript = (steps: readonly { sql: string }[]): string =>
  steps.map((s) => `${s.sql};`).join('\n\n');

export const sqliteDialect: DialectSpec = {
  id: 'sqlite',
  capabilities: SQLITE_CAPABILITIES,
  quoteIdent: sqliteIdent,
  quoteQualified: sqliteQualified,
  literal: sqliteLiteral,
  keywords: SQLITE_KEYWORDS,
  tokenize: sqliteTokenize,
  columnRefs: sqliteColumnRefs,
  exprReferences: sqliteExprReferences,
  renameInExpr: sqliteRenameInExpr,
  renameQualifiedInExpr: sqliteRenameQualifiedInExpr,
  normalizeType: sqliteNormalizeType,
  commonTypes: SQLITE_COMMON_TYPES,
  emptyBase: (like, _scope) => {
    const m = emptyModel('sqlite');
    const main = Object.values(like.objects).find((o) => o.kind === 'schema' && o.name === 'main');
    const id = main?.id ?? EMPTY_MAIN_ID;
    m.objects[id] = { id, kind: 'schema', name: 'main', comment: null };
    return m;
  },
  validateIdent: validateSqliteIdent,
  formatScript: formatSqliteScript,
  validateModel: validateSqliteModel,
  refreshDerivedNames: refreshSqliteDerivedNames,
  isNameTaken: (m, space, containerId, name, selfId) => {
    if (space === 'con') return isSqliteConTaken(m, containerId, name, selfId);
    return isSqliteRelTaken(m, name, selfId);
  },
  plan: (from, to) => sqlitePlan(from, to),
  createAll: (m) => sqliteCreateAll(m),
  isNontransactionalSql: sqliteIsNontransactionalSql,
  isConcurrentDdlSql: sqliteIsConcurrentDdlSql,
  findInstanceLevelStatement: sqliteFindInstanceLevelStatement,
  instanceLevelDescription: SQLITE_INSTANCE_LEVEL_DESCRIPTION,
  clipboard: sqliteClipboard,
  versioning: sqliteVersioning,
};
