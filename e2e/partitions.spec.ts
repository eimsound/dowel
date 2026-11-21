// PG 分区表端到端验证：配置分区策略、增删改子分区、脱离与挂载、发布验证与已发布策略只读。
// 需要 PG 作影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过。
import { expect, test } from '@playwright/test';

import { addEnvironment, commit, createProject, newUser, openModel } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

test('分区表配置、子分区增删改、脱离与挂载、发布及影子库迁移验证', async ({ browser }) => {
  const { page } = await newUser(browser, '分区测试');
  await createProject(page, '日志系统');
  await addEnvironment(page, 'e2e_partitions');
  await openModel(page);

  // 1. 建表 events，新增分区键列 created_at 并纳入复合主键
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'events');

  await page.getByRole('button', { name: '添加列' }).click();
  await commit(page, '列名 column_2', 'created_at');
  await commit(page, '类型 created_at', 'timestamptz');
  await page.getByRole('checkbox', { name: '非空' }).check();
  await page.getByRole('checkbox', { name: '主键' }).check();

  // 2. 配置 RANGE 分区策略（按 created_at 列）
  await page.getByRole('button', { name: '配置分区' }).click();
  await page.getByLabel('分区策略').selectOption('range');
  await page.getByLabel('选择列 1').selectOption({ label: 'created_at' });
  await page.getByRole('button', { name: '保存分区策略' }).click();

  await expect(page.getByText('RANGE (created_at)')).toBeVisible();
  // 分区键列类型与删除按钮应被锁定
  await expect(page.getByLabel('类型 created_at')).toBeDisabled();
  await expect(page.getByRole('button', { name: '无法删除分区键列 created_at' })).toBeDisabled();
  await expect(page.getByText('该列被分区键引用，不能修改类型或删除。')).toBeVisible();

  // 3. 添加 RANGE 子分区与 DEFAULT 子分区
  await page.getByRole('button', { name: '添加子分区' }).click();
  await page.getByLabel('子分区名').fill('events_2025');
  await page.getByLabel('起始值（FROM）').fill("'2025-01-01'");
  await page.getByLabel('结束值（TO）').fill("'2026-01-01'");
  await page.getByRole('button', { name: '添加子分区' }).last().click();

  // 影子库自动将日期字面量规范化为带时区的 timestamptz
  await expect(
    page.getByText("FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2026-01-01 00:00:00+00')"),
  ).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '添加子分区' }).click();
  await page.getByLabel('子分区名').fill('events_default');
  await page.getByRole('checkbox', { name: 'DEFAULT 默认分区' }).check();
  await page.getByRole('button', { name: '添加子分区' }).last().click();
  await expect(page.getByText('DEFAULT', { exact: true })).toBeVisible();

  // 侧边栏展示策略与数量，展开可见子分区
  const nav = page.getByRole('navigation', { name: '对象' });
  await expect(nav).toContainText('RANGE · 2');
  await nav.getByRole('button', { name: '展开或收起 events 的子分区' }).click();
  await expect(nav.getByRole('button', { name: 'events_2025' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'events_default' })).toBeVisible();

  // 4. 修改子分区边界
  await page.getByRole('button', { name: '修改子分区 events_2025 的边界' }).click();
  await page.getByLabel('结束值（TO）').fill("'2025-07-01'");
  await page.getByRole('button', { name: '保存边界' }).click();
  await expect(
    page.getByText("FOR VALUES FROM ('2025-01-01 00:00:00+00') TO ('2025-07-01 00:00:00+00')"),
  ).toBeVisible({ timeout: 20_000 });

  // 5. 脱离子分区为普通表，再从“挂载已有表”重新挂回
  await page.getByRole('button', { name: '脱离子分区 events_2025' }).click();
  await expect(nav).toContainText('RANGE · 1');

  await page.getByRole('button', { name: '挂载已有表' }).click();
  await page.getByLabel('选择兼容的普通表').selectOption({ label: 'events_2025' });
  await page.getByLabel('起始值（FROM）').fill("'2025-01-01'");
  await page.getByLabel('结束值（TO）').fill("'2025-07-01'");
  await page.getByRole('button', { name: '挂载为子分区' }).click();
  await expect(nav).toContainText('RANGE · 2');

  // 6. 删除子分区
  await page.getByRole('button', { name: '删除子分区 events_default' }).click();
  await expect(nav).toContainText('RANGE · 1');

  // 7. SQL 视图包含 PARTITION BY 与 PARTITION OF
  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.getByLabel('DDL')).toContainText('PARTITION BY RANGE (created_at)');
  await expect(page.getByLabel('DDL')).toContainText(
    'CREATE TABLE public.events_2025 PARTITION OF public.events',
  );
  await page.getByRole('tab', { name: '画布' }).click();

  // 8. 发布 v1（在影子库闭环验证）
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v1');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByText('已发布 v1 v1，已通过验证')).toBeVisible({ timeout: 30_000 });

  // 已发布后，策略变为只读（不再显示“编辑策略”按钮，显示说明）
  await expect(page.getByRole('button', { name: '编辑策略' })).toHaveCount(0);
  await expect(page.getByText('表已存在于已发布版本中')).toBeVisible();

  // 已发布后仍可新增子分区，并通过迁移影子库闭环验证
  await page.getByRole('button', { name: '添加子分区' }).click();
  await page.getByLabel('子分区名').fill('events_2025_h2');
  await page.getByLabel('起始值（FROM）').fill("'2025-07-01'");
  await page.getByLabel('结束值（TO）').fill("'2026-01-01'");
  await page.getByRole('button', { name: '添加子分区' }).last().click();
  await expect(nav).toContainText('RANGE · 2');

  await page.getByRole('button', { name: '迁移' }).click();
  const dlg = page.getByRole('dialog', { name: '迁移' });
  await expect(dlg.getByRole('list', { name: '升级脚本' })).toContainText(
    'CREATE TABLE public.events_2025_h2 PARTITION OF public.events',
  );
  await dlg.getByRole('button', { name: '在影子库验证' }).click();
  await expect(dlg.getByRole('status')).toContainText('验证通过', { timeout: 30_000 });
});
