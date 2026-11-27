// 单条入站消息上限（Issue #150）：HTTP 请求体、协作 WebSocket 单条消息、presence 数据。
// 用注入的小上限验证行为（超限在解析与认证之前被拒、恰好等于上限放行），默认值另行断言。
import type { AddressInfo } from 'node:net';

import { emptyModel } from '@dowel/core';
import { MAX_SYNC_MESSAGE_BYTES, SyncClient, type ToClient, type ToServer } from '@dowel/sync';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { DEFAULT_MESSAGE_LIMITS, MAX_HTTP_BODY_BYTES } from '../src/limits.ts';
import { MAX_PRESENCE_BYTES, type Rooms } from '../src/rooms.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

const HTTP_LIMIT = 4096;
const WS_LIMIT = 16 * 1024;

let db: PlatformDb;
let rooms: Rooms;
let base = '';
let closeServer: () => Promise<void>;
const sockets = new Set<WebSocket>();

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, {
    security: { trustProxy: false, publicUrl: null },
    limits: { httpBodyBytes: HTTP_LIMIT, wsMessageBytes: WS_LIMIT },
  });
  rooms = created.rooms;
  const server = serve({ fetch: created.app.fetch, port: 0 });
  created.injectWebSocket(server);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = async () => {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    await created.rooms.flush();
    await created.shadows.close();
    (server as import('node:http').Server).closeAllConnections();
    await new Promise((r) => server.close(r));
    await db.close();
  };
});

afterAll(async () => {
  await closeServer();
});

const post = async (
  path: string,
  body: string | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { status: res.status, data, headers: res.headers };
};

/** 恰好 bytes 个 UTF-8 字节的合法 JSON 登录请求体（用中文填充，验证按字节而不是按字符计） */
const loginBodyOfBytes = (bytes: number) => {
  const head = JSON.stringify({ username: 'nobody', password: 'x', pad: '' });
  const room = bytes - Buffer.byteLength(head);
  const pad = '中'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
  const body = JSON.stringify({ username: 'nobody', password: 'x', pad });
  expect(Buffer.byteLength(body)).toBe(bytes);
  return body;
};

const streamOf = (text: string, chunk = 1000) => {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(i, i + chunk));
      i += chunk;
    },
  });
};

