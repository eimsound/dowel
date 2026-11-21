// SQLite 目标库端到端测试（零外部依赖）：
// - 新建项目向导选择 SQLite（验证 MySQL / SQL Server 暂不可选）→ 跳过环境 → 零环境从 SQL 导入；
// - 概览显示 SQLite 方言与已验证 v0 基线；
// - 模型页：对象树隐藏 main. 前缀、状态栏显示 SQLite :memory: 影子库、属性面板支持 SQLite STRICT/WITHOUT ROWID/AUTOINCREMENT 且隐藏 PG 分区/注释；
// - 新增列 + SQL 视图预览 + 零环境发布 v1（自动通过 :memory: 影子库验证）。
import { expect, test } from '@playwright/test';

import { createGroup, gotoPage, newUser, openModel } from './helpers.ts';

test('SQLite 零环境向导导入、建模编辑、SQL 预览与自动验证发布', async ({ browser }) => {
  const { page } = await newUser(browser, 'SQLite 用户');
  const group = await createGroup(page, `SQLite 组 ${Date.now().toString(36)}`);

  // 1. 向导第 1 步：选择 SQLite 方言，确认 MySQL / SQL Server 处于禁用状态
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group.name });
  await page.getByLabel('项目名').fill('SQLite 笔记');
  await expect(page.getByRole('radio', { name: /MySQL/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /SQL Server/ })).toBeDisabled();
  await page.getByRole('radio', { name: /SQLite/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();

  // 2. 向导第 2 步：直接跳过外部环境配置
  await page.getByRole('button', { name: '跳过' }).click();

  // 3. 向导第 3 步：零环境选择从 SQL 导入
  await page.getByRole('radio', { name: /从 SQL 导入/ }).check();
  await expect(page.getByText(/SQLite :memory:/)).toBeVisible();
  await page.getByLabel('SQL', { exact: true }).fill(
    `CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    ) STRICT;`,
  );
  await page.getByRole('button', { name: '下一步' }).click();

  // 4. 确认并创建
  await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('SQLite', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '基线', exact: true })).toBeVisible();

  // 5. 模型页：状态栏、对象树与属性面板适配 SQLite
  await openModel(page);
  await expect(page.getByText('影子库：SQLite :memory:')).toBeVisible();
  const tree = page.getByRole('navigation', { name: '对象' });
  const notesBtn = tree.getByRole('button', { name: 'notes', exact: true });
  await expect(notesBtn).toBeVisible();
  await notesBtn.click();

  const inspector = page.getByRole('complementary', { name: '属性' });
  await expect(inspector.getByText('SQLite 表选项')).toBeVisible();
  await expect(inspector.getByRole('checkbox', { name: /STRICT/ })).toBeChecked();
  // SQLite 不支持 PG 分区与表注释
  await expect(inspector.getByRole('heading', { name: /^分区/ })).toHaveCount(0);
  await expect(inspector.getByLabel('注释')).toHaveCount(0);

  // 6. 添加一列并检查 SQL 视图
  await inspector.getByRole('button', { name: '添加列' }).click();
  await expect(inspector.getByRole('button', { name: /^column_3\b/ })).toBeVisible();

  await page.getByRole('tab', { name: 'SQL' }).click();
  await expect(page.getByText(/CREATE TABLE notes[\s\S]*STRICT/)).toBeVisible();

  // 6.5. 零环境在迁移弹窗直接通过 :memory: 影子库闭环验证
  await page.getByRole('button', { name: '迁移' }).click();
  const migDlg = page.getByRole('dialog', { name: '迁移' });
  const verifyBtn = migDlg.getByRole('button', { name: '验证' });
  await expect(verifyBtn).toBeEnabled();
  await verifyBtn.click();
  await expect(migDlg.getByText('验证通过')).toBeVisible();
  await migDlg.getByRole('button', { name: '关闭' }).first().click();

  // 7. 零环境直接发布 v1，经内置 :memory: 影子库自动验证通过
  await page.getByRole('button', { name: '发布' }).click();
  const dlg = page.getByRole('dialog', { name: '发布' });
  await dlg.getByLabel('版本名').fill('add-column');
  await dlg.getByRole('button', { name: '发布' }).click();
  await expect(dlg).not.toBeVisible();

  await gotoPage(page, '版本');
  const v1Link = page.getByRole('link', { name: 'add-column', exact: true });
  await expect(v1Link).toBeVisible();
  await v1Link.click();
  await expect(page.getByText('已验证')).toBeVisible();
  await expect(page.getByText(/SQLite :memory:/)).toBeVisible();
});
