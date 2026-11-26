// 画布板块同步：本地板块防抖合并落盘、失败退避重试、超 7000B 落库重载与跨副本 LWW 同步，
// 以及 MCP manage_sections 的锁内增量合并落库（ADR 0015 第 1 节；纯布局层，不进 IR / room_commits / seq）。

import {
  applySectionActions,
  type CanvasSection,
  type ResolvedSectionAction,
  type SectionActionError,
  type SectionTableCheck,
  type SectionTableMove,
  sanitizeSections,
} from '@dowel/api';
import type { Model } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Commit } from '@dowel/sync';

import type { ClusterEvent } from '../bus.ts';
import type { RoomKernel } from './kernel.ts';
import type { DebounceOptions } from './layout.ts';
import { isNewerLayoutVersion, parseClock, resolveIncomingClock } from './lww.ts';
import type { LayoutVersion, Loaded, Peer } from './types.ts';

/** 单条 room.sections 集群事件内联发送的安全字节上限（留足余量，低于 PG NOTIFY 7500B 上限） */
const SECTIONS_INLINE_MAX_BYTES = 7000;

/** 是否仍有待落盘 / 在途 IO / 已排期的板块写入（纯函数，供内核空闲卸载判断） */
export const hasPendingSections = (r: Loaded): boolean =>
  r.sectionsPending || r.sectionsIoCount > 0 || r.sectionsTimer !== undefined;

/** branches 行里的板块列 */
export interface SectionsRow {
  sections: unknown;
  sections_ver: number | string;
}

/**
 * 在内存板块（含尚未落盘的 WS 防抖编辑）与 DB 持久化板块之间选出较新一方作为合并 / 读取基准：
 * DB 按 `{ ver: sections_ver, origin: '' }` 与内存 `sectionsVersion` 做 LWW 比较（同版本时内存优先），
 * 既不丢本副本尚未刷盘的编辑，也避免冷副本用旧内存抹掉其他副本的新写入。
 */
export const freshestSections = (
  r: Pick<Loaded, 'sections' | 'sectionsVersion' | 'sectionsPending'>,
  row: SectionsRow,
): { sections: CanvasSection[]; ver: number; dbVer: number; source: 'memory' | 'db' } => {
  const dbVer = parseClock(row.sections_ver);
  const mem = r.sectionsVersion;
  const useDb = mem ? isNewerLayoutVersion({ ver: dbVer, origin: '' }, mem) : !r.sectionsPending;
  return useDb
    ? { sections: sanitizeSections(row.sections), ver: dbVer, dbVer, source: 'db' }
    : { sections: r.sections, ver: mem?.ver ?? 0, dbVer, source: 'memory' };
};

/** 板块可容纳的表：live model 里的普通表（分区子表跟随父表显示，不可单独归属） */
export const sectionTableChecker =
  (model: Model) =>
  (id: string): SectionTableCheck => {
    const obj = Object.hasOwn(model.objects, id) ? model.objects[id] : undefined;
    if (!obj) return 'missing';
    if (obj.kind !== 'table') return 'not_table';
    return obj.partitionOf ? 'partition' : 'ok';
  };

export interface ManageSectionsOptions {
  /** 已解析的增量动作（create 的 ID 已由调用方分配，`$ref:` 已换成真实 ID） */
  actions: ResolvedSectionAction[];
  dryRun?: boolean;
  /**
   * 写事务提交前的回调（仅非 dryRun 且有净变化时，在同一个 DB 事务 `tx` 内调用 1 次），用于 `auditIn(tx, ...)`；
   * 抛错会回滚整次板块写入，内存态不变，不广播。
   */
  onBeforeCommit?: (
    tx: Db,
    info: { ver: number; moved: SectionTableMove[]; created: string[]; deleted: string[] },
  ) => Promise<void>;
}

export type ManageSectionsResult =
  | {
      ok: true;
      dryRun: boolean;
      /** 本次写入的板块版本（dryRun 时为预计版本；noop 时为当前版本） */
      sectionsVer: number;
      sections: CanvasSection[];
      moved: SectionTableMove[];
      created: string[];
      deleted: string[];
      /** 没有净变化：不写库、不记审计、不广播 */
      noop?: true;
      /** 提交期间同副本到达了更新的人工编辑且本批无法在其上重放：人的编辑胜出 */
      superseded?: true;
    }
  | SectionActionError;

