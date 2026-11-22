// 可变/叠加模型索引：一次线性建表，支撑 O(1) 按 kind / parent / 分区父表 / PG 命名空间查询。
// 绝不跨外部调用挂靠在可变的 Model 上，必须由 withModelIndex 或同步层显式增量维护，杜绝脏缓存。
import type { Column, Kind, Model, Obj, ObjOf, Sequence, Table } from './ir.ts';

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

const addOwner = (
  map: Map<string, Map<string, Set<string>>>,
  container: string,
  name: string,
  ownerId: string,
) => {
  let byName = map.get(container);
  if (!byName) {
    byName = new Map();
    map.set(container, byName);
  }
  let owners = byName.get(name);
  if (!owners) {
    owners = new Set();
    byName.set(name, owners);
  }
  owners.add(ownerId);
};

const delOwner = (
  map: Map<string, Map<string, Set<string>>>,
  container: string,
  name: string,
  ownerId: string,
) => {
  const byName = map.get(container);
  if (!byName) return;
  const owners = byName.get(name);
  if (!owners) return;
  owners.delete(ownerId);
  if (owners.size === 0) {
    byName.delete(name);
    if (byName.size === 0) map.delete(container);
  }
};

const hasOtherOwner = (
  map: Map<string, Map<string, Set<string>>>,
  container: string,
  name: string,
  selfId: string,
): boolean => {
  const owners = map.get(container)?.get(name);
  if (!owners || owners.size === 0) return false;
  if (owners.size > 1) return true;
  return !owners.has(selfId);
};

const hasOwnOther = (
  map: Map<string, Map<string, Set<string>>>,
  container: string,
  name: string,
  selfId: string,
  extraExclude?: string,
): boolean => {
  const owners = map.get(container)?.get(name);
  if (!owners || owners.size === 0) return false;
  for (const ow of owners) {
    if (ow !== selfId && ow !== extraExclude) return true;
  }
  return false;
};

