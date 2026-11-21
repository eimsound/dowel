// 脱敏收口（P4a 遗留）：错误响应的出口（全局 onError 的每个分支）和 SSE 的 send 统一过 scrubSecrets，
// 往下游抛错的地方不用各自脱敏。这里验证两个出口本身。
import { PlanError } from '@dowel/core';
import { HTTPException } from 'hono/http-exception';
import type { SSEStreamingApi } from 'hono/streaming';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb, ShadowError } from '../src/index.ts';
import { SecretError } from '../src/secrets.ts';
import { scrubDeep, sseSender } from '../src/sse.ts';

process.env.DOWEL_SECRET ??= 'scrub-test-secret-0123456789';

const LEAK = 'could not connect to postgres://app:s3cretpw@db.internal:5432/prod';

describe('全局 onError：每个分支的响应都过 scrubSecrets', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db);
    const throwing: Record<string, () => never> = {
      http: () => {
        throw new HTTPException(409, { message: LEAK });
      },
      shadow: () => {
        throw new ShadowError(LEAK);
      },
      secret: () => {
        throw new SecretError(LEAK);
      },
      plan: () => {
        throw new PlanError(LEAK);
      },
      other: () => {
        throw new Error(LEAK);
      },
    };
    for (const [name, fn] of Object.entries(throwing)) created.app.get(`/__scrub/${name}`, () => fn());
  });
  afterAll(async () => {
    await created.rooms.flush();
    await db.close();
  });

  test.each([
    ['http', 409],
    ['shadow', 422],
    ['secret', 422],
    ['plan', 422],
  ])('%s → %i，响应里没有密码', async (name, status) => {
    const r = await created.app.request(`/__scrub/${name}`);
    const text = await r.text();
    expect(r.status).toBe(status);
    expect(text).not.toContain('s3cretpw');
    expect(JSON.parse(text).error).toContain('postgres://app:***@db.internal');
  });

  test('意外错误：500，只说“服务器内部错误”，不回显原因', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await created.app.request('/__scrub/other');
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: '服务器内部错误' });
  });
});

describe('SSE 的 send：每个字符串值都过 scrubSecrets，JSON 结构不受影响', () => {
  const fake = () => {
    const sent: string[] = [];
    const stream = {
      writeSSE: async ({ data }: { data: string }) => void sent.push(data),
    } as unknown as SSEStreamingApi;
    return { sent, send: sseSender<unknown>(stream) };
  };

  test('嵌套对象 / 数组里的字符串都脱敏；相邻字段里的 @ 不会被吞掉', async () => {
    const { sent, send } = fake();
    await send({
      stage: 'drift',
      error: `连接失败：${LEAK}，请联系 ops@corp.com`,
      details: { problems: ['a@b', 'postgres://u:pw2@h2/d'], n: 3, ok: false },
      code: 'drift',
    });
    const text = sent[0]!;
    expect(text).not.toContain('s3cretpw');
    expect(text).not.toContain('pw2');
    const e = JSON.parse(text);
    expect(e.error).toContain('postgres://app:***@db.internal');
    expect(e.error).toContain('ops@corp.com');
    expect(e.details).toEqual({ problems: ['a@b', 'postgres://u:***@h2/d'], n: 3, ok: false });
    expect(e.code).toBe('drift');
  });

  test('scrubDeep 不改非字符串的值', () => {
    expect(scrubDeep({ a: 1, b: null, c: [true, 'x'], d: undefined })).toEqual({
      a: 1,
      b: null,
      c: [true, 'x'],
      d: undefined,
    });
  });

  test('写失败（客户端断开）后不再发送，也不抛错', async () => {
    let calls = 0;
    const stream = {
      writeSSE: async () => {
        calls++;
        throw new Error('closed');
      },
    } as unknown as SSEStreamingApi;
    const send = sseSender<unknown>(stream);
    await send({ stage: 'a' });
    await send({ stage: 'b' });
    expect(calls).toBe(1);
  });
});
