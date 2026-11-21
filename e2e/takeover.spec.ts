// 接手与认领（P4c）：向导里的接手流程、认领确认对话框、环境页的认领、确认对话框里的预演结果，加无障碍扫描。
// “另一个实例”用改目标库里 dowel.projects 的 instance_id 来模拟（e2e 只有一个服务实例）：
// 先在界面上建项目、发布、执行，再删掉项目（目标库里的历史还在），把库里记的认领实例改成“旧实例”，然后走接手向导。
// 需要 PG 作目标库和影子库（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';

import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createGroup, createProjectIn, instanceAdmin } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

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

type Db = Awaited<ReturnType<typeof newTargetDb>>;

/** 在界面上执行到最新版本（非生产环境不需要输入环境名） */
const executeAll = async (page: Page) => {
  await page.getByRole('button', { name: '执行迁移' }).click();
  const dlg = execDialog(page);
  await dlg.getByRole('button', { name: '确认执行' }).click();
  await expect(dlg.getByRole('status')).toContainText('执行完成', { timeout: 60_000 });
  await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
  await expect(dlg).toBeHidden();
};

/**
 * 准备“实例丢了、目标库还在”：用管理员建项目、加环境、发布 v1 v2、执行，然后删掉项目，
 * 并把目标库里记的认领实例改成 old-instance（模拟这个库是另一个实例写的）。
 * 返回目标库、组名和原项目名。
 */
const lostInstance = async (browser: Browser, scheme?: 'light' | 'dark') => {
  const db = await newTargetDb('e2e_takeover');
  const admin = await instanceAdmin(browser, scheme);
  const group = await createGroup(admin);
  const name = `原项目 ${Math.random().toString(36).slice(2, 6)}`;
  await createProjectIn(admin, name, group.name);
  await addEnv(admin, 'dev', db.url, false);
  await publishTable(admin, 'orders', 'v1', 1);
  await publishTable(admin, 'customers', 'v2', 2);
  await openEnv(admin, 'dev');
  await executeAll(admin);
  // 删项目：平台上什么都没了，目标库里的历史还在
  const list = (await (await admin.request.get('/api/projects')).json()) as {
    id: string;
    name: string;
    slug: string;
  }[];
  const p = list.find((x) => x.name === name)!;
  const del = await admin.request.delete(`/api/projects/${p.id}`, { data: { confirm: p.slug } });
  expect(del.ok(), await del.text()).toBe(true);
  await db.sql("update dowel.projects set instance_id = 'old-instance'");
  return { db, admin, group, name, projectId: p.id };
};

/** 向导：基本信息 → 添加数据库 → 选择“接手现有项目”，停在第 3 步（读出了库里的项目） */
const wizardToTakeover = async (
  page: Page,
  groupName: string,
  newName: string,
  db: Db,
  production = false,
) => {
  await page.goto('/new');
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: groupName });
  await page.getByLabel('项目名').fill(newName);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('button', { name: '添加数据库' }).click();
  await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(db.url);
  if (production) await page.getByLabel('生产环境').check();
  else await page.getByLabel('生产环境').uncheck();
  await page.getByLabel('允许在同一实例上建影子库').check();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByRole('radio', { name: /接手现有项目/ }).check();
};

