// 启动服务：DOWEL_DB（平台数据库：postgres://… 或 SQLite 文件路径，默认 ./data/dowel.db）、PORT（默认 4600）。
// 实例里还没有用户时，这里打印一次性初始化令牌（也可以用 DOWEL_ADMIN_USERNAME / DOWEL_ADMIN_PASSWORD 无人值守初始化）。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { openPlatformDb } from './db.ts';
import { DEFAULT_DRIFT_INTERVAL_MS } from './drift-scheduler.ts';
import { autoSetup, ensureSetupToken, needsSetup } from './setup.ts';

const db = await openPlatformDb(process.env.DOWEL_DB || './data/dowel.db');
const { app, injectWebSocket, bus, ha, rooms, shadows, drift, requests, webhooks, setupToken } =
  createApp(db);
const port = Number(process.env.PORT ?? 4600);

// 无人值守初始化：设置了 DOWEL_ADMIN_USERNAME / DOWEL_ADMIN_PASSWORD 并且还没有用户时直接建管理员。
// 这两个值要能登录、也会被记进审计，规则和接口一致；不合法就直接启动失败。
let created = null;
try {
  created = await autoSetup(db);
} catch (e) {
  console.error(`Dowel 启动失败：${e instanceof Error ? e.message : e}`);
  await db.close();
  process.exit(1);
}
if (created) console.log(`已创建实例管理员 ${created.username}（来自 DOWEL_ADMIN_USERNAME）。`);
const needsInit = !created && (await needsSetup(db));
// 多副本同时冷启动时共享持久化在平台库的同一个初始化令牌
const sharedSetupToken = needsInit ? await ensureSetupToken(db, setupToken ?? undefined) : null;

// 前端构建产物（pnpm build 生成）：静态文件直接返回，其余路径交给前端路由
const web = process.env.DOWEL_WEB ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(web)) {
  app.use('/*', serveStatic({ root: web }));
  // 每次读取：重新构建前端后不用重启服务
  app.get('*', (c) =>
    c.req.path.startsWith('/api/') ? c.notFound() : c.html(readFileSync(`${web}/index.html`, 'utf8')),
  );
}
// HA1：先启动跨副本事件总线与副本心跳租约，再恢复申请状态与接受外部流量
await bus.start();
await ha.start();
// 执行申请：先把重启前就在“执行中”的申请记为中断（执行失败），再开始接受连接——之后开始的执行不会被误记（第一轮审查）；
// 然后定时检查过期、失效的申请（单进程部署）
await requests.start();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Dowel 已启动：http://localhost:${info.port}`);
  if (sharedSetupToken)
    console.log(
      `实例还没有用户。打开 http://localhost:${info.port}/setup 初始化，初始化令牌：${sharedSetupToken}`,
    );
});
injectWebSocket(server);

// 定时漂移检查：DOWEL_DRIFT_INTERVAL_MINUTES（分钟，默认 60；0 关闭）
const driftMinutes = process.env.DOWEL_DRIFT_INTERVAL_MINUTES;
drift.start(driftMinutes === undefined ? DEFAULT_DRIFT_INTERVAL_MS : Number(driftMinutes) * 60_000);

const stop = async () => {
  server.close();
  drift.stop();
  requests.stop();
  webhooks.close();
  await rooms.flush();
  await shadows.close();
  await ha.stop();
  await bus.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
