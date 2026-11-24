// 无障碍（S8）：用 @axe-core/playwright 扫描主要页面，亮 / 暗两种配色各跑一遍。
// 允许 minor / moderate；serious、critical 一律不允许（有问题就改界面，不放宽规则）。
// 这里不 disable 任何规则：确实要排除的误报，必须在 exclude 处写清原因。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { adminPage, commit, createProject, gotoPage, newUser, openModel } from './helpers.ts';

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

for (const scheme of ['light', 'dark'] as const) {
  test(`无障碍（${scheme}）：登录、我的项目、组首页、项目各页、个人设置`, async ({ browser }) => {
    const guest = await browser.newContext({ colorScheme: scheme, locale: 'zh-CN' });
    const login = await guest.newPage();
    await login.goto('/login');
    await expect(login.getByRole('heading', { name: '登录' })).toBeVisible();
    await scan(login, '/login');
    // 带错误提示的登录页（提示条也是页面的一部分）
    await login.goto('/login?oidc_error=state');
    await expect(login.getByRole('alert')).toBeVisible();
    await scan(login, '/login?oidc_error');
    await guest.close();

    const { page } = await newUser(browser, '无障碍', { colorScheme: scheme });
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
    await scan(page, '我的项目');

    const projectUrl = await createProject(page, '无障碍项目');
    const owner = new URL(projectUrl).pathname.split('/')[2]!;
    await scan(page, '项目概览');

    // 命令面板打开时也扫一遍（dialog + combobox + listbox）
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
    await scan(page, '命令面板');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeHidden();

    await page.goto(`/group/${owner}`);
    await expect(page.getByRole('heading', { name: '组设置' })).toBeVisible();
    await scan(page, '组首页');

    await page.goto(projectUrl);
    await openModel(page);
    await scan(page, '模型');
    // 发布一个版本（项目没有环境，所以是“未验证”），版本列表和详情里才有标记、冻结的迁移可以扫描
    await page.getByRole('button', { name: '新建表' }).click();
    await commit(page, '表名', 'orders');
    await page.getByRole('button', { name: '发布' }).click();
    await page.getByLabel('版本名').fill('首个版本');
    await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
    // 未验证的提示留在对话框里（也扫一遍）
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('项目还没有配置环境');
    await scan(page, '发布对话框（未验证）');
    await page.getByRole('dialog').locator('button.primary', { hasText: '关闭' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    for (const [name, heading] of [
      ['版本', '版本'],
      ['环境', '环境'],
      ['成员与授权', '成员与授权'],
      ['设置', '设置'],
    ] as const) {
      await gotoPage(page, name);
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await scan(page, name);
    }

    // 版本详情：已验证 / 未验证 / 人工编辑标记，冻结的迁移，逐步编辑模式
    await gotoPage(page, '版本');
    await page.getByRole('link', { name: '首个版本' }).click();
    await expect(page.getByRole('heading', { name: '版本详情' })).toBeVisible();
    await scan(page, '版本详情');
    await page.getByRole('button', { name: '编辑脚本' }).click();
    await expect(page.getByRole('button', { name: '保存脚本' })).toBeVisible();
    await scan(page, '版本详情（编辑脚本）');
    // 空步骤：保存按钮用 aria-disabled（仍可聚焦），原因通过 aria-describedby 关联到提示
    await page.getByRole('button', { name: '添加一步' }).click();
    const save = page.getByRole('button', { name: '保存脚本' });
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    // 不是原生 disabled（Playwright 的 toBeDisabled 会把 aria-disabled 也算进去，所以直接读属性）
    expect(await save.evaluate((el) => el.hasAttribute('disabled'))).toBe(false);
    await save.focus();
    await expect(save).toBeFocused();
    await expect(save).toHaveAccessibleDescription(/有空的步骤.*升级脚本第 \d+ 步/);
    await scan(page, '版本详情（编辑脚本，有空步骤）');

    for (const section of ['', '/password', '/identities', '/sessions', '/mcp', '/preferences']) {
      await page.goto(`/account${section}`);
      await expect(page.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
      await scan(page, `个人设置${section}`);
    }
  });

  test(`无障碍（${scheme}）：环境详情（版本链、历史、漂移差异）和生产环境的执行确认对话框`, async ({
    browser,
  }) => {
    test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');
    const db = await newTargetDb(`e2e_a11y_${scheme}`);
    try {
      const { page } = await newUser(browser, '执行无障碍', { colorScheme: scheme });
      await createProject(page, '执行无障碍项目');
      await addEnv(page, 'prod', db.url, true);
      await publishTable(page, 'orders', 'v1', 1);
      await publishTable(page, 'customers', 'v2', 2);
      await openEnv(page, 'prod');

      // 执行到 v1：版本链里有已执行 / 待执行，历史里有记录
      await page.getByLabel('执行到版本').selectOption({ label: 'v1 v1' });
      await page.getByRole('button', { name: '执行迁移' }).click();
      const dlg = execDialog(page);
      // 生产环境，还没有输入环境名（确认按钮 aria-disabled）
      await expect(dlg.getByLabel('输入环境名确认')).toBeVisible();
      await scan(page, '执行确认对话框（生产，输入前）');
      await dlg.getByLabel('输入环境名确认').fill('prod');
      await dlg.getByRole('button', { name: '确认执行' }).click();
      await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
      await scan(page, '执行确认对话框（执行完成）');
      await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
      await expect(dlg).toBeHidden();

      // 手工改库 → 漂移差异
      await db.sql('ALTER TABLE public.orders ADD COLUMN sneaky int');
      await page.getByRole('button', { name: '检查漂移' }).click();
      await expect(page.getByRole('heading', { name: '漂移差异' })).toBeVisible();
      await expect(page.locator('tr[data-run=up]')).toHaveCount(1);
      await scan(page, '环境详情（版本链、历史、漂移差异）');
      // 项目概览的漂移警告
      await gotoPage(page, '概览');
      await expect(page.getByRole('status').filter({ hasText: '环境有漂移警告' })).toBeVisible();
      await scan(page, '项目概览（漂移警告、版本标记）');
    } finally {
      await db.drop();
    }
  });

  test(`无障碍（${scheme}）：管理后台每一页`, async ({ browser }) => {
    const admin = await adminPage(browser);
    await admin.emulateMedia({ colorScheme: scheme });
    for (const [path, heading] of [
      ['/admin', '用户'],
      ['/admin/invites', '已生成的邀请'],
      ['/admin/sign-in', '已配置的登录方式'],
      ['/admin/settings', '实例设置'],
      ['/admin/grants', '授权'],
      ['/admin/audit', '审计日志'],
    ] as const) {
      await admin.goto(path);
      await expect(admin.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await scan(admin, path);
    }
  });
}
