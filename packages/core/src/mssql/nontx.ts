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
  for (const batch of splitMssqlBatches(sql)) {
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
]);

/** 读取多段限定名（如 `[master].[dbo].[xp_cmdshell]` 或 `dowel.history`），返回各段小写名与结束下标 */
const readMultipartName = (toks: Token[], start: number): { parts: string[]; next: number } => {
  const parts: string[] = [];
  let i = start;
  if (!isIdentToken(toks[i])) return { parts, next: i };
  parts.push(toks[i]!.text.toLowerCase());
  i++;
  while (toks[i]?.text === '.' && isIdentToken(toks[i + 1])) {
    parts.push(toks[i + 1]!.text.toLowerCase());
    i += 2;
  }
  return { parts, next: i };
};

/** 判断多段名是否指向 `[dowel]` schema 下的对象（2 段 `dowel.obj` 或 3 段 `db.dowel.obj`） */
const isDowelSchemaRef = (parts: string[]): boolean => {
  if (parts.length === 2) return parts[0] === 'dowel';
  if (parts.length >= 3) return parts[parts.length - 2] === 'dowel';
  return false;
};

/** 词法级检测一个批次内是否包含高危实例级语句或篡改 `[dowel]` schema 对象的语句 */
const batchIsInstanceLevel = (batch: string): boolean => {
  const toks = mssqlTokenize(batch).filter(isSignificant);
  if (toks.length === 0) return false;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind !== 'ident') continue;

    // 1. 独立高危关键字：RECONFIGURE / SHUTDOWN / BACKUP / RESTORE / OPENROWSET / OPENDATASOURCE / OPENQUERY / BULK INSERT
    if (
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

      // CREATE / ALTER / DROP TABLE|VIEW|TRIGGER|INDEX|SEQUENCE|PROCEDURE|PROC|FUNCTION [IF EXISTS] [dowel].[*]
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
        isWord(toks[k], 'function')
      ) {
        let nameIdx = k + 1;
        if (isWord(toks[nameIdx], 'if') && isWord(toks[nameIdx + 1], 'exists')) nameIdx += 2;
        const { parts } = readMultipartName(toks, nameIdx);
        if (isDowelSchemaRef(parts)) return true;
      }
      continue;
    }

    // 3. ON [dowel].*（如 CREATE TRIGGER/INDEX ... ON [dowel].[history] 或 DROP INDEX x ON [dowel].[history]）
    if (t.text === 'on') {
      const { parts } = readMultipartName(toks, i + 1);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }

    // 4. DML 篡改 [dowel].*：INSERT [INTO] / UPDATE / DELETE [FROM] / TRUNCATE TABLE / MERGE [INTO]
    if (t.text === 'insert' || t.text === 'merge') {
      let j = i + 1;
      if (isWord(toks[j], 'into')) j++;
      const { parts } = readMultipartName(toks, j);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }
    if (t.text === 'delete') {
      let j = i + 1;
      if (isWord(toks[j], 'from')) j++;
      const { parts } = readMultipartName(toks, j);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }
    if (t.text === 'update') {
      const { parts } = readMultipartName(toks, i + 1);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }
    if (t.text === 'truncate' && isWord(toks[i + 1], 'table')) {
      const { parts } = readMultipartName(toks, i + 2);
      if (isDowelSchemaRef(parts)) return true;
      continue;
    }

    // 5. EXEC / EXECUTE 调用高危存储过程，或对 dowel 对象调用 sp_rename
    if (t.text === 'exec' || t.text === 'execute') {
      let j = i + 1;
      // 跳过 `@rc = ` 返回值接收语法
      if (toks[j]?.kind === 'other' && toks[j]!.text.startsWith('@') && toks[j + 1]?.text === '=') {
        j += 2;
      }
      const { parts, next } = readMultipartName(toks, j);
      const procName = parts.at(-1);
      if (procName && DANGEROUS_PROCS.has(procName)) return true;
      if (procName === 'sp_rename') {
        const arg = toks[next];
        if (arg?.kind === 'other' && /(?:'|N')\[?dowel\]?\./i.test(arg.text)) return true;
      }
      continue;
    }

    // 6. 裸写危险扩展存储过程名（如独立批次直接写 `xp_cmdshell '...'` 或 `sp_configure ...`）
    if (DANGEROUS_PROCS.has(t.text)) return true;
  }
  return false;
};

export const MSSQL_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用实例级/高危语句（DATABASE / LOGIN / SERVER ROLE / ENDPOINT / CREDENTIAL / LINKEDSERVER / sp_configure / xp_cmdshell / RECONFIGURE / SHUTDOWN / BACKUP / RESTORE / OPENROWSET / OPENDATASOURCE / BULK INSERT）或修改 [dowel] 迁移历史对象';

export const mssqlFindInstanceLevelStatement = (sql: string): string | null => {
  for (const batch of splitMssqlBatches(sql)) {
    if (batchIsInstanceLevel(batch)) {
      return batch.trim().replace(/\s+/g, ' ').slice(0, 80);
    }
  }
  return null;
};
