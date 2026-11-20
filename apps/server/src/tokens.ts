// CI 令牌（P6 T1，ADR 0009）：生成、认证、列表、吊销。
// - 明文 `dwl_` + 32 字节随机数（base64url，43 个字符），创建时只返回一次；库里只存 SHA-256（和会话、邀请令牌同一个做法）。
//   令牌本身有 256 位熵，离线撞不出来，所以不需要慢哈希，也不用 HMAC：HMAC 会让令牌依赖 DOWEL_SECRET，换密钥就让所有流水线失效。
// - 令牌属于项目：创建者离职、被停用都不影响；吊销和过期立即生效（每个请求都查库）。
// - 能力只有“只读 + 执行”（authz.ts 的 CiAction），只能访问 /api/ci/…，别的接口一律 403（routes/index.ts 的 rejectTokens）。
import { randomBytes } from 'node:crypto';
import {
  type CiTokenInfo,
  type CiTokenStatus,
  TOKEN_DISPLAY_LENGTH,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import { hashToken } from './auth.ts';
import type { Actor } from './authz.ts';
import { iso } from './envs.ts';

/** 认证后挂在请求上的令牌信息 */
export interface CiTokenAuth {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdBy: string | null;
  createdByName: string | null;
  expiresAt: string;
}

export const tokenActor = (t: Pick<CiTokenAuth, 'id' | 'projectId'>): Actor => ({
  kind: 'token',
  id: t.id,
  projectId: t.projectId,
});

/** 新令牌：明文、哈希、用来辨认的前缀 */
export const newCiToken = () => {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, TOKEN_DISPLAY_LENGTH) };
};

/** 多久更新一次 last_used_at：每个请求都写一次没必要（和会话的 last_seen_at 一样） */
const USED_EVERY_MS = 60_000;

export type TokenAuthFailure = 'token_missing' | 'token_invalid' | 'token_expired' | 'token_revoked';

/** Authorization 头里的令牌：只认 `Bearer dwl_…`；别的 Bearer（例如反向代理转发的 OIDC 令牌）不当作 CI 令牌 */
export const bearerToken = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec((header ?? '').trim());
  return m?.[1]?.startsWith(TOKEN_PREFIX) ? m[1] : null;
};

/**
 * `/api/ci/*` 专用：区分“完全没带 Authorization 头”（token_missing）和“带了但格式不对 / 不是 dwl_”（token_invalid）。
 */
export const ciAuthHeader = (header: string | undefined): string | null => {
  if (!header?.trim()) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return m?.[1] ?? '';
};

/** 锁内复查令牌是否仍然有效（等执行锁期间可能被吊销或过期） */
export const recheckToken = async (
  db: Db,
  id: string,
): Promise<'ok' | 'token_invalid' | 'token_revoked' | 'token_expired'> => {
  const [row] = await db.query<{ expiresAt: unknown; revokedAt: unknown }>(
    'select expires_at as "expiresAt", revoked_at as "revokedAt" from ci_tokens where id = $1',
    [id],
  );
  if (!row) return 'token_invalid';
  if (row.revokedAt !== null && row.revokedAt !== undefined) return 'token_revoked';
  if (Date.parse(iso(row.expiresAt)!) <= Date.now()) return 'token_expired';
  return 'ok';
};

/**
 * 用明文换令牌：格式不对 / 不存在 → token_invalid；已吊销 → token_revoked；已过期 → token_expired。
 * 吊销先于过期判断（吊销是人为的动作，说明更准确）。成功时按需更新最后使用时间和来源 IP。
 */
