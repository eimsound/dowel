// 按需规范化（ADR 0016）前端纯逻辑：状态栏影子库来源按服务端选影优先级挑选；手动规范化结果提示文案中英文对齐。
import { afterEach, expect, test } from 'vitest';

import { normalizeToast, usableShadowEnv } from '../src/envs.ts';
import i18n from '../src/i18n.ts';

const env = (
  name: string,
  o: {
    shadowUrl?: string | null;
    production?: boolean;
    allowSameInstance?: boolean;
    engineVersionNum?: number | null;
  },
) => ({
  name,
  shadowUrl: o.shadowUrl ?? null,
  production: o.production ?? false,
  allowSameInstance: o.allowSameInstance ?? false,
  engineVersionNum: o.engineVersionNum ?? null,
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

test('usableShadowEnv：与服务端 forProjectTarget 一致，先选最低已知版本组，再按优先级；该组不可用时回退', () => {
  const pg16Dev = env('pg16-dev', { engineVersionNum: 160004 });
  const pg17Shadow = env('pg17-shadow', { shadowUrl: 'postgres://x/s', engineVersionNum: 170002 });
  const pg16Prod = env('pg16-prod', { production: true, engineVersionNum: 160010 });
  const unknown = env('unknown', { shadowUrl: 'postgres://y/s' });
  // 最低已知版本组 PG 16 优先，哪怕 PG 17 组有显式影子库
  expect(usableShadowEnv([pg17Shadow, pg16Dev, unknown], 'pg')?.name).toBe('pg16-dev');
  // PG 16 组只有禁止同实例的生产环境：回退到下一个已知组
  expect(usableShadowEnv([pg17Shadow, pg16Prod, unknown], 'pg')?.name).toBe('pg17-shadow');
  // 已知组都不可用时才用未探测版本的环境
  expect(usableShadowEnv([pg16Prod, unknown], 'pg')?.name).toBe('unknown');
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
