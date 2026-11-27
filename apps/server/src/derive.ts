// 派生数据（04-ir-design.md 2.6）：表达式和不透明对象（视图、触发器等）的引擎规范形式。
// 用户写的表达式会换成引擎的规范形式（如 (note <> '') → (note <> ''::text)），这样与线上库读出的结构可以直接比较；
// 编辑操作不改写不透明对象的 SQL 文本，改名后由服务器在影子库里重放一遍，读回 PG 自动更新后的 DDL。
//
// 按需规范化（ADR 0016）：编辑期间不在后台调影子库。只有两种入口会回影子库：
// - 关键出口（发布、迁移 / DDL / 验证、版本差异预览、历史详情、拉取 / 接入预览、MCP 读模型）调 flush()：
//   相对基线没有待规范化的对象时 0 影子库 I/O 直接返回；
// - 用户在模型页点“规范化”（POST /api/projects/:pid/normalize）调 normalize()：显式在影子库里校验并写回。
//
// 基线（branches.baseline）是一份“确定已在影子库里规范化过”的模型（黄金基线）：只在导入 / 拉取 / 接入 / 已验证版本覆盖
// （runWithReset）或一次成功的 canonicalize 之后推进；没有待规范化对象时、canonicalize 失败时都**不**改写它。
import { deepEqual, type Model, type Obj } from '@dowel/core';
import type { Versions } from '@dowel/sync';

import { emptyBaseline, fullName, needsRefresh, pendingRefreshIds } from './derive-pending.ts';
import type { HaCoordinator } from './ha.ts';
import type { Rooms } from './rooms.ts';
import { type Shadow, ShadowError } from './shadow.ts';

export {
  exprsOf,
  fullName,
  hasRenamedOpaqueDeps,
  needsRefresh,
  pendingRefreshIds,
} from './derive-pending.ts';

const MAX_CATCHUP_ROUNDS = 5;
const MAX_REJECT_RETRIES = 3;
const DEFAULT_FLUSH_LOCK_TIMEOUT_MS = 30_000;
/** status() 最多列出的待规范化对象数 */
export const STATUS_OBJECT_LIMIT = 50;

/** 等待分支 derive 锁（PG 多副本 job:derive:<branchId>）超时：HTTP 映射为 503 normalize_busy */
export class DeriveBusyError extends Error {
  constructor(branchId: string) {
    super(`分支 ${branchId} 正在规范化，请稍后重试`);
  }
}

/** 服务正在停机，拒绝新的显式规范化：HTTP 映射为 503 shutting_down */
export class RefresherStoppedError extends Error {
  constructor() {
    super('服务正在关闭，请稍后重试');
  }
}

/** 规范化写回时工作副本被别人改过（版本检查拒绝或房间被替换）：HTTP 映射为 409 working_changed */
export class NormalizeConflictError extends Error {
  readonly currentSeq: number;
  constructor(currentSeq: number) {
    super('规范化期间工作副本被修改了，请重试');
    this.currentSeq = currentSeq;
  }
}

/**
 * 显式规范化期间分支被 forget（项目已被删除）：不论写回 / 保存基线做到哪一步都不报成功。
 * HTTP 映射为 404（与项目不存在一致）。
 */
export class BranchForgottenError extends Error {
  constructor(branchId: string) {
    super(`分支 ${branchId} 已被删除`);
  }
}

/**
 * flush 没做成规范化的原因：
 * - stopped / forgotten：服务正在停机，或分支已被 forget（项目 / 分支被删）；
 * - no_shadow：没有可用的影子库（shadowOf 返回 null）；
 * - shadow_unavailable：影子库连不上、超时、被占用，或句柄因配置变更被关闭（ShadowError，含 ShadowConfigChangedError：flush 安静跳过即可）；
 * - canonicalize_failed：表达式 / 不透明对象 DDL 在影子库 `canonicalize` 里报错（留给显式规范化或闭环验证报告给用户）；
 * - store_failed：平台库读写失败（`rooms.patch` / `rooms.state` / 保存 `branches.baseline` 抛错）；若写回已被接受但保存基线失败，返回的 `model` / `seq` 仍是写回后的房间状态，基线不推进；
 * - write_conflict：写回连续被版本检查拒绝超过 MAX_REJECT_RETRIES 次（期间一直有人改同一对象）；
 * - round_limit：单次持锁跑满 MAX_CATCHUP_ROUNDS 轮仍有待规范化对象（持续编辑造成活锁），不论期间是否写回过。
 */
