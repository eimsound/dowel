// MSSQL 快照 → IR（Model）：为所有对象分配 ID，识别推导名与显式名，保留带名 DEFAULT 约束、IDENTITY、CLUSTERED、FILLFACTOR 与注释。
import {
  type Column,
  type ColumnExt,
  emptyModel,
  type FkAction,
  type Index,
  indexElementNames,
  type Model,
  mssqlDerivedNames,
  mssqlExprReferences,
  type MssqlIndexExt,
  newId,
  type SequenceOptions,
} from '@dowel/core';
import { generateKeyBetween } from 'fractional-indexing';

import type { MssqlSeqSnap, MssqlSnapshot } from './snapshot.ts';

const SEQ_TYPE_LIMITS: Record<SequenceOptions['type'], [string, string]> = {
  smallint: ['-32768', '32767'],
  integer: ['-2147483648', '2147483647'],
  bigint: ['-9223372036854775808', '9223372036854775807'],
};

const seqOptionsFromMssqlSnap = (s: MssqlSeqSnap): SequenceOptions => {
  const type = (s.type in SEQ_TYPE_LIMITS ? s.type : 'bigint') as SequenceOptions['type'];
  const [tmin, tmax] = SEQ_TYPE_LIMITS[type];
  const asc = !s.increment.startsWith('-');
  const min = s.min === tmin ? null : s.min;
  const max = s.max === tmax ? null : s.max;
  const dstart = asc ? s.min : s.max;
  return {
    type,
    increment: s.increment,
    min,
    max,
    start: s.start === dstart ? null : s.start,
    cache: s.cache,
    cycle: s.cycle,
  };
};

/** 尝试解析 `NEXT VALUE FOR [schema].[seq]` 序列默认值 */
const parseNextValueFor = (expr: string): [string, string] | null => {
  let inner = expr.trim();
  while (inner.startsWith('(') && inner.endsWith(')')) {
    const candidate = inner.slice(1, -1).trim();
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '(') depth++;
      else if (candidate[i] === ')') {
        depth--;
        if (depth < 0) {
          balanced = false;
          break;
        }
      }
    }
    if (balanced && depth === 0) inner = candidate;
    else break;
  }
  const m =
    /^NEXT\s+VALUE\s+FOR\s+(?:\[((?:[^\]]|\]\])+)\]|([A-Za-z_][A-Za-z0-9_$#]*))\s*\.\s*(?:\[((?:[^\]]|\]\])+)\]|([A-Za-z_][A-Za-z0-9_$#]*))$/i.exec(
      inner,
    );
  if (!m) return null;
  const sch = m[1] !== undefined ? m[1].replaceAll(']]', ']') : m[2]!;
  const name = m[3] !== undefined ? m[3].replaceAll(']]', ']') : m[4]!;
  return [sch, name];
};

