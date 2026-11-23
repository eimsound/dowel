// 认证：登录、忘记密码、退出、当前用户与公开实例信息。注册只通过邀请（见 account.ts），不再有公开的注册接口。
import {
  type ApiErrorBody,
  forgotPasswordSchema,
  type InstanceInfo,
  loginSchema,
  type Me,
  type Ok,
} from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { currentUser, endSession, login, startSession } from '../auth.ts';
import {
  isEmailConfiguredAndEnabled,
  isEmailEnabled,
  passwordResetEmailTemplate,
  readStoredEmailSettings,
  resolveSmtpConfig,
} from '../email.ts';
import { createInvite, revokeInvite } from '../invites.ts';
import { publicProviders } from '../oidc.ts';
import { scrubSecrets } from '../secrets.ts';
import { clientIp, expectedOrigin } from '../security.ts';
import { readSettings } from '../settings.ts';
import { normalizeUsername, userByEmail } from '../users.ts';
import { type AppContext, body, type Env } from './context.ts';

const FORGOT_RESET_HOURS = 1;

export const registerAuth = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/instance', async (c) => {
    const settings = await readSettings(db);
    return c.json<InstanceInfo>({
      name: settings.name,
      // 应急变量打开时，即使设置里关了也算可用（登录接口也是这么判断的）
      passwordLogin: settings.passwordLogin || ctx.allowPasswordLogin,
      emailEnabled: await isEmailEnabled(db),
      providers: await publicProviders(db),
    });
  });

  app.post('/api/auth/forgot-password', async (c) => {
    const b = await body(c, forgotPasswordSchema);
    const settings = await readSettings(db);
    if (!settings.passwordLogin && !ctx.allowPasswordLogin) {
      throw new HTTPException(403, { message: '密码登录已关闭，请联系实例管理员' });
    }
    const stored = await readStoredEmailSettings(db);
    if (!isEmailConfiguredAndEnabled(stored)) {
      throw new HTTPException(422, { message: '实例尚未启用邮件服务，请联系管理员重置密码' });
    }
    const origin = expectedOrigin(c, ctx.security);
    if (!origin) {
      throw new HTTPException(422, { message: '无法确定对外访问地址，请设置 DOWEL_PUBLIC_URL' });
    }
    const smtpConfig = resolveSmtpConfig(stored);
    const ip = clientIp(c, ctx.security);
    const gate = ctx.forgotPasswordLimiter.attempt(ip, b.email);
    if (!gate.allowed) {
      c.header('Retry-After', String(gate.retryAfterSeconds));
      return c.json<ApiErrorBody>({ error: '密码重置请求过于频繁，请稍后再试' }, 429);
    }

    // 防邮箱枚举：无论邮箱是否存在、是否停用或为纯 OIDC 无密码账户，对外统一返回 { ok: true }
    const user = await userByEmail(db, b.email);
    if (!user || user.status !== 'active' || !user.hasPassword) {
      return c.json<Ok>({ ok: true });
    }

    const { invite, url } = await db.transaction(async (tx) => {
      await tx.query(
        `update invites set revoked_at = $2
          where kind = 'reset' and user_id = $1 and used_at is null and revoked_at is null`,
        [user.id, new Date().toISOString()],
      );
      return createInvite(tx, {
        kind: 'reset',
        createdBy: user.id,
        userId: user.id,
        expiresInMs: FORGOT_RESET_HOURS * 3600_000,
      });
    });

    const resetUrl = `${origin}${url}`;
    const tpl = passwordResetEmailTemplate({
      instanceName: settings.name,
      username: user.username,
      resetUrl,
      expiresInHours: FORGOT_RESET_HOURS,
    });
    let delivered = false;
    try {
      await ctx.mailer(smtpConfig, { to: b.email, ...tpl });
      delivered = true;
    } catch (e) {
      await revokeInvite(db, invite.id).catch(() => {});
      console.error('发送忘记密码邮件失败', scrubSecrets(e instanceof Error ? e.message : String(e)));
    }

    await audit(
      db,
      c,
      {
        action: 'auth.forgot_password_request',
        actorKind: 'system',
        actorId: null,
        targetKind: 'user',
        targetId: user.id,
        data: { username: user.username, delivered },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
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
