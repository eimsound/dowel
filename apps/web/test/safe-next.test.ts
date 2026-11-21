// 登录后跳转校验的单元测试：用例与服务端 safeNext 相同（apps/server/test/oidc.test.ts）。
import { expect, test } from 'vitest';

import { safeNext } from '../src/safe-next.ts';

const ORIGIN = 'http://dowel.invalid';

test('next 规范化后校验，非法值回退到 /', () => {
  for (const next of [
    '/a/..//evil.com',
    '/.//evil.com',
    '/%2e%2e//evil.com',
    '/\\evil.com',
    '//evil.com',
    'https://evil.com',
  ])
    expect(safeNext(next, ORIGIN), next).toBe('/');
  expect(safeNext('/a/b?x=1#h', ORIGIN)).toBe('/a/b?x=1#h');
  // 同 origin 的绝对地址规范化后仍指向站内，允许
  expect(safeNext(`${ORIGIN}/a/b`, ORIGIN)).toBe('/a/b');
  expect(safeNext(undefined)).toBeNull();
});
