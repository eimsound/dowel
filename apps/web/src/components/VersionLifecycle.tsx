// 链尾版本作废 / 取消作废 / 应用到画布（ADR 0013）：版本详情用的三个对话框。
// - 作废：作废从某个版本到活跃链头的整段（版本和迁移记录都保留，版本号不重用），默认把工作副本回退到这一段的父版本；
// - 取消作废：还没有基于父版本发布更新的版本时，把 (活跃链头, 全局最大编号] 这条已作废路径恢复为活跃主链；
// - 应用到画布：任意版本（含已作废版本）的模型整体替换工作副本，作为画布修改历史里的一条新记录（复用画布历史的差异确认）。
// 权限分级：涉及的版本都没在任何环境执行过 = 项目编辑者；任一执行过 = 项目管理员（服务端再校验一次）。
// 结果和错误显示在对话框里（模态框打开时通知会被遮住）；工作副本没能回退 / 恢复时对话框保留，显示原因。
import type {
  CanvasHistoryConflict,
  CanvasHistoryList,
  ModelUpdate,
  VersionCanvasDiff,
  VersionInfo,
  VersionRetireResult,
  VersionUnretireResult,
} from '@dowel/api';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { invalidateRequests } from '../requests.ts';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
import { useToast } from './Toasts.tsx';
import { Banner } from './ui.tsx';
import { useVersionName, VersionNumber } from './VersionStatus.tsx';

type Role = 'viewer' | 'editor' | 'admin';

/** 活跃主链（按编号升序）：未作废的版本 */
export const activeChain = (versions: VersionInfo[]): VersionInfo[] =>
  versions.filter((v) => v.retiredAt === null).sort((a, b) => a.number - b.number);

/** 作废从 from 到活跃链头的整段（编号升序）；from 不在活跃主链上或是第一个版本时为空 */
export const retireSpan = (versions: VersionInfo[], from: VersionInfo): VersionInfo[] => {
  const chain = activeChain(versions);
  const i = chain.findIndex((v) => v.id === from.id);
  return i <= 0 ? [] : chain.slice(i);
};

/** 取消作废会恢复的整段：服务端标了 unretirable 的那条路径 (活跃链头, 全局最大编号]（编号升序） */
export const unretireSpan = (versions: VersionInfo[]): VersionInfo[] =>
  versions.filter((v) => v.unretirable).sort((a, b) => a.number - b.number);

/** 这一段需要的项目角色：任一执行过 = 管理员，否则编辑者 */
export const canManageSpan = (role: Role, span: VersionInfo[]) =>
  role === 'admin' || (role === 'editor' && !span.some((v) => v.executed));

/** 版本范围：单个 `v5`，多个 `v4～v6`（中文）/ `v4–v6`（英文） */
export const useRangeLabel = () => {
  const { t } = useTranslation();
  return (span: Pick<VersionInfo, 'number'>[]) =>
    span.length === 1
      ? `v${span[0]!.number}`
      : t('vl.range', { from: span[0]!.number, to: span.at(-1)!.number });
};

/** 当前工作副本的 seq（回退 / 恢复工作副本时做乐观并发） */
const useWorkingSeq = (pid: string, enabled: boolean) =>
  useQuery({
    queryKey: ['history-head', pid],
    queryFn: () => api<CanvasHistoryList>('GET', `/api/projects/${pid}/history?limit=1&grouped=0`),
    enabled,
    staleTime: 0,
  });

/** 作废会让执行申请失效、改变环境里的版本状态，工作副本可能被回退（画布修改历史、迁移预览、DDL） */
const invalidateAfter = (qc: QueryClient, pid: string) => {
  for (const k of [
    'versions',
    'version',
    'published-tables',
    'envs',
    'env-status',
    'requests',
    'activity',
    'migration',
    'ddl',
    'canvas-history',
    'history-head',
  ])
    void qc.invalidateQueries({ queryKey: [k, pid] });
  void invalidateRequests(qc);
};

