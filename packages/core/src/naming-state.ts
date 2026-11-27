// 推导名引擎的持久状态（Issue #164）：挂在基线 MutableModelIndex 上，随提交（applyBatch）增量维护，
// 供同步层每次 execute 的叠加层跟踪器（name-tracker.ts）复用，使"在万条 CHECK 的表上加一条约束"、
// MCP apply_changes 的 500 步预演都只做 O(变化量) 的工作。内容：
// - 命名空间分桶：命名空间 → 归一化名字 → 占用者 → 对象 ID（条目定义见 naming-ns.ts）；
// - 倒排索引：CHECK 引用的标识符 → CHECK；列 → 名字输入用到它的 UNIQUE / FK / 索引；
// - 脏集合：输入可能变化、尚未确认名字仍然有效的对象（提交后只读校验，通常为空）；
// - 命名序列注册表：每个序列的高水位与空位最小堆（见 derived-names.ts 的 SeqRegistry）。
// 另含两条路径共用的写入事件 → 标脏规则（markChange）与普通模型路径的扫描视图（ScanView）。
import {
  type DialectNaming,
  derivedNameStats,
  dialectNaming as dialectNamingOf,
  DirtyByTable,
  type NamingView,
  normalizeSlots,
  SeqRegistry,
  SLOT_OBJ_KINDS,
  slotTableOf,
} from './derived-names.ts';
import type { Dialect, Model, Obj, Table } from './ir.ts';
import {
  colNs,
  nameEntriesOf,
  nsDependsOnTable,
  type NsEntry,
  nsNorm,
  type TableLookup,
} from './naming-ns.ts';

// ───── 快照 ─────

/** 对象里与推导名相关的部分 */
export interface Snap {
  kind: Obj['kind'];
  parent: string | null;
  /** 表 / 列名 */
  name: string | null;
  entries: NsEntry[];
  /** CHECK 引用的（已归一化）标识符 */
  refs: readonly string[];
  /** 名字输入用到的列（UNIQUE / FK 的列、索引元素列与 INCLUDE 列） */
  cols: readonly string[];
  /** 表的分区父表 */
  partitionParent: string | null;
  /** 序列的归属列 */
  ownedBy: string | null;
  /** 推导名相关字段的指纹：相同则这次写入与推导名无关 */
  fp: string;
}

const EMPTY: readonly string[] = [];

export const snapOf = (
  dialect: Dialect,
  naming: DialectNaming,
  o: Obj,
  tableOf: TableLookup,
  entries?: NsEntry[],
): Snap => {
  let es = entries;
  if (!es) {
    es = [];
    nameEntriesOf(dialect, o, tableOf, es);
  }
  let refs: readonly string[] = EMPTY;
  let cols: readonly string[] = EMPTY;
  let fp: unknown[];
  switch (o.kind) {
    case 'table':
      fp = [o.name, o.parent, o.partitionOf?.parent ?? null];
      break;
    case 'column': {
      const ms = o.ext?.mssql;
      fp = [
        o.parent,
        o.name,
        o.notNull,
        o.notNullName,
        o.notNullNameMode,
        o.identity?.sequenceName ?? null,
        o.identity?.sequenceNameMode ?? null,
        !!o.default,
        ms?.defaultName ?? null,
        ms?.defaultNameMode ?? null,
      ];
      break;
    }
    case 'primaryKey':
    case 'unique':
    case 'foreignKey':
      cols = o.kind === 'primaryKey' ? EMPTY : o.columns;
      fp = [o.parent, o.nameMode, o.name, o.columns];
      break;
    case 'check':
      refs = [...naming.checkRefs(o.expr)];
      fp = [o.parent, o.nameMode, o.name, o.expr];
      break;
    case 'index': {
      const cs: string[] = [];
      for (const e of o.elements) if (e.column) cs.push(e.column);
      for (const c of o.include) cs.push(c);
      cols = cs;
      fp = [o.parent, o.nameMode, o.name, o.elements.map((e) => [e.column, e.expr]), o.include];
      break;
    }
    case 'sequence':
      fp = [o.parent, o.nameMode, o.name, o.ownedBy];
      break;
    default:
      fp = [o.name, 'parent' in o ? o.parent : null];
      break;
  }
  return {
    kind: o.kind,
    parent: 'parent' in o ? o.parent : null,
    name: o.kind === 'table' || o.kind === 'column' ? o.name : null,
    entries: es,
    refs,
    cols,
    partitionParent: o.kind === 'table' ? (o.partitionOf?.parent ?? null) : null,
    ownedBy: o.kind === 'sequence' ? (o.ownedBy ?? null) : null,
    fp: JSON.stringify(fp),
  };
};

