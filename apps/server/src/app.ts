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
import { BranchForgottenError, DeriveBusyError, OpaqueRefresher } from './derive.ts';
import { DriftScheduler } from './drift-scheduler.ts';
import { defaultMailer, type Mailer } from './email.ts';
import { EnvLocks, type ExecContext } from './executions.ts';
import { HaCoordinator, type HaCoordinatorOptions } from './ha.ts';
import { DEFAULT_MESSAGE_LIMITS, httpBodyLimit, type MessageLimits } from './limits.ts';
import {
  connectionLimiterFromEnv,
  emailTestLimiterFromEnv,
  forgotPasswordLimiterFromEnv,
  type KeyedLimiter,
  type LoginLimiter,
  loginLimiterFromEnv,
  mcpFailLimiterFromEnv,
  mcpLimiterFromEnv,
  tokenFailLimiterFromEnv,
  tokenLimiterFromEnv,
} from './rate-limit.ts';
import { Requests } from './requests.ts';
import { effectiveProjectRole } from './roles.ts';
import { Rooms, type RoomsOptions } from './rooms.ts';
import { type AppContext, CodedHTTPException, type Env } from './routes/context.ts';
import { registerRoutes } from './routes/index.ts';
import { SecretError, scrubSecrets } from './secrets.ts';
import {
  mutationOriginGuard,
  type SecurityConfig,
  securityConfigFromEnv,
  securityHeaders,
} from './security.ts';
import { passwordLoginForced, readSettings } from './settings.ts';
import { DEFAULT_ADMIN_USERNAME } from './setup.ts';
import { ShadowConfigChangedError, ShadowError } from './shadow.ts';
import { ProjectGoneError, Shadows } from './shadows.ts';
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
  /** MCP 令牌认证失败的限速（按来源 IP）；默认 DOWEL_MCP_FAIL_LIMIT（20）次 / DOWEL_MCP_FAIL_WINDOW_MS（600000ms） */
  mcpFailLimiter?: KeyedLimiter;
  /** 每个 MCP 令牌的请求限速；默认 DOWEL_MCP_RATE_LIMIT（120）次 / DOWEL_MCP_RATE_WINDOW_MS（60000ms） */
  mcpLimiter?: KeyedLimiter;
  /** 忘记密码请求限速器（测试用） */
  forgotPasswordLimiter?: LoginLimiter;
  /** 测试邮件发送限速器（测试用） */
  emailTestLimiter?: KeyedLimiter;
  /** 自定义邮件发送器（测试用；默认使用原生 SMTP 客户端） */
  mailer?: Mailer;
  /** 首次启动自动生成的初始管理员临时密码文件路径（首次改密/重置后删除；运维指定文件时为 null） */
  initialAdminPasswordFile?: string | null;
  /** 首次启动引导创建的管理员用户名（默认 'admin'） */
  bootstrapUsername?: string;
  /** 跨副本事件总线配置（测试可注入自定义 replicaId / channel） */
  bus?: EventBusOptions;
  /** 副本租约与分布式任务协调器配置 */
  ha?: HaCoordinatorOptions;
  /** 协作房间配置（如空闲超时卸载间隔） */
  rooms?: RoomsOptions;
  /** 单条入站消息上限（测试里调小；默认 HTTP 请求体 16 MiB、协作 WebSocket 单条消息 16 MiB，见 limits.ts） */
  limits?: Partial<MessageLimits>;
}

