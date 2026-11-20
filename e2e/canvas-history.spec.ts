// 画布修改历史（C4）端到端测试：
// 新建表 / 改列 → 打开画布修改历史 → 验证本次修改 / 当时状态 / 与当前画布的差异 →
// 一键恢复到此状态（二次确认）→ 验证画布恢复且新历史记录追加成功，含亮 / 暗主题与 axe 无障碍扫描。
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { commit, createProject, newUser, openModel } from './helpers.ts';

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
  test(`画布修改历史完整流程与无障碍检查（${scheme}）`, async ({ browser }) => {
    const { page } = await newUser(browser, '历史测试员', { colorScheme: scheme, locale: 'zh-CN' });
    await createProject(page, `画布历史 ${scheme}`);
    await openModel(page);

    // 1. 新建表 orders 并添加列 total，再把 total 重命名为 amount
    await page.getByRole('button', { name: '新建表' }).click();
    await commit(page, '表名', 'orders');
    await expect(
      page.getByRole('navigation', { name: '对象' }).getByRole('button', { name: 'orders' }),
    ).toBeVisible();

    await page.getByRole('button', { name: '添加列' }).click();
    await commit(page, '列名 column_2', 'total');
    await commit(page, '列名 total', 'amount');
    // 等待同步完成
    await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

    // 2. 打开画布修改历史
    await page.getByRole('button', { name: '修改历史' }).click();
    const historyDlg = page.getByRole('dialog', { name: '画布修改历史' });
    await expect(historyDlg).toBeVisible();

    // 时间线可见且最新一条是「重命名列」
    const timeline = historyDlg.getByRole('navigation', { name: '修改时间线' });
    await expect(timeline).toBeVisible();
    await expect(timeline.getByRole('button', { name: /重命名列/ }).first()).toHaveAttribute(
      'aria-current',
      'true',
    );

    // 维度 1：本次修改显示 RENAME COLUMN total TO amount
    await expect(historyDlg.getByRole('tabpanel', { name: '本次修改' })).toContainText(
      'RENAME COLUMN total TO amount',
    );
    await scan(page, `画布修改历史-本次修改（${scheme}）`);

    // 选中更早的一步：把 column_2 改名为 total 的历史点（恢复目标）
    const totalRenameBtn = timeline.getByRole('button', { name: /重命名列.*total/ });
    await totalRenameBtn.click();
    await expect(totalRenameBtn).toHaveAttribute('aria-current', 'true');

    // 维度 2：当时状态（画布 + 表结构 + SQL）
    await historyDlg.getByRole('tab', { name: /当时状态/ }).click();
    const statePanel = historyDlg.getByRole('tabpanel', { name: /当时状态/ });
    await expect(statePanel).toContainText('orders');
    await expect(statePanel).toContainText('total');
    await scan(page, `画布修改历史-当时状态画布（${scheme}）`);

    await statePanel.getByRole('button', { name: '表结构' }).click();
    await expect(statePanel).toContainText('orders');
    await expect(statePanel).toContainText('total');
    await scan(page, `画布修改历史-当时状态表结构（${scheme}）`);

    // 维度 3：与当前画布的差异（把 amount 改回 total）
    await historyDlg.getByRole('tab', { name: /与当前画布的差异/ }).click();
    const diffPanel = historyDlg.getByRole('tabpanel', { name: /与当前画布的差异/ });
    await expect(diffPanel).toContainText('RENAME COLUMN amount TO total');
    await scan(page, `画布修改历史-与当前差异（${scheme}）`);

    // 3. 点击「恢复到此状态」弹出二次确认框
    await historyDlg.getByRole('button', { name: '恢复到此状态' }).click();
    const confirmDlg = page.getByRole('dialog', { name: /恢复画布到 #\d+？/ });
    await expect(confirmDlg).toBeVisible();
    await expect(confirmDlg).toContainText('RENAME COLUMN amount TO total');
    await scan(page, `画布修改历史-恢复确认（${scheme}）`);

    // 确认恢复
    await confirmDlg.getByRole('button', { name: '恢复到此状态' }).click();
    await expect(confirmDlg).toBeHidden();
    await expect(historyDlg).toBeHidden();

    // 4. 验证画布已恢复为 total 列
    await expect(page.locator('.react-flow__node')).toContainText('total');
    await expect(page.locator('.react-flow__node')).not.toContainText('amount');

    // 5. 重新打开修改历史，确认追加了「恢复历史状态」新提交且原历史仍在
    await page.getByRole('button', { name: '修改历史' }).click();
    await expect(historyDlg).toBeVisible();
    await expect(timeline.getByRole('button', { name: /恢复历史状态/ }).first()).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(timeline.getByRole('button', { name: /初始状态/ })).toBeVisible();

    // Esc 可关闭
    await page.keyboard.press('Escape');
    await expect(historyDlg).toBeHidden();
  });
}
