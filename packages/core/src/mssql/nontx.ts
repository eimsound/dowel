// MSSQL 非事务语句检测与实例级高危语句拦截（词法级，前后端共用）。
import type { Token } from '../plan-types.ts';
import { splitMssqlBatches } from './batch.ts';
import { mssqlTokenize, stripMssqlSql } from './quote.ts';

const isSignificant = (t: Token): boolean =>
  !/^\s+$/.test(t.text) && !t.text.startsWith('--') && !t.text.startsWith('/*');

const isWord = (t: Token | undefined, w: string): boolean => t?.kind === 'ident' && t.text === w;

const isIdentToken = (t: Token | undefined): t is Token => !!t && (t.kind === 'ident' || t.kind === 'qident');

/**
 * 识别 MSSQL 不能在用户事务内执行的语句：
 * - `CREATE / ALTER / DROP DATABASE`（含 `ALTER DATABASE ... SET ...`）
 * - `CREATE / ALTER / DROP FULLTEXT CATALOG | INDEX | STOPLIST`
 * - `CREATE / ALTER / DROP SEARCH PROPERTY LIST`
 * - `RECONFIGURE`
 * - `BACKUP` / `RESTORE`
 * - `DBCC SHRINKDATABASE | SHRINKFILE`
 */
const statementIsNontransactional = (stmt: string): boolean => {
  const s = stripMssqlSql(stmt).trim();
  if (!s) return false;
  return (
    /^(?:create|alter|drop)\s+database\b/i.test(s) ||
    /^(?:create|alter|drop)\s+fulltext\s+(?:catalog|index|stoplist)\b/i.test(s) ||
    /^(?:create|alter|drop)\s+search\s+property\s+list\b/i.test(s) ||
    /^reconfigure\b/i.test(s) ||
    /^(?:backup|restore)\b/i.test(s) ||
    /^dbcc\s+(?:shrinkdatabase|shrinkfile)\b/i.test(s)
  );
};

export const mssqlIsNontransactionalSql = (sql: string): boolean => {
  for (const batch of splitMssqlBatches(sql, { expandRepeat: false })) {
    const stripped = stripMssqlSql(batch);
    for (const part of stripped.split(';')) {
      if (statementIsNontransactional(part)) return true;
    }
  }
  return false;
};

/** MSSQL 建索引不支持 PG 式 CONCURRENTLY（企业版 ONLINE = ON 仍可在事务内执行） */
export const mssqlIsConcurrentDdlSql = (_sql: string): boolean => false;

const INSTANCE_DDL_SINGLE = new Set(['database', 'login', 'endpoint', 'credential', 'linkedserver']);

const DANGEROUS_PROCS = new Set([
  'sp_configure',
  'xp_cmdshell',
  'sp_addlinkedserver',
  'sp_addlinkedsrvlogin',
  'sp_dropserver',
  'sp_addlogin',
  'sp_droplogin',
  'sp_addsrvrolemember',
  'sp_dropsrvrolemember',
  'sp_oacreate',
  'xp_regread',
  'xp_regwrite',
  'xp_dirtree',
  'xp_fileexist',
  'sp_renamedb',
  'sp_detach_db',
  'sp_attach_db',
  'sp_attach_single_file_db',
]);

const WRITE_DML_KEYWORDS = new Set(['insert', 'update', 'delete', 'merge', 'truncate']);

/** 读取多段限定名（含空段，如 `[master]..[xp_cmdshell]`、`db..obj`、`dowel.history`），返回各段小写名与结束下标 */
const readMultipartName = (toks: Token[], start: number): { parts: string[]; next: number } => {
  const parts: string[] = [];
  let i = start;
  if (!isIdentToken(toks[i])) return { parts, next: i };
  parts.push(toks[i]!.text.toLowerCase());
  i++;
  while (toks[i]?.text === '.') {
    if (isIdentToken(toks[i + 1])) {
      parts.push(toks[i + 1]!.text.toLowerCase());
      i += 2;
    } else if (toks[i + 1]?.text === '.') {
      parts.push('');
      i += 1;
    } else {
      break;
    }
  }
  return { parts, next: i };
};

