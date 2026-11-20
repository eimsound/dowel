// 权限矩阵（P1 验收）：遍历 Hono 的路由表，每个 method + path 都必须在这里登记。
//
// 约定：
// - 请求体用“能过鉴权、但会被路由拒绝”的最小值（通常是 {}），所以“过了鉴权”表现为 400 / 422，
//   而不是 401 / 403 / 404；需要真实目标库的端点只验证鉴权这一层，用连不上的 127.0.0.1:1，允许 4xx/5xx。
// - 项目端点：看不见（生效角色为空）一律 404；角色不够是 403；角色够用但请求体不合法是 400/422。
// - 公开端点显式标成 public，只断言它不被登录中间件拦住（各端点自己的错误码写在 statuses 里）。
// - WebSocket 端点单独测：未登录 / 停用 / 无关用户被拒，查看者只读。
import type { AddressInfo } from 'node:net';
import type { GroupRole, Role } from '@dowel/api';
import { all, emptyModel } from '@dowel/core';
import { stepsChecksum } from '@dowel/engines';
import { SyncClient, type ToClient } from '@dowel/sync';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, test } from 'vitest';
import WebSocket from 'ws';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { newCiToken } from '../src/tokens.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'matrix-test-secret-0123456789';

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

interface Identity {
  name: string;
  cookie: string;
  active: boolean;
  instanceAdmin: boolean;
  groupRole: GroupRole | null;
  projectRole: Role | null;
  userId: string;
}

const identities: Identity[] = [];
const byName = new Map<string, Identity>();
const addIdentity = (i: Identity) => {
  identities.push(i);
  byName.set(i.name, i);
};

type Access =
  | { kind: 'public'; statuses: number[] }
  | { kind: 'authed'; statuses?: number[] }
  | { kind: 'instance'; statuses?: number[] }
  | { kind: 'group-read'; statuses?: number[] }
  | { kind: 'group-admin'; statuses?: number[] }
  | { kind: 'create-group'; statuses?: number[] }
  | { kind: 'group-create-project'; statuses?: number[] }
  | { kind: 'project'; min: Role; statuses?: number[] }
  /** 项目可见（看不见 404）但操作只有实例管理员能做（其余 403，包括项目管理员） */
  | { kind: 'project-instance-admin'; statuses?: number[] }
  /** CI 令牌端点（/api/ci/*）：无令牌的用户一律 401，持有效令牌返回 tokenStatuses */
  | { kind: 'ci'; tokenStatuses: number[] }
  | { kind: 'ws' };

interface Ctx {
  pid: string;
  projectSlug: string;
  groupSlug: string;
  groupId: string;
  targetUserId: string;
  outsiderId: string;
  inviteToken: string;
  envId: string;
  envName: string;
  tokenId: string;
  versionId: string;
}

interface Spec {
  access: Access;
  path?: (ctx: Ctx) => string;
  body?: (ctx: Ctx) => unknown;
  prepare?: (ctx: Ctx, identity: Identity) => Promise<void>;
}

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let stop: () => Promise<void>;
let base = '';
let server: ReturnType<typeof serve>;
let injectWebSocket: ReturnType<typeof createApp>['injectWebSocket'];

const P = () => `/api/projects/${currentCtx.pid}`;
let currentCtx: Ctx;
let ciToken = '';
let adminUserId = '';
let unique = 0;

