// 环境的执行（H7）：状态、历史、漂移检查，以及执行 / 回滚 / 写基线（进度用 SSE，参考新建项目向导）。
// 特权操作按环境的“谁能执行”档位检查（H6，authz.ts 的 EnvAction）。
import {
  baselineRequestSchema,
  type DriftCheckResponse,
  type EnvHistory,
  type EnvStatus,
  type ExecEvent,
  type ExecStage,
  executeRequestSchema,
} from '@dowel/api';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { audit } from '../audit.ts';
import { type EnvAction, effectiveExecPolicy, userActor } from '../authz.ts';
import { inList } from '../db.ts';
import {
  driftInfo,
  type EnvRow,
  loadVersionMetas,
  permissionsOf,
  toEnvVersion,
  versionRef,
} from '../envs.ts';
import { checkEnvDrift, errorEvent, readTargetState, runExecution, runInfoOf } from '../executions.ts';
import { sseSender } from '../sse.ts';
import { type AppContext, body, type Env, envAccess } from './context.ts';

/** 读目标库的接口（历史、漂移检查）也是“服务端替用户去连地址”：和连接检查共用限速 */
const limit = (c: Context<Env>, ctx: AppContext) => {
  const r = ctx.connectionLimiter.attempt(c.get('user').id);
  if (!r.allowed) {
    c.header('Retry-After', String(r.retryAfterSeconds));
    throw new HTTPException(429, { message: `连接检查太频繁了，请 ${r.retryAfterSeconds} 秒后再试` });
  }
};

/** 生产环境的执行 / 回滚 / 写基线必须在请求里带上环境名（服务端校验，不只是界面上的确认框） */
const confirmed = (env: EnvRow, confirm: string | undefined) => {
  if (env.production && (confirm ?? '').trim() !== env.name)
    throw new HTTPException(422, { message: `生产环境需要输入环境名“${env.name}”确认` });
};

