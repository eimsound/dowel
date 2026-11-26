// 执行申请与审批（P5b：E3 执行申请、E4 审批流程、E5 紧急执行、E7 收件箱；规则见 ADR 0006、0007）。
//
// 一个申请绑定“起止版本 + 各迁移校验和”（提交时预演得到的计划），并快照提交时生效的审批流程：
// - 审批按快照的环节走，**审批人资格按审批时（锁内重新读到的）成员关系判断**；
// - 当前生效流程比快照严（快照不再包含它）→ 申请失效；变宽或不变 → 继续按快照（更严的那份）走；
// - 环境当前版本变了、检测到漂移、连接设置变了、生产标记变了、链上相关版本的脚本变了、目标版本没了 → 失效；过了有效期 → 过期；
// - 执行时执行器还会在目标库的项目锁里按目标库历史核对一遍（ExecuteOptions.expect），平台库缓存落后也越不过失效。
//
// 执行权限不因审批而来：无论哪种流程，真正执行（“通过并执行”或通过后的“执行”）的人都要满足环境的“谁能执行”
// （或是执行者）。审批流程只会多加限制、不会给谁执行权，所以下级追加环节（ADR 0005 里算收紧）不可能借审批绕过上级的“仅限执行者”。
//
// 状态变化、审批人资格判断都在执行策略锁（withPolicyLock）里，用锁内重新读到的申请、策略、成员关系和环境状态；
// 收件箱的通知、审计与 Webhook 持久化入队（webhook_jobs）在同一个事务里原子写库，实时推送与 Webhook 队列唤醒在提交之后发（Effects）。
//
// 模块划分（requests/ 目录，依赖单向：flow → model → eligibility / binding → scope → notice / views / inbox → service）：
// - flow.ts：审批流程快照与“是否变严”的判断；
// - model.ts：申请行、连接指纹、申请类型 / 方向、中断判断与巡检条件、状态文案、Effects；
// - eligibility.ts：审批人 / 执行权资格判断与受众读取；
// - binding.ts：绑定检查（失效 / 过期）与版本作废的失效原因；
// - scope.ts：申请所在的项目、环境、生效策略；
// - notice.ts：收件箱通知与 Webhook 事件的内容；
// - views.ts：列表摘要、详情、“等我处理”；
// - inbox.ts：收件箱的持久化读取与标记已读；
// - inbox-hub.ts：本副本 SSE 订阅中心与跨副本 inbox.changed 广播；
// - sweeper.ts：巡检调度（定时 / kick / 显式 sweep、分布式锁、撞锁重试）；
// - service.ts：Requests 服务（状态机、事务与副作用、生命周期、总线）。
// 这个文件只做对外导出，调用方仍从 './requests.ts' 导入。
export {
  type BindingCache,
  type BindingProblem,
  bindingProblem,
  newBindingCache,
  retireInvalidReason,
} from './requests/binding.ts';
export {
  approversLabel,
  eligibleFor,
  hasExecRight,
  loadAudience,
  loadRoleContexts,
  type StageScope,
  type UserContext,
} from './requests/eligibility.ts';
export {
  type FlowSnapshot,
  flowOf,
  flowStillHolds,
  IMPLICIT_STAGE,
  type StageSpec,
  stagesOf,
} from './requests/flow.ts';
export {
  connHash,
  Effects,
  execDirectionOf,
  INTERRUPTED,
  isInterrupted,
  loadRequest,
  type NoticeData,
  type RequestRow,
  requestKindOf,
  statusLabel,
  sweepWhere,
} from './requests/model.ts';
export type { RequestScope } from './requests/scope.ts';
export { Requests, type RequestsOptions } from './requests/service.ts';
export { REQUEST_SWEEP_MS, type SweepTarget } from './requests/sweeper.ts';
