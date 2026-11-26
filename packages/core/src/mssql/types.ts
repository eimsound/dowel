// MSSQL 数据类型规范化与版本能力（SQL Server 2019 = 15、2022 = 16、2025 = 17）。
import type { Model } from '../ir.ts';
import { all, find } from '../model.ts';

export const MIN_MSSQL_MAJOR = 15; // SQL Server 2019
export const LATEST_MSSQL_MAJOR = 17; // SQL Server 2025
export const SUPPORTED_MSSQL_MAJORS = [15, 16, 17] as const;

/** 从 MSSQL 数值版本号（如 150000 / 160000 / 170000）提取主版本号（15 / 16 / 17） */
export const mssqlMajorOf = (versionNum: number | null | undefined): number | null => {
  if (typeof versionNum !== 'number' || !Number.isInteger(versionNum) || versionNum <= 0) return null;
  if (versionNum >= 100000) return Math.floor(versionNum / 10000);
  if (versionNum >= 11 && versionNum <= 30) return versionNum;
  return null;
};

/** 把主版本号映射为 SQL Server 发行年份标签（15 → 2019, 16 → 2022, 17 → 2025） */
export const mssqlReleaseYear = (major: number): string => {
  if (major === 15) return '2019';
  if (major === 16) return '2022';
  if (major === 17) return '2025';
  return String(major);
};

export interface MssqlCapabilities {
  major: number;
  nativeJson: boolean;
  vectorType: boolean;
  isDistinctFrom: boolean;
}

export const mssqlCapabilities = (major: number): MssqlCapabilities => ({
  major,
  nativeJson: major >= 17,
  vectorType: major >= 17,
  isDistinctFrom: major >= 16,
});

const SIMPLE_ALIASES: Record<string, string> = {
  integer: 'int',
  int: 'int',
  int4: 'int',
  bigint: 'bigint',
  int8: 'bigint',
  smallint: 'smallint',
  int2: 'smallint',
  tinyint: 'tinyint',
  bit: 'bit',
  bool: 'bit',
  boolean: 'bit',
  real: 'real',
  float: 'float',
  'double precision': 'float',
  money: 'money',
  smallmoney: 'smallmoney',
  date: 'date',
  datetime: 'datetime',
  smalldatetime: 'smalldatetime',
  datetime2: 'datetime2(7)',
  datetimeoffset: 'datetimeoffset(7)',
  time: 'time(7)',
  uniqueidentifier: 'uniqueidentifier',
  uuid: 'uniqueidentifier',
  xml: 'xml',
  json: 'json',
  text: 'text',
  ntext: 'ntext',
  image: 'image',
  rowversion: 'rowversion',
  timestamp: 'rowversion',
  sql_variant: 'sql_variant',
  hierarchyid: 'hierarchyid',
  geometry: 'geometry',
  geography: 'geography',
  decimal: 'decimal(18,0)',
  dec: 'decimal(18,0)',
  numeric: 'numeric(18,0)',
  nvarchar: 'nvarchar(1)',
  varchar: 'varchar(1)',
  nchar: 'nchar(1)',
  char: 'char(1)',
  varbinary: 'varbinary(1)',
  binary: 'binary(1)',
};

const PARAM_ALIASES: Record<string, string> = {
  dec: 'decimal',
  decimal: 'decimal',
  numeric: 'numeric',
  'character varying': 'varchar',
  'char varying': 'varchar',
  varchar: 'varchar',
  'national character varying': 'nvarchar',
  'national char varying': 'nvarchar',
  'nchar varying': 'nvarchar',
  nvarchar: 'nvarchar',
  character: 'char',
  char: 'char',
  'national character': 'nchar',
  'national char': 'nchar',
  nchar: 'nchar',
  'binary varying': 'varbinary',
  varbinary: 'varbinary',
  binary: 'binary',
  float: 'float',
  datetime2: 'datetime2',
  datetimeoffset: 'datetimeoffset',
  time: 'time',
  vector: 'vector',
};

/**
 * 规范化 MSSQL 数据类型文本：
 * 统一小写、压缩空白、规范化别名及默认精度/标度（与 sys.types + sys.columns 反解结果对齐）。
 */
