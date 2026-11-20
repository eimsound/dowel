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
  type CiEnvironmentStatus,
  type CiErrorBody,
  type CiExecuteResult,
  type CiHistory,
  type CiProject,
  type CiTokenCreated,
  type CiTokenList,
  type CiTokenSelf,
  type CiVersion,
  effectiveTokenRules,
  type InboxList,
  type ProjectActivity,
  type ProjectInfo,
  TOKEN_PATTERN,
  type TokenPolicyView,
  tokenCreatorAllows,
  type VersionDetail,
} from '@dowel/api';
import { addColumn, all, type Model } from '@dowel/core';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { hashToken } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
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

  test('过期令牌立即返回 401 token_expired；缺失 / 非法头分别返回 token_missing / token_invalid；失败认证触发限速', async () => {
    const t = (await call('POST', `/api/projects/${pid}/tokens`, { name: '快过期' }, 'ga'))
      .data as unknown as CiTokenCreated;
    await db.query('update ci_tokens set expires_at = $2 where id = $1', [
      t.info.id,
      new Date(Date.now() - 1000).toISOString(),
    ]);

    // 用独立 X-Forwarded-For 或不依赖限速器的新 app 测限速（本测试 app 的 tokenFailLimiter = 3 次）
    // 先测同一个 app 下的失败分类与限速
    const r1 = await call('GET', '/api/ci/token', undefined, null, { authorization: `Bearer ${t.token}` });
    expect(r1.status).toBe(401);
    expect(r1.data).toMatchObject({ ok: false, code: 'token_expired' });

    const r2 = await call('GET', '/api/ci/token', undefined, null);
    expect(r2.status).toBe(401);
    expect(r2.data).toMatchObject({ ok: false, code: 'token_missing' });

    const r3 = await call('GET', '/api/ci/token', undefined, null, {
      authorization: 'Bearer not-a-dwl-token',
    });
    expect(r3.status).toBe(401);
    expect(r3.data).toMatchObject({ ok: false, code: 'token_invalid' });

    // 第 4 次被 IP 失败限速拦住（429 + Retry-After）
    const r4 = await call('GET', '/api/ci/token', undefined, null, { authorization: 'Bearer dwl_invalid' });
    expect(r4.status).toBe(429);
    expect(r4.data).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(Number(r4.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
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
            prerequisiteId: stg.eid,
          },
          'admin',
        )
      ).status,
    ).toBe(200);

    // 只读接口：项目概要 / 版本链 / 环境状态
    const projRes = await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}`);
    expect(projRes.status).toBe(200);
    const proj = projRes.data as unknown as CiProject;
    expect(proj.latest).toMatchObject({ number: 2 });
    expect(proj.environments.find((e) => e.name === 'staging')!.tokenExecution).toBe(true);
    expect(proj.environments.find((e) => e.name === 'prod')!.tokenExecution).toBe(false);

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

    // 环境状态与目标库执行历史
    const st = (await ciCall(p.token, 'GET', `/api/ci/projects/${groupSlug}/${p.slug}/environments/staging`))
      .data as unknown as CiEnvironmentStatus;
    expect(st.currentVersion).toMatchObject({ number: 1 });
    expect(st.pending).toEqual([2]);

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
            prerequisiteId: stg.eid,
          },
          'admin',
        )
      ).status,
    ).toBe(200);

    // prod 到 v2 被前置环境 staging（当前 v1）挡住：409 prerequisite_behind
    const preBehind = await ciCall(
      p.token,
      'POST',
      `/api/ci/projects/${groupSlug}/${p.slug}/environments/prod/execute`,
      { to: 'latest' },
    );
    expect(preBehind.status).toBe(409);
    expect(preBehind.data as unknown as CiErrorBody).toMatchObject({
      ok: false,
      code: 'prerequisite_behind',
      details: { prerequisite: { name: 'staging', currentNumber: 1 } },
    });

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
            { settings: { allowTokens: false }, prerequisiteId: null },
            'admin',
          )
        ).status,
      ).toBe(200);
      release();
      const rechecked = await waiting;
      expect(rechecked.status).toBe(403);
      expect(rechecked.data).toMatchObject({ ok: false, code: 'token_execution_disabled' });
    } finally {
      release();
    }
    // 重新打开 allowTokens
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${p.pid}/environments/${dev.eid}/exec-policy`,
          { settings: {}, prerequisiteId: null },
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
          { settings: { statementTimeoutMs: 300 }, prerequisiteId: null },
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
