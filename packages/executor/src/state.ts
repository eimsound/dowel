// 读目标库里这个项目的历史状态（只读，不建任何东西）并做完整性检查。
import type { Dialect } from '@dowel/core';
import {
  type ChainProblem,
  type ClaimRow,
  type Db,
  getEngine,
  type HistoryVersionRow,
  type ProjectRow,
  type RunRow,
  verifyChain,
} from '@dowel/engines';

import { ExecutorError } from './errors.ts';
import type { ChainVersion, MigrationDirection } from './types.ts';

export type OpenRun = RunRow & { direction: MigrationDirection };

const READBACK_MARK = '[readback_mismatch] ';

export const markReadbackError = (text: string): string => READBACK_MARK + text;
export const isReadbackFailure = (error: string | null | undefined): boolean =>
  error?.startsWith(READBACK_MARK) === true;
export const stripReadbackMark = (error: string): string =>
  error.startsWith(READBACK_MARK) ? error.slice(READBACK_MARK.length) : error;

export const runTouched = (r: RunRow): boolean =>
  (r.status === 'done' && r.direction !== 'mark') || r.stepIndex !== null || isReadbackFailure(r.error);

export const runVersionId = (r: RunRow): string | null =>
  r.direction === 'down' ? r.fromVersion : r.toVersion;

export interface TargetState {
  historyExists: boolean;
  current: string | null;
  versions: HistoryVersionRow[];
  runs: RunRow[];
  project: ProjectRow | null;
  claims: ClaimRow[];
  unfinished: OpenRun | null;
  readbackFailure: OpenRun | null;
}

export const readState = async (db: Db, projectId: string, dialect: Dialect = 'pg'): Promise<TargetState> => {
  const history = getEngine(dialect).history;
  if ((await history.readHistoryFormat(db)) === null)
    return {
      historyExists: false,
      current: null,
      versions: [],
      runs: [],
      project: null,
      claims: [],
      unfinished: null,
      readbackFailure: null,
    };
  const h = await history.readHistory(db, projectId);
  const last = h.history.at(-1) ?? null;
  const readbackFailure =
    last?.status === 'failed' && isReadbackFailure(last.error) ? (last as OpenRun) : null;
  const unfinished =
    !readbackFailure &&
    last &&
    (last.status === 'running' || (last.status === 'failed' && last.stepIndex !== null))
      ? (last as OpenRun)
      : null;
  return {
    historyExists: true,
    current: h.currentVersion,
    versions: h.versions,
    runs: h.history,
    project: await history.readProject(db, projectId),
    claims: await history.readClaims(db, projectId),
    unfinished,
    readbackFailure,
  };
};

export const asRows = (chain: ChainVersion[], projectId: string): HistoryVersionRow[] =>
  chain.map((v) => ({
    projectId,
    versionId: v.id,
    number: v.number,
    parentId: v.parentId,
    name: v.name,
    scope: v.scope,
    upSteps: v.upSteps,
    downSteps: v.downSteps,
    checksum: v.checksum,
    model: v.model,
    fingerprint: '',
    publishedAt: v.publishedAt,
    publishedBy: v.publishedBy,
  }));

const messages = (ps: ChainProblem[]) => ps.map((p) => p.message);

export const assertPlatformChain = (chain: ChainVersion[], projectId: string) => {
  const problems = verifyChain(asRows(chain, projectId));
  if (problems.length)
    throw new ExecutorError('chain_broken', `平台库里的版本链不完整：${messages(problems)[0]}`, {
      problems: messages(problems),
    });
};

export const assertTargetHistory = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  if (!state.historyExists) return;
  if (state.project && state.project.instanceId !== instanceId)
    throw new ExecutorError(
      'foreign_instance',
      `这个项目在目标库里的历史由另一个 Dowel 实例（${state.project.instanceId}）认领，本实例（${instanceId}）不能执行。` +
        '需要由本实例的管理员“认领”它（之后原实例的执行会被拒绝）；只读的漂移检查和读历史不受影响',
      {
        claim: {
          instanceId: state.project.instanceId,
          claimedAt: state.project.claimedAt,
          previousInstanceId: state.project.previousInstanceId,
        },
      },
    );
  const problems = verifyChain(state.versions);
  if (problems.length)
    throw new ExecutorError(
      'history_broken',
      `目标库里的迁移历史不完整或被改动过：${messages(problems)[0]}。出于安全，已拒绝执行`,
      { problems: messages(problems) },
    );
  const byId = new Map(chain.map((v) => [v.id, v]));
  const bad: string[] = [];
  for (const r of state.versions) {
    const v = byId.get(r.versionId);
    if (!v) bad.push(`目标库历史里的版本 ${r.name}（${r.versionId}）不在平台库的版本链上`);
    else if (v.checksum !== r.checksum)
      bad.push(
        `版本 ${r.name} 的校验和与平台库不一致（目标库 ${r.checksum.slice(0, 12)}…，平台库 ${v.checksum.slice(0, 12)}…）`,
      );
    else if (v.number !== r.number || v.parentId !== r.parentId)
      bad.push(`版本 ${r.name} 在链上的位置与平台库不一致`);
  }
  for (const run of state.runs)
    for (const id of [run.fromVersion, run.toVersion])
      if (id && !byId.has(id)) bad.push(`执行记录 #${run.id} 引用了平台库里没有的版本 ${id}`);
  if (bad.length)
    throw new ExecutorError('history_mismatch', `目标库历史与平台库的版本链对不上：${bad[0]}`, {
      problems: bad,
    });
};

export const claimOf = (state: TargetState, instanceId: string) => ({
  mine: !state.project || state.project.instanceId === instanceId,
  instanceId: state.project?.instanceId ?? null,
  claimedAt: state.project?.claimedAt ?? null,
  previousInstanceId: state.project?.previousInstanceId ?? null,
});
