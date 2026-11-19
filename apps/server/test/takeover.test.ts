// P4c：接手（H5）、多环境合并、认领、预演（dry run）。真实 PG；用两个 createApp（各有自己的平台库和实例标识）
// 模拟“实例 A 写过的库被实例 B 接手”。没有 Docker 时跳过。
import type {
  AttachResult,
  ClaimResult,
  DryRunResponse,
  EnvHistory,
  EnvInfo,
  ExecEvent,
  TakeoverInspectResult,
  VersionInfo,
  WizardEvent,
} from '@dowel/api';
import { addColumn, all, type Model, renameColumn } from '@dowel/core';
import { type Db, ensureHistory, recordVersion, stepsChecksum } from '@dowel/engines';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { versionExecutedAnywhere } from '../src/chain.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { readSettings } from '../src/settings.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

// 读平台版本链可以按需失败一次（接手提交之后、认领之前）：项目已经建好，认领只能作为警告失败
const chainStub = vi.hoisted(() => ({ failNext: false, calls: 0 }));
vi.mock('../src/envs.ts', async (orig) => {
  const m = await orig<typeof import('../src/envs.ts')>();
  return {
    ...m,
    loadChain: (...a: Parameters<typeof m.loadChain>) => {
      chainStub.calls++;
      if (chainStub.failNext) {
        chainStub.failNext = false;
        throw new Error('boom: platform db went away');
      }
      return m.loadChain(...a);
    },
  };
});

process.env.DOWEL_SECRET ??= 'takeover-test-secret-0123456789';

interface Body extends Record<string, unknown> {
  error?: string;
}

interface Inst {
  name: string;
  db: PlatformDb;
  created: ReturnType<typeof createApp>;
  admin: string;
  /** 实例管理员以外的项目管理员 */
  pa: string;
  groupId: string;
  instanceId: string;
  call: (
    method: string,
    path: string,
    json?: unknown,
    cookie?: string,
  ) => Promise<{ status: number; data: Body; events: (WizardEvent & ExecEvent)[] }>;
}

const instances: Inst[] = [];
const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];

const newInstance = async (name: string): Promise<Inst> => {
  const db = await openPlatformDb(':memory:');
  const created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
  });
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  const paUser = await makeUser(db, 'pa', { name: '项目管理员' });
  const inst = { name, db, created } as Inst;
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
    return { status: res.status, data: data as Body, events };
  };
  const login = async (username: string) => {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  };
  inst.admin = await login('admin');
  inst.pa = await login('pa');
  const g = await inst.call('POST', '/api/groups', { slug: 'g', name: '组' });
  expect(g.status).toBe(201);
  inst.groupId = g.data.id as string;
  // 项目管理员要能在这个组建项目
  await inst.call('POST', '/api/groups/g/members', { username: 'pa' });
  void paUser;
  inst.instanceId = (await readSettings(db)).instanceId;
  instances.push(inst);
  return inst;
};

const newTarget = async (prefix = 'tk') => {
  const t = await createTestDb(prefix);
  targets.push(t);
  return t;
};

const tableOf = (m: Model, name = 'orders') => all(m, 'table').find((t) => t.name === name)!.id;