test('接手：读出库里的项目 → 认领确认 → 恢复版本链和环境；预演；认领按钮', async ({ browser }) => {
  const { db, admin: page, group, name } = await lostInstance(browser);
  try {
    await wizardToTakeover(page, group.name, '接手回来的项目', db);
    // 自动读取库里登记过的项目：名字、版本数、当前版本、由另一个实例认领
    const pick = page.getByRole('radio', { name: new RegExp(name) });
    await expect(pick).toBeVisible();
    await expect(page.getByText('2 个版本，最新 v2')).toBeVisible();
    await expect(page.getByText(/由另一个实例认领/).first()).toBeVisible();
    // 没选项目不能下一步
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
    await pick.check();
    await expect(page.getByText(/接手需要认领它/)).toBeVisible();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('会认领这些库里的项目');

    // 创建 → 认领确认对话框说明后果
    await page.getByRole('button', { name: '创建项目' }).click();
    const claim = page.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claim).toBeVisible();
    await expect(claim).toContainText('原实例之后在这个库上执行、回滚会被拒绝');
    await expect(claim).toContainText('漂移检查、读取历史照常可用');
    await expect(claim).toContainText('old-instance');
    // 先取消：什么都没发生，目标库里的认领没变
    await claim.getByRole('button', { name: '取消' }).click();
    await expect(claim).toBeHidden();
    expect((await db.sql<{ i: string }>('select instance_id as i from dowel.projects'))[0]!.i).toBe(
      'old-instance',
    );
    await page.getByRole('button', { name: '创建项目' }).click();
    await claim.getByRole('button', { name: '确认认领并接手' }).click();
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible({ timeout: 60_000 });

    // ADR 0012：接手前经本实例影子库全链验证通过，恢复的版本链 v2、v1 均标“接手恢复”和“已验证”
    await expect(page.locator('.chip', { hasText: /^v2$/ })).toBeVisible();
    await expect(page.locator('.chip', { hasText: '接手恢复' })).toHaveCount(2);
    await expect(page.locator('.risk', { hasText: '已验证' })).toHaveCount(2);
    // 认领写进了目标库：项目行换手、claims 追加一条事件、history 里的执行记录没动
    const [row] = await db.sql<{ i: string; p: string }>(
      'select instance_id as i, previous_instance_id as p from dowel.projects',
    );
    expect(row!.i).not.toBe('old-instance');
    expect(row!.p).toBe('old-instance');
    expect(await db.sql('select 1 from dowel.claims')).toHaveLength(1);

    // 环境页：当前版本 v2、认领是本实例，认领记录里有这一条
    await openEnv(page, 'dev');
    await expect(page.getByTestId('current-version')).toContainText('v2');
    await expect(page.getByTestId('claim-info')).toContainText('本实例');
    await expect(page.getByTestId('claim-info')).toContainText('old-instance');
    await expect(page.getByText('这个库里的项目由另一个实例认领')).toHaveCount(0);

    // 在接手的项目上发布 v3，确认对话框先预演：列出迁移和步骤、通过的检查，什么都没写
    await publishTable(page, 'invoices', 'v3', 3);
    await openEnv(page, 'dev');
    const historyBefore = (await db.sql('select 1 from dowel.history')).length;
    await page.getByRole('button', { name: '执行迁移' }).click();
    const dlg = execDialog(page);
    const dry = dlg.getByTestId('dry-run');
    await expect(dry).toContainText('预演通过', { timeout: 30_000 });
    await expect(dry).toContainText('v3');
    await expect(dry).toContainText('只是预演：没有写目标库');
    await dry.getByText('查看步骤').first().click();
    await expect(dry).toContainText('CREATE TABLE');
    await expect(dry).toContainText('通过的检查');
    // 预演没有写目标库：没有 invoices 表，history 没有新记录
    expect(
      (await db.sql<{ t: string | null }>("select to_regclass('public.invoices')::text as t"))[0]!.t,
    ).toBeNull();
    expect((await db.sql('select 1 from dowel.history')).length).toBe(historyBefore);
    await scan(page, '确认对话框里的预演结果');
    await dlg.getByRole('button', { name: '取消' }).click();
    await expect(dlg).toBeHidden();
    await executeAll(page);
    expect(
      (await db.sql<{ t: string | null }>("select to_regclass('public.invoices')::text as t"))[0]!.t,
    ).toBe('invoices');

    // 库被别的实例认领：环境页横幅 + 预演报告被拒绝的原因；管理员点“认领这个库”
    await db.sql("update dowel.projects set instance_id = 'someone-else'");
    // 读历史、检查漂移按用户限速（每分钟 10 次）：这一段换一个新的实例管理员，不和前面的操作抢额度
    const envUrl = page.url();
    const second = await instanceAdmin(browser);
    await second.goto(envUrl);
    await expect(second.getByText('这个库里的项目由另一个实例认领')).toBeVisible();
    await expect(second.getByTestId('claim-info')).toContainText('someone-else');
    await second.getByRole('button', { name: '回滚迁移' }).click();
    await expect(execDialog(second).getByTestId('dry-error')).toContainText('由另一个 Dowel 实例', {
      timeout: 30_000,
    });
    await execDialog(second).getByRole('button', { name: '取消' }).click();
    await second.getByRole('button', { name: '认领这个库' }).click();
    const claim2 = second.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claim2).toContainText('someone-else');
    await scan(second, '认领确认对话框');
    await claim2.getByRole('button', { name: '确认认领', exact: true }).click();
    await expect(second.getByText('已认领：之后由本实例执行。')).toBeVisible();
    await expect(second.getByText('这个库里的项目由另一个实例认领')).toHaveCount(0);
    expect(await db.sql('select 1 from dowel.claims')).toHaveLength(2);
  } finally {
    await db.drop();
  }
});

