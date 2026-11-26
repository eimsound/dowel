// 执行申请服务（Requests）：申请状态机与收尾、站内通知与 Webhook 入队、生命周期（启动 / 停机 / 排空）与跨副本总线。
// 规则说明见 ../requests.ts 文件头；巡检调度见 sweeper.ts，收件箱实时推送见 inbox-hub.ts。
//
// 事务边界：状态变化都在 withPolicyLock 的事务里，收件箱通知、审计与 Webhook 持久化入队（webhooks.enqueueIn(tx)）
// 同在这个事务里原子写库；提交之后才由 flushEffects 唤醒 Webhook 投递（wake(true)）、实时推送与跨副本广播。
import type {
  InboxEvent,
  InboxItem,
  InboxKind,
  PendingRequest,
  ExecRequestDetail,
  ExecRequestSummary,
  RequestActions,
  RequestStatus,
  RequestVersionRef,
  ResolvedPolicy,
  WebhookEventType,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Context } from 'hono';

import { auditIn } from '../audit.ts';
import type { EventBus } from '../bus.ts';
import { inList, type PlatformDb, readDbNow } from '../db.ts';
import { type EnvRow, iso } from '../envs.ts';
import type { ExecContext } from '../executions.ts';
import type { HaCoordinator } from '../ha.ts';
import { withPolicyLock } from '../policy.ts';
import { effectiveRole, type RoleContext } from '../roles.ts';
import { scrubSecrets } from '../secrets.ts';
import type { SecurityConfig } from '../security.ts';
import type { Webhooks } from '../webhooks.ts';
import { bindingProblem, newBindingCache } from './binding.ts';
import {
  eligibleFor,
  hasExecRight,
  loadAudience,
  loadRoleContexts,
  type StageScope,
  type UserContext,
} from './eligibility.ts';
import { flowOf, stagesOf } from './flow.ts';
import { InboxHub, type Listener } from './inbox-hub.ts';
import { listInbox, readAll, unread } from './inbox.ts';
import { Effects, INTERRUPTED, isInterrupted, type RequestRow, sweepWhere } from './model.ts';
import {
  type DirectRun,
  type DirectRunResult,
  directRunHookEvent,
  type NoticeInput,
  noticeData,
  type RequestHookExtra,
  requestHookEvent,
  type TokenRef,
  type TokenRunResult,
  tokenNoticeData,
  tokenRunHookEvent,
  versionRefs,
} from './notice.ts';
import { type RequestScope, scopeOf, stageScopeOf } from './scope.ts';
import {
  REQUEST_SWEEP_MS,
  SWEEP_KICK_RETRY_MS,
  SWEEP_LOCK_TIMEOUT_MS,
  type SweepScope,
  SweepScheduler,
  type SweepTarget,
} from './sweeper.ts';
import * as views from './views.ts';

export interface RequestsOptions {
  /** 跨副本事件总线（可选）：收件箱变更与 requests.kick 跨副本同步 */
  bus?: EventBus;
  /** 副本租约与分布式任务协调器（可选）：按副本租约恢复中断申请与巡检互斥 */
  ha?: HaCoordinator;
  /** 显式 sweep() 等待分布式巡检锁的超时时间（毫秒，默认 30000） */
  sweepLockTimeoutMs?: number;
  /** 事件驱动 kick 未获锁时的短延迟重试间隔（毫秒，默认 200） */
  kickRetryMs?: number;
}

export class Requests {
  readonly db: PlatformDb;
  readonly exec: ExecContext;
  readonly webhooks: Webhooks;
  readonly security: SecurityConfig;
  readonly bus: EventBus | null;
  readonly ha: HaCoordinator | null;
  /** 停机标记：巡检调度与收件箱推送共用（经 isStopped 读取） */
  private stopped = false;
  private busUnsubs: (() => void)[] = [];
  /** 收件箱实时推送（本副本 SSE 订阅） */
  private readonly hub: InboxHub;
  /** 巡检调度（定时 / kick / 显式 sweep） */
  private readonly sweeper: SweepScheduler;
  /** 正在执行收尾写库与通知（finish / afterDirectRun / afterTokenRun）的异步任务 */
  private readonly inFlight = new Set<Promise<unknown>>();
  /**
   * 本进程开始的时间：无 HA 租约或历史无 worker_id 的记录仍据此区分重启前遗留与本进程刚发起的执行。
   * 在 createApp 里构造，早于开始接受连接。
   */
  readonly bootAt = new Date();

