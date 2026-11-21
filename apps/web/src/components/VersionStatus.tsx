// 版本的验证状态标记和验证报告：版本列表、详情、发布对话框共用。
// 术语见 GLOSSARY：版本、迁移、发布、影子库。
import type { StoredVerifyReport, VerifyResponse, VersionInfo } from '@dowel/api';
import { BASELINE_VERSION_NAME } from '@dowel/api';
import { CircleCheck, CircleHelp, DatabaseBackup, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Banner } from './ui.tsx';

/** 版本在界面上的名字：v0 基线的名字本身已经带着 v0，这里换成“基线”，避免和 v0 标记重复 */
export const useVersionName = () => {
  const { t } = useTranslation();
  return (v: Pick<VersionInfo, 'name' | 'number'>) =>
    v.number === 0 && v.name === BASELINE_VERSION_NAME ? t('versions.baseline') : v.name;
};

/** `v3` 这样的序号标记 */
export const VersionNumber = ({ number }: { number: number }) => (
  <span className="chip shrink-0 font-mono">v{number}</span>
);

/** 已验证 / 未验证 / 人工编辑：脚本被人工改过时两个标记都显示（改过的脚本可能已重新验证） */
export const VersionBadges = ({
  v,
}: {
  v: Pick<VersionInfo, 'verifiedAt' | 'edited'> & { restoredAt?: string | null };
}) => {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-1.5">
      {v.verifiedAt ? (
        <span className="risk low inline-flex items-center gap-1">
          <CircleCheck size={12} aria-hidden="true" />
          {t('versions.verified')}
        </span>
      ) : (
        <span className="risk medium inline-flex items-center gap-1">
          <CircleHelp size={12} aria-hidden="true" />
          {t('versions.unverified')}
        </span>
      )}
      {v.edited && (
        <span className="risk low inline-flex items-center gap-1">
          <Pencil size={12} aria-hidden="true" />
          {t('versions.edited')}
        </span>
      )}
      {v.restoredAt && (
        <span className="chip inline-flex items-center gap-1" title={t('tk.restoredHint')}>
          <DatabaseBackup size={12} aria-hidden="true" />
          {t('tk.restored')}
        </span>
      )}
    </span>
  );
};

type Report = Pick<StoredVerifyReport, 'ok' | 'upDiff' | 'downDiff' | 'error' | 'risks' | 'riskError'> & {
  shadow?: string;
};

/**
 * 风险分析没有完成时，在风险列表的位置如实说明（不能让用户以为“没有风险”）。
 * 风险分析是附带信息，不影响验证结论，所以是提示（warn），不是失败。
 * riskError 只是原因本身，“风险分析没有完成”由横幅标题提供，正文不重复。
 */
export const RiskNote = ({ report }: { report: Pick<Report, 'riskError'> | null | undefined }) => {
  const { t } = useTranslation();
  return report?.riskError ? (
    <Banner kind="warn" title={t('dlg.riskFailedTitle')} role="status">
      {report.riskError}
    </Banner>
  ) : null;
};

/** 验证报告：通过（可能带高风险提示）或失败（出错的步骤和原因、结构差异），role=status */
export const VerifyBanner = ({ report }: { report: Report | VerifyResponse }) => {
  const { t } = useTranslation();
  const highs = report.risks.filter((x) => x.level === 'high').length;
  const diffs = [...report.upDiff, ...report.downDiff];
  const shadow = report.shadow ? (
    <span className="text-text-2"> {t('dlg.usedShadow', { s: report.shadow })}</span>
  ) : null;
  if (report.ok)
    return (
      <Banner kind={highs ? 'warn' : 'ok'} title={t('dlg.verifyOkTitle')} role="status">
        {t('dlg.verifyOk')}
        {highs > 0 && ` ${t('dlg.highRisks', { count: highs })}`}
        {shadow}
      </Banner>
    );
  return (
    <Banner kind="danger" title={t('dlg.verifyFail')} role="status">
      {shadow}
      {report.error && (
        <pre className="mt-1.5 mb-0 font-mono text-xs whitespace-pre-wrap">
          {report.error.step?.sql}
          {'\n'}
          {report.error.message}
        </pre>
      )}
      {diffs.length > 0 && (
        <pre className="mt-1.5 mb-0 font-mono text-xs whitespace-pre-wrap">{diffs.join('\n')}</pre>
      )}
    </Banner>
  );
};