/** 判断多段名是否指向 `[dowel]` schema 下的对象（2 段 `dowel.obj` 或 3 段 `db.dowel.obj`） */
const isDowelSchemaRef = (parts: string[]): boolean => {
  if (parts.length === 2) return parts[0] === 'dowel';
  if (parts.length >= 3) return parts[parts.length - 2] === 'dowel';
  return false;
};

/** 解包单个 T-SQL 字符串字面量（`'...'` 或 `N'...'`），非字符串字面量返回 null */
const unwrapSqlString = (t: Token | undefined): string | null => {
  if (!t || t.kind !== 'other') return null;
  const s = t.text;
  let body: string | null = null;
  if ((s.startsWith("N'") || s.startsWith("n'")) && s.endsWith("'") && s.length >= 3) {
    body = s.slice(2, -1);
  } else if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    body = s.slice(1, -1);
  }
  return body === null ? null : body.replaceAll("''", "'");
};

/**
 * 检查 `sp_rename` 调用（无论是否带 `EXEC`、是否用命名参数 `@objname`/`@objtype`、是否含引号/空白/三段名）：
 * - 禁止重命名数据库（`@objtype = N'DATABASE'`）
 * - 禁止目标指向 `[dowel]` schema 或跨库对象
 * - 禁止非静态字面量的动态目标/类型表达式（如变量或字符串拼接绕过）
 */
