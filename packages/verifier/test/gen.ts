// 随机编辑生成器：把一串随机整数解释成一串编辑操作。
// 不合法的操作（EditError）直接跳过；生成器负责让结果在 SQL 语义上也合法（类型、表达式都对得上）。
import * as E from '@dowel/core';
import {
  all,
  type Column,
  childrenOf,
  columnsOf,
  emptyModel,
  ident,
  LATEST_PG_MAJOR,
  literal,
  type Model,
  parsePartitionBound,
  partitionDescendants,
  partitionKeyColumns,
  partitionsOf,
  qname,
  resolvePartitionBy,
} from '@dowel/core';
import fc from 'fast-check';

export interface GenOptions {
  pgMajor?: number;
}

export type Action = { op: number; a: number; b: number; c: number; d: number };
export const action = fc.record({ op: fc.nat(), a: fc.nat(), b: fc.nat(), c: fc.nat(), d: fc.nat() });

const NAMES = ['a', 'b', 'c', 'id', 'user', 'order', 'Mixed Case', 'x'.repeat(60), 'y'.repeat(60), '名字'];

interface TypeInfo {
  t: string;
  group: string;
  defaults: string[];
  check: (col: string) => string;
}
const TYPES: TypeInfo[] = [
  { t: 'integer', group: 'num', defaults: ['0', '42'], check: (c) => `(${c} > 0)` },
  { t: 'bigint', group: 'num', defaults: ['0'], check: (c) => `(${c} >= 0)` },
  { t: 'numeric(10,2)', group: 'num', defaults: ['1.5'], check: (c) => `(${c} < 1000)` },
  { t: 'text', group: 'text', defaults: ["'x'::text", "'it''s'::text"], check: (c) => `(length(${c}) < 50)` },
  {
    t: 'character varying(20)',
    group: 'text',
    defaults: ["'v'::character varying"],
    check: (c) => `(${c} <> '')`,
  },
  { t: 'boolean', group: 'bool', defaults: ['true'], check: (c) => `(${c} IS NOT NULL)` },
  {
    t: 'timestamp with time zone',
    group: 'ts',
    defaults: ['now()'],
    check: (c) => `(${c} > '2000-01-01 00:00:00+00')`,
  },
  { t: 'uuid', group: 'uuid', defaults: ['gen_random_uuid()'], check: (c) => `(${c} IS NOT NULL)` },
  { t: 'jsonb', group: 'json', defaults: ["'{}'::jsonb"], check: (c) => `(${c} ? 'k')` },
  { t: 'text[]', group: 'arr', defaults: ["'{}'::text[]"], check: (c) => `(cardinality(${c}) < 10)` },
];
const typeInfo = (c: Column) => TYPES.find((x) => x.t === c.type && !c.typeRef);

const pick = <T>(xs: T[], k: number): T | undefined => (xs.length ? xs[k % xs.length] : undefined);

/**
 * 各操作的权重。build 用于生成版本 1（偏重建表、加列、加约束），mutate 用于生成版本 2（偏重改名、改类型、删除）。
 * 下标与 interpret 里 switch 的分支编号一致。
 */
// prettier-ignore
const WEIGHTS = {
  //       0  1  2  3  4  5   6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35
  build: [1, 0, 5, 0, 0, 12, 0, 0, 0, 2, 3, 2, 2, 3, 3, 3, 4, 4, 0, 1, 0, 2, 0, 1, 0, 3, 2, 0, 0, 2, 1, 2, 4, 0, 0, 0],
  mutate: [1, 2, 1, 3, 2, 4, 4, 3, 6, 3, 3, 2, 1, 2, 2, 2, 2, 2, 3, 2, 1, 1, 2, 2, 1, 1, 1, 2, 1, 2, 1, 1, 3, 2, 2, 2],
};
const opOf = (phase: keyof typeof WEIGHTS, op: number): number => {
  const w = WEIGHTS[phase];
  let r = op % w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) {
    r -= w[i]!;
    if (r < 0) return i;
  }
  return 0;
};

