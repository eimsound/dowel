// 登录、强制改密、接受邀请、重置密码共用的页面外壳：右上角语言/配色切换器 + 居中的窄卡片 + 实例名称。
// 样式遵循 DESIGN.md（13px 正文、28px 控件、语义 token）。
import type { Me } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { setLang } from '../i18n.ts';
import { setScheme, useScheme } from '../theme.ts';
import { Logo } from './Shell.tsx';
import { Menu } from './ui.tsx';

export const AuthShell = ({
  name,
  tagline,
  title,
  children,
}: {
  name: string;
  tagline: string;
  title: string;
  children: ReactNode;
}) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === 'en' ? 'en' : 'zh';
  const scheme = useScheme();
  const SchemeIcon = scheme === 'light' ? Sun : scheme === 'dark' ? Moon : Monitor;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-11 flex-none items-center justify-end gap-1 px-4">
        <Menu
          label={t('acc.language')}
          trigger={<Languages size={16} aria-hidden="true" />}
          align="end"
          items={(['zh', 'en'] as const).map((lng) => ({
            label: lng === 'zh' ? '中文' : 'English',
            checked: lang === lng,
            onSelect: () => setLang(lng),
          }))}
        />
        <Menu
          label={t('acc.scheme')}
          trigger={<SchemeIcon size={16} aria-hidden="true" />}
          align="end"
          items={(
            [
              { value: 'auto', icon: <Monitor size={16} aria-hidden="true" /> },
              { value: 'light', icon: <Sun size={16} aria-hidden="true" /> },
              { value: 'dark', icon: <Moon size={16} aria-hidden="true" /> },
            ] as const
          ).map(({ value, icon }) => ({
            label: t(`acc.schemeOption.${value}`),
            icon,
            checked: scheme === value,
            onSelect: () => setScheme(value),
          }))}
        />
      </div>
      <main className="flex flex-1 items-start justify-center px-4 pt-[max(24px,calc(14vh-44px))] pb-10">
        <div className="w-[min(360px,100%)] space-y-6">
          <header className="flex flex-col items-center gap-2 text-center">
            <Logo />
            <h1 className="text-[length:var(--fs-headline)] font-semibold tracking-tight">{name}</h1>
            <p className="text-sm text-text-2">{tagline}</p>
          </header>
          <div className="space-y-3.5 rounded-lg border border-border bg-panel p-6">
            <h2 className="text-[length:var(--fs-lg)] font-semibold">{title}</h2>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
};

/** 登录 / 初始化 / 接受邀请成功后写入当前用户，后面的页面就不用再请求一次 */
export const useSetMe = () => {
  const qc = useQueryClient();
  return (me: Me) => qc.setQueryData(['me'], me);
};
