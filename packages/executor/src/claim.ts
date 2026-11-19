// 认领与接入已有历史：把目标库里一个项目的“当前认领实例”换成本实例；检查一个库的历史能不能接入已有的版本链。
//
// 为什么需要认领：目标库的 dowel.projects 记着“当前认领这个项目的实例”，执行时不是本实例就拒绝（foreign_instance）。
// 另一个实例（或者平台库丢失重建后 instance_id 变了的同一个实例）要接手，必须显式认领：之后原实例的执行被拒绝，
// 只读的漂移检查和读历史不受影响。认领由平台的实例管理员确认（服务端做权限），这里只负责写目标库。
import { stableJson } from '@dowel/core';
import {
  type ClaimInput,
  claimProject,
  type Db,
  historyExists,
  verifyChain,
  withProjectLock,
} from '@dowel/engines';
import { ExecutorError } from './errors.ts';
import { ensureHistoryMapped } from './execute.ts';
import { assertTargetHistory, claimOf, readState, type TargetState } from './state.ts';
import type { ChainVersion } from './types.ts';

export interface ClaimOptions extends Omit<ClaimInput, 'name'> {
  db: Db;
  projectName: string | null;
  lockTimeoutMs?: number;
  /**
   * 本实例（平台库）里这个项目的版本链。**在项目锁里**拿它和目标库的历史重新比对（和执行前的检查同一套：完整性、
   * 版本都在链上且 checksum / 序号 / parent / 模型一致）：从读到历史到认领之间，原实例可能又执行了新版本，
   * 这时目标库的历史已经领先于我们的链，认领会让本实例接管一个自己并不了解的库，所以拒绝（history_mismatch，提示重新读取）。
   */
  chain: ChainVersion[];
}

/** 历史领先 / 对不上我们的链时，说明这很可能是读取之后原实例又往前走了 */
const STALE_HINT = '（认领前会在锁里重新比对：如果是读取之后原实例又执行了新版本，请重新读取再认领）';

/**
 * 目标库的历史必须和平台的版本链对得上：完整性（verifyChain、与链互相对一遍）+ 每个版本的**模型**一致。
 * 不检查认领（项目行置空）。接入检查（inspectAttach）和认领（claimInstance，在锁里）共用。
 */
const assertMatchesChain = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  assertTargetHistory({ ...state, project: null }, chain, instanceId);
  const byId = new Map(chain.map((v) => [v.id, v]));
  for (const r of state.versions) {
    const v = byId.get(r.versionId)!;
    if (stableJson(v.model) !== stableJson(r.model))
      throw new ExecutorError(
        'history_conflict',
        `版本 v${r.number}「${r.name}」的模型在目标库历史里和平台库里不一致：这个库的历史来自另一份项目副本`,
      );
  }
};

/**
 * 认领。取目标库的项目锁（等不到就 lock_timeout：原实例正在执行时不能换手）；
 * 先升级旧格式的历史（认领要写 previous_instance_id 和 claims 事件）；历史不完整（verifyChain 不过）就拒绝，
 * 不认领一个已经被改坏的历史。在一个事务里写项目行和认领事件；已经是本实例认领的什么都不写（changed = false）。
 */
export const claimInstance = async (
  o: ClaimOptions,
): Promise<{ changed: boolean; previousInstanceId: string | null }> =>
  withProjectLock(o.db, o.projectId, o.lockTimeoutMs ?? 30_000, async (conn) => {
    try {
      if (!(await historyExists(conn)))
        throw new ExecutorError('history_missing', '目标库里没有 Dowel 的迁移历史，没有什么可认领的');
      await ensureHistoryMapped(conn);
      const state = await readState(conn, o.projectId);
      if (!state.project && !state.versions.length)
        throw new ExecutorError('history_missing', '目标库里没有这个项目的历史，没有什么可认领的');
      const problems = verifyChain(state.versions);
      if (problems.length)
        throw new ExecutorError(
          'history_broken',
          `目标库里的迁移历史不完整或被改动过：${problems[0]!.message}。出于安全，不能认领`,
          { problems: problems.map((p) => p.message) },
        );
      // 锁里重新比对：读到历史之后原实例可能又执行了新版本（历史领先于我们的链）
      try {
        assertMatchesChain(state, o.chain, o.instanceId);
      } catch (e) {
        if (e instanceof ExecutorError && (e.code === 'history_mismatch' || e.code === 'history_conflict'))
          throw new ExecutorError(e.code, `${e.message}${STALE_HINT}`, e.details, e);
        throw e;
      }
      await conn.exec('BEGIN');
      try {
        const r = await claimProject(conn, {
          projectId: o.projectId,
          instanceId: o.instanceId,
          claimedBy: o.claimedBy,
          claimedByName: o.claimedByName,
          name: o.projectName,
          note: o.note,
        });
        await conn.exec('COMMIT');
        return r;
      } catch (e) {
        await conn.exec('ROLLBACK').catch(() => {});
        throw e;
      }
    } finally {
      await conn.exec('RESET ALL').catch(() => {});
    }
  });

export type AttachInspection =
  | { hasHistory: false }
  | {
      hasHistory: true;
      state: TargetState;
      /** 这个库的当前版本（平台版本链上的版本）；还没有 done 的记录为 null */
      current: ChainVersion | null;
      claim: ReturnType<typeof claimOf>;
    };

/**
 * 检查一个库的历史能不能接入平台上已有的版本链（只读）：
 * - 没有这个项目的历史：返回 hasHistory = false（它只是一个新环境，不需要接入）；
 * - 有：历史自己的链必须完整（verifyChain，冻结脚本按内容重算校验和），记录的每个版本都必须在平台的链上，
 *   且 checksum、序号、parent **和模型**都一致——否则说明这个库的历史来自另一份项目副本，抛 history_mismatch / history_conflict。
 *   库里的历史领先于平台的链（有平台没有的版本）也算对不上：接入不会改平台的版本链，要接手整条链请用接手新建项目。
 * 认领情况放在 claim 里，由调用方决定要不要认领，这里不拒绝别的实例认领的历史。
 */
export const inspectAttach = async (
  db: Db,
  projectId: string,
  chain: ChainVersion[],
  instanceId: string,
): Promise<AttachInspection> => {
  const state = await readState(db, projectId);
  if (!state.historyExists || (!state.versions.length && !state.project && !state.runs.length))
    return { hasHistory: false };
  // 完整性 + 与平台的链对得上（含模型）；不检查认领，认领信息单独返回
  assertMatchesChain(state, chain, instanceId);
  const byId = new Map(chain.map((v) => [v.id, v]));
  const current = state.current ? (byId.get(state.current) ?? null) : null;
  return { hasHistory: true, state, current, claim: claimOf(state, instanceId) };
};
