// 环境的执行（H7）：状态、历史、漂移检查，以及执行 / 回滚 / 写基线（进度用 SSE，参考新建项目向导）。
// 特权操作按环境的“谁能执行”档位检查（H6，authz.ts 的 EnvAction）。
import {
  baselineRequestSchema,
  type DriftCheckResponse,
  type DryRunResponse,
  type EnvHistory,
  type EnvStatus,
  type ExecEvent,
  type ExecStage,
  executeRequestSchema,
  type MarkDryRunResponse,
  type MarkPlanInfo,
  type MarkResult as MarkResultInfo,
  markRequestSchema,
  type RepairScript,
} from '@dowel/api';
import { SESSION_SETTINGS } from '@dowel/engines';
import { claimOf, ExecutorError, type MarkPlan, repairRisks } from '@dowel/executor';
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

import {
  checkEnvDrift,
  dryRunExecution,
  dryRunMark,
  errorEvent,
  readTargetState,
  runExecution,
  runInfoOf,
  runMark,
} from '../executions.ts';
import { readSettings } from '../settings.ts';
import { sseSender } from '../sse.ts';
import { type AppContext, body, connectionLimit, type Env, envAccess } from './context.ts';

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
    connectionLimit(c, ctx);
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
    const claim = state.project ? claimOf(state, (await readSettings(db)).instanceId) : null;
    return c.json<EnvHistory>({
      initialized: state.current !== null || state.runs.length > 0,
      claim: claim && {
        mine: claim.mine,
        instanceId: claim.instanceId,
        claimedAt: claim.claimedAt,
        previousInstanceId: claim.previousInstanceId,
      },
      claims: state.claims.map((e) => ({
        id: e.id,
        instanceId: e.instanceId,
        previousInstanceId: e.previousInstanceId,
        claimedByName: e.claimedByName,
        claimedAt: e.claimedAt,
      })),
      currentVersion: cur ? versionRef(cur) : null,
      unfinished: state.unfinished ? runInfoOf(state.unfinished, refs, names) : null,
      readbackFailure: state.readbackFailure !== null,
      runs: runs.slice(-100).reverse(),
    });
  });

  /** 手动检查漂移：读目标库结构，与环境当前版本的模型比较，结果写进缓存 */
  app.post('/api/projects/:pid/environments/:eid/drift-check', async (c) => {
    const { env } = await envAccess(c, ctx, 'environment.check_drift');
    connectionLimit(c, ctx);
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

  /**
   * 只预演（dryRun）：做完全部执行前检查，列出要执行的迁移 / 步骤、哪些不在事务里、风险摘要；
   * 不写目标库，也不写平台库的登记。权限和真正的执行一样（它要连目标库，也会暴露将要执行的脚本）；
   * 生产环境不需要输入环境名（什么都不会写）。检查没通过也是 200，ok = false，带原因（和执行时的错误事件同一个形状）。
   */
  const dryRun = async (
    a: Awaited<ReturnType<typeof envAccess>>,
    userId: string,
    run: { mode: 'migrate' | 'baseline'; to?: string; direction?: 'up' | 'down' },
  ): Promise<DryRunResponse> => {
    try {
      const result = await dryRunExecution(ctx.exec, {
        pid: a.pid,
        projectName: a.name,
        env: a.env,
        mode: run.mode,
        to: run.to,
        direction: run.direction,
        userId,
      });
      const metas = new Map((await loadVersionMetas(db, a.pid)).map((m) => [m.id, m]));
      const plan = result.dryRun!;
      const ref = (v: { id: string; number: number; name: string } | null) => (v ? versionRef(v) : null);
      return {
        ok: true,
        plan: {
          mode: result.mode,
          direction: result.direction,
          firstRun: plan.firstRun,
          baseline: plan.baseline,
          from: ref(plan.from),
          to: ref(plan.to),
          migrations: plan.migrations.map((m) => {
            const meta = metas.get(m.versionId);
            const ev = meta ? toEnvVersion(meta, undefined, new Set()) : null;
            return {
              versionId: m.versionId,
              number: m.number,
              name: m.name,
              direction: m.direction,
              steps: m.steps,
              nonTransactional: m.nonTransactional,
              // 风险分析只针对升级脚本（回滚脚本没有锁和重写分析）
              risk: m.direction === 'up' ? (ev?.risk ?? null) : null,
              riskError: m.direction === 'up' ? (ev?.riskError ?? null) : null,
              verified: ev?.verified ?? false,
            };
          }),
          resume: plan.resume,
          createsHistory: plan.createsHistory,
          checks: plan.checks,
        },
      };
    } catch (e) {
      if (e instanceof HTTPException) throw e;
      const ev = errorEvent(e);
      // 连接不上等：errorEvent 会按 cause 分类；意外错误已经是“服务器内部错误”
      return { ok: false, ...ev };
    }
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
    if (b.dryRun)
      return c.json(await dryRun(a, c.get('user').id, { mode: 'migrate', to: b.to, direction: 'up' }));
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.execute', { mode: 'migrate', to: b.to, direction: 'up' });
  });

  app.post('/api/projects/:pid/environments/:eid/rollback', async (c) => {
    const a = await envAccess(c, ctx, 'environment.rollback');
    const b = await body(c, executeRequestSchema);
    await target(a, b.to);
    if (b.dryRun)
      return c.json(await dryRun(a, c.get('user').id, { mode: 'migrate', to: b.to, direction: 'down' }));
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.rollback', { mode: 'migrate', to: b.to, direction: 'down' });
  });

  // ───── 标记为已执行（ADR 0004） ─────

  const planInfo = (p: MarkPlan): MarkPlanInfo => ({
    direction: p.direction,
    from: p.from ? versionRef(p.from) : null,
    to: versionRef(p.to),
    skipped: p.skipped.map((v) => ({
      ...versionRef(v),
      upSteps: v.upSteps,
      downSteps: v.downSteps,
    })),
    fingerprint: p.fingerprint,
  });

  /**
   * 标记为已执行：不执行任何 SQL，把环境记为已到达链上任意版本（更新或更早）。硬条件：线上结构等于它的模型，
   * 否则拒绝并给出差异。特权操作（environment.mark，按执行档位；生产环境要环境名；向前标记要确认被跳过的版本）。
   * dryRun：只核对、返回计划（含被跳过的版本和脚本），不写任何东西；核对没通过也是 200 + ok:false。
   * 成功、失败各记一条审计（from、to、跳过的版本、线上结构指纹）。
   */
  app.post('/api/projects/:pid/environments/:eid/mark', async (c) => {
    const a = await envAccess(c, ctx, 'environment.mark');
    const b = await body(c, markRequestSchema);
    await target(a, b.to);
    const user = c.get('user');
    if (b.dryRun) {
      try {
        const r = await dryRunMark(ctx.exec, {
          pid: a.pid,
          projectName: a.name,
          env: a.env,
          to: b.to,
          userId: user.id,
        });
        return c.json<MarkDryRunResponse>({ ok: true, plan: planInfo(r.plan) });
      } catch (e) {
        if (e instanceof HTTPException) throw e;
        return c.json<MarkDryRunResponse>({ ok: false, ...errorEvent(e) });
      }
    }
    confirmed(a.env, b.confirm);
    const base = {
      projectId: a.pid,
      name: a.env.name,
      production: a.env.production,
      to: b.to,
      // P5 扩展点：标记不受前置环境约束（不跑脚本），豁免写进审计；接入审批后批准绑定 from / to / fingerprint
      prerequisiteExempt: true,
    };
    try {
      const r = await runMark(ctx.exec, {
        pid: a.pid,
        projectName: a.name,
        env: a.env,
        to: b.to,
        userId: user.id,
        acknowledge: b.acknowledge,
        expect: b.expect,
      });
      await audit(
        db,
        c,
        {
          action: 'environment.mark',
          actorKind: 'user',
          actorId: user.id,
          targetKind: 'environment',
          targetId: a.env.id,
          projectId: a.pid,
          data: {
            ...base,
            // from 用执行器在目标库历史里实际读到的当前版本，不用平台缓存
            from: r.plan.from?.id ?? null,
            direction: r.plan.direction,
            skipped: r.plan.skipped.map((v) => v.number),
            fingerprint: r.plan.fingerprint,
            ok: true,
          },
        },
        ctx.security,
      );
      return c.json<MarkResultInfo>({ plan: planInfo(r.plan), current: versionRef(r.plan.to) });
    } catch (e) {
      const ev = e instanceof HTTPException ? { error: e.message, code: 'rejected' as const } : errorEvent(e);
      await audit(
        db,
        c,
        {
          action: 'environment.mark',
          actorKind: 'user',
          actorId: user.id,
          targetKind: 'environment',
          targetId: a.env.id,
          projectId: a.pid,
          data: {
            ...base,
            // 失败时也记执行器读到的当前版本（读历史之前就失败了，比如连不上，就是 null）
            from: e instanceof ExecutorError ? (e.details.reached ?? null) : null,
            ok: false,
            code: ev.code,
            error: ev.error,
          },
        },
        ctx.security,
      );
      // 预期的拒绝（线上结构对不上、没确认……）：422 + 原因和差异，界面据此显示；意外错误走全局处理
      if (e instanceof HTTPException) throw e;
      if (e instanceof ExecutorError && e.code !== 'unexpected') {
        // 预演之后目标库变了：附上锁里重新算出的计划，界面据此刷新并让用户重新确认
        if (e.code === 'plan_changed' && e.details.markPlan)
          return c.json({ ...ev, details: { ...ev.details, plan: planInfo(e.details.markPlan) } }, 422);
        return c.json(ev, 422);
      }
      throw e;
    }
  });

  /**
   * 放弃线上的修改：修复脚本 = plan(线上结构, 当前版本的模型)，即漂移摘要里的差异（最近一次漂移检查的结果）。
   * 只显示、可复制；**Dowel 不代为执行**（它是临时 plan 出来的、没验证过的 SQL，ADR 0004）。
   * 模型表达不了的差异（unresolvable）单独列为“需要手工处理”。用户自己执行完后点“重新检查漂移”。
   */
  app.get('/api/projects/:pid/environments/:eid/repair-script', async (c) => {
    const { env } = await envAccess(c, ctx, 'environment.read');
    const d = driftInfo(env);
    const sum = d.status === 'drifted' ? d.summary : null;
    const items = sum?.items ?? [];
    const steps = items.filter((i) => i.kind !== 'unresolvable');
    const manual = items.filter((i) => i.kind === 'unresolvable');
    return c.json<RepairScript>({
      versionNumber: sum?.versionNumber ?? null,
      script: steps.length
        ? `${[...SESSION_SETTINGS, ...steps.map((s) => s.sql)].map((q) => `${q};`).join('\n')}\n`
        : null,
      steps,
      manual,
      total: sum?.total ?? 0,
      truncated: (sum?.total ?? 0) > items.length,
      // 按规划器 step 的 kind 分类（compare.ts 的 repairRisks），不靠文本里有没有 drop
      risks: repairRisks(steps),
    });
  });

  /** 写基线：库里的结构已经等于链上第一个版本（导入来源库），只写历史，不执行任何 SQL */
  app.post('/api/projects/:pid/environments/:eid/baseline', async (c) => {
    const a = await envAccess(c, ctx, 'environment.baseline');
    const b = await body(c, baselineRequestSchema);
    if (b.dryRun) return c.json(await dryRun(a, c.get('user').id, { mode: 'baseline' }));
    confirmed(a.env, b.confirm);
    return stream(c, a, 'environment.baseline', { mode: 'baseline' });
  });
};
