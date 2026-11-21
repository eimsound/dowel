// 组与授权（产品化 P1b）：生效角色计算、可见性、授权管理、保护规则、转组、建组 / 建项目设置、
// 邀请加入组，以及 WebSocket 上的即时生效（降级为查看者、被移出组后断开）。
// 平台库在 SQLite 和 PostgreSQL 上各跑一遍（PG 需要 Docker）。
import type { AddressInfo } from 'node:net';

import { all } from '@dowel/core';
import { SyncClient, type ToClient } from '@dowel/sync';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { effectiveRole, type GrantRow, type ProjectRow, type RoleContext } from '../src/roles.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

// ───── 生效角色：纯函数、表驱动 ─────

const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 'p1',
  name: '项目',
  slug: 'p',
  dialect: 'pg',
  groupId: 'g1',
  groupSlug: 'g1',
  groupName: '组一',
  groupDefaultRole: 'editor',
  projectDefaultRole: null,
  branch: 'b1',
  createdAt: '2026-01-01T00:00:00.000Z',
  schemas: null,
  ...over,
});

const ctx = (over: Partial<RoleContext> = {}): RoleContext => ({
  userId: 'u1',
  instanceAdmin: false,
  groups: new Map(),
  grants: [],
  ...over,
});

const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
  subjectKind: 'user',
  subjectId: 'u1',
  role: 'viewer',
  scopeKind: 'project',
  scopeId: 'p1',
  ...over,
});

describe('生效角色（四种来源取最高）', () => {
  // [说明, 角色输入, 项目, 期望]
  const cases: [string, RoleContext, ProjectRow, string | null][] = [
    ['没有任何来源 → 看不见', ctx(), project(), null],
    ['实例管理员 → 项目管理员', ctx({ instanceAdmin: true }), project(), 'admin'],
    [
      '组管理员 → 项目管理员',
      ctx({ groups: new Map([['g1', 'admin']]) }),
      project({ groupDefaultRole: 'none' }),
      'admin',
    ],
    ['组成员 → 组默认权限', ctx({ groups: new Map([['g1', 'member']]) }), project(), 'editor'],
    [
      '组成员 + 项目默认权限是 none → 看不见',
      ctx({ groups: new Map([['g1', 'member']]) }),
      project({ projectDefaultRole: 'none' }),
      null,
    ],
    [
      '组成员 + 项目默认权限覆盖组默认权限',
      ctx({ groups: new Map([['g1', 'member']]) }),
      project({ projectDefaultRole: 'viewer' }),
      'viewer',
    ],
    ['项目授权（用户）', ctx({ grants: [grant({ role: 'viewer' })] }), project(), 'viewer'],
    [
      '项目授权（用户所在的组）',
      ctx({
        groups: new Map([['g2', 'member']]),
        grants: [grant({ subjectKind: 'group', subjectId: 'g2' })],
      }),
      project(),
      'viewer',
    ],
    [
      '组范围授权（用户所在的组）',
      ctx({
        groups: new Map([['g2', 'member']]),
        grants: [grant({ subjectKind: 'group', subjectId: 'g2', scopeKind: 'group', scopeId: 'g1' })],
      }),
      project(),
      'viewer',
    ],
    [
      '实例范围授权（用户）',
      ctx({ grants: [grant({ role: 'editor', scopeKind: 'instance', scopeId: '' })] }),
      project(),
      'editor',
    ],
    // 两两组合
    [
      '实例管理员 + 组管理员 → 项目管理员',
      ctx({ instanceAdmin: true, groups: new Map([['g1', 'admin']]) }),
      project(),
      'admin',
    ],
    [
      '组管理员 + 默认权限 viewer → 项目管理员（取高）',
      ctx({ groups: new Map([['g1', 'admin']]) }),
      project({ projectDefaultRole: 'viewer' }),
      'admin',
    ],
    [
      '组成员 viewer + 项目授权 editor → 编辑者',
      ctx({ groups: new Map([['g1', 'member']]), grants: [grant({ role: 'editor' })] }),
      project({ projectDefaultRole: 'viewer' }),
      'editor',
    ],
    [
      '组成员 editor + 组范围授权 viewer → 编辑者',
      ctx({
        groups: new Map([['g1', 'member']]),
        grants: [grant({ role: 'viewer', scopeKind: 'group', scopeId: 'g1' })],
      }),
      project(),
      'editor',
    ],
    [
      '实例授权 viewer + 项目授权 editor → 编辑者',
      ctx({
        grants: [
          grant({ role: 'viewer', scopeKind: 'instance', scopeId: '' }),
          grant({ role: 'editor', scopeKind: 'project', scopeId: 'p1' }),
        ],
      }),
      project(),
      'editor',
    ],
    [
      '项目授权给用户所在的另一个组 → 生效',
      ctx({
        groups: new Map([
          ['g1', 'member'],
          ['g2', 'member'],
        ]),
        grants: [grant({ subjectKind: 'group', subjectId: 'g2', role: 'admin' })],
      }),
      project(),
      'admin',
    ],
    [
      '授权给别的组 / 别的用户 → 不生效',
      ctx({ grants: [grant({ subjectKind: 'group', subjectId: 'g9', role: 'admin' })] }),
      project(),
      null,
    ],
    [
      '组范围授权的范围不是本项目所属的组 → 不生效',
      ctx({
        groups: new Map([['g1', 'member']]),
        grants: [grant({ role: 'admin', scopeKind: 'group', scopeId: 'g9' })],
      }),
      project({ groupDefaultRole: 'none' }),
      null,
    ],
  ];

  for (const [name, roleContext, row, expected] of cases)
    test(name, () => expect(effectiveRole(roleContext, row)).toBe(expected));
});

