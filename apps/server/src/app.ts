// HTTP API 和 WebSocket（同一个端口）。这里只负责组装：创建共享依赖、挂中间件、注册各领域路由。

import type { ApiErrorBody } from '@dowel/api';
import { type Model, PlanError } from '@dowel/core';
import { HistoryError, ScopeError } from '@dowel/engines';
import { ExecutorError } from '@dowel/executor';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assertUrlAllowed } from './allowlist.ts';
import { EventBus, type EventBusOptions } from './bus.ts';
import type { PlatformDb } from './db.ts';
import { OpaqueRefresher } from './derive.ts';
import { DriftScheduler } from './drift-scheduler.ts';
import { EnvLocks, type ExecContext } from './executions.ts';
import { HaCoordinator, type HaCoordinatorOptions } from './ha.ts';
import {
  connectionLimiterFromEnv,
  type KeyedLimiter,
  type LoginLimiter,
  loginLimiterFromEnv,
  tokenFailLimiterFromEnv,
  tokenLimiterFromEnv,
} from './rate-limit.ts';
import { Requests } from './requests.ts';
import { effectiveProjectRole } from './roles.ts';
import { Rooms } from './rooms.ts';
import type { AppContext, Env } from './routes/context.ts';
import { registerRoutes } from './routes/index.ts';
import { SecretError, scrubSecrets } from './secrets.ts';
import {
  mutationOriginGuard,
  type SecurityConfig,
  securityConfigFromEnv,
  securityHeaders,
} from './security.ts';
import { passwordLoginForced, readSettings } from './settings.ts';
import { newSetupToken } from './setup.ts';
import { ShadowError } from './shadow.ts';
import { Shadows } from './shadows.ts';
import type { ConnectionGuard } from './targets.ts';
import { ActiveTokenCache } from './tokens.ts';
import { type WebhookOptions, Webhooks } from './webhooks.ts';

export interface AppOptions {
  /** 可注入时钟 / 阈值的登录限速器（测试用） */
  loginLimiter?: LoginLimiter;
  /** 可注入时钟 / 阈值的连接检查限速器（测试用）；默认 DOWEL_CONNECTION_LIMIT（10）次 / DOWEL_CONNECTION_WINDOW_MS（60000ms） */
  connectionLimiter?: KeyedLimiter;
  /** 安全相关配置；未给出的项从 DOWEL_TRUST_PROXY / DOWEL_PUBLIC_URL 读取 */
  security?: Partial<SecurityConfig>;
  /** 强制允许密码登录（相当于 DOWEL_ALLOW_PASSWORD_LOGIN=1）；未给出时读环境变量 */
  allowPasswordLogin?: boolean;
  /** Webhook 投递的参数（测试里调短重试间隔） */
  webhooks?: WebhookOptions;
  /** CI 令牌认证失败的限速（按来源 IP，仅计格式合法的失败尝试且不阻断活跃有效令牌）；默认 DOWEL_TOKEN_FAIL_LIMIT（20）次 / DOWEL_TOKEN_FAIL_WINDOW_MS（600000ms） */
  tokenFailLimiter?: KeyedLimiter;
  /** 每个 CI 令牌的请求限速；默认 DOWEL_TOKEN_RATE_LIMIT（120）次 / DOWEL_TOKEN_RATE_WINDOW_MS（60000ms） */
  tokenLimiter?: KeyedLimiter;
  /** 自定义一次性初始化令牌（测试用，优先于平台库中持久化的共享令牌） */
  setupToken?: string;
  /** 多副本冷启动经 ensureSetupToken 持久化并共享的初始化令牌（由 main.ts 传入；传 null 表示实例已初始化） */
  sharedSetupToken?: string | null;
  /** 跨副本事件总线配置（测试可注入自定义 replicaId / channel） */
  bus?: EventBusOptions;
  /** 副本租约与分布式任务协调器配置 */
  ha?: HaCoordinatorOptions;
}

