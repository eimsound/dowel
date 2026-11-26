// 执行策略（P5a）：各层配置页（含上级锁定的显示）、授予执行者（“仅限执行者 + 生产”时非实例管理员不能选）、
// 项目层收紧后缓存失效；保存进行中“撤销修改”禁用（组层 / 环境层）；相关页面的 axe 扫描（亮 / 暗）。
// “需要目标库”分组里的用例需要 PG 作目标库（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';

import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createGroup, createProjectIn, gotoPage, holdRequest, instanceAdmin, newUser } from './helpers.ts';

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

const policySection = (page: Page, heading = '执行策略') =>
  page.locator('section').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });

const set = (root: Page | Locator, name: string) => root.getByRole('group', { name, exact: true });

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

// 非生产收紧了“谁能执行” / 配了审批，但“允许 CI 令牌执行”仍开：提示令牌可以免审批执行（ADR 0010、pitfalls #10），
// 一键关闭只改草稿；上级显式允许（下限是“允许”）不妨碍关闭；只读的人只看到提示、没有按钮。中英文 × 亮暗各覆盖一次。
for (const [scheme, lang] of [
  ['light', 'zh'],
  ['dark', 'en'],
] as const) {
  test(`非生产收紧后提示 CI 令牌仍可免审批执行，一键关闭（${scheme} · ${lang}）`, async ({ browser }) => {
    const L =
      lang === 'zh'
        ? {
            section: '执行策略',
            nonProd: '非生产环境',
            prod: '生产环境',
            who: '谁能执行',
            tokens: '允许 CI 令牌执行',
            warn: 'CI 令牌仍可直接执行迁移',
            warnBody: '不受“谁能执行”与审批流程限制',
            action: '禁止 CI 令牌执行',
            pending: '保存执行策略后生效',
            save: '保存执行策略',
            saved: '已保存执行策略',
            reset: '撤销修改',
            effectiveOff: '生效：不允许 · 来自组',
            addStage: '添加审批环节',
          }
        : {
            section: 'Execution policy',
            nonProd: 'Non-production environments',
            prod: 'Production environments',
            who: 'Who can execute',
            tokens: 'Allow CI token execution',
            warn: 'CI tokens can still execute migrations directly',
            warnBody: 'bypassing “Who can execute” and the approval flow',
            action: 'Disallow CI token execution',
            pending: 'save the execution policy to apply it',
            save: 'Save execution policy',
            saved: 'Execution policy saved',
            reset: 'Discard changes',
            effectiveOff: 'Effective: Not allowed · from group',
            addStage: 'Add approval stage',
          };
    const useLang = async (p: Page) => {
      await p.evaluate((l) => localStorage.setItem('dowel.lang', l), lang);
      await p.reload();
    };
    const { page } = await newUser(browser, '令牌提醒组管', { colorScheme: scheme });
    const group = await createGroup(page);
    await useLang(page);
    await page.goto(`/group/${group.slug}`);
    const section = policySection(page, L.section);
    const nonProd = set(section, L.nonProd);
    const warn = nonProd.getByTestId('token-bypass-warn');
    // 默认（项目编辑者、无审批、允许令牌）不提示；生产那一套默认不允许令牌，从不提示
    await expect(nonProd.getByLabel(L.who)).toBeVisible();
    await expect(warn).toHaveCount(0);

    // 收紧“谁能执行”：立刻出现提示（草稿即生效，不用先保存）
    await nonProd.getByLabel(L.who).selectOption('executor');
    await expect(warn).toContainText(L.warn);
    await expect(warn).toContainText(L.warnBody);
    await expect(set(section, L.prod).getByTestId('token-bypass-warn')).toHaveCount(0);
    await scan(page, `组首页 · 令牌提醒（${lang}）`);
    await shoot(page, `policy-token-guard-${lang}-${scheme}`);

    // 保存收紧（令牌仍允许）：保存后仍提示
    await section.getByRole('button', { name: L.save }).click();
    await expect(page.getByText(L.saved)).toBeVisible();
    await expect(warn).toBeVisible();

    // 一键关闭：只改草稿，焦点落到“允许 CI 令牌执行”，提示消失；撤销修改后提示回来
    await nonProd.getByRole('button', { name: L.action }).click();
    await expect(warn).toHaveCount(0);
    const tok = nonProd.getByLabel(L.tokens);
    await expect(tok).toHaveValue('false');
    await expect(tok).toBeFocused();
    // 稍后礼貌播报“保存后生效”（独立的 aria-live 区域，提示条本身不是 live region）
    await expect(nonProd.locator('[aria-live="polite"]')).toContainText(L.pending);
    await expect(nonProd).toContainText(L.effectiveOff);
    await section.getByRole('button', { name: L.reset }).click();
    await expect(warn).toBeVisible();

    // 审批环节也会触发（只在草稿里试，随后撤销）：谁能执行回到继承，提示消失；再加一个审批环节，提示回来
    await nonProd.getByLabel(L.who).selectOption('');
    await expect(warn).toHaveCount(0);
    await nonProd.getByRole('button', { name: L.addStage }).click();
    await expect(warn).toBeVisible();
    await section.getByRole('button', { name: L.reset }).click();

    // 只读的人（不是组管理员）看得到提示，但没有一键关闭的按钮
    const { page: viewer } = await newUser(browser, '令牌提醒旁观', { colorScheme: scheme });
    await useLang(viewer);
    await viewer.goto(`/group/${group.slug}`);
    const viewerSet = set(policySection(viewer, L.section), L.nonProd);
    await expect(viewerSet.getByTestId('token-bypass-warn')).toContainText(L.warn);
    await expect(viewerSet.getByRole('button', { name: L.action })).toHaveCount(0);
    await scan(viewer, `组首页 · 令牌提醒只读（${lang}）`);

    // 关闭并保存：刷新后不再提示
    await nonProd.getByRole('button', { name: L.action }).click();
    const saveRes = page.waitForResponse(
      (r) => r.url().includes('/exec-policy') && r.request().method() === 'PUT' && r.ok(),
    );
    await section.getByRole('button', { name: L.save }).click();
    await saveRes;
    await expect(page.getByText(L.saved).first()).toBeVisible();
    await page.reload();
    const reloaded = set(policySection(page, L.section), L.nonProd);
    await expect(reloaded.getByLabel(L.tokens)).toHaveValue('false');
    await expect(reloaded.getByTestId('token-bypass-warn')).toHaveCount(0);
  });
}

