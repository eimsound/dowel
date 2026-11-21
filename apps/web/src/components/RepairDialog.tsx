// 放弃线上的修改（ADR 0004 的出口二）：显示修复脚本 plan(线上结构, 当前版本的模型)，可复制，附风险提示。
// **Dowel 不代为执行**：用户自己在目标库上执行，然后点“重新检查漂移”。模型表达不了的差异单独列为“需要手工处理”。
import type { RepairScript } from '@dowel/api';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { DiffList } from './ExecDialog.tsx';
import { Modal } from './Modal.tsx';
import { useToast } from './Toasts.tsx';
import { Banner } from './ui.tsx';

export const RepairDialog = ({
  pid,
  eid,
  onClose,
  onRecheck,
  rechecking,
}: {
  pid: string;
  eid: string;
  onClose: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) => {
  const { t } = useTranslation();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['repair-script', pid, eid],
    queryFn: () => api<RepairScript>('GET', `/api/projects/${pid}/environments/${eid}/repair-script`),
    gcTime: 0,
  });
  const r = q.data;
  const copy = async () => {
    if (!r?.script) return;
    await navigator.clipboard?.writeText(r.script).catch(() => {});
    toast(t('dr.repairCopied'));
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('dr.repairTitle')}
      footer={
        <>
          <button type="button" className="btn" disabled={!r?.script} onClick={() => void copy()}>
            <Copy size={16} aria-hidden="true" />
            {t('dr.repairCopy')}
          </button>
          <span className="flex-1" />
          <button type="button" className="btn" onClick={onClose}>
            {t('dlg.close')}
          </button>
          <button
            type="button"
            className="btn primary"
            aria-disabled={rechecking || undefined}
            aria-busy={rechecking || undefined}
            onClick={() => !rechecking && onRecheck()}
          >
            {t('dr.repairRecheck')}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {q.error && (
          <Banner kind="danger" role="alert">
            {q.error.message}
          </Banner>
        )}
        {r && (
          <>
            <p className="m-0 text-text-2">{t('dr.repairIntro', { number: r.versionNumber ?? '?' })}</p>
            {r.risks.drops > 0 && (
              <Banner kind="warn" role="status">
                {t('dr.repairDrops', { count: r.risks.drops })}
              </Banner>
            )}
            {r.risks.rebuilds > 0 && (
              <Banner kind="warn" role="status">
                {t('dr.repairRebuilds', { count: r.risks.rebuilds })}
              </Banner>
            )}
            {r.risks.constraints > 0 && (
              <Banner kind="warn" role="status">
                {t('dr.repairConstraints', { count: r.risks.constraints })}
              </Banner>
            )}
            {r.risks.rewrites > 0 && (
              <Banner kind="warn" role="status">
                {t('dr.repairRewrites', { count: r.risks.rewrites })}
              </Banner>
            )}
            {r.truncated && (
              <Banner kind="warn" role="status">
                {t('dr.repairTruncated')}
              </Banner>
            )}
            {r.script ? (
              <section
                aria-label={t('dr.repairTitle')}
                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 可滚动的代码区需要能用键盘滚动
                tabIndex={0}
                className="max-h-80 overflow-auto rounded-sm border border-border bg-code-bg p-2"
              >
                <pre className="m-0 font-mono text-xs whitespace-pre-wrap" data-testid="repair-script">
                  {r.script}
                </pre>
              </section>
            ) : (
              <p className="hint m-0">{t('dr.repairNone')}</p>
            )}
            {r.manual.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="section-title">{t('dr.repairManual')}</h3>
                <DiffList items={r.manual} />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
