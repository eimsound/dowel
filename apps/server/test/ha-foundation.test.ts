// P7 HA Wave 1 底座测试（ADR 0011）：
// 覆盖 SQLite + 真实 PG：迁移 23、PG LISTEN/NOTIFY 跨连接事件总线与断线重连、
// withAdvisoryLock 跨连接互斥与超时、HaCoordinator 心跳续租与停机释放、
// 跨副本 EnvLocks 互斥、多副本共享 setupToken 与并发 autoSetup 幂等。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import { type ClusterEvent, EventBus } from '../src/bus.ts';
import { MIGRATE_LOCK_KEY, MIGRATIONS, openPlatformDb, type PlatformDb } from '../src/db.ts';
import { EnvBusyError, EnvLocks, lockEnvIdle } from '../src/executions.ts';
import { HaCoordinator } from '../src/ha.ts';
import { encrypt } from '../src/secrets.ts';
import { autoSetup, ensureSetupToken, SETUP_TOKEN_KEY } from '../src/setup.ts';
import { makeUser, PASSWORD } from './support.ts';

const waitFor = async (predicate: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const callJson = async (
  app: ReturnType<typeof createApp>['app'],
  method: string,
  path: string,
  json?: unknown,
  cookie = '',
) => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data: data as Record<string, unknown>,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

// ───── 1. 迁移 23 ─────

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('迁移 23：HA 底座表与列（$platform）', ({ platform, skip }) => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test.skipIf(skip)(
    '从 v22 升到 v23：建 webhook_jobs / ha_leases 并给 exec_requests 加 worker_id',
    async () => {
      let url: string;
      if (platform === 'sqlite') {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-m23-'));
        dirs.push(dir);
        url = join(dir, 'm23.db');
      } else {
        const t = await createTestDb('ha_m23');
        closers.push(t.close);
        url = t.url;
      }

      // 先升到最新，再退回迁移 23 模拟 v22 库
      const base = await openPlatformDb(url);
      try {
        await base.exec('drop table ha_leases');
        await base.exec('drop table webhook_jobs');
        await base.exec('alter table exec_requests drop column worker_id');
        await base.query('delete from dowel_migrations where version >= $1', [MIGRATIONS.length]);
      } finally {
        await base.close();
      }

      const db = await openPlatformDb(url);
      try {
        const [ver] = await db.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);
        expect(MIGRATIONS.length).toBeGreaterThanOrEqual(23);

        // webhook_jobs：写入 JSON payload 并在 SQLite / PG 都读出为对象，删除 webhook 时级联清理
        await db.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
        await db.query(
          `insert into webhooks (id, group_id, name, format, url_enc, events)
         values ('w1', 'g1', 'hook', 'json', 'enc', $1::text::jsonb)`,
          [JSON.stringify(['request.created'])],
        );
        await db.query(
          `insert into webhook_jobs (id, webhook_id, delivery_id, event_type, payload)
         values ('j1', 'w1', 'd1', 'request.created', $1::text::jsonb)`,
          [JSON.stringify({ requestId: 'r1', nested: { ok: true } })],
        );
        const [job] = await db.query<{
          id: string;
          payload: { requestId: string; nested: { ok: boolean } };
          attempts: number;
          max_retries: number;
        }>("select id, payload, attempts, max_retries from webhook_jobs where id = 'j1'");
        expect(job).toEqual({
          id: 'j1',
          payload: { requestId: 'r1', nested: { ok: true } },
          attempts: 0,
          max_retries: 3,
        });
        await db.query("delete from webhooks where id = 'w1'");
        expect(await db.query("select id from webhook_jobs where id = 'j1'")).toEqual([]);

        // ha_leases 读写正常
        await db.query(`insert into ha_leases (key, owner, expires_at) values ('node:n1', 'n1', $1)`, [
          new Date(Date.now() + 10_000),
        ]);
        expect(
          await db.query<{ key: string; owner: string }>(
            "select key, owner from ha_leases where key = 'node:n1'",
          ),
        ).toEqual([{ key: 'node:n1', owner: 'n1' }]);

        // exec_requests.worker_id 列存在且可读写
        await db.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
        await db.query(
          "insert into environments (id, project_id, name, url_enc, production) values ('e1', 'p1', 'dev', 'x', $1)",
          [false],
        );
        await db.query(
          `insert into exec_requests
           (id, project_id, environment_id, direction, to_version_id, migrations, flow, conn_hash, production, status, expires_at, worker_id)
         values ('req1', 'p1', 'e1', 'up', 'v1', $1::text::jsonb, $2::text::jsonb, 'hash', $3, 'executing', $4, 'replica-1')`,
          [
            JSON.stringify([]),
            JSON.stringify({ implicit: true, stages: [] }),
            false,
            new Date(Date.now() + 60_000),
          ],
        );
        expect(
          await db.query<{ worker_id: string | null }>(
            "select worker_id from exec_requests where id = 'req1'",
          ),
        ).toEqual([{ worker_id: 'replica-1' }]);
        // 迁移 23 验证完毕
      } finally {
        await db.close();
      }
    },
  );
});

