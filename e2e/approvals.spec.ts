// 执行申请与审批（P5b 验收）：开发提交申请 → 组管理员审批 → DBA“通过并执行”；收件箱未读数实时变化；
// 实例管理员的紧急执行（原因必填、二次确认）；申请详情、收件箱、确认对话框（申请模式）的 axe 扫描（亮 / 暗）。
// 需要 PG 作目标库（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createGroup, createProjectIn, instanceAdmin, newUser } from './helpers.ts';

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

const shoot = async (page: Page, name: string) => {
  if (process.env.SHOOT_APP === '1')
    await page.screenshot({ path: `.agents/docs/ui/shots/app-${name}.png`, fullPage: true });
};

/** 图标栏收件箱的未读数（没有未读时不显示数字） */
const unread = (page: Page) => page.getByTestId('inbox-unread');

const idOf = async (page: Page, username: string) => {
  const r = await page.request.get(`/api/directory?q=${encodeURIComponent(username)}`);
  const d = (await r.json()) as { users: { id: string; slug: string }[] };
  return d.users.find((u) => u.slug === username)!.id;
};

test.describe('需要目标库', () => {
  test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');
  test.describe.configure({ timeout: 240_000 });

  for (const scheme of ['light', 'dark'] as const)
    test(`开发提交申请 → 组管理员审批 → DBA“通过并执行”；收件箱未读数；紧急执行（${scheme}）`, async ({
      browser,
    }) => {
      const prodDb = await newTargetDb('e2e_req_prod');
      try {
        // 组管理员建组、项目、生产环境，发布 v1
        const { page: ga } = await newUser(browser, '组管理员', { colorScheme: scheme });
        const { page: dev, username: devName } = await newUser(browser, '开发', { colorScheme: scheme });
        const { page: dba, username: dbaName } = await newUser(browser, 'DBA', { colorScheme: scheme });
        const group = await createGroup(ga);
        const projectUrl = await createProjectIn(ga, '审批项目', group.name);
        await addEnv(ga, 'prod', prodDb.url, true);
        await publishTable(ga, 'orders', 'v1', 1);
        const [, , owner, slug] = new URL(projectUrl).pathname.split('/');
        const pid = ((await (await ga.request.get(`/api/resolve/${owner}/${slug}`)).json()) as { id: string })
          .id;
        const envs = (await (await ga.request.get(`/api/projects/${pid}/environments`)).json()) as {
          id: string;
          name: string;
        }[];
        const prodId = envs.find((e) => e.name === 'prod')!.id;
        // 授权：开发 = 编辑者；DBA = prod 的执行者
        for (const body of [
          { subjectKind: 'user', subjectId: await idOf(ga, devName), role: 'editor' },
          {
            subjectKind: 'user',
            subjectId: await idOf(ga, dbaName),
            role: 'executor',
            environmentId: prodId,
          },
        ]) {
          const r = await ga.request.post(`/api/projects/${pid}/grants`, { data: body });
          expect(r.ok(), await r.text()).toBe(true);
        }
        // 审批流程：组管理员 → 执行者（最后一个审批人即执行者）
        const pol = await ga.request.put(`/api/projects/${pid}/exec-policy`, {
          data: {
            production: {
              approval: [
                { approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: false },
                { approvers: { kind: 'executors' }, count: 1, lastApproverExecutes: true },
              ],
            },
            nonProduction: {},
          },
        });
        expect(pol.ok(), await pol.text()).toBe(true);

        // 开发：环境页上执行按钮变成“提交执行申请”，对话框里先预演，写说明后提交
        await dev.goto(projectUrl);
        await openEnv(dev, 'prod');
        await expect(dev.getByTestId('approval-required')).toBeVisible();
        await dev.getByRole('button', { name: '提交执行申请' }).click();
        const dlg = execDialog(dev);
        await expect(dlg.getByTestId('dry-run')).toBeVisible({ timeout: 30_000 });
        await dlg.getByLabel('申请说明（选填）').fill('上线订单表');
        await scan(dev, '确认对话框 · 提交执行申请');
        await dlg.getByRole('button', { name: '提交执行申请' }).click();
        await expect(dev.getByTestId('request-status')).toHaveText('待审批');
        await expect(dev.getByTestId('stage-0')).toContainText('项目所属组的组管理员');
        await scan(dev, '申请详情 · 待审批');

        // 组管理员：图标栏未读数出现（SSE 推送，不刷新页面），收件箱里“待我处理”有这条
        await expect(unread(ga)).toHaveText('1', { timeout: 15_000 });
        await ga.getByRole('link', { name: '收件箱' }).click();
        await expect(ga.getByRole('tab', { name: /待我处理（1）/ })).toBeVisible();
        await scan(ga, '收件箱');
        await shoot(ga, `inbox-${scheme}`);
        await ga.getByRole('link', { name: /审批项目 \/ prod：执行到 v1/ }).click();
        await ga.getByLabel('意见（选填）').fill('可以上线');
        await ga.getByRole('button', { name: '通过', exact: true }).click();
        await expect(ga.getByText('已通过这个环节')).toBeVisible();
        await expect(ga.getByTestId('stage-0')).toContainText('可以上线');

        // DBA：收到第二个环节的通知；“通过并执行”，生产环境输入环境名
        await dba.goto('/inbox');
        await expect(unread(dba)).toHaveText('1', { timeout: 15_000 });
        await dba.getByRole('link', { name: /审批项目 \/ prod：执行到 v1/ }).click();
        await expect(dba.getByTestId('stage-1')).toContainText('当前环节');
        await expect(dba.getByTestId('stage-1')).toContainText('执行者');
        await scan(dba, '申请详情 · 第二个环节');
        await shoot(dba, `request-${scheme}`);
        await dba.getByRole('button', { name: '通过并执行' }).click();
        const run = dba.getByRole('dialog');
        await run.getByLabel('输入环境名 prod 确认').fill('prod');
        await run.getByRole('button', { name: '通过并执行' }).click();
        await expect(run.getByText('执行完成')).toBeVisible({ timeout: 60_000 });
        await run.getByRole('contentinfo').getByRole('button', { name: '关闭' }).click();
        await expect(dba.getByTestId('request-status')).toHaveText('已执行');
        await expect(dba.getByTestId('timeline')).toContainText('执行成功');
        expect(
          (
            await prodDb.sql<{ n: number }>(
              "select count(*)::int as n from pg_tables where tablename = 'orders'",
            )
          )[0]!.n,
        ).toBe(1);

        // 开发：收件箱里有“已执行”的结果，未读数实时更新
        await expect(unread(dev)).toHaveText('1', { timeout: 15_000 });
        await dev.getByRole('link', { name: '收件箱' }).click();
        await dev.getByRole('tab', { name: /通知/ }).click();
        await expect(dev.getByText(/你的申请已执行：审批项目 \/ prod 到 v1/)).toBeVisible();
        await dev.getByRole('button', { name: '全部标为已读' }).click();
        await expect(unread(dev)).toHaveCount(0);

        // 紧急执行：实例管理员，原因必填 + 勾选确认 + 输入环境名；审批人（组管理员）收到通知
        await publishTable(ga, 'items', 'v2', 2);
        const admin = await instanceAdmin(browser, scheme);
        await admin.goto(projectUrl);
        await openEnv(admin, 'prod');
        await admin.getByRole('button', { name: '紧急执行' }).click();
        const em = execDialog(admin);
        const confirm = em.getByRole('button', { name: '紧急执行' });
        await expect(em.getByTestId('dry-run')).toBeVisible({ timeout: 30_000 });
        await em.getByLabel('输入环境名确认').fill('prod');
        await expect(confirm).toHaveAttribute('aria-disabled', 'true');
        await em.getByLabel('紧急执行的原因').fill('线上故障，需要立即加表');
        await expect(confirm).toHaveAttribute('aria-disabled', 'true');
        await em.getByLabel('我确认这是紧急情况，要绕过审批直接执行').check();
        await scan(admin, '确认对话框 · 紧急执行');
        await confirm.click();
        await expect(em.getByText('执行完成')).toBeVisible({ timeout: 60_000 });
        // 组管理员之前那条“待你审批”还没读，加上紧急执行的开始和结果两条：3 条未读
        await expect(unread(ga)).toHaveText('3', { timeout: 15_000 });
        await ga.goto('/inbox');
        await ga.getByRole('tab', { name: /通知/ }).click();
        await expect(ga.getByText(/^紧急执行：审批项目 \/ prod 到 v2/)).toBeVisible();
        await expect(ga.getByText(/紧急执行完成：审批项目 \/ prod 到 v2/)).toBeVisible();
      } finally {
        await prodDb.drop();
      }
    });
});
