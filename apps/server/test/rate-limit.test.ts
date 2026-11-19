// 登录限速：注入时钟，验证 IP+账号、IP 总量、原子性、成功撤销、窗口清扫和 key 上限。
import { expect, test } from 'vitest';
import { LoginLimiter, type LoginLimiterOptions } from '../src/rate-limit.ts';

const setup = (options: LoginLimiterOptions = {}) => {
  let now = 0;
  const limiter = new LoginLimiter({
    limit: 3,
    ipLimit: 30,
    windowMs: 60_000,
    now: () => now,
    ...options,
  });
  return {
    limiter,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

test('IP + 账号达到上限后拒绝，窗口过期后恢复', () => {
  const { limiter, advance } = setup();
  expect(limiter.attempt('1.1.1.1', 'a@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'a@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'a@x.com').allowed).toBe(true);
  const blocked = limiter.attempt('1.1.1.1', 'a@x.com');
  expect(blocked.allowed).toBe(false);
  if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(60);
  advance(60_000);
  expect(limiter.attempt('1.1.1.1', 'a@x.com').allowed).toBe(true);
});

test('按 IP + 账号计数：同一账号换个 IP 仍可登录（不会把受害者锁在门外）', () => {
  const { limiter } = setup({ limit: 2 });
  expect(limiter.attempt('1.1.1.1', 'victim@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'victim@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'victim@x.com').allowed).toBe(false);
  expect(limiter.attempt('2.2.2.2', 'victim@x.com').allowed).toBe(true);
});

test('按 IP 总量计数：换账号也拦，换 IP 不受影响', () => {
  const { limiter } = setup({ limit: 100, ipLimit: 3 });
  expect(limiter.attempt('1.1.1.1', 'a@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'b@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'c@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'd@x.com').allowed).toBe(false);
  expect(limiter.attempt('2.2.2.2', 'd@x.com').allowed).toBe(true);
});

test('登录成功只撤销 IP + 账号的记录，IP 总量保留', () => {
  const { limiter } = setup({ limit: 2, ipLimit: 2 });
  expect(limiter.attempt('1.1.1.1', 'attacker@x.com').allowed).toBe(true);
  expect(limiter.attempt('1.1.1.1', 'other@x.com').allowed).toBe(true);
  limiter.succeed('1.1.1.1', 'attacker@x.com');
  // 账号记录没了，但 IP 总量还是满的
  expect(limiter.attempt('1.1.1.1', 'attacker@x.com').allowed).toBe(false);
  expect(limiter.attempt('2.2.2.2', 'attacker@x.com').allowed).toBe(true);
});

test('attempt 是原子的：同时发起 N 个请求，放行数不超过上限', async () => {
  const { limiter } = setup({ limit: 5, ipLimit: 100 });
  const results = await Promise.all(
    Array.from({ length: 20 }, async () => {
      await Promise.resolve();
      return limiter.attempt('1.1.1.1', 'same@x.com');
    }),
  );
  expect(results.filter((r) => r.allowed)).toHaveLength(5);
});

test('超过一个窗口后清扫所有过期 key', () => {
  const { limiter, advance } = setup({ limit: 100, windowMs: 1_000 });
  limiter.attempt('1.1.1.1', 'a@x.com');
  expect(limiter.keyCount).toBe(2); // pair + ip
  advance(1_000);
  limiter.attempt('2.2.2.2', 'b@x.com');
  expect(limiter.keyCount).toBe(2); // 旧的两个 key 被清掉，只剩这次的两个
});

test('key 数量有上限', () => {
  const { limiter } = setup({ limit: 100, maxKeys: 3 });
  for (const account of ['a', 'b', 'c', 'd']) expect(limiter.attempt(null, account).allowed).toBe(true);
  expect(limiter.keyCount).toBeLessThanOrEqual(3);
});
