// PostgreSQL serial 家族（serial / bigserial / smallserial）识别与 IR 派生。
// 依据 ADR 0017 决定 6：模型绝不持久化 serial 字符串，写入时按 PG 实际结构展开，展示层仅从 IR 三条件派生。
import type { Column, Model, Sequence } from '../ir.ts';

export type PgSerialKind = 'serial' | 'bigserial' | 'smallserial';
export type PgSerialBase = 'integer' | 'bigint' | 'smallint';

/** 给 MCP / AI 调用方的 serial 写入规则说明（宏与原语 mutator 的参数描述共用） */
export const PG_SERIAL_TYPE_NOTE =
  "PG: `serial` / `bigserial` / `smallserial` (aliases serial4 / serial8 / serial2, case-insensitive, unquoted) are expanded on write into an `integer` / `bigint` / `smallint` column + NOT NULL + an owned sequence named `<table>_<column>_seq` + default `nextval(<that sequence>)`; the model stores the integer type, never `serial`. Cannot be combined with default / identity / generated / notNull: false. Switching between serial variants updates the owned sequence's type in place; setting any other type (including plain integer) changes only the type — clear the default to stop auto-incrementing.";

/** 界面候选顺序 */
export const PG_SERIAL_KINDS: readonly PgSerialKind[] = ['serial', 'bigserial', 'smallserial'];

export const PG_SERIAL_BASE: Readonly<Record<PgSerialKind, PgSerialBase>> = {
  serial: 'integer',
  bigserial: 'bigint',
  smallserial: 'smallint',
};

const SERIAL_ALIASES: Readonly<Record<string, PgSerialKind>> = {
  serial: 'serial',
  serial4: 'serial',
  bigserial: 'bigserial',
  serial8: 'bigserial',
  smallserial: 'smallserial',
  serial2: 'smallserial',
};

const BASE_TO_SERIAL: Readonly<Record<string, PgSerialKind>> = {
  integer: 'serial',
  bigint: 'bigserial',
  smallint: 'smallserial',
};

const isWs = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/**
 * 未加引号的 serial 家族写法 → kind：serial/serial4、bigserial/serial8、smallserial/serial2；大小写不敏感、忽略首尾空白。
 * 带双引号（"serial"）、数组（serial[]）、schema 限定（public.serial）、带修饰符（serial(4)）等一律 null。
 */
export const parsePgSerialType = (raw: string): PgSerialKind | null => {
  const key = raw.trim().toLowerCase();
  return Object.hasOwn(SERIAL_ALIASES, key) ? SERIAL_ALIASES[key]! : null;
};

/** 是否为 serial 数组写法（如 `serial[]`、`BIGSERIAL [ ]`），用于拒绝（PG 不支持 serial 数组）；线性扫描避免回溯 */
export const isPgSerialArrayType = (raw: string): boolean => {
  const trimmed = raw.trim();
  let end = trimmed.length;
  let dims = 0;
  for (;;) {
    let j = end;
    while (isWs(trimmed[j - 1])) j--;
    if (trimmed[j - 1] !== ']') break;
    j--;
    while (isWs(trimmed[j - 1])) j--;
    if (trimmed[j - 1] !== '[') break;
    end = j - 1;
    dims++;
  }
  if (dims === 0) return false;
  return parsePgSerialType(trimmed.slice(0, end)) !== null;
};

/**
 * 三条件派生（只看 IR，不另存标记）：pg 方言、无 typeRef、类型 ∈ {integer,bigint,smallint}、default 是 {nextval}、
 * 该序列存在且 ownedBy === column.id。kind 按列类型（integer→serial 等），不看序列自己的 type。不看 notNull。
 */
export const pgSerialOf = (
  m: Pick<Model, 'dialect' | 'objects'>,
  column: Pick<Column, 'id' | 'type' | 'typeRef' | 'default'>,
): { kind: PgSerialKind; sequence: Sequence } | null => {
  if (m.dialect !== 'pg') return null;
  if (column.typeRef !== null) return null;
  if (!Object.hasOwn(BASE_TO_SERIAL, column.type)) return null;
  const def = column.default;
  if (!def || !('nextval' in def)) return null;
  const seq = Object.hasOwn(m.objects, def.nextval) ? m.objects[def.nextval] : undefined;
  if (!seq || seq.kind !== 'sequence' || seq.ownedBy !== column.id) return null;
  return { kind: BASE_TO_SERIAL[column.type]!, sequence: seq };
};
