// 选项卡：分段控件的外观（DESIGN.md：选择与切换）。focusgroup 提供方向键在选项卡间移动（不支持的浏览器由 polyfill 补上）。
import type { ReactNode } from 'react';
import { useId } from 'react';
import { cx } from './ui.tsx';

export const Tabs = <K extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
  floating,
}: {
  label: string;
  tabs: { key: K; title: string; icon?: ReactNode }[];
  value: K;
  onChange: (k: K) => void;
  children: (k: K) => ReactNode;
  /** 浮在内容左上角（画布） */
  floating?: boolean;
}) => {
  const base = useId();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        {...({ focusgroup: 'tablist nomemory' } as object)}
        aria-label={label}
        className={cx('seg', floating ? 'floating absolute top-2.5 left-2.5 z-10' : 'self-start')}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${base}-${t.key}`}
            aria-selected={t.key === value}
            {...(t.key === value ? { focusgroupstart: '' } : {})}
            onFocus={() => onChange(t.key)}
            onClick={() => onChange(t.key)}
          >
            {t.icon}
            {t.title}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.key}
          role="tabpanel"
          aria-labelledby={`${base}-${t.key}`}
          hidden={t.key !== value}
          className="min-h-0 flex-1"
        >
          {t.key === value && children(t.key)}
        </div>
      ))}
    </div>
  );
};
