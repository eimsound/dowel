// 推导名引擎：各方言 refreshDerivedNames 的公共部分（Issue #164）。
//
// 语义与原实现逐条一致：一趟按固定顺序处理表上每个推导名对象，每个对象取它命名序列里
// 第一个未被"其他对象"占用的名字（name、name1、name2……）。原实现每次修改都对整张表做一趟，
// 且每个对象从 0 号后缀逐个试探、每次试探扫描整个命名空间、CHECK 表达式按列反复分词，
// 在同一张表上逐条加 N 条 CHECK 的总开销接近 O(N³)～O(N⁴)。这里：
// 1. 表达式只分词一次（按表达式文本缓存），与列名集合求交；
// 2. 名字是否占用走命名空间哈希表（O(1)），见 naming-ns.ts；
// 3. 每个命名序列维护"游标"：游标之前的候选名都已被占用，试探从游标开始，均摊 O(1)；
// 4. 写时复制叠加索引（同步层 execute）里跟踪每次写入：表处于"已认证稳定"状态（再做一趟也不会改任何名字）
//    且只有一个对象新增 / 变化时，只为这个对象算名字（快路径）；其余情况（删除或改名腾出了更小的后缀、
//    改列名、改表名等）回退到完整一趟，保证结果与原实现完全相同。
import type { Dialect, Model, Obj } from './ir.ts';
import type { NsEntry } from './naming-ns.ts';
import type { Token } from './plan-types.ts';

// ───── 计数（复杂度守卫测试用，不依赖墙钟） ─────

export interface DerivedNameStats {
  /** 完整一趟的次数 */
  fullPasses: number;
  /** 走快路径的次数 */
  fastPaths: number;
  /** 为单个对象选名的次数 */
  slotVisits: number;
  /** 候选名试探次数（每次查询命名空间） */
  probes: number;
  /** 推导名计算里对表达式做词法分析的次数（缓存未命中） */
  exprLexes: number;
}

export const derivedNameStats: DerivedNameStats = {
  fullPasses: 0,
  fastPaths: 0,
  slotVisits: 0,
  probes: 0,
  exprLexes: 0,
};

export const resetDerivedNameStats = (): void => {
  derivedNameStats.fullPasses = 0;
  derivedNameStats.fastPaths = 0;
  derivedNameStats.slotVisits = 0;
  derivedNameStats.probes = 0;
  derivedNameStats.exprLexes = 0;
};

// ───── 表达式引用的列名（单趟分词 + 缓存） ─────

const REF_CACHE_MAX_ENTRIES = 4096;
const REF_CACHE_MAX_CHARS = 8_000_000;
const refCache = new Map<string, ReadonlySet<string>>();
let refCacheChars = 0;

/**
 * 表达式里作为列引用出现的名字集合（PG 原样比较，其他方言转小写）。纯函数结果按表达式文本缓存（LRU，有总长上限），
 * 与模型状态无关，不会脏。
 */
export const exprRefNames = (
  dialect: Dialect,
  expr: string,
  columnRefs: (expr: string) => Token[],
): ReadonlySet<string> => {
  const key = `${dialect}\0${expr}`;
  const hit = refCache.get(key);
  if (hit) {
    refCache.delete(key);
    refCache.set(key, hit);
    return hit;
  }
  derivedNameStats.exprLexes++;
  const ci = dialect !== 'pg';
  const out = new Set<string>();
  for (const t of columnRefs(expr)) out.add(ci ? t.text.toLowerCase() : t.text);
  if (key.length <= REF_CACHE_MAX_CHARS / 4) {
    refCache.set(key, out);
    refCacheChars += key.length;
    while (refCache.size > REF_CACHE_MAX_ENTRIES || refCacheChars > REF_CACHE_MAX_CHARS) {
      const oldest = refCache.keys().next().value as string;
      refCache.delete(oldest);
      refCacheChars -= oldest.length;
    }
  }
  return out;
};