/** 列是否被表达式、外键、生成列、identity、分区键牵连（这些列不随机改类型） */
const entangled = (m: Model, c: Column): boolean => {
  if (c.identity || c.generated) return true;
  const parentTable = m.objects[c.parent];
  if (parentTable?.kind === 'table') {
    for (const tb of [parentTable, ...partitionDescendants(m, parentTable.id)]) {
      if (tb.partitionBy && partitionKeyColumns(m, tb).all.includes(c.id)) return true;
    }
  }
  for (const o of Object.values(m.objects)) {
    if (o.kind === 'foreignKey' && (o.columns.includes(c.id) || o.refColumns.includes(c.id))) return true;
    if (!('parent' in o) || o.parent !== c.parent) continue;
    if (o.kind === 'check' && E.exprReferences(o.expr, c.name)) return true;
    if (
      o.kind === 'index' &&
      (o.elements.some((e) => e.expr && E.exprReferences(e.expr, c.name)) ||
        (o.where && E.exprReferences(o.where, c.name)))
    )
      return true;
    if (o.kind === 'column' && o.generated && E.exprReferences(o.generated.expr, c.name)) return true;
  }
  return false;
};

const plainCols = (m: Model, table: string) => columnsOf(m, table).filter((c) => !c.generated);

/** 为分区父表选择一个不与现有子分区冲突的新边界 */
const nextPartitionBound = (m: Model, parent: E.Table, seed: number): string | null => {
  const spec = resolvePartitionBy(m, parent);
  if (!spec || spec.keys.length !== 1 || !spec.keys[0]?.column) return null;
  const children = partitionsOf(m, parent.id);
  const existingBounds = children.map((ch) => parsePartitionBound(ch.partitionOf!.bound));
  const hasDefault = existingBounds.some((b) => b?.kind === 'default');
  if (spec.strategy !== 'hash' && !hasDefault && seed % 5 === 0) return 'DEFAULT';
  if (spec.strategy === 'range') {
    const usedStarts = new Set(
      existingBounds.filter((b) => b?.kind === 'range').map((b) => Number(b.from[0])),
    );
    for (let i = 0; i < 20; i++) {
      const start = ((seed + i) % 20) * 100;
      if (!usedStarts.has(start)) return `FOR VALUES FROM (${start}) TO (${start + 100})`;
    }
    return null;
  }
  if (spec.strategy === 'list') {
    const usedVals = new Set(existingBounds.filter((b) => b?.kind === 'list').flatMap((b) => b.values));
    for (let i = 0; i < 20; i++) {
      const val = `'v_${(seed + i) % 20}'`;
      if (!usedVals.has(val)) return `FOR VALUES IN (${val})`;
    }
    return null;
  }
  // hash: 固定 modulus 4
  const usedRem = new Set(existingBounds.filter((b) => b?.kind === 'hash').map((b) => b.remainder));
  for (let i = 0; i < 4; i++) {
    const rem = (seed + i) % 4;
    if (!usedRem.has(rem)) return `FOR VALUES WITH (modulus 4, remainder ${rem})`;
  }
  return null;
};

