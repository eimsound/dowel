// 环境：侧面板是环境列表，主区域是列表 + 新建（管理员）或单个环境的详情。
// 详情里可以测试连接、从目标库导入结构、删除环境；连接状态只在这里主动检查。
import type {
  AttachOverwritePreview,
  AttachResult,
  ClaimResult,
  DriftCheckResponse,
  EnvInfo,
  EnvStatus,
  EnvVersion,
  RunInfo,
  TargetInfo,
} from '@dowel/api';
import type { Dialect } from '@dowel/core';
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
  Siren,
  Trash2,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { ClaimDialog } from '../components/ClaimDialog.tsx';
import { DriftBadge, driftLabel, useDeniedHint } from '../components/EnvBits.tsx';
import { DiffList, ExecDialog, type ExecKind, type ExecMode, routeFor } from '../components/ExecDialog.tsx';
import { ImportDialog } from '../components/ImportDialog.tsx';
import { MARK_TIP, MARK_TITLE, MarkDialog, markDirection } from '../components/MarkDialog.tsx';
import { Confirm, Modal } from '../components/Modal.tsx';
import { EnvPolicyPanel } from '../components/PolicyEditor.tsx';
import { EmptyHint, ProjectPage, Row, Rows, Section } from '../components/ProjectPage.tsx';
import { RepairDialog } from '../components/RepairDialog.tsx';
import { PageHeader, useShellPanel } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Banner, IconButton } from '../components/ui.tsx';
import { useVersionName, VersionBadges, VersionNumber } from '../components/VersionStatus.tsx';
import { dialectUiSpec, formatEngineVersion } from '../dialects.ts';
import { attachRetiredMessage, attachSuccessMessage, useEnvHistory, useEnvStatus, useEnvs } from '../envs.ts';
import { formatTime } from '../format.ts';
import { invalidatePolicyDependents } from '../policy-cache.ts';
import { useProject } from '../project.tsx';
import { invalidateRequests, useEnvRequests } from '../requests.ts';
import { useMe } from '../session.ts';
import { StatusBadge } from './Request.tsx';

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
  const { project } = useProject();
  const uiSpec = dialectUiSpec(project.dialect);
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const empty = { name: '', url: '', production: true, allowSameInstance: false, shadowUrl: '' };
  const [form, setForm] = useState(empty);
  /** 接入这个库里已有的迁移历史（特权操作；由另一个实例认领的库要确认认领；领先于平台链且工作副本脏时需确认覆盖） */
  const [attach, setAttach] = useState(false);
  const [claimAsk, setClaimAsk] = useState<{ instanceId: string | null } | null>(null);
  const [claimConfirmed, setClaimConfirmed] = useState(false);
  const [overwriteAsk, setOverwriteAsk] = useState<{
    preview: AttachOverwritePreview;
    changed: boolean;
  } | null>(null);
  const attachCodeOf = (e: Error | null) =>
    e instanceof ApiError && e.status === 409 ? (e.body as { code?: string } | undefined)?.code : undefined;
  const shadowHintId = useId();
  const add = useMutation<
    unknown,
    Error,
    { claim: boolean; confirmOverwrite?: boolean; workingSeq?: number }
  >({
    mutationFn: ({ claim, confirmOverwrite, workingSeq }) =>
      attach
        ? api<AttachResult>('POST', `/api/projects/${pid}/environments/attach`, {
            ...form,
            shadowUrl: form.shadowUrl.trim() || null,
            claim,
            confirmOverwrite: confirmOverwrite ?? false,
            ...(workingSeq !== undefined ? { workingSeq } : {}),
          })
        : api('POST', `/api/projects/${pid}/environments`, {
            ...form,
            shadowUrl: form.shadowUrl.trim() || null,
          }),
    onSuccess: (r) => {
      if (attach) {
        const a = r as AttachResult;
        toast(attachSuccessMessage(t, form.name, a));
        const retiredMsg = attachRetiredMessage(t, a.retiredVersions);
        if (retiredMsg) toast(retiredMsg);
        // 环境已经添加，但认领失败 / 同步失败：如实告诉用户（可以在环境页重试）
        for (const w of a.warnings ?? []) toast(t('tk.attachedWarn', { msg: w }), 'error');
      }
      setForm(empty);
      setClaimAsk(null);
      setClaimConfirmed(false);
      setOverwriteAsk(null);
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['versions', pid] });
      void qc.invalidateQueries({ queryKey: ['published-tables', pid] });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['activity', pid] });
      void qc.invalidateQueries({ queryKey: ['migration', pid] });
      void qc.invalidateQueries({ queryKey: ['ddl', pid] });
    },
    onError: (e) => {
      // 这个库里的项目由另一个实例认领：弹出认领确认（说明后果），确认后带 claim: true 重新提交
      const body =
        e instanceof ApiError
          ? (e.body as {
              code?: string;
              claim?: { instanceId?: string };
              aheadVersions?: AttachOverwritePreview['aheadVersions'];
              items?: AttachOverwritePreview['items'];
              total?: number;
              workingSeq?: number;
            })
          : null;
      const code = attachCodeOf(e);
      if (code === 'claim_required') {
        setOverwriteAsk(null);
        setClaimAsk({ instanceId: body?.claim?.instanceId ?? null });
        return;
      }
      if (
        (code === 'working_dirty_confirm' || code === 'working_changed') &&
        body?.aheadVersions &&
        body?.items &&
        typeof body.total === 'number' &&
        typeof body.workingSeq === 'number'
      ) {
        setClaimAsk(null);
        setOverwriteAsk({
          preview: {
            aheadVersions: body.aheadVersions,
            items: body.items,
            total: body.total,
            workingSeq: body.workingSeq,
          },
          changed: code === 'working_changed',
        });
        return;
      }
      // 验证失败 / 影子库不可用（422）：关掉确认对话框，在表单中清晰展示失败版本和原因，方便直接改影子库配置
      const errCode = e instanceof ApiError ? (e.body as { code?: string } | undefined)?.code : undefined;
      if (errCode === 'shadow_unavailable' || errCode === 'verify_failed') {
        setClaimAsk(null);
        setOverwriteAsk(null);
      }
    },
  });
  const pendingConfirmCode = attachCodeOf(add.error);
  const isConfirmCode =
    pendingConfirmCode === 'claim_required' ||
    pendingConfirmCode === 'working_dirty_confirm' ||
    pendingConfirmCode === 'working_changed';
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <form
      className="space-y-3 rounded-md border border-border bg-panel p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setClaimConfirmed(false);
        add.mutate({ claim: false });
      }}
    >
      <h2 className="section-title">{t('envp.add')}</h2>
      <p className="hint">{uiSpec.requiresExternalShadow ? t('dlg.envHint') : t('envp.addHintSqlite')}</p>
      {project.dialect === 'mssql' && <Banner kind="info">{t('wiz.mssqlTlsHint')}</Banner>}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-[800px]:grid-cols-1">
        <label className="field">
          <span className="label">{t('dlg.envName')}</span>
          <input
            className="input"
            aria-label={t('dlg.envName')}
            value={form.name}
            onChange={set('name')}
            placeholder="dev"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
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
            placeholder={uiSpec.urlPlaceholder}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <div className="checks col-span-2">
          <label>
            <input type="checkbox" checked={form.production} onChange={set('production')} />
            {t('dlg.envProduction')}
          </label>
          {uiSpec.requiresExternalShadow && (
            <label>
              <input type="checkbox" checked={form.allowSameInstance} onChange={set('allowSameInstance')} />
              {t('dlg.envAllowSame')}
            </label>
          )}
        </div>
        {uiSpec.requiresExternalShadow && (
          <div className="field col-span-2">
            <label className="field">
              <span className="label">{t('dlg.envShadowUrl')}</span>
              <input
                className="input font-mono"
                aria-label={t('dlg.envShadowUrl')}
                aria-describedby={shadowHintId}
                value={form.shadowUrl}
                onChange={set('shadowUrl')}
                placeholder={uiSpec.shadowPlaceholder}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>
            <span id={shadowHintId} className="hint">
              {t('wiz.envShadowHint')}
            </span>
          </div>
        )}
        <div className="checks col-span-2">
          <label>
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
            {t('tk.attachLabel')}
          </label>
          <p className="hint m-0 basis-full">{t('tk.attachHint')}</p>
        </div>
      </div>
      <ClaimDialog
        open={claimAsk !== null}
        onClose={() => setClaimAsk(null)}
        onConfirm={() => {
          setClaimConfirmed(true);
          add.mutate({ claim: true });
        }}
        pending={add.isPending}
        // 只有服务端明确返回确认类 409 才不算错误；其他错误（包括别的 409，比如重名）照常显示在对话框里
        error={add.error && !isConfirmCode ? add.error.message : undefined}
        instanceId={claimAsk?.instanceId}
        isAdmin={me?.role === 'admin'}
      />
      <Modal
        open={overwriteAsk !== null}
        onClose={() => setOverwriteAsk(null)}
        size="md"
        title={t('tk.attachAheadTitle')}
        footer={
          <>
            <span className="flex-1" />
            <button type="button" className="btn" autoFocus onClick={() => setOverwriteAsk(null)}>
              {t('dlg.cancel')}
            </button>
            <button
              type="button"
              className="btn danger solid"
              disabled={add.isPending}
              aria-busy={add.isPending || undefined}
              onClick={() =>
                overwriteAsk &&
                add.mutate({
                  claim: claimConfirmed,
                  confirmOverwrite: true,
                  workingSeq: overwriteAsk.preview.workingSeq,
                })
              }
            >
              {t('tk.attachAheadConfirm')}
            </button>
          </>
        }
      >
        {overwriteAsk && (
          <div className="space-y-3 text-sm">
            <p className="m-0 text-text-2">{t('tk.attachAheadIntro')}</p>
            {overwriteAsk.changed && (
              <Banner kind="warn" role="alert">
                {t('tk.attachWorkingChanged')}
              </Banner>
            )}
            {add.error && !isConfirmCode && (
              <Banner kind="danger" role="alert">
                {add.error.message}
              </Banner>
            )}
            <div className="space-y-1.5">
              <h3 className="section-title">
                {t('tk.attachAheadVersions')}
                <span className="count">{overwriteAsk.preview.aheadVersions.length}</span>
              </h3>
              <ul className="m-0 list-none space-y-1 rounded-sm border border-border bg-bg p-2.5 font-mono text-xs">
                {overwriteAsk.preview.aheadVersions.map((v) => (
                  <li key={v.id}>
                    v{v.number} · {v.name}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <h3 className="section-title">
                {t('tk.attachAheadDiff')}
                <span className="count">{overwriteAsk.preview.total}</span>
              </h3>
              <DiffList items={overwriteAsk.preview.items} total={overwriteAsk.preview.total} />
            </div>
          </div>
        )}
      </Modal>
      {add.error && !isConfirmCode && !claimAsk && !overwriteAsk && (
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
  const uiSpec = dialectUiSpec(project.dialect);
  const params = { owner: project.group.slug, project: project.slug };
  const envs = useEnvs(pid);
  const canManage = project.role === 'admin';
  return (
    <>
      <EnvPanel pid={pid} />
      <ProjectPage title={t('envp.title')}>
        <div className="space-y-6">
          <p className="text-sm text-text-2">
            {uiSpec.requiresExternalShadow ? t('envp.addHint') : t('envp.addHintSqlite')}
          </p>
          {envs.data && envs.data.length === 0 ? (
            <EmptyHint>{t('envp.empty')}</EmptyHint>
          ) : (
            <Rows>
              {(envs.data ?? []).map((e) => {
                const verLabel = formatEngineVersion(project.dialect, e.engineVersion, e.engineMajor);
                return (
                  <Row key={e.id}>
                    <Database size={16} aria-hidden="true" className="shrink-0 text-text-3" />
                    <Link
                      to="/project/$owner/$project/environments/$eid"
                      params={{ ...params, eid: e.id }}
                      className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
                    >
                      {e.name}
                    </Link>
                    {verLabel && <span className="chip shrink-0 font-mono">{verLabel}</span>}
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
                );
              })}
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
  retired: 'envx.state.retired',
} as const;

/** 版本链：每个版本相对这个环境的当前版本是已执行 / 当前 / 待执行 / 已作废（不在当前版本的祖先路径上） */
const VersionChain = ({
  status,
  params,
  dialect,
}: {
  status: EnvStatus;
  params: { owner: string; project: string };
  dialect: Dialect;
}) => {
  const { t } = useTranslation();
  const versionName = useVersionName();
  const nonTxHint = t(
    dialect === 'pg' ? 'envx.nonTx' : dialect === 'mysql' ? 'envx.nonTxMysql' : 'envx.nonTxGeneric',
  );
  return (
    <Rows>
      {[...status.versions].reverse().map((v) => (
        <Row key={v.id} className={v.retired ? 'row-retired' : undefined}>
          <VersionNumber number={v.number} />
          <Link
            to="/project/$owner/$project/versions/$vid"
            params={{ ...params, vid: v.id }}
            className="min-w-0 flex-1 truncate font-mono font-medium no-underline"
          >
            {versionName(v)}
          </Link>
          <VersionBadges
            v={{
              verifiedAt: v.verified ? 'x' : null,
              edited: v.edited,
              // 状态 chip 已经写着“已作废”时不重复
              retiredAt: v.retired && v.state !== 'retired' ? 'x' : null,
            }}
          />
          {v.nonTransactional && (
            <span className="risk medium" title={nonTxHint}>
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

const DIRECTION_KEY = {
  baseline: 'envx.dir.baseline',
  up: 'envx.dir.up',
  down: 'envx.dir.down',
  mark: 'envx.dir.mark',
} as const;
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
              <td className="px-3 py-2">
                {r.direction === 'mark' && r.toVersion ? (
                  // 标记：和按钮同一段说明（向后标记去掉“不能再编辑”那一句）
                  <span
                    title={t(
                      r.fromVersion && r.toVersion.number === r.fromVersion.number
                        ? 'dr.mark.tipStay'
                        : r.fromVersion && r.toVersion.number < r.fromVersion.number
                          ? 'dr.mark.tipBackward'
                          : 'dr.mark.tip',
                      { number: r.toVersion.number },
                    )}
                    className="cursor-help underline decoration-dotted underline-offset-2"
                  >
                    {t(DIRECTION_KEY.mark)}
                  </span>
                ) : (
                  t(DIRECTION_KEY[r.direction])
                )}
              </td>
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

const EnvironmentDetailView = ({ eid }: { eid: string }) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const uiSpec = dialectUiSpec(project.dialect);
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
  const [unmarkConfirm, setUnmarkConfirm] = useState(false);
  const [dlg, setDlg] = useState<{ kind: ExecKind; to?: EnvVersion; mode: ExecMode } | null>(null);
  const requestsQ = useEnvRequests(pid, eid);
  const [execTo, setExecTo] = useState('');
  const [rollTo, setRollTo] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  /** 漂移的两个出口：保留线上的修改（导入）/ 放弃线上的修改（修复脚本）；标记为已执行 */
  const [importOpen, setImportOpen] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const [markTo, setMarkTo] = useState('');
  const [markDlg, setMarkDlg] = useState<EnvVersion | null>(null);
  const me = useMe().data;
  const isInstanceAdmin = me?.role === 'admin';
  const versionName = useVersionName();
  const execSelectId = useId();
  const rollSelectId = useId();
  const markSelectId = useId();
  const canPull = project.role !== 'viewer';

  const refreshState = () => {
    void qc.invalidateQueries({ queryKey: ['envs', pid] });
    void qc.invalidateQueries({ queryKey: ['project', pid] });
    void qc.invalidateQueries({ queryKey: ['migration', pid] });
    void qc.invalidateQueries({ queryKey: ['ddl', pid] });
    void qc.invalidateQueries({ queryKey: ['env-status', pid, eid] });
    void qc.invalidateQueries({ queryKey: ['env-history', pid, eid] });
  };

  const test = useMutation({
    mutationFn: () => api<TargetInfo>('POST', `/api/projects/${pid}/environments/${eid}/test`),
    onSuccess: (r) => {
      setResult({
        ok: true,
        text: uiSpec.requiresExternalShadow
          ? t('dlg.envTested', {
              ...r,
              dialect: uiSpec.name,
              exists: r.shadowExists ? t('dlg.envShadowExists') : '',
              createdb: r.canCreateDb ? t('dlg.envCanCreate') : t('dlg.envCannotCreate'),
            })
          : t('dlg.envTestedSqlite', {
              database: r.database,
              version: r.version,
              shadow: r.shadow,
            }),
      });
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['migration', pid] });
      void qc.invalidateQueries({ queryKey: ['ddl', pid] });
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
  const claim = useMutation({
    mutationFn: () => api<ClaimResult>('POST', `/api/projects/${pid}/environments/${eid}/claim`),
    onSuccess: (r) => {
      toast(r.changed ? t('tk.claimDone') : t('tk.claimNoop'));
      setClaimOpen(false);
      refreshState();
    },
  });
  const setProduction = useMutation<EnvInfo, Error, boolean>({
    mutationFn: (production) =>
      api<EnvInfo>('PATCH', `/api/projects/${pid}/environments/${eid}`, { production }),
    onSuccess: (updated) => {
      setUnmarkConfirm(false);
      toast(
        t(updated.production ? 'envp.markedProduction' : 'envp.unmarkedProduction', {
          name: updated.name,
        }),
      );
      void invalidatePolicyDependents(qc);
      void qc.invalidateQueries({ queryKey: ['activity', pid] });
      void invalidateRequests(qc);
    },
    onError: (e, production) => {
      if (production) toast(e.message, 'error');
    },
  });
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/projects/${pid}/environments/${eid}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['migration', pid] });
      void qc.invalidateQueries({ queryKey: ['ddl', pid] });
      void qc.invalidateQueries({ queryKey: ['activity', pid] });
      void invalidateRequests(qc);
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
  const canUnmarkProduction = env.permissions.unmarkProduction;
  const canExec = status?.permissions.execute ?? env.permissions.execute;
  // 版本树（ADR 0013）：待执行 = 活跃主链上还没到的版本；回滚目标 = 当前版本的祖先（已执行）；
  // 环境停在已作废岔路上时，到待执行版本要先回滚到最近公共祖先再升级（切换）
  const pending = status?.versions.filter((v) => v.state === 'pending') ?? [];
  const current = status?.currentVersion ?? null;
  const currentRetired = !!current && !!status?.versions.find((v) => v.id === current.id)?.retired;
  const rollbackTargets = current ? (status?.versions ?? []).filter((v) => v.state === 'applied') : [];
  const execTarget = pending.find((v) => v.id === execTo) ?? pending.at(-1);
  const execKind: ExecKind =
    status && execTarget && routeFor(status, execTarget).items.some((m) => m.direction === 'down')
      ? 'switch'
      : 'execute';
  const rollTarget = rollbackTargets.find((v) => v.id === rollTo) ?? rollbackTargets.at(-1);
  const showBaseline =
    !!status && !!history && !history.initialized && !current && status.versions[0]?.number === 0;
  const deniedText = status ? denied(status.effectiveExecPolicy) : '';
  // 上一次执行没有结束（停在中途 / 读回校验失败）时，当前版本也可以作为标记目标：手工改回当前版本之后放弃那次未完成的运行
  // “当前版本”以执行器读目标库历史得到的为准（history.currentVersion），不用平台缓存（缓存可能过期）；
  // 未完成的运行同样用执行器给的 unfinished / readbackFailure，不从 runs 里推
  const openRun = !!history?.unfinished || history?.readbackFailure === true;
  const markCurrent = openRun ? (history?.currentVersion ?? current) : current;
  // 不能标记到已作废的版本（ADR 0013）；有未完成的运行时当前版本仍可作为目标
  const markTargets = (status?.versions ?? []).filter(
    (v) => (openRun || v.id !== markCurrent?.id) && (!v.retired || (openRun && v.id === markCurrent?.id)),
  );
  const markTarget = markTargets.find((v) => v.id === markTo) ?? markTargets.at(-1);
  const markDir = markTarget ? markDirection(markCurrent, markTarget, status?.versions) : 'forward';
  // P5b：环境要求审批（配置了审批环节）或者自己没有执行权限时，执行 / 回滚变成“提交执行申请”
  const perm = status?.permissions ?? env.permissions;
  const direct = perm.execute && !perm.approvalRequired;
  const viaRequest = !direct && perm.request;
  const canRun = direct || viaRequest;
  const runTitle = canRun ? undefined : deniedText;
  const run = (kind: ExecKind, to?: EnvVersion) => {
    if (kind === 'baseline') {
      if (canExec) setDlg({ kind, to, mode: 'direct' });
      return;
    }
    if (!canRun) return;
    setDlg({ kind, to, mode: direct ? 'direct' : 'request' });
  };
  const openRequests = requestsQ.data ?? [];

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
              <button type="button" className="btn" onClick={() => setImportOpen(true)}>
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
      <main
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 只读视图内所有控件可能被禁用，可滚动主区域需要能用键盘滚动
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-offset-[-2px]"
      >
        <div className="mx-auto max-w-[960px] space-y-6 px-6 py-6">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Database size={20} aria-hidden="true" className="text-text-3" />
            <span className="font-mono text-[length:var(--fs-headline)] font-semibold">{env.name}</span>
            {formatEngineVersion(project.dialect, env.engineVersion, env.engineMajor) && (
              <span className="chip font-mono">
                {formatEngineVersion(project.dialect, env.engineVersion, env.engineMajor)}
              </span>
            )}
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
          {/* 这个库里的项目由另一个实例认领：本实例的执行会被拒绝（foreign_instance），只读的检查和历史不受影响 */}
          {history?.claim && !history.claim.mine && (
            <Banner kind="warn" title={t('tk.claimBannerTitle')} role="status">
              <p className="m-0">{t('tk.claimBannerBody', { id: history.claim.instanceId ?? '?' })}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  aria-disabled={!isInstanceAdmin || undefined}
                  title={isInstanceAdmin ? undefined : t('tk.claimAdminOnly')}
                  onClick={() => isInstanceAdmin && setClaimOpen(true)}
                >
                  {t('tk.claimButton')}
                </button>
                {!isInstanceAdmin && <span className="hint">{t('tk.claimAdminOnly')}</span>}
              </div>
            </Banner>
          )}
          {/* ADR 0013：环境停在已作废的版本上：引导切换回活跃主链，或跨岔路零 SQL 标记 */}
          {current && currentRetired && (
            <Banner kind="warn" title={t('envx.exec.switchBanner', { number: current.number })} role="status">
              <p className="m-0">{t('envx.exec.switchBannerBody')}</p>
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
                      aria-disabled={!canRun || !execTarget || undefined}
                      title={runTitle}
                      onClick={() => execTarget && run(execKind, execTarget)}
                    >
                      <Play size={16} aria-hidden="true" />
                      {execKind === 'switch'
                        ? direct || !viaRequest
                          ? t('envx.exec.switchButton', { number: execTarget?.number })
                          : t('req.envButton.switch')
                        : direct || !viaRequest
                          ? t('envx.exec.button')
                          : t('req.envButton.execute')}
                    </button>
                    {perm.emergency && execTarget && (
                      <button
                        type="button"
                        className="btn danger"
                        onClick={() => setDlg({ kind: execKind, to: execTarget, mode: 'emergency' })}
                      >
                        <Siren size={16} aria-hidden="true" />
                        {t('req.envButton.emergency')}
                      </button>
                    )}
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
                      aria-disabled={!canRun || !rollTarget || undefined}
                      title={runTitle}
                      onClick={() => rollTarget && run('rollback', rollTarget)}
                    >
                      <RotateCcw size={16} aria-hidden="true" />
                      {direct || !viaRequest ? t('envx.exec.rollbackButton') : t('req.envButton.rollback')}
                    </button>
                    {perm.emergency && rollTarget && (
                      <button
                        type="button"
                        className="btn danger"
                        onClick={() => setDlg({ kind: 'rollback', to: rollTarget, mode: 'emergency' })}
                      >
                        <Siren size={16} aria-hidden="true" />
                        {t('req.envButton.emergencyRollback')}
                      </button>
                    )}
                  </div>
                  {markTarget && (
                    <div className="flex items-end gap-2">
                      <div className="field">
                        <label htmlFor={markSelectId} className="label">
                          {t('dr.mark.toLabel')}
                        </label>
                        <select
                          id={markSelectId}
                          className="input w-auto"
                          value={markTarget.id}
                          onChange={(e) => setMarkTo(e.target.value)}
                        >
                          {markTargets.map((v) => (
                            <option key={v.id} value={v.id}>
                              v{v.number} {versionName(v)}
                              {v.id === markCurrent?.id ? `（${t('dr.mark.currentTag')}）` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        aria-disabled={!canExec || undefined}
                        title={canExec ? t(MARK_TIP[markDir], { number: markTarget.number }) : deniedText}
                        onClick={() => canExec && setMarkDlg(markTarget)}
                      >
                        {t(MARK_TITLE[markDir], { number: markTarget.number })}
                      </button>
                    </div>
                  )}
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
              {status && perm.approvalRequired && (
                <p className="hint m-0" role="note" data-testid="approval-required">
                  {t('req.envApprovalRequired')}
                </p>
              )}
              {status && !perm.approvalRequired && !canExec && (
                <p className="hint m-0" role="note">
                  {viaRequest ? t('req.envNoRight', { denied: deniedText }) : deniedText}
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
              {/* 漂移的两个出口，不分主次（ADR 0004） */}
              <div
                className="space-y-2 rounded-md border border-border bg-panel p-3"
                data-testid="drift-exits"
              >
                <h3 className="section-title">{t('dr.exitsTitle')}</h3>
                <p className="hint m-0">{t('dr.exitsHint')}</p>
                <div className="grid grid-cols-2 gap-3 max-[800px]:grid-cols-1">
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      className="btn"
                      aria-disabled={!canPull || undefined}
                      onClick={() => canPull && setImportOpen(true)}
                    >
                      {t('dr.keep')}
                    </button>
                    <p className="hint m-0">{t('dr.keepHint')}</p>
                  </div>
                  <div className="space-y-1.5">
                    <button type="button" className="btn" onClick={() => setRepairOpen(true)}>
                      {t('dr.discard')}
                    </button>
                    <p className="hint m-0">{t('dr.discardHint')}</p>
                  </div>
                </div>
              </div>
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

          {/* P5b：这个环境上还没结束的执行申请 */}
          <Section title={t('req.envPending')} count={openRequests.length}>
            {openRequests.length === 0 ? (
              <EmptyHint>{t('req.envPendingEmpty')}</EmptyHint>
            ) : (
              <ul
                className="m-0 list-none overflow-hidden rounded-md border border-border p-0"
                data-testid="env-requests"
              >
                {openRequests.map((rq) => (
                  <li
                    key={rq.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm not-first:border-t not-first:border-border"
                  >
                    <StatusBadge status={rq.status} />
                    <Link to="/project/$owner/$project/requests/$rid" params={{ ...params, rid: rq.id }}>
                      {t(
                        rq.kind === 'rollback'
                          ? 'req.envRowRollback'
                          : rq.kind === 'switch'
                            ? 'req.envRowSwitch'
                            : 'req.envRowExecute',
                        {
                          to: rq.to.number,
                        },
                      )}
                    </Link>
                    {rq.status === 'pending' && (
                      <span className="text-xs text-text-2">
                        {t('req.stageOf', { n: rq.stage + 1, total: rq.stageCount })}
                      </span>
                    )}
                    <span className="flex-1" />
                    <span className="text-xs text-text-3">
                      {rq.requestedBy?.name ?? '?'} · {formatTime(rq.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={t('envx.chain')} count={status?.versions.length}>
            {status && status.versions.length === 0 ? (
              <EmptyHint>{t('envx.noVersions')}</EmptyHint>
            ) : status ? (
              <VersionChain status={status} params={params} dialect={project.dialect} />
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

          {/* 环境层的执行策略（P5a）：上级的要求锁定显示，只能收紧 */}
          <Section title={t('pol.title')}>
            <EnvPolicyPanel pid={pid} eid={eid} />
          </Section>

          <Section title={t('envp.config')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-md border border-border bg-panel px-4 py-3 text-sm">
              <dt className="text-text-2">{t('dlg.envUrl')}</dt>
              <dd className="m-0 truncate font-mono text-xs">{env.url}</dd>
              <dt className="text-text-2">
                {project.dialect === 'pg' ? t('envp.pgVersion') : t('envp.engineVersion')}
              </dt>
              <dd className="m-0">
                {formatEngineVersion(project.dialect, env.engineVersion, env.engineMajor, true) ? (
                  <span className="font-mono text-xs">
                    {formatEngineVersion(project.dialect, env.engineVersion, env.engineMajor, true)}
                  </span>
                ) : (
                  <span className="text-text-2">
                    {project.dialect === 'pg' ? t('envp.pgVersionUnknown') : t('envp.engineVersionUnknown')}
                  </span>
                )}
              </dd>
              <dt className="text-text-2">{t('dlg.envProduction')}</dt>
              <dd className="m-0 flex flex-wrap items-center gap-2">
                <span>{env.production ? t('envp.production') : t('envp.notProduction')}</span>
                {project.role === 'admin' &&
                  (env.production ? (
                    <button
                      type="button"
                      className="btn"
                      aria-disabled={!canUnmarkProduction || setProduction.isPending || undefined}
                      title={canUnmarkProduction ? undefined : denied(env.effectiveExecPolicy)}
                      onClick={() => {
                        if (!canUnmarkProduction || setProduction.isPending) return;
                        setProduction.reset();
                        setUnmarkConfirm(true);
                      }}
                    >
                      {t('envp.unmarkProduction')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={setProduction.isPending}
                      aria-busy={setProduction.isPending || undefined}
                      onClick={() => setProduction.mutate(true)}
                    >
                      {t('envp.markProduction')}
                    </button>
                  ))}
              </dd>
              {dialectUiSpec(project.dialect).requiresExternalShadow ? (
                <>
                  <dt className="text-text-2">{t('dlg.envAllowSame')}</dt>
                  <dd className="m-0">{env.allowSameInstance ? '✓' : '—'}</dd>
                  <dt className="text-text-2">{t('envp.shadow')}</dt>
                  <dd className="m-0 font-mono text-xs">{env.shadowUrl ?? t('envp.shadowNone')}</dd>
                </>
              ) : (
                <>
                  <dt className="text-text-2">{t('envp.shadow')}</dt>
                  <dd className="m-0 text-xs text-text-2">{t('envp.shadowMemory')}</dd>
                </>
              )}
              <dt className="text-text-2">{t('envp.status')}</dt>
              <dd className="m-0 text-text-2">{t('envp.statusUnknown')}</dd>
              {history && (
                <>
                  <dt className="text-text-2">{t('tk.claimRow')}</dt>
                  <dd className="m-0" data-testid="claim-info">
                    {!history.claim
                      ? t('tk.claimNone')
                      : history.claim.mine
                        ? t('tk.claimMine')
                        : t('tk.claimOther', { id: history.claim.instanceId ?? '?' })}
                    {history.claims.length > 0 && (
                      <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-xs text-text-3">
                        {history.claims.map((c) => (
                          <li key={c.id}>
                            {t('tk.claimEvent', {
                              time: formatTime(c.claimedAt),
                              who: c.claimedByName ?? t('tk.unknownInstance'),
                              prev: c.previousInstanceId ?? t('tk.unknownInstance'),
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </>
              )}
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
          dialect={project.dialect}
          status={status}
          kind={dlg.kind}
          to={dlg.to}
          mode={dlg.mode}
          onClose={() => setDlg(null)}
          onRequested={(rq) => {
            setDlg(null);
            toast(t('req.submitted'));
            void nav({ to: '/project/$owner/$project/requests/$rid', params: { ...params, rid: rq.id } });
          }}
        />
      )}

      {importOpen && <ImportDialog pid={pid} eid={eid} onClose={() => setImportOpen(false)} />}
      {repairOpen && (
        <RepairDialog
          pid={pid}
          eid={eid}
          onClose={() => setRepairOpen(false)}
          onRecheck={() => checkDrift.mutate(undefined, { onSuccess: () => setRepairOpen(false) })}
          rechecking={checkDrift.isPending}
        />
      )}
      {markDlg && status && (
        <MarkDialog
          pid={pid}
          eid={eid}
          envName={env.name}
          production={env.production}
          current={markCurrent}
          to={markDlg}
          tree={status?.versions}
          onClose={() => setMarkDlg(null)}
        />
      )}

      <ClaimDialog
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onConfirm={() => claim.mutate()}
        pending={claim.isPending}
        error={claim.error?.message}
        instanceId={history?.claim?.instanceId}
        isAdmin={isInstanceAdmin}
      />

      <Confirm
        open={unmarkConfirm}
        onClose={() => setUnmarkConfirm(false)}
        title={t('envp.unmarkTitle', { name: env.name })}
        confirmLabel={t('envp.unmarkProduction')}
        pending={setProduction.isPending}
        error={setProduction.error?.message}
        onConfirm={() => setProduction.mutate(false)}
      >
        {t('envp.unmarkHint')}
      </Confirm>

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
