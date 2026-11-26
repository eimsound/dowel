import {
  CANVAS_HISTORY_SESSION_OP,
  type CanvasHistoryEntry,
  type CanvasHistoryList,
  type CanvasHistoryVersionRef,
} from '@dowel/api';
import type { Model, Obj } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Commit } from '@dowel/sync';
import { HTTPException } from 'hono/http-exception';

import { inList } from '../db.ts';
import { atOf } from '../time.ts';
import { countOps, HistoryGrouper, type HistoryMetaRow, parseCommitTime } from './history-grouping.ts';
import type { RoomKernel } from './kernel.ts';

const HISTORY_SUMMARY_LIMIT = 5;
/** 归组视图按元数据列超量预取的批大小 */
const GROUP_SCAN_BATCH = 500;

type RawMetaRow = {
  seq: string | number;
  client: string;
  user_name: string;
  op_name: string | null;
  op_summary: string | null;
  created_at: unknown;
};
type RawCommitRow = RawMetaRow & { changes: Commit['changes'] };

/** 归组用的元数据行（不含 changes） */
interface MetaRow extends HistoryMetaRow {
  userName: string;
  createdAt: unknown;
}
/** 带 changes 的完整提交行 */
interface CommitRow extends MetaRow {
  changes: Commit['changes'];
}

const toMetaRow = (r: RawMetaRow): MetaRow => ({
  seq: Number(r.seq),
  client: r.client,
  userName: r.user_name,
  opName: r.op_name,
  opSummary: r.op_summary,
  atMs: parseCommitTime(r.created_at),
  createdAt: r.created_at,
});
const toCommitRow = (r: RawCommitRow): CommitRow => ({ ...toMetaRow(r), changes: r.changes });

interface EntryContext {
  currentSeq: number;
  versions: Map<number, CanvasHistoryVersionRef>;
  prefixes: Map<string, string>;
}

const TOP_LEVEL_KINDS = new Set<Obj['kind']>(['table', 'enum', 'sequence', 'opaque', 'extension', 'schema']);

/** 按对象 ID 查对象（用于解析父表名与被删对象名） */
type ObjLookup = (id: string) => Obj | undefined;

const objectLabel = (obj: Obj, lookup: ObjLookup): string => {
  if ('parent' in obj && !TOP_LEVEL_KINDS.has(obj.kind)) {
    const parent = lookup(obj.parent);
    if (parent) return `${parent.name}.${obj.name}`;
  }
  return obj.name;
};

const summarizeChanges = (changes: Commit['changes'], lookup: ObjLookup): string[] => {
  const local = new Map<string, Obj>();
  for (const ch of changes) if (ch.obj) local.set(ch.id, ch.obj);
  const withLocal: ObjLookup = (id) => local.get(id) ?? lookup(id);

  const top: string[] = [];
  const sub: string[] = [];
  const seen = new Set<string>();
  const push = (bucket: string[], label: string | undefined) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    bucket.push(label);
  };

  for (const ch of changes) {
    if (ch.obj) {
      if (ch.obj.kind === 'schema' && ch.obj.name === 'public' && changes.length > 1) continue;
      const label = objectLabel(ch.obj, withLocal);
      push(TOP_LEVEL_KINDS.has(ch.obj.kind) ? top : sub, label);
    } else {
      const known = lookup(ch.id);
      push(sub, known ? objectLabel(known, lookup) : undefined);
    }
  }
  return [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT);
};

/** 组内按 seqFrom → seqTo 折叠：每个对象只保留最新一条变更（顺序按首次出现） */
const foldChanges = (changesList: readonly Commit['changes'][]): Commit['changes'] => {
  const latest = new Map<string, Commit['changes'][number]>();
  for (const changes of changesList) for (const ch of changes) latest.set(ch.id, ch);
  return [...latest.values()];
};

/**
 * 解析对象名的已知对象表：按 seq 升序（从旧到新）写入各提交里的对象，再叠加当前模型（最新优先），
 * 避免旧对象名覆盖新对象名。
 */
const knownObjectsOf = (
  rowsAsc: readonly CommitRow[],
  currentObjects: Record<string, Obj> | null,
): ObjLookup => {
  const known: Record<string, Obj> = {};
  for (const row of rowsAsc) for (const ch of row.changes) if (ch.obj) known[ch.id] = ch.obj;
  if (currentObjects) Object.assign(known, currentObjects);
  return (id) => known[id];
};

