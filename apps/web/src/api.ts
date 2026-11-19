// 调用服务端接口。错误统一抛 ApiError，消息来自服务端。
import type { ApiErrorBody } from '@dowel/api';

export class ApiError extends Error {
  status: number;
  /** 服务端返回的完整响应体（发布被拒绝时带着验证报告） */
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** 发请求、读文本、解析 JSON；非 2xx 统一抛 ApiError。api 和 apiText 共用这一段。 */
const request = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await r.text();
  const data = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  })();
  if (!r.ok) throw new ApiError(r.status, (data as ApiErrorBody)?.error ?? r.statusText, data);
  return { text, data };
};

export const api = async <T = unknown>(method: string, path: string, body?: unknown): Promise<T> =>
  (await request(method, path, body)).data as T;

/** 下载只读的文本接口（DDL、迁移脚本）；错误同样抛 ApiError */
export const apiText = async (path: string): Promise<string> => (await request('GET', path)).text;
