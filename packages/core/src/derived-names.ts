// 推导名引擎：各方言 refreshDerivedNames 的公共部分（Issue #164）。
//
// 语义（稳定推导名）：推导名对象（约束、索引、PG NOT NULL / IDENTITY / 归属序列名、MSSQL 带名 DEFAULT）
// 只有在下面三种情况下才重算名字，否则保留现有名字：
// 1. 自身的命名输入变了：当前名字不再是"它自己命名序列里的某个候选名"（改表名、改被引用列名、
//    改 CHECK 表达式、分区拓扑变化、刚新建还没有名字、resetKeyName 清空名字等）；
// 2. 当前名字与别的对象撞名（同一命名空间里还有其他占用者）；
// 3. 对象不再需要推导名（例如 MSSQL 列去掉默认值后清理遗留的推导 DEFAULT 名）。
// 需要重算的槽位一律取命名序列里最小的空位（name、name1、name2……；MSSQL 为 _1、_2……）。
// 删除或改名腾出的名字不会让其他对象"级联下移"——旧实现每次都把整张表重算一遍并压缩后缀，
// 这正是大表上 O(N²) 以上开销的来源。
//
// 一次刷新只处理"脏"对象：
// - 普通模型（无写入跟踪）：全模型扫描一次建命名空间快照，校验全部推导名对象（这就是语义定义本身）；
// - 同步层 execute 的叠加索引（写入跟踪）：只校验输入可能变化的对象（见 name-tracker.ts），
//   命名序列的最小空位用"高水位 + 空位最小堆"维护，均摊 O(log N)；状态持久化在基线 MutableModelIndex 上
//   （见 naming-state.ts），叠加层对它的消耗在 execute 结束时撤销。
// 两条路径对同一修改序列给出逐字节相同的结果：未被标脏的对象在两种路径下都一定会保留名字。
//
// 工作量预算（DerivedNameBudget）：跟踪路径按确定性的步数计费（校验、试探、标脏），
// 超出预算抛 EditError，由同步层写时复制原子回滚并按 invalid 拒绝。
import { EditError } from './errors.ts';
import type { Dialect, Model, Obj } from './ir.ts';
import type { Token } from './plan-types.ts';

// ───── 计数（复杂度守卫测试用，不依赖墙钟） ─────

export interface DerivedNameStats {
  /** 普通模型路径的全量校验次数 */
  plainPasses: number;
  /** 跟踪路径的增量刷新次数 */
  passes: number;
  /** 校验单个推导名槽位的次数 */
  validations: number;
  /** 需要重新选名的槽位数 */
  recomputes: number;
  /** 候选名试探次数（每次查询命名空间） */
  probes: number;
  /** 写入事件标脏次数 */
  marks: number;
  /** 推导名计算里对表达式做词法分析的次数（缓存未命中） */
  exprLexes: number;
  /** 基线命名状态的全量构建次数 */
  stateBuilds: number;
}

export const derivedNameStats: DerivedNameStats = {
  plainPasses: 0,
  passes: 0,
  validations: 0,
  recomputes: 0,
  probes: 0,
  marks: 0,
  exprLexes: 0,
  stateBuilds: 0,
};

export const resetDerivedNameStats = (): void => {
  for (const k of Object.keys(derivedNameStats) as (keyof DerivedNameStats)[]) derivedNameStats[k] = 0;
};

// ───── 工作量预算 ─────

/**
 * 一次修改（WS 单条修改、粘贴、batch、客户端乐观执行）或一次 MCP apply_changes 预演允许的推导名工作量步数
 * （校验一个槽位、试探一个候选名、标脏一个对象各计 1 步）。客户端与服务端共用。
 * 标定见 .agents/docs/05-implementation.md 4.32：病态的 renameTable / renameColumn 循环在 1 s 内被中止，
 * 正常的大规模编辑（粘贴上万个子操作、在万条 CHECK 的表上逐条加约束）远低于这个数。
 */
export const DERIVED_NAME_WORK_BUDGET = 200_000;

export class DerivedNameBudget {
  used = 0;
  readonly limit: number;
  constructor(limit: number = DERIVED_NAME_WORK_BUDGET) {
    this.limit = limit;
  }
}

