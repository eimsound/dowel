// 发布 = 冻结迁移（P4a）：没有环境（没有影子库）时可以发布，但版本标为“未验证”；
// 空迁移不能发布；v1 的迁移从空库建出来。不需要 PG，没有 Docker 也能跑。
import { expect, type Page, test } from '@playwright/test';

import { addEnvironment, commit, createProject, gotoPage, newUser, openModel } from './helpers.ts';

test('没有影子库：发布成功但未验证；没有变更不能发布；详情显示冻结的迁移', async ({ browser }) => {
  const { page } = await newUser(browser, '张三');
  await createProject(page, '无环境项目');
  await openModel(page);

  // 工作副本是空的：发布被拒绝，原因显示在对话框里
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v1');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('没有变更');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('首个版本');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  // 没有可用的影子库：已发布，但对话框留着，明确写出原因，用户点关闭才离开
  const done = page.getByRole('dialog');
  await expect(done.getByRole('status')).toContainText('项目还没有配置环境');
  await expect(done.getByRole('status')).toContainText('已发布 v1 首个版本，未验证');
  await done.locator('button.primary', { hasText: '关闭' }).click();
  await expect(done).toBeHidden();

  // 版本页：序号 v1、名称、“未验证”标记
  await gotoPage(page, '版本');
  await expect(page.locator('.chip', { hasText: /^v1$/ })).toBeVisible();
  await expect(page.getByRole('link', { name: '首个版本' })).toBeVisible();
  await expect(page.locator('.risk', { hasText: '未验证' })).toBeVisible();

  // 详情：冻结的升级 / 回滚脚本；没有环境，重新验证给出原因
  await page.getByRole('link', { name: '首个版本' }).click();
  await expect(page.getByRole('heading', { name: '版本详情' })).toBeVisible();
  await expect(page.getByRole('list', { name: '升级脚本' })).toContainText('CREATE TABLE public.orders');
  await page.getByRole('tab', { name: /^回滚/ }).click();
  await expect(page.getByRole('list', { name: '回滚脚本' })).toContainText('DROP TABLE public.orders');
  await page.getByRole('button', { name: '重新验证' }).click();
  await expect(page.getByRole('alert')).toContainText('还没有配置环境');

  // 没有新的修改：再次发布被拒绝
  await openModel(page);
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v2');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('没有变更');
});

