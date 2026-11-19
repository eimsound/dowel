// 从 PG 系统目录读出结构快照。快照没有 ID，按名字索引；比较两份快照即可判断结构是否相同。
// 比较规则见 04-ir-design.md 第 3 节：不比较 OID、列的物理顺序、所有者、权限；名字和表达式规范形式严格比较。
//
// schema 范围（P3）：`readSnapshot(db, only)` 只读给定的 schema，在 SQL 层面就过滤掉，
// 不读出来再丢弃；`dowel` 是 Dowel 自己的迁移历史 schema（ADR 0003），永远不读。（引擎层写死）
import { literal } from '@dowel/core';
import { type Db, pinSession } from './db.ts';
import { type OpaqueSnap, readOpaques } from './opaque.ts';
import { checkScope } from './scope.ts';

export interface SeqSnap {
  type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}
export interface ColSnap {
  /** format_type 的输出；是枚举时只保留数组后缀 */
  type: string;
  /** 枚举类型的 `schema.name`（未加引号，与 Snapshot.enums 的键一致） */
  enumType: string | null;
  notNull: boolean;
  notNullName: string | null;
  default: string | null;
  identity: { always: boolean; sequence: string; options: SeqSnap } | null;
  generated: { expr: string; stored: boolean } | null;
  collation: string | null;
  comment: string | null;
  /** 分区子表从父表继承来的列（建子表时自动产生，不单独定义） */
  inherited: boolean;
}
export interface ConSnap {
  type: 'p' | 'u' | 'f' | 'c';
  columns: string[];
  nullsNotDistinct: boolean;
  refTable: string | null;
  refColumns: string[];
  onDelete: string;
  onUpdate: string;
  match: string;
  deferrable: boolean;
  deferred: boolean;
  expr: string | null;
  noInherit: boolean;
  comment: string | null;
}
export interface IdxElemSnap {
  column: string | null;
  expr: string | null;
  desc: boolean;
  nullsFirst: boolean;
  opclass: string | null;
  collation: string | null;
}
export interface IdxSnap {
  unique: boolean;
  method: string;
  elements: IdxElemSnap[];
  include: string[];
  where: string | null;
  nullsNotDistinct: boolean;
  comment: string | null;
}
export interface TableSnap {
  schema: string;
  name: string;
  comment: string | null;
  /** 列按名字索引；attnum 只用于导入时决定展示顺序，不参与比较 */
  columns: Record<string, ColSnap & { attnum: number }>;
  constraints: Record<string, ConSnap>;
  indexes: Record<string, IdxSnap>;
  partitionBy: string | null;
  partitionOf: { parent: string; bound: string } | null;
}
export interface Snapshot {
  version: number;
  schemas: Record<string, { comment: string | null }>;
  extensions: Record<string, { schema: string; comment: string | null }>;
  opaques: Record<string, OpaqueSnap>;
  enums: Record<string, { schema: string; name: string; values: string[]; comment: string | null }>;
  sequences: Record<
    string,
    SeqSnap & {
      schema: string;
      name: string;
      ownedBy: { table: string; column: string } | null;
      comment: string | null;
    }
  >;
  tables: Record<string, TableSnap>;
}

export const USER_NS = `n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`;
/** Dowel 在目标库里的迁移历史 schema（ADR 0003）；它不属于用户的模型，永远不导入 */
export const DOWEL_SCHEMA = 'dowel';

const quoteList = (names: string[]) => names.map((n) => literal(n)).join(', ');

/**
 * “用户 schema”的过滤条件（别名固定为 `n`）：排除系统 schema 和 `dowel`，
 * 给了范围（导入时勾选的 schema）就只留范围内的 —— 条件直接写进各条目录查询，
 * 不在读出来之后丢弃。
 */
export const userNs = (only?: string[] | null): string =>
  only?.length
    ? `${USER_NS} and n.nspname <> ${literal(DOWEL_SCHEMA)} and n.nspname in (${quoteList(only)})`
    : `${USER_NS} and n.nspname <> ${literal(DOWEL_SCHEMA)}`;
/** 排除扩展自带的对象（它们随 CREATE EXTENSION 产生，不属于用户 schema） */
export const NOT_EXT = (catalog: string, oid: string) =>
  `not exists (select 1 from pg_depend xd where xd.classid = '${catalog}'::regclass and xd.objid = ${oid} and xd.deptype = 'e')`;
export const key = (schema: string, name: string) => `${schema}.${name}`;
const ACTIONS: Record<string, string> = {
  a: 'noAction',
  r: 'restrict',
  c: 'cascade',
  n: 'setNull',
  d: 'setDefault',
};

