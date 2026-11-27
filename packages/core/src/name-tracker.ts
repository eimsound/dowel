// 写时复制叠加索引的写入跟踪：同步层 execute 的代理在每次写入时通知这里（noteWrite），
// 查询前惰性折叠（flush）成按命名空间分桶的名字占用表，使"名字是否已被占用"在叠加层上也是 O(1)，
// 并把写入翻译成推导名引擎需要的事件（名字被腾出 / 重复、表或列变化、约束 / 索引新增或变化）。
//
// 只在所有写入都经过代理时正确（execute 保证这一点：mutator 拿到的对象全是代理）。
// 表换 schema（PG / MSSQL）或改名（MSSQL）会让其子对象的条目整体变化，此时跟踪器"失效"，
// 之后的查询全部退回原有的扫描实现，结果不受影响。
import type { NameRegistry as NameRegistryType, TableNamingState, TrackedNaming } from './derived-names.ts';
import { NameRegistry } from './derived-names.ts';
import type { Dialect, Obj, Table } from './ir.ts';
import type { MutableModelIndex } from './model-index.ts';
import { nameEntriesOf, nsDependsOnTable, type NsEntry } from './naming-ns.ts';

interface Snap {
  kind: Obj['kind'];
  parent: string | null;
  entries: NsEntry[];
  /** 影响推导名输入的字段 */
  keyFp: string;
  /** 推导名输出（名字本身） */
  outFp: string;
  /** 序列归属列所在的表（PG） */
  ownerTable: string | null;
  /** 表的分区父表 */
  partitionParent: string | null;
  /** 表名（表的 schema 即 parent） */
  tableName: string | null;
}

const SLOT_KINDS: ReadonlySet<string> = new Set(['primaryKey', 'unique', 'check', 'foreignKey', 'index']);

const entryKey = (e: NsEntry) => `${e.ns}\0${e.name}\0${e.owner}`;

type OwnerMap = Map<string, Map<string, Set<string>>>;

export class OverlayNameTracker implements TrackedNaming {
  broken = false;
  inPass: string | null = null;
  readonly registry: NameRegistryType;
  readonly states = new Map<string, TableNamingState>();
  private dirty = new Set<string>();
  private flushing = false;
  private snaps = new Map<string, Snap | null>();
  /** 叠加层对象的条目（基线里同 ID 的条目被遮蔽） */
  private ov: OwnerMap = new Map();
  /** 叠加层里的分区子表：父表 → 子表 */
  private ovChildren = new Map<string, Set<string>>();

  private readonly base: MutableModelIndex;
  private readonly overlay: Map<string, Obj | undefined>;
  private readonly dialect: Dialect;

  constructor(base: MutableModelIndex, overlay: Map<string, Obj | undefined>, dialect: Dialect) {
    this.base = base;
    this.overlay = overlay;
    this.dialect = dialect;
    this.registry = new NameRegistry(this, (t) => {
      const st = this.states.get(t);
      if (st) st.certified = false;
    });
  }

  noteWrite(id: string) {
    if (!this.broken) this.dirty.add(id);
  }

  private cur(id: string): Obj | undefined {
    return this.overlay.has(id) ? this.overlay.get(id) : this.base.getObj(id);
  }

  private readonly tableOf = (id: string): Table | undefined => {
    const o = this.cur(id);
    return o?.kind === 'table' ? o : undefined;
  };

  private readonly baseTableOf = (id: string): Table | undefined => {
    const o = this.base.getObj(id);
    return o?.kind === 'table' ? o : undefined;
  };

