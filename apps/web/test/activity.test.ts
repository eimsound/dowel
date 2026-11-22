import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 审计动作文案与画布历史操作名 i18n 覆盖测试（#33）。
import { mutators } from '@dowel/core';
import { afterEach, expect, test } from 'vitest';

import { actionText } from '../src/activity.ts';
import i18n from '../src/i18n.ts';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

test('project.takeover 与 project.claim 在中英文下正确渲染（含与不含 environment）', async () => {
  await i18n.changeLanguage('zh');
  expect(actionText('project.takeover', { name: '商城' })).toBe('接手了项目');
  expect(actionText('project.claim', { projectId: 'p1', environment: 'prod', via: 'takeover' })).toBe(
    '认领了环境 prod 的项目',
  );
  expect(
    actionText('project.claim', { projectId: 'p1', name: 'staging', environment: 'staging', via: 'attach' }),
  ).toBe('认领了环境 staging 的项目');
  expect(actionText('project.claim', {})).toBe('认领了项目');
  expect(actionText('project.claim', { environment: '   ' })).toBe('认领了项目');
  expect(actionText('project.claim', null)).toBe('认领了项目');

  await i18n.changeLanguage('en');
  expect(actionText('project.takeover', { name: 'Shop' })).toBe('took over the project');
  expect(actionText('project.claim', { projectId: 'p1', environment: 'prod', via: 'claim' })).toBe(
    'claimed the project on prod',
  );
  expect(actionText('project.claim', {})).toBe('claimed the project');
  expect(actionText('project.claim', { environment: '' })).toBe('claimed the project');
  expect(actionText('project.claim', null)).toBe('claimed the project');
});

test('hist.op.edit 在中英文下均有对应文案', async () => {
  await i18n.changeLanguage('zh');
  expect(i18n.exists('hist.op.edit')).toBe(true);
  expect(i18n.t('hist.op.edit')).toBe('编辑模型');

  await i18n.changeLanguage('en');
  expect(i18n.exists('hist.op.edit')).toBe(true);
  expect(i18n.t('hist.op.edit')).toBe('Edit model');
});

test('所有 core mutators 在 zh / en 的 hist.op 词典中均有文案', async () => {
  for (const lng of ['zh', 'en'] as const) {
    await i18n.changeLanguage(lng);
    for (const op of Object.keys(mutators)) {
      expect(i18n.exists(`hist.op.${op}`, { lng }), `${lng}: 缺少 hist.op.${op}`).toBe(true);
    }
  }
});

test('服务端 audit-coverage 覆盖的全部审计动作在 zh / en 词典中均已登记', async () => {
  const covPath = resolve(import.meta.dirname, '../../server/test/audit-coverage.test.ts');
  const covSrc = readFileSync(covPath, 'utf8');
  const actions = new Set([...covSrc.matchAll(/action:\s*'([^']+)'/g)].map((m) => m[1]!));
  actions.add('user.create');

  for (const lng of ['zh', 'en'] as const) {
    await i18n.changeLanguage(lng);
    const unknown = i18n.t('act.unknown');
    for (const action of actions) {
      expect(i18n.exists(`act.${action}`, { lng }), `${lng}: 缺少 act.${action}`).toBe(true);
      expect(actionText(action, {}), `${lng}: act.${action} 回退为 unknown`).not.toBe(unknown);
    }
  }
});
