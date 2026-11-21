// 新建项目向导（P3）：三条创建路径——从数据库导入（勾选 schema）、空白、从 SQL 导入。
// 需要真实 PG（Testcontainers 或 DOWEL_TEST_PG）作为目标库 / 影子库；没有 Docker 时跳过。
import { expect, type Page, test } from '@playwright/test';

import { connectPg } from '../apps/server/src/targets.ts';
import { createGroup, newUser } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

/** 测试实例上另一个库的连接串（不用 test/pg.ts：它依赖 vitest 的注入） */
const dbUrl = (name: string) => {
  const u = new URL(process.env.DOWEL_TEST_PG!);
  u.pathname = `/${name}`;
  return u.toString();
};

/** 建一个测试库（先删掉上次留下的同名库和它的影子库），返回连接串 */
const makeDb = async (name: string, sql: string) => {
  const admin = connectPg(process.env.DOWEL_TEST_PG!);
  for (const d of [name, `${name}_dowel`]) await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  await admin.db.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const target = connectPg(dbUrl(name));
  if (sql) await target.db.exec(sql);
  await target.close();
  return dbUrl(name);
};

/** 在目标库里数一下某个 schema / schema 下的表（确认向导没有写目标库） */
const countTarget = async (url: string, sql: string) => {
  const target = connectPg(url);
  const [row] = await target.db.query<{ n: number }>(sql);
  await target.close();
  return row!.n;
};

/** 新建用户、建一个组（项目必须属于组），然后进向导填好基本信息 */
const startWizard = async (page: Page, name: string) => {
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  await page.getByLabel('项目名').fill(name);
  await page.getByRole('button', { name: '下一步' }).click();
};

test('从数据库导入：勾选一个 schema，完成后有 v0 基线，模型里只有选中的表', async ({ browser }) => {
  const url = await makeDb(
    'e2e_wizard_import',
    `create schema alpha;
     create table alpha.customers (id int primary key, email text unique);
     create table alpha.orders (id int primary key, customer_id int references alpha.customers);
     create schema beta;
     create table beta.notes (id int primary key);`,
  );
  const { page } = await newUser(browser, '向导导入');
  await createGroup(page, `向导导入组 ${Date.now().toString(36)}`);

  await startWizard(page, '导入项目');
  // 第 2 步：添加数据库并检查连接（结果里有版本、权限、schema 和表数）
  await page.getByRole('button', { name: '添加数据库' }).click();
  await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(url);
  await page.getByLabel('生产环境').uncheck();
  await page.getByRole('button', { name: '检查连接' }).click();
  await expect(page.getByText('连接正常')).toBeVisible();
  await expect(page.getByText(/PostgreSQL 18/)).toBeVisible();
  await expect(page.getByText('alpha · 2 张表')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();

  // 第 3 步：从数据库导入，默认全选，取消 beta
  await page.getByRole('radio', { name: /从数据库导入/ }).check();
  await expect(page.getByText('勾选要导入的 schema（默认全选）')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^alpha/ })).toBeChecked();
  await page.getByRole('checkbox', { name: /^beta/ }).uncheck();
  await page.getByRole('button', { name: '下一步' }).click();

  // 第 4 步：汇总里的 schema 范围是“勾掉的 beta 不在里面”
  await expect(page.getByRole('main').getByText('alpha、public')).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  // 导入完成后自动发布 v0 基线
  // 概览的版本列表复用 VersionStatus：v0 基线显示为“基线”，序号 v0 是单独的标记
  await expect(page.getByRole('link', { name: '基线', exact: true })).toBeVisible();

  // 模型页：只有 alpha 的两张表
  await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
  const tree = page.getByRole('navigation', { name: '对象' });
  await expect(tree.getByRole('button', { name: 'alpha.customers', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'alpha.orders', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'beta.notes', exact: true })).toHaveCount(0);

  // 目标库没有被写：没有 dowel schema
  expect(await countTarget(url, "select count(*)::int as n from pg_namespace where nspname = 'dowel'")).toBe(
    0,
  );
});

test('空白项目：没有版本，只有空的 public schema', async ({ browser }) => {
  const { page } = await newUser(browser, '向导空白');
  const group = await createGroup(page, `向导空白组 ${Date.now().toString(36)}`);
  await startWizard(page, '空白项目');
  // 第 2 步可以跳过；第 3 步保持“空白”
  await page.getByRole('button', { name: '跳过' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByText('还没有版本。发布工作副本后会出现在这里。')).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: group.name })).toBeVisible();
});