describe.skipIf(!PG_URL)('openPlatformDb：多副本并发冷启动迁移锁与失败关闭连接池（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  const waitForAsync = async (predicate: () => Promise<boolean>, timeoutMs = 5_000, stepMs = 30) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`等待异步条件超时（${timeoutMs}ms）`);
      await new Promise((r) => setTimeout(r, stepMs));
    }
  };

  test('全新空 PG 库 4 副本并发 openPlatformDb 冷启动：全部成功且迁移版本一致无锁残留', async () => {
    const t = await createTestDb('ha_cold_start');
    closers.push(t.close);

    const dbs = await Promise.all([
      openPlatformDb(t.url),
      openPlatformDb(t.url),
      openPlatformDb(t.url),
      openPlatformDb(t.url),
    ]);

    try {
      expect(dbs).toHaveLength(4);
      const versions = await Promise.all(
        dbs.map(async (db) => {
          const [row] = await db.query<{ count: number; max: number }>(
            'select count(*)::int as count, max(version)::int as max from dowel_migrations',
          );
          return row!;
        }),
      );
      for (const v of versions) {
        expect(v).toEqual({ count: MIGRATIONS.length, max: MIGRATIONS.length });
      }

      // instance_id 唯一且所有副本读出一致
      const ids = await Promise.all(
        dbs.map(async (db) => {
          const rows = await db.query<{ value: string }>(
            "select value from instance_settings where key = 'instance_id'",
          );
          expect(rows).toHaveLength(1);
          return rows[0]!.value;
        }),
      );
      expect(new Set(ids).size).toBe(1);

      // 迁移完成后无残留 advisory lock
      const [locks] = await dbs[0]!.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())`,
      );
      expect(locks!.n).toBe(0);
    } finally {
      await Promise.all(dbs.map((db) => db.close()));
    }
  });

  test('迁移锁超时或迁移 DDL 抛错时 openPlatformDb 抛出明确错误并干净关闭连接池', async () => {
    // 1. 锁超时：另一副本长期持有 platform:migrate 锁，冷启动等待超时抛错且不泄漏连接
    const tTimeout = await createTestDb('ha_migrate_timeout');
    closers.push(tTimeout.close);
    const dbHolder = await openPlatformDb(tTimeout.url);

    const countConns = async (db: typeof tTimeout.db) => {
      const [row] = await db.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where datname = current_database()',
      );
      return row!.n;
    };
    const countAdvisoryLocks = async (db: typeof tTimeout.db) => {
      const [row] = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())`,
      );
      return row!.n;
    };

    try {
      let entered!: () => void;
      const inLock = new Promise<void>((r) => {
        entered = r;
      });
      let releaseHold!: () => void;
      const holding = new Promise<void>((r) => {
        releaseHold = r;
      });

      const holdTask = dbHolder.withAdvisoryLock(MIGRATE_LOCK_KEY, async () => {
        entered();
        await holding;
      });
      await inLock;

      const beforeConns = await countConns(tTimeout.db);
      const t0 = Date.now();
      await expect(openPlatformDb(tTimeout.url, { migrateLockTimeoutMs: 150 })).rejects.toThrow(
        /platform:migrate.*超时/,
      );
      expect(Date.now() - t0).toBeGreaterThanOrEqual(100);

      // 失败的 openPlatformDb 连接池（主池 + 锁池）均已关闭，会话数回落到调用前
      await waitForAsync(async () => (await countConns(tTimeout.db)) === beforeConns);

      releaseHold();
      expect(await holdTask).toEqual({ acquired: true, value: undefined });
    } finally {
      await dbHolder.close();
    }
    // dbHolder 也关闭后，仅剩 tTimeout.db 自身的 1 条测试连接，证明无任何泄漏连接
    await waitForAsync(async () => (await countConns(tTimeout.db)) === 1);
    expect(await countAdvisoryLocks(tTimeout.db)).toBe(0);

    // 2. 迁移 DDL 抛错：空库预先存在冲突表导致迁移 1 失败，抛错后连接池关闭且迁移锁释放
    const tFail = await createTestDb('ha_migrate_fail');
    closers.push(tFail.close);
    await tFail.db.exec('create table users (id text)');
    expect(await countConns(tFail.db)).toBe(1);

    await expect(openPlatformDb(tFail.url)).rejects.toThrow();

    // 主池和锁池均已干净关闭，且不残留 platform:migrate 锁
    await waitForAsync(async () => (await countConns(tFail.db)) === 1);
    expect(await countAdvisoryLocks(tFail.db)).toBe(0);
  });
});

