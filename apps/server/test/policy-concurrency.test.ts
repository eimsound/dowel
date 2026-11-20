// 执行策略写入的原子性（P5a 审查后）：所有策略写入都在执行策略锁的事务里读当前值 → 校验 / 放宽检测 → 写。
// 平台库用 PG（SQLite 的事务本来就互斥）。用另一个会话先占住锁，按顺序放进两个请求，确定性地复现“一次收紧被另一个
// 基于旧状态的写入覆盖”：后到的写入必须在收紧之后的状态上判断（放宽 → 403），不能把收紧覆盖掉。
import type { PolicyLayerView } from '@dowel/api';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { POLICY_LOCK_KEY } from '../src/policy.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'policy-concurrency-secret-0123456789';

describe.skipIf(!PG_URL)('执行策略写入串行化（平台库 PG）', () => {
  let platform: Awaited<ReturnType<typeof createTestDb>>;
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let pid = '';

  const call = async (method: string, path: string, json: unknown, who: string) => {
    const r = await created.app.request(path, {
      method,
      headers: { cookie: cookies[who]!, 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });
    return { status: r.status, data: (await r.json()) as Record<string, unknown> };
  };

  /** 等到有 n 个请求排在执行策略锁上 */
  const waiters = async (holder: ReturnType<typeof connect>, n: number) => {
    for (let i = 0; i < 200; i++) {
      const [r] = await holder.db.query<{ n: number }>(
        "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted",
      );
      if (r!.n >= n) return;
      await new Promise((ok) => setTimeout(ok, 25));
    }
    throw new Error(`等不到 ${n} 个请求排队`);
  };

  beforeAll(async () => {
    platform = await createTestDb('pol_conc');
    db = await openPlatformDb(platform.url);
    created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
    await makeUser(db, 'admin', { role: 'admin' });
    ids.pa = (await makeUser(db, 'pa')).id;
    for (const n of ['admin', 'pa']) {
      const r = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: n, password: PASSWORD }),
      });
      cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    }
    const g = await call('POST', '/api/groups', { slug: 'conc', name: '并发', defaultRole: 'none' }, 'admin');
    const p = await call('POST', '/api/projects', { name: 'conc', groupId: g.data.id }, 'admin');
    pid = p.data.id as string;
    await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.pa, role: 'admin' },
      'admin',
    );
    await db.query(
      "insert into environments (id, project_id, name, url_enc, production) values ('e1', $1, 'e1', $2, false)",
      [pid, encrypt('postgres://u:p@127.0.0.1:1/x')],
    );
  });

  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    await platform.close();
  });

  test('收紧之后排队的写入按收紧后的状态判断：基于旧状态的“放宽”被拒，收紧没有被覆盖', async () => {
    const holder = connect(platform.url);
    const path = `/api/projects/${pid}/environments/e1/exec-policy`;
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      // A：实例管理员把环境收紧成“仅限执行者”
      const a = call('PUT', path, { settings: { whoCanExecute: 'executor' }, prerequisiteId: null }, 'admin');
      await waiters(holder, 1);
      // B：项目管理员看到的还是旧状态（没有“仅限执行者”），只想把锁等待改短——对收紧之后的状态来说，这是撤掉“仅限执行者”
      const b = call('PUT', path, { settings: { lockTimeoutMs: 1000 }, prerequisiteId: null }, 'pa');
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(403);
      expect(rb.data.error).toContain('仅限执行者');
    } finally {
      await holder.close();
    }
    const [row] = await db.query<{ policy: { whoCanExecute?: string; lockTimeoutMs?: number } }>(
      "select policy from exec_policies where scope_kind = 'environment' and scope_id = 'e1'",
    );
    expect(row!.policy).toEqual({ whoCanExecute: 'executor' });
  });

  test('实例 / 组 / 项目层的写入同样排在这把锁上', async () => {
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      let settled = false;
      const p = call(
        'PUT',
        `/api/projects/${pid}/exec-policy`,
        { production: { lockTimeoutMs: 3000 } },
        'pa',
      ).finally(() => {
        settled = true;
      });
      await waiters(holder, 1);
      await new Promise((ok) => setTimeout(ok, 200));
      expect(settled).toBe(false);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const r = await p;
      expect(r.status).toBe(200);
      expect((r.data as unknown as PolicyLayerView).settings.production.lockTimeoutMs).toBe(3000);
    } finally {
      await holder.close();
    }
  });

  /** 新项目（实例管理员建在 groupId 里，pa 是项目管理员）+ 一个不连目标库的环境 */
  const project = async (name: string, groupId: string, production: boolean) => {
    const p = await call('POST', '/api/projects', { name, groupId }, 'admin');
    const id = p.data.id as string;
    await call(
      'POST',
      `/api/projects/${id}/grants`,
      { subjectKind: 'user', subjectId: ids.pa, role: 'admin' },
      'admin',
    );
    const eid = `${id}-env`;
    await db.query(
      'insert into environments (id, project_id, name, url_enc, production) values ($1, $2, $1, $3, $4)',
      [eid, id, encrypt('postgres://u:p@127.0.0.1:1/x'), production],
    );
    return { id, eid };
  };

  test('PATCH 等锁期间生产标记被别人改了：按锁内的状态判断（这次变成了“取消生产标记”，要满足执行策略），不会悄悄写回', async () => {
    const g = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-prod', name: '生产标记', defaultRole: 'none' },
      'admin',
    );
    const { id, eid } = await project('prodflag', g.data.id as string, false);
    // 项目层：生产环境仅限执行者（pa 不是执行者）
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${id}/exec-policy`,
          { production: { whoCanExecute: 'executor' } },
          'admin',
        )
      ).status,
    ).toBe(200);
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      // A：实例管理员把环境标成生产
      const a = call('PATCH', `/api/projects/${id}/environments/${eid}`, { production: true }, 'admin');
      await waiters(holder, 1);
      // B：pa 看到的还是非生产，请求里带着 production: false（锁外看没有变化）和一个连接设置的修改
      const b = call(
        'PATCH',
        `/api/projects/${id}/environments/${eid}`,
        { production: false, allowSameInstance: true },
        'pa',
      );
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status).toBe(200);
      // 锁内：环境已经是生产，这次请求等于取消生产标记 → 要满足生产那一套的“仅限执行者”，pa 不满足
      expect(rb.status).toBe(403);
      expect(rb.data.error).toContain('仅限执行者');
    } finally {
      await holder.close();
    }
    const [row] = await db.query<{ production: boolean; allow_same_instance: boolean }>(
      'select production, allow_same_instance from environments where id = $1',
      [eid],
    );
    expect(row).toEqual({ production: true, allow_same_instance: false });
  });

  test('排在转组之后的策略写入按新组判断：环境层 / 项目层都用锁内读到的组', async () => {
    const g1 = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-src', name: '源组', defaultRole: 'none' },
      'admin',
    );
    const g2 = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-dst', name: '目标组', defaultRole: 'none' },
      'admin',
    );
    // 目标组：非生产仅限执行者；源组什么都没设
    expect(
      (
        await call(
          'PUT',
          '/api/groups/conc-dst/exec-policy',
          { nonProduction: { whoCanExecute: 'executor' } },
          'admin',
        )
      ).status,
    ).toBe(200);
    const { id, eid } = await project('transfer-race', g1.data.id as string, false);
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      const t = call('POST', `/api/projects/${id}/transfer`, { groupId: g2.data.id }, 'admin');
      await waiters(holder, 1);
      // pa 以为还在源组：把环境层 / 项目层的非生产设成“项目编辑者”——在源组下合法，在目标组下比下限宽
      const envPut = call(
        'PUT',
        `/api/projects/${id}/environments/${eid}/exec-policy`,
        { settings: { whoCanExecute: 'editor' }, prerequisiteId: null },
        'pa',
      );
      await waiters(holder, 2);
      const projectPut = call(
        'PUT',
        `/api/projects/${id}/exec-policy`,
        { nonProduction: { whoCanExecute: 'editor' } },
        'pa',
      );
      await waiters(holder, 3);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [rt, re, rp] = await Promise.all([t, envPut, projectPut]);
      expect(rt.status).toBe(200);
      expect(re.status).toBe(422);
      expect(re.data.error).toContain('组');
      expect(rp.status).toBe(422);
      expect(rp.data.error).toContain('组');
    } finally {
      await holder.close();
    }
    const rows = await db.query<{ scope_kind: string }>(
      "select scope_kind from exec_policies where (scope_kind = 'environment' and scope_id = $1) or (scope_kind = 'project' and scope_id = $2)",
      [eid, id],
    );
    expect(rows).toEqual([]);
  });

  test('PATCH 锁内才出现的连接类改动（等锁期间别人改了“允许同实例影子库”）：没有环境锁保护，409，什么都没改', async () => {
    const g = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-conn', name: '连接', defaultRole: 'none' },
      'admin',
    );
    const { id, eid } = await project('conn-race', g.data.id as string, false);
    await db.query('update environments set allow_same_instance = true where id = $1', [eid]);
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      // A：实例管理员把“允许同实例影子库”关掉（连接类，拿着环境锁排在执行策略锁上）
      const a = call(
        'PATCH',
        `/api/projects/${id}/environments/${eid}`,
        { allowSameInstance: false },
        'admin',
      );
      await waiters(holder, 1);
      // B：pa 看到的还是 true：请求里的 allowSameInstance: true 在锁外看不是改动（不拿环境锁），只改档位
      const b = call(
        'PATCH',
        `/api/projects/${id}/environments/${eid}`,
        { allowSameInstance: true, execPolicy: 'admin' },
        'pa',
      );
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.status).toBe(200);
      // 锁内：allowSameInstance 已经是 false，这次请求变成了改连接配置，但没有拿环境锁 → 409
      expect(rb.status).toBe(409);
      expect(rb.data.error).toContain('刷新后重试');
    } finally {
      await holder.close();
    }
    const [row] = await db.query<{ allow_same_instance: boolean }>(
      'select allow_same_instance from environments where id = $1',
      [eid],
    );
    expect(row!.allow_same_instance).toBe(false);
    // 档位也没有被写（整个请求回滚）
    expect(
      (
        await db.query("select 1 from exec_policies where scope_kind = 'environment' and scope_id = $1", [
          eid,
        ])
      ).length,
    ).toBe(0);
  });

  test('转组：等锁期间项目已经被别人转走了，按锁外的源组做的检查作废 → 409，项目留在先转到的组', async () => {
    const g1 = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-t1', name: '源', defaultRole: 'none' },
      'admin',
    );
    const g2 = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-t2', name: '甲', defaultRole: 'none' },
      'admin',
    );
    const g3 = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-t3', name: '乙', defaultRole: 'none' },
      'admin',
    );
    const { id } = await project('double-transfer', g1.data.id as string, false);
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      const t1 = call('POST', `/api/projects/${id}/transfer`, { groupId: g2.data.id }, 'admin');
      await waiters(holder, 1);
      const t2 = call('POST', `/api/projects/${id}/transfer`, { groupId: g3.data.id }, 'admin');
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [r1, r2] = await Promise.all([t1, t2]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(409);
      expect(r2.data.error).toContain('别的组');
    } finally {
      await holder.close();
    }
    const [row] = await db.query<{ groupId: string }>(
      'select group_id as "groupId" from projects where id = $1',
      [id],
    );
    expect(row!.groupId).toBe(g2.data.id);
    // 旧地址跳转只记了源组（第二次没有写下“甲组”的跳转）
    const redirects = await db.query<{ owner: string }>(
      'select owner_slug as owner from project_redirects where project_id = $1',
      [id],
    );
    expect(redirects.map((r) => r.owner)).toEqual(['conc-t1']);
  });

  test('删除环境：收紧成“仅限执行者”排在前面，项目管理员的删除在锁内按新策略判断 → 403，环境还在', async () => {
    const g = await call(
      'POST',
      '/api/groups',
      { slug: 'conc-del', name: '删除', defaultRole: 'none' },
      'admin',
    );
    const { id, eid } = await project('delete-race', g.data.id as string, false);
    const holder = connect(platform.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [POLICY_LOCK_KEY]);
      const tighten = call(
        'PUT',
        `/api/projects/${id}/environments/${eid}/exec-policy`,
        { settings: { whoCanExecute: 'executor' }, prerequisiteId: null },
        'admin',
      );
      await waiters(holder, 1);
      const del = call('DELETE', `/api/projects/${id}/environments/${eid}`, undefined, 'pa');
      await waiters(holder, 2);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [POLICY_LOCK_KEY]);
      const [rt, rd] = await Promise.all([tighten, del]);
      expect(rt.status).toBe(200);
      expect(rd.status).toBe(403);
      expect(rd.data.error).toContain('仅限执行者');
    } finally {
      await holder.close();
    }
    expect((await db.query('select 1 from environments where id = $1', [eid])).length).toBe(1);
  });
});
