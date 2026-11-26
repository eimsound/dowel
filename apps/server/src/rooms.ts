// 同步房间的管理：每个分支一个房间，按需从数据库加载（最新快照 + 之后的操作日志），
// 修改持久化后广播给房间里的所有连接；另外转发画布布局和在线状态这两类不进操作日志的消息。
//
// 本文件是统一门面：`Rooms` 只负责组装 rooms/ 下各职责子模块并保持原有公开 API 与导出不变：
// - rooms/kernel.ts：房间注册表、withRoomLock、REPEATABLE READ 追赶、空闲卸载、刷新代际、事件发布
// - rooms/ops.ts：WS hello / op 与系统 replace / patch 的有序持久化
// - rooms/access.ts + rooms/peers.ts：成员准入、权限刷新单飞队列、跨副本在线成员与 presence
// - rooms/layout.ts + rooms/sections.ts：画布布局 / 板块的 LWW 同步、防抖落盘与超限重载
// - rooms/history.ts：画布修改历史；rooms/mcp.ts：MCP 原子批量写入（板块增量写入 manage_sections 在 rooms/sections.ts）
// - rooms/cluster.ts：集群事件分派与事件总线重连补偿

import type { CanvasHistoryEntry, CanvasHistoryList, CanvasSection } from '@dowel/api';
import type { Model, Obj } from '@dowel/core';
import type { Commit, ToServer, Versions } from '@dowel/sync';

import type { EventBus } from './bus.ts';
import type { PlatformDb } from './db.ts';
import type { HaCoordinator } from './ha.ts';
import { RoomAccess } from './rooms/access.ts';
import { RoomCluster } from './rooms/cluster.ts';
import { CanvasHistory } from './rooms/history.ts';
import { RoomKernel } from './rooms/kernel.ts';
import { LayoutSync } from './rooms/layout.ts';
import { type ApplyMcpOpsOptions, type ApplyMcpOpsResult, McpWriter } from './rooms/mcp.ts';
import { RoomOps } from './rooms/ops.ts';
import { RoomPeers } from './rooms/peers.ts';
import { type ManageSectionsOptions, type ManageSectionsResult, SectionsSync } from './rooms/sections.ts';
import type { ExtraIn, Loaded, Peer, ResolveRole, RoomsOptions } from './rooms/types.ts';

export {
  type ApplyMcpChangedItem,
  type ApplyMcpOpInput,
  type ApplyMcpOpsOptions,
  type ApplyMcpOpsResult,
  MCP_DISALLOWED_MUTATORS,
} from './rooms/mcp.ts';
export { type ManageSectionsOptions, type ManageSectionsResult } from './rooms/sections.ts';
export {
  type Extra,
  type ExtraIn,
  type Layout,
  type Peer,
  type ResolveRole,
  type Role,
  type RoomsOptions,
  SNAPSHOT_EVERY,
  WorkingChangedError,
} from './rooms/types.ts';

/** 空闲房间（无在线成员且无待落盘布局）默认超时卸载时间（毫秒） */
const DEFAULT_IDLE_EVICT_MS = 5 * 60_000;
/** 画布布局防抖落盘默认延迟（毫秒） */
const DEFAULT_LAYOUT_DEBOUNCE_MS = 500;
/** 画布布局防抖落盘失败默认最大重试次数 */
const DEFAULT_LAYOUT_FLUSH_MAX_RETRIES = 3;
/** 画布布局防抖落盘重试默认基础退避间隔（毫秒） */
const DEFAULT_LAYOUT_RETRY_BASE_MS = 500;

export class Rooms {
  /**
   * 有新的修改提交之后调用的可选钩子（默认空操作）。
   * 派生数据已改为按需规范化（ADR 0016），createApp 不再挂这个钩子做后台影子库刷新；保留给测试与扩展用。
   */
  onCommit: (branchId: string) => void = () => {};

  private k: RoomKernel;
  private layout: LayoutSync;
  private sections: SectionsSync;
  private peers: RoomPeers;
  private access: RoomAccess;
  private ops: RoomOps;
  private mcp: McpWriter;
  private history: CanvasHistory;
  private cluster: RoomCluster;
  private unsubBus: (() => void)[] = [];

