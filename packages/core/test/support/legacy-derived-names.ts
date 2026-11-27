// 参照实现：main（e1f0026）上四种方言 refreshDerivedNames 的原样拷贝，只用于差分测试，生产代码绝不引用。
// 与 main 唯一的区别：PG 叠加索引分支里的重名判定改用同语义的全模型扫描（main 的 OverlayModelIndex 判定与之等价，
// 见 model-index.test.ts），避免参照实现依赖本次改动的索引。
import {
  allChildrenOf,
  childrenOfKinds,
  colName,
  columnsOf,
  effectiveColumnsOf,
  get,
  getActiveModelIndex,
  indexElementNames,
  type Model,
  mssqlExprReferences,
  mysqlExprReferences,
  type Obj,
  objectsOfKinds,
  OverlayModelIndex,
  partitionAncestors,
  partitionDescendants,
  sqliteExprReferences,
} from '../../src/index.ts';
import { mssqlChooseName, mssqlJoinNames } from '../../src/mssql/naming.ts';
import { mssqlDefaultNameOf } from '../../src/mssql/plan.ts';
import { mysqlChooseName, mysqlJoinNames } from '../../src/mysql/naming.ts';
import { exprReferences } from '../../src/pg/expr.ts';
import { chooseName, joinNames } from '../../src/pg/naming.ts';
import { sqliteChooseName, sqliteJoinNames } from '../../src/sqlite/naming.ts';

// ───── PG ─────

const schemaOf = (m: Model, tableId: string) => get(m, tableId, 'table').parent;

const pgRelTakenScan = (m: Model, schema: string, name: string, self: string): boolean =>
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

const pgConTakenScan = (m: Model, table: string, name: string, self: string): boolean => {
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

const legacyPgWithIndex = (
  m: Model,
  tableId: string,
  t: { name: string; parent: string },
  idx: NonNullable<ReturnType<typeof getActiveModelIndex>>,
): void => {
  const schema = t.parent;
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    chooseName(
      n1,
      n2,
      label,
      (n) => (rel && pgRelTakenScan(m, schema, n, id)) || (con && pgConTakenScan(m, tableId, n, id)),
    );
  const joinCols = (ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
  for (const c of columnsOf(m, tableId)) {
    if (c.notNull && c.notNullNameMode === 'derived')
      c.notNullName = choose(`${c.id}#nn`, t.name, c.name, 'not_null', false, true);
    if (c.identity?.sequenceNameMode === 'derived')
      c.identity.sequenceName = choose(`${c.id}#seq`, t.name, c.name, 'seq', true, false);
    for (const s of idx.sequencesOwnedBy(c.id))
      if (s.nameMode === 'derived') s.name = choose(s.id, t.name, c.name, 'seq', true, false);
  }
  const effCols = effectiveColumnsOf(m, tableId);
  for (const o of allChildrenOf(m, tableId)) {
    if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
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
        const refs = effCols.filter((c) => exprReferences(o.expr, c.name));
        o.name = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        break;
      }
      case 'index':
        o.name = choose(o.id, t.name, joinNames(indexElementNames(m, o)), 'idx', true, false);
        break;
    }
  }
};

const addNameOwner = (owners: Map<string, Set<string>>, name: string, ownerId: string) => {
  let set = owners.get(name);
  if (!set) {
    set = new Set();
    owners.set(name, set);
  }
  set.add(ownerId);
};

const moveNameOwner = (
  owners: Map<string, Set<string>>,
  oldName: string | null,
  newName: string | null,
  ownerId: string,
) => {
  if (oldName === newName) return;
  if (oldName) {
    const set = owners.get(oldName);
    if (set) {
      set.delete(ownerId);
      if (set.size === 0) owners.delete(oldName);
    }
  }
  if (newName) addNameOwner(owners, newName, ownerId);
};

