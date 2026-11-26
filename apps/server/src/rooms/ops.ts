// 协作操作的排序与持久化：WS hello / op 与服务端系统身份的 replace / patch。
// 锁序固定为 withRoomLock → DB 事务（PG `branches FOR UPDATE` + catchUpFrom）→ 释放锁后广播并发布 room.commit；
// 事务失败且已改动内存房间时标记 dirty 并在锁内重建。

import type { Model, Obj } from '@dowel/core';
import { type Commit, isValidClientId, type Out, type ToServer, type Versions, verOf } from '@dowel/sync';

import { forPeer, rewriteReadsToScoped, scopeClient } from './client-scope.ts';
import type { RoomKernel } from './kernel.ts';
import type { RoomPeers } from './peers.ts';
import { type Loaded, type Peer, WorkingChangedError } from './types.ts';

export class RoomOps {
  private readonly k: RoomKernel;
  private readonly peers: RoomPeers;
  private readonly notifyCommit: (branchId: string) => void;

  constructor(k: RoomKernel, peers: RoomPeers, notifyCommit: (branchId: string) => void) {
    this.k = k;
    this.peers = peers;
    this.notifyCommit = notifyCommit;
  }

  async handleHello(branchId: string, r: Loaded, peer: Peer, msg: Extract<ToServer, { t: 'hello' }>) {
    const validLastSeq = typeof msg.lastSeq === 'number' && Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0;
    if (!isValidClientId(msg.client) || !validLastSeq) {
      const hadClient = Boolean(peer.client);
      r.peers.delete(peer);
      peer.close?.(4400, '无效的客户端标识');
      try {
        if (hadClient) {
          this.peers.broadcastPeers(r);
          await this.peers.publishRoomPeers(branchId, r);
        }
      } finally {
        this.k.scheduleIdleEvictIfNeeded(branchId, r);
      }
      return;
    }
    if (peer.client !== undefined && peer.client !== msg.client) {
      r.peers.delete(peer);
      peer.close?.(4400, '客户端标识不可变更');
      this.peers.broadcastPeers(r);
      try {
        await this.peers.publishRoomPeers(branchId, r);
      } finally {
        this.k.scheduleIdleEvictIfNeeded(branchId, r);
      }
      return;
    }
    // 同一用户带着相同 client 重连时，踢掉尚未触发 close 的旧连接，避免同键并发乱序
    for (const other of [...r.peers]) {
      if (other !== peer && other.user.id === peer.user.id && other.client === msg.client) {
        r.peers.delete(other);
        other.close?.(4409, '客户端已在其他连接重新建立');
      }
    }
    peer.client = msg.client;
    const syncClient = scopeClient(peer.user.id, msg.client);
    const scopedHello: ToServer = { t: 'hello', client: syncClient, lastSeq: msg.lastSeq };
    this.peers.broadcastPeers(r);
    r.activeOps += 1;
    let caughtUp: Commit[] = [];
    let outs: Out[] = [];
    try {
      const res = await this.k.withRoomLock(r, async () => {
        if (!r.peers.has(peer)) return { caughtUp: [] as Commit[], outs: [] as Out[] };
        if (r.dirty) await this.k.reloadLocked(branchId, r);
        const caughtUp = this.k.db.dialect === 'pg' ? await this.k.catchUpReadOnly(branchId, r) : [];
        const outs = await r.room.handle(syncClient, peer.user.name, scopedHello, {
          readOnly: peer.role === 'viewer',
        });
        return { caughtUp, outs };
      });
      caughtUp = res.caughtUp;
      outs = res.outs;
    } finally {
      r.activeOps -= 1;
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
    if (caughtUp.length) this.k.broadcastCommits(r, caughtUp, peer);
    this.k.deliver(r, peer, outs);
    await this.peers.publishRoomPeers(branchId, r);
  }

  async handleOp(branchId: string, r: Loaded, peer: Peer, msg: Extract<ToServer, { t: 'op' }>) {
    if (
      !peer.client ||
      !msg.op ||
      typeof msg.op !== 'object' ||
      msg.op.client !== peer.client ||
      typeof msg.op.n !== 'number' ||
      !Number.isInteger(msg.op.n) ||
      msg.op.n < 1
    ) {
      return;
    }
    const rawClient = peer.client;
    const syncClient = scopeClient(peer.user.id, rawClient);
    const scopedMsg: ToServer = {
      t: 'op',
      op: {
        ...msg.op,
        client: syncClient,
        reads: Array.isArray(msg.op.reads) ? rewriteReadsToScoped(msg.op.reads, rawClient, syncClient) : [],
      },
    };
    let caughtUp: Commit[] = [];
    let result: { outs: Out[]; committed: boolean; seq: number } | null = null;
    r.activeOps += 1;
    try {
      result = await this.k.withRoomLock(r, async () => {
        if (!r.peers.has(peer)) return null;
        if (peer.role === 'viewer') {
          const outs = await r.room.handle(syncClient, peer.user.name, scopedMsg, { readOnly: true });
          return { outs, committed: false, seq: r.room.seq };
        }
        if (r.dirty) await this.k.reloadLocked(branchId, r);
        let mutated = false;
        try {
          let committedRejectionId = r.lastRejectionId;
          const out = await this.k.db.transaction(async (tx) => {
            if (this.k.db.dialect === 'pg') {
              const [locked] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!locked) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.k.catchUpFrom(tx, branchId, r);
              committedRejectionId = r.lastRejectionId;
            }
            const store = this.k.makeStore(tx, branchId, (rejId) => {
              if (rejId > committedRejectionId) committedRejectionId = rejId;
            });
            mutated = true;
            const outs = await r.room.handle(syncClient, peer.user.name, scopedMsg, {
              readOnly: peer.role === 'viewer',
              store,
            });
            const committed = outs.some((o) => o.msg.t === 'commit');
            if (committed) await this.k.maybeSnapshot(tx, branchId, r.room);
            return { outs, committed, seq: r.room.seq };
          });
          if (committedRejectionId > r.lastRejectionId) {
            r.lastRejectionId = committedRejectionId;
          }
          return out;
        } catch (err) {
          if (mutated) {
            r.dirty = true;
            await this.k.reloadLocked(branchId, r).catch(() => {});
          }
          throw err;
        }
      });
    } catch (err) {
      if (caughtUp.length) this.k.broadcastCommits(r, caughtUp);
      throw err;
    } finally {
      r.activeOps -= 1;
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
    if (!result) return;
    if (caughtUp.length) this.k.broadcastCommits(r, caughtUp);
    this.k.deliver(r, peer, result.outs);
    if (result.committed) {
      this.notifyCommit(branchId);
      await this.k.publish({ t: 'room.commit', branchId, seq: result.seq });
    }
  }

  /** 服务器以系统身份替换整个模型（导入 DDL、恢复历史、接入领先环境等）；传入 expectedSeq 时原子校验当前 seq */
  async replace(branchId: string, user: string, next: Model, opName?: string, expectedSeq?: number) {
    let loadedRef: Loaded | null = null;
    let caughtUp: Commit[] = [];
    let result: { outs: Out[]; committed: boolean; seq: number };
    try {
      const locked = await this.k.withActiveRoomLock(branchId, async (r) => {
        loadedRef = r;
        caughtUp = [];
        if (r.dirty) await this.k.reloadLocked(branchId, r);
        let mutated = false;
        try {
          return await this.k.db.transaction(async (tx) => {
            if (this.k.db.dialect === 'pg') {
              const [branch] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!branch) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.k.catchUpFrom(tx, branchId, r);
            }
            if (expectedSeq !== undefined && r.room.seq !== expectedSeq) {
              throw new WorkingChangedError(r.room.seq, structuredClone(r.room.model));
            }
            const store = this.k.makeStore(tx, branchId);
            mutated = true;
            const outs = await r.room.replace(user, next, opName, store);
            const committed = outs.some((o) => o.msg.t === 'commit');
            if (committed) await this.k.maybeSnapshot(tx, branchId, r.room);
            return { outs, committed, seq: r.room.seq };
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
      result = locked.value;
    } catch (err) {
      if (loadedRef && caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
      throw err;
    }
    if (caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
    for (const o of result.outs) for (const p of loadedRef.peers) this.k.safeSend(p, forPeer(p, o.msg));
    if (result.committed) {
      await this.k.publish({ t: 'room.commit', branchId, seq: result.seq });
    }
  }

  /** 服务器以系统身份更新派生数据（期间被别人改过的对象不写） */
  async patch(
    branchId: string,
    user: string,
    objects: Obj[],
    expect: Versions,
  ): Promise<{ committed: boolean; rejected: boolean; seq: number }> {
    let loadedRef: Loaded | null = null;
    let caughtUp: Commit[] = [];
    let result: { outs: Out[]; committed: boolean; rejected: boolean; seq: number };
    try {
      const locked = await this.k.withActiveRoomLock(branchId, async (r) => {
        loadedRef = r;
        caughtUp = [];
        if (r.dirty) await this.k.reloadLocked(branchId, r);
        let mutated = false;
        try {
          return await this.k.db.transaction(async (tx) => {
            if (this.k.db.dialect === 'pg') {
              const [branch] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!branch) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.k.catchUpFrom(tx, branchId, r);
            }
            const rejected = objects.some(
              (o) =>
                !Object.hasOwn(r.room.model.objects, o.id) ||
                verOf(r.room.versions, o.id) !== verOf(expect, o.id),
            );
            const store = this.k.makeStore(tx, branchId);
            mutated = true;
            const outs = await r.room.patch(user, objects, expect, 'derive', store);
            const committed = outs.some((o) => o.msg.t === 'commit');
            if (committed) await this.k.maybeSnapshot(tx, branchId, r.room);
            return { outs, committed, rejected, seq: r.room.seq };
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
      result = locked.value;
    } catch (err) {
      if (loadedRef && caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
      throw err;
    }
    if (caughtUp.length) this.k.broadcastCommits(loadedRef, caughtUp);
    for (const o of result.outs) for (const p of loadedRef.peers) this.k.safeSend(p, forPeer(p, o.msg));
    if (result.committed) {
      await this.k.publish({ t: 'room.commit', branchId, seq: result.seq });
    }
    return { committed: result.committed, rejected: result.rejected, seq: result.seq };
  }
}