export class DerivedNameBudgetError extends EditError {}

let activeBudget: DerivedNameBudget | null = null;

/** 在 fn 执行期间按 budget 计费（可嵌套，内层覆盖外层） */
export const withDerivedNameBudget = <T>(budget: DerivedNameBudget, fn: () => T): T => {
  const prev = activeBudget;
  activeBudget = budget;
  try {
    return fn();
  } finally {
    activeBudget = prev;
  }
};

/** 计入工作量预算（没有活动预算时只是空操作） */
export const chargeDerivedNameWork = (n: number): void => {
  const b = activeBudget;
  if (!b) return;
  b.used += n;
  if (b.used > b.limit)
    throw new DerivedNameBudgetError(
      `推导名重算工作量超出上限（${b.limit} 步）：一次操作里对大表反复改表名 / 改列名 / 调整分区，请拆成多次提交`,
    );
};

// ───── 表达式引用的列名（单趟分词 + 缓存） ─────

interface RefCacheEntry {
  refs: ReadonlySet<string>;
  cost: number;
}

// 按加权预算淘汰（每条计固定元数据开销 + 键长 + 提取列名估算），既防止海量极短表达式撑爆内存，
// 也避免固定条数上限在 >4096 条 CHECK 的大表上每趟全量失效。
const REF_CACHE_MAX_COST = 8_000_000;
const REF_CACHE_ENTRY_OVERHEAD = 128;
const refCache = new Map<string, RefCacheEntry>();
let refCacheCost = 0;

/**
 * 表达式里作为列引用出现的名字集合（PG 原样比较，其他方言转小写）。纯函数结果按表达式文本缓存（LRU，按加权成本预算淘汰），
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
    return hit.refs;
  }
  derivedNameStats.exprLexes++;
  const ci = dialect !== 'pg';
  const out = new Set<string>();
  for (const t of columnRefs(expr)) out.add(ci ? t.text.toLowerCase() : t.text);
  const cost = REF_CACHE_ENTRY_OVERHEAD + key.length + out.size * 16;
  if (cost <= REF_CACHE_MAX_COST / 4) {
    refCache.set(key, { refs: out, cost });
    refCacheCost += cost;
    while (refCacheCost > REF_CACHE_MAX_COST) {
      const oldest = refCache.entries().next().value as [string, RefCacheEntry];
      refCache.delete(oldest[0]);
      refCacheCost -= oldest[1].cost;
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

/** 与方言的 exprReferences(expr, name) 等价：refs 为 exprRefNames 的结果 */
export const refsHaveName = (dialect: Dialect, refs: ReadonlySet<string>, name: string): boolean =>
  refs.has(dialect === 'pg' ? name : name.toLowerCase());

// ───── 视图：名字占用与模型查询 ─────

/** 推导名引擎读取的状态（普通模型扫描快照 / 基线索引 / 叠加层跟踪器各自实现） */
export interface NamingView {
  /** 读之前把挂起的写入折叠进来（叠加层惰性 flush） */
  prepare?(): void;
  /** ns 里是否有 self 以外的占用者（名字已归一化） */
  hasOther(ns: string, name: string, self: string): boolean;
  /** ns 里是否有任何占用者 */
  hasAny(ns: string, name: string): boolean;
  /** 表上（已归一化）名字为 norm 的列 ID */
  columnIdByName(tableId: string, norm: string): string | undefined;
  /** 沿 partitionOf 向上的祖先表（PG） */
  ancestors(tableId: string): string[];
  /** 全部后代分区（PG） */
  descendants(tableId: string): string[];
  /** 根分区父表（非子分区返回自身） */
  rootOf(tableId: string): string;
  /** 本趟写入的对象（普通模型路径同步命名空间快照；跟踪路径由代理自动通知，为空操作） */
  written(o: Obj): void;
}

// ───── 命名序列：高水位 + 空位最小堆 ─────

