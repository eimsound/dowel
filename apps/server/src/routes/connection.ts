// 连接检查（P3 向导第 2 步）：建项目之前检查一个连接串能不能用、当前账号有什么权限、有哪些 schema。
// 服务端会替用户去连这个地址（SSRF），所以：只允许 postgres:// / postgresql://、先过实例的
// connection_allowlist、再按用户限速；检查本身只读，不执行任何写语句。
import { connectionCheckSchema, type TargetInfo } from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { can, userActor } from '../authz.ts';
import { groupById, groupRoleOf } from '../groups.ts';
import { CHECK_CONNECT_TIMEOUT, inspectTarget } from '../targets.ts';
import { type AppContext, body, type Env } from './context.ts';

export const registerConnection = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.post('/api/connection-check', async (c) => {
    const u = c.get('user');
    const b = await body(c, connectionCheckSchema);

    // 和建项目一样的判断（group.create_project）：连接检查是建项目流程的一部分
    const g = await groupById(db, b.groupId);
    if (!g) throw new HTTPException(404, { message: '组不存在' });
    const groupRole = await groupRoleOf(db, g.id, u.id);
    if (
      !can(userActor(u), 'group.create_project', {
        kind: 'group',
        groupRole,
        projectCreation: g.projectCreation,
      })
    )
      throw new HTTPException(403, { message: '没有在这个组建项目的权限' });

    // 每个用户每分钟 10 次：服务端替用户去连地址，限速避免被当成端口扫描器
    const limit = ctx.connectionLimiter.attempt(u.id);
    if (!limit.allowed) {
      c.header('Retry-After', String(limit.retryAfterSeconds));
      throw new HTTPException(429, {
        message: `检查太频繁了，请 ${limit.retryAfterSeconds} 秒后再试`,
      });
    }

    // 白名单在连接层检查（ctx.guard），这里只负责连一次、读回信息
    return c.json<TargetInfo>(await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard));
  });
};
