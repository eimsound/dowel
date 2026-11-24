// 链尾版本作废 / 取消作废 / 发布的并发串行化（平台库 PG，SQLite 的写事务天然互斥）：
// 用另一个会话先拿住 projects 行的 FOR UPDATE 锁，确定性地复现并发竞争：
// 1. 两个并发 retire 竞争同一项目：一个成功，另一个 409 head_changed；
// 2. retire 与 publish 并发竞争同一项目：恰好一个成功，另一个 409，保持单活跃链与单调唯一版本号；
// 3. 两个并发 unretire 竞争同一可恢复尾段：一个成功，另一个 409 not_unretirable；
// 4. unretire 与 publish 并发竞争同一项目：恰好一个成功，另一个 409，保持单活跃链与单调唯一版本号。
import { addColumn, all, type Model } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'versions-concurrency-secret-0123456789';

describe.skipIf(!PG_URL)('版本发布 / 作废 / 取消作废并发串行化（平台库 PG）', () => {
  let platform: Awaited<ReturnType<typeof createTestDb>>;
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let groupId = '';

  const call = async (method: string, path: string, json: unknown, who = 'admin') => {
    const r = await created.app.request(path, {
      method,
      headers: { cookie: cookies[who]!, 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data };
  };

  /**
   * 等待直到有 n 个会话在排队等锁：第一个请求直接被 holderPid 的行锁挡住，后到的请求排在它后面
   * （pg_blocking_pids 里是前一个排队者，不是 holder），所以统计“被任何会话挡住”的会话数
   */
  const waitProjectLockWaiters = async (holder: ReturnType<typeof connect>, holderPid: number, n: number) => {
    for (let i = 0; i < 250; i++) {
      const [r] = await holder.db.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where pid <> $1 and cardinality(pg_blocking_pids(pid)) > 0',
        [holderPid],
      );
      if (r!.n >= n) return;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    const act = await holder.db.query(
      'select pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blockers, left(query, 80) as q from pg_stat_activity where pid <> pg_backend_pid()',
    );
    throw new Error(`等待 ${n} 个请求排队锁项目行超时（holderPid=${holderPid}）act=${JSON.stringify(act)}`);
  };

  /**
   * 持住 projects 行 FOR UPDATE 锁期间派发并发 HTTP 请求，确认它们都在排队后先放锁、再等结果
   * （在放锁之前等结果会自己卡住自己）
   */
  const withProjectRowLock = async <T>(
    pid: string,
    fn: (holder: ReturnType<typeof connect>, holderPid: number) => Promise<Promise<T>[]>,
  ): Promise<T[]> => {
    const holder = connect(platform.url);
    try {
      await holder.db.exec('begin');
      try {
        const [row] = await holder.db.query<{ pid: number }>('select pg_backend_pid() as pid');
        const holderPid = row!.pid;
        await holder.db.query('select id from projects where id = $1 for update', [pid]);
        const pending = await fn(holder, holderPid);
        await holder.db.exec('commit');
        return await Promise.all(pending);
      } catch (e) {
        await holder.db.exec('rollback').catch(() => {});
        throw e;
      }
    } finally {
      await holder.close();
    }
  };

  const tableOf = (m: Model) => all(m, 'table').find((t) => t.name === 'orders')!.id;

  const setupProject = async (name: string) => {
    const p = await call('POST', '/api/projects', { name, groupId }, 'admin');
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.e1, role: 'editor' },
      'admin',
    );
    await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.e2, role: 'editor' },
      'admin',
    );
    await addTable(created.rooms, db, pid);
    const v1 = await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' }, 'admin');
    expect(v1.status).toBe(201);
    await editModel(
      created.rooms,
      db,
      pid,
      (m) => void addColumn(m, tableOf(m), { name: 'c2', type: 'text' }),
    );
    const v2 = await call('POST', `/api/projects/${pid}/versions`, { name: 'v2' }, 'admin');
    expect(v2.status).toBe(201);
    return { pid, v1: v1.data.id as string, v2: v2.data.id as string };
  };

  const assertSingleActiveChainAndMonotonicNumbers = async (pid: string) => {
    const rows = await db.query<{
      id: string;
      number: number;
      parentId: string | null;
      retiredAt: unknown;
    }>(
      'select id, number, parent_id as "parentId", retired_at as "retiredAt" from versions where project_id = $1 order by number asc',
      [pid],
    );
    const numbers = rows.map((r) => r.number);
    expect(new Set(numbers).size).toBe(rows.length);
    const active = rows.filter((r) => r.retiredAt === null);
    expect(active.length).toBeGreaterThanOrEqual(1);
    expect(active[0]!.parentId).toBeNull();
    for (let i = 1; i < active.length; i++) {
      expect(active[i]!.parentId).toBe(active[i - 1]!.id);
    }
    return rows;
  };

  beforeAll(async () => {
    platform = await createTestDb('ver_conc');
    db = await openPlatformDb(platform.url);
    created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
    await makeUser(db, 'admin', { role: 'admin' });
    ids.e1 = (await makeUser(db, 'e1')).id;
    ids.e2 = (await makeUser(db, 'e2')).id;
    for (const n of ['admin', 'e1', 'e2']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const g = await call(
      'POST',
      '/api/groups',
      { slug: 'vc', name: '版本并发', defaultRole: 'none' },
      'admin',
    );
    groupId = g.data.id as string;
  });

  afterAll(async () => {
    created.requests.stop();
    await created.webhooks.close();
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    await platform.close();
  });

  test('两个并发 retire 竞争同一项目：只有一个成功，另一个 409 head_changed', async () => {
    const { pid, v2 } = await setupProject('race-double-retire');
    const [r1, r2] = await withProjectRowLock(pid, async (holder, holderPid) => {
      const p1 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/retire`,
        { head: v2, keepWorkingCopy: true },
        'e1',
      );
      const p2 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/retire`,
        { head: v2, keepWorkingCopy: true },
        'e2',
      );
      await waitProjectLockWaiters(holder, holderPid, 2);
      return [p1, p2];
    });
    const ok = [r1, r2].filter((r) => r.status === 200);
    const conflict = [r1, r2].filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.data.code).toBe('head_changed');
    await assertSingleActiveChainAndMonotonicNumbers(pid);
  });

  test('retire 与 publish 并发竞争同一项目：恰好一个成功、另一个 409，单活跃链与唯一号段不破坏', async () => {
    const { pid, v2 } = await setupProject('race-retire-publish');
    await editModel(
      created.rooms,
      db,
      pid,
      (m) => void addColumn(m, tableOf(m), { name: 'c3', type: 'text' }),
    );
    const [retireRes, pubRes] = await withProjectRowLock(pid, async (holder, holderPid) => {
      const p1 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/retire`,
        { head: v2, keepWorkingCopy: true },
        'e1',
      );
      const p2 = call('POST', `/api/projects/${pid}/versions`, { name: 'v3' }, 'e2');
      await waitProjectLockWaiters(holder, holderPid, 2);
      return [p1, p2];
    });
    const statuses = [retireRes.status, pubRes.status];
    expect(statuses.includes(409)).toBe(true);
    expect(retireRes.status === 200 || pubRes.status === 201).toBe(true);
    expect(retireRes.status === 200 && pubRes.status === 201).toBe(false);
    if (retireRes.status === 409) expect(retireRes.data.code).toBe('head_changed');
    await assertSingleActiveChainAndMonotonicNumbers(pid);
  });

  test('两个并发 unretire 竞争同一可恢复尾段：只有一个成功，另一个 409 not_unretirable', async () => {
    const { pid, v2 } = await setupProject('race-double-unretire');
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/versions/${v2}/retire`,
          { head: v2, keepWorkingCopy: true },
          'e1',
        )
      ).status,
    ).toBe(200);

    const [r1, r2] = await withProjectRowLock(pid, async (holder, holderPid) => {
      const p1 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/unretire`,
        { syncWorkingCopy: false },
        'e1',
      );
      const p2 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/unretire`,
        { syncWorkingCopy: false },
        'e2',
      );
      await waitProjectLockWaiters(holder, holderPid, 2);
      return [p1, p2];
    });
    const ok = [r1, r2].filter((r) => r.status === 200);
    const conflict = [r1, r2].filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflict).toHaveLength(1);
    expect(conflict[0]!.data.code).toBe('not_unretirable');
    await assertSingleActiveChainAndMonotonicNumbers(pid);
  });

  test('unretire 与 publish 并发竞争同一项目：恰好一个成功、另一个 409，单活跃链与唯一号段不破坏', async () => {
    const { pid, v2 } = await setupProject('race-unretire-publish');
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/versions/${v2}/retire`,
          { head: v2, keepWorkingCopy: true },
          'e1',
        )
      ).status,
    ).toBe(200);
    await editModel(
      created.rooms,
      db,
      pid,
      (m) => void addColumn(m, tableOf(m), { name: 'c3', type: 'text' }),
    );

    const [unretireRes, pubRes] = await withProjectRowLock(pid, async (holder, holderPid) => {
      const p1 = call(
        'POST',
        `/api/projects/${pid}/versions/${v2}/unretire`,
        { syncWorkingCopy: false },
        'e1',
      );
      const p2 = call('POST', `/api/projects/${pid}/versions`, { name: 'v3' }, 'e2');
      await waitProjectLockWaiters(holder, holderPid, 2);
      return [p1, p2];
    });
    expect([unretireRes.status, pubRes.status].includes(409)).toBe(true);
    expect(unretireRes.status === 200 || pubRes.status === 201).toBe(true);
    expect(unretireRes.status === 200 && pubRes.status === 201).toBe(false);
    if (unretireRes.status === 409) expect(unretireRes.data.code).toBe('not_unretirable');
    await assertSingleActiveChainAndMonotonicNumbers(pid);
  });
});