export const registerExecutions = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  /**
   * 环境状态：只读平台库里的缓存（当前版本、版本链、待执行、漂移），不连目标库。
   * executedHere 只算 confirmed（目标库历史的镜像）；claimed 是进行中的登记，还不算执行过。
   */
  app.get('/api/projects/:pid/environments/:eid/status', async (c) => {
    const { env, role } = await envAccess(c, ctx, 'environment.read');
    const metas = await loadVersionMetas(db, env.project_id);
    const executed = new Set(
      (
        await db.query<{ version_id: string }>(
          "select version_id from environment_versions where environment_id = $1 and state = 'confirmed'",
          [env.id],
        )
      ).map((r) => r.version_id),
    );
    const cur = metas.find((m) => m.id === env.current_version_id);
    const versions = metas.map((m) => toEnvVersion(m, cur, executed));
    return c.json<EnvStatus>({
      id: env.id,
      name: env.name,
      production: env.production,
      execPolicy: env.exec_policy,
      effectiveExecPolicy: effectiveExecPolicy({ production: env.production, execPolicy: env.exec_policy }),
      currentVersion: cur ? versionRef(cur) : null,
      versions,
      pending: versions.filter((v) => v.state === 'pending').map((v) => v.id),
      drift: driftInfo(env),
      permissions: permissionsOf(userActor(c.get('user')), env, role),
    });
  });

  /** 执行历史：读目标库的 dowel.history，顺便把当前版本和“执行过哪些版本”同步回平台库 */
  app.get('/api/projects/:pid/environments/:eid/history', async (c) => {
    const { env } = await envAccess(c, ctx, 'environment.read');
    limit(c, ctx);
    // 读历史并同步缓存：同步在目标库的项目锁里做（把镜像对齐到目标库历史；拿不到锁说明正在执行，只读不同步）
    const state = await readTargetState(ctx.exec, env, true);
    const refs = new Map((await loadVersionMetas(db, env.project_id)).map((m) => [m.id, m]));
    // 执行者显示名：一次 where id in (...) 查完（用户被删除后回退到 id）
    const ids = [...new Set(state.runs.map((r) => r.executedBy).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (ids.length)
      for (const u of await db.query<{ id: string; name: string }>(
        `select id, name from users where id in (${inList(ids)})`,
        ids,
      ))
        names.set(u.id, u.name);
    const runs = state.runs.map((r) => runInfoOf(r, refs, names));
    const cur = state.current ? refs.get(state.current) : undefined;
    return c.json<EnvHistory>({
      initialized: state.current !== null || state.runs.length > 0,
      currentVersion: cur ? versionRef(cur) : null,
      unfinished: state.unfinished ? runInfoOf(state.unfinished, refs, names) : null,
      runs: runs.slice(-100).reverse(),
    });
  });

  /** 手动检查漂移：读目标库结构，与环境当前版本的模型比较，结果写进缓存 */
  app.post('/api/projects/:pid/environments/:eid/drift-check', async (c) => {
    const { env } = await envAccess(c, ctx, 'environment.check_drift');
    limit(c, ctx);
    return c.json<DriftCheckResponse>(await checkEnvDrift(ctx.exec, env));
  });

  // ───── 执行 / 回滚 / 写基线（SSE） ─────

  const stream = (
    c: Context<Env>,
    a: Awaited<ReturnType<typeof envAccess>>,
    action: Extract<EnvAction, 'environment.execute' | 'environment.rollback' | 'environment.baseline'>,
    run: { mode: 'migrate' | 'baseline'; to?: string; direction?: 'up' | 'down' },
  ) => {
    const { env } = a;
    const user = c.get('user');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (s) => {
      const send = sseSender<ExecEvent>(s);
      let stage: ExecStage = 'lock';
      const fromId = env.current_version_id;
      try {
        const { result, current } = await runExecution(ctx.exec, {
          pid: a.pid,
          projectName: a.name,
          env,
          mode: run.mode,
          to: run.to,
          direction: run.direction,
          userId: user.id,
          onEvent: async (e) => {
            stage = e.stage;
            await send(e);
          },
        });
        await audit(
          db,
          c,
          {
            action,
            actorKind: 'user',
            actorId: user.id,
            targetKind: 'environment',
            targetId: env.id,
            projectId: a.pid,
            data: {
              projectId: a.pid,
              name: env.name,
              production: env.production,
              from: fromId,
              to: current?.id ?? null,
              ran: result.ran.map((r) => ({ number: r.number, direction: r.direction })),
              ok: true,
            },
          },
          ctx.security,
        );
        await send({ stage: 'done', current, ran: result.ran.length });
      } catch (e) {
        const ev = errorEvent(e);
        await audit(
          db,
          c,
          {
            action,
            actorKind: 'user',
            actorId: user.id,
            targetKind: 'environment',
            targetId: env.id,
            projectId: a.pid,
            data: {
              projectId: a.pid,
              name: env.name,
              production: env.production,
              from: fromId,
              to: run.to ?? null,
              ok: false,
              code: ev.code,
              error: ev.error,
            },
          },
          ctx.security,
        );
        await send({ stage, ...ev });
      }
    });
  };

  const target = async (a: Awaited<ReturnType<typeof envAccess>>, to: string) => {
    const [v] = await db.query<{ id: string }>('select id from versions where id = $1 and project_id = $2', [
      to,
      a.pid,
    ]);
    if (!v) throw new HTTPException(404, { message: '版本不存在' });
  };

  app.post('/api/projects/:pid/environments/:eid/execute', async (c) => {
    const a = await envAccess(c, ctx, 'environment.execute');
    const b = await body(c, executeRequestSchema);
    await target(a, b.to);
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.execute', { mode: 'migrate', to: b.to, direction: 'up' });
  });

  app.post('/api/projects/:pid/environments/:eid/rollback', async (c) => {
    const a = await envAccess(c, ctx, 'environment.rollback');
    const b = await body(c, executeRequestSchema);
    await target(a, b.to);
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.rollback', { mode: 'migrate', to: b.to, direction: 'down' });
  });

  /** 写基线：库里的结构已经等于链上第一个版本（导入来源库），只写历史，不执行任何 SQL */
  app.post('/api/projects/:pid/environments/:eid/baseline', async (c) => {
    const a = await envAccess(c, ctx, 'environment.baseline');
    const b = await body(c, baselineRequestSchema);
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.baseline', { mode: 'baseline' });
  });
};
