// 环境的小部件：漂移状态徽标、“谁能执行”档位文案。
import type { DriftInfo, ExecPolicy } from '@dowel/api';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../format.ts';

/** 漂移状态徽标：无漂移 / 漂移 / 检查失败 / 未检查，带最近检查时间 */
export const DriftBadge = ({ drift, withTime = false }: { drift: DriftInfo; withTime?: boolean }) => {
  const { t } = useTranslation();
  const time =
    withTime && drift.checkedAt ? (
      <time dateTime={drift.checkedAt} className="ml-2 text-xs text-text-3">
        {t('envx.checkedAt', { time: formatTime(drift.checkedAt) })}
      </time>
    ) : null;
  const badge =
    drift.status === 'ok' ? (
      <span className="risk low inline-flex items-center gap-1">
        <CircleCheck size={12} aria-hidden="true" />
        {t('envx.drift.ok')}
      </span>
    ) : drift.status === 'drifted' ? (
      <span className="risk high inline-flex items-center gap-1">
        <TriangleAlert size={12} aria-hidden="true" />
        {t('envx.drift.drifted')}
      </span>
    ) : drift.status === 'error' ? (
      <span className="risk medium inline-flex items-center gap-1">
        <TriangleAlert size={12} aria-hidden="true" />
        {t('envx.drift.error')}
      </span>
    ) : (
      <span className="risk low inline-flex items-center gap-1">
        <CircleHelp size={12} aria-hidden="true" />
        {t('envx.drift.unknown')}
      </span>
    );
  return (
    <span className="inline-flex items-center">
      {badge}
      {time}
    </span>
  );
};

/** 列表里的警告小图标（只给有漂移 / 检查失败的环境）；名字不放进链接里，由 sr-only 的说明用 aria-describedby 关联 */
export const driftLabel = (t: (k: string) => string, drift: DriftInfo): string | null =>
  drift.status === 'drifted'
    ? t('envx.drift.drifted')
    : drift.status === 'error'
      ? t('envx.drift.error')
      : null;

export const policyLabel = (t: (k: string) => string, p: ExecPolicy) => t(`envx.policy.${p}`);

/** 没有权限时的说明：按环境生效的档位说清楚需要谁 */
export const useDeniedHint = () => {
  const { t } = useTranslation();
  return (p: ExecPolicy) => t(`envx.denied.${p}`);
};
