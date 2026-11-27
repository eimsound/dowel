// 单条入站消息的大小上限（Issue #150）：超限的请求 / 帧在解析与业务处理之前被拒绝，避免一条超大消息长时间占住事件循环。
// - HTTP：除 MCP 外所有带请求体的请求，默认 16 MiB，超限 413 + { error, code: 'payload_too_large' }（CI 接口用 CiErrorBody 形状）；
// - WebSocket（协作同步）：`ws` 的 maxPayload = MAX_SYNC_MESSAGE_BYTES（16 MiB），超限以 1009 关闭连接；
// - MCP：保持原有 1 MiB（routes/mcp.ts，JSON-RPC 错误体 + 413），不经过这里的 HTTP 上限。
// 上限不开放环境变量：取值来自已有的硬上限（导入 SQL ≤ 500 万字符、剪贴板 ≤ 4 MiB / 粘贴 ≤ 20000 个子操作），
// 调大不会放行更多合法操作；WS 上限还要和前端发送前的自查保持一致，单独调小会让前端的大粘贴被反复断开。
import type { ApiErrorBody } from '@dowel/api';
import { MAX_SYNC_MESSAGE_BYTES } from '@dowel/sync';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { CiError, ciJson } from './routes/ci.ts';
import { MCP_PATH } from './routes/mcp.ts';

/**
 * HTTP 请求体上限（字节）。依据：导入 SQL / 新建项目向导的 SQL 字段上限 500 万字符，
 * 按 JSON 编码后的 UTF-8 计（中文 3 字节 / 字符、换行转义 2 字节）实际最大约 15 MB；冻结脚本整体替换同样落在这个量级内。
 */
export const MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024;

export interface MessageLimits {
  /** HTTP 请求体上限（字节），默认 MAX_HTTP_BODY_BYTES */
  httpBodyBytes: number;
  /** 协作 WebSocket 单条消息上限（字节），默认 MAX_SYNC_MESSAGE_BYTES；需要与前端 SyncClient 的自查一致 */
  wsMessageBytes: number;
}

export const DEFAULT_MESSAGE_LIMITS: MessageLimits = {
  httpBodyBytes: MAX_HTTP_BODY_BYTES,
  wsMessageBytes: MAX_SYNC_MESSAGE_BYTES,
};

export const PAYLOAD_TOO_LARGE_CODE = 'payload_too_large';

const formatBytes = (bytes: number) =>
  bytes >= 1048576 ? `${Math.round((bytes / 1048576) * 10) / 10} MiB` : `${Math.round(bytes / 1024)} KiB`;

/**
 * 请求体上限中间件：有 Content-Length 时只看请求头（不读请求体），分块传输时边读边计数，超限立刻 413。
 * MCP 路径跳过（它有自己更小的上限与 JSON-RPC 错误形状）。
 */
export const httpBodyLimit = (maxBytes: number): MiddlewareHandler => {
  const limit = bodyLimit({
    maxSize: maxBytes,
    onError: (c) => {
      const message = `请求体太大：超过 ${formatBytes(maxBytes)} 上限`;
      if (c.req.path.startsWith('/api/ci/')) return ciJson(c, new CiError(PAYLOAD_TOO_LARGE_CODE, message));
      return c.json<ApiErrorBody>({ error: message, code: PAYLOAD_TOO_LARGE_CODE }, 413);
    },
  });
  return async (c, next) => (c.req.path === MCP_PATH ? next() : limit(c, next));
};
