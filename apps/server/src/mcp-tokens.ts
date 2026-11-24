// 个人 MCP 令牌（M3-C，ADR 0014）：生成、认证、批量吊销。管理接口在 routes/mcp-tokens.ts，MCP 服务在 routes/mcp.ts。
// - 明文 `dwm_` + 32 字节随机数（base64url，43 个字符），创建时只返回一次；库里只存 SHA-256（和 CI 令牌、会话同一个做法，ADR 0009）。
// - 令牌属于用户：权限 = 用户**当前**生效角色 ∩ 令牌 scope ∩ 可选项目白名单（每个请求实时算，降权立即生效）。
// - 每个请求都查库：令牌吊销 / 过期、用户停用（401）、用户需要改密码（403 password_change_required）立即生效。
// - 停用、管理员重置密码、使用重置密码链接时吊销该用户的全部 MCP 令牌（revokeAllMcpTokens）；自己改密码不吊销。
import { randomBytes } from 'node:crypto';

import {
  MCP_TOKEN_DISPLAY_LENGTH,
  MCP_TOKEN_PATTERN,
  MCP_TOKEN_PREFIX,
  type McpRevokeReason,
  mcpRevokeReasonSchema,
  type McpScope,
  type McpTokenInfo,
  mcpTokenKindSchema,
  type McpTokenProjectRef,
  type McpTokenStatus,
  normalizeMcpScopes,
} from '@dowel/api';
import type { Db } from '@dowel/engines';

import { hashToken, type User } from './auth.ts';
import { inList } from './db.ts';
import { iso } from './envs.ts';
import { effectiveRole, loadRoleContext, type ProjectRoleInput } from './roles.ts';
import { userById } from './users.ts';

/** 认证后挂在 /api/mcp 请求上的主体 */
export interface McpPrincipal {
  tokenId: string;
  tokenName: string;
  prefix: string;
  /** 令牌的主人（实时从 users 表读出；状态已确认 active、不需要改密码） */
  user: User;
  /** 规范化后的 scope（总是含 read） */
  scopes: ReadonlySet<McpScope>;
  /** 项目白名单；null = 用户能看到的全部项目 */
  projectIds: readonly string[] | null;
  expiresAt: string;
}

export type McpAuthFailure =
  | 'token_missing'
  | 'token_invalid'
  | 'token_expired'
  | 'token_revoked'
  | 'user_disabled'
  | 'password_change_required';

/** 新令牌：明文、哈希、用来辨认的前缀 */
export const newMcpToken = () => {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, MCP_TOKEN_DISPLAY_LENGTH) };
};

/** Authorization 头里的 MCP 令牌：只认 `Bearer dwm_…`（大小写不敏感的 Bearer） */
export const bearerMcpToken = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec((header ?? '').trim());
  return m?.[1]?.startsWith(MCP_TOKEN_PREFIX) ? m[1] : null;
};

/** 多久更新一次 last_used_at（和 CI 令牌一样） */
const USED_EVERY_MS = 60_000;

const parseJsonArray = (v: unknown): unknown[] | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
};

export const parseScopes = (v: unknown): McpScope[] =>
  normalizeMcpScopes((parseJsonArray(v) ?? []).filter((x): x is string => typeof x === 'string'));

export const parseProjectIds = (v: unknown): string[] | null => {
  const arr = parseJsonArray(v);
  return arr === null ? null : arr.filter((x): x is string => typeof x === 'string');
};

/**
 * 用明文换主体：格式不对 / 不存在 → token_invalid；已吊销 → token_revoked；已过期 → token_expired；
 * 用户被停用 → user_disabled；用户需要先改密码 → password_change_required。吊销先于过期判断。
 * 成功时按需更新最后使用时间和来源 IP。
 */
