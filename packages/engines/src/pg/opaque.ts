// 读取不透明对象（域、复合类型、函数、聚合、视图、物化视图、触发器、策略、排他约束）。
// DDL 一律取引擎输出的规范形式；依赖从 pg_depend 读出，换算成快照里的名字，导入时再换成 IR 的 ID。
import type { Db } from './db.ts';
import { key, NOT_EXT, type TableSnap, USER_NS, userNs } from './snapshot.ts';

export interface OpaqueSnap {
  objType:
    | 'domain'
    | 'type'
    | 'function'
    | 'procedure'
    | 'aggregate'
    | 'view'
    | 'materializedView'
    | 'trigger'
    | 'policy'
    | 'exclusion';
  schema: string;
  /** 触发器、策略、排他约束所在的表（快照键） */
  table: string | null;
  name: string;
  ddl: string[];
  drop: string;
  /** 依赖，形如 `table:s.t`、`column:s.t\0c`、`enum:s.e`、`sequence:s.q`、`opaque:<键>` */
  deps: string[];
  /** OID，只用于排序，不参与比较 */
  order: number;
}

interface Maps {
  tableByOid: Map<number, TableSnap>;
  colName: Map<string, string>;
  enumByOid: Map<number, string>;
  seqByOid: Map<number, string>;
}

const qi = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replaceAll('"', '""')}"`);
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const stripSemi = (s: string) => s.trim().replace(/;\s*$/, '');

export const opaqueKey = (o: Pick<OpaqueSnap, 'objType' | 'schema' | 'table' | 'name'>) =>
  `${o.objType}:${o.table ?? o.schema}.${o.name}`;

