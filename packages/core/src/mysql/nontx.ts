// MySQL 非事务语句（DDL 隐式提交）与实例级高危语句检测（纯函数，前后端共用）。
import type { Token } from '../plan-types.ts';
import { MYSQL_SHADOW_MARK_TABLE } from './naming.ts';
import { mysqlTokenize, splitMysqlStatements, stripMysqlSql } from './quote.ts';

/**
 * MySQL 中会触发隐式提交或不能包进外层事务的语句：
 * 所有 DDL（CREATE / ALTER / DROP / TRUNCATE / RENAME）以及管理/锁/事务控制语句。
 */
const statementIsNontransactional = (s: string): boolean => {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^\s*(?:create|alter|drop|truncate|rename|lock|unlock|load|analyze|optimize|repair|check|flush|reset|grant|revoke|install|uninstall|start\s+transaction|begin|commit|rollback|set\s+autocommit|call)\b/i.test(
    trimmed,
  );
};

export const mysqlIsNontransactionalSql = (sql: string): boolean =>
  stripMysqlSql(sql).split(';').some(statementIsNontransactional);

/** MySQL 在线 DDL 在起止阶段仍需获取元数据锁，照常受 lock_wait_timeout 约束 */
export const mysqlIsConcurrentDdlSql = (_sql: string): boolean => false;

const isSignificant = (t: Token): boolean =>
  !/^\s+$/.test(t.text) &&
  !t.text.startsWith('--') &&
  !t.text.startsWith('#') &&
  !t.text.startsWith('/*') &&
  t.text !== '*/';

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === 'ident' && t.text === w;

const isIdentToken = (t: Token | undefined): t is Token => !!t && (t.kind === 'ident' || t.kind === 'qident');

/** 读取 `[db.]<name>` 形式的对象名，返回对象本体名（小写） */
const readTargetName = (toks: Token[], start: number): string | null => {
  const first = toks[start];
  if (!isIdentToken(first)) return null;
  if (toks[start + 1]?.text === '.' && isIdentToken(toks[start + 2])) {
    return toks[start + 2]!.text.toLowerCase();
  }
  return first.text.toLowerCase();
};

const isInternalName = (name: string | null): boolean =>
  !!name && (name.startsWith('dowel_') || name === MYSQL_SHADOW_MARK_TABLE);

/** 跳过可选的 `IF [NOT] EXISTS` */
const skipIfExists = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'if')) return start;
  if (isWord(toks[start + 1], 'not') && isWord(toks[start + 2], 'exists')) return start + 3;
  if (isWord(toks[start + 1], 'exists')) return start + 2;
  return start;
};

/** 跳过 `DEFINER = user [@ host]` 子句 */
const skipDefiner = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'definer')) return start;
  let j = start + 1;
  if (toks[j]?.text === '=') j++;
  if (j < toks.length) j++; // user
  if (toks[j]?.text === '@') j += 2; // @ host
  return j;
};

