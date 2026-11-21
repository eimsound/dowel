// 读目标库里这个项目的历史状态（只读，不建任何东西）并做完整性检查。
import {
  type ChainProblem,
  type ClaimRow,
  type Db,
  type HistoryVersionRow,
  type ProjectRow,
  type RunRow,
  readClaims,
  readHistory,
  readHistoryFormat,
  readProject,
  verifyChain,
} from '@dowel/engines';

import { ExecutorError } from './errors.ts';
import type { ChainVersion, MigrationDirection } from './types.ts';

/**
 * 没有结束的执行记录（running / failed）：只可能是“执行”（up / down / baseline），不会是 mark——
 * 标记在一个事务里写完（startRun + finishRun），要么 done 要么没有。类型上收窄，别处不用到处处理 mark。
 */
export type OpenRun = RunRow & { direction: MigrationDirection };

/**
 * 读回校验失败的失败记录在 history.error 里的前缀标记。含非事务步骤的迁移，所有步骤都做完了、读回的结构却不等于目标版本：
 * 脚本本身的结果就不对，接着跑解决不了，所以这种记录**不算“停在中途”**（不续跑），而是留着库的半途状态，
 * 由漂移检查报告（附差异），需要人工修正。history 表没有放标记的列，用 error 文本的前缀，不改表结构。
 */
const READBACK_MARK = '[readback_mismatch] ';

/** 给失败记录的错误文本打上“读回校验失败”的标记（执行器写失败记录时用） */
export const markReadbackError = (text: string): string => READBACK_MARK + text;
/** 这条失败记录是不是“读回校验失败”（标记只在这个文件里识别，别处都调用这里的函数） */
export const isReadbackFailure = (error: string | null | undefined): boolean =>
  error?.startsWith(READBACK_MARK) === true;
/** 去掉标记，得到给人看的文本 */
export const stripReadbackMark = (error: string): string =>
  error.startsWith(READBACK_MARK) ? error.slice(READBACK_MARK.length) : error;

/**
 * 这次执行有没有“碰过”目标库（让这个迁移的版本算执行过）：完成了（done，含基线）、或者做了一部分
 * （step_index 非空：已提交的事务段 / 非事务步骤，-1 表示已开始第一个非事务步骤）、或者所有步骤做完读回却不对。
 * 只有**完全干净**的失败（事务整体回滚、step_index 为空）不算。要看**全部**历史，不能只看最后一次执行：
 * 一个版本只要有过一次碰过目标库的执行，之后再来一次干净的失败，它仍然算执行过。
 */
export const runTouched = (r: RunRow): boolean =>
  (r.status === 'done' && r.direction !== 'mark') || r.stepIndex !== null || isReadbackFailure(r.error);

/**
 * 这次执行动的是哪个版本：升级和基线是目标版本（toVersion），回滚是被回滚的版本（fromVersion）。
 * **全仓只有这一份规则**：记录里对应的字段是 null 就返回 null，不回退到另一个字段（回退会把别的版本算成“动过”），由调用方处理。
 */
export const runVersionId = (r: RunRow): string | null =>
  r.direction === 'down' ? r.fromVersion : r.toVersion;

export interface TargetState {
  /** 目标库里有没有 dowel 历史表 */
  historyExists: boolean;
  /** 最后一条 done 的 to_version；没有为 null（从没执行过 / 只有失败的记录） */
  current: string | null;
  versions: HistoryVersionRow[];
  runs: RunRow[];
  project: ProjectRow | null;
  /** 认领事件（dowel.claims），新的在后 */
  claims: ClaimRow[];
  /**
   * 上一次执行停在中途：最后一条记录是 running（进程崩了），或者 failed 但已经有断点（有非事务步骤做完了 / 有事务段提交了）。
   * 这时目标库的结构处于“半途”状态，既不是旧版本也不是新版本：不做漂移检查，必须先把它跑完。
   */
  unfinished: OpenRun | null;
  /**
   * 最后一条记录是“读回校验失败”（见 READBACK_MARK）：库停在半途状态，**不能续跑**，需要人工修正。
   * 漂移检查会把它报成漂移（附上与当前版本模型的差异），执行 / 回滚在漂移检查处被拒绝。
   */
  readbackFailure: OpenRun | null;
}

export const readState = async (db: Db, projectId: string): Promise<TargetState> => {
  // 历史比当前代码新就连读也不行（format_too_new）；没有历史表返回 null
  if ((await readHistoryFormat(db)) === null)
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
  const h = await readHistory(db, projectId);
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
    project: await readProject(db, projectId),
    claims: await readClaims(db, projectId),
    unfinished,
    readbackFailure,
  };
};

/** 链上的版本 → verifyChain 要的行（指纹这里用不上） */
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

/** 平台库的版本链必须完整：序号连续、parent 衔接、冻结脚本按内容重算的校验和与记录一致 */
export const assertPlatformChain = (chain: ChainVersion[], projectId: string) => {
  const problems = verifyChain(asRows(chain, projectId));
  if (problems.length)
    throw new ExecutorError('chain_broken', `平台库里的版本链不完整：${messages(problems)[0]}`, {
      problems: messages(problems),
    });
};

/**
 * 目标库历史的完整性：
 * - 它自己的版本链要通过 verifyChain（序号、parent、**按内容重算的校验和**必须与记录一致——篡改校验和会在这里被发现）；
 * - 它记录的每个版本都必须在平台库的链上，且 id / 序号 / parent / 校验和一致；
 * - **以认领信息为准**：目标库里 `dowel.projects` 记着“当前认领这个项目的实例”（claimProject 换手时写、第一次执行时登记），
 *   不是本实例就拒绝（foreign_instance）。执行记录（history.instance_id）只说明“当时是谁执行的”，换手之后旧实例留下的记录
 *   不影响本实例，所以不看它。只读的漂移检查、读历史不经过这里，不受影响。
 */
export const assertTargetHistory = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  if (!state.historyExists) return;
  // 认领放在最前面：被别的实例认领的库，第一句话就该是“要先认领”，而不是版本链对不上（换手之后对方可能已经往前走了）
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

/** 目标库里这个项目的认领情况：mine = 当前认领它的就是本实例；没有项目行（还没登记）算 mine（第一次执行会登记） */
export const claimOf = (state: TargetState, instanceId: string) => ({
  mine: !state.project || state.project.instanceId === instanceId,
  instanceId: state.project?.instanceId ?? null,
  claimedAt: state.project?.claimedAt ?? null,
  previousInstanceId: state.project?.previousInstanceId ?? null,
});
