// 房间各子模块共享的类型、常量与错误：每个分支一个 Loaded 记录（扁平结构，由各子模块按字段归属读写）。

import type { CanvasSection, Role } from '@dowel/api';
import type { Model } from '@dowel/core';
import type { Room, ToClient } from '@dowel/sync';

import type { User } from '../auth.ts';
import type { RoomPeerInfo } from '../bus.ts';
import type { RoleLookup } from '../roles.ts';

export type { Role } from '@dowel/api';

export const SNAPSHOT_EVERY = 200;

/**
 * 客户端 presence 数据序列化后的上限（UTF-8 字节，Issue #150）。presence 会原样转发给房间里每个连接、
 * 并经 PG NOTIFY（单条 7500 字节）广播到其他副本；超限的直接丢弃，本副本与跨副本行为一致
 */
export const MAX_PRESENCE_BYTES = 4096;

export interface RoomsOptions {
  /** 空闲房间超时卸载时间（毫秒）；默认 5 分钟，传入 0 或 Infinity 禁用 */
  idleEvictMs?: number;
  /** 画布布局防抖落盘延迟（毫秒）；默认 500ms */
  layoutDebounceMs?: number;
  /** 画布布局防抖落盘失败后的最大重试次数；默认 3 次 */
  layoutMaxRetries?: number;
  /** 画布布局防抖落盘失败后的初始指数退避间隔（毫秒）；默认 500ms */
  layoutRetryBaseMs?: number;
}

export type RefreshTarget = 'all' | Set<string>;

/** 画布布局：表 ID → 位置。同一张表后到的覆盖先到的，不检查冲突（拖动不应被拒绝） */
export type Layout = Record<string, { x: number; y: number }>;

/** 服务器发给客户端的、同步协议之外的消息 */
export type Extra =
  | { t: 'layout'; positions: Layout }
  | { t: 'sections'; sections: CanvasSection[] }
  | { t: 'presence'; client: string; user: string; data: unknown }
  | { t: 'peers'; peers: { client: string; user: string }[] }
  // 生效角色变了（授权、组成员、默认权限变动后）：客户端据此切换只读 / 可编辑
  | { t: 'role'; role: Role };
/** 客户端发给服务器的、同步协议之外的消息 */
export type ExtraIn =
  | { t: 'layout'; positions: Layout }
  | { t: 'sections'; sections: CanvasSection[] }
  | { t: 'presence'; data: unknown };

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

export interface LayoutVersion {
  ver: number;
  origin: string;
}

export interface Loaded {
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
  /** 房间级布局 DB 读写串行链（互斥协调 flushLayout 与 reloadLayoutFromDb，避免重载查库期间穿插旧刷盘） */
  layoutIo: Promise<void>;
  /** 当前排队及在途的布局 DB IO 计数（用于空闲卸载保护、flush 排空与重连排空） */
  layoutIoCount: number;
  /** 连续防抖落盘失败的重试次数（收到新本地布局或落盘成功后清零） */
  layoutRetries: number;
  /** 画布板块定义（纯布局层，绝不进入 IR） */
  sections: CanvasSection[];
  /** 是否有尚未落库的本地板块改动 */
  sectionsPending: boolean;
  /** 板块逻辑时钟（Lamport clock），配合 origin 做确定性 LWW 裁决 */
  sectionsClock: number;
  /** 最近一次生效的板块版本 */
  sectionsVersion: LayoutVersion | null;
  sectionsTimer?: ReturnType<typeof setTimeout>;
  /** 房间级板块 DB 读写串行链（互斥协调 flushSections 与 reloadSectionsFromDb，避免重载查库期间穿插旧刷盘） */
  sectionsIo: Promise<void>;
  /** 当前排队及在途的板块 DB IO 计数（用于空闲卸载保护、flush 排空与重连排空） */
  sectionsIoCount: number;
  /** 连续防抖落盘失败的重试次数 */
  sectionsRetries: number;
  /** 本机单调递增的板块写代次，避免异步落库/重载期间覆盖更新的本地编辑 */
  sectionsWriteSeq: number;
  /** 空闲卸载定时器（仅在无在线成员、无在途操作且无待落盘布局/板块时存在） */
  idleTimer?: ReturnType<typeof setTimeout>;
  /** 当前在途/等待房间锁的活跃操作计数（避免等待锁期间被空闲卸载误删） */
  activeOps: number;
  /** 是否已被卸载或随分支删除移除（防止滞后回调误操作旧条目） */
  evicted: boolean;
  /** 指向 this.rooms 中登记的当前 Promise 条目，用于同步核验归属 */
  entry?: Promise<Loaded>;
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