export const createApp = (db: PlatformDb, options: AppOptions = {}) => {
  const app = new Hono<Env>();
  const bus = new EventBus(db, options.bus);
  const ha = new HaCoordinator(db, { replicaId: bus.replicaId, ...options.ha });
  // 房间和 HTTP 用同一套生效角色规则；join 复查时也要能算；多副本下经 EventBus 同步房间事件并借助 HA 租约清理离线副本成员
  const rooms = new Rooms(db, (user, pid, lookup) => effectiveProjectRole(db, user, pid, lookup), bus, ha);
  // 所有目标库 / 影子库连接都要过的检查：实例的白名单（服务端替用户连地址 = SSRF 面）
  const guard: ConnectionGuard = async (url) => {
    const { connectionAllowlist } = await readSettings(db);
    await assertUrlAllowed(url, connectionAllowlist);
  };
  const shadows = new Shadows(db, guard, bus);
  const refresher = new OpaqueRefresher(
    rooms,
    async (branchId) => {
      const [b] = await db.query<{ project_id: string }>('select project_id from branches where id = $1', [
        branchId,
      ]);
      if (!b) return null;
      return (await shadows.forProject(b.project_id).catch(() => null))?.shadow ?? null;
    },
    {
      load: async (branchId) =>
        (
          await db.query<{ baseline: Model | null }>('select baseline from branches where id = $1', [
            branchId,
          ])
        )[0]?.baseline ?? null,
      save: async (branchId, m) => {
        await db.query('update branches set baseline = $2::text::jsonb where id = $1', [
          branchId,
          JSON.stringify(m),
        ]);
      },
    },
    ha,
  );
  rooms.onCommit = (branchId) => refresher.schedule(branchId);
  /** 导入、拉取、恢复历史后替换模型：新模型就是引擎读出的，作为派生数据的基线 */
  const replace = async (branch: string, user: string, model: Model, op: string, expectedSeq?: number) => {
    await refresher.runWithReset(branch, model, () => rooms.replace(branch, user, model, op, expectedSeq));
  };
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const security: SecurityConfig = { ...securityConfigFromEnv(), ...options.security };

  // 执行 / 漂移检查：环境锁在单进程互斥之上叠加 PG 平台库 advisory lock 跨副本互斥
  const exec: ExecContext = { db, guard, locks: new EnvLocks(db) };
  // 定时漂移检查：这里只创建，不启动（main.ts 按配置启动；测试里不启动或调短间隔）
  const drift = new DriftScheduler(db, exec, ha);
  // 组级 Webhook（持久化队列 webhook_jobs + EventBus 唤醒；后台定时轮询由 main.ts 显式 start()）和执行申请（状态检查、跨副本通知、分布式巡检）
  const webhooks = new Webhooks(db, { bus, ha, ...options.webhooks });
  const requests = new Requests(db, exec, webhooks, security, { bus, ha });
  drift.afterSweep = () => requests.kick({ all: true });
  const activeTokens = new ActiveTokenCache(db);
  bus.onEvent((event) => {
    if (event.t === 'ci_tokens.changed' && event.origin !== bus.replicaId) activeTokens.markStale();
  });
  bus.onReconnect(() => activeTokens.markStale());

  const setupTokenMode: AppContext['setupTokenMode'] =
    options.setupToken !== undefined ? 'custom' : options.sharedSetupToken !== undefined ? 'shared' : 'local';
  const setupToken =
    options.setupToken !== undefined
      ? options.setupToken
      : options.sharedSetupToken !== undefined
        ? options.sharedSetupToken
        : newSetupToken();

  const ctx: AppContext = {
    db,
    bus,
    ha,
    replicaId: bus.replicaId,
    rooms,
    shadows,
    refresher,
    loginLimiter: options.loginLimiter ?? loginLimiterFromEnv(),
    connectionLimiter: options.connectionLimiter ?? connectionLimiterFromEnv(),
    tokenFailLimiter: options.tokenFailLimiter ?? tokenFailLimiterFromEnv(),
    activeTokens,
    tokenLimiter: options.tokenLimiter ?? tokenLimiterFromEnv(),
    guard,
    exec,
    drift,
    requests,
    webhooks,
    security,
    // 一次性初始化令牌：生产冷启动由 main.ts 经 ensureSetupToken 获取后同步传入 sharedSetupToken；单测可直接用内存令牌
    setupToken,
    setupTokenMode,
    allowPasswordLogin: options.allowPasswordLogin ?? passwordLoginForced(),
    replace,
    upgradeWebSocket,
  };

  // 所有错误响应的出口：每个分支的文本统一过 scrubSecrets（连接串里的密码不能出现在响应里）。
  // 往下游抛错的地方不用各自脱敏；已经落库的文本（验证报告、历史）才在写入前脱敏
  app.onError((err, c) => {
    const fail = (message: string, status: 422 | 500 | HTTPException['status']) =>
      c.json<ApiErrorBody>({ error: scrubSecrets(message) }, status);
    if (err instanceof HTTPException) return fail(err.message, err.status);
    if (
      err instanceof PlanError ||
      err instanceof ShadowError ||
      err instanceof SecretError ||
      err instanceof ScopeError ||
      err instanceof HistoryError ||
      // 执行器的预期拒绝（历史对不上、被别的实例认领……）；意外错误（unexpected）仍然是 500
      (err instanceof ExecutorError && err.code !== 'unexpected')
    )
      return fail(err.message, 422);
    console.error(err);
    return fail('服务器内部错误', 500);
  });

  // 安全响应头对所有响应生效；变更请求校验 Origin（没有 Origin 头的放行，便于 CI 用 curl）。
  // CI 令牌接口（/api/ci/…）不校验：令牌请求不带 cookie，没有 CSRF 的前提（P6）
  app.use('*', securityHeaders);
  app.use('/api/*', async (c, next) =>
    c.req.path.startsWith('/api/ci/') ? next() : mutationOriginGuard(security)(c, next),
  );

  registerRoutes(app, ctx);

  return {
    app,
    injectWebSocket,
    wss,
    bus,
    ha,
    replicaId: bus.replicaId,
    rooms,
    shadows,
    refresher,
    drift,
    exec,
    requests,
    webhooks,
    setupToken: ctx.setupToken,
  };
};
