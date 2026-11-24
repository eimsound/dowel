import type { CanvasSection } from '@dowel/api';
import type { ClipboardPayload } from '@dowel/core';
import { describe, expect, it } from 'vitest';

import { placePastedTables, sectionIndex, sectionsAfterPaste } from '../src/copy-paste.ts';

const payload = (over: Partial<ClipboardPayload> = {}): ClipboardPayload => ({
  format: 'dowel/clipboard',
  v: 1,
  dialect: 'pg',
  kind: 'tables',
  source: { projectId: 'p1', projectName: 'P1', origin: 'canvas', seq: null },
  copiedAt: '2026-11-24T00:00:00.000Z',
  fragment: {},
  tables: ['a', 'b', 'c'],
  table: null,
  items: [],
  external: [],
  layout: {},
  sections: {},
  skippedOpaque: 0,
  ...over,
});

const plan = { tableMap: { a: 'A', b: 'B', c: 'C' }, newTables: ['A', 'B', 'C'] };

describe('placePastedTables', () => {
  it('保留相对位置并整体居中到视口中心', () => {
    const p = payload({ layout: { a: { x: 0, y: 0 }, b: { x: 300, y: 100 } }, tables: ['a', 'b'] });
    const out = placePastedTables(
      p,
      { tableMap: { a: 'A', b: 'B' }, newTables: ['A', 'B'] },
      { x: 1000, y: 500 },
    );
    // 包围盒 x: 0..550（含节点宽 250），y: 0..100 → 中心 (275, 50)
    expect(out.A).toEqual({ x: 725, y: 450 });
    expect(out.B).toEqual({ x: 1025, y: 550 });
    expect(out.B!.x - out.A!.x).toBe(300);
  });

  it('来源没有坐标的表按网格排在下方，彼此不重叠', () => {
    const out = placePastedTables(payload({ layout: { a: { x: 0, y: 0 } } }), plan, { x: 0, y: 0 });
    expect(Object.keys(out).sort()).toEqual(['A', 'B', 'C']);
    expect(out.B!.y).toBeGreaterThan(out.A!.y);
    expect(out.B!.y).toBe(out.C!.y);
    expect(Math.abs(out.C!.x - out.B!.x)).toBeGreaterThanOrEqual(250);
  });

  it('画布未就绪时以原点为中心；未映射的表不出现', () => {
    const out = placePastedTables(payload(), { tableMap: { a: 'A' }, newTables: ['A'] }, null);
    expect(Object.keys(out)).toEqual(['A']);
    expect(Number.isFinite(out.A!.x)).toBe(true);
  });
});

describe('sectionsAfterPaste', () => {
  const sections: CanvasSection[] = [
    { id: 's1', name: 'Orders', color: 'peer-1', tables: ['a'] },
    { id: 's2', name: 'Users', color: 'peer-2', tables: ['x'] },
  ];

  it('同一项目：新表加入来源表所在且仍存在的板块', () => {
    const next = sectionsAfterPaste(sections, payload({ sections: { a: 's1', b: 'gone' } }), plan, 'p1');
    expect(next?.find((s) => s.id === 's1')?.tables).toEqual(['a', 'A']);
    expect(next?.find((s) => s.id === 's2')?.tables).toEqual(['x']);
  });

  it('跨项目或没有板块信息时不改动', () => {
    expect(sectionsAfterPaste(sections, payload({ sections: { a: 's1' } }), plan, 'other')).toBeNull();
    expect(sectionsAfterPaste(sections, payload(), plan, 'p1')).toBeNull();
  });

  it('sectionIndex 只记录复制的表', () => {
    expect(sectionIndex(sections, ['a', 'zzz'])).toEqual({ a: 's1' });
  });
});
