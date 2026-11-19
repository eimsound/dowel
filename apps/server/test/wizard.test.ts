// P3 新建项目向导：连接检查（含 SSRF 白名单、限速、只读账号）、schema 范围过滤、三条创建路径、
// 失败时不留残留、自动发布 v0 基线，以及“只读账号导入后目标库结构完全不变”。
// 用测试 PG 实例（Testcontainers 或 DOWEL_TEST_PG，见 test/pg-container.ts），没有 Docker 时跳过。
import type { AddressInfo } from 'node:net';
import {
  BASELINE_VERSION_NAME,
  type ProjectCreated,
  type VersionDetail,
  type VersionInfo,
  type WizardEvent,
} from '@dowel/api';
import { addColumn, all } from '@dowel/core';
import { diffSnapshots, readSnapshot, stepsChecksum } from '@dowel/engines';
import { serve } from '@hono/node-server';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { dbUrl, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import { SecretError } from '../src/secrets.ts';
import { connectPg, SHADOW_MARK } from '../src/targets.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

// 基线验证出错时的行为：用 mock 让影子库的 verifyScripts 抛指定的错误；created 记下最近一次新建的影子库
const hook = vi.hoisted(() => ({
  /** prepareShadow 被调用的次数（准备影子库可能建 {库名}_dowel、拿检查锁） */
  prepareCalls: 0,
  verifyError: null as unknown,
  /** 让 verifyScripts 返回这份报告（模拟“冻结的 up 在影子库里验证失败”） */
  verifyResult: null as unknown,
  created: null as { targetUrl: string; name: string } | null,
}));
vi.mock('../src/shadows.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/shadows.ts')>();
  return {
    ...real,
    prepareShadow: async (...args: Parameters<typeof real.prepareShadow>) => {
      hook.prepareCalls++;
      const r = await real.prepareShadow(...args);
      hook.created = r.created;
      if (!hook.verifyError && !hook.verifyResult) return r;
      return {
        ...r,
        shadow: {
          ...r.shadow,
          verifyScripts: async () => {
            if (hook.verifyResult) return hook.verifyResult;
            throw hook.verifyError;
          },
        },
      };
    },
  };
});

const ADMIN = PG_URL;
process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

/** 带测试账号密码的连接串（用来验证错误信息里没有密码） */
const withCredentials = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

const RO_USER = 'dowel_ro';
const RO_PASSWORD = 'ro-pass-should-not-leak';

