// MySQL 8.4 / 9.7 类型规范化与分类工具。

const INT_NO_WIDTH = new Map<string, string>([
  ['int', 'int'],
  ['integer', 'int'],
  ['int4', 'int'],
  ['bigint', 'bigint'],
  ['int8', 'bigint'],
  ['smallint', 'smallint'],
  ['int2', 'smallint'],
  ['mediumint', 'mediumint'],
  ['int3', 'mediumint'],
  ['tinyint', 'tinyint'],
  ['int1', 'tinyint'],
]);

const SIMPLE_ALIASES: Record<string, string> = {
  int: 'int',
  integer: 'int',
  int4: 'int',
  bigint: 'bigint',
  int8: 'bigint',
  smallint: 'smallint',
  int2: 'smallint',
  mediumint: 'mediumint',
  int3: 'mediumint',
  tinyint: 'tinyint',
  int1: 'tinyint',
  bool: 'tinyint(1)',
  boolean: 'tinyint(1)',
  decimal: 'decimal(10,0)',
  dec: 'decimal(10,0)',
  numeric: 'decimal(10,0)',
  fixed: 'decimal(10,0)',
  float: 'float',
  float4: 'float',
  double: 'double',
  'double precision': 'double',
  real: 'double',
  float8: 'double',
  bit: 'bit(1)',
  char: 'char(1)',
  character: 'char(1)',
  binary: 'binary(1)',
  tinytext: 'tinytext',
  text: 'text',
  mediumtext: 'mediumtext',
  longtext: 'longtext',
  tinyblob: 'tinyblob',
  blob: 'blob',
  mediumblob: 'mediumblob',
  longblob: 'longblob',
  date: 'date',
  datetime: 'datetime',
  timestamp: 'timestamp',
  time: 'time',
  year: 'year',
  json: 'json',
  geometry: 'geometry',
  point: 'point',
  linestring: 'linestring',
  polygon: 'polygon',
  multipoint: 'multipoint',
  multilinestring: 'multilinestring',
  multipolygon: 'multipolygon',
  geometrycollection: 'geometrycollection',
  geomcollection: 'geometrycollection',
};

