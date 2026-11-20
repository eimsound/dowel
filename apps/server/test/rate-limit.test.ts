// 登录限速与全量限流环境变量：验证 IP+账号、IP 总量、原子性、成功撤销、窗口清扫、key 上限及 9 项环境变量读取。
import { expect, test } from 'vitest';
import {
  connectionLimiterFromEnv,
  LoginLimiter,
  type LoginLimiterOptions,
  loginLimiterFromEnv,
  tokenFailLimiterFromEnv,
  tokenLimiterFromEnv,
} from '../src/rate-limit.ts';

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

test('全部 4 个限流器 / 9 个环境变量默认值、合法覆盖与非法值回退', () => {
  // 默认值
  const defLogin = loginLimiterFromEnv({});
  expect([defLogin.limit, defLogin.ipLimit, defLogin.windowMs]).toEqual([10, 30, 600_000]);
  const defConn = connectionLimiterFromEnv({});
  expect([defConn.limit, defConn.windowMs]).toEqual([10, 60_000]);
  const defFail = tokenFailLimiterFromEnv({});
  expect([defFail.limit, defFail.windowMs]).toEqual([20, 600_000]);
  const defRate = tokenLimiterFromEnv({});
  expect([defRate.limit, defRate.windowMs]).toEqual([120, 60_000]);

  // 合法正整数覆盖
  const customEnv: NodeJS.ProcessEnv = {
    DOWEL_LOGIN_LIMIT: '5',
    DOWEL_LOGIN_IP_LIMIT: '15',
    DOWEL_LOGIN_WINDOW_MS: '120000',
    DOWEL_CONNECTION_LIMIT: '4',
    DOWEL_CONNECTION_WINDOW_MS: '30000',
    DOWEL_TOKEN_FAIL_LIMIT: '8',
    DOWEL_TOKEN_FAIL_WINDOW_MS: '90000',
    DOWEL_TOKEN_RATE_LIMIT: '60',
    DOWEL_TOKEN_RATE_WINDOW_MS: '45000',
  };
  const cLogin = loginLimiterFromEnv(customEnv);
  expect([cLogin.limit, cLogin.ipLimit, cLogin.windowMs]).toEqual([5, 15, 120_000]);
  const cConn = connectionLimiterFromEnv(customEnv);
  expect([cConn.limit, cConn.windowMs]).toEqual([4, 30_000]);
  const cFail = tokenFailLimiterFromEnv(customEnv);
  expect([cFail.limit, cFail.windowMs]).toEqual([8, 90_000]);
  const cRate = tokenLimiterFromEnv(customEnv);
  expect([cRate.limit, cRate.windowMs]).toEqual([60, 45_000]);

  // 非法值（0、负数、小数、非数字）全部回退到默认值
  const badEnv: NodeJS.ProcessEnv = {
    DOWEL_LOGIN_LIMIT: '0',
    DOWEL_LOGIN_IP_LIMIT: '-5',
    DOWEL_LOGIN_WINDOW_MS: '1.5',
    DOWEL_CONNECTION_LIMIT: 'abc',
    DOWEL_CONNECTION_WINDOW_MS: '',
    DOWEL_TOKEN_FAIL_LIMIT: '-1',
    DOWEL_TOKEN_FAIL_WINDOW_MS: 'NaN',
    DOWEL_TOKEN_RATE_LIMIT: '0',
    DOWEL_TOKEN_RATE_WINDOW_MS: 'Infinity',
  };
  const bLogin = loginLimiterFromEnv(badEnv);
  expect([bLogin.limit, bLogin.ipLimit, bLogin.windowMs]).toEqual([10, 30, 600_000]);
  const bConn = connectionLimiterFromEnv(badEnv);
  expect([bConn.limit, bConn.windowMs]).toEqual([10, 60_000]);
  const bFail = tokenFailLimiterFromEnv(badEnv);
  expect([bFail.limit, bFail.windowMs]).toEqual([20, 600_000]);
  const bRate = tokenLimiterFromEnv(badEnv);
  expect([bRate.limit, bRate.windowMs]).toEqual([120, 60_000]);
});
