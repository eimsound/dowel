import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    conditions: ['@dowel/source', 'module', 'browser', 'development|production'],
  },
  ssr: {
    resolve: {
      conditions: ['@dowel/source', 'node', 'development|production'],
    },
  },
  test: {
    // 需要 PG 的测试共用一个实例（Testcontainers 或 DOWEL_TEST_PG），见 test/pg-container.ts
    globalSetup: ['test/global-setup.ts'],
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
