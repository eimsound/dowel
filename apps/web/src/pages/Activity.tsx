// 动态：项目、版本、环境的操作日志（只读，最近 50 条）。权限是项目查看者。
import type { ProjectActivity } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { ActivityList } from '../components/ActivityList.tsx';
import { ProjectPage } from '../components/ProjectPage.tsx';
import { useProject } from '../project.tsx';

export const ActivityPage = () => {
  const { t } = useTranslation();
  const { pid } = useProject();
  const activity = useQuery({
    queryKey: ['activity', pid],
    queryFn: () => api<ProjectActivity>('GET', `/api/projects/${pid}/activity`),
  });
  return (
    <ProjectPage title={t('activity.title')}>
      {activity.error && (
        <p role="alert" className="text-sm text-danger">
          {activity.error.message}
        </p>
      )}
      <ActivityList events={activity.data?.events ?? []} />
    </ProjectPage>
  );
};
