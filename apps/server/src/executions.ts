// 执行（H3 / H7）：把平台库里的版本链、环境信息整理给执行器，把进度转成 API 事件，
// 并在平台库里登记“这个环境执行过哪些版本”、同步当前版本和漂移结果。
import type {
  DriftCheckResponse,
  DriftInfo,
  DriftSummary,
  ExecEvent,
  NeedsManual,
  RunInfo,
} from '@dowel/api';
import type { Model } from '@dowel/core';
import {
  type Db,
  fingerprint,
  HistoryError,
  readSnapshot,
  ScopeError,
  withProjectLock,
} from '@dowel/engines';
import {
  type ChainVersion,
  checkDrift,
  type DriftReport,
  type ExecuteResult,
  ExecutorError,
  type ExecutorEvent,
  execute,
  importLive,
  isReadbackFailure,
  type MarkExpect,
  type MarkPlan,
  type MarkResult,
  markApplied,
  readState,
  stripReadbackMark,
  type TargetState,
} from '@dowel/executor';
import { HTTPException } from 'hono/http-exception';
import type { PlatformDb } from './db.ts';
import {
  confirmVersion,
  driftInfo,
  type EnvRow,
  loadChain,
  loadEnv,
  markExecuted,
  releaseClaim,
  setDrift,
  syncEnvCache,
  versionRef,
} from './envs.ts';
import { decrypt, SecretError, scrubSecrets } from './secrets.ts';
import { readSettings } from './settings.ts';
import { CHECK_CONNECT_TIMEOUT, ConnectError, type ConnectionGuard, connectPg, scrubUrl } from './targets.ts';

/** 同一个环境同一时间只做一件事（单进程内；跨进程由目标库上的项目锁保证）。默认等 30 秒 */
export const LOCK_WAIT_MS = 30_000;

export class EnvLocks {
  private held = new Map<string, Promise<void>>();
  /** 这个环境现在有没有正在执行的操作 */
  busy(id: string): boolean {
    return this.held.has(id);
  }
  async acquire(id: string, timeoutMs = LOCK_WAIT_MS, busyMessage?: string): Promise<() => void> {
    const deadline = Date.now() + timeoutMs;
    while (this.held.has(id)) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new HTTPException(409, {
          message:
            busyMessage ??
            `这个环境正在执行另一个操作，等待 ${Math.round(timeoutMs / 1000)} 秒后超时。请稍后再试`,
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.held.get(id)!,
        new Promise<void>((r) => {
          timer = setTimeout(r, left);
        }),
      ]);
      clearTimeout(timer);
    }
    let release!: () => void;
    this.held.set(
      id,
      new Promise<void>((r) => {
        release = r;
      }),
    );
    return () => {
      this.held.delete(id);
      release();
    };
  }
}

export interface ExecContext {
  db: PlatformDb;
  guard: ConnectionGuard;
  locks: EnvLocks;
  /** 在目标库项目锁里读历史并同步缓存（默认 syncTarget）；测试里可以替换，验证关键状态不依赖结尾的同步 */
  syncTarget?: (db: PlatformDb, env: EnvRow, tdb: Db) => Promise<TargetState | null>;
  /** 标记等目标库项目锁的毫秒数（默认 30 秒）；测试里调短，验证“锁被占用”的错误路径 */
  lockTimeoutMs?: number;
}

/** 连目标库的连接（白名单在连接层检查）。postgres.js 是懒连接，URL 写错这里也可能同步抛错 */
const open = (url: string, guard: ConnectionGuard, timeout = 10) => connectPg(url, timeout, guard);

/** 连接 / 通信层面的故障（SQLSTATE 08 / 53 / 57 / 28 / 3D 和驱动的网络错误） */
const isConnectionFailure = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' &&
    /^(08|53|57|28|3D|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|CONNECTION_)/.test(code)
  );
};

export type ErrorKind = NonNullable<DriftSummary['errorKind']>;

/** 认领失败时给用户看的原因（已脱敏）：接入、接手共用 */
export const claimFailure = (e: unknown, url: string): string =>
  scrubSecrets(
    e instanceof ExecutorError && e.code !== 'unexpected' ? e.message : classifyError(e, url).message,
  );

/**
 * 连目标库 / 读历史 / 认领时抛出的错误 → 路由能直接映射成 4xx 的错误：预期的拒绝（HTTPException、HistoryError、
 * ExecutorError 非 unexpected）原样返回；连接故障、权限不足（目标库返回的错误）转成带原因的 ConnectError（422，文案已脱敏）；
 * 真正意外的原样返回（500，只记日志）。接入、认领、接手共用。
 */
