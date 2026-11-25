// MCP 令牌（M3-C，ADR 0014）：个人设置「MCP 访问」新建 → 一次性展示（不可误关）与客户端配置 → 用令牌调 /api/mcp
// → 列表与吊销；管理后台查看并吊销某个用户的令牌；实例开关“允许 MCP 访问”（亮 / 暗配色）。
import { expect, test } from '@playwright/test';

import { createProject, instanceAdmin, newUser } from './helpers.ts';

const initialize = (token: string) => ({
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  },
  data: {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    },
  },
});

for (const scheme of ['light', 'dark'] as const) {
  test(`MCP 访问：新建、一次性展示、调用 /api/mcp、吊销、管理后台与实例开关（${scheme}）`, async ({
    browser,
  }) => {
    const { page, username } = await newUser(browser, `MCP 用户 ${scheme}`, { colorScheme: scheme });
    await createProject(page, `MCP 项目 ${scheme}`);

    await page.goto('/account/mcp');
    const section = page.getByTestId('account-mcp');
    await expect(section.getByRole('heading', { name: 'MCP 访问' })).toBeVisible();
    await expect(section.getByText('还没有 MCP 令牌')).toBeVisible();

    // 新建：名称必填、只允许指定项目时至少选一个
    await section.getByRole('button', { name: '新建 MCP 令牌' }).click();
    const dlg = page.getByRole('dialog', { name: '新建 MCP 令牌' });
    await expect(dlg.getByRole('checkbox', { name: '读取' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: '读取' })).toBeDisabled();
    await dlg.getByRole('button', { name: '新建令牌' }).click();
    await expect(dlg.getByText('请填写令牌名称')).toBeVisible();
    await dlg.getByLabel('名称').fill('笔记本上的 Claude Code');
    await dlg.getByRole('checkbox', { name: '修改工作副本' }).check();
    await dlg.getByRole('radio', { name: '只允许指定项目' }).check();
    await dlg.getByRole('button', { name: '新建令牌' }).click();
    await expect(dlg.getByText('至少选择一个项目')).toBeVisible();
    await dlg.getByRole('checkbox', { name: new RegExp(`MCP 项目 ${scheme}`) }).check();
    await dlg.getByRole('button', { name: '新建令牌' }).click();

    // 一次性展示：Esc 不能关闭；复制按钮的结果通过 role="status" 播报；配置片段里带令牌
    const reveal = page.getByRole('dialog', { name: 'MCP 令牌已创建' });
    await expect(reveal.getByTestId('mcp-token-reveal')).toBeVisible();
    const token = await reveal.getByLabel('MCP 令牌').inputValue();
    expect(token).toMatch(/^dwm_[A-Za-z0-9_-]{43}$/);
    await expect(reveal.getByLabel('MCP 令牌')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(reveal).toBeVisible();
    await expect(reveal.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0);
    await expect(reveal.getByText(`--scope user dowel`)).toBeVisible();
    await expect(reveal.locator('code').first()).toContainText(token);
    await reveal.getByRole('tab', { name: 'VS Code' }).click();
    await expect(reveal.locator('code').first()).toContainText('"type": "http"');
    await reveal.getByRole('button', { name: '我已保存，关闭' }).click();
    await expect(reveal).toBeHidden();

    // 列表不再显示明文
    const table = section.getByTestId('mcp-token-table');
    await expect(table).toContainText('笔记本上的 Claude Code');
    await expect(table).toContainText(token.slice(0, 12));
    await expect(table).not.toContainText(token);
    await expect(table).toContainText('修改');

    // 令牌能用：/api/mcp initialize 成功（令牌请求不带 cookie）
    const ok = await page.request.post('/api/mcp', initialize(token));
    expect(ok.status()).toBe(200);

    // 实例开关：关闭后个人设置显示提示、新建按钮 aria-disabled，令牌请求 403 mcp_disabled
    const admin = await instanceAdmin(browser, scheme);
    await admin.goto('/admin/settings');
    await admin.getByRole('checkbox', { name: '允许 MCP 访问' }).uncheck();
    await admin.getByRole('button', { name: '保存设置' }).click();
    await expect(admin.getByText('已保存实例设置').first()).toBeVisible();
    await page.reload();
    await expect(section.getByText('实例管理员已关闭 MCP 访问')).toBeVisible();
    await expect(section.getByRole('button', { name: '新建 MCP 令牌' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const off = await page.request.post('/api/mcp', initialize(token));
    expect(off.status()).toBe(403);
    expect((await off.json()).code).toBe('mcp_disabled');
    await admin.getByRole('checkbox', { name: '允许 MCP 访问' }).check();
    await admin.getByRole('button', { name: '保存设置' }).click();
    await expect(admin.getByText('已保存实例设置').first()).toBeVisible();

    // 管理后台：查看该用户的 MCP 令牌并吊销
    await admin.goto('/admin');
    await admin.getByLabel('搜索用户名、名字或邮箱…').fill(username);
    await admin.getByRole('button', { name: `MCP 令牌（${username}）` }).click();
    const adminDlg = admin.getByRole('dialog', { name: new RegExp(`MCP 用户 ${scheme} 的 MCP 令牌`) });
    await expect(adminDlg.getByTestId('mcp-token-table')).toContainText('笔记本上的 Claude Code');
    await adminDlg.getByRole('button', { name: '吊销 MCP 令牌 笔记本上的 Claude Code' }).click();
    const confirm = admin.getByRole('dialog', { name: '吊销 MCP 令牌 笔记本上的 Claude Code？' });
    await confirm.getByRole('button', { name: '吊销令牌' }).click();
    await expect(adminDlg.getByText('管理员吊销')).toBeVisible();
    await adminDlg.getByRole('button', { name: '关闭', exact: true }).last().click();

    // 吊销立即生效
    const revoked = await page.request.post('/api/mcp', initialize(token));
    expect(revoked.status()).toBe(401);
    expect((await revoked.json()).code).toBe('token_revoked');
    await page.reload();
    await expect(table).toContainText('已吊销');
    await expect(table).toContainText('管理员吊销');
  });
}
