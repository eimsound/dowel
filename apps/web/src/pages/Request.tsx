// 执行申请详情（P5b，E9）：起止版本、绑定的迁移与校验和、预演摘要、审批环节与时间线、当前状态和失效原因；
// 按钮：通过 / 驳回（带意见）/ 通过并执行 / 执行 / 撤回。按钮是否可用由服务端给出（actions），不在界面上自己推。
// “通过并执行”和“执行”打开确认对话框：生产环境要输入环境名，确认后用 SSE 读进度。
import type { ExecEvent, ExecRequestDetail, RequestStageView, VersionInfo } from '@dowel/api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Check, CircleDashed, LoaderCircle, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { Modal } from '../components/Modal.tsx';
import { Section } from '../components/ProjectPage.tsx';
import { PageHeader } from '../components/Shell.tsx';
import { useToast } from '../components/Toasts.tsx';
import { Banner } from '../components/ui.tsx';
import { VersionNumber } from '../components/VersionStatus.tsx';
import { dialectUiSpec } from '../dialects.ts';
import { streamExec } from '../envs.ts';
import { formatTime } from '../format.ts';
import { useProject } from '../project.tsx';
import { invalidateRequests, STATUS_TONE, useRequest } from '../requests.ts';

export const StatusBadge = ({ status }: { status: ExecRequestDetail['status'] }) => {
  const { t } = useTranslation();
  return (
    <span className={`badge ${STATUS_TONE[status]}`} data-testid="request-status">
      {t(`req.status.${status}`)}
    </span>
  );
};

/** “通过并执行” / “执行”：确认（生产输入环境名）→ SSE 进度 → 结果 */
const RunDialog = ({
  r,
  approve,
  comment,
  onClose,
}: {
  r: ExecRequestDetail;
  /** 有值：通过并执行（先通过这个环节） */
  approve: number | null;
  comment: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const { pid } = useProject();
  const qc = useQueryClient();
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done' | 'failed'>('confirm');
  const [stage, setStage] = useState<ExecEvent['stage'] | null>(null);
  const [result, setResult] = useState<ExecEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const mustType = r.environment.production;
  const canConfirm = !mustType || typed.trim() === r.environment.name;
  const start = async () => {
    if (!canConfirm || running.current) return;
    running.current = true;
    setPhase('running');
    let last: ExecEvent | null = null;
    try {
      await streamExec(
        `/api/projects/${pid}/requests/${r.id}/execute`,
        approve === null ? { confirm: typed } : { confirm: typed, approve: { stage: approve, comment } },
        (e) => {
          last = e;
          if (!e.error) setStage(e.stage);
        },
      );
      const ev = last as ExecEvent | null;
      if (ev?.error) {
        setError(ev.error);
        setPhase('failed');
      } else {
        setResult(ev);
        setPhase('done');
      }
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setPhase('failed');
    } finally {
      running.current = false;
      void invalidateRequests(qc);
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['env-status', pid, r.environment.id] });
      void qc.invalidateQueries({ queryKey: ['env-history', pid, r.environment.id] });
    }
  };
  const title = t(approve === null ? 'req.run.titleExecute' : 'req.run.titleApprove', {
    name: r.environment.name,
    number: r.to.number,
  });
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={title}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {phase === 'confirm' ? t('dlg.cancel') : t('dlg.close')}
          </button>
          {(phase === 'confirm' || phase === 'running') && (
            <button
              type="button"
              className={r.kind === 'execute' ? 'btn primary' : 'btn danger solid'}
              aria-disabled={!canConfirm || phase === 'running' || undefined}
              aria-busy={phase === 'running' || undefined}
              onClick={() => void start()}
            >
              {approve === null ? t('req.actions.execute') : t('req.actions.approveAndExecute')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-2">
          {t(
            r.kind === 'rollback'
              ? 'req.run.introRollback'
              : r.kind === 'switch'
                ? 'req.run.introSwitch'
                : 'req.run.introExecute',
            {
              count: r.migrations.length,
              down: r.migrations.filter((m) => m.direction === 'down').length,
              up: r.migrations.filter((m) => m.direction === 'up').length,
            },
          )}
        </p>
        <ol className="m-0 list-none overflow-hidden rounded-md border border-border p-0">
          {r.migrations.map((m) => (
            <li
              key={`${m.versionId}-${m.direction}`}
              className="flex items-center gap-2 px-3 py-2 text-sm not-first:border-t not-first:border-border"
            >
              <VersionNumber number={m.number} />
              <span className="min-w-0 flex-1 truncate font-mono">{m.name}</span>
              <span className="text-xs text-text-3">{t('envx.exec.steps', { count: m.steps })}</span>
            </li>
          ))}
        </ol>
        {mustType && phase === 'confirm' && (
          <div className="field">
            <label htmlFor={inputId} className="label">
              {t('envx.exec.typeName', { name: r.environment.name })}
            </label>
            <input
              id={inputId}
              className="input font-mono"
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void start();
                }
              }}
            />
            <p className="hint">{t('envx.exec.typeHint')}</p>
          </div>
        )}
        {phase === 'running' && stage && (
          <p role="status" className="m-0 inline-flex items-center gap-1.5 text-sm text-text-2">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
            {t(`envx.exec.stage.${stage}`)}
          </p>
        )}
        {phase === 'done' && (
          <Banner kind="ok" title={t('envx.exec.okTitle')} role="status">
            {result?.current
              ? t('envx.exec.okCurrent', { number: result.current.number, ran: result.ran ?? 0 })
              : t('envx.exec.okNothing')}
          </Banner>
        )}
        {phase === 'failed' && error && (
          <Banner kind="danger" title={t('envx.exec.failedTitle')} role="alert">
            {error}
          </Banner>
        )}
      </div>
    </Modal>
  );
};