describe('openPlatformDb：SQLite 迁移失败时释放连接句柄', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('迁移抛错时抛出错误并关闭 SQLite 连接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dowel-sqlite-fail-'));
    dirs.push(dir);
    const file = join(dir, 'conflict.db');
    const pre = new DatabaseSync(file);
    pre.exec('create table users (id text)');
    pre.close();

    await expect(openPlatformDb(file)).rejects.toThrow();

    // 原失败连接已关闭，可以重新独占打开并清理冲突表后正常初始化
    const fix = new DatabaseSync(file);
    fix.exec('drop table users');
    fix.close();

    const db = await openPlatformDb(file);
    try {
      const [ver] = await db.query<{ v: number }>('select max(version) as v from dowel_migrations');
      expect(ver!.v).toBe(MIGRATIONS.length);
    } finally {
      await db.close();
    }
  });
});

// ───── 2. withAdvisoryLock ─────

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('PlatformDb.withAdvisoryLock（$platform）', ({ platform, skip }) => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test.skipIf(skip)('互斥、tryOnly、超时等待、异常后自动释放且不同 key 互不阻塞', async () => {
    let dbA: PlatformDb;
    let dbB: PlatformDb;
    if (platform === 'sqlite') {
      dbA = await openPlatformDb(':memory:');
      dbB = dbA; // SQLite 为单进程单实例
    } else {
      const t = await createTestDb('ha_lock');
      closers.push(t.close);
      dbA = await openPlatformDb(t.url);
      dbB = await openPlatformDb(t.url);
    }

    try {
      let releaseHold!: () => void;
      const holding = new Promise<void>((r) => {
        releaseHold = r;
      });
      let entered!: () => void;
      const inLock = new Promise<void>((r) => {
        entered = r;
      });

      const first = dbA.withAdvisoryLock('test:k1', async () => {
        entered();
        await holding;
        return 'from-A';
      });
      await inLock;

      // tryOnly 立即返回未拿到锁
      expect(await dbB.withAdvisoryLock('test:k1', async () => 'nope', { tryOnly: true })).toEqual({
        acquired: false,
      });

      // 带短超时等待失败
      const t0 = Date.now();
      expect(await dbB.withAdvisoryLock('test:k1', async () => 'nope', { timeoutMs: 120 })).toEqual({
        acquired: false,
      });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(80);

      // 不同 key 互不阻塞
      expect(await dbB.withAdvisoryLock('test:k2', async () => 'other', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'other',
      });

      // 副本 B 等待拿锁，期间副本 A 释放后 B 成功拿到
      const second = dbB.withAdvisoryLock('test:k1', async () => 'from-B', { timeoutMs: 2000 });
      await new Promise((r) => setTimeout(r, 80));
      releaseHold();
      expect(await first).toEqual({ acquired: true, value: 'from-A' });
      expect(await second).toEqual({ acquired: true, value: 'from-B' });

      // 回调抛错时锁必须释放
      await expect(
        dbA.withAdvisoryLock('test:err', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await dbB.withAdvisoryLock('test:err', async () => 'recovered', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'recovered',
      });

      if (platform === 'pg') {
        const [locks] = await dbA.query<{ n: number }>(
          `select count(*)::int as n from pg_locks
           where locktype = 'advisory'
             and database = (select oid from pg_database where datname = current_database())`,
        );
        expect(locks!.n).toBe(0);
      }
    } finally {
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
    }
  });
});

