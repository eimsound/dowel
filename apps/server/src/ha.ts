// 副本租约与分布式任务协调器（P7 HA1，ADR 0011）。
// - 每个副本在 ha_leases 表维护自己的心跳租约（key = 'node:<replicaId>'，默认 TTL 15 秒、每 5 秒续租）；
// - 优雅停机时主动删除自身租约行，便于其他副本立即感知并接管中断的执行申请；
// - 提供 tryWithJobLock(jobName, fn)，通过平台库 advisory lock 防止多副本重复跑同一轮巡检。
import { randomUUID } from 'node:crypto';
import type { AdvisoryLockResult, PlatformDb } from './db.ts';

export const DEFAULT_LEASE_TTL_MS = 15_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

const NODE_KEY_PREFIX = 'node:';
const JOB_LOCK_PREFIX = 'job:';

export interface HaCoordinatorOptions {
  /** 当前副本 ID；建议与 EventBus 共用同一个 replicaId */
  replicaId?: string;
  /** 心跳租约有效期（毫秒，默认 15000） */
  ttlMs?: number;
  /** 续租间隔（毫秒，默认 5000） */
  heartbeatIntervalMs?: number;
}

export class HaCoordinator {
  readonly replicaId: string;
  private readonly db: PlatformDb;
  private readonly ttlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly nodeKey: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlightRenew: Promise<void> | null = null;

  constructor(db: PlatformDb, options: HaCoordinatorOptions = {}) {
    this.db = db;
    this.replicaId = options.replicaId ?? randomUUID();
    this.ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.nodeKey = `${NODE_KEY_PREFIX}${this.replicaId}`;
  }

  /** 启动心跳续租：先同步写入一次租约，再按间隔定时续租（幂等） */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.renew();
    } catch (e) {
      this.running = false;
      throw e;
    }
    this.timer = setInterval(() => {
      if (!this.running || this.inFlightRenew) return;
      this.renew().catch((e) => {
        console.error(`HA 副本心跳续租失败（replica=${this.replicaId}）`, e);
      });
    }, this.heartbeatIntervalMs);
    this.timer.unref?.();
  }

  /** 停止心跳并主动删除本副本的租约行（幂等） */
  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 等进行中的 renew 结束再删除，防止旧 renew 在 delete 之后重新写回租约行
    if (this.inFlightRenew) {
      await this.inFlightRenew.catch(() => {});
    }
    if (!wasRunning) return;
    await this.db.query('delete from ha_leases where key = $1 and owner = $2', [
      this.nodeKey,
      this.replicaId,
    ]);
  }

  /** 续租本副本的心跳租约（PG 上使用数据库 now()，消除副本间时钟漂移） */
  async renew(): Promise<void> {
    const task = (async () => {
      if (this.db.dialect === 'pg') {
        await this.db.query(
          `insert into ha_leases (key, owner, expires_at, updated_at)
           values ($1, $2, now() + ($3::double precision * interval '1 millisecond'), now())
           on conflict (key) do update
             set owner = excluded.owner,
                 expires_at = excluded.expires_at,
                 updated_at = excluded.updated_at`,
          [this.nodeKey, this.replicaId, this.ttlMs],
        );
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
               updated_at = excluded.updated_at`,
        [this.nodeKey, this.replicaId, expiresAt, now],
      );
    })();
    this.inFlightRenew = task;
    try {
      await task;
    } finally {
      if (this.inFlightRenew === task) this.inFlightRenew = null;
    }
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
