// Issue #15：attach 与 claim 接口连库限速按实际外部建连数精确扣减，并复用同一目标库的短连接。
import type { AttachResult, ClaimResult, EnvInfo, ExecEvent, WizardEvent } from '@dowel/api';
import { addColumn, all, type Model } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { readSettings } from '../src/settings.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

// 统计服务端实际通过 postgres() 建立的外部数据库连接次数（覆盖 targets.ts 内部与路由层全部建连，与 connectionLimit 扣减逐案对齐）
const pgTracker = vi.hoisted(() => ({ count: 0 }));
vi.mock('postgres', async (orig) => {
  const m = await orig<typeof import('postgres')>();
  const wrapped = Object.assign((...args: Parameters<typeof m.default>) => {
    pgTracker.count++;
    return m.default(...args);
  }, m.default);
  return { ...m, default: wrapped };
});

process.env.DOWEL_SECRET ??= 'claims-ratelimit-test-secret-0123456789';

interface Body extends Record<string, unknown> {
  error?: string;
}

interface Inst {
  db: PlatformDb;
  created: ReturnType<typeof createApp>;
  limiter: KeyedLimiter;
  admin: string;
  adminId: string;
  groupId: string;
  instanceId: string;
  call: (
    method: string,
    path: string,
    json?: unknown,
    cookie?: string,
  ) => Promise<{
    status: number;
    data: Body;
    headers: Headers;
    events: (WizardEvent & ExecEvent)[];
  }>;
}

const instances: Inst[] = [];
const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];

const newInstance = async (connectionLimit = 10_000): Promise<Inst> => {
  const db = await openPlatformDb(':memory:');
  const limiter = new KeyedLimiter({ limit: connectionLimit, windowMs: 60_000 });
  const created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: limiter,
  });
  const adminUser = await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  const inst = { db, created, limiter, adminId: adminUser.id } as Inst;
  inst.call = async (method, path, json, cookie = inst.admin) => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await created.app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    let events: (WizardEvent & ExecEvent)[] = [];
    if (res.headers.get('content-type')?.includes('text/event-stream'))
      events = text
        .split('\n\n')
        .filter((x) => x.trim())
        .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
    else
      try {
        data = JSON.parse(text);
      } catch {}
    return { status: res.status, data: data as Body, headers: res.headers, events };
  };
  const loginRes = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  expect(loginRes.status).toBe(200);
  inst.admin = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
  const g = await inst.call('POST', '/api/groups', { slug: 'g', name: '组' });
  expect(g.status).toBe(201);
  inst.groupId = g.data.id as string;
  inst.instanceId = (await readSettings(db)).instanceId;
  instances.push(inst);
  return inst;
};

const drain = async () => {
  for (let i = instances.pop(); i; i = instances.pop()) {
    await i.created.refresher.drain();
    i.created.requests.stop();
    await i.created.webhooks.close();
    await i.created.rooms.flush();
    await i.created.shadows.close();
    await i.created.ha.stop();
    await i.created.bus.close();
    await i.db.close();
  }
  for (let t = targets.pop(); t; t = targets.pop()) await t.close();
};

/** 测量单次请求内 connectionLimiter 实际成功扣减的次数与 connectPg 建立的外部连接次数 */
const measure = async <T>(
  limiter: KeyedLimiter,
  fn: () => Promise<T>,
): Promise<{ res: T; deducted: number; attempts: number; connections: number }> => {
  const beforeConns = pgTracker.count;
  let deducted = 0;
  let attempts = 0;
  const spy = vi.spyOn(limiter, 'attempt').mockImplementation((...args) => {
    attempts++;
    const r = KeyedLimiter.prototype.attempt.apply(limiter, args);
    if (r.allowed) deducted++;
    return r;
  });
  try {
    const res = await fn();
    return { res, deducted, attempts, connections: pgTracker.count - beforeConns };
  } finally {
    spy.mockRestore();
  }
};

