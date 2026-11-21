// MySQL 非事务语句（DDL 隐式提交）与实例级高危语句检测（纯函数，前后端共用）。
import type { Token } from '../plan-types.ts';
import { MYSQL_SHADOW_MARK_TABLE } from './naming.ts';
import { MYSQL_KEYWORDS, mysqlTokenize, splitMysqlStatements, stripMysqlSql } from './quote.ts';

/**
 * MySQL 中会触发隐式提交或不能包进外层事务的语句：
 * 所有 DDL（CREATE / ALTER / DROP / TRUNCATE / RENAME）以及管理/锁/事务控制语句。
 */
const statementIsNontransactional = (s: string): boolean => {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return /^\s*(?:create|alter|drop|truncate|rename|lock|unlock|load|analyze|optimize|repair|check|checksum|flush|reset|grant|revoke|install|uninstall|prepare|execute|deallocate|clone|import|xa|start\s+transaction|begin|commit|rollback|set\s+autocommit|call)\b/i.test(
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

const isStringLiteral = (t: Token | undefined): boolean =>
  !!t && t.kind === 'other' && (t.text.startsWith("'") || t.text.startsWith('"'));

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

/**
 * 跳过 `DEFINER = CURRENT_USER[()] | user [@ host]` 子句：
 * 仅当 host 首 token 为无引号形式（如 `127.0.0.1`、`db-1.internal`）时合并紧邻片段；
 * 引号字符串（`'%'`）与反引号标识符（`` `localhost` ``）立即停止，防止吞掉紧邻的 `EVENT`/`VIEW`/`TRIGGER` 关键字。
 */
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
    const hostFirst = toks[j];
    if (hostFirst) {
      j++;
      const isQuotedHost = hostFirst.kind === 'qident' || isStringLiteral(hostFirst);
      if (!isQuotedHost) {
        while (j < toks.length && toks[j]!.start === toks[j - 1]!.end) {
          j++;
        }
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

const JOIN_LEAD_WORDS = new Set([
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'natural',
  'straight_join',
]);

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
  'window',
  'end',
  ...JOIN_LEAD_WORDS,
]);

const ON_EXPR_STOP_WORDS = new Set([
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
  'window',
  'end',
  ...JOIN_LEAD_WORDS,
]);

/**
 * 扫描 `FROM` / `UPDATE` / `USING` / `JOIN` / `LOCK TABLES` 后的表引用列表：
 * - 支持逗号分隔多表；
 * - 穿过括号表引用 `(tbl ...)`（如 `UPDATE (dowel_claims) SET ...`、`SELECT * FROM (prod.users)`）；
 * - 穿过 `JOIN ... [ON expr | USING (...)]` 与 `STRAIGHT_JOIN` 继续扫描后续 `, tbl`；
 * - 遇到子查询 `(SELECT ...)` / `(WITH ...)` 时跳过整段括号（由外层主循环扫描子查询内部的 `FROM`）并继续扫描后续 `, tbl` / `JOIN`。
 */
const scanTableRefList = (toks: Token[], start: number): boolean => {
  let pos = start;
  let parenNest = 0;

  const skipOptionalTableTail = () => {
    if (isWord(toks[pos], 'partition') && toks[pos + 1]?.text === '(') {
      pos = skipBalancedParens(toks, pos + 1);
    }
    let hasAlias = false;
    if (isWord(toks[pos], 'as') && isIdentToken(toks[pos + 1])) {
      pos += 2;
      hasAlias = true;
    } else if (isIdentToken(toks[pos]) && !CLAUSE_END_WORDS.has(toks[pos]!.text.toLowerCase())) {
      pos++;
      hasAlias = true;
    }
    if (hasAlias && toks[pos]?.text === '(') {
      pos = skipBalancedParens(toks, pos);
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
  };

  while (pos < toks.length) {
    let handledSubquery = false;
    // 跳过表因子外层多余括号（如 `UPDATE (dowel_claims) SET ...`、`FROM (prod.users)`）及 `LATERAL (...)`
    if (isWord(toks[pos], 'lateral') && toks[pos + 1]?.text === '(') {
      pos++;
    }
    while (toks[pos]?.text === '(') {
      const nxt = toks[pos + 1];
      if (isWord(nxt, 'select') || isWord(nxt, 'with') || isWord(nxt, 'values') || isWord(nxt, 'table')) {
        pos = skipBalancedParens(toks, pos);
        skipOptionalTableTail();
        handledSubquery = true;
        break;
      }
      parenNest++;
      pos++;
    }

    if (!handledSubquery) {
      const target = readQualifiedObj(toks, pos);
      if (!target) break;
      if (isForbiddenTarget(target)) return true;
      pos = target.next;
      if (toks[pos]?.text === '(') {
        pos = skipBalancedParens(toks, pos);
      }
      skipOptionalTableTail();
    }

    // 消耗表因子后的 `ON <expr>` / `USING (...)` / 闭合括号 / `JOIN` / `,`
    for (;;) {
      while (parenNest > 0 && toks[pos]?.text === ')') {
        parenNest--;
        pos++;
        skipOptionalTableTail();
      }
      if (isWord(toks[pos], 'on')) {
        pos++;
        let depth = 0;
        while (pos < toks.length) {
          const tk = toks[pos]!;
          if (tk.text === '(') depth++;
          else if (tk.text === ')') {
            if (depth === 0) break;
            depth--;
          } else if (depth === 0) {
            if (tk.text === ';' || tk.text === ',') break;
            if (tk.kind === 'ident' && ON_EXPR_STOP_WORDS.has(tk.text)) break;
          }
          pos++;
        }
        continue;
      }
      if (isWord(toks[pos], 'using') && toks[pos + 1]?.text === '(') {
        pos = skipBalancedParens(toks, pos + 1);
        continue;
      }
      break;
    }

    if (toks[pos]?.text === ',') {
      pos++;
      continue;
    }

    // `JOIN` / `LEFT [OUTER] JOIN` / `RIGHT [OUTER] JOIN` / `INNER JOIN` / `CROSS JOIN` / `NATURAL [LEFT|RIGHT] [OUTER] JOIN` / `STRAIGHT_JOIN`
    if (toks[pos]?.kind === 'ident' && JOIN_LEAD_WORDS.has(toks[pos]!.text)) {
      let j = pos;
      while (
        isWord(toks[j], 'natural') ||
        isWord(toks[j], 'left') ||
        isWord(toks[j], 'right') ||
        isWord(toks[j], 'inner') ||
        isWord(toks[j], 'outer') ||
        isWord(toks[j], 'cross')
      ) {
        j++;
      }
      if (isWord(toks[j], 'join') || isWord(toks[j], 'straight_join')) {
        pos = j + 1;
        continue;
      }
    }

    break;
  }
  return false;
};

/** 扫描 `LOCK TABLE[S] t1 [[AS] alias] READ [LOCAL] | [LOW_PRIORITY] WRITE, t2 ...` */
const scanLockTablesList = (toks: Token[], start: number): boolean => {
  let pos = start;
  while (pos < toks.length) {
    const target = readQualifiedObj(toks, pos);
    if (!target) break;
    if (isForbiddenTarget(target)) return true;
    pos = target.next;
    if (isWord(toks[pos], 'as') && isIdentToken(toks[pos + 1])) {
      pos += 2;
    } else if (
      isIdentToken(toks[pos]) &&
      !isWord(toks[pos], 'read') &&
      !isWord(toks[pos], 'write') &&
      !isWord(toks[pos], 'low_priority')
    ) {
      pos++;
    }
    if (isWord(toks[pos], 'read')) {
      pos++;
      if (isWord(toks[pos], 'local')) pos++;
    } else {
      if (isWord(toks[pos], 'low_priority')) pos++;
      if (isWord(toks[pos], 'write')) pos++;
    }
    if (toks[pos]?.text === ',') {
      pos++;
      continue;
    }
    break;
  }
  return false;
};

/** 扫描逗号分隔的表名列表（用于 `ANALYZE|OPTIMIZE|REPAIR|CHECK|CHECKSUM TABLE t1, t2`） */
const scanCommaTableList = (toks: Token[], start: number): boolean => {
  let pos = start;
  while (pos < toks.length) {
    const target = readQualifiedObj(toks, pos);
    if (!target) break;
    if (isForbiddenTarget(target)) return true;
    pos = target.next;
    if (toks[pos]?.text === ',') {
      pos++;
      continue;
    }
    break;
  }
  return false;
};

/** 判断 token 索引是否位于顶层、触发器/例程复合块、`FOLLOWS`/`PRECEDES` 或 `DECLARE ... HANDLER` 后的语句起点 */
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
    isWord(prev, 'repeat') ||
    isWord(prev, 'sqlexception') ||
    isWord(prev, 'sqlwarning')
  ) {
    return true;
  }
  if (isWord(prev, 'found') && isWord(toks[i - 2], 'not')) return true;
  if (isWord(prev, 'row') && isWord(toks[i - 2], 'each') && isWord(toks[i - 3], 'for')) return true;
  if (isIdentToken(prev) && (isWord(toks[i - 2], 'follows') || isWord(toks[i - 2], 'precedes'))) return true;
  return false;
};

const SAFE_SQL_MODES = new Set([
  'allow_invalid_dates',
  'error_for_division_by_zero',
  'high_not_precedence',
  'ignore_space',
  'no_auto_value_on_zero',
  'no_dir_in_create',
  'no_engine_substitution',
  'no_unsigned_subtraction',
  'no_zero_date',
  'no_zero_in_date',
  'only_full_group_by',
  'pad_char_to_full_length',
  'pipes_as_concat',
  'real_as_float',
  'strict_all_tables',
  'strict_trans_tables',
  'time_truncate_fractional',
  'traditional',
]);

const decodeSingleQuoted = (raw: string): string | null => {
  if (raw.length < 2 || raw[0] !== "'" || raw[raw.length - 1] !== "'") return null;
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === '\\') {
      if (i + 1 >= inner.length) return null;
      out += inner[++i]!;
    } else if (ch === "'" && inner[i + 1] === "'") {
      out += "'";
      i++;
    } else {
      out += ch;
    }
  }
  return out;
};

