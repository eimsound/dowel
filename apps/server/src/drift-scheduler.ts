// 定时漂移检查（H4）：服务端按固定间隔逐个检查所有环境，结果写进平台库的环境缓存（环境页、图标栏、项目概览显示）。
// 间隔可配，默认 1 小时；测试里不启动它，或者调短间隔 / 直接调用 runOnce()。
import { HTTPException } from 'hono/http-exception';
import type { PlatformDb } from './db.ts';
import type { EnvRow } from './envs.ts';
import { checkEnvDrift, type ExecContext } from './executions.ts';
import type { HaCoordinator } from './ha.ts';
import { scrubSecrets } from './secrets.ts';

/** 默认检查间隔：1 小时 */
export const DEFAULT_DRIFT_INTERVAL_MS = 60 * 60 * 1000;

export class DriftScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private stopped = false;
  private db: PlatformDb;
  private x: ExecContext;
  private ha: HaCoordinator | null;
  /** 每一轮检查结束后调用（P5b：漂移会让执行申请失效，及时检查一遍） */
  afterSweep: (() => void) | null = null;

  constructor(db: PlatformDb, x: ExecContext, ha?: HaCoordinator) {
    this.db = db;
    this.x = x;
    this.ha = ha ?? null;
  }

  /** 按间隔开始定时检查；intervalMs <= 0 表示关闭。定时器不会阻止进程退出 */
  start(intervalMs: number = DEFAULT_DRIFT_INTERVAL_MS) {
    this.stop();
    this.stopped = false;
    if (!(intervalMs > 0)) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 等待正在进行的一轮漂移巡检结束（优雅停机排空用） */
  async drain(): Promise<void> {
    if (this.running) await this.running.catch(() => {});
  }

  get started(): boolean {
    return this.timer !== null;
  }

  /**
   * 检查所有环境一遍，返回检查的环境数。上一轮还没结束时不重叠（返回同一个 Promise）。
   * 多副本下通过 HaCoordinator 分布式任务锁互斥：锁已被其他副本持有时跳过并返回 0。
   * 一个环境出错（连不上、白名单拒绝）不影响其他环境；错误记进该环境的漂移状态（error）。
   */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    const run = async (): Promise<number> => {
      try {
        let n = 0;
        // 没有版本的项目不用查（checkEnvDrift 里会跳过）；先取出行，检查期间环境被删了再查一次就找不到，忽略
        const rows = await this.db.query<EnvRow>('select * from environments order by created_at, id');
        for (const env of rows) {
          if (this.stopped) break;
          try {
            const r = await checkEnvDrift(this.x, env);
            if (!r.skipped) n++;
          } catch (e) {
            if (e instanceof HTTPException && e.status === 404) continue; // 轮到它时环境已经被删了
            console.error('定时漂移检查出错', env.id, e instanceof Error ? scrubSecrets(e.message) : e);
          }
        }
        return n;
      } finally {
        if (!this.stopped) this.afterSweep?.();
      }
    };
    if (!this.ha) return run();
    const res = await this.ha.tryWithJobLock('drift.sweep', run);
    return res.acquired ? res.value : 0;
  }
}
