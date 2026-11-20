// P7 HA Wave 2B（HA3 + HA4 剩余）真实 PG 双副本集成测试（ADR 0011）：
// 1. 持久化 Webhook 队列（webhook_jobs + FOR UPDATE SKIP LOCKED）：双副本防重 + 崩溃重启续投不丢失；
// 2. 按副本租约恢复“执行中”申请：存活副本不误杀、停机/租约过期后由另一副本 sweep 自动恢复为 interrupted；
// 3. 跨副本收件箱 SSE 实时推送：副本 A 写入通知或标已读，副本 B 订阅者实时收到最新未读数；
// 4. 分布式巡检互斥与影子库派生防重：双 DriftScheduler 并发 runOnce 仅一个执行、双 OpaqueRefresher 同分支互斥。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InboxEvent, WebhookEventInput } from '@dowel/api';
import { emptyModel, type Model, type Obj, runMutator } from '@dowel/core';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { EventBus } from '../src/bus.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { OpaqueRefresher } from '../src/derive.ts';
import { DriftScheduler } from '../src/drift-scheduler.ts';
import { EnvLocks, type ExecContext } from '../src/executions.ts';
import { HaCoordinator } from '../src/ha.ts';
import { connHash, Effects, INTERRUPTED, type RequestRow, Requests } from '../src/requests.ts';
import { type Peer, Rooms } from '../src/rooms.ts';
import { encrypt } from '../src/secrets.ts';
import { securityConfigFromEnv } from '../src/security.ts';
import type { Shadow } from '../src/shadow.ts';
import { Webhooks } from '../src/webhooks.ts';
import { makeUser } from './support.ts';

process.env.DOWEL_SECRET ??= 'ha-jobs-test-secret-0123456789';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 8000, stepMs = 25) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

interface Receiver {
  base: string;
  received: Received[];
  replies: ((res: ServerResponse, req: Received) => void)[];
  fallback: (res: ServerResponse, req: Received) => void;
  close: () => Promise<void>;
}

const ok200 = (res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
};

const sampleEvent = (): WebhookEventInput => ({
  type: 'request.created',
  title: 'HA Webhook 投递测试',
  lines: ['**管理员** 提交了执行申请'],
  url: 'https://dowel.example.com/p/g/proj/requests/r1',
  data: { requestId: 'r1' },
});

