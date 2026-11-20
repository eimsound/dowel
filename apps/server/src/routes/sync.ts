// 实时同步：WebSocket 升级时校验 Origin 和项目权限（看不到项目时用 4401 关闭，HTTP 那侧是 404）。
// 连接期间角色可能被改（成员 / 授权 / 默认权限 / 转组 / 删组），由 rooms.refreshLoaded() 发 role 消息或直接断开；
// join 时还会再算一次（升级和 join 之间可能已经变了），成功后总会发一条 role。
import type { Hono } from 'hono';
import { can, userActor } from '../authz.ts';
import { effectiveRole, loadRoleContext, projectRow } from '../roles.ts';
import type { ExtraIn, Peer } from '../rooms.ts';
import type { AppContext, Env } from './context.ts';

export const registerSync = (app: Hono<Env>, ctx: AppContext) => {
  const { rooms, upgradeWebSocket } = ctx;

  app.get(
    '/api/projects/:pid/sync',
    upgradeWebSocket(async (c) => {
      // requireUser 已认证
      const user = c.get('user');
      const pid = c.req.param('pid')!;
      const project = await projectRow(ctx.db, pid);
      const role = project ? effectiveRole(await loadRoleContext(ctx.db, user), project) : null;
      const allowed =
        project !== null && role !== null && can(userActor(user), 'sync.connect', { kind: 'project', role });
      let peer: Peer | null = null;
      let chain: Promise<unknown> = Promise.resolve();
      return {
        onOpen: (_e, ws) => {
          if (!project || !allowed || !role) {
            ws.close(4401, '未登录或没有权限');
            return;
          }
          peer = {
            user,
            role,
            send: (msg) => {
              if (ws.readyState === 1) ws.send(JSON.stringify(msg));
            },
            // 账号被停用、或项目权限被收回时由 rooms 调到这里
            close: (code, reason) => ws.close(code, reason),
          };
          // join 可能因为分支被删掉（项目刚被删除）而失败：记日志并关闭连接，不能留下未处理的 rejection
          chain = rooms.join(project.branch, peer).catch((err) => {
            console.error('加入房间失败', err);
            ws.close(1011, '服务器内部错误');
          });
        },
        onMessage: (e, ws) => {
          if (!peer || !project) return;
          let msg: unknown;
          try {
            msg = JSON.parse(String(e.data));
          } catch {
            return;
          }
          // 同一连接上的消息按到达顺序处理
          const p = peer;
          chain = chain
            .then(() => rooms.message(project.branch, p, msg as never as ExtraIn))
            .catch((err) => {
              console.error(err);
              ws.close(1011, '服务器内部错误');
            });
        },
        onClose: () => {
          if (peer && project) {
            const p = peer;
            chain = chain.then(() => rooms.leave(project.branch, p)).catch(() => {});
          }
        },
      };
    }),
  );
};
