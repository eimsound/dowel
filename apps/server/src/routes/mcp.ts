import {
  MCP_HTTP_ERROR_STATUS,
  MCP_TOKEN_PATTERN,
  type McpHttpErrorBody,
  type McpHttpErrorCode,
} from '@dowel/api';
// MCP 服务（M3-C，ADR 0014）：`POST /api/mcp`，无状态 Streamable HTTP（不建会话、不开 SSE，多副本无需粘性路由）。
// - 只认 `Authorization: Bearer dwm_…`（个人 MCP 令牌）；会话 cookie 一律不读，CI 令牌在更前面的 rejectTokens 里就 403。
// - 认证失败限速与 CI 令牌同一套防误杀做法（pitfalls #8 #9）：缺头 / 格式不对直接在内存里 401，不查库、不扣失败桶；
//   格式合法的令牌按来源 IP 同步预占失败计数，认证成功、主体问题（停用 / 需改密码）或数据库异常时退回；
//   IP 触限时先查活跃 MCP 令牌哈希快照，命中的合法令牌仍然进库强校验，未命中的直接 429。
// - 认证通过后检查实例开关“允许 MCP 访问”，再按令牌 ID 限速，最后把主体挂到 c.get('mcp')。
import { createMcpHandler, isJsonContentType } from '@modelcontextprotocol/server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { hashToken } from '../auth.ts';
import { createMcpServer } from '../mcp-server.ts';
import { authenticateMcpToken, type McpPrincipal } from '../mcp-tokens.ts';
import { scrubSecrets } from '../secrets.ts';
import { clientIp } from '../security.ts';
import { readSettings } from '../settings.ts';
import type { AppContext, Env } from './context.ts';

/** MCP 服务的挂载路径 */
export const MCP_PATH = '/api/mcp';

const MAX_MCP_BODY_BYTES = 1024 * 1024;

const MESSAGES: Record<McpHttpErrorCode, string> = {
  token_missing: '缺少 MCP 令牌：请求头需要 Authorization: Bearer dwm_…',
  token_invalid: 'MCP 令牌无效',
  token_expired: 'MCP 令牌已过期',
  token_revoked: 'MCP 令牌已被吊销',
  user_disabled: '令牌所属的用户已被停用',
  password_change_required: '令牌所属的用户需要先登录并修改密码',
  mcp_disabled: '实例管理员关闭了 MCP 访问',
  forbidden: '没有权限',
  rate_limited: '请求太频繁了',
};

/** /api/mcp 的 HTTP 层错误响应（JSON-RPC 之外）；401 带 WWW-Authenticate */
export const mcpHttpError = (
  c: Context,
  code: McpHttpErrorCode,
  message = MESSAGES[code],
  retryAfter?: number,
) => {
  const status = MCP_HTTP_ERROR_STATUS[code] as ContentfulStatusCode;
  if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="dowel-mcp"');
  if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  return c.json<McpHttpErrorBody>({ error: message, code }, status);
};

/** `/api/mcp` 的令牌认证中间件（见文件头） */
export const mcpAuth =
  (ctx: AppContext): MiddlewareHandler<Env> =>
  async (c, next) => {
    const header = c.req.header('authorization')?.trim();
    if (!header) return mcpHttpError(c, 'token_missing');
    const raw = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
    if (!MCP_TOKEN_PATTERN.test(raw)) return mcpHttpError(c, 'token_invalid');

    const ip = clientIp(c, ctx.security);
    const hash = hashToken(raw);
    const gate = ctx.mcpFailLimiter.attempt(`ip:${ip ?? 'unknown'}`);
    if (!gate.allowed) {
      // 加载失败直接抛给 app.onError（500），不放行
      if (!(await ctx.activeMcpTokens.hasActive(hash)))
        return mcpHttpError(
          c,
          'rate_limited',
          `MCP 令牌认证失败次数太多，请 ${gate.retryAfterSeconds} 秒后再试`,
          gate.retryAfterSeconds,
        );
    }

    let r: Awaited<ReturnType<typeof authenticateMcpToken>>;
    try {
      r = await authenticateMcpToken(ctx.db, raw, ip);
    } catch (e) {
      if (gate.allowed) gate.refund();
      throw e;
    }
    if (!r.ok) {
      // 令牌本身合法、只是主人的状态不允许（停用 / 需改密码）：不算爆破尝试
      if (gate.allowed && (r.code === 'user_disabled' || r.code === 'password_change_required'))
        gate.refund();
      if (r.code !== 'password_change_required') ctx.activeMcpTokens.forgetHash(hash);
      return mcpHttpError(c, r.code);
    }
    if (gate.allowed) gate.refund();
    ctx.activeMcpTokens.remember(hash, {
      id: r.principal.tokenId,
      projectId: r.principal.user.id,
      expiresAtMs: Date.parse(r.principal.expiresAt),
    });
    if (!(await readSettings(ctx.db)).allowMcpAccess) return mcpHttpError(c, 'mcp_disabled');
    const limited = ctx.mcpLimiter.attempt(`mcp:${r.principal.tokenId}`);
    if (!limited.allowed)
      return mcpHttpError(
        c,
        'rate_limited',
        `这个 MCP 令牌的请求太频繁了，请 ${limited.retryAfterSeconds} 秒后再试`,
        limited.retryAfterSeconds,
      );
    c.set('mcp', r.principal);
    await next();
  };

/**
 * 注册 MCP 服务。认证中间件之后由 @modelcontextprotocol/server 的无状态 handler 负责
 * （支持 2026-07-28 与 2025-era 无会话请求：initialize / server/discover / tools/* / resources/* / prompts/* / ping）。
 */
export const registerMcp = (app: Hono<Env>, ctx: AppContext) => {
  const handler = createMcpHandler(
    (reqCtx) => {
      const extra = reqCtx.authInfo?.extra as { principal: McpPrincipal; honoCtx: Context<Env> } | undefined;
      if (!extra) throw new Error('缺少 MCP 认证上下文');
      return createMcpServer(ctx, extra.principal, extra.honoCtx);
    },
    {
      legacy: 'stateless',
      maxRequestBodySize: MAX_MCP_BODY_BYTES,
      onerror: (err) => {
        console.error('MCP 处理错误：', scrubSecrets(err.message));
      },
    },
  );

  app.use(MCP_PATH, mcpAuth(ctx));
  app.all(MCP_PATH, async (c) => {
    if (c.req.method !== 'POST') {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } },
        405,
        { Allow: 'POST' },
      );
    }
    if (!isJsonContentType(c.req.header('content-type'))) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Unsupported Media Type: Content-Type must be application/json' },
        },
        415,
      );
    }
    const contentLength = Number(c.req.header('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES) {
      return c.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Payload Too Large: request body exceeds 1 MiB limit' },
        },
        413,
      );
    }
    const principal = c.get('mcp');
    const response = await handler.fetch(c.req.raw, {
      authInfo: {
        token: principal.tokenId,
        clientId: principal.user.id,
        scopes: [...principal.scopes],
        extra: { principal, honoCtx: c },
      },
    });
    if (response.headers.has('mcp-session-id')) {
      const headers = new Headers(response.headers);
      headers.delete('mcp-session-id');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  });
};
