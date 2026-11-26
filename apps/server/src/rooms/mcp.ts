import { MCP_REF_PATTERN } from '@dowel/api';
import { EditError, type Model, MutableModelIndex, newId, type Obj, readsOf } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { type Commit, execute, type Op, type Out, type Room, type SimulateCommit } from '@dowel/sync';

import { forPeer } from './client-scope.ts';
import { loadModelFromSnapshot } from './history.ts';
import type { RoomKernel } from './kernel.ts';
import type { Loaded } from './types.ts';

/** MCP `apply_changes` 禁止调用的 mutator（如 `paste` 单 op 可包裹多达 20,000 子操作，避免绕过 MCP 100 op 批量上限） */
export const MCP_DISALLOWED_MUTATORS: ReadonlySet<string> = new Set(['paste']);

export interface ApplyMcpOpInput {
  name: string;
  args: unknown;
}

export interface ApplyMcpOpsOptions {
  userId: string;
  tokenId: string;
  user: string;
  baseSeq?: number;
  dryRun?: boolean;
  ops: ApplyMcpOpInput[];
  /**
   * 写事务提交前的回调（仅非 dryRun 且至少有 1 条提交时在同一个 DB 事务 `tx` 内调用）。
   * 适合写入必须与本次提交同生共死的记录（例如 `auditIn(tx, ...)`）；回调抛错会回滚整批提交并恢复内存房间，不广播也不触发派生刷新。
   */
  onBeforeCommit?: (
    tx: Db,
    info: { seqFrom: number; seqTo: number; committed: { index: number; seq: number }[] },
  ) => Promise<void>;
}

export interface ApplyMcpChangedItem {
  id: string;
  kind: Obj['kind'];
  name: string;
  deleted: boolean;
}

export type ApplyMcpOpsResult =
  | {
      ok: true;
      dryRun: boolean;
      baseSeq: number;
      seq: number;
      committed: { index: number; seq: number }[];
      refs: Record<string, string>;
      changed: ApplyMcpChangedItem[];
      model: Model;
    }
  | {
      ok: false;
      index?: number;
      currentSeq: number;
      code: 'base_seq_ahead' | 'conflict' | 'invalid' | 'dependency';
      message: string;
    };

/** 递归把参数里的 `$ref:<alias>` 占位符替换成整批共享的 UUIDv7（同 alias 同 ID，refs 键为去掉 `$ref:` 前缀的 alias） */
const expandMcpRefs = (value: unknown, refs: Map<string, string>): unknown => {
  if (typeof value === 'string') {
    if (!MCP_REF_PATTERN.test(value)) return value;
    const alias = value.slice(5);
    let id = refs.get(alias);
    if (!id) {
      id = newId();
      refs.set(alias, id);
    }
    return id;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandMcpRefs(v, refs));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandMcpRefs(v, refs);
    }
    return out;
  }
  return value;
};

const summarizeBatchChanges = (
  before: Model,
  after: Model,
  commits: SimulateCommit[],
): ApplyMcpChangedItem[] => {
  const firstCreated = new Map<string, Obj>();
  const touchedOrder: string[] = [];
  const seen = new Set<string>();
  for (const c of commits) {
    for (const ch of c.changes) {
      if (!seen.has(ch.id)) {
        seen.add(ch.id);
        touchedOrder.push(ch.id);
      }
      if (ch.obj && !firstCreated.has(ch.id)) {
        firstCreated.set(ch.id, ch.obj);
      }
    }
  }
  const items: ApplyMcpChangedItem[] = [];
  for (const id of touchedOrder) {
    const fin = after.objects[id];
    if (fin) {
      items.push({ id, kind: fin.kind, name: fin.name, deleted: false });
      continue;
    }
    const prev = before.objects[id] ?? firstCreated.get(id);
    if (prev) {
      items.push({ id, kind: prev.kind, name: prev.name, deleted: true });
    }
  }
  return items;
};

export class McpWriter {
  private readonly k: RoomKernel;
  private readonly notifyCommit: (branchId: string) => void;

  constructor(k: RoomKernel, notifyCommit: (branchId: string) => void) {
    this.k = k;
    this.notifyCommit = notifyCommit;
  }

