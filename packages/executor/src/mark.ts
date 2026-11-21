// 标记为已执行（ADR 0004）：不执行任何 SQL，只在目标库的迁移历史里把环境记为“已经到达版本 X”。
import { type Dialect, scrubSecrets } from '@dowel/core';
import { type Db, getEngine, HistoryError } from '@dowel/engines';

import { diffAgainst } from './compare.ts';
import { ExecutorError } from './errors.ts';
import { ensureHistoryMapped } from './execute.ts';
import { assertPlatformChain, assertTargetHistory, readState } from './state.ts';
import type { ChainVersion } from './types.ts';

export interface MarkPlan {
  direction: 'forward' | 'backward' | 'current';
  from: ChainVersion | null;
  to: ChainVersion;
  skipped: ChainVersion[];
  fingerprint: string;
}

export interface MarkExpect {
  from: string | null;
  to: string;
  skipped: string[];
  fingerprint: string;
}

export const expectOf = (p: MarkPlan): MarkExpect => ({
  from: p.from?.id ?? null,
  to: p.to.id,
  skipped: p.skipped.map((v) => v.id),
  fingerprint: p.fingerprint,
});

export interface MarkOptions {
  db: Db;
  dialect?: Dialect;
  projectId: string;
  projectName: string | null;
  instanceId: string;
  chain: ChainVersion[];
  to: string;
  executedBy: string | null;
  via?: 'web' | 'ci';
  lockTimeoutMs?: number;
  dryRun?: boolean;
  acknowledge?: boolean;
  expect?: MarkExpect;
  beforeMark?: (p: MarkPlan) => void | Promise<void>;
  onTouch?: (p: MarkPlan) => void;
  afterMark?: (p: MarkPlan) => void | Promise<void>;
}

export interface MarkResult {
  plan: MarkPlan;
  runId: number | null;
}

const label = (v: ChainVersion) => `v${v.number}「${v.name}」`;

export const markApplied = async (o: MarkOptions): Promise<MarkResult> => {
  assertPlatformChain(o.chain, o.projectId);
  let reached: string | null | undefined;
  try {
    return await markLocked(o, (cur) => {
      reached = cur;
    });
  } catch (e) {
    const original = e instanceof CallbackError ? e.original : e;
    const details = reached === undefined ? {} : { reached };
    if (original instanceof HistoryError)
      throw new ExecutorError(original.code, scrubSecrets(original.message), details, original);
    if (original instanceof ExecutorError) {
      if (reached !== undefined) original.details.reached ??= reached;
      throw original;
    }
    if (e instanceof CallbackError || reached === undefined) throw original;
    throw new ExecutorError(
      'unexpected',
      scrubSecrets(e instanceof Error ? e.message : String(e)),
      details,
      e,
    );
  }
};

class CallbackError extends Error {
  original: unknown;
  constructor(original: unknown) {
    super('callback');
    this.original = original;
  }
}

