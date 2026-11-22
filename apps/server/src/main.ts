// 启动服务：DOWEL_DB（平台数据库：postgres://… 或 SQLite 文件路径，默认 ./data/dowel.db）、PORT（默认 4600）。
// 实例尚无用户时自动创建初始管理员（默认 admin）：提供 DOWEL_ADMIN_PASSWORD_FILE / DOWEL_ADMIN_PASSWORD 则直接启用，
// 否则生成 0600 权限的临时密码文件并要求首次登录后改密。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';

import { DEFAULT_SQLITE_PLATFORM_DB } from './allowlist.ts';
import { createApp } from './app.ts';
import { openPlatformDb } from './db.ts';
import { DEFAULT_DRIFT_INTERVAL_MS } from './drift-scheduler.ts';
import { bootstrapAdmin, type BootstrapAdminResult } from './setup.ts';
import { createShutdown } from './shutdown.ts';

const db = await openPlatformDb(process.env.DOWEL_DB || DEFAULT_SQLITE_PLATFORM_DB);
const port = Number(process.env.PORT ?? 4600);

let bootstrap: BootstrapAdminResult;
try {
  bootstrap = await bootstrapAdmin(db);
} catch (e) {
  console.error(`Dowel 启动失败：${e instanceof Error ? e.message : String(e)}`);
  await db.close();
  process.exit(1);
}

if (bootstrap.created) {
  if (bootstrap.source === 'file') {
    console.log(`已创建实例管理员 ${bootstrap.created.username}（密码来自 DOWEL_ADMIN_PASSWORD_FILE）。`);
  } else if (bootstrap.source === 'env') {
    console.log(`已创建实例管理员 ${bootstrap.created.username}（密码来自 DOWEL_ADMIN_PASSWORD）。`);
  } else if (bootstrap.source === 'generated') {
    console.log(
      `已创建初始实例管理员 ${bootstrap.created.username}，临时密码已写入 ${bootstrap.initialAdminPasswordFile}（首次登录后必须修改密码）。`,
    );
  }
}

const { app, injectWebSocket, wss, bus, ha, rooms, shadows, refresher, drift, exec, requests, webhooks } =
  createApp(db, {
    initialAdminPasswordFile: bootstrap.initialAdminPasswordFile,
    bootstrapUsername: bootstrap.bootstrapUsername,
  });

// 前端构建产物（pnpm build 生成）：静态文件直接返回，其余路径交给前端路由
const web = process.env.DOWEL_WEB ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(web)) {
  app.use('/*', serveStatic({ root: web }));
  // 每次读取：重新构建前端后不用重启服务
  app.get('*', (c) =>
    c.req.path.startsWith('/api/') ? c.notFound() : c.html(readFileSync(`${web}/index.html`, 'utf8')),
  );
}
// HA：先启动副本心跳租约与跨副本事件总线，再恢复申请状态与接受外部流量
await ha.start();
await bus.start();
// 执行申请：先按副本租约恢复已离线节点遗留的“执行中”申请，再开始接受连接；然后按间隔做分布式巡检
await requests.start();
// 组级 Webhook：显式启动后台定时轮询兜底，并立即拾取重启或崩溃遗留的持久化任务
webhooks.start();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Dowel 已启动：http://localhost:${info.port}`);
});
injectWebSocket(server);

// 定时漂移检查：DOWEL_DRIFT_INTERVAL_MINUTES（分钟，默认 60；0 关闭）
const driftMinutes = process.env.DOWEL_DRIFT_INTERVAL_MINUTES;
drift.start(driftMinutes === undefined ? DEFAULT_DRIFT_INTERVAL_MS : Number(driftMinutes) * 60_000);

const stop = createShutdown({
  server,
  wss,
  drift,
  requests,
  refresher,
  locks: exec.locks,
  webhooks,
  rooms,
  shadows,
  bus,
  ha,
  db,
  onExit: (code) => process.exit(code),
});
process.on('SIGINT', () => {
  void stop('SIGINT');
});
process.on('SIGTERM', () => {
  void stop('SIGTERM');
});
