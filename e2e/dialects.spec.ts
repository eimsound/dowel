// MySQL 与 SQL Server 端到端界面测试（零外部容器依赖）：
// - 新建项目向导第 1 步验证 MySQL / SQL Server 均可选（无「即将支持」）；
// - 第 2 步验证连接串占位符、同实例影子库 {原库名}_dowel 提示，以及 MSSQL 的 TLS / 自签名证书提示；
// - 第 3 步验证空白项目与从 SQL 导入提示（SHOW CREATE TABLE / mysqldump；SSMS / T-SQL）；
// - 模型页：验证 MySQL / MSSQL 默认主键列（AUTO_INCREMENT / IDENTITY）、各自专属 Inspector 编辑、表单校验、隐藏不支持区块与 SQL 视图 DDL 渲染；
// - SQL Server 额外覆盖 Schema 设置（dbo）、Sidebar 序列新建与 Inspector PK/Unique/Index CLUSTERED + FILLFACTOR。
import { expect, test } from '@playwright/test';

import { createGroup, gotoPage, newUser, openModel } from './helpers.ts';

test('MySQL 向导、默认主键、属性面板专属编辑、校验与 SQL 视图（零外部容器）', async ({ browser }) => {
  const { page } = await newUser(browser, 'MySQL 用户');
  const group = await createGroup(page, `MySQL 组 ${Date.now().toString(36)}`);

  // 1. 向导第 1 步：MySQL / SQL Server 均开放可选，且无「即将支持」文案
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  await expect(page.getByText(/即将支持/)).toHaveCount(0);
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group.name });
  await page.getByLabel('项目名').fill('MySQL 商店');
  await expect(page.getByRole('radio', { name: /MySQL/ })).toBeEnabled();
  await expect(page.getByRole('radio', { name: /SQL Server/ })).toBeEnabled();
  await page.getByRole('radio', { name: /MySQL/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();

  // 2. 向导第 2 步：检查 MySQL 连接串占位符与同实例影子库提示
  await page.getByRole('button', { name: '添加数据库' }).click();
  await expect(page.getByLabel('连接串', { exact: true })).toHaveAttribute(
    'placeholder',
    'mysql://user:password@host:3306/db',
  );
  await expect(page.getByLabel('单独的影子库连接串（可选，必须是空库）')).toHaveAttribute(
    'placeholder',
    'mysql://user:password@shadow-host:3306/empty_db',
  );
  await expect(page.getByText(/\{原库名\}_dowel/).first()).toBeVisible();
  await page.getByRole('button', { name: '跳过' }).click();

  // 3. 向导第 3 步：检查 SQL 导入提示含 SHOW CREATE TABLE / mysqldump，随后选空白项目创建
  await expect(page.getByText(/SHOW CREATE TABLE|mysqldump --no-data/)).toBeVisible();
  await page.getByRole('radio', { name: /^空白/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('MySQL', { exact: true })).toBeVisible();

  // 4. 模型页：对象树隐藏枚举和序列；新建表验证默认 AUTO_INCREMENT 主键与无 default. 前缀
  await openModel(page);
  const tree = page.getByRole('navigation', { name: '对象' });
  await expect(tree.getByRole('button', { name: /^枚举/ })).toHaveCount(0);
  await expect(tree.getByRole('button', { name: /^序列/ })).toHaveCount(0);

  await page.getByRole('button', { name: '新建表' }).click();
  const inspector = page.getByRole('complementary', { name: '属性' });
  await expect(inspector.getByRole('heading', { name: 'table_1', exact: true })).toBeVisible();
  // MySQL 隐藏 PG 分区区块
  await expect(inspector.getByRole('heading', { name: /^分区/ })).toHaveCount(0);

  // 5. MySQL 表选项：先测试非法存储引擎名校验（失焦触发、保留草稿并设置 aria-invalid）
  const engineInput = inspector.getByLabel('存储引擎', { exact: true });
  await engineInput.click();
  await engineInput.fill('Inno DB');
  await engineInput.press('Enter');
  await expect(engineInput).toHaveAttribute('aria-invalid', 'true');
  await expect(inspector.getByText(/仅允许 1–64 位/)).toBeVisible();

  await engineInput.fill('InnoDB');
  await engineInput.press('Enter');
  await expect(engineInput).not.toHaveAttribute('aria-invalid', 'true');

  const tableCharset = inspector.getByLabel('字符集', { exact: true });
  await tableCharset.click();
  await tableCharset.fill('utf8mb4');
  await tableCharset.press('Enter');

  const tableCollation = inspector.getByLabel('排序规则', { exact: true });
  await tableCollation.click();
  await tableCollation.fill('utf8mb4_0900_ai_ci');
  await tableCollation.press('Enter');

  // 6. 检查默认 id 列（bigint + NOT NULL + AUTO_INCREMENT），且最后一列禁止删除
  await inspector.getByRole('button', { name: /^id\b/ }).click();
  await expect(inspector.getByRole('checkbox', { name: 'AUTO_INCREMENT' })).toBeChecked();
  await expect(inspector.getByRole('checkbox', { name: '非空' })).toBeDisabled();
  await expect(inspector.getByLabel('默认值 id', { exact: true })).toBeDisabled();
  await expect(inspector.getByRole('button', { name: /最后一列，无法删除/ })).toBeDisabled();

  // 7. 新增列测试 enum(...) 类型与列级字符集
  await inspector.getByRole('button', { name: '添加列' }).click();
  const col2Btn = inspector.getByRole('button', { name: /^column_2\b/ });
  await expect(col2Btn).toBeVisible();
  await expect(inspector.getByText(/支持直接输入 enum/)).toBeVisible();
  const col2Type = inspector.getByLabel('类型 column_2', { exact: true });
  await col2Type.click();
  await col2Type.fill("enum('draft', 'published')");
  await col2Type.press('Enter');
  const col2Charset = inspector.getByLabel('字符集 column_2', { exact: true });
  await col2Charset.click();
  await col2Charset.fill('utf8mb4');
  await col2Charset.press('Enter');

  // 8. 新增整数列勾选 UNSIGNED
  await inspector.getByRole('button', { name: '添加列' }).click();
  const col3Type = inspector.getByLabel('类型 column_3', { exact: true });
  await col3Type.click();
  await col3Type.fill('int');
  await col3Type.press('Enter');
  await inspector.getByRole('checkbox', { name: 'UNSIGNED' }).check();

  // 9. 新增 datetime 列勾选 ON UPDATE CURRENT_TIMESTAMP
  await inspector.getByRole('button', { name: '添加列' }).click();
  const col4Type = inspector.getByLabel('类型 column_4', { exact: true });
  await col4Type.click();
  await col4Type.fill('datetime');
  await col4Type.press('Enter');
  await inspector.getByRole('checkbox', { name: 'ON UPDATE CURRENT_TIMESTAMP' }).check();

  // 10. 添加 FULLTEXT 索引：选择 FULLTEXT 后自动禁用唯一复选框
  await inspector.getByRole('button', { name: '添加索引' }).click();
  await inspector.getByRole('checkbox', { name: 'column_2', exact: true }).check();
  await inspector.getByLabel('索引类型').selectOption('FULLTEXT');
  await expect(inspector.getByRole('checkbox', { name: '唯一' })).toBeDisabled();
  await inspector.getByRole('button', { name: '添加索引' }).last().click();
  await expect(inspector.getByText(/FULLTEXT \(column_2\)/)).toBeVisible();

  // 11. 切换到 SQL 视图校验生成的 MySQL DDL
  await page.getByRole('tab', { name: 'SQL' }).click();
  const sqlEditor = page.locator('.cm-content');
  await expect(sqlEditor).toContainText('AUTO_INCREMENT');
  await expect(sqlEditor).toContainText("enum('draft','published')");
  await expect(sqlEditor).toContainText('UNSIGNED');
  await expect(sqlEditor).toContainText('ON UPDATE CURRENT_TIMESTAMP');
  await expect(sqlEditor).toContainText('ENGINE=InnoDB');
  await expect(sqlEditor).toContainText('DEFAULT CHARSET=utf8mb4');
  await expect(sqlEditor).toContainText('COLLATE=utf8mb4_0900_ai_ci');
  await expect(sqlEditor).toContainText('CREATE FULLTEXT INDEX');
});

test('SQL Server 向导（TLS 提示）、Schema 与序列、属性面板专属编辑与 T-SQL 视图（零外部容器）', async ({
  browser,
}) => {
  const { page } = await newUser(browser, 'MSSQL 用户');
  const group = await createGroup(page, `MSSQL 组 ${Date.now().toString(36)}`);

  // 1. 向导第 1 步选 SQL Server
  await page.goto('/new');
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group.name });
  await page.getByLabel('项目名').fill('MSSQL 账本');
  await page.getByRole('radio', { name: /SQL Server/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();

  // 2. 向导第 2 步：检查 MSSQL 连接串占位符、TLS 自签名证书提示及同实例影子库说明
  await page.getByRole('button', { name: '添加数据库' }).click();
  await expect(page.getByLabel('连接串', { exact: true })).toHaveAttribute(
    'placeholder',
    'mssql://user:password@host:1433/db?encrypt=true',
  );
  await expect(page.getByText(/trustServerCertificate=true/)).toBeVisible();
  await expect(page.getByText(/\{原库名\}_dowel/).first()).toBeVisible();
  await page.getByRole('button', { name: '跳过' }).click();

  // 3. 向导第 3 步：检查 dbo 空白提示与 T-SQL 导入提示，随后按空白创建
  await expect(page.getByText(/只有一个 dbo schema/)).toBeVisible();
  await expect(page.getByText(/SSMS.*GO/)).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('SQL Server', { exact: true })).toBeVisible();

  // 4. 设置页验证 MSSQL Schema 范围区块存在且占位符为 dbo, app
  await gotoPage(page, '设置');
  await expect(page.getByLabel(/^手动输入 schema 名（用逗号分隔）/)).toHaveAttribute(
    'placeholder',
    'dbo, app',
  );

  // 5. 模型页：对象树隐藏枚举、展示序列组并支持直接新建序列
  await openModel(page);
  const tree = page.getByRole('navigation', { name: '对象' });
  await expect(tree.getByRole('button', { name: /^枚举/ })).toHaveCount(0);
  await expect(tree.getByRole('button', { name: /^序列/ })).toBeVisible();

  await tree.getByRole('button', { name: '新建序列' }).click();
  const inspector = page.getByRole('complementary', { name: '属性' });
  await expect(inspector.getByRole('heading', { name: /dbo\.\s*seq_1/ })).toBeVisible();

  // 6. 新建表并检查 dbo.table_1、隐藏 PG 分区、默认 PK 为 CLUSTERED + IDENTITY(1,1)
  await page.getByRole('button', { name: '新建表' }).click();
  await expect(inspector.getByRole('heading', { name: /dbo\.\s*table_1/ })).toBeVisible();
  await expect(inspector.getByRole('heading', { name: /^分区/ })).toHaveCount(0);

  await inspector.getByRole('button', { name: /^id\b/ }).click();
  await expect(inspector.getByRole('checkbox', { name: 'IDENTITY' })).toBeChecked();
  const seedInput = inspector.getByLabel('起始值 (seed) id', { exact: true });
  const incInput = inspector.getByLabel('步长 (increment) id', { exact: true });
  await incInput.click();
  await incInput.fill('0');
  await incInput.press('Enter');
  await expect(incInput).toHaveAttribute('aria-invalid', 'true');
  await expect(inspector.getByText('步长不能为 0')).toBeVisible();

  await seedInput.click();
  await seedInput.fill('10');
  await seedInput.press('Enter');
  await incInput.click();
  await incInput.fill('5');
  await incInput.press('Enter');

  // 7. 新增带默认值与自定义默认约束名（defaultName / defaultNameMode）的列
  await inspector.getByRole('button', { name: '添加列' }).click();
  const defInput = inspector.getByLabel('默认值 column_2', { exact: true });
  await defInput.click();
  await defInput.fill("'active'");
  await defInput.press('Enter');
  const dfNameInput = inspector.getByLabel('默认约束名 column_2', { exact: true });
  await expect(inspector.getByText('自动推导')).toBeVisible();
  await dfNameInput.click();
  await dfNameInput.fill('DF_custom_status');
  await dfNameInput.press('Enter');
  await expect(inspector.getByText('显式')).toBeVisible();

  // 8. 新增 uniqueidentifier 列勾选 ROWGUIDCOL
  await inspector.getByRole('button', { name: '添加列' }).click();
  const col3Type = inspector.getByLabel('类型 column_3', { exact: true });
  await col3Type.click();
  await col3Type.fill('uniqueidentifier');
  await col3Type.press('Enter');
  await inspector.getByRole('checkbox', { name: 'ROWGUIDCOL' }).check();

  // 9. 新增可空列勾选 SPARSE
  await inspector.getByRole('button', { name: '添加列' }).click();
  await inspector.getByRole('checkbox', { name: 'SPARSE' }).check();

  // 10. 主键改为 NONCLUSTERED，然后创建带 FILLFACTOR=80 的 CLUSTERED 索引与唯一约束
  await expect(inspector.getByText(/^CLUSTERED \(id\)$/)).toBeVisible();
  await inspector.getByRole('checkbox', { name: 'CLUSTERED' }).first().uncheck();
  await expect(inspector.getByText(/^NONCLUSTERED \(id\)$/)).toBeVisible();

  await inspector.getByRole('button', { name: '添加约束' }).click();
  await page.getByText('唯一约束', { exact: true }).click();
  await inspector.getByRole('checkbox', { name: 'column_2', exact: true }).check();
  await inspector.getByRole('button', { name: '添加唯一约束' }).click();
  await expect(inspector.getByText(/^UNIQUE NONCLUSTERED \(column_2\)$/)).toBeVisible();

  await inspector.getByRole('button', { name: '添加索引' }).click();
  await inspector.getByRole('checkbox', { name: 'column_2', exact: true }).check();
  await inspector.getByRole('checkbox', { name: 'CLUSTERED' }).last().check();
  const ffInput = inspector.getByLabel('FILLFACTOR (1–100)', { exact: true });
  await ffInput.fill('200');
  await ffInput.blur();
  await expect(ffInput).toHaveAttribute('aria-invalid', 'true');
  await ffInput.fill('80');
  await ffInput.blur();
  await expect(ffInput).not.toHaveAttribute('aria-invalid', 'true');
  await inspector.getByRole('button', { name: '添加索引' }).last().click();
  await expect(inspector.getByText(/CLUSTERED \(column_2\) · FILLFACTOR = 80/)).toBeVisible();

  // 11. 切换到 SQL 视图校验生成的 T-SQL（含 GO 批处理与各类 MSSQL 特性）
  await page.getByRole('tab', { name: 'SQL' }).click();
  const sqlEditor = page.locator('.cm-content');
  await expect(sqlEditor).toContainText('CREATE SEQUENCE [dbo].[seq_1]');
  await expect(sqlEditor).toContainText('CREATE TABLE [dbo].[table_1]');
  await expect(sqlEditor).toContainText('IDENTITY(10, 5)');
  await expect(sqlEditor).toContainText('CONSTRAINT [DF_custom_status] DEFAULT');
  await expect(sqlEditor).toContainText('ROWGUIDCOL');
  await expect(sqlEditor).toContainText('SPARSE');
  await expect(sqlEditor).toContainText('PRIMARY KEY NONCLUSTERED');
  await expect(sqlEditor).toContainText('UNIQUE NONCLUSTERED');
  await expect(sqlEditor).toContainText('CREATE CLUSTERED INDEX');
  await expect(sqlEditor).toContainText('WITH (FILLFACTOR = 80)');
  await expect(sqlEditor).toContainText('GO');
});
