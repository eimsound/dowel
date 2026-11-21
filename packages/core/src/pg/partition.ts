// PostgreSQL 分区边界解析/格式化/校验、存量 partitionBy 字符串解析与分区键列引用提取。
import type { Column, Model, PartitionKey, PartitionSpec, PartitionStrategy, Table } from '../ir.ts';
import { exprReferences } from './expr.ts';

export type PartitionBound =
  | { kind: 'default' }
  | { kind: 'range'; from: string[]; to: string[] }
  | { kind: 'list'; values: string[] }
  | { kind: 'hash'; modulus: number; remainder: number };

/** 在 PG SQL 片段中跳过从位置 i 开始的字面量/引号标识符/注释，返回跳过后的新下标；否则返回 -1 */
const skipPgAtom = (s: string, i: number): number => {
  const ch = s[i]!;
  if (ch === "'" || ((ch === 'E' || ch === 'e') && s[i + 1] === "'")) {
    const escaped = ch !== "'";
    let j = escaped ? i + 2 : i + 1;
    while (j < s.length) {
      if (escaped && s[j] === '\\') j += 2;
      else if (s[j] === "'" && s[j + 1] === "'") j += 2;
      else if (s[j] === "'") return j + 1;
      else j++;
    }
    return s.length;
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '"' && s[j + 1] === '"') j += 2;
      else if (s[j] === '"') return j + 1;
      else j++;
    }
    return s.length;
  }
  if (ch === '$') {
    const m = /^\$([A-Za-z_]\w*)?\$/.exec(s.slice(i));
    if (m) {
      const tag = m[0];
      const close = s.indexOf(tag, i + tag.length);
      return close < 0 ? s.length : close + tag.length;
    }
  }
  if (ch === '-' && s[i + 1] === '-') {
    const nl = s.indexOf('\n', i + 2);
    return nl < 0 ? s.length : nl + 1;
  }
  if (ch === '/' && s[i + 1] === '*') {
    let depth = 1;
    let j = i + 2;
    while (j < s.length && depth > 0) {
      if (s[j] === '/' && s[j + 1] === '*') {
        depth++;
        j += 2;
      } else if (s[j] === '*' && s[j + 1] === '/') {
        depth--;
        j += 2;
      } else j++;
    }
    return j;
  }
  return -1;
};

