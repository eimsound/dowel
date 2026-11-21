// 概览：项目名称、所属组、我的角色；最近版本、环境配置、最近动态。
// 环境只显示配置，不主动连接数据库（连接在环境详情里测试）。
import type { ProjectActivity, VersionInfo } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, ShieldAlert, Workflow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { ActivityList } from '../components/ActivityList.tsx';
import { DriftBadge } from '../components/EnvBits.tsx';
import { EmptyHint, MoreLink, ProjectPage, Row, Rows, Section } from '../components/ProjectPage.tsx';
import { Banner } from '../components/ui.tsx';
import { useVersionName, VersionBadges, VersionNumber } from '../components/VersionStatus.tsx';
import { driftWarnings, useEnvs } from '../envs.ts';
import { formatTime } from '../format.ts';
import { useProject } from '../project.tsx';

export const Overview = () => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
  });
  const envs = useEnvs(pid);
  const warnings = driftWarnings(envs.data);
  const versionName = useVersionName();
  const activity = useQuery({
    queryKey: ['activity', pid],
    queryFn: () => api<ProjectActivity>('GET', `/api/projects/${pid}/activity`),
  });

  return (
    <ProjectPage
      title={t('nav.overview')}
      actions={
        <Link to="/project/$owner/$project/model" params={params} className="btn primary">
          <Workflow size={16} aria-hidden="true" />
          {t('nav.model')}
        </Link>
      }
    >
      <div className="space-y-6">
        {warnings.length > 0 && (
          <Banner kind="warn" title={t('ov.driftTitle')} role="status">
            <ul className="m-0 mt-1 list-none space-y-1 p-0">
              {warnings.map((e) => (
                <li key={e.id} className="flex items-center gap-2">
                  <ShieldAlert size={14} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    {e.drift.status === 'drifted'
                      ? t('ov.driftBody', { name: e.name, count: e.drift.summary?.total ?? 0 })
                      : t('ov.driftError', { name: e.name })}
                  </span>
                  <Link
                    to="/project/$owner/$project/environments/$eid"
                    params={{ ...params, eid: e.id }}
                    aria-label={`${t('ov.driftView')} ${e.name}`}
                    className="text-xs text-primary-text"
                  >
                    {t('ov.driftView')}
                  </Link>
                </li>
              ))}
            </ul>
          </Banner>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-4 py-3 text-sm">
          <dt className="text-text-2">{t('ov.group')}</dt>
          <dd className="m-0">
            <Link to="/group/$slug" params={{ slug: project.group.slug }} className="no-underline">
              {project.group.name}
            </Link>
            <span className="ml-2 font-mono text-xs text-text-3">{project.group.slug}</span>
          </dd>
          <dt className="text-text-2">{t('ov.role')}</dt>
          <dd className="m-0">{t(`projects.role.${project.role}`)}</dd>
          {(project.envPgMajors.length > 1 ||
            (project.targetPgMajor !== null && project.targetPgMajor < 18)) && (
            <>
              <dt className="text-text-2">{t('ov.targetPg')}</dt>
              <dd className="m-0 flex flex-wrap items-center gap-2">
                <span className="font-mono">PostgreSQL {project.targetPgMajor}+</span>
                {project.envPgMajors.length > 1 && (
                  <span className="font-mono text-xs text-text-3">
                    ({project.envPgMajors.map((v) => `PG ${v}`).join(' · ')})
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>

        <div className="grid grid-cols-2 gap-6 max-[1100px]:grid-cols-1">
          <Section
            title={t('ov.recentVersions')}
            count={versions.data?.length}
            action={
              <MoreLink to={`/project/${params.owner}/${params.project}/versions`}>
                {t('ov.allVersions')}
              </MoreLink>
            }
          >
            {versions.data && versions.data.length === 0 ? (
              <EmptyHint>{t('ov.noVersions')}</EmptyHint>
            ) : (
              <Rows>
                {(versions.data ?? []).slice(0, 5).map((v) => (
                  <Row key={v.id}>
                    <VersionNumber number={v.number} />
                    <Link
                      to="/project/$owner/$project/versions/$vid"
                      params={{ ...params, vid: v.id }}
                      className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
                    >
                      {versionName(v)}
                    </Link>
                    <VersionBadges v={v} />
                    <span className="shrink-0 text-xs text-text-3">
                      {v.createdBy ?? ''} · {formatTime(v.createdAt)}
                    </span>
                  </Row>
                ))}
              </Rows>
            )}
          </Section>

          <Section
            title={t('ov.environments')}
            count={envs.data?.length}
            action={
              <MoreLink to={`/project/${params.owner}/${params.project}/environments`}>
                {t('ov.allEnvironments')}
              </MoreLink>
            }
          >
            {envs.data && envs.data.length === 0 ? (
              <EmptyHint>{t('ov.noEnv')}</EmptyHint>
            ) : (
              <Rows>
                {(envs.data ?? []).map((e) => (
                  <Row key={e.id}>
                    <Database size={16} aria-hidden="true" className="shrink-0 text-text-3" />
                    <Link
                      to="/project/$owner/$project/environments/$eid"
                      params={{ ...params, eid: e.id }}
                      className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
                    >
                      {e.name}
                    </Link>
                    {e.engineMajor !== null && (
                      <span className="chip shrink-0 font-mono">PG {e.engineMajor}</span>
                    )}
                    {e.production && <span className="badge danger">{t('ov.envProduction')}</span>}
                    {e.drift.status === 'drifted' || e.drift.status === 'error' ? (
                      <DriftBadge drift={e.drift} />
                    ) : (
                      <span className="chip">{t('ov.envConfigured')}</span>
                    )}
                  </Row>
                ))}
              </Rows>
            )}
            <p className="hint">{t('ov.configOnly')}</p>
          </Section>
        </div>

        <Section
          title={t('ov.activity')}
          action={
            <MoreLink to={`/project/${params.owner}/${params.project}/activity`}>
              {t('ov.allActivity')}
            </MoreLink>
          }
        >
          <ActivityList events={(activity.data?.events ?? []).slice(0, 6)} />
        </Section>
      </div>
    </ProjectPage>
  );
};
