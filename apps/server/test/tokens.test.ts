// CI 令牌（P6，T1～T4）集成与验收测试：
// - 纯函数：三层“谁能创建令牌”逐层取与（下级只能收紧）；
// - T1：令牌生成 / 哈希存储 / 过期与吊销立即生效 / 创建者停用不影响 / 认证失败限速与令牌限速 / 跨项目隔离；
// - T2：实例 / 组 / 项目三层规则、组条件自动给项目只读可见性、删组清理；
// - T3（目标库 PG）：只读接口、预演、真实执行、生产默认拒绝与开关放行（跳过审批）、各类约定错误码逐一覆盖、
//   执行锁超时与锁内复查、待处理申请失效、审计与收件箱 / Webhook 通知；
// - T4（目标库 PG）：本地 HTTP 服务跑一遍 actions/execute/run.sh（预演、执行、noop、失败退出码与 GITHUB_OUTPUT）。
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  type AuditPage,
  type CiDriftResult,
  type CiEnvironmentStatus,
  type CiErrorBody,
  type CiExecuteResult,
  type CiHistory,
  type CiProject,
  type CiTokenCreated,
  type CiTokenList,
  type CiTokenSelf,
  type CiVersion,
  ciDriftResultSchema,
  ciEnvironmentStatusSchema,
  ciProjectSchema,
  effectiveTokenRules,
  type InboxList,
  type ProjectActivity,
  type ProjectInfo,
  TOKEN_PATTERN,
  type TokenPolicyView,
  tokenCreatorAllows,
  type VersionDetail,
} from '@dowel/api';
import { addColumn, all, type Model, newId, plan } from '@dowel/core';
import { stepsChecksum, toScriptSteps } from '@dowel/engines';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { hashToken } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { ActiveTokenCache } from '../src/tokens.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'tokens-test-secret-0123456789';

const execFileAsync = promisify(execFile);
const ACTION_SCRIPT = resolve(import.meta.dirname, '../../../actions/execute/run.sh');

describe('谁能创建令牌：三层逐层取与（纯函数）', () => {
  const groups = (entries: [string, 'admin' | 'member'][]) => new Map(entries);

  test('三层都未设置时默认项目管理员可以', () => {
    expect(effectiveTokenRules({})).toEqual([{ layer: 'default', rule: { roles: ['admin'], groups: [] } }]);
    expect(tokenCreatorAllows({}, { role: 'admin', groups: groups([]) })).toBe(true);
    expect(tokenCreatorAllows({}, { role: 'editor', groups: groups([]) })).toBe(false);
    expect(tokenCreatorAllows({}, { role: 'viewer', groups: groups([]) })).toBe(false);
    expect(tokenCreatorAllows({}, { role: null, groups: groups([]) })).toBe(false);
  });

  test('逐层取与：下级只能在上级允许的人里收窄，无法放宽', () => {
    // 实例层只允许安全组（sec）成员；项目层设为项目编辑者以上 → 必须同时是安全组成员且为项目编辑者以上
    const layers = {
      instance: { roles: [], groups: [{ groupId: 'sec', role: 'member' as const }] },
      project: { roles: ['editor' as const], groups: [] },
    };
    expect(tokenCreatorAllows(layers, { role: 'admin', groups: groups([]) })).toBe(false);
    expect(tokenCreatorAllows(layers, { role: null, groups: groups([['sec', 'member']]) })).toBe(false);
    expect(tokenCreatorAllows(layers, { role: 'viewer', groups: groups([['sec', 'member']]) })).toBe(false);
    expect(tokenCreatorAllows(layers, { role: 'editor', groups: groups([['sec', 'member']]) })).toBe(true);
    expect(tokenCreatorAllows(layers, { role: 'admin', groups: groups([['sec', 'admin']]) })).toBe(true);
  });

  test('空规则表示该层不允许任何人（实例管理员由调用方放行）', () => {
    const layers = {
      instance: { roles: [], groups: [] },
      project: { roles: ['editor' as const], groups: [{ groupId: 'sec', role: 'member' as const }] },
    };
    expect(tokenCreatorAllows(layers, { role: 'admin', groups: groups([['sec', 'admin']]) })).toBe(false);
  });
});

describe('ActiveTokenCache（活跃令牌快照缓存）', () => {
  test('惰性加载、TTL 复用、自然过期即刻失效、markStale 补刷、forget 清理与容量淘汰', async () => {
    let now = 1_000_000;
    let queryCalls = 0;
    let rows: { tokenHash: string; id: string; projectId: string; expiresAt: string }[] = [
      { tokenHash: 'h1', id: 't1', projectId: 'p1', expiresAt: new Date(now + 5_000).toISOString() },
      { tokenHash: 'h2', id: 't2', projectId: 'p2', expiresAt: new Date(now + 60_000).toISOString() },
    ];
    let releaseFirst: (() => void) | null = null;
    let blockNextQuery = false;

    const fakeDb = {
      query: async () => {
        queryCalls++;
        const snapshot = rows.map((r) => ({ ...r }));
        if (blockNextQuery) {
          blockNextQuery = false;
          await new Promise<void>((r) => {
            releaseFirst = r;
          });
        }
        return snapshot;
      },
    } as unknown as PlatformDb;

    const cache = new ActiveTokenCache(fakeDb, { ttlMs: 15_000, maxEntries: 3, now: () => now });

    // 未调用 hasActive 前不查库
    expect(queryCalls).toBe(0);
    expect(await cache.hasActive('h1')).toBe(true);
    expect(queryCalls).toBe(1);

    // TTL 内复用快照，不重复查库
    expect(await cache.hasActive('h2')).toBe(true);
    expect(await cache.hasActive('missing')).toBe(false);
    expect(queryCalls).toBe(1);

    // 时钟越过 h1 过期时间，无需刷新快照即刻失效
    now += 5_000;
    expect(await cache.hasActive('h1')).toBe(false);
    expect(queryCalls).toBe(1);

    // remember 与容量上限淘汰（maxEntries=3）
    cache.remember('h3', { id: 't3', projectId: 'p1', expiresAtMs: now + 60_000 });
    cache.remember('h4', { id: 't4', projectId: 'p1', expiresAtMs: now + 60_000 });
    cache.remember('h5', { id: 't5', projectId: 'p1', expiresAtMs: now + 60_000 });
    // 最旧的 h2 已被淘汰
    expect(await cache.hasActive('h2')).toBe(false);
    expect(await cache.hasActive('h5')).toBe(true);

    // forgetId / forgetProject / forgetHash 立即生效
    cache.forgetId('t3');
    expect(await cache.hasActive('h3')).toBe(false);
    cache.forgetProject('p1');
    expect(await cache.hasActive('h4')).toBe(false);
    expect(await cache.hasActive('h5')).toBe(false);

    // 刷新查询进行期间收到 markStale（模拟并发创建 / 吊销）时，结束后会补刷一次反映最新数据
    now += 20_000;
    blockNextQuery = true;
    const pending = cache.hasActive('h_new');
    // 在第一次查询尚未返回时，数据库新增了 h_new 且触发了 markStale
    rows = [
      ...rows,
      { tokenHash: 'h_new', id: 't_new', projectId: 'p1', expiresAt: new Date(now + 60_000).toISOString() },
    ];
    cache.markStale();
    releaseFirst!();
    expect(await pending).toBe(true);
    expect(queryCalls).toBe(3);
  });
});

