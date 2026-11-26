// 房间内核：每个分支一个房间，按需从数据库加载（最新快照 + 之后的操作日志）。
// 持有房间注册表、进程内房间锁（withRoomLock）、只读快照追赶（REPEATABLE READ）、空闲卸载、
// 权限刷新代际与集群事件发布；布局 / 板块 / 成员 / 写入 / 历史 / MCP 等子模块都经它访问共享状态。

import { type CanvasSection, sanitizeSections } from '@dowel/api';
import { BATCH_MUTATOR, batchSummaryOf, type Model, scrubSecrets } from '@dowel/core';
import type { Db } from '@dowel/engines';
import {
  type Commit,
  emptyRoomState,
  type Op,
  type Out,
  type Rejection,
  Room,
  type RoomState,
  type RoomStore,
  type ToClient,
  type Versions,
} from '@dowel/sync';

import type { ClusterEventPayload, EventBus } from '../bus.ts';
import type { PlatformDb } from '../db.ts';
import type { HaCoordinator } from '../ha.ts';
import { forPeer, syncClientOf } from './client-scope.ts';
import { hasPendingLayout } from './layout.ts';
import { parseClock } from './lww.ts';
import { hasPendingSections } from './sections.ts';
import {
  type Extra,
  type Layout,
  type LayoutVersion,
  type Loaded,
  type Peer,
  SNAPSHOT_EVERY,
} from './types.ts';

/** batch 提交的意图说明（脱敏后落库 room_commits.op_summary）；其他操作为 null */
const opSummaryOf = (op: Op): string | null => {
  if (op.name !== BATCH_MUTATOR) return null;
  const s = batchSummaryOf(op.args);
  return s ? scrubSecrets(s) : null;
};

export class RoomKernel {
  readonly rooms = new Map<string, Promise<Loaded>>();
  readonly db: PlatformDb;
  readonly bus?: EventBus;
  readonly ha?: Pick<HaCoordinator, 'replicaId' | 'aliveNodes'>;
  closed = false;
  private idleEvictMs: number;
  /** 追踪所有活跃的空闲卸载定时器，确保 close() 时同步彻底清理 */
  readonly idleTimers = new Map<Loaded, ReturnType<typeof setTimeout>>();
  /** 追踪非阻塞路径（load / close）发起的在途事件发布，供 flush() 排空避免与 db.close() 竞态 */
  readonly pendingBackgroundPublishes = new Set<Promise<void>>();
  /** 全量权限刷新与全库踢人的代际计数 */
  globalRefreshGen = 0;
  /** 按分支的定向权限刷新代际计数 */
  readonly branchRefreshGen = new Map<string, number>();
  /** 单调递增的刷新批次序号，避免旧批次刷新覆盖在更新批次之后完成 join 校验的 peer */
  refreshSeq = 0;
  /** 记录每个 peer 最近一次完成 join 校验时对应的刷新批次序号 */
  readonly peerVerifiedSeq = new WeakMap<Peer, number>();

  constructor(
    db: PlatformDb,
    bus: EventBus | undefined,
    ha: Pick<HaCoordinator, 'replicaId' | 'aliveNodes'> | undefined,
    idleEvictMs: number,
  ) {
    this.db = db;
    this.bus = bus;
    this.ha = ha;
    this.idleEvictMs = idleEvictMs;
  }

  /** 同步清理全部空闲卸载定时器（close() 时调用） */
  clearAllIdleTimers() {
    for (const [r, timer] of this.idleTimers) {
      clearTimeout(timer);
      if (r.idleTimer === timer) r.idleTimer = undefined;
    }
    this.idleTimers.clear();
  }

  /** 新建分支时写入初始模型（序号 0 的快照） */
  async init(branchId: string, model: Model) {
    await this.db.query(
      'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
      [branchId, JSON.stringify(model), '{}'],
    );
  }

  get(branchId: string): Promise<Loaded> {
    let p = this.rooms.get(branchId);
    if (!p) {
      p = this.load(branchId).then(
        (r) => {
          r.entry = p!;
          this.scheduleIdleEvictIfNeeded(branchId, r);
          return r;
        },
        (err) => {
          if (this.rooms.get(branchId) === p) this.rooms.delete(branchId);
          throw err;
        },
      );
      this.rooms.set(branchId, p);
    }
    return p;
  }

