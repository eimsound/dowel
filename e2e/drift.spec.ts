// 漂移的两个出口与标记为已执行（ADR 0004）：
// - 放弃线上的修改：漂移详情里的修复脚本（只显示、可复制），自己执行后重新检查漂移；
// - 保留线上的修改：导入预览 → 覆盖工作副本 → 发布 → 标记为已执行（确认框必须勾选“脚本效果已经手工完成”才能确认）；
// - 标记核对不通过时在确认框里显示差异；
// 需要 PG 作目标库和影子库，没有 Docker 时跳过。
// 连接检查 / 读历史 / 导入按用户限速（每分钟 10 次）：一个用例里分阶段换新的实例管理员，不互相挤占额度。
import { expect, type Page, test } from '@playwright/test';

import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createGroup, createProjectIn, instanceAdmin } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

type Db = Awaited<ReturnType<typeof newTargetDb>>;

const executeAll = async (page: Page) => {
  await page.getByRole('button', { name: '执行迁移' }).click();
  const dlg = execDialog(page);
  await dlg.getByRole('button', { name: '确认执行' }).click();
  await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
  await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
  await expect(dlg).toBeHidden();
};

/** 建项目、加环境、发布 v1 v2 并执行；停在环境详情页。返回环境页地址 */
const setup = async (page: Page, db: Db) => {
  const group = await createGroup(page);
  await createProjectIn(page, '漂移项目', group.name);
  await addEnv(page, 'dev', db.url, false);
  await publishTable(page, 'orders', 'v1', 1);
  await publishTable(page, 'customers', 'v2', 2);
  await openEnv(page, 'dev');
  await executeAll(page);
  return page.url();
};

const checkDrift = async (page: Page) => {
  await page.getByRole('button', { name: '检查漂移' }).click();
  await expect(page.getByTestId('drift-exits')).toBeVisible();
};