/** 表的命名空间条目依赖它的属性（PG / MSSQL 换 schema，MSSQL 改名）：子对象条目要重算 */
export const tableEntriesMoved = (dialect: Dialect, prev: Snap | null, next: Snap | null): boolean =>
  prev?.kind === 'table' &&
  next?.kind === 'table' &&
  nsDependsOnTable(
    dialect,
    { name: prev.name, parent: prev.parent } as Table,
    { name: next.name, parent: next.parent } as Table,
  );

// ───── 标脏规则（叠加层与基线共用） ─────

/** 标脏需要的查询（基线索引 / 叠加层跟踪器各自实现，都反映写入之后的状态） */
export interface MarkHost {
  readonly dialect: Dialect;
  mark(id: string): void;
  charge?(n: number): void;
  /** tableId 上引用标识符 norm 的 CHECK */
  refHits(tableId: string, norm: string): Iterable<string>;
  /** 名字输入用到列 colId 的约束 / 索引 */
  colUsers(colId: string): Iterable<string>;
  /** 归属列 colId 的序列 */
  ownedSeqs(colId: string): Iterable<string>;
  /** 表的全部子对象 */
  childIds(tableId: string): Iterable<string>;
  rootOf(tableId: string): string;
  descendants(tableId: string): string[];
}

const markTable = (h: MarkHost, tableId: string) => {
  for (const c of h.childIds(tableId)) {
    h.mark(c);
    for (const s of h.ownedSeqs(c)) h.mark(s);
  }
};

const markFamily = (h: MarkHost, tableId: string | null) => {
  if (!tableId) return;
  const root = h.rootOf(tableId);
  const desc = h.descendants(root);
  if (desc.length) h.charge?.(desc.length);
  markTable(h, root);
  for (const d of desc) markTable(h, d);
};

const markRefHits = (h: MarkHost, tableId: string, norm: string) => {
  for (const ck of h.refHits(tableId, norm)) {
    derivedNameStats.refScans++;
    h.mark(ck);
  }
};

/**
 * 一个对象从 prev 变成 next 之后，哪些对象的推导名输入可能变了（不含撞名，撞名由命名空间分桶检测）：
 * - 约束 / 索引 / 序列自身任何相关字段变化：它自己；
 * - 列：它自己（NOT NULL / IDENTITY / DEFAULT 名）与归属序列；列名变化（含新建、删除）时，
 *   还有引用这个名字的 CHECK（同一分区家族）与名字输入用到这列的约束 / 索引；
 * - 表：改名 / 换 schema 时表上全部推导名对象；分区归属变化时整个分区家族（约束命名空间与有效列随之变化）。
 */
