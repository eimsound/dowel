// 画布修改历史读时会话归组（ADR 0015 §4）纯单测：零 DB。
import {
  CANVAS_HISTORY_GROUP_GAP_MS,
  CANVAS_HISTORY_GROUP_MAX_STEPS,
  CANVAS_HISTORY_GROUP_SPAN_MS,
  CANVAS_HISTORY_RUN_ANCHOR,
} from '@dowel/api';
import { COMPOSITE_MUTATORS } from '@dowel/core';
import { expect, test } from 'vitest';

import { userIdOfScopedClient } from '../src/rooms/client-scope.ts';
import {
  actorOf,
  canLink,
  countOps,
  GROUPABLE_OPS,
  groupHistoryRows,
  HistoryGrouper,
  type HistoryMetaRow,
  parseCommitTime,
  splitRun,
} from '../src/rooms/history-grouping.ts';

const T0 = Date.UTC(2026, 10, 27, 9, 0, 0);
const NO_VERSIONS = new Set<number>();

const row = (seq: number, over: Partial<HistoryMetaRow> = {}): HistoryMetaRow => ({
  seq,
  client: 'u1:tab-a',
  opName: 'addColumn',
  opSummary: null,
  atMs: T0 + seq * 1000,
  ...over,
});

/** 生成 [from..to] 的升序行，按 gapMs 递增时间 */
const series = (from: number, to: number, gapMs = 1000, over: Partial<HistoryMetaRow> = {}) => {
  const out: HistoryMetaRow[] = [];
  for (let s = from; s <= to; s++) out.push(row(s, { atMs: T0 + (s - from) * gapMs, ...over }));
  return out;
};

/** 倒序喂入并返回 [seqFrom, seqTo] 列表（按组尾倒序） */
const ranges = (rowsAsc: HistoryMetaRow[], versions: Set<number> = NO_VERSIONS) =>
  groupHistoryRows([...rowsAsc].reverse(), versions).map((g) => [g[0]!.seq, g.at(-1)!.seq]);

test('userIdOfScopedClient：仅 `${userId}:${rawClient}` 返回 userId', () => {
  expect(userIdOfScopedClient('u1:tab-a')).toBe('u1');
  expect(userIdOfScopedClient('u1:tab:with:colons')).toBe('u1');
  expect(userIdOfScopedClient('system')).toBeNull();
  expect(userIdOfScopedClient('mcp:u1:tok')).toBeNull();
  expect(userIdOfScopedClient('mcp:tok')).toBeNull();
  expect(userIdOfScopedClient('')).toBeNull();
  expect(userIdOfScopedClient(null)).toBeNull();
  expect(userIdOfScopedClient(undefined)).toBeNull();
  // 早期无前缀旧行 / 畸形
  expect(userIdOfScopedClient('legacy-client')).toBeNull();
  expect(userIdOfScopedClient(':raw')).toBeNull();
  expect(userIdOfScopedClient('u1:')).toBeNull();
});

test('GROUPABLE_OPS 只含普通 mutator，排除 paste / batch', () => {
  expect(GROUPABLE_OPS.has('addColumn')).toBe(true);
  expect(GROUPABLE_OPS.has('createTable')).toBe(true);
  for (const n of COMPOSITE_MUTATORS) expect(GROUPABLE_OPS.has(n)).toBe(false);
});

test('parseCommitTime 兼容 PG Date、SQLite ISO 与无时区历史文本（按 UTC）', () => {
  const d = new Date(T0);
  expect(parseCommitTime(d)).toBe(T0);
  expect(parseCommitTime(d.toISOString())).toBe(T0);
  expect(parseCommitTime('2026-11-27 09:00:00')).toBe(T0);
  expect(parseCommitTime('2026-11-27T09:00:00')).toBe(T0);
  expect(parseCommitTime('2026-11-27 09:00:00.250')).toBe(T0 + 250);
  expect(parseCommitTime('2026-11-27T17:00:00+08:00')).toBe(T0);
  expect(parseCommitTime('not a time')).toBeNaN();
  expect(parseCommitTime(null)).toBeNaN();
});

test('相邻间隔 5 分钟边界：5m00s 合并，5m00.001s 断开', () => {
  const a = row(1, { atMs: T0 });
  expect(canLink(a, row(2, { atMs: T0 + CANVAS_HISTORY_GROUP_GAP_MS }), NO_VERSIONS)).toBe(true);
  expect(canLink(a, row(2, { atMs: T0 + CANVAS_HISTORY_GROUP_GAP_MS + 1 }), NO_VERSIONS)).toBe(false);
  expect(ranges([a, row(2, { atMs: T0 + CANVAS_HISTORY_GROUP_GAP_MS })])).toEqual([[1, 2]]);
  expect(ranges([a, row(2, { atMs: T0 + CANVAS_HISTORY_GROUP_GAP_MS + 1 })])).toEqual([
    [2, 2],
    [1, 1],
  ]);
});

test('容忍 HA 多副本毫秒级时钟微倒挂；无法解析的时间不连接', () => {
  expect(canLink(row(1, { atMs: T0 }), row(2, { atMs: T0 - 5 }), NO_VERSIONS)).toBe(true);
  expect(
    canLink(row(1, { atMs: T0 }), row(2, { atMs: T0 - CANVAS_HISTORY_GROUP_GAP_MS - 1 }), NO_VERSIONS),
  ).toBe(false);
  expect(canLink(row(1, { atMs: Number.NaN }), row(2), NO_VERSIONS)).toBe(false);
});

