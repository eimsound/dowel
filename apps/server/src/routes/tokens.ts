// CI 令牌的管理（P6 T1）和“谁能创建令牌”的三层配置（T2，ADR 0010）。这些接口只给登录用户用：
// CI 令牌访问它们一律 403（routes/index.ts 的 rejectTokens），令牌不能管理令牌。
import {
  type CiTokenCreated,
  type CiTokenInfo,
  type CiTokenList,
  ciTokenCreateSchema,
  effectiveTokenRules,
  TOKEN_POLICY_LAYERS,
  type TokenCreatorRule,
  type TokenPolicyLayer,
  type TokenPolicyNames,
  type TokenPolicyView,
  tokenPolicyPutSchema,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { type Action, can, userActor } from '../authz.ts';
import { inList } from '../db.ts';
import { canCreateToken, type ProjectRow } from '../roles.ts';
import { loadTokenRules, type TokenRuleStore, tokenRulesFor } from '../token-rules.ts';
import { listTokens, loadToken, newCiToken } from '../tokens.ts';
import { type AppContext, access, body, type Env, groupAccess, type ProjectAccessRow } from './context.ts';

/** 规则里引用的组的显示名 */
const ruleNames = async (
  db: Db,
  rules: (TokenCreatorRule | null | undefined)[],
): Promise<TokenPolicyNames> => {
  const ids = [...new Set(rules.flatMap((r) => (r ? r.groups.map((g) => g.groupId) : [])))];
  if (!ids.length) return {};
  const rows = await db.query<{ id: string; name: string }>(
    `select id, name from groups where id in (${inList(ids)})`,
    ids,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
};

/** 写入前：规则里引用的组必须存在（422）；去重 */
const normalizeRule = async (db: Db, rule: TokenCreatorRule | null): Promise<TokenCreatorRule | null> => {
  if (!rule) return null;
  const names = await ruleNames(db, [rule]);
  if (rule.groups.some((g) => !names[g.groupId]))
    throw new HTTPException(422, { message: '规则里引用的组不存在' });
  const seen = new Set<string>();
  return {
    roles: [...new Set(rule.roles)],
    groups: rule.groups.filter((g) => {
      const k = `${g.groupId}:${g.role}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  };
};

const scopeIdOf = (layer: TokenPolicyLayer, id: string) => (layer === 'instance' ? '' : id);

const saveRule = async (
  db: Db,
  layer: TokenPolicyLayer,
  id: string,
  rule: TokenCreatorRule | null,
  userId: string,
) => {
  const scopeId = scopeIdOf(layer, id);
  if (!rule) {
    await db.query('delete from token_policies where scope_kind = $1 and scope_id = $2', [layer, scopeId]);
    return;
  }
  await db.query(
    `insert into token_policies (scope_kind, scope_id, rule, updated_by, updated_at)
     values ($1, $2, $3::text::jsonb, $4, $5)
     on conflict (scope_kind, scope_id) do update
       set rule = excluded.rule, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [layer, scopeId, JSON.stringify(rule), userId, new Date().toISOString()],
  );
};

/** 删掉一组范围的规则（删组 / 删项目时清理；范围是多态的，没有外键） */
export const deleteTokenPolicies = async (db: Db, kind: 'group' | 'project', ids: string[]) => {
  if (!ids.length) return;
  await db.query(`delete from token_policies where scope_kind = $1 and scope_id in (${inList(ids, 2)})`, [
    kind,
    ...ids,
  ]);
};

const view = async (
  db: Db,
  layer: TokenPolicyLayer,
  store: TokenRuleStore,
  scope: { groupId: string | null; projectId: string | null },
  canEdit: boolean,
): Promise<TokenPolicyView> => {
  const all = tokenRulesFor(store, { id: scope.projectId ?? '', groupId: scope.groupId ?? '' });
  const layers = {
    instance: all.instance ?? null,
    group: scope.groupId ? (all.group ?? null) : null,
    project: scope.projectId ? (all.project ?? null) : null,
  };
  const at = TOKEN_POLICY_LAYERS.indexOf(layer);
  const upper = TOKEN_POLICY_LAYERS.slice(0, at).flatMap((l) => {
    const rule = layers[l];
    return rule ? [{ layer: l, rule }] : [];
  });
  // 生效规则只算到本层（组层的视图不含任何项目层）
  const effective = effectiveTokenRules(
    Object.fromEntries(TOKEN_POLICY_LAYERS.slice(0, at + 1).map((l) => [l, layers[l]])),
  );
  return {
    layer,
    rule: layers[layer],
    upper,
    effective,
    canEdit,
    names: await ruleNames(db, Object.values(layers)),
  };
};

export const registerTokens = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  /** 项目里令牌管理的身份：能不能创建、能不能看列表、能不能吊销某个令牌 */
  const tokenAccess = (c: Context<Env>, a: ProjectAccessRow, project: ProjectRow) => {
    const user = c.get('user');
    const actor = userActor(user);
    const tokenCreator = canCreateToken(a.rc, project);
    const check = (action: Action, tokenOwner = false) =>
      can(actor, action, { kind: 'project', role: a.role, tokenCreator, tokenOwner });
    return {
      canCreate: check('token.create'),
      canList: check('token.list'),
      canRevoke: (createdBy: string | null) =>
        check('token.revoke', createdBy !== null && createdBy === user.id),
    };
  };

  app.get('/api/projects/:pid/tokens', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const t = tokenAccess(c, a, a);
    if (!t.canList)
      throw new HTTPException(403, { message: '只有项目管理员和被允许创建 CI 令牌的人能查看令牌' });
    return c.json<CiTokenList>({ tokens: await listTokens(db, a.pid, t.canRevoke), canCreate: t.canCreate });
  });

  app.post('/api/projects/:pid/tokens', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const t = tokenAccess(c, a, a);
    if (!t.canCreate)
      throw new HTTPException(403, { message: '你不在“谁能创建 CI 令牌”允许的范围内（见项目设置里的说明）' });
    const b = await body(c, ciTokenCreateSchema);
    const user = c.get('user');
    const { token, hash, prefix } = newCiToken();
    const id = newId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + b.expiresInDays * 86400_000).toISOString();
    await db.query(
      `insert into ci_tokens (id, project_id, name, description, prefix, token_hash, created_by, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, a.pid, b.name, b.description, prefix, hash, user.id, now.toISOString(), expiresAt],
    );
    ctx.activeTokens.remember(hash, { id, projectId: a.pid, expiresAtMs: Date.parse(expiresAt) });
    await ctx.bus.publish({ t: 'ci_tokens.changed' }).catch((e) => {
      console.error('广播 CI 令牌创建事件失败', e);
    });
    await audit(
      db,
      c,
      {
        action: 'ci_token.create',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'ci_token',
        targetId: id,
        projectId: a.pid,
        data: { name: b.name, prefix, expiresAt, expiresInDays: b.expiresInDays },
      },
      ctx.security,
    );
    const info = (await loadToken(db, a.pid, id, t.canRevoke))!;
    return c.json<CiTokenCreated>({ token, info }, 201);
  });

  /** 吊销：立即生效（每个令牌请求都查库）。行保留（列表和审计里看得到谁在什么时候吊销的）；先鉴权（403）再判已吊销（409） */
  app.post('/api/projects/:pid/tokens/:tid/revoke', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const t = tokenAccess(c, a, a);
    const tid = c.req.param('tid');
    const before = await loadToken(db, a.pid, tid, t.canRevoke);
    if (!before) throw new HTTPException(404, { message: '令牌不存在' });
    if (!t.canRevoke(before.createdBy?.id ?? null))
      throw new HTTPException(403, {
        message: '只有项目管理员、组管理员、实例管理员或令牌的创建者能吊销令牌',
      });
    if (before.status === 'revoked') throw new HTTPException(409, { message: '令牌已经吊销了' });
    const user = c.get('user');
    // 条件更新：并发吊销只有一个算数
    const done = await db.query<{ id: string }>(
      `update ci_tokens set revoked_at = $3, revoked_by = $4
        where id = $1 and project_id = $2 and revoked_at is null returning id`,
      [tid, a.pid, new Date().toISOString(), user.id],
    );
    if (!done.length) throw new HTTPException(409, { message: '令牌已经吊销了' });
    ctx.activeTokens.forgetId(tid);
    await ctx.bus.publish({ t: 'ci_tokens.changed' }).catch((e) => {
      console.error('广播 CI 令牌吊销事件失败', e);
    });
    await audit(
      db,
      c,
      {
        action: 'ci_token.revoke',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'ci_token',
        targetId: tid,
        projectId: a.pid,
        data: { name: before.name, prefix: before.prefix, createdBy: before.createdBy?.id ?? null },
      },
      ctx.security,
    );
    return c.json<CiTokenInfo>((await loadToken(db, a.pid, tid, t.canRevoke))!);
  });

  // ───── 谁能创建令牌：三层配置 ─────

  /** 改了规则：组条件会改变可见性（被允许创建令牌的人能只读查看），在线的房间按新角色刷新 */
  const afterRuleChange = async (
    c: Context<Env>,
    layer: TokenPolicyLayer,
    id: string,
    before: TokenCreatorRule | null,
    after: TokenCreatorRule | null,
    projectId: string | null,
  ) => {
    await ctx.rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'token_policy.update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: layer,
        targetId: layer === 'instance' ? null : id,
        projectId,
        data: { layer, before, after },
      },
      ctx.security,
    );
  };

  const put = async (c: Context<Env>, layer: TokenPolicyLayer, id: string) => {
    const b = await body(c, tokenPolicyPutSchema);
    const rule = await normalizeRule(db, b.rule);
    const before = (await loadTokenRules(db))[
      layer === 'instance' ? 'instance' : layer === 'group' ? 'groups' : 'projects'
    ];
    const old = before instanceof Map ? (before.get(id) ?? null) : before;
    await saveRule(db, layer, id, rule, c.get('user').id);
    return { before: old, after: rule };
  };

  // 实例层（/api/admin/* 已要求实例管理员：instance.manage_token_policy，见 routes/index.ts）
  app.get('/api/admin/token-policy', async (c) =>
    c.json<TokenPolicyView>(
      await view(db, 'instance', await loadTokenRules(db), { groupId: null, projectId: null }, true),
    ),
  );
  app.put('/api/admin/token-policy', async (c) => {
    const r = await put(c, 'instance', '');
    await afterRuleChange(c, 'instance', '', r.before, r.after, null);
    return c.json<TokenPolicyView>(
      await view(db, 'instance', await loadTokenRules(db), { groupId: null, projectId: null }, true),
    );
  });

  // 组层：组对所有人可见（GET），组管理员可改
  app.get('/api/groups/:slug/token-policy', async (c) => {
    const g = await groupAccess(c, ctx, 'group.read');
    const canEdit = can(userActor(c.get('user')), 'group.set_token_policy', {
      kind: 'group',
      groupRole: g.groupRole,
    });
    return c.json<TokenPolicyView>(
      await view(db, 'group', await loadTokenRules(db), { groupId: g.id, projectId: null }, canEdit),
    );
  });
  app.put('/api/groups/:slug/token-policy', async (c) => {
    const g = await groupAccess(c, ctx, 'group.set_token_policy');
    const r = await put(c, 'group', g.id);
    await afterRuleChange(c, 'group', g.id, r.before, r.after, null);
    return c.json<TokenPolicyView>(
      await view(db, 'group', await loadTokenRules(db), { groupId: g.id, projectId: null }, true),
    );
  });

  // 项目层：项目成员可看，项目管理员可改
  app.get('/api/projects/:pid/token-policy', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const canEdit = can(userActor(c.get('user')), 'project.set_token_policy', {
      kind: 'project',
      role: a.role,
    });
    return c.json<TokenPolicyView>(
      await view(db, 'project', await loadTokenRules(db), { groupId: a.groupId, projectId: a.pid }, canEdit),
    );
  });
  app.put('/api/projects/:pid/token-policy', async (c) => {
    const a = await access(c, ctx, 'project.set_token_policy');
    const r = await put(c, 'project', a.pid);
    await afterRuleChange(c, 'project', a.pid, r.before, r.after, a.pid);
    return c.json<TokenPolicyView>(
      await view(db, 'project', await loadTokenRules(db), { groupId: a.groupId, projectId: a.pid }, true),
    );
  });
};
