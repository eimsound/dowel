// schema 范围自洽（P3）：导入范围里的对象不能引用范围外的对象。
// 只导一部分 schema 时，范围外的表、类型、序列等不在快照里；如果范围内的外键 / 视图 / 列类型
// 指向它们，导入出来的模型就是残缺的（迁移会引用不存在的对象）。所以宁可拒绝，
// 并告诉用户要补进范围的 schema。
//
// 检查直接用系统目录（pg_depend / pg_constraint / pg_attribute）：快照已经按范围过滤，
// 跨范围的引用在快照里看不到，只能在库里查。只在给了范围时执行（一次导入一次）。
import type { Db } from './db.ts';

/** 一条跨范围的引用 */
export interface ScopeViolation {
  /** 一句描述，例如 `表 app.orders 的外键 orders_user_id_fkey 引用了 public.users` */
  message: string;
  /** 需要加进范围的 schema */
  schema: string;
}

export class ScopeError extends Error {
  readonly violations: ScopeViolation[];
  readonly scope: string[];
  constructor(violations: ScopeViolation[], scope: string[]) {
    const schemas = [...new Set(violations.map((v) => v.schema))];
    const shown = violations.slice(0, 20).map((v) => v.message);
    const more = violations.length > shown.length ? `（还有 ${violations.length - shown.length} 处）` : '';
    super(
      `导入范围（${scope.join('、')}）里的对象引用了范围外的对象：${shown.join('；')}${more}。` +
        `请把 ${schemas.join('、')} 也加进范围后再导入`,
    );
    this.name = 'ScopeError';
    this.violations = violations;
    this.scope = scope;
  }
}

interface Row {
  srcSchema: string;
  srcName: string;
  /** 引用者多一级的名字（外键名、列名、函数参数等），可以为空 */
  srcDetail: string | null;
  kind: string;
  refSchema: string;
  refName: string;
}

/** 系统 schema 不参与范围判断（只有 $1 是参数，避免 PG 推断不出没用到的参数类型） */
const SYSTEM = `array['pg_catalog', 'information_schema']::text[]`;

/** 查一类跨范围引用；refSchema 一定在范围外（SQL 里已经过滤） */
const query = async (db: Db, sql: string, scope: string[]): Promise<Row[]> => db.query<Row>(sql, [scope]);

