// 需要 PG 作影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过
import { expect, test } from '@playwright/test';
import { connectPg } from '../apps/server/src/targets.ts';
import { openEnv } from './exec-helpers.ts';
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

test('环境详情页：标记为生产环境与取消生产标记（二次确认 + 自动锁定原生产策略）', async ({ browser }) => {
  const dbName = `e2e_prod_toggle_${Math.random().toString(36).slice(2, 6)}`;
  const admin = connectPg(ADMIN!);
  await admin.db.exec(`CREATE DATABASE ${dbName}`);
  await admin.close();
  const u = new URL(ADMIN!);
  u.pathname = `/${dbName}`;
  try {
    const { page } = await newUser(browser, '环境管理员');
    await createProject(page, '生产标记项目');
    await gotoPage(page, '环境');
    await page.getByLabel('名字').fill('app');
    await page.getByLabel('连接串', { exact: true }).fill(u.toString());
    await page.getByLabel('生产环境').check();
    await page.getByLabel('允许在同一实例上建影子库').check();
    await page.getByRole('button', { name: '添加环境' }).click();
    await openEnv(page, 'app');

    // 初始为生产环境：连接配置区提供“取消生产标记”按钮
    await expect(page.getByRole('button', { name: '取消生产标记' })).toBeVisible();
    await page.getByRole('button', { name: '取消生产标记' }).click();
    const dlg = page.getByRole('dialog', { name: /取消 app 的生产环境标记/ });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('environment.unmark_production');
    await expect(dlg).toContainText('不会悄悄放宽');
    await dlg.getByRole('button', { name: '取消生产标记' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText('已取消环境 app 的生产环境标记')).toBeVisible();
    // 取消后自动锁定原生产策略（谁能执行仍为项目管理员，而非悄悄放宽成编辑者）
    const envPolicy = page.getByRole('group', { name: /本环境（非生产）/ });
    await expect(envPolicy).toContainText('生效：项目管理员');

    // 再重新标记为生产环境
    await page.getByRole('button', { name: '标记为生产环境' }).click();
    await expect(page.getByText('已将环境 app 标记为生产环境')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消生产标记' })).toBeVisible();
  } finally {
    const a = connectPg(ADMIN!);
    for (const d of [dbName, `${dbName}_dowel`]) await a.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await a.close();
  }
});
