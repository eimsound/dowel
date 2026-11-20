// 执行器（H3）：沿冻结的版本链逐个执行 / 回滚迁移，历史写在目标库的 dowel schema 里。
//
// 流程（每一步失败都会拒绝，什么都不改）：
// 1. 项目锁（advisory lock，独占连接，等待默认 30 秒）；
// 2. 完整性：平台库的版本链和目标库 dowel 历史都过 verifyChain（冻结脚本按内容重算校验和，必须与记录一致），
//    两边再互相对一遍；
// 3. 漂移：读目标库结构，与环境当前版本的模型比较（先比指纹，再用 plan 算差异），不一致就报漂移；
//    第一次执行到某个库时改为判断它是“基线结构”还是“空库”（见 classifyFirstRun）；
// 4. 要执行的每个冻结迁移都必须已通过影子库验证，且不含实例级语句；
// 5. 逐个迁移执行。没有非事务步骤的迁移是**一个事务**（历史记录、脚本、读回校验、版本行都在里面）；
//    有非事务步骤的迁移按“事务段 / 非事务步骤”依次执行，每段做完记断点（markStep），失败后能从断点续跑；
// 6. 每个迁移做完都读回结构，必须等于目标版本的模型，否则（事务内）回滚并记失败。
import {
  emptyBase,
  findInstanceLevelStep,
  isConcurrentDdlSql,
  isNontransactionalSql,
  type Step,
  scrubSecrets,
} from '@dowel/core';
import {
  type Db,
  ensureHistory,
  fingerprint,
  finishRun,
  HistoryError,
  historyExists,
  historyWriteProblem,
  markStep,
  pinSession,
  readSnapshot,
  recordVersion,
  type ScriptStep,
  startRun,
  withProjectLock,
  writeProject,
} from '@dowel/engines';
import { classifyFirstRun, diffAgainst } from './compare.ts';
import { ExecutorError, type ExecutorErrorDetails } from './errors.ts';
import {
  assertPlatformChain,
  assertTargetHistory,
  markReadbackError,
  readState,
  runVersionId,
  type TargetState,
} from './state.ts';
import type {
  ChainVersion,
  DryRunPlan,
  ExecuteOptions,
  ExecuteResult,
  ExecutorEvent,
  Migration,
} from './types.ts';

type DryRunChecks = DryRunPlan['checks'];

/** 这一步不能放进事务：冻结脚本里的标记，加上语句文本的判断（双保险） */
export const isNonTx = (s: ScriptStep): boolean => !s.transactional || isNontransactionalSql(s.sql);

/** 写进历史 / 返回给客户端的错误文本：脱敏，限长 */
const errText = (e: unknown, max = 2000): string => {
  const t = scrubSecrets(e instanceof Error ? e.message : String(e));
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** 某一步执行时执行策略实际设下的超时（毫秒，0 = 这一步没有设，用库端原来的配置） */
interface AppliedTimeouts {
  statementMs: number;
  lockMs: number;
}

class StepFailure extends Error {
  index: number;
  /** 只属于这一步失败的补充提示（例如没能识别 CREATE INDEX CONCURRENTLY 的索引名）；不会带到别的步骤的错误里 */
  hint: string;
  /** 这一步实际设下的超时：据此判断失败是不是执行策略的超时 */
  applied: AppliedTimeouts;
  constructor(index: number, cause: unknown, hint = '', applied: AppliedTimeouts = NO_TIMEOUTS) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.index = index;
    this.hint = hint;
    this.applied = applied;
  }
}

const NO_TIMEOUTS: AppliedTimeouts = { statementMs: 0, lockMs: 0 };

const upMigration = (chain: ChainVersion[], i: number): Migration => ({
  version: chain[i]!,
  direction: 'up',
  from: chain[i - 1] ?? null,
  to: chain[i]!,
  steps: chain[i]!.upSteps,
});
const downMigration = (chain: ChainVersion[], i: number): Migration => ({
  version: chain[i]!,
  direction: 'down',
  from: chain[i]!,
  to: chain[i - 1]!,
  steps: chain[i]!.downSteps,
});
const baselineMigration = (v: ChainVersion): Migration => ({
  version: v,
  direction: 'baseline',
  from: null,
  to: v,
  steps: [],
});

const label = (v: ChainVersion) => `v${v.number}「${v.name}」`;

/**
 * 事务：BEGIN … COMMIT，出错 ROLLBACK 后原样抛出。
 * - afterCommit 在 COMMIT **成功返回之后**调用：COMMIT 本身可能失败（DEFERRABLE 约束到提交时才检查、连接断开……），
 *   失败时数据库没有任何变化，不能提前报告“已经动过目标库”。COMMIT 成功之后、回调之前进程崩溃也没关系：
 *   登记会留下，下一次同步发现目标库历史里已经有这个版本就会确认它；
 * - beforeCommit 在发出 COMMIT 之前调用（只有写基线用：它没有会失败的脚本，保持提交前报告）。
 */
export const inTx = async <T>(
  conn: Db,
  fn: () => Promise<T>,
  hooks: { beforeCommit?: () => void; afterCommit?: () => void } = {},
): Promise<T> => {
  await conn.exec('BEGIN');
  try {
    const r = await fn();
    hooks.beforeCommit?.();
    await conn.exec('COMMIT');
    hooks.afterCommit?.();
    return r;
  } catch (e) {
    await conn.exec('ROLLBACK').catch(() => {});
    throw e;
  }
};