export const authenticateToken = async (
  db: Db,
  raw: string | null,
  ip: string | null,
): Promise<{ ok: true; token: CiTokenAuth } | { ok: false; code: TokenAuthFailure }> => {
  if (raw === null) return { ok: false, code: 'token_missing' };
  if (!TOKEN_PATTERN.test(raw)) return { ok: false, code: 'token_invalid' };
  const hash = hashToken(raw);
  const [row] = await db.query<{
    id: string;
    projectId: string;
    name: string;
    prefix: string;
    createdBy: string | null;
    createdByName: string | null;
    expiresAt: unknown;
    revokedAt: unknown;
    lastUsedAt: unknown;
  }>(
    `select t.id, t.project_id as "projectId", t.name, t.prefix, t.created_by as "createdBy",
            u.name as "createdByName", t.expires_at as "expiresAt", t.revoked_at as "revokedAt",
            t.last_used_at as "lastUsedAt"
       from ci_tokens t left join users u on u.id = t.created_by
      where t.token_hash = $1`,
    [hash],
  );
  if (!row) return { ok: false, code: 'token_invalid' };
  if (row.revokedAt !== null && row.revokedAt !== undefined) return { ok: false, code: 'token_revoked' };
  const expiresAt = iso(row.expiresAt)!;
  if (Date.parse(expiresAt) <= Date.now()) return { ok: false, code: 'token_expired' };
  const last = iso(row.lastUsedAt);
  if (!last || Date.now() - Date.parse(last) > USED_EVERY_MS)
    await db.query('update ci_tokens set last_used_at = $2, last_used_ip = $3 where id = $1', [
      row.id,
      new Date().toISOString(),
      ip,
    ]);
  return {
    ok: true,
    token: {
      id: row.id,
      projectId: row.projectId,
      name: row.name,
      prefix: row.prefix,
      createdBy: row.createdBy,
      createdByName: row.createdByName,
      expiresAt,
    },
  };
};

interface TokenRow {
  id: string;
  name: string;
  description: string;
  prefix: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: unknown;
  expiresAt: unknown;
  lastUsedAt: unknown;
  lastUsedIp: string | null;
  revokedAt: unknown;
  revokedBy: string | null;
  revokedByName: string | null;
}

const TOKEN_SELECT = `select t.id, t.name, t.description, t.prefix, t.created_by as "createdBy", cu.name as "createdByName",
    t.created_at as "createdAt", t.expires_at as "expiresAt", t.last_used_at as "lastUsedAt",
    t.last_used_ip as "lastUsedIp", t.revoked_at as "revokedAt", t.revoked_by as "revokedBy",
    ru.name as "revokedByName"
  from ci_tokens t
  left join users cu on cu.id = t.created_by
  left join users ru on ru.id = t.revoked_by`;

export const tokenStatus = (
  r: { revokedAt: unknown; expiresAt: unknown },
  now = Date.now(),
): CiTokenStatus =>
  r.revokedAt !== null && r.revokedAt !== undefined
    ? 'revoked'
    : Date.parse(iso(r.expiresAt)!) <= now
      ? 'expired'
      : 'active';

const toInfo = (r: TokenRow, canRevoke: (r: TokenRow) => boolean): CiTokenInfo => {
  const status = tokenStatus(r);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    prefix: r.prefix,
    createdBy: r.createdBy ? { id: r.createdBy, name: r.createdByName ?? r.createdBy } : null,
    createdAt: iso(r.createdAt)!,
    expiresAt: iso(r.expiresAt)!,
    lastUsedAt: iso(r.lastUsedAt),
    lastUsedIp: r.lastUsedIp,
    revokedAt: iso(r.revokedAt),
    revokedBy: r.revokedBy ? { id: r.revokedBy, name: r.revokedByName ?? r.revokedBy } : null,
    status,
    // 已吊销的不能再吊销；过期的仍可吊销（让列表里的状态更明确，也防止有人以后延长有效期的误操作——目前没有延长入口）
    canRevoke: status !== 'revoked' && canRevoke(r),
  };
};

/** 项目的全部令牌（新的在前）；canRevoke 由调用方按身份给出 */
export const listTokens = async (
  db: Db,
  pid: string,
  canRevoke: (createdBy: string | null) => boolean,
): Promise<CiTokenInfo[]> => {
  const rows = await db.query<TokenRow>(
    `${TOKEN_SELECT} where t.project_id = $1 order by t.created_at desc`,
    [pid],
  );
  return rows.map((r) => toInfo(r, (x) => canRevoke(x.createdBy)));
};

export const loadToken = async (
  db: Db,
  pid: string,
  tid: string,
  canRevoke: (createdBy: string | null) => boolean = () => false,
): Promise<CiTokenInfo | null> => {
  const [r] = await db.query<TokenRow>(`${TOKEN_SELECT} where t.project_id = $1 and t.id = $2`, [pid, tid]);
  return r ? toInfo(r, (x) => canRevoke(x.createdBy)) : null;
};
