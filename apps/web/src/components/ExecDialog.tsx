// 执行确认对话框：列出将要执行 / 回滚的迁移和风险摘要，生产环境必须输入环境名才能确认；
// 确认后用 SSE 读进度，出错时显示原因（漂移时列出差异）。关闭时刷新环境的状态、历史和列表。
import type { DriftItem, EnvStatus, EnvVersion, ExecEvent } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../api.ts';
import { streamExec } from '../envs.ts';
import { Modal } from './Modal.tsx';
import { Banner, Sql } from './ui.tsx';
import { useVersionName, VersionNumber } from './VersionStatus.tsx';

export type ExecKind = 'execute' | 'rollback' | 'baseline';

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

export const ExecDialog = ({
  pid,
  eid,
  envName,
  production,
  status,
  kind,
  to,
  onClose,
}: {
  pid: string;
  eid: string;
  envName: string;
  production: boolean;
  status: EnvStatus;
  kind: ExecKind;
  to?: EnvVersion;
  onClose: () => void;
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
  const mustType = production;
  const canConfirm = !mustType || typed.trim() === envName;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['envs', pid] }),
      qc.invalidateQueries({ queryKey: ['env-status', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['env-history', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['versions', pid] }),
    ]);

  const start = async () => {
    if (!canConfirm || running.current) return;
    running.current = true;
    setPhase('running');
    const base = `/api/projects/${pid}/environments/${eid}`;
    const body = kind === 'baseline' ? { confirm: typed } : { to: to!.id, confirm: typed };
    let last: ExecEvent | null = null;
    try {
      await streamExec(`${base}/${kind}`, body, (e) => {
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
    }
  };

  const title =
    kind === 'baseline'
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
              className={kind === 'rollback' ? 'btn danger solid' : 'btn primary'}
              aria-disabled={!canConfirm || phase === 'running' || undefined}
              aria-describedby={mustType && !canConfirm ? `${inputId}-hint` : undefined}
              aria-busy={phase === 'running' || undefined}
              onClick={() => void start()}
            >
              {kind === 'baseline'
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
