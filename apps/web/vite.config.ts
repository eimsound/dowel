import { copyFileSync, createReadStream, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { Features } from 'lightningcss';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const SCALAR_VENDOR_PATH = '/vendor/scalar/standalone.js';

/** 自托管 @scalar/api-reference 浏览器独立包，满足 strict CSP（script-src 'self'，零外链 CDN） */
const scalarStandalonePlugin = (): Plugin => {
  // @scalar/api-reference 的 exports 未暴露 ./package.json，经主入口 dist/index.js 定位 dist/browser/standalone.js
  const scalarDistDir = dirname(require.resolve('@scalar/api-reference'));
  const standaloneFile = resolve(scalarDistDir, 'browser/standalone.js');
  let outDir = 'dist';

  return {
    name: 'dowel-scalar-standalone',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0];
        if ((req.method === 'GET' || req.method === 'HEAD') && pathname === SCALAR_VENDOR_PATH) {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          createReadStream(standaloneFile).pipe(res);
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      const targetDir = resolve(options.dir ?? outDir, 'vendor/scalar');
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(standaloneFile, resolve(targetDir, 'standalone.js'));
    },
  };
};

export default defineConfig({
  plugins: [react(), tailwindcss(), scalarStandalonePlugin()],
  resolve: {
    conditions: ['@dowel/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    // 开发时把接口和 WebSocket 转发给 apps/server
    proxy: { '/api': { target: 'http://localhost:4600', ws: true } },
  },
  worker: { format: 'es' },
  // 生产构建的 CSS 压缩（Lightning CSS，按 build.target 推出的浏览器范围）会把 light-dark() 降级成
  // 只跟 @media (prefers-color-scheme) 走的 --lightningcss-light / --lightningcss-dark 开关，
  // theme.ts 写在 <html> 上的手动 color-scheme 就切不动配色了（#81）。保留原生 light-dark()，
  // 与 @tailwindcss/vite 自己调用 Lightning CSS 时的做法一致。
  css: { lightningcss: { exclude: Features.LightDark } },
  build: { target: 'es2023' },
});
