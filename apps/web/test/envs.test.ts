// 接入环境成功提示文案测试：覆盖认领/未认领、有无领先版本、有无当前版本的中英文输出，确保无双标点且无 v—（#36）。
import type { AttachResult } from '@dowel/api';
import { afterEach, expect, test } from 'vitest';
import { attachSuccessMessage } from '../src/envs.ts';
import i18n from '../src/i18n.ts';

type AttachSummary = Pick<AttachResult, 'attached' | 'claimed' | 'currentVersion' | 'aheadVersions'>;

const v = (number: number) => ({ id: `v_${number}`, number, name: `v${number}` });

const CASES: Array<{ label: string; result: AttachSummary; zh: string; en: string }> = [
  {
    label: '无历史的新环境',
    result: { attached: false, claimed: false, currentVersion: null, aheadVersions: [] },
    zh: '已添加 prod（这个库里还没有这个项目的历史）。',
    en: 'Added prod (no history of this project in that database yet).',
  },
  {
    label: '已接入、有当前版本、未认领',
    result: { attached: true, claimed: false, currentVersion: v(3), aheadVersions: [] },
    zh: '已接入 prod：当前版本 v3。',
    en: 'Attached prod: current version v3.',
  },
  {
    label: '已接入、有当前版本、已认领',
    result: { attached: true, claimed: true, currentVersion: v(3), aheadVersions: [] },
    zh: '已接入 prod：当前版本 v3，并已认领。',
    en: 'Attached and claimed prod: current version v3.',
  },
  {
    label: '已接入、无当前版本、未认领',
    result: { attached: true, claimed: false, currentVersion: null, aheadVersions: [] },
    zh: '已接入 prod：尚未执行任何版本。',
    en: 'Attached prod: not yet executed.',
  },
  {
    label: '已接入、无当前版本、已认领',
    result: { attached: true, claimed: true, currentVersion: null, aheadVersions: [] },
    zh: '已接入 prod：尚未执行任何版本，并已认领。',
    en: 'Attached and claimed prod: not yet executed.',
  },
  {
    label: '已接入、有领先版本、有当前版本、未认领',
    result: { attached: true, claimed: false, currentVersion: v(2), aheadVersions: [v(2)] },
    zh: '已接入 prod：补齐 1 个领先版本，当前版本 v2。',
    en: 'Attached prod: added 1 ahead version(s), current version v2.',
  },
  {
    label: '已接入、有领先版本、有当前版本、已认领',
    result: { attached: true, claimed: true, currentVersion: v(2), aheadVersions: [v(2)] },
    zh: '已接入 prod：补齐 1 个领先版本，当前版本 v2，并已认领。',
    en: 'Attached and claimed prod: added 1 ahead version(s), current version v2.',
  },
  {
    label: '已接入、有领先版本、无当前版本、未认领',
    result: { attached: true, claimed: false, currentVersion: null, aheadVersions: [v(2), v(3)] },
    zh: '已接入 prod：补齐 2 个领先版本。',
    en: 'Attached prod: added 2 ahead version(s).',
  },
  {
    label: '已接入、有领先版本、无当前版本、已认领',
    result: { attached: true, claimed: true, currentVersion: null, aheadVersions: [v(2), v(3)] },
    zh: '已接入 prod：补齐 2 个领先版本，并已认领。',
    en: 'Attached and claimed prod: added 2 ahead version(s).',
  },
];

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

test('attachSuccessMessage 在中英文下所有组合均输出完整自然句，无双标点与 v—', async () => {
  const t = i18n.t.bind(i18n);
  for (const lng of ['zh', 'en'] as const) {
    await i18n.changeLanguage(lng);
    for (const c of CASES) {
      const msg = attachSuccessMessage(t, 'prod', c.result);
      expect(msg, `${lng} / ${c.label}`).toBe(c[lng]);
      expect(msg, `${lng} / ${c.label}: 不应含双标点`).not.toMatch(/[。！？][，。！？]|\.\s*(and\b|,|\.)/i);
      expect(msg, `${lng} / ${c.label}: 不应渲染 v—`).not.toMatch(/v(?:—|undefined|null)/);
    }
  }
});

test('tk.attached* 词条在 zh 与 en 100% 对齐，且旧后缀键已移除', () => {
  const keys = [
    'tk.attachedNone',
    'tk.attachedOk',
    'tk.attachedOkClaimed',
    'tk.attachedNoVersion',
    'tk.attachedNoVersionClaimed',
    'tk.attachedAheadOk',
    'tk.attachedAheadOkClaimed',
    'tk.attachedAheadNoVersion',
    'tk.attachedAheadNoVersionClaimed',
  ];
  for (const lng of ['zh', 'en'] as const) {
    for (const key of keys) {
      expect(i18n.exists(key, { lng }), `${lng}: 缺少 ${key}`).toBe(true);
    }
    expect(i18n.exists('tk.attachedClaimed', { lng }), `${lng}: 不应保留旧后缀键`).toBe(false);
  }
});