test('单组总跨度 ≤ 30 分钟：正序贪心从组首起算', () => {
  // 每 4 分钟一步：0,4,...,28 分钟（8 步）在 30 分钟内，第 9 步（32 分钟）另起一组
  const rows = series(1, 12, 4 * 60_000);
  expect(ranges(rows)).toEqual([
    [9, 12],
    [1, 8],
  ]);
  // 正好 30 分钟仍合并，多 1ms 即另起一组
  const at = (ms: number) => [
    row(1, { atMs: T0 }),
    row(2, { atMs: T0 + 3 * 60_000 }),
    row(3, { atMs: T0 + ms }),
  ];
  expect(splitRun(at(CANVAS_HISTORY_GROUP_SPAN_MS)).map((g) => g.length)).toEqual([3]);
  expect(splitRun(at(CANVAS_HISTORY_GROUP_SPAN_MS + 1)).map((g) => g.length)).toEqual([2, 1]);
});

test('单组最多 50 步；120 → 121 步追加只延长末尾组、旧组边界不变', () => {
  const r120 = series(1, 120);
  expect(ranges(r120)).toEqual([
    [101, 120],
    [51, 100],
    [1, 50],
  ]);
  const r121 = series(1, 121);
  expect(ranges(r121)).toEqual([
    [101, 121],
    [51, 100],
    [1, 50],
  ]);
  expect(ranges(series(1, CANVAS_HISTORY_GROUP_MAX_STEPS + 1))).toEqual([
    [51, 51],
    [1, 50],
  ]);
});

test('RUN_ANCHOR 锚点处强制断开（1000 / 1001）', () => {
  const rows = series(991, 1010, 100);
  expect(canLink(row(CANVAS_HISTORY_RUN_ANCHOR), row(CANVAS_HISTORY_RUN_ANCHOR + 1), NO_VERSIONS)).toBe(
    false,
  );
  expect(ranges(rows)).toEqual([
    [1001, 1010],
    [991, 1000],
  ]);
});

test('同名不同 userId 绝不合并；同一 userId 多标签页 / 重连自动合并', () => {
  const rows = [
    row(1, { client: 'u1:tab-a' }),
    row(2, { client: 'u1:tab-b' }),
    row(3, { client: 'u1:reconnect' }),
  ];
  expect(ranges(rows)).toEqual([[1, 3]]);
  const twoUsers = [row(1, { client: 'u1:c' }), row(2, { client: 'u2:c' }), row(3, { client: 'u2:c' })];
  expect(ranges(twoUsers)).toEqual([
    [2, 3],
    [1, 1],
  ]);
});

test('无前缀旧行、op_name 为 null、带 opSummary 的行都不归组', () => {
  expect(actorOf(row(1, { client: 'legacy' }))).toBeNull();
  expect(actorOf(row(1, { opName: null }))).toBeNull();
  expect(actorOf(row(1, { opSummary: '说明' }))).toBeNull();
  expect(actorOf(row(1, { opSummary: '   ' }))).toBe('u1');
  expect(actorOf(row(0))).toBeNull();
  const rows = [row(1), row(2, { client: 'legacy' }), row(3), row(4, { opName: null }), row(5), row(6)];
  expect(ranges(rows)).toEqual([
    [5, 6],
    [4, 4],
    [3, 3],
    [2, 2],
    [1, 1],
  ]);
});

test('已发布版本 vN 只能作组尾：其后新提交绝不跨 vN 向下合并', () => {
  const rows = series(1, 6);
  expect(ranges(rows, new Set([3]))).toEqual([
    [4, 6],
    [1, 3],
  ]);
  expect(ranges(rows, new Set([6]))).toEqual([[1, 6]]);
});

test('硬断点：MCP batch、paste 与全部 system 操作（含 derive）', () => {
  const systemOps = [
    'importSql',
    'pullSchema',
    'attachAhead',
    'restoreHistory',
    'applyVersion',
    'retireVersions',
    'unretireVersions',
    'replaceModel',
    'derive',
  ];
  for (const op of systemOps) {
    expect(actorOf(row(2, { client: 'system', opName: op })), op).toBeNull();
    expect(ranges([row(1), row(2, { client: 'system', opName: op }), row(3)]), op).toEqual([
      [3, 3],
      [2, 2],
      [1, 1],
    ]);
  }
  expect(
    ranges([row(1), row(2, { client: 'mcp:u1:tok', opName: 'batch', opSummary: '整批' }), row(3)]),
  ).toEqual([
    [3, 3],
    [2, 2],
    [1, 1],
  ]);
  // 即使 client 是人类格式，paste / batch 也不归组
  expect(ranges([row(1), row(2, { opName: 'paste' }), row(3), row(4, { opName: 'batch' }), row(5)])).toEqual([
    [5, 5],
    [4, 4],
    [3, 3],
    [2, 2],
    [1, 1],
  ]);
});

test('HistoryGrouper 增量喂入：连续段只在碰到硬断点或 finish 时封口', () => {
  const g = new HistoryGrouper<HistoryMetaRow>(NO_VERSIONS);
  for (const r of series(4, 6).reverse()) g.push(r);
  expect(g.groups).toEqual([]);
  g.push(row(3, { client: 'u2:x' }));
  expect(g.groups.map((x) => x.map((r) => r.seq))).toEqual([[4, 5, 6]]);
  g.finish();
  expect(g.groups.map((x) => x.map((r) => r.seq))).toEqual([[4, 5, 6], [3]]);
});

test('countOps 按出现次数降序（同数按首次出现），最多 5 项', () => {
  expect(
    countOps(['addColumn', 'renameColumn', 'addColumn', 'setNotNull', 'renameColumn', 'addColumn']),
  ).toEqual([
    { name: 'addColumn', count: 3 },
    { name: 'renameColumn', count: 2 },
    { name: 'setNotNull', count: 1 },
  ]);
  expect(countOps(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toHaveLength(5);
});
