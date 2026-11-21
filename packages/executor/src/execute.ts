// 执行器：沿冻结的版本链逐个执行 / 回滚迁移，全面由 EngineAdapter 驱动。
import {
  type Dialect,
  emptyBase,
  findInstanceLevelStep,
  isConcurrentDdlSql,
  isNontransactionalSql,
  type Step,
  scrubSecrets,
} from '@dowel/core';
import {
  type AppliedTimeouts,
  type Db,
  type EngineAdapter,
  getEngine,
  HistoryError,
  NO_TIMEOUTS,
  parsePgCreateIndexConcurrently,
  parsePgDetachConcurrently,
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

const route = (chain: ChainVersion[], curIdx: number, tgtIdx: number): Migration[] => {
  const out: Migration[] = [];
  if (tgtIdx > curIdx) for (let i = curIdx + 1; i <= tgtIdx; i++) out.push(upMigration(chain, i));
  else for (let i = curIdx; i > tgtIdx; i--) out.push(downMigration(chain, i));
  return out;
};

const preflight = (migrations: Migration[], dialect: Dialect) => {
  for (const m of migrations) {
    if (m.direction === 'baseline') continue;
    if (!m.version.verified)
      throw new ExecutorError(
        'unverified',
        `${label(m.version)}还没有通过影子库验证，不能${m.direction === 'down' ? '回滚' : '执行'}。请先在版本页“重新验证”`,
        { versionId: m.version.id, number: m.version.number, direction: m.direction },
      );
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
  const mode = o.mode ?? 'migrate';
  await c.emit({ type: 'phase', phase: 'integrity' });
  if (o.dryRun) {
    const problem = await engine.history.historyWriteProblem(conn);
    if (problem) throw new ExecutorError(problem.code, scrubSecrets(problem.message));
  } else if (await engine.history.historyExists(conn)) await ensureHistoryMapped(conn, dialect);
  const state: TargetState = await readState(conn, o.projectId, dialect);
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
  let resumeFromCrash = false;
  let snapshotFp = '';

  if (state.unfinished) {
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
    resumeFromCrash = p.status === 'running';
  } else if (state.current === null) {
    await c.emit({ type: 'phase', phase: 'drift' });
    const snapshot = await engine.readSnapshot(conn, first.scope);
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
      snapshotFp = engine.fingerprint(snapshot);
      migrations = mode === 'baseline' ? [] : route(chain, 0, tgtIdx);
    } else migrations = route(chain, -1, tgtIdx);
  } else {
    if (mode === 'baseline')
      throw new ExecutorError(
        'baseline_not_applicable',
        '这个库里已经有这个项目的 Dowel 历史，不需要再写基线',
      );
    migrations = route(chain, curIdx, tgtIdx);
    if (!migrations.length) {
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
    const snapshot = await engine.readSnapshot(conn, cur.scope);
    const recorded = state.versions.find((v) => v.versionId === cur.id)?.fingerprint;
    if (!recorded || recorded !== engine.fingerprint(snapshot)) {
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
  preflight(migrations, dialect);
  if (o.expect) assertExpected(o.expect, state.current, migrations);
  const direction = migrations[0]?.direction === 'down' ? 'down' : migrations.length ? 'up' : 'none';
  if (o.dryRun) {
    const ref = (v: ChainVersion | undefined) => (v ? { id: v.id, number: v.number, name: v.name } : null);
    const lastTo = migrations.at(-1)?.to ?? (baseline ? first : (chain[curIdx] ?? null));
    const stepNonTx = (s: ScriptStep) => isNonTx(s, dialect);
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
    mode,
    direction: direction as ExecuteResult['direction'],
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