describe('HTTP 请求体上限', () => {
  test('默认上限：HTTP 16 MiB，WebSocket 与前端自查共用 MAX_SYNC_MESSAGE_BYTES（16 MiB）', async () => {
    expect(MAX_HTTP_BODY_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_MESSAGE_LIMITS).toEqual({
      httpBodyBytes: MAX_HTTP_BODY_BYTES,
      wsMessageBytes: MAX_SYNC_MESSAGE_BYTES,
    });
    const other = await openPlatformDb(':memory:');
    const created = createApp(other);
    expect(created.wss.options.maxPayload).toBe(MAX_SYNC_MESSAGE_BYTES);
    expect(created.wss.options.perMessageDeflate).toBe(false);
    created.rooms.close();
    await created.shadows.close();
    await other.close();
  });

  test('超限（Content-Length）：未登录、非法 JSON 也是 413 payload_too_large——在认证与解析之前', async () => {
    const r = await post('/api/auth/login', '{' + 'x'.repeat(HTTP_LIMIT));
    expect(r.status).toBe(413);
    expect(r.data).toEqual({ error: '请求体太大：超过 4 KiB 上限', code: 'payload_too_large' });
    // 需要登录的接口同样先于 requireUser 拒绝（否则会是 401）
    const r2 = await post('/api/projects/whatever/import', 'x'.repeat(HTTP_LIMIT + 1));
    expect(r2.status).toBe(413);
    expect(r2.data.code).toBe('payload_too_large');
    // 安全响应头照常带上
    expect(r2.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('恰好等于上限（按 UTF-8 字节，含中文）放行到业务处理', async () => {
    const r = await post('/api/auth/login', loginBodyOfBytes(HTTP_LIMIT));
    expect(r.status).toBe(401);
    const over = await post('/api/auth/login', loginBodyOfBytes(HTTP_LIMIT + 1));
    expect(over.status).toBe(413);
  });

  test('分块传输（没有 Content-Length）边读边计数：超限 413，未超限照常处理', async () => {
    const over = await post('/api/auth/login', streamOf(loginBodyOfBytes(HTTP_LIMIT + 1)));
    expect(over.status).toBe(413);
    expect(over.data.code).toBe('payload_too_large');
    const ok = await post('/api/auth/login', streamOf(loginBodyOfBytes(HTTP_LIMIT)));
    expect(ok.status).toBe(401);
  });

  test('CI 接口返回 CI 错误体形状（ok: false, code: payload_too_large）', async () => {
    const r = await post('/api/ci/projects/p/environments/e/execute', 'x'.repeat(HTTP_LIMIT + 1));
    expect(r.status).toBe(413);
    expect(r.data).toMatchObject({ ok: false, code: 'payload_too_large' });
  });

  test('MCP 不走通用上限（它有自己的 1 MiB 上限与 JSON-RPC 错误体）', async () => {
    const r = await post('/api/mcp', 'x'.repeat(HTTP_LIMIT * 4));
    // 超过通用上限但没超过 MCP 上限：照常走到 MCP 认证
    expect(r.status).toBe(401);
    expect(r.data.code).toBe('token_missing');
  });
});

describe('协作 WebSocket 单条消息上限', () => {
  let cookie = '';
  let pid = '';
  let branch = '';

  beforeAll(async () => {
    await makeUser(db, 'limits', { name: 'Limits' });
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'limits', password: PASSWORD }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const api = async (path: string, json: unknown) =>
      (await (
        await fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify(json),
        })
      ).json()) as Record<string, string>;
    const g = await api('/api/groups', { slug: 'limits', name: 'Limits' });
    pid = (await api('/api/projects', { name: 'limits', groupId: g.id })).id!;
    // 工作副本做大一点：服务端发出的快照远超入站上限，用来验证上限只管入站
    for (let i = 0; i < 40; i++) await addTable(rooms, db, pid, `t_${i}`);
    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    branch = b!.id;
  });

  const connect = async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pid}/sync`, {
      headers: { cookie, origin: base },
    });
    sockets.add(ws);
    const received: { t: string; [k: string]: unknown }[] = [];
    const waiters: {
      pred: (m: { t: string; [k: string]: unknown }) => boolean;
      resolve: (m: { t: string; [k: string]: unknown }) => void;
      reject: (err: Error) => void;
    }[] = [];
    let closedCode: number | null = null;
    let rawMax = 0;
    ws.on('message', (data) => {
      const text = (data as Buffer).toString('utf8');
      rawMax = Math.max(rawMax, Buffer.byteLength(text));
      const parsed = JSON.parse(text) as { t: string; [k: string]: unknown };
      received.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(parsed)) {
          const [w] = waiters.splice(i, 1);
          w!.resolve(parsed);
        }
      }
    });
    const closed = new Promise<number>((r) =>
      ws.once('close', (code) => {
        closedCode = code;
        for (const w of waiters.splice(0)) {
          w.reject(new Error(`连接在收到期望消息前关闭：${code}`));
        }
        r(code);
      }),
    );
    await new Promise((r, reject) => {
      ws.once('open', r);
      ws.once('error', reject);
    });
    const waitFor = (pred: (m: { t: string; [k: string]: unknown }) => boolean) => {
      const hit = received.find(pred);
      if (hit) return Promise.resolve(hit);
      if (closedCode !== null) {
        return Promise.reject(new Error(`连接已关闭（${closedCode}），未等到期望消息`));
      }
      return new Promise<{ t: string; [k: string]: unknown }>((resolve, reject) => {
        waiters.push({ pred, resolve, reject });
      });
    };
    return { ws, received, closed, waitFor, rawMax: () => rawMax };
  };

  test('恰好等于上限的消息被处理；服务端发出的大快照不受入站上限影响', async () => {
    const c = await connect();
    const hello = JSON.stringify({ t: 'hello', client: 'c-at-limit', lastSeq: 0 });
    // JSON 允许尾部空白：补齐到恰好 WS_LIMIT 字节
    c.ws.send(hello + ' '.repeat(WS_LIMIT - Buffer.byteLength(hello)));
    await c.waitFor((m) => m.t === 'welcome');
    await c.waitFor((m) => m.t === 'snapshot');
    expect(c.rawMax()).toBeGreaterThan(WS_LIMIT);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    c.ws.close();
  });

  test('超过上限：含中文 op 恰好等于上限可提交，超出 1 字节以 1009 关闭且 seq、模型与 room_commits 不变', async () => {
    const makeCommentOp = (
      clientId: string,
      n: number,
      tableId: string,
      ver: number,
      targetBytes: number,
    ) => {
      const base = JSON.stringify({
        t: 'op',
        op: {
          client: clientId,
          n,
          name: 'setComment',
          args: { id: tableId, comment: '' },
          reads: [[tableId, ver]],
        },
      });
      const room = targetBytes - Buffer.byteLength(base);
      const comment = '中'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3);
      const frame = JSON.stringify({
        t: 'op',
        op: {
          client: clientId,
          n,
          name: 'setComment',
          args: { id: tableId, comment },
          reads: [[tableId, ver]],
        },
      });
      expect(Buffer.byteLength(frame)).toBe(targetBytes);
      expect(frame.length).toBeLessThan(targetBytes);
      return { frame, comment };
    };

    // 1. 恰好等于 WS_LIMIT 字节的含中文 op 正常提交
    const okConn = await connect();
    okConn.ws.send(JSON.stringify({ t: 'hello', client: 'c-op-at', lastSeq: 0 }));
    await okConn.waitFor((m) => m.t === 'welcome');
    const snap1 = (await okConn.waitFor((m) => m.t === 'snapshot')) as unknown as Extract<
      ToClient,
      { t: 'snapshot' }
    >;
    const tableId = Object.values(snap1.model.objects).find(
      (o) => o.kind === 'table' && o.name === 't_0',
    )!.id;
    const atOp = makeCommentOp('c-op-at', 1, tableId, Number(snap1.versions[tableId] ?? 0), WS_LIMIT);
    okConn.ws.send(atOp.frame);
    const commitMsg = await okConn.waitFor((m) => m.t === 'commit' && m.client === 'c-op-at');
    expect(commitMsg.seq).toBe(snap1.seq + 1);
    const afterAt = await rooms.model(branch);
    expect(afterAt.seq).toBe(snap1.seq + 1);
    expect((afterAt.model.objects[tableId] as { comment: string | null }).comment).toBe(atOp.comment);
    okConn.ws.close();

    // 2. 超出 1 字节的含中文 op 以 1009 关闭，不改 seq / 模型 / room_commits
    const overConn = await connect();
    overConn.ws.send(JSON.stringify({ t: 'hello', client: 'c-op-over', lastSeq: 0 }));
    await overConn.waitFor((m) => m.t === 'welcome');
    const snap2 = (await overConn.waitFor((m) => m.t === 'snapshot')) as unknown as Extract<
      ToClient,
      { t: 'snapshot' }
    >;
    const beforeModel = await rooms.model(branch);
    const [commitBefore] = await db.query<{ n: number | string }>(
      'select count(*) as n from room_commits where branch_id = $1',
      [branch],
    );
    const overOp = makeCommentOp('c-op-over', 1, tableId, Number(snap2.versions[tableId] ?? 0), WS_LIMIT + 1);
    overConn.ws.send(overOp.frame);
    expect(await overConn.closed).toBe(1009);
    const afterOver = await rooms.model(branch);
    expect(afterOver.seq).toBe(beforeModel.seq);
    expect(afterOver.model).toEqual(beforeModel.model);
    const [commitAfter] = await db.query<{ n: number | string }>(
      'select count(*) as n from room_commits where branch_id = $1',
      [branch],
    );
    expect(Number(commitAfter!.n)).toBe(Number(commitBefore!.n));
  });

  test('分片发送也按整条消息累计：总长超限同样 1009', async () => {
    const c = await connect();
    const part = 'x'.repeat(WS_LIMIT / 4);
    for (let i = 0; i < 5; i++) c.ws.send(part, { fin: i === 4 });
    expect(await c.closed).toBe(1009);
  });

  test('presence 数据超过上限直接丢弃，不转发给其他连接（含中文按字节计）', async () => {
    const a = await connect();
    const b = await connect();
    a.ws.send(JSON.stringify({ t: 'hello', client: 'c-pres-a', lastSeq: 0 }));
    b.ws.send(JSON.stringify({ t: 'hello', client: 'c-pres-b', lastSeq: 0 }));
    await a.waitFor((m) => m.t === 'welcome');
    await b.waitFor((m) => m.t === 'welcome');
    a.ws.send(JSON.stringify({ t: 'presence', data: { big: 'x'.repeat(MAX_PRESENCE_BYTES) } }));
    const cjkData = { cjk: '中'.repeat(1400) };
    expect(JSON.stringify(cjkData).length).toBeLessThan(MAX_PRESENCE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(cjkData))).toBeGreaterThan(MAX_PRESENCE_BYTES);
    a.ws.send(JSON.stringify({ t: 'presence', data: cjkData }));
    a.ws.send(JSON.stringify({ t: 'presence', data: { cursor: 1 } }));
    const got = await b.waitFor((m) => m.t === 'presence');
    expect(got.data).toEqual({ cursor: 1 });
    expect(b.received.filter((m) => m.t === 'presence')).toHaveLength(1);
    a.ws.close();
    b.ws.close();
  });

  test('客户端与服务端上限不一致：超限 1009 后 dropPending 并重连，后续小修改可正常提交且不陷入 1011 循环', async () => {
    // 客户端用默认 16 MiB 上限，服务端用 WS_LIMIT（16 KiB），模拟两端上限不一致
    const client = new SyncClient('tab-mismatch', emptyModel());
    const closeCodes: number[] = [];
    let activeWs: WebSocket | null = null;
    let holdFirstCommit = true;
    let reconnects = 0;
    let stopped = false;

    let resolveFirstCommit!: () => void;
    const firstCommitSeen = new Promise<void>((r) => {
      resolveFirstCommit = r;
    });
    let resolveReadyAfter1009!: () => void;
    const readyAfter1009 = new Promise<void>((r) => {
      resolveReadyAfter1009 = r;
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });

    const openConn = () => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pid}/sync`, {
        headers: { cookie, origin: base },
      });
      sockets.add(ws);
      activeWs = ws;
      client.send = (m: ToServer) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      };
      ws.on('open', () => {
        if (activeWs !== ws) return;
        client.connect();
      });
      ws.on('message', (data) => {
        if (activeWs !== ws) return;
        const msg = JSON.parse((data as Buffer).toString('utf8')) as ToClient | { t: string };
        if (msg.t === 'commit' && holdFirstCommit) {
          resolveFirstCommit();
          return;
        }
        if (msg.t === 'welcome' || msg.t === 'snapshot' || msg.t === 'commit' || msg.t === 'reject') {
          client.receive(msg as ToClient);
          if (closeCodes.includes(1009) && client.ready) {
            resolveReadyAfter1009();
          }
          if (Object.hasOwn(client.confirmed.objects, 't_after_1009') && client.pending.length === 0) {
            stopped = true;
            ws.close();
            resolveDone();
          }
        }
      });
      ws.on('close', (code) => {
        if (activeWs !== ws) return;
        client.disconnect();
        if (stopped) return;
        closeCodes.push(code);
        if (code === 1009) {
          holdFirstCommit = false;
          expect(client.dropPending()).toBe(2);
        }
        if (reconnects < 5) {
          reconnects += 1;
          openConn();
        } else {
          resolveDone();
        }
      });
    };

    const initialSync = new Promise<void>((resolve) => {
      const off = client.subscribe(() => {
        if (client.ready && client.seq > 0) {
          off();
          resolve();
        }
      });
    });

    openConn();
    await initialSync;

    const schemaId = Object.values(client.view.objects).find(
      (o) => o.kind === 'schema' && o.name === 'public',
    )!.id;

    // 1. 先发一条小修改（n=1），等服务端已落库并广播 commit，但暂不交给 client.receive，让 pending 留有未确认项
    client.mutate('createTable', { id: 't_before_1009', schema: schemaId, name: 't_before_1009' });
    await firstCommitSeen;
    // 2. 再发一条超过服务端 WS_LIMIT 的大修改（n=2），触发服务端以 1009 断开
    client.mutate('setComment', { id: 't_before_1009', comment: 'x'.repeat(WS_LIMIT + 4096) });

    await readyAfter1009;
    expect(client.view.objects.t_before_1009).toBeDefined();
    expect((client.view.objects.t_before_1009 as { comment: string | null }).comment).toBeNull();
    // 3. 重连完成同步后，再做一条小修改，必须能被服务端正常接受并确认
    client.mutate('createTable', { id: 't_after_1009', schema: schemaId, name: 't_after_1009' });
    await done;

    expect(closeCodes).toEqual([1009]);
    expect(client.pending).toEqual([]);
    expect(client.confirmed.objects.t_before_1009).toBeDefined();
    expect((client.confirmed.objects.t_before_1009 as { comment: string | null }).comment).toBeNull();
    expect(client.confirmed.objects.t_after_1009).toBeDefined();
  });
});
