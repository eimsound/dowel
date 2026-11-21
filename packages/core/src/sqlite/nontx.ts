// SQLite 非事务语句与文件/实例级危险语句检测（纯函数，前后端共用）。
import type { Token } from '../plan-types.ts';
import { splitSqliteStatements, sqliteTokenize, stripSqliteSql } from './quote.ts';

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

const DANGEROUS_PRAGMAS = new Set(['writable_schema', 'temp_store_directory', 'data_store_directory']);

const isSignificant = (t: Token): boolean =>
  !/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*');

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === 'ident' && t.text === w;

const isIdentToken = (t: Token | undefined): t is Token => !!t && (t.kind === 'ident' || t.kind === 'qident');

/** 读取 `[schema.]<name>` 形式的对象名，返回对象本体名（小写） */
const readTargetName = (toks: Token[], start: number): string | null => {
  const first = toks[start];
  if (!isIdentToken(first)) return null;
  if (toks[start + 1]?.text === '.' && isIdentToken(toks[start + 2])) {
    return toks[start + 2]!.text.toLowerCase();
  }
  return first.text.toLowerCase();
};

/** 跳过可选的 `IF [NOT] EXISTS` */
const skipIfExists = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'if')) return start;
  if (isWord(toks[start + 1], 'not') && isWord(toks[start + 2], 'exists')) return start + 3;
  if (isWord(toks[start + 1], 'exists')) return start + 2;
  return start;
};

/** 检测语句（含触发器体）是否试图篡改或操作 dowel_* 迁移历史对象 */
const targetsDowelInternal = (toks: Token[]): boolean => {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'ident') continue;

    // DROP TABLE/TRIGGER/INDEX/VIEW [IF EXISTS] [schema.]dowel_*
    if (t.text === 'drop') {
      const kind = toks[i + 1];
      if (isWord(kind, 'table') || isWord(kind, 'trigger') || isWord(kind, 'index') || isWord(kind, 'view')) {
        const name = readTargetName(toks, skipIfExists(toks, i + 2));
        if (name?.startsWith('dowel_')) return true;
      }
      continue;
    }

    // ALTER TABLE [schema.]dowel_*
    if (t.text === 'alter' && isWord(toks[i + 1], 'table')) {
      const name = readTargetName(toks, i + 2);
      if (name?.startsWith('dowel_')) return true;
      continue;
    }

    // CREATE [TEMP|TEMPORARY] [UNIQUE] TABLE/TRIGGER/INDEX/VIEW [IF NOT EXISTS] [schema.]dowel_*
    // 或 CREATE TRIGGER ... ON [schema.]dowel_*
    if (t.text === 'create') {
      let j = i + 1;
      if (isWord(toks[j], 'temp') || isWord(toks[j], 'temporary')) j++;
      if (isWord(toks[j], 'unique')) j++;
      if (
        isWord(toks[j], 'table') ||
        isWord(toks[j], 'trigger') ||
        isWord(toks[j], 'index') ||
        isWord(toks[j], 'view') ||
        isWord(toks[j], 'virtual')
      ) {
        if (isWord(toks[j], 'virtual') && isWord(toks[j + 1], 'table')) j++;
        const name = readTargetName(toks, skipIfExists(toks, j + 1));
        if (name?.startsWith('dowel_')) return true;
      }
      continue;
    }

    // CREATE INDEX/TRIGGER ... ON [schema.]dowel_*
    if (t.text === 'on') {
      const name = readTargetName(toks, i + 1);
      if (name?.startsWith('dowel_')) return true;
      continue;
    }

    // DELETE FROM [schema.]dowel_*
    if (t.text === 'delete' && isWord(toks[i + 1], 'from')) {
      const name = readTargetName(toks, i + 2);
      if (name?.startsWith('dowel_')) return true;
      continue;
    }

    // UPDATE [OR <action>] [schema.]dowel_*
    if (t.text === 'update') {
      let j = i + 1;
      if (isWord(toks[j], 'or') && toks[j + 1]?.kind === 'ident') j += 2;
      const name = readTargetName(toks, j);
      if (name?.startsWith('dowel_')) return true;
      continue;
    }

    // INSERT [OR <action>] INTO [schema.]dowel_* / REPLACE INTO [schema.]dowel_*
    if (t.text === 'insert' || t.text === 'replace') {
      let j = i + 1;
      if (t.text === 'insert' && isWord(toks[j], 'or') && toks[j + 1]?.kind === 'ident') j += 2;
      if (isWord(toks[j], 'into')) {
        const name = readTargetName(toks, j + 1);
        if (name?.startsWith('dowel_')) return true;
      }
      continue;
    }
  }
  return false;
};

/**
 * 拦截访问/操作本地任意文件或破坏沙箱与迁移历史的危险 SQLite 语句（基于词法流，免疫无空白紧凑写法）：
 * - `[EXPLAIN [QUERY PLAN]] ATTACH ...` / `DETACH ...`（含 `ATTACH'/etc/passwd'AS x`、`ATTACH('x')AS x` 等无空白变体）
 * - `VACUUM ... INTO ...`（向任意本地路径写出文件）
 * - `PRAGMA writable_schema` / `temp_store_directory` / `data_store_directory`
 * - 任何修改/删除/篡改 `dowel_*` 迁移历史表与防篡改触发器的 DDL/DML
 */
const statementIsInstanceLevel = (stmt: string): boolean => {
  const toks = sqliteTokenize(stmt).filter(isSignificant);
  if (toks.length === 0) return false;

  // 剥离前导 EXPLAIN [QUERY PLAN]
  let head = 0;
  if (isWord(toks[head], 'explain')) {
    head++;
    if (isWord(toks[head], 'query') && isWord(toks[head + 1], 'plan')) head += 2;
  }
  const first = toks[head];
  if (!first) return false;

  if (isWord(first, 'attach') || isWord(first, 'detach')) return true;
  if (isWord(first, 'vacuum') && toks.slice(head + 1).some((t) => isWord(t, 'into'))) return true;
  if (isWord(first, 'pragma')) {
    const pragmaName = readTargetName(toks, head + 1);
    if (pragmaName && DANGEROUS_PRAGMAS.has(pragmaName)) return true;
  }
  if (targetsDowelInternal(toks.slice(head))) return true;
  return false;
};

export const SQLITE_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用 ATTACH / DETACH / VACUUM INTO / 危险 PRAGMA 或修改 dowel_* 迁移历史对象';

export const sqliteFindInstanceLevelStatement = (sql: string): string | null => {
  const hit = splitSqliteStatements(sql).find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};
