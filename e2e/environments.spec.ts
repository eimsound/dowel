// 需要 PG 作影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过
import { expect, test } from '@playwright/test';
import { connectPg } from '../apps/server/src/targets.ts';
import { createProject, gotoPage, newUser, openEnvironment } from './helpers.ts';

const ADMIN = process.env.DOWEL_TEST_PG;

test.skip(!ADMIN, '没有可用的 PostgreSQL（需要 Docker）');

test('添加环境、从数据库导入、在同实例影子库验证', async ({ browser }) => {
  const admin = connectPg(ADMIN!);
  for (const d of ['e2e_shop', 'e2e_shop_dowel'])
    await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  await admin.db.exec('CREATE DATABASE e2e_shop');
  await admin.close();
  const u = new URL(ADMIN!);
  u.pathname = '/e2e_shop';
  const shop = connectPg(u.toString());
  await shop.db.exec(`create table products (id serial primary key, name text not null, price numeric(10,2) check (price > 0));
                      create view cheap as select id, name from products where price < 10;`);
  await shop.close();

  const { page } = await newUser(browser, '张三');
  await createProject(page, '商店');
  await gotoPage(page, '环境');
  await page.getByLabel('名字').fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(u.toString());
  await page.getByLabel('生产环境').uncheck();
  await page.getByRole('button', { name: '添加环境' }).click();
  await expect(
    page.getByRole('navigation', { name: '环境列表' }).getByRole('link', { name: 'dev', exact: true }),
  ).toBeVisible();

  await openEnvironment(page, 'dev');
  await expect(page.getByText(u.password)).toHaveCount(0); // 密码不显示
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText(/e2e_shop：PostgreSQL 18/)).toBeVisible();

  // 拉取失败只显示一条错误（提示条），不重复显示
  const pullPattern = /\/api\/projects\/[^/]+\/environments\/[^/]+\/pull$/;
  const failPull = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: '拉取失败' }),
    });
  await page.route(pullPattern, failPull);
  // 导入先打开对话框预览（读线上结构）：预览失败在对话框里显示原因
  await page.getByRole('button', { name: '从此库导入结构' }).click();
  const imp = page.getByRole('dialog', { name: '把线上结构导入工作副本' });
  await expect(imp.getByText('拉取失败')).toHaveCount(1);
  await page.unroute(pullPattern, failPull);
  await imp.getByRole('button', { name: '取消' }).click();

  // 重新打开：预览差异，确认后覆盖工作副本
  await page.getByRole('button', { name: '从此库导入结构' }).click();
  await expect(imp).toContainText('覆盖会带来的变化', { timeout: 30_000 });
  await imp.getByRole('button', { name: '覆盖工作副本' }).click();
  await expect(page.getByText(/已导入：工作副本现在是线上结构/)).toBeVisible();

  await gotoPage(page, '模型');
  await expect(
    page.getByRole('navigation').getByRole('button', { name: 'products', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: '迁移' }).click();
  const mig = page.getByRole('dialog', { name: '迁移' });
  await expect(mig.getByLabel('验证用的影子库')).toHaveValue(/.+/);
  await mig.getByRole('button', { name: '在影子库验证' }).click();
  await expect(mig.getByRole('status')).toContainText('验证通过', { timeout: 60_000 });
  await expect(mig.getByRole('status')).toContainText('影子库：dev：e2e_shop_dowel');
});
