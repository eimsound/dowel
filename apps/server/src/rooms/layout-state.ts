// 画布布局待落盘判定（纯函数，供内核空闲卸载判断复用，避免内核与布局模块循环依赖）。

import type { Loaded } from './types.ts';

export const hasPendingLayout = (r: Loaded): boolean =>
  Object.keys(r.pendingLayout).length > 0 || r.layoutIoCount > 0 || r.layoutTimer !== undefined;
