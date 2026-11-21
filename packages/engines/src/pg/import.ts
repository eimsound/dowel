// 快照 → IR：为每个对象分配新 ID，判断名字是推导名还是显式名，规整序列选项。
import {
  type Column,
  derivedNames,
  emptyModel,
  type FkAction,
  type Index,
  indexElementNames,
  type Model,
  newId,
  type SequenceOptions,
} from '@dowel/core';
import { generateKeyBetween } from 'fractional-indexing';

import type { SeqSnap, Snapshot } from './snapshot.ts';

const TYPE_LIMITS: Record<string, [string, string]> = {
  smallint: ['-32768', '32767'],
  integer: ['-2147483648', '2147483647'],
  bigint: ['-9223372036854775808', '9223372036854775807'],
};

/** 等于类型默认值的序列选项记为 null，这样 IR 里只出现用户真正指定过的值 */
export const seqOptionsFromSnap = (s: SeqSnap): SequenceOptions => {
  const type = (s.type in TYPE_LIMITS ? s.type : 'bigint') as SequenceOptions['type'];
  const [tmin, tmax] = TYPE_LIMITS[type]!;
  const asc = !s.increment.startsWith('-');
  const dmin = asc ? '1' : tmin;
  const dmax = asc ? tmax : '-1';
  const min = s.min === dmin ? null : s.min;
  const max = s.max === dmax ? null : s.max;
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

/** 解析 `schema.name` 形式的（可能带引号的）限定名 */
export const parseQualified = (s: string): [string, string] | null => {
  const parts: string[] = [];
  const re = /"((?:[^"]|"")*)"|([^."]+)/g;
  for (const m of s.matchAll(re)) parts.push(m[1] !== undefined ? m[1].replaceAll('""', '"') : m[2]!);
  return parts.length === 2 ? [parts[0]!, parts[1]!] : null;
};

