// 链尾版本作废（ADR 0013）：执行到 v2 → 作废 v2（工作副本回退到 v1）→ 基于 v1 发布 v3 →
// 停在已作废 v2 上的环境经最近公共祖先切换（v2 → v1 → v3）→ 把已作废的 v2 应用到画布 →
// 作废 v3 后在还没发布更新版本前取消作废（亮 / 暗两种配色）。
// 需要 PG 作目标库和影子库（Testcontainers 或 DOWEL_TEST_PG，见 e2e/global-setup.ts），没有 Docker 时跳过。
import { expect, type Page, test } from '@playwright/test';

import { addEnv, execDialog, newTargetDb, openEnv, publishTable } from './exec-helpers.ts';
import { createProject, gotoPage, newUser } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

const versionRow = (page: Page, n: number) =>
  page.getByRole('listitem').filter({ has: page.getByRole('link', { name: `v${n}`, exact: true }) });

const openVersion = async (page: Page, n: number) => {
  await gotoPage(page, '版本');
  await page.getByRole('link', { name: `v${n}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: `v${n}`, exact: true })).toBeVisible();
};

const regclass = async (db: Awaited<ReturnType<typeof newTargetDb>>, t: string) =>
  (await db.sql<{ t: string | null }>(`select to_regclass('public.${t}')::text as t`))[0]!.t;

for (const scheme of ['light', 'dark'] as const) {
  test(`作废链尾版本、切换、应用到画布、取消作废（${scheme}）`, async ({ browser }) => {
    test.setTimeout(240_000);
    const db = await newTargetDb('e2e_retire');
    try {
      const { page } = await newUser(browser, `作废者${scheme}`, { colorScheme: scheme });
      await createProject(page, `作废项目${scheme}`);
      await addEnv(page, 'dev', db.url, false);
      await publishTable(page, 'orders', 'v1', 1);
      await publishTable(page, 'customers', 'v2', 2);

      // 执行到 v2
      await openEnv(page, 'dev');
      await page.getByRole('button', { name: '执行迁移' }).click();
      let dlg = execDialog(page);
      await dlg.getByRole('button', { name: '确认执行' }).click();
      await expect(dlg.getByRole('status')).toContainText('环境当前版本是 v2', { timeout: 60_000 });
      await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();

      // 作废 v2：已在 dev 执行过，提示需要项目管理员（项目创建者是管理员），默认回退工作副本到 v1
      await openVersion(page, 2);
      await expect(page.locator('.chip', { hasText: '已执行过' })).toBeVisible();
      await page.getByRole('button', { name: '作废', exact: true }).click();
      dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('heading', { name: '作废 v2' })).toBeVisible();
      await expect(dlg).toContainText('下次发布将是 v3（父版本 v1）');
      await expect(dlg).toContainText('v2 已在环境执行过');
      await expect(dlg.getByRole('radio', { name: /回退到 v1 的模型/ })).toBeChecked();
      await dlg.getByRole('button', { name: '作废 v2' }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByText('已作废 v2，链头现在是 v1')).toBeVisible();
      await expect(page.getByText('这个版本已作废', { exact: true })).toBeVisible();
      // 还没发布更新版本：可以取消作废
      await expect(page.getByRole('button', { name: '取消作废' })).toBeVisible();

      // 版本列表：v2 已作废，v1 是链头；可按状态筛选
      await gotoPage(page, '版本');
      await expect(versionRow(page, 2)).toContainText('已作废');
      await expect(versionRow(page, 1)).toContainText('链头');
      await page.getByRole('radio', { name: '已作废' }).click();
      await expect(page.getByRole('link', { name: 'v1', exact: true })).toHaveCount(0);
      await page.getByRole('radio', { name: '全部' }).click();

      // 工作副本已回退到 v1（customers 不在了）：基于 v1 发布 v3（items）
      await publishTable(page, 'items', 'v3', 3);
      await openVersion(page, 3);
      await expect(page.getByRole('link', { name: 'v1', exact: true })).toBeVisible();
      // 已经基于父版本发布了 v3：v2 不能再取消作废
      await openVersion(page, 2);
      await expect(page.getByText('这一段不能再取消作废')).toBeVisible();
      await expect(page.getByRole('button', { name: '取消作废' })).toHaveCount(0);

      // 环境停在已作废的 v2 上：切换到 v3（先回滚 v2 到 v1，再升级 v3）
      await openEnv(page, 'dev');
      await expect(page.getByText('这个环境停在已作废的版本 v2 上。')).toBeVisible();
      await page.getByRole('button', { name: '切换到 v3' }).click();
      dlg = execDialog(page);
      await expect(dlg.getByRole('heading', { name: /^切换到 v3/ })).toBeVisible();
      await expect(dlg.getByTestId('switch-route')).toContainText('先从 v2 回滚到 v1，再升级到 v3');
      await expect(dlg.getByRole('list', { name: '回滚段（执行回滚脚本）' })).toContainText('v2');
      await expect(dlg.getByRole('list', { name: '升级段' })).toContainText('v3');
      await expect(dlg.getByTestId('dry-run')).toContainText('经最近公共祖先 v1 切换', { timeout: 60_000 });
      // 没勾选回滚确认不能执行
      const confirm = dlg.getByRole('button', { name: '确认切换' });
      await expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await dlg.getByRole('checkbox', { name: /回滚段会执行已作废版本的回滚脚本/ }).check();
      await confirm.click();
      await expect(dlg.getByRole('status')).toContainText('环境当前版本是 v3', { timeout: 60_000 });
      await dlg.getByRole('button', { name: '关闭', exact: true }).first().click();
      expect(await regclass(db, 'customers')).toBeNull();
      expect(await regclass(db, 'items')).toBe('items');
      expect(await regclass(db, 'orders')).toBe('orders');

      // 把已作废的 v2 应用到画布：显示差异，确认后作为新的修改记录
      await openVersion(page, 2);
      await page.getByRole('button', { name: '应用到画布' }).click();
      dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('heading', { name: '将 v2 应用到画布' })).toBeVisible();
      await expect(dlg.getByRole('heading', { name: /工作副本 → v2 的变化/ })).toBeVisible();
      await dlg.getByRole('button', { name: '应用到画布' }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByText('已将 v2 应用到画布')).toBeVisible();

      // 作废 v3（还没发布更新版本）→ 一键取消作废
      await openVersion(page, 3);
      await page.getByRole('button', { name: '作废', exact: true }).click();
      dlg = page.getByRole('dialog');
      await dlg.getByRole('radio', { name: '保留当前工作副本' }).check();
      await dlg.getByRole('button', { name: '作废 v3' }).click();
      await expect(dlg).toBeHidden();
      await page.getByRole('button', { name: '取消作废' }).click();
      dlg = page.getByRole('dialog');
      await expect(dlg.getByRole('heading', { name: '取消作废 v3' })).toBeVisible();
      await dlg.getByRole('button', { name: '取消作废' }).click();
      await expect(dlg).toBeHidden();
      await expect(page.getByText('已取消作废 v3，链头现在是 v3')).toBeVisible();
      await expect(page.getByText('这个版本已作废', { exact: true })).toHaveCount(0);
    } finally {
      await db.drop();
    }
  });
}
