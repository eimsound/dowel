// MySQL 方言规格实现（注册到 @dowel/core registry）。
import type { DialectCapabilities, DialectSpec, IdentKind } from '../dialect.ts';
import { emptyModel, type Model, type Obj } from '../ir.ts';
import { all, allChildrenOf, childrenOf, columnsOf, get, indexElementNames } from '../model.ts';
import {
  MAX_MYSQL_IDENT,
  MYSQL_SAFE_IDENT_RE,
  MYSQL_SHADOW_MARK_TABLE,
  mysqlChooseName,
  mysqlJoinNames,
} from './naming.ts';
import {
  MYSQL_INSTANCE_LEVEL_DESCRIPTION,
  mysqlFindInstanceLevelStatement,
  mysqlIsConcurrentDdlSql,
  mysqlIsNontransactionalSql,
} from './nontx.ts';
import { mysqlCreateAll, mysqlPlan, type MysqlPlanOptions } from './plan.ts';
import {
  MYSQL_KEYWORDS,
  mysqlColumnRefs,
  mysqlExprReferences,
  mysqlIdent,
  mysqlLiteral,
  mysqlQualified,
  mysqlRenameInExpr,
  mysqlRenameQualifiedInExpr,
  mysqlTokenize,
} from './quote.ts';
import { isMysqlAutoIncrementType, MYSQL_COMMON_TYPES, mysqlNormalizeType } from './types.ts';

const EMPTY_DEFAULT_ID = 'dowel:empty-database:default';

export const MYSQL_CAPABILITIES: DialectCapabilities = {
  schemas: false,
  defaultSchema: 'default',
  maxIdentLength: MAX_MYSQL_IDENT,
  maxIdentUnit: 'chars',
  enums: false,
  sequences: false,
  partitioning: false,
  transactionalDdl: false,
  requiresTableRebuild: false,
  supportsColumnOrder: true,
  requiresExternalShadow: true,
  historyStorage: 'prefix',
  nullsNotDistinct: false,
  comments: true,
};

const isMysqlTableOrViewTaken = (m: Model, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return Object.values(m.objects).some((o) => {
    if (o.id === selfId) return false;
    if (o.kind === 'table') return o.name.toLowerCase() === low;
    if (o.kind === 'opaque' && o.objType === 'view') return o.name.toLowerCase() === low;
    return false;
  });
};

