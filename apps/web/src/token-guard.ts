// 执行策略配置页的“CI 令牌仍可免审批执行”提醒（ADR 0010 的权限传导边界、pitfalls #10）。
// 单独放一个模块，便于不带 React / i18n 地单测。
//
// CI 令牌执行（/api/ci/…/execute）只看环境生效的“允许 CI 令牌执行”，不受“谁能执行”和审批流程约束；
// 非生产环境默认允许。所以管理员把非生产收紧（谁能执行比默认严、或配置了审批环节）却没关掉令牌执行时，
// 被允许创建 CI 令牌的成员仍然可以签发令牌免审批向前执行。这里只做提示，不改任何默认值和服务端语义。
import { compareField, POLICY_DEFAULTS, type ResolvedPolicy } from '@dowel/api';

/**
 * 这一套（非生产）策略是否“收紧了但令牌仍可绕过”：
 * - 只看非生产：生产默认不允许令牌执行，打开它是显式选择；
 * - 用生效值（含上级的锁定），不只看本层自己的设置——上级收紧、本层仍能关掉令牌执行；
 * - 谁能执行比非生产默认（项目编辑者）严，或生效的审批流程至少有一个环节（不论来自哪一层）；
 * - 且生效的“允许 CI 令牌执行”仍是允许。
 */
export const tokenBypassRisk = (r: ResolvedPolicy): boolean => {
  if (r.production || !r.allowTokens.value) return false;
  const tightenedWho =
    compareField('whoCanExecute', r.whoCanExecute.value, POLICY_DEFAULTS(false).whoCanExecute) > 0;
  return tightenedWho || r.approval.stages.length > 0;
};
