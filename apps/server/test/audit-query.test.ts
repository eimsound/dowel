// 审计查询接口（G7）：过滤、按 at + id 倒序的游标分页、返回 actor 用户名、只有实例管理员能用。
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'audit-query-secret-0123456789';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let adminCookie = '';
let memberCookie = '';

const call = async (method: string, path: string, json?: unknown, cookie = '') => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const r = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: r.status,
    data: data as Record<string, unknown> & unknown[],
    cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

const RANGE = 'from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:06Z';

interface Event {
  id: string;
  action: string;
  actorId: string;
  actorUsername: string;
}

const events = (data: unknown): Event[] => (data as { events: Event[] }).events;

const insert = async (
  id: string,
  at: string,
  action: string,
  actorId: string | null,
  targetKind: string | null,
  targetId: string | null,
) => {
  await db.query(
    `insert into audit_events (id, at, actor_kind, actor_id, action, target_kind, target_id, ip, data)
     values ($1, $2, $3, $4, $5, $6, $7, '203.0.113.1', $8::text::jsonb)`,
    [id, at, actorId ? 'user' : 'system', actorId, action, targetKind, targetId, JSON.stringify({ id })],
  );
};

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
  app = created.app;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
  const admin = await makeUser(db, 'admin', { role: 'admin' });
  const member = await makeUser(db, 'member');
  adminCookie = (await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD })).cookie;
  memberCookie = (await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD })).cookie;
  await insert('e1', '2026-01-01T00:00:01.000Z', 'auth.login', admin.id, 'user', admin.id);
  await insert('e2', '2026-01-01T00:00:02.000Z', 'grant.create', member.id, 'project', 'p1');
  await insert('e3', '2026-01-01T00:00:03.000Z', 'grant.update', member.id, 'project', 'p1');
  await insert('e4', '2026-01-01T00:00:04.000Z', 'project.create', member.id, 'project', 'p2');
  await insert('e5', '2026-01-01T00:00:05.000Z', 'auth.logout', admin.id, 'user', admin.id);
});

afterEach(async () => {
  await stop();
  await db.close();
});

test('只有实例管理员能查询；未登录 401、普通用户 403', async () => {
  expect((await call('GET', '/api/admin/audit')).status).toBe(401);
  expect((await call('GET', '/api/admin/audit', undefined, memberCookie)).status).toBe(403);
  expect((await call('GET', '/api/admin/audit', undefined, adminCookie)).status).toBe(200);
});

test('过滤：action 前缀、actor（ID / 用户名）、target、时间范围', async () => {
  const prefix = await call('GET', `/api/admin/audit?${RANGE}&action=grant.`, undefined, adminCookie);
  expect(events(prefix.data).map((e) => e.action)).toEqual(['grant.update', 'grant.create']);

  const byUsername = await call('GET', `/api/admin/audit?${RANGE}&actor=member`, undefined, adminCookie);
  expect(events(byUsername.data)).toHaveLength(3);
  expect(events(byUsername.data)[0]).toMatchObject({ actorUsername: 'member' });

  const byId = await call(
    'GET',
    `/api/admin/audit?${RANGE}&actor=${events(byUsername.data)[0]!.actorId}`,
    undefined,
    adminCookie,
  );
  expect(events(byId.data)).toHaveLength(3);

  const target = await call(
    'GET',
    `/api/admin/audit?${RANGE}&targetKind=project&targetId=p1`,
    undefined,
    adminCookie,
  );
  expect(events(target.data).map((e) => e.action)).toEqual(['grant.update', 'grant.create']);

  const range = await call(
    'GET',
    '/api/admin/audit?from=2026-01-01T00:00:02Z&to=2026-01-01T00:00:04Z',
    undefined,
    adminCookie,
  );
  expect(events(range.data).map((e) => e.id)).toEqual(['e4', 'e3', 'e2']);

  expect((await call('GET', '/api/admin/audit?from=not-a-time', undefined, adminCookie)).status).toBe(400);
});

test('游标分页按 at、id 倒序，两页不重叠', async () => {
  const first = await call('GET', `/api/admin/audit?${RANGE}&limit=2`, undefined, adminCookie);
  expect(events(first.data).map((e) => e.id)).toEqual(['e5', 'e4']);
  const cursor = first.data.nextCursor as string;
  expect(cursor).toBeTruthy();
  const second = await call(
    'GET',
    `/api/admin/audit?${RANGE}&limit=2&cursor=${encodeURIComponent(cursor)}`,
    undefined,
    adminCookie,
  );
  expect(events(second.data).map((e) => e.id)).toEqual(['e3', 'e2']);
  const third = await call(
    'GET',
    `/api/admin/audit?${RANGE}&limit=2&cursor=${encodeURIComponent(second.data.nextCursor as string)}`,
    undefined,
    adminCookie,
  );
  expect(events(third.data).map((e) => e.id)).toEqual(['e1']);
  expect(third.data.nextCursor).toBeNull();

  expect((await call('GET', '/api/admin/audit?cursor=bogus', undefined, adminCookie)).status).toBe(400);
});

test.skipIf(!PG_URL)('PG 上游标保留微秒精度：同一毫秒内多条记录不漏不重', async () => {
  const t = await createTestDb('audit_cursor');
  const pdb = await openPlatformDb(t.url);
  const created = createApp(pdb, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
  try {
    await makeUser(pdb, 'admin', { role: 'admin' });
    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    for (const [i, micros] of ['123001', '123002', '123003', '123004'].entries())
      await pdb.query(
        `insert into audit_events (id, at, actor_kind, action)
         values ($1, $2::timestamptz, 'system', 'test.event')`,
        [`p${i + 1}`, `2026-01-01T00:00:00.${micros}+00`],
      );

    const get = async (path: string) => {
      const r = await created.app.request(path, { headers: { cookie } });
      return { status: r.status, data: (await r.json()) as Record<string, unknown> };
    };
    const range = 'from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:01Z';
    const first = await get(`/api/admin/audit?${range}&limit=2`);
    expect(events(first.data).map((e) => e.id)).toEqual(['p4', 'p3']);
    const second = await get(
      `/api/admin/audit?${range}&limit=2&cursor=${encodeURIComponent(first.data.nextCursor as string)}`,
    );
    expect(events(second.data).map((e) => e.id)).toEqual(['p2', 'p1']);
    expect(second.data.nextCursor).toBeNull();
  } finally {
    await created.rooms.flush();
    await created.shadows.close();
    await pdb.close();
    await t.close();
  }
});
