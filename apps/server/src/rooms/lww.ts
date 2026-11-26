// 布局 / 板块共用的 Lamport 时钟与确定性 LWW 裁决工具。

import type { LayoutVersion } from './types.ts';

export const isNewerLayoutVersion = (
  incoming: LayoutVersion,
  existing: LayoutVersion | undefined,
): boolean => {
  if (!existing) return true;
  if (incoming.ver !== existing.ver) return incoming.ver > existing.ver;
  // 由 DB 持久化时钟推导的匿名基线（origin === ''）在同版本下不视为比既有同版本更新，
  // 避免已从 DB 载入 ver = N 的表被迟到的 ver < N 重载事件（提权为 { ver: N, origin: '' }）误覆写
  if (incoming.origin === '') return false;
  return incoming.origin >= existing.origin;
};

export const parseClock = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

export const resolveIncomingClock = (ver: number | undefined, fallback: number): number =>
  typeof ver === 'number' && Number.isSafeInteger(ver) && ver >= 0 ? ver : fallback;
