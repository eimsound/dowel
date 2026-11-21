// 登录限速、KeyedLimiter 精确退回与全量限流环境变量：验证 IP+账号、IP 总量、原子性、成功撤销、窗口清扫、精确退回、key 上限及 9 项环境变量读取。
import { expect, test } from 'vitest';

import {
  connectionLimiterFromEnv,
  KeyedLimiter,
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

  // 超出 32 位正整数上限的超大数值同样回退默认值（防定时器 / 窗口溢出）
  const hugeEnv = {
    DOWEL_LOGIN_LIMIT: '1e300',
    DOWEL_LOGIN_WINDOW_MS: '2147483648',
    DOWEL_CONNECTION_WINDOW_MS: '9999999999999',
  };
  const hLogin = loginLimiterFromEnv(hugeEnv);
  expect([hLogin.limit, hLogin.windowMs]).toEqual([10, 600_000]);
  const hConn = connectionLimiterFromEnv(hugeEnv);
  expect(hConn.windowMs).toBe(60_000);
});

const setupKeyed = (options: { limit?: number; windowMs?: number; maxKeys?: number } = {}) => {
  let now = 0;
  const limiter = new KeyedLimiter({
    limit: 2,
    windowMs: 10_000,
    now: () => now,
    ...options,
  });
  return {
    limiter,
    setNow: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

test('KeyedLimiter 精确退回：并发同 key 请求 A(t1) 退回只删 t1、保留 B(t2) 且按 t2 计算过期时间', () => {
  const { limiter, setNow } = setupKeyed({ limit: 2, windowMs: 10_000 });

  setNow(0);
  const a = limiter.attempt('ip:1');
  expect(a.allowed).toBe(true);

  setNow(4_000);
  const b = limiter.attempt('ip:1');
  expect(b.allowed).toBe(true);

  // A 认证成功退回，应精确删除 t1=0，保留 B 的 t2=4_000
  setNow(4_500);
  if (a.allowed) a.refund();
  expect(limiter.keyCount).toBe(1);

  // C 在 t3=5_000 预占，此时窗口内为 [4_000, 5_000] 达到上限 2
  setNow(5_000);
  const c = limiter.attempt('ip:1');
  expect(c.allowed).toBe(true);

  // t=10_000 已超过 t1+10_000，但未到 t2+10_000（14_000），不能提前放行
  setNow(10_000);
  const blocked = limiter.attempt('ip:1');
  expect(blocked.allowed).toBe(false);
  if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(4);

  setNow(13_999);
  const stillBlocked = limiter.attempt('ip:1');
  expect(stillBlocked.allowed).toBe(false);
  if (!stillBlocked.allowed) expect(stillBlocked.retryAfterSeconds).toBe(1);

  // 到达 t2+10_000 后 B 过期，重新允许
  setNow(14_000);
  const d = limiter.attempt('ip:1');
  expect(d.allowed).toBe(true);

  // 退回剩余所有未过期记录后，应从 map 清理空 key
  if (c.allowed) c.refund();
  if (d.allowed) d.refund();
  expect(limiter.keyCount).toBe(0);
});

test('KeyedLimiter 精确退回：慢请求 A 跨过 windowMs 后调用 refund 不误删新窗口内 B 的记录', () => {
  const { limiter, setNow } = setupKeyed({ limit: 1, windowMs: 10_000 });

  setNow(0);
  const a = limiter.attempt('ip:slow');
  expect(a.allowed).toBe(true);

  // 跨过整个窗口，B 在新窗口插入记录（A 的旧记录已过期清扫）
  setNow(10_000);
  const b = limiter.attempt('ip:slow');
  expect(b.allowed).toBe(true);

  // 慢请求 A 此时才完成并退回，必须是安全 no-op，绝不误删 B
  setNow(10_500);
  if (a.allowed) a.refund();
  expect(limiter.keyCount).toBe(1);

  const blocked = limiter.attempt('ip:slow');
  expect(blocked.allowed).toBe(false);
  if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBe(10);

  // B 自己退回后才会释放配额并清理 key
  if (b.allowed) b.refund();
  expect(limiter.keyCount).toBe(0);
  expect(limiter.attempt('ip:slow').allowed).toBe(true);
});

test('KeyedLimiter 精确退回：重复调用同一次 refund 幂等且不误删其他记录', () => {
  const { limiter, setNow } = setupKeyed({ limit: 2, windowMs: 10_000 });

  setNow(0);
  const a = limiter.attempt('ip:dup');
  setNow(1_000);
  const b = limiter.attempt('ip:dup');
  expect(a.allowed).toBe(true);
  expect(b.allowed).toBe(true);
  expect(limiter.attempt('ip:dup').allowed).toBe(false);

  // 多次重复调用 a.refund() 只删 A，不影响 B
  if (a.allowed) {
    a.refund();
    a.refund();
    a.refund();
  }
  expect(limiter.keyCount).toBe(1);

  // 此时仅剩 B，还能再放行 1 次，之后达到上限 2
  setNow(2_000);
  const c = limiter.attempt('ip:dup');
  expect(c.allowed).toBe(true);
  expect(limiter.attempt('ip:dup').allowed).toBe(false);

  // 再次重复调用 a.refund() 依然不删 B 或 C
  if (a.allowed) a.refund();
  expect(limiter.attempt('ip:dup').allowed).toBe(false);

  if (b.allowed) b.refund();
  if (c.allowed) c.refund();
  expect(limiter.keyCount).toBe(0);
});

test('KeyedLimiter 精确退回：attempt(key, count) 多计数预占精确退回与边界校验', () => {
  const { limiter, setNow } = setupKeyed({ limit: 5, windowMs: 10_000 });

  setNow(0);
  const batchA = limiter.attempt('k:batch', 3);
  expect(batchA.allowed).toBe(true);

  setNow(2_000);
  const batchB = limiter.attempt('k:batch', 2);
  expect(batchB.allowed).toBe(true);
  expect(limiter.attempt('k:batch', 1).allowed).toBe(false);

  // 精确退回 batchA 的 3 条记录，保留 batchB 的 2 条（at=2_000）
  setNow(3_000);
  if (batchA.allowed) batchA.refund();
  expect(limiter.keyCount).toBe(1);

  // 剩余 3 槽：申请 4 槽应被拒，且按 batchB 的 at=2_000 计算等待 9 秒
  const tooMany = limiter.attempt('k:batch', 4);
  expect(tooMany.allowed).toBe(false);
  if (!tooMany.allowed) expect(tooMany.retryAfterSeconds).toBe(9);

  // 申请 3 槽应允许（总计 5 槽）
  const batchC = limiter.attempt('k:batch', 3);
  expect(batchC.allowed).toBe(true);
  expect(limiter.attempt('k:batch', 1).allowed).toBe(false);

  // 退回 batchB（2 条）后保留 batchC（3 条），再退回 batchC 后空桶清理
  if (batchB.allowed) batchB.refund();
  expect(limiter.check('k:batch', 2).allowed).toBe(true);
  expect(limiter.check('k:batch', 3).allowed).toBe(false);
  if (batchC.allowed) batchC.refund();
  expect(limiter.keyCount).toBe(0);

  // 单次请求超过 limit 安全拒绝不崩溃；非法 count 抛出 RangeError
  const overLimit = limiter.attempt('k:over', 6);
  expect(overLimit.allowed).toBe(false);
  if (!overLimit.allowed) expect(overLimit.retryAfterSeconds).toBe(10);
  expect(() => limiter.attempt('k:bad', 0)).toThrow(RangeError);
  expect(() => limiter.attempt('k:bad', -1)).toThrow(RangeError);
  expect(() => limiter.attempt('k:bad', 1.5)).toThrow(RangeError);
});
