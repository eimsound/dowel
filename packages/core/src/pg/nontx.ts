// 哪些 PG 语句不能放进事务里执行。纯函数，前后端共用：
// 服务端冻结迁移时据此标记 transactional，界面上编辑脚本时也按同一规则自动勾选“非事务”。

const isIdentChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
// sticky（y）：只在 lastIndex 这个位置匹配，不用先 slice 出一份后缀——每个 $ 都复制一遍字符串是二次方
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/** 在 i 这个位置开头的美元引号标记（$$ 或 $tag$）；不是就返回 null */
const dollarTagAt = (sql: string, i: number): string | null => {
  DOLLAR_TAG.lastIndex = i;
  return DOLLAR_TAG.exec(sql)?.[0] ?? null;
};

/**
 * 去掉注释、字符串字面量、带引号的标识符和美元引号（函数体），按字符从左到右**只扫一遍**。
 * 分两遍（先删注释再删字符串，或反过来）会互相吃：字符串里的 `--`、`/*` 会把后面的语句当成注释删掉，
 * 注释里的引号又会让字符串配对错位。这里每个位置只会被一种记号消耗：
 * - 单引号字符串：`''` 是转义的引号；前面紧跟 E / e 的（E'…'）里反斜杠还会转义下一个字符；
 * - 双引号标识符：`""` 是转义的引号；
 * - `$tag$…$tag$`（tag 可以为空）：前一个字符是标识符字符时 `$` 只是标识符的一部分（`a$b$`），`$1` 是参数，都不算；
 * - `--` 行注释；
 * - `/* … *\/` 块注释，PG 允许嵌套。
 * 没有结束的字符串 / 注释 / 美元引号一直吃到末尾。去掉的内容换成占位符（空串 '' / "" / 空格），语句之间的分号保留。
 */
export const stripPgSql = (sql: string): string => {
  let out = '';
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    // 美元引号的标记在每个位置只算一次（$ 前面是标识符字符时只是标识符的一部分）
    const tag = c === '$' && !isIdentChar(sql[i - 1]) ? dollarTagAt(sql, i) : null;
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? '') && !isIdentChar(sql[i - 2]);
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2;
          else break;
        } else i++;
      }
      i++;
      out += "''";
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') i += 2;
          else break;
        } else i++;
      }
      i++;
      out += '""';
    } else if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? n : end + tag.length;
      out += "''";
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

/** REPACK 的括号选项里有没有打开 ANALYZE / ANALYSE：`ANALYZE`、`ANALYZE true / on / 1` 算，`false / off / 0` 不算 */
const repackOptionAnalyze = (options: string): boolean =>
  options.split(',').some((o) => {
    const m = /^\s*analy[zs]e(?:\s+(\S+))?\s*$/i.exec(o);
    if (!m) return false;
    const v = m[1]?.toLowerCase();
    return v === undefined || v === 'true' || v === 'on' || v === '1';
  });

const REPACK_WITH_OPTIONS = /^\s*repack\s*\(([^)]*)\)/i;

/** 单条语句（已经去掉注释、字符串等）是不是不能进事务 */
const statementIsNontransactional = (s: string): boolean => {
  const repackOpts = REPACK_WITH_OPTIONS.exec(s);
  return (
    /\bconcurrently\b/i.test(s) ||
    /^\s*vacuum\b/i.test(s) ||
    /^\s*alter\s+system\b/i.test(s) ||
    /^\s*(create|drop)\s+(database|tablespace)\b/i.test(s) ||
    /^\s*alter\s+type\b[\s\S]*?\badd\s+value\b/i.test(s) ||
    /^\s*discard\s+all\b/i.test(s) ||
    // REINDEX DATABASE / SYSTEM（可带 (选项)）不能在事务块里执行；REINDEX INDEX / TABLE / SCHEMA 可以
    /^\s*reindex\s*(?:\([^)]*\)\s*)?(?:database|system)\b/i.test(s) ||
    // 不带表名的 CLUSTER（整库重排，可带 (选项) 或老写法的 VERBOSE）不能在事务块里；CLUSTER 表名 可以
    /^\s*cluster\s*(?:\([^)]*\)|verbose)?\s*$/i.test(s) ||
    // PG 19+ 无表名 REPACK（含 REPACK USING INDEX 及带选项的整库重排）与启用 ANALYZE/ANALYSE 的 REPACK 均不能在事务块里；
    // 带 CONCURRENTLY 已被上面规则覆盖；不带 ANALYZE/CONCURRENTLY 的单表 REPACK 表名 可以进事务
    /^\s*repack\s*(?:\([^)]*\)\s*)?(?:using\s+index\s*)?$/i.test(s) ||
    (repackOpts !== null && repackOptionAnalyze(repackOpts[1]!))
  );
};

