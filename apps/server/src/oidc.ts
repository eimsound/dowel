// 通用 OIDC（A7）：提供方配置、发现（discovery）、短时登录状态、身份关联和首次开户。
// 规则见 02-consensus.md 11.1：按“提供方 + subject”识别，邮箱绝不用于自动关联；
// 未被邀请者被拒绝，除非该提供方开了 auto_provision。
import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { OidcProviderInfo, OidcProviderPreset } from '@dowel/api';
import type { Db } from '@dowel/engines';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { allowInsecureRequests, type Configuration, discovery, fetchUserInfo } from 'openid-client';

import { hashToken, type User } from './auth.ts';
import type { PlatformDb } from './db.ts';
import { claimInvite, inviteByToken, inviteState, setInviteUsedBy } from './invites.ts';
import { decrypt } from './secrets.ts';
import { expectedOrigin, type SecurityConfig } from './security.ts';
import { cleanSlug, normalizeUsername } from './usernames.ts';
import { createUser } from './users.ts';

/** 短时状态（state / nonce / PKCE verifier / 邀请令牌）的有效期 */
export const OIDC_TTL_MS = 10 * 60_000;

export interface OidcProvider {
  id: string;
  slug: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  scopes: string;
  enabled: boolean;
  autoProvision: boolean;
  createdAt: string;
  updatedAt: string;
}

const SELECT = `p.id, p.slug, p.name, p.issuer, p.client_id as "clientId",
  p.client_secret_enc as "clientSecretEnc", p.scopes, p.enabled, p.auto_provision as "autoProvision",
  p.created_at as "createdAt", p.updated_at as "updatedAt"`;

export const listProviders = (db: Db): Promise<OidcProvider[]> =>
  db.query<OidcProvider>(`select ${SELECT} from oidc_providers p order by p.created_at, p.id`);

export const enabledProviders = (db: Db): Promise<OidcProvider[]> =>
  db.query<OidcProvider>(
    `select ${SELECT} from oidc_providers p where p.enabled = true order by p.name, p.slug`,
  );

export const countEnabledProviders = async (db: Db): Promise<number> => {
  const [row] = await db.query<{ n: number }>(
    'select count(*) as n from oidc_providers where enabled = true',
  );
  return Number(row?.n ?? 0);
};

export const publicProviders = async (db: Db): Promise<{ slug: string; name: string }[]> =>
  (await enabledProviders(db)).map((p) => ({ slug: p.slug, name: p.name }));

export const providerById = async (db: Db, id: string): Promise<OidcProvider | null> => {
  const [p] = await db.query<OidcProvider>(`select ${SELECT} from oidc_providers p where p.id = $1`, [id]);
  return p ?? null;
};

export const providerBySlug = async (db: Db, slug: string): Promise<OidcProvider | null> => {
  const [p] = await db.query<OidcProvider>(`select ${SELECT} from oidc_providers p where p.slug = $1`, [
    normalizeUsername(slug),
  ]);
  return p ?? null;
};

/** 不含回调地址：那个地址与请求的对外地址有关，由路由（routes/oidc.ts）拼上 */
export const providerInfo = (p: OidcProvider): Omit<OidcProviderInfo, 'callbackUrl'> => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  issuer: p.issuer,
  clientId: p.clientId,
  scopes: p.scopes,
  enabled: p.enabled,
  autoProvision: p.autoProvision,
  hasSecret: !!p.clientSecretEnc,
  createdAt: p.createdAt,
});

/** 预设模板：只带 issuer 和文档，client_id / secret 由实例管理员填 */
export const OIDC_PRESETS: OidcProviderPreset[] = [
  {
    key: 'google',
    name: 'Google',
    issuer: 'https://accounts.google.com',
    docUrl: 'https://developers.google.com/identity/openid-connect/openid-connect',
    scopes: 'openid profile email',
  },
  {
    key: 'gitlab',
    name: 'GitLab',
    issuer: 'https://gitlab.com',
    docUrl: 'https://docs.gitlab.com/ee/integration/openid_connect_provider.html',
    scopes: 'openid profile email',
  },
];

const isLoopback = (url: URL) =>
  url.hostname === 'localhost' ||
  url.hostname === '127.0.0.1' ||
  url.hostname === '::1' ||
  url.hostname === '[::1]';

interface DiscoveryCacheEntry {
  key: string;
  config: Configuration;
  expiresAt: number;
}

/** discovery 缓存：provider id → 配置指纹（issuer / client_id / secret / updated_at）+ 1 小时 TTL */
const discoveryCache = new Map<string, DiscoveryCacheEntry>();
const DISCOVERY_TTL_MS = 60 * 60_000;