describe('attach / claim 连库限速入口校验（不依赖 PG）', () => {
  afterAll(drain);

  test('attach 带 shadowUrl 时入口需 2 槽配额；仅剩 1 槽直接 429 且不建任何外部连接', async () => {
    const inst = await newInstance(1);
    const p = await inst.call('POST', '/api/projects', { name: 'p1', groupId: inst.groupId });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;

    // 非法请求参数（confirmOverwrite 缺 workingSeq）返回 400，不消耗连库配额
    const invalid = await measure(inst.limiter, () =>
      inst.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'bad',
        url: 'postgres://127.0.0.1:1/db',
        production: false,
        allowSameInstance: true,
        confirmOverwrite: true,
      }),
    );
    expect(invalid.res.status).toBe(400);
    expect(invalid.attempts).toBe(0);
    expect(invalid.connections).toBe(0);

    // 带 shadowUrl 需要 2 槽，当前上限为 1 → 入口直接 429，不发起任何外部连接
    const blocked = await measure(inst.limiter, () =>
      inst.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'with-shadow',
        url: 'postgres://127.0.0.1:1/db',
        shadowUrl: 'postgres://127.0.0.1:1/shadow',
        production: false,
        allowSameInstance: false,
      }),
    );
    expect(blocked.res.status).toBe(429);
    expect(Number(blocked.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(blocked.connections).toBe(0);
  });

  test('attach（无 shadowUrl）与 claim 在配额耗尽时返回 429 且不建外部连接', async () => {
    const inst = await newInstance(1);
    const p = await inst.call('POST', '/api/projects', { name: 'p2', groupId: inst.groupId });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;

    // 预插入一个环境行用于测试 claim 的限速拒绝
    const eid = 'env-rate-limit-test';
    const { encrypt } = await import('../src/secrets.ts');
    await inst.db.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
       values ($1, $2, $3, $4, false, true, null)`,
      [eid, pid, 'dev', encrypt('postgres://127.0.0.1:1/db')],
    );

    // 先把唯一 1 槽配额消耗掉
    expect(inst.limiter.attempt(inst.adminId).allowed).toBe(true);

    const blockedAttach = await measure(inst.limiter, () =>
      inst.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'fresh',
        url: 'postgres://127.0.0.1:1/db',
        production: false,
        allowSameInstance: true,
      }),
    );
    expect(blockedAttach.res.status).toBe(429);
    expect(Number(blockedAttach.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(blockedAttach.connections).toBe(0);

    const blockedClaim = await measure(inst.limiter, () =>
      inst.call('POST', `/api/projects/${pid}/environments/${eid}/claim`),
    );
    expect(blockedClaim.res.status).toBe(429);
    expect(Number(blockedClaim.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(blockedClaim.connections).toBe(0);
  });
});

describe.skipIf(!PG_URL)('attach / claim 连库限速与实际建连数对齐（真实 PG）', () => {
  let A: Inst;

  const newTarget = async (prefix = 'clrl') => {
    const t = await createTestDb(prefix);
    targets.push(t);
    return t;
  };

  const tableOf = (m: Model, name = 'orders') => all(m, 'table').find((t) => t.name === name)!.id;

  const createProject = async (inst: Inst, name: string) => {
    const p = await inst.call('POST', '/api/projects', { name, groupId: inst.groupId });
    expect(p.status).toBe(201);
    return p.data.id as string;
  };

  const addEnv = async (inst: Inst, pid: string, name: string, url: string) => {
    const e = await inst.call('POST', `/api/projects/${pid}/environments`, {
      name,
      url,
      production: false,
      allowSameInstance: true,
    });
    expect(e.status, JSON.stringify(e.data)).toBe(201);
    return e.data.id as string;
  };

  const publishN = async (inst: Inst, pid: string, n: number, from = 1) => {
    const out: { id: string; number: number }[] = [];
    for (let i = from; i < from + n; i++) {
      if (i === 1) await addTable(inst.created.rooms, inst.db, pid);
      else
        await editModel(
          inst.created.rooms,
          inst.db,
          pid,
          (m) => void addColumn(m, tableOf(m), { name: `c${i}`, type: 'text' }),
        );
      const r = await inst.call('POST', `/api/projects/${pid}/versions`, { name: `v${i}` });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      out.push({ id: r.data.id as string, number: r.data.number as number });
    }
    return out;
  };

  const exec = async (inst: Inst, pid: string, eid: string, to: string) => {
    const r = await inst.call('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to });
    expect(r.events.at(-1), JSON.stringify(r.events)).toMatchObject({ stage: 'done' });
  };

  const takeoverOne = async (inst: Inst, pid: string, url: string) => {
    const r = await inst.call('POST', '/api/projects/wizard', {
      name: '接手的项目',
      groupId: inst.groupId,
      environments: [{ name: 'dev', url, production: false, allowSameInstance: true }],
      content: { kind: 'takeover', projectId: pid, claim: true },
    });
    expect(r.events.at(-1), JSON.stringify(r.events)).toMatchObject({ stage: 'done' });
  };

  const listEnvs = async (inst: Inst, pid: string) =>
    (await inst.call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];

  beforeAll(async () => {
    A = await newInstance(10_000);
  });

  afterAll(drain);

  test('attach（无历史）：无 shadowUrl 建 1 扣 1、带 shadowUrl 建 2 扣 2，超配额返 429', async () => {
    const fresh1 = await newTarget();
    const fresh2 = await newTarget();
    const shadow = await newTarget('clrl_shd');

    // 无 shadowUrl：配额 1 刚好够 1 次（建 1 扣 1），紧接着第 2 次 429
    const inst1 = await newInstance(1);
    const pid1 = await createProject(inst1, 'plain-no-shadow');
    const r1 = await measure(inst1.limiter, () =>
      inst1.call('POST', `/api/projects/${pid1}/environments/attach`, {
        name: 'staging',
        url: fresh1.url,
        production: false,
        allowSameInstance: true,
      }),
    );
    expect(r1.res.status, JSON.stringify(r1.res.data)).toBe(201);
    expect(r1.res.data as unknown as AttachResult).toMatchObject({ attached: false, claimed: false });
    expect(r1.connections).toBe(1);
    expect(r1.deducted).toBe(1);

    const r1Again = await measure(inst1.limiter, () =>
      inst1.call('POST', `/api/projects/${pid1}/environments/attach`, {
        name: 'staging2',
        url: fresh2.url,
        production: false,
        allowSameInstance: true,
      }),
    );
    expect(r1Again.res.status).toBe(429);
    expect(r1Again.connections).toBe(0);

    // 有 shadowUrl：配额 2 刚好够 1 次（建 2 扣 2），紧接着第 2 次 429
    const inst2 = await newInstance(2);
    const pid2 = await createProject(inst2, 'plain-with-shadow');
    const r2 = await measure(inst2.limiter, () =>
      inst2.call('POST', `/api/projects/${pid2}/environments/attach`, {
        name: 'staging',
        url: fresh2.url,
        shadowUrl: shadow.url,
        production: false,
        allowSameInstance: false,
      }),
    );
    expect(r2.res.status, JSON.stringify(r2.res.data)).toBe(201);
    expect(r2.res.data as unknown as AttachResult).toMatchObject({ attached: false, claimed: false });
    expect(r2.connections).toBe(2);
    expect(r2.deducted).toBe(2);

    const r2Again = await measure(inst2.limiter, () =>
      inst2.call('POST', `/api/projects/${pid2}/environments/attach`, {
        name: 'staging2',
        url: fresh1.url,
        production: false,
        allowSameInstance: true,
      }),
    );
    expect(r2Again.res.status).toBe(429);
    expect(r2Again.connections).toBe(0);
  });

  test('attach（有历史 + 认领，无领先版本）：无 shadowUrl 建 2 扣 2、带 shadowUrl 建 3 扣 3，配额不足时在写库前 429', async () => {
    const dev = await newTarget();
    const prod1 = await newTarget();
    const prod2 = await newTarget();
    const shadow = await newTarget('clrl_shd');

    const pid = await createProject(A, 'attach-history');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const eP1 = await addEnv(A, pid, 'prod1', prod1.url);
    const eP2 = await addEnv(A, pid, 'prod2', prod2.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eDev, chain[1]!.id);
    await exec(A, pid, eP1, chain[1]!.id);
    await exec(A, pid, eP2, chain[1]!.id);

    // 1) 无 shadowUrl：takeover 占 1 槽；总限额 = 2 → 仅剩 1 槽时，提交前扣第 2 槽触发 429，不写平台库也不认领目标库
    const instTight1 = await newInstance(2);
    await takeoverOne(instTight1, pid, dev.url);
    const tight1 = await measure(instTight1.limiter, () =>
      instTight1.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod1',
        url: prod1.url,
        production: false,
        allowSameInstance: true,
        claim: true,
      }),
    );
    expect(tight1.res.status).toBe(429);
    expect(tight1.connections).toBe(1);
    expect(tight1.deducted).toBe(1);
    expect((await listEnvs(instTight1, pid)).map((e) => e.name)).toEqual(['dev']);
    expect(
      (await prod1.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(A.instanceId);

    // 无 shadowUrl：剩余 2 槽 → 成功（建 2 扣 2），配额耗尽
    const instOk1 = await newInstance(3);
    await takeoverOne(instOk1, pid, dev.url);
    const ok1 = await measure(instOk1.limiter, () =>
      instOk1.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod1',
        url: prod1.url,
        production: false,
        allowSameInstance: true,
        claim: true,
      }),
    );
    expect(ok1.res.status, JSON.stringify(ok1.res.data)).toBe(201);
    expect(ok1.res.data as unknown as AttachResult).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 2 },
    });
    expect(ok1.connections).toBe(2);
    expect(ok1.deducted).toBe(2);
    expect(instOk1.limiter.check(instOk1.adminId, 1).allowed).toBe(false);

    // 2) 带 shadowUrl：takeover 占 1 槽；总限额 = 3 → 仅剩 2 槽时，提交前扣第 3 槽触发 429，不写平台库
    const instTight2 = await newInstance(3);
    await takeoverOne(instTight2, pid, dev.url);
    const tight2 = await measure(instTight2.limiter, () =>
      instTight2.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod2',
        url: prod2.url,
        shadowUrl: shadow.url,
        production: false,
        allowSameInstance: false,
        claim: true,
      }),
    );
    expect(tight2.res.status).toBe(429);
    expect(tight2.connections).toBe(2);
    expect(tight2.deducted).toBe(2);
    expect((await listEnvs(instTight2, pid)).map((e) => e.name)).toEqual(['dev']);

    // 带 shadowUrl：剩余 3 槽 → 成功（建 3 扣 3），配额耗尽
    const instOk2 = await newInstance(4);
    await takeoverOne(instOk2, pid, dev.url);
    const ok2 = await measure(instOk2.limiter, () =>
      instOk2.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod2',
        url: prod2.url,
        shadowUrl: shadow.url,
        production: false,
        allowSameInstance: false,
        claim: true,
      }),
    );
    expect(ok2.res.status, JSON.stringify(ok2.res.data)).toBe(201);
    expect(ok2.res.data as unknown as AttachResult).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 2 },
    });
    expect(ok2.connections).toBe(3);
    expect(ok2.deducted).toBe(3);
    expect(instOk2.limiter.check(instOk2.adminId, 1).allowed).toBe(false);
  });

  test('attach（领先版本影子库验证）：带 shadowUrl 建 4 扣 4、同实例影子库建 6 扣 6，配额不足时写库前 429', async () => {
    const dev = await newTarget();
    const prod1 = await newTarget();
    const prod2 = await newTarget();
    const shadow = await newTarget('clrl_shd');

    const pid = await createProject(A, 'attach-ahead');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const eP1 = await addEnv(A, pid, 'prod1', prod1.url);
    const eP2 = await addEnv(A, pid, 'prod2', prod2.url);
    const base = await publishN(A, pid, 1);
    await exec(A, pid, eDev, base[0]!.id);
    await exec(A, pid, eP1, base[0]!.id);
    await exec(A, pid, eP2, base[0]!.id);

    // A 继续发布 v2 并在 prod1 / prod2 上执行，使两者均领先于 dev 的 v1
    const ahead = await publishN(A, pid, 1, 2);
    await exec(A, pid, eP1, ahead[0]!.id);
    await exec(A, pid, eP2, ahead[0]!.id);

    // 1) 带独立 shadowUrl：需 4 个外部连接（probe 1 + claimShadow 1 + pgShadow 1 + claim&sync 1）
    // takeover 占 1 槽；限额 4 → 仅剩 3 槽，在写平台库前返回 429（无写入）
    const instShadowTight = await newInstance(4);
    await takeoverOne(instShadowTight, pid, dev.url);
    const st = await measure(instShadowTight.limiter, () =>
      instShadowTight.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod1',
        url: prod1.url,
        shadowUrl: shadow.url,
        production: false,
        allowSameInstance: false,
        claim: true,
      }),
    );
    expect(st.res.status).toBe(429);
    expect(st.connections).toBe(3);
    expect(st.deducted).toBe(3);
    expect((await listEnvs(instShadowTight, pid)).map((e) => e.name)).toEqual(['dev']);

    // 限额 5（takeover 1 + attach 4）→ 成功（建 4 扣 4）
    const instShadowOk = await newInstance(5);
    await takeoverOne(instShadowOk, pid, dev.url);
    const so = await measure(instShadowOk.limiter, () =>
      instShadowOk.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod1',
        url: prod1.url,
        shadowUrl: shadow.url,
        production: false,
        allowSameInstance: false,
        claim: true,
      }),
    );
    expect(so.res.status, JSON.stringify(so.res.data)).toBe(201);
    expect(so.res.data as unknown as AttachResult).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 2 },
    });
    expect(so.connections).toBe(4);
    expect(so.deducted).toBe(4);
    expect(instShadowOk.limiter.check(instShadowOk.adminId, 1).allowed).toBe(false);

    // 2) 无独立 shadowUrl（走同实例影子库）：需 6 个外部连接（probe 1 + ensureSameInstanceShadow 3 + pgShadow 1 + claim&sync 1）
    // takeover 占 1 槽；限额 6 → 仅剩 5 槽，在写平台库前返回 429（无写入）
    const instSameTight = await newInstance(6);
    await takeoverOne(instSameTight, pid, dev.url);
    const smt = await measure(instSameTight.limiter, () =>
      instSameTight.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod2',
        url: prod2.url,
        production: false,
        allowSameInstance: true,
        claim: true,
      }),
    );
    expect(smt.res.status).toBe(429);
    expect(smt.deducted).toBe(5);
    expect((await listEnvs(instSameTight, pid)).map((e) => e.name)).toEqual(['dev']);

    // 限额 7（takeover 1 + attach 6）→ 成功（建 6 扣 6）
    const instSameOk = await newInstance(7);
    await takeoverOne(instSameOk, pid, dev.url);
    const smo = await measure(instSameOk.limiter, () =>
      instSameOk.call('POST', `/api/projects/${pid}/environments/attach`, {
        name: 'prod2',
        url: prod2.url,
        production: false,
        allowSameInstance: true,
        claim: true,
      }),
    );
    expect(smo.res.status, JSON.stringify(smo.res.data)).toBe(201);
    expect(smo.res.data as unknown as AttachResult).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 2 },
    });
    expect(smo.connections).toBe(6);
    expect(smo.deducted).toBe(6);
    expect(instSameOk.limiter.check(instSameOk.adminId, 1).allowed).toBe(false);
  });

  test('claim 复用单条连接完成接入检查、认领与状态同步：建 1 扣 1，配额耗尽后返 429', async () => {
    const dev = await newTarget();
    const pid = await createProject(A, 'claim-reuse');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eDev, chain[1]!.id);

    // B 接手并认领 dev 后，再让 A 反向认领；这里给一个独立实例 C 接手后由 A 认领，再由 C 认领
    const instC = await newInstance(2);
    // takeover 消耗 1 槽，剩余 1 槽留给后续 /claim
    await takeoverOne(instC, pid, dev.url);
    const [envC] = await listEnvs(instC, pid);

    // 先由 A 抢回认领，让 C 的 /claim 真正发生一次换手（changed = true）
    const reclaimA = await A.call('POST', `/api/projects/${pid}/environments/${eDev}/claim`);
    expect(reclaimA.status).toBe(200);
    expect((reclaimA.data as unknown as ClaimResult).changed).toBe(true);

    // C 用仅剩的 1 槽配额调用 /claim：复用单条连接完成 inspectAttach + claimInstance + syncTargetOn
    const claim1 = await measure(instC.limiter, () =>
      instC.call('POST', `/api/projects/${pid}/environments/${envC!.id}/claim`),
    );
    expect(claim1.res.status, JSON.stringify(claim1.res.data)).toBe(200);
    expect(claim1.res.data as unknown as ClaimResult).toMatchObject({
      changed: true,
      previousInstanceId: A.instanceId,
    });
    expect(claim1.connections).toBe(1);
    expect(claim1.deducted).toBe(1);

    // 紧接着第 2 次 /claim：配额已耗尽 → 429，且不建新连接
    const claim2 = await measure(instC.limiter, () =>
      instC.call('POST', `/api/projects/${pid}/environments/${envC!.id}/claim`),
    );
    expect(claim2.res.status).toBe(429);
    expect(Number(claim2.res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(claim2.connections).toBe(0);
  });
});
