// 截图对比：模型页和迁移对话框，亮 / 暗两种配色（DESIGN.md 的视觉回归保护）。
// 基准图在 e2e/visual.spec.ts-snapshots/；界面有意改动时用 `pnpm e2e --update-snapshots` 更新并检查差异。
//
// 另外用 SHOOT_APP=1 跑这个文件时，会把外壳各页面的 1440 宽截图写到 .agents/docs/ui/shots/app-*.png
// （个人设置、后台各页、命令面板、窄屏抽屉等）；这是文档配图，不参与截图对比。
import { expect, test } from '@playwright/test';
import { connectPg } from '../apps/server/src/targets.ts';
import { adminPage, createProject, gotoPage, newUser, openModel } from './helpers.ts';

test.skip(!process.env.DOWEL_TEST_PG, '没有可用的 PostgreSQL（需要 Docker）');

const SHOOT = process.env.SHOOT_APP === '1';

const SCHEMA = `
  create type status as enum ('new', 'paid', 'shipped');
  create table customers (id bigint generated always as identity primary key, email text not null unique, name text);
  create table orders (
    id serial primary key,
    customer_id bigint not null references customers,
    status status not null default 'new',
    total numeric(12,2) check (total >= 0),
    created_at timestamptz not null default now()
  );
  create index on orders (customer_id);
  create view paid_orders as select id, total from orders where status = 'paid';`;

