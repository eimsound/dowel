// 副本租约与分布式任务协调器（P7 HA1，ADR 0011）。
// - 每个副本在 ha_leases 表维护自己的心跳租约（key = 'node:<replicaId>'，默认 TTL 15 秒、每 5 秒续租）；
// - 单次续租配备 PG 事务级 statement_timeout / lock_timeout 与 JS 侧有界超时保护，防止半开连接长期占住
//   inFlightRenews 导致后续心跳全部跳过、存活副本租约过期；同时通过代际校验与停机补删防止滞后续租复活已删租约；
// - 心跳续租周期内按节流间隔（默认每 10 分钟）清理过期超过保留宽限期（默认 1 小时）的崩溃节点租约行，
//   防止被 SIGKILL / OOM 强杀的容器在 ha_leases 表永久堆积僵尸行，且不误删未过期、刚过期或非 node: 租约；
// - 优雅停机时有界等待在途续租并主动删除自身租约行，既不卡死停机又便于其他副本立即感知接管；
// - 提供 tryWithJobLock(jobName, fn)，通过平台库 advisory lock 防止多副本重复跑同一轮巡检。
import { randomUUID } from 'node:crypto';

import type { AdvisoryLockResult, PlatformDb } from './db.ts';

export const DEFAULT_LEASE_TTL_MS = 15_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_EXPIRED_LEASE_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_LEASE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MIN_DEFAULT_RENEW_TIMEOUT_MS = 1_000;

const NODE_KEY_PREFIX = 'node:';
const JOB_LOCK_PREFIX = 'job:';

class RenewAbortedError extends Error {
  constructor() {
    super('HA 副本续租已中止');
    this.name = 'RenewAbortedError';
  }
}

type RaceResult<T> = { outcome: 'value'; value: T } | { outcome: 'timeout' } | { outcome: 'aborted' };

/** 在 ms 毫秒内等待 promise 完成，支持外部取消；超时或取消后吞掉原 promise 迟到产生的 rejection，避免未处理异常 */
const raceWithTimeout = <T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<RaceResult<T>> =>
  new Promise((resolve, reject) => {
    const swallow = () => {
      promise.then(
        () => {},
        () => {},
      );
    };
    if (signal?.aborted) {
      swallow();
      resolve({ outcome: 'aborted' });
      return;
    }
    if (ms <= 0) {
      swallow();
      resolve({ outcome: 'timeout' });
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ outcome: 'aborted' });
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({ outcome: 'timeout' });
    }, ms);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ outcome: 'value', value });
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });

const isDbClosedError = (e: unknown): boolean => {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; message?: unknown };
  if (
    err.code === 'CONNECTION_CLOSED' ||
    err.code === 'CONNECTION_DESTROYED' ||
    err.code === 'CONNECTION_ENDED'
  ) {
    return true;
  }
  if (typeof err.message === 'string') {
    return err.message.includes('database is not open') || err.message.includes('PG 平台库连接池已关闭');
  }
  return false;
};

export interface HaCoordinatorOptions {
  /** 当前副本 ID；建议与 EventBus 共用同一个 replicaId */
  replicaId?: string;
  /** 心跳租约有效期（毫秒，默认 15000） */
  ttlMs?: number;
  /** 续租间隔（毫秒，默认 5000） */
  heartbeatIntervalMs?: number;
  /** 单次续租超时上限（毫秒，默认 Math.max(1000, Math.min(heartbeatIntervalMs, Math.floor(ttlMs / 3)))） */
  renewTimeoutMs?: number;
  /** stop() 等待在途续租与删除租约的超时上限（毫秒，默认与 renewTimeoutMs 一致） */
  stopTimeoutMs?: number;
  /** 清理过期节点租约行前的保留宽限期（毫秒，默认 3600000 = 1 小时） */
  expiredLeaseRetentionMs?: number;
  /** 定期清理过期节点租约行的节流间隔（毫秒，默认 600000 = 10 分钟；传 0 或负数禁用自动定期清理） */
  leaseCleanupIntervalMs?: number;
}

export class HaCoordinator {
  readonly replicaId: string;
  readonly renewTimeoutMs: number;
  readonly stopTimeoutMs: number;
  readonly expiredLeaseRetentionMs: number;
  readonly leaseCleanupIntervalMs: number;
  private readonly db: PlatformDb;
  private readonly ttlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly nodeKey: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private generation = 0;
  private inFlightRenews = new Map<Promise<void>, AbortController>();
  private lastCleanupAt = 0;
  private inFlightCleanup: { task: Promise<void>; ac: AbortController } | null = null;

