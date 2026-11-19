// 端到端测试的公共步骤。
// 注册接口已经删除（只接受邀请），用户由实例管理员创建：主实例在启动时用 DOWEL_ADMIN_* 无人值守初始化（见 playwright.config.ts），
// 这里用管理员的浏览器上下文调 /api/admin/users；初始化流程本身由 e2e/invites.spec.ts 用独立的服务实例覆盖。
import { type Browser, type BrowserContextOptions, expect, type Page } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'e2e-admin-password' };
const PASSWORD = 'password123';

let n = 0;
let adminPageRef: Page | undefined;

/** 管理员页面（同一个浏览器上下文，顺带复用它的 cookie 调接口） */
export const adminPage = async (browser: Browser) => {
  if (!adminPageRef) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/login');
    await page.getByLabel('用户名').fill(ADMIN.username);
    await page.getByLabel('密码').fill(ADMIN.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
    adminPageRef = page;
  }
  return adminPageRef;
};

/**
 * 新建一个用户并登录：管理员通过接口建用户，再用用户名 + 密码登录。
 * 返回的 username 用来把用户加进项目（成员按用户名添加）。
 */
export const newUser = async (browser: Browser, name: string, options?: BrowserContextOptions) => {
  // 每个 test 文件在独立的模块上下文里跑，n 会重新开始；加随机后缀避免和别的文件撞用户名
  const username = `user${++n}-${Math.random().toString(36).slice(2, 7)}`;
  const a = await adminPage(browser);
  const res = await a.request.post('/api/admin/users', {
    data: { username, name, password: PASSWORD },
  });
  expect(res.ok(), `创建用户 ${username} 失败：${await res.text()}`).toBe(true);

  const ctx = await browser.newContext(options);
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
  return { page, username };
};

/** 新建一个组（项目列表页的“新建组”对话框）；每个用例用它自己的组，互不影响 */
export const createGroup = async (page: Page, name?: string) => {
  const slug = `g-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const groupName = name ?? `团队 ${Date.now().toString(36)}-${++n}`;
  await page.getByRole('button', { name: '新建组' }).click();
  const dlg = page.getByRole('dialog', { name: '新建组' });
  await dlg.getByLabel('组名').fill(groupName);
  await dlg.getByLabel('标识').fill(slug);
  await dlg.getByRole('button', { name: '创建组' }).click();
  await expect(page.getByRole('heading', { name: groupName })).toBeVisible();
  return { slug, name: groupName };
};

/**
 * 用新建项目向导在指定的组里建一个空白项目（P3）：四步都走一遍，停在概览页。
 * 返回项目地址 /project/:owner/:project。
 */
export const createProjectIn = async (page: Page, name: string, groupName: string) => {
  await page.goto('/new');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
  // 标签里带说明文字的字段用 role + 前缀匹配（可访问名字包含提示文字）
  await page.getByRole('combobox', { name: /^组/ }).selectOption({ label: groupName });
  await page.getByLabel('项目名').fill(name);
  await page.getByRole('button', { name: '下一步' }).click();
  // 第 2 步（关联数据库）跳过：空白项目不需要目标库；第 3 步保持“空白”
  await page.getByRole('button', { name: '跳过' }).click();
  await expect(page.getByRole('heading', { name: /^初始内容/ })).toBeVisible();
  await page.getByRole('button', { name: '下一步' }).click();
  await expect(page.getByRole('heading', { name: /^确认/ })).toBeVisible();
  await page.getByRole('button', { name: '创建项目' }).click();
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  return page.url();
};

/** 新建项目（先建一个组，项目必须属于组）；返回项目地址（停在概览页） */
export const createProject = async (page: Page, name: string) => {
  const group = await createGroup(page);
  return createProjectIn(page, name, group.name);
};

/** 图标栏里的页面入口（当前项目的页面） */
export const gotoPage = async (page: Page, name: string) => {
  await page.getByRole('navigation', { name: '实例与项目' }).getByRole('link', { name }).click();
};

/** 打开模型页（对象树出现说明已经连上工作区） */
export const openModel = async (page: Page) => {
  await gotoPage(page, '模型');
  await expect(page.getByRole('navigation', { name: '对象' })).toBeVisible();
};

/** 在“成员与授权”页面给一个用户加项目级授权（按用户名搜索） */
export const addGrant = async (
  page: Page,
  username: string,
  name: string,
  role: 'viewer' | 'editor' | 'admin',
) => {
  await gotoPage(page, '成员与授权');
  await page.getByLabel('搜索用户或组…').fill(username);
  const hit = page.getByRole('button', { name: new RegExp(name) });
  await expect(hit).toBeVisible();
  await hit.click();
  await page.getByLabel('角色', { exact: true }).selectOption(role);
  await page.getByRole('button', { name: '添加', exact: true }).click();
  // 授权行只有“移除 …”按钮是唯一的（搜索框重置后又会列出所有用户，不能用名字判断）
  await expect(page.getByRole('button', { name: `移除 ${name} 的授权` })).toBeVisible();
};

/** 在输入框里改值并提交（失焦提交） */
export const commit = async (page: Page, label: string | RegExp, value: string) => {
  const input = page.getByLabel(label, { exact: typeof label === 'string' });
  await input.click();
  await input.fill(value);
  await input.press('Enter');
};

/** 新建一个空库并把它添加为项目的环境（非生产，允许同实例影子库） */
export const addEnvironment = async (page: Page, dbName: string) => {
  const { connectPg } = await import('../apps/server/src/targets.ts');
  const admin = connectPg(process.env.DOWEL_TEST_PG!);
  for (const d of [dbName, `${dbName}_dowel`])
    await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  await admin.db.exec(`CREATE DATABASE ${dbName}`);
  await admin.close();
  const u = new URL(process.env.DOWEL_TEST_PG!);
  u.pathname = `/${dbName}`;
  await gotoPage(page, '环境');
  await page.getByLabel('名字').fill('dev');
  await page.getByLabel('连接串', { exact: true }).fill(u.toString());
  await page.getByLabel('生产环境').uncheck();
  await page.getByRole('button', { name: '添加环境' }).click();
  await expect(
    page.getByRole('navigation', { name: '环境列表' }).getByRole('link', { name: 'dev', exact: true }),
  ).toBeVisible();
  return u.toString();
};

/** 进入某个环境的详情页（侧面板或列表里的链接） */
export const openEnvironment = async (page: Page, name: string) => {
  await page.getByRole('navigation', { name: '环境列表' }).getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
};
