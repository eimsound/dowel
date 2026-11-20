// 执行策略保存之后让依赖生效策略的查询失效（PolicyEditor 用；单独放一个模块，便于不带 React / i18n 地单测）。
import type { QueryClient } from '@tanstack/react-query';

/** 依赖生效策略的查询（按前缀） */
export const POLICY_DEPENDENT_KEYS = [
  'envs',
  'env-status',
  'env-policy',
  'exec-policy',
  'token-policy',
  'ci-tokens',
] as const;

/**
 * 生效策略变了之后（任何一层的策略保存、项目转组——转组换掉了组层，可能有字段被固定进环境层），所有依赖生效策略的查询
 * 都可能过期：环境列表（权限、策略、前置环境）、环境状态（确认对话框的策略摘要和执行按钮）、各环境 / 各层的配置页（下限和锁定）、
 * 授权页里“仅限执行者的生产环境”的判断（读的是环境列表）。一律按前缀失效重取（不管是哪个项目、哪个环境）；
 * saved 是刚保存、已经用响应写回的那一个，不重取。返回所有失效完成的 Promise（调用方要在跳转之前等它时用）。
 */
export const invalidatePolicyDependents = (qc: QueryClient, saved: unknown[] | null = null) =>
  Promise.all(
    POLICY_DEPENDENT_KEYS.map((prefix) =>
      qc.invalidateQueries({
        queryKey: [prefix],
        predicate: (q) => saved === null || JSON.stringify(q.queryKey) !== JSON.stringify(saved),
      }),
    ),
  );
