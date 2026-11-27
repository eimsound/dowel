// 执行器：沿冻结的版本链逐个执行 / 回滚迁移，全面由 EngineAdapter 驱动。
import {
  type Dialect,
  emptyBase,
  findInstanceLevelStep,
  isConcurrentDdlSql,
  isNontransactionalSql,
  type Step,
  scrubSecrets,
  verifiedForEngine,
} from '@dowel/core';
import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  getEngine,
  HistoryError,
  indexTree,
  NO_TIMEOUTS,
  parsePgCreateIndexConcurrently,
  parsePgDetachConcurrently,
  readEngineFullVersion,
  routeBetween,
  routeShape,
  type RouteShape,
  type ScriptStep,
  type TxHooks,
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

// 保留旧导出兼容既有 PG 单测
export {
  parsePgCreateIndexConcurrently as parseCreateIndexConcurrently,
  parsePgDetachConcurrently as parseDetachConcurrently,
};

type DryRunChecks = DryRunPlan['checks'];

/** 这一步不能放进外层事务：冻结脚本里的标记，加上语句文本的判断（双保险） */
export const isNonTx = (s: ScriptStep, dialect: Dialect = 'pg'): boolean =>
  !s.transactional || isNontransactionalSql(s.sql, dialect);

const errText = (e: unknown, max = 2000): string => {
  const t = scrubSecrets(e instanceof Error ? e.message : String(e));
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

class StepFailure extends Error {
  index: number;
  hint: string;
  applied: AppliedTimeouts;
  constructor(index: number, cause: unknown, hint = '', applied: AppliedTimeouts = NO_TIMEOUTS) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.index = index;
    this.hint = hint;
    this.applied = applied;
  }
}

const upMigration = (byId: ReadonlyMap<string, ChainVersion>, v: ChainVersion): Migration => ({
  version: v,
  direction: 'up',
  from: v.parentId ? (byId.get(v.parentId) ?? null) : null,
  to: v,
  steps: v.upSteps,
});
const downMigration = (byId: ReadonlyMap<string, ChainVersion>, v: ChainVersion): Migration => {
  const parent = v.parentId ? byId.get(v.parentId) : undefined;
  if (!parent)
    throw new ExecutorError('chain_broken', `版本 ${label(v)} 缺少父版本，无法回滚`, {
      versionId: v.id,
      number: v.number,
    });
  return {
    version: v,
    direction: 'down',
    from: v,
    to: parent,
    steps: v.downSteps,
  };
};
const baselineMigration = (v: ChainVersion): Migration => ({
  version: v,
  direction: 'baseline',
  from: null,
  to: v,
  steps: [],
});

const label = (v: ChainVersion) => `v${v.number}「${v.name}」`;

export const inTx = async <T>(
  conn: Db,
  fn: () => Promise<T>,
  hooks: TxHooks = {},
  dialect: Dialect = 'pg',
): Promise<T> => getEngine(dialect).inTransaction(conn, fn, hooks);

interface Ctx {
  o: ExecuteOptions;
  dialect: Dialect;
  engine: EngineAdapter;
  emit: (e: ExecutorEvent) => Promise<void>;
  touch: (m: Migration) => void;
}

