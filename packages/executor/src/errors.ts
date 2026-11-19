import type { HistoryErrorCode } from '@dowel/engines';
import type { DiffItem } from './types.ts';

export type ExecutorErrorCode =
  | HistoryErrorCode
  /** 版本不存在 / 目标不合法（例如要回滚到第一个版本之前） */
  | 'unknown_version'
  /** 平台库的版本链不完整（序号断档、parent 断裂、校验和与脚本内容不符） */
  | 'chain_broken'
  /** 目标库 dowel 历史里的版本链不完整（含校验和被篡改） */
  | 'history_broken'
  /** 目标库历史与平台库的版本链对不上（版本不在链上、校验和不同……） */
  | 'history_mismatch'
  /** 这个项目的历史属于另一个 Dowel 实例（认领流程之后提供） */
  | 'foreign_instance'
  /** 线上结构与环境当前版本的模型不一致 */
  | 'drift'
  /** 第一次执行到这个库，但它既不是基线结构、也不是空库 */
  | 'first_run_drift'
  /** 要求的方向与实际要走的方向相反（例如用“执行”去回滚） */
  | 'wrong_direction'
  /** 要写基线，但条件不满足 */
  | 'baseline_not_applicable'
  /** 要执行的迁移还没有通过影子库验证 */
  | 'unverified'
  /** 迁移里有实例级语句 */
  | 'instance_level'
  /** 上一次执行停在中途，必须先接着把它跑完 */
  | 'unfinished_run'
  /** 意料之外的错误（读结构失败、范围错误、连接断开……）：已记失败记录，原错误在 `cause` 里 */
  | 'unexpected'
  /** 某一步 SQL 报错 */
  | 'step_failed'
  /** 迁移执行完，读回的结构与目标版本的模型不一致 */
  | 'readback_mismatch';

export interface ExecutorErrorDetails {
  /** 漂移 / 读回不一致的差异（最多 MAX_DIFF 项） */
  diff?: DiffItem[];
  diffTotal?: number;
  /** 完整性问题列表 */
  problems?: string[];
  versionId?: string;
  number?: number;
  direction?: 'up' | 'down' | 'baseline';
  /** 失败的是第几步（从 1 开始） */
  step?: number;
  /** 失败时目标库是不是已经被部分改动（有非事务步骤已经执行、或已提交的部分）：true 时必须先继续跑完它 */
  partial?: boolean;
  /** 读回校验失败时，差异是拿线上结构和哪个版本的模型比出来的（目标版本） */
  comparedVersionId?: string;
  comparedNumber?: number;
  /** 差异是上一次“读回校验失败”的执行留下的：不能续跑，需要人工修正 */
  needsManual?: { direction: 'up' | 'down' | 'baseline'; versionId: string | null };
  /** 出错时环境停在哪个版本（目标库历史里最后一条成功的记录） */
  reached?: string | null;
}

export class ExecutorError extends Error {
  code: ExecutorErrorCode;
  details: ExecutorErrorDetails;
  constructor(code: ExecutorErrorCode, message: string, details: ExecutorErrorDetails = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExecutorError';
    this.code = code;
    this.details = details;
  }
}
