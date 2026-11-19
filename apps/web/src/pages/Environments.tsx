// 环境：侧面板是环境列表，主区域是列表 + 新建（管理员）或单个环境的详情。
// 详情里可以测试连接、从目标库导入结构、删除环境；连接状态只在这里主动检查。
import type {
  DriftCheckResponse,
  EnvInfo,
  EnvStatus,
  EnvVersion,
  ExecPolicy,
  ModelUpdate,
  RunInfo,
  TargetInfo,
} from '@dowel/api';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowDownToLine,
  Database,
  FileInput,
  Play,
  PlugZap,
  Plus,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { DriftBadge, driftLabel, useDeniedHint } from '../components/EnvBits.tsx';
import { DiffList, ExecDialog, type ExecKind } from '../components/ExecDialog.tsx';
import { Confirm } from '../components/Modal.tsx';
import { EmptyHint, ProjectPage, Row, Rows, Section } from '../components/ProjectPage.tsx';
import { PageHeader, useShellPanel } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Banner, IconButton } from '../components/ui.tsx';
import { RiskNote, useVersionName, VersionBadges, VersionNumber } from '../components/VersionStatus.tsx';
import { EXEC_POLICIES, useEnvHistory, useEnvStatus, useEnvs } from '../envs.ts';
import { formatTime } from '../format.ts';
import { useProject } from '../project.tsx';

/**
 * 侧面板里的一个环境。漂移警告的说明不放进链接里（链接的名字要保持就是环境名），
 * 用 aria-describedby 指向旁边的 sr-only 文字，图标本身 aria-hidden。
 */
const EnvPanelLink = ({
  e,
  params,
  active,
}: {
  e: EnvInfo;
  params: { owner: string; project: string };
  active: boolean;
}) => {
  const { t } = useTranslation();
  const descId = useId();
  const warn = driftLabel(t, e.drift);
  return (
    <>
      <Link
        to="/project/$owner/$project/environments/$eid"
        params={{ ...params, eid: e.id }}
        aria-current={active ? 'page' : undefined}
        aria-describedby={warn ? descId : undefined}
        className="flex h-[var(--row-h)] items-center gap-2 rounded-sm px-2 font-mono text-sm text-text-2 no-underline hover:bg-surface-hover aria-[current=page]:bg-primary-soft aria-[current=page]:text-primary-text"
      >
        <Database size={16} aria-hidden="true" className="shrink-0 text-text-3" />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {warn && (
          <ShieldAlert
            size={14}
            aria-hidden="true"
            className={e.drift.status === 'drifted' ? 'shrink-0 text-danger' : 'shrink-0 text-warn'}
          />
        )}
        {e.production && <span className="badge danger font-sans">{t('envp.production')}</span>}
      </Link>
      {warn && (
        <span id={descId} className="sr-only">
          {warn}
        </span>
      )}
    </>
  );
};

/** 项目页的侧面板：环境列表（DESIGN.md：Layout） */
const EnvPanel = ({ pid, activeId }: { pid: string; activeId?: string }) => {
  const { t } = useTranslation();
  const { project } = useProject();
  const envs = useEnvs(pid);
  const params = { owner: project.group.slug, project: project.slug };
  useShellPanel(
    t('envp.list'),
    <nav aria-label={t('envp.list')} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <span className="section-title flex-1">
          {t('nav.environments')}
          <span className="count">{envs.data?.length ?? 0}</span>
        </span>
        <Link
          to="/project/$owner/$project/environments"
          params={params}
          className="btn icon ghost"
          aria-label={t('envp.add')}
          title={t('envp.add')}
        >
          <Plus size={16} aria-hidden="true" />
        </Link>
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-1.5">
        {(envs.data ?? []).map((e) => (
          <li key={e.id}>
            <EnvPanelLink e={e} params={params} active={e.id === activeId} />
          </li>
        ))}
      </ul>
    </nav>,
    [envs.data, activeId, params.owner, params.project, project.role, t],
  );
  return null;
};

