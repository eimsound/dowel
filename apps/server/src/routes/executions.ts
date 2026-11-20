// 环境的执行（H7）：状态、历史、漂移检查，以及执行 / 回滚 / 写基线（进度用 SSE，参考新建项目向导）。
// 特权操作按环境的“谁能执行”档位检查（H6，authz.ts 的 EnvAction）。
import {
  baselineRequestSchema,
  checkPrerequisite,
  type DriftCheckResponse,
  type DryRunResponse,
  type EnvHistory,
  type EnvStatus,
  type EnvVersionRef,
  type ExecEvent,
  type ExecStage,
  executeRequestSchema,
  type MarkDryRunResponse,
  type MarkPlanInfo,
  type MarkResult as MarkResultInfo,
  markRequestSchema,
  type PrerequisiteResult,
  type RepairScript,
} from '@dowel/api';
import { type Db, SESSION_SETTINGS } from '@dowel/engines';
import { claimOf, type ExecuteExpect, ExecutorError, type MarkPlan, repairRisks } from '@dowel/executor';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { audit } from '../audit.ts';
import { type EnvAction, userActor } from '../authz.ts';
import { inList } from '../db.ts';
import {
  driftInfo,
  type EnvRow,
  loadPrerequisite,
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
import { scrubSecrets } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import { sseSender } from '../sse.ts';
import { type AppContext, body, connectionLimit, type Env, envAccess } from './context.ts';

/** envAccess 的结果：项目、环境行、生效策略 */
export type EnvAccess = Awaited<ReturnType<typeof envAccess>>;
/** 执行只用到这几项：执行申请在锁内准备好它们（P5b） */
export type RunAccess = Pick<EnvAccess, 'pid' | 'name' | 'env' | 'auth'>;

/**
 * 前置环境检查（E6）：执行（向前）时目标版本不得高于前置环境（平台库缓存里）的当前版本；回滚 / 标记 / 写基线豁免。
 * 判断本身是 @dowel/api 的 checkPrerequisite（界面、预演、P6 的令牌执行共用）。没有设置前置环境时返回 null。
 */
export const prerequisiteOf = async (
  db: Db,
  a: Pick<EnvAccess, 'pid' | 'env'>,
  to: string | null,
  direction: 'up' | 'down' | 'mark' | 'baseline',
): Promise<PrerequisiteResult | null> => {
  // 只要序号：前置环境的名字和它当前版本（共用的轻量查询，悬空时是 missing）、目标版本的序号（不读脚本和验证报告）
  const p = await loadPrerequisite(db, a.pid, a.env.prerequisite_id);
  if (!p) return null;
  const [t] = to
    ? await db.query<{ number: number }>('select number from versions where id = $1 and project_id = $2', [
        to,
        a.pid,
      ])
    : await db.query<{ number: number }>('select min(number) as number from versions where project_id = $1', [
        a.pid,
      ]);
  // 设置了前置环境却找不到它（有外键 / 触发器，不应该发生）：missing，checkPrerequisite 宁可拒绝也不放宽
  const prerequisite = {
    id: p.id,
    name: p.name,
    currentNumber: p.currentVersion?.number ?? null,
    missing: p.missing === true,
  };
  const r = checkPrerequisite({ direction, targetNumber: t?.number ?? 0, prerequisite });
  return {
    ok: r.ok,
    exempt: r.ok && r.exempt,
    id: prerequisite.id,
    name: prerequisite.name,
    currentNumber: prerequisite.currentNumber,
    code: r.ok ? null : r.code,
    message: r.ok ? null : r.message,
  };
};

/** 执行策略里给执行器的超时（生效值） */
export const timeoutsOf = (a: Pick<EnvAccess, 'auth'>) => ({
  statementMs: a.auth.resolved.statementTimeoutMs.value,
  lockMs: a.auth.resolved.lockTimeoutMs.value,
});

// ───── 执行 / 回滚 / 写基线（SSE）：直接执行、执行申请、紧急执行共用 ─────

/** 一次执行的结果（给执行申请 / 紧急执行在结束后更新状态、发通知） */
export interface StreamOutcome {
  ok: boolean;
  current: EnvVersionRef | null;
  ran: number;
  error: { error: string; code?: string; details?: ExecEvent['details'] } | null;
}

export interface StreamOptions {
  /** 审计 data 里追加的字段（申请 id、紧急执行的原因……） */
  auditExtra?: Record<string, unknown>;
  /** 执行申请的绑定（P5b）：执行器在目标库锁里核对起点和迁移 */
  expect?: ExecuteExpect;
  /**
   * 执行结束（成功或失败）之后、最后一个 SSE 事件之前调用：执行申请据此改状态、发通知。
   * 不给时按“直接执行”处理：发 execution.finished 的 Webhook，并让这个环境上还没结束的申请重新检查（环境状态变了）。
   */
  onFinish?: (r: StreamOutcome) => Promise<void>;
}

export const execStream = (
  c: Context<Env>,
  ctx: AppContext,
  a: RunAccess,
  action: Extract<EnvAction, 'environment.execute' | 'environment.rollback' | 'environment.baseline'>,
  run: { mode: 'migrate' | 'baseline'; to?: string; direction?: 'up' | 'down' },
  prerequisite: PrerequisiteResult | null,
  opts: StreamOptions = {},
) => {
  const { db } = ctx;
  const { env } = a;
  const user = c.get('user');
  /** 审计里记下这次用的执行策略（谁能执行、超时）和前置环境（回滚 / 写基线是豁免） */
  const policyAudit = {
    whoCanExecute: a.auth.resolved.whoCanExecute.value,
    viaExecutor: a.auth.isExecutor,
    timeouts: timeoutsOf(a),
    ...(prerequisite
      ? {
          prerequisite: { name: prerequisite.name, currentNumber: prerequisite.currentNumber },
          ...(prerequisite.exempt ? { prerequisiteExempt: true } : {}),
        }
      : {}),
    ...opts.auditExtra,
  };
  const finish = async (r: StreamOutcome) => {
    try {
      if (opts.onFinish) await opts.onFinish(r);
      else await ctx.requests.afterDirectRun(user, a, run, r);
    } catch (e) {
      console.error('执行结束后的处理失败', e instanceof Error ? scrubSecrets(e.message) : e);
    }
  };
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (s) => {
    const send = sseSender<ExecEvent>(s);
    let stage: ExecStage = 'lock';
    const fromId = env.current_version_id;
    // 结果只由执行器决定（第二轮审查）：先得到结果，再**恰好一次**做结束处理（申请状态、通知、Webhook），最后才写审计；
    // 审计失败只记日志，不会让已经成功的迁移被记成失败，也不会让结束处理被跳过
    let outcome: StreamOutcome;
    let ev: ReturnType<typeof errorEvent> | null = null;
    let ranList: { number: number; direction: string }[] = [];
    try {
      const { result, current } = await runExecution(ctx.exec, {
        pid: a.pid,
        projectName: a.name,
        env,
        mode: run.mode,
        to: run.to,
        direction: run.direction,
        userId: user.id,
        timeouts: timeoutsOf(a),
        expect: opts.expect,
        onEvent: async (e) => {
          stage = e.stage;
          await send(e);
        },
      });
      ranList = result.ran.map((r) => ({ number: r.number, direction: r.direction }));
      outcome = { ok: true, current, ran: result.ran.length, error: null };
    } catch (e) {
      ev = errorEvent(e);
      outcome = { ok: false, current: null, ran: 0, error: ev };
    }
    await finish(outcome);
    try {
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
            ...(outcome.ok ? { to: outcome.current?.id ?? null, ran: ranList } : { to: run.to ?? null }),
            ...policyAudit,
            ok: outcome.ok,
            ...(ev ? { code: ev.code, error: ev.error } : {}),
          },
        },
        ctx.security,
      );
    } catch (e) {
      console.error('写执行审计失败', e instanceof Error ? scrubSecrets(e.message) : e);
    }
    if (outcome.ok) await send({ stage: 'done', current: outcome.current, ran: outcome.ran });
    else await send({ stage, ...ev! });
  });
};

