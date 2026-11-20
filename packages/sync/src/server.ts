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

export type Out = { to: string | '*'; msg: ToClient };

class Reject extends Error {
  code: Rejection['code'];
  constructor(code: Rejection['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export class Room {
  private s: RoomState;
  private store: RoomStore;
  private queue: Promise<unknown> = Promise.resolve();
  /** “客户端:n” → 提交序号或被拒绝（换算客户端引用自己未确认修改的版本） */
  private outcome = new Map<string, number | 'rejected'>();
  private lastWriter = new Map<string, string>();
  logLimit = 2000;

  constructor(state: RoomState, store: RoomStore) {
    this.s = state;
    this.store = store;
    for (const c of state.log) {
      this.outcome.set(`${c.client}:${c.n}`, c.seq);
      for (const ch of c.changes) this.lastWriter.set(ch.id, c.user);
    }
    for (const [client, rs] of Object.entries(state.rejections))
      for (const r of rs) this.outcome.set(`${client}:${r.n}`, 'rejected');
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
    if ((s.processed[commit.client] ?? 0) < commit.n) {
      s.processed[commit.client] = commit.n;
    }
    this.commit(commit, next, commit.user);
    return true;
  }

  /** 合并外部副本已持久化的拒绝记录到当前内存态（幂等：已存在的拒绝记录直接忽略） */
  applyExternalRejection(client: string, r: Rejection): boolean {
    if (!client || client.toLowerCase() === SYSTEM_CLIENT) return false;
    const s = this.s;
    const key = `${client}:${r.n}`;
    if (this.outcome.get(key) === 'rejected') return false;
    if ((s.processed[client] ?? 0) < r.n) {
      s.processed[client] = r.n;
    }
    this.outcome.set(key, 'rejected');
    const existing = s.rejections[client] ?? [];
    if (!existing.some((x) => x.n === r.n)) {
      s.rejections[client] = [...existing, { ...r }].sort((a, b) => a.n - b.n);
    }
    return true;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private commit(commit: Commit, next: Model, user: string) {
    const s = this.s;
    s.seq = commit.seq;
    s.model = next;
    for (const c of commit.changes) {
      if (c.obj) s.versions[c.id] = commit.seq;
      else delete s.versions[c.id];
      this.lastWriter.set(c.id, user);
    }
    s.log.push(commit);
    if (s.log.length > this.logLimit) s.log.splice(0, s.log.length - this.logLimit);
    this.outcome.set(`${commit.client}:${commit.n}`, commit.seq);
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
      const out: Out[] = [
        {
          to: client,
          msg: {
            t: 'welcome',
            lastProcessed: s.processed[client] ?? 0,
            rejected: s.rejections[client] ?? [],
          },
        },
      ];
      const oldest = s.log[0]?.seq ?? s.seq + 1;
      if (msg.lastSeq === 0 || msg.lastSeq + 1 < oldest) {
        out.push({
          to: client,
          msg: {
            t: 'snapshot',
            seq: s.seq,
            model: structuredClone(s.model),
            versions: { ...s.versions },
            lastProcessed: s.processed[client] ?? 0,
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
      this.outcome.set(`${client}:${op.n}`, 'rejected');
      s.rejections[client] = [...(s.rejections[client] ?? []), r];
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
        const o = this.outcome.get(seen.slice(2));
        if (o === 'rejected') throw new Reject('dependency', '依赖的上一个修改已被拒绝');
        if (o === undefined) throw new Reject('dependency', '依赖的修改不存在');
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
