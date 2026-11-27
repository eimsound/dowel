// 工作区状态：WebSocket 连接同步房间（断线自动重连），SyncClient 维护模型，另外管理画布布局、板块和在线成员。
import { type CanvasSection, type Role, sanitizeSections } from '@dowel/api';
import { EditError, emptyModel, type Model, newId } from '@dowel/core';
import { SyncClient, SyncMessageTooLargeError, type ToClient, type Versions } from '@dowel/sync';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import i18n from './i18n.ts';

const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

export type Layout = Record<string, { x: number; y: number }>;
export type Status = 'connecting' | 'online' | 'offline';

export interface Snapshot {
  model: Model;
  status: Status;
  pending: number;
  seq: number;
  layout: Layout;
  sections: CanvasSection[];
  peers: { client: string; user: string }[];
  /** 服务端推来的生效角色（授权、组成员变动后即时生效）；还没收到时为 null */
  role: Role | null;
}

export class Workspace {
  readonly pid: string;
  readonly client: SyncClient;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private listeners = new Set<() => void>();
  private snap: Snapshot;
  private seenNotices = 0;
  /** 冲突、校验失败等需要告诉用户的消息 */
  onNotice: (message: string, kind: 'error' | 'info') => void = () => {};

  constructor(pid: string) {
    this.pid = pid;
    // 每个浏览器标签页是一个独立的客户端
    this.client = new SyncClient(`tab-${newId()}`, emptyModel());
    this.client.send = (m) => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    };
    this.client.subscribe(() => this.update({}));
    this.snap = {
      model: this.client.view,
      status: 'connecting',
      pending: 0,
      seq: 0,
      layout: {},
      sections: [],
      peers: [],
      role: null,
    };
  }

  private update(patch: Partial<Snapshot>) {
    const c = this.client;
    this.snap = { ...this.snap, ...patch, model: c.view, pending: c.pending.length, seq: c.seq };
    for (const n of c.notices.slice(this.seenNotices)) this.onNotice(n.message, 'error');
    this.seenNotices = c.notices.length;
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  start() {
    this.stopped = false;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/projects/${this.pid}/sync`;
    const ws = new WebSocket(url);
    this.ws = ws;
    // 每次连接（含重连）都以服务端 join 成功后发来的 role 为准：先清空，避免拿旧角色判断
    this.update({ status: 'connecting', role: null });
    // 只处理当前连接的事件：旧连接（例如 StrictMode 重新挂载前的那个）晚到的事件一律忽略
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.update({ status: 'online' });
      this.client.connect();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const m = JSON.parse(String(e.data)) as ToClient | { t: string; [k: string]: unknown };
      switch (m.t) {
        case 'welcome':
        case 'snapshot':
        case 'commit':
        case 'reject':
          this.client.receive(m as ToClient);
          break;
        case 'layout':
          this.update({ layout: { ...this.snap.layout, ...(m.positions as Layout) } });
          break;
        case 'sections':
          this.update({ sections: sanitizeSections(m.sections) });
          break;
        case 'peers':
          this.update({ peers: m.peers as Snapshot['peers'] });
          break;
        case 'role':
          this.update({ role: m.role as Role });
          break;
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.client.disconnect();
      if (this.stopped) return;
      // 4401：没有权限；4403：账号被停用或项目权限被收回。都不再重连，避免刷屏
      if (e.code === 4401 || e.code === 4403) {
        this.update({ status: 'offline' });
        this.onNotice(e.reason || '没有权限', 'error');
        return;
      }
      // 1009：发出的消息超过服务端单条上限。正常情况下发送前就会在本地拦下（SyncClient.mutate），
      // 走到这里说明两边上限不一致：丢掉待确认修改再重连，否则重连后会重发同一批消息被反复断开
      if (e.code === 1009) {
        const dropped = this.client.dropPending();
        this.onNotice(i18n.t('ws.messageTooLarge', { count: dropped }), 'error');
      }
      this.update({ status: 'offline' });
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.stopped && this.start(), delay);
    };
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }

  /** 发起修改；本地就不合法时提示原因并返回 false */
  act(name: string, args: unknown, basis?: Versions): boolean {
    try {
      this.client.mutate(name, args, basis);
      return true;
    } catch (e) {
      if (e instanceof SyncMessageTooLargeError) {
        this.onNotice(
          i18n.t('ws.opTooLarge', { size: mb(e.bytes), max: Math.round(e.max / 1048576) }),
          'error',
        );
        return false;
      }
      if (e instanceof EditError) {
        this.onNotice(e.message, 'error');
        return false;
      }
      throw e;
    }
  }

  /** 移动画布上的表（不检查冲突，后到的覆盖先到的） */
  move(positions: Layout) {
    this.update({ layout: { ...this.snap.layout, ...positions } });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'layout', positions }));
  }

  /** 更新画布板块定义（纯布局层：名称、颜色、成员表），先本地清洗并乐观更新再通过 WS 同步 */
  setSections(sections: CanvasSection[]) {
    const clean = sanitizeSections(sections);
    this.update({ sections: clean });
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'sections', sections: clean }));
    }
  }

  setOnNotice(fn: Workspace['onNotice']) {
    this.onNotice = fn;
  }
}

export const useWorkspace = (pid: string, onNotice: Workspace['onNotice']) => {
  const [ws] = useState(() => new Workspace(pid));
  useLayoutEffect(() => {
    ws.setOnNotice(onNotice);
  }, [ws, onNotice]);
  useEffect(() => {
    ws.start();
    return () => ws.stop();
  }, [ws]);
  const snap = useSyncExternalStore(ws.subscribe, ws.getSnapshot);
  return { ws, ...snap };
};
