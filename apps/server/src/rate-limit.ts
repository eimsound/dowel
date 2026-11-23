// 登录限速：IP + 账号组合和 IP 总量两个计数，窗口内达到上限后拒绝。
// 单进程内存实现（自托管默认单实例）；时钟可注入，方便测试。
export interface LoginLimiterOptions {
  /** 同一 IP + 账号在窗口内允许的尝试次数 */
  limit?: number;
  /** 同一 IP 在窗口内允许的总尝试次数（跨账号） */
  ipLimit?: number;
  windowMs?: number;
  now?: () => number;
  /** key 数量上限，防止大量不同 IP / 账号把内存撑爆 */
  maxKeys?: number;
}

export type LimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export type KeyedLimitResult =
  | { allowed: true; refund: () => void }
  | { allowed: false; retryAfterSeconds: number };

interface KeyedHit {
  at: number;
  id: number;
}

/**
 * 通用滑动窗口限速器：一个 key（例如用户 ID）在窗口内最多 N 次。
 * 与登录限速同一个思路（同步记一次尝试，避免并发请求突破上限）。
 * 连接检查用它：服务端会替用户去连一个地址，即使有白名单也不要让一个账号把它当成端口扫描器。
 */
export class KeyedLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  private readonly now: () => number;
  private hits = new Map<string, KeyedHit[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;
  private nextId = 1;

  constructor(options: { limit?: number; windowMs?: number; now?: () => number; maxKeys?: number } = {}) {
    this.limit = options.limit ?? 10;
    this.windowMs = options.windowMs ?? 60_000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** 当前保存的 key 数量（测试和排查用） */
  get keyCount(): number {
    return this.hits.size;
  }

  private validateCount(count: number) {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError('KeyedLimiter count 必须是正整数');
    }
  }

  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return;
    for (const [key, arr] of this.hits) {
      const keep = arr.filter((h) => t - h.at < this.windowMs);
      if (keep.length) this.hits.set(key, keep);
      else this.hits.delete(key);
    }
    this.lastSweep = t;
  }

  private recent(key: string, t: number): KeyedHit[] {
    const cur = this.hits.get(key);
    if (!cur) return [];
    const arr = cur.filter((h) => t - h.at < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  private deniedResult(
    arr: KeyedHit[],
    count: number,
    t: number,
  ): { allowed: false; retryAfterSeconds: number } | null {
    const need = arr.length + count - this.limit;
    if (need <= 0) return null;
    const pivot = arr[need - 1];
    const retry = pivot ? Math.max(0, pivot.at + this.windowMs - t) : this.windowMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
  }

  private insert(key: string, count: number, t: number, arr: KeyedHit[]): () => void {
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      for (const k of this.hits.keys()) {
        this.hits.delete(k);
        if (this.hits.size < this.maxKeys) break;
      }
    }
    const firstId = this.nextId;
    for (let i = 0; i < count; i++) {
      arr.push({ at: t, id: this.nextId++ });
    }
    const lastId = this.nextId - 1;
    this.hits.set(key, arr);
    let refunded = false;
    return () => {
      if (refunded) return;
      refunded = true;
      this.removeRange(key, firstId, lastId);
    };
  }

  private removeRange(key: string, firstId: number, lastId: number): void {
    const arr = this.hits.get(key);
    if (!arr?.length) return;
    const keep = arr.filter((h) => h.id < firstId || h.id > lastId);
    if (keep.length === arr.length) return;
    if (keep.length) this.hits.set(key, keep);
    else this.hits.delete(key);
  }

  /**
   * 检查上限并立即记 count 次（默认 1）。
   * 允许时返回精确退回句柄 refund（只退回本次预占插入的记录，幂等且不误删并发或跨窗口的其他记录）；
   * 超过上限时返回还要等多少秒。
   */
  attempt(key: string, count = 1): KeyedLimitResult {
    this.validateCount(count);
    const t = this.now();
    this.sweep(t);
    const arr = this.recent(key, t);
    const denied = this.deniedResult(arr, count, t);
    if (denied) return denied;
    const refund = this.insert(key, count, t, arr);
    return { allowed: true, refund };
  }

  /**
   * 只检查、不记录（只按失败计数的场景：可先 check，失败了才 record，成功的请求不占额度）。
   * check 和随后的 record 之间没有 await 时仍是同步的，不会被并发请求穿插。
   */
  check(key: string, count = 1): LimitResult {
    this.validateCount(count);
    const t = this.now();
    this.sweep(t);
    const arr = this.recent(key, t);
    return this.deniedResult(arr, count, t) ?? { allowed: true };
  }

  /** 记 count 次（默认 1，不检查上限），返回精确退回本次记录的 refund 句柄 */
  record(key: string, count = 1): () => void {
    this.validateCount(count);
    const t = this.now();
    this.sweep(t);
    const arr = this.recent(key, t);
    return this.insert(key, count, t, arr);
  }
}