describe.runIf(ADMIN)('新建项目向导', () => {
  const admin = ADMIN ? connectPg(ADMIN) : (null as never);
  let base = '';
  let cookie = '';
  let stop: () => Promise<void>;
  let pdb: PlatformDb;
  let appRooms: ReturnType<typeof createApp>['rooms'];
  /** 有 a、b、dowel 三个 schema 的库（dowel 里有 Dowel 的历史表 meta） */
  let multiUrl = '';
  /** 只有 schema a 的库，用一个只有 CONNECT + USAGE + SELECT 的角色连 */
  let roUrl = '';
  let roAdminUrl = '';
  /** 空库，作环境（SQL 导入需要影子库） */
  let emptyUrl = '';
  let groupId = '';

  const SHADOW_DBS = [
    'wizard_multi_dowel',
    'wizard_empty_dowel',
    'wizard_cleanup_dowel',
    'wizard_abort_dowel',
    'wizard_instance_dowel',
    'wizard_audit_dowel',
  ];
  const DBS = [
    'wizard_multi',
    'wizard_ro',
    'wizard_empty',
    'wizard_cleanup',
    'wizard_abort',
    'wizard_instance',
    'wizard_audit',
    'wizard_scope',
    'wizard_citext',
    'wizard_dirty',
    'wizard_limit',
  ];

  beforeAll(async () => {
    for (const d of [...DBS, ...SHADOW_DBS]) await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    for (const d of DBS) await admin.db.exec(`CREATE DATABASE ${d}`);

    const multi = connectPg(dbUrl('wizard_multi'));
    await multi.db.exec(`
      create schema a;
      create schema b;
      create table a.t1 (id int primary key);
      create table b.t2 (id int primary key);
      create schema dowel;
      create table dowel.meta (version int, checksum text, model text);
      create table dowel.other (id int);`);
    await multi.close();

    const ro = connectPg(dbUrl('wizard_ro'));
    await ro.db.exec(`
      create schema a;
      create table a.t (id int primary key, note text);
      create index on a.t (note);`);
    await ro.close();

    // 只读账号：只能 CONNECT + USAGE + SELECT，不能建库、不能建 schema
    await admin.db.exec(`
      drop role if exists ${RO_USER};
      create role ${RO_USER} login password '${RO_PASSWORD}';`);
    // 授权要在目标库里执行：`grant usage on schema a` 里的 a 是当前库的 schema
    const roGrant = connectPg(dbUrl('wizard_ro'));
    await roGrant.db.exec(`
      grant connect on database wizard_ro to ${RO_USER};
      grant usage on schema a to ${RO_USER};
      grant select on all tables in schema a to ${RO_USER};`);
    await roGrant.close();

    // 范围自洽：app.orders 的外键指向 public.users，audit 是另一个 schema
    const scopeDb = connectPg(dbUrl('wizard_scope'));
    await scopeDb.db.exec(`
      create schema app;
      create schema audit;
      create table public.users (id int primary key, email text);
      create table audit.events (id int primary key);
      create table app.orders (
        id int primary key,
        user_id int references public.users (id),
        note text);
      create view app.user_emails as select id, email from public.users;`);
    await scopeDb.close();

    // 扩展提供的类型：citext 装在 public，app.t 的列用了它
    const citext = connectPg(dbUrl('wizard_citext'));
    await citext.db.exec(`
      create extension citext;
      create schema app;
      create table app.t (id int primary key, name citext);`);
    await citext.close();

    // 非空、没有 Dowel 标记的库：不能作影子库
    const dirty = connectPg(dbUrl('wizard_dirty'));
    await dirty.db.exec('create table important (id int)');
    await dirty.close();

    multiUrl = dbUrl('wizard_multi');
    roAdminUrl = dbUrl('wizard_ro');
    roUrl = withCredentials(roAdminUrl, RO_USER, RO_PASSWORD);
    emptyUrl = dbUrl('wizard_empty');

    pdb = await openPlatformDb(':memory:');
    // 主实例把限速放宽（下面有专门的用例用独立实例测限速）
    const { app, injectWebSocket, rooms, shadows } = createApp(pdb, {
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    appRooms = rooms;
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = async () => {
      await rooms.flush();
      await shadows.close();
      (server as import('node:http').Server).closeAllConnections();
      await new Promise((r) => server.close(r));
      await pdb.close();
    };
    // 实例管理员改实例设置（白名单）；limited 只是做限速计数，outsider 什么都不属于
    await makeUser(pdb, 'zhang', { name: '张三', role: 'admin' });
    await makeUser(pdb, 'outsider', { name: '路人' });
    await makeUser(pdb, 'limited', { name: '限速', role: 'admin' });
    await makeUser(pdb, 'wizard-limit', { name: '向导限速', role: 'admin' });
    cookie = await login('zhang');
    const g = await call('POST', '/api/groups', { slug: 'wizard', name: '向导测试' }, cookie);
    groupId = (g.data as { id: string }).id;
  });

  afterAll(async () => {
    await stop?.();
    for (const d of [...DBS, ...SHADOW_DBS]) await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.db.exec(`drop role if exists ${RO_USER}`);
    await admin.close();
  });

  const call = async (method: string, path: string, json?: unknown, ck = cookie) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: ck },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: r.status, data };
  };

  const login = async (username: string) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status).toBe(200);
    return r.headers.get('set-cookie')!.split(';')[0]!;
  };

  /** 读 SSE：每条消息的 data 是 JSON */
  const wizard = async (body: unknown, ck = cookie) => {
    const r = await fetch(`${base}/api/projects/wizard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.headers.get('content-type')?.includes('text/event-stream'))
      return { status: r.status, events: [] as WizardEvent[], data: JSON.parse(text) };
    const events = text
      .split('\n\n')
      .filter((x) => x.trim())
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as WizardEvent);
    return { status: r.status, events, data: {} as Record<string, unknown> };
  };

  const stages = (events: WizardEvent[]) => events.map((e) => e.stage);
  const projectOf = (events: WizardEvent[]) => events.at(-1)?.project as ProjectCreated;

  // ───── N1 连接检查 ─────

  test('连接检查返回权限与 schema 列表（排除系统 schema 和 dowel）', async () => {
    const r = await call('POST', '/api/connection-check', { url: multiUrl, groupId });
    expect(r.status).toBe(200);
    const data = r.data as unknown as {
      versionNum: number;
      currentUser: string;
      superuser: boolean;
      canCreateDb: boolean;
      canCreateSchema: boolean;
      schemas: { name: string; tables: number }[];
      dowelSchema: boolean;
      dowelMeta: boolean;
    };
    expect(data.versionNum).toBeGreaterThanOrEqual(180000);
    expect(data.currentUser).toBe(new URL(multiUrl).username);
    expect(data.superuser).toBe(true);
    expect(data.canCreateDb).toBe(true);
    expect(data.canCreateSchema).toBe(true);
    // a、b 有表，public 是空库自带的；dowel 不在列表里（它在接口里单独报告）
    expect(data.schemas).toEqual([
      { name: 'a', tables: 1 },
      { name: 'b', tables: 1 },
      { name: 'public', tables: 0 },
    ]);
    expect(data.dowelSchema).toBe(true);
    expect(data.dowelMeta).toBe(true);
  });

  test('只有 CONNECT + USAGE + SELECT 的账号：不能建 schema，也不能建库', async () => {
    const r = await call('POST', '/api/connection-check', { url: roUrl, groupId });
    expect(r.status).toBe(200);
    const data = r.data as unknown as {
      canCreateSchema: boolean;
      canCreateDb: boolean;
      superuser: boolean;
      schemas: { name: string; tables: number }[];
      dowelSchema: boolean;
      dowelMeta: boolean;
    };
    expect(data.superuser).toBe(false);
    expect(data.canCreateDb).toBe(false);
    expect(data.canCreateSchema).toBe(false);
    expect(data.schemas).toEqual([
      { name: 'a', tables: 1 },
      { name: 'public', tables: 0 },
    ]);
    expect(data.dowelSchema).toBe(false);
    expect(data.dowelMeta).toBe(false);
  });

  test('白名单：不在列表里的地址被拒绝，列表里的 IP / 主机名放行', async () => {
    const host = new URL(dbUrl('wizard_multi')).hostname;
    expect(
      (await call('PATCH', '/api/admin/settings', { connectionAllowlist: ['10.255.255.0/24'] })).status,
    ).toBe(200);
    const denied = await call('POST', '/api/connection-check', { url: multiUrl, groupId });
    expect(denied.status).toBe(422);
    expect(denied.data.error as string).toContain('不在实例允许的范围内');

    // 主机名和它解析出来的 IP 都认
    await call('PATCH', '/api/admin/settings', { connectionAllowlist: [host] });
    expect((await call('POST', '/api/connection-check', { url: multiUrl, groupId })).status).toBe(200);
    await call('PATCH', '/api/admin/settings', { connectionAllowlist: ['127.0.0.0/8', '::1/128'] });
    expect((await call('POST', '/api/connection-check', { url: multiUrl, groupId })).status).toBe(200);
    // 写错的白名单项在保存时就拒绝，免得以后谁都连不上
    const bad = await call('PATCH', '/api/admin/settings', { connectionAllowlist: ['10.0.0.0/77'] });
    expect(bad.status).toBe(422);
    await call('PATCH', '/api/admin/settings', { connectionAllowlist: [] });
  });

  test('连接串只能在 URL 里给主机：?host= / ?hostaddr= / unix socket 一律 422', async () => {
    // 收紧白名单后，?host= 覆盖 authority 就能绕过它 —— 必须直接拒绝
    await call('PATCH', '/api/admin/settings', {
      connectionAllowlist: ['127.0.0.0/8', '::1/128'],
    });
    const host = new URL(multiUrl).hostname;
    const port = new URL(multiUrl).port;
    const db = new URL(multiUrl).pathname;
    for (const url of [
      `${multiUrl}?host=169.254.169.254`,
      `postgres://u:p@${host}:${port}${db}?hostaddr=169.254.169.254`,
      `postgres://u:p@${host}:${port}${db}?host=/var/run/postgresql`,
      'postgres:///db?host=%2Fvar%2Frun%2Fpostgresql',
      `postgres://u:p@%2Fvar%2Frun%2Fpostgresql/${db.replace(/^\//, '')}`,
    ]) {
      const r = await call('POST', '/api/connection-check', { url, groupId });
      expect(r.status, url).toBe(422);
      expect(r.data.error as string, url).not.toContain('169.254.169.254 不在');
      expect(r.data.error as string, url).toMatch(/host|hostaddr|unix socket/);
    }

    // 多主机：每一个都要检查，混进一个不允许的就整条拒绝
    const allowed = new URL(multiUrl);
    const multi = `postgres://${allowed.username}:${allowed.password}@${host}:${port},169.254.169.254:5432${db}`;
    const r = await call('POST', '/api/connection-check', { url: multi, groupId });
    expect(r.status).toBe(422);
    expect(r.data.error as string).toContain('169.254.169.254');
    await call('PATCH', '/api/admin/settings', { connectionAllowlist: [] });
  });

  test('错误信息里没有密码', async () => {
    const wrong = withCredentials(roAdminUrl, RO_USER, RO_PASSWORD);
    // 换一个不存在的密码：连接失败，错误里不能出现密码本身
    const u = new URL(wrong);
    u.password = 'definitely-wrong-pass';
    const r = await call('POST', '/api/connection-check', { url: u.toString(), groupId });
    expect(r.status).toBe(422);
    const message = r.data.error as string;
    expect(message).toContain('连接失败');
    expect(message).not.toContain('definitely-wrong-pass');
    expect(message).not.toContain(u.toString());
  });

  test('没有建项目权限的用户：403', async () => {
    const outsider = await login('outsider');
    const r = await call('POST', '/api/connection-check', { url: multiUrl, groupId }, outsider);
    expect(r.status).toBe(403);
  });

  test('限速：每个用户每分钟 10 次', async () => {
    // 默认限额是 10（主实例把限额放宽了，这里用默认设置另起一个）
    const { app, rooms, shadows } = createApp(pdb);
    const ck = await login('limited');
    const check = async () =>
      app.request('/api/connection-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ck },
        body: JSON.stringify({ url: 'postgres://127.0.0.1:1/nothing', groupId }),
      });
    for (let i = 0; i < 10; i++) expect((await check()).status).toBe(422);
    const blocked = await check();
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: string }).error).toContain('检查太频繁');
    await shadows.close();
    await rooms.flush();
  });

  test('向导也计入限速：每个环境和每次导入各算一次，超限时还没开始写入', async () => {
    // 限 3 次：两个环境 + 一次导入刚好用完，第二次请求直接 429
    const { app, rooms, shadows } = createApp(pdb, {
      connectionLimiter: new KeyedLimiter({ limit: 3, windowMs: 60_000 }),
    });
    const ck = await login('wizard-limit');
    const body = {
      name: '限速项目',
      groupId,
      environments: [
        { name: 'dev', url: emptyUrl, production: false, allowSameInstance: true },
        { name: 'dev2', url: emptyUrl, production: false, allowSameInstance: true },
      ],
      content: { kind: 'sql', sql: 'create table limit_t (id int)' },
    };
    const first = await app.request('/api/projects/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"stage":"done"');

    const second = await app.request('/api/projects/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ck },
      body: JSON.stringify({ ...body, name: '限速项目二' }),
    });
    expect(second.status).toBe(429);
    const [named] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '限速项目二',
    ]);
    expect(named!.n).toBe(0);
    await shadows.close();
    await rooms.flush();
  });

  test('KeyedLimiter：窗口过去后重新允许，时钟可注入', () => {
    let now = 0;
    const limiter = new KeyedLimiter({ limit: 2, windowMs: 1000, now: () => now });
    expect(limiter.attempt('u').allowed).toBe(true);
    expect(limiter.attempt('u').allowed).toBe(true);
    const blocked = limiter.attempt('u');
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed === false && blocked.retryAfterSeconds).toBe(1);
    now = 1000;
    expect(limiter.attempt('u').allowed).toBe(true);
    // 不同 key 互不影响
    expect(limiter.attempt('v').allowed).toBe(true);
  });

  // ───── N2 / N3 schema 范围与创建路径 ─────

  test('blank：只建空项目 + public schema，不发布版本', async () => {
    const r = await wizard({ name: '空空', groupId, content: { kind: 'blank' } });
    expect(r.status).toBe(200);
    expect(stages(r.events)).toEqual(['write', 'done']);
    const project = projectOf(r.events);
    const info = await call('GET', `/api/projects/${project.id}`);
    expect(info.status).toBe(200);
    expect((info.data as { schemas: unknown }).schemas).toBeNull();
    expect((await call('GET', `/api/projects/${project.id}/versions`)).data).toEqual([]);
    const ddl = await call('GET', `/api/projects/${project.id}/ddl`);
    expect(ddl.data.text as string).toContain('CREATE SCHEMA public');
    // 审计带上初始内容类型
    const [row] = await pdb.query<{ data: { content: string } }>(
      "select data from audit_events where action = 'project.create' and target_id = $1",
      [project.id],
    );
    expect(row!.data.content).toBe('blank');
  });

  /** 项目里的 v0 基线（详情，带冻结脚本和验证报告） */
  const baselineOf = async (pid: string) => {
    const [v0] = (await call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
    return (await call('GET', `/api/projects/${pid}/versions/${v0!.id}`)).data as unknown as VersionDetail;
  };

  test('database：按 schema 范围导入，自动发布 v0 基线，绝不导入 dowel', async () => {
    const r = await wizard({
      name: '多 schema',
      groupId,
      environments: [{ name: 'dev', url: multiUrl, production: false }],
      schemas: ['a'],
      content: { kind: 'database', env: 'dev' },
    });
    expect(r.status).toBe(200);
    expect(stages(r.events)).toEqual(['connect', 'read', 'write', 'done']);
    const project = projectOf(r.events);
    const ddl = (await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string;
    expect(ddl).toContain('a.t1');
    expect(ddl).not.toContain('b.t2');
    expect(ddl).not.toContain('dowel');

    const versions = (await call('GET', `/api/projects/${project.id}/versions`)).data as unknown as {
      name: string;
    }[];
    expect(versions.map((v) => v.name)).toEqual([BASELINE_VERSION_NAME]);

    // v0 基线：范围 ['a'] 不含 public，冻结的 up 只建 a，不碰 public（不能带 DROP SCHEMA public）；
    // 并且真的在影子库里执行了这份冻结脚本、结构一致，才标为已验证
    const v0 = await baselineOf(project.id);
    expect(v0.upSteps[0]!.sql).toBe('CREATE SCHEMA a');
    expect(v0.upSteps.map((x) => x.sql).join('\n')).not.toMatch(/public/);
    expect(v0.verifiedAt).not.toBeNull();
    expect(v0.verifyReport).toMatchObject({ ok: true, upDiff: [], error: null });
    expect(v0.verifyReport!.shadow).toBe('dev：wizard_multi_dowel');

    // 项目自己的 schema 范围记在项目上
    const info = await call('GET', `/api/projects/${project.id}`);
    expect((info.data as { schemas: unknown }).schemas).toEqual(['a']);
    // 环境也一起建好，并且目标库没有被写
    const envs = (await call('GET', `/api/projects/${project.id}/environments`)).data as unknown as {
      name: string;
    }[];
    expect(envs.map((e) => e.name)).toEqual(['dev']);
  });

  test('database：不设范围时导入 a 和 b，dowel 永远不导入', async () => {
    const r = await wizard({
      name: '全部 schema',
      groupId,
      environments: [{ name: 'dev', url: multiUrl, production: false }],
      content: { kind: 'database', env: 'dev' },
    });
    const project = projectOf(r.events);
    const ddl = (await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string;
    expect(ddl).toContain('a.t1');
    expect(ddl).toContain('b.t2');
    expect(ddl).not.toContain('dowel');
    const target = connectPg(multiUrl);
    const [n] = await target.db.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'dowel' and tablename = 'meta'",
    );
    await target.close();
    expect(n!.n).toBe(1); // 目标库里的 dowel 原样保留，没有被 Dowel 动过
  });

  test('sql：在影子库里执行后读回来，自动发布 v0，目标库不写', async () => {
    const r = await wizard({
      name: '从 SQL',
      groupId,
      environments: [{ name: 'dev', url: emptyUrl, production: false, allowSameInstance: true }],
      content: { kind: 'sql', sql: 'create schema s; create table s.t (id int primary key, note text);' },
    });
    expect(r.status).toBe(200);
    expect(stages(r.events)).toEqual(['connect', 'read', 'canonicalize', 'write', 'done']);
    const project = projectOf(r.events);
    const ddl = (await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string;
    expect(ddl).toContain('s.t');
    const versions = (await call('GET', `/api/projects/${project.id}/versions`)).data as unknown as {
      name: string;
    }[];
    expect(versions.map((v) => v.name)).toEqual([BASELINE_VERSION_NAME]);
    // v0 基线：number 0、没有 parent；up 是在空库上建库，down 为空；发布时就视为已验证
    const [v0] = (await call('GET', `/api/projects/${project.id}/versions`)).data as unknown as VersionInfo[];
    expect(v0).toMatchObject({ number: 0, parentId: null, edited: false, latest: true });
    expect(v0!.verifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const d0 = (await call('GET', `/api/projects/${project.id}/versions/${v0!.id}`))
      .data as unknown as VersionDetail;
    const upSql = d0.upSteps.map((x) => x.sql).join('\n');
    expect(upSql).toContain('CREATE SCHEMA s');
    expect(upSql).toContain('CREATE TABLE s.t');
    expect(upSql).not.toContain('CREATE SCHEMA public'); // 空库本来就有 public
    expect(d0.downSteps).toEqual([]);
    // 已验证 = 在影子库里执行了冻结的 up，读回的结构与模型一致（报告里记着用的是哪个影子库）
    expect(d0.verifyReport).toMatchObject({ ok: true, upDiff: [], error: null });
    expect(d0.verifyReport!.shadow).toBe('dev：wizard_empty_dowel');
    expect(d0.checksum).toBe(stepsChecksum(d0.upSteps, d0.downSteps));

    // 基线之后的第一次发布是 v1：parent 是 v0，迁移只含相对基线的差异；基线本身可以重新验证（只验证建库那一半）
    await editModel(appRooms, pdb, project.id, (m) => {
      const t = all(m, 'table').find((x) => x.name === 't')!;
      addColumn(m, t.id, { name: 'extra', type: 'text' });
    });
    const v1 = await call('POST', `/api/projects/${project.id}/versions`, { name: '加列' });
    expect(v1.status).toBe(201);
    expect(v1.data).toMatchObject({ number: 1, verified: true });
    const d1 = (await call('GET', `/api/projects/${project.id}/versions/${v1.data.id}`))
      .data as unknown as VersionDetail;
    expect(d1.parentId).toBe(v0!.id);
    expect(d1.upSteps.map((x) => x.sql)).toEqual(['ALTER TABLE s.t ADD COLUMN extra text']);
    const re0 = await call('POST', `/api/projects/${project.id}/versions/${v0!.id}/verify`);
    expect(re0.status).toBe(200);
    expect(re0.data.report).toMatchObject({ ok: true, upDiff: [], error: null });
    // 目标库（wizard_empty）里没有 s schema：只写平台库
    const target = connectPg(emptyUrl);
    const [row] = await target.db.query<{ n: number }>(
      "select count(*)::int as n from pg_namespace where nspname = 's'",
    );
    await target.close();
    expect(row!.n).toBe(0);
  });

  test('项目设置里的 schema 范围也管着“从环境拉取”', async () => {
    const pid = (await call('POST', '/api/projects', { name: '范围拉取', groupId })).data.id as string;
    // 先设范围，再添加环境、从目标库拉取：只应该拉 a
    expect((await call('PATCH', `/api/projects/${pid}`, { schemas: ['a'] })).status).toBe(200);
    const eid = (
      await call('POST', `/api/projects/${pid}/environments`, {
        name: 'dev',
        url: multiUrl,
        production: false,
      })
    ).data.id as string;
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(200);
    const ddl = (await call('GET', `/api/projects/${pid}/ddl`)).data.text as string;
    expect(ddl).toContain('a.t1');
    expect(ddl).not.toContain('b.t2');
    // 改成全部（null）后再拉取一次：a 和 b 都在，dowel 依然没有
    expect((await call('PATCH', `/api/projects/${pid}`, { schemas: null })).status).toBe(200);
    await call('POST', `/api/projects/${pid}/environments/${eid}/pull`);
    const all2 = (await call('GET', `/api/projects/${pid}/ddl`)).data.text as string;
    expect(all2).toContain('a.t1');
    expect(all2).toContain('b.t2');
    expect(all2).not.toContain('dowel');
  });

  test('takeover：P4 才实现，返回 422', async () => {
    const r = await call('POST', '/api/projects/wizard', {
      name: '接手',
      groupId,
      content: { kind: 'takeover' },
    });
    expect(r.status).toBe(422);
    expect(r.data.error as string).toContain('即将推出');
  });

  test('导入失败：平台库里没有残留的项目 / 环境 / 版本', async () => {
    const before = (await call('GET', '/api/projects')).data as unknown as { id: string }[];
    const r = await wizard({
      name: '坏 SQL',
      groupId,
      environments: [{ name: 'dev', url: emptyUrl, production: false, allowSameInstance: true }],
      content: { kind: 'sql', sql: 'create table (' },
    });
    expect(r.status).toBe(200);
    const last = r.events.at(-1)!;
    expect(last.stage).toBe('read');
    expect(last.error).toBeTruthy();
    expect(last.project).toBeUndefined();
    const after = (await call('GET', '/api/projects')).data as unknown as { id: string }[];
    expect(after.length).toBe(before.length);
    const [named] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '坏 SQL',
    ]);
    expect(named!.n).toBe(0);
    const [envs] = await pdb.query<{ n: number }>('select count(*) as n from environments where name = $1', [
      'dev',
    ]);
    expect(envs!.n).toBeGreaterThanOrEqual(0);
  });

  test('平台库写入失败：清理这次新建的影子库，不留项目', async () => {
    // 用一个还没建过影子库的空库：这次请求会新建 wizard_cleanup_dowel，写入失败时应该被清掉
    // 让平台库的事务直接失败：外部操作（建影子库、导入 SQL）都成功，写入阶段出错
    const broken: PlatformDb = {
      ...pdb,
      dialect: pdb.dialect,
      transaction: () => Promise.reject(new Error('平台库写入失败（测试）')),
      close: async () => {},
    };
    const { app, rooms, shadows } = createApp(broken);
    const res = await app.request('/api/projects/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: '写入失败',
        groupId,
        environments: [
          { name: 'dev', url: dbUrl('wizard_cleanup'), production: false, allowSameInstance: true },
        ],
        content: { kind: 'sql', sql: 'create table writes_fail (id int)' },
      }),
    });
    const events = (await res.text())
      .split('\n\n')
      .filter((x) => x.trim())
      .map((c) => JSON.parse(c.replace(/^data: /, '')) as WizardEvent);
    // 意外错误（平台库）不把内部细节发给浏览器，只给“服务器内部错误”，细节进服务端日志
    expect(events.at(-1)!.error).toBe('服务器内部错误');
    await shadows.close();
    await rooms.flush();
    // 本次新建的影子库被清掉（之前用例可能已经建过，所以先确认存在再断言被删）
    const [row] = await admin.db.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname = 'wizard_cleanup_dowel'",
    );
    expect(row!.n).toBe(0);
    const [named] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '写入失败',
    ]);
    expect(named!.n).toBe(0);
  });

  test('只有 SELECT 权限的账号能导入，且导入前后目标库结构完全相同、没有 dowel schema', async () => {
    const before = await snapshotOf(roAdminUrl);
    const r = await wizard({
      name: '只读导入',
      groupId,
      environments: [{ name: 'prod', url: roUrl, production: false }],
      content: { kind: 'database', env: 'prod' },
    });
    expect(r.status).toBe(200);
    expect(r.events.at(-1)!.project).toBeTruthy();
    const project = projectOf(r.events);
    const ddl = (await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string;
    expect(ddl).toContain('a.t');
    const after = await snapshotOf(roAdminUrl);
    expect(diffSnapshots(before, after)).toEqual([]);
    const target = connectPg(roAdminUrl);
    const [row] = await target.db.query<{ n: number }>(
      "select count(*)::int as n from pg_namespace where nspname = 'dowel'",
    );
    await target.close();
    expect(row!.n).toBe(0);
  });

  test('SQL 导入里有实例级语句：在连接数据库、准备影子库之前就 422（不建 {库名}_dowel、不拿锁），没有建项目', async () => {
    hook.prepareCalls = 0;
    // 用一个还没建过影子库的库：被拒绝之后也不应该冒出 wizard_instance_dowel
    const r = await wizard({
      name: '实例级语句导入',
      groupId,
      environments: [
        { name: 'dev', url: dbUrl('wizard_instance'), production: false, allowSameInstance: true },
      ],
      content: { kind: 'sql', sql: 'create table t (id int); CREATE DATABASE wizard_must_not_exist' },
    });
    expect(r.status).toBe(422);
    expect(r.events).toEqual([]); // 不是进度流：直接 HTTP 422
    expect(String(r.data.error)).toMatch(/^导入的 SQL 含实例级语句（.+）。实例级语句不能放进迁移/);
    expect(hook.prepareCalls).toBe(0);
    const [shadowDb] = await admin.db.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname = 'wizard_instance_dowel'",
    );
    expect(shadowDb!.n).toBe(0);
    const [row] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '实例级语句导入',
    ]);
    expect(Number(row!.n)).toBe(0);
    const [exists] = await admin.db.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname = 'wizard_must_not_exist'",
    );
    expect(exists!.n).toBe(0);
  });

  test('基线验证失败（ok:false，例如执行超时）：项目照常创建，基线未验证，失败报告保留', async () => {
    hook.verifyResult = {
      ok: false,
      up: [],
      down: [],
      upDiff: [],
      downDiff: [],
      risks: [],
      error: { step: null, message: '执行超时（超过影子库的语句超时限制）：canceling statement' },
    };
    try {
      const r = await wizard({
        name: '基线验证失败',
        groupId,
        environments: [{ name: 'dev', url: multiUrl, production: false }],
        schemas: ['a'],
        content: { kind: 'database', env: 'dev' },
      });
      expect(r.events.some((e) => e.error)).toBe(false);
      const v0 = await baselineOf(projectOf(r.events).id);
      expect(v0.verifiedAt).toBeNull();
      expect(v0.verifyReport).toMatchObject({
        ok: false,
        error: { message: '执行超时（超过影子库的语句超时限制）：canceling statement' },
      });
      expect(v0.verifyReport!.shadow).toBe('dev：wizard_multi_dowel');
    } finally {
      hook.verifyResult = null;
    }
  });

  test('基线验证的意外错误消息里带连接串密码：写进 baselineReport 之前先脱敏', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    hook.verifyError = new Error('读结构时出错：postgres://u:pw@h/db 连不上');
    try {
      const r = await wizard({
        name: '基线报告脱敏',
        groupId,
        environments: [{ name: 'dev', url: multiUrl, production: false }],
        schemas: ['a'],
        content: { kind: 'database', env: 'dev' },
      });
      const v0 = await baselineOf(projectOf(r.events).id);
      expect(JSON.stringify(v0.verifyReport)).not.toContain('pw');
      expect(v0.verifyReport!.error!.message).toBe(
        '基线验证没有完成：读结构时出错：postgres://u:***@h/db 连不上',
      );
      const [row] = await pdb.query<{ verify_report: unknown }>(
        'select verify_report from versions where id = $1',
        [v0.id],
      );
      expect(JSON.stringify(row!.verify_report)).not.toContain('pw');
    } finally {
      hook.verifyError = null;
      log.mockRestore();
    }
  });

  test('向导进度里的 error 事件也脱敏（意外错误的消息里带连接串）', async () => {
    hook.verifyError = new HTTPException(403, { message: '拒绝连接 postgres://u:pw@h/db' });
    try {
      const r = await wizard({
        name: '事件脱敏',
        groupId,
        environments: [{ name: 'dev', url: dbUrl('wizard_abort'), production: false }],
        content: { kind: 'database', env: 'dev' },
      });
      const last = r.events.at(-1)!;
      expect(last.error).toBe('拒绝连接 postgres://u:***@h/db');
      expect(JSON.stringify(r.events)).not.toContain('pw');
    } finally {
      hook.verifyError = null;
    }
  });

  test('基线验证出现意外错误：项目照常创建，基线未验证，报告里写明原因并记日志', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    hook.verifyError = new Error('读结构时出了意外');
    try {
      const cases = [
        {
          name: '验证出意外（database）',
          environments: [{ name: 'dev', url: multiUrl, production: false }],
          content: { kind: 'database' as const, env: 'dev' },
          schemas: ['a'],
        },
        {
          name: '验证出意外（sql）',
          environments: [{ name: 'dev', url: emptyUrl, production: false, allowSameInstance: true }],
          content: { kind: 'sql' as const, sql: 'create table public.t (id int primary key);' },
        },
      ];
      for (const c of cases) {
        const r = await wizard({ groupId, ...c });
        expect(r.status).toBe(200);
        // 没有 error 事件，项目建好了，模型也在
        expect(r.events.some((e) => e.error)).toBe(false);
        const project = projectOf(r.events);
        const v0 = await baselineOf(project.id);
        expect(v0.verifiedAt, c.name).toBeNull();
        expect(v0.verifyReport).toMatchObject({ ok: false });
        expect(v0.verifyReport!.error!.message).toBe('基线验证没有完成：读结构时出了意外');
        expect(v0.upSteps.length).toBeGreaterThan(0);
        expect(
          ((await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string).length,
        ).toBeGreaterThan(0);
      }
      expect(log).toHaveBeenCalledWith(expect.stringContaining('基线验证出错'), expect.any(Error));
    } finally {
      hook.verifyError = null;
      log.mockRestore();
    }
  });

  test('基线验证时白名单拒绝 / 密钥解密失败：和发布一致，继续抛出，向导以 error 事件结束，新建的影子库被清掉', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const err of [
        new HTTPException(403, { message: '连接地址不在白名单里' }),
        new SecretError('无法解密连接串'),
      ]) {
        hook.verifyError = err;
        hook.created = null;
        const name = `基线验证被拒绝 ${err.constructor.name}`;
        const r = await wizard({
          name,
          groupId,
          environments: [{ name: 'dev', url: dbUrl('wizard_abort'), production: false }],
          content: { kind: 'database', env: 'dev' },
        });
        expect(r.status).toBe(200);
        const last = r.events.at(-1)!;
        expect(last.error).toBe(err.message);
        expect(last.project).toBeUndefined();
        // 项目没有创建
        const [row] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
          name,
        ]);
        expect(Number(row!.n)).toBe(0);
        // 为这次验证新建的影子库按 pre-commit 失败的流程清掉了
        expect(hook.created, '这次请求应该新建了影子库').not.toBeNull();
        const [db] = await admin.db.query<{ n: number }>(
          "select count(*)::int as n from pg_database where datname = 'wizard_abort_dowel'",
        );
        expect(db!.n).toBe(0);
      }
    } finally {
      hook.verifyError = null;
      log.mockRestore();
    }
  });

  test('没有影子库可用时基线照常创建，但标为未验证（不假装验证过）', async () => {
    // 生产环境默认不在同一实例上建影子库：导入只读结构，不需要影子库，所以能成功，但没法验证基线
    const prod = await wizard({
      name: '生产导入',
      groupId,
      environments: [{ name: 'prod', url: multiUrl, production: true }],
      schemas: ['a'],
      content: { kind: 'database', env: 'prod' },
    });
    expect(prod.status).toBe(200);
    const v0 = await baselineOf(projectOf(prod.events).id);
    expect(v0.verifiedAt).toBeNull();
    expect(v0.verifyReport).toBeNull();
    expect(v0.upSteps.length).toBeGreaterThan(0);
    // 没有建库权限的只读账号：同样没有影子库，基线未验证
    const ro = await wizard({
      name: '只读未验证',
      groupId,
      environments: [{ name: 'prod', url: roUrl, production: false }],
      content: { kind: 'database', env: 'prod' },
    });
    expect(ro.status).toBe(200);
    const roV0 = await baselineOf(projectOf(ro.events).id);
    expect(roV0.verifiedAt).toBeNull();
  });

  test('影子库上仍然有 Dowel 的标记（新建的影子库会被下次复用）', async () => {
    const [row] = await admin.db.query<{ c: string }>(
      "select shobj_description(oid, 'pg_database') as c from pg_database where datname = 'wizard_empty_dowel'",
    );
    expect(row?.c).toBe(SHADOW_MARK);
  });

  // ───── 范围自洽（跨范围引用拒绝导入） ─────

  test('范围里的外键指向范围外的表：422，提示把 public 加进范围', async () => {
    const scopeUrl = dbUrl('wizard_scope');
    const bad = await wizard({
      name: '跨范围外键',
      groupId,
      environments: [{ name: 'dev', url: scopeUrl, production: false }],
      schemas: ['app'],
      content: { kind: 'database', env: 'dev' },
    });
    expect(bad.status).toBe(200);
    const last = bad.events.at(-1)!;
    expect(last.project).toBeUndefined();
    expect(last.error).toContain('范围外');
    expect(last.error).toContain('public');
    expect(last.error).toContain('app.orders');
    // 视图跨范围也查得出来（依赖在 pg_depend 里）
    expect(last.error).toContain('app.user_emails');
    // 没有建出项目
    const [named] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '跨范围外键',
    ]);
    expect(named!.n).toBe(0);

    // 把 public 也加进范围就正常
    const ok = await wizard({
      name: '跨范围外键二',
      groupId,
      environments: [{ name: 'dev', url: scopeUrl, production: false }],
      schemas: ['app', 'public'],
      content: { kind: 'database', env: 'dev' },
    });
    expect(ok.status).toBe(200);
    const project = projectOf(ok.events);
    const ddl = (await call('GET', `/api/projects/${project.id}/ddl`)).data.text as string;
    expect(ddl).toContain('app.orders');
    expect(ddl).toContain('public.users');
  });

  test('列用了范围外的扩展类型（citext 装在 public）：422', async () => {
    const citextUrl = dbUrl('wizard_citext');
    const body = {
      groupId,
      environments: [{ name: 'dev', url: citextUrl, production: false }],
      content: { kind: 'database', env: 'dev' },
    };
    const bad = await wizard({ ...body, name: 'citext 范围', schemas: ['app'] });
    expect(bad.status).toBe(200);
    const last = bad.events.at(-1)!;
    expect(last.project).toBeUndefined();
    expect(last.error).toContain('citext');
    expect(last.error).toContain('public');

    // public 也在范围里就正常（citext 是 public 下的扩展类型）
    const ok = await wizard({ ...body, name: 'citext 范围二', schemas: ['app', 'public'] });
    expect(ok.events.at(-1)!.project).toBeTruthy();
  });

  // ───── 白名单在连接层生效 ─────

  test('白名单收紧后：测试连接、拉取、验证都拒绝', async () => {
    const pid = (await call('POST', '/api/projects', { name: '白名单收紧', groupId })).data.id as string;
    const eid = (
      await call('POST', `/api/projects/${pid}/environments`, {
        name: 'dev',
        url: multiUrl,
        production: false,
      })
    ).data.id as string;
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(200);

    await call('PATCH', '/api/admin/settings', { connectionAllowlist: ['10.255.255.0/24'] });
    const test = await call('POST', `/api/projects/${pid}/environments/${eid}/test`);
    expect(test.status).toBe(422);
    expect(test.data.error as string).toContain('不在实例允许的范围内');
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(422);
    expect((await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' })).status).toBe(
      422,
    );
    await call('PATCH', '/api/admin/settings', { connectionAllowlist: [] });
  });

  // ───── 提交之后失败不回滚 ─────

  test('提交之后审计失败：项目保留、影子库不删、仍然返回 done', async () => {
    // 注入一个“审计写不进去”的平台库：其余查询照旧
    const broken: PlatformDb = {
      ...pdb,
      dialect: pdb.dialect,
      close: async () => {},
      query: (async <T>(q: string, params?: unknown[]) => {
        if (q.includes('insert into audit_events')) throw new Error('审计表写不进去（测试）');
        return pdb.query<T>(q, params);
      }) as PlatformDb['query'],
    };
    const { app, rooms, shadows } = createApp(broken, {
      connectionLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    const res = await app.request('/api/projects/wizard', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        name: '审计失败',
        groupId,
        environments: [
          { name: 'dev', url: dbUrl('wizard_audit'), production: false, allowSameInstance: true },
        ],
        content: { kind: 'sql', sql: 'create table audit_t (id int)' },
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"stage":"done"');
    expect(text).not.toContain('"error"');
    // 项目在、影子库也在（提交之后失败不能回滚）
    const [project] = await pdb.query<{ id: string }>('select id from projects where name = $1', [
      '审计失败',
    ]);
    expect(project).toBeTruthy();
    const [shadow] = await admin.db.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname = 'wizard_audit_dowel'",
    );
    expect(shadow!.n).toBe(1);
    await shadows.close();
    await rooms.flush();
  });

  // ───── 环境和单独建环境走同样的检查 ─────

  test('向导里的环境也要过影子库检查：非空且没有标记的库 → 422', async () => {
    const r = await call('POST', '/api/projects/wizard', {
      name: '脏影子库',
      groupId,
      environments: [
        {
          name: 'dev',
          url: emptyUrl,
          production: false,
          allowSameInstance: true,
          shadowUrl: dbUrl('wizard_dirty'),
        },
      ],
      content: { kind: 'blank' },
    });
    expect(r.status).toBe(422);
    expect(r.data.error as string).toContain('不是空库');
    const [named] = await pdb.query<{ n: number }>('select count(*) as n from projects where name = $1', [
      '脏影子库',
    ]);
    expect(named!.n).toBe(0);
  });

  test('环境名与 content.env 都按 trim 后匹配', async () => {
    const r = await wizard({
      name: '空格环境',
      groupId,
      environments: [{ name: '  dev  ', url: multiUrl, production: false }],
      content: { kind: 'database', env: ' dev ' },
    });
    expect(r.status).toBe(200);
    const project = projectOf(r.events);
    const envs = (await call('GET', `/api/projects/${project.id}/environments`)).data as unknown as {
      name: string;
    }[];
    expect(envs.map((e) => e.name)).toEqual(['dev']);
  });

  const snapshotOf = async (url: string) => {
    const c = connectPg(url);
    try {
      return await readSnapshot(c.db);
    } finally {
      await c.close();
    }
  };

  void all;
});
