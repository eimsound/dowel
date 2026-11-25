// 组级 Webhook（P5b，E8）：组管理员在组首页新建通用 JSON Webhook（带签名密钥）→ 发送测试 → 界面显示成功、
// 投递记录里有一条 → 本地接收端收到的请求签名正确；编辑时 URL 和密钥不回显（亮 / 暗）。
// 接收端是测试进程里的 HTTP 服务器（127.0.0.1）：默认的出站限制会拒绝回环地址，所以先把 127.0.0.0/8 加进
// 实例设置的 webhookAllowlist，结束后恢复原值。
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, type Page, test } from '@playwright/test';

import { adminPage, createGroup, newUser } from './helpers.ts';

/** SHOOT_APP=1 时把截图写到 .agents/docs/ui/shots/（和 visual.spec.ts 同一个约定） */
const shoot = async (page: Page, name: string) => {
  if (process.env.SHOOT_APP === '1')
    await page.screenshot({ path: `.agents/docs/ui/shots/app-${name}.png`, fullPage: true });
};

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let base = '';
const received: Received[] = [];
let original: string[] | null = null;

test.beforeAll(async ({ browser }) => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const admin = await adminPage(browser);
  const settings = await admin.request.get('/api/admin/settings');
  expect(settings.ok()).toBe(true);
  original = ((await settings.json()) as { webhookAllowlist: string[] }).webhookAllowlist;
  const r = await admin.request.patch('/api/admin/settings', {
    data: { webhookAllowlist: [...original, '127.0.0.0/8'] },
  });
  expect(r.ok(), await r.text()).toBe(true);
});

test.afterAll(async ({ browser }) => {
  if (original) {
    const admin = await adminPage(browser);
    await admin.request.patch('/api/admin/settings', { data: { webhookAllowlist: original } });
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

for (const scheme of ['light', 'dark'] as const) {
  test(`组管理员新建 Webhook、发送测试、查看投递记录，编辑时不回显 URL 和密钥（${scheme}）`, async ({
    browser,
  }) => {
    const { page } = await newUser(browser, '组管理员', { colorScheme: scheme });
    const group = await createGroup(page);
    await page.goto(`/group/${group.slug}`);
    const section = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Webhook', exact: true }),
    });
    await expect(page.getByRole('heading', { name: 'Webhook', exact: true })).toBeVisible();
    await expect(section.getByText('还没有 Webhook')).toBeVisible();

    const name = `通知-${scheme}`;
    const token = `path-token-${scheme}-${Date.now().toString(36)}`;
    const secret = `S3CRET-${scheme}-signing`;
    await section.getByRole('button', { name: '新建 Webhook' }).click();
    const dlg = page.getByRole('dialog', { name: '新建 Webhook' });
    await dlg.getByLabel('名称').fill(name);
    await expect(dlg.getByLabel('格式')).toHaveValue('json');
    await dlg.getByLabel('Webhook 地址').fill(`${base}/hooks/${token}`);
    await dlg.getByLabel(/^签名密钥/).fill(secret);
    await dlg.getByLabel('申请已通过').check();
    await dlg.getByRole('button', { name: '新建 Webhook' }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText(`已新建 Webhook ${name}`)).toBeVisible();

    // 列表：遮蔽的 URL（只有协议和主机）、订阅的事件、还没有投递
    const item = section.getByRole('listitem').filter({ hasText: name });
    await expect(item).toContainText(`${base}/…`);
    await expect(item).toContainText('提交了执行申请、申请已通过');
    await expect(item).toContainText('还没有投递');
    await expect(page.locator('body')).not.toContainText(token);

    // 发送测试：界面显示成功，本地接收端收到签名正确的请求
    const before = received.length;
    await item.getByRole('button', { name: '发送测试' }).click();
    await expect(item.getByRole('status')).toContainText('测试消息已送达：HTTP 200');
    await expect(item).toContainText('成功');
    expect(received.length).toBe(before + 1);
    const got = received.at(-1)!;
    expect(got.path).toBe(`/hooks/${token}`);
    expect(got.headers['x-dowel-event']).toBe('test');
    const ts = got.headers['x-dowel-timestamp'] as string;
    expect(got.headers['x-dowel-signature']).toBe(
      `sha256=${createHmac('sha256', secret).update(`${ts}.${got.body}`).digest('hex')}`,
    );
    const body = JSON.parse(got.body) as { type: string; title: string; text: string };
    expect(body).toMatchObject({ type: 'test', title: 'Dowel Webhook 测试' });
    expect(body.text).toContain(group.name);
    await shoot(page, `webhooks-group-${scheme}`);

    // 投递记录：一条测试投递
    await item.getByRole('button', { name: `${name} 的投递记录` }).click();
    const logs = page.getByRole('dialog', { name: `${name} 的投递记录` });
    const rows = logs.getByRole('row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('测试');
    await expect(rows.nth(1)).toContainText('200');
    await expect(rows.nth(1)).toContainText('成功');
    await logs.getByRole('button', { name: '关闭' }).click();
    await expect(logs).toBeHidden();

    // 编辑：URL 和密钥都不回显（输入框是空的，提示“留空不改”）
    await item.getByRole('button', { name: `编辑 ${name}` }).click();
    const edit = page.getByRole('dialog', { name: `编辑 Webhook ${name}` });
    const url = edit.getByLabel('Webhook 地址');
    await expect(url).toHaveValue('');
    await expect(url).toHaveAttribute('placeholder', `留空不改（当前：${base}/…）`);
    const secretInput = edit.getByLabel(/^签名密钥/);
    await expect(secretInput).toHaveValue('');
    await expect(secretInput).toHaveAttribute('placeholder', '已设置，留空不改');
    await expect(edit.getByLabel('清除签名密钥')).not.toBeChecked();
    const html = await page.content();
    expect(html).not.toContain(token);
    expect(html).not.toContain(secret);
    // 只改名字：保存后 URL 和密钥保留，再发一次测试仍然签名正确
    await edit.getByLabel('名称').fill(`${name}-改`);
    await edit.getByRole('button', { name: '保存 Webhook' }).click();
    await expect(edit).toBeHidden();
    const renamed = section.getByRole('listitem').filter({ hasText: `${name}-改` });
    await renamed.getByRole('button', { name: '发送测试' }).click();
    await expect(renamed.getByRole('status')).toContainText('测试消息已送达');
    const again = received.at(-1)!;
    expect(again.path).toBe(`/hooks/${token}`);
    expect(again.headers['x-dowel-signature']).toBe(
      `sha256=${createHmac('sha256', secret)
        .update(`${again.headers['x-dowel-timestamp'] as string}.${again.body}`)
        .digest('hex')}`,
    );
  });
}
