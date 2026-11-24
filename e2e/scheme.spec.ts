// 手动配色与系统配色相反时，生产构建里所有 light-dark() token 都要跟着手动选择切换（#81）。
// theme.ts 只在 <html> 上写内联 color-scheme；如果构建把 light-dark() 降级成只跟 @media (prefers-color-scheme)
// 走的 --lightningcss-light / --lightningcss-dark 开关，界面会一直停在系统配色上。
// 其他用例只用 colorScheme 模拟系统配色，覆盖不到这里，所以单独对比：
//   系统配色 X + 手动选 Y  ==  系统配色 Y + 跟随系统
// 涵盖全局表面（body、--surface、--border）和 React Flow 画布、小地图及其遮罩。
import { expect, type Page, test } from '@playwright/test';

import { commit, createProject, newUser, openModel } from './helpers.ts';

type Scheme = 'light' | 'dark';

const LABEL: Record<Scheme | 'auto', string> = { light: '亮色', dark: '暗色', auto: '跟随系统' };

/** 当前页面（模型页）上各处配色的计算值（用字符串在页面里求值，测试工程本身不带 DOM 类型） */
type Snapshot = Record<
  'bodyBackground' | 'bodyText' | 'surface' | 'border' | 'canvas' | 'minimap' | 'minimapMask',
  string
>;
const SNAPSHOT = `(() => {
  const css = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('找不到 ' + sel);
    return getComputedStyle(el);
  };
  // 用临时元素读语义 token 的实际颜色（与组件里 var(--surface) 的解析方式相同：随 <html> 的 color-scheme 继承）
  const token = (name) => {
    const el = document.createElement('div');
    el.style.backgroundColor = 'var(' + name + ')';
    document.body.append(el);
    const c = getComputedStyle(el).backgroundColor;
    el.remove();
    return c;
  };
  return {
    bodyBackground: css('body').backgroundColor,
    bodyText: css('body').color,
    surface: token('--surface'),
    border: token('--border'),
    canvas: css('.react-flow').backgroundColor,
    minimap: css('.react-flow__minimap').backgroundColor,
    minimapMask: css('.react-flow__minimap-mask').fill,
  };
})()`;
const snapshot = (page: Page) => page.evaluate<Snapshot>(SNAPSHOT);

/** 在个人设置 → 偏好里选配色，再整页回到模型页（顺带验证刷新后仍然生效） */
const pickScheme = async (page: Page, modelUrl: string, s: Scheme | 'auto') => {
  await page.goto('/account/preferences');
  const btn = page.getByRole('button', { name: LABEL[s], exact: true });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await page.goto(modelUrl);
  await expect(page.locator('.react-flow__minimap-mask')).toBeAttached();
};

const inlineScheme = (page: Page) => page.evaluate<string>('document.documentElement.style.colorScheme');

for (const [os, manual] of [
  ['dark', 'light'],
  ['light', 'dark'],
] as const satisfies [Scheme, Scheme][]) {
  test(`系统${LABEL[os]}时手动切到${LABEL[manual]}，界面与画布配色都跟着切换`, async ({ browser }) => {
    const { page } = await newUser(browser, `配色 ${os}`, { colorScheme: os });
    await createProject(page, `配色 ${os}`);
    await openModel(page);
    // 画布上要有一张表，小地图才有内容
    await page.getByRole('button', { name: '新建表' }).click();
    await commit(page, '表名', 'orders');
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.locator('.react-flow__minimap-mask')).toBeAttached();
    const modelUrl = page.url();

    // 跟随系统：<html> 上没有内联 color-scheme
    expect(await inlineScheme(page)).toBe('');
    const followOs = await snapshot(page);

    // 手动选与系统相反的配色
    await pickScheme(page, modelUrl, manual);
    expect(await inlineScheme(page)).toBe(manual);
    const manualPicked = await snapshot(page);
    for (const [key, value] of Object.entries(manualPicked)) {
      expect(value, `${key} 应该随手动配色切换`).not.toBe(followOs[key as keyof Snapshot]);
    }

    // 参照：系统就是手动选的配色、界面跟随系统时的值，两者必须完全一致
    await page.emulateMedia({ colorScheme: manual });
    await pickScheme(page, modelUrl, 'auto');
    expect(await inlineScheme(page)).toBe('');
    expect(manualPicked).toEqual(await snapshot(page));
  });
}