const hasOtherNameOwner = (
  owners: Map<string, Set<string>>,
  name: string,
  self: string,
  extraExclude?: string,
): boolean => {
  const set = owners.get(name);
  if (!set || set.size === 0) return false;
  for (const ow of set) {
    if (ow !== self && ow !== extraExclude) return true;
  }
  return false;
};

export const legacyRefreshPg = (m: Model, tableId: string): void => {
  const t = get(m, tableId, 'table');
  const activeIdx = getActiveModelIndex(m);
  if (activeIdx instanceof OverlayModelIndex) {
    legacyPgWithIndex(m, tableId, t, activeIdx);
    return;
  }
  const schema = t.parent;
  const relOwners = new Map<string, Set<string>>();
  const localConOwners = new Map<string, Set<string>>();
  const propConOwners = new Map<string, Set<string>>();
  const ancIds = new Set(partitionAncestors(m, tableId).map((a) => a.id));
  const descIds = new Set(partitionDescendants(m, tableId).map((d) => d.id));
  const tableChildren: Obj[] = [];
  const ownedSeqsByCol = new Map<string, Extract<Obj, { kind: 'sequence' }>[]>();

  for (const o of Object.values(m.objects)) {
    if ('parent' in o && o.parent === tableId) tableChildren.push(o);
    if (o.kind === 'sequence' && o.ownedBy) {
      const list = ownedSeqsByCol.get(o.ownedBy);
      if (list) list.push(o);
      else ownedSeqsByCol.set(o.ownedBy, [o]);
    }
    if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schema) {
      addNameOwner(relOwners, o.name, o.id);
    } else if (
      (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') &&
      schemaOf(m, o.parent) === schema
    ) {
      addNameOwner(relOwners, o.name, o.id);
    } else if (o.kind === 'column' && o.identity && schemaOf(m, o.parent) === schema) {
      addNameOwner(relOwners, o.identity.sequenceName, `${o.id}#seq`);
    }

    if (o.kind === 'column' && o.notNull && o.notNullName) {
      if (o.parent === tableId || ancIds.has(o.parent)) {
        addNameOwner(localConOwners, o.notNullName, `${o.id}#nn`);
        addNameOwner(propConOwners, o.notNullName, `${o.id}#nn`);
      } else if (descIds.has(o.parent)) {
        addNameOwner(propConOwners, o.notNullName, `${o.id}#nn`);
      }
    } else if ('parent' in o) {
      if (o.parent === tableId) {
        if (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') {
          addNameOwner(localConOwners, o.name, o.id);
          addNameOwner(propConOwners, o.name, o.id);
        }
      } else if (ancIds.has(o.parent)) {
        if (o.kind === 'check' || o.kind === 'foreignKey') {
          addNameOwner(localConOwners, o.name, o.id);
          addNameOwner(propConOwners, o.name, o.id);
        }
      } else if (descIds.has(o.parent)) {
        if (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') {
          addNameOwner(propConOwners, o.name, o.id);
        }
      }
    }
  }

  const isConTakenLocal = (id: string, name: string): boolean => {
    const excludeNn = id.endsWith('#nn') ? id : undefined;
    const selfObj = id && !id.endsWith('#nn') ? m.objects[id] : undefined;
    const selfPropagates =
      id === '' || id.endsWith('#nn') || selfObj?.kind === 'check' || selfObj?.kind === 'foreignKey';
    return hasOtherNameOwner(selfPropagates ? propConOwners : localConOwners, name, id, excludeNn);
  };
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    chooseName(
      n1,
      n2,
      label,
      (n) => (rel && hasOtherNameOwner(relOwners, n, id)) || (con && isConTakenLocal(id, n)),
    );
  const joinCols = (ids: string[]) => joinNames(ids.map((c) => colName(m, c)));
  const cols = tableChildren
    .filter((o): o is Extract<Obj, { kind: 'column' }> => o.kind === 'column')
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1));
  const effCols = t.partitionOf ? effectiveColumnsOf(m, tableId) : cols;

  for (const c of cols) {
    if (c.notNull && c.notNullNameMode === 'derived') {
      const nextName = choose(`${c.id}#nn`, t.name, c.name, 'not_null', false, true);
      moveNameOwner(localConOwners, c.notNullName, nextName, `${c.id}#nn`);
      moveNameOwner(propConOwners, c.notNullName, nextName, `${c.id}#nn`);
      c.notNullName = nextName;
    }
    if (c.identity?.sequenceNameMode === 'derived') {
      const nextName = choose(`${c.id}#seq`, t.name, c.name, 'seq', true, false);
      moveNameOwner(relOwners, c.identity.sequenceName, nextName, `${c.id}#seq`);
      c.identity.sequenceName = nextName;
    }
    for (const s of ownedSeqsByCol.get(c.id) ?? []) {
      if (s.nameMode === 'derived') {
        const nextName = choose(s.id, t.name, c.name, 'seq', true, false);
        if (s.parent === schema) moveNameOwner(relOwners, s.name, nextName, s.id);
        s.name = nextName;
      }
    }
  }
  for (const o of tableChildren) {
    if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey': {
        const nextName = choose(o.id, t.name, null, 'pkey', true, true);
        moveNameOwner(relOwners, o.name, nextName, o.id);
        moveNameOwner(localConOwners, o.name, nextName, o.id);
        moveNameOwner(propConOwners, o.name, nextName, o.id);
        o.name = nextName;
        break;
      }
      case 'unique': {
        const nextName = choose(o.id, t.name, joinCols(o.columns), 'key', true, true);
        moveNameOwner(relOwners, o.name, nextName, o.id);
        moveNameOwner(localConOwners, o.name, nextName, o.id);
        moveNameOwner(propConOwners, o.name, nextName, o.id);
        o.name = nextName;
        break;
      }
      case 'foreignKey': {
        const nextName = choose(o.id, t.name, joinCols(o.columns), 'fkey', false, true);
        moveNameOwner(localConOwners, o.name, nextName, o.id);
        moveNameOwner(propConOwners, o.name, nextName, o.id);
        o.name = nextName;
        break;
      }
      case 'check': {
        const refs = effCols.filter((c) => exprReferences(o.expr, c.name));
        const nextName = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        moveNameOwner(localConOwners, o.name, nextName, o.id);
        moveNameOwner(propConOwners, o.name, nextName, o.id);
        o.name = nextName;
        break;
      }
      case 'index': {
        const nextName = choose(o.id, t.name, joinNames(indexElementNames(m, o)), 'idx', true, false);
        moveNameOwner(relOwners, o.name, nextName, o.id);
        o.name = nextName;
        break;
      }
    }
  }
};

