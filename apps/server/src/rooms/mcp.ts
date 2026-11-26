import { MCP_REF_PATTERN } from '@dowel/api';
import {
  BATCH_MUTATOR,
  BATCH_OPS_LIMIT,
  BATCH_SUMMARY_MAX,
  type BatchArgs,
  EditError,
  type Model,
  MutableModelIndex,
  newId,
  type Obj,
  readsOf,
  scrubSecrets,
} from '@dowel/core';
import type { Db } from '@dowel/engines';
import { type Commit, execute, type Op, type Out, type Room } from '@dowel/sync';

import { forPeer } from './client-scope.ts';
import { loadModelFromSnapshot } from './history.ts';
import type { RoomKernel } from './kernel.ts';
import type { Loaded } from './types.ts';

/**
 * MCP `apply_changes` 禁止直接调用的 mutator：
 * - `paste` 单 op 可包裹多达 20,000 子操作，会绕过 MCP 的批量上限；
 * - `batch` 由服务端把整批收敛为 1 个 op 时内部使用（ADR 0015 第 3 节），禁止 AI 嵌套调用。
 */
export const MCP_DISALLOWED_MUTATORS: ReadonlySet<string> = new Set(['paste', BATCH_MUTATOR]);

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
  /** 可选意图说明：脱敏后写入 batch 参数（room_commits.op_summary 与画布修改历史）；绝不做 `$ref` 展开 */
  summary?: string;
  /**
   * 写事务提交前的回调（仅非 dryRun 且有净变化时，在同一个 DB 事务 `tx` 内调用 1 次）。
   * 适合写入必须与本次提交同生共死的记录（例如 `auditIn(tx, ...)`）；回调抛错会回滚整批提交并恢复内存房间，不广播也不触发派生刷新。
   */
  onBeforeCommit?: (tx: Db, info: { seq: number; opCount: number }) => Promise<void>;
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
      /** 整批对应的唯一提交序号（dryRun 时为预计序号；noop 时为当前序号） */
      seq: number;
      /** 展开后的底层子操作数 */
      opCount: number;
      refs: Record<string, string>;
      changed: ApplyMcpChangedItem[];
      model: Model;
      /** 整批没有净变化：不产生提交、不记审计、不广播 */
      noop?: true;
    }
  | {
      ok: false;
      /** 出错的输入操作下标（从 0 开始） */
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

/** 意图说明：去首尾空白 → 脱敏 → 截断到上限；空串视为没有 */
const sanitizeMcpSummary = (raw: string | undefined): string | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const safe = scrubSecrets(trimmed).trim().slice(0, BATCH_SUMMARY_MAX).trim();
  return safe || undefined;
};