const call = async (
  method: string,
  path: string,
  json?: unknown,
  cookie = '',
  extra: Record<string, string> = {},
) => {
  const headers: Record<string, string> = { ...extra };
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const r = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: r.status,
    data: data as Record<string, unknown>,
    cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

const login = async (username: string, password = PASSWORD) => {
  const r = await call('POST', '/api/auth/login', { username, password });
  expect(r.status, username).toBe(200);
  return r.cookie;
};

const ensureGrant = async (id: string, subjectId: string, role: Role, scopeKind: string, scopeId: string) => {
  await db.query(
    `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
     values ($1, 'user', $2, $3, $4, $5)
     on conflict do nothing`,
    [id, subjectId, role, scopeKind, scopeId],
  );
};

const freshEnv = async (projectId: string, seq: number) => {
  const id = `matrix-env-${seq}`;
  const name = `env-${seq}`;
  await db.query(
    `insert into environments (id, project_id, name, url_enc, production)
     values ($1, $2, $3, $4, false)`,
    [id, projectId, name, encrypt('postgres://127.0.0.1:1/matrix')],
  );
  return { id, name };
};

const freshToken = async (projectId: string, seq: number, createdBy: string) => {
  const id = `matrix-tok-${seq}`;
  const { hash, prefix } = newCiToken();
  await db.query(
    `insert into ci_tokens (id, project_id, name, description, prefix, token_hash, created_by, expires_at)
     values ($1, $2, $3, '', $4, $5, $6, $7)`,
    [id, projectId, `tok-${seq}`, prefix, hash, createdBy, new Date(Date.now() + 86400_000).toISOString()],
  );
  return id;
};

/** 权限矩阵用的 Webhook（127.0.0.1 会被出站限制拒绝，不会真的发请求） */
const matrixWebhook = async (groupId: string) => {
  await db.query(
    `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
     values ('matrix-webhook', $1, 'm', 'json', $2, $3::text::jsonb, true) on conflict do nothing`,
    [groupId, encrypt('http://127.0.0.1:1/x'), JSON.stringify(['request.created'])],
  );
};

const matrix: Record<string, Spec> = {
  // 公开端点
  'POST /api/auth/login': {
    access: { kind: 'public', statuses: [200] },
    body: () => ({ username: 'admin', password: PASSWORD }),
  },
  'POST /api/auth/logout': { access: { kind: 'public', statuses: [200] } },
  'GET /api/auth/me': { access: { kind: 'public', statuses: [401] } },
  'GET /api/auth/oidc/:slug/start': {
    access: { kind: 'public', statuses: [404] },
    path: () => '/api/auth/oidc/no-such-provider/start',
  },
  'GET /api/auth/oidc/:slug/callback': {
    access: { kind: 'public', statuses: [302] },
    path: () => '/api/auth/oidc/no-such-provider/callback',
  },
  'GET /api/auth/oidc/confirm': { access: { kind: 'public', statuses: [410] } },
  'POST /api/auth/oidc/confirm': { access: { kind: 'public', statuses: [410] }, body: () => ({}) },
  'GET /api/setup': { access: { kind: 'public', statuses: [200] } },
  'GET /api/instance': { access: { kind: 'public', statuses: [200] } },
  'POST /api/setup': {
    access: { kind: 'public', statuses: [409] },
    body: () => ({ token: 'x', username: 'nobody', name: 'Nobody', password: 'password1' }),
  },
  'GET /api/invites/:token': {
    access: { kind: 'public', statuses: [200] },
    path: (ctx) => `/api/invites/${ctx.inviteToken}`,
  },
  'POST /api/invites/:token/accept': {
    access: { kind: 'public', statuses: [400] },
    path: (ctx) => `/api/invites/${ctx.inviteToken}/accept`,
    body: () => ({}),
  },
  'POST /api/reset/:token': {
    access: { kind: 'public', statuses: [400] },
    path: () => '/api/reset/no-such-token',
    body: () => ({}),
  },
  // 个人设置：所有登录用户都能访问自己的资料
  'PATCH /api/me': { access: { kind: 'authed', statuses: [200] }, body: () => ({}) },
  'POST /api/me/password': { access: { kind: 'authed', statuses: [400] }, body: () => ({}) },
  'GET /api/me/sessions': { access: { kind: 'authed', statuses: [200] } },
  'DELETE /api/me/sessions/:id': {
    access: { kind: 'authed', statuses: [404] },
    path: () => '/api/me/sessions/no-such-session',
  },
  'GET /api/me/identities': { access: { kind: 'authed', statuses: [200] } },
  'DELETE /api/me/identities/:id': {
    access: { kind: 'authed', statuses: [404] },
    path: () => '/api/me/identities/no-such-identity',
  },
  // 实例管理
  'GET /api/admin/settings': { access: { kind: 'instance', statuses: [200] } },
  'PATCH /api/admin/settings': {
    access: { kind: 'instance', statuses: [200] },
    body: () => ({}),
  },
  'GET /api/admin/users': { access: { kind: 'instance', statuses: [200] } },
  'POST /api/admin/users': { access: { kind: 'instance', statuses: [400] }, body: () => ({}) },
  'PATCH /api/admin/users/:id': {
    access: { kind: 'instance', statuses: [200] },
    path: (ctx) => `/api/admin/users/${ctx.outsiderId}`,
    body: () => ({}),
  },
  'POST /api/admin/users/:id/reset-link': {
    access: { kind: 'instance', statuses: [200] },
    path: (ctx) => `/api/admin/users/${ctx.outsiderId}/reset-link`,
    body: () => ({}),
  },
  'GET /api/admin/grants': { access: { kind: 'instance', statuses: [200] } },
  // 执行策略（P5a）：实例层只有实例管理员能看和改；空的整层替换是合法请求（全部继承）
  'GET /api/admin/exec-policy': { access: { kind: 'instance', statuses: [200] } },
  'PUT /api/admin/exec-policy': { access: { kind: 'instance', statuses: [200] }, body: () => ({}) },
  'GET /api/groups/:slug/exec-policy': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/exec-policy`,
  },
  'PUT /api/groups/:slug/exec-policy': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/exec-policy`,
    body: () => ({}),
  },
  'GET /api/projects/:pid/exec-policy': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/exec-policy`,
  },
  'PUT /api/projects/:pid/exec-policy': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: () => `${P()}/exec-policy`,
    body: () => ({}),
  },
  'GET /api/projects/:pid/environments/:eid/exec-policy': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/exec-policy`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 环境层：项目管理员（放宽另外要满足执行策略，在 policy-routes.test.ts 里验证）；请求体不合法 → 400
  'PUT /api/projects/:pid/environments/:eid/exec-policy': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/exec-policy`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/admin/grants': { access: { kind: 'instance', statuses: [400] }, body: () => ({}) },
  'DELETE /api/admin/grants/:id': {
    access: { kind: 'instance', statuses: [404] },
    path: () => '/api/admin/grants/no-such-grant',
  },
  'POST /api/admin/invites': { access: { kind: 'instance', statuses: [201] }, body: () => ({}) },
  'GET /api/admin/invites': { access: { kind: 'instance', statuses: [200] } },
  'DELETE /api/admin/invites/:id': {
    access: { kind: 'instance', statuses: [404] },
    path: () => '/api/admin/invites/no-such-invite',
  },
  'GET /api/admin/oidc/presets': { access: { kind: 'instance', statuses: [200] } },
  'GET /api/admin/oidc': { access: { kind: 'instance', statuses: [200] } },
  'POST /api/admin/oidc': { access: { kind: 'instance', statuses: [400] }, body: () => ({}) },
  'PATCH /api/admin/oidc/:id': {
    access: { kind: 'instance', statuses: [404] },
    path: () => '/api/admin/oidc/no-such-provider',
    body: () => ({}),
  },
  'DELETE /api/admin/oidc/:id': {
    access: { kind: 'instance', statuses: [404] },
    path: () => '/api/admin/oidc/no-such-provider',
  },
  'GET /api/admin/audit': { access: { kind: 'instance', statuses: [200] } },
  // 组：组本身对所有人可见，管理动作需要这个组的组管理员
  'GET /api/groups': { access: { kind: 'authed', statuses: [200] } },
  'POST /api/groups': {
    access: { kind: 'create-group', statuses: [201] },
    body: () => ({ slug: `matrix-new-${++unique}`, name: '新组' }),
  },
  'GET /api/groups/:slug': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}`,
  },
  'PATCH /api/groups/:slug': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}`,
    body: () => ({}),
  },
  'DELETE /api/groups/:slug': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}`,
    prepare: async (ctx, identity) => {
      const slug = `matrix-empty-${++unique}`;
      const id = `matrix-group-${unique}`;
      await db.query(`insert into groups (id, slug, name, default_role) values ($1, $2, '空组', 'none')`, [
        id,
        slug,
      ]);
      // 只有组管理员身份（ga）在新组里也是管理员；其他身份（包括普通组成员）不是
      if (identity.name === 'ga')
        await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')", [
          id,
          identity.userId,
        ]);
      ctx.groupSlug = slug;
    },
  },
  'GET /api/groups/:slug/projects': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/projects`,
  },
  'GET /api/groups/:slug/members': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/members`,
  },
  'POST /api/groups/:slug/members': {
    access: { kind: 'group-admin', statuses: [400] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/members`,
    body: () => ({}),
  },
  'PATCH /api/groups/:slug/members/:userId': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/members/${ctx.targetUserId}`,
    body: () => ({ role: 'member' }),
    prepare: async (ctx) => {
      await db.query(
        "insert into group_members (group_id, user_id, role) values ($1, $2, 'member') on conflict do nothing",
        [ctx.groupId, ctx.targetUserId],
      );
    },
  },
  'DELETE /api/groups/:slug/members/:userId': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/members/${ctx.targetUserId}`,
    prepare: async (ctx) => {
      await db.query(
        "insert into group_members (group_id, user_id, role) values ($1, $2, 'member') on conflict do nothing",
        [ctx.groupId, ctx.targetUserId],
      );
    },
  },
  'GET /api/groups/:slug/grants': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/grants`,
  },
  'POST /api/groups/:slug/grants': {
    access: { kind: 'group-admin', statuses: [400] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/grants`,
    body: () => ({}),
  },
  'DELETE /api/groups/:slug/grants/:id': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/grants/matrix-group-grant`,
    prepare: async (ctx) => {
      await ensureGrant('matrix-group-grant', ctx.targetUserId, 'viewer', 'group', ctx.groupId);
    },
  },
  'GET /api/directory': { access: { kind: 'authed', statuses: [200] } },
  // 连接检查（P3 向导）：能在这个组建项目就能用（组级动作 group.create_project）；
  // 要真实的目标库，用连不上的地址只验证鉴权 / 限速这一层
  'POST /api/connection-check': {
    access: { kind: 'group-create-project', statuses: [422] },
    body: (ctx) => ({ url: 'postgres://127.0.0.1:1/matrix', groupId: ctx.groupId }),
  },
  // 接手（P4c）：连接检查的兄弟，同样是组级动作 group.create_project；用连不上的地址只验证鉴权 / 限速这一层
  'POST /api/takeover/inspect': {
    access: { kind: 'group-create-project', statuses: [422] },
    body: (ctx) => ({ url: 'postgres://127.0.0.1:1/matrix', groupId: ctx.groupId }),
  },
  // 项目：可见性 404，权限不够 403
  'GET /api/projects': { access: { kind: 'authed', statuses: [200] } },
  'POST /api/projects': {
    access: { kind: 'group-create-project', statuses: [201] },
    body: (ctx) => ({ name: `矩阵项目 ${++unique}`, groupId: ctx.groupId }),
  },
  // 新建项目向导：同样是组级动作；空内容（blank）不需要目标库，所以直接 201（SSE 的 done 事件）
  'POST /api/projects/wizard': {
    access: { kind: 'group-create-project', statuses: [200] },
    body: (ctx) => ({ name: `向导项目 ${++unique}`, groupId: ctx.groupId, content: { kind: 'blank' } }),
  },
  'GET /api/projects/:pid': { access: { kind: 'project', min: 'viewer', statuses: [200] }, path: P },
  'PATCH /api/projects/:pid': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: P,
    body: () => ({}),
  },
  'POST /api/projects/:pid/transfer': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/transfer`,
    body: () => ({}),
  },
  'DELETE /api/projects/:pid': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: P,
    body: () => ({}),
  },
  'GET /api/resolve/:owner/:project': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: (ctx) => `/api/resolve/${ctx.groupSlug}/${ctx.projectSlug}`,
  },
  'POST /api/projects/:pid/import': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: () => `${P()}/import`,
    body: () => ({}),
  },
  'GET /api/projects/:pid/grants': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/grants`,
  },
  'POST /api/projects/:pid/grants': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/grants`,
    body: () => ({}),
  },
  'PATCH /api/projects/:pid/grants/:id': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/grants/matrix-project-grant`,
    body: () => ({}),
    prepare: async (ctx) => {
      await ensureGrant('matrix-project-grant', ctx.targetUserId, 'viewer', 'project', ctx.pid);
    },
  },
  'DELETE /api/projects/:pid/grants/:id': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: () => `${P()}/grants/matrix-project-grant`,
    prepare: async (ctx) => {
      await ensureGrant('matrix-project-grant', ctx.targetUserId, 'viewer', 'project', ctx.pid);
    },
  },
  'GET /api/projects/:pid/versions': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/versions`,
  },
  'GET /api/projects/:pid/versions/:vid': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: (ctx) => `${P()}/versions/${ctx.versionId}`,
  },
  // 编辑冻结脚本、重新验证：沿用发布的权限（编辑者）
  'PATCH /api/projects/:pid/versions/:vid/steps': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: (ctx) => `${P()}/versions/${ctx.versionId}/steps`,
    body: () => ({}),
  },
  'POST /api/projects/:pid/versions/:vid/verify': {
    // 项目没有环境，过了鉴权就是 422“还没有配置环境”
    access: { kind: 'project', min: 'editor', statuses: [422] },
    path: (ctx) => `${P()}/versions/${ctx.versionId}/verify`,
  },
  'GET /api/projects/:pid/activity': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/activity`,
  },
  'POST /api/projects/:pid/versions': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: () => `${P()}/versions`,
    body: () => ({}),
  },
  'GET /api/projects/:pid/migration': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/migration`,
  },
  'GET /api/projects/:pid/ddl': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/ddl`,
  },
  'POST /api/projects/:pid/verify': {
    access: { kind: 'project', min: 'viewer', statuses: [422] },
    path: () => `${P()}/verify`,
    body: () => ({}),
  },
  'GET /api/projects/:pid/environments': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/environments`,
  },
  'POST /api/projects/:pid/environments': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/environments`,
    body: () => ({}),
  },
  'DELETE /api/projects/:pid/environments/:eid': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/test': {
    access: { kind: 'project', min: 'viewer', statuses: [422] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/test`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/pull': {
    access: { kind: 'project', min: 'editor', statuses: [422] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/pull`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 环境的执行（P4b）。freshEnv 是非生产环境、没有显式设置执行档位 → 默认档位是项目编辑者；
  // 特权操作的档位规则（生产默认管理员、仅限执行者）在 exec-policy.test.ts 里逐项验证
  'PATCH /api/projects/:pid/environments/:eid': {
    // 改执行档位是配置类特权操作：除了档位，还要项目管理员
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}`,
    body: () => ({ execPolicy: 'admin' }),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'GET /api/projects/:pid/environments/:eid/status': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/status`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'GET /api/projects/:pid/environments/:eid/history': {
    access: { kind: 'project', min: 'viewer', statuses: [422] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/history`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/drift-check': {
    access: { kind: 'project', min: 'editor', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/drift-check`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/execute': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/execute`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/rollback': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/rollback`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 接入已有历史（P4c）：配置类特权操作，至少项目管理员（freshEnv 之外的新环境：请求体不合法 → 400）
  'POST /api/projects/:pid/environments/attach': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/environments/attach`,
    body: () => ({}),
  },
  // 认领（P4c）：实例管理员；连不上目标库 → 422
  'POST /api/projects/:pid/environments/:eid/claim': {
    access: { kind: 'project-instance-admin', statuses: [422] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/claim`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 标记为已执行（ADR 0004）：特权操作，按执行档位（freshEnv 是非生产、默认档位 = 编辑者）；请求体不合法 → 400
  'POST /api/projects/:pid/environments/:eid/mark': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/mark`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 修复脚本：只读平台库里缓存的漂移摘要，查看者就能看
  'GET /api/projects/:pid/environments/:eid/repair-script': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/repair-script`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/projects/:pid/environments/:eid/baseline': {
    // 通过鉴权后进入 SSE，连不上目标库以 error 事件结束（HTTP 状态仍是 200）
    access: { kind: 'project', min: 'editor', statuses: [200] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/baseline`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 执行申请（P5b）：项目可见即可列表 / 看详情；提交要编辑者（或执行者）；审批类操作看得到项目就能进到申请
  // 里的检查（不存在的申请 404；请求体不合法 400）；具体的资格规则在 requests.test.ts 里逐项验证
  'GET /api/projects/:pid/requests': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/requests`,
  },
  'POST /api/projects/:pid/environments/:eid/requests': {
    access: { kind: 'project', min: 'editor', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/requests`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'GET /api/projects/:pid/requests/:rid': {
    access: { kind: 'project', min: 'viewer', statuses: [404] },
    path: () => `${P()}/requests/no-such-request`,
  },
  'POST /api/projects/:pid/requests/:rid/approve': {
    access: { kind: 'project', min: 'viewer', statuses: [400] },
    path: () => `${P()}/requests/no-such-request/approve`,
    body: () => ({}),
  },
  'POST /api/projects/:pid/requests/:rid/reject': {
    access: { kind: 'project', min: 'viewer', statuses: [400] },
    path: () => `${P()}/requests/no-such-request/reject`,
    body: () => ({}),
  },
  'POST /api/projects/:pid/requests/:rid/withdraw': {
    access: { kind: 'project', min: 'viewer', statuses: [404] },
    path: () => `${P()}/requests/no-such-request/withdraw`,
    body: () => ({}),
  },
  'POST /api/projects/:pid/requests/:rid/execute': {
    access: { kind: 'project', min: 'viewer', statuses: [404] },
    path: () => `${P()}/requests/no-such-request/execute`,
    body: () => ({}),
  },
  // 紧急执行：只有实例管理员（项目看不见 404，其余 403）；请求体不合法 400
  'POST /api/projects/:pid/environments/:eid/emergency': {
    access: { kind: 'project-instance-admin', statuses: [400] },
    path: (ctx) => `${P()}/environments/${ctx.envId}/emergency`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  // 收件箱（P5b）：每个人只看自己的
  'GET /api/me/inbox': { access: { kind: 'authed', statuses: [200] } },
  'GET /api/me/inbox/pending': { access: { kind: 'authed', statuses: [200] } },
  'GET /api/me/requests': { access: { kind: 'authed', statuses: [200] } },
  'POST /api/me/inbox/read-all': { access: { kind: 'authed', statuses: [200] }, body: () => ({}) },
  'POST /api/me/inbox/:id/read': {
    access: { kind: 'authed', statuses: [404] },
    path: () => '/api/me/inbox/no-such-item/read',
    body: () => ({}),
  },
  'GET /api/me/inbox/stream': {
    access: { kind: 'authed', statuses: [200] },
    path: () => '/api/me/inbox/stream?once=1',
  },
  // 组级 Webhook（P5b）：组管理员 / 实例管理员
  'GET /api/groups/:slug/webhooks': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks`,
  },
  'POST /api/groups/:slug/webhooks': {
    access: { kind: 'group-admin', statuses: [400] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks`,
    body: () => ({}),
  },
  'PATCH /api/groups/:slug/webhooks/:id': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks/matrix-webhook`,
    body: () => ({ name: 'x' }),
    prepare: async (ctx) => matrixWebhook(ctx.groupId),
  },
  'DELETE /api/groups/:slug/webhooks/:id': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks/matrix-webhook`,
    prepare: async (ctx) => matrixWebhook(ctx.groupId),
  },
  'GET /api/groups/:slug/webhooks/:id/deliveries': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks/matrix-webhook/deliveries`,
    prepare: async (ctx) => matrixWebhook(ctx.groupId),
  },
  // 发送测试：127.0.0.1 被出站限制立即拒绝（不走网络），结果仍是 200 + ok:false
  'POST /api/groups/:slug/webhooks/:id/test': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/webhooks/matrix-webhook/test`,
    body: () => ({}),
    prepare: async (ctx) => matrixWebhook(ctx.groupId),
  },
  // CI 令牌管理与三层“谁能创建令牌”规则（P6）
  'GET /api/admin/token-policy': { access: { kind: 'instance', statuses: [200] } },
  'PUT /api/admin/token-policy': {
    access: { kind: 'instance', statuses: [200] },
    body: () => ({ rule: null }),
  },
  'GET /api/groups/:slug/token-policy': {
    access: { kind: 'group-read', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/token-policy`,
  },
  'PUT /api/groups/:slug/token-policy': {
    access: { kind: 'group-admin', statuses: [200] },
    path: (ctx) => `/api/groups/${ctx.groupSlug}/token-policy`,
    body: () => ({ rule: null }),
  },
  'GET /api/projects/:pid/token-policy': {
    access: { kind: 'project', min: 'viewer', statuses: [200] },
    path: () => `${P()}/token-policy`,
  },
  'PUT /api/projects/:pid/token-policy': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: () => `${P()}/token-policy`,
    body: () => ({ rule: null }),
  },
  'GET /api/projects/:pid/tokens': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: () => `${P()}/tokens`,
  },
  'POST /api/projects/:pid/tokens': {
    access: { kind: 'project', min: 'admin', statuses: [400] },
    path: () => `${P()}/tokens`,
    body: () => ({}),
  },
  'POST /api/projects/:pid/tokens/:tid/revoke': {
    access: { kind: 'project', min: 'admin', statuses: [200] },
    path: (ctx) => `${P()}/tokens/${ctx.tokenId}/revoke`,
    body: () => ({}),
    prepare: async (ctx) => {
      ctx.tokenId = await freshToken(ctx.pid, ++unique, adminUserId);
    },
  },
  // CI 令牌专用端点（/api/ci/*）
  'GET /api/ci/token': { access: { kind: 'ci', tokenStatuses: [200] } },
  'GET /api/ci/projects/:owner/:project': {
    access: { kind: 'ci', tokenStatuses: [200] },
    path: (ctx) => `/api/ci/projects/${ctx.groupSlug}/${ctx.projectSlug}`,
  },
  'GET /api/ci/projects/:owner/:project/versions': {
    access: { kind: 'ci', tokenStatuses: [200] },
    path: (ctx) => `/api/ci/projects/${ctx.groupSlug}/${ctx.projectSlug}/versions`,
  },
  'GET /api/ci/projects/:owner/:project/environments/:env': {
    access: { kind: 'ci', tokenStatuses: [200] },
    path: (ctx) => `/api/ci/projects/${ctx.groupSlug}/${ctx.projectSlug}/environments/${ctx.envName}`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'GET /api/ci/projects/:owner/:project/environments/:env/history': {
    access: { kind: 'ci', tokenStatuses: [502] },
    path: (ctx) => `/api/ci/projects/${ctx.groupSlug}/${ctx.projectSlug}/environments/${ctx.envName}/history`,
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'POST /api/ci/projects/:owner/:project/environments/:env/execute': {
    access: { kind: 'ci', tokenStatuses: [400] },
    path: (ctx) => `/api/ci/projects/${ctx.groupSlug}/${ctx.projectSlug}/environments/${ctx.envName}/execute`,
    body: () => ({}),
    prepare: async (ctx) => {
      const e = await freshEnv(ctx.pid, ++unique);
      ctx.envId = e.id;
      ctx.envName = e.name;
    },
  },
  'GET /api/projects/:pid/sync': { access: { kind: 'ws' } },
};

const expectedStatus = (access: Access, identity: Identity): number | number[] => {
  if (access.kind === 'public') return access.statuses;
  if (access.kind === 'ci') return [401];
  if (!identity.active) return 401;
  switch (access.kind) {
    case 'authed':
      return access.statuses ?? [200];
    case 'instance':
      return identity.instanceAdmin ? (access.statuses ?? [200]) : 403;
    case 'group-read':
      return access.statuses ?? [200];
    case 'group-admin':
      return identity.instanceAdmin || identity.groupRole === 'admin' ? (access.statuses ?? [200]) : 403;
    case 'create-group':
      return access.statuses ?? [201];
    case 'group-create-project':
      return identity.instanceAdmin || identity.groupRole ? (access.statuses ?? [201]) : 403;
    case 'project':
      if (!identity.projectRole) return 404;
      return RANK[identity.projectRole] >= RANK[access.min] ? (access.statuses ?? [200]) : 403;
    case 'project-instance-admin':
      if (!identity.projectRole && !identity.instanceAdmin) return 404;
      return identity.instanceAdmin ? (access.statuses ?? [200]) : 403;
    case 'ws':
      return 0;
  }
};

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    tokenFailLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    tokenLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
  });
  app = created.app;
  injectWebSocket = created.injectWebSocket;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };
  server = serve({ fetch: app.fetch, port: 0 });
  injectWebSocket(server);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const admin = await makeUser(db, 'admin', { role: 'admin' });
  adminUserId = admin.id;
  const ga = await makeUser(db, 'ga', { name: '组管理员' });
  const gm = await makeUser(db, 'gm', { name: '组成员' });
  const pv = await makeUser(db, 'pv', { name: '直接查看者' });
  const pe = await makeUser(db, 'pe', { name: '直接编辑者' });
  const pa = await makeUser(db, 'pa', { name: '直接项目管理员' });
  const gg = await makeUser(db, 'gg', { name: '组授权成员' });
  const outsider = await makeUser(db, 'outsider', { name: '无关用户' });
  const target = await makeUser(db, 'target', { name: '组成员目标' });
  const disabled = await makeUser(db, 'disabled', { name: '停用用户' });

  addIdentity({
    name: 'anon',
    cookie: '',
    active: false,
    instanceAdmin: false,
    groupRole: null,
    projectRole: null,
    userId: '',
  });
  const disabledCookie = await login('disabled');
  await db.query("update users set status = 'disabled' where id = $1", [disabled.id]);
  addIdentity({
    name: 'disabled',
    cookie: disabledCookie,
    active: false,
    instanceAdmin: false,
    groupRole: null,
    projectRole: null,
    userId: disabled.id,
  });

  const adminCookie = await login('admin');
  const gaCookie = await login('ga');
  const gmCookie = await login('gm');
  const pvCookie = await login('pv');
  const peCookie = await login('pe');
  const paCookie = await login('pa');
  const ggCookie = await login('gg');
  const outsiderCookie = await login('outsider');

  const group = await call(
    'POST',
    '/api/groups',
    {
      slug: 'matrix-g',
      name: '矩阵组',
      defaultRole: 'viewer',
      projectCreation: 'members',
    },
    adminCookie,
  );
  expect(group.status).toBe(201);
  const groupId = group.data.id as string;
  await call('POST', '/api/groups', { slug: 'matrix-h', name: '授权组', defaultRole: 'none' }, adminCookie);

  const project = await call(
    'POST',
    '/api/projects',
    {
      name: 'Matrix Project',
      groupId,
    },
    adminCookie,
  );
  expect(project.status).toBe(201);
  const pid = project.data.id as string;
  const projectSlug = project.data.slug as string;

  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')", [
    groupId,
    ga.id,
  ]);
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member')", [
    groupId,
    gm.id,
  ]);
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member')", [
    groupId,
    target.id,
  ]);
  const h = await call('GET', '/api/groups/matrix-h', undefined, adminCookie);
  const hId = h.data.id as string;
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member')", [
    hId,
    gg.id,
  ]);
  await db.query(
    `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
     values ('matrix-h-grant', 'group', $1, 'editor', 'project', $2)`,
    [hId, pid],
  );
  await ensureGrant('matrix-pv', pv.id, 'viewer', 'project', pid);
  await ensureGrant('matrix-pe', pe.id, 'editor', 'project', pid);
  await ensureGrant('matrix-pa', pa.id, 'admin', 'project', pid);
  await ensureGrant('matrix-group-grant', target.id, 'viewer', 'group', groupId);
  await ensureGrant('matrix-project-grant', target.id, 'viewer', 'project', pid);

  const invite = await call('POST', '/api/admin/invites', {}, adminCookie);
  expect(invite.status).toBe(201);

  const tok = await call('POST', `/api/projects/${pid}/tokens`, { name: 'matrix-ci' }, adminCookie);
  expect(tok.status).toBe(201);
  ciToken = tok.data.token as string;

  currentCtx = {
    pid,
    projectSlug,
    groupSlug: 'matrix-g',
    groupId,
    targetUserId: target.id,
    outsiderId: outsider.id,
    inviteToken: invite.data.token as string,
    envId: '',
    envName: '',
    tokenId: '',
    versionId: 'matrix-version',
  };
  // 一个已发布的版本（直接写库）：版本端点的路径要用它
  const [matrixBranch] = await db.query<{ id: string }>('select id from branches where project_id = $1', [
    pid,
  ]);
  await db.query(
    `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
     values ('matrix-version', $1, $2, 1, 'v1', $3::text::jsonb, 1, '[]'::text::jsonb, '[]'::text::jsonb, $4)`,
    [pid, matrixBranch!.id, JSON.stringify(emptyModel()), stepsChecksum([], [])],
  );

  addIdentity({
    name: 'admin',
    cookie: adminCookie,
    active: true,
    instanceAdmin: true,
    groupRole: null,
    projectRole: 'admin',
    userId: admin.id,
  });
  addIdentity({
    name: 'ga',
    cookie: gaCookie,
    active: true,
    instanceAdmin: false,
    groupRole: 'admin',
    projectRole: 'admin',
    userId: ga.id,
  });
  addIdentity({
    name: 'gm',
    cookie: gmCookie,
    active: true,
    instanceAdmin: false,
    groupRole: 'member',
    projectRole: 'viewer',
    userId: gm.id,
  });
  addIdentity({
    name: 'pv',
    cookie: pvCookie,
    active: true,
    instanceAdmin: false,
    groupRole: null,
    projectRole: 'viewer',
    userId: pv.id,
  });
  addIdentity({
    name: 'pe',
    cookie: peCookie,
    active: true,
    instanceAdmin: false,
    groupRole: null,
    projectRole: 'editor',
    userId: pe.id,
  });
  addIdentity({
    name: 'pa',
    cookie: paCookie,
    active: true,
    instanceAdmin: false,
    groupRole: null,
    projectRole: 'admin',
    userId: pa.id,
  });
  addIdentity({
    name: 'gg',
    cookie: ggCookie,
    active: true,
    instanceAdmin: false,
    groupRole: null,
    projectRole: 'editor',
    userId: gg.id,
  });
  addIdentity({
    name: 'outsider',
    cookie: outsiderCookie,
    active: true,
    instanceAdmin: false,
    groupRole: null,
    projectRole: null,
    userId: outsider.id,
  });
});

afterAll(async () => {
  await stop();
  await new Promise((r) => server.close(r));
  await db.close();
});

test('每个端点都在矩阵里登记', () => {
  const keys = app.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`);
  const missing = keys.filter((k) => !(k in matrix));
  expect(missing, `未登记到权限矩阵的端点：\n${missing.join('\n')}`).toEqual([]);
  const extra = Object.keys(matrix).filter((k) => !keys.includes(k));
  expect(extra, `矩阵里登记了不存在的端点：\n${extra.join('\n')}`).toEqual([]);
});

test('每个端点和身份都返回预期的状态码类别', async () => {
  for (const route of app.routes.filter((r) => r.method !== 'ALL')) {
    const key = `${route.method} ${route.path}`;
    const spec = matrix[key]!;
    if (spec.access.kind === 'ws') continue;
    for (const identity of identities) {
      const ctx: Ctx = { ...currentCtx };
      await spec.prepare?.(ctx, identity);
      const path = spec.path?.(ctx) ?? route.path;
      // 公开端点不发送会话 cookie：否则像“重新登录”这样的用例会轮换掉当前身份的会话
      const cookie = spec.access.kind === 'public' ? '' : identity.cookie;
      const res = await call(route.method, path, spec.body?.(ctx), cookie);
      const want = expectedStatus(spec.access, identity);
      const label = `${key} / ${identity.name}`;
      if (Array.isArray(want)) expect(want, `${label} 返回 ${res.status}`).toContain(res.status);
      else expect(res.status, label).toBe(want);
    }
  }
});

test('WebSocket：未登录 / 停用 / 无关用户被拒，查看者只读', async () => {
  const pid = currentCtx.pid;
  const wsUrl = `${base.replace('http', 'ws')}/api/projects/${pid}/sync`;

  // 未登录和停用用户：HTTP 升级返回 401
  for (const name of ['anon', 'disabled']) {
    const identity = byName.get(name)!;
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: identity.cookie ? { cookie: identity.cookie } : {} });
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.on('error', () => resolve(-1));
    });
    expect(status, name).toBe(401);
  }

  // 无关用户：升级成功，但 join 时生效角色为空，用 4401 关闭
  const outsider = byName.get('outsider')!;
  const outsiderClose = await new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: { cookie: outsider.cookie } });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve(-1));
  });
  expect(outsiderClose).toBe(4401);

  // 查看者：收到 role=viewer，修改被服务器拒绝
  const viewer = byName.get('pv')!;
  const ws = new WebSocket(wsUrl, { headers: { cookie: viewer.cookie } });
  const client = new SyncClient('matrix-viewer', { format: 1, dialect: 'pg', objects: {} });
  client.send = (m) => ws.send(JSON.stringify(m));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ToClient | { t: string };
    if (['welcome', 'snapshot', 'commit', 'reject'].includes(m.t)) client.receive(m as ToClient);
  });
  await new Promise((r) => ws.once('open', r));
  client.connect();
  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(() => client.ready);
  const schema = all(client.view, 'schema')[0]!.id;
  client.mutate('createTable', { id: 'matrix-table', schema, name: 'viewer_table' });
  await until(() => client.notices.length > 0);
  expect(client.notices.at(-1)!.message).toContain('查看者');
  ws.close();
});