/** 一个推导名槽位的选名规格 */
export interface NameSpec {
  /** 命名序列键：同一张表上同一组 (label, name1, name2, 命名空间) 共用 */
  key: string;
  /** 第 j 个候选名（j = 0 为不带后缀的名字） */
  cand: (j: number) => string;
  /** 归一化名字 */
  norm: (name: string) => string;
  /** 需要避让的命名空间 */
  ns: readonly string[];
  /** 额外的占用判定（例如 MySQL 的保留索引名 PRIMARY），参数为归一化名字 */
  extraTaken?: (norm: string) => boolean;
}

/** 命名序列键：长度前缀避免拼接歧义 */
export const nameKey = (table: string, label: string, n1: string, n2: string | null, ns: readonly string[]) =>
  `${table}\0${label}\0${n1.length}:${n1}\0${n2 === null ? '-' : `${n2.length}:${n2}`}\0${ns.join('\u0001')}`;

/** cur 是 spec 的第几个候选名（不是候选名返回 -1）；序号只出现在候选名末尾，按末尾数字反解 */
export const candIndex = (spec: NameSpec, cur: string | null | undefined): number => {
  if (!cur) return -1;
  if (spec.cand(0) === cur) return 0;
  const m = /([1-9][0-9]*)$/.exec(cur);
  if (!m) return -1;
  const j = Number(m[1]);
  if (!Number.isSafeInteger(j)) return -1;
  return spec.cand(j) === cur ? j : -1;
};

class MinHeap {
  private readonly a: number[] = [];
  private readonly has = new Set<number>();
  peek(): number | undefined {
    return this.a[0];
  }
  push(x: number) {
    if (this.has.has(x)) return;
    this.has.add(x);
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]! <= x) break;
      a[i] = a[p]!;
      i = p;
    }
    a[i] = x;
  }
  pop(): number | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= a.length) break;
        const r = l + 1;
        const c = r < a.length && a[r]! < a[l]! ? r : l;
        if (a[c]! >= last) break;
        a[i] = a[c]!;
        i = c;
      }
      a[i] = last;
    }
    this.has.delete(top);
    return top;
  }
}

/**
 * 一个命名序列的缓存。不变式：每个 j < H 的候选名要么被占用，要么在空位堆里（堆里可以有过期项，取用时再验证）。
 * 整个状态只是加速缓存：随时可以丢弃重建（H = 0、堆为空同样满足不变式）。
 */
export class SeqState {
  H = 0;
  readonly heap = new MinHeap();
  readonly norms: string[] = [];
  /** 归一化候选名 → 序号 */
  readonly idx = new Map<string, number>();
  readonly key: string;
  readonly ns: readonly string[];
  readonly extraTaken: ((norm: string) => boolean) | undefined;
  constructor(spec: NameSpec) {
    this.key = spec.key;
    this.ns = spec.ns;
    this.extraTaken = spec.extraTaken;
  }
}

/** 命名序列注册表：序列键 → 状态，以及候选名 → 用到它的序列（名字被腾出时把空位放回堆） */
export class SeqRegistry {
  readonly states = new Map<string, SeqState>();
  private readonly byCand = new Map<string, Set<SeqState>>();
  /** 叠加层执行期间被消耗（取出堆或越过高水位）的空位，execute 结束时据基线状态补回 */
  consumed: { s: SeqState; j: number }[] | null = null;

  private state(spec: NameSpec): SeqState {
    let s = this.states.get(spec.key);
    if (!s) {
      s = new SeqState(spec);
      this.states.set(spec.key, s);
    }
    return s;
  }

  private ensure(s: SeqState, spec: NameSpec, j: number) {
    while (s.norms.length <= j) {
      const norm = spec.norm(spec.cand(s.norms.length));
      s.norms.push(norm);
      if (!s.idx.has(norm)) {
        s.idx.set(norm, s.norms.length - 1);
        let set = this.byCand.get(norm);
        if (!set) {
          set = new Set();
          this.byCand.set(norm, set);
        }
        set.add(s);
      }
    }
  }

  private free(view: NamingView, s: SeqState, j: number): boolean {
    derivedNameStats.probes++;
    const norm = s.norms[j]!;
    if (s.extraTaken?.(norm)) return false;
    for (const ns of s.ns) if (view.hasAny(ns, norm)) return false;
    return true;
  }

