// 派生数据（04-ir-design.md 2.6）：表达式和不透明对象（视图、触发器等）的引擎规范形式。
// 用户写的表达式会换成引擎的规范形式（如 (note <> '') → (note <> ''::text)），这样与线上库读出的结构可以直接比较；
// 编辑操作不改写不透明对象的 SQL 文本，改名后由服务器在影子库里重放一遍，读回 PG 自动更新后的 DDL。
//
// 做法：记住一份“DDL 确定正确”的模型作为基线（导入、拉取后的模型，或上次刷新后的模型）；
// 修改提交后（防抖），如果不透明对象依赖的对象改了名，就在影子库里建出基线、执行到当前模型的迁移、读回 DDL，
// 以系统身份写回（期间被别人改过的对象不写）。
import { deepEqual, type Model, type Obj } from '@dowel/core';
import type { Versions } from '@dowel/sync';

import type { HaCoordinator } from './ha.ts';
import type { Rooms } from './rooms.ts';
import type { Shadow } from './shadow.ts';

const MAX_CATCHUP_ROUNDS = 5;
const MAX_REJECT_RETRIES = 3;
const DEFAULT_FLUSH_LOCK_TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 100;

/** 对象的完整限定名（沿 parent 链拼接），用于判断是否改了名 */
const fullName = (m: Model, id: string): string | null => {
  const parts: string[] = [];
  for (let o: Obj | undefined = m.objects[id], i = 0; o && i < 5; i++) {
    parts.unshift(o.name);
    o = 'parent' in o ? m.objects[o.parent] : undefined;
  }
  return parts.length ? parts.join('.') : null;
};

