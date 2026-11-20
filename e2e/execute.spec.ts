// 环境执行（P4b）：非生产环境执行 / 回滚、生产环境输入环境名确认、漂移检查与拦截、概览版本列表。
// 需要 PG 作目标库和影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过。
import { expect, test } from '@playwright/test';
import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createProject, gotoPage, newUser } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

const rail = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: '实例与项目' });

test('非生产环境：执行到 v2、回滚到 v1；概览的版本列表显示序号和验证标记', async ({ browser }) => {
  const db = await newTargetDb('e2e_exec');
  try {
    const { page } = await newUser(browser, '执行者甲');
    await createProject(page, '执行项目');
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await publishTable(page, 'customers', 'v2', 2);

    // 概览：最近版本显示 v{序号} 和“已验证”标记（复用 VersionStatus）
    await gotoPage(page, '概览');
    await expect(page.locator('.chip', { hasText: /^v2$/ })).toBeVisible();
    await expect(page.locator('.chip', { hasText: /^v1$/ })).toBeVisible();
    await expect(page.locator('.risk', { hasText: '已验证' })).toHaveCount(2);

    await openEnv(page, 'dev');
    await expect(page.getByTestId('current-version')).toContainText('尚未执行');
    // 版本链：两个版本都待执行
    await expect(page.locator('.chip[data-state=pending]')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: '执行历史' })).toBeVisible();

    // 执行到最新（v2）：确认对话框列出两个迁移
    await page.getByRole('button', { name: '执行迁移' }).click();
    const dlg = execDialog(page);
    await expect(dlg.getByRole('heading', { name: /^执行到 v2/ })).toBeVisible();
    const migrations = dlg.getByRole('list', { name: '要执行的迁移' });
    await expect(migrations.getByRole('listitem')).toHaveCount(2);
    await expect(migrations).toContainText('v1');
    await expect(migrations).toContainText('v2');
    // 非生产环境不需要输入环境名
    await expect(dlg.getByLabel('输入环境名确认')).toHaveCount(0);
    await dlg.getByRole('button', { name: '确认执行' }).click();
    await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
    await expect(dlg.getByRole('status')).toContainText('环境当前版本是 v2');
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(dlg).toBeHidden();

    await expect(page.getByTestId('current-version')).toContainText('v2');
    await expect(page.locator('tr[data-run=up]')).toHaveCount(2);
    expect(
      (await db.sql<{ t: string | null }>("select to_regclass('public.customers')::text as t"))[0]!.t,
    ).toBe('customers');
    expect((await db.sql<{ t: string | null }>("select to_regclass('public.orders')::text as t"))[0]!.t).toBe(
      'orders',
    );

    // 回滚到 v1
    await page.getByLabel('回滚到版本').selectOption({ label: 'v1 v1' });
    await page.getByRole('button', { name: '回滚迁移' }).click();
    await expect(dlg.getByRole('heading', { name: /^回滚到 v1/ })).toBeVisible();
    await expect(dlg).toContainText('回滚脚本没有做过锁和重写分析');
    await dlg.getByRole('button', { name: '确认回滚' }).click();
    await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(page.getByTestId('current-version')).toContainText('v1');
    await expect(page.locator('tr[data-run=down]')).toHaveCount(1);
    expect(
      (await db.sql<{ t: string | null }>("select to_regclass('public.customers')::text as t"))[0]!.t,
    ).toBeNull();
    expect((await db.sql<{ t: string | null }>("select to_regclass('public.orders')::text as t"))[0]!.t).toBe(
      'orders',
    );

    // 执行过的版本不能再编辑脚本（409）：版本详情里没有可用的“编辑脚本”结果，接口直接拒绝
    await gotoPage(page, '版本');
    await page.getByRole('link', { name: 'v2', exact: true }).click();
    await page.getByRole('button', { name: '编辑脚本' }).click();
    await page.getByRole('button', { name: '保存脚本' }).click();
    await expect(page.getByRole('alert')).toContainText('已经在环境上执行过');
  } finally {
    await db.drop();
  }
});