export const createApp = (db: PlatformDb, options: AppOptions = {}) => {
  const app = new Hono<Env>();
  const bus = new EventBus(db, options.bus);
  const ha = new HaCoordinator(db, { replicaId: bus.replicaId, ...options.ha });
  // 房间和 HTTP 用同一套生效角色规则；join 复查时也要能算；多副本下经 EventBus 同步房间事件并借助 HA 租约清理离线副本成员
  const rooms = new Rooms(
    db,
    (user, pid, lookup) => effectiveProjectRole(db, user, pid, lookup),
    bus,
    ha,
    options.rooms,
  );
  // 所有目标库 / 影子库连接都要过的检查：实例的白名单（服务端替用户连地址 = SSRF 面）
  const guard: ConnectionGuard = async (url) => {
    const { connectionAllowlist } = await readSettings(db);
    await assertUrlAllowed(url, connectionAllowlist, { platformDbPath: db.filePath });
  };
  const shadows = new Shadows(db, guard, bus);
  const refresher = new OpaqueRefresher(
    rooms,
    async (branchId) => {
      const [b] = await db.query<{ project_id: string }>('select project_id from branches where id = $1', [
        branchId,
      ]);
      if (!b) return 'forgotten';
      try {
        return (await shadows.forProjectTarget(b.project_id))?.shadow ?? null;
      } catch (e) {
        // 查完 branches 之后项目被并发删除（Issue #170）：是 forgotten，不能被下面当成“无环境”的 no_shadow
        if (e instanceof ProjectGoneError) return 'forgotten';
        // 尚未尝试连库就已知项目没有可用影子库（无环境）：直接报 no_shadow，避免每次 flush 多查一次 branches
        if (e instanceof ShadowError && e.preConnect) return 'no_shadow';
        return null;
      }
    },
    {
      load: async (branchId) =>
        (
          await db.query<{ baseline: Model | null }>('select baseline from branches where id = $1', [
            branchId,
          ])
        )[0]?.baseline ?? null,
      // 更新 0 行 = 分支已被删（可能是别的副本删的，derive.forget 还没到）
      save: async (branchId, m) =>
        (
          await db.query<{ id: string }>(
            'update branches set baseline = $2::text::jsonb where id = $1 returning id',
            [branchId, JSON.stringify(m)],
          )
        ).length > 0,
      // 只在失败路径与总线重连 / 退化事件时调用（OpaqueRefresher 按 500 个一批）
      existing: async (branchIds) =>
        new Set(
          branchIds.length
            ? (
                await db.query<{ id: string }>(
                  `select id from branches where id in (${branchIds.map((_, i) => `$${i + 1}`).join(', ')})`,
                  branchIds,
                )
              ).map((r) => r.id)
            : [],
        ),
    },
    ha,
    // 跨副本同步 forget（Issue #153）：收 derive.forget、总线重连时复核
    bus,
  );
  // 按需规范化（ADR 0016）：编辑提交不再触发后台影子库刷新，只在关键出口 flush 或用户显式规范化时才回影子库
  /**
   * 整体替换工作副本：
   * - canonical（默认 true）：导入、拉取、接入领先版本——直接作为黄金基线。导入、拉取的模型是引擎刚读出的；
   *   接入领先版本用的是链头版本模型，直接作黄金基线依赖严格的读回核对（#123，ADR 0016 / ADR 0017）：当前执行读回校验
   *   （`verifyAndRecord`）已对四种方言严格校验（MySQL 表达式纯格式容忍已于 #162 移除），恢复时闭环验证的读回核对
   *   待 ADR 0017 / #132 落地，放宽其中任何一道都要重新审视这条路径；
   * - canonical: 'ifClean'：已验证版本的应用 / 作废 / 取消作废——相对当前黄金基线没有待规范化对象时才推进黄金基线。
   *   当前闭环验证尚未核对模型原文（待 #132 落地）；按 ADR 0017 落地后仍保留，因为验证记录将按数据库完整版本号区分
   *   （其他版本上验证通过不保证是当前影子库的规范形式）、SQL Server 生成列的 `type` 规划器不比较，同时作为推进黄金基线前
   *   的防御性确认；
   * - canonical: false：恢复画布历史、未验证版本——只替换房间，不改写黄金基线（被替换进来的模型不一定规范化过）。
   */
  const replace: AppContext['replace'] = async (branch, user, model, op, expectedSeq, opts) => {
    const run = () => rooms.replace(branch, user, model, op, expectedSeq);
    if (opts?.canonical === false) await refresher.runWithoutReset(branch, run);
    else await refresher.runWithReset(branch, model, run, { onlyIfClean: opts?.canonical === 'ifClean' });
  };
  const limits: MessageLimits = { ...DEFAULT_MESSAGE_LIMITS, ...options.limits };
  const nodeWs = createNodeWebSocket({ app });
  const { upgradeWebSocket, wss } = nodeWs;
  // @hono/node-ws 不透传 WebSocketServer 选项；ws 在每次升级时读 wss.options.maxPayload（含分片累计与解压后的大小），
  // 超限以 1009 关闭连接，消息不会进入 onMessage / JSON.parse（Issue #150；ws 默认是 100 MiB）
  wss.options.maxPayload = limits.wsMessageBytes;
  // ws 服务端默认就不开压缩；显式固定，避免依赖升级后默认值变化带来解压放大
  wss.options.perMessageDeflate = false;
  const injectWebSocket: typeof nodeWs.injectWebSocket = (server) => nodeWs.injectWebSocket(server);
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
  const activeMcpTokens = new ActiveTokenCache(db, { table: 'mcp_tokens' });
  bus.onEvent((event) => {
    if (event.t === 'ci_tokens.changed' && event.origin !== bus.replicaId) activeTokens.markStale();
    if (event.t === 'mcp_tokens.changed' && event.origin !== bus.replicaId) activeMcpTokens.markStale();
  });
  bus.onReconnect(() => {
    activeTokens.markStale();
    activeMcpTokens.markStale();
  });

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
    mcpFailLimiter: options.mcpFailLimiter ?? mcpFailLimiterFromEnv(),
    activeMcpTokens,
    mcpLimiter: options.mcpLimiter ?? mcpLimiterFromEnv(),
    forgotPasswordLimiter: options.forgotPasswordLimiter ?? forgotPasswordLimiterFromEnv(),
    emailTestLimiter: options.emailTestLimiter ?? emailTestLimiterFromEnv(),
    mailer: options.mailer ?? defaultMailer,
    guard,
    exec,
    drift,
    requests,
    webhooks,
    security,
    initialAdminPasswordFile: options.initialAdminPasswordFile ?? null,
    bootstrapUsername: options.bootstrapUsername ?? DEFAULT_ADMIN_USERNAME,
    allowPasswordLogin: options.allowPasswordLogin ?? passwordLoginForced(),
    replace,
    upgradeWebSocket,
  };

  // 所有错误响应的出口：每个分支的文本统一过 scrubSecrets（连接串里的密码不能出现在响应里）。
  // 往下游抛错的地方不用各自脱敏；已经落库的文本（验证报告、历史）才在写入前脱敏
  app.onError((err, c) => {
    const fail = (message: string, status: 422 | 500 | HTTPException['status'], code?: string) =>
      c.json<ApiErrorBody>({ error: scrubSecrets(message), ...(code ? { code } : {}) }, status);
    if (err instanceof CodedHTTPException) return fail(err.message, err.status, err.code);
    // 等 derive 锁超时（另一副本 / 请求正在规范化同一分支）：可重试的 503
    if (err instanceof DeriveBusyError) return fail(err.message, 503, 'normalize_busy');
    // 影子库句柄因环境配置变更被关闭（Issue #154）：可重试的 503，不是“影子库不可用”的 422
    if (err instanceof ShadowConfigChangedError) return fail(err.message, 503, err.code);
    // 规范化 / flush 期间分支已删（未读到房间状态或显式规范化）：与 accessIn 一致返回 404
    if (err instanceof BranchForgottenError) return fail('项目不存在', 404);
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
  // 请求体上限放在所有路由与认证之前：超限的请求不读完请求体、不解析 JSON（Issue #150；MCP 有自己的 1 MiB 上限）
  app.use('*', httpBodyLimit(limits.httpBodyBytes));
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
  };
};
