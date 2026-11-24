// 个人 MCP 令牌（M3-C，ADR 0014）集成与单元测试（覆盖 SQLite 与 PostgreSQL）：
// - CRUD、参数校验、scope 规范化、项目白名单可见性/去重/删改脱敏、单账号 20 枚活跃上限、列表排序；
// - 管理员查看与吊销任意用户令牌、allowMcpAccess 实例开关、审计记录校验；
// - 停用、管理员重置密码、消费重置链接批量吊销，本人改密不吊销，重启用不恢复，删用户外键级联；
// - /api/mcp 认证矩阵（缺头/畸形/不存在/过期/吊销/停用兜底/强制改密/开关关闭/cookie/CI 越界/WS 越界）；
// - 限流（pitfalls #8 #9）：缺头与格式非法不耗桶，触限放行活跃令牌、拦截无效令牌，单令牌限速，last_used_at 节流；
// - 跨副本 mcp_tokens.changed 事件驱动 ActiveTokenCache 失效。
import type { AddressInfo } from 'node:net';

import {
  type AdminMcpTokenList,
  type AuditPage,
  type InstanceSettings,
  MCP_TOKEN_MAX_ACTIVE_PER_USER,
  MCP_TOKEN_PATTERN,
  type McpTokenCreated,
  type McpTokenInfo,
  type McpTokenList,
} from '@dowel/api';
import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import type { AppOptions } from '../src/app.ts';
import { hashToken } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'mcp-tokens-test-secret-0123456789';

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('个人 MCP 令牌（平台库：$platform）', ({ platform, skip }) => {
  let db: PlatformDb;
  let pg: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let created: ReturnType<typeof createApp>;

  const closeApp = async (target: ReturnType<typeof createApp>) => {
    target.drift.stop();
    target.requests.stop();
    target.refresher.stop();
    await target.requests.drain();
    await target.webhooks.close();
    await target.bus.close();
    await target.rooms.flush();
    target.rooms.close();
    await target.shadows.close();
    await target.ha.stop();
  };

  const boot = (options: AppOptions = {}) =>
    createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      mcpFailLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      mcpLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      ...options,
    });

  beforeEach(async () => {
    if (skip) return;
    pg = platform === 'pg' ? await createTestDb('mcp_tokens') : undefined;
    db = await openPlatformDb(pg?.url ?? ':memory:');
    created = boot();
  });

  afterEach(async () => {
    if (skip) return;
    await closeApp(created);
    await db.close();
    await pg?.close();
    pg = undefined;
  });

  const callOn = async (
    targetApp: ReturnType<typeof createApp>['app'],
    method: string,
    path: string,
    json?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) => {
    const h: Record<string, string> = { ...headers };
    if (cookie) h.cookie = cookie;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await targetApp.request(path, {
      method,
      headers: h,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      status: res.status,
      data: data as Record<string, unknown> & unknown[],
      headers: res.headers,
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  };

  const call = (
    method: string,
    path: string,
    json?: unknown,
    cookie = '',
    headers: Record<string, string> = {},
  ) => callOn(created.app, method, path, json, cookie, headers);

  const loginAs = async (username: string, password = PASSWORD) => {
    const r = await call('POST', '/api/auth/login', { username, password });
    expect(r.status, username).toBe(200);
    return r.cookie;
  };

  test.skipIf(skip)('CRUD、参数校验、scope 规范化、项目白名单可见性与上限', async () => {
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(db, 'alice', { name: '爱丽丝' });
    await makeUser(db, 'bob', { name: '鲍勃' });
    const adminCookie = await loginAs('admin');
    const aliceCookie = await loginAs('alice');
    const bobCookie = await loginAs('bob');

    // 建两个组和三个项目：alice 仅能看到 p1、p2，看不到 pSecret
    const g1 = await call(
      'POST',
      '/api/groups',
      { slug: 'team-a', name: 'A 组', defaultRole: 'none' },
      adminCookie,
    );
    expect(g1.status).toBe(201);
    const g1Id = g1.data.id as string;

    const p1Res = await call('POST', '/api/projects', { name: '核心库', groupId: g1Id }, adminCookie);
    const p2Res = await call('POST', '/api/projects', { name: '日志库', groupId: g1Id }, adminCookie);
    const pSecretRes = await call('POST', '/api/projects', { name: '机密库', groupId: g1Id }, adminCookie);
    expect(p1Res.status).toBe(201);
    expect(p2Res.status).toBe(201);
    expect(pSecretRes.status).toBe(201);
    const p1Id = p1Res.data.id as string;
    const p1Slug = p1Res.data.slug as string;
    const p2Id = p2Res.data.id as string;
    const p2Slug = p2Res.data.slug as string;
    const pSecretId = pSecretRes.data.id as string;

    expect(
      (
        await call(
          'POST',
          `/api/projects/${p1Id}/grants`,
          { subjectKind: 'user', subjectId: alice.id, role: 'editor' },
          adminCookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          'POST',
          `/api/projects/${p2Id}/grants`,
          { subjectKind: 'user', subjectId: alice.id, role: 'viewer' },
          adminCookie,
        )
      ).status,
    ).toBe(201);

    // 校验错误 → 400
    for (const bad of [
      { name: '' },
      { name: '   ' },
      { name: 'a'.repeat(101) },
      { name: 'ok', expiresInDays: 0 },
      { name: 'ok', expiresInDays: 366 },
      { name: 'ok', expiresInDays: 7.5 },
      { name: 'ok', scopes: ['read'] },
      { name: 'ok', scopes: ['admin'] },
      { name: 'ok', scopes: ['verify', 'write', 'verify'] },
      { name: 'ok', projectIds: [] },
      { name: 'ok', projectIds: Array.from({ length: 51 }, (_, i) => `p-${i}`) },
      { name: 'ok', extra: true },
    ]) {
      expect((await call('POST', '/api/me/mcp-tokens', bad, aliceCookie)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }

    // 不可见或不存在的项目 → 422
    expect(
      (await call('POST', '/api/me/mcp-tokens', { name: 'bad', projectIds: [pSecretId] }, aliceCookie))
        .status,
    ).toBe(422);
    expect(
      (
        await call(
          'POST',
          '/api/me/mcp-tokens',
          { name: 'bad', projectIds: [p1Id, 'no-such-project'] },
          aliceCookie,
        )
      ).status,
    ).toBe(422);

    // 默认参数创建（30 天、scopes=['read']、projects=null）
    const c1 = await call('POST', '/api/me/mcp-tokens', { name: '  Claude Code  ' }, aliceCookie);
    expect(c1.status).toBe(201);
    const created1 = c1.data as unknown as McpTokenCreated;
    expect(created1.token).toMatch(MCP_TOKEN_PATTERN);
    expect(created1.info.prefix).toBe(created1.token.slice(0, 12));
    expect(created1.info.kind).toBe('personal');
    expect(created1.info.name).toBe('Claude Code');
    expect(created1.info.scopes).toEqual(['read']);
    expect(created1.info.projects).toBeNull();
    expect(created1.info.status).toBe('active');
    expect(created1.info.revokedAt).toBeNull();
    expect(created1.info.revokedBy).toBeNull();
    expect(created1.info.revokedReason).toBeNull();
    const diffDays1 = (Date.parse(created1.info.expiresAt) - Date.parse(created1.info.createdAt)) / 86400_000;
    expect(Math.round(diffDays1)).toBe(30);

    // 库里只存哈希，不存明文
    const [dbRow] = await db.query<{ token_hash: string }>(
      'select token_hash from mcp_tokens where id = $1',
      [created1.info.id],
    );
    expect(dbRow!.token_hash).toBe(hashToken(created1.token));
    expect(dbRow!.token_hash).not.toBe(created1.token);

    // 额外 scope 规范化；projectIds 去重且解析 path/name；边界有效期 1 天 / 365 天
    const c2 = await call(
      'POST',
      '/api/me/mcp-tokens',
      {
        name: 'Cursor',
        scopes: ['write', 'verify'],
        projectIds: [p1Id, p2Id, p1Id],
        expiresInDays: 365,
      },
      aliceCookie,
    );
    expect(c2.status).toBe(201);
    const created2 = c2.data as unknown as McpTokenCreated;
    expect(created2.info.scopes).toEqual(['read', 'verify', 'write']);
    expect(created2.info.projects).toEqual([
      { id: p1Id, path: `team-a/${p1Slug}`, name: '核心库' },
      { id: p2Id, path: `team-a/${p2Slug}`, name: '日志库' },
    ]);
    const diffDays2 = (Date.parse(created2.info.expiresAt) - Date.parse(created2.info.createdAt)) / 86400_000;
    expect(Math.round(diffDays2)).toBe(365);

    // 撤销 alice 对 p2 的权限后：alice 列表里 p2 的 path/name 变 null，管理员列表里仍可见；删除 p1 后双方都变 null
    const p2Grants = (await call('GET', `/api/projects/${p2Id}/grants`, undefined, adminCookie))
      .data as unknown as {
      grants: { id: string; subject: { id: string } }[];
    };
    const p2GrantId = p2Grants.grants.find((g) => g.subject.id === alice.id)!.id;
    expect(
      (await call('DELETE', `/api/projects/${p2Id}/grants/${p2GrantId}`, undefined, adminCookie)).status,
    ).toBe(200);

    const aliceListMid = (await call('GET', '/api/me/mcp-tokens', undefined, aliceCookie))
      .data as unknown as McpTokenList;
    expect(aliceListMid.allowed).toBe(true);
    expect(JSON.stringify(aliceListMid)).not.toContain(created1.token);
    expect(JSON.stringify(aliceListMid)).not.toContain(created2.token);
    expect(JSON.stringify(aliceListMid)).not.toContain(dbRow!.token_hash);
    const c2ForAlice = aliceListMid.tokens.find((t) => t.id === created2.info.id)!;
    expect(c2ForAlice.projects).toEqual([
      { id: p1Id, path: `team-a/${p1Slug}`, name: '核心库' },
      { id: p2Id, path: null, name: null },
    ]);

    const c2ForAdmin = (
      (await call('GET', `/api/admin/users/${alice.id}/mcp-tokens`, undefined, adminCookie))
        .data as unknown as AdminMcpTokenList
    ).tokens.find((t) => t.id === created2.info.id)!;
    expect(c2ForAdmin.projects).toEqual([
      { id: p1Id, path: `team-a/${p1Slug}`, name: '核心库' },
      { id: p2Id, path: `team-a/${p2Slug}`, name: '日志库' },
    ]);

    expect((await call('DELETE', `/api/projects/${p1Id}`, { confirm: p1Slug }, adminCookie)).status).toBe(
      200,
    );
    const c2AfterDelete = (
      (await call('GET', `/api/admin/users/${alice.id}/mcp-tokens`, undefined, adminCookie))
        .data as unknown as AdminMcpTokenList
    ).tokens.find((t) => t.id === created2.info.id)!;
    expect(c2AfterDelete.projects).toEqual([
      { id: p1Id, path: null, name: null },
      { id: p2Id, path: `team-a/${p2Slug}`, name: '日志库' },
    ]);
    const c2AfterDeleteForAlice = (
      (await call('GET', '/api/me/mcp-tokens', undefined, aliceCookie)).data as unknown as McpTokenList
    ).tokens.find((t) => t.id === created2.info.id)!;
    expect(c2AfterDeleteForAlice.projects).toEqual([
      { id: p1Id, path: null, name: null },
      { id: p2Id, path: null, name: null },
    ]);

    // 吊销他人令牌 → 404（不泄露存在性）
    expect((await call('POST', `/api/me/mcp-tokens/${created1.info.id}/revoke`, {}, bobCookie)).status).toBe(
      404,
    );

    // 吊销自己的令牌 → 200，再吊销 → 409
    const rev1 = await call('POST', `/api/me/mcp-tokens/${created1.info.id}/revoke`, {}, aliceCookie);
    expect(rev1.status).toBe(200);
    expect(rev1.data as unknown as McpTokenInfo).toMatchObject({
      id: created1.info.id,
      status: 'revoked',
      revokedReason: 'self',
      revokedBy: { id: alice.id, name: '爱丽丝' },
    });
    expect(
      (await call('POST', `/api/me/mcp-tokens/${created1.info.id}/revoke`, {}, aliceCookie)).status,
    ).toBe(409);

    // 排序：active 在前（按创建时间新到旧），expired / revoked 在后（按创建时间新到旧）
    const cExpired = (
      await call('POST', '/api/me/mcp-tokens', { name: '已过期令牌', expiresInDays: 1 }, aliceCookie)
    ).data as unknown as McpTokenCreated;
    const cNewActive = (
      await call(
        'POST',
        '/api/me/mcp-tokens',
        { name: '最新有效令牌', scopes: ['verify', 'verify'] },
        aliceCookie,
      )
    ).data as unknown as McpTokenCreated;
    expect(cNewActive.info.scopes).toEqual(['read', 'verify']);
    await db.query('update mcp_tokens set created_at = $2 where id = $1', [
      created2.info.id,
      '2026-01-01T00:00:00.000Z',
    ]);
    await db.query('update mcp_tokens set created_at = $2 where id = $1', [
      cNewActive.info.id,
      '2026-01-03T00:00:00.000Z',
    ]);
    await db.query('update mcp_tokens set created_at = $2, expires_at = $3 where id = $1', [
      cExpired.info.id,
      '2026-01-04T00:00:00.000Z',
      '2026-01-05T00:00:00.000Z',
    ]);
    await db.query('update mcp_tokens set created_at = $2 where id = $1', [
      created1.info.id,
      '2026-01-02T00:00:00.000Z',
    ]);

    const sorted = (await call('GET', '/api/me/mcp-tokens', undefined, aliceCookie))
      .data as unknown as McpTokenList;
    expect(sorted.tokens.map((t) => [t.id, t.status])).toEqual([
      [cNewActive.info.id, 'active'],
      [created2.info.id, 'active'],
      [cExpired.info.id, 'expired'],
      [created1.info.id, 'revoked'],
    ]);

    // 过期令牌仍可吊销
    const revExpired = await call('POST', `/api/me/mcp-tokens/${cExpired.info.id}/revoke`, {}, aliceCookie);
    expect(revExpired.status).toBe(200);
    expect((revExpired.data as unknown as McpTokenInfo).status).toBe('revoked');

    // 上限：当前 alice 已有 2 个 active，补建到 20 个后第 21 个报 422 mcp_token_limit
    for (let i = 2; i < MCP_TOKEN_MAX_ACTIVE_PER_USER; i++) {
      const r = await call('POST', '/api/me/mcp-tokens', { name: `bulk-${i}` }, aliceCookie);
      expect(r.status).toBe(201);
    }
    const overLimit = await call('POST', '/api/me/mcp-tokens', { name: 'overflow' }, aliceCookie);
    expect(overLimit.status).toBe(422);
    expect(overLimit.data).toMatchObject({ code: 'mcp_token_limit' });

    // 吊销或过期一个后又能新建，且另一位用户 bob 不受影响
    expect(
      (await call('POST', `/api/me/mcp-tokens/${cNewActive.info.id}/revoke`, {}, aliceCookie)).status,
    ).toBe(200);
    expect((await call('POST', '/api/me/mcp-tokens', { name: 'after-revoke' }, aliceCookie)).status).toBe(
      201,
    );
    await db.query('update mcp_tokens set expires_at = $2 where id = $1', [
      created2.info.id,
      '2026-01-05T00:00:00.000Z',
    ]);
    expect((await call('POST', '/api/me/mcp-tokens', { name: 'after-expire' }, aliceCookie)).status).toBe(
      201,
    );
    expect((await call('POST', '/api/me/mcp-tokens', { name: 'bob-token' }, bobCookie)).status).toBe(201);

    // 审计日志校验：mcp_token.create 与 mcp_token.revoke，绝不记录明文或哈希
    const auditRes = (
      await call('GET', '/api/admin/audit?action=mcp_token.create&limit=100', undefined, adminCookie)
    ).data as unknown as AuditPage;
    const createEvent = auditRes.events.find((e) => e.targetId === created1.info.id)!;
    expect(createEvent).toMatchObject({
      actorKind: 'user',
      actorId: alice.id,
      targetKind: 'mcp_token',
      targetId: created1.info.id,
    });
    expect(createEvent.data).toMatchObject({
      name: 'Claude Code',
      prefix: created1.info.prefix,
      scopes: ['read'],
      projectIds: null,
      expiresAt: created1.info.expiresAt,
    });
    expect(JSON.stringify(createEvent)).not.toContain(created1.token);
    expect(JSON.stringify(createEvent)).not.toContain(dbRow!.token_hash);
  });

  test.skipIf(skip)('管理员查看/吊销用户令牌与 allowMcpAccess 实例开关', async () => {
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(db, 'alice', { name: '爱丽丝' });
    const adminCookie = await loginAs('admin');
    const aliceCookie = await loginAs('alice');

    const createdTok = (await call('POST', '/api/me/mcp-tokens', { name: 'work-mac' }, aliceCookie))
      .data as unknown as McpTokenCreated;

    // 非管理员禁止访问管理端 MCP 令牌接口
    expect(
      (await call('GET', `/api/admin/users/${alice.id}/mcp-tokens`, undefined, aliceCookie)).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/api/admin/users/${alice.id}/mcp-tokens/${createdTok.info.id}/revoke`,
          {},
          aliceCookie,
        )
      ).status,
    ).toBe(403);

    // 不存在的用户 / 不匹配的令牌 → 404
    expect(
      (await call('GET', '/api/admin/users/no-such-user/mcp-tokens', undefined, adminCookie)).status,
    ).toBe(404);
    expect(
      (await call('POST', `/api/admin/users/${alice.id}/mcp-tokens/no-such-token/revoke`, {}, adminCookie))
        .status,
    ).toBe(404);

    // 管理员查看 + 吊销
    const list = (await call('GET', `/api/admin/users/${alice.id}/mcp-tokens`, undefined, adminCookie))
      .data as unknown as AdminMcpTokenList;
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]!.id).toBe(createdTok.info.id);

    const rev = await call(
      'POST',
      `/api/admin/users/${alice.id}/mcp-tokens/${createdTok.info.id}/revoke`,
      {},
      adminCookie,
    );
    expect(rev.status).toBe(200);
    expect(rev.data as unknown as McpTokenInfo).toMatchObject({
      status: 'revoked',
      revokedReason: 'admin',
      revokedBy: { id: (await call('GET', '/api/auth/me', undefined, adminCookie)).data.id, name: '管理员' },
    });
    // 已吊销再吊销 → 409
    expect(
      (
        await call(
          'POST',
          `/api/admin/users/${alice.id}/mcp-tokens/${createdTok.info.id}/revoke`,
          {},
          adminCookie,
        )
      ).status,
    ).toBe(409);

    const revAudit = (
      (await call('GET', '/api/admin/audit?action=mcp_token.revoke', undefined, adminCookie))
        .data as unknown as AuditPage
    ).events[0]!;
    expect(revAudit.data).toMatchObject({ byAdmin: true, reason: 'admin', userId: alice.id });

    // 实例设置 allowMcpAccess 开关往返与审计
    const t2 = (await call('POST', '/api/me/mcp-tokens', { name: 'still-active' }, aliceCookie))
      .data as unknown as McpTokenCreated;
    const settingsBefore = (await call('GET', '/api/admin/settings', undefined, adminCookie))
      .data as unknown as InstanceSettings;
    expect(settingsBefore.allowMcpAccess).toBe(true);

    const patchOff = await call('PATCH', '/api/admin/settings', { allowMcpAccess: false }, adminCookie);
    expect(patchOff.status).toBe(200);
    expect((patchOff.data as unknown as InstanceSettings).allowMcpAccess).toBe(false);
    expect(
      ((await call('GET', '/api/admin/settings', undefined, adminCookie)).data as unknown as InstanceSettings)
        .allowMcpAccess,
    ).toBe(false);

    const settingsAudit = (
      (await call('GET', '/api/admin/audit?action=instance.settings_update', undefined, adminCookie))
        .data as unknown as AuditPage
    ).events[0]!;
    expect(settingsAudit.data).toMatchObject({ allowMcpAccess: false });

    // 关闭后：列表 allowed=false，新建返回 403 mcp_disabled，已有令牌请求 /api/mcp 返回 403 mcp_disabled
    const listOff = (await call('GET', '/api/me/mcp-tokens', undefined, aliceCookie))
      .data as unknown as McpTokenList;
    expect(listOff.allowed).toBe(false);
    const createOff = await call('POST', '/api/me/mcp-tokens', { name: 'blocked' }, aliceCookie);
    expect(createOff.status).toBe(403);
    expect(createOff.data).toMatchObject({ code: 'mcp_disabled' });

    const mcpOff = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${t2.token}` });
    expect(mcpOff.status).toBe(403);
    expect(mcpOff.data).toMatchObject({ code: 'mcp_disabled' });

    // 重新打开后恢复可用
    expect((await call('PATCH', '/api/admin/settings', { allowMcpAccess: true }, adminCookie)).status).toBe(
      200,
    );
    const mcpOn = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${t2.token}` });
    expect([401, 403, 429]).not.toContain(mcpOn.status);
    expect((await call('POST', '/api/me/mcp-tokens', { name: 'restored' }, aliceCookie)).status).toBe(201);
  });

  test.skipIf(skip)('批量吊销钩子（停用/管理员重置密码/重置链接）、本人改密保留与删用户级联', async () => {
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(db, 'alice', { name: '爱丽丝' });
    const bob = await makeUser(db, 'bob', { name: '鲍勃' });
    const adminCookie = await loginAs('admin');
    const aliceCookie = await loginAs('alice');
    let bobCookie = await loginAs('bob');

    // 1. 停用用户：全部未吊销令牌被吊销为 user_disabled；已吊销的保持原原因；重新启用不恢复；无活跃令牌再停用不写 revoke_all 审计
    const a1 = (await call('POST', '/api/me/mcp-tokens', { name: 'a1' }, aliceCookie))
      .data as unknown as McpTokenCreated;
    const a2 = (await call('POST', '/api/me/mcp-tokens', { name: 'a2' }, aliceCookie))
      .data as unknown as McpTokenCreated;
    expect((await call('POST', `/api/me/mcp-tokens/${a2.info.id}/revoke`, {}, aliceCookie)).status).toBe(200);

    expect(
      (await call('PATCH', `/api/admin/users/${alice.id}`, { status: 'disabled' }, adminCookie)).status,
    ).toBe(200);
    const aliceAfterDisable = (
      await call('GET', `/api/admin/users/${alice.id}/mcp-tokens`, undefined, adminCookie)
    ).data as unknown as AdminMcpTokenList;
    expect(aliceAfterDisable.tokens.find((t) => t.id === a1.info.id)).toMatchObject({
      status: 'revoked',
      revokedReason: 'user_disabled',
    });
    expect(aliceAfterDisable.tokens.find((t) => t.id === a2.info.id)).toMatchObject({
      status: 'revoked',
      revokedReason: 'self',
    });

    const disableAudits = (
      await call('GET', '/api/admin/audit?action=mcp_token.revoke_all', undefined, adminCookie)
    ).data as unknown as AuditPage;
    expect(disableAudits.events).toHaveLength(1);
    expect(disableAudits.events[0]).toMatchObject({
      actorKind: 'user',
      targetKind: 'user',
      targetId: alice.id,
      data: { reason: 'user_disabled', count: 1 },
    });

    // 重新启用不恢复令牌
    expect(
      (await call('PATCH', `/api/admin/users/${alice.id}`, { status: 'active' }, adminCookie)).status,
    ).toBe(200);
    const afterReenable = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${a1.token}` });
    expect(afterReenable.status).toBe(401);
    expect(afterReenable.data).toMatchObject({ code: 'token_revoked' });

    // 没有任何未吊销令牌时再停用：count=0，不额外写 mcp_token.revoke_all 审计
    expect(
      (await call('PATCH', `/api/admin/users/${alice.id}`, { status: 'disabled' }, adminCookie)).status,
    ).toBe(200);
    expect(
      (
        (await call('GET', '/api/admin/audit?action=mcp_token.revoke_all', undefined, adminCookie))
          .data as unknown as AuditPage
      ).events,
    ).toHaveLength(1);

    // 2. 本人主动修改密码：不吊销 MCP 令牌
    const bKeep = (await call('POST', '/api/me/mcp-tokens', { name: 'bob-keep' }, bobCookie))
      .data as unknown as McpTokenCreated;
    expect(
      (await call('POST', '/api/me/password', { oldPassword: PASSWORD, newPassword: 'password2' }, bobCookie))
        .status,
    ).toBe(200);
    const bAfterSelfPw = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${bKeep.token}` });
    expect([401, 403, 429]).not.toContain(bAfterSelfPw.status);

    // 3. 管理员重置密码：吊销全部未吊销令牌（reason=password_reset）
    expect(
      (
        await call(
          'POST',
          `/api/admin/users/${bob.id}/reset-password`,
          { password: 'temp-password-1' },
          adminCookie,
        )
      ).status,
    ).toBe(200);
    const bobAfterAdminReset = (
      await call('GET', `/api/admin/users/${bob.id}/mcp-tokens`, undefined, adminCookie)
    ).data as unknown as AdminMcpTokenList;
    expect(bobAfterAdminReset.tokens[0]).toMatchObject({
      id: bKeep.info.id,
      status: 'revoked',
      revokedReason: 'password_reset',
    });

    // 改回正常密码并再建一个令牌，然后测试重置链接消费
    bobCookie = await loginAs('bob', 'temp-password-1');
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: 'temp-password-1', newPassword: 'password3' },
          bobCookie,
        )
      ).status,
    ).toBe(200);
    const bResetLinkTok = (await call('POST', '/api/me/mcp-tokens', { name: 'bob-link-revoke' }, bobCookie))
      .data as unknown as McpTokenCreated;

    const resetLink = await call('POST', `/api/admin/users/${bob.id}/reset-link`, {}, adminCookie);
    expect(resetLink.status).toBe(200);
    const consumed = await call('POST', `/api/reset/${resetLink.data.token as string}`, {
      password: 'password4',
    });
    expect(consumed.status).toBe(200);
    const bobAfterLinkReset = (
      await call('GET', `/api/admin/users/${bob.id}/mcp-tokens`, undefined, adminCookie)
    ).data as unknown as AdminMcpTokenList;
    expect(bobAfterLinkReset.tokens.find((t) => t.id === bResetLinkTok.info.id)).toMatchObject({
      status: 'revoked',
      revokedReason: 'password_reset',
      revokedBy: null,
    });

    const allRevokeAudits = (
      await call('GET', '/api/admin/audit?action=mcp_token.revoke_all', undefined, adminCookie)
    ).data as unknown as AuditPage;
    expect(allRevokeAudits.events).toHaveLength(3);
    expect(allRevokeAudits.events.every((e) => e.actorKind === 'user')).toBe(true);

    // 4. 删除用户级联删除 mcp_tokens 行
    await db.query('delete from users where id = $1', [bob.id]);
    expect(await db.query('select id from mcp_tokens where user_id = $1', [bob.id])).toEqual([]);
  });

  test.skipIf(skip)('/api/mcp 认证矩阵与令牌隔离（含 CI 令牌和 WebSocket）', async () => {
    const admin = await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    await makeUser(db, 'bob', { name: '鲍勃' });
    const forced = await makeUser(db, 'forced', { name: '强制改密', mustChangePassword: true });
    const adminCookie = await loginAs('admin');
    const bobCookie = await loginAs('bob');

    // 创建组、项目、CI 令牌和 MCP 令牌
    const g = await call('POST', '/api/groups', { slug: 'iso-g', name: '隔离组' }, adminCookie);
    const p = await call('POST', '/api/projects', { name: '隔离库', groupId: g.data.id }, adminCookie);
    const pid = p.data.id as string;
    const ciTok = (await call('POST', `/api/projects/${pid}/tokens`, { name: 'ci' }, adminCookie)).data
      .token as string;
    const mcpTok = (await call('POST', '/api/me/mcp-tokens', { name: 'bob-mcp' }, bobCookie))
      .data as unknown as McpTokenCreated;
    const expiredTok = (await call('POST', '/api/me/mcp-tokens', { name: 'expired' }, bobCookie))
      .data as unknown as McpTokenCreated;
    await db.query('update mcp_tokens set expires_at = $2 where id = $1', [
      expiredTok.info.id,
      new Date(Date.now() - 1000).toISOString(),
    ]);
    const revokedTok = (await call('POST', '/api/me/mcp-tokens', { name: 'revoked' }, bobCookie))
      .data as unknown as McpTokenCreated;
    expect(
      (await call('POST', `/api/me/mcp-tokens/${revokedTok.info.id}/revoke`, {}, bobCookie)).status,
    ).toBe(200);

    // 缺头、畸形、不存在、过期、已吊销 → 401 + WWW-Authenticate
    const missing = await call('POST', '/api/mcp', {});
    expect(missing.status).toBe(401);
    expect(missing.data).toMatchObject({ code: 'token_missing' });
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');

    // 仅带会话 cookie 不认
    const cookieOnly = await call('POST', '/api/mcp', {}, adminCookie);
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.data).toMatchObject({ code: 'token_missing' });

    for (const badAuth of ['Basic abc', 'Bearer not-mcp', 'Bearer dwm_short']) {
      const r = await call('POST', '/api/mcp', {}, '', { authorization: badAuth });
      expect(r.status, badAuth).toBe(401);
      expect(r.data).toMatchObject({ code: 'token_invalid' });
      expect(r.headers.get('www-authenticate')).toContain('Bearer');
    }

    const unknown = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer dwm_${'A'.repeat(43)}` });
    expect(unknown.status).toBe(401);
    expect(unknown.data).toMatchObject({ code: 'token_invalid' });
    expect(unknown.headers.get('www-authenticate')).toContain('Bearer');

    const expRes = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${expiredTok.token}` });
    expect(expRes.status).toBe(401);
    expect(expRes.data).toMatchObject({ code: 'token_expired' });
    expect(expRes.headers.get('www-authenticate')).toContain('Bearer');

    const revRes = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${revokedTok.token}` });
    expect(revRes.status).toBe(401);
    expect(revRes.data).toMatchObject({ code: 'token_revoked' });
    expect(revRes.headers.get('www-authenticate')).toContain('Bearer');

    // 直接改库把 user 置为 disabled（绕过 hook）→ 401 user_disabled + WWW-Authenticate
    const directDisUser = await makeUser(db, 'direct-dis', { name: '直接停用' });
    const directDisCookie = await loginAs('direct-dis');
    const directDisTok = (await call('POST', '/api/me/mcp-tokens', { name: 'dis-tok' }, directDisCookie))
      .data as unknown as McpTokenCreated;
    await db.query("update users set status = 'disabled' where id = $1", [directDisUser.id]);
    const directDisRes = await call('POST', '/api/mcp', {}, '', {
      authorization: `Bearer ${directDisTok.token}`,
    });
    expect(directDisRes.status).toBe(401);
    expect(directDisRes.data).toMatchObject({ code: 'user_disabled' });
    expect(directDisRes.headers.get('www-authenticate')).toContain('Bearer');

    // must_change_password → 403 password_change_required
    // 先把 forced 暂时设为 false 建令牌，再设回 true（或在库里直接插一条该用户的令牌）
    await db.query('update users set must_change_password = $2 where id = $1', [forced.id, false]);
    const forcedCookie = await loginAs('forced');
    const forcedTok = (await call('POST', '/api/me/mcp-tokens', { name: 'forced-tok' }, forcedCookie))
      .data as unknown as McpTokenCreated;
    await db.query('update users set must_change_password = $2 where id = $1', [forced.id, true]);
    const forcedRes = await call('POST', '/api/mcp', {}, '', {
      authorization: `Bearer ${forcedTok.token}`,
    });
    expect(forcedRes.status).toBe(403);
    expect(forcedRes.data).toMatchObject({ code: 'password_change_required' });

    // 有效令牌通过认证（当前分支 /api/mcp 为 501 占位）
    const okRes = await call('POST', '/api/mcp', {}, '', { authorization: `Bearer ${mcpTok.token}` });
    expect([401, 403, 429]).not.toContain(okRes.status);

    // 令牌跨边界隔离（即使同时附带管理员 cookie）：
    // 1) Bearer dwl_... 访问 /api/mcp → 403 forbidden
    const ciOnMcp = await call('POST', '/api/mcp', {}, adminCookie, { authorization: `Bearer ${ciTok}` });
    expect(ciOnMcp.status).toBe(403);
    expect(ciOnMcp.data).toMatchObject({ ok: false, code: 'forbidden' });

    // 2) Bearer dwm_... 访问 /api/projects、/api/me/mcp-tokens、/api/ci/token、WS /api/projects/:pid/sync → 403 forbidden
    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['GET', '/api/me/mcp-tokens'],
      ['GET', '/api/ci/token'],
    ] as const) {
      const r = await call(method, path, undefined, adminCookie, {
        authorization: `Bearer ${mcpTok.token}`,
      });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.data).toMatchObject({ code: 'forbidden' });
    }

    const server = serve({ fetch: created.app.fetch, port: 0, hostname: '127.0.0.1' });
    created.injectWebSocket(server);
    try {
      await new Promise((r) => server.once('listening', r));
      const wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${pid}/sync`;
      const wsStatus = await new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl, {
          headers: { authorization: `Bearer ${mcpTok.token}`, cookie: adminCookie },
        });
        ws.on('unexpected-response', (_req, res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        });
        ws.on('error', () => resolve(-1));
      });
      expect(wsStatus).toBe(403);
    } finally {
      await new Promise((r) => server.close(r));
    }
    expect(admin.id).toBeTruthy();
  });

  test.skipIf(skip)('限流防护（pitfalls #8 #9）与 last_used_at 节流更新', async () => {
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const adminCookie = await loginAs('admin');

    const limitedApp = boot({
      security: { trustProxy: true },
      mcpFailLimiter: new KeyedLimiter({ limit: 3, windowMs: 60_000 }),
      mcpLimiter: new KeyedLimiter({ limit: 3, windowMs: 60_000 }),
    });
    try {
      const mcpReq = (ip: string, auth?: string) =>
        callOn(limitedApp.app, 'POST', '/api/mcp', {}, '', {
          'x-forwarded-for': ip,
          ...(auth ? { authorization: auth } : {}),
        });

      const coldValid = (
        await callOn(limitedApp.app, 'POST', '/api/me/mcp-tokens', { name: 'cold-valid' }, adminCookie)
      ).data as unknown as McpTokenCreated;
      const badValid = (
        await callOn(limitedApp.app, 'POST', '/api/me/mcp-tokens', { name: 'expired' }, adminCookie)
      ).data as unknown as McpTokenCreated;
      await db.query('update mcp_tokens set expires_at = $2 where id = $1', [
        badValid.info.id,
        new Date(Date.now() - 1000).toISOString(),
      ]);

      // 缺头和格式非法永不消耗失败桶
      for (let i = 0; i < 6; i++) {
        expect((await mcpReq('198.51.100.1')).status).toBe(401);
        expect((await mcpReq('198.51.100.1', 'Bearer bad-format')).status).toBe(401);
      }

      // 合法格式失败消耗 3 次额度，第 4 次触发 429 + Retry-After
      for (let i = 0; i < 3; i++) {
        const fail = await mcpReq('198.51.100.1', `Bearer dwm_${String(i).padStart(43, 'A')}`);
        expect(fail.status).toBe(401);
        expect(fail.data).toMatchObject({ code: 'token_invalid' });
      }
      const blocked = await mcpReq('198.51.100.1', `Bearer ${badValid.token}`);
      expect(blocked.status).toBe(429);
      expect(blocked.data).toMatchObject({ code: 'rate_limited' });
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

      // 同一已限流 IP 上：冷态合法活跃令牌仍放行通过认证，不误杀共享 NAT
      const coldPass = await mcpReq('198.51.100.1', `Bearer ${coldValid.token}`);
      expect([401, 403, 429]).not.toContain(coldPass.status);

      // 限流状态下新创建的令牌也立即可用，吊销后立即被 429 拦截
      const newlyCreated = (
        await callOn(limitedApp.app, 'POST', '/api/me/mcp-tokens', { name: 'after-block' }, adminCookie)
      ).data as unknown as McpTokenCreated;
      expect([401, 403, 429]).not.toContain(
        (await mcpReq('198.51.100.1', `Bearer ${newlyCreated.token}`)).status,
      );
      expect(
        (
          await callOn(
            limitedApp.app,
            'POST',
            `/api/me/mcp-tokens/${newlyCreated.info.id}/revoke`,
            {},
            adminCookie,
          )
        ).status,
      ).toBe(200);
      expect((await mcpReq('198.51.100.1', `Bearer ${newlyCreated.token}`)).status).toBe(429);

      // 单令牌限流：coldValid 在 198.51.100.1 已用 1 次，在另一个 IP 再用 2 次达上限 3，第 4 次返回 429 + Retry-After
      expect([401, 403, 429]).not.toContain(
        (await mcpReq('198.51.100.2', `Bearer ${coldValid.token}`)).status,
      );
      expect([401, 403, 429]).not.toContain(
        (await mcpReq('198.51.100.2', `Bearer ${coldValid.token}`)).status,
      );
      const tokenLimited = await mcpReq('198.51.100.2', `Bearer ${coldValid.token}`);
      expect(tokenLimited.status).toBe(429);
      expect(tokenLimited.data).toMatchObject({ code: 'rate_limited' });
      expect(Number(tokenLimited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

      // last_used_at 节流更新（60s 内不重复写，超过 60s 更新）
      const usageTok = (
        await callOn(limitedApp.app, 'POST', '/api/me/mcp-tokens', { name: 'usage' }, adminCookie)
      ).data as unknown as McpTokenCreated;
      await mcpReq('198.51.100.9', `Bearer ${usageTok.token}`);
      const firstList = (await callOn(limitedApp.app, 'GET', '/api/me/mcp-tokens', undefined, adminCookie))
        .data as unknown as McpTokenList;
      const firstInfo = firstList.tokens.find((t) => t.id === usageTok.info.id)!;
      expect(firstInfo.lastUsedAt).not.toBeNull();
      expect(firstInfo.lastUsedIp).toBe('198.51.100.9');

      await mcpReq('198.51.100.10', `Bearer ${usageTok.token}`);
      const secondList = (await callOn(limitedApp.app, 'GET', '/api/me/mcp-tokens', undefined, adminCookie))
        .data as unknown as McpTokenList;
      const secondInfo = secondList.tokens.find((t) => t.id === usageTok.info.id)!;
      expect(secondInfo.lastUsedAt).toBe(firstInfo.lastUsedAt);
      expect(secondInfo.lastUsedIp).toBe('198.51.100.9');

      const oldIso = new Date(Date.now() - 61_000).toISOString();
      await db.query('update mcp_tokens set last_used_at = $2 where id = $1', [usageTok.info.id, oldIso]);
      await mcpReq('198.51.100.11', `Bearer ${usageTok.token}`);
      const thirdList = (await callOn(limitedApp.app, 'GET', '/api/me/mcp-tokens', undefined, adminCookie))
        .data as unknown as McpTokenList;
      const thirdInfo = thirdList.tokens.find((t) => t.id === usageTok.info.id)!;
      expect(Date.parse(thirdInfo.lastUsedAt!)).toBeGreaterThan(Date.parse(oldIso));
      expect(thirdInfo.lastUsedIp).toBe('198.51.100.11');
    } finally {
      await closeApp(limitedApp);
    }
  });
});

describe('跨副本 MCP 令牌缓存失效（mcp_tokens.changed）', () => {
  test('收到其他副本的 mcp_tokens.changed 事件后，activeMcpTokens 立即失效并重刷', async () => {
    const inner = await openPlatformDb(':memory:');
    let onPayload: ((payload: string) => void) | null = null;
    let onReconnect: (() => void) | undefined;
    const pgLikeDb: PlatformDb = {
      dialect: 'pg',
      query: (q, params) => inner.query(q.replace(/ for update/gi, ''), params),
      exec: (q) => inner.exec(q),
      transaction: (fn, opts) =>
        inner.transaction(
          (tx) =>
            fn({
              query: (q, params) => tx.query(q.replace(/ for update/gi, ''), params),
              exec: (q) => tx.exec(q),
            }),
          opts,
        ),
      listen: async (_ch, cb, reconnect) => {
        onPayload = cb;
        onReconnect = reconnect;
        return async () => {
          onPayload = null;
        };
      },
      notify: async () => {},
      withAdvisoryLock: (key, fn, opts) => inner.withAdvisoryLock(key, fn, opts),
      close: () => inner.close(),
    };

    const created = createApp(pgLikeDb, {
      bus: { replicaId: 'replica-a' },
      security: { trustProxy: true },
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      mcpFailLimiter: new KeyedLimiter({ limit: 1, windowMs: 60_000 }),
      mcpLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    await created.webhooks.close();
    created.requests.stop();
    await created.bus.start();

    try {
      await makeUser(inner, 'admin', { name: '管理员', role: 'admin' });
      const login = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const makeTok = async (name: string) => {
        const r = await created.app.request('/api/me/mcp-tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ name }),
        });
        expect(r.status).toBe(201);
        return (await r.json()) as McpTokenCreated;
      };
      const tokSame = await makeTok('cluster-same');
      const tokRemote = await makeTok('cluster-remote');

      const mcpCall = (auth: string) =>
        created.app.request('/api/mcp', {
          method: 'POST',
          headers: { 'x-forwarded-for': '198.51.100.77', authorization: auth },
        });

      // 先耗尽该 IP 的失败桶并预热 activeMcpTokens 快照
      expect((await mcpCall(`Bearer dwm_${'Z'.repeat(43)}`)).status).toBe(401);
      expect([401, 403, 429]).not.toContain((await mcpCall(`Bearer ${tokSame.token}`)).status);
      expect([401, 403, 429]).not.toContain((await mcpCall(`Bearer ${tokRemote.token}`)).status);

      // 模拟另一个副本直接在数据库吊销这两个令牌（未走本副本内存清理）
      await inner.query(
        "update mcp_tokens set revoked_at = $3, revoked_reason = 'self' where id in ($1, $2)",
        [tokSame.info.id, tokRemote.info.id, new Date().toISOString()],
      );

      // 同副本回环事件不使缓存失效（tokSame 仍命中旧缓存进入强校验，返回 401 token_revoked）
      onPayload!(JSON.stringify({ t: 'mcp_tokens.changed', origin: 'replica-a' }));
      const sameOriginRes = await mcpCall(`Bearer ${tokSame.token}`);
      expect(sameOriginRes.status).toBe(401);
      expect(await sameOriginRes.json()).toMatchObject({ code: 'token_revoked' });

      // 来自其他副本的 mcp_tokens.changed 使缓存立刻失效并刷新，tokRemote 直接在限流阶段拦为 429
      onPayload!(JSON.stringify({ t: 'mcp_tokens.changed', origin: 'replica-b' }));
      const blocked = await mcpCall(`Bearer ${tokRemote.token}`);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ code: 'rate_limited' });

      // 断线重连回调同样会标脏缓存
      const tok2 = await makeTok('cluster-reconnect');
      expect([401, 403, 429]).not.toContain((await mcpCall(`Bearer ${tok2.token}`)).status);
      await inner.query("update mcp_tokens set revoked_at = $2, revoked_reason = 'admin' where id = $1", [
        tok2.info.id,
        new Date().toISOString(),
      ]);
      onReconnect?.();
      expect((await mcpCall(`Bearer ${tok2.token}`)).status).toBe(429);
    } finally {
      created.drift.stop();
      created.requests.stop();
      created.refresher.stop();
      await created.requests.drain();
      await created.webhooks.close();
      await created.bus.close();
      await created.rooms.flush();
      created.rooms.close();
      await created.shadows.close();
      await created.ha.stop();
      await inner.close();
    }
  });
});