  private snapOf(o: Obj | undefined, fromBase = false): Snap | null {
    if (!o) return null;
    const entries: NsEntry[] = [];
    nameEntriesOf(this.dialect, o, fromBase ? this.baseTableOf : this.tableOf, entries);
    let keyFp = '';
    let outFp = '';
    let ownerTable: string | null = null;
    let partitionParent: string | null = null;
    switch (o.kind) {
      case 'table':
        partitionParent = o.partitionOf?.parent ?? null;
        keyFp = JSON.stringify([o.name, o.parent, partitionParent, o.partitionBy === null]);
        break;
      case 'column': {
        const ms = o.ext?.mssql;
        keyFp = JSON.stringify([
          o.parent,
          o.name,
          o.pos,
          o.notNull,
          o.notNullNameMode,
          o.notNullNameMode === 'derived' ? null : o.notNullName,
          o.identity ? o.identity.sequenceNameMode : null,
          o.identity && o.identity.sequenceNameMode !== 'derived' ? o.identity.sequenceName : null,
          !!o.default,
          ms?.defaultNameMode ?? null,
          ms?.defaultNameMode === 'derived' ? null : (ms?.defaultName ?? null),
        ]);
        outFp = JSON.stringify([o.notNullName, o.identity?.sequenceName ?? null, ms?.defaultName ?? null]);
        break;
      }
      case 'primaryKey':
      case 'unique':
        keyFp = JSON.stringify([o.parent, o.nameMode, o.columns]);
        outFp = o.name;
        break;
      case 'foreignKey':
        keyFp = JSON.stringify([o.parent, o.nameMode, o.columns]);
        outFp = o.name;
        break;
      case 'check':
        keyFp = JSON.stringify([o.parent, o.nameMode, o.expr]);
        outFp = o.name;
        break;
      case 'index':
        keyFp = JSON.stringify([o.parent, o.nameMode, o.elements.map((e) => [e.column, e.expr]), o.include]);
        outFp = o.name;
        break;
      case 'sequence': {
        const col = o.ownedBy ? (fromBase ? this.base.getObj(o.ownedBy) : this.cur(o.ownedBy)) : undefined;
        ownerTable = col?.kind === 'column' ? col.parent : null;
        keyFp = JSON.stringify([o.parent, o.nameMode, o.ownedBy, ownerTable]);
        outFp = o.name;
        break;
      }
      default:
        break;
    }
    return {
      kind: o.kind,
      parent: 'parent' in o ? o.parent : null,
      entries,
      keyFp,
      outFp,
      ownerTable,
      partitionParent,
      tableName: o.kind === 'table' ? o.name : null,
    };
  }

  private goBroken() {
    this.broken = true;
    this.dirty.clear();
    this.snaps.clear();
    this.ov.clear();
    this.ovChildren.clear();
    this.states.clear();
  }

  // ───── 名字占用（NsView） ─────

