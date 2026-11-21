// 删除项目（P2a 遗留）：必须原样输入项目标识；删除后回“我的项目”，旧地址 404。
// 平台库里的数据是否删干净由 apps/server/test/project-delete.test.ts 覆盖，这里验证界面路径。
import { expect, test } from '@playwright/test';

import { createProject, gotoPage, newUser } from './helpers.ts';

test('删除项目：确认文字必须匹配，删除后回我的项目，旧地址 404', async ({ browser }) => {
  const { page } = await newUser(browser, '删除项目');
  const url = await createProject(page, '要被删掉的项目');
  const slug = new URL(url).pathname.split('/')[3]!;

  await gotoPage(page, '设置');
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

  const confirm = page.getByLabel(/输入项目标识/);
  const remove = page.getByRole('button', { name: '删除项目', exact: true });
  await expect(remove).toBeDisabled();
  await confirm.fill('not-the-slug');
  await expect(remove).toBeDisabled();
  await confirm.fill(slug);
  await expect(remove).toBeEnabled();
  await remove.click();

  await expect(page.getByText('已删除项目')).toBeVisible();
  await page.waitForURL('/');
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
  await expect(page.getByText('要被删掉的项目')).toHaveCount(0);

  // 旧地址不再存在
  await page.goto(url);
  await expect(page.getByText('项目不存在，或者你没有权限。')).toBeVisible();
});