export const markChange = (h: MarkHost, id: string, prev: Snap | null, next: Snap | null): void => {
  if (!prev && !next) return;
  if (prev && next && prev.kind !== next.kind) {
    markChange(h, id, prev, null);
    markChange(h, id, null, next);
    return;
  }
  if (prev && next && prev.fp === next.fp) return;
  const s = (next ?? prev)!;
  switch (s.kind) {
    case 'table':
      if (prev && next) markTable(h, id);
      if (prev?.partitionParent !== next?.partitionParent) {
        markFamily(h, id);
        markFamily(h, prev?.partitionParent ?? null);
        markFamily(h, next?.partitionParent ?? null);
      }
      return;
    case 'column': {
      if (next) h.mark(id);
      for (const q of h.ownedSeqs(id)) h.mark(q);
      if (prev?.name === next?.name && prev?.parent === next?.parent) return;
      for (const u of h.colUsers(id)) h.mark(u);
      let prevRoot: string | null = null;
      let prevNorm: string | null = null;
      let prevDesc: string[] | null = null;
      for (const snap of [prev, next]) {
        if (!snap?.name || !snap.parent) continue;
        const norm = nsNorm(h.dialect, snap.name);
        const root = h.dialect === 'pg' ? h.rootOf(snap.parent) : snap.parent;
        if (root === prevRoot && norm === prevNorm) continue;
        markRefHits(h, root, norm);
        if (h.dialect === 'pg') {
          const desc: string[] = root === prevRoot && prevDesc !== null ? prevDesc : h.descendants(root);
          prevDesc = desc;
          if (desc.length) h.charge?.(desc.length);
          for (const d of desc) markRefHits(h, d, norm);
        }
        prevRoot = root;
        prevNorm = norm;
      }
      return;
    }
    default:
      if (next && SLOT_OBJ_KINDS.has(s.kind)) h.mark(id);
  }
};

// ───── 命名空间分桶 ─────

/** 命名空间 → 归一化名字 → 占用者 → 对象 ID */
export type NsOwners = Map<string, Map<string, Map<string, string>>>;

export const addNsOwner = (map: NsOwners, e: NsEntry, root: string) => {
  let byName = map.get(e.ns);
  if (!byName) {
    byName = new Map();
    map.set(e.ns, byName);
  }
  let owners = byName.get(e.name);
  if (!owners) {
    owners = new Map();
    byName.set(e.name, owners);
  }
  owners.set(e.owner, root);
};

export const delNsOwner = (map: NsOwners, e: NsEntry) => {
  const byName = map.get(e.ns);
  const owners = byName?.get(e.name);
  if (!owners) return;
  owners.delete(e.owner);
  if (owners.size === 0) {
    byName!.delete(e.name);
    if (byName!.size === 0) map.delete(e.ns);
  }
};

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

/** 倒排索引（(表, 标识符) → CHECK、列 → 约束 / 索引） */
export class RefIndex {
  /** tableId → 归一化标识符 → CHECK ID 集合 */
  readonly refs = new Map<string, Map<string, Set<string>>>();
  readonly cols = new Map<string, Set<string>>();
  add(id: string, s: Snap) {
    if (s.parent && s.refs.length) {
      let byIdent = this.refs.get(s.parent);
      if (!byIdent) {
        byIdent = new Map();
        this.refs.set(s.parent, byIdent);
      }
      for (const r of s.refs) addSet(byIdent, r, id);
    }
    for (const c of s.cols) addSet(this.cols, c, id);
  }
  del(id: string, s: Snap) {
    if (s.parent && s.refs.length) {
      const byIdent = this.refs.get(s.parent);
      if (byIdent) {
        for (const r of s.refs) delSet(byIdent, r, id);
        if (byIdent.size === 0) this.refs.delete(s.parent);
      }
    }
    for (const c of s.cols) delSet(this.cols, c, id);
  }
  getRefs(tableId: string, norm: string): ReadonlySet<string> | undefined {
    return this.refs.get(tableId)?.get(norm);
  }
}

// ───── 基线状态 ─────

/** 基线状态读取模型索引的接口（MutableModelIndex 实现） */
export interface IndexAccess {
  model(): Model;
  getObj(id: string): Obj | undefined;
  childIds(tableId: string): Iterable<string>;
  partitionChildIds(tableId: string): Iterable<string>;
  ownedSeqIds(colId: string): Iterable<string>;
}

const SWEEP_MIN = 4096;

export class BaseNamingState implements NamingView, MarkHost {
  readonly dialect: Dialect;
  readonly owners: NsOwners = new Map();
  /** 每个对象登记的快照（移除时按登记内容删除，不依赖父表当前状态） */
  readonly snaps = new Map<string, Snap>();
  readonly refIndex = new RefIndex();
  readonly reg = new SeqRegistry();
  /** 名字可能需要重算的对象 */
  readonly dirty = new DirtyByTable();
  /** 叠加层跟踪器正在使用（同一时刻至多一个） */
  activeTracker: { finish(): void } | null = null;
  private namingReady = false;
  private liveAtSweep = 0;
  private readonly idx: IndexAccess;

