// 窄屏（S7，视口 900 宽）：侧面板变成抽屉——默认收起，打开后焦点进入抽屉，
// Esc / 点遮罩关闭并把焦点还给“打开侧面板”；属性面板覆盖在内容上。
import { expect, test } from '@playwright/test';

import { createProject, gotoPage, newUser } from './helpers.ts';

const NARROW = { width: 900, height: 900 };

/** 窄屏下对象树默认收在抽屉里，不能用 openModel（它要求侧面板可见）；等同步连上再操作 */
const openModelNarrow = async (page: import('@playwright/test').Page) => {
  await gotoPage(page, '模型');
  await expect(page.getByRole('status').filter({ hasText: '已同步' })).toBeVisible();
};

test('窄屏抽屉：默认收起，打开后焦点进入，Esc / 遮罩关闭后焦点回到按钮', async ({ browser }) => {
  const { page } = await newUser(browser, '窄屏', { viewport: NARROW });
  await createProject(page, '窄屏项目');
  await openModelNarrow(page);

  const objects = page.getByRole('navigation', { name: '对象' });
  await expect(objects).toBeHidden();
  const open = page.getByRole('button', { name: '打开侧面板' });
  await expect(open).toBeVisible();

  await open.click();
  await expect(objects).toBeVisible();
  // 焦点移进了抽屉（落在抽屉里第一个可聚焦元素：关闭按钮）
  await expect(page.getByRole('button', { name: '关闭侧面板' })).toBeFocused();

  // Esc 关闭，焦点回到按钮
  await page.keyboard.press('Escape');
  await expect(objects).toBeHidden();
  await expect(open).toBeFocused();

  // 点遮罩关闭，同样回到按钮
  await open.click();
  await expect(objects).toBeVisible();
  await page.locator('.drawer-backdrop').click({ position: { x: 400, y: 400 } });
  await expect(objects).toBeHidden();
  await expect(open).toBeFocused();

  // 图标栏保持 48px：打开按钮在内容区顶栏，不是抽屉里的
  const rail = await page.getByRole('navigation', { name: '实例与项目' }).boundingBox();
  expect(Math.round(rail!.width)).toBe(48);
});

test('窄屏：属性面板覆盖在内容上，不挤压画布', async ({ browser }) => {
  const { page } = await newUser(browser, '窄屏属性', { viewport: NARROW });
  await createProject(page, '窄屏属性项目');
  await openModelNarrow(page);
  await page.getByRole('button', { name: '新建表' }).click();

  const inspector = page.getByRole('complementary', { name: '属性' });
  await expect(inspector).toBeVisible();
  // 覆盖式：position: fixed（用字符串在页面里求值，测试工程本身不带 DOM 类型）
  const position = await page.evaluate(
    `getComputedStyle(document.querySelector('aside[aria-label="属性"]')).position`,
  );
  expect(position).toBe('fixed');
  const box = await inspector.boundingBox();
  // 贴着右侧边缘（900 宽视口）
  expect(Math.round(box!.x + box!.width)).toBe(900);
  // 画布仍然占满内容区（没有被属性面板挤走）：画布宽度 = 视口 - 图标栏
  const canvas = page.locator('.react-flow');
  const canvasBox = await canvas.boundingBox();
  expect(Math.round(canvasBox!.width)).toBe(900 - 48);
});
