import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { Features } from 'lightningcss';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
