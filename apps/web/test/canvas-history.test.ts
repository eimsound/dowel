// 画布修改历史编辑会话归组的前端纯逻辑（apps/web/src/canvas-history.ts）。
import type { CanvasHistoryEntry } from '@dowel/api';
import { afterEach, expect, test } from 'vitest';

import {
  activeSelection,
  detailPath,
  entryKey,
  isSession,
  mergeHistoryPages,
  opsPreview,
  rangeLabel,
  sameSelection,
  selectionInside,
  selectionOf,
  stepsPath,
  timeRange,
} from '../src/canvas-history.ts';
import i18n from '../src/i18n.ts';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

const entry = (seqFrom: number, seq: number, over: Partial<CanvasHistoryEntry> = {}): CanvasHistoryEntry => ({
  seq,
  seqFrom,
  stepCount: seq === 0 ? 0 : seq - seqFrom + 1,
  at: '2026-11-27T09:05:00.000Z',
  startedAt: '2026-11-27T09:00:00.000Z',
  user: '张三',
  opName: seq - seqFrom > 0 ? 'editSession' : 'addColumn',
  changeCount: 1,
  summary: [],
  isCurrent: false,
  version: null,
  ...over,
});

test('entryKey 区分组 #1–#5 与组尾单步 #5', () => {
  expect(entryKey(entry(1, 5))).toBe('1-5');
  expect(entryKey(entry(5, 5))).toBe('5-5');
  expect(isSession(entry(1, 5))).toBe(true);
  expect(isSession(entry(5, 5))).toBe(false);
  expect(isSession(entry(0, 0))).toBe(false);
});

test('mergeHistoryPages 按 `${seqFrom}-${seq}` 去重并保持顺序', () => {
  const merged = mergeHistoryPages([
    { entries: [entry(6, 6), entry(1, 5)] },
    { entries: [entry(1, 5), entry(5, 5), entry(0, 0)] },
  ]);
  expect(merged.map(entryKey)).toEqual(['6-6', '1-5', '5-5', '0-0']);
});

test('选中态：默认顶部第 1 项；组与组尾单步互不相同；组内单步可识别', () => {
  const entries = [entry(1, 5), entry(0, 0)];
  expect(activeSelection(null, entries)).toEqual({ seq: 5, from: 1 });
  expect(activeSelection(null, [])).toBeNull();
  expect(activeSelection({ seq: 3, from: 3 }, entries)).toEqual({ seq: 3, from: 3 });
  expect(sameSelection(selectionOf(entry(1, 5)), { seq: 5, from: 5 })).toBe(false);
  expect(sameSelection(selectionOf(entry(1, 5)), { seq: 5, from: 1 })).toBe(true);
  expect(sameSelection(null, null)).toBe(false);

  const g = entry(1, 5);
  expect(selectionInside({ seq: 3, from: 3 }, g)).toBe(true);
  expect(selectionInside({ seq: 5, from: 5 }, g)).toBe(true);
  expect(selectionInside({ seq: 5, from: 1 }, g)).toBe(false);
  expect(selectionInside({ seq: 6, from: 6 }, g)).toBe(false);
  expect(selectionInside({ seq: 3, from: 3 }, entry(3, 3))).toBe(false);
});

test('接口路径：组带 ?from=，单步不带', () => {
  expect(detailPath('p1', { seq: 5, from: 1 })).toBe('/api/projects/p1/history/5?from=1');
  expect(detailPath('p1', { seq: 5, from: 5 })).toBe('/api/projects/p1/history/5');
  expect(detailPath('p1', { seq: 0, from: 0 })).toBe('/api/projects/p1/history/0');
  expect(stepsPath('p1', 1, 5)).toBe('/api/projects/p1/history/5/steps?from=1');
  expect(rangeLabel(1, 5)).toBe('#1–#5');
  expect(rangeLabel(5, 5)).toBe('#5');
});

test('opsPreview 取前 3 项并计算其余步数', () => {
  expect(
    opsPreview(
      [
        { name: 'addColumn', count: 3 },
        { name: 'renameColumn', count: 2 },
        { name: 'setNotNull', count: 1 },
        { name: 'dropColumn', count: 1 },
      ],
      8,
    ),
  ).toEqual({
    shown: [
      { name: 'addColumn', count: 3 },
      { name: 'renameColumn', count: 2 },
      { name: 'setNotNull', count: 1 },
    ],
    rest: 2,
  });
  // 乱序输入稳定按次数降序
  expect(
    opsPreview(
      [
        { name: 'a', count: 1 },
        { name: 'b', count: 4 },
      ],
      5,
    ).shown.map((o) => o.name),
  ).toEqual(['b', 'a']);
  expect(opsPreview(undefined, 3)).toEqual({ shown: [], rest: 3 });
});

test('timeRange：起止显示相同时只给一个', () => {
  const fmt = (iso: string) => iso.slice(11, 16);
  expect(timeRange('2026-11-27T09:00:00Z', '2026-11-27T09:05:00Z', fmt)).toEqual({
    start: '09:00',
    end: '09:05',
  });
  expect(timeRange('2026-11-27T09:00:10Z', '2026-11-27T09:00:50Z', fmt)).toEqual({ single: '09:00' });
});

test('编辑会话归组新增文案中英文齐全且无句末拼接', async () => {
  const keys = [
    'hist.op.editSession',
    'hist.stepBadge',
    'hist.opCount',
    'hist.opsMore',
    'hist.stepsToggle',
    'hist.stepsOf',
    'hist.stepsLoadFailed',
    'hist.stepsRetry',
    'hist.containsSelected',
    'hist.groupDiffMeta',
    'hist.groupDiffHint',
    'hist.noGroupOpDiff',
    'hist.confirmGroupBody',
  ];
  for (const lng of ['zh', 'en'] as const) {
    await i18n.changeLanguage(lng);
    for (const k of keys) expect(i18n.exists(k, { lng }), `${lng}: 缺少 ${k}`).toBe(true);
  }
  await i18n.changeLanguage('zh');
  expect(i18n.t('hist.op.editSession')).toBe('连续编辑');
  expect(i18n.t('hist.stepsToggle', { count: 5 })).toBe('5 步明细');
  expect(i18n.t('hist.groupDiffMeta', { range: '#0 → #5', count: 5 })).toBe('#0 → #5 · 5 步净差异');
  expect(i18n.t('hist.confirmGroupBody', { range: '#1–#5', seq: 5, count: 2 })).toContain('连续编辑 #1–#5');
  await i18n.changeLanguage('en');
  expect(i18n.t('hist.op.editSession')).toBe('Editing session');
  expect(i18n.t('hist.stepsToggle', { count: 5 })).toBe('5 steps');
  expect(i18n.t('hist.confirmGroupBody', { range: '#1–#5', seq: 5, count: 2 })).toContain('session #1–#5');
});