// ───── MySQL ─────

const isMysqlTableIndexTaken = (m: Model, tableId: string, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  if (low === 'primary') return true;
  return childrenOfKinds(m, tableId, ['unique', 'index', 'foreignKey']).some((o) => {
    if (o.id === selfId) return false;
    if ((o.kind === 'unique' || o.kind === 'index' || o.kind === 'foreignKey') && o.parent === tableId) {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

const isMysqlSchemaConstraintTaken = (m: Model, name: string, selfId: string): boolean => {
  const low = name.toLowerCase();
  return objectsOfKinds(m, ['foreignKey', 'check']).some((o) => {
    if (o.id === selfId) return false;
    if (o.kind === 'foreignKey' || o.kind === 'check') {
      return o.name.toLowerCase() === low;
    }
    return false;
  });
};

export const legacyRefreshMysql = (m: Model, tableId: string): void => {
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

// ───── SQLite ─────

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

export const legacyRefreshSqlite = (m: Model, tableId: string): void => {
  const t = get(m, tableId, 'table');
  const choose = (id: string, n1: string, n2: string | null, label: string, rel: boolean, con: boolean) =>
    sqliteChooseName(
      n1,
      n2,
      label,
      (n) => (rel && isSqliteRelTaken(m, n, id)) || (con && isSqliteConTaken(m, tableId, n, id)),
    );
  const joinCols = (ids: string[]) => sqliteJoinNames(ids.map((c) => get(m, c, 'column').name));
  const tableCols = columnsOf(m, tableId);
  for (const o of allChildrenOf(m, tableId)) {
    if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey':
        o.name = choose(o.id, t.name, null, 'pkey', false, true);
        break;
      case 'unique':
        o.name = choose(o.id, t.name, joinCols(o.columns), 'key', false, true);
        break;
      case 'foreignKey':
        o.name = choose(o.id, t.name, joinCols(o.columns), 'fkey', false, true);
        break;
      case 'check': {
        const refs = tableCols.filter((c) => sqliteExprReferences(o.expr, c.name));
        o.name = choose(o.id, t.name, refs.length === 1 ? refs[0]!.name : null, 'check', false, true);
        break;
      }
      case 'index':
        o.name = choose(o.id, t.name, sqliteJoinNames(indexElementNames(m, o)), 'idx', true, false);
        break;
    }
  }
};

// ───── MSSQL ─────

const schemaOfTable = (m: Model, tableId: string): string => get(m, tableId, 'table').parent;

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

export const legacyRefreshMssql = (m: Model, tableId: string): void => {
  const t = get(m, tableId, 'table');
  const schemaId = t.parent;

  const chooseObj = (id: string, prefix: string, n1: string, n2: string | null, alsoIdx: boolean) =>
    mssqlChooseName(
      prefix,
      n1,
      n2,
      (n) => isMssqlObjTaken(m, schemaId, n, id) || (alsoIdx && isMssqlIdxTaken(m, tableId, n, id)),
    );
  const chooseIdx = (id: string, prefix: string, n1: string, n2: string | null) =>
    mssqlChooseName(prefix, n1, n2, (n) => isMssqlIdxTaken(m, tableId, n, id));
  const joinCols = (ids: string[]) => mssqlJoinNames(ids.map((c) => get(m, c, 'column').name));

  const tableCols = columnsOf(m, tableId);
  for (const c of tableCols) {
    if (c.default) {
      const mode = c.ext?.mssql?.defaultNameMode ?? 'derived';
      if (mode === 'derived') {
        const dfName = chooseObj(`${c.id}#df`, 'DF', t.name, c.name, false);
        c.ext = {
          ...c.ext,
          mssql: {
            ...c.ext?.mssql,
            defaultName: dfName,
            defaultNameMode: 'derived',
          },
        };
      }
    } else if (c.ext?.mssql?.defaultNameMode === 'derived' && c.ext.mssql.defaultName !== undefined) {
      delete c.ext.mssql.defaultName;
      delete c.ext.mssql.defaultNameMode;
      if (Object.keys(c.ext.mssql).length === 0) {
        delete c.ext.mssql;
        if (Object.keys(c.ext).length === 0) delete c.ext;
      }
    }
  }

  for (const o of allChildrenOf(m, tableId)) {
    if (!('nameMode' in o) || o.nameMode !== 'derived') continue;
    switch (o.kind) {
      case 'primaryKey':
        o.name = chooseObj(o.id, 'PK', t.name, null, true);
        break;
      case 'unique':
        o.name = chooseObj(o.id, 'UQ', t.name, joinCols(o.columns), true);
        break;
      case 'foreignKey':
        o.name = chooseObj(o.id, 'FK', t.name, joinCols(o.columns), false);
        break;
      case 'check': {
        const refs = tableCols.filter((c) => mssqlExprReferences(o.expr, c.name));
        o.name = chooseObj(o.id, 'CK', t.name, refs.length === 1 ? refs[0]!.name : null, false);
        break;
      }
      case 'index':
        o.name = chooseIdx(o.id, 'IX', t.name, mssqlJoinNames(indexElementNames(m, o)));
        break;
    }
  }
};

export const LEGACY_REFRESH = {
  pg: legacyRefreshPg,
  mysql: legacyRefreshMysql,
  sqlite: legacyRefreshSqlite,
  mssql: legacyRefreshMssql,
} as const;