export const authenticateMcpToken = async (
  db: Db,
  raw: string | null,
  ip: string | null,
): Promise<{ ok: true; principal: McpPrincipal } | { ok: false; code: McpAuthFailure }> => {
  if (raw === null) return { ok: false, code: 'token_missing' };
  if (!MCP_TOKEN_PATTERN.test(raw)) return { ok: false, code: 'token_invalid' };
  const [row] = await db.query<{
    id: string;
    userId: string;
    name: string;
    prefix: string;
    scopes: unknown;
    projectIds: unknown;
    expiresAt: unknown;
    revokedAt: unknown;
    lastUsedAt: unknown;
  }>(
    `select id, user_id as "userId", name, prefix, scopes, project_ids as "projectIds",
            expires_at as "expiresAt", revoked_at as "revokedAt", last_used_at as "lastUsedAt"
       from mcp_tokens where token_hash = $1`,
    [hashToken(raw)],
  );
  if (!row) return { ok: false, code: 'token_invalid' };
  if (row.revokedAt !== null && row.revokedAt !== undefined) return { ok: false, code: 'token_revoked' };
  const expiresAt = iso(row.expiresAt)!;
  if (Date.parse(expiresAt) <= Date.now()) return { ok: false, code: 'token_expired' };
  const user = await userById(db, row.userId);
  if (!user) return { ok: false, code: 'token_invalid' };
  if (user.status !== 'active') return { ok: false, code: 'user_disabled' };
  if (user.mustChangePassword) return { ok: false, code: 'password_change_required' };
  const last = iso(row.lastUsedAt);
  if (!last || Date.now() - Date.parse(last) > USED_EVERY_MS)
    await db.query('update mcp_tokens set last_used_at = $2, last_used_ip = $3 where id = $1', [
      row.id,
      new Date().toISOString(),
      ip,
    ]);
  return {
    ok: true,
    principal: {
      tokenId: row.id,
      tokenName: row.name,
      prefix: row.prefix,
      user,
      scopes: new Set(parseScopes(row.scopes)),
      projectIds: parseProjectIds(row.projectIds),
      expiresAt,
    },
  };
};

/**
 * 吊销某个用户的全部未吊销 MCP 令牌（停用、管理员重置密码、使用重置密码链接时调用；可在调用方事务里执行）。
 * 返回吊销的个数。调用方负责在事务提交后发布 `mcp_tokens.changed`、清理本副本缓存，并写 `mcp_token.revoke_all` 审计（count > 0 时）。
 */
export const revokeAllMcpTokens = async (
  db: Db,
  userId: string,
  reason: Extract<McpRevokeReason, 'user_disabled' | 'password_reset'>,
  by: string | null,
): Promise<number> => {
  const rows = await db.query<{ id: string }>(
    `update mcp_tokens set revoked_at = $2, revoked_by = $3, revoked_reason = $4
      where user_id = $1 and revoked_at is null returning id`,
    [userId, new Date().toISOString(), by, reason],
  );
  return rows.length;
};

interface McpTokenRow {
  id: string;
  kind: string;
  name: string;
  prefix: string;
  scopes: unknown;
  projectIds: unknown;
  createdAt: unknown;
  expiresAt: unknown;
  lastUsedAt: unknown;
  lastUsedIp: string | null;
  revokedAt: unknown;
  revokedBy: string | null;
  revokedByName: string | null;
  revokedReason: string | null;
}

const MCP_TOKEN_SELECT = `select t.id, t.kind, t.name, t.prefix, t.scopes, t.project_ids as "projectIds",
    t.created_at as "createdAt", t.expires_at as "expiresAt", t.last_used_at as "lastUsedAt",
    t.last_used_ip as "lastUsedIp", t.revoked_at as "revokedAt", t.revoked_by as "revokedBy",
    ru.name as "revokedByName", t.revoked_reason as "revokedReason"
  from mcp_tokens t
  left join users ru on ru.id = t.revoked_by`;

/** 令牌状态：吊销优先于过期（与 CI 令牌一致） */
export const mcpTokenStatus = (
  r: { revokedAt: unknown; expiresAt: unknown },
  now = Date.now(),
): McpTokenStatus =>
  r.revokedAt !== null && r.revokedAt !== undefined
    ? 'revoked'
    : Date.parse(iso(r.expiresAt)!) <= now
      ? 'expired'
      : 'active';

interface VisibleProjectRow extends ProjectRoleInput {
  name: string;
  slug: string;
  groupSlug: string;
}

/**
 * 解析一组项目 ID 中调用者当前可见的项目（已删除或无权查看的不会出现在返回 Map 里）。
 * 用于创建令牌时校验白名单，以及在列表/详情里把 projectIds 解析成 { id, path, name }。
 */