/**
 * 等价于 `cols.filter((c) => exprReferences(expr, c.name))` 后"恰好一列时取它的列名，否则 null"，
 * 但表达式只分词一次。
 */
export const singleReferencedColumn = (
  dialect: Dialect,
  refs: ReadonlySet<string>,
  colNames: readonly string[],
): string | null => {
  const ci = dialect !== 'pg';
  let found: string | null = null;
  for (const n of colNames) {
    if (!refs.has(ci ? n.toLowerCase() : n)) continue;
    if (found !== null) return null;
    found = n;
  }
  return found;
};

// ───── 命名空间视图 ─────

/** 名字占用查询（名字已归一化） */
export interface NsView {
  /** 读游标前把挂起的写入折叠进来（写入跟踪器惰性 flush；腾出事件会降低游标） */
  prepare?(): void;
  /** ns 里是否有 self 以外的占用者 */
  hasOther(ns: string, name: string, self: string): boolean;
  /** ns 里是否有任何占用者 */
  hasAny(ns: string, name: string): boolean;
}

type OwnerMap = Map<string, Map<string, Set<string>>>;

const addOwner = (map: OwnerMap, ns: string, name: string, owner: string) => {
  let byName = map.get(ns);
  if (!byName) {
    byName = new Map();
    map.set(ns, byName);
  }
  let owners = byName.get(name);
  if (!owners) {
    owners = new Set();
    byName.set(name, owners);
  }
  owners.add(owner);
};

const delOwner = (map: OwnerMap, ns: string, name: string, owner: string) => {
  const byName = map.get(ns);
  const owners = byName?.get(name);
  if (!owners) return;
  owners.delete(owner);
  if (owners.size === 0) {
    byName!.delete(name);
    if (byName!.size === 0) map.delete(ns);
  }
};

/**
 * 一趟内有效的命名空间快照：开始时全模型扫描一次（只保留本趟关心的命名空间），
 * 本趟写入的对象通过 update 增量同步。用于没有写入跟踪的路径（普通模型、未跟踪的索引）。
 */
export class ScanNsView implements NsView {
  private owners: OwnerMap = new Map();
  private entriesById = new Map<string, NsEntry[]>();

  private readonly want: (ns: string) => boolean;
  private readonly entriesOf: (o: Obj, out: NsEntry[]) => void;
  private readonly onFreed: ((name: string) => void) | undefined;

  constructor(
    want: (ns: string) => boolean,
    entriesOf: (o: Obj, out: NsEntry[]) => void,
    objects: Iterable<Obj>,
    onFreed?: (name: string) => void,
  ) {
    this.want = want;
    this.entriesOf = entriesOf;
    this.onFreed = onFreed;
    for (const o of objects) this.index(o);
  }

  private collect(o: Obj): NsEntry[] {
    const raw: NsEntry[] = [];
    this.entriesOf(o, raw);
    return raw.filter((e) => this.want(e.ns));
  }

  private index(o: Obj) {
    const es = this.collect(o);
    if (es.length === 0) return;
    this.entriesById.set(o.id, es);
    for (const e of es) addOwner(this.owners, e.ns, e.name, e.owner);
  }

  /** 对象被写入后同步它的条目 */
  update(o: Obj) {
    const prev = this.entriesById.get(o.id) ?? [];
    const next = this.collect(o);
    const key = (e: NsEntry) => `${e.ns}\0${e.name}\0${e.owner}`;
    const nextKeys = new Set(next.map(key));
    const prevKeys = new Set(prev.map(key));
    for (const e of prev) if (!nextKeys.has(key(e))) delOwner(this.owners, e.ns, e.name, e.owner);
    for (const e of next) if (!prevKeys.has(key(e))) addOwner(this.owners, e.ns, e.name, e.owner);
    if (next.length) this.entriesById.set(o.id, next);
    else this.entriesById.delete(o.id);
    if (this.onFreed) {
      for (const e of prev) if (!nextKeys.has(key(e)) && !this.hasAny(e.ns, e.name)) this.onFreed(e.name);
    }
  }