/** 从 s[openIdx] === '(' 出发，找到匹配的 ')' 下标；未闭合返回 -1 */
export const findMatchingParen = (s: string, openIdx: number): number => {
  if (s[openIdx] !== '(') return -1;
  let depth = 0;
  let i = openIdx;
  while (i < s.length) {
    const next = skipPgAtom(s, i);
    if (next >= 0) {
      i = next;
      continue;
    }
    const ch = s[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
};

/** 按顶层逗号切分 PG SQL 列表（忽略字符串、引号、注释及括号/方括号内的逗号） */
export const splitTopLevel = (s: string): string[] => {
  if (!s.trim()) return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const next = skipPgAtom(s, i);
    if (next >= 0) {
      i = next;
      continue;
    }
    const ch = s[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  out.push(s.slice(start).trim());
  return out;
};

/** 解析 PG 分区边界子句：DEFAULT / RANGE / LIST / HASH */
export const parsePartitionBound = (bound: string): PartitionBound | null => {
  const s = bound.trim();
  if (!s) return null;
  if (/^DEFAULT$/i.test(s)) return { kind: 'default' };
  const head = /^FOR\s+VALUES\s+/i.exec(s);
  if (!head) return null;
  const rest = s.slice(head[0].length).trim();

  // LIST: FOR VALUES IN (...)
  const inMatch = /^IN\s*\(/i.exec(rest);
  if (inMatch) {
    const open = inMatch[0].length - 1;
    const close = findMatchingParen(rest, open);
    if (close < 0 || rest.slice(close + 1).trim() !== '') return null;
    const values = splitTopLevel(rest.slice(open + 1, close));
    if (!values.length || values.some((v) => !v)) return null;
    return { kind: 'list', values };
  }

  // RANGE: FOR VALUES FROM (...) TO (...)
  const fromMatch = /^FROM\s*\(/i.exec(rest);
  if (fromMatch) {
    const open1 = fromMatch[0].length - 1;
    const close1 = findMatchingParen(rest, open1);
    if (close1 < 0) return null;
    const afterFrom = rest.slice(close1 + 1);
    const toMatch = /^\s*TO\s*\(/i.exec(afterFrom);
    if (!toMatch) return null;
    const open2 = close1 + 1 + toMatch[0].length - 1;
    const close2 = findMatchingParen(rest, open2);
    if (close2 < 0 || rest.slice(close2 + 1).trim() !== '') return null;
    const from = splitTopLevel(rest.slice(open1 + 1, close1));
    const to = splitTopLevel(rest.slice(open2 + 1, close2));
    if (!from.length || !to.length || from.some((v) => !v) || to.some((v) => !v)) return null;
    return { kind: 'range', from, to };
  }

  // HASH: FOR VALUES WITH (modulus M, remainder R)
  const withMatch = /^WITH\s*\(/i.exec(rest);
  if (withMatch) {
    const open = withMatch[0].length - 1;
    const close = findMatchingParen(rest, open);
    if (close < 0 || rest.slice(close + 1).trim() !== '') return null;
    const items = splitTopLevel(rest.slice(open + 1, close));
    if (items.length !== 2) return null;
    let modulus: number | null = null;
    let remainder: number | null = null;
    for (const item of items) {
      const kv = /^(modulus|remainder)\s+(-?\d+)$/i.exec(item);
      if (!kv) return null;
      const val = Number(kv[2]);
      if (!Number.isSafeInteger(val)) return null;
      if (kv[1]!.toLowerCase() === 'modulus') {
        if (modulus !== null) return null;
        modulus = val;
      } else {
        if (remainder !== null) return null;
        remainder = val;
      }
    }
    if (modulus === null || remainder === null) return null;
    return { kind: 'hash', modulus, remainder };
  }

  return null;
};

/** 将结构化分区边界格式化为 PG SQL 边界子句 */
export const formatPartitionBound = (parsed: PartitionBound): string => {
  switch (parsed.kind) {
    case 'default':
      return 'DEFAULT';
    case 'range':
      return `FOR VALUES FROM (${parsed.from.map((v) => v.trim()).join(', ')}) TO (${parsed.to.map((v) => v.trim()).join(', ')})`;
    case 'list':
      return `FOR VALUES IN (${parsed.values.map((v) => v.trim()).join(', ')})`;
    case 'hash':
      return `FOR VALUES WITH (modulus ${parsed.modulus}, remainder ${parsed.remainder})`;
  }
};

export type PartitionBoundError =
  | { code: 'syntax' }
  | { code: 'hash_no_default' }
  | { code: 'strategy_mismatch'; actual: string; expected: string }
  | { code: 'range_count_mismatch' }
  | { code: 'range_key_count'; actual: number; expected: number }
  | { code: 'list_empty' }
  | { code: 'hash_modulus' }
  | { code: 'hash_remainder'; remainder: number; modulus: number };

/** 结构化校验分区边界，返回错误码及参数或 null（合法），便于前端按语言环境展示 */
export const validatePartitionBoundCode = (
  strategy: PartitionStrategy,
  bound: string,
  keyCount?: number,
): PartitionBoundError | null => {
  const parsed = parsePartitionBound(bound);
  if (!parsed) return { code: 'syntax' };
  if (parsed.kind === 'default') {
    if (strategy === 'hash') return { code: 'hash_no_default' };
    return null;
  }
  if (parsed.kind !== strategy) {
    return {
      code: 'strategy_mismatch',
      actual: parsed.kind.toUpperCase(),
      expected: strategy.toUpperCase(),
    };
  }
  if (parsed.kind === 'range') {
    if (parsed.from.length !== parsed.to.length) {
      return { code: 'range_count_mismatch' };
    }
    if (keyCount !== undefined && parsed.from.length !== keyCount) {
      return { code: 'range_key_count', actual: parsed.from.length, expected: keyCount };
    }
    return null;
  }
  if (parsed.kind === 'list') {
    if (!parsed.values.length) return { code: 'list_empty' };
    return null;
  }
  if (parsed.modulus < 1) return { code: 'hash_modulus' };
  if (parsed.remainder < 0 || parsed.remainder >= parsed.modulus) {
    return { code: 'hash_remainder', remainder: parsed.remainder, modulus: parsed.modulus };
  }
  return null;
};

/** 校验分区边界是否匹配给定策略与分区键数量；返回错误信息或 null（合法） */
export const validatePartitionBound = (
  strategy: PartitionStrategy,
  bound: string,
  keyCount?: number,
): string | null => {
  const err = validatePartitionBoundCode(strategy, bound, keyCount);
  if (!err) return null;
  switch (err.code) {
    case 'syntax':
      return '分区边界语法不合法';
    case 'hash_no_default':
      return 'HASH 分区不支持 DEFAULT 子分区';
    case 'strategy_mismatch':
      return `分区边界类型（${err.actual}）与父表分区策略（${err.expected}）不匹配`;
    case 'range_count_mismatch':
      return 'RANGE 分区边界的 FROM 与 TO 值数量必须一致';
    case 'range_key_count':
      return `RANGE 分区边界的值数量（${err.actual}）必须与分区键数量（${err.expected}）一致`;
    case 'list_empty':
      return 'LIST 分区边界至少需要一个值';
    case 'hash_modulus':
      return 'HASH 分区的 modulus 必须为正整数（>= 1）';
    case 'hash_remainder':
      return `HASH 分区的 remainder 必须满足 0 <= remainder < modulus（当前 ${err.remainder} / ${err.modulus}）`;
  }
};

/** 沿 partitionOf 链找根表（带环保护），供内部与 model.ts 共享 */
const findRootTableId = (m: Model, tableId: string): string => {
  const seen = new Set<string>();
  let cur = tableId;
  while (!seen.has(cur)) {
    seen.add(cur);
    const t = m.objects[cur];
    if (t?.kind !== 'table' || !t.partitionOf) return cur;
    if (!(t.partitionOf.parent in m.objects)) return cur;
    cur = t.partitionOf.parent;
  }
  return cur;
};

const tableColumns = (m: Model, tableId: string): Column[] => {
  const root = findRootTableId(m, tableId);
  const rootCols = Object.values(m.objects).filter(
    (o): o is Column => o.kind === 'column' && o.parent === root,
  );
  if (root !== tableId && rootCols.length > 0) return rootCols;
  return Object.values(m.objects).filter(
    (o): o is Column => o.kind === 'column' && (o.parent === root || o.parent === tableId),
  );
};

/** 读取一个 PG 标识符（带引号或不带引号）及后续位置 */
const readIdent = (s: string, start: number): { name: string; raw: string; end: number } | null => {
  let i = start;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return null;
  if (s[i] === '"') {
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '"' && s[j + 1] === '"') j += 2;
      else if (s[j] === '"') {
        j++;
        return { name: s.slice(i + 1, j - 1).replaceAll('""', '"'), raw: s.slice(i, j), end: j };
      } else j++;
    }
    return null;
  }
  const m = /^[A-Za-z_\u0080-\uFFFD][A-Za-z0-9_$\u0080-\uFFFD]*/.exec(s.slice(i));
  if (!m) return null;
  return { name: m[0].toLowerCase(), raw: m[0], end: i + m[0].length };
};

/** 读取可选的 schema 限定标识符（如 `pg_catalog."C"` 或 `text_pattern_ops`） */
const readQualifiedRaw = (s: string, start: number): { raw: string; end: number } | null => {
  const first = readIdent(s, start);
  if (!first) return null;
  let end = first.end;
  let raw = first.raw;
  let i = end;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (s[i] === '.') {
    const second = readIdent(s, i + 1);
    if (!second) return null;
    raw = `${first.raw}.${second.raw}`;
    end = second.end;
  }
  return { raw, end };
};

/** 将存量 `pg_get_partkeydef` 字符串（如 `RANGE (payment_date)`）解析为结构化 PartitionSpec */
export const parsePartitionByString = (
  m: Model,
  table: Pick<Table, 'id'> & Partial<Pick<Table, 'partitionOf'>>,
  raw: string,
): PartitionSpec | null => {
  const s = raw.trim();
  const head = /^(RANGE|LIST|HASH)\s*\(/i.exec(s);
  if (!head) return null;
  const strategy = head[1]!.toLowerCase() as PartitionStrategy;
  const open = head[0].length - 1;
  const close = findMatchingParen(s, open);
  if (close < 0 || s.slice(close + 1).trim() !== '') return null;
  const parts = splitTopLevel(s.slice(open + 1, close));
  if (!parts.length) return null;

  const cols = tableColumns(m, table.id);
  const colByName = new Map(cols.map((c) => [c.name, c.id]));
  const keys: PartitionKey[] = [];

  for (const part of parts) {
    const p = part.trim();
    if (!p) return null;
    let column: string | null = null;
    let expr: string | null = null;
    let restStart = 0;

    if (p.startsWith('(')) {
      const endParen = findMatchingParen(p, 0);
      if (endParen < 0) return null;
      expr = p.slice(1, endParen).trim();
      if (!expr) return null;
      restStart = endParen + 1;
    } else {
      const idTok = readIdent(p, 0);
      const colId = idTok ? colByName.get(idTok.name) : undefined;
      if (idTok && colId) {
        // 确认后面只有空白、COLLATE 或单个 opclass，而不是复杂表达式（如 `a + b`）
        const tail = p.slice(idTok.end).trim();
        if (!tail || /^COLLATE\s+/i.test(tail) || /^[A-Za-z_"]/.test(tail)) {
          column = colId;
          restStart = idTok.end;
        }
      }
      if (column === null) {
        expr = p;
        restStart = p.length;
      }
    }

    let collation: string | null = null;
    let opclass: string | null = null;
    let cursor = restStart;
    const afterCollate = /^\s*COLLATE\s+/i.exec(p.slice(cursor));
    if (afterCollate) {
      cursor += afterCollate[0].length;
      const q = readQualifiedRaw(p, cursor);
      if (!q) return null;
      collation = q.raw;
      cursor = q.end;
    }
    const tail = p.slice(cursor).trim();
    if (tail) {
      const q = readQualifiedRaw(p, cursor);
      if (!q || p.slice(q.end).trim() !== '') {
        // 若不是干净的 opclass，说明前面其实是未加括号的复杂表达式
        if (column !== null) {
          column = null;
          expr = p;
          collation = null;
          opclass = null;
        } else {
          return null;
        }
      } else {
        opclass = q.raw;
      }
    }

    keys.push({ column, expr, opclass, collation });
  }

  return { strategy, keys };
};

/** 将表的 partitionBy 统一解析为 PartitionSpec（已是结构化则原样返回，存量字符串按列即时解析） */
export const resolvePartitionBy = (
  m: Model,
  table: Pick<Table, 'id' | 'partitionBy'> & Partial<Pick<Table, 'partitionOf'>>,
): PartitionSpec | null => {
  if (!table.partitionBy) return null;
  if (typeof table.partitionBy !== 'string') return table.partitionBy;
  return parsePartitionByString(m, table, table.partitionBy);
};

export interface PartitionKeyColumnRefs {
  /** 直接引用的列 ID（去重、保持声明顺序） */
  direct: string[];
  /** 表达式键中引用的列 ID（去重） */
  expr: string[];
  /** 直接引用与表达式引用的全部列 ID（去重） */
  all: string[];
  /** 是否包含表达式分区键 */
  hasExprKey: boolean;
}

/** 提取分区表分区键直接引用的列 ID 与表达式键引用的列 ID */
export const partitionKeyColumns = (
  m: Model,
  table: Pick<Table, 'id' | 'partitionBy'> & Partial<Pick<Table, 'partitionOf'>>,
): PartitionKeyColumnRefs => {
  const spec = resolvePartitionBy(m, table);
  if (!spec) return { direct: [], expr: [], all: [], hasExprKey: false };
  const cols = tableColumns(m, table.id);
  const direct: string[] = [];
  const expr: string[] = [];
  let hasExprKey = false;
  for (const k of spec.keys) {
    if (k.column) {
      if (!direct.includes(k.column)) direct.push(k.column);
    } else if (k.expr) {
      hasExprKey = true;
      for (const c of cols) {
        if (exprReferences(k.expr, c.name) && !expr.includes(c.id)) expr.push(c.id);
      }
    }
  }
  const all = [...direct];
  for (const id of expr) if (!all.includes(id)) all.push(id);
  return { direct, expr, all, hasExprKey };
};

/** 从种子字符串派生确定性的 36 字符 UUID（供 detachPartition 等跨客户端/服务端同步操作生成一致 ID） */
export const derivedUuid = (seed: string): string => {
  const bytes = new TextEncoder().encode(seed);
  const hash32 = (init: number, salt: number) => {
    let h = init >>> 0;
    h = Math.imul(h ^ salt, 0x01000193) >>> 0;
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  };
  const w0 = hash32(0x811c9dc5, 0x11);
  const w1 = hash32(0x9e3779b9, 0x22);
  const w2 = hash32(0x85ebca6b, 0x33);
  const w3 = hash32(0xc2b2ae35, 0x44);
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, w0);
  dv.setUint32(4, w1);
  dv.setUint32(8, w2);
  dv.setUint32(12, w3);
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