/** 校验 `SET [SESSION|LOCAL] sql_mode = <rhs>` 的右值是否属于静态安全白名单 */
const isSafeSqlModeRhs = (rhs: Token[]): boolean => {
  if (rhs.length !== 1) return false;
  const only = rhs[0]!;
  if (only.kind === 'ident') {
    const low = only.text.toLowerCase();
    return low === 'default' || SAFE_SQL_MODES.has(low);
  }
  if (only.kind === 'other' && only.text.startsWith("'") && only.text.endsWith("'")) {
    const decoded = decodeSingleQuoted(only.text);
    if (decoded === null) return false;
    const items = decoded
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    return items.every((m) => SAFE_SQL_MODES.has(m));
  }
  return false;
};

const SET_STOP_WORDS = new Set(['where', 'end', 'from', 'order', 'limit', 'group', 'having', 'returning']);

/**
 * 扫描 `SET` 子句（支持多赋值逗号列表与复合块内 `SET`）：
 * - 阻断 `GLOBAL` / `PERSIST` / `PERSIST_ONLY` / `@@global` / `@@persist` / `@@persist_only`
 * - 阻断 `SET ROLE` / `SET DEFAULT ROLE` / `SET PASSWORD` / `SET RESOURCE GROUP`
 * - 严格约束 `sql_mode` 赋值（`[SESSION|LOCAL] sql_mode` / `@@[session.|local.]sql_mode`），仅放行静态安全白名单
 */