  constructor(dialect: Dialect, idx: IndexAccess) {
    this.dialect = dialect;
    this.idx = idx;
  }

  private get naming(): DialectNaming {
    return dialectNamingOf(this.dialect);
  }

  readonly tableOf = (id: string): Table | undefined => {
    const o = this.idx.getObj(id);
    return o?.kind === 'table' ? o : undefined;
  };

  /** 建命名空间与倒排索引（不含推导名校验） */
  build() {
    for (const o of Object.values(this.idx.model().objects)) this.register(o);
  }

  private register(o: Obj) {
    const s = snapOf(this.dialect, this.naming, o, this.tableOf);
    this.snaps.set(o.id, s);
    for (const e of s.entries) addNsOwner(this.owners, e, o.id);
    this.refIndex.add(o.id, s);
  }

  private unregister(id: string): Snap | undefined {
    const s = this.snaps.get(id);
    if (!s) return undefined;
    this.snaps.delete(id);
    for (const e of s.entries) delNsOwner(this.owners, e);
    this.refIndex.del(id, s);
    return s;
  }

  /** 推导名状态就绪：首次调用时校验全部推导名对象（只读），名字已有效的预热所在序列 */
  ensureNaming() {
    if (this.namingReady) return;
    this.namingReady = true;
    derivedNameStats.stateBuilds++;
    const ids: string[] = [];
    for (const o of Object.values(this.idx.model().objects)) if (SLOT_OBJ_KINDS.has(o.kind)) ids.push(o.id);
    for (const id of this.validate(ids)) this.addDirty(id);
  }

  private validate(ids: Iterable<string>): Set<string> {
    return normalizeSlots(this.idx.model(), this, this.naming, ids, this.reg, {
      counted: false,
      readOnly: true,
      warm: true,
    });
  }

  /** 提交前：按登记内容移除旧条目，返回旧快照 */
  beforeBatch(changes: readonly { id: string; prev: Obj | undefined }[]): (Snap | null)[] {
    const out: (Snap | null)[] = [];
    for (const c of changes) out.push(c.prev ? (this.unregister(c.id) ?? null) : null);
    return out;
  }

  /** 提交后（模型与基础索引已切换到新状态）：登记新条目，处理腾出 / 撞名，标脏并只读校验脏对象 */
  afterBatch(
    changes: readonly { id: string; next: Obj | undefined }[],
    prevs: readonly (Snap | null)[],
    validate = true,
  ) {
    const nexts: (Snap | null)[] = [];
    for (const c of changes) {
      if (c.next) {
        this.register(c.next);
        nexts.push(this.snaps.get(c.id)!);
      } else nexts.push(null);
    }
    const ids = changes.map((c) => c.id);
    const extraPrev: (Snap | null)[] = [];
    const extraNext: (Snap | null)[] = [];
    const extraIds: string[] = [];
    // 表换 schema / MSSQL 改名：未被改写的子对象条目也要重算
    const inBatch = new Set(ids);
    for (let i = 0; i < ids.length; i++) {
      if (!tableEntriesMoved(this.dialect, prevs[i]!, nexts[i]!)) continue;
      for (const cid of this.idx.childIds(ids[i]!)) {
        if (inBatch.has(cid)) continue;
        inBatch.add(cid);
        const o = this.idx.getObj(cid);
        extraPrev.push(this.unregister(cid) ?? null);
        if (o) this.register(o);
        extraNext.push(o ? this.snaps.get(cid)! : null);
        extraIds.push(cid);
      }
    }
    const allIds = [...ids, ...extraIds];
    const allPrev = [...prevs, ...extraPrev];
    const allNext = [...nexts, ...extraNext];
    for (let i = 0; i < allIds.length; i++) this.events(allPrev[i]!, allNext[i]!);
    if (!this.namingReady) return;
    for (let i = 0; i < ids.length; i++) markChange(this, ids[i]!, prevs[i]!, nexts[i]!);
    if (validate && this.dirty.size > 0) {
      const left = this.validate(this.dirty.ids());
      this.dirty.clear();
      for (const id of left) this.addDirty(id);
    }
    this.maybeSweep();
  }