const pairKey = (ip: string | null, account: string) => `pair:${ip ?? ''}:${account.trim().toLowerCase()}`;
const ipKey = (ip: string | null) => (ip ? `ip:${ip}` : null);

export class LoginLimiter {
  readonly limit: number;
  readonly ipLimit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  private readonly now: () => number;
  private failures = new Map<string, number[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: LoginLimiterOptions = {}) {
    this.limit = options.limit ?? 10;
    this.ipLimit = options.ipLimit ?? 30;
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.maxKeys = options.maxKeys ?? 100_000;
    this.now = options.now ?? Date.now;
  }

  /** 当前保存的 key 数量（测试和排查用） */
  get keyCount(): number {
    return this.failures.size;
  }

  /** 每隔一个窗口清一次所有过期记录，避免不活跃的 key 永远留在内存里 */
  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return;
    for (const [key, arr] of this.failures) {
      const keep = arr.filter((at) => t - at < this.windowMs);
      if (keep.length) this.failures.set(key, keep);
      else this.failures.delete(key);
    }
    this.lastSweep = t;
  }

  /** 去掉窗口外的记录，顺便清理空条目 */
  private recent(key: string, t: number): number[] {
    const arr = (this.failures.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (arr.length) this.failures.set(key, arr);
    else this.failures.delete(key);
    return arr;
  }

  /** 还需要等多久才会低于上限 */
  private retry(arr: number[], limit: number, t: number): number {
    if (arr.length < limit) return 0;
    // 足够的旧记录过期后才会重新允许：需要 arr[length - limit] 及更早的过期
    return Math.max(0, arr[arr.length - limit]! + this.windowMs - t);
  }

  /** 超过 key 上限时按插入顺序淘汰最老的 key，保证内存有界 */
  private ensureCapacity() {
    if (this.failures.size < this.maxKeys) return;
    for (const key of this.failures.keys()) {
      this.failures.delete(key);
      if (this.failures.size < this.maxKeys) break;
    }
  }

  /**
   * 检查上限并立即记一次尝试（同步完成，中间没有 await，避免并发请求突破上限）。
   * 登录成功后用 succeed() 撤销这次 IP + 账号的记录。
   */
  attempt(ip: string | null, account: string): LimitResult {
    const t = this.now();
    this.sweep(t);
    const pair = pairKey(ip, account);
    const ipk = ipKey(ip);
    const pairArr = this.recent(pair, t);
    const ipArr = ipk ? this.recent(ipk, t) : null;
    const retry = Math.max(
      this.retry(pairArr, this.limit, t),
      ipArr ? this.retry(ipArr, this.ipLimit, t) : 0,
    );
    if (retry > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };

    if (!this.failures.has(pair)) this.ensureCapacity();
    pairArr.push(t);
    this.failures.set(pair, pairArr);
    if (ipk && ipArr) {
      if (!this.failures.has(ipk)) this.ensureCapacity();
      ipArr.push(t);
      this.failures.set(ipk, ipArr);
    }
    return { allowed: true };
  }

  /** 登录成功：只清这次 IP + 账号的 key，IP 总量和别的账号的记录保留 */
  succeed(ip: string | null, account: string) {
    this.failures.delete(pairKey(ip, account));
  }
}

/** 32 位有符号整数上限（Node 定时器与滑动窗口安全上界，约 24.8 天） */
const MAX_LIMIT_INT = 2_147_483_647;

/** 环境变量里的正整数（不超过 2^31 - 1）；没设置、非正整数或超上限时返回 undefined（交给默认值） */
const envPositiveInt = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= MAX_LIMIT_INT ? n : undefined;
};

/**
 * 登录失败限速（单副本进程内计数，HA 多副本部署下实际总配额约为设定值 × 副本数）：
 * - DOWEL_LOGIN_LIMIT：同一 IP + 账号在窗口内的尝试次数（默认 10）；
 * - DOWEL_LOGIN_IP_LIMIT：同一 IP 在窗口内的总尝试次数（默认 30；公司 NAT / 反向代理后很多人共用一个 IP 时调大）；
 * - DOWEL_LOGIN_WINDOW_MS：窗口长度（毫秒，默认 600000 = 10 分钟）。
 * e2e 会在一个 IP 上反复登录，所以 playwright.config.ts 里把它调大。
 */
