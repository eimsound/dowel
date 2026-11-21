// 标记为已执行的确认框（ADR 0004）：不执行任何 SQL，把环境记为已到达某个版本。
// 打开时先核对（dryRun）：线上结构必须等于目标版本的模型，不一致就列出差异、不能确认；
// 向前标记要列出被跳过的版本和它们的脚本，**必须勾选**“这些脚本的效果已经手工完成，或者不需要”才能确认；
// 生产环境还要输入环境名。
import type { EnvVersion, MarkDryRunResponse, MarkPlanInfo, MarkResult } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../api.ts';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
import { Banner, Sql } from './ui.tsx';
import { useVersionName, VersionNumber } from './VersionStatus.tsx';

export const MARK_TITLE = {
  forward: 'dr.mark.forward',
  backward: 'dr.mark.backward',
  current: 'dr.mark.stay',
} as const;
export const MARK_TIP = {
  forward: 'dr.mark.tip',
  backward: 'dr.mark.tipBackward',
  current: 'dr.mark.tipStay',
} as const;

type Check =
  | { state: 'loading' }
  | { state: 'done'; res: MarkDryRunResponse }
  | { state: 'error'; message: string };

/**
 * 按平台缓存估计的标记方向（只用来先显示按钮 / 标题；**真正的方向、跳过哪些版本、要不要确认，全以服务端预演返回的 plan 为准**）：
 * 目标就是当前版本是 current（只有上一次执行没结束时才会列出来），比当前版本旧是 backward，否则 forward。
 */
export const markDirection = (
  current: { id: string; number: number } | null,
  to: { id: string; number: number },
): 'forward' | 'backward' | 'current' =>
  current?.id === to.id ? 'current' : current && to.number < current.number ? 'backward' : 'forward';

