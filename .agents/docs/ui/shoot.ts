// 给静态稿截图：node .agents/docs/ui/shoot.ts
// 工作区、迁移对话框、组件一览（整页），亮 / 暗两种配色，存到 .agents/docs/ui/shots/。
import { createReadStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const dir = fileURLToPath(new URL('./mockups/', import.meta.url));
const out = fileURLToPath(new URL('./shots/', import.meta.url));
mkdirSync(out, { recursive: true });
const types: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
  const file = join(dir, path === '/' ? 'index.html' : path);
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  createReadStream(file)
    .on('error', () => res.writeHead(404).end())
    .pipe(res);
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

const browser = await chromium.launch();
for (const scheme of ['light', 'dark'] as const) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
  for (const screen of ['workspace', 'migration', 'components']) {
    await page.goto(`${base}?screen=${screen}&bare`);
    await page.evaluate(async () => {
      await document.fonts.ready;
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.screenshot({
      path: join(out, `${screen}-${scheme}.png`),
      fullPage: screen === 'components',
      animations: 'disabled',
    });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`截图已保存到 ${out}`);
