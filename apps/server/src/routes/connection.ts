// 连接检查（P3 向导第 2 步）：建项目之前检查一个连接串能不能用、当前账号有什么权限、有哪些 schema。
// 服务端会替用户去连这个地址（SSRF / 本地路径边界），所以：先校方言与协议、先过实例的
// connection_allowlist / DOWEL_SQLITE_ROOTS、再按用户限速；检查本身只读，不执行任何写语句。
import { connectionCheckSchema, type TargetInfo } from '@dowel/api';
import { hasDialect } from '@dowel/core';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { assertUrlMatchesDialect } from '../allowlist.ts';
import { CHECK_CONNECT_TIMEOUT, hasTargetDriver, inspectTarget } from '../targets.ts';
import { type AppContext, body, connectionLimit, createProjectGroup, type Env } from './context.ts';

export const registerConnection = (app: Hono<Env>, ctx: AppContext) => {
  app.post('/api/connection-check', async (c) => {
    const b = await body(c, connectionCheckSchema);
    if (!hasDialect(b.dialect) || !hasTargetDriver(b.dialect))
      throw new HTTPException(422, { message: `暂不支持方言 ${b.dialect}` });
    assertUrlMatchesDialect(b.url, b.dialect);

    // 和建项目一样的判断（group.create_project）：连接检查是建项目流程的一部分
    await createProjectGroup(c, ctx, b.groupId);
    // 每个用户每分钟 10 次：服务端替用户去连地址，限速避免被当成端口扫描器
    connectionLimit(c, ctx);

    // 白名单在连接层检查（ctx.guard），这里只负责连一次、读回信息
    return c.json<TargetInfo>(await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard, b.dialect));
  });
};
