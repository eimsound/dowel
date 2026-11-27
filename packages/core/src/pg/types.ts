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

type TypeSegment = { kind: 'outside'; text: string } | { kind: 'paren'; raw: string; closed: boolean };

const NUMERIC_MOD_RE = /^\s*\d+(?:\s*,\s*\d+)*\s*$/;

/**
 * 扫描顶层括号之外的类型名与括号内的修饰符：
 * - 双引号标识符（含 `""` 转义）原样保留，内部括号/空格/大小写都不改；
 * - 顶层 `(...)` 组（追踪嵌套括号及单/双引号）作为 `paren` 原样切出；
 * - 其余括号外未加引号文本转小写并压缩空白。
 */
const scanTypeSegments = (rawBase: string): TypeSegment[] => {
  const segments: TypeSegment[] = [];
  let outsideBuf = '';
  const flushOutside = () => {
    if (outsideBuf) {
      segments.push({ kind: 'outside', text: outsideBuf });
      outsideBuf = '';
    }
  };

  let i = 0;
  const n = rawBase.length;
  while (i < n) {
    const ch = rawBase[i]!;
    if (ch === '"') {
      const start = i++;
      while (i < n) {
        if (rawBase[i] === '"') {
          if (rawBase[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      outsideBuf += rawBase.slice(start, i);
    } else if (ch === '(') {
      flushOutside();
      const start = i;
      let depth = 0;
      while (i < n) {
        const c = rawBase[i]!;
        if (c === "'" || c === '"') {
          i++;
          while (i < n) {
            if (rawBase[i] === c) {
              if (rawBase[i + 1] === c) i += 2;
              else {
                i++;
                break;
              }
            } else {
              i++;
            }
          }
        } else if (c === '(') {
          depth++;
          i++;
        } else if (c === ')') {
          depth--;
          i++;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      segments.push({ kind: 'paren', raw: rawBase.slice(start, i), closed: depth === 0 });
    } else {
      const start = i;
      while (i < n && rawBase[i] !== '"' && rawBase[i] !== '(') i++;
      outsideBuf += rawBase.slice(start, i).toLowerCase().replace(/\s+/g, ' ');
    }
  }
  flushOutside();
  return segments;
};

const isWs = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** 从尾部线性剥离任意个 `[]`（允许括号内外夹空白），替代非锚定正则避免 O(n²) 回溯 */
const stripTrailingArraySuffix = (trimmed: string): { rawBase: string; arr: string } => {
  let end = trimmed.length;
  let count = 0;
  for (;;) {
    let j = end;
    while (isWs(trimmed[j - 1])) j--;
    if (trimmed[j - 1] !== ']') break;
    j--;
    while (isWs(trimmed[j - 1])) j--;
    if (trimmed[j - 1] !== '[') break;
    end = j - 1;
    count++;
  }
  return {
    rawBase: count ? trimmed.slice(0, end).trim() : trimmed,
    arr: count ? '[]'.repeat(count) : '',
  };
};

export const normalizeType = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const { rawBase, arr } = stripTrailingArraySuffix(trimmed);
  if (!rawBase) return arr;

  const segments = scanTypeSegments(rawBase);

  if (segments.length === 1 && segments[0]!.kind === 'outside') {
    const base = segments[0]!.text.trim();
    return `${SIMPLE[base] ?? base}${arr}`;
  }

  if (
    (segments.length === 2 || (segments.length === 3 && segments[2]!.kind === 'outside')) &&
    segments[0]!.kind === 'outside' &&
    segments[1]!.kind === 'paren' &&
    segments[1]!.closed
  ) {
    const inner = segments[1]!.raw.slice(1, -1);
    if (NUMERIC_MOD_RE.test(inner)) {
      const name = segments[0]!.text.trim();
      const mods = inner.replace(/\s+/g, '');
      const tail = segments[2]?.kind === 'outside' ? segments[2]!.text.trim() : '';
      if (!tail) {
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
        if (name === 'timestamp') return `timestamp(${mods}) without time zone${arr}`;
        if (name === 'timetz') return `time(${mods}) with time zone${arr}`;
        if (name === 'time') return `time(${mods}) without time zone${arr}`;
        return `${name}(${mods})${arr}`;
      }
      if (
        (tail === 'with time zone' || tail === 'without time zone') &&
        (name === 'timestamp' || name === 'time')
      ) {
        return `${name}(${mods}) ${tail}${arr}`;
      }
    }
  }

  // 回退拼装：保留非纯数字修饰符（如 geometry(Point,4326)）与未闭合括号原文，仅对括号外未加引号片段规范空白/小写
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'outside') {
      const t = seg.text.trim();
      if (t) out += out ? ` ${t}` : t;
    } else if (seg.closed) {
      const inner = seg.raw.slice(1, -1);
      out += NUMERIC_MOD_RE.test(inner) ? `(${inner.replace(/\s+/g, '')})` : seg.raw;
    } else {
      out += seg.raw;
    }
  }
  return `${out}${arr}`;
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
