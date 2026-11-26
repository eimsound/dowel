// 执行申请巡检的调度：定时心跳、事件驱动的 kick（合并成一轮）、显式 await sweep()、撞锁后的短延迟重试，
// 以及多副本下经分布式任务锁（requests.sweep）互斥。一轮巡检本身做什么由构造时传入的 run 决定（service.ts 的 runSweep）。
//
// 防坑（#22）：显式 sweep() 用带超时的阻塞锁，未获锁时绝不误推进 done、也不丢弃并入的 kick 重试；
// 后台定时 / kick 巡检用非阻塞锁，kick 撞锁时短延迟重试（有上限，另有定时巡检兜底）。所有定时器都 unref()。
// stopped 状态由 Requests 持有（isStopped）：停机后不再续跑、不再重试。
import type { HaCoordinator } from '../ha.ts';
import { scrubSecrets } from '../secrets.ts';

/** 重检的范围：全部，或者受影响的环境 / 项目 / 组（组层策略变了：组里所有项目） */
export interface SweepTarget {
  all?: boolean;
  envIds?: string[];
  projectIds?: string[];
  groupIds?: string[];
}

/** 定时清理的默认间隔：30 秒（过期、失效的申请转成终态并通知申请人） */
export const REQUEST_SWEEP_MS = 30_000;
/** 显式 sweep() 等待分布式巡检锁的默认超时时间 */
export const SWEEP_LOCK_TIMEOUT_MS = 30_000;
/** 事件驱动 kick 未拿到分布式锁时的默认重试间隔 */
export const SWEEP_KICK_RETRY_MS = 200;
/** 事件驱动 kick 连续撞锁时的最大重试次数（避免锁长期被占时无限自旋；另有 30 秒周期巡检兜底） */
const MAX_SWEEP_KICK_RETRIES = 25;

export interface SweepScope {
  all: boolean;
  envs: Set<string>;
  projects: Set<string>;
  groups: Set<string>;
}

interface PendingSweep extends SweepScope {
  /** 是否有显式 await sweep() 调用者在等待：需要阻塞等锁直到跑完 */
  blocking: boolean;
  /** 是否包含事件驱动的 kick（非单纯定时心跳）：未获锁时需要短延迟重试而非静默丢弃 */
  retryOnContention: boolean;
}

interface SweepOnceResult {
  acquired: boolean;
  count: number;
}

const emptyScope = (): SweepScope => ({
  all: false,
  envs: new Set(),
  projects: new Set(),
  groups: new Set(),
});

const mergeScope = (dst: SweepScope, src: SweepTarget | SweepScope): void => {
  if (src.all) dst.all = true;
  if ('envs' in src) {
    for (const id of src.envs) dst.envs.add(id);
    for (const id of src.projects) dst.projects.add(id);
    for (const id of src.groups) dst.groups.add(id);
  } else {
    for (const id of src.envIds ?? []) dst.envs.add(id);
    for (const id of src.projectIds ?? []) dst.projects.add(id);
    for (const id of src.groupIds ?? []) dst.groups.add(id);
  }
};

export interface SweepSchedulerOptions {
  /** 副本租约与分布式任务协调器（可选）：有它时巡检经 requests.sweep 任务锁跨副本互斥 */
  ha: HaCoordinator | null;
  /** 显式 sweep() 等待分布式巡检锁的超时时间（毫秒） */
  lockTimeoutMs: number;
  /** 事件驱动 kick 未获锁时的短延迟重试间隔（毫秒） */
  retryMs: number;
  /** 是否已停机（Requests 持有的状态） */
  isStopped: () => boolean;
  /** 一轮巡检：返回处理了几个 */
  run: (t: SweepScope) => Promise<number>;
}

export class SweepScheduler {
  private readonly ha: HaCoordinator | null;
  private readonly lockTimeoutMs: number;
  private readonly retryMs: number;
  private readonly isStopped: () => boolean;
  private readonly run: (t: SweepScope) => Promise<number>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPending: SweepScope | null = null;
  private retryAttempts = 0;
  /** 排着的检查范围（合并）；queued / done 是代数：sweep() 等到包含自己那一次的一轮跑完 */
  private pending: PendingSweep | null = null;
  private queued = 0;
  private done = 0;
  private draining: Promise<number> | null = null;

  constructor(o: SweepSchedulerOptions) {
    this.ha = o.ha;
    this.lockTimeoutMs = o.lockTimeoutMs;
    this.retryMs = o.retryMs;
    this.isStopped = o.isStopped;
    this.run = o.run;
  }

  /** 正在进行的一轮（或几轮连续的）巡检；没有时 null（优雅停机排空用） */
  get inProgress(): Promise<number> | null {
    return this.draining;
  }

  /** 按间隔触发定时巡检（定时器 unref，不拖住进程退出） */
  startTimer(intervalMs: number): void {
    this.timer = setInterval(() => this.triggerPeriodicSweep(), intervalMs);
    this.timer.unref?.();
  }

  /** 停机：清掉全部定时器与重试；没有显式 sweep() 在等的排队范围直接丢弃（显式等待的仍由 sweep() 自己跑完或报错） */
  halt(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.kickTimer = null;
    this.clearRetry();
    this.retryAttempts = 0;
    if (this.pending && !this.pending.blocking) this.pending = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryPending = null;
  }

