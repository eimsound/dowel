// 账户集成测试：初始化、实例设置、密码登录开关、邀请、重置密码、用户管理、个人设置。
// 用 app.request 直接打 HTTP（不需要真实端口）；SQLite 用内存库，PostgreSQL 用测试实例（没有 Docker 时跳过）。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InstanceInfo, Me, SessionInfo } from '@dowel/api';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import type { AppOptions } from '../src/app.ts';
import { hashToken } from '../src/auth.ts';
import { bootstrapAdmin, createApp, openPlatformDb, type PlatformDb, writeSettings } from '../src/index.ts';
import { makeUser, PASSWORD } from './support.ts';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let pg: Awaited<ReturnType<typeof createTestDb>> | undefined;
const tempDirs: string[] = [];

const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dowel-acc-test-'));
  tempDirs.push(dir);
  return dir;
};

const boot = async (options: AppOptions = {}) => {
  const created = createApp(db, options);
  app = created.app;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
};

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('账户（平台库：$platform）', ({ platform, skip }) => {
  beforeEach(async () => {
    if (skip) return;
    pg = platform === 'pg' ? await createTestDb('accounts') : undefined;
    db = await openPlatformDb(pg?.url ?? ':memory:');
    await boot();
  });

  afterEach(async () => {
    if (skip) return;
    await stop();
    await db.close();
    await pg?.close();
    pg = undefined;
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
      data: data as Record<string, unknown> & unknown[],
      cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
    };
  };

  /** 直接写库建一个无需改密的实例管理员，返回它的会话 cookie 和用户 ID */
  const setupAdmin = async (username = 'admin') => {
    const u = await makeUser(db, username, { name: '管理员', role: 'admin' });
    const cookie = await login(username);
    return { cookie, id: u.id };
  };

  /** 管理员建一个普通用户（带初始密码时会置 mustChangePassword），并在辅助里清理标志以便既有流程直接用 */
  const createMember = async (admin: string, username: string, password = PASSWORD) => {
    const r = await call('POST', '/api/admin/users', { username, name: username, password }, admin);
    expect(r.status).toBe(201);
    expect(r.data.mustChangePassword).toBe(true);
    await db.query('update users set must_change_password = $2 where id = $1', [r.data.id, false]);
    return r.data.id as string;
  };

  const login = async (username: string, password = PASSWORD) => {
    const r = await call('POST', '/api/auth/login', { username, password });
    expect(r.status).toBe(200);
    return r.cookie;
  };

  test.skipIf(skip)('废除 /setup：首次启动写 0600 临时密码，登录后强制改密并清理初始文件', async () => {
    expect((await call('GET', '/api/setup')).status).toBe(404);
    expect(
      (await call('POST', '/api/setup', { token: 'x', username: 'a', name: 'A', password: PASSWORD })).status,
    ).toBe(404);

    const inst = await call('GET', '/api/instance');
    expect(inst.status).toBe(200);
    expect(inst.data).toMatchObject({ name: 'Dowel', passwordLogin: true, providers: [] });
    expect('needsSetup' in inst.data).toBe(false);

    const dir = makeTempDir();
    const pwFile = join(dir, 'initial-admin-password');
    const bootRes = await bootstrapAdmin(db, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } });
    expect(bootRes.source).toBe('generated');
    expect(bootRes.bootstrapUsername).toBe('admin');
    expect(bootRes.initialAdminPasswordFile).toBe(pwFile);
    expect(bootRes.created).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: true });
    expect(statSync(pwFile).mode & 0o777).toBe(0o600);
    const tempPw = readFileSync(pwFile, 'utf8').trim();
    expect(tempPw).toHaveLength(24);

    // 再次执行幂等不覆盖
    const second = await bootstrapAdmin(db, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } });
    expect(second.created).toBeNull();
    expect(readFileSync(pwFile, 'utf8').trim()).toBe(tempPw);

    await stop();
    await boot({
      initialAdminPasswordFile: bootRes.initialAdminPasswordFile,
      bootstrapUsername: bootRes.bootstrapUsername,
    });

    const firstLogin = await call('POST', '/api/auth/login', { username: 'admin', password: tempPw });
    expect(firstLogin.status).toBe(200);
    expect(firstLogin.data).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: true });
    const otherLogin = await call('POST', '/api/auth/login', { username: 'admin', password: tempPw });
    expect(otherLogin.status).toBe(200);

    // 允许 GET /api/auth/me，但其它已认证端点与 SSE / OIDC link 一律 403 password_change_required
    expect((await call('GET', '/api/auth/me', undefined, firstLogin.cookie)).data).toMatchObject({
      mustChangePassword: true,
    });
    for (const [m, p, b] of [
      ['GET', '/api/projects'],
      ['PATCH', '/api/me', { name: '新名' }],
      ['GET', '/api/me/sessions'],
      ['GET', '/api/me/inbox/stream'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/groups', { slug: 'g', name: 'G' }],
      ['GET', '/api/directory'],
    ] as const) {
      const blocked = await call(m, p, b, firstLogin.cookie);
      expect(blocked.status, `${m} ${p}`).toBe(403);
      expect(blocked.data).toMatchObject({ code: 'password_change_required' });
    }
    await db.query(
      `insert into oidc_providers (id, slug, name, issuer, client_id, client_secret_enc, enabled, auto_provision)
       values ('acc-oidc-id', 'acc-oidc', 'Acc OIDC', 'https://idp.example', 'cid', 'enc', true, false)`,
    );
    try {
      const oidcLinkBlocked = await call(
        'GET',
        '/api/auth/oidc/acc-oidc/start?mode=link',
        undefined,
        firstLogin.cookie,
      );
      expect(oidcLinkBlocked.status).toBe(403);
      expect(oidcLinkBlocked.data).toMatchObject({ code: 'password_change_required' });
    } finally {
      await db.query("delete from oidc_providers where id = 'acc-oidc-id'");
    }

    // 强制改密不允许新密码与临时密码相同
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: tempPw, newPassword: tempPw },
          firstLogin.cookie,
        )
      ).status,
    ).toBe(400);

    // 强制改密期间也允许退出
    expect((await call('POST', '/api/auth/logout', undefined, otherLogin.cookie)).status).toBe(200);
    const thirdLogin = await call('POST', '/api/auth/login', { username: 'admin', password: tempPw });

    // 完成改密：清除标志、删除自动生成的密码文件、吊销其他会话并保留当前会话
    const changed = await call(
      'POST',
      '/api/me/password',
      { oldPassword: tempPw, newPassword: PASSWORD },
      firstLogin.cookie,
    );
    expect(changed.status).toBe(200);
    expect(existsSync(pwFile)).toBe(false);
    expect((await call('GET', '/api/auth/me', undefined, firstLogin.cookie)).data).toMatchObject({
      mustChangePassword: false,
    });
    expect((await call('GET', '/api/auth/me', undefined, thirdLogin.cookie)).status).toBe(401);
    expect((await call('GET', '/api/projects', undefined, firstLogin.cookie)).status).toBe(200);
    expect(await login('admin', PASSWORD)).toBeTruthy();
  });

  test.skipIf(skip)(
    '运维预设密码（DOWEL_ADMIN_PASSWORD_FILE / DOWEL_ADMIN_PASSWORD）：无需强制改密、绝不删文件且互斥报错',
    async () => {
      const dir = makeTempDir();
      const opFile = join(dir, 'op-secret');
      writeFileSync(opFile, `\n  ${PASSWORD}-op-file \n`, { mode: 0o600 });

      await expect(
        bootstrapAdmin(db, { env: { DOWEL_ADMIN_PASSWORD_FILE: opFile, DOWEL_ADMIN_PASSWORD: PASSWORD } }),
      ).rejects.toThrow(/DOWEL_ADMIN_PASSWORD_FILE/);

      const emptyFile = join(dir, 'empty');
      writeFileSync(emptyFile, '   \n');
      await expect(bootstrapAdmin(db, { env: { DOWEL_ADMIN_PASSWORD_FILE: emptyFile } })).rejects.toThrow(
        /不能为空/,
      );

      const shortFile = join(dir, 'short');
      writeFileSync(shortFile, '1234567\n');
      await expect(bootstrapAdmin(db, { env: { DOWEL_ADMIN_PASSWORD_FILE: shortFile } })).rejects.toThrow(
        /不合法/,
      );

      await expect(
        bootstrapAdmin(db, { env: { DOWEL_ADMIN_PASSWORD_FILE: join(dir, 'missing') } }),
      ).rejects.toThrow(/无法读取/);

      const bootRes = await bootstrapAdmin(db, {
        env: { DOWEL_ADMIN_USERNAME: 'OpsRoot', DOWEL_ADMIN_PASSWORD_FILE: opFile },
      });
      expect(bootRes.source).toBe('file');
      expect(bootRes.initialAdminPasswordFile).toBeNull();
      expect(bootRes.bootstrapUsername).toBe('opsroot');
      expect(bootRes.created).toMatchObject({
        username: 'opsroot',
        name: 'opsroot',
        role: 'admin',
        mustChangePassword: false,
      });

      const cookie = await login('opsroot', `${PASSWORD}-op-file`);
      expect((await call('GET', '/api/projects', undefined, cookie)).status).toBe(200);
      expect(
        (
          await call(
            'POST',
            '/api/me/password',
            { oldPassword: `${PASSWORD}-op-file`, newPassword: 'new-op-password' },
            cookie,
          )
        ).status,
      ).toBe(200);
      // 运维提供的新密码文件绝不会被删除或覆盖
      expect(readFileSync(opFile, 'utf8')).toBe(`\n  ${PASSWORD}-op-file \n`);

      // 清库后测 DOWEL_ADMIN_PASSWORD
      await db.query('delete from sessions');
      await db.query('delete from users');
      const envRes = await bootstrapAdmin(db, {
        env: { DOWEL_ADMIN_USERNAME: 'root', DOWEL_ADMIN_PASSWORD: PASSWORD },
      });
      expect(envRes.source).toBe('env');
      expect(envRes.initialAdminPasswordFile).toBeNull();
      expect(envRes.created).toMatchObject({
        username: 'root',
        role: 'admin',
        mustChangePassword: false,
      });
      expect(await login('root', PASSWORD)).toBeTruthy();
    },
  );

  test.skipIf(skip)('实例设置：只有实例管理员能读写，公开接口返回登录页需要的信息', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const member = await login('member');

    // 未登录 401、普通用户 403
    expect((await call('GET', '/api/admin/settings')).status).toBe(401);
    expect((await call('PATCH', '/api/admin/settings', { name: 'x' })).status).toBe(401);
    expect((await call('GET', '/api/admin/settings', undefined, member)).status).toBe(403);
    expect((await call('PATCH', '/api/admin/settings', { name: 'x' }, member)).status).toBe(403);

    const settings = (await call('GET', '/api/admin/settings', undefined, admin.cookie)).data;
    expect(settings).toEqual({
      name: 'Dowel',
      groupCreation: 'all',
      passwordLogin: true,
      // P3：服务端能连到哪里（空表示不限制）；SSRF 的开关
      connectionAllowlist: [],
      // P5b：Webhook 出站额外放行的地址（默认只允许公网）
      webhookAllowlist: [],
      // P4a：实例唯一标识，首次启动时生成，只读
      instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    const instanceId = settings.instanceId as string;

    const patched = await call(
      'PATCH',
      '/api/admin/settings',
      { name: '示例公司', groupCreation: 'admin' },
      admin.cookie,
    );
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ name: '示例公司', groupCreation: 'admin', instanceId });
    // instanceId 只读：请求里带了也不会改（被忽略），重启（重新打开平台库）后仍然不变
    const tamper = await call(
      'PATCH',
      '/api/admin/settings',
      { instanceId: 'forged', name: '示例公司' },
      admin.cookie,
    );
    expect(tamper.status).toBe(200);
    expect(tamper.data.instanceId).toBe(instanceId);
    expect((await call('GET', '/api/instance')).data).toMatchObject({ name: '示例公司' });
  });

  test.skipIf(skip)('关闭密码登录：没有 OIDC 时拒绝；关闭后登录 403，应急变量可以强制允许', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');

    // 现在一定没有 OIDC 提供方，关闭密码登录会把人锁在外面
    const refused = await call('PATCH', '/api/admin/settings', { passwordLogin: false }, admin.cookie);
    expect(refused.status).toBe(422);
    expect(String(refused.data.error)).toContain('OIDC');
    expect((await call('GET', '/api/admin/settings', undefined, admin.cookie)).data.passwordLogin).toBe(true);

    // 直接写库模拟“以后有了 OIDC 提供方”
    await writeSettings(db, { passwordLogin: false });
    const denied = await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD });
    expect(denied.status).toBe(403);
    expect((await call('GET', '/api/instance')).data).toMatchObject<Partial<InstanceInfo>>({
      passwordLogin: false,
    });

    // 应急入口：DOWEL_ALLOW_PASSWORD_LOGIN=1（这里通过 createApp 选项注入）
    await stop();
    await boot({ allowPasswordLogin: true });
    expect((await call('GET', '/api/instance')).data).toMatchObject<Partial<InstanceInfo>>({
      passwordLogin: true,
    });
    expect((await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD })).status).toBe(
      200,
    );
  });

  test.skipIf(skip)('邀请：创建、查看、接受、重复使用、撤销、过期、用户名冲突', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const member = await login('member');

    // 只有实例管理员能创建和列出邀请
    expect((await call('POST', '/api/admin/invites', {})).status).toBe(401);
    expect((await call('POST', '/api/admin/invites', {}, member)).status).toBe(403);
    expect((await call('GET', '/api/admin/invites', undefined, member)).status).toBe(403);

    const created = await call('POST', '/api/admin/invites', {}, admin.cookie);
    expect(created.status).toBe(201);
    const token = created.data.token as string;
    const url = created.data.url as string;
    expect(url).toBe(`/invite/${token}`);
    // 默认 7 天
    const days = (Date.parse(created.data.expiresAt as string) - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({
      valid: true,
      state: 'ok',
      instanceName: 'Dowel',
    });
    expect((await call('GET', '/api/invites/no-such-token')).data).toMatchObject({
      valid: false,
      state: 'missing',
    });

    // 用户名冲突：409，且邀请还能继续用
    expect(
      (
        await call('POST', `/api/invites/${token}/accept`, {
          username: 'member',
          name: '撞名',
          password: PASSWORD,
        })
      ).status,
    ).toBe(409);

    const accepted = await call('POST', `/api/invites/${token}/accept`, {
      username: 'invited',
      name: '被邀请的人',
      email: 'invited@x.com',
      password: 'password2',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.data).toMatchObject({ username: 'invited', role: 'member', email: 'invited@x.com' });
    expect((await call('GET', '/api/auth/me', undefined, accepted.cookie)).status).toBe(200);
    expect(await login('invited', 'password2')).toBeTruthy();

    // 令牌随即作废
    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({ state: 'used' });
    expect(
      (
        await call('POST', `/api/invites/${token}/accept`, {
          username: 'again',
          name: '再用一次',
          password: PASSWORD,
        })
      ).status,
    ).toBe(410);

    // 管理员能看到这条已使用的邀请
    const list = await call('GET', '/api/admin/invites', undefined, admin.cookie);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ createdBy: 'admin', usedBy: 'invited', state: 'used' });

    // 撤销
    const second = await call('POST', '/api/admin/invites', {}, admin.cookie);
    const secondToken = second.data.token as string;
    const revoked = await call(
      'DELETE',
      `/api/admin/invites/${second.data.id as string}`,
      undefined,
      admin.cookie,
    );
    expect(revoked.status).toBe(200);
    expect((await call('GET', `/api/invites/${secondToken}`)).data).toMatchObject({ state: 'revoked' });
    expect(
      (
        await call('POST', `/api/invites/${secondToken}/accept`, {
          username: 'revoked-one',
          name: '撤销',
          password: PASSWORD,
        })
      ).status,
    ).toBe(410);

    // 过期
    const third = await call('POST', '/api/admin/invites', { expiresInDays: 1 }, admin.cookie);
    await db.query('update invites set expires_at = $2 where id = $1', [
      third.data.id,
      new Date(Date.now() - 1000).toISOString(),
    ]);
    expect((await call('GET', `/api/invites/${third.data.token as string}`)).data).toMatchObject({
      state: 'expired',
    });
    expect(
      (
        await call('POST', `/api/invites/${third.data.token as string}/accept`, {
          username: 'expired-one',
          name: '过期',
          password: PASSWORD,
        })
      ).status,
    ).toBe(410);

    // 所有动作都写审计
    const actions = await db.query<{ action: string }>(
      "select action from audit_events where action in ('user.invite','invite.accept','invite.revoke')",
    );
    expect(new Set(actions.map((a) => a.action))).toEqual(
      new Set(['user.invite', 'invite.accept', 'invite.revoke']),
    );
  });

  test.skipIf(skip)('用户管理：管理员直接建用户；非管理员 403、未登录 401；可以搜索和修改', async () => {
    const admin = await setupAdmin();

    expect(
      (await call('POST', '/api/admin/users', { username: 'x', name: 'X', password: PASSWORD })).status,
    ).toBe(401);
    const memberId = await createMember(admin.cookie, 'member');
    const member = await login('member');
    expect(
      (await call('POST', '/api/admin/users', { username: 'y', name: 'Y', password: PASSWORD }, member))
        .status,
    ).toBe(403);
    expect((await call('GET', '/api/admin/users', undefined, member)).status).toBe(403);
    expect((await call('PATCH', `/api/admin/users/${memberId}`, { name: 'Z' }, member)).status).toBe(403);

    // 用户名格式、冲突
    expect(
      (await call('POST', '/api/admin/users', { username: 'Bad_Name', name: 'X' }, admin.cookie)).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/admin/users', { username: '-bad', name: 'X' }, admin.cookie)).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/admin/users', { username: 'member', name: 'X' }, admin.cookie)).status,
    ).toBe(409);

    // 邮箱选填、不唯一
    expect(
      (
        await call(
          'POST',
          '/api/admin/users',
          { username: 'one', name: '一号', email: 'same@x.com' },
          admin.cookie,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await call(
          'POST',
          '/api/admin/users',
          { username: 'two', name: '二号', email: 'same@x.com' },
          admin.cookie,
        )
      ).status,
    ).toBe(201);
    // 没给密码的用户暂时不能密码登录
    expect((await call('POST', '/api/auth/login', { username: 'one', password: PASSWORD })).status).toBe(401);

    // 搜索用户名 / 显示名 / 邮箱
    const byName = await call('GET', '/api/admin/users?q=%E4%BA%8C%E5%8F%B7', undefined, admin.cookie);
    expect((byName.data as unknown as { username: string }[]).map((u) => u.username)).toEqual(['two']);
    const byEmail = await call('GET', '/api/admin/users?q=same@x.com', undefined, admin.cookie);
    expect((byEmail.data as unknown as { username: string }[]).map((u) => u.username).sort()).toEqual([
      'one',
      'two',
    ]);

    // 改名、改角色
    const patched = await call(
      'PATCH',
      `/api/admin/users/${memberId}`,
      { name: '会员', role: 'admin' },
      admin.cookie,
    );
    expect(patched.status).toBe(200);
    expect(patched.data).toMatchObject({ username: 'member', name: '会员', role: 'admin' });
    const [updated] = await db.query<{ action: string; data: unknown }>(
      "select action, data from audit_events where action = 'user.update'",
    );
    expect(updated).toBeDefined();
  });

  test.skipIf(skip)('停用用户：已有会话立即失效，也不能再登录', async () => {
    const admin = await setupAdmin();
    const memberId = await createMember(admin.cookie, 'member');
    const member = await login('member');
    expect((await call('GET', '/api/projects', undefined, member)).status).toBe(200);

    const r = await call('PATCH', `/api/admin/users/${memberId}`, { status: 'disabled' }, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ status: 'disabled' });
    expect((await call('GET', '/api/projects', undefined, member)).status).toBe(401);
    expect((await call('GET', '/api/auth/me', undefined, member)).status).toBe(401);
    expect(await db.query('select id from sessions where user_id = $1', [memberId])).toEqual([]);

    const denied = await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD });
    expect(denied.status).toBe(403);
    expect(String(denied.data.error)).toContain('停用');

    // 重新启用后可以登录（旧会话不会复活）
    expect(
      (await call('PATCH', `/api/admin/users/${memberId}`, { status: 'active' }, admin.cookie)).status,
    ).toBe(200);
    expect(await login('member')).toBeTruthy();
    expect((await call('GET', '/api/projects', undefined, member)).status).toBe(401);
  });

  test.skipIf(skip)('最后一个实例管理员不能被停用或降级', async () => {
    const admin = await setupAdmin();
    expect(
      (await call('PATCH', `/api/admin/users/${admin.id}`, { status: 'disabled' }, admin.cookie)).status,
    ).toBe(422);
    expect(
      (await call('PATCH', `/api/admin/users/${admin.id}`, { role: 'member' }, admin.cookie)).status,
    ).toBe(422);

    // 有了第二个管理员之后就可以了
    const second = await call(
      'POST',
      '/api/admin/users',
      { username: 'admin2', name: '管理员二', password: PASSWORD, role: 'admin' },
      admin.cookie,
    );
    expect(second.status).toBe(201);
    expect(
      (await call('PATCH', `/api/admin/users/${admin.id}`, { role: 'member' }, admin.cookie)).status,
    ).toBe(200);
    // 现在唯一的管理员是 admin2：不能再降级它
    const admin2 = await login('admin2');
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: PASSWORD, newPassword: 'admin2-new-password' },
          admin2,
        )
      ).status,
    ).toBe(200);
    expect(
      (await call('PATCH', `/api/admin/users/${second.data.id as string}`, { role: 'member' }, admin2))
        .status,
    ).toBe(422);
  });

  test.skipIf(skip)('重置密码链接：24 小时有效、一次性，设完新密码吊销所有会话', async () => {
    const admin = await setupAdmin();
    const memberId = await createMember(admin.cookie, 'member');
    const oldSession = await login('member');
    await login('member'); // 第二个会话

    const link = await call('POST', `/api/admin/users/${memberId}/reset-link`, undefined, admin.cookie);
    expect(link.status).toBe(200);
    expect(link.data.url).toBe(`/reset/${link.data.token as string}`);
    const hours = (Date.parse(link.data.expiresAt as string) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);

    // 重置链接不能当邀请用
    expect((await call('GET', `/api/invites/${link.data.token as string}`)).data).toMatchObject({
      state: 'missing',
    });

    const reset = await call('POST', `/api/reset/${link.data.token as string}`, {
      password: 'new-password',
    });
    expect(reset.status).toBe(200);
    expect((await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD })).status).toBe(
      401,
    );
    expect(
      (await call('POST', '/api/auth/login', { username: 'member', password: 'new-password' })).status,
    ).toBe(200);
    // 之前的会话全部失效
    expect((await call('GET', '/api/auth/me', undefined, oldSession)).status).toBe(401);
    expect(
      await db.query('select id from sessions where user_id = $1 and expires_at > $2', [
        memberId,
        new Date(),
      ]),
    ).toHaveLength(1);

    // 一次性
    expect(
      (await call('POST', `/api/reset/${link.data.token as string}`, { password: 'third-password' })).status,
    ).toBe(410);
    // 过期的重置链接
    const expired = await call('POST', `/api/admin/users/${memberId}/reset-link`, undefined, admin.cookie);
    await db.query('update invites set expires_at = $2 where id = $1', [
      expired.data.id ??
        (await db.query<{ id: string }>('select id from invites order by created_at desc limit 1'))[0]!.id,
      new Date(Date.now() - 1000).toISOString(),
    ]);
    expect(
      (await call('POST', `/api/reset/${expired.data.token as string}`, { password: 'third-password' }))
        .status,
    ).toBe(410);

    // 不存在的用户
    expect(
      (await call('POST', '/api/admin/users/no-such-user/reset-link', undefined, admin.cookie)).status,
    ).toBe(404);
  });

  test.skipIf(skip)('改密码：要旧密码，完成后吊销其他会话、保留当前会话', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const current = await login('member');
    const other = await login('member');

    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: 'wrong-one', newPassword: 'new-password' },
          current,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/me/password', { oldPassword: PASSWORD, newPassword: 'short' }, current))
        .status,
    ).toBe(400);

    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: PASSWORD, newPassword: 'new-password' },
          current,
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, current)).status).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, other)).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD })).status).toBe(
      401,
    );
    expect(
      (await call('POST', '/api/auth/login', { username: 'member', password: 'new-password' })).status,
    ).toBe(200);
  });

  test.skipIf(skip)('会话列表：标出当前会话，可以吊销其他会话', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const current = await login('member');
    await login('member');
    await login('member');

    const list = await call('GET', '/api/me/sessions', undefined, current);
    expect(list.status).toBe(200);
    const sessions = list.data as unknown as SessionInfo[];
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions.every((s) => s.createdAt && s.lastSeenAt)).toBe(true);
    // 不返回令牌哈希
    expect(Object.keys(sessions[0]!)).not.toContain('token_hash');

    const other = sessions.find((s) => !s.current)!;
    expect((await call('DELETE', `/api/me/sessions/${other.id}`, undefined, current)).status).toBe(200);
    expect(
      (await call('GET', '/api/me/sessions', undefined, current)).data as unknown as SessionInfo[],
    ).toHaveLength(2);
    expect((await call('DELETE', '/api/me/sessions/no-such-session', undefined, current)).status).toBe(404);

    // 吊销当前会话等于退出
    const mine = (list.data as unknown as SessionInfo[]).find((s) => s.current)!;
    expect((await call('DELETE', `/api/me/sessions/${mine.id}`, undefined, current)).status).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, current)).status).toBe(401);
  });

  test.skipIf(skip)('个人设置：改用户名 / 显示名 / 邮箱，用户名冲突', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const member = await login('member');

    const r = await call(
      'PATCH',
      '/api/me',
      { username: 'renamed', name: '新名字', email: 'me@x.com' },
      member,
    );
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ username: 'renamed', name: '新名字', email: 'me@x.com' });
    expect((await call('PATCH', '/api/me', { username: 'admin' }, member)).status).toBe(409);
    expect((await call('PATCH', '/api/me', { username: 'Bad Name' }, member)).status).toBe(400);
    // 邮箱可以清空
    expect((await call('PATCH', '/api/me', { email: '' }, member)).data).toMatchObject({ email: null });

    // 改了用户名之后用新用户名登录，旧的不行
    expect((await call('POST', '/api/auth/login', { username: 'member', password: PASSWORD })).status).toBe(
      401,
    );
    const me = await call('POST', '/api/auth/login', { username: 'renamed', password: PASSWORD });
    expect(me.status).toBe(200);
    expect((me.data as unknown as Me).username).toBe('renamed');

    // 未登录不能改
    expect((await call('PATCH', '/api/me', { name: '匿名' })).status).toBe(401);
    expect((await call('GET', '/api/me/sessions')).status).toBe(401);
  });

  test.skipIf(skip)('密码登录用用户名且不区分大小写；last_login_at 会更新', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const cookie = await login('MEMBER');
    expect((await call('GET', '/api/auth/me', undefined, cookie)).data).toMatchObject({ username: 'member' });
    const [row] = await db.query<{ last_login_at: string | null }>(
      "select last_login_at from users where username = 'member'",
    );
    expect(row!.last_login_at).toBeTruthy();
    // 管理员初始化时登录过，普通用户建出来时没有
    const [fresh] = await db.query<{ last_login_at: string | null }>(
      "select last_login_at from users where username = 'admin'",
    );
    expect(fresh!.last_login_at).toBeTruthy();
  });

  test.skipIf(skip)('makeUser 直接写库的用户能登录（测试辅助自身可用）', async () => {
    await makeUser(db, 'helper', { name: '辅助' });
    expect(await login('helper')).toBeTruthy();
  });

  // ───── 审查修复：并发与边界 ─────

  test.skipIf(skip)('邀请并发：同一个邀请只会被接受一次', async () => {
    const admin = await setupAdmin();
    const created = await call('POST', '/api/admin/invites', {}, admin.cookie);
    const token = created.data.token as string;

    // 5 个请求同时接受同一个邀请（用户名各不相同，排除用户名冲突的影响）
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call('POST', `/api/invites/${token}/accept`, {
          username: `racer${i}`,
          name: `并发 ${i}`,
          password: 'password2',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(4);
    expect(await db.query("select id from users where username like 'racer%'")).toHaveLength(1);

    // 邀请只在事务里被认领一次
    const [invite] = await db.query<{ used_at: string | null }>('select used_at from invites where id = $1', [
      created.data.id,
    ]);
    expect(invite!.used_at).toBeTruthy();
    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({ state: 'used' });
  });

  test.skipIf(skip)('邀请：建用户失败整体回滚，令牌仍然可用', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'taken');
    const created = await call('POST', '/api/admin/invites', {}, admin.cookie);
    const token = created.data.token as string;

    // 用户名冲突：认领要一起回滚，否则这个邀请就白白用掉了
    const conflict = await call('POST', `/api/invites/${token}/accept`, {
      username: 'taken',
      name: '撞名',
      password: 'password2',
    });
    expect(conflict.status).toBe(409);
    expect((await call('GET', `/api/invites/${token}`)).data).toMatchObject({ state: 'ok' });

    // 换一个用户名还是能用
    const ok = await call('POST', `/api/invites/${token}/accept`, {
      username: 'accepted',
      name: '接受',
      password: 'password2',
    });
    expect(ok.status).toBe(200);
    expect(await db.query("select id from users where username = 'taken'")).toHaveLength(1);
  });

  test.skipIf(skip)('重置密码并发：同一个链接只会改一次密码', async () => {
    const admin = await setupAdmin();
    const memberId = await createMember(admin.cookie, 'member');
    const link = await call('POST', `/api/admin/users/${memberId}/reset-link`, undefined, admin.cookie);
    const token = link.data.token as string;
    const passwords = ['new-password-a', 'new-password-b', 'new-password-c'];

    const results = await Promise.all(
      passwords.map((password) => call('POST', `/api/reset/${token}`, { password })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 410)).toHaveLength(2);

    // 只有认领成功的那一个密码生效
    const logins = await Promise.all(
      passwords.map((password) => call('POST', '/api/auth/login', { username: 'member', password })),
    );
    expect(logins.filter((r) => r.status === 200)).toHaveLength(1);
  });

  test.skipIf(skip)('两个管理员同时互相降级：最多成功一个，最后一个管理员不会被降级', async () => {
    const admin = await setupAdmin();
    const second = await call(
      'POST',
      '/api/admin/users',
      { username: 'admin2', name: '管理员二', password: PASSWORD, role: 'admin' },
      admin.cookie,
    );
    expect(second.status).toBe(201);
    const admin2 = await login('admin2');
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: PASSWORD, newPassword: 'admin2-new-password' },
          admin2,
        )
      ).status,
    ).toBe(200);

    const [a, b] = await Promise.all([
      call('PATCH', `/api/admin/users/${second.data.id as string}`, { role: 'member' }, admin.cookie),
      call('PATCH', `/api/admin/users/${admin.id}`, { role: 'member' }, admin2),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 422]);
    // 计数和更新在同一个事务里，结果一定还剩一个 active 管理员
    expect(
      await db.query<{ id: string }>("select id from users where role = 'admin' and status = 'active'"),
    ).toHaveLength(1);
  });

  test.skipIf(skip)(
    'bootstrapAdmin 插入失败回滚并清理刚写入的临时密码文件，重试可成功（SQLite）',
    async () => {
      if (platform !== 'sqlite') return;
      const dir = makeTempDir();
      const pwFile = join(dir, 'initial-admin-password');
      await db.exec(`create trigger fail_setup before insert on users
                   when new.username = 'admin'
                   begin select raise(abort, 'boom'); end;`);
      await expect(bootstrapAdmin(db, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } })).rejects.toThrow(
        /boom/,
      );
      expect(await db.query('select id from users')).toHaveLength(0);
      expect(existsSync(pwFile)).toBe(false);

      await db.exec('drop trigger fail_setup');
      const ok = await bootstrapAdmin(db, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } });
      expect(ok.created).toMatchObject({ username: 'admin', role: 'admin', mustChangePassword: true });
      expect(existsSync(pwFile)).toBe(true);
    },
  );

  test.skipIf(skip)(
    '管理员创建与重置临时密码：手动/随机生成、禁止自重置、吊销会话、不泄露明文审计，且 /api/reset/:token 清除须改密',
    async () => {
      const admin = await setupAdmin();
      // 创建不带密码的纯 OIDC 用户：mustChangePassword=false
      const oidcCreated = await call(
        'POST',
        '/api/admin/users',
        { username: 'oidc-only-u', name: 'OIDC用户' },
        admin.cookie,
      );
      expect(oidcCreated.status).toBe(201);
      expect(oidcCreated.data.mustChangePassword).toBe(false);

      // 创建带密码的用户：mustChangePassword=true，列表中返回布尔值
      const tempCreated = await call(
        'POST',
        '/api/admin/users',
        { username: 'tempuser', name: '临时用户', password: PASSWORD },
        admin.cookie,
      );
      expect(tempCreated.status).toBe(201);
      expect(tempCreated.data.mustChangePassword).toBe(true);
      const userList = (await call('GET', '/api/admin/users?q=tempuser', undefined, admin.cookie))
        .data as unknown as { id: string; mustChangePassword: boolean }[];
      expect(userList[0]!.mustChangePassword).toBe(true);

      const tempUserId = tempCreated.data.id as string;
      const tempSession = await login('tempuser');
      expect((await call('GET', '/api/projects', undefined, tempSession)).status).toBe(403);

      // 1. 禁止在用户管理接口重置自己，也不允许操作不存在用户或过短密码
      expect(
        (await call('POST', `/api/admin/users/${admin.id}/reset-password`, {}, admin.cookie)).status,
      ).toBe(422);
      expect(
        (await call('POST', '/api/admin/users/no-such-user/reset-password', {}, admin.cookie)).status,
      ).toBe(404);
      expect(
        (
          await call(
            'POST',
            `/api/admin/users/${tempUserId}/reset-password`,
            { password: 'short' },
            admin.cookie,
          )
        ).status,
      ).toBe(400);

      // 2. 自动生成临时密码：吊销原有会话、审计不含明文
      const genRes = await call('POST', `/api/admin/users/${tempUserId}/reset-password`, {}, admin.cookie);
      expect(genRes.status).toBe(200);
      expect(genRes.data.mustChangePassword).toBe(true);
      const generatedPw = genRes.data.password as string;
      expect(generatedPw).toHaveLength(24);
      expect((await call('GET', '/api/auth/me', undefined, tempSession)).status).toBe(401);

      const [resetAudit] = await db.query<{
        data: { username: string; generated: boolean; mustChangePassword: boolean };
      }>("select data from audit_events where action = 'user.password_reset_temp' order by at desc limit 1");
      expect(resetAudit!.data).toEqual({
        username: 'tempuser',
        generated: true,
        mustChangePassword: true,
      });
      expect(JSON.stringify(resetAudit!.data)).not.toContain(generatedPw);

      // 用生成的新临时密码登录 → 被 403 拦截 → 改密恢复
      const tempSession2 = await login('tempuser', generatedPw);
      expect((await call('GET', '/api/projects', undefined, tempSession2)).data).toMatchObject({
        code: 'password_change_required',
      });
      expect(
        (
          await call(
            'POST',
            '/api/me/password',
            { oldPassword: generatedPw, newPassword: 'tempuser-new-pw' },
            tempSession2,
          )
        ).status,
      ).toBe(200);
      expect((await call('GET', '/api/projects', undefined, tempSession2)).status).toBe(200);

      // 3. 管理员手动指定临时密码
      const manualRes = await call(
        'POST',
        `/api/admin/users/${tempUserId}/reset-password`,
        { password: 'manual-temp-pw' },
        admin.cookie,
      );
      expect(manualRes.status).toBe(200);
      expect(manualRes.data).toEqual({ password: 'manual-temp-pw', mustChangePassword: true });
      const tempSession3 = await login('tempuser', 'manual-temp-pw');
      expect((await call('GET', '/api/auth/me', undefined, tempSession3)).data).toMatchObject({
        mustChangePassword: true,
      });

      // 4. 用户通过 /api/reset/:token 完成自助重置时同样清除 mustChangePassword，若为 bootstrap 管理员也清理文件
      const resetLink = await call('POST', `/api/admin/users/${tempUserId}/reset-link`, {}, admin.cookie);
      expect(resetLink.status).toBe(200);
      expect(
        (
          await call('POST', `/api/reset/${resetLink.data.token as string}`, {
            password: 'self-reset-pw',
          })
        ).status,
      ).toBe(200);
      const afterReset = await login('tempuser', 'self-reset-pw');
      expect((await call('GET', '/api/auth/me', undefined, afterReset)).data).toMatchObject({
        mustChangePassword: false,
      });
      expect((await call('GET', '/api/projects', undefined, afterReset)).status).toBe(200);

      // 5. bootstrapUsername 在被重置密码或 /api/reset/:token 时同样清理 initialAdminPasswordFile
      const dir = makeTempDir();
      const orphanFile = join(dir, 'initial-admin-password');
      writeFileSync(orphanFile, 'leftover\n', { mode: 0o600 });
      await stop();
      await boot({ initialAdminPasswordFile: orphanFile, bootstrapUsername: 'tempuser' });
      const admin2 = await login('admin');
      await call('POST', `/api/admin/users/${tempUserId}/reset-password`, {}, admin2);
      expect(existsSync(orphanFile)).toBe(false);

      writeFileSync(orphanFile, 'leftover2\n', { mode: 0o600 });
      const adminLink = await call('POST', `/api/admin/users/${tempUserId}/reset-link`, {}, admin2);
      await call('POST', `/api/reset/${adminLink.data.token as string}`, { password: 'self-reset-pw-2' });
      expect(existsSync(orphanFile)).toBe(false);
    },
  );

  test.skipIf(skip)('登录耗时不泄露用户名是否存在（不存在时也跑 scrypt）', async () => {
    await createMember((await setupAdmin()).cookie, 'member');
    const timeIt = async (username: string) => {
      const t0 = performance.now();
      const r = await call('POST', '/api/auth/login', { username, password: 'wrong-password' });
      return { status: r.status, ms: performance.now() - t0, error: r.data.error };
    };
    // 现有用户 + 错密码
    const existing = await timeIt('member');
    // 不存在的用户
    const missing = await timeIt('no-such-user');
    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    // 两条路径的错误信息一致
    expect(missing.error).toBe(existing.error);
    // scrypt 本身要几十毫秒：不存在用户这条路径也至少花了 5ms，说明跑了假哈希
    expect(missing.ms).toBeGreaterThan(5);
  });

  test.skipIf(skip)('用户名唯一约束冲突返回 409（并发建同名用户、并发改用户名）', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'one');
    await createMember(admin.cookie, 'two');

    // 并发建同名用户：usernameTaken() 可能都没查到，靠唯一约束兜底
    const created = await Promise.all(
      Array.from({ length: 3 }, () =>
        call(
          'POST',
          '/api/admin/users',
          { username: 'duplicate', name: '同名', password: PASSWORD },
          admin.cookie,
        ),
      ),
    );
    expect(created.filter((r) => r.status === 201)).toHaveLength(1);
    expect(created.filter((r) => r.status === 409)).toHaveLength(2);

    // 并发把两个用户改成同一个新用户名
    const one = await login('one');
    const two = await login('two');
    const renamed = await Promise.all([
      call('PATCH', '/api/me', { username: 'same-new-name' }, one),
      call('PATCH', '/api/me', { username: 'same-new-name' }, two),
    ]);
    expect(renamed.filter((r) => r.status === 200)).toHaveLength(1);
    expect(renamed.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await db.query("select id from users where username = 'same-new-name'")).toHaveLength(1);
  });

  test.skipIf(skip)('用户名里的字母统一转成小写（接口校验之前）', async () => {
    const admin = await setupAdmin();
    const created = await call(
      'POST',
      '/api/admin/users',
      { username: '  MixedCase  ', name: '大小写', password: PASSWORD },
      admin.cookie,
    );
    expect(created.status).toBe(201);
    expect(created.data.username).toBe('mixedcase');

    const memberLogin = await call('POST', '/api/auth/login', { username: 'MixedCase', password: PASSWORD });
    expect(memberLogin.status).toBe(200);
    expect(memberLogin.data.mustChangePassword).toBe(true);
    const member = memberLogin.cookie;
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: PASSWORD, newPassword: 'mixed-new-password' },
          member,
        )
      ).status,
    ).toBe(200);
    const renamed = await call('PATCH', '/api/me', { username: 'NewName' }, member);
    expect(renamed.status).toBe(200);
    expect(renamed.data.username).toBe('newname');

    // 不符合格式的仍然拒绝（只放宽大小写，不放宽字符集）
    expect((await call('PATCH', '/api/me', { username: 'bad name' }, member)).status).toBe(400);
    expect(
      (await call('POST', '/api/admin/users', { username: '-bad-', name: 'x' }, admin.cookie)).status,
    ).toBe(400);

    // 接受邀请时同样转小写
    const invite = await call('POST', '/api/admin/invites', {}, admin.cookie);
    const accepted = await call('POST', `/api/invites/${invite.data.token as string}/accept`, {
      username: 'InvitedUser',
      name: '被邀请',
      password: 'password2',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.data.username).toBe('inviteduser');
  });

  test.skipIf(skip)('bootstrapAdmin 的环境变量要走和接口一样的校验', async () => {
    await expect(
      bootstrapAdmin(db, { env: { DOWEL_ADMIN_USERNAME: 'Bad Name', DOWEL_ADMIN_PASSWORD: PASSWORD } }),
    ).rejects.toThrow(/DOWEL_ADMIN_USERNAME/);
    await expect(
      bootstrapAdmin(db, { env: { DOWEL_ADMIN_USERNAME: '-bad-', DOWEL_ADMIN_PASSWORD: PASSWORD } }),
    ).rejects.toThrow(/DOWEL_ADMIN_USERNAME/);
    await expect(
      bootstrapAdmin(db, { env: { DOWEL_ADMIN_USERNAME: 'root', DOWEL_ADMIN_PASSWORD: 'short' } }),
    ).rejects.toThrow(/DOWEL_ADMIN_PASSWORD/);

    // 合法值（大小写会被统一成小写）照常建管理员
    expect(await db.query('select id from users')).toHaveLength(0);
    const res = await bootstrapAdmin(db, {
      env: { DOWEL_ADMIN_USERNAME: 'Root', DOWEL_ADMIN_PASSWORD: PASSWORD },
    });
    expect(res.created).toMatchObject({ username: 'root', role: 'admin', mustChangePassword: false });
  });

  test.skipIf(skip)('撤销邀请：已使用返回 409，已撤销返回 404', async () => {
    const admin = await setupAdmin();
    const used = await call('POST', '/api/admin/invites', {}, admin.cookie);
    expect(
      (
        await call('POST', `/api/invites/${used.data.token as string}/accept`, {
          username: 'used-invite',
          name: '用过',
          password: 'password2',
        })
      ).status,
    ).toBe(200);
    const revokeUsed = await call(
      'DELETE',
      `/api/admin/invites/${used.data.id as string}`,
      undefined,
      admin.cookie,
    );
    expect(revokeUsed.status).toBe(409);
    // 已使用的邀请状态优先显示“已使用”
    expect((await call('GET', `/api/invites/${used.data.token as string}`)).data).toMatchObject({
      state: 'used',
    });

    const revoked = await call('POST', '/api/admin/invites', {}, admin.cookie);
    expect(
      (await call('DELETE', `/api/admin/invites/${revoked.data.id as string}`, undefined, admin.cookie))
        .status,
    ).toBe(200);
    expect(
      (await call('DELETE', `/api/admin/invites/${revoked.data.id as string}`, undefined, admin.cookie))
        .status,
    ).toBe(404);
  });

  test.skipIf(skip)('修改密码要旧密码；没有密码的用户（纯 OIDC）可以不带旧密码直接设置', async () => {
    const admin = await setupAdmin();
    await createMember(admin.cookie, 'member');
    const member = await login('member');
    // 有密码：不传 / 传错旧密码都不行
    expect((await call('POST', '/api/me/password', { newPassword: 'new-password' }, member)).status).toBe(
      400,
    );
    expect(
      (
        await call(
          'POST',
          '/api/me/password',
          { oldPassword: 'wrong-pass', newPassword: 'x-password1' },
          member,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('POST', '/api/me/password', { oldPassword: PASSWORD, newPassword: 'x-password1' }, member))
        .status,
    ).toBe(200);
    // /api/auth/me 告诉前端有没有密码（不返回哈希）
    expect((await call('GET', '/api/auth/me', undefined, member)).data).toMatchObject({ hasPassword: true });

    // 纯 OIDC 用户：直接写库建一个没有密码的用户，再造一个会话（没有密码就登录不了）
    const oidcUser = await makeUser(db, 'oidc-only', { password: null });
    const token = 'oidc-only-session-token';
    const insertSession = async (createdAt: Date) =>
      db.query(
        'insert into sessions (id, token_hash, user_id, expires_at, created_at) values ($1, $2, $3, $4, $5)',
        [
          'oidc-only-session',
          hashToken(token),
          oidcUser.id,
          new Date(Date.now() + 3600_000).toISOString(),
          createdAt.toISOString(),
        ],
      );
    await insertSession(new Date(Date.now() - 11 * 60_000));
    const oidcSession = `dowel_session=${token}`;
    expect((await call('GET', '/api/auth/me', undefined, oidcSession)).data.hasPassword).toBe(false);
    // 会话是 11 分钟前建的：首次设置密码被拒绝，并说明要重新登录
    const stale = await call('POST', '/api/me/password', { newPassword: 'first-password' }, oidcSession);
    expect(stale.status).toBe(403);
    expect(stale.data.error).toContain('请重新登录后再设置密码');
    expect((await call('GET', '/api/auth/me', undefined, oidcSession)).data.hasPassword).toBe(false);

    // 重新登录（会话是刚建的）之后可以设置：不需要旧密码
    await db.query('delete from sessions where id = $1', ['oidc-only-session']);
    await insertSession(new Date());
    expect(
      (await call('POST', '/api/me/password', { newPassword: 'first-password' }, oidcSession)).status,
    ).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, oidcSession)).data.hasPassword).toBe(true);
    // 设完之后就要求旧密码了
    expect(
      (await call('POST', '/api/me/password', { newPassword: 'second-password' }, oidcSession)).status,
    ).toBe(400);
    expect(await login('oidc-only', 'first-password')).toBeTruthy();
  });

  test.skipIf(skip)('首次设置密码：并发请求只有一个成功，且不会吊销其他会话', async () => {
    const oidcUser = await makeUser(db, 'oidc-race', { password: null });
    const otherSession = 'oidc-race-other-session';
    await db.query('insert into sessions (id, token_hash, user_id, expires_at) values ($1, $2, $3, $4)', [
      'oidc-race-other',
      hashToken(otherSession),
      oidcUser.id,
      new Date(Date.now() + 3600_000).toISOString(),
    ]);
    const token = 'oidc-race-session-token';
    await db.query('insert into sessions (id, token_hash, user_id, expires_at) values ($1, $2, $3, $4)', [
      'oidc-race',
      hashToken(token),
      oidcUser.id,
      new Date(Date.now() + 3600_000).toISOString(),
    ]);
    const cookie = `dowel_session=${token}`;
    // 两个请求同时把 password_hash 从 null 改成值：条件更新只有一个能成功，另一个是 409
    const [a, b] = await Promise.all([
      call('POST', '/api/me/password', { newPassword: 'race-password-1' }, cookie),
      call('POST', '/api/me/password', { newPassword: 'race-password-2' }, cookie),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    // 首次设置不吊销其他会话（否则只是帮攻击者把主人踢下线）
    expect((await call('GET', '/api/auth/me', undefined, `dowel_session=${otherSession}`)).status).toBe(200);
    // 设好的密码能用
    const winner = a.status === 200 ? 'race-password-1' : 'race-password-2';
    expect(await login('oidc-race', winner)).toBeTruthy();
  });
});

