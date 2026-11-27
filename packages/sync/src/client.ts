// 客户端：已确认状态 + 待确认修改队列；收到服务器的提交后在新状态上重放队列（rebase）。
import { EditError, type Model, MutableModelIndex } from '@dowel/core';

import {
  applyChanges,
  type Commit,
  exceedsUtf8Bytes,
  execute,
  MAX_SYNC_MESSAGE_BYTES,
  type Op,
  opReads,
  type ToClient,
  type ToServer,
  utf8Bytes,
  type Ver,
  type Versions,
  verOf,
} from './protocol.ts';

export interface PendingOp extends Op {
  /** 在当前已确认状态上已经执行不了：服务器一定会拒绝它，界面上标为冲突 */
  stale?: boolean;
}

/** 修改序列化后超过单条同步消息上限：本地拒绝，不发送、不进待确认队列 */
export class SyncMessageTooLargeError extends EditError {
  readonly bytes: number;
  readonly max: number;
  constructor(bytes: number, max: number) {
    super(
      `这次修改太大（约 ${(bytes / 1048576).toFixed(1)} MB），超过单条同步消息上限 ${(max / 1048576).toFixed(0)} MB，没有提交。请分批操作。`,
    );
    this.bytes = bytes;
    this.max = max;
  }
}

export interface SyncClientOptions {
  /** 单条 op 消息的字节上限（默认 MAX_SYNC_MESSAGE_BYTES，测试可调小） */
  maxMessageBytes?: number;
}

export class SyncClient {
  readonly id: string;
  confirmed: Model;
  versions: Versions = {};
  seq = 0;
  pending: PendingOp[] = [];
  /** 界面看到的状态 = 已确认状态 + 依次重放的待确认修改 */
  view: Model;
  viewVersions: Versions = {};
  online = false;
  /** 收到 welcome 之前不能发送：否则新修改会先于断线期间积压的修改到达（原型的随机测试发现） */
  ready = false;
  notices: { n: number; message: string }[] = [];
  private nextN = 1;
  private early = new Map<number, Commit>();
  private listeners = new Set<() => void>();
  private confirmedIndex: MutableModelIndex | null = null;
  send: (m: ToServer) => void = () => {};
  private readonly maxMessageBytes: number;

  constructor(id: string, model: Model, options: SyncClientOptions = {}) {
    this.id = id;
    this.confirmed = model;
    this.view = model;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_SYNC_MESSAGE_BYTES;
  }