/** 实例上的一个项目：建项目、加环境、发布 n 个版本（v1 建 orders，之后每个版本加一列 c<i>） */
const project = async (inst: Inst, name: string, scope?: string[]) => {
  const p = await inst.call('POST', '/api/projects', { name, groupId: inst.groupId });
  expect(p.status).toBe(201);
  const pid = p.data.id as string;
  if (scope) expect((await inst.call('PATCH', `/api/projects/${pid}`, { schemas: scope })).status).toBe(200);
  return pid;
};
const addEnv = async (inst: Inst, pid: string, name: string, url: string, production = false) => {
  const e = await inst.call('POST', `/api/projects/${pid}/environments`, {
    name,
    url,
    production,
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
    expect(r.data.verified).toBe(true);
    out.push({ id: r.data.id as string, number: r.data.number as number });
  }
  return out;
};
const exec = async (
  inst: Inst,
  pid: string,
  eid: string,
  action: 'execute' | 'rollback',
  to: string,
  extra: Record<string, unknown> = {},
) => {
  const r = await inst.call('POST', `/api/projects/${pid}/environments/${eid}/${action}`, { to, ...extra });
  return { ...r, last: r.events.at(-1)! };
};
const wizard = async (inst: Inst, body: unknown, cookie = inst.admin) => {
  const r = await inst.call('POST', '/api/projects/wizard', body, cookie);
  return { ...r, last: r.events.at(-1)! };
};
const takeover = (
  inst: Inst,
  projectId: string,
  envs: { name: string; url: string; production?: boolean }[],
  extra: { claim?: boolean; name?: string } = {},
  cookie = inst.admin,
) =>
  wizard(
    inst,
    {
      name: extra.name ?? '接手的项目',
      groupId: inst.groupId,
      environments: envs.map((e) => ({
        name: e.name,
        url: e.url,
        production: e.production ?? false,
        allowSameInstance: true,
      })),
      content: { kind: 'takeover', projectId, claim: extra.claim },
    },
    cookie,
  );
const modelOf = async (inst: Inst, pid: string): Promise<Model> => {
  const [b] = await inst.db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
  return (await inst.created.rooms.model(b!.id)).model;
};
const versionModel = async (inst: Inst, vid: string) =>
  (await inst.db.query<{ model: Model }>('select model from versions where id = $1', [vid]))[0]!.model;
const history = async (inst: Inst, pid: string, eid: string) =>
  (await inst.call('GET', `/api/projects/${pid}/environments/${eid}/history`)).data as unknown as EnvHistory;
const envs = async (inst: Inst, pid: string) =>
  (await inst.call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
const columns = async (db: Db) =>
  (
    await db.query<{ c: string }>(
      `select column_name::text as c from information_schema.columns
        where table_schema = 'public' and table_name = 'orders' order by ordinal_position`,
    )
  ).map((r) => r.c);

/** 关掉到目前为止建的实例和目标库（两个 describe 各调一次，幂等） */
const drain = async () => {
  for (let i = instances.pop(); i; i = instances.pop()) {
    await i.created.rooms.flush();
    await i.created.shadows.close();
    await i.db.close();
  }
  for (let t = targets.pop(); t; t = targets.pop()) await t.close();
};

describe.skipIf(!PG_URL)('接手与认领（P4c）', () => {
  let A: Inst;
  let B: Inst;

  beforeAll(async () => {
    A = await newInstance('A');
    B = await newInstance('B');
    expect(A.instanceId).not.toBe(B.instanceId);
  });

  afterAll(drain);

  test('验收：A 发布 v1~v3 并执行 → B 接手：模型与对象 ID 完全相同 → B 改列名发布 v4 是 RENAME → B 执行成功；认领之后 A 被拒绝，只读的检查照常', async () => {
    const dev = await newTarget();
    const pid = await project(A, '商城');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 3);
    expect((await exec(A, pid, eidA, 'execute', chain[2]!.id)).last.stage).toBe('done');

    // 接手前先看这个库登记过什么
    const insp = await B.call('POST', '/api/takeover/inspect', { url: dev.url, groupId: B.groupId });
    expect(insp.status).toBe(200);
    const info = insp.data as unknown as TakeoverInspectResult;
    expect(info.hasHistory).toBe(true);
    expect(info.projects).toHaveLength(1);
    expect(info.projects[0]).toMatchObject({
      projectId: pid,
      name: '商城',
      claimedBy: A.instanceId,
      mine: false,
      versions: 3,
      headNumber: 3,
      currentNumber: 3,
      existsHere: false,
    });
    expect(info.instanceId).toBe(B.instanceId);

    // 没有确认认领：拒绝，什么都没建，目标库的认领也没变
    const refused = await takeover(B, pid, [{ name: 'dev', url: dev.url }]);
    expect(refused.last).toMatchObject({ stage: 'read', code: 'claim_required' });
    expect((await B.call('GET', '/api/projects')).data).toEqual([]);
    const claimRows = async () =>
      dev.db.query<{ instance_id: string }>(
        `select instance_id from dowel.projects where project_id = '${pid}'`,
      );
    expect(await claimRows()).toEqual([{ instance_id: A.instanceId }]);

    // 实例管理员确认认领
    const done = await takeover(B, pid, [{ name: 'dev', url: dev.url }], { claim: true });
    expect(done.last, JSON.stringify(done.events)).toMatchObject({ stage: 'done' });
    expect(done.last.warnings).toBeUndefined();
    expect(done.last.project!.id).toBe(pid);
    expect(done.events.map((e) => e.stage)).toEqual(['connect', 'read', 'write', 'claim', 'done']);

    // 版本链完整恢复：id、序号、parent、冻结脚本、checksum 一致，模型深度相等（对象 ID 完全相同）
    const rowsA = await A.db.query<Record<string, unknown>>(
      'select id, number, parent_id, name, model, up_steps, down_steps, checksum from versions where project_id = $1 order by number',
      [pid],
    );
    const rowsB = await B.db.query<Record<string, unknown>>(
      'select id, number, parent_id, name, model, up_steps, down_steps, checksum from versions where project_id = $1 order by number',
      [pid],
    );
    expect(rowsB).toEqual(rowsA);
    // 工作副本 = 链头版本的模型
    expect(await modelOf(B, pid)).toEqual(await versionModel(A, chain[2]!.id));
    expect(await modelOf(B, pid)).toEqual(await versionModel(B, chain[2]!.id));
    // 恢复的版本一律未验证、标了恢复时间；执行过的事实（executed_at）已经写上
    const vs = (await B.call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
    expect(vs.map((v) => [v.number, v.verifiedAt, v.restoredAt !== null])).toEqual([
      [3, null, true],
      [2, null, true],
      [1, null, true],
    ]);
    for (const v of chain) expect(await versionExecutedAnywhere(B.db, v.id)).toBe(true);
    // 环境当前版本 = 目标库历史里最后完成的版本
    const [envB] = await envs(B, pid);
    expect(envB!.currentVersion).toMatchObject({ id: chain[2]!.id, number: 3 });
    expect(envB!.drift.status).toBe('ok');
    const eidB = envB!.id;

    // 认领写进目标库：项目行换手、claims 里追加一条事件
    expect(await claimRows()).toEqual([{ instance_id: B.instanceId }]);
    const claims = await dev.db.query<Record<string, unknown>>(
      'select instance_id, previous_instance_id, claimed_by_name from dowel.claims',
    );
    expect(claims).toEqual([
      { instance_id: B.instanceId, previous_instance_id: A.instanceId, claimed_by_name: '管理员' },
    ]);

    // A 之后执行被拒绝（foreign_instance）；读历史、漂移检查仍然正常
    const rejected = await exec(A, pid, eidA, 'rollback', chain[1]!.id);
    expect(rejected.last).toMatchObject({ code: 'foreign_instance' });
    expect(rejected.last.error).toContain(B.instanceId);
    expect(await columns(dev.db)).toEqual(['id', 'c2', 'c3']);
    const hA = await history(A, pid, eidA);
    expect(hA.claim).toMatchObject({
      mine: false,
      instanceId: B.instanceId,
      previousInstanceId: A.instanceId,
    });
    expect(hA.claims).toHaveLength(1);
    expect(hA.runs.length).toBeGreaterThan(0);
    const driftA = await A.call('POST', `/api/projects/${pid}/environments/${eidA}/drift-check`);
    expect(driftA.status).toBe(200);
    expect(driftA.data.status).toBe('ok');
    // 干跑也报同样的原因
    const dryA = (
      await A.call('POST', `/api/projects/${pid}/environments/${eidA}/rollback`, {
        to: chain[1]!.id,
        dryRun: true,
      })
    ).data as unknown as DryRunResponse;
    expect(dryA).toMatchObject({ ok: false, code: 'foreign_instance' });

    // B 在模型里把 c2 改名，发布 v4：冻结的 up 是 RENAME COLUMN，不是先删后加
    await editModel(B.created.rooms, B.db, pid, (m) => {
      const col = all(m, 'column').find((c) => c.parent === tableOf(m) && c.name === 'c2')!;
      renameColumn(m, col.id, 'memo');
    });
    const v4 = await B.call('POST', `/api/projects/${pid}/versions`, { name: 'v4 改名' });
    expect(v4.status, JSON.stringify(v4.data)).toBe(201);
    expect(v4.data.verified).toBe(true);
    const detail = (await B.call('GET', `/api/projects/${pid}/versions/${v4.data.id as string}`))
      .data as unknown as { upSteps: { sql: string }[] };
    expect(detail.upSteps.map((s) => s.sql)).toEqual([
      expect.stringMatching(/RENAME COLUMN "?c2"? TO "?memo"?/i),
    ]);
    expect(detail.upSteps.join(' ')).not.toMatch(/DROP COLUMN|ADD COLUMN/i);
    // B 执行成功（v1~v3 已经在这个库里，只跑 v4）
    const run = await exec(B, pid, eidB, 'execute', v4.data.id as string);
    expect(run.last, JSON.stringify(run.events)).toMatchObject({ stage: 'done', ran: 1 });
    expect(await columns(dev.db)).toEqual(['id', 'memo', 'c3']);
    // 数据保留：RENAME 不是重建（目标库的行数据不受影响由结构保证；这里看 history 里只多了一条记录）
    const hB = await history(B, pid, eidB);
    expect(hB.currentVersion).toMatchObject({ number: 4 });
    expect(hB.claim).toMatchObject({ mine: true });
  });

  test('恢复的版本未验证：不能回滚到它；重新验证（影子库）之后才行', async () => {
    const dev = await newTarget();
    const inst = await newInstance('C');
    const pid = await project(A, '待验证');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eidA, 'execute', chain[1]!.id);
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last).toMatchObject({
      stage: 'done',
    });
    const [e] = await envs(inst, pid);
    const rb = await exec(inst, pid, e!.id, 'rollback', chain[0]!.id);
    expect(rb.last).toMatchObject({ code: 'unverified' });
    // 重新验证 v2（版本页的“重新验证”）：恢复的 scope 用来建 from，通过后才能回滚
    const re = await inst.call('POST', `/api/projects/${pid}/versions/${chain[1]!.id}/verify`);
    expect(re.status, JSON.stringify(re.data)).toBe(200);
    expect(re.data.verifiedAt).not.toBeNull();
    const rb2 = await exec(inst, pid, e!.id, 'rollback', chain[0]!.id);
    expect(rb2.last, JSON.stringify(rb2.events)).toMatchObject({ stage: 'done', ran: 1 });
  });

  test('schema 范围随版本恢复：项目的范围 = 链头版本冻结时的范围', async () => {
    const dev = await newTarget();
    const inst = await newInstance('D');
    const pid = await project(A, '带范围', ['public']);
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eidA, 'execute', chain[1]!.id);
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    const [p] = await inst.db.query<{ schemas: string[] | null }>(
      'select schemas from projects where id = $1',
      [pid],
    );
    expect(p!.schemas).toEqual(['public']);
    const scopes = await inst.db.query<{ scope: string[] | null }>(
      'select scope from versions where project_id = $1 order by number',
      [pid],
    );
    expect(scopes.map((s) => s.scope)).toEqual([['public'], ['public']]);
  });

  test('多环境合并：dev 在 v3、prod 在 v2 → 链是 v1~v3，两个环境各自的当前版本正确', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('M');
    const pid = await project(A, '多环境');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eDev, 'execute', chain[2]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);

    // 只给落后的 prod：链只有 v1~v2
    const onlyProd = await newInstance('M1');
    const r1 = await takeover(onlyProd, pid, [{ name: 'prod', url: prod.url }], { claim: true });
    expect(r1.last.stage).toBe('done');
    expect((await onlyProd.db.query('select 1 from versions where project_id = $1', [pid])).length).toBe(2);
    // 认领之后 A 对 prod 的执行被拒绝，dev 仍然是 A 的
    expect((await exec(A, pid, ePro, 'execute', chain[2]!.id)).last).toMatchObject({
      code: 'foreign_instance',
    });
    expect((await exec(A, pid, eDev, 'rollback', chain[1]!.id)).last).toMatchObject({ stage: 'done' });
    await exec(A, pid, eDev, 'execute', chain[2]!.id);

    const done = await takeover(
      inst,
      pid,
      [
        { name: 'dev', url: dev.url },
        { name: 'prod', url: prod.url, production: true },
      ],
      { claim: true },
    );
    expect(done.last, JSON.stringify(done.events)).toMatchObject({ stage: 'done' });
    const vs = (await inst.call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
    expect(vs.map((v) => v.number).sort()).toEqual([1, 2, 3]);
    const list = await envs(inst, pid);
    const by = Object.fromEntries(list.map((e) => [e.name, e.currentVersion?.number]));
    expect(by).toEqual({ dev: 3, prod: 2 });
    // 各自“执行过哪些版本”：prod 没执行过 v3，但 v3 在 dev 上执行过，所以 v3 整体已冻结
    const stProd = (
      await inst.call(
        'GET',
        `/api/projects/${pid}/environments/${list.find((e) => e.name === 'prod')!.id}/status`,
      )
    ).data as unknown as { versions: { number: number; executedHere: boolean; state: string }[] };
    expect(stProd.versions.map((v) => [v.number, v.executedHere, v.state])).toEqual([
      [1, true, 'applied'],
      [2, true, 'current'],
      [3, false, 'pending'],
    ]);
    for (const v of chain) expect(await versionExecutedAnywhere(inst.db, v.id)).toBe(true);
    // 两个库都已被 inst 认领（dev 的项目行也换手）
    for (const t of [dev, prod]) {
      const [row] = await t.db.query<{ instance_id: string }>(
        'select instance_id from dowel.projects where project_id = $1',
        [pid],
      );
      expect(row!.instance_id).toBe(inst.instanceId);
    }
  });

  test('接手提交之后读版本链失败：项目已经建好，每个需要认领的环境各一条 warning，库没被认领；初始漂移检查照常尝试', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('LC');
    const pid = await project(A, '链读取失败');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eDev, 'execute', chain[1]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);
    chainStub.failNext = true;
    chainStub.calls = 0;
    let r: Awaited<ReturnType<typeof takeover>>;
    try {
      r = await takeover(
        inst,
        pid,
        [
          { name: 'dev', url: dev.url },
          { name: 'prod', url: prod.url },
        ],
        { claim: true },
      );
    } finally {
      chainStub.failNext = false;
    }
    expect(r.last, JSON.stringify(r.events)).toMatchObject({ stage: 'done' });
    const warnings = (r.last as unknown as { warnings?: string[] }).warnings ?? [];
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('环境“dev”认领失败：读取版本链出错');
    expect(warnings[1]).toContain('环境“prod”认领失败：读取版本链出错');
    expect(warnings.join('')).toContain('可以在环境页重试');
    // 项目建好了，平台上有版本和两个环境；库没有被认领（原实例照样能执行）
    expect((await envs(inst, pid)).map((e) => e.name).sort()).toEqual(['dev', 'prod']);
    for (const t of [dev, prod]) {
      const [row] = await t.db.query<{ instance_id: string }>(
        'select instance_id from dowel.projects where project_id = $1',
        [pid],
      );
      expect(row!.instance_id).toBe(A.instanceId);
    }
    // 读链失败的那一次之后，每个环境的初始漂移检查仍然尝试了（各自再读一次链），状态已更新
    expect(chainStub.calls).toBeGreaterThanOrEqual(3);
    for (const e of await envs(inst, pid)) expect(e.drift.checkedAt).not.toBeNull();
    expect((await exec(A, pid, eDev, 'rollback', chain[0]!.id)).last).toMatchObject({ stage: 'done' });
  });

  /** 在目标库历史里手工塞一行版本（checksum 与脚本自洽，所以过得了 verifyChain） */
  const plant = async (
    t: { db: Db },
    pid: string,
    over: { id: string; number: number; parent: string | null; up: string; model: Model },
  ) => {
    const up = [{ sql: over.up, transactional: true }];
    const down: typeof up = [];
    await recordVersion(t.db, {
      projectId: pid,
      versionId: over.id,
      number: over.number,
      parentId: over.parent,
      name: `分叉的 v${over.number}`,
      scope: null,
      upSteps: up,
      downSteps: down,
      checksum: stepsChecksum(up, down),
      model: over.model,
      fingerprint: 'f',
      publishedAt: new Date().toISOString(),
      publishedBy: null,
    });
  };

  test('链分叉（两个环境在同一个父版本下有不同的子版本）→ 拒绝接手，什么都不建、不认领', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('F');
    const pid = await project(A, '分叉');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eDev, 'execute', chain[2]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);
    // prod 的 v2 之后是另一个 v3'
    await plant(prod, pid, {
      id: 'forked-v3',
      number: 3,
      parent: chain[1]!.id,
      up: 'ALTER TABLE public.orders ADD COLUMN other text',
      model: await versionModel(A, chain[1]!.id),
    });
    const r = await takeover(
      inst,
      pid,
      [
        { name: 'dev', url: dev.url },
        { name: 'prod', url: prod.url },
      ],
      { claim: true },
    );
    expect(r.last).toMatchObject({ stage: 'read', code: 'history_fork' });
    expect(r.last.error).toContain('分叉');
    expect((await inst.call('GET', '/api/projects')).data).toEqual([]);
    const [row] = await dev.db.query<{ instance_id: string }>(
      'select instance_id from dowel.projects where project_id = $1',
      [pid],
    );
    expect(row!.instance_id).toBe(A.instanceId);
    expect(await dev.db.query('select 1 from dowel.claims')).toEqual([]);
  });

  test('同一个版本 ID 的内容（模型）不一致 → 拒绝；checksum 被篡改 → 拒绝（按内容重算）', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('T');
    const pid = await project(A, '篡改');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eDev, 'execute', chain[1]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);

    // 模型不一致：改 prod 里 v2 的模型（checksum 只覆盖脚本，所以单环境的 verifyChain 看不出来，合并时才发现）
    const m = await versionModel(A, chain[1]!.id);
    const other = structuredClone(m);
    const col = all(other, 'column').find((c) => c.name === 'c2')!;
    col.name = 'c2_changed';
    await prod.db.query('update dowel.versions set model = $2::text::jsonb where version_id = $1', [
      chain[1]!.id,
      JSON.stringify(other),
    ]);
    const conflict = await takeover(
      inst,
      pid,
      [
        { name: 'dev', url: dev.url },
        { name: 'prod', url: prod.url },
      ],
      { claim: true },
    );
    expect(conflict.last).toMatchObject({ code: 'history_conflict' });
    expect(conflict.last.error).toContain('模型');
    await prod.db.query('update dowel.versions set model = $2::text::jsonb where version_id = $1', [
      chain[1]!.id,
      JSON.stringify(m),
    ]);

    // 篡改 checksum（脚本没动）：重算对不上 → 拒绝，目标库不动
    await dev.db.query("update dowel.versions set checksum = repeat('0', 64) where version_id = $1", [
      chain[0]!.id,
    ]);
    const tampered = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true });
    expect(tampered.last).toMatchObject({ stage: 'read', code: 'history_broken' });
    expect(tampered.last.error).toMatch(/校验和|checksum/);
    expect((await inst.call('GET', '/api/projects')).data).toEqual([]);
    const [row] = await dev.db.query<{ instance_id: string }>(
      'select instance_id from dowel.projects where project_id = $1',
      [pid],
    );
    expect(row!.instance_id).toBe(A.instanceId);
    // 篡改脚本（checksum 没动）同样被发现
    await dev.db.query('update dowel.versions set checksum = $2 where version_id = $1', [
      chain[0]!.id,
      (
        await A.db.query<{ checksum: string }>('select checksum from versions where id = $1', [chain[0]!.id])
      )[0]!.checksum,
    ]);
    await dev.db.query(
      `update dowel.versions set up_steps = '[{"sql":"DROP SCHEMA public CASCADE","transactional":true}]'::jsonb where version_id = $1`,
      [chain[0]!.id],
    );
    const tampered2 = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true });
    expect(tampered2.last).toMatchObject({ code: 'history_broken' });
  });

  test('权限：接手需要在组里有建项目权限；认领另一个实例的库需要实例管理员并明确确认', async () => {
    const dev = await newTarget();
    const inst = await newInstance('P');
    const pid = await project(A, '权限');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 1);
    await exec(A, pid, eidA, 'execute', chain[0]!.id);
    // 组外的人（没有任何组）连检查都不行
    await makeUser(inst.db, 'outsider', { name: '外人' });
    const res = await inst.created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'outsider', password: PASSWORD }),
    });
    const outsider = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(
      (await inst.call('POST', '/api/takeover/inspect', { url: dev.url, groupId: inst.groupId }, outsider))
        .status,
    ).toBe(403);
    expect(
      (await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true }, outsider)).status,
    ).toBe(403);
    // 组成员（项目管理员，不是实例管理员）：能接手没人认领过的库，但认领别的实例的库要实例管理员
    const forbidden = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true }, inst.pa);
    expect(forbidden.last).toMatchObject({ code: 'claim_forbidden' });
    expect((await inst.call('GET', '/api/projects')).data).toEqual([]);
    // 实例管理员确认之后成功
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    // 已经接手过：再接手同一个项目 → project_exists
    const again = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true }, inst.admin);
    expect(again.last).toMatchObject({ code: 'project_exists' });
  });

  test('本实例自己的项目（项目被删、平台库还在）：不需要认领，恢复后 mine', async () => {
    const dev = await newTarget();
    const inst = await newInstance('S');
    const pid = await project(inst, '自己的');
    const eid = await addEnv(inst, pid, 'dev', dev.url);
    const chain = await publishN(inst, pid, 2);
    await exec(inst, pid, eid, 'execute', chain[1]!.id);
    const slug = (await inst.call('GET', `/api/projects/${pid}`)).data.slug as string;
    expect((await inst.call('DELETE', `/api/projects/${pid}`, { confirm: slug })).status).toBe(200);
    // 项目没了，但目标库里的历史还在，认领的就是本实例：不需要确认认领
    const insp = (await inst.call('POST', '/api/takeover/inspect', { url: dev.url, groupId: inst.groupId }))
      .data as unknown as TakeoverInspectResult;
    expect(insp.projects[0]).toMatchObject({ mine: true, existsHere: false });
    const r = await takeover(inst, pid, [{ name: 'dev', url: dev.url }]);
    expect(r.last, JSON.stringify(r.events)).toMatchObject({ stage: 'done' });
    expect(r.events.map((e) => e.stage)).not.toContain('claim');
    expect(await dev.db.query('select 1 from dowel.claims')).toEqual([]);
    const [e] = await envs(inst, pid);
    expect(e!.currentVersion).toMatchObject({ number: 2 });
  });

  test('认领与反向认领：A 被拒绝后，A 的实例管理员认领回来 → B 被拒绝；认领事件追加两条', async () => {
    const dev = await newTarget();
    const inst = await newInstance('X');
    const pid = await project(A, '来回认领');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eidA, 'execute', chain[1]!.id);
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    const [envX] = await envs(inst, pid);
    expect((await exec(A, pid, eidA, 'rollback', chain[0]!.id)).last).toMatchObject({
      code: 'foreign_instance',
    });

    // 不是实例管理员：403（项目管理员也不行）
    expect((await A.call('POST', `/api/projects/${pid}/environments/${eidA}/claim`, {}, A.pa)).status).toBe(
      403,
    );
    expect((await A.call('POST', `/api/projects/${pid}/environments/${eidA}/claim`)).status).toBe(200);
    // A 执行恢复；X 被拒绝
    const back = await exec(A, pid, eidA, 'rollback', chain[0]!.id);
    expect(back.last, JSON.stringify(back.events)).toMatchObject({ stage: 'done' });
    expect((await exec(inst, pid, envX!.id, 'execute', chain[1]!.id)).last).toMatchObject({
      code: 'foreign_instance',
    });
    const claims = await dev.db.query<{ instance_id: string; previous_instance_id: string | null }>(
      'select instance_id, previous_instance_id from dowel.claims order by id',
    );
    expect(claims).toEqual([
      { instance_id: inst.instanceId, previous_instance_id: A.instanceId },
      { instance_id: A.instanceId, previous_instance_id: inst.instanceId },
    ]);
    // 再认领一次：本来就是 A 的，什么都不写
    const again = await A.call('POST', `/api/projects/${pid}/environments/${eidA}/claim`);
    expect((again.data as unknown as ClaimResult).changed).toBe(false);
    expect(await dev.db.query('select 1 from dowel.claims')).toHaveLength(2);
    // history 表是只追加的：认领没有改写任何执行记录（执行记录里的实例仍然是当时执行的 A）
    const hist = await dev.db.query<{ instance_id: string }>(
      'select distinct instance_id from dowel.history',
    );
    expect(hist.map((h) => h.instance_id)).toEqual([A.instanceId]);
  });

  test('添加环境并接入已有历史（特权）：对不上的历史 422、别的实例认领的要确认、没有历史的只是新环境', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const fresh = await newTarget();
    const other = await newTarget();
    const inst = await newInstance('Y');
    const pid = await project(A, '接入');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eDev, 'execute', chain[2]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);
    // inst 只接手 dev（链是 v1~v3），之后再把 prod 接入
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    const attach = (body: Record<string, unknown>, cookie = inst.admin) =>
      inst.call(
        'POST',
        `/api/projects/${pid}/environments/attach`,
        {
          production: false,
          allowSameInstance: true,
          ...body,
        },
        cookie,
      );

    // 没有历史的库：只是一个新环境
    const plain = await attach({ name: 'staging', url: fresh.url });
    expect(plain.status, JSON.stringify(plain.data)).toBe(201);
    expect(plain.data as unknown as AttachResult).toMatchObject({
      attached: false,
      claimed: false,
      currentVersion: null,
    });
    // 同一个项目 ID 的历史，但版本不在平台的链上（来自另一份项目副本）：422
    await ensureHistory(other.db);
    await plant(other, pid, {
      id: 'alien-v1',
      number: 1,
      parent: null,
      up: 'CREATE TABLE alien (id int)',
      model: await versionModel(A, chain[0]!.id),
    });
    const foreign = await attach({ name: 'other', url: other.url });
    expect(foreign.status).toBe(422);
    expect(foreign.data.error).toMatch(/不在平台库的版本链上|不一致/);
    // 由 A 认领的 prod：不确认 → 409 claim_required；项目管理员（不是实例管理员）→ 403；确认 → 201，当前版本 v2
    const need = await attach({ name: 'prod', url: prod.url, production: true });
    expect(need.status).toBe(409);
    expect(need.data.code).toBe('claim_required');
    expect(await prod.db.query('select 1 from dowel.claims')).toEqual([]);
    const nope = await attach({ name: 'prod', url: prod.url, claim: true }, inst.pa);
    expect(nope.status).toBe(403); // pa 是组成员（默认权限：编辑者），不是项目管理员：接入已有历史至少要项目管理员
    const ok = await attach({ name: 'prod', url: prod.url, claim: true });
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
    expect(ok.data as unknown as AttachResult).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 2 },
    });
    const list = await envs(inst, pid);
    expect(Object.fromEntries(list.map((e) => [e.name, e.currentVersion?.number ?? null]))).toEqual({
      dev: 3,
      prod: 2,
      staging: null,
    });
    // 认领已写入 prod：A 对 prod 被拒绝
    expect((await exec(A, pid, ePro, 'execute', chain[2]!.id)).last).toMatchObject({
      code: 'foreign_instance',
    });
  });

  /** 目标库里的一个受限账号：能连、能读 public；dowel schema 的权限按 dowel 参数给（none / usage / read / write） */
  const limitedRole = async (
    t: Awaited<ReturnType<typeof createTestDb>>,
    dowel: 'none' | 'usage' | 'read' | 'write',
  ) => {
    const role = `tk_r_${Math.random().toString(36).slice(2, 8)}`;
    const admin = connect(PG_URL);
    try {
      await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'pw'`);
    } finally {
      await admin.close();
    }
    const name = new URL(t.url).pathname.slice(1);
    await t.db.exec(`GRANT CONNECT ON DATABASE ${name} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}`);
    if (dowel !== 'none') await t.db.exec(`GRANT USAGE ON SCHEMA dowel TO ${role}`);
    if (dowel === 'read' || dowel === 'write')
      await t.db.exec(`GRANT SELECT ON ALL TABLES IN SCHEMA dowel TO ${role}`);
    if (dowel === 'write')
      await t.db.exec(
        `GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA dowel TO ${role}; GRANT USAGE ON ALL SEQUENCES IN SCHEMA dowel TO ${role}`,
      );
    const u = new URL(t.url);
    u.username = role;
    u.password = 'pw';
    return u.toString();
  };

  test('接入：认领失败时环境照样保留（有审计、warning），可以重试；同步失败请求仍然成功；错误转成 422 带原因', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const prod2 = await newTarget();
    const inst = await newInstance('Z');
    const pid = await project(A, '接入容错');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const eP2 = await addEnv(A, pid, 'prod2', prod2.url);
    const chain = await publishN(A, pid, 2);
    for (const e of [eDev, ePro, eP2]) await exec(A, pid, e, 'execute', chain[1]!.id);
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    const attach = (body: Record<string, unknown>) =>
      inst.call('POST', `/api/projects/${pid}/environments/attach`, {
        production: false,
        allowSameInstance: true,
        ...body,
      });
    const auditOf = async (action: string) =>
      inst.db.query<{ target_id: string }>(
        'select target_id from audit_events where action = $1 and project_id = $2',
        [action, pid],
      );

    // ① 认领失败：只读账号能读历史、不能写 → 环境已经添加（和审计一起提交），认领失败作为 warning
    const readOnly = await limitedRole(prod, 'read');
    const r1 = await attach({ name: 'prod', url: readOnly, claim: true });
    expect(r1.status, JSON.stringify(r1.data)).toBe(201);
    const res1 = r1.data as unknown as AttachResult;
    expect(res1).toMatchObject({ attached: true, claimed: false, currentVersion: { number: 2 } });
    expect(res1.warnings.join('\n')).toContain('认领失败');
    expect(res1.warnings.join('\n')).not.toContain('pw'); // 脱敏：不带密码
    const envs1 = (await inst.call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
    expect(envs1.map((e) => e.name).sort()).toEqual(['dev', 'prod']);
    expect((await auditOf('environment.attach_history')).map((a) => a.target_id)).toContain(res1.id);
    expect((await auditOf('project.claim')).map((a) => a.target_id)).not.toContain(res1.id);
    const proRow = async () =>
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!;
    expect((await proRow()).instance_id).toBe(A.instanceId); // 目标库的认领没变
    // 重试：环境页的认领（读写账号才行）——先把连接串换成有权限的，再认领
    const claimRoute = () => inst.call('POST', `/api/projects/${pid}/environments/${res1.id}/claim`);
    const retry1 = await claimRoute(); // 仍然是只读账号：422 带原因，不是 500
    expect(retry1.status).toBe(422);
    expect(retry1.data.error).toMatch(/没有在里面建表和读写的权限|目标库返回错误/);
    expect(
      (await inst.call('PATCH', `/api/projects/${pid}/environments/${res1.id}`, { url: prod.url })).status,
    ).toBe(200);
    const retry2 = await claimRoute();
    expect(retry2.status, JSON.stringify(retry2.data)).toBe(200);
    expect((await proRow()).instance_id).toBe(inst.instanceId);
    expect((await auditOf('project.claim')).map((a) => a.target_id)).toContain(res1.id);

    // ② 同步目标库状态失败：环境已经建好，请求仍然成功（201），附 warning
    const original = inst.created.exec.syncTarget;
    inst.created.exec.syncTarget = async () => {
      throw new Error('boom');
    };
    try {
      const r2 = await attach({ name: 'prod2', url: prod2.url, claim: true });
      expect(r2.status, JSON.stringify(r2.data)).toBe(201);
      const res2 = r2.data as unknown as AttachResult;
      expect(res2).toMatchObject({ attached: true, claimed: true, currentVersion: null });
      expect(res2.warnings.join('\n')).toContain('同步目标库状态失败');
    } finally {
      inst.created.exec.syncTarget = original;
    }
    const names = (
      (await inst.call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[]
    ).map((e) => e.name);
    expect(names).toContain('prod2');

    // ③ 重名：409（事务里检查），不留半个环境
    const dup = await attach({ name: 'prod2', url: prod2.url, claim: true });
    expect(dup.status).toBe(409);

    // ④ 连接故障 / 权限不足 → 422 带原因，不是 500：dowel schema 只有 USAGE 没有读权限
    const noRead = await limitedRole(prod2, 'usage');
    const bad = await attach({ name: 'bad', url: noRead, claim: true });
    expect(bad.status).toBe(422);
    expect(bad.data.error).toMatch(/目标库返回错误/);
    expect(JSON.stringify(bad.data)).not.toContain('pw');
    // 连不上
    const unreachable = await attach({ name: 'x', url: 'postgres://127.0.0.1:1/none' });
    expect(unreachable.status).toBe(422);
  });

  test('认领在锁里重新比对链：读到历史之后原实例又执行了 v4 → B 的接入 / 认领被拒绝（history_mismatch），A 之后仍然可以执行', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('V');
    const pid = await project(A, '认领竞态');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eDev, 'execute', chain[2]!.id);
    await exec(A, pid, ePro, 'execute', chain[2]!.id);
    // B 接手 dev：链是 v1~v3
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    // B 读到 prod 的历史（v3）之后，A 发布 v4 并在 prod 上执行了
    const v4 = (await publishN(A, pid, 1, 4))[0]!;
    expect((await exec(A, pid, ePro, 'execute', v4.id)).last).toMatchObject({ stage: 'done' });
    // B 接入 / 认领 prod：历史已经领先于 B 的链 → 拒绝，提示重新读取
    const r = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/不在平台库的版本链上|重新读取/);
    expect(
      (await inst.call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[],
    ).toHaveLength(1);
    // 什么都没认领：A 仍然可以执行（回滚一步再执行回来）
    expect(
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(A.instanceId);
    expect(await prod.db.query('select 1 from dowel.claims')).toEqual([]);
    expect((await exec(A, pid, ePro, 'rollback', chain[2]!.id)).last).toMatchObject({ stage: 'done' });
    expect((await exec(A, pid, ePro, 'execute', v4.id)).last).toMatchObject({ stage: 'done' });
  });

  test('接手检查的 existsHere：只查目标库列出的 ID；调用者看不到的项目标 hidden，不给名字 / 归属', async () => {
    const dev = await newTarget();
    const inst = await newInstance('H');
    const pid = await project(A, '隐藏的项目');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 1);
    await exec(A, pid, eidA, 'execute', chain[0]!.id);
    // inst 上另一个组 h（pa 不是成员）里接手这个项目
    const h = await inst.call('POST', '/api/groups', { slug: 'h', name: '管理员的组' });
    const done = await wizard(inst, {
      name: '隐藏的接手',
      groupId: h.data.id as string,
      environments: [{ name: 'dev', url: dev.url, production: false, allowSameInstance: true }],
      content: { kind: 'takeover', projectId: pid, claim: true },
    });
    expect(done.last.stage).toBe('done');
    const inspect = async (cookie: string) =>
      (await inst.call('POST', '/api/takeover/inspect', { url: dev.url, groupId: inst.groupId }, cookie))
        .data as unknown as TakeoverInspectResult;
    // 管理员看得到：existsHere，不隐藏
    expect((await inspect(inst.admin)).projects[0]).toMatchObject({
      existsHere: true,
      hidden: false,
      mine: true,
    });
    // pa 看不到那个组里的项目：existsHere（不能悄悄覆盖）但 hidden，没有名字 / 归属之类的细节
    const hiddenOne = (await inspect(inst.pa)).projects[0]!;
    expect(hiddenOne).toMatchObject({ existsHere: true, hidden: true });
    // 接手本身也不透露：错误里没有 slug / 组
    const again = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], {}, inst.pa);
    expect(again.last).toMatchObject({ code: 'project_exists' });
    expect(again.last.error).toContain('联系管理员');
    expect(again.last.error).not.toContain('h/');
    // 看得到的人（管理员）得到具体位置
    const seen = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], {}, inst.admin);
    expect(seen.last.error).toContain('h/');
  });

  test('格式比当前代码新的库：接手检查和接手都拒绝', async () => {
    const dev = await newTarget();
    const inst = await newInstance('N');
    const pid = await project(A, '新格式');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 1);
    await exec(A, pid, eidA, 'execute', chain[0]!.id);
    await dev.db.exec(`update dowel.meta set value = '9'::jsonb where key = 'format_version'`);
    expect(
      (await inst.call('POST', '/api/takeover/inspect', { url: dev.url, groupId: inst.groupId })).status,
    ).toBe(422);
    const r = await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true });
    expect(r.last).toMatchObject({ code: 'format_too_new' });
  });

  test('没有历史的库：接手检查返回空列表；接手 → 环境没有这个项目的历史', async () => {
    const empty = await newTarget();
    const inst = await newInstance('E');
    const insp = (await inst.call('POST', '/api/takeover/inspect', { url: empty.url, groupId: inst.groupId }))
      .data as unknown as TakeoverInspectResult;
    expect(insp).toMatchObject({ hasHistory: false, projects: [] });
    const r = await takeover(inst, 'no-such-project', [{ name: 'dev', url: empty.url }], { claim: true });
    expect(r.last).toMatchObject({ stage: 'read', code: 'history_missing' });
    // 检查没有在目标库里建任何东西
    expect(await empty.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);
  });
});

describe.skipIf(!PG_URL)('只预演不执行（dry run）', () => {
  let A: Inst;
  beforeAll(async () => {
    A = await newInstance('R');
  });
  afterAll(drain);

  const dry = async (pid: string, eid: string, action: 'execute' | 'rollback' | 'baseline', to?: string) => {
    const r = await A.call('POST', `/api/projects/${pid}/environments/${eid}/${action}`, {
      to,
      dryRun: true,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    return r.data as unknown as DryRunResponse;
  };
  /** 平台库里和执行有关的登记：一条都不能多 */
  const platformState = async () => ({
    ev: await A.db.query('select * from environment_versions'),
    executed: await A.db.query('select id from versions where executed_at is not null'),
    cur: await A.db.query('select id, current_version_id from environments'),
  });

  test('目标库没有 dowel schema：预演列出迁移和步骤，之后目标库仍然没有 dowel schema，平台库也没有任何登记', async () => {
    const dev = await newTarget('dry');
    const pid = await project(A, '预演');
    const eid = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    const before = await platformState();

    const r = await dry(pid, eid, 'execute', chain[1]!.id);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.plan).toMatchObject({
      mode: 'migrate',
      direction: 'up',
      firstRun: 'empty',
      createsHistory: true,
      baseline: false,
      to: { number: 2 },
    });
    expect(r.plan!.migrations.map((m) => [m.number, m.direction, m.verified])).toEqual([
      [1, 'up', true],
      [2, 'up', true],
    ]);
    expect(r.plan!.migrations[0]!.steps.length).toBeGreaterThan(0);
    expect(r.plan!.migrations[1]!.steps[0]!.sql).toMatch(/ADD COLUMN/i);
    expect(r.plan!.migrations.every((m) => m.nonTransactional === 0)).toBe(true);
    expect(r.plan!.checks).toEqual(
      expect.arrayContaining([
        'lock',
        'integrity',
        'claim',
        'drift',
        'verified',
        'instance_level',
        'history_writable',
      ]),
    );
    // 什么都没写
    expect(await dev.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);
    expect(await dev.db.query("select 1 from pg_tables where schemaname = 'public'")).toEqual([]);
    expect(await platformState()).toEqual(before);
    // 预演之后真的执行仍然成功（预演没有留下半截状态）
    const real = await exec(A, pid, eid, 'execute', chain[1]!.id);
    expect(real.last).toMatchObject({ stage: 'done', ran: 2 });
  });

  test('已有历史：预演回滚 / 重复执行；dowel 表里一行都没多', async () => {
    const dev = await newTarget('dry');
    const pid = await project(A, '预演二');
    const eid = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eid, 'execute', chain[1]!.id);
    const counts = async () => ({
      history: (await dev.db.query('select * from dowel.history')).length,
      versions: (await dev.db.query('select * from dowel.versions')).length,
      claims: (await dev.db.query('select * from dowel.claims')).length,
    });
    const before = await counts();
    const platformBefore = await platformState();

    const up = await dry(pid, eid, 'execute', chain[2]!.id);
    expect(up.plan).toMatchObject({
      direction: 'up',
      firstRun: null,
      createsHistory: false,
      from: { number: 2 },
      to: { number: 3 },
    });
    expect(up.plan!.migrations).toHaveLength(1);
    const down = await dry(pid, eid, 'rollback', chain[0]!.id);
    expect(down.plan).toMatchObject({ direction: 'down', from: { number: 2 }, to: { number: 1 } });
    expect(down.plan!.migrations.map((m) => [m.number, m.direction])).toEqual([[2, 'down']]);
    // 回滚脚本没有锁和重写分析：risk 为空
    expect(down.plan!.migrations[0]!.risk).toBeNull();
    // 已经在目标版本：空操作
    const noop = await dry(pid, eid, 'execute', chain[1]!.id);
    expect(noop.plan).toMatchObject({ direction: 'none', migrations: [] });
    // 方向不对：和真正执行一样被拒绝，ok = false
    const wrong = await dry(pid, eid, 'rollback', chain[2]!.id);
    expect(wrong).toMatchObject({ ok: false, code: 'wrong_direction' });
    expect(await counts()).toEqual(before);
    expect(await platformState()).toEqual(platformBefore);
    expect(await columns(dev.db)).toEqual(['id', 'c2']);
  });

  test('检查没通过也是 200 + ok:false：漂移、未验证、锁被占用、写基线条件不满足；都不写任何东西', async () => {
    const dev = await newTarget('dry');
    const pid = await project(A, '预演三');
    const eid = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eid, 'execute', chain[0]!.id);
    const before = (await dev.db.query('select * from dowel.history')).length;

    // 漂移：手工改了库
    await dev.db.exec('alter table public.orders add column sneaky int');
    const drifted = await dry(pid, eid, 'execute', chain[1]!.id);
    expect(drifted).toMatchObject({ ok: false, code: 'drift' });
    expect(drifted.details!.diffTotal).toBeGreaterThan(0);
    await dev.db.exec('alter table public.orders drop column sneaky');
    expect((await dry(pid, eid, 'execute', chain[1]!.id)).ok).toBe(true);

    // 未验证：把 v2 标成未验证
    await A.db.query('update versions set verified_at = null where id = $1', [chain[1]!.id]);
    expect(await dry(pid, eid, 'execute', chain[1]!.id)).toMatchObject({ ok: false, code: 'unverified' });
    await A.db.query('update versions set verified_at = $2 where id = $1', [
      chain[1]!.id,
      new Date().toISOString(),
    ]);

    // 锁被占用：另一个连接持有目标库的项目锁（正在执行时的样子）——预演不排队，报告 lock_timeout
    const holder = connect(dev.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [`dowel:${pid}`]);
      const t0 = Date.now();
      expect(await dry(pid, eid, 'execute', chain[1]!.id)).toMatchObject({ ok: false, code: 'lock_timeout' });
      expect(Date.now() - t0).toBeLessThan(15_000);
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [`dowel:${pid}`]);
    } finally {
      await holder.close();
    }
    // 已经有历史：不能写基线
    expect(await dry(pid, eid, 'baseline')).toMatchObject({ ok: false, code: 'baseline_not_applicable' });
    expect((await dev.db.query('select * from dowel.history')).length).toBe(before);
  });

  test('预演和真正的执行权限一样：查看者 403；生产环境不需要输入环境名；没有 dryRun 的生产执行仍要环境名', async () => {
    const dev = await newTarget('dry');
    const pid = await project(A, '预演权限');
    const eid = await addEnv(A, pid, 'prod', dev.url, true);
    const chain = await publishN(A, pid, 1);
    // 生产环境：不带环境名的预演是 200
    expect((await dry(pid, eid, 'execute', chain[0]!.id)).ok).toBe(true);
    // 真正的执行（没有 dryRun）缺环境名 → 422
    const noConfirm = await A.call('POST', `/api/projects/${pid}/environments/${eid}/execute`, {
      to: chain[0]!.id,
    });
    expect(noConfirm.status).toBe(422);
    // 组成员 pa 是项目编辑者，生产环境默认档位是项目管理员：预演和真正的执行一样 403
    const pa = await A.call(
      'POST',
      `/api/projects/${pid}/environments/${eid}/execute`,
      { to: chain[0]!.id, dryRun: true },
      A.pa,
    );
    expect(pa.status).toBe(403);
  });
});
