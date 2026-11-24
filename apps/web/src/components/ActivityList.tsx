// 项目动态列表：谁、什么时候、做了什么（DESIGN.md：时间是相对时间，操作用动词）。
import type { ProjectActivityEvent } from '@dowel/api';
import { useTranslation } from 'react-i18next';

import { actionText, viaMcp } from '../activity.ts';
import { formatTime } from '../format.ts';
import { McpBadge } from './McpTokens.tsx';
import { Avatar } from './ui.tsx';

export const ActivityList = ({ events }: { events: ProjectActivityEvent[] }) => {
  const { t } = useTranslation();
  if (!events.length) return <p className="hint">{t('activity.empty')}</p>;
  return (
    <ol className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
      {events.map((e) => {
        const actor = e.actorName ?? e.actorUsername ?? t('activity.system');
        const label = actionText(e.action, e.data);
        return (
          <li
            key={e.id}
            className="flex items-center gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-border"
          >
            <Avatar name={actor} color="var(--peer-2)" />
            <p className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{actor}</span> {label}
            </p>
            {viaMcp(e.data) && <McpBadge />}
            <time dateTime={e.at} className="shrink-0 text-xs text-text-3">
              {formatTime(e.at)}
            </time>
          </li>
        );
      })}
    </ol>
  );
};
