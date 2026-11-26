// 画布修改历史的读时编辑会话归组（ADR 0015 §4）：纯函数，零 DB 依赖。
//
// 底层 room_commits / 实时同步 seq 零改写；只在读路径上把「同一用户、非 MCP、连续普通单步编辑」
// 聚成编辑会话组。硬断点（绝不跨界合并）：换人、已发布版本 vN（只能作组尾）、MCP batch、paste、
// 全部 system 提交（导入 / 拉取 / 接入 / 恢复 / 应用版本 / 作废回退 / 派生刷新…）、seq 为 RUN_ANCHOR 整数倍处。
//
// 切分规则：先把相邻可连接的行串成连续段，每段从最早一步起正序贪心切组（≤ MAX_STEPS 步且总跨度 ≤ SPAN_MS）。
// 因此追加新提交只会延长 / 续开末尾组，已封口的旧组边界与分页游标 beforeSeq 永远不变。
import {
  CANVAS_HISTORY_GROUP_GAP_MS,
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  CANVAS_HISTORY_GROUP_SPAN_MS,
  CANVAS_HISTORY_RUN_ANCHOR,
} from '@dowel/api';
import { COMPOSITE_MUTATORS, mutators } from '@dowel/core';

import { userIdOfScopedClient } from './client-scope.ts';

/** 归组只需要的元数据列（不含 changes，避免在大历史页上反序列化多余 JSON） */
export interface HistoryMetaRow {
  seq: number;
  client: string;
  opName: string | null;
  opSummary: string | null;
  /** 提交时间（毫秒）；无法解析时为 NaN（不与任何相邻行连接） */
  atMs: number;
}

/** 可归组的操作：`mutators` 注册表里的普通单步 mutator（排除 paste / batch 等复合操作） */
export const GROUPABLE_OPS: ReadonlySet<string> = new Set(
  Object.keys(mutators).filter((n) => !COMPOSITE_MUTATORS.has(n)),
);

const NAIVE_TS = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * 解析 room_commits.created_at：PG 是 Date，SQLite 是 ISO 文本；
 * 兼容早期无时区的 `YYYY-MM-DD HH:MM:SS[.fff]`（统一按 UTC 解析）。无法解析时返回 NaN。
 */
export const parseCommitTime = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v !== 'string') return Number.NaN;
  const s = v.trim();
  const naive = NAIVE_TS.exec(s);
  if (naive) return Date.parse(`${naive[1]}T${naive[2]}Z`);
  return Date.parse(s);
};

/** 单行是否可参与归组；可以时返回提交者 userId（归组身份），否则 null */
export const actorOf = (
  row: Pick<HistoryMetaRow, 'seq' | 'client' | 'opName' | 'opSummary'>,
): string | null => {
  if (!(row.seq > 0)) return null;
  if (row.opName === null || !GROUPABLE_OPS.has(row.opName)) return null;
  if (row.opSummary?.trim()) return null;
  return userIdOfScopedClient(row.client);
};

/** 已发布版本锚定的 seq 集合（versionsInRange 已过滤 restored_at is null） */
export interface SeqSet {
  has(seq: number): boolean;
}

/** 相邻两行 prev（旧）→ cur（新）能否连成同一连续段 */
export const canLink = (prev: HistoryMetaRow, cur: HistoryMetaRow, versionSeqs: SeqSet): boolean => {
  if (prev.seq !== cur.seq - 1) return false;
  const actor = actorOf(prev);
  if (actor === null || actor !== actorOf(cur)) return false;
  // 容忍 HA 多副本毫秒级时钟倒挂，同时拦截异常大跨度；NaN 比较恒为 false
  if (!(Math.abs(cur.atMs - prev.atMs) <= CANVAS_HISTORY_GROUP_GAP_MS)) return false;
  // 已发布版本 vN 可以作组尾，但其后的新提交绝不跨 vN 向下合并
  if (versionSeqs.has(prev.seq)) return false;
  // 确定性回扫兜底：锚点处强制断开，保证最长连续段有界
  if (prev.seq % CANVAS_HISTORY_RUN_ANCHOR === 0) return false;
  return true;
};

/** 把一个连续段（按 seq 升序）从最早一步起正序贪心切成若干组（每组仍按 seq 升序） */
export const splitRun = <T extends HistoryMetaRow>(run: readonly T[]): T[][] => {
  const groups: T[][] = [];
  let cur: T[] = [];
  for (const row of run) {
    const start = cur[0];
    if (
      start &&
      cur.length < CANVAS_HISTORY_GROUP_MAX_STEPS &&
      row.atMs - start.atMs <= CANVAS_HISTORY_GROUP_SPAN_MS
    ) {
      cur.push(row);
    } else {
      if (cur.length) groups.push(cur);
      cur = [row];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
};

/**
 * 增量归组器：按 seq 倒序逐行喂入。一个连续段只有向下碰到硬断点（下一行连不上）或调用 finish()
 * （已读到最早一行）时才封口切分；`groups` 按组尾 seq 倒序排列，每组内部按 seq 升序。
 */
export class HistoryGrouper<T extends HistoryMetaRow> {
  readonly groups: T[][] = [];
  private run: T[] = [];
  private readonly versionSeqs: SeqSet;

  constructor(versionSeqs: SeqSet) {
    this.versionSeqs = versionSeqs;
  }

  push(row: T): void {
    const oldest = this.run.at(-1);
    if (oldest && canLink(row, oldest, this.versionSeqs)) {
      this.run.push(row);
      return;
    }
    this.close();
    this.run = [row];
  }

  /** 封口当前连续段（已读到最早一行时调用） */
  finish(): void {
    this.close();
  }

  private close(): void {
    if (!this.run.length) return;
    const groups = splitRun([...this.run].reverse());
    for (let i = groups.length - 1; i >= 0; i--) this.groups.push(groups[i]!);
    this.run = [];
  }
}

/** 一次性对一段完整的倒序行归组（rowsDesc 须为到 seq = 1 为止的完整尾部，或调用方自行保证最底段已封口） */
export const groupHistoryRows = <T extends HistoryMetaRow>(
  rowsDesc: readonly T[],
  versionSeqs: SeqSet,
): T[][] => {
  const g = new HistoryGrouper<T>(versionSeqs);
  for (const row of rowsDesc) g.push(row);
  g.finish();
  return g.groups;
};

/** 组内操作计数：按出现次数降序（同数按首次出现先后），最多 limit 项 */
export const countOps = (
  opNames: readonly (string | null)[],
  limit = 5,
): { name: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const n of opNames) {
    const name = n ?? 'edit';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count], i) => ({ name, count, i }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .slice(0, limit)
    .map(({ name, count }) => ({ name, count }));
};
