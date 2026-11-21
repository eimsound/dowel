// 漂移检测：读目标库结构，和环境当前版本的模型比较。只读；不建 dowel schema。
import { emptyBase } from '@dowel/core';
import { type Db, fingerprint, readSnapshot, withProjectLock } from '@dowel/engines';

import { classifyFirstRun, type DiffResult, diffAgainst } from './compare.ts';
import { ExecutorError } from './errors.ts';
import { readState, runVersionId } from './state.ts';
import type { ChainVersion } from './types.ts';

export type DriftReport =
  | {
      status: 'ok';
      /** 比较的是哪个版本（库里还没有历史时是链上第一个版本） */
      version: string | null;
      /** 还没有历史时：库里的结构等于基线 / 是空库 */
      firstRun?: 'baseline' | 'empty';
    }
  | {
      status: 'drifted';
      /** 与哪个版本的模型比较 */
      version: string;
      diff: DiffResult;
      /** 还没有历史时：库的结构既不是基线也不是空库 */
      firstRun?: true;
      /**
       * 上一次执行的读回校验失败（所有步骤都做完了，结构却不等于目标版本）：这个差异就是它留下的，
       * 不能续跑，需要人工修正（或等“处理漂移”功能）。带着那次执行的方向和涉及的版本。
       */
      needsManual?: { versionId: string | null; direction: 'up' | 'down' | 'baseline' };
    }
  | {
      status: 'skipped';
      /** busy：正在执行；unfinished：上次执行停在中途（结构是半途状态，没法比）；no_versions：项目还没有版本 */
      reason: 'busy' | 'unfinished' | 'no_versions';
    };

export interface DriftOptions {
  db: Db;
  projectId: string;
  chain: ChainVersion[];
  /** 可选回调：读取快照后上报目标库的 server_version_num（零额外查询感知原地升级） */
  onVersion?: (versionNum: number) => void;
}

/**
 * 这个库的结构有没有偏离 Dowel 记录的当前版本。
 * - 有历史：和当前版本比，读结构用**当前版本冻结时的 schema 范围**。先比指纹（执行时读回结构记下的值），
 *   一样就没有漂移；不一样再用 plan 算差异——差异为空也算没有漂移（指纹只是快速通道，不是判据）；
 * - 没有历史：和“第一次执行”的判据一致——等于基线模型，或是空库，否则算漂移（范围用第一个版本的）。
 * 取项目锁（不等待）：正在执行时库的结构是半途状态，不能比，返回 skipped / busy。
 */
export const checkDrift = async (o: DriftOptions): Promise<DriftReport> => {
  const first = o.chain[0];
  if (!first) return { status: 'skipped', reason: 'no_versions' };
  try {
    return await withProjectLock(o.db, o.projectId, 0, async (conn) => {
      try {
        const state = await readState(conn, o.projectId);
        if (state.unfinished) return { status: 'skipped', reason: 'unfinished' } as const;
        const manual = state.readbackFailure
          ? {
              versionId: runVersionId(state.readbackFailure),
              direction: state.readbackFailure.direction,
            }
          : undefined;
        if (state.current === null) {
          const snapshot = await readSnapshot(conn, first.scope);
          o.onVersion?.(snapshot.version);
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
        const snapshot = await readSnapshot(conn, cur.scope);
        o.onVersion?.(snapshot.version);
        const recorded = state.versions.find((v) => v.versionId === cur.id)?.fingerprint;
        if (recorded && recorded === fingerprint(snapshot)) return { status: 'ok', version: cur.id } as const;
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
        await conn.exec('RESET ALL').catch(() => {});
      }
    });
  } catch (e) {
    if (e instanceof Error && (e as { code?: unknown }).code === 'lock_timeout')
      return { status: 'skipped', reason: 'busy' };
    throw e;
  }
};
