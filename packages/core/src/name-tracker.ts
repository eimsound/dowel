// 写时复制叠加索引的写入跟踪（Issue #164）：同步层 execute 的代理在每次写入后通知这里（noteWrite），
// 查询前惰性折叠（flush）成叠加层的命名空间分桶与倒排索引（基线里同 ID 的条目被遮蔽），
// 使"名字是否已被占用"、"哪些 CHECK 引用了这个列名"在叠加层上也是 O(1)，
// 并把写入翻译成推导名引擎的事件：名字被腾出（空位放回命名序列的最小堆）、撞名与输入变化（标脏）。
//
// 基线状态（naming-state.ts）在 execute 期间只被读取，唯一的例外是命名序列的空位堆 / 高水位：
// 叠加层取用的空位记在消耗日志里，finish() 时把基线下仍空着的位置放回，保证不变式在基线上成立。
// 只在所有写入都经过代理时正确（execute 保证这一点：mutator 拿到的对象全是代理）。
import {
  chargeDerivedNameWork,
  type DialectNaming,
  derivedNameStats,
  dialectNaming,
  DirtyByTable,
  type NamingView,
  normalizeSlots,
  slotTableOf,
} from './derived-names.ts';
import type { Dialect, Model, Obj, Table } from './ir.ts';
import type { MutableModelIndex } from './model-index.ts';
import { colNs } from './naming-ns.ts';
import {
  addNsOwner,
  type BaseNamingState,
  delNsOwner,
  entryKey,
  type MarkHost,
  markChange,
  type NsOwners,
  RefIndex,
  type Snap,
  snapOf,
  tableEntriesMoved,
} from './naming-state.ts';

const addSet = (map: Map<string, Set<string>>, k: string, v: string) => {
  let set = map.get(k);
  if (!set) {
    set = new Set();
    map.set(k, set);
  }
  set.add(v);
};

const delSet = (map: Map<string, Set<string>>, k: string, v: string) => {
  const set = map.get(k);
  if (!set) return;
  set.delete(v);
  if (set.size === 0) map.delete(k);
};

export class OverlayNameTracker implements NamingView, MarkHost {
  readonly dialect: Dialect;
  /** 名字可能需要重算的对象（开始时取自基线脏集合） */
  readonly dirty = new DirtyByTable();
  /** 正在做推导名刷新：引擎自己的写入不再标脏 */
  inPass = false;
  private finished = false;
  private pending = new Set<string>();
  private flushing = false;
  /** 被写入过的对象的当前快照（遮蔽基线登记内容；null 表示已删除） */
  private snaps = new Map<string, Snap | null>();
  private ov: NsOwners = new Map();
  private ovRefs = new RefIndex();
  /** 叠加层快照里的子对象 / 子分区 / 归属序列 */
  private ovKids = new Map<string, Set<string>>();
  private ovParts = new Map<string, Set<string>>();
  private ovSeqs = new Map<string, Set<string>>();

  private readonly base: MutableModelIndex;
  private readonly state: BaseNamingState;
  private readonly overlay: Map<string, Obj | undefined>;
  private readonly naming: DialectNaming;

  constructor(base: MutableModelIndex, state: BaseNamingState, overlay: Map<string, Obj | undefined>) {
    this.base = base;
    this.state = state;
    this.overlay = overlay;
    this.dialect = state.dialect;
    this.naming = dialectNaming(state.dialect);
    state.activeTracker?.finish();
    state.ensureNaming();
    state.activeTracker = this;
    state.reg.consumed = [];
    this.dirty.copyFrom(state.dirty);
  }

  noteWrite(id: string) {
    this.pending.add(id);
  }

