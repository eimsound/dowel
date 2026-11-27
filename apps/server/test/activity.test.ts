// 项目动态接口：只返回与这个项目有关的审计记录（项目、版本、环境），按时间倒序；
// 权限是项目查看者，看不见的项目一律 404。
import { afterEach, beforeEach, expect, test } from 'vitest';

import { backfillAuditProjectIds } from '../src/db.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { addTable, makeUser, PASSWORD, stubPassingShadow } from './support.ts';

process.env.DOWEL_SECRET ??= 'activity-test-secret-0123456789';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let adminCookie = '';
let viewerCookie = '';
let outsiderCookie = '';
let pids = { p1: '', p2: '' };

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
    data: data as Record<string, unknown>,
    cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

const login = async (username: string) => {
  const r = await call('POST', '/api/auth/login', { username, password: PASSWORD });
  expect(r.status).toBe(200);
  return r.cookie;
};

interface Event {
  id: string;
  action: string;
  actorName: string | null;
  actorUsername: string | null;
  at: string;
  data: unknown;
}

const events = (data: unknown): Event[] => (data as { events: Event[] }).events;

const insertAudit = async (
  id: string,
  at: string,
  action: string,
  actorId: string,
  targetKind: string,
  targetId: string,
  projectId: string | null = null,
  data: unknown = null,
) => {
  await db.query(
    `insert into audit_events (id, at, actor_kind, actor_id, action, target_kind, target_id, project_id, data)
     values ($1, $2, 'user', $3, $4, $5, $6, $7, $8::text::jsonb)`,
    [id, at, actorId, action, targetKind, targetId, projectId, data === null ? null : JSON.stringify(data)],
  );
};

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
  // 发布必须经影子库验证（ADR 0017）：这里只要一个已发布版本，用影子库替身
  stubPassingShadow(created.shadows);
  app = created.app;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
  const admin = await makeUser(db, 'admin', { role: 'admin' });
  const viewer = await makeUser(db, 'viewer', { name: '查看者' });
  await makeUser(db, 'outsider', { name: '无关用户' });
  adminCookie = await login('admin');
  viewerCookie = await login('viewer');
  outsiderCookie = await login('outsider');

  const group = await call('POST', '/api/groups', { slug: 'g1', name: '组一' }, adminCookie);
  expect(group.status).toBe(201);
  const groupId = group.data.id as string;

  const p1 = await call('POST', '/api/projects', { name: '项目一', groupId }, adminCookie);
  const p2 = await call('POST', '/api/projects', { name: '项目二', groupId }, adminCookie);
  expect(p1.status).toBe(201);
  expect(p2.status).toBe(201);
  const p1id = p1.data.id as string;
  const p2id = p2.data.id as string;

  await addTable(created.rooms, db, p1id);
  // 项目一里发一个版本、加一个环境（环境的连接串用不到的假地址，直接写库）
  const v = await call('POST', `/api/projects/${p1id}/versions`, { name: 'v1' }, adminCookie);
  expect(v.status).toBe(201);
  const versionId = v.data.id as string;
  await db.query(
    `insert into environments (id, project_id, name, url_enc, production)
     values ('env1', $1, 'dev', 'x', false)`,
    [p1id],
  );

  await db.query(
    `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
     values ('g-viewer', 'user', $1, 'viewer', 'project', $2)`,
    [viewer.id, p1id],
  );

  await insertAudit('a1', '2026-01-01T00:00:01.000Z', 'project.create', admin.id, 'project', p1id, p1id, {
    name: '项目一',
  });
  await insertAudit(
    'a2',
    '2026-01-01T00:00:02.000Z',
    'version.publish',
    admin.id,
    'version',
    versionId,
    p1id,
    { name: 'v1' },
  );
  await insertAudit(
    'a3',
    '2026-01-01T00:00:03.000Z',
    'environment.create',
    admin.id,
    'environment',
    'env1',
    p1id,
    { name: 'dev', projectId: p1id },
  );
  await insertAudit(
    'a7',
    '2026-01-01T00:00:07.000Z',
    'environment.delete',
    admin.id,
    'environment',
    'env1',
    p1id,
    { projectId: p1id },
  );
  await insertAudit('a4', '2026-01-01T00:00:04.000Z', 'project.update', admin.id, 'project', p1id, p1id, {});
  await insertAudit('a5', '2026-01-01T00:00:05.000Z', 'project.create', admin.id, 'project', p2id, p2id, {
    name: '项目二',
  });
  await insertAudit('a6', '2026-01-01T00:00:06.000Z', 'auth.login', admin.id, 'user', admin.id);
  // 只按 project_id 过滤：target 指向项目一、但归类到项目二的记录不应出现
  await insertAudit('a8', '2026-01-01T00:00:08.000Z', 'project.update', admin.id, 'project', p1id, p2id);
  // 反过来，project_id 是项目一、target 是用户（例如项目相关的账户操作）应该出现
  await insertAudit('a9', '2026-01-01T00:00:09.000Z', 'grant.create', admin.id, 'user', admin.id, p1id, {
    role: 'viewer',
  });

  // 环境已经被删除：旧记录的 data.projectId 仍然能把它归类到项目一
  await db.query("delete from environments where id = 'env1'");

  // 环境已经被删除：动态仍要通过审计记录里的 projectId 找到它
  await db.query("delete from environments where id = 'env1'");

  pids = { p1: p1id, p2: p2id };
});