describe.skipIf(!PG_URL)('PlatformDb.withAdvisoryLock：独立锁池、满载超时与解锁失败销毁（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('并发持有 12 个不同 key 锁时，锁内业务查询/事务与 HaCoordinator.renew() 均不死锁', async () => {
    const t = await createTestDb('ha_lock_pool_isolation');
    closers.push(t.close);
    const db = await openPlatformDb(t.url);
    const ha = new HaCoordinator(db, { replicaId: 'node-concurrent', ttlMs: 5_000 });
    const count = 12; // 超过主连接池默认 max=10

    try {
      let entered = 0;
      let allInLock!: () => void;
      const allEntered = new Promise<void>((r) => {
        allInLock = r;
      });
      let releaseAll!: () => void;
      const holdAll = new Promise<void>((r) => {
        releaseAll = r;
      });

      const tasks = Array.from({ length: count }, (_, i) =>
        db.withAdvisoryLock(`concurrent:key:${i}`, async () => {
          entered++;
          if (entered === count) allInLock();
          await holdAll;

          // 在全部 12 个锁同时被持有期间并发执行主池查询、事务与心跳续租
          const [ping] = await db.query<{ n: number }>('select $1::int as n', [i]);
          const txVal = await db.transaction(async (tx) => {
            const [r] = await tx.query<{ v: number }>('select $1::int + 100 as v', [i]);
            return r!.v;
          });
          await ha.renew();
          return { ping: ping!.n, txVal };
        }),
      );

      // 等所有 12 个锁都真正进入回调后再放行，确保同时持有 12 条锁连接
      await waitFor(() => entered === count, 10_000);
      await allEntered;
      // 在 12 个锁全部占用期间，外部直接调用 renew() 与查询也必须畅通
      await ha.renew();
      expect(await ha.isNodeAlive('node-concurrent')).toBe(true);

      releaseAll();
      const results = await Promise.all(tasks);
      for (let i = 0; i < count; i++) {
        expect(results[i]).toEqual({ acquired: true, value: { ping: i, txVal: i + 100 } });
      }

      const [locks] = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())`,
      );
      expect(locks!.n).toBe(0);
    } finally {
      await ha.stop();
      await db.close();
    }
  });

  test('锁池满载时 tryOnly 与短 timeoutMs 在时限内返回 acquired=false，释放后恢复正常加锁', async () => {
    const t = await createTestDb('ha_lock_pool_full');
    closers.push(t.close);
    const poolMax = 2;
    const db = await openPlatformDb(t.url, { advisoryLockPoolMax: poolMax });

    try {
      const releases: (() => void)[] = [];
      let entered = 0;
      const holders = Array.from({ length: poolMax }, (_, i) =>
        db.withAdvisoryLock(`full:hold:${i}`, async () => {
          entered++;
          await new Promise<void>((r) => {
            releases.push(r);
          });
          return i;
        }),
      );
      await waitFor(() => entered === poolMax, 5_000);

      // 锁池满载：tryOnly 与默认 timeoutMs=0 立即返回 { acquired: false }，不挂起
      const tTry = Date.now();
      expect(await db.withAdvisoryLock('full:extra:try', async () => 'nope', { tryOnly: true })).toEqual({
        acquired: false,
      });
      expect(Date.now() - tTry).toBeLessThan(500);

      const tZero = Date.now();
      expect(await db.withAdvisoryLock('full:extra:zero', async () => 'nope')).toEqual({
        acquired: false,
      });
      expect(Date.now() - tZero).toBeLessThan(500);

      // 锁池满载：带短 timeoutMs 在时限内返回 { acquired: false }，不会无限挂起
      const tShort = Date.now();
      expect(await db.withAdvisoryLock('full:extra:short', async () => 'nope', { timeoutMs: 120 })).toEqual({
        acquired: false,
      });
      const elapsed = Date.now() - tShort;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(1500);

      // 带较长超时的等待者在其中一个持有者释放槽位后立即拿到锁
      const waiting = db.withAdvisoryLock('full:extra:wait', async () => 'got-slot', { timeoutMs: 3_000 });
      await new Promise((r) => setTimeout(r, 60));
      releases[0]!();
      expect(await waiting).toEqual({ acquired: true, value: 'got-slot' });

      releases[1]!();
      expect(await Promise.all(holders)).toEqual([
        { acquired: true, value: 0 },
        { acquired: true, value: 1 },
      ]);

      // 池全部释放后恢复正常并发加锁
      expect(await db.withAdvisoryLock('full:after', async () => 'ok', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'ok',
      });
    } finally {
      await db.close();
    }
  });

  test('解锁返回非 true、解锁抛错或持锁连接被强杀时均销毁连接，绝不泄漏会话级 advisory lock', async () => {
    const t = await createTestDb('ha_lock_unlock_fail');
    closers.push(t.close);
    let mode: 'normal' | 'return-false' | 'throw' = 'normal';
    const dbA = await openPlatformDb(t.url, {
      advisoryLockPoolMax: 2,
      advisoryUnlock: async (conn, k1, k2) => {
        if (mode === 'return-false') return false;
        if (mode === 'throw') throw new Error('模拟 pg_advisory_unlock 异常');
        const rows = await conn.unsafe<{ ok: boolean }[]>(
          'select pg_advisory_unlock($1::int, $2::int) as ok',
          [k1, k2],
        );
        return rows[0]?.ok === true;
      },
    });
    const dbB = await openPlatformDb(t.url);

    const countAdvisoryLocks = async () => {
      const [row] = await dbB.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory'
           and database = (select oid from pg_database where datname = current_database())`,
      );
      return row!.n;
    };

    try {
      // 1. 模拟 pg_advisory_unlock 返回 false（会话仍存活且真实持有 PG advisory lock）
      mode = 'return-false';
      const r1 = await dbA.withAdvisoryLock('leak:false', async () => {
        expect(await countAdvisoryLocks()).toBe(1);
        return 'done-false';
      });
      expect(r1).toEqual({ acquired: true, value: 'done-false' });
      expect(await countAdvisoryLocks()).toBe(0);
      expect(await dbB.withAdvisoryLock('leak:false', async () => 'b-ok', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'b-ok',
      });

      // 2. 模拟 pg_advisory_unlock 抛错（会话仍存活且真实持有 PG advisory lock）
      mode = 'throw';
      const r2 = await dbA.withAdvisoryLock('leak:throw', async () => {
        expect(await countAdvisoryLocks()).toBe(1);
        return 'done-throw';
      });
      expect(r2).toEqual({ acquired: true, value: 'done-throw' });
      expect(await countAdvisoryLocks()).toBe(0);
      expect(await dbB.withAdvisoryLock('leak:throw', async () => 'b-ok-2', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'b-ok-2',
      });

      // 3. 真实 PG：持锁期间后端被外部 pg_terminate_backend 强杀，解锁收到断连错误后可正常恢复
      mode = 'normal';
      const r3 = await dbA.withAdvisoryLock('leak:killed', async () => {
        expect(await countAdvisoryLocks()).toBe(1);
        await dbB.query(
          `select pg_terminate_backend(pid)
           from pg_locks
           where locktype = 'advisory'
             and database = (select oid from pg_database where datname = current_database())`,
        );
        return 'done-killed';
      });
      expect(r3).toEqual({ acquired: true, value: 'done-killed' });
      expect(await countAdvisoryLocks()).toBe(0);

      // 销毁损坏连接后，dbA 自身连接池仍可打开新连接正常加锁与解锁
      expect(await dbA.withAdvisoryLock('leak:false', async () => 'a-recovered', { tryOnly: true })).toEqual({
        acquired: true,
        value: 'a-recovered',
      });
      expect(
        await dbA.withAdvisoryLock('leak:throw', async () => 'a-recovered-2', { tryOnly: true }),
      ).toEqual({
        acquired: true,
        value: 'a-recovered-2',
      });
      expect(await countAdvisoryLocks()).toBe(0);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });
});

