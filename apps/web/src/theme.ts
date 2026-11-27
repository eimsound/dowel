// 配色：默认跟随系统；用户可在设置菜单或登录页右上角固定为亮色或暗色（DESIGN.md：Implementation）。
// 同时同步 <html style="color-scheme: …"> 与 <meta name="color-scheme">，所有 light-dark() token 随之切换。
// 存 localStorage，并在存储异常时仍保证当前页面生效；同时监听 storage 实现跨标签页同步。
import { useSyncExternalStore } from 'react';

export type Scheme = 'auto' | 'light' | 'dark';
const KEY = 'dowel.scheme';

const listeners = new Set<() => void>();

export const getScheme = (): Scheme => {
  try {
    const raw =
      typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
        ? localStorage.getItem(KEY)
        : null;
    return raw === 'light' || raw === 'dark' ? raw : 'auto';
  } catch {
    return 'auto';
  }
};

export const applyScheme = (s: Scheme = getScheme()) => {
  if (typeof document === 'undefined') return;
  document.documentElement.style.colorScheme = s === 'auto' ? '' : s;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.content = s === 'auto' ? 'light dark' : s;
};

export const setScheme = (s: Scheme) => {
  try {
    if (typeof localStorage !== 'undefined') {
      if (s === 'auto' && typeof localStorage.removeItem === 'function') localStorage.removeItem(KEY);
      else if (s !== 'auto' && typeof localStorage.setItem === 'function') localStorage.setItem(KEY, s);
    }
  } catch {
    // 存储受限或被禁用时仍即时切换当前页面配色
  }
  applyScheme(s);
  for (const fn of listeners) fn();
};

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    applyScheme();
    for (const fn of listeners) fn();
  });
}

/** 命令面板等地方用：跟随系统时按当前实际配色取反，得到“切换”后的配色 */
export const nextScheme = (current: Scheme): Scheme => {
  if (current === 'dark') return 'light';
  if (current === 'light') return 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
};

/** 订阅配色的变化（同一个标签页里改设置时立刻通知） */
export const useScheme = (): Scheme =>
  useSyncExternalStore((fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, getScheme);
