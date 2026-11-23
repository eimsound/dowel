// 认证：登录、退出、当前用户与公开实例信息。注册只通过邀请（见 account.ts），不再有公开的注册接口。
import { type ApiErrorBody, type InstanceInfo, loginSchema, type Me, type Ok } from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { currentUser, endSession, login, startSession } from '../auth.ts';
import { publicProviders } from '../oidc.ts';
import { clientIp } from '../security.ts';
import { readSettings } from '../settings.ts';
import { normalizeUsername } from '../users.ts';
import { type AppContext, body, type Env } from './context.ts';

export const registerAuth = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/instance', async (c) => {
    const settings = await readSettings(db);
    return c.json<InstanceInfo>({
      name: settings.name,
      // 应急变量打开时，即使设置里关了也算可用（登录接口也是这么判断的）
      passwordLogin: settings.passwordLogin || ctx.allowPasswordLogin,
      providers: await publicProviders(db),
    });
  });

  app.post('/api/auth/login', async (c) => {
    const b = await body(c, loginSchema);
    const settings = await readSettings(db);
    // 关闭密码登录后唯一的入口是 OIDC；DOWEL_ALLOW_PASSWORD_LOGIN=1 是应急入口
    if (!settings.passwordLogin && !ctx.allowPasswordLogin)
      throw new HTTPException(403, { message: '密码登录已关闭，请联系实例管理员' });

    const ip = clientIp(c, ctx.security);
    const account = normalizeUsername(b.username);
    // 检查和记录在同一次同步调用里完成，之后的 await login() 不会让并发请求绕过上限
    const gate = ctx.loginLimiter.attempt(ip, account);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSeconds));
      return c.json<ApiErrorBody>({ error: '登录失败次数过多，请稍后再试' }, 429);
    }
    const result = await login(db, account, b.password);
    if (!result.ok) {
      await audit(
        db,
        c,
        {
          action: 'auth.login_failed',
          actorKind: 'system',
          actorId: null,
          data: { username: account, reason: result.reason },
        },
        ctx.security,
      );
      // 停用的用户给出明确原因（他已经知道这个账号存在），其余一律“用户名或密码错误”
      if (result.reason === 'disabled') throw new HTTPException(403, { message: '这个用户已被停用' });
      throw new HTTPException(401, { message: '用户名或密码错误' });
    }
    ctx.loginLimiter.succeed(ip, account);
    await startSession(db, c, result.user, ctx.security);
    await audit(
      db,
      c,
      {
        action: 'auth.login',
        actorKind: 'user',
        actorId: result.user.id,
        targetKind: 'user',
        targetId: result.user.id,
      },
      ctx.security,
    );
    return c.json<Me>(result.user);
  });

  app.post('/api/auth/logout', async (c) => {
    const u = await currentUser(db, c);
    await endSession(db, c);
    if (u)
      await audit(
        db,
        c,
        {
          action: 'auth.logout',
          actorKind: 'user',
          actorId: u.id,
          targetKind: 'user',
          targetId: u.id,
        },
        ctx.security,
      );
    return c.json<Ok>({ ok: true });
  });

  app.get('/api/auth/me', async (c) => {
    const u = await currentUser(db, c);
    return u ? c.json<Me>(u) : c.json<ApiErrorBody>({ error: '未登录' }, 401);
  });
};