export const toTargetError = (e: unknown, url: string): unknown => {
  if (e instanceof HTTPException || e instanceof HistoryError) return e;
  if (e instanceof ExecutorError && e.code !== 'unexpected') return e;
  const k = classifyError(e, url);
  return k.kind === 'unexpected' ? e : new ConnectError(k.message);
};

/**
 * 错误分类：给出准确的类别和文案，不把什么都说成“连接目标库失败”。文案已脱敏（url 是目标库的连接串，用来遮密码）。
 * - 连接类故障 → connect；目标库返回的其他错误（权限不够等）→ database；
 * - 目标库历史与平台版本链对不上 / 被改动（ExecutorError）→ integrity；schema 范围问题（ScopeError）→ scope；
 *   dowel 历史读不了（HistoryError）→ history；其他 → unexpected（只记日志，文案不给细节）。
 * ExecutorError('unexpected') 是执行器包起来的意外错误：按它的 cause 再分类。
 */
export const classifyError = (e: unknown, url = ''): { kind: ErrorKind; message: string } => {
  const raw = e instanceof Error ? e.message : String(e);
  const clean = url ? scrubUrl(raw, url) : scrubSecrets(raw);
  if (e instanceof ExecutorError) {
    if (e.code === 'unexpected' && e.cause !== undefined) return classifyError(e.cause, url);
    return { kind: 'integrity', message: `完整性检查失败：${clean}` };
  }
  if (e instanceof ScopeError) return { kind: 'scope', message: `schema 范围检查失败：${clean}` };
  if (e instanceof HistoryError) return { kind: 'history', message: `读取目标库的 dowel 历史失败：${clean}` };
  if (e instanceof SecretError) return { kind: 'connect', message: clean };
  if (e instanceof ConnectError || isConnectionFailure(e))
    return { kind: 'connect', message: `连接目标库失败：${clean}` };
  if (e instanceof Error && e.name === 'PostgresError')
    return { kind: 'database', message: `目标库返回错误：${clean}` };
  console.error('目标库操作出错（意外）', e);
  return { kind: 'unexpected', message: '意外错误（详情见服务器日志）' };
};

// ───── 事件转换 ─────

export const toExecEvent = (e: ExecutorEvent): ExecEvent => {
  if (e.type === 'phase') return { stage: e.phase };
  if (e.type === 'plan') return { stage: 'plan', baseline: e.baseline, migrations: e.migrations };
  return {
    stage: 'migration',
    status: e.status,
    index: e.index,
    total: e.total,
    versionId: e.versionId,
    number: e.number,
    name: e.name,
    direction: e.direction,
    step: e.step,
    steps: e.steps,
    resumed: e.resumed,
  };
};

/** 错误 → 给客户端的 error 事件字段。预期的拒绝给原因（脱敏在发送时统一做），意外错误只记日志 */
export const errorEvent = (e: unknown): { error: string; code?: string; details?: ExecEvent['details'] } => {
  if (e instanceof ExecutorError && e.code !== 'unexpected') {
    const { diff, diffTotal, problems, versionId, number, step, partial, needsManual, claim } = e.details;
    return {
      error: e.message,
      code: e.code,
      details: { diff, diffTotal, problems, versionId, number, step, partial, needsManual, claim },
    };
  }
  if (e instanceof HTTPException) return { error: e.message, code: 'rejected' };
  // 执行器包起来的意外错误按 cause 分类（这时失败记录已经写进目标库历史）
  const partial = e instanceof ExecutorError ? e.details.partial : undefined;
  const c = classifyError(e instanceof ExecutorError ? e.cause : e);
  if (c.kind === 'unexpected') return { error: '服务器内部错误', code: 'internal', details: { partial } };
  return { error: c.message, code: c.kind, details: { partial } };
};

// ───── 执行 / 回滚 / 写基线 ─────

export interface RunInput {
  pid: string;
  projectName: string;
  env: EnvRow;
  mode: 'migrate' | 'baseline';
  to?: string;
  direction?: 'up' | 'down';
  userId: string;
  onEvent?: (e: ExecEvent) => void | Promise<void>;
}

