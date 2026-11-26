// 画布布局同步：本地位置防抖合并落盘、失败退避重试、超 7000B 落库重载与跨副本 LWW 同步。

import type { ClusterEvent } from '../bus.ts';
import type { RoomKernel } from './kernel.ts';
import { isNewerLayoutVersion, parseClock, resolveIncomingClock } from './lww.ts';
import type { Layout, LayoutVersion, Loaded, Peer } from './types.ts';

/** 单条 room.layout 集群事件内联发送的安全字节上限（留足余量，低于 PG NOTIFY 7500B 上限） */
const LAYOUT_INLINE_MAX_BYTES = 7000;

export interface DebounceOptions {
  debounceMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

export class LayoutSync {
  private readonly k: RoomKernel;
  private readonly opts: DebounceOptions;
  /** 追踪所有活跃的布局防抖/重试定时器，确保 close() 时同步彻底清理 */
  private readonly layoutTimers = new Map<Loaded, ReturnType<typeof setTimeout>>();

  constructor(k: RoomKernel, opts: DebounceOptions) {
    this.k = k;
    this.opts = opts;
  }

  clearAllLayoutTimers() {
    for (const [r, timer] of this.layoutTimers) {
      clearTimeout(timer);
      if (r.layoutTimer === timer) r.layoutTimer = undefined;
    }
    this.layoutTimers.clear();
  }

  clearLayoutTimer(r: Loaded) {
    if (r.layoutTimer !== undefined) {
      clearTimeout(r.layoutTimer);
      r.layoutTimer = undefined;
    }
    this.layoutTimers.delete(r);
  }

