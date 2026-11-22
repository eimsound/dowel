import { describe, expect, test } from 'vitest';

import {
  MAX_SECTION_NAME_LENGTH,
  MAX_SECTIONS,
  SECTION_COLORS,
  sanitizeSections,
  sectionColorCssVar,
} from '../src/index.ts';

describe('sanitizeSections', () => {
  test('非数组输入安全返回空数组', () => {
    expect(sanitizeSections(null)).toEqual([]);
    expect(sanitizeSections(undefined)).toEqual([]);
    expect(sanitizeSections({})).toEqual([]);
    expect(sanitizeSections('bad')).toEqual([]);
  });

  test('强制每张表最多归属 1 个板块（保留首次出现并去重）', () => {
    const out = sanitizeSections([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 't2', 't1'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: ['t2', 't3', 't2'] },
    ]);
    expect(out).toEqual([
      { id: 's1', name: '订单', color: 'peer-1', tables: ['t1', 't2'] },
      { id: 's2', name: '用户', color: 'peer-2', tables: ['t3'] },
    ]);
  });

  test('校验并规范化名称、ID、颜色与扁平结构', () => {
    const longName = 'x'.repeat(MAX_SECTION_NAME_LENGTH + 20);
    const out = sanitizeSections([
      null,
      { id: '', name: '无效', color: 'peer-1', tables: [] },
      { id: 's1', name: '   ', color: 'peer-1', tables: [] },
      {
        id: ' s1 ',
        name: `  ${longName}  `,
        color: 'red',
        tables: ['t1', '', 123, '   '],
        children: [{ id: 'nested' }],
      },
      { id: 's1', name: '重复ID丢弃', color: 'peer-3', tables: ['t2'] },
      { id: 's2', name: '有效板块', color: 'invalid', tables: ['t2'] },
    ]);
    expect(out).toEqual([
      {
        id: 's1',
        name: 'x'.repeat(MAX_SECTION_NAME_LENGTH),
        color: SECTION_COLORS[0],
        tables: ['t1'],
      },
      {
        id: 's2',
        name: '有效板块',
        color: SECTION_COLORS[1],
        tables: ['t2'],
      },
    ]);
    expect(sectionColorCssVar('peer-4')).toBe('var(--peer-4)');
  });

  test('超过板块数量上限时确定性截断', () => {
    const input = Array.from({ length: MAX_SECTIONS + 15 }, (_, i) => ({
      id: `s-${i}`,
      name: `板块 ${i}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length],
      tables: [`t-${i}`],
    }));
    const out = sanitizeSections(input);
    expect(out).toHaveLength(MAX_SECTIONS);
    expect(out.at(-1)?.id).toBe(`s-${MAX_SECTIONS - 1}`);
  });
});