const EMPTY_LIST: readonly Obj[] = [];

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

  // PG 命名空间惰性索引（首次查询时一次构建，之后随 applyObjectChange O(1) 同步）
  private pgNamespacesReady = false;
  private pgRelOwners = new Map<string, Map<string, Set<string>>>();
  private pgTypeOwners = new Map<string, Map<string, Set<string>>>();
  /** 表级全部约束（PK / UNIQUE / CHECK / FK / #nn）归属：tableId -> name -> Set<ownerId> */
  private pgAllConOwners = new Map<string, Map<string, Set<string>>>();
  /** 表级向下继承约束（CHECK / FK / #nn）归属：tableId -> name -> Set<ownerId> */
  private pgPropConOwners = new Map<string, Map<string, Set<string>>>();

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

  private tableSchema(tableId: string): string | undefined {
    const indexed = this.byKind.get('table')?.get(tableId);
    if (indexed?.kind === 'table') return indexed.parent;
    const t = this.model.objects[tableId];
    return t?.kind === 'table' ? t.parent : undefined;
  }

  private invalidatePgNamespaces() {
    this.pgNamespacesReady = false;
    this.pgRelOwners.clear();
    this.pgTypeOwners.clear();
    this.pgAllConOwners.clear();
    this.pgPropConOwners.clear();
  }

  private indexPgNsObj(o: Obj, add: boolean) {
    const fn = add ? addOwner : delOwner;
    if (o.kind === 'table') {
      fn(this.pgRelOwners, o.parent, o.name, o.id);
      fn(this.pgTypeOwners, o.parent, o.name, o.id);
    } else if (o.kind === 'enum') {
      fn(this.pgTypeOwners, o.parent, o.name, o.id);
    } else if (o.kind === 'sequence') {
      fn(this.pgRelOwners, o.parent, o.name, o.id);
    } else if (o.kind === 'index') {
      const sch = this.tableSchema(o.parent);
      if (sch) fn(this.pgRelOwners, sch, o.name, o.id);
    } else if (o.kind === 'primaryKey' || o.kind === 'unique') {
      const sch = this.tableSchema(o.parent);
      if (sch) fn(this.pgRelOwners, sch, o.name, o.id);
      fn(this.pgAllConOwners, o.parent, o.name, o.id);
    } else if (o.kind === 'check' || o.kind === 'foreignKey') {
      fn(this.pgAllConOwners, o.parent, o.name, o.id);
      fn(this.pgPropConOwners, o.parent, o.name, o.id);
    } else if (o.kind === 'column') {
      if (o.identity) {
        const sch = this.tableSchema(o.parent);
        if (sch) fn(this.pgRelOwners, sch, o.identity.sequenceName, `${o.id}#seq`);
      }
      if (o.notNull && o.notNullName) {
        fn(this.pgAllConOwners, o.parent, o.notNullName, `${o.id}#nn`);
        fn(this.pgPropConOwners, o.parent, o.notNullName, `${o.id}#nn`);
      }
    }
  }

  private ensurePgNamespaces() {
    if (this.pgNamespacesReady) return;
    this.pgNamespacesReady = true;
    for (const o of Object.values(this.model.objects)) {
      this.indexPgNsObj(o, true);
    }
  }

  applyObjectChange(id: string, prev: Obj | undefined, next: Obj | undefined) {
    if (prev && prev === next) return;
    if (
      this.pgNamespacesReady &&
      prev?.kind === 'table' &&
      next?.kind === 'table' &&
      prev.parent !== next.parent
    ) {
      this.invalidatePgNamespaces();
    }
    if (this.pgNamespacesReady && prev) {
      this.indexPgNsObj(prev, false);
    }
    if (prev) this.removeObj(prev);
    if (next) this.insertObj(next);
    if (this.pgNamespacesReady && next) {
      this.indexPgNsObj(next, true);
    }
  }

  setModel(m: Model) {
    this.model = m;
  }

  getObj(id: string): Obj | undefined {
    return this.model.objects[id];
  }

  getPgRelOwnerIds(schema: string, name: string): ReadonlySet<string> | undefined {
    this.ensurePgNamespaces();
    return this.pgRelOwners.get(schema)?.get(name);
  }

  getPgTypeOwnerIds(schema: string, name: string): ReadonlySet<string> | undefined {
    this.ensurePgNamespaces();
    return this.pgTypeOwners.get(schema)?.get(name);
  }

  /**
   * 批量应用一个提交的对象变更：先在旧索引状态上移除 PG 命名空间（保障 tableSchema 可解析被删表），
   * 再移除旧对象并切换为 nextModel，接着插入全部新对象，最后更新 PG 命名空间（保障新建表可解析）。
   */
  applyBatch(
    nextModel: Model,
    changes: readonly { id: string; prev: Obj | undefined; next: Obj | undefined }[],
  ) {
    if (this.pgNamespacesReady) {
      for (let i = 0; i < changes.length; i++) {
        const { prev, next } = changes[i]!;
        if (prev?.kind === 'table' && next?.kind === 'table' && prev.parent !== next.parent) {
          this.invalidatePgNamespaces();
          break;
        }
      }
    }
    if (this.pgNamespacesReady) {
      for (let i = 0; i < changes.length; i++) {
        const prev = changes[i]!.prev;
        if (prev) this.indexPgNsObj(prev, false);
      }
    }
    for (let i = 0; i < changes.length; i++) {
      const prev = changes[i]!.prev;
      if (prev) this.removeObj(prev);
    }
    this.model = nextModel;
    for (let i = 0; i < changes.length; i++) {
      const next = changes[i]!.next;
      if (next) this.insertObj(next);
    }
    if (this.pgNamespacesReady) {
      for (let i = 0; i < changes.length; i++) {
        const next = changes[i]!.next;
        if (next) this.indexPgNsObj(next, true);
      }
    }
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
    this.ensurePgNamespaces();
    return hasOtherOwner(this.pgRelOwners, schema, name, self);
  }

  isPgTypeTaken(schema: string, name: string, self: string): boolean {
    this.ensurePgNamespaces();
    return hasOtherOwner(this.pgTypeOwners, schema, name, self);
  }

  isPgConTaken(tableId: string, name: string, self: string): boolean {
    this.ensurePgNamespaces();
    const excludeNn = self.endsWith('#nn') ? self : undefined;
    if (hasOwnOther(this.pgAllConOwners, tableId, name, self, excludeNn)) return true;

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
      if (hasOwnOther(this.pgPropConOwners, ancId, name, self, excludeNn)) return true;
      curObj = t;
      ancId = t.partitionOf?.parent ?? null;
    }

    if (selfPropagates && this.partitionsByParent.has(tableId)) {
      for (const desc of this.partitionDescendants(tableId)) {
        if (hasOwnOther(this.pgAllConOwners, desc.id, name, self, excludeNn)) return true;
      }
    }
    return false;
  }
}

/**
 * 面向同步层的写时复制增量索引：底层只读复用基线 MutableModelIndex，
 * 所有查询跳过 overlay 中已被改写/删除的对象 ID，并现场折叠小规模 overlay（通常仅 1–10 个对象）。
 * 即使 mutator 原地修改 overlay 内对象的属性（name / parent / partitionOf 等），依然 100% 实时准确。
 */