  hasOther(ns: string, name: string, self: string): boolean {
    const owners = this.owners.get(ns)?.get(name);
    if (!owners) return false;
    for (const o of owners) if (o !== self) return true;
    return false;
  }

  hasAny(ns: string, name: string): boolean {
    return (this.owners.get(ns)?.get(name)?.size ?? 0) > 0;
  }
}

// ───── 命名序列游标 ─────

/** 一个推导名对象的选名规格 */
export interface NameSpec {
  /** 所属表（推导名状态按表维护） */
  table: string;
  /** 命名序列键：同一张表上同一组 (name1, name2, label, 命名空间) 共用 */
  key: string;
  /** 第 j 个候选名（j = 0 为不带后缀的名字） */
  cand: (j: number) => string;
  /** 归一化名字 */
  norm: (name: string) => string;
  /** 需要避让的命名空间 */
  ns: readonly string[];
  /** 额外的占用判定（例如 MySQL 的保留索引名 PRIMARY），参数为归一化名字 */
  extraTaken?: (norm: string) => boolean;
  /** 自身的占用者 ID（自身占用的名字不算冲突） */
  self: string;
  /** 当前名字 */
  cur: string | null | undefined;
}

/** 命名序列键：长度前缀避免拼接歧义 */
export const nameKey = (table: string, label: string, n1: string, n2: string | null, ns: readonly string[]) =>
  `${table}\0${label}\0${n1.length}:${n1}\0${n2 === null ? '-' : `${n2.length}:${n2}`}\0${ns.join('\u0001')}`;

class KeyState {
  /** 不变式：所有 j < L 的候选名都被某个对象占用 */
  L = 0;
  readonly cands: string[] = [];
  readonly norms: string[] = [];
  /** 归一化候选名 → 第一次出现的序号 */
  readonly idx = new Map<string, number>();
  /** 当前属于这个序列的推导名对象 → 序号 */
  readonly members = new Map<string, number>();
  private readonly countAt = new Map<number, number>();
  private maxIdx = -1;

  readonly table: string;
  readonly ns: readonly string[];
  readonly nsSet: ReadonlySet<string>;
  readonly extraTaken: ((norm: string) => boolean) | undefined;

  constructor(
    table: string,
    ns: readonly string[],
    nsSet: ReadonlySet<string>,
    extraTaken: ((norm: string) => boolean) | undefined,
  ) {
    this.table = table;
    this.ns = ns;
    this.nsSet = nsSet;
    this.extraTaken = extraTaken;
  }

  addMember(self: string, j: number) {
    this.members.set(self, j);
    this.countAt.set(j, (this.countAt.get(j) ?? 0) + 1);
    if (j > this.maxIdx) this.maxIdx = j;
  }

  removeMember(self: string) {
    const j = this.members.get(self);
    if (j === undefined) return;
    this.members.delete(self);
    const c = (this.countAt.get(j) ?? 1) - 1;
    if (c > 0) this.countAt.set(j, c);
    else this.countAt.delete(j);
  }

  maxMember(): number {
    while (this.maxIdx >= 0 && !this.countAt.has(this.maxIdx)) this.maxIdx--;
    return this.maxIdx;
  }
}

/**
 * 命名序列注册表：每个序列的游标与已生成候选名，以及候选名 → 序列的反查（名字被腾出时降低游标）。
 * onHarm(table)：某张表的推导名可能不再稳定（更小的后缀被腾出、名字出现重复）。
 */
export class NameRegistry {
  private readonly keys = new Map<string, KeyState>();
  private readonly byName = new Map<string, Set<KeyState>>();
  private readonly keysByTable = new Map<string, Set<string>>();
  private readonly memberKey = new Map<string, KeyState>();

  private readonly view: NsView;
  private readonly onHarm: (table: string) => void;