  /** 取序列里最小的空位（调用方已释放自身旧名字）；counted 为真时计入工作量预算 */
  choose(view: NamingView, spec: NameSpec, counted: boolean): number {
    view.prepare?.();
    const s = this.state(spec);
    for (;;) {
      const top = s.heap.peek();
      if (top === undefined || top >= s.H) break;
      s.heap.pop();
      this.consumed?.push({ s, j: top });
      if (counted) chargeDerivedNameWork(1);
      if (this.free(view, s, top)) return top;
    }
    for (;;) {
      const j = s.H;
      this.ensure(s, spec, j);
      s.H = j + 1;
      this.consumed?.push({ s, j });
      if (counted) chargeDerivedNameWork(1);
      if (this.free(view, s, j)) return j;
    }
  }

  /** 预热：从高水位起越过已被占用的候选名（不计费；只在基线构建 / 校验时调用） */
  warm(view: NamingView, spec: NameSpec) {
    const s = this.state(spec);
    for (;;) {
      this.ensure(s, spec, s.H);
      if (this.free(view, s, s.H)) return;
      s.H++;
    }
  }

  /** 名字（归一化）在某个命名空间里不再有占用者：把它放回用到它的序列的空位堆 */
  noteFreed(norm: string) {
    const set = this.byCand.get(norm);
    if (!set) return;
    for (const s of set) {
      const j = s.idx.get(norm)!;
      if (j < s.H) s.heap.push(j);
    }
  }

  /** 撤销叠加层的消耗：基线状态下仍空着的位置放回堆（高水位不回退，不变式依然成立） */
  undo(baseTaken: (s: SeqState, norm: string) => boolean) {
    const list = this.consumed;
    this.consumed = null;
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const { s, j } = list[i]!;
      if (this.states.get(s.key) !== s) continue;
      if (j < s.H && !baseTaken(s, s.norms[j]!)) s.heap.push(j);
    }
  }

  /** 丢弃不在 live 里的序列（纯缓存，丢弃总是安全的） */
  sweep(live: ReadonlySet<string>) {
    for (const [key, s] of this.states) {
      if (live.has(key)) continue;
      this.states.delete(key);
      for (const norm of s.idx.keys()) {
        const set = this.byCand.get(norm);
        if (!set) continue;
        set.delete(s);
        if (set.size === 0) this.byCand.delete(norm);
      }
    }
  }
}

// ───── 方言接口 ─────

/** 一个推导名槽位 */
export interface Slot {
  /** 命名空间里的占用者 ID（对象 ID，或 列 ID#nn / #seq / #df） */
  self: string;
  /** 选名规格；null 表示这个槽位只需清理（write(null)） */
  spec: NameSpec | null;
  /** 当前名字 */
  cur: string | null | undefined;
  /** 写回名字；null 表示释放（清空名字） */
  write(name: string | null): void;
  /** 名字保留但对象上还要补写（例如 MSSQL DEFAULT 名已写进 ext、但缺 defaultNameMode）：只在需要时提供 */
  fix?(): void;
  /**
   * 名字还没写到对象上、只在命名空间里按隐式默认名占位（MSSQL 新加的 DEFAULT 尚未写进 ext）：当作新对象处理，
   * 并且在校验其他槽位之前先释放，免得这个隐式占位把已有对象挤走（隐式名截断后可能与已有名字相同）
   */
  implicit?: boolean;
}

/** 同一次刷新内共享的表级上下文缓存 */
export type TableCtxCache = Map<string, unknown>;

/** 解析不了（例如引用的列已被删除）的对象：本次跳过，保持脏 */
export const UNRESOLVED = Symbol('unresolved');

export interface DialectNaming {
  dialect: Dialect;
  /**
   * 对象的推导名槽位（约束 / 索引 / 列 / 序列；其他对象或显式命名返回空数组）。
   * m 为要读写的模型（叠加层为写时复制代理），写回只在可写上下文调用。
   */
  slotsOf(m: Model, view: NamingView, o: Obj, cache: TableCtxCache): Slot[] | typeof UNRESOLVED;
  /** CHECK 表达式引用的（已归一化）标识符 */
  checkRefs(expr: string): ReadonlySet<string>;
}

const namings = new Map<Dialect, DialectNaming>();

