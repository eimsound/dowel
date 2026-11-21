// 管理后台（S4 第二部分）：只有实例管理员能进；建用户、停用、最后一个管理员保护、
// 邀请（生成 → 接受）、登录方式（配置 mock OIDC 提供方、回调地址、停用、删除）、审计筛选。
import { expect, test } from '@playwright/test';

import { adminPage, newUser } from './helpers.ts';

const login = async (page: import('@playwright/test').Page, username: string, password: string) => {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
};

test('不是实例管理员：后台返回 404，账户菜单里也没有入口', async ({ browser }) => {
  const { page } = await newUser(browser, '普通用户');
  // 账户菜单里没有后台入口（有入口就会暴露后台存在）
  await page.getByRole('button', { name: '账户菜单' }).click();
  await expect(page.getByRole('button', { name: '管理后台' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto('/admin');
  await expect(page.getByText('页面不存在。')).toBeVisible();
  // 不暴露后台存在：连“需要实例管理员”都不说
  await expect(page.getByText(/需要实例管理员/)).toHaveCount(0);
});

test('用户：建用户、改角色（最后一个管理员 422 显示在界面上）、停用', async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/admin');
  await expect(admin.getByRole('heading', { name: '管理后台', exact: true })).toBeVisible();
  await expect(admin.getByRole('heading', { name: '用户', exact: true })).toBeVisible();

  // 建用户
  const username = `adm${Date.now().toString(36)}`;
  await admin.getByLabel('用户名', { exact: true }).fill(username);
  await admin.getByLabel('显示名', { exact: true }).fill('后台建的用户');
  await admin.getByLabel('初始密码（可选）').fill('password123');
  await admin.getByRole('button', { name: '创建用户' }).click();
  await expect(admin.getByText('已创建用户').first()).toBeVisible();
  await admin.getByLabel('搜索用户名、名字或邮箱…').fill(username);
  const row = admin.getByRole('row', { name: new RegExp(username) });
  await expect(row).toBeVisible();

  // 改实例角色：升成实例管理员，再降回成员（不是最后一个，允许）
  await row.getByLabel(`实例角色 · ${username}`).selectOption('admin');
  await expect(admin.getByText('已更新用户').first()).toBeVisible();
  await row.getByLabel(`实例角色 · ${username}`).selectOption('member');
  await expect(admin.getByText('已更新用户').first()).toBeVisible();

  // 最后一个管理员保护：把 admin 自己降级，服务端 422 的说明原样显示
  await admin.getByLabel('搜索用户名、名字或邮箱…').fill('admin');
  const adminRow = admin.locator('tbody tr').filter({ hasText: 'admin' }).first();
  await adminRow.getByLabel(/实例角色 · admin/).selectOption('member');
  await expect(admin.getByText('不能降级最后一个实例管理员')).toBeVisible();

  // 停用：会话立刻失效，登录时给出明确原因
  await admin.getByLabel('搜索用户名、名字或邮箱…').fill(username);
  await row.getByRole('button', { name: '停用' }).click();
  await expect(admin.getByText('已更新用户').first()).toBeVisible();
  await expect(row.getByText('已停用')).toBeVisible();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, username, 'password123');
  await expect(page.getByText('这个用户已被停用')).toBeVisible();
  await ctx.close();

  // 再启用，避免影响后续用例
  await row.getByRole('button', { name: '启用' }).click();
  await expect(row.getByText('启用', { exact: true })).toBeVisible();
});

test('邀请：生成链接（一次显示）、新用户接受、列表状态、撤销', async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/admin/invites');
  await expect(admin.getByRole('heading', { name: '已生成的邀请' })).toBeVisible();

  await admin.getByLabel('有效期（天）').fill('3');
  await admin.getByRole('button', { name: '生成邀请' }).click();
  const link = await admin.locator('main code').first().textContent();
  expect(link).toContain('/invite/');
  await expect(admin.getByRole('cell', { name: '有效' }).first()).toBeVisible();

  // 新用户打开链接接受邀请
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link!);
  await expect(page.getByRole('heading', { name: '接受邀请' })).toBeVisible();
  const username = `inv${Date.now().toString(36)}`;
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('名字').fill('被邀请的用户');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
  await ctx.close();

  // 邀请状态变成已使用
  await admin.reload();
  await expect(admin.getByRole('cell', { name: '已使用' }).first()).toBeVisible();

  // 撤销一个还没用的邀请
  await admin.getByRole('button', { name: '生成邀请' }).click();
  await admin
    .getByRole('row')
    .filter({ hasText: '有效' })
    .first()
    .getByRole('button', { name: '撤销' })
    .click();
  await expect(admin.getByText('已撤销邀请').first()).toBeVisible();
  await expect(admin.getByRole('cell', { name: '已撤销' }).first()).toBeVisible();
});

test('登录方式：配置 mock OIDC 提供方，显示回调地址，停用再删除', async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/admin/sign-in');
  await expect(admin.getByRole('heading', { name: '已配置的登录方式' })).toBeVisible();

  const slug = `ui${Date.now().toString(36)}`;
  await admin.getByLabel('显示名', { exact: true }).fill('Mock UI');
  await admin.getByLabel('标识', { exact: true }).fill(slug);
  await admin.getByLabel('Issuer 地址').fill('http://localhost:4652');
  await admin.getByLabel('client_id').fill('e2e-client');
  await admin.getByLabel('client_secret').fill('e2e-secret');
  await admin.getByRole('button', { name: '添加登录方式' }).click();
  await expect(admin.getByText('已保存登录方式').first()).toBeVisible();

  // 回调地址由服务端按 callbackUrl() 的规则算出来，可以直接复制
  await expect(admin.getByText(`/api/auth/oidc/${slug}/callback`, { exact: false })).toBeVisible();
  const enabled = admin.getByRole('checkbox', { name: '启用 · Mock UI' });
  await expect(enabled).toBeChecked();

  // 停用（受控复选框：等接口返回、列表刷新后状态才变，所以只断言结果）
  await enabled.click();
  await expect(admin.getByText('已保存登录方式').first()).toBeVisible();
  await expect(admin.getByText('已停用').first()).toBeVisible();

  // 删除（确认对话框里重复动作）
  await admin.getByRole('button', { name: '删除 · Mock UI' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: '删除' }).click();
  await expect(admin.getByText('已删除登录方式').first()).toBeVisible();
  await expect(admin.getByText('Mock UI')).toHaveCount(0);
});

test('审计：按动作前缀筛选、展开数据、清除筛选', async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/admin/audit');
  await expect(admin.getByRole('heading', { name: '审计日志' })).toBeVisible();

  await admin.getByLabel('动作前缀').fill('user.create');
  await admin.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(admin.getByRole('table')).toContainText('创建了用户');
  await expect(admin.getByRole('table')).not.toContainText('登录了');

  // 目标类型筛选：只看用户
  await admin.getByLabel('对象类型').selectOption('user');
  await admin.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(admin.getByRole('table')).toContainText('创建了用户');

  // 展开一行的 data JSON
  await admin.getByRole('button', { name: '查看数据' }).first().click();
  await expect(admin.locator('pre').first()).toContainText('"username"');
  await admin.getByRole('button', { name: '收起数据' }).first().click();
  await expect(admin.locator('pre')).toHaveCount(0);

  // 清除筛选：更多种类的动作出现
  await admin.getByRole('button', { name: '清除筛选' }).click();
  await expect(admin.getByRole('table')).toContainText('登录了');
});
