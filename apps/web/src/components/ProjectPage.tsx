// 项目内页面的公共框架：顶栏面包屑（组 / 项目 / 页面）+ 内容区。
// 模型页有自己的一组工具栏和状态栏，不用这个组件。
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { useProject } from '../project.tsx';
import { PageHeader } from './Shell.tsx';

export const ProjectPage = ({
  title,
  center,
  actions,
  children,
  wide,
}: {
  title: string;
  center?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** 表单类页面限制宽度；列表页可以更宽 */
  wide?: boolean;
}) => {
  const { project } = useProject();
  const params = { owner: project.group.slug, project: project.slug };
  return (
    <>
      <PageHeader
        crumbs={[
          { label: project.group.name, to: '/group/$slug', params: { slug: project.group.slug } },
          { label: project.name, to: '/project/$owner/$project', params },
          { label: title },
        ]}
        center={center}
        actions={actions}
      />
      <main
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 只读视图内所有控件可能被禁用，可滚动主区域需要能用键盘滚动
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto focus-visible:outline-offset-[-2px]"
      >
        <div className={`mx-auto px-6 py-6 ${wide ? 'max-w-[1200px]' : 'max-w-[960px]'}`}>{children}</div>
      </main>
    </>
  );
};

/** 分节：标题 + 右侧操作 + 内容（DESIGN.md：不用卡片套卡片，分节之间留 16～24px） */
export const Section = ({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="space-y-2">
    <header className="flex min-h-[22px] items-center gap-2">
      <h2 className="section-title">{title}</h2>
      {count !== undefined && <span className="count">{count}</span>}
      <span className="flex-1" />
      {action}
    </header>
    {children}
  </section>
);

/** 列表容器：细线分隔，行高 36～40px（比树节点高，因为有两行文字） */
export const Rows = ({ children }: { children: ReactNode }) => (
  <ul className="m-0 list-none overflow-hidden rounded-md border border-border bg-panel p-0">{children}</ul>
);

export const Row = ({ children, className }: { children: ReactNode; className?: string }) => (
  <li
    className={`flex items-center gap-2.5 px-3 py-2.5 not-first:border-t not-first:border-border${className ? ` ${className}` : ''}`}
  >
    {children}
  </li>
);

export const EmptyHint = ({ children }: { children: ReactNode }) => (
  <p className="rounded-md border border-dashed border-border-strong px-4 py-6 text-center text-sm text-text-3">
    {children}
  </p>
);

/** “查看全部”一类的次级链接 */
export const MoreLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <Link to={to} className="text-xs text-primary-text no-underline hover:underline">
    {children}
  </Link>
);
