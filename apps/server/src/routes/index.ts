// 路由组装：认证 → WebSocket Origin → requireUser → 各项目接口。
// Hono 的 app.use 只对之后注册的路由生效，所以这里的顺序就是行为的一部分。
import type { Hono } from 'hono';
import { wsOriginGuard } from '../security.ts';
import { registerInvites, registerMe } from './account.ts';
import { registerActivity } from './activity.ts';
import { registerAdmin } from './admin.ts';
import { registerAudit } from './audit.ts';
import { registerAuth } from './auth.ts';
import { registerClaims } from './claims.ts';
import { registerConnection } from './connection.ts';
import { type AppContext, type Env, requireInstanceAdmin, requireUser } from './context.ts';
import { registerDirectory } from './directory.ts';
import { registerEnvironments } from './environments.ts';
import { registerExecutions } from './executions.ts';
import { registerGrants } from './grants.ts';
import { registerGroups } from './groups.ts';
import { registerOidcAdmin, registerOidcAuth, registerOidcMe } from './oidc.ts';
import { registerPolicy } from './policy.ts';
import { registerProjects } from './projects.ts';
import { registerSetup } from './setup.ts';
import { registerSync } from './sync.ts';
import { registerTakeover } from './takeover.ts';
import { registerVersions } from './versions.ts';
import { registerWizard } from './wizard.ts';

export const registerRoutes = (app: Hono<Env>, ctx: AppContext) => {
  // 公开接口：登录 / 退出、初始化与实例信息、接受邀请、重置密码
  registerAuth(app, ctx);
  registerOidcAuth(app, ctx);
  registerSetup(app, ctx);
  registerInvites(app, ctx);

  // 个人设置
  app.use('/api/me', requireUser(ctx.db));
  app.use('/api/me/*', requireUser(ctx.db));
  registerMe(app, ctx);
  registerOidcMe(app, ctx);

  // 实例管理：先登录，再按各自的实例级动作要求实例管理员
  app.use('/api/admin/*', requireUser(ctx.db));
  for (const [path, action] of [
    ['/api/admin/settings', 'instance.manage_settings'],
    ['/api/admin/users', 'instance.manage_users'],
    ['/api/admin/users/*', 'instance.manage_users'],
    ['/api/admin/invites', 'instance.invite'],
    ['/api/admin/invites/*', 'instance.invite'],
    ['/api/admin/grants', 'instance.manage_grants'],
    ['/api/admin/grants/*', 'instance.manage_grants'],
    ['/api/admin/oidc', 'instance.manage_settings'],
    ['/api/admin/oidc/*', 'instance.manage_settings'],
    ['/api/admin/audit', 'instance.view_audit'],
    ['/api/admin/exec-policy', 'instance.manage_policy'],
  ] as const)
    app.use(path, requireInstanceAdmin(action));
  registerAdmin(app, ctx);
  registerOidcAdmin(app, ctx);
  registerAudit(app, ctx);

  // 组、用户 / 组选择器、按路径解析项目：所有已登录用户可用（可见性由各自的接口判断）
  app.use('/api/groups', requireUser(ctx.db));
  app.use('/api/groups/*', requireUser(ctx.db));
  app.use('/api/directory', requireUser(ctx.db));
  app.use('/api/resolve/*', requireUser(ctx.db));
  registerGroups(app, ctx);
  registerDirectory(app, ctx);

  // WebSocket 的 Origin 校验在登录检查之前（跨源升级一律 403）
  app.use('/api/projects/:pid/sync', wsOriginGuard(ctx.security));
  app.use('/api/projects', requireUser(ctx.db));
  app.use('/api/projects/*', requireUser(ctx.db));
  // 连接检查（向导第 2 步）和向导本身都在建项目之前，鉴权在各自的路由里按组的动作判断
  app.use('/api/connection-check', requireUser(ctx.db));
  registerConnection(app, ctx);
  registerWizard(app, ctx);
  app.use('/api/takeover/*', requireUser(ctx.db));
  registerTakeover(app, ctx);
  registerProjects(app, ctx);
  registerGrants(app, ctx);
  registerVersions(app, ctx);
  registerActivity(app, ctx);
  // attach 要在 /environments/:eid 之前注册（否则 :eid 会吃掉 attach）
  registerClaims(app, ctx);
  registerEnvironments(app, ctx);
  registerExecutions(app, ctx);
  // 执行策略：实例层在 /api/admin 下（上面已要求实例管理员），组层在 /api/groups 下，项目 / 环境层在 /api/projects 下
  registerPolicy(app, ctx);
  registerSync(app, ctx);
};