  constructor(
    db: PlatformDb,
    exec: ExecContext,
    webhooks: Webhooks,
    security: SecurityConfig,
    options: RequestsOptions = {},
  ) {
    this.db = db;
    this.exec = exec;
    this.webhooks = webhooks;
    this.security = security;
    this.bus = options.bus ?? null;
    this.ha = options.ha ?? null;
    const isStopped = () => this.stopped;
    this.hub = new InboxHub(this.bus, isStopped, (userId) => this.unread(this.db, userId));
    this.sweeper = new SweepScheduler({
      ha: this.ha,
      lockTimeoutMs: options.sweepLockTimeoutMs ?? SWEEP_LOCK_TIMEOUT_MS,
      retryMs: options.kickRetryMs ?? SWEEP_KICK_RETRY_MS,
      isStopped,
      run: (t) => this.runSweep(t),
    });
    this.attachBus();
  }

  /** 当前副本 ID（写入 exec_requests.worker_id；无 HA 时为 null） */
  get workerId(): string | null {
    return this.ha?.replicaId ?? null;
  }

  /** 是否已调用 stop() 进入停机状态 */
  isStopped(): boolean {
    return this.stopped;
  }

  private attachBus(): void {
    if (!this.bus || this.busUnsubs.length) return;
    const replicaId = this.bus.replicaId;
    this.busUnsubs.push(
      this.bus.onEvent(async (event) => {
        if (this.stopped || event.origin === replicaId) return;
        if (event.t === 'inbox.changed') {
          if (!event.userIds.length) {
            this.hub.broadcastLocal({ requests: true });
            return;
          }
          for (const uid of event.userIds) {
            if (this.stopped) return;
            if (this.hub.has(uid)) await this.hub.publishUnreadLocal(uid);
          }
          return;
        }
        if (event.t === 'requests.kick') {
          this.sweeper.kickLocal({
            all: event.all,
            envIds: event.envIds,
            projectIds: event.projectIds,
            groupIds: event.groupIds,
          });
        }
      }),
      this.bus.onReconnect(async () => {
        if (this.stopped) return;
        // 断线期间可能错过了 requests.kick，重连后补跑一次全量巡检（非阻塞、撞锁自动短延迟重试）
        this.sweeper.kickLocal({ all: true });
        const activeUsers = this.hub.activeUsers();
        for (const uid of activeUsers) {
          if (this.stopped) return;
          await this.hub.publishUnreadLocal(uid);
        }
        if (!this.stopped && activeUsers.length) this.hub.broadcastLocal({ requests: true });
      }),
    );
  }

  private detachBus(): void {
    for (const off of this.busUnsubs) off();
    this.busUnsubs = [];
  }

  // ───── 定时清理 ─────

  /**
   * 启动定时清理（main.ts，在 ha.start() / bus.start() 之后、开始接受连接之前调用）。
   * 先恢复已离线节点遗留的“执行中”申请，再按间隔巡检过期、失效与中断的申请。
   */
  async start(intervalMs = REQUEST_SWEEP_MS) {
    this.stop();
    this.stopped = false;
    this.attachBus();
    await this.recoverInterrupted();
    if (this.stopped || !(intervalMs > 0)) return;
    this.sweeper.startTimer(intervalMs);
  }

  /** 判断一条 executing 申请是否已经因原执行副本离线/重启而中断 */
  private async isInterruptedRow(row: RequestRow, aliveCache: Map<string, boolean>): Promise<boolean> {
    const updatedMs = new Date(iso(row.updated_at)!).getTime();
    const olderThanBoot = updatedMs < this.bootAt.getTime();
    if (!this.ha) return olderThanBoot;
    const wid = row.worker_id ?? null;
    // 无 worker_id（升级前遗留或单测手工造数据）或属于本副本 ID：仅按早于本进程启动时间判断，避免误杀本进程正在执行的申请
    if (!wid || wid === this.ha.replicaId) return olderThanBoot;
    let alive = aliveCache.get(wid);
    if (alive === undefined) {
      alive = await this.ha.isNodeAlive(wid);
      aliveCache.set(wid, alive);
    }
    return !alive;
  }

