// 完整账户生命周期 E2E：
// 首次启动 0600 临时密码文件（日志仅打路径、不打明文）→ admin 登录后强制 /change-password 并清理文件 →
// /setup 重定向至 /login → 邀请新用户 → 后台创建临时密码用户与单按钮“重置密码”对话框（清旧会话 + 须改密徽章） →
// 后端 /reset/:token 自助重置兼容（同步清除 mustChangePassword）。
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const PORT = 4651;
const BASE = `http://localhost:${PORT}`;
const ADMIN_NEW_PASSWORD = 'admin-new-password-1';

let tmpDir = '';
let dbPath = '';
let pwPath = '';
let proc: ChildProcess;
let stdoutLog = '';
let initialPassword = '';

test.beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dowel-e2e-init-'));
  dbPath = join(tmpDir, 'dowel.db');
  pwPath = join(tmpDir, 'initial-admin-password');

  proc = spawn(process.execPath, ['apps/server/dist/main.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DOWEL_DB: dbPath,
      DOWEL_SECRET: 'e2e-secret-0123456789',
      DOWEL_ADMIN_USERNAME: '',
      DOWEL_ADMIN_PASSWORD: '',
      DOWEL_ADMIN_PASSWORD_FILE: '',
      DOWEL_INITIAL_PASSWORD_FILE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => {
    stdoutLog += String(d);
  });
  proc.stderr!.on('data', (d) => process.stderr.write(d));

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (existsSync(pwPath) && stdoutLog.includes(pwPath)) {
      try {
        const res = await fetch(`${BASE}/api/instance`);
        if (res.ok) break;
      } catch {
        // 等待监听
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(existsSync(pwPath), `未生成 ${pwPath}，输出：${stdoutLog}`).toBe(true);
  expect(statSync(pwPath).mode & 0o777).toBe(0o600);
  initialPassword = readFileSync(pwPath, 'utf8').trim();
  expect(initialPassword.length).toBeGreaterThanOrEqual(8);
  expect(stdoutLog).toContain(pwPath);
  expect(stdoutLog).not.toContain(initialPassword);
});

test.afterAll(async () => {
  proc?.kill('SIGTERM');
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

test('首次启动临时密码 → 强制改密 → 邀请 → 后台重置密码与重置链接兼容', async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();

  // /setup 已废除，访问直接重定向到 /login；/api/instance 不再暴露 needsSetup
  await admin.goto(`${BASE}/setup`);
  await expect(admin).toHaveURL(`${BASE}/login`);
  await expect(admin.getByRole('heading', { name: '登录' })).toBeVisible();

  const instRes = await admin.request.get(`${BASE}/api/instance`);
  expect(instRes.ok()).toBe(true);
  const inst = (await instRes.json()) as Record<string, unknown>;
  expect(inst).toMatchObject({ name: 'Dowel', passwordLogin: true });
  expect('needsSetup' in inst).toBe(false);

  // admin 用临时密码登录，立即强制跳转到 /change-password
  await admin.getByLabel('用户名').fill('admin');
  await admin.getByLabel('密码').fill(initialPassword);
  await admin.getByRole('button', { name: '登录', exact: true }).click();
  await expect(admin).toHaveURL(`${BASE}/change-password`);
  await expect(admin.getByRole('heading', { name: '修改密码' })).toBeVisible();
  await expect(admin.getByText('当前使用的是初始或重置后的临时密码')).toBeVisible();

  // 强制改密期间受保护接口 fail-closed 403 password_change_required，且访问首页被拉回 /change-password
  const blocked = await admin.request.get(`${BASE}/api/projects`);
  expect(blocked.status()).toBe(403);
  expect(await blocked.json()).toMatchObject({ code: 'password_change_required' });
  await admin.goto(`${BASE}/`);
  await expect(admin).toHaveURL(`${BASE}/change-password`);

  // 完成改密（无需再输入临时密码）后进入首页，并自动删除 initial-admin-password 文件
  await expect(admin.locator('input[name="oldPassword"]')).toHaveCount(0);
  await admin.getByLabel(/^新密码/).fill(initialPassword);
  await admin.getByLabel('确认新密码').fill(initialPassword);
  await admin.getByRole('button', { name: '保存新密码并继续' }).click();
  await expect(admin.getByText('新密码不能与临时密码相同')).toBeVisible();
  await admin.getByLabel(/^新密码/).fill(ADMIN_NEW_PASSWORD);
  await admin.getByLabel('确认新密码').fill(ADMIN_NEW_PASSWORD);
  await admin.getByRole('button', { name: '保存新密码并继续' }).click();
  await expect(admin.getByRole('heading', { name: '我的项目' })).toBeVisible();
  await expect(admin).toHaveURL(`${BASE}/`);
  expect(existsSync(pwPath)).toBe(false);

  // 管理员生成邀请链接
  const inviteRes = await admin.request.post(`${BASE}/api/admin/invites`, { data: {} });
  expect(inviteRes.ok()).toBe(true);
  const invite = (await inviteRes.json()) as { url: string };
  expect(invite.url).toMatch(/^\/invite\/.+/);

  // 新用户通过邀请注册（直接设好密码，不需要强制改密）
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(BASE + invite.url);
  await expect(guest.getByRole('heading', { name: '接受邀请' })).toBeVisible();
  await guest.getByLabel('用户名').fill('lisi');
  await guest.getByLabel('名字').fill('李四');
  await guest.getByLabel('密码').fill('password123');
  await guest.getByRole('button', { name: '接受邀请' }).click();
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 邀请只能用一次
  const again = await (await browser.newContext()).newPage();
  await again.goto(BASE + invite.url);
  await expect(again.getByText('这个邀请链接已经被使用过了。')).toBeVisible();

  // 退出并重新登录验证
  await guest.getByRole('button', { name: '账户菜单' }).click();
  await guest.getByText('退出', { exact: true }).click();
  await expect(guest.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await guest.getByLabel('用户名').fill('lisi');
  await guest.getByLabel('密码').fill('password123');
  await guest.getByRole('button', { name: '登录', exact: true }).click();
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 管理后台用户页：每行只有单个“重置密码”按钮（无“重置密码链接”按钮），且 admin 自己禁用
  await admin.goto(`${BASE}/admin`);
  await expect(admin.getByRole('heading', { name: '用户', exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: '重置密码链接' })).toHaveCount(0);
  const adminRow = admin.locator('tbody tr').filter({ hasText: 'admin' }).first();
  await expect(adminRow.getByRole('button', { name: '重置密码' })).toBeDisabled();

  // 1) 创建带初始密码的用户 → 显示“须改密”徽章 → 首次登录强制改密 → 徽章消失
  await admin.getByLabel('用户名', { exact: true }).fill('wangwu');
  await admin.getByLabel('显示名', { exact: true }).fill('王五');
  await admin.getByLabel('初始密码（可选）').fill('temp-wangwu-1');
  await admin.getByRole('button', { name: '创建用户' }).click();
  await expect(admin.getByText('已创建用户').first()).toBeVisible();
  const wangRow = admin.locator('tbody tr').filter({ hasText: 'wangwu' });
  await expect(wangRow.getByText('须改密')).toBeVisible();

  const wangCtx = await browser.newContext();
  const wang = await wangCtx.newPage();
  await wang.goto(`${BASE}/login`);
  await wang.getByLabel('用户名').fill('wangwu');
  await wang.getByLabel('密码').fill('temp-wangwu-1');
  await wang.getByRole('button', { name: '登录', exact: true }).click();
  await expect(wang).toHaveURL(`${BASE}/change-password`);
  await wang.getByLabel(/^新密码/).fill('wangwu-new-1');
  await wang.getByLabel('确认新密码').fill('wangwu-new-1');
  await wang.getByRole('button', { name: '保存新密码并继续' }).click();
  await expect(wang.getByRole('heading', { name: '我的项目' })).toBeVisible();
  await wangCtx.close();

  await admin.reload();
  await expect(admin.locator('tbody tr').filter({ hasText: 'wangwu' }).getByText('须改密')).toHaveCount(0);

  // 2) 通过 UI“重置密码”对话框留空生成临时密码 → 显示一次性密码条 → 旧会话失效 → 登录强制改密
  const lisiRow = admin.locator('tbody tr').filter({ hasText: 'lisi' });
  await lisiRow.getByRole('button', { name: '重置密码' }).click();
  const dlg = admin.getByRole('dialog', { name: '重置密码 · lisi' });
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '确认重置密码' }).click();
  await expect(dlg).toBeHidden();
  await expect(admin.getByText('临时密码 · lisi')).toBeVisible();
  const generatedTempPw = (await admin.locator('main code').first().textContent())?.trim() ?? '';
  expect(generatedTempPw).toHaveLength(24);
  await expect(lisiRow.getByText('须改密')).toBeVisible();

  // lisi 旧会话已失效
  await guest.reload();
  await expect(guest.getByRole('button', { name: '登录', exact: true })).toBeVisible();

  // lisi 用临时密码登录 → 强制改密 → 进入首页
  await guest.getByLabel('用户名').fill('lisi');
  await guest.getByLabel('密码').fill(generatedTempPw);
  await guest.getByRole('button', { name: '登录', exact: true }).click();
  await expect(guest).toHaveURL(`${BASE}/change-password`);
  await guest.getByLabel(/^新密码/).fill('lisi-after-temp');
  await guest.getByLabel('确认新密码').fill('lisi-after-temp');
  await guest.getByRole('button', { name: '保存新密码并继续' }).click();
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 3) 兼容保留的后端 reset-link 与前端 /reset/:token 页面：同步清除 mustChangePassword
  const users = (await (await admin.request.get(`${BASE}/api/admin/users?q=lisi`)).json()) as {
    id: string;
  }[];
  await admin.request.post(`${BASE}/api/admin/users/${users[0]!.id}/reset-password`, {
    data: { password: 'manual-temp-pw' },
  });
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
});