// ───── 3. EventBus（SQLite + PG LISTEN/NOTIFY 跨连接与重连） ─────

describe('EventBus：SQLite 进程内回调', () => {
  test('start 后本地回环触发，localLoopback=false 时跳过自身，close 后停止分发', async () => {
    const db = await openPlatformDb(':memory:');
    try {
      const bus = new EventBus(db, { replicaId: 'local-1' });
      const got: ClusterEvent[] = [];
      bus.onEvent((e) => {
        got.push(e);
      });
      await bus.start();
      await bus.publish({ t: 'webhooks.wake' });
      await bus.publish({ t: 'room.commit', branchId: 'b1', seq: 3 });
      expect(got).toEqual([
        { t: 'webhooks.wake', origin: 'local-1' },
        { t: 'room.commit', origin: 'local-1', branchId: 'b1', seq: 3 },
      ]);
      await bus.close();
      await bus.publish({ t: 'webhooks.wake' });
      expect(got).toHaveLength(2);

      const noLoop = new EventBus(db, { replicaId: 'local-2', localLoopback: false });
      const got2: ClusterEvent[] = [];
      noLoop.onEvent((e) => {
        got2.push(e);
      });
      await noLoop.start();
      await noLoop.publish({ t: 'webhooks.wake' });
      expect(got2).toEqual([]);
      await noLoop.close();
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('EventBus：真实 PG LISTEN/NOTIFY 跨连接广播与断线重连', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('双连接跨副本收发事件、超长负载保护与断线自动重连触发 onReconnect', async () => {
    const t = await createTestDb('ha_bus');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    const busA = new EventBus(dbA, { replicaId: 'replica-a' });
    const busB = new EventBus(dbB, { replicaId: 'replica-b' });

    try {
      const receivedB: ClusterEvent[] = [];
      let reconnectCount = 0;
      busB.onEvent((e) => {
        receivedB.push(e);
      });
      busB.onReconnect(() => {
        reconnectCount++;
      });

      await busA.start();
      await busB.start();

      // 副本 A 发布多种轻量事件，副本 B 跨连接收到且带 origin = replica-a
      await busA.publish({ t: 'room.commit', branchId: 'b1', seq: 42 });
      await busA.publish({ t: 'inbox.changed', userIds: ['u1', 'u2'] });
      await busA.publish({ t: 'requests.kick', envIds: ['e1'] });
      await waitFor(() => receivedB.length >= 3);
      expect(receivedB.slice(0, 3)).toEqual([
        { t: 'room.commit', origin: 'replica-a', branchId: 'b1', seq: 42 },
        { t: 'inbox.changed', origin: 'replica-a', userIds: ['u1', 'u2'] },
        { t: 'requests.kick', origin: 'replica-a', envIds: ['e1'] },
      ]);

      // 超长 room.refresh 自动退化为全量刷新信号，且底层 db.notify > 7500 字节保护不会抛 54000 错误
      const hugeBranchIds = Array.from({ length: 600 }, (_, i) => `branch-${String(i).padStart(16, '0')}`);
      await busA.publish({ t: 'room.refresh', branchIds: hugeBranchIds });
      await waitFor(() => receivedB.length >= 4);
      expect(receivedB[3]).toEqual({ t: 'room.refresh', origin: 'replica-a' });
      await expect(dbA.notify('dowel_oversize_test', '中'.repeat(4000))).resolves.toBeUndefined();

      // 主动踢掉所有 LISTEN 连接，验证 postgres.js 自动重连后触发 onReconnect 且后续消息恢复接收
      await dbA.query(
        `select pg_terminate_backend(pid)
         from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and query ilike 'listen%'`,
      );
      await waitFor(() => reconnectCount >= 1, 10_000);
      expect(reconnectCount).toBeGreaterThanOrEqual(1);

      const before = receivedB.length;
      await busA.publish({ t: 'webhooks.wake' });
      await waitFor(() => receivedB.length > before);
      expect(receivedB[receivedB.length - 1]).toEqual({ t: 'webhooks.wake', origin: 'replica-a' });
    } finally {
      await busA.close();
      await busB.close();
      await dbA.close();
      await dbB.close();
    }
  });
});

// ───── 4. HaCoordinator 心跳续租、停机释放与分布式任务锁 ─────

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('HaCoordinator（$platform）', ({ platform, skip }) => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test.skipIf(skip)('心跳自动续租、优雅停机立即删除租约、过期节点不可见、tryWithJobLock 互斥', async () => {
    let dbA: PlatformDb;
    let dbB: PlatformDb;
    if (platform === 'sqlite') {
      dbA = await openPlatformDb(':memory:');
      dbB = dbA;
    } else {
      const t = await createTestDb('ha_coord');
      closers.push(t.close);
      dbA = await openPlatformDb(t.url);
      dbB = await openPlatformDb(t.url);
    }

    const haA = new HaCoordinator(dbA, { replicaId: 'node-a', ttlMs: 400, heartbeatIntervalMs: 120 });
    const haB = new HaCoordinator(dbB, { replicaId: 'node-b', ttlMs: 400, heartbeatIntervalMs: 120 });

    try {
      await haA.start();
      await haB.start();

      expect(await haA.isNodeAlive('node-a')).toBe(true);
      expect(await haA.isNodeAlive('node-b')).toBe(true);
      expect(await haB.aliveNodes()).toEqual(new Set(['node-a', 'node-b']));

      // 超过单个 TTL 后因心跳续租仍存活
      await new Promise((r) => setTimeout(r, 520));
      expect(await haB.isNodeAlive('node-a')).toBe(true);
      expect(await haA.isNodeAlive('node-b')).toBe(true);

      // 写入一条已过期的崩溃节点租约：isNodeAlive 返回 false，aliveNodes 不包含
      await dbA.query(
        `insert into ha_leases (key, owner, expires_at) values ('node:dead-node', 'dead-node', $1)`,
        [new Date(Date.now() - 5_000)],
      );
      expect(await haA.isNodeAlive('dead-node')).toBe(false);
      expect((await haA.aliveNodes()).has('dead-node')).toBe(false);

      // 优雅停机立即删除自身租约行
      await haA.stop();
      expect(await haB.isNodeAlive('node-a')).toBe(false);
      expect(await haB.aliveNodes()).toEqual(new Set(['node-b']));

      // tryWithJobLock 跨副本互斥
      let releaseJob!: () => void;
      const holdJob = new Promise<void>((r) => {
        releaseJob = r;
      });
      let jobEntered!: () => void;
      const inJob = new Promise<void>((r) => {
        jobEntered = r;
      });
      const firstJob = haA.tryWithJobLock('drift-sweep', async () => {
        jobEntered();
        await holdJob;
        return 1;
      });
      await inJob;
      expect(await haB.tryWithJobLock('drift-sweep', async () => 2)).toEqual({ acquired: false });
      releaseJob();
      expect(await firstJob).toEqual({ acquired: true, value: 1 });
      expect(await haB.tryWithJobLock('drift-sweep', async () => 2)).toEqual({ acquired: true, value: 2 });
    } finally {
      await haA.stop();
      await haB.stop();
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
    }
  });
});

// ───── 5. 跨副本 EnvLocks 互斥 ─────

describe.skipIf(!PG_URL)('跨副本 EnvLocks 互斥（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('副本 A 持有环境锁时，副本 B 的 acquire / lockEnvIdle / PATCH 连接串 / DELETE 均返回 409，释放后恢复', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'ha-test-secret-at-least-16-chars';
    const t = await createTestDb('ha_envlocks');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);

    try {
      // 直接测试 EnvLocks 跨副本互斥与等待唤醒
      const locksA = new EnvLocks(dbA);
      const locksB = new EnvLocks(dbB);
      const releaseA = await locksA.acquire('env-cross-1');
      expect(locksA.busy('env-cross-1')).toBe(true);
      expect(locksB.busy('env-cross-1')).toBe(false);

      // 副本 B 立即尝试（timeoutMs=0，等同 lockEnvIdle）立刻抛 EnvBusyError（409）
      await expect(locksB.acquire('env-cross-1', 0, '环境正在执行，稍后再改')).rejects.toThrow(EnvBusyError);
      // 副本 B 短超时等待也抛 EnvBusyError
      await expect(locksB.acquire('env-cross-1', 120)).rejects.toThrow(EnvBusyError);

      // 副本 B 等待，副本 A 释放后副本 B 顺利拿到锁
      const waitingB = locksB.acquire('env-cross-1', 2000);
      await new Promise((r) => setTimeout(r, 80));
      await releaseA();
      const releaseB = await waitingB;
      await releaseB();

      // 端到端 HTTP 验证：副本 A 持环境锁期间，副本 B 的 PATCH 连接串和 DELETE 返回 409
      const appA = createApp(dbA);
      const appB = createApp(dbB);
      try {
        await makeUser(dbA, 'admin', { role: 'admin' });
        const loginRes = await callJson(appB.app, 'POST', '/api/auth/login', {
          username: 'admin',
          password: PASSWORD,
        });
        expect(loginRes.status).toBe(200);
        const cookie = loginRes.cookie;

        const grp = await callJson(appB.app, 'POST', '/api/groups', { name: 'g', slug: 'g' }, cookie);
        expect(grp.status).toBe(201);
        const proj = await callJson(
          appB.app,
          'POST',
          '/api/projects',
          { name: 'p', groupId: grp.data.id },
          cookie,
        );
        expect(proj.status).toBe(201);
        const pid = proj.data.id as string;
        await dbA.query(
          `insert into environments (id, project_id, name, url_enc, production)
           values ('e-ha', $1, 'staging', $2, $3)`,
          [pid, encrypt('postgres://u:p@127.0.0.1:5432/x'), false],
        );

        const rel = await lockEnvIdle(appA.exec, 'e-ha');
        try {
          const patch = await callJson(
            appB.app,
            'PATCH',
            `/api/projects/${pid}/environments/e-ha`,
            { url: 'postgres://u:p@127.0.0.1:1/y' },
            cookie,
          );
          expect(patch.status).toBe(409);
          expect(patch.data.error).toContain('环境正在执行');

          const del = await callJson(
            appB.app,
            'DELETE',
            `/api/projects/${pid}/environments/e-ha`,
            undefined,
            cookie,
          );
          expect(del.status).toBe(409);
        } finally {
          await rel();
        }

        // 副本 A 释放锁后，副本 B 可以删除环境
        const delAfter = await callJson(
          appB.app,
          'DELETE',
          `/api/projects/${pid}/environments/e-ha`,
          undefined,
          cookie,
        );
        expect(delAfter.status).toBe(200);
      } finally {
        await appA.rooms.flush();
        await appB.rooms.flush();
        await appA.shadows.close();
        await appB.shadows.close();
      }
    } finally {
      await dbA.close();
      await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });
});

