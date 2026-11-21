// 应用外壳的导航（P2）：我的项目 → 项目概览 → 每个项目页面 → 组首页 → 回到项目；
// 断言图标栏的 aria-current，以及 `[` 能收起 / 展开侧面板。
import { expect, test } from '@playwright/test';

import { createProject, newUser } from './helpers.ts';

const rail = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '实例与项目' });

test('外壳导航：图标栏、aria-current、侧面板快捷键', async ({ browser }) => {
  const { page } = await newUser(browser, '导航员');
  const projectUrl = await createProject(page, '导航测试');
  const owner = new URL(projectUrl).pathname.split('/')[2]!;
  const groups = (await (await page.request.get('/api/groups')).json()) as {
    groups: { slug: string; name: string }[];
  };
  const groupName = groups.groups.find((g) => g.slug === owner)!.name;

  // 概览：图标栏里的概览是当前页
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');

  const pages: { name: string; path: string }[] = [
    { name: '模型', path: '/model' },
    { name: '版本', path: '/versions' },
    { name: '环境', path: '/environments' },
    { name: '动态', path: '/activity' },
    { name: '成员与授权', path: '/members' },
    { name: '设置', path: '/settings' },
    { name: '概览', path: '' },
  ];
  for (const p of pages) {
    await rail(page).getByRole('link', { name: p.name }).click();
    await page.waitForURL(new RegExp(`${p.path || '/project/[^/]+/[^/]+$'}`));
    await expect(rail(page).getByRole('link', { name: p.name })).toHaveAttribute('aria-current', 'page');
  }

  // 模型页：对象树在侧面板里；`[` 收起、再按一次展开
  await rail(page).getByRole('link', { name: '模型' }).click();
  const objects = page.getByRole('navigation', { name: '对象' });
  await expect(objects).toBeVisible();
  await page.keyboard.press('[');
  await expect(objects).toBeHidden();
  await page.keyboard.press('[');
  await expect(objects).toBeVisible();

  // 属性面板默认按需：选中出现，Esc 消失；固定后常驻，刷新仍然常驻
  const inspector = page.getByRole('complementary', { name: '属性' });
  await expect(inspector).toBeHidden();
  await page.getByRole('button', { name: '新建表' }).click();
  await expect(objects.getByRole('button', { name: 'table_1' })).toBeVisible();
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toBeHidden();
  await page.getByRole('button', { name: '固定属性面板' }).click();
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText('没有选中对象')).toBeVisible();
  await page.reload();
  await expect(inspector).toBeVisible();
  await page.getByRole('button', { name: '取消固定属性面板' }).click();

  // 不存在的环境：文案是“环境不存在”，不是“还没有环境”
  await page.goto(`${projectUrl.replace(/\/$/, '')}/environments/no-such-env`);
  await expect(page.getByText('环境不存在，或者已经被删除。')).toBeVisible();
  await expect(page.getByText('还没有环境。添加一个环境后，导入 SQL、验证迁移都需要它。')).toHaveCount(0);

  // 组首页：当前组的头像高亮，侧面板是组内项目（面包屑第一段就是组）
  await page.getByRole('navigation', { name: '位置' }).getByRole('link').first().click();
  await page.waitForURL(`/group/${owner}`);
  await expect(page.getByRole('heading', { name: groupName, exact: true })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: groupName, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('navigation', { name: '项目', exact: true })).toBeVisible();

  // 通过组页的侧面板回到项目
  await page
    .getByRole('navigation', { name: '项目', exact: true })
    .getByRole('link', { name: '导航测试' })
    .click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
});

test('项目加载失败时显示错误和重试按钮', async ({ browser }) => {
  const { page } = await newUser(browser, '错误页');
  await createProject(page, '错误页项目');

  const pattern = /\/api\/projects\/[^/]+$/;
  const fail = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: '服务器暂时不可用' }),
    });
  await page.route(pattern, fail);
  await page.reload();
  await expect(page.getByText('项目加载失败')).toBeVisible();
  await expect(page.getByText('服务器暂时不可用')).toBeVisible();

  await page.unroute(pattern, fail);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
});
