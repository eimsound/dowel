// 粘贴结果说明：有改名、跳过或附注时，在画布左下方显示一个常驻（不自动消失）的提示面板，
// 让“哪些外键没接上、哪些对象被改名”在通知消失后仍可查看（modern-web-guidance：persistent-toast-notifications）。
import type { PasteNote, PasteReport as Report, PasteSkip } from '@dowel/core';
import type { TFunction } from 'i18next';
import { CircleAlert, CircleCheck, History, X } from 'lucide-react';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from './ui.tsx';

export interface PasteSummary {
  /** 'tables'：新建了 count 张表；'items'：往 table 里粘贴了 count 项 */
  kind: 'tables' | 'items';
  count: number;
  table: string | null;
  report: Report;
}

export const hasDetails = (r: Report) => r.renamed.length + r.skipped.length + r.notes.length > 0;

/** 结果标题：粘贴了几张表 / 往哪张表粘贴了几项；一项都没粘贴时单独措辞 */
export const summaryTitle = (t: TFunction, s: PasteSummary) =>
  s.kind === 'tables'
    ? s.count
      ? t('clip.report.pastedTables', { count: s.count })
      : t('clip.report.nonePastedTables')
    : s.count
      ? t('clip.report.pastedItems', { count: s.count, table: s.table ?? '' })
      : t('clip.report.nonePastedItems', { table: s.table ?? '' });

/** 结果计数行：改名 / 跳过 / 说明各几项 */
export const summaryCounts = (t: TFunction, r: Report) =>
  [
    r.renamed.length ? t('clip.report.renamedCount', { count: r.renamed.length }) : null,
    r.skipped.length ? t('clip.report.skippedCount', { count: r.skipped.length }) : null,
    r.notes.length ? t('clip.report.notesCount', { count: r.notes.length }) : null,
  ]
    .filter(Boolean)
    .join(t('clip.report.sep'));

/** 交给读屏播报的一句话（标题 + 计数） */
export const summaryText = (t: TFunction, s: PasteSummary) =>
  [summaryTitle(t, s), summaryCounts(t, s.report)].filter(Boolean).join(t('clip.report.sep'));

export const PasteReportPanel = ({
  summary,
  onClose,
  onOpenHistory,
}: {
  summary: PasteSummary;
  onClose: () => void;
  onOpenHistory: () => void;
}) => {
  const { t } = useTranslation();
  const headingId = useId();
  const { report } = summary;
  const title = summaryTitle(t, summary);
  const skipped = report.skipped.length;
  const Icon = skipped ? CircleAlert : CircleCheck;

  const skipText = (s: PasteSkip) =>
    t(`clip.reason.${s.reason}`, { name: s.name, table: s.table ?? '', detail: s.detail ?? '' });
  const noteText = (n: PasteNote) => {
    switch (n.code) {
      case 'schemaFallback':
        return t('clip.note.schemaFallback', { from: n.from, to: n.to, count: n.tables });
      case 'reusedType':
        return t(n.valuesDiffer ? 'clip.note.reusedEnumDiffers' : `clip.note.reused.${n.kind}`, {
          name: n.name,
        });
      case 'createdType':
        return t(`clip.note.created.${n.kind}`, { name: n.name });
      case 'opaqueSkipped':
        return t('clip.note.opaqueSkipped', { count: n.count });
      case 'partitionObjectsSkipped':
        return t('clip.note.partitionObjectsSkipped', { count: n.count });
      case 'defaultCleared':
        return t('clip.note.defaultCleared', { table: n.table, column: n.column });
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="pointer-events-auto max-h-[min(360px,50vh)] w-[min(420px,100%)] overflow-auto rounded-md border border-border bg-surface text-sm shadow-[var(--shadow-pop)]"
      data-testid="paste-report"
    >
      <div className="sticky top-0 flex items-start gap-2 border-b border-border bg-surface px-3 py-2">
        <Icon
          size={16}
          aria-hidden="true"
          className={`mt-0.5 shrink-0 ${skipped ? 'text-warn' : 'text-ok'}`}
        />
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="m-0 text-sm font-semibold">
            {title}
          </h2>
          <p className="m-0 text-xs text-text-2">{summaryCounts(t, report)}</p>
        </div>
        <IconButton label={t('clip.report.dismiss')} size="sm" data-dismiss="" onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="space-y-2 px-3 py-2">
        {skipped > 0 && (
          <details open>
            <summary className="cursor-pointer text-xs font-semibold text-text-2">
              {t('clip.report.skipped', { count: skipped })}
            </summary>
            <ul className="m-0 mt-1 list-disc space-y-1 pl-5 text-xs">
              {report.skipped.map((s, i) => (
                <li key={i}>{skipText(s)}</li>
              ))}
            </ul>
          </details>
        )}
        {report.renamed.length > 0 && (
          <details open={report.renamed.length <= 6}>
            <summary className="cursor-pointer text-xs font-semibold text-text-2">
              {t('clip.report.renamed', { count: report.renamed.length })}
            </summary>
            <ul className="m-0 mt-1 list-none space-y-1 p-0 text-xs">
              {report.renamed.map((r, i) => (
                <li key={i}>
                  {t(`clip.kind.${r.kind}`)}{' '}
                  <code className="font-mono">
                    {r.table && r.kind !== 'table' ? `${r.table}.${r.from}` : r.from}
                  </code>{' '}
                  → <code className="font-mono">{r.to}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
        {report.notes.length > 0 && (
          <details open>
            <summary className="cursor-pointer text-xs font-semibold text-text-2">
              {t('clip.report.notes', { count: report.notes.length })}
            </summary>
            <ul className="m-0 mt-1 list-disc space-y-1 pl-5 text-xs">
              {report.notes.map((n, i) => (
                <li key={i}>{noteText(n)}</li>
              ))}
            </ul>
          </details>
        )}
        {summary.count > 0 && (
          <div className="flex justify-end">
            <button type="button" className="btn ghost sm" onClick={onOpenHistory}>
              <History size={14} aria-hidden="true" />
              {t('hist.open')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
