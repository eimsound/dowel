// 执行策略（P5a）：各层配置页（含上级锁定的显示）、授予执行者（“仅限执行者 + 生产”时非实例管理员不能选）、
// 确认对话框里的前置环境拒绝提示；相关页面的 axe 扫描（亮 / 暗）。
// 后两条需要 PG 作目标库（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createGroup, createProjectIn, gotoPage, instanceAdmin, newUser } from './helpers.ts';

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

/** SHOOT_APP=1 时把新页面的截图写到 .agents/docs/ui/shots/（和 visual.spec.ts 同一个约定） */
const shoot = async (page: Page, name: string) => {
  if (process.env.SHOOT_APP === '1')
    await page.screenshot({ path: `.agents/docs/ui/shots/app-${name}.png`, fullPage: true });
};

const set = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

for (const scheme of ['light', 'dark'] as const) {
  test(`各层执行策略配置页：组层收紧后项目层锁定显示，放宽选项不可选（${scheme}）`, async ({ browser }) => {
    // 实例层：实例管理员能看到配置页（只看，不改，避免影响并行的其他用例）
    const admin = await instanceAdmin(browser, scheme);
    await admin.goto('/admin/policy');
    await expect(admin.getByRole('heading', { name: '执行策略' })).toBeVisible();
    await expect(set(admin, '生产环境').getByLabel('谁能执行')).toBeVisible();
    await expect(set(admin, '生产环境')).toContainText('生效：项目管理员 · 默认值');
    await expect(set(admin, '非生产环境')).toContainText('生效：项目编辑者 · 默认值');
    await scan(admin, '/admin/policy');

    // 组层：组管理员把非生产收紧为“项目管理员”，锁等待 3 秒
    const { page } = await newUser(browser, '组管理员', { colorScheme: scheme });
    const group = await createGroup(page);
    const projectUrl = await createProjectIn(page, '策略项目', group.name);
    await page.goto(`/group/${group.slug}`);
    const nonProd = set(page, '非生产环境');
    await nonProd.getByLabel('谁能执行').selectOption('admin');
    await nonProd.getByLabel('锁等待超时（秒）').fill('3');
    await expect(nonProd).toContainText('生效：项目管理员 · 来自组');
    await page.getByRole('button', { name: '保存执行策略' }).click();
    await expect(page.getByText('已保存执行策略')).toBeVisible();
    await scan(page, '组首页 · 执行策略');

    // 项目层：显示“由组锁定”，比它宽的“项目编辑者”不可选
    await page.goto(projectUrl);
    await gotoPage(page, '设置');
    const projNonProd = set(page, '非生产环境');
    await expect(projNonProd.getByTestId('locked-whoCanExecute')).toContainText('由组锁定：至少 项目管理员');
    await expect(projNonProd.getByTestId('locked-lockTimeoutMs')).toContainText('由组锁定：至少 3 秒');
    const editorOption = projNonProd.getByLabel('谁能执行').locator('option[value=editor]');
    await expect(editorOption).toBeDisabled();
    // 收紧到“仅限执行者”可以
    await projNonProd.getByLabel('谁能执行').selectOption('executor');
    await expect(projNonProd).toContainText('生效：仅限执行者 · 来自项目');
    await page.getByRole('button', { name: '保存执行策略' }).click();
    await expect(page.getByText('已保存执行策略')).toBeVisible();
    // 放宽是特权操作：项目管理员不是执行者，页面提示，再改回去会被服务端拒绝
    await expect(page.getByRole('status').filter({ hasText: '仅限执行者' })).toBeVisible();
    await projNonProd.getByLabel('谁能执行').selectOption('');
    await page.getByRole('button', { name: '保存执行策略' }).click();
    await expect(page.getByRole('alert')).toContainText('仅限执行者');
    await scan(page, '项目设置 · 执行策略');
    await shoot(page, `policy-project-${scheme}`);
  });
}