export const loginLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new LoginLimiter({
    limit: envPositiveInt(env.DOWEL_LOGIN_LIMIT),
    ipLimit: envPositiveInt(env.DOWEL_LOGIN_IP_LIMIT),
    windowMs: envPositiveInt(env.DOWEL_LOGIN_WINDOW_MS),
  });

/**
 * 连库探测限速（单副本进程内计数，HA 多副本部署下实际总配额约为设定值 × 副本数）：
 * - DOWEL_CONNECTION_LIMIT：单个用户在窗口内允许的连接检查 / 探测次数（默认 10）；
 * - DOWEL_CONNECTION_WINDOW_MS：窗口长度（毫秒，默认 60000 = 1 分钟）。
 */
export const connectionLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new KeyedLimiter({
    limit: envPositiveInt(env.DOWEL_CONNECTION_LIMIT) ?? 10,
    windowMs: envPositiveInt(env.DOWEL_CONNECTION_WINDOW_MS) ?? 60_000,
  });

/**
 * CI 令牌认证失败限速（按来源 IP，仅计格式合法的失败尝试且不阻断活跃有效令牌；单副本进程内计数，HA 多副本部署下实际总配额约为设定值 × 副本数）：
 * - DOWEL_TOKEN_FAIL_LIMIT：同一 IP 在窗口内允许的格式合法但认证失败次数（默认 20）；
 * - DOWEL_TOKEN_FAIL_WINDOW_MS：窗口长度（毫秒，默认 600000 = 10 分钟）。
 */
export const tokenFailLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new KeyedLimiter({
    limit: envPositiveInt(env.DOWEL_TOKEN_FAIL_LIMIT) ?? 20,
    windowMs: envPositiveInt(env.DOWEL_TOKEN_FAIL_WINDOW_MS) ?? 10 * 60_000,
  });

/**
 * CI 令牌请求速率限速（按令牌；单副本进程内计数，HA 多副本部署下实际总配额约为设定值 × 副本数）：
 * - DOWEL_TOKEN_RATE_LIMIT：单个令牌在窗口内允许的请求次数（默认 120）；
 * - DOWEL_TOKEN_RATE_WINDOW_MS：窗口长度（毫秒，默认 60000 = 1 分钟）。
 */
export const tokenLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new KeyedLimiter({
    limit: envPositiveInt(env.DOWEL_TOKEN_RATE_LIMIT) ?? 120,
    windowMs: envPositiveInt(env.DOWEL_TOKEN_RATE_WINDOW_MS) ?? 60_000,
  });

/**
 * 忘记密码请求限速（单副本进程内计数）：
 * - DOWEL_FORGOT_PASSWORD_LIMIT：同一 IP + 邮箱在窗口内允许的请求次数（默认 3）；
 * - DOWEL_FORGOT_PASSWORD_IP_LIMIT：同一 IP 在窗口内允许的总请求次数（默认 10）；
 * - DOWEL_FORGOT_PASSWORD_WINDOW_MS：窗口长度（毫秒，默认 900000 = 15 分钟）。
 */
export const forgotPasswordLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new LoginLimiter({
    limit: envPositiveInt(env.DOWEL_FORGOT_PASSWORD_LIMIT) ?? 3,
    ipLimit: envPositiveInt(env.DOWEL_FORGOT_PASSWORD_IP_LIMIT) ?? 10,
    windowMs: envPositiveInt(env.DOWEL_FORGOT_PASSWORD_WINDOW_MS) ?? 15 * 60_000,
  });

/**
 * 后台测试邮件发送限速（按管理员用户 ID；单副本进程内计数）：
 * - DOWEL_EMAIL_TEST_LIMIT：单个管理员在窗口内允许的测试发信次数（默认 5）；
 * - DOWEL_EMAIL_TEST_WINDOW_MS：窗口长度（毫秒，默认 60000 = 1 分钟）。
 */
export const emailTestLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new KeyedLimiter({
    limit: envPositiveInt(env.DOWEL_EMAIL_TEST_LIMIT) ?? 5,
    windowMs: envPositiveInt(env.DOWEL_EMAIL_TEST_WINDOW_MS) ?? 60_000,
  });