/**
 * 能不能放进事务。判断依据是 PG“不能在事务块里执行”的命令，外加一条保守的规则：
 * - 任何带 CONCURRENTLY 的语句：CREATE INDEX / DROP INDEX / REINDEX / REPACK (CONCURRENTLY) / ALTER TABLE … DETACH PARTITION …；
 * - VACUUM、ALTER SYSTEM、CREATE / DROP DATABASE、CREATE / DROP TABLESPACE、DISCARD ALL、
 *   REINDEX DATABASE / SYSTEM、不带表名的 CLUSTER 与 REPACK（含 REPACK USING INDEX）及带 ANALYZE/ANALYSE 选项的 REPACK
 *   （不带 ANALYZE/CONCURRENTLY 的单表 CLUSTER / REPACK 和 REINDEX TABLE / INDEX / SCHEMA 可以进事务）；
 * - ALTER TYPE … ADD VALUE：PG 12 起可以在事务里执行，但新值在同一事务里不能使用（后面的步骤可能立刻
 *   用到它：默认值、索引条件），所以单独作为非事务步骤最稳妥（规划器会生成这条语句）。
 * 一步里可以有多条语句（用户手写的脚本）：先去掉字符串、注释、带引号标识符和 $$ 函数体（分号出现在这些地方
 * 不会把语句切开），再按分号切成多条逐条检查，任何一条命中就算非事务。
 * 只是保守的文本判断：宁可把能进事务的标成非事务（执行器少一层保护），也不要把不能进事务的塞进事务。
 */
export const isNontransactionalSql = (sql: string): boolean =>
  stripPgSql(sql).split(';').some(statementIsNontransactional);

/**
 * 单条语句（已经去掉注释、字符串等）是不是“只拿不阻塞读写的锁、等旧事务结束”的 CONCURRENTLY 操作：
 * CREATE [UNIQUE] INDEX CONCURRENTLY、DROP INDEX CONCURRENTLY，
 * REINDEX {INDEX|TABLE|SCHEMA|DATABASE|SYSTEM} CONCURRENTLY，以及 PG 14 起的括号选项写法 REINDEX (CONCURRENTLY [true|on|1], …) …
 * （`(CONCURRENTLY false|off|0)` 不算）。它们拿的是 SHARE UPDATE EXCLUSIVE，不挡业务的读写，等的是已有事务结束。
 *
 * **ALTER TABLE … DETACH PARTITION … CONCURRENTLY 与 PG 19+ REPACK (CONCURRENTLY) 不在其中**：
 * 它们在最终切换/完成阶段仍需短暂获取 ACCESS EXCLUSIVE 锁，排队时一样会把访问目标表的业务语句堵在后面，
 * 所以照常受锁等待超时约束（它们仍然是非事务步骤，见 isNontransactionalSql）。
 */
const REINDEX =
  /^\s*reindex\s*(?:\(([^)]*)\)\s*)?(?:index|table|schema|database|system)\b(\s+concurrently\b)?/i;

/** REINDEX 的括号选项里有没有打开 CONCURRENTLY：`CONCURRENTLY`、`CONCURRENTLY true / on / 1` 算，`false / off / 0` 不算 */
const reindexOptionConcurrently = (options: string): boolean =>
  options.split(',').some((o) => {
    const m = /^\s*concurrently(?:\s+(\S+))?\s*$/i.exec(o);
    if (!m) return false;
    const v = m[1]?.toLowerCase();
    return v === undefined || v === 'true' || v === 'on' || v === '1';
  });