  private events(prev: Snap | null, next: Snap | null) {
    const nextKeys = new Set((next?.entries ?? []).map(entryKey));
    const prevKeys = new Set((prev?.entries ?? []).map(entryKey));
    for (const e of prev?.entries ?? []) {
      if (!nextKeys.has(entryKey(e)) && !this.hasAny(e.ns, e.name)) this.reg.noteFreed(e.name);
    }
    if (!this.namingReady) return;
    for (const e of next?.entries ?? []) {
      if (prevKeys.has(entryKey(e))) continue;
      const owners = this.owners.get(e.ns)?.get(e.name);
      if (owners && owners.size > 1) for (const root of owners.values()) this.mark(root);
    }
  }

  /** 推导名序列缓存超过存活序列数的两倍时清理一次（摊还 O(1)） */
  private maybeSweep() {
    if (this.reg.states.size <= Math.max(SWEEP_MIN, 2 * this.liveAtSweep)) return;
    const live = new Set<string>();
    const m = this.idx.model();
    const cache = new Map<string, unknown>();
    for (const o of Object.values(m.objects)) {
      if (!SLOT_OBJ_KINDS.has(o.kind)) continue;
      const slots = this.naming.slotsOf(m, this, o, cache);
      if (typeof slots === 'symbol') continue;
      for (const s of slots) if (s.spec) live.add(s.spec.key);
    }
    this.reg.sweep(live);
    this.liveAtSweep = live.size;
  }

  // ───── NamingView（基线状态） ─────

  hasOther(ns: string, name: string, self: string): boolean {
    const owners = this.owners.get(ns)?.get(name);
    if (!owners) return false;
    if (owners.size > 1) return true;
    return !owners.has(self);
  }

  hasAny(ns: string, name: string): boolean {
    return (this.owners.get(ns)?.get(name)?.size ?? 0) > 0;
  }

  columnIdByName(tableId: string, norm: string): string | undefined {
    const owners = this.owners.get(colNs(tableId))?.get(norm);
    if (!owners) return undefined;
    for (const k of owners.keys()) return k;
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

  descendants(tableId: string): string[] {
    const it = this.idx.partitionChildIds(tableId)[Symbol.iterator]();
    const first = it.next();
    if (first.done) return [];
    const out: string[] = [];
    const seen = new Set<string>([tableId]);
    const queue: string[] = [];
    const push = (c: string) => {
      if (seen.has(c)) return;
      seen.add(c);
      out.push(c);
      queue.push(c);
    };
    push(first.value);
    for (let n = it.next(); !n.done; n = it.next()) push(n.value);
    for (let head = 0; head < queue.length; head++) {
      for (const c of this.idx.partitionChildIds(queue[head]!)) push(c);
    }
    return out;
  }

  rootOf(tableId: string): string {
    const first = this.tableOf(tableId);
    if (!first?.partitionOf || !this.tableOf(first.partitionOf.parent)) return tableId;
    const seen = new Set<string>([tableId]);
    let cur = first.partitionOf.parent;
    while (!seen.has(cur)) {
      seen.add(cur);
      const t = this.tableOf(cur);
      if (!t?.partitionOf || !this.tableOf(t.partitionOf.parent)) return cur;
      cur = t.partitionOf.parent;
    }
    return cur;
  }

  written(): void {}

  // ───── MarkHost（基线状态） ─────

  mark(id: string) {
    derivedNameStats.marks++;
    this.addDirty(id);
  }

  private addDirty(id: string) {
    const o = this.idx.getObj(id);
    const t = o ? slotTableOf((x) => this.idx.getObj(x), o) : null;
    if (t) this.dirty.add(t, id);
  }

  refHits(tableId: string, norm: string): Iterable<string> {
    return this.refIndex.getRefs(tableId, norm) ?? EMPTY;
  }

  colUsers(colId: string): Iterable<string> {
    return this.refIndex.cols.get(colId) ?? EMPTY;
  }

  ownedSeqs(colId: string): Iterable<string> {
    return this.idx.ownedSeqIds(colId);
  }

  childIds(tableId: string): Iterable<string> {
    return this.idx.childIds(tableId);
  }

  /** 基线里 (ns, 名字) 是否被占用（撤销叠加层消耗时用） */
  baseTaken(ns: readonly string[], norm: string): boolean {
    for (const n of ns) if (this.hasAny(n, norm)) return true;
    return false;
  }
}

export const entryKey = (e: NsEntry): string => `${e.ns}\0${e.name}\0${e.owner}`;

// ───── 普通模型路径：扫描视图 ─────

/** 一趟内有效的全模型快照：开始时扫描一次，本趟写入的对象经 written 增量同步 */
class ScanView implements NamingView {
  private readonly owners: NsOwners = new Map();
  private readonly entriesById = new Map<string, NsEntry[]>();
  private readonly parts = new Map<string, string[]>();
  /** 每张表的推导名槽位对象 */
  readonly slotsByTable = new Map<string, string[]>();
  private readonly m: Model;
  private readonly onFreed: (norm: string) => void;
  private readonly tableOf: (id: string) => Table | undefined;

