// CI 令牌（P6）：令牌管理界面（创建只显示一次、列表、吊销）、三层“谁能创建令牌”的配置（上级锁定 + 组条件自动只读可见）、
// 用 Playwright request 上下文拿令牌调 /api/ci 执行接口打到测试 PG（生产默认拒、开开关后通过并在收件箱显示通知），
// 以及亮 / 暗配色下的 axe 无障碍扫描。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { addEnv, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
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

for (const scheme of ['light', 'dark'] as const) {
  test(`令牌管理与三层创建规则界面、自动只读可见性、无障碍扫描（${scheme}）`, async ({ browser }) => {
    // 管理后台 /admin/policy 包含“谁能创建 CI 令牌”配置
    const admin = await instanceAdmin(browser, scheme);
    await admin.goto('/admin/policy');
    await expect(admin.getByRole('heading', { name: '谁能创建 CI 令牌' })).toBeVisible();
    await scan(admin, `/admin/policy (${scheme})`);

    // 建业务组、流水线组（另一位用户加入流水线组）和项目
    const { page: ga } = await newUser(browser, '令牌组管', { colorScheme: scheme });
    const { page: pipeUser, username: pipeUsername } = await newUser(browser, '流水线员', {
      colorScheme: scheme,
    });
    const bizGroup = await createGroup(ga, `令牌业务组-${scheme}`);
    const pipeGroup = await createGroup(ga, `令牌流水线组-${scheme}`);
    await ga.goto(`/group/${pipeGroup.slug}`);
    await ga.getByLabel('用户名').fill(pipeUsername);
    await ga.getByRole('button', { name: '添加成员' }).click();
    await expect(ga.getByText(pipeUsername, { exact: true })).toBeVisible();

    const projectUrl = await createProjectIn(ga, '令牌项目', bizGroup.name);

    // 组层设置：允许项目管理员或“令牌流水线组”成员创建令牌
    await ga.goto(`/group/${bizGroup.slug}`);
    const groupTokPanel = ga.getByTestId('token-policy-panel');
    await groupTokPanel.getByRole('radio', { name: '在本层指定允许范围' }).check();
    await groupTokPanel.getByRole('button', { name: '添加组条件' }).click();
    await groupTokPanel.getByLabel('组', { exact: true }).selectOption({ label: pipeGroup.name });
    await groupTokPanel.getByRole('button', { name: '保存创建规则' }).click();
    await expect(ga.getByText('已保存令牌创建规则')).toBeVisible();
    await scan(ga, `组页 · 令牌规则 (${scheme})`);

    // 项目层：看到“由组锁定”提示；创建令牌只显示一次明文；关闭后列表不显示明文；吊销生效
    await ga.goto(projectUrl);
    await gotoPage(ga, '设置');
    await expect(ga.getByTestId('token-policy-locked-group')).toContainText('由组锁定');
    const tokPanel = ga.getByTestId('ci-tokens-panel');
    await tokPanel.getByLabel('名称').fill('GitHub 部署');
    await tokPanel.getByLabel('说明（选填）').fill('自动迁移');
    await tokPanel.getByLabel('有效期（天）').fill('30');
    await tokPanel.getByRole('button', { name: '创建令牌' }).click();
    const tokenValue = (await tokPanel.getByTestId('created-token-value').textContent())?.trim() ?? '';
    expect(tokenValue).toMatch(/^dwl_[A-Za-z0-9_-]{43}$/);
    await scan(ga, `项目设置 · 创建令牌后 (${scheme})`);
    await tokPanel.getByRole('button', { name: '我已保存' }).click();
    await expect(tokPanel.getByTestId('created-token-value')).toHaveCount(0);
    // 列表里只显示前缀，不显示明文
    await expect(tokPanel).toContainText(tokenValue.slice(0, 12));
    await expect(tokPanel).not.toContainText(tokenValue);

    // 吊销令牌
    await tokPanel.getByRole('button', { name: '吊销' }).click();
    const confirmDlg = ga.getByRole('dialog');
    await confirmDlg.getByRole('button', { name: '吊销' }).click();
    await expect(ga.getByText('已吊销令牌', { exact: true })).toBeVisible();
    await expect(tokPanel).toContainText('已吊销');

    // 流水线组成员（原本不是业务组成员）自动能只读看到项目，并能创建自己的令牌
    await pipeUser.goto(projectUrl);
    await gotoPage(pipeUser, '设置');
    const pipeTokPanel = pipeUser.getByTestId('ci-tokens-panel');
    await pipeTokPanel.getByLabel('名称').fill('流水线自建');
    await pipeTokPanel.getByRole('button', { name: '创建令牌' }).click();
    await expect(pipeTokPanel.getByTestId('created-token-value')).toBeVisible();
  });
}