  constructor(db: PlatformDb, options: HaCoordinatorOptions = {}) {
    this.db = db;
    this.replicaId = options.replicaId ?? randomUUID();
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const defaultRenewTimeoutMs = Math.max(
      MIN_DEFAULT_RENEW_TIMEOUT_MS,
      Math.min(this.heartbeatIntervalMs, Math.floor(this.ttlMs / 3)),
    );
    this.renewTimeoutMs =
      options.renewTimeoutMs !== undefined &&
      Number.isFinite(options.renewTimeoutMs) &&
      options.renewTimeoutMs > 0
        ? Math.max(1, Math.floor(options.renewTimeoutMs))
        : defaultRenewTimeoutMs;
    this.stopTimeoutMs =
      options.stopTimeoutMs !== undefined &&
      Number.isFinite(options.stopTimeoutMs) &&
      options.stopTimeoutMs > 0
        ? Math.max(1, Math.floor(options.stopTimeoutMs))
        : this.renewTimeoutMs;
    this.expiredLeaseRetentionMs =
      options.expiredLeaseRetentionMs !== undefined &&
      Number.isFinite(options.expiredLeaseRetentionMs) &&
      options.expiredLeaseRetentionMs >= 0
        ? Math.floor(options.expiredLeaseRetentionMs)
        : DEFAULT_EXPIRED_LEASE_RETENTION_MS;
    this.leaseCleanupIntervalMs =
      options.leaseCleanupIntervalMs !== undefined && Number.isFinite(options.leaseCleanupIntervalMs)
        ? Math.max(0, Math.floor(options.leaseCleanupIntervalMs))
        : DEFAULT_LEASE_CLEANUP_INTERVAL_MS;
    this.nodeKey = `${NODE_KEY_PREFIX}${this.replicaId}`;
  }