const summarizeModel = (model: Model): { changeCount: number; summary: string[] } => {
  const objs = Object.values(model.objects).filter((o) => o.kind !== 'schema');
  if (!objs.length) return { changeCount: 0, summary: [] };
  const top: string[] = [];
  const sub: string[] = [];
  const seen = new Set<string>();
  const push = (bucket: string[], label: string) => {
    if (seen.has(label)) return;
    seen.add(label);
    bucket.push(label);
  };
  for (const o of objs) {
    const label = objectLabel(o, (id) => model.objects[id]);
    push(TOP_LEVEL_KINDS.has(o.kind) ? top : sub, label);
  }
  return { changeCount: objs.length, summary: [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT) };
};

/** room_commits.op_summary（MCP batch 的意图说明）→ 历史条目的 opSummary；空值不输出 */
const opSummaryField = (raw: string | null | undefined): Pick<CanvasHistoryEntry, 'opSummary'> => {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s ? { opSummary: s } : {};
};

const mcpTokenIdFromClient = (client: string): string | null => {
  if (!client.startsWith('mcp:')) return null;
  const parts = client.split(':');
  // 支持 `mcp:${userId}:${tokenId}`（也兼容 `mcp:${tokenId}`）
  return parts.length >= 3 ? parts[2] || null : parts[1] || null;
};

/** 按快照与增量提交重建任意历史 seq 的模型（调用方需已验证 seq <= 当前最新 seq） */
export async function loadModelFromSnapshot(db: Db, branchId: string, seq: number): Promise<Model | null> {
  const [snapRow] = await db.query<{ seq: string | number; model: Model }>(
    'select seq, model from room_snapshots where branch_id = $1 and seq <= $2 order by seq desc limit 1',
    [branchId, seq],
  );
  if (!snapRow) return null;
  const model = structuredClone(snapRow.model);
  const snapSeq = Number(snapRow.seq);
  if (snapSeq < seq) {
    const commits = await db.query<{ seq: string | number; changes: Commit['changes'] }>(
      'select seq, changes from room_commits where branch_id = $1 and seq > $2 and seq <= $3 order by seq',
      [branchId, snapSeq, seq],
    );
    for (const c of commits) {
      for (const ch of c.changes) {
        if (ch.obj) model.objects[ch.id] = structuredClone(ch.obj);
        else delete model.objects[ch.id];
      }
    }
  }
  return model;
}

export class CanvasHistory {
  private readonly k: RoomKernel;

  constructor(k: RoomKernel) {
    this.k = k;
  }