const isDangerousSet = (toks: Token[], setIdx: number): boolean => {
  const prev = toks[setIdx - 1];
  if (
    prev?.text === '.' ||
    isWord(prev, 'character') ||
    isWord(prev, 'char') ||
    isWord(prev, 'delete') ||
    isWord(prev, 'update')
  ) {
    return false;
  }

  const second = toks[setIdx + 1];
  if (second?.text === '(') return false;
  if (
    isWord(second, 'role') ||
    isWord(second, 'password') ||
    (isWord(second, 'default') && isWord(toks[setIdx + 2], 'role')) ||
    (isWord(second, 'resource') && isWord(toks[setIdx + 2], 'group'))
  ) {
    return true;
  }

  let depth = 0;
  let itemStartIdx = setIdx + 1;

  const checkItem = (start: number, end: number): boolean => {
    if (start >= end) return false;
    let p = start;
    // GLOBAL / PERSIST / PERSIST_ONLY <var>
    if (
      (isWord(toks[p], 'global') || isWord(toks[p], 'persist') || isWord(toks[p], 'persist_only')) &&
      isIdentToken(toks[p + 1])
    ) {
      return true;
    }

    // 解析目标变量名，判断是否针对 sql_mode
    let targetVar: string | null = null;
    if (toks[p]?.text === '@' && toks[p + 1]?.text === '@') {
      p += 2;
      if (isWord(toks[p], 'global') || isWord(toks[p], 'persist') || isWord(toks[p], 'persist_only')) {
        return true;
      }
      if ((isWord(toks[p], 'session') || isWord(toks[p], 'local')) && toks[p + 1]?.text === '.') {
        p += 2;
      }
      if (isIdentToken(toks[p])) {
        targetVar = toks[p]!.text.toLowerCase();
        p++;
      }
    } else {
      if (isWord(toks[p], 'session') || isWord(toks[p], 'local')) p++;
      if (isIdentToken(toks[p])) {
        targetVar = toks[p]!.text.toLowerCase();
        p++;
      }
    }

    if (targetVar === 'sql_mode') {
      if (toks[p]?.text === ':' && toks[p + 1]?.text === '=') p += 2;
      else if (toks[p]?.text === '=') p += 1;
      else return true;
      const rhs = toks.slice(p, end);
      if (!isSafeSqlModeRhs(rhs)) return true;
    }

    return false;
  };

  let k = setIdx + 1;
  for (; k < toks.length; k++) {
    const tk = toks[k]!;
    if (tk.text === '(') {
      depth++;
      continue;
    }
    if (tk.text === ')') {
      if (depth === 0) break;
      depth--;
      continue;
    }
    if (tk.text === '@' && toks[k + 1]?.text === '@') {
      const scope = toks[k + 2];
      if (isWord(scope, 'global') || isWord(scope, 'persist') || isWord(scope, 'persist_only')) return true;
    }
    if (depth === 0) {
      if (tk.text === ';' || (tk.kind === 'ident' && SET_STOP_WORDS.has(tk.text))) break;
      if (tk.text === ',') {
        if (checkItem(itemStartIdx, k)) return true;
        itemStartIdx = k + 1;
      }
    }
  }
  if (checkItem(itemStartIdx, k)) return true;
  return false;
};