  /** 启动心跳续租：先同步写入一次租约，再按间隔定时续租（幂等） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startGen = ++this.generation;
    try {
      await this.renew();
    } catch (e) {
      if (this.generation === startGen) {
        this.running = false;
        this.generation++;
      }
      throw e;
    }
    // 首次续租期间若已被 stop()，不再启动心跳定时器
    if (!this.running || this.generation !== startGen) return;
    this.lastCleanupAt = Date.now();
    this.timer = setInterval(() => {
      if (!this.running || this.inFlightRenews.size > 0) return;
      this.renew()
        .then(() => {
          this.maybeCleanupExpiredLeases();
        })
        .catch((e) => {
          if (e instanceof RenewAbortedError) return;
          console.error(`HA 副本心跳续租失败（replica=${this.replicaId}）`, e);
        });
    }, this.heartbeatIntervalMs);
    this.timer.unref?.();
  }

  /** 停止心跳并主动删除本副本的租约行（幂等；等待在途续租与删租约均有界超时，防止半开连接卡死停机） */
  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 有界等待进行中的 renew 与过期租约清理结束再删除，防止半开连接无限卡死停机
    if (this.inFlightRenews.size > 0 || this.inFlightCleanup) {
      const pendingRenews = [...this.inFlightRenews.entries()];
      const pendingCleanup = this.inFlightCleanup;
      const tasks: Promise<unknown>[] = pendingRenews.map(([task]) => task);
      if (pendingCleanup) tasks.push(pendingCleanup.task);
      const raced = await raceWithTimeout(Promise.allSettled(tasks), this.stopTimeoutMs);
      if (raced.outcome === 'timeout') {
        for (const [task, ac] of pendingRenews) {
          this.inFlightRenews.delete(task);
          ac.abort();
        }
        if (pendingCleanup) {
          pendingCleanup.ac.abort();
          if (this.inFlightCleanup === pendingCleanup) this.inFlightCleanup = null;
        }
        console.warn(
          `HA 副本停机等待在途续租超时（replica=${this.replicaId}, timeoutMs=${this.stopTimeoutMs}），将直接尝试删除租约`,
        );
      }
    }
    if (!wasRunning) return;
    await this.deleteLeaseWithTimeout();
  }

  /** 续租本副本的心跳租约（PG 上使用数据库 now()，消除副本间时钟漂移；带单次超时上限防止半开连接阻塞后续心跳） */
  async renew(): Promise<void> {
    const renewGen = this.generation;
    const ac = new AbortController();
    let timedOut = false;
    const isAborted = () => timedOut || ac.signal.aborted || this.generation !== renewGen;

    const rawTask = this.executeRenew(isAborted);

    // 若本次续租在超时或停机后才迟到提交成功，且协调器已停机且未重新启动，
    // 立即补发一次幂等删除，避免滞后的旧 renew 在 stop() 删租约后重新复活租约行。
    rawTask.then(
      () => {
        if (!this.running && this.generation !== renewGen) {
          this.deleteLeaseBestEffort('滞后续租落盘后补删租约');
        }
      },
      (e) => {
        if (e instanceof RenewAbortedError) return;
        if (timedOut && !ac.signal.aborted) {
          console.warn(`HA 副本超时后的滞后续租最终失败（replica=${this.replicaId}）`, e);
        }
      },
    );

    const boundedTask = (async () => {
      const raced = await raceWithTimeout(rawTask, this.renewTimeoutMs, ac.signal);
      if (raced.outcome === 'aborted') {
        throw new RenewAbortedError();
      }
      if (raced.outcome === 'timeout') {
        timedOut = true;
        throw new Error(`HA 副本心跳续租超时（replica=${this.replicaId}, timeoutMs=${this.renewTimeoutMs}）`);
      }
    })();

    this.inFlightRenews.set(boundedTask, ac);
    try {
      await boundedTask;
    } finally {
      this.inFlightRenews.delete(boundedTask);
    }
  }

  private async executeRenew(isAborted: () => boolean): Promise<void> {
    if (isAborted()) throw new RenewAbortedError();
    if (this.db.dialect === 'pg') {
      // PG 服务端超时略紧于 JS 侧兜底超时，让正常连通时的锁等待/慢查询优先返回精确的 PG 错误并立即释放服务端事务
      const pgTimeoutMs = Math.max(1, Math.floor(this.renewTimeoutMs * 0.9));
      const timeoutParam = `${pgTimeoutMs}ms`;
      await this.db.transaction(async (tx) => {
        if (isAborted()) throw new RenewAbortedError();
        // 仅在本次续租事务内生效（is_local = true），事务提交/回滚后自动恢复，不污染连接池其他查询
        await tx.query(
          "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
          [timeoutParam],
        );
        if (isAborted()) throw new RenewAbortedError();
        await tx.query(
          `insert into ha_leases (key, owner, expires_at, updated_at)
           values ($1, $2, now() + ($3::double precision * interval '1 millisecond'), now())
           on conflict (key) do update
             set owner = excluded.owner,
                 expires_at = excluded.expires_at,
                 updated_at = excluded.updated_at`,
          [this.nodeKey, this.replicaId, this.ttlMs],
        );
        // COMMIT 前再次校验：超时或已停机的滞后续租直接回滚，绝不提交落盘复活租约
        if (isAborted()) throw new RenewAbortedError();
      });
      return;
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    await this.db.query(
      `insert into ha_leases (key, owner, expires_at, updated_at)
       values ($1, $2, $3, $4)
       on conflict (key) do update
         set owner = excluded.owner,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at
       where ha_leases.expires_at <= excluded.expires_at`,
      [this.nodeKey, this.replicaId, expiresAt, now],
    );
  }

  private async deleteLease(): Promise<void> {
    if (this.db.dialect === 'pg') {
      const pgTimeoutMs = Math.max(1, Math.floor(this.stopTimeoutMs * 0.9));
      const timeoutParam = `${pgTimeoutMs}ms`;
      await this.db.transaction(async (tx) => {
        await tx.query(
          "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
          [timeoutParam],
        );
        await tx.query('delete from ha_leases where key = $1 and owner = $2', [this.nodeKey, this.replicaId]);
      });
      return;
    }
    await this.db.query('delete from ha_leases where key = $1 and owner = $2', [
      this.nodeKey,
      this.replicaId,
    ]);
  }

  private async deleteLeaseWithTimeout(): Promise<void> {
    try {
      const raced = await raceWithTimeout(this.deleteLease(), this.stopTimeoutMs);
      if (raced.outcome === 'timeout') {
        console.warn(`HA 副本停机删除租约超时（replica=${this.replicaId}, timeoutMs=${this.stopTimeoutMs}）`);
      }
    } catch (e) {
      if (isDbClosedError(e)) return;
      console.error(`HA 副本停机删除租约失败（replica=${this.replicaId}）`, e);
    }
  }

  private deleteLeaseBestEffort(reason: string): void {
    void raceWithTimeout(this.deleteLease(), this.stopTimeoutMs).then(
      (raced) => {
        if (raced.outcome === 'timeout') {
          console.warn(`HA 副本${reason}超时（replica=${this.replicaId}, timeoutMs=${this.stopTimeoutMs}）`);
        }
      },
      (e) => {
        if (isDbClosedError(e)) return;
        console.warn(`HA 副本${reason}失败（replica=${this.replicaId}）`, e);
      },
    );
  }

  private maybeCleanupExpiredLeases(): void {
    if (!this.running || this.leaseCleanupIntervalMs <= 0 || this.inFlightCleanup) return;
    const now = Date.now();
    if (now - this.lastCleanupAt < this.leaseCleanupIntervalMs) return;
    this.lastCleanupAt = now;
    const ac = new AbortController();
    const entry = { task: Promise.resolve(), ac };
    entry.task = this.cleanupExpiredLeases(ac.signal)
      .then(() => {})
      .catch((e) => {
        if (isDbClosedError(e)) return;
        console.warn(`HA 副本清理过期节点租约失败（replica=${this.replicaId}）`, e);
      })
      .finally(() => {
        if (this.inFlightCleanup === entry) this.inFlightCleanup = null;
      });
    this.inFlightCleanup = entry;
  }

  /**
   * 清理过期超过保留宽限期（默认 1 小时）的崩溃节点租约行。
   * 仅删除 `node:*` 前缀且排除当前副本自身，不误删未过期、刚过期或非 `node:` 租约（如 `job:*`）。
   * 返回删除的行数；受单次续租超时上限约束。
   */
  async cleanupExpiredLeases(signal?: AbortSignal): Promise<number> {
    const raced = await raceWithTimeout(this.executeCleanupExpiredLeases(), this.renewTimeoutMs, signal);
    if (raced.outcome === 'aborted') return 0;
    if (raced.outcome === 'timeout') {
      throw new Error(
        `HA 副本清理过期节点租约超时（replica=${this.replicaId}, timeoutMs=${this.renewTimeoutMs}）`,
      );
    }
    return raced.value;
  }

  private async executeCleanupExpiredLeases(): Promise<number> {
    if (this.db.dialect === 'pg') {
      const pgTimeoutMs = Math.max(1, Math.floor(this.renewTimeoutMs * 0.9));
      const timeoutParam = `${pgTimeoutMs}ms`;
      const rows = await this.db.transaction(async (tx) => {
        await tx.query(
          "select set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
          [timeoutParam],
        );
        return tx.query<{ key: string }>(
          `delete from ha_leases
            where key like 'node:%'
              and key <> $1
              and expires_at < now() - ($2::double precision * interval '1 millisecond')
          returning key`,
          [this.nodeKey, this.expiredLeaseRetentionMs],
        );
      });
      return rows.length;
    }
    const cutoff = new Date(Date.now() - this.expiredLeaseRetentionMs);
    const rows = await this.db.query<{ key: string }>(
      `delete from ha_leases
        where key like 'node:%'
          and key <> $1
          and expires_at < $2
      returning key`,
      [this.nodeKey, cutoff],
    );
    return rows.length;
  }

  /** 判断指定副本当前租约是否仍有效 */
  async isNodeAlive(nodeId: string): Promise<boolean> {
    const key = `${NODE_KEY_PREFIX}${nodeId}`;
    const rows =
      this.db.dialect === 'pg'
        ? await this.db.query<{ ok: number }>(
            'select 1 as ok from ha_leases where key = $1 and expires_at > now()',
            [key],
          )
        : await this.db.query<{ ok: number }>(
            'select 1 as ok from ha_leases where key = $1 and expires_at > $2',
            [key, new Date()],
          );
    return rows.length > 0;
  }

  /** 返回当前所有存活副本的 replicaId 集合 */
  async aliveNodes(): Promise<Set<string>> {
    const rows =
      this.db.dialect === 'pg'
        ? await this.db.query<{ owner: string }>(
            "select owner from ha_leases where key like 'node:%' and expires_at > now()",
          )
        : await this.db.query<{ owner: string }>(
            "select owner from ha_leases where key like 'node:%' and expires_at > $1",
            [new Date()],
          );
    return new Set(rows.map((r) => r.owner));
  }

  /** 当前协调器是否运行在跨副本分布式模式（PG 平台库） */
  get isDistributed(): boolean {
    return this.db.dialect === 'pg';
  }

  /** 尝试独占运行一项分布式定时任务：拿不到锁立即跳过（不阻塞） */
  tryWithJobLock<T>(jobName: string, fn: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
    return this.db.withAdvisoryLock(`${JOB_LOCK_PREFIX}${jobName}`, fn, { tryOnly: true });
  }

  /** 阻塞等待并独占运行一项分布式任务（超时未拿到锁时返回 { acquired: false }） */
  withJobLock<T>(
    jobName: string,
    fn: () => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<AdvisoryLockResult<T>> {
    return this.db.withAdvisoryLock(`${JOB_LOCK_PREFIX}${jobName}`, fn, {
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }
}
