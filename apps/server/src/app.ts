// HTTP API 和 WebSocket（同一个端口）。这里只负责组装：创建共享依赖、挂中间件、注册各领域路由。

import type { ApiErrorBody } from '@dowel/api';
import { type Model, PlanError } from '@dowel/core';
import { HistoryError, ScopeError } from '@dowel/engines';
import { ExecutorError } from '@dowel/executor';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assertUrlAllowed } from './allowlist.ts';
import type { PlatformDb } from './db.ts';
import { OpaqueRefresher } from './derive.ts';
import { DriftScheduler } from './drift-scheduler.ts';
import { EnvLocks, type ExecContext } from './executions.ts';
import { KeyedLimiter, type LoginLimiter, loginLimiterFromEnv } from './rate-limit.ts';
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

export interface AppOptions {
  /** 可注入时钟 / 阈值的登录限速器（测试用） */
  loginLimiter?: LoginLimiter;
  /** 可注入时钟 / 阈值的连接检查限速器（测试用）；默认每个用户每分钟 10 次 */
  connectionLimiter?: KeyedLimiter;
  /** 安全相关配置；未给出的项从 DOWEL_TRUST_PROXY / DOWEL_PUBLIC_URL 读取 */
  security?: Partial<SecurityConfig>;
  /** 强制允许密码登录（相当于 DOWEL_ALLOW_PASSWORD_LOGIN=1）；未给出时读环境变量 */
  allowPasswordLogin?: boolean;
}

export const createApp = (db: PlatformDb, options: AppOptions = {}) => {
  const app = new Hono<Env>();
  // 房间和 HTTP 用同一套生效角色规则；join 复查时也要能算
  const rooms = new Rooms(db, (user, pid, lookup) => effectiveProjectRole(db, user, pid, lookup));
  // 所有目标库 / 影子库连接都要过的检查：实例的白名单（服务端替用户连地址 = SSRF 面）
  const guard: ConnectionGuard = async (url) => {
    const { connectionAllowlist } = await readSettings(db);
    await assertUrlAllowed(url, connectionAllowlist);
  };
  const shadows = new Shadows(db, guard);
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
  );
  rooms.onCommit = (branchId) => refresher.schedule(branchId);
  /** 导入、拉取后替换模型：新模型就是引擎读出的，作为派生数据的基线 */
  const replace = async (branch: string, user: string, model: Model, op: string) => {
    await refresher.flush(branch);
    await rooms.replace(branch, user, model, op);
    await refresher.reset(branch, (await rooms.model(branch)).model);
  };
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const security: SecurityConfig = { ...securityConfigFromEnv(), ...options.security };

  // 执行 / 漂移检查：环境锁是单进程内的互斥（跨进程由目标库上的项目锁保证）
  const exec: ExecContext = { db, guard, locks: new EnvLocks() };
  // 定时漂移检查：这里只创建，不启动（main.ts 按配置启动；测试里不启动或调短间隔）
  const drift = new DriftScheduler(db, exec);

  const ctx: AppContext = {
    db,
    rooms,
    shadows,
    refresher,
    loginLimiter: options.loginLimiter ?? loginLimiterFromEnv(),
    connectionLimiter: options.connectionLimiter ?? new KeyedLimiter({ limit: 10, windowMs: 60_000 }),
    guard,
    exec,
    drift,
    security,
    // 一次性初始化令牌只放内存里（服务重启会重新生成），启动时由 main.ts 打印
    setupToken: newSetupToken(),
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

  // 安全响应头对所有响应生效；变更请求校验 Origin（没有 Origin 头的放行，便于 CI 用 curl）
  app.use('*', securityHeaders);
  app.use('/api/*', mutationOriginGuard(security));

  registerRoutes(app, ctx);

  return { app, injectWebSocket, rooms, shadows, refresher, drift, exec, setupToken: ctx.setupToken };
};
