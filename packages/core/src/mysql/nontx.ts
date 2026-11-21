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
  return /^\s*(?:create|alter|drop|truncate|rename|lock|unlock|load|analyze|optimize|repair|check|flush|reset|grant|revoke|install|uninstall|prepare|execute|deallocate|clone|import|start\s+transaction|begin|commit|rollback|set\s+autocommit|call)\b/i.test(
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

interface QualifiedTarget {
  name: string;
  qualified: boolean;
  next: number;
}

/** 读取 `[db.]<name>` 形式的对象名，返回对象本体名（小写）与是否带跨库前缀 */
const readQualifiedObj = (toks: Token[], start: number): QualifiedTarget | null => {
  const first = toks[start];
  if (!isIdentToken(first)) return null;
  if (toks[start + 1]?.text === '.' && isIdentToken(toks[start + 2])) {
    return { name: toks[start + 2]!.text.toLowerCase(), qualified: true, next: start + 3 };
  }
  return { name: first.text.toLowerCase(), qualified: false, next: start + 1 };
};

const isInternalName = (name: string | null): boolean =>
  !!name && (name.startsWith('dowel_') || name === MYSQL_SHADOW_MARK_TABLE);

/** 禁止跨库限定名（`db.obj`）以及任何 `dowel_*` / `__dowel_shadow_mark` 内部对象 */
const isForbiddenTarget = (target: QualifiedTarget | null): boolean =>
  target !== null && (target.qualified || isInternalName(target.name));

/** 跳过可选的 `IF [NOT] EXISTS` */
const skipIfExists = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'if')) return start;
  if (isWord(toks[start + 1], 'not') && isWord(toks[start + 2], 'exists')) return start + 3;
  if (isWord(toks[start + 1], 'exists')) return start + 2;
  return start;
};

/** 跳过 `DEFINER = CURRENT_USER[()] | user [@ host]` 子句（兼容点分 IP 与无引号主机名） */
const skipDefiner = (toks: Token[], start: number): number => {
  if (!isWord(toks[start], 'definer')) return start;
  let j = start + 1;
  if (toks[j]?.text === '=') j++;
  if (isWord(toks[j], 'current_user')) {
    j++;
    if (toks[j]?.text === '(' && toks[j + 1]?.text === ')') j += 2;
    return j;
  }
  if (j < toks.length) j++; // user
  if (toks[j]?.text === '@') {
    j++;
    if (j < toks.length) {
      j++; // host 首 token（引号字符串、反引号或无引号首字符/词）
      // 合并源码中紧邻无空白的后续 host token（如 `127.0.0.1`、`db-1.internal`）
      while (j < toks.length && toks[j]!.start === toks[j - 1]!.end) {
        j++;
      }
    }
  }
  return j;
};

