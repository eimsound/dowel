// ⌘K / Ctrl+K 命令面板（S6）：打开、搜索项目、回车跳转、Esc 关闭；G 加字母跳项目页面。
// 还有“当前模型里的表”只在模型页可搜，选中后直接在画布上选中它。
import { expect, test } from '@playwright/test';
import { createProject, newUser, openModel } from './helpers.ts';

const palette = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: '命令面板' });

test('⌘K：搜索项目、回车跳转，Esc 关闭，上下键选择', async ({ browser }) => {
  const { page } = await newUser(browser, '命令面板');
  const url = await createProject(page, '命令面板项目');
  // 先离开项目页，才能验证“回车跳转”
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();

  await page.keyboard.press('Control+k');
  const dlg = palette(page);
  await expect(dlg).toBeVisible();
  const input = dlg.getByRole('combobox', { name: '命令面板' });
  await expect(input).toBeFocused();

  await input.fill('命令面板项目');
  const option = dlg.getByRole('option').filter({ hasText: '命令面板项目' });
  await expect(option).toHaveCount(1);
  await input.press('Enter');
  await expect(dlg).toBeHidden();
  await page.waitForURL(url);
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  // 上下键 + 动作：第二个动作是“新建组”。当前在项目页 → 回到我的项目并打开新建组对话框，
  // 意图通过 ?new=group 传过去，页面打开对话框后用 replace 把参数清掉。
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const second = palette(page).getByRole('option').nth(1);
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await palette(page).getByRole('combobox').press('Enter');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('dialog', { name: '新建组' })).toBeVisible();
  await page.getByRole('dialog', { name: '新建组' }).getByRole('button', { name: '取消' }).click();

  // 已经在 / 时也要能打开：重开面板、上下键选“新建组”，对话框直接出现，地址不再带参数
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await palette(page).getByRole('combobox').press('Enter');
  await expect(page.getByRole('dialog', { name: '新建组' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('dialog', { name: '新建组' }).getByRole('button', { name: '取消' }).click();

  // 第一个动作“新建项目”：跳到 /new 向导（P3）
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await palette(page).getByRole('combobox').press('Enter');
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();

  // Esc 关闭
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
});

test('G 加字母跳到项目页面；输入框里不触发', async ({ browser }) => {
  const { page } = await newUser(browser, '快捷键');
  const url = await createProject(page, '快捷键项目');
  const base = url.replace(/\/$/, '');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  const go = async (key: string, path: string, heading: string) => {
    await page.keyboard.press('g');
    await page.keyboard.press(key);
    await page.waitForURL(`${base}${path}`);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  };
  await go('m', '/model', '模型');
  await go('v', '/versions', '版本');
  await go('e', '/environments', '环境');
  await go('a', '/activity', '动态');
  await go('p', '/members', '成员与授权');
  await go('s', '/settings', '设置');
  await go('o', '', '概览');

  // 焦点在输入框里时按 G 不跳转（是在输入文字）
  await page.goto('/new');
  const name = page.getByLabel('项目名');
  await name.click();
  await page.keyboard.press('g');
  await page.keyboard.press('v');
  await expect(name).toHaveValue('gv');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
});

test('⌘K 只在与模型页同一项目时搜表：打开过面板再新建的表也能搜到', async ({ browser }) => {
  const { page } = await newUser(browser, '命令面板搜表');
  await createProject(page, '搜表项目');
  await openModel(page);

  // 先在还没有表的时候打开、关闭面板：面板的列表已经算过一次了
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();

  // 再新建一张表（表清单是可订阅的 store；面板打开时会重新算，见 current-tables.ts）
  await page.getByRole('button', { name: '新建表' }).click();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'table_1' })).toBeVisible();
  // 先取消选中，确认是命令面板把它选回来的
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: '属性' })).toBeHidden();

  await page.keyboard.press('Control+k');
  const dlg = palette(page);
  const input = dlg.getByRole('combobox', { name: '命令面板' });
  await input.fill('table_1');
  await expect(dlg.getByRole('option').filter({ hasText: 'table_1' })).toHaveCount(1);
  await input.press('Enter');
  await expect(dlg).toBeHidden();
  await expect(page.getByRole('complementary', { name: '属性' })).toBeVisible();
  await expect(page.getByLabel('表名')).toHaveValue('table_1');
});
