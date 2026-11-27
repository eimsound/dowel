// api.ts 的错误消息：登记过的错误码（影子库配置已变更，#154）用界面文案、跟随界面语言；其余用服务端原文。
import { afterEach, expect, test, vi } from 'vitest';

import { ApiError, api } from '../src/api.ts';
import i18n from '../src/i18n.ts';

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

const failure = async () => {
  try {
    await api('POST', '/api/projects/p/verify', {});
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected ApiError');
};

afterEach(async () => {
  vi.unstubAllGlobals();
  await i18n.changeLanguage('zh');
});

test('shadow_config_changed：中英文界面文案，保留错误码与状态', async () => {
  respond(503, { error: '影子库配置已变更，请重试', code: 'shadow_config_changed' });
  await i18n.changeLanguage('zh');
  const zh = await failure();
  expect(zh).toBeInstanceOf(ApiError);
  expect(zh.status).toBe(503);
  expect(zh.code).toBe('shadow_config_changed');
  expect(zh.message).toBe('影子库配置已变更，请重试');

  await i18n.changeLanguage('en');
  expect((await failure()).message).toBe('The shadow database configuration changed. Please try again.');
});

test('未登记的错误码（shadow_unavailable）仍用服务端原文', async () => {
  respond(422, { error: '影子库不可用：连接失败：ECONNREFUSED', code: 'shadow_unavailable' });
  await i18n.changeLanguage('en');
  const e = await failure();
  expect(e.code).toBe('shadow_unavailable');
  expect(e.message).toBe('影子库不可用：连接失败：ECONNREFUSED');
});