  /**
   * 重建任意 seq（含 0）的完整模型：从不大于 seq 的最新快照出发，按序重放后续提交。
   * seq < 0 或超过当前最新 seq 时抛 404。
   */
  async modelAt(branchId: string, seq: number): Promise<Model> {
    const snap = await this.k.readFresh(branchId, (room) => ({
      currentSeq: room.seq,
      currentModel: seq === room.seq ? structuredClone(room.model) : null,
    }));
    if (!Number.isInteger(seq) || seq < 0 || seq > snap.currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    if (snap.currentModel) return snap.currentModel;
    const model = await loadModelFromSnapshot(this.k.db, branchId, seq);
    if (!model) throw new HTTPException(404, { message: `修改记录 #${seq} 缺少可用快照` });
    return model;
  }

  private async versionsInRange(
    branchId: string,
    minSeq: number,
    maxSeq: number,
  ): Promise<Map<number, CanvasHistoryVersionRef>> {
    // 仅关联在当前画布序列上真实发布的版本，排除接手/接入恢复的版本（restored_at 非空，避免历史遗留 seq 与画布提交撞号）
    const rows = await this.k.db.query<{ id: string; seq: string | number; number: number; name: string }>(
      `select id, seq, number, name from versions
        where branch_id = $1 and seq >= $2 and seq <= $3 and restored_at is null
        order by number desc`,
      [branchId, minSeq, maxSeq],
    );
    const map = new Map<number, CanvasHistoryVersionRef>();
    for (const row of rows) {
      const s = Number(row.seq);
      if (!map.has(s)) map.set(s, { id: row.id, number: Number(row.number), name: row.name });
    }
    return map;
  }

  private async initialHistoryEntry(
    branchId: string,
    currentSeq: number,
    versions: Map<number, CanvasHistoryVersionRef>,
    modelOverride?: Model,
  ): Promise<CanvasHistoryEntry> {
    const [branch] = await this.k.db.query<{ created_at: unknown }>(
      'select created_at from branches where id = $1',
      [branchId],
    );
    let model = modelOverride;
    if (!model) {
      const [snap] = await this.k.db.query<{ model: Model }>(
        'select model from room_snapshots where branch_id = $1 and seq = 0',
        [branchId],
      );
      model = snap?.model;
    }
    const { changeCount, summary } = model ? summarizeModel(model) : { changeCount: 0, summary: [] };
    const at = branch ? atOf(branch.created_at) : new Date(0).toISOString();
    return {
      seq: 0,
      seqFrom: 0,
      stepCount: 0,
      at,
      startedAt: at,
      user: '',
      opName: 'init',
      changeCount,
      summary,
      isCurrent: currentSeq === 0,
      version: versions.get(0) ?? null,
    };
  }

  private async mcpPrefixesFor(clients: string[]): Promise<Map<string, string>> {
    const tokenIds = [
      ...new Set(clients.map(mcpTokenIdFromClient).filter((id): id is string => id !== null)),
    ];
    const prefixes = new Map<string, string>();
    if (tokenIds.length > 0) {
      const rows = await this.k.db.query<{ id: string; prefix: string }>(
        `select id, prefix from mcp_tokens where id in (${inList(tokenIds)})`,
        tokenIds,
      );
      for (const t of rows) prefixes.set(t.id, t.prefix);
    }
    return prefixes;
  }

  private mcpHistoryMeta(
    client: string,
    prefixes: Map<string, string>,
  ): Pick<CanvasHistoryEntry, 'via' | 'mcpTokenPrefix'> {
    if (!client.startsWith('mcp:')) return {};
    const tokenId = mcpTokenIdFromClient(client);
    const prefix = tokenId ? prefixes.get(tokenId) : undefined;
    return {
      via: 'mcp',
      ...(prefix ? { mcpTokenPrefix: prefix } : {}),
    };
  }

  /** 单步（或 1 步组）条目 */
  private stepEntry(row: CommitRow, lookup: ObjLookup, ctx: EntryContext): CanvasHistoryEntry {
    const at = atOf(row.createdAt);
    return {
      seq: row.seq,
      seqFrom: row.seq,
      stepCount: 1,
      at,
      startedAt: at,
      user: row.userName,
      opName: row.opName ?? 'edit',
      changeCount: row.changes.length,
      summary: summarizeChanges(row.changes, lookup),
      isCurrent: row.seq === ctx.currentSeq,
      version: ctx.versions.get(row.seq) ?? null,
      ...this.mcpHistoryMeta(row.client, ctx.prefixes),
      ...opSummaryField(row.opSummary),
    };
  }

  /**
   * 编辑会话组条目（rows 按 seq 升序）：seq / at / user / isCurrent / version 取组尾，seqFrom / startedAt 取组首；
   * changeCount 为组内折叠去重后涉及的对象数，summary 为最新对象名（最多 5 项），ops 为操作计数（最多 5 项）。
   * 只有 1 步时退化为普通单步条目（含 MCP batch、opSummary、via 等原样字段）。
   */
  private groupEntry(rows: readonly CommitRow[], lookup: ObjLookup, ctx: EntryContext): CanvasHistoryEntry {
    const head = rows[0]!;
    const tail = rows.at(-1)!;
    if (rows.length === 1) return this.stepEntry(head, lookup, ctx);
    const folded = foldChanges(rows.map((r) => r.changes));
    return {
      seq: tail.seq,
      seqFrom: head.seq,
      stepCount: rows.length,
      at: atOf(tail.createdAt),
      startedAt: atOf(head.createdAt),
      user: tail.userName,
      opName: CANVAS_HISTORY_SESSION_OP,
      changeCount: folded.length,
      summary: summarizeChanges(folded, lookup),
      isCurrent: tail.seq === ctx.currentSeq,
      version: ctx.versions.get(tail.seq) ?? null,
      ops: countOps(rows.map((r) => r.opName)),
    };
  }

  /** 读取 [from, to] 区间的完整提交行（含 changes，按 seq 升序） */
  private async commitRows(branchId: string, from: number, to: number): Promise<CommitRow[]> {
    const rows = await this.k.db.query<RawCommitRow>(
      `select seq, client, user_name, op_name, op_summary, changes, created_at
         from room_commits
        where branch_id = $1 and seq >= $2 and seq <= $3
        order by seq`,
      [branchId, from, to],
    );
    return rows.map(toCommitRow);
  }

  /**
   * 分页倒序查询画布修改历史；翻到末尾时附带 seq = 0 初始状态，并匹配已发布版本标记。
   * 默认 `grouped: true` 返回编辑会话归组视图（limit 按组计数，游标 beforeSeq 与整组边界对齐）；
   * `grouped: false` 返回逐条原始单步。
   */
  async listHistory(
    branchId: string,
    opts: { beforeSeq?: number; limit?: number; grouped?: boolean } = {},
  ): Promise<CanvasHistoryList> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    return (opts.grouped ?? true)
      ? this.listGrouped(branchId, opts.beforeSeq, limit)
      : this.listRaw(branchId, opts.beforeSeq, limit);
  }