export type FlushSkipReason =
  | 'stopped'
  | 'forgotten'
  | 'no_shadow'
  | 'shadow_unavailable'
  | 'canonicalize_failed'
  | 'store_failed'
  | 'write_conflict'
  | 'round_limit';

/**
 * flush 的结果。`model` / `seq` 是 flush 最后一次读到（或写回后读到）的房间状态，也就是本次判定所针对的那一份：
 * 调用方直接用它，不要在 flush 之后再读一次房间——中间可能插进别人的编辑，读到的就不是判定过的模型了。
 * - clean：model 相对基线没有待规范化的对象，且本次 flush 没有任何写回被接受（通常 0 影子库 I/O；
 *   写回被拒之后别人的编辑恰好消除了待规范化对象时也是 clean）；
 * - normalized：本次 flush 至少有一次写回被接受，且 model 相对推进后的基线没有待规范化的对象；
 * - skipped：model 可能仍有待规范化的对象（原因见 skippedReason），基线只反映已被接受的写回。
 * 多个排队中合并的调用各自拿到一份独立的 model 副本。
 */
export interface FlushOutcome {
  kind: 'clean' | 'normalized' | 'skipped';
  seq: number;
  model: Model;
  /** 仅 kind === 'skipped' 时有 */
  skippedReason?: FlushSkipReason;
}

export interface DerivedObjectRef {
  id: string;
  kind: Obj['kind'];
  name: string;
}

export interface RefreshStatus {
  seq: number;
  pendingCount: number;
  objects: DerivedObjectRef[];
  truncated: boolean;
  /** 是否已经有黄金基线 */
  baseline: boolean;
}

export interface NormalizeOutcome {
  ok: true;
  /** clean：基线就是当前模型，未连影子库；verified：影子库里校验过，没有需要改写的；normalized：改写了 */
  outcome: 'clean' | 'verified' | 'normalized';
  seq: number;
  normalizedCount: number;
  normalizedObjects: DerivedObjectRef[];
  checkedInShadow: boolean;
  /** 所用影子库的显示名；clean 且没有解析影子库时为 null */
  shadow: string | null;
}

export interface ShadowHandle {
  shadow: Shadow;
  label: string;
}

const refOf = (m: Model, id: string): DerivedObjectRef => {
  const o = m.objects[id]!;
  return { id, kind: o.kind, name: fullName(m, id) ?? o.name };
};

export class OpaqueRefresher {
  private rooms: Rooms;
  private shadowOf: (branchId: string) => Promise<Shadow | null>;
  /** 基线的持久化（重启后仍知道哪份模型已规范化） */
  private store: {
    load(branchId: string): Promise<Model | null>;
    save(branchId: string, m: Model): Promise<void>;
  };
  private ha: HaCoordinator | null;
  private good = new Map<string, Model>();
  private running = new Map<string, Promise<void>>();
  /** 已排队但尚未开始的 flush：同分支的并发调用合并成一次（开始时才读最新状态，结果对所有等待者都是新鲜的） */
  private queuedFlush = new Map<string, Promise<FlushOutcome>>();
  /** 在途任务尚未结束时被 forget 的分支，防止任务结束时回写内存/库基线 */
  private forgotten = new Set<string>();
  private stopped = false;
  /** flush / normalize / runWithReset 等待分布式锁的超时时间（毫秒） */
  flushLockTimeoutMs = DEFAULT_FLUSH_LOCK_TIMEOUT_MS;

  constructor(
    rooms: Rooms,
    shadowOf: (branchId: string) => Promise<Shadow | null>,
    store: OpaqueRefresher['store'],
    ha?: HaCoordinator,
  ) {
    this.rooms = rooms;
    this.shadowOf = shadowOf;
    this.store = store;
    this.ha = ha ?? null;
  }

  private async setGood(branchId: string, m: Model) {
    if (this.forgotten.has(branchId)) return;
    await this.store.save(branchId, m);
    if (this.forgotten.has(branchId)) return;
    this.good.set(branchId, m);
  }

  private async loadGood(branchId: string): Promise<Model | null> {
    if (this.ha?.isDistributed) {
      // PG 多副本模式：始终以平台库 branches.baseline 为准，避免读取过期的本地缓存
      const fromDb = await this.store.load(branchId);
      if (!this.forgotten.has(branchId)) {
        if (fromDb) this.good.set(branchId, fromDb);
        else this.good.delete(branchId);
      }
      return fromDb;
    }
    const cached = this.good.get(branchId);
    if (cached) return cached;
    const fromDb = await this.store.load(branchId);
    if (fromDb && !this.forgotten.has(branchId)) this.good.set(branchId, fromDb);
    return fromDb;
  }

