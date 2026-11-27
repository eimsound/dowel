// 可变/叠加模型索引：一次线性建表，支撑 O(1) 按 kind / parent / 分区父表 / 命名空间查询。
// 绝不跨外部调用挂靠在可变的 Model 上，必须由 withModelIndex 或同步层显式增量维护，杜绝脏缓存。
import type { Column, Kind, Model, Obj, ObjOf, Sequence, Table } from './ir.ts';
import { OverlayNameTracker } from './name-tracker.ts';
import { pgAllConNs, pgPropConNs, pgRelNs, pgTypeNs } from './naming-ns.ts';
import { BaseNamingState, hasOwnerOtherThan, type NsOwners, type Snap } from './naming-state.ts';

export interface ModelIndex {
  all<K extends Kind>(kind: K): ObjOf<K>[];
  allRef<K extends Kind>(kind: K): readonly ObjOf<K>[];
  childrenOf<K extends Kind>(parent: string, kind: K): ObjOf<K>[];
  childrenRef<K extends Kind>(parent: string, kind: K): readonly ObjOf<K>[];
  allChildrenOf(parent: string): Obj[];
  columnsOf(tableId: string): Column[];
  columnsRef(tableId: string): readonly Column[];
  partitionsOf(parentId: string): Table[];
  partitionsRef(parentId: string): readonly Table[];
  partitionDescendants(parentId: string): Table[];
  sequencesOwnedBy(colId: string): Sequence[];
  isPgRelTaken(schema: string, name: string, self: string): boolean;
  isPgConTaken(tableId: string, name: string, self: string): boolean;
  isPgTypeTaken(schema: string, name: string, self: string): boolean;
  /**
   * 命名空间（naming-ns.ts）里除 self 以外是否还有名字为 norm（已归一化）的占用者；
   * self 既可以是占用者 ID（如 `<列>#df`），也可以是对象 ID（排除该对象的全部条目，与方言扫描判定的 `o.id === self` 一致）。
   * 返回 undefined 表示该索引无法直接回答（未开启写入跟踪的叠加索引），调用方退回扫描。
   */
  nsTaken(ns: string, norm: string, self: string): boolean | undefined;
}

const cmpColumns = (a: Column, b: Column): number =>
  a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1;

const addBucket = <K1, V>(map: Map<K1, Map<string, V>>, k1: K1, id: string, val: V) => {
  let inner = map.get(k1);
  if (!inner) {
    inner = new Map();
    map.set(k1, inner);
  }
  inner.set(id, val);
};

const delBucket = <K1, V>(map: Map<K1, Map<string, V>>, k1: K1, id: string) => {
  const inner = map.get(k1);
  if (!inner) return;
  inner.delete(id);
  if (inner.size === 0) map.delete(k1);
};

const hasOtherOwner = (map: NsOwners, ns: string, name: string, selfId: string): boolean => {
  const owners = map.get(ns)?.get(name);
  if (!owners || owners.size === 0) return false;
  if (owners.size > 1) return true;
  return !owners.has(selfId);
};

const hasOwnOther = (
  map: NsOwners,
  ns: string,
  name: string,
  selfId: string,
  extraExclude?: string,
): boolean => {
  const owners = map.get(ns)?.get(name);
  if (!owners || owners.size === 0) return false;
  for (const ow of owners.keys()) {
    if (ow !== selfId && ow !== extraExclude) return true;
  }
  return false;
};

const EMPTY_LIST: readonly Obj[] = [];
const EMPTY_IDS: readonly string[] = [];

/** 沿 partitionOf 向上的祖先表 ID（不含自身，带环保护；与 model.ts 的 partitionAncestors 同语义） */
export const pgAncestorIds = (m: Model, tableId: string): string[] => {
  const out: string[] = [];
  const seen = new Set<string>([tableId]);
  const self = Object.hasOwn(m.objects, tableId) ? m.objects[tableId] : undefined;
  let cur = self?.kind === 'table' && self.partitionOf ? self.partitionOf.parent : null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = Object.hasOwn(m.objects, cur) ? m.objects[cur] : undefined;
    if (t?.kind !== 'table') break;
    out.push(t.id);
    cur = t.partitionOf?.parent ?? null;
  }
  return out;
};

export class MutableModelIndex implements ModelIndex {
  private model: Model;
  private byKind = new Map<Kind, Map<string, Obj>>();
  private byKindCache = new Map<Kind, Obj[]>();
  private childrenByParent = new Map<string, Map<string, Obj>>();
  private childrenByParentKind = new Map<string, Map<Kind, Map<string, Obj>>>();
  private childrenCache = new Map<string, Obj[]>();
  private partitionsByParent = new Map<string, Map<string, Table>>();
  private partitionsCache = new Map<string, Table[]>();
  private columnsCache = new Map<string, Column[]>();
  private seqsByOwnedCol = new Map<string, Map<string, Sequence>>();

