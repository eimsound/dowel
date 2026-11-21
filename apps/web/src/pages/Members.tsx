// 成员与授权：直接授权、来自组默认权限的成员、项目默认权限（只有组管理员能改）。
// 内容原来在“成员与授权”对话框里，P2 改成页面。P5a 起可以授予“执行者”（整个项目或某个环境）。
import type { Directory, GrantInfo, GrantRole, GrantSubjectKind, ProjectAccess, Role } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../api.ts';
import { ProjectPage, Section } from '../components/ProjectPage.tsx';
import { Avatar, Banner, IconButton } from '../components/ui.tsx';
import { useEnvs } from '../envs.ts';
import { useProject } from '../project.tsx';

const ROLE_OPTIONS = ['viewer', 'editor', 'admin'] as const;
const GRANT_OPTIONS = [...ROLE_OPTIONS, 'executor'] as const;

export const Members = () => {
  const { t } = useTranslation();
  const { pid, project, me } = useProject();
  const qc = useQueryClient();
  const canManage = project.role === 'admin';
  // 项目的默认权限属于组设置：只有组管理员（含实例管理员）能改
  const canSetDefault = me.role === 'admin' || project.groupRole === 'admin';
  const access = useQuery({
    queryKey: ['access', pid],
    queryFn: () => api<ProjectAccess>('GET', `/api/projects/${pid}/grants`),
  });
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState<{ kind: GrantSubjectKind; id: string; name: string } | null>(null);
  const [role, setRole] = useState<GrantRole>('editor');
  /** 执行者授权的范围：空 = 整个项目，否则是环境 ID */
  const [scopeEnv, setScopeEnv] = useState('');
  const envs = useEnvs(pid);
  const instanceAdmin = me.role === 'admin';
  // “仅限执行者”的生产环境：执行者只能由实例管理员授予（服务端同样拒绝），非实例管理员不能选，并说明原因
  const executorOnlyProd = (envs.data ?? []).filter(
    (e) => e.production && e.policy.whoCanExecute.value === 'executor',
  );
  const dir = useQuery({
    queryKey: ['directory', q],
    queryFn: () => api<Directory>('GET', `/api/directory?q=${encodeURIComponent(q)}`),
    enabled: canManage && !subject,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['access', pid] });
    void qc.invalidateQueries({ queryKey: ['project', pid] });
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api<GrantInfo>('POST', `/api/projects/${pid}/grants`, {
        subjectKind: subject!.kind,
        subjectId: subject!.id,
        role,
        ...(role === 'executor' && scopeEnv ? { environmentId: scopeEnv } : {}),
      }),
    onSuccess: () => {
      setSubject(null);
      setQ('');
      setScopeEnv('');
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: (x: { id: string; role: Role }) =>
      api('PATCH', `/api/projects/${pid}/grants/${x.id}`, { role: x.role }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/projects/${pid}/grants/${id}`),
    onSuccess: refresh,
  });
  const setDefault = useMutation({
    mutationFn: (v: string) =>
      api('PATCH', `/api/projects/${pid}`, { defaultRole: v === 'inherit' ? null : v }),
    onSuccess: refresh,
  });
  const grantError = add.error ?? change.error ?? remove.error;

  return (
    <ProjectPage title={t('access.title')}>
      <div className="space-y-6">
        <Section
          title={t('dlg.projectDefault')}
          action={canSetDefault ? null : <span className="hint">{t('access.defaultAdminHint')}</span>}
        >
          <div className="flex flex-wrap items-end gap-3">
            <label className="field w-56">
              <select
                className="select"
                aria-label={t('dlg.projectDefault')}
                value={project.defaultRole ?? 'inherit'}
                disabled={!canSetDefault || setDefault.isPending}
                onChange={(e) => setDefault.mutate(e.target.value)}
              >
                <option value="inherit">
                  {t('dlg.inheritDefault', {
                    role: t(`projects.defaultRole.${project.groupDefaultRole}`),
                  })}
                </option>
                {(['none', 'viewer', 'editor', 'admin'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`projects.defaultRole.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint max-w-[520px] flex-1 pb-1.5">{t('dlg.defaultHint')}</p>
          </div>
          {setDefault.error && (
            <Banner kind="danger" role="alert">
              {setDefault.error.message}
            </Banner>
          )}
        </Section>

        <Section
          title={t('dlg.grants')}
          count={access.data?.grants.length}
          action={canManage ? null : <span className="hint">{t('access.manageHint')}</span>}
        >
          <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
            {(access.data?.grants ?? []).map((g) => (
              <li
                key={g.id}
                className="flex items-center gap-2.5 px-3 py-2 not-first:border-t not-first:border-border"
              >
                <Avatar name={g.subject.name} color="var(--me)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{g.subject.name}</span>
                  <span className="block truncate font-mono text-xs text-text-3">
                    {g.subject.slug} · {t(g.subject.kind === 'user' ? 'dlg.subjectUser' : 'dlg.subjectGroup')}
                    {g.role === 'executor' &&
                      ` · ${g.scopeKind === 'environment' ? t('pol.executor.env', { name: g.environmentName ?? g.scopeId }) : t('pol.executor.wholeProject')}${g.byInstanceAdmin ? ` · ${t('pol.executor.byAdmin')}` : ''}`}
                  </span>
                </span>
                {canManage && g.role !== 'executor' ? (
                  <select
                    aria-label={t('dlg.roleOf', { name: g.subject.name })}
                    className="select w-32"
                    value={g.role}
                    disabled={change.isPending}
                    onChange={(e) => change.mutate({ id: g.id, role: e.target.value as Role })}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`projects.role.${r}`)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="chip">{t(`projects.role.${g.role}`)}</span>
                )}
                {canManage && (
                  <IconButton
                    label={t('dlg.removeGrant', { name: g.subject.name })}
                    className="hover:!text-danger"
                    onClick={() => remove.mutate(g.id)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </IconButton>
                )}
              </li>
            ))}
            {access.data?.grants.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-text-3">{t('dlg.noGrants')}</li>
            )}
          </ul>
          {grantError && (
            <Banner kind="danger" role="alert">
              {grantError.message}
            </Banner>
          )}
        </Section>

        {canManage && (
          <Section title={t('dlg.addGrant')}>
            <div className="space-y-2 rounded-md border border-border bg-panel p-3.5">
              {subject ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="chip">
                    {subject.name} · {t(subject.kind === 'user' ? 'dlg.subjectUser' : 'dlg.subjectGroup')}
                  </span>
                  <button type="button" className="btn ghost" onClick={() => setSubject(null)}>
                    {t('dlg.change')}
                  </button>
                  <select
                    aria-label={t('dlg.role')}
                    className="select w-32"
                    value={role}
                    onChange={(e) => setRole(e.target.value as GrantRole)}
                  >
                    {GRANT_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {t(`projects.role.${r}`)}
                      </option>
                    ))}
                  </select>
                  {role === 'executor' && (
                    <select
                      aria-label={t('pol.executor.scope')}
                      className="select w-48"
                      value={scopeEnv}
                      onChange={(e) => setScopeEnv(e.target.value)}
                    >
                      <option value="">{t('pol.executor.wholeProject')}</option>
                      {(envs.data ?? []).map((e) => {
                        const blocked = !instanceAdmin && executorOnlyProd.some((x) => x.id === e.id);
                        return (
                          <option key={e.id} value={e.id} disabled={blocked}>
                            {t('pol.executor.env', { name: e.name })}
                            {blocked ? `（${t('pol.executor.prodOnlyAdmin')}）` : ''}
                          </option>
                        );
                      })}
                    </select>
                  )}
                  <button
                    type="button"
                    className="btn primary"
                    disabled={add.isPending}
                    onClick={() => add.mutate()}
                  >
                    {t('dlg.addGrantRun')}
                  </button>
                  {role === 'executor' && (
                    <div className="w-full space-y-1">
                      <p className="hint m-0">{t('pol.executor.hint')}</p>
                      {!instanceAdmin && executorOnlyProd.length > 0 && (
                        <p className="hint m-0" data-testid="executor-prod-note">
                          {t('pol.executor.prodNote', {
                            names: executorOnlyProd.map((e) => e.name).join('、'),
                          })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <input
                    className="input"
                    aria-label={t('dlg.searchSubject')}
                    placeholder={t('dlg.searchSubject')}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                  <ul className="m-0 list-none p-0">
                    {dir.data?.users.map((u) => (
                      <li key={`u-${u.id}`}>
                        <button
                          type="button"
                          className="w-full rounded-sm px-1.5 py-1 text-left text-base hover:bg-surface-hover"
                          onClick={() => setSubject({ kind: 'user', id: u.id, name: u.name })}
                        >
                          {u.name} <span className="font-mono text-xs text-text-3">{u.slug}</span>
                        </button>
                      </li>
                    ))}
                    {dir.data?.groups.map((g) => (
                      <li key={`g-${g.id}`}>
                        <button
                          type="button"
                          className="w-full rounded-sm px-1.5 py-1 text-left text-base hover:bg-surface-hover"
                          onClick={() => setSubject({ kind: 'group', id: g.id, name: g.name })}
                        >
                          {g.name} <span className="font-mono text-xs text-text-3">{g.slug}</span>{' '}
                          <span className="chip">{t('dlg.subjectGroup')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Section>
        )}

        <Section title={t('dlg.defaultMembers')}>
          <p className="hint">{t('dlg.defaultMembersHint')}</p>
          <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">
            {(access.data?.defaultMembers ?? []).map((m) => (
              <li
                key={m.userId}
                className="flex items-center gap-2.5 px-3 py-2 not-first:border-t not-first:border-border"
              >
                <Avatar name={m.name} color="var(--peer-2)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{m.name}</span>
                  <span className="block truncate font-mono text-xs text-text-3">{m.username}</span>
                </span>
                {m.groupAdmin && <span className="chip">{t('groups.role.admin')}</span>}
                <span className="chip">
                  {m.role === 'none' ? t('projects.defaultRole.none') : t(`projects.role.${m.role}`)}
                </span>
              </li>
            ))}
            {access.data?.defaultMembers.length === 0 && (
              <li className="px-3 py-4 text-center text-sm text-text-3">{t('dlg.noDefaultMembers')}</li>
            )}
          </ul>
        </Section>
      </div>
    </ProjectPage>
  );
};
