// 执行确认对话框：列出将要执行 / 回滚的迁移和风险摘要，生产环境必须输入环境名才能确认；
// 确认后用 SSE 读进度，出错时显示原因（漂移时列出差异）。关闭时刷新环境的状态、历史和列表。
// P5a：显示生效的执行策略摘要。
// P5b：mode = request 时（无权直接执行，或环境要求审批）变成“提交执行申请”：预演不通过不能提交，可以写申请说明；
// mode = emergency 是实例管理员的紧急执行：绕过审批，必填原因并二次确认（勾选确认 + 生产环境输入环境名）。
import type {
  DriftItem,
  DryRunResponse,
  EnvStatus,
  EnvVersion,
  ExecEvent,
  ExecRequestDetail,
} from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api.ts';
import { streamExec } from '../envs.ts';
import { Modal } from './Modal.tsx';
import { PolicySummary } from './PolicyEditor.tsx';
import { Banner, Sql } from './ui.tsx';
import { useVersionName, VersionNumber } from './VersionStatus.tsx';

export type ExecKind = 'execute' | 'rollback' | 'baseline';
/** direct：直接执行；request：提交执行申请；emergency：紧急执行（实例管理员，绕过审批） */
export type ExecMode = 'direct' | 'request' | 'emergency';

/** 这次要执行 / 回滚的版本（按执行顺序）：执行是从当前版本之后到目标；回滚是从当前版本往回到目标之后 */
export const migrationsFor = (status: EnvStatus, kind: ExecKind, to?: EnvVersion): EnvVersion[] => {
  if (kind === 'baseline' || !to) return [];
  const cur = status.currentVersion?.number ?? -1;
  if (kind === 'execute') return status.versions.filter((v) => v.number > cur && v.number <= to.number);
  return status.versions.filter((v) => v.number > to.number && v.number <= cur).reverse();
};

interface Progress {
  status: 'start' | 'step' | 'done';
  step: number;
  steps: number;
}

const RiskChip = ({ v }: { v: EnvVersion }) => {
  const { t } = useTranslation();
  return (
    <>
      {v.risk && (v.risk === 'high' || v.risk === 'medium') && (
        <span className={`risk ${v.risk}`}>{t(`envx.exec.risk.${v.risk}`)}</span>
      )}
      {v.riskError && (
        <span className="risk medium" title={v.riskError}>
          {t('envx.exec.riskError')}
        </span>
      )}
    </>
  );
};

export const DiffList = ({ items, total }: { items: DriftItem[]; total?: number }) => {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5">
      <ul className="m-0 list-none space-y-1.5 p-0">
        {items.map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 差异列表只读、顺序固定
          <li key={i} className="rounded-sm border border-border bg-bg px-2 py-1.5 text-xs">
            <div className="mb-0.5 text-text-3">
              {d.kind} · <span className="font-mono">{d.target}</span>
            </div>
            <code className="block font-mono break-all whitespace-pre-wrap">
              <Sql text={d.sql} />
            </code>
          </li>
        ))}
      </ul>
      {total !== undefined && total > items.length && (
        <p className="hint">{t('envx.drift.truncated', { shown: items.length, total })}</p>
      )}
    </div>
  );
};

type DryState =
  | { state: 'loading' }
  | { state: 'done'; res: DryRunResponse }
  | { state: 'error'; message: string };

/**
 * 预演结果：确认对话框打开时先调用 dryRun（做完全部执行前检查，不写目标库也不写平台库的登记），
 * 把“现在执行会做什么 / 为什么会被拒绝”显示出来。
 */
