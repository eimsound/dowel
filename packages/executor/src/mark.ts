// 标记为已执行（ADR 0004）：**不执行任何 SQL**，只在目标库的迁移历史里把环境记为“已经到达版本 X”。
//
// 为什么存在：环境的线上结构和历史对不上时（有人手工改了库、读回失败后手工修好、含非事务步骤的迁移半途失败后手工补完、
// 手工回退了一次发布），要有一个出口让历史追上现实——而不是让 Dowel 代为执行没验证过的 SQL。
// 硬条件只有一个：在项目锁里读出的线上结构必须等于 X 的模型（`plan(线上结构, X 的模型)` 为空），否则拒绝并给出差异。
// X 可以是链上任意版本，比当前版本新（向前）或旧（向后）都行；第一次执行时的“写入基线”是它的特例。
//
// 写入：一条 direction = 'mark' 的历史记录（from = 当前版本，to = X），在**一个事务**里写完（startRun + finishRun），
// 所以不会有半途状态；向前标记还要给 X 和中间跳过的版本在目标库补上版本行（历史链要连续）。
// 向前标记的版本在平台上算“执行过”（executed_at、environment_versions），向后标记不改变这一点——由服务端的
// 登记 / 同步按版本行判断（见 apps/server/src/envs.ts 的 syncEnvCache）。
//
// P5 扩展点：接入审批以后，批准要绑定“起止版本 + 线上结构指纹”（MarkPlan.fingerprint），结构一变批准即失效；
// 这些都在服务端，这里只提供指纹和计划。

import { scrubSecrets } from '@dowel/core';
import {
  type Db,
  fingerprint,
  finishRun,
  HistoryError,
  historyWriteProblem,
  readSnapshot,
  recordVersion,
  startRun,
  withProjectLock,
  writeProject,
} from '@dowel/engines';

import { diffAgainst } from './compare.ts';
import { ExecutorError } from './errors.ts';
import { ensureHistoryMapped, inTx } from './execute.ts';
import { assertPlatformChain, assertTargetHistory, readState } from './state.ts';
import type { ChainVersion } from './types.ts';

export interface MarkPlan {
  /**
   * forward / backward：目标版本比当前版本新 / 旧；
   * current：目标就是当前版本，只在上一次执行**没有结束**（unfinished / readbackFailure）时允许——
   * DBA 手工把半途的库改回了当前版本，这条 mark 记录（from = to = 当前版本）关掉那次未完成的运行，之后执行从头重跑那个迁移。
   */
  direction: 'forward' | 'backward' | 'current';
  from: ChainVersion | null;
  to: ChainVersion;
  /**
   * 向前标记：被记为“已执行”、但脚本**没有执行**的版本（from 之后一直到 to，含 to）——它们里的数据步骤、
   * 手工要做的事都不会发生，确认框要把它们和脚本列给用户看。向后标记为空。
   */
  skipped: ChainVersion[];
  /** 读到的线上结构的指纹（审计、以后的审批绑定用） */
  fingerprint: string;
}

/**
 * 预演时拿到的计划：确认必须绑定到它。执行器在锁里重新算出 plan，任何一项（from、to、跳过的版本、线上结构指纹）
 * 和 expect 不一致就拒绝（plan_changed），什么都不写——预演和确认之间目标库可能被人改了、被人标记了。
 */
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
  projectId: string;
  projectName: string | null;
  instanceId: string;
  chain: ChainVersion[];
  /** 目标版本 ID */
  to: string;
  executedBy: string | null;
  via?: 'web' | 'ci';
  lockTimeoutMs?: number;
  /** 只做全部检查（含线上结构核对）并返回计划，不写目标库，也不调用任何回调 */
  dryRun?: boolean;
  /**
   * 向前标记（一定有被跳过的版本）的确认：用户确认了“这些脚本的效果已经手工完成，或者不需要”，**并且**带着预演拿到的计划（expect）。
   * 两个都要：只有布尔值的 ack 不能证明用户确认的就是现在要写的这个计划。向后标记和标记到当前版本不需要（没有被跳过的版本）。
   * 这些检查和预演的检查在同一层，都在建 dowel schema 之前，被拒绝时目标库里不会多出任何东西。
   */
  acknowledge?: boolean;
  expect?: MarkExpect;
  /** 写目标库之前调用（平台库在这里登记）；抛错就中止，此时目标库还没动 */
  beforeMark?: (p: MarkPlan) => void | Promise<void>;
  /** 事务 COMMIT 成功之后调用（同步）：目标库已经被改动 */
  onTouch?: (p: MarkPlan) => void;
  /** 标记成功之后调用；这里抛错会被忽略（目标库已经提交） */
  afterMark?: (p: MarkPlan) => void | Promise<void>;
}