test('接手：库里没有历史时有说明，不能继续', async ({ browser }) => {
  const empty = await newTargetDb('e2e_takeover_empty');
  try {
    const page = await instanceAdmin(browser);
    const group = await createGroup(page);
    await wizardToTakeover(page, group.name, '空库接手', empty);
    await expect(page.getByText('这个库里没有 Dowel 的迁移历史。')).toBeVisible();
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  } finally {
    await empty.drop();
  }
});

test('ADR 0012：生产环境接手配置独立影子库 + 接入领先环境（工作副本脏展示差异确认覆盖）', async ({
  browser,
}) => {
  const dev = await newTargetDb('e2e_tk_ahead_dev');
  const prod = await newTargetDb('e2e_tk_ahead_prod');
  const shadow = await newTargetDb('e2e_tk_ahead_shd');
  try {
    const admin = await instanceAdmin(browser);
    const group = await createGroup(admin);
    const origName = `领先原项目 ${Math.random().toString(36).slice(2, 6)}`;
    await createProjectIn(admin, origName, group.name);
    await addEnv(admin, 'dev', dev.url, false);
    await addEnv(admin, 'prod', prod.url, false);
    await publishTable(admin, 'orders', 'v1', 1);
    // dev 执行到 v1
    await openEnv(admin, 'dev');
    await executeAll(admin);
    // 再发布 v2（customers），只执行到 prod（prod 领先 dev 一个版本）
    await publishTable(admin, 'customers', 'v2', 2);
    await openEnv(admin, 'prod');
    await executeAll(admin);

    // 删掉原项目并改认领实例为 old-instance，模拟另一个实例
    const list = (await (await admin.request.get('/api/projects')).json()) as {
      id: string;
      name: string;
      slug: string;
    }[];
    const p = list.find((x) => x.name === origName)!;
    expect((await admin.request.delete(`/api/projects/${p.id}`, { data: { confirm: p.slug } })).ok()).toBe(
      true,
    );
    await dev.sql("update dowel.projects set instance_id = 'old-instance'");
    await prod.sql("update dowel.projects set instance_id = 'old-instance'");

    // ① 接手 dev（设为生产环境、未勾选允许同实例，在第 3 步“接手现有项目”的影子库配置中填写独立影子库）
    const page = await instanceAdmin(browser);
    await page.goto('/new');
    await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group.name });
    await page.getByLabel('项目名').fill('接手并接入领先');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '添加数据库' }).click();
    await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
    await page.getByLabel('连接串', { exact: true }).fill(dev.url);
    await page.getByLabel('生产环境').check();
    await page.getByLabel('允许在同一实例上建影子库').uncheck();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('radio', { name: /接手现有项目/ }).check();
    await expect(page.getByText(/当前所有环境均为生产环境且未配置可用影子库/)).toBeVisible();
    await page.getByRole('radio', { name: new RegExp(origName) }).check();
    // 在接手面板里填写独立影子库连接串，警告消失
    await page.getByLabel(/单独的影子库连接串/).fill(shadow.url);
    await expect(page.getByText(/当前所有环境均为生产环境且未配置可用影子库/)).toHaveCount(0);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '创建项目' }).click();
    const claim = page.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claim).toBeVisible();
    await claim.getByRole('button', { name: '确认认领并接手' }).click();
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.risk', { hasText: '已验证' })).toHaveCount(1);

    // ② 在画布中新建一张未发布表（使工作副本相对 v1 变脏）
    await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
    await expect(page.getByRole('navigation', { name: '对象' })).toBeVisible();
    await page.getByRole('button', { name: '新建表' }).click();
    await page.getByLabel('表名').fill('draft_table');
    await page.getByLabel('表名').press('Enter');
    await expect(
      page.getByRole('navigation').getByRole('button', { name: 'draft_table', exact: true }),
    ).toBeVisible();

    // ③ 在环境页添加并接入领先的 prod（v2）→ 先认领确认 → 再弹出覆盖工作副本差异确认对话框
    const page2 = await instanceAdmin(browser);
    await page2.goto(page.url().replace(/\/model.*$/, '/environments'));
    await page2.getByLabel('名字').fill('prod');
    await page2.getByLabel('连接串', { exact: true }).fill(prod.url);
    await page2.getByLabel('生产环境').uncheck();
    await page2.getByLabel('允许在同一实例上建影子库').check();
    await page2.getByLabel(/已经有这个项目的迁移历史/).check();
    await page2.getByRole('button', { name: '添加环境' }).click();

    const claimDlg = page2.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claimDlg).toBeVisible();
    await claimDlg.getByRole('button', { name: '确认认领', exact: true }).click();

    const overwriteDlg = page2.getByRole('dialog', { name: '确认覆盖工作副本并接入领先环境' });
    await expect(overwriteDlg).toBeVisible({ timeout: 60_000 });
    await expect(overwriteDlg).toContainText('v2 · v2');
    await expect(overwriteDlg).toContainText('customers');
    await expect(overwriteDlg).toContainText('draft_table');
    await overwriteDlg.getByRole('button', { name: '确认覆盖并接入' }).click();
    await expect(overwriteDlg).toBeHidden({ timeout: 60_000 });
    await expect(page2.getByText(/已接入 prod：补齐 1 个领先版本/)).toBeVisible();

    // 回到模型页：工作副本已覆盖到新链头 v2（有 customers，不再有未发布的 draft_table）
    await page2.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name: '模型' }).click();
    await expect(
      page2.getByRole('navigation').getByRole('button', { name: 'customers', exact: true }),
    ).toBeVisible();
    await expect(
      page2.getByRole('navigation').getByRole('button', { name: 'draft_table', exact: true }),
    ).toHaveCount(0);
  } finally {
    await Promise.all([dev.drop(), prod.drop(), shadow.drop()]);
  }
});