  /** 逐条原始单步（兼容既有调用） */
  private async listRaw(
    branchId: string,
    beforeSeq: number | undefined,
    limit: number,
  ): Promise<CanvasHistoryList> {
    const needObjects = beforeSeq === undefined || beforeSeq > 0;
    const { currentSeq, currentObjects } = await this.k.readFresh(branchId, (room) => ({
      currentSeq: room.seq,
      currentObjects: needObjects ? structuredClone(room.model.objects) : null,
    }));
    if (beforeSeq !== undefined && beforeSeq <= 0) {
      return { entries: [], currentSeq, nextBeforeSeq: null, grouped: false };
    }

    const raw =
      beforeSeq !== undefined
        ? await this.k.db.query<RawCommitRow>(
            `select seq, client, user_name, op_name, op_summary, changes, created_at
               from room_commits
              where branch_id = $1 and seq < $2
              order by seq desc
              limit $3`,
            [branchId, beforeSeq, limit],
          )
        : await this.k.db.query<RawCommitRow>(
            `select seq, client, user_name, op_name, op_summary, changes, created_at
               from room_commits
              where branch_id = $1
              order by seq desc
              limit $2`,
            [branchId, limit],
          );
    const rows = raw.map(toCommitRow);

    const includeInit = rows.length < limit;
    const seqs = rows.map((row) => row.seq);
    if (includeInit) seqs.push(0);
    const [versions, prefixes] = await Promise.all([
      seqs.length
        ? this.versionsInRange(branchId, Math.min(...seqs), Math.max(...seqs))
        : Promise.resolve(new Map<number, CanvasHistoryVersionRef>()),
      this.mcpPrefixesFor(rows.map((r) => r.client)),
    ]);

    const lookup = knownObjectsOf([...rows].reverse(), currentObjects);
    const ctx: EntryContext = { currentSeq, versions, prefixes };
    const entries = rows.map((row) => this.stepEntry(row, lookup, ctx));

    if (includeInit) entries.push(await this.initialHistoryEntry(branchId, currentSeq, versions));

    const lastSeq = entries.at(-1)?.seq ?? 0;
    const nextBeforeSeq = !includeInit && lastSeq > 0 ? lastSeq : null;
    return { entries, currentSeq, nextBeforeSeq, grouped: false };
  }

