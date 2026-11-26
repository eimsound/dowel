import type { CanvasHistoryEntry, CanvasHistoryList, CanvasHistoryVersionRef } from '@dowel/api';
import type { Model, Obj } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Commit } from '@dowel/sync';
import { HTTPException } from 'hono/http-exception';

import { inList } from '../db.ts';
import { atOf } from '../time.ts';
import type { RoomKernel } from './kernel.ts';

const HISTORY_SUMMARY_LIMIT = 5;

const TOP_LEVEL_KINDS = new Set<Obj['kind']>(['table', 'enum', 'sequence', 'opaque', 'extension', 'schema']);

const objectLabel = (obj: Obj, objects: Record<string, Obj>): string => {
  if ('parent' in obj && !TOP_LEVEL_KINDS.has(obj.kind)) {
    const parent = objects[obj.parent];
    if (parent) return `${parent.name}.${obj.name}`;
  }
  return obj.name;
};

const summarizeChanges = (
  changes: Commit['changes'],
  knownNames: Map<string, string>,
  fallbackObjects: Record<string, Obj>,
): string[] => {
  const localObjects: Record<string, Obj> = { ...fallbackObjects };
  for (const ch of changes) if (ch.obj) localObjects[ch.id] = ch.obj;

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
      const label = objectLabel(ch.obj, localObjects);
      push(TOP_LEVEL_KINDS.has(ch.obj.kind) ? top : sub, label);
    } else {
      const known = knownNames.get(ch.id);
      push(sub, known);
    }
  }
  return [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT);
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
    const label = objectLabel(o, model.objects);
    push(TOP_LEVEL_KINDS.has(o.kind) ? top : sub, label);
  }
  return { changeCount: objs.length, summary: [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT) };
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
    return {
      seq: 0,
      at: branch ? atOf(branch.created_at) : new Date(0).toISOString(),
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

  /** 分页倒序查询画布修改历史；翻到末尾时附带 seq = 0 初始状态，并匹配已发布版本标记 */
  async listHistory(
    branchId: string,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<CanvasHistoryList> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const beforeSeq = opts.beforeSeq;
    const needObjects = beforeSeq === undefined || beforeSeq > 0;
    const { currentSeq, currentObjects } = await this.k.readFresh(branchId, (room) => ({
      currentSeq: room.seq,
      currentObjects: needObjects ? structuredClone(room.model.objects) : null,
    }));
    if (beforeSeq !== undefined && beforeSeq <= 0) {
      return { entries: [], currentSeq, nextBeforeSeq: null };
    }

    type CommitRow = {
      seq: string | number;
      client: string;
      user_name: string;
      op_name: string | null;
      changes: Commit['changes'];
      created_at: unknown;
    };
    const rows =
      beforeSeq !== undefined
        ? await this.k.db.query<CommitRow>(
            `select seq, client, user_name, op_name, changes, created_at
               from room_commits
              where branch_id = $1 and seq < $2
              order by seq desc
              limit $3`,
            [branchId, beforeSeq, limit],
          )
        : await this.k.db.query<CommitRow>(
            `select seq, client, user_name, op_name, changes, created_at
               from room_commits
              where branch_id = $1
              order by seq desc
              limit $2`,
            [branchId, limit],
          );

    const includeInit = rows.length < limit;
    const seqs = rows.map((row) => Number(row.seq));
    if (includeInit) seqs.push(0);
    const [versions, mcpPrefixes] = await Promise.all([
      seqs.length
        ? this.versionsInRange(branchId, Math.min(...seqs), Math.max(...seqs))
        : Promise.resolve(new Map<number, CanvasHistoryVersionRef>()),
      this.mcpPrefixesFor(rows.map((r) => r.client)),
    ]);

    // 从当前模型与本页提交收集对象名，便于为删除操作解析对象名称
    const knownObjects: Record<string, Obj> = { ...(currentObjects ?? {}) };
    for (const row of rows) for (const ch of row.changes) if (ch.obj) knownObjects[ch.id] = ch.obj;
    const knownNames = new Map<string, string>();
    for (const [id, obj] of Object.entries(knownObjects)) knownNames.set(id, objectLabel(obj, knownObjects));

    const entries: CanvasHistoryEntry[] = rows.map((row) => {
      const seq = Number(row.seq);
      return {
        seq,
        at: atOf(row.created_at),
        user: row.user_name,
        opName: row.op_name ?? 'edit',
        changeCount: row.changes.length,
        summary: summarizeChanges(row.changes, knownNames, knownObjects),
        isCurrent: seq === currentSeq,
        version: versions.get(seq) ?? null,
        ...this.mcpHistoryMeta(row.client, mcpPrefixes),
      };
    });

    if (includeInit) {
      entries.push(await this.initialHistoryEntry(branchId, currentSeq, versions));
    }

    const lastSeq = entries.at(-1)?.seq ?? 0;
    const nextBeforeSeq = !includeInit && lastSeq > 0 ? lastSeq : null;
    return { entries, currentSeq, nextBeforeSeq };
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
    const [row] = await this.k.db.query<{
      seq: string | number;
      client: string;
      user_name: string;
      op_name: string | null;
      changes: Commit['changes'];
      created_at: unknown;
    }>(
      'select seq, client, user_name, op_name, changes, created_at from room_commits where branch_id = $1 and seq = $2',
      [branchId, seq],
    );
    if (!row) throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    const mcpPrefixes = await this.mcpPrefixesFor([row.client]);

    const knownObjects: Record<string, Obj> = {
      ...(context?.prevModel?.objects ?? {}),
      ...(context?.targetModel?.objects ?? {}),
    };
    const knownNames = new Map<string, string>();
    for (const [id, obj] of Object.entries(knownObjects)) knownNames.set(id, objectLabel(obj, knownObjects));
    return {
      seq,
      at: atOf(row.created_at),
      user: row.user_name,
      opName: row.op_name ?? 'edit',
      changeCount: row.changes.length,
      summary: summarizeChanges(row.changes, knownNames, knownObjects),
      isCurrent: seq === currentSeq,
      version: versions.get(seq) ?? null,
      ...this.mcpHistoryMeta(row.client, mcpPrefixes),
    };
  }
}