export const readSnapshot = async (db: Db, only?: string[] | null): Promise<Snapshot> => {
  await pinSession(db);
  const ns = userNs(only);
  const [{ v }] = (await db.query<{ v: number }>(
    `select current_setting('server_version_num')::int as v`,
  )) as [{ v: number }];
  const snap: Snapshot = {
    version: v,
    schemas: {},
    extensions: {},
    enums: {},
    sequences: {},
    tables: {},
    opaques: {},
  };

  for (const r of await db.query<{ name: string; comment: string | null }>(
    `select n.nspname as name, obj_description(n.oid, 'pg_namespace') as comment
       from pg_namespace n where ${ns}`,
  ))
    snap.schemas[r.name] = { comment: r.comment };

  for (const r of await db.query<{ name: string; schema: string; comment: string | null }>(
    `select x.extname as name, n.nspname as schema, obj_description(x.oid, 'pg_extension') as comment
       from pg_extension x join pg_namespace n on n.oid = x.extnamespace where ${ns}`,
  ))
    snap.extensions[r.name] = { schema: r.schema, comment: r.comment };

  const enumByOid = new Map<number, string>();
  for (const r of await db.query<{
    oid: number;
    schema: string;
    name: string;
    values: string[];
    comment: string | null;
  }>(
    `select t.oid::int as oid, n.nspname as schema, t.typname as name, obj_description(t.oid, 'pg_type') as comment,
            array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder) as values
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typtype = 'e' and ${ns} and ${NOT_EXT('pg_type', 't.oid')}`,
  )) {
    enumByOid.set(r.oid, key(r.schema, r.name));
    snap.enums[key(r.schema, r.name)] = {
      schema: r.schema,
      name: r.name,
      values: r.values,
      comment: r.comment,
    };
  }

  // 序列：独立序列和 serial 产生的（deptype a）进 sequences；identity 产生的（deptype i）归到列上
  type SeqRow = SeqSnap & {
    oid: number;
    schema: string;
    name: string;
    comment: string | null;
    deptype: string | null;
    ownerTable: string | null;
    ownerSchema: string | null;
    ownerColumn: string | null;
  };
  const seqRows = await db.query<SeqRow>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, obj_description(c.oid, 'pg_class') as comment,
            format_type(s.seqtypid, null) as type, s.seqstart::text as start, s.seqincrement::text as increment,
            s.seqmin::text as min, s.seqmax::text as max, s.seqcache::text as cache, s.seqcycle as cycle,
            d.deptype::text as deptype, tc.relname as "ownerTable", tn.nspname as "ownerSchema", a.attname as "ownerColumn"
       from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_sequence s on s.seqrelid = c.oid
       left join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = c.oid
                             and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
       left join pg_class tc on tc.oid = d.refobjid
       left join pg_namespace tn on tn.oid = tc.relnamespace
       left join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
      where c.relkind = 'S' and ${ns} and ${NOT_EXT('pg_class', 'c.oid')}`,
  );
  const seqByOid = new Map<number, string>();
  const seqOpts = (r: SeqRow): SeqSnap => ({
    type: r.type,
    start: r.start,
    increment: r.increment,
    min: r.min,
    max: r.max,
    cache: r.cache,
    cycle: r.cycle,
  });
  const identitySeq = new Map<string, SeqRow>(); // "schema.table.column" → 序列
  for (const r of seqRows) {
    if (r.deptype === 'i') {
      identitySeq.set(`${r.ownerSchema}.${r.ownerTable}.${r.ownerColumn}`, r);
      continue;
    }
    seqByOid.set(r.oid, key(r.schema, r.name));
    snap.sequences[key(r.schema, r.name)] = {
      schema: r.schema,
      name: r.name,
      ...seqOpts(r),
      ownedBy:
        r.deptype === 'a' ? { table: key(r.ownerSchema!, r.ownerTable!), column: r.ownerColumn! } : null,
      comment: r.comment,
    };
  }

  const tableByOid = new Map<number, TableSnap>();
  const tableRows = await db.query<{
    oid: number;
    schema: string;
    name: string;
    comment: string | null;
    partBy: string | null;
    parent: number | null;
    bound: string | null;
  }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, obj_description(c.oid, 'pg_class') as comment,
            case when c.relkind = 'p' then pg_get_partkeydef(c.oid) end as "partBy",
            case when c.relispartition then (select i.inhparent::int from pg_inherits i where i.inhrelid = c.oid) end as parent,
            case when c.relispartition then pg_get_expr(c.relpartbound, c.oid) end as bound
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and ${ns} and ${NOT_EXT('pg_class', 'c.oid')}`,
  );
  for (const r of tableRows) {
    const t: TableSnap = {
      schema: r.schema,
      name: r.name,
      comment: r.comment,
      columns: {},
      constraints: {},
      indexes: {},
      partitionBy: r.partBy,
      partitionOf: null,
    };
    snap.tables[key(r.schema, r.name)] = t;
    tableByOid.set(r.oid, t);
  }
  for (const r of tableRows) {
    if (r.parent === null) continue;
    const p = tableByOid.get(r.parent)!;
    snap.tables[key(r.schema, r.name)]!.partitionOf = { parent: key(p.schema, p.name), bound: r.bound! };
  }

  // 列
  const colName = new Map<string, string>(); // "oid:attnum" → 列名
  for (const r of await db.query<{
    rel: number;
    attnum: number;
    name: string;
    type: string;
    enumType: string | null;
    notNull: boolean;
    notNullName: string | null;
    default: string | null;
    identity: string;
    generated: string;
    collation: string | null;
    comment: string | null;
    inherited: boolean;
  }>(
    `select a.attrelid::int as rel, not a.attislocal as inherited, a.attnum::int as attnum, a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            (select en.nspname || '.' || e.typname
               from pg_type e join pg_namespace en on en.oid = e.typnamespace
              where e.typtype = 'e' and (e.oid = t.oid or e.oid = t.typelem)) as "enumType",
            a.attnotnull as "notNull",
            (select k.conname from pg_constraint k
              where k.conrelid = a.attrelid and k.contype = 'n' and k.conkey[1] = a.attnum) as "notNullName",
            pg_get_expr(d.adbin, d.adrelid) as default,
            a.attidentity::text as identity, a.attgenerated::text as generated,
            case when a.attcollation <> t.typcollation
                 then (select quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                         from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = a.attcollation)
            end as collation,
            col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_type t on t.oid = a.atttypid
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and ${ns}`,
  )) {
    const t = tableByOid.get(r.rel);
    if (!t) continue;
    colName.set(`${r.rel}:${r.attnum}`, r.name);
    const idSeq = r.identity ? identitySeq.get(`${t.schema}.${t.name}.${r.name}`) : undefined;
    t.columns[r.name] = {
      attnum: r.attnum,
      type: r.enumType ? (/(\[\])+$/.exec(r.type)?.[0] ?? '') : r.type,
      enumType: r.enumType,
      notNull: r.notNull,
      notNullName: r.notNullName,
      default: r.generated ? null : r.default,
      identity: idSeq ? { always: r.identity === 'a', sequence: idSeq.name, options: seqOpts(idSeq) } : null,
      generated: r.generated ? { expr: r.default!, stored: r.generated === 's' } : null,
      collation: r.collation,
      comment: r.comment,
      inherited: r.inherited,
    };
  }
  const names = (rel: number, attnums: number[] | null) =>
    (attnums ?? []).map((n) => colName.get(`${rel}:${n}`)!);

  // 约束（不含 NOT NULL，它已经并入列）
  for (const r of await db.query<{
    rel: number;
    name: string;
    type: 'p' | 'u' | 'f' | 'c';
    keys: number[] | null;
    refRel: number;
    refKeys: number[] | null;
    upd: string;
    del: string;
    match: string;
    deferrable: boolean;
    deferred: boolean;
    expr: string | null;
    noInherit: boolean;
    nnd: boolean | null;
    comment: string | null;
  }>(
    `select k.conrelid::int as rel, k.conname as name, k.contype::text as type, k.conkey::int[] as keys,
            k.confrelid::int as "refRel", k.confkey::int[] as "refKeys", k.confupdtype::text as upd,
            k.confdeltype::text as del, k.confmatchtype::text as match, k.condeferrable as deferrable,
            k.condeferred as deferred, case when k.contype = 'c' then pg_get_expr(k.conbin, k.conrelid) end as expr,
            k.connoinherit as "noInherit",
            case when k.contype = 'u'
                 then (select i.indnullsnotdistinct from pg_index i where i.indexrelid = k.conindid) end as nnd,
            obj_description(k.oid, 'pg_constraint') as comment
       from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where k.contype in ('p', 'u', 'f', 'c') and c.relkind in ('r', 'p') and ${ns}
        and k.conislocal and k.conparentid = 0`,
  )) {
    // 分区子表上从父表继承来的约束（conislocal 为假或 conparentid 非 0）建子表时自动产生，不读
    const t = tableByOid.get(r.rel);
    if (!t) continue;
    const ref = r.type === 'f' ? tableByOid.get(r.refRel)! : null;
    t.constraints[r.name] = {
      type: r.type,
      columns: names(r.rel, r.keys),
      nullsNotDistinct: !!r.nnd,
      refTable: ref ? key(ref.schema, ref.name) : null,
      refColumns: ref ? names(r.refRel, r.refKeys) : [],
      onDelete: r.type === 'f' ? ACTIONS[r.del]! : '',
      onUpdate: r.type === 'f' ? ACTIONS[r.upd]! : '',
      match: r.type === 'f' ? (r.match === 'f' ? 'full' : 'simple') : '',
      deferrable: r.deferrable,
      deferred: r.deferred,
      expr: r.expr,
      noInherit: r.type === 'c' && r.noInherit,
      comment: r.comment,
    };
  }

  // 不属于约束的索引
  for (const r of await db.query<{
    rel: number;
    name: string;
    unique: boolean;
    method: string;
    nkey: number;
    keys: number[];
    opts: number[];
    defs: string[];
    opclasses: (string | null)[];
    colls: number[];
    colColls: number[];
    where: string | null;
    nnd: boolean;
    comment: string | null;
  }>(
    `select i.indrelid::int as rel, ic.relname as name, i.indisunique as unique, am.amname as method,
            i.indnkeyatts::int as nkey, i.indkey::int2[]::int[] as keys, i.indoption::int2[]::int[] as opts,
            array(select pg_get_indexdef(i.indexrelid, k, true) from generate_series(1, i.indnatts) k) as defs,
            array(select case when opc.opcdefault then null
                              else quote_ident(on_.nspname) || '.' || quote_ident(opc.opcname) end
                    from unnest(i.indclass::oid[]) with ordinality u(oid, ord)
                    join pg_opclass opc on opc.oid = u.oid join pg_namespace on_ on on_.oid = opc.opcnamespace
                   order by u.ord) as opclasses,
            i.indcollation::oid[]::int[] as colls,
            array(select coalesce((select a.attcollation from pg_attribute a
                                    where a.attrelid = i.indrelid and a.attnum = u.k), 0)::int
                    from unnest(i.indkey::int2[]) with ordinality u(k, ord) order by u.ord) as "colColls",
            pg_get_expr(i.indpred, i.indrelid) as where, i.indnullsnotdistinct as nnd,
            obj_description(i.indexrelid, 'pg_class') as comment
       from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_class c on c.oid = i.indrelid
       join pg_namespace n on n.oid = c.relnamespace join pg_am am on am.oid = ic.relam
      where c.relkind in ('r', 'p') and ${ns} and not ic.relispartition
        and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid and k.contype in ('p', 'u', 'x'))`,
  )) {
    const t = tableByOid.get(r.rel);
    if (!t) continue;
    const collName = async (oid: number) =>
      (
        await db.query<{ n: string }>(
          `select quote_ident(n.nspname) || '.' || quote_ident(c.collname) as n
             from pg_collation c join pg_namespace n on n.oid = c.collnamespace where c.oid = $1`,
          [oid],
        )
      )[0]?.n ?? null;
    const elements: IdxElemSnap[] = [];
    for (let k = 0; k < r.nkey; k++) {
      const attnum = r.keys[k]!;
      const opt = r.opts[k]!;
      const coll = r.colls[k]!;
      const defaultColl = attnum ? r.colColls[k]! : 100; // 100 = default 排序规则
      elements.push({
        column: attnum ? colName.get(`${r.rel}:${attnum}`)! : null,
        expr: attnum ? null : r.defs[k]!,
        desc: (opt & 1) !== 0,
        nullsFirst: (opt & 2) !== 0,
        opclass: r.opclasses[k] ?? null,
        collation: coll && coll !== defaultColl ? await collName(coll) : null,
      });
    }
    t.indexes[r.name] = {
      unique: r.unique,
      method: r.method,
      elements,
      include: r.keys.slice(r.nkey).map((a) => colName.get(`${r.rel}:${a}`)!),
      where: r.where,
      nullsNotDistinct: r.nnd,
      comment: r.comment,
    };
  }

  snap.opaques = await readOpaques(db, { tableByOid, colName, enumByOid, seqByOid }, only);
  // 范围里的对象不能引用范围外的对象（否则会导入出一个残缺模型），有跨范围引用就报错
  if (only?.length) await checkScope(db, only);
  return snap;
};

/** 把快照转成规范的、可比较的形式：去掉 attnum，按键排序 */
export const normalize = (s: Snapshot): unknown => {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object')
      return Object.fromEntries(
        Object.keys(x)
          .filter((k) => k !== 'attnum' && k !== 'version' && k !== 'order')
          .sort()
          .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
      );
    return x;
  };
  return sort(s);
};

/** 比较两份快照，返回差异描述（空数组表示相同） */
export const diffSnapshots = (a: Snapshot, b: Snapshot): string[] => {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys)
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    out.push(`${path}: ${JSON.stringify(x)} ≠ ${JSON.stringify(y)}`);
  };
  walk(normalize(a), normalize(b), '');
  return out;
};