for (const scheme of ['light', 'dark'] as const) {
  test(`放弃线上的修改（${scheme}）：修复脚本只显示不执行，自己执行后重新检查漂移`, async ({ browser }) => {
    const db = await newTargetDb('e2e_drift_repair');
    try {
      const page = await instanceAdmin(browser, scheme);
      await setup(page, db);
      await db.sql('alter table public.orders add column hot int');
      await checkDrift(page);
      // 两个出口不分主次：两个按钮并排，都是普通按钮
      const exits = page.getByTestId('drift-exits');
      await expect(exits.getByRole('button', { name: '保留线上的修改' })).toBeVisible();
      await expect(exits.getByRole('button', { name: '放弃线上的修改' })).toBeVisible();
      await expect(exits.getByRole('button', { name: '放弃线上的修改' })).not.toHaveClass(/primary/);

      await exits.getByRole('button', { name: '放弃线上的修改' }).click();
      const dlg = page.getByRole('dialog', { name: '修复脚本' });
      await expect(dlg).toBeVisible();
      await expect(dlg.getByTestId('repair-script')).toContainText('DROP COLUMN');
      await expect(dlg.getByTestId('repair-script')).toContainText("SET search_path = ''");
      await expect(dlg).toContainText('Dowel 不会执行');
      await expect(dlg).toContainText('会删掉线上的对象或其中的数据'); // 风险提示（按步骤种类统计）
      // 只显示，没有执行：目标库里 hot 还在
      expect(
        (
          await db.sql<{ n: number }>(
            "select count(*)::int as n from information_schema.columns where column_name = 'hot'",
          )
        )[0]!.n,
      ).toBe(1);
      // 自己执行脚本（这里直接在目标库上执行同样的语句），然后在对话框里重新检查漂移
      await db.sql('alter table public.orders drop column hot');
      await dlg.getByRole('button', { name: '重新检查漂移' }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByTestId('drift-exits')).toHaveCount(0);
    } finally {
      await db.drop();
    }
  });

  test(`保留线上的修改（${scheme}）：导入预览 → 覆盖 → 发布 → 标记为已执行（必须勾选确认）；核对不通过在确认框里显示差异`, async ({
    browser,
  }) => {
    const db = await newTargetDb('e2e_drift_keep');
    try {
      const first = await instanceAdmin(browser, scheme);
      const envUrl = await setup(first, db);
      await db.sql('alter table public.orders add column hot int'); // 线上热修

      // 导入：打开对话框先预览（差异、指纹、没有警告），再确认覆盖
      await first.getByRole('button', { name: '检查漂移' }).click();
      await expect(first.getByTestId('drift-exits')).toBeVisible();
      await first.getByTestId('drift-exits').getByRole('button', { name: '保留线上的修改' }).click();
      const imp = first.getByRole('dialog', { name: '把线上结构导入工作副本' });
      await expect(imp).toBeVisible();
      await expect(imp).toContainText('覆盖会带来的变化', { timeout: 30_000 });
      await expect(imp).toContainText('hot');
      await expect(imp).toContainText('线上结构指纹');
      await expect(imp).not.toContainText('撤销'); // 环境在链头：没有“落后”警告
      await imp.getByRole('button', { name: '覆盖工作副本' }).click();
      await expect(imp).toBeHidden();
      await expect(first.getByText(/已导入：工作副本现在是线上结构/)).toBeVisible();

      // 发布 v3（工作副本现在含 hot 列）：普通发布，没有特殊标记
      await first.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
      await expect(first.getByRole('navigation', { name: '对象' })).toBeVisible();
      await first.getByRole('button', { name: '发布' }).click();
      await first.getByLabel('版本名').fill('v3 保留热修');
      await first.getByRole('dialog').getByRole('button', { name: '发布' }).click();
      await expect(first.getByText('已发布 v3 v3 保留热修，已通过验证')).toBeVisible({ timeout: 60_000 });

      // 标记为已执行：换一个新的实例管理员（限速），回到环境页
      const page = await instanceAdmin(browser, scheme);
      await page.goto(envUrl);
      await expect(page.getByTestId('current-version')).toContainText('v2');
      const markBtn = page.getByRole('button', { name: '标记为已执行到 v3' });
      await expect(markBtn).toBeVisible();
      // tooltip：不执行任何 SQL、先核对线上结构、标记之后脚本不能再编辑
      const tip = (await markBtn.getAttribute('title')) ?? '';
      expect(tip).toContain('不执行任何 SQL');
      expect(tip).toContain('和 v3 的模型完全一致才允许标记');
      expect(tip).toContain('标记之后 v3 的脚本不能再编辑');
      await markBtn.click();
      const dlg = page.getByRole('dialog', { name: '标记为已执行到 v3' });
      await expect(dlg.getByTestId('mark-plan')).toBeVisible({ timeout: 30_000 });
      // 列出被跳过的版本和脚本
      await expect(dlg).toContainText('这些版本会被记为已执行，但它们的脚本不会执行');
      await expect(dlg.getByTestId('mark-plan').getByText('v3 保留热修')).toBeVisible();
      await dlg.getByText('查看步骤').first().click();
      await expect(dlg).toContainText('ADD COLUMN');
      // 必须勾选“这些脚本的效果已经手工完成，或者不需要”才能确认
      const confirm = dlg.getByRole('button', { name: '确认标记' });
      await expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await confirm.click({ force: true });
      await expect(dlg).not.toContainText('已标记：');
      await dlg.getByLabel('这些脚本的效果已经手工完成，或者不需要').check();
      await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
      await confirm.click();
      await expect(dlg).toContainText('已标记：环境当前版本是 v3');
      await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
      await expect(page.getByTestId('current-version')).toContainText('v3');
      await expect(page.getByTestId('drift-exits')).toHaveCount(0);
      // 没有执行任何 SQL：目标库历史里最后一条是 mark；执行历史里显示“标记”
      expect(
        (await db.sql<{ d: string }>('select direction as d from dowel.history order by id desc limit 1'))[0]!
          .d,
      ).toBe('mark');
      const markRow = page.locator('tr[data-run=mark]');
      await expect(markRow).toHaveCount(1);
      expect((await markRow.locator('span[title]').getAttribute('title')) ?? '').toContain('不执行任何 SQL');

      // 核对不通过：标记回 v2，线上其实是 v3 的结构 → 确认框显示差异，不能确认；向后标记的按钮文案和 tooltip（没有“不能再编辑”）
      await page.getByLabel('标记到版本').selectOption({ label: 'v2 v2' });
      const backBtn = page.getByRole('button', { name: '标记为已回滚到 v2' });
      expect(((await backBtn.getAttribute('title')) ?? '').includes('不能再编辑')).toBe(false);
      await backBtn.click();
      const dlg2 = page.getByRole('dialog', { name: '标记为已回滚到 v2' });
      await expect(dlg2).toContainText('线上结构和 v2 的模型不一致', { timeout: 30_000 });
      await expect(dlg2.getByTestId('mark-error')).toContainText('不一致');
      await expect(dlg2).toContainText('hot');
      await expect(dlg2.getByRole('button', { name: '确认标记' })).toHaveAttribute('aria-disabled', 'true');
    } finally {
      await db.drop();
    }
  });
}

