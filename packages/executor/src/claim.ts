// 认领与接入已有历史：全面按 dialect 派发至 EngineAdapter。
import { type Dialect, stableJson } from '@dowel/core';
import {
  activePath,
  type ClaimInput,
  type Db,
  getEngine,
  type HistoryVersionRow,
  maxNumberNode,
  verifyChain,
} from '@dowel/engines';

import { ExecutorError } from './errors.ts';
import { ensureHistoryMapped } from './execute.ts';
import { asRows, assertTargetHistory, claimOf, readState, type TargetState } from './state.ts';
import type { ChainVersion } from './types.ts';

export interface ClaimOptions extends Omit<ClaimInput, 'name'> {
  db: Db;
  dialect?: Dialect;
  projectName: string | null;
  lockTimeoutMs?: number;
  chain: ChainVersion[];
}

const STALE_HINT = '（认领前会在锁里重新比对：如果是读取之后原实例又执行了新版本，请重新读取再认领）';

const normScope = (scope: string[] | null | undefined): string[] | null => (scope?.length ? scope : null);

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

const assertMatchesChain = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  assertTargetHistory({ ...state, project: null }, chain, instanceId);
  const byId = new Map(chain.map((v) => [v.id, v]));
  for (const r of state.versions) assertVersionSame(r, byId.get(r.versionId)!);
};

const rowToChainVersion = (r: HistoryVersionRow, retired = false): ChainVersion => ({
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
  retired,
});

export const claimInstance = async (
  o: ClaimOptions,
): Promise<{ changed: boolean; previousInstanceId: string | null }> => {
  const dialect = o.dialect ?? o.chain[0]?.model.dialect ?? 'pg';
  const engine = getEngine(dialect);
  return engine.history.withProjectLock(o.db, o.projectId, o.lockTimeoutMs ?? 30_000, async (conn) => {
    try {
      if (!(await engine.history.historyExists(conn)))
        throw new ExecutorError('history_missing', '目标库里没有 Dowel 的迁移历史，没有什么可认领的');
      await ensureHistoryMapped(conn, dialect);
      const state = await readState(conn, o.projectId, dialect);
      if (!state.project && !state.versions.length)
        throw new ExecutorError('history_missing', '目标库里没有这个项目的历史，没有什么可认领的');
      const problems = verifyChain(state.versions);
      if (problems.length)
        throw new ExecutorError(
          'history_broken',
          `目标库里的迁移历史不完整或被改动过：${problems[0]!.message}。出于安全，不能认领`,
          { problems: problems.map((p) => p.message) },
        );
      try {
        assertMatchesChain(state, o.chain, o.instanceId);
      } catch (e) {
        if (e instanceof ExecutorError && (e.code === 'history_mismatch' || e.code === 'history_conflict'))
          throw new ExecutorError(e.code, `${e.message}${STALE_HINT}`, e.details, e);
        throw e;
      }
      return await engine.inTransaction(conn, () =>
        engine.history.claimProject(conn, {
          projectId: o.projectId,
          instanceId: o.instanceId,
          claimedBy: o.claimedBy,
          claimedByName: o.claimedByName,
          name: o.projectName,
          note: o.note,
        }),
      );
    } finally {
      await engine.resetSession(conn).catch(() => {});
    }
  });
};

export type AttachInspection =
  | { hasHistory: false }
  | {
      hasHistory: true;
      state: TargetState;
      current: ChainVersion | null;
      aheadVersions: HistoryVersionRow[];
      /** aheadVersions 中不在合并后活跃主链上、接入后应记为已作废的版本 ID */
      retiredAheadIds: string[];
      /** 合并后产生了新的活跃链头时对应的版本行；仅补齐已作废岔路时为 null */
      newActiveHead: HistoryVersionRow | null;
      claim: ReturnType<typeof claimOf>;
    };