/** 规范化 enum(...) / set(...) 内部值列表（保留单引号字面量原文，去掉逗号后多余空白） */
const normalizeEnumOrSet = (kw: 'enum' | 'set', body: string): string => {
  const vals: string[] = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i]!)) i++;
    if (i >= n) break;
    if (body[i] === "'") {
      const start = i;
      i++;
      while (i < n) {
        if (body[i] === '\\') i = Math.min(n, i + 2);
        else if (body[i] === "'") {
          if (body[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      vals.push(body.slice(start, i));
    } else {
      const start = i;
      while (i < n && body[i] !== ',') i++;
      vals.push(body.slice(start, i).trim());
    }
  }
  return `${kw}(${vals.join(',')})`;
};

/**
 * 规范化 MySQL 类型串，对齐 MySQL 8.4 / 9.7 `information_schema.COLUMNS.COLUMN_TYPE` 输出格式。
 * 保留 `unsigned` / `zerofill` 后缀（若输入自带）。
 */
export const mysqlNormalizeType = (input: string): string => {
  const raw = input.trim().replace(/\s+/g, ' ');
  if (!raw) return 'varchar(255)';

  // 剥离尾部 unsigned / zerofill 修饰符（MySQL 规范顺序：base unsigned zerofill）
  // raw 已去除首尾空白并压缩内部空白为单空格，从尾部移动索引线性剥离避免反复正则扫描与整串拷贝（O(n²)）
  let end = raw.length;
  let hasUnsigned = false;
  let hasZerofill = false;
  for (;;) {
    if (end >= 9 && raw.slice(end - 9, end).toLowerCase() === ' zerofill') {
      hasZerofill = true;
      end -= 9;
    } else if (end >= 9 && raw.slice(end - 9, end).toLowerCase() === ' unsigned') {
      hasUnsigned = true;
      end -= 9;
    } else {
      break;
    }
  }
  const rest = raw.slice(0, end);
  if (hasZerofill) hasUnsigned = true; // MySQL ZEROFILL 自动隐含 UNSIGNED

  const low = rest.toLowerCase();
  let base: string;

  // enum(...) / set(...)
  const enumMatch = /^(enum|set)\s*\(([\s\S]*)\)$/i.exec(rest);
  if (enumMatch) {
    base = normalizeEnumOrSet(enumMatch[1]!.toLowerCase() as 'enum' | 'set', enumMatch[2]!);
  } else if (low in SIMPLE_ALIASES) {
    base = SIMPLE_ALIASES[low]!;
  } else {
    // 带参数类型：<name>(<args>)
    const paramMatch = /^([a-z][a-z0-9\s]*?)\s*\(([^)]+)\)$/i.exec(rest);
    if (paramMatch) {
      const name = paramMatch[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
      const args = paramMatch[2]!
        .split(',')
        .map((a) => a.trim())
        .join(',');

      if (INT_NO_WIDTH.has(name)) {
        const canonical = INT_NO_WIDTH.get(name)!;
        // MySQL 8.0.17+ 仅保留 tinyint(1) 显示宽度（作为 boolean 约定），其余整数显示宽度均省略
        base = canonical === 'tinyint' && args === '1' ? 'tinyint(1)' : canonical;
      } else if (name === 'character varying' || name === 'varchar') {
        base = `varchar(${args})`;
      } else if (name === 'character' || name === 'char') {
        base = `char(${args})`;
      } else if (name === 'varbinary') {
        base = `varbinary(${args})`;
      } else if (name === 'binary') {
        base = `binary(${args})`;
      } else if (name === 'decimal' || name === 'dec' || name === 'numeric' || name === 'fixed') {
        base = args.includes(',') ? `decimal(${args})` : `decimal(${args},0)`;
      } else if (name === 'datetime' || name === 'timestamp' || name === 'time') {
        base = args === '0' ? name : `${name}(${args})`;
      } else if (name === 'year') {
        base = 'year';
      } else if (name === 'bit') {
        base = `bit(${args})`;
      } else if (name === 'float' || name === 'double') {
        base = `${name}(${args})`;
      } else if (name === 'vector') {
        base = `vector(${args})`;
      } else {
        base = `${name}(${args})`;
      }
    } else {
      base = low;
    }
  }

  const mods: string[] = [];
  if (hasUnsigned) mods.push('unsigned');
  if (hasZerofill) mods.push('zerofill');
  return mods.length ? `${base} ${mods.join(' ')}` : base;
};

/** 剥离类型上的 unsigned / zerofill 修饰符，返回纯基础类型与标记 */
export const splitMysqlTypeModifiers = (
  input: string,
): { baseType: string; unsigned: boolean; zerofill: boolean } => {
  const norm = mysqlNormalizeType(input);
  let baseType = norm;
  let unsigned = false;
  let zerofill = false;
  if (/\s+zerofill$/i.test(baseType)) {
    zerofill = true;
    unsigned = true;
    baseType = baseType.replace(/\s+zerofill$/i, '').trim();
  }
  if (/\s+unsigned$/i.test(baseType)) {
    unsigned = true;
    baseType = baseType.replace(/\s+unsigned$/i, '').trim();
  }
  return { baseType, unsigned, zerofill };
};

/** 是否为 MySQL 9.0+ 新增的 VECTOR(N) 类型 */
export const isMysqlVectorType = (type: string): boolean => /^vector\s*\(/i.test(type.trim());

/** 是否为 MySQL 要求 DEFAULT 必须使用括号表达式语法的类型（TEXT / BLOB / JSON / GEOMETRY / VECTOR） */
export const isMysqlExprOnlyDefaultType = (type: string): boolean => {
  const base = type
    .trim()
    .toLowerCase()
    .replace(/\s*\([\s\S]*\)$/, '')
    .split(/\s+/)[0]!;
  return (
    base === 'tinytext' ||
    base === 'text' ||
    base === 'mediumtext' ||
    base === 'longtext' ||
    base === 'tinyblob' ||
    base === 'blob' ||
    base === 'mediumblob' ||
    base === 'longblob' ||
    base === 'json' ||
    base === 'geometry' ||
    base === 'point' ||
    base === 'linestring' ||
    base === 'polygon' ||
    base === 'multipoint' ||
    base === 'multilinestring' ||
    base === 'multipolygon' ||
    base === 'geometrycollection' ||
    base === 'geomcollection' ||
    base === 'vector'
  );
};

/** 是否为支持 AUTO_INCREMENT 的 MySQL 数值类型 */
export const isMysqlAutoIncrementType = (type: string): boolean => {
  const base = splitMysqlTypeModifiers(type)
    .baseType.replace(/\([^)]*\)/, '')
    .trim()
    .toLowerCase();
  return (
    base === 'tinyint' ||
    base === 'smallint' ||
    base === 'mediumint' ||
    base === 'int' ||
    base === 'bigint' ||
    base === 'float' ||
    base === 'double'
  );
};

/** 是否为数值类型（用于判断 information_schema.COLUMN_DEFAULT 是否无需引号） */
export const isMysqlNumericType = (type: string): boolean => {
  const base = splitMysqlTypeModifiers(type)
    .baseType.replace(/\([^)]*\)/, '')
    .trim()
    .toLowerCase();
  return (
    base === 'tinyint' ||
    base === 'smallint' ||
    base === 'mediumint' ||
    base === 'int' ||
    base === 'bigint' ||
    base === 'decimal' ||
    base === 'float' ||
    base === 'double' ||
    base === 'year'
  );
};

/** 是否为受表/列字符集与排序规则影响的 MySQL 字符类型 */
export const isMysqlCharType = (type: string): boolean => {
  const base = splitMysqlTypeModifiers(type)
    .baseType.replace(/\([\s\S]*\)$/, '')
    .trim()
    .toLowerCase();
  return (
    base === 'char' ||
    base === 'varchar' ||
    base === 'tinytext' ||
    base === 'text' ||
    base === 'mediumtext' ||
    base === 'longtext' ||
    base === 'enum' ||
    base === 'set'
  );
};

/** 提取 datetime(n) / timestamp(n) / time(n) 的小数秒精度（无精度返回 null） */
export const mysqlTemporalPrecision = (type: string): number | null => {
  const m = /^(?:datetime|timestamp|time)\s*\((\d+)\)$/i.exec(type.trim());
  return m ? Number.parseInt(m[1]!, 10) : null;
};

/** 界面里推荐的 MySQL 常用类型 */
export const MYSQL_COMMON_TYPES: readonly string[] = [
  'int',
  'bigint',
  'smallint',
  'tinyint(1)',
  'varchar(255)',
  'char(36)',
  'text',
  'mediumtext',
  'decimal(10,2)',
  'double',
  'float',
  'date',
  'datetime',
  'timestamp',
  'time',
  'json',
  'varbinary(255)',
  'blob',
];