  private hasOtherRaw(ns: string, name: string, self: string | null): boolean {
    const ov = this.ov.get(ns)?.get(name);
    if (ov) for (const o of ov) if (o !== self) return true;
    const baseOwners = this.base.nsOwnersOf(ns, name);
    if (baseOwners) {
      for (const [owner, root] of baseOwners) if (owner !== self && !this.overlay.has(root)) return true;
    }
    return false;
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

  // ───── 分区家族 ─────

  /** 当前状态下的直接子分区（基线中未被改写的 + 叠加层里的） */
  partitionChildren(parentId: string): string[] {
    this.flush();
    const out: string[] = [];
    for (const t of this.base.partitionsRef(parentId)) if (!this.overlay.has(t.id)) out.push(t.id);
    const ov = this.ovChildren.get(parentId);
    if (ov) for (const id of ov) out.push(id);
    return out;
  }

  /** 全部后代分区（广度优先，带环保护） */
  partitionDescendantIds(parentId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([parentId]);
    const queue = [parentId];
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

  private markGlobal(tableId: string | null | undefined) {
    if (!tableId) return;
    const st = this.states.get(tableId);
    if (st) st.global = true;
  }

  /** 表、祖先与后代全部标记为需要完整一趟（分区家族共享约束命名空间与有效列） */
  private markFamily(tableId: string | null | undefined) {
    if (!tableId) return;
    this.markGlobal(tableId);
    const seen = new Set<string>([tableId]);
    let cur = this.tableOf(tableId)?.partitionOf?.parent ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      this.markGlobal(cur);
      cur = this.tableOf(cur)?.partitionOf?.parent ?? null;
    }
    const queue = [tableId];
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head]!;
      const kids = new Set<string>(this.base.partitionsRef(p).map((t) => t.id));
      for (const k of this.ovChildren.get(p) ?? []) kids.add(k);
      for (const k of kids) {
        if (seen.has(k)) continue;
        seen.add(k);
        this.markGlobal(k);
        queue.push(k);
      }
    }
  }

  // ───── 折叠写入 ─────

  flush() {
    if (this.flushing || this.broken || this.dirty.size === 0) return;
    this.flushing = true;
    try {
      const ids = [...this.dirty];
      this.dirty.clear();
      const changes: { id: string; prev: Snap | null; next: Snap | null }[] = [];
      // 第一阶段：所有写入对象的条目先换成新状态，再判定腾出 / 重复（避免同批对象互相看不到）
      for (const id of ids) {
        // 基线对象的惰性旧快照按基线解析父表与序列归属列（与基线索引登记条目时一致），
        // 避免同一次 flush 窗口内 dropTable / dropColumn 先删父对象导致 prev.entries / ownerTable 缺失。
        const prev = this.snaps.has(id) ? this.snaps.get(id)! : this.snapOf(this.base.getObj(id), true);
        const next = this.snapOf(this.cur(id));
        if (prev?.kind === 'table' && next?.kind === 'table' && this.tableAttrsChanged(prev, next)) {
          this.goBroken();
          return;
        }
        if (this.snaps.has(id) && prev) for (const e of prev.entries) this.delOv(e);
        if (next) for (const e of next.entries) this.addOv(e);
        this.snaps.set(id, next);
        if (prev?.kind === 'table' && prev.partitionParent) this.delChild(prev.partitionParent, id);
        if (next?.kind === 'table' && next.partitionParent) this.addChild(next.partitionParent, id);
        if (prev && SLOT_KINDS.has(prev.kind)) {
          const o = this.cur(id);
          if (!o || !('nameMode' in o) || o.nameMode !== 'derived') this.registry.removeMember(id);
        }
        changes.push({ id, prev, next });
      }
      // 第二阶段：腾出 / 重复 与 结构事件
      for (const { id, prev, next } of changes) {
        const prevKeys = new Set((prev?.entries ?? []).map(entryKey));
        const nextKeys = new Set((next?.entries ?? []).map(entryKey));
        for (const e of next?.entries ?? []) {
          if (!prevKeys.has(entryKey(e)) && this.hasOtherRaw(e.ns, e.name, e.owner)) {
            this.registry.noteDup(e.ns, e.name);
          }
        }
        for (const e of prev?.entries ?? []) {
          if (!nextKeys.has(entryKey(e)) && !this.hasOtherRaw(e.ns, e.name, null)) {
            this.registry.noteFreed(e.name);
          }
        }
        this.classify(id, prev, next);
      }
    } finally {
      this.flushing = false;
    }
  }

  private tableAttrsChanged(prev: Snap, next: Snap): boolean {
    return nsDependsOnTable(
      this.dialect,
      { name: prev.tableName, parent: prev.parent } as Table,
      { name: next.tableName, parent: next.parent } as Table,
    );
  }

  private classify(id: string, prev: Snap | null, next: Snap | null) {
    if (!prev && !next) return;
    if (prev && next && prev.kind !== next.kind) {
      this.classify(id, prev, null);
      this.classify(id, null, next);
      return;
    }
    const kind = (next ?? prev)!.kind;
    const same = prev && next && prev.keyFp === next.keyFp;
    switch (kind) {
      case 'table':
        if (!same) {
          this.markFamily(id);
          if (prev?.partitionParent) this.markFamily(prev.partitionParent);
          if (next?.partitionParent) this.markFamily(next.partitionParent);
        }
        return;
      case 'column': {
        const table = (next ?? prev)!.parent;
        if (!same) this.markFamily(table);
        else if (prev.outFp !== next.outFp && this.inPass !== table) this.markGlobal(table);
        return;
      }
      case 'sequence': {
        if (same && prev.outFp === next.outFp) return;
        for (const t of [prev?.ownerTable, next?.ownerTable]) {
          if (t && (!same || this.inPass !== t)) this.markGlobal(t);
        }
        return;
      }
      default:
        if (!SLOT_KINDS.has(kind)) return;
        if (!next) return;
        if (same && prev.outFp === next.outFp) return;
        if (prev && prev.parent !== next.parent) {
          this.markGlobal(prev.parent);
          this.markGlobal(next.parent);
          return;
        }
        if (this.inPass !== next.parent || !same) this.states.get(next.parent!)?.dirty.add(id);
        return;
    }
  }

  private addOv(e: NsEntry) {
    let byName = this.ov.get(e.ns);
    if (!byName) {
      byName = new Map();
      this.ov.set(e.ns, byName);
    }
    let owners = byName.get(e.name);
    if (!owners) {
      owners = new Set();
      byName.set(e.name, owners);
    }
    owners.add(e.owner);
  }

  private delOv(e: NsEntry) {
    const byName = this.ov.get(e.ns);
    const owners = byName?.get(e.name);
    if (!owners) return;
    owners.delete(e.owner);
    if (owners.size === 0) {
      byName!.delete(e.name);
      if (byName!.size === 0) this.ov.delete(e.ns);
    }
  }

  private addChild(parent: string, child: string) {
    let set = this.ovChildren.get(parent);
    if (!set) {
      set = new Set();
      this.ovChildren.set(parent, set);
    }
    set.add(child);
  }

  private delChild(parent: string, child: string) {
    const set = this.ovChildren.get(parent);
    if (!set) return;
    set.delete(child);
    if (set.size === 0) this.ovChildren.delete(parent);
  }
}