export const inspectAttach = async (
  db: Db,
  projectId: string,
  chain: ChainVersion[],
  instanceId: string,
  dialect: Dialect = chain[0]?.model.dialect ?? 'pg',
): Promise<AttachInspection> => {
  const state = await readState(db, projectId, dialect);
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

  // 集合/树并集校验（ADR 0013）：
  // 1) 平台已有的版本（按 versionId）必须完全一致；
  // 2) 不在平台里的目标库版本，如果编号已存在于平台 → history_fork；其余为“平台缺失的版本”；
  // 3) 并集必须通过版本树 verifyChain，所有执行记录引用必须在并集内。
  const platById = new Map(chain.map((v) => [v.id, v]));
  const platByNumber = new Map(chain.map((v) => [v.number, v]));
  const missing: HistoryVersionRow[] = [];
  for (const r of state.versions) {
    const pv = platById.get(r.versionId);
    if (pv) {
      assertVersionSame(r, pv);
      continue;
    }
    const clash = platByNumber.get(r.number);
    if (clash)
      throw new ExecutorError(
        'history_fork',
        `目标库历史与平台库的版本链分叉：v${r.number} 在目标库是「${r.name}」（${r.versionId}），平台库是「${clash.name}」（${clash.id}）`,
      );
    missing.push(r);
  }
  missing.sort((a, b) => a.number - b.number);

  const unionRows = [...asRows(chain, projectId), ...missing].sort((a, b) => a.number - b.number);
  const unionProblems = verifyChain(unionRows);
  if (unionProblems.length) {
    const forkProblem = unionProblems.find(
      (p) => p.code === 'root_multiple' || p.code === 'number_duplicate',
    );
    if (forkProblem)
      throw new ExecutorError('history_fork', `目标库历史与平台库的版本链分叉：${forkProblem.message}`, {
        problems: unionProblems.map((p) => p.message),
      });
    throw new ExecutorError(
      'history_broken',
      `目标库与平台库合并后的版本树不完整：${unionProblems[0]!.message}`,
      { problems: unionProblems.map((p) => p.message) },
    );
  }
  const unionIds = new Set(unionRows.map((v) => v.versionId));
  for (const run of state.runs)
    for (const id of [run.fromVersion, run.toVersion])
      if (id && !unionIds.has(id))
        throw new ExecutorError(
          'history_mismatch',
          `目标库历史与平台库的版本链对不上：执行记录 #${run.id} 引用了未知版本 ${id}`,
        );

  let retiredAheadIds: string[] = [];
  let newActiveHead: HistoryVersionRow | null = null;
  if (missing.length > 0) {
    const platActiveHead = maxNumberNode(chain.filter((v) => !v.retired));
    const unionNodes = unionRows.map((v) => ({ id: v.versionId, number: v.number, parentId: v.parentId }));
    const unionActive = activePath(unionNodes);
    const unionActiveSet = new Set(unionActive.map((n) => n.id));
    if (platActiveHead && !unionActiveSet.has(platActiveHead.id))
      throw new ExecutorError(
        'history_fork',
        `目标库历史与平台库活跃主链分叉：平台当前活跃链头 v${platActiveHead.number}「${platActiveHead.name}」不在合并后的活跃主链上`,
      );
    for (const v of chain) {
      if (v.retired && unionActiveSet.has(v.id))
        throw new ExecutorError(
          'history_fork',
          `目标库历史与平台库冲突：平台已作废的版本 v${v.number}「${v.name}」落在了合并后的活跃主链上，不能静默复活已作废版本`,
        );
    }
    retiredAheadIds = missing.filter((v) => !unionActiveSet.has(v.versionId)).map((v) => v.versionId);
    const unionHeadId = unionActive.at(-1)?.id ?? null;
    newActiveHead = missing.find((v) => v.versionId === unionHeadId) ?? null;
  }

  const retiredSet = new Set(retiredAheadIds);
  const byId = new Map<string, ChainVersion>(chain.map((v) => [v.id, v]));
  for (const r of missing) byId.set(r.versionId, rowToChainVersion(r, retiredSet.has(r.versionId)));
  const current = state.current ? (byId.get(state.current) ?? null) : null;
  return {
    hasHistory: true,
    state,
    current,
    aheadVersions: missing,
    retiredAheadIds,
    newActiveHead,
    claim: claimOf(state, instanceId),
  };
};
