// 通用 OIDC（A7）：
// - /api/admin/oidc：实例管理员配置提供方（保存时做 discovery，返回结果不含 secret）；
// - /api/auth/oidc/:slug/start|callback：授权码 + PKCE + state / nonce；
// - /api/auth/oidc/confirm：用户名冲突或不合法时，让本人确认用户名（短时记录放在平台库）；
// - /api/me/identities：个人设置里查看 / 解除关联。
import {
  type Me,
  type MeIdentity,
  type OidcConfirmInfo,
  type OidcProviderInfo,
  type Ok,
  oidcConfirmSchema,
  oidcProviderCreateSchema,
  oidcProviderPatchSchema,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';

import { audit } from '../audit.ts';
import { currentUser, hashToken, markLogin, startSession } from '../auth.ts';
import { isUniqueViolation, type PlatformDb } from '../db.ts';
import {
  callbackUrl,
  clearDiscoveryCache,
  consumeOidcState,
  countEnabledProviders,
  createOidcPending,
  createOidcState,
  deleteIdentity,
  deletePending,
  discoverProvider,
  displayNameOf,
  hasOtherLoginMethod,
  identityOf,
  linkIdentity,
  listIdentities,
  listProviders,
  mergeUserInfo,
  OIDC_PRESETS,
  OIDC_TTL_MS,
  type OidcProvider,
  pendingByToken,
  profileFromClaims,
  providerById,
  providerBySlug,
  providerInfo,
  provisionFromIdentity,
  safeNext,
  sameToken,
  suggestedUsername,
  touchIdentity,
} from '../oidc.ts';
import { encrypt } from '../secrets.ts';
import { expectedOrigin } from '../security.ts';
import { readSettings } from '../settings.ts';
import { normalizeUsername } from '../usernames.ts';
import { userById, usernameTaken } from '../users.ts';
import { type AppContext, body, type Env } from './context.ts';

const STATE_COOKIE = 'dowel_oidc_state';
const PENDING_COOKIE = 'dowel_oidc_pending';
const COOKIE_PATH = '/api/auth/oidc';

const secureCookie = (c: Context, ctx: AppContext) =>
  (expectedOrigin(c, ctx.security) ?? '').startsWith('https://');

const setShortCookie = (c: Context, ctx: AppContext, name: string, value: string) => {
  setCookie(c, name, value, {
    httpOnly: true,
    sameSite: 'Lax',
    path: COOKIE_PATH,
    maxAge: OIDC_TTL_MS / 1000,
    secure: secureCookie(c, ctx),
  });
};

const clearCookie = (c: Context, name: string) => deleteCookie(c, name, { path: COOKIE_PATH });

type OidcErrorCode =
  | 'provider'
  | 'state'
  | 'token'
  | 'disabled'
  | 'not_invited'
  | 'link_conflict'
  | 'link_session';

/** 回调失败只把固定错误码带回登录页；具体原因写服务端日志 / 审计，绝不放 error_description */
const loginPageError = (c: Context, code: OidcErrorCode) =>
  c.redirect(`/login?oidc_error=${encodeURIComponent(code)}`, 302);

const discoveryError = (e: unknown) =>
  new HTTPException(422, {
    message: `无法读取 OIDC 配置：${e instanceof Error ? e.message : String(e)}`,
  });

const providerForLogin = async (db: PlatformDb, slug: string) => {
  const p = await providerBySlug(db, slug);
  if (!p?.enabled) throw new HTTPException(404, { message: '这个登录方式不存在或已停用' });
  return p;
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** 已登录用户的 OIDC 登录 / 关联成功：开会话（轮换），写审计，然后跳转 */
const finishLogin = async (
  c: Context<Env>,
  ctx: AppContext,
  provider: OidcProvider,
  user: Awaited<ReturnType<typeof userById>>,
  data: Record<string, unknown>,
  next: string,
) => {
  const me = { ...user!, lastLoginAt: await markLogin(ctx.db, user!.id) };
  await startSession(ctx.db, c, me, ctx.security);
  await audit(
    ctx.db,
    c,
    {
      action: 'auth.oidc_login',
      actorKind: 'user',
      actorId: me.id,
      targetKind: 'user',
      targetId: me.id,
      data: { provider: provider.slug, ...data },
    },
    ctx.security,
  );
  return c.redirect(next, 302);
};

export const registerOidcAuth = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/auth/oidc/:slug/start', async (c) => {
    const provider = await providerForLogin(db, c.req.param('slug'));
    const mode = c.req.query('mode') === 'link' ? 'link' : 'login';
    const inviteToken = c.req.query('invite') || null;
    const next = safeNext(c.req.query('next')) ?? (mode === 'link' ? '/account' : '/');
    let userId: string | null = null;
    if (mode === 'link') {
      const u = await currentUser(db, c);
      if (!u) throw new HTTPException(401, { message: '关联账户需要先登录' });
      userId = u.id;
    }
    if (inviteToken) {
      const [invite] = await db.query<{ id: string }>(
        'select id from invites where token_hash = $1 and kind = $2',
        [hashToken(inviteToken), 'invite'],
      );
      if (!invite) throw new HTTPException(404, { message: '邀请链接无效' });
    }

    let config: Awaited<ReturnType<typeof discoverProvider>>;
    try {
      config = await discoverProvider(provider);
    } catch (e) {
      throw discoveryError(e);
    }
    const state = randomState();
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const { token } = await createOidcState(db, {
      providerId: provider.id,
      state,
      nonce,
      codeVerifier,
      mode,
      userId,
      inviteToken,
      next,
    });
    setShortCookie(c, ctx, STATE_COOKIE, token);

    const scope = provider.scopes.split(/\s+/).filter(Boolean);
    if (!scope.includes('openid')) scope.unshift('openid');
    const url = buildAuthorizationUrl(config, {
      redirect_uri: callbackUrl(c, ctx.security, provider.slug).toString(),
      response_type: 'code',
      scope: scope.join(' '),
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return c.redirect(url.toString(), 302);
  });

  app.get('/api/auth/oidc/:slug/callback', async (c) => {
    const provider = await providerBySlug(db, c.req.param('slug'));
    if (!provider?.enabled) return loginPageError(c, 'provider');
    const providerError = c.req.query('error');
    if (providerError) {
      // IdP 的 error_description 不可信，只写服务端日志，绝不带回登录页
      console.error('OIDC 提供方返回错误', {
        provider: provider.slug,
        error: providerError,
        description: c.req.query('error_description'),
      });
      clearCookie(c, STATE_COOKIE);
      return loginPageError(c, 'provider');
    }

    const cookie = getCookie(c, STATE_COOKIE);
    if (!cookie) return loginPageError(c, 'state');
    const state = await consumeOidcState(db, cookie);
    clearCookie(c, STATE_COOKIE);
    if (!state || state.providerId !== provider.id) return loginPageError(c, 'state');
    if (Date.parse(state.expiresAt) <= Date.now()) return loginPageError(c, 'state');
    const provided = c.req.query('state');
    if (!provided || !sameToken(state.state, provided)) return loginPageError(c, 'state');
    const code = c.req.query('code');
    if (!code) return loginPageError(c, 'token');

    let config: Awaited<ReturnType<typeof discoverProvider>>;
    try {
      config = await discoverProvider(provider);
    } catch (e) {
      console.error('OIDC discovery 失败', e);
      return loginPageError(c, 'provider');
    }
    // 用 callbackUrl() 构造 currentUrl（并拼上当前查询串），保证 token 请求里的 redirect_uri
    // 与授权请求完全一致；不能直接用 c.req.url，否则反向代理 / DOWEL_PUBLIC_URL 下会不一致。
    const currentUrl = callbackUrl(c, ctx.security, provider.slug);
    currentUrl.search = new URL(c.req.url).search;
    let token: Awaited<ReturnType<typeof authorizationCodeGrant>>;
    try {
      token = await authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: state.codeVerifier,
        expectedState: provided,
        expectedNonce: state.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      console.error('OIDC id_token 校验失败', e);
      return loginPageError(c, 'token');
    }
    const claims = token.claims();
    const base = claims ? profileFromClaims(asRecord(claims)) : null;
    if (!base) {
      console.error('OIDC id_token 里没有 sub');
      return loginPageError(c, 'token');
    }
    const profile = token.access_token ? await mergeUserInfo(config, token.access_token, base) : base;

    /** link 模式必须由发起关联的同一个用户完成；切换会话或未登录都拒绝 */
    const linkUser = async () => {
      const current = await currentUser(db, c);
      if (!current || !state.userId || current.id !== state.userId) return null;
      return current;
    };

    const existing = await identityOf(db, provider.id, profile.sub);
    if (existing) {
      if (state.mode === 'link') {
        const current = await linkUser();
        if (!current) return loginPageError(c, 'link_session');
        if (existing.userId !== current.id) return loginPageError(c, 'link_conflict');
        clearCookie(c, PENDING_COOKIE);
        return c.redirect(state.next ?? '/account', 302);
      }
      if (existing.userStatus !== 'active') return loginPageError(c, 'disabled');
      await touchIdentity(db, provider.id, profile.sub);
      const user = await userById(db, existing.userId);
      if (!user) return loginPageError(c, 'disabled');
      return finishLogin(c, ctx, provider, user, { subject: profile.sub }, state.next ?? '/');
    }

    if (state.mode === 'link') {
      const current = await linkUser();
      if (!current) return loginPageError(c, 'link_session');
      const [own] = await db.query('select 1 from user_identities where provider_id = $1 and user_id = $2', [
        provider.id,
        current.id,
      ]);
      if (own) return loginPageError(c, 'link_conflict');
      await linkIdentity(db, provider.id, profile.sub, current.id);
      await audit(
        db,
        c,
        {
          action: 'identity.link',
          actorKind: 'user',
          actorId: current.id,
          targetKind: 'user',
          targetId: current.id,
          data: { provider: provider.slug, subject: profile.sub },
        },
        ctx.security,
      );
      clearCookie(c, PENDING_COOKIE);
      // 关联成功回到发起关联的页面（默认 /account，即个人设置）
      return c.redirect(state.next ?? '/account', 302);
    }

    if (!state.inviteToken && !provider.autoProvision) {
      await audit(
        db,
        c,
        {
          action: 'auth.oidc_login_failed',
          actorKind: 'system',
          actorId: null,
          data: { provider: provider.slug, subject: profile.sub, reason: 'not_invited' },
        },
        ctx.security,
      );
      return loginPageError(c, 'not_invited');
    }

    const suggested = suggestedUsername(profile);
    const name = displayNameOf(profile, suggested.username);
    if (suggested.needsConfirm) {
      const pending = await createOidcPending(db, {
        providerId: provider.id,
        subject: profile.sub,
        username: suggested.username,
        name,
        email: profile.email,
        inviteToken: state.inviteToken,
      });
      setShortCookie(c, ctx, PENDING_COOKIE, pending);
      return c.redirect('/oidc/confirm', 302);
    }

    try {
      const user = await provisionFromIdentity(db, {
        providerId: provider.id,
        subject: profile.sub,
        username: suggested.username,
        name,
        email: profile.email,
        inviteToken: state.inviteToken,
      });
      return finishLogin(
        c,
        ctx,
        provider,
        user,
        { subject: profile.sub, provisioned: true, invite: !!state.inviteToken },
        state.next ?? '/',
      );
    } catch (e) {
      // 同一个 subject 并发开户：另一个回调已经建好身份，直接登录它，而不是去确认用户名
      const raced = await identityOf(db, provider.id, profile.sub);
      if (raced) {
        if (raced.userStatus !== 'active') return loginPageError(c, 'disabled');
        await touchIdentity(db, provider.id, profile.sub);
        const user = await userById(db, raced.userId);
        if (!user) return loginPageError(c, 'disabled');
        return finishLogin(c, ctx, provider, user, { subject: profile.sub, race: true }, state.next ?? '/');
      }
      // 只有 users.username 冲突才转到确认页；其他唯一约束冲突照常抛出
      if (isUniqueViolation(e) && (await usernameTaken(db, suggested.username))) {
        const pending = await createOidcPending(db, {
          providerId: provider.id,
          subject: profile.sub,
          username: suggested.username,
          name,
          email: profile.email,
          inviteToken: state.inviteToken,
        });
        setShortCookie(c, ctx, PENDING_COOKIE, pending);
        return c.redirect('/oidc/confirm', 302);
      }
      throw e;
    }
  });

  app.get('/api/auth/oidc/confirm', async (c) => {
    const token = getCookie(c, PENDING_COOKIE);
    if (!token) throw new HTTPException(410, { message: '确认状态已过期，请重新登录' });
    const pending = await pendingByToken(db, token);
    if (!pending || Date.parse(pending.expiresAt) <= Date.now())
      throw new HTTPException(410, { message: '确认状态已过期，请重新登录' });
    const provider = await providerById(db, pending.providerId);
    return c.json<OidcConfirmInfo>({
      providerName: provider?.name ?? '',
      username: pending.username,
      name: pending.name,
      email: pending.email,
    });
  });

  app.post('/api/auth/oidc/confirm', async (c) => {
    const token = getCookie(c, PENDING_COOKIE);
    if (!token) throw new HTTPException(410, { message: '确认状态已过期，请重新登录' });
    const pending = await pendingByToken(db, token);
    if (!pending || Date.parse(pending.expiresAt) <= Date.now())
      throw new HTTPException(410, { message: '确认状态已过期，请重新登录' });
    const provider = await providerById(db, pending.providerId);
    if (!provider?.enabled) throw new HTTPException(410, { message: '这个登录方式已经停用' });
    const b = await body(c, oidcConfirmSchema);
    if (await usernameTaken(db, b.username)) throw new HTTPException(409, { message: '用户名已被使用' });

    let user: Awaited<ReturnType<typeof provisionFromIdentity>>;
    try {
      user = await provisionFromIdentity(db, {
        providerId: provider.id,
        subject: pending.subject,
        username: b.username,
        name: pending.name,
        email: pending.email,
        inviteToken: pending.inviteToken,
      });
    } catch (e) {
      // 并发时另一个请求已经建好同一个 subject 的身份：直接登录已有用户
      const raced = await identityOf(db, provider.id, pending.subject);
      if (raced) {
        if (raced.userStatus !== 'active') throw new HTTPException(403, { message: '这个用户已被停用' });
        await touchIdentity(db, provider.id, pending.subject);
        const existing = await userById(db, raced.userId);
        if (!existing) throw new HTTPException(403, { message: '这个用户已被删除' });
        user = existing;
        await deletePending(db, token);
        clearCookie(c, PENDING_COOKIE);
        const racedMe = { ...user, lastLoginAt: await markLogin(db, user.id) };
        await startSession(db, c, racedMe, ctx.security);
        await audit(
          db,
          c,
          {
            action: 'auth.oidc_login',
            actorKind: 'user',
            actorId: racedMe.id,
            targetKind: 'user',
            targetId: racedMe.id,
            data: { provider: provider.slug, subject: pending.subject, race: true },
          },
          ctx.security,
        );
        return c.json<Me>(racedMe);
      }
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '用户名已被使用' });
      throw e;
    }
    await deletePending(db, token);
    clearCookie(c, PENDING_COOKIE);
    const me = { ...user, lastLoginAt: await markLogin(db, user.id) };
    await startSession(db, c, me, ctx.security);
    await audit(
      db,
      c,
      {
        action: 'auth.oidc_login',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'user',
        targetId: me.id,
        data: {
          provider: provider.slug,
          subject: pending.subject,
          provisioned: true,
          invite: !!pending.inviteToken,
          confirmedUsername: true,
        },
      },
      ctx.security,
    );
    return c.json<Me>(me);
  });
};