/** 拦截优化器提示 `/*+ ... SET_VAR(sql_mode = ...) ... *\/` */
const hasDangerousOptimizerHint = (rawToks: Token[]): boolean => {
  for (const t of rawToks) {
    if (t.kind !== 'other' || !t.text.startsWith('/*+')) continue;
    const body = t.text.slice(3, t.text.endsWith('*/') ? -2 : t.text.length);
    const inner = mysqlTokenize(body).filter(isSignificant);
    for (let i = 0; i < inner.length; i++) {
      if (!isWord(inner[i], 'set_var') || inner[i + 1]?.text !== '(') continue;
      let depth = 0;
      for (let j = i + 1; j < inner.length; j++) {
        const tk = inner[j]!;
        if (tk.text === '(') depth++;
        else if (tk.text === ')') {
          depth--;
          if (depth === 0) break;
        } else if (isIdentToken(tk) && tk.text.toLowerCase() === 'sql_mode') {
          return true;
        }
      }
    }
  }
  return false;
};

const FROM_ARG_FUNCS = new Set(['trim', 'extract', 'substring', 'substr', 'position', 'weight_string']);
const FLUSH_TARGETS = new Set([
  'privileges',
  'table',
  'tables',
  'logs',
  'binary',
  'engine',
  'error',
  'general',
  'relay',
  'slow',
  'hosts',
  'optimizer_costs',
  'status',
  'user_resources',
]);
const RESET_TARGETS = new Set(['persist', 'master', 'slave', 'replica', 'binary', 'query']);
const XA_SUBCOMMANDS = new Set(['start', 'begin', 'end', 'prepare', 'commit', 'rollback', 'recover']);
const SELECT_MODIFIER_PREVS = new Set([
  'select',
  'distinct',
  'distinctrow',
  'all',
  'high_priority',
  'sql_small_result',
  'sql_big_result',
  'sql_buffer_result',
  'sql_no_cache',
  'sql_calc_found_rows',
]);
const NON_STMT_PREVS = new Set(['.', 'as', ',', '(', '=', ':=', 'set', 'select']);

