// 登录、初始化、接受邀请、重置密码共用的页面外壳：居中的窄卡片 + 实例名称。
// 样式遵循 DESIGN.md（13px 正文、28px 控件、语义 token）。
import type { Me } from '@dowel/api';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { Logo } from './Shell.tsx';

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
}) => (
  <main className="flex min-h-full items-start justify-center px-4 pt-[14vh]">
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
);

/** 登录 / 初始化 / 接受邀请成功后写入当前用户，后面的页面就不用再请求一次 */
export const useSetMe = () => {
  const qc = useQueryClient();
  return (me: Me) => qc.setQueryData(['me'], me);
};
