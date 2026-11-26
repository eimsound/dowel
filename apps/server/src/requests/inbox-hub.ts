// 收件箱实时推送的本副本订阅中心（SSE）：内存维护本节点的订阅回调与停机时要唤醒的流，
// 跨副本变更经 EventBus 的 inbox.changed 广播并在各副本本地扇出（订阅总线在 service.ts 的 attachBus）。
//
// 停机（#26）：stopped 状态由 Requests 持有（isStopped），停机后 subscribe 立即回调 onClose；
// Requests.stop() 调 closeAll() 主动唤醒并结束所有活跃流。
import type { InboxEvent } from '@dowel/api';

import type { EventBus } from '../bus.ts';
import { scrubSecrets } from '../secrets.ts';

/** 收件箱实时推送的本副本订阅回调（内存维护本节点 SSE 连接；跨副本变更经 EventBus 的 inbox.changed 广播并在各副本本地扇出） */
export type Listener = (e: InboxEvent) => void;

const INBOX_CHANGED_BATCH = 100;

export class InboxHub {
  private readonly bus: EventBus | null;
  private readonly isStopped: () => boolean;
  /** 读这个用户的未读数：经 Requests 实例的 unread() 读（保持实例方法分派） */
  private readonly readUnread: (userId: string) => Promise<number>;
  private listeners = new Map<string, Set<Listener>>();
  private stopListeners = new Set<() => void>();

  constructor(
    bus: EventBus | null,
    isStopped: () => boolean,
    readUnread: (userId: string) => Promise<number>,
  ) {
    this.bus = bus;
    this.isStopped = isStopped;
    this.readUnread = readUnread;
  }

  subscribe(userId: string, fn: Listener, onClose?: () => void): () => void {
    if (this.isStopped()) {
      onClose?.();
      return () => {};
    }
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    this.listeners.set(userId, set);
    set.add(fn);
    if (onClose) this.stopListeners.add(onClose);
    return () => {
      set.delete(fn);
      if (!set.size && this.listeners.get(userId) === set) this.listeners.delete(userId);
      if (onClose) this.stopListeners.delete(onClose);
    };
  }

  /** 本副本上这个用户有没有活跃的实时连接 */
  has(userId: string): boolean {
    return this.listeners.has(userId);
  }

  /** 本副本上有活跃实时连接的用户 */
  activeUsers(): string[] {
    return [...this.listeners.keys()];
  }

  /** 停机：清空订阅并唤醒所有活跃流（各流的 onClose），回调抛错不影响其他流 */
  closeAll(): void {
    const closers = [...this.stopListeners];
    this.stopListeners.clear();
    this.listeners.clear();
    for (const close of closers) {
      try {
        close();
      } catch {}
    }
  }

  /** 仅推送未读数给本副本上这个用户的实时连接；调用方已经算好的值直接用，不再查 */
  async publishUnreadLocal(userId: string, known?: number) {
    const set = this.listeners.get(userId);
    if (!set?.size) return;
    const unread = known ?? (await this.readUnread(userId).catch(() => null));
    if (unread === null) return;
    for (const fn of set) fn({ unread });
  }

  /** 向其他副本广播收件箱变更（分批防止超过 PG NOTIFY 8 KB 上限；空数组表示“申请列表有变化”） */
  async publishInboxChanged(userIds: string[]) {
    if (!this.bus) return;
    if (!userIds.length) {
      await this.bus.publish({ t: 'inbox.changed', userIds: [] }).catch((e) => {
        console.error('广播收件箱变更失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
      return;
    }
    for (let i = 0; i < userIds.length; i += INBOX_CHANGED_BATCH) {
      const chunk = userIds.slice(i, i + INBOX_CHANGED_BATCH);
      await this.bus.publish({ t: 'inbox.changed', userIds: chunk }).catch((e) => {
        console.error('广播收件箱变更失败', e instanceof Error ? scrubSecrets(e.message) : e);
      });
    }
  }

  /** 仅向本副本活跃 SSE 订阅者广播一个不带内容的“申请有变化” */
  broadcastLocal(e: InboxEvent) {
    for (const set of this.listeners.values()) for (const fn of set) fn(e);
  }
}
