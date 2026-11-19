// 定时漂移检查（H4）：服务端按固定间隔逐个检查所有环境，结果写进平台库的环境缓存（环境页、图标栏、项目概览显示）。
// 间隔可配，默认 1 小时；测试里不启动它，或者调短间隔 / 直接调用 runOnce()。
import { HTTPException } from 'hono/http-exception';
import type { PlatformDb } from './db.ts';
import type { EnvRow } from './envs.ts';
import { checkEnvDrift, type ExecContext } from './executions.ts';
import { scrubSecrets } from './secrets.ts';

/** 默认检查间隔：1 小时 */
export const DEFAULT_DRIFT_INTERVAL_MS = 60 * 60 * 1000;

export class DriftScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private db: PlatformDb;
  private x: ExecContext;

  constructor(db: PlatformDb, x: ExecContext) {
    this.db = db;
    this.x = x;
  }

  /** 按间隔开始定时检查；intervalMs <= 0 表示关闭。定时器不会阻止进程退出 */
  start(intervalMs: number = DEFAULT_DRIFT_INTERVAL_MS) {
    this.stop();
    if (!(intervalMs > 0)) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get started(): boolean {
    return this.timer !== null;
  }

  /**
   * 检查所有环境一遍，返回检查的环境数。上一轮还没结束时不重叠（返回同一个 Promise）。
   * 一个环境出错（连不上、白名单拒绝）不影响其他环境；错误记进该环境的漂移状态（error）。
   */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async sweep(): Promise<number> {
    let n = 0;
    // 没有版本的项目不用查（checkEnvDrift 里会跳过）；先取出行，检查期间环境被删了再查一次就找不到，忽略
    const rows = await this.db.query<EnvRow>('select * from environments order by created_at, id');
    for (const env of rows) {
      try {
        const r = await checkEnvDrift(this.x, env);
        if (!r.skipped) n++;
      } catch (e) {
        if (e instanceof HTTPException && e.status === 404) continue; // 轮到它时环境已经被删了
        console.error('定时漂移检查出错', env.id, e instanceof Error ? scrubSecrets(e.message) : e);
      }
    }
    return n;
  }
}