/** 检测语句（含触发器/例程体）是否试图篡改或操作 `dowel_*` 迁移历史对象或 `__dowel_shadow_mark` */
const targetsDowelInternal = (toks: Token[]): boolean => {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'ident') continue;

    // DROP [TEMPORARY] TABLE / TRIGGER / INDEX / VIEW / PROCEDURE / FUNCTION / EVENT [IF EXISTS] <name>
    if (t.text === 'drop') {
      let j = i + 1;
      if (isWord(toks[j], 'temporary')) j++;
      if (
        isWord(toks[j], 'table') ||
        isWord(toks[j], 'trigger') ||
        isWord(toks[j], 'index') ||
        isWord(toks[j], 'view') ||
        isWord(toks[j], 'procedure') ||
        isWord(toks[j], 'function') ||
        isWord(toks[j], 'event')
      ) {
        let pos = skipIfExists(toks, j + 1);
        // DROP TABLE 支持逗号分隔多表
        for (;;) {
          const name = readTargetName(toks, pos);
          if (isInternalName(name)) return true;
          pos += toks[pos + 1]?.text === '.' ? 3 : 1;
          if (toks[pos]?.text === ',') {
            pos++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // ALTER TABLE <name> / ALTER VIEW <name>
    if (t.text === 'alter') {
      const j = skipDefiner(toks, i + 1);
      if (isWord(toks[j], 'table') || isWord(toks[j], 'view')) {
        if (isInternalName(readTargetName(toks, j + 1))) return true;
      }
      continue;
    }

    // TRUNCATE [TABLE] <name>
    if (t.text === 'truncate') {
      const j = isWord(toks[i + 1], 'table') ? i + 2 : i + 1;
      if (isInternalName(readTargetName(toks, j))) return true;
      continue;
    }

    // RENAME TABLE a TO b, c TO d
    if (t.text === 'rename' && isWord(toks[i + 1], 'table')) {
      let j = i + 2;
      while (j < toks.length) {
        if (isInternalName(readTargetName(toks, j))) return true;
        j += toks[j + 1]?.text === '.' ? 3 : 1;
        if (isWord(toks[j], 'to')) {
          j++;
          if (isInternalName(readTargetName(toks, j))) return true;
          j += toks[j + 1]?.text === '.' ? 3 : 1;
        }
        if (toks[j]?.text === ',') j++;
        else break;
      }
      continue;
    }

    // CREATE [OR REPLACE] [TEMPORARY] [UNIQUE|FULLTEXT|SPATIAL] [DEFINER=...] TABLE/TRIGGER/INDEX/VIEW/PROCEDURE/FUNCTION/EVENT ...
    if (t.text === 'create') {
      let j = i + 1;
      if (isWord(toks[j], 'or') && isWord(toks[j + 1], 'replace')) j += 2;
      if (isWord(toks[j], 'temporary')) j++;
      if (isWord(toks[j], 'unique') || isWord(toks[j], 'fulltext') || isWord(toks[j], 'spatial')) j++;
      j = skipDefiner(toks, j);
      if (isWord(toks[j], 'algorithm') && toks[j + 1]?.text === '=') j += 3;
      j = skipDefiner(toks, j);
      if (isWord(toks[j], 'sql') && isWord(toks[j + 1], 'security')) j += 3;
      if (
        isWord(toks[j], 'table') ||
        isWord(toks[j], 'trigger') ||
        isWord(toks[j], 'index') ||
        isWord(toks[j], 'view') ||
        isWord(toks[j], 'procedure') ||
        isWord(toks[j], 'function') ||
        isWord(toks[j], 'event')
      ) {
        if (isInternalName(readTargetName(toks, skipIfExists(toks, j + 1)))) return true;
      }
      continue;
    }

    // ON <name>（如 CREATE INDEX ... ON dowel_* / CREATE TRIGGER ... ON dowel_*）
    if (t.text === 'on') {
      if (isInternalName(readTargetName(toks, i + 1))) return true;
      continue;
    }

    // DELETE [LOW_PRIORITY] [QUICK] [IGNORE] FROM <name>
    if (t.text === 'delete') {
      let j = i + 1;
      while (isWord(toks[j], 'low_priority') || isWord(toks[j], 'quick') || isWord(toks[j], 'ignore')) j++;
      if (isWord(toks[j], 'from')) {
        if (isInternalName(readTargetName(toks, j + 1))) return true;
      } else {
        // 多表 DELETE t1 FROM dowel_history t1 ...
        for (let k = j; k < toks.length && k < j + 12; k++) {
          if (isWord(toks[k], 'from') && isInternalName(readTargetName(toks, k + 1))) return true;
        }
      }
      continue;
    }

    // UPDATE [LOW_PRIORITY] [IGNORE] <name>
    if (t.text === 'update') {
      let j = i + 1;
      while (isWord(toks[j], 'low_priority') || isWord(toks[j], 'ignore')) j++;
      if (isInternalName(readTargetName(toks, j))) return true;
      continue;
    }

    // INSERT / REPLACE [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] [INTO] <name>
    if (t.text === 'insert' || t.text === 'replace') {
      let j = i + 1;
      while (
        isWord(toks[j], 'low_priority') ||
        isWord(toks[j], 'delayed') ||
        isWord(toks[j], 'high_priority') ||
        isWord(toks[j], 'ignore')
      ) {
        j++;
      }
      if (isWord(toks[j], 'into')) j++;
      if (isInternalName(readTargetName(toks, j))) return true;
      continue;
    }
  }
  return false;
};

/** 检测 `SELECT ... INTO OUTFILE | DUMPFILE` */
const hasIntoOutfileOrDumpfile = (toks: Token[]): boolean => {
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], 'into') && (isWord(toks[i + 1], 'outfile') || isWord(toks[i + 1], 'dumpfile'))) {
      return true;
    }
  }
  return false;
};

