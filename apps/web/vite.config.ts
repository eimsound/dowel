import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
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
  build: { target: 'es2023' },
});
