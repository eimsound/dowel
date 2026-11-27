// 服务端集成测试：真实的 HTTP + WebSocket，两个用户协作。平台库在 SQLite 和 PostgreSQL 上各跑一遍。
// 需要 PG 的部分（PG 平台库、影子库验证、导入）在没有 Docker 时跳过（见 test/pg-container.ts）。
import type { AddressInfo } from 'node:net';

import { all, type Model } from '@dowel/core';
import { SyncClient, type ToClient } from '@dowel/sync';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createTestDb, dbUrl, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { connectPg } from '../src/targets.ts';
import { makeUser, PASSWORD, stubPassingShadow } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';
let db: PlatformDb;
let base: string;
let close: () => Promise<void>;
let appShadows: ReturnType<typeof createApp>['shadows'];
const sockets = new Set<WebSocket>();

const start = async () => {
  const { app, injectWebSocket, rooms, shadows } = createApp(db);
  appShadows = shadows;
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
};

/** 带 cookie 的简易 HTTP 客户端 */
const agent = () => {
  let cookie = '';
  const call = async (method: string, path: string, json?: unknown) => {
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
    return { status: r.status, data: data as Record<string, unknown> & unknown[] };
  };
  return { call, cookie: () => cookie };
};

/** 通过 WebSocket 连上项目的同步房间 */
const connect = async (a: ReturnType<typeof agent>, pid: string, id: string) => {
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
  await new Promise((r) => ws.once('open', r));
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

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('服务端（平台库：$platform）', ({ platform, skip }) => {
  let platformDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  beforeAll(async () => {
    if (skip) return;
    if (platform === 'pg') platformDb = await createTestDb('platform');
    db = await openPlatformDb(platformDb?.url ?? ':memory:');
    await start();
  });
  afterAll(async () => {
    if (skip) return;
    await close();
    await db.close();
    await platformDb?.close();
  });
  const zhang = agent();
  const li = agent();
  let pid = '';

  test.skipIf(skip)('登录、建项目、邀请成员', async () => {
    // 公开注册已取消：测试里直接写库建一个实例管理员，其余用户由他创建
    await makeUser(db, 'zhang', { name: '张三', role: 'admin' });
    expect(
      (await zhang.call('POST', '/api/admin/users', { username: 'li', name: '李四', password: 'password2' }))
        .status,
    ).toBe(401);
    expect(
      (await zhang.call('POST', '/api/auth/login', { username: 'zhang', password: PASSWORD })).status,
    ).toBe(200);
    expect(
      (await zhang.call('POST', '/api/admin/users', { username: 'li', name: '李四', password: 'password2' }))
        .status,
    ).toBe(201);
    expect(
      (await zhang.call('POST', '/api/admin/users', { username: 'li', name: '李四', password: 'password2' }))
        .status,
    ).toBe(409);
    expect(
      (await li.call('POST', '/api/auth/login', { username: 'li', password: 'wrong-pass' })).status,
    ).toBe(401);
    expect((await li.call('POST', '/api/auth/login', { username: 'li', password: 'password2' })).status).toBe(
      200,
    );
    expect(
      (await li.call('POST', '/api/me/password', { oldPassword: 'password2', newPassword: 'password2-new' }))
        .status,
    ).toBe(200);
    // 建组 → 建项目（项目必须属于一个组）；李四先不是组成员，看不到项目
    const group = await zhang.call('POST', '/api/groups', { slug: 'shop', name: '商城组' });
    expect(group.status).toBe(201);
    const gid = group.data.id as string;
    const p = await zhang.call('POST', '/api/projects', { name: '商城', groupId: gid });
    expect(p.status).toBe(201);
    pid = p.data.id as string;
    expect((await li.call('GET', `/api/projects/${pid}`)).status).toBe(404);
    // 加进组：默认权限是编辑者
    expect(
      (await zhang.call('POST', '/api/groups/shop/members', { username: 'li', role: 'member' })).status,
    ).toBe(200);
    expect((await li.call('GET', `/api/projects/${pid}`)).data.role).toBe('editor');
    expect((await fetch(`${base}/api/projects`)).status).toBe(401);
  });

  test.skipIf(skip)('两人实时协作，冲突时后到者被拒绝', async () => {
    const a = await connect(zhang, pid, 'tab-zhang');
    const b = await connect(li, pid, 'tab-li');
    await until(() => a.client.ready && b.client.ready);
    const schema = all(a.client.view, 'schema')[0]!.id;
    a.client.mutate('createTable', { id: 't1', schema, name: 'users' });
    a.client.mutate('addColumn', {
      table: 't1',
      column: { id: 'c1', name: 'id', type: 'bigint', notNull: true },
    });
    a.client.mutate('addColumn', { table: 't1', column: { id: 'c2', name: 'email', type: 'text' } });
    a.client.mutate('addPrimaryKey', { id: 'pk', table: 't1', columns: ['c1'] });
    await until(() => b.client.view.objects.pk !== undefined);
    expect(b.client.view.objects.pk!.name).toBe('users_pkey');

    // 张三把 email 改名后，李四的页面已经刷新：用旧列名保存 CHECK 在本地就被拦下，不发给服务器
    // （服务器端“先到先得”拒绝的路径由 packages/sync 的单元测试覆盖）
    a.client.mutate('renameColumn', { id: 'c2', name: 'mail' });
    await until(() => b.client.view.objects.c2?.name === 'mail');
    expect(() => b.client.mutate('addCheck', { id: 'k1', table: 't1', expr: "email LIKE '%@%'" })).toThrow(
      '表达式引用了不存在的列：email',
    );

    // 布局和在线状态
    a.ws.send(JSON.stringify({ t: 'layout', positions: { t1: { x: 10, y: 20 } } }));
    await until(() =>
      b.extras.some((m) => (m as { t: string }).t === 'layout' && JSON.stringify(m).includes('"x":10')),
    );
    a.ws.close();
    b.ws.close();
  });

  let v1 = '';

  test.skipIf(skip)('版本、迁移脚本、导出 DDL；没有环境时验证和导入直接报错（不用任何兜底）', async () => {
    // 发布必须经影子库验证（ADR 0017）：还没有环境，这一次发布用影子库替身
    const restore = stubPassingShadow(appShadows);
    const r1 = await zhang.call('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    restore();
    expect(r1.status).toBe(201);
    v1 = r1.data.id as string;
    const mig = await zhang.call('GET', `/api/projects/${pid}/migration?from=empty&to=${v1}`);
    const sqls = (mig.data.up as unknown as { sql: string }[]).map((s) => s.sql);
    expect(sqls.some((s) => s.startsWith('CREATE TABLE public.users'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('CREATE SCHEMA'))).toBe(false); // 空库本来就有 public

    const ddl = await zhang.call('GET', `/api/projects/${pid}/ddl`);
    expect(String(ddl.data)).toContain('CONSTRAINT users_pkey PRIMARY KEY (id)');

    for (const [path, body] of [
      ['verify', { from: v1, to: 'head' }],
      ['import', { sql: 'create table t (a int)' }],
    ] as const) {
      const r = await zhang.call('POST', `/api/projects/${pid}/${path}`, body);
      expect(r.status).toBe(422);
      expect(String(r.data.error)).toContain('项目还没有配置环境');
    }
  });

  test.skipIf(skip || !PG_URL)('配置环境后：闭环验证与风险分析、导入 DDL（同实例影子库）', async () => {
    const target = `server_test_${platform}`;
    const admin = connectPg(PG_URL);
    for (const d of [target, `${target}_dowel`])
      await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.db.exec(`CREATE DATABASE ${target}`);
    await admin.close();
    const env = await zhang.call('POST', `/api/projects/${pid}/environments`, {
      name: 'dev',
      url: dbUrl(target),
      production: false,
    });
    expect(env.status).toBe(201);

    // 加一个 CHECK、改列类型，验证迁移并看风险
    const a = await connect(zhang, pid, 'tab-zhang-2');
    await until(() => a.client.ready && a.client.seq > 0);
    a.client.mutate('addCheck', { id: 'k2', table: 't1', expr: "(mail <> '')" });
    a.client.mutate('setColumnType', { id: 'c1', type: 'integer', typeRef: null });
    await until(() => a.client.pending.length === 0);
    a.ws.close();
    const r = await zhang.call('POST', `/api/projects/${pid}/verify`, { from: v1, to: 'head' });
    const report = r.data as unknown as {
      ok: boolean;
      shadow: string;
      up: { sql: string }[];
      risks: { level: string; rewrites: string[]; scans: string[] }[];
    };
    expect(report.ok).toBe(true);
    expect(report.shadow).toBe(`dev：${target}_dowel`);
    const i = report.up.findIndex((s) => s.sql.includes('TYPE integer'));
    expect(report.risks[i]!.level).toBe('high'); // bigint → integer 重写整表
    expect(report.risks[i]!.rewrites).toEqual(['public.users']);
    const j = report.up.findIndex((s) => s.sql.includes('CHECK'));
    expect(report.risks[j]!.scans).toEqual(['public.users']); // 加 CHECK 全表扫描

    const imp = await li.call('POST', `/api/projects/${pid}/import`, {
      sql: `create type mood as enum ('ok', 'sad');
            create table orders (id serial primary key, m mood default 'ok', note text check (length(note) < 100));
            create view recent as select id from orders;`,
    });
    expect(imp.status).toBe(200);
    const bad = await li.call('POST', `/api/projects/${pid}/import`, {
      sql: 'create table x (a nosuchtype)',
    });
    expect(bad.status).toBe(422);
    expect(String(bad.data.error)).toContain('nosuchtype');
  });

  test.skipIf(skip)('重启服务后数据仍在（房间从快照 + 操作日志重新加载）', async () => {
    const before = await connect(zhang, pid, 'tab-zhang-3');
    await until(() => before.client.ready && all(before.client.view, 'table').length > 0);
    const m: Model = structuredClone(before.client.view);
    before.ws.close();
    await close();
    await start();
    const after = await connect(zhang, pid, 'tab-zhang-4');
    await until(() => after.client.ready && all(after.client.view, 'table').length > 0);
    expect(after.client.view).toEqual(m);
    after.ws.close();
  });

  test.skipIf(skip)('只读成员的修改被拒绝', async () => {
    const wang = agent();
    expect(
      (
        await zhang.call('POST', '/api/admin/users', {
          username: 'wang',
          name: '王五',
          password: 'password3',
        })
      ).status,
    ).toBe(201);
    expect(
      (await wang.call('POST', '/api/auth/login', { username: 'wang', password: 'password3' })).status,
    ).toBe(200);
    expect(
      (
        await wang.call('POST', '/api/me/password', {
          oldPassword: 'password3',
          newPassword: 'password3-new',
        })
      ).status,
    ).toBe(200);
    // 组外的人用项目级授权给查看者
    const [wangUser] = await db.query<{ id: string }>("select id from users where username = 'wang'");
    expect(
      (
        await zhang.call('POST', `/api/projects/${pid}/grants`, {
          subjectKind: 'user',
          subjectId: wangUser!.id,
          role: 'viewer',
        })
      ).status,
    ).toBe(201);
    const w = await connect(wang, pid, 'tab-wang');
    await until(() => w.client.ready && all(w.client.view, 'table').length > 0);
    const t = all(w.client.view, 'table')[0]!;
    w.client.mutate('renameTable', { id: t.id, name: 'x' });
    await until(() => w.client.notices.length > 0);
    expect(w.client.notices[0]!.message).toContain('查看者');
    expect((await wang.call('POST', `/api/projects/${pid}/versions`, { name: 'v' })).status).toBe(403);
    w.ws.close();
  });

  test.skipIf(skip)('停用用户：会话立即 401，WebSocket 被断开', async () => {
    const li2 = agent();
    const created = await zhang.call('POST', '/api/admin/users', {
      username: 'li2',
      name: '李四二',
      password: 'password4',
    });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect(
      (await li2.call('POST', '/api/auth/login', { username: 'li2', password: 'password4' })).status,
    ).toBe(200);
    expect(
      (
        await li2.call('POST', '/api/me/password', {
          oldPassword: 'password4',
          newPassword: 'password4-new',
        })
      ).status,
    ).toBe(200);
    await zhang.call('POST', `/api/projects/${pid}/grants`, {
      subjectKind: 'user',
      subjectId: id,
      role: 'viewer',
    });

    const w = await connect(li2, pid, 'tab-li2');
    await until(() => w.client.ready && all(w.client.view, 'table').length > 0);
    const closed = new Promise<number>((resolve) => w.ws.once('close', (code) => resolve(code)));

    expect((await zhang.call('PATCH', `/api/admin/users/${id}`, { status: 'disabled' })).status).toBe(200);
    // 服务端主动断开：4403（不是 4401 权限不足），之后 HTTP 也拿不到任何东西
    expect(await closed).toBe(4403);
    expect((await li2.call('GET', '/api/projects')).status).toBe(401);
    expect(
      (await li2.call('POST', '/api/auth/login', { username: 'li2', password: 'password4-new' })).status,
    ).toBe(403);
  });

  test.skipIf(skip)('临时密码 / 管理员重置密码：WS 升级返回 403 且在线连接立即被 4403 踢出', async () => {
    const zhao = agent();
    const created = await zhang.call('POST', '/api/admin/users', {
      username: 'zhao',
      name: '赵六',
      password: 'temp-password-6',
    });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect(
      (await zhang.call('POST', '/api/groups/shop/members', { username: 'zhao', role: 'member' })).status,
    ).toBe(200);

    const firstLogin = await zhao.call('POST', '/api/auth/login', {
      username: 'zhao',
      password: 'temp-password-6',
    });
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.data.mustChangePassword).toBe(true);

    const wsUrl = `${base.replace('http', 'ws')}/api/projects/${pid}/sync`;
    const blockedStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { cookie: zhao.cookie() } });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on('error', () => resolve(-1));
    });
    expect(blockedStatus).toBe(403);

    expect(
      (
        await zhao.call('POST', '/api/me/password', {
          oldPassword: 'temp-password-6',
          newPassword: 'zhao-active-pw',
        })
      ).status,
    ).toBe(200);

    const w = await connect(zhao, pid, 'tab-zhao');
    await until(() => w.client.ready && all(w.client.view, 'table').length > 0);
    const closed = new Promise<number>((resolve) => w.ws.once('close', (code) => resolve(code)));

    const reset = await zhang.call('POST', `/api/admin/users/${id}/reset-password`, {});
    expect(reset.status).toBe(200);
    expect(reset.data.mustChangePassword).toBe(true);
    const tempPw = reset.data.password as string;
    expect(await closed).toBe(4403);
    expect((await zhao.call('GET', '/api/projects')).status).toBe(401);

    const relogin = await zhao.call('POST', '/api/auth/login', { username: 'zhao', password: tempPw });
    expect(relogin.status).toBe(200);
    expect(relogin.data.mustChangePassword).toBe(true);
    const blockedAgain = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { cookie: zhao.cookie() } });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on('error', () => resolve(-1));
    });
    expect(blockedAgain).toBe(403);

    expect(
      (
        await zhao.call('POST', '/api/me/password', {
          oldPassword: tempPw,
          newPassword: 'zhao-recovered-pw',
        })
      ).status,
    ).toBe(200);
    const recovered = await connect(zhao, pid, 'tab-zhao-2');
    await until(() => recovered.client.ready && all(recovered.client.view, 'table').length > 0);
    recovered.ws.close();
  });
});