  constructor(view: NsView, onHarm: (table: string) => void = () => {}) {
    this.view = view;
    this.onHarm = onHarm;
  }

  private state(spec: NameSpec): KeyState {
    let ks = this.keys.get(spec.key);
    if (!ks) {
      ks = new KeyState(spec.table, spec.ns, new Set(spec.ns), spec.extraTaken);
      this.keys.set(spec.key, ks);
      let set = this.keysByTable.get(spec.table);
      if (!set) {
        set = new Set();
        this.keysByTable.set(spec.table, set);
      }
      set.add(spec.key);
    }
    return ks;
  }

  private ensure(ks: KeyState, spec: NameSpec, j: number) {
    while (ks.cands.length <= j) {
      const n = spec.cand(ks.cands.length);
      const norm = spec.norm(n);
      ks.cands.push(n);
      ks.norms.push(norm);
      if (!ks.idx.has(norm)) {
        ks.idx.set(norm, ks.cands.length - 1);
        let set = this.byName.get(norm);
        if (!set) {
          set = new Set();
          this.byName.set(norm, set);
        }
        set.add(ks);
      }
    }
  }

  private takenBy(ks: KeyState, norm: string, self: string | null): boolean {
    derivedNameStats.probes++;
    if (ks.extraTaken?.(norm)) return true;
    for (const ns of ks.ns) {
      if (self === null ? this.view.hasAny(ns, norm) : this.view.hasOther(ns, norm, self)) return true;
    }
    return false;
  }

  /** 选名（不登记归属）：返回序号与名字，结果与"从 0 号后缀逐个试探"完全相同 */
  choose(spec: NameSpec): { j: number; name: string } {
    derivedNameStats.slotVisits++;
    this.view.prepare?.();
    const ks = this.state(spec);
    // 当前名字若是本序列 L 之前的候选：更小序号都被"别人"占用（自身只占这一个名字），只需确认它本身没被别人占用
    if (spec.cur) {
      const j0 = ks.idx.get(spec.norm(spec.cur));
      if (j0 !== undefined && j0 < ks.L && !this.takenBy(ks, ks.norms[j0]!, spec.self)) {
        return { j: j0, name: ks.cands[j0]! };
      }
    }
    // L 之前的候选都被占用（自身的名字若在其中也已排除），从 L 开始试探
    let j = ks.L;
    for (;;) {
      this.ensure(ks, spec, j);
      if (!this.takenBy(ks, ks.norms[j]!, spec.self)) break;
      j++;
    }
    ks.L = j;
    return { j, name: ks.cands[j]! };
  }

  /** 登记 self 属于 spec 的序列、序号为 j */
  commit(spec: NameSpec, j: number) {
    const ks = this.state(spec);
    const prev = this.memberKey.get(spec.self);
    if (prev) prev.removeMember(spec.self);
    ks.addMember(spec.self, j);
    this.memberKey.set(spec.self, ks);
  }

  removeMember(self: string) {
    const ks = this.memberKey.get(self);
    if (!ks) return;
    ks.removeMember(self);
    this.memberKey.delete(self);
  }

  /** 丢弃一张表的全部序列（完整一趟前重建） */
  dropTable(table: string) {
    const keys = this.keysByTable.get(table);
    if (!keys) return;
    for (const k of keys) {
      const ks = this.keys.get(k)!;
      for (const norm of ks.idx.keys()) {
        const set = this.byName.get(norm);
        if (set) {
          set.delete(ks);
          if (set.size === 0) this.byName.delete(norm);
        }
      }
      for (const self of ks.members.keys()) if (this.memberKey.get(self) === ks) this.memberKey.delete(self);
      this.keys.delete(k);
    }
    this.keysByTable.delete(table);
  }

