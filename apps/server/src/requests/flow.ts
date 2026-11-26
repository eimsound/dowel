// 审批流程快照（ADR 0006）：提交时生效流程的快照、默认流程的环节，以及“当前流程是否比快照严”的判断。
import { type ApprovalStage, approvalAtLeast, type RequestApprovers, type ResolvedPolicy } from '@dowel/api';

/** 提交时生效审批流程的快照。implicit：没有配置环节的默认流程（一个环节、一人、审批人 = 有执行权限的人、通过即执行） */
export interface FlowSnapshot {
  implicit: boolean;
  stages: ApprovalStage[];
}

export interface StageSpec {
  approvers: RequestApprovers;
  count: number;
  lastApproverExecutes: boolean;
}

/** 默认流程的那一个环节 */
export const IMPLICIT_STAGE: StageSpec = {
  approvers: { kind: 'can_execute' },
  count: 1,
  lastApproverExecutes: true,
};

export const stagesOf = (f: FlowSnapshot): StageSpec[] => (f.implicit ? [IMPLICIT_STAGE] : f.stages);

export const flowOf = (r: ResolvedPolicy): FlowSnapshot => {
  const stages = r.approval.stages.map((s) => s.stage);
  return { implicit: stages.length === 0, stages };
};

/**
 * 策略中途变化的规则（ADR 0006）：当前生效流程不比快照严——快照的环节按顺序包含当前流程的每个环节——就继续按快照走；
 * 当前流程变严（多了环节、换了环节、人数变了）→ 申请失效，要按新流程重新提交。默认流程的快照只有当前也没配置环节时才成立。
 */
export const flowStillHolds = (snap: FlowSnapshot, current: ApprovalStage[]): boolean =>
  snap.implicit ? current.length === 0 : approvalAtLeast(snap.stages, current);
