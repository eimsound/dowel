// 一条完整流程：初始化实例 → 管理员生成邀请 → 新用户接受邀请 → 退出后用新账号登录。
// 用一个独立启动的服务实例（内存库、自己的端口），这样能读到启动日志里的一次性初始化令牌；
// 主实例在 playwright.config.ts 里用 DOWEL_ADMIN_* 无人值守初始化，见 e2e/helpers.ts。
import { type ChildProcess, spawn } from 'node:child_process';

import { expect, test } from '@playwright/test';

const PORT = 4651;
const BASE = `http://localhost:${PORT}`;
const ADMIN = { username: 'admin', name: '管理员', password: 'admin-password' };

let proc: ChildProcess;
let setupToken = '';

test.beforeAll(async () => {
  proc = spawn(process.execPath, ['apps/server/dist/main.js'], {
    // 显式清掉 DOWEL_ADMIN_*，走“打印初始化令牌”这条路
    env: {
      ...process.env,
      PORT: String(PORT),
      DOWEL_DB: ':memory:',
      DOWEL_SECRET: 'e2e-secret-0123456789',
      DOWEL_ADMIN_USERNAME: '',
      DOWEL_ADMIN_PASSWORD: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => {
    out += String(d);
  });
  proc.stderr!.on('data', (d) => process.stderr.write(d));
  setupToken = await new Promise<string>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const m = out.match(/初始化令牌：(\S+)/);
      if (m) return resolve(m[1]!);
      if (Date.now() - t0 > 60_000) return reject(new Error(`等不到初始化令牌。服务输出：${out}`));
      setTimeout(tick, 100);
    };
    tick();
  });
});

test.afterAll(async () => {
  proc?.kill('SIGTERM');
});

test('初始化 → 管理员生成邀请 → 新用户接受邀请 → 登录', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();

  // 未初始化时打开任何页面都会跳到 /setup
  await admin.goto(`${BASE}/login`);
  await expect(admin.getByRole('heading', { name: '初始化实例' })).toBeVisible();
  expect(admin.url()).toBe(`${BASE}/setup`);

  await admin.getByLabel('初始化令牌').fill(setupToken);
  await admin.getByLabel('用户名').fill(ADMIN.username);
  await admin.getByLabel('名字').fill(ADMIN.name);
  await admin.getByLabel('密码').fill(ADMIN.password);
  await admin.getByRole('button', { name: '创建实例管理员' }).click();
  await expect(admin.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 初始化完成后 /setup 不再可用
  await admin.goto(`${BASE}/setup`);
  await expect(admin.getByText('这个实例已经初始化过了。')).toBeVisible();

  // 管理员生成邀请链接（管理界面留到下一阶段，这里用接口）
  const res = await admin.request.post(`${BASE}/api/admin/invites`, { data: {} });
  expect(res.ok()).toBe(true);
  const invite = (await res.json()) as { url: string };
  expect(invite.url).toMatch(/^\/invite\/.+/);

  // 新用户打开邀请链接，填用户名、名字、密码
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(BASE + invite.url);
  await expect(guest.getByRole('heading', { name: '接受邀请' })).toBeVisible();
  await guest.getByLabel('用户名').fill('lisi');
  await guest.getByLabel('名字').fill('李四');
  await guest.getByLabel('密码').fill('password123');
  await guest.getByRole('button', { name: '接受邀请' }).click();
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 邀请只能使用一次
  const again = await (await browser.newContext()).newPage();
  await again.goto(BASE + invite.url);
  await expect(again.getByText('这个邀请链接已经被使用过了。')).toBeVisible();

  // 退出后用新账号登录
  await guest.getByRole('button', { name: '账户菜单' }).click();
  await guest.getByText('退出', { exact: true }).click();
  await expect(guest.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await guest.getByLabel('用户名').fill('lisi');
  await guest.getByLabel('密码').fill('password123');
  await guest.getByRole('button', { name: '登录', exact: true }).click();
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 密码登录是开着的，信息来自公开的 /api/instance
  const info = (await (await guest.request.get(`${BASE}/api/instance`)).json()) as {
    name: string;
    passwordLogin: boolean;
    needsSetup: boolean;
  };
  expect(info).toMatchObject({ name: 'Dowel', passwordLogin: true, needsSetup: false });

  // 管理员生成一次性重置密码链接：设完新密码后可以用新密码登录
  const users = (await (await admin.request.get(`${BASE}/api/admin/users?q=lisi`)).json()) as {
    id: string;
  }[];
  const reset = (await (
    await admin.request.post(`${BASE}/api/admin/users/${users[0]!.id}/reset-link`, { data: {} })
  ).json()) as { url: string };
  const resetPage = await (await browser.newContext()).newPage();
  await resetPage.goto(BASE + reset.url);
  await resetPage.getByLabel('新密码').fill('new-password-1');
  await resetPage.getByRole('button', { name: '设置新密码' }).click();
  await expect(resetPage.getByText('密码已更新，请用新密码登录。')).toBeVisible();
  await resetPage.getByRole('button', { name: '去登录' }).click();
  await resetPage.getByLabel('用户名').fill('lisi');
  await resetPage.getByLabel('密码').fill('new-password-1');
  await resetPage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(resetPage.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 重置会吊销该用户的所有会话：之前那个页面已经掉线
  await guest.reload();
  await expect(guest.getByRole('button', { name: '登录', exact: true })).toBeVisible();
});