  /** 名字（归一化）在某个命名空间里不再有占用者：降低相关序列的游标；腾出的序号之后还有成员时该表不再稳定 */
  noteFreed(norm: string) {
    const set = this.byName.get(norm);
    if (!set) return;
    for (const ks of set) {
      if (this.takenBy(ks, norm, null)) continue;
      const i = ks.idx.get(norm)!;
      if (i < ks.L) ks.L = i;
      if (ks.maxMember() > i) this.onHarm(ks.table);
    }
  }

  /** 名字在 ns 里出现了多个占用者：用到这个候选名的表不再稳定 */
  noteDup(ns: string, norm: string) {
    const set = this.byName.get(norm);
    if (!set) return;
    for (const ks of set) if (ks.nsSet.has(ns)) this.onHarm(ks.table);
  }

  /**
   * self 把名字 oldName 换掉之后，本表是否会有对象因为更小的后缀被腾出而改名（完整一趟里会被"压缩"）。
   * 只看 table 自己的序列；其他表的序列由腾出事件在之后处理。
   */
  freeingHarms(table: string, oldNorm: string, self: string): boolean {
    const set = this.byName.get(oldNorm);
    if (!set) return false;
    for (const ks of set) {
      if (ks.table !== table) continue;
      if (this.takenBy(ks, oldNorm, self)) continue;
      if (ks.maxMember() > ks.idx.get(oldNorm)!) return true;
    }
    return false;
  }
}

// ───── 每张表的稳定状态（只在跟踪写入的叠加索引里存在） ─────

export interface TableNamingState {
  /** 完整一趟后验证过：再做一趟不会改任何名字 */
  certified: boolean;
  /** 表本身、列或分区家族变了：下次必须完整一趟 */
  global: boolean;
  /** 自上次处理后新增或变化的约束 / 索引对象 */
  dirty: Set<string>;
  /** 方言缓存（表名、有效列名、命名空间列表等），global 为假时有效 */
  cache: unknown;
}

/** 写入跟踪器对推导名引擎暴露的能力（实现见 name-tracker.ts） */
export interface TrackedNaming extends NsView {
  readonly registry: NameRegistry;
  readonly states: Map<string, TableNamingState>;
  /** 正在做推导名的表：这张表上由推导名写入引起的变化不再标脏 */
  inPass: string | null;
  flush(): void;
}

// ───── 方言接口与执行器 ─────

/** 一趟中的上下文 */
export interface PassCtx {
  /** 选名并登记，返回名字（调用方负责写回对象） */
  choose(spec: NameSpec): string;
  /** 对象被本趟写入后调用（无跟踪路径需要同步命名空间快照） */
  written(o: Obj): void;
}

export interface DialectNaming {
  dialect: Dialect;
  /** 无跟踪路径：本表推导名用到的命名空间 */
  wantNs(m: Model, tableId: string): (ns: string) => boolean;
  entriesOf(m: Model): (o: Obj, out: NsEntry[]) => void;
  /** 完整一趟（遍历顺序、写入与原实现一致），返回快路径缓存 */
  fullPass(m: Model, tableId: string, ctx: PassCtx): unknown;
  /** 快路径：单个约束 / 索引对象的选名规格；返回 null 表示不支持，回退完整一趟 */
  slotSpec(m: Model, tableId: string, o: Obj, cache: unknown): NameSpec | null;
}

const SLOT_KINDS: ReadonlySet<string> = new Set(['primaryKey', 'unique', 'check', 'foreignKey', 'index']);

const plainPass = (m: Model, tableId: string, naming: DialectNaming) => {
  derivedNameStats.fullPasses++;
  let registry: NameRegistry | null = null;
  const view = new ScanNsView(naming.wantNs(m, tableId), naming.entriesOf(m), Object.values(m.objects), (n) =>
    registry?.noteFreed(n),
  );
  registry = new NameRegistry(view);
  const reg = registry;
  naming.fullPass(m, tableId, {
    choose: (spec) => {
      const r = reg.choose(spec);
      reg.commit(spec, r.j);
      return r.name;
    },
    written: (o) => view.update(o),
  });
};