const verifyAndRecord = async (conn: Db, c: Ctx, m: Migration) => {
  const snapshot = await c.engine.readSnapshot(conn, m.to.scope);
  const diff = diffAgainst(snapshot, m.to.model);
  if (diff.total)
    throw new ExecutorError(
      'readback_mismatch',
      `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}执行完后，读回的结构与 ${label(m.to)} 的模型不一致（${diff.total} 处差异）`,
      { diff: diff.items, diffTotal: diff.total, comparedVersionId: m.to.id, comparedNumber: m.to.number },
    );
  await c.engine.history.recordVersion(conn, {
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
    fingerprint: c.engine.fingerprint(snapshot),
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

const seconds = (ms: number) => (ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`);

const wrap = (e: unknown, c: Ctx, m: Migration, partial: boolean): ExecutorError => {
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
    const timeout = c.engine.classifyTimeout(e.cause, e.applied);
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
  c: Ctx,
  steps: ScriptStep[],
  i: number,
  hint = '',
  applied: AppliedTimeouts = NO_TIMEOUTS,
  sql = steps[i]!.sql,
) => {
  try {
    await c.engine.execStepSql(conn, sql);
  } catch (e) {
    throw new StepFailure(i, e, hint, applied);
  }
};

const writeBaseline = async (conn: Db, c: Ctx, m: Migration, snapshotFp: string): Promise<number> => {
  return c.engine.inTransaction(
    conn,
    async () => {
      await c.engine.history.recordVersion(conn, {
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
      const id = await c.engine.history.startRun(conn, runBase(c, m));
      await c.engine.history.finishRun(conn, id, 'done');
      return id;
    },
    { beforeCommit: () => c.touch(m) },
  );
};

const runMigration = async (
  conn: Db,
  c: Ctx,
  m: Migration,
  pos: { index: number; total: number },
  resumeAfter: number | null,
  resumeFromCrash = false,
): Promise<number> => {
  const { steps } = m;
  const { engine, dialect } = c;
  const stepNonTx = (s: ScriptStep) => isNonTx(s, dialect);
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

  if (!steps.some(stepNonTx)) {
    let runId = 0;
    try {
      runId = await engine.inTransaction(
        conn,
        async () => {
          await engine.pinSession(conn);
          const id = await engine.history.startRun(conn, runBase(c, m));
          const applied = await engine.applyTimeouts(conn, c.o.timeouts);
          try {
            for (let i = 0; i < steps.length; i++) await execStep(conn, c, steps, i, '', applied);
          } finally {
            await engine.restoreTimeouts(conn, applied).catch(() => {});
          }
          await verifyAndRecord(conn, c, m);
          await engine.history.finishRun(conn, id, 'done');
          return id;
        },
        { afterCommit: () => c.touch(m) },
      );
    } catch (e) {
      const err = wrap(e, c, m, false);
      await engine
        .inTransaction(conn, async () => {
          const id = await engine.history.startRun(conn, runBase(c, m));
          await engine.history.finishRun(conn, id, 'failed', errText(err));
        })
        .catch((x) => console.error('写入失败的执行记录出错', errText(x)));
      throw err;
    }
    for (let i = 1; i <= steps.length; i++) await event('step', { step: i, steps: steps.length });
    await event('done', { steps: steps.length });
    return runId;
  }

  const runId = await engine.history.startRun(conn, runBase(c, m));
  let done = resumeAfter ?? -1;
  let touched = done >= 0;
  if (touched) c.touch(m);
  try {
    if (done >= 0) await engine.history.markStep(conn, runId, done);
    let completed = false;
    let i = done + 1;
    while (i < steps.length) {
      if (stepNonTx(steps[i]!)) {
        if (!touched) {
          c.touch(m);
          await engine.history.markStep(conn, runId, -1);
          touched = true;
        }
        await engine.pinSession(conn);
        const applied = await engine.applyTimeouts(conn, c.o.timeouts, {
          concurrent: isConcurrentDdlSql(steps[i]!.sql, dialect),
        });
        try {
          const isResumeStep = resumeAfter !== null && i === done + 1;
          const prep = engine.beforeNonTxStep
            ? await engine.beforeNonTxStep(conn, steps[i]!.sql, isResumeStep)
            : {};
          try {
            await execStep(conn, c, steps, i, prep.hint ?? '', applied, prep.sql);
          } catch (stepErr) {
            if (
              resumeFromCrash &&
              isResumeStep &&
              engine.detectStepAlreadyApplied &&
              (await engine.detectStepAlreadyApplied(
                conn,
                steps[i]!,
                stepErr instanceof StepFailure ? stepErr.cause : stepErr,
              ))
            ) {
              // 崩溃前 DDL 已提交但尚未落盘 markStep：幂等跳过
            } else {
              throw stepErr;
            }
          }
        } finally {
          await engine.afterNonTxStep?.(conn, steps[i]!.sql).catch(() => {});
          await engine.restoreTimeouts(conn, applied).catch(() => {});
        }
        await engine.history.markStep(conn, runId, i);
        done = i;
        i++;
        await event('step', { step: i, steps: steps.length });
      } else {
        let j = i;
        while (j < steps.length && !stepNonTx(steps[j]!)) j++;
        const last = j === steps.length;
        await engine.inTransaction(
          conn,
          async () => {
            await engine.pinSession(conn);
            const applied = await engine.applyTimeouts(conn, c.o.timeouts);
            try {
              for (let k = i; k < j; k++) await execStep(conn, c, steps, k, '', applied);
            } finally {
              await engine.restoreTimeouts(conn, applied).catch(() => {});
            }
            if (last) {
              await verifyAndRecord(conn, c, m);
              await engine.history.markStep(conn, runId, j - 1);
              await engine.history.finishRun(conn, runId, 'done');
            } else await engine.history.markStep(conn, runId, j - 1);
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
      await engine.inTransaction(
        conn,
        async () => {
          await verifyAndRecord(conn, c, m);
          await engine.history.finishRun(conn, runId, 'done');
        },
        { afterCommit: () => c.touch(m) },
      );
  } catch (e) {
    const err = wrap(e, c, m, touched);
    const text = err.code === 'readback_mismatch' ? markReadbackError(errText(err)) : errText(err);
    await engine.history
      .finishRun(conn, runId, 'failed', text)
      .catch((x) => console.error('结束失败的执行记录出错', errText(x)));
    throw err;
  }
  await event('done', { steps: steps.length });
  return runId;
};

interface PlannedRoute {
  lca: ChainVersion | null;
  shape: RouteShape;
  migrations: Migration[];
}

const buildRoute = (
  byId: ReadonlyMap<string, ChainVersion>,
  fromId: string | null,
  toId: string,
): PlannedRoute => {
  const r = routeBetween(byId, fromId, toId);
  if (!r) throw new ExecutorError('chain_broken', '平台库里的版本树断裂，无法规划执行路线');
  return {
    lca: r.lca,
    shape: routeShape(r),
    migrations: [...r.down.map((v) => downMigration(byId, v)), ...r.up.map((v) => upMigration(byId, v))],
  };
};

/**
 * 执行 / 回滚 / 预演之前的检查：每个要执行的迁移都必须已验证；给了 verifiedOn 的版本（需要外部影子库的方言，
 * ADR 0017 决定 5）还必须有与**目标库数据库完整版本号**一致的通过记录——紧急执行、CI 令牌、执行申请都走这里，不绕过。
 * 目标库版本只在需要时读一次（不连影子库）。
 */
const preflight = async (conn: Db, migrations: Migration[], dialect: Dialect) => {
  let engineVersion: string | null | undefined;
  for (const m of migrations) {
    if (m.direction === 'baseline') continue;
    const verb = m.direction === 'down' ? '回滚' : '执行';
    if (!m.version.verified)
      throw new ExecutorError(
        'unverified',
        `${label(m.version)}还没有通过影子库验证，不能${verb}。请先在版本页“重新验证”`,
        { versionId: m.version.id, number: m.version.number, direction: m.direction },
      );
    const verifiedOn = m.version.verifiedOn;
    if (verifiedOn) {
      if (engineVersion === undefined) engineVersion = await readEngineFullVersion(dialect, conn);
      if (!verifiedForEngine(dialect, verifiedOn, engineVersion))
        throw new ExecutorError(
          'unverified',
          engineVersion === null
            ? `读不到目标库的数据库版本，无法确认${label(m.version)}是否在同版本的影子库上验证过，不能${verb}`
            : `${label(m.version)}还没有在数据库版本 ${engineVersion} 的影子库上验证通过（已验证：${verifiedOn.length ? verifiedOn.join('、') : '无'}），不能${verb}到这个环境。` +
                '请先为与目标库版本一致的影子库（或允许同实例影子库）重新验证这个版本',
          {
            versionId: m.version.id,
            number: m.version.number,
            direction: m.direction,
            engineVersion,
            verifiedOn: [...verifiedOn],
          },
        );
    }
    const steps: Step[] = m.steps.map((s) => ({ kind: 'frozen', target: '', sql: s.sql }));
    const bad = findInstanceLevelStep(steps, dialect);
    if (bad >= 0)
      throw new ExecutorError(
        'instance_level',
        `${label(m.version)}${m.direction === 'down' ? '的回滚' : ''}脚本第 ${bad + 1} 步含实例级语句（作用于整个数据库实例或外部文件，不只是这个库），不能执行`,
        { versionId: m.version.id, number: m.version.number, direction: m.direction, step: bad + 1 },
      );
  }
};

const manualNote = (state: TargetState): string =>
  state.readbackFailure ? '（这些差异是上一次执行留下的，需要手工修正）' : '';

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
  const { o, dialect, engine } = c;
  const { chain } = o;
  await c.emit({ type: 'phase', phase: 'integrity' });
  if (o.dryRun) {
    const problem = await engine.history.historyWriteProblem(conn);
    if (problem) throw new ExecutorError(problem.code, scrubSecrets(problem.message));
  } else if (await engine.history.historyExists(conn)) await ensureHistoryMapped(conn, dialect);
  const state: TargetState = await readState(conn, o.projectId, dialect);
  assertTargetHistory(state, chain, o.instanceId);

  const byId = indexTree(chain);
  const first = chain.find((v) => v.parentId === null) ?? chain[0];
  if (!first) throw new ExecutorError('unknown_version', '项目还没有发布任何版本');
  const target = byId.get(o.to);
  if (!target) throw new ExecutorError('unknown_version', `目标版本不存在：${o.to}`);
  const cur = state.current === null ? null : (byId.get(state.current) ?? null);
  if (state.current !== null && !cur)
    throw new ExecutorError(
      'history_mismatch',
      `目标库历史里的当前版本 ${state.current} 不在平台库的版本链上`,
    );
  const refOf = (v: ChainVersion | null | undefined) =>
    v ? { id: v.id, number: v.number, name: v.name } : null;

  let planned: PlannedRoute = { lca: null, shape: 'none', migrations: [] };
  let migrations: Migration[] = [];
  let baseline: Migration | null = null;
  let resumeAfter: number | null = null;
  let resumeFromCrash = false;
  let snapshotFp = '';

  if (state.unfinished) {
    const p = state.unfinished;
    const want = runVersionId(p);
    const openVer = want ? byId.get(want) : undefined;
    // 上一次升级停在中途的版本已被作废：给出可操作的错误码 retired_target，而不是令人困惑的 unfinished_run
    if (p.direction === 'up' && openVer?.retired)
      throw new ExecutorError(
        'retired_target',
        `版本 ${label(openVer)} 在上一次升级停在中途后已被作废，不能继续升级到它。` +
          '如果尚未发布更新版本，可以先取消作废后再继续；否则请先手工恢复目标库结构到祖先或活跃版本，再使用“标记为已执行”',
        {
          versionId: openVer.id,
          number: openVer.number,
          direction: 'up',
          partial: true,
          reached: state.current,
        },
      );
    planned = buildRoute(byId, state.current, target.id);
    migrations = planned.migrations;
    const m0 = migrations[0];
    if (!m0 || m0.direction !== p.direction || m0.version.id !== want) {
      throw new ExecutorError(
        'unfinished_run',
        `上一次${p.direction === 'down' ? '回滚' : '执行'}${openVer ? ` ${label(openVer)}` : ''}${p.status === 'running' ? '被中断了' : '失败了'}，停在第 ${(p.stepIndex ?? -1) + 2} 步之前，目标库处于半途状态。` +
          `必须先继续执行它（把目标版本设为${p.direction === 'down' ? '它的回滚目标或更早的版本' : ' 它或更靠后的版本'}），不能改做别的`,
        {
          versionId: want ?? undefined,
          direction: p.direction === 'baseline' ? undefined : p.direction,
          partial: true,
        },
      );
    }
    resumeAfter = p.stepIndex ?? -1;
    resumeFromCrash = p.status === 'running';
  } else if (state.current === null) {
    await c.emit({ type: 'phase', phase: 'drift' });
    const snapshot = await engine.readSnapshot(conn, first.scope);
    const cls = classifyFirstRun(snapshot, first, emptyBase(first.model, first.scope));
    if (cls.kind === 'drift')
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
      planned = buildRoute(byId, first.id, target.id);
      if (!planned.migrations.length) {
        if (o.direction === 'down')
          throw new ExecutorError('wrong_direction', '这个库还没有 Dowel 的历史，不能回滚', {
            versionId: target.id,
            reached: null,
          });
        throw new ExecutorError(
          'mark_required',
          `这个库还没有 Dowel 的历史，且结构已经等于 ${label(first)}，没有可执行的迁移。` +
            '如果只想先建立历史基准而不执行迁移，请改用“标记为已执行”；或者等发布新版本后，在执行新版本时自动写入基线',
          { versionId: first.id, number: first.number, reached: null },
        );
      }
      baseline = baselineMigration(first);
      snapshotFp = engine.fingerprint(snapshot);
    } else planned = buildRoute(byId, null, target.id);
    migrations = planned.migrations;
  } else {
    planned = buildRoute(byId, state.current, target.id);
    migrations = planned.migrations;
    if (!migrations.length) {
      if (target.retired && o.direction !== 'down')
        throw new ExecutorError('retired_target', `版本 ${label(target)} 已作废，不能升级到它`, {
          versionId: target.id,
          number: target.number,
          direction: 'up',
          reached: state.current,
        });
      if (o.expect) assertExpected(o.expect, state.current, migrations);
      const ref = refOf(cur);
      return {
        direction: 'none',
        lca: null,
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
                lca: null,
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
    const snapshot = await engine.readSnapshot(conn, cur!.scope);
    const recorded = state.versions.find((v) => v.versionId === cur!.id)?.fingerprint;
    if (!recorded || recorded !== engine.fingerprint(snapshot)) {
      const diff = diffAgainst(snapshot, cur!.model);
      if (diff.total)
        throw new ExecutorError(
          'drift',
          `目标库的结构与环境当前版本 ${label(cur!)} 不一致（${diff.total} 处差异），可能有人绕过 Dowel 直接改过库。已拒绝执行${manualNote(state)}`,
          {
            diff: diff.items,
            diffTotal: diff.total,
            versionId: cur!.id,
            number: cur!.number,
            ...manualOf(state),
          },
        );
    }
  }

  // ADR 0013：不允许升级（up）到任何已作废版本（回滚 down 允许，switch 的回滚段也允许）
  for (const m of migrations) {
    if (m.direction === 'up' && m.version.retired)
      throw new ExecutorError('retired_target', `版本 ${label(m.version)} 已作废，不能升级到它`, {
        versionId: m.version.id,
        number: m.version.number,
        direction: 'up',
        reached: state.current,
      });
  }

  if (o.direction && planned.shape !== 'none') {
    if (o.direction === 'up') {
      if (planned.shape === 'switch')
        throw new ExecutorError(
          'switch_required',
          `环境当前停在已作废岔路 ${cur ? label(cur) : ''} 上，到 ${label(target)} 需要先回滚到公共祖先 ${label(planned.lca!)} 再升级：请改用“切换”并确认回滚段`,
          {
            versionId: target.id,
            number: target.number,
            reached: state.current,
            lca: refOf(planned.lca)!,
          },
        );
      if (planned.shape === 'down')
        throw new ExecutorError(
          'wrong_direction',
          `目标版本 ${label(target)} 比环境当前版本更早，这是回滚，不是执行`,
          { versionId: target.id, reached: state.current },
        );
    } else if (o.direction === 'down' && planned.shape !== 'down') {
      throw new ExecutorError(
        'wrong_direction',
        planned.shape === 'switch'
          ? `目标版本 ${label(target)} 不在当前版本的祖先路径上，需要先回滚到 ${label(planned.lca!)} 再升级，请改用“切换”`
          : `目标版本 ${label(target)} 比环境当前版本更新，这是执行，不是回滚`,
        { versionId: target.id, reached: state.current },
      );
    } else if (o.direction === 'switch' && planned.shape !== 'switch') {
      throw new ExecutorError(
        'wrong_direction',
        `从当前版本到 ${label(target)} 不需要跨岔路切换，请改用${planned.shape === 'down' ? '“回滚”' : '“执行”'}`,
        { versionId: target.id, reached: state.current },
      );
    }
  }
  await preflight(conn, migrations, dialect);
  if (o.expect) assertExpected(o.expect, state.current, migrations);
  const direction: ExecuteResult['direction'] = planned.shape;
  const lcaRef = planned.shape === 'switch' ? refOf(planned.lca) : null;
  if (o.dryRun) {
    const lastTo = migrations.at(-1)?.to ?? (baseline ? first : cur);
    const stepNonTx = (s: ScriptStep) => isNonTx(s, dialect);
    return {
      direction,
      lca: lcaRef,
      baseline: baseline !== null,
      ran: [],
      from: state.current,
      current: state.current,
      dryRun: {
        firstRun: state.current === null && !state.unfinished ? (baseline ? 'baseline' : 'empty') : null,
        baseline: baseline !== null,
        from: refOf(cur),
        to: refOf(lastTo),
        lca: lcaRef,
        migrations: migrations.map((m) => ({
          versionId: m.version.id,
          number: m.version.number,
          name: m.version.name,
          direction: m.direction,
          steps: m.steps.map((s) => ({ sql: s.sql, transactional: !stepNonTx(s) })),
          nonTransactional: m.steps.filter(stepNonTx).length,
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

  const ran: ExecuteResult['ran'] = [];
  let current = state.current;
  const total = migrations.length + (baseline ? 1 : 0);
  let registered = state.historyExists && state.project !== null;
  const register = async () => {
    if (registered) return;
    await ensureHistoryMapped(conn, dialect);
    await engine.history.writeProject(conn, {
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
        throw wrap(e, c, baseline!, false);
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
      const runId = await runMigration(
        conn,
        c,
        m,
        { index: pos, total },
        k === 0 ? resumeAfter : null,
        k === 0 ? resumeFromCrash : false,
      );
      await after(m, runId);
    }
  } catch (e) {
    if (e instanceof ExecutorError) e.details.reached ??= current;
    throw e;
  }
  return {
    direction,
    lca: lcaRef,
    baseline: baseline !== null,
    ran,
    from: state.current,
    current,
  };
};

export const ensureHistoryMapped = async (conn: Db, dialect: Dialect = 'pg') => {
  try {
    await getEngine(dialect).history.ensureHistory(conn);
  } catch (e) {
    if (e instanceof HistoryError) throw new ExecutorError(e.code, scrubSecrets(e.message));
    throw e;
  }
};

export const execute = async (o: ExecuteOptions): Promise<ExecuteResult> => {
  const dialect = o.dialect ?? o.chain[0]?.model.dialect ?? 'pg';
  const engine = getEngine(dialect);
  const emit = async (e: ExecutorEvent) => {
    try {
      await o.onEvent?.(e);
    } catch {
      // 进度发不出去不影响正在做的事
    }
  };
  assertPlatformChain(o.chain, o.projectId);
  try {
    return await engine.history.withProjectLock(
      o.db,
      o.projectId,
      o.lockTimeoutMs ?? 30_000,
      async (conn) => {
        await emit({ type: 'phase', phase: 'lock' });
        try {
          return await locked(conn, {
            o,
            dialect,
            engine,
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
          await engine.resetSession(conn).catch(() => {});
        }
      },
    );
  } catch (e) {
    if (e instanceof HistoryError) throw new ExecutorError(e.code, scrubSecrets(e.message));
    throw e;
  }
};