const isMysqlTableIndexTaken = (m: Model, tableId: string, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  if (low === 'primary') return true;
  return Object.values(m.objects).some((o) => {
    if (o.id === selfId) return false;
    if ((o.kind === 'unique' || o.kind === 'index' || o.kind === 'foreignKey') && o.parent === tableId) {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

const isMysqlSchemaConstraintTaken = (m: Model, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return Object.values(m.objects).some((o) => {
    if (o.id === selfId) return false;
    if (o.kind === 'foreignKey' || o.kind === 'check') {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

const isMysqlConTaken = (m: Model, tableId: string, name: string, selfId: string): boolean => {
  const self = selfId ? m.objects[selfId] : undefined;
  const low = name.toLowerCase();
  if (self?.kind === 'primaryKey') return false;
  if (self?.kind === 'unique') return isMysqlTableIndexTaken(m, tableId, name, selfId);
  if (self?.kind === 'foreignKey') {
    return isMysqlSchemaConstraintTaken(m, name, selfId) || isMysqlTableIndexTaken(m, tableId, name, selfId);
  }
  if (self?.kind === 'check') {
    return isMysqlSchemaConstraintTaken(m, name, selfId);
  }
  return Object.values(m.objects).some((o) => {
    if (o.id === selfId) return false;
    if (o.kind === 'foreignKey' || o.kind === 'check') return o.name.toLowerCase() === low;
    if ((o.kind === 'unique' || o.kind === 'index') && o.parent === tableId)
      return o.name.toLowerCase() === low;
    return false;
  });
};

const refreshMysqlDerivedNames = (m: Model, tableId: string): void => {
  const t = get(m, tableId, 'table');
  const joinCols = (ids: string[]) => mysqlJoinNames(ids.map((c) => get(m, c, 'column').name));
  const tableCols = columnsOf(m, tableId);
  for (const o of allChildrenOf(m, tableId)) {
    if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey':
        o.name = 'PRIMARY';
        break;
      case 'unique':
        o.name = mysqlChooseName(t.name, joinCols(o.columns), 'key', (n) =>
          isMysqlTableIndexTaken(m, tableId, n, o.id),
        );
        break;
      case 'foreignKey':
        o.name = mysqlChooseName(
          t.name,
          joinCols(o.columns),
          'fkey',
          (n) => isMysqlSchemaConstraintTaken(m, n, o.id) || isMysqlTableIndexTaken(m, tableId, n, o.id),
        );
        break;
      case 'check': {
        const refs = tableCols.filter((c) => mysqlExprReferences(o.expr, c.name));
        o.name = mysqlChooseName(t.name, refs.length === 1 ? refs[0]!.name : null, 'check', (n) =>
          isMysqlSchemaConstraintTaken(m, n, o.id),
        );
        break;
      }
      case 'index':
        o.name = mysqlChooseName(t.name, mysqlJoinNames(indexElementNames(m, o)), 'idx', (n) =>
          isMysqlTableIndexTaken(m, tableId, n, o.id),
        );
        break;
    }
  }
};

const isReservedMysqlName = (val: string): string | null => {
  const low = val.toLowerCase();
  if (low.startsWith('dowel_')) return `名称 ${val} 不能使用 Dowel 迁移历史保留前缀 dowel_`;
  if (low === MYSQL_SHADOW_MARK_TABLE) return `名称 ${val} 保留给 Dowel 影子库标记，不能使用`;
  return null;
};

const validateMysqlIdent = (name: string, kind: IdentKind): string | null => {
  if (!name.trim()) return '标识符不能为空';
  if (Array.from(name).length > MAX_MYSQL_IDENT) {
    return `标识符 ${name} 超出 MySQL 长度上限（${MAX_MYSQL_IDENT} 字符）`;
  }
  if (kind === 'table' || kind === 'index') {
    const reserved = isReservedMysqlName(name);
    if (reserved) return reserved;
  }
  if (kind === 'index' && name.toLowerCase() === 'primary') {
    return 'MySQL 索引名不能使用保留名 PRIMARY';
  }
  return null;
};

const validateMysqlModel = (m: Model): string[] => {
  const errs: string[] = [];
  const ns = new Map<string, string>();
  const claim = (space: string, name: string, o: Obj) => {
    const k = `${space}\u0000${name.toLowerCase()}`;
    const prev = ns.get(k);
    if (prev && prev !== o.id) errs.push(`名字冲突（MySQL 不区分大小写）：${name}（${space}）`);
    ns.set(k, o.id);
  };
  const checkLen = (o: Obj, val: string) => {
    if (o.kind !== 'opaque' && Array.from(val).length > MAX_MYSQL_IDENT) {
      errs.push(`${o.kind} ${val}：超出 MySQL 标识符长度上限（${MAX_MYSQL_IDENT} 字符）`);
    }
  };

  const schemas = all(m, 'schema');
  if (schemas.length > 1)
    errs.push(`MySQL 仅支持单一逻辑 schema（default），发现 ${schemas.length} 个 schema`);
  for (const s of schemas) {
    if (s.name !== 'default') errs.push(`MySQL schema 名必须为 default（当前为 ${s.name}）`);
  }

  for (const o of Object.values(m.objects)) {
    checkLen(o, o.name);
    switch (o.kind) {
      case 'enum':
        errs.push(`enum ${o.name}：MySQL 不支持独立枚举对象，请使用列类型 enum(...)`);
        break;
      case 'sequence':
        errs.push(`sequence ${o.name}：MySQL 不支持独立序列，请使用列属性 AUTO_INCREMENT`);
        break;
      case 'extension':
        errs.push(`extension ${o.name}：MySQL 不支持扩展对象`);
        break;
      case 'table': {
        const resErr = isReservedMysqlName(o.name);
        if (resErr) errs.push(`table ${o.name}：${resErr}`);
        if (o.partitionBy !== null || o.partitionOf !== null) {
          errs.push(`table ${o.name}：MySQL 暂不支持声明式分区表编辑`);
        }
        if (o.ext?.mysql?.engine !== undefined && !MYSQL_SAFE_IDENT_RE.test(o.ext.mysql.engine)) {
          errs.push(
            `table ${o.name}：存储引擎名 ${o.ext.mysql.engine} 格式不合法（仅允许字母、数字与下划线）`,
          );
        }
        if (o.ext?.mysql?.charset !== undefined && !MYSQL_SAFE_IDENT_RE.test(o.ext.mysql.charset)) {
          errs.push(
            `table ${o.name}：字符集名 ${o.ext.mysql.charset} 格式不合法（仅允许字母、数字与下划线）`,
          );
        }
        if (o.ext?.mysql?.collation !== undefined && !MYSQL_SAFE_IDENT_RE.test(o.ext.mysql.collation)) {
          errs.push(
            `table ${o.name}：排序规则名 ${o.ext.mysql.collation} 格式不合法（仅允许字母、数字与下划线）`,
          );
        }
        claim('rel', o.name, o);
        break;
      }
      case 'column':
        claim(`col:${o.parent}`, o.name, o);
        if (o.identity) errs.push(`列 ${o.name}：MySQL 不支持 PG IDENTITY，请使用 AUTO_INCREMENT`);
        if (o.typeRef) errs.push(`列 ${o.name}：MySQL 不支持独立枚举类型引用`);
        if (o.default && 'nextval' in o.default) errs.push(`列 ${o.name}：MySQL 不支持序列默认值`);
        if (o.ext?.mysql?.charset !== undefined && !MYSQL_SAFE_IDENT_RE.test(o.ext.mysql.charset)) {
          errs.push(`列 ${o.name}：字符集名 ${o.ext.mysql.charset} 格式不合法（仅允许字母、数字与下划线）`);
        }
        if (o.collation !== null && !MYSQL_SAFE_IDENT_RE.test(o.collation)) {
          errs.push(`列 ${o.name}：排序规则名 ${o.collation} 格式不合法（仅允许字母、数字与下划线）`);
        }
        break;
      case 'primaryKey':
        break;
      case 'unique':
        if (o.name.toLowerCase() === 'primary') errs.push(`唯一约束 ${o.name}：不能使用保留名 PRIMARY`);
        if (o.nullsNotDistinct) errs.push(`唯一约束 ${o.name}：MySQL 不支持 NULLS NOT DISTINCT`);
        claim(`idx:${o.parent}`, o.name, o);
        break;
      case 'foreignKey':
        claim('schema_con', o.name, o);
        break;
      case 'check':
        claim('schema_con', o.name, o);
        break;
      case 'index': {
        const resErr = isReservedMysqlName(o.name);
        if (resErr) errs.push(`index ${o.name}：${resErr}`);
        if (o.name.toLowerCase() === 'primary') errs.push(`索引 ${o.name}：不能使用保留名 PRIMARY`);
        if (o.include.length > 0) errs.push(`索引 ${o.name}：MySQL 不支持 INCLUDE 覆盖列`);
        if (o.where) errs.push(`索引 ${o.name}：MySQL 不支持部分索引 WHERE 子句`);
        if (o.nullsNotDistinct) errs.push(`索引 ${o.name}：MySQL 不支持 NULLS NOT DISTINCT`);
        claim(`idx:${o.parent}`, o.name, o);
        break;
      }
      case 'opaque': {
        const resErr = isReservedMysqlName(o.name);
        if (resErr) errs.push(`${o.objType} ${o.name}：${resErr}`);
        if (o.objType === 'view') claim('rel', o.name, o);
        else claim(`opaque:${o.objType}`, o.name, o);
        break;
      }
    }
  }

  for (const t of all(m, 'table')) {
    const cols = columnsOf(m, t.id);
    if (cols.length === 0) errs.push(`表 ${t.name}：MySQL 表至少需要一列`);

    const indexedFirstCols = new Set<string>();
    for (const pk of childrenOf(m, t.id, 'primaryKey'))
      if (pk.columns[0]) indexedFirstCols.add(pk.columns[0]);
    for (const u of childrenOf(m, t.id, 'unique')) if (u.columns[0]) indexedFirstCols.add(u.columns[0]);
    for (const ix of childrenOf(m, t.id, 'index')) {
      const idxType = (ix.ext?.mysql?.indexType ?? ix.method).toUpperCase();
      if (idxType !== 'FULLTEXT' && idxType !== 'SPATIAL' && ix.elements[0]?.column) {
        indexedFirstCols.add(ix.elements[0]!.column);
      }
    }

    const aiCols = cols.filter((c) => c.ext?.mysql?.autoIncrement);
    if (aiCols.length > 1) {
      errs.push(
        `表 ${t.name}：每张表最多只能有一列 AUTO_INCREMENT（当前有 ${aiCols.map((c) => c.name).join('、')}）`,
      );
    }
    if (aiCols.length > 0) {
      for (const gc of cols) {
        if (!gc.generated) continue;
        for (const ai of aiCols) {
          if (mysqlExprReferences(gc.generated.expr, ai.name)) {
            errs.push(`表 ${t.name}：生成列 ${gc.name} 不能引用 AUTO_INCREMENT 列 ${ai.name}`);
          }
        }
      }
    }
    for (const c of aiCols) {
      if (!isMysqlAutoIncrementType(c.type)) {
        errs.push(`表 ${t.name} 列 ${c.name}：AUTO_INCREMENT 只能用于整数或浮点类型（当前为 ${c.type}）`);
      }
      if (c.generated) errs.push(`表 ${t.name} 列 ${c.name}：生成列不能设为 AUTO_INCREMENT`);
      if (c.default) errs.push(`表 ${t.name} 列 ${c.name}：AUTO_INCREMENT 列不能有默认值`);
      if (!c.notNull) errs.push(`表 ${t.name} 列 ${c.name}：AUTO_INCREMENT 列必须为 NOT NULL`);
      if (!indexedFirstCols.has(c.id)) {
        errs.push(`表 ${t.name} 列 ${c.name}：AUTO_INCREMENT 列必须作为主键、唯一约束或索引的首列`);
      }
    }
  }

  return errs;
};

const formatMysqlScript = (steps: readonly { sql: string }[]): string =>
  steps.map((s) => `${s.sql};`).join('\n\n');

export const mysqlDialect: DialectSpec = {
  id: 'mysql',
  capabilities: MYSQL_CAPABILITIES,
  quoteIdent: mysqlIdent,
  quoteQualified: mysqlQualified,
  literal: mysqlLiteral,
  keywords: MYSQL_KEYWORDS,
  tokenize: mysqlTokenize,
  columnRefs: mysqlColumnRefs,
  exprReferences: mysqlExprReferences,
  renameInExpr: mysqlRenameInExpr,
  renameQualifiedInExpr: mysqlRenameQualifiedInExpr,
  normalizeType: mysqlNormalizeType,
  commonTypes: MYSQL_COMMON_TYPES,
  emptyBase: (like, _scope) => {
    const m = emptyModel('mysql');
    const def = Object.values(like.objects).find((o) => o.kind === 'schema' && o.name === 'default');
    const id = def?.id ?? EMPTY_DEFAULT_ID;
    m.objects[id] = { id, kind: 'schema', name: 'default', comment: null };
    return m;
  },
  validateIdent: validateMysqlIdent,
  formatScript: formatMysqlScript,
  validateModel: validateMysqlModel,
  refreshDerivedNames: refreshMysqlDerivedNames,
  isNameTaken: (m, space, containerId, name, selfId) => {
    if (space === 'con') return isMysqlConTaken(m, containerId, name, selfId);
    const self = selfId ? m.objects[selfId] : undefined;
    if (self && (self.kind === 'index' || self.kind === 'unique' || self.kind === 'primaryKey')) {
      return isMysqlTableIndexTaken(m, self.parent, name, selfId);
    }
    return isMysqlTableOrViewTaken(m, name, selfId);
  },
  plan: (from, to, opts) => mysqlPlan(from, to, opts as MysqlPlanOptions | undefined),
  createAll: (m, opts) => mysqlCreateAll(m, opts as MysqlPlanOptions | undefined),
  isNontransactionalSql: mysqlIsNontransactionalSql,
  isConcurrentDdlSql: mysqlIsConcurrentDdlSql,
  findInstanceLevelStatement: mysqlFindInstanceLevelStatement,
  instanceLevelDescription: MYSQL_INSTANCE_LEVEL_DESCRIPTION,
};
