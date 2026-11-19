// 组与可见性：管理员建组 → 邀请用户加入组 → 用户能看到组里的项目；移出组后项目当作不存在；
// 旧地址 /p/:pid 跳转到 /project/:owner/:project。
import { expect, test } from '@playwright/test';
import { adminPage, createGroup, createProjectIn, newUser } from './helpers.ts';

test('管理员建组 → 邀请加入组 → 能看到组里的项目；移出后项目返回不存在；旧地址跳转', async ({ browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/');
  const group = await createGroup(admin, `平台组 ${Date.now().toString(36)}`);

  // 在刚建的组里建项目（向导：基本信息 → 跳过数据库 → 初始内容 → 确认）
  await createProjectIn(admin, '组项目', group.name);
  const projectUrl = admin.url();
  expect(new URL(projectUrl).pathname).toMatch(new RegExp(`^/project/${group.slug}/[a-z0-9-]+$`));

  const groups = (await (await admin.request.get('/api/groups')).json()) as {
    groups: { id: string; slug: string }[];
  };
  const groupId = groups.groups.find((g) => g.slug === group.slug)!.id;
  const projects = (await (await admin.request.get(`/api/groups/${group.slug}/projects`)).json()) as {
    id: string;
  }[];
  const pid = projects[0]!.id;

  // 管理员生成带组的邀请；新用户接受后自动成为组成员（默认权限：编辑者）
  const invite = (await (
    await admin.request.post('/api/admin/invites', { data: { groupIds: [groupId] } })
  ).json()) as { url: string };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(invite.url);
  await page.getByLabel('用户名').fill('groupie');
  await page.getByLabel('名字').fill('组员');
  await page.getByLabel('密码').fill('password123');
  await page.getByRole('button', { name: '接受邀请' }).click();
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();

  // 项目列表里能看到组和项目
  await expect(page.getByRole('heading', { name: group.name })).toBeVisible();
  await expect(page.getByText('组项目')).toBeVisible();

  await page.goto(projectUrl);
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
  await expect(page.getByRole('button', { name: '新建表' })).toBeVisible();

  // 旧地址跳转到新地址
  await page.goto(`/p/${pid}`);
  await expect(page).toHaveURL(new RegExp(`/project/${group.slug}/`));
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  // 移出组之后：项目当作不存在
  const users = (await (await admin.request.get('/api/admin/users?q=groupie')).json()) as {
    id: string;
  }[];
  expect((await admin.request.delete(`/api/groups/${group.slug}/members/${users[0]!.id}`)).ok()).toBe(true);
  await page.goto(projectUrl);
  await expect(page.getByText('项目不存在，或者你没有权限。')).toBeVisible();
});

test('切换组时未保存的表单不会带到另一个组', async ({ browser }) => {
  const { page } = await newUser(browser, '组切换');
  const a = await createGroup(page, `Alpha 组 ${Date.now().toString(36)}`);
  const b = await createGroup(page, `Beta 组 ${Date.now().toString(36)}`);
  const rail = page.getByRole('navigation', { name: '实例与项目' });

  // 两个组的头像首字不同，背景色也不同（不是一律显示“组”）
  const initials = await rail.locator('.rail-org-av').allTextContents();
  expect(initials).toEqual(expect.arrayContaining(['A', 'B']));
  const style = (name: string) =>
    rail.getByRole('link', { name, exact: true }).locator('.rail-org-av').getAttribute('style');
  expect(await style(a.name)).toContain('--peer-');
  expect(await style(b.name)).toContain('--peer-');

  await page.goto(`/group/${a.slug}`);
  const nameInput = page.getByLabel('组名');
  await expect(nameInput).toHaveValue(a.name);
  await nameInput.fill('未保存的组名');

  // 只换 slug：组件要重新挂载，显示 B 的值
  await rail.getByRole('link', { name: b.name, exact: true }).click();
  await page.waitForURL(`/group/${b.slug}`);
  await expect(page.getByLabel('组名')).toHaveValue(b.name);
});

test('删除组失败时错误显示在确认对话框里', async ({ browser }) => {
  const { page } = await newUser(browser, '删组');
  const group = await createGroup(page, `平台组 ${Date.now().toString(36)}`);
  await createProjectIn(page, '占位项目', group.name);

  await page.goto(`/group/${group.slug}`);
  await page.getByRole('button', { name: '删除组' }).click();
  const dlg = page.getByRole('dialog', { name: `删除组 ${group.name}？` });
  await dlg.getByRole('button', { name: '删除组' }).click();
  await expect(dlg.getByRole('alert')).toContainText('组里还有项目，不能删除');
  await expect(dlg).toBeVisible();
});

test('图标栏只显示我的组；正在看的组不是我的组时临时显示', async ({ browser }) => {
  const { page } = await newUser(browser, '组图标');
  const mine = await createGroup(page, `我的组 ${Date.now().toString(36)}`);
  const admin = await adminPage(browser);
  await admin.goto('/');
  const other = await createGroup(admin, `别人的组 ${Date.now().toString(36)}`);

  const rail = page.getByRole('navigation', { name: '实例与项目' });
  await page.goto('/');
  await expect(rail.getByRole('link', { name: mine.name, exact: true })).toBeVisible();
  // 不是成员的组不出现在图标栏
  await expect(rail.getByRole('link', { name: other.name, exact: true })).toHaveCount(0);

  // “我的项目”页可以浏览所有组（组本身对所有人可见）
  await expect(page.getByRole('heading', { name: '所有组' })).toBeVisible();
  await page
    .getByRole('main')
    .getByRole('link', { name: new RegExp(other.name) })
    .click();
  await expect(page.getByRole('heading', { name: other.name, exact: true })).toBeVisible();

  // 正在看别人的组：图标栏临时显示它，并标明不是我的组（虚线边框 + tooltip）
  const temp = rail.getByRole('link', { name: other.name, exact: true });
  await expect(temp).toBeVisible();
  await expect(temp).toHaveAttribute('data-temp', '');
  await expect(temp.locator('.rail-org-av')).toHaveCSS('border-style', 'dashed');

  // 组很多时组区域单独滚动，底部的收件箱始终可见
  await expect(rail.locator('.rail-orgs')).toHaveCSS('overflow-y', 'auto');
  await expect(rail.getByRole('button', { name: '收件箱（即将推出）' })).toBeVisible();
});