/**
 * 只预演（dryRun）：做完全部执行前检查，列出要执行的迁移 / 步骤、哪些不在事务里、风险摘要；
 * 不写目标库，也不写平台库的登记。权限和真正的执行一样（它要连目标库，也会暴露将要执行的脚本）；
 * 生产环境不需要输入环境名（什么都不会写）。检查没通过也是 200，ok = false，带原因（和执行时的错误事件同一个形状）。
 * 执行申请提交前也跑它（P5b）：不通过不能提交，通过的计划就是申请绑定的迁移。
 */
export const dryRunFor = async (
  ctx: AppContext,
  a: Pick<EnvAccess, 'pid' | 'name' | 'env'>,
  userId: string,
  run: { mode: 'migrate' | 'baseline'; to?: string; direction?: 'up' | 'down' },
  prerequisite: PrerequisiteResult | null,
): Promise<DryRunResponse> => {
  const { db } = ctx;
  // 前置环境没满足：不用连目标库就知道会被拒绝，和真正执行时同一个代码和说明
  if (prerequisite && !prerequisite.ok)
    return {
      ok: false,
      error: prerequisite.message ?? '前置环境检查没有通过',
      code: prerequisite.code ?? 'prerequisite_behind',
      details: { prerequisite },
      prerequisite,
    };
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
      prerequisite,
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
            checksum: m.checksum,
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
    return { ok: false, ...ev, prerequisite };
  }
};

/**
 * 环境生效的审批流程配置了环节（P5b）：执行 / 回滚必须走执行申请，谁都不能直接执行（实例管理员另有紧急执行）。
 * 没配置环节是默认流程：有执行权限的人直接执行，没有的提交申请、由有执行权限的人“通过并执行”。
 * 写基线、标记为已执行不跑脚本，不走审批（仍然受“谁能执行”约束）。
 */