const EnvForm = ({ pid }: { pid: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const empty = { name: '', url: '', production: true, allowSameInstance: false, shadowUrl: '' };
  const [form, setForm] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      api('POST', `/api/projects/${pid}/environments`, {
        ...form,
        shadowUrl: form.shadowUrl.trim() || null,
      }),
    onSuccess: () => {
      setForm(empty);
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form
      className="space-y-3 rounded-md border border-border bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <h2 className="section-title">{t('envp.add')}</h2>
      <p className="hint">{t('dlg.envHint')}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[800px]:grid-cols-1">
        <label className="field">
          <span className="label">{t('dlg.envName')}</span>
          <input
            className="input"
            aria-label={t('dlg.envName')}
            value={form.name}
            onChange={set('name')}
            placeholder="dev"
            required
          />
        </label>
        <label className="field">
          <span className="label">{t('dlg.envUrl')}</span>
          <input
            className="input font-mono"
            aria-label={t('dlg.envUrl')}
            value={form.url}
            onChange={set('url')}
            placeholder="postgres://user:password@host:5432/db"
            spellCheck={false}
            required
          />
        </label>
        <div className="checks col-span-2">
          <label>
            <input type="checkbox" checked={form.production} onChange={set('production')} />
            {t('dlg.envProduction')}
          </label>
          <label>
            <input type="checkbox" checked={form.allowSameInstance} onChange={set('allowSameInstance')} />
            {t('dlg.envAllowSame')}
          </label>
        </div>
        <label className="field col-span-2">
          <span className="label">{t('dlg.envShadowUrl')}</span>
          <input
            className="input font-mono"
            aria-label={t('dlg.envShadowUrl')}
            value={form.shadowUrl}
            onChange={set('shadowUrl')}
            spellCheck={false}
          />
        </label>
      </div>
      {add.error && (
        <Banner kind="danger" role="alert">
          {add.error.message}
        </Banner>
      )}
      <div className="flex justify-end">
        <button type="submit" className="btn primary" disabled={add.isPending} aria-busy={add.isPending}>
          {t('dlg.envAdd')}
        </button>
      </div>
    </form>
  );
};

export const Environments = () => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const envs = useEnvs(pid);
  const canManage = project.role === 'admin';
  return (
    <>
      <EnvPanel pid={pid} />
      <ProjectPage title={t('envp.title')}>
        <div className="space-y-6">
          <p className="text-sm text-text-2">{t('envp.addHint')}</p>
          {envs.data && envs.data.length === 0 ? (
            <EmptyHint>{t('envp.empty')}</EmptyHint>
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
                  {e.production ? (
                    <span className="badge danger">{t('envp.production')}</span>
                  ) : (
                    <span className="badge">{t('envp.notProduction')}</span>
                  )}
                  {(e.drift.status === 'drifted' || e.drift.status === 'error') && (
                    <DriftBadge drift={e.drift} />
                  )}
                  <code className="w-72 truncate text-xs text-text-3 max-[900px]:hidden">{e.url}</code>
                </Row>
              ))}
            </Rows>
          )}
          {canManage ? <EnvForm pid={pid} /> : <Banner kind="info">{t('envp.manageHint')}</Banner>}
        </div>
      </ProjectPage>
    </>
  );
};

const VERSION_STATE_KEY = {
  applied: 'envx.state.applied',
  current: 'envx.state.current',
  pending: 'envx.state.pending',
} as const;

