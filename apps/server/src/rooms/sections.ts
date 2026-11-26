// 画布板块同步：本地板块防抖合并落盘、失败退避重试、超 7000B 落库重载与跨副本 LWW 同步。

import { type CanvasSection, sanitizeSections } from '@dowel/api';

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
          const rows =
            this.k.db.dialect === 'pg'
              ? await this.k.db.query<{ sections_ver: number | string }>(
                  'update branches set sections = $2::text::jsonb, sections_ver = greatest(sections_ver, $3::bigint) where id = $1 returning sections_ver',
                  [branchId, JSON.stringify(snapshot), sectionsVer],
                )
              : await this.k.db.query<{ sections_ver: number | string }>(
                  'update branches set sections = $2::text::jsonb, sections_ver = max(sections_ver, $3) where id = $1 returning sections_ver',
                  [branchId, JSON.stringify(snapshot), sectionsVer],
                );
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
    for (const p of r.peers) if (p !== peer) this.k.safeSend(p, { t: 'sections', sections });

    const needsReloadBroadcast =
      this.k.bus !== undefined &&
      Buffer.byteLength(
        JSON.stringify({ t: 'room.sections', origin: this.k.bus.replicaId, branchId, sections, ver }),
        'utf8',
      ) > SECTIONS_INLINE_MAX_BYTES;

    if (needsReloadBroadcast) {
      this.clearSectionsTimer(r);
      try {
        await this.flushSections(branchId, r);
      } catch (e) {
        if (r.sectionsPending) this.scheduleSectionsFlush(branchId, r);
        throw e;
      }
      await this.k.publish({ t: 'room.sections.reload', branchId, ver });
      return;
    }

    await this.k.publish({ t: 'room.sections', branchId, sections, ver });
    return;
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
