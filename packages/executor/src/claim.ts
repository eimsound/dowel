// 认领与接入已有历史：全面按 dialect 派发至 EngineAdapter。
import { type Dialect, stableJson } from '@dowel/core';
import { type ClaimInput, type Db, getEngine, type HistoryVersionRow, verifyChain } from '@dowel/engines';

import { ExecutorError } from './errors.ts';
import { ensureHistoryMapped } from './execute.ts';
import { assertTargetHistory, claimOf, readState, type TargetState } from './state.ts';
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

  let aheadVersions: HistoryVersionRow[] = [];
  if (state.versions.length <= chain.length) {
    assertMatchesChain(state, chain, instanceId);
  } else {
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