export const mssqlNormalizeType = (input: string): string => {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return 'nvarchar(max)';
  const low = s.toLowerCase();
  if (low in SIMPLE_ALIASES) return SIMPLE_ALIASES[low]!;

  const m = /^([a-z_][a-z0-9_ ]*?)\s*\(\s*([^)]+?)\s*\)$/.exec(low);
  if (!m) return low;
  const rawBase = m[1]!.trim();
  const base = PARAM_ALIASES[rawBase] ?? rawBase;
  const args = m[2]!
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

  if (base === 'float' && args.length === 1) {
    const bits = Number.parseInt(args[0]!, 10);
    if (Number.isInteger(bits)) {
      if (bits >= 1 && bits <= 24) return 'real';
      if (bits >= 25 && bits <= 53) return 'float';
    }
  }
  if ((base === 'decimal' || base === 'numeric') && args.length === 1) {
    return `${base}(${args[0]!},0)`;
  }
  if (base === 'decimal' || base === 'numeric') {
    return `${base}(${args.join(',')})`;
  }
  if (base === 'nvarchar' || base === 'varchar' || base === 'varbinary') {
    return `${base}(${args[0] === 'max' ? 'max' : args.join(',')})`;
  }
  if (
    base === 'nchar' ||
    base === 'char' ||
    base === 'binary' ||
    base === 'time' ||
    base === 'datetime2' ||
    base === 'datetimeoffset' ||
    base === 'vector'
  ) {
    return `${base}(${args.join(',')})`;
  }
  return `${base}(${args.join(',')})`;
};

/** 是否为 SQL Server 2025（17+）原生 json 类型 */
export const isMssqlNativeJsonType = (type: string): boolean => mssqlNormalizeType(type) === 'json';

/** 是否为 SQL Server 2025（17+）原生 vector(n) 类型 */
export const isMssqlVectorType = (type: string): boolean => /^vector\(\d+\)$/.test(mssqlNormalizeType(type));

/** 是否为允许携带 MSSQL IDENTITY(seed, increment) 的精确数值/整数类型 */
export const isMssqlIdentityEligibleType = (type: string): boolean => {
  const norm = mssqlNormalizeType(type);
  if (norm === 'tinyint' || norm === 'smallint' || norm === 'int' || norm === 'bigint') return true;
  return /^(?:decimal|numeric)\(\d+,0\)$/.test(norm);
};

/** SQL Server 版本兼容性问题（结构化，供 diagnoseModel 汇总） */
export interface MssqlCompatibilityIssue {
  code: 'native_json' | 'vector_type';
  severity: 'error';
  objectId: string;
  objectName: string;
  /** 最低需要的 SQL Server 主版本号 */
  minMajor: number;
  message: string;
}

/** 收集模型在指定 SQL Server 主版本下的全部类型兼容性问题（如 2019/2022 不支持原生 json 与 vector(n)） */
export const checkMssqlCompatibility = (m: Model, targetMajor: number): MssqlCompatibilityIssue[] => {
  const cap = mssqlCapabilities(targetMajor);
  const issues: MssqlCompatibilityIssue[] = [];
  const year = mssqlReleaseYear(targetMajor);
  for (const c of all(m, 'column')) {
    const t = find(m, c.parent);
    const label = t?.kind === 'table' ? `${t.name}.${c.name}` : c.name;
    if (!cap.nativeJson && isMssqlNativeJsonType(c.type)) {
      issues.push({
        code: 'native_json',
        severity: 'error',
        objectId: c.id,
        objectName: label,
        minMajor: 17,
        message: `列 ${label} 使用了原生 json 类型，需要 SQL Server 2025（主版本 17+，当前目标 SQL Server ${year} / ${targetMajor}），低版本请改用 nvarchar(max)`,
      });
    }
    if (!cap.vectorType && isMssqlVectorType(c.type)) {
      issues.push({
        code: 'vector_type',
        severity: 'error',
        objectId: c.id,
        objectName: label,
        minMajor: 17,
        message: `列 ${label} 使用了 ${c.type} 类型，需要 SQL Server 2025（主版本 17+，当前目标 SQL Server ${year} / ${targetMajor}）`,
      });
    }
  }
  return issues;
};

/** 检查模型在指定 SQL Server 主版本下的类型兼容性，返回错误文本列表（规划器用） */
export const checkMssqlVersionCompatibility = (m: Model, targetMajor: number): string[] =>
  checkMssqlCompatibility(m, targetMajor).map((i) => i.message);

/** 界面推荐的 MSSQL 常用类型 */
export const MSSQL_COMMON_TYPES: readonly string[] = [
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'bit',
  'decimal(18,2)',
  'float',
  'nvarchar(255)',
  'nvarchar(max)',
  'varchar(255)',
  'varbinary(max)',
  'date',
  'time(7)',
  'datetime2(7)',
  'datetimeoffset(7)',
  'uniqueidentifier',
  'xml',
  'json',
  'vector(1536)',
];