for (const scheme of ['light', 'dark'] as const) {
  test(`界面截图（${scheme === 'light' ? '亮色' : '暗色'}）`, async ({ browser }) => {
    const db = `e2e_visual_${scheme}`;
    const admin = connectPg(process.env.DOWEL_TEST_PG!);
    for (const d of [db, `${db}_dowel`]) await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.db.exec(`CREATE DATABASE ${db}`);
    await admin.close();
    const u = new URL(process.env.DOWEL_TEST_PG!);
    u.pathname = `/${db}`;
    const target = connectPg(u.toString());
    await target.db.exec(SCHEMA);
    await target.close();

    const { page } = await newUser(browser, 'Visual', {
      colorScheme: scheme,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    const projectUrl = await createProject(page, '视觉测试');
    const owner = new URL(projectUrl).pathname.split('/')[2]!;

    // 添加环境并从目标库导入结构
    await gotoPage(page, '环境');
    await page.getByLabel('名字').fill('dev');
    await page.getByLabel('连接串', { exact: true }).fill(u.toString());
    await page.getByLabel('生产环境').uncheck();
    await page.getByRole('button', { name: '添加环境' }).click();
    await page
      .getByRole('navigation', { name: '环境列表' })
      .getByRole('link', { name: 'dev', exact: true })
      .click();
    await page.getByRole('button', { name: '从此库导入结构' }).click();
    await page.getByRole('button', { name: '关闭通知' }).click();

    // 选中 orders、展开 total 列
    await openModel(page);
    await page.getByRole('navigation').getByRole('button', { name: 'orders', exact: true }).click();
    await page.getByRole('button', { name: /^total/ }).click();
    await expect(page.getByLabel('列名 total')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`workspace-${scheme}.png`, { maxDiffPixelRatio: 0.02 });

    // 发布版本、改列名，在影子库验证迁移
    await page.getByRole('button', { name: '发布' }).click();
    await page.getByLabel('版本名').fill('v1');
    await page.getByRole('dialog').getByRole('button', { name: '发布' }).click();
    await page.getByRole('button', { name: '关闭通知' }).click();
    const col = page.getByLabel('列名 total');
    await col.fill('amount');
    await col.press('Enter');
    await page.getByRole('button', { name: '迁移' }).click();
    const mig = page.getByRole('dialog', { name: '迁移' });
    await mig.getByRole('button', { name: '在影子库验证' }).click();
    await expect(mig.getByRole('status')).toContainText('验证通过', { timeout: 60_000 });
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`migration-${scheme}.png`, { maxDiffPixelRatio: 0.02 });
    await page.keyboard.press('Escape');

    // 外壳在概览页的截图（模型页就是上面的 workspace-*.png）
    await gotoPage(page, '概览');
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`overview-${scheme}.png`, { maxDiffPixelRatio: 0.02 });

    // 个人设置和管理后台用固定的 admin 账号截图：页面上的用户名是 'admin'，不会每次都不一样
    const adminView = await adminPage(browser);
    await adminView.setViewportSize({ width: 1440, height: 900 });
    await adminView.emulateMedia({ colorScheme: scheme });
    await adminView.goto('/account');
    await expect(adminView.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
    await adminView.mouse.move(0, 0);
    await expect(adminView).toHaveScreenshot(`account-${scheme}.png`, { maxDiffPixelRatio: 0.02 });

    // 用户列表会随测试进程里的用户增长：搜一个固定的、从未登录过的账号，整行都稳定
    // （最近登录是 “—”；第二次跑时创建会 409，忽略即可）
    const shotUser = { username: 'visual-shot-user', name: '截图用户', password: 'password123' };
    await adminView.request.post('/api/admin/users', { data: shotUser });
    await adminView.goto('/admin');
    await expect(adminView.getByRole('heading', { name: '管理后台', exact: true })).toBeVisible();
    await adminView.getByLabel('搜索用户名、名字或邮箱…').fill(shotUser.username);
    await expect(adminView.getByRole('row', { name: new RegExp(shotUser.username) })).toBeVisible();
    await adminView.mouse.move(0, 0);
    await expect(adminView).toHaveScreenshot(`admin-users-${scheme}.png`, { maxDiffPixelRatio: 0.02 });

    // 窄屏（900 宽）：侧面板是抽屉，默认收起，打开后覆盖在内容上
    await page.setViewportSize({ width: 900, height: 900 });
    await gotoPage(page, '模型');
    await page.getByRole('status').filter({ hasText: '已同步' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '打开侧面板' }).click();
    await expect(page.getByRole('navigation', { name: '对象' })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(page).toHaveScreenshot(`narrow-${scheme}.png`, { maxDiffPixelRatio: 0.02 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await adminView.emulateMedia({ colorScheme: 'light' });

    if (!SHOOT) return;
    // 文档配图：外壳在概览页和模型页各一张（亮 / 暗），亮色再截各个项目页面
    const shot = async (name: string) => {
      await page.mouse.move(0, 0);
      await page.screenshot({ path: `.agents/docs/ui/shots/${name}.png` });
    };
    await shot(`app-overview-${scheme}`);
    await openModel(page);
    await page.getByRole('navigation').getByRole('button', { name: 'orders', exact: true }).click();
    await page.getByRole('button', { name: /^amount/ }).click();
    await shot(`app-model-${scheme}`);
    if (scheme !== 'light') return;

    // 我的项目
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '我的项目' })).toBeVisible();
    await shot('app-projects-light');

    // 新建项目向导四步（P3）：基本信息 / 关联数据库（带检查结果）/ 初始内容 / 确认
    await page.goto('/new');
    await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();
    await page.getByLabel('项目名').fill('向导示例');
    await shot('app-new-basics-light');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '添加数据库' }).click();
    await page.getByRole('textbox', { name: /^名字/ }).fill('dev');
    await page.getByLabel('连接串', { exact: true }).fill(u.toString());
    await page.getByLabel('生产环境').uncheck();
    await page.getByRole('button', { name: '检查连接' }).click();
    await expect(page.getByText('连接正常')).toBeVisible();
    await shot('app-new-database-light');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('radio', { name: /从数据库导入/ }).check();
    await expect(page.getByText('勾选要导入的 schema（默认全选）')).toBeVisible();
    await shot('app-new-content-light');
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByRole('heading', { name: '确认' })).toBeVisible();
    await shot('app-new-confirm-light');

    // 组首页（名称从接口取：createProject 里随机生成）
    const groupInfo = (await (await page.request.get(`/api/groups/${owner}`)).json()) as { name: string };
    await page.goto(`/group/${owner}`);
    await expect(page.getByRole('heading', { name: groupInfo.name, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '组设置' })).toBeVisible();
    await shot('app-group-light');

    // 项目概览
    await page.goto(projectUrl);
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await shot('app-overview-light');

    // 版本详情
    await gotoPage(page, '版本');
    await page.getByRole('link', { name: 'v1' }).click();
    await expect(page.getByRole('heading', { name: '版本详情' })).toBeVisible();
    await shot('app-version-light');

    // 环境详情
    await gotoPage(page, '环境');
    await page
      .getByRole('navigation', { name: '环境列表' })
      .getByRole('link', { name: 'dev', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'dev', exact: true })).toBeVisible();
    await shot('app-environment-light');

    // 成员与授权
    await gotoPage(page, '成员与授权');
    await expect(page.getByRole('heading', { name: '成员与授权' })).toBeVisible();
    await shot('app-members-light');

    // 设置
    await gotoPage(page, '设置');
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await shot('app-settings-light');

    // 个人设置、后台用户页、命令面板（admin 页面用 admin 的浏览器上下文）
    const adminShot = async (name: string) => {
      await adminView.mouse.move(0, 0);
      await adminView.screenshot({ path: `.agents/docs/ui/shots/${name}.png` });
    };
    await adminView.goto('/account');
    await expect(adminView.getByRole('heading', { name: '个人设置', exact: true })).toBeVisible();
    await adminShot('app-settings-account-light');

    await adminView.goto('/admin');
    await expect(adminView.getByRole('heading', { name: '管理后台', exact: true })).toBeVisible();
    await adminShot('app-admin-users-light');

    await adminView.getByRole('link', { name: '登录方式' }).click();
    await expect(adminView.getByRole('heading', { name: '已配置的登录方式' })).toBeVisible();
    // 没有配置过提供方时先加一个本地 mock，文档里才看得到回调地址那一块
    if ((await adminView.getByText('还没有配置任何外部登录方式。').count()) > 0) {
      await adminView.request.post('/api/admin/oidc', {
        data: {
          slug: 'mock-docs',
          name: 'Mock',
          issuer: 'http://localhost:4652',
          clientId: 'e2e-client',
          clientSecret: 'e2e-secret',
        },
      });
      await adminView.reload();
      await expect(adminView.getByText('回调地址').first()).toBeVisible();
    }
    // 回调地址在提供方卡片的底部：滚一点让整块（含说明）都进画面
    await adminView.locator('main').hover();
    await adminView.mouse.wheel(0, 200);
    await expect(adminView.getByText('回调地址').first()).toBeVisible();
    await adminShot('app-admin-oidc-light');

    await adminView.getByRole('link', { name: '审计日志' }).click();
    await expect(adminView.getByRole('heading', { name: '审计日志' })).toBeVisible();
    await expect(adminView.getByRole('table')).toContainText('创建了项目');
    await adminShot('app-admin-audit-light');

    // 命令面板：在项目概览上打开
    await page.goto(projectUrl);
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
    await shot('app-cmdk-light');

    // 窄屏抽屉（900 宽）
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 900, height: 900 });
    await gotoPage(page, '模型');
    await page.getByRole('button', { name: '打开侧面板' }).click();
    await expect(page.getByRole('navigation', { name: '对象' })).toBeVisible();
    await shot('app-narrow-drawer-light');
    await page.setViewportSize({ width: 1440, height: 900 });
  });
}