/** 判断当前模型相对基线是否存在待规范化的表达式或依赖改名的不透明对象 */
const needsRefresh = (base: Model, cur: Model): boolean => {
  const renamed = (id: string) => {
    const x = fullName(base, id);
    const y = fullName(cur, id);
    return x !== null && y !== null && x !== y;
  };
  return Object.values(cur.objects).some((o) =>
    o.kind === 'opaque'
      ? [...o.deps, o.parent].some(renamed) || !deepEqual(exprsOf(o), exprsOf(base.objects[o.id]))
      : exprsOf(o) !== null && !deepEqual(exprsOf(o), exprsOf(base.objects[o.id])),
  );
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
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  /** 写回被拒绝后自动重试的次数（防止异常情况下无限重试） */
  private retries = new Map<string, number>();
  /** 在途任务尚未结束时被 forget 的分支，防止任务结束时回写内存/库基线 */
  private forgotten = new Set<string>();
  private stopped = false;
  delayMs = 300;
  /** 强一致 flush / runWithReset 等待分布式锁的超时时间（毫秒） */
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

  private retryDelayMs(): number {
    return Math.min(this.delayMs, MAX_RETRY_DELAY_MS);
  }

  private async setGood(branchId: string, m: Model) {
    if (this.forgotten.has(branchId)) return;
    this.good.set(branchId, m);
    await this.store.save(branchId, m);
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
   * 进程内按分支串行排队，确保本地后台刷新、flush 与 reset/replace 不交错，
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
    if (!lock.acquired) {
      throw new Error(`等待分支 ${branchId} 派生数据刷新锁超时`);
    }
    return lock.value;
  }

  /** 导入、拉取之后：新模型就是引擎刚读出来的，直接作为基线（受 derive 锁保护） */
  async reset(branchId: string, model: Model) {
    this.forgotten.delete(branchId);
    const baseline = structuredClone(model);
    await this.enqueue(branchId, () =>
      this.withExclusiveLock(branchId, async () => {
        clearTimeout(this.timers.get(branchId));
        this.timers.delete(branchId);
        await this.setGood(branchId, baseline);
        this.retries.delete(branchId);
      }),
    );
  }

  /**
   * 在 derive 分布式锁与本地串行队列保护下执行整体模型替换并重置基线：
   * - 阻塞等待任何在途 canonicalize 结束后再 replace，防止旧任务写回覆盖新基线；
   * - 以调用方传入的 model（而非事后重读 rooms.model）写入基线，防止 replace 与 reset 间的并发提交污染基线；
   * - 锁序严格单向：本地队列 → job:derive:<branchId> → rooms.withRoomLock → branches FOR UPDATE。
   */
  async runWithReset<T>(branchId: string, model: Model, fn: () => Promise<T>): Promise<T> {
    this.forgotten.delete(branchId);
    const baseline = structuredClone(model);
    return this.enqueue(branchId, () =>
      this.withExclusiveLock(branchId, async () => {
        const hadTimer = this.timers.has(branchId);
        clearTimeout(this.timers.get(branchId));
        this.timers.delete(branchId);
        let result: T;
        try {
          result = await fn();
        } catch (err) {
          if (hadTimer && !this.stopped && !this.forgotten.has(branchId)) {
            this.schedule(branchId);
          }
          throw err;
        }
        // 不在 fn() 之后清 timer：fn() 返回到 setGood 之间的并发用户提交会重新 schedule，必须保留
        await this.setGood(branchId, baseline);
        this.retries.delete(branchId);
        return result;
      }),
    );
  }

  schedule(branchId: string, delayMs = this.delayMs) {
    if (this.stopped) return;
    this.forgotten.delete(branchId);
    clearTimeout(this.timers.get(branchId));
    const timer = setTimeout(() => {
      this.timers.delete(branchId);
      if (this.stopped || this.forgotten.has(branchId)) return;
      void this.start(branchId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(branchId, timer);
  }

  /** 停止接收新防抖调度并清理尚未触发的定时器（优雅停机用） */
  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** 停止新调度并等待所有已启动的刷新任务完成（优雅停机排空用） */
  async drain(): Promise<void> {
    this.stop();
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /**
   * 分支被删掉时清理内存状态：取消挂起的 timer，丢掉已经规范化的基线和重试计数。
   * 正在执行的刷新不在这里取消（Promise 取消不了）；它写回时会被房间的版本检查拒绝或忽略，
   * 并通过 forgotten 标记阻止其回写内存基线。
   */
  forget(branchId: string) {
    clearTimeout(this.timers.get(branchId));
    this.timers.delete(branchId);
    this.good.delete(branchId);
    this.retries.delete(branchId);
    if (this.running.has(branchId)) this.forgotten.add(branchId);
  }

  /** 测试和排查用：这个分支还有没有挂起的 timer / 基线 / 重试状态 */
  tracked(branchId: string): boolean {
    return this.timers.has(branchId) || this.good.has(branchId) || this.retries.has(branchId);
  }

  /**
   * 立即执行并等待该分支的派生数据刷新追齐（验证、生成迁移、导出 DDL、发布、历史恢复之前调用）。
   * - HA（PG）模式：清掉本地定时器后阻塞等待分布式锁 job:derive:<branchId>，并在锁内循环追齐跨副本提交；
   * - 单机模式（SQLite 或无 HA）：仅当本地有挂起定时器或在途任务时执行并等待。
   */
  async flush(branchId: string) {
    if (this.ha?.isDistributed) {
      clearTimeout(this.timers.get(branchId));
      this.timers.delete(branchId);
      await this.enqueue(branchId, () => this.withExclusiveLock(branchId, () => this.runLocked(branchId)));
      return;
    }
    // 单机模式（SQLite 或无 HA）：无跨副本编辑，仅当本地有挂起定时器或在途任务时执行并等待
    if (this.timers.has(branchId)) {
      clearTimeout(this.timers.get(branchId));
      this.timers.delete(branchId);
      await this.enqueue(branchId, () => this.withExclusiveLock(branchId, () => this.runLocked(branchId)));
      return;
    }
    const inflight = this.running.get(branchId);
    if (inflight) {
      await inflight;
      if (this.timers.has(branchId)) {
        clearTimeout(this.timers.get(branchId));
        this.timers.delete(branchId);
        await this.enqueue(branchId, () => this.withExclusiveLock(branchId, () => this.runLocked(branchId)));
      }
    }
  }

  private start(branchId: string): Promise<void> {
    return this.enqueue(branchId, () =>
      this.runBackground(branchId).catch((e) => {
        console.error('刷新不透明对象 DDL 失败', e);
      }),
    );
  }

  private async runBackground(branchId: string) {
    if (this.stopped || this.forgotten.has(branchId)) return;
    if (!this.ha) {
      await this.runLocked(branchId);
      return;
    }
    const lock = await this.ha.tryWithJobLock(`derive:${branchId}`, () => this.runLocked(branchId));
    if (!lock.acquired && !this.stopped && !this.forgotten.has(branchId)) {
      // 另一副本正在刷新同一分支：不静默丢弃，短延迟重排以防期间新提交漏刷
      this.schedule(branchId, this.retryDelayMs());
    }
  }

  private async runLocked(branchId: string) {
    for (let round = 0; round < MAX_CATCHUP_ROUNDS; round++) {
      if (this.stopped || this.forgotten.has(branchId)) return;
      const { model: cur, versions, seq } = await this.rooms.state(branchId);
      const good = await this.loadGood(branchId);
      if (!good) {
        const empty: Model = { ...cur, objects: {} };
        if (!needsRefresh(empty, cur)) {
          await this.setGood(branchId, cur);
          this.retries.delete(branchId);
          const after = await this.rooms.state(branchId);
          if (after.seq === seq && deepEqual(after.model, cur)) return;
          continue;
        }
        // 没有基线：从空模型开始规范化（相当于从零建出整个模型）
        const shadow = await this.shadowOf(branchId);
        if (!shadow) return;
        try {
          const outcome = await this.apply(branchId, shadow, empty, cur, versions, seq);
          if (outcome === 'done' || outcome === 'give_up') return;
        } catch (e) {
          // 从零建不出来（例如重启前遗留了过期的不透明对象 DDL）：只能接受当前模型作为基线
          console.error('从零规范化失败，以当前模型作为基线', e);
          if (!this.forgotten.has(branchId)) {
            const latest = await this.rooms.state(branchId);
            if (latest.seq === seq) await this.setGood(branchId, cur);
          }
          return;
        }
        continue;
      }
      if (!needsRefresh(good, cur)) {
        this.retries.delete(branchId);
        if (deepEqual(good, cur)) return;
        await this.setGood(branchId, cur);
        const after = await this.rooms.state(branchId);
        if (after.seq === seq && deepEqual(after.model, cur)) return;
        continue;
      }
      const shadow = await this.shadowOf(branchId);
      if (!shadow) return;
      try {
        const outcome = await this.apply(branchId, shadow, good, cur, versions, seq);
        if (outcome === 'done' || outcome === 'give_up') return;
      } catch (e) {
        console.error('刷新不透明对象 DDL 失败', e);
        return;
      }
    }
    // 单次持锁达到循环上限（防止持续编辑造成活锁）：释放锁前重排一次，确保后续提交不漏刷
    if (!this.stopped && !this.forgotten.has(branchId)) {
      this.schedule(branchId, this.retryDelayMs());
    }
  }

  private async apply(
    branchId: string,
    shadow: Shadow,
    good: Model,
    cur: Model,
    versions: Versions,
    curSeq: number,
  ): Promise<'done' | 'retry' | 'give_up'> {
    const patched = await shadow.canonicalize(good, cur);
    if (this.forgotten.has(branchId)) return 'done';
    const patchRes = patched.length
      ? await this.rooms.patch(branchId, 'Dowel', patched, versions)
      : undefined;
    const after = await this.rooms.state(branchId);
    const rejected =
      Boolean(patchRes?.rejected) || patched.some((o) => !deepEqual(after.model.objects[o.id], o));
    if (rejected) {
      // 写回被版本检查拒绝或期间房间被替换：绝不用过期的 canonical 覆盖 branches.baseline
      const n = (this.retries.get(branchId) ?? 0) + 1;
      this.retries.set(branchId, n);
      return n <= MAX_REJECT_RETRIES ? 'retry' : 'give_up';
    }
    this.retries.delete(branchId);
    // 基线是“本次规范化的那份模型 + 规范形式”，而不是房间里的最新模型：
    // 规范化期间别人新增或修改的其他对象不在 canonical 里，留给下一轮继续规范化
    const canonical = structuredClone(cur);
    for (const o of patched) canonical.objects[o.id] = o;
    await this.setGood(branchId, canonical);
    if (
      (after.seq !== curSeq && !deepEqual(after.model, canonical)) ||
      needsRefresh(canonical, after.model)
    ) {
      return 'retry';
    }
    return 'done';
  }
}

/** 对象里需要规范化的表达式（没有则为 null） */
const exprsOf = (o: Obj | undefined): unknown => {
  if (!o) return null;
  switch (o.kind) {
    case 'table': {
      const partExprs =
        o.partitionBy && typeof o.partitionBy !== 'string' && o.partitionBy.keys.some((k) => k.expr)
          ? o.partitionBy.keys.map((k) => k.expr)
          : null;
      const bound = o.partitionOf?.bound ?? null;
      return partExprs || bound !== null ? [partExprs, bound] : null;
    }
    case 'check':
      return o.expr;
    case 'index':
      return o.elements.some((e) => e.expr) || o.where ? [o.elements.map((e) => e.expr), o.where] : null;
    case 'column':
      return o.generated || (o.default && 'expr' in o.default) ? [o.generated, o.default] : null;
    case 'opaque':
      return o.ddl;
    default:
      return null;
  }
};