const trackedFullPass = (m: Model, tableId: string, naming: DialectNaming, tr: TrackedNaming) => {
  derivedNameStats.fullPasses++;
  const reg = tr.registry;
  // 本趟中途抛错时不能留下旧的"已认证"状态
  tr.states.delete(tableId);
  reg.dropTable(tableId);
  tr.inPass = tableId;
  const records: { spec: NameSpec; j: number; name: string }[] = [];
  let cache: unknown;
  try {
    cache = naming.fullPass(m, tableId, {
      choose: (spec) => {
        const r = reg.choose(spec);
        reg.commit(spec, r.j);
        records.push({ spec, j: r.j, name: r.name });
        return r.name;
      },
      written: () => {},
    });
    tr.flush();
  } finally {
    tr.inPass = null;
  }
  // 验证不动点：每个对象在最终状态下仍会选到同一个名字，才允许之后走快路径
  let certified = true;
  for (const rec of records) {
    if (reg.choose({ ...rec.spec, cur: rec.name }).j !== rec.j) {
      certified = false;
      break;
    }
  }
  tr.states.set(tableId, { certified, global: false, dirty: new Set(), cache });
};

/** 快路径：成功返回 true；不满足条件返回 false（调用方完整一趟，此时尚未改动任何东西） */
const tryFastPath = (
  m: Model,
  tableId: string,
  naming: DialectNaming,
  tr: TrackedNaming,
  st: TableNamingState,
): boolean => {
  if (!st.certified || st.global) return false;
  // 显式命名或已删除的对象不参与推导（原实现的一趟也跳过它们），只需清掉归属；剩下至多一个推导名对象时才走快路径
  let target: Obj | null = null;
  for (const id of st.dirty) {
    const o = Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;
    if (!o) continue;
    if (!SLOT_KINDS.has(o.kind) || !('parent' in o) || o.parent !== tableId || !('nameMode' in o))
      return false;
    if (o.nameMode !== 'derived') continue;
    if (target) return false;
    target = o;
  }
  for (const id of st.dirty) {
    const o = Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;
    if (!o || !('nameMode' in o) || o.nameMode !== 'derived') tr.registry.removeMember(id);
  }
  // 之后若回退完整一趟，状态会整体重建，这里清掉脏标记不影响正确性
  st.dirty.clear();
  if (!target || !('nameMode' in target)) {
    derivedNameStats.fastPaths++;
    return true;
  }
  const o = target;
  const spec = naming.slotSpec(m, tableId, o, st.cache);
  if (!spec) return false;
  const r = tr.registry.choose(spec);
  // 换掉旧名字会让本表另一个对象在完整一趟里改用更小的后缀：快路径无法复现遍历顺序，回退
  if (o.name && o.name !== r.name && tr.registry.freeingHarms(tableId, spec.norm(o.name), spec.self))
    return false;
  tr.inPass = tableId;
  try {
    o.name = r.name;
    tr.registry.commit(spec, r.j);
    tr.flush();
  } finally {
    tr.inPass = null;
  }
  derivedNameStats.fastPaths++;
  return true;
};

/** 执行一次推导名刷新：tracked 为写入跟踪器（只在同步层叠加索引里提供） */
export const runDerivedNames = (
  m: Model,
  tableId: string,
  naming: DialectNaming,
  tracked: TrackedNaming | undefined,
): void => {
  if (!tracked) {
    plainPass(m, tableId, naming);
    return;
  }
  tracked.flush();
  const st = tracked.states.get(tableId);
  if (st && tryFastPath(m, tableId, naming, tracked, st)) return;
  trackedFullPass(m, tableId, naming, tracked);
};

/** 与方言的 exprReferences(expr, name) 等价：refs 为 exprRefNames 的结果 */
export const refsHaveName = (dialect: Dialect, refs: ReadonlySet<string>, name: string): boolean =>
  refs.has(dialect === 'pg' ? name : name.toLowerCase());
