// 组名 / 项目名自动推导 slug 的单元测试：输出非空时必须满足 @dowel/api 的 slugSchema。
import { slugSchema } from '@dowel/api';
import { expect, test } from 'vitest';

import { slugify } from '../src/slug.ts';

test('slugify：小写化、空格与下划线替换成 -、合并连续分隔符并去首尾 -', () => {
  expect(slugify('My_Team Name')).toBe('my-team-name');
  expect(slugify('  __Core__Platform_01__  ')).toBe('core-platform-01');
  expect(slugify('Billing & Auth / V2')).toBe('billing-auth-v2');
  expect(slugify('订单_Order Service')).toBe('order-service');
  expect(slugify('纯中文名称')).toBe('');
  expect(slugify('___---   ')).toBe('');
});

test('slugify：最多 39 位且截断后不以 - 结尾，所有非空结果通过 slugSchema 校验', () => {
  const longWithDashAtBoundary = `${'a'.repeat(38)}-bcdef`;
  const truncated = slugify(longWithDashAtBoundary);
  expect(truncated).toBe('a'.repeat(38));
  expect(truncated.length).toBeLessThanOrEqual(39);

  const samples = [
    'My_Team Name',
    '  __Core__Platform_01__  ',
    'Billing & Auth / V2',
    '订单_Order Service',
    longWithDashAtBoundary,
    'A'.repeat(60),
    '1',
  ];
  for (const s of samples) {
    const out = slugify(s);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(39);
    expect(slugSchema.safeParse(out).success, out).toBe(true);
  }
});