export class OverlayModelIndex implements ModelIndex {
  private base: MutableModelIndex;
  private overlay: Map<string, Obj | undefined>;
  private model: Model;
  private wrap?: <T extends Obj>(o: T) => T;

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
    return this.overlay.values();
  }

  all<K extends Kind>(kind: K): ObjOf<K>[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.allRef(kind));
    const baseList = this.base.allRef(kind);
    const out: ObjOf<K>[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (!this.overlay.has(o.id)) out.push(this.wrapOut(o));
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === kind) out.push(this.wrapOut(o as ObjOf<K>));
    }
    return out;
  }

  allRef<K extends Kind>(kind: K): readonly ObjOf<K>[] {
    if (this.overlay.size === 0) return this.base.allRef(kind);
    const baseList = this.base.allRef(kind);
    const out: ObjOf<K>[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (!this.overlay.has(o.id)) out.push(o);
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === kind) out.push(o as ObjOf<K>);
    }
    return out;
  }

  childrenOf<K extends Kind>(parent: string, kind: K): ObjOf<K>[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.childrenRef(parent, kind));
    const baseList = this.base.childrenRef(parent, kind);
    const out: ObjOf<K>[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (!this.overlay.has(o.id)) out.push(this.wrapOut(o));
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === kind && 'parent' in o && o.parent === parent) out.push(this.wrapOut(o as ObjOf<K>));
    }
    return out;
  }

  childrenRef<K extends Kind>(parent: string, kind: K): readonly ObjOf<K>[] {
    if (this.overlay.size === 0) return this.base.childrenRef(parent, kind);
    const baseList = this.base.childrenRef(parent, kind);
    const out: ObjOf<K>[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (!this.overlay.has(o.id)) out.push(o);
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === kind && 'parent' in o && o.parent === parent) out.push(o as ObjOf<K>);
    }
    return out;
  }

  allChildrenOf(parent: string): Obj[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.allChildrenOf(parent));
    const baseList = this.base.allChildrenOf(parent);
    const out: Obj[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const o = baseList[i]!;
      if (!this.overlay.has(o.id)) out.push(this.wrapOut(o));
    }
    for (const o of this.overlayVals()) {
      if (o && 'parent' in o && o.parent === parent) out.push(this.wrapOut(o));
    }
    return out;
  }

  columnsOf(tableId: string): Column[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.columnsRef(tableId));
    let overlayTouchesCol = false;
    for (const [id, o] of this.overlay) {
      if (o?.kind === 'column' && o.parent === tableId) {
        overlayTouchesCol = true;
        break;
      }
      // 也检查从 base 里被删除或移走的列
      const prev = this.base.childrenRef(tableId, 'column').some((c) => c.id === id);
      if (prev) {
        overlayTouchesCol = true;
        break;
      }
    }
    if (!overlayTouchesCol) return this.wrapList(this.base.columnsRef(tableId));
    return this.childrenOf(tableId, 'column').sort(cmpColumns);
  }

  columnsRef(tableId: string): readonly Column[] {
    if (this.overlay.size === 0) return this.base.columnsRef(tableId);
    return this.childrenRef(tableId, 'column').slice().sort(cmpColumns);
  }

  partitionsOf(parentId: string): Table[] {
    if (this.overlay.size === 0) return this.wrapList(this.base.partitionsRef(parentId));
    const baseList = this.base.partitionsRef(parentId);
    const out: Table[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const t = baseList[i]!;
      if (!this.overlay.has(t.id)) out.push(this.wrapOut(t));
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === 'table' && o.partitionOf?.parent === parentId) out.push(this.wrapOut(o));
    }
    return out;
  }

  partitionsRef(parentId: string): readonly Table[] {
    if (this.overlay.size === 0) return this.base.partitionsRef(parentId);
    const baseList = this.base.partitionsRef(parentId);
    const out: Table[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const t = baseList[i]!;
      if (!this.overlay.has(t.id)) out.push(t);
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === 'table' && o.partitionOf?.parent === parentId) out.push(o);
    }
    return out;
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
    if (this.overlay.size === 0) return this.wrapList(this.base.sequencesOwnedBy(colId));
    const baseList = this.base.sequencesOwnedBy(colId);
    const out: Sequence[] = [];
    for (let i = 0; i < baseList.length; i++) {
      const s = baseList[i]!;
      if (!this.overlay.has(s.id)) out.push(this.wrapOut(s));
    }
    for (const o of this.overlayVals()) {
      if (o && o.kind === 'sequence' && o.ownedBy === colId) out.push(this.wrapOut(o));
    }
    return out;
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
    for (const ownerId of baseOwners) {
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
    for (const ownerId of baseOwners) {
      if (ownerId !== self && !this.overlay.has(ownerId)) return true;
    }
    return false;
  }

  isPgConTaken(tableId: string, name: string, self: string): boolean {
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