/**
 * 非事务的 CREATE INDEX CONCURRENTLY 失败（唯一冲突、被取消……）会留下一个 INVALID 的同名索引，
 * 再执行同一条语句会报“已存在”（带 IF NOT EXISTS 的更糟：悄悄跳过，留下一个不可用的索引）。
 * 重跑之前把这个自己留下的无效索引删掉。**精确匹配**，不做子串猜测：从语句里解析出索引名和它所在表的
 * `schema.table`（CREATE INDEX 总是建在表所在的 schema 里），只删 `pg_index.indisvalid = false`、
 * 索引名和 schema 都一致、并且 `indrelid` 恰好是这张表的索引——别的 schema 里的同名表、同名无效索引都不会动。
 * 表名没写 schema（执行时 search_path 是空的，本来也执行不了）或解析不了，就不删，失败信息里提示手工处理。
 */
const CIC_HEAD = /^\s*create\s+(?:unique\s+)?index\s+concurrently\b/i;

/** 在 s 的 i 位置读一个标识符（带引号或不带；不带引号的折成小写）；返回名字和结束位置 */
const identAt = (s: string, from: number): { name: string; end: number } | null => {
  let i = from;
  while (/\s/.test(s[i] ?? '')) i++;
  if (s[i] === '"') {
    let out = '';
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] !== '"') out += s[j];
      else if (s[j + 1] === '"') {
        out += '"';
        j++;
      } else return { name: out, end: j + 1 };
    }
    return null;
  }
  const m = /^[A-Za-z_\u0080-￿][\w$\u0080-￿]*/.exec(s.slice(i));
  return m ? { name: m[0].toLowerCase(), end: i + m[0].length } : null;
};

/** 解析 CREATE [UNIQUE] INDEX CONCURRENTLY [IF NOT EXISTS] 名字 ON [ONLY] [schema.]表；不是 CIC 返回 null，解析不了返回 'unparsed' */
export const parseCreateIndexConcurrently = (
  sql: string,
): { index: string; schema: string; table: string } | 'unparsed' | null => {
  const head = CIC_HEAD.exec(sql);
  if (!head) return null;
  let pos = head[0].length;
  const ine = /^\s+if\s+not\s+exists\b/i.exec(sql.slice(pos));
  if (ine) pos += ine[0].length;
  const index = identAt(sql, pos);
  if (!index) return 'unparsed';
  const on = /^\s+on\s+(?:only\s+)?/i.exec(sql.slice(index.end));
  if (!on) return 'unparsed';
  const first = identAt(sql, index.end + on[0].length);
  if (!first) return 'unparsed';
  if (sql[first.end] !== '.') return 'unparsed'; // 没写 schema：search_path 为空时本来就执行不了，也没法确定是哪张表
  const second = identAt(sql, first.end + 1);
  if (!second) return 'unparsed';
  return { index: index.name, schema: first.name, table: second.name };
};

const CIC_HINT =
  '（如果这条语句失败后在库里留下了无效索引，而 Dowel 没能识别出它，请先手工 DROP INDEX CONCURRENTLY 再重试）';

/** 在 s 的 i 位置读一个带 schema 的名字（schema.name）；没写 schema 返回 null */
const qualifiedAt = (s: string, from: number): { schema: string; name: string; end: number } | null => {
  const first = identAt(s, from);
  if (!first || s[first.end] !== '.') return null;
  const second = identAt(s, first.end + 1);
  return second ? { schema: first.name, name: second.name, end: second.end } : null;
};

const DETACH_HEAD = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/i;

/**
 * 解析 ALTER TABLE [IF EXISTS] [ONLY] schema.父表 [*] DETACH PARTITION schema.分区 CONCURRENTLY；
 * 不是这种语句返回 null，是但解析不了（没写 schema、带注释等）返回 'unparsed'。
 */
export const parseDetachConcurrently = (
  sql: string,
): { parentSchema: string; parent: string; schema: string; partition: string } | 'unparsed' | null => {
  if (!/\bdetach\s+partition\b[\s\S]*\bconcurrently\b/i.test(sql)) return null;
  const head = DETACH_HEAD.exec(sql);
  if (!head) return 'unparsed';
  const parent = qualifiedAt(sql, head[0].length);
  if (!parent) return 'unparsed';
  const mid = /^(?:\s*\*)?\s+detach\s+partition\s+/i.exec(sql.slice(parent.end));
  if (!mid) return 'unparsed';
  const part = qualifiedAt(sql, parent.end + mid[0].length);
  if (!part) return 'unparsed';
  if (!/^\s+concurrently\s*;?\s*$/i.test(sql.slice(part.end))) return 'unparsed';
  return { parentSchema: parent.schema, parent: parent.name, schema: part.schema, partition: part.name };
};

const DETACH_HINT =
  '（如果分区停在了 detach pending 状态，而 Dowel 没能识别这条语句，请先手工执行 ALTER TABLE … DETACH PARTITION … FINALIZE 再处理）';

/**
 * DETACH PARTITION … CONCURRENTLY 分两个事务：第一个事务把分区标成 detach pending 并提交，之后要等所有可能用到父表的旧事务结束，
 * 第二个事务再对分区拿 ACCESS EXCLUSIVE 完成分离。等旧事务和拿锁都受 lock_timeout 约束（执行策略照常设锁等待超时：
 * 第二阶段排队会挡业务）。第一个事务提交之后超时，分区就停在 detach pending，重跑原语句会报 “already pending detach”，
 * 迁移会卡死。所以执行（续跑）这一步之前先看目标分区是不是已经 detach pending：是就改为执行
 * `ALTER TABLE 父表 DETACH PARTITION 分区 FINALIZE`（同样受超时约束，可以反复重试），效果相同。
 * 返回要执行的语句（null = 照原样执行）和识别不了时的提示。
 */