export const importMssqlSnapshot = (snap: MssqlSnapshot): Model => {
  const m = emptyModel('mssql');
  const put = <T extends { id: string }>(o: T) => {
    m.objects[o.id] = o as never;
    return o;
  };

  // 1. Schemas
  const schemaId = new Map<string, string>();
  for (const [name, s] of Object.entries(snap.schemas)) {
    schemaId.set(name, put({ id: newId(), kind: 'schema' as const, name, comment: s.comment }).id);
  }

  // 2. Sequences
  const seqId = new Map<string, string>();
  const seqIdByLower = new Map<string, string>();
  for (const [k, s] of Object.entries(snap.sequences)) {
    const sid = put({
      id: newId(),
      kind: 'sequence' as const,
      parent: schemaId.get(s.schema)!,
      name: s.name,
      nameMode: 'explicit' as const,
      ownedBy: null,
      options: seqOptionsFromMssqlSnap(s),
      comment: s.comment,
    }).id;
    seqId.set(k, sid);
    seqIdByLower.set(k.toLowerCase(), sid);
  }

  // 3. Tables & pre-allocate column IDs
  const tableId = new Map<string, string>();
  const columnId = new Map<string, string>();
  for (const [k, t] of Object.entries(snap.tables)) {
    const tid = put({
      id: newId(),
      kind: 'table' as const,
      parent: schemaId.get(t.schema)!,
      name: t.name,
      partitionBy: null,
      partitionOf: null,
      comment: t.comment,
    }).id;
    tableId.set(k, tid);
    for (const colName of Object.keys(t.columns)) {
      columnId.set(`${k}\u0000${colName}`, newId());
    }
  }

  // 4. Columns, constraints, indexes
  for (const [k, t] of Object.entries(snap.tables)) {
    const tid = tableId.get(k)!;
    const col = (name: string) => columnId.get(`${k}\u0000${name}`)!;

    // 检测表上是否存在非 PK 的 CLUSTERED 对象，以对称还原 PK 的 ext.mssql.clustered
    const hasClusteredNonPk =
      Object.values(t.constraints).some((c) => c.type === 'UQ' && c.clustered) ||
      Object.values(t.indexes).some((ix) => ix.clustered);

    let pos: string | null = null;
    for (const [name, c] of Object.entries(t.columns).sort((a, b) => a[1].columnId - b[1].columnId)) {
      pos = generateKeyBetween(pos, null);
      let def: Column['default'] = null;
      if (c.default !== null) {
        const nv = parseNextValueFor(c.default);
        const sid = nv ? seqIdByLower.get(`${nv[0]}.${nv[1]}`.toLowerCase()) : undefined;
        def = sid ? { nextval: sid } : { expr: c.default };
      }

      const mssqlExt: NonNullable<ColumnExt['mssql']> = {};
      if (c.identity) mssqlExt.identity = { seed: c.identity.seed, increment: c.identity.increment };
      if (c.defaultName) {
        mssqlExt.defaultName = c.defaultName;
        mssqlExt.defaultNameMode =
          c.defaultName === mssqlDerivedNames.default(t.name, name) ? 'derived' : 'explicit';
      }
      if (c.sparse) mssqlExt.sparse = true;
      if (c.rowguidcol) mssqlExt.rowguidcol = true;
      // 持久化计算列：系统目录分不出显式 `PERSISTED NOT NULL` 与引擎推断的非空（is_nullable 都是 0，ADR 0019），
      // 一律记为推断（notNull: false + inferredNotNull: true）；显式声明只能从参考模型沿用（alignMssqlImportedLive）
      // 或由影子库探测还原（shadow.ts）
      const persistedComputed = c.generated?.stored === true;
      if (persistedComputed && c.notNull) mssqlExt.inferredNotNull = true;
      const ext: ColumnExt | undefined = Object.keys(mssqlExt).length > 0 ? { mssql: mssqlExt } : undefined;

      put<Column>({
        id: col(name),
        kind: 'column',
        parent: tid,
        name,
        pos,
        type: c.type,
        typeRef: null,
        notNull: persistedComputed ? false : c.notNull,
        notNullName: null,
        notNullNameMode: 'derived',
        default: def,
        identity: null,
        generated: c.generated ? { expr: c.generated.expr, stored: c.generated.stored } : null,
        collation: c.collation,
        comment: c.comment,
        ...(ext ? { ext } : {}),
      });
    }

    for (const [name, con] of Object.entries(t.constraints)) {
      const base = { id: newId(), parent: tid, name, comment: con.comment };
      const cols = con.columns.map(col);
      const mode = (derived: string) => (name === derived ? ('derived' as const) : ('explicit' as const));
      switch (con.type) {
        case 'PK': {
          const defaultPkClustered = !hasClusteredNonPk;
          const pkExt =
            con.clustered !== defaultPkClustered ? { mssql: { clustered: con.clustered } } : undefined;
          put({
            ...base,
            kind: 'primaryKey' as const,
            nameMode: mode(mssqlDerivedNames.primaryKey(t.name)),
            columns: cols,
            ...(pkExt ? { ext: pkExt } : {}),
          });
          break;
        }
        case 'UQ': {
          const uqExt = con.clustered ? { mssql: { clustered: true } } : undefined;
          put({
            ...base,
            kind: 'unique' as const,
            nameMode: mode(mssqlDerivedNames.unique(t.name, con.columns)),
            columns: cols,
            nullsNotDistinct: false,
            ...(uqExt ? { ext: uqExt } : {}),
          });
          break;
        }
        case 'CK': {
          const colNames = Object.keys(t.columns);
          const refs = colNames.filter((cn) => mssqlExprReferences(con.expr!, cn));
          put({
            ...base,
            kind: 'check' as const,
            nameMode: mode(mssqlDerivedNames.check(t.name, refs.length === 1 ? refs[0]! : null)),
            expr: con.expr!,
            noInherit: false,
          });
          break;
        }
        case 'FK': {
          const refKey = con.refTable!;
          put({
            ...base,
            kind: 'foreignKey' as const,
            nameMode: mode(mssqlDerivedNames.foreignKey(t.name, con.columns)),
            columns: cols,
            refTable: tableId.get(refKey)!,
            refColumns: con.refColumns.map((rc) => columnId.get(`${refKey}\u0000${rc}`)!),
            onDelete: con.onDelete as FkAction,
            onUpdate: con.onUpdate as FkAction,
            match: 'simple' as const,
            deferrable: false,
            initiallyDeferred: false,
          });
          break;
        }
      }
    }

    for (const [name, ix] of Object.entries(t.indexes)) {
      const idxMssqlExt: MssqlIndexExt = {};
      if (ix.clustered) idxMssqlExt.clustered = true;
      if (ix.fillFactor !== null) idxMssqlExt.fillFactor = ix.fillFactor;
      const ext = Object.keys(idxMssqlExt).length > 0 ? { mssql: idxMssqlExt } : undefined;

      const idx: Index = {
        id: newId(),
        kind: 'index',
        parent: tid,
        name,
        nameMode: 'explicit',
        comment: ix.comment,
        unique: ix.unique,
        method: 'btree',
        elements: ix.elements.map((e) => ({
          column: col(e.column),
          expr: null,
          desc: e.desc,
          nullsFirst: null,
          opclass: null,
          collation: null,
        })),
        include: ix.include.map(col),
        where: ix.where,
        nullsNotDistinct: false,
        ...(ext ? { ext } : {}),
      };
      put(idx);
      if (name === mssqlDerivedNames.index(t.name, indexElementNames(m, idx))) {
        idx.nameMode = 'derived';
      }
    }
  }

  // 5. Opaque objects
  const opaqueId = new Map<string, string>();
  for (const k of Object.keys(snap.opaques)) opaqueId.set(k, newId());
  const resolveRef = (ref: string): string | undefined => {
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i);
    const rest = ref.slice(i + 1);
    switch (kind) {
      case 'table':
        return tableId.get(rest);
      case 'column':
        return columnId.get(rest);
      case 'sequence':
        return seqId.get(rest);
      case 'opaque':
        return opaqueId.get(rest);
      default:
        return undefined;
    }
  };
  for (const [k, o] of Object.entries(snap.opaques)) {
    const parentId = o.table ? (tableId.get(o.table) ?? schemaId.get(o.schema)!) : schemaId.get(o.schema)!;
    put({
      id: opaqueId.get(k)!,
      kind: 'opaque' as const,
      objType: o.objType,
      parent: parentId,
      name: o.name,
      ddl: o.ddl,
      drop: o.drop,
      deps: o.deps.map(resolveRef).filter((x): x is string => Boolean(x)),
      order: o.order,
      comment: null,
    });
  }

  return m;
};
