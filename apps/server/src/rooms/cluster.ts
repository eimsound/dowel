// 跨副本集群事件分派与事件总线重连补偿（追赶提交、布局 / 板块、在线成员与权限）。
// 事件载荷契约见 bus.ts 的 ClusterEvent；本模块只负责按类型分派到各子模块，不改变任何载荷。

import { type CanvasSection, sanitizeSections } from '@dowel/api';

import type { ClusterEvent } from '../bus.ts';
import type { RoomAccess } from './access.ts';
import type { RoomKernel } from './kernel.ts';
import type { LayoutSync } from './layout.ts';
import { isNewerLayoutVersion, parseClock } from './lww.ts';
import type { RoomPeers } from './peers.ts';
import type { SectionsSync } from './sections.ts';
import type { Layout, LayoutVersion } from './types.ts';

export class RoomCluster {
  private readonly k: RoomKernel;
  private readonly peers: RoomPeers;
  private readonly layout: LayoutSync;
  private readonly sections: SectionsSync;
  private readonly access: RoomAccess;

  constructor(
    k: RoomKernel,
    peers: RoomPeers,
    layout: LayoutSync,
    sections: SectionsSync,
    access: RoomAccess,
  ) {
    this.k = k;
    this.peers = peers;
    this.layout = layout;
    this.sections = sections;
    this.access = access;
  }

  async handleClusterEvent(event: ClusterEvent) {
    if (!this.k.bus || event.origin === this.k.bus.replicaId) return;
    switch (event.t) {
      case 'room.commit': {
        if (!this.k.rooms.has(event.branchId)) return;
        await this.k.catchUp(event.branchId, { minSeq: event.seq });
        break;
      }
      case 'room.layout': {
        await this.layout.handleRemoteLayout(event);
        break;
      }
      case 'room.layout.reload': {
        await this.layout.handleRemoteLayoutReload(event);
        break;
      }
      case 'room.sections': {
        await this.sections.handleRemoteSections(event);
        break;
      }
      case 'room.sections.reload': {
        await this.sections.handleRemoteSectionsReload(event);
        break;
      }
      case 'room.peers': {
        await this.peers.handleRemotePeers(event);
        break;
      }
      case 'room.peers.sync': {
        await this.peers.handlePeersSync(event);
        break;
      }
      case 'room.presence': {
        await this.peers.handleRemotePresence(event);
        break;
      }
      case 'room.kick': {
        await this.access.kickUserLocal(event.userId, event.reason);
        break;
      }
      case 'room.refresh': {
        await this.access.refreshLoadedLocal(event.branchIds);
        break;
      }
    }
  }

  /** PG LISTEN 断线重连后：追赶所有已加载房间的提交与布局、同步跨副本在线成员，并刷新权限（补齐断线期间错过的通知） */
  async handleBusReconnect() {
    const branchIds = [...this.k.rooms.keys()];
    for (const branchId of branchIds) {
      try {
        await this.k.catchUp(branchId);
        const pending = this.k.rooms.get(branchId);
        const r = pending ? await pending.catch(() => null) : null;
        if (r && this.k.isCurrentEntry(branchId, r)) {
          while (r.layoutIoCount > 0) {
            await r.layoutIo;
          }
          while (r.sectionsIoCount > 0) {
            await r.sectionsIo;
          }
          if (!this.k.isCurrentEntry(branchId, r)) continue;
          const pendingLayoutBefore: Layout = { ...r.pendingLayout };
          const layoutVersionsBefore = new Map(r.layoutVersions);
          const sectionsPendingBefore = r.sectionsPending;
          const sectionsWriteSeqBefore = r.sectionsWriteSeq;
          const sectionsVersionBefore = r.sectionsVersion;
          const [b] = await this.k.db.query<{
            layout: Layout;
            sections: CanvasSection[];
            layout_ver: number | string;
            sections_ver: number | string;
          }>('select layout, sections, layout_ver, sections_ver from branches where id = $1', [branchId]);
          if (b && this.k.isCurrentEntry(branchId, r)) {
            const persistedLayoutVer = parseClock(b.layout_ver);
            if (persistedLayoutVer > r.layoutClock) r.layoutClock = persistedLayoutVer;
            const persistedSectionsVer = parseClock(b.sections_ver);
            if (persistedSectionsVer > r.sectionsClock) r.sectionsClock = persistedSectionsVer;
            if (b.layout) {
              const dbLayoutVersion: LayoutVersion = { ver: persistedLayoutVer, origin: '' };
              let layoutUpdated = false;
              for (const [key, pos] of Object.entries(b.layout)) {
                if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
                if (key in r.pendingLayout || key in pendingLayoutBefore) continue;
                const existingVer = r.layoutVersions.get(key);
                if (existingVer !== layoutVersionsBefore.get(key)) continue;
                if (!isNewerLayoutVersion(dbLayoutVersion, existingVer)) continue;
                r.layout[key] = { x: pos.x, y: pos.y };
                if (persistedLayoutVer > 0) {
                  r.layoutVersions.set(key, dbLayoutVersion);
                }
                layoutUpdated = true;
              }
              if (layoutUpdated) {
                for (const p of r.peers) this.k.safeSend(p, { t: 'layout', positions: r.layout });
              }
            }
            if (
              !sectionsPendingBefore &&
              !r.sectionsPending &&
              r.sectionsIoCount === 0 &&
              r.sectionsWriteSeq === sectionsWriteSeqBefore &&
              r.sectionsVersion === sectionsVersionBefore
            ) {
              const staleDb = r.sectionsVersion !== null && persistedSectionsVer < r.sectionsVersion.ver;
              if (!staleDb) {
                if (persistedSectionsVer > (r.sectionsVersion?.ver ?? 0)) {
                  r.sectionsVersion = { ver: persistedSectionsVer, origin: '' };
                }
                r.sections = sanitizeSections(b.sections);
                for (const p of r.peers) this.k.safeSend(p, { t: 'sections', sections: r.sections });
              }
            }
          }
          if (this.k.isCurrentEntry(branchId, r)) {
            await this.peers.publishRoomPeers(branchId, r);
          }
        }
      } catch (e) {
        console.error(`事件总线重连后追赶房间失败（branchId=${branchId}）`, e);
      }
    }
    try {
      await this.peers.pruneDeadRemotePeers();
    } catch (e) {
      console.error('事件总线重连后清理离线副本在线成员失败', e);
    }
    if (branchIds.length > 0) {
      await this.k.publish({ t: 'room.peers.sync' });
    }
    try {
      await this.access.refreshLoadedLocal();
    } catch (e) {
      console.error('事件总线重连后刷新房间权限失败', e);
    }
  }
}