const discoveryCacheKey = (p: OidcProvider) =>
  [p.issuer, p.clientId, p.clientSecretEnc, p.updatedAt].join('\0');

/** 测试和配置删除时清缓存 */
export const clearDiscoveryCache = (providerId?: string) => {
  if (providerId) discoveryCache.delete(providerId);
  else discoveryCache.clear();
};

/**
 * 做一次 discovery，并用它构造 openid-client 的 Configuration。
 * 保存提供方时先调用一次：配错了在保存时就返回 422，而不是等用户点登录才失败。
 * HTTP 只允许回环地址（本地开发和测试用），生产提供方必须是 HTTPS。
 * 按 provider id + 配置指纹缓存 1 小时；updated_at 变化后自动失效。
 */
export const discoverProvider = async (p: OidcProvider): Promise<Configuration> => {
  const key = discoveryCacheKey(p);
  const hit = discoveryCache.get(p.id);
  if (hit && hit.key === key && hit.expiresAt > Date.now()) return hit.config;
  const issuer = new URL(p.issuer);
  const options = isLoopback(issuer) ? { execute: [allowInsecureRequests] } : undefined;
  const config = await discovery(issuer, p.clientId, decrypt(p.clientSecretEnc), undefined, options);
  discoveryCache.set(p.id, { key, config, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return config;
};

/** 对外地址：优先 DOWEL_PUBLIC_URL，否则与 Origin 校验共用 expectedOrigin 的推导 */
export const callbackUrl = (c: Context, security: SecurityConfig, slug: string): URL => {
  const origin = expectedOrigin(c, security);
  if (!origin) throw new HTTPException(422, { message: '无法确定对外访问地址，请设置 DOWEL_PUBLIC_URL' });
  return new URL(`/api/auth/oidc/${encodeURIComponent(slug)}/callback`, origin);
};

/**
 * 只允许站内相对路径，防止开放跳转。
 * 先让 URL 规范化（会折叠 `..`、解码 `%2e`、把反斜杠当协议分隔符），再校验规范化后的结果：
 * 必须以单个 `/` 开头、第二个字符不是 `/` 或 `\`，并且 origin 不变；任何一项不满足都回退到 `/`。
 */
export const safeNext = (next: string | undefined): string | null => {
  if (!next) return null;
  let u: URL;
  try {
    u = new URL(next, 'http://dowel.invalid');
  } catch {
    return '/';
  }
  const normalized = `${u.pathname}${u.search}${u.hash}`;
  if (
    u.origin !== 'http://dowel.invalid' ||
    !normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized[1] === '\\'
  )
    return '/';
  return normalized;
};

const randomToken = () => randomBytes(32).toString('base64url');

/** 定长比较，避免按响应时间猜 state */
export const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ───── 短时登录状态 ─────

export interface OidcState {
  tokenHash: string;
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  mode: 'login' | 'link';
  userId: string | null;
  inviteToken: string | null;
  next: string | null;
  expiresAt: string;
}

const STATE_COLUMNS = `token_hash as "tokenHash", provider_id as "providerId", state, nonce,
  code_verifier as "codeVerifier", mode, user_id as "userId", invite_token as "inviteToken",
  next, expires_at as "expiresAt"`;

export const createOidcState = async (
  db: Db,
  input: Omit<OidcState, 'tokenHash' | 'expiresAt'>,
): Promise<{ token: string; state: OidcState }> => {
  await db.query('delete from oidc_states where expires_at <= $1', [new Date().toISOString()]);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + OIDC_TTL_MS).toISOString();
  await db.query(
    `insert into oidc_states
       (token_hash, provider_id, state, nonce, code_verifier, mode, user_id, invite_token, next, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      hashToken(token),
      input.providerId,
      input.state,
      input.nonce,
      input.codeVerifier,
      input.mode,
      input.userId,
      input.inviteToken,
      input.next,
      expiresAt,
    ],
  );
  return { token, state: { ...input, tokenHash: hashToken(token), expiresAt } };
};

/** 一次性消费：DELETE ... RETURNING 让并发回调里只有一个能拿到状态 */
export const consumeOidcState = async (db: Db, token: string): Promise<OidcState | null> => {
  const [row] = await db.query<OidcState>(
    `delete from oidc_states where token_hash = $1 returning ${STATE_COLUMNS}`,
    [hashToken(token)],
  );
  return row ?? null;
};

// ───── 用户名确认页的短时记录 ─────

export interface OidcPending {
  tokenHash: string;
  providerId: string;
  subject: string;
  username: string;
  name: string;
  email: string | null;
  inviteToken: string | null;
  expiresAt: string;
}

const PENDING_COLUMNS = `token_hash as "tokenHash", provider_id as "providerId", subject, username, name,
  email, invite_token as "inviteToken", expires_at as "expiresAt"`;

export const createOidcPending = async (
  db: Db,
  input: Omit<OidcPending, 'tokenHash' | 'expiresAt'>,
): Promise<string> => {
  await db.query('delete from oidc_pending where expires_at <= $1', [new Date().toISOString()]);
  const token = randomToken();
  await db.query(
    `insert into oidc_pending
       (token_hash, provider_id, subject, username, name, email, invite_token, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      hashToken(token),
      input.providerId,
      input.subject,
      input.username,
      input.name,
      input.email,
      input.inviteToken,
      new Date(Date.now() + OIDC_TTL_MS).toISOString(),
    ],
  );
  return token;
};

export const pendingByToken = async (db: Db, token: string): Promise<OidcPending | null> => {
  const [row] = await db.query<OidcPending>(
    `select ${PENDING_COLUMNS} from oidc_pending where token_hash = $1`,
    [hashToken(token)],
  );
  return row ?? null;
};

export const deletePending = async (db: Db, token: string) => {
  await db.query('delete from oidc_pending where token_hash = $1', [hashToken(token)]);
};

// ───── 身份 ─────

export interface IdentityRow {
  providerId: string;
  providerSlug: string;
  providerName: string;
  subject: string;
  userId: string;
  userStatus: string;
  createdAt: string;
  lastLoginAt: string;
}

export const identityOf = async (
  db: Db,
  providerId: string,
  subject: string,
): Promise<IdentityRow | null> => {
  const [row] = await db.query<IdentityRow>(
    `select i.provider_id as "providerId", p.slug as "providerSlug", p.name as "providerName",
            i.subject, i.user_id as "userId", u.status as "userStatus",
            i.created_at as "createdAt", i.last_login_at as "lastLoginAt"
       from user_identities i
       join oidc_providers p on p.id = i.provider_id
       join users u on u.id = i.user_id
      where i.provider_id = $1 and i.subject = $2`,
    [providerId, subject],
  );
  return row ?? null;
};

export const linkIdentity = async (db: Db, providerId: string, subject: string, userId: string) => {
  await db.query('insert into user_identities (provider_id, subject, user_id) values ($1, $2, $3)', [
    providerId,
    subject,
    userId,
  ]);
};

export const touchIdentity = async (db: Db, providerId: string, subject: string) => {
  await db.query('update user_identities set last_login_at = $3 where provider_id = $1 and subject = $2', [
    providerId,
    subject,
    new Date().toISOString(),
  ]);
};

export const listIdentities = (db: Db, userId: string) =>
  db.query<{
    id: string;
    providerId: string;
    providerSlug: string;
    providerName: string;
    subject: string;
    createdAt: string;
    lastLoginAt: string;
  }>(
    `select cast(i.provider_id as text) || ':' || i.subject as id,
            i.provider_id as "providerId", p.slug as "providerSlug", p.name as "providerName",
            i.subject, i.created_at as "createdAt", i.last_login_at as "lastLoginAt"
       from user_identities i join oidc_providers p on p.id = i.provider_id
      where i.user_id = $1 order by p.name, i.created_at`,
    [userId],
  );

/**
 * 解除关联前判断：还有没有别的**可用**登录方式。
 * - 密码只有在实例允许密码登录时才算（设置里的开关或 DOWEL_ALLOW_PASSWORD_LOGIN 应急入口）；
 * - 挂在已停用提供方上的身份不算。
 */
export const hasOtherLoginMethod = async (
  db: Db,
  userId: string,
  exceptIdentityId: string,
  passwordLoginAllowed: boolean,
) => {
  if (passwordLoginAllowed) {
    const [u] = await db.query<{ passwordHash: string | null }>(
      'select password_hash as "passwordHash" from users where id = $1',
      [userId],
    );
    if (u?.passwordHash) return true;
  }
  const [n] = await db.query<{ n: number }>(
    `select count(*) as n
       from user_identities i join oidc_providers p on p.id = i.provider_id
      where i.user_id = $1 and p.enabled = true
        and cast(i.provider_id as text) || ':' || i.subject <> $2`,
    [userId, exceptIdentityId],
  );
  return Number(n?.n ?? 0) > 0;
};

/** 删除自己的身份；返回是否真的删掉了 */
export const deleteIdentity = async (db: Db, userId: string, identityId: string) => {
  // 身份 ID 是“提供方 ID:subject”；提供方 ID 由 newId() 生成，不含冒号
  const at = identityId.indexOf(':');
  if (at <= 0 || at === identityId.length - 1) return false;
  const providerId = identityId.slice(0, at);
  const subject = identityId.slice(at + 1);
  const rows = await db.query<{ subject: string }>(
    `delete from user_identities where provider_id = $1 and subject = $2 and user_id = $3 returning subject`,
    [providerId, subject, userId],
  );
  return rows.length > 0;
};

// ───── 资料与首次开户 ─────

export interface OidcProfile {
  sub: string;
  preferredUsername: string | null;
  name: string | null;
  email: string | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** 从 id_token（以及可选的 userinfo）里取出需要保存的资料 */
export const profileFromClaims = (claims: Record<string, unknown>): OidcProfile | null => {
  const sub = asString(claims.sub);
  if (!sub) return null;
  return {
    sub,
    preferredUsername: asString(claims.preferred_username),
    name: asString(claims.name),
    email: asString(claims.email),
  };
};

/** 用 userinfo 补上 id_token 里没有的资料（Google 的 preferred_username 通常只在 userinfo 里） */
export const mergeUserInfo = async (
  config: Configuration,
  accessToken: string,
  profile: OidcProfile,
): Promise<OidcProfile> => {
  if (profile.preferredUsername && profile.name && profile.email) return profile;
  try {
    const info = (await fetchUserInfo(config, accessToken, profile.sub)) as Record<string, unknown>;
    return {
      sub: profile.sub,
      preferredUsername: profile.preferredUsername ?? asString(info.preferred_username),
      name: profile.name ?? asString(info.name),
      email: profile.email ?? asString(info.email),
    };
  } catch {
    // userinfo 失败不影响登录：id_token 已经通过签名、issuer、audience、nonce 校验
    return profile;
  }
};

/** 从 preferred_username 清洗出候选用户名；不合法（清洗后为空）时需要本人确认 */
export const suggestedUsername = (profile: OidcProfile): { username: string; needsConfirm: boolean } => {
  const base = profile.preferredUsername ? cleanSlug(profile.preferredUsername, '') : '';
  return { username: base || 'user', needsConfirm: !base };
};

export const displayNameOf = (profile: OidcProfile, fallback: string) =>
  profile.name || profile.preferredUsername || fallback;

const inviteUnusable = (state: string) =>
  state === 'missing'
    ? new HTTPException(404, { message: '邀请链接无效' })
    : new HTTPException(410, {
        message: {
          used: '这个邀请链接已经被使用过了',
          revoked: '这个邀请链接已被撤销',
          expired: '这个邀请链接已过期',
          ok: '',
        }[state],
      });

/**
 * 首次开户：在一个事务里认领邀请（如果来自邀请）、建用户、关联身份。
 * 用户名冲突时抛唯一约束错误，调用方回滚后转到确认页；邀请令牌因为事务回滚仍然可用。
 */
export const provisionFromIdentity = async (
  db: PlatformDb,
  input: {
    providerId: string;
    subject: string;
    username: string;
    name: string;
    email: string | null;
    inviteToken: string | null;
  },
): Promise<User> =>
  db.transaction(async (tx) => {
    let inviteId: string | null = null;
    let groupIds: string[] = [];
    if (input.inviteToken) {
      const invite = await inviteByToken(tx, input.inviteToken);
      if (invite?.kind !== 'invite') throw inviteUnusable('missing');
      const state = inviteState(invite);
      if (state !== 'ok') throw inviteUnusable(state);
      const claimed = await claimInvite(tx, { token: input.inviteToken, kind: 'invite' });
      if (!claimed) {
        const current = await inviteByToken(tx, input.inviteToken);
        throw inviteUnusable(current ? inviteState(current) : 'missing');
      }
      inviteId = claimed.id;
      const [full] = await tx.query<{ groupIds: string[] }>(
        'select group_ids as "groupIds" from invites where id = $1',
        [claimed.id],
      );
      groupIds = full?.groupIds ?? [];
    }

    const user = await createUser(tx, {
      username: input.username,
      name: input.name,
      email: input.email,
      password: null,
      role: 'member',
    });

    if (inviteId) {
      await setInviteUsedBy(tx, inviteId, user.id);
      for (const groupId of groupIds) {
        const [group] = await tx.query<{ id: string }>('select id from groups where id = $1', [groupId]);
        if (!group) continue;
        await tx.query(
          `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')
           on conflict (group_id, user_id) do nothing`,
          [groupId, user.id],
        );
      }
    }
    await linkIdentity(tx, input.providerId, input.subject, user.id);
    return user;
  });