  /**
   * 恢复卡死的“执行中”申请 → 执行失败（result.code = interrupted）。
   * - 有 HaCoordinator 时：按 worker_id 检查所属副本心跳租约是否仍存活，绝不误杀其他存活副本正在跑的迁移；
   * - 无 HaCoordinator 或历史无 worker_id 记录时：退回 updated_at < bootAt 判断。
   * 之后真正的执行结果如果还能送到，finish() 仍然接受这种状态，用真实结果覆盖。返回处理了几个。
   */
  async recoverInterrupted(): Promise<number> {
    const candidates = await this.db.query<RequestRow>(
      "select * from exec_requests where status = 'executing'",
    );
    if (!candidates.length) return 0;
    const preCache = new Map<string, boolean>();
    const staleIds: string[] = [];
    for (const r of candidates) {
      if (await this.isInterruptedRow(r, preCache)) staleIds.push(r.id);
    }
    if (!staleIds.length) return 0;

    const fx = await withPolicyLock(this.db, async (tx) => {
      const fx = Object.assign(new Effects(), { n: 0 });
      const rows = await tx.query<RequestRow>(
        `select * from exec_requests where status = 'executing' and id in (${inList(staleIds)})`,
        staleIds,
      );
      const lockCache = new Map<string, boolean>();
      for (const r of rows) {
        if (!(await this.isInterruptedRow(r, lockCache))) continue;
        const reason = '服务重启或执行节点离线时这个申请正在执行，结果未知：请到环境页查看执行历史';
        const ok = await this.setStatus(tx, null, r, 'failed', reason, null, fx, {
          result: { ok: false, code: INTERRUPTED, error: reason, current: null },
          onlyIf: 'executing',
        });
        if (ok) fx.n++;
      }
      return fx;
    });
    await this.flushEffects(fx);
    return fx.n;
  }

  stop() {
    this.stopped = true;
    this.sweeper.halt();
    this.detachBus();
    this.hub.closeAll();
  }

  /** 等待正在进行的巡检与执行收尾任务全部完成（优雅停机排空用） */
  async drain(): Promise<void> {
    while (this.sweeper.inProgress || this.inFlight.size > 0) {
      const tasks: Promise<unknown>[] = [...this.inFlight];
      const sweeping = this.sweeper.inProgress;
      if (sweeping) tasks.push(sweeping);
      await Promise.allSettled(tasks);
    }
  }

