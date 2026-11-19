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
  effectiveExecPolicy,
  type GroupAction,
  type InstanceAction,
  isEnvAction,
  isEnvConfigAction,
  type ProjectAction,
  userActor,
} from '../authz.ts';
import { isUniqueViolation, type PlatformDb } from '../db.ts';
import type { OpaqueRefresher } from '../derive.ts';
import type { DriftScheduler } from '../drift-scheduler.ts';
import { type EnvRow, envResource, loadEnv } from '../envs.ts';
import type { ExecContext } from '../executions.ts';
import { groupBySlug, groupRoleOf } from '../groups.ts';
import type { KeyedLimiter, LoginLimiter } from '../rate-limit.ts';
import { effectiveRole, loadRoleContext, type ProjectRow, projectRow } from '../roles.ts';
import type { Role, Rooms } from '../rooms.ts';
import type { SecurityConfig } from '../security.ts';
import type { Shadows } from '../shadows.ts';
import type { ConnectionGuard } from '../targets.ts';
import { createUser, type NewUser } from '../users.ts';

export type Env = { Variables: { user: User } };

export interface AppContext {
  db: PlatformDb;
  rooms: Rooms;
  shadows: Shadows;
  refresher: OpaqueRefresher;
  loginLimiter: LoginLimiter;
  /** 连接检查的限速（每个用户每分钟 10 次）：服务端替用户去连地址 */
  connectionLimiter: KeyedLimiter;
  /** 连接目标库 / 影子库之前统一跑的检查（SSRF 白名单） */
  guard: ConnectionGuard;
  /** 执行 / 漂移检查共用的上下文（平台库、白名单、环境锁） */
  exec: ExecContext;
  /** 定时漂移检查（main.ts 启动；测试里不启动或调短间隔） */
  drift: DriftScheduler;
  security: SecurityConfig;
  /** 一次性初始化令牌：只在内存里，初始化成功后置空（重启会重新生成） */
  setupToken: string | null;
  /** DOWEL_ALLOW_PASSWORD_LOGIN=1：设置里关了密码登录也能用密码登录的应急入口 */
  allowPasswordLogin: boolean;
  /** 导入、拉取后替换模型；新模型就是引擎读出的，作为派生数据的基线 */
  replace: (branch: string, user: string, model: Model, op: string) => Promise<void>;
  upgradeWebSocket: ReturnType<typeof import('@hono/node-ws').createNodeWebSocket>['upgradeWebSocket'];
}

export const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? '请求不合法' });
  return parsed.data;
};

/** 登录后再访问项目接口：目前只认会话 cookie（Bearer 令牌以后加在这里） */
export const requireUser =
  (db: PlatformDb): MiddlewareHandler<Env> =>
  async (c, next) => {
    // TODO(P6)：先解析 Authorization: Bearer，用令牌认证后再回落到会话 cookie
    const u = await currentUser(db, c);
    if (!u) throw new HTTPException(401, { message: '未登录' });
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
    if (isUniqueViolation(e)) throw new HTTPException(409, { message: '用户名已被使用' });
    throw e;
  }
};

/** 项目行 + 调用者的生效角色；命名和 @dowel/api 里项目授权的响应类型（ProjectAccess）区分开 */
export interface ProjectAccessRow extends ProjectRow {
  pid: string;
  role: Role;
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
  const pid = c.req.param('pid')!;
  const user = c.get('user');
  const p = await projectRow(ctx.db, pid);
  const role = p ? effectiveRole(await loadRoleContext(ctx.db, user), p) : null;
  if (!p || !role) throw new HTTPException(404, { message: '项目不存在' });
  if (!can(userActor(user), action, { kind: 'project', role }))
    throw new HTTPException(403, { message: '没有权限' });
  return { ...p, pid: p.id, role };
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

/** 403 的说明：按环境的执行档位说清楚谁能做 */
const denied = (action: EnvAction, r: EnvRow): string => {
  const policy = effectiveExecPolicy({ production: r.production, execPolicy: r.exec_policy });
  if (policy === 'executor') return '这个环境设置为“仅限执行者”：目前只有实例管理员可以做这个操作';
  const need = policy === 'admin' || isEnvConfigAction(action) ? '项目管理员' : '项目编辑者';
  return `这个环境需要${need}才能做这个操作`;
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
): Promise<ProjectAccessRow & { env: EnvRow }> => {
  const a = await access(c, ctx, 'environment.read');
  const env = await loadEnv(ctx.db, a.pid, eid);
  const actor = userActor(c.get('user'));
  const ok = isEnvAction(action)
    ? can(actor, action, envResource(env, a.role))
    : can(actor, action, { kind: 'project', role: a.role });
  if (!ok)
    throw new HTTPException(403, {
      message: isEnvAction(action) ? denied(action, env) : '没有权限',
    });
  return { ...a, env };
};
