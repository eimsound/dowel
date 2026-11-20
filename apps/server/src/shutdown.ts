// 优雅停机（#19）：幂等防重入、停止新巡检与长连接、排空在途 HTTP/SSE/迁移锁与后台任务，
// 排空完成后再按依赖顺序关闭 webhooks / rooms / shadows / bus / ha / db，并配备 unref 兜底超时。

/** 默认优雅停机兜底超时（毫秒） */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 25_000;

export interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export interface ClosableWebSocket {
  readyState: number;
  close(code?: number, data?: string): void;
  terminate?: () => void;
}

export interface ClosableWebSocketServer {
  clients: Iterable<ClosableWebSocket>;
  close(callback?: (err?: Error) => void): void;
  on?(event: 'connection', listener: (ws: ClosableWebSocket) => void): unknown;
  off?(event: 'connection', listener: (ws: ClosableWebSocket) => void): unknown;
}

export interface ShutdownDeps {
  server: ClosableServer;
  wss?: ClosableWebSocketServer;
  drift: { stop(): void; drain?(): Promise<void> };
  requests: { stop(): void; drain?(): Promise<void> };
  refresher?: { stop(): void; drain(): Promise<void> };
  locks: { drain(): Promise<void> };
  webhooks: { close(): Promise<void> };
  rooms: {
    disconnectAll?(code?: number, reason?: string): Promise<void> | void;
    flush(): Promise<void>;
    close(): void;
  };
  shadows: { close(): Promise<void> };
  bus: { close(): Promise<void> };
  ha: { stop(): Promise<void> };
  db: { close(): Promise<void> };
  /** 兜底强制退出超时（毫秒，默认 25000） */
  timeoutMs?: number;
  /** 优雅关闭 WebSocket 后的宽限时长（毫秒），超时后仅对残留 WS 连接调用 terminate */
  wsCloseGraceMs?: number;
  /** 超时强制退出前触发的钩子（测试或监控用） */
  onTimeout?: () => void;
  /** 退出回调（默认 process.exit） */
  onExit?: (code: number) => void;
  /** 日志输出（默认 console） */
  log?: {
    info?: (message: string) => void;
    error?: (message: string, err?: unknown) => void;
  };
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

const terminateWebSockets = (wss?: ClosableWebSocketServer) => {
  if (!wss) return;
  for (const ws of wss.clients) {
    try {
      if (ws.terminate) ws.terminate();
      else ws.close(1001, '服务正在关闭');
    } catch {}
  }
};

const isNotRunningError = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';

/**
 * 执行一次完整的优雅停机序列：
 * 1. 停止后台新巡检与主动关闭空闲长连接（drift / requests / refresher）；
 * 2. 停止接收新 HTTP 连接、关闭空闲 keep-alive 连接，并优雅关闭在线 WebSocket；
 * 3. 等待在途 HTTP/SSE 请求、环境锁、派生刷新与在途巡检/收尾全部排空（此时 webhooks / ha / db 均保持存活）；
 * 4. 排空完成后依次关闭：webhooks → rooms.flush → rooms.close → shadows → bus → ha → db；
 * 5. 清理兜底定时器并触发退出回调。
 */
export const gracefulShutdown = async (deps: ShutdownDeps, signal?: string): Promise<void> => {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const wsCloseGraceMs = deps.wsCloseGraceMs ?? Math.min(5_000, Math.max(50, Math.floor(timeoutMs / 2)));
  const logError = (message: string, err?: unknown) => {
    if (deps.log?.error) deps.log.error(message, err);
    else if (err !== undefined) console.error(message, err);
    else console.error(message);
  };
  const onExit = deps.onExit ?? ((code: number) => process.exit(code));

  let timedOut = false;
  let exited = false;
  let hasError = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let wsGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSweepTimer: ReturnType<typeof setInterval> | null = null;
  let onLateWsConnection: ((ws: ClosableWebSocket) => void) | null = null;

  const cleanupTimersAndListeners = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (wsGraceTimer) {
      clearTimeout(wsGraceTimer);
      wsGraceTimer = null;
    }
    if (idleSweepTimer) {
      clearInterval(idleSweepTimer);
      idleSweepTimer = null;
    }
    if (onLateWsConnection) {
      deps.wss?.off?.('connection', onLateWsConnection);
      onLateWsConnection = null;
    }
  };

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    onExit(code);
  };

  const safeStep = async (label: string, fn: () => unknown) => {
    try {
      await fn();
    } catch (err) {
      hasError = true;
      logError(`停机步骤失败（${label}）`, err);
    }
  };

  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) return;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      timeoutTimer = null;
      logError(`优雅停机超时（${timeoutMs}ms${signal ? `，信号 ${signal}` : ''}），强制终止残留连接并退出`);
      cleanupTimersAndListeners();
      terminateWebSockets(deps.wss);
      try {
        deps.server.closeAllConnections?.();
      } catch {}
      try {
        deps.onTimeout?.();
      } finally {
        exitOnce(1);
        resolve('timeout');
      }
    }, timeoutMs);
    timeoutTimer.unref?.();
  });

  const sequencePromise = (async (): Promise<'done'> => {
    // 第 1 步：停止后台新巡检，清掉未触发的防抖调度，主动关闭活跃收件箱 SSE 长连接
    await safeStep('停止漂移定时检查', () => deps.drift.stop());
    await safeStep('停止执行申请巡检与收件箱 SSE', () => deps.requests.stop());
    await safeStep('停止派生刷新调度', () => deps.refresher?.stop());
    if (timedOut) return 'done';

    // 第 2 步：停止接受新 HTTP 连接、关闭空闲 keep-alive 连接，并主动优雅关闭在线 WebSocket
    let serverDone = false;
    const serverClosed = new Promise<void>((resolve) => {
      const finish = () => {
        serverDone = true;
        resolve();
      };
      try {
        deps.server.close((err) => {
          if (err && !isNotRunningError(err)) {
            hasError = true;
            logError('关闭 HTTP 服务器出错', err);
          }
          finish();
        });
      } catch (err) {
        if (!isNotRunningError(err)) {
          hasError = true;
          logError('关闭 HTTP 服务器出错', err);
        }
        finish();
      }
    });

    try {
      deps.server.closeIdleConnections?.();
    } catch {}
    // 已在停机前发送响应头的 HTTP/1.1 keep-alive 连接（尤其是 SSE 流）在 res.end() 后会回到空闲态，
    // 定期补扫 closeIdleConnections 可立即回收这类已结束请求的连接而不打断任何在途请求
    if (!serverDone && deps.server.closeIdleConnections) {
      idleSweepTimer = setInterval(() => {
        if (serverDone || timedOut) return;
        try {
          deps.server.closeIdleConnections?.();
        } catch {}
      }, 50);
      idleSweepTimer.unref?.();
    }

    if (deps.wss) {
      onLateWsConnection = (ws) => {
        try {
          ws.close(1001, '服务正在关闭');
        } catch {}
      };
      deps.wss.on?.('connection', onLateWsConnection);
      let hasOpenWs = false;
      for (const ws of deps.wss.clients) {
        if (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN) {
          hasOpenWs = true;
          try {
            ws.close(1001, '服务正在关闭');
          } catch {}
        }
      }
      try {
        deps.wss.close();
      } catch {}
      if (hasOpenWs && wsCloseGraceMs > 0 && Number.isFinite(wsCloseGraceMs)) {
        wsGraceTimer = setTimeout(() => {
          wsGraceTimer = null;
          terminateWebSockets(deps.wss);
        }, wsCloseGraceMs);
        wsGraceTimer.unref?.();
      }
    }
    await safeStep('断开房间在线连接', () => deps.rooms.disconnectAll?.(1001, '服务正在关闭'));
    if (timedOut) return 'done';

    // 第 3 步：等待在途 HTTP/SSE 请求、环境锁、派生刷新以及在途后台巡检/收尾全部排空
    // 排空期间 webhooks、ha（心跳租约）与 db（平台数据库连接池）全部保持存活
    await Promise.all([
      serverClosed.finally(() => {
        if (wsGraceTimer) {
          clearTimeout(wsGraceTimer);
          wsGraceTimer = null;
        }
        if (idleSweepTimer) {
          clearInterval(idleSweepTimer);
          idleSweepTimer = null;
        }
        if (onLateWsConnection) {
          deps.wss?.off?.('connection', onLateWsConnection);
          onLateWsConnection = null;
        }
      }),
      safeStep('排空环境锁', () => deps.locks.drain()),
      safeStep('排空派生刷新', () => deps.refresher?.drain()),
      safeStep('排空漂移巡检', () => deps.drift.drain?.()),
      safeStep('排空执行申请后台任务', () => deps.requests.drain?.()),
    ]);
    if (timedOut) return 'done';

    // 复查一轮：确保在途请求释放锁后紧接着启动的收尾动作（如 finish / afterDirectRun）也已落库
    await Promise.all([
      safeStep('复查环境锁排空', () => deps.locks.drain()),
      safeStep('复查派生刷新排空', () => deps.refresher?.drain()),
      safeStep('复查执行申请收尾排空', () => deps.requests.drain?.()),
    ]);
    if (timedOut) return 'done';

    // 第 4 步：在途请求与迁移全部排空后，按依赖顺序依次关闭基础设施
    await safeStep('关闭 Webhook 队列', () => deps.webhooks.close());
    if (timedOut) return 'done';
    await safeStep('落库房间画布布局', () => deps.rooms.flush());
    if (timedOut) return 'done';
    await safeStep('关闭房间事件总线订阅', () => deps.rooms.close());
    if (timedOut) return 'done';
    await safeStep('关闭影子库连接', () => deps.shadows.close());
    if (timedOut) return 'done';
    await safeStep('关闭跨副本事件总线', () => deps.bus.close());
    if (timedOut) return 'done';
    await safeStep('停止 HA 心跳并释放租约', () => deps.ha.stop());
    if (timedOut) return 'done';
    await safeStep('关闭平台数据库', () => deps.db.close());
    if (timedOut) return 'done';

    // 第 5 步：清理兜底定时器并正常退出
    cleanupTimersAndListeners();
    exitOnce(hasError ? 1 : 0);
    return 'done';
  })();

  await Promise.race([sequencePromise, timeoutPromise]);
};

/**
 * 创建带幂等防重入保护的优雅停机触发器：
 * 连续收到多次 SIGINT / SIGTERM 时返回同一个 Promise，绝不并发执行两次停机序列。
 */
export const createShutdown = (deps: ShutdownDeps): ((signal?: string) => Promise<void>) => {
  let stopping: Promise<void> | null = null;
  return (signal?: string) => {
    if (stopping) return stopping;
    stopping = gracefulShutdown(deps, signal);
    return stopping;
  };
};
