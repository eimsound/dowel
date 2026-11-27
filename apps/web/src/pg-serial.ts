// PostgreSQL serial 的界面显示（ADR 0017 决定 6）：serial 只是写法，模型里存的是整数列 + 归属此列的序列 + 指向它的默认值。
// 显示只看模型里的三个条件（整数类型、默认值指向序列、序列归属此列），不另存标记，从数据库导入的同类列同样显示。
import {
  type Column,
  type Model,
  PG_SERIAL_BASE,
  PG_SERIAL_KINDS,
  type PgSerialKind,
  pgSerialOf,
} from '@dowel/core';

/** 类型框与候选里的完整写法：`serial (integer)`、`bigserial (bigint)`、`smallserial (smallint)` */
export const serialTypeLabel = (kind: PgSerialKind): string => `${kind} (${PG_SERIAL_BASE[kind]})`;

/** 类型候选（PG 项目追加到常用类型之后） */
export const PG_SERIAL_TYPE_OPTIONS: readonly string[] = PG_SERIAL_KINDS.map(serialTypeLabel);

export interface ColumnSerial {
  kind: PgSerialKind;
  /** 类型框里的完整写法，如 `serial (integer)` */
  label: string;
  /** 归属此列、被默认值引用的序列 ID */
  sequenceId: string;
}

/** 列满足 serial 的三个条件时返回显示信息，否则 null（非 PG 项目恒为 null） */
export const columnSerial = (m: Model, c: Column): ColumnSerial | null => {
  if (m.dialect !== 'pg') return null;
  const s = pgSerialOf(m, c);
  return s ? { kind: s.kind, label: serialTypeLabel(s.kind), sequenceId: s.sequence.id } : null;
};

const LABEL_RE = /^\s*(smallserial|serial|bigserial)\s*\(\s*(smallint|integer|bigint)\s*\)\s*$/i;

/**
 * 类型框输入的完整写法换回 serial 写法再交给核心展开：`serial (integer)` → `serial`。
 * 只认完整写法本身（serial 与括号里的底层类型必须配对），其他输入原样返回。
 */
export const unwrapSerialLabel = (text: string): string => {
  const m = LABEL_RE.exec(text);
  if (!m) return text;
  const kind = m[1]!.toLowerCase() as PgSerialKind;
  return PG_SERIAL_BASE[kind] === m[2]!.toLowerCase() ? kind : text;
};

const BASE_TYPES: ReadonlySet<string> = new Set(Object.values(PG_SERIAL_BASE));

/**
 * serial 形态的列被提交成普通整数类型（integer / bigint / smallint，不是 serial 写法）：核心只改类型，
 * 默认值与序列不动，列仍是 serial 形态。界面据此提示“自增仍保留，清空默认值即可取消”。
 */
export const keepsSerialOnPlainInteger = (
  m: Model,
  c: Column,
  target: { type: string; typeRef: string | null },
): boolean => columnSerial(m, c) !== null && target.typeRef === null && BASE_TYPES.has(target.type);
