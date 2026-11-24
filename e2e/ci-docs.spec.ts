// CI OpenAPI 与自托管 Scalar 文档页端到端测试：
// - 未登录访问 /api/ci/docs 与 /api/ci/openapi.json 返回 401；
// - 登录后访问 /api/ci/docs，Scalar 正常渲染标题与接口，零 CSP 违规、零控制台报错、零跨源请求。
import { expect, test } from '@playwright/test';

import { newUser } from './helpers.ts';

test('未登录访问 /api/ci/docs 与 /api/ci/openapi.json 返回 401', async ({ request }) => {
  const docsRes = await request.get('/api/ci/docs');
  expect(docsRes.status()).toBe(401);

  const specRes = await request.get('/api/ci/openapi.json');
  expect(specRes.status()).toBe(401);
});

test('登录后访问 /api/ci/docs：Scalar 正确渲染 CI API 文档，零 CSP 违规与外域请求', async ({ browser }) => {
  const { page } = await newUser(browser, 'CI 文档浏览者');
  const pageOrigin = new URL(page.url()).origin;

  const cspViolations: Array<{ violatedDirective: string; blockedURI: string; sourceFile: string }> = [];
  await page.addInitScript(`(() => {
    const list = [];
    window.__cspViolations = list;
    document.addEventListener('securitypolicyviolation', (ev) => {
      list.push({
        violatedDirective: ev.violatedDirective,
        blockedURI: ev.blockedURI,
        sourceFile: ev.sourceFile,
      });
    });
  })()`);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  const assetStatuses = new Map<string, number>();

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (new URL(url).origin !== pageOrigin) externalRequests.push(url);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (url.startsWith(pageOrigin)) {
      assetStatuses.set(new URL(url).pathname, res.status());
    }
  });

  await page.goto('/api/ci/docs');

  // Scalar 渲染文档标题与至少一个接口路径
  await expect(page.getByRole('heading', { name: 'Dowel CI API' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('/api/ci/token').first()).toBeVisible();
  await expect(page.getByText('校验当前 CI 令牌并获取元数据').first()).toBeVisible();

  const recordedViolations = await page.evaluate<typeof cspViolations>('window.__cspViolations ?? []');

  expect(assetStatuses.get('/api/ci/docs')).toBe(200);
  expect(assetStatuses.get('/api/ci/docs/init.js')).toBe(200);
  expect(assetStatuses.get('/vendor/scalar/standalone.js')).toBe(200);
  expect(assetStatuses.get('/api/ci/openapi.json')).toBe(200);

  expect(recordedViolations, `检测到 CSP 违规：${JSON.stringify(recordedViolations)}`).toEqual([]);
  expect(pageErrors, `页面脚本报错：${pageErrors.join('\n')}`).toEqual([]);
  expect(consoleErrors, `控制台 error：${consoleErrors.join('\n')}`).toEqual([]);
  expect(externalRequests, `存在跨源请求：${externalRequests.join(', ')}`).toEqual([]);
});