const markLocked = async (o: MarkOptions, seen: (current: string | null) => void): Promise<MarkResult> => {
  const dialect = o.dialect ?? o.chain[0]?.model.dialect ?? 'pg';
  const engine = getEngine(dialect);
  return engine.history.withProjectLock(o.db, o.projectId, o.lockTimeoutMs ?? 30_000, async (conn) => {
    try {
      const state = await readState(conn, o.projectId, dialect);
      seen(state.current);
      assertTargetHistory(state, o.chain, o.instanceId);
      const idx = new Map(o.chain.map((v, i) => [v.id, i]));
      const to = o.chain[idx.get(o.to) ?? -1];
      if (!to) throw new ExecutorError('unknown_version', `目标版本不存在：${o.to}`);
      const curIdx = state.current === null ? -1 : (idx.get(state.current) ?? -1);
      if (state.current !== null && curIdx < 0)
        throw new ExecutorError(
          'history_mismatch',
          `目标库历史里的当前版本 ${state.current} 不在平台库的版本链上`,
        );
      const tgtIdx = idx.get(to.id)!;
      const open = state.unfinished !== null || state.readbackFailure !== null;
      if (tgtIdx === curIdx && !open)
        throw new ExecutorError(
          'mark_noop',
          `环境已经记在 ${label(to)}，不需要标记。如果线上结构和它对不上，那是漂移，请先处理漂移`,
        );
      const snapshot = await engine.readSnapshot(conn, to.scope);
      const diff = diffAgainst(snapshot, to.model);
      if (diff.total)
        throw new ExecutorError(
          'mark_mismatch',
          `线上结构和 ${label(to)} 的模型不一致（${diff.total} 处差异），不能标记。标记只记录“已经到达这个版本”，不改库：请先把库改成这个版本的样子`,
          { diff: diff.items, diffTotal: diff.total, versionId: to.id, number: to.number },
        );
      const forward = tgtIdx > curIdx;
      const plan: MarkPlan = {
        direction: tgtIdx === curIdx ? 'current' : forward ? 'forward' : 'backward',
        from: curIdx >= 0 ? o.chain[curIdx]! : null,
        to,
        skipped: forward ? o.chain.slice(curIdx + 1, tgtIdx + 1) : [],
        fingerprint: engine.fingerprint(snapshot),
      };
      if (o.dryRun) {
        const problem = await engine.history.historyWriteProblem(conn);
        if (problem) throw new ExecutorError(problem.code, scrubSecrets(problem.message));
        return { plan, runId: null };
      }

      if (plan.skipped.length) {
        if (!o.acknowledge)
          throw new ExecutorError(
            'ack_required',
            '向前标记要确认：被跳过的版本里的脚本效果已经手工完成，或者不需要',
          );
        if (!o.expect)
          throw new ExecutorError(
            'expect_required',
            '向前标记要带着预演拿到的计划确认（expect）：确认必须绑定到预演结果，请先预演',
          );
      }
      if (o.expect) {
        const now = expectOf(plan);
        const same =
          now.from === o.expect.from &&
          now.to === o.expect.to &&
          now.fingerprint === o.expect.fingerprint &&
          now.skipped.length === o.expect.skipped.length &&
          now.skipped.every((v, i) => v === o.expect!.skipped[i]);
        if (!same)
          throw new ExecutorError(
            'plan_changed',
            '目标库在核对之后变了（当前版本或线上结构和预演时不一样了），什么都没写。请重新预演、重新确认',
            { markPlan: plan },
          );
      }

      await ensureHistoryMapped(conn, dialect);
      try {
        await o.beforeMark?.(plan);
      } catch (e) {
        throw new CallbackError(e);
      }
      const runId = await engine.inTransaction(
        conn,
        async () => {
          if (!state.project)
            await engine.history.writeProject(conn, {
              projectId: o.projectId,
              name: o.projectName,
              instanceId: o.instanceId,
              claimedAt: new Date().toISOString(),
              claimedBy: o.executedBy,
            });
          for (const v of plan.skipped)
            await engine.history.recordVersion(conn, {
              projectId: o.projectId,
              versionId: v.id,
              number: v.number,
              parentId: v.parentId,
              name: v.name,
              scope: v.scope,
              upSteps: v.upSteps,
              downSteps: v.downSteps,
              checksum: v.checksum,
              model: v.model,
              fingerprint: v.id === to.id ? plan.fingerprint : '',
              publishedAt: v.publishedAt,
              publishedBy: v.publishedBy,
            });
          const id = await engine.history.startRun(conn, {
            projectId: o.projectId,
            fromVersion: plan.from?.id ?? null,
            toVersion: to.id,
            direction: 'mark',
            executedBy: o.executedBy,
            via: o.via ?? 'web',
            instanceId: o.instanceId,
          });
          await engine.history.finishRun(conn, id, 'done');
          return id;
        },
        {
          afterCommit: () => {
            try {
              o.onTouch?.(plan);
            } catch {
              // 回调出错不影响结果
            }
          },
        },
      );
      try {
        await o.afterMark?.(plan);
      } catch (e) {
        console.error('标记后回调出错（目标库已经提交）', e instanceof Error ? e.message : e);
      }
      return { plan, runId };
    } finally {
      await engine.resetSession(conn).catch(() => {});
    }
  });
};