describe('CI 令牌生命周期、权限、三层创建规则与限速（T1 / T2）', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let groupId = '';
  let groupSlug = '';
  let pipeGroupId = '';
  let pid = '';
  let projectSlug = '';
  let otherPid = '';

  const call = async (
    method: string,
    path: string,
    json?: unknown,
    who: string | null = 'admin',
    headers: Record<string, string> = {},
  ) => {
    const h: Record<string, string> = { ...headers };
    if (who) h.cookie = cookies[who]!;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await created.app.request(path, {
      method,
      headers: h,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data: data as Record<string, unknown>, headers: res.headers };
  };

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 4, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    await makeUser(db, 'admin', { name: '实例管理员', role: 'admin' });
    for (const n of ['ga', 'pa', 'editor', 'viewer', 'pipe', 'outsider'])
      ids[n] = (await makeUser(db, n, { name: n })).id;
    for (const n of ['admin', 'ga', 'pa', 'editor', 'viewer', 'pipe', 'outsider']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const g = await call('POST', '/api/groups', { slug: 'tok-g', name: '业务组', defaultRole: 'none' }, 'ga');
    expect(g.status).toBe(201);
    groupId = g.data.id as string;
    groupSlug = 'tok-g';

    const pg = await call(
      'POST',
      '/api/groups',
      { slug: 'pipe-g', name: '流水线组', defaultRole: 'none' },
      'admin',
    );
    expect(pg.status).toBe(201);
    pipeGroupId = pg.data.id as string;
    expect(
      (await call('POST', '/api/groups/pipe-g/members', { username: 'pipe', role: 'member' }, 'admin'))
        .status,
    ).toBe(200);

    const p = await call('POST', '/api/projects', { name: '订单库', groupId }, 'ga');
    expect(p.status).toBe(201);
    pid = p.data.id as string;
    projectSlug = p.data.slug as string;

    const p2 = await call('POST', '/api/projects', { name: '另一项目', groupId }, 'ga');
    expect(p2.status).toBe(201);
    otherPid = p2.data.id as string;

    for (const [u, role] of [
      ['pa', 'admin'],
      ['editor', 'editor'],
      ['viewer', 'viewer'],
    ] as const)
      expect(
        (
          await call(
            'POST',
            `/api/projects/${pid}/grants`,
            { subjectKind: 'user', subjectId: ids[u], role },
            'ga',
          )
        ).status,
      ).toBe(201);
  });

  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
  });

  test('创建令牌只返回一次明文、库里只存哈希、必须设有效期（1～365 天）', async () => {
    // 非法有效期被拒
    expect(
      (await call('POST', `/api/projects/${pid}/tokens`, { name: 'bad', expiresInDays: 0 }, 'pa')).status,
    ).toBe(400);
    expect(
      (await call('POST', `/api/projects/${pid}/tokens`, { name: 'bad', expiresInDays: 366 }, 'pa')).status,
    ).toBe(400);
    // 默认规则：编辑者 / 查看者不能创建或查看列表
    expect((await call('POST', `/api/projects/${pid}/tokens`, { name: 'no' }, 'editor')).status).toBe(403);
    expect((await call('GET', `/api/projects/${pid}/tokens`, undefined, 'editor')).status).toBe(403);

    const res = await call(
      'POST',
      `/api/projects/${pid}/tokens`,
      { name: '主干流水线', description: 'staging 发布', expiresInDays: 30 },
      'pa',
    );
    expect(res.status).toBe(201);
    const createdTok = res.data as unknown as CiTokenCreated;
    expect(createdTok.token).toMatch(TOKEN_PATTERN);
    expect(createdTok.info.prefix).toBe(createdTok.token.slice(0, 12));
    expect(createdTok.info.status).toBe('active');
    expect(createdTok.info.createdBy).toEqual({ id: ids.pa, name: 'pa' });

    // 数据库里存的是 SHA-256 哈希，不存明文
    const [row] = await db.query<{ token_hash: string }>('select token_hash from ci_tokens where id = $1', [
      createdTok.info.id,
    ]);
    expect(row!.token_hash).toBe(hashToken(createdTok.token));
    expect(row!.token_hash).not.toBe(createdTok.token);

    // 列表里不再出现明文
    const list = (await call('GET', `/api/projects/${pid}/tokens`, undefined, 'pa'))
      .data as unknown as CiTokenList;
    expect(list.canCreate).toBe(true);
    expect(JSON.stringify(list)).not.toContain(createdTok.token);

    // 令牌访问 /api/ci/token 成功并记录最后使用时间；访问其他项目 404；访问管理接口 403
    const self = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${createdTok.token}`,
    });
    expect(self.status).toBe(200);
    expect(self.data as unknown as CiTokenSelf).toMatchObject({
      id: createdTok.info.id,
      name: '主干流水线',
      project: { id: pid, slug: projectSlug, owner: groupSlug },
    });

    const otherSlug = (await call('GET', `/api/projects/${otherPid}`, undefined, 'ga')).data.slug as string;
    const cross = await call('GET', `/api/ci/projects/${groupSlug}/${otherSlug}`, undefined, null, {
      authorization: `Bearer ${createdTok.token}`,
    });
    expect(cross.status).toBe(404);
    expect(cross.data).toMatchObject({ ok: false, code: 'project_not_found' });

    const forbidden = await call('GET', `/api/projects/${pid}/tokens`, undefined, 'admin', {
      authorization: `Bearer ${createdTok.token}`,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.data).toMatchObject({ ok: false, code: 'forbidden' });

    // 停用创建者 pa：令牌仍然属于项目，照常可用
    expect((await call('PATCH', `/api/admin/users/${ids.pa}`, { status: 'disabled' }, 'admin')).status).toBe(
      200,
    );
    const afterDisable = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${createdTok.token}`,
    });
    expect(afterDisable.status).toBe(200);
    // 恢复 pa
    expect((await call('PATCH', `/api/admin/users/${ids.pa}`, { status: 'active' }, 'admin')).status).toBe(
      200,
    );

    // 吊销：非管理员非创建者 403；吊销后立即 401 token_revoked；已吊销时无权者仍是 403，有权者 409
    expect(
      (await call('POST', `/api/projects/${pid}/tokens/${createdTok.info.id}/revoke`, {}, 'editor')).status,
    ).toBe(403);
    const revoked = await call('POST', `/api/projects/${pid}/tokens/${createdTok.info.id}/revoke`, {}, 'ga');
    expect(revoked.status).toBe(200);
    expect(revoked.data).toMatchObject({ status: 'revoked', canRevoke: false });
    expect(
      (await call('POST', `/api/projects/${pid}/tokens/${createdTok.info.id}/revoke`, {}, 'editor')).status,
    ).toBe(403);
    expect(
      (await call('POST', `/api/projects/${pid}/tokens/${createdTok.info.id}/revoke`, {}, 'ga')).status,
    ).toBe(409);

    const afterRevoke = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${createdTok.token}`,
    });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.data).toMatchObject({ ok: false, code: 'token_revoked' });
  });

  test('过期令牌立即返回 401 token_expired；缺失 / 非法头不耗失败额度；格式合法失败触发限速且不阻断同 IP 合法令牌', async () => {
    const t = (await call('POST', `/api/projects/${pid}/tokens`, { name: '快过期' }, 'ga'))
      .data as unknown as CiTokenCreated;
    await db.query('update ci_tokens set expires_at = $2 where id = $1', [
      t.info.id,
      new Date(Date.now() - 1000).toISOString(),
    ]);

    // 预先创建一个从未请求过（冷态）的合法令牌，验证不会被同 IP 失败流量阻断
    const goodCold = (await call('POST', `/api/projects/${pid}/tokens`, { name: '同 IP 冷态合法令牌' }, 'ga'))
      .data as unknown as CiTokenCreated;

    // 缺失头与格式不符 TOKEN_PATTERN 的请求在内存拒绝，不消耗失败限流额度（远超 limit=4 也不触发 429）
    for (let i = 0; i < 6; i++) {
      const missing = await call('GET', '/api/ci/token', undefined, null);
      expect(missing.status).toBe(401);
      expect(missing.data).toMatchObject({ ok: false, code: 'token_missing' });

      const malformed = await call('GET', '/api/ci/token', undefined, null, {
        authorization: i % 2 === 0 ? 'Bearer not-a-dwl-token' : 'Bearer dwl_invalid',
      });
      expect(malformed.status).toBe(401);
      expect(malformed.data).toMatchObject({ ok: false, code: 'token_invalid' });
    }

    // 上一个测试吊销令牌已消费 1 次，此处用格式合法的过期 / 不存在令牌继续触发至上限 4 次
    const r1 = await call('GET', '/api/ci/token', undefined, null, { authorization: `Bearer ${t.token}` });
    expect(r1.status).toBe(401);
    expect(r1.data).toMatchObject({ ok: false, code: 'token_expired' });

    const r2 = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer dwl_${'A'.repeat(43)}`,
    });
    expect(r2.status).toBe(401);
    expect(r2.data).toMatchObject({ ok: false, code: 'token_invalid' });

    const r3 = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer dwl_${'B'.repeat(43)}`,
    });
    expect(r3.status).toBe(401);
    expect(r3.data).toMatchObject({ ok: false, code: 'token_invalid' });

    // 达到上限 4 次后，后续无效 / 过期令牌被 IP 失败限速拦住（429 + Retry-After）
    const r4 = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${t.token}`,
    });
    expect(r4.status).toBe(429);
    expect(r4.data).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(Number(r4.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // 同 IP（含无 trustProxy 时回落 ip:unknown）下从未调用过的冷态合法令牌依然正常 200
    const goodRes = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${goodCold.token}`,
    });
    expect(goodRes.status).toBe(200);
    expect(goodRes.data).toMatchObject({ id: goodCold.info.id, name: '同 IP 冷态合法令牌' });

    // IP 已处于限速状态后新创建的令牌也立即可用（200），吊销后立即被拦截（429，绝不放行）
    const createdAfterBlock = (
      await call('POST', `/api/projects/${pid}/tokens`, { name: '限流后新建令牌' }, 'ga')
    ).data as unknown as CiTokenCreated;
    const afterCreateRes = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${createdAfterBlock.token}`,
    });
    expect(afterCreateRes.status).toBe(200);
    expect(afterCreateRes.data).toMatchObject({ id: createdAfterBlock.info.id });

    expect(
      (await call('POST', `/api/projects/${pid}/tokens/${createdAfterBlock.info.id}/revoke`, {}, 'ga'))
        .status,
    ).toBe(200);
    const afterRevokeBlocked = await call('GET', '/api/ci/token', undefined, null, {
      authorization: `Bearer ${createdAfterBlock.token}`,
    });
    expect(afterRevokeBlocked.status).toBe(429);
    expect(afterRevokeBlocked.data).toMatchObject({ ok: false, code: 'rate_limited' });
  });

  test('共享 NAT IP 爆破防护：随机令牌超限后 429 且不持续打库、并发预占防竞态、同 IP 冷态与并发合法令牌全放行', async () => {
    const natApp = createApp(db, {
      security: { trustProxy: true },
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 4, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    try {
      const ciReq = async (ip: string, auth?: string) => {
        const headers: Record<string, string> = { 'x-forwarded-for': ip };
        if (auth !== undefined) headers.authorization = auth;
        const res = await natApp.app.request('/api/ci/token', { method: 'GET', headers });
        return {
          status: res.status,
          data: (await res.json()) as Record<string, unknown>,
          retryAfter: res.headers.get('retry-after'),
        };
      };

      const coldValid = (await call('POST', `/api/projects/${pid}/tokens`, { name: 'NAT 冷态合法' }, 'ga'))
        .data as unknown as CiTokenCreated;
      const fakeToken = (n: number) => `dwl_${String(n).padStart(43, 'x')}`;

      // 1. 并发 20 个不同随机合法格式无效令牌：同步预占确保严格只放行 4 次查库（401），其余 16 次 429
      const burstInvalid = await Promise.all(
        Array.from({ length: 20 }, (_, i) => ciReq('198.51.100.10', `Bearer ${fakeToken(100 + i)}`)),
      );
      expect(burstInvalid.filter((r) => r.status === 401)).toHaveLength(4);
      expect(burstInvalid.filter((r) => r.status === 429)).toHaveLength(16);

      // 2. 触顶后继续发 30 个不同随机无效令牌：全部 429，且不再继续打数据库（快照已缓存，查询次数为 0）
      let queries = 0;
      const origQuery = db.query.bind(db);
      db.query = ((...args: Parameters<typeof db.query>) => {
        queries++;
        return origQuery(...args);
      }) as typeof db.query;
      try {
        for (let i = 0; i < 30; i++) {
          const r = await ciReq('198.51.100.10', `Bearer ${fakeToken(200 + i)}`);
          expect(r.status).toBe(429);
          expect(r.data).toMatchObject({ ok: false, code: 'rate_limited' });
          expect(Number(r.retryAfter)).toBeGreaterThanOrEqual(1);
        }
        expect(queries).toBe(0);
      } finally {
        db.query = origQuery;
      }

      // 3. 同一被限流的 NAT IP 上，冷态合法令牌（并发 20 次）全部 200 通过
      const burstValidOnBlockedIp = await Promise.all(
        Array.from({ length: 20 }, () => ciReq('198.51.100.10', `Bearer ${coldValid.token}`)),
      );
      expect(burstValidOnBlockedIp.every((r) => r.status === 200)).toBe(true);

      // 4. 全新未限流 IP 上并发 20 次合法令牌请求，也不会因预占临时触及 limit=4 而误报 429
      const burstValidOnFreshIp = await Promise.all(
        Array.from({ length: 20 }, () => ciReq('198.51.100.20', `Bearer ${coldValid.token}`)),
      );
      expect(burstValidOnFreshIp.every((r) => r.status === 200)).toBe(true);

      // 5. 不同 IP 互不影响：198.51.100.30 的首次无效令牌仍是 401 token_invalid
      const otherIp = await ciReq('198.51.100.30', `Bearer ${fakeToken(999)}`);
      expect(otherIp.status).toBe(401);
      expect(otherIp.data).toMatchObject({ ok: false, code: 'token_invalid' });
    } finally {
      await natApp.rooms.flush();
      await natApp.shadows.close();
    }
  });

  test('T2 三层“谁能创建令牌”与组条件自动只读可见性', async () => {
    // 原本 pipe 看不到这个项目（404）
    expect((await call('GET', `/api/projects/${pid}`, undefined, 'pipe')).status).toBe(404);
    expect((await call('GET', `/api/resolve/${groupSlug}/${projectSlug}`, undefined, 'pipe')).status).toBe(
      404,
    );

    // 组层设置：允许流水线组成员或项目管理员创建令牌
    const setGroup = await call(
      'PUT',
      `/api/groups/${groupSlug}/token-policy`,
      { rule: { roles: ['admin'], groups: [{ groupId: pipeGroupId, role: 'member' }] } },
      'ga',
    );
    expect(setGroup.status).toBe(200);

    // pipe 自动获得只读可见性（viewer），且 canListTokens = true，能创建和吊销自己的令牌，不能改模型 / 发布
    const info = await call('GET', `/api/projects/${pid}`, undefined, 'pipe');
    expect(info.status).toBe(200);
    expect(info.data as unknown as ProjectInfo).toMatchObject({ role: 'viewer', canListTokens: true });
    expect((await call('GET', `/api/resolve/${groupSlug}/${projectSlug}`, undefined, 'pipe')).status).toBe(
      200,
    );
    expect((await call('POST', `/api/projects/${pid}/versions`, { name: 'nope' }, 'pipe')).status).toBe(403);

    const pipeTok = await call('POST', `/api/projects/${pid}/tokens`, { name: 'pipe-token' }, 'pipe');
    expect(pipeTok.status).toBe(201);
    const tid = (pipeTok.data as unknown as CiTokenCreated).info.id;
    // 创建者本人可以吊销自己的令牌
    expect((await call('POST', `/api/projects/${pid}/tokens/${tid}/revoke`, {}, 'pipe')).status).toBe(200);

    // 实例层收紧为“仅流水线组管理员”：组层不能放宽实例层，pipe（普通成员）立刻失去创建权和自动可见性
    const setInst = await call(
      'PUT',
      '/api/admin/token-policy',
      { rule: { roles: [], groups: [{ groupId: pipeGroupId, role: 'admin' }] } },
      'admin',
    );
    expect(setInst.status).toBe(200);
    expect((await call('GET', `/api/projects/${pid}`, undefined, 'pipe')).status).toBe(404);

    // 项目层查看能看到 instance 和 group 两层锁定
    const pv = (await call('GET', `/api/projects/${pid}/token-policy`, undefined, 'ga'))
      .data as unknown as TokenPolicyView;
    expect(pv.upper.map((u) => u.layer)).toEqual(['instance', 'group']);
    expect(pv.names[pipeGroupId]).toBe('流水线组');

    // 引用不存在的组 → 422
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/token-policy`,
          { rule: { roles: [], groups: [{ groupId: 'no-such-group', role: 'member' }] } },
          'ga',
        )
      ).status,
    ).toBe(422);

    // 清理：删掉一个空组时顺便删它的 token_policies
    const tmp = await call('POST', '/api/groups', { slug: 'tmp-tok-g', name: '临时组' }, 'admin');
    expect(tmp.status).toBe(201);
    const tmpId = tmp.data.id as string;
    expect(
      (
        await call(
          'PUT',
          '/api/groups/tmp-tok-g/token-policy',
          { rule: { roles: ['admin'], groups: [] } },
          'admin',
        )
      ).status,
    ).toBe(200);
    expect((await call('DELETE', '/api/groups/tmp-tok-g', undefined, 'admin')).status).toBe(200);
    const left = await db.query("select 1 from token_policies where scope_kind = 'group' and scope_id = $1", [
      tmpId,
    ]);
    expect(left).toHaveLength(0);

    // 恢复实例层
    expect((await call('PUT', '/api/admin/token-policy', { rule: null }, 'admin')).status).toBe(200);
  });
});

describe.skipIf(!PG_URL)('CI 执行接口、错误码、审计通知与 GitHub Action（T3 / T4，目标库 PG）', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let server: ReturnType<typeof serve>;
  let baseUrl = '';
  let webhookServer: ReturnType<typeof createServer>;
  let webhookPort = 0;
  const receivedHooks: { event?: string; body: Record<string, unknown> }[] = [];
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];
  const groupSlug = 'ci-g';
  let groupId = '';

  const call = async (
    method: string,
    path: string,
    json?: unknown,
    who: string | null = 'admin',
    headers: Record<string, string> = {},
  ) => {
    const h: Record<string, string> = { ...headers };
    if (who) h.cookie = cookies[who]!;
    if (json !== undefined) h['content-type'] = 'application/json';
    const res = await created.app.request(path, {
      method,
      headers: h,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data: data as Record<string, unknown> };
  };

  const ciCall = (token: string, method: string, path: string, json?: unknown) =>
    call(method, path, json, null, { authorization: `Bearer ${token}` });

  const newProject = async (name: string) => {
    const p = await call('POST', '/api/projects', { name, groupId }, 'admin');
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    const slug = p.data.slug as string;
    expect(
      (
        await call('POST', `/api/projects/${pid}/grants`, {
          subjectKind: 'user',
          subjectId: ids.pa,
          role: 'admin',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call('POST', `/api/projects/${pid}/grants`, {
          subjectKind: 'user',
          subjectId: ids.editor,
          role: 'editor',
        })
      ).status,
    ).toBe(201);
    const tok = (await call('POST', `/api/projects/${pid}/tokens`, { name: 'deploy-bot' }, 'pa'))
      .data as unknown as CiTokenCreated;
    return { pid, slug, token: tok.token, tokenId: tok.info.id, tokenPrefix: tok.info.prefix };
  };

  const addRealEnv = async (pid: string, name: string, production = false) => {
    const target = await createTestDb(`ci_${name}`);
    targets.push(target);
    const e = await call('POST', `/api/projects/${pid}/environments`, {
      name,
      url: target.url,
      production,
      allowSameInstance: true,
    });
    expect(e.status, JSON.stringify(e.data)).toBe(201);
    return { eid: e.data.id as string, target };
  };

  const tableOf = (m: Model) => all(m, 'table').find((t) => t.name === 'orders')!.id;

  const publishChain = async (pid: string, n: number) => {
    const out: { id: string; number: number; name: string }[] = [];
    for (let i = 1; i <= n; i++) {
      if (i === 1) await addTable(created.rooms, db, pid);
      else
        await editModel(
          created.rooms,
          db,
          pid,
          (m) => void addColumn(m, tableOf(m), { name: `c${i}`, type: 'text' }),
        );
      const r = await call('POST', `/api/projects/${pid}/versions`, { name: `v${i}` });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      out.push(r.data as unknown as { id: string; number: number; name: string });
    }
    return out;
  };

  beforeAll(async () => {
    // 启动本地接收 Webhook 的 HTTP 服务
    webhookServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          receivedHooks.push({
            event: req.headers['x-dowel-event'] as string | undefined,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          });
        } catch {}
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => webhookServer.listen(0, '127.0.0.1', r));
    webhookPort = (webhookServer.address() as AddressInfo).port;

    db = await openPlatformDb(':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      webhooks: { retryBaseMs: 10 },
    });
    server = serve({ fetch: created.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await makeUser(db, 'admin', { name: '实例管理员', role: 'admin' });
    for (const n of ['pa', 'editor', 'approver']) ids[n] = (await makeUser(db, n, { name: n })).id;
    for (const n of ['admin', 'pa', 'editor', 'approver']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    // 放行 127.0.0.1 Webhook 出站
    expect(
      (await call('PATCH', '/api/admin/settings', { webhookAllowlist: ['127.0.0.1/32'] }, 'admin')).status,
    ).toBe(200);
    const g = await call(
      'POST',
      '/api/groups',
      { slug: groupSlug, name: 'CI 组', defaultRole: 'none' },
      'admin',
    );
    expect(g.status).toBe(201);
    groupId = g.data.id as string;
    // 配置组级 Webhook 订阅 token.executed
    const wh = await call(
      'POST',
      `/api/groups/${groupSlug}/webhooks`,
      {
        name: 'ci-hook',
        format: 'json',
        url: `http://127.0.0.1:${webhookPort}/hook`,
        events: ['token.executed'],
        enabled: true,
      },
      'admin',
    );
    expect(wh.status, JSON.stringify(wh.data)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => webhookServer.close(r));
    await db.close();
    if (!PG_URL) return;
    const adminConn = connect(PG_URL);
    for (const t of targets) {
      await adminConn.db
        .exec(`DROP DATABASE IF EXISTS ${new URL(t.url).pathname.slice(1)}_dowel WITH (FORCE)`)
        .catch(() => {});
      await t.close();
    }
    await adminConn.close();
  });

  const waitUntil = async (fn: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  test('只读接口、预演、执行、noop、生产默认拒绝与打开开关跳过审批、审计 + 收件箱 + Webhook', async () => {
    const p = await newProject('ci-main');
    const stg = await addRealEnv(p.pid, 'staging', false);
    const prod = await addRealEnv(p.pid, 'prod', true);
    const [v1, v2] = await publishChain(p.pid, 2);

    // 生产环境配上审批环节（验证令牌执行不走审批）
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${p.pid}/environments/${prod.eid}/exec-policy`,
          {
            settings: { approval: [{ approvers: { kind: 'project_admins' }, count: 1 }] },
          },
          'admin',
        )
      ).status,
    ).toBe(200);

    // 只读接口：项目与环境列表（纯平台配置，不含缓存的 currentVersion / drift）
    const projRes = await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}`);
    expect(projRes.status).toBe(200);
    const proj = ciProjectSchema.parse(projRes.data) as CiProject;
    expect(proj.latest).toMatchObject({ number: 2 });
    const stgCfg = proj.environments.find((e) => e.name === 'staging')!;
    const prodCfg = proj.environments.find((e) => e.name === 'prod')!;
    expect(stgCfg).toEqual({ name: 'staging', production: false, tokenExecution: true });
    expect(prodCfg).toEqual({ name: 'prod', production: true, tokenExecution: false });
    expect('currentVersion' in stgCfg).toBe(false);
    expect('drift' in stgCfg).toBe(false);

    const vers = (await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}/versions`))
      .data as unknown as CiVersion[];
    expect(vers.map((v) => v.number)).toEqual([1, 2]);

    // 预演：不触碰目标库
    const dry = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      {
        to: 'v1',
        dryRun: true,
      },
    );
    expect(dry.status, JSON.stringify(dry.data)).toBe(200);
    expect(dry.data as unknown as CiExecuteResult).toMatchObject({
      ok: true,
      dryRun: true,
      from: null,
      to: { number: 1 },
      reached: { number: 1 },
      noop: false,
    });
    expect((await stg.target.db.query("select 1 from pg_namespace where nspname = 'dowel'")).length).toBe(0);

    // 真实执行 staging 到 v1
    const run1 = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      {
        to: 'v1',
      },
    );
    expect(run1.status, JSON.stringify(run1.data)).toBe(200);
    expect(run1.data as unknown as CiExecuteResult).toMatchObject({
      ok: true,
      dryRun: false,
      from: null,
      to: { number: 1 },
      reached: { number: 1 },
      noop: false,
      migrations: [{ number: 1, direction: 'up' }],
    });

    // 重复执行到 v1 → noop
    const noop = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      {
        to: 'v1',
      },
    );
    expect(noop.status).toBe(200);
    expect(noop.data as unknown as CiExecuteResult).toMatchObject({ ok: true, noop: true, migrations: [] });

    // 环境实时状态（直连目标库读 dowel.history，不含缓存 drift）与目标库执行历史
    const stRes = await ciCall(
      p.token,
      'GET',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`,
    );
    expect(stRes.status).toBe(200);
    const st = ciEnvironmentStatusSchema.parse(stRes.data) as CiEnvironmentStatus;
    expect(st.currentVersion).toMatchObject({ number: 1 });
    expect(st.unfinished).toBe(false);
    expect(st.pending).toEqual([2]);
    expect('drift' in st).toBe(false);

    const hist = (
      await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/history`)
    ).data as unknown as CiHistory;
    expect(hist.currentVersion).toMatchObject({ number: 1 });
    expect(hist.runs[0]).toMatchObject({ via: 'ci', status: 'done', to: { number: 1 } });

    // 非生产执行不发站内收件箱通知
    const inboxBefore = (await call('GET', '/api/me/inbox', undefined, 'pa')).data as unknown as InboxList;
    expect(
      inboxBefore.items.filter((x) => x.kind === 'token_execution' && x.project?.id === p.pid),
    ).toHaveLength(0);

    // 生产默认拒绝：403 token_execution_disabled
    const prodDenied = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/prod/execute`,
      { to: 'v1' },
    );
    expect(prodDenied.status).toBe(403);
    expect(prodDenied.data as unknown as CiErrorBody).toMatchObject({
      ok: false,
      code: 'token_execution_disabled',
    });

    // 打开生产环境的“允许令牌执行”
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${p.pid}/environments/${prod.eid}/exec-policy`,
          {
            settings: {
              allowTokens: true,
              approval: [{ approvers: { kind: 'project_admins' }, count: 1 }],
            },
          },
          'admin',
        )
      ).status,
    ).toBe(200);

    // 先在 prod 上提交一个执行申请（v1），验证令牌执行后待处理申请失效
    const reqCreate = await call(
      'POST',
      `/api/projects/${p.pid}/environments/${prod.eid}/requests`,
      { kind: 'execute', to: v1!.id, reason: '等待上线' },
      'editor',
    );
    expect(reqCreate.status, JSON.stringify(reqCreate.data)).toBe(201);
    const reqId = reqCreate.data.id as string;

    // 令牌执行 prod 到 v1：跳过审批直接成功！
    const prodOk = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/prod/execute`,
      {
        to: 'v1',
      },
    );
    expect(prodOk.status, JSON.stringify(prodOk.data)).toBe(200);
    expect(prodOk.data as unknown as CiExecuteResult).toMatchObject({
      ok: true,
      reached: { number: 1 },
      noop: false,
    });

    // 待处理申请应自动失效
    let reqStatus = '';
    for (let i = 0; i < 40; i++) {
      const r = await call('GET', `/api/projects/${p.pid}/requests/${reqId}`, undefined, 'pa');
      reqStatus = r.data.status as string;
      if (reqStatus === 'invalid') break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(reqStatus).toBe('invalid');

    // 生产令牌执行通知：项目管理员 pa 收到 token_execution 收件箱条目
    const inboxAfter = (await call('GET', '/api/me/inbox', undefined, 'pa')).data as unknown as InboxList;
    const tokNotice = inboxAfter.items.find((x) => x.kind === 'token_execution' && x.project?.id === p.pid);
    expect(tokNotice).toBeTruthy();
    expect(tokNotice!.data).toMatchObject({ event: 'token_executed', params: { env: 'prod', to: 1 } });

    // Webhook 收到 token.executed
    await waitUntil(() =>
      receivedHooks.some((h) => h.event === 'token.executed' && h.body.type === 'token.executed'),
    );

    // 审计日志和项目动态都正确显示令牌操作者
    const auditRes = (
      await call('GET', `/api/admin/audit?action=environment.execute&actor=${p.tokenId}`, undefined, 'admin')
    ).data as unknown as AuditPage;
    expect(auditRes.events.length).toBeGreaterThanOrEqual(2);
    expect(auditRes.events[0]).toMatchObject({
      actorKind: 'token',
      actorId: p.tokenId,
      actorUsername: `deploy-bot (${p.tokenPrefix}…)`,
    });
    const actRes = (await call('GET', `/api/projects/${p.pid}/activity`, undefined, 'pa'))
      .data as unknown as ProjectActivity;
    expect(
      actRes.events.some((e) => e.action === 'environment.execute' && e.actorName?.includes('deploy-bot')),
    ).toBe(true);

    // staging 执行到 v2，再测试回滚被拒（409 rollback_not_allowed 带 details.current）
    expect(
      (
        await ciCall(
          p.token,
          'POST',
          `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
          {
            to: 'latest',
          },
        )
      ).status,
    ).toBe(200);
    const rb = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      {
        to: 'v1',
      },
    );
    expect(rb.status).toBe(409);
    expect(rb.data as unknown as CiErrorBody).toMatchObject({
      ok: false,
      code: 'rollback_not_allowed',
      details: { current: { number: 2 } },
    });
    expect(v2!.number).toBe(2);
  }, 120_000);

  test('错误码逐一覆盖：invalid_request / environment_not_found / version_not_found / drift / unverified / lock_timeout / execution_failed / target_unreachable / 锁内复查', async () => {
    const p = await newProject('ci-errors');
    const dev = await addRealEnv(p.pid, 'dev', false);
    const [v1, v2] = await publishChain(p.pid, 2);

    // 400 invalid_request
    const badReq = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      {
        to: 'bad-target',
      },
    );
    expect(badReq.status).toBe(400);
    expect(badReq.data).toMatchObject({ ok: false, code: 'invalid_request' });

    // 404 environment_not_found
    const noEnv = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/nope/execute`,
      {
        to: 'latest',
      },
    );
    expect(noEnv.status).toBe(404);
    expect(noEnv.data).toMatchObject({ ok: false, code: 'environment_not_found' });

    // 422 version_not_found
    const noVer = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      {
        to: 'v99',
      },
    );
    expect(noVer.status).toBe(422);
    expect(noVer.data).toMatchObject({ ok: false, code: 'version_not_found' });

    // 先执行到 v1
    expect(
      (
        await ciCall(p.token, 'POST', `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`, {
          to: 'v1',
        })
      ).status,
    ).toBe(200);

    // 409 drift：手工修改目标库表结构
    await dev.target.db.exec('ALTER TABLE public.orders ADD COLUMN sneaky_col int');
    const drifted = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      {
        to: 'v2',
      },
    );
    expect(drifted.status).toBe(409);
    expect(drifted.data as unknown as CiErrorBody).toMatchObject({ ok: false, code: 'drift' });
    expect((drifted.data as unknown as CiErrorBody).details?.diff?.length).toBeGreaterThan(0);
    // 复原漂移
    await dev.target.db.exec('ALTER TABLE public.orders DROP COLUMN sneaky_col');

    // 423 lock_timeout：另一个操作持环境锁时，lockTimeoutSeconds=0 立刻返回 423 lock_timeout
    const release = await created.exec.locks.acquire(dev.eid, 5000);
    try {
      const locked = await ciCall(
        p.token,
        'POST',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
        { to: 'v2', lockTimeoutSeconds: 0 },
      );
      expect(locked.status).toBe(423);
      expect(locked.data).toMatchObject({ ok: false, code: 'lock_timeout' });

      // 锁内复查（beforeConnect）：等锁期间环境关闭“允许令牌执行” → 拿到锁后立即拒绝，不写目标库
      const waiting = ciCall(
        p.token,
        'POST',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
        {
          to: 'v2',
          lockTimeoutSeconds: 5,
        },
      );
      await new Promise((r) => setTimeout(r, 150));
      expect(
        (
          await call(
            'PUT',
            `/api/projects/${p.pid}/environments/${dev.eid}/exec-policy`,
            { settings: { allowTokens: false } },
            'admin',
          )
        ).status,
      ).toBe(200);
      await release();
      const rechecked = await waiting;
      expect(rechecked.status).toBe(403);
      expect(rechecked.data).toMatchObject({ ok: false, code: 'token_execution_disabled' });
    } finally {
      await release();
    }
    // 重新打开 allowTokens
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${p.pid}/environments/${dev.eid}/exec-policy`,
          { settings: {} },
          'admin',
        )
      ).status,
    ).toBe(200);

    // 409 unverified：修改 v2 的冻结脚本使其变为未验证
    const v2Detail = (await call('GET', `/api/projects/${p.pid}/versions/${v2!.id}`, undefined, 'admin'))
      .data as unknown as VersionDetail;
    expect(
      (
        await call('PATCH', `/api/projects/${p.pid}/versions/${v2!.id}/steps`, {
          up: [{ sql: 'SELECT pg_sleep(2)', transactional: true }, ...v2Detail.upSteps],
          down: v2Detail.downSteps,
        })
      ).status,
    ).toBe(200);
    const unver = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      {
        to: 'v2',
      },
    );
    expect(unver.status).toBe(409);
    expect(unver.data).toMatchObject({ ok: false, code: 'unverified' });

    // 重新验证 v2，再设 statementTimeoutMs=300 → 422 execution_failed，reached 停在 v1！
    expect((await call('POST', `/api/projects/${p.pid}/versions/${v2!.id}/verify`)).status).toBe(200);
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${p.pid}/environments/${dev.eid}/exec-policy`,
          { settings: { statementTimeoutMs: 300 } },
          'admin',
        )
      ).status,
    ).toBe(200);
    const failed = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      {
        to: 'v2',
      },
    );
    expect(failed.status).toBe(422);
    expect(failed.data as unknown as CiErrorBody).toMatchObject({
      ok: false,
      code: 'execution_failed',
      reached: { number: 1 },
      details: { timeout: { kind: 'statement', ms: 300 } },
    });

    // 502 target_unreachable：连不上的目标库
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ($1, $2, 'dead', $3, false)`,
      [`${p.pid}-dead`, p.pid, encrypt('postgres://u:p@127.0.0.1:1/dead')],
    );
    const unreach = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dead/execute`,
      { to: 'v1' },
    );
    expect(unreach.status).toBe(502);
    expect(unreach.data).toMatchObject({ ok: false, code: 'target_unreachable' });
    expect(v1!.number).toBe(1);
  }, 120_000);

  test('CI 三接口拆分与零过期缓存：纯平台配置 / 实时环境状态 / 实时漂移检测', async () => {
    const p = await newProject('ci-split');
    const stg = await addRealEnv(p.pid, 'staging', false);
    await addRealEnv(p.pid, 'prod', true);
    // 加一个不可达环境，验证项目列表不连目标库
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ($1, $2, 'dead', $3, false)`,
      [`${p.pid}-dead`, p.pid, encrypt('postgres://u:p@127.0.0.1:1/dead')],
    );

    // 1. 项目还没有发布任何版本时：
    //    - GET /api/ci/projects/:owner/:project 返回纯平台配置（即使存在 dead 环境也 200）
    const proj0 = await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}`);
    expect(proj0.status).toBe(200);
    const parsedProj0 = ciProjectSchema.parse(proj0.data);
    expect(parsedProj0.latest).toBeNull();
    expect(parsedProj0.environments).toEqual([
      { name: 'dead', production: false, tokenExecution: true },
      { name: 'prod', production: true, tokenExecution: false },
      { name: 'staging', production: false, tokenExecution: true },
    ]);
    for (const e of proj0.data.environments as Record<string, unknown>[]) {
      expect('currentVersion' in e).toBe(false);
      expect('drift' in e).toBe(false);
    }

    //    - POST .../drift 无版本时返回 status = unknown
    const driftUnknownRes = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
    );
    expect(driftUnknownRes.status, JSON.stringify(driftUnknownRes.data)).toBe(200);
    const driftUnknown = ciDriftResultSchema.parse(driftUnknownRes.data) as CiDriftResult;
    expect(driftUnknown).toMatchObject({
      environment: 'staging',
      currentVersion: null,
      status: 'unknown',
      total: 0,
      items: [],
      unresolvable: [],
      firstRun: false,
      needsManual: null,
    });

    // 2. 发布 v1 / v2 并执行 staging 到 v1
    const [v1, v2] = await publishChain(p.pid, 2);
    expect(
      (
        await ciCall(
          p.token,
          'POST',
          `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
          {
            to: 'v1',
          },
        )
      ).status,
    ).toBe(200);

    // 故意把平台库缓存 current_version_id 清空，验证 GET .../environments/:env 实时读目标库而非过期缓存，并同步回平台库
    await db.query('update environments set current_version_id = null where id = $1', [stg.eid]);
    const liveStatusRes = await ciCall(
      p.token,
      'GET',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`,
    );
    expect(liveStatusRes.status, JSON.stringify(liveStatusRes.data)).toBe(200);
    const liveStatus = ciEnvironmentStatusSchema.parse(liveStatusRes.data) as CiEnvironmentStatus;
    expect(liveStatus).toMatchObject({
      name: 'staging',
      production: false,
      tokenExecution: true,
      currentVersion: { id: v1!.id, number: 1, name: 'v1' },
      unfinished: false,
      pending: [2],
    });
    expect(liveStatus.versions.map((v) => [v.number, v.state])).toEqual([
      [1, 'current'],
      [2, 'pending'],
    ]);
    expect('drift' in (liveStatusRes.data as Record<string, unknown>)).toBe(false);
    const [cachedEnv] = await db.query<{ current_version_id: string | null }>(
      'select current_version_id from environments where id = $1',
      [stg.eid],
    );
    expect(cachedEnv!.current_version_id).toBe(v1!.id);

    // 3. POST .../drift：无漂移返回 status = clean（包括 tokenExecution=false 的生产环境也可只读检测）
    const cleanStg = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
    );
    expect(cleanStg.status, JSON.stringify(cleanStg.data)).toBe(200);
    expect(ciDriftResultSchema.parse(cleanStg.data)).toMatchObject({
      environment: 'staging',
      currentVersion: { id: v1!.id, number: 1, name: 'v1' },
      status: 'clean',
      total: 0,
      items: [],
      unresolvable: [],
      firstRun: false,
      needsManual: null,
    });
    const cleanProd = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/prod/drift`,
    );
    expect(cleanProd.status, JSON.stringify(cleanProd.data)).toBe(200);
    expect(ciDriftResultSchema.parse(cleanProd.data)).toMatchObject({
      environment: 'prod',
      currentVersion: null,
      status: 'clean',
      total: 0,
    });

    // 4. 目标库手工改动后：POST .../drift 实时检出漂移、刷新平台缓存，并使待处理执行申请失效
    const reqCreate = await call(
      'POST',
      `/api/projects/${p.pid}/environments/${stg.eid}/requests`,
      { kind: 'execute', to: v2!.id, reason: '升 v2' },
      'editor',
    );
    expect(reqCreate.status, JSON.stringify(reqCreate.data)).toBe(201);
    const reqId = reqCreate.data.id as string;

    await stg.target.db.exec('ALTER TABLE public.orders ADD COLUMN ci_drift_col int');
    const driftedRes = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
    );
    expect(driftedRes.status, JSON.stringify(driftedRes.data)).toBe(200);
    const drifted = ciDriftResultSchema.parse(driftedRes.data) as CiDriftResult;
    expect(drifted).toMatchObject({
      environment: 'staging',
      currentVersion: { id: v1!.id, number: 1, name: 'v1' },
      status: 'drifted',
      firstRun: false,
      needsManual: null,
    });
    expect(drifted.total).toBeGreaterThan(0);
    expect(drifted.items.some((i) => i.sql.includes('ci_drift_col'))).toBe(true);
    expect(drifted.unresolvable).toEqual([]);
    const [driftRow] = await db.query<{ drift_status: string }>(
      'select drift_status from environments where id = $1',
      [stg.eid],
    );
    expect(driftRow!.drift_status).toBe('drifted');
    // 触发了 ctx.requests.kick：待处理申请应失效
    let reqStatus = '';
    for (let i = 0; i < 40; i++) {
      const r = await call('GET', `/api/projects/${p.pid}/requests/${reqId}`, undefined, 'pa');
      reqStatus = r.data.status as string;
      if (reqStatus === 'invalid') break;
      await new Promise((x) => setTimeout(x, 50));
    }
    expect(reqStatus).toBe('invalid');
    await stg.target.db.exec('ALTER TABLE public.orders DROP COLUMN ci_drift_col');

    // 5. 错误映射：
    //    - 不可达目标库：GET .../environments/dead 和 POST .../environments/dead/drift 均返回 502 target_unreachable
    const deadStatus = await ciCall(
      p.token,
      'GET',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dead`,
    );
    expect(deadStatus.status).toBe(502);
    expect(deadStatus.data).toMatchObject({ ok: false, code: 'target_unreachable' });
    const deadDrift = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dead/drift`,
    );
    expect(deadDrift.status).toBe(502);
    expect(deadDrift.data).toMatchObject({ ok: false, code: 'target_unreachable' });

    //    - 环境锁被占用：POST .../drift 返回 423 lock_timeout
    const release = await created.exec.locks.acquire(stg.eid, 5000);
    try {
      const busyDrift = await ciCall(
        p.token,
        'POST',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
      );
      expect(busyDrift.status).toBe(423);
      expect(busyDrift.data).toMatchObject({ ok: false, code: 'lock_timeout' });
    } finally {
      await release();
    }

    //    - 历史格式过新：GET .../environments/:env 和 POST .../drift 均返回 409 version_mismatch
    await stg.target.db.exec("UPDATE dowel.meta SET value = '999' WHERE key = 'format_version'");
    try {
      const tooNewStatus = await ciCall(
        p.token,
        'GET',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`,
      );
      expect(tooNewStatus.status).toBe(409);
      expect(tooNewStatus.data).toMatchObject({
        ok: false,
        code: 'version_mismatch',
        details: { reason: 'format_too_new' },
      });
      const tooNewDrift = await ciCall(
        p.token,
        'POST',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
      );
      expect(tooNewDrift.status).toBe(409);
      expect(tooNewDrift.data).toMatchObject({
        ok: false,
        code: 'version_mismatch',
        details: { reason: 'format_too_new' },
      });
    } finally {
      await stg.target.db.exec("UPDATE dowel.meta SET value = '1' WHERE key = 'format_version'");
    }

    // 6. connectionLimiter 限速：GET .../environments/:env 与 POST .../drift 均按 token:<id> 计入连接限速
    const limitedApp = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 2, windowMs: 60_000 }),
      tokenFailLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      tokenLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    try {
      const limCall = async (method: string, path: string) => {
        const res = await limitedApp.app.request(path, {
          method,
          headers: { authorization: `Bearer ${p.token}` },
        });
        return { status: res.status, data: (await res.json()) as Record<string, unknown> };
      };
      expect(
        (await limCall('GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`)).status,
      ).toBe(200);
      expect(
        (await limCall('POST', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`)).status,
      ).toBe(200);
      const third = await limCall('GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`);
      expect(third.status).toBe(429);
      expect(third.data).toMatchObject({ ok: false, code: 'rate_limited' });
      const fourth = await limCall(
        'POST',
        `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/drift`,
      );
      expect(fourth.status).toBe(429);
      expect(fourth.data).toMatchObject({ ok: false, code: 'rate_limited' });
      // 纯平台配置的 GET /api/ci/projects/:owner/:project 不受 connectionLimiter 约束
      expect((await limCall('GET', `/api/ci/projects/${groupSlug}/${p.slug}`)).status).toBe(200);
    } finally {
      await limitedApp.rooms.flush();
      await limitedApp.shadows.close();
    }
  }, 120_000);

  test('T4 GitHub Action 脚本（actions/execute/run.sh）：预演、执行、noop、失败退出码与 GITHUB_OUTPUT', async () => {
    const p = await newProject('ci-action');
    await addRealEnv(p.pid, 'staging', false);
    await addRealEnv(p.pid, 'prod', true);
    await publishChain(p.pid, 1);

    const dir = mkdtempSync(join(tmpdir(), 'dowel-action-'));
    const runAction = async (env: Record<string, string>) => {
      const outFile = join(dir, `out-${Math.random().toString(36).slice(2)}`);
      try {
        const res = await execFileAsync('bash', [ACTION_SCRIPT], {
          env: {
            PATH: process.env.PATH,
            GITHUB_OUTPUT: outFile,
            DOWEL_URL: baseUrl,
            DOWEL_TOKEN: p.token,
            DOWEL_PROJECT: `${groupSlug}/${p.slug}`,
            ...env,
          },
        });
        const outputs = parseGithubOutput(readFileSync(outFile, 'utf8'));
        return { code: 0, stdout: res.stdout, stderr: res.stderr, outputs };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        let outputs: Record<string, string> = {};
        try {
          outputs = parseGithubOutput(readFileSync(outFile, 'utf8'));
        } catch {}
        return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '', outputs };
      }
    };

    try {
      // 1. 预演成功
      const dry = await runAction({
        DOWEL_ENVIRONMENT: 'staging',
        DOWEL_TO: 'latest',
        DOWEL_DRY_RUN: 'true',
      });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.outputs).toMatchObject({ ok: 'true', reached: 'v1', noop: 'false', code: '' });

      // 2. 真实执行成功
      const exec1 = await runAction({ DOWEL_ENVIRONMENT: 'staging', DOWEL_TO: 'v1', DOWEL_DRY_RUN: 'false' });
      expect(exec1.code, exec1.stderr).toBe(0);
      expect(exec1.outputs).toMatchObject({ ok: 'true', reached: 'v1', noop: 'false' });

      // 3. 再次执行 → noop=true
      const exec2 = await runAction({ DOWEL_ENVIRONMENT: 'staging', DOWEL_TO: 'latest' });
      expect(exec2.code, exec2.stderr).toBe(0);
      expect(exec2.outputs).toMatchObject({ ok: 'true', reached: 'v1', noop: 'true' });

      // 4. 生产默认拒绝 → 退出码 1、打印 token_execution_disabled、不泄露令牌明文
      const denied = await runAction({
        DOWEL_ENVIRONMENT: 'prod',
        DOWEL_TO: 'v1',
        GITHUB_ACTIONS: 'true',
      });
      expect(denied.code).toBe(1);
      expect(denied.stdout).toContain('::error::[token_execution_disabled]');
      expect(denied.stdout + denied.stderr).not.toContain(p.token);
      expect(denied.outputs).toMatchObject({ ok: 'false', code: 'token_execution_disabled' });

      // 5. 非法输入（非法 to、前导零 lock-timeout、含换行/引号的 token、非 http URL）→ 退出码 1
      const bad = await runAction({ DOWEL_ENVIRONMENT: 'staging', DOWEL_TO: 'not-valid' });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('[invalid_input]');

      const badOctal = await runAction({
        DOWEL_ENVIRONMENT: 'staging',
        DOWEL_TO: 'latest',
        DOWEL_LOCK_TIMEOUT: '08',
      });
      expect(badOctal.code).toBe(1);
      expect(badOctal.stderr).toContain('[invalid_input]');

      const badTok = await runAction({
        DOWEL_ENVIRONMENT: 'staging',
        DOWEL_TO: 'latest',
        DOWEL_TOKEN: 'dwl_abc"\nurl = "http://evil',
      });
      expect(badTok.code).toBe(1);
      expect(badTok.stderr).toContain('[invalid_input]');

      const badUrl = await runAction({
        DOWEL_ENVIRONMENT: 'staging',
        DOWEL_TO: 'latest',
        DOWEL_URL: 'file:///etc/passwd',
      });
      expect(badUrl.code).toBe(1);
      expect(badUrl.stderr).toContain('[invalid_input]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('ADR 0013 CI 版本树：latest 解析到活跃头、状态四分类、version_retired 与 switch_requires_web（409）', async () => {
    const p = await newProject('ci-tree');
    const stg = await addRealEnv(p.pid, 'staging', false);
    const dev = await addRealEnv(p.pid, 'dev', false);
    const [v1, v2] = await publishChain(p.pid, 2);

    // stg 走到 v1，dev 走到 v2
    expect(
      (
        await ciCall(
          p.token,
          'POST',
          `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
          {
            to: 'v1',
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await ciCall(p.token, 'POST', `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`, {
          to: 'v2',
        })
      ).status,
    ).toBe(200);

    // 在 v1 下构造分叉活跃版本 v3（添加 main_c3），将 v2 标为已作废
    const [bRow] = await db.query<{ id: string }>('select id from branches where project_id = $1', [p.pid]);
    const [v1Row] = await db.query<{ model: Model }>('select model from versions where id = $1', [v1!.id]);
    const m1 = v1Row!.model;
    const m3 = structuredClone(m1);
    addColumn(m3, tableOf(m3), { name: 'main_c3', type: 'text' });
    const up3 = toScriptSteps(plan(m1, m3), 'pg');
    const down3 = toScriptSteps(plan(m3, m1), 'pg');
    const v3Id = newId();
    await db.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                             up_steps, down_steps, checksum, verified_at)
       values ($1, $2, $3, 2, 'v3', $4::text::jsonb, null, 3, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
      [
        v3Id,
        p.pid,
        bRow!.id,
        JSON.stringify(m3),
        v1!.id,
        JSON.stringify(up3),
        JSON.stringify(down3),
        stepsChecksum(up3, down3),
        new Date().toISOString(),
      ],
    );
    await db.query('update versions set retired_at = $2 where id = $1', [v2!.id, new Date().toISOString()]);

    // 1. GET /api/ci/projects/:o/:p 中的 latest 为活跃头 v3
    const projRes = await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}`);
    expect(projRes.status).toBe(200);
    expect((projRes.data as unknown as CiProject).latest).toMatchObject({ id: v3Id, number: 3 });

    // 2. stg 状态四分类与 pending：v1=current, v2=retired, v3=pending；dev：v1=applied, v2=current, v3=pending
    const stgStatus = ciEnvironmentStatusSchema.parse(
      (await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`)).data,
    );
    expect(stgStatus.versions.map((v) => [v.number, v.state])).toEqual([
      [1, 'current'],
      [2, 'retired'],
      [3, 'pending'],
    ]);
    expect(stgStatus.pending).toEqual([3]);

    const devStatus = ciEnvironmentStatusSchema.parse(
      (await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev`)).data,
    );
    expect(devStatus.versions.map((v) => [v.number, v.state])).toEqual([
      [1, 'applied'],
      [2, 'current'],
      [3, 'pending'],
    ]);
    expect(devStatus.pending).toEqual([3]);

    // 3. 显式传入已作废的 v2 → 409 version_retired
    const retiredRes = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      { to: 'v2' },
    );
    expect(retiredRes.status).toBe(409);
    expect(retiredRes.data).toMatchObject({ ok: false, code: 'version_retired' });

    // 4. dev 停在已作废 v2，尝试执行 latest（解析为 v3）→ 409 switch_requires_web，且返回 current 与 lca
    const switchRes = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/dev/execute`,
      { to: 'latest' },
    );
    expect(switchRes.status).toBe(409);
    expect(switchRes.data as unknown as CiErrorBody).toMatchObject({
      ok: false,
      code: 'switch_requires_web',
      details: {
        current: { id: v2!.id, number: 2 },
        lca: { id: v1!.id, number: 1 },
      },
    });

    // stg 正常用 latest 执行到活跃头 v3（不经由 v2）
    const stgUp = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging/execute`,
      { to: 'latest' },
    );
    expect(stgUp.status, JSON.stringify(stgUp.data)).toBe(200);
    expect(stgUp.data as unknown as CiExecuteResult).toMatchObject({
      ok: true,
      reached: { id: v3Id, number: 3 },
      migrations: [{ number: 3, direction: 'up' }],
    });
    expect(stg.target).toBeDefined();
    expect(dev.target).toBeDefined();
  }, 120_000);
});

/** 解析 GITHUB_OUTPUT（支持单行 key=value 和 heredoc key<<DELIM） */
const parseGithubOutput = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const h = /^([^=<]+)<<(.+)$/.exec(line);
    if (h) {
      const vals: string[] = [];
      for (i++; i < lines.length && lines[i] !== h[2]; i++) vals.push(lines[i]!);
      out[h[1]!] = vals.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
};
