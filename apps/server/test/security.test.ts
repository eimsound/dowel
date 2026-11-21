// 安全基础：代理信任、Origin 校验、安全响应头、会话令牌轮换、登录限速、WebSocket Origin 校验。
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import type { Context } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { clientIp, type SecurityConfig, sameOrigin, securityConfigFromEnv } from '../src/security.ts';
import { makeUser, PASSWORD } from './support.ts';

let db: PlatformDb;
let base = '';
let closeServer: () => Promise<void>;
const sockets = new Set<WebSocket>();

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  // 测试里通过 X-Forwarded-For 切换客户端 IP，所以显式开启 trustProxy
  const { app, injectWebSocket, rooms, shadows } = createApp(db, {
    security: { trustProxy: true, publicUrl: null },
  });
  const server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    await rooms.flush();
    await shadows.close();
    (server as import('node:http').Server).closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
  };
});

afterAll(async () => {
  await closeServer();
});

const call = async (
  method: string,
  path: string,
  options: { json?: unknown; cookie?: string; origin?: string; ip?: string } = {},
) => {
  const headers: Record<string, string> = {};
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  if (options.ip) headers['x-forwarded-for'] = options.ip;
  const res = await fetch(base + path, {
    method,
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data: data as Record<string, unknown>,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    headers: res.headers,
  };
};

const config = (trustProxy: boolean, publicUrl: string | null = null): SecurityConfig => ({
  trustProxy,
  publicUrl,
});

const fakeContext = (
  headers: Record<string, string>,
  options: { url?: string; remote?: string | null } = {},
): Context => {
  const remote = options.remote === null ? null : (options.remote ?? '10.0.0.5');
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      url: options.url ?? 'http://internal:4600/api/test',
    },
    env: remote
      ? { incoming: { socket: { remoteAddress: remote, remotePort: 1234, remoteFamily: 'IPv4' } } }
      : {},
  } as unknown as Context;
};

describe('代理配置与 Origin', () => {
  test('DOWEL_TRUST_PROXY / DOWEL_PUBLIC_URL 从环境变量读取', () => {
    const trust = process.env.DOWEL_TRUST_PROXY;
    const publicUrl = process.env.DOWEL_PUBLIC_URL;
    try {
      delete process.env.DOWEL_TRUST_PROXY;
      delete process.env.DOWEL_PUBLIC_URL;
      expect(securityConfigFromEnv()).toEqual({ trustProxy: false, publicUrl: null });
      process.env.DOWEL_TRUST_PROXY = '0';
      expect(securityConfigFromEnv().trustProxy).toBe(false);
      process.env.DOWEL_TRUST_PROXY = 'TRUE';
      expect(securityConfigFromEnv().trustProxy).toBe(true);
      process.env.DOWEL_TRUST_PROXY = '1';
      expect(securityConfigFromEnv().trustProxy).toBe(true);
      process.env.DOWEL_PUBLIC_URL = ' https://dowel.example.com ';
      expect(securityConfigFromEnv().publicUrl).toBe('https://dowel.example.com');
    } finally {
      if (trust === undefined) delete process.env.DOWEL_TRUST_PROXY;
      else process.env.DOWEL_TRUST_PROXY = trust;
      if (publicUrl === undefined) delete process.env.DOWEL_PUBLIC_URL;
      else process.env.DOWEL_PUBLIC_URL = publicUrl;
    }
  });

  test('不信任代理时忽略 X-Forwarded-For；信任时取最后一个地址', () => {
    const xff = { 'x-forwarded-for': '198.51.100.7, 10.0.0.9' };
    expect(clientIp(fakeContext(xff), config(false))).toBe('10.0.0.5');
    expect(clientIp(fakeContext(xff), config(true))).toBe('10.0.0.9');
    expect(clientIp(fakeContext({}), config(true))).toBe('10.0.0.5');
    expect(clientIp(fakeContext({}, { remote: null }), config(true))).toBeNull();
  });

  test('Origin 期望来源：PUBLIC_URL > 转发头 > 请求自身', () => {
    const proxied = fakeContext({
      host: 'internal:4600',
      origin: 'https://dowel.example.com',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'dowel.example.com',
    });
    expect(sameOrigin(proxied, config(false, 'https://dowel.example.com'))).toBe(true);
    // PUBLIC_URL 优先于转发头
    expect(sameOrigin(proxied, config(true, 'https://other.example.com'))).toBe(false);
    expect(sameOrigin(proxied, config(true))).toBe(true);
    // 协议也要比较
    expect(
      sameOrigin(
        fakeContext({
          origin: 'http://dowel.example.com',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'dowel.example.com',
        }),
        config(true),
      ),
    ).toBe(false);
    // 不信任代理时，转发头不参与
    expect(sameOrigin(proxied, config(false))).toBe(false);
    // 没有反代配置时用请求自身的协议 + Host
    expect(
      sameOrigin(
        fakeContext(
          { host: '127.0.0.1:4600', origin: 'http://127.0.0.1:4600' },
          { url: 'http://127.0.0.1:4600/api/test' },
        ),
        config(false),
      ),
    ).toBe(true);
    expect(sameOrigin(fakeContext({ origin: 'null' }), config(false))).toBe(false);
    expect(sameOrigin(fakeContext({}), config(false))).toBe(true);
  });
});

