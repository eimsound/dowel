/** 数据库读出的时间列：PG 是 Date，SQLite 是 ISO 文本；统一成 ISO 字符串。 */
export const atOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
