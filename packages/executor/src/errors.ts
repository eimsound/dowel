import type { HistoryErrorCode } from '@dowel/engines';
import type { MarkPlan } from './mark.ts';
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
  /** 这个项目在目标库里的“当前认领实例”不是本实例：执行被拒绝，要先认领（只读的检查不受影响） */
  | 'foreign_instance'
  /** 接手 / 接入历史：目标库里没有这个项目的历史 */
  | 'history_missing'
  /** 接手 / 接入历史：同一个版本 ID 在不同环境里的内容不一致（checksum、模型、序号、parent……） */
  | 'history_conflict'
  /** 接手 / 接入历史：链分叉——两个环境在同一个父版本下有不同的子版本 */
  | 'history_fork'
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
  /** 标记为已执行：向前标记没有带预演拿到的计划（expect）：确认必须绑定到预演结果 */
  | 'expect_required'
  /** 标记为已执行：锁里算出的计划和预演时不一样了（目标库在核对之后变了）：什么都没写，details.markPlan 是新的计划 */
  | 'plan_changed'
  /**
   * 执行申请（P5b）：锁里读到的起始版本、要执行的迁移或它们的校验和，和申请提交时绑定的不一样了
   * （环境状态变了、链上相关版本的内容变了）：什么都没写，申请应当失效
   */
  | 'request_stale'
  /** 标记为已执行：向前标记没有确认“被跳过的版本里的脚本效果已经手工完成，或者不需要” */
  | 'ack_required'
  /** 标记为已执行：线上结构不等于目标版本的模型 */
  | 'mark_mismatch'
  /** 标记为已执行：环境已经记在目标版本 */
  | 'mark_noop'
  /** 意料之外的错误（读结构失败、范围错误、连接断开……）：已记失败记录，原错误在 `cause` 里 */
  | 'unexpected'
  /** 某一步 SQL 报错 */
  | 'step_failed'
  /**
   * 某一步因为执行策略的超时被 PG 取消（lock_timeout：55P03；statement_timeout：57014）。和 step_failed 一样会留下失败记录、
   * 能重试 / 续跑；单独一个代码是为了让用户知道这不是脚本本身的错误（details.timeout 说明是哪一种、当时的设置）
   */
  | 'step_timeout'
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
  /** foreign_instance：当前认领这个项目的实例，以及换手信息 */
  claim?: { instanceId: string; claimedAt: string | null; previousInstanceId: string | null };
  /** plan_changed：锁里重新算出的标记计划 */
  markPlan?: MarkPlan;
  /** 出错时环境停在哪个版本（目标库历史里最后一条成功的记录） */
  reached?: string | null;
  /** step_timeout：lock = 等锁超过 lock_timeout，statement = 语句超过 statement_timeout；ms 是当时的设置 */
  timeout?: { kind: 'lock' | 'statement'; ms: number };
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
