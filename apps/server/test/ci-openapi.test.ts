// /api/ci OpenAPI 3.1 规范、自托管 Scalar 文档页与认证边界测试（不依赖外部 PostgreSQL）。
import {
  CI_DOCS_PATH,
  CI_ERROR_CODES,
  CI_ERROR_STATUS,
  CI_OPENAPI_PATH,
  type CiTokenCreated,
} from '@dowel/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { newMcpToken } from '../src/mcp-tokens.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { CI_DOCS_INIT_PATH } from '../src/routes/ci.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'ci-openapi-test-secret-0123456789';

const EXPECTED_PATHS = [
  '/api/ci/token',
  '/api/ci/projects/{owner}/{project}',
  '/api/ci/projects/{owner}/{project}/versions',
  '/api/ci/projects/{owner}/{project}/environments/{env}',
  '/api/ci/projects/{owner}/{project}/environments/{env}/drift',
  '/api/ci/projects/{owner}/{project}/environments/{env}/history',
  '/api/ci/projects/{owner}/{project}/environments/{env}/execute',
] as const;

describe('CI OpenAPI 3.1 与自托管 Scalar 文档', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let adminCookie = '';
  let memberCookie = '';
  let forcedCookie = '';
  let disabledCookie = '';
  let validToken = '';
  let expiredToken = '';
  let revokedToken = '';
  let mcpToken = '';
  let groupSlug = '';
  let projectSlug = '';

  const call = async (
    method: string,
    path: string,
    opts: { cookie?: string; auth?: string; json?: unknown; rawBody?: string; contentType?: string } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.auth) headers.authorization = opts.auth;
    if (opts.contentType) headers['content-type'] = opts.contentType;
    else if (opts.json !== undefined) headers['content-type'] = 'application/json';
    const body = opts.rawBody ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const res = await created.app.request(path, { method, headers, body });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, text, data: data as Record<string, unknown>, headers: res.headers };
  };

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 50, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });

    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    await makeUser(db, 'member', { name: '普通成员', role: 'member' });
    await makeUser(db, 'forced', { name: '需改密', mustChangePassword: true });
    const disabled = await makeUser(db, 'disabled', { name: '已停用' });

    const loginAs = async (username: string) => {
      const r = await call('POST', '/api/auth/login', { json: { username, password: PASSWORD } });
      expect(r.status).toBe(200);
      return r.headers.get('set-cookie')?.split(';')[0] ?? '';
    };

    adminCookie = await loginAs('admin');
    memberCookie = await loginAs('member');
    forcedCookie = await loginAs('forced');
    disabledCookie = await loginAs('disabled');
    await db.query("update users set status = 'disabled' where id = $1", [disabled.id]);

    const g = await call('POST', '/api/groups', {
      cookie: adminCookie,
      json: { slug: 'openapi-g', name: 'OpenAPI 组' },
    });
    expect(g.status).toBe(201);
    groupSlug = 'openapi-g';

    const p = await call('POST', '/api/projects', {
      cookie: adminCookie,
      json: { name: 'OpenAPI Shop', groupId: g.data.id },
    });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    projectSlug = p.data.slug as string;

    const createTok = async (name: string) => {
      const r = await call('POST', `/api/projects/${pid}/tokens`, {
        cookie: adminCookie,
        json: { name },
      });
      expect(r.status).toBe(201);
      return r.data as unknown as CiTokenCreated;
    };

    validToken = (await createTok('valid')).token;

    const exp = await createTok('expired');
    expiredToken = exp.token;
    await db.query('update ci_tokens set expires_at = $2 where id = $1', [
      exp.info.id,
      new Date(Date.now() - 10_000).toISOString(),
    ]);

    const rev = await createTok('revoked');
    revokedToken = rev.token;
    expect(
      (
        await call('POST', `/api/projects/${pid}/tokens/${rev.info.id}/revoke`, {
          cookie: adminCookie,
          json: {},
        })
      ).status,
    ).toBe(200);

    // 仅验证 rejectTokens 拦截 dwm_… 前缀，无需落库
    mcpToken = newMcpToken().token;
  });

  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
  });

  test('openapi.json 生成合法的 OpenAPI 3.1.0 规范，精确覆盖 7 个接口、Bearer 安全方案与错误模型', async () => {
    const res = await call('GET', CI_OPENAPI_PATH, { cookie: memberCookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const doc = res.data as {
      openapi: string;
      info: { title: string; version: string };
      security?: Record<string, string[]>[];
      components?: {
        securitySchemes?: Record<string, { type: string; scheme?: string }>;
        schemas?: Record<string, unknown>;
      };
      paths?: Record<
        string,
        Record<string, { security?: unknown; requestBody?: unknown; responses?: Record<string, unknown> }>
      >;
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Dowel CI API');
    expect(doc.components?.securitySchemes?.ciToken).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.security).toEqual([{ ciToken: [] }]);

    // 路径精确等于 7 个 CI 业务接口（不含 /api/ci/openapi.json 与 /api/ci/docs*）
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toHaveLength(EXPECTED_PATHS.length);
    expect(new Set(paths)).toEqual(new Set(EXPECTED_PATHS));

    // 每个操作都声明安全方案、200 响应及对应错误响应；累计覆盖 CI_ERROR_STATUS 全部分类状态码
    const documentedErrorStatuses = new Set<string>();
    for (const p of EXPECTED_PATHS) {
      const item = doc.paths![p]!;
      const ops = Object.entries(item);
      expect(ops.length).toBe(1);
      const [, op] = ops[0]!;
      expect(op.security).toEqual([{ ciToken: [] }]);
      expect(op.responses?.['200']).toBeTruthy();
      for (const status of Object.keys(op.responses ?? {})) {
        if (status !== '200') documentedErrorStatuses.add(status);
      }
    }
    const expectedStatuses = new Set(Object.values(CI_ERROR_STATUS).map(String));
    expect(documentedErrorStatuses).toEqual(expectedStatuses);

    // execute 接口声明了请求体 schema
    const executeOp = doc.paths!['/api/ci/projects/{owner}/{project}/environments/{env}/execute']!.post!;
    expect(executeOp.requestBody).toBeTruthy();

    // Error schema 与全部错误码均已导出
    expect(doc.components?.schemas?.CiErrorBody).toBeTruthy();
    expect(doc.components?.schemas?.CiErrorCode).toMatchObject({
      enum: CI_ERROR_CODES,
    });
  });

  test('文档端点（openapi.json / docs / docs/init.js）认证矩阵：Cookie / 改密拦截 / CI 令牌 / 匿名 / MCP 令牌', async () => {
    for (const path of [CI_OPENAPI_PATH, CI_DOCS_PATH, CI_DOCS_INIT_PATH]) {
      // 1. 已登录普通用户 & 管理员均可访问
      expect((await call('GET', path, { cookie: memberCookie })).status, `${path} member`).toBe(200);
      expect((await call('GET', path, { cookie: adminCookie })).status, `${path} admin`).toBe(200);

      // 2. mustChangePassword 强制改密用户 → 403 password_change_required
      const forced = await call('GET', path, { cookie: forcedCookie });
      expect(forced.status, `${path} forced`).toBe(403);
      expect(forced.data).toMatchObject({ code: 'password_change_required' });

      // 3. 停用用户 / 匿名请求 → 401 unauthorized
      const dis = await call('GET', path, { cookie: disabledCookie });
      expect(dis.status, `${path} disabled`).toBe(401);
      expect(dis.data).toMatchObject({ code: 'unauthorized' });

      const anon = await call('GET', path);
      expect(anon.status, `${path} anon`).toBe(401);
      expect(anon.data).toMatchObject({ code: 'unauthorized' });

      // 4. 有效 Bearer dwl_… → 200
      expect((await call('GET', path, { auth: `Bearer ${validToken}` })).status, `${path} token`).toBe(200);

      // 5. 过期 / 吊销 / 无效 dwl_…（即使同时带了有效 cookie 也绝不回落）→ 401
      const exp = await call('GET', path, { cookie: adminCookie, auth: `Bearer ${expiredToken}` });
      expect(exp.status, `${path} expired`).toBe(401);
      expect(exp.data).toMatchObject({ ok: false, code: 'token_expired' });

      const rev = await call('GET', path, { cookie: adminCookie, auth: `Bearer ${revokedToken}` });
      expect(rev.status, `${path} revoked`).toBe(401);
      expect(rev.data).toMatchObject({ ok: false, code: 'token_revoked' });

      const bad = await call('GET', path, { cookie: adminCookie, auth: 'Bearer dwl_invalid' });
      expect(bad.status, `${path} invalid`).toBe(401);
      expect(bad.data).toMatchObject({ ok: false, code: 'token_invalid' });

      // 6. Bearer dwm_… MCP 令牌（即使带有效 cookie）→ 403 forbidden
      const mcp = await call('GET', path, { cookie: adminCookie, auth: `Bearer ${mcpToken}` });
      expect(mcp.status, `${path} mcp`).toBe(403);
      expect(mcp.data).toMatchObject({ code: 'forbidden' });

      // 7. 反代注入非 dwl_/dwm_ Authorization 头：有有效 Cookie 放行，无 Cookie 返回 401 token_invalid
      expect(
        (await call('GET', path, { cookie: memberCookie, auth: 'Bearer oidc-proxy-token' })).status,
        `${path} proxy header + cookie`,
      ).toBe(200);
      const badProxy = await call('GET', path, { auth: 'Bearer oidc-proxy-token' });
      expect(badProxy.status, `${path} proxy header anon`).toBe(401);
      expect(badProxy.data).toMatchObject({ ok: false, code: 'token_invalid' });
    }

    // /api/ci/docs/* 下未知子路径：匿名 401，已登录 404（不误落入 CI token_missing）
    expect((await call('GET', `${CI_DOCS_PATH}/missing.js`)).status).toBe(401);
    expect((await call('GET', `${CI_DOCS_PATH}/missing.js`, { cookie: memberCookie })).status).toBe(404);
  });

  test('文档端点同样受 IP 失败限流 + 活跃令牌放行 + 单令牌限速保护', async () => {
    const limApp = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 2, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 3, windowMs: 60_000 }),
    });
    try {
      const reqDoc = (auth: string) =>
        limApp.app.request(CI_OPENAPI_PATH, { headers: { authorization: auth } });

      // 2 次格式合法的未知令牌触发 IP 失败上限
      expect((await reqDoc(`Bearer dwl_${'X'.repeat(43)}`)).status).toBe(401);
      expect((await reqDoc(`Bearer dwl_${'Y'.repeat(43)}`)).status).toBe(401);
      const blocked = await reqDoc(`Bearer dwl_${'Z'.repeat(43)}`);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ ok: false, code: 'rate_limited' });

      // 同 IP 下活跃合法令牌仍放行，并在第 4 次触发 tokenLimiter 429
      for (let i = 0; i < 3; i++) {
        expect((await reqDoc(`Bearer ${validToken}`)).status).toBe(200);
      }
      const tokenLimited = await reqDoc(`Bearer ${validToken}`);
      expect(tokenLimited.status).toBe(429);
      expect(Number(tokenLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      await limApp.rooms.flush();
      await limApp.shadows.close();
    }
  });

  test('7 个 CI 业务接口严格拒绝会话 Cookie（401 token_missing），且校验错误保持 invalid_request 400', async () => {
    const businessRequests: Array<[string, string, unknown?]> = [
      ['GET', '/api/ci/token'],
      ['GET', `/api/ci/projects/${groupSlug}/${projectSlug}`],
      ['GET', `/api/ci/projects/${groupSlug}/${projectSlug}/versions`],
      ['GET', `/api/ci/projects/${groupSlug}/${projectSlug}/environments/staging`],
      ['POST', `/api/ci/projects/${groupSlug}/${projectSlug}/environments/staging/drift`],
      ['GET', `/api/ci/projects/${groupSlug}/${projectSlug}/environments/staging/history`],
      ['POST', `/api/ci/projects/${groupSlug}/${projectSlug}/environments/staging/execute`, { to: 'latest' }],
    ];

    for (const [method, path, json] of businessRequests) {
      const r = await call(method, path, { cookie: adminCookie, json });
      expect(r.status, `${method} ${path} with cookie`).toBe(401);
      expect(r.data, `${method} ${path} with cookie`).toMatchObject({ ok: false, code: 'token_missing' });
    }

    // execute 各类非法请求体（空对象、非法 to、畸形 JSON、非 JSON Content-Type）均保持 400 invalid_request
    const execPath = `/api/ci/projects/${groupSlug}/${projectSlug}/environments/staging/execute`;
    for (const opts of [
      { json: {} },
      { json: { to: 'bad-target' } },
      { rawBody: '{', contentType: 'application/json' },
      { rawBody: '{}', contentType: 'text/plain' },
    ]) {
      const bad = await call('POST', execPath, { auth: `Bearer ${validToken}`, ...opts });
      expect(bad.status, JSON.stringify(opts)).toBe(400);
      expect(bad.data, JSON.stringify(opts)).toMatchObject({ ok: false, code: 'invalid_request' });
    }
  });

  test('Scalar 文档 HTML 无内联脚本且保留严格 CSP（script-src self）', async () => {
    const htmlRes = await call('GET', CI_DOCS_PATH, { cookie: memberCookie });
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get('content-type')).toContain('text/html');
    expect(htmlRes.headers.get('cache-control')).toBe('no-store');

    const csp = htmlRes.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    const scriptDirective = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptDirective).not.toContain("'unsafe-inline'");

    // 所有 <script> 标签必须只有外链 src（无内联脚本内容、无跨域 URL）
    const scriptTags = [...htmlRes.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scriptTags.length).toBe(2);
    const srcs: string[] = [];
    for (const [, attrs, body] of scriptTags) {
      expect(body!.trim()).toBe('');
      const srcMatch = /\bsrc=["']([^"']+)["']/i.exec(attrs!);
      expect(srcMatch).toBeTruthy();
      const src = srcMatch![1]!;
      expect(src.startsWith('/') && !src.startsWith('//')).toBe(true);
      srcs.push(src);
    }
    expect(srcs).toEqual([CI_DOCS_INIT_PATH, '/vendor/scalar/standalone.js']);
    expect(htmlRes.text).not.toMatch(/\son[a-z]+\s*=/i);

    // init.js 校验
    const initRes = await call('GET', CI_DOCS_INIT_PATH, { cookie: memberCookie });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('content-type')).toContain('text/javascript');
    expect(initRes.headers.get('cache-control')).toBe('no-store');
    expect(initRes.headers.get('content-security-policy')).toBe(csp);
    expect(initRes.text).toContain(CI_OPENAPI_PATH);
    expect(initRes.text).toContain('withDefaultFonts: false');
    expect(initRes.text).toContain('telemetry: false');
    expect(initRes.text).toContain('jitless = true');
    expect(initRes.text).not.toMatch(/https?:\/\//i);
  });
});
