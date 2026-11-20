// 同步房间的管理：每个分支一个房间，按需从数据库加载（最新快照 + 之后的操作日志），
// 修改持久化后广播给房间里的所有连接；另外转发画布布局和在线状态这两类不进操作日志的消息。

import type { CanvasHistoryEntry, CanvasHistoryList, CanvasHistoryVersionRef, Role } from '@dowel/api';
import type { Model, Obj } from '@dowel/core';
import {
  type Commit,
  emptyRoomState,
  type Out,
  type Rejection,
  Room,
  type RoomState,
  type ToClient,
  type ToServer,
  type Versions,
} from '@dowel/sync';
import { HTTPException } from 'hono/http-exception';
import type { User } from './auth.ts';
import { inList, type PlatformDb } from './db.ts';
import type { RoleLookup } from './roles.ts';
import { atOf } from './time.ts';

export type { Role } from '@dowel/api';

const SNAPSHOT_EVERY = 200;
const HISTORY_SUMMARY_LIMIT = 5;

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

interface Loaded {
  room: Room;
  peers: Set<Peer>;
  layout: Layout;
  layoutTimer?: ReturnType<typeof setTimeout>;
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

  constructor(db: PlatformDb, resolveRole: ResolveRole) {
    this.db = db;
    this.resolveRole = resolveRole;
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

  private async load(branchId: string): Promise<Loaded> {
    const db = this.db;
    const [snap] = await db.query<{ seq: string; model: Model; versions: Versions }>(
      'select seq, model, versions from room_snapshots where branch_id = $1 order by seq desc limit 1',
      [branchId],
    );
    if (!snap) throw new Error(`分支 ${branchId} 没有初始快照`);
    const state: RoomState = emptyRoomState(snap.model);
    state.versions = snap.versions;
    state.seq = Number(snap.seq);
    const after = await db.query<{
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
    // 最近的提交用于给重连的客户端补发
    const recent = await db.query<{
      seq: string;
      client: string;
      n: number;
      user_name: string;
      changes: Commit['changes'];
    }>(
      `select seq, client, n, user_name, changes from
         (select * from room_commits where branch_id = $1 order by seq desc limit 2000) x order by seq`,
      [branchId],
    );
    state.log = recent.map((c) => ({
      t: 'commit',
      seq: Number(c.seq),
      client: c.client,
      n: c.n,
      user: c.user_name,
      changes: c.changes,
    }));
    for (const r of await db.query<{ client: string; n: number }>(
      `select client, max(n) as n from (
         select client, n from room_commits where branch_id = $1
         union all select client, n from room_rejections where branch_id = $1) x group by client`,
      [branchId],
    ))
      state.processed[r.client] = Number(r.n);
    for (const r of await db.query<{ client: string; n: number; code: Rejection['code']; message: string }>(
      'select client, n, code, message from room_rejections where branch_id = $1 order by n',
      [branchId],
    ))
      state.rejections[r.client] = [
        ...(state.rejections[r.client] ?? []),
        { n: r.n, code: r.code, message: r.message },
      ];

    const room = new Room(state, {
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
        await db.query(
          'insert into room_rejections (branch_id, client, n, code, message) values ($1, $2, $3, $4, $5)',
          [branchId, client, r.n, r.code, r.message],
        );
      },
    });
    const [b] = await db.query<{ layout: Layout }>('select layout from branches where id = $1', [branchId]);
    return { room, peers: new Set(), layout: b?.layout ?? {} };
  }

  /** 修改之后：每隔一段写一次快照，加快下次加载 */
  private async maybeSnapshot(branchId: string, room: Room) {
    if (room.seq % SNAPSHOT_EVERY !== 0) return;
    await this.db.query(
      'insert into room_snapshots (branch_id, seq, model, versions) values ($1, $2, $3::text::jsonb, $4::text::jsonb) on conflict do nothing',
      [branchId, room.seq, JSON.stringify(room.model), JSON.stringify(room.versions)],
    );
  }

  private deliver(r: Loaded, from: Peer, outs: Out[]) {
    for (const o of outs) {
      if (o.to === '*') for (const p of r.peers) p.send(o.msg);
      else if (o.to === from.client) from.send(o.msg);
      else for (const p of r.peers) if (p.client === o.to) p.send(o.msg);
    }
  }

  private peerList(r: Loaded) {
    return [...r.peers].filter((p) => p.client).map((p) => ({ client: p.client!, user: p.user.name }));
  }

  /** 账号是否还能用：停用之后不能继续实时协作 */
  private async userActive(userId: string): Promise<boolean> {
    const [row] = await this.db.query<{ status: string }>('select status from users where id = $1', [userId]);
    return row?.status === 'active';
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
   * 加入房间。**先**把 peer 放进集合，再做两次复查，避免“升级之后、join 之前”状态已经变了：
   * 1. 账号是否还能用（停用后不能继续实时协作）；
   * 2. 重新算一次生效角色——授权、组成员、默认权限可能正好在这之间被改，
   *    算不到就让位（4403），和升级时不一样就更新并通知客户端。
   * join 成功（含重连）后总会发一条 role，前端以它为准校正本地状态。
   */
  async join(branchId: string, peer: Peer) {
    const r = await this.get(branchId);
    r.peers.add(peer);
    if (!(await this.userActive(peer.user.id))) {
      r.peers.delete(peer);
      peer.close?.(4403, '账号已被停用');
      for (const p of r.peers) p.send({ t: 'peers', peers: this.peerList(r) });
      return;
    }
    const projectId = await this.projectOfBranch(branchId);
    const role = projectId ? await this.resolveRole(peer.user, projectId) : null;
    if (!role) {
      r.peers.delete(peer);
      peer.close?.(4403, '你在这个项目里已经没有权限');
      for (const p of r.peers) p.send({ t: 'peers', peers: this.peerList(r) });
      return;
    }
    peer.role = role;
    peer.send({ t: 'role', role });
    peer.send({ t: 'layout', positions: r.layout });
  }

  async leave(branchId: string, peer: Peer) {
    // 分攴可能已经被删掉（项目删除）：加载失败就当没进过房间，不能抛出去
    const r = await this.get(branchId).catch(() => null);
    if (!r) return;
    // 已经被踢掉的连接走 onClose 时不用再广播一次
    if (!r.peers.delete(peer)) return;
    for (const p of r.peers) p.send({ t: 'peers', peers: this.peerList(r) });
  }

  async message(branchId: string, peer: Peer, msg: ToServer | ExtraIn) {
    const r = await this.get(branchId);
    // 不在房间里（例如账号刚被停用踢掉）就直接丢弃：不提交、不广播、不回消息
    if (!r.peers.has(peer)) return;
    if (msg.t === 'hello') {
      peer.client = msg.client;
      for (const p of r.peers) p.send({ t: 'peers', peers: this.peerList(r) });
    }
    if (msg.t === 'hello' || msg.t === 'op') {
      if (msg.t === 'op' && msg.op.client !== peer.client) return;
      const outs = await r.room.handle(peer.client!, peer.user.name, msg, {
        readOnly: peer.role === 'viewer',
      });
      this.deliver(r, peer, outs);
      if (outs.some((o) => o.msg.t === 'commit')) this.onCommit(branchId);
      await this.maybeSnapshot(branchId, r.room);
      return;
    }
    if (msg.t === 'layout') {
      if (peer.role === 'viewer') return;
      // 处理过程中可能已经被踢出房间（以后这里加了 await 也不会漏）
      if (!r.peers.has(peer)) return;
      Object.assign(r.layout, msg.positions);
      for (const p of r.peers) if (p !== peer) p.send({ t: 'layout', positions: msg.positions });
      clearTimeout(r.layoutTimer);
      r.layoutTimer = setTimeout(() => {
        r.layoutTimer = undefined;
        void this.db.query('update branches set layout = $2::text::jsonb where id = $1', [
          branchId,
          JSON.stringify(r.layout),
        ]);
      }, 500);
      return;
    }
    if (msg.t === 'presence' && peer.client) {
      for (const p of r.peers)
        if (p !== peer) p.send({ t: 'presence', client: peer.client, user: peer.user.name, data: msg.data });
    }
  }

  /** 服务器以系统身份替换整个模型（导入 DDL、恢复历史、接入领先环境等）；传入 expectedSeq 时原子校验当前 seq */
  async replace(branchId: string, user: string, next: Model, opName?: string, expectedSeq?: number) {
    const r = await this.get(branchId);
    if (expectedSeq !== undefined && r.room.seq !== expectedSeq)
      throw new WorkingChangedError(r.room.seq, structuredClone(r.room.model));
    const outs = await r.room.replace(user, next, opName);
    for (const o of outs) for (const p of r.peers) p.send(o.msg);
    await this.maybeSnapshot(branchId, r.room);
  }

  /** 服务器以系统身份更新派生数据（期间被别人改过的对象不写） */
  async patch(branchId: string, user: string, objects: Obj[], expect: Versions) {
    const r = await this.get(branchId);
    const outs = await r.room.patch(user, objects, expect);
    for (const o of outs) for (const p of r.peers) p.send(o.msg);
    await this.maybeSnapshot(branchId, r.room);
  }

  async state(branchId: string): Promise<{ model: Model; versions: Versions; seq: number }> {
    const r = await this.get(branchId);
    return { model: structuredClone(r.room.model), versions: { ...r.room.versions }, seq: r.room.seq };
  }

  async model(branchId: string): Promise<{ model: Model; seq: number }> {
    const r = await this.get(branchId);
    return { model: structuredClone(r.room.model), seq: r.room.seq };
  }

  /**
   * 重建任意 seq（含 0）的完整模型：从不大于 seq 的最新快照出发，按序重放后续提交。
   * seq < 0 或超过当前最新 seq 时抛 404。
   */
  async modelAt(branchId: string, seq: number): Promise<Model> {
    const r = await this.get(branchId);
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
    const rows = await this.db.query<{ id: string; seq: string | number; number: number; name: string }>(
      `select id, seq, number, name from versions
        where branch_id = $1 and seq >= $2 and seq <= $3
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
    const r = await this.get(branchId);
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
    const r = await this.get(branchId);
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

  /**
   * 角色可能变了之后，重算**所有已经加载的房间**里每个在线 peer 的生效角色（G6）。
   * 组成员、组 / 项目默认权限、授权、转组、删除组、停用或改实例角色之后都调用它。
   *
   * - 只遍历 this.rooms：没人在线的分支不在里面，所以没有连接时整次刷新是零查询；
   * - 分支 → 项目用一条查询反查，角色上下文按用户缓存，整次刷新共享；
   * - 没有权限了 → 4403 断开（沿用停用账号的关闭码，客户端收到后不再重连）；
   * - 账号被停用 → 同样断开；
   * - 降级 / 升级 → 更新 peer.role 并发一条 role 消息，客户端切换只读。
   */
  async refreshLoaded() {
    if (this.rooms.size === 0) return;
    const branchIds = [...this.rooms.keys()];
    // 分支 → 项目只反查一次（同一个项目可能有多个分支的房间）
    const projects = await this.db.query<{ branchId: string; projectId: string }>(
      `select id as "branchId", project_id as "projectId" from branches where id in (${inList(branchIds)})`,
      branchIds,
    );
    const projectByBranch = new Map(projects.map((p) => [p.branchId, p.projectId]));
    // 整次刷新共用：用户当前状态（可能刚被停用 / 改了实例角色）+ 角色上下文 / 项目缓存
    const users = new Map<string, { role: User['role']; status: string } | null>();
    const lookup: RoleLookup = { contexts: new Map(), projects: new Map() };
    const kick = (r: Loaded, peer: Peer, reason: string) => {
      peer.close?.(4403, reason);
      r.peers.delete(peer);
    };

    for (const [branchId, pending] of this.rooms) {
      const projectId = projectByBranch.get(branchId);
      const r = await pending.catch(() => null);
      if (!projectId || !r) continue;
      let removed = false;
      for (const peer of [...r.peers]) {
        let current = users.get(peer.user.id);
        if (current === undefined) {
          const [row] = await this.db.query<{ role: User['role']; status: string }>(
            'select role, status from users where id = $1',
            [peer.user.id],
          );
          current = row ?? null;
          users.set(peer.user.id, current);
        }
        if (current?.status !== 'active') {
          kick(r, peer, '账号已被停用');
          removed = true;
          continue;
        }
        const role = await this.resolveRole({ ...peer.user, role: current.role }, projectId, lookup);
        if (!role) {
          kick(r, peer, '你在这个项目里已经没有权限');
          removed = true;
          continue;
        }
        if (role !== peer.role) {
          peer.role = role;
          peer.send({ t: 'role', role });
        }
      }
      // 只给真正踢掉了人的房间广播在线列表
      if (removed) for (const p of r.peers) p.send({ t: 'peers', peers: this.peerList(r) });
    }
  }

  /**
   * 分支被删掉（项目被删除）时立即断开里面所有连接：和“没有权限了”用同一个关闭码 4403，
   * 客户端收到后不会再重连。房间从缓存里移除，避免继续拿着已经不存在的分支。
   */
  async kickBranches(branchIds: string[], reason: string) {
    const gone = new Set(branchIds);
    for (const [branchId, pending] of this.rooms) {
      if (!gone.has(branchId)) continue;
      const r = await pending.catch(() => null);
      if (r)
        for (const peer of [...r.peers]) {
          peer.close?.(4403, reason);
          r.peers.delete(peer);
        }
      this.rooms.delete(branchId);
    }
  }

  /** 测试和排查用：这个分支的房间是否已经加载在内存里 */
  has(branchId: string): boolean {
    return this.rooms.has(branchId);
  }

  /** 立即写入所有挂起的布局（关闭服务和测试时用） */
  async flush() {
    for (const [branchId, p] of this.rooms) {
      const r = await p;
      if (!r.layoutTimer) continue;
      clearTimeout(r.layoutTimer);
      r.layoutTimer = undefined;
      await this.db.query('update branches set layout = $2::text::jsonb where id = $1', [
        branchId,
        JSON.stringify(r.layout),
      ]);
    }
  }
}
