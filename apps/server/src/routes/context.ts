// 路由模块共享的上下文、请求体解析和项目权限检查。
import type { Model } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

import { currentUser, type User } from '../auth.ts';
import {
  can,
  type EnvAction,
  type GroupAction,
  type InstanceAction,
  isEnvAction,
  type ProjectAction,
  userActor,
} from '../authz.ts';
import type { EventBus } from '../bus.ts';
import { isEmailUniqueViolation, isUniqueViolation, type PlatformDb } from '../db.ts';
import type { OpaqueRefresher } from '../derive.ts';
import type { DriftScheduler } from '../drift-scheduler.ts';
import type { Mailer } from '../email.ts';
import { type EnvRow, envResource, loadEnv } from '../envs.ts';
import type { ExecContext } from '../executions.ts';
import { groupById, groupBySlug, groupRoleOf } from '../groups.ts';
import type { HaCoordinator } from '../ha.ts';
import type { McpPrincipal } from '../mcp-tokens.ts';
import {
  accessIn,
  deniedMessage,
  type EnvAuth,
  envAuthOf,
  loadPolicies,
  type PolicyStore,
} from '../policy.ts';
import type { KeyedLimiter, LoginLimiter } from '../rate-limit.ts';
import type { Requests } from '../requests.ts';
import type { ProjectRow, RoleContext } from '../roles.ts';
import type { Role, Rooms } from '../rooms.ts';
import type { SecurityConfig } from '../security.ts';
import type { Shadows } from '../shadows.ts';
import type { ConnectionGuard } from '../targets.ts';
import type { ActiveTokenCache, CiTokenAuth } from '../tokens.ts';
import { createUser, type NewUser } from '../users.ts';
import type { Webhooks } from '../webhooks.ts';

/** 请求上挂的身份：登录用户（会话 cookie）、CI 令牌（只在 /api/ci/… 上，见 routes/ci.ts）或 MCP 令牌的主体（只在 /api/mcp 上，见 routes/mcp.ts） */
export type Env = { Variables: { user: User; token: CiTokenAuth; mcp: McpPrincipal } };

export interface AppContext {
  db: PlatformDb;
  /** 跨副本事件总线（PG LISTEN/NOTIFY，SQLite 进程内回调） */
  bus: EventBus;
  /** 副本租约与分布式任务协调器 */
  ha: HaCoordinator;
  /** 当前副本唯一 ID */
  replicaId: string;
  rooms: Rooms;
  shadows: Shadows;
  refresher: OpaqueRefresher;
  loginLimiter: LoginLimiter;
  /** 连接检查的限速（每个用户每分钟 10 次）：服务端替用户去连地址 */
  connectionLimiter: KeyedLimiter;
  /** CI 令牌认证失败的限速（按来源 IP，防爆破；P6）：只计格式合法但校验失败的尝试，成功与缺头 / 非法格式不占额度，且不阻断活跃有效令牌 */
  tokenFailLimiter: KeyedLimiter;
  /** 活跃 CI 令牌哈希缓存：仅在来源 IP 触发失败限流时放行有效令牌做数据库强校验，阻断无效令牌继续打库 */
  activeTokens: ActiveTokenCache;
  /** 每个 CI 令牌的请求限速（P6） */
  tokenLimiter: KeyedLimiter;
  /** MCP 令牌认证失败的限速（按来源 IP；M3-C），规则同 tokenFailLimiter */
  mcpFailLimiter: KeyedLimiter;
  /** 活跃 MCP 令牌哈希缓存（M3-C）：仅在来源 IP 触发失败限流时放行有效令牌做数据库强校验 */
  activeMcpTokens: ActiveTokenCache;
  /** 每个 MCP 令牌的请求限速（M3-C） */
  mcpLimiter: KeyedLimiter;
  /** 忘记密码邮件请求限速（按 IP + 邮箱与 IP 总量） */
  forgotPasswordLimiter: LoginLimiter;
  /** 管理后台发送测试邮件限速（按管理员） */
  emailTestLimiter: KeyedLimiter;
  /** 邮件发送器（默认原生 SMTP 客户端，测试可替换） */
  mailer: Mailer;
  /** 连接目标库 / 影子库之前统一跑的检查（SSRF 白名单） */
  guard: ConnectionGuard;
  /** 执行 / 漂移检查共用的上下文（平台库、白名单、环境锁） */
  exec: ExecContext;
  /** 定时漂移检查（main.ts 启动；测试里不启动或调短间隔） */
  drift: DriftScheduler;
  /** 执行申请、审批与收件箱（P5b）：申请的状态检查、通知、定时清理过期 / 失效的申请 */
  requests: Requests;
  /** 组级 Webhook 的持久化投递队列（P5b / P7 HA：写入 webhook_jobs 表，重启不丢失，PG 多副本下通过 FOR UPDATE SKIP LOCKED 认领并经 EventBus 唤醒） */
  webhooks: Webhooks;
  security: SecurityConfig;
  /** 首次启动自动生成的初始管理员临时密码文件路径（首次改密/重置后删除；运维指定文件时为 null） */
  initialAdminPasswordFile: string | null;
  /** 首次启动引导创建的管理员用户名（默认 'admin'） */
  bootstrapUsername: string;
  /** DOWEL_ALLOW_PASSWORD_LOGIN=1：设置里关了密码登录也能用密码登录的应急入口 */
  allowPasswordLogin: boolean;
  /**
   * 整体替换工作副本；传入 expectedSeq 时原子校验当前 seq。
   * `canonical`（默认 true）：导入、拉取、接入领先版本，新模型同时作为派生数据的黄金基线。导入、拉取的模型是引擎刚读出的；
   * 接入领先版本用链头版本模型，依赖严格的读回核对（#123，ADR 0016 / ADR 0017）：当前执行读回校验（`verifyAndRecord`）
   * 已对四种方言严格校验（MySQL 表达式纯格式容忍已于 #162 移除），恢复时闭环验证也有同样严格的读回核对（ADR 0017 / #132），
   * 放宽其中任何一道都要重新审视这条路径；
   * 'ifClean'：已验证版本——验证记录按数据库完整版本号区分（ADR 0017），在别的版本上验证通过不保证是当前影子库的规范形式，
   * SQL Server 生成列的 `type` 规划器也不比较，“已验证”不保证是当前影子库的规范形式，因此只有相对当前黄金基线没有待规范化
   * 对象时才推进黄金基线（同时作为防御性确认）；
   * false：恢复画布历史、未验证版本等不一定规范化过的模型，只替换房间、不改写黄金基线（ADR 0016）。
   */
  replace: (
    branch: string,
    user: string,
    model: Model,
    op: string,
    expectedSeq?: number,
    opts?: { canonical?: boolean | 'ifClean' },
  ) => Promise<void>;
  upgradeWebSocket: ReturnType<typeof import('@hono/node-ws').createNodeWebSocket>['upgradeWebSocket'];
}