  // 命名空间与推导名状态（首次查询时一次构建，之后随 applyObjectChange / applyBatch 增量同步），见 naming-state.ts
  private naming: BaseNamingState | null = null;

  constructor(model: Model) {
    this.model = model;
    for (const o of Object.values(model.objects)) {
      this.insertObj(o);
    }
  }

  private insertObj(o: Obj) {
    addBucket(this.byKind, o.kind, o.id, o);
    this.byKindCache.delete(o.kind);
    if ('parent' in o) {
      addBucket(this.childrenByParent, o.parent, o.id, o);
      let pkMap = this.childrenByParentKind.get(o.parent);
      if (!pkMap) {
        pkMap = new Map();
        this.childrenByParentKind.set(o.parent, pkMap);
      }
      addBucket(pkMap, o.kind, o.id, o);
      this.childrenCache.delete(`${o.parent}\0${o.kind}`);
      if (o.kind === 'column') this.columnsCache.delete(o.parent);
    }
    if (o.kind === 'table' && o.partitionOf) {
      addBucket(this.partitionsByParent, o.partitionOf.parent, o.id, o);
      this.partitionsCache.delete(o.partitionOf.parent);
    }
    if (o.kind === 'sequence' && o.ownedBy) {
      addBucket(this.seqsByOwnedCol, o.ownedBy, o.id, o);
    }
  }

  private removeObj(o: Obj) {
    delBucket(this.byKind, o.kind, o.id);
    this.byKindCache.delete(o.kind);
    if ('parent' in o) {
      delBucket(this.childrenByParent, o.parent, o.id);
      const pkMap = this.childrenByParentKind.get(o.parent);
      if (pkMap) {
        delBucket(pkMap, o.kind, o.id);
        if (pkMap.size === 0) this.childrenByParentKind.delete(o.parent);
      }
      this.childrenCache.delete(`${o.parent}\0${o.kind}`);
      if (o.kind === 'column') this.columnsCache.delete(o.parent);
    }
    if (o.kind === 'table' && o.partitionOf) {
      delBucket(this.partitionsByParent, o.partitionOf.parent, o.id);
      this.partitionsCache.delete(o.partitionOf.parent);
    }
    if (o.kind === 'sequence' && o.ownedBy) {
      delBucket(this.seqsByOwnedCol, o.ownedBy, o.id);
    }
  }

  private readonly tableLookup = (tableId: string): Table | undefined => {
    const indexed = this.byKind.get('table')?.get(tableId);
    if (indexed?.kind === 'table') return indexed;
    const t = Object.hasOwn(this.model.objects, tableId) ? this.model.objects[tableId] : undefined;
    return t?.kind === 'table' ? t : undefined;
  };

  /** 命名空间分桶（惰性构建） */
  private ns(): BaseNamingState {
    if (!this.naming) {
      this.naming = new BaseNamingState(this.model.dialect, {
        model: () => this.model,
        getObj: (id) => this.getObj(id) ?? this.byKind.get('table')?.get(id),
        childIds: (t) => this.childrenByParent.get(t)?.keys() ?? EMPTY_IDS,
        partitionChildIds: (t) => this.partitionsByParent.get(t)?.keys() ?? EMPTY_IDS,
        ownedSeqIds: (c) => this.seqsByOwnedCol.get(c)?.keys() ?? EMPTY_IDS,
      });
      this.naming.build();
    }
    return this.naming;
  }

  /** 推导名持久状态（叠加层跟踪器使用；首次调用时校验全部推导名对象） */
  namingState(): BaseNamingState {
    const st = this.ns();
    st.ensureNaming();
    return st;
  }

  applyObjectChange(id: string, prev: Obj | undefined, next: Obj | undefined) {
    if (prev && prev === next) return;
    const st = this.naming;
    const prevs = st ? st.beforeBatch([{ id, prev }]) : null;
    if (prev) this.removeObj(prev);
    if (next) this.insertObj(next);
    if (st && prevs) st.afterBatch([{ id, next }], prevs, false);
  }

  setModel(m: Model) {
    this.model = m;
  }

  getObj(id: string): Obj | undefined {
    return Object.hasOwn(this.model.objects, id) ? this.model.objects[id] : undefined;
  }

  /** 命名空间里某个（已归一化的）名字的占用者：占用者 ID -> 对象 ID */
  nsOwnersOf(ns: string, name: string): ReadonlyMap<string, string> | undefined {
    return this.ns().owners.get(ns)?.get(name);
  }

