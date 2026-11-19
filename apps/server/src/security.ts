// 请求来源与基础安全：客户端 IP、Origin 校验、安全响应头。
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';

export interface SecurityConfig {
  /** 在可信反向代理后：只在这时读取 X-Forwarded-*，否则客户端可以伪造 */
  trustProxy: boolean;
  /** 对外访问地址（例如 https://dowel.example.com），配置后 Origin 以它为准 */
  publicUrl: string | null;
}

export const securityConfigFromEnv = (): SecurityConfig => {
  const trust = process.env.DOWEL_TRUST_PROXY?.trim().toLowerCase();
  return {
    trustProxy: trust === '1' || trust === 'true',
    publicUrl: process.env.DOWEL_PUBLIC_URL?.trim() || null,
  };
};

const firstHeader = (value: string | undefined): string | null => {
  const first = value?.split(',')[0]?.trim();
  return first || null;
};

/** 反向代理链上离我们最近的代理写的客户端地址是 XFF 最后一个；不可信时完全忽略 XFF */
export const clientIp = (c: Context, config: SecurityConfig): string | null => {
  if (config.trustProxy) {
    const forwarded = c.req
      .header('x-forwarded-for')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const nearest = forwarded?.at(-1);
    if (nearest) return nearest;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    // app.request（单元测试）没有真实连接
    return null;
  }
};

/**
 * 根据配置确定本次请求的“期望源”（协议 + host）；无法确定时返回 null。
 * OIDC 回调地址也用它推导对外地址，保证与 Origin 校验用的是同一套逻辑。
 */
export const expectedOrigin = (c: Context, config: SecurityConfig): string | null => {
  if (config.publicUrl) {
    try {
      return new URL(config.publicUrl).origin;
    } catch {
      return null;
    }
  }
  if (config.trustProxy) {
    const proto = firstHeader(c.req.header('x-forwarded-proto'))?.replace(/:$/, '');
    const host = firstHeader(c.req.header('x-forwarded-host'));
    if (proto && host) {
      try {
        return new URL(`${proto}://${host}`).origin;
      } catch {
        return null;
      }
    }
  }
  const url = new URL(c.req.url);
  const host = c.req.header('host') ?? url.host;
  try {
    return new URL(`${url.protocol}//${host}`).origin;
  } catch {
    return null;
  }
};

/** Origin 与期望来源（协议 + host）相同才算同源；没有 Origin 头时放行（便于 CI 用 curl / 令牌） */
export const sameOrigin = (c: Context, config: SecurityConfig): boolean => {
  const origin = c.req.header('origin');
  if (!origin) return true;
  const expected = expectedOrigin(c, config);
  if (!expected) return false;
  try {
    return new URL(origin).origin.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
};

/** POST / PUT / PATCH / DELETE 的 /api 请求校验 Origin，防 CSRF */
export const mutationOriginGuard =
  (config: SecurityConfig): MiddlewareHandler =>
  async (c, next) => {
    const method = c.req.method;
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      !sameOrigin(c, config)
    )
      throw new HTTPException(403, { message: '请求来源不合法' });
    await next();
  };

/** WebSocket 升级也校验 Origin（浏览器会带上，curl / 令牌客户端可以不带） */
export const wsOriginGuard =
  (config: SecurityConfig): MiddlewareHandler =>
  async (c, next) => {
    if (!sameOrigin(c, config)) throw new HTTPException(403, { message: '请求来源不合法' });
    await next();
  };

/**
 * 前端（apps/web）是 Vite 打包的静态文件：脚本、样式、字体都在本站，样式行内属性由 React / CodeMirror 使用；
 * 图片有 data: URL（CSS 里的下拉箭头）；接口和 WebSocket 用同源地址（CSP3 的 'self' 已包含 ws/wss）。
 */
export const securityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'no-referrer',
  xFrameOptions: 'DENY',
});