  constructor(m: Model, onFreed: (norm: string) => void) {
    this.m = m;
    this.onFreed = onFreed;
    this.tableOf = (id) => {
      const t = Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;
      return t?.kind === 'table' ? t : undefined;
    };
    for (const o of Object.values(m.objects)) {
      const es: NsEntry[] = [];
      nameEntriesOf(m.dialect, o, this.tableOf, es);
      if (es.length) this.entriesById.set(o.id, es);
      for (const e of es) addNsOwner(this.owners, e, o.id);
      const st = SLOT_OBJ_KINDS.has(o.kind)
        ? slotTableOf((x) => (Object.hasOwn(m.objects, x) ? m.objects[x] : undefined), o)
        : null;
      if (st) {
        const list = this.slotsByTable.get(st);
        if (list) list.push(o.id);
        else this.slotsByTable.set(st, [o.id]);
      }
      if (o.kind === 'table' && o.partitionOf) {
        const list = this.parts.get(o.partitionOf.parent);
        if (list) list.push(o.id);
        else this.parts.set(o.partitionOf.parent, [o.id]);
      }
    }
  }

  written(o: Obj) {
    const prev = this.entriesById.get(o.id) ?? [];
    const next: NsEntry[] = [];
    nameEntriesOf(this.m.dialect, o, this.tableOf, next);
    for (const e of prev) delNsOwner(this.owners, e);
    for (const e of next) addNsOwner(this.owners, e, o.id);
    if (next.length) this.entriesById.set(o.id, next);
    else this.entriesById.delete(o.id);
    for (const e of prev) if (!this.hasAny(e.ns, e.name)) this.onFreed(e.name);
  }

  hasOther(ns: string, name: string, self: string): boolean {
    const owners = this.owners.get(ns)?.get(name);
    if (!owners) return false;
    if (owners.size > 1) return true;
    return !owners.has(self);
  }

  hasAny(ns: string, name: string): boolean {
    return (this.owners.get(ns)?.get(name)?.size ?? 0) > 0;
  }

  columnIdByName(tableId: string, norm: string): string | undefined {
    const owners = this.owners.get(colNs(tableId))?.get(norm);
    if (!owners) return undefined;
    for (const k of owners.keys()) return k;
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

  descendants(tableId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([tableId]);
    const queue = [tableId];
    for (let head = 0; head < queue.length; head++) {
      for (const c of this.parts.get(queue[head]!) ?? []) {
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
}

/** 普通模型（无写入跟踪）的刷新：校验并修正一张表的全部推导名槽位（这就是语义定义本身） */
export const plainRefresh = (m: Model, naming: DialectNaming, tableId: string): void => {
  derivedNameStats.plainPasses++;
  const reg = new SeqRegistry();
  const view = new ScanView(m, (n) => reg.noteFreed(n));
  normalizeSlots(m, view, naming, view.slotsByTable.get(tableId) ?? [], reg, { counted: false });
};
