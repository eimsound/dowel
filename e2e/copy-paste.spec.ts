// 画布复制粘贴（ADR 0013 第 2 节）端到端测试，全部用零外部依赖的 SQLite 项目（内置 :memory: 影子库可直接导入 SQL）：
// - 同一画布复制粘贴表：同名自动加后缀 _copy、外键仍指向原表；亮 / 暗主题 + axe 扫描（含粘贴结果面板）；
// - 从画布修改历史的“表结构”视图复制表，关掉历史后粘贴到当前画布；
// - 项目 A 复制 → 同类型项目 B 粘贴：外部外键按 (schema, 表, 列) 重连，找不到的外键跳过并在粘贴结果里说明；
// - 跨方言粘贴（SQLite → PostgreSQL）明确报错；
// - 属性面板里复制列 / 索引并粘贴进另一张表；
// - 查看者不能粘贴。
import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

import { addGrant, createGroup, createProjectIn, newUser, openModel } from './helpers.ts';

const scan = async (page: Page, label: string) => {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad,
    `${label} 有 serious / critical 级别的无障碍问题：\n${bad
      .map(
        (v) => `- ${v.id} (${v.impact}) ${v.help}\n  ${v.nodes.map((n) => n.target.join(' ')).join('\n  ')}`,
      )
      .join('\n')}`,
  ).toEqual([]);
};

const SHOP_SQL = `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id),
  product_id INTEGER REFERENCES products (id),
  note TEXT
);
CREATE INDEX orders_note_idx ON orders (note);`;

/** 用向导建一个从 SQL 导入的 SQLite 项目，停在模型页 */
const createSqliteProject = async (page: Page, groupName: string, name: string, sql: string) => {
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: groupName });
  await page.getByLabel('项目名').fill(name);
  await page.getByRole('radio', { name: /SQLite/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '跳过' }).click();
  await page.getByRole('radio', { name: /从 SQL 导入/ }).check();
  await page.getByLabel('SQL', { exact: true }).fill(sql);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  const url = page.url();
  await openModel(page);
  return url;
};

const tree = (page: Page) => page.getByRole('navigation', { name: '对象' });
const inspector = (page: Page) => page.getByRole('complementary', { name: '属性' });

/** 在对象树里选中一张表，再把焦点放回画布（键盘复制粘贴不在输入框里触发） */
const selectTable = async (page: Page, name: string) => {
  await tree(page).getByRole('button', { name, exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name, exact: true })).toBeVisible();
};

const synced = async (page: Page) => {
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
};

const grantClipboard = async (ctx: BrowserContext) => {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
};

