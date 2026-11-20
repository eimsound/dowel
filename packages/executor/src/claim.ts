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
  type HistoryVersionRow,
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
   * 版本都在链上且 checksum / 序号 / parent / 模型 / schema 范围一致）：从读到历史到认领之间，原实例可能又执行了新版本，
   * 这时目标库的历史已经领先于我们的链，认领会让本实例接管一个自己并不了解的库，所以拒绝（history_mismatch，提示重新读取）。
   */
  chain: ChainVersion[];
}

/** 历史领先 / 对不上我们的链时，说明这很可能是读取之后原实例又往前走了 */
const STALE_HINT = '（认领前会在锁里重新比对：如果是读取之后原实例又执行了新版本，请重新读取再认领）';

const normScope = (scope: string[] | null | undefined): string[] | null => (scope?.length ? scope : null);

/** 检查目标库的一行版本与平台链上同一 ID 的版本是否内容完全一致（序号、parent、checksum、模型、schema 范围） */
const assertVersionSame = (r: HistoryVersionRow, v: ChainVersion) => {
  if (v.checksum !== r.checksum)
    throw new ExecutorError(
      'history_mismatch',
      `目标库历史与平台库的版本链对不上：版本 ${r.name} 的校验和与平台库不一致（目标库 ${r.checksum.slice(0, 12)}…，平台库 ${v.checksum.slice(0, 12)}…）`,
    );
  if (v.number !== r.number || v.parentId !== r.parentId)
    throw new ExecutorError(
      'history_mismatch',
      `目标库历史与平台库的版本链对不上：版本 ${r.name} 在链上的位置与平台库不一致`,
    );
  if (stableJson(v.model) !== stableJson(r.model))
    throw new ExecutorError(
      'history_conflict',
      `版本 v${r.number}「${r.name}」的模型在目标库历史里和平台库里不一致：这个库的历史来自另一份项目副本`,
    );
  if (stableJson(normScope(v.scope)) !== stableJson(normScope(r.scope)))
    throw new ExecutorError(
      'history_conflict',
      `版本 v${r.number}「${r.name}」的 schema 范围在目标库历史里和平台库里不一致：这个库的历史来自另一份项目副本`,
    );
};

/**
 * 目标库的历史必须和平台的版本链严格一致（不允许目标库领先）：完整性（verifyChain、与链互相对一遍）+
 * 每个版本的模型和 schema 范围一致。不检查认领（项目行置空）。认领（claimInstance，在锁里）使用。
 */
const assertMatchesChain = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  assertTargetHistory({ ...state, project: null }, chain, instanceId);
  const byId = new Map(chain.map((v) => [v.id, v]));
  for (const r of state.versions) assertVersionSame(r, byId.get(r.versionId)!);
};

const rowToChainVersion = (r: HistoryVersionRow): ChainVersion => ({
  id: r.versionId,
  number: r.number,
  parentId: r.parentId,
  name: r.name,
  model: r.model,
  upSteps: r.upSteps,
  downSteps: r.downSteps,
  checksum: r.checksum,
  verified: false,
  publishedAt: r.publishedAt,
  publishedBy: r.publishedBy,
  scope: normScope(r.scope),
});

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
      /** 这个库的当前版本（平台链或领先延伸版本里的版本）；还没有 done 的记录为 null */
      current: ChainVersion | null;
      /** 目标库严格领先于平台链（无分叉）时末尾多出的连续延伸版本，按序号升序；未领先时为空数组 */
      aheadVersions: HistoryVersionRow[];
      claim: ReturnType<typeof claimOf>;
    };

/**
 * 检查一个库的历史能不能接入平台上已有的版本链（只读，ADR 0012）：
 * - 没有这个项目的历史：返回 hasHistory = false（它只是一个新环境，不需要接入）；
 * - 有：历史自己的链必须完整（verifyChain，冻结脚本按内容重算校验和）；
 * - 若目标库历史长度 <= 平台链：记录的每个版本都必须在平台的链上，且 ID / 序号 / parent / checksum / 模型 / schema 范围一致；
 * - 若目标库历史包含平台链的全部版本（逐一完全一致），且末尾多出 1 个或多个连续延伸版本（无分叉）：
 *   将其识别为领先延伸并返回 aheadVersions（由上层用影子库验证后补齐平台链）；
 * - 若存在分叉或任一已有版本不一致：抛 history_conflict / history_mismatch。
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

  const problems = verifyChain(state.versions);
  if (problems.length)
    throw new ExecutorError(
      'history_broken',
      `目标库里的迁移历史不完整或被改动过：${problems[0]!.message}。出于安全，已拒绝接入`,
      { problems: problems.map((p) => p.message) },
    );
  if (state.current && !state.versions.some((v) => v.versionId === state.current))
    throw new ExecutorError(
      'history_broken',
      `目标库历史里的当前版本 ${state.current} 不在它自己的版本记录里`,
    );

  let aheadVersions: HistoryVersionRow[] = [];
  if (state.versions.length <= chain.length) {
    // 不领先：沿用严格匹配（每个版本都在平台链上，且内容完全一致）
    assertMatchesChain(state, chain, instanceId);
  } else {
    // 目标库更长：检查目标库是否包含平台链的全部版本（严格无分叉前缀延伸）
    const sorted = [...state.versions].sort((a, b) => a.number - b.number);
    const prefix = sorted.slice(0, chain.length);
    for (let i = 0; i < chain.length; i++) {
      const v = chain[i]!;
      const r = prefix[i]!;
      if (r.versionId !== v.id) {
        if (r.parentId === v.parentId)
          throw new ExecutorError(
            'history_conflict',
            `目标库历史与平台库的版本链分叉：目标库在 v${r.number} 处是「${r.name}」（${r.versionId}），平台库是「${v.name}」（${v.id}）`,
          );
        throw new ExecutorError(
          'history_mismatch',
          `目标库历史与平台库的版本链对不上：目标库历史里的版本 ${r.name}（${r.versionId}）不在平台库的版本链上`,
        );
      }
      assertVersionSame(r, v);
    }
    const ahead = sorted.slice(chain.length);
    if (chain.length > 0) {
      const head = chain.at(-1)!;
      const firstAhead = ahead[0]!;
      if (firstAhead.parentId !== head.id || firstAhead.number !== head.number + 1)
        throw new ExecutorError(
          'history_conflict',
          `目标库历史与平台库的版本链分叉：v${firstAhead.number}「${firstAhead.name}」的父版本不是平台链头 v${head.number}「${head.name}」`,
        );
    }
    const allIds = new Set([...chain.map((v) => v.id), ...ahead.map((v) => v.versionId)]);
    for (const run of state.runs)
      for (const id of [run.fromVersion, run.toVersion])
        if (id && !allIds.has(id))
          throw new ExecutorError(
            'history_mismatch',
            `目标库历史与平台库的版本链对不上：执行记录 #${run.id} 引用了未知版本 ${id}`,
          );
    aheadVersions = ahead;
  }

  const byId = new Map<string, ChainVersion>(chain.map((v) => [v.id, v]));
  for (const r of aheadVersions) byId.set(r.versionId, rowToChainVersion(r));
  const current = state.current ? (byId.get(state.current) ?? null) : null;
  return { hasHistory: true, state, current, aheadVersions, claim: claimOf(state, instanceId) };
};