  async flushLayout(
    branchId: string,
    r: Loaded,
    onErrorSnapshot?: (snapshot: Layout) => void,
  ): Promise<void> {
    let currentSnapshot: Layout = {};
    try {
      await this.withLayoutIoLock(r, async () => {
        if (!this.k.isCurrentEntry(branchId, r)) return;
        if (Object.keys(r.pendingLayout).length === 0) {
          r.layoutRetries = 0;
          this.clearLayoutTimer(r);
          return;
        }
        while (this.k.isCurrentEntry(branchId, r) && Object.keys(r.pendingLayout).length > 0) {
          const snapshot: Layout = { ...r.pendingLayout };
          const fullLayout = this.k.db.dialect === 'pg' ? null : { ...r.layout };
          const keys = Object.keys(snapshot);
          if (keys.length === 0) break;
          const versionsBefore = new Map<string, LayoutVersion | undefined>();
          let maxVersion = r.layoutClock;
          if (this.k.db.dialect === 'pg') {
            for (const key of keys) {
              const ver = r.layoutVersions.get(key);
              versionsBefore.set(key, ver);
              if (ver && ver.ver > maxVersion) maxVersion = ver.ver;
            }
          } else {
            for (const [key, ver] of r.layoutVersions) {
              versionsBefore.set(key, ver);
              if (ver.ver > maxVersion) maxVersion = ver.ver;
            }
          }
          const layoutVer = Math.max(0, maxVersion);
          currentSnapshot = snapshot;
          const rows =
            this.k.db.dialect === 'pg'
              ? await this.k.db.query<{ layout_ver: number | string }>(
                  "update branches set layout = coalesce(layout, '{}'::jsonb) || $2::text::jsonb, layout_ver = greatest(layout_ver, $3::bigint) where id = $1 returning layout_ver",
                  [branchId, JSON.stringify(snapshot), layoutVer],
                )
              : await this.k.db.query<{ layout_ver: number | string }>(
                  'update branches set layout = $2::text::jsonb, layout_ver = max(layout_ver, $3) where id = $1 returning layout_ver',
                  [branchId, JSON.stringify(fullLayout), layoutVer],
                );
          const persistedVer = parseClock(rows[0]?.layout_ver);
          if (persistedVer > r.layoutClock) r.layoutClock = persistedVer;
          // SQL 落库成功后再清理快照中未被新坐标或更高版本替换的键；若落库期间远端更新胜出并清掉了 pendingLayout，则重新入队以自愈 DB
          for (const key of keys) {
            const versionChanged = r.layoutVersions.get(key) !== versionsBefore.get(key);
            if (r.pendingLayout[key] === snapshot[key] && !versionChanged) {
              delete r.pendingLayout[key];
            } else if (!(key in r.pendingLayout) && versionChanged) {
              const winningPos = r.layout[key];
              if (winningPos) {
                r.pendingLayout[key] = winningPos;
              }
            }
          }
          if (this.k.db.dialect !== 'pg') {
            for (const [key, currentVer] of r.layoutVersions) {
              if (currentVer !== versionsBefore.get(key) && !(key in r.pendingLayout)) {
                const winningPos = r.layout[key];
                if (winningPos) {
                  r.pendingLayout[key] = winningPos;
                }
              }
            }
          }
          if (Object.keys(r.pendingLayout).length === 0) {
            this.clearLayoutTimer(r);
          }
          r.layoutRetries = 0;
        }
      });
    } catch (err) {
      onErrorSnapshot?.(currentSnapshot);
      throw err;
    } finally {
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
  }

  async handleLocalLayout(
    branchId: string,
    r: Loaded,
    peer: Peer,
    msg: { positions: Layout },
  ): Promise<void> {
    if (peer.role === 'viewer') return;
    // 处理过程中可能已经被踢出房间（以后这里加了 await 也不会漏）
    if (!r.peers.has(peer)) return;
    if (!msg.positions || typeof msg.positions !== 'object') return;
    const positions: Layout = {};
    for (const [tableId, pos] of Object.entries(msg.positions)) {
      if (
        !pos ||
        typeof pos !== 'object' ||
        typeof pos.x !== 'number' ||
        typeof pos.y !== 'number' ||
        !Number.isFinite(pos.x) ||
        !Number.isFinite(pos.y)
      ) {
        continue;
      }
      const point = { x: pos.x, y: pos.y };
      positions[tableId] = point;
      r.layout[tableId] = point;
      r.pendingLayout[tableId] = point;
    }
    const tableIds = Object.keys(positions);
    if (tableIds.length === 0) return;

    r.layoutClock += 1;
    r.layoutRetries = 0;
    const ver = r.layoutClock;
    const versionStamp: LayoutVersion = { ver, origin: this.k.bus?.replicaId ?? '' };
    for (const tableId of tableIds) r.layoutVersions.set(tableId, versionStamp);

    // 写入 pendingLayout 后立即调度防抖定时器，避免在 await publish 挂起窗口内漏刷
    this.scheduleLayoutFlush(branchId, r);
    for (const p of r.peers) if (p !== peer) this.k.safeSend(p, { t: 'layout', positions });

    const needsReloadBroadcast =
      this.k.bus !== undefined &&
      Buffer.byteLength(
        JSON.stringify({ t: 'room.layout', origin: this.k.bus.replicaId, branchId, positions, ver }),
        'utf8',
      ) > LAYOUT_INLINE_MAX_BYTES;

    if (needsReloadBroadcast) {
      this.clearLayoutTimer(r);
      try {
        await this.flushLayout(branchId, r);
      } catch (e) {
        if (Object.keys(r.pendingLayout).length > 0) this.scheduleLayoutFlush(branchId, r);
        throw e;
      }
      await this.k.publish({ t: 'room.layout.reload', branchId, ver });
      return;
    }

    await this.k.publish({ t: 'room.layout', branchId, positions, ver });
    return;
  }

  async handleRemoteLayout(event: Extract<ClusterEvent, { t: 'room.layout' }>): Promise<void> {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    const incomingVer = resolveIncomingClock(event.ver, r.layoutClock + 1);
    if (incomingVer > r.layoutClock) r.layoutClock = incomingVer;
    const incoming: LayoutVersion = { ver: incomingVer, origin: event.origin };
    const accepted: Layout = {};
    for (const [tableId, pos] of Object.entries(event.positions)) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
      if (!isNewerLayoutVersion(incoming, r.layoutVersions.get(tableId))) continue;
      const point = { x: pos.x, y: pos.y };
      accepted[tableId] = point;
      r.layout[tableId] = point;
      r.layoutVersions.set(tableId, incoming);
    }
    const acceptedKeys = Object.keys(accepted);
    if (acceptedKeys.length === 0) return;
    this.clearPendingLayoutKeys(event.branchId, r, acceptedKeys);
    for (const p of r.peers) this.k.safeSend(p, { t: 'layout', positions: accepted });
  }

  async handleRemoteLayoutReload(event: Extract<ClusterEvent, { t: 'room.layout.reload' }>): Promise<void> {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    const incomingVer = resolveIncomingClock(event.ver, r.layoutClock + 1);
    if (incomingVer > r.layoutClock) r.layoutClock = incomingVer;
    await this.reloadLayoutFromDb(event.branchId, r, { ver: incomingVer, origin: event.origin });
  }

  /** 按分支串行化画布布局的 DB 读写（flushLayout / reloadLayoutFromDb），防止重载查库与旧刷盘交错 */
  private async withLayoutIoLock<T>(r: Loaded, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = r.layoutIo;
    r.layoutIo = prev.then(() => mine);
    r.layoutIoCount += 1;
    await prev;
    try {
      return await fn();
    } finally {
      r.layoutIoCount -= 1;
      release();
    }
  }

