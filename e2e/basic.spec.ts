// 需要 PG 作影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过
import { expect, test } from '@playwright/test';
import { addEnvironment, commit, createProject, gotoPage, newUser, openModel } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

test('建表、编辑、发布、生成并验证迁移', async ({ browser }) => {
  const { page } = await newUser(browser, '张三');
  await createProject(page, '商城');
  await addEnvironment(page, 'e2e_basic');
  await openModel(page);

  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  // 新加的列自动展开编辑区
  await page.getByRole('button', { name: '添加列' }).click();
  await commit(page, '列名 column_2', 'total');
  await commit(page, '类型 total', 'numeric(12,2)');
  await page.getByRole('checkbox', { name: '非空' }).check();
  await page.getByRole('button', { name: '添加约束' }).click();
  await page.getByText('CHECK 约束', { exact: true }).click();
  await commit(page, 'CHECK 表达式', 'total >= 0');
  // 服务器在影子库里把表达式换成引擎的规范形式
  await expect(page.getByLabel('表达式 orders_total_check')).toHaveValue('(total >= (0)::numeric)');

  // SQL 视图
  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.getByLabel('DDL')).toContainText('CREATE TABLE public.orders');
  await expect(page.getByLabel('DDL')).toContainText(
    'CONSTRAINT orders_total_check CHECK ((total >= (0)::numeric))',
  );
  await page.getByRole('tab', { name: '画布' }).click();

  // 发布，再改：列改名、加索引
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v1');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  // 项目有环境：发布时已在影子库里闭环验证，版本号是链上的序号
  await expect(page.getByText('已发布 v1 v1，已通过验证')).toBeVisible();
  await commit(page, '列名 total', 'amount');
  await expect(page.getByLabel('表达式 orders_amount_check')).toHaveValue('(amount >= (0)::numeric)'); // 推导名和表达式跟着改

  await page.getByRole('button', { name: '迁移' }).click();
  const dlg = page.getByRole('dialog', { name: '迁移' });
  await expect(dlg.getByRole('list', { name: '升级脚本' })).toContainText('RENAME COLUMN total TO amount');
  await expect(dlg.getByRole('list', { name: '升级脚本' })).toContainText(
    'RENAME CONSTRAINT orders_total_check TO orders_amount_check',
  );
  await dlg.getByRole('button', { name: '在影子库验证' }).click();
  await expect(dlg.getByRole('status')).toContainText('验证通过', { timeout: 30_000 });
  await page.keyboard.press('Escape');

  // 版本页：v1 已验证；详情里是冻结的迁移，最新版本的脚本可以逐步编辑，改完回到未验证，重新验证后恢复
  await gotoPage(page, '版本');
  await expect(page.locator('.chip', { hasText: /^v1$/ })).toBeVisible();
  await expect(page.locator('.risk', { hasText: '已验证' })).toBeVisible();
  await page.getByRole('link', { name: 'v1', exact: true }).click();
  await expect(page.getByRole('heading', { name: '版本详情' })).toBeVisible();
  await expect(page.getByRole('list', { name: '升级脚本' })).toContainText('CREATE TABLE public.orders');
  await page.getByRole('button', { name: '编辑脚本' }).click();
  await page.getByRole('button', { name: '添加一步' }).click();
  // 新加的一步在最后（v1 本来有建表、加约束等几步）
  await page
    .getByRole('textbox', { name: /^升级脚本第 \d+ 步$/ })
    .last()
    .click();
  await page.keyboard.type('SELECT 1');
  await page.getByRole('checkbox', { name: '非事务' }).last().check();
  await page.getByRole('button', { name: '保存脚本' }).click();
  await expect(page.getByText('脚本已保存，版本回到未验证')).toBeVisible();
  await expect(page.locator('.risk', { hasText: '人工编辑' })).toBeVisible();
  await expect(page.locator('.risk', { hasText: '未验证' })).toBeVisible();
  await expect(page.getByRole('list', { name: '升级脚本' })).toContainText('SELECT 1');
  await expect(page.getByRole('list', { name: '升级脚本' })).toContainText('非事务');
  await page.getByRole('button', { name: '重新验证' }).click();
  await expect(page.getByRole('status').filter({ hasText: '验证通过' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.risk', { hasText: '已验证' })).toBeVisible();
  await expect(page.locator('.risk', { hasText: '人工编辑' })).toBeVisible();
});