const detachFinalizeFor = async (conn: Db, sql: string): Promise<{ sql: string | null; hint: string }> => {
  const p = parseDetachConcurrently(sql);
  if (p === null) return { sql: null, hint: '' };
  if (p === 'unparsed') return { sql: null, hint: DETACH_HINT };
  const [row] = await conn.query<{ parent: string; partition: string }>(
    `select format('%I.%I', pn.nspname, pc.relname) as parent, format('%I.%I', cn.nspname, cc.relname) as partition
       from pg_inherits i
       join pg_class cc on cc.oid = i.inhrelid join pg_namespace cn on cn.oid = cc.relnamespace
       join pg_class pc on pc.oid = i.inhparent join pg_namespace pn on pn.oid = pc.relnamespace
      where i.inhdetachpending and cc.relname = $1 and cn.nspname = $2 and pc.relname = $3 and pn.nspname = $4`,
    [p.partition, p.schema, p.parent, p.parentSchema],
  );
  return {
    sql: row ? `ALTER TABLE ${row.parent} DETACH PARTITION ${row.partition} FINALIZE` : null,
    hint: '',
  };
};

/** 返回这条 CIC 语句能不能被识别（识别不了时失败信息里要提示手工处理） */
const dropLeftoverInvalidIndex = async (conn: Db, sql: string): Promise<boolean> => {
  const p = parseCreateIndexConcurrently(sql);
  if (p === null) return true;
  if (p === 'unparsed') return false;
  const rows = await conn.query<{ index: string }>(
    `select format('%I.%I', ni.nspname, ci.relname) as index
       from pg_index i
       join pg_class ci on ci.oid = i.indexrelid join pg_namespace ni on ni.oid = ci.relnamespace
       join pg_class ct on ct.oid = i.indrelid join pg_namespace nt on nt.oid = ct.relnamespace
      where not i.indisvalid and ci.relname = $1 and ct.relname = $2 and nt.nspname = $3`,
    [p.index, p.table, p.schema],
  );
  for (const r of rows) await conn.exec(`DROP INDEX CONCURRENTLY IF EXISTS ${r.index}`);
  return true;
};

interface Ctx {
  o: ExecuteOptions;
  emit: (e: ExecutorEvent) => Promise<void>;
  /** 通知调用方：这个迁移即将对目标库留下痕迹（见 ExecuteOptions.onTouch） */
  touch: (m: Migration) => void;
}

/** 读回结构（用目标版本冻结时的 schema 范围），必须等于目标版本的模型；一致就把版本行写进历史（指纹是读回结构的指纹） */
const verifyAndRecord = async (conn: Db, c: Ctx, m: Migration) => {
  const snapshot = await readSnapshot(conn, m.to.scope);
  const diff = diffAgainst(snapshot, m.to.model);
  if (diff.total)
    throw new ExecutorError(
      'readback_mismatch',
      `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}执行完后，读回的结构与 ${label(m.to)} 的模型不一致（${diff.total} 处差异）`,
      { diff: diff.items, diffTotal: diff.total, comparedVersionId: m.to.id, comparedNumber: m.to.number },
    );
  await recordVersion(conn, {
    projectId: c.o.projectId,
    versionId: m.to.id,
    number: m.to.number,
    parentId: m.to.parentId,
    name: m.to.name,
    scope: m.to.scope,
    upSteps: m.to.upSteps,
    downSteps: m.to.downSteps,
    checksum: m.to.checksum,
    model: m.to.model,
    fingerprint: fingerprint(snapshot),
    publishedAt: m.to.publishedAt,
    publishedBy: m.to.publishedBy,
  });
};

const runBase = (c: Ctx, m: Migration) => ({
  projectId: c.o.projectId,
  fromVersion: m.from?.id ?? null,
  toVersion: m.to.id,
  direction: m.direction,
  executedBy: c.o.executedBy,
  via: c.o.via ?? 'web',
  instanceId: c.o.instanceId,
});

/**
 * 把任何错误整理成 ExecutorError，**永远不抛**——失败记录要先写下来，之后才把错误往上抛：
 * - ExecutorError：补上版本、方向、partial；
 * - 某一步 SQL 失败（StepFailure）：带上第几步；
 * - HistoryError：同代码的 ExecutorError；
 * - 其他（读结构出错、schema 范围错误、连接断开……）：包成 `unexpected`，消息脱敏，原错误放 `cause`
 *   （调用方据此还能认出 ScopeError、连接故障）。
 */
const wrap = (e: unknown, m: Migration, partial: boolean): ExecutorError => {
  const details: ExecutorErrorDetails = {
    versionId: m.version.id,
    number: m.version.number,
    direction: m.direction,
    partial,
  };
  if (e instanceof ExecutorError) {
    e.details = { ...details, ...e.details };
    return e;
  }
  if (e instanceof StepFailure) {
    const sql = m.steps[e.index]?.sql ?? '';
    const brief = sql.length > 160 ? `${sql.slice(0, 160)}…` : sql;
    const timeout = timeoutOf(e.cause, e.applied);
    if (timeout)
      return new ExecutorError(
        'step_timeout',
        scrubSecrets(
          `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}第 ${e.index + 1} 步${
            timeout.kind === 'lock'
              ? `等锁超过 ${seconds(timeout.ms)}（执行策略的锁等待超时）：要改的表正被其他会话占用。`
              : `执行超过 ${seconds(timeout.ms)}（执行策略的语句超时）。`
          }${partial ? '已完成的步骤保留，重试会从断点接着执行' : '这个迁移已整体回滚，可以稍后重试'}（${brief}）${e.hint}`,
        ),
        { ...details, step: e.index + 1, timeout },
        e,
      );
    return new ExecutorError(
      'step_failed',
      scrubSecrets(
        `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}第 ${e.index + 1} 步执行失败：${e.message}（${brief}）${e.hint}`,
      ),
      { ...details, step: e.index + 1 },
      e,
    );
  }
  if (e instanceof HistoryError) return new ExecutorError(e.code, scrubSecrets(e.message), details, e);
  return new ExecutorError('unexpected', errText(e), details, e);
};