afterEach(async () => {
  await stop();
});

test('查看者能看到项目自己的、版本的和环境的动态，看不到别的项目和登录记录', async () => {
  const r = await call('GET', `/api/projects/${pids.p1}/activity`, undefined, viewerCookie);
  expect(r.status).toBe(200);
  const list = events(r.data);
  const ids = list.map((e) => e.id);
  // 建项目和发布版本的接口自己也会写审计，这里只看手工插入的那几条及其相对顺序
  expect(ids).toEqual(expect.arrayContaining(['a9', 'a7', 'a4', 'a3', 'a2', 'a1']));
  expect(ids).not.toContain('a5');
  expect(ids).not.toContain('a6');
  expect(ids).not.toContain('a8');
  expect(ids.indexOf('a9')).toBeLessThan(ids.indexOf('a7'));
  expect(ids.indexOf('a7')).toBeLessThan(ids.indexOf('a4'));
  expect(ids.indexOf('a4')).toBeLessThan(ids.indexOf('a3'));
  expect(ids.indexOf('a3')).toBeLessThan(ids.indexOf('a2'));
  expect(ids.indexOf('a2')).toBeLessThan(ids.indexOf('a1'));
  const a4 = list.find((e) => e.id === 'a4')!;
  expect(a4).toMatchObject({
    action: 'project.update',
    actorName: 'admin',
    actorUsername: 'admin',
  });
  expect(new Date(a4.at).toISOString()).toBe('2026-01-01T00:00:04.000Z');
  expect(list.find((e) => e.id === 'a2')!.data).toEqual({ name: 'v1' });

  // 服务端自己的 project.create / version.publish 也带上了 project_id
  const own = await db.query<{ action: string; projectId: string | null }>(
    `select action, project_id as "projectId" from audit_events
      where project_id = $1 and action in ('project.create', 'version.publish')`,
    [pids.p1],
  );
  expect(own.map((e) => e.action)).toEqual(expect.arrayContaining(['project.create', 'version.publish']));
  expect(own.every((e) => e.projectId === pids.p1)).toBe(true);
});

test('旧审计记录回填 project_id，环境删除后仍能靠 data.projectId 归类', async () => {
  const [version] = await db.query<{ id: string }>('select id from versions limit 1');
  await insertAudit('b1', '2026-02-01T00:00:01.000Z', 'project.create', '', 'project', pids.p1);
  await insertAudit('b2', '2026-02-01T00:00:02.000Z', 'version.publish', '', 'version', version!.id);
  await insertAudit('b3', '2026-02-01T00:00:03.000Z', 'environment.delete', '', 'environment', 'env1', null, {
    projectId: pids.p1,
  });
  await insertAudit('b4', '2026-02-01T00:00:04.000Z', 'project.create', '', 'project', pids.p2);

  await backfillAuditProjectIds(db, db.dialect);

  const rows = await db.query<{ id: string; projectId: string | null }>(
    `select id, project_id as "projectId" from audit_events where id in ('b1', 'b2', 'b3', 'b4')`,
  );
  const byId = new Map(rows.map((r) => [r.id, r.projectId]));
  expect(byId.get('b1')).toBe(pids.p1);
  expect(byId.get('b2')).toBe(pids.p1);
  expect(byId.get('b3')).toBe(pids.p1);
  expect(byId.get('b4')).toBe(pids.p2);
});

test('看不到项目的人返回 404', async () => {
  const r = await call('GET', `/api/projects/${pids.p1}/activity`, undefined, outsiderCookie);
  expect(r.status).toBe(404);
});