/** 各方言模块加载时登记（避免模型索引 ↔ 方言模块的循环依赖） */
export const registerDialectNaming = (n: DialectNaming): void => {
  namings.set(n.dialect, n);
};

export const dialectNaming = (d: Dialect): DialectNaming => {
  const n = namings.get(d);
  if (!n) throw new Error(`方言 ${d} 的推导名规格未登记`);
  return n;
};

/** 可能带推导名的对象种类 */
export const SLOT_OBJ_KINDS: ReadonlySet<string> = new Set([
  'primaryKey',
  'unique',
  'check',
  'foreignKey',
  'index',
  'column',
  'sequence',
]);

// ───── 刷新 ─────

const own = (m: Model, id: string): Obj | undefined =>
  Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;

const takenByOther = (view: NamingView, spec: NameSpec, norm: string, self: string): boolean => {
  derivedNameStats.probes++;
  if (spec.extraTaken?.(norm)) return true;
  for (const ns of spec.ns) if (view.hasOther(ns, norm, self)) return true;
  return false;
};

export interface NormalizeOpts {
  /** 跟踪路径：计入工作量预算 */
  counted: boolean;
  /** 只校验、不写回（基线索引维护脏集合用）：需要重算的对象留在返回值里 */
  readOnly?: boolean;
  /** 保留的名字：预热它所在的序列（基线构建 / 校验时） */
  warm?: boolean;
}

/**
 * 校验 ids 里对象的推导名，重算需要重算的槽位。返回仍需处理的对象：解析不了的；readOnly 时还包括需要重算的。
 */
export const normalizeSlots = (
  m: Model,
  view: NamingView,
  naming: DialectNaming,
  ids: Iterable<string>,
  reg: SeqRegistry,
  opts: NormalizeOpts,
): Set<string> => {
  const left = new Set<string>();
  const cache: TableCtxCache = new Map();
  const needy: { slot: Slot; obj: string; cur: string }[] = [];
  view.prepare?.();
  const pending: { id: string; slots: Slot[] }[] = [];
  for (const id of ids) {
    const o = own(m, id);
    if (!o || !SLOT_OBJ_KINDS.has(o.kind)) continue;
    const slots = naming.slotsOf(m, view, o, cache);
    if (slots === UNRESOLVED) {
      left.add(id);
      continue;
    }
    pending.push({ id, slots });
  }
  for (const { id, slots } of pending) {
    for (const slot of slots) {
      if (!slot.implicit) continue;
      derivedNameStats.validations++;
      if (opts.counted) chargeDerivedNameWork(1);
      if (opts.readOnly) {
        left.add(id);
        break;
      }
      slot.write(null);
      view.written(m.objects[id]!);
      needy.push({ slot, obj: id, cur: '' });
    }
  }
  for (const { id, slots } of pending) {
    if (opts.readOnly && left.has(id)) continue;
    for (const slot of slots) {
      if (slot.implicit) continue;
      derivedNameStats.validations++;
      if (opts.counted) chargeDerivedNameWork(1);
      const spec = slot.spec;
      if (
        spec &&
        candIndex(spec, slot.cur) >= 0 &&
        !takenByOther(view, spec, spec.norm(slot.cur!), slot.self)
      ) {
        if (opts.warm) reg.warm(view, spec);
        if (!slot.fix) continue;
        if (!opts.readOnly) {
          slot.fix();
          view.written(m.objects[id]!);
          continue;
        }
      }
      if (opts.readOnly) {
        left.add(id);
        break;
      }
      needy.push({ slot, obj: id, cur: slot.cur ?? '' });
    }
  }
  if (opts.readOnly || needy.length === 0) return left;
  derivedNameStats.recomputes += needy.length;
  // 先释放全部待重算槽位的旧名字（彼此不互相阻挡），再按（当前名字长度、名字、占用者）的确定顺序取最小空位，
  // 与遍历顺序无关：例如改表名后 orders_check / orders_check1 依次变成 invoices_check / invoices_check1
  for (const n of needy) {
    if (!n.slot.implicit && (n.slot.cur || !n.slot.spec)) {
      n.slot.write(null);
      view.written(m.objects[n.obj]!);
    }
  }
  needy.sort((a, b) => {
    if (a.cur.length !== b.cur.length) return a.cur.length - b.cur.length;
    if (a.cur !== b.cur) return a.cur < b.cur ? -1 : 1;
    return a.slot.self < b.slot.self ? -1 : a.slot.self > b.slot.self ? 1 : 0;
  });
  for (const n of needy) {
    const spec = n.slot.spec;
    if (!spec) continue;
    const j = reg.choose(view, spec, opts.counted);
    n.slot.write(spec.cand(j));
    view.written(m.objects[n.obj]!);
  }
  return left;
};

