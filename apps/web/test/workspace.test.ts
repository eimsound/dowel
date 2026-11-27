// Workspace 单条消息上限与 1009 断线恢复行为测试（Issue #150）：
// 1. 本地自查超限时直接拒绝且保持模型与待确认队列不变，中英文提示使用 MiB；
// 2. 服务端以 1009 断开时丢弃未确认队列、轮换客户端标识并重置序号，重连拿到快照刷新画布后再提示；
// 3. pending 为 0 时走不带“0 处”的无计数文案。
import { createSchema, emptyModel } from '@dowel/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import i18n from '../src/i18n.ts';
import { Workspace } from '../src/workspace.ts';

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readonly url: string;
  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = '') {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  emitClose(code: number, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const seedBaseModel = () => {
  const m = emptyModel('pg');
  const schemaId = createSchema(m, 'public');
  return { m, schemaId };
};

describe('Workspace 单条消息大小上限与 1009 处理', () => {
  beforeEach(async () => {
    MockWebSocket.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    await i18n.changeLanguage('zh');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await i18n.changeLanguage('zh');
  });

  const startOnline = (ws: Workspace) => {
    const { m, schemaId } = seedBaseModel();
    ws.start();
    const sock = MockWebSocket.instances.at(-1)!;
    sock.emitOpen();
    sock.emitMessage({ t: 'welcome', lastProcessed: 0, rejected: [] });
    sock.emitMessage({ t: 'snapshot', seq: 1, model: m, versions: { [schemaId]: 1 }, lastProcessed: 0 });
    sock.sent.length = 0;
    return { sock, baseModel: m, schemaId };
  };

  test('ws.act 本地超限：返回 false，不发送且不修改本地画布与 pending，中英文文案带 MiB', async () => {
    const ws = new Workspace('p1', { maxMessageBytes: 1024 * 1024 });
    const notices: { message: string; kind: 'error' | 'info' }[] = [];
    ws.setOnNotice((message, kind) => notices.push({ message, kind }));
    const { sock, baseModel, schemaId } = startOnline(ws);

    const ops = [
      { name: 'createTable', args: { id: 't1', schema: schemaId, name: 't1' } },
      { name: 'setComment', args: { id: 't1', comment: 'a'.repeat(600_000) } },
      { name: 'createTable', args: { id: 't2', schema: schemaId, name: 't2' } },
      { name: 'setComment', args: { id: 't2', comment: 'a'.repeat(600_000) } },
    ];
    expect(ws.act('paste', { ops })).toBe(false);
    expect(sock.sent).toEqual([]);
    expect(ws.getSnapshot().pending).toBe(0);
    expect(ws.getSnapshot().model).toEqual(baseModel);
    expect(notices).toEqual([
      {
        kind: 'error',
        message:
          '这次修改的数据量太大（约 1.1 MiB，上限 1 MiB），没有保存。请减少一次操作的内容，例如分几次粘贴，每次少选一些表。',
      },
    ]);

    await i18n.changeLanguage('en');
    notices.length = 0;
    expect(ws.act('paste', { ops })).toBe(false);
    expect(notices).toEqual([
      {
        kind: 'error',
        message:
          'This change is too large to save (about 1.1 MiB; the limit is 1 MiB). Nothing was changed. Try smaller steps, for example paste fewer tables at a time.',
      },
    ]);
    ws.stop();
  });

  test('收到 1009 且有未确认修改：立即回滚并轮换 client.id，重连拿到快照刷新后再按中英文提示，之后可正常提交', async () => {
    for (const lng of ['zh', 'en'] as const) {
      await i18n.changeLanguage(lng);
      MockWebSocket.instances = [];
      const ws = new Workspace('p1');
      const notices: { message: string; kind: 'error' | 'info' }[] = [];
      ws.setOnNotice((message, kind) => notices.push({ message, kind }));
      const { sock: sock1, baseModel, schemaId } = startOnline(ws);
      const oldId = ws.client.id;

      // 制造两条未确认修改（假设第 1 条其实已在服务端落库，第 2 条触发 1009）
      expect(ws.act('createTable', { id: 't1', schema: schemaId, name: 'orders' })).toBe(true);
      expect(ws.act('setComment', { id: 't1', comment: 'oversize' })).toBe(true);
      expect(ws.getSnapshot().pending).toBe(2);
      expect(ws.getSnapshot().model.objects.t1).toBeDefined();

      sock1.emitClose(1009, 'Message too big');

      // 断开当下立即回滚本地待确认态、轮换客户端 ID，但尚未收到服务端快照前不提前提示“已刷新”
      expect(ws.client.id).not.toBe(oldId);
      expect(ws.getSnapshot().pending).toBe(0);
      expect(ws.getSnapshot().model.objects.t1).toBeUndefined();
      expect(notices).toEqual([]);

      await vi.advanceTimersByTimeAsync(500);
      expect(MockWebSocket.instances).toHaveLength(2);
      const sock2 = MockWebSocket.instances[1]!;
      sock2.emitOpen();
      expect(JSON.parse(sock2.sent[0]!)).toEqual({
        t: 'hello',
        client: ws.client.id,
        lastSeq: 0,
      });

      // 服务端发来 welcome 与包含已提交 t1 的最新快照
      const serverModel = structuredClone(baseModel);
      serverModel.objects.t1 = {
        id: 't1',
        kind: 'table',
        parent: schemaId,
        name: 'orders',
        partitionBy: null,
        partitionOf: null,
        comment: null,
      };
      sock2.emitMessage({ t: 'welcome', lastProcessed: 0, rejected: [] });
      expect(notices).toEqual([]);
      sock2.emitMessage({
        t: 'snapshot',
        seq: 2,
        model: serverModel,
        versions: { [schemaId]: 1, t1: 2 },
        lastProcessed: 0,
      });

      expect(ws.getSnapshot().seq).toBe(2);
      expect(ws.getSnapshot().model).toEqual(serverModel);
      expect(notices).toEqual([
        {
          kind: 'error',
          message:
            lng === 'zh'
              ? '有一条修改超过了服务器的大小上限，已重新连接。尚未确认的 2 处修改可能没有保存，画布已按服务器上的内容刷新，请检查后重做。'
              : "A change exceeded the server's size limit, so the connection was reset. 2 unconfirmed changes may not have been saved; the canvas now shows what the server has. Please check and redo them if needed.",
        },
      ]);

      // 重连后下一次小修改必须用新 client.id 且从 n=1 开始
      sock2.sent.length = 0;
      expect(ws.act('createTable', { id: 't2', schema: schemaId, name: 'items' })).toBe(true);
      expect(JSON.parse(sock2.sent[0]!)).toMatchObject({
        t: 'op',
        op: { client: ws.client.id, n: 1, name: 'createTable' },
      });
      ws.stop();
    }
  });

  test('收到 1009 且待确认修改为 0 条：使用不带数字的无计数提示文案', async () => {
    for (const lng of ['zh', 'en'] as const) {
      await i18n.changeLanguage(lng);
      MockWebSocket.instances = [];
      const ws = new Workspace('p1');
      const notices: { message: string; kind: 'error' | 'info' }[] = [];
      ws.setOnNotice((message, kind) => notices.push({ message, kind }));
      const { sock: sock1, baseModel, schemaId } = startOnline(ws);

      expect(ws.getSnapshot().pending).toBe(0);
      sock1.emitClose(1009, 'Message too big');

      await vi.advanceTimersByTimeAsync(500);
      const sock2 = MockWebSocket.instances[1]!;
      sock2.emitOpen();
      sock2.emitMessage({ t: 'welcome', lastProcessed: 0, rejected: [] });
      sock2.emitMessage({
        t: 'snapshot',
        seq: 1,
        model: baseModel,
        versions: { [schemaId]: 1 },
        lastProcessed: 0,
      });

      expect(notices).toEqual([
        {
          kind: 'error',
          message:
            lng === 'zh'
              ? '有一条消息超过了服务器的大小上限，已重新连接。画布已按服务器上的内容刷新，如有遗漏请重做。'
              : "A message exceeded the server's size limit, so the connection was reset. The canvas now shows what the server has. Please check and redo any missing changes.",
        },
      ]);
      expect(notices[0]!.message).not.toMatch(/\b0\b/);
      ws.stop();
    }
  });
});