const spRenameIsDangerous = (toks: Token[], afterProcIdx: number): boolean => {
  const args: Token[][] = [];
  let cur: Token[] = [];
  let depth = 0;
  for (let i = afterProcIdx; i < toks.length; i++) {
    const t = toks[i]!;
    if (depth === 0 && t.text === ';') break;
    if (t.text === '(') {
      depth++;
      cur.push(t);
    } else if (t.text === ')') {
      depth = Math.max(0, depth - 1);
      cur.push(t);
    } else if (depth === 0 && t.text === ',') {
      args.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length > 0) args.push(cur);

  let objNameToks: Token[] | null = null;
  let objTypeToks: Token[] | null = null;
  let posIdx = 0;
  for (const arg of args) {
    if (arg.length >= 2 && arg[0]!.kind === 'other' && arg[0]!.text.startsWith('@') && arg[1]!.text === '=') {
      const pname = arg[0]!.text.toLowerCase();
      const val = arg.slice(2);
      if (pname === '@objname') objNameToks = val;
      else if (pname === '@objtype') objTypeToks = val;
    } else {
      if (posIdx === 0) objNameToks = arg;
      else if (posIdx === 2) objTypeToks = arg;
      posIdx++;
    }
  }

  let objType: string | null = null;
  if (objTypeToks && objTypeToks.length > 0) {
    if (objTypeToks.length !== 1) return true;
    const rawType = unwrapSqlString(objTypeToks[0]);
    if (rawType === null) return true;
    objType = rawType.trim().toLowerCase();
    if (objType === 'database') return true;
  }

  if (objNameToks && objNameToks.length > 0) {
    if (objNameToks.length !== 1) return true;
    const rawTarget = unwrapSqlString(objNameToks[0]);
    if (rawTarget === null) return true;
    const innerToks = mssqlTokenize(rawTarget).filter(isSignificant);
    const { parts } = readMultipartName(innerToks, 0);
    if (parts.some((p) => p === '')) return true;
    if (parts.length >= 4) return true;
    if (parts.length === 3 && objType !== 'column' && objType !== 'index' && objType !== 'statistics') {
      return true;
    }
    if (parts.length >= 2 && parts[0] === 'dowel') return true;
    if (parts.length >= 3 && parts[1] === 'dowel') return true;
  }

  return false;
};

/** 词法级检测一个批次内是否包含高危实例级语句、跨库引用或篡改 `[dowel]` schema 对象的语句 */
const batchIsInstanceLevel = (batch: string): boolean => {
  const toks = mssqlTokenize(batch).filter(isSignificant);
  if (toks.length === 0) return false;

  let hasWriteDml = false;
  let hasDowelRef = false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;

    // 0. 检查所有多段名（含方括号/双引号 qident）：
    //    - 禁止 3 段/4 段跨库与链接服务器引用（如 db.dbo.t、db..t、[master]..[xp_cmdshell]）
    //    - 禁止任何危险系统存储过程（无论是否加 EXEC、是否加方括号）
    //    - 严格审查 sp_rename（无论是否加 EXEC、是否加方括号）
    if (isIdentToken(t) && toks[i - 1]?.text !== '.') {
      const { parts, next } = readMultipartName(toks, i);
      if (parts.length >= 3) return true;
      if (isDowelSchemaRef(parts)) hasDowelRef = true;
      const lastPart = parts.at(-1);
      if (lastPart && DANGEROUS_PROCS.has(lastPart)) return true;
      if (lastPart === 'sp_rename' && spRenameIsDangerous(toks, next)) return true;
    }

    if (t.kind !== 'ident') continue;

    if (WRITE_DML_KEYWORDS.has(t.text)) hasWriteDml = true;

    // 1. 独立高危关键字：USE <db> / KILL / RECONFIGURE / SHUTDOWN / BACKUP / RESTORE / OPENROWSET / OPENDATASOURCE / OPENQUERY / BULK INSERT
    if (
      t.text === 'kill' ||
      t.text === 'reconfigure' ||
      t.text === 'shutdown' ||
      t.text === 'backup' ||
      t.text === 'restore' ||
      t.text === 'openrowset' ||
      t.text === 'opendatasource' ||
      t.text === 'openquery'
    ) {
      return true;
    }
    if (t.text === 'use' && isIdentToken(toks[i + 1])) return true;
    if (t.text === 'bulk' && isWord(toks[i + 1], 'insert')) return true;

    // 2. CREATE / ALTER / DROP 实例级对象 & [dowel] schema 对象
    if (t.text === 'create' || t.text === 'alter' || t.text === 'drop') {
      let j = i + 1;
      if (t.text === 'create' && isWord(toks[j], 'or') && isWord(toks[j + 1], 'alter')) j += 2;
      const objKind = toks[j];
      if (!objKind || objKind.kind !== 'ident') continue;

      if (INSTANCE_DDL_SINGLE.has(objKind.text)) return true;
      if (
        objKind.text === 'server' &&
        (isWord(toks[j + 1], 'role') || isWord(toks[j + 1], 'audit') || isWord(toks[j + 1], 'trigger'))
      ) {
        return true;
      }
      if (objKind.text === 'linked' && isWord(toks[j + 1], 'server')) return true;
      if (objKind.text === 'event' && isWord(toks[j + 1], 'session')) return true;
      if (objKind.text === 'availability' && isWord(toks[j + 1], 'group')) return true;
      if (objKind.text === 'resource' && isWord(toks[j + 1], 'pool')) return true;
      if (objKind.text === 'workload' && isWord(toks[j + 1], 'group')) return true;

      // CREATE / ALTER / DROP SCHEMA [dowel] 或 ALTER SCHEMA [x] TRANSFER [dowel].[y]
      if (objKind.text === 'schema') {
        let k = j + 1;
        if (isWord(toks[k], 'if') && isWord(toks[k + 1], 'exists')) k += 2;
        const { parts, next } = readMultipartName(toks, k);
        if (parts.length > 0 && parts[0] === 'dowel') return true;
        if (t.text === 'alter' && isWord(toks[next], 'transfer')) {
          const src = readMultipartName(toks, next + 1);
          if (isDowelSchemaRef(src.parts)) return true;
        }
        continue;
      }

      // CREATE / ALTER / DROP TABLE|VIEW|TRIGGER|INDEX|SEQUENCE|PROCEDURE|PROC|FUNCTION|SYNONYM|TYPE [IF EXISTS] [dowel].[*]
      let k = j;
      if (isWord(toks[k], 'unique')) k++;
      if (isWord(toks[k], 'clustered') || isWord(toks[k], 'nonclustered')) k++;
      if (
        isWord(toks[k], 'table') ||
        isWord(toks[k], 'view') ||
        isWord(toks[k], 'trigger') ||
        isWord(toks[k], 'index') ||
        isWord(toks[k], 'sequence') ||
        isWord(toks[k], 'procedure') ||
        isWord(toks[k], 'proc') ||
        isWord(toks[k], 'function') ||
        isWord(toks[k], 'synonym') ||
        isWord(toks[k], 'type')
      ) {
        let nameIdx = k + 1;
        if (isWord(toks[nameIdx], 'if') && isWord(toks[nameIdx + 1], 'exists')) nameIdx += 2;
        const { parts, next } = readMultipartName(toks, nameIdx);
        if (isDowelSchemaRef(parts)) return true;
        if (isWord(toks[k], 'synonym') && isWord(toks[next], 'for')) {
          const target = readMultipartName(toks, next + 1);
          if (isDowelSchemaRef(target.parts) || target.parts.length >= 3) return true;
        }
      }
      continue;
    }

    // 3. ON 目标检查：
    //    - ON DATABASE / ON ALL SERVER（含 DISABLE/ENABLE/CREATE/DROP TRIGGER、GRANT/DENY/REVOKE、ALTER AUTHORIZATION）
    //    - ON SCHEMA::[dowel] / ON OBJECT::[dowel].* / ON TYPE::[dowel].* / ON SERVER::* / ON LOGIN::* / ON ENDPOINT::*
    //    - ON [dowel].*（如 CREATE TRIGGER/INDEX / DROP INDEX / GRANT ... ON [dowel].[history]）
    if (t.text === 'on') {
      if (isWord(toks[i + 1], 'database')) return true;
      if (isWord(toks[i + 1], 'all') && isWord(toks[i + 2], 'server')) return true;
      if (toks[i + 2]?.text === ':' && toks[i + 3]?.text === ':') {
        const scope = toks[i + 1]?.kind === 'ident' ? toks[i + 1]!.text : '';
        if (
          scope === 'database' ||
          scope === 'server' ||
          scope === 'login' ||
          scope === 'endpoint' ||
          scope === 'availability'
        ) {
          return true;
        }
        const target = readMultipartName(toks, i + 4);
        if (scope === 'schema' && target.parts[0] === 'dowel') return true;
        if (isDowelSchemaRef(target.parts)) return true;
      }
      const { parts } = readMultipartName(toks, i + 1);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }

    // 4. SELECT ... INTO [dowel].*（独立于 INSERT/UPDATE/DELETE）
    if (t.text === 'into') {
      const { parts } = readMultipartName(toks, i + 1);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }
  }

  // 5. 任何写 DML（INSERT / UPDATE / DELETE / MERGE / TRUNCATE，含 TOP / 别名 FROM / CTE）触及 [dowel].* 一律拦截
  if (hasWriteDml && hasDowelRef) return true;

  return false;
};

export const MSSQL_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用实例级/跨库/高危语句（USE / KILL / 跨库三段名 / DATABASE / LOGIN / SERVER ROLE / ENDPOINT / CREDENTIAL / LINKEDSERVER / sp_configure / xp_cmdshell / RECONFIGURE / SHUTDOWN / BACKUP / RESTORE / OPENROWSET / OPENDATASOURCE / BULK INSERT / 数据库或服务器级触发器）或修改 [dowel] 迁移历史对象';

export const mssqlFindInstanceLevelStatement = (sql: string): string | null => {
  for (const batch of splitMssqlBatches(sql, { expandRepeat: false })) {
    if (batchIsInstanceLevel(batch)) {
      return batch.trim().replace(/\s+/g, ' ').slice(0, 80);
    }
  }
  return null;
};