test('标记确认框以服务端预演为准：平台缓存说是向后标记，目标库实际是向前 → 对话框按预演显示跳过的版本和脚本、要求勾选', async ({
  browser,
}) => {
  const db = await newTargetDb('e2e_drift_plan');
  try {
    const page = await instanceAdmin(browser);
    const group = await createGroup(page);
    await createProjectIn(page, '预演为准', group.name);
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await publishTable(page, 'customers', 'v2', 2);
    await publishTable(page, 'invoices', 'v3', 3);
    await openEnv(page, 'dev');
    await executeAll(page); // 页面缓存：当前版本 v3
    await expect(page.getByTestId('current-version')).toContainText('v3');

    // 页面不动，在页面外把环境回滚到 v1，再手工做成 v2 的样子（v2 的升级脚本直接在目标库上执行）
    const list = (await (await page.request.get('/api/projects')).json()) as { id: string; name: string }[];
    const pid = list.find((x) => x.name === '预演为准')!.id;
    const versions = (await (await page.request.get(`/api/projects/${pid}/versions`)).json()) as {
      id: string;
      number: number;
    }[];
    const v = (n: number) => versions.find((x) => x.number === n)!.id;
    const envs = (await (await page.request.get(`/api/projects/${pid}/environments`)).json()) as {
      id: string;
    }[];
    const back = await page.request.post(`/api/projects/${pid}/environments/${envs[0]!.id}/rollback`, {
      data: { to: v(1) },
    });
    expect(back.ok()).toBe(true);
    const v2 = (await (await page.request.get(`/api/projects/${pid}/versions/${v(2)}`)).json()) as {
      upSteps: { sql: string }[];
    };
    for (const s of v2.upSteps) await db.sql(s.sql);

    // 页面还以为当前是 v3：选 v2 → 按缓存是“标记为已回滚到 v2”
    await page.getByLabel('标记到版本').selectOption({ label: 'v2 v2' });
    await page.getByRole('button', { name: '标记为已回滚到 v2' }).click();
    // 对话框预演回来以后，按服务端的计划显示：实际是向前（v1 → v2），要跳过 v2 的脚本、要勾选确认
    const dlg = page.getByRole('dialog', { name: '标记为已执行到 v2' });
    await expect(dlg.getByTestId('mark-plan')).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toContainText('这些版本会被记为已执行，但它们的脚本不会执行');
    await dlg.getByText('查看步骤').first().click();
    await expect(dlg).toContainText('CREATE TABLE');
    const confirm = dlg.getByRole('button', { name: '确认标记' });
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await dlg.getByLabel('这些脚本的效果已经手工完成，或者不需要').check();
    await confirm.click();
    await expect(dlg).toContainText('已标记：环境当前版本是 v2');
    expect(
      (await db.sql<{ d: string }>('select direction as d from dowel.history order by id desc limit 1'))[0]!
        .d,
    ).toBe('mark');
  } finally {
    await db.drop();
  }
});

test('有未完成的运行时，下拉里的“当前”、标记方向和“停在 vN”都以目标库读到的当前版本为准，不用可能过期的平台缓存', async ({
  browser,
}) => {
  const db = await newTargetDb('e2e_drift_stale');
  try {
    const page = await instanceAdmin(browser);
    const group = await createGroup(page);
    await createProjectIn(page, '缓存过期', group.name);
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await publishTable(page, 'customers', 'v2', 2);
    await openEnv(page, 'dev');
    await executeAll(page); // 目标库在 v2

    // 目标库里造一条 v1 → v2 的“停在中途”记录；平台缓存（/status）被改成还停在 v1——模拟缓存过期
    const inst = (await db.sql<{ i: string }>('select instance_id as i from dowel.projects'))[0]!.i;
    const ids = await db.sql<{ v: string; n: number }>(
      'select version_id as v, number as n from dowel.versions order by number',
    );
    await db.sql(
      `insert into dowel.history (project_id, from_version, to_version, direction, status, step_index, error, via, instance_id)
       select project_id, '${ids[0]!.v}', '${ids[1]!.v}', 'up', 'failed', 0, 'boom', 'web', '${inst}' from dowel.projects`,
    );
    await page.route('**/api/projects/*/environments/*/status', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as {
        currentVersion: { id: string; number: number; name: string } | null;
        versions: { id: string; number: number; name: string }[];
      };
      const v1 = body.versions.find((v) => v.number === 1)!;
      body.currentVersion = { id: v1.id, number: v1.number, name: v1.name };
      await route.fulfill({ response: res, json: body });
    });
    await page.reload();
    await expect(page.getByText(/上一次执行停在中途|停在中途/).first()).toBeVisible();
    // 缓存说当前是 v1，目标库实际是 v2：下拉里“当前”标在 v2 上，选 v2 就是“停在 v2”（不是向前标记）
    await expect(page.getByLabel('标记到版本').locator('option')).toHaveText(['v1 v1', 'v2 v2（当前）']);
    await page.getByLabel('标记到版本').selectOption({ label: 'v2 v2（当前）' });
    await expect(page.getByRole('button', { name: '标记为停在 v2（放弃未完成的迁移）' })).toBeVisible();
    // 选 v1：相对目标库实际的当前版本 v2 是向后标记
    await page.getByLabel('标记到版本').selectOption({ label: 'v1 v1' });
    await expect(page.getByRole('button', { name: '标记为已回滚到 v1' })).toBeVisible();
  } finally {
    await db.drop();
  }
});