/**
 * 执行前登记：这个版本即将在这个环境执行，并再确认脚本在这期间没被改过（和编辑脚本在同一把项目行锁里串行）。
 * 返回登记的来源：
 * - 'new'：新插入的 claimed，finally 里按 touched 确认（touched）或撤销（没 touched）；
 * - 'adopted'：已经有一条 claimed，**接管**它——它只可能是进程崩溃留下的。claim 在执行器拿到目标库项目锁**之后**才调用，
   此刻不可能有别的执行在进行；而改连接串 / 删环境在有 claimed 或环境锁被占用时会被拒绝（409），所以登记不会属于一个仍在进行的执行。
   **这个推断只在单进程部署下成立**（EnvLocks 只在本进程内有效，平台库也是单实例）；多进程部署是已知限制，见 05-implementation.md；
   接管来的行：touched 了就确认；**没 touched 就保持 claimed、不撤销**——它不是我们这次插入的，没动过库不代表上一次（崩溃的那次）没动过，
   交给之后在目标库项目锁里运行的同步，按目标库历史来决定；
 * - null：已经 confirmed，保持不动，也不进任何集合。
 */
const claim = async (
  db: PlatformDb,
  pid: string,
  envId: string,
  v: ChainVersion,
  baseline: boolean,
): Promise<'new' | 'adopted' | null> =>
  db.transaction(async (tx) => {
    if (db.dialect === 'pg') await tx.query('select id from projects where id = $1 for update', [pid]);
    const [row] = await tx.query<{ checksum: string; verified_at: unknown }>(
      'select checksum, verified_at from versions where id = $1 and project_id = $2',
      [v.id, pid],
    );
    if (!row || row.checksum !== v.checksum)
      throw new HTTPException(409, { message: `版本 v${v.number} 的脚本在执行前被修改了，请刷新后重试` });
    if (!baseline && (row.verified_at === null || row.verified_at === undefined))
      throw new HTTPException(409, { message: `版本 v${v.number} 在执行前被标为未验证，请重新验证后再执行` });
    const inserted = await tx.query<{ version_id: string }>(
      `insert into environment_versions (environment_id, version_id, state) values ($1, $2, 'claimed')
       on conflict do nothing returning version_id`,
      [envId, v.id],
    );
    if (inserted.length > 0) return 'new';
    const [existing] = await tx.query<{ state: string }>(
      'select state from environment_versions where environment_id = $1 and version_id = $2',
      [envId, v.id],
    );
    return existing?.state === 'claimed' ? 'adopted' : null;
  });

const MANUAL_MESSAGE = '这些差异是上一次执行留下的，需要手工修正'; // 短句；详细说明只在界面文案和文档里留一份

/** “需要人工修正”的结构化信息，补上版本号（checkDrift 的结果和执行失败路径用同一个格式） */
const manualOf = (
  m: { direction: 'up' | 'down' | 'baseline'; versionId: string | null },
  chain: { id: string; number: number }[],
): NeedsManual => ({
  direction: m.direction,
  versionId: m.versionId,
  versionNumber: chain.find((v) => v.id === m.versionId)?.number ?? null,
});

const summaryOf = (
  rep: Extract<DriftReport, { status: 'drifted' }>,
  chain: { id: string; number: number }[],
): DriftSummary => ({
  versionId: rep.version,
  versionNumber: chain.find((v) => v.id === rep.version)?.number ?? null,
  total: rep.diff.total,
  items: rep.diff.items,
  message: rep.needsManual ? MANUAL_MESSAGE : null,
  ...(rep.firstRun ? { firstRun: true } : {}),
  ...(rep.needsManual ? { needsManual: manualOf(rep.needsManual, chain) } : {}),
});

/** 失败日志（缓存写不进去不能悄悄吞掉：记日志，不影响返回给用户的原错误） */
const logFailure = (what: string) => (e: unknown) =>
  console.error(what, e instanceof Error ? scrubSecrets(e.message) : e);

/**
 * 读回校验失败且目标库已被改动：直接用执行器带出来的信息写漂移摘要——读回差异（线上结构 → 目标版本的模型）加上 needsManual，
 * 不再多连一次目标库去检查。之后手动 / 定时的漂移检查会把差异换成“线上结构 → 当前版本的模型”。
 */
const summaryOfReadback = (e: ExecutorError, chain: { id: string; number: number }[]): DriftSummary => ({
  versionId: e.details.comparedVersionId ?? null,
  versionNumber: e.details.comparedNumber ?? null,
  total: e.details.diffTotal ?? e.details.diff?.length ?? 0,
  items: e.details.diff ?? [],
  message: MANUAL_MESSAGE,
  needsManual: manualOf(
    { direction: e.details.direction ?? 'up', versionId: e.details.versionId ?? null },
    chain,
  ),
});