for (const scheme of ['light', 'dark'] as const) {
  test(`同一画布复制粘贴表：自动加后缀、外键不断（${scheme}）`, async ({ browser }) => {
    const { page } = await newUser(browser, `复制粘贴 ${scheme}`, { colorScheme: scheme, locale: 'zh-CN' });
    await grantClipboard(page.context());
    const group = await createGroup(page);
    await createSqliteProject(page, group.name, `复制粘贴 ${scheme}`, SHOP_SQL);

    await selectTable(page, 'orders');
    await page.keyboard.press('ControlOrMeta+c');
    await expect(page.getByText('已复制 1 张表')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+v');

    // 新表 orders_copy 出现并被选中；外键仍指向 users / products
    await expect(tree(page).getByRole('button', { name: 'orders_copy', exact: true })).toBeVisible();
    await expect(inspector(page).getByRole('heading', { name: 'orders_copy', exact: true })).toBeVisible();
    await expect(inspector(page).getByText(/user_id → users\.id/)).toBeVisible();
    await expect(inspector(page).getByText(/product_id → products\.id/)).toBeVisible();
    await synced(page);

    // 再粘贴一次：orders_copy2，原表 orders 不受影响
    await page.keyboard.press('ControlOrMeta+v');
    await expect(tree(page).getByRole('button', { name: 'orders_copy2', exact: true })).toBeVisible();
    await expect(tree(page).getByRole('button', { name: 'orders', exact: true })).toBeVisible();

    // 粘贴结果面板（有改名时常驻）可读且无障碍
    const report = page.getByTestId('paste-report');
    await expect(report).toContainText('已粘贴 1 张表');
    await expect(report).toContainText('orders_copy2');
    await scan(page, `复制粘贴-粘贴结果（${scheme}）`);
    await report.getByRole('button', { name: '关闭粘贴结果' }).click();
    await expect(report).toHaveCount(0);

    // 画布修改历史里记成一条“粘贴”
    await page.getByRole('button', { name: '修改历史' }).click();
    const dlg = page.getByRole('dialog', { name: '画布修改历史' });
    await expect(
      dlg.getByRole('navigation', { name: '修改时间线' }).getByRole('button', { name: /粘贴/ }).first(),
    ).toBeVisible();
    await scan(page, `复制粘贴-修改历史（${scheme}）`);
  });
}

test('从画布修改历史复制表并粘贴到当前画布', async ({ browser }) => {
  const { page } = await newUser(browser, '历史复制');
  await grantClipboard(page.context());
  const group = await createGroup(page);
  await createSqliteProject(page, group.name, '历史复制', SHOP_SQL);

  // 删除 products，再从历史快照里把它找回来
  await selectTable(page, 'products');
  await inspector(page).getByRole('button', { name: '更多操作' }).click();
  await page.getByText('删除表', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除表' }).click();
  await expect(tree(page).getByRole('button', { name: 'products', exact: true })).toHaveCount(0);
  await synced(page);

  await page.getByRole('button', { name: '修改历史' }).click();
  const dlg = page.getByRole('dialog', { name: '画布修改历史' });
  const timeline = dlg.getByRole('navigation', { name: '修改时间线' });
  // 选中导入后的初始状态（删除之前）
  await timeline.getByRole('button').last().click();
  await dlg.getByRole('tab', { name: /当时状态/ }).click();
  await dlg.getByRole('button', { name: '表结构' }).click();
  await dlg.getByRole('button', { name: '复制表 products' }).click();
  await expect(dlg.getByRole('status').filter({ hasText: '已复制 1 张表' })).toBeVisible();
  await dlg.getByRole('button', { name: '关闭' }).first().click();
  await expect(dlg).not.toBeVisible();

  await page.getByRole('button', { name: '粘贴（⌘V / Ctrl+V）' }).click();
  // 原名已空出来：保持原名 products
  await expect(tree(page).getByRole('button', { name: 'products', exact: true })).toBeVisible();
  await expect(page.getByText('已粘贴 1 张表')).toBeVisible();
});

test('项目 A 复制到同类型项目 B：外部外键重连，找不到的跳过并说明；跨方言报错', async ({ browser }) => {
  const { page } = await newUser(browser, '跨项目');
  const ctx = page.context();
  await grantClipboard(ctx);
  const group = await createGroup(page);
  await createSqliteProject(page, group.name, '项目 A', SHOP_SQL);
  const pageB = await ctx.newPage();
  await pageB.goto('/');
  await createSqliteProject(
    pageB,
    group.name,
    '项目 B',
    `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);`,
  );

  // A：复制 orders（外键指向 users 与 products）
  await page.bringToFront();
  await selectTable(page, 'orders');
  await page.getByRole('button', { name: /^复制选中的 1 张表/ }).click();
  await expect(page.getByText('已复制 1 张表')).toBeVisible();

  // B：粘贴。users 能接上，products 不存在 → 跳过并说明
  await pageB.bringToFront();
  await pageB.getByRole('button', { name: '粘贴（⌘V / Ctrl+V）' }).click();
  await expect(tree(pageB).getByRole('button', { name: 'orders', exact: true })).toBeVisible();
  await expect(inspector(pageB).getByText(/user_id → users\.id/)).toBeVisible();
  await expect(inspector(pageB).getByText(/product_id → products/)).toHaveCount(0);
  const report = pageB.getByTestId('paste-report');
  await expect(report).toContainText('已跳过（1）');
  await expect(report).toContainText('products');
  await scan(pageB, '跨项目粘贴结果');

  // C：PostgreSQL 空白项目，粘贴 SQLite 的内容 → 明确报错，模型不变
  const pageC = await ctx.newPage();
  await pageC.goto('/');
  await createProjectIn(pageC, '项目 C', group.name);
  await openModel(pageC);
  await pageC.getByRole('button', { name: '粘贴（⌘V / Ctrl+V）' }).click();
  await expect(pageC.getByText(/无法粘贴：内容复制自 SQLite 项目，当前项目是 PostgreSQL/)).toBeVisible();
  await expect(tree(pageC).getByRole('button', { name: 'orders', exact: true })).toHaveCount(0);
});

test('属性面板：复制列和索引并粘贴进另一张表；查看者不能粘贴', async ({ browser }) => {
  const owner = await newUser(browser, '表内复制');
  const page = owner.page;
  await grantClipboard(page.context());
  const group = await createGroup(page);
  const url = await createSqliteProject(page, group.name, '表内复制', SHOP_SQL);

  // 复制 orders.note 列
  await selectTable(page, 'orders');
  await inspector(page)
    .getByRole('button', { name: /^note\b/ })
    .click();
  await inspector(page).getByRole('button', { name: '复制列 note' }).click();
  await expect(page.getByText('已复制 1 项')).toBeVisible();
  // 粘贴进 users
  await selectTable(page, 'users');
  await inspector(page).getByRole('button', { name: '粘贴列、约束或索引到表 users' }).click();
  await expect(inspector(page).getByRole('button', { name: /^note\b/ })).toBeVisible();

  // 复制 orders 的索引 orders_note_idx，粘贴进 users：按列名 note 映射
  await selectTable(page, 'orders');
  await inspector(page).getByRole('button', { name: '复制 orders_note_idx' }).click();
  await selectTable(page, 'users');
  await inspector(page).getByRole('button', { name: '粘贴列、约束或索引到表 users' }).click();
  await expect(
    inspector(page)
      .getByText(/\(note\)/)
      .first(),
  ).toBeVisible();
  await synced(page);

  // 再粘贴一次同一个索引：定义相同，跳过并说明
  await inspector(page).getByRole('button', { name: '粘贴列、约束或索引到表 users' }).click();
  await expect(page.getByTestId('paste-report')).toContainText('已有相同定义');

  // 查看者：没有粘贴按钮，键盘粘贴给出说明
  const viewer = await newUser(browser, '只读成员');
  await addGrant(page, viewer.username, '只读成员', 'viewer');
  await grantClipboard(viewer.page.context());
  await viewer.page.goto(`${url}/model`);
  await expect(viewer.page.getByText('你是查看者')).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: '粘贴（⌘V / Ctrl+V）' })).toHaveCount(0);
  await selectTable(viewer.page, 'orders');
  await viewer.page.keyboard.press('ControlOrMeta+c');
  await expect(viewer.page.getByText('已复制 1 张表')).toBeVisible();
  await viewer.page.keyboard.press('ControlOrMeta+v');
  await expect(viewer.page.getByText('你在这个项目里是查看者，不能粘贴。')).toBeVisible();
  await expect(tree(viewer.page).getByRole('button', { name: 'orders_copy', exact: true })).toHaveCount(0);
});