// ───── 方言共用的小工具 ─────

/** 列名（列不存在时为 undefined） */
export const colNameOf = (m: Model, id: string): string | undefined => {
  const c = Object.hasOwn(m.objects, id) ? m.objects[id] : undefined;
  return c?.kind === 'column' ? c.name : undefined;
};

/**
 * 表达式恰好引用表上一列时取它的列名，否则 null（root 为分区家族根表，PG 子分区沿用根表的列）。
 * 与原先"逐列 exprReferences 后恰好一列"等价，但只按表达式里出现的标识符查列，与表的列数无关。
 */
export const singleRefColumn = (
  m: Model,
  view: NamingView,
  root: string,
  refs: ReadonlySet<string>,
): string | null => {
  let found: string | null = null;
  for (const r of refs) {
    const id = view.columnIdByName(root, r);
    if (id === undefined) continue;
    if (found !== null) return null;
    found = colNameOf(m, id) ?? null;
  }
  return found;
};

/** 约束 / 索引的推导名槽位（名字就在对象的 name 上） */
export const keySlot = (o: { id: string; name: string }, spec: NameSpec): Slot => ({
  self: o.id,
  spec,
  cur: o.name,
  write: (n) => {
    o.name = n ?? '';
  },
});

/** 一组列的列名（有列不存在时返回 null） */
export const colNamesOf = (m: Model, ids: readonly string[]): string[] | null => {
  const out: string[] = [];
  for (const id of ids) {
    const n = colNameOf(m, id);
    if (n === undefined) return null;
    out.push(n);
  }
  return out;
};

/** 索引元素与 INCLUDE 引用的列都还存在（indexElementNames 才能算） */
export const indexColsResolved = (
  m: Model,
  o: { elements: readonly { column: string | null }[]; include: readonly string[] },
): boolean =>
  o.elements.every((e) => !e.column || colNameOf(m, e.column) !== undefined) &&
  o.include.every((c) => colNameOf(m, c) !== undefined);

/**
 * 推导名槽位归属的表：刷新按表进行（refreshDerivedNames(m, table) 只处理这张表的槽位，与原实现一致）。
 * 约束 / 索引 / 列归属父表；PG 归属序列归属它所属列的表；其他对象为 null。
 */
export const slotTableOf = (lookup: (id: string) => Obj | undefined, o: Obj): string | null => {
  switch (o.kind) {
    case 'primaryKey':
    case 'unique':
    case 'check':
    case 'foreignKey':
    case 'index':
    case 'column':
      return o.parent;
    case 'sequence': {
      if (!o.ownedBy) return null;
      const c = lookup(o.ownedBy);
      return c?.kind === 'column' ? c.parent : null;
    }
    default:
      return null;
  }
};

/** 按表分组的脏对象集合 */
export class DirtyByTable {
  readonly byTable = new Map<string, Set<string>>();
  add(table: string, id: string) {
    let set = this.byTable.get(table);
    if (!set) {
      set = new Set();
      this.byTable.set(table, set);
    }
    set.add(id);
  }
  /** 取出一张表的脏对象（从集合里移除） */
  take(table: string): Set<string> | undefined {
    const set = this.byTable.get(table);
    this.byTable.delete(table);
    return set;
  }
  ids(): string[] {
    const out: string[] = [];
    for (const set of this.byTable.values()) for (const id of set) out.push(id);
    return out;
  }
  get size(): number {
    let n = 0;
    for (const set of this.byTable.values()) n += set.size;
    return n;
  }
  clear() {
    this.byTable.clear();
  }
  copyFrom(other: DirtyByTable) {
    for (const [t, set] of other.byTable) this.byTable.set(t, new Set(set));
  }
}
