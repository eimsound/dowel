// 画布修改历史（ADR 0015 §4 编辑会话归组）的纯逻辑：分页合并去重、选中态、操作计数摘要与区间文案。
// 与 React 组件解耦，便于纯单测。
import type { CanvasHistoryEntry, CanvasHistoryList, CanvasHistoryOpCount } from '@dowel/api';

/** 时间线上的选中项：单步 / 初始状态时 from === seq；编辑会话组时 from 为组首 */
export interface HistorySelection {
  seq: number;
  from: number;
}

/** 条目的稳定去重键：组与组尾单步（同 seq 不同 from）互不冲突 */
export const entryKey = (e: Pick<CanvasHistoryEntry, 'seq' | 'seqFrom'>): string => `${e.seqFrom}-${e.seq}`;

/** 多步编辑会话组 */
export const isSession = (e: Pick<CanvasHistoryEntry, 'stepCount'>): boolean => e.stepCount > 1;

/** 合并分页结果并按 `${seqFrom}-${seq}` 去重（保留先出现的） */
export const mergeHistoryPages = (
  pages: readonly Pick<CanvasHistoryList, 'entries'>[],
): CanvasHistoryEntry[] => {
  const seen = new Set<string>();
  const out: CanvasHistoryEntry[] = [];
  for (const page of pages) {
    for (const e of page.entries) {
      const k = entryKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  return out;
};

/** 条目对应的选中态 */
export const selectionOf = (e: Pick<CanvasHistoryEntry, 'seq' | 'seqFrom'>): HistorySelection => ({
  seq: e.seq,
  from: e.seqFrom,
});

/** 当前生效的选中项：未显式选择时取时间线顶部第 1 项 */
export const activeSelection = (
  selected: HistorySelection | null,
  entries: readonly Pick<CanvasHistoryEntry, 'seq' | 'seqFrom'>[],
): HistorySelection | null => selected ?? (entries[0] ? selectionOf(entries[0]) : null);

export const sameSelection = (a: HistorySelection | null, b: HistorySelection | null): boolean =>
  !!a && !!b && a.seq === b.seq && a.from === b.from;

/** 选中的是某组内的单步（组本身未被选中、组处于折叠时用于在组行上做柔和标记） */
export const selectionInside = (
  sel: HistorySelection | null,
  group: Pick<CanvasHistoryEntry, 'seq' | 'seqFrom' | 'stepCount'>,
): boolean =>
  !!sel && isSession(group) && sel.from === sel.seq && sel.seq >= group.seqFrom && sel.seq <= group.seq;

/** 详情接口路径：组带 `?from=`，单步 / 初始状态不带 */
export const detailPath = (pid: string, sel: HistorySelection): string =>
  sel.from !== sel.seq
    ? `/api/projects/${pid}/history/${sel.seq}?from=${sel.from}`
    : `/api/projects/${pid}/history/${sel.seq}`;

/** 展开组内单步的接口路径 */
export const stepsPath = (pid: string, from: number, seq: number): string =>
  `/api/projects/${pid}/history/${seq}/steps?from=${from}`;

/** 区间文案 `#1–#5`（单步时为 `#5`） */
export const rangeLabel = (from: number, to: number): string => (from === to ? `#${to}` : `#${from}–#${to}`);

/**
 * 时间线上的操作计数摘要：按次数降序（服务端已排好，这里再稳定排序兜底）取前 max 项，
 * rest 为未展示的步数（总步数减去已展示项的次数之和）。
 */
export const opsPreview = (
  ops: readonly CanvasHistoryOpCount[] | undefined,
  stepCount: number,
  max = 3,
): { shown: CanvasHistoryOpCount[]; rest: number } => {
  const sorted = [...(ops ?? [])]
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .map(({ name, count }) => ({ name, count }));
  const shown = sorted.slice(0, max);
  const used = shown.reduce((n, o) => n + o.count, 0);
  return { shown, rest: Math.max(0, stepCount - used) };
};

/** formatTime 的绝对时间形态 `YYYY-MM-DD HH:mm`（超过一天的记录）；相对时间（“3 分钟前”）返回 false */
export const isAbsoluteTime = (s: string): boolean => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s);

/**
 * 格式化后的时间范围：起止显示相同（例如都显示为“刚刚”）时只给出一个；
 * 起止都是同一天的绝对时间时，结束只保留 `HH:mm`（`2026-11-25 14:20–14:45`）。
 * `full` 为不简写的完整文本（用作悬停提示，窄侧栏截断时仍可看全）。
 */
export const timeRange = (
  startedAt: string,
  at: string,
  format: (iso: string) => string,
): ({ start: string; end: string } | { single: string }) & { full: string } => {
  const start = format(startedAt);
  const end = format(at);
  if (start === end) return { single: end, full: end };
  const full = `${start}–${end}`;
  if (isAbsoluteTime(start) && isAbsoluteTime(end) && start.slice(0, 10) === end.slice(0, 10)) {
    return { start, end: end.slice(11), full };
  }
  return { start, end, full };
};
