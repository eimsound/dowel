// 入口：加载 polyfill、应用配色，挂载路由。路由定义在 routes.tsx（嵌套布局 + beforeLoad 登录检查）。
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from './components/Toasts.tsx';
import './i18n.ts';
import { loadPolyfills } from './polyfills.ts';
import { router } from './routes.tsx';
import { queryClient } from './session.ts';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyScheme } from './theme.ts';

applyScheme();
await loadPolyfills();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