export const PASSWORD_CHANGE_REQUIRED_CODE = 'password_change_required';

export class CodedHTTPException extends HTTPException {
  readonly code: string;
  constructor(status: HTTPException['status'], message: string, code: string) {
    super(status, { message });
    this.code = code;
  }
}

export const passwordChangeRequired = () =>
  new CodedHTTPException(403, '请先修改密码后再继续使用', PASSWORD_CHANGE_REQUIRED_CODE);

export const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? '请求不合法' });
  return parsed.data;
};

/**
 * 登录后再访问的接口：只认会话 cookie。CI 令牌（Authorization: Bearer dwl_…）在更前面就被 rejectTokens 拒绝（403），
 * 不会走到这里，也不会回落到 cookie——令牌只能访问 /api/ci/…（P6，routes/ci.ts）。
 * 若当前账号处于 mustChangePassword 状态，除 POST /api/me/password 外一律 fail-closed 返回 403 password_change_required。
 */
export const requireUser =
  (db: PlatformDb): MiddlewareHandler<Env> =>
  async (c, next) => {
    const u = await currentUser(db, c);
    if (!u) throw new HTTPException(401, { message: '未登录' });
    if (u.mustChangePassword && !(c.req.method === 'POST' && c.req.path === '/api/me/password')) {
      throw passwordChangeRequired();
    }
    c.set('user', u);
    await next();
  };

/**
 * 实例管理员才能做的事；要放在 requireUser 之后。
 * 每个路由传自己的实例级动作（用户管理 / 邀请 / 实例设置），规则仍然只在 can() 里。
 */
export const requireInstanceAdmin =
  (action: InstanceAction): MiddlewareHandler<Env> =>
  async (c, next) => {
    const u = c.get('user');
    if (!u) throw new HTTPException(401, { message: '未登录' });
    if (!can(userActor(u), action, { kind: 'instance' }))
      throw new HTTPException(403, { message: '需要实例管理员' });
    await next();
  };

/**
 * 建用户并把用户名唯一约束冲突转成 409：usernameTaken() 只是提前检查，
 * 并发建同名用户时最终靠数据库兜底（SQLite / PG 都能识别，见 isUniqueViolation）。
 */