  private scheduleRetry(t: SweepScope): void {
    if (this.isStopped() || this.retryAttempts >= MAX_SWEEP_KICK_RETRIES) {
      this.clearRetry();
      return;
    }
    this.retryAttempts++;
    this.retryPending ??= emptyScope();
    mergeScope(this.retryPending, t);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      const retry = this.retryPending;
      this.retryPending = null;
      if (this.isStopped() || !retry) return;
      this.enqueue(retry, 'kick');
      void this.drainPending().catch((e) => {
        console.error('重试检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private enqueue(t: SweepTarget | SweepScope, mode: 'periodic' | 'kick' | 'blocking'): number {
    this.pending ??= { ...emptyScope(), blocking: false, retryOnContention: false };
    mergeScope(this.pending, t);
    if (mode === 'blocking') this.pending.blocking = true;
    if (mode === 'kick') this.pending.retryOnContention = true;
    // 非单纯定时心跳触发时，若已有挂起的短延迟重试目标则顺手并入本轮
    if (this.retryPending && mode !== 'periodic') {
      mergeScope(this.pending, this.retryPending);
      this.pending.retryOnContention = true;
      this.clearRetry();
    }
    return ++this.queued;
  }

  private triggerPeriodicSweep(): void {
    if (this.isStopped()) return;
    this.enqueue({ all: true }, 'periodic');
    void this.drainPending().catch((e) => {
      console.error('定时检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
    });
  }

  /** 本副本的事件驱动巡检（非阻塞；合并成一轮，撞锁时短延迟重试） */
  kickLocal(t: SweepTarget) {
    if (this.isStopped()) return;
    this.retryAttempts = 0;
    this.enqueue(t, 'kick');
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      if (this.isStopped()) return;
      void this.drainPending().catch((e) => {
        console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }, 0);
    this.kickTimer.unref?.();
  }

  /** 检查一个范围：等到包含这次请求的那一轮跑完，返回处理了几个 */
  async sweep(t: SweepTarget): Promise<number> {
    const mine = this.enqueue(t, 'blocking');
    let n = 0;
    while (this.done < mine) n += await this.drainPending();
    return n;
  }

  private pendingBlocking(): PendingSweep | null {
    return this.pending?.blocking ? this.pending : null;
  }

  private drainPending(): Promise<number> {
    this.draining ??= (async () => {
      let n = 0;
      while (this.pending) {
        if (this.kickTimer) {
          clearTimeout(this.kickTimer);
          this.kickTimer = null;
        }
        const t = this.pending;
        const gen = this.queued;
        this.pending = null;
        let res: SweepOnceResult;
        try {
          res = await this.sweepOnce(t);
        } catch (e) {
          console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
          this.done = gen;
          if (this.isStopped()) break;
          continue;
        }
        if (res.acquired) {
          n += res.count;
          this.done = gen;
          this.retryAttempts = 0;
          if (t.all) this.clearRetry();
        } else if (t.blocking) {
          // 显式 sweep() 阻塞等锁超时：绝不误推进 done，也不丢弃合并进来的 kick 重试
          if (t.retryOnContention && !this.isStopped()) this.scheduleRetry(t);
          throw new Error('等待执行申请巡检锁超时');
        } else if (t.retryOnContention && !this.isStopped()) {
          // 事件驱动 kick 未拿到锁：若已有后续显式 sweep() 排队则直接并入，否则短延迟重试，防止跨副本撞锁/总线瞬断丢弃
          const queuedBlocking = this.pendingBlocking();
          if (queuedBlocking) {
            mergeScope(queuedBlocking, t);
            queuedBlocking.retryOnContention = true;
          } else {
            this.scheduleRetry(t);
          }
        }
        if (this.isStopped()) break;
      }
      return n;
    })().finally(() => {
      this.draining = null;
      // 循环结束和这里之间又排进来的：再跑一轮，不能丢（停机后不再续跑）
      if (!this.isStopped() && this.pending) {
        void this.drainPending().catch((e) => {
          console.error('检查执行申请失败', e instanceof Error ? scrubSecrets(e.message) : e);
        });
      }
    });
    return this.draining;
  }

  /**
   * 分布式巡检入口：多副本下通过 advisory lock 互斥，同一时刻只有一个副本跑巡检。
   * - 显式 sweep()（blocking = true）使用阻塞等锁，确保等待锁释放并跑完目标范围后再推进 done；
   * - 后台定时 / kick 巡检使用非阻塞 tryWithJobLock，避免后台周期巡检互相阻塞。
   */
  private async sweepOnce(t: PendingSweep): Promise<SweepOnceResult> {
    const run = () => this.run(t);
    if (!this.ha) return { acquired: true, count: await run() };
    const res = t.blocking
      ? await this.ha.withJobLock('requests.sweep', run, { timeoutMs: this.lockTimeoutMs })
      : await this.ha.tryWithJobLock('requests.sweep', run);
    return res.acquired ? { acquired: true, count: res.value } : { acquired: false, count: 0 };
  }
}