export const readOpaques = async (
  db: Db,
  maps: Maps,
  only?: string[] | null,
): Promise<Record<string, OpaqueSnap>> => {
  const ns = userNs(only);
  const out: Record<string, OpaqueSnap> = {};
  // (catalog, oid) → 不透明对象的键，用于把依赖换算成名字
  const byCatalog = new Map<string, string>();
  const pending: { o: OpaqueSnap; catalog: string; oids: number[] }[] = [];
  const add = (o: OpaqueSnap, catalog: string, oid: number, depOids: number[] = [oid]) => {
    const k = opaqueKey(o);
    out[k] = o;
    byCatalog.set(`${catalog}:${oid}`, k);
    pending.push({ o, catalog, oids: depOids });
  };
  const comment = (what: string, c: string | null) => (c === null ? [] : [`COMMENT ON ${what} IS ${lit(c)}`]);
  const tableKey = (oid: number) => {
    const t = maps.tableByOid.get(oid);
    return t ? key(t.schema, t.name) : null;
  };

  // 域
  for (const r of await db.query<{
    oid: number;
    schema: string;
    name: string;
    base: string;
    collation: string | null;
    def: string | null;
    cons: string[];
    comment: string | null;
  }>(
    `select t.oid::int as oid, n.nspname as schema, t.typname as name, format_type(t.typbasetype, t.typtypmod) as base,
            case when t.typcollation <> b.typcollation
                 then (select quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                         from pg_collation co join pg_namespace cn on cn.oid = co.collnamespace where co.oid = t.typcollation)
            end as collation,
            t.typdefault as def,
            array(select 'CONSTRAINT ' || quote_ident(k.conname) || ' ' || pg_get_constraintdef(k.oid)
                    from pg_constraint k where k.contypid = t.oid order by k.conname) as cons,
            obj_description(t.oid, 'pg_type') as comment
       from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_type b on b.oid = t.typbasetype
      where t.typtype = 'd' and ${ns} and ${NOT_EXT('pg_type', 't.oid')}`,
  )) {
    const q = `${qi(r.schema)}.${qi(r.name)}`;
    let ddl = `CREATE DOMAIN ${q} AS ${r.base}`;
    if (r.collation) ddl += ` COLLATE ${r.collation}`;
    if (r.def) ddl += ` DEFAULT ${r.def}`;
    for (const c of r.cons) ddl += ` ${c}`;
    add(
      {
        objType: 'domain',
        schema: r.schema,
        table: null,
        name: r.name,
        ddl: [ddl, ...comment(`DOMAIN ${q}`, r.comment)],
        drop: `DROP DOMAIN ${q}`,
        deps: [],
        order: r.oid,
      },
      'pg_type',
      r.oid,
    );
  }

  // 复合类型（CREATE TYPE ... AS (...)）
  for (const r of await db.query<{
    oid: number;
    rel: number;
    schema: string;
    name: string;
    attrs: string[];
    comment: string | null;
  }>(
    `select t.oid::int as oid, t.typrelid::int as rel, n.nspname as schema, t.typname as name,
            array(select quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod)
                    from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0 and not a.attisdropped
                   order by a.attnum) as attrs,
            obj_description(t.oid, 'pg_type') as comment
       from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_class c on c.oid = t.typrelid
      where t.typtype = 'c' and c.relkind = 'c' and ${ns} and ${NOT_EXT('pg_type', 't.oid')}`,
  )) {
    const q = `${qi(r.schema)}.${qi(r.name)}`;
    add(
      {
        objType: 'type',
        schema: r.schema,
        table: null,
        name: r.name,
        ddl: [`CREATE TYPE ${q} AS (${r.attrs.join(', ')})`, ...comment(`TYPE ${q}`, r.comment)],
        drop: `DROP TYPE ${q}`,
        deps: [],
        order: r.oid,
      },
      'pg_type',
      r.oid,
    );
    byCatalog.set(`pg_class:${r.rel}`, opaqueKey(out[`type:${r.schema}.${r.name}`]!));
  }

  // 函数、过程、聚合
  for (const r of await db.query<{
    oid: number;
    schema: string;
    name: string;
    kind: string;
    args: string;
    def: string | null;
    agg: {
      sfunc: string;
      stype: string;
      ffunc: string | null;
      init: string | null;
      cfunc: string | null;
    } | null;
    comment: string | null;
  }>(
    `select p.oid::int as oid, n.nspname as schema, p.proname as name, p.prokind::text as kind,
            pg_get_function_identity_arguments(p.oid) as args,
            case when p.prokind in ('f', 'p', 'w') then pg_get_functiondef(p.oid) end as def,
            case when p.prokind = 'a' then
              (select json_build_object('sfunc', a.aggtransfn::regproc::text, 'stype', format_type(a.aggtranstype, null),
                        'ffunc', nullif(a.aggfinalfn::regproc::text, '-'), 'init', a.agginitval,
                        'cfunc', nullif(a.aggcombinefn::regproc::text, '-'))
                 from pg_aggregate a where a.aggfnoid = p.oid) end as agg,
            obj_description(p.oid, 'pg_proc') as comment
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${ns} and ${NOT_EXT('pg_proc', 'p.oid')}`,
  )) {
    const sig = `${qi(r.schema)}.${qi(r.name)}(${r.args})`;
    const objType = r.kind === 'a' ? 'aggregate' : r.kind === 'p' ? 'procedure' : 'function';
    let ddl: string;
    if (r.agg) {
      const parts = [`SFUNC = ${r.agg.sfunc}`, `STYPE = ${r.agg.stype}`];
      if (r.agg.ffunc) parts.push(`FINALFUNC = ${r.agg.ffunc}`);
      if (r.agg.cfunc) parts.push(`COMBINEFUNC = ${r.agg.cfunc}`);
      if (r.agg.init !== null) parts.push(`INITCOND = ${lit(r.agg.init)}`);
      ddl = `CREATE OR REPLACE AGGREGATE ${sig} (${parts.join(', ')})`;
    } else ddl = r.def!.trim();
    const word = objType === 'aggregate' ? 'AGGREGATE' : objType === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    add(
      {
        objType,
        schema: r.schema,
        table: null,
        name: `${r.name}(${r.args})`,
        ddl: [ddl, ...comment(`${word} ${sig}`, r.comment)],
        drop: `DROP ${word} ${sig}`,
        deps: [],
        order: r.oid,
      },
      'pg_proc',
      r.oid,
    );
  }

  // 视图、物化视图（依赖记在它们的重写规则上）
  for (const r of await db.query<{
    oid: number;
    schema: string;
    name: string;
    kind: string;
    def: string;
    options: string[] | null;
    indexes: string[];
    rules: number[];
    comment: string | null;
  }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind::text as kind,
            pg_get_viewdef(c.oid, true) as def, c.reloptions as options,
            array(select pg_get_indexdef(i.indexrelid) from pg_index i where i.indrelid = c.oid order by i.indexrelid) as indexes,
            array(select rw.oid::int from pg_rewrite rw where rw.ev_class = c.oid) as rules,
            obj_description(c.oid, 'pg_class') as comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v', 'm') and ${ns} and ${NOT_EXT('pg_class', 'c.oid')}`,
  )) {
    const q = `${qi(r.schema)}.${qi(r.name)}`;
    const mat = r.kind === 'm';
    const opts = r.options?.length ? ` WITH (${r.options.join(', ')})` : '';
    const body = stripSemi(r.def);
    const ddl = mat
      ? [`CREATE MATERIALIZED VIEW ${q}${opts} AS\n${body}\nWITH NO DATA`, ...r.indexes]
      : [`CREATE VIEW ${q}${opts} AS\n${body}`];
    add(
      {
        objType: mat ? 'materializedView' : 'view',
        schema: r.schema,
        table: null,
        name: r.name,
        ddl: [...ddl, ...comment(`${mat ? 'MATERIALIZED VIEW' : 'VIEW'} ${q}`, r.comment)],
        drop: `DROP ${mat ? 'MATERIALIZED VIEW' : 'VIEW'} ${q}`,
        deps: [],
        order: r.oid,
      },
      'pg_class',
      r.oid,
    );
    // 依赖在 pg_rewrite 上
    pending.at(-1)!.catalog = 'pg_rewrite';
    pending.at(-1)!.oids = r.rules;
  }

  // 触发器
  for (const r of await db.query<{
    oid: number;
    rel: number;
    name: string;
    def: string;
    comment: string | null;
  }>(
    `select g.oid::int as oid, g.tgrelid::int as rel, g.tgname as name, pg_get_triggerdef(g.oid) as def,
            obj_description(g.oid, 'pg_trigger') as comment
       from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not g.tgisinternal and ${ns}`,
  )) {
    const t = tableKey(r.rel);
    const rel = maps.tableByOid.get(r.rel);
    const relName = rel ? `${qi(rel.schema)}.${qi(rel.name)}` : null;
    if (!t || !relName) continue; // 视图上的触发器暂不支持
    add(
      {
        objType: 'trigger',
        schema: rel!.schema,
        table: t,
        name: r.name,
        ddl: [r.def, ...comment(`TRIGGER ${qi(r.name)} ON ${relName}`, r.comment)],
        drop: `DROP TRIGGER ${qi(r.name)} ON ${relName}`,
        deps: [],
        order: r.oid,
      },
      'pg_trigger',
      r.oid,
    );
  }

  // 行级安全：表上的开关和策略
  for (const r of await db.query<{
    oid: number;
    rel: number;
    name: string;
    permissive: boolean;
    cmd: string;
    roles: string[];
    qual: string | null;
    check: string | null;
  }>(
    `select p.oid::int as oid, p.polrelid::int as rel, p.polname as name, p.polpermissive as permissive,
            p.polcmd::text as cmd,
            array(select case when r = 0 then 'public' else quote_ident(pg_get_userbyid(r)) end
                    from unnest(p.polroles) r) as roles,
            pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as check
       from pg_policy p`,
  )) {
    const rel = maps.tableByOid.get(r.rel);
    if (!rel) continue;
    const t = `${qi(rel.schema)}.${qi(rel.name)}`;
    const cmd = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }[r.cmd] ?? 'ALL';
    let ddl = `CREATE POLICY ${qi(r.name)} ON ${t} AS ${r.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${cmd} TO ${r.roles.join(', ')}`;
    if (r.qual) ddl += ` USING (${r.qual})`;
    if (r.check) ddl += ` WITH CHECK (${r.check})`;
    add(
      {
        objType: 'policy',
        schema: rel.schema,
        table: key(rel.schema, rel.name),
        name: r.name,
        ddl: [ddl],
        drop: `DROP POLICY ${qi(r.name)} ON ${t}`,
        deps: [],
        order: r.oid,
      },
      'pg_policy',
      r.oid,
    );
  }
  for (const r of await db.query<{ oid: number; forced: boolean }>(
    `select c.oid::int as oid, c.relforcerowsecurity as forced from pg_class c where c.relrowsecurity`,
  )) {
    const rel = maps.tableByOid.get(r.oid);
    if (!rel) continue;
    const t = `${qi(rel.schema)}.${qi(rel.name)}`;
    add(
      {
        objType: 'policy',
        schema: rel.schema,
        table: key(rel.schema, rel.name),
        name: '(row level security)',
        ddl: [
          `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
          ...(r.forced ? [`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`] : []),
        ],
        drop: `ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY${r.forced ? `, NO FORCE ROW LEVEL SECURITY` : ''}`,
        deps: [`table:${key(rel.schema, rel.name)}`],
        order: 0,
      },
      'pg_class:rls',
      r.oid,
      [],
    );
  }

  // 排他约束
  for (const r of await db.query<{
    oid: number;
    rel: number;
    name: string;
    def: string;
    comment: string | null;
  }>(
    `select k.oid::int as oid, k.conrelid::int as rel, k.conname as name, pg_get_constraintdef(k.oid) as def,
            obj_description(k.oid, 'pg_constraint') as comment
       from pg_constraint k where k.contype = 'x' and k.conislocal and k.conparentid = 0`,
  )) {
    const rel = maps.tableByOid.get(r.rel);
    if (!rel) continue;
    const t = `${qi(rel.schema)}.${qi(rel.name)}`;
    add(
      {
        objType: 'exclusion',
        schema: rel.schema,
        table: key(rel.schema, rel.name),
        name: r.name,
        ddl: [
          `ALTER TABLE ${t} ADD CONSTRAINT ${qi(r.name)} ${r.def}`,
          ...comment(`CONSTRAINT ${qi(r.name)} ON ${t}`, r.comment),
        ],
        drop: `ALTER TABLE ${t} DROP CONSTRAINT ${qi(r.name)}`,
        deps: [],
        order: r.oid,
      },
      'pg_constraint',
      r.oid,
    );
  }

  // 依赖：把 pg_depend 里的引用换算成快照里的名字
  const rowTypeOf = new Map<number, number>(); // 表的行类型 → 表
  for (const r of await db.query<{ oid: number; rel: number }>(
    `select t.oid::int as oid, t.typrelid::int as rel from pg_type t where t.typrelid <> 0`,
  ))
    rowTypeOf.set(r.oid, r.rel);
  const typeElem = new Map<number, number>();
  for (const r of await db.query<{ oid: number; elem: number }>(
    `select t.oid::int as oid, t.typelem::int as elem from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where t.typelem <> 0 and ${USER_NS}`,
  ))
    typeElem.set(r.oid, r.elem);
  const refOf = (cls: string, oid: number, sub: number): string | null => {
    if (cls === 'pg_class') {
      const t = tableKey(oid);
      if (t) {
        if (sub > 0) {
          const c = maps.colName.get(`${oid}:${sub}`);
          return c ? `column:${t}\u0000${c}` : `table:${t}`;
        }
        return `table:${t}`;
      }
      const s = maps.seqByOid.get(oid);
      if (s) return `sequence:${s}`;
      const o = byCatalog.get(`pg_class:${oid}`);
      return o ? `opaque:${o}` : null;
    }
    if (cls === 'pg_type') {
      const e = maps.enumByOid.get(oid) ?? maps.enumByOid.get(typeElem.get(oid) ?? -1);
      if (e) return `enum:${e}`;
      const o = byCatalog.get(`pg_type:${oid}`) ?? byCatalog.get(`pg_type:${typeElem.get(oid)}`);
      if (o) return `opaque:${o}`;
      // 表的行类型（含其数组类型）算作依赖这张表
      const rel = rowTypeOf.get(oid) ?? rowTypeOf.get(typeElem.get(oid) ?? -1);
      const t = rel !== undefined ? tableKey(rel) : null;
      return t ? `table:${t}` : null;
    }
    if (cls === 'pg_proc') {
      const o = byCatalog.get(`pg_proc:${oid}`);
      return o ? `opaque:${o}` : null;
    }
    return null;
  };
  for (const { o, catalog, oids } of pending) {
    if (!oids.length) continue;
    const rows = await db.query<{ cls: string; ref: number; sub: number }>(
      `select d.refclassid::regclass::text as cls, d.refobjid::int as ref, d.refobjsubid::int as sub
         from pg_depend d
        where d.classid = '${catalog}'::regclass and d.objid = any($1::oid[]) and d.deptype in ('n', 'a')`,
      [oids],
    );
    const self = `opaque:${opaqueKey(o)}`;
    const deps = new Set<string>();
    for (const r of rows) {
      const ref = refOf(r.cls, r.ref, r.sub);
      if (ref && ref !== self) deps.add(ref);
    }
    if (o.table) deps.add(`table:${o.table}`);
    o.deps = [...deps].sort();
  }
  return out;
};