test('接手：修改/增删环境与切组精确失效并自动补读，同名环境按 key 匹配', async ({ browser }) => {
  const { db, admin, group, name } = await lostInstance(browser);
  const empty = await newTargetDb('e2e_tk_cache_empty');
  try {
    // 准备第二个组，用于验证切组重置接手状态并重读
    await admin.goto('/');
    const group2 = await createGroup(admin);
    const page = await instanceAdmin(browser);

    await wizardToTakeover(page, group.name, '缓存失效回归', empty);
    await expect(page.getByText('这个库里没有 Dowel 的迁移历史。')).toBeVisible();

    // 修改环境连接串：缓存精确失效，回到第 2 步自动重读新库（无需点“重新读取”）
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByLabel('连接串', { exact: true }).fill(db.url);
    await page.getByRole('button', { name: '下一步' }).click();
    const pick = page.getByRole('radio', { name: new RegExp(name) });
    await expect(pick).toBeVisible();
    await pick.check();
    await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled();

    // 新增一个同名环境（同样叫 dev，但指向空库）：自动补读且按 e.key 判缺失，不会被同名误判掩盖
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByRole('button', { name: '添加数据库' }).click();
    await page.getByRole('textbox', { name: /^名字/ }).nth(1).fill('dev');
    await page.getByLabel('连接串', { exact: true }).nth(1).fill(empty.url);
    await page.getByLabel('生产环境').nth(1).uncheck();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByText('环境“dev”的库里没有这个项目的历史')).toBeVisible();
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();

    // 删除新增环境：同步清理该环境缓存，缺失提示消失并恢复可下一步
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByRole('button', { name: '移除 dev' }).nth(1).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByText('环境“dev”的库里没有这个项目的历史')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '下一步' })).toBeEnabled();

    // 切组：清空 takeReads 与 takeProject，再进第 2 步自动重读且已选项目被清空
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByRole('button', { name: '上一步' }).click();
    await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: group2.name });
    await page.getByRole('button', { name: '下一步' }).click();
    const reread = page.waitForResponse(
      (r) => r.url().includes('/api/takeover/inspect') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '下一步' }).click();
    await reread;
    const pickAfterGroup = page.getByRole('radio', { name: new RegExp(name) });
    await expect(pickAfterGroup).toBeVisible();
    await expect(pickAfterGroup).not.toBeChecked();
    await expect(page.getByRole('button', { name: '下一步' })).toBeDisabled();
  } finally {
    await Promise.all([db.drop(), empty.drop()]);
  }
});

