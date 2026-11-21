// 漂移检测：读目标库结构，和环境当前版本的模型比较。只读；不建历史表。
import { type Dialect, emptyBase } from '@dowel/core';
import { type Db, getEngine } from '@dowel/engines';

import { classifyFirstRun, type DiffResult, diffAgainst } from './compare.ts';
import { ExecutorError } from './errors.ts';
import { readState, runVersionId } from './state.ts';
import type { ChainVersion } from './types.ts';

export type DriftReport =
  | {
      status: 'ok';
      version: string | null;
      firstRun?: 'baseline' | 'empty';
    }
  | {
      status: 'drifted';
      version: string;
      diff: DiffResult;
      firstRun?: true;
      needsManual?: { versionId: string | null; direction: 'up' | 'down' | 'baseline' };
    }
  | {
      status: 'skipped';
      reason: 'busy' | 'unfinished' | 'no_versions';
    };

export interface DriftOptions {
  db: Db;
  dialect?: Dialect;
  projectId: string;
  chain: ChainVersion[];
  /** 可选回调：读取快照后上报目标库版本号 */
  onVersion?: (versionNum: number) => void;
}

export const checkDrift = async (o: DriftOptions): Promise<DriftReport> => {
  const first = o.chain[0];
  if (!first) return { status: 'skipped', reason: 'no_versions' };
  const dialect = o.dialect ?? first.model.dialect;
  const engine = getEngine(dialect);
  try {
    return await engine.history.withProjectLock(o.db, o.projectId, 0, async (conn) => {
      try {
        const state = await readState(conn, o.projectId, dialect);
        if (state.unfinished) return { status: 'skipped', reason: 'unfinished' } as const;
        const manual = state.readbackFailure
          ? {
              versionId: runVersionId(state.readbackFailure),
              direction: state.readbackFailure.direction,
            }
          : undefined;
        if (state.current === null) {
          const snapshot = await engine.readSnapshot(conn, first.scope);
          o.onVersion?.(snapshot.versionNum);
          const c = classifyFirstRun(snapshot, first, emptyBase(first.model, first.scope));
          return c.kind === 'drift'
            ? ({
                status: 'drifted',
                version: first.id,
                diff: c.diff,
                firstRun: true,
                ...(manual ? { needsManual: manual } : {}),
              } as const)
            : ({ status: 'ok', version: first.id, firstRun: c.kind } as const);
        }
        const cur = o.chain.find((v) => v.id === state.current);
        if (!cur)
          throw new ExecutorError(
            'history_mismatch',
            `目标库历史里的当前版本 ${state.current} 不在平台库的版本链上`,
          );
        const snapshot = await engine.readSnapshot(conn, cur.scope);
        o.onVersion?.(snapshot.versionNum);
        const recorded = state.versions.find((v) => v.versionId === cur.id)?.fingerprint;
        if (recorded && recorded === engine.fingerprint(snapshot))
          return { status: 'ok', version: cur.id } as const;
        const diff = diffAgainst(snapshot, cur.model);
        return diff.total === 0
          ? ({ status: 'ok', version: cur.id } as const)
          : ({
              status: 'drifted',
              version: cur.id,
              diff,
              ...(manual ? { needsManual: manual } : {}),
            } as const);
      } finally {
        await engine.resetSession(conn).catch(() => {});
      }
    });
  } catch (e) {
    if (e instanceof Error && (e as { code?: unknown }).code === 'lock_timeout')
      return { status: 'skipped', reason: 'busy' };
    throw e;
  }
};