/** 执行因漂移被拒绝时写进缓存的摘要：格式和 checkDrift 给出的完全一致 */
const summaryOfError = (e: ExecutorError, chain: { id: string; number: number }[]): DriftSummary => ({
  versionId: e.details.versionId ?? null,
  versionNumber: e.details.number ?? null,
  total: e.details.diffTotal ?? e.details.diff?.length ?? 0,
  items: e.details.diff ?? [],
  message: e.details.needsManual ? MANUAL_MESSAGE : null,
  ...(e.code === 'first_run_drift' ? { firstRun: true } : {}),
  ...(e.details.needsManual ? { needsManual: manualOf(e.details.needsManual, chain) } : {}),
});

/**
 * 在目标库的项目锁里读历史并同步到平台库缓存（拿不到锁——另一个执行正在进行，可能在别的进程——就返回 null，不同步）。
 * 同步写入必须在锁里：读到的状态和写进缓存的状态之间不能插进一个执行，否则会用旧状态覆盖执行刚留下的结果。
 * 跨进程以目标库的 advisory lock 为准，不依赖本进程的 EnvLocks.busy()。
 */
const syncTarget = async (db: PlatformDb, env: EnvRow, tdb: Db): Promise<TargetState | null> => {
  try {
    return await withProjectLock(tdb, env.project_id, 0, async (c) => {
      // 读目标库和写平台库分开：平台库写入失败是服务端自己的问题，不能被当成目标库的错误；
      // 只记日志、跳过这次同步（状态照常返回，下次读取历史或执行结束时会重新对齐）
      const state = await readState(c, env.project_id);
      try {
        await syncEnvCache(db, env.id, state);
      } catch (e) {
        console.error('同步环境状态到平台库失败（已跳过，下次会重新同步）', e);
      }
      return state;
    });
  } catch (e) {
    if (e instanceof HistoryError && e.code === 'lock_timeout') return null;
    throw e;
  }
};

/** 预演等目标库项目锁的时间：正在执行时报告“锁被占用”，而不是排队等 */
export const DRY_RUN_LOCK_WAIT_MS = 3_000;

/**
 * 只预演：做完全部执行前检查（锁、完整性、认领、漂移、已验证、实例级语句、历史表能不能写），返回将要做的事。
 * **不写目标库、不写平台库**：不取环境锁（不改平台库缓存）、不登记 claimed、不同步缓存。
 * 检查没通过抛 ExecutorError（调用方转成 ok = false 的响应）。
 */
export const dryRunExecution = async (
  x: ExecContext,
  input: Omit<RunInput, 'onEvent' | 'userId'> & { userId: string },
): Promise<ExecuteResult> => {
  const { db } = x;
  const env = await loadEnv(db, input.pid, input.env.id);
  if (x.locks.busy(env.id))
    throw new ExecutorError(
      'lock_timeout',
      '这个环境正在执行另一个操作，现在不能执行（预演检查的就是这一点）',
    );
  const conn = open(decrypt(env.url_enc), x.guard);
  try {
    const chain = await loadChain(db, input.pid);
    if (!chain.length) throw new HTTPException(422, { message: '项目还没有发布任何版本' });
    const settings = await readSettings(db);
    return await execute({
      db: conn.db,
      projectId: input.pid,
      projectName: input.projectName,
      instanceId: settings.instanceId,
      chain,
      mode: input.mode,
      to: input.to,
      direction: input.direction,
      executedBy: input.userId,
      via: 'web',
      lockTimeoutMs: DRY_RUN_LOCK_WAIT_MS,
      dryRun: true,
    });
  } finally {
    await conn.close().catch(() => {});
  }
};

