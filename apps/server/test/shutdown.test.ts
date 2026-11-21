// 优雅停机（#19）单元测试与集成测试：
// 1. 信号防重入幂等（连续 SIGINT / SIGTERM 只执行一次停机序列并返回同一 Promise）；
// 2. 在途 HTTP 请求 + 在途环境锁（EnvLocks）+ 在途派生刷新排空期间，webhooks / ha 租约 / db 保持存活，
//    confirmVersion、requests.finish 与同事务 Webhook 入队不丢失，排空后再按严格顺序关闭基础设施；
// 3. 活跃 WebSocket 与活跃收件箱 SSE 连接在停机时主动优雅关闭，不会无限阻塞 server.close；
// 4. 超过兜底超时时间时触发超时回调强制终止残留连接并退出（且不二次触发退出）；
// 5. EnvLocks.drain() 与 OpaqueRefresher.stop() / drain() 边界行为。
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

import { createApp } from '../src/app.ts';
import { openPlatformDb } from '../src/db.ts';
import { OpaqueRefresher } from '../src/derive.ts';
import { confirmVersion } from '../src/envs.ts';
import { EnvLocks } from '../src/executions.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import type { Rooms } from '../src/rooms.ts';
import { encrypt } from '../src/secrets.ts';
import type { Shadow } from '../src/shadow.ts';
import { createShutdown, type ShutdownDeps } from '../src/shutdown.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'shutdown-test-secret-0123456789';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('优雅停机（#19）', () => {
  test('1. 重复调用 stop()（模拟连续 SIGINT + SIGTERM）返回同一 Promise 且只执行一次停机序列', async () => {
    const events: string[] = [];
    const serverGate = deferred<void>();
    const exitCodes: number[] = [];

    const deps: ShutdownDeps = {
      server: {
        close: (cb) => {
          events.push('server.close:start');
          void serverGate.promise.then(() => {
            events.push('server.close:done');
            cb?.();
          });
        },
        closeIdleConnections: () => events.push('server.closeIdleConnections'),
      },
      drift: {
        stop: () => events.push('drift.stop'),
        drain: async () => void events.push('drift.drain'),
      },
      requests: {
        stop: () => events.push('requests.stop'),
        drain: async () => void events.push('requests.drain'),
      },
      refresher: {
        stop: () => events.push('refresher.stop'),
        drain: async () => void events.push('refresher.drain'),
      },
      locks: {
        drain: async () => void events.push('locks.drain'),
      },
      webhooks: {
        close: async () => void events.push('webhooks.close'),
      },
      rooms: {
        disconnectAll: () => void events.push('rooms.disconnectAll'),
        flush: async () => void events.push('rooms.flush'),
        close: () => void events.push('rooms.close'),
      },
      shadows: {
        close: async () => void events.push('shadows.close'),
      },
      bus: {
        close: async () => void events.push('bus.close'),
      },
      ha: {
        stop: async () => void events.push('ha.stop'),
      },
      db: {
        close: async () => void events.push('db.close'),
      },
      timeoutMs: 5_000,
      onExit: (code) => {
        exitCodes.push(code);
        events.push(`exit:${code}`);
      },
      log: { info: () => {}, error: () => {} },
    };

    const stop = createShutdown(deps);
    const p1 = stop('SIGINT');
    const p2 = stop('SIGTERM');
    const p3 = stop('SIGINT');
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);

    await flushMicrotasks();
    // server.close 尚未完成时，基础设施均未关闭
    expect(events).not.toContain('webhooks.close');
    expect(events).not.toContain('ha.stop');
    expect(events).not.toContain('db.close');

    serverGate.resolve();
    await p1;
    // 完成后再次触发也幂等返回同一 Promise，不重跑
    expect(stop('SIGTERM')).toBe(p1);

    expect(exitCodes).toEqual([0]);
    for (const step of [
      'drift.stop',
      'requests.stop',
      'refresher.stop',
      'server.close:start',
      'server.close:done',
      'webhooks.close',
      'rooms.flush',
      'rooms.close',
      'shadows.close',
      'bus.close',
      'ha.stop',
      'db.close',
      'exit:0',
    ]) {
      expect(events.filter((e) => e === step)).toHaveLength(1);
    }

    // 验证停机收尾严格按依赖顺序发生
    const idx = (name: string) => events.indexOf(name);
    expect(idx('server.close:done')).toBeLessThan(idx('webhooks.close'));
    expect(idx('webhooks.close')).toBeLessThan(idx('rooms.flush'));
    expect(idx('rooms.flush')).toBeLessThan(idx('rooms.close'));
    expect(idx('rooms.close')).toBeLessThan(idx('shadows.close'));
    expect(idx('shadows.close')).toBeLessThan(idx('bus.close'));
    expect(idx('bus.close')).toBeLessThan(idx('ha.stop'));
    expect(idx('ha.stop')).toBeLessThan(idx('db.close'));
    expect(idx('db.close')).toBeLessThan(idx('exit:0'));
  });

  test('2. 停机期间存在在途 HTTP 请求与环境锁时，等待排空后再关闭 webhooks / ha / db，收尾落库与 Webhook 入队不丢失', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dowel-shutdown-drain-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'platform.db');
    const db = await openPlatformDb(dbPath);
    const created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      // 调长 pollIntervalMs 以便验证 webhook_jobs 在 webhooks.close 之前稳定入队落盘
      webhooks: { pollIntervalMs: 60_000, retryBaseMs: 60_000 },
    });
    const { app, injectWebSocket, wss, bus, ha, rooms, shadows, refresher, drift, exec, requests, webhooks } =
      created;

    // 准备真实业务数据：用户、组、项目、版本、环境、组级 Webhook、一条 executing 的执行申请
    const admin = await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    await db.query("insert into groups (id, slug, name) values ('g1', 'g1', '测试组')");
    await db.query("insert into projects (id, name, group_id, slug) values ('p1', '项目1', 'g1', 'p1')");
    await db.query("insert into branches (id, project_id, name) values ('b1', 'p1', 'main')");
    await db.query(
      `insert into versions (id, project_id, branch_id, seq, number, name, checksum, model, up_steps, down_steps)
       values ('v1', 'p1', 'b1', 1, 1, 'v1', 'chk1', '{}', '[]', '[]')`,
    );
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ('e1', 'p1', 'prod', $1, $2)`,
      [encrypt('postgres://u:p@127.0.0.1:5432/target'), true],
    );
    await db.query(
      `insert into environment_versions (environment_id, version_id, state)
       values ('e1', 'v1', 'claimed')`,
    );
    await db.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('w1', 'g1', '通知', 'json', $1, $2::text::jsonb, $3)`,
      [encrypt('https://example.invalid/hook'), JSON.stringify(['request.executed']), true],
    );
    const nowIso = new Date().toISOString();
    await db.query(
      `insert into exec_requests
         (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
          migrations, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at,
          executed_by, emergency, worker_id)
       values ('req1', 'p1', 'e1', $1, 'up', null, 'v1', $2::text::jsonb, $3::text::jsonb,
               'conn-hash', $4, 'executing', 1, $5, $6, $6, $1, $7, $8)`,
      [
        admin.id,
        JSON.stringify([
          { versionId: 'v1', number: 1, name: 'v1', direction: 'up', checksum: 'chk1', steps: 1 },
        ]),
        JSON.stringify({ implicit: true, stages: [] }),
        true,
        new Date(Date.now() + 60_000).toISOString(),
        nowIso,
        false,
        ha.replicaId,
      ],
    );

    // 挂一个可控的长 HTTP 路由模拟在途请求
    const httpEntered = deferred<void>();
    const httpRelease = deferred<void>();
    app.get('/__test__/in-flight', async (c) => {
      httpEntered.resolve();
      await httpRelease.promise;
      return c.json({ ok: true });
    });

    await ha.start();
    await bus.start();
    await requests.start(0);

    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // 记录关键停机步骤的精确顺序
    const order: string[] = [];
    const origWebhooksClose = webhooks.close.bind(webhooks);
    const origRoomsFlush = rooms.flush.bind(rooms);
    const origRoomsClose = rooms.close.bind(rooms);
    const origShadowsClose = shadows.close.bind(shadows);
    const origBusClose = bus.close.bind(bus);
    const origHaStop = ha.stop.bind(ha);
    const origDbClose = db.close.bind(db);

    const exitCodes: number[] = [];
    const stop = createShutdown({
      server,
      wss,
      drift,
      requests,
      refresher,
      locks: exec.locks,
      webhooks: {
        close: async () => {
          order.push('webhooks.close');
          await origWebhooksClose();
        },
      },
      rooms: {
        disconnectAll: (code, reason) => rooms.disconnectAll(code, reason),
        flush: async () => {
          order.push('rooms.flush');
          await origRoomsFlush();
        },
        close: () => {
          order.push('rooms.close');
          origRoomsClose();
        },
      },
      shadows: {
        close: async () => {
          order.push('shadows.close');
          await origShadowsClose();
        },
      },
      bus: {
        close: async () => {
          order.push('bus.close');
          await origBusClose();
        },
      },
      ha: {
        stop: async () => {
          order.push('ha.stop');
          await origHaStop();
        },
      },
      db: {
        close: async () => {
          order.push('db.close');
          await origDbClose();
        },
      },
      timeoutMs: 5_000,
      onExit: (code) => {
        exitCodes.push(code);
        order.push(`exit:${code}`);
      },
      log: { info: () => {}, error: () => {} },
    });

    // 1. 占用环境锁模拟在途目标库迁移，并发起一条在途 HTTP 请求
    const releaseLock = await exec.locks.acquire('e1');
    const httpFetch = fetch(`${base}/__test__/in-flight`, { headers: { connection: 'close' } });
    await httpEntered.promise;

    // 2. 触发优雅停机
    const stopPromise = stop('SIGTERM');
    await flushMicrotasks();

    // 3. 在途请求与环境锁尚未完成：webhooks / ha / db 必须全部存活
    expect(order).toEqual([]);
    expect(await ha.isNodeAlive(ha.replicaId)).toBe(true);

    // 4. 释放 HTTP 请求，但环境锁仍持有中：停机仍需等待环境锁排空
    httpRelease.resolve();
    const httpRes = await httpFetch;
    expect(httpRes.status).toBe(200);
    expect(await httpRes.json()).toEqual({ ok: true });
    await flushMicrotasks();
    expect(order).toEqual([]);
    expect(await ha.isNodeAlive(ha.replicaId)).toBe(true);

    // 5. 模拟在途迁移提交后的收尾落库：confirmVersion + requests.finish（同事务写入 webhook_jobs）
    await confirmVersion(db, 'e1', 'v1');
    await requests.finish(
      null,
      'req1',
      { id: admin.id, name: admin.name },
      { ok: true, current: { id: 'v1', number: 1, name: 'v1' }, error: null },
    );
    order.push('migration.finished');

    // 6. 释放环境锁，触发停机继续执行至完成
    await releaseLock();
    order.push('lock.released');
    await stopPromise;

    expect(exitCodes).toEqual([0]);
    expect(order).toEqual([
      'migration.finished',
      'lock.released',
      'webhooks.close',
      'rooms.flush',
      'rooms.close',
      'shadows.close',
      'bus.close',
      'ha.stop',
      'db.close',
      'exit:0',
    ]);

    // 7. 重新打开落盘平台库，验证永久 executed_at、申请终态、Webhook 任务与租约清理均完整落库
    const verifyDb = await openPlatformDb(dbPath);
    try {
      const [ver] = await verifyDb.query<{ executed_at: string | null }>(
        "select executed_at from versions where id = 'v1'",
      );
      expect(ver?.executed_at).toBeTruthy();

      const [ev] = await verifyDb.query<{ state: string }>(
        "select state from environment_versions where environment_id = 'e1' and version_id = 'v1'",
      );
      expect(ev?.state).toBe('confirmed');

      const [req] = await verifyDb.query<{ status: string; executed_at: string | null }>(
        "select status, executed_at from exec_requests where id = 'req1'",
      );
      expect(req?.status).toBe('executed');
      expect(req?.executed_at).toBeTruthy();

      // Webhook 事件已随业务事务通过 enqueueIn(tx) 落入 webhook_jobs 或已记录到 webhook_deliveries，没有被静默丢弃
      const jobs = await verifyDb.query<{ id: string; event_type: string; locked_by: string | null }>(
        "select id, event_type, locked_by from webhook_jobs where webhook_id = 'w1'",
      );
      const deliveries = await verifyDb.query<{ id: string; event: string }>(
        "select id, event from webhook_deliveries where webhook_id = 'w1'",
      );
      expect(jobs.length + deliveries.length).toBeGreaterThanOrEqual(1);
      for (const j of jobs) {
        expect(j.event_type).toBe('request.executed');
        expect(j.locked_by).toBeNull();
      }

      // 停机完成后本副本的 HA 租约已清理
      const leases = await verifyDb.query<{ key: string }>('select key from ha_leases where owner = $1', [
        ha.replicaId,
      ]);
      expect(leases).toEqual([]);
    } finally {
      await verifyDb.close();
    }
  });

  test('3. 活跃 WebSocket 与收件箱 SSE 长连接不会阻塞停机，停机时主动优雅关闭并快速退出', async () => {
    const db = await openPlatformDb(':memory:');
    const created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    const { app, injectWebSocket, wss, bus, ha, rooms, shadows, refresher, drift, exec, requests, webhooks } =
      created;

    await makeUser(db, 'ws_sse_admin', { name: '管理员', role: 'admin' });
    await db.query("insert into groups (id, slug, name) values ('g1', 'g1', '组1')");
    await ha.start();
    await bus.start();
    await requests.start(0);

    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    // 登录并建一个项目以连接同步 WebSocket
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ws_sse_admin', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    const projRes = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '实时测试项目', groupId: 'g1' }),
    });
    expect(projRes.status).toBe(201);
    const proj = (await projRes.json()) as { id: string };

    // 建立活跃 WebSocket 连接并完成 hello 握手
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/projects/${proj.id}/sync`, {
      headers: { cookie },
    });
    const wsClosed = deferred<{ code: number; reason: string }>();
    ws.once('close', (code, reason) => wsClosed.resolve({ code, reason: reason.toString() }));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', client: 'c-shutdown-test', lastSeq: 0 }));
    await flushMicrotasks(2);

    // 建立活跃收件箱 SSE 长连接并读取首帧
    const sseRes = await fetch(`${base}/api/me/inbox/stream`, { headers: { cookie } });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value)).toContain('"unread":0');

    // 触发停机：应在短时间内（远小于 timeoutMs）优雅断开 WS 与 SSE 并完成退出
    const exitCodes: number[] = [];
    let timedOut = false;
    const stop = createShutdown({
      server,
      wss,
      drift,
      requests,
      refresher,
      locks: exec.locks,
      webhooks,
      rooms,
      shadows,
      bus,
      ha,
      db,
      timeoutMs: 3_000,
      onTimeout: () => {
        timedOut = true;
      },
      onExit: (code) => exitCodes.push(code),
      log: { info: () => {}, error: () => {} },
    });

    const t0 = Date.now();
    await stop('SIGTERM');
    const elapsed = Date.now() - t0;

    expect(timedOut).toBe(false);
    expect(exitCodes).toEqual([0]);
    expect(elapsed).toBeLessThan(2_000);

    // WS 客户端应收到 1001 Going Away 关闭码
    const closedInfo = await wsClosed.promise;
    expect(closedInfo.code).toBe(1001);

    // SSE 流应已自然读到 EOF（done: true）
    let sseEnded = false;
    for (let i = 0; i < 10; i++) {
      const next = await reader.read();
      if (next.done) {
        sseEnded = true;
        break;
      }
    }
    expect(sseEnded).toBe(true);
  });

  test('4. 超过兜底超时时间时触发超时回调、强制终止连接并退出，且不二次触发退出', async () => {
    const stuckLock = deferred<void>();
    const events: string[] = [];
    const exitCodes: number[] = [];
    const errors: string[] = [];
    let wsTerminated = false;

    const fakeWs = {
      readyState: 1,
      close: () => events.push('ws.close'),
      terminate: () => {
        wsTerminated = true;
        events.push('ws.terminate');
      },
    };

    const stop = createShutdown({
      server: {
        close: () => {
          events.push('server.close');
          // 刻意永不回调模拟挂死请求
        },
        closeIdleConnections: () => events.push('server.closeIdleConnections'),
        closeAllConnections: () => events.push('server.closeAllConnections'),
      },
      wss: {
        clients: [fakeWs],
        close: () => events.push('wss.close'),
      },
      drift: { stop: () => events.push('drift.stop') },
      requests: { stop: () => events.push('requests.stop') },
      refresher: {
        stop: () => events.push('refresher.stop'),
        drain: async () => {},
      },
      locks: {
        drain: () => stuckLock.promise,
      },
      webhooks: { close: async () => void events.push('webhooks.close') },
      rooms: {
        flush: async () => void events.push('rooms.flush'),
        close: () => void events.push('rooms.close'),
      },
      shadows: { close: async () => void events.push('shadows.close') },
      bus: { close: async () => void events.push('bus.close') },
      ha: { stop: async () => void events.push('ha.stop') },
      db: { close: async () => void events.push('db.close') },
      timeoutMs: 80,
      wsCloseGraceMs: 500,
      onTimeout: () => events.push('onTimeout'),
      onExit: (code) => {
        exitCodes.push(code);
        events.push(`exit:${code}`);
      },
      log: {
        error: (msg) => errors.push(msg),
      },
    });

    await stop('SIGTERM');

    expect(wsTerminated).toBe(true);
    expect(events).toContain('server.closeAllConnections');
    expect(events).toContain('onTimeout');
    expect(exitCodes).toEqual([1]);
    expect(errors.some((m) => m.includes('优雅停机超时') && m.includes('SIGTERM'))).toBe(true);

    // 即使超时后挂起的锁最终释放，也不应继续关闭 db 或再次调用 onExit
    stuckLock.resolve();
    await flushMicrotasks();
    expect(exitCodes).toEqual([1]);
    expect(events).not.toContain('db.close');
  });

  test('5. EnvLocks.drain() 无锁立即返回，有锁及排队接手锁时等待全部释放完成', async () => {
    const locks = new EnvLocks();

    // 无锁时立即 resolve
    await locks.drain();
    expect(locks.activeCount).toBe(0);

    const rel1 = await locks.acquire('env-1');
    const rel2 = await locks.acquire('env-2');
    // 排队等待 env-1 的第二个请求：env-1 释放后会立即接手该锁
    const queuedAcquire = locks.acquire('env-1', 5_000);
    expect(locks.activeCount).toBe(2);

    let drained = false;
    const drainPromise = locks.drain().then(() => {
      drained = true;
    });

    await flushMicrotasks(2);
    expect(drained).toBe(false);

    // 释放 env-2 与第一个 env-1（此时排队的第二个 env-1 接手锁，drain 仍不应结束）
    await rel2();
    await rel1();
    const rel1Next = await queuedAcquire;
    await flushMicrotasks(2);
    expect(locks.activeCount).toBe(1);
    expect(drained).toBe(false);

    // 释放接手的第二个 env-1，drain 立即完成
    await rel1Next();
    await drainPromise;
    expect(drained).toBe(true);
    expect(locks.activeCount).toBe(0);
  });

  test('6. OpaqueRefresher.stop()/drain() 清理未触发防抖定时器、拒绝新调度并等待在途刷新结束', async () => {
    const live: Model = emptyModel();
    runMutator(live, 'createSchema', { id: 's', name: 'public' });
    runMutator(live, 'createTable', { id: 't', schema: 's', name: 'orders' });
    runMutator(live, 'addColumn', { table: 't', column: { id: 'c', name: 'total', type: 'integer' } });

    const canonEntered = deferred<void>();
    const canonRelease = deferred<void>();
    let canonCalls = 0;

    const rooms = {
      state: async () => ({ model: structuredClone(live), versions: {}, seq: 0 }),
      patch: async (_b: string, _u: string, objects: Obj[]) => {
        for (const o of objects) live.objects[o.id] = o;
      },
    } as unknown as Rooms;
    const shadow = {
      canonicalize: async (_prev: Model, next: Model) => {
        canonCalls++;
        canonEntered.resolve();
        await canonRelease.promise;
        return Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj);
      },
    } as unknown as Shadow;

    const refresher = new OpaqueRefresher(rooms, async () => shadow, {
      load: async () => null,
      save: async () => {},
    });
    refresher.delayMs = 20;
    await refresher.reset('b-running', live);
    await refresher.reset('b-pending', live);

    // b-running 启动后进入 shadow.canonicalize 阻塞中；b-pending 仅挂在防抖定时器里尚未启动
    runMutator(live, 'addCheck', { id: 'k1', table: 't', expr: 'total > 0' });
    refresher.schedule('b-running');
    await canonEntered.promise;

    refresher.delayMs = 50;
    refresher.schedule('b-pending');

    // 停机调用 stop() + drain()：清理 b-pending 定时器，等待 b-running 完成
    let drained = false;
    const drainPromise = refresher.drain().then(() => {
      drained = true;
    });
    await flushMicrotasks(2);
    expect(drained).toBe(false);

    // 停机后再调用 schedule 不应安排新任务
    refresher.schedule('b-after-stop');
    expect(refresher.tracked('b-after-stop')).toBe(false);

    // 放行在途的 canonicalize，drain 随后完成
    canonRelease.resolve();
    await drainPromise;
    expect(drained).toBe(true);

    // 等超过 b-pending 原定时器的时间，确认未触发第二次 canonicalize
    await new Promise((r) => setTimeout(r, 80));
    expect(canonCalls).toBe(1);
  });
});