// ───── HTTP 集成测试 ─────

interface Agent {
  call: (method: string, path: string, json?: unknown) => Promise<{ status: number; data: any }>;
  cookie: () => string;
}

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('组与授权（平台库：$platform）', ({ platform, skip }) => {
  let platformDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let db: PlatformDb;
  let base: string;
  let close: () => Promise<void>;
  const sockets = new Set<WebSocket>();

  let appRooms: ReturnType<typeof createApp>['rooms'];
  let zhang: Awaited<ReturnType<typeof makeUser>>;
  let li: Awaited<ReturnType<typeof makeUser>>;
  let wang: Awaited<ReturnType<typeof makeUser>>;
  let adminAgent: Agent;
  let zhangAgent: Agent;
  let liAgent: Agent;
  let wangAgent: Agent;

  // 测试之间共享的数据
  let alphaId = '';
  const alphaSlug = 'alpha';
  let pShop = '';
  let betaId = '';
  let pBeta = '';
  let lockedId = '';
  let pLocked = '';

  const agent = (): Agent => {
    let cookie = '';
    return {
      cookie: () => cookie,
      call: async (method, path, json) => {
        const r = await fetch(base + path, {
          method,
          headers: { 'content-type': 'application/json', cookie },
          body: json === undefined ? undefined : JSON.stringify(json),
        });
        const set = r.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0]!;
        const text = await r.text();
        let data: unknown = text;
        try {
          data = JSON.parse(text);
        } catch {}
        return { status: r.status, data };
      },
    };
  };

  const login = async (a: Agent, username: string) => {
    expect((await a.call('POST', '/api/auth/login', { username, password: PASSWORD })).status).toBe(200);
  };

  const connect = async (a: Agent, pid: string, id: string) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pid}/sync`, {
      headers: { cookie: a.cookie() },
    });
    sockets.add(ws);
    const client = new SyncClient(id, { format: 1, dialect: 'pg', objects: {} });
    client.send = (m) => ws.send(JSON.stringify(m));
    const extras: unknown[] = [];
    ws.on('message', (d) => {
      const text = Buffer.isBuffer(d)
        ? d.toString('utf8')
        : Array.isArray(d)
          ? Buffer.concat(d).toString('utf8')
          : new TextDecoder().decode(d);
      const m = JSON.parse(text) as ToClient | { t: string };
      if (['welcome', 'snapshot', 'commit', 'reject'].includes(m.t)) client.receive(m as ToClient);
      else extras.push(m);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    client.connect();
    return { ws, client, extras };
  };

  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(async () => {
    if (skip) return;
    if (platform === 'pg') platformDb = await createTestDb('groups');
    db = await openPlatformDb(platformDb?.url ?? ':memory:');
    const { app, injectWebSocket, rooms, shadows } = createApp(db);
    appRooms = rooms;
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      await rooms.flush();
      await shadows.close();
      await new Promise((r) => server.close(r));
    };

    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    zhang = await makeUser(db, 'zhang', { name: '张三' });
    li = await makeUser(db, 'li', { name: '李四' });
    wang = await makeUser(db, 'wang', { name: '王五' });

    adminAgent = agent();
    zhangAgent = agent();
    liAgent = agent();
    wangAgent = agent();
    await login(adminAgent, 'admin');
    await login(zhangAgent, 'zhang');
    await login(liAgent, 'li');
    await login(wangAgent, 'wang');
  });

  afterAll(async () => {
    if (skip) return;
    await close();
    await db.close();
    await platformDb?.close();
  });

  test.skipIf(skip)('建组：默认所有用户都能建（建组人自动成为组管理员）；建项目必须指定组', async () => {
    expect((await liAgent.call('POST', '/api/groups', { slug: 'not-admin', name: '不行' })).status).toBe(201);
    // 清理，避免影响后面的组列表断言
    expect((await liAgent.call('DELETE', '/api/groups/not-admin')).status).toBe(200);

    const g = await zhangAgent.call('POST', '/api/groups', { slug: alphaSlug, name: 'Alpha 组' });
    expect(g.status).toBe(201);
    alphaId = g.data.id;
    expect(g.data.role).toBe('admin');

    const list = await zhangAgent.call('GET', '/api/groups');
    expect(list.status).toBe(200);
    expect(list.data.canCreate).toBe(true);
    expect(list.data.groups.find((x: { slug: string }) => x.slug === alphaSlug)).toMatchObject({
      slug: alphaSlug,
      role: 'admin',
      memberCount: 1,
      projectCount: 0,
      defaultRole: 'editor',
      projectCreation: 'members',
    });

    // 不指定组的建项目请求不合法
    expect((await zhangAgent.call('POST', '/api/projects', { name: '无组' })).status).toBe(400);

    const p = await zhangAgent.call('POST', '/api/projects', { name: 'Shop', groupId: alphaId });
    expect(p.status).toBe(201);
    pShop = p.data.id;
    expect(p.data).toMatchObject({ name: 'Shop', slug: 'shop', role: 'admin', group: { id: alphaId } });

    // 不是组成员：看不到组里的项目，也不能建项目
    expect((await wangAgent.call('GET', `/api/projects/${pShop}`)).status).toBe(404);
    expect((await wangAgent.call('POST', '/api/projects', { name: 'X', groupId: alphaId })).status).toBe(403);

    // 组名、组成员对所有已登录用户可见
    expect((await wangAgent.call('GET', `/api/groups/${alphaSlug}`)).status).toBe(200);
    expect((await wangAgent.call('GET', `/api/groups/${alphaSlug}/members`)).status).toBe(200);
    // 但不是组管理员：不能改组、不能管成员
    expect((await wangAgent.call('PATCH', `/api/groups/${alphaSlug}`, { name: '改名' })).status).toBe(403);
    expect((await wangAgent.call('GET', `/api/groups/${alphaSlug}/projects`)).data).toEqual([]);

    // project_creation=admins：组成员也不能建项目，组管理员可以
    const beta = await zhangAgent.call('POST', '/api/groups', {
      slug: 'beta',
      name: 'Beta 组',
      projectCreation: 'admins',
    });
    expect(beta.status).toBe(201);
    betaId = beta.data.id;
    expect((await zhangAgent.call('POST', '/api/groups/beta/members', { username: 'li' })).status).toBe(200);
    expect((await liAgent.call('POST', '/api/projects', { name: 'Beta 项目', groupId: betaId })).status).toBe(
      403,
    );
    const pb = await zhangAgent.call('POST', '/api/projects', { name: 'Beta Shop', groupId: betaId });
    expect(pb.status).toBe(201);
    pBeta = pb.data.id;
    // li 是 Beta 的成员：默认权限是编辑者
    expect((await liAgent.call('GET', `/api/projects/${pBeta}`)).data.role).toBe('editor');
  });

  test.skipIf(skip)('看不见的项目：列表、搜索、解析、每种项目接口都是 404', async () => {
    const paths: [string, string, unknown?][] = [
      ['GET', `/api/projects/${pShop}`],
      ['PATCH', `/api/projects/${pShop}`, { name: '偷改' }],
      ['POST', `/api/projects/${pShop}/transfer`, { groupId: betaId }],
      ['GET', `/api/projects/${pShop}/versions`],
      ['POST', `/api/projects/${pShop}/versions`, { name: 'v' }],
      ['GET', `/api/projects/${pShop}/migration?from=empty`],
      ['GET', `/api/projects/${pShop}/ddl`],
      ['POST', `/api/projects/${pShop}/verify`, {}],
      ['POST', `/api/projects/${pShop}/import`, { sql: 'create table x (a int)' }],
      ['GET', `/api/projects/${pShop}/environments`],
      ['POST', `/api/projects/${pShop}/environments/nope/test`],
      ['GET', `/api/projects/${pShop}/grants`],
      ['POST', `/api/projects/${pShop}/grants`, { subjectKind: 'user', subjectId: wang.id, role: 'admin' }],
      ['DELETE', `/api/projects/${pShop}/grants/nope`],
    ];
    for (const [method, path, body] of paths)
      expect((await wangAgent.call(method, path, body)).status, `${method} ${path}`).toBe(404);

    expect((await wangAgent.call('GET', '/api/projects')).data).toEqual([]);
    expect((await wangAgent.call('GET', `/api/groups/${alphaSlug}/projects`)).data).toEqual([]);
    expect((await wangAgent.call('GET', `/api/resolve/${alphaSlug}/shop`)).status).toBe(404);
    expect((await wangAgent.call('GET', '/api/resolve/nope/nope')).status).toBe(404);
    // 组接口本身可见，但成员列表 / 授权也只暴露“能看的人”
    expect((await wangAgent.call('GET', `/api/groups/${alphaSlug}/grants`)).status).toBe(200);

    // WebSocket：看不到项目时 4401
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pShop}/sync`, {
      headers: { cookie: wangAgent.cookie() },
    });
    sockets.add(ws);
    const code = await new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });

  test.skipIf(skip)('项目级授权：增删改、谁能管、来自组默认权限的成员', async () => {
    // 创建者自动有 admin 授权；Beta 的默认成员里能看到 li（默认权限是编辑者）
    const initial = await zhangAgent.call('GET', `/api/projects/${pBeta}/grants`);
    expect(initial.status).toBe(200);
    expect(initial.data.grants).toHaveLength(1);
    expect(initial.data.grants[0]).toMatchObject({
      subject: { kind: 'user', id: zhang.id, slug: 'zhang' },
      role: 'admin',
    });
    expect(initial.data.defaultMembers).toEqual(
      expect.arrayContaining([
        { userId: zhang.id, username: 'zhang', name: '张三', role: 'admin', groupAdmin: true },
        { userId: li.id, username: 'li', name: '李四', role: 'editor', groupAdmin: false },
      ]),
    );

    // 授权给王五（查看者）
    const created = await zhangAgent.call('POST', `/api/projects/${pShop}/grants`, {
      subjectKind: 'user',
      subjectId: wang.id,
      role: 'viewer',
    });
    expect(created.status).toBe(201);
    expect((await wangAgent.call('GET', `/api/projects/${pShop}`)).data.role).toBe('viewer');
    // 查看者够看不够改
    expect((await wangAgent.call('POST', `/api/projects/${pShop}/versions`, { name: 'v' })).status).toBe(403);
    expect((await wangAgent.call('PATCH', `/api/projects/${pShop}`, { name: 'x' })).status).toBe(403);

    // 同一个对象重复授权 → 409；对象不存在 → 404
    expect(
      (
        await zhangAgent.call('POST', `/api/projects/${pShop}/grants`, {
          subjectKind: 'user',
          subjectId: wang.id,
          role: 'editor',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await zhangAgent.call('POST', `/api/projects/${pShop}/grants`, {
          subjectKind: 'user',
          subjectId: 'nope',
          role: 'editor',
        })
      ).status,
    ).toBe(404);

    // 改角色：查看者 → 编辑者，可以发布版本了
    expect(
      (await zhangAgent.call('PATCH', `/api/projects/${pShop}/grants/${created.data.id}`, { role: 'editor' }))
        .status,
    ).toBe(200);
    await addTable(appRooms, db, pShop);
    expect((await wangAgent.call('POST', `/api/projects/${pShop}/versions`, { name: 'v1' })).status).toBe(
      201,
    );

    // 组级授权：授给 Beta 组，li（Beta 的成员）能看到了；他是编辑者，不能管授权
    const groupGrant = await zhangAgent.call('POST', `/api/projects/${pShop}/grants`, {
      subjectKind: 'group',
      subjectId: betaId,
      role: 'editor',
    });
    expect(groupGrant.status).toBe(201);
    expect(groupGrant.data.subject).toMatchObject({ kind: 'group', id: betaId, slug: 'beta' });
    expect((await liAgent.call('GET', `/api/projects/${pShop}`)).data.role).toBe('editor');
    expect(
      (
        await liAgent.call('POST', `/api/projects/${pShop}/grants`, {
          subjectKind: 'user',
          subjectId: li.id,
          role: 'admin',
        })
      ).status,
    ).toBe(403);
    expect(
      (await liAgent.call('PATCH', `/api/projects/${pShop}/grants/${groupGrant.data.id}`, { role: 'viewer' }))
        .status,
    ).toBe(403);
    expect((await liAgent.call('DELETE', `/api/projects/${pShop}/grants/${groupGrant.data.id}`)).status).toBe(
      403,
    );

    // 授权属于别的项目时不能借 id 操作
    expect(
      (await zhangAgent.call('DELETE', `/api/projects/${pBeta}/grants/${groupGrant.data.id}`)).status,
    ).toBe(404);

    // 删掉王五的授权：又看不到了
    const wangGrant = (await zhangAgent.call('GET', `/api/projects/${pShop}/grants`)).data.grants.find(
      (x: { subject: { id: string } }) => x.subject.id === wang.id,
    );
    expect((await zhangAgent.call('DELETE', `/api/projects/${pShop}/grants/${wangGrant.id}`)).status).toBe(
      200,
    );
    expect((await wangAgent.call('GET', `/api/projects/${pShop}`)).status).toBe(404);
  });

  test.skipIf(skip)('最后一个组管理员 / 最后一个项目管理员', async () => {
    // 组里只有一个组管理员（张三）：不能把自己移出或降级
    expect((await zhangAgent.call('DELETE', `/api/groups/${alphaSlug}/members/${zhang.id}`)).status).toBe(
      409,
    );
    expect(
      (await zhangAgent.call('PATCH', `/api/groups/${alphaSlug}/members/${zhang.id}`, { role: 'member' }))
        .status,
    ).toBe(409);
    // 实例管理员不受这条限制
    expect((await adminAgent.call('DELETE', `/api/groups/${alphaSlug}/members/${zhang.id}`)).status).toBe(
      200,
    );
    // 还原：把张三加回 Alpha
    expect(
      (
        await adminAgent.call('POST', `/api/groups/${alphaSlug}/members`, {
          username: 'zhang',
          role: 'admin',
        })
      ).status,
    ).toBe(200);

    // 造一个“只靠项目授权当管理员”的项目：直接改库把组管理员降为成员（接口有保护，正常走不到这里）
    const locked = await zhangAgent.call('POST', '/api/groups', {
      slug: 'locked',
      name: 'Locked',
      defaultRole: 'none',
    });
    lockedId = locked.data.id;
    const pl = await zhangAgent.call('POST', '/api/projects', { name: 'Locked 项目', groupId: lockedId });
    pLocked = pl.data.id;
    const adminGrant = (await zhangAgent.call('GET', `/api/projects/${pLocked}/grants`)).data.grants[0];
    await db.query("update group_members set role = 'member' where group_id = $1 and user_id = $2", [
      lockedId,
      zhang.id,
    ]);
    expect((await zhangAgent.call('GET', `/api/projects/${pLocked}`)).data.role).toBe('admin');
    // 实例管理员不算项目管理员（否则这条保护永远不会触发）：删掉 / 降级唯一的 admin 授权会被拒绝
    expect((await zhangAgent.call('DELETE', `/api/projects/${pLocked}/grants/${adminGrant.id}`)).status).toBe(
      409,
    );
    expect(
      (
        await zhangAgent.call('PATCH', `/api/projects/${pLocked}/grants/${adminGrant.id}`, {
          role: 'viewer',
        })
      ).status,
    ).toBe(409);
    expect((await zhangAgent.call('GET', `/api/projects/${pLocked}`)).data.role).toBe('admin');
  });

  test.skipIf(skip)('转组：两边组管理员、slug 冲突、旧路径跳转', async () => {
    const gamma = await zhangAgent.call('POST', '/api/groups', { slug: 'gamma', name: 'Gamma 组' });
    expect(gamma.status).toBe(201);
    const gammaId = gamma.data.id;
    expect((await zhangAgent.call('POST', '/api/groups/gamma/members', { username: 'li' })).status).toBe(200);
    expect(
      (await zhangAgent.call('POST', '/api/projects', { name: 'Dent', groupId: gammaId, slug: 'dent' }))
        .status,
    ).toBe(201);

    // 张三同时是 Alpha 和 Gamma 的组管理员：可以转
    expect(
      (await zhangAgent.call('POST', `/api/projects/${pShop}/transfer`, { groupId: gammaId })).status,
    ).toBe(200);
    // 旧路径还能解析，但会告诉前端新地址
    const old = await zhangAgent.call('GET', `/api/resolve/${alphaSlug}/shop`);
    expect(old.status).toBe(200);
    expect(old.data).toMatchObject({ id: pShop, owner: 'gamma', slug: 'shop', redirected: true });
    // 新路径
    expect((await zhangAgent.call('GET', '/api/resolve/gamma/shop')).data).toMatchObject({
      redirected: false,
    });
    // 授权还在（项目本身的授权跟着项目走）
    expect((await wangAgent.call('GET', `/api/projects/${pShop}`)).status).toBe(404);

    // 目标组里已经有相同的 slug → 409
    const dup = await zhangAgent.call('POST', '/api/projects', {
      name: 'Dent2',
      groupId: alphaId,
      slug: 'dent',
    });
    expect(dup.status).toBe(201);
    expect(
      (await zhangAgent.call('POST', `/api/projects/${dup.data.id}/transfer`, { groupId: gammaId })).status,
    ).toBe(409);

    // 李四只是 Gamma 的成员：不能转组
    const gammaProjects = (await zhangAgent.call('GET', '/api/groups/gamma/projects')).data;
    const dent = gammaProjects.find((x: { slug: string }) => x.slug === 'dent');
    expect(
      (await liAgent.call('POST', `/api/projects/${dent.id}/transfer`, { groupId: alphaId })).status,
    ).toBe(403);
    // 转到同一个组没有意义
    expect(
      (await zhangAgent.call('POST', `/api/projects/${dent.id}/transfer`, { groupId: gammaId })).status,
    ).toBe(422);
  });

  test.skipIf(skip)('有项目的组不能删；空组可以删', async () => {
    expect((await adminAgent.call('DELETE', '/api/groups/locked')).status).toBe(409);
    expect((await zhangAgent.call('DELETE', '/api/groups/gamma')).status).toBe(409);

    const temp = await zhangAgent.call('POST', '/api/groups', { slug: 'temp', name: '临时组' });
    expect(temp.status).toBe(201);
    expect((await zhangAgent.call('DELETE', '/api/groups/temp')).status).toBe(200);
    expect((await zhangAgent.call('GET', '/api/groups/temp')).status).toBe(404);
    // 不是组管理员不能删
    const solo = await zhangAgent.call('POST', '/api/groups', { slug: 'solo', name: 'Solo' });
    expect(solo.status).toBe(201);
    expect((await wangAgent.call('DELETE', '/api/groups/solo')).status).toBe(403);
  });

  test.skipIf(skip)('group_creation=admin：只有实例管理员能建组', async () => {
    expect((await adminAgent.call('PATCH', '/api/admin/settings', { groupCreation: 'admin' })).status).toBe(
      200,
    );
    expect((await zhangAgent.call('POST', '/api/groups', { slug: 'nope', name: '不行' })).status).toBe(403);
    expect((await zhangAgent.call('GET', '/api/groups')).data.canCreate).toBe(false);
    expect((await adminAgent.call('GET', '/api/groups')).data.canCreate).toBe(true);
    const byAdmin = await adminAgent.call('POST', '/api/groups', { slug: 'by-admin', name: '管理员建的组' });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.data.role).toBe('admin');
    expect((await adminAgent.call('PATCH', '/api/admin/settings', { groupCreation: 'all' })).status).toBe(
      200,
    );
  });

  test.skipIf(skip)('邀请加入组：接受后成为组成员；不存在的组跳过', async () => {
    const inv = await adminAgent.call('POST', '/api/admin/invites', {
      groupIds: [betaId, 'no-such-group'],
    });
    expect(inv.status).toBe(201);
    const accepted = await agent().call('POST', `/api/invites/${inv.data.token}/accept`, {
      username: 'newbie',
      name: '新人',
      password: PASSWORD,
    });
    expect(accepted.status).toBe(200);

    const newbie = agent();
    await login(newbie, 'newbie');
    const groups = (await newbie.call('GET', '/api/groups')).data.groups;
    expect(groups.find((g: { slug: string }) => g.slug === 'beta')).toMatchObject({ role: 'member' });
    expect((await newbie.call('GET', `/api/projects/${pBeta}`)).data.role).toBe('editor');
  });

  test.skipIf(skip)('即时生效：降为查看者后只读，被移出组后断开', async () => {
    const w = await connect(liAgent, pBeta, 'tab-li-beta');
    await until(() => w.client.ready);
    await until(() => all(w.client.view, 'schema').length > 0);

    // Beta 的默认权限改成查看者：在线连接收到 role 消息
    expect((await zhangAgent.call('PATCH', `/api/projects/${pBeta}`, { defaultRole: 'viewer' })).status).toBe(
      200,
    );
    await until(() =>
      w.extras.some(
        (m) => (m as { t: string; role?: string }).t === 'role' && (m as { role?: string }).role === 'viewer',
      ),
    );
    // 修改被拒绝
    const schema = all(w.client.view, 'schema')[0]!.id;
    w.client.mutate('createTable', { id: 't-li-1', schema, name: 'readonly_probe' });
    await until(() => w.client.notices.length > 0);
    expect(w.client.notices[0]!.message).toContain('查看者');

    // 移出组：没有权限了，连接被 4403 断开
    const closed = new Promise<number>((resolve) => w.ws.once('close', (code) => resolve(code)));
    expect((await zhangAgent.call('DELETE', `/api/groups/beta/members/${li.id}`)).status).toBe(200);
    expect(await closed).toBe(4403);
    expect((await liAgent.call('GET', `/api/projects/${pBeta}`)).status).toBe(404);
  });

  test.skipIf(skip)('即时生效：授权升级后恢复可编辑', async () => {
    // 王五通过项目授权拿到查看者
    const wangGrant = await zhangAgent.call('POST', `/api/projects/${pBeta}/grants`, {
      subjectKind: 'user',
      subjectId: wang.id,
      role: 'viewer',
    });
    expect(wangGrant.status).toBe(201);
    const w = await connect(wangAgent, pBeta, 'tab-wang-beta');
    await until(() => w.client.ready);
    await until(() => all(w.client.view, 'schema').length > 0);

    // 升级为编辑者
    expect(
      (
        await zhangAgent.call('PATCH', `/api/projects/${pBeta}/grants/${wangGrant.data.id}`, {
          role: 'editor',
        })
      ).status,
    ).toBe(200);
    await until(() =>
      w.extras.some(
        (m) => (m as { t: string; role?: string }).t === 'role' && (m as { role?: string }).role === 'editor',
      ),
    );
    const schema = all(w.client.view, 'schema')[0]!.id;
    w.client.mutate('createTable', { id: 't-wang-1', schema, name: 'editable_probe' });
    await until(() => w.client.view.objects['t-wang-1'] !== undefined);
    w.ws.close();
  });

  test.skipIf(skip)('即时生效：组作为授权对象，移出组 / 删除组都会刷新所有已加载房间', async () => {
    // wart 组是授权对象，host 组里有一个项目：王五通过 wart 的组授权看到项目
    const grantor = await zhangAgent.call('POST', '/api/groups', { slug: 'grantor', name: 'Grantor' });
    expect(grantor.status).toBe(201);
    expect((await zhangAgent.call('POST', '/api/groups/grantor/members', { username: 'wang' })).status).toBe(
      200,
    );
    const host = await zhangAgent.call('POST', '/api/groups', { slug: 'host', name: 'Host' });
    expect(host.status).toBe(201);
    const hosted = await zhangAgent.call('POST', '/api/projects', {
      name: 'Hosted',
      groupId: host.data.id,
    });
    expect(hosted.status).toBe(201);
    expect(
      (
        await zhangAgent.call('POST', `/api/projects/${hosted.data.id}/grants`, {
          subjectKind: 'group',
          subjectId: grantor.data.id,
          role: 'editor',
        })
      ).status,
    ).toBe(201);
    expect((await wangAgent.call('GET', `/api/projects/${hosted.data.id}`)).data.role).toBe('editor');

    // 移出 Grantor：这个组授权不再适用于王五 → 在线连接被踢
    const w1 = await connect(wangAgent, hosted.data.id, 'tab-wang-grantor');
    await until(() => w1.client.ready);
    const closed1 = new Promise<number>((resolve) => w1.ws.once('close', (code) => resolve(code)));
    expect((await zhangAgent.call('DELETE', `/api/groups/grantor/members/${wang.id}`)).status).toBe(200);
    expect(await closed1).toBe(4403);
    expect((await wangAgent.call('GET', `/api/projects/${hosted.data.id}`)).status).toBe(404);

    // 加回去、再连一次；把 Grantor 整组删掉（授权作为对象也会被清掉）→ 同样被踢
    expect((await zhangAgent.call('POST', '/api/groups/grantor/members', { username: 'wang' })).status).toBe(
      200,
    );
    const w2 = await connect(wangAgent, hosted.data.id, 'tab-wang-grantor-2');
    await until(() => w2.client.ready);
    const closed2 = new Promise<number>((resolve) => w2.ws.once('close', (code) => resolve(code)));
    expect((await zhangAgent.call('DELETE', '/api/groups/grantor')).status).toBe(200);
    expect(await closed2).toBe(4403);
    expect((await wangAgent.call('GET', `/api/projects/${hosted.data.id}`)).status).toBe(404);
  });

  test.skipIf(skip)('转组：并发转组撞上唯一约束时返回 409（不是 500）', async () => {
    const ra = await zhangAgent.call('POST', '/api/groups', { slug: 'race-a', name: 'Race A' });
    const rb = await zhangAgent.call('POST', '/api/groups', { slug: 'race-b', name: 'Race B' });
    const rt = await zhangAgent.call('POST', '/api/groups', { slug: 'race-t', name: 'Race T' });
    const pa = await zhangAgent.call('POST', '/api/projects', {
      name: 'Race A',
      groupId: ra.data.id,
      slug: 'dup',
    });
    const pb = await zhangAgent.call('POST', '/api/projects', {
      name: 'Race B',
      groupId: rb.data.id,
      slug: 'dup',
    });
    expect(pa.status).toBe(201);
    expect(pb.status).toBe(201);
    // 两个项目同时转到同一个组：预检查可能都通过，最终由唯一约束兜底
    const results = await Promise.all([
      zhangAgent.call('POST', `/api/projects/${pa.data.id}/transfer`, { groupId: rt.data.id }),
      zhangAgent.call('POST', `/api/projects/${pb.data.id}/transfer`, { groupId: rt.data.id }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });
});
