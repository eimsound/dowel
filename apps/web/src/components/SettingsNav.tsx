// 设置类页面（个人设置、管理后台）的侧面板导航：一组链接 + 当前项标记。
// 放在外壳的侧面板里（useShellPanel），窄屏时随侧面板变成抽屉。
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export interface SettingsNavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

export const SettingsNav = ({
  label,
  items,
  path,
}: {
  label: string;
  items: SettingsNavItem[];
  /** 当前路径：精确匹配决定 aria-current */
  path: string;
}) => (
  <nav aria-label={label} className="min-h-0 flex-1 overflow-auto p-2">
    <ul className="m-0 list-none space-y-0.5 p-0">
      {items.map((it) => {
        const current = path === it.to;
        return (
          <li key={it.to}>
            <Link
              to={it.to}
              aria-current={current ? 'page' : undefined}
              className={`flex h-[var(--row-h)] items-center gap-2 rounded-sm px-2 text-sm no-underline ${
                current
                  ? 'bg-surface-active font-medium text-text'
                  : 'text-text-2 hover:bg-surface-hover hover:text-text'
              }`}
            >
              {it.icon}
              {it.label}
            </Link>
          </li>
        );
      })}
    </ul>
  </nav>
);
