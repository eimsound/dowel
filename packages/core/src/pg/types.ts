// 把用户输入的类型名换成 PG 的规范写法（format_type 的输出），这样手工编辑的模型与导入的模型可以直接比较。
const SIMPLE: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  integer: 'integer',
  int2: 'smallint',
  smallint: 'smallint',
  int8: 'bigint',
  bigint: 'bigint',
  float4: 'real',
  real: 'real',
  float8: 'double precision',
  float: 'double precision',
  'double precision': 'double precision',
  bool: 'boolean',
  boolean: 'boolean',
  varchar: 'character varying',
  'character varying': 'character varying',
  char: 'character(1)',
  character: 'character(1)',
  decimal: 'numeric',
  numeric: 'numeric',
  timestamp: 'timestamp without time zone',
  'timestamp without time zone': 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  'timestamp with time zone': 'timestamp with time zone',
  time: 'time without time zone',
  'time without time zone': 'time without time zone',
  timetz: 'time with time zone',
  'time with time zone': 'time with time zone',
  bit: 'bit(1)',
  varbit: 'bit varying',
  'bit varying': 'bit varying',
};

/** 双引号外的部分转小写、压缩空白；双引号里的标识符（如 "MyDomain"）原样保留——PG 的带引号标识符区分大小写 */
const lowerOutsideQuotes = (input: string): string =>
  input
    .trim()
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 ? part : part.toLowerCase().replace(/\s+/g, ' ')))
    .join('');

export const normalizeType = (input: string): string => {
  const s = lowerOutsideQuotes(input);
  const arr = /((?:\s*\[\s*\])*)$/.exec(s)![0].replace(/\s/g, '');
  const base = s.slice(0, s.length - /((?:\s*\[\s*\])*)$/.exec(s)![0].length).trim();
  const m = /^([a-z ]+?)\s*\(\s*([\d\s,]+)\s*\)\s*(with(?:out)? time zone)?$/.exec(base);
  if (m) {
    const name = m[1]!.trim();
    const mods = m[2]!.replace(/\s/g, '').split(',').join(',');
    const tz = m[3];
    if (name === 'varchar' || name === 'character varying') return `character varying(${mods})${arr}`;
    if (name === 'char' || name === 'character') return `character(${mods})${arr}`;
    if (name === 'decimal' || name === 'numeric') return `numeric(${mods})${arr}`;
    if (name === 'varbit' || name === 'bit varying') return `bit varying(${mods})${arr}`;
    // float(p)：1–24 位精度是 real，25–53 位是 double precision（format_type 的写法）
    if (name === 'float' && /^\d+$/.test(mods)) {
      const p = Number(mods);
      if (p >= 1 && p <= 24) return `real${arr}`;
      if (p >= 25 && p <= 53) return `double precision${arr}`;
    }
    if (name === 'timestamptz') return `timestamp(${mods}) with time zone${arr}`;
    if (name === 'timestamp') return `timestamp(${mods}) ${tz ?? 'without time zone'}${arr}`;
    if (name === 'timetz') return `time(${mods}) with time zone${arr}`;
    if (name === 'time') return `time(${mods}) ${tz ?? 'without time zone'}${arr}`;
    return `${name}(${mods})${arr}`;
  }
  return `${SIMPLE[base] ?? base}${arr}`;
};

/** 界面里推荐的常用类型 */
export const COMMON_TYPES = [
  'bigint',
  'integer',
  'smallint',
  'numeric(12,2)',
  'double precision',
  'boolean',
  'text',
  'character varying(255)',
  'uuid',
  'date',
  'timestamp with time zone',
  'timestamp without time zone',
  'jsonb',
  'bytea',
  'text[]',
];