export interface MarkResult {
  plan: MarkPlan;
  /** 写入的执行记录 ID；dryRun 为 null */
  runId: number | null;
}

const label = (v: ChainVersion) => `v${v.number}「${v.name}」`;

/**
 * 标记为已执行。检查（都在拿到目标库项目锁之后、第一次写之前）：
 * 平台链完整、目标库历史完整且与平台链对得上、认领是本实例；目标版本存在；
 * **线上结构等于目标版本的模型**。`unfinished` / `readbackFailure` 状态下也允许——这两种状态正是靠它走出来的，
 * 并且这时目标版本可以就是当前版本（手工改回当前版本之后的出口，见 MarkPlan.direction）；没有未完成的运行时目标是当前版本报 mark_noop。
 *
 * 错误：HistoryError（lock_timeout、格式错误、读取错误）转成带 code 的 ExecutorError（和 execute 一样）；
 * ExecutorError 带上 `details.reached`——执行器**实际读到**的当前版本（审计用，不用平台缓存）。
 */
export const markApplied = async (o: MarkOptions): Promise<MarkResult> => {
  assertPlatformChain(o.chain, o.projectId);
  /** 读到历史之后，这里是执行器看到的当前版本 */
  let reached: string | null | undefined;
  try {
    return await markLocked(o, (cur) => {
      reached = cur;
    });
  } catch (e) {
    // 调用方回调（平台库登记）抛的错原样往上抛（它们有自己的 HTTP 语义）；reached 照样标上
    const original = e instanceof CallbackError ? e.original : e;
    const details = reached === undefined ? {} : { reached };
    if (original instanceof HistoryError)
      throw new ExecutorError(original.code, scrubSecrets(original.message), details, original);
    if (original instanceof ExecutorError) {
      if (reached !== undefined) original.details.reached ??= reached;
      throw original;
    }
    // 读到历史之后的其他错误（读结构失败、连接断开……）：和 execute 一样包成 unexpected，带上 reached 和 cause
    // （服务端按 cause 再分类：连接故障 → connect，目标库返回的错误 → database……）
    if (e instanceof CallbackError || reached === undefined) throw original;
    throw new ExecutorError(
      'unexpected',
      scrubSecrets(e instanceof Error ? e.message : String(e)),
      details,
      e,
    );
  }
};

/** beforeMark 回调抛的错：和执行器自己的错区分开，外层原样抛出 */
class CallbackError extends Error {
  original: unknown;
  constructor(original: unknown) {
    super('callback');
    this.original = original;
  }
}

const markLocked = async (o: MarkOptions, seen: (current: string | null) => void): Promise<MarkResult> =>
  withProjectLock(o.db, o.projectId, o.lockTimeoutMs ?? 30_000, async (conn) => {
    try {
      const state = await readState(conn, o.projectId);
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
      // 硬条件：线上结构等于目标版本的模型（用目标版本冻结时的 schema 范围读）
      const snapshot = await readSnapshot(conn, to.scope);
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
        fingerprint: fingerprint(snapshot),
      };
      if (o.dryRun) {
        // 预演：只读——提前发现真标记会因为历史表不能写（权限、格式）失败
        const problem = await historyWriteProblem(conn);
        if (problem) throw new ExecutorError(problem.code, scrubSecrets(problem.message));
        return { plan, runId: null };
      }

      // 确认的检查（和预演同一层，**在建 dowel schema 之前**）：向前标记要确认被跳过的版本，并且绑定到预演结果
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

      // 所有检查都过了才建 dowel schema / 表（没有历史的库第一次标记；有历史时只是格式检查）：拒绝时目标库里不会多出任何东西
      await ensureHistoryMapped(conn);
      try {
        await o.beforeMark?.(plan);
      } catch (e) {
        throw new CallbackError(e);
      }
      const runId = await inTx(
        conn,
        async () => {
          if (!state.project)
            await writeProject(conn, {
              projectId: o.projectId,
              name: o.projectName,
              instanceId: o.instanceId,
              claimedAt: new Date().toISOString(),
              claimedBy: o.executedBy,
            });
          // 向前：给 X 和中间跳过的版本补上版本行（目标库历史的版本必须连续）；X 记真实指纹，中间的没有读过结构，指纹留空
          for (const v of plan.skipped)
            await recordVersion(conn, {
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
          const id = await startRun(conn, {
            projectId: o.projectId,
            fromVersion: plan.from?.id ?? null,
            toVersion: to.id,
            direction: 'mark',
            executedBy: o.executedBy,
            via: o.via ?? 'web',
            instanceId: o.instanceId,
          });
          await finishRun(conn, id, 'done');
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
      await conn.exec('RESET ALL').catch(() => {});
    }
  });
