// 通用 OIDC（A7）集成测试：用 oauth2-mock-server 起一个本地 OIDC 提供方，
// 走真实的 discovery、authorize、token、userinfo、PKCE、state 和 nonce 校验。
import { Events, OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import {
  clearDiscoveryCache,
  countEnabledProviders,
  hasOtherLoginMethod,
  provisionFromIdentity,
  safeNext,
} from '../src/oidc.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { hasOidcProvider } from '../src/settings.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'oidc-test-secret-0123456789';

const mock = new OAuth2Server();
let issuer = '';
let claims: Record<string, unknown> = {};
let nonceOverride: string | null = null;
let discoveryCount = 0;
let lastTokenRedirectUri: string | null = null;

beforeAll(async () => {
  await mock.issuer.keys.generate('RS256');
  await mock.start(0, '127.0.0.1');
  issuer = mock.issuer.url!;
  mock.service.on(Events.BeforeWellKnownOpenIdConfiguration, () => {
    discoveryCount++;
  });
  mock.service.on(Events.BeforeTokenSigning, (token, req) => {
    Object.assign(token.payload, claims);
    if (nonceOverride) token.payload.nonce = nonceOverride;
    const redirect = (req.body as { redirect_uri?: unknown } | undefined)?.redirect_uri;
    if (typeof redirect === 'string') lastTokenRedirectUri = redirect;
  });
  mock.service.on(Events.BeforeUserinfo, (res) => {
    Object.assign(res.body as Record<string, unknown>, claims);
  });
});

afterAll(async () => {
  await mock.stop();
});

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let admin: { id: string; cookie: string };

interface CallResult {
  status: number;
  data: Record<string, unknown>;
  setCookies: string[];
  location: string | null;
}

const call = async (
  method: string,
  path: string,
  json?: unknown,
  cookie = '',
  headers: Record<string, string> = {},
): Promise<CallResult> => {
  const h: Record<string, string> = { ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers: h,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { text };
  }
  return {
    status: res.status,
    data,
    setCookies:
      res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []),
    location: res.headers.get('location'),
  };
};

const cookieFrom = (r: CallResult, name: string) =>
  r.setCookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? '';

const boot = async (options: Parameters<typeof createApp>[1] = {}) => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, {
    // 矩阵以外的用例也可能多次登录，放宽限速避免测试自身触发 429
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    ...options,
  });
  app = created.app;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  const login = await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  expect(login.status).toBe(200);
  admin = { id: login.data.id as string, cookie: cookieFrom(login, 'dowel_session') };
};

beforeEach(async () => {
  claims = {
    sub: 'subject-alice',
    preferred_username: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
  };
  nonceOverride = null;
  lastTokenRedirectUri = null;
  discoveryCount = 0;
  await boot();
});

afterEach(async () => {
  await stop();
  await db.close();
});

const createProvider = async (extra: Record<string, unknown> = {}) => {
  const r = await call(
    'POST',
    '/api/admin/oidc',
    {
      slug: 'mock',
      name: 'Mock',
      issuer,
      clientId: 'dowel-client',
      clientSecret: 'top-secret-value',
      ...extra,
    },
    admin.cookie,
  );
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data;
};

const invite = async () => {
  const r = await call('POST', '/api/admin/invites', {}, admin.cookie);
  expect(r.status).toBe(201);
  return r.data.token as string;
};

