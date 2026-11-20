// 面向 CI 的 HTTP API（P6 T3，ADR 0009）：`Authorization: Bearer dwl_…` 认证，只读 + 执行，结构化的 JSON 错误。
// - 只认令牌，不看 cookie，不校验 Origin（app.ts）；令牌访问 /api/ci 之外的任何接口都是 403（rejectTokens）。
// - 令牌只能访问它所属的项目：路径里的项目不是它的项目时和不存在一样（404 project_not_found，不泄露存在）。
// - 执行只受环境生效的“允许令牌执行”约束（不看“谁能执行”，不走审批）；漂移、完整性、认领、超时等检查照常，
//   和界面执行共用同一套环境锁 / 目标库项目锁（runExecution）。目标版本必须显式给出（latest 或 v5），令牌不能回滚。
// - 同步等待执行结束再返回 JSON（CI 里最简单）；错误码与 HTTP 状态码的对应见 @dowel/api 的 CI_ERROR_STATUS 和 docs/api.md。
import {
  CI_ERROR_STATUS,
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
  ciExecuteSchema,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HistoryError, ScopeError } from '@dowel/engines';
import { ExecutorError, type ExecutorErrorCode } from '@dowel/executor';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { audit } from '../audit.ts';
import { can } from '../authz.ts';
import { type EnvRow, iso } from '../envs.ts';
import {
  checkEnvDriftDetailed,
  classifyError,
  dryRunExecution,
  EnvBusyError,
  readTargetState,
  runExecution,
} from '../executions.ts';
import { groupBySlug } from '../groups.ts';
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
import type { AppContext, Env } from './context.ts';

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

/** 令牌访问 /api/ci 之外的接口：403 forbidden（不回落到 cookie 会话，令牌不能管理令牌、不能编辑、不能发布……） */
export const rejectTokens: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.req.path.startsWith('/api/ci/') && bearerToken(c.req.header('authorization')) !== null)
    return ciJson(
      c,
      new CiError('forbidden', 'CI 令牌不能访问这个接口：令牌只能读取项目状态和执行迁移（/api/ci/…）'),
    );
  await next();
};