  constructor(
    db: PlatformDb,
    resolveRole: ResolveRole,
    bus?: EventBus,
    ha?: Pick<HaCoordinator, 'replicaId' | 'aliveNodes'>,
    options?: RoomsOptions,
  ) {
    const rawIdle = options?.idleEvictMs;
    const idleEvictMs =
      rawIdle === undefined ? DEFAULT_IDLE_EVICT_MS : rawIdle <= 0 || !Number.isFinite(rawIdle) ? 0 : rawIdle;
    const rawLayoutDebounce = options?.layoutDebounceMs;
    const layoutDebounceMs =
      rawLayoutDebounce !== undefined && Number.isFinite(rawLayoutDebounce) && rawLayoutDebounce >= 0
        ? rawLayoutDebounce
        : DEFAULT_LAYOUT_DEBOUNCE_MS;
    const rawLayoutMaxRetries = options?.layoutMaxRetries;
    const layoutMaxRetries =
      rawLayoutMaxRetries !== undefined && Number.isFinite(rawLayoutMaxRetries) && rawLayoutMaxRetries >= 0
        ? Math.floor(rawLayoutMaxRetries)
        : DEFAULT_LAYOUT_FLUSH_MAX_RETRIES;
    const rawLayoutRetryBase = options?.layoutRetryBaseMs;
    const layoutRetryBaseMs =
      rawLayoutRetryBase !== undefined && Number.isFinite(rawLayoutRetryBase) && rawLayoutRetryBase >= 0
        ? rawLayoutRetryBase
        : DEFAULT_LAYOUT_RETRY_BASE_MS;
    const debounce = {
      debounceMs: layoutDebounceMs,
      maxRetries: layoutMaxRetries,
      retryBaseMs: layoutRetryBaseMs,
    };
    const notifyCommit = (branchId: string) => this.onCommit(branchId);

    this.k = new RoomKernel(db, bus, ha, idleEvictMs);
    this.layout = new LayoutSync(this.k, debounce);
    this.sections = new SectionsSync(this.k, debounce);
    this.peers = new RoomPeers(this.k);
    this.access = new RoomAccess(this.k, this.peers, this.layout, this.sections, resolveRole);
    this.ops = new RoomOps(this.k, this.peers, notifyCommit);
    this.mcp = new McpWriter(this.k, notifyCommit);
    this.history = new CanvasHistory(this.k);
    this.cluster = new RoomCluster(this.k, this.peers, this.layout, this.sections, this.access);

    if (bus) {
      this.unsubBus.push(
        bus.onEvent((event) => this.cluster.handleClusterEvent(event)),
        bus.onReconnect(() => this.cluster.handleBusReconnect()),
      );
      if (ha) this.peers.startPruneTimer();
    }
  }

  /** 取消集群事件总线订阅、空闲卸载定时器与后台清理定时器，并在仍有未清空本地成员时广播离线快照（关闭实例或测试清理时调用） */
  close() {
    if (this.k.closed) return;
    this.k.closed = true;
    for (const off of this.unsubBus) off();
    this.unsubBus = [];
    this.peers.stopPruneTimer();
    this.k.clearAllIdleTimers();
    this.layout.clearAllLayoutTimers();
    this.sections.clearAllSectionsTimers();
    this.peers.publishOfflineOnClose();
  }

  /** 新建分支时写入初始模型（序号 0 的快照） */
  init(branchId: string, model: Model): Promise<void> {
    return this.k.init(branchId, model);
  }

  get(branchId: string): Promise<Loaded> {
    return this.k.get(branchId);
  }

  /** 对已加载的房间从平台库追赶新提交与拒绝记录，并广播给本地在线连接 */
  catchUp(branchId: string, opts?: { minSeq?: number }): Promise<Commit[]> {
    return this.k.catchUp(branchId, opts);
  }

  /** 结合 HA 租约清理已离线副本残留的 remotePeers，并在列表变动时广播给本地在线成员 */
  pruneDeadRemotePeers(): Promise<void> {
    return this.peers.pruneDeadRemotePeers();
  }

  /**
   * 加入房间。**先**把 peer 放进集合，再按刷新代际循环复查，避免“升级之后、join 之前/期间”状态已经变了
   * （详见 rooms/access.ts）。join 成功（含重连）后总会发一条 role，前端以它为准校正本地状态。
   */
  join(branchId: string, peer: Peer): Promise<void> {
    return this.access.join(branchId, peer);
  }