export class SectionsSync {
  private readonly k: RoomKernel;
  private readonly opts: DebounceOptions;
  /** 追踪所有活跃的板块防抖/重试定时器，确保 close() 时同步彻底清理 */
  private readonly sectionsTimers = new Map<Loaded, ReturnType<typeof setTimeout>>();

  constructor(k: RoomKernel, opts: DebounceOptions) {
    this.k = k;
    this.opts = opts;
  }

  clearAllSectionsTimers() {
    for (const [r, timer] of this.sectionsTimers) {
      clearTimeout(timer);
      if (r.sectionsTimer === timer) r.sectionsTimer = undefined;
    }
    this.sectionsTimers.clear();
  }

  clearSectionsTimer(r: Loaded) {
    if (r.sectionsTimer !== undefined) {
      clearTimeout(r.sectionsTimer);
      r.sectionsTimer = undefined;
    }
    this.sectionsTimers.delete(r);
  }

  async flushSections(
    branchId: string,
    r: Loaded,
    onErrorState?: (state: { writeSeq: number; version: LayoutVersion | null }) => void,
  ): Promise<void> {
    let currentWriteSeq = r.sectionsWriteSeq;
    let currentVersion = r.sectionsVersion;
    /** 条件写被拒（DB 已有更高版本）时，锁外从 DB 重载获胜版本 */
    let reloadAfter: LayoutVersion | null = null;
    try {
      await this.withSectionsIoLock(r, async () => {
        if (!this.k.isCurrentEntry(branchId, r)) return;
        if (!r.sectionsPending) {
          r.sectionsRetries = 0;
          this.clearSectionsTimer(r);
          return;
        }
        while (this.k.isCurrentEntry(branchId, r) && r.sectionsPending) {
          const snapshot = r.sections;
          const writeSeq = r.sectionsWriteSeq;
          const versionBefore = r.sectionsVersion;
          const sectionsVer = Math.max(0, r.sectionsClock, versionBefore?.ver ?? 0);
          currentWriteSeq = writeSeq;
          currentVersion = versionBefore;
          // 条件写：只在 DB 版本不高于本次写入版本时覆写，杜绝旧副本的防抖落盘覆盖其他副本 / MCP 的更新提交
          const rows =
            this.k.db.dialect === 'pg'
              ? await this.k.db.query<{ sections_ver: number | string }>(
                  'update branches set sections = $2::text::jsonb, sections_ver = greatest(sections_ver, $3::bigint) where id = $1 and sections_ver <= $3::bigint returning sections_ver',
                  [branchId, JSON.stringify(snapshot), sectionsVer],
                )
              : await this.k.db.query<{ sections_ver: number | string }>(
                  'update branches set sections = $2::text::jsonb, sections_ver = max(sections_ver, $3) where id = $1 and sections_ver <= $3 returning sections_ver',
                  [branchId, JSON.stringify(snapshot), sectionsVer],
                );
          if (rows.length === 0) {
            const [cur] = await this.k.db.query<{ sections_ver: number | string }>(
              'select sections_ver from branches where id = $1',
              [branchId],
            );
            const dbVer = parseClock(cur?.sections_ver);
            if (dbVer > r.sectionsClock) r.sectionsClock = dbVer;
            const dbVersion: LayoutVersion = { ver: dbVer, origin: '' };
            if (cur && r.sectionsVersion && isNewerLayoutVersion(r.sectionsVersion, dbVersion)) {
              // 落库期间又有更新的本地写入（版本已超过 DB）：保持待刷，下一轮按推进后的时钟写回
              r.sectionsPending = true;
              continue;
            }
            // DB 已有更新提交：放弃本地旧快照（LWW 落败），锁外重载获胜版本推给本地 peers
            r.sectionsPending = false;
            r.sectionsRetries = 0;
            this.clearSectionsTimer(r);
            if (cur) reloadAfter = dbVersion;
            break;
          }
          const persistedVer = parseClock(rows[0]?.sections_ver);
          if (persistedVer > r.sectionsClock) r.sectionsClock = persistedVer;
          if (r.sectionsWriteSeq === writeSeq && r.sectionsVersion === versionBefore) {
            r.sectionsPending = false;
            r.sectionsRetries = 0;
            this.clearSectionsTimer(r);
          } else {
            // 落库期间有新本地写入或收到更高版本远端板块（旧快照可能已覆写 DB），保持待刷状态幂等写回当前获胜版本
            r.sectionsPending = true;
          }
        }
      });
    } catch (err) {
      onErrorState?.({ writeSeq: currentWriteSeq, version: currentVersion });
      throw err;
    } finally {
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
    if (reloadAfter) {
      void this.reloadSectionsFromDb(branchId, r, reloadAfter).catch((e) => {
        if (!this.k.closed) console.error(`重载画布板块失败（branchId=${branchId}）`, e);
      });
    }
  }

  /**
   * 板块变更的统一出口：发给本地 peers（可排除发起者），再经事件总线同步其他副本：
   * 小负载发 room.sections；超 SECTIONS_INLINE_MAX_BYTES 时发轻量 room.sections.reload
   * （flushFirst：DB 尚未包含本次结果时先在 IO 锁外落库再发 reload）。
   */
  async broadcastSections(
    branchId: string,
    r: Loaded,
    sections: CanvasSection[],
    ver: number,
    opts: { excludePeer?: Peer; flushFirst?: boolean } = {},
  ): Promise<void> {
    for (const p of r.peers) if (p !== opts.excludePeer) this.k.safeSend(p, { t: 'sections', sections });
    const bus = this.k.bus;
    if (!bus) return;
    const needsReloadBroadcast =
      Buffer.byteLength(
        JSON.stringify({ t: 'room.sections', origin: bus.replicaId, branchId, sections, ver }),
        'utf8',
      ) > SECTIONS_INLINE_MAX_BYTES;
    if (needsReloadBroadcast) {
      if (opts.flushFirst) {
        this.clearSectionsTimer(r);
        try {
          await this.flushSections(branchId, r);
        } catch (e) {
          if (r.sectionsPending) this.scheduleSectionsFlush(branchId, r);
          throw e;
        }
      }
      await this.k.publish({ t: 'room.sections.reload', branchId, ver });
      return;
    }
    await this.k.publish({ t: 'room.sections', branchId, sections, ver });
  }

  /**
   * MCP manage_sections：在房间锁内基于最新板块增量合并、落库（与审计同事务）并广播。
   * 固定单向锁序：withActiveRoomLock → withSectionsIoLock（不可重入：锁内绝不调用 flushSections）
   * → DB 事务（PG `branches FOR UPDATE` + catchUpFrom 追齐模型后再校验表）。
   * 失败 / noop / dryRun 零写库、零审计、零广播；事务等待期间本副本到达的新人工编辑通过重放合并。
   */
  async manage(branchId: string, opts: ManageSectionsOptions): Promise<ManageSectionsResult> {
    const dryRun = !!opts.dryRun;
    const origin = this.k.bus?.replicaId ?? '';
    let loadedRef: Loaded | null = null;
    const caughtUp: Commit[] = [];

    type Broadcast = { sections: CanvasSection[]; ver: number; flushFirst: boolean };
    type Value = { res: ManageSectionsResult; broadcast: Broadcast | null };
    type TxValue =
      | { kind: 'done'; value: Value }
      | {
          kind: 'commit';
          applied: Extract<ReturnType<typeof applySectionActions>, { ok: true }>;
          ver: number;
          writeSeqBefore: number;
          versionBefore: LayoutVersion | null;
          checkTable: (id: string) => SectionTableCheck;
        };

    let value: Value;
    try {
      const locked = await this.k.withActiveRoomLock(branchId, async (r): Promise<Value> => {
        loadedRef = r;
        caughtUp.length = 0;
        if (r.dirty) caughtUp.push(...(await this.k.reloadAndMissedLocked(branchId, r)));
        return this.withSectionsIoLock(r, async (): Promise<Value> => {
          const pg = this.k.db.dialect === 'pg';
          const tv = await this.k.db.transaction(
            async (tx): Promise<TxValue> => {
              const [row] = await tx.query<SectionsRow>(
                `select sections, sections_ver from branches where id = $1${pg && !dryRun ? ' for update' : ''}`,
                [branchId],
              );
              if (!row) throw new Error(`分支 ${branchId} 不存在`);
              if (pg) caughtUp.push(...(await this.k.catchUpFrom(tx, branchId, r)));
              const base = freshestSections(r, row);
              if (base.dbVer > r.sectionsClock) r.sectionsClock = base.dbVer;
              const checkTable = sectionTableChecker(r.room.model);
              const applied = applySectionActions(base.sections, opts.actions, checkTable);
              if (!applied.ok) return { kind: 'done', value: { res: applied, broadcast: null } };
              const nextVer = Math.max(r.sectionsClock, base.ver) + 1;
              if (!applied.changed || dryRun) {
                return {
                  kind: 'done',
                  value: {
                    res: {
                      ok: true,
                      dryRun,
                      sectionsVer: applied.changed ? nextVer : base.ver,
                      sections: structuredClone(applied.sections),
                      moved: applied.moved,
                      created: applied.created,
                      deleted: applied.deleted,
                      ...(applied.changed ? {} : { noop: true as const }),
                    },
                    broadcast: null,
                  },
                };
              }
              const writeSeqBefore = r.sectionsWriteSeq;
              const versionBefore = r.sectionsVersion;
              // 预推时钟：事务挂起期间到达的本地 WS 编辑会拿到更高版本，提交后走重放合并
              r.sectionsClock = nextVer;
              await tx.query(
                pg
                  ? 'update branches set sections = $2::text::jsonb, sections_ver = greatest(sections_ver, $3::bigint) where id = $1'
                  : 'update branches set sections = $2::text::jsonb, sections_ver = max(sections_ver, $3) where id = $1',
                [branchId, JSON.stringify(applied.sections), nextVer],
              );
              await opts.onBeforeCommit?.(tx, {
                ver: nextVer,
                moved: applied.moved,
                created: applied.created,
                deleted: applied.deleted,
              });
              return { kind: 'commit', applied, ver: nextVer, writeSeqBefore, versionBefore, checkTable };
            },
            dryRun ? { isolationLevel: 'repeatable_read', readOnly: true } : undefined,
          );
          if (tv.kind === 'done') return tv.value;

          // 事务已提交（仍在 IO 锁内）：同步把结果合入内存
          const { applied, ver, checkTable } = tv;
          const ours: LayoutVersion = { ver, origin };
          const current = r.sectionsVersion;
          const remoteNotNewer =
            current === tv.versionBefore || !current || !isNewerLayoutVersion(current, ours);
          if (r.sectionsWriteSeq === tv.writeSeqBefore && remoteNotNewer) {
            r.sections = applied.sections;
            r.sectionsVersion = ours;
            r.sectionsPending = false;
            r.sectionsRetries = 0;
            this.clearSectionsTimer(r);
            return {
              res: {
                ok: true,
                dryRun: false,
                sectionsVer: ver,
                sections: structuredClone(applied.sections),
                moved: applied.moved,
                created: applied.created,
                deleted: applied.deleted,
              },
              broadcast: { sections: applied.sections, ver, flushFirst: false },
            };
          }

          // 事务挂起期间本副本到达了更新的 WS / 远端板块：用同一批已解析动作（create 复用已生成的 ID）在其上重放
          const replay = applySectionActions(r.sections, opts.actions, checkTable);
          if (!replay.ok) {
            return {
              res: {
                ok: true,
                dryRun: false,
                sectionsVer: r.sectionsVersion?.ver ?? ver,
                sections: structuredClone(r.sections),
                moved: applied.moved,
                created: applied.created,
                deleted: applied.deleted,
                superseded: true,
              },
              broadcast: null,
            };
          }
          if (!replay.changed) {
            return {
              res: {
                ok: true,
                dryRun: false,
                sectionsVer: r.sectionsVersion?.ver ?? ver,
                sections: structuredClone(r.sections),
                moved: replay.moved,
                created: replay.created,
                deleted: replay.deleted,
              },
              broadcast: null,
            };
          }
          r.sectionsClock = Math.max(r.sectionsClock, ver) + 1;
          r.sectionsWriteSeq += 1;
          const replayVer = r.sectionsClock;
          r.sections = replay.sections;
          r.sectionsVersion = { ver: replayVer, origin };
          r.sectionsPending = true;
          r.sectionsRetries = 0;
          this.scheduleSectionsFlush(branchId, r);
          return {
            res: {
              ok: true,
              dryRun: false,
              sectionsVer: replayVer,
              sections: structuredClone(replay.sections),
              moved: replay.moved,
              created: replay.created,
              deleted: replay.deleted,
            },
            broadcast: { sections: replay.sections, ver: replayVer, flushFirst: true },
          };
        });
      });
      loadedRef = locked.r;
      value = locked.value;
    } catch (err) {
      if (loadedRef && caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
      throw err;
    }

    // 锁外广播：先补发追赶到的模型提交，再发板块
    const r: Loaded = loadedRef!;
    if (caughtUp.length) this.k.broadcastCommits(r, caughtUp);
    if (value.broadcast) {
      try {
        await this.broadcastSections(branchId, r, value.broadcast.sections, value.broadcast.ver, {
          flushFirst: value.broadcast.flushFirst,
        });
      } catch (e) {
        // 板块已提交（或已排期落盘重试）：广播 / 落盘失败不让调用方误以为写入失败
        if (!this.k.closed) console.error(`广播画布板块失败（branchId=${branchId}）`, e);
      }
    }
    return value.res;
  }

  /**
   * 只读路径（get_model）取最新板块：对房间锁内拍下的内存板块与 DB 做一次 freshestSections 比较；
   * DB 更热（跨副本 manage_sections 刚提交）且本副本没有待刷 / 在途写入时，同步追齐内存并补发本地 peers。
   */
  async readFreshest(
    branchId: string,
    r: Loaded,
    captured: { sections: CanvasSection[]; version: LayoutVersion | null; pending: boolean },
  ): Promise<{ sections: CanvasSection[]; ver: number }> {
    const [row] = await this.k.db.query<SectionsRow>(
      'select sections, sections_ver from branches where id = $1',
      [branchId],
    );
    const memVer = captured.version?.ver ?? 0;
    if (!row) return { sections: captured.sections, ver: memVer };
    const pick = freshestSections(
      { sections: captured.sections, sectionsVersion: captured.version, sectionsPending: captured.pending },
      row,
    );
    if (pick.source === 'memory' || pick.dbVer <= memVer) {
      return { sections: captured.sections, ver: memVer };
    }
    if (
      this.k.isCurrentEntry(branchId, r) &&
      !r.sectionsPending &&
      r.sectionsIoCount === 0 &&
      r.sectionsVersion === captured.version
    ) {
      if (pick.dbVer > r.sectionsClock) r.sectionsClock = pick.dbVer;
      r.sections = pick.sections;
      r.sectionsVersion = { ver: pick.dbVer, origin: '' };
      for (const p of r.peers) this.k.safeSend(p, { t: 'sections', sections: pick.sections });
    }
    return { sections: structuredClone(pick.sections), ver: pick.dbVer };
  }

  async handleLocalSections(
    branchId: string,
    r: Loaded,
    peer: Peer,
    msg: { sections: CanvasSection[] },
  ): Promise<void> {
    if (peer.role === 'viewer') return;
    if (!r.peers.has(peer)) return;
    if (!Array.isArray(msg.sections)) return;
    const sections = sanitizeSections(msg.sections);
    r.sections = sections;
    r.sectionsPending = true;
    r.sectionsRetries = 0;
    r.sectionsClock += 1;
    r.sectionsWriteSeq += 1;
    const ver = r.sectionsClock;
    r.sectionsVersion = { ver, origin: this.k.bus?.replicaId ?? '' };

    // 写入内存待落盘状态后立即调度防抖定时器，避免在 await publish 挂起窗口内漏刷
    this.scheduleSectionsFlush(branchId, r);
    await this.broadcastSections(branchId, r, sections, ver, { excludePeer: peer, flushFirst: true });
  }

  async handleRemoteSections(event: Extract<ClusterEvent, { t: 'room.sections' }>): Promise<void> {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    const incomingVer = resolveIncomingClock(event.ver, r.sectionsClock + 1);
    if (incomingVer > r.sectionsClock) r.sectionsClock = incomingVer;
    const incoming: LayoutVersion = { ver: incomingVer, origin: event.origin };
    if (!isNewerLayoutVersion(incoming, r.sectionsVersion ?? undefined)) return;
    const sections = sanitizeSections(event.sections);
    r.sections = sections;
    r.sectionsVersion = incoming;
    r.sectionsPending = false;
    r.sectionsRetries = 0;
    this.clearSectionsTimer(r);
    this.k.scheduleIdleEvictIfNeeded(event.branchId, r);
    for (const p of r.peers) this.k.safeSend(p, { t: 'sections', sections });
  }

  async handleRemoteSectionsReload(
    event: Extract<ClusterEvent, { t: 'room.sections.reload' }>,
  ): Promise<void> {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    const incomingVer = resolveIncomingClock(event.ver, r.sectionsClock + 1);
    if (incomingVer > r.sectionsClock) r.sectionsClock = incomingVer;
    await this.reloadSectionsFromDb(event.branchId, r, { ver: incomingVer, origin: event.origin });
  }

  /** 按分支串行化画布板块的 DB 读写（flushSections / reloadSectionsFromDb），防止重载查库与旧刷盘交错 */
  private async withSectionsIoLock<T>(r: Loaded, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = r.sectionsIo;
    r.sectionsIo = prev.then(() => mine);
    r.sectionsIoCount += 1;
    await prev;
    try {
      return await fn();
    } finally {
      r.sectionsIoCount -= 1;
      release();
    }
  }

  private scheduleSectionsFlush(branchId: string, r: Loaded, delayMs?: number) {
    if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
    this.k.clearIdleEvict(r);
    this.clearSectionsTimer(r);
    const timer = setTimeout(() => {
      if (r.sectionsTimer === timer) r.sectionsTimer = undefined;
      this.sectionsTimers.delete(r);
      if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
      let failedState: { writeSeq: number; version: LayoutVersion | null } = {
        writeSeq: -1,
        version: null,
      };
      this.flushSections(branchId, r, (state) => {
        failedState = state;
      }).catch((e) => {
        console.error(`保存画布板块失败（branchId=${branchId}）`, e);
        this.handleSectionsFlushFailure(branchId, r, failedState);
      });
    }, delayMs ?? this.opts.debounceMs);
    timer.unref?.();
    r.sectionsTimer = timer;
    this.sectionsTimers.set(r, timer);
  }

  private handleSectionsFlushFailure(
    branchId: string,
    r: Loaded,
    failedState: { writeSeq: number; version: LayoutVersion | null },
  ) {
    if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
    if (!r.sectionsPending) {
      r.sectionsRetries = 0;
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
      return;
    }
    if (r.sectionsRetries < this.opts.maxRetries) {
      r.sectionsRetries += 1;
      const backoffMs = this.opts.retryBaseMs * 2 ** (r.sectionsRetries - 1);
      this.scheduleSectionsFlush(branchId, r, backoffMs);
      return;
    }
    // 连续失败达重试上限：若期间无更新写入或更高版本覆盖则清 pending，防止空闲房间永久卡死无法卸载
    if (r.sectionsWriteSeq === failedState.writeSeq && r.sectionsVersion === failedState.version) {
      r.sectionsPending = false;
      r.sectionsRetries = 0;
      this.clearSectionsTimer(r);
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
      return;
    }
    r.sectionsRetries = 0;
    this.scheduleSectionsFlush(branchId, r);
  }

  private async reloadSectionsFromDb(branchId: string, r: Loaded, incoming: LayoutVersion) {
    const writeSeqBefore = r.sectionsWriteSeq;
    try {
      await this.withSectionsIoLock(r, async () => {
        if (!this.k.isCurrentEntry(branchId, r)) return;
        if (r.sectionsWriteSeq !== writeSeqBefore) return;
        if (!isNewerLayoutVersion(incoming, r.sectionsVersion ?? undefined)) return;
        const [b] = await this.k.db.query<{ sections: CanvasSection[]; sections_ver: number | string }>(
          'select sections, sections_ver from branches where id = $1',
          [branchId],
        );
        if (!b || !this.k.isCurrentEntry(branchId, r)) return;
        const persistedVer = parseClock(b.sections_ver);
        if (persistedVer > r.sectionsClock) r.sectionsClock = persistedVer;
        if (r.sectionsWriteSeq !== writeSeqBefore) return;
        const effectiveIncoming: LayoutVersion =
          persistedVer > incoming.ver ? { ver: persistedVer, origin: '' } : incoming;
        if (!isNewerLayoutVersion(effectiveIncoming, r.sectionsVersion ?? undefined)) return;
        const sections = sanitizeSections(b.sections);
        r.sections = sections;
        r.sectionsVersion = effectiveIncoming;
        r.sectionsPending = false;
        r.sectionsRetries = 0;
        this.clearSectionsTimer(r);
        for (const p of r.peers) this.k.safeSend(p, { t: 'sections', sections });
      });
    } finally {
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
  }
}
