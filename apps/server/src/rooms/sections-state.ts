// 画布板块待落盘判定（纯函数，供内核空闲卸载判断复用，避免内核与板块模块循环依赖）。

import type { Loaded } from './types.ts';

export const hasPendingSections = (r: Loaded): boolean =>
  r.sectionsPending || r.sectionsIoCount > 0 || r.sectionsTimer !== undefined;