const execStep = async (
  conn: Db,
  steps: ScriptStep[],
  i: number,
  hint = '',
  applied: AppliedTimeouts = NO_TIMEOUTS,
  /** 实际执行的语句（续跑时把停在 detach pending 的 DETACH … CONCURRENTLY 换成 FINALIZE）；默认就是这一步的语句 */
  sql = steps[i]!.sql,
) => {
  try {
    await conn.exec(sql);
  } catch (e) {
    throw new StepFailure(i, e, hint, applied);
  }
};

/**
 * 迁移会话的超时（执行策略，P5a）：执行步骤之前设上，步骤做完（读回校验、写历史之前）用 RESET 恢复。
 * - 策略是“不限”（0）的项**不 SET**：库端（角色 / 数据库级）已有的 statement_timeout、lock_timeout 照常生效；
 * - 恢复用 RESET（回到会话的默认值，也就是角色 / 数据库级的配置），不是 SET 成 0：读回校验和写历史跑在原来的设置上；
 * - concurrent：CONCURRENTLY 类的操作不设锁等待超时（见 @dowel/core 的 isConcurrentDdlSql）；
 * - 在事务里 SET / RESET 随事务提交或回滚（失败时回滚就撤销了），在事务外由调用方在 finally 里恢复；结束时 RESET ALL 兜底。
 * 值是校验过的整数毫秒，直接拼进语句。返回实际设下的值（恢复和判断超时都用它）。
 */
const applyTimeouts = async (
  conn: Db,
  t: ExecuteOptions['timeouts'],
  concurrent = false,
): Promise<AppliedTimeouts> => {
  const ms = (n: number) => Math.max(0, Math.trunc(n));
  const applied = { statementMs: t ? ms(t.statementMs) : 0, lockMs: t && !concurrent ? ms(t.lockMs) : 0 };
  if (applied.statementMs > 0) await conn.exec(`SET statement_timeout = ${applied.statementMs}`);
  if (applied.lockMs > 0) await conn.exec(`SET lock_timeout = ${applied.lockMs}`);
  return applied;
};

const restoreTimeouts = async (conn: Db, applied: AppliedTimeouts) => {
  if (applied.statementMs > 0) await conn.exec('RESET statement_timeout');
  if (applied.lockMs > 0) await conn.exec('RESET lock_timeout');
};

/**
 * PG 因为执行策略的超时取消了语句：55P03 = lock_not_available（lock_timeout），57014 = query_canceled（statement_timeout）。
 * 只认这一步**执行策略实际设下**的超时：没设时同样的错误码来自库端配置或别人的 pg_cancel_backend，按普通失败报告。
 */
const timeoutOf = (e: unknown, t: AppliedTimeouts): ExecutorErrorDetails['timeout'] | undefined => {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '55P03' && t.lockMs > 0) return { kind: 'lock', ms: t.lockMs };
  // 57014 也可能是别人 pg_cancel_backend：只有设了语句超时时才认为是超时
  if (code === '57014' && t.statementMs > 0) return { kind: 'statement', ms: t.statementMs };
  return undefined;
};

