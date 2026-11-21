// SSE（text/event-stream）发送：向导和执行进度共用。
// 所有要发给客户端的文本在这里统一过一遍 scrubSecrets（递归处理每个字符串值，不是对整段 JSON 做正则：
// userinfo 的匹配会一路吃到同一行里最后一个 @，JSON 里没有空白，会把别的字段一起吞掉），
// 所以调用方不用、也不该再各自脱敏。客户端断开（写失败）只丢掉后续进度，不影响正在做的事。
import type { SSEStreamingApi } from 'hono/streaming';

import { scrubSecrets } from './secrets.ts';

export const scrubDeep = <T>(v: T): T => {
  if (typeof v === 'string') return scrubSecrets(v) as T;
  if (Array.isArray(v)) return v.map(scrubDeep) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubDeep(x)])) as T;
  return v;
};

export const sseSender = <E>(stream: SSEStreamingApi) => {
  let closed = false;
  return async (e: E) => {
    if (closed) return;
    try {
      await stream.writeSSE({ data: JSON.stringify(scrubDeep(e)) });
    } catch {
      closed = true;
    }
  };
};