test('接手：第 3 步遇 SSE claim_required（TOCTOU）弹出认领确认框并带 claim 成功认领', async ({ browser }) => {
  const db = await newTargetDb('e2e_tk_toctou');
  try {
    const admin = await instanceAdmin(browser);
    const group = await createGroup(admin);
    const origName = `TOCTOU 原项目 ${Math.random().toString(36).slice(2, 6)}`;
    await createProjectIn(admin, origName, group.name);
    await addEnv(admin, 'dev', db.url, false);
    await publishTable(admin, 'orders', 'v1', 1);
    await openEnv(admin, 'dev');
    await executeAll(admin);
    // 删除项目，但保持目标库的 instance_id 为本实例（inspect 时 mine=true、takeClaim=null）
    const list = (await (await admin.request.get('/api/projects')).json()) as {
      id: string;
      name: string;
      slug: string;
    }[];
    const p = list.find((x) => x.name === origName)!;
    expect((await admin.request.delete(`/api/projects/${p.id}`, { data: { confirm: p.slug } })).ok()).toBe(
      true,
    );

    const page = await instanceAdmin(browser);
    await wizardToTakeover(page, group.name, 'TOCTOU 接手项目', db);
    const pick = page.getByRole('radio', { name: new RegExp(origName) });
    await expect(pick).toBeVisible();
    await expect(page.getByText('本实例认领')).toBeVisible();
    await pick.check();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('会认领这些库里的项目');

    // 提交前目标库被另一实例认领：触发服务端 SSE code=claim_required
    await db.sql("update dowel.projects set instance_id = 'late-other-instance'");
    await page.getByRole('button', { name: '创建项目' }).click();
    const claim = page.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claim).toBeVisible();
    await expect(page.getByText('创建失败')).toHaveCount(0);

    // 确认认领：即便 takeClaim 为 null 也应携带 claim: true 完成接手并认领目标库
    await claim.getByRole('button', { name: '确认认领并接手' }).click();
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible({ timeout: 60_000 });
    const [row] = await db.sql<{ i: string; p: string }>(
      'select instance_id as i, previous_instance_id as p from dowel.projects',
    );
    expect(row!.i).not.toBe('late-other-instance');
    expect(row!.p).toBe('late-other-instance');
  } finally {
    await db.drop();
  }
});

test('接手：带 warnings 创建成功后停留在第 3 步并禁用「上一步」', async ({ browser }) => {
  const { db, group, name } = await lostInstance(browser);
  try {
    const page = await instanceAdmin(browser);
    await wizardToTakeover(page, group.name, '带警告接手项目', db);
    await page.getByRole('radio', { name: new RegExp(name) }).check();
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();

    // 转发真实创建请求，为最终 done 事件附带一条 warning（稳定覆盖带 warnings 的前端状态机）
    await page.route('**/api/projects/wizard', async (route) => {
      const response = await route.fetch();
      const raw = await response.text();
      const patched = raw
        .split('\n\n')
        .map((frame) => {
          if (!frame.startsWith('data: ')) return frame;
          const payload = JSON.parse(frame.slice(6)) as { stage?: string; warnings?: string[] };
          if (payload.stage === 'done') {
            payload.warnings = ['环境“dev”认领失败：模拟网络波动，项目已经建好，可以在环境页重试认领'];
          }
          return `data: ${JSON.stringify(payload)}`;
        })
        .join('\n\n');
      await route.fulfill({ response, body: patched });
    });

    await page.getByRole('button', { name: '创建项目' }).click();
    const claim = page.getByRole('dialog', { name: '认领这个项目？' });
    await expect(claim).toBeVisible();
    await claim.getByRole('button', { name: '确认认领并接手' }).click();

    await expect(page.getByText('项目已经建好，但有没做完的事')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/模拟网络波动/)).toBeVisible();
    await expect(page.getByRole('button', { name: '上一步' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '创建项目' })).toBeDisabled();

    await page.getByRole('button', { name: '进入项目' }).click();
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  } finally {
    await db.drop();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`无障碍（${scheme}）：接手向导选项目、认领确认、环境页的认领横幅`, async ({ browser }) => {
    const { db, admin: page, group, name } = await lostInstance(browser, scheme);
    try {
      await wizardToTakeover(page, group.name, '无障碍接手', db);
      await expect(page.getByRole('radio', { name: new RegExp(name) })).toBeVisible();
      await page.getByRole('radio', { name: new RegExp(name) }).check();
      await scan(page, '接手向导：选择项目');
      await page.getByRole('button', { name: '下一步' }).click();
      await page.getByRole('button', { name: '创建项目' }).click();
      const claim = page.getByRole('dialog', { name: '认领这个项目？' });
      await expect(claim).toBeVisible();
      await scan(page, '接手向导：认领确认');
      await claim.getByRole('button', { name: '确认认领并接手' }).click();
      await expect(page.getByRole('heading', { name: '概览' })).toBeVisible({ timeout: 60_000 });
      await scan(page, '接手之后的项目概览（接手恢复标记）');
      await openEnv(page, 'dev');
      await db.sql("update dowel.projects set instance_id = 'someone-else'");
      await page.reload();
      await expect(page.getByText('这个库里的项目由另一个实例认领')).toBeVisible();
      await scan(page, '环境页：认领横幅和认领记录');
    } finally {
      await db.drop();
    }
  });
}
