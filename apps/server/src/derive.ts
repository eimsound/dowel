// 派生数据（04-ir-design.md 2.6）：表达式和不透明对象（视图、触发器等）的引擎规范形式。
// 用户写的表达式会换成引擎的规范形式（如 (note <> '') → (note <> ''::text)），这样与线上库读出的结构可以直接比较；
// 编辑操作不改写不透明对象的 SQL 文本，改名后由服务器在影子库里重放一遍，读回 PG 自动更新后的 DDL。
//
// 做法：记住一份“DDL 确定正确”的模型作为基线（导入、拉取后的模型，或上次刷新后的模型）；
// 修改提交后（防抖），如果不透明对象依赖的对象改了名，就在影子库里建出基线、执行到当前模型的迁移、读回 DDL，
// 以系统身份写回（期间被别人改过的对象不写）。
import { deepEqual, type Model, type Obj } from '@dowel/core';
import type { Versions } from '@dowel/sync';
import type { Rooms } from './rooms.ts';
import type { Shadow } from './shadow.ts';

/** 对象的完整限定名（沿 parent 链拼接），用于判断是否改了名 */
const fullName = (m: Model, id: string): string | null => {
  const parts: string[] = [];
  for (let o: Obj | undefined = m.objects[id], i = 0; o && i < 5; i++) {
    parts.unshift(o.name);
    o = 'parent' in o ? m.objects[o.parent] : undefined;
  }
  return parts.length ? parts.join('.') : null;
};

export class OpaqueRefresher {
  private rooms: Rooms;
  private shadowOf: (branchId: string) => Promise<Shadow | null>;
  /** 基线的持久化（重启后仍知道哪份模型已规范化） */
  private store: {
    load(branchId: string): Promise<Model | null>;
    save(branchId: string, m: Model): Promise<void>;
  };
  private good = new Map<string, Model>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  /** 写回被拒绝后自动重试的次数（防止异常情况下无限重试） */
  private retries = new Map<string, number>();
  delayMs = 300;

  constructor(
    rooms: Rooms,
    shadowOf: (branchId: string) => Promise<Shadow | null>,
    store: OpaqueRefresher['store'],
  ) {
    this.rooms = rooms;
    this.shadowOf = shadowOf;
    this.store = store;
  }

  private async setGood(branchId: string, m: Model) {
    this.good.set(branchId, m);
    await this.store.save(branchId, m);
  }

  /** 导入、拉取之后：新模型就是引擎刚读出来的，直接作为基线 */
  async reset(branchId: string, model: Model) {
    clearTimeout(this.timers.get(branchId));
    this.timers.delete(branchId);
    await this.setGood(branchId, structuredClone(model));
  }

  schedule(branchId: string) {
    clearTimeout(this.timers.get(branchId));
    this.timers.set(
      branchId,
      setTimeout(() => {
        this.timers.delete(branchId);
        void this.start(branchId);
      }, this.delayMs),
    );
  }

  /**
   * 分支被删掉时清理内存状态：取消挂起的 timer，丢掉已经规范化的基线和重试计数。
   * 正在执行的刷新不在这里取消（Promise 取消不了）；它写回时会被房间的版本检查拒绝或忽略。
   */
  forget(branchId: string) {
    clearTimeout(this.timers.get(branchId));
    this.timers.delete(branchId);
    this.good.delete(branchId);
    this.retries.delete(branchId);
  }

  /** 测试和排查用：这个分支还有没有挂起的 timer / 基线 / 重试状态 */
  tracked(branchId: string): boolean {
    return this.timers.has(branchId) || this.good.has(branchId) || this.retries.has(branchId);
  }

  /** 立即执行挂起的刷新，并等它完成（验证、生成迁移、导出 DDL 之前调用） */
  async flush(branchId: string) {
    if (this.timers.has(branchId)) {
      clearTimeout(this.timers.get(branchId));
      this.timers.delete(branchId);
      await this.start(branchId);
    }
    await this.running.get(branchId);
  }

  private start(branchId: string): Promise<void> {
    const prev = this.running.get(branchId) ?? Promise.resolve();
    const p = prev.then(() => this.run(branchId)).catch((e) => console.error('刷新不透明对象 DDL 失败', e));
    this.running.set(branchId, p);
    return p;
  }

  private async run(branchId: string) {
    const { model: cur, versions } = await this.rooms.state(branchId);
    const good = this.good.get(branchId) ?? (await this.store.load(branchId));
    const shadow = await this.shadowOf(branchId);
    if (!good) {
      // 没有基线：从空模型开始规范化（相当于从零建出整个模型）
      if (!shadow) return;
      try {
        await this.apply(branchId, shadow, { ...cur, objects: {} }, cur, versions);
      } catch (e) {
        // 从零建不出来（例如重启前遗留了过期的不透明对象 DDL）：只能接受当前模型作为基线
        console.error('从零规范化失败，以当前模型作为基线', e);
        await this.setGood(branchId, cur);
      }
      return;
    }
    // 需要规范化的：表达式相对基线变了的对象；依赖的对象（或所在的表、schema）改了名的不透明对象
    const base = good;
    const renamed = (id: string) => {
      const x = fullName(base, id);
      const y = fullName(cur, id);
      return x !== null && y !== null && x !== y;
    };
    const needs = Object.values(cur.objects).some((o) =>
      o.kind === 'opaque'
        ? [...o.deps, o.parent].some(renamed) || !deepEqual(exprsOf(o), exprsOf(base.objects[o.id]))
        : exprsOf(o) !== null && !deepEqual(exprsOf(o), exprsOf(base.objects[o.id])),
    );
    if (!needs) {
      await this.setGood(branchId, cur);
      return;
    }
    if (!shadow) return;
    await this.apply(branchId, shadow, good, cur, versions);
  }

  private async apply(branchId: string, shadow: Shadow, good: Model, cur: Model, versions: Versions) {
    const patched = await shadow.canonicalize(good, cur);
    if (patched.length) await this.rooms.patch(branchId, 'Dowel', patched, versions);
    // 基线是“本次规范化的那份模型 + 规范形式”，而不是房间里的最新模型：
    // 规范化期间别人改过的对象，写回会被版本检查拒绝，它们在最新模型里仍是原文，不能当成已规范化
    const canonical = structuredClone(cur);
    for (const o of patched) canonical.objects[o.id] = o;
    await this.setGood(branchId, canonical);
    const now = (await this.rooms.state(branchId)).model;
    const rejected = patched.some((o) => !deepEqual(now.objects[o.id], o));
    const n = rejected ? (this.retries.get(branchId) ?? 0) + 1 : 0;
    this.retries.set(branchId, n);
    if (rejected && n <= 3) this.schedule(branchId);
  }
}

/** 对象里需要规范化的表达式（没有则为 null） */
const exprsOf = (o: Obj | undefined): unknown => {
  if (!o) return null;
  switch (o.kind) {
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
