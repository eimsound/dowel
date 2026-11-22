// Q17 Phase 1 端到端测试：
// 1. 协作同步板块（创建、重命名、单表最多 1 板块改归属、前缀建议）、本地折叠/聚焦状态互不干扰、viewer 只读限制及 SQL/DDL 零副作用；
// 2. >100 表（105 张表）默认折叠汇总卡片、按需展开/收起、1 跳 / 2 跳外键邻域聚焦与退出聚焦。
import { expect, type Page, test } from '@playwright/test';

import { addGrant, createGroup, openModel } from './helpers.ts';

const createSqliteWithSql = async (page: Page, projectName: string, sql: string) => {
  const group = await createGroup(
    page,
    `板块组 ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  );
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group.name });
  await page.getByLabel('项目名').fill(projectName);
  await page.getByRole('radio', { name: /SQLite/ }).check();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '跳过' }).click();
  await page.getByRole('radio', { name: /从 SQL 导入/ }).check();
  await page.getByLabel('SQL', { exact: true }).fill(sql);
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  return page.url();
};

test('画布板块实时协作同步、前缀建议、单表唯一归属、本地视图隔离、viewer 只读且不改变 SQL', async ({
  browser,
}) => {
  const { newUser } = await import('./helpers.ts');
  const alice = await newUser(browser, '板块甲');
  const bob = await newUser(browser, '板块乙');
  const carol = await newUser(browser, '查看丙');

  const sql = `
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE user_sessions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id));
    CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, detail TEXT);
  `;
  const projectUrl = await createSqliteWithSql(alice.page, '板块协作', sql);
  await addGrant(alice.page, bob.username, '板块乙', 'editor');
  await addGrant(alice.page, carol.username, '查看丙', 'viewer');

  await openModel(alice.page);
  await expect(alice.page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

  // 记录创建板块前的基线 DDL
  await alice.page.getByRole('tab', { name: 'SQL' }).click();
  const sqlContent = alice.page.locator('.cm-content');
  await expect(sqlContent).toContainText('CREATE TABLE orders');
  const baselineDdl = await sqlContent.innerText();
  await alice.page.getByRole('tab', { name: '画布' }).click();

  await bob.page.goto(`${projectUrl}/model`);
  await expect(bob.page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
  await expect(bob.page.locator('.react-flow__node-table')).toHaveCount(5);

  await carol.page.goto(`${projectUrl}/model`);
  await expect(carol.page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

  // Alice 切换到侧边栏“按板块”视图并应用前缀建议（order / user）
  const aliceNav = alice.page.getByRole('navigation', { name: '对象' });
  await aliceNav.getByRole('tab', { name: '按板块' }).click();
  await aliceNav.getByRole('button', { name: '前缀建议' }).click();

  const dlg = alice.page.getByRole('dialog', { name: '前缀建议板块' });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel('order')).toBeChecked();
  await expect(dlg.getByLabel('user')).toBeChecked();
  await dlg.getByRole('button', { name: '应用建议板块' }).click();

  // 回到管理视图：把板块 user 重命名为“账户”，再新建“审计”并把 orders 改归属到“审计”验证单表最多 1 个板块
  const manageDlg = alice.page.getByRole('dialog', { name: '管理板块' });
  await expect(manageDlg).toBeVisible();
  await manageDlg.getByRole('navigation', { name: '板块列表' }).getByRole('button', { name: /user/ }).click();
  await manageDlg.getByLabel('板块名称').fill('账户');
  await manageDlg.getByRole('button', { name: '保存名称' }).click();
  await expect(
    manageDlg.getByRole('navigation', { name: '板块列表' }).getByRole('button', { name: /账户/ }),
  ).toBeVisible();

  await manageDlg.getByLabel('新板块名').fill('审计');
  await manageDlg.getByRole('button', { name: '创建板块' }).click();
  await manageDlg.getByRole('checkbox', { name: 'audit_log' }).check();
  // orders 原在 order 板块，勾选进“审计”后应自动从 order 移出
  await manageDlg.getByRole('checkbox', { name: /orders/ }).check();
  await manageDlg.getByRole('button', { name: '关闭' }).first().click();
  await expect(manageDlg).toBeHidden();

  // 协作者 Bob 无需刷新即在“按板块”视图看到同步的板块和归属变化（order 仅剩 order_items 1 张表）
  const bobNav = bob.page.getByRole('navigation', { name: '对象' });
  await bobNav.getByRole('tab', { name: '按板块' }).click();
  await expect(bobNav.getByRole('button', { name: /^账户\s*2$/ })).toBeVisible();
  await expect(bobNav.getByRole('button', { name: /^审计\s*2$/ })).toBeVisible();
  await expect(bobNav.getByRole('button', { name: /^order\s*1$/ })).toBeVisible();

  // Alice 切换画布到“按板块”折叠态并聚焦 orders（1 跳），Bob 本地仍保持平铺与非聚焦态
  await alice.page.getByRole('tab', { name: '按板块', exact: true }).last().click();
  await expect(alice.page.locator('.react-flow__node-sectionSummary')).toHaveCount(3);
  await expect(bob.page.locator('.react-flow__node-table')).toHaveCount(5);

  await aliceNav.getByRole('button', { name: 'orders', exact: true }).click();
  await alice.page.getByRole('button', { name: '聚焦邻域' }).click();
  await expect(alice.page.getByRole('button', { name: '退出聚焦' })).toBeVisible();
  await expect(alice.page.locator('.react-flow__node-table')).toHaveCount(3); // orders + users + order_items
  await expect(bob.page.getByRole('button', { name: '退出聚焦' })).toHaveCount(0);
  await expect(bob.page.locator('.react-flow__node-table')).toHaveCount(5);

  // 查看者 Carol 可见同步后的板块，但所有修改板块按钮均禁用
  const carolNav = carol.page.getByRole('navigation', { name: '对象' });
  await carolNav.getByRole('tab', { name: '按板块' }).click();
  await expect(carolNav.getByRole('button', { name: /^审计\s*2$/ })).toBeVisible();
  await expect(carolNav.getByRole('button', { name: '新建板块' })).toBeDisabled();
  await expect(carolNav.getByRole('button', { name: '前缀建议' })).toBeDisabled();
  await carolNav.getByRole('button', { name: '管理板块' }).click();
  const carolDlg = carol.page.getByRole('dialog', { name: '管理板块' });
  await expect(carolDlg.getByText('当前为查看者权限，只能浏览板块，不能修改。')).toBeVisible();
  await expect(carolDlg.getByRole('button', { name: '创建板块' })).toBeDisabled();
  await expect(carolDlg.getByRole('button', { name: '删除板块' })).toBeDisabled();
  await carolDlg.getByRole('button', { name: '关闭' }).first().click();

  // 确认 DDL 毫无变化
  await alice.page.getByRole('tab', { name: 'SQL' }).click();
  await expect(sqlContent).toContainText('CREATE TABLE orders');
  expect(await sqlContent.innerText()).toBe(baselineDdl);
});

test('>100 表默认折叠为汇总卡片，支持按需展开与 1 跳 / 2 跳外键邻域聚焦', async ({ browser }) => {
  const { newUser } = await import('./helpers.ts');
  const { page } = await newUser(browser, '百表用户');

  // 生成 5 个域 × 21 张表 = 105 张表，包含链条 dom0_t0 <- dom0_t1 <- dom0_t2 <- dom0_t3 及跨板块 dom0_t0 <- dom1_t0
  const stmts: string[] = [];
  for (let d = 0; d < 5; d++) {
    for (let i = 0; i < 21; i++) {
      if (d === 0 && i >= 1 && i <= 3) {
        stmts.push(
          `CREATE TABLE dom0_t${i} (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES dom0_t${i - 1}(id));`,
        );
      } else if (d === 1 && i === 0) {
        stmts.push('CREATE TABLE dom1_t0 (id INTEGER PRIMARY KEY, d0_id INTEGER REFERENCES dom0_t0(id));');
      } else {
        stmts.push(`CREATE TABLE dom${d}_t${i} (id INTEGER PRIMARY KEY);`);
      }
    }
  }

  await createSqliteWithSql(page, '百表项目', stmts.join('\n'));
  await openModel(page);
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

  // 默认进入折叠汇总视图（无板块时按 Schema 汇总，绝不阻塞主线程平铺 105 张表）
  await expect(page.locator('.react-flow__node-sectionSummary')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-table')).toHaveCount(0);

  // 通过前缀建议生成 5 个板块：画布自动呈现 5 张板块汇总卡片
  const nav = page.getByRole('navigation', { name: '对象' });
  await nav.getByRole('tab', { name: '按板块' }).click();
  await nav.getByRole('button', { name: '前缀建议' }).click();
  const suggestDlg = page.getByRole('dialog', { name: '前缀建议板块' });
  await expect(suggestDlg.getByText('已选 5 个')).toBeVisible();
  await suggestDlg.getByRole('button', { name: '应用建议板块' }).click();
  await page.getByRole('dialog', { name: '管理板块' }).getByRole('button', { name: '关闭' }).first().click();

  await expect(page.locator('.react-flow__node-sectionSummary')).toHaveCount(5);
  await expect(page.locator('.react-flow__node-table')).toHaveCount(0);

  // 展开 dom0：仅渲染该板块的 21 张表，其余 4 个板块保持折叠
  await page.getByRole('button', { name: '展开 dom0' }).click();
  await expect(page.locator('.react-flow__node-table')).toHaveCount(21);
  await expect(page.locator('.react-flow__node-sectionSummary')).toHaveCount(4);

  // 收起 dom0：回到 5 张汇总卡片
  await page.getByRole('button', { name: '收起 dom0' }).click();
  await expect(page.locator('.react-flow__node-sectionSummary')).toHaveCount(5);
  await expect(page.locator('.react-flow__node-table')).toHaveCount(0);

  // 搜索并直接从侧边栏行内聚焦 dom0_t0（不展开整个板块）：1 跳仅含 dom0_t0 / dom0_t1 / dom1_t0
  await nav.getByLabel('搜索对象…').fill('dom0_t0');
  await nav.getByRole('button', { name: 'dom0_t0', exact: true }).hover();
  const focusRowBtn = nav.getByRole('button', { name: '聚焦此表邻域' });
  await expect(focusRowBtn).toHaveAccessibleDescription('dom0_t0');
  await focusRowBtn.click();

  await expect(page.getByRole('button', { name: '退出聚焦' })).toBeVisible();
  await expect(page.locator('.react-flow__node-table')).toHaveCount(3);
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom0_t0' })).toBeVisible();
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom0_t1' })).toBeVisible();
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom1_t0' })).toBeVisible();
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom0_t2' })).toHaveCount(0);

  // 切换为 2 跳：新增 dom0_t2，仍不含 3 跳的 dom0_t3
  await page.getByRole('tab', { name: '2 跳' }).click();
  await expect(page.locator('.react-flow__node-table')).toHaveCount(4);
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom0_t2' })).toBeVisible();
  await expect(page.locator('.react-flow__node-table', { hasText: 'dom0_t3' })).toHaveCount(0);

  // 退出聚焦：恢复 5 张汇总卡片
  await page.getByRole('button', { name: '退出聚焦' }).click();
  await expect(page.getByRole('button', { name: '退出聚焦' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node-sectionSummary')).toHaveCount(5);
  await expect(page.locator('.react-flow__node-table')).toHaveCount(0);
});