  makeStore(db: Db, branchId: string, onRejectionId?: (id: number) => void): RoomStore {
    return {
      append: async (commit, op) => {
        await db.query(
          `insert into room_commits (branch_id, seq, client, n, user_name, op_name, op_args, changes, op_summary)
           values ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb, $9)`,
          [
            branchId,
            commit.seq,
            commit.client,
            commit.n,
            commit.user,
            op.name,
            JSON.stringify(op.args ?? null),
            JSON.stringify(commit.changes),
            opSummaryOf(op),
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
    const [b] = await this.db.query<{
      layout: Layout;
      sections: CanvasSection[];
      layout_ver: number | string;
      sections_ver: number | string;
    }>('select layout, sections, layout_ver, sections_ver from branches where id = $1', [branchId]);
    const layout = b?.layout ?? {};
    const layoutClock = parseClock(b?.layout_ver);
    const sectionsClock = parseClock(b?.sections_ver);
    const layoutVersions = new Map<string, LayoutVersion>();
    if (layoutClock > 0) {
      for (const key of Object.keys(layout)) {
        layoutVersions.set(key, { ver: layoutClock, origin: '' });
      }
    }
    const loaded: Loaded = {
      room,
      lastRejectionId,
      peers: new Set(),
      remotePeers: new Map(),
      layout,
      pendingLayout: {},
      layoutClock,
      layoutVersions,
      layoutIo: Promise.resolve(),
      layoutIoCount: 0,
      layoutRetries: 0,
      sections: sanitizeSections(b?.sections),
      sectionsPending: false,
      sectionsClock,
      sectionsVersion: sectionsClock > 0 ? { ver: sectionsClock, origin: '' } : null,
      sectionsIo: Promise.resolve(),
      sectionsIoCount: 0,
      sectionsRetries: 0,
      sectionsWriteSeq: 0,
      activeOps: 0,
      evicted: false,
      lock: Promise.resolve(),
      dirty: false,
    };
    if (this.bus && !this.closed) {
      // 房间首次加载时向其他副本请求一次该分支的在线成员快照
      void this.trackPublish({ t: 'room.peers.sync', branchId });
    }
    return loaded;
  }

  async reloadLocked(branchId: string, r: Loaded) {
    const { room, lastRejectionId } = await this.loadRoom(branchId);
    r.room = room;
    r.lastRejectionId = lastRejectionId;
    r.dirty = false;
  }

  isCurrentEntry(branchId: string, r: Loaded): boolean {
    return !r.evicted && r.entry !== undefined && this.rooms.get(branchId) === r.entry;
  }

  private isIdle(r: Loaded): boolean {
    return r.peers.size === 0 && r.activeOps === 0 && !hasPendingLayout(r) && !hasPendingSections(r);
  }

  clearIdleEvict(r: Loaded) {
    if (r.idleTimer !== undefined) {
      clearTimeout(r.idleTimer);
      r.idleTimer = undefined;
    }
    this.idleTimers.delete(r);
  }

  scheduleIdleEvictIfNeeded(branchId: string, r: Loaded) {
    if (this.closed || this.idleEvictMs <= 0) return;
    if (!this.isCurrentEntry(branchId, r)) return;
    if (!this.isIdle(r)) {
      this.clearIdleEvict(r);
      return;
    }
    // 已有空闲卸载倒计时则保持原到期时间，避免外部事件/重复调度无限续命
    // （真实打破空闲的本机访问已在入口显式 clearIdleEvict）
    if (r.idleTimer !== undefined) return;
    const timer = setTimeout(() => {
      if (r.idleTimer === timer) r.idleTimer = undefined;
      this.idleTimers.delete(r);
      void this.evictIfIdle(branchId, r);
    }, this.idleEvictMs);
    timer.unref?.();
    r.idleTimer = timer;
    this.idleTimers.set(r, timer);
  }

  private async evictIfIdle(branchId: string, r: Loaded): Promise<void> {
    if (this.closed || !this.isCurrentEntry(branchId, r) || !this.isIdle(r)) return;
    await this.withRoomLock(r, async () => {
      if (this.closed || !this.isCurrentEntry(branchId, r) || !this.isIdle(r)) return;
      this.clearIdleEvict(r);
      r.evicted = true;
      this.rooms.delete(branchId);
      this.branchRefreshGen.delete(branchId);
    });
  }

  /** 按分支在当前进程内串行执行，避免同一房间并发修改 / 追赶交错 */
  async withRoomLock<T>(r: Loaded, fn: () => Promise<T>): Promise<T> {
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

  /**
   * 获取当前活跃房间条目并在 withRoomLock 内串行执行：
   * - 若拿锁前该条目已被空闲卸载或删除，则透明重新加载并重试；
   * - 排队与执行期间通过 activeOps 与清除定时器阻止空闲卸载；
   * - 退出时（含异常路径）若房间处于空闲态，重新调度空闲卸载定时器。
   */
  async withActiveRoomLock<T>(
    branchId: string,
    fn: (r: Loaded) => Promise<T>,
  ): Promise<{ r: Loaded; value: T }> {
    for (;;) {
      const r = await this.get(branchId);
      if (!this.isCurrentEntry(branchId, r)) continue;
      this.clearIdleEvict(r);
      r.activeOps += 1;
      let stale = false;
      try {
        const value = await this.withRoomLock(r, async () => {
          if (!this.isCurrentEntry(branchId, r)) {
            stale = true;
            return undefined as T;
          }
          this.clearIdleEvict(r);
          return fn(r);
        });
        if (stale) continue;
        return { r, value };
      } finally {
        r.activeOps -= 1;
        if (!stale) this.scheduleIdleEvictIfNeeded(branchId, r);
      }
    }
  }

  /** 无写锁场景的追赶：在单次 REPEATABLE READ READ ONLY 快照事务中增量拉取 commits 与 rejections，避免读撕裂 */
  catchUpReadOnly(branchId: string, r: Loaded): Promise<Commit[]> {
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
  async catchUpFrom(db: Db, branchId: string, r: Loaded): Promise<Commit[]> {
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

  async reloadAndMissedLocked(branchId: string, r: Loaded): Promise<Commit[]> {
    const missed: Commit[] = [];
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
    return missed;
  }

  private async catchUpLoaded(
    branchId: string,
    r: Loaded,
    opts?: { excludePeer?: Peer; minSeq?: number },
  ): Promise<Commit[]> {
    const caughtUp = await this.withRoomLock(r, async () => {
      if (!this.isCurrentEntry(branchId, r)) return [];
      if (opts?.minSeq !== undefined && !r.dirty && r.room.seq >= opts.minSeq) return [];
      const missed = r.dirty ? await this.reloadAndMissedLocked(branchId, r) : [];
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
    if (!r || !this.isCurrentEntry(branchId, r)) return [];
    return this.catchUpLoaded(branchId, r, opts);
  }

  /**
   * 在 withRoomLock 内确保内存房间态与平台库一致（PG 追赶外部副本提交，SQLite/PG 脏态重载），
   * 并在持锁期间同步提取只读快照副本，彻底消除 SQLite/PG 并发写事务 COMMIT 前的未提交脏读窗口。
   */
  async readFresh<T>(branchId: string, read: (room: Room) => T): Promise<T> {
    const { r, value } = await this.withActiveRoomLock(branchId, async (loaded) => {
      const missed = loaded.dirty ? await this.reloadAndMissedLocked(branchId, loaded) : [];
      const fresh = this.db.dialect === 'pg' ? await this.catchUpReadOnly(branchId, loaded) : [];
      const caughtUp = missed.length > 0 ? [...missed, ...fresh] : fresh;
      return { caughtUp, snapshot: read(loaded.room) };
    });
    if (value.caughtUp.length) this.broadcastCommits(r, value.caughtUp);
    return value.snapshot;
  }

  /** 修改之后：每隔一段写一次快照，加快下次加载（传入事务 tx 以与 commit 同事务提交） */
  async maybeSnapshot(db: Db, branchId: string, room: Room) {
    if (room.seq <= 0 || room.seq % SNAPSHOT_EVERY !== 0) return;
    await db.query(
      'insert into room_snapshots (branch_id, seq, model, versions) values ($1, $2, $3::text::jsonb, $4::text::jsonb) on conflict do nothing',
      [branchId, room.seq, JSON.stringify(room.model), JSON.stringify(room.versions)],
    );
  }

  safeSend(peer: Peer, msg: ToClient | Extra) {
    try {
      peer.send(msg);
    } catch {
      // 连接可能正在关闭，忽略单个发送失败以免影响房间内其他连接
    }
  }

  broadcastCommits(r: Loaded, commits: Commit[], excludePeer?: Peer) {
    for (const c of commits) {
      for (const p of r.peers) {
        if (p !== excludePeer) this.safeSend(p, forPeer(p, c));
      }
    }
  }

  deliver(r: Loaded, from: Peer, outs: Out[]) {
    const fromSync = syncClientOf(from);
    for (const o of outs) {
      if (o.to === '*') {
        for (const p of r.peers) this.safeSend(p, forPeer(p, o.msg));
      } else if (fromSync && o.to === fromSync) {
        if (r.peers.has(from)) this.safeSend(from, forPeer(from, o.msg));
      } else {
        for (const p of r.peers) {
          if (syncClientOf(p) === o.to) this.safeSend(p, forPeer(p, o.msg));
        }
      }
    }
  }

  async publish(event: ClusterEventPayload) {
    if (!this.bus) return;
    try {
      await this.bus.publish(event);
    } catch (e) {
      if (!this.closed) console.error(`发布集群房间事件失败（t=${event.t}）`, e);
    }
  }

  trackPublish(event: ClusterEventPayload): Promise<void> {
    const p = this.publish(event).finally(() => {
      this.pendingBackgroundPublishes.delete(p);
    });
    this.pendingBackgroundPublishes.add(p);
    return p;
  }

  /** 推进权限刷新代际；不传 branchIds 表示全量影响所有已加载房间 */
  bumpRefreshGen(branchIds?: Iterable<string>) {
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

  refreshGenFor(branchId: string): number {
    return this.globalRefreshGen + (this.branchRefreshGen.get(branchId) ?? 0);
  }
}