test('从 SQL 导入：在影子库里执行后读回结构，目标库不变', async ({ browser }) => {
  const url = await makeDb('e2e_wizard_sql', '');
  const { page } = await newUser(browser, '向导 SQL');
  await createGroup(page, `向导 SQL 组 ${Date.now().toString(36)}`);
  await startWizard(page, 'SQL 项目');
  await page.getByRole('button', { name: '添加数据库' }).click();
  await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(url);
  // 生产环境默认不在同一实例上建影子库：这里明确允许（测试实例上只有一个库）
  await page.getByLabel('生产环境').uncheck();
  await page.getByRole('button', { name: '下一步' }).click();

  await page.getByRole('radio', { name: /从 SQL 导入/ }).check();
  await page
    .getByRole('textbox', { name: 'SQL' })
    .fill('create schema shop;\ncreate table shop.items (id int primary key, title text);');
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByRole('link', { name: '基线', exact: true })).toBeVisible();

  await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
  await expect(
    page.getByRole('navigation', { name: '对象' }).getByRole('button', { name: 'shop.items', exact: true }),
  ).toBeVisible();
  // 目标库只被读过：没有 shop schema
  expect(await countTarget(url, "select count(*)::int as n from pg_namespace where nspname = 'shop'")).toBe(
    0,
  );
});

test('⌘K 新建项目：地址带上组 slug，向导里组已经预选好，可以直接下一步', async ({ browser }) => {
  const { page } = await newUser(browser, '向导快捷键');
  const group = await createGroup(page, `向导快捷键组 ${Date.now().toString(36)}`);
  await startWizard(page, '快捷键项目');
  await page.getByRole('button', { name: '跳过' }).click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  // 在项目里按 ⌘K → 新建项目：地址带的是组 slug，不是组 id
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').press('Enter');
  await page.waitForURL(/\/new\?group=/);
  const search = new URL(page.url()).searchParams.get('group');
  expect(search).toBe(group.slug);
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  // 组已经预选好：选了组、填了名字就能点下一步
  await expect(page.getByRole('combobox', { name: /^组/ }).locator('option:checked')).toHaveText(group.name);
  await page.getByLabel('项目名').fill('下一个项目');
  await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled();
});

test('SQL 导入没有环境时不能下一步，并说明原因', async ({ browser }) => {
  const { page } = await newUser(browser, '向导无环境');
  await createGroup(page, `向导无环境组 ${Date.now().toString(36)}`);
  await startWizard(page, '无环境 SQL');
  await page.getByRole('button', { name: '跳过' }).click();
  await page.getByRole('radio', { name: /从 SQL 导入/ }).check();
  await page.getByRole('textbox', { name: 'SQL' }).fill('create table t (id int)');
  await expect(page.getByText(/从 SQL 导入需要一个环境/)).toBeVisible();
  await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
});

test('schema 范围：范围为全部时取消勾选一个，保存后是除它以外的全部', async ({ browser }) => {
  const url = await makeDb(
    'e2e_wizard_scope',
    `create schema app;
     create table app.t1 (id int primary key);
     create schema audit;
     create table audit.a1 (id int primary key);`,
  );
  const { page } = await newUser(browser, '向导范围');
  await createGroup(page, `向导范围组 ${Date.now().toString(36)}`);
  await startWizard(page, '范围项目');
  await page.getByRole('button', { name: '添加数据库' }).click();
  await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(url);
  await page.getByLabel('生产环境').uncheck();
  await page.getByRole('button', { name: '检查连接' }).click();
  await expect(page.getByText('连接正常')).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('radio', { name: /从数据库导入/ }).check();
  // 默认全选
  await expect(page.getByRole('checkbox', { name: /^audit/ })).toBeChecked();
  await page.getByRole('button', { name: '下一步' }).click();
  // 全选时存的是“全部”，确认页写的就是“全部”
  await expect(page.getByRole('main').getByText('全部')).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  const owner = new URL(page.url()).pathname.split('/')[2]!;
  const slug = new URL(page.url()).pathname.split('/')[3]!;
  const pid = ((await (await page.request.get(`/api/resolve/${owner}/${slug}`)).json()) as { id: string }).id;
  expect(
    ((await (await page.request.get(`/api/projects/${pid}`)).json()) as { schemas: unknown }).schemas,
  ).toBe(null);

  // 项目设置：取消 audit，保存后范围是除 audit 以外的全部
  await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '设置' }).click();
  const schemaBox = page.getByRole('checkbox', { name: /^audit/ });
  await expect(schemaBox).toBeChecked();
  await schemaBox.uncheck();
  await page.getByRole('button', { name: '保存设置' }).last().click();
  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/projects/${pid}`)).json()) as { schemas: string[] }).schemas,
    )
    .toEqual(['app', 'public']);

  // 一个都不勾：不能保存，并提示至少选一个
  for (const box of await page.getByRole('checkbox').all()) await box.uncheck();
  await expect(page.getByText('至少选一个 schema。')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置' }).last()).toBeDisabled();
});