  private scheduleLayoutFlush(branchId: string, r: Loaded, delayMs?: number) {
    if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
    this.k.clearIdleEvict(r);
    this.clearLayoutTimer(r);
    const timer = setTimeout(() => {
      if (r.layoutTimer === timer) r.layoutTimer = undefined;
      this.layoutTimers.delete(r);
      if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
      let failedSnapshot: Layout = {};
      this.flushLayout(branchId, r, (snap) => {
        failedSnapshot = snap;
      }).catch((e) => {
        console.error(`保存画布布局失败（branchId=${branchId}）`, e);
        this.handleLayoutFlushFailure(branchId, r, failedSnapshot);
      });
    }, delayMs ?? this.opts.debounceMs);
    timer.unref?.();
    r.layoutTimer = timer;
    this.layoutTimers.set(r, timer);
  }

  private handleLayoutFlushFailure(branchId: string, r: Loaded, failedSnapshot: Layout) {
    if (this.k.closed || !this.k.isCurrentEntry(branchId, r)) return;
    if (Object.keys(r.pendingLayout).length === 0) {
      r.layoutRetries = 0;
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
      return;
    }
    if (r.layoutRetries < this.opts.maxRetries) {
      r.layoutRetries += 1;
      const backoffMs = this.opts.retryBaseMs * 2 ** (r.layoutRetries - 1);
      this.scheduleLayoutFlush(branchId, r, backoffMs);
      return;
    }
    // 连续失败达重试上限：清理本次失败快照中未被新拖动覆盖的键，防止空闲房间永久卡死无法卸载
    for (const [key, point] of Object.entries(failedSnapshot)) {
      if (r.pendingLayout[key] === point) {
        delete r.pendingLayout[key];
      }
    }
    r.layoutRetries = 0;
    if (Object.keys(r.pendingLayout).length > 0) {
      this.scheduleLayoutFlush(branchId, r);
      return;
    }
    this.clearLayoutTimer(r);
    this.k.scheduleIdleEvictIfNeeded(branchId, r);
  }

  private clearPendingLayoutKeys(branchId: string, r: Loaded, keys: Iterable<string>) {
    let deletedAny = false;
    for (const key of keys) {
      if (key in r.pendingLayout) {
        delete r.pendingLayout[key];
        deletedAny = true;
      }
    }
    if (!deletedAny) return;
    if (Object.keys(r.pendingLayout).length === 0) {
      this.clearLayoutTimer(r);
      r.layoutRetries = 0;
    }
    this.k.scheduleIdleEvictIfNeeded(branchId, r);
  }

  private async reloadLayoutFromDb(branchId: string, r: Loaded, incoming?: LayoutVersion) {
    try {
      await this.withLayoutIoLock(r, async () => {
        if (!this.k.isCurrentEntry(branchId, r)) return;
        const pendingBefore: Layout = { ...r.pendingLayout };
        const [b] = await this.k.db.query<{ layout: Layout; layout_ver: number | string }>(
          'select layout, layout_ver from branches where id = $1',
          [branchId],
        );
        if (!b || !this.k.isCurrentEntry(branchId, r)) return;
        const persistedVer = parseClock(b.layout_ver);
        if (persistedVer > r.layoutClock) r.layoutClock = persistedVer;
        if (incoming && incoming.ver > r.layoutClock) r.layoutClock = incoming.ver;
        if (!b.layout) return;
        const effectiveIncoming: LayoutVersion | undefined = incoming
          ? persistedVer > incoming.ver
            ? { ver: persistedVer, origin: '' }
            : incoming
          : persistedVer > 0
            ? { ver: persistedVer, origin: '' }
            : undefined;
        const clearedKeys: string[] = [];
        let updatedAny = false;
        for (const [key, pos] of Object.entries(b.layout)) {
          if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
          const cur = r.pendingLayout[key];
          // 查询期间新产生的本地拖动保留，不被此次重载覆盖
          if (cur !== undefined && cur !== pendingBefore[key]) continue;
          if (effectiveIncoming && !isNewerLayoutVersion(effectiveIncoming, r.layoutVersions.get(key))) {
            continue;
          }
          if (cur !== undefined) clearedKeys.push(key);
          if (effectiveIncoming) r.layoutVersions.set(key, effectiveIncoming);
          r.layout[key] = { x: pos.x, y: pos.y };
          updatedAny = true;
        }
        if (clearedKeys.length > 0) this.clearPendingLayoutKeys(branchId, r, clearedKeys);
        if (updatedAny) {
          for (const p of r.peers) this.k.safeSend(p, { t: 'layout', positions: r.layout });
        }
      });
    } finally {
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
  }
}
