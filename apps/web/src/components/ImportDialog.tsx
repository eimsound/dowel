// 保留线上的修改（ADR 0004 的出口一）：把环境的线上结构导入（覆盖）工作副本。
// 打开时先预览：覆盖会带来的差异，以及三种只警告、不拦截的情况（环境落后于链头 / 半途失败的迁移 / 工作副本有未发布的修改）。
import type { PullPreview, PullResult } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
import { NullabilityFallbackNotice } from './NullabilityFallback.tsx';
import { useToast } from './Toasts.tsx';
import { Banner } from './ui.tsx';

export const ImportDialog = ({ pid, eid, onClose }: { pid: string; eid: string; onClose: () => void }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const base = `/api/projects/${pid}/environments/${eid}/pull`;
  const [preview, setPreview] = useState<PullPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 覆盖完成、但有需要用户看的提示（SQL Server 持久化计算列因没有影子库按显式非空记录，ADR 0019）：弹窗留在完成态 */
  const [done, setDone] = useState<PullResult | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  // 进入完成态时原确认按钮已卸载：把焦点移到结果顶部，读屏从成功提示读起，Tab 再到“完成”
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  useEffect(() => {
    let live = true;
    api<PullPreview>('POST', base, { preview: true }).then(
      (r) => live && setPreview(r),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [base]);

  const confirm = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      // 带着预览时的线上结构指纹：线上结构在预览之后又变了，服务端 409 并给出新的预览
      const r = await api<PullResult>('POST', base, {
        fingerprint: preview.fingerprint,
        workingSeq: preview.workingSeq,
      });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['migration', pid] });
      void qc.invalidateQueries({ queryKey: ['ddl', pid] });
      // 影子库来源 / 基线可能变了：状态栏的规范化状态（含 shadow 配置）重查（ADR 0016）
      void qc.invalidateQueries({ queryKey: ['normalize', pid] });
      void qc.invalidateQueries({ queryKey: ['activity', pid] });
      if (r.nullabilityFallback?.columns.length) {
        // 对话框打开时不弹通知：结果与受影响的列留在弹窗里
        setDone(r);
        setBusy(false);
        return;
      }
      toast(t('dr.importDone', { count: r.objects }));
      onClose();
    } catch (e) {
      const b =
        e instanceof ApiError ? (e.body as { code?: string; preview?: PullPreview } | undefined) : undefined;
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        (b?.code === 'live_changed' || b?.code === 'working_changed') &&
        b.preview
      ) {
        // 线上结构 / 工作副本在预览之后变了：显示新的差异，让用户重新确认（没有覆盖）
        setPreview(b.preview);
        setError(t(b.code === 'working_changed' ? 'dr.importWorkingChanged' : 'dr.importChanged'));
      } else setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const w = preview?.warnings;
  if (done)
    return (
      <Modal
        open
        onClose={onClose}
        size="md"
        title={t('dr.importDoneTitle')}
        footer={
          <>
            <span className="flex-1" />
            <button type="button" className="btn primary" onClick={onClose}>
              {t('dr.importDoneClose')}
            </button>
          </>
        }
      >
        <div ref={doneRef} tabIndex={-1} className="space-y-3 text-sm">
          <Banner kind="ok" role="status">
            {t('dr.importDone', { count: done.objects })}
          </Banner>
          <NullabilityFallbackNotice columns={done.nullabilityFallback?.columns ?? []} />
        </div>
      </Modal>
    );
  return (
    <Modal
      open
      onClose={onClose}
      pending={busy}
      size="md"
      title={t('dr.importTitle')}
      footer={
        <>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.cancel')}
          </button>
          <button
            type="button"
            className="btn danger solid"
            aria-disabled={!preview || busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => void confirm()}
          >
            {t('dr.importConfirm')}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="m-0 text-text-2">{t('dr.importIntro').replaceAll('**', '')}</p>
        {error && (
          <Banner kind="danger" role="alert">
            {error}
          </Banner>
        )}
        {!preview && !error && (
          <p role="status" className="m-0 inline-flex items-center gap-1.5 text-text-2">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
            {t('dr.importReading')}
          </p>
        )}
        {preview && w && (
          <div className="space-y-2.5">
            {w.behindHead && (
              <Banner kind="warn" role="status">
                {w.behindHead.current
                  ? t('dr.importWarnBehind', {
                      current: w.behindHead.current.number,
                      head: w.behindHead.head.number,
                      next: w.behindHead.current.number + 1,
                    })
                  : t('dr.importWarnBehindNone', { head: w.behindHead.head.number })}
              </Banner>
            )}
            {w.unfinished && (
              <Banner kind="warn" role="status">
                {t('dr.importWarnUnfinished')}
              </Banner>
            )}
            {w.readbackFailure && (
              <Banner kind="warn" role="status">
                {t('dr.importWarnReadback')}
              </Banner>
            )}
            {w.workingDirty && (
              <Banner kind="warn" role="status">
                {t('dr.importWarnDirty')}
              </Banner>
            )}
            <h3 className="section-title">
              {t('dr.importDiff')}
              <span className="count">{preview.total}</span>
            </h3>
            {preview.total === 0 ? (
              <p className="hint m-0">{t('dr.importNoDiff')}</p>
            ) : (
              <DiffList items={preview.items} total={preview.total} />
            )}
            <p className="hint m-0 font-mono">
              {t('dr.importFingerprint', { fp: preview.fingerprint.slice(0, 12) })}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
};