/**
 * 词法级检测 MySQL 实例级 / 高危语句（免疫注释、条件注释 `/*!...*\/` 与无空白紧凑写法）：
 * - CREATE / DROP / ALTER DATABASE | SCHEMA
 * - CREATE / DROP / ALTER / RENAME USER、CREATE / DROP / SET ROLE
 * - GRANT / REVOKE
 * - SET GLOBAL / SET PERSIST / SET PERSIST_ONLY / SET @@GLOBAL... / SET @@PERSIST...
 * - INSTALL / UNINSTALL PLUGIN | COMPONENT
 * - FLUSH / RESET / SHUTDOWN / RESTART / KILL / PURGE / BINLOG / CHANGE REPLICATION / START|STOP REPLICA|SLAVE
 * - CREATE / ALTER / DROP TABLESPACE | LOGFILE GROUP | SERVER | RESOURCE GROUP
 * - LOAD DATA / LOAD XML / SELECT ... INTO OUTFILE | DUMPFILE
 * - USE <db>
 * - 任何触碰 `dowel_*` / `__dowel_shadow_mark` 内部表的 DDL/DML
 */
const statementIsInstanceLevel = (stmt: string): boolean => {
  const toks = mysqlTokenize(stmt).filter(isSignificant);
  if (toks.length === 0) return false;

  let head = 0;
  if (isWord(toks[head], 'explain') || isWord(toks[head], 'describe') || isWord(toks[head], 'desc')) {
    head++;
    if (isWord(toks[head], 'analyze')) head++;
  }
  const first = toks[head];
  if (!first) return false;
  const second = toks[head + 1];

  if (isWord(first, 'create') || isWord(first, 'drop') || isWord(first, 'alter')) {
    if (
      isWord(second, 'database') ||
      isWord(second, 'schema') ||
      isWord(second, 'user') ||
      isWord(second, 'role') ||
      isWord(second, 'tablespace') ||
      isWord(second, 'server') ||
      (isWord(second, 'logfile') && isWord(toks[head + 2], 'group')) ||
      (isWord(second, 'resource') && isWord(toks[head + 2], 'group'))
    ) {
      return true;
    }
  }
  if (isWord(first, 'rename') && isWord(second, 'user')) return true;
  if (isWord(first, 'grant') || isWord(first, 'revoke')) return true;
  if (
    (isWord(first, 'install') || isWord(first, 'uninstall')) &&
    (isWord(second, 'plugin') || isWord(second, 'component'))
  ) {
    return true;
  }
  if (
    isWord(first, 'flush') ||
    isWord(first, 'reset') ||
    isWord(first, 'shutdown') ||
    isWord(first, 'restart') ||
    isWord(first, 'kill') ||
    isWord(first, 'purge') ||
    isWord(first, 'binlog') ||
    isWord(first, 'use')
  ) {
    return true;
  }
  if (
    (isWord(first, 'start') || isWord(first, 'stop') || isWord(first, 'change')) &&
    (isWord(second, 'replica') ||
      isWord(second, 'slave') ||
      isWord(second, 'replication') ||
      isWord(second, 'master'))
  ) {
    return true;
  }
  if (isWord(first, 'load') && (isWord(second, 'data') || isWord(second, 'xml'))) return true;

  if (isWord(first, 'set')) {
    if (
      isWord(second, 'global') ||
      isWord(second, 'persist') ||
      isWord(second, 'persist_only') ||
      isWord(second, 'role') ||
      isWord(second, 'default') ||
      isWord(second, 'password')
    ) {
      return true;
    }
    // SET @@global.xxx = ... / SET @@persist.xxx = ... / SET @@persist_only.xxx = ...
    for (let i = head + 1; i < toks.length - 1; i++) {
      if (toks[i]?.text === '@' && toks[i + 1]?.text === '@') {
        const scope = toks[i + 2];
        if (isWord(scope, 'global') || isWord(scope, 'persist') || isWord(scope, 'persist_only')) return true;
      }
    }
  }

  if (hasIntoOutfileOrDumpfile(toks.slice(head))) return true;
  if (targetsDowelInternal(toks.slice(head))) return true;
  return false;
};

export const MYSQL_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用实例级/高危 MySQL 语句（DATABASE/SCHEMA、USER/ROLE、GRANT/REVOKE、SET GLOBAL/PERSIST、INSTALL/UNINSTALL PLUGIN|COMPONENT、FLUSH/RESET/SHUTDOWN、LOAD DATA、INTO OUTFILE/DUMPFILE、USE 或修改 dowel_* / __dowel_shadow_mark 内部对象）';

export const mysqlFindInstanceLevelStatement = (sql: string): string | null => {
  const hit = splitMysqlStatements(sql).find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};
