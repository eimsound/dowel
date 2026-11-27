// 面向 CI 的 HTTP API（P6 T3，ADR 0009）：`Authorization: Bearer dwl_…` 认证，只读 + 执行，结构化的 JSON 错误。
// - 7 个业务接口（/api/ci/token、projects、environments、drift、history、execute）托管在独立 OpenAPIHono 子应用中，
//   只认 CI 令牌，不看 cookie，不校验 Origin（app.ts）；令牌访问 /api/ci 之外的任何接口都是 403（rejectTokens）。
// - 令牌只能访问它所属的项目：路径里的项目不是它的项目时和不存在一样（404 project_not_found，不泄露存在）。
// - 执行只受环境生效的“允许令牌执行”约束（不看“谁能执行”，不走审批）；漂移、完整性、认领、超时等检查照常，
//   和界面执行共用同一套环境锁 / 目标库项目锁（runExecution）。目标版本必须显式给出（latest 或 v5），令牌不能回滚。
// - 同步等待执行结束再返回 JSON（CI 里最简单）；错误码与 HTTP 状态码的对应见 @dowel/api 的 CI_ERROR_STATUS 和 docs/en/api.md / docs/zh/api.md。
// - 文档接口（/api/ci/openapi.json、/api/ci/docs、/api/ci/docs/init.js）同时接受已登录用户会话 Cookie 或有效 CI 令牌。
import {
  CI_DOCS_PATH,
  CI_ERROR_STATUS,
  CI_OPENAPI_PATH,
  type CiDriftResult,
  type CiEnvironment,
  type CiEnvironmentStatus,
  type CiErrorBody,
  type CiErrorCode,
  type CiExecuteResult,
  type CiHistory,
  type CiMigration,
  type CiProject,
  type CiTokenSelf,
  type CiVersion,
  type CiVersionRef,
  TOKEN_PATTERN,
  type VerifyRecord,
} from '@dowel/api';
import { type Dialect, getDialect, verifiedForEngine } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { HistoryError, maxNumberNode, ScopeError } from '@dowel/engines';
import { ExecutorError, type ExecutorErrorCode } from '@dowel/executor';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { audit } from '../audit.ts';
import { currentUser, hashToken } from '../auth.ts';
import { can } from '../authz.ts';
import { type EnvRow, iso, verifiedOnOf, versionStates } from '../envs.ts';
import {
  checkEnvDriftDetailed,
  classifyError,
  dryRunExecution,
  EnvBusyError,
  readTargetState,
  runExecution,
} from '../executions.ts';
import { groupBySlug } from '../groups.ts';
import { bearerMcpToken } from '../mcp-tokens.ts';
import { loadPolicies, resolveEnv } from '../policy.ts';
import { type ProjectRow, projectRow, projectRows } from '../roles.ts';
import { SecretError, scrubSecrets } from '../secrets.ts';
import { clientIp } from '../security.ts';
import { ConnectError } from '../targets.ts';
import {
  authenticateToken,
  bearerToken,
  type CiTokenAuth,
  ciAuthHeader,
  recheckToken,
  tokenActor,
} from '../tokens.ts';
import {
  ciEnvironmentDriftRoute,
  ciEnvironmentExecuteRoute,
  ciEnvironmentGetRoute,
  ciEnvironmentHistoryRoute,
  ciProjectGetRoute,
  ciTokenSelfRoute,
  ciVersionsListRoute,
} from './ci-openapi-schemas.ts';
import { type AppContext, type Env, PASSWORD_CHANGE_REQUIRED_CODE } from './context.ts';
import { MCP_PATH, mcpHttpError } from './mcp.ts';

/** Scalar 文档页的初始化脚本路径 */
export const CI_DOCS_INIT_PATH = `${CI_DOCS_PATH}/init.js`;

/** 文档页统一错误体：{ ok: false, code, error }（兼容 CI 错误信封与 { error, code } 约定） */
export type CiDocsErrorCode = 'unauthorized' | typeof PASSWORD_CHANGE_REQUIRED_CODE;

const isCiDocsPath = (path: string) =>
  path === CI_OPENAPI_PATH || path === CI_DOCS_PATH || path.startsWith(`${CI_DOCS_PATH}/`);

/** CI 接口的预期错误：带机器可读的 code，HTTP 状态码由 code 决定 */
export class CiError extends Error {
  code: CiErrorCode;
  details: CiErrorBody['details'];
  reached: CiVersionRef | null | undefined;
  constructor(
    code: CiErrorCode,
    message: string,
    details?: CiErrorBody['details'],
    reached?: CiVersionRef | null,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.reached = reached;
  }
}

export const ciJson = (c: Context, e: CiError) => {
  const status = CI_ERROR_STATUS[e.code] as ContentfulStatusCode;
  if (e.code === 'rate_limited' && e.details?.reason) c.header('Retry-After', e.details.reason);
  return c.json<CiErrorBody>(
    {
      ok: false,
      code: e.code,
      error: scrubSecrets(e.message),
      ...(e.details ? { details: e.details } : {}),
      ...(e.reached !== undefined ? { reached: e.reached } : {}),
    },
    status,
  );
};

/**
 * 令牌越界：403 forbidden（不回落到 cookie 会话）。
 * - CI 令牌（Bearer dwl_…）访问 /api/ci 之外的接口（含 /api/mcp）：令牌不能管理令牌、不能编辑、不能发布……
 * - MCP 令牌（Bearer dwm_…，M3-C）访问 /api/mcp 之外的接口（含 /api/ci/…、/api/me/mcp-tokens、WebSocket）。
 */