export const approvalRequired = (a: Pick<EnvAccess, 'auth'>) => a.auth.resolved.approval.stages.length > 0;
export const APPROVAL_REQUIRED = {
  error: '这个环境的执行策略要求审批：请提交执行申请，审批通过后再执行',
  code: 'approval_required',
} as const;

/** 目标版本要在这个项目的链上（404） */
export const assertVersion = async (db: Db, pid: string, to: string) => {
  const [v] = await db.query<{ id: string }>('select id from versions where id = $1 and project_id = $2', [
    to,
    pid,
  ]);
  if (!v) throw new HTTPException(404, { message: '版本不存在' });
};

/** 生产环境的执行 / 回滚 / 写基线必须在请求里带上环境名（服务端校验，不只是界面上的确认框） */
export const confirmed = (env: EnvRow, confirm: string | undefined) => {
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
    const { env, role, auth } = await envAccess(c, ctx, 'environment.read');
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
      execPolicy: auth.resolved.whoCanExecute.own,
      effectiveExecPolicy: auth.resolved.whoCanExecute.value,
      policy: auth.resolved,
      prerequisite: await loadPrerequisite(db, env.project_id, env.prerequisite_id),
      currentVersion: cur ? versionRef(cur) : null,
      versions,
      pending: versions.filter((v) => v.state === 'pending').map((v) => v.id),
      drift: driftInfo(env),
      permissions: permissionsOf(userActor(c.get('user')), env, role, auth),
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
    // P5b：读历史会把目标库的当前版本同步进缓存，可能和申请绑定的起点不一样了
    ctx.requests.kick({ envIds: [env.id] });
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
    const result = await checkEnvDrift(ctx.exec, env);
    // P5b：检测到漂移会让这个环境上还没结束的执行申请失效
    ctx.requests.kick({ envIds: [env.id] });
    return c.json<DriftCheckResponse>(result);
  });

  app.post('/api/projects/:pid/environments/:eid/execute', async (c) => {
    const a = await envAccess(c, ctx, 'environment.execute');
    const b = await body(c, executeRequestSchema);
    await assertVersion(db, a.pid, b.to);
    const prerequisite = await prerequisiteOf(db, a, b.to, 'up');
    const run = { mode: 'migrate', to: b.to, direction: 'up' } as const;
    if (b.dryRun) return c.json(await dryRunFor(ctx, a, c.get('user').id, run, prerequisite));
    // 配置了审批环节：谁都不能直接执行（实例管理员也走审批，另有紧急执行），要提交执行申请（P5b）
    if (approvalRequired(a)) return c.json(APPROVAL_REQUIRED, 403);
    // 前置环境没满足（还没到目标版本，或者设置的前置环境不存在）：422，什么都不做
    // （也不写审计——和其他请求校验失败一样，没有开始执行）
    if (prerequisite && !prerequisite.ok)
      return c.json(
        {
          error: prerequisite.message,
          code: prerequisite.code ?? 'prerequisite_behind',
          details: { prerequisite },
        },
        422,
      );
    confirmed(a.env, b.confirm);
    return execStream(c, ctx, a, 'environment.execute', run, prerequisite);
  });

  app.post('/api/projects/:pid/environments/:eid/rollback', async (c) => {
    const a = await envAccess(c, ctx, 'environment.rollback');
    const b = await body(c, executeRequestSchema);
    await assertVersion(db, a.pid, b.to);
    // 回滚不受前置环境约束（豁免记进审计），见 checkPrerequisite
    const prerequisite = await prerequisiteOf(db, a, b.to, 'down');
    const run = { mode: 'migrate', to: b.to, direction: 'down' } as const;
    if (b.dryRun) return c.json(await dryRunFor(ctx, a, c.get('user').id, run, prerequisite));
    if (approvalRequired(a)) return c.json(APPROVAL_REQUIRED, 403);
    confirmed(a.env, b.confirm);
    return execStream(c, ctx, a, 'environment.rollback', run, prerequisite);
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
    await assertVersion(db, a.pid, b.to);
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
      // 标记不受前置环境约束（不跑脚本，ADR 0004），豁免写进审计；P5b 接入审批后批准绑定 from / to / fingerprint
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
      // P5b：标记改变了环境的当前版本，这个环境上还没结束的执行申请会失效
      ctx.requests.kick({ envIds: [a.env.id] });
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
    // 写基线不执行脚本（标记为已执行的特例），不受前置环境约束
    const prerequisite = await prerequisiteOf(db, a, null, 'baseline');
    if (b.dryRun)
      return c.json(await dryRunFor(ctx, a, c.get('user').id, { mode: 'baseline' }, prerequisite));
    confirmed(a.env, b.confirm);
    return execStream(c, ctx, a, 'environment.baseline', { mode: 'baseline' }, prerequisite);
  });
};