  /**
   * 编辑会话归组视图：只查元数据列按 500 行一批倒序超量预取，连续段向下碰到硬断点（或读到 seq = 1）才封口切分；
   * 已封口组数达到 limit 即停止，取最上面 limit 组（丢弃多预取的更旧组）。beforeSeq 落在某连续段中间时，
   * 该组上界自然截断在 < beforeSeq（正序贪心切分与上界无关）。最后只对本页保留组的区间一次性查回 changes。
   */
  private async listGrouped(
    branchId: string,
    beforeSeq: number | undefined,
    limit: number,
  ): Promise<CanvasHistoryList> {
    const { currentSeq, currentObjects } = await this.k.readFresh(branchId, (room) => ({
      currentSeq: room.seq,
      currentObjects: structuredClone(room.model.objects),
    }));
    const upper = Math.min(beforeSeq ?? Number.POSITIVE_INFINITY, currentSeq + 1);
    if (upper <= 0) return { entries: [], currentSeq, nextBeforeSeq: null, grouped: true };

    const versions = new Map<number, CanvasHistoryVersionRef>();
    const grouper = new HistoryGrouper<MetaRow>(versions);
    let cursor = upper;
    let drained = false;
    scan: for (;;) {
      const raw = await this.k.db.query<RawMetaRow>(
        `select seq, client, user_name, op_name, op_summary, created_at
           from room_commits
          where branch_id = $1 and seq < $2
          order by seq desc
          limit $3`,
        [branchId, cursor, GROUP_SCAN_BATCH],
      );
      const batch = raw.map(toMetaRow);
      const exhausted = batch.length < GROUP_SCAN_BATCH;
      // 版本锚点先于本批行入组前合并：canLink 需要知道 prev.seq 是否为已发布版本
      const hi = batch[0]?.seq ?? 0;
      const lo = exhausted ? 0 : batch.at(-1)!.seq;
      for (const [s, v] of await this.versionsInRange(branchId, lo, hi))
        if (!versions.has(s)) versions.set(s, v);
      for (const row of batch) {
        grouper.push(row);
        if (grouper.groups.length >= limit) break scan;
      }
      if (exhausted) {
        grouper.finish();
        drained = true;
        break;
      }
      cursor = batch.at(-1)!.seq;
    }

    const kept = grouper.groups.slice(0, limit);
    const includeInit = drained && grouper.groups.length < limit;

    const entries: CanvasHistoryEntry[] = [];
    if (kept.length) {
      const minFrom = kept.at(-1)![0]!.seq;
      const maxTo = kept[0]!.at(-1)!.seq;
      const [full, prefixes] = await Promise.all([
        this.commitRows(branchId, minFrom, maxTo),
        this.mcpPrefixesFor(kept.flatMap((g) => g.map((r) => r.client))),
      ]);
      const bySeq = new Map(full.map((r) => [r.seq, r]));
      const lookup = knownObjectsOf(full, currentObjects);
      const ctx: EntryContext = { currentSeq, versions, prefixes };
      for (const g of kept) {
        const rows = g.map((m) => bySeq.get(m.seq)).filter((r): r is CommitRow => r !== undefined);
        if (rows.length) entries.push(this.groupEntry(rows, lookup, ctx));
      }
    }
    if (includeInit) entries.push(await this.initialHistoryEntry(branchId, currentSeq, versions));

    const last = entries.at(-1);
    const nextBeforeSeq = includeInit || !last ? null : last.seqFrom;
    return { entries, currentSeq, nextBeforeSeq, grouped: true };
  }