export const resolveVisibleMcpProjects = async (
  db: Db,
  projectIds: readonly string[],
  viewer: { id: string; role: string },
): Promise<Map<string, { path: string; name: string }>> => {
  const ids = [...new Set(projectIds)];
  const out = new Map<string, { path: string; name: string }>();
  if (!ids.length) return out;
  const rows = await db.query<VisibleProjectRow>(
    `select p.id, p.name, p.slug, p.group_id as "groupId", g.slug as "groupSlug",
            cast(g.default_role as text) as "groupDefaultRole",
            cast(p.default_role as text) as "projectDefaultRole"
       from projects p
       join groups g on g.id = p.group_id
      where p.id in (${inList(ids)})`,
    ids,
  );
  if (!rows.length) return out;
  if (viewer.role === 'admin') {
    for (const p of rows) out.set(p.id, { path: `${p.groupSlug}/${p.slug}`, name: p.name });
    return out;
  }
  const rc = await loadRoleContext(db, viewer);
  for (const p of rows) {
    if (effectiveRole(rc, p) !== null) out.set(p.id, { path: `${p.groupSlug}/${p.slug}`, name: p.name });
  }
  return out;
};

const toMcpTokenInfo = (
  r: McpTokenRow,
  visible: ReadonlyMap<string, { path: string; name: string }>,
  now: number,
): McpTokenInfo => {
  const parsedKind = mcpTokenKindSchema.safeParse(r.kind);
  const parsedReason = mcpRevokeReasonSchema.safeParse(r.revokedReason);
  const pids = parseProjectIds(r.projectIds);
  const projects: McpTokenProjectRef[] | null =
    pids === null
      ? null
      : pids.map((id) => {
          const p = visible.get(id);
          return { id, path: p?.path ?? null, name: p?.name ?? null };
        });
  return {
    id: r.id,
    kind: parsedKind.success ? parsedKind.data : 'personal',
    name: r.name,
    prefix: r.prefix,
    scopes: parseScopes(r.scopes),
    projects,
    createdAt: iso(r.createdAt)!,
    expiresAt: iso(r.expiresAt)!,
    lastUsedAt: iso(r.lastUsedAt),
    lastUsedIp: r.lastUsedIp,
    revokedAt: iso(r.revokedAt),
    revokedBy: r.revokedBy ? { id: r.revokedBy, name: r.revokedByName ?? r.revokedBy } : null,
    revokedReason: parsedReason.success ? parsedReason.data : null,
    status: mcpTokenStatus(r, now),
  };
};

/** 列出指定用户的全部 MCP 令牌：有效令牌在前，再按创建时间新到旧排序 */
export const listMcpTokens = async (
  db: Db,
  userId: string,
  viewer: { id: string; role: string },
): Promise<McpTokenInfo[]> => {
  const rows = await db.query<McpTokenRow>(
    `${MCP_TOKEN_SELECT} where t.user_id = $1 order by t.created_at desc, t.id desc`,
    [userId],
  );
  if (!rows.length) return [];
  const allProjectIds = rows.flatMap((r) => parseProjectIds(r.projectIds) ?? []);
  const visible = await resolveVisibleMcpProjects(db, allProjectIds, viewer);
  const now = Date.now();
  const items = rows.map((r) => toMcpTokenInfo(r, visible, now));
  items.sort(
    (a, b) =>
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
  return items;
};

/** 加载指定用户的单个 MCP 令牌详情；不存在返回 null */
export const loadMcpToken = async (
  db: Db,
  userId: string,
  tokenId: string,
  viewer: { id: string; role: string },
): Promise<McpTokenInfo | null> => {
  const [row] = await db.query<McpTokenRow>(`${MCP_TOKEN_SELECT} where t.user_id = $1 and t.id = $2`, [
    userId,
    tokenId,
  ]);
  if (!row) return null;
  const pids = parseProjectIds(row.projectIds);
  const visible = pids ? await resolveVisibleMcpProjects(db, pids, viewer) : new Map();
  return toMcpTokenInfo(row, visible, Date.now());
};

/** 统计指定用户当前未吊销且未过期的 MCP 令牌数量 */
export const countActiveMcpTokens = async (
  db: Db,
  userId: string,
  nowIso = new Date().toISOString(),
): Promise<number> => {
  const [row] = await db.query<{ n: number }>(
    'select count(*) as n from mcp_tokens where user_id = $1 and revoked_at is null and expires_at > $2',
    [userId, nowIso],
  );
  return Number(row?.n ?? 0);
};
