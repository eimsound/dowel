// 画布修改历史（C4 + ADR 0015 §4 编辑会话归组）端到端测试：
// 同一会话连续 5 步手工编辑 → 打开画布修改历史即见编辑会话 #1–#5 与整组净差异 →
// 键盘展开单步明细 → 选中间单步查看本次修改 / 当时状态 / 与当前画布的差异 → 恢复中间单步（独立的「恢复历史状态」记录）→
// 再恢复回组尾 #5，含亮 / 暗主题与 axe 无障碍扫描。
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
  test(`画布修改历史编辑会话归组、单步展开、恢复与无障碍检查（${scheme}）`, async ({ browser }) => {
    const { page } = await newUser(browser, '历史测试员', { colorScheme: scheme, locale: 'zh-CN' });
    await createProject(page, `画布历史 ${scheme}`);
    await openModel(page);

    // 1. 连续 5 步：新建表（createTable + addColumn id）→ 改表名 orders → 添加列 → 把 column_2 改名为 total
    await page.getByRole('button', { name: '新建表' }).click();
    await commit(page, '表名', 'orders');
    await expect(
      page.getByRole('navigation', { name: '对象' }).getByRole('button', { name: 'orders' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '添加列' }).click();
    await commit(page, '列名 column_2', 'total');
    await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();

    // 2. 打开画布修改历史：顶部是编辑会话 #1–#5，默认选中并展示整组净差异
    await page.getByRole('button', { name: '修改历史' }).click();
    const historyDlg = page.getByRole('dialog', { name: '画布修改历史' });
    await expect(historyDlg).toBeVisible();
    const timeline = historyDlg.getByRole('navigation', { name: '修改时间线' });
    const session = timeline.getByRole('button', { name: /^连续编辑.*#1–#5/ });
    await expect(session).toHaveAttribute('aria-current', 'true');
    await expect(timeline.locator('[aria-current="true"]')).toHaveCount(1);

    const opDiffPanel = historyDlg.getByRole('tabpanel', { name: '本次修改' });
    await expect(opDiffPanel).toContainText('#0 → #5 · 5 步净差异');
    await expect(opDiffPanel).toContainText('CREATE TABLE');
    await expect(opDiffPanel).toContainText('total');
    await expect(opDiffPanel).not.toContainText('column_2');
    await expect(opDiffPanel).not.toContainText('table_1');
    await expect(historyDlg.locator('header')).toContainText('#1–#5');
    await expect(historyDlg.locator('header')).toContainText('5 步');
    await scan(page, `画布修改历史-编辑会话净差异（${scheme}）`);

    // 预览选项卡键盘方向键：由 focusgroup / polyfill 单步顺序移动焦点，不跳格
    const opDiffTab = historyDlg.getByRole('tab', { name: /本次修改/ });
    const stateTab = historyDlg.getByRole('tab', { name: /当时状态/ });
    const diffTab = historyDlg.getByRole('tab', { name: /与当前画布的差异/ });
    await opDiffTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(stateTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(diffTab).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(stateTab).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(opDiffTab).toBeFocused();

    // 3. 键盘展开单步明细：主选择按钮 → Tab 到兄弟展开按钮 → Enter
    const toggle = timeline.getByRole('button', { name: '5 步明细 #1–#5' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await session.focus();
    await page.keyboard.press('Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = timeline.getByRole('list', { name: '#1–#5 的单步明细' });
    await expect(steps.getByRole('button')).toHaveCount(5);
    // 倒序：#5 重命名列在最前
    await page.keyboard.press('Tab');
    await expect(steps.getByRole('button').first()).toBeFocused();
    await expect(steps.getByRole('button').first()).toContainText('重命名列');
    await expect(steps.getByRole('button').first()).toContainText('#5');
    await scan(page, `画布修改历史-展开单步明细（${scheme}）`);

    // 4. 选中间单步 #4（新增列 column_2）：组本身不再是当前项，全列表唯一 aria-current
    const step4 = steps.getByRole('button', { name: /新增列.*#4/ });
    await step4.click();
    await expect(step4).toHaveAttribute('aria-current', 'true');
    await expect(session).not.toHaveAttribute('aria-current', 'true');
    await expect(timeline.locator('[aria-current="true"]')).toHaveCount(1);
    await expect(opDiffPanel).toContainText('ADD COLUMN column_2');

    // 收起该组：保留单步选中态，组行带「包含当前选中的步骤」提示
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(session).toHaveAccessibleName(/包含当前选中的步骤/);
    await expect(opDiffPanel).toContainText('ADD COLUMN column_2');
    await toggle.click();
    await expect(step4).toHaveAttribute('aria-current', 'true');

    // 当时状态（画布 + 表结构）
    await stateTab.click();
    const statePanel = historyDlg.getByRole('tabpanel', { name: /当时状态/ });
    await expect(statePanel).toContainText('orders');
    await expect(statePanel).toContainText('column_2');
    await statePanel.getByRole('button', { name: '表结构' }).click();
    await expect(statePanel).toContainText('column_2');
    await scan(page, `画布修改历史-当时状态表结构（${scheme}）`);

    // 与当前画布的差异（把 total 改回 column_2）
    await diffTab.click();
    const diffPanel = historyDlg.getByRole('tabpanel', { name: /与当前画布的差异/ });
    await expect(diffPanel).toContainText('RENAME COLUMN total TO column_2');

    // 5. 恢复到中间单步 #4（二次确认）
    await historyDlg.getByRole('button', { name: '恢复到此状态' }).click();
    const confirmStep = page.getByRole('dialog', { name: '恢复画布到 #4？' });
    await expect(confirmStep).toBeVisible();
    await expect(confirmStep).toContainText('#4（新增列）');
    await expect(confirmStep).toContainText('RENAME COLUMN total TO column_2');
    await scan(page, `画布修改历史-恢复单步确认（${scheme}）`);
    await confirmStep.getByRole('button', { name: '恢复到此状态' }).click();
    await expect(confirmStep).toBeHidden();
    await expect(historyDlg).toBeHidden();
    await expect(page.locator('.react-flow__node')).toContainText('column_2');
    await expect(page.locator('.react-flow__node')).not.toContainText('total');

    // 6. 重新打开：恢复是独立的「恢复历史状态」记录，编辑会话 #1–#5 原样保留
    await page.getByRole('button', { name: '修改历史' }).click();
    await expect(historyDlg).toBeVisible();
    await expect(timeline.getByRole('button', { name: /^恢复历史状态.*#6/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // 重新打开时展开状态已清空
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // 7. 恢复回组尾 #5
    await session.click();
    await expect(session).toHaveAttribute('aria-current', 'true');
    await historyDlg.getByRole('button', { name: '恢复到此状态' }).click();
    const confirmGroup = page.getByRole('dialog', { name: '恢复画布到 #5？' });
    await expect(confirmGroup).toBeVisible();
    await expect(confirmGroup).toContainText('连续编辑 #1–#5 结束时（#5）');
    await expect(confirmGroup).toContainText('RENAME COLUMN column_2 TO total');
    await scan(page, `画布修改历史-恢复编辑会话确认（${scheme}）`);
    await confirmGroup.getByRole('button', { name: '恢复到此状态' }).click();
    await expect(historyDlg).toBeHidden();
    await expect(page.locator('.react-flow__node')).toContainText('total');
    await expect(page.locator('.react-flow__node')).not.toContainText('column_2');

    await page.getByRole('button', { name: '修改历史' }).click();
    await expect(timeline.getByRole('button', { name: /^恢复历史状态.*#7/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(timeline.getByRole('button', { name: /初始状态/ })).toBeVisible();

    // Esc 可关闭
    await page.keyboard.press('Escape');
    await expect(historyDlg).toBeHidden();
  });
}