export const interpret = (
  m: Model,
  actions: Action[],
  phase: keyof typeof WEIGHTS = 'mutate',
  opts: GenOptions = {},
): Model => {
  const pgMajor = opts.pgMajor ?? LATEST_PG_MAJOR;
  for (const { op: raw, a, b, c, d } of actions) {
    const op = opOf(phase, raw);
    const schemas = all(m, 'schema');
    const tables = all(m, 'table');
    const rootTables = tables.filter((x) => !x.partitionOf);
    const partParents = tables.filter((x) => x.partitionBy !== null && !x.partitionOf);
    const partChildren = tables.filter((x) => x.partitionOf !== null && x.partitionBy === null);
    const columns = all(m, 'column');
    const enums = all(m, 'enum');
    const seqs = all(m, 'sequence');
    const keys = Object.values(m.objects).filter((o) =>
      ['primaryKey', 'unique', 'foreignKey', 'check', 'index'].includes(o.kind),
    );
    const name = NAMES[b % NAMES.length]!;
    const t = pick(rootTables, a);
    const col = pick(columns, a);
    try {
      switch (op) {
        case 0:
          E.createSchema(m, name);
          break;
        case 1:
          if (schemas.length) E.renameSchema(m, pick(schemas, a)!.id, name);
          break;
        case 2: {
          const s = pick(schemas, a) ?? { id: E.createSchema(m, 'public') };
          const tid = E.createTable(m, s.id, name);
          const id = E.addColumn(m, tid, { name: 'id', type: c % 2 ? 'integer' : 'bigint', notNull: true });
          if (d % 3) E.addPrimaryKey(m, tid, [id]);
          break;
        }
        case 3:
          if (t) E.renameTable(m, t.id, name);
          break;
        case 4:
          if (t && d % 3 === 0) E.dropTable(m, t.id);
          break;
        case 5:
          if (t) {
            const ti = TYPES[c % TYPES.length]!;
            E.addColumn(m, t.id, {
              name,
              type: ti.t,
              notNull: d % 3 === 0,
              default: d % 2 ? { expr: pick(ti.defaults, d)! } : null,
            });
          }
          break;
        case 6:
          if (col) E.renameColumn(m, col.id, name);
          break;
        case 7:
          if (col && d % 2 === 0) E.dropColumn(m, col.id);
          break;
        case 8: {
          if (!col || entangled(m, col)) break;
          const from = typeInfo(col);
          const to = TYPES[c % TYPES.length]!;
          const ok = col.typeRef
            ? to.t === 'text'
            : from && (from.group === to.group || from.group === 'text' || to.group === 'text');
          if (!ok) break;
          E.setDefault(m, col.id, null);
          E.setColumnType(m, col.id, to.t, null);
          break;
        }
        case 9:
          if (col) E.setNotNull(m, col.id, !col.notNull);
          break;
        case 10: {
          if (!col || col.identity || col.generated) break;
          const ti = typeInfo(col);
          if (d % 3 === 0 || !ti) E.setDefault(m, col.id, null);
          else E.setDefault(m, col.id, { expr: pick(ti.defaults, c)! });
          break;
        }
        case 11: {
          if (!col || (col.type !== 'integer' && col.type !== 'bigint') || col.generated || col.typeRef)
            break;
          const pt = m.objects[col.parent];
          if (pgMajor < 17 && pt?.kind === 'table' && pt.partitionBy !== null) break;
          E.setIdentity(
            m,
            col.id,
            col.identity ? (d % 2 ? null : { always: !col.identity.always }) : { always: d % 2 === 0 },
          );
          break;
        }
        case 12: {
          if (!t) break;
          const src = pick(
            plainCols(m, t.id).filter((x) => typeInfo(x)?.group === 'num'),
            c,
          );
          if (src)
            E.addColumn(m, t.id, {
              name,
              type: src.type,
              generated: { expr: `(${ident(src.name)} * 2)`, stored: pgMajor < 18 ? true : d % 2 === 0 },
            });
          break;
        }
        case 13:
        case 14: {
          if (!t) break;
          const cs = plainCols(m, t.id);
          const k = [pick(cs, c), ...(d % 3 === 0 ? [pick(cs, c + 1)] : [])].filter((x): x is Column => !!x);
          const ids = [...new Set(k.map((x) => x.id))];
          if (!ids.length) break;
          if (op === 13) E.addPrimaryKey(m, t.id, ids);
          else E.addUnique(m, t.id, ids, d % 2 === 0);
          break;
        }
        case 15: {
          if (!t) break;
          const x = pick(
            plainCols(m, t.id).filter((x) => typeInfo(x)),
            c,
          );
          if (x) E.addCheck(m, t.id, typeInfo(x)!.check(ident(x.name)));
          break;
        }
        case 16: {
          // 外键：引用目标表上已有的主键或唯一约束，本表挑类型完全相同的列
          if (!t) break;
          const ref = pick(
            Object.values(m.objects).filter((o) => o.kind === 'primaryKey' || o.kind === 'unique'),
            c,
          ) as E.PrimaryKey | E.Unique | undefined;
          if (!ref) break;
          const refCols = ref.columns.map((id) => m.objects[id] as Column);
          const used = new Set<string>();
          const local: string[] = [];
          for (const rc of refCols) {
            const cand = plainCols(m, t.id).filter(
              (x) => x.type === rc.type && x.typeRef === rc.typeRef && !used.has(x.id),
            );
            const x = pick(cand, d);
            if (!x) break;
            used.add(x.id);
            local.push(x.id);
          }
          if (local.length !== refCols.length) break;
          const actions = ['noAction', 'restrict', 'cascade', 'setNull', 'setDefault'] as const;
          E.addForeignKey(m, t.id, local, ref.parent, ref.columns, {
            onDelete: actions[d % 5]!,
            onUpdate: actions[(d >> 3) % 5]!,
            deferrable: d % 7 === 0,
            initiallyDeferred: d % 14 === 0,
            match: d % 11 === 0 ? 'full' : 'simple',
          });
          break;
        }
        case 17: {
          if (!t) break;
          const cs = plainCols(m, t.id);
          const x = pick(cs, c);
          if (!x) break;
          const els: Partial<E.IndexElement>[] =
            typeInfo(x)?.group === 'text' && d % 2
              ? [{ expr: `lower(${ident(x.name)})` }]
              : [{ column: x.id, desc: d % 3 === 0 }];
          const y = pick(cs, c + 1);
          if (d % 5 === 0 && y && y.id !== x.id) els.push({ column: y.id, nullsFirst: true });
          E.addIndex(m, t.id, els, {
            unique: d % 4 === 0,
            where: d % 6 === 0 ? `(${ident(x.name)} IS NOT NULL)` : null,
            include: d % 7 === 0 && y && y.id !== x.id && !els.some((e) => e.column === y.id) ? [y.id] : [],
          });
          break;
        }
        case 18:
          if (keys.length) E.dropKey(m, pick(keys, a)!.id);
          break;
        case 19:
          if (keys.length) E.renameKey(m, pick(keys, a)!.id, `k_${name}`.slice(0, 63));
          break;
        case 20:
          if (keys.length) E.resetKeyName(m, pick(keys, a)!.id);
          break;
        case 21:
          if (schemas.length) E.createEnum(m, pick(schemas, a)!.id, name, ['x', 'y']);
          break;
        case 22:
          if (enums.length) E.renameEnum(m, pick(enums, a)!.id, name);
          break;
        case 23:
          if (enums.length) {
            const e = pick(enums, a)!;
            E.addEnumValue(m, e.id, ['z', 'w', "it's", 'v'][c % 4]!, d % (e.values.length + 1));
          }
          break;
        case 24:
          if (enums.length) E.dropEnum(m, pick(enums, a)!.id);
          break;
        case 25:
          if (t && enums.length) {
            const e = pick(enums, c)!;
            const array = d % 4 === 0;
            const lit = `${literal(e.values[0]!)}::${qname(m, e)}`;
            E.addColumn(m, t.id, {
              name,
              type: array ? '[]' : '',
              typeRef: e.id,
              default: !array && d % 2 ? { expr: lit } : null,
            });
          }
          break;
        case 26: {
          if (!schemas.length) break;
          const sid = E.createSequence(m, pick(schemas, a)!.id, `seq_${name}`.slice(0, 63), {
            increment: d % 2 ? '1' : '5',
            start: d % 3 ? null : '100',
            cycle: d % 5 === 0,
          });
          const target = pick(
            columns.filter(
              (x) =>
                (x.type === 'integer' || x.type === 'bigint') && !x.identity && !x.generated && !x.typeRef,
            ),
            c,
          );
          if (target) E.setDefault(m, target.id, { nextval: sid });
          break;
        }
        case 27:
          if (seqs.length) E.renameSequence(m, pick(seqs, a)!.id, `s_${name}`.slice(0, 63));
          break;
        case 28:
          if (seqs.length) E.dropSequence(m, pick(seqs, a)!.id);
          break;
        case 29: {
          const target = pick(Object.values(m.objects), a);
          if (target) E.setComment(m, target.id, d % 3 === 0 ? null : `注释 ${c % 5} it's`);
          break;
        }
        case 30:
          if (col) E.moveColumn(m, col.id, pick(childrenOf(m, col.parent, 'column'), c)?.id ?? null);
          break;
        case 31: {
          // 新建分区父表（RANGE / LIST / HASH）
          const s = pick(schemas, a) ?? { id: E.createSchema(m, 'public') };
          const strategy = (['range', 'list', 'hash'] as const)[c % 3]!;
          const tid = E.createTable(m, s.id, `pt_${name}`.slice(0, 63));
          const keyType = strategy === 'list' ? 'text' : 'integer';
          const keyCol = E.addColumn(m, tid, { name: 'pk_key', type: keyType, notNull: true });
          E.addColumn(m, tid, { name: 'val', type: 'integer', default: { expr: '0' } });
          E.setPartitionBy(m, tid, {
            strategy,
            keys: [{ column: keyCol, expr: null, opclass: null, collation: null }],
          });
          if (d % 2 === 0) E.addPrimaryKey(m, tid, [keyCol]);
          break;
        }
        case 32: {
          // 新增子分区（不重叠 RANGE / LIST / HASH / DEFAULT）
          const parent = pick(partParents, a);
          if (!parent) break;
          const bound = nextPartitionBound(m, parent, c);
          if (!bound) break;
          E.createPartition(m, parent.id, `${parent.name}_p_${d % 97}`.slice(0, 63), bound);
          break;
        }
        case 33: {
          // 修改子分区边界或重命名/删除子分区
          const child = pick(partChildren, a);
          if (!child) break;
          if (d % 4 === 0) {
            E.dropTable(m, child.id);
          } else if (d % 4 === 1) {
            E.renameTable(m, child.id, `ch_${name}_${c % 31}`.slice(0, 63));
          } else {
            const parent = m.objects[child.partitionOf!.parent] as E.Table | undefined;
            if (!parent) break;
            const bound = nextPartitionBound(m, parent, c);
            if (bound) E.setPartitionBound(m, child.id, bound);
          }
          break;
        }
        case 34: {
          // 子分区脱离为普通表（Detach）
          const child = pick(partChildren, a);
          if (child) E.detachPartition(m, child.id);
          break;
        }
        case 35: {
          // 寻找结构兼容的普通表挂载为子分区（Attach）
          const parent = pick(partParents, a);
          if (!parent) break;
          const bound = nextPartitionBound(m, parent, c);
          if (!bound) break;
          const plain = pick(
            rootTables.filter((x) => x.id !== parent.id && x.partitionBy === null && x.partitionOf === null),
            b,
          );
          if (plain) E.attachPartition(m, parent.id, plain.id, bound);
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof E.EditError)) throw e;
    }
  }
  return m;
};

/** 版本 1 的起点：已有 public schema */
export const fresh = () => {
  const m = emptyModel();
  E.createSchema(m, 'public');
  return m;
};

export const versions = fc.tuple(
  fc.array(action, { minLength: 10, maxLength: 70, size: 'max' }),
  fc.array(action, { minLength: 1, maxLength: 30, size: 'max' }),
);
export const makeVersions = ([a1, a2]: [Action[], Action[]], opts: GenOptions = {}) => {
  const v1 = interpret(fresh(), a1, 'build', opts);
  const v2 = interpret(structuredClone(v1), a2, 'mutate', opts);
  return { v1, v2 };
};
