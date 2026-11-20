// “谁能创建 CI 令牌”的三层规则（P6 T2，ADR 0010）的存储：token_policies(scope_kind, scope_id, rule)。
// 合并规则（逐层取与）是 @dowel/api 的纯函数 tokenCreatorAllows；这里只负责读出来。
// roles.ts 的生效角色要用它（被允许创建令牌的人自动能只读查看项目），所以这个模块不依赖 roles.ts。
import {
  type TokenCreatorRule,
  type TokenPolicyLayer,
  type TokenRuleLayers,
  tokenCreatorRuleSchema,
} from '@dowel/api';
import type { Db } from '@dowel/engines';

/** 全部已设置的规则：表很小（只有设置过的范围才有一行），一次读出，算多个项目时共用 */
export interface TokenRuleStore {
  instance: TokenCreatorRule | null;
  groups: Map<string, TokenCreatorRule>;
  projects: Map<string, TokenCreatorRule>;
}

export const emptyTokenRules = (): TokenRuleStore => ({
  instance: null,
  groups: new Map(),
  projects: new Map(),
});

/** 解析不了的规则（数据被改坏）：按“不允许任何人”处理——宁可收紧，不能放宽，也不能让每个请求都 500 */
const NOBODY: TokenCreatorRule = { roles: [], groups: [] };

export const parseTokenRule = (raw: unknown, where: string): TokenCreatorRule => {
  const r = tokenCreatorRuleSchema.safeParse(raw);
  if (r.success) return r.data;
  console.error(`令牌创建规则无法解析（${where}），按“不允许任何人”处理`, r.error.issues[0]);
  return NOBODY;
};

export const loadTokenRules = async (db: Db): Promise<TokenRuleStore> => {
  const rows = await db.query<{ scopeKind: TokenPolicyLayer; scopeId: string; rule: unknown }>(
    'select scope_kind as "scopeKind", scope_id as "scopeId", rule from token_policies',
  );
  const store = emptyTokenRules();
  for (const r of rows) {
    const rule = parseTokenRule(r.rule, `${r.scopeKind}:${r.scopeId}`);
    if (r.scopeKind === 'instance') store.instance = rule;
    else if (r.scopeKind === 'group') store.groups.set(r.scopeId, rule);
    else store.projects.set(r.scopeId, rule);
  }
  return store;
};

/** 某个项目的三层输入 */
export const tokenRulesFor = (s: TokenRuleStore, p: { id: string; groupId: string }): TokenRuleLayers => ({
  instance: s.instance,
  group: s.groups.get(p.groupId) ?? null,
  project: s.projects.get(p.id) ?? null,
});

/** 规则里有没有组条件：只有组条件会让本来看不到项目的人得到只读可见性（角色条件本身就要求能看到项目） */
export const hasGroupCondition = (s: TokenRuleStore): boolean =>
  [s.instance, ...s.groups.values(), ...s.projects.values()].some((r) => r !== null && r.groups.length > 0);
