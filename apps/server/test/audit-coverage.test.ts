// 审计覆盖：把“每个应审计的动作”列成一张表，逐项执行（或对外部依赖的动作直接调用 audit），
// 最后断言表里每个动作都真的写进了 audit_events，且没有表外的动作。
// environment.* / model.import / OIDC 相关动作需要真实 PG、影子库或 OIDC 提供方，
// 它们的路由级覆盖在 targets / oidc 集成测试里；这里用 audit() 直接写入，保证动作名不漂移。
import type { Context } from 'hono';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { audit } from '../src/audit.ts';
import { hashToken } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import type { SecurityConfig } from '../src/security.ts';
import { addTable, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'audit-coverage-secret-0123456789';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let rooms: ReturnType<typeof createApp>['rooms'];
let setupToken: string;
let adminCookie = '';

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

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
  app = created.app;
  rooms = created.rooms;
  setupToken = created.setupToken!;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
  const setup = await call('POST', '/api/setup', {
    token: setupToken,
    username: 'admin',
    name: '管理员',
    password: PASSWORD,
  });
  expect(setup.status).toBe(200);
  adminCookie = setup.cookie;
});

afterEach(async () => {
  await stop();
  await db.close();
});

test('每个应审计的动作都能在 audit_events 里找到', async () => {
  const fakeContext = {
    req: {
      header: (name: string) => (name === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : undefined),
    },
  } as unknown as Context;
  const security: SecurityConfig = { trustProxy: true, publicUrl: null };
  const directAudit = (action: string, targetKind: string | null = null, targetId: string | null = null) =>
    audit(db, fakeContext, { action, actorKind: 'user', actorId: null, targetKind, targetId }, security);

  const loginAdmin = await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  expect(loginAdmin.status).toBe(200);
  adminCookie = loginAdmin.cookie;
  const loginMember = await call(
    'POST',
    '/api/admin/users',
    {
      username: 'member',
      name: '成员',
      password: PASSWORD,
    },
    adminCookie,
  );
  expect(loginMember.status).toBe(201);
  const memberId = loginMember.data.id as string;
  const memberLogin = await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD });
  const memberCookie = memberLogin.cookie;

  const rows: { action: string; run: () => Promise<unknown> }[] = [
    // 账户
    {
      action: 'auth.login',
      run: async () =>
        expect(
          (await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD })).status,
        ).toBe(200),
    },
    {
      action: 'auth.login_failed',
      run: async () =>
        expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status).toBe(
          401,
        ),
    },
    {
      action: 'user.update',
      run: async () =>
        expect(
          (await call('PATCH', `/api/admin/users/${memberId}`, { name: '成员二' }, adminCookie)).status,
        ).toBe(200),
    },
    {
      action: 'user.update_self',
      run: async () =>
        expect((await call('PATCH', '/api/me', { name: '成员三' }, memberCookie)).status).toBe(200),
    },
    {
      action: 'user.password_change',
      run: async () =>
        expect(
          (
            await call(
              'POST',
              '/api/me/password',
              { oldPassword: PASSWORD, newPassword: 'password2' },
              memberCookie,
            )
          ).status,
        ).toBe(200),
    },
    {
      // 纯 OIDC 用户第一次设置密码（没有密码就登录不了，所以直接插一个会话）
      action: 'user.password_set',
      run: async () => {
        const u = await call(
          'POST',
          '/api/admin/users',
          { username: 'oidc-only', name: '外部用户' },
          adminCookie,
        );
        expect(u.status).toBe(201);
        const token = 'audit-oidc-only-session';
        await db.query('insert into sessions (id, token_hash, user_id, expires_at) values ($1, $2, $3, $4)', [
          'audit-oidc-only-session',
          hashToken(token),
          u.data.id as string,
          new Date(Date.now() + 3600_000).toISOString(),
        ]);
        expect(
          (
            await call(
              'POST',
              '/api/me/password',
              { newPassword: 'first-password' },
              `dowel_session=${token}`,
            )
          ).status,
        ).toBe(200);
      },
    },
    {
      action: 'user.reset_link',
      run: async () =>
        expect((await call('POST', `/api/admin/users/${memberId}/reset-link`, {}, adminCookie)).status).toBe(
          200,
        ),
    },
    // 邀请与注册
    {
      action: 'user.invite',
      run: async () => expect((await call('POST', '/api/admin/invites', {}, adminCookie)).status).toBe(201),
    },
    {
      action: 'invite.accept',
      run: async () => {
        const invite = (await call('POST', '/api/admin/invites', {}, adminCookie)).data.token as string;
        expect(
          (
            await call('POST', `/api/invites/${invite}/accept`, {
              username: 'invited',
              name: '被邀请的人',
              password: PASSWORD,
            })
          ).status,
        ).toBe(200);
      },
    },
    {
      action: 'invite.revoke',
      run: async () => {
        const invite = await call('POST', '/api/admin/invites', {}, adminCookie);
        expect(
          (await call('DELETE', `/api/admin/invites/${invite.data.id as string}`, undefined, adminCookie))
            .status,
        ).toBe(200);
      },
    },
    {
      action: 'user.password_reset',
      run: async () => {
        const reset = await call('POST', `/api/admin/users/${memberId}/reset-link`, {}, adminCookie);
        expect(
          (await call('POST', `/api/reset/${reset.data.token as string}`, { password: 'password3' })).status,
        ).toBe(200);
      },
    },
    {
      action: 'session.revoke',
      run: async () => {
        const again = await call('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
        const sessions = (await call('GET', '/api/me/sessions', undefined, again.cookie)).data as unknown as {
          id: string;
          current: boolean;
        }[];
        const other = sessions.find((s) => !s.current)!;
        expect((await call('DELETE', `/api/me/sessions/${other.id}`, undefined, again.cookie)).status).toBe(
          200,
        );
      },
    },
    {
      action: 'auth.logout',
      run: async () => {
        const fresh = await call('POST', '/api/auth/login', { username: 'member', password: 'password3' });
        expect(fresh.status).toBe(200);
        expect((await call('POST', '/api/auth/logout', undefined, fresh.cookie)).status).toBe(200);
      },
    },
    // 组
    {
      action: 'group.create',
      run: async () =>
        expect(
          (await call('POST', '/api/groups', { slug: 'shop', name: '商城组' }, adminCookie)).status,
        ).toBe(201),
    },
    {
      action: 'group.update',
      run: async () =>
        expect((await call('PATCH', '/api/groups/shop', { name: '商城组二' }, adminCookie)).status).toBe(200),
    },
    {
      action: 'group.member_add',
      run: async () =>
        expect(
          (await call('POST', '/api/groups/shop/members', { username: 'invited' }, adminCookie)).status,
        ).toBe(200),
    },
    {
      action: 'group.member_update',
      run: async () => {
        const invited = (await call('GET', '/api/admin/users?q=invited', undefined, adminCookie))
          .data as unknown as { id: string }[];
        expect(
          (await call('PATCH', `/api/groups/shop/members/${invited[0]!.id}`, { role: 'admin' }, adminCookie))
            .status,
        ).toBe(200);
      },
    },
    {
      action: 'group.member_remove',
      run: async () => {
        const invited = (await call('GET', '/api/admin/users?q=invited', undefined, adminCookie))
          .data as unknown as { id: string }[];
        expect(
          (await call('DELETE', `/api/groups/shop/members/${invited[0]!.id}`, undefined, adminCookie)).status,
        ).toBe(200);
      },
    },
    {
      action: 'group.delete',
      run: async () => {
        await call('POST', '/api/groups', { slug: 'empty', name: '空组' }, adminCookie);
        expect((await call('DELETE', '/api/groups/empty', undefined, adminCookie)).status).toBe(200);
      },
    },
    // 项目
    {
      action: 'project.create',
      run: async () => {
        const groups = (await call('GET', '/api/groups', undefined, adminCookie)).data as unknown as {
          groups: { slug: string; id: string }[];
        };
        const g = groups.groups.find((x) => x.slug === 'shop')!;
        expect(
          (await call('POST', '/api/projects', { name: '商城', groupId: g.id }, adminCookie)).status,
        ).toBe(201);
      },
    },
    {
      action: 'project.update',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (await call('PATCH', `/api/projects/${p[0]!.id}`, { name: '商城二' }, adminCookie)).status,
        ).toBe(200);
      },
    },
    {
      action: 'project.slug',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (await call('PATCH', `/api/projects/${p[0]!.id}`, { slug: 'shop-2' }, adminCookie)).status,
        ).toBe(200);
      },
    },
    {
      action: 'project.default_role',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (await call('PATCH', `/api/projects/${p[0]!.id}`, { defaultRole: 'editor' }, adminCookie)).status,
        ).toBe(200);
      },
    },
    {
      action: 'project.delete',
      run: async () => {
        const group = await call('POST', '/api/groups', { slug: 'doomed', name: '待删组' }, adminCookie);
        expect(group.status).toBe(201);
        const created = await call(
          'POST',
          '/api/projects',
          { name: '待删项目', groupId: group.data.id as string },
          adminCookie,
        );
        expect(created.status).toBe(201);
        expect(
          (
            await call(
              'DELETE',
              `/api/projects/${created.data.id as string}`,
              { confirm: created.data.slug as string },
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    {
      action: 'version.publish',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        await addTable(rooms, db, p[0]!.id);
        expect(
          (await call('POST', `/api/projects/${p[0]!.id}/versions`, { name: 'v1' }, adminCookie)).status,
        ).toBe(201);
      },
    },
    {
      // 编辑冻结脚本（只改最新版本）：在上一行发布的版本上多加一步
      action: 'version.edit_steps',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        const vs = (await call('GET', `/api/projects/${p[0]!.id}/versions`, undefined, adminCookie))
          .data as unknown as { id: string }[];
        const d = (
          await call('GET', `/api/projects/${p[0]!.id}/versions/${vs[0]!.id}`, undefined, adminCookie)
        ).data as unknown as { upSteps: { sql: string; transactional: boolean }[]; downSteps: unknown[] };
        expect(
          (
            await call(
              'PATCH',
              `/api/projects/${p[0]!.id}/versions/${vs[0]!.id}/steps`,
              { up: [...d.upSteps, { sql: 'SELECT 1', transactional: true }], down: d.downSteps },
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    // 重新验证需要真实 PG 影子库：路由级覆盖在 versions.test.ts，这里直接写审计保证动作名不漂移
    { action: 'version.verify', run: () => directAudit('version.verify', 'version', 'v1') },
    {
      action: 'grant.create',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (
            await call(
              'POST',
              `/api/projects/${p[0]!.id}/grants`,
              { subjectKind: 'user', subjectId: memberId, role: 'viewer' },
              adminCookie,
            )
          ).status,
        ).toBe(201);
      },
    },
    {
      action: 'grant.update',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        const grants = (await call('GET', `/api/projects/${p[0]!.id}/grants`, undefined, adminCookie))
          .data as unknown as { grants: { id: string }[] };
        expect(
          (
            await call(
              'PATCH',
              `/api/projects/${p[0]!.id}/grants/${grants.grants[0]!.id}`,
              { role: 'editor' },
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    {
      action: 'grant.delete',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        const grants = (await call('GET', `/api/projects/${p[0]!.id}/grants`, undefined, adminCookie))
          .data as unknown as { grants: { id: string }[] };
        expect(
          (
            await call(
              'DELETE',
              `/api/projects/${p[0]!.id}/grants/${grants.grants[0]!.id}`,
              undefined,
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    {
      action: 'project.transfer',
      run: async () => {
        const target = await call('POST', '/api/groups', { slug: 'target', name: '目标组' }, adminCookie);
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (await call('POST', `/api/projects/${p[0]!.id}/transfer`, { groupId: target.data.id }, adminCookie))
            .status,
        ).toBe(200);
      },
    },
    // 实例设置
    {
      action: 'instance.settings_update',
      run: async () =>
        expect((await call('PATCH', '/api/admin/settings', { name: '示例公司' }, adminCookie)).status).toBe(
          200,
        ),
    },
    // 需要真实 PG / 影子库的动作（路由级覆盖在 targets 测试里）
    { action: 'environment.create', run: () => directAudit('environment.create', 'environment', 'e1') },
    { action: 'environment.delete', run: () => directAudit('environment.delete', 'environment', 'e1') },
    { action: 'environment.pull', run: () => directAudit('environment.pull', 'environment', 'e1') },
    // P4b：环境的修改、执行、回滚、写基线（路由级覆盖在 executions.test.ts / exec-policy.test.ts 里）
    { action: 'environment.update', run: () => directAudit('environment.update', 'environment', 'e1') },
    { action: 'environment.execute', run: () => directAudit('environment.execute', 'environment', 'e1') },
    { action: 'environment.rollback', run: () => directAudit('environment.rollback', 'environment', 'e1') },
    { action: 'environment.baseline', run: () => directAudit('environment.baseline', 'environment', 'e1') },
    // P4c：接手、认领、接入已有历史（路由级覆盖在 takeover.test.ts）
    { action: 'project.takeover', run: () => directAudit('project.takeover', 'project', 'p1') },
    { action: 'project.claim', run: () => directAudit('project.claim', 'environment', 'e1') },
    {
      action: 'environment.attach_history',
      run: () => directAudit('environment.attach_history', 'environment', 'e1'),
    },
    // 标记为已执行（路由级覆盖在 drift.test.ts）
    { action: 'environment.mark', run: () => directAudit('environment.mark', 'environment', 'e1') },
    // 执行策略（P5a）：四层共用一个动作，targetKind 是层；路由级覆盖（组 / 项目 / 环境层）在 policy-routes.test.ts
    {
      action: 'exec_policy.update',
      run: async () =>
        expect(
          (
            await call(
              'PUT',
              '/api/admin/exec-policy',
              { production: { whoCanExecute: 'admin', lockTimeoutMs: 3000 } },
              adminCookie,
            )
          ).status,
        ).toBe(200),
    },
    // P5b：执行申请的每一步、紧急执行（路由级覆盖在 requests.test.ts，需要真实目标库）
    { action: 'exec_request.create', run: () => directAudit('exec_request.create', 'exec_request', 'r1') },
    { action: 'exec_request.approve', run: () => directAudit('exec_request.approve', 'exec_request', 'r1') },
    { action: 'exec_request.reject', run: () => directAudit('exec_request.reject', 'exec_request', 'r1') },
    {
      action: 'exec_request.withdraw',
      run: () => directAudit('exec_request.withdraw', 'exec_request', 'r1'),
    },
    {
      action: 'exec_request.invalidate',
      run: () => directAudit('exec_request.invalidate', 'exec_request', 'r1'),
    },
    { action: 'exec_request.expire', run: () => directAudit('exec_request.expire', 'exec_request', 'r1') },
    { action: 'exec_request.execute', run: () => directAudit('exec_request.execute', 'exec_request', 'r1') },
    { action: 'exec_request.finish', run: () => directAudit('exec_request.finish', 'exec_request', 'r1') },
    {
      action: 'environment.emergency',
      run: () => directAudit('environment.emergency', 'exec_request', 'r1'),
    },
    // P5b：组级 Webhook 的配置与发送测试（路由级覆盖在 webhooks.test.ts）
    { action: 'webhook.create', run: () => directAudit('webhook.create', 'webhook', 'w1') },
    { action: 'webhook.update', run: () => directAudit('webhook.update', 'webhook', 'w1') },
    { action: 'webhook.delete', run: () => directAudit('webhook.delete', 'webhook', 'w1') },
    { action: 'webhook.test', run: () => directAudit('webhook.test', 'webhook', 'w1') },
    { action: 'model.import', run: () => directAudit('model.import', 'project', 'p1') },
    {
      action: 'model.restore',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        // 前面 version.publish 已经向工作副本加了 orders 表（seq >= 1），取当前 workingSeq 后恢复到初始状态 seq = 0
        const hist = (await call('GET', `/api/projects/${p[0]!.id}/history`, undefined, adminCookie))
          .data as unknown as { currentSeq: number };
        expect(
          (
            await call(
              'POST',
              `/api/projects/${p[0]!.id}/history/0/restore`,
              { workingSeq: hist.currentSeq },
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    // P6：CI 令牌创建 / 吊销、谁能创建令牌规则
    {
      action: 'token_policy.update',
      run: async () =>
        expect(
          (
            await call(
              'PUT',
              '/api/admin/token-policy',
              { rule: { roles: ['admin'], groups: [] } },
              adminCookie,
            )
          ).status,
        ).toBe(200),
    },
    {
      action: 'ci_token.create',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        expect(
          (await call('POST', `/api/projects/${p[0]!.id}/tokens`, { name: 'ci' }, adminCookie)).status,
        ).toBe(201);
      },
    },
    {
      action: 'ci_token.revoke',
      run: async () => {
        const p = (await call('GET', '/api/projects', undefined, adminCookie)).data as unknown as {
          id: string;
        }[];
        const list = (await call('GET', `/api/projects/${p[0]!.id}/tokens`, undefined, adminCookie))
          .data as unknown as { tokens: { id: string }[] };
        expect(
          (
            await call(
              'POST',
              `/api/projects/${p[0]!.id}/tokens/${list.tokens[0]!.id}/revoke`,
              {},
              adminCookie,
            )
          ).status,
        ).toBe(200);
      },
    },
    // OIDC 动作（路由级覆盖在 oidc.test.ts 里）
    { action: 'oidc.provider_create', run: () => directAudit('oidc.provider_create', 'oidc_provider', 'o1') },
    { action: 'oidc.provider_update', run: () => directAudit('oidc.provider_update', 'oidc_provider', 'o1') },
    { action: 'oidc.provider_delete', run: () => directAudit('oidc.provider_delete', 'oidc_provider', 'o1') },
    { action: 'auth.oidc_login', run: () => directAudit('auth.oidc_login', 'user', 'u1') },
    { action: 'auth.oidc_login_failed', run: () => directAudit('auth.oidc_login_failed') },
    { action: 'identity.link', run: () => directAudit('identity.link', 'user', 'u1') },
    { action: 'identity.unlink', run: () => directAudit('identity.unlink', 'user', 'u1') },
  ];

  // instance.setup 已经在 beforeEach 里执行；user.create 在准备 member 时执行
  for (const row of rows) await row.run();

  const seenRows = await db.query<{ action: string }>('select distinct action from audit_events');
  const seen = new Set(seenRows.map((r) => r.action));
  const expected = new Set([...rows.map((r) => r.action), 'instance.setup', 'user.create']);
  for (const action of expected) expect(seen.has(action), `缺少审计动作：${action}`).toBe(true);
  expect([...seen].sort()).toEqual([...expected].sort());
});