test.describe('需要目标库', () => {
  test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');
  // 每条用例要建两个目标库、添加两个环境（各自连接检查 + 影子库），再走多个页面：比默认的 60 秒长
  test.describe.configure({ timeout: 180_000 });

  test('授予执行者：“仅限执行者”的生产环境只有实例管理员能授予，界面说明原因', async ({ browser }) => {
    const prodDb = await newTargetDb('e2e_pol_prod');
    const devDb = await newTargetDb('e2e_pol_dev');
    try {
      const { page } = await newUser(browser, '项目管理员');
      const { username: dba } = await newUser(browser, 'DBA 乙');
      const group = await createGroup(page);
      await createProjectIn(page, '执行者项目', group.name);
      await addEnv(page, 'prod', prodDb.url, true);
      await addEnv(page, 'dev', devDb.url, false);
      // 环境层：生产环境收紧为“仅限执行者”（收紧只要项目管理员）
      await openEnv(page, 'prod');
      const envSet = set(page, '本环境（生产）');
      await envSet.getByLabel('谁能执行').selectOption('executor');
      await page.getByRole('button', { name: '保存执行策略' }).click();
      await expect(page.getByText('已保存执行策略')).toBeVisible();
      await expect(envSet).toContainText('生效：仅限执行者 · 来自环境');

      // 成员与授权：选“执行者”后出现范围；prod 不能选并说明原因
      await gotoPage(page, '成员与授权');
      await page.getByLabel('搜索用户或组…').fill(dba);
      await page.getByRole('button', { name: /^DBA 乙/ }).click();
      await page.getByLabel('角色', { exact: true }).selectOption('executor');
      const scope = page.getByLabel('范围');
      await expect(scope.locator('option', { hasText: '环境：prod' })).toBeDisabled();
      await expect(scope.locator('option', { hasText: '环境：prod' })).toContainText('只能由实例管理员授予');
      await expect(page.getByTestId('executor-prod-note')).toContainText('prod');
      await scope.selectOption({ label: '环境：dev' });
      await page.getByRole('button', { name: '添加', exact: true }).click();
      await expect(page.getByRole('button', { name: '移除 DBA 乙 的授权' })).toBeVisible();
      await expect(page.getByText(/· 环境：dev/)).toBeVisible();
      await new AxeBuilder({ page })
        .analyze()
        .then((r) =>
          expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]),
        );

      // 实例管理员可以授予 prod 的执行者
      const admin = await instanceAdmin(browser);
      await admin.goto(page.url());
      await admin.getByLabel('搜索用户或组…').fill(dba);
      await admin.getByRole('button', { name: /^DBA 乙/ }).click();
      await admin.getByLabel('角色', { exact: true }).selectOption('executor');
      await expect(admin.getByLabel('范围').locator('option', { hasText: '环境：prod' })).toBeEnabled();
      await admin.getByLabel('范围').selectOption({ label: '环境：prod' });
      await admin.getByRole('button', { name: '添加', exact: true }).click();
      await expect(admin.getByText(/环境：prod · 实例管理员授予/)).toBeVisible();
    } finally {
      await prodDb.drop();
      await devDb.drop();
    }
  });

  test('项目层收紧后回到环境页（不刷新页面）：确认对话框的策略摘要和执行按钮立刻反映新值', async ({
    browser,
  }) => {
    const devDb = await newTargetDb('e2e_pol_cache');
    try {
      const { page } = await newUser(browser, '缓存');
      const group = await createGroup(page);
      await createProjectIn(page, '缓存项目', group.name);
      await addEnv(page, 'dev', devDb.url, false);
      await publishTable(page, 'orders', 'v1', 1);
      // 先打开一次环境页和确认对话框，让环境状态进缓存
      await openEnv(page, 'dev');
      await page.getByRole('button', { name: '执行迁移' }).click();
      await expect(execDialog(page).getByTestId('policy-summary')).toContainText('锁等待 5 秒');
      await execDialog(page).getByRole('button', { name: '取消' }).click();

      // 项目设置里收紧非生产的锁等待超时（单页内导航，不重新加载页面）
      await gotoPage(page, '设置');
      const nonProd = set(page, '非生产环境');
      await nonProd.getByLabel('锁等待超时（秒）').fill('2');
      await page.getByRole('button', { name: '保存执行策略' }).click();
      await expect(page.getByText('已保存执行策略')).toBeVisible();
      await openEnv(page, 'dev');
      await page.getByRole('button', { name: '执行迁移' }).click();
      await expect(execDialog(page).getByTestId('policy-summary')).toContainText('锁等待 2 秒');
      await execDialog(page).getByRole('button', { name: '取消' }).click();
      // 环境页自己的配置区也是新的：锁定来自项目
      await expect(set(page, '本环境（非生产）').getByTestId('locked-lockTimeoutMs')).toContainText(
        '由项目锁定：至少 2 秒',
      );

      // 再收紧成“仅限执行者”：回到环境页，执行按钮立刻不可用
      await gotoPage(page, '设置');
      await set(page, '非生产环境').getByLabel('谁能执行').selectOption('executor');
      await page.getByRole('button', { name: '保存执行策略' }).click();
      await expect(page.getByText('已保存执行策略').first()).toBeVisible();
      await openEnv(page, 'dev');
      await expect(page.getByRole('button', { name: '执行迁移' })).toHaveAttribute('aria-disabled', 'true');
    } finally {
      await devDb.drop();
    }
  });

  for (const scheme of ['light', 'dark'] as const)
    test(`确认对话框：前置环境没执行到目标版本时显示拒绝原因、不能确认；执行之后通过（${scheme}）`, async ({
      browser,
    }) => {
      const devDb = await newTargetDb('e2e_pre_dev');
      const stgDb = await newTargetDb('e2e_pre_stg');
      try {
        const { page } = await newUser(browser, '前置环境', { colorScheme: scheme });
        const group = await createGroup(page);
        await createProjectIn(page, '前置项目', group.name);
        await addEnv(page, 'dev', devDb.url, false);
        await addEnv(page, 'stg', stgDb.url, false);
        await publishTable(page, 'orders', 'v1', 1);

        // stg 的前置环境设为 dev
        await openEnv(page, 'stg');
        await page.getByLabel('前置环境').selectOption({ label: 'dev' });
        await page.getByRole('button', { name: '保存执行策略' }).click();
        await expect(page.getByText('已保存执行策略')).toBeVisible();
        await expect(page.getByText('“dev”还没有执行过任何版本。')).toBeVisible();

        await page.getByRole('button', { name: '执行迁移' }).click();
        const dlg = execDialog(page);
        await expect(dlg.getByTestId('policy-summary')).toContainText('谁能执行：项目编辑者');
        await expect(dlg.getByTestId('policy-summary')).toContainText('锁等待 5 秒');
        await expect(dlg.getByRole('alert').filter({ hasText: '前置环境“dev”' })).toContainText(
          '还没有执行过任何版本',
        );
        await expect(dlg.getByRole('button', { name: '确认执行' })).toHaveAttribute('aria-disabled', 'true');
        // 预演（服务端）给出同样的代码和说明
        await expect(dlg.getByTestId('dry-error')).toContainText('前置环境“dev”');
        await scan(page, '确认对话框 · 前置环境拒绝');
        await shoot(page, `policy-prerequisite-${scheme}`);
        await dlg.getByRole('button', { name: '取消' }).click();
        // stg 的目标库没有被碰
        expect(
          (await stgDb.sql<{ n: string | null }>("select to_regnamespace('dowel')::text as n"))[0]!.n,
        ).toBeNull();

        // dev 执行到 v1 之后，stg 通过
        await openEnv(page, 'dev');
        await page.getByRole('button', { name: '执行迁移' }).click();
        await execDialog(page).getByRole('button', { name: '确认执行' }).click();
        await expect(execDialog(page).getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
        await execDialog(page).getByRole('button', { name: '关闭', exact: true }).first().click();
        await openEnv(page, 'stg');
        await page.getByRole('button', { name: '执行迁移' }).click();
        await expect(execDialog(page).getByTestId('prerequisite-check')).toContainText(
          '前置环境“dev”当前 v1：通过',
        );
        await execDialog(page).getByRole('button', { name: '确认执行' }).click();
        await expect(execDialog(page).getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
      } finally {
        await devDb.drop();
        await stgDb.drop();
      }
    });
});
