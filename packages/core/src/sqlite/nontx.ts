// SQLite 非事务语句与文件/实例级危险语句检测（纯函数，前后端共用）。
import { stripSqliteSql } from './quote.ts';

/**
 * 不能放进外层事务里执行的 SQLite 语句：
 * - `PRAGMA foreign_keys = ...`（SQLite 在事务内修改 foreign_keys 会静默忽略，必须事务外生效）
 * - `VACUUM`、`PRAGMA journal_mode`、`PRAGMA auto_vacuum`、`PRAGMA page_size`、`PRAGMA encoding`
 * - `BEGIN` / `COMMIT` / `ROLLBACK` / `END`（自包含显式事务块，如 12 步表重建，不能再套外层 BEGIN）
 */
const statementIsNontransactional = (s: string): boolean =>
  /^\s*pragma\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?(?:foreign_keys|journal_mode|auto_vacuum|page_size|encoding|legacy_file_format)\b/i.test(
    s,
  ) ||
  /^\s*vacuum\b/i.test(s) ||
  /^\s*(?:begin|commit|rollback|end)\b/i.test(s);

export const sqliteIsNontransactionalSql = (sql: string): boolean =>
  stripSqliteSql(sql).split(';').some(statementIsNontransactional);

/** SQLite 没有 PG 式 CONCURRENTLY 无阻塞建索引 */
export const sqliteIsConcurrentDdlSql = (_sql: string): boolean => false;

/**
 * 拦截访问或操作本地任意文件的危险 SQLite 语句：
 * - `ATTACH [DATABASE] ...`（可能读取/创建任意本地 SQLite 文件）
 * - `DETACH [DATABASE] ...`
 * - `VACUUM ... INTO ...`（可能向任意本地路径写出文件）
 */
const statementIsInstanceLevel = (s: string): boolean =>
  /^\s*(?:attach|detach)\s+(?:database\s+)?/i.test(s) || /^\s*vacuum\b[\s\S]*?\binto\b/i.test(s);

export const SQLITE_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用 ATTACH DATABASE / DETACH DATABASE / VACUUM INTO 等外部文件操作语句';

export const sqliteFindInstanceLevelStatement = (sql: string): string | null => {
  const hit = stripSqliteSql(sql).split(';').find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};