  private trackInFlight<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const drop = () => this.inFlight.delete(p);
    p.then(drop, drop);
    return p;
  }

  /**
   * 环境状态或执行策略可能变了（执行结束、漂移检查、读历史同步、改脚本、改策略、改连接、转组……）：
   * 由相应的路由**显式**调用，带上受影响的范围，尽快检查这个范围里还没结束的申请（合并成一轮；检查进行中又来的会再跑一轮），
   * 并广播给其他副本。正确性不依赖它：审批、执行时都在锁内重新检查绑定，另有定时检查。
   */
  kick(t: SweepTarget) {
    this.sweeper.kickLocal(t);
    if (this.bus) {
      void this.bus
        .publish({
          t: 'requests.kick',
          ...(t.all ? { all: true } : {}),
          ...(t.envIds?.length ? { envIds: t.envIds } : {}),
          ...(t.projectIds?.length ? { projectIds: t.projectIds } : {}),
          ...(t.groupIds?.length ? { groupIds: t.groupIds } : {}),
        })
        .catch((e) => {
          console.error('广播 requests.kick 失败', e instanceof Error ? scrubSecrets(e.message) : e);
        });
    }
  }

  /** 检查一个范围（默认全部）里还没结束的申请，失效 / 过期的转成终态并通知申请人；等到包含这次请求的那一轮跑完，返回处理了几个 */
  async sweep(t: SweepTarget = { all: true }): Promise<number> {
    return this.sweeper.sweep(t);
  }

  /**
   * 一轮检查：全量巡检时先按副本租约恢复卡死的 executing 申请，
   * 再在锁外只读地找出绑定已经不成立的申请（大多数时候一个都没有，不拿全局锁），
   * 最后在执行策略锁里逐个重新读、重新判断、条件更新。
   */
  private async runSweep(t: SweepScope): Promise<number> {
    let n = 0;
    if (t.all) n += await this.recoverInterrupted();
    const params: string[] = [];
    const conds: string[] = [];
    if (!t.all) {
      const add = (ids: Set<string>, sql: (list: string) => string) => {
        if (!ids.size) return;
        conds.push(sql(inList([...ids], params.length + 1)));
        params.push(...ids);
      };
      add(t.envs, (l) => `environment_id in (${l})`);
      add(t.projects, (l) => `project_id in (${l})`);
      add(t.groups, (l) => `project_id in (select id from projects where group_id in (${l}))`);
      if (!conds.length) return n;
    }
    const rows = await this.db.query<RequestRow>(
      `select * from exec_requests where ${sweepWhere(this.db.dialect)}${conds.length ? ` and (${conds.join(' or ')})` : ''}`,
      params,
    );
    const stale: string[] = [];
    const cache = newBindingCache();
    const now = await readDbNow(this.db, this.db.dialect);
    for (const r of rows) {
      if (isInterrupted(r)) continue;
      if (await bindingProblem(this.db, r, now, cache)) stale.push(r.id);
    }
    if (!stale.length) return n;
    return n + (await this.closeStale(stale));
  }

  /** 锁内重新读、重新判断、条件更新：只读判断之后状态可能又变了（被执行、被撤回……） */
  private async closeStale(ids: string[]): Promise<number> {
    const where = sweepWhere(this.db.dialect);
    const fx = await withPolicyLock(this.db, async (tx) => {
      const fx = Object.assign(new Effects(), { n: 0 });
      const cache = newBindingCache();
      const now = await readDbNow(tx, this.db.dialect);
      for (const id of ids) {
        const [r] = await tx.query<RequestRow>(`select * from exec_requests where id = $1 and ${where}`, [
          id,
        ]);
        if (!r || isInterrupted(r)) continue;
        const p = await bindingProblem(tx, r, now, cache);
        if (p && (await this.setStatus(tx, null, r, p.status, p.reason, null, fx, { onlyIf: r.status })))
          fx.n++;
      }
      return fx;
    });
    await this.flushEffects(fx);
    return fx.n;
  }

  /** 单个申请的绑定检查（详情页打开时）：失效 / 过期的当场转成终态并通知 */
  async recheck(rid: string) {
    // 先只读判断（不拿全局锁，第一轮审查）；发现不成立再在锁内重新读、条件更新
    const [r] = await this.db.query<RequestRow>(
      `select * from exec_requests where id = $1 and ${sweepWhere(this.db.dialect)}`,
      [rid],
    );
    if (
      r &&
      !isInterrupted(r) &&
      (await bindingProblem(this.db, r, await readDbNow(this.db, this.db.dialect)))
    )
      await this.closeStale([rid]);
  }

  // ───── 状态变化 ─────

  /**
   * 改申请状态（在锁内的事务里）：写状态和原因、审计、通知申请人、排上 Webhook。
   * actor：做这件事的人（系统清理为 null）。
   */
  async setStatus(
    tx: Db,
    c: Context | null,
    req: RequestRow,
    status: RequestStatus,
    reason: string | null,
    actor: { id: string; name: string } | null,
    fx: Effects,
    extra: { result?: RequestRow['result']; comment?: string; onlyIf?: RequestStatus } = {},
  ): Promise<boolean> {
    // 紧急执行的记录只有“执行结束”（finish）和启动恢复会改它的状态，两者都带着结果；已经结束的紧急记录不再被别的路径改动
    // （第二轮审查：否则定时检查会把失败的紧急记录转成失效，再发一次通知和 Webhook）
    if (req.emergency && req.status !== 'executing' && !extra.result) return false;
    // 执行中被中断（result.code = interrupted）的记录同样不能被巡检/重检改写为失效或过期，仅允许原节点 finish() 带真实结果覆盖（#18）
    if (isInterrupted(req) && !extra.result) return false;
    const now = new Date().toISOString();
    // onlyIf：条件更新（状态仍是读到时的那个才改），没改到就什么副作用都不做
    const updated = await tx.query<{ id: string }>(
      `update exec_requests set status = $2, status_reason = $3, updated_at = $4,
              result = coalesce($5::text::jsonb, result)
        where id = $1${extra.onlyIf ? ' and status = $6' : ''} returning id`,
      [
        req.id,
        status,
        reason,
        now,
        extra.result ? JSON.stringify(extra.result) : null,
        ...(extra.onlyIf ? [extra.onlyIf] : []),
      ],
    );
    if (!updated.length) return false;
    const action =
      status === 'invalid'
        ? 'exec_request.invalidate'
        : status === 'expired'
          ? 'exec_request.expire'
          : status === 'withdrawn'
            ? 'exec_request.withdraw'
            : status === 'rejected'
              ? 'exec_request.reject'
              : status === 'executed' || status === 'failed'
                ? 'exec_request.finish'
                : `exec_request.${status}`;
    await auditIn(
      tx,
      c,
      {
        action,
        actorKind: actor ? 'user' : 'system',
        actorId: actor?.id ?? null,
        targetKind: 'exec_request',
        targetId: req.id,
        projectId: req.project_id,
        data: {
          environmentId: req.environment_id,
          from: status === 'failed' || status === 'executed' ? undefined : req.status,
          status,
          reason,
          ...(extra.comment ? { comment: extra.comment } : {}),
          ...(extra.result ? { ok: extra.result.ok, code: extra.result.code } : {}),
          ...(req.emergency ? { emergency: true } : {}),
        },
      },
      this.security,
    );
    req.status = status;
    req.status_reason = reason;
    if (extra.result) req.result = extra.result;
    fx.requestsChanged = true;
    const ctx = await this.scopeOf(tx, req);
    if (!ctx) return true;
    // 紧急执行的结果（成功、失败、执行器判为状态已变）通知这个环境审批流程里的审批人，和开始时一样（第一轮审查补上）
    if (req.emergency && (status === 'executed' || status === 'failed' || status === 'invalid'))
      await this.notifyApprovers(tx, req, ctx, fx, actor?.id ?? null, {
        event: `emergency_${status}`,
        status,
        actor: actor?.name ?? null,
        reason: status === 'executed' ? req.reason : reason,
      });
    // 申请人收到结果（撤回是他自己做的，不用通知）
    const event =
      status === 'executed' || status === 'failed'
        ? status
        : status === 'rejected' || status === 'invalid' || status === 'expired'
          ? status
          : null;
    // 执行结果总是通知申请人（他自己执行的也记一条，收件箱里能看到“我的申请结果”）；其他结果是别人做的才通知
    const finished = status === 'executed' || status === 'failed';
    if (req.requested_by && event && !req.emergency && (finished || req.requested_by !== actor?.id))
      await this.notify(tx, [req.requested_by], 'request_result', req, ctx, fx, {
        event,
        status,
        actor: actor?.name ?? null,
        reason,
      });
    const hook: WebhookEventType | null = req.emergency
      ? status === 'executed' || status === 'failed' || status === 'invalid'
        ? 'emergency.executed'
        : null
      : status === 'rejected'
        ? 'request.rejected'
        : status === 'withdrawn'
          ? 'request.withdrawn'
          : status === 'invalid' || status === 'expired'
            ? 'request.invalidated'
            : status === 'executed' || status === 'failed'
              ? 'request.executed'
              : null;
    if (hook)
      await this.queueHook(tx, fx, hook, req, ctx, {
        actor: actor?.name ?? null,
        reason: req.emergency && status === 'executed' ? req.reason : reason,
        status,
        ...(req.emergency ? { ok: status === 'executed' } : {}),
      });
    return true;
  }

  /**
   * 通知这个申请的审批流程（快照）里每个环节现在有资格的人（紧急执行的开始和结果）。只读项目的受众，不读全实例的用户。
   */
  async notifyApprovers(
    tx: Db,
    req: RequestRow,
    s: RequestScope,
    fx: Effects,
    except: string | null,
    n: Parameters<Requests['notify']>[6],
  ) {
    const audience = await loadAudience(tx, s.project);
    const scope = this.stageScope(s, req);
    const ids = [...audience.values()]
      .filter((u) => u.userId !== except && stagesOf(req.flow).some((spec) => eligibleFor(u, spec, scope)))
      .map((u) => u.userId);
    await this.notify(tx, ids, 'emergency_execution', req, s, fx, n, audience);
  }

  /** 申请所在的项目、环境和当前生效策略（环境 / 项目已删除时 null） */
  async scopeOf(
    db: Db,
    req: Pick<RequestRow, 'project_id' | 'environment_id'>,
  ): Promise<RequestScope | null> {
    return scopeOf(db, req);
  }

  stageScope(s: RequestScope, req: Pick<RequestRow, 'direction' | 'migrations'>): StageScope {
    return stageScopeOf(s, req);
  }

  /** 现在有资格批第 stage 个环节的用户（能看到项目、在审批人范围内、不是申请人） */
  async eligibleUsers(
    tx: Db,
    req: RequestRow,
    s: RequestScope,
    stage: number,
    all?: Map<string, UserContext>,
  ): Promise<UserContext[]> {
    const spec = stagesOf(req.flow)[stage];
    if (!spec) return [];
    const users = all ?? (await loadAudience(tx, s.project));
    const scope = this.stageScope(s, req);
    return [...users.values()].filter((u) => u.userId !== req.requested_by && eligibleFor(u, spec, scope));
  }

  /** 有执行权限、能看到项目的用户 */
  async executors(tx: Db, req: RequestRow, s: RequestScope, all?: Map<string, UserContext>) {
    const users = all ?? (await loadAudience(tx, s.project));
    const scope = this.stageScope(s, req);
    return [...users.values()].filter((u) => hasExecRight(u, scope));
  }

  /** 写收件箱（同一个事务）：只发给现在还能看到这个项目的人 */
  async notify(
    tx: Db,
    userIds: Iterable<string>,
    kind: InboxKind,
    req: RequestRow,
    s: RequestScope,
    fx: Effects,
    n: NoticeInput,
    /** 调用方已经读过的角色上下文（受众）：复用，不再查；没给就只读这几个用户的 */
    known?: Map<string, UserContext>,
  ) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const missing = ids.filter((id) => !known?.has(id));
    const all = missing.length
      ? new Map([...(known ?? []), ...(await loadRoleContexts(tx, missing))])
      : known!;
    const refs = await versionRefs(tx, req);
    const data = noticeData(req, s, refs, n);
    for (const id of ids) {
      const rc = all.get(id);
      if (!rc || !effectiveRole(rc, s.project)) continue;
      await tx.query(
        `insert into inbox_items (id, user_id, kind, project_id, environment_id, request_id, data, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)`,
        [
          newId(),
          id,
          kind,
          req.project_id,
          req.environment_id,
          req.id,
          JSON.stringify(data),
          new Date().toISOString(),
        ],
      );
      fx.users.add(id);
    }
  }

  /** 详情页的绝对链接（设置了 DOWEL_PUBLIC_URL 时） */
  requestUrl(s: RequestScope, rid: string): string | null {
    if (!this.security.publicUrl) return null;
    const base = this.security.publicUrl.replace(/\/+$/, '');
    return `${base}/project/${s.project.groupSlug}/${s.project.slug}/requests/${rid}`;
  }

  /** 在当前事务内持久化入队一个 Webhook 事件（提交后再由 flushEffects 唤醒投递）。消息里只有项目、环境、版本号、人名、状态和原因，没有连接信息 */
  async queueHook(
    tx: Db,
    fx: Effects,
    type: WebhookEventType,
    req: RequestRow,
    s: RequestScope,
    extra: RequestHookExtra = {},
  ): Promise<number> {
    const refs = await versionRefs(tx, req);
    const inserted = await this.webhooks.enqueueIn(
      tx,
      s.project.groupId,
      requestHookEvent(type, req, s, refs, this.requestUrl(s, req.id), extra),
    );
    fx.enqueuedHooksCount += inserted;
    return inserted;
  }

  /** 事务提交之后：唤醒已入队的 Webhook 投递、实时推送未读数、广播“申请有变化”与跨副本通知 */
  async flushEffects(fx: Effects) {
    if (fx.enqueuedHooksCount > 0) this.webhooks.wake(true);
    const userIds = [...fx.users];
    for (const u of userIds) await this.hub.publishUnreadLocal(u);
    if (userIds.length) await this.hub.publishInboxChanged(userIds);
    if (fx.requestsChanged) {
      this.hub.broadcastLocal({ requests: true });
      await this.hub.publishInboxChanged([]);
    }
  }

  // ───── 执行结束 ─────

  /**
   * 申请的执行结束：转成已执行 / 执行失败（执行器报 request_stale 时转成失效），通知申请人（紧急执行通知审批人），发 Webhook。
   * 在锁里条件更新：只接受仍是 executing 的申请，以及被恢复逻辑记为“中断”的申请（result.code = interrupted，
   * 例如执行节点租约抖动短暂失联后真实结果才送达时，用真实结果覆盖）。
   */
  finish(
    c: Context | null,
    rid: string,
    user: { id: string; name: string },
    r: { ok: boolean; current: RequestVersionRef | null; error: { error: string; code?: string } | null },
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        const fx = new Effects();
        let envId: string | null = null;
        await withPolicyLock(this.db, async (tx) => {
          const [req] = await tx.query<RequestRow>('select * from exec_requests where id = $1', [rid]);
          if (!req) return;
          const interrupted = isInterrupted(req);
          if (req.status !== 'executing' && !interrupted) return;
          envId = req.environment_id;
          await tx.query('update exec_requests set executed_at = $2 where id = $1', [
            rid,
            new Date().toISOString(),
          ]);
          const result = {
            ok: r.ok,
            code: r.error?.code ?? null,
            error: r.error?.error ?? null,
            current: r.current,
          };
          const status: RequestStatus = r.ok
            ? 'executed'
            : r.error?.code === 'request_stale'
              ? 'invalid'
              : 'failed';
          await this.setStatus(tx, c, req, status, r.ok ? null : (r.error?.error ?? null), user, fx, {
            result,
            onlyIf: req.status,
          });
        });
        await this.flushEffects(fx);
        // 环境状态变了：同一个环境上别的申请要重新检查
        if (envId) this.kick({ envIds: [envId] });
      })(),
    );
  }

  // ───── 直接执行之后 ─────

  /**
   * 不经申请的直接执行 / 回滚 / 写基线结束之后：发 execution.finished 的 Webhook（执行和回滚），
   * 并让这个环境上还没结束的申请马上重新检查（环境状态变了的会失效）。
   */
  afterDirectRun(
    user: { id: string; name: string },
    a: { pid: string; env: EnvRow },
    run: DirectRun,
    r: DirectRunResult,
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        // 环境状态变了：这个环境上还没结束的申请要重新检查
        this.kick({ envIds: [a.env.id] });
        if (run.mode !== 'migrate') return;
        const s = await this.scopeOf(this.db, { project_id: a.pid, environment_id: a.env.id });
        if (!s) return;
        const toRef = run.to
          ? (
              await this.db.query<RequestVersionRef>('select id, number, name from versions where id = $1', [
                run.to,
              ])
            )[0]
          : undefined;
        const hookEvent = directRunHookEvent(user, s, run, r, toRef);
        try {
          const inserted = await this.webhooks.enqueueIn(this.db, s.project.groupId, hookEvent);
          if (inserted > 0) this.webhooks.wake(true);
        } catch (e) {
          console.error('直接执行 Webhook 入队失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      })(),
    );
  }

  // ───── CI 令牌执行之后（P6） ─────

  /**
   * CI 令牌的执行结束之后（成功或失败；预演不算）：
   * - 这个环境上还没结束的执行申请马上重新检查（环境状态变了的会失效，P5b 的规则）；
   * - 组级 Webhook 发 token.executed（所有环境）；
   * - **生产环境**给收件箱发 token_execution：项目管理员（含组管理员、实例管理员，和审批人范围里的“项目管理员”同一个定义）
   *   和环境当前审批流程里每个环节现在有资格的审批人（没配环节时是有执行权限的人）。非生产不发站内通知（太频繁），只有 Webhook。
   * 自己的错误只记日志，不影响已经返回给 CI 的结果。
   */
  afterTokenRun(
    token: TokenRef,
    a: { pid: string; env: EnvRow },
    target: RequestVersionRef,
    r: TokenRunResult,
  ): Promise<void> {
    return this.trackInFlight(
      (async () => {
        this.kick({ envIds: [a.env.id] });
        const s = await this.scopeOf(this.db, { project_id: a.pid, environment_id: a.env.id });
        if (!s) return;
        const hookEvent = tokenRunHookEvent(token, s, target, r);
        // 生产环境无变更的幂等空跑（noop）或非生产环境：不向收件箱刷屏，同步持久化 Webhook 后立即唤醒
        if (!s.env.production || (r.ok && r.noop)) {
          try {
            const inserted = await this.webhooks.enqueueIn(this.db, s.project.groupId, hookEvent);
            if (inserted > 0) this.webhooks.wake(true);
          } catch (e) {
            console.error('令牌执行 Webhook 入队失败', e instanceof Error ? scrubSecrets(e.message) : e);
          }
          return;
        }
        const fx = new Effects();
        try {
          await this.db.transaction(async (tx) => {
            fx.enqueuedHooksCount += await this.webhooks.enqueueIn(tx, s.project.groupId, hookEvent);
            const audience = await loadAudience(tx, s.project);
            const scope: StageScope = {
              project: s.project,
              env: { id: s.env.id, production: s.env.production },
              resolved: s.resolved,
              direction: 'up',
            };
            const stages = stagesOf(flowOf(s.resolved));
            const data = tokenNoticeData(token, s, target, r);
            for (const u of audience.values()) {
              const role = effectiveRole(u, s.project);
              if (!role) continue;
              if (role !== 'admin' && !stages.some((spec) => eligibleFor(u, spec, scope))) continue;
              await tx.query(
                `insert into inbox_items (id, user_id, kind, project_id, environment_id, request_id, data, created_at)
                 values ($1, $2, 'token_execution', $3, $4, null, $5::text::jsonb, $6)`,
                [newId(), u.userId, s.project.id, s.env.id, JSON.stringify(data), new Date().toISOString()],
              );
              fx.users.add(u.userId);
            }
          });
          await this.flushEffects(fx);
        } catch (e) {
          console.error('令牌执行通知写库失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      })(),
    );
  }

  // ───── 实时推送（收件箱） ─────

  subscribe(userId: string, fn: Listener, onClose?: () => void): () => void {
    return this.hub.subscribe(userId, fn, onClose);
  }

  /**
   * 未读数：和收件箱列表同一条可见性规则（第一轮审查：直接数全部未读会泄露“看不到的项目里有动静”）。
   * 过滤在 SQL 里做（第二轮审查）：先算出这个用户现在看得到的项目，再 count。rc 不给就按这个用户现在的角色读一次；
   * 账号不存在 / 停用时是 0。
   */
  async unread(db: Db, userId: string, rc?: RoleContext): Promise<number> {
    return unread(db, userId, rc);
  }

  /** 全部标为已读：只作用于现在看得到的通知（看不到的项目的通知保持原样，重新看得到时仍是未读） */
  async readAll(db: Db, userId: string, rc: RoleContext): Promise<void> {
    return readAll(db, userId, rc);
  }

  /** 推送未读数给这个用户的实时连接（本副本立即推送 + 跨副本广播）；调用方已经算好的值直接用，不再查 */
  async publishUnread(userId: string, known?: number) {
    await this.hub.publishUnreadLocal(userId, known);
    await this.hub.publishInboxChanged([userId]);
  }

  /** 广播一个不带内容的“申请有变化”（界面据此重新拉自己能看到的列表；不泄露是哪个项目） */
  broadcast(e: InboxEvent) {
    this.hub.broadcastLocal(e);
  }

  // ───── 视图 ─────

  async summaries(db: Db, rows: RequestRow[]): Promise<ExecRequestSummary[]> {
    return views.summaries(db, rows);
  }

  /** 当前用户在这个申请上能做的事 */
  actionsFor(
    req: RequestRow,
    rc: RoleContext,
    scope: StageScope | null,
    approvals: { stage: number; user_id: string | null }[],
  ): RequestActions {
    return views.actionsFor(req, rc, scope, approvals);
  }

  async detail(
    db: Db,
    req: RequestRow,
    user: { id: string; role: string },
    rc: RoleContext,
  ): Promise<ExecRequestDetail> {
    return views.detail(this, db, req, user, rc);
  }

  // ───── 收件箱 ─────

  /** 收件箱列表（新的在前）：可见性过滤和条数限制都在 SQL 里（第二轮审查） */
  async inbox(
    db: Db,
    user: { id: string; role: string },
    rc: RoleContext,
    limit = 100,
  ): Promise<InboxItem[]> {
    return listInbox(db, user, rc, limit);
  }

  /** 等我处理的申请：当前环节我能批，或者已经全部通过、我有执行权限 */
  async pendingFor(db: Db, user: { id: string; role: string }, rc: RoleContext): Promise<PendingRequest[]> {
    return views.pendingFor(this, db, user, rc);
  }

  /** 申请的有效期（小时 → 到期时间） */
  static expiry(resolved: ResolvedPolicy, from = new Date()): string {
    return new Date(from.getTime() + resolved.requestTtlHours.value * 3600_000).toISOString();
  }
}