export const runExecution = async (
  x: ExecContext,
  input: RunInput,
): Promise<{ result: ExecuteResult; current: ReturnType<typeof versionRef> | null }> => {
  const { db } = x;
  const { pid } = input;
  const release = await x.locks.acquire(input.env.id);
  let conn: ReturnType<typeof open> | null = null;
  let env = input.env;
  /** 这次新插入的 claimed 登记：finally 里按 touched 确认或撤销 */
  const claimed = new Set<string>();
  /** 接管来的 claimed 登记（崩溃残留）：touched 了就确认；没 touched 保持 claimed，交给之后锁内的同步 */
  const adopted = new Set<string>();
  /** 执行器报告“已经对目标库留下痕迹”的版本（见 ExecuteOptions.onTouch），不管后来失败成了什么类型的错误 */
  const touched = new Set<string>();
  try {
    // 拿到环境锁之后重新读环境行再解密：等锁期间 PATCH（持有同一把锁）可能已经换了连接串，或者环境已经被删除（404）；
    // 用新 URL，不用请求开始时读到的旧 URL。解密 / 建连接都在 try 里，失败也一定释放锁
    env = await loadEnv(db, pid, input.env.id);
    conn = open(decrypt(env.url_enc), x.guard);
    const chain = await loadChain(db, pid);
    if (!chain.length) throw new HTTPException(422, { message: '项目还没有发布任何版本' });
    const settings = await readSettings(db);
    const emit = async (e: ExecutorEvent) => void (await input.onEvent?.(toExecEvent(e)));
    try {
      const result = await execute({
        db: conn.db,
        projectId: pid,
        projectName: input.projectName,
        instanceId: settings.instanceId,
        chain,
        mode: input.mode,
        to: input.to,
        direction: input.direction,
        executedBy: input.userId,
        via: 'web',
        onEvent: emit,
        beforeMigration: async (m) => {
          const k = await claim(db, pid, env.id, m.version, m.direction === 'baseline');
          if (k === 'new') claimed.add(m.version.id);
          else if (k === 'adopted') adopted.add(m.version.id);
        },
        onTouch: (m) => void touched.add(m.version.id),
        afterMigration: async (m) => {
          // 执行成功：永久写下“执行过”（executed_at，只写一次），登记改成 confirmed
          await confirmVersion(db, env.id, m.version.id);
          claimed.delete(m.version.id);
          adopted.delete(m.version.id);
          await db.query('update environments set current_version_id = $2 where id = $1', [env.id, m.to.id]);
          await setDrift(db, env.id, 'ok', null);
        },
      });
      const cur = result.current ? chain.find((v) => v.id === result.current) : undefined;
      return { result, current: cur ? versionRef(cur) : null };
    } catch (e) {
      if (e instanceof ExecutorError) {
        // 因漂移被拒绝：顺便把结果记进环境的漂移状态（含 needsManual，格式和 checkDrift 一致），环境页和图标栏马上能看到
        if ((e.code === 'drift' || e.code === 'first_run_drift') && e.details.diff)
          await setDrift(db, env.id, 'drifted', summaryOfError(e, chain)).catch(
            logFailure('写入漂移状态失败'),
          );
        // 读回校验失败且目标库已被改动（需要人工修正）：同一次请求里就把漂移状态设成 drifted，不能停在前一个迁移设下的 ok
        else if (e.code === 'readback_mismatch' && e.details.partial === true)
          await setDrift(db, env.id, 'drifted', summaryOfReadback(e, chain)).catch(
            logFailure('写入漂移状态失败'),
          );
      }
      throw e;
    }
  } finally {
    // 还没确认的登记（这次新登记、执行没有成功完成的）按执行器报告的 touched 处理，和错误是什么类型无关：
    // 动过目标库 → 版本算执行过（永久）；没动过（ensureHistory 权限不足、startRun 失败、事务整体回滚……）→ 撤销登记，版本还能修脚本。
    // 做不到的（平台库写失败）只记日志：残留的 claimed 由下一次在目标库项目锁里的同步清理
    for (const vid of claimed) {
      try {
        if (touched.has(vid)) await confirmVersion(db, env.id, vid);
        else await releaseClaim(db, env.id, vid);
      } catch (e) {
        console.error('处理执行登记失败（下次同步会清理）', e instanceof Error ? scrubSecrets(e.message) : e);
      }
    }
    // 接管来的：touched 了才确认；没 touched 就保持 claimed，不撤销（见 claim）
    for (const vid of adopted)
      if (touched.has(vid))
        await confirmVersion(db, env.id, vid).catch(logFailure('处理执行登记失败（下次同步会清理）'));
    if (conn) {
      // 以目标库的历史为准把缓存完全对齐（在项目锁里做，拿不到锁就跳过；平台库写失败只记日志）
      try {
        await (x.syncTarget ?? syncTarget)(db, env, conn.db);
      } catch (e) {
        console.error(
          '读取目标库历史失败（下次读取历史时会重新同步）',
          e instanceof Error ? scrubSecrets(e.message) : e,
        );
      }
      await conn.close().catch(() => {});
    }
    release();
  }
};