test('上一次执行没结束时：当前版本也能作为标记目标（标记为停在 vN，放弃未完成的迁移），文案和 tooltip 不提“不能再编辑”', async ({
  browser,
}) => {
  const db = await newTargetDb('e2e_drift_stay');
  try {
    const page = await instanceAdmin(browser);
    const group = await createGroup(page);
    await createProjectIn(page, '停在当前', group.name);
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await publishTable(page, 'customers', 'v2', 2);
    await openEnv(page, 'dev');
    await executeAll(page);
    // 没有未完成的运行：下拉里没有当前版本（只有 v1）
    await expect(page.getByLabel('标记到版本').locator('option')).toHaveText(['v1 v1']);

    // 造一条“停在中途”的失败记录（已经有断点）：库里的结构其实就是 v2（DBA 已经手工改回）
    const inst = (await db.sql<{ i: string }>('select instance_id as i from dowel.projects'))[0]!.i;
    const ids = await db.sql<{ v: string; n: number }>(
      'select version_id as v, number as n from dowel.versions order by number',
    );
    await db.sql(
      `insert into dowel.history (project_id, from_version, to_version, direction, status, step_index, error, via, instance_id)
       select project_id, '${ids[0]!.v}', '${ids[1]!.v}', 'up', 'failed', 0, 'boom', 'web', '${inst}' from dowel.projects`,
    );
    await page.reload();
    await expect(page.getByText(/上一次执行停在中途|停在中途/).first()).toBeVisible();
    await expect(page.getByLabel('标记到版本').locator('option')).toHaveText(['v1 v1', 'v2 v2（当前）']);
    await page.getByLabel('标记到版本').selectOption({ label: 'v2 v2（当前）' });
    const btn = page.getByRole('button', { name: '标记为停在 v2（放弃未完成的迁移）' });
    const tip = (await btn.getAttribute('title')) ?? '';
    expect(tip).toContain('不执行任何 SQL');
    expect(tip).not.toContain('不能再编辑');
    await btn.click();
    const dlg = page.getByRole('dialog', { name: '标记为停在 v2（放弃未完成的迁移）' });
    await expect(dlg.getByTestId('mark-plan')).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toContainText('放弃上一次没有结束的迁移');
    // 没有被跳过的版本：不需要勾选，可以直接确认
    await expect(dlg.getByRole('button', { name: '确认标记' })).not.toHaveAttribute('aria-disabled', 'true');
    await dlg.getByRole('button', { name: '确认标记' }).click();
    await expect(dlg).toContainText('已标记：环境当前版本是 v2');
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(page.getByText(/上一次执行停在中途/)).toHaveCount(0);
    // 标记之后当前版本又不在下拉里了
    await expect(page.getByLabel('标记到版本').locator('option')).toHaveText(['v1 v1']);
  } finally {
    await db.drop();
  }
});

