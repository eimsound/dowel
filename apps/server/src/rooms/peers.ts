// 在线成员与 presence：本副本 peers 与其他副本经事件总线同步的 remotePeers 合并广播，
// 并结合 HA 租约定期清理已离线副本的残留成员快照。

import { type ClusterEvent, type RoomPeerInfo, truncateRoomPeersForEvent } from '../bus.ts';
import type { RoomKernel } from './kernel.ts';
import type { Loaded, Peer } from './types.ts';

/** 单条 room.peers 集群事件的安全字节上限 */
const PEERS_EVENT_MAX_BYTES = 7000;
/** 定期结合 HA 租约清理已离线副本残留 remotePeers 的间隔（毫秒） */
const PEER_PRUNE_INTERVAL_MS = 10_000;

export class RoomPeers {
  private readonly k: RoomKernel;
  private peerPruneTimer: ReturnType<typeof setInterval> | null = null;
  pruneInFlight: Promise<void> | null = null;

  constructor(k: RoomKernel) {
    this.k = k;
  }

  /** 启动结合 HA 租约定期清理离线副本在线成员的后台定时器（仅在同时配置事件总线与 HA 时调用） */
  startPruneTimer() {
    this.peerPruneTimer = setInterval(() => {
      if (this.k.closed) return;
      void this.pruneDeadRemotePeers().catch((e) => {
        console.error('定期清理离线副本在线成员失败', e);
      });
    }, PEER_PRUNE_INTERVAL_MS);
    this.peerPruneTimer.unref?.();
  }

  stopPruneTimer() {
    if (this.peerPruneTimer) {
      clearInterval(this.peerPruneTimer);
      this.peerPruneTimer = null;
    }
  }

  /** close() 时：对仍有本地在线成员的房间清空成员并广播离线快照（登记为后台发布，供 flush() 排空） */
  publishOfflineOnClose() {
    if (this.k.bus) {
      for (const [branchId, pending] of this.k.rooms) {
        const p = pending
          .then(async (r) => {
            const hadClients = this.localPeerList(r).length > 0;
            if (!hadClients) return;
            for (const peer of [...r.peers]) r.peers.delete(peer);
            await this.k.publish({ t: 'room.peers', branchId, peers: [] });
          })
          .catch(() => {})
          .finally(() => {
            this.k.pendingBackgroundPublishes.delete(p);
          });
        this.k.pendingBackgroundPublishes.add(p);
      }
    }
  }

  localPeerList(r: Loaded): RoomPeerInfo[] {
    return [...r.peers]
      .filter((p): p is Peer & { client: string } => typeof p.client === 'string' && p.client.length > 0)
      .map((p) => ({ client: p.client, user: p.user.name }));
  }