test('生产环境：必须输入环境名才能确认执行', async ({ browser }) => {
  const db = await newTargetDb('e2e_prod');
  try {
    const { page } = await newUser(browser, '执行者乙');
    await createProject(page, '生产项目');
    await addEnv(page, 'prod', db.url, true);
    await publishTable(page, 'orders', 'v1', 1);

    await openEnv(page, 'prod');
    // 生产环境默认档位：项目管理员（P5a 起在“执行策略”里：环境层选中“继承”，生效值是默认的项目管理员）
    const envPolicy = page.getByRole('group', { name: '本环境（生产）' });
    await expect(envPolicy.getByLabel('谁能执行')).toHaveValue('');
    await expect(envPolicy).toContainText('生效：项目管理员 · 默认值');
    await page.getByRole('button', { name: '执行迁移' }).click();
    const dlg = execDialog(page);
    const confirm = dlg.getByRole('button', { name: '确认执行' });
    const typed = dlg.getByLabel('输入环境名确认');
    // 输入之前不可确认（aria-disabled，仍然可以聚焦）
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    // Playwright 的 click 会等 aria-disabled 的元素变成可用，这里要验证“点了也没有反应”，所以 force
    await confirm.click({ force: true });
    // 点了也没有开始：对话框里只有预演结果（role=status），没有执行进度
    await expect(dlg.getByText(/正在获取项目锁|正在执行迁移|执行完成/)).toHaveCount(0);
    // 输错环境名仍然不可确认
    await typed.fill('prd');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await typed.fill('prod');
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
    await confirm.click();
    await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(page.getByTestId('current-version')).toContainText('v1');
    expect((await db.sql<{ t: string | null }>("select to_regclass('public.orders')::text as t"))[0]!.t).toBe(
      'orders',
    );
  } finally {
    await db.drop();
  }
});

test('漂移：手动检查发现手工改库，图标栏和概览出现警告，执行被拦住；还原后恢复', async ({ browser }) => {
  const db = await newTargetDb('e2e_drift');
  try {
    const { page } = await newUser(browser, '执行者丙');
    await createProject(page, '漂移项目');
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await publishTable(page, 'customers', 'v2', 2);
    await openEnv(page, 'dev');

    // 先执行到 v1：选目标版本 v1
    await page.getByLabel('执行到版本').selectOption({ label: 'v1 v1' });
    await page.getByRole('button', { name: '执行迁移' }).click();
    await execDialog(page).getByRole('button', { name: '确认执行' }).click();
    await expect(execDialog(page).getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
    await execDialog(page).getByRole('button', { name: '关闭', exact: true }).first().click();

    // 没有漂移
    await page.getByRole('button', { name: '检查漂移' }).click();
    await expect(page.getByText('没有发现漂移。')).toBeVisible();
    await expect(page.locator('.risk', { hasText: '无漂移' })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: '环境' })).not.toHaveAccessibleDescription(/漂移/);

    // 有人绕过 Dowel 直接改库
    await db.sql('ALTER TABLE public.orders ADD COLUMN sneaky int');
    await page.getByRole('button', { name: '检查漂移' }).click();
    await expect(page.locator('.risk', { hasText: /^漂移$/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '漂移差异' })).toBeVisible();
    await expect(page.getByText('sneaky').first()).toBeVisible();
    // 图标栏的“环境”出现警告（名字不变，说明用 aria-describedby 提供）
    await expect(rail(page).getByRole('link', { name: '环境' })).toHaveAccessibleDescription(
      '有环境出现漂移警告',
    );
    // 环境列表里这个环境带着警告说明，但链接的名字仍然是环境名
    await expect(
      page.getByRole('navigation', { name: '环境列表' }).getByRole('link', { name: 'dev', exact: true }),
    ).toHaveAccessibleDescription('漂移');
    // 概览：警告块
    await gotoPage(page, '概览');
    await expect(page.getByRole('status').filter({ hasText: '环境有漂移警告' })).toContainText('dev');
    await page.getByRole('link', { name: '查看 dev' }).click();
    await expect(page.getByRole('heading', { name: '漂移差异' })).toBeVisible();

    // 执行被拦住：错误里列出差异
    await page.getByRole('button', { name: '执行迁移' }).click();
    const dlg = execDialog(page);
    await dlg.getByRole('button', { name: '确认执行' }).click();
    await expect(dlg.getByRole('alert')).toContainText('不一致', { timeout: 60_000 });
    await expect(dlg).toContainText('sneaky');
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(page.getByTestId('current-version')).toContainText('v1');

    // 还原后再检查：恢复正常
    await db.sql('ALTER TABLE public.orders DROP COLUMN sneaky');
    await page.getByRole('button', { name: '检查漂移' }).click();
    await expect(page.locator('.risk', { hasText: '无漂移' })).toBeVisible();
    await expect(rail(page).getByRole('link', { name: '环境' })).not.toHaveAccessibleDescription(/漂移/);
    await expect(page.getByRole('heading', { name: '漂移差异' })).toHaveCount(0);
  } finally {
    await db.drop();
  }
});
