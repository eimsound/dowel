// 同步房间的管理：每个分支一个房间，按需从数据库加载（最新快照 + 之后的操作日志），
// 修改持久化后广播给房间里的所有连接；另外转发画布布局和在线状态这两类不进操作日志的消息。

import type { CanvasHistoryEntry, CanvasHistoryList, CanvasHistoryVersionRef, Role } from '@dowel/api';
import type { Model, Obj } from '@dowel/core';
import type { Db } from '@dowel/engines';
import {
  type Commit,
  emptyRoomState,
  isValidClientId,
  type Op,
  type Out,
  type Rejection,
  Room,
  type RoomState,
  type RoomStore,
  SYSTEM_CLIENT,
  type ToClient,
  type ToServer,
  type Versions,
} from '@dowel/sync';
import { HTTPException } from 'hono/http-exception';
import type { User } from './auth.ts';
import {
  type ClusterEvent,
  type ClusterEventPayload,
  type EventBus,
  type RoomPeerInfo,
  truncateRoomPeersForEvent,
} from './bus.ts';
import { inList, type PlatformDb } from './db.ts';
import type { HaCoordinator } from './ha.ts';
import type { RoleLookup } from './roles.ts';
import { atOf } from './time.ts';

export type { Role } from '@dowel/api';

const SNAPSHOT_EVERY = 200;
const HISTORY_SUMMARY_LIMIT = 5;
/** join 复查权限时因并发刷新触发重查的最大尝试次数 */
const MAX_JOIN_VERIFY_ATTEMPTS = 8;
/** 单条 room.layout 集群事件内联发送的安全字节上限（留足余量，低于 PG NOTIFY 7500B 上限） */
const LAYOUT_INLINE_MAX_BYTES = 7000;
/** 单条 room.peers 集群事件的安全字节上限 */
const PEERS_EVENT_MAX_BYTES = 7000;
/** 定期结合 HA 租约清理已离线副本残留 remotePeers 的间隔（毫秒） */
const PEER_PRUNE_INTERVAL_MS = 10_000;

type RefreshTarget = 'all' | Set<string>;

/** 将客户端上报的 client 标识绑定到当前认证用户，在 Room 幂等表与持久化层跨副本彻底隔离不同用户 */
const scopeClient = (userId: string, client: string): string => `${userId}:${client}`;

/** 将客户端待确认版本引用 `p:${rawClient}:${n}` 改写为绑定用户后的 `p:${scopedClient}:${n}` */
const rewriteReadsToScoped = (reads: Op['reads'], rawClient: string, scopedClient: string): Op['reads'] => {
  const prefix = `p:${rawClient}:`;
  return reads.map(([id, seen]) => {
    if (typeof seen === 'string' && seen.startsWith(prefix)) {
      return [id, `p:${scopedClient}:${seen.slice(prefix.length)}`];
    }
    return [id, seen];
  });
};

const TOP_LEVEL_KINDS = new Set<Obj['kind']>(['table', 'enum', 'sequence', 'opaque', 'extension', 'schema']);

const objectLabel = (obj: Obj, objects: Record<string, Obj>): string => {
  if ('parent' in obj && !TOP_LEVEL_KINDS.has(obj.kind)) {
    const parent = objects[obj.parent];
    if (parent) return `${parent.name}.${obj.name}`;
  }
  return obj.name;
};

const summarizeChanges = (
  changes: Commit['changes'],
  knownNames: Map<string, string>,
  fallbackObjects: Record<string, Obj>,
): string[] => {
  const localObjects: Record<string, Obj> = { ...fallbackObjects };
  for (const ch of changes) if (ch.obj) localObjects[ch.id] = ch.obj;

  const top: string[] = [];
  const sub: string[] = [];
  const seen = new Set<string>();
  const push = (bucket: string[], label: string | undefined) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    bucket.push(label);
  };

  for (const ch of changes) {
    if (ch.obj) {
      if (ch.obj.kind === 'schema' && ch.obj.name === 'public' && changes.length > 1) continue;
      const label = objectLabel(ch.obj, localObjects);
      push(TOP_LEVEL_KINDS.has(ch.obj.kind) ? top : sub, label);
    } else {
      const known = knownNames.get(ch.id);
      push(sub, known);
    }
  }
  return [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT);
};

const summarizeModel = (model: Model): { changeCount: number; summary: string[] } => {
  const objs = Object.values(model.objects).filter((o) => o.kind !== 'schema');
  if (!objs.length) return { changeCount: 0, summary: [] };
  const top: string[] = [];
  const sub: string[] = [];
  const seen = new Set<string>();
  const push = (bucket: string[], label: string) => {
    if (seen.has(label)) return;
    seen.add(label);
    bucket.push(label);
  };
  for (const o of objs) {
    const label = objectLabel(o, model.objects);
    push(TOP_LEVEL_KINDS.has(o.kind) ? top : sub, label);
  }
  return { changeCount: objs.length, summary: [...top, ...sub].slice(0, HISTORY_SUMMARY_LIMIT) };
};

/** 画布布局：表 ID → 位置。同一张表后到的覆盖先到的，不检查冲突（拖动不应被拒绝） */
export type Layout = Record<string, { x: number; y: number }>;

/** 服务器发给客户端的、同步协议之外的消息 */
export type Extra =
  | { t: 'layout'; positions: Layout }
  | { t: 'presence'; client: string; user: string; data: unknown }
  | { t: 'peers'; peers: { client: string; user: string }[] }
  // 生效角色变了（授权、组成员、默认权限变动后）：客户端据此切换只读 / 可编辑
  | { t: 'role'; role: Role };
/** 客户端发给服务器的、同步协议之外的消息 */
export type ExtraIn = { t: 'layout'; positions: Layout } | { t: 'presence'; data: unknown };

export interface Peer {
  user: User;
  /** 当前的生效项目角色；由 roles.ts 算出，房间据此拒绝修改并通知角色变化 */
  role: Role;
  client?: string;
  send(msg: ToClient | Extra): void;
  /** 停用用户时由服务端主动关闭连接（routes/sync.ts 里接到 ws.close） */
  close?(code: number, reason: string): void;
}

/** 注入的生效角色计算；批量刷新时带上共享缓存 */
export type ResolveRole = (user: User, projectId: string, lookup?: RoleLookup) => Promise<Role | null>;

interface LayoutVersion {
  ver: number;
  origin: string;
}

const isNewerLayoutVersion = (incoming: LayoutVersion, existing: LayoutVersion | undefined): boolean => {
  if (!existing) return true;
  if (incoming.ver !== existing.ver) return incoming.ver > existing.ver;
  return incoming.origin >= existing.origin;
};

interface Loaded {
  room: Room;
  /** 已同步到内存的 room_rejections 最大游标 id（同分支写事务由 branches FOR UPDATE 串行提交，可安全按 id > 游标增量拉取） */
  lastRejectionId: number;
  peers: Set<Peer>;
  /** 其他副本上已握手的在线成员快照（按远端 replicaId 隔离） */
  remotePeers: Map<string, RoomPeerInfo[]>;
  layout: Layout;
  /** 尚未落库的本地布局改动（PG 下用 jsonb || 增量合并，避免多副本互盖） */
  pendingLayout: Layout;
  /** 房间级布局逻辑时钟（Lamport clock），配合 origin 做确定性 LWW 裁决，避免并发拖动双方互删 pendingLayout */
  layoutClock: number;
  /** 每张表最近一次生效的布局版本（用于忽略乱序/败诉的远端旧坐标） */
  layoutVersions: Map<string, LayoutVersion>;
  layoutTimer?: ReturnType<typeof setTimeout>;
  /** 当前在途的布局落库任务（串行化落库并确保 flush() 等待 SQL 真正完成） */
  layoutFlushing: Promise<void> | null;
  /** 进程内按分支串行化的互斥队列（保护 catchUp / 事务写 / 失败重建不交错） */
  lock: Promise<void>;
  /** 上次事务回滚后重建失败时置为 true，下次操作前强制重载 */
  dirty: boolean;
}

