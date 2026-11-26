// 房间成员准入与权限刷新：join 复查角色（按刷新代际在每次 await 后复核）、leave、踢人、
// 单飞串行 + 合并重跑的权限刷新队列，以及分支删除 / 停机时的批量断开。

import type { User } from '../auth.ts';
import { inList } from '../db.ts';
import type { RoleLookup } from '../roles.ts';
import type { RoomKernel } from './kernel.ts';
import type { LayoutSync } from './layout.ts';
import type { RoomPeers } from './peers.ts';
import type { SectionsSync } from './sections.ts';
import type { Loaded, Peer, RefreshTarget, ResolveRole } from './types.ts';

/** join 复查权限时因并发刷新触发重查的最大尝试次数 */
const MAX_JOIN_VERIFY_ATTEMPTS = 8;

export class RoomAccess {
  private readonly k: RoomKernel;
  private readonly peers: RoomPeers;
  private readonly layout: LayoutSync;
  private readonly sections: SectionsSync;
  /**
   * 注入的生效角色计算（app.ts 接到 roles.ts）。join 时用它复查“升级和 join 之间”的角色变化，
   * 和 HTTP 的 access() 是同一套规则。
   */
  private readonly resolveRole: ResolveRole;
  /** 单飞权限刷新状态：串行执行 refreshLoadedLocal 并合并期间到来的新请求 */
  private refreshActive = false;
  refreshInFlight: Promise<void> | null = null;
  private pendingRefreshTarget: RefreshTarget | null = null;
  private pendingRefreshWait: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
  } | null = null;

  constructor(
    k: RoomKernel,
    peers: RoomPeers,
    layout: LayoutSync,
    sections: SectionsSync,
    resolveRole: ResolveRole,
  ) {
    this.k = k;
    this.peers = peers;
    this.layout = layout;
    this.sections = sections;
    this.resolveRole = resolveRole;
  }

  private mergePendingRefresh(target: RefreshTarget) {
    if (target === 'all' || this.pendingRefreshTarget === 'all') {
      this.pendingRefreshTarget = 'all';
      return;
    }
    if (!this.pendingRefreshTarget) {
      this.pendingRefreshTarget = new Set(target);
      return;
    }
    for (const id of target) this.pendingRefreshTarget.add(id);
  }

  /** 查询用户最新的实例角色、账号状态与是否须改密：停用、改密要求或角色变更后不能沿用 WS 升级时的快照 */
  private async fetchUserState(
    userId: string,
  ): Promise<{ role: User['role']; status: User['status']; mustChangePassword: boolean } | null> {
    const [row] = await this.k.db.query<{
      role: User['role'];
      status: User['status'];
      mustChangePassword: boolean | number;
    }>('select role, status, must_change_password as "mustChangePassword" from users where id = $1', [
      userId,
    ]);
    return row ? { ...row, mustChangePassword: Boolean(row.mustChangePassword) } : null;
  }

  /** 分支属于哪个项目（join 复查角色、刷新已加载房间时用） */
  private async projectOfBranch(branchId: string): Promise<string | null> {
    const [row] = await this.k.db.query<{ projectId: string }>(
      'select project_id as "projectId" from branches where id = $1',
      [branchId],
    );
    return row?.projectId ?? null;
  }

  /**
   * 加入房间。**先**把 peer 放进集合，再按刷新代际循环复查，避免“升级之后、join 之前/期间”状态已经变了：
   * 1. 重查 users.role 与 users.status（停用后不能继续实时协作，实例角色变更同步更新到 peer.user）；
   * 2. 重新算一次生效角色——授权、组成员、默认权限可能正好在这之间被改，
   *    算不到就让位（4403），和升级时不一样就更新并通知客户端；
   * 3. 若 await 期间 peer 已被踢出或离开，直接中止；若并发刷新/踢人推进了代际，放弃旧结果重查直到稳定。
   * join 成功（含重连）后总会发一条 role，前端以它为准校正本地状态。
   */
  async join(branchId: string, peer: Peer) {
    let r: Loaded;
    for (;;) {
      r = await this.k.get(branchId);
      if (this.k.isCurrentEntry(branchId, r)) break;
    }
    this.k.clearIdleEvict(r);
    r.peers.add(peer);

    const removePeer = (closeReason?: string) => {
      const hadClient = Boolean(peer.client);
      if (!r.peers.delete(peer)) return;
      if (closeReason !== undefined) peer.close?.(4403, closeReason);
      this.peers.broadcastPeers(r);
      if (hadClient) {
        const p = this.peers.publishRoomPeers(branchId, r).finally(() => {
          this.k.pendingBackgroundPublishes.delete(p);
        });
        this.k.pendingBackgroundPublishes.add(p);
      }
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    };

    try {
      for (let attempt = 0; attempt < MAX_JOIN_VERIFY_ATTEMPTS; attempt++) {
        if (!r.peers.has(peer)) return;
        const gen = this.k.refreshGenFor(branchId);
        const seq = this.k.refreshSeq;

        const current = await this.fetchUserState(peer.user.id);
        if (!r.peers.has(peer)) return;
        if (this.k.refreshGenFor(branchId) !== gen) continue;
        if (current?.status !== 'active') {
          removePeer('账号已被停用');
          return;
        }
        if (current.mustChangePassword) {
          removePeer('密码已重置，请重新登录并修改密码');
          return;
        }
        if (peer.user.role !== current.role) {
          peer.user = { ...peer.user, role: current.role };
        }

        const projectId = await this.projectOfBranch(branchId);
        if (!r.peers.has(peer)) return;
        const role = projectId ? await this.resolveRole(peer.user, projectId) : null;
        if (!r.peers.has(peer)) return;
        if (this.k.refreshGenFor(branchId) !== gen) continue;

        if (!role) {
          removePeer('你在这个项目里已经没有权限');
          return;
        }
        this.k.peerVerifiedSeq.set(peer, seq);
        peer.role = role;
        this.k.safeSend(peer, { t: 'role', role });
        this.k.safeSend(peer, { t: 'layout', positions: r.layout });
        this.k.safeSend(peer, { t: 'sections', sections: r.sections });
        return;
      }
    } catch (err) {
      removePeer();
      throw err;
    }

    removePeer('权限状态正在变更，请重试');
  }

  async leave(branchId: string, peer: Peer) {
    // 房间未加载或分支已被删掉时直接返回，避免滞后的 onClose 误触发重新加载
    const pending = this.k.rooms.get(branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r) return;
    const hadClient = Boolean(peer.client);
    // 已经被踢掉的连接走 onClose 时不用再广播一次
    if (!r.peers.delete(peer)) return;
    this.peers.broadcastPeers(r);
    try {
      if (hadClient) await this.peers.publishRoomPeers(branchId, r);
    } finally {
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
  }

  /** 仅在当前副本踢出指定用户的所有在线连接 */
  async kickUserLocal(userId: string, reason = '账号已被停用') {
    this.k.bumpRefreshGen();
    for (const [branchId, pending] of this.k.rooms) {
      const r = await pending.catch(() => null);
      if (!r) continue;
      let removed = false;
      let removedClient = false;
      for (const peer of [...r.peers]) {
        if (peer.user.id !== userId) continue;
        if (peer.client) removedClient = true;
        r.peers.delete(peer);
        peer.close?.(4403, reason);
        removed = true;
      }
      if (removed) {
        this.peers.broadcastPeers(r);
        try {
          if (removedClient) await this.peers.publishRoomPeers(branchId, r);
        } finally {
          this.k.scheduleIdleEvictIfNeeded(branchId, r);
        }
      }
    }
  }

  /** 踢出指定用户的所有在线连接（本地立即断开并经事件总线广播给其他副本） */
  async kickUser(userId: string, reason = '账号已被停用') {
    await this.kickUserLocal(userId, reason);
    await this.k.publish({ t: 'room.kick', userId, reason });
  }

  /**
   * 仅在当前副本重算已加载房间（或指定分支子集）里每个在线 peer 的生效角色（G6）。
   *
   * 采用单飞串行 + 合并重跑保护：并发到达的多次刷新不会交错乱序写回，期间新来的请求会合并为下一轮重跑；
   * 每次发起与切换轮次都会推进刷新代际，避免挂起中的 join 用旧角色覆写回去。
   */
  async refreshLoadedLocal(branchIds?: string[]): Promise<void> {
    if (branchIds && branchIds.length === 0) return;
    const target: RefreshTarget = branchIds ? new Set(branchIds) : 'all';
    this.k.bumpRefreshGen(target === 'all' ? undefined : target);

    if (this.refreshActive) {
      this.mergePendingRefresh(target);
      if (!this.pendingRefreshWait) {
        let resolve!: () => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        promise.catch(() => {});
        this.pendingRefreshWait = { promise, resolve, reject };
      }
      return this.pendingRefreshWait.promise;
    }

    this.refreshActive = true;
    let resolveFirst!: () => void;
    let rejectFirst!: (err: unknown) => void;
    const firstPromise = new Promise<void>((res, rej) => {
      resolveFirst = res;
      rejectFirst = rej;
    });

    const initialSeq = this.k.refreshSeq;
    const loop = (async () => {
      let nextTarget: RefreshTarget | null = target;
      let nextSeq = initialSeq;
      let nextWait: { resolve: () => void; reject: (err: unknown) => void } = {
        resolve: resolveFirst,
        reject: rejectFirst,
      };
      try {
        while (nextTarget) {
          try {
            await this.runRefreshLoadedLocal(nextTarget, nextSeq);
            nextWait.resolve();
          } catch (err) {
            nextWait.reject(err);
          }
          if (!this.pendingRefreshTarget || !this.pendingRefreshWait) {
            nextTarget = null;
            break;
          }
          nextTarget = this.pendingRefreshTarget;
          nextWait = this.pendingRefreshWait;
          this.pendingRefreshTarget = null;
          this.pendingRefreshWait = null;
          this.k.bumpRefreshGen(nextTarget === 'all' ? undefined : nextTarget);
          nextSeq = this.k.refreshSeq;
        }
      } finally {
        this.refreshActive = false;
        this.refreshInFlight = null;
      }
    })();
    this.refreshInFlight = loop;
    return firstPromise;
  }

  /**
   * 执行单轮本地权限刷新（由 refreshLoadedLocal 串行调度）：
   * - 只遍历 this.rooms：没人在线的分支不在里面，所以没有连接时整次刷新是零查询；
   * - 分支 → 项目用一条查询反查，角色上下文按用户缓存，整次刷新共享；
   * - 分支已不存在（项目被删除）→ 4403 断开并移除房间缓存；
   * - 没有权限了 / 账号被停用 → 4403 断开（沿用停用账号的关闭码，客户端收到后不再重连）；
   * - 降级 / 升级 → 同步更新 peer.user.role 与 peer.role 并发一条 role 消息，客户端切换只读。
   */
  private async runRefreshLoadedLocal(target: RefreshTarget, roundSeq: number) {
    const targets =
      target === 'all' ? [...this.k.rooms.keys()] : [...target].filter((id) => this.k.rooms.has(id));
    if (targets.length === 0) return;
    // 分支 → 项目只反查一次（同一个项目可能有多个分支的房间）
    const projects = await this.k.db.query<{ branchId: string; projectId: string }>(
      `select id as "branchId", project_id as "projectId" from branches where id in (${inList(targets)})`,
      targets,
    );
    const projectByBranch = new Map(projects.map((p) => [p.branchId, p.projectId]));
    // 整次刷新共用：用户当前状态（可能刚被停用 / 改了实例角色 / 重置了临时密码）+ 角色上下文 / 项目缓存
    const users = new Map<
      string,
      { role: User['role']; status: User['status']; mustChangePassword: boolean } | null
    >();
    const lookup: RoleLookup = { contexts: new Map(), projects: new Map() };
    const kick = (r: Loaded, peer: Peer, reason: string) => {
      r.peers.delete(peer);
      peer.close?.(4403, reason);
    };

    for (const branchId of targets) {
      const pending = this.k.rooms.get(branchId);
      if (!pending) continue;
      const r = await pending.catch(() => null);
      if (!r) continue;
      const projectId = projectByBranch.get(branchId);
      if (!projectId) {
        const hadClients = this.peers.localPeerList(r).length > 0;
        this.k.clearIdleEvict(r);
        this.layout.clearLayoutTimer(r);
        this.sections.clearSectionsTimer(r);
        r.evicted = true;
        for (const peer of [...r.peers]) kick(r, peer, '项目已被删除');
        if (this.k.rooms.get(branchId) === pending) this.k.rooms.delete(branchId);
        this.k.branchRefreshGen.delete(branchId);
        if (hadClients) await this.k.publish({ t: 'room.peers', branchId, peers: [] });
        continue;
      }
      let removed = false;
      let removedClient = false;
      for (const peer of [...r.peers]) {
        if (!r.peers.has(peer)) continue;
        if ((this.k.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        let current = users.get(peer.user.id);
        if (current === undefined) {
          current = await this.fetchUserState(peer.user.id);
          users.set(peer.user.id, current);
        }
        if (!r.peers.has(peer)) continue;
        if ((this.k.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        if (current?.status !== 'active') {
          if (peer.client) removedClient = true;
          kick(r, peer, '账号已被停用');
          removed = true;
          continue;
        }
        if (current.mustChangePassword) {
          if (peer.client) removedClient = true;
          kick(r, peer, '密码已重置，请重新登录并修改密码');
          removed = true;
          continue;
        }
        if (peer.user.role !== current.role) {
          peer.user = { ...peer.user, role: current.role };
        }
        const role = await this.resolveRole(peer.user, projectId, lookup);
        if (!r.peers.has(peer)) continue;
        if ((this.k.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        if (!role) {
          if (peer.client) removedClient = true;
          kick(r, peer, '你在这个项目里已经没有权限');
          removed = true;
          continue;
        }
        if (role !== peer.role) {
          peer.role = role;
          this.k.safeSend(peer, { t: 'role', role });
        }
      }
      // 只给真正踢掉了人的房间广播在线列表
      if (removed) {
        this.peers.broadcastPeers(r);
        try {
          if (removedClient) await this.peers.publishRoomPeers(branchId, r);
        } finally {
          this.k.scheduleIdleEvictIfNeeded(branchId, r);
        }
      }
    }
  }

  /**
   * 角色可能变了之后，重算所有副本上已加载房间（或指定分支子集）里每个在线 peer 的生效角色。
   * 组成员、组 / 项目默认权限、授权、转组、删除组、停用或改实例角色之后都调用它。
   */
  async refreshLoaded(branchIds?: string[]) {
    await this.refreshLoadedLocal(branchIds);
    await this.k.publish(branchIds ? { t: 'room.refresh', branchIds } : { t: 'room.refresh' });
  }

  /**
   * 分支被删掉（项目被删除）时立即断开里面所有连接：和“没有权限了”用同一个关闭码 4403，
   * 客户端收到后不会再重连。房间从缓存里移除，避免继续拿着已经不存在的分支，并通知其他副本清理。
   */
  async kickBranches(branchIds: string[], reason: string) {
    if (branchIds.length > 0) this.k.bumpRefreshGen(branchIds);
    const gone = new Set(branchIds);
    for (const [branchId, pending] of this.k.rooms) {
      if (!gone.has(branchId)) continue;
      const r = await pending.catch(() => null);
      let hadClients = false;
      if (r) {
        hadClients = this.peers.localPeerList(r).length > 0;
        this.k.clearIdleEvict(r);
        this.layout.clearLayoutTimer(r);
        this.sections.clearSectionsTimer(r);
        r.evicted = true;
        for (const peer of [...r.peers]) {
          r.peers.delete(peer);
          peer.close?.(4403, reason);
        }
      }
      if (this.k.rooms.get(branchId) === pending) this.k.rooms.delete(branchId);
      this.k.branchRefreshGen.delete(branchId);
      if (hadClients) await this.k.publish({ t: 'room.peers', branchId, peers: [] });
    }
    if (branchIds.length > 0) {
      await this.k.publish({ t: 'room.refresh', branchIds });
    }
  }

  /** 优雅断开本副本所有在线房间连接（停机时通知客户端重连并向集群广播离线快照，避免持久连接阻塞 HTTP 服务关闭） */
  async disconnectAll(code = 1001, reason = '服务正在关闭') {
    for (const [branchId, pending] of this.k.rooms) {
      const r = await pending.catch(() => null);
      if (!r) continue;
      const hadClients = this.peers.localPeerList(r).length > 0;
      for (const peer of [...r.peers]) {
        r.peers.delete(peer);
        try {
          peer.close?.(code, reason);
        } catch {}
      }
      try {
        if (hadClients) await this.k.publish({ t: 'room.peers', branchId, peers: [] });
      } finally {
        this.k.scheduleIdleEvictIfNeeded(branchId, r);
      }
    }
  }
}