test('CI 令牌：访问所有非 /api/ci 端点一律 403 forbidden（不回落到 cookie），只允许访问 /api/ci/*', async () => {
  const admin = byName.get('admin')!;
  for (const route of app.routes.filter((r) => r.method !== 'ALL')) {
    const key = `${route.method} ${route.path}`;
    const spec = matrix[key]!;
    if (spec.access.kind === 'ws') continue;
    const ctx: Ctx = { ...currentCtx };
    await spec.prepare?.(ctx, admin);
    const path = spec.path?.(ctx) ?? route.path;
    const res = await call(route.method, path, spec.body?.(ctx), admin.cookie, {
      authorization: `Bearer ${ciToken}`,
    });
    if (spec.access.kind === 'ci') {
      expect(spec.access.tokenStatuses, `${key} / ciToken 返回 ${res.status}`).toContain(res.status);
    } else {
      expect(res.status, `CI 令牌访问非允许端点 ${key} 应为 403`).toBe(403);
      expect(res.data, key).toMatchObject({ ok: false, code: 'forbidden' });
    }
  }
  // WebSocket 同步接口带 CI 令牌同样被 403 拒绝
  const wsUrl = `${base.replace('http', 'ws')}/api/projects/${currentCtx.pid}/sync`;
  const wsStatus = await new Promise<number>((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${ciToken}`, cookie: admin.cookie },
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    });
    ws.on('error', () => resolve(-1));
  });
  expect(wsStatus).toBe(403);
});