const EXECUTOR_CODES: Partial<Record<ExecutorErrorCode, CiErrorCode>> = {
  drift: 'drift',
  first_run_drift: 'drift',
  unfinished_run: 'unfinished_run',
  foreign_instance: 'foreign_instance',
  unverified: 'unverified',
  wrong_direction: 'rollback_not_allowed',
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
        ...(e.code === 'wrong_direction' && 'reached' in d ? { current: refOf(d.reached) } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(d.step !== undefined ? { step: d.step } : {}),
        ...(d.partial !== undefined ? { partial: d.partial } : {}),
        ...(d.timeout ? { timeout: d.timeout } : {}),
        ...(d.problems ? { problems: d.problems } : {}),
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

const wrap =
  (handler: (c: Context<Env>) => Promise<Response>) =>
  async (c: Context<Env>): Promise<Response> => {
    try {
      return await handler(c);
    } catch (e) {
      return ciJson(
        c,
        toCiError(e, () => null),
      );
    }
  };

/** 版本的轻量信息（按序号升序） */
interface VersionLite {
  id: string;
  number: number;
  name: string;
  verifiedAt: unknown;
  checksum: string;
  createdAt: unknown;
}

const loadVersions = (db: Db, pid: string) =>
  db.query<VersionLite>(
    `select id, number, name, verified_at as "verifiedAt", checksum, created_at as "createdAt"
       from versions where project_id = $1 order by number`,
    [pid],
  );

const ref = (v: { id: string; number: number; name: string }): CiVersionRef => ({
  id: v.id,
  number: v.number,
  name: v.name,
});

export const registerCi = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  /**
   * 令牌认证（/api/ci/*）：先同步预占来源 IP 的失败计数（防并发绕过限速），认证成功后退回；
   * 数据库异常也按 CiErrorBody 返回并退回失败预占。认证通过后再按令牌限速。
   */
  app.use('/api/ci/*', async (c, next) => {
    const ip = clientIp(c, ctx.security);
    const ipKey = `ip:${ip ?? 'unknown'}`;
    const blocked = ctx.tokenFailLimiter.attempt(ipKey);
    if (!blocked.allowed)
      return ciJson(
        c,
        new CiError('rate_limited', `令牌认证失败次数太多，请 ${blocked.retryAfterSeconds} 秒后再试`, {
          reason: String(blocked.retryAfterSeconds),
        }),
      );
    let r: Awaited<ReturnType<typeof authenticateToken>>;
    try {
      r = await authenticateToken(db, ciAuthHeader(c.req.header('authorization')), ip);
    } catch (e) {
      ctx.tokenFailLimiter.refund(ipKey);
      return ciJson(
        c,
        toCiError(e, () => null),
      );
    }
    if (!r.ok) {
      const msg = {
        token_missing: '缺少令牌：请求头需要 Authorization: Bearer dwl_…',
        token_invalid: '令牌无效',
        token_expired: '令牌已过期',
        token_revoked: '令牌已被吊销',
      }[r.code];
      return ciJson(c, new CiError(r.code, msg));
    }
    ctx.tokenFailLimiter.refund(ipKey);
    const limited = ctx.tokenLimiter.attempt(`token:${r.token.id}`);
    if (!limited.allowed)
      return ciJson(
        c,
        new CiError('rate_limited', `这个令牌的请求太频繁了，请 ${limited.retryAfterSeconds} 秒后再试`, {
          reason: String(limited.retryAfterSeconds),
        }),
      );
    c.set('token', r.token);
    await next();
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
  app.get(
    '/api/ci/token',
    wrap(async (c) => {
      const t = c.get('token');
      const p = await projectRow(db, t.projectId);
      if (!p) throw new CiError('project_not_found', '令牌所属的项目不存在');
      return c.json<CiTokenSelf>({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        expiresAt: t.expiresAt,
        project: { id: p.id, name: p.name, slug: p.slug, owner: p.groupSlug },
        createdBy: t.createdByName,
      });
    }),
  );

  /** 项目与环境列表（纯平台配置，不连目标库，不返回缓存状态） */
  app.get(
    '/api/ci/projects/:owner/:project',
    wrap(async (c) => {
      const p = await projectOf(c);
      const versions = await loadVersions(db, p.id);
      const store = await loadPolicies(db, p);
      const envs = await db.query<EnvRow>('select * from environments where project_id = $1 order by name', [
        p.id,
      ]);
      const head = versions.at(-1);
      return c.json<CiProject>({
        id: p.id,
        name: p.name,
        slug: p.slug,
        owner: p.groupSlug,
        latest: head ? ref(head) : null,
        environments: envs.map((e) => envConfig(e, store)),
      });
    }),
  );

  /** 版本链（按序号升序） */
  app.get(
    '/api/ci/projects/:owner/:project/versions',
    wrap(async (c) => {
      const p = await projectOf(c);
      return c.json<CiVersion[]>(
        (await loadVersions(db, p.id)).map((v) => ({
          ...ref(v),
          publishedAt: iso(v.createdAt)!,
          verified: v.verifiedAt !== null && v.verifiedAt !== undefined,
          checksum: v.checksum,
        })),
      );
    }),
  );

  /** 单环境实时状态：轻量连目标库读 dowel.history（顺带同步平台缓存），返回平台配置 + 实时当前版本、unfinished、版本链状态与待执行列表 */
  app.get(
    '/api/ci/projects/:owner/:project/environments/:env',
    wrap(async (c) => {
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      requireConnectionQuota(c, '读取环境状态');
      const state = await readTargetState(ctx.exec, env, true, { preserveHistoryError: true });
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
      const list = versions.map((v) => ({
        ...ref(v),
        state: (!cur || v.number > cur.number ? 'pending' : v.id === cur.id ? 'current' : 'applied') as
          | 'pending'
          | 'current'
          | 'applied',
        verified: v.verifiedAt !== null && v.verifiedAt !== undefined,
      }));
      return c.json<CiEnvironmentStatus>({
        ...envConfig(env, store),
        currentVersion: cur ? ref(cur) : null,
        unfinished: state.unfinished !== null,
        versions: list,
        pending: list.filter((v) => v.state === 'pending').map((v) => v.number),
      });
    }),
  );

  /** 实时漂移检测：连目标库读全库结构快照比对，顺带刷新平台侧漂移状态 */
  app.post(
    '/api/ci/projects/:owner/:project/environments/:env/drift',
    wrap(async (c) => {
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
      ctx.requests.kick({ envIds: [env.id] });
      if (error !== undefined) throw toCiError(error, refOf);
      if (result.skipped === 'busy')
        throw new CiError('lock_timeout', '这个环境正在执行另一个操作，暂时无法检查漂移');
      if (result.skipped === 'unfinished')
        throw new CiError('unfinished_run', '上一次执行停在中途，请先在界面上处理后再检查漂移');
      if (result.skipped === 'no_versions')
        return c.json<CiDriftResult>({
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
        });
      const currentVersion = refOf(currentVersionId);
      const checkedAt = result.checkedAt ?? new Date().toISOString();
      if (result.status === 'ok')
        return c.json<CiDriftResult>({
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
        });
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
      return c.json<CiDriftResult>({
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
      });
    }),
  );

  /** 执行历史：读目标库的 dowel.history（最近 100 条，新的在前），顺便同步平台库缓存；和界面共用连接限速（按令牌计） */
  app.get(
    '/api/ci/projects/:owner/:project/environments/:env/history',
    wrap(async (c) => {
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
      return c.json<CiHistory>({
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
      });
    }),
  );

  /**
   * 执行（或预演）到指定版本。顺序：项目 / 环境 → 请求体 → 目标版本 → “允许令牌执行” → 执行器（锁、完整性、认领、
   * 漂移、已验证、实例级语句、超时）。不是预演时，从“允许令牌执行”这一步起，每次请求都写一条审计（成功、失败、被拒）。
   */
  app.post(
    '/api/ci/projects/:owner/:project/environments/:env/execute',
    wrap(async (c) => {
      const started = Date.now();
      const token = c.get('token');
      const p = await projectOf(c);
      const env = await envOf(p, c.req.param('env')!);
      const parsed = ciExecuteSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new CiError('invalid_request', parsed.error.issues[0]?.message ?? '请求体不合法');
      const b = parsed.data;
      const versions = await loadVersions(db, p.id);
      const byId = new Map(versions.map((v) => [v.id, v]));
      const refOf = (id: string | null | undefined) => {
        const v = id ? byId.get(id) : undefined;
        return v ? ref(v) : null;
      };
      const raw = String(b.to).trim().toLowerCase();
      const target =
        raw === 'latest' ? versions.at(-1) : versions.find((v) => v.number === Number(raw.replace(/^v/, '')));
      if (!target)
        throw new CiError(
          'version_not_found',
          versions.length
            ? `目标版本 ${b.to} 不在版本链上（最新是 v${versions.at(-1)!.number}）`
            : '项目还没有发布任何版本',
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
            mode: 'migrate',
            to: target.id,
            direction: 'up',
            userId: token.id,
            via: 'ci',
          });
          const plan = r.dryRun!;
          const baseVer = versions[0];
          return c.json<CiExecuteResult>({
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
              ...plan.migrations.map(
                (m): CiMigration => ({
                  number: m.number,
                  name: m.name,
                  direction: m.direction === 'down' ? 'up' : (m.direction as 'up' | 'baseline'),
                  steps: m.steps.length,
                  nonTransactional: m.nonTransactional,
                }),
              ),
            ],
            noop: plan.migrations.length === 0 && !plan.baseline,
            durationMs: Date.now() - started,
          });
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
          mode: 'migrate',
          to: target.id,
          direction: 'up',
          userId: token.id,
          via: 'ci',
          lockWaitMs: b.lockTimeoutSeconds * 1000,
          timeouts: curTimeouts,
          onCommitted: (m) => {
            committed.push({ number: m.number, direction: m.direction === 'baseline' ? 'baseline' : 'up' });
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
          migrations: ran.map((m) => ({
            number: m.number,
            name: byNumber.get(m.number)?.name ?? '',
            direction: m.direction === 'baseline' ? 'baseline' : 'up',
          })),
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
        return c.json<CiExecuteResult>(outcome.out);
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
};

export type { CiTokenAuth };