const statementIsConcurrentDdl = (s: string): boolean => {
  if (/^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i.test(s)) return true;
  if (/^\s*drop\s+index\s+concurrently\b/i.test(s)) return true;
  const r = REINDEX.exec(s);
  return r !== null && (r[2] !== undefined || (r[1] !== undefined && reindexOptionConcurrently(r[1])));
};

/**
 * 这一步是不是**只有** CONCURRENTLY 类的操作（见 statementIsConcurrentDdl）：执行器据此不给它设锁等待超时
 * （lock_timeout 要防的是 DDL 排队时把业务语句堵在后面，这类操作不会；照设的话库里有长事务时会反复失败、留下 INVALID 索引）。
 * 先去掉注释、字符串、带引号标识符和 $$ 函数体再判断：注释里提到 concurrently 的普通 CREATE INDEX 不算，前导注释不影响识别。
 * 一步里还有别的语句时不算（别的语句仍然要受锁等待超时约束；实际上 CONCURRENTLY 本来也不能和别的语句放在一个多语句请求里）。
 */
export const isConcurrentDdlSql = (sql: string): boolean => {
  const statements = stripPgSql(sql)
    .split(';')
    .filter((s) => s.trim() !== '');
  return statements.length > 0 && statements.every(statementIsConcurrentDdl);
};

/**
 * 单条语句（已经去掉注释、字符串等）是不是实例级语句：作用于整个数据库实例，而不只是迁移的这个库——
 * CREATE / DROP / ALTER DATABASE、CREATE / DROP / ALTER TABLESPACE、ALTER SYSTEM、
 * CREATE / DROP / ALTER ROLE | USER | GROUP。
 * USER MAPPING 是库里的对象，不算——但只有 USER 后面紧跟 `MAPPING FOR`、`MAPPING IF NOT EXISTS FOR`、
 * `MAPPING IF EXISTS FOR` 才排除：`CREATE USER mapping SUPERUSER`（建一个叫 mapping 的角色）仍然是实例级语句。
 */
const statementIsInstanceLevel = (s: string): boolean =>
  /^\s*alter\s+system\b/i.test(s) ||
  /^\s*(create|drop|alter)\s+(database|tablespace|role|group)\b/i.test(s) ||
  /^\s*(create|drop|alter)\s+user\b(?!\s+mapping\s+(?:if\s+(?:not\s+)?exists\s+)?for\b)/i.test(s);

/**
 * 实例级语句不能放进迁移的说明文字：所有拒绝实例级语句的地方（编辑脚本、发布、验证、导入 SQL）共用这一份，
 * 清单也只在 statementIsInstanceLevel 里维护一份。
 */
export const INSTANCE_LEVEL_DESCRIPTION =
  '实例级语句不能放进迁移：它作用于整个数据库实例，不只是这个库（CREATE / DROP / ALTER DATABASE、TABLESPACE、ROLE | USER | GROUP，ALTER SYSTEM）';

/**
 * 找出第一条实例级语句，返回它（去掉字符串和注释后的文本，压成一行、最多 80 个字符，用来在提示里指出是哪一条）；
 * 没有返回 null。先去掉字符串、注释、带引号标识符和 $$ 函数体，再按分号切开逐条检查。
 * 这只是防误操作，不是安全边界：挡不住 DO 块或函数里 EXECUTE 的动态 SQL；
 * 真正的边界是“生产环境默认不在同一实例上建影子库”和“影子库用权限受限的账号（不带 SUPERUSER / CREATEROLE）或独立实例”。
 */
export const findInstanceLevelStatement = (sql: string): string | null => {
  const hit = stripPgSql(sql).split(';').find(statementIsInstanceLevel);
  return hit === undefined ? null : hit.trim().replace(/\s+/g, ' ').slice(0, 80);
};

export const isInstanceLevelSql = (sql: string): boolean => findInstanceLevelStatement(sql) !== null;

/**
 * 第一条含实例级语句的步骤的下标；没有返回 -1。编辑脚本 / 发布的检查（chain.ts）和验证前的拒绝检查（verifier）
 * 共用它，和 findInstanceLevelStatement 放在一起，清单只在这个文件里维护。
 */
export const findInstanceLevelStep = (steps: { sql: string }[]): number =>
  steps.findIndex((s) => isInstanceLevelSql(s.sql));