  /**
   * 代表 MCP 令牌向工作副本应用一批原子操作（支持 baseSeq 冲突检测、`$ref:<alias>` 占位符与 `dryRun`）。
   * 锁顺序与 WS 提交一致：withActiveRoomLock → DB 事务（PG `branches FOR UPDATE` + catchUpFrom）→ 释放锁后广播与触发派生刷新。
   */
  async apply(branchId: string, opts: ApplyMcpOpsOptions): Promise<ApplyMcpOpsResult> {
    const client = `mcp:${opts.userId}:${opts.tokenId}`;
    const dryRun = !!opts.dryRun;
    let loadedRef: Loaded | null = null;
    let caughtUp: Commit[] = [];

    type LockValue =
      | { kind: 'err'; res: Extract<ApplyMcpOpsResult, { ok: false }> }
      | { kind: 'dry'; res: Extract<ApplyMcpOpsResult, { ok: true }> }
      | { kind: 'ok'; res: Extract<ApplyMcpOpsResult, { ok: true }>; outs: Out[] };

    const planAndSimulate = async (
      db: Db,
      r: Loaded,
    ): Promise<
      | LockValue
      | {
          builtOps: Op[];
          refs: Map<string, string>;
          sim: Extract<ReturnType<Room['simulate']>, { ok: true }>;
        }
    > => {
      const currentSeq = r.room.seq;
      const effectiveBaseSeq = opts.baseSeq ?? currentSeq;
      if (!Number.isInteger(effectiveBaseSeq) || effectiveBaseSeq < 0) {
        return {
          kind: 'err',
          res: { ok: false, currentSeq, code: 'invalid', message: `无效的 baseSeq：${opts.baseSeq}` },
        };
      }
      if (effectiveBaseSeq > currentSeq) {
        return {
          kind: 'err',
          res: {
            ok: false,
            currentSeq,
            code: 'base_seq_ahead',
            message: `baseSeq (${effectiveBaseSeq}) 超过了当前最新版本号 (${currentSeq})`,
          },
        };
      }

      const baseModel =
        effectiveBaseSeq === currentSeq
          ? structuredClone(r.room.model)
          : await loadModelFromSnapshot(db, branchId, effectiveBaseSeq);
      if (!baseModel) {
        return {
          kind: 'err',
          res: {
            ok: false,
            currentSeq,
            code: 'conflict',
            message: `历史版本 #${effectiveBaseSeq} 的快照已不可用，请基于最新 seq=${currentSeq} 重新读取后重试`,
          },
        };
      }

      const startN = r.room.processedOf(client) + 1;
      const refs = new Map<string, string>();
      const builtOps: Op[] = [];
      let batchModel = structuredClone(baseModel);
      const batchIndex = new MutableModelIndex(batchModel);
      const pendingOpNById = new Map<string, number>();

      for (let i = 0; i < opts.ops.length; i++) {
        const input = opts.ops[i]!;
        if (MCP_DISALLOWED_MUTATORS.has(input.name)) {
          return {
            kind: 'err',
            res: {
              ok: false,
              index: i,
              currentSeq,
              code: 'invalid',
              message: `MCP apply_changes 不允许使用操作：${input.name}`,
            },
          };
        }
        const n = startN + i;
        const expandedArgs = expandMcpRefs(input.args, refs);
        let execRes: ReturnType<typeof execute>;
        try {
          execRes = execute(batchModel, input.name, expandedArgs, batchIndex);
        } catch (e) {
          if (e instanceof EditError) {
            return {
              kind: 'err',
              res: { ok: false, index: i, currentSeq, code: 'invalid', message: e.message },
            };
          }
          throw e;
        }
        const readIds = new Set([
          ...readsOf(baseModel, expandedArgs),
          ...readsOf(batchModel, expandedArgs),
          ...execRes.changes.map((c) => c.id),
        ]);
        const reads: Op['reads'] = [...readIds].sort().map((id) => {
          const prevN = pendingOpNById.get(id);
          if (prevN !== undefined) return [id, `p:${client}:${prevN}`];
          if (Object.hasOwn(baseModel.objects, id)) return [id, effectiveBaseSeq];
          return [id, null];
        });
        builtOps.push({ client, n, name: input.name, args: expandedArgs, reads });

        const batch = execRes.changes.map((c) => ({
          id: c.id,
          prev: batchModel.objects[c.id],
          next: c.obj ? execRes.next.objects[c.id] : undefined,
        }));
        batchIndex.applyBatch(execRes.next, batch);
        batchModel = execRes.next;
        for (const c of execRes.changes) pendingOpNById.set(c.id, n);
      }

      const sim = r.room.simulate(client, builtOps);
      if (!sim.ok) {
        return {
          kind: 'err',
          res: {
            ok: false,
            index: sim.failedIndex,
            currentSeq,
            code: sim.code,
            message: sim.message,
          },
        };
      }
      return { builtOps, refs, sim };
    };

    let lockedValue: LockValue;
    try {
      const locked = await this.k.withActiveRoomLock(branchId, async (r): Promise<LockValue> => {
        loadedRef = r;
        caughtUp = [];
        if (dryRun) {
          const missed = r.dirty ? await this.k.reloadAndMissedLocked(branchId, r) : [];
          const fresh = this.k.db.dialect === 'pg' ? await this.k.catchUpReadOnly(branchId, r) : [];
          caughtUp = missed.length > 0 ? [...missed, ...fresh] : fresh;
          const prepared = await planAndSimulate(this.k.db, r);
          if ('kind' in prepared) return prepared;
          const { refs, sim } = prepared;
          const changed = summarizeBatchChanges(r.room.model, sim.model, sim.commits);
          return {
            kind: 'dry',
            res: {
              ok: true,
              dryRun: true,
              baseSeq: opts.baseSeq ?? r.room.seq,
              seq: sim.headSeq,
              committed: sim.commits.map((c, idx) => ({ index: idx, seq: c.seq })),
              refs: Object.fromEntries(refs),
              changed,
              model: sim.model,
            },
          };
        }

        if (r.dirty) await this.k.reloadLocked(branchId, r);
        let mutated = false;
        try {
          return await this.k.db.transaction(async (tx): Promise<LockValue> => {
            if (this.k.db.dialect === 'pg') {
              const [branch] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!branch) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.k.catchUpFrom(tx, branchId, r);
            }
            const prepared = await planAndSimulate(tx, r);
            if ('kind' in prepared) return prepared;
            const { builtOps, refs, sim } = prepared;
            const beforeModel = r.room.model;
            const store = this.k.makeStore(tx, branchId);
            mutated = true;
            const allOuts: Out[] = [];
            for (const op of builtOps) {
              const outs = await r.room.handle(client, opts.user, { t: 'op', op }, { store });
              let opCommitted = false;
              for (const o of outs) {
                if (o.msg.t === 'reject') {
                  throw new Error(`预期预检通过的操作被拒绝：${o.msg.message}`);
                }
                if (o.msg.t === 'commit') opCommitted = true;
                allOuts.push(o);
              }
              if (opCommitted) await this.k.maybeSnapshot(tx, branchId, r.room);
            }
            const committed = sim.commits.map((c, idx) => ({ index: idx, seq: c.seq }));
            if (committed.length > 0 && opts.onBeforeCommit) {
              await opts.onBeforeCommit(tx, {
                seqFrom: committed[0]!.seq,
                seqTo: committed.at(-1)!.seq,
                committed,
              });
            }
            const changed = summarizeBatchChanges(beforeModel, r.room.model, sim.commits);
            return {
              kind: 'ok',
              res: {
                ok: true,
                dryRun: false,
                baseSeq: opts.baseSeq ?? sim.baseSeq,
                seq: r.room.seq,
                committed,
                refs: Object.fromEntries(refs),
                changed,
                model: structuredClone(r.room.model),
              },
              outs: allOuts,
            };
          });
        } catch (err) {
          if (mutated) {
            r.dirty = true;
            await this.k.reloadLocked(branchId, r).catch(() => {});
          }
          throw err;
        }
      });
      loadedRef = locked.r;
      lockedValue = locked.value;
    } catch (err) {
      if (loadedRef && caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
      throw err;
    }

    if (loadedRef && caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
    if (lockedValue.kind !== 'ok') return lockedValue.res;
    for (const o of lockedValue.outs) {
      if (o.msg.t === 'commit') {
        for (const p of loadedRef.peers) this.k.safeSend(p, forPeer(p, o.msg));
      }
    }
    if (lockedValue.outs.some((o) => o.msg.t === 'commit')) {
      this.notifyCommit(branchId);
      await this.k.publish({ t: 'room.commit', branchId, seq: lockedValue.res.seq });
    }
    return lockedValue.res;
  }
}
