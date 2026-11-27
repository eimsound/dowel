// 从已有 SQL Server 数据库导入 / 拉取时没有可用的影子库：列出按显式非空记录的持久化计算列（ADR 0019）。
// 不是错误（导入已经成功），所以是 warn 级别、不设 live region：成功状态由调用方的 ok 提示条播报，
// 这里的列清单不会被读屏一口气朗读。
import { useTranslation } from 'react-i18next';

import { fallbackListing } from '../nullability.ts';
import { Banner } from './ui.tsx';

export const NullabilityFallbackNotice = ({ columns }: { columns: readonly string[] }) => {
  const { t } = useTranslation();
  const l = fallbackListing(columns);
  return (
    <Banner kind="warn" title={t('nnFallback.title')}>
      <p className="m-0 mt-1">{t(l.bodyKey, { count: l.total })}</p>
      <ul className="m-0 mt-1.5 list-disc space-y-0.5 pl-5">
        {l.shown.map((c) => (
          <li key={c}>
            <code className="font-mono text-xs break-all">{c}</code>
          </li>
        ))}
      </ul>
      {l.more > 0 && (
        <p className="m-0 mt-1 text-xs text-text-2">
          {t('nnFallback.more', { count: l.more, total: l.total })}
        </p>
      )}
    </Banner>
  );
};
