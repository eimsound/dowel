// 项目设置：名称、slug、schema 范围、默认权限（组管理员）、转组、删除项目。
// 删除必须原样输入项目标识（slug）才能点；成功后回“我的项目”。
import type { EnvInfo, GroupList, ProjectInfo, TargetInfo } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { PolicyLayerPanel } from '../components/PolicyEditor.tsx';
import { ProjectPage, Section } from '../components/ProjectPage.tsx';
import { useToast } from '../components/Toasts.tsx';
import { ProjectTokensPanel, TokenPolicyPanel } from '../components/TokenSettings.tsx';
import { Banner } from '../components/ui.tsx';
import { invalidatePolicyDependents } from '../policy-cache.ts';
import { useProject } from '../project.tsx';

export const ProjectSettings = () => {
  const { t } = useTranslation();
  const { pid, project, me } = useProject();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const canManage = project.role === 'admin';
  const canSetDefault = me.role === 'admin' || project.groupRole === 'admin';
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: () => api<GroupList>('GET', '/api/groups'),
    enabled: canManage,
  });
  const [target, setTarget] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const save = useMutation({
    mutationFn: () => api<ProjectInfo>('PATCH', `/api/projects/${pid}`, { name, slug }),
    onSuccess: (p) => {
      qc.setQueryData(['project', pid], p);
      void qc.invalidateQueries({ queryKey: ['projects'] });
      toast(t('pset.saved'));
      if (p.slug !== project.slug || p.name !== project.name) {
        setName(p.name);
        setSlug(p.slug);
      }
      if (p.slug !== project.slug)
        void nav({
          to: '/project/$owner/$project/settings',
          params: { owner: p.group.slug, project: p.slug },
          replace: true,
        });
    },
  });
  const setDefault = useMutation({
    mutationFn: (v: string) =>
      api<ProjectInfo>('PATCH', `/api/projects/${pid}`, { defaultRole: v === 'inherit' ? null : v }),
    onSuccess: (p) => {
      qc.setQueryData(['project', pid], p);
      void qc.invalidateQueries({ queryKey: ['access', pid] });
      toast(t('pset.saved'));
    },
  });
  const transfer = useMutation({
    mutationFn: () => api<ProjectInfo>('POST', `/api/projects/${pid}/transfer`, { groupId: target }),
    onSuccess: async (p) => {
      // 组的归属、项目角色和路径都变了：先把相关缓存全部标为过期，再跳到新地址
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['project', pid] }),
        qc.invalidateQueries({ queryKey: ['access', pid] }),
        qc.invalidateQueries({ queryKey: ['resolve'] }),
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['group'] }),
        qc.invalidateQueries({ queryKey: ['projects'] }),
        // 组层换了：环境的生效策略、配置页的锁定都要重取（转组时变宽的字段被固定进环境层）
        invalidatePolicyDependents(qc),
      ]);
      toast(t('pset.saved'));
      void nav({
        to: '/project/$owner/$project',
        params: { owner: p.group.slug, project: p.slug },
        replace: true,
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/projects/${pid}`, { confirm: confirmText }),
    onSuccess: async () => {
      toast(t('pset.deleted'));
      // 先离开这一页，再处理缓存：这个项目已经删了，不能再让它去 refetch（invalidate 会让观察者重新请求）。
      // 项目自己的数据直接 remove，项目列表 / 组计数才是 invalidate。
      await nav({ to: '/' });
      qc.removeQueries({ queryKey: ['project', pid] });
      qc.removeQueries({ queryKey: ['access', pid] });
      qc.removeQueries({ queryKey: ['versions', pid] });
      qc.removeQueries({ queryKey: ['envs', pid] });
      qc.removeQueries({ queryKey: ['activity', pid] });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['projects'] }),
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['resolve'] }),
      ]);
    },
  });

  return (
    <ProjectPage title={t('pset.title')}>
      <div className="space-y-6">
        <Section title={t('pset.general')}>
          <form
            className="space-y-3 rounded-md border border-border bg-panel p-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <label className="field max-w-md">
              <span className="label">{t('pset.name')}</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canManage}
                required
              />
            </label>
            <label className="field max-w-md">
              <span className="label">{t('pset.slug')}</span>
              <input
                className="input font-mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={!canManage}
                required
                autoCapitalize="none"
                spellCheck={false}
              />
              <span className="hint">{t('pset.slugHint')}</span>
            </label>
            {save.error && (
              <Banner kind="danger" role="alert">
                {save.error.message}
              </Banner>
            )}
            {canManage && (
              <div className="flex justify-end">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={save.isPending}
                  aria-busy={save.isPending}
                >
                  {t('pset.save')}
                </button>
              </div>
            )}
          </form>
        </Section>

        <Section title={t('pset.defaultSection')}>
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-panel p-4">
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
          {!canSetDefault && <p className="hint">{t('access.defaultAdminHint')}</p>}
          {setDefault.error && (
            <Banner kind="danger" role="alert">
              {setDefault.error.message}
            </Banner>
          )}
        </Section>

        <Section title={t('pset.schemaSection')}>
          <SchemaScope pid={pid} project={project} canManage={canManage} />
        </Section>

        {/* 项目层的执行策略（P5a）：项目成员都能看，项目管理员可改；环境自己的那一层在环境页 */}
        <Section title={t('pol.title')}>
          <PolicyLayerPanel
            path={`/api/projects/${pid}/exec-policy`}
            queryKey={['exec-policy', 'project', pid]}
          />
        </Section>

        {/* 项目层的“谁能创建 CI 令牌”（P6 T2）：项目成员可看，项目管理员可改 */}
        <Section title={t('tok.policy.title')}>
          <TokenPolicyPanel
            path={`/api/projects/${pid}/token-policy`}
            queryKey={['token-policy', 'project', pid]}
          />
        </Section>

        {/* CI 令牌管理（P6 T1）：项目管理员和被允许创建令牌的人可见 */}
        {(project.canListTokens || canManage) && (
          <Section title={t('tok.title')}>
            <ProjectTokensPanel pid={pid} />
          </Section>
        )}

        {canManage && (
          <Section title={t('pset.transfer')}>
            <div className="space-y-2 rounded-md border border-border bg-panel p-4">
              <p className="hint mt-0">{t('dlg.transferHint')}</p>
              <div className="flex flex-wrap items-end gap-2">
                <label className="field w-64">
                  <span className="label">{t('dlg.transferTo')}</span>
                  <select
                    className="select"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    aria-label={t('dlg.transferTo')}
                  >
                    <option value="">{t('dlg.pickGroup')}</option>
                    {(groups.data?.groups ?? [])
                      .filter((g) => g.id !== project.group.id)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn"
                  disabled={!target || transfer.isPending}
                  onClick={() => transfer.mutate()}
                >
                  {t('dlg.transferRun')}
                </button>
              </div>
              {transfer.error && (
                <Banner kind="danger" role="alert">
                  {transfer.error.message}
                </Banner>
              )}
            </div>
          </Section>
        )}

        {canManage && (
          <Section title={t('pset.delete')}>
            <div className="space-y-2 rounded-md border border-border bg-panel p-4">
              <Banner kind="danger">{t('pset.deleteHint')}</Banner>
              <label className="field max-w-md">
                <span className="label">{t('pset.deleteConfirmLabel', { slug: project.slug })}</span>
                <input
                  className="input font-mono"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  aria-describedby="delete-project-hint"
                />
                <span id="delete-project-hint" className="hint">
                  {t('pset.deleteConfirmHint', { slug: project.slug })}
                </span>
              </label>
              {remove.error && (
                <Banner kind="danger" role="alert">
                  {remove.error.message}
                </Banner>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn danger solid"
                  disabled={confirmText !== project.slug || remove.isPending}
                  aria-busy={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {t('pset.deleteRun')}
                </button>
              </div>
            </div>
          </Section>
        )}
      </div>
    </ProjectPage>
  );
};

/**
 * schema 范围：导入、从环境拉取、规范化只读这些 schema（dowel 永远跳过）。
 * 有环境时勾选列表来自“连接检查”（第 3 步同款接口）；没有环境时只能手动输入。
 * 不选任何一项 = 全部 schema（接口里发 null）。
 */
const SchemaScope = ({
  pid,
  project,
  canManage,
}: {
  pid: string;
  project: ProjectInfo;
  canManage: boolean;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [manual, setManual] = useState<string | null>(null);
  const [envId, setEnvId] = useState('');
  const [checked, setChecked] = useState<string[] | null>(null);
  const envs = useQuery({
    queryKey: ['envs', pid],
    queryFn: () => api<EnvInfo[]>('GET', `/api/projects/${pid}/environments`),
  });
  const first = envs.data?.[0];
  const activeEnv = envs.data?.find((e) => e.id === envId) ?? first;
  const check = useMutation({
    mutationFn: (eid: string) => api<TargetInfo>('POST', `/api/projects/${pid}/environments/${eid}/test`),
  });
  // 打开这一节时先用第一个环境检查一次：schema 勾选列表直接出现，不用先点“检查连接”
  const started = useRef(false);
  const runCheck = check.mutate;
  useEffect(() => {
    if (started.current || !first) return;
    started.current = true;
    runCheck(first.id);
  }, [first, runCheck]);
  const save = useMutation({
    mutationFn: (schemas: string[] | null) => api<ProjectInfo>('PATCH', `/api/projects/${pid}`, { schemas }),
    onSuccess: (p) => {
      qc.setQueryData(['project', pid], p);
      setChecked(null);
      setManual(null);
      toast(t('pset.schemaSaved'));
    },
  });

  // 勾选列表：连接检查拿到的 schema + 项目范围里可能有、库里暂时没有的名字（手动输入过）
  const fromCheck = check.data?.schemas.map((s) => s.name) ?? [];
  const list = [...new Set([...fromCheck, ...(project.schemas ?? [])])];
  /**
   * 当前选择永远是显式列表：没改动过时按项目上的范围展开 ——
   * projects.schemas 为 null / 空表示“全部”，这里展开成全部 schema 名；保存时正好是全部就存回 null。
   */
  const current = checked ?? (project.schemas?.length ? project.schemas : list);
  const manualValue = manual ?? (project.schemas ?? []).join(', ');
  const toggle = (name: string) =>
    setChecked(current.includes(name) ? current.filter((x) => x !== name) : [...current, name]);
  /** 勾选正好覆盖列表时存 null（“全部”）；一个都没勾是无效状态 */
  const scopeToSave = () => (list.length > 0 && current.length === list.length ? null : current);

  if (!canManage)
    return (
      <div className="rounded-md border border-border bg-panel p-4">
        <p className="m-0 font-mono text-sm">
          {project.schemas?.length ? project.schemas.join('、') : t('pset.schemaAll')}
        </p>
      </div>
    );

  return (
    <div className="space-y-2 rounded-md border border-border bg-panel p-4">
      <p className="hint mt-0">{t('pset.schemaHint')}</p>
      {envs.data && envs.data.length === 0 ? (
        <>
          <Banner kind="info">{t('pset.schemaNoEnv')}</Banner>
          <label className="field max-w-md">
            <span className="label">{t('pset.schemaManual')}</span>
            <input
              className="input font-mono"
              value={manualValue}
              placeholder="public, app"
              spellCheck={false}
              onChange={(e) => setManual(e.target.value)}
            />
            <span className="hint">{t('pset.schemaManualEmpty')}</span>
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              className="btn primary"
              disabled={save.isPending}
              aria-busy={save.isPending}
              onClick={() =>
                save.mutate(
                  manualValue
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            >
              {t('pset.save')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label className="field w-48">
              <span className="label">{t('pset.schemaPick')}</span>
              <select
                className="select"
                value={activeEnv?.id ?? ''}
                onChange={(e) => {
                  setEnvId(e.target.value);
                  setChecked(null);
                  check.reset();
                  check.mutate(e.target.value);
                }}
              >
                {(envs.data ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn mb-0.5"
              disabled={!activeEnv || check.isPending}
              aria-busy={check.isPending}
              onClick={() => activeEnv && check.mutate(activeEnv.id)}
            >
              {check.isPending ? t('wiz.checking') : t('wiz.check')}
            </button>
          </div>
          {check.error && (
            <Banner kind="danger" role="alert">
              {check.error.message}
            </Banner>
          )}
          {list.length > 0 && (
            <div className="checks items-start">
              {list.map((name) => (
                <label key={name}>
                  <input type="checkbox" checked={current.includes(name)} onChange={() => toggle(name)} />
                  <span className="font-mono text-xs">{name}</span>
                  {fromCheck.includes(name) && (
                    <span className="chip">
                      {t('wiz.tables', {
                        count: check.data?.schemas.find((s) => s.name === name)?.tables ?? 0,
                      })}
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
          {list.length > 0 && current.length === 0 && (
            <p className="hint error" role="alert">
              {t('wiz.schemaNeeded')}
            </p>
          )}
          {save.error && (
            <Banner kind="danger" role="alert">
              {save.error.message}
            </Banner>
          )}
          <div className="flex items-center justify-end gap-2">
            <span className="hint mr-auto mb-0">
              {list.length > 0 && current.length === list.length ? t('pset.schemaAll') : ''}
            </span>
            <button
              type="button"
              className="btn primary"
              disabled={save.isPending || current.length === 0 || list.length === 0}
              aria-busy={save.isPending}
              onClick={() => save.mutate(scopeToSave())}
            >
              {t('pset.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