  /** 读取单条历史记录的元信息（用于详情接口；若提供 prevModel/targetModel 可精确解析被删对象名） */
  async historyEntry(
    branchId: string,
    seq: number,
    context?: { prevModel?: Model | null; targetModel?: Model; currentSeq?: number },
  ): Promise<CanvasHistoryEntry> {
    const currentSeq =
      context?.currentSeq !== undefined
        ? context.currentSeq
        : await this.k.readFresh(branchId, (room) => room.seq);
    if (!Number.isInteger(seq) || seq < 0 || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    const versions = await this.versionsInRange(branchId, seq, seq);
    if (seq === 0) {
      return this.initialHistoryEntry(branchId, currentSeq, versions, context?.targetModel);
    }
    const [row] = await this.commitRows(branchId, seq, seq);
    if (!row) throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    const prefixes = await this.mcpPrefixesFor([row.client]);
    const target = context?.targetModel?.objects;
    const prev = context?.prevModel?.objects;
    const lookup: ObjLookup = (id) => target?.[id] ?? prev?.[id];
    return this.stepEntry(row, lookup, { currentSeq, versions, prefixes });
  }

  /**
   * 区间详情（`?from=`）：只重建一次 modelAt(from - 1)，在内存中顺次重放 [from..seq] 的提交得到目标模型，
   * 并用与列表相同的汇总函数构建组条目。调用方需已校验 1 <= from <= seq <= currentSeq。
   */
  async historyRange(
    branchId: string,
    from: number,
    seq: number,
    currentSeq: number,
  ): Promise<{ entry: CanvasHistoryEntry; prevModel: Model; targetModel: Model }> {
    if (!Number.isInteger(from) || !Number.isInteger(seq) || from < 1 || from > seq || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${from}–#${seq} 不存在` });
    const prevModel = await this.modelAt(branchId, from - 1);
    const rows = await this.commitRows(branchId, from, seq);
    if (rows.length !== seq - from + 1)
      throw new HTTPException(404, { message: `修改记录 #${from}–#${seq} 不完整` });
    const targetModel = structuredClone(prevModel);
    const touched: Record<string, Obj> = {};
    for (const row of rows) {
      for (const ch of row.changes) {
        if (ch.obj) {
          targetModel.objects[ch.id] = structuredClone(ch.obj);
          touched[ch.id] = ch.obj;
        } else delete targetModel.objects[ch.id];
      }
    }
    const lookup: ObjLookup = (id) => targetModel.objects[id] ?? touched[id] ?? prevModel.objects[id];
    const [versions, prefixes] = await Promise.all([
      this.versionsInRange(branchId, seq, seq),
      this.mcpPrefixesFor(rows.map((r) => r.client)),
    ]);
    const entry = this.groupEntry(rows, lookup, { currentSeq, versions, prefixes });
    return { entry, prevModel, targetModel };
  }

  /**
   * 历史详情共用的前后模型（HTTP `GET /history/:seq` 与 MCP get_history_diff 共用）：
   * - seq = 0：初始状态，prevModel 为 null；
   * - 单步（from 省略或 from = seq，seq >= 1）与区间（1 <= from < seq）统一走 historyRange：
   *   最多重建一次 modelAt(from - 1)，在内存中顺次重放 [from..seq] 得到目标模型。
   * 只读平台库（快照与提交），绝不 flush、绝不连影子库或目标库。调用方需已校验 seq <= currentSeq（越界抛 404）。
   */
  async historyDetailModels(
    branchId: string,
    seq: number,
    from: number | undefined,
    currentSeq: number,
  ): Promise<{ entry: CanvasHistoryEntry; prevModel: Model | null; targetModel: Model }> {
    if (!Number.isInteger(seq) || seq < 0 || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    if (seq === 0) {
      const targetModel = await this.modelAt(branchId, 0);
      const entry = await this.historyEntry(branchId, 0, { prevModel: null, targetModel, currentSeq });
      return { entry, prevModel: null, targetModel };
    }
    return this.historyRange(branchId, from ?? seq, seq, currentSeq);
  }

  /**
   * 展开编辑会话组：重建一次 modelAt(from - 1) 后逐步重放，借每步前后的对象精确解析被删对象名；
   * 返回倒序单步列表（绝不含 seq = 0）。调用方需已校验 1 <= from <= seq <= currentSeq。
   */
  async historySteps(
    branchId: string,
    from: number,
    seq: number,
    currentSeq: number,
  ): Promise<CanvasHistoryEntry[]> {
    if (!Number.isInteger(from) || !Number.isInteger(seq) || from < 1 || from > seq || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${from}–#${seq} 不存在` });
    const model = await this.modelAt(branchId, from - 1);
    const rows = await this.commitRows(branchId, from, seq);
    if (rows.length !== seq - from + 1)
      throw new HTTPException(404, { message: `修改记录 #${from}–#${seq} 不完整` });
    const [versions, prefixes] = await Promise.all([
      this.versionsInRange(branchId, from, seq),
      this.mcpPrefixesFor(rows.map((r) => r.client)),
    ]);
    const ctx: EntryContext = { currentSeq, versions, prefixes };
    const steps: CanvasHistoryEntry[] = [];
    for (const row of rows) {
      const before = new Map<string, Obj | undefined>();
      for (const ch of row.changes) if (!before.has(ch.id)) before.set(ch.id, model.objects[ch.id]);
      for (const ch of row.changes) {
        if (ch.obj) model.objects[ch.id] = ch.obj;
        else delete model.objects[ch.id];
      }
      steps.push(this.stepEntry(row, (id) => model.objects[id] ?? before.get(id), ctx));
    }
    return steps.reverse();
  }
}