test('上级显式允许令牌（下限“允许”）+ 上级的审批环节：项目层仍提示，一键关闭可以保存', async ({
  browser,
}) => {
  const { page } = await newUser(browser, '令牌提醒锁定');
  const group = await createGroup(page);
  const projectUrl = await createProjectIn(page, '令牌提醒项目', group.name);
  // 组层：显式允许令牌执行 + 一个审批环节
  await page.goto(`/group/${group.slug}`);
  const groupSection = policySection(page);
  const groupSet = set(groupSection, '非生产环境');
  await groupSet.getByLabel('允许 CI 令牌执行').selectOption('true');
  await groupSet.getByRole('button', { name: '添加审批环节' }).click();
  await groupSection.getByRole('button', { name: '保存执行策略' }).click();
  await expect(page.getByText('已保存执行策略')).toBeVisible();

  // 项目层：审批环节来自组、令牌执行由组定为“允许”——仍提示；关闭是收紧，不受锁定限制，保存成功
  await page.goto(projectUrl);
  await gotoPage(page, '设置');
  const projSection = policySection(page);
  const projSet = set(projSection, '非生产环境');
  await expect(projSet.getByTestId('token-bypass-warn')).toBeVisible();
  await projSet.getByRole('button', { name: '禁止 CI 令牌执行' }).click();
  await expect(projSet.getByLabel('允许 CI 令牌执行')).toHaveValue('false');
  await expect(projSet).toContainText('生效：不允许 · 来自项目');
  await projSection.getByRole('button', { name: '保存执行策略' }).click();
  await expect(page.getByText('已保存执行策略')).toBeVisible();
  await expect(projSection.getByRole('alert')).toHaveCount(0);
  await expect(projSet.getByTestId('token-bypass-warn')).toHaveCount(0);

  // 组层自己改成“不允许”，提示随即消失（上级锁定为不允许时下级生效值也是不允许，单测覆盖）
  await page.goto(`/group/${group.slug}`);
  const g2 = set(policySection(page), '非生产环境');
  await expect(g2.getByTestId('token-bypass-warn')).toBeVisible();
  await g2.getByLabel('允许 CI 令牌执行').selectOption('false');
  await expect(g2.getByTestId('token-bypass-warn')).toHaveCount(0);
});