describe.skipIf(!PG_URL)('P7 HA Wave 2B：持久化队列、分布式巡检、跨副本 SSE 与按租约恢复（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];

  const startReceiver = async (fallback: Receiver['fallback'] = ok200): Promise<Receiver> => {
    const r = { received: [], replies: [], fallback } as unknown as Receiver;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const got: Received = {
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        r.received.push(got);
        (r.replies.shift() ?? r.fallback)(res, got);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    r.base = `http://127.0.0.1:${port}`;
    r.close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    closers.push(r.close);
    return r;
  };

  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('1. 持久化 Webhook 队列：双副本防重仅投递 1 次；崩溃重启后新实例自动拾取重试任务零丢失', async () => {
    const t = await createTestDb('ha_webhooks');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const busA = new EventBus(dbA, { replicaId: 'wh-replica-a' });
    const busB = new EventBus(dbB, { replicaId: 'wh-replica-b' });
    const haA = new HaCoordinator(dbA, { replicaId: 'wh-replica-a' });
    const haB = new HaCoordinator(dbB, { replicaId: 'wh-replica-b' });

    const rx = await startReceiver();
    let hooksA: Webhooks | null = null;
    let hooksB: Webhooks | null = null;
    let hooksC: Webhooks | null = null;

    try {
      await busA.start();
      await busB.start();
      await dbA.query(
        `insert into instance_settings (key, value) values ('webhook_allowlist', $1::text::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [JSON.stringify(['127.0.0.0/8'])],
      );
      await dbA.query("insert into groups (id, slug, name) values ('g-wh', 'g-wh', '钩子组')");
      await dbA.query(
        `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
         values ('w-ha', 'g-wh', 'ha-hook', 'json', $1, $2::text::jsonb, true)`,
        [encrypt(`${rx.base}/hook`), JSON.stringify(['request.created'])],
      );

      // (a) 双副本防重：同时连接同一 PG，触发 1 个事件 → 严格只投递 1 次
      hooksA = new Webhooks(dbA, {
        bus: busA,
        ha: haA,
        retryBaseMs: 30,
        pollIntervalMs: 30,
        timeoutMs: 2000,
      });
      hooksB = new Webhooks(dbB, {
        bus: busB,
        ha: haB,
        retryBaseMs: 30,
        pollIntervalMs: 30,
        timeoutMs: 2000,
      });

      hooksA.emit('g-wh', sampleEvent());
      await hooksA.flush();
      await hooksB.flush();

      expect(rx.received).toHaveLength(1);
      expect(await dbA.query('select id from webhook_jobs')).toEqual([]);
      expect(
        await dbA.query<{ ok: boolean; attempt: number }>(
          "select ok, attempt from webhook_deliveries where webhook_id = 'w-ha'",
        ),
      ).toEqual([{ ok: true, attempt: 1 }]);

      await hooksA.close();
      await hooksB.close();
      hooksA = null;
      hooksB = null;

      // (b) 模拟进程崩溃重启：首次 500 失败需重试，在重试前关闭旧实例，新实例自动拾取并成功投递
      rx.received.length = 0;
      rx.replies.push((res) => {
        res.writeHead(500);
        res.end('temporary failure');
      });

      hooksA = new Webhooks(dbA, {
        bus: busA,
        ha: haA,
        retryBaseMs: 250,
        pollIntervalMs: 40,
        timeoutMs: 2000,
      });
      hooksA.emit('g-wh', sampleEvent());

      // 等旧实例完成第 1 次 500 尝试并把 job 写回待重试状态（attempts = 1, locked_by = null）
      await waitFor(async () => {
        const rows = await dbA.query<{ attempts: number; locked_by: string | null }>(
          'select attempts, locked_by from webhook_jobs',
        );
        return rows.length === 1 && rows[0]!.attempts === 1 && rows[0]!.locked_by === null;
      });
      expect(rx.received).toHaveLength(1);
      const firstDeliveryId = rx.received[0]!.headers['x-dowel-delivery'];

      // 在重试到期前关闭旧实例（模拟崩溃/重启）
      await hooksA.close();
      hooksA = null;

      // 启动全新的 Webhooks 实例（接收端 fallback 为 200）：无需重新 emit，自动拾取 webhook_jobs 完成重试
      hooksC = new Webhooks(dbB, {
        bus: busB,
        ha: haB,
        retryBaseMs: 250,
        pollIntervalMs: 30,
        timeoutMs: 2000,
      });
      await hooksC.flush();

      expect(rx.received).toHaveLength(2);
      expect(rx.received[1]!.headers['x-dowel-delivery']).toBe(firstDeliveryId);
      expect(await dbB.query('select id from webhook_jobs')).toEqual([]);
      const deliveries = await dbB.query<{ attempt: number; ok: boolean; status: number }>(
        'select attempt, ok, status from webhook_deliveries where delivery_id = $1 order by attempt',
        [firstDeliveryId],
      );
      expect(deliveries).toEqual([
        { attempt: 1, ok: false, status: 500 },
        { attempt: 2, ok: true, status: 200 },
      ]);
    } finally {
      if (hooksA) await hooksA.close();
      if (hooksB) await hooksB.close();
      if (hooksC) await hooksC.close();
      await busA.close();
      await busB.close();
      await dbA.close();
      await dbB.close();
    }
  });

  test('2. 按副本租约恢复“执行中”申请：存活副本绝不误杀，停机或租约过期后副本 B sweep 自动恢复为 interrupted', async () => {
    const t = await createTestDb('ha_recover');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const haA = new HaCoordinator(dbA, { replicaId: 'exec-node-a', ttlMs: 5000, heartbeatIntervalMs: 1000 });
    const haB = new HaCoordinator(dbB, { replicaId: 'exec-node-b', ttlMs: 5000, heartbeatIntervalMs: 1000 });
    const busA = new EventBus(dbA, { replicaId: 'exec-node-a' });
    const busB = new EventBus(dbB, { replicaId: 'exec-node-b' });
    const whA = new Webhooks(dbA, { bus: busA, ha: haA });
    const whB = new Webhooks(dbB, { bus: busB, ha: haB });
    const security = securityConfigFromEnv();
    const guard = async () => {};
    const execA: ExecContext = { db: dbA, guard, locks: new EnvLocks(dbA) };
    const execB: ExecContext = { db: dbB, guard, locks: new EnvLocks(dbB) };
    const requestsA = new Requests(dbA, execA, whA, security, { bus: busA, ha: haA });
    const requestsB = new Requests(dbB, execB, whB, security, { bus: busB, ha: haB });

    try {
      await haA.start();
      await haB.start();
      await busA.start();
      await busB.start();

      const requester = await makeUser(dbA, 'dev1', { name: '开发者' });
      await dbA.query("insert into groups (id, slug, name) values ('g-rec', 'g-rec', '恢复组')");
      await dbA.query("insert into group_members (group_id, user_id, role) values ('g-rec', $1, 'admin')", [
        requester.id,
      ]);
      await dbA.query(
        "insert into projects (id, name, group_id, slug) values ('p-rec', '恢复项目', 'g-rec', 'p-rec')",
      );
      await dbA.query("insert into branches (id, project_id, name) values ('b-rec', 'p-rec', 'main')");
      const envUrlEnc = encrypt('postgres://u:p@127.0.0.1:5432/x');
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production)
         values ('e-rec', 'p-rec', 'prod', $1, true)`,
        [envUrlEnc],
      );
      await dbA.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
         values ('v-rec-1', 'p-rec', 'b-rec', 0, 'v1', $1::text::jsonb, 1, '[]'::jsonb, '[]'::jsonb, 'sum1')`,
        [JSON.stringify(emptyModel())],
      );

      const envConnHash = connHash({ url_enc: envUrlEnc });
      const insertExecuting = async (id: string, workerId: string) => {
        await dbA.query(
          `insert into exec_requests
             (id, project_id, environment_id, requested_by, direction, to_version_id, migrations, flow, conn_hash, production, status, expires_at, updated_at, worker_id)
           values ($1, 'p-rec', 'e-rec', $2, 'up', 'v-rec-1', '[]'::jsonb, $3::text::jsonb, $4, true, 'executing', $5, $6, $7)`,
          [
            id,
            requester.id,
            JSON.stringify({ implicit: true, stages: [] }),
            envConnHash,
            new Date(Date.now() + 3600_000),
            new Date(),
            workerId,
          ],
        );
      };

      // 副本 A 正在执行 req-live（worker_id = haA.replicaId），此时副本 A 心跳存活
      await insertExecuting('req-live', requestsA.workerId!);

      // 副本 B 启动并巡检：副本 A 存活，绝不误杀 req-live
      await requestsB.start(0);
      expect(await requestsB.sweep()).toBe(0);
      const [stillRunning] = await dbB.query<{ status: string; worker_id: string | null }>(
        "select status, worker_id from exec_requests where id = 'req-live'",
      );
      expect(stillRunning).toEqual({ status: 'executing', worker_id: haA.replicaId });

      // 模拟副本 A 优雅停机（删除租约行）→ 副本 B 跑 sweep 自动将 req-live 恢复为 failed (interrupted)
      await haA.stop();
      expect(await requestsB.sweep()).toBe(1);
      const [recovered] = await dbB.query<{ status: string; result: { ok: boolean; code: string } }>(
        "select status, result from exec_requests where id = 'req-live'",
      );
      expect(recovered!.status).toBe('failed');
      expect(recovered!.result).toMatchObject({ ok: false, code: INTERRUPTED });

      // 模拟另一个节点崩溃且租约过期（expires_at 在过去）→ 副本 B 跑 sweep 自动恢复
      await dbA.query(
        "insert into ha_leases (key, owner, expires_at) values ('node:crashed-node', 'crashed-node', $1)",
        [new Date(Date.now() - 5000)],
      );
      await insertExecuting('req-expired-lease', 'crashed-node');
      expect(await requestsB.sweep()).toBe(1);
      const [recoveredExpired] = await dbB.query<{ status: string; result: { code: string } }>(
        "select status, result from exec_requests where id = 'req-expired-lease'",
      );
      expect(recoveredExpired!.status).toBe('failed');
      expect(recoveredExpired!.result.code).toBe(INTERRUPTED);
    } finally {
      requestsA.stop();
      requestsB.stop();
      await whA.close();
      await whB.close();
      await busA.close();
      await busB.close();
      await haA.stop();
      await haB.stop();
      await dbA.close();
      await dbB.close();
    }
  });

  test('3. 跨副本收件箱 SSE 实时推送：副本 A 写通知与标已读，副本 B 订阅者实时收到未读数更新', async () => {
    const t = await createTestDb('ha_inbox');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const busA = new EventBus(dbA, { replicaId: 'sse-node-a' });
    const busB = new EventBus(dbB, { replicaId: 'sse-node-b' });
    const haA = new HaCoordinator(dbA, { replicaId: 'sse-node-a' });
    const haB = new HaCoordinator(dbB, { replicaId: 'sse-node-b' });
    const whA = new Webhooks(dbA, { bus: busA, ha: haA });
    const whB = new Webhooks(dbB, { bus: busB, ha: haB });
    const security = securityConfigFromEnv();
    const guard = async () => {};
    const requestsA = new Requests(dbA, { db: dbA, guard, locks: new EnvLocks(dbA) }, whA, security, {
      bus: busA,
      ha: haA,
    });
    const requestsB = new Requests(dbB, { db: dbB, guard, locks: new EnvLocks(dbB) }, whB, security, {
      bus: busB,
      ha: haB,
    });

    try {
      await busA.start();
      await busB.start();

      const approver = await makeUser(dbA, 'approver', { name: '审批人' });
      await dbA.query("insert into groups (id, slug, name) values ('g-sse', 'g-sse', '通知组')");
      await dbA.query("insert into group_members (group_id, user_id, role) values ('g-sse', $1, 'admin')", [
        approver.id,
      ]);
      await dbA.query(
        "insert into projects (id, name, group_id, slug) values ('p-sse', '通知项目', 'g-sse', 'p-sse')",
      );
      await dbA.query("insert into branches (id, project_id, name) values ('b-sse', 'p-sse', 'main')");
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production)
         values ('e-sse', 'p-sse', 'prod', $1, true)`,
        [encrypt('postgres://u:p@127.0.0.1:5432/x')],
      );
      await dbA.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
         values ('v-sse-1', 'p-sse', 'b-sse', 0, 'v1', $1::text::jsonb, 1, '[]'::jsonb, '[]'::jsonb, 'sum1')`,
        [JSON.stringify(emptyModel())],
      );
      await dbA.query(
        `insert into exec_requests
           (id, project_id, environment_id, requested_by, direction, to_version_id, migrations, flow, conn_hash, production, status, expires_at)
         values ('r-sse-1', 'p-sse', 'e-sse', $1, 'up', 'v-sse-1', '[]'::jsonb, $2::text::jsonb, 'h', true, 'pending', $3)`,
        [approver.id, JSON.stringify({ implicit: true, stages: [] }), new Date(Date.now() + 3600_000)],
      );

      // 用户订阅副本 B 的收件箱 SSE
      const eventsB: InboxEvent[] = [];
      const unsub = requestsB.subscribe(approver.id, (e) => {
        eventsB.push(e);
      });

      try {
        // 副本 A 写入一条收件箱通知并提交副作用
        const [reqRow] = await dbA.query<RequestRow>("select * from exec_requests where id = 'r-sse-1'");
        const scope = (await requestsA.scopeOf(dbA, reqRow!))!;
        const fx = new Effects();
        await dbA.transaction(async (tx) => {
          await requestsA.notify(tx, [approver.id], 'approval_needed', reqRow!, scope, fx, {
            event: 'needs',
            action: 'approve',
            actor: '开发者',
            stage: 0,
          });
          fx.requestsChanged = true;
        });
        await requestsA.flushEffects(fx);

        // 副本 B 的 SSE 订阅者实时收到未读数 1 和申请列表变更通知
        await waitFor(() => eventsB.some((e) => e.unread === 1));
        expect(eventsB.some((e) => e.unread === 1)).toBe(true);
        await waitFor(() => eventsB.some((e) => e.requests === true));

        // 副本 A 标已读并广播未读数归零 → 副本 B 订阅者实时收到 unread: 0
        await dbA.query('update inbox_items set read_at = now() where user_id = $1', [approver.id]);
        await requestsA.publishUnread(approver.id, 0);
        await waitFor(() => eventsB.some((e) => e.unread === 0));
        expect(eventsB.some((e) => e.unread === 0)).toBe(true);
      } finally {
        unsub();
      }
    } finally {
      requestsA.stop();
      requestsB.stop();
      await whA.close();
      await whB.close();
      await busA.close();
      await busB.close();
      await dbA.close();
      await dbB.close();
    }
  });

  test('4. 分布式巡检互斥（DriftScheduler）与影子库派生防重（OpaqueRefresher）', async () => {
    const platform = await createTestDb('ha_drift');
    const target = await createTestDb('ha_drift_tgt');
    closers.push(platform.close, target.close);

    const dbA = await openPlatformDb(platform.url);
    const dbB = await openPlatformDb(platform.url);
    const haA = new HaCoordinator(dbA, { replicaId: 'drift-node-a' });
    const haB = new HaCoordinator(dbB, { replicaId: 'drift-node-b' });

    try {
      // 准备一个有版本的项目与真实目标库环境，使 checkEnvDrift 会真正执行扫描
      await dbA.query("insert into groups (id, slug, name) values ('g-dr', 'g-dr', '漂移组')");
      await dbA.query(
        "insert into projects (id, name, group_id, slug) values ('p-dr', '漂移项目', 'g-dr', 'p-dr')",
      );
      await dbA.query("insert into branches (id, project_id, name) values ('b-dr', 'p-dr', 'main')");
      await dbA.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
         values ('v-dr-1', 'p-dr', 'b-dr', 0, 'v1', $1::text::jsonb, 1, '[]'::jsonb, '[]'::jsonb, 'sum-dr')`,
        [JSON.stringify(emptyModel())],
      );
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production)
         values ('e-dr', 'p-dr', 'dev', $1, false)`,
        [encrypt(target.url)],
      );

      let enteredA!: () => void;
      const inSweepA = new Promise<void>((r) => {
        enteredA = r;
      });
      let releaseA!: () => void;
      const holdSweepA = new Promise<void>((r) => {
        releaseA = r;
      });

      let scansA = 0;
      let scansB = 0;
      const execA: ExecContext = {
        db: dbA,
        guard: async () => {
          scansA++;
          enteredA();
          await holdSweepA;
        },
        locks: new EnvLocks(dbA),
      };
      const execB: ExecContext = {
        db: dbB,
        guard: async () => {
          scansB++;
        },
        locks: new EnvLocks(dbB),
      };

      const driftA = new DriftScheduler(dbA, execA, haA);
      const driftB = new DriftScheduler(dbB, execB, haB);

      let afterA = 0;
      let afterB = 0;
      driftA.afterSweep = () => {
        afterA++;
      };
      driftB.afterSweep = () => {
        afterB++;
      };

      // 副本 A 先进入漂移扫描（持有 PG advisory lock job:drift.sweep）
      const runA = driftA.runOnce();
      await inSweepA;

      // 副本 B 并发调用 runOnce()：拿不到分布式锁，直接跳过返回 0，不触发扫描和 afterSweep
      const countB = await driftB.runOnce();
      expect(countB).toBe(0);
      expect(scansB).toBe(0);
      expect(afterB).toBe(0);

      // 放行副本 A 完成扫描
      releaseA();
      const countA = await runA;
      expect(countA).toBe(1);
      expect(scansA).toBe(1);
      expect(afterA).toBe(1);

      // 副本 A 释放锁后，副本 B 再次调用 runOnce() 可以正常拿到锁并执行扫描
      expect(await driftB.runOnce()).toBe(1);
      expect(scansB).toBe(1);
      expect(afterB).toBe(1);

      // 验证 OpaqueRefresher 的分布式锁与跨副本 flush：
      // 副本 A 持锁跑 canonicalize 期间，副本 B 的 flush 会阻塞等待直至副本 A 写回并更新基线，且不重复调用 canonicalize
      const live: Model = emptyModel();
      runMutator(live, 'createSchema', { id: 's1', name: 'public' });
      runMutator(live, 'createTable', { id: 't1', schema: 's1', name: 'items' });
      runMutator(live, 'addColumn', { table: 't1', column: { id: 'c1', name: 'n', type: 'integer' } });
      runMutator(live, 'addCheck', { id: 'k1', table: 't1', expr: 'n > 0' });

      let liveSeq = 1;
      const fakeRooms = {
        state: async () => ({ model: structuredClone(live), versions: {}, seq: liveSeq }),
        patch: async (_b: string, _u: string, objects: Obj[]) => {
          for (const o of objects) live.objects[o.id] = o;
          liveSeq++;
          return { committed: true, rejected: false, seq: liveSeq };
        },
      } as unknown as Rooms;
      let savedBaseline: Model | null = emptyModel();
      const store = {
        load: async () => (savedBaseline ? structuredClone(savedBaseline) : null),
        save: async (_b: string, m: Model) => {
          savedBaseline = structuredClone(m);
        },
      };

      let canonEnteredA!: () => void;
      const inCanonA = new Promise<void>((r) => {
        canonEnteredA = r;
      });
      let canonReleaseA!: () => void;
      const holdCanonA = new Promise<void>((r) => {
        canonReleaseA = r;
      });
      let canonCountA = 0;
      let canonCountB = 0;

      const canonicalizeChecks = (next: Model): Obj[] =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj);

      const shadowA = {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          canonCountA++;
          canonEnteredA();
          await holdCanonA;
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow;
      const shadowB = {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          canonCountB++;
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow;

      const refA = new OpaqueRefresher(fakeRooms, async () => shadowA, store, haA);
      const refB = new OpaqueRefresher(fakeRooms, async () => shadowB, store, haB);
      refA.delayMs = 1;
      refB.delayMs = 1;

      try {
        refA.schedule('branch-ha-1');
        const flushA = refA.flush('branch-ha-1');
        await inCanonA;

        // 副本 B 在副本 A 持有 derive:branch-ha-1 锁期间 flush：必须阻塞等待，绝不 0ms 空返回
        let flushBDone = false;
        const flushB = refB.flush('branch-ha-1').then(() => {
          flushBDone = true;
        });
        await new Promise((r) => setTimeout(r, 80));
        expect(flushBDone).toBe(false);
        expect(canonCountB).toBe(0);

        canonReleaseA();
        await Promise.all([flushA, flushB]);
        expect(flushBDone).toBe(true);
        expect(canonCountA).toBe(1);
        expect(canonCountB).toBe(0);
        expect((live.objects.k1 as { expr: string }).expr).toBe('(n > 0::integer)');
      } finally {
        refA.stop();
        refB.stop();
      }
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  /** 构造真实 PG 双副本房间 + 持久化 branches.baseline + OpaqueRefresher 测试夹具 */
  const setupRefresherCluster = async (
    tag: string,
    makeShadows: () => { shadowA: Shadow; shadowB: Shadow },
  ) => {
    const t = await createTestDb(tag);
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const busA = new EventBus(dbA, { replicaId: `${tag}-a` });
    const busB = new EventBus(dbB, { replicaId: `${tag}-b` });
    const haA = new HaCoordinator(dbA, { replicaId: `${tag}-a` });
    const haB = new HaCoordinator(dbB, { replicaId: `${tag}-b` });
    await busA.start();
    await busB.start();

    const user = await makeUser(dbA, `${tag}_editor`, { name: '编辑者' });
    const groupId = `g-${tag}`;
    const projectId = `p-${tag}`;
    const branchId = `b-${tag}`;
    await dbA.query('insert into groups (id, slug, name) values ($1, $1, $2)', [groupId, tag]);
    await dbA.query('insert into projects (id, name, group_id, slug) values ($1, $2, $3, $1)', [
      projectId,
      tag,
      groupId,
    ]);

    const initial = emptyModel();
    runMutator(initial, 'createSchema', { id: 's1', name: 'public' });
    runMutator(initial, 'createTable', { id: 't1', schema: 's1', name: 'orders' });
    runMutator(initial, 'addColumn', { table: 't1', column: { id: 'c1', name: 'n', type: 'integer' } });

    await dbA.query(
      "insert into branches (id, project_id, name, baseline) values ($1, $2, 'main', $3::text::jsonb)",
      [branchId, projectId, JSON.stringify(initial)],
    );

    const resolveRole = async () => 'admin' as const;
    const roomsA = new Rooms(dbA, resolveRole, busA);
    const roomsB = new Rooms(dbB, resolveRole, busB);
    await roomsA.init(branchId, initial);

    const storeOf = (db: PlatformDb) => ({
      load: async (b: string) =>
        (await db.query<{ baseline: Model | null }>('select baseline from branches where id = $1', [b]))[0]
          ?.baseline ?? null,
      save: async (b: string, m: Model) => {
        await db.query('update branches set baseline = $2::text::jsonb where id = $1', [
          b,
          JSON.stringify(m),
        ]);
      },
    });

    const { shadowA, shadowB } = makeShadows();
    const refA = new OpaqueRefresher(roomsA, async () => shadowA, storeOf(dbA), haA);
    const refB = new OpaqueRefresher(roomsB, async () => shadowB, storeOf(dbB), haB);
    roomsA.onCommit = (b) => refA.schedule(b);
    roomsB.onCommit = (b) => refB.schedule(b);

    const peerA: Peer = { user, role: 'admin', send: () => {} };
    const peerB: Peer = { user, role: 'admin', send: () => {} };
    await roomsA.join(branchId, peerA);
    await roomsA.message(branchId, peerA, { t: 'hello', client: 'cli-a', lastSeq: 0 });
    await roomsB.join(branchId, peerB);
    await roomsB.message(branchId, peerB, { t: 'hello', client: 'cli-b', lastSeq: 0 });

    let nA = 0;
    let nB = 0;
    const addCheckOnA = (id: string, expr: string) =>
      roomsA.message(branchId, peerA, {
        t: 'op',
        op: { client: 'cli-a', n: ++nA, name: 'addCheck', args: { id, table: 't1', expr }, reads: [] },
      });
    const addCheckOnB = (id: string, expr: string) =>
      roomsB.message(branchId, peerB, {
        t: 'op',
        op: { client: 'cli-b', n: ++nB, name: 'addCheck', args: { id, table: 't1', expr }, reads: [] },
      });

    const readBaseline = async (db: PlatformDb = dbA) =>
      (
        await db.query<{ baseline: Model | null }>('select baseline from branches where id = $1', [branchId])
      )[0]?.baseline ?? null;

    const close = async () => {
      await refA.drain();
      await refB.drain();
      roomsA.close();
      roomsB.close();
      await busA.close();
      await busB.close();
      await dbA.close();
      await dbB.close();
    };

    return {
      branchId,
      initial,
      dbA,
      dbB,
      roomsA,
      roomsB,
      refA,
      refB,
      addCheckOnA,
      addCheckOnB,
      readBaseline,
      close,
    };
  };

  const canonicalizeChecks = (next: Model): Obj[] =>
    Object.values(next.objects)
      .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
      .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr}::integer)` }) as Obj);

  test('5. 跨副本 OpaqueRefresher.flush：副本 A 防抖未触发或正在 canonicalize 期间，副本 B flush 阻塞等待/接手并看到规范化模型', async () => {
    let canonCountA = 0;
    let canonCountB = 0;
    let gateA: { entered: () => void; hold: Promise<void> } | null = null;

    const cluster = await setupRefresherCluster('ha_flush', () => ({
      shadowA: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          canonCountA++;
          if (gateA) {
            gateA.entered();
            await gateA.hold;
          }
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow,
      shadowB: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          canonCountB++;
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow,
    }));

    try {
      const { branchId, roomsB, refA, refB, addCheckOnA } = cluster;

      // (a) 副本 A 提交后尚在长防抖期（未触发 canonicalize），副本 B 内存无 timer/running 立即 flush → 接手完成规范化
      refA.delayMs = 60_000;
      refB.delayMs = 60_000;
      await addCheckOnA('k1', 'n > 0');

      await refB.flush(branchId);
      const afterB1 = (await roomsB.model(branchId)).model;
      expect((afterB1.objects.k1 as { expr: string }).expr).toBe('(n > 0::integer)');
      expect(canonCountB).toBe(1);
      expect(canonCountA).toBe(0);

      // 随后在副本 A 上 flush：基线已由副本 B 写齐，副本 A 无需再调影子库
      await refA.flush(branchId);
      expect(canonCountA).toBe(0);

      // (b) 副本 A 正在 canonicalize 持锁期间，副本 B 调用 flush → 必须阻塞等待副本 A 写回后再返回
      let enteredA!: () => void;
      const inCanonA = new Promise<void>((r) => {
        enteredA = r;
      });
      let releaseA!: () => void;
      const holdA = new Promise<void>((r) => {
        releaseA = r;
      });
      gateA = { entered: enteredA, hold: holdA };

      refA.delayMs = 5;
      await addCheckOnA('k2', 'n > 1');
      await inCanonA;

      let flushBDone = false;
      const flushB = refB.flush(branchId).then(() => {
        flushBDone = true;
      });
      await new Promise((r) => setTimeout(r, 80));
      expect(flushBDone).toBe(false);

      releaseA();
      await flushB;
      expect(flushBDone).toBe(true);
      const afterB2 = (await roomsB.model(branchId)).model;
      expect((afterB2.objects.k2 as { expr: string }).expr).toBe('(n > 1::integer)');
      expect(canonCountA).toBe(1);
      // 副本 B 等待副本 A 完成后看到基线已追齐，不重复调用 shadowB.canonicalize
      expect(canonCountB).toBe(1);
    } finally {
      await cluster.close();
    }
  });

  test('6. 跨副本并发提交无漏刷：副本 A 规范化 seq=1 期间副本 B 提交 seq=2，两项最终均规范化', async () => {
    let enteredFirst!: () => void;
    const inFirstCanon = new Promise<void>((r) => {
      enteredFirst = r;
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((r) => {
      releaseFirst = r;
    });
    let firstHeld = false;

    const cluster = await setupRefresherCluster('ha_concurrent', () => ({
      shadowA: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          if (!firstHeld) {
            firstHeld = true;
            enteredFirst();
            await holdFirst;
          }
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow,
      shadowB: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => canonicalizeChecks(next),
      } as unknown as Shadow,
    }));

    try {
      const { branchId, roomsA, roomsB, refA, refB, addCheckOnA, addCheckOnB } = cluster;
      refA.delayMs = 5;
      refB.delayMs = 5;

      // 副本 A 提交 seq=1（k1），进入 shadowA.canonicalize 持锁阻塞
      await addCheckOnA('k1', 'n > 0');
      await inFirstCanon;

      // 持锁期间副本 B 提交 seq=2（k2），并让副本 B 的后台防抖在锁被占用期间触发（验证不会静默丢弃）
      await addCheckOnB('k2', 'n > 10');
      await new Promise((r) => setTimeout(r, 40));

      // 放行副本 A 后，无需再手动 flush，后台追齐/重排必须自动完成两项规范化
      releaseFirst();
      await waitFor(async () => {
        const m = (await roomsB.model(branchId)).model;
        return (
          (m.objects.k1 as { expr: string } | undefined)?.expr === '(n > 0::integer)' &&
          (m.objects.k2 as { expr: string } | undefined)?.expr === '(n > 10::integer)'
        );
      });

      const finalA = (await roomsA.model(branchId)).model;
      const finalB = (await roomsB.model(branchId)).model;
      expect((finalA.objects.k1 as { expr: string }).expr).toBe('(n > 0::integer)');
      expect((finalA.objects.k2 as { expr: string }).expr).toBe('(n > 10::integer)');
      expect((finalB.objects.k1 as { expr: string }).expr).toBe('(n > 0::integer)');
      expect((finalB.objects.k2 as { expr: string }).expr).toBe('(n > 10::integer)');
    } finally {
      await cluster.close();
    }
  });

  test('7. 跨副本 replace/reset 基线保护：旧 canonicalize 绝不覆盖新基线，且 replace 后并发新提交不污染基线', async () => {
    let enteredOld!: () => void;
    const inOldCanon = new Promise<void>((r) => {
      enteredOld = r;
    });
    let releaseOld!: () => void;
    const holdOld = new Promise<void>((r) => {
      releaseOld = r;
    });
    let holdOnce = true;

    const cluster = await setupRefresherCluster('ha_replace', () => ({
      shadowA: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => {
          if (holdOnce) {
            holdOnce = false;
            enteredOld();
            await holdOld;
          }
          return canonicalizeChecks(next);
        },
      } as unknown as Shadow,
      shadowB: {
        canonicalize: async (_prev: Model, next: Model): Promise<Obj[]> => canonicalizeChecks(next),
      } as unknown as Shadow,
    }));

    try {
      const { branchId, initial, roomsA, roomsB, refA, refB, addCheckOnA, readBaseline } = cluster;
      refA.delayMs = 5;
      refB.delayMs = 5;

      // (a) 副本 A 正在 canonicalize 旧模型（含 k_old）期间，副本 B 执行 ctx.replace（runWithReset + rooms.replace）
      await addCheckOnA('k_old', 'n > 0');
      await inOldCanon;

      const restored = structuredClone(initial);
      runMutator(restored, 'addColumn', {
        table: 't1',
        column: { id: 'c_restored', name: 'restored_col', type: 'text' },
      });

      let replaceDone = false;
      const replacePromise = refB
        .runWithReset(branchId, restored, () =>
          roomsB.replace(branchId, '管理员', restored, 'restoreHistory'),
        )
        .then(() => {
          replaceDone = true;
        });

      // 副本 A 仍持锁期间，副本 B 的 replace 必须等待，防止旧 canonicalize 在之后覆盖新基线
      await new Promise((r) => setTimeout(r, 80));
      expect(replaceDone).toBe(false);

      releaseOld();
      await replacePromise;
      await refA.flush(branchId);

      expect(replaceDone).toBe(true);
      expect((await roomsA.model(branchId)).model).toEqual(restored);
      expect((await roomsB.model(branchId)).model).toEqual(restored);
      expect(await readBaseline()).toEqual(restored);

      // (b) replace 刚写完房间、尚未写 branches.baseline 的窗口内，副本 A 并发提交未规范化表达式 → 绝不污染基线
      refA.delayMs = 60_000;
      refB.delayMs = 60_000;
      const imported = structuredClone(initial);
      runMutator(imported, 'addColumn', {
        table: 't1',
        column: { id: 'c_imp', name: 'imported_col', type: 'text' },
      });

      await refB.runWithReset(branchId, imported, async () => {
        await roomsB.replace(branchId, '管理员', imported, 'importSql');
        // 模拟 rooms.replace 返回后、setGood 尚未写入基线之前的并发用户提交
        await addCheckOnA('k_conc', 'n > 99');
      });

      // branches.baseline 严格等于 imported，不含并发提交 k_conc
      const baselineAfterReplace = await readBaseline();
      expect(baselineAfterReplace).toEqual(imported);
      expect(baselineAfterReplace!.objects.k_conc).toBeUndefined();

      // 后续 flush 必须能识别并规范化 k_conc（证明没有因为基线污染而被永久跳过）
      await refB.flush(branchId);
      const afterFlush = (await roomsB.model(branchId)).model;
      expect((afterFlush.objects.k_conc as { expr: string }).expr).toBe('(n > 99::integer)');
    } finally {
      await cluster.close();
    }
  });

  test('8. 全量巡检保留 interrupted 申请不被二次改写为 invalid/expired，且原副本心跳恢复后 finish() 兜底仍生效（#18）', async () => {
    const t = await createTestDb('ha_interrupted_preserve');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const haA = new HaCoordinator(dbA, { replicaId: 'int-node-a', ttlMs: 5000, heartbeatIntervalMs: 1000 });
    const haB = new HaCoordinator(dbB, { replicaId: 'int-node-b', ttlMs: 5000, heartbeatIntervalMs: 1000 });
    const busA = new EventBus(dbA, { replicaId: 'int-node-a' });
    const busB = new EventBus(dbB, { replicaId: 'int-node-b' });
    const whA = new Webhooks(dbA, { bus: busA, ha: haA });
    const whB = new Webhooks(dbB, { bus: busB, ha: haB });
    const security = securityConfigFromEnv();
    const guard = async () => {};
    const requestsA = new Requests(dbA, { db: dbA, guard, locks: new EnvLocks(dbA) }, whA, security, {
      bus: busA,
      ha: haA,
    });
    const requestsB = new Requests(dbB, { db: dbB, guard, locks: new EnvLocks(dbB) }, whB, security, {
      bus: busB,
      ha: haB,
    });

    const hooksB: { type: string; requestId: unknown; status: unknown }[] = [];
    const origEmitB = whB.emit.bind(whB);
    whB.emit = (gid, event) => {
      hooksB.push({ type: event.type, requestId: event.data.requestId, status: event.data.status });
      origEmitB(gid, event);
    };

    try {
      await haA.start();
      await haB.start();
      await busA.start();
      await busB.start();

      const requester = await makeUser(dbA, 'int_dev', { name: '开发者' });
      await dbA.query("insert into groups (id, slug, name) values ('g-int', 'g-int', '中断组')");
      await dbA.query("insert into group_members (group_id, user_id, role) values ('g-int', $1, 'admin')", [
        requester.id,
      ]);
      await dbA.query(
        "insert into projects (id, name, group_id, slug) values ('p-int', '中断项目', 'g-int', 'p-int')",
      );
      await dbA.query("insert into branches (id, project_id, name) values ('b-int', 'p-int', 'main')");
      const envUrlEnc = encrypt('postgres://u:p@127.0.0.1:5432/x');
      await dbA.query(
        `insert into environments (id, project_id, name, url_enc, production)
         values ('e-int', 'p-int', 'prod', $1, true)`,
        [envUrlEnc],
      );
      for (const [vid, seq, num] of [
        ['v-int-1', 0, 1],
        ['v-int-2', 1, 2],
      ] as const) {
        await dbA.query(
          `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
           values ($1, 'p-int', 'b-int', $2, $3, $4::text::jsonb, $5, '[]'::jsonb, '[]'::jsonb, $6)`,
          [vid, seq, `v${num}`, JSON.stringify(emptyModel()), num, `sum-${num}`],
        );
      }

      const envConnHash = connHash({ url_enc: envUrlEnc });
      const insertReq = async (
        id: string,
        opts: { status: string; workerId: string | null; expiresAt: Date; result?: unknown },
      ) => {
        await dbA.query(
          `insert into exec_requests
             (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
              migrations, flow, conn_hash, production, status, expires_at, updated_at, worker_id, result)
           values ($1, 'p-int', 'e-int', $2, 'up', null, 'v-int-2',
                   '[]'::jsonb, $3::text::jsonb, $4, true, $5, $6, $7, $8, $9::text::jsonb)`,
          [
            id,
            requester.id,
            JSON.stringify({ implicit: true, stages: [] }),
            envConnHash,
            opts.status,
            opts.expiresAt,
            new Date(),
            opts.workerId,
            opts.result ? JSON.stringify(opts.result) : null,
          ],
        );
      };

      // 场景 1：多步迁移中途副本 A 已推进 environments.current_version_id = v1 后租约离线
      await insertReq('req-int-env', {
        status: 'executing',
        workerId: requestsA.workerId!,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await dbA.query("update environments set current_version_id = 'v-int-1' where id = 'e-int'");
      // 同时放一条普通 failed（非 interrupted）申请，确认 PG 下 sweepWhere 只跳过 interrupted、不漏扫普通 failed
      await insertReq('req-normal-failed', {
        status: 'failed',
        workerId: null,
        expiresAt: new Date(Date.now() + 3600_000),
        result: { ok: false, code: 'internal', error: '普通失败', current: null },
      });

      // 副本 A 心跳租约失效 → 副本 B 跑全量 sweep（runSweep({ all: true })）
      await haA.stop();
      // 1 条 recoverInterrupted（req-int-env）+ 1 条普通失败转为 invalid（req-normal-failed）
      expect(await requestsB.sweep()).toBe(2);

      const [envRow] = await dbB.query<RequestRow>("select * from exec_requests where id = 'req-int-env'");
      expect(envRow!.status).toBe('failed');
      expect(envRow!.result).toMatchObject({ ok: false, code: INTERRUPTED });
      expect(envRow!.status_reason).toContain('结果未知');

      const [normalRow] = await dbB.query<{ status: string }>(
        "select status from exec_requests where id = 'req-normal-failed'",
      );
      expect(normalRow!.status).toBe('invalid');

      // req-int-env 仅发 1 条执行失败通知与 1 条 request.executed Webhook（无 request.invalidated）
      const envInbox = await dbB.query<{ data: { event: string; status?: string } }>(
        "select data from inbox_items where request_id = 'req-int-env' and user_id = $1",
        [requester.id],
      );
      expect(envInbox).toHaveLength(1);
      expect(envInbox[0]!.data).toMatchObject({ event: 'failed', status: 'failed' });
      expect(hooksB.filter((h) => h.requestId === 'req-int-env').map((h) => h.type)).toEqual([
        'request.executed',
      ]);

      // 再次 sweep / recheck 不改写，且 actionsFor 拒绝直接重试
      expect(await requestsB.sweep()).toBe(0);
      await requestsB.recheck('req-int-env');
      const [afterRecheck] = await dbB.query<RequestRow>(
        "select * from exec_requests where id = 'req-int-env'",
      );
      expect(afterRecheck!.status).toBe('failed');
      expect(afterRecheck!.result).toMatchObject({ ok: false, code: INTERRUPTED });
      const scope = (await requestsB.scopeOf(dbB, afterRecheck!))!;
      const actions = requestsB.actionsFor(
        afterRecheck!,
        {
          userId: requester.id,
          instanceAdmin: false,
          groups: new Map([['g-int', 'admin']]),
          grants: [],
        },
        requestsB.stageScope(scope, afterRecheck!),
        [],
      );
      expect(actions).toMatchObject({ execute: false, withdraw: false });

      // 副本 A 心跳短暂超时恢复后调用 finish()：仍能成功覆盖回写为 executed 终态
      await requestsA.finish(
        null,
        'req-int-env',
        { id: requester.id, name: '开发者' },
        { ok: true, current: { id: 'v-int-2', number: 2, name: 'v2' }, error: null },
      );
      const [finishedEnv] = await dbB.query<RequestRow>(
        "select * from exec_requests where id = 'req-int-env'",
      );
      expect(finishedEnv!.status).toBe('executed');
      expect(finishedEnv!.result).toMatchObject({ ok: true, current: { number: 2 } });

      // 等待 finish() 触发的按环境 kick 巡检在双副本排空，避免占用分布式锁干扰下一场景的 sweep
      await new Promise((r) => setTimeout(r, 30));
      await requestsA.drain();
      await requestsB.drain();

      // 场景 2：执行期间跨过 expires_at 后节点离线 → sweep 与 recheck 保持 failed/interrupted，且 finish() 仍生效
      await dbA.query(
        "insert into ha_leases (key, owner, expires_at) values ('node:expired-exec-node', 'expired-exec-node', $1)",
        [new Date(Date.now() - 5000)],
      );
      await insertReq('req-int-exp', {
        status: 'executing',
        workerId: 'expired-exec-node',
        expiresAt: new Date(Date.now() - 60_000),
      });

      expect(await requestsB.sweep()).toBe(1);
      await requestsB.recheck('req-int-exp');
      const [expRow] = await dbB.query<RequestRow>("select * from exec_requests where id = 'req-int-exp'");
      expect(expRow!.status).toBe('failed');
      expect(expRow!.result).toMatchObject({ ok: false, code: INTERRUPTED });

      const expInbox = await dbB.query<{ data: { event: string; status?: string } }>(
        "select data from inbox_items where request_id = 'req-int-exp' and user_id = $1",
        [requester.id],
      );
      expect(expInbox).toHaveLength(1);
      expect(expInbox[0]!.data).toMatchObject({ event: 'failed', status: 'failed' });
      expect(hooksB.filter((h) => h.requestId === 'req-int-exp').map((h) => h.type)).toEqual([
        'request.executed',
      ]);

      await requestsA.finish(
        null,
        'req-int-exp',
        { id: requester.id, name: '开发者' },
        { ok: true, current: { id: 'v-int-2', number: 2, name: 'v2' }, error: null },
      );
      const [finishedExp] = await dbB.query<RequestRow>(
        "select * from exec_requests where id = 'req-int-exp'",
      );
      expect(finishedExp!.status).toBe('executed');
      expect(finishedExp!.result).toMatchObject({ ok: true, current: { number: 2 } });
    } finally {
      whB.emit = origEmitB;
      requestsA.stop();
      requestsB.stop();
      await requestsA.drain();
      await requestsB.drain();
      await whA.close();
      await whB.close();
      await busA.close();
      await busB.close();
      await haA.stop();
      await haB.stop();
      await dbA.close();
      await dbB.close();
    }
  });
});