const StageCard = ({ s, current, status }: { s: RequestStageView; current: boolean; status: string }) => {
  const { t } = useTranslation();
  const approved = s.approvals.filter((a) => a.decision === 'approve').length;
  return (
    <li
      className="space-y-1.5 rounded-md border border-border px-3 py-2 text-sm"
      aria-current={current ? 'step' : undefined}
      data-testid={`stage-${s.index}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {s.done ? (
          <Check size={14} aria-hidden="true" className="text-text-2" />
        ) : current && status === 'pending' ? (
          <LoaderCircle size={14} aria-hidden="true" className="text-text-2" />
        ) : (
          <CircleDashed size={14} aria-hidden="true" className="text-text-3" />
        )}
        <span className="font-medium">{t('req.stage.title', { n: s.index + 1 })}</span>
        <span>
          {s.approvers.kind === 'can_execute'
            ? t('req.stage.canExecute')
            : s.approvers.kind === 'group_admins' ||
                s.approvers.kind === 'project_admins' ||
                s.approvers.kind === 'executors'
              ? t(`pol.approval.kinds.${s.approvers.kind}`)
              : s.label}
        </span>
        <span className="text-text-2">· {t('req.stage.progress', { done: approved, count: s.count })}</span>
        {s.lastApproverExecutes && <span className="chip">{t('req.stage.lastExecutes')}</span>}
        {current && status === 'pending' && <span className="badge warn">{t('req.stage.current')}</span>}
      </div>
      {current && status === 'pending' && s.eligible < s.count - approved && (
        <p className="hint" role="note">
          {t('req.stage.notEnough', { eligible: s.eligible })}
        </p>
      )}
      {s.approvals.length > 0 && (
        <ul className="list-none space-y-1 p-0 pl-6">
          {s.approvals.map((a) => (
            <li key={`${a.userId}-${a.at}`} className="text-text-2">
              {a.decision === 'approve' ? (
                <Check size={12} aria-hidden="true" className="mr-1 inline" />
              ) : (
                <X size={12} aria-hidden="true" className="mr-1 inline" />
              )}
              {t(a.decision === 'approve' ? 'req.stage.approvedBy' : 'req.stage.rejectedBy', {
                name: a.userName ?? '?',
                time: formatTime(a.at),
              })}
              {a.comment && <span className="text-text"> · {a.comment}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

const RequestView = ({ rid }: { rid: string }) => {
  const { t } = useTranslation();
  const { pid, project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  const qc = useQueryClient();
  const toast = useToast();
  const q = useRequest(pid, rid);
  // 切换申请（ADR 0013）：回滚段的终点（最近公共祖先）= 最后一个回滚的版本的 parent
  const versions = useQuery({
    queryKey: ['versions', pid],
    queryFn: () => api<VersionInfo[]>('GET', `/api/projects/${pid}/versions`),
    enabled: q.data?.kind === 'switch',
  });
  const commentId = useId();
  const [comment, setComment] = useState('');
  const [run, setRun] = useState<{ approve: number | null } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const act = useMutation({
    mutationFn: (a: { op: 'approve' | 'reject' | 'withdraw'; body?: unknown }) =>
      api<ExecRequestDetail>('POST', `/api/projects/${pid}/requests/${rid}/${a.op}`, a.body ?? {}),
    onSuccess: (r, a) => {
      qc.setQueryData(['request', pid, rid], r);
      void invalidateRequests(qc);
      setComment('');
      setRejecting(false);
      toast(t(`req.done.${a.op}`));
    },
    onError: (e) => {
      toast(e.message, 'error');
      void invalidateRequests(qc);
    },
  });
  const r = q.data;
  if (!r)
    return (
      <>
        <PageHeader
          crumbs={[
            { label: project.name, to: '/project/$owner/$project', params },
            { label: t('req.title') },
          ]}
        />
        <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
          {q.error && (
            <Banner kind="danger" role="alert">
              {q.error.message}
            </Banner>
          )}
        </main>
      </>
    );
  const a = r.actions;
  const pending = r.status === 'pending';
  const stageDesc = r.stages[r.stage];
  return (
    <>
      <PageHeader
        crumbs={[
          { label: project.group.name, to: '/group/$slug', params: { slug: project.group.slug } },
          { label: project.name, to: '/project/$owner/$project', params },
          {
            label: r.environment.name,
            to: '/project/$owner/$project/environments/$eid',
            params: { ...params, eid: r.environment.id },
            mono: true,
          },
          { label: t(r.emergency ? 'req.titleEmergency' : 'req.title') },
        ]}
      />
      <main className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[960px] space-y-6 px-6 py-6">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={r.status} />
              {r.emergency && <span className="badge danger">{t('req.emergencyBadge')}</span>}
              <h2 className="text-[length:var(--fs-headline)] font-semibold">
                {t(
                  r.kind === 'rollback'
                    ? 'req.headRollback'
                    : r.kind === 'switch'
                      ? 'req.headSwitch'
                      : 'req.headExecute',
                  {
                    env: r.environment.name,
                    from: r.from ? `v${r.from.number}` : t('req.none'),
                    to: `v${r.to.number}`,
                  },
                )}
              </h2>
              {r.environment.production && <span className="badge danger">{t('envp.production')}</span>}
            </div>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
              <dt className="text-text-2">
                {t(r.emergency ? 'req.executedByEmergency' : 'req.requestedBy')}
              </dt>
              <dd className="m-0">
                {r.requestedBy?.name ?? '?'} · {formatTime(r.createdAt)}
              </dd>
              {r.reason && (
                <>
                  <dt className="text-text-2">{t(r.emergency ? 'req.emergency.reason' : 'req.reason')}</dt>
                  <dd className="m-0 whitespace-pre-wrap">{r.reason}</dd>
                </>
              )}
              {!r.emergency && (
                <>
                  <dt className="text-text-2">{t('req.expiresAt')}</dt>
                  <dd className="m-0">{formatTime(r.expiresAt)}</dd>
                </>
              )}
              {r.executedBy && (
                <>
                  <dt className="text-text-2">{t('req.executedBy')}</dt>
                  <dd className="m-0">
                    {r.executedBy.name}
                    {r.executedAt ? ` · ${formatTime(r.executedAt)}` : ''}
                  </dd>
                </>
              )}
            </dl>
            {r.statusReason &&
              (r.status === 'invalid' || r.status === 'expired' || r.status === 'failed') && (
                <Banner
                  kind={r.status === 'failed' ? 'danger' : 'warn'}
                  title={t(`req.status.${r.status}`)}
                  role="status"
                >
                  <span data-testid="status-reason">{r.statusReason}</span>
                </Banner>
              )}
            {r.status === 'rejected' && r.statusReason && (
              <Banner kind="danger" title={t('req.status.rejected')} role="status">
                <span data-testid="status-reason">{r.statusReason}</span>
              </Banner>
            )}
            {r.status === 'executed' && r.result?.current && (
              <Banner kind="ok" title={t('req.status.executed')} role="status">
                {t('req.executedTo', { number: r.result.current.number })}
              </Banner>
            )}
          </div>

          {(a.approve || a.reject || a.approveAndExecute || a.execute || a.withdraw || a.note) && (
            <Section title={t('req.actions.title')}>
              <div className="space-y-2 rounded-md border border-border bg-panel px-4 py-3">
                {pending && stageDesc && (a.approve || a.reject || a.approveAndExecute) && (
                  <p className="text-sm text-text-2">
                    {t('req.actions.stageNow', { n: r.stage + 1, total: r.stageCount })}
                  </p>
                )}
                {(a.approve || a.reject || a.approveAndExecute) && (
                  <div className="field">
                    <label htmlFor={commentId} className="label">
                      {rejecting ? t('req.actions.rejectComment') : t('req.actions.comment')}
                    </label>
                    <textarea
                      id={commentId}
                      className="input min-h-[56px]"
                      maxLength={2000}
                      value={comment}
                      aria-required={rejecting || undefined}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {a.approveAndExecute && (
                    <button
                      type="button"
                      className="btn primary"
                      onClick={() => setRun({ approve: r.stage })}
                    >
                      {t('req.actions.approveAndExecute')}
                    </button>
                  )}
                  {a.approve && (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate({ op: 'approve', body: { stage: r.stage, comment: comment.trim() } })
                      }
                    >
                      {t('req.actions.approve')}
                    </button>
                  )}
                  {a.reject && (
                    <button
                      type="button"
                      className="btn danger"
                      disabled={act.isPending}
                      onClick={() => {
                        if (!comment.trim()) {
                          setRejecting(true);
                          toast(t('req.actions.rejectNeedsComment'), 'error');
                          return;
                        }
                        act.mutate({ op: 'reject', body: { stage: r.stage, comment: comment.trim() } });
                      }}
                    >
                      {t('req.actions.reject')}
                    </button>
                  )}
                  {a.execute && (
                    <button type="button" className="btn primary" onClick={() => setRun({ approve: null })}>
                      {r.status === 'failed' ? t('req.actions.retry') : t('req.actions.execute')}
                    </button>
                  )}
                  {a.withdraw && (
                    <button
                      type="button"
                      className="btn"
                      disabled={act.isPending}
                      onClick={() => act.mutate({ op: 'withdraw' })}
                    >
                      {t('req.actions.withdraw')}
                    </button>
                  )}
                </div>
                {a.note && (
                  <p className="hint" role="note" data-testid="actions-note">
                    {a.note}
                  </p>
                )}
              </div>
            </Section>
          )}

          <Section title={t('req.flow.title')}>
            {r.implicit && <p className="hint">{t('req.flow.implicit')}</p>}
            <ol className="list-none space-y-1.5 p-0">
              {r.stages.map((s) => (
                <StageCard key={s.index} s={s} current={s.index === r.stage} status={r.status} />
              ))}
            </ol>
          </Section>

          <Section title={t('req.migrations')} count={r.migrations.length}>
            {r.kind === 'switch' &&
              (() => {
                const downs = r.migrations.filter((m) => m.direction === 'down');
                const lastDown = downs.at(-1);
                const lca = versions.data?.find(
                  (v) => v.id === versions.data?.find((x) => x.id === lastDown?.versionId)?.parentId,
                );
                return (
                  <Banner kind="warn">
                    {t('req.switchNote', {
                      down: downs.length,
                      up: r.migrations.length - downs.length,
                      lca: lca?.number ?? '?',
                    })}
                  </Banner>
                );
              })()}
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{t('req.col.version')}</th>
                  <th scope="col">{t('req.col.direction')}</th>
                  <th scope="col">{t('req.col.steps')}</th>
                  <th scope="col">{t('req.col.checksum')}</th>
                </tr>
              </thead>
              <tbody>
                {r.migrations.map((m) => (
                  <tr key={`${m.versionId}-${m.direction}`}>
                    <td>
                      <Link
                        to="/project/$owner/$project/versions/$vid"
                        params={{ ...params, vid: m.versionId }}
                        className="inline-flex items-center gap-1.5"
                      >
                        <VersionNumber number={m.number} />
                        <span className="font-mono">{m.name}</span>
                      </Link>
                    </td>
                    <td>
                      {r.kind === 'switch' && m.direction === 'down' ? (
                        <span className="risk high">{t('req.down')}</span>
                      ) : (
                        t(m.direction === 'down' ? 'req.down' : 'req.up')
                      )}
                    </td>
                    <td>
                      {m.steps}
                      {m.nonTransactional > 0 && (
                        <span className="risk medium ml-1.5">
                          {t('tk.dry.nonTx', { count: m.nonTransactional })}
                        </span>
                      )}
                    </td>
                    <td>
                      <code className="text-xs" title={m.checksum}>
                        {m.checksum.slice(0, 12)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {r.dryRun && (
              <p className="hint">
                {t('req.dryRun', {
                  checks: r.dryRun.checks.map((c) => t(`tk.dry.check.${c}`)).join('、'),
                })}
                {r.dryRun.createsHistory
                  ? ` ${t(dialectUiSpec(project.dialect).historyStorage === 'prefix' ? 'tk.dry.createsHistoryPrefix' : 'tk.dry.createsHistory')}`
                  : ''}
              </p>
            )}
            <p className="hint">{t('req.binding')}</p>
          </Section>

          <Section title={t('req.timeline.title')}>
            <ol className="list-none space-y-1 p-0 text-sm" data-testid="timeline">
              {r.timeline.map((e, i) => (
                <li key={i} className="flex flex-wrap gap-x-2">
                  <span className="text-text-3 tabular-nums">{formatTime(e.at)}</span>
                  <span>
                    {t(`req.timeline.${e.kind}`, {
                      name: e.userName ?? t('req.timeline.system'),
                      n: (e.stage ?? 0) + 1,
                      defaultValue: e.kind,
                    })}
                  </span>
                  {e.comment && <span className="text-text-2">· {e.comment}</span>}
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </main>
      {run && <RunDialog r={r} approve={run.approve} comment={comment.trim()} onClose={() => setRun(null)} />}
    </>
  );
};

export const RequestDetail = () => {
  const { rid } = useParams({ strict: false }) as { rid: string };
  return <RequestView key={rid} rid={rid} />;
};