  private getConfirmedIndex(): MutableModelIndex {
    if (!this.confirmedIndex) {
      this.confirmedIndex = new MutableModelIndex(this.confirmed);
    }
    return this.confirmedIndex;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 发起修改。basis：编辑框打开时记下的对象版本（草稿场景，见 04-ir-design.md 2.3）。
   * 本地执行不合法时直接抛 EditError，不发给服务器；序列化后超过单条消息上限时抛 SyncMessageTooLargeError
   * （服务端会以 1009 断开这样的连接，重连后重发同一条又会被断开，所以必须在进队列之前拒绝）。
   */
  mutate(name: string, args: unknown, basis?: Versions): number {
    const baseIdx = this.pending.length === 0 ? this.getConfirmedIndex() : undefined;
    const { next, changes } = execute(this.view, name, args, baseIdx);
    let reads = opReads(this.view, this.viewVersions, args, changes, name);
    if (basis) reads = reads.map(([id, v]) => [id, Object.hasOwn(basis, id) ? basis[id]! : v]);
    const rawOp: Op = { client: this.id, n: this.nextN, name, args, reads };
    const frame = JSON.stringify({ t: 'op', op: rawOp } satisfies ToServer);
    if (exceedsUtf8Bytes(frame, this.maxMessageBytes))
      throw new SyncMessageTooLargeError(utf8Bytes(frame), this.maxMessageBytes);
    // 序号只在确定要发出时才占用：服务端要求每个客户端的 n 严格连续
    this.nextN++;
    const op: PendingOp = { ...rawOp, stale: false };
    this.pending.push(op);
    this.view = next;
    const nextVv = this.viewVersions === this.versions ? { ...this.versions } : this.viewVersions;
    for (const c of changes) {
      if (c.obj) nextVv[c.id] = `p:${op.client}:${op.n}` as Ver;
      else delete nextVv[c.id];
    }
    this.viewVersions = nextVv;
    for (const fn of this.listeners) fn();
    if (this.online && this.ready) this.send({ t: 'op', op: rawOp });
    return op.n;
  }

  /** 当前看到的这些对象的版本（打开编辑框时调用，保存时作为 basis 传入） */
  basisOf(ids: string[]): Versions {
    const out: Versions = {};
    for (const id of ids) if (Object.hasOwn(this.view.objects, id)) out[id] = verOf(this.viewVersions, id);
    return out;
  }

  receive(m: ToClient) {
    if (m.t === 'welcome') {
      for (const r of m.rejected)
        if (this.pending.some((p) => p.n === r.n)) this.notices.push({ n: r.n, message: r.message });
      const rejected = new Set(m.rejected.map((r) => r.n));
      this.pending = this.pending.filter((p) => p.n > m.lastProcessed || !rejected.has(p.n));
      for (const p of this.pending) if (p.n > m.lastProcessed) this.send({ t: 'op', op: stripLocal(p) });
      this.ready = true;
    } else if (m.t === 'snapshot') {
      this.confirmed = m.model;
      this.versions = m.versions;
      this.seq = m.seq;
      this.confirmedIndex = null;
      for (const k of this.early.keys()) if (k <= m.seq) this.early.delete(k);
      this.pending = this.pending.filter((p) => p.n > m.lastProcessed);
    } else if (m.t === 'commit') {
      if (m.seq <= this.seq) return;
      this.early.set(m.seq, m);
      for (let c = this.early.get(this.seq + 1); c; c = this.early.get(this.seq + 1)) {
        this.early.delete(c.seq);
        if (this.confirmed === this.view) {
          this.confirmed = { ...this.confirmed, objects: { ...this.confirmed.objects } };
          this.confirmedIndex?.setModel(this.confirmed);
        }
        const batch = this.confirmedIndex
          ? c.changes.map((ch) => ({
              id: ch.id,
              prev: this.confirmed.objects[ch.id],
              next: ch.obj ?? undefined,
            }))
          : null;
        applyChanges(this.confirmed, this.versions, c.changes, c.seq);
        if (batch) {
          for (let i = 0; i < batch.length; i++) {
            const ch = c.changes[i]!;
            batch[i]!.next = ch.obj ? this.confirmed.objects[ch.id] : undefined;
          }
          this.confirmedIndex!.applyBatch(this.confirmed, batch);
        }
        this.seq = c.seq;
        if (c.client === this.id) this.pending = this.pending.filter((p) => p.n !== c.n);
      }
    } else {
      if (this.pending.some((p) => p.n === m.n)) this.notices.push({ n: m.n, message: m.message });
      this.pending = this.pending.filter((p) => p.n !== m.n);
    }
    this.rebuild();
  }

  private rebuild() {
    if (!this.pending.length) {
      this.view = this.confirmed;
      this.viewVersions = this.versions;
    } else {
      let view = this.confirmed;
      const vv: Versions = { ...this.versions };
      for (const op of this.pending) {
        try {
          const baseIdx = view === this.confirmed ? this.getConfirmedIndex() : undefined;
          const { next, changes } = execute(view, op.name, op.args, baseIdx);
          view = next;
          for (const c of changes) {
            if (c.obj) vv[c.id] = `p:${op.client}:${op.n}` as Ver;
            else delete vv[c.id];
          }
          op.stale = false;
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          op.stale = true;
        }
      }
      this.view = view;
      this.viewVersions = vv;
    }
    for (const fn of this.listeners) fn();
  }

  /**
   * 丢弃全部待确认修改，界面回到已确认状态；返回丢弃的条数。
   * 服务端以 1009（消息过大）断开时调用：否则重连收到 welcome 后会重发同一批修改，再次被断开。
   */
  dropPending(): number {
    const dropped = this.pending.length;
    this.pending = [];
    this.rebuild();
    return dropped;
  }

  connect() {
    this.online = true;
    this.ready = false;
    this.send({ t: 'hello', client: this.id, lastSeq: this.seq });
  }
  disconnect() {
    this.online = false;
    this.ready = false;
  }
}

const stripLocal = (p: PendingOp): Op => ({
  client: p.client,
  n: p.n,
  name: p.name,
  args: p.args,
  reads: p.reads,
});
