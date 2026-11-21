// 个人设置（S4 第二部分）：资料、密码、会话、登录方式。
// 登录方式里的“最后一种可用方式不能解除”需要先把密码登录关掉，让关联的外部账户成为唯一方式；
// 关掉密码登录是实例级设置，所以用例结束时一定要恢复（try/finally）。
import { expect, test } from '@playwright/test';

import { adminPage, newUser } from './helpers.ts';

const NEW_PASSWORD = 'new-password-1';

test('资料：改显示名，用户名下面提示会影响别人 @ 你的方式', async ({ browser }) => {
  const { page } = await newUser(browser, '资料');
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '资料' })).toBeVisible();
  await expect(page.getByText(/改用户名会影响别人 @ 你的方式/)).toBeVisible();

  await page.getByLabel('显示名').fill('新的名字');
  await page.getByRole('button', { name: '保存资料' }).click();
  await expect(page.getByText('已保存资料')).toBeVisible();

  // 保存后刷新仍然生效
  await page.reload();
  await expect(page.getByLabel('显示名')).toHaveValue('新的名字');
  const me = (await (await page.request.get('/api/auth/me')).json()) as { name: string };
  expect(me.name).toBe('新的名字');
});

test('密码：旧密码不对会提示，改完之后旧密码登录不了、新密码可以', async ({ browser }) => {
  const { page, username } = await newUser(browser, '密码');
  await page.goto('/account/password');
  await page.getByLabel('旧密码').fill('wrong-password');
  await page.getByLabel('新密码').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('旧密码不正确')).toBeVisible();

  await page.getByLabel('旧密码').fill('password123');
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.getByText('密码已修改，其他会话已退出')).toBeVisible();

  // 旧密码不再能登录，新密码可以
  await page.request.post('/api/auth/logout');
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('用户名或密码错误')).toBeVisible();

  await page.getByLabel('密码').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
});

test('会话：列出当前会话，可以吊销其他会话', async ({ browser }) => {
  const { page, username } = await newUser(browser, '会话');
  // 同一个账号在另一个浏览器上下文里再登录一次：会话列表应该有两行
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto('/login');
  await otherPage.getByLabel('用户名').fill(username);
  await otherPage.getByLabel('密码').fill('password123');
  await otherPage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(otherPage.getByRole('heading', { name: '我的项目' })).toBeVisible();

  await page.goto('/account/sessions');
  await expect(page.getByText('当前')).toBeVisible();
  await expect(page.locator('main ul > li')).toHaveCount(2);
  // UA 被简化成“浏览器 · 操作系统”，IP 和最后活动时间都在
  await expect(page.getByText(/Chrome · Linux/).first()).toBeVisible();
  await expect(page.getByText(/最后活动/).first()).toBeVisible();

  await page.getByRole('button', { name: '退出其他所有会话' }).click();
  await expect(page.getByText('已退出其他所有会话')).toBeVisible();
  await expect(page.locator('main ul > li')).toHaveCount(1);
  await expect(page.getByText('当前')).toBeVisible();

  // 另一个浏览器里的会话已经失效：下次请求返回 401
  const me = await otherPage.request.get('/api/auth/me');
  expect(me.status()).toBe(401);
  await other.close();

  // 吊销当前会话：和退出登录一样先清空查询缓存再回登录页。
  // 没清的话根路由的 beforeLoad 会拿缓存里的 me 把人又送回“我的项目”。
  await page.getByRole('button', { name: /吊销会话/ }).click();
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test('登录方式：关联外部账户，最后一种可用方式不能解除关联', async ({ browser }) => {
  const admin = await adminPage(browser);
  const slug = `link-${Date.now().toString(36)}`;
  const created = await admin.request.post('/api/admin/oidc', {
    data: {
      slug,
      name: 'Mock Link',
      issuer: 'http://localhost:4652',
      clientId: 'e2e-client',
      clientSecret: 'e2e-secret',
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const provider = (await created.json()) as { id: string };

  try {
    const { page } = await newUser(browser, '关联');
    await page.goto('/account/identities');
    // 还没有外部账户：显示密码登录，并给出可以关联的提供方
    await expect(page.getByText('已设置密码')).toBeVisible();
    await page.getByRole('link', { name: '关联 Mock Link' }).click();

    // 经过 mock 提供方的授权页自动跳回 /account/identities
    await page.waitForURL('**/account/identities', { timeout: 15000 });
    await expect(page.getByText('e2e-oidc-subject')).toBeVisible();
    // 还有密码：解除关联是可用的
    await expect(page.getByRole('button', { name: '解除关联' })).toBeEnabled();

    // 关掉密码登录：外部账户成了唯一可用的方式，解除按钮禁用并说明原因
    const closed = await admin.request.patch('/api/admin/settings', { data: { passwordLogin: false } });
    expect(closed.ok(), await closed.text()).toBe(true);
    await page.reload();
    await expect(page.getByText(/这是最后一种能用的登录方式，不能解除关联/)).toBeVisible();
    await expect(page.getByRole('button', { name: '解除关联' })).toBeDisabled();
  } finally {
    await admin.request.patch('/api/admin/settings', { data: { passwordLogin: true } });
    await admin.request.delete(`/api/admin/oidc/${provider.id}`);
  }
});
