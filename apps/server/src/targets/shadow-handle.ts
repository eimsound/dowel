// 外部影子库句柄（PG / MySQL / MSSQL）共用的连接生命周期：操作串行排队、懒建连、出错丢弃连接、关闭后永不重连。
import { ShadowConfigChangedError } from '../shadow.ts';
import type { TargetConnection } from './types.ts';

export interface ShadowConnection {
  /**
   * 排队执行一次影子库操作。`op` 拿到本次要用的连接；连接状态不可信（建连 / 加锁失败、操作没跑完、解锁失败……）时
   * 调 `discard` 丢弃它，下一次操作再重新建连。
   */
  run<T>(op: (conn: TargetConnection, discard: () => Promise<void>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * 关闭语义（Issue #154）：
 * - `close()` 同步把句柄标为已关闭，再关掉当前连接；可重复调用。
 * - 关闭之后**不再建连**：新调用的 `run`、以及排队中还没开始的操作，都直接以 ShadowConfigChangedError 拒绝，
 *   不会拿到正在关闭的连接，也不会 `connect()` 出一条没人负责关闭的新连接（缓存淘汰旧句柄后，拿着它的调用方
 *   不能悄悄连回旧影子库——例如环境已改为生产、禁止同实例影子库）。
 * - 关闭时**正在跑**的操作：它的连接被直接关掉（打断在途语句；PG 驱动最多给 5 秒宽限），无论这次操作本身成功还是失败，
 *   都以 ShadowConfigChangedError 结束、结果丢弃——配置已经变了，旧影子库上得出的结论不能再用。
 */
export const serialShadowConnection = (connect: () => TargetConnection): ShadowConnection => {
  let conn: TargetConnection | null = null;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const discard = async () => {
    const old = conn;
    conn = null;
    await old?.close().catch(() => {});
  };
  return {
    run: <T>(op: (conn: TargetConnection, discard: () => Promise<void>) => Promise<T>): Promise<T> => {
      if (closed) return Promise.reject(new ShadowConfigChangedError());
      const p = queue.then(async () => {
        if (closed) throw new ShadowConfigChangedError();
        conn ??= connect();
        let result: T;
        try {
          result = await op(conn, discard);
        } catch (e) {
          if (closed) throw new ShadowConfigChangedError();
          throw e;
        }
        if (closed) throw new ShadowConfigChangedError();
        return result;
      });
      queue = p.catch(() => {});
      return p;
    },
    close: async () => {
      closed = true;
      await discard();
    },
  };
};
