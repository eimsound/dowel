// 端到端：实例管理员配置本地 mock OIDC 提供方 → 生成邀请 → 新用户打开邀请链接，
// 点“用 Mock 账户接受” → 回调完成开户并登录。
import { expect, test } from '@playwright/test';

import { adminPage } from './helpers.ts';

const ISSUER = 'http://localhost:4652';

test('邀请链接 → 用 OIDC 账户接受 → 登录成功', async ({ browser }) => {
  const admin = await adminPage(browser);
  const slug = `mock-${Date.now().toString(36)}`;
  const created = await admin.request.post('/api/admin/oidc', {
    data: {
      slug,
      name: 'Mock',
      issuer: ISSUER,
      clientId: 'e2e-client',
      clientSecret: 'e2e-secret',
      autoProvision: false,
    },
  });
  expect(created.ok(), await created.text()).toBe(true);

  // 登录页显示“使用 Mock 登录”
  const loginPage = await (await browser.newContext()).newPage();
  await loginPage.goto('/login');
  await expect(loginPage.getByRole('link', { name: '使用 Mock 登录' })).toBeVisible();

  // 邀请页显示“用 Mock 账户接受”
  const invite = (await (await admin.request.post('/api/admin/invites', { data: {} })).json()) as {
    url: string;
  };
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(invite.url);
  await expect(guest.getByRole('heading', { name: '接受邀请' })).toBeVisible();
  await guest.getByRole('link', { name: '用 Mock 账户接受' }).click();

  // 经过 mock 提供方的授权页自动跳回，回调开户后进入项目页
  await expect(guest.getByRole('heading', { name: '我的项目' })).toBeVisible();
  const me = (await (await guest.request.get('/api/auth/me')).json()) as { username: string };
  expect(me.username).toBe('oidcuser');

  // 邀请已被使用
  const again = await (await browser.newContext()).newPage();
  await again.goto(invite.url);
  await expect(again.getByText('这个邀请链接已经被使用过了。')).toBeVisible();
});

test('登录页只显示固定错误文案，不回显 URL 里的任意内容', async ({ page }) => {
  await page.goto('/login?oidc_error=not_invited');
  await expect(page.getByText('这个账户还没有被邀请。请向实例管理员要一个邀请链接。')).toBeVisible();

  await page.goto('/login?oidc_error=not-a-real-code');
  await expect(page.getByText('登录失败，请重新登录。')).toBeVisible();

  await page.goto('/login?oidc_error=<script>alert(1)</script>');
  await expect(page.getByText('登录失败，请重新登录。')).toBeVisible();
  await expect(page.getByText('<script>', { exact: false })).toHaveCount(0);
});