test('保存执行策略进行中时“撤销修改”禁用，保存完成后回到未修改状态（组层）', async ({ browser }) => {
  const { page } = await newUser(browser, '策略保存中');
  const group = await createGroup(page);
  await page.goto(`/group/${group.slug}`);
  // 组页上令牌创建规则面板也有一个“撤销修改”，限定在执行策略这一节里
  const panel = policySection(page);
  const save = panel.getByRole('button', { name: '保存执行策略' });
  const reset = panel.getByRole('button', { name: '撤销修改' });
  await expect(reset).toBeDisabled();
  await set(panel, '非生产环境').getByLabel('谁能执行').selectOption('admin');
  await expect(reset).toBeEnabled();

  const release = await holdRequest(page, '**/api/groups/*/exec-policy', 'PUT');
  await save.click();
  // 请求还没回来：保存、撤销、表单都不可操作，避免撤销后又被迟到的保存结果覆盖
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(reset).toBeDisabled();
  await expect(set(panel, '非生产环境').getByLabel('谁能执行')).toBeDisabled();
  await release();

  await expect(page.getByText('已保存执行策略')).toBeVisible();
  await expect(save).toHaveAttribute('aria-busy', 'false');
  await expect(set(panel, '非生产环境').getByLabel('谁能执行')).toHaveValue('admin');
  await expect(set(panel, '非生产环境').getByLabel('谁能执行')).toBeEnabled();
  // 已保存：没有未保存的修改，撤销仍禁用；再改一次又可撤销
  await expect(reset).toBeDisabled();
  await set(panel, '非生产环境').getByLabel('谁能执行').selectOption('');
  await expect(reset).toBeEnabled();
});

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

      // 再收紧成“仅限执行者”：回到环境页，立刻不能直接执行了——按钮变成“提交执行申请”（P5b：无权者提交申请）
      await gotoPage(page, '设置');
      await set(page, '非生产环境').getByLabel('谁能执行').selectOption('executor');
      await page.getByRole('button', { name: '保存执行策略' }).click();
      await expect(page.getByText('已保存执行策略').first()).toBeVisible();
      await openEnv(page, 'dev');
      await expect(page.getByRole('button', { name: '执行迁移' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '提交执行申请' })).toBeVisible();
    } finally {
      await devDb.drop();
    }
  });

  test('保存环境执行策略进行中时“撤销修改”禁用（环境层）', async ({ browser }) => {
    const devDb = await newTargetDb('e2e_pol_reset');
    try {
      const { page } = await newUser(browser, '环境策略保存中');
      const group = await createGroup(page);
      await createProjectIn(page, '撤销禁用项目', group.name);
      await addEnv(page, 'dev', devDb.url, false);
      await openEnv(page, 'dev');
      const panel = page.getByTestId('env-policy');
      const who = set(page, '本环境（非生产）').getByLabel('谁能执行');
      const save = panel.getByRole('button', { name: '保存执行策略' });
      const reset = panel.getByRole('button', { name: '撤销修改' });
      await expect(reset).toBeDisabled();
      await who.selectOption('admin');
      await expect(reset).toBeEnabled();

      const release = await holdRequest(page, '**/api/projects/*/environments/*/exec-policy', 'PUT');
      await save.click();
      await expect(save).toBeDisabled();
      await expect(save).toHaveAttribute('aria-busy', 'true');
      await expect(reset).toBeDisabled();
      await expect(who).toBeDisabled();
      await release();

      await expect(page.getByText('已保存执行策略')).toBeVisible();
      await expect(save).toHaveAttribute('aria-busy', 'false');
      await expect(who).toHaveValue('admin');
      await expect(reset).toBeDisabled();
      await who.selectOption('');
      await expect(reset).toBeEnabled();
    } finally {
      await devDb.drop();
    }
  });
});