export const rejectTokens: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;
  const header = c.req.header('authorization');
  if (!path.startsWith('/api/ci/') && bearerToken(header) !== null)
    return ciJson(
      c,
      new CiError('forbidden', 'CI 令牌不能访问这个接口：令牌只能读取项目状态和执行迁移（/api/ci/…）'),
    );
  if (path !== MCP_PATH && bearerMcpToken(header) !== null)
    return mcpHttpError(c, 'forbidden', 'MCP 令牌不能访问这个接口：MCP 令牌只能访问 /api/mcp');
  await next();
};

const EXECUTOR_CODES: Partial<Record<ExecutorErrorCode, CiErrorCode>> = {
  drift: 'drift',
  first_run_drift: 'drift',
  unfinished_run: 'unfinished_run',
  foreign_instance: 'foreign_instance',
  unverified: 'unverified',
  wrong_direction: 'rollback_not_allowed',
  switch_required: 'switch_requires_web',
  retired_target: 'version_retired',
  unknown_version: 'version_not_found',
  chain_broken: 'version_mismatch',
  history_broken: 'version_mismatch',
  history_mismatch: 'version_mismatch',
  history_conflict: 'version_mismatch',
  history_fork: 'version_mismatch',
  history_missing: 'version_mismatch',
  format_too_new: 'version_mismatch',
  checksum_mismatch: 'version_mismatch',
  number_conflict: 'version_mismatch',
  no_schema_privilege: 'target_unreachable',
  lock_timeout: 'lock_timeout',
  step_failed: 'execution_failed',
  step_timeout: 'execution_failed',
  readback_mismatch: 'execution_failed',
};

/**
 * 任意错误 → CiError。refOf 把版本 ID 换成 { id, number, name }（失败时环境停在的版本、失败的迁移）。
 * 意外错误只记日志，返回 internal（文案不给细节）。
 */