  private peerList(r: Loaded): RoomPeerInfo[] {
    const local = this.localPeerList(r);
    if (r.remotePeers.size === 0) return local;
    const seen = new Set<string>();
    const merged: RoomPeerInfo[] = [];
    const append = (item: RoomPeerInfo) => {
      if (typeof item.client !== 'string' || item.client.length === 0 || typeof item.user !== 'string')
        return;
      const key = `${item.client}\0${item.user}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ client: item.client, user: item.user });
    };
    for (const item of local) append(item);
    for (const list of r.remotePeers.values()) {
      for (const item of list) append(item);
    }
    return merged;
  }

  private samePeerList(a: RoomPeerInfo[] | undefined, b: RoomPeerInfo[]): boolean {
    if (!a) return b.length === 0;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.client !== b[i]!.client || a[i]!.user !== b[i]!.user) return false;
    }
    return true;
  }

  broadcastPeers(r: Loaded) {
    const peers = this.peerList(r);
    for (const p of r.peers) {
      if (!this.k.peerVerifiedSeq.has(p)) continue;
      this.k.safeSend(p, { t: 'peers', peers });
    }
  }

  async publishRoomPeers(branchId: string, r: Loaded) {
    if (!this.k.bus) return;
    const raw = this.localPeerList(r);
    const { peers, truncated } = truncateRoomPeersForEvent(
      this.k.bus.replicaId,
      branchId,
      raw,
      PEERS_EVENT_MAX_BYTES,
    );
    if (truncated) {
      console.warn(
        `分支 ${branchId} 在线成员快照超出单条集群事件字节上限，已截断（total=${raw.length}, kept=${peers.length}）`,
      );
    }
    await this.k.publish({ t: 'room.peers', branchId, peers });
  }

  /** 结合 HA 租约清理已离线副本残留的 remotePeers，并在列表变动时广播给本地在线成员 */
  async pruneDeadRemotePeers(): Promise<void> {
    if (!this.k.ha || this.k.closed) return;
    let hasRemote = false;
    for (const pending of this.k.rooms.values()) {
      const r = await pending.catch(() => null);
      if (r && r.remotePeers.size > 0) {
        hasRemote = true;
        break;
      }
    }
    if (!hasRemote) return;
    if (this.pruneInFlight) {
      await this.pruneInFlight;
      return;
    }
    const task = (async () => {
      const alive = await this.k.ha!.aliveNodes();
      // 仅当本副本自身租约存活（HA 心跳已启用）时才剔除离线副本，避免未启动 HA 的测试环境误删
      if (!alive.has(this.k.ha!.replicaId)) return;
      for (const pending of this.k.rooms.values()) {
        const r = await pending.catch(() => null);
        if (!r || r.remotePeers.size === 0) continue;
        let changed = false;
        for (const origin of [...r.remotePeers.keys()]) {
          if (!alive.has(origin)) {
            r.remotePeers.delete(origin);
            changed = true;
          }
        }
        if (changed) this.broadcastPeers(r);
      }
    })();
    this.pruneInFlight = task;
    try {
      await task;
    } finally {
      if (this.pruneInFlight === task) this.pruneInFlight = null;
    }
  }

  /** 本地连接上报 presence：转发给同房间其他本地连接并经事件总线广播给其他副本 */
  async handleLocalPresence(branchId: string, r: Loaded, peer: Peer, client: string, data: unknown) {
    for (const p of r.peers)
      if (p !== peer) this.k.safeSend(p, { t: 'presence', client, user: peer.user.name, data });
    await this.k.publish({
      t: 'room.presence',
      branchId,
      userId: peer.user.id,
      client,
      user: peer.user.name,
      data,
    });
  }

  async handleRemotePeers(event: Extract<ClusterEvent, { t: 'room.peers' }>) {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    const normalized: RoomPeerInfo[] = Array.isArray(event.peers)
      ? event.peers
          .filter(
            (item): item is RoomPeerInfo =>
              Boolean(item) &&
              typeof item.client === 'string' &&
              item.client.length > 0 &&
              typeof item.user === 'string',
          )
          .map((item) => ({ client: item.client, user: item.user }))
      : [];
    const prev = r.remotePeers.get(event.origin);
    if (this.samePeerList(prev, normalized)) return;
    if (normalized.length === 0) {
      r.remotePeers.delete(event.origin);
    } else {
      r.remotePeers.set(event.origin, normalized);
    }
    this.broadcastPeers(r);
  }

  async handlePeersSync(event: Extract<ClusterEvent, { t: 'room.peers.sync' }>) {
    if (event.branchId) {
      const pending = this.k.rooms.get(event.branchId);
      if (!pending) return;
      const r = await pending.catch(() => null);
      if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
      if (this.localPeerList(r).length > 0) {
        await this.publishRoomPeers(event.branchId, r);
      }
      return;
    }
    for (const [branchId, pending] of this.k.rooms) {
      const r = await pending.catch(() => null);
      if (!r || !this.k.isCurrentEntry(branchId, r)) continue;
      await this.publishRoomPeers(branchId, r);
    }
  }

  async handleRemotePresence(event: Extract<ClusterEvent, { t: 'room.presence' }>) {
    const pending = this.k.rooms.get(event.branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(event.branchId, r)) return;
    for (const p of r.peers) {
      const isSameSender = event.userId
        ? p.user.id === event.userId && p.client === event.client
        : p.client === event.client;
      if (!isSameSender) {
        this.k.safeSend(p, { t: 'presence', client: event.client, user: event.user, data: event.data });
      }
    }
  }
}
