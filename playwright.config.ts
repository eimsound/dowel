import { defineConfig } from '@playwright/test';

// 端到端测试：先构建服务端与前端，再用内存中的 SQLite 平台库启动服务（前端由服务端直接提供）
export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://localhost:4650', viewport: { width: 1440, height: 900 }, locale: 'zh-CN' },
  // 截图对比：关掉动画和光标闪烁，基准图按平台区分（CI 和本地都是 Linux）
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide' } },
  webServer: [
    {
      command: 'pnpm build && node apps/server/dist/main.js',
      url: 'http://localhost:4650/login',
      // DOWEL_ADMIN_* 无人值守初始化主实例的管理员；初始化页本身由 e2e/invites.spec.ts 用独立服务覆盖
      env: {
        PORT: '4650',
        DOWEL_DB: ':memory:',
        DOWEL_SECRET: 'e2e-secret-0123456789',
        DOWEL_ADMIN_USERNAME: 'admin',
        DOWEL_ADMIN_PASSWORD: 'e2e-admin-password',
        // e2e 在一个 IP 上反复登录（每个用例都要新建用户 / 管理员），把登录限速的 IP 总量调大
        DOWEL_LOGIN_IP_LIMIT: '10000',
        // 关掉定时漂移检查：用例里手动点“检查漂移”，不依赖（也不被）1 小时一次的定时任务干扰
        DOWEL_DRIFT_INTERVAL_MINUTES: '0',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // 本地 OIDC 提供方（e2e/oidc-server.ts）：固定返回同一个用户，验证邀请 + OIDC 登录
      command: 'node e2e/oidc-server.ts',
      url: 'http://localhost:4652/.well-known/openid-configuration',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
