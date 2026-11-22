// 审计日志：注册、登录成功 / 失败、退出、创建项目、添加成员、发布版本都写一条记录。
import type { Context } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { audit } from '../src/audit.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import type { SecurityConfig } from '../src/security.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let rooms: ReturnType<typeof createApp>['rooms'];

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db);
  const { app: a, shadows } = created;
  rooms = created.rooms;
  app = a;
  stop = async () => {
    await rooms.flush();
    await shadows.close();
  };
});

afterEach(async () => {
  await stop();
  await db.close();
});

const call = async (method: string, path: string, json?: unknown, cookie = '') => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
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
  };
};

const events = (action: string) =>
  db.query<{
    actor_kind: string;
    actor_id: string | null;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    ip: string | null;
    data: unknown;
  }>(
    'select actor_kind, actor_id, action, target_kind, target_id, ip, data from audit_events where action = $1',
    [action],
  );

test('认证与项目动作写入审计', async () => {
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  const admin = await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  expect(admin.status).toBe(200);
  const adminId = admin.data.id as string;
  const [loginEvent] = await events('auth.login');
  expect(loginEvent).toMatchObject({ actor_kind: 'user', actor_id: adminId });

  expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong-pass' })).status).toBe(
    401,
  );
  const [failed] = await events('auth.login_failed');
  expect(failed).toMatchObject({
    actor_kind: 'system',
    actor_id: null,
    data: { username: 'admin', reason: 'invalid' },
  });

  // 管理员直接建用户（公开注册已取消）
  const zhang = await call(
    'POST',
    '/api/admin/users',
    { username: 'zhang', name: '张三', password: 'password1' },
    admin.cookie,
  );
  expect(zhang.status).toBe(201);
  const zhangId = zhang.data.id as string;
  const [created] = await events('user.create');
  expect(created).toMatchObject({
    actor_kind: 'user',
    actor_id: adminId,
    target_kind: 'user',
    target_id: zhangId,
    data: { username: 'zhang', role: 'member', password: true },
  });

  expect(zhang.data.mustChangePassword).toBe(true);
  const login = await call('POST', '/api/auth/login', { username: 'zhang', password: 'password1' });
  expect(login.status).toBe(200);
  expect(login.data.mustChangePassword).toBe(true);
  // 管理员直接创建的用户初始带临时密码，必须先改密才能创建组/项目
  expect(
    (
      await call(
        'POST',
        '/api/me/password',
        { oldPassword: 'password1', newPassword: 'password1-new' },
        login.cookie,
      )
    ).status,
  ).toBe(200);

  const group = await call('POST', '/api/groups', { slug: 'shop', name: '商城组' }, login.cookie);
  expect(group.status).toBe(201);
  const [groupEvent] = await events('group.create');
  expect(groupEvent).toMatchObject({
    actor_id: zhangId,
    target_kind: 'group',
    target_id: group.data.id,
    data: { slug: 'shop', name: '商城组' },
  });

  const p = await call('POST', '/api/projects', { name: '商城', groupId: group.data.id }, login.cookie);
  expect(p.status).toBe(201);
  const pid = p.data.id as string;
  const [project] = await events('project.create');
  expect(project).toMatchObject({
    actor_id: zhangId,
    target_kind: 'project',
    target_id: pid,
    data: { name: '商城' },
  });

  const li = await call(
    'POST',
    '/api/admin/users',
    { username: 'li', name: '李四', password: 'password2' },
    admin.cookie,
  );
  expect(li.status).toBe(201);
  expect(
    (
      await call(
        'POST',
        `/api/projects/${pid}/grants`,
        { subjectKind: 'user', subjectId: li.data.id, role: 'editor' },
        login.cookie,
      )
    ).status,
  ).toBe(201);
  const [grant] = await events('grant.create');
  expect(grant).toMatchObject({
    actor_id: zhangId,
    target_kind: 'project',
    target_id: pid,
    data: { subjectKind: 'user', subjectId: li.data.id, role: 'editor', scope: 'project' },
  });

  await addTable(rooms, db, pid);
  expect((await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' }, login.cookie)).status).toBe(
    201,
  );
  const [version] = await events('version.publish');
  expect(version).toMatchObject({
    actor_id: zhangId,
    target_kind: 'version',
    data: { projectId: pid, name: 'v1', seq: 1, number: 1, verified: false },
  });

  expect((await call('POST', '/api/auth/logout', undefined, login.cookie)).status).toBe(200);
  const [logout] = await events('auth.logout');
  expect(logout).toMatchObject({ actor_id: zhangId });
});

test('环境、导入、拉取的审计字段（直接调用 audit 辅助函数）', async () => {
  const c = {
    req: { header: (name: string) => (name === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : undefined) },
  } as unknown as Context;
  const security: SecurityConfig = { trustProxy: true, publicUrl: null };
  await audit(
    db,
    c,
    {
      action: 'environment.create',
      actorKind: 'user',
      actorId: 'u1',
      targetKind: 'environment',
      targetId: 'e1',
      data: { projectId: 'p1', name: 'dev' },
    },
    security,
  );
  await audit(
    db,
    c,
    {
      action: 'environment.delete',
      actorKind: 'user',
      actorId: 'u1',
      targetKind: 'environment',
      targetId: 'e1',
    },
    security,
  );
  await audit(
    db,
    c,
    {
      action: 'model.import',
      actorKind: 'user',
      actorId: 'u1',
      targetKind: 'project',
      targetId: 'p1',
      data: { seq: 3, objects: 2 },
    },
    security,
  );
  await audit(
    db,
    c,
    {
      action: 'environment.pull',
      actorKind: 'user',
      actorId: 'u1',
      targetKind: 'environment',
      targetId: 'e1',
      data: { projectId: 'p1', seq: 4, objects: 5 },
    },
    security,
  );

  for (const action of ['environment.create', 'environment.delete', 'model.import', 'environment.pull']) {
    const [row] = await events(action);
    expect(row, action).toBeDefined();
    expect(row!.ip, action).toBe('10.0.0.1'); // trustProxy 下取 XFF 最后一个
  }
  const [pull] = await events('environment.pull');
  expect(pull!.data).toEqual({ projectId: 'p1', seq: 4, objects: 5 });
});

test('删除不存在的环境返回 404 且不写审计', async () => {
  await makeUser(db, 'delete');
  const u = await call('POST', '/api/auth/login', { username: 'delete', password: PASSWORD });
  const g = await call('POST', '/api/groups', { slug: 'delete-group', name: '删除组' }, u.cookie);
  const p = await call('POST', '/api/projects', { name: '空项目', groupId: g.data.id }, u.cookie);
  const pid = p.data.id as string;
  const r = await call('DELETE', `/api/projects/${pid}/environments/no-such-env`, undefined, u.cookie);
  expect(r.status).toBe(404);
  expect(r.data.error).toBe('环境不存在');
  expect(await events('environment.delete')).toHaveLength(0);
});
