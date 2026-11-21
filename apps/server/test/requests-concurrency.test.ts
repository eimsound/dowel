// 执行申请的并发（P5b）：平台库用 PG（SQLite 的事务本来就互斥），目标库也是 PG。
// 用另一个会话占住执行策略锁、按顺序放进请求，确定性地复现竞争：
// - 两个审批人同时批同一个环节：只有一个算数，另一个 409；
// - 两个审批人同时“通过并执行”：只执行一次；
// - 审批与直接执行并发：目标库只执行一次，申请要么执行成功、要么失效；
// - 审批排在锁上时环境状态变了：锁内重新检查，申请失效；平台库缓存落后时执行器在目标库锁里拦住（越不过失效）。
import type { ExecEvent, ExecRequestDetail } from '@dowel/api';
import { readHistory } from '@dowel/engines';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { POLICY_LOCK_KEY } from '../src/policy.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'requests-concurrency-secret-0123456789';

describe.skipIf(!PG_URL)('执行申请的并发（平台库 PG）', () => {
  let platform: Awaited<ReturnType<typeof createTestDb>>;
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];
  let groupId = '';

  const call = async (method: string, path: string, json: unknown, who: string) => {
    const r = await created.app.request(path, {
      method,
      headers: { cookie: cookies[who]!, 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    let events: ExecEvent[] = [];
    if (r.headers.get('content-type')?.includes('text/event-stream'))
      events = text
        .split('\n\n')
        .filter((x) => x.trim().startsWith('data:'))
        .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as ExecEvent);
    else
      try {
        data = JSON.parse(text);
      } catch {}
    return { status: r.status, data, events };
  };

  const waiters = async (holder: ReturnType<typeof connect>, n: number) => {
    for (let i = 0; i < 400; i++) {
      const [r] = await holder.db.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      if (r!.n >= n) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`等不到 ${n} 个请求排队`);
  };
  const withLockHeld = async <T>(fn: (holder: ReturnType<typeof connect>) => Promise<T>) => {
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      return await fn(holder);
    } finally {
      await holder.db.query('select pg_advisory_unlock_all()').catch(() => {});
      await holder.close();
    }
  };

  beforeAll(async () => {
    platform = await createTestDb('req_conc');
    db = await openPlatformDb(platform.url);
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    await makeUser(db, 'admin', { role: 'admin' });
    for (const n of ['pa', 'pb', 'dev']) ids[n] = (await makeUser(db, n)).id;
    for (const n of ['admin', 'pa', 'pb', 'dev']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const g = await call('POST', '/api/groups', { slug: 'rc', name: '并发', defaultRole: 'none' }, 'admin');
    groupId = g.data.id as string;
  });

  afterAll(async () => {
    created.requests.stop();
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    const adminConn = connect(PG_URL);
    for (const t of targets) {
      await adminConn.db
        .exec(`DROP DATABASE IF EXISTS ${new URL(t.url).pathname.slice(1)}_dowel WITH (FORCE)`)
        .catch(() => {});
      await t.close();
    }
    await adminConn.close();
    await platform.close();
  });

  /** 项目（pa、pb 项目管理员，dev 编辑者）+ 一个生产环境 + 发布 v1 */
  const setup = async (name: string, approval?: unknown[]) => {
    const p = await call('POST', '/api/projects', { name, groupId }, 'admin');
    const pid = p.data.id as string;
    for (const [u, role] of [
      ['pa', 'admin'],
      ['pb', 'admin'],
      ['dev', 'editor'],
    ] as const)
      await call(
        'POST',
        `/api/projects/${pid}/grants`,
        { subjectKind: 'user', subjectId: ids[u], role },
        'admin',
      );
    const target = await createTestDb('req_conc_tgt');
    targets.push(target);
    const e = await call(
      'POST',
      `/api/projects/${pid}/environments`,
      { name: 'prod', url: target.url, production: true, allowSameInstance: true },
      'admin',
    );
    expect(e.status, JSON.stringify(e.data)).toBe(201);
    if (approval)
      expect(
        (await call('PUT', `/api/projects/${pid}/exec-policy`, { production: { approval } }, 'admin')).status,
      ).toBe(200);
    await addTable(created.rooms, db, pid);
    const v = await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' }, 'admin');
    expect(v.status, JSON.stringify(v.data)).toBe(201);
    const eid = e.data.id as string;
    const r = await call(
      'POST',
      `/api/projects/${pid}/environments/${eid}/requests`,
      { kind: 'execute', to: v.data.id },
      'dev',
    );
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return { pid, eid, target, v1: v.data.id as string, rid: (r.data as unknown as ExecRequestDetail).id };
  };
  const upRuns = async (t: { db: Parameters<typeof readHistory>[0] }, pid: string) =>
    (await readHistory(t.db, pid)).history.filter((h) => h.direction === 'up').length;
  const statusOf = async (rid: string) =>
    (await db.query<{ status: string }>('select status from exec_requests where id = $1', [rid]))[0]!.status;

  test('两个审批人同时批同一个环节：只有一个算数，另一个 409', async () => {
    const two = [
      { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: false },
      { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: true },
    ];
    const { pid, rid } = await setup('conc-approve', two);
    const path = `/api/projects/${pid}/requests/${rid}/approve`;
    const [a, b] = await withLockHeld(async (holder) => {
      const a = call('POST', path, { stage: 0, comment: 'a' }, 'pa');
      await waiters(holder, 1);
      const b = call('POST', path, { stage: 0, comment: 'b' }, 'pb');
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      return Promise.all([a, b]);
    });
    expect([a.status, b.status]).toEqual([200, 409]);
    const rows = await db.query<{ stage: number }>('select stage from exec_approvals where request_id = $1', [
      rid,
    ]);
    expect(rows.map((r) => r.stage)).toEqual([0]);
    const [req] = await db.query<{ stage: number; status: string }>(
      'select stage, status from exec_requests where id = $1',
      [rid],
    );
    expect(req).toEqual({ stage: 1, status: 'pending' });
  });

  test('两个审批人同时“通过并执行”：只执行一次', async () => {
    const { pid, rid, target } = await setup('conc-exec');
    const path = `/api/projects/${pid}/requests/${rid}/execute`;
    const body = { approve: { stage: 0, comment: '' }, confirm: 'prod' };
    const [a, b] = await withLockHeld(async (holder) => {
      const a = call('POST', path, body, 'pa');
      await waiters(holder, 1);
      const b = call('POST', path, body, 'pb');
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      return Promise.all([a, b]);
    });
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    expect(ok.events.at(-1)).toMatchObject({ stage: 'done', current: { number: 1 } });
    expect(await upRuns(target, pid)).toBe(1);
    expect(await statusOf(rid)).toBe('executed');
  });

  test('审批与直接执行并发：目标库只执行一次；申请要么执行成功，要么失效', async () => {
    const { pid, eid, rid, target, v1 } = await setup('conc-direct');
    const [r1, r2] = await Promise.all([
      call(
        'POST',
        `/api/projects/${pid}/requests/${rid}/execute`,
        { approve: { stage: 0, comment: '' }, confirm: 'prod' },
        'pa',
      ),
      call('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to: v1, confirm: 'prod' }, 'pb'),
    ]);
    expect(await upRuns(target, pid)).toBe(1);
    const st = await statusOf(rid);
    expect(['executed', 'invalid']).toContain(st);
    if (st === 'invalid') expect(r2.events.at(-1)).toMatchObject({ stage: 'done', ran: 1 });
    else expect(r1.events.at(-1)).toMatchObject({ stage: 'done', ran: 1 });
  });

  test('审批排在锁上时环境被直接执行了：锁内重新检查，申请失效，不会再执行一次', async () => {
    const { pid, eid, rid, target, v1 } = await setup('conc-state');
    const res = await withLockHeld(async (holder) => {
      const a = call(
        'POST',
        `/api/projects/${pid}/requests/${rid}/execute`,
        { approve: { stage: 0, comment: '' }, confirm: 'prod' },
        'pa',
      );
      await waiters(holder, 1);
      // 直接执行不需要执行策略锁：在审批排队期间完成
      const direct = await call(
        'POST',
        `/api/projects/${pid}/environments/${eid}/execute`,
        { to: v1, confirm: 'prod' },
        'pb',
      );
      expect(direct.events.at(-1)).toMatchObject({ stage: 'done', ran: 1 });
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      return a;
    });
    expect(res.status).toBe(409);
    expect(res.data.code).toBe('request_invalid');
    expect(await statusOf(rid)).toBe('invalid');
    expect(await upRuns(target, pid)).toBe(1);
  });

  test('平台库缓存落后于目标库：锁内检查以为还成立，执行器在目标库锁里按历史拦住（request_stale → 失效）', async () => {
    const { pid, eid, rid, target, v1 } = await setup('conc-stale-cache');
    const direct = await call(
      'POST',
      `/api/projects/${pid}/environments/${eid}/execute`,
      { to: v1, confirm: 'prod' },
      'pb',
    );
    expect(direct.events.at(-1)).toMatchObject({ stage: 'done', ran: 1 });
    // 直接执行结束后会在后台重检这个环境的申请（它会失效）：先等这一轮跑完，免得和下面的模拟交错
    await created.requests.sweep({ envIds: [eid] });
    // 模拟缓存没同步（例如别的实例执行了）：平台库里还是“没执行过”
    await db.query('update environments set current_version_id = null where id = $1', [eid]);
    await db.query("update exec_requests set status = 'pending' where id = $1", [rid]);
    const run = await call(
      'POST',
      `/api/projects/${pid}/requests/${rid}/execute`,
      { approve: { stage: 0, comment: '' }, confirm: 'prod' },
      'pa',
    );
    expect(run.status).toBe(200);
    expect(run.events.at(-1)).toMatchObject({ code: 'request_stale' });
    expect(await statusOf(rid)).toBe('invalid');
    expect(await upRuns(target, pid)).toBe(1);
  });

  test('提交申请时绑定的是预演用的那份校验和：预演之后、锁内之前脚本被改 → 409，不会绑定没预演过的版本', async () => {
    const { pid, eid, v1 } = await setup('conc-snapshot');
    const before = await db.query<{ n: number }>(
      'select count(*)::int as n from exec_requests where project_id = $1',
      [pid],
    );
    const v = (await call('GET', `/api/projects/${pid}/versions/${v1}`, undefined, 'admin')).data as {
      upSteps: { sql: string; transactional: boolean }[];
      downSteps: { sql: string; transactional: boolean }[];
    };
    const res = await withLockHeld(async (holder) => {
      // 提交：预演在锁外做完，然后排在执行策略锁上
      const sub = call(
        'POST',
        `/api/projects/${pid}/environments/${eid}/requests`,
        { kind: 'execute', to: v1 },
        'dev',
      );
      await waiters(holder, 1);
      // 这时脚本被改了（还没在任何环境执行过，可以改）
      const edit = await call(
        'PATCH',
        `/api/projects/${pid}/versions/${v1}/steps`,
        { up: [...v.upSteps, { sql: 'SELECT 1', transactional: true }], down: v.downSteps },
        'admin',
      );
      expect(edit.status, JSON.stringify(edit.data)).toBe(200);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      return sub;
    });
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toContain('预演之后被修改');
    const after = await db.query<{ n: number }>(
      'select count(*)::int as n from exec_requests where project_id = $1',
      [pid],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  test('打开申请详情（只读的绑定检查）不拿全局的执行策略锁', async () => {
    const { pid, rid } = await setup('conc-detail');
    const r = await withLockHeld(() =>
      Promise.race([
        call('GET', `/api/projects/${pid}/requests/${rid}`, undefined, 'dev'),
        new Promise<{ status: number }>((ok) => setTimeout(() => ok({ status: -1 }), 10_000)),
      ]),
    );
    expect(r.status).toBe(200);
  });
});