test.describe('CI 令牌真实执行（需要目标库 PG）', () => {
  test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');
  test.describe.configure({ timeout: 90_000 });

  test('通过界面创建令牌并调用 /api/ci 执行到测试 PG；生产默认拒绝，打开开关后通过并写进收件箱', async ({
    browser,
    request,
  }) => {
    const stgDb = await test.step('建 staging 目标库', () => newTargetDb('e2e_tok_stg'));
    const prodDb = await test.step('建 prod 目标库', () => newTargetDb('e2e_tok_prod'));
    try {
      const { page } = await test.step('新建用户并建项目', () => newUser(browser, 'CI 管理员'));
      const group = await createGroup(page, 'CI 执行组');
      const projectUrl = await createProjectIn(page, 'CI 执行项目', group.name);
      const [, , owner, slug] = new URL(projectUrl).pathname.split('/');

      await test.step('添加 staging / prod 环境并发布 v1', async () => {
        await addEnv(page, 'staging', stgDb.url, false);
        await addEnv(page, 'prod', prodDb.url, true);
        await publishTable(page, 'orders', 'v1', 1);
      });

      const token = await test.step('在项目设置里创建 CI 令牌', async () => {
        await gotoPage(page, '设置');
        const tokPanel = page.getByTestId('ci-tokens-panel');
        await tokPanel.getByLabel('名称').fill('E2E 流水线');
        await tokPanel.getByRole('button', { name: '创建令牌' }).click();
        const val = (await tokPanel.getByTestId('created-token-value').textContent())?.trim() ?? '';
        expect(val).toMatch(/^dwl_/);
        return val;
      });
      const headers = { authorization: `Bearer ${token}` };

      await test.step('staging 执行成功、prod 默认拒绝', async () => {
        const stgRes = await request.post(`/api/ci/projects/${owner}/${slug}/environments/staging/execute`, {
          headers,
          data: { to: 'latest' },
        });
        expect(stgRes.status()).toBe(200);
        expect(await stgRes.json()).toMatchObject({ ok: true, reached: { number: 1 }, noop: false });

        const prodDenied = await request.post(`/api/ci/projects/${owner}/${slug}/environments/prod/execute`, {
          headers,
          data: { to: 'v1' },
        });
        expect(prodDenied.status()).toBe(403);
        expect(await prodDenied.json()).toMatchObject({ ok: false, code: 'token_execution_disabled' });
      });

      await test.step('打开 prod 允许令牌执行并执行成功', async () => {
        await openEnv(page, 'prod');
        const envSet = page.getByRole('group', { name: '本环境（生产）', exact: true });
        await envSet.getByLabel('允许 CI 令牌执行').selectOption('true');
        await page.getByRole('button', { name: '保存执行策略' }).click();
        await expect(page.getByText('已保存执行策略')).toBeVisible();

        const prodOk = await request.post(`/api/ci/projects/${owner}/${slug}/environments/prod/execute`, {
          headers,
          data: { to: 'v1' },
        });
        expect(prodOk.status()).toBe(200);
        expect(await prodOk.json()).toMatchObject({ ok: true, reached: { number: 1 }, noop: false });
      });

      await test.step('收件箱显示通知并通过 axe 扫描', async () => {
        await page.goto('/inbox');
        await page.getByRole('tab', { name: /^通知/ }).click();
        await expect(page.getByText(/CI 令牌执行了生产环境/)).toBeVisible({ timeout: 15_000 });
        await scan(page, '收件箱 · CI 令牌执行通知');
      });
    } finally {
      await stgDb.drop();
      await prodDb.drop();
    }
  });
});