export const createUserOrConflict = async (db: Db, input: NewUser): Promise<User> => {
  try {
    return await createUser(db, input);
  } catch (e) {
    if (isEmailUniqueViolation(e)) throw new HTTPException(409, { message: '邮箱已被使用' });
    if (isUniqueViolation(e)) throw new HTTPException(409, { message: '用户名已被使用' });
    throw e;
  }
};

/** 项目行 + 调用者的生效角色；命名和 @dowel/api 里项目授权的响应类型（ProjectAccess）区分开 */
export interface ProjectAccessRow extends ProjectRow {
  pid: string;
  role: Role;
  /** 调用者的角色上下文（组成员关系 + 授权）：判断执行者时复用，不再查一次 */
  rc: RoleContext;
}

/**
 * 检查当前用户对项目的权限：算出生效角色 → can() → 不允许时返回。
 * 生效角色为空（看不见）时一律 404，权限够看但不够做时 403（G4）。
 */
export const access = async (
  c: Context<Env>,
  ctx: AppContext,
  action: ProjectAction,
): Promise<ProjectAccessRow> => {
  const user = c.get('user');
  // 项目行、角色上下文、项目角色：和锁内重新读用同一个函数（accessIn，看不见就 404）
  const { project: p, rc, role } = await accessIn(ctx.db, user, c.req.param('pid')!);
  if (!can(userActor(user), action, { kind: 'project', role }))
    throw new HTTPException(403, { message: '没有权限' });
  return { ...p, pid: p.id, role, rc };
};

/**
 * 在这个组建项目的检查（group.create_project）：新建项目向导、连接检查、接手（检查和执行）共用。
 * 组不存在 404，没有权限 403；返回组。
 */
export const createProjectGroup = async (c: Context<Env>, ctx: AppContext, groupId: string) => {
  const u = c.get('user');
  const g = await groupById(ctx.db, groupId);
  if (!g) throw new HTTPException(404, { message: '组不存在' });
  const groupRole = await groupRoleOf(ctx.db, g.id, u.id);
  if (
    !can(userActor(u), 'group.create_project', {
      kind: 'group',
      groupRole,
      projectCreation: g.projectCreation,
    })
  )
    throw new HTTPException(403, { message: '没有在这个组建项目的权限' });
  return g;
};

/**
 * 服务端替用户去连地址（连接检查、读历史、漂移检查、接手、接入、认领、向导）共用的限速：每个用户每分钟 10 次。
 * times：这个请求要连几次（向导每个环境算一次）；超限时抛 429 + Retry-After，此时还没有开始任何写入。
 */
export const connectionLimit = (c: Context<Env>, ctx: AppContext, times = 1) => {
  for (let i = 0; i < times; i++) {
    const r = ctx.connectionLimiter.attempt(c.get('user').id);
    if (!r.allowed) {
      c.header('Retry-After', String(r.retryAfterSeconds));
      throw new HTTPException(429, { message: `连接检查太频繁了，请 ${r.retryAfterSeconds} 秒后再试` });
    }
  }
};

/** 组接口的权限检查：组对所有人可见，管理动作看组里的身份 */
export const groupAccess = async (c: Context<Env>, ctx: AppContext, action: GroupAction) => {
  const slug = c.req.param('slug')!;
  const g = await groupBySlug(ctx.db, slug);
  if (!g) throw new HTTPException(404, { message: '组不存在' });
  const groupRole = await groupRoleOf(ctx.db, g.id, c.get('user').id);
  if (
    !can(userActor(c.get('user')), action, {
      kind: 'group',
      groupRole,
      projectCreation: g.projectCreation,
    })
  )
    throw new HTTPException(403, { message: '需要组管理员' });
  return { ...g, groupRole };
};

/**
 * 环境上的操作：先按项目权限看环境（看不见 404），再按环境的执行档位检查特权操作（H6）。
 * 非特权的项目动作（读、拉取、检查漂移）按项目角色。
 */
export const envAccess = async (
  c: Context<Env>,
  ctx: AppContext,
  action: EnvAction | ProjectAction,
  eid = c.req.param('eid')!,
): Promise<ProjectAccessRow & { env: EnvRow; auth: EnvAuth; store: PolicyStore }> => {
  const a = await access(c, ctx, 'environment.read');
  const env = await loadEnv(ctx.db, a.pid, eid);
  const store = await loadPolicies(ctx.db, a);
  const auth = envAuthOf(store, a.rc, a, env);
  const actor = userActor(c.get('user'));
  // 非特权的项目动作也用环境资源判断：执行者能检查漂移（见 can()），其余按项目角色
  const ok = can(actor, action, envResource(env, a.role, auth));
  if (!ok)
    throw new HTTPException(403, {
      message: isEnvAction(action) ? deniedMessage(action, auth) : '没有权限',
    });
  return { ...a, env, auth, store };
};