  getPgRelOwnerIds(schema: string, name: string): ReadonlyMap<string, string> | undefined {
    return this.nsOwnersOf(pgRelNs(schema), name);
  }

  getPgTypeOwnerIds(schema: string, name: string): ReadonlyMap<string, string> | undefined {
    return this.nsOwnersOf(pgTypeNs(schema), name);
  }

  /**
   * 批量应用一个提交的对象变更：先按登记内容移除命名空间条目（与父表的当前状态无关），
   * 再移除旧对象并切换为 nextModel，接着插入全部新对象，最后登记新条目、处理腾出 / 撞名并维护推导名脏集合。
   */
  applyBatch(
    nextModel: Model,
    changes: readonly { id: string; prev: Obj | undefined; next: Obj | undefined }[],
  ) {
    const st = this.naming;
    const prevs: (Snap | null)[] | null = st ? st.beforeBatch(changes) : null;
    for (let i = 0; i < changes.length; i++) {
      const prev = changes[i]!.prev;
      if (prev) this.removeObj(prev);
    }
    this.model = nextModel;
    for (let i = 0; i < changes.length; i++) {
      const next = changes[i]!.next;
      if (next) this.insertObj(next);
    }
    if (st && prevs) st.afterBatch(changes, prevs);
  }

  allRef<K extends Kind>(kind: K): readonly ObjOf<K>[] {
    let cached = this.byKindCache.get(kind);
    if (!cached) {
      const bucket = this.byKind.get(kind);
      cached = bucket ? [...bucket.values()] : (EMPTY_LIST as Obj[]);
      this.byKindCache.set(kind, cached);
    }
    return cached as unknown as readonly ObjOf<K>[];
  }

  all<K extends Kind>(kind: K): ObjOf<K>[] {
    return [...this.allRef(kind)];
  }

  childrenRef<K extends Kind>(parent: string, kind: K): readonly ObjOf<K>[] {
    const cacheKey = `${parent}\0${kind}`;
    let cached = this.childrenCache.get(cacheKey);
    if (!cached) {
      const bucket = this.childrenByParentKind.get(parent)?.get(kind);
      cached = bucket ? [...bucket.values()] : (EMPTY_LIST as Obj[]);
      this.childrenCache.set(cacheKey, cached);
    }
    return cached as unknown as readonly ObjOf<K>[];
  }

  childrenOf<K extends Kind>(parent: string, kind: K): ObjOf<K>[] {
    return [...this.childrenRef(parent, kind)];
  }

  allChildrenOf(parent: string): Obj[] {
    const bucket = this.childrenByParent.get(parent);
    return bucket ? [...bucket.values()] : [];
  }

  columnsRef(tableId: string): readonly Column[] {
    let cached = this.columnsCache.get(tableId);
    if (!cached) {
      const raw = this.childrenRef(tableId, 'column');
      cached = raw.length === 0 ? (EMPTY_LIST as Column[]) : [...raw].sort(cmpColumns);
      this.columnsCache.set(tableId, cached);
    }
    return cached;
  }

  columnsOf(tableId: string): Column[] {
    return [...this.columnsRef(tableId)];
  }

  partitionsRef(parentId: string): readonly Table[] {
    let cached = this.partitionsCache.get(parentId);
    if (!cached) {
      const bucket = this.partitionsByParent.get(parentId);
      cached = bucket ? [...bucket.values()] : (EMPTY_LIST as Table[]);
      this.partitionsCache.set(parentId, cached);
    }
    return cached;
  }

  partitionsOf(parentId: string): Table[] {
    return [...this.partitionsRef(parentId)];
  }