/** 乐观并发冲突：replace 时工作副本的当前 seq 已不等于调用方期望的 seq */
export class WorkingChangedError extends Error {
  readonly currentSeq: number;
  readonly currentModel: Model;
  constructor(currentSeq: number, currentModel: Model) {
    super('工作副本在操作期间已被修改');
    this.name = 'WorkingChangedError';
    this.currentSeq = currentSeq;
    this.currentModel = currentModel;
  }
}

export class Rooms {
  private rooms = new Map<string, Promise<Loaded>>();
  /** 有新的修改提交之后调用（用于安排派生数据的刷新） */
  onCommit: (branchId: string) => void = () => {};

  private db: PlatformDb;
  /**
   * 注入的生效角色计算（app.ts 接到 roles.ts）。join 时用它复查“升级和 join 之间”的角色变化，
   * 和 HTTP 的 access() 是同一套规则。
   */
  private resolveRole: ResolveRole;
  private bus?: EventBus;
  private ha?: Pick<HaCoordinator, 'replicaId' | 'aliveNodes'>;
  private unsubBus: (() => void)[] = [];
  private closed = false;
  private peerPruneTimer: ReturnType<typeof setInterval> | null = null;
  private pruneInFlight: Promise<void> | null = null;
  /** 追踪非阻塞路径（load / close）发起的在途事件发布，供 flush() 排空避免与 db.close() 竞态 */
  private pendingBackgroundPublishes = new Set<Promise<void>>();
  /** 全量权限刷新与全库踢人的代际计数 */
  private globalRefreshGen = 0;
  /** 按分支的定向权限刷新代际计数 */
  private branchRefreshGen = new Map<string, number>();
  /** 单调递增的刷新批次序号，避免旧批次刷新覆盖在更新批次之后完成 join 校验的 peer */
  private refreshSeq = 0;
  /** 记录每个 peer 最近一次完成 join 校验时对应的刷新批次序号 */
  private peerVerifiedSeq = new WeakMap<Peer, number>();
  /** 单飞权限刷新状态：串行执行 refreshLoadedLocal 并合并期间到来的新请求 */
  private refreshActive = false;
  private refreshInFlight: Promise<void> | null = null;
  private pendingRefreshTarget: RefreshTarget | null = null;
  private pendingRefreshWait: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
  } | null = null;

  constructor(
    db: PlatformDb,
    resolveRole: ResolveRole,
    bus?: EventBus,
    ha?: Pick<HaCoordinator, 'replicaId' | 'aliveNodes'>,
  ) {
    this.db = db;
    this.resolveRole = resolveRole;
    this.bus = bus;
    this.ha = ha;
    if (bus) {
      this.unsubBus.push(
        bus.onEvent((event) => this.handleClusterEvent(event)),
        bus.onReconnect(() => this.handleBusReconnect()),
      );
      if (ha) {
        this.peerPruneTimer = setInterval(() => {
          if (this.closed) return;
          void this.pruneDeadRemotePeers().catch((e) => {
            console.error('定期清理离线副本在线成员失败', e);
          });
        }, PEER_PRUNE_INTERVAL_MS);
        this.peerPruneTimer.unref?.();
      }
    }
  }

  /** 取消集群事件总线订阅与后台清理定时器，并在仍有未清空本地成员时广播离线快照（关闭实例或测试清理时调用） */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubBus) off();
    this.unsubBus = [];
    if (this.peerPruneTimer) {
      clearInterval(this.peerPruneTimer);
      this.peerPruneTimer = null;
    }
    if (this.bus) {
      for (const [branchId, pending] of this.rooms) {
        const p = pending
          .then(async (r) => {
            const hadClients = this.localPeerList(r).length > 0;
            if (!hadClients) return;
            for (const peer of [...r.peers]) r.peers.delete(peer);
            await this.publish({ t: 'room.peers', branchId, peers: [] });
          })
          .catch(() => {})
          .finally(() => {
            this.pendingBackgroundPublishes.delete(p);
          });
        this.pendingBackgroundPublishes.add(p);
      }
    }
  }

  /** 新建分支时写入初始模型（序号 0 的快照） */
  async init(branchId: string, model: Model) {
    await this.db.query(
      'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
      [branchId, JSON.stringify(model), '{}'],
    );
  }

  get(branchId: string): Promise<Loaded> {
    let r = this.rooms.get(branchId);
    if (!r) {
      r = this.load(branchId);
      this.rooms.set(branchId, r);
      r.catch(() => this.rooms.delete(branchId));
    }
    return r;
  }

  private makeStore(db: Db, branchId: string, onRejectionId?: (id: number) => void): RoomStore {
    return {
      append: async (commit, op) => {
        await db.query(
          `insert into room_commits (branch_id, seq, client, n, user_name, op_name, op_args, changes)
           values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb)`,
          [
            branchId,
            commit.seq,
            commit.client,
            commit.n,
            commit.user,
            op.name,
            JSON.stringify(op.args ?? null),
            JSON.stringify(commit.changes),
          ],
        );
      },
      reject: async (client, r) => {
        const rows = await db.query<{ id: string | number }>(
          'insert into room_rejections (branch_id, client, n, code, message) values ($1, $2, $3, $4, $5) returning id',
          [branchId, client, r.n, r.code, r.message],
        );
        if (rows[0]) onRejectionId?.(Number(rows[0].id));
      },
    };
  }

  private async loadRoom(branchId: string): Promise<{ room: Room; lastRejectionId: number }> {
    // PG 下用单次 REPEATABLE READ READ ONLY 事务读取 room_snapshots / room_commits / room_rejections，
    // 保证来自同一 MVCC 快照，避免先读 commits 后读 rejections 产生“旧 seq + 新 lastProcessed”读撕裂；
    // SQLite 下用只读事务包在单连接 exclusive 队列内，同样保证整次加载不被并发写入穿插。
    return this.db.transaction(
      async (tx) => {
        const [snap] = await tx.query<{ seq: string; model: Model; versions: Versions }>(
          'select seq, model, versions from room_snapshots where branch_id = $1 order by seq desc limit 1',
          [branchId],
        );
        if (!snap) throw new Error(`分支 ${branchId} 没有初始快照`);
        const state: RoomState = emptyRoomState(snap.model);
        state.versions = snap.versions;
        state.seq = Number(snap.seq);
        const after = await tx.query<{
          seq: string;
          client: string;
          n: number;
          user_name: string;
          changes: Commit['changes'];
        }>(
          'select seq, client, n, user_name, changes from room_commits where branch_id = $1 and seq > $2 order by seq',
          [branchId, state.seq],
        );
        for (const c of after) {
          const seq = Number(c.seq);
          for (const ch of c.changes) {
            if (ch.obj) {
              state.model.objects[ch.id] = ch.obj;
              state.versions[ch.id] = seq;
            } else {
              delete state.model.objects[ch.id];
              delete state.versions[ch.id];
            }
          }
          state.seq = seq;
        }
        // 最近的提交用于给重连的客户端补发（限定 seq <= state.seq，防止并发写入导致 log 领先于 model）
        const recent = await tx.query<{
          seq: string;
          client: string;
          n: number;
          user_name: string;
          changes: Commit['changes'];
        }>(
          `select seq, client, n, user_name, changes from
             (select * from room_commits where branch_id = $1 and seq <= $2 order by seq desc limit 2000) x order by seq`,
          [branchId, state.seq],
        );
        state.log = recent.map((c) => ({
          t: 'commit',
          seq: Number(c.seq),
          client: c.client,
          n: Number(c.n),
          user: c.user_name,
          changes: c.changes,
        }));
        for (const r of await tx.query<{ client: string; n: number }>(
          'select client, max(n) as n from room_commits where branch_id = $1 and seq <= $2 group by client',
          [branchId, state.seq],
        ))
          state.processed[r.client] = Number(r.n);
        let lastRejectionId = 0;
        for (const r of await tx.query<{
          id: string | number;
          client: string;
          n: number;
          code: Rejection['code'];
          message: string;
        }>('select id, client, n, code, message from room_rejections where branch_id = $1 order by id asc', [
          branchId,
        ])) {
          const id = Number(r.id);
          const n = Number(r.n);
          if (id > lastRejectionId) lastRejectionId = id;
          if ((state.processed[r.client] ?? 0) < n) state.processed[r.client] = n;
          state.rejections[r.client] = [
            ...(state.rejections[r.client] ?? []),
            { n, code: r.code, message: r.message },
          ];
        }
        for (const list of Object.values(state.rejections)) {
          list.sort((a, b) => a.n - b.n);
        }

        // Room 的默认 store 绑定顶层 this.db（不可绑定短生命周期只读快照 tx）
        return { room: new Room(state, this.makeStore(this.db, branchId)), lastRejectionId };
      },
      { isolationLevel: 'repeatable_read', readOnly: true },
    );
  }

  private async load(branchId: string): Promise<Loaded> {
    const { room, lastRejectionId } = await this.loadRoom(branchId);
    const [b] = await this.db.query<{ layout: Layout }>('select layout from branches where id = $1', [
      branchId,
    ]);
    const loaded: Loaded = {
      room,
      lastRejectionId,
      peers: new Set(),
      remotePeers: new Map(),
      layout: b?.layout ?? {},
      pendingLayout: {},
      layoutClock: 0,
      layoutVersions: new Map(),
      layoutFlushing: null,
      lock: Promise.resolve(),
      dirty: false,
    };
    if (this.bus && !this.closed) {
      // 房间首次加载时向其他副本请求一次该分支的在线成员快照
      void this.trackPublish({ t: 'room.peers.sync', branchId });
    }
    return loaded;
  }

  private async reloadLocked(branchId: string, r: Loaded) {
    const { room, lastRejectionId } = await this.loadRoom(branchId);
    r.room = room;
    r.lastRejectionId = lastRejectionId;
    r.dirty = false;
  }

  /** 按分支在当前进程内串行执行，避免同一房间并发修改 / 追赶交错 */
  private async withRoomLock<T>(r: Loaded, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = r.lock;
    r.lock = prev.then(() => mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 无写锁场景的追赶：在单次 REPEATABLE READ READ ONLY 快照事务中增量拉取 commits 与 rejections，避免读撕裂 */
  private catchUpReadOnly(branchId: string, r: Loaded): Promise<Commit[]> {
    return this.db.transaction((tx) => this.catchUpFrom(tx, branchId, r), {
      isolationLevel: 'repeatable_read',
      readOnly: true,
    });
  }

  /**
   * 从给定连接（已有写事务 tx 或顶层 this.db）按游标增量读取更新的提交与拒绝记录并合入内存态：
   * - 若传入顶层 this.db（无写锁路径），自动包裹进 REPEATABLE READ READ ONLY 快照事务；
   * - 若已在写事务 tx（如 branches FOR UPDATE）内调用，直接复用 tx，绝不嵌套新事务。
   */
  private async catchUpFrom(db: Db, branchId: string, r: Loaded): Promise<Commit[]> {
    if (db === this.db) {
      return this.catchUpReadOnly(branchId, r);
    }
    const rows = await db.query<{
      seq: string | number;
      client: string;
      n: number;
      user_name: string;
      changes: Commit['changes'];
    }>(
      'select seq, client, n, user_name, changes from room_commits where branch_id = $1 and seq > $2 order by seq',
      [branchId, r.room.seq],
    );
    const rejections = await db.query<{
      id: string | number;
      client: string;
      n: number;
      code: Rejection['code'];
      message: string;
    }>(
      'select id, client, n, code, message from room_rejections where branch_id = $1 and id > $2 order by id asc',
      [branchId, r.lastRejectionId],
    );
    // 两条查询均完成后再合入内存，避免中途查询失败造成半截内存态
    const applied: Commit[] = [];
    for (const row of rows) {
      const commit: Commit = {
        t: 'commit',
        seq: Number(row.seq),
        client: row.client,
        n: Number(row.n),
        user: row.user_name,
        changes: row.changes,
      };
      if (r.room.applyExternalCommit(commit)) applied.push(commit);
    }
    for (const rej of rejections) {
      r.room.applyExternalRejection(rej.client, {
        n: Number(rej.n),
        code: rej.code,
        message: rej.message,
      });
      const id = Number(rej.id);
      if (id > r.lastRejectionId) r.lastRejectionId = id;
    }
    return applied;
  }

  private async catchUpLoaded(
    branchId: string,
    r: Loaded,
    opts?: { excludePeer?: Peer; minSeq?: number },
  ): Promise<Commit[]> {
    const caughtUp = await this.withRoomLock(r, async () => {
      if (opts?.minSeq !== undefined && !r.dirty && r.room.seq >= opts.minSeq) return [];
      const missed: Commit[] = [];
      if (r.dirty) {
        const prevSeq = r.room.seq;
        await this.reloadLocked(branchId, r);
        if (r.room.seq > prevSeq) {
          const rows = await this.db.query<{
            seq: string | number;
            client: string;
            n: number;
            user_name: string;
            changes: Commit['changes'];
          }>(
            'select seq, client, n, user_name, changes from room_commits where branch_id = $1 and seq > $2 and seq <= $3 order by seq',
            [branchId, prevSeq, r.room.seq],
          );
          for (const row of rows) {
            missed.push({
              t: 'commit',
              seq: Number(row.seq),
              client: row.client,
              n: Number(row.n),
              user: row.user_name,
              changes: row.changes,
            });
          }
        }
      }
      const fresh = await this.catchUpReadOnly(branchId, r);
      return [...missed, ...fresh];
    });
    if (caughtUp.length) this.broadcastCommits(r, caughtUp, opts?.excludePeer);
    return caughtUp;
  }

  /** 对已加载的房间从平台库追赶新提交与拒绝记录，并广播给本地在线连接 */
  async catchUp(branchId: string, opts?: { minSeq?: number }): Promise<Commit[]> {
    const pending = this.rooms.get(branchId);
    if (!pending) return [];
    const r = await pending.catch(() => null);
    if (!r) return [];
    return this.catchUpLoaded(branchId, r, opts);
  }

  /** 读取前确保内存态与平台库一致（PG 模式下追赶外部副本提交，SQLite 下仅在脏态时重载） */
  private async getFresh(branchId: string): Promise<Loaded> {
    const r = await this.get(branchId);
    if (this.db.dialect === 'pg' || r.dirty) {
      await this.catchUpLoaded(branchId, r);
    }
    return r;
  }

  /** 修改之后：每隔一段写一次快照，加快下次加载（传入事务 tx 以与 commit 同事务提交） */
  private async maybeSnapshot(db: Db, branchId: string, room: Room) {
    if (room.seq <= 0 || room.seq % SNAPSHOT_EVERY !== 0) return;
    await db.query(
      'insert into room_snapshots (branch_id, seq, model, versions) values ($1, $2, $3::text::jsonb, $4::text::jsonb) on conflict do nothing',
      [branchId, room.seq, JSON.stringify(room.model), JSON.stringify(room.versions)],
    );
  }

  private safeSend(peer: Peer, msg: ToClient | Extra) {
    try {
      peer.send(msg);
    } catch {
      // 连接可能正在关闭，忽略单个发送失败以免影响房间内其他连接
    }
  }

  private syncClientOf(peer: Peer): string | null {
    return peer.client ? scopeClient(peer.user.id, peer.client) : null;
  }

  /** 发给客户端前映射 commit.client：本连接自己的提交还原为原始 client，系统提交保持 system，他人提交不暴露内部键且不与本连接冲突 */
  private forPeer(peer: Peer, msg: ToClient): ToClient {
    if (msg.t !== 'commit') return msg;
    const ownSync = this.syncClientOf(peer);
    if (ownSync && msg.client === ownSync) {
      return { ...msg, client: peer.client! };
    }
    if (msg.client === SYSTEM_CLIENT) return msg;
    return { ...msg, client: '' };
  }

  private broadcastCommits(r: Loaded, commits: Commit[], excludePeer?: Peer) {
    for (const c of commits) {
      for (const p of r.peers) {
        if (p !== excludePeer) this.safeSend(p, this.forPeer(p, c));
      }
    }
  }

  private deliver(r: Loaded, from: Peer, outs: Out[]) {
    const fromSync = this.syncClientOf(from);
    for (const o of outs) {
      if (o.to === '*') {
        for (const p of r.peers) this.safeSend(p, this.forPeer(p, o.msg));
      } else if (fromSync && o.to === fromSync) {
        if (r.peers.has(from)) this.safeSend(from, this.forPeer(from, o.msg));
      } else {
        for (const p of r.peers) {
          if (this.syncClientOf(p) === o.to) this.safeSend(p, this.forPeer(p, o.msg));
        }
      }
    }
  }

  private async publish(event: ClusterEventPayload) {
    if (!this.bus) return;
    try {
      await this.bus.publish(event);
    } catch (e) {
      if (!this.closed) console.error(`发布集群房间事件失败（t=${event.t}）`, e);
    }
  }

  private trackPublish(event: ClusterEventPayload): Promise<void> {
    const p = this.publish(event).finally(() => {
      this.pendingBackgroundPublishes.delete(p);
    });
    this.pendingBackgroundPublishes.add(p);
    return p;
  }

  private scheduleLayoutFlush(branchId: string, r: Loaded) {
    if (r.layoutTimer) clearTimeout(r.layoutTimer);
    r.layoutTimer = setTimeout(() => {
      r.layoutTimer = undefined;
      this.flushLayout(branchId, r).catch((e) => {
        console.error(`保存画布布局失败（branchId=${branchId}）`, e);
      });
    }, 500);
    r.layoutTimer.unref?.();
  }

  private clearPendingLayoutKeys(r: Loaded, keys: Iterable<string>) {
    for (const key of keys) {
      delete r.pendingLayout[key];
    }
    if (r.layoutTimer && Object.keys(r.pendingLayout).length === 0) {
      clearTimeout(r.layoutTimer);
      r.layoutTimer = undefined;
    }
  }

  private async reloadLayoutFromDb(branchId: string, r: Loaded, incoming?: LayoutVersion) {
    const pendingBefore: Layout = { ...r.pendingLayout };
    const [b] = await this.db.query<{ layout: Layout }>('select layout from branches where id = $1', [
      branchId,
    ]);
    if (!b?.layout) return;
    const clearedKeys: string[] = [];
    for (const [key, pos] of Object.entries(b.layout)) {
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
      const cur = r.pendingLayout[key];
      // 查询期间新产生的本地拖动保留，不被此次重载覆盖
      if (cur !== undefined && cur !== pendingBefore[key]) continue;
      if (incoming && !isNewerLayoutVersion(incoming, r.layoutVersions.get(key))) continue;
      if (cur !== undefined) clearedKeys.push(key);
      if (incoming) r.layoutVersions.set(key, incoming);
      r.layout[key] = { x: pos.x, y: pos.y };
    }
    if (clearedKeys.length > 0) this.clearPendingLayoutKeys(r, clearedKeys);
    for (const p of r.peers) this.safeSend(p, { t: 'layout', positions: r.layout });
  }

  private async handleClusterEvent(event: ClusterEvent) {
    if (!this.bus || event.origin === this.bus.replicaId) return;
    switch (event.t) {
      case 'room.commit': {
        if (!this.rooms.has(event.branchId)) return;
        await this.catchUp(event.branchId, { minSeq: event.seq });
        break;
      }
      case 'room.layout': {
        const pending = this.rooms.get(event.branchId);
        if (!pending) return;
        const r = await pending.catch(() => null);
        if (!r) return;
        const incomingVer = typeof event.ver === 'number' ? event.ver : r.layoutClock + 1;
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
        this.clearPendingLayoutKeys(r, acceptedKeys);
        for (const p of r.peers) this.safeSend(p, { t: 'layout', positions: accepted });
        break;
      }
      case 'room.layout.reload': {
        const pending = this.rooms.get(event.branchId);
        if (!pending) return;
        const r = await pending.catch(() => null);
        if (!r) return;
        const incomingVer = typeof event.ver === 'number' ? event.ver : r.layoutClock + 1;
        if (incomingVer > r.layoutClock) r.layoutClock = incomingVer;
        await this.reloadLayoutFromDb(event.branchId, r, { ver: incomingVer, origin: event.origin });
        break;
      }
      case 'room.peers': {
        const pending = this.rooms.get(event.branchId);
        if (!pending) return;
        const r = await pending.catch(() => null);
        if (!r) return;
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
        break;
      }
      case 'room.peers.sync': {
        if (event.branchId) {
          const pending = this.rooms.get(event.branchId);
          if (!pending) return;
          const r = await pending.catch(() => null);
          if (!r) return;
          if (this.localPeerList(r).length > 0) {
            await this.publishRoomPeers(event.branchId, r);
          }
          return;
        }
        for (const [branchId, pending] of this.rooms) {
          const r = await pending.catch(() => null);
          if (!r) continue;
          await this.publishRoomPeers(branchId, r);
        }
        break;
      }
      case 'room.presence': {
        const pending = this.rooms.get(event.branchId);
        if (!pending) return;
        const r = await pending.catch(() => null);
        if (!r) return;
        for (const p of r.peers) {
          const isSameSender = event.userId
            ? p.user.id === event.userId && p.client === event.client
            : p.client === event.client;
          if (!isSameSender) {
            this.safeSend(p, { t: 'presence', client: event.client, user: event.user, data: event.data });
          }
        }
        break;
      }
      case 'room.kick': {
        await this.kickUserLocal(event.userId, event.reason);
        break;
      }
      case 'room.refresh': {
        await this.refreshLoadedLocal(event.branchIds);
        break;
      }
    }
  }

  /** PG LISTEN 断线重连后：追赶所有已加载房间的提交与布局、同步跨副本在线成员，并刷新权限（补齐断线期间错过的通知） */
  private async handleBusReconnect() {
    const branchIds = [...this.rooms.keys()];
    for (const branchId of branchIds) {
      try {
        await this.catchUp(branchId);
        const pending = this.rooms.get(branchId);
        const r = pending ? await pending.catch(() => null) : null;
        if (r) {
          const [b] = await this.db.query<{ layout: Layout }>('select layout from branches where id = $1', [
            branchId,
          ]);
          if (b?.layout) {
            r.layout = { ...b.layout, ...r.pendingLayout };
            for (const p of r.peers) this.safeSend(p, { t: 'layout', positions: r.layout });
          }
          await this.publishRoomPeers(branchId, r);
        }
      } catch (e) {
        console.error(`事件总线重连后追赶房间失败（branchId=${branchId}）`, e);
      }
    }
    try {
      await this.pruneDeadRemotePeers();
    } catch (e) {
      console.error('事件总线重连后清理离线副本在线成员失败', e);
    }
    if (branchIds.length > 0) {
      await this.publish({ t: 'room.peers.sync' });
    }
    try {
      await this.refreshLoadedLocal();
    } catch (e) {
      console.error('事件总线重连后刷新房间权限失败', e);
    }
  }

  private localPeerList(r: Loaded): RoomPeerInfo[] {
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

  private broadcastPeers(r: Loaded) {
    const peers = this.peerList(r);
    for (const p of r.peers) {
      if (!this.peerVerifiedSeq.has(p)) continue;
      this.safeSend(p, { t: 'peers', peers });
    }
  }

  private async publishRoomPeers(branchId: string, r: Loaded) {
    if (!this.bus) return;
    const raw = this.localPeerList(r);
    const { peers, truncated } = truncateRoomPeersForEvent(
      this.bus.replicaId,
      branchId,
      raw,
      PEERS_EVENT_MAX_BYTES,
    );
    if (truncated) {
      console.warn(
        `分支 ${branchId} 在线成员快照超出单条集群事件字节上限，已截断（total=${raw.length}, kept=${peers.length}）`,
      );
    }
    await this.publish({ t: 'room.peers', branchId, peers });
  }

  /** 结合 HA 租约清理已离线副本残留的 remotePeers，并在列表变动时广播给本地在线成员 */
  async pruneDeadRemotePeers(): Promise<void> {
    if (!this.ha || this.closed) return;
    let hasRemote = false;
    for (const pending of this.rooms.values()) {
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
      const alive = await this.ha!.aliveNodes();
      // 仅当本副本自身租约存活（HA 心跳已启用）时才剔除离线副本，避免未启动 HA 的测试环境误删
      if (!alive.has(this.ha!.replicaId)) return;
      for (const pending of this.rooms.values()) {
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

  /** 推进权限刷新代际；不传 branchIds 表示全量影响所有已加载房间 */
  private bumpRefreshGen(branchIds?: Iterable<string>) {
    this.refreshSeq += 1;
    if (!branchIds) {
      this.globalRefreshGen += 1;
      return;
    }
    for (const id of branchIds) {
      if (this.rooms.has(id)) {
        this.branchRefreshGen.set(id, (this.branchRefreshGen.get(id) ?? 0) + 1);
      }
    }
  }

  private refreshGenFor(branchId: string): number {
    return this.globalRefreshGen + (this.branchRefreshGen.get(branchId) ?? 0);
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

  /** 查询用户最新的实例角色与账号状态：停用或角色变更后不能沿用 WS 升级时的快照 */
  private async fetchUserState(
    userId: string,
  ): Promise<{ role: User['role']; status: User['status'] } | null> {
    const [row] = await this.db.query<{ role: User['role']; status: User['status'] }>(
      'select role, status from users where id = $1',
      [userId],
    );
    return row ?? null;
  }

  /** 分支属于哪个项目（join 复查角色、刷新已加载房间时用） */
  private async projectOfBranch(branchId: string): Promise<string | null> {
    const [row] = await this.db.query<{ projectId: string }>(
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
    const r = await this.get(branchId);
    r.peers.add(peer);

    const abort = (reason: string) => {
      const hadClient = Boolean(peer.client);
      if (!r.peers.delete(peer)) return;
      peer.close?.(4403, reason);
      this.broadcastPeers(r);
      if (hadClient) {
        const p = this.publishRoomPeers(branchId, r).finally(() => {
          this.pendingBackgroundPublishes.delete(p);
        });
        this.pendingBackgroundPublishes.add(p);
      }
    };

    for (let attempt = 0; attempt < MAX_JOIN_VERIFY_ATTEMPTS; attempt++) {
      if (!r.peers.has(peer)) return;
      const gen = this.refreshGenFor(branchId);
      const seq = this.refreshSeq;

      const current = await this.fetchUserState(peer.user.id);
      if (!r.peers.has(peer)) return;
      if (this.refreshGenFor(branchId) !== gen) continue;
      if (current?.status !== 'active') {
        abort('账号已被停用');
        return;
      }
      if (peer.user.role !== current.role) {
        peer.user = { ...peer.user, role: current.role };
      }

      const projectId = await this.projectOfBranch(branchId);
      if (!r.peers.has(peer)) return;
      const role = projectId ? await this.resolveRole(peer.user, projectId) : null;
      if (!r.peers.has(peer)) return;
      if (this.refreshGenFor(branchId) !== gen) continue;

      if (!role) {
        abort('你在这个项目里已经没有权限');
        return;
      }
      this.peerVerifiedSeq.set(peer, seq);
      peer.role = role;
      this.safeSend(peer, { t: 'role', role });
      this.safeSend(peer, { t: 'layout', positions: r.layout });
      return;
    }

    abort('权限状态正在变更，请重试');
  }

  async leave(branchId: string, peer: Peer) {
    // 分支可能已经被删掉（项目删除）：加载失败就当没进过房间，不能抛出去
    const r = await this.get(branchId).catch(() => null);
    if (!r) return;
    const hadClient = Boolean(peer.client);
    // 已经被踢掉的连接走 onClose 时不用再广播一次
    if (!r.peers.delete(peer)) return;
    this.broadcastPeers(r);
    if (hadClient) await this.publishRoomPeers(branchId, r);
  }

  private async flushLayout(branchId: string, r: Loaded): Promise<void> {
    while (r.layoutFlushing) {
      await r.layoutFlushing.catch(() => {});
    }
    if (Object.keys(r.pendingLayout).length === 0) return;
    const task = (async () => {
      while (Object.keys(r.pendingLayout).length > 0) {
        const snapshot: Layout = { ...r.pendingLayout };
        const keys = Object.keys(snapshot);
        if (keys.length === 0) break;
        if (this.db.dialect === 'pg') {
          await this.db.query(
            "update branches set layout = coalesce(layout, '{}'::jsonb) || $2::text::jsonb where id = $1",
            [branchId, JSON.stringify(snapshot)],
          );
        } else {
          await this.db.query('update branches set layout = $2::text::jsonb where id = $1', [
            branchId,
            JSON.stringify(r.layout),
          ]);
        }
        // SQL 落库成功后再清理快照中未被新坐标替换的键（按对象引用精确判定）
        for (const key of keys) {
          if (r.pendingLayout[key] === snapshot[key]) {
            delete r.pendingLayout[key];
          }
        }
      }
    })();
    r.layoutFlushing = task;
    try {
      await task;
    } finally {
      if (r.layoutFlushing === task) r.layoutFlushing = null;
    }
  }

  async message(branchId: string, peer: Peer, msg: ToServer | ExtraIn) {
    const r = await this.get(branchId);
    // 不在房间里（例如账号刚被停用踢掉）就直接丢弃：不提交、不广播、不回消息
    if (!r.peers.has(peer)) return;
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      const validLastSeq =
        typeof msg.lastSeq === 'number' && Number.isInteger(msg.lastSeq) && msg.lastSeq >= 0;
      if (!isValidClientId(msg.client) || !validLastSeq) {
        const hadClient = Boolean(peer.client);
        r.peers.delete(peer);
        peer.close?.(4400, '无效的客户端标识');
        if (hadClient) {
          this.broadcastPeers(r);
          await this.publishRoomPeers(branchId, r);
        }
        return;
      }
      if (peer.client !== undefined && peer.client !== msg.client) {
        r.peers.delete(peer);
        peer.close?.(4400, '客户端标识不可变更');
        this.broadcastPeers(r);
        await this.publishRoomPeers(branchId, r);
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
      this.broadcastPeers(r);
      const { caughtUp, outs } = await this.withRoomLock(r, async () => {
        if (!r.peers.has(peer)) return { caughtUp: [] as Commit[], outs: [] as Out[] };
        if (r.dirty) await this.reloadLocked(branchId, r);
        const caughtUp = this.db.dialect === 'pg' ? await this.catchUpReadOnly(branchId, r) : [];
        const outs = await r.room.handle(syncClient, peer.user.name, scopedHello, {
          readOnly: peer.role === 'viewer',
        });
        return { caughtUp, outs };
      });
      if (caughtUp.length) this.broadcastCommits(r, caughtUp, peer);
      this.deliver(r, peer, outs);
      await this.publishRoomPeers(branchId, r);
      return;
    }
    if (msg.t === 'op') {
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
      try {
        result = await this.withRoomLock(r, async () => {
          if (!r.peers.has(peer)) return null;
          if (peer.role === 'viewer') {
            const outs = await r.room.handle(syncClient, peer.user.name, scopedMsg, { readOnly: true });
            return { outs, committed: false, seq: r.room.seq };
          }
          if (r.dirty) await this.reloadLocked(branchId, r);
          let mutated = false;
          try {
            let committedRejectionId = r.lastRejectionId;
            const out = await this.db.transaction(async (tx) => {
              if (this.db.dialect === 'pg') {
                const [locked] = await tx.query<{ id: string }>(
                  'select id from branches where id = $1 for update',
                  [branchId],
                );
                if (!locked) throw new Error(`分支 ${branchId} 不存在`);
                caughtUp = await this.catchUpFrom(tx, branchId, r);
                committedRejectionId = r.lastRejectionId;
              }
              const store = this.makeStore(tx, branchId, (rejId) => {
                if (rejId > committedRejectionId) committedRejectionId = rejId;
              });
              mutated = true;
              const outs = await r.room.handle(syncClient, peer.user.name, scopedMsg, {
                readOnly: peer.role === 'viewer',
                store,
              });
              const committed = outs.some((o) => o.msg.t === 'commit');
              if (committed) await this.maybeSnapshot(tx, branchId, r.room);
              return { outs, committed, seq: r.room.seq };
            });
            if (committedRejectionId > r.lastRejectionId) {
              r.lastRejectionId = committedRejectionId;
            }
            return out;
          } catch (err) {
            if (mutated) {
              r.dirty = true;
              await this.reloadLocked(branchId, r).catch(() => {});
            }
            throw err;
          }
        });
      } catch (err) {
        if (caughtUp.length) this.broadcastCommits(r, caughtUp);
        throw err;
      }
      if (!result) return;
      if (caughtUp.length) this.broadcastCommits(r, caughtUp);
      this.deliver(r, peer, result.outs);
      if (result.committed) {
        this.onCommit(branchId);
        await this.publish({ t: 'room.commit', branchId, seq: result.seq });
      }
      return;
    }
    if (msg.t === 'layout') {
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
      const ver = r.layoutClock;
      const versionStamp: LayoutVersion = { ver, origin: this.bus?.replicaId ?? '' };
      for (const tableId of tableIds) r.layoutVersions.set(tableId, versionStamp);

      // 写入 pendingLayout 后立即调度防抖定时器，避免在 await publish 挂起窗口内漏刷
      this.scheduleLayoutFlush(branchId, r);
      for (const p of r.peers) if (p !== peer) this.safeSend(p, { t: 'layout', positions });

      const needsReloadBroadcast =
        this.bus !== undefined &&
        Buffer.byteLength(
          JSON.stringify({ t: 'room.layout', origin: this.bus.replicaId, branchId, positions, ver }),
          'utf8',
        ) > LAYOUT_INLINE_MAX_BYTES;

      if (needsReloadBroadcast) {
        if (r.layoutTimer) {
          clearTimeout(r.layoutTimer);
          r.layoutTimer = undefined;
        }
        try {
          await this.flushLayout(branchId, r);
        } catch (e) {
          if (Object.keys(r.pendingLayout).length > 0) this.scheduleLayoutFlush(branchId, r);
          throw e;
        }
        await this.publish({ t: 'room.layout.reload', branchId, ver });
        return;
      }

      await this.publish({ t: 'room.layout', branchId, positions, ver });
      return;
    }
    if (msg.t === 'presence' && peer.client) {
      for (const p of r.peers)
        if (p !== peer)
          this.safeSend(p, { t: 'presence', client: peer.client, user: peer.user.name, data: msg.data });
      await this.publish({
        t: 'room.presence',
        branchId,
        userId: peer.user.id,
        client: peer.client,
        user: peer.user.name,
        data: msg.data,
      });
    }
  }

  /** 服务器以系统身份替换整个模型（导入 DDL、恢复历史、接入领先环境等）；传入 expectedSeq 时原子校验当前 seq */
  async replace(branchId: string, user: string, next: Model, opName?: string, expectedSeq?: number) {
    const r = await this.get(branchId);
    let caughtUp: Commit[] = [];
    let result: { outs: Out[]; committed: boolean; seq: number };
    try {
      result = await this.withRoomLock(r, async () => {
        if (r.dirty) await this.reloadLocked(branchId, r);
        let mutated = false;
        try {
          return await this.db.transaction(async (tx) => {
            if (this.db.dialect === 'pg') {
              const [locked] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!locked) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.catchUpFrom(tx, branchId, r);
            }
            if (expectedSeq !== undefined && r.room.seq !== expectedSeq) {
              throw new WorkingChangedError(r.room.seq, structuredClone(r.room.model));
            }
            const store = this.makeStore(tx, branchId);
            mutated = true;
            const outs = await r.room.replace(user, next, opName, store);
            const committed = outs.some((o) => o.msg.t === 'commit');
            if (committed) await this.maybeSnapshot(tx, branchId, r.room);
            return { outs, committed, seq: r.room.seq };
          });
        } catch (err) {
          if (mutated) {
            r.dirty = true;
            await this.reloadLocked(branchId, r).catch(() => {});
          }
          throw err;
        }
      });
    } catch (err) {
      if (caughtUp.length) this.broadcastCommits(r, caughtUp);
      throw err;
    }
    if (caughtUp.length) this.broadcastCommits(r, caughtUp);
    for (const o of result.outs) for (const p of r.peers) this.safeSend(p, this.forPeer(p, o.msg));
    if (result.committed) {
      await this.publish({ t: 'room.commit', branchId, seq: result.seq });
    }
  }

  /** 服务器以系统身份更新派生数据（期间被别人改过的对象不写） */
  async patch(
    branchId: string,
    user: string,
    objects: Obj[],
    expect: Versions,
  ): Promise<{ committed: boolean; rejected: boolean; seq: number }> {
    const r = await this.get(branchId);
    let caughtUp: Commit[] = [];
    let result: { outs: Out[]; committed: boolean; rejected: boolean; seq: number };
    try {
      result = await this.withRoomLock(r, async () => {
        if (r.dirty) await this.reloadLocked(branchId, r);
        let mutated = false;
        try {
          return await this.db.transaction(async (tx) => {
            if (this.db.dialect === 'pg') {
              const [locked] = await tx.query<{ id: string }>(
                'select id from branches where id = $1 for update',
                [branchId],
              );
              if (!locked) throw new Error(`分支 ${branchId} 不存在`);
              caughtUp = await this.catchUpFrom(tx, branchId, r);
            }
            const rejected = objects.some(
              (o) => !(o.id in r.room.model.objects) || (r.room.versions[o.id] ?? 0) !== (expect[o.id] ?? 0),
            );
            const store = this.makeStore(tx, branchId);
            mutated = true;
            const outs = await r.room.patch(user, objects, expect, 'derive', store);
            const committed = outs.some((o) => o.msg.t === 'commit');
            if (committed) await this.maybeSnapshot(tx, branchId, r.room);
            return { outs, committed, rejected, seq: r.room.seq };
          });
        } catch (err) {
          if (mutated) {
            r.dirty = true;
            await this.reloadLocked(branchId, r).catch(() => {});
          }
          throw err;
        }
      });
    } catch (err) {
      if (caughtUp.length) this.broadcastCommits(r, caughtUp);
      throw err;
    }
    if (caughtUp.length) this.broadcastCommits(r, caughtUp);
    for (const o of result.outs) for (const p of r.peers) this.safeSend(p, this.forPeer(p, o.msg));
    if (result.committed) {
      await this.publish({ t: 'room.commit', branchId, seq: result.seq });
    }
    return { committed: result.committed, rejected: result.rejected, seq: result.seq };
  }

  async state(branchId: string): Promise<{ model: Model; versions: Versions; seq: number }> {
    const r = await this.getFresh(branchId);
    return { model: structuredClone(r.room.model), versions: { ...r.room.versions }, seq: r.room.seq };
  }

  async model(branchId: string): Promise<{ model: Model; seq: number }> {
    const r = await this.getFresh(branchId);
    return { model: structuredClone(r.room.model), seq: r.room.seq };
  }

  /**
   * 重建任意 seq（含 0）的完整模型：从不大于 seq 的最新快照出发，按序重放后续提交。
   * seq < 0 或超过当前最新 seq 时抛 404。
   */
  async modelAt(branchId: string, seq: number): Promise<Model> {
    const r = await this.getFresh(branchId);
    const currentSeq = r.room.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    if (seq === currentSeq) return structuredClone(r.room.model);
    const [snap] = await this.db.query<{ seq: string | number; model: Model }>(
      'select seq, model from room_snapshots where branch_id = $1 and seq <= $2 order by seq desc limit 1',
      [branchId, seq],
    );
    if (!snap) throw new HTTPException(404, { message: `修改记录 #${seq} 缺少可用快照` });
    const model = structuredClone(snap.model);
    const snapSeq = Number(snap.seq);
    if (snapSeq < seq) {
      const commits = await this.db.query<{ seq: string | number; changes: Commit['changes'] }>(
        'select seq, changes from room_commits where branch_id = $1 and seq > $2 and seq <= $3 order by seq',
        [branchId, snapSeq, seq],
      );
      for (const c of commits) {
        for (const ch of c.changes) {
          if (ch.obj) model.objects[ch.id] = structuredClone(ch.obj);
          else delete model.objects[ch.id];
        }
      }
    }
    return model;
  }

  private async versionsInRange(
    branchId: string,
    minSeq: number,
    maxSeq: number,
  ): Promise<Map<number, CanvasHistoryVersionRef>> {
    // 仅关联在当前画布序列上真实发布的版本，排除接手/接入恢复的版本（restored_at 非空，避免历史遗留 seq 与画布提交撞号）
    const rows = await this.db.query<{ id: string; seq: string | number; number: number; name: string }>(
      `select id, seq, number, name from versions
        where branch_id = $1 and seq >= $2 and seq <= $3 and restored_at is null
        order by number desc`,
      [branchId, minSeq, maxSeq],
    );
    const map = new Map<number, CanvasHistoryVersionRef>();
    for (const row of rows) {
      const s = Number(row.seq);
      if (!map.has(s)) map.set(s, { id: row.id, number: Number(row.number), name: row.name });
    }
    return map;
  }

  private async initialHistoryEntry(
    branchId: string,
    currentSeq: number,
    versions: Map<number, CanvasHistoryVersionRef>,
    modelOverride?: Model,
  ): Promise<CanvasHistoryEntry> {
    const [branch] = await this.db.query<{ created_at: unknown }>(
      'select created_at from branches where id = $1',
      [branchId],
    );
    let model = modelOverride;
    if (!model) {
      const [snap] = await this.db.query<{ model: Model }>(
        'select model from room_snapshots where branch_id = $1 and seq = 0',
        [branchId],
      );
      model = snap?.model;
    }
    const { changeCount, summary } = model ? summarizeModel(model) : { changeCount: 0, summary: [] };
    return {
      seq: 0,
      at: branch ? atOf(branch.created_at) : new Date(0).toISOString(),
      user: '',
      opName: 'init',
      changeCount,
      summary,
      isCurrent: currentSeq === 0,
      version: versions.get(0) ?? null,
    };
  }

  /** 分页倒序查询画布修改历史；翻到末尾时附带 seq = 0 初始状态，并匹配已发布版本标记 */
  async listHistory(
    branchId: string,
    opts: { beforeSeq?: number; limit?: number } = {},
  ): Promise<CanvasHistoryList> {
    const r = await this.getFresh(branchId);
    const currentSeq = r.room.seq;
    const limit = Math.min(100, Math.max(1, opts.limit ?? 30));
    const beforeSeq = opts.beforeSeq;
    if (beforeSeq !== undefined && beforeSeq <= 0) {
      return { entries: [], currentSeq, nextBeforeSeq: null };
    }

    type CommitRow = {
      seq: string | number;
      user_name: string;
      op_name: string | null;
      changes: Commit['changes'];
      created_at: unknown;
    };
    const rows =
      beforeSeq !== undefined
        ? await this.db.query<CommitRow>(
            `select seq, user_name, op_name, changes, created_at
               from room_commits
              where branch_id = $1 and seq < $2
              order by seq desc
              limit $3`,
            [branchId, beforeSeq, limit],
          )
        : await this.db.query<CommitRow>(
            `select seq, user_name, op_name, changes, created_at
               from room_commits
              where branch_id = $1
              order by seq desc
              limit $2`,
            [branchId, limit],
          );

    const includeInit = rows.length < limit;
    const seqs = rows.map((row) => Number(row.seq));
    if (includeInit) seqs.push(0);
    const versions = seqs.length
      ? await this.versionsInRange(branchId, Math.min(...seqs), Math.max(...seqs))
      : new Map<number, CanvasHistoryVersionRef>();

    // 从当前模型与本页提交收集对象名，便于为删除操作解析对象名称
    const knownObjects: Record<string, Obj> = { ...r.room.model.objects };
    for (const row of rows) for (const ch of row.changes) if (ch.obj) knownObjects[ch.id] = ch.obj;
    const knownNames = new Map<string, string>();
    for (const [id, obj] of Object.entries(knownObjects)) knownNames.set(id, objectLabel(obj, knownObjects));

    const entries: CanvasHistoryEntry[] = rows.map((row) => {
      const seq = Number(row.seq);
      return {
        seq,
        at: atOf(row.created_at),
        user: row.user_name,
        opName: row.op_name ?? 'edit',
        changeCount: row.changes.length,
        summary: summarizeChanges(row.changes, knownNames, knownObjects),
        isCurrent: seq === currentSeq,
        version: versions.get(seq) ?? null,
      };
    });

    if (includeInit) {
      entries.push(await this.initialHistoryEntry(branchId, currentSeq, versions));
    }

    const lastSeq = entries.at(-1)?.seq ?? 0;
    const nextBeforeSeq = !includeInit && lastSeq > 0 ? lastSeq : null;
    return { entries, currentSeq, nextBeforeSeq };
  }

  /** 读取单条历史记录的元信息（用于详情接口；若提供 prevModel/targetModel 可精确解析被删对象名） */
  async historyEntry(
    branchId: string,
    seq: number,
    context?: { prevModel?: Model | null; targetModel?: Model; currentSeq?: number },
  ): Promise<CanvasHistoryEntry> {
    const r = await this.getFresh(branchId);
    const currentSeq = context?.currentSeq ?? r.room.seq;
    if (!Number.isInteger(seq) || seq < 0 || seq > currentSeq)
      throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });
    const versions = await this.versionsInRange(branchId, seq, seq);
    if (seq === 0) {
      return this.initialHistoryEntry(branchId, currentSeq, versions, context?.targetModel);
    }
    const [row] = await this.db.query<{
      seq: string | number;
      user_name: string;
      op_name: string | null;
      changes: Commit['changes'];
      created_at: unknown;
    }>(
      'select seq, user_name, op_name, changes, created_at from room_commits where branch_id = $1 and seq = $2',
      [branchId, seq],
    );
    if (!row) throw new HTTPException(404, { message: `修改记录 #${seq} 不存在` });

    const knownObjects: Record<string, Obj> = {
      ...(context?.prevModel?.objects ?? {}),
      ...(context?.targetModel?.objects ?? {}),
    };
    const knownNames = new Map<string, string>();
    for (const [id, obj] of Object.entries(knownObjects)) knownNames.set(id, objectLabel(obj, knownObjects));
    return {
      seq,
      at: atOf(row.created_at),
      user: row.user_name,
      opName: row.op_name ?? 'edit',
      changeCount: row.changes.length,
      summary: summarizeChanges(row.changes, knownNames, knownObjects),
      isCurrent: seq === currentSeq,
      version: versions.get(seq) ?? null,
    };
  }

  /** 仅在当前副本踢出指定用户的所有在线连接 */
  async kickUserLocal(userId: string, reason = '账号已被停用') {
    this.bumpRefreshGen();
    for (const [branchId, pending] of this.rooms) {
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
        this.broadcastPeers(r);
        if (removedClient) await this.publishRoomPeers(branchId, r);
      }
    }
  }

  /** 踢出指定用户的所有在线连接（本地立即断开并经事件总线广播给其他副本） */
  async kickUser(userId: string, reason = '账号已被停用') {
    await this.kickUserLocal(userId, reason);
    await this.publish({ t: 'room.kick', userId, reason });
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
    this.bumpRefreshGen(target === 'all' ? undefined : target);

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

    const initialSeq = this.refreshSeq;
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
          this.bumpRefreshGen(nextTarget === 'all' ? undefined : nextTarget);
          nextSeq = this.refreshSeq;
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
      target === 'all' ? [...this.rooms.keys()] : [...target].filter((id) => this.rooms.has(id));
    if (targets.length === 0) return;
    // 分支 → 项目只反查一次（同一个项目可能有多个分支的房间）
    const projects = await this.db.query<{ branchId: string; projectId: string }>(
      `select id as "branchId", project_id as "projectId" from branches where id in (${inList(targets)})`,
      targets,
    );
    const projectByBranch = new Map(projects.map((p) => [p.branchId, p.projectId]));
    // 整次刷新共用：用户当前状态（可能刚被停用 / 改了实例角色）+ 角色上下文 / 项目缓存
    const users = new Map<string, { role: User['role']; status: User['status'] } | null>();
    const lookup: RoleLookup = { contexts: new Map(), projects: new Map() };
    const kick = (r: Loaded, peer: Peer, reason: string) => {
      r.peers.delete(peer);
      peer.close?.(4403, reason);
    };

    for (const branchId of targets) {
      const pending = this.rooms.get(branchId);
      if (!pending) continue;
      const r = await pending.catch(() => null);
      if (!r) continue;
      const projectId = projectByBranch.get(branchId);
      if (!projectId) {
        const hadClients = this.localPeerList(r).length > 0;
        if (r.layoutTimer) {
          clearTimeout(r.layoutTimer);
          r.layoutTimer = undefined;
        }
        for (const peer of [...r.peers]) kick(r, peer, '项目已被删除');
        this.rooms.delete(branchId);
        this.branchRefreshGen.delete(branchId);
        if (hadClients) await this.publish({ t: 'room.peers', branchId, peers: [] });
        continue;
      }
      let removed = false;
      let removedClient = false;
      for (const peer of [...r.peers]) {
        if (!r.peers.has(peer)) continue;
        if ((this.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        let current = users.get(peer.user.id);
        if (current === undefined) {
          current = await this.fetchUserState(peer.user.id);
          users.set(peer.user.id, current);
        }
        if (!r.peers.has(peer)) continue;
        if ((this.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        if (current?.status !== 'active') {
          if (peer.client) removedClient = true;
          kick(r, peer, '账号已被停用');
          removed = true;
          continue;
        }
        if (peer.user.role !== current.role) {
          peer.user = { ...peer.user, role: current.role };
        }
        const role = await this.resolveRole(peer.user, projectId, lookup);
        if (!r.peers.has(peer)) continue;
        if ((this.peerVerifiedSeq.get(peer) ?? 0) > roundSeq) continue;
        if (!role) {
          if (peer.client) removedClient = true;
          kick(r, peer, '你在这个项目里已经没有权限');
          removed = true;
          continue;
        }
        if (role !== peer.role) {
          peer.role = role;
          this.safeSend(peer, { t: 'role', role });
        }
      }
      // 只给真正踢掉了人的房间广播在线列表
      if (removed) {
        this.broadcastPeers(r);
        if (removedClient) await this.publishRoomPeers(branchId, r);
      }
    }
  }

  /**
   * 角色可能变了之后，重算所有副本上已加载房间（或指定分支子集）里每个在线 peer 的生效角色。
   * 组成员、组 / 项目默认权限、授权、转组、删除组、停用或改实例角色之后都调用它。
   */
  async refreshLoaded(branchIds?: string[]) {
    await this.refreshLoadedLocal(branchIds);
    await this.publish(branchIds ? { t: 'room.refresh', branchIds } : { t: 'room.refresh' });
  }

  /**
   * 分支被删掉（项目被删除）时立即断开里面所有连接：和“没有权限了”用同一个关闭码 4403，
   * 客户端收到后不会再重连。房间从缓存里移除，避免继续拿着已经不存在的分支，并通知其他副本清理。
   */
  async kickBranches(branchIds: string[], reason: string) {
    if (branchIds.length > 0) this.bumpRefreshGen(branchIds);
    const gone = new Set(branchIds);
    for (const [branchId, pending] of this.rooms) {
      if (!gone.has(branchId)) continue;
      const r = await pending.catch(() => null);
      let hadClients = false;
      if (r) {
        hadClients = this.localPeerList(r).length > 0;
        if (r.layoutTimer) {
          clearTimeout(r.layoutTimer);
          r.layoutTimer = undefined;
        }
        for (const peer of [...r.peers]) {
          r.peers.delete(peer);
          peer.close?.(4403, reason);
        }
      }
      this.rooms.delete(branchId);
      this.branchRefreshGen.delete(branchId);
      if (hadClients) await this.publish({ t: 'room.peers', branchId, peers: [] });
    }
    if (branchIds.length > 0) {
      await this.publish({ t: 'room.refresh', branchIds });
    }
  }

  /** 测试和排查用：这个分支的房间是否已经加载在内存里 */
  has(branchId: string): boolean {
    return this.rooms.has(branchId);
  }

  /** 优雅断开本副本所有在线房间连接（停机时通知客户端重连并向集群广播离线快照，避免持久连接阻塞 HTTP 服务关闭） */
  async disconnectAll(code = 1001, reason = '服务正在关闭') {
    for (const [branchId, pending] of this.rooms) {
      const r = await pending.catch(() => null);
      if (!r) continue;
      const hadClients = this.localPeerList(r).length > 0;
      for (const peer of [...r.peers]) {
        r.peers.delete(peer);
        try {
          peer.close?.(code, reason);
        } catch {}
      }
      if (hadClients) await this.publish({ t: 'room.peers', branchId, peers: [] });
    }
  }

  /** 立即写入所有挂起的布局，并等待进行中的房间操作与在途布局落库完成（关闭服务和测试时用） */
  async flush() {
    while (this.refreshInFlight) {
      await this.refreshInFlight.catch(() => {});
    }
    if (this.pruneInFlight) {
      await this.pruneInFlight.catch(() => {});
    }
    if (this.pendingBackgroundPublishes.size > 0) {
      await Promise.allSettled([...this.pendingBackgroundPublishes]);
    }
    for (const [branchId, p] of this.rooms) {
      const r = await p.catch(() => null);
      if (!r) continue;
      await r.lock.catch(() => {});
      if (r.layoutTimer) {
        clearTimeout(r.layoutTimer);
        r.layoutTimer = undefined;
      }
      if (r.layoutFlushing || Object.keys(r.pendingLayout).length > 0) {
        await this.flushLayout(branchId, r);
      }
    }
  }
}
