// 跨副本事件总线（P7 HA1，ADR 0011）：基于平台 PostgreSQL 的 LISTEN/NOTIFY。
// 所有消息均为轻量小负载（远小于 PG NOTIFY 8 KB 上限），业务数据从平台库按需读取；
// 单机 SQLite 模式下走进程内回调，保持上层接口一致。
import { randomUUID } from 'node:crypto';
import type { PlatformDb } from './db.ts';

export const CLUSTER_EVENTS_CHANNEL = 'dowel_events';

/** 留出协议余量，避免触发 PG NOTIFY 8000 字节硬上限 */
const MAX_EVENT_BYTES = 7500;

export type ClusterEvent =
  | { t: 'room.commit'; origin: string; branchId: string; seq: number }
  | {
      t: 'room.layout';
      origin: string;
      branchId: string;
      positions: Record<string, { x: number; y: number }>;
    }
  | { t: 'room.presence'; origin: string; branchId: string; client: string; user: string; data: unknown }
  | { t: 'room.kick'; origin: string; userId: string; reason: string }
  | { t: 'room.refresh'; origin: string; branchIds?: string[] }
  | { t: 'inbox.changed'; origin: string; userIds: string[] }
  | { t: 'webhooks.wake'; origin: string }
  | { t: 'ci_tokens.changed'; origin: string }
  | {
      t: 'requests.kick';
      origin: string;
      all?: boolean;
      envIds?: string[];
      projectIds?: string[];
      groupIds?: string[];
    };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 发布事件时的入参（origin 由 EventBus 自动附带当前副本 ID） */
export type ClusterEventPayload = DistributiveOmit<ClusterEvent, 'origin'>;

export type ClusterEventHandler = (event: ClusterEvent) => void | Promise<void>;
export type ReconnectHandler = () => void | Promise<void>;

export interface EventBusOptions {
  /** 当前副本唯一标识；默认生成随机 UUID */
  replicaId?: string;
  /** PG NOTIFY/LISTEN 通道名；默认 dowel_events */
  channel?: string;
  /** 是否向本副本的订阅者回环自己发布的事件（默认 true，由调用方决定是否忽略 event.origin === replicaId） */
  localLoopback?: boolean;
}

const isClusterEvent = (v: unknown): v is ClusterEvent => {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.t === 'string' && typeof e.origin === 'string';
};

export class EventBus {
  readonly replicaId: string;
  readonly channel: string;
  private readonly db: PlatformDb;
  private readonly localLoopback: boolean;
  private readonly eventHandlers = new Set<ClusterEventHandler>();
  private readonly reconnectHandlers = new Set<ReconnectHandler>();
  private unlisten: (() => Promise<void>) | null = null;
  private starting: Promise<void> | null = null;
  private started = false;

  constructor(db: PlatformDb, options: EventBusOptions = {}) {
    this.db = db;
    this.replicaId = options.replicaId ?? randomUUID();
    this.channel = options.channel ?? CLUSTER_EVENTS_CHANNEL;
    this.localLoopback = options.localLoopback ?? true;
  }

  /** 注册事件处理器，返回取消订阅函数 */
  onEvent(handler: ClusterEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** 注册断线重连处理器（PG LISTEN 重建后触发各模块做增量追赶），返回取消订阅函数 */
  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  /** 启动监听（幂等） */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (this.db.dialect === 'pg') {
        this.unlisten = await this.db.listen(
          this.channel,
          (raw) => this.handleRaw(raw),
          () => this.handleReconnect(),
        );
      }
      this.started = true;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /** 停止监听并释放 PG 订阅连接（幂等） */
  async close(): Promise<void> {
    if (this.starting) {
      await this.starting.catch(() => {});
    }
    this.started = false;
    const stop = this.unlisten;
    this.unlisten = null;
    if (stop) await stop();
  }

  /** 向集群广播事件 */
  async publish(event: ClusterEventPayload): Promise<void> {
    let full = { ...event, origin: this.replicaId } as ClusterEvent;
    if (this.db.dialect === 'pg') {
      let json = JSON.stringify(full);
      if (Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) {
        // 避免发出被截断的非法 JSON：能退化为全量刷新信号的退化，否则告警丢弃
        if (full.t === 'room.refresh') {
          full = { t: 'room.refresh', origin: this.replicaId };
          json = JSON.stringify(full);
        } else if (full.t === 'requests.kick') {
          full = { t: 'requests.kick', origin: this.replicaId, all: true };
          json = JSON.stringify(full);
        } else {
          console.warn(
            `跳过超长集群事件（t=${full.t}, bytes=${Buffer.byteLength(json, 'utf8')} > ${MAX_EVENT_BYTES}）`,
          );
          return;
        }
      }
      await this.db.notify(this.channel, json);
      return;
    }
    if (this.started && this.localLoopback) {
      this.dispatch(full);
    }
  }

  private handleRaw(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('忽略无法解析的集群事件负载', e);
      return;
    }
    if (!isClusterEvent(parsed)) {
      console.warn('忽略格式不合法的集群事件');
      return;
    }
    if (!this.localLoopback && parsed.origin === this.replicaId) return;
    this.dispatch(parsed);
  }

  private dispatch(event: ClusterEvent): void {
    for (const handler of [...this.eventHandlers]) {
      try {
        const res = handler(event);
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch((e) => {
            console.error(`集群事件处理失败（t=${event.t}）`, e);
          });
        }
      } catch (e) {
        console.error(`集群事件处理失败（t=${event.t}）`, e);
      }
    }
  }

  private handleReconnect(): void {
    for (const handler of [...this.reconnectHandlers]) {
      try {
        const res = handler();
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch((e) => {
            console.error('集群事件总线重连回调失败', e);
          });
        }
      } catch (e) {
        console.error('集群事件总线重连回调失败', e);
      }
    }
  }
}
