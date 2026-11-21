// 组头像的首字母与配色：中文取第一个字，西文取首字母大写；同一个 slug 总是同一种颜色。
import { expect, test } from 'vitest';

import { groupColor, groupInitial } from '../src/avatar.ts';

test('组名首字母：中文取第一个字，西文取首字母大写', () => {
  expect(groupInitial('平台组')).toBe('平');
  expect(groupInitial('acme')).toBe('A');
  expect(groupInitial('  frontend')).toBe('F');
  expect(groupInitial('')).toBe('?');
});

test('组颜色稳定，并且只从八个 peer 色里选', () => {
  expect(groupColor('platform')).toBe(groupColor('platform'));
  expect(groupColor('platform')).not.toBe(groupColor('payments'));
  for (const slug of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'platform'])
    expect(groupColor(slug)).toMatch(/^color-mix\(in oklab, var\(--peer-[1-8]\) 45%, var\(--surface\)\)$/);
});