const SQL = {
  // 外键：范围内的表 → 范围外的表
  foreignKey: `
    select n.nspname as "srcSchema", c.relname as "srcName", k.conname as "srcDetail",
           'foreign key' as kind, rn.nspname as "refSchema", rc.relname as "refName"
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class rc on rc.oid = k.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
     where k.contype = 'f' and n.nspname = any($1) and not (rn.nspname = any($1))`,
  // 分区子表 → 范围外的父表
  partition: `
    select n.nspname as "srcSchema", c.relname as "srcName", null as "srcDetail",
           'partition' as kind, pn.nspname as "refSchema", p.relname as "refName"
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_class p on p.oid = i.inhparent join pg_namespace pn on pn.oid = p.relnamespace
     where n.nspname = any($1) and not (pn.nspname = any($1))`,
  // 列的类型：枚举、域、复合类型、扩展提供的类型（citext 等）都按类型的 schema 判断
  columnType: `
    select n.nspname as "srcSchema", c.relname as "srcName", a.attname as "srcDetail",
           'column type' as kind, tn.nspname as "refSchema", format_type(a.atttypid, a.atttypmod) as "refName"
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_type t on t.oid = a.atttypid join pg_namespace tn on tn.oid = t.typnamespace
     where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
       and n.nspname = any($1) and not (tn.nspname = any($1)) and tn.nspname <> all(${SYSTEM})`,
  // 列的排序规则
  collation: `
    select n.nspname as "srcSchema", c.relname as "srcName", a.attname as "srcDetail",
           'collation' as kind, cn.nspname as "refSchema", co.collname as "refName"
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      join pg_collation co on co.oid = a.attcollation
      join pg_namespace cn on cn.oid = co.collnamespace
     where c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
       and n.nspname = any($1) and not (cn.nspname = any($1)) and cn.nspname <> all(${SYSTEM})`,
  // 序列 OWNED BY 范围外的列
  sequenceOwner: `
    select sn.nspname as "srcSchema", s.relname as "srcName", null as "srcDetail",
           'sequence owner' as kind, tn.nspname as "refSchema", t.relname || '.' || a.attname as "refName"
      from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S'
      join pg_namespace sn on sn.oid = s.relnamespace
      join pg_class t on t.oid = d.refobjid join pg_namespace tn on tn.oid = t.relnamespace
      join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
     where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype = 'a'
       and sn.nspname = any($1) and not (tn.nspname = any($1))`,
  // 不透明对象（视图、函数、域、触发器、策略、排他约束）在 pg_depend 里的依赖
  opaque: `
    with src as (
      select 'pg_rewrite'::regclass as classid, rw.oid, n.nspname as schema, c.relname as name,
             null::text as detail, case c.relkind when 'm' then 'materialized view' else 'view' end as kind
        from pg_rewrite rw join pg_class c on c.oid = rw.ev_class
        join pg_namespace n on n.oid = c.relnamespace
       where c.relkind in ('v', 'm')
      union all
      select 'pg_proc'::regclass, p.oid, n.nspname, p.proname,
             pg_get_function_identity_arguments(p.oid), 'function'
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      union all
      select 'pg_type'::regclass, t.oid, n.nspname, t.typname, null,
             case t.typtype when 'd' then 'domain' else 'type' end
        from pg_type t join pg_namespace n on n.oid = t.typnamespace
       where t.typtype in ('d', 'c')
      union all
      select 'pg_trigger'::regclass, g.oid, n.nspname, g.tgname, null, 'trigger'
        from pg_trigger g join pg_class c on c.oid = g.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
      union all
      select 'pg_policy'::regclass, p.oid, n.nspname, p.polname, null, 'policy'
        from pg_policy p join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
      union all
      select 'pg_constraint'::regclass, k.oid, n.nspname, k.conname, null, 'constraint'
        from pg_constraint k join pg_class c on c.oid = k.conrelid
        join pg_namespace n on n.oid = c.relnamespace
       where k.contype = 'x'
    )
    select distinct s.schema as "srcSchema", s.name as "srcName", s.detail as "srcDetail", s.kind,
           (pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema as "refSchema",
           (pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).identity as "refName"
      from pg_depend d
      join src s on s.classid = d.classid and s.oid = d.objid
     where s.schema = any($1)
       and (pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema is not null
       and not ((pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema = any($1))
       and not ((pg_identify_object(d.refclassid, d.refobjid, d.refobjsubid)).schema = any(${SYSTEM}))`,
};

/** 把一行查询结果变成可读的句子 */
const describe = (r: Row): ScopeViolation => {
  const ref = `${r.refSchema}.${r.refName}`;
  const owner =
    r.kind === 'foreign key'
      ? `表 ${r.srcSchema}.${r.srcName} 的外键 ${r.srcDetail}`
      : r.kind === 'column type'
        ? `表 ${r.srcSchema}.${r.srcName} 的列 ${r.srcDetail}（类型 ${r.refName}）`
        : r.kind === 'collation'
          ? `表 ${r.srcSchema}.${r.srcName} 的列 ${r.srcDetail} 的排序规则`
          : r.kind === 'partition'
            ? `表 ${r.srcSchema}.${r.srcName}（分区子表）`
            : r.kind === 'sequence owner'
              ? `序列 ${r.srcSchema}.${r.srcName}（OWNED BY）`
              : `${r.kind} ${r.srcSchema}.${r.srcName}${r.srcDetail ? `(${r.srcDetail})` : ''}`;
  const target = r.kind === 'column type' ? `${r.refSchema} 里的类型` : `表 ${ref}`;
  return { message: `${owner} 引用了 ${target}`, schema: r.refSchema };
};

/**
 * 检查范围是否自洽：范围内的对象引用范围外的对象时抛 ScopeError。
 * 覆盖外键、分区、列类型、排序规则、序列 OWNED BY，以及视图 / 函数 / 域 / 触发器 /
 * 策略 / 排他约束在 pg_depend 里的依赖。
 */
export const checkScope = async (db: Db, scope: string[]): Promise<void> => {
  if (!scope.length) return;
  const rows = (await Promise.all(Object.values(SQL).map((sql) => query(db, sql, scope)))).flat();
  const seen = new Set<string>();
  const violations: ScopeViolation[] = [];
  for (const row of rows) {
    const v = describe(row);
    if (seen.has(v.message)) continue;
    seen.add(v.message);
    violations.push(v);
  }
  if (violations.length) throw new ScopeError(violations, scope);
};