export const toCiError = (
  e: unknown,
  refOf: (id: string | null | undefined) => CiVersionRef | null,
): CiError => {
  if (e instanceof CiError) return e;
  if (e instanceof EnvBusyError)
    return new CiError('lock_timeout', `等待执行锁超时：这个环境正在执行另一个操作。${e.message}`);
  if (e instanceof ExecutorError) {
    const d = e.details;
    const reached = 'reached' in d ? refOf(d.reached) : undefined;
    if (e.code === 'unexpected') {
      // 执行器包起来的意外错误：连接 / 目标库错误 → target_unreachable；其他 → internal
      const k = classifyError(e.cause ?? e);
      return k.kind === 'connect' || k.kind === 'database'
        ? new CiError('target_unreachable', k.message, { reason: k.kind, partial: d.partial }, reached)
        : new CiError('internal', '服务器内部错误', { partial: d.partial }, reached);
    }
    const code = EXECUTOR_CODES[e.code] ?? 'rejected';
    const version = d.versionId ? refOf(d.versionId) : undefined;
    return new CiError(
      code,
      e.message,
      {
        reason: e.code,
        ...(d.diff ? { diff: d.diff, diffTotal: d.diffTotal ?? d.diff.length } : {}),
        ...(e.code === 'first_run_drift' ? { firstRun: true } : {}),
        ...((e.code === 'wrong_direction' || e.code === 'switch_required') && 'reached' in d
          ? { current: refOf(d.reached) }
          : {}),
        ...(e.code === 'switch_required' && d.lca ? { lca: refOf(d.lca.id) ?? d.lca } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(d.step !== undefined ? { step: d.step } : {}),
        ...(d.partial !== undefined ? { partial: d.partial } : {}),
        ...(d.timeout ? { timeout: d.timeout } : {}),
        ...(d.problems ? { problems: d.problems } : {}),
        ...(d.engineVersion !== undefined ? { engineVersion: d.engineVersion } : {}),
        ...(d.verifiedOn !== undefined ? { verifiedOn: d.verifiedOn } : {}),
      },
      // 执行失败时报告停在哪个版本（最后一个成功的版本）；拒绝类的错误没有执行任何东西，也照样告诉调用方当前版本
      reached,
    );
  }
  if (e instanceof HistoryError)
    return new CiError(
      e.code === 'lock_timeout'
        ? 'lock_timeout'
        : e.code === 'no_schema_privilege'
          ? 'target_unreachable'
          : 'version_mismatch',
      e.message,
      {
        reason: e.code,
      },
    );
  if (e instanceof ScopeError) return new CiError('rejected', e.message, { reason: 'scope' });
  if (e instanceof SecretError) return new CiError('internal', e.message);
  if (e instanceof ConnectError) return new CiError('target_unreachable', e.message);
  if (e instanceof HTTPException) {
    if (e.status === 404) return new CiError('environment_not_found', e.message);
    if (e.status === 400) return new CiError('invalid_request', e.message);
    if (e.status === 429) return new CiError('rate_limited', e.message);
    // 执行前登记时发现脚本刚被改过（409）、项目还没有版本（422）等：执行前检查没通过，什么都没执行
    return new CiError('rejected', e.message, { reason: `http_${e.status}` });
  }
  const k = classifyError(e);
  if (k.kind === 'connect' || k.kind === 'database')
    return new CiError('target_unreachable', k.message, { reason: k.kind });
  return new CiError('internal', '服务器内部错误');
};

// 保留在每个 handler 内部转错误为 ciJson：Hono app.route() 不会合并子应用的 onError
const wrap = async <R>(c: Context<Env>, handler: () => Promise<R>): Promise<R> => {
  try {
    return await handler();
  } catch (e) {
    return ciJson(
      c,
      toCiError(e, () => null),
    ) as unknown as R;
  }
};

/** 版本的轻量信息（按序号升序） */
interface VersionLite {
  id: string;
  number: number;
  parentId: string | null;
  name: string;
  verifiedAt: unknown;
  retiredAt: unknown;
  checksum: string;
  createdAt: unknown;
}

const loadVersions = (db: Db, pid: string) =>
  db.query<VersionLite>(
    `select id, number, parent_id as "parentId", name, verified_at as "verifiedAt",
            retired_at as "retiredAt", checksum, created_at as "createdAt"
       from versions where project_id = $1 order by number`,
    [pid],
  );

/**
 * 各版本通过验证的数据库完整版本号（ADR 0017 决定 5，与 Web 版本信息的 verifiedOn 同一算法）。
 * 单独查：验证报告可能很大，只有版本列表与环境状态需要它，不放进 loadVersions
 */
const loadVerifiedOn = async (db: Db, pid: string): Promise<Map<string, string[]>> =>
  new Map(
    (
      await db.query<{ id: string; verifyReport: { records?: VerifyRecord[] } | null }>(
        'select id, verify_report as "verifyReport" from versions where project_id = $1',
        [pid],
      )
    ).map((r) => [r.id, verifiedOnOf(r.verifyReport)]),
  );

const isVerified = (v: Pick<VersionLite, 'verifiedAt'>): boolean =>
  v.verifiedAt !== null && v.verifiedAt !== undefined;

/**
 * 环境状态里的 verifiedHere（#200）：与执行前检查（executor preflight）同一条规则，CI 据此能预知 409 unverified。
 * - 先要 verified（通过过闭环验证、脚本没被人工改过）；
 * - 需要外部影子库的方言（PostgreSQL / MySQL / SQL Server）：目标库完整版本号必须在 verifiedOn 里，读不到（null）一律 false；
 * - SQLite 影子库与目标库是同一个内置库，视为恒等：等于 verified（preflight 不给 SQLite 版本 verifiedOn，不比对）。
 */
export const ciVerifiedHere = (
  dialect: Dialect,
  verified: boolean,
  verifiedOn: readonly string[],
  engineVersion: string | null,
): boolean =>
  verified &&
  (!getDialect(dialect).capabilities.requiresExternalShadow ||
    verifiedForEngine(dialect, verifiedOn, engineVersion));

const isRetired = (v: Pick<VersionLite, 'retiredAt'>): boolean =>
  v.retiredAt !== null && v.retiredAt !== undefined;

const activeHeadOf = (versions: VersionLite[]): VersionLite | undefined =>
  maxNumberNode(versions.filter((v) => !isRetired(v))) ?? undefined;

/** 与环境状态页同一套版本树状态（envs.ts versionStates） */
const ciVersionStates = (versions: VersionLite[], cur: VersionLite | undefined) =>
  versionStates(
    versions.map((v) => ({ id: v.id, number: v.number, parentId: v.parentId, retired: isRetired(v) })),
    cur?.id ?? null,
  );

const ref = (v: { id: string; number: number; name: string }): CiVersionRef => ({
  id: v.id,
  number: v.number,
  name: v.name,
});

/**
 * 认证当前请求的 CI 令牌（`Authorization: Bearer dwl_…`）：
 * - 缺头（token_missing）或格式不符 TOKEN_PATTERN（token_invalid）直接在内存拒绝，不查库、不消耗失败限流桶；
 * - 格式合法的令牌：按来源 IP 同步预占失败计数（防并发绕过限速），认证成功或数据库异常时退回；
 * - 来源 IP 触及失败上限时，先查询进程内活跃令牌哈希快照（惰性加载、短 TTL 复用）：
 *   - 未命中活跃快照的无效 / 过期 / 吊销 / 随机爆破令牌直接 429 rate_limited（不再打数据库）；
 *   - 命中活跃快照的合法令牌仍进入 authenticateToken 做数据库强校验（吊销和过期立即生效），
 *     避免共享 NAT / 代理下某条错误流水线或爆破流量阻断同 IP 合法流水线。
 * - 认证通过后再按令牌 ID 限速。
 */
const authenticateCiTokenRequest = async (
  c: Context<Env>,
  ctx: AppContext,
): Promise<CiTokenAuth | Response> => {
  const { db } = ctx;
  const raw = ciAuthHeader(c.req.header('authorization'));
  if (raw === null)
    return ciJson(c, new CiError('token_missing', '缺少令牌：请求头需要 Authorization: Bearer dwl_…'));
  if (!TOKEN_PATTERN.test(raw)) return ciJson(c, new CiError('token_invalid', '令牌无效'));

  const ip = clientIp(c, ctx.security);
  const ipKey = `ip:${ip ?? 'unknown'}`;
  const hash = hashToken(raw);
  const gate = ctx.tokenFailLimiter.attempt(ipKey);

  if (!gate.allowed) {
    let isActive: boolean;
    try {
      isActive = await ctx.activeTokens.hasActive(hash);
    } catch (e) {
      return ciJson(
        c,
        toCiError(e, () => null),
      );
    }
    if (!isActive)
      return ciJson(
        c,
        new CiError('rate_limited', `令牌认证失败次数太多，请 ${gate.retryAfterSeconds} 秒后再试`, {
          reason: String(gate.retryAfterSeconds),
        }),
      );
  }

  let r: Awaited<ReturnType<typeof authenticateToken>>;
  try {
    r = await authenticateToken(db, raw, ip);
  } catch (e) {
    if (gate.allowed) gate.refund();
    return ciJson(
      c,
      toCiError(e, () => null),
    );
  }
  if (!r.ok) {
    ctx.activeTokens.forgetHash(hash);
    const msg = {
      token_missing: '缺少令牌：请求头需要 Authorization: Bearer dwl_…',
      token_invalid: '令牌无效',
      token_expired: '令牌已过期',
      token_revoked: '令牌已被吊销',
    }[r.code];
    return ciJson(c, new CiError(r.code, msg));
  }
  if (gate.allowed) gate.refund();
  ctx.activeTokens.remember(hash, {
    id: r.token.id,
    projectId: r.token.projectId,
    expiresAtMs: Date.parse(r.token.expiresAt),
  });
  const limited = ctx.tokenLimiter.attempt(`token:${r.token.id}`);
  if (!limited.allowed)
    return ciJson(
      c,
      new CiError('rate_limited', `这个令牌的请求太频繁了，请 ${limited.retryAfterSeconds} 秒后再试`, {
        reason: String(limited.retryAfterSeconds),
      }),
    );
  return r.token;
};

/** 仅允许 `Bearer dwl_…` 的文档无关业务路由校验中间件 */
const requireCiTokenOnly =
  (ctx: AppContext): MiddlewareHandler<Env> =>
  async (c, next) => {
    const auth = await authenticateCiTokenRequest(c, ctx);
    if (auth instanceof Response) return auth;
    c.set('token', auth);
    await next();
  };

/**
 * CI API 文档接口（/api/ci/openapi.json、/api/ci/docs、/api/ci/docs/*）的双认证中间件：
 * - 带 `Bearer dwl_…` 时严格走 CI 令牌认证（绝不回落到 Cookie）；
 * - 否则读取登录会话 Cookie：mustChangePassword 返回 403 password_change_required；
 * - 未登录 / 停用用户返回 401（若带了非 dwl_ 的 Authorization 头则返回 token_invalid，否则 unauthorized）。
 */
const requireCiDocsAuth =
  (ctx: AppContext): MiddlewareHandler<Env> =>
  async (c, next) => {
    const header = c.req.header('authorization');
    if (bearerToken(header) !== null) {
      const auth = await authenticateCiTokenRequest(c, ctx);
      if (auth instanceof Response) return auth;
      c.set('token', auth);
      await next();
      return;
    }

    const user = await currentUser(ctx.db, c);
    if (user) {
      if (user.mustChangePassword) {
        return c.json(
          {
            ok: false as const,
            code: PASSWORD_CHANGE_REQUIRED_CODE,
            error: '请先修改密码后再继续使用',
          },
          403,
        );
      }
      c.set('user', user);
      await next();
      return;
    }

    if (ciAuthHeader(header) !== null) return ciJson(c, new CiError('token_invalid', '令牌无效'));
    return c.json(
      {
        ok: false as const,
        code: 'unauthorized' as const,
        error: '请先登录或提供有效的 CI 令牌（Authorization: Bearer dwl_…）',
      },
      401,
    );
  };

const JSON_CONTENT_TYPE_RE = /^application\/([a-z.-]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

/**
 * 在 OpenAPIHono 的 mediaTypeGate / zValidator 之前把非法 JSON 或非 JSON 请求体统一映射为 400 invalid_request，
 * 与原有 `ciExecuteSchema.safeParse(await c.req.json().catch(() => null))` 行为保持一致。
 */
const ensureJsonExecuteBody: MiddlewareHandler<Env> = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const ct = c.req.header('content-type')?.trim();
  if (!ct || !JSON_CONTENT_TYPE_RE.test(ct)) {
    return ciJson(c, new CiError('invalid_request', '请求体必须是 JSON（Content-Type: application/json）'));
  }
  try {
    await c.req.raw.clone().json();
  } catch {
    return ciJson(c, new CiError('invalid_request', '请求体必须是合法的 JSON'));
  }
  await next();
};

/** 零内联脚本的 Scalar 文档 HTML，严格兼容 `script-src 'self'` CSP */
const DOCS_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dowel CI API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="${CI_DOCS_INIT_PATH}" defer></script>
    <script src="/vendor/scalar/standalone.js" defer></script>
  </body>
</html>
`;

/**
 * 独立初始化脚本：
 * - 在 standalone.js 执行前关闭 Zod 4 的 JIT（避免其探测 `Function('')` 触发 strict CSP 的 unsafe-eval 告警）；
 * - 关闭默认外链字体（withDefaultFonts: false）和遥测（telemetry: false），并清空 proxyUrl 以避免外发请求。
 */
const DOCS_INIT_JS = `(() => {
  const globalCfg = globalThis.__zod_globalConfig ?? {};
  globalCfg.jitless = true;
  globalThis.__zod_globalConfig = globalCfg;

  const mount = () => {
    const target = document.getElementById('app');
    if (!target || !window.Scalar || typeof window.Scalar.createApiReference !== 'function') return;
    window.Scalar.createApiReference(target, {
      url: ${JSON.stringify(CI_OPENAPI_PATH)},
      withDefaultFonts: false,
      hideClientButton: false,
      telemetry: false,
      proxyUrl: '',
    });
  };

  if (window.Scalar && typeof window.Scalar.createApiReference === 'function') {
    mount();
  } else {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }
})();
`;

export const registerCi = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;
  const ciTokenOnlyAuth = requireCiTokenOnly(ctx);
  const ciDocsAuth = requireCiDocsAuth(ctx);

  const ciApi = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success)
        return ciJson(c, new CiError('invalid_request', result.error.issues[0]?.message ?? '请求体不合法'));
    },
  });

  ciApi.openAPIRegistry.registerComponent('securitySchemes', 'ciToken', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'dwl_<43 base64url chars>',
    description: '项目级 CI 令牌（Authorization: Bearer dwl_…），仅允许只读查询与向前迁移执行。',
  });

  // 7 个外部业务接口严格只认 Bearer dwl_…；文档路径由主 app 上的 ciDocsAuth 负责，不在这里重复拦截
  ciApi.use('/api/ci/*', async (c, next) => {
    if (isCiDocsPath(c.req.path)) return next();
    return ciTokenOnlyAuth(c, next);
  });

  /** 路径里的项目：必须是令牌所属的项目（ci.read 核对项目），否则和不存在一样 */
  const projectOf = async (c: Context<Env>): Promise<ProjectRow> => {
    const token = c.get('token');
    const owner = c.req.param('owner')!.trim().toLowerCase();
    const slug = c.req.param('project')!.trim().toLowerCase();
    const group = await groupBySlug(db, owner);
    let p = group ? (await projectRows(db, { groupId: group.id })).find((x) => x.slug === slug) : undefined;
    if (!p) {
      // 旧路径（转组 / 改名之后）照样能用
      const [old] = await db.query<{ projectId: string }>(
        'select project_id as "projectId" from project_redirects where owner_slug = $1 and project_slug = $2',
        [owner, slug],
      );
      if (old) p = (await projectRow(db, old.projectId)) ?? undefined;
    }
    if (!p || !can(tokenActor(token), 'ci.read', { kind: 'project', projectId: p.id }))
      throw new CiError('project_not_found', '项目不存在，或者不是这个令牌所属的项目');
    return p;
  };

  const envOf = async (p: ProjectRow, name: string): Promise<EnvRow> => {
    const [env] = await db.query<EnvRow>('select * from environments where project_id = $1 and name = $2', [
      p.id,
      name,
    ]);
    if (!env) throw new CiError('environment_not_found', `环境“${name}”不存在`);
    return env;
  };

  const envConfig = (env: EnvRow, store: Awaited<ReturnType<typeof loadPolicies>>): CiEnvironment => ({
    name: env.name,
    production: env.production,
    tokenExecution: resolveEnv(store, env).allowTokens.value,
  });

  const requireConnectionQuota = (c: Context<Env>, action: string) => {
    const limited = ctx.connectionLimiter.attempt(`token:${c.get('token').id}`);
    if (!limited.allowed)
      throw new CiError('rate_limited', `${action}太频繁了，请 ${limited.retryAfterSeconds} 秒后再试`, {
        reason: String(limited.retryAfterSeconds),
      });
  };

  /** 令牌自己的信息（流水线自检：令牌有效、属于哪个项目、什么时候过期） */
  ciApi.openapi(ciTokenSelfRoute, (c) =>
    wrap(c, async () => {
      const t = c.get('token');
      const p = await projectRow(db, t.projectId);
      if (!p) throw new CiError('project_not_found', '令牌所属的项目不存在');
      return c.json<CiTokenSelf, 200>(
        {
          id: t.id,
          name: t.name,
          prefix: t.prefix,
          expiresAt: t.expiresAt,
          project: { id: p.id, name: p.name, slug: p.slug, owner: p.groupSlug },
          createdBy: t.createdByName,
        },
        200,
      );
    }),
  );

  /** 项目与环境列表（纯平台配置，不连目标库，不返回缓存状态） */
  ciApi.openapi(ciProjectGetRoute, (c) =>
    wrap(c, async () => {
      const p = await projectOf(c);
      const versions = await loadVersions(db, p.id);
      const store = await loadPolicies(db, p);
      const envs = await db.query<EnvRow>('select * from environments where project_id = $1 order by name', [
        p.id,
      ]);
      const head = activeHeadOf(versions);
      return c.json<CiProject, 200>(
        {
          id: p.id,
          name: p.name,
          slug: p.slug,
          owner: p.groupSlug,
          latest: head ? ref(head) : null,
          environments: envs.map((e) => envConfig(e, store)),
        },
        200,
      );
    }),
  );

  /** 版本链（按序号升序） */
  ciApi.openapi(ciVersionsListRoute, (c) =>
    wrap(c, async () => {
      const p = await projectOf(c);
      const verifiedOn = await loadVerifiedOn(db, p.id);
      return c.json<CiVersion[], 200>(
        (await loadVersions(db, p.id)).map((v) => ({
          ...ref(v),
          publishedAt: iso(v.createdAt)!,
          verified: isVerified(v),
          verifiedOn: verifiedOn.get(v.id) ?? [],
          checksum: v.checksum,
        })),
        200,
      );
    }),
  );

  /** 单环境实时状态：轻量连目标库读 dowel.history（顺带同步平台缓存），返回平台配置 + 实时当前版本、unfinished、版本链状态与待执行列表 */
  ciApi.openapi(ciEnvironmentGetRoute, (c) =>
    wrap(c, async () => {
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      requireConnectionQuota(c, '读取环境状态');
      const state = await readTargetState(ctx.exec, env, true, {
        preserveHistoryError: true,
        engineVersion: true,
      });
      const engineVersion = state.engineVersion ?? null;
      ctx.requests.kick({ envIds: [env.id] });
      const versions = await loadVersions(db, p.id);
      const byId = new Map(versions.map((v) => [v.id, v]));
      const cur = state.current ? byId.get(state.current) : undefined;
      if (state.current && !cur)
        throw new CiError(
          'version_mismatch',
          `目标库历史里的当前版本 ${state.current} 不在平台库的版本链上`,
          { reason: 'history_mismatch' },
        );
      const store = await loadPolicies(db, p);
      const states = ciVersionStates(versions, cur);
      const verifiedOn = await loadVerifiedOn(db, p.id);
      const list = versions.map((v) => {
        const verified = isVerified(v);
        return {
          ...ref(v),
          state: states.get(v.id)!,
          verified,
          verifiedHere: ciVerifiedHere(p.dialect, verified, verifiedOn.get(v.id) ?? [], engineVersion),
        };
      });
      return c.json<CiEnvironmentStatus, 200>(
        {
          ...envConfig(env, store),
          currentVersion: cur ? ref(cur) : null,
          engineVersion,
          unfinished: state.unfinished !== null,
          versions: list,
          pending: list.filter((v) => v.state === 'pending').map((v) => v.number),
        },
        200,
      );
    }),
  );

  /** 实时漂移检测：连目标库读全库结构快照比对，顺带刷新平台侧漂移状态 */
  ciApi.openapi(ciEnvironmentDriftRoute, (c) =>
    wrap(c, async () => {
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      requireConnectionQuota(c, '检查漂移');
      const versions = await loadVersions(db, p.id);
      const byId = new Map(versions.map((v) => [v.id, v]));
      const refOf = (id: string | null | undefined) => {
        const v = id ? byId.get(id) : undefined;
        return v ? ref(v) : null;
      };
      const { result, currentVersionId, error } = await checkEnvDriftDetailed(ctx.exec, env);
      // 即使漂移检查报错，checkEnvDriftDetailed 也可能已更新平台侧漂移状态或缓存，因此统一触发待批申请重检
      ctx.requests.kick({ envIds: [env.id] });
      if (error !== undefined) throw toCiError(error, refOf);
      if (result.skipped === 'busy')
        throw new CiError('lock_timeout', '这个环境正在执行另一个操作，暂时无法检查漂移');
      if (result.skipped === 'unfinished')
        throw new CiError('unfinished_run', '上一次执行停在中途，请先在界面上处理后再检查漂移');
      if (result.skipped === 'no_versions')
        return c.json<CiDriftResult, 200>(
          {
            environment: env.name,
            currentVersion: null,
            status: 'unknown',
            checkedAt: new Date().toISOString(),
            summary: '项目还没有发布任何版本，无法检查漂移',
            total: 0,
            items: [],
            unresolvable: [],
            firstRun: false,
            needsManual: null,
          },
          200,
        );
      const currentVersion = refOf(currentVersionId);
      const checkedAt = result.checkedAt ?? new Date().toISOString();
      if (result.status === 'ok')
        return c.json<CiDriftResult, 200>(
          {
            environment: env.name,
            currentVersion,
            status: 'clean',
            checkedAt,
            summary: currentVersion
              ? `目标库结构与当前版本 v${currentVersion.number} 一致`
              : '目标库结构符合初始状态，无漂移',
            total: 0,
            items: [],
            unresolvable: [],
            firstRun: false,
            needsManual: null,
          },
          200,
        );
      const sum = result.summary;
      const items = sum?.items ?? [];
      const unresolvable = items.filter((i) => i.kind === 'unresolvable');
      const total = sum?.total ?? items.length;
      const needsManual = sum?.needsManual
        ? {
            direction: sum.needsManual.direction,
            versionId: sum.needsManual.versionId,
            versionNumber: sum.needsManual.versionNumber ?? null,
          }
        : null;
      return c.json<CiDriftResult, 200>(
        {
          environment: env.name,
          currentVersion,
          status: 'drifted',
          checkedAt,
          summary: sum?.message ?? `检测到 ${total} 处结构差异`,
          total,
          items,
          unresolvable,
          firstRun: sum?.firstRun === true,
          needsManual,
        },
        200,
      );
    }),
  );

  /** 执行历史：读目标库的 dowel.history（最近 100 条，新的在前），顺便同步平台库缓存；和界面共用连接限速（按令牌计） */
  ciApi.openapi(ciEnvironmentHistoryRoute, (c) =>
    wrap(c, async () => {
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      requireConnectionQuota(c, '读取执行历史');
      const state = await readTargetState(ctx.exec, env, true, { preserveHistoryError: true });
      ctx.requests.kick({ envIds: [env.id] });
      const byId = new Map((await loadVersions(db, p.id)).map((v) => [v.id, v]));
      const r = (id: string) => {
        const v = byId.get(id);
        return v ? ref(v) : { id, number: -1, name: id };
      };
      const cur = state.current ? byId.get(state.current) : undefined;
      return c.json<CiHistory, 200>(
        {
          currentVersion: cur ? ref(cur) : null,
          unfinished: state.unfinished !== null,
          runs: state.runs
            .slice(-100)
            .reverse()
            .map((run) => ({
              from: run.fromVersion ? r(run.fromVersion) : null,
              to: r(run.toVersion),
              direction: run.direction,
              status: run.status,
              error: run.error ? scrubSecrets(run.error) : null,
              via: run.via,
              executedBy: run.executedBy,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
            })),
        },
        200,
      );
    }),
  );

  /**
   * 执行（或预演）到指定版本。顺序：请求体 JSON 校验 → 项目 / 环境 → 目标版本 → “允许令牌执行” → 执行器（锁、完整性、认领、
   * 漂移、已验证、实例级语句、超时）。不是预演时，从“允许令牌执行”这一步起，每次请求都写一条审计（成功、失败、被拒）。
   */
  ciApi.use('/api/ci/projects/:owner/:project/environments/:env/execute', ensureJsonExecuteBody);
  ciApi.openapi(ciEnvironmentExecuteRoute, (c) =>
    wrap(c, async () => {
      const started = Date.now();
      const token = c.get('token');
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      const b = c.req.valid('json');
      const versions = await loadVersions(db, p.id);
      const byId = new Map(versions.map((v) => [v.id, v]));
      const refOf = (id: string | null | undefined) => {
        const v = id ? byId.get(id) : undefined;
        return v ? ref(v) : null;
      };
      const head = activeHeadOf(versions);
      const raw = String(b.to).trim().toLowerCase();
      const target =
        raw === 'latest' ? head : versions.find((v) => v.number === Number(raw.replace(/^v/, '')));
      if (!target)
        throw new CiError(
          'version_not_found',
          head
            ? `目标版本 ${b.to} 不在版本链上（最新活跃版本是 v${head.number}）`
            : versions.length
              ? '项目没有可用的活跃版本'
              : '项目还没有发布任何版本',
        );
      if (isRetired(target))
        throw new CiError(
          'version_retired',
          `目标版本 v${target.number}「${target.name}」已作废，不能执行到它`,
          { version: ref(target) },
        );

      let curProject = p;
      let curEnv = env;
      const store = await loadPolicies(db, curProject);
      let curResolved = resolveEnv(store, curEnv);
      let curTimeouts = {
        statementMs: curResolved.statementTimeoutMs.value,
        lockMs: curResolved.lockTimeoutMs.value,
      };
      const writeAudit = (data: Record<string, unknown>, realFrom?: string | null) =>
        audit(
          db,
          c,
          {
            action: 'environment.execute',
            actorKind: 'token',
            actorId: token.id,
            targetKind: 'environment',
            targetId: curEnv.id,
            projectId: curProject.id,
            data: {
              projectId: curProject.id,
              name: curEnv.name,
              production: curEnv.production,
              via: 'ci',
              token: {
                id: token.id,
                name: token.name,
                prefix: token.prefix,
                createdBy: token.createdBy,
                createdByName: token.createdByName,
              },
              from: realFrom !== undefined ? realFrom : curEnv.current_version_id,
              to: target.id,
              toNumber: target.number,
              allowTokens: curResolved.allowTokens.value,
              allowTokensSource: curResolved.allowTokens.source,
              timeouts: curTimeouts,
              ...data,
            },
          },
          ctx.security,
        );

      // 只看“允许令牌执行”（四层逐层取更严，默认非生产开、生产关）；不看“谁能执行”，不走审批
      if (
        !can(tokenActor(token), 'ci.execute', {
          kind: 'environment',
          projectId: curProject.id,
          allowTokens: curResolved.allowTokens.value,
        })
      ) {
        const err = new CiError(
          'token_execution_disabled',
          `环境“${curEnv.name}”的执行策略不允许令牌执行${curEnv.production ? '（生产环境默认不允许）' : ''}`,
        );
        if (!b.dryRun) await writeAudit({ ok: false, code: err.code, error: err.message });
        throw err;
      }

      if (b.dryRun) {
        try {
          const r = await dryRunExecution(ctx.exec, {
            pid: curProject.id,
            projectName: curProject.name,
            env: curEnv,
            to: target.id,
            direction: 'up',
            userId: token.id,
            via: 'ci',
          });
          const plan = r.dryRun!;
          const baseVer = versions[0];
          return c.json<CiExecuteResult, 200>(
            {
              ok: true,
              dryRun: true,
              project: `${curProject.groupSlug}/${curProject.slug}`,
              environment: curEnv.name,
              from: plan.from ? ref(plan.from) : null,
              to: ref(target),
              reached: plan.to ? ref(plan.to) : null,
              migrations: [
                ...(plan.baseline && baseVer
                  ? [
                      {
                        number: baseVer.number,
                        name: baseVer.name,
                        direction: 'baseline' as const,
                        steps: 0,
                        nonTransactional: 0,
                      },
                    ]
                  : []),
                ...plan.migrations.map((m): CiMigration => {
                  if (m.direction === 'down')
                    throw new CiError(
                      'switch_requires_web',
                      'CI 令牌不允许执行回滚操作，请在 Web 端人工确认切换',
                    );
                  return {
                    number: m.number,
                    name: m.name,
                    direction: m.direction,
                    steps: m.steps.length,
                    nonTransactional: m.nonTransactional,
                  };
                }),
              ],
              noop: plan.migrations.length === 0,
              durationMs: Date.now() - started,
            },
            200,
          );
        } catch (e) {
          throw toCiError(e, refOf);
        }
      }

      const committed: { number: number; direction: 'up' | 'baseline' }[] = [];
      let lastReachedId: string | null = null;
      let outcome:
        | {
            ok: true;
            out: CiExecuteResult;
            fromId: string | null;
            ran: { number: number; direction: string }[];
          }
        | { ok: false; err: CiError };

      try {
        const { result, current } = await runExecution(ctx.exec, {
          pid: curProject.id,
          projectName: curProject.name,
          env: curEnv,
          to: target.id,
          direction: 'up',
          userId: token.id,
          via: 'ci',
          lockWaitMs: b.lockTimeoutSeconds * 1000,
          timeouts: curTimeouts,
          onCommitted: (m) => {
            if (m.direction === 'down') throw new Error('CI 令牌执行中出现了非法的回滚迁移');
            committed.push({ number: m.number, direction: m.direction });
            lastReachedId = m.toId;
          },
          // 锁内重新检查：等锁期间令牌可能被吊销 / 过期，策略可能关闭了允许令牌执行
          beforeConnect: async (freshEnv) => {
            curEnv = freshEnv;
            const st = await recheckToken(db, token.id);
            if (st !== 'ok')
              throw new CiError(
                st,
                st === 'token_revoked' ? '令牌已被吊销' : st === 'token_expired' ? '令牌已过期' : '令牌无效',
              );
            const freshProject = await projectRow(db, p.id);
            if (!freshProject)
              throw new CiError('project_not_found', '项目不存在，或者不是这个令牌所属的项目');
            curProject = freshProject;
            const freshResolved = resolveEnv(await loadPolicies(db, freshProject), freshEnv);
            curResolved = freshResolved;
            curTimeouts = {
              statementMs: freshResolved.statementTimeoutMs.value,
              lockMs: freshResolved.lockTimeoutMs.value,
            };
            if (
              !can(tokenActor(token), 'ci.execute', {
                kind: 'environment',
                projectId: freshProject.id,
                allowTokens: freshResolved.allowTokens.value,
              })
            )
              throw new CiError(
                'token_execution_disabled',
                `环境“${freshEnv.name}”的执行策略不允许令牌执行${freshEnv.production ? '（生产环境默认不允许）' : ''}`,
              );
            return { timeouts: curTimeouts };
          },
        });
        const ran = result.ran;
        const byNumber = new Map(versions.map((v) => [v.number, v]));
        const fromId = result.from ?? null;
        const from = refOf(fromId);
        const out: CiExecuteResult = {
          ok: true,
          dryRun: false,
          project: `${curProject.groupSlug}/${curProject.slug}`,
          environment: curEnv.name,
          from,
          to: ref(target),
          reached: current ? { id: current.id, number: current.number, name: current.name } : null,
          migrations: ran.map((m) => {
            if (m.direction === 'down')
              throw new CiError('switch_requires_web', 'CI 令牌不允许执行回滚操作，请在 Web 端人工确认切换');
            return {
              number: m.number,
              name: byNumber.get(m.number)?.name ?? '',
              direction: m.direction,
            };
          }),
          noop: ran.length === 0,
          durationMs: Date.now() - started,
        };
        outcome = {
          ok: true,
          out,
          fromId,
          ran: ran.map((m) => ({ number: m.number, direction: m.direction })),
        };
      } catch (e) {
        const err = toCiError(e, refOf);
        if (err.reached === undefined && lastReachedId !== null) err.reached = refOf(lastReachedId);
        outcome = { ok: false, err };
      }

      if (outcome.ok) {
        await writeAudit({ ok: true, noop: outcome.out.noop, ran: outcome.ran }, outcome.fromId);
        await ctx.requests
          .afterTokenRun(token, { pid: curProject.id, env: curEnv }, ref(target), {
            ok: true,
            noop: outcome.out.noop,
            current: outcome.out.reached,
            ran: outcome.ran.map((m) => m.number),
            error: null,
          })
          .catch((e) =>
            console.error('令牌执行之后的通知失败', e instanceof Error ? scrubSecrets(e.message) : e),
          );
        return c.json<CiExecuteResult, 200>(outcome.out, 200);
      }

      const { err } = outcome;
      await writeAudit({
        ok: false,
        code: err.code,
        reason: err.details?.reason ?? null,
        error: scrubSecrets(err.message),
        reached: err.reached?.id ?? null,
        ...(committed.length ? { ran: committed } : {}),
      });
      // 锁内预检被拒（令牌失效、策略关闭、资源不存在）且未动目标库时，与锁前拒绝保持一致，不发执行通知
      const preCheckDenial =
        committed.length === 0 &&
        (
          [
            'token_revoked',
            'token_expired',
            'token_invalid',
            'project_not_found',
            'environment_not_found',
            'token_execution_disabled',
          ] as CiErrorCode[]
        ).includes(err.code);
      if (!preCheckDenial)
        await ctx.requests
          .afterTokenRun(token, { pid: curProject.id, env: curEnv }, ref(target), {
            ok: false,
            current: err.reached ?? null,
            ran: committed.map((m) => m.number),
            error: { error: err.message, code: err.code },
          })
          .catch((x) =>
            console.error('令牌执行之后的通知失败', x instanceof Error ? scrubSecrets(x.message) : x),
          );
      throw err;
    }),
  );

  // 只从 7 个外部业务路由生成 OpenAPI 3.1 规范（不含文档端点自身）
  const openApiDoc = ciApi.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Dowel CI API',
      version: '1.0.0',
      description:
        '面向 CI 流水线的 Dowel HTTP API（Bearer dwl_… 令牌认证）：只读查询项目/版本/环境实时状态、执行实时漂移检测，以及同步向前迁移执行。',
    },
    tags: [
      { name: 'Token', description: 'CI 令牌自检' },
      { name: 'Projects', description: '项目平台配置与版本链' },
      { name: 'Environments', description: '环境实时状态、漂移检测与执行历史' },
      { name: 'Execution', description: '向前迁移预演与执行' },
    ],
    security: [{ ciToken: [] }],
  });

  // 文档端点（支持登录会话 Cookie 或 Bearer dwl_…）：必须在挂载 ciApi 之前注册
  app.use(CI_OPENAPI_PATH, ciDocsAuth);
  app.use(CI_DOCS_PATH, ciDocsAuth);
  app.use(`${CI_DOCS_PATH}/*`, ciDocsAuth);

  app.get(CI_OPENAPI_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(openApiDoc);
  });

  app.get(CI_DOCS_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(DOCS_HTML);
  });

  app.get(CI_DOCS_INIT_PATH, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.body(DOCS_INIT_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  });

  app.route('/', ciApi);
};

export type { CiTokenAuth };
