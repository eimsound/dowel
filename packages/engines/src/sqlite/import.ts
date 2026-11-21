// SQLite 快照 → IR（Model）：为所有对象分配 ID，推导或保留显式约束名，映射 STRICT / WITHOUT ROWID / AUTOINCREMENT。
import {
  type Column,
  emptyModel,
  type FkAction,
  type Index,
  indexElementNames,
  type Model,
  newId,
  sqliteChooseName,
  sqliteExprReferences,
  sqliteJoinNames,
} from '@dowel/core';
import { generateKeyBetween } from 'fractional-indexing';

import type { SqliteSnapshot } from './snapshot.ts';

export const importSqliteSnapshot = (snap: SqliteSnapshot): Model => {
  const m = emptyModel('sqlite');
  const put = <T extends { id: string }>(o: T) => {
    m.objects[o.id] = o as never;
    return o;
  };

  const mainId = put({ id: newId(), kind: 'schema' as const, name: 'main', comment: null }).id;
  const tableIdByLower = new Map<string, string>();
  const colIdByTableAndLower = new Map<string, string>(); // `${tableId}\0${colLower}` -> colId

  // 1. 表和列
  for (const t of Object.values(snap.tables)) {
    const ext =
      t.strict || t.withoutRowid
        ? {
            sqlite: {
              ...(t.strict ? { strict: true } : {}),
              ...(t.withoutRowid ? { withoutRowid: true } : {}),
            },
          }
        : undefined;
    const tid = put({
      id: newId(),
      kind: 'table' as const,
      parent: mainId,
      name: t.name,
      partitionBy: null,
      partitionOf: null,
      comment: null,
      ...(ext ? { ext } : {}),
    }).id;
    tableIdByLower.set(t.name.toLowerCase(), tid);

    const colsSorted = Object.entries(t.columns).sort(([, a], [, b]) => a.cid - b.cid);
    let prevPos: string | null = null;
    for (const [colName, c] of colsSorted) {
      const pos = generateKeyBetween(prevPos, null);
      prevPos = pos;
      const colExt = c.autoincrement ? { sqlite: { autoincrement: true } } : undefined;
      const col: Column = {
        id: newId(),
        kind: 'column',
        parent: tid,
        name: colName,
        pos,
        type: c.type,
        typeRef: null,
        notNull: c.notNull,
        notNullName: null,
        notNullNameMode: 'derived',
        default: c.default !== null ? { expr: c.default } : null,
        identity: null,
        generated: c.generated ? { expr: c.generated.expr, stored: c.generated.stored } : null,
        collation: c.collation,
        comment: null,
        ...(colExt ? { ext: colExt } : {}),
      };
      put(col);
      colIdByTableAndLower.set(`${tid}\0${colName.toLowerCase()}`, col.id);
    }
  }

  // 2. 约束与索引
  for (const t of Object.values(snap.tables)) {
    const tid = tableIdByLower.get(t.name.toLowerCase())!;
    const colId = (colName: string): string => colIdByTableAndLower.get(`${tid}\0${colName.toLowerCase()}`)!;
    const usedConLower = new Set<string>();
    const takeConName = (explicitName: string | null, n2: string | null, label: string) => {
      if (explicitName) {
        usedConLower.add(explicitName.toLowerCase());
        return { name: explicitName, nameMode: 'explicit' as const };
      }
      const chosen = sqliteChooseName(t.name, n2, label, (n) => usedConLower.has(n.toLowerCase()));
      usedConLower.add(chosen.toLowerCase());
      return { name: chosen, nameMode: 'derived' as const };
    };

    if (t.primaryKey) {
      const { name, nameMode } = takeConName(t.primaryKey.name, null, 'pkey');
      put({
        id: newId(),
        kind: 'primaryKey' as const,
        parent: tid,
        name,
        nameMode,
        columns: t.primaryKey.columns.map(colId),
        comment: null,
      });
    }

    for (const u of t.uniques) {
      const { name, nameMode } = takeConName(u.name, sqliteJoinNames(u.columns), 'key');
      put({
        id: newId(),
        kind: 'unique' as const,
        parent: tid,
        name,
        nameMode,
        columns: u.columns.map(colId),
        nullsNotDistinct: false,
        comment: null,
      });
    }

    for (const ck of t.checks) {
      const colNames = Object.keys(t.columns);
      const refs = colNames.filter((cn) => sqliteExprReferences(ck.expr, cn));
      const { name, nameMode } = takeConName(ck.name, refs.length === 1 ? refs[0]! : null, 'check');
      put({
        id: newId(),
        kind: 'check' as const,
        parent: tid,
        name,
        nameMode,
        expr: ck.expr,
        noInherit: false,
        comment: null,
      });
    }

    for (const fk of t.foreignKeys) {
      const refTid = tableIdByLower.get(fk.refTable.toLowerCase());
      if (!refTid) continue;
      const refColIds = fk.refColumns
        .map((rc) => colIdByTableAndLower.get(`${refTid}\0${rc.toLowerCase()}`))
        .filter((x): x is string => Boolean(x));
      if (refColIds.length !== fk.columns.length) continue;
      const { name, nameMode } = takeConName(fk.name, sqliteJoinNames(fk.columns), 'fkey');
      put({
        id: newId(),
        kind: 'foreignKey' as const,
        parent: tid,
        name,
        nameMode,
        columns: fk.columns.map(colId),
        refTable: refTid,
        refColumns: refColIds,
        onDelete: fk.onDelete as FkAction,
        onUpdate: fk.onUpdate as FkAction,
        match: 'simple' as const,
        deferrable: fk.deferrable,
        initiallyDeferred: fk.initiallyDeferred,
        comment: null,
      });
    }

    for (const [idxName, ix] of Object.entries(t.indexes)) {
      const elements = ix.elements.map((e) => ({
        column: e.column ? colId(e.column) : null,
        expr: e.expr,
        desc: e.desc,
        nullsFirst: null,
        opclass: null,
        collation: e.collation,
      }));
      const draft: Pick<Index, 'elements' | 'include'> = { elements, include: [] };
      const derived = sqliteChooseName(t.name, sqliteJoinNames(indexElementNames(m, draft)), 'idx');
      put({
        id: newId(),
        kind: 'index' as const,
        parent: tid,
        name: idxName,
        nameMode: idxName === derived ? ('derived' as const) : ('explicit' as const),
        unique: ix.unique,
        method: 'btree',
        elements,
        include: [],
        where: ix.where,
        nullsNotDistinct: false,
        comment: null,
      });
    }
  }

  // 3. 不透明对象（视图、触发器）
  for (const op of Object.values(snap.opaques)) {
    const parentId =
      op.objType === 'trigger' ? (tableIdByLower.get(op.tblName.toLowerCase()) ?? mainId) : mainId;
    const deps: string[] = [];
    if (op.objType === 'trigger' && parentId !== mainId) deps.push(parentId);
    put({
      id: newId(),
      kind: 'opaque' as const,
      objType: op.objType,
      parent: parentId,
      name: op.name,
      ddl: [op.ddl],
      drop: op.drop,
      deps,
      order: op.order,
      comment: null,
    });
  }

  return m;
};
