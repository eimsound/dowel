// 执行策略配置页的“CI 令牌仍可免审批执行”提醒条件（ADR 0010、pitfalls #10）。
import { type ApprovalStage, resolvePolicy } from '@dowel/api';
import { expect, test } from 'vitest';

import { tokenBypassRisk } from '../src/token-guard.ts';

const stage: ApprovalStage = { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: false };

test('非生产默认（项目编辑者、无审批、允许令牌）：不提醒', () => {
  expect(tokenBypassRisk(resolvePolicy({}, false))).toBe(false);
  expect(tokenBypassRisk(resolvePolicy({}, false, 'group'))).toBe(false);
});

test('非生产收紧谁能执行（项目管理员 / 仅限执行者）且令牌仍允许：提醒', () => {
  expect(tokenBypassRisk(resolvePolicy({ environment: { whoCanExecute: 'admin' } }, false))).toBe(true);
  expect(tokenBypassRisk(resolvePolicy({ group: { whoCanExecute: 'executor' } }, false, 'group'))).toBe(true);
  // 本层显式写回“项目编辑者”不算收紧
  expect(tokenBypassRisk(resolvePolicy({ project: { whoCanExecute: 'editor' } }, false, 'project'))).toBe(
    false,
  );
});

test('非生产配置了审批环节（任一层）且令牌仍允许：提醒', () => {
  expect(tokenBypassRisk(resolvePolicy({ environment: { approval: [stage] } }, false))).toBe(true);
  // 上级（组）加的环节，从项目层看也算：本层仍可以关掉令牌执行
  expect(tokenBypassRisk(resolvePolicy({ group: { approval: [stage] } }, false, 'project'))).toBe(true);
});

test('生效的“允许令牌执行”已关（本层或上级）：不提醒', () => {
  expect(
    tokenBypassRisk(
      resolvePolicy(
        { environment: { whoCanExecute: 'executor', approval: [stage], allowTokens: false } },
        false,
      ),
    ),
  ).toBe(false);
  // 上级锁定为不允许：本层写允许也不生效
  expect(
    tokenBypassRisk(
      resolvePolicy(
        { group: { allowTokens: false }, environment: { whoCanExecute: 'executor', allowTokens: true } },
        false,
      ),
    ),
  ).toBe(false);
});

test('上级显式允许令牌（下限是“允许”）时仍提醒：关掉令牌执行是收紧，不受锁定限制', () => {
  const r = resolvePolicy(
    { group: { allowTokens: true }, project: { whoCanExecute: 'executor' } },
    false,
    'project',
  );
  expect(r.allowTokens.floor).toBe(true);
  expect(tokenBypassRisk(r)).toBe(true);
});

test('生产那一套不提醒（默认不允许令牌执行，显式打开是有意的选择）', () => {
  expect(
    tokenBypassRisk(resolvePolicy({ environment: { whoCanExecute: 'executor', allowTokens: true } }, true)),
  ).toBe(false);
});
