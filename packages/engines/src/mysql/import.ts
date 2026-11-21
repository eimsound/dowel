// MySQL 快照 → IR（Model）：分配对象 ID、推导或保留显式约束名、映射 MySQL 专属扩展与不透明对象依赖。
import {
  type Column,
  type ColumnExt,
  emptyModel,
  type FkAction,
  type Index,
  type IndexExt,
  indexElementNames,
  type Model,
  MYSQL_KEYWORDS,
  mysqlChooseName,
  mysqlExprReferences,
  mysqlJoinNames,
  mysqlTokenize,
  newId,
  type TableExt,
} from '@dowel/core';
import { generateKeyBetween } from 'fractional-indexing';

import type { MysqlSnapshot } from './snapshot.ts';

export const importMysqlSnapshot = (snap: MysqlSnapshot): Model => {
  const m = emptyModel('mysql');
  const put = <T extends { id: string }>(o: T) => {
    m.objects[o.id] = o as never;
    return o;
  };

  const defaultSchemaId = put({
    id: newId(),
    kind: 'schema' as const,
    name: 'default',
    comment: null,
  }).id;

  const tableIdByLower = new Map<string, string>();
  const colIdByTableAndLower = new Map<string, string>();

  // 1. 表和列
  for (const t of Object.values(snap.tables)) {
    const mysqlTblExt: NonNullable<TableExt['mysql']> = {};
    if (t.engine.toLowerCase() !== 'innodb') mysqlTblExt.engine = t.engine;
    if (t.charset.toLowerCase() !== snap.defaultCharset.toLowerCase()) mysqlTblExt.charset = t.charset;
    if (t.collation.toLowerCase() !== snap.defaultCollation.toLowerCase())
      mysqlTblExt.collation = t.collation;
    const ext: TableExt | undefined =
      Object.keys(mysqlTblExt).length > 0 ? { mysql: mysqlTblExt } : undefined;

    const tid = put({
      id: newId(),
      kind: 'table' as const,
      parent: defaultSchemaId,
      name: t.name,
      partitionBy: null,
      partitionOf: null,
      comment: t.comment,
      ...(ext ? { ext } : {}),
    }).id;
    tableIdByLower.set(t.name.toLowerCase(), tid);

    const colsSorted = Object.entries(t.columns).sort(
      ([, a], [, b]) => a.ordinalPosition - b.ordinalPosition,
    );
    let prevPos: string | null = null;
    for (const [colName, c] of colsSorted) {
      const pos = generateKeyBetween(prevPos, null);
      prevPos = pos;

      const mysqlColExt: NonNullable<ColumnExt['mysql']> = {};
      if (c.unsigned) mysqlColExt.unsigned = true;
      if (c.zerofill) mysqlColExt.zerofill = true;
      if (c.autoIncrement) mysqlColExt.autoIncrement = true;
      if (c.charset) mysqlColExt.charset = c.charset;
      if (c.onUpdateCurrentTimestamp) mysqlColExt.onUpdateCurrentTimestamp = true;
      const colExt: ColumnExt | undefined =
        Object.keys(mysqlColExt).length > 0 ? { mysql: mysqlColExt } : undefined;

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
        comment: c.comment,
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

    if (t.primaryKey) {
      put({
        id: newId(),
        kind: 'primaryKey' as const,
        parent: tid,
        name: 'PRIMARY',
        nameMode: 'derived' as const,
        columns: t.primaryKey.columns.map(colId),
        comment: null,
      });
    }

    for (const u of Object.values(t.uniques)) {
      const derived = mysqlChooseName(t.name, mysqlJoinNames(u.columns), 'key');
      put({
        id: newId(),
        kind: 'unique' as const,
        parent: tid,
        name: u.name,
        nameMode: u.name === derived ? ('derived' as const) : ('explicit' as const),
        columns: u.columns.map(colId),
        nullsNotDistinct: false,
        comment: null,
      });
    }

    for (const ck of Object.values(t.checks)) {
      const colNames = Object.keys(t.columns);
      const refs = colNames.filter((cn) => mysqlExprReferences(ck.expr, cn));
      const derived = mysqlChooseName(t.name, refs.length === 1 ? refs[0]! : null, 'check');
      put({
        id: newId(),
        kind: 'check' as const,
        parent: tid,
        name: ck.name,
        nameMode: ck.name === derived ? ('derived' as const) : ('explicit' as const),
        expr: ck.expr,
        noInherit: false,
        comment: null,
      });
    }

    for (const fk of Object.values(t.foreignKeys)) {
      const refTid = tableIdByLower.get(fk.refTable.toLowerCase());
      if (!refTid) continue;
      const refColIds = fk.refColumns
        .map((rc) => colIdByTableAndLower.get(`${refTid}\0${rc.toLowerCase()}`))
        .filter((x): x is string => Boolean(x));
      if (refColIds.length !== fk.columns.length) continue;
      const derived = mysqlChooseName(t.name, mysqlJoinNames(fk.columns), 'fkey');
      put({
        id: newId(),
        kind: 'foreignKey' as const,
        parent: tid,
        name: fk.name,
        nameMode: fk.name === derived ? ('derived' as const) : ('explicit' as const),
        columns: fk.columns.map(colId),
        refTable: refTid,
        refColumns: refColIds,
        onDelete: fk.onDelete as FkAction,
        onUpdate: fk.onUpdate as FkAction,
        match: 'simple' as const,
        deferrable: false,
        initiallyDeferred: false,
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
        collation: null,
      }));
      const draft: Pick<Index, 'elements' | 'include'> = { elements, include: [] };
      const derived = mysqlChooseName(t.name, mysqlJoinNames(indexElementNames(m, draft)), 'idx');

      const mysqlIdxExt: NonNullable<IndexExt['mysql']> = {};
      if (ix.indexType !== 'BTREE') mysqlIdxExt.indexType = ix.indexType;
      if (ix.elements.some((e) => e.length !== null)) {
        mysqlIdxExt.lengths = ix.elements.map((e) => e.length);
      }
      const idxExt: IndexExt | undefined =
        Object.keys(mysqlIdxExt).length > 0 ? { mysql: mysqlIdxExt } : undefined;

      put({
        id: newId(),
        kind: 'index' as const,
        parent: tid,
        name: idxName,
        nameMode: idxName === derived ? ('derived' as const) : ('explicit' as const),
        unique: ix.unique,
        method: ix.indexType.toLowerCase(),
        elements,
        include: [],
        where: null,
        nullsNotDistinct: false,
        comment: ix.comment,
        ...(idxExt ? { ext: idxExt } : {}),
      });
    }
  }

  // 3. 不透明对象（视图、触发器、函数、存储过程）及依赖解析
  const opaqueEntries = Object.values(snap.opaques).map((op) => ({ op, id: newId() }));
  const viewIdByLower = new Map<string, string>();
  const routineIdByLower = new Map<string, string>();
  for (const { op, id } of opaqueEntries) {
    if (op.objType === 'view') viewIdByLower.set(op.name.toLowerCase(), id);
    else if (op.objType === 'function' || op.objType === 'procedure') {
      routineIdByLower.set(op.name.toLowerCase(), id);
    }
  }

  const resolveOpaqueDeps = (
    op: MysqlSnapshot['opaques'][string],
    selfId: string,
    parentId: string,
  ): string[] => {
    const depSet = new Set<string>();
    const refTableIds = new Set<string>();
    const aliases = new Map<string, string>();
    if (op.objType === 'trigger' && parentId !== defaultSchemaId) {
      depSet.add(parentId);
      refTableIds.add(parentId);
      aliases.set('new', parentId);
      aliases.set('old', parentId);
    }

    const toks = mysqlTokenize(op.ddl).filter(
      (t) =>
        !/^\s+$/.test(t.text) &&
        !t.text.startsWith('--') &&
        !t.text.startsWith('#') &&
        !t.text.startsWith('/*') &&
        t.text !== '*/',
    );
    const isId = (t: (typeof toks)[number] | undefined) => !!t && (t.kind === 'ident' || t.kind === 'qident');

    let bodyStart = 0;
    if (op.objType === 'view') {
      const asIdx = toks.findIndex((t) => t.kind === 'ident' && t.text === 'as');
      if (asIdx >= 0) bodyStart = asIdx + 1;
    } else if (op.objType === 'trigger') {
      const onIdx = toks.findIndex((t) => t.kind === 'ident' && t.text === 'on');
      if (onIdx >= 0) bodyStart = onIdx;
    }

    const tableIntro = new Set(['from', 'join', 'into', 'update', 'on']);
    for (let i = bodyStart; i < toks.length; i++) {
      const cur = toks[i]!;
      if (!isId(cur)) continue;
      const low = cur.text.toLowerCase();
      if (cur.kind === 'ident' && MYSQL_KEYWORDS.has(low)) continue;
      const prev = toks[i - 1];
      const next = toks[i + 1];

      if (next?.text === '(') {
        const rid = routineIdByLower.get(low);
        if (rid && rid !== selfId) depSet.add(rid);
        if (prev?.text.toLowerCase() !== 'into') continue;
      }

      const tid = tableIdByLower.get(low);
      if (tid) {
        depSet.add(tid);
        refTableIds.add(tid);
        aliases.set(low, tid);
        const introWord = prev?.text === '.' ? toks[i - 3]?.text.toLowerCase() : prev?.text.toLowerCase();
        if (introWord && tableIntro.has(introWord)) {
          let aIdx = i + 1;
          if (toks[aIdx]?.kind === 'ident' && toks[aIdx]!.text === 'as') aIdx++;
          const aliasTok = toks[aIdx];
          if (isId(aliasTok) && !(aliasTok!.kind === 'ident' && MYSQL_KEYWORDS.has(aliasTok!.text))) {
            aliases.set(aliasTok!.text.toLowerCase(), tid);
          }
        }
        continue;
      }

      const vid = viewIdByLower.get(low);
      if (vid && vid !== selfId) depSet.add(vid);
    }

    for (let i = bodyStart; i < toks.length; i++) {
      const cur = toks[i]!;
      if (!isId(cur)) continue;
      const low = cur.text.toLowerCase();
      const next = toks[i + 1];
      const prev = toks[i - 1];

      if (next?.text === '.' && isId(toks[i + 2])) {
        const tid = aliases.get(low);
        if (tid) {
          const cid = colIdByTableAndLower.get(`${tid}\0${toks[i + 2]!.text.toLowerCase()}`);
          if (cid) depSet.add(cid);
        }
        continue;
      }
      if (prev?.text === '.' || next?.text === '(') continue;
      if (cur.kind === 'ident' && MYSQL_KEYWORDS.has(low)) continue;
      if (tableIdByLower.has(low) || viewIdByLower.has(low)) continue;

      for (const tid of refTableIds) {
        const cid = colIdByTableAndLower.get(`${tid}\0${low}`);
        if (cid) depSet.add(cid);
      }
    }

    depSet.delete(selfId);
    return [...depSet];
  };

  for (const { op, id } of opaqueEntries) {
    const parentId =
      op.objType === 'trigger' && op.tblName
        ? (tableIdByLower.get(op.tblName.toLowerCase()) ?? defaultSchemaId)
        : defaultSchemaId;
    put({
      id,
      kind: 'opaque' as const,
      objType: op.objType,
      parent: parentId,
      name: op.name,
      ddl: [op.ddl],
      drop: op.drop,
      deps: resolveOpaqueDeps(op, id, parentId),
      order: op.order,
      comment: null,
    });
  }

  return m;
};