/** 版本链：每个版本相对这个环境的当前版本是已执行 / 当前 / 待执行 */
const VersionChain = ({
  status,
  params,
}: {
  status: EnvStatus;
  params: { owner: string; project: string };
}) => {
  const { t } = useTranslation();
  const versionName = useVersionName();
  return (
    <Rows>
      {[...status.versions].reverse().map((v) => (
        <Row key={v.id}>
          <VersionNumber number={v.number} />
          <Link
            to="/project/$owner/$project/versions/$vid"
            params={{ ...params, vid: v.id }}
            className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
          >
            {versionName(v)}
          </Link>
          <VersionBadges v={{ verifiedAt: v.verified ? 'x' : null, edited: v.edited }} />
          {v.nonTransactional && (
            <span className="risk medium" title={t('envx.nonTx')}>
              {t('envx.nonTxShort')}
            </span>
          )}
          {v.risk && v.risk !== 'low' && (
            <span className={`risk ${v.risk}`}>{t(`envx.exec.risk.${v.risk}`)}</span>
          )}
          {v.riskError && (
            <span className="risk medium" title={v.riskError}>
              {t('envx.exec.riskError')}
            </span>
          )}
          <span className={v.state === 'current' ? 'chip text-primary-text' : 'chip'} data-state={v.state}>
            {t(VERSION_STATE_KEY[v.state])}
          </span>
        </Row>
      ))}
    </Rows>
  );
};

const DIRECTION_KEY = { baseline: 'envx.dir.baseline', up: 'envx.dir.up', down: 'envx.dir.down' } as const;
const RUN_STATUS_KEY = {
  running: 'envx.run.running',
  done: 'envx.run.done',
  failed: 'envx.run.failed',
} as const;

const vlabel = (v: { number: number } | null) => (v ? `v${v.number}` : '—');