test('读回失败提示分流：含非事务步骤迁移执行后读回不一致，提示手工修正与修复脚本 / 标记为已执行（不提示从断点续跑）', async ({
  browser,
}) => {
  const db = await newTargetDb('e2e_readback_split');
  try {
    const page = await instanceAdmin(browser);
    const group = await createGroup(page);
    await createProjectIn(page, '读回失败分流', group.name);
    await addEnv(page, 'dev', db.url, false);
    await publishTable(page, 'orders', 'v1', 1);
    await openEnv(page, 'dev');
    await executeAll(page); // 先执行到 v1

    // 发布 v2（建 customers 表），然后把 v2 冻结脚本改为“空表时建表 + 非事务 VACUUM”并重新验证通过
    await publishTable(page, 'customers', 'v2', 2);
    const projects = (await (await page.request.get('/api/projects')).json()) as {
      id: string;
      name: string;
    }[];
    const pid = projects.find((x) => x.name === '读回失败分流')!.id;
    const versions = (await (await page.request.get(`/api/projects/${pid}/versions`)).json()) as {
      id: string;
      number: number;
    }[];
    const v2Id = versions.find((v) => v.number === 2)!.id;
    const v2Detail = (await (await page.request.get(`/api/projects/${pid}/versions/${v2Id}`)).json()) as {
      upSteps: { sql: string; transactional: boolean }[];
      downSteps: { sql: string; transactional: boolean }[];
    };
    const createSql = v2Detail.upSteps.map((s) => `${s.sql};`).join(' ');
    const patched = await page.request.patch(`/api/projects/${pid}/versions/${v2Id}/steps`, {
      data: {
        up: [
          {
            sql: `DO $$ BEGIN IF (SELECT count(*) FROM public.orders) = 0 THEN ${createSql} END IF; END $$`,
            transactional: true,
          },
          { sql: 'VACUUM "public"."orders"', transactional: false },
        ],
        down: v2Detail.downSteps,
      },
    });
    expect(patched.ok(), await patched.text()).toBe(true);
    // 影子库里 orders 为空，闭环验证通过
    const verified = await page.request.post(`/api/projects/${pid}/versions/${v2Id}/verify`);
    expect(verified.ok(), await verified.text()).toBe(true);
    expect(((await verified.json()) as { verifiedAt: string | null }).verifiedAt).not.toBeNull();

    // 在目标库插入业务数据（不改结构，漂移检查仍通过），使 v2 执行后未建 customers 表，触发读回校验失败
    await db.sql('INSERT INTO public.orders (id) VALUES (1)');

    await openEnv(page, 'dev');
    await page.getByRole('button', { name: '执行迁移' }).click();
    const dlg = execDialog(page);
    await dlg.getByRole('button', { name: '确认执行' }).click();

    // 对话框内提示分流：显示“所有步骤都执行完了但读回的结构不对：继续执行解决不了，需要手工修正目标库”，不显示“从断点接着跑”
    await expect(dlg.getByText('执行失败')).toBeVisible({ timeout: 60_000 });
    await expect(dlg).toContainText(
      '所有步骤都执行完了但读回的结构不对：继续执行解决不了，需要手工修正目标库',
    );
    await expect(dlg).not.toContainText('从断点接着跑');
    await expect(dlg).toContainText('customers');
    await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(dlg).toBeHidden();

    // 环境页提示分流：顶部出现“需要人工修正”红色横幅，引导用修复脚本或「标记为已执行」处理而非盲跑；不出现“上一次执行停在中途”
    await expect(page.getByText('需要人工修正', { exact: true })).toBeVisible();
    await expect(page.getByText(/使用下方修复脚本改回当前版本.*标记为已执行/)).toBeVisible();
    await expect(page.getByText('上一次执行停在中途')).toHaveCount(0);
    // 历史表标出“读回不一致，需要人工修正”
    await expect(page.getByText('读回不一致，需要人工修正')).toBeVisible();
    // 漂移出口可见（修复脚本）且“标记到版本”下拉含当前版本 v1（当前），可通过“标记为停在 v1”结束该状态
    await expect(
      page.getByTestId('drift-exits').getByRole('button', { name: '放弃线上的修改' }),
    ).toBeVisible();
    await page.getByLabel('标记到版本').selectOption({ label: 'v1 v1（当前）' });
    await page.getByRole('button', { name: '标记为停在 v1（放弃未完成的迁移）' }).click();
    const markDlg = page.getByRole('dialog', { name: '标记为停在 v1（放弃未完成的迁移）' });
    await expect(markDlg.getByTestId('mark-plan')).toBeVisible({ timeout: 30_000 });
    await markDlg.getByRole('button', { name: '确认标记' }).click();
    await expect(markDlg).toContainText('已标记：环境当前版本是 v1');
    await markDlg.getByRole('button', { name: '关闭', exact: true }).first().click();
    await expect(page.getByText('需要人工修正', { exact: true })).toHaveCount(0);
  } finally {
    await db.drop();
  }
});