/**
 * 词法级检测 MySQL 实例级 / 高危 / 跨库 / 篡改内部表语句（免疫注释、条件注释 `/*!...*\/`、优化器提示 `/*+...*\/` 与触发器/例程复合块藏匿）：
 * - CREATE / DROP / ALTER DATABASE | SCHEMA | USER | ROLE | EVENT | TABLESPACE | UNDO TABLESPACE | SERVER | LOGFILE GROUP | RESOURCE GROUP
 * - ALTER INSTANCE / RENAME USER / GRANT / REVOKE / XA
 * - SET GLOBAL / PERSIST / PERSIST_ONLY / @@GLOBAL / @@PERSIST / ROLE / DEFAULT ROLE / PASSWORD / RESOURCE GROUP、危险 `sql_mode` 与 `/*+ SET_VAR(sql_mode=...) *\/`
 * - PREPARE / EXECUTE / DEALLOCATE PREPARE、CLONE、IMPORT TABLE
 * - INSTALL / UNINSTALL PLUGIN | COMPONENT
 * - FLUSH / RESET / SHUTDOWN / RESTART / KILL / PURGE / BINLOG / CHANGE REPLICATION / START|STOP REPLICA|SLAVE
 * - LOAD DATA / LOAD XML / SELECT ... INTO OUTFILE | DUMPFILE / USE <db>
 * - 任何显式跨库限定 `db.obj`、跨库函数调用 `db.fn(...)`、三段 `db.tbl.col` / `db.tbl.*`、`TABLE db.obj`
 * - 任何触碰 `dowel_*` 或 `__dowel_shadow_mark` 内部对象的语句
 */