test('DOWEL_ADMIN_* 启动校验与首次启动 0600 临时密码文件日志契约', async () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['--conditions=@dowel/source', 'apps/server/src/main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, DOWEL_DB: ':memory:', PORT: '0', DOWEL_DRIFT_INTERVAL_MINUTES: '0', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });

  const badUsername = run({ DOWEL_ADMIN_USERNAME: 'Bad Name', DOWEL_ADMIN_PASSWORD: 'password1' });
  expect(badUsername.status).toBe(1);
  expect(badUsername.stderr).toContain('DOWEL_ADMIN_USERNAME');

  const badPassword = run({ DOWEL_ADMIN_USERNAME: 'root', DOWEL_ADMIN_PASSWORD: 'short' });
  expect(badPassword.status).toBe(1);
  expect(badPassword.stderr).toContain('DOWEL_ADMIN_PASSWORD');

  const dir = mkdtempSync(join(tmpdir(), 'dowel-main-boot-'));
  try {
    const opFile = join(dir, 'op-pw');
    writeFileSync(opFile, 'operator-pw-123\n', { mode: 0o600 });

    const conflict = run({
      DOWEL_ADMIN_PASSWORD_FILE: opFile,
      DOWEL_ADMIN_PASSWORD: 'password1',
    });
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('DOWEL_ADMIN_PASSWORD_FILE');

    const missingFile = run({ DOWEL_ADMIN_PASSWORD_FILE: join(dir, 'nonexistent-pw') });
    expect(missingFile.status).toBe(1);
    expect(missingFile.stderr).toContain('DOWEL_ADMIN_PASSWORD_FILE');

    // 未配置 DOWEL_ADMIN_PASSWORD* 且首次使用本地 SQLite 文件时，写入同目录 0600 initial-admin-password，且日志只打路径不打明文
    const sqlitePath = join(dir, 'dowel.db');
    const pwFile = join(dir, 'initial-admin-password');
    const child = spawn(process.execPath, ['--conditions=@dowel/source', 'apps/server/src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOWEL_DB: sqlitePath,
        PORT: '0',
        DOWEL_DRIFT_INTERVAL_MINUTES: '0',
        DOWEL_ADMIN_USERNAME: '',
        DOWEL_ADMIN_PASSWORD: '',
        DOWEL_ADMIN_PASSWORD_FILE: '',
        DOWEL_INITIAL_PASSWORD_FILE: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && (!stdout.includes('Dowel 已启动') || !existsSync(pwFile))) {
        if (child.exitCode !== null) {
          throw new Error(`子进程提前退出（${child.exitCode}）：${stderr}\n${stdout}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(existsSync(pwFile), `stdout=${stdout}\nstderr=${stderr}`).toBe(true);
      expect(statSync(pwFile).mode & 0o777).toBe(0o600);
      const pw = readFileSync(pwFile, 'utf8').trim();
      expect(pw).toHaveLength(24);
      expect(stdout).toContain(pwFile);
      expect(stdout).not.toContain(pw);
      expect(stderr).not.toContain(pw);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => {
        if (child.exitCode !== null) return r(undefined);
        child.once('exit', r);
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
