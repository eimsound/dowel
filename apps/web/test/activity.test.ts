import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 审计动作文案与画布历史操作名 i18n 覆盖测试（#33）。
import { CANVAS_HISTORY_SESSION_OP } from '@dowel/api';
import { COMPOSITE_MUTATORS, mutators } from '@dowel/core';
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
    // paste / batch 不在普通 mutator 表里（由 runMutator 单独分派），一并检查；editSession 是读时归组的编辑会话
    for (const op of [...Object.keys(mutators), ...COMPOSITE_MUTATORS, CANVAS_HISTORY_SESSION_OP]) {
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

test('邮件服务与找回密码审计动作在中英文下正确渲染', async () => {
  await i18n.changeLanguage('zh');
  expect(actionText('email.settings_update', {})).toBe('修改了邮件服务（SMTP）配置');
  expect(actionText('email.test', { to: 'ops@example.com' })).toBe('发送了测试邮件至 ops@example.com');
  expect(actionText('auth.forgot_password_request', { username: 'alice' })).toBe(
    '发起了找回密码请求（用户 alice）',
  );

  await i18n.changeLanguage('en');
  expect(actionText('email.settings_update', {})).toBe('updated SMTP email settings');
  expect(actionText('email.test', { to: 'ops@example.com' })).toBe('sent a test email to ops@example.com');
  expect(actionText('auth.forgot_password_request', { username: 'alice' })).toBe(
    'requested a password reset for alice',
  );
});

test('model.mutate：带 MCP 意图说明时使用独立文案键，空白说明回退为普通文案', async () => {
  await i18n.changeLanguage('zh');
  expect(COMPOSITE_MUTATORS.has('batch')).toBe(true);
  expect(i18n.t('hist.op.batch')).toBe('批量修改');
  expect(actionText('model.mutate', { opCount: 3 })).toBe('修改了工作副本（3 处操作）');
  expect(actionText('model.mutate', { opCount: 3, summary: '  新增订单表  ' })).toBe(
    '修改了工作副本（3 处操作）：新增订单表',
  );
  expect(actionText('model.mutate', { opCount: 3, summary: '   ' })).toBe('修改了工作副本（3 处操作）');

  await i18n.changeLanguage('en');
  expect(i18n.t('hist.op.batch')).toBe('Batch edit');
  expect(actionText('model.mutate', { opCount: 2, summary: 'add orders' })).toBe(
    'edited the working copy (2 operations): add orders',
  );
  expect(actionText('model.mutate', { opCount: 2, summary: 1 })).toBe(
    'edited the working copy (2 operations)',
  );
});
