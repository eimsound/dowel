// 读目标库里这个项目的历史状态（只读，不建任何东西）并做完整性检查。
import {
  type ChainProblem,
  type Db,
  type HistoryVersionRow,
  historyExists,
  type ProjectRow,
  type RunRow,
  readHistory,
  readProject,
  verifyChain,
} from '@dowel/engines';
import { ExecutorError } from './errors.ts';
import type { ChainVersion } from './types.ts';

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
  r.status === 'done' || r.stepIndex !== null || isReadbackFailure(r.error);

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
  /**
   * 上一次执行停在中途：最后一条记录是 running（进程崩了），或者 failed 但已经有断点（有非事务步骤做完了 / 有事务段提交了）。
   * 这时目标库的结构处于“半途”状态，既不是旧版本也不是新版本：不做漂移检查，必须先把它跑完。
   */
  unfinished: RunRow | null;
  /**
   * 最后一条记录是“读回校验失败”（见 READBACK_MARK）：库停在半途状态，**不能续跑**，需要人工修正。
   * 漂移检查会把它报成漂移（附上与当前版本模型的差异），执行 / 回滚在漂移检查处被拒绝。
   */
  readbackFailure: RunRow | null;
}

export const readState = async (db: Db, projectId: string): Promise<TargetState> => {
  if (!(await historyExists(db)))
    return {
      historyExists: false,
      current: null,
      versions: [],
      runs: [],
      project: null,
      unfinished: null,
      readbackFailure: null,
    };
  const h = await readHistory(db, projectId);
  const last = h.history.at(-1) ?? null;
  const readbackFailure = last?.status === 'failed' && isReadbackFailure(last.error) ? last : null;
  const unfinished =
    !readbackFailure &&
    last &&
    (last.status === 'running' || (last.status === 'failed' && last.stepIndex !== null))
      ? last
      : null;
  return {
    historyExists: true,
    current: h.currentVersion,
    versions: h.versions,
    runs: h.history,
    project: await readProject(db, projectId),
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
 * - 这个项目的历史必须属于本实例（认领流程之后提供）。
 */
export const assertTargetHistory = (state: TargetState, chain: ChainVersion[], instanceId: string) => {
  if (!state.historyExists) return;
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
  if (state.project && state.project.instanceId !== instanceId)
    throw new ExecutorError(
      'foreign_instance',
      `这个项目在目标库里的历史属于另一个 Dowel 实例（${state.project.instanceId}），本实例（${instanceId}）不能执行。接手现有库的认领流程在后续版本提供`,
    );
};