  partitionDescendants(parentId: string): Table[] {
    if (this.partitionsByParent.size === 0 || !this.partitionsByParent.has(parentId)) return [];
    const out: Table[] = [];
    const seen = new Set<string>([parentId]);
    const queue = [parentId];
    for (let head = 0; head < queue.length; head++) {
      const pid = queue[head]!;
      for (const child of this.partitionsRef(pid)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
    return out;
  }

  sequencesOwnedBy(colId: string): Sequence[] {
    const bucket = this.seqsByOwnedCol.get(colId);
    return bucket ? [...bucket.values()] : [];
  }

  isPgRelTaken(schema: string, name: string, self: string): boolean {
    return hasOtherOwner(this.ns().owners, pgRelNs(schema), name, self);
  }

  isPgTypeTaken(schema: string, name: string, self: string): boolean {
    return hasOtherOwner(this.ns().owners, pgTypeNs(schema), name, self);
  }

  nsTaken(ns: string, norm: string, self: string): boolean {
    return hasOwnerOtherThan(this.ns().owners.get(ns)?.get(norm), self);
  }

  isPgConTaken(tableId: string, name: string, self: string): boolean {
    const owners = this.ns().owners;
    const excludeNn = self.endsWith('#nn') ? self : undefined;
    if (hasOwnOther(owners, pgAllConNs(tableId), name, self, excludeNn)) return true;

    const selfObj = self && !self.endsWith('#nn') ? this.model.objects[self] : undefined;
    const selfPropagates =
      self === '' || self.endsWith('#nn') || selfObj?.kind === 'check' || selfObj?.kind === 'foreignKey';

    // 沿 partitionOf 向上检查祖先的向下继承约束（CHECK / FK / #nn）
    const seenAnc = new Set<string>([tableId]);
    let curObj = this.model.objects[tableId];
    let ancId = curObj?.kind === 'table' && curObj.partitionOf ? curObj.partitionOf.parent : null;
    while (ancId && !seenAnc.has(ancId)) {
      seenAnc.add(ancId);
      const t = this.model.objects[ancId];
      if (t?.kind !== 'table') break;
      if (hasOwnOther(owners, pgPropConNs(ancId), name, self, excludeNn)) return true;
      curObj = t;
      ancId = t.partitionOf?.parent ?? null;
    }

    if (selfPropagates && this.partitionsByParent.has(tableId)) {
      for (const desc of this.partitionDescendants(tableId)) {
        if (hasOwnOther(owners, pgAllConNs(desc.id), name, self, excludeNn)) return true;
      }
    }
    return false;
  }
}

/** 叠加索引查询访问的元素数（确定性计数守卫用：粘贴规模翻 4 倍时应只翻约 4 倍，见 Issue #165） */
export const modelIndexStats = { elems: 0 };

export const resetModelIndexStats = (): void => {
  modelIndexStats.elems = 0;
};

/** 叠加层对象在分桶里登记的位置 */
interface OvKey {
  kind: Kind;
  parent: string | null;
  /** 表的分区父表 */
  part: string | null;
  /** 序列的归属列 */
  owned: string | null;
}

const ovKeyOf = (o: Obj): OvKey => ({
  kind: o.kind,
  parent: 'parent' in o ? o.parent : null,
  part: o.kind === 'table' && o.partitionOf ? o.partitionOf.parent : null,
  owned: o.kind === 'sequence' && o.ownedBy ? o.ownedBy : null,
});

const sameOvKey = (a: OvKey | null, b: OvKey | null): boolean =>
  a === b ||
  (!!a && !!b && a.kind === b.kind && a.parent === b.parent && a.part === b.part && a.owned === b.owned);

const kidKey = (parent: string, kind: Kind) => `${parent}\0${kind}`;

/** 按首次写入顺序迭代的 ID 集合（与叠加层 Map 的插入顺序一致，结果顺序与逐个扫描叠加层相同） */
class OrderedIds {
  private ids = new Set<string>();
  private top = -1;
  private ordered = true;

  get size(): number {
    return this.ids.size;
  }

  add(id: string, seq: number) {
    this.ids.add(id);
    if (seq >= this.top) this.top = seq;
    else this.ordered = false;
  }

  delete(id: string) {
    this.ids.delete(id);
  }

  list(seqOf: ReadonlyMap<string, number>): Iterable<string> {
    if (!this.ordered) {
      this.ids = new Set([...this.ids].sort((a, b) => seqOf.get(a)! - seqOf.get(b)!));
      this.ordered = true;
    }
    return this.ids;
  }
}

const addOrdered = (map: Map<string, OrderedIds>, k: string, id: string, seq: number) => {
  let set = map.get(k);
  if (!set) {
    set = new OrderedIds();
    map.set(k, set);
  }
  set.add(id, seq);
};

const delOrdered = (map: Map<string, OrderedIds>, k: string, id: string) => {
  const set = map.get(k);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(k);
};

const inc = (map: Map<string, number>, k: string) => map.set(k, (map.get(k) ?? 0) + 1);

/**
 * 叠加层的分桶（Issue #165）：按 kind / (父对象, kind) / 父对象 / 分区父表 / 归属列登记叠加层里的当前对象，
 * 并统计各桶里被叠加层遮蔽（改写或删除）的基线对象数，使查询只做 O(该桶大小) 的工作、不再扫描整个叠加层。
 * 写入 ID 先记入 pending，查询前惰性折叠；状态只属于本次 execute，回滚时随叠加层一起丢弃，不触碰基线索引。
 */
class OverlayBuckets {
  readonly pending = new Set<string>();
  /** 已登记（被写入过）的 ID → 首次写入序号；同时就是"遮蔽基线同 ID 对象"的集合 */
  readonly seq = new Map<string, number>();
  private keys = new Map<string, OvKey | null>();
  readonly kinds = new Map<string, OrderedIds>();
  readonly kids = new Map<string, OrderedIds>();
  readonly parents = new Map<string, OrderedIds>();
  readonly parts = new Map<string, OrderedIds>();
  readonly seqs = new Map<string, OrderedIds>();
  readonly maskedKind = new Map<string, number>();
  readonly maskedKid = new Map<string, number>();
  readonly maskedParent = new Map<string, number>();
  readonly maskedPart = new Map<string, number>();
  readonly maskedSeq = new Map<string, number>();

  private readonly base: MutableModelIndex;
  private readonly overlay: Map<string, Obj | undefined>;

  constructor(base: MutableModelIndex, overlay: Map<string, Obj | undefined>) {
    this.base = base;
    this.overlay = overlay;
  }

  masked(id: string): boolean {
    return this.seq.has(id);
  }

  sync() {
    if (this.pending.size === 0) return;
    for (const id of this.pending) {
      // 只登记叠加层里确实有的 ID（写入回调总在写入叠加层之后调用）
      if (!this.overlay.has(id)) continue;
      let s = this.seq.get(id);
      if (s === undefined) {
        s = this.seq.size;
        this.seq.set(id, s);
        // 基线在 execute 期间不变：首次写入时把基线里的同 ID 对象记为被遮蔽
        const b = this.base.getObj(id);
        if (b) this.count(ovKeyOf(b));
      }
      const prev = this.keys.get(id) ?? null;
      const o = this.overlay.get(id);
      const next = o ? ovKeyOf(o) : null;
      if (sameOvKey(prev, next)) continue;
      if (prev) this.unplace(id, prev);
      if (next) this.place(id, next, s);
      this.keys.set(id, next);
    }
    this.pending.clear();
  }

  private count(k: OvKey) {
    inc(this.maskedKind, k.kind);
    if (k.parent !== null) {
      inc(this.maskedKid, kidKey(k.parent, k.kind));
      inc(this.maskedParent, k.parent);
    }
    if (k.part !== null) inc(this.maskedPart, k.part);
    if (k.owned !== null) inc(this.maskedSeq, k.owned);
  }

  private place(id: string, k: OvKey, s: number) {
    addOrdered(this.kinds, k.kind, id, s);
    if (k.parent !== null) {
      addOrdered(this.kids, kidKey(k.parent, k.kind), id, s);
      addOrdered(this.parents, k.parent, id, s);
    }
    if (k.part !== null) addOrdered(this.parts, k.part, id, s);
    if (k.owned !== null) addOrdered(this.seqs, k.owned, id, s);
  }

  private unplace(id: string, k: OvKey) {
    delOrdered(this.kinds, k.kind, id);
    if (k.parent !== null) {
      delOrdered(this.kids, kidKey(k.parent, k.kind), id);
      delOrdered(this.parents, k.parent, id);
    }
    if (k.part !== null) delOrdered(this.parts, k.part, id);
    if (k.owned !== null) delOrdered(this.seqs, k.owned, id);
  }
}

/**
 * 面向同步层的写时复制增量索引：底层只读复用基线 MutableModelIndex，
 * 所有查询跳过 overlay 中已被改写/删除的对象 ID，再接上叠加层分桶（OverlayBuckets）里的对象。
 * 即使 mutator 原地修改 overlay 内对象的属性（name / parent / partitionOf 等），依然 100% 实时准确：
 * 开启写入跟踪时由写入回调增量维护分桶（每次查询 O(该桶大小)）；未开启时每次查询前把整个叠加层重新折叠一遍。
 *
 * 创建方若保证所有写入都经过它的代理并通知 trackWrites 返回的回调（同步层 execute 如此），
 * 名字占用查询改走写入跟踪器的命名空间分桶（O(1)），推导名刷新只处理输入变化的对象（见 derived-names.ts）；
 * 执行结束（提交或回滚）后必须调用 finishTracking()。
 */
export class OverlayModelIndex implements ModelIndex {
  private base: MutableModelIndex;
  private overlay: Map<string, Obj | undefined>;
  private model: Model;
  private wrap?: <T extends Obj>(o: T) => T;
  private tracker: OverlayNameTracker | undefined;
  private readonly buckets: OverlayBuckets;
  /** 写入是否都经由 trackWrites 的回调通知（否则每次查询前重新折叠整个叠加层） */
  private tracked = false;

  constructor(
    base: MutableModelIndex,
    overlay: Map<string, Obj | undefined>,
    model: Model,
    wrap?: <T extends Obj>(o: T) => T,
  ) {
    this.base = base;
    this.overlay = overlay;
    this.model = model;
    this.wrap = wrap;
    this.buckets = new OverlayBuckets(base, overlay);
  }

  /**
   * 开启写入跟踪：返回的回调必须在每次写入叠加层对象（新增、删除、改任意字段）后以对象 ID 调用。
   * 只能在叠加层还为空时开启。
   */
  trackWrites(): (id: string) => void {
    if (this.overlay.size !== 0) throw new Error('trackWrites 只能在叠加层为空时开启');
    const tracker = new OverlayNameTracker(this.base, this.base.namingState(), this.overlay);
    this.tracker = tracker;
    this.tracked = true;
    const pending = this.buckets.pending;
    return (id) => {
      pending.add(id);
      tracker.noteWrite(id);
    };
  }

  /** 可用的写入跟踪器（未开启或已结束时为 undefined） */
  nameTracker(): OverlayNameTracker | undefined {
    return this.tracker;
  }

  /** 结束写入跟踪：撤销叠加层对基线命名序列的消耗（execute 无论成功与否都要调用） */
  finishTracking() {
    const tr = this.tracker;
    this.tracker = undefined;
    tr?.finish();
  }

  private wrapOut<T extends Obj>(o: T): T {
    return this.wrap ? this.wrap(o) : o;
  }

  private wrapList<T extends Obj>(xs: readonly T[]): T[] {
    if (!this.wrap) return [...xs];
    const out = new Array<T>(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = this.wrap(xs[i]!);
    return out;
  }

  private overlayVals(): IterableIterator<Obj | undefined> {
    modelIndexStats.elems += this.overlay.size;
    return this.overlay.values();
  }

  /** 折叠待处理写入后的分桶（未开启写入跟踪时整个叠加层都当作待处理） */
  private synced(): OverlayBuckets {
    let b = this.buckets;
    if (!this.tracked) {
      // 未跟踪写入：对象可能被原地修改、甚至从叠加层移除，每次查询都从头折叠
      b = new OverlayBuckets(this.base, this.overlay);
      modelIndexStats.elems += this.overlay.size;
      for (const id of this.overlay.keys()) b.pending.add(id);
    }
    b.sync();
    return b;
  }

  /** 基线列表去掉被遮蔽的对象再接上叠加层分桶里的对象；两者都没有时原样返回基线列表（不复制） */
  private merge<T extends Obj>(
    b: OverlayBuckets,
    baseList: readonly T[],
    masked: number,
    ov: OrderedIds | undefined,
  ): readonly T[] {
    const ovSize = ov?.size ?? 0;
    modelIndexStats.elems += baseList.length + ovSize;
    if (masked === 0 && ovSize === 0) return baseList;
    const out: T[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (masked === 0 || !b.masked(o.id)) out.push(o);
    }
    if (ov) for (const id of ov.list(b.seq)) out.push(this.overlay.get(id) as T);
    return out;
  }

  all<K extends Kind>(kind: K): ObjOf<K>[] {
    return this.wrapList(this.allRef(kind));
  }

  allRef<K extends Kind>(kind: K): readonly ObjOf<K>[] {
    const b = this.synced();
    return this.merge(b, this.base.allRef(kind), b.maskedKind.get(kind) ?? 0, b.kinds.get(kind));
  }

  childrenOf<K extends Kind>(parent: string, kind: K): ObjOf<K>[] {
    return this.wrapList(this.childrenRef(parent, kind));
  }

  childrenRef<K extends Kind>(parent: string, kind: K): readonly ObjOf<K>[] {
    const b = this.synced();
    const k = kidKey(parent, kind);
    return this.merge(b, this.base.childrenRef(parent, kind), b.maskedKid.get(k) ?? 0, b.kids.get(k));
  }

  allChildrenOf(parent: string): Obj[] {
    const b = this.synced();
    return this.wrapList(
      this.merge(b, this.base.allChildrenOf(parent), b.maskedParent.get(parent) ?? 0, b.parents.get(parent)),
    );
  }

  /** 本表的列是否都还是基线里的样子（没有被改写 / 删除 / 移入移出的列） */
  private columnsUntouched(tableId: string): boolean {
    const b = this.synced();
    const k = kidKey(tableId, 'column');
    return (b.maskedKid.get(k) ?? 0) === 0 && !b.kids.has(k);
  }

  columnsOf(tableId: string): Column[] {
    if (this.columnsUntouched(tableId)) return this.wrapList(this.base.columnsRef(tableId));
    return this.childrenOf(tableId, 'column').sort(cmpColumns);
  }

  columnsRef(tableId: string): readonly Column[] {
    if (this.columnsUntouched(tableId)) return this.base.columnsRef(tableId);
    return this.childrenRef(tableId, 'column').slice().sort(cmpColumns);
  }

  partitionsOf(parentId: string): Table[] {
    return this.wrapList(this.partitionsRef(parentId));
  }

  partitionsRef(parentId: string): readonly Table[] {
    const b = this.synced();
    return this.merge(
      b,
      this.base.partitionsRef(parentId),
      b.maskedPart.get(parentId) ?? 0,
      b.parts.get(parentId),
    ) as readonly Table[];
  }

  partitionDescendants(parentId: string): Table[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.partitionDescendants(parentId));
    const out: Table[] = [];
    const seen = new Set<string>([parentId]);
    const queue = [parentId];
    for (let head = 0; head < queue.length; head++) {
      const pid = queue[head]!;
      for (const child of this.partitionsRef(pid)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(this.wrapOut(child));
        queue.push(child.id);
      }
    }
    return out;
  }

  sequencesOwnedBy(colId: string): Sequence[] {
    const b = this.synced();
    return this.wrapList(
      this.merge(b, this.base.sequencesOwnedBy(colId), b.maskedSeq.get(colId) ?? 0, b.seqs.get(colId)),
    );
  }

  nsTaken(ns: string, norm: string, self: string): boolean | undefined {
    return this.tracker?.hasOtherThan(ns, norm, self);
  }

  private overlayPgRelMatch(schema: string, name: string, self: string): boolean {
    for (const o of this.overlayVals()) {
      if (!o || o.id === self) continue;
      if ((o.kind === 'table' || o.kind === 'sequence') && o.parent === schema && o.name === name) {
        return true;
      }
      if (o.kind === 'index' || o.kind === 'primaryKey' || o.kind === 'unique') {
        if (o.name === name) {
          const tbl = this.model.objects[o.parent];
          if (tbl?.kind === 'table' && tbl.parent === schema) return true;
        }
      } else if (o.kind === 'column' && o.identity && self !== `${o.id}#seq`) {
        if (o.identity.sequenceName === name) {
          const tbl = this.model.objects[o.parent];
          if (tbl?.kind === 'table' && tbl.parent === schema) return true;
        }
      }
    }
    return false;
  }

  isPgRelTaken(schema: string, name: string, self: string): boolean {
    const tr = this.nameTracker();
    if (tr) return tr.hasOther(pgRelNs(schema), name, self);
    if (this.overlay.size === 0) return this.base.isPgRelTaken(schema, name, self);
    if (this.overlayPgRelMatch(schema, name, self)) return true;
    for (const o of this.overlayVals()) {
      if (!o || o.kind !== 'table' || o.parent !== schema) continue;
      const baseTbl = this.base.getObj(o.id);
      if (!baseTbl || baseTbl.kind !== 'table' || baseTbl.parent === schema) continue;
      for (const child of this.base.allChildrenOf(o.id)) {
        if (this.overlay.has(child.id) || child.id === self) continue;
        if (
          (child.kind === 'index' || child.kind === 'primaryKey' || child.kind === 'unique') &&
          child.name === name
        ) {
          return true;
        }
        if (
          child.kind === 'column' &&
          child.identity &&
          self !== `${child.id}#seq` &&
          child.identity.sequenceName === name
        ) {
          return true;
        }
      }
    }
    const baseOwners = this.base.getPgRelOwnerIds(schema, name);
    if (!baseOwners || baseOwners.size === 0) return false;
    for (const ownerId of baseOwners.keys()) {
      if (ownerId === self) continue;
      const rawId = ownerId.endsWith('#seq') ? ownerId.slice(0, -4) : ownerId;
      if (this.overlay.has(rawId)) continue;
      const obj = this.base.getObj(rawId);
      if (
        obj &&
        (obj.kind === 'index' ||
          obj.kind === 'primaryKey' ||
          obj.kind === 'unique' ||
          obj.kind === 'column') &&
        this.overlay.has(obj.parent)
      ) {
        const tbl = this.model.objects[obj.parent];
        if (!tbl || tbl.kind !== 'table' || tbl.parent !== schema) continue;
      }
      return true;
    }
    return false;
  }

  isPgTypeTaken(schema: string, name: string, self: string): boolean {
    const tr = this.nameTracker();
    if (tr) return tr.hasOther(pgTypeNs(schema), name, self);
    if (this.overlay.size === 0) return this.base.isPgTypeTaken(schema, name, self);
    for (const o of this.overlayVals()) {
      if (
        o &&
        o.id !== self &&
        (o.kind === 'enum' || o.kind === 'table') &&
        o.parent === schema &&
        o.name === name
      ) {
        return true;
      }
    }
    const baseOwners = this.base.getPgTypeOwnerIds(schema, name);
    if (!baseOwners || baseOwners.size === 0) return false;
    for (const ownerId of baseOwners.keys()) {
      if (ownerId !== self && !this.overlay.has(ownerId)) return true;
    }
    return false;
  }

  /** 与下面的扫描实现同语义：本表全部约束 + 祖先的继承约束 + （自身会继承时）后代的全部约束 */
  private isPgConTakenTracked(tr: OverlayNameTracker, tableId: string, name: string, self: string): boolean {
    if (tr.hasOther(pgAllConNs(tableId), name, self)) return true;
    for (const anc of pgAncestorIds(this.model, tableId)) {
      if (tr.hasOther(pgPropConNs(anc), name, self)) return true;
    }
    const selfObj = self && !self.endsWith('#nn') ? this.model.objects[self] : undefined;
    const selfPropagates =
      self === '' || self.endsWith('#nn') || selfObj?.kind === 'check' || selfObj?.kind === 'foreignKey';
    if (selfPropagates) {
      for (const d of tr.descendants(tableId)) {
        if (tr.hasOther(pgAllConNs(d), name, self)) return true;
      }
    }
    return false;
  }

  isPgConTaken(tableId: string, name: string, self: string): boolean {
    const tr = this.nameTracker();
    if (tr) return this.isPgConTakenTracked(tr, tableId, name, self);
    if (this.overlay.size === 0) return this.base.isPgConTaken(tableId, name, self);
    const selfObj = self && !self.endsWith('#nn') ? this.model.objects[self] : undefined;
    const selfPropagates =
      self === '' || self.endsWith('#nn') || selfObj?.kind === 'check' || selfObj?.kind === 'foreignKey';

    const ancIds = new Set<string>();
    const seenAnc = new Set<string>([tableId]);
    let curObj = this.model.objects[tableId];
    let ancId = curObj?.kind === 'table' && curObj.partitionOf ? curObj.partitionOf.parent : null;
    while (ancId && !seenAnc.has(ancId)) {
      seenAnc.add(ancId);
      const t = this.model.objects[ancId];
      if (t?.kind !== 'table') break;
      ancIds.add(ancId);
      curObj = t;
      ancId = t.partitionOf?.parent ?? null;
    }
    const descIds = selfPropagates
      ? new Set(this.partitionDescendants(tableId).map((d) => d.id))
      : new Set<string>();

    // 检查 overlay 对象
    for (const o of this.overlayVals()) {
      if (!o || o.id === self) continue;
      if (o.kind === 'column' && o.notNull && self !== `${o.id}#nn` && o.notNullName === name) {
        if (o.parent === tableId || ancIds.has(o.parent) || descIds.has(o.parent)) return true;
      }
      if (!('parent' in o)) continue;
      if (o.parent === tableId) {
        if (
          (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
          o.name === name
        ) {
          return true;
        }
      } else if (ancIds.has(o.parent)) {
        if ((o.kind === 'check' || o.kind === 'foreignKey') && o.name === name) return true;
      } else if (descIds.has(o.parent)) {
        if (
          (o.kind === 'primaryKey' || o.kind === 'unique' || o.kind === 'check' || o.kind === 'foreignKey') &&
          o.name === name
        ) {
          return true;
        }
      }
    }

    // 检查 base：仅扫描相关表（tableId + ancIds + descIds），复杂度仍是 O(表内对象数)
    const relevantTables = [tableId, ...ancIds, ...descIds];
    for (const tid of relevantTables) {
      const isLocalOrDesc = tid === tableId || descIds.has(tid);
      const isAnc = ancIds.has(tid);
      for (const o of this.base.allChildrenOf(tid)) {
        if (this.overlay.has(o.id) || o.id === self) continue;
        if (o.kind === 'column') {
          if (o.notNull && self !== `${o.id}#nn` && o.notNullName === name) return true;
        } else if (o.kind === 'check' || o.kind === 'foreignKey') {
          if (o.name === name && (isLocalOrDesc || isAnc)) return true;
        } else if (isLocalOrDesc && (o.kind === 'primaryKey' || o.kind === 'unique')) {
          if (o.name === name) return true;
        }
      }
    }
    return false;
  }
}

export const buildModelIndex = (m: Model): MutableModelIndex => new MutableModelIndex(m);
