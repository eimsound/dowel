// 执行申请、审批、紧急执行与收件箱的接口（P5b：E3 / E4 / E5 / E7；规则见 requests.ts 开头和 ADR 0006、0007）。
//
// 所有改变申请状态的操作都在执行策略锁里：锁内重新读项目（当前所属的组）、调用者的成员关系、申请、环境状态和生效策略，
// 先做绑定检查（失效 / 过期就把申请转成终态并返回 409），再判断资格、推进环节。真正的执行在锁外（拿环境锁、目标库项目锁），
// “执行中”这个状态保证同一个申请不会被执行两次，执行器在目标库锁里按目标库历史再核对一次绑定。
import {
  type DryRunResponse,
  type ExecRequestSummary,
  emergencyExecuteSchema,
  type InboxEvent,
  type InboxList,
  requestApproveSchema,
  requestCreateSchema,
  requestExecuteSchema,
  type RequestKind,
  requestRejectSchema,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { auditIn } from '../audit.ts';
import type { User } from '../auth.ts';
import { can, userActor } from '../authz.ts';
import { dbNowSql, inList, readDbNow } from '../db.ts';
import { envResource, iso, loadEnv } from '../envs.ts';
import { accessIn, envAuthOf, loadPolicies, withPolicyLock } from '../policy.ts';
import {
  bindingProblem,
  connHash,
  Effects,
  eligibleFor,
  execDirectionOf,
  flowOf,
  hasExecRight,
  isInterrupted,
  loadAudience,
  loadRequest,
  type RequestRow,
  Requests,
  type StageScope,
  stagesOf,
  statusLabel,
} from '../requests.ts';
import { effectiveRole, loadRoleContext } from '../roles.ts';
import { sseSender } from '../sse.ts';
import {
  type AppContext,
  access,
  body,
  CodedHTTPException,
  connectionLimit,
  type Env,
  envAccess,
} from './context.ts';
import { assertVersion, confirmed, dryRunFor, execStream, type RunAccess } from './executions.ts';

/** 申请里的操作（都在执行策略锁里做） */
type Op =
  | { kind: 'approve'; stage: number; comment: string; execute?: { confirm?: string } }
  | { kind: 'reject'; stage: number; comment: string }
  | { kind: 'withdraw' }
  | { kind: 'execute'; confirm?: string };

/** 执行需要的一切：在锁内、转成 executing 之前就准备好（第一轮审查：之后再做检查，失败会让申请停在 executing） */
interface RunPlan {
  a: RunAccess;
}

interface OpResult {
  req: RequestRow;
  /** 绑定不成立：申请已转成失效 / 过期（已提交），返回 409 */
  stale?: { status: string; reason: string };
  /** 要开始执行（状态已经是 executing） */
  execute?: RunPlan;
}

const conflict = (message: string) => new HTTPException(409, { message });
const forbidden = (message: string) => new HTTPException(403, { message });
const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * 审批 / 驳回 / 撤回 / 执行：锁内的全部判断。返回之后由调用方提交事务、发通知、（需要时）开始执行。
 */
const decideIn = async (
  tx: Db,
  c: Context<Env>,
  requests: Requests,
  user: User,
  pid: string,
  rid: string,
  op: Op,
  fx: Effects,
): Promise<OpResult> => {
  const { project, rc } = await accessIn(tx, user, pid);
  const req = await loadRequest(tx, pid, rid);
  const me = { id: user.id, name: user.name };
  // 紧急执行的记录不走申请的流程（第一轮审查）：失败后不能由有执行权的人经 /execute 重试（那等于绕过全部审批），
  // 也不能撤回；要再来一次就重新发起紧急执行（实例管理员）或提交执行申请
  if (req.emergency)
    throw conflict('紧急执行的记录不能在这里重试或撤回：需要的话请重新发起紧急执行，或提交执行申请');
  // 执行中被中断（结果未知）的申请不能直接重试或撤回：避免在状态未明时重复执行，也避免覆盖中断状态击穿原节点 finish() 兜底（#18）
  if (isInterrupted(req))
    throw conflict(
      '执行中服务重启或执行节点离线，结果未知，不能直接重试或撤回：请到环境页查看执行历史后重新提交执行申请',
    );
  if (op.kind === 'withdraw') {
    if (req.requested_by !== user.id) throw forbidden('只有申请人能撤回申请');
    if (req.status !== 'pending' && req.status !== 'approved' && req.status !== 'failed')
      throw conflict(`申请${statusLabel(req.status)}，不能撤回`);
    await requests.setStatus(tx, c, req, 'withdrawn', null, me, fx);
    return { req };
  }
  if (req.status === 'executing') throw conflict('申请正在执行');
  if (req.status !== 'pending' && req.status !== 'approved' && req.status !== 'failed')
    throw conflict(`申请${statusLabel(req.status)}${req.status_reason ? `：${req.status_reason}` : ''}`);
  // 绑定检查：环境状态变了 / 过期 / 流程变严 → 转成终态（提交），返回 409
  const problem = await bindingProblem(tx, req, await readDbNow(tx, requests.db.dialect));
  if (problem) {
    await requests.setStatus(tx, c, req, problem.status, problem.reason, null, fx);
    return { req, stale: problem };
  }
  const s = (await requests.scopeOf(tx, req))!;
  const scope: StageScope = requests.stageScope(s, req);
  const stages = stagesOf(req.flow);
  const right = hasExecRight(rc, scope);
  let startExecute: { confirm?: string } | null = op.kind === 'execute' ? { confirm: op.confirm } : null;

  if (op.kind === 'approve' || op.kind === 'reject') {
    if (req.status !== 'pending') throw conflict('申请已经全部通过，不在审批中');
    // 每个环节单独确认：请求里带的环节必须是当前环节（不能一次点击跨过多个环节，也防止界面过期时误批下一个环节）
    if (op.stage !== req.stage) throw conflict('这个环节已经处理过了，请刷新后再看');
    if (req.requested_by === user.id) throw forbidden('申请人不能审批自己的申请');
    const spec = stages[req.stage]!;
    if (!eligibleFor(rc, spec, scope)) throw forbidden('你不在当前环节的审批人范围内');
    const decided = await tx.query<{ decision: string; user_id: string | null }>(
      'select decision, user_id from exec_approvals where request_id = $1 and stage = $2',
      [req.id, req.stage],
    );
    if (decided.some((d) => d.user_id === user.id)) throw conflict('你已经处理过这个环节');
    const insert = (decision: 'approve' | 'reject') =>
      tx.query(
        `insert into exec_approvals (id, request_id, stage, user_id, decision, comment, at)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [newId(), req.id, req.stage, user.id, decision, op.comment, new Date().toISOString()],
      );
    if (op.kind === 'reject') {
      await insert('reject');
      await requests.setStatus(tx, c, req, 'rejected', op.comment, me, fx, { comment: op.comment });
      return { req };
    }
    const approvedCount = decided.filter((d) => d.decision === 'approve').length + 1;
    const stageDone = approvedCount >= spec.count;
    const final = stageDone && req.stage === stages.length - 1;
    // 「最后一个审批人即执行者」：凑够最后一个环节的那一次通过必须同时执行（“通过并执行”），而且要有执行权限
    if (final && spec.lastApproverExecutes && !op.execute)
      throw unprocessable('最后一个环节设置了“最后一个审批人即执行者”：请用“通过并执行”');
    if (op.execute && !(final && spec.lastApproverExecutes))
      throw unprocessable('只有凑够最后一个环节、并且设置了“最后一个审批人即执行者”时才能“通过并执行”');
    if (op.execute && !right) throw forbidden('你没有这个环境的执行权限，不能“通过并执行”');
    if (op.execute) {
      confirmed(s.env, op.execute.confirm);
      startExecute = op.execute;
    }
    await insert('approve');
    await auditIn(
      tx,
      c,
      {
        action: 'exec_request.approve',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'exec_request',
        targetId: req.id,
        projectId: req.project_id,
        data: {
          environmentId: req.environment_id,
          stage: req.stage,
          comment: op.comment,
          approvals: approvedCount,
          count: spec.count,
          ...(op.execute ? { andExecute: true } : {}),
        },
      },
      requests.security,
    );
    fx.requestsChanged = true;
    if (stageDone) {
      req.stage += 1;
      const now = new Date().toISOString();
      if (req.stage < stages.length) {
        await tx.query('update exec_requests set stage = $2, updated_at = $3 where id = $1', [
          req.id,
          req.stage,
          now,
        ]);
        // 下一个环节的审批人
        const next = await requests.eligibleUsers(tx, req, s, req.stage);
        await requests.notify(
          tx,
          next.map((u) => u.userId),
          'approval_needed',
          req,
          s,
          fx,
          { event: 'needs', action: 'approve', actor: user.name, stage: req.stage },
        );
      } else {
        req.status = 'approved';
        await tx.query(
          "update exec_requests set stage = $2, status = 'approved', updated_at = $3 where id = $1",
          [req.id, req.stage, now],
        );
        await requests.queueHook(tx, fx, 'request.approved', req, s, {
          actor: user.name,
          status: 'approved',
        });
        if (!startExecute) {
          if (req.requested_by)
            await requests.notify(tx, [req.requested_by], 'request_result', req, s, fx, {
              event: 'approved',
              status: 'approved',
              actor: user.name,
            });
          // 申请人自己没有执行权限：告诉有执行权限的人可以执行了（只读项目的受众）
          const all = await loadAudience(tx, s.project);
          const requester = req.requested_by ? all.get(req.requested_by) : undefined;
          if (!requester || !hasExecRight(requester, scope)) {
            const execs = (await requests.executors(tx, req, s, all)).map((u) => u.userId);
            await requests.notify(
              tx,
              execs,
              'approval_needed',
              req,
              s,
              fx,
              { event: 'needs', action: 'execute', actor: user.name },
              all,
            );
          }
        }
      }
    }
    if (!startExecute) return { req };
  }

  // 执行：全部通过（或执行失败可以重试）之后，由有执行权限的人执行
  if (req.status !== 'approved' && req.status !== 'failed') throw conflict('申请还没有全部通过');
  if (!right) throw forbidden('你没有这个环境的执行权限：审批不会给执行权限，请让有执行权限的人执行');
  confirmed(s.env, startExecute!.confirm);
  // 执行用到的项目、环境、生效策略（超时、执行者身份）都在这里、锁内读好
  const auth = envAuthOf(s.store, rc, project, s.env);
  const run: RunPlan = { a: { pid: project.id, name: project.name, env: s.env, auth } };
  const now = new Date().toISOString();
  await tx.query(
    "update exec_requests set status = 'executing', executed_by = $2, updated_at = $3, status_reason = null, worker_id = $4 where id = $1",
    [req.id, user.id, now, requests.workerId],
  );
  await auditIn(
    tx,
    c,
    {
      action: 'exec_request.execute',
      actorKind: 'user',
      actorId: user.id,
      targetKind: 'exec_request',
      targetId: req.id,
      projectId: req.project_id,
      data: { environmentId: req.environment_id, retry: req.status === 'failed' },
    },
    requests.security,
  );
  req.status = 'executing';
  fx.requestsChanged = true;
  return { req, execute: run };
};

/**
 * 开始执行一个已经转成 executing 的申请（SSE）。执行用到的一切都已经在锁内准备好（RunPlan），这里不再做任何检查；
 * execStream 同步地返回 SSE 响应，执行器里的任何失败（包括拿环境锁、连目标库之前的错误）都由它的结束处理
 * （恰好一次，见 execStream）转成执行失败，申请不会停在 executing。
 */
const runRequest = (c: Context<Env>, ctx: AppContext, req: RequestRow, { a }: RunPlan) => {
  const user = c.get('user');
  const me = { id: user.id, name: user.name };
  const dir = execDirectionOf(req);
  const action =
    dir === 'down' ? 'environment.rollback' : dir === 'switch' ? 'environment.switch' : 'environment.execute';
  return execStream(
    c,
    ctx,
    a,
    action,
    { to: req.to_version_id, direction: dir },
    {
      auditExtra: { requestId: req.id, ...(req.emergency ? { emergency: true, reason: req.reason } : {}) },
      expect: {
        from: req.from_version_id,
        migrations: req.migrations.map((m) => ({
          versionId: m.versionId,
          direction: m.direction,
          checksum: m.checksum,
        })),
      },
      // 执行结束（成功、失败、执行器判为状态已变）：在锁里条件更新申请状态、通知、Webhook
      onFinish: (r) => ctx.requests.finish(c, req.id, me, r),
    },
  );
};

const listQuery = z.object({
  environment: z.string().optional(),
  status: z.enum(['open', 'all']).optional(),
});

/**
 * 预演 → 申请绑定的迁移快照。绑定的是**预演用的那一份**校验和（第一轮审查：之前在锁内重新读平台库，预演之后脚本被改，
 * 就会绑定一个没预演过的版本）：锁内读到的校验和和预演时的不一样 → 409，让用户重新预演。
 * ADR 0013：非回滚申请禁止目标或任何升级段版本已作废（允许回滚段里的已作废版本）。
 */
export const snapshotOf = async (
  db: Db,
  pid: string,
  plan: NonNullable<DryRunResponse['plan']>,
  kind: RequestKind,
  toVersionId: string,
) => {
  const rows = await db.query<{
    id: string;
    number: number;
    name: string;
    checksum: string;
    retired_at: unknown;
  }>('select id, number, name, checksum, retired_at from versions where project_id = $1', [pid]);
  const byId = new Map(rows.map((v) => [v.id, v]));
  if (kind !== 'rollback') {
    const target = byId.get(toVersionId);
    if (!target) throw conflict('目标版本在预演之后不存在了，请重新预演');
    if (target.retired_at !== null && target.retired_at !== undefined)
      throw new CodedHTTPException(
        409,
        `版本 v${target.number}「${target.name}」已作废，不能${kind === 'switch' ? '切换到它' : '升级到它'}`,
        'retired_target',
      );
  }
  return plan.migrations.map((m) => {
    const v = byId.get(m.versionId);
    if (!v) throw conflict(`版本 v${m.number} 在预演之后不存在了，请重新预演`);
    if (v.checksum !== m.checksum)
      throw conflict(`版本 v${m.number} 的脚本在预演之后被修改了，请重新预演后再提交`);
    if (m.direction === 'up' && v.retired_at !== null && v.retired_at !== undefined)
      throw new CodedHTTPException(
        409,
        `版本 v${m.number}「${v.name}」在预演之后已被作废，不能升级到它`,
        'retired_target',
      );
    return {
      versionId: m.versionId,
      number: m.number,
      name: m.name,
      direction: m.direction as 'up' | 'down',
      checksum: v.checksum,
      steps: m.steps.length,
      nonTransactional: m.nonTransactional,
    };
  });
};

export const registerRequests = (app: Hono<Env>, ctx: AppContext) => {
  const { db, requests } = ctx;

  /** 项目里的执行申请（可按环境、只看还没结束的） */
  app.get('/api/projects/:pid/requests', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const q = listQuery.safeParse(c.req.query());
    if (!q.success) throw new HTTPException(400, { message: '查询参数不合法' });
    const params: unknown[] = [a.pid];
    let where = 'project_id = $1';
    if (q.data.environment) {
      params.push(q.data.environment);
      where += ` and environment_id = $${params.length}`;
    }
    if (q.data.status === 'open') where += ` and status in ('pending', 'approved', 'executing', 'failed')`;
    const rows = await db.query<RequestRow>(
      `select * from exec_requests where ${where} order by created_at desc limit 200`,
      params,
    );
    return c.json<ExecRequestSummary[]>(await requests.summaries(db, rows));
  });

  /**
   * 提交执行申请。先跑一次预演（和确认对话框同一个检查：完整性、漂移、认领……），不通过不能提交；
   * dryRun = true 只返回预演结果（没有直接执行权限的人在对话框里看预演用这个）。
   */
  app.post('/api/projects/:pid/environments/:eid/requests', async (c) => {
    const a = await envAccess(c, ctx, 'environment.request');
    const b = await body(c, requestCreateSchema.extend({ dryRun: z.boolean().optional() }));
    const user = c.get('user');
    const target = await assertVersion(db, a.pid, b.to);
    const execDir = b.kind === 'rollback' ? 'down' : b.kind === 'switch' ? 'switch' : 'up';
    // exec_requests.direction 列约束仍为 ('up', 'down')：switch 存为 'up'，API 返回的 kind 由 migrations 推导
    const storedDir = b.kind === 'rollback' ? 'down' : 'up';
    if (!b.dryRun) {
      if (b.kind !== 'rollback' && target.retired_at !== null && target.retired_at !== undefined)
        return c.json(
          { error: `版本 v${target.number}「${target.name}」已作废，不能提交该申请`, code: 'retired_target' },
          409,
        );
      if (b.kind === 'switch' && b.acknowledgeRollback !== true)
        return c.json(
          { error: '切换申请必须确认回滚段会执行回滚脚本、可能造成数据丢失', code: 'rollback_ack_required' },
          422,
        );
    }
    connectionLimit(c, ctx);
    const dry = await dryRunFor(ctx, a, user.id, { to: b.to, direction: execDir });
    if (b.dryRun) return c.json(dry);
    if (!dry.ok || !dry.plan)
      return c.json(
        {
          error: `预演没有通过，不能提交申请：${dry.error ?? ''}`,
          code: dry.code ?? 'dry_run_failed',
          details: dry.details,
        },
        422,
      );
    if (!dry.plan.migrations.length) throw unprocessable('环境已经在目标版本，不需要执行');
    const plan = dry.plan;
    const fx = new Effects();
    const rid = await withPolicyLock(db, async (tx) => {
      const { project, rc, role } = await accessIn(tx, user, a.pid);
      const env = await loadEnv(tx, a.pid, a.env.id);
      const store = await loadPolicies(tx, project);
      const auth = envAuthOf(store, rc, project, env);
      if (!can(userActor(user), 'environment.request', envResource(env, role, auth)))
        throw forbidden('没有提交执行申请的权限（需要项目编辑者以上，或者执行者）');
      if ((env.current_version_id ?? null) !== (plan.from?.id ?? null))
        throw conflict(
          '环境的当前版本和预演读到的不一致（平台库的缓存可能落后于目标库）：请在环境页刷新执行历史后重新提交',
        );
      if (env.drift_status === 'drifted') throw conflict('环境检测到漂移，不能提交申请');
      const migrations = await snapshotOf(tx, a.pid, plan, b.kind, b.to);
      const flow = flowOf(auth.resolved);
      const id = newId();
      const dbNow = await readDbNow(tx, db.dialect);
      const expiresAt = Requests.expiry(auth.resolved, dbNow);
      const downIds = migrations.filter((m) => m.direction === 'down').map((m) => m.versionId);
      const dryRunJson = JSON.stringify({
        firstRun: plan.firstRun,
        createsHistory: plan.createsHistory,
        resume: plan.resume ? { versionId: plan.resume.versionId, afterStep: plan.resume.afterStep } : null,
        checks: plan.checks,
      });
      const baseParams = [
        id,
        a.pid,
        env.id,
        user.id,
        storedDir,
        env.current_version_id,
        b.to,
        JSON.stringify(migrations),
        dryRunJson,
        b.reason,
        JSON.stringify(flow),
        connHash(env),
        env.production,
        expiresAt,
      ];
      if (db.dialect === 'pg') {
        const createdExpr = downIds.length
          ? `greatest(clock_timestamp(), coalesce((select max(retired_at) from versions where project_id = $2 and id in (${inList(downIds, 15)})), '-infinity'::timestamptz))`
          : 'clock_timestamp()';
        await tx.query(
          `insert into exec_requests (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
              migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10, $11::text::jsonb, $12, $13, 'pending', 0, $14, ${createdExpr}, clock_timestamp())`,
          downIds.length ? [...baseParams, ...downIds] : baseParams,
        );
      } else {
        const nowIso = dbNow.toISOString();
        let createdAt = nowIso;
        if (downIds.length) {
          const [maxRow] = await tx.query<{ m: unknown }>(
            `select max(retired_at) as m from versions where project_id = $1 and retired_at is not null and id in (${inList(downIds, 2)})`,
            [a.pid, ...downIds],
          );
          const maxIso = iso(maxRow?.m);
          if (maxIso && new Date(maxIso).getTime() > dbNow.getTime()) {
            createdAt = new Date(maxIso).toISOString();
          }
        }
        await tx.query(
          `insert into exec_requests (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
              migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10, $11::text::jsonb, $12, $13, 'pending', 0, $14, $15, $16)`,
          [...baseParams, createdAt, nowIso],
        );
      }
      await auditIn(
        tx,
        c,
        {
          action: 'exec_request.create',
          actorKind: 'user',
          actorId: user.id,
          targetKind: 'exec_request',
          targetId: id,
          projectId: a.pid,
          data: {
            environmentId: env.id,
            name: env.name,
            production: env.production,
            kind: b.kind,
            direction: execDir,
            from: env.current_version_id,
            to: b.to,
            ...(plan.lca ? { lca: plan.lca } : {}),
            migrations: migrations.map((m) => ({
              number: m.number,
              direction: m.direction,
              checksum: m.checksum,
            })),
            stages: stagesOf(flow).length,
            implicit: flow.implicit,
            ttlHours: auth.resolved.requestTtlHours.value,
            reason: b.reason,
          },
        },
        ctx.security,
      );
      const req = await loadRequest(tx, a.pid, id);
      const s = (await requests.scopeOf(tx, req))!;
      const approvers = await requests.eligibleUsers(tx, req, s, 0);
      await requests.notify(
        tx,
        approvers.map((u) => u.userId),
        'approval_needed',
        req,
        s,
        fx,
        { event: 'needs', action: 'approve', actor: user.name, stage: 0 },
      );
      await requests.queueHook(tx, fx, 'request.created', req, s, { actor: user.name, status: 'pending' });
      fx.requestsChanged = true;
      return id;
    });
    await requests.flushEffects(fx);
    const req = await loadRequest(db, a.pid, rid);
    return c.json(await requests.detail(db, req, user, a.rc), 201);
  });

  /** 申请详情（项目可见即可看）；还没结束的先做一次绑定检查（失效 / 过期的当场转成终态） */
  app.get('/api/projects/:pid/requests/:rid', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const rid = c.req.param('rid');
    let req = await loadRequest(db, a.pid, rid);
    if (
      (req.status === 'pending' || req.status === 'approved' || req.status === 'failed') &&
      !isInterrupted(req)
    ) {
      await requests.recheck(req.id);
      req = await loadRequest(db, a.pid, rid);
    }
    return c.json(await requests.detail(db, req, c.get('user'), a.rc));
  });

  /** 看得到项目再解析请求体（看不见的一律 404，不因为请求体不合法先返回 400） */
  const decide = async (c: Context<Env>, a: Awaited<ReturnType<typeof access>>, op: Op) => {
    const user = c.get('user');
    const fx = new Effects();
    const out = await withPolicyLock(db, (tx) =>
      decideIn(tx, c, requests, user, a.pid, c.req.param('rid')!, op, fx),
    );
    await requests.flushEffects(fx);
    if (out.stale)
      return {
        response: c.json(
          {
            error: `申请已${out.stale.status === 'expired' ? '过期' : '失效'}：${out.stale.reason}`,
            code: `request_${out.stale.status}`,
          },
          409,
        ),
      };
    return { out, a };
  };

  app.post('/api/projects/:pid/requests/:rid/approve', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const b = await body(c, requestApproveSchema);
    const r = await decide(c, a, { kind: 'approve', stage: b.stage, comment: b.comment });
    if (r.response) return r.response;
    const req = await loadRequest(db, r.a.pid, r.out.req.id);
    return c.json(await requests.detail(db, req, c.get('user'), r.a.rc));
  });

  app.post('/api/projects/:pid/requests/:rid/reject', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const b = await body(c, requestRejectSchema);
    const r = await decide(c, a, { kind: 'reject', stage: b.stage, comment: b.comment });
    if (r.response) return r.response;
    const req = await loadRequest(db, r.a.pid, r.out.req.id);
    return c.json(await requests.detail(db, req, c.get('user'), r.a.rc));
  });

  app.post('/api/projects/:pid/requests/:rid/withdraw', async (c) => {
    const r = await decide(c, await access(c, ctx, 'project.read'), { kind: 'withdraw' });
    if (r.response) return r.response;
    const req = await loadRequest(db, r.a.pid, r.out.req.id);
    return c.json(await requests.detail(db, req, c.get('user'), r.a.rc));
  });

  /** 执行（SSE）：全部通过后的“执行”，或带 approve 的“通过并执行” */
  app.post('/api/projects/:pid/requests/:rid/execute', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const b = await body(c, requestExecuteSchema);
    const r = await decide(
      c,
      a,
      b.approve
        ? {
            kind: 'approve',
            stage: b.approve.stage,
            comment: b.approve.comment,
            execute: { confirm: b.confirm },
          }
        : { kind: 'execute', confirm: b.confirm },
    );
    if (r.response) return r.response;
    if (!r.out.execute) throw conflict('申请没有进入执行');
    return runRequest(c, ctx, r.out.req, r.out.execute);
  });

  /**
   * 紧急执行（E5）：只有实例管理员；绕过审批流程，**不绕过**漂移、完整性、认领等检查（先预演，不通过就拒绝）。
   * 必填原因、生产环境要输入环境名；审计，通知这个环境审批流程里的所有审批人。记成一条 emergency = true 的申请（详情页有记录）。
   */
  app.post('/api/projects/:pid/environments/:eid/emergency', async (c) => {
    const a = await envAccess(c, ctx, 'environment.read');
    const user = c.get('user');
    if (!can(userActor(user), 'instance.emergency_execute', { kind: 'instance' }))
      throw forbidden('只有实例管理员能紧急执行');
    const b = await body(c, emergencyExecuteSchema);
    const target = await assertVersion(db, a.pid, b.to);
    const execDir = b.kind === 'rollback' ? 'down' : b.kind === 'switch' ? 'switch' : 'up';
    const storedDir = b.kind === 'rollback' ? 'down' : 'up';
    if (b.kind !== 'rollback' && target.retired_at !== null && target.retired_at !== undefined)
      return c.json(
        { error: `版本 v${target.number}「${target.name}」已作废，不能紧急执行到它`, code: 'retired_target' },
        409,
      );
    if (b.kind === 'switch' && b.acknowledgeRollback !== true)
      return c.json(
        { error: '紧急切换必须确认回滚段会执行回滚脚本、可能造成数据丢失', code: 'rollback_ack_required' },
        422,
      );
    confirmed(a.env, b.confirm);
    connectionLimit(c, ctx);
    const dry = await dryRunFor(ctx, a, user.id, { to: b.to, direction: execDir });
    if (!dry.ok || !dry.plan)
      return c.json(
        {
          error: dry.error ?? '执行前检查没有通过',
          code: dry.code ?? 'dry_run_failed',
          details: dry.details,
        },
        422,
      );
    if (!dry.plan.migrations.length) throw unprocessable('环境已经在目标版本，不需要执行');
    const plan = dry.plan;
    const fx = new Effects();
    const out = await withPolicyLock(db, async (tx) => {
      const { project, rc } = await accessIn(tx, user, a.pid);
      const env = await loadEnv(tx, a.pid, a.env.id);
      if ((env.current_version_id ?? null) !== (plan.from?.id ?? null))
        throw conflict('环境的当前版本在检查之后变了，请重试');
      confirmed(env, b.confirm);
      const auth = envAuthOf(await loadPolicies(tx, project), rc, project, env);
      const migrations = await snapshotOf(tx, a.pid, plan, b.kind, b.to);
      const flow = flowOf(auth.resolved);
      const id = newId();
      const dbNow = await readDbNow(tx, db.dialect);
      const nowSql = dbNowSql(db.dialect);
      await tx.query(
        `insert into exec_requests (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
            migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at,
            executed_by, emergency, worker_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, null, $9, $10::text::jsonb, $11, $12, 'executing', $13, $14, ${nowSql}, ${nowSql}, $4, $15, $16)`,
        [
          id,
          a.pid,
          env.id,
          user.id,
          storedDir,
          env.current_version_id,
          b.to,
          JSON.stringify(migrations),
          b.reason,
          JSON.stringify(flow),
          connHash(env),
          env.production,
          stagesOf(flow).length,
          Requests.expiry(auth.resolved, dbNow),
          true,
          requests.workerId,
        ],
      );
      await auditIn(
        tx,
        c,
        {
          action: 'environment.emergency',
          actorKind: 'user',
          actorId: user.id,
          targetKind: 'exec_request',
          targetId: id,
          projectId: a.pid,
          data: {
            environmentId: env.id,
            name: env.name,
            production: env.production,
            kind: b.kind,
            direction: execDir,
            from: env.current_version_id,
            to: b.to,
            ...(plan.lca ? { lca: plan.lca } : {}),
            reason: b.reason,
            migrations: migrations.map((m) => m.number),
          },
        },
        ctx.security,
      );
      const row = await loadRequest(tx, a.pid, id);
      const s = (await requests.scopeOf(tx, row))!;
      // 通知这个环境审批流程里的所有审批人（每个环节现在有资格的人；默认流程是有执行权限的人）；结果也会通知（finish）
      await requests.notifyApprovers(tx, row, s, fx, user.id, {
        event: 'emergency',
        actor: user.name,
        reason: b.reason,
      });
      fx.requestsChanged = true;
      return {
        row,
        plan: { a: { pid: project.id, name: project.name, env, auth } },
      } as const;
    });
    await requests.flushEffects(fx);
    return runRequest(c, ctx, out.row, out.plan);
  });
};

// ───── 收件箱（E7） ─────

export const registerInbox = (app: Hono<Env>, ctx: AppContext) => {
  const { db, requests } = ctx;

  app.get('/api/me/inbox', async (c) => {
    const user = c.get('user');
    const rc = await loadRoleContext(db, user);
    const items = await requests.inbox(db, user, rc);
    return c.json<InboxList>({ items, unread: await requests.unread(db, user.id, rc) });
  });

  /** 等我处理的申请（当前环节我能批，或已全部通过、我有执行权限） */
  app.get('/api/me/inbox/pending', async (c) => {
    const user = c.get('user');
    return c.json(await requests.pendingFor(db, user, await loadRoleContext(db, user)));
  });

  /** 我提交的申请（最近 100 个，只含现在还能看到的项目） */
  app.get('/api/me/requests', async (c) => {
    const user = c.get('user');
    const rc = await loadRoleContext(db, user);
    const rows = await db.query<RequestRow>(
      'select * from exec_requests where requested_by = $1 and emergency = $2 order by created_at desc limit 100',
      [user.id, false],
    );
    const visible: RequestRow[] = [];
    for (const r of rows) {
      const s = await requests.scopeOf(db, r);
      if (s && effectiveRole(rc, s.project)) visible.push(r);
    }
    return c.json(await requests.summaries(db, visible));
  });

  app.post('/api/me/inbox/:id/read', async (c) => {
    const user = c.get('user');
    const r = await db.query<{ id: string }>(
      'update inbox_items set read_at = $3 where id = $1 and user_id = $2 and read_at is null returning id',
      [c.req.param('id'), user.id, new Date().toISOString()],
    );
    if (!r.length) {
      const [exists] = await db.query<{ id: string }>(
        'select id from inbox_items where id = $1 and user_id = $2',
        [c.req.param('id'), user.id],
      );
      if (!exists) throw new HTTPException(404, { message: '通知不存在' });
    }
    // 算一次未读数，同时推给这个用户的实时连接（第二轮审查：不再各算一遍）
    const unread = await requests.unread(db, user.id);
    await requests.publishUnread(user.id, unread);
    return c.json({ unread });
  });

  app.post('/api/me/inbox/read-all', async (c) => {
    const user = c.get('user');
    const rc = await loadRoleContext(db, user);
    // 只把现在看得到的通知标为已读
    await requests.readAll(db, user.id, rc);
    const unread = await requests.unread(db, user.id, rc);
    await requests.publishUnread(user.id, unread);
    return c.json({ unread });
  });

  /**
   * 实时更新（SSE）：连上先发一次未读数，之后未读数变化时推送 { unread }，有申请状态变化时推送 { requests: true }
   * （不带内容，界面据此重新拉自己能看到的列表）。每 25 秒一次心跳，同时确认账号仍然有效（停用后断开）。
   * once=1：只发第一条就结束（测试用）。
   */
  app.get('/api/me/inbox/stream', async (c) => {
    const user = c.get('user');
    const once = c.req.query('once') === '1';
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (s) => {
      const send = sseSender<InboxEvent>(s);
      if (once) {
        await send({ unread: await requests.unread(db, user.id) });
        return;
      }
      const queue: InboxEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = requests.isStopped() || s.aborted || s.closed;
      const close = () => {
        closed = true;
        wake?.();
      };
      s.onAbort(close);
      const off = requests.subscribe(
        user.id,
        (e) => {
          if (closed) return;
          queue.push(e);
          wake?.();
        },
        close,
      );
      try {
        if (closed) return;
        // 先订阅再查初始未读数：初始查询与首帧发送期间到达的事件先缓冲到 queue，随后立刻消费，消除丢通知窗口
        const initialUnread = await requests.unread(db, user.id);
        if (closed) return;
        await send({ unread: initialUnread });
        while (!closed) {
          while (queue.length && !closed) await send(queue.shift()!);
          if (closed) break;
          const ping = await new Promise<boolean>((r) => {
            const t = setTimeout(() => {
              wake = null;
              r(true);
            }, 25_000);
            t.unref?.();
            wake = () => {
              clearTimeout(t);
              wake = null;
              r(false);
            };
          });
          if (ping && !closed) {
            const [u] = await db.query<{ status: string; mustChangePassword: boolean | number }>(
              'select status, must_change_password as "mustChangePassword" from users where id = $1',
              [user.id],
            );
            if (closed || u?.status !== 'active' || Boolean(u.mustChangePassword)) break;
            await s.write(': ping\n\n').catch(() => {
              closed = true;
            });
          }
        }
      } finally {
        off();
      }
    });
  });
};
