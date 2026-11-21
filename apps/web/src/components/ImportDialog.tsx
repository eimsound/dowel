// 保留线上的修改（ADR 0004 的出口一）：把环境的线上结构导入（覆盖）工作副本。
// 打开时先预览：覆盖会带来的差异，以及三种只警告、不拦截的情况（环境落后于链头 / 半途失败的迁移 / 工作副本有未发布的修改）。
import type { ModelUpdate, PullPreview } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError, api } from '../api.ts';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
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
      const r = await api<ModelUpdate>('POST', base, {
        fingerprint: preview.fingerprint,
        workingSeq: preview.workingSeq,
      });
      void qc.invalidateQueries({ queryKey: ['project', pid] });
      void qc.invalidateQueries({ queryKey: ['envs', pid] });
      void qc.invalidateQueries({ queryKey: ['migration', pid] });
      void qc.invalidateQueries({ queryKey: ['ddl', pid] });
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
  return (
    <Modal
      open
      onClose={onClose}
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