const SpanList = ({ span, label }: { span: VersionInfo[]; label: string }) => {
  const { t } = useTranslation();
  const versionName = useVersionName();
  return (
    <ul className="m-0 list-none space-y-1 p-0" aria-label={label}>
      {[...span].reverse().map((v) => (
        <li key={v.id} className="flex items-center gap-2 text-sm">
          <VersionNumber number={v.number} />
          <span className="min-w-0 flex-1 truncate font-mono">{versionName(v)}</span>
          {v.executed && <span className="chip">{t('vl.executed')}</span>}
        </li>
      ))}
    </ul>
  );
};

/** 409 冲突（warn）和其他错误（danger）分开显示（pitfalls #30） */
const ErrorBanner = ({ error, conflict }: { error: Error | null; conflict?: string }) => {
  if (!error) return null;
  if (error instanceof ApiError && error.status === 409)
    return (
      <Banner kind="warn" role="alert">
        {conflict ?? error.message}
      </Banner>
    );
  return (
    <Banner kind="danger" role="alert">
      {error.message}
    </Banner>
  );
};

export const RetireDialog = ({
  pid,
  versions,
  from,
  role,
  onClose,
}: {
  pid: string;
  versions: VersionInfo[];
  from: VersionInfo;
  role: Role;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const rangeLabel = useRangeLabel();
  const warnId = useId();
  const deniedId = useId();
  const [keep, setKeep] = useState(false);
  const [changed, setChanged] = useState<VersionRetireResult | null>(null);
  const chain = activeChain(versions);
  const span = retireSpan(versions, from);
  const head = chain.at(-1);
  const parent = chain[chain.findIndex((v) => v.id === from.id) - 1];
  const maxNumber = Math.max(...versions.map((v) => v.number));
  const executed = span.filter((v) => v.executed);
  const allowed = canManageSpan(role, span);
  const seq = useWorkingSeq(pid, !keep);
  const retire = useMutation({
    mutationFn: () =>
      api<VersionRetireResult>('POST', `/api/projects/${pid}/versions/${from.id}/retire`, {
        head: head!.id,
        keepWorkingCopy: keep,
        ...(!keep && seq.data ? { workingSeq: seq.data.currentSeq } : {}),
      }),
    onSuccess: (r) => {
      invalidateAfter(qc, pid);
      const args = { range: rangeLabel(r.retired), head: r.head.number, count: r.invalidatedRequests };
      toast(t(r.invalidatedRequests ? 'vl.retiredWithRequests' : 'vl.retired', args));
      // 工作副本在确认期间被别人改过或同步失败：作废已经完成，但没有回退；留在对话框里说明
      if (r.workingCopy === 'changed' || r.workingCopy === 'failed') setChanged(r);
      else onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) invalidateAfter(qc, pid);
    },
  });
  // 范围已经不成立（别人刚作废了它、或这是第一个版本）：不显示确认
  const stale = !changed && (!span.length || !parent || !head);
  const confirmable = !stale && allowed && !retire.isPending && (keep || !seq.isLoading) && !changed;
  const describedBy = [executed.length ? warnId : '', allowed ? '' : deniedId].filter(Boolean).join(' ');
  return (
    <Modal
      open
      onClose={onClose}
      pending={retire.isPending}
      size="md"
      title={
        changed
          ? t('vl.retireTitle', { range: rangeLabel(changed.retired) })
          : stale
            ? t('vl.retireTitleStale')
            : t('vl.retireTitle', { range: rangeLabel(span) })
      }
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={retire.isPending}>
            {changed || stale ? t('dlg.close') : t('dlg.cancel')}
          </button>
          {!changed && !stale && (
            <button
              type="button"
              className="btn danger solid"
              aria-disabled={!confirmable || undefined}
              aria-busy={retire.isPending || undefined}
              aria-describedby={describedBy || undefined}
              onClick={() => confirmable && retire.mutate()}
            >
              {span.length === 1
                ? t('vl.retireConfirmOne', { number: span[0]!.number })
                : t('vl.retireConfirm', { count: span.length })}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {changed ? (
          <Banner kind="warn" role="status" title={t('vl.retireDoneTitle')}>
            {changed.workingCopy === 'failed' ? t('vl.workingFailedRetire') : t('vl.workingChangedRetire')}
          </Banner>
        ) : stale || !parent ? (
          <Banner kind="info" role="status">
            {t('vl.retireStale')}
          </Banner>
        ) : (
          <>
            <ErrorBanner
              error={retire.error}
              conflict={
                retire.error instanceof ApiError && retire.error.code === 'head_changed'
                  ? t('vl.headChanged')
                  : undefined
              }
            />
            <SpanList span={span} label={t('vl.spanLabel')} />
            <Banner kind="info">{t('vl.retireKeeps', { next: maxNumber + 1, parent: parent.number })}</Banner>
            {executed.length > 0 && (
              <Banner kind="warn" id={warnId} title={t('vl.retireExecutedTitle')}>
                {executed.length === 1
                  ? t('vl.retireExecutedOne', { number: executed[0]!.number })
                  : t('vl.retireExecuted', {
                      list: executed.map((v) => `v${v.number}`).join(t('vl.listSep')),
                    })}
              </Banner>
            )}
            {!allowed && (
              <Banner kind="danger" role="status" id={deniedId}>
                {t('vl.needsAdminRetire')}
              </Banner>
            )}
            <p className="m-0 text-sm text-text-2">{t('vl.retireRequests')}</p>
            <fieldset className="m-0 space-y-1.5 border-0 p-0">
              <legend className="mb-1 p-0 text-sm font-medium">{t('vl.workingCopy')}</legend>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="retire-working-copy"
                  checked={!keep}
                  onChange={() => setKeep(false)}
                  className="mt-0.5"
                />
                <span>{t('vl.revertTo', { parent: parent.number })}</span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="retire-working-copy"
                  checked={keep}
                  onChange={() => setKeep(true)}
                  className="mt-0.5"
                />
                <span>{t('vl.keepWorking')}</span>
              </label>
            </fieldset>
          </>
        )}
      </div>
    </Modal>
  );
};

export const UnretireDialog = ({
  pid,
  versions,
  role,
  onClose,
}: {
  pid: string;
  versions: VersionInfo[];
  role: Role;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const rangeLabel = useRangeLabel();
  const deniedId = useId();
  const [restore, setRestore] = useState(false);
  const [changed, setChanged] = useState<VersionUnretireResult | null>(null);
  const span = unretireSpan(versions);
  const first = span[0];
  const last = span.at(-1);
  const allowed = canManageSpan(role, span);
  const seq = useWorkingSeq(pid, restore);
  const unretire = useMutation({
    mutationFn: () =>
      api<VersionUnretireResult>('POST', `/api/projects/${pid}/versions/${first!.id}/unretire`, {
        syncWorkingCopy: restore,
        ...(restore && seq.data ? { workingSeq: seq.data.currentSeq } : {}),
      }),
    onSuccess: (r) => {
      invalidateAfter(qc, pid);
      toast(t('vl.unretired', { range: rangeLabel(r.restored), head: r.head.number }));
      if (r.workingCopy === 'changed' || r.workingCopy === 'failed') setChanged(r);
      else onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) invalidateAfter(qc, pid);
    },
  });
  const stale = !changed && (!first || !last);
  const confirmable = !stale && allowed && !unretire.isPending && (!restore || !seq.isLoading) && !changed;
  return (
    <Modal
      open
      onClose={onClose}
      pending={unretire.isPending}
      size="md"
      title={
        changed
          ? t('vl.unretireTitle', { range: rangeLabel(changed.restored) })
          : stale
            ? t('vl.unretireTitleStale')
            : t('vl.unretireTitle', { range: rangeLabel(span) })
      }
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={unretire.isPending}>
            {changed || stale ? t('dlg.close') : t('dlg.cancel')}
          </button>
          {!changed && !stale && (
            <button
              type="button"
              className="btn primary"
              aria-disabled={!confirmable || undefined}
              aria-busy={unretire.isPending || undefined}
              aria-describedby={allowed ? undefined : deniedId}
              onClick={() => confirmable && unretire.mutate()}
            >
              {t('vl.unretireConfirm')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {changed ? (
          <Banner kind="warn" role="status" title={t('vl.unretireDoneTitle')}>
            {changed.workingCopy === 'failed'
              ? t('vl.workingFailedUnretire')
              : t('vl.workingChangedUnretire')}
          </Banner>
        ) : stale || !last ? (
          <Banner kind="info" role="status">
            {t('vl.notUnretirable')}
          </Banner>
        ) : (
          <>
            <ErrorBanner error={unretire.error} />
            <SpanList span={span} label={t('vl.spanLabel')} />
            <Banner kind="info">{t('vl.unretireHint')}</Banner>
            {!allowed && (
              <Banner kind="danger" role="status" id={deniedId}>
                {t('vl.needsAdminUnretire')}
              </Banner>
            )}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={restore}
                onChange={(e) => setRestore(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('vl.restoreWorking', { head: last.number })}</span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
};

export const ApplyToCanvasDialog = ({
  pid,
  version,
  onClose,
}: {
  pid: string;
  version: Pick<VersionInfo, 'id' | 'number' | 'name'>;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const [conflict, setConflict] = useState<VersionCanvasDiff | null>(null);
  const preview = useQuery({
    queryKey: ['version-canvas-diff', pid, version.id],
    queryFn: () => api<VersionCanvasDiff>('GET', `/api/projects/${pid}/versions/${version.id}/canvas-diff`),
    staleTime: 0,
    gcTime: 0,
  });
  const data = conflict ?? preview.data;
  const apply = useMutation({
    mutationFn: () =>
      api<ModelUpdate>('POST', `/api/projects/${pid}/versions/${version.id}/apply`, {
        workingSeq: data!.currentSeq,
      }),
    onSuccess: () => {
      invalidateAfter(qc, pid);
      toast(t('vl.applied', { number: version.number }));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409 && e.code === 'working_changed') {
        const b = e.body as CanvasHistoryConflict;
        setConflict({ diffToCurrent: b.diffToCurrent, currentSeq: b.currentSeq });
      }
    },
  });
  const raced = apply.error instanceof ApiError && apply.error.code === 'working_changed';
  const total = data?.diffToCurrent.total ?? 0;
  const confirmable = !!data && total > 0 && !apply.isPending;
  return (
    <Modal
      open
      onClose={onClose}
      pending={apply.isPending}
      size="lg"
      title={t('vl.applyTitle', { number: version.number })}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" autoFocus onClick={onClose} disabled={apply.isPending}>
            {t('dlg.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            aria-disabled={!confirmable || undefined}
            aria-busy={apply.isPending || undefined}
            onClick={() => confirmable && apply.mutate()}
          >
            {t('vl.applyConfirm')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {preview.isLoading && (
          <p role="status" className="m-0 inline-flex items-center gap-1.5 text-sm text-text-2">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
            {t('vl.applyLoading')}
          </p>
        )}
        {preview.error && (
          <Banner
            kind="danger"
            role="alert"
            action={
              <button type="button" className="btn" onClick={() => void preview.refetch()}>
                {t('tk.dry.retry')}
              </button>
            }
          >
            {preview.error.message}
          </Banner>
        )}
        {raced ? (
          <Banner kind="warn" role="alert">
            {t('vl.applyRaced')}
          </Banner>
        ) : (
          <ErrorBanner error={apply.error} />
        )}
        {data &&
          (total === 0 ? (
            <Banner kind="info" role="status">
              {t('vl.applySame', { number: version.number })}
            </Banner>
          ) : (
            <>
              <Banner kind="warn">{t('vl.applyWarn', { number: version.number })}</Banner>
              <h3 className="section-title m-0">
                {t('vl.applyDiff', { number: version.number })} <span className="count">{total}</span>
              </h3>
              <DiffList items={data.diffToCurrent.items} total={total} />
            </>
          ))}
      </div>
    </Modal>
  );
};