const DryRunPanel = ({ dry, onRetry }: { dry: DryState; onRetry: () => void }) => {
  const { t } = useTranslation();
  const versionName = useVersionName();
  if (dry.state === 'loading')
    return (
      <p role="status" className="m-0 inline-flex items-center gap-1.5 text-sm text-text-2">
        <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
        {t('tk.dry.running')}
      </p>
    );
  if (dry.state === 'error')
    return (
      <Banner kind="warn" role="status" title={t('tk.dry.failTitle')}>
        {dry.message}
        <div className="mt-1.5">
          <button type="button" className="btn" onClick={onRetry}>
            {t('tk.dry.retry')}
          </button>
        </div>
      </Banner>
    );
  const { res } = dry;
  if (!res.ok || !res.plan)
    return (
      <div className="space-y-2" role="status">
        <Banner kind="danger" title={t('tk.dry.failTitle')}>
          <p className="m-0">{t('tk.dry.failBody')}</p>
          <p className="m-0 mt-1" data-testid="dry-error">
            {res.error}
          </p>
          <div className="mt-1.5">
            <button type="button" className="btn" onClick={onRetry}>
              {t('tk.dry.retry')}
            </button>
          </div>
        </Banner>
        {res.details?.diff && res.details.diff.length > 0 && (
          <DiffList items={res.details.diff} total={res.details.diffTotal} />
        )}
        <p className="hint">{t('tk.dry.readonly')}</p>
      </div>
    );
  const plan = res.plan;
  return (
    <div className="space-y-2" role="status" data-testid="dry-run">
      <Banner kind="ok" title={t('tk.dry.okTitle')}>
        {plan.migrations.length === 0 && !plan.baseline ? t('tk.dry.nothing') : t('tk.dry.okBody')}
      </Banner>
      {plan.firstRun === 'empty' && <p className="hint m-0">{t('tk.dry.firstRunEmpty')}</p>}
      {plan.firstRun === 'baseline' && <p className="hint m-0">{t('tk.dry.firstRunBaseline')}</p>}
      {plan.createsHistory && <p className="hint m-0">{t('tk.dry.createsHistory')}</p>}
      {plan.resume && (
        <p className="hint m-0">
          {t('tk.dry.resume', {
            number: plan.migrations.find((m) => m.versionId === plan.resume?.versionId)?.number ?? '?',
            step: plan.resume.afterStep + 2,
          })}
        </p>
      )}
      <ul className="m-0 list-none space-y-1 p-0">
        {plan.migrations.map((m) => (
          <li
            key={`${m.versionId}-${m.direction}`}
            className="rounded-sm border border-border px-2 py-1.5 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <VersionNumber number={m.number} />
              <span className="font-mono">{versionName(m)}</span>
              <span className="text-text-3">{t('tk.dry.steps', { count: m.steps.length })}</span>
              {m.nonTransactional > 0 && (
                <span className="risk medium">{t('tk.dry.nonTx', { count: m.nonTransactional })}</span>
              )}
              {m.risk && (m.risk === 'high' || m.risk === 'medium') && (
                <span className={`risk ${m.risk}`}>{t(`envx.exec.risk.${m.risk}`)}</span>
              )}
              {m.riskError && (
                <span className="risk medium" title={m.riskError}>
                  {t('envx.exec.riskError')}
                </span>
              )}
              {!m.verified && <span className="risk medium">{t('tk.dry.unverified')}</span>}
            </div>
            <details className="mt-1">
              <summary className="cursor-pointer text-text-2">{t('tk.dry.showSteps')}</summary>
              <ol className="m-0 mt-1 list-none space-y-1 p-0">
                {m.steps.map((st, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 步骤只读、顺序固定
                  <li key={i}>
                    <code className="block font-mono break-all whitespace-pre-wrap">
                      <Sql text={st.sql} />
                    </code>
                    {!st.transactional && <span className="text-text-3">{t('envx.nonTxShort')}</span>}
                  </li>
                ))}
              </ol>
            </details>
          </li>
        ))}
      </ul>
      <p className="hint m-0">
        {t('tk.dry.checks')}：{plan.checks.map((c) => t(`tk.dry.check.${c}`)).join('、')}
      </p>
      <p className="hint m-0">{t('tk.dry.readonly')}</p>
    </div>
  );
};

