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

export interface ActiveTokenCacheOptions {
  /** 活跃令牌哈希快照的刷新间隔（毫秒）；默认 15 秒 */
  ttlMs?: number;
  /** 内存缓存的活跃令牌哈希上限；默认 10_000 */
  maxEntries?: number;
  /** 时钟（测试可注入） */
  now?: () => number;
  /**
   * 哪张令牌表：ci_tokens（默认，归属列 project_id）或 mcp_tokens（M3-C，归属列 user_id）。
   * 缓存条目里的 projectId 字段对 MCP 令牌存的是用户 ID（forgetProject 对应“按归属清理”）。
   */
  table?: 'ci_tokens' | 'mcp_tokens';
}

interface CachedTokenEntry {
  id: string;
  /** 归属：CI 令牌是项目 ID，MCP 令牌是用户 ID */
  projectId: string;
  expiresAtMs: number;
}

/**
 * 进程内活跃 CI 令牌哈希缓存（仅供来源 IP 触发失败限流时判断是否放行，绝不替代数据库强校验）：
 * - 正常流量（IP 未超失败上限）完全惰性，不查库、不占内存；
 * - 当某 IP 触发失败限流后，惰性加载一次未吊销且未过期的 token_hash 快照并在 ttlMs 内复用（并发去重）；
 * - 合法活跃令牌（含首次使用的冷态令牌）命中快照后仍进入 authenticateToken 做数据库校验，避免被同 IP 的异常流量阻断；
 * - 无效 / 过期 / 已吊销 / 随机爆破令牌未命中快照，直接返回 429，不继续打数据库。
 */
export class ActiveTokenCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly table: 'ci_tokens' | 'mcp_tokens';
  private entries: Map<string, CachedTokenEntry> | null = null;
  private lastLoadedAt = Number.NEGATIVE_INFINITY;
  private dirty = false;
  private loading: Promise<void> | null = null;

  constructor(db: Db, options: ActiveTokenCacheOptions = {}) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? 15_000;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
    this.table = options.table ?? 'ci_tokens';
  }

  /** 是否在活跃令牌快照中且未过期（仅在来源 IP 已超失败限流上限时调用） */
  async hasActive(tokenHash: string): Promise<boolean> {
    const t = this.now();
    if (this.entries === null || this.dirty || t - this.lastLoadedAt >= this.ttlMs) {
      await this.refresh();
      // 若在刷新查询进行期间又发生了创建 / 吊销 / 删项目等变更，再补刷一次保证立即生效
      if (this.dirty) await this.refresh();
    }
    const entry = this.entries?.get(tokenHash);
    if (!entry) return false;
    if (entry.expiresAtMs <= this.now()) {
      this.entries!.delete(tokenHash);
      return false;
    }
    return true;
  }

  /** 记录新创建或刚通过校验的活跃令牌（仅在快照已初始化时维护；若正在刷新则标记脏等待重刷） */
  remember(tokenHash: string, entry: CachedTokenEntry): void {
    if (this.loading !== null) this.dirty = true;
    if (this.entries === null) return;
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(tokenHash);
      return;
    }
    this.entries.delete(tokenHash);
    if (this.entries.size >= this.maxEntries) {
      for (const k of this.entries.keys()) {
        this.entries.delete(k);
        if (this.entries.size < this.maxEntries) break;
      }
    }
    this.entries.set(tokenHash, entry);
  }

  /** 按哈希移除（认证失败返回无效 / 过期 / 吊销时立即清理） */
  forgetHash(tokenHash: string): void {
    if (this.loading !== null) this.dirty = true;
    this.entries?.delete(tokenHash);
  }

  /** 按令牌 ID 移除（吊销后立即清理） */
  forgetId(tokenId: string): void {
    if (this.loading !== null) this.dirty = true;
    if (!this.entries) return;
    for (const [hash, entry] of this.entries) {
      if (entry.id === tokenId) this.entries.delete(hash);
    }
  }

  /** 按项目移除（删项目后立即清理其令牌） */
  forgetProject(projectId: string): void {
    if (this.loading !== null) this.dirty = true;
    if (!this.entries) return;
    for (const [hash, entry] of this.entries) {
      if (entry.projectId === projectId) this.entries.delete(hash);
    }
  }

  /** 标记快照过期（多副本收到集群变更事件或断线重连时调用） */
  markStale(): void {
    if (this.entries !== null || this.loading !== null) this.dirty = true;
  }

  private async refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.dirty = false;
      const started = this.now();
      const rows = await this.db.query<{
        tokenHash: string;
        id: string;
        projectId: string;
        expiresAt: unknown;
      }>(
        `select token_hash as "tokenHash", id, ${this.table === 'mcp_tokens' ? 'user_id' : 'project_id'} as "projectId",
                expires_at as "expiresAt"
           from ${this.table}
          where revoked_at is null and expires_at > $1
          order by coalesce(last_used_at, created_at) desc
          limit $2`,
        [new Date(started).toISOString(), this.maxEntries],
      );
      const next = new Map<string, CachedTokenEntry>();
      // 倒序写入，让最近活跃的排在 Map 尾部，超出上限时优先淘汰头部最久未活跃的条目
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]!;
        const expiresAtMs = Date.parse(iso(r.expiresAt)!);
        if (expiresAtMs > started) {
          next.set(r.tokenHash, { id: r.id, projectId: r.projectId, expiresAtMs });
        }
      }
      this.entries = next;
      this.lastLoadedAt = started;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }
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

export const tokenStatus = (r: { revokedAt: unknown; expiresAt: unknown }, now = Date.now()): CiTokenStatus =>
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