  leave(branchId: string, peer: Peer): Promise<void> {
    return this.access.leave(branchId, peer);
  }

  async message(branchId: string, peer: Peer, msg: ToServer | ExtraIn) {
    const pending = this.k.rooms.get(branchId);
    if (!pending) return;
    const r = await pending.catch(() => null);
    if (!r || !this.k.isCurrentEntry(branchId, r)) return;
    // 不在房间里（例如账号刚被停用踢掉）就直接丢弃：不提交、不广播、不回消息
    if (!r.peers.has(peer)) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      await this.ops.handleHello(branchId, r, peer, msg);
      return;
    }
    if (msg.t === 'op') {
      await this.ops.handleOp(branchId, r, peer, msg);
      return;
    }
    if (msg.t === 'layout') {
      await this.layout.handleLocalLayout(branchId, r, peer, msg);
      return;
    }
    if (msg.t === 'sections') {
      await this.sections.handleLocalSections(branchId, r, peer, msg);
      return;
    }
    if (msg.t === 'presence' && peer.client) {
      await this.peers.handleLocalPresence(branchId, r, peer, peer.client, msg.data);
    }
  }

  /** 服务器以系统身份替换整个模型（导入 DDL、恢复历史、接入领先环境等）；传入 expectedSeq 时原子校验当前 seq */
  replace(branchId: string, user: string, next: Model, opName?: string, expectedSeq?: number): Promise<void> {
    return this.ops.replace(branchId, user, next, opName, expectedSeq);
  }

  /** 服务器以系统身份更新派生数据（期间被别人改过的对象不写） */
  patch(
    branchId: string,
    user: string,
    objects: Obj[],
    expect: Versions,
  ): Promise<{ committed: boolean; rejected: boolean; seq: number }> {
    return this.ops.patch(branchId, user, objects, expect);
  }

  async state(branchId: string): Promise<{ model: Model; versions: Versions; seq: number }> {
    return this.k.readFresh(branchId, (room) => ({
      model: structuredClone(room.model),
      versions: { ...room.versions },
      seq: room.seq,
    }));
  }

  /**
   * 画布只读上下文（get_model）：单次房间锁内原子拍下模型、对象版本、seq 与板块，
   * 再与 DB 板块做一次 freshestSections 比较，保证跨副本 manage_sections 提交后立即强一致可见。
   */
  async canvasState(branchId: string): Promise<{
    model: Model;
    versions: Versions;
    seq: number;
    sections: CanvasSection[];
    sectionsVer: number;
  }> {
    const snap = await this.k.readFresh(branchId, (room, r) => ({
      r,
      model: structuredClone(room.model),
      versions: { ...room.versions },
      seq: room.seq,
      sections: structuredClone(r.sections),
      sectionsVersion: r.sectionsVersion,
      sectionsPending: r.sectionsPending,
    }));
    const fresh = await this.sections.readFreshest(branchId, snap.r, {
      sections: snap.sections,
      version: snap.sectionsVersion,
      pending: snap.sectionsPending,
    });
    return {
      model: snap.model,
      versions: snap.versions,
      seq: snap.seq,
      sections: fresh.sections,
      sectionsVer: fresh.ver,
    };
  }

  /**
   * 代表 MCP 令牌增量调整画布板块（纯布局层：只写 branches.sections / sections_ver，不进 IR、room_commits 与 seq）。
   * 锁序：withActiveRoomLock → 板块 IO 锁 → DB 事务（PG `branches FOR UPDATE` + catchUpFrom）→ 释放锁后广播。
   */
  manageSections(branchId: string, opts: ManageSectionsOptions): Promise<ManageSectionsResult> {
    return this.sections.manage(branchId, opts);
  }

  async model(branchId: string): Promise<{ model: Model; seq: number }> {
    return this.k.readFresh(branchId, (room) => ({
      model: structuredClone(room.model),
      seq: room.seq,
    }));
  }

  /**
   * 代表 MCP 令牌向工作副本应用一批原子操作（支持 baseSeq 冲突检测、`$ref:<alias>` 占位符与 `dryRun`）。
   * 锁顺序与 WS 提交一致：withActiveRoomLock → DB 事务（PG `branches FOR UPDATE` + catchUpFrom）→ 释放锁后广播与触发派生刷新。
   */
  applyMcpOps(branchId: string, opts: ApplyMcpOpsOptions): Promise<ApplyMcpOpsResult> {
    return this.mcp.apply(branchId, opts);
  }

  /**
   * 重建任意 seq（含 0）的完整模型：从不大于 seq 的最新快照出发，按序重放后续提交。
   * seq < 0 或超过当前最新 seq 时抛 404。
   */
  modelAt(branchId: string, seq: number): Promise<Model> {
    return this.history.modelAt(branchId, seq);
  }

  /** 分页倒序查询画布修改历史；翻到末尾时附带 seq = 0 初始状态，并匹配已发布版本标记 */
  listHistory(
    branchId: string,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<CanvasHistoryList> {
    return this.history.listHistory(branchId, opts);
  }

  /** 读取单条历史记录的元信息（用于详情接口；若提供 prevModel/targetModel 可精确解析被删对象名） */
  historyEntry(
    branchId: string,
    seq: number,
    context?: { prevModel?: Model | null; targetModel?: Model; currentSeq?: number },
  ): Promise<CanvasHistoryEntry> {
    return this.history.historyEntry(branchId, seq, context);
  }

  /** 仅在当前副本踢出指定用户的所有在线连接 */
  kickUserLocal(userId: string, reason = '账号已被停用'): Promise<void> {
    return this.access.kickUserLocal(userId, reason);
  }

  /** 踢出指定用户的所有在线连接（本地立即断开并经事件总线广播给其他副本） */
  kickUser(userId: string, reason = '账号已被停用'): Promise<void> {
    return this.access.kickUser(userId, reason);
  }

  /**
   * 仅在当前副本重算已加载房间（或指定分支子集）里每个在线 peer 的生效角色（G6）。
   * 单飞串行 + 合并重跑，并推进刷新代际，避免挂起中的 join 用旧角色覆写回去。
   */
  refreshLoadedLocal(branchIds?: string[]): Promise<void> {
    return this.access.refreshLoadedLocal(branchIds);
  }

  /**
   * 角色可能变了之后，重算所有副本上已加载房间（或指定分支子集）里每个在线 peer 的生效角色。
   * 组成员、组 / 项目默认权限、授权、转组、删除组、停用或改实例角色之后都调用它。
   */
  refreshLoaded(branchIds?: string[]): Promise<void> {
    return this.access.refreshLoaded(branchIds);
  }

  /**
   * 分支被删掉（项目被删除）时立即断开里面所有连接：和“没有权限了”用同一个关闭码 4403，
   * 客户端收到后不会再重连。房间从缓存里移除，避免继续拿着已经不存在的分支，并通知其他副本清理。
   */
  kickBranches(branchIds: string[], reason: string): Promise<void> {
    return this.access.kickBranches(branchIds, reason);
  }

  /** 测试和排查用：这个分支的房间是否已经加载在内存里 */
  has(branchId: string): boolean {
    return this.k.rooms.has(branchId);
  }

  /** 优雅断开本副本所有在线房间连接（停机时通知客户端重连并向集群广播离线快照，避免持久连接阻塞 HTTP 服务关闭） */
  disconnectAll(code = 1001, reason = '服务正在关闭'): Promise<void> {
    return this.access.disconnectAll(code, reason);
  }

  /** 立即写入所有挂起的布局，并等待进行中的房间操作与在途布局落库完成（关闭服务和测试时用） */
  async flush() {
    while (this.access.refreshInFlight) {
      await this.access.refreshInFlight.catch(() => {});
    }
    if (this.peers.pruneInFlight) {
      await this.peers.pruneInFlight.catch(() => {});
    }
    if (this.k.pendingBackgroundPublishes.size > 0) {
      await Promise.allSettled([...this.k.pendingBackgroundPublishes]);
    }
    for (const [branchId, p] of this.k.rooms) {
      const r = await p.catch(() => null);
      if (!r) continue;
      await r.lock.catch(() => {});
      this.layout.clearLayoutTimer(r);
      this.sections.clearSectionsTimer(r);
      if (r.layoutIoCount > 0 || Object.keys(r.pendingLayout).length > 0) {
        await this.layout.flushLayout(branchId, r);
      }
      if (r.sectionsIoCount > 0 || r.sectionsPending) {
        await this.sections.flushSections(branchId, r);
      }
      this.k.scheduleIdleEvictIfNeeded(branchId, r);
    }
  }
}