const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`);

/** 只写基线：不执行任何 SQL；库里的结构已经等于基线模型 */
const writeBaseline = async (conn: Db, c: Ctx, m: Migration, snapshotFp: string): Promise<number> => {
  return inTx(
    conn,
    async () => {
      await recordVersion(conn, {
        projectId: c.o.projectId,
        versionId: m.to.id,
        number: m.to.number,
        parentId: m.to.parentId,
        name: m.to.name,
        scope: m.to.scope,
        upSteps: m.to.upSteps,
        downSteps: m.to.downSteps,
        checksum: m.to.checksum,
        model: m.to.model,
        fingerprint: snapshotFp,
        publishedAt: m.to.publishedAt,
        publishedBy: m.to.publishedBy,
      });
      const id = await startRun(conn, runBase(c, m));
      await finishRun(conn, id, 'done');
      return id;
    },
    { beforeCommit: () => c.touch(m) },
  );
};

/**
 * 执行一个迁移，返回执行记录 ID。**任何错误都先写 failed 记录（文本脱敏）再往上抛**；写记录本身失败（连接断了）
 * 只记日志，抛出的仍是原错误，不会被第二个错误盖掉。
 * - 没有非事务步骤：一个事务（startRun、全部步骤、读回校验、版本行、finishRun 同生共死）；失败时事务回滚、记录没了，
 *   **在事务之外另起一个事务**写一条 failed 记录；
 * - 有非事务步骤：先提交一条 running 记录，之后依次执行“连续的事务步骤（一个事务，末尾 markStep）”和
 *   “单个非事务步骤（事务外执行，成功后 markStep）”；最后一段（或单独的收尾事务）里做读回校验、写版本行、finishRun。
 *   失败：事务段回滚、记失败（保留断点），之后从断点接着跑。**第一个非事务步骤执行之前**先把断点记成 -1
 *   （“已经开始动目标库，但还没完成任何一步”）：它失败时库可能已经被改了（CREATE INDEX CONCURRENTLY 留下的 INVALID 索引），
 *   所以也算“停在中途”，可以续跑（续跑前先清掉遗留的无效索引），不会被当成漂移。
 *   读回校验失败（所有步骤都做完了，结果却不对）：续跑解决不了，失败记录带 READBACK_MARK 前缀，readState 不把它当作停在中途，
 *   漂移检查把残留的差异报成漂移，需要人工修正。
 */
const runMigration = async (
  conn: Db,
  c: Ctx,
  m: Migration,
  pos: { index: number; total: number },
  resumeAfter: number | null,
): Promise<number> => {
  const { steps } = m;
  const meta = {
    versionId: m.version.id,
    number: m.version.number,
    name: m.version.name,
    direction: m.direction,
  };
  const event = (status: 'start' | 'step' | 'done', extra: { step?: number; steps?: number } = {}) =>
    c.emit({
      type: 'migration',
      status,
      ...pos,
      ...meta,
      ...extra,
      ...(resumeAfter !== null ? { resumed: true } : {}),
    });
  await event('start', { steps: steps.length });

  if (!steps.some(isNonTx)) {
    // ── 纯事务迁移：一个事务 ──
    let runId = 0;
    try {
      runId = await inTx(
        conn,
        async () => {
          await pinSession(conn);
          const id = await startRun(conn, runBase(c, m));
          const applied = await applyTimeouts(conn, c.o.timeouts);
          for (let i = 0; i < steps.length; i++) await execStep(conn, steps, i, '', applied);
          await restoreTimeouts(conn, applied);
          await verifyAndRecord(conn, c, m);
          await finishRun(conn, id, 'done');
          return id;
        },
        { afterCommit: () => c.touch(m) },
      );
    } catch (e) {
      const err = wrap(e, m, false);
      // 事务已回滚，记录没了：在事务之外另起一个事务写一条失败记录留痕（尽力而为）
      await inTx(conn, async () => {
        const id = await startRun(conn, runBase(c, m));
        await finishRun(conn, id, 'failed', errText(err));
      }).catch((x) => console.error('写入失败的执行记录出错', errText(x)));
      throw err;
    }
    for (let i = 1; i <= steps.length; i++) await event('step', { step: i, steps: steps.length });
    await event('done', { steps: steps.length });
    return runId;
  }

  // ── 含非事务步骤：分段执行，带断点 ──
  const runId = await startRun(conn, runBase(c, m));
  let done = resumeAfter ?? -1; // 已完成的最后一步（0 起的下标）
  let touched = done >= 0; // 目标库是不是可能已经被这次迁移改动过
  if (touched) c.touch(m);
  try {
    if (done >= 0) await markStep(conn, runId, done); // 沿用上一次的断点：本次再失败也知道已经有进展
    let completed = false;
    let i = done + 1;
    while (i < steps.length) {
      if (isNonTx(steps[i]!)) {
        if (!touched) {
          // 第一个非事务步骤：它失败时库可能已经被改了，先记下“已经开始”
          c.touch(m);
          await markStep(conn, runId, -1);
          touched = true;
        }
        await pinSession(conn);
        // 超时也作用于非事务步骤（含清理遗留无效索引的 DROP INDEX CONCURRENTLY）；做完立刻恢复，写断点不受它约束。
        // CONCURRENTLY 类的索引操作（CREATE / DROP INDEX、REINDEX … CONCURRENTLY）不设锁等待超时
        // （它们不阻塞读写、等的是旧事务结束，见 @dowel/core 的 isConcurrentDdlSql）；DETACH PARTITION … CONCURRENTLY 不豁免
        // （第二阶段要对分区拿 ACCESS EXCLUSIVE，排队时一样会挡住业务）
        const applied = await applyTimeouts(conn, c.o.timeouts, isConcurrentDdlSql(steps[i]!.sql));
        try {
          // 没能识别 CIC 的索引名时，这一步失败的信息里提示手工处理（只属于这一步，不会带到别的步骤的错误里）
          const hint = (await dropLeftoverInvalidIndex(conn, steps[i]!.sql)) ? '' : CIC_HINT;
          // 上一次停在 detach pending 的 DETACH PARTITION … CONCURRENTLY：续跑时改为 FINALIZE（见 detachFinalizeFor）
          const detach = await detachFinalizeFor(conn, steps[i]!.sql);
          await execStep(conn, steps, i, hint + detach.hint, applied, detach.sql ?? undefined);
        } finally {
          await restoreTimeouts(conn, applied).catch(() => {});
        }
        await markStep(conn, runId, i);
        done = i;
        i++;
        await event('step', { step: i, steps: steps.length });
      } else {
        let j = i;
        while (j < steps.length && !isNonTx(steps[j]!)) j++;
        const last = j === steps.length;
        await inTx(
          conn,
          async () => {
            await pinSession(conn);
            const applied = await applyTimeouts(conn, c.o.timeouts);
            for (let k = i; k < j; k++) await execStep(conn, steps, k, '', applied);
            await restoreTimeouts(conn, applied);
            if (last) {
              await verifyAndRecord(conn, c, m);
              await markStep(conn, runId, j - 1);
              await finishRun(conn, runId, 'done');
            } else await markStep(conn, runId, j - 1);
          },
          { afterCommit: () => c.touch(m) },
        );
        if (last) completed = true;
        for (let k = i; k < j; k++) await event('step', { step: k + 1, steps: steps.length });
        done = j - 1;
        touched = true;
        i = j;
      }
    }
    if (!completed)
      // 最后一步是非事务步骤（或续跑时只剩收尾）：单独一个事务做读回校验、写版本行、结束记录
      await inTx(
        conn,
        async () => {
          await verifyAndRecord(conn, c, m);
          await finishRun(conn, runId, 'done');
        },
        { afterCommit: () => c.touch(m) },
      );
  } catch (e) {
    const err = wrap(e, m, touched);
    // 读回不一致：所有步骤都做完了，脚本的结果本身就不对，续跑没有意义——打上标记，交给漂移检查 / 人工处理
    const text = err.code === 'readback_mismatch' ? markReadbackError(errText(err)) : errText(err);
    await finishRun(conn, runId, 'failed', text).catch((x) =>
      console.error('结束失败的执行记录出错', errText(x)),
    );
    throw err;
  }
  await event('done', { steps: steps.length });
  return runId;
};

/** 路线：从 current 走到 target 要执行哪些迁移 */
const route = (chain: ChainVersion[], curIdx: number, tgtIdx: number): Migration[] => {
  const out: Migration[] = [];
  if (tgtIdx > curIdx) for (let i = curIdx + 1; i <= tgtIdx; i++) out.push(upMigration(chain, i));
  else for (let i = curIdx; i > tgtIdx; i--) out.push(downMigration(chain, i));
  return out;
};

const preflight = (migrations: Migration[]) => {
  for (const m of migrations) {
    if (m.direction === 'baseline') continue;
    if (!m.version.verified)
      throw new ExecutorError(
        'unverified',
        `${label(m.version)}还没有通过影子库验证，不能${m.direction === 'down' ? '回滚' : '执行'}。请先在版本页“重新验证”`,
        { versionId: m.version.id, number: m.version.number, direction: m.direction },
      );
    const steps: Step[] = m.steps.map((s) => ({ kind: 'frozen', target: '', sql: s.sql }));
    const bad = findInstanceLevelStep(steps);
    if (bad >= 0)
      throw new ExecutorError(
        'instance_level',
        `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}脚本第 ${bad + 1} 步含实例级语句（作用于整个数据库实例，不只是这个库），不能执行`,
        { versionId: m.version.id, number: m.version.number, direction: m.direction, step: bad + 1 },
      );
  }
};

/** 上一次执行是“读回校验失败”时，漂移错误后加一句短说明（详细说明在界面文案和文档里，只留一份） */
const manualNote = (state: TargetState): string =>
  state.readbackFailure ? '（这些差异是上一次执行留下的，需要手工修正）' : '';

/** 读回失败留下的“需要人工修正”：哪次执行（方向）、动的是哪个版本（升级是新版本，回滚是被回滚的版本） */
const manualOf = (state: TargetState): Pick<ExecutorErrorDetails, 'needsManual'> => {
  const r = state.readbackFailure;
  return r
    ? {
        needsManual: {
          direction: r.direction,
          versionId: runVersionId(r),
        },
      }
    : {};
};

/**
 * 执行申请的绑定（P5b）：锁里读到的当前版本、算出的迁移和校验和必须与提交时一致。不一致时什么都还没写（调用点在开始写目标库之前）。
 * 写基线那一步不在比较之内：它不执行脚本，第一次执行到导入来源库时预演和真执行都会先写基线。
 */
const assertExpected = (
  expect: NonNullable<ExecuteOptions['expect']>,
  current: string | null,
  migrations: Migration[],
) => {
  const stale = (why: string) =>
    new ExecutorError('request_stale', `环境状态和提交申请时不一样了：${why}。申请已失效，请重新提交`);
  if (current !== expect.from) throw stale('目标库里的当前版本变了');
  const got = migrations.map((m) => ({
    versionId: m.version.id,
    direction: m.direction,
    checksum: m.version.checksum,
  }));
  if (
    got.length !== expect.migrations.length ||
    got.some((g, i) => {
      const e = expect.migrations[i]!;
      return g.versionId !== e.versionId || g.direction !== e.direction;
    })
  )
    throw stale('要执行的迁移变了');
  if (got.some((g, i) => g.checksum !== expect.migrations[i]!.checksum))
    throw stale('相关版本的脚本被修改过');
};

const locked = async (conn: Db, c: Ctx): Promise<ExecuteResult> => {
  const { o } = c;
  const { chain } = o;
  const mode = o.mode ?? 'migrate';
  await c.emit({ type: 'phase', phase: 'integrity' });
  // 历史已经存在时先过一遍 ensureHistory（格式版本检查；旧格式在这里升级——要改表，所以预演不做）：
  // 目标库里的历史比当前代码新就拒绝。预演只读：用只读的检查代替，看得出真执行时会不会在这里失败
  if (o.dryRun) {
    const problem = await historyWriteProblem(conn);
    if (problem) throw new ExecutorError(problem.code, scrubSecrets(problem.message));
  } else if (await historyExists(conn)) await ensureHistoryMapped(conn);
  const state: TargetState = await readState(conn, o.projectId);
  assertTargetHistory(state, chain, o.instanceId);

  const first = chain[0];
  if (!first) throw new ExecutorError('unknown_version', '项目还没有发布任何版本');
  const idx = new Map(chain.map((v, i) => [v.id, i]));
  const target = mode === 'baseline' ? first : chain.find((v) => v.id === o.to);
  if (!target) throw new ExecutorError('unknown_version', `目标版本不存在：${o.to ?? '（未指定）'}`);
  const tgtIdx = idx.get(target.id)!;
  const curIdx = state.current === null ? -1 : (idx.get(state.current) ?? -1);
  if (state.current !== null && curIdx < 0)
    throw new ExecutorError(
      'history_mismatch',
      `目标库历史里的当前版本 ${state.current} 不在平台库的版本链上`,
    );

  let migrations: Migration[] = [];
  let baseline: Migration | null = null;
  let resumeAfter: number | null = null;
  let snapshotFp = '';

  if (state.unfinished) {
    // ── 上一次停在中途：结构是半途状态，不做漂移检查；必须先把它接着跑完 ──
    const p = state.unfinished;
    if (mode === 'baseline')
      throw new ExecutorError('baseline_not_applicable', '上一次执行停在中途，必须先继续执行它，不能写基线');
    migrations = route(chain, curIdx, tgtIdx);
    const m0 = migrations[0];
    const want = runVersionId(p);
    if (!m0 || m0.direction !== p.direction || m0.version.id !== want) {
      const v = chain[idx.get(want ?? '') ?? -1];
      throw new ExecutorError(
        'unfinished_run',
        `上一次${p.direction === 'down' ? '回滚' : '执行'}${v ? ` ${label(v)}` : ''}${p.status === 'running' ? '被中断了' : '失败了'}，停在第 ${(p.stepIndex ?? -1) + 2} 步之前，目标库处于半途状态。` +
          `必须先继续执行它（把目标版本设为${p.direction === 'down' ? '它的回滚目标或更早的版本' : ' 它或更靠后的版本'}），不能改做别的`,
        {
          versionId: want ?? undefined,
          direction: p.direction === 'baseline' ? undefined : p.direction,
          partial: true,
        },
      );
    }
    resumeAfter = p.stepIndex ?? -1;
  } else if (state.current === null) {
    // ── 第一次执行到这个库 ──
    await c.emit({ type: 'phase', phase: 'drift' });
    // 第一次执行：用第一个版本冻结时的 schema 范围读结构
    const snapshot = await readSnapshot(conn, first.scope);
    const cls = classifyFirstRun(snapshot, first, emptyBase(first.model, first.scope));
    if (mode === 'baseline') {
      if (cls.kind !== 'baseline')
        throw new ExecutorError(
          'baseline_not_applicable',
          cls.kind === 'empty'
            ? '库里还没有任何结构，没有可以写入的基线：直接执行即可建库'
            : `库的结构与基线版本 ${label(first)} 不一致（${cls.diff.total} 处差异），不能写入基线`,
          { diff: cls.diff.items, diffTotal: cls.diff.total },
        );
    } else if (cls.kind === 'drift')
      throw new ExecutorError(
        'first_run_drift',
        `这个库还没有 Dowel 的历史，而且它的结构既不等于基线版本 ${label(first)}、也不是空库（${cls.diff.total} 处差异）。` +
          '请先让库的结构与基线一致（或改用“从这个库导入”建项目），再执行' +
          manualNote(state),
        {
          diff: cls.diff.items,
          diffTotal: cls.diff.total,
          versionId: first.id,
          number: first.number,
          ...manualOf(state),
        },
      );
    if (cls.kind === 'baseline') {
      baseline = baselineMigration(first);
      snapshotFp = fingerprint(snapshot);
      migrations = mode === 'baseline' ? [] : route(chain, 0, tgtIdx);
    } else migrations = route(chain, -1, tgtIdx);
  } else {
    // ── 正常：库里有历史 ──
    if (mode === 'baseline')
      throw new ExecutorError(
        'baseline_not_applicable',
        '这个库里已经有这个项目的 Dowel 历史，不需要再写基线',
      );
    migrations = route(chain, curIdx, tgtIdx);
    if (!migrations.length) {
      // 申请绑定了要执行的迁移，库却已经在目标版本（别人先执行了）：不能当作“执行成功”
      if (o.expect) assertExpected(o.expect, state.current, migrations);
      const cur = chain[curIdx];
      const ref = cur ? { id: cur.id, number: cur.number, name: cur.name } : null;
      return {
        mode,
        direction: 'none',
        baseline: false,
        ran: [],
        current: state.current,
        ...(o.dryRun
          ? {
              dryRun: {
                firstRun: null,
                baseline: false,
                from: ref,
                to: ref,
                migrations: [],
                resume: null,
                createsHistory: false,
                checks: ['lock', 'integrity', 'claim', 'history_writable'] as DryRunChecks,
              },
            }
          : {}),
      };
    }
    await c.emit({ type: 'phase', phase: 'drift' });
    const cur = chain[curIdx]!;
    // 漂移检查用环境当前版本冻结时的 schema 范围
    const snapshot = await readSnapshot(conn, cur.scope);
    const recorded = state.versions.find((v) => v.versionId === cur.id)?.fingerprint;
    if (!recorded || recorded !== fingerprint(snapshot)) {
      const diff = diffAgainst(snapshot, cur.model);
      if (diff.total)
        throw new ExecutorError(
          'drift',
          `目标库的结构与环境当前版本 ${label(cur)} 不一致（${diff.total} 处差异），可能有人绕过 Dowel 直接改过库。已拒绝执行${manualNote(state)}`,
          {
            diff: diff.items,
            diffTotal: diff.total,
            versionId: cur.id,
            number: cur.number,
            ...manualOf(state),
          },
        );
    }
  }

  const routeDir = migrations[0]?.direction === 'down' ? 'down' : migrations.length ? 'up' : null;
  if (o.direction && routeDir && routeDir !== o.direction)
    throw new ExecutorError(
      'wrong_direction',
      routeDir === 'down'
        ? `目标版本 ${label(target)} 比环境当前版本更早，这是回滚，不是执行`
        : `目标版本 ${label(target)} 比环境当前版本更新，这是执行，不是回滚`,
      { versionId: target.id, reached: state.current },
    );
  preflight(migrations);
  if (o.expect) assertExpected(o.expect, state.current, migrations);
  const direction = migrations[0]?.direction === 'down' ? 'down' : migrations.length ? 'up' : 'none';
  if (o.dryRun) {
    // 预演到此为止：检查全部通过，没有写目标库，也不调用任何平台库回调
    const ref = (v: ChainVersion | undefined) => (v ? { id: v.id, number: v.number, name: v.name } : null);
    const lastTo = migrations.at(-1)?.to ?? (baseline ? first : (chain[curIdx] ?? null));
    return {
      mode,
      direction: direction as ExecuteResult['direction'],
      baseline: baseline !== null,
      ran: [],
      from: state.current,
      current: state.current,
      dryRun: {
        firstRun: state.current === null && !state.unfinished ? (baseline ? 'baseline' : 'empty') : null,
        baseline: baseline !== null,
        from: ref(chain[curIdx]),
        to: ref(lastTo ?? undefined),
        migrations: migrations.map((m) => ({
          versionId: m.version.id,
          number: m.version.number,
          name: m.version.name,
          direction: m.direction,
          steps: m.steps.map((s) => ({ sql: s.sql, transactional: !isNonTx(s) })),
          nonTransactional: m.steps.filter(isNonTx).length,
          checksum: m.version.checksum,
        })),
        resume: state.unfinished
          ? {
              versionId: runVersionId(state.unfinished) ?? '',
              direction: state.unfinished.direction,
              afterStep: state.unfinished.stepIndex ?? -1,
            }
          : null,
        createsHistory: !state.historyExists,
        checks: ['lock', 'integrity', 'claim', 'drift', 'verified', 'instance_level', 'history_writable'],
      },
    };
  }
  await c.emit({
    type: 'plan',
    baseline: baseline !== null,
    migrations: migrations.map((m) => ({
      versionId: m.version.id,
      number: m.version.number,
      name: m.version.name,
      direction: m.direction,
      steps: m.steps.length,
    })),
  });

  // ── 开始写目标库 ──
  const ran: ExecuteResult['ran'] = [];
  let current = state.current;
  const total = migrations.length + (baseline ? 1 : 0);
  let registered = state.historyExists && state.project !== null;
  const register = async () => {
    if (registered) return;
    await ensureHistoryMapped(conn);
    await writeProject(conn, {
      projectId: o.projectId,
      name: o.projectName,
      instanceId: o.instanceId,
      claimedAt: new Date().toISOString(),
      claimedBy: o.executedBy,
    });
    registered = true;
  };
  const after = async (m: Migration, runId: number) => {
    ran.push({ versionId: m.version.id, number: m.version.number, direction: m.direction, runId });
    current = m.to.id;
    try {
      await o.afterMigration?.(m);
    } catch (e) {
      console.error('执行后回调出错（目标库已经提交）', errText(e));
    }
  };
  try {
    let pos = 0;
    if (baseline) {
      await o.beforeMigration?.(baseline);
      await register();
      pos++;
      await c.emit({
        type: 'migration',
        status: 'start',
        index: pos,
        total,
        versionId: first.id,
        number: first.number,
        name: first.name,
        direction: 'baseline',
        steps: 0,
      });
      const runId = await writeBaseline(conn, c, baseline, snapshotFp).catch((e) => {
        throw wrap(e, baseline!, false);
      });
      await c.emit({
        type: 'migration',
        status: 'done',
        index: pos,
        total,
        versionId: first.id,
        number: first.number,
        name: first.name,
        direction: 'baseline',
        steps: 0,
      });
      await after(baseline, runId);
    }
    for (const [k, m] of migrations.entries()) {
      await o.beforeMigration?.(m);
      await register();
      pos++;
      const runId = await runMigration(conn, c, m, { index: pos, total }, k === 0 ? resumeAfter : null);
      await after(m, runId);
    }
  } catch (e) {
    if (e instanceof ExecutorError) e.details.reached ??= current;
    throw e;
  }
  return {
    mode,
    direction: direction as ExecuteResult['direction'],
    baseline: baseline !== null,
    ran,
    from: state.current,
    current,
  };
};

export const ensureHistoryMapped = async (conn: Db) => {
  try {
    await ensureHistory(conn);
  } catch (e) {
    if (e instanceof HistoryError) throw new ExecutorError(e.code, scrubSecrets(e.message));
    throw e;
  }
};

/** 执行 / 回滚到指定版本，或只写基线。失败抛 ExecutorError（消息已脱敏）。 */
export const execute = async (o: ExecuteOptions): Promise<ExecuteResult> => {
  const emit = async (e: ExecutorEvent) => {
    try {
      await o.onEvent?.(e);
    } catch {
      // 进度发不出去（客户端断开）不影响正在做的事
    }
  };
  // 平台库的链先查（不用连目标库）
  assertPlatformChain(o.chain, o.projectId);
  try {
    return await withProjectLock(o.db, o.projectId, o.lockTimeoutMs ?? 30_000, async (conn) => {
      await emit({ type: 'phase', phase: 'lock' });
      try {
        return await locked(conn, {
          o,
          emit,
          touch: (m) => {
            try {
              o.onTouch?.(m);
            } catch {
              // 回调出错不影响执行
            }
          },
        });
      } finally {
        // 会话级设置（search_path 等）不能留在连接上
        await conn.exec('RESET ALL').catch(() => {});
      }
    });
  } catch (e) {
    if (e instanceof HistoryError) throw new ExecutorError(e.code, scrubSecrets(e.message));
    throw e;
  }
};