  /**
   * 进程内按分支串行排队，确保 flush、normalize 与 reset/replace 不交错，
   * 且 drain() 可统一等待所有在途操作结束。
   */
  private enqueue<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.running.get(branchId) ?? Promise.resolve();
    const res = prev.then(fn);
    const settled = res.then(
      () => {},
      () => {},
    );
    const tracked = settled.finally(() => {
      if (this.running.get(branchId) === tracked) {
        this.running.delete(branchId);
        this.forgotten.delete(branchId);
      }
    });
    this.running.set(branchId, tracked);
    return res;
  }

  private async withExclusiveLock<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    if (!this.ha) return fn();
    const lock = await this.ha.withJobLock(`derive:${branchId}`, fn, {
      timeoutMs: this.flushLockTimeoutMs,
    });
    if (!lock.acquired) throw new DeriveBusyError(branchId);
    return lock.value;
  }

  /** 导入、拉取之后：新模型就是引擎刚读出来的，直接作为基线（受 derive 锁保护） */
  async reset(branchId: string, model: Model) {
    this.forgotten.delete(branchId);
    const baseline = structuredClone(model);
    await this.enqueue(branchId, () =>
      this.withExclusiveLock(branchId, async () => {
        await this.setGood(branchId, baseline);
      }),
    );
  }

  /**
   * 在 derive 分布式锁与本地串行队列保护下执行整体模型替换并按需重置黄金基线
   * （默认 `onlyIfClean: false` 用于 canonical 替换：导入、拉取、接入领先版本；`onlyIfClean: true` 用于已验证版本覆盖）：
   * - 阻塞等待任何在途 canonicalize 结束后再 replace，防止旧任务写回覆盖新黄金基线；
   * - 以调用方传入的 model（而非事后重读 rooms.model）写入黄金基线，防止 replace 与 reset 间的并发提交污染黄金基线；
   * - fn 抛错时黄金基线不变；
   * - 接入领先版本直接用链头版本模型作黄金基线依赖严格的读回核对（#123，ADR 0016 / ADR 0017）：当前执行读回校验
   *   （`verifyAndRecord`）已对四种方言严格校验（MySQL 表达式纯格式容忍已于 #162 移除），恢复时闭环验证也做同一个读回核对
   *   （ADR 0017 决定 2 / 4）；
   * - `onlyIfClean`（已验证版本的应用 / 作废 / 取消作废）：验证记录按数据库完整版本号区分（ADR 0017 决定 5）、SQL Server 生成列
   *   `type` 规划器不比较，“已验证”不保证是当前影子库的规范形式。
   *   因此只有 model 相对当前黄金基线没有待规范化对象时才推进黄金基线（同时作为防御性确认），否则只替换房间；
   * - 锁序严格单向：本地队列 → job:derive:<branchId> → rooms.withRoomLock → branches FOR UPDATE。
   */
  async runWithReset<T>(
    branchId: string,
    model: Model,
    fn: () => Promise<T>,
    opts: { onlyIfClean?: boolean } = {},
  ): Promise<T> {
    this.forgotten.delete(branchId);
    const baseline = structuredClone(model);
    return this.enqueue(branchId, () =>
      this.withExclusiveLock(branchId, async () => {
        const reset = !opts.onlyIfClean || !needsRefresh(await this.loadGood(branchId), baseline);
        const result = await fn();
        if (!reset) return result;
        await this.setGood(branchId, baseline);
        return result;
      }),
    );
  }

  /**
   * 非 canonical 的整体替换（恢复画布历史、未验证版本）：同样排在本地队列和 derive 锁里（在途规范化先排空，
   * 不会用旧 canonical 覆盖替换后的房间），但**不**改写黄金基线——被替换进来的模型不一定规范化过。
   */
  async runWithoutReset<T>(branchId: string, fn: () => Promise<T>): Promise<T> {
    return this.enqueue(branchId, () => this.withExclusiveLock(branchId, fn));
  }

  /** 停止接收新的显式规范化（优雅停机用；flush 之后只返回 skipped） */
  stop() {
    this.stopped = true;
  }

  /** 停止并等待所有已启动的刷新任务完成（优雅停机排空用） */
  async drain(): Promise<void> {
    this.stop();
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /**
   * 分支被删掉时清理内存状态：丢掉已经规范化的基线。
   * 正在执行的刷新不在这里取消（Promise 取消不了）；它写回时会被房间的版本检查拒绝或忽略，
   * 并通过 forgotten 标记阻止其回写内存/库基线（任务结束也不会复活）。
   */
  forget(branchId: string) {
    this.good.delete(branchId);
    if (this.running.has(branchId)) this.forgotten.add(branchId);
  }

  /** 测试和排查用：这个分支还有没有内存基线 / 在途任务 */
  tracked(branchId: string): boolean {
    return this.good.has(branchId) || this.running.has(branchId);
  }

  /**
   * 关键出口之前调用（发布、生成迁移、导出 DDL、验证、版本差异预览、历史详情、拉取 / 接入预览、MCP 读模型）：
   * 单机与 HA 统一走本地队列 + derive 锁；锁内相对黄金基线判断有没有待规范化的对象，没有就 0 影子库 I/O 返回 clean；
   * 有就在影子库里规范化并写回。影子库不可用（ShadowError）或规范化失败时安静返回 skipped（带原因），不改基线、不报错，
   * 保证没有影子库的项目照样能看迁移、导出 DDL；发布在 skipped 且仍有待规范化对象时拒绝（ADR 0017 决定 1，见 pendingIn）。
   * 只有等锁超时（DeriveBusyError）会抛出。
   * 返回的 model / seq 就是判定所针对的房间状态（见 FlushOutcome），调用方不要再另读房间。
   * 写回冲突的重试预算（MAX_REJECT_RETRIES 次连续被拒）只属于这一次 flush，不跨调用累计。
   */
  flush(branchId: string): Promise<FlushOutcome> {
    let shared = this.queuedFlush.get(branchId);
    if (!shared) {
      const p: Promise<FlushOutcome> = this.enqueue(branchId, () => {
        if (this.queuedFlush.get(branchId) === p) this.queuedFlush.delete(branchId);
        return this.withExclusiveLock(branchId, () => this.runLocked(branchId));
      });
      this.queuedFlush.set(branchId, p);
      shared = p;
    }
    // 合并的调用共用一次结果，但各自拿一份模型副本（调用方可以放心修改）
    return shared.then((o) => ({ ...o, model: structuredClone(o.model) }));
  }

  private async runLocked(branchId: string): Promise<FlushOutcome> {
    const skipped = (reason: FlushSkipReason, at: { model: Model; seq: number }): FlushOutcome => ({
      kind: 'skipped',
      seq: at.seq,
      model: at.model,
      skippedReason: reason,
    });
    /** 本次 flush 是否有写回被接受（只有这样才可能报 normalized） */
    let wrote = false;
    /** 连续被拒的次数（写回被接受后清零） */
    let rejects = 0;
    let last!: { model: Model; seq: number };
    for (let round = 0; round < MAX_CATCHUP_ROUNDS; round++) {
      const { model: cur, versions, seq } = await this.rooms.state(branchId);
      last = { model: cur, seq };
      if (this.stopped) return skipped('stopped', last);
      if (this.forgotten.has(branchId)) return skipped('forgotten', last);
      const good = await this.loadGood(branchId);
      if (this.forgotten.has(branchId)) return skipped('forgotten', last);
      const base = good ?? emptyBaseline(cur);
      if (!needsRefresh(base, cur)) return { kind: wrote ? 'normalized' : 'clean', seq, model: cur };
      const shadow = await this.shadowOf(branchId);
      if (this.forgotten.has(branchId)) return skipped('forgotten', last);
      if (!shadow) return skipped('no_shadow', last);
      const outcome = await this.apply(branchId, shadow, base, cur, versions, seq);
      last = { model: outcome.model, seq: outcome.seq };
      switch (outcome.kind) {
        case 'skipped':
          return skipped(outcome.reason, last);
        case 'done':
          return { kind: 'normalized', seq: outcome.seq, model: outcome.model };
        case 'rejected':
          if (++rejects > MAX_REJECT_RETRIES) return skipped('write_conflict', last);
          break;
        case 'accepted':
          wrote = true;
          rejects = 0;
          break;
      }
    }
    // 单次持锁达到循环上限（持续编辑造成活锁）：仍有待规范化对象，如实报 skipped，下次出口再追
    return skipped('round_limit', last);
  }

  /**
   * 一轮规范化：
   * - done：写回被接受，房间相对推进后的基线没有待规范化对象（model 就是判定过的那一份）；
   * - accepted：写回被接受、基线已推进，但期间有别人的编辑还需要再追一轮；
   * - rejected：写回被版本检查拒绝或期间房间被替换，基线不动；
   * - skipped：规范化期间被 forget、影子库不可用 / 报错，或平台库写回 / 读房间 / 保存基线失败。
   */
  private async apply(
    branchId: string,
    shadow: Shadow,
    good: Model,
    cur: Model,
    versions: Versions,
    curSeq: number,
  ): Promise<
    | { kind: 'done' | 'accepted' | 'rejected'; seq: number; model: Model }
    | { kind: 'skipped'; reason: FlushSkipReason; seq: number; model: Model }
  > {
    let patched: Obj[];
    try {
      patched = await shadow.canonicalize(good, cur);
    } catch (e) {
      if (this.forgotten.has(branchId)) {
        return { kind: 'skipped', reason: 'forgotten', seq: curSeq, model: cur };
      }
      // 影子库不可用是预期情况（没有环境、连不上……）：安静跳过；表达式在影子库里报错留给显式规范化报告给用户
      if (e instanceof ShadowError) {
        return { kind: 'skipped', reason: 'shadow_unavailable', seq: curSeq, model: cur };
      }
      console.warn('规范化表达式 / 不透明对象 DDL 失败（模型保持原样）', e instanceof Error ? e.message : e);
      return { kind: 'skipped', reason: 'canonicalize_failed', seq: curSeq, model: cur };
    }
    if (this.forgotten.has(branchId)) {
      return { kind: 'skipped', reason: 'forgotten', seq: curSeq, model: cur };
    }
    let patchRes: { committed: boolean; rejected: boolean; seq: number } | undefined;
    let after: { model: Model; versions: Versions; seq: number };
    try {
      patchRes = patched.length ? await this.rooms.patch(branchId, 'Dowel', patched, versions) : undefined;
      after = await this.rooms.state(branchId);
    } catch (e) {
      if (this.forgotten.has(branchId)) {
        return { kind: 'skipped', reason: 'forgotten', seq: curSeq, model: cur };
      }
      console.warn('写回规范化结果或读取房间状态失败（模型保持原样）', e instanceof Error ? e.message : e);
      return { kind: 'skipped', reason: 'store_failed', seq: curSeq, model: cur };
    }
    if (this.forgotten.has(branchId)) {
      return { kind: 'skipped', reason: 'forgotten', seq: after.seq, model: after.model };
    }
    const rejected =
      Boolean(patchRes?.rejected) || patched.some((o) => !deepEqual(after.model.objects[o.id], o));
    // 写回被拒绝或期间房间被替换：绝不用过期的 canonical 覆盖 branches.baseline
    if (rejected) return { kind: 'rejected', seq: after.seq, model: after.model };
    // 基线是“本次规范化的那份模型 + 规范形式”，而不是房间里的最新模型：
    // 规范化期间别人新增或修改的其他对象不在 canonical 里，留给下一轮继续规范化
    const canonical = structuredClone(cur);
    for (const o of patched) canonical.objects[o.id] = o;
    try {
      await this.setGood(branchId, canonical);
    } catch (e) {
      if (this.forgotten.has(branchId)) {
        return { kind: 'skipped', reason: 'forgotten', seq: after.seq, model: after.model };
      }
      console.warn('保存规范化基线失败（模型已写回，基线未推进）', e instanceof Error ? e.message : e);
      return { kind: 'skipped', reason: 'store_failed', seq: after.seq, model: after.model };
    }
    if (this.forgotten.has(branchId)) {
      return { kind: 'skipped', reason: 'forgotten', seq: after.seq, model: after.model };
    }
    if (
      (after.seq !== curSeq && !deepEqual(after.model, canonical)) ||
      needsRefresh(canonical, after.model)
    ) {
      return { kind: 'accepted', seq: after.seq, model: after.model };
    }
    return { kind: 'done', seq: after.seq, model: after.model };
  }

  /**
   * 显式规范化（模型页“规范化”按钮）：本地队列 + derive 锁内执行，停机中拒绝。
   * - 黄金基线就是当前模型：直接返回 clean（不连影子库；handle 是函数时也不会去解析影子库）；
   * - 否则在给定影子库里从基线（没有就从空模型）迁移到当前模型并读回，写回规范形式、推进基线；
   * - 影子库 / 表达式报错（ShadowError、StepError、PlanError、InstanceLevelStatementError）原样抛给路由，基线不变；
   * - 写回被拒（期间有人改了同一对象）抛 NormalizeConflictError；
   * - 期间分支被 forget（项目被删）：不论卡在哪一步（排队、读房间、读基线、解析影子库、影子库校验、写回、读回、保存基线），
   *   也不论那一步是否因此抛错（删除项目事务提交后会先同步 forget 再踢房间与关影子库），一律抛 BranchForgottenError，不报成功。
   */
  normalize(
    branchId: string,
    handleOrResolve: ShadowHandle | (() => Promise<ShadowHandle>),
  ): Promise<NormalizeOutcome> {
    if (this.stopped) return Promise.reject(new RefresherStoppedError());
    return this.enqueue(branchId, () =>
      this.withExclusiveLock(branchId, async (): Promise<NormalizeOutcome> => {
        let out: NormalizeOutcome;
        try {
          out = await this.normalizeLocked(branchId, handleOrResolve);
        } catch (e) {
          if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
          throw e;
        }
        // 写回 / 读回 / 保存基线期间被 forget：setGood 不写内存基线，这里也不能报成功
        if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
        return out;
      }),
    );
  }

  private async normalizeLocked(
    branchId: string,
    handleOrResolve: ShadowHandle | (() => Promise<ShadowHandle>),
  ): Promise<NormalizeOutcome> {
    if (this.stopped) throw new RefresherStoppedError();
    if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
    const { model: cur, versions, seq } = await this.rooms.state(branchId);
    if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
    const good = await this.loadGood(branchId);
    if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
    if (good !== null && deepEqual(good, cur)) {
      return {
        ok: true,
        outcome: 'clean',
        seq,
        normalizedCount: 0,
        normalizedObjects: [],
        checkedInShadow: false,
        shadow: typeof handleOrResolve === 'function' ? null : handleOrResolve.label,
      };
    }
    const handle = typeof handleOrResolve === 'function' ? await handleOrResolve() : handleOrResolve;
    if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
    const patched = await handle.shadow.canonicalize(good ?? emptyBaseline(cur), cur);
    // 已被 forget：不再写回（normalize 外层把它报成 BranchForgottenError）
    if (this.forgotten.has(branchId)) throw new BranchForgottenError(branchId);
    const patchRes = patched.length
      ? await this.rooms.patch(branchId, 'Dowel', patched, versions)
      : undefined;
    const after = await this.rooms.state(branchId);
    const rejected =
      Boolean(patchRes?.rejected) || patched.some((o) => !deepEqual(after.model.objects[o.id], o));
    if (rejected) throw new NormalizeConflictError(after.seq);
    const canonical = structuredClone(cur);
    for (const o of patched) canonical.objects[o.id] = o;
    await this.setGood(branchId, canonical);
    return {
      ok: true,
      outcome: patched.length ? 'normalized' : 'verified',
      seq: after.seq,
      normalizedCount: patched.length,
      normalizedObjects: patched.map((o) => refOf(canonical, o.id)),
      checkedInShadow: true,
      shadow: handle.label,
    };
  }

  /**
   * 给定的模型（通常是 flush 返回、被跳过的那一份）相对黄金基线还有哪些待规范化的对象（0 影子库 I/O、不拿 derive 锁）。
   * 发布在 flush 被跳过时据此决定是否在验证之前就拒绝（ADR 0017 决定 1）
   */
  async pendingIn(
    branchId: string,
    model: Model,
  ): Promise<{ pendingCount: number; objects: DerivedObjectRef[]; truncated: boolean }> {
    const good = await this.loadGood(branchId);
    const ids = pendingRefreshIds(good, model);
    return {
      pendingCount: ids.length,
      objects: ids.slice(0, STATUS_OBJECT_LIMIT).map((id) => refOf(model, id)),
      truncated: ids.length > STATUS_OBJECT_LIMIT,
    };
  }

  /** 只读状态（0 影子库 I/O、不拿 derive 锁）：当前模型相对黄金基线有多少待规范化的对象 */
  async status(branchId: string): Promise<RefreshStatus> {
    const { model: cur, seq } = await this.rooms.model(branchId);
    const good = await this.loadGood(branchId);
    const ids = pendingRefreshIds(good, cur);
    return {
      seq,
      pendingCount: ids.length,
      objects: ids.slice(0, STATUS_OBJECT_LIMIT).map((id) => refOf(cur, id)),
      truncated: ids.length > STATUS_OBJECT_LIMIT,
      baseline: good !== null,
    };
  }
}