export const ExecDialog = ({
  pid,
  eid,
  envName,
  production,
  status,
  kind,
  to,
  onClose,
  mode = 'direct',
  onRequested,
}: {
  pid: string;
  eid: string;
  envName: string;
  production: boolean;
  status: EnvStatus;
  kind: ExecKind;
  to?: EnvVersion;
  onClose: () => void;
  mode?: ExecMode;
  /** 申请提交成功（mode = request）：跳到申请详情 */
  onRequested?: (r: ExecRequestDetail) => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const versionName = useVersionName();
  const inputId = useId();
  const migrations = migrationsFor(status, kind, to);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done' | 'failed'>('confirm');
  const [stage, setStage] = useState<ExecEvent['stage'] | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [baseline, setBaseline] = useState<Progress | null>(null);
  const [plan, setPlan] = useState<ExecEvent | null>(null);
  const [result, setResult] = useState<ExecEvent | null>(null);
  const [error, setError] = useState<{ message: string; code?: string; event?: ExecEvent } | null>(null);
  const running = useRef(false);
  const [dry, setDry] = useState<DryState>({ state: 'loading' });
  const [dryTick, setDryTick] = useState(0);
  const reasonId = useId();
  const ackId = useId();
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const isRequest = mode === 'request';
  const isEmergency = mode === 'emergency';
  // 申请不执行任何东西，不用输入环境名（执行时再输入）；直接执行和紧急执行在生产环境要输入
  const mustType = production && !isRequest;
  const dryOk = dry.state === 'done' && dry.res.ok;
  const canConfirm =
    (!mustType || typed.trim() === envName) &&
    // 申请：预演不通过不能提交（服务端同样会拒绝）
    (!isRequest || dryOk) &&
    // 紧急执行：必填原因 + 勾选确认（二次确认）
    (!isEmergency || (reason.trim() !== '' && ack));

  // 对话框打开（或点“重新预演”）时先预演：只读，不写目标库，也不写平台库的登记；
  // 预演没通过不挡着确认按钮——真正的执行会被同样的原因拒绝，原因照样显示
  // biome-ignore lint/correctness/useExhaustiveDependencies: dryTick 只用来触发重新预演
  useEffect(() => {
    let live = true;
    setDry({ state: 'loading' });
    const body = kind === 'baseline' ? { dryRun: true } : { to: to?.id, dryRun: true };
    // 申请：没有直接执行权限的人也能预演（提交申请的接口带 dryRun）
    const req = isRequest
      ? api<DryRunResponse>('POST', `/api/projects/${pid}/environments/${eid}/requests`, {
          kind,
          to: to?.id,
          dryRun: true,
        })
      : api<DryRunResponse>('POST', `/api/projects/${pid}/environments/${eid}/${kind}`, body);
    req.then(
      (res) => live && setDry({ state: 'done', res }),
      (e: unknown) => live && setDry({ state: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [pid, eid, kind, to?.id, dryTick, isRequest]);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['envs', pid] }),
      qc.invalidateQueries({ queryKey: ['env-status', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['env-history', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['versions', pid] }),
    ]);

  const submitRequest = async () => {
    if (!canConfirm || running.current) return;
    running.current = true;
    setSubmitError(null);
    try {
      const r = await api<ExecRequestDetail>('POST', `/api/projects/${pid}/environments/${eid}/requests`, {
        kind,
        to: to!.id,
        reason: reason.trim(),
      });
      void qc.invalidateQueries({ queryKey: ['requests', pid] });
      onRequested?.(r);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
    }
  };

  const start = async () => {
    if (isRequest) return submitRequest();
    if (!canConfirm || running.current) return;
    running.current = true;
    setPhase('running');
    const base = `/api/projects/${pid}/environments/${eid}`;
    const body = isEmergency
      ? { kind, to: to!.id, reason: reason.trim(), confirm: typed }
      : kind === 'baseline'
        ? { confirm: typed }
        : { to: to!.id, confirm: typed };
    let last: ExecEvent | null = null;
    try {
      await streamExec(`${base}/${isEmergency ? 'emergency' : kind}`, body, (e) => {
        last = e;
        if (e.error) return;
        setStage(e.stage);
        if (e.stage === 'plan') setPlan(e);
        if (e.stage === 'migration' && e.versionId) {
          const p: Progress = { status: e.status ?? 'start', step: e.step ?? 0, steps: e.steps ?? 0 };
          if (e.direction === 'baseline') setBaseline(p);
          else setProgress((s) => ({ ...s, [e.versionId!]: { ...s[e.versionId!], ...p } }));
        }
        if (e.stage === 'done') setResult(e);
      });
      const ev = last as ExecEvent | null;
      if (ev?.error) {
        setError({ message: ev.error, code: ev.code, event: ev });
        setPhase('failed');
      } else setPhase('done');
    } catch (e) {
      setError({ message: e instanceof ApiError || e instanceof Error ? e.message : String(e) });
      setPhase('failed');
    } finally {
      running.current = false;
      void refresh();
      void qc.invalidateQueries({ queryKey: ['requests', pid] });
    }
  };

  const title = isRequest
    ? t(kind === 'rollback' ? 'req.dialog.titleRollback' : 'req.dialog.titleExecute', {
        name: envName,
        number: to?.number,
      })
    : isEmergency
      ? t('req.emergency.title', { name: envName, number: to?.number })
      : kind === 'baseline'
        ? t('envx.exec.titleBaseline', { name: envName })
        : kind === 'execute'
          ? t('envx.exec.titleExecute', { name: envName, number: to?.number })
          : t('envx.exec.titleRollback', { name: envName, number: to?.number });
  const details = error?.event?.details;
  const rows = plan?.migrations ?? [];
  const closeLabel = phase === 'confirm' ? t('dlg.cancel') : t('dlg.close');

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
            {closeLabel}
          </button>
          {phase !== 'done' && phase !== 'failed' && (
            <button
              type="button"
              className={kind === 'rollback' || isEmergency ? 'btn danger solid' : 'btn primary'}
              aria-disabled={!canConfirm || phase === 'running' || undefined}
              aria-describedby={mustType && !canConfirm ? `${inputId}-hint` : undefined}
              aria-busy={phase === 'running' || undefined}
              onClick={() => void start()}
            >
              {isRequest
                ? t('req.dialog.submit')
                : isEmergency
                  ? t('req.emergency.confirm')
                  : kind === 'baseline'
                    ? t('envx.exec.confirmBaseline')
                    : kind === 'execute'
                      ? t('envx.exec.confirmExecute')
                      : t('envx.exec.confirmRollback')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {phase === 'confirm' && (
          <div className="space-y-1.5 rounded-md border border-border px-3 py-2">
            <PolicySummary policy={status.policy} />
          </div>
        )}

        {kind === 'baseline' ? (
          <p className="text-sm text-text-2">{t('envx.exec.baselineHint')}</p>
        ) : (
          <>
            <p className="text-sm text-text-2">
              {kind === 'execute'
                ? t('envx.exec.executeIntro', { count: migrations.length })
                : t('envx.exec.rollbackIntro', { count: migrations.length })}
            </p>
            <ol
              className="m-0 list-none overflow-hidden rounded-md border border-border p-0"
              aria-label={t('envx.exec.migrations')}
            >
              {migrations.map((v, i) => {
                const p = progress[v.id];
                return (
                  <li
                    key={v.id}
                    className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm not-first:border-t not-first:border-border"
                  >
                    <span className="w-5 shrink-0 text-xs text-text-3">{i + 1}</span>
                    <VersionNumber number={v.number} />
                    <span className="min-w-0 flex-1 truncate font-mono">{versionName(v)}</span>
                    <span className="text-xs text-text-3">
                      {t('envx.exec.steps', { count: kind === 'execute' ? v.upSteps : v.downSteps })}
                    </span>
                    {kind === 'execute' && v.nonTransactional && (
                      <span className="risk medium" title={t('envx.nonTx')}>
                        {t('envx.nonTxShort')}
                      </span>
                    )}
                    {kind === 'execute' && <RiskChip v={v} />}
                    {p && (
                      <span className="inline-flex items-center gap-1 text-xs text-text-2">
                        {p.status === 'done' ? (
                          <CircleCheck size={12} aria-hidden="true" />
                        ) : (
                          <LoaderCircle size={12} aria-hidden="true" className="animate-spin" />
                        )}
                        {p.status === 'done'
                          ? t('envx.exec.migDone')
                          : t('envx.exec.migRunning', { step: p.step, steps: p.steps })}
                      </span>
                    )}
                    {!p && phase === 'running' && (
                      <CircleDashed size={12} aria-hidden="true" className="text-text-3" />
                    )}
                  </li>
                );
              })}
            </ol>
            {kind === 'rollback' && <p className="hint">{t('envx.exec.rollbackNoRisk')}</p>}
            {kind === 'execute' && migrations.some((v) => v.nonTransactional) && (
              <p className="hint">{t('envx.nonTx')}</p>
            )}
          </>
        )}

        {phase === 'confirm' && <DryRunPanel dry={dry} onRetry={() => setDryTick((n) => n + 1)} />}

        {phase === 'confirm' && isRequest && (
          <div className="space-y-2">
            <p className="hint">{t('req.dialog.intro')}</p>
            <div className="field">
              <label htmlFor={reasonId} className="label">
                {t('req.dialog.reason')}
              </label>
              <textarea
                id={reasonId}
                className="input min-h-[64px]"
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {dry.state === 'done' && !dry.res.ok && (
              <p className="hint" role="note">
                {t('req.dialog.dryFailed')}
              </p>
            )}
            {submitError && (
              <Banner kind="danger" role="alert">
                {submitError}
              </Banner>
            )}
          </div>
        )}

        {phase === 'confirm' && isEmergency && (
          <div className="space-y-2">
            <Banner kind="warn" title={t('req.emergency.warnTitle')}>
              {t('req.emergency.warnBody')}
            </Banner>
            <div className="field">
              <label htmlFor={reasonId} className="label">
                {t('req.emergency.reason')}
              </label>
              <textarea
                id={reasonId}
                className="input min-h-[64px]"
                maxLength={2000}
                required
                aria-required="true"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <label htmlFor={ackId} className="flex items-start gap-2 text-sm">
              <input id={ackId} type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t('req.emergency.ack')}
            </label>
          </div>
        )}

        {mustType && phase === 'confirm' && (
          <div className="field">
            <label htmlFor={inputId} className="label">
              {t('envx.exec.typeName', { name: envName })}
            </label>
            <input
              id={inputId}
              className="input font-mono"
              aria-label={t('envx.exec.typeAria')}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void start();
                }
              }}
            />
            <p id={`${inputId}-hint`} className="hint">
              {t('envx.exec.typeHint')}
            </p>
          </div>
        )}

        {phase !== 'confirm' && (
          <div role="status" className="space-y-1 text-sm text-text-2" aria-live="polite">
            {phase === 'running' && stage && (
              <p className="m-0 inline-flex items-center gap-1.5">
                <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
                {t(`envx.exec.stage.${stage}`)}
              </p>
            )}
            {baseline && (
              <p className="m-0">
                {baseline.status === 'done' ? t('envx.exec.baselineDone') : t('envx.exec.baselineRunning')}
              </p>
            )}
            {rows.length > 0 && phase === 'running' && (
              <p className="m-0 text-xs text-text-3">{t('envx.exec.planned', { count: rows.length })}</p>
            )}
            {phase === 'done' && (
              <Banner kind="ok" title={t('envx.exec.okTitle')}>
                {result?.current
                  ? t('envx.exec.okCurrent', { number: result.current.number, ran: result.ran ?? 0 })
                  : t('envx.exec.okNothing')}
              </Banner>
            )}
          </div>
        )}

        {phase === 'failed' && error && (
          <div className="space-y-2">
            <Banner kind="danger" title={t('envx.exec.failedTitle')} role="alert">
              {error.message}
            </Banner>
            {/* 读回校验失败且目标库已被部分改动：续跑解决不了，要人工修正；事务整体回滚的读回失败（partial 为 false）库没动 */}
            {details?.needsManual || (error.code === 'readback_mismatch' && details?.partial) ? (
              <Banner kind="danger">{t('envx.exec.manual')}</Banner>
            ) : (
              details?.partial && <Banner kind="warn">{t('envx.exec.partial')}</Banner>
            )}
            {details?.step !== undefined && (
              <p className="hint">{t('envx.exec.failedStep', { step: details.step })}</p>
            )}
            {(error.code === 'drift' ||
              error.code === 'first_run_drift' ||
              error.code === 'readback_mismatch') &&
              details?.diff && (
                <div className="space-y-1.5">
                  <h3 className="section-title">{t('envx.drift.diffTitle')}</h3>
                  <DiffList items={details.diff} total={details.diffTotal} />
                </div>
              )}
            {details?.problems && details.problems.length > 0 && (
              <ul className="m-0 list-disc pl-5 text-xs text-text-2">
                {details.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {error.code === 'unverified' && <p className="hint">{t('envx.exec.unverifiedHint')}</p>}
          </div>
        )}
      </div>
    </Modal>
  );
};