export const registerOidcMe = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/me/identities', async (c) => {
    return c.json<MeIdentity[]>(await listIdentities(db, c.get('user').id));
  });

  app.delete('/api/me/identities/:id', async (c) => {
    const me = c.get('user');
    const id = c.req.param('id');
    const identity = (await listIdentities(db, me.id)).find((i) => i.id === id);
    if (!identity) throw new HTTPException(404, { message: '身份不存在' });
    const settings = await readSettings(db);
    const passwordLogin = settings.passwordLogin || ctx.allowPasswordLogin;
    if (!(await hasOtherLoginMethod(db, me.id, id, passwordLogin)))
      throw new HTTPException(422, { message: '这是最后一个登录方式，不能解除关联' });
    await deleteIdentity(db, me.id, id);
    await audit(
      db,
      c,
      {
        action: 'identity.unlink',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'user',
        targetId: me.id,
        data: { provider: identity.providerSlug, subject: identity.subject },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });
};

const providerConfig = async (p: OidcProvider) => {
  try {
    new URL(p.issuer);
    await discoverProvider(p);
  } catch (e) {
    throw discoveryError(e);
  }
};

/**
 * 返回给管理界面的提供方信息。回调地址由服务端按 callbackUrl() 的规则算（和真正授权请求里的
 * redirect_uri 完全一致），前端只负责显示 / 复制；拿不到对外地址时为 null。
 */
const adminProviderInfo = (c: Context<Env>, ctx: AppContext, p: OidcProvider): OidcProviderInfo => {
  let url: string | null = null;
  try {
    url = callbackUrl(c, ctx.security, p.slug).toString();
  } catch {
    url = null;
  }
  return { ...providerInfo(p), callbackUrl: url };
};

export const registerOidcAdmin = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;
  const actorId = (c: Context<Env>) => c.get('user').id;

  app.get('/api/admin/oidc/presets', async (c) => c.json(OIDC_PRESETS));

  app.get('/api/admin/oidc', async (c) =>
    c.json((await listProviders(db)).map((p) => adminProviderInfo(c, ctx, p))),
  );

  app.post('/api/admin/oidc', async (c) => {
    const b = await body(c, oidcProviderCreateSchema);
    const slug = normalizeUsername(b.slug);
    if (await providerBySlug(db, slug)) throw new HTTPException(409, { message: '这个标识已被使用' });
    const now = new Date().toISOString();
    const p: OidcProvider = {
      id: newId(),
      slug,
      name: b.name,
      issuer: b.issuer,
      clientId: b.clientId,
      clientSecretEnc: encrypt(b.clientSecret),
      scopes: b.scopes,
      enabled: b.enabled,
      autoProvision: b.autoProvision,
      createdAt: now,
      updatedAt: now,
    };
    await providerConfig(p);
    try {
      await db.query(
        `insert into oidc_providers
           (id, slug, name, issuer, client_id, client_secret_enc, scopes, enabled, auto_provision,
            created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          p.id,
          p.slug,
          p.name,
          p.issuer,
          p.clientId,
          p.clientSecretEnc,
          p.scopes,
          p.enabled,
          p.autoProvision,
          now,
        ],
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个标识已被使用' });
      throw e;
    }
    await audit(
      db,
      c,
      {
        action: 'oidc.provider_create',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'oidc_provider',
        targetId: p.id,
        data: { slug: p.slug, issuer: p.issuer, enabled: p.enabled, autoProvision: p.autoProvision },
      },
      ctx.security,
    );
    return c.json(adminProviderInfo(c, ctx, p), 201);
  });

  app.patch('/api/admin/oidc/:id', async (c) => {
    const id = c.req.param('id');
    const current = await providerById(db, id);
    if (!current) throw new HTTPException(404, { message: '提供方不存在' });
    const b = await body(c, oidcProviderPatchSchema);
    const now = new Date().toISOString();
    const next: OidcProvider = {
      ...current,
      slug: b.slug !== undefined ? normalizeUsername(b.slug) : current.slug,
      name: b.name ?? current.name,
      issuer: b.issuer ?? current.issuer,
      clientId: b.clientId ?? current.clientId,
      scopes: b.scopes ?? current.scopes,
      enabled: b.enabled ?? current.enabled,
      autoProvision: b.autoProvision ?? current.autoProvision,
      updatedAt: now,
    };
    if (b.clientSecret !== undefined) {
      if (!b.clientSecret) throw new HTTPException(422, { message: 'client_secret 不能为空' });
      next.clientSecretEnc = encrypt(b.clientSecret);
    }
    if (next.slug !== current.slug && (await providerBySlug(db, next.slug)))
      throw new HTTPException(409, { message: '这个标识已被使用' });

    // 只有连接配置变化或从停用改为启用才需要 discovery；单纯停用 / 改名不访问 issuer
    const needsDiscovery =
      next.issuer !== current.issuer ||
      next.clientId !== current.clientId ||
      next.clientSecretEnc !== current.clientSecretEnc ||
      (!current.enabled && next.enabled);
    if (needsDiscovery) await providerConfig(next);

    try {
      await db.transaction(async (tx) => {
        // PG 下锁住所有提供方行，把“最后一个启用的提供方”检查与写入串行化；SQLite 事务本身串行
        if (db.dialect === 'pg') await tx.query('select id from oidc_providers order by id for update');
        const fresh = await providerById(tx, id);
        if (!fresh) throw new HTTPException(404, { message: '提供方不存在' });
        const passwordLogin = (await readSettings(tx)).passwordLogin;
        if (fresh.enabled && !next.enabled && !passwordLogin && (await countEnabledProviders(tx)) <= 1)
          throw new HTTPException(422, {
            message: '这是最后一个启用的 OIDC 登录方式，而密码登录已关闭，不能停用',
          });
        await tx.query(
          `update oidc_providers set slug = $2, name = $3, issuer = $4, client_id = $5,
             client_secret_enc = $6, scopes = $7, enabled = $8, auto_provision = $9, updated_at = $10
           where id = $1`,
          [
            next.id,
            next.slug,
            next.name,
            next.issuer,
            next.clientId,
            next.clientSecretEnc,
            next.scopes,
            next.enabled,
            next.autoProvision,
            next.updatedAt,
          ],
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个标识已被使用' });
      throw e;
    }
    clearDiscoveryCache(next.id);
    await audit(
      db,
      c,
      {
        action: 'oidc.provider_update',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'oidc_provider',
        targetId: next.id,
        // 只记改了哪些字段，绝不记 secret 的值
        data: { slug: next.slug, changed: Object.keys(b), discovery: needsDiscovery },
      },
      ctx.security,
    );
    return c.json(adminProviderInfo(c, ctx, next));
  });

  app.delete('/api/admin/oidc/:id', async (c) => {
    const id = c.req.param('id');
    const p = await providerById(db, id);
    if (!p) throw new HTTPException(404, { message: '提供方不存在' });
    await db.transaction(async (tx) => {
      if (db.dialect === 'pg') await tx.query('select id from oidc_providers order by id for update');
      const fresh = await providerById(tx, id);
      if (!fresh) throw new HTTPException(404, { message: '提供方不存在' });
      const passwordLogin = (await readSettings(tx)).passwordLogin;
      if (fresh.enabled && !passwordLogin && (await countEnabledProviders(tx)) <= 1)
        throw new HTTPException(422, {
          message: '这是最后一个启用的 OIDC 登录方式，而密码登录已关闭，不能删除',
        });
      await tx.query('delete from oidc_providers where id = $1', [id]);
    });
    clearDiscoveryCache(p.id);
    await audit(
      db,
      c,
      {
        action: 'oidc.provider_delete',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'oidc_provider',
        targetId: p.id,
        data: { slug: p.slug, name: p.name },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });
};