const summarizeNetChanges = (
  before: Model,
  after: Model,
  changes: Commit['changes'],
): ApplyMcpChangedItem[] => {
  const items: ApplyMcpChangedItem[] = [];
  for (const ch of changes) {
    const fin = after.objects[ch.id];
    if (fin) {
      items.push({ id: ch.id, kind: fin.kind, name: fin.name, deleted: false });
      continue;
    }
    const prev = Object.hasOwn(before.objects, ch.id) ? before.objects[ch.id] : undefined;
    if (prev) items.push({ id: ch.id, kind: prev.kind, name: prev.name, deleted: true });
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
   * 代表 MCP 令牌向工作副本原子应用一批操作（支持 baseSeq 冲突检测、`$ref:<alias>` 占位符与 `dryRun`）。
   * 整批收敛为 1 个 `batch` op（ADR 0015 第 3 节）：1 个 seq / 1 条 room_commits / 1 次快照判断 / 1 次 WS 广播。
   * 锁顺序与 WS 提交一致：withActiveRoomLock → DB 事务（PG `branches FOR UPDATE` + catchUpFrom）→ 释放锁后广播与触发派生刷新。
   */
  async apply(branchId: string, opts: ApplyMcpOpsOptions): Promise<ApplyMcpOpsResult> {
    const client = `mcp:${opts.userId}:${opts.tokenId}`;
    const dryRun = !!opts.dryRun;
    const safeSummary = sanitizeMcpSummary(opts.summary);
    let loadedRef: Loaded | null = null;
    let caughtUp: Commit[] = [];

    type OkRes = Extract<ApplyMcpOpsResult, { ok: true }>;
    type LockValue =
      | { kind: 'err'; res: Extract<ApplyMcpOpsResult, { ok: false }> }
      | { kind: 'dry'; res: OkRes }
      | { kind: 'ok'; res: OkRes; outs: Out[] };

    const planAndSimulate = async (
      db: Db,
      r: Loaded,
    ): Promise<
      | LockValue
      | {
          batchOp: Op;
          opCount: number;
          refs: Map<string, string>;
          sim: Extract<ReturnType<Room['simulate']>, { ok: true }>;
        }
    > => {
      const currentSeq = r.room.seq;
      const err = (
        code: Extract<ApplyMcpOpsResult, { ok: false }>['code'],
        message: string,
        index?: number,
      ): LockValue => ({
        kind: 'err',
        res: { ok: false, ...(index !== undefined ? { index } : {}), currentSeq, code, message },
      });
      const effectiveBaseSeq = opts.baseSeq ?? currentSeq;
      if (!Number.isInteger(effectiveBaseSeq) || effectiveBaseSeq < 0) {
        return err('invalid', `无效的 baseSeq：${opts.baseSeq}`);
      }
      if (effectiveBaseSeq > currentSeq) {
        return err('base_seq_ahead', `baseSeq (${effectiveBaseSeq}) 超过了当前最新版本号 (${currentSeq})`);
      }

      const baseModel =
        effectiveBaseSeq === currentSeq
          ? structuredClone(r.room.model)
          : await loadModelFromSnapshot(db, branchId, effectiveBaseSeq);
      if (!baseModel) {
        return err(
          'conflict',
          `历史版本 #${effectiveBaseSeq} 的快照已不可用，请基于最新 seq=${currentSeq} 重新读取后重试`,
        );
      }

      // 在 baseModel 副本上逐步预演每个子操作：校验参数、展开 `$ref`，并收集每一步的外部依据
      // （本批新建的对象不是外部依据；既有对象以 baseSeq 为依据版本，本批首次新建的对象要求当前仍不存在）
      const refs = new Map<string, string>();
      const expandedOps: BatchArgs['ops'] = [];
      /** 展开后子操作下标 → 输入操作下标（目前一一对应；复合宏展开后多对一） */
      const inputIndexOf: number[] = [];
      const merged = new Map<string, number | null>();
      const firstReadStep = new Map<string, number>();
      const createdInBatch = new Set<string>();
      let batchModel = structuredClone(baseModel);
      const batchIndex = new MutableModelIndex(batchModel);

      for (let i = 0; i < opts.ops.length; i++) {
        const input = opts.ops[i]!;
        if (MCP_DISALLOWED_MUTATORS.has(input.name)) {
          return err('invalid', `MCP apply_changes 不允许使用操作：${input.name}`, i);
        }
        const expandedArgs = expandMcpRefs(input.args, refs);
        let execRes: ReturnType<typeof execute>;
        try {
          execRes = execute(batchModel, input.name, expandedArgs, batchIndex);
        } catch (e) {
          if (e instanceof EditError) return err('invalid', e.message, i);
          throw e;
        }
        const stepIds = new Set([
          ...readsOf(baseModel, expandedArgs, input.name),
          ...readsOf(batchModel, expandedArgs, input.name),
          ...execRes.changes.map((c) => c.id),
        ]);
        const stepReads: Op['reads'] = [];
        for (const id of [...stepIds].sort()) {
          if (createdInBatch.has(id) || merged.has(id)) continue;
          const ver = Object.hasOwn(baseModel.objects, id) ? effectiveBaseSeq : null;
          if (ver === null) createdInBatch.add(id);
          merged.set(id, ver);
          firstReadStep.set(id, expandedOps.length);
          stepReads.push([id, ver]);
        }
        // 按子操作顺序检查外部依据：报告最早冲突的那一步，并给出人类可读的“X 已被 Y 修改”
        const conflict = stepReads.length ? r.room.readConflict(client, stepReads) : null;
        if (conflict) return err(conflict.code, conflict.message, i);

        expandedOps.push({ name: input.name, args: expandedArgs });
        inputIndexOf.push(i);
        if (expandedOps.length > BATCH_OPS_LIMIT) {
          return err(
            'invalid',
            `展开后的子操作超过上限 ${BATCH_OPS_LIMIT} 条，请拆分成多次 apply_changes`,
            i,
          );
        }

        const batch = execRes.changes.map((c) => ({
          id: c.id,
          prev: batchModel.objects[c.id],
          next: c.obj ? execRes.next.objects[c.id] : undefined,
        }));
        batchIndex.applyBatch(execRes.next, batch);
        batchModel = execRes.next;
      }

      const batchArgs: BatchArgs = { ops: expandedOps, ...(safeSummary ? { summary: safeSummary } : {}) };
      const batchOp: Op = {
        client,
        n: r.room.processedOf(client) + 1,
        name: BATCH_MUTATOR,
        args: batchArgs,
        reads: [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      };
      const sim = r.room.simulate(client, [batchOp]);
      if (!sim.ok) {
        const sub =
          sim.subIndex ?? (sim.objectId !== undefined ? firstReadStep.get(sim.objectId) : undefined);
        return err(sim.code, sim.message, sub !== undefined ? inputIndexOf[sub] : undefined);
      }
      return { batchOp, opCount: expandedOps.length, refs, sim };
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
          const { refs, sim, opCount } = prepared;
          const changes = sim.commits[0]?.changes ?? [];
          const noop = changes.length === 0;
          return {
            kind: 'dry',
            res: {
              ok: true,
              dryRun: true,
              baseSeq: opts.baseSeq ?? r.room.seq,
              seq: noop ? r.room.seq : sim.headSeq,
              opCount,
              refs: Object.fromEntries(refs),
              changed: summarizeNetChanges(r.room.model, sim.model, changes),
              model: sim.model,
              ...(noop ? { noop: true as const } : {}),
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
            const { batchOp, refs, sim, opCount } = prepared;
            const changes = sim.commits[0]?.changes ?? [];
            if (changes.length === 0) {
              // 整批没有净变化：不写提交、不记审计、不广播
              return {
                kind: 'dry',
                res: {
                  ok: true,
                  dryRun: false,
                  baseSeq: opts.baseSeq ?? sim.baseSeq,
                  seq: r.room.seq,
                  opCount,
                  refs: Object.fromEntries(refs),
                  changed: [],
                  model: sim.model,
                  noop: true,
                },
              };
            }
            const beforeModel = r.room.model;
            const store = this.k.makeStore(tx, branchId);
            mutated = true;
            const outs = await r.room.handle(client, opts.user, { t: 'op', op: batchOp }, { store });
            const commit = outs.find((o) => o.msg.t === 'commit');
            const rejected = outs.find((o) => o.msg.t === 'reject');
            if (rejected?.msg.t === 'reject') {
              throw new Error(`预期预检通过的操作被拒绝：${rejected.msg.message}`);
            }
            if (!commit || commit.msg.t !== 'commit') throw new Error('预期预检通过的操作没有产生提交');
            await this.k.maybeSnapshot(tx, branchId, r.room);
            const seq = commit.msg.seq;
            if (opts.onBeforeCommit) await opts.onBeforeCommit(tx, { seq, opCount });
            return {
              kind: 'ok',
              res: {
                ok: true,
                dryRun: false,
                baseSeq: opts.baseSeq ?? sim.baseSeq,
                seq,
                opCount,
                refs: Object.fromEntries(refs),
                changed: summarizeNetChanges(beforeModel, r.room.model, commit.msg.changes),
                model: structuredClone(r.room.model),
              },
              outs,
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
    this.notifyCommit(branchId);
    await this.k.publish({ t: 'room.commit', branchId, seq: lockedValue.res.seq });
    return lockedValue.res;
  }
}