/**
 * 改连接配置（连接串 / 影子库 / 是否允许同实例）、删除环境之前：**本进程**不能正在对这个环境执行。占住环境锁（拿不到立刻 409，
 * “环境正在执行，稍后再改”，不等待，**不产生任何副作用**），改完（或失败）后调用返回的释放函数。
 * 先拿锁、再做 inspectTarget / claimShadow 这些外部检查：被 409 拒绝的请求不会碰任何数据库。
 * 锁也让“等锁的执行”在改完之后才开始，并且（runExecution 拿锁后重新读环境行）用新的 URL。
 * 同步（syncEnvCache）清理 claimed 残留，依赖“持有目标库项目锁 = 没有执行在进行”；这个前提**只在单进程部署下成立**
 * （EnvLocks 是进程内的），多进程部署是已知限制，见 05-implementation.md。
 */
export const lockEnvIdle = (x: ExecContext, envId: string): Promise<() => void> =>
  x.locks.acquire(envId, 0, '环境正在执行，稍后再改');

/**
 * 在改连接配置 / 删环境的**同一个平台库事务**里调用：本进程没有在执行（已经占住环境锁），所以环境上残留的 claimed
 * 只可能是进程崩溃留下的。保守处理：把这些版本当作执行过（写 executed_at），删掉 claimed 行，不阻止修改。
 * 最坏的结果是：一个其实没碰过目标库的版本不能再编辑了；不会让碰过库的版本又能编辑。
 */
export const settleClaims = async (tx: Db, envId: string) => {
  const rows = await tx.query<{ version_id: string }>(
    "select version_id from environment_versions where environment_id = $1 and state = 'claimed'",
    [envId],
  );
  for (const r of rows) await markExecuted(tx, r.version_id);
  if (rows.length)
    await tx.query("delete from environment_versions where environment_id = $1 and state = 'claimed'", [
      envId,
    ]);
};

// ───── 读历史 ─────

/** 读目标库的历史；sync 为真时顺便同步到平台库缓存（在项目锁里，拿不到锁就只读不同步） */
export const readTargetState = async (x: ExecContext, env: EnvRow, sync = false): Promise<TargetState> => {
  const url = decrypt(env.url_enc);
  let conn: ReturnType<typeof open> | null = null;
  try {
    conn = open(url, x.guard, CHECK_CONNECT_TIMEOUT);
    return (
      (sync ? await (x.syncTarget ?? syncTarget)(x.db, env, conn.db) : null) ??
      (await readState(conn.db, env.project_id))
    );
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(classifyError(e, url).message);
  } finally {
    await conn?.close().catch(() => {});
  }
};