export const MarkDialog = ({
  pid,
  eid,
  envName,
  production,
  current,
  to,
  onClose,
}: {
  pid: string;
  eid: string;
  envName: string;
  production: boolean;
  /** 当前版本（有未完成的运行时是目标库实际读到的，否则是平台缓存）：只用来在预演回来之前先显示 */
  current: { id: string; number: number } | null;
  to: EnvVersion;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const versionName = useVersionName();
  const ackId = useId();
  const typeId = useId();
  const [tick, setTick] = useState(0);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done' | 'failed'>('confirm');
  /** 提示（目标库在核对之后变了、已经刷新了预演结果）：显示在确认区 */
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<{ message: string; diff?: MarkDryRunResponse['details'] } | null>(null);
  const base = `/api/projects/${pid}/environments/${eid}/mark`;
  const reqKey = `${base}\0${to.id}\0${tick}`;
  const [checkState, setCheckState] = useState<{ key: string; val: Check } | null>(null);
  const check: Check = checkState?.key === reqKey ? checkState.val : { state: 'loading' };
  const [prevReqKey, setPrevReqKey] = useState(reqKey);
  if (reqKey !== prevReqKey) {
    setPrevReqKey(reqKey);
    // 每次重新预演都把已勾选的确认清掉：确认只对应它看到的那一份计划
    setAck(false);
  }

  // 打开（或点“重新核对”）时先核对线上结构：只读，不写任何东西
  useEffect(() => {
    let live = true;
    api<MarkDryRunResponse>('POST', base, { to: to.id, dryRun: true }).then(
      (res) => live && setCheckState({ key: reqKey, val: { state: 'done', res } }),
      (e: unknown) =>
        live &&
        setCheckState({
          key: reqKey,
          val: { state: 'error', message: e instanceof Error ? e.message : String(e) },
        }),
    );
    return () => {
      live = false;
    };
  }, [base, to.id, reqKey]);

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['envs', pid] }),
      qc.invalidateQueries({ queryKey: ['env-status', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['env-history', pid, eid] }),
      qc.invalidateQueries({ queryKey: ['versions', pid] }),
    ]);

  const plan = check.state === 'done' && check.res.ok ? check.res.plan : undefined;
  const skipped = plan?.skipped ?? [];
  // 方向和要不要确认都以预演返回的 plan 为准；预演回来之前先按缓存显示
  const direction = plan?.direction ?? markDirection(current, to);
  const needAck = skipped.length > 0;
  const canConfirm = !!plan && (!needAck || ack) && (!production || typed.trim() === envName);

  const start = async () => {
    if (!canConfirm || phase === 'running') return;
    setPhase('running');
    try {
      // 确认绑定到预演拿到的计划：锁里重新算出的计划和它不一致，服务端拒绝并附上新的计划
      await api<MarkResult>('POST', base, {
        to: to.id,
        confirm: typed,
        acknowledge: ack,
        expect: plan && {
          from: plan.from?.id ?? null,
          to: plan.to.id,
          skipped: plan.skipped.map((v) => v.id),
          fingerprint: plan.fingerprint,
        },
      });
      setPhase('done');
    } catch (e) {
      const body =
        e instanceof ApiError
          ? (e.body as { code?: string; details?: MarkDryRunResponse['details'] & { plan?: MarkPlanInfo } })
          : null;
      if (body?.code === 'plan_changed' && body.details?.plan) {
        // 目标库在核对之后变了：刷新预演结果（新的计划），清掉勾选，提示重新确认
        setCheckState({ key: reqKey, val: { state: 'done', res: { ok: true, plan: body.details.plan } } });
        setAck(false);
        setNotice(t('dr.mark.planChanged'));
        setPhase('confirm');
        return;
      }
      setError({ message: e instanceof Error ? e.message : String(e), diff: body?.details });
      setPhase('failed');
    } finally {
      void refresh();
    }
  };

  const title = t(MARK_TITLE[direction], { number: to.number });
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
          {phase !== 'done' && phase !== 'failed' && (
            <button
              type="button"
              className="btn primary"
              aria-disabled={!canConfirm || phase === 'running' || undefined}
              aria-busy={phase === 'running' || undefined}
              onClick={() => void start()}
            >
              {t('dr.mark.confirm')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <p className="hint m-0">{t(MARK_TIP[direction], { number: to.number })}</p>

        {phase === 'confirm' && notice && (
          <Banner kind="warn" role="alert">
            {notice}
          </Banner>
        )}
        {phase === 'confirm' && check.state === 'loading' && (
          <p role="status" className="m-0 inline-flex items-center gap-1.5 text-sm text-text-2">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
            {t('dr.mark.checking')}
          </p>
        )}
        {phase === 'confirm' && check.state === 'error' && (
          <Banner kind="warn" role="status">
            {check.message}
            <div className="mt-1.5">
              <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>
                {t('tk.dry.retry')}
              </button>
            </div>
          </Banner>
        )}
        {phase === 'confirm' && check.state === 'done' && !check.res.ok && (
          <div className="space-y-2" role="status">
            <Banner kind="danger" title={t('dr.mark.mismatchTitle', { number: to.number })}>
              <p className="m-0" data-testid="mark-error">
                {check.res.error}
              </p>
              {check.res.code === 'mark_mismatch' && <p className="m-0 mt-1">{t('dr.mark.mismatchBody')}</p>}
              <div className="mt-1.5">
                <button type="button" className="btn" onClick={() => setTick((n) => n + 1)}>
                  {t('tk.dry.retry')}
                </button>
              </div>
            </Banner>
            {check.res.details?.diff && (
              <DiffList items={check.res.details.diff} total={check.res.details.diffTotal} />
            )}
          </div>
        )}

        {phase === 'confirm' && plan && (
          <div className="space-y-2.5" data-testid="mark-plan">
            <Banner kind="ok" title={t('dr.mark.okTitle', { number: to.number })} role="status">
              <span className="font-mono text-xs">
                {t('dr.mark.fingerprint', { fp: plan.fingerprint.slice(0, 12) })}
              </span>
            </Banner>
            {needAck ? (
              <>
                <h3 className="section-title">{t('dr.mark.skippedTitle')}</h3>
                <p className="hint m-0">{t('dr.mark.skippedHint')}</p>
                <ul className="m-0 list-none space-y-1 p-0">
                  {skipped.map((v) => (
                    <li key={v.id} className="rounded-sm border border-border px-2 py-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <VersionNumber number={v.number} />
                        <span className="font-mono">{versionName(v)}</span>
                        <span className="text-text-2">{t('tk.dry.steps', { count: v.upSteps.length })}</span>
                      </div>
                      {v.upSteps.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-text-2">{t('tk.dry.showSteps')}</summary>
                          <ol className="m-0 mt-1 list-none space-y-1 p-0">
                            {v.upSteps.map((st, i) => (
                              <li key={i}>
                                <code className="block font-mono break-all whitespace-pre-wrap">
                                  <Sql text={st.sql} />
                                </code>
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="checks">
                  <label htmlFor={ackId}>
                    <input
                      id={ackId}
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    {t('dr.mark.ack')}
                  </label>
                </div>
                {!ack && <p className="hint m-0">{t('dr.mark.ackNeeded')}</p>}
              </>
            ) : (
              <p className="hint m-0">
                {t(direction === 'current' ? 'dr.mark.currentNote' : 'dr.mark.backwardNote')}
              </p>
            )}
          </div>
        )}

        {production && phase === 'confirm' && (
          <div className="field">
            <label htmlFor={typeId} className="label">
              {t('envx.exec.typeName', { name: envName })}
            </label>
            <input
              id={typeId}
              className="input font-mono"
              aria-label={t('envx.exec.typeAria')}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        {phase === 'done' && (
          <Banner kind="ok" role="status">
            {t('dr.mark.done', { number: to.number })}
          </Banner>
        )}
        {phase === 'failed' && error && (
          <div className="space-y-2">
            <Banner kind="danger" role="alert">
              {error.message}
            </Banner>
            {error.diff?.diff && <DiffList items={error.diff.diff} total={error.diff.diffTotal} />}
          </div>
        )}
      </div>
    </Modal>
  );
};