  /** execute 结束（提交或回滚）：撤销对基线命名序列的消耗 */
  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.state.activeTracker === this) this.state.activeTracker = null;
    this.state.reg.undo((s, norm) => !!s.extraTaken?.(norm) || this.state.baseTaken(s.ns, norm));
  }

  private cur(id: string): Obj | undefined {
    return this.overlay.has(id) ? this.overlay.get(id) : this.base.getObj(id);
  }

  private readonly tableOf = (id: string): Table | undefined => {
    const o = this.cur(id);
    return o?.kind === 'table' ? o : undefined;
  };

  private masked(root: string): boolean {
    return this.snaps.has(root);
  }

  // ───── 折叠写入 ─────

  flush() {
    if (this.flushing || this.pending.size === 0) return;
    this.flushing = true;
    try {
      while (this.pending.size > 0) {
        const ids = [...this.pending];
        this.pending.clear();
        const changes: { id: string; prev: Snap | null; next: Snap | null }[] = [];
        // 第一阶段：所有写入对象的条目先换成新状态，再判定腾出 / 撞名（避免同批对象互相看不到）。
        // 基线对象的旧快照用基线登记的内容（与父表的当前状态无关，同批先删父表也能正确腾出）
        for (const id of ids) {
          const fromOv = this.snaps.has(id);
          const prev = fromOv ? this.snaps.get(id)! : (this.state.snaps.get(id) ?? null);
          const o = this.cur(id);
          const next = o ? snapOf(this.dialect, this.naming, o, this.tableOf) : null;
          if (fromOv && prev) this.unindex(id, prev);
          if (next) this.index(id, next);
          this.snaps.set(id, next);
          changes.push({ id, prev, next });
        }
        // 第二阶段：腾出 / 撞名 / 输入变化
        for (const { id, prev, next } of changes) {
          const prevKeys = new Set((prev?.entries ?? []).map(entryKey));
          const nextKeys = new Set((next?.entries ?? []).map(entryKey));
          for (const e of prev?.entries ?? []) {
            if (!nextKeys.has(entryKey(e)) && !this.hasOtherRaw(e.ns, e.name, null))
              this.state.reg.noteFreed(e.name);
          }
          for (const e of next?.entries ?? []) {
            if (prevKeys.has(entryKey(e))) continue;
            if (this.hasOtherRaw(e.ns, e.name, e.owner))
              for (const r of this.ownerRoots(e.ns, e.name)) this.mark(r);
          }
          if (tableEntriesMoved(this.dialect, prev, next)) {
            // 表换 schema / MSSQL 改名：子对象的条目随之变化，当作写入重新折叠
            for (const c of this.childIds(id)) {
              chargeDerivedNameWork(1);
              this.pending.add(c);
            }
          }
          markChange(this, id, prev, next);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private index(id: string, s: Snap) {
    for (const e of s.entries) addNsOwner(this.ov, e, id);
    this.ovRefs.add(id, s);
    if (s.parent) addSet(this.ovKids, s.parent, id);
    if (s.partitionParent) addSet(this.ovParts, s.partitionParent, id);
    if (s.ownedBy) addSet(this.ovSeqs, s.ownedBy, id);
  }

  private unindex(id: string, s: Snap) {
    for (const e of s.entries) delNsOwner(this.ov, e);
    this.ovRefs.del(id, s);
    if (s.parent) delSet(this.ovKids, s.parent, id);
    if (s.partitionParent) delSet(this.ovParts, s.partitionParent, id);
    if (s.ownedBy) delSet(this.ovSeqs, s.ownedBy, id);
  }

  // ───── 名字占用（NamingView） ─────

  private hasOtherRaw(ns: string, name: string, self: string | null): boolean {
    const ov = this.ov.get(ns)?.get(name);
    if (ov) for (const o of ov.keys()) if (o !== self) return true;
    const baseOwners = this.state.owners.get(ns)?.get(name);
    if (baseOwners) {
      for (const [owner, root] of baseOwners) if (owner !== self && !this.masked(root)) return true;
    }
    return false;
  }

  private ownerRoots(ns: string, name: string): string[] {
    const out: string[] = [];
    const ov = this.ov.get(ns)?.get(name);
    if (ov) for (const root of ov.values()) out.push(root);
    const baseOwners = this.state.owners.get(ns)?.get(name);
    if (baseOwners) for (const root of baseOwners.values()) if (!this.masked(root)) out.push(root);
    return out;
  }

  prepare() {
    this.flush();
  }

  hasOther(ns: string, name: string, self: string): boolean {
    this.flush();
    return this.hasOtherRaw(ns, name, self);
  }

  hasAny(ns: string, name: string): boolean {
    this.flush();
    return this.hasOtherRaw(ns, name, null);
  }

  columnIdByName(tableId: string, norm: string): string | undefined {
    this.flush();
    const ns = colNs(tableId);
    const ov = this.ov.get(ns)?.get(norm);
    if (ov) for (const k of ov.keys()) return k;
    const baseOwners = this.state.owners.get(ns)?.get(norm);
    if (baseOwners) for (const [k, root] of baseOwners) if (!this.masked(root)) return k;
    return undefined;
  }

  ancestors(tableId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([tableId]);
    let cur = this.tableOf(tableId)?.partitionOf?.parent ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const t = this.tableOf(cur);
      if (!t) break;
      out.push(t.id);
      cur = t.partitionOf?.parent ?? null;
    }
    return out;
  }

  /** 当前状态下的直接子分区（基线中未被改写的 + 叠加层里的） */
  partitionChildren(parentId: string): string[] {
    this.flush();
    const out: string[] = [];
    for (const t of this.base.partitionsRef(parentId)) if (!this.masked(t.id)) out.push(t.id);
    const ov = this.ovParts.get(parentId);
    if (ov) for (const id of ov) out.push(id);
    return out;
  }

  descendants(tableId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([tableId]);
    const queue = [tableId];
    for (let head = 0; head < queue.length; head++) {
      for (const c of this.partitionChildren(queue[head]!)) {
        if (seen.has(c)) continue;
        seen.add(c);
        out.push(c);
        queue.push(c);
      }
    }
    return out;
  }

  rootOf(tableId: string): string {
    const seen = new Set<string>();
    let cur = tableId;
    while (!seen.has(cur)) {
      seen.add(cur);
      const t = this.tableOf(cur);
      if (!t?.partitionOf || !this.tableOf(t.partitionOf.parent)) return cur;
      cur = t.partitionOf.parent;
    }
    return cur;
  }

  written(): void {}

  // ───── MarkHost（叠加层） ─────

  mark(id: string) {
    if (this.inPass) return;
    derivedNameStats.marks++;
    chargeDerivedNameWork(1);
    const o = this.cur(id);
    const t = o ? slotTableOf((x) => this.cur(x), o) : null;
    if (t) this.dirty.add(t, id);
  }

  refHits(norm: string): Iterable<string> {
    const out: string[] = [];
    for (const id of this.state.refIndex.refs.get(norm) ?? []) if (!this.masked(id)) out.push(id);
    for (const id of this.ovRefs.refs.get(norm) ?? []) out.push(id);
    return out;
  }

  colUsers(colId: string): Iterable<string> {
    const out: string[] = [];
    for (const id of this.state.refIndex.cols.get(colId) ?? []) if (!this.masked(id)) out.push(id);
    for (const id of this.ovRefs.cols.get(colId) ?? []) out.push(id);
    return out;
  }

  ownedSeqs(colId: string): Iterable<string> {
    const out: string[] = [];
    for (const id of this.state.ownedSeqs(colId)) if (!this.masked(id)) out.push(id);
    for (const id of this.ovSeqs.get(colId) ?? []) out.push(id);
    return out;
  }

  childIds(tableId: string): Iterable<string> {
    const out: string[] = [];
    for (const id of this.state.childIds(tableId)) if (!this.masked(id)) out.push(id);
    for (const id of this.ovKids.get(tableId) ?? []) out.push(id);
    return out;
  }

  parentOf(id: string): string | null {
    const o = this.cur(id);
    return o && 'parent' in o ? o.parent : null;
  }

  // ───── 刷新 ─────

  /** 校验一张表的脏对象并重算需要重算的推导名（m 为 execute 的写时复制草稿） */
  refresh(m: Model, tableId: string) {
    this.flush();
    derivedNameStats.passes++;
    const ids = this.dirty.take(tableId) ?? [];
    let left: Set<string>;
    this.inPass = true;
    try {
      left = normalizeSlots(m, this, this.naming, ids, this.state.reg, { counted: true });
      this.flush();
    } finally {
      this.inPass = false;
    }
    for (const id of left) this.dirty.add(tableId, id);
  }
}
