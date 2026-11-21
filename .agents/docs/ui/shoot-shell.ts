// 给侧边栏方案静态稿（mockups/shell.html）截图：node .agents/docs/ui/shoot-shell.ts
// 方案 a / b / c / d × 模型页 / 环境页 × 亮 / 暗 × 1440×900 / 1024×768，另加方案 a 的浮层展开态、
// 四种方案在“属性面板按需 + 未选中”下的模型页（1440 暗色）、方案 d 图标栏的悬停提示；
// 存到 .agents/docs/ui/shots/shell-*.png，并打印每张模型页截图里画布的实际宽度。
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
  const file = join(dir, path === '/' ? 'shell.html' : path);
  if (!file.startsWith(dir)) return void res.writeHead(403).end();
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  createReadStream(file)
    .on('error', () => res.writeHead(404).end())
    .pipe(res);
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/shell.html`;

const sizes = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];
// tag 拼进文件名；only 限定配色和宽度；hover 是截图前悬停的元素
type Shot = {
  shell: string;
  page: string;
  extra?: string;
  tag?: string;
  only?: { scheme: string; width: number };
  hover?: string;
};
const shots: Shot[] = [];
for (const shell of ['a', 'b', 'c', 'd'])
  for (const page of ['model', 'environments']) shots.push({ shell, page });
shots.push({ shell: 'a', page: 'model', extra: '&peek', tag: 'peek' });
// 属性面板按需 + 未选中：画布占满右侧
for (const shell of ['a', 'b', 'c', 'd'])
  shots.push({
    shell,
    page: 'model',
    extra: '&inspector=auto&unselected',
    tag: 'noinsp',
    only: { scheme: 'dark', width: 1440 },
  });
// 方案 d 图标栏的悬停提示
shots.push({
  shell: 'd',
  page: 'model',
  tag: 'tip',
  hover: '.drail .rbtn[data-go=environments]',
  only: { scheme: 'dark', width: 1440 },
});

const widths: string[] = [];
const browser = await chromium.launch();
for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of sizes) {
    const page = await browser.newPage({ viewport, colorScheme: scheme });
    for (const s of shots) {
      if (s.only && (s.only.scheme !== scheme || s.only.width !== viewport.width)) continue;
      await page.goto(`${base}?shell=${s.shell}&page=${s.page}&scheme=${scheme}${s.extra ?? ''}&bare`);
      const w = await page.evaluate(async () => {
        await document.fonts.ready;
        (document.activeElement as HTMLElement | null)?.blur();
        return Math.round(document.getElementById('canvas')!.getBoundingClientRect().width);
      });
      // 鼠标默认在 (0, 0)，会悬停到图标栏上触发浮层；移到画布中间
      await page.mouse.move(viewport.width / 2, viewport.height - 120);
      if (s.hover) await page.hover(s.hover);
      await page.waitForTimeout(50);
      const name = `shell-${s.shell}-${s.page}${s.tag ? `-${s.tag}` : ''}-${scheme}-${viewport.width}.png`;
      await page.screenshot({ path: join(out, name), animations: 'disabled' });
      const counted = !s.tag || s.tag === 'noinsp';
      if (s.page === 'model' && counted && (scheme === 'dark' || !s.only))
        if (s.tag || scheme === 'light')
          widths.push(`方案 ${s.shell} @ ${viewport.width}${s.tag ? '（属性面板隐藏）' : ''}：画布 ${w} px`);
    }
    await page.close();
  }
}
await browser.close();
server.close();
console.log(widths.join('\n'));
console.log(`截图已保存到 ${out}`);
