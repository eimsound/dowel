// 配色：默认跟随系统；用户可在设置菜单里固定为亮色或暗色（DESIGN.md：Implementation）。
// 设置在 <html style="color-scheme: …"> 上，所有 light-dark() token 随之切换。
// 存 localStorage；用一个小订阅让界面里的“切到亮色 / 暗色”文案跟着变（命令面板、账户菜单）。
import { useSyncExternalStore } from 'react';

export type Scheme = 'auto' | 'light' | 'dark';
const KEY = 'dowel.scheme';

const listeners = new Set<() => void>();

export const getScheme = (): Scheme => (localStorage.getItem(KEY) as Scheme | null) ?? 'auto';

export const applyScheme = (s: Scheme = getScheme()) => {
  document.documentElement.style.colorScheme = s === 'auto' ? '' : s;
};

export const setScheme = (s: Scheme) => {
  if (s === 'auto') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, s);
  applyScheme(s);
  for (const fn of listeners) fn();
};

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