export const importSnapshot = (snap: Snapshot): Model => {
  const m = emptyModel();
  const put = <T extends { id: string }>(o: T) => {
    m.objects[o.id] = o as never;
    return o;
  };
  const schemaId = new Map<string, string>();
  for (const [name, s] of Object.entries(snap.schemas))
    schemaId.set(name, put({ id: newId(), kind: 'schema' as const, name, comment: s.comment }).id);

  for (const [name, x] of Object.entries(snap.extensions))
    put({
      id: newId(),
      kind: 'extension' as const,
      name,
      parent: schemaId.get(x.schema)!,
      comment: x.comment,
    });

  const enumId = new Map<string, string>();
  for (const [k, e] of Object.entries(snap.enums))
    enumId.set(
      k,
      put({
        id: newId(),
        kind: 'enum' as const,
        parent: schemaId.get(e.schema)!,
        name: e.name,
        values: e.values,
        comment: e.comment,
      }).id,
    );

  const tableId = new Map<string, string>();
  const columnId = new Map<string, string>(); // "schema.table" + "\0" + 列名
  const rootKeyOf = (tableKey: string): string => {
    const seen = new Set<string>();
    let cur = tableKey;
    while (!seen.has(cur)) {
      seen.add(cur);
      const t = snap.tables[cur];
      if (!t?.partitionOf || !(t.partitionOf.parent in snap.tables)) return cur;
      cur = t.partitionOf.parent;
    }
    return cur;
  };
  for (const [k, t] of Object.entries(snap.tables)) {
    const tid = put({
      id: newId(),
      kind: 'table' as const,
      parent: schemaId.get(t.schema)!,
      name: t.name,
      partitionBy: null as
        | string
        | {
            strategy: 'range' | 'list' | 'hash';
            keys: {
              column: string | null;
              expr: string | null;
              opclass: string | null;
              collation: string | null;
            }[];
          }
        | null,
      partitionOf: null as { parent: string; bound: string } | null,
      comment: t.comment,
    }).id;
    tableId.set(k, tid);
    if (!t.partitionOf) {
      for (const name of Object.keys(t.columns)) columnId.set(`${k}\u0000${name}`, newId());
    }
  }
  // 分区子表不重复生成列对象：列引用沿 partitionOf 链统一映射到根父表的列 ID
  for (const [k, t] of Object.entries(snap.tables)) {
    if (!t.partitionOf) continue;
    const rk = rootKeyOf(k);
    for (const name of Object.keys(t.columns)) {
      const rootCid = columnId.get(`${rk}\u0000${name}`);
      if (rootCid) columnId.set(`${k}\u0000${name}`, rootCid);
    }
  }
  // 设置分区父表的结构化 partitionBy（优先使用 partitionSpec）以及子分区的 partitionOf
  for (const [k, t] of Object.entries(snap.tables)) {
    const o = m.objects[tableId.get(k)!];
    if (o?.kind !== 'table') continue;
    if (t.partitionOf) {
      o.partitionOf = { parent: tableId.get(t.partitionOf.parent)!, bound: t.partitionOf.bound };
    }
    if (t.partitionSpec) {
      const rk = rootKeyOf(k);
      o.partitionBy = {
        strategy: t.partitionSpec.strategy,
        keys: t.partitionSpec.keys.map((pk) => ({
          column: pk.column ? columnId.get(`${rk}\u0000${pk.column}`)! : null,
          expr: pk.expr,
          opclass: pk.opclass,
          collation: pk.collation,
        })),
      };
    } else if (t.partitionBy) {
      o.partitionBy = t.partitionBy;
    }
  }

  const seqId = new Map<string, string>();
  for (const [k, s] of Object.entries(snap.sequences)) {
    const owner = s.ownedBy ? columnId.get(`${s.ownedBy.table}\u0000${s.ownedBy.column}`)! : null;
    const derived =
      s.ownedBy && s.name === derivedNames.sequence(snap.tables[s.ownedBy.table]!.name, s.ownedBy.column);
    seqId.set(
      k,
      put({
        id: newId(),
        kind: 'sequence' as const,
        parent: schemaId.get(s.schema)!,
        name: s.name,
        nameMode: derived ? ('derived' as const) : ('explicit' as const),
        ownedBy: owner,
        options: seqOptionsFromSnap(s),
        comment: s.comment,
      }).id,
    );
  }

  for (const [k, t] of Object.entries(snap.tables)) {
    const tid = tableId.get(k)!;
    let pos: string | null = null;
    const col = (name: string) => columnId.get(`${k}\u0000${name}`)!;
    if (!t.partitionOf) {
      for (const [name, c] of Object.entries(t.columns).sort((a, b) => a[1].attnum - b[1].attnum)) {
        pos = generateKeyBetween(pos, null);
        let def: Column['default'] = null;
        if (c.default) {
          const nv = /^nextval\('((?:[^']|'')+)'::regclass\)$/.exec(c.default);
          const q = nv ? parseQualified(nv[1]!.replaceAll("''", "'")) : null;
          const sid = q ? seqId.get(`${q[0]}.${q[1]}`) : undefined;
          def = sid ? { nextval: sid } : { expr: c.default };
        }
        put<Column>({
          id: col(name),
          kind: 'column',
          parent: tid,
          name,
          pos,
          type: c.type,
          typeRef: c.enumType ? enumId.get(c.enumType)! : null,
          notNull: c.notNull,
          notNullName: c.notNullName,
          notNullNameMode: c.notNullName === derivedNames.notNull(t.name, name) ? 'derived' : 'explicit',
          default: def,
          identity: c.identity
            ? {
                always: c.identity.always,
                sequenceName: c.identity.sequence,
                sequenceNameMode:
                  c.identity.sequence === derivedNames.sequence(t.name, name) ? 'derived' : 'explicit',
                options: seqOptionsFromSnap(c.identity.options),
              }
            : null,
          generated: c.generated,
          collation: c.collation,
          comment: c.comment,
        });
      }
    }
    for (const [name, k2] of Object.entries(t.constraints)) {
      const base = { id: newId(), parent: tid, name, comment: k2.comment };
      const cols = k2.columns.map(col);
      const mode = (derived: string) => (name === derived ? ('derived' as const) : ('explicit' as const));
      switch (k2.type) {
        case 'p':
          put({
            ...base,
            kind: 'primaryKey' as const,
            nameMode: mode(derivedNames.primaryKey(t.name)),
            columns: cols,
          });
          break;
        case 'u':
          put({
            ...base,
            kind: 'unique' as const,
            nameMode: mode(derivedNames.unique(t.name, k2.columns)),
            columns: cols,
            nullsNotDistinct: k2.nullsNotDistinct,
          });
          break;
        case 'c':
          put({
            ...base,
            kind: 'check' as const,
            nameMode: mode(derivedNames.check(t.name, k2.columns.length === 1 ? k2.columns[0]! : null)),
            expr: k2.expr!,
            noInherit: k2.noInherit,
          });
          break;
        case 'f': {
          const refKey = k2.refTable!;
          put({
            ...base,
            kind: 'foreignKey' as const,
            nameMode: mode(derivedNames.foreignKey(t.name, k2.columns)),
            columns: cols,
            refTable: tableId.get(refKey)!,
            refColumns: k2.refColumns.map((n) => columnId.get(`${refKey}\u0000${n}`)!),
            onDelete: k2.onDelete as FkAction,
            onUpdate: k2.onUpdate as FkAction,
            match: k2.match as 'simple' | 'full',
            deferrable: k2.deferrable,
            initiallyDeferred: k2.deferred,
          });
          break;
        }
      }
    }
    for (const [name, x] of Object.entries(t.indexes)) {
      const idx: Index = {
        id: newId(),
        kind: 'index',
        parent: tid,
        name,
        nameMode: 'explicit',
        comment: x.comment,
        unique: x.unique,
        method: x.method,
        elements: x.elements.map((e) => ({
          column: e.column ? col(e.column) : null,
          expr: e.expr,
          desc: e.desc,
          nullsFirst: e.nullsFirst === e.desc ? null : e.nullsFirst,
          opclass: e.opclass,
          collation: e.collation,
        })),
        include: x.include.map(col),
        where: x.where,
        nullsNotDistinct: x.nullsNotDistinct,
      };
      put(idx);
      if (name === derivedNames.index(t.name, indexElementNames(m, idx))) idx.nameMode = 'derived';
    }
  }
  // 不透明对象：先分配 ID，再把依赖换算成 ID
  const opaqueId = new Map<string, string>();
  for (const k of Object.keys(snap.opaques)) opaqueId.set(k, newId());
  const resolve = (ref: string): string | undefined => {
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i);
    const rest = ref.slice(i + 1);
    switch (kind) {
      case 'table':
        return tableId.get(rest);
      case 'column':
        return columnId.get(rest);
      case 'enum':
        return enumId.get(rest);
      case 'sequence':
        return seqId.get(rest);
      case 'opaque':
        return opaqueId.get(rest);
    }
    return undefined;
  };
  for (const [k, o] of Object.entries(snap.opaques)) {
    put({
      id: opaqueId.get(k)!,
      kind: 'opaque' as const,
      objType: o.objType,
      parent: o.table ? tableId.get(o.table)! : schemaId.get(o.schema)!,
      name: o.name,
      ddl: o.ddl,
      drop: o.drop,
      deps: o.deps.map(resolve).filter((x): x is string => !!x),
      order: o.order,
      comment: null,
    });
  }
  return m;
};