const statementIsInstanceLevel = (stmt: string): boolean => {
  const rawToks = mysqlTokenize(stmt);
  if (hasDangerousOptimizerHint(rawToks)) return true;

  const toks = rawToks.filter(isSignificant);
  if (toks.length === 0) return false;

  // 1. 全流拦截任意位置的 `__dowel_shadow_mark` 哨兵表标识符
  for (const t of toks) {
    if (isIdentToken(t) && t.text.toLowerCase() === MYSQL_SHADOW_MARK_TABLE) return true;
  }

  // 2. 全流拦截三段跨库引用（`db.tbl.col` / `db.tbl.*`）、`dowel_*.*` 以及跨库函数调用 `db.fn(`
  for (let i = 0; i < toks.length; i++) {
    if (!isIdentToken(toks[i])) continue;
    if (toks[i + 1]?.text === '.' && toks[i + 2]?.text === '*') {
      if (isInternalName(toks[i]!.text.toLowerCase())) return true;
    }
    if (toks[i + 1]?.text === '.' && isIdentToken(toks[i + 2])) {
      if (toks[i + 3]?.text === '.' && (isIdentToken(toks[i + 4]) || toks[i + 4]?.text === '*')) {
        return true;
      }
      if (toks[i + 3]?.text === '(' && toks[i - 1]?.text !== '@') {
        return true;
      }
    }
  }

  let head = 0;
  if (isWord(toks[head], 'explain') || isWord(toks[head], 'describe') || isWord(toks[head], 'desc')) {
    head++;
    if (isWord(toks[head], 'analyze')) head++;
  }
  if (!toks[head]) return false;

  // 精确追踪 `TRIM` / `EXTRACT` / `SUBSTRING` / `SUBSTR` / `POSITION` / `WEIGHT_STRING` 括号，避免其内部 `FROM` 误报
  const parenKind: ('query' | 'from_func' | 'other')[] = [];
  let inUpdateStmt = false;

  for (let i = head; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.text === '(') {
      const prev = toks[i - 1];
      const nxt = toks[i + 1];
      if (isWord(nxt, 'select') || isWord(nxt, 'with') || isWord(nxt, 'table')) {
        parenKind.push('query');
      } else if (prev?.kind === 'ident' && FROM_ARG_FUNCS.has(prev.text)) {
        parenKind.push('from_func');
      } else {
        parenKind.push('other');
      }
      continue;
    }
    if (t.text === ')') {
      parenKind.pop();
      continue;
    }
    if (t.kind !== 'ident') continue;

    const prev = toks[i - 1];
    const notMember = prev?.text !== '.';
    const atStart = isStmtStart(toks, i, head);
    if (atStart) inUpdateStmt = false;
    else if (parenKind.length === 0 && t.text === 'where') inUpdateStmt = false;

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
            if ((isWord(kw, 'table') || isWord(kw, 'view')) && toks[pos]?.text === ',') {
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
          if (isWord(kw, 'table') && target) {
            for (let k = target.next; k < toks.length && toks[k]!.text !== ';'; k++) {
              // ALTER TABLE <t> RENAME [TO|AS] <newT>（兼容省略 TO/AS，排除 RENAME COLUMN|INDEX|KEY）
              if (
                isWord(toks[k], 'rename') &&
                !isWord(toks[k + 1], 'column') &&
                !isWord(toks[k + 1], 'index') &&
                !isWord(toks[k + 1], 'key')
              ) {
                const dstPos = isWord(toks[k + 1], 'to') || isWord(toks[k + 1], 'as') ? k + 2 : k + 1;
                if (isForbiddenTarget(readQualifiedObj(toks, dstPos))) return true;
              }
              // ALTER TABLE <t> EXCHANGE PARTITION <p> WITH TABLE <other>
              if (isWord(toks[k], 'exchange') && isWord(toks[k + 1], 'partition')) {
                for (let m = k + 2; m < toks.length && toks[m]!.text !== ';'; m++) {
                  if (isWord(toks[m], 'with') && isWord(toks[m + 1], 'table')) {
                    if (isForbiddenTarget(readQualifiedObj(toks, m + 2))) return true;
                    break;
                  }
                }
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

    if (t.text === 'rename' && notMember) {
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

    // MySQL 保留字全流拦截（只需排除成员访问 `x.<kw>`）
    if (notMember && (t.text === 'grant' || t.text === 'revoke' || t.text === 'kill' || t.text === 'purge')) {
      return true;
    }
    if (notMember && t.text === 'use' && !isWord(toks[i + 1], 'index') && !isWord(toks[i + 1], 'key')) {
      return true;
    }
    if (notMember && t.text === 'call') {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }
    if (notMember && t.text === 'lock' && (isWord(toks[i + 1], 'table') || isWord(toks[i + 1], 'tables'))) {
      if (scanLockTablesList(toks, i + 2)) return true;
      continue;
    }

    if (
      (t.text === 'install' || t.text === 'uninstall') &&
      (isWord(toks[i + 1], 'plugin') || isWord(toks[i + 1], 'component'))
    ) {
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

    // 非保留/半保留高危命令的确定性全流语法识别（覆盖无 BEGIN 单语句例程、FOLLOWS/PRECEDES 与 HANDLER）
    if (notMember && t.text === 'xa') {
      if (atStart || (toks[i + 1]?.kind === 'ident' && XA_SUBCOMMANDS.has(toks[i + 1]!.text))) {
        return true;
      }
    }
    if (notMember && t.text === 'flush') {
      if (atStart) return true;
      let j = i + 1;
      if (isWord(toks[j], 'no_write_to_binlog') || isWord(toks[j], 'local')) j++;
      if (toks[j]?.kind === 'ident' && FLUSH_TARGETS.has(toks[j]!.text)) return true;
    }
    if (notMember && t.text === 'reset') {
      if (atStart) return true;
      if (toks[i + 1]?.kind === 'ident' && RESET_TARGETS.has(toks[i + 1]!.text)) return true;
    }
    if (notMember && t.text === 'binlog') {
      if (atStart || isStringLiteral(toks[i + 1])) return true;
    }
    if (notMember && (t.text === 'shutdown' || t.text === 'restart')) {
      const after = toks[i + 1];
      if (
        atStart ||
        ((!prev || !NON_STMT_PREVS.has(prev.text)) &&
          (after === undefined || after.text === ';' || isWord(after, 'end')))
      ) {
        return true;
      }
    }
    if (notMember && t.text === 'execute') {
      if (atStart) return true;
      const stmtTok = toks[i + 1];
      const after = toks[i + 2];
      const looksLikeStmtName =
        isIdentToken(stmtTok) && (stmtTok.kind === 'qident' || !MYSQL_KEYWORDS.has(stmtTok.text));
      if (
        looksLikeStmtName &&
        (!prev || !NON_STMT_PREVS.has(prev.text)) &&
        (after === undefined || after.text === ';' || isWord(after, 'using') || isWord(after, 'end'))
      ) {
        return true;
      }
    }

    if (t.text === 'set' && !inUpdateStmt && isDangerousSet(toks, i)) return true;

    if (notMember && t.text === 'handler' && !isWord(toks[i + 1], 'for')) {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }

    // ─── DDL / DML / 维护命令的跨库与内部表目标检查 ───
    if (
      notMember &&
      (t.text === 'analyze' ||
        t.text === 'optimize' ||
        t.text === 'repair' ||
        t.text === 'check' ||
        t.text === 'checksum')
    ) {
      let j = i + 1;
      if (isWord(toks[j], 'no_write_to_binlog') || isWord(toks[j], 'local')) j++;
      if (isWord(toks[j], 'table') || isWord(toks[j], 'tables')) {
        if (scanCommaTableList(toks, j + 1)) return true;
      }
      continue;
    }

    // MySQL 8.0.19+ `TABLE <tbl>` 以及其他未覆写到的 `TABLE <db.tbl|dowel_*>` 上下文
    if (notMember && t.text === 'table') {
      const pos = skipIfExists(toks, i + 1);
      if (isForbiddenTarget(readQualifiedObj(toks, pos))) return true;
      continue;
    }

    if (t.text === 'truncate') {
      const j = isWord(toks[i + 1], 'table') ? i + 2 : i + 1;
      if (isForbiddenTarget(readQualifiedObj(toks, j))) return true;
      continue;
    }

    if (t.text === 'references') {
      if (isForbiddenTarget(readQualifiedObj(toks, i + 1))) return true;
      continue;
    }

    if (t.text === 'update') {
      if (
        notMember &&
        !isWord(prev, 'before') &&
        !isWord(prev, 'after') &&
        !isWord(prev, 'on') &&
        !isWord(prev, 'key') &&
        !isWord(prev, 'for')
      ) {
        inUpdateStmt = true;
      }
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

    if (t.text === 'from' && parenKind.at(-1) !== 'from_func') {
      if (scanTableRefList(toks, i + 1)) return true;
      continue;
    }

    if (
      t.text === 'join' ||
      (t.text === 'straight_join' && (!prev || !SELECT_MODIFIER_PREVS.has(prev.text)))
    ) {
      if (scanTableRefList(toks, i + 1)) return true;
      continue;
    }

    if (t.text === 'using' && parenKind.at(-1) !== 'from_func' && toks[i + 1]?.text !== '(') {
      if (scanTableRefList(toks, i + 1)) return true;
      continue;
    }

    if (t.text === 'into' && !isWord(prev, 'insert') && !isWord(prev, 'replace')) {
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
  '不允许在迁移或 SQL 导入中使用实例级/高危/跨库 MySQL 语句（DATABASE/SCHEMA、USER/ROLE、EVENT、GRANT/REVOKE、XA、SET GLOBAL/PERSIST/RESOURCE GROUP/危险 sql_mode、SET_VAR(sql_mode)、PREPARE/EXECUTE、ALTER INSTANCE、UNDO TABLESPACE、CLONE、IMPORT TABLE、INSTALL/UNINSTALL PLUGIN|COMPONENT、FLUSH/RESET/SHUTDOWN/RESTART、LOAD DATA、INTO OUTFILE/DUMPFILE、USE、跨库限定 db.obj / db.fn() 或访问 dowel_* / __dowel_shadow_mark 内部对象）';

export const mysqlFindInstanceLevelStatement = (sql: string): string | null => {
  const hit = splitMysqlStatements(sql).find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};
