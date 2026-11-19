// 转组（P2）：成功后跳到新地址，面包屑和图标栏显示新组，相关缓存全部失效。
import { expect, test } from '@playwright/test';
import { createGroup, createProject, gotoPage, newUser } from './helpers.ts';

test('转组后跳到新地址，面包屑和图标栏都是新组', async ({ browser }) => {
  const { page } = await newUser(browser, '转组');
  const projectUrl = await createProject(page, '转组项目');

  await page.goto('/');
  const target = await createGroup(page, `目标组 ${Date.now().toString(36)}`);
  await page.goto(projectUrl);
  await gotoPage(page, '设置');

  await page.getByLabel('目标组', { exact: true }).selectOption({ label: target.name });
  await page.getByRole('button', { name: '转组' }).click();
  await page.waitForURL(new RegExp(`/project/${target.slug}/`));

  await expect(
    page.getByRole('navigation', { name: '位置' }).getByRole('link', { name: target.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: '实例与项目' })
      .getByRole('link', { name: target.name, exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
});
