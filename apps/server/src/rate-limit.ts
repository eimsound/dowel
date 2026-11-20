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
  private hits = new Map<string, number[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;

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

  private sweep(t: number) {
    if (t - this.lastSweep < this.windowMs) return;
    for (const [key, arr] of this.hits) {
      const keep = arr.filter((at) => t - at < this.windowMs);
      if (keep.length) this.hits.set(key, keep);
      else this.hits.delete(key);
    }
    this.lastSweep = t;
  }

  /** 检查上限并立即记一次；超过上限时返回还要等多少秒 */
  attempt(key: string): LimitResult {
    const r = this.check(key);
    if (!r.allowed) return r;
    this.record(key);
    return r;
  }

  /**
   * 只检查、不记录（只按失败计数的场景：CI 令牌认证先 check，失败了才 record，成功的请求不占额度）。
   * check 和随后的 record 之间没有 await 时仍是同步的，不会被并发请求穿插。
   */
  check(key: string): LimitResult {
    const t = this.now();
    this.sweep(t);
    const arr = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      const retry = Math.max(0, arr[arr.length - this.limit]! + this.windowMs - t);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retry / 1000)) };
    }
    return { allowed: true };
  }

  /** 记一次（不检查上限） */
  record(key: string): void {
    const t = this.now();
    const arr = (this.hits.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      for (const k of this.hits.keys()) {
        this.hits.delete(k);
        if (this.hits.size < this.maxKeys) break;
      }
    }
    arr.push(t);
    this.hits.set(key, arr);
  }

  /**
   * 退回最近一次预占（同步 attempt 后，异步校验成功时调用，避免 check → await → record 的并发竞态）。
   */
  refund(key: string): void {
    const arr = this.hits.get(key);
    if (!arr?.length) return;
    arr.pop();
    if (!arr.length) this.hits.delete(key);
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

/** 环境变量里的正数；没设置或不是正数时返回 undefined（交给默认值） */
const envPositive = (value: string | undefined) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * 默认限速设置，可用环境变量覆盖：
 * - DOWEL_LOGIN_LIMIT：同一 IP + 账号在窗口内的尝试次数（默认 10）；
 * - DOWEL_LOGIN_IP_LIMIT：同一 IP 在窗口内的总尝试次数（默认 30；公司 NAT / 反向代理后很多人共用一个 IP 时调大）；
 * - DOWEL_LOGIN_WINDOW_MS：窗口长度（默认 10 分钟）。
 * e2e 会在一个 IP 上反复登录，所以 playwright.config.ts 里把它调大。
 */
export const loginLimiterFromEnv = (env: NodeJS.ProcessEnv = process.env) =>
  new LoginLimiter({
    limit: envPositive(env.DOWEL_LOGIN_LIMIT),
    ipLimit: envPositive(env.DOWEL_LOGIN_IP_LIMIT),
    windowMs: envPositive(env.DOWEL_LOGIN_WINDOW_MS),
  });
