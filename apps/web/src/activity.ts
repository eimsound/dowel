// 审计动作的中文描述：项目动态（ActivityList）和后台审计日志共用一份映射，
// 键是 i18n 里的 act.<action>（动作名在服务端是 `领域.动作`，见 audit-coverage.test.ts）。
// 没登记的动作显示“执行了一个操作”，不把英文动作名直接抛给用户。
import i18n from './i18n.ts';

export const actionText = (action: string, data: unknown) => {
  const d = (data ?? {}) as Record<string, unknown>;
  const key = `act.${action}`;
  if (!i18n.exists(key)) return i18n.t('act.unknown');
  const environment = typeof d.environment === 'string' ? d.environment.trim() : '';
  const name = typeof d.name === 'string' ? d.name : environment;
  return i18n.t(key, {
    name,
    environment,
    ...(environment ? { context: 'env' } : {}),
    count: typeof d.objects === 'number' ? d.objects : 0,
    role: typeof d.role === 'string' ? i18n.t(`projects.role.${d.role}`) : '',
    username: typeof d.username === 'string' ? d.username : '',
    provider: typeof d.provider === 'string' ? d.provider : '',
  });
};