/** 开始登录：返回 state cookie 和提供方重定向后的回调地址 */
const startLogin = async (query: string, cookie = '') => {
  const r = await call('GET', `/api/auth/oidc/mock/start?${query}`, undefined, cookie);
  expect(r.status, JSON.stringify(r.data)).toBe(302);
  const stateCookie = cookieFrom(r, 'dowel_oidc_state');
  expect(stateCookie).toBeTruthy();
  const authorize = await fetch(r.location!, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  return { stateCookie, callback: authorize.headers.get('location')! };
};

const finishLogin = async (start: { stateCookie: string; callback: string }, cookie = '') => {
  const u = new URL(start.callback);
  const cookies = [cookie, start.stateCookie].filter(Boolean).join('; ');
  return call('GET', `${u.pathname}${u.search}`, undefined, cookies);
};

const loginWithOidc = async (inviteToken?: string, cookie = '') => {
  const start = await startLogin(
    inviteToken ? `invite=${inviteToken}&next=/projects` : 'next=/projects',
    cookie,
  );
  return { start, result: await finishLogin(start, cookie) };
};

describe('OIDC 登录', () => {
  test('邀请 + 首次开户：建用户、关联身份、认领邀请、开会话并写审计', async () => {
    await createProvider();
    const token = await invite();
    const { result } = await loginWithOidc(token);
    expect(result.status).toBe(302);
    expect(result.location).toBe('/projects');
    const session = cookieFrom(result, 'dowel_session');
    expect(session).toBeTruthy();

    const me = await call('GET', '/api/auth/me', undefined, session);
    expect(me.data).toMatchObject({ username: 'alice', email: 'alice@example.com', role: 'member' });
    const identities = await call('GET', '/api/me/identities', undefined, session);
    expect(identities.data).toMatchObject([{ providerSlug: 'mock', subject: 'subject-alice' }]);

    const [used] = await db.query<{ usedBy: string }>(
      'select used_by as "usedBy" from invites where token_hash is not null',
    );
    expect(used!.usedBy).toBe(me.data.id);
    const [audit] = await db.query<{ action: string; data: unknown }>(
      "select action, data from audit_events where action = 'auth.oidc_login'",
    );
    expect(audit).toBeDefined();
    expect((audit!.data as Record<string, unknown>).provider).toBe('mock');
    expect((audit!.data as Record<string, unknown>).provisioned).toBe(true);
  });

  test('用户名冲突：跳到确认页，改用户名后完成开户', async () => {
    await createProvider();
    await makeUser(db, 'alice', { name: '已存在的 Alice' });
    const token = await invite();
    const { result } = await loginWithOidc(token);
    expect(result.status).toBe(302);
    expect(result.location).toBe('/oidc/confirm');
    const pending = cookieFrom(result, 'dowel_oidc_pending');
    expect(pending).toBeTruthy();

    const info = await call('GET', '/api/auth/oidc/confirm', undefined, pending);
    expect(info.status).toBe(200);
    expect(info.data).toMatchObject({ providerName: 'Mock', username: 'alice', name: 'Alice' });

    // 冲突的用户名仍然被拒绝，确认状态保留，可以重试
    expect((await call('POST', '/api/auth/oidc/confirm', { username: 'alice' }, pending)).status).toBe(409);
    const done = await call('POST', '/api/auth/oidc/confirm', { username: 'alice-2' }, pending);
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ username: 'alice-2', role: 'member' });
    const session = cookieFrom(done, 'dowel_session');
    expect((await call('GET', '/api/auth/me', undefined, session)).status).toBe(200);

    // 邀请已经用掉
    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({ state: 'used' });
  });

  test('没有邀请且没有 auto_provision：拒绝并回到登录页显示原因', async () => {
    await createProvider();
    const { result } = await loginWithOidc();
    expect(result.status).toBe(302);
    expect(result.location).toBe('/login?oidc_error=not_invited');
    const [failed] = await db.query<{ action: string }>(
      "select action from audit_events where action = 'auth.oidc_login_failed'",
    );
    expect(failed).toBeDefined();
  });

  test('开启 auto_provision 后无需邀请即可开户', async () => {
    await createProvider({ autoProvision: true });
    const { result } = await loginWithOidc();
    expect(result.status).toBe(302);
    expect(result.location).toBe('/projects');
    expect(
      (await call('GET', '/api/auth/me', undefined, cookieFrom(result, 'dowel_session'))).data,
    ).toMatchObject({ username: 'alice', role: 'member' });
  });

  test('已关联的用户直接登录，不需要邀请', async () => {
    await createProvider();
    const first = await loginWithOidc(await invite());
    expect(first.result.status).toBe(302);
    const again = await loginWithOidc();
    expect(again.result.status).toBe(302);
    expect(again.result.location).toBe('/projects');
    const [count] = await db.query<{ n: number }>('select count(*) as n from users');
    expect(Number(count!.n)).toBe(2); // admin + alice
  });

  test('停用用户被拒绝，只带回 disabled 错误码', async () => {
    await createProvider();
    const first = await loginWithOidc(await invite());
    const session = cookieFrom(first.result, 'dowel_session');
    const me = await call('GET', '/api/auth/me', undefined, session);
    await call('PATCH', `/api/admin/users/${me.data.id as string}`, { status: 'disabled' }, admin.cookie);
    const again = await loginWithOidc();
    expect(again.result.status).toBe(302);
    expect(again.result.location).toBe('/login?oidc_error=disabled');
  });

  test('已登录时可以把身份关联到当前用户；已被别人关联时报错', async () => {
    await createProvider();
    // 管理员先关联一个身份
    const linked = await startLogin('mode=link', admin.cookie);
    const ok = await finishLogin(linked, admin.cookie);
    expect(ok.status).toBe(302);
    expect(ok.location).toBe('/account');
    const identities = await call('GET', '/api/me/identities', undefined, admin.cookie);
    expect(identities.data).toMatchObject([{ providerSlug: 'mock', subject: 'subject-alice' }]);

    // 另一个用户想关联同一个 subject
    const bob = await makeUser(db, 'bob');
    const bobLogin = await call('POST', '/api/auth/login', { username: bob.username, password: PASSWORD });
    const bobCookie = cookieFrom(bobLogin, 'dowel_session');
    const conflict = await startLogin('mode=link', bobCookie);
    const conflictResult = await finishLogin(conflict, bobCookie);
    expect(conflictResult.status).toBe(302);
    expect(conflictResult.location).toBe('/login?oidc_error=link_conflict');
  });

  test('不能解除最后一个登录方式；有密码时才能解除', async () => {
    await createProvider();
    const first = await loginWithOidc(await invite());
    const session = cookieFrom(first.result, 'dowel_session');
    const [identity] = (await call('GET', '/api/me/identities', undefined, session)).data as unknown as {
      id: string;
    }[];
    // OIDC 用户没有密码
    expect((await call('DELETE', `/api/me/identities/${identity!.id}`, undefined, session)).status).toBe(422);

    // 管理员有密码，可以解除关联（换一个 subject，避免和 alice 已关联的身份冲突）
    claims = { ...claims, sub: 'subject-admin', preferred_username: 'admin-oidc' };
    const linked = await startLogin('mode=link', admin.cookie);
    expect((await finishLogin(linked, admin.cookie)).status).toBe(302);
    const [adminIdentity] = (await call('GET', '/api/me/identities', undefined, admin.cookie))
      .data as unknown as { id: string }[];
    expect(
      (await call('DELETE', `/api/me/identities/${adminIdentity!.id}`, undefined, admin.cookie)).status,
    ).toBe(200);
  });

  test('state 不匹配被拒绝', async () => {
    await createProvider();
    const start = await startLogin(`invite=${await invite()}`);
    const u = new URL(start.callback);
    u.searchParams.set('state', 'tampered');
    const res = await call('GET', `${u.pathname}${u.search}`, undefined, start.stateCookie);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?oidc_error=state');
  });

  test('nonce 不匹配被拒绝', async () => {
    await createProvider();
    const token = await invite();
    const start = await startLogin(`invite=${token}`);
    nonceOverride = 'not-the-nonce';
    const result = await finishLogin(start);
    nonceOverride = null;
    expect(result.status).toBe(302);
    expect(result.location).toBe('/login?oidc_error=token');
    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({ state: 'ok' });
  });

  test('next 规范化后校验，非法值回退到 /', async () => {
    for (const next of [
      '/a/..//evil.com',
      '/.//evil.com',
      '/%2e%2e//evil.com',
      '/\\evil.com',
      '//evil.com',
      'https://evil.com',
    ])
      expect(safeNext(next), next).toBe('/');
    expect(safeNext('/a/b?x=1#h')).toBe('/a/b?x=1#h');
    expect(safeNext(undefined)).toBeNull();

    await createProvider();
    for (const next of ['/a/..//evil.com', '/.//evil.com', '/%2e%2e//evil.com', '/\\evil.com']) {
      const r = await call(
        'GET',
        `/api/auth/oidc/mock/start?next=${encodeURIComponent(next)}`,
        undefined,
        admin.cookie,
      );
      expect(r.status, next).toBe(302);
      expect(r.location, next).not.toContain('evil.com');
    }
  });

  test('同一个邮箱不会自动关联已有用户', async () => {
    await createProvider();
    const existing = await makeUser(db, 'someone', { email: 'alice@example.com' });
    const { result } = await loginWithOidc();
    // 没有邀请：拒绝，而不是按邮箱登录成 someone
    expect(result.status).toBe(302);
    expect(result.location).toBe('/login?oidc_error=not_invited');
    expect((await call('GET', '/api/auth/me', undefined, cookieFrom(result, 'dowel_session'))).status).toBe(
      401,
    );
    const [identity] = await db.query('select 1 from user_identities where user_id = $1', [existing.id]);
    expect(identity).toBeUndefined();
  });

  test('关闭密码登录的联动：最后一个启用的提供方不能停用或删除', async () => {
    const created = await createProvider();
    expect((await call('PATCH', '/api/admin/settings', { passwordLogin: false }, admin.cookie)).status).toBe(
      200,
    );
    expect(
      (await call('PATCH', `/api/admin/oidc/${created.id as string}`, { enabled: false }, admin.cookie))
        .status,
    ).toBe(422);
    expect(
      (await call('DELETE', `/api/admin/oidc/${created.id as string}`, undefined, admin.cookie)).status,
    ).toBe(422);
    // 再启用密码登录后可以删除
    expect((await call('PATCH', '/api/admin/settings', { passwordLogin: true }, admin.cookie)).status).toBe(
      200,
    );
    expect(
      (await call('DELETE', `/api/admin/oidc/${created.id as string}`, undefined, admin.cookie)).status,
    ).toBe(200);
  });

  test('client_secret 加密存储；列表只返回是否已设置；discovery 失败返回 422', async () => {
    const created = await createProvider();
    const [row] = await db.query<{ enc: string }>(
      'select client_secret_enc as enc from oidc_providers where id = $1',
      [created.id],
    );
    expect(row!.enc).not.toBe('top-secret-value');
    expect(row!.enc).toMatch(/^v1:/);
    expect(JSON.stringify(created)).not.toContain('top-secret-value');
    expect(created).toMatchObject({ hasSecret: true });
    expect(created).not.toHaveProperty('clientSecret');

    const list = await call('GET', '/api/admin/oidc', undefined, admin.cookie);
    expect(JSON.stringify(list.data)).not.toContain('top-secret-value');
    expect((list.data as unknown as { hasSecret: boolean }[])[0]).toMatchObject({ hasSecret: true });

    const presets = await call('GET', '/api/admin/oidc/presets', undefined, admin.cookie);
    expect(presets.data).toMatchObject([
      { key: 'google', issuer: 'https://accounts.google.com' },
      { key: 'gitlab', issuer: 'https://gitlab.com' },
    ]);

    const bad = await call(
      'POST',
      '/api/admin/oidc',
      {
        slug: 'broken',
        name: 'Broken',
        issuer: 'http://127.0.0.1:1',
        clientId: 'x',
        clientSecret: 'y',
      },
      admin.cookie,
    );
    expect(bad.status).toBe(422);
    expect(String(bad.data.error)).toContain('OIDC');
  });
  test('redirect_uri 与授权请求一致：DOWEL_PUBLIC_URL 与请求 host 不同也能登录', async () => {
    await stop();
    await db.close();
    await boot({ security: { publicUrl: 'https://dowel.example.com' } });
    await createProvider();
    lastTokenRedirectUri = null;
    const { result } = await loginWithOidc(await invite());
    expect(result.status).toBe(302);
    expect(result.location).toBe('/projects');
    expect(lastTokenRedirectUri).toBe('https://dowel.example.com/api/auth/oidc/mock/callback');
  });

  test('link 模式在 start/callback 之间切换会话会被拒绝', async () => {
    await createProvider();
    const bob = await makeUser(db, 'bob');
    const bobLogin = await call('POST', '/api/auth/login', { username: bob.username, password: PASSWORD });
    const bobCookie = cookieFrom(bobLogin, 'dowel_session');

    const start = await startLogin('mode=link', admin.cookie);
    const res = await finishLogin(start, bobCookie);
    expect(res.status).toBe(302);
    expect(res.location).toBe('/login?oidc_error=link_session');
    expect((await call('GET', '/api/me/identities', undefined, admin.cookie)).data).toEqual([]);
  });

  test('同一个 subject 并发开户：只建一个用户，两个回调都正常登录', async () => {
    await createProvider({ autoProvision: true });
    const a = await startLogin('next=/projects');
    const b = await startLogin('next=/projects');
    const [ra, rb] = await Promise.all([finishLogin(a), finishLogin(b)]);
    for (const r of [ra, rb]) {
      expect(r.status).toBe(302);
      expect(r.location).toBe('/projects');
      expect((await call('GET', '/api/auth/me', undefined, cookieFrom(r, 'dowel_session'))).status).toBe(200);
    }
    const [users] = await db.query<{ n: number }>('select count(*) as n from users');
    const [identities] = await db.query<{ n: number }>('select count(*) as n from user_identities');
    expect(Number(users!.n)).toBe(2); // admin + alice
    expect(Number(identities!.n)).toBe(1);
  });

  test('关闭密码登录后，密码不再算作可用的登录方式', async () => {
    await createProvider();
    claims = { ...claims, sub: 'subject-admin', preferred_username: 'admin-oidc' };
    const linked = await startLogin('mode=link', admin.cookie);
    expect((await finishLogin(linked, admin.cookie)).status).toBe(302);
    expect((await call('PATCH', '/api/admin/settings', { passwordLogin: false }, admin.cookie)).status).toBe(
      200,
    );
    const [identity] = (await call('GET', '/api/me/identities', undefined, admin.cookie)).data as unknown as {
      id: string;
    }[];
    expect((await call('DELETE', `/api/me/identities/${identity!.id}`, undefined, admin.cookie)).status).toBe(
      422,
    );
  });

  test('停用提供方不做 discovery：issuer 不可达时也能停用', async () => {
    const created = await createProvider();
    // 模拟提供方已经不可达（直接改库，避免触发 PATCH 的 discovery）
    await db.query('update oidc_providers set issuer = $2 where id = $1', [created.id, 'http://127.0.0.1:1']);
    const r = await call(
      'PATCH',
      `/api/admin/oidc/${created.id as string}`,
      { enabled: false },
      admin.cookie,
    );
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: false });
  });

  test('回调只带错误码，不回显 IdP 的 error_description', async () => {
    await createProvider();
    const desc = 'https://evil.example/<script>alert(1)</script>';
    const r = await call(
      'GET',
      `/api/auth/oidc/mock/callback?error=access_denied&error_description=${encodeURIComponent(desc)}`,
    );
    expect(r.status).toBe(302);
    expect(r.location).toBe('/login?oidc_error=provider');
    expect(r.location).not.toContain('evil.example');
    expect(r.location).not.toContain('script');
  });

  test('discovery 按 provider 缓存：两次登录只做一次，配置更新后失效', async () => {
    const created = await createProvider();
    clearDiscoveryCache();
    discoveryCount = 0;

    const first = await loginWithOidc(await invite());
    expect(first.result.status).toBe(302);
    const second = await loginWithOidc();
    expect(second.result.status).toBe(302);
    expect(discoveryCount).toBe(1);

    // 改名不触发 discovery，但 updated_at 变化会让下一次登录重新 discovery
    expect(
      (await call('PATCH', `/api/admin/oidc/${created.id as string}`, { name: 'Mock 2' }, admin.cookie))
        .status,
    ).toBe(200);
    discoveryCount = 0;
    expect((await loginWithOidc()).result.status).toBe(302);
    expect(discoveryCount).toBe(1);
  });
  test('countEnabledProviders / hasOidcProvider / publicProviders 共用同一份判断', async () => {
    expect(await countEnabledProviders(db)).toBe(0);
    expect(await hasOidcProvider(db)).toBe(false);
    const created = await createProvider();
    expect(await countEnabledProviders(db)).toBe(1);
    expect(await hasOidcProvider(db)).toBe(true);
    expect((await call('GET', '/api/instance')).data.providers).toEqual([{ slug: 'mock', name: 'Mock' }]);
    expect(
      (await call('PATCH', `/api/admin/oidc/${created.id as string}`, { enabled: false }, admin.cookie))
        .status,
    ).toBe(200);
    expect(await countEnabledProviders(db)).toBe(0);
    expect(await hasOidcProvider(db)).toBe(false);
    expect((await call('GET', '/api/instance')).data.providers).toEqual([]);
  });

  test('hasOtherLoginMethod 不把已停用提供方的身份算作登录方式', async () => {
    const created = await createProvider();
    const user = await makeUser(db, 'no-password');
    await db.query('insert into user_identities (provider_id, subject, user_id) values ($1, $2, $3)', [
      created.id,
      'subject-no-password',
      user.id,
    ]);
    expect(await hasOtherLoginMethod(db, user.id, 'none', false)).toBe(true);
    await call('PATCH', `/api/admin/oidc/${created.id as string}`, { enabled: false }, admin.cookie);
    expect(await hasOtherLoginMethod(db, user.id, 'none', false)).toBe(false);
  });

  test('已有同邮箱用户时 OIDC autoProvision 绝不自动关联且邮箱降级为 null（含并发）', async () => {
    const provider = await createProvider({ autoProvision: true });
    const providerId = provider.id as string;
    const existing = await makeUser(db, 'someone', { email: 'Alice@Example.com' });

    // 即使外部 IdP 返回相同的邮箱（大小写不同），也不关联到 existing，且不抛 500
    claims = {
      sub: 'subject-new-alice',
      preferred_username: 'new-alice',
      name: 'New Alice',
      email: 'alice@example.com',
    };
    const { result } = await loginWithOidc();
    expect(result.status).toBe(302);
    expect(result.location).toBe('/projects');
    const session = cookieFrom(result, 'dowel_session');
    const me = await call('GET', '/api/auth/me', undefined, session);
    expect(me.status).toBe(200);
    expect(me.data.id).not.toBe(existing.id);
    expect(me.data.username).toBe('new-alice');
    expect(me.data.email).toBeNull();

    // existing 账号未关联该外部身份
    const [existingId] = await db.query('select 1 from user_identities where user_id = $1', [existing.id]);
    expect(existingId).toBeUndefined();

    // 两个新用户携同一尚未被占用的外部邮箱并发开户：先到者占邮箱，后到者降级 email=null 且均成功登录
    const [u1, u2] = await Promise.all([
      provisionFromIdentity(db, {
        providerId,
        subject: 'subject-race-1',
        username: 'race-1',
        name: 'Race 1',
        email: 'shared-race@example.com',
        inviteToken: null,
      }),
      provisionFromIdentity(db, {
        providerId,
        subject: 'subject-race-2',
        username: 'race-2',
        name: 'Race 2',
        email: 'SHARED-RACE@example.com',
        inviteToken: null,
      }),
    ]);
    expect(u1.id).not.toBe(u2.id);
    const identities = await db.query<{ userId: string }>(
      'select user_id as "userId" from user_identities where provider_id = $1 and user_id in ($2, $3)',
      [providerId, u1.id, u2.id],
    );
    expect(identities).toHaveLength(2);
    const emails = [u1.email, u2.email].sort((a, b) => String(a).localeCompare(String(b)));
    expect(emails).toContain('shared-race@example.com');
    expect(emails).toContain(null);
  });
});