export const runInfoOf = (
  r: TargetState['runs'][number],
  refs: Map<string, { id: string; number: number; name: string }>,
  names: Map<string, string> = new Map(),
): RunInfo => {
  const ref = (id: string) => {
    const v = refs.get(id);
    return v ? versionRef(v) : { id, number: -1, name: id };
  };
  return {
    id: r.id,
    fromVersion: r.fromVersion ? ref(r.fromVersion) : null,
    toVersion: ref(r.toVersion),
    direction: r.direction,
    status: r.status,
    stepIndex: r.stepIndex,
    // 内部标记（读回校验失败）只在 executor 的 state.ts 里识别，这里转成结构化字段并剥掉
    error: r.error ? scrubSecrets(stripReadbackMark(r.error)) : null,
    readbackFailure: isReadbackFailure(r.error),
    executedBy: r.executedBy,
    executedByName: (r.executedBy && names.get(r.executedBy)) || null,
    via: r.via,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
};

// ───── 漂移检查 ─────

/**
 * 检查一个环境的漂移并写进缓存。手动检查和定时检查共用。
 * 正在执行 / 上次停在中途 / 项目没有版本时跳过（不改缓存）；检查失败记为 error，并按真实原因分类
 * （连不上、目标库返回错误、历史与版本链对不上、schema 范围有问题……），文案说明真实原因。
 */
export const checkEnvDrift = async (x: ExecContext, given: EnvRow): Promise<DriftCheckResponse> => {
  const { db } = x;
  // 重新读一遍环境行：调用方（定时检查一轮里的后面几个环境）手里的可能已经过期（换了连接串、被删了：404）
  const env = await loadEnv(db, given.project_id, given.id);
  // 所有返回的漂移信息都经过 driftInfo（清洗旧格式）
  const current = (): DriftInfo => driftInfo(env);
  if (x.locks.busy(env.id)) return { ...current(), skipped: 'busy' };
  let url = '';
  let conn: ReturnType<typeof open> | null = null;
  try {
    url = decrypt(env.url_enc);
    const chain = await loadChain(db, env.project_id);
    conn = open(url, x.guard, CHECK_CONNECT_TIMEOUT);
    const rep = await checkDrift({ db: conn.db, projectId: env.project_id, chain });
    if (rep.status === 'skipped') return { ...current(), skipped: rep.reason };
    // 检查期间如果开始了执行，结果作废（结构可能是半途状态）
    if (x.locks.busy(env.id)) return { ...current(), skipped: 'busy' };
    const at = new Date().toISOString();
    if (rep.status === 'ok') {
      await setDrift(db, env.id, 'ok', null, at);
      return { status: 'ok', checkedAt: at, summary: null, skipped: null };
    }
    const summary = summaryOf(rep, chain);
    await setDrift(db, env.id, 'drifted', summary, at);
    return { status: 'drifted', checkedAt: at, summary, skipped: null };
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    const c = classifyError(e, url);
    return recordError(db, env, c.kind, c.message);
  } finally {
    await conn?.close().catch(() => {});
  }
};

const recordError = async (
  db: PlatformDb,
  env: EnvRow,
  errorKind: ErrorKind,
  message: string,
): Promise<DriftCheckResponse> => {
  const at = new Date().toISOString();
  const summary: DriftSummary = {
    versionId: null,
    versionNumber: null,
    total: 0,
    items: [],
    message: scrubSecrets(message),
    errorKind,
  };
  await setDrift(db, env.id, 'error', summary, at);
  return { status: 'error', checkedAt: at, summary, skipped: null };
};

// ───── 标记为已执行（ADR 0004） ─────

export interface MarkInput {
  pid: string;
  projectName: string;
  env: EnvRow;
  /** 目标版本 ID */
  to: string;
  userId: string;
  /** 向前标记：用户确认了“被跳过的版本里的脚本效果已经手工完成，或者不需要”（执行器在锁里检查，建 schema 之前） */
  acknowledge?: boolean;
  /** 预演时拿到的计划：确认绑定到它，不一致执行器拒绝（plan_changed） */
  expect?: MarkExpect;
}

/**
 * 标记为已执行：不执行 SQL，只写一条 direction = 'mark' 的历史。平台库的登记沿用执行的那一套（claimed → confirmed）：
 * - 向前标记：目标版本和中间跳过的版本都算“执行过”——写前登记 claimed（不要求已验证：不跑脚本），**事务提交之后**
 *   才确认（executed_at + confirmed）；目标库没被改动的失败撤销登记；崩溃留下的由下一次锁内的同步按目标库的**版本行**对齐；
 * - 向后标记：不写 executed_at、不登记（这些版本本来就执行过，或者没有——标记不改变它）。
 * 环境锁、目标库项目锁、拿到锁后重新读环境行，和 runExecution 一样。
 * P5 扩展点：接审批以后，批准绑定“起止版本 + MarkPlan.fingerprint”，在 beforeMark 里核对；标记不受前置环境约束（不跑脚本），
 * 豁免写进审计（路由层的审计数据里已经有 prerequisiteExempt）。
 */
export const runMark = async (x: ExecContext, input: MarkInput): Promise<MarkResult> => {
  const { db } = x;
  const { pid } = input;
  const release = await x.locks.acquire(input.env.id);
  let conn: ReturnType<typeof open> | null = null;
  let env = input.env;
  const claimed = new Set<string>();
  const adopted = new Set<string>();
  const touched = new Set<string>();
  try {
    env = await loadEnv(db, pid, input.env.id);
    conn = open(decrypt(env.url_enc), x.guard);
    const chain = await loadChain(db, pid);
    if (!chain.length) throw new HTTPException(422, { message: '项目还没有发布任何版本' });
    const settings = await readSettings(db);
    return await markApplied({
      db: conn.db,
      projectId: pid,
      projectName: input.projectName,
      instanceId: settings.instanceId,
      chain,
      to: input.to,
      executedBy: input.userId,
      via: 'web',
      lockTimeoutMs: x.lockTimeoutMs,
      acknowledge: input.acknowledge,
      expect: input.expect,
      beforeMark: async (p: MarkPlan) => {
        for (const v of p.skipped) {
          // baseline = true：不要求已验证（标记不执行脚本）
          const k = await claim(db, pid, env.id, v, true);
          if (k === 'new') claimed.add(v.id);
          else if (k === 'adopted') adopted.add(v.id);
        }
      },
      onTouch: (p) => {
        for (const v of p.skipped) touched.add(v.id);
      },
      afterMark: async (p) => {
        for (const v of p.skipped) {
          await confirmVersion(db, env.id, v.id);
          claimed.delete(v.id);
          adopted.delete(v.id);
        }
        await db.query('update environments set current_version_id = $2 where id = $1', [env.id, p.to.id]);
        await setDrift(db, env.id, 'ok', null);
      },
    });
  } finally {
    for (const vid of claimed) {
      try {
        if (touched.has(vid)) await confirmVersion(db, env.id, vid);
        else await releaseClaim(db, env.id, vid);
      } catch (e) {
        console.error('处理标记登记失败（下次同步会清理）', e instanceof Error ? scrubSecrets(e.message) : e);
      }
    }
    for (const vid of adopted)
      if (touched.has(vid))
        await confirmVersion(db, env.id, vid).catch(logFailure('处理标记登记失败（下次同步会清理）'));
    if (conn) {
      try {
        await (x.syncTarget ?? syncTarget)(db, env, conn.db);
      } catch (e) {
        console.error(
          '读取目标库历史失败（下次读取历史时会重新同步）',
          e instanceof Error ? scrubSecrets(e.message) : e,
        );
      }
      await conn.close().catch(() => {});
    }
    release();
  }
};

/** 标记的预演：核对线上结构、列出被跳过的版本；不写目标库、不写平台库的登记（不取环境锁，只等目标库项目锁几秒） */
export const dryRunMark = async (
  x: ExecContext,
  input: Pick<MarkInput, 'pid' | 'projectName' | 'env' | 'to' | 'userId'>,
): Promise<MarkResult> => {
  const { db } = x;
  const env = await loadEnv(db, input.pid, input.env.id);
  if (x.locks.busy(env.id))
    throw new ExecutorError(
      'lock_timeout',
      '这个环境正在执行另一个操作，现在不能标记（预演检查的就是这一点）',
    );
  const conn = open(decrypt(env.url_enc), x.guard);
  try {
    const chain = await loadChain(db, input.pid);
    if (!chain.length) throw new HTTPException(422, { message: '项目还没有发布任何版本' });
    return await markApplied({
      db: conn.db,
      projectId: input.pid,
      projectName: input.projectName,
      instanceId: (await readSettings(db)).instanceId,
      chain,
      to: input.to,
      executedBy: input.userId,
      lockTimeoutMs: DRY_RUN_LOCK_WAIT_MS,
      dryRun: true,
    });
  } finally {
    await conn.close().catch(() => {});
  }
};

// ───── 保留线上的修改：导入 ─────

export interface LiveRead {
  /** 线上结构导入成的模型（对象 ID 已按名字沿用 base 里的） */
  model: Model;
  /** 线上结构的指纹 */
  fingerprint: string;
  /** 目标库历史（读不到时为 null：只影响警告，不挡着导入） */
  state: TargetState | null;
}

/**
 * 读出环境的线上结构（只读：SET + SELECT，只读 scope 范围内的），用 reconcileIds 按名字沿用 `base`（工作副本）里的对象 ID；
 * 顺带读目标库历史，判断有没有半途失败的迁移（警告用）。
 */
export const readLive = async (
  x: ExecContext,
  env: EnvRow,
  scope: string[] | null,
  base: Model,
): Promise<LiveRead> => {
  const url = decrypt(env.url_enc);
  const conn = open(url, x.guard, CHECK_CONNECT_TIMEOUT);
  try {
    const snapshot = await readSnapshot(conn.db, scope);
    // 和漂移检查、标记的核对同一套规则（compare.ts 的 importLive：按名字沿用 base 里的对象 ID，忽略 public 的默认注释）
    const model = importLive(snapshot, base);
    const state = await readState(conn.db, env.project_id).catch(() => null);
    return { model, fingerprint: fingerprint(snapshot), state };
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new ConnectError(classifyError(e, url).message);
  } finally {
    await conn.close().catch(() => {});
  }
};
