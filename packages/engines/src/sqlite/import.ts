// SQLite 快照 → IR（Model）：为所有对象分配 ID，推导或保留显式约束名，映射 STRICT / WITHOUT ROWID / AUTOINCREMENT。
import {
  type Column,
  emptyModel,
  type FkAction,
  type Index,
  indexElementNames,
  type Model,
  newId,
  SQLITE_KEYWORDS,
  sqliteChooseName,
  sqliteExprReferences,
  sqliteJoinNames,
  sqliteTokenize,
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

  // 3. 不透明对象（视图、触发器）：解析 DDL 依赖的表、列与上游视图 ID，供重建顺序与派生刷新使用
  const opaqueEntries = Object.values(snap.opaques).map((op) => ({ op, id: newId() }));
  const viewIdByLower = new Map<string, string>();
  for (const { op, id } of opaqueEntries) {
    if (op.objType === 'view') viewIdByLower.set(op.name.toLowerCase(), id);
  }

  const resolveOpaqueDeps = (
    op: SqliteSnapshot['opaques'][string],
    selfId: string,
    parentId: string,
  ): string[] => {
    const depSet = new Set<string>();
    const refTableIds = new Set<string>();
    const aliases = new Map<string, string>();
    if (op.objType === 'trigger' && parentId !== mainId) {
      depSet.add(parentId);
      refTableIds.add(parentId);
      aliases.set('new', parentId);
      aliases.set('old', parentId);
    }

    const toks = sqliteTokenize(op.ddl).filter(
      (t) => !/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*'),
    );
    const isId = (t: (typeof toks)[number] | undefined) => !!t && (t.kind === 'ident' || t.kind === 'qident');

    // 找到声明体起始位置，避免把视图/触发器自身名字误识别为依赖
    let bodyStart = 0;
    if (op.objType === 'view') {
      const asIdx = toks.findIndex((t) => t.kind === 'ident' && t.text === 'as');
      if (asIdx >= 0) bodyStart = asIdx + 1;
    } else if (op.objType === 'trigger') {
      const onIdx = toks.findIndex((t) => t.kind === 'ident' && t.text === 'on');
      if (onIdx >= 0) bodyStart = onIdx;
    }

    // 第一遍：识别引用的表、上游视图及 FROM/JOIN/INTO/UPDATE/ON 后的别名
    const tableIntro = new Set(['from', 'join', 'into', 'update', 'on']);
    for (let i = bodyStart; i < toks.length; i++) {
      const cur = toks[i]!;
      if (!isId(cur)) continue;
      const low = cur.text.toLowerCase();
      if (cur.kind === 'ident' && SQLITE_KEYWORDS.has(low)) continue;
      const prev = toks[i - 1];
      const next = toks[i + 1];
      const introWord =
        prev?.text === '.' && toks[i - 2]?.text.toLowerCase() === 'main'
          ? toks[i - 3]?.text.toLowerCase()
          : prev?.text.toLowerCase();
      // 跳过函数调用与列访问的右半部分（但保留 INSERT INTO tbl(col1, ...) 的目标表名）
      if (next?.text === '(' && introWord !== 'into') continue;
      if (prev?.text === '.' && toks[i - 2]?.text.toLowerCase() !== 'main') continue;

      const tid = tableIdByLower.get(low);
      if (tid) {
        depSet.add(tid);
        refTableIds.add(tid);
        aliases.set(low, tid);
        // 记录表别名（例如 FROM users u 或 FROM users AS u）
        if (introWord && tableIntro.has(introWord)) {
          let aIdx = i + 1;
          if (toks[aIdx]?.kind === 'ident' && toks[aIdx]!.text === 'as') aIdx++;
          const aliasTok = toks[aIdx];
          if (isId(aliasTok) && !(aliasTok!.kind === 'ident' && SQLITE_KEYWORDS.has(aliasTok!.text))) {
            aliases.set(aliasTok!.text.toLowerCase(), tid);
          }
        }
        continue;
      }

      const vid = viewIdByLower.get(low);
      if (vid && vid !== selfId) {
        depSet.add(vid);
      }
    }

    // 第二遍：解析限定列（alias.col / table.col / NEW.col / OLD.col）与非限定列引用
    for (let i = bodyStart; i < toks.length; i++) {
      const cur = toks[i]!;
      if (!isId(cur)) continue;
      const low = cur.text.toLowerCase();
      const next = toks[i + 1];
      const prev = toks[i - 1];

      // <aliasOrTable>.<col>
      if (next?.text === '.' && isId(toks[i + 2])) {
        const tid = aliases.get(low);
        if (tid) {
          const cid = colIdByTableAndLower.get(`${tid}\0${toks[i + 2]!.text.toLowerCase()}`);
          if (cid) depSet.add(cid);
        }
        continue;
      }

      if (prev?.text === '.' || next?.text === '(') continue;
      if (cur.kind === 'ident' && SQLITE_KEYWORDS.has(low)) continue;
      // 跳过已作为表名/别名的标识符，避免与同名列混淆
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
      op.objType === 'trigger' ? (tableIdByLower.get(op.tblName.toLowerCase()) ?? mainId) : mainId;
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