test('发布请求还没完成就关了对话框：未验证的结果改用通知提示，并带原因；再打开对话框是干净的', async ({
  browser,
}) => {
  const { page } = await newUser(browser, '王五');
  await createProject(page, '关闭对话框项目');
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  // 让发布请求停在半路，直到用户把对话框关掉
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/projects/*/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('关得太早');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('正在影子库里验证');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  release();

  // 对话框已经关了，横幅没人看：用通知提示未验证和原因
  await expect(page.getByText('已发布 v1 关得太早，未验证：项目还没有配置环境')).toBeVisible();
  // 再打开：干净的表单，没有上次的结果
  await page.getByRole('button', { name: '发布' }).click();
  await expect(page.getByLabel('版本名')).toHaveValue('');
  await expect(page.getByRole('dialog').getByRole('status')).toHaveCount(0);
});

/** 新建一张表，打开发布对话框并提交（请求由调用方的 page.route 控制）；返回已经提交的对话框 */
const submitPublish = async (page: Page, name: string) => {
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('正在影子库里验证');
};

test('发布请求进行中关闭又重新打开：仍显示“正在发布”，按钮保持禁用；完成后在对话框里显示结果', async ({
  browser,
}) => {
  const { page } = await newUser(browser, '赵六');
  await createProject(page, '重新打开项目');
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let posts = 0;
  await page.route('**/api/projects/*/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts++;
    await gate;
    await route.continue();
  });
  await submitPublish(page, '重开');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // 请求还没完成就重新打开：没有被重置，继续显示进行中，按钮禁用、名字不能改，不能重复提交
  await page.getByRole('button', { name: '发布' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('status')).toContainText('正在影子库里验证');
  await expect(dlg.getByRole('button', { name: '发布中…' })).toBeDisabled();
  await expect(dlg.getByLabel('版本名')).toBeDisabled();
  await expect(dlg.getByLabel('版本名')).toHaveValue('重开');
  expect(posts).toBe(1);

  // 请求完成时对话框开着：直接在对话框里显示结果（没有影子库 → 未验证），不弹通知、也没有被关掉
  release();
  await expect(dlg.getByRole('status')).toContainText('已发布 v1 重开，未验证');
  await dlg.locator('button.primary', { hasText: '关闭' }).click();
  await expect(dlg).toBeHidden();
  expect(posts).toBe(1);
});

test('发布请求进行中关了对话框，期间收到验证失败（422）：弹出失败通知，说明验证没有通过；再打开是干净的', async ({
  browser,
}) => {
  const { page } = await newUser(browser, '钱七');
  await createProject(page, '失败通知项目');
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/projects/*/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await gate;
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: '闭环验证没有通过，版本没有发布。请先修正模型',
        report: {
          ok: false,
          up: [],
          down: [],
          upDiff: [],
          downDiff: [],
          risks: [],
          error: { step: null, message: 'type "nosuchtype" does not exist' },
          shadow: 'dev：x_dowel',
        },
      }),
    });
  });
  await submitPublish(page, '会失败');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  release();

  await expect(
    page.getByText('发布没有成功：验证没有通过（type "nosuchtype" does not exist）'),
  ).toBeVisible();
  // 再打开：没有上次的错误和报告
  await page.getByRole('button', { name: '发布' }).click();
  await expect(page.getByLabel('版本名')).toBeEnabled();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByRole('status')).toHaveCount(0);
});

test('已验证但风险分析没有完成：对话框不关，用警告横幅说明；对话框已经关了就改用通知', async ({
  browser,
}) => {
  const { page } = await newUser(browser, '孙八');
  await createProject(page, '风险分析项目');
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await expect(page.getByRole('navigation').getByRole('button', { name: 'orders' })).toBeVisible();

  // 服务端的响应：验证通过，但风险分析没有完成（模拟：真实情况需要影子库里分析出错）
  const created = (n: number) => ({
    id: `mock-${n}`,
    name: '带风险说明',
    seq: n,
    number: n,
    verified: true,
    unverifiedReason: null,
    // riskError 只是原因本身，“风险分析没有完成”由界面的标题 / 模板提供
    riskError: '执行失败：x（分析时出事了）',
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let n = 0;
  await page.route('**/api/projects/*/versions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    n++;
    if (n === 2) await gate;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created(n)) });
  });

  // 对话框开着：不关，横幅说明
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('带风险说明');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  const banner = page.getByRole('dialog').getByRole('status');
  // 标题是“已发布 …，已通过验证”，正文是“风险分析没有完成：原因”，两处不重复
  await expect(banner).toContainText('已发布 v1 带风险说明，已通过验证');
  await expect(banner).toContainText('风险分析没有完成：执行失败：x（分析时出事了）');
  expect(((await banner.textContent()) ?? '').split('风险分析没有完成')).toHaveLength(2);
  await page.getByRole('dialog').locator('button.primary', { hasText: '关闭' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // 请求进行中关掉对话框：通知里是同样的内容
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('带风险说明');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('正在影子库里验证');
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  release();
  await expect(
    page.getByText('已发布 v2 带风险说明，已通过验证；风险分析没有完成：执行失败：x（分析时出事了）'),
  ).toBeVisible();
});

// 需要 PG 作影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts）
test('影子库验证没通过：发布被拒绝，报告显示在发布对话框里，修好之后可以发布', async ({ browser }) => {
  test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');
  const { page } = await newUser(browser, '李四');
  await createProject(page, '验证失败项目');
  await addEnvironment(page, 'e2e_versions_fail');
  await openModel(page);
  await page.getByRole('button', { name: '新建表' }).click();
  await commit(page, '表名', 'orders');
  await page.getByRole('button', { name: '添加列' }).click();
  await commit(page, '列名 column_2', 'total');
  // 数据库里不存在的类型：模型能接受，但在影子库里建不出来
  await commit(page, '类型 total', 'nosuchtype');

  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v1');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByRole('alert')).toContainText('闭环验证没有通过');
  await expect(dlg.getByRole('status')).toContainText('验证失败');
  await expect(dlg.getByRole('status')).toContainText('nosuchtype');
  await dlg.getByRole('button', { name: '取消' }).click();
  await gotoPage(page, '版本');
  await expect(page.getByText('还没有版本')).toBeVisible();

  // 改成合法的类型后可以发布，并且已验证
  await openModel(page);
  await page.getByRole('navigation').getByRole('button', { name: 'orders', exact: true }).click();
  await page.getByRole('button', { name: /^total/ }).click();
  await commit(page, '类型 total', 'numeric(12,2)');
  await page.getByRole('button', { name: '发布' }).click();
  await page.getByLabel('版本名').fill('v1');
  await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
  await expect(page.getByText('已发布 v1 v1，已通过验证')).toBeVisible();
});
