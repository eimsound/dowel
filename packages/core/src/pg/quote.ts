// PG 标识符与字面量的引用规则。
// 关键字列表来自 PG 18.6 的 pg_get_keywords()（catcode <> 'U'，即保留、列名、类型/函数名三类）。
export const KEYWORDS: ReadonlySet<string> = new Set(
  'all analyse analyze and any array as asc asymmetric authorization between bigint binary bit boolean both case cast char character check coalesce collate collation column concurrently constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user dec decimal default deferrable desc distinct do else end except exists extract false fetch float for foreign freeze from full grant greatest group grouping having ilike in initially inner inout int integer intersect interval into is isnull join json json_array json_arrayagg json_exists json_object json_objectagg json_query json_scalar json_serialize json_table json_value lateral leading least left like limit localtime localtimestamp merge_action national natural nchar none normalize not notnull null nullif numeric offset on only or order out outer overlaps overlay placing position precision primary real references returning right row select session_user setof similar smallint some substring symmetric system_user table tablesample then time timestamp to trailing treat trim true union unique user using values varchar variadic verbose when where window with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot xmlserialize xmltable'.split(
    ' ',
  ),
);

/** 与 PG 的 quote_identifier 一致：只有全小写、合法且不是关键字的名字才不加引号 */
export const ident = (name: string): string =>
  /^[a-z_][a-z0-9_$]*$/.test(name) && !KEYWORDS.has(name) ? name : `"${name.replaceAll('"', '""')}"`;

export const qualified = (schema: string, name: string): string => `${ident(schema)}.${ident(name)}`;

export const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
