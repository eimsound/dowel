// 个人 MCP 令牌管理接口（M3-C，ADR 0014）：
// - 登录用户本人管理自己的令牌（/api/me/mcp-tokens*，由 routes/index.ts 的 requireUser 保护）；
// - 实例管理员查看和吊销任意用户的令牌（/api/admin/users/:id/mcp-tokens*，由 requireInstanceAdmin('instance.manage_users') 保护）；
// - MCP 令牌自身访问这些接口一律被更前面的 rejectTokens 拒绝（403 forbidden）。
import {
  type AdminMcpTokenList,
  MCP_TOKEN_MAX_ACTIVE_PER_USER,
  type McpRevokeReason,
  type McpTokenCreated,
  mcpTokenCreateSchema,
  type McpTokenInfo,
  type McpTokenList,
  normalizeMcpScopes,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import {
  countActiveMcpTokens,
  listMcpTokens,
  loadMcpToken,
  newMcpToken,
  resolveVisibleMcpProjects,
} from '../mcp-tokens.ts';
import { readSettings } from '../settings.ts';
import { userById } from '../users.ts';
import { type AppContext, body, CodedHTTPException, type Env } from './context.ts';

const publishTokensChanged = async (ctx: AppContext, label: string) => {
  await ctx.bus.publish({ t: 'mcp_tokens.changed' }).catch((e) => {
    console.error(`广播${label}事件失败`, e);
  });
};

const revokeOneMcpToken = async (
  c: Context<Env>,
  ctx: AppContext,
  opts: {
    userId: string;
    tokenId: string;
    actorId: string;
    reason: Extract<McpRevokeReason, 'self' | 'admin'>;
    viewer: { id: string; role: string };
    auditData?: Record<string, unknown>;
  },
): Promise<McpTokenInfo> => {
  const before = await loadMcpToken(ctx.db, opts.userId, opts.tokenId, opts.viewer);
  if (!before) throw new HTTPException(404, { message: '令牌不存在' });
  if (before.status === 'revoked') throw new HTTPException(409, { message: '令牌已经吊销了' });
  const done = await ctx.db.query<{ id: string }>(
    `update mcp_tokens set revoked_at = $3, revoked_by = $4, revoked_reason = $5
      where id = $1 and user_id = $2 and revoked_at is null returning id`,
    [opts.tokenId, opts.userId, new Date().toISOString(), opts.actorId, opts.reason],
  );
  if (!done.length) throw new HTTPException(409, { message: '令牌已经吊销了' });
  ctx.activeMcpTokens.forgetId(opts.tokenId);
  await publishTokensChanged(ctx, 'MCP 令牌吊销');
  await audit(
    ctx.db,
    c,
    {
      action: 'mcp_token.revoke',
      actorKind: 'user',
      actorId: opts.actorId,
      targetKind: 'mcp_token',
      targetId: opts.tokenId,
      data: {
        name: before.name,
        prefix: before.prefix,
        userId: opts.userId,
        reason: opts.reason,
        ...opts.auditData,
      },
    },
    ctx.security,
  );
  return (await loadMcpToken(ctx.db, opts.userId, opts.tokenId, opts.viewer))!;
};

/** 批量吊销提交后的缓存清理、跨副本通知与审计（仅在 count > 0 时广播并写审计） */
export const afterRevokeAllMcpTokens = async (
  c: Context<Env>,
  ctx: AppContext,
  opts: {
    userId: string;
    username: string;
    actorId: string | null;
    reason: Extract<McpRevokeReason, 'user_disabled' | 'password_reset'>;
    count: number;
  },
) => {
  ctx.activeMcpTokens.forgetProject(opts.userId);
  if (opts.count <= 0) return;
  await publishTokensChanged(ctx, 'MCP 令牌批量吊销');
  await audit(
    ctx.db,
    c,
    {
      action: 'mcp_token.revoke_all',
      actorKind: 'user',
      actorId: opts.actorId,
      targetKind: 'user',
      targetId: opts.userId,
      data: { username: opts.username, reason: opts.reason, count: opts.count },
    },
    ctx.security,
  );
};

export const registerMcpTokens = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/me/mcp-tokens', async (c) => {
    const me = c.get('user');
    const [{ allowMcpAccess }, tokens] = await Promise.all([readSettings(db), listMcpTokens(db, me.id, me)]);
    return c.json<McpTokenList>({ tokens, allowed: allowMcpAccess });
  });

  app.post('/api/me/mcp-tokens', async (c) => {
    if (!(await readSettings(db)).allowMcpAccess) {
      throw new CodedHTTPException(403, '实例管理员已关闭 MCP 访问', 'mcp_disabled');
    }
    const me = c.get('user');
    const b = await body(c, mcpTokenCreateSchema);
    const projectIds = b.projectIds === null ? null : [...new Set(b.projectIds)];
    if (projectIds !== null) {
      const visible = await resolveVisibleMcpProjects(db, projectIds, me);
      if (projectIds.some((pid) => !visible.has(pid))) {
        throw new HTTPException(422, { message: '项目白名单中包含不存在或无权访问的项目' });
      }
    }

    const scopes = normalizeMcpScopes(b.scopes);
    const { token, hash, prefix } = newMcpToken();
    const id = newId();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + b.expiresInDays * 86400_000).toISOString();

    await db.transaction(async (tx) => {
      // PG 下锁住当前用户行，将活跃令牌上限校验与插入串行化；SQLite 事务天然串行
      const [u] = await tx.query<{ status: string }>(
        `select status from users where id = $1${db.dialect === 'pg' ? ' for update' : ''}`,
        [me.id],
      );
      if (!u || u.status !== 'active') throw new HTTPException(401, { message: '未登录' });
      if ((await countActiveMcpTokens(tx, me.id, nowIso)) >= MCP_TOKEN_MAX_ACTIVE_PER_USER) {
        throw new CodedHTTPException(
          422,
          `每个账号最多同时持有 ${MCP_TOKEN_MAX_ACTIVE_PER_USER} 个有效 MCP 令牌，请先吊销不再使用的令牌`,
          'mcp_token_limit',
        );
      }
      await tx.query(
        `insert into mcp_tokens
           (id, user_id, kind, name, prefix, token_hash, scopes, project_ids, created_at, expires_at)
         values ($1, $2, 'personal', $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
        [
          id,
          me.id,
          b.name,
          prefix,
          hash,
          JSON.stringify(scopes),
          projectIds === null ? null : JSON.stringify(projectIds),
          nowIso,
          expiresAt,
        ],
      );
    });

    ctx.activeMcpTokens.remember(hash, {
      id,
      projectId: me.id,
      expiresAtMs: Date.parse(expiresAt),
    });
    await publishTokensChanged(ctx, 'MCP 令牌创建');
    await audit(
      db,
      c,
      {
        action: 'mcp_token.create',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'mcp_token',
        targetId: id,
        data: {
          name: b.name,
          prefix,
          scopes,
          projectIds,
          expiresAt,
          expiresInDays: b.expiresInDays,
        },
      },
      ctx.security,
    );
    return c.json<McpTokenCreated>({ token, info: (await loadMcpToken(db, me.id, id, me))! }, 201);
  });

  app.post('/api/me/mcp-tokens/:id/revoke', async (c) => {
    const me = c.get('user');
    return c.json<McpTokenInfo>(
      await revokeOneMcpToken(c, ctx, {
        userId: me.id,
        tokenId: c.req.param('id')!,
        actorId: me.id,
        reason: 'self',
        viewer: me,
      }),
    );
  });

  app.get('/api/admin/users/:id/mcp-tokens', async (c) => {
    const userId = c.req.param('id')!;
    if (!(await userById(db, userId))) throw new HTTPException(404, { message: '用户不存在' });
    return c.json<AdminMcpTokenList>({ tokens: await listMcpTokens(db, userId, c.get('user')) });
  });

  app.post('/api/admin/users/:id/mcp-tokens/:tid/revoke', async (c) => {
    const userId = c.req.param('id')!;
    const tid = c.req.param('tid')!;
    const admin = c.get('user');
    const target = await userById(db, userId);
    if (!target) throw new HTTPException(404, { message: '用户不存在' });
    return c.json<McpTokenInfo>(
      await revokeOneMcpToken(c, ctx, {
        userId,
        tokenId: tid,
        actorId: admin.id,
        reason: 'admin',
        viewer: admin,
        auditData: { username: target.username, byAdmin: true },
      }),
    );
  });
};