describe('安全基础', () => {
  test('响应头：CSP、X-Content-Type-Options、Referrer-Policy、X-Frame-Options', async () => {
    const r = await call('GET', '/api/auth/me');
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('ws:');
    expect(csp).not.toContain('wss:');
    expect(csp).toContain("img-src 'self' data:");
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
  });

  test('变更请求校验 Origin；没有 Origin 放行；GET 不校验', async () => {
    await makeUser(db, 'origin', { name: '同源' });
    const u = await call('POST', '/api/auth/login', { json: { username: 'origin', password: PASSWORD } });
    expect(u.status).toBe(200);
    const config = { cookie: u.cookie };
    const g = await call('POST', '/api/groups', {
      ...config,
      json: { slug: 'origin', name: 'Origin' },
    });
    const groupId = g.data.id as string;
    expect(
      (
        await call('POST', '/api/projects', {
          ...config,
          json: { name: 'x', groupId },
          origin: 'http://evil.test',
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', '/api/projects', { ...config, origin: 'http://evil.test' })).status).toBe(200);
    expect(
      (await call('POST', '/api/projects', { ...config, json: { name: 'x', groupId }, origin: base })).status,
    ).toBe(201);
    expect((await call('POST', '/api/projects', { ...config, json: { name: 'y', groupId } })).status).toBe(
      201,
    );
  });

  test('登录时轮换会话令牌：旧 cookie 失效', async () => {
    await makeUser(db, 'rotate', { name: '轮换' });
    const first = await call('POST', '/api/auth/login', {
      json: { username: 'rotate', password: PASSWORD },
    });
    expect(first.status).toBe(200);
    expect((await call('GET', '/api/auth/me', { cookie: first.cookie })).status).toBe(200);

    const login = await call('POST', '/api/auth/login', {
      cookie: first.cookie,
      json: { username: 'rotate', password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.cookie).not.toBe(first.cookie);
    expect((await call('GET', '/api/auth/me', { cookie: first.cookie })).status).toBe(401);
    expect((await call('GET', '/api/auth/me', { cookie: login.cookie })).status).toBe(200);
  });

  test('登录限速：IP + 账号、IP 总量分别计数，且不锁住其他 IP 的同账号', async () => {
    const ip = '203.0.113.10';
    const account = 'pair';
    for (let i = 0; i < 10; i++)
      expect(
        (await call('POST', '/api/auth/login', { ip, json: { username: account, password: PASSWORD } }))
          .status,
      ).toBe(401);
    const byPair = await call('POST', '/api/auth/login', {
      ip,
      json: { username: account, password: PASSWORD },
    });
    expect(byPair.status).toBe(429);
    expect(byPair.headers.get('retry-after')).toBeTruthy();

    // 受害者在另一个 IP 上用同一个账号，不应被攻击者 IP 的失败记录锁住
    expect(
      (
        await call('POST', '/api/auth/login', {
          ip: '203.0.113.11',
          json: { username: account, password: PASSWORD },
        })
      ).status,
    ).toBe(401);

    // IP 总量：同一 IP 换 30 个账号后被拦
    const totalIp = '203.0.113.12';
    for (let i = 0; i < 30; i++)
      expect(
        (
          await call('POST', '/api/auth/login', {
            ip: totalIp,
            json: { username: `no${i}`, password: PASSWORD },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await call('POST', '/api/auth/login', {
          ip: totalIp,
          json: { username: 'another', password: PASSWORD },
        })
      ).status,
    ).toBe(429);
  });

  test('并发登录不会突破 IP + 账号上限', async () => {
    const ip = '203.0.113.13';
    const account = 'race';
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call('POST', '/api/auth/login', { ip, json: { username: account, password: PASSWORD } }),
      ),
    );
    expect(results.filter((r) => r.status === 401)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(10);
  });

  test('WebSocket 升级校验 Origin', async () => {
    await makeUser(db, 'ws-origin', { name: 'WS' });
    const u = await call('POST', '/api/auth/login', {
      json: { username: 'ws-origin', password: PASSWORD },
    });
    const g = await call('POST', '/api/groups', {
      cookie: u.cookie,
      json: { slug: 'ws-origin', name: 'WS' },
    });
    const p = await call('POST', '/api/projects', {
      cookie: u.cookie,
      json: { name: 'ws', groupId: g.data.id },
    });
    const pid = p.data.id as string;
    const url = `${base.replace('http', 'ws')}/api/projects/${pid}/sync`;

    const bad = new WebSocket(url, { headers: { cookie: u.cookie, origin: 'http://evil.test' } });
    sockets.add(bad);
    const badStatus = await new Promise<number>((resolve, reject) => {
      bad.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      bad.once('error', reject);
      bad.once('open', () => reject(new Error('跨源升级不应该成功')));
    });
    expect(badStatus).toBe(403);

    const good = new WebSocket(url, { headers: { cookie: u.cookie, origin: base } });
    sockets.add(good);
    await new Promise((r, reject) => {
      good.once('open', r);
      good.once('error', reject);
    });
    expect(good.readyState).toBe(WebSocket.OPEN);
    good.close();
  });
});
