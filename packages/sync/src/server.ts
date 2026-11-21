// 服务器端的房间：一个分支的工作副本。按到达顺序逐个处理修改，冲突或不合法就拒绝。
import { deepEqual, EditError, type Model, type Obj } from '@dowel/core';
import {
  type Commit,
  execute,
  type Op,
  type Rejection,
  SYSTEM_CLIENT,
  type ToClient,
  type ToServer,
  type Versions,
} from './protocol.ts';

/** 持久化接口：先写操作日志再广播（04-ir-design.md 2.5） */
export interface RoomStore {
  append(commit: Commit, op: Op): Promise<void>;
  reject(client: string, r: Rejection): Promise<void>;
}

export interface RoomState {
  model: Model;
  versions: Versions;
  seq: number;
  /** 最近的提交，用于给重连的客户端补发；更早的直接发快照 */
  log: Commit[];
  processed: Record<string, number>;
  rejections: Record<string, Rejection[]>;
}

export type Out = { to: '*' | (string & {}); msg: ToClient };

class Reject extends Error {
  code: Rejection['code'];
  constructor(code: Rejection['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export const DEFAULT_LOG_LIMIT = 2000;
export const DEFAULT_OUTCOME_LIMIT = 4000;
export const DEFAULT_REJECTIONS_PER_CLIENT_LIMIT = 200;
export const DEFAULT_REJECTIONS_LIMIT = 2000;
export const DEFAULT_LAST_WRITER_LIMIT = 10_000;
export const DEFAULT_EVICTED_REJECTION_WATERMARK_LIMIT = 10_000;

export interface RoomOptions {
  /** 内存中保留的最近提交条数上限（默认 2000） */
  logLimit?: number;
  /** outcome 映射表最大条目数上限（默认 4000） */
  outcomeLimit?: number;
  /** 单个客户端在内存中保留的最近拒绝记录条数上限（默认 200） */
  rejectionsPerClientLimit?: number;
  /** 房间内所有客户端拒绝记录总条数上限（默认 2000） */
  rejectionsLimit?: number;
  /** lastWriter 映射表最大条目数上限（默认 10000；对象删除时会同步移除对应条目） */
  lastWriterLimit?: number;
  /** evictedRejectionWatermark 映射表最大客户端数上限（默认 Math.max(rejectionsLimit * 4, 10000)） */
  evictedRejectionWatermarkLimit?: number;
}

export interface RoomMemoryStats {
  log: number;
  outcome: number;
  lastWriter: number;
  rejections: number;
  rejectionClients: number;
  evictedRejectionWatermarks: number;
}

const normalizeLimit = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;

export class Room {
  private s: RoomState;
  private store: RoomStore;
  private queue: Promise<unknown> = Promise.resolve();
  /** “客户端:n” → 提交序号或被拒绝（换算客户端引用自己未确认修改的版本），按最近插入/访问顺序有界淘汰 */
  private outcome = new Map<string, number | 'rejected'>();
  /** 存活对象 ID → 最近写入用户名；对象从模型移除时同步清理，并设总量上限防极端场景无限增长 */
  private lastWriter = new Map<string, string>();
  /** 内存中保留的拒绝记录全局 FIFO 顺序（key = `${client}:${n}`），用于跨客户端总量裁剪 */
  private rejectionOrder = new Map<string, { client: string; n: number }>();
  /** 每个客户端已因容量上限淘汰的最大拒绝序号（有界），防止外部追赶重放旧拒绝挤掉活跃记录并触发 hello 快照兜底 */
  private evictedRejectionWatermark = new Map<string, number>();
  /** evictedRejectionWatermark 是否曾发生容量溢出（溢出后对老客户端保守走 snapshot 兜底并拦截无缺口旧重放） */
  private watermarkOverflowed = false;
  /** 外部提交跳号产生的待合入拒绝序号区间（用于 watermark 溢出后仍放行合法乱序的外部拒绝） */
  private externalRejectionGaps = new Map<string, { from: number; to: number }[]>();
  logLimit: number;
  readonly outcomeLimit: number;
  readonly rejectionsPerClientLimit: number;
  readonly rejectionsLimit: number;
  readonly lastWriterLimit: number;
  readonly evictedRejectionWatermarkLimit: number;

  constructor(state: RoomState, store: RoomStore, options: RoomOptions = {}) {
    this.s = state;
    this.store = store;
    this.logLimit = normalizeLimit(options.logLimit, DEFAULT_LOG_LIMIT);
    this.outcomeLimit = normalizeLimit(options.outcomeLimit, DEFAULT_OUTCOME_LIMIT);
    this.rejectionsPerClientLimit = normalizeLimit(
      options.rejectionsPerClientLimit,
      DEFAULT_REJECTIONS_PER_CLIENT_LIMIT,
    );
    this.rejectionsLimit = normalizeLimit(options.rejectionsLimit, DEFAULT_REJECTIONS_LIMIT);
    this.lastWriterLimit = normalizeLimit(options.lastWriterLimit, DEFAULT_LAST_WRITER_LIMIT);
    this.evictedRejectionWatermarkLimit = normalizeLimit(
      options.evictedRejectionWatermarkLimit,
      Math.max(this.rejectionsLimit * 4, DEFAULT_EVICTED_REJECTION_WATERMARK_LIMIT),
    );

    const lastSeenSeqByClient = new Map<string, number>();
    for (const c of state.log) {
      if (c.client !== SYSTEM_CLIENT) {
        lastSeenSeqByClient.set(c.client, c.seq);
      }
      for (const ch of c.changes) {
        if (ch.obj) {
          if (ch.id in state.model.objects) this.recordLastWriter(ch.id, c.user);
        } else {
          this.lastWriter.delete(ch.id);
        }
      }
    }
    if (state.log.length > this.logLimit) {
      state.log.splice(0, state.log.length - this.logLimit);
    }
    for (const c of state.log) {
      if (c.client !== SYSTEM_CLIENT) {
        this.recordOutcome(`${c.client}:${c.n}`, c.seq);
      }
    }

    // 重载/初始化拒绝记录时，先排不活跃客户端、后排近期活跃客户端，超全局上限时优先保留活跃客户端的近期拒绝
    const initialRejections = Object.entries(state.rejections)
      .filter(([, rs]) => rs.length > 0)
      .map(([client, rs], index) => ({
        client,
        rs,
        lastSeq: lastSeenSeqByClient.get(client) ?? -1,
        index,
      }))
      .sort((a, b) => a.lastSeq - b.lastSeq || a.index - b.index);
    this.s.rejections = {};
    for (const { client, rs } of initialRejections) {
      const sorted = [...rs].sort((a, b) => a.n - b.n);
      for (const r of sorted) {
        this.recordRejection(client, r);
      }
    }
    for (const key of this.rejectionOrder.keys()) {
      this.recordOutcome(key, 'rejected');
    }
  }

  get model(): Model {
    return this.s.model;
  }
  get seq(): number {
    return this.s.seq;
  }
  get versions(): Versions {
    return this.s.versions;
  }
  get stats(): RoomMemoryStats {
    return {
      log: this.s.log.length,
      outcome: this.outcome.size,
      lastWriter: this.lastWriter.size,
      rejections: this.rejectionOrder.size,
      rejectionClients: Object.keys(this.s.rejections).length,
      evictedRejectionWatermarks: this.evictedRejectionWatermark.size,
    };
  }

  /** 处理一条消息；按到达顺序串行执行。返回要发出的消息。readOnly：只读成员，修改一律拒绝 */
  handle(
    client: string,
    user: string,
    msg: ToServer,
    opts: { readOnly?: boolean; store?: RoomStore } = {},
  ): Promise<Out[]> {
    return this.enqueue(() => this.process(client, user, msg, !!opts.readOnly, opts.store ?? this.store));
  }

  /** 服务器以系统身份把模型整体替换成 next（如导入 DDL），作为一个普通提交广播 */
  replace(user: string, next: Model, opName = 'replaceModel', store?: RoomStore): Promise<Out[]> {
    return this.enqueue(async () => {
      const s = this.s;
      const targetStore = store ?? this.store;
      const changes = [];
      for (const [id, o] of Object.entries(next.objects))
        if (!deepEqual(s.model.objects[id], o)) changes.push({ id, obj: structuredClone(o) });
      for (const id of Object.keys(s.model.objects))
        if (!(id in next.objects)) changes.push({ id, obj: null });
      const n = (s.processed[SYSTEM_CLIENT] ?? 0) + 1;
      const commit: Commit = { t: 'commit', seq: s.seq + 1, client: SYSTEM_CLIENT, n, user, changes };
      await targetStore.append(commit, { client: SYSTEM_CLIENT, n, name: opName, args: null, reads: [] });
      s.processed[SYSTEM_CLIENT] = n;
      this.commit(commit, structuredClone(next), user);
      return [{ to: '*', msg: commit }];
    });
  }

  /**
   * 服务器以系统身份更新一些对象（派生数据，如不透明对象的规范 DDL）。
   * expect：这些对象在派生计算开始时的版本；期间被别人改过的对象不写（避免用过期结果覆盖用户的修改）。
   */
  patch(
    user: string,
    objects: Obj[],
    expect: Versions,
    opName = 'derive',
    store?: RoomStore,
  ): Promise<Out[]> {
    return this.enqueue(async () => {
      const s = this.s;
      const targetStore = store ?? this.store;
      const changes = objects
        .filter((o) => o.id in s.model.objects && (s.versions[o.id] ?? 0) === (expect[o.id] ?? 0))
        .filter((o) => !deepEqual(s.model.objects[o.id], o))
        .map((o) => ({ id: o.id, obj: structuredClone(o) }));
      if (!changes.length) return [];
      const next = structuredClone(s.model);
      for (const c of changes) next.objects[c.id] = c.obj;
      const n = (s.processed[SYSTEM_CLIENT] ?? 0) + 1;
      const commit: Commit = { t: 'commit', seq: s.seq + 1, client: SYSTEM_CLIENT, n, user, changes };
      await targetStore.append(commit, { client: SYSTEM_CLIENT, n, name: opName, args: null, reads: [] });
      s.processed[SYSTEM_CLIENT] = n;
      this.commit(commit, next, user);
      return [{ to: '*', msg: commit }];
    });
  }

  /**
   * 合并外部副本已持久化的提交到当前内存态（幂等：已应用过的 seq 直接忽略）。
   * 调用方需保证与 handle/replace/patch 互斥并按 seq 严格递增传入。
   */
  applyExternalCommit(commit: Commit): boolean {
    const s = this.s;
    if (commit.seq <= s.seq) return false;
    if (commit.seq !== s.seq + 1) {
      throw new Error(`外部提交序号不连续：期望 ${s.seq + 1}，收到 ${commit.seq}`);
    }
    const next: Model = { ...s.model, objects: { ...s.model.objects } };
    for (const c of commit.changes) {
      if (c.obj) next.objects[c.id] = structuredClone(c.obj);
      else delete next.objects[c.id];
    }
    const prevProcessed = s.processed[commit.client] ?? 0;
    if (commit.client !== SYSTEM_CLIENT && commit.n > prevProcessed + 1) {
      this.recordExternalRejectionGap(commit.client, prevProcessed + 1, commit.n - 1);
    }
    if (prevProcessed < commit.n) {
      s.processed[commit.client] = commit.n;
    }
    this.commit(commit, next, commit.user);
    return true;
  }

  /** 合并外部副本已持久化的拒绝记录到当前内存态（幂等：已存在或已淘汰的旧拒绝记录直接忽略） */
  applyExternalRejection(client: string, r: Rejection): boolean {
    if (!client || client.toLowerCase() === SYSTEM_CLIENT) return false;
    const s = this.s;
    const key = `${client}:${r.n}`;
    if (this.outcome.get(key) === 'rejected') return false;
    const done = s.processed[client] ?? 0;
    if (r.n <= done) {
      const inGap = this.consumeExternalRejectionGap(client, r.n);
      if (this.watermarkOverflowed && !inGap) {
        return false;
      }
    }
    if (!this.recordRejection(client, r)) return false;
    if (done < r.n) {
      s.processed[client] = r.n;
    }
    this.recordOutcome(key, 'rejected');
    return true;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private recordOutcome(key: string, value: number | 'rejected') {
    if (this.outcome.has(key)) this.outcome.delete(key);
    this.outcome.set(key, value);
    while (this.outcome.size > this.outcomeLimit) {
      const oldest = this.outcome.keys().next().value;
      if (oldest === undefined) break;
      this.outcome.delete(oldest);
    }
  }

  private recordLastWriter(id: string, user: string) {
    if (this.lastWriter.has(id)) this.lastWriter.delete(id);
    this.lastWriter.set(id, user);
    while (this.lastWriter.size > this.lastWriterLimit) {
      const oldest = this.lastWriter.keys().next().value;
      if (oldest === undefined) break;
      this.lastWriter.delete(oldest);
    }
  }

  private markEvictedRejection(client: string, n: number) {
    const prev = this.evictedRejectionWatermark.get(client);
    const next = prev !== undefined ? Math.max(prev, n) : n;
    if (prev !== undefined) this.evictedRejectionWatermark.delete(client);
    this.evictedRejectionWatermark.set(client, next);
    while (this.evictedRejectionWatermark.size > this.evictedRejectionWatermarkLimit) {
      const oldest = this.evictedRejectionWatermark.keys().next().value;
      if (oldest === undefined) break;
      this.evictedRejectionWatermark.delete(oldest);
      this.watermarkOverflowed = true;
    }
  }

  private recordExternalRejectionGap(client: string, from: number, to: number) {
    if (from > to) return;
    const prev = this.externalRejectionGaps.get(client);
    const ranges = prev ? [...prev] : [];
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) {
      if (to > last.to) last.to = to;
    } else {
      ranges.push({ from, to });
    }
    const perClientCap = Math.min(this.rejectionsPerClientLimit, this.rejectionsLimit);
    if (ranges.length > perClientCap) {
      ranges.splice(0, ranges.length - perClientCap);
    }
    if (prev !== undefined) this.externalRejectionGaps.delete(client);
    this.externalRejectionGaps.set(client, ranges);
    while (this.externalRejectionGaps.size > this.rejectionsLimit) {
      const oldest = this.externalRejectionGaps.keys().next().value;
      if (oldest === undefined) break;
      this.externalRejectionGaps.delete(oldest);
    }
  }

  private consumeExternalRejectionGap(client: string, n: number): boolean {
    const ranges = this.externalRejectionGaps.get(client);
    if (!ranges) return false;
    const idx = ranges.findIndex((r) => n >= r.from && n <= r.to);
    if (idx === -1) return false;
    const target = ranges[idx]!;
    if (target.from === target.to) {
      ranges.splice(idx, 1);
    } else if (n === target.from) {
      target.from++;
    } else if (n === target.to) {
      target.to--;
    } else {
      ranges.splice(idx, 1, { from: target.from, to: n - 1 }, { from: n + 1, to: target.to });
      const perClientCap = Math.min(this.rejectionsPerClientLimit, this.rejectionsLimit);
      if (ranges.length > perClientCap) {
        ranges.splice(0, ranges.length - perClientCap);
      }
    }
    if (ranges.length === 0) this.externalRejectionGaps.delete(client);
    return true;
  }

  private trimGlobalRejections() {
    while (this.rejectionOrder.size > this.rejectionsLimit) {
      const first = this.rejectionOrder.entries().next().value;
      if (!first) break;
      const [key, entry] = first;
      const list = this.s.rejections[entry.client];
      if (!list || list.length === 0) {
        this.rejectionOrder.delete(key);
        delete this.s.rejections[entry.client];
        continue;
      }
      // 对同一客户端始终优先淘汰序号最小的旧拒绝，避免乱序合入时误删较新拒绝并推高 watermark
      const oldestForClient = list.shift()!;
      const dropKey = `${entry.client}:${oldestForClient.n}`;
      this.rejectionOrder.delete(dropKey);
      if (list.length === 0) delete this.s.rejections[entry.client];
      this.markEvictedRejection(entry.client, oldestForClient.n);
      if (dropKey !== key) {
        this.rejectionOrder.delete(key);
        this.rejectionOrder.set(key, entry);
      }
    }
  }

  private recordRejection(client: string, r: Rejection): boolean {
    const s = this.s;
    const existing = s.rejections[client];
    if (existing?.some((x) => x.n === r.n)) return false;
    if (r.n <= (this.evictedRejectionWatermark.get(client) ?? 0)) return false;

    const perClientCap = Math.min(this.rejectionsPerClientLimit, this.rejectionsLimit);
    if (existing && existing.length >= perClientCap && r.n < existing[0]!.n) {
      this.markEvictedRejection(client, r.n);
      return false;
    }

    const next = existing ? [...existing, { ...r }] : [{ ...r }];
    if (next.length > 1 && next[next.length - 1]!.n < next[next.length - 2]!.n) {
      next.sort((a, b) => a.n - b.n);
    }
    while (next.length > perClientCap) {
      const dropped = next.shift()!;
      this.rejectionOrder.delete(`${client}:${dropped.n}`);
      this.markEvictedRejection(client, dropped.n);
    }
    s.rejections[client] = next;

    const key = `${client}:${r.n}`;
    if (this.rejectionOrder.has(key)) this.rejectionOrder.delete(key);
    this.rejectionOrder.set(key, { client, n: r.n });
    this.trimGlobalRejections();
    return true;
  }

  private commit(commit: Commit, next: Model, user: string) {
    const s = this.s;
    s.seq = commit.seq;
    s.model = next;
    for (const c of commit.changes) {
      if (c.obj) {
        s.versions[c.id] = commit.seq;
        this.recordLastWriter(c.id, user);
      } else {
        delete s.versions[c.id];
        this.lastWriter.delete(c.id);
      }
    }
    s.log.push(commit);
    if (s.log.length > this.logLimit) s.log.splice(0, s.log.length - this.logLimit);
    if (commit.client !== SYSTEM_CLIENT) {
      this.recordOutcome(`${commit.client}:${commit.n}`, commit.seq);
    }
  }

  private async process(
    client: string,
    user: string,
    msg: ToServer,
    readOnly: boolean,
    store: RoomStore,
  ): Promise<Out[]> {
    if (!client || client.toLowerCase() === SYSTEM_CLIENT) {
      throw new Error('无效的客户端标识');
    }
    const s = this.s;
    if (msg.t === 'hello') {
      if (msg.client !== client) return [];
      const lastProcessed = s.processed[client] ?? 0;
      const out: Out[] = [
        {
          to: client,
          msg: {
            t: 'welcome',
            lastProcessed,
            rejected: [...(s.rejections[client] ?? [])],
          },
        },
      ];
      const oldest = s.log[0]?.seq ?? s.seq + 1;
      // 该客户端曾有拒绝记录被淘汰（或 watermark 曾溢出且客户端有已处理记录）时，强制下发 snapshot，
      // 防止 SyncClient 走增量 log 分支导致缺失拒绝记录的 pending 项永久卡死并引起视图分叉。
      const rejectionEvicted =
        (this.evictedRejectionWatermark.get(client) ?? 0) > 0 ||
        (this.watermarkOverflowed && lastProcessed > 0);
      if (msg.lastSeq === 0 || msg.lastSeq + 1 < oldest || rejectionEvicted) {
        out.push({
          to: client,
          msg: {
            t: 'snapshot',
            seq: s.seq,
            model: structuredClone(s.model),
            versions: { ...s.versions },
            lastProcessed,
          },
        });
      } else for (const c of s.log) if (c.seq > msg.lastSeq) out.push({ to: client, msg: c });
      return out;
    }
    const op = msg.op;
    if (op.client !== client) return [];
    // 只读成员直接返回 reject，不推进 s.processed[client]、不落库 room_rejections，防止污染幂等状态
    if (readOnly) {
      return [
        {
          to: client,
          msg: { t: 'reject', n: op.n, code: 'invalid', message: '你在这个项目里是查看者，不能修改' },
        },
      ];
    }
    const done = s.processed[client] ?? 0;
    if (op.n <= done) return []; // 重复发送
    if (op.n !== done + 1) throw new Error(`修改乱序：期望 ${done + 1}，收到 ${op.n}`);
    try {
      this.checkReads(op);
      let result: ReturnType<typeof execute>;
      try {
        result = execute(s.model, op.name, op.args); // 在最新状态上重新执行，校验以服务器为准
      } catch (e) {
        if (e instanceof EditError) throw new Reject('invalid', e.message);
        throw e;
      }
      const commit: Commit = { t: 'commit', seq: s.seq + 1, client, n: op.n, user, changes: result.changes };
      await store.append(commit, op);
      s.processed[client] = op.n;
      this.commit(commit, result.next, user);
      return [{ to: '*', msg: commit }];
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      const r: Rejection = { n: op.n, code: e.code, message: e.message };
      await store.reject(client, r);
      s.processed[client] = op.n;
      this.recordOutcome(`${client}:${op.n}`, 'rejected');
      this.recordRejection(client, r);
      return [{ to: client, msg: { t: 'reject', ...r } }];
    }
  }

  /** 修改依据的对象如果之后被别人改过，就拒绝（先到先得） */
  private checkReads(op: Op) {
    const s = this.s;
    const ownPendingPrefix = `p:${op.client}:`;
    for (const [id, seen] of op.reads) {
      let expected = seen;
      if (typeof seen === 'string') {
        if (!seen.startsWith(ownPendingPrefix)) {
          throw new Reject('dependency', '依赖的修改不存在');
        }
        const outcomeKey = seen.slice(2);
        const o = this.outcome.get(outcomeKey);
        if (o === undefined) throw new Reject('dependency', '依赖的修改不存在');
        // 命中后刷新到最近位置，保护同一客户端流水线未确认操作对前序结果的持续引用
        this.outcome.delete(outcomeKey);
        this.outcome.set(outcomeKey, o);
        if (o === 'rejected') throw new Reject('dependency', '依赖的上一个修改已被拒绝');
        expected = o;
      }
      const cur = s.model.objects[id];
      const now = cur ? (s.versions[id] ?? 0) : null;
      const ok = expected === null ? now === null : now !== null && (now as number) <= (expected as number);
      if (!ok) {
        const who = this.lastWriter.get(id) ?? '其他人';
        const what = cur ? `${kindName[cur.kind] ?? cur.kind} ${cur.name}` : '对象';
        throw new Reject('conflict', `${what} 已被 ${who} ${cur ? '修改' : '删除'}，请在最新数据上重新操作`);
      }
    }
  }
}

const kindName: Record<string, string> = {
  schema: 'schema',
  table: '表',
  column: '列',
  enum: '枚举',
  sequence: '序列',
  primaryKey: '主键',
  unique: '唯一约束',
  foreignKey: '外键',
  check: 'CHECK 约束',
  index: '索引',
  opaque: '对象',
  extension: '扩展',
};

export const emptyRoomState = (model: Model): RoomState => ({
  model,
  versions: {},
  seq: 0,
  log: [],
  processed: {},
  rejections: {},
});

export const memoryStore = (): RoomStore & { commits: Commit[] } => {
  const commits: Commit[] = [];
  return {
    commits,
    append: async (c) => {
      commits.push(c);
    },
    reject: async () => {},
  };
};