// ───── 6. 多副本共享 setupToken 与并发 autoSetup 幂等 ─────

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('HA4：多副本共享 setupToken 与并发 autoSetup 幂等（$platform）', ({ platform, skip }) => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test.skipIf(skip)('双副本并发冷启动共享同一个 setupToken，跨副本初始化成功并删除持久化令牌', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'ha-setup-token-secret-16chars';
    let dbA: PlatformDb;
    let dbB: PlatformDb;
    if (platform === 'sqlite') {
      dbA = await openPlatformDb(':memory:');
      dbB = dbA;
    } else {
      const t = await createTestDb('ha_setup');
      closers.push(t.close);
      dbA = await openPlatformDb(t.url);
      dbB = await openPlatformDb(t.url);
    }

    const appA = createApp(dbA);
    const appB = createApp(dbB);
    try {
      // 双副本并发冷启动生成/获取共享 setupToken，必须拿到完全相同的值
      const [tokenA, tokenB] = await Promise.all([
        ensureSetupToken(dbA, appA.setupToken!),
        ensureSetupToken(dbB, appB.setupToken!),
      ]);
      expect(tokenA).toBeTruthy();
      expect(tokenB).toBe(tokenA);

      // 存储的值已加密（配置了 DOWEL_SECRET 时不存明文）
      const [storedRow] = await dbA.query<{ value: { enc?: string; plain?: string } }>(
        'select value from instance_settings where key = $1',
        [SETUP_TOKEN_KEY],
      );
      expect(typeof storedRow?.value.enc).toBe('string');
      expect(storedRow?.value.plain).toBeUndefined();

      // 副本 B 用副本 A 的共享令牌发起并发 POST /api/setup：严格 1 个成功，1 个 409，库里仅 1 个管理员
      const [r1, r2] = await Promise.all([
        callJson(appA.app, 'POST', '/api/setup', {
          token: tokenA,
          username: 'admin1',
          name: '管理员一',
          password: PASSWORD,
        }),
        callJson(appB.app, 'POST', '/api/setup', {
          token: tokenB,
          username: 'admin2',
          name: '管理员二',
          password: PASSWORD,
        }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      expect(await dbA.query('select id from users')).toHaveLength(1);

      // 创建管理员的同一事务里已删除 instance_settings 中的 setup_token
      expect(
        await dbA.query('select value from instance_settings where key = $1', [SETUP_TOKEN_KEY]),
      ).toEqual([]);
      // 已经有用户后 ensureSetupToken 返回 null
      expect(await ensureSetupToken(dbB)).toBeNull();
    } finally {
      await appA.rooms.flush();
      await appB.rooms.flush();
      await appA.shadows.close();
      await appB.shadows.close();
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });

  test.skipIf(skip)('DOWEL_SECRET 缺失或变更时安全降级，且兼容 options.setupToken 自定义令牌', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    delete process.env.DOWEL_SECRET;
    let db: PlatformDb;
    if (platform === 'sqlite') {
      db = await openPlatformDb(':memory:');
    } else {
      const t = await createTestDb('ha_setup_fallback');
      closers.push(t.close);
      db = await openPlatformDb(t.url);
    }

    try {
      // 无 DOWEL_SECRET 时降级明文持久化，多次调用拿到同一个令牌
      const t1 = await ensureSetupToken(db, 'plain-shared-token');
      const t2 = await ensureSetupToken(db, 'another-candidate');
      expect(t1).toBe('plain-shared-token');
      expect(t2).toBe('plain-shared-token');

      // 模拟历史密文因 DOWEL_SECRET 变化无法解密：ensureSetupToken 安全覆盖并生成新令牌
      process.env.DOWEL_SECRET = 'first-secret-value-16chars';
      await db.query(
        `insert into instance_settings (key, value) values ($1, $2::text::jsonb)
         on conflict (key) do update set value = excluded.value`,
        [SETUP_TOKEN_KEY, JSON.stringify({ enc: encrypt('stale-secret-token') })],
      );
      process.env.DOWEL_SECRET = 'rotated-secret-value-16chars';
      const healed = await ensureSetupToken(db, 'healed-token');
      expect(healed).toBe('healed-token');

      // 自定义 options.setupToken 在单测中优先生效
      const customApp = createApp(db, { setupToken: 'custom-unit-test-token' });
      try {
        const res = await callJson(customApp.app, 'POST', '/api/setup', {
          token: 'custom-unit-test-token',
          username: 'customadmin',
          name: '测试管理员',
          password: PASSWORD,
        });
        expect(res.status).toBe(200);
        expect(
          await db.query('select value from instance_settings where key = $1', [SETUP_TOKEN_KEY]),
        ).toEqual([]);
      } finally {
        await customApp.rooms.flush();
        await customApp.shadows.close();
      }
    } finally {
      await db.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });

  test.skipIf(skip)('双副本并发 autoSetup 幂等：只建一个管理员，另一副本优雅返回 null', async () => {
    let dbA: PlatformDb;
    let dbB: PlatformDb;
    if (platform === 'sqlite') {
      dbA = await openPlatformDb(':memory:');
      dbB = dbA;
    } else {
      const t = await createTestDb('ha_autosetup');
      closers.push(t.close);
      dbA = await openPlatformDb(t.url);
      dbB = await openPlatformDb(t.url);
    }

    try {
      await ensureSetupToken(dbA, 'token-to-be-cleaned');
      const env = { DOWEL_ADMIN_USERNAME: 'root', DOWEL_ADMIN_PASSWORD: PASSWORD };
      const results = await Promise.all([autoSetup(dbA, env), autoSetup(dbB, env)]);
      const created = results.filter((u) => u !== null);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ username: 'root', role: 'admin' });
      expect(results.filter((u) => u === null)).toHaveLength(1);
      expect(await dbA.query('select username from users')).toEqual([{ username: 'root' }]);
      // autoSetup 同时清理了持久化的 setup_token
      expect(
        await dbA.query('select value from instance_settings where key = $1', [SETUP_TOKEN_KEY]),
      ).toEqual([]);
    } finally {
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
    }
  });
});
