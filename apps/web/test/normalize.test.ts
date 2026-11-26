// 按需规范化（ADR 0016）前端纯逻辑：状态栏影子库来源按服务端选影优先级挑选；手动规范化结果提示文案中英文对齐。
import { afterEach, expect, test } from 'vitest';

import { normalizeToast, usableShadowEnv } from '../src/envs.ts';
import i18n from '../src/i18n.ts';

const env = (
  name: string,
  o: { shadowUrl?: string | null; production?: boolean; allowSameInstance?: boolean },
) => ({
  name,
  shadowUrl: o.shadowUrl ?? null,
  production: o.production ?? false,
  allowSameInstance: o.allowSameInstance ?? false,
});

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

test('usableShadowEnv：独立影子库 > 非生产 > 允许同实例的生产；都不可用返回 null', () => {
  const prod = env('prod', { production: true });
  const prodSame = env('prod-same', { production: true, allowSameInstance: true });
  const dev = env('dev', {});
  const dedicated = env('prod-shadow', { production: true, shadowUrl: 'postgres://x/shadow' });
  expect(usableShadowEnv(undefined)).toBeNull();
  expect(usableShadowEnv([prod])).toBeNull();
  expect(usableShadowEnv([prod, prodSame])?.name).toBe('prod-same');
  expect(usableShadowEnv([prod, prodSame, dev])?.name).toBe('dev');
  expect(usableShadowEnv([prod, prodSame, dev, dedicated])?.name).toBe('prod-shadow');
});

test('normalizeToast 与 ws.normalize.* 词条在中英文下完整对齐', async () => {
  const t = i18n.t.bind(i18n);
  const keys = (lng: string) =>
    Object.keys(
      (i18n.getResourceBundle(lng, 'translation') as { ws: { normalize: object } }).ws.normalize,
    ).sort();
  expect(keys('en')).toEqual(keys('zh'));
  for (const lng of ['zh', 'en'] as const) {
    await i18n.changeLanguage(lng);
    for (const outcome of ['normalized', 'verified', 'clean'] as const) {
      const msg = normalizeToast({ outcome, normalizedCount: 2, shadow: 'dev：shop_dowel' }, t);
      expect(msg).not.toMatch(/\{\{|ws\.normalize/);
    }
    expect(normalizeToast({ outcome: 'normalized', normalizedCount: 2, shadow: 'S' }, t)).toContain('2');
    expect(t('ws.normalize.pending', { count: 3 })).toContain('3');
  }
});