/** 执行历史（读目标库 dowel.history），新的在前 */
const HistoryTable = ({ runs }: { runs: RunInfo[] }) => {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-panel">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t('envx.history')}</caption>
        <thead>
          <tr className="text-left text-xs text-text-3">
            <th scope="col" className="px-3 py-2 font-medium">
              {t('envx.run.time')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('envx.run.direction')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('envx.run.versions')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('envx.run.status')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('envx.run.by')}
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-border align-top" data-run={r.direction}>
              <td className="px-3 py-2 whitespace-nowrap text-text-2">
                <time dateTime={r.startedAt}>{formatTime(r.startedAt)}</time>
              </td>
              <td className="px-3 py-2">{t(DIRECTION_KEY[r.direction])}</td>
              <td className="px-3 py-2 font-mono">
                {r.direction === 'baseline'
                  ? vlabel(r.toVersion)
                  : `${vlabel(r.fromVersion)} → ${vlabel(r.toVersion)}`}
              </td>
              <td className="px-3 py-2">
                <span
                  className={
                    r.status === 'failed' ? 'risk high' : r.status === 'running' ? 'risk medium' : 'risk low'
                  }
                >
                  {t(RUN_STATUS_KEY[r.status])}
                </span>
                {r.readbackFailure && (
                  <span className="ml-2 text-xs text-text-3">{t('envx.run.readbackFailure')}</span>
                )}
                {r.stepIndex !== null && r.status !== 'done' && !r.readbackFailure && (
                  <span className="ml-2 text-xs text-text-3">
                    {t('envx.run.checkpoint', { step: r.stepIndex + 1 })}
                  </span>
                )}
                {r.error && (
                  <p className="m-0 mt-1 text-xs break-words whitespace-pre-wrap text-danger">{r.error}</p>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-text-3" title={r.executedBy ?? undefined}>
                {r.executedByName ?? (r.executedBy ? r.executedBy.slice(0, 8) : '—')} · {r.via}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** “谁能执行”档位：有 configure 权限的人可以改；默认值标明“默认” */
const PolicySetting = ({ pid, env, status }: { pid: string; env: EnvInfo; status: EnvStatus }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const save = useMutation({
    mutationFn: (execPolicy: ExecPolicy | null) =>
      api('PATCH', `/api/projects/${pid}/environments/${env.id}`, { execPolicy }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['env-status', pid, env.id] });
      toast(t('envx.policy.saved'));
    },
  });
  const def: ExecPolicy = env.production ? 'admin' : 'editor';
  const can = status.permissions.configure;
  return (
    <div className="space-y-2 rounded-md border border-border bg-panel px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id} className="text-text-2">
          {t('envx.policy.label')}
        </label>
        {can ? (
          <select
            id={id}
            className="input w-auto"
            value={status.execPolicy ?? ''}
            disabled={save.isPending}
            onChange={(e) => save.mutate((e.target.value || null) as ExecPolicy | null)}
          >
            <option value="">{t('envx.policy.default', { policy: t(`envx.policy.${def}`) })}</option>
            {EXEC_POLICIES.map((p) => (
              <option key={p} value={p}>
                {t(`envx.policy.${p}`)}
              </option>
            ))}
          </select>
        ) : (
          <span id={id} className="font-medium">
            {t(`envx.policy.${status.effectiveExecPolicy}`)}
            {status.execPolicy === null && (
              <span className="ml-1 text-text-3">{t('envx.policy.defaultTag')}</span>
            )}
          </span>
        )}
      </div>
      <p className="hint m-0">{t('envx.policy.hint')}</p>
      {status.effectiveExecPolicy === 'executor' && (
        <p className="hint m-0">{t('envx.policy.executorNote')}</p>
      )}
      {!can && <p className="hint m-0">{t('envx.policy.readonly')}</p>}
      {save.error && (
        <Banner kind="danger" role="alert">
          {save.error.message}
        </Banner>
      )}
    </div>
  );
};

const EnvironmentDetailView = ({ eid }: { eid: string }) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const denied = useDeniedHint();
  const envs = useEnvs(pid);
  const statusQ = useEnvStatus(pid, eid);
  const historyQ = useEnvHistory(pid, eid);
  const env = envs.data?.find((e) => e.id === eid);
  const status = statusQ.data;
  const history = historyQ.data;
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [dlg, setDlg] = useState<{ kind: ExecKind; to?: EnvVersion } | null>(null);
  const [execTo, setExecTo] = useState('');
  const [rollTo, setRollTo] = useState('');
  const versionName = useVersionName();
  const execSelectId = useId();
  const rollSelectId = useId();
  const canPull = project.role !== 'viewer';

  const refreshState = () => {
    void qc.invalidateQueries({ queryKey: ['envs', pid] });
    void qc.invalidateQueries({ queryKey: ['env-status', pid, eid] });
    void qc.invalidateQueries({ queryKey: ['env-history', pid, eid] });
  };

  const test = useMutation({
    mutationFn: () => api<TargetInfo>('POST', `/api/projects/${pid}/environments/${eid}/test`),
    onSuccess: (r) =>
      setResult({
        ok: true,
        text: t('dlg.envTested', {
          ...r,
          exists: r.shadowExists ? t('dlg.envShadowExists') : '',
          createdb: r.canCreateDb ? t('dlg.envCanCreate') : t('dlg.envCannotCreate'),
        }),
      }),
    onError: (e) => setResult({ ok: false, text: e.message }),
  });
  const pull = useMutation({
    mutationFn: () => api<ModelUpdate>('POST', `/api/projects/${pid}/environments/${eid}/pull`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      toast(t('dlg.envPulled', { count: r.objects }));
    },
    onError: (e) => setResult({ ok: false, text: e.message }),
  });
  const checkDrift = useMutation({
    mutationFn: () => api<DriftCheckResponse>('POST', `/api/projects/${pid}/environments/${eid}/drift-check`),
    onSuccess: (r) => {
      if (r.skipped) toast(t(`envx.drift.skipped.${r.skipped}`));
      else if (r.status === 'ok') toast(t('envx.drift.checkedOk'));
      else if (r.status === 'drifted')
        toast(t('envx.drift.checkedDrifted', { count: r.summary?.total ?? 0 }), 'error');
      else toast(r.summary?.message ?? t('envx.drift.error'), 'error');
      refreshState();
    },
    onError: (e) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/projects/${pid}/environments/${eid}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      toast(t('envp.deleted', { name: env?.name ?? '' }));
      setConfirm(false);
      void nav({ to: '/project/$owner/$project/environments', params });
    },
  });

  // 人工修正：只在漂移检查结果仍是 drifted 且 needsManual 是合格的 { direction, … } 时显示（旧格式的 true 之类服务端已经丢掉，这里再防一道）
  const manualRaw = env?.drift.status === 'drifted' ? env.drift.summary?.needsManual : undefined;
  const manual =
    manualRaw && typeof manualRaw === 'object' && Object.hasOwn(DIRECTION_KEY, manualRaw.direction)
      ? manualRaw
      : undefined;

  // 详情页也显示环境列表（同一个侧面板）
  if (!env)
    return (
      <>
        <EnvPanel pid={pid} activeId={eid} />
        <ProjectPage title={t('envp.detail')}>
          {envs.isLoading ? null : envs.error ? (
            <Banner kind="danger" role="alert">
              {envs.error.message}
            </Banner>
          ) : (
            <Banner kind="danger">{t('envp.notFound')}</Banner>
          )}
        </ProjectPage>
      </>
    );

  const canConfigure = env.permissions.configure;
  const canExec = status?.permissions.execute ?? env.permissions.execute;
  const pending = status?.versions.filter((v) => v.state === 'pending') ?? [];
  const current = status?.currentVersion ?? null;
  const rollbackTargets = current ? (status?.versions ?? []).filter((v) => v.number < current.number) : [];
  const execTarget = pending.find((v) => v.id === execTo) ?? pending.at(-1);
  const rollTarget = rollbackTargets.find((v) => v.id === rollTo) ?? rollbackTargets.at(-1);
  const showBaseline =
    !!status && !!history && !history.initialized && !current && status.versions[0]?.number === 0;
  const deniedText = status ? denied(status.effectiveExecPolicy) : '';
  const run = (kind: ExecKind, to?: EnvVersion) => {
    if (!canExec) return;
    setDlg({ kind, to });
  };

  return (
    <>
      <EnvPanel pid={pid} activeId={eid} />
      <PageHeader
        crumbs={[
          { label: project.group.name, to: '/group/$slug', params: { slug: project.group.slug } },
          { label: project.name, to: '/project/$owner/$project', params },
          { label: t('nav.environments'), to: '/project/$owner/$project/environments', params },
          { label: env.name, mono: true },
        ]}
        actions={
          <>
            <button
              type="button"
              className="btn"
              disabled={test.isPending}
              aria-busy={test.isPending}
              onClick={() => test.mutate()}
            >
              <PlugZap size={16} aria-hidden="true" />
              {t('dlg.envTest')}
            </button>
            {canPull && (
              <button
                type="button"
                className="btn"
                disabled={pull.isPending}
                aria-busy={pull.isPending}
                onClick={() => pull.mutate()}
              >
                <FileInput size={16} aria-hidden="true" />
                {t('dlg.envPull')}
              </button>
            )}
            {project.role === 'admin' && (
              <IconButton
                label={t('envp.delete')}
                className="hover:!text-danger"
                aria-disabled={!canConfigure || undefined}
                title={canConfigure ? undefined : denied(env.effectiveExecPolicy)}
                onClick={() => canConfigure && setConfirm(true)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </IconButton>
            )}
          </>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[960px] space-y-6 px-6 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Database size={20} aria-hidden="true" className="text-text-3" />
            <span className="font-mono text-[length:var(--fs-headline)] font-semibold">{env.name}</span>
            {env.production ? (
              <span className="badge danger">{t('envp.production')}</span>
            ) : (
              <span className="badge">{t('envp.notProduction')}</span>
            )}
            <code className="min-w-0 truncate text-xs text-text-3">{env.url}</code>
          </div>

          {/* 只在漂移检查的结果仍是漂移、并且差异是“读回校验失败”的执行留下的时显示：手工修好后检查返回 ok，横幅就消失。
              方向和版本号由服务端给出（升级是新版本，回滚是被回滚的版本） */}
          {manual && (
            <Banner kind="danger" title={t('envx.manual.title')} role="alert">
              {t('envx.manual.body', {
                direction: t(DIRECTION_KEY[manual.direction]),
                number: manual.versionNumber ?? '?',
              })}
            </Banner>
          )}
          {history?.unfinished && (
            <Banner kind="danger" title={t('envx.unfinished.title')} role="alert">
              {t('envx.unfinished.body', {
                number: history.unfinished.toVersion.number,
                step: (history.unfinished.stepIndex ?? -1) + 2,
              })}
            </Banner>
          )}

          <Section title={t('envx.title')}>
            <div className="space-y-3 rounded-md border border-border bg-panel px-4 py-3 text-sm">
              <dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
                <dt className="text-text-2">{t('envx.current')}</dt>
                <dd className="m-0" data-testid="current-version">
                  {current ? (
                    <>
                      <VersionNumber number={current.number} />{' '}
                      <span className="font-mono">{versionName(current)}</span>
                    </>
                  ) : (
                    <span className="text-text-2">{t('envx.notExecuted')}</span>
                  )}
                </dd>
                <dt className="text-text-2">{t('envx.drift.title')}</dt>
                <dd className="m-0 flex flex-wrap items-center gap-2">
                  <DriftBadge drift={env.drift} withTime />
                  <button
                    type="button"
                    className="btn"
                    disabled={checkDrift.isPending}
                    aria-busy={checkDrift.isPending}
                    onClick={() => checkDrift.mutate()}
                  >
                    {t('envx.drift.check')}
                  </button>
                </dd>
              </dl>

              {status && (
                <div className="flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-border pt-3">
                  <div className="flex items-end gap-2">
                    <div className="field">
                      <label htmlFor={execSelectId} className="label">
                        {t('envx.exec.toLabel')}
                      </label>
                      <select
                        id={execSelectId}
                        className="input w-auto"
                        value={execTarget?.id ?? ''}
                        disabled={!pending.length}
                        onChange={(e) => setExecTo(e.target.value)}
                      >
                        {pending.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.number} {versionName(v)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn primary"
                      aria-disabled={!canExec || !execTarget || undefined}
                      title={canExec ? undefined : deniedText}
                      onClick={() => execTarget && run('execute', execTarget)}
                    >
                      <Play size={16} aria-hidden="true" />
                      {t('envx.exec.button')}
                    </button>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="field">
                      <label htmlFor={rollSelectId} className="label">
                        {t('envx.exec.rollToLabel')}
                      </label>
                      <select
                        id={rollSelectId}
                        className="input w-auto"
                        value={rollTarget?.id ?? ''}
                        disabled={!rollbackTargets.length}
                        onChange={(e) => setRollTo(e.target.value)}
                      >
                        {rollbackTargets.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.number} {versionName(v)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      aria-disabled={!canExec || !rollTarget || undefined}
                      title={canExec ? undefined : deniedText}
                      onClick={() => rollTarget && run('rollback', rollTarget)}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                      {t('envx.exec.rollbackButton')}
                    </button>
                  </div>
                  {showBaseline && (
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="btn"
                        aria-disabled={!canExec || undefined}
                        title={canExec ? undefined : deniedText}
                        onClick={() => run('baseline')}
                      >
                        <ArrowDownToLine size={16} aria-hidden="true" />
                        {t('envx.exec.baselineButton')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {showBaseline && <p className="hint m-0">{t('envx.exec.baselineHint')}</p>}
              {status && !canExec && (
                <p className="hint m-0" role="note">
                  {deniedText}
                </p>
              )}
            </div>
          </Section>

          {env.drift.status === 'drifted' && env.drift.summary && (
            <Section title={t('envx.drift.diffTitle')} count={env.drift.summary.total}>
              <Banner kind="warn" role="status">
                {env.drift.summary.firstRun
                  ? t('envx.drift.firstRunBody')
                  : t('envx.drift.body', { number: env.drift.summary.versionNumber ?? '?' })}
                {env.drift.summary.message && <p className="m-0 mt-1">{env.drift.summary.message}</p>}
              </Banner>
              <DiffList items={env.drift.summary.items} total={env.drift.summary.total} />
            </Section>
          )}
          {env.drift.status === 'error' && env.drift.summary?.message && (
            <Banner
              kind="warn"
              title={t(`envx.drift.kind.${env.drift.summary.errorKind ?? 'unexpected'}`)}
              role="status"
            >
              {env.drift.summary.message}
            </Banner>
          )}

          <Section title={t('envx.chain')} count={status?.versions.length}>
            {status && status.versions.length === 0 ? (
              <EmptyHint>{t('envx.noVersions')}</EmptyHint>
            ) : status ? (
              <VersionChain status={status} params={params} />
            ) : statusQ.error ? (
              <Banner kind="danger" role="alert">
                {statusQ.error.message}
              </Banner>
            ) : null}
          </Section>

          <Section title={t('envx.history')} count={history?.runs.length}>
            {historyQ.error ? (
              <Banner kind="warn" role="status">
                {t('envx.historyError', { msg: historyQ.error.message })}
              </Banner>
            ) : history && history.runs.length === 0 ? (
              <EmptyHint>{t('envx.historyEmpty')}</EmptyHint>
            ) : history ? (
              <HistoryTable runs={history.runs} />
            ) : null}
          </Section>

          {status && (
            <Section title={t('envx.policy.title')}>
              <PolicySetting pid={pid} env={env} status={status} />
            </Section>
          )}

          <Section title={t('envp.config')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-4 py-3 text-sm">
              <dt className="text-text-2">{t('dlg.envUrl')}</dt>
              <dd className="m-0 truncate font-mono text-xs">{env.url}</dd>
              <dt className="text-text-2">{t('dlg.envProduction')}</dt>
              <dd className="m-0">{env.production ? t('envp.production') : t('envp.notProduction')}</dd>
              <dt className="text-text-2">{t('dlg.envAllowSame')}</dt>
              <dd className="m-0">{env.allowSameInstance ? '✓' : '—'}</dd>
              <dt className="text-text-2">{t('envp.shadow')}</dt>
              <dd className="m-0 font-mono text-xs">{env.shadowUrl ?? t('envp.shadowNone')}</dd>
              <dt className="text-text-2">{t('envp.status')}</dt>
              <dd className="m-0 text-text-2">{t('envp.statusUnknown')}</dd>
            </dl>
          </Section>

          {result && (
            <Banner kind={result.ok ? 'ok' : 'danger'} role={result.ok ? 'status' : 'alert'}>
              {result.text}
            </Banner>
          )}
          {!canPull && <Banner kind="info">{t('envp.manageHint')}</Banner>}
        </div>
      </main>

      {dlg && status && (
        <ExecDialog
          pid={pid}
          eid={eid}
          envName={env.name}
          production={env.production}
          status={status}
          kind={dlg.kind}
          to={dlg.to}
          onClose={() => setDlg(null)}
        />
      )}

      <Confirm
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t('envp.deleteTitle', { name: env.name })}
        confirmLabel={t('envp.delete')}
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => remove.mutate()}
      >
        {t('envp.deleteHint')}
      </Confirm>
    </>
  );
};

export const EnvironmentDetail = () => {
  const { eid } = useParams({ from: '/project/$owner/$project/environments/$eid' });
  // eid 变了要重新挂载：测试结果、确认框这些状态不能带到另一个环境
  return <EnvironmentDetailView key={eid} eid={eid} />;
};