/** 跳过括号对 `(...)` */
const skipBalancedParens = (toks: Token[], start: number): number => {
  if (toks[start]?.text !== '(') return start;
  let depth = 0;
  let j = start;
  while (j < toks.length) {
    if (toks[j]!.text === '(') depth++;
    else if (toks[j]!.text === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
};

const CLAUSE_END_WORDS = new Set([
  'where',
  'set',
  'order',
  'group',
  'having',
  'limit',
  'union',
  'except',
  'intersect',
  'into',
  'values',
  'for',
  'lock',
  'on',
  'using',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'natural',
  'straight_join',
  'window',
  'end',
]);

/** 扫描 `FROM` / `UPDATE` / `USING` 后的表引用列表（含逗号分隔多表），阻断跨库与内部对象 */
const scanTableRefList = (toks: Token[], start: number): boolean => {
  let pos = start;
  while (pos < toks.length) {
    if (toks[pos]?.text === '(' || isWord(toks[pos], 'select')) break;
    const target = readQualifiedObj(toks, pos);
    if (!target) break;
    if (isForbiddenTarget(target)) return true;
    pos = target.next;

    // 跳过可选 PARTITION (...)、别名与索引提示
    if (isWord(toks[pos], 'partition') && toks[pos + 1]?.text === '(') {
      pos = skipBalancedParens(toks, pos + 1);
    }
    if (isWord(toks[pos], 'as') && isIdentToken(toks[pos + 1])) {
      pos += 2;
    } else if (isIdentToken(toks[pos]) && !CLAUSE_END_WORDS.has(toks[pos]!.text.toLowerCase())) {
      pos++;
    }
    while (
      (isWord(toks[pos], 'use') || isWord(toks[pos], 'force') || isWord(toks[pos], 'ignore')) &&
      (isWord(toks[pos + 1], 'index') || isWord(toks[pos + 1], 'key'))
    ) {
      pos += 2;
      if (isWord(toks[pos], 'for')) {
        pos++;
        if (isWord(toks[pos], 'join')) pos++;
        else if (isWord(toks[pos], 'order') || isWord(toks[pos], 'group')) {
          pos++;
          if (isWord(toks[pos], 'by')) pos++;
        }
      }
      if (toks[pos]?.text === '(') pos = skipBalancedParens(toks, pos);
    }

    if (toks[pos]?.text === ',') {
      pos++;
      continue;
    }
    break;
  }
  return false;
};

/** 判断 token 索引是否位于顶层或触发器/例程复合块内的语句起点 */
const isStmtStart = (toks: Token[], i: number, head: number): boolean => {
  if (i === head) return true;
  const prev = toks[i - 1];
  if (!prev) return false;
  if (prev.text === ';' || prev.text === ':') return true;
  if (
    isWord(prev, 'begin') ||
    isWord(prev, 'then') ||
    isWord(prev, 'else') ||
    isWord(prev, 'do') ||
    isWord(prev, 'loop') ||
    isWord(prev, 'repeat')
  ) {
    return true;
  }
  if (isWord(prev, 'row') && isWord(toks[i - 2], 'each') && isWord(toks[i - 3], 'for')) return true;
  return false;
};

const SET_STOP_WORDS = new Set(['where', 'end', 'from', 'order', 'limit', 'group', 'having', 'returning']);

/** 扫描 `SET` 子句（支持多赋值逗号列表与复合块内 `SET`）是否触及 GLOBAL / PERSIST / PERSIST_ONLY / ROLE / PASSWORD */
const isDangerousSet = (toks: Token[], setIdx: number): boolean => {
  // 排除 CHARACTER SET / CHAR SET
  const prev = toks[setIdx - 1];
  if (isWord(prev, 'character') || isWord(prev, 'char')) return false;

  const second = toks[setIdx + 1];
  if (
    isWord(second, 'role') ||
    isWord(second, 'password') ||
    (isWord(second, 'default') && isWord(toks[setIdx + 2], 'role'))
  ) {
    return true;
  }

  let depth = 0;
  let atItemStart = true;
  for (let k = setIdx + 1; k < toks.length; k++) {
    const tk = toks[k]!;
    if (tk.text === '(') {
      depth++;
      atItemStart = false;
      continue;
    }
    if (tk.text === ')') {
      if (depth === 0) break;
      depth--;
      atItemStart = false;
      continue;
    }
    if (depth === 0) {
      if (tk.text === ';' || (tk.kind === 'ident' && SET_STOP_WORDS.has(tk.text))) break;
      if (tk.text === ',') {
        atItemStart = true;
        continue;
      }
      if (
        atItemStart &&
        (isWord(tk, 'global') || isWord(tk, 'persist') || isWord(tk, 'persist_only')) &&
        isIdentToken(toks[k + 1])
      ) {
        return true;
      }
    }
    if (tk.text === '@' && toks[k + 1]?.text === '@') {
      const scope = toks[k + 2];
      if (isWord(scope, 'global') || isWord(scope, 'persist') || isWord(scope, 'persist_only')) return true;
    }
    atItemStart = false;
  }
  return false;
};

/**
 * 词法级检测 MySQL 实例级 / 高危 / 跨库 / 篡改内部表语句（免疫注释、条件注释 `/*!...*\/` 与触发器/例程复合块藏匿）：
 * - CREATE / DROP / ALTER DATABASE | SCHEMA | USER | ROLE | EVENT | TABLESPACE | UNDO TABLESPACE | SERVER | LOGFILE GROUP | RESOURCE GROUP
 * - ALTER INSTANCE / RENAME USER / GRANT / REVOKE
 * - SET GLOBAL / PERSIST / PERSIST_ONLY / @@GLOBAL / @@PERSIST / ROLE / DEFAULT ROLE / PASSWORD（含多变量赋值）
 * - PREPARE / EXECUTE / DEALLOCATE PREPARE、CLONE、IMPORT TABLE
 * - INSTALL / UNINSTALL PLUGIN | COMPONENT
 * - FLUSH / RESET / SHUTDOWN / RESTART / KILL / PURGE / BINLOG / CHANGE REPLICATION / START|STOP REPLICA|SLAVE
 * - LOAD DATA / LOAD XML / SELECT ... INTO OUTFILE | DUMPFILE / USE <db>
 * - 任何显式跨库限定 `db.obj` 或三段 `db.tbl.col` 引用
 * - 任何触碰 `dowel_*` 或 `__dowel_shadow_mark` 内部对象的语句
 */
const statementIsInstanceLevel = (stmt: string): boolean => {
  const toks = mysqlTokenize(stmt).filter(isSignificant);
  if (toks.length === 0) return false;

  // 1. 全流拦截任意位置的 `__dowel_shadow_mark` 哨兵表标识符
  for (const t of toks) {
    if (isIdentToken(t) && t.text.toLowerCase() === MYSQL_SHADOW_MARK_TABLE) return true;
  }

  // 2. 全流拦截三段跨库列引用 `db.tbl.col`
  for (let i = 0; i + 4 < toks.length; i++) {
    if (
      isIdentToken(toks[i]) &&
      toks[i + 1]?.text === '.' &&
      isIdentToken(toks[i + 2]) &&
      toks[i + 3]?.text === '.' &&
      isIdentToken(toks[i + 4])
    ) {
      return true;
    }
  }

  let head = 0;
  if (isWord(toks[head], 'explain') || isWord(toks[head], 'describe') || isWord(toks[head], 'desc')) {
    head++;
    if (isWord(toks[head], 'analyze')) head++;
  }
  if (!toks[head]) return false;

  // 追踪括号是否属于子查询 `(SELECT ...)` / `(WITH ...)`, 避免 EXTRACT(... FROM a.b) / TRIM(... FROM a.b) 误报
  const parenIsQuery: boolean[] = [];
  const inTableClauseContext = (): boolean =>
    parenIsQuery.length === 0 || parenIsQuery[parenIsQuery.length - 1] === true;

  for (let i = head; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.text === '(') {
      const nxt = toks[i + 1];
      parenIsQuery.push(isWord(nxt, 'select') || isWord(nxt, 'with') || nxt?.text === '(');
      continue;
    }
    if (t.text === ')') {
      parenIsQuery.pop();
      continue;
    }
    if (t.kind !== 'ident') continue;

    const atStart = isStmtStart(toks, i, head);

    // ─── 全流实例级与高危控制命令 ───
    if (t.text === 'create' || t.text === 'drop' || t.text === 'alter') {
      let j = i + 1;
      if (t.text === 'create' && isWord(toks[j], 'or') && isWord(toks[j + 1], 'replace')) j += 2;
      if ((t.text === 'create' || t.text === 'drop') && isWord(toks[j], 'temporary')) j++;
      if (
        t.text === 'create' &&
        (isWord(toks[j], 'unique') || isWord(toks[j], 'fulltext') || isWord(toks[j], 'spatial'))
      ) {
        j++;
      }
      j = skipDefiner(toks, j);
      if (isWord(toks[j], 'algorithm') && toks[j + 1]?.text === '=') j += 3;
      j = skipDefiner(toks, j);
      if (isWord(toks[j], 'sql') && isWord(toks[j + 1], 'security')) j += 3;
      j = skipDefiner(toks, j);

      const kw = toks[j];
      if (
        isWord(kw, 'database') ||
        isWord(kw, 'schema') ||
        isWord(kw, 'user') ||
        isWord(kw, 'role') ||
        isWord(kw, 'event') ||
        isWord(kw, 'tablespace') ||
        isWord(kw, 'server') ||
        (t.text === 'alter' && isWord(kw, 'instance')) ||
        (isWord(kw, 'undo') && isWord(toks[j + 1], 'tablespace')) ||
        (isWord(kw, 'logfile') && isWord(toks[j + 1], 'group')) ||
        (isWord(kw, 'resource') && isWord(toks[j + 1], 'group'))
      ) {
        return true;
      }

      if (t.text === 'drop') {
        if (
          isWord(kw, 'table') ||
          isWord(kw, 'trigger') ||
          isWord(kw, 'index') ||
          isWord(kw, 'view') ||
          isWord(kw, 'procedure') ||
          isWord(kw, 'function')
        ) {
          let pos = skipIfExists(toks, j + 1);
          for (;;) {
            const target = readQualifiedObj(toks, pos);
            if (isForbiddenTarget(target)) return true;
            if (!target) break;
            pos = target.next;
            if (isWord(kw, 'index') && isWord(toks[pos], 'on')) {
              if (isForbiddenTarget(readQualifiedObj(toks, pos + 1))) return true;
              break;
            }
            if (isWord(kw, 'table') && toks[pos]?.text === ',') {
              pos++;
              continue;
            }
            break;
          }
        }
        continue;
      }

      if (t.text === 'alter') {
        if (isWord(kw, 'table') || isWord(kw, 'view') || isWord(kw, 'procedure') || isWord(kw, 'function')) {
          const target = readQualifiedObj(toks, j + 1);
          if (isForbiddenTarget(target)) return true;
          // ALTER TABLE <t> RENAME [TO|AS] <newT>
          if (isWord(kw, 'table') && target) {
            for (let k = target.next; k < toks.length && toks[k]!.text !== ';'; k++) {
              if (
                isWord(toks[k], 'rename') &&
                (isWord(toks[k + 1], 'to') || isWord(toks[k + 1], 'as')) &&
                !isWord(toks[k - 1], 'column') &&
                !isWord(toks[k - 1], 'index')
              ) {
                if (isForbiddenTarget(readQualifiedObj(toks, k + 2))) return true;
              }
            }
          }
        }
        continue;
      }

      // CREATE TABLE / TRIGGER / INDEX / VIEW / PROCEDURE / FUNCTION
      if (
        isWord(kw, 'table') ||
        isWord(kw, 'trigger') ||
        isWord(kw, 'index') ||
        isWord(kw, 'view') ||
        isWord(kw, 'procedure') ||
        isWord(kw, 'function')
      ) {
        const target = readQualifiedObj(toks, skipIfExists(toks, j + 1));
        if (isForbiddenTarget(target)) return true;
        if (target && isWord(kw, 'table')) {
          // CREATE TABLE t LIKE other_tbl / CREATE TABLE t (LIKE other_tbl)
          let p = target.next;
          if (toks[p]?.text === '(') p++;
          if (isWord(toks[p], 'like')) {
            if (isForbiddenTarget(readQualifiedObj(toks, p + 1))) return true;
          }
        }
        if (target && (isWord(kw, 'index') || isWord(kw, 'trigger'))) {
          for (let k = target.next; k < toks.length && toks[k]!.text !== ';'; k++) {
            if (isWord(toks[k], 'on')) {
              if (isForbiddenTarget(readQualifiedObj(toks, k + 1))) return true;
              break;
            }
            if (isWord(toks[k], 'begin')) break;
          }
        }
      }
      continue;
    }

    if (t.text === 'rename') {
      if (isWord(toks[i + 1], 'user')) return true;
      if (isWord(toks[i + 1], 'table')) {
        let j = i + 2;
        while (j < toks.length) {
          const src = readQualifiedObj(toks, j);
          if (isForbiddenTarget(src)) return true;
          if (!src) break;
          j = src.next;
          if (isWord(toks[j], 'to')) {
            const dst = readQualifiedObj(toks, j + 1);
            if (isForbiddenTarget(dst)) return true;
            if (!dst) break;
            j = dst.next;
          }
          if (toks[j]?.text === ',') j++;
          else break;
        }
      }
      continue;
    }

    if (atStart && (t.text === 'grant' || t.text === 'revoke')) return true;
    if (
      (t.text === 'install' || t.text === 'uninstall') &&
      (isWord(toks[i + 1], 'plugin') || isWord(toks[i + 1], 'component'))
    ) {
      return true;
    }
    if (
      atStart &&
      (t.text === 'flush' ||
        t.text === 'reset' ||
        t.text === 'shutdown' ||
        t.text === 'restart' ||
        t.text === 'kill' ||
        t.text === 'purge' ||
        t.text === 'binlog')
    ) {
      return true;
    }
    if (atStart && t.text === 'use' && !isWord(toks[i + 1], 'index') && !isWord(toks[i + 1], 'key')) {
      return true;
    }
    if (
      (t.text === 'start' || t.text === 'stop' || t.text === 'change') &&
      (isWord(toks[i + 1], 'replica') ||
        isWord(toks[i + 1], 'slave') ||
        isWord(toks[i + 1], 'replication') ||
        isWord(toks[i + 1], 'master'))
    ) {
      return true;
    }
    if (t.text === 'load' && (isWord(toks[i + 1], 'data') || isWord(toks[i + 1], 'xml'))) return true;
    if (t.text === 'into' && (isWord(toks[i + 1], 'outfile') || isWord(toks[i + 1], 'dumpfile'))) return true;
    if (t.text === 'clone' && (isWord(toks[i + 1], 'local') || isWord(toks[i + 1], 'instance'))) return true;
    if (t.text === 'import' && isWord(toks[i + 1], 'table')) return true;
    if (t.text === 'deallocate' && isWord(toks[i + 1], 'prepare')) return true;
    if (t.text === 'prepare' && (atStart || (isIdentToken(toks[i + 1]) && isWord(toks[i + 2], 'from')))) {
      return true;
    }
    if (atStart && t.text === 'execute') return true;

    if (t.text === 'set' && isDangerousSet(toks, i)) return true;

    // ─── DDL / DML 跨库与内部表目标检查 ───
    if (t.text === 'truncate') {
      const j = isWord(toks[i + 1], 'table') ? i + 2 : i + 1;
      if (isForbiddenTarget(readQualifiedObj(toks, j))) return true;
      continue;
    }

    if (atStart && t.text === 'call') {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }

    if (atStart && t.text === 'lock' && (isWord(toks[i + 1], 'table') || isWord(toks[i + 1], 'tables'))) {
      if (scanTableRefList(toks, i + 2)) return true;
      continue;
    }

    if (t.text === 'references') {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }

    if (t.text === 'update') {
      let j = i + 1;
      while (isWord(toks[j], 'low_priority') || isWord(toks[j], 'ignore')) j++;
      if (scanTableRefList(toks, j)) return true;
      continue;
    }

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
      if (isForbiddenTarget(readQualifiedObj(toks, j))) return true;
      continue;
    }

    if (t.text === 'from' && inTableClauseContext()) {
      if (scanTableRefList(toks, i + 1)) return true;
      continue;
    }

    if (t.text === 'join') {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }

    if (t.text === 'using' && inTableClauseContext() && toks[i + 1]?.text !== '(') {
      if (scanTableRefList(toks, i + 1)) return true;
      continue;
    }

    if (t.text === 'into' && !isWord(toks[i - 1], 'insert') && !isWord(toks[i - 1], 'replace')) {
      const target = readQualifiedObj(toks, i + 1);
      if (target && isInternalName(target.name)) return true;
      continue;
    }

    if (t.text === 'like') {
      const target = readQualifiedObj(toks, i + 1);
      if (target && isInternalName(target.name)) return true;
      continue;
    }
  }

  return false;
};

export const MYSQL_INSTANCE_LEVEL_DESCRIPTION =
  '不允许在迁移或 SQL 导入中使用实例级/高危/跨库 MySQL 语句（DATABASE/SCHEMA、USER/ROLE、EVENT、GRANT/REVOKE、SET GLOBAL/PERSIST、PREPARE/EXECUTE、ALTER INSTANCE、UNDO TABLESPACE、CLONE、IMPORT TABLE、INSTALL/UNINSTALL PLUGIN|COMPONENT、FLUSH/RESET/SHUTDOWN、LOAD DATA、INTO OUTFILE/DUMPFILE、USE、跨库限定 db.obj 或访问 dowel_* / __dowel_shadow_mark 内部对象）';

export const mysqlFindInstanceLevelStatement = (sql: string): string | null => {
  const hit = splitMysqlStatements(sql).find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};
