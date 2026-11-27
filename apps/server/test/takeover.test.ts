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
import { addColumn, all, type Model, newId, plan, renameColumn } from '@dowel/core';
import { type Db, ensureHistory, recordVersion, stepsChecksum, toScriptSteps } from '@dowel/engines';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { versionExecutedAnywhere } from '../src/chain.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { readSettings } from '../src/settings.ts';
import { addTable, editModel, makeUser, PASSWORD, recordVerifiedOnEnvs } from './support.ts';

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
  envs: {
    name: string;
    url: string;
    production?: boolean;
    allowSameInstance?: boolean;
    shadowUrl?: string | null;
  }[],
  extra: { claim?: boolean; name?: string; slug?: string; groupId?: string } = {},
  cookie = inst.admin,
) =>
  wizard(
    inst,
    {
      name: extra.name ?? '接手的项目',
      groupId: extra.groupId ?? inst.groupId,
      ...(extra.slug ? { slug: extra.slug } : {}),
      environments: envs.map((e) => ({
        name: e.name,
        url: e.url,
        production: e.production ?? false,
        allowSameInstance: e.allowSameInstance ?? true,
        shadowUrl: e.shadowUrl ?? null,
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
    expect([...new Set(done.events.map((e) => e.stage))]).toEqual([
      'connect',
      'read',
      'verify',
      'write',
      'claim',
      'done',
    ]);

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
    // ADR 0012：接手前经本实例影子库全链验证通过，恢复的版本带 verifiedAt 与 verifyReport，并保留 restoredAt 标明来源
    const vs = (await B.call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
    expect(vs.map((v) => [v.number, v.verifiedAt !== null, v.restoredAt !== null])).toEqual([
      [3, true, true],
      [2, true, true],
      [1, true, true],
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
    expect(detail.upSteps.map((s) => s.sql).join(' ')).not.toMatch(/DROP COLUMN|ADD COLUMN/i);
    // B 执行成功（v1~v3 已经在这个库里，只跑 v4）
    const run = await exec(B, pid, eidB, 'execute', v4.data.id as string);
    expect(run.last, JSON.stringify(run.events)).toMatchObject({ stage: 'done', ran: 1 });
    expect(await columns(dev.db)).toEqual(['id', 'memo', 'c3']);
    // 数据保留：RENAME 不是重建（目标库的行数据不受影响由结构保证；这里看 history 里只多了一条记录）
    const hB = await history(B, pid, eidB);
    expect(hB.currentVersion).toMatchObject({ number: 4 });
    expect(hB.claim).toMatchObject({ mine: true });
  });

  test('ADR 0012：接手强制全链影子库验证——无可用影子库拒绝、脚本验证失败拒绝、配独立影子库或验证通过后可直接回滚', async () => {
    const dev = await newTarget();
    const shadowDb = await newTarget('tk_shd');
    const inst = await newInstance('C');
    const pid = await project(A, '强制验证');
    const eidA = await addEnv(A, pid, 'dev', dev.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eidA, 'execute', chain[1]!.id);

    // 1) 生产环境未配独立影子库且未允许同实例 → shadow_unavailable，不写平台库也不认领目标库
    const noShadow = await takeover(
      inst,
      pid,
      [{ name: 'prod', url: dev.url, production: true, allowSameInstance: false, shadowUrl: null }],
      { claim: true },
    );
    expect(noShadow.last).toMatchObject({ stage: 'verify', code: 'shadow_unavailable' });
    expect((await inst.call('GET', '/api/projects')).data).toEqual([]);
    expect(
      (await dev.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!.instance_id,
    ).toBe(A.instanceId);

    // 2) 篡改 v2 冻结脚本并重算 checksum（过得了 verifyChain，但在影子库验证必失败）→ verify_failed，指明版本号与原因，不写平台库也不认领
    const [origV2] = await dev.db.query<{ up_steps: unknown; down_steps: unknown; checksum: string }>(
      'select up_steps, down_steps, checksum from dowel.versions where version_id = $1',
      [chain[1]!.id],
    );
    const badUp = [{ sql: 'ALTER TABLE public.orders ADD COLUMN wrong_col text', transactional: true }];
    const badDown = [{ sql: 'ALTER TABLE public.orders DROP COLUMN wrong_col', transactional: true }];
    const badSum = stepsChecksum(badUp, badDown);
    await dev.db.query(
      'update dowel.versions set up_steps = $2::text::jsonb, down_steps = $3::text::jsonb, checksum = $4 where version_id = $1',
      [chain[1]!.id, JSON.stringify(badUp), JSON.stringify(badDown), badSum],
    );
    const badVerify = await takeover(
      inst,
      pid,
      [{ name: 'prod', url: dev.url, production: true, allowSameInstance: false, shadowUrl: shadowDb.url }],
      { claim: true },
    );
    expect(badVerify.last).toMatchObject({ stage: 'verify', code: 'verify_failed' });
    expect(badVerify.last.error).toContain('v2');
    expect((await inst.call('GET', '/api/projects')).data).toEqual([]);
    expect(
      (await dev.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!.instance_id,
    ).toBe(A.instanceId);

    // 恢复 v2 原始脚本和 checksum
    await dev.db.query(
      'update dowel.versions set up_steps = $2::text::jsonb, down_steps = $3::text::jsonb, checksum = $4 where version_id = $1',
      [chain[1]!.id, JSON.stringify(origV2!.up_steps), JSON.stringify(origV2!.down_steps), origV2!.checksum],
    );

    // 3) 生产环境配独立影子库 → 接手成功，版本全部带 verifiedAt 和 verifyReport，可直接回滚
    const ok = await takeover(
      inst,
      pid,
      [{ name: 'prod', url: dev.url, production: true, allowSameInstance: false, shadowUrl: shadowDb.url }],
      { claim: true },
    );
    expect(ok.last, JSON.stringify(ok.events)).toMatchObject({ stage: 'done' });
    const vs = (await inst.call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
    expect(vs.every((v) => v.verifiedAt !== null && v.restoredAt !== null)).toBe(true);
    const [e] = await envs(inst, pid);
    const rb = await exec(inst, pid, e!.id, 'rollback', chain[0]!.id, { confirm: 'prod' });
    expect(rb.last, JSON.stringify(rb.events)).toMatchObject({ stage: 'done', ran: 1 });
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
    expect(vs.map((v) => v.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
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
    // 同一个项目 ID 的历史，但版本不在平台的链上且占用同一编号（来自另一份项目副本）：409 history_fork
    await ensureHistory(other.db);
    await plant(other, pid, {
      id: 'alien-v1',
      number: 1,
      parent: null,
      up: 'CREATE TABLE alien (id int)',
      model: await versionModel(A, chain[0]!.id),
    });
    const foreign = await attach({ name: 'other', url: other.url });
    expect(foreign.status).toBe(409);
    expect(foreign.data.code).toBe('history_fork');
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
      await admin.db.exec(`CREATE ROLE ${role} LOGIN PASSWORD 'secret_pw_xyz'`);
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
    u.password = 'secret_pw_xyz';
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
    expect(res1.warnings.join('\n')).not.toContain('secret_pw_xyz'); // 脱敏：不带密码
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
    expect(JSON.stringify(bad.data)).not.toContain('secret_pw_xyz');
    // 连不上
    const unreachable = await attach({ name: 'x', url: 'postgres://127.0.0.1:1/none' });
    expect(unreachable.status).toBe(422);
  });

  test('认领在锁里重新比对链：已接入环境在认领前原实例又执行了 v4 → /claim 拒绝（history_mismatch），A 之后仍可执行', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const inst = await newInstance('V');
    const pid = await project(A, '认领竞态');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const chain = await publishN(A, pid, 3);
    await exec(A, pid, eDev, 'execute', chain[2]!.id);
    await exec(A, pid, ePro, 'execute', chain[2]!.id);
    // B 接手 dev（v1~v3）并接入 prod（v1~v3）后，再让 A 反向认领 prod 并推进到 v4
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    const attached = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(attached.status).toBe(201);
    const eidBProd = attached.data.id as string;
    expect((await A.call('POST', `/api/projects/${pid}/environments/${ePro}/claim`)).status).toBe(200);
    const v4 = (await publishN(A, pid, 1, 4))[0]!;
    expect((await exec(A, pid, ePro, 'execute', v4.id)).last).toMatchObject({ stage: 'done' });
    // B 尝试直接认领 prod（B 平台上只有 v1~v3）：锁内比对发现目标库领先于 B 的链 → 422 拒绝，提示重新读取
    const r = await inst.call('POST', `/api/projects/${pid}/environments/${eidBProd}/claim`);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/不在平台库的版本链上|重新读取/);
    // 什么都没认领：A 仍然可以执行（回滚一步再执行回来）
    expect(
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(A.instanceId);
    expect((await exec(A, pid, ePro, 'rollback', chain[2]!.id)).last).toMatchObject({ stage: 'done' });
    expect((await exec(A, pid, ePro, 'execute', v4.id)).last).toMatchObject({ stage: 'done' });
  });

  test('ADR 0012：接入严格领先环境——影子库验证（缺影子库/验证失败拒绝）、工作副本干净自动覆盖、工作副本脏 409 差异确认与 working_changed', async () => {
    const dev = await newTarget();
    const prod = await newTarget();
    const prod2 = await newTarget();
    const inst = await newInstance('AH');
    const pid = await project(A, '接入领先');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const ePro = await addEnv(A, pid, 'prod', prod.url);
    const ePro2 = await addEnv(A, pid, 'prod2', prod2.url);
    const chain = await publishN(A, pid, 2);
    await exec(A, pid, eDev, 'execute', chain[1]!.id);
    await exec(A, pid, ePro, 'execute', chain[1]!.id);
    await exec(A, pid, ePro2, 'execute', chain[1]!.id);

    // inst 先接手 dev（v1~v2），这里用生产环境但不允许同实例的设定不方便，直接用 dev（非生产）
    expect((await takeover(inst, pid, [{ name: 'dev', url: dev.url }], { claim: true })).last.stage).toBe(
      'done',
    );
    // A 继续发布 v3、v4 并在 prod 与 prod2 上执行到 v4（比 inst 领先 2 个版本）
    const more = await publishN(A, pid, 2, 3);
    expect((await exec(A, pid, ePro, 'execute', more[1]!.id)).last).toMatchObject({ stage: 'done' });
    expect((await exec(A, pid, ePro2, 'execute', more[1]!.id)).last).toMatchObject({ stage: 'done' });

    // 1) 无可用影子库测试（新建独立实例 instNoShadow 仅接手生产环境并配独立影子库后清除其影子库，再接入领先生产环境）
    const instNoShadow = await newInstance('AH_NS');
    const tmpShadow = await newTarget('ah_shd');
    expect(
      (
        await takeover(
          instNoShadow,
          pid,
          [
            {
              name: 'dev-prod',
              url: dev.url,
              production: true,
              allowSameInstance: false,
              shadowUrl: tmpShadow.url,
            },
          ],
          { claim: true },
        )
      ).last.stage,
    ).toBe('done');
    // 清掉 dev-prod 的独立影子库，使其无法再提供影子库
    const [nsEnv] = await envs(instNoShadow, pid);
    expect(
      (
        await instNoShadow.call('PATCH', `/api/projects/${pid}/environments/${nsEnv!.id}`, {
          shadowUrl: null,
        })
      ).status,
    ).toBe(200);
    const noShadowAttach = await instNoShadow.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: true,
      allowSameInstance: false,
      claim: true,
    });
    expect(noShadowAttach.status).toBe(422);
    expect(noShadowAttach.data.code).toBe('shadow_unavailable');
    expect(
      (await instNoShadow.call('GET', `/api/projects/${pid}/versions`)).data as unknown as unknown[],
    ).toHaveLength(2);

    // 2) 领先版本影子库验证失败 → 422 verify_failed，不写平台库也不认领
    const [origV3] = await prod.db.query<{ up_steps: unknown; down_steps: unknown; checksum: string }>(
      'select up_steps, down_steps, checksum from dowel.versions where version_id = $1',
      [more[0]!.id],
    );
    const badUp = [{ sql: 'ALTER TABLE public.orders ADD COLUMN bogus text', transactional: true }];
    const badDown = [{ sql: 'ALTER TABLE public.orders DROP COLUMN bogus', transactional: true }];
    await prod.db.query(
      'update dowel.versions set up_steps = $2::text::jsonb, down_steps = $3::text::jsonb, checksum = $4 where version_id = $1',
      [more[0]!.id, JSON.stringify(badUp), JSON.stringify(badDown), stepsChecksum(badUp, badDown)],
    );
    const badAttach = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(badAttach.status).toBe(422);
    expect(badAttach.data.code).toBe('verify_failed');
    expect(badAttach.data.error).toContain('v3');
    expect(
      (await inst.call('GET', `/api/projects/${pid}/versions`)).data as unknown as unknown[],
    ).toHaveLength(2);
    expect(
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(A.instanceId);
    // 还原 v3 脚本
    await prod.db.query(
      'update dowel.versions set up_steps = $2::text::jsonb, down_steps = $3::text::jsonb, checksum = $4 where version_id = $1',
      [more[0]!.id, JSON.stringify(origV3!.up_steps), JSON.stringify(origV3!.down_steps), origV3!.checksum],
    );

    // 3) 工作副本有未发布修改（脏）→ 409 working_dirty_confirm，带 aheadVersions / items / total / workingSeq
    await editModel(inst.created.rooms, inst.db, pid, (m) => {
      addColumn(m, tableOf(m), { name: 'draft_col', type: 'text' });
    });
    const dirtyRes = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(dirtyRes.status, JSON.stringify(dirtyRes.data)).toBe(409);
    expect(dirtyRes.data.code).toBe('working_dirty_confirm');
    expect((dirtyRes.data.aheadVersions as { number: number }[]).map((v) => v.number)).toEqual([3, 4]);
    expect(dirtyRes.data.total as number).toBeGreaterThan(0);
    const staleSeq = dirtyRes.data.workingSeq as number;
    // 未确认时不写平台库也不认领
    expect(
      (await inst.call('GET', `/api/projects/${pid}/versions`)).data as unknown as unknown[],
    ).toHaveLength(2);
    expect(
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(A.instanceId);

    // 4) 预览之后画布又被编辑 → 带旧 workingSeq 确认返回 409 working_changed
    await editModel(inst.created.rooms, inst.db, pid, (m) => {
      addColumn(m, tableOf(m), { name: 'draft_col_2', type: 'text' });
    });
    const changedRes = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
      confirmOverwrite: true,
      workingSeq: staleSeq,
    });
    expect(changedRes.status).toBe(409);
    expect(changedRes.data.code).toBe('working_changed');
    const freshSeq = changedRes.data.workingSeq as number;
    expect(freshSeq).toBeGreaterThan(staleSeq);

    // 5) 带最新 workingSeq + confirmOverwrite: true → 201，补齐 v3/v4（已验证 + restoredAt）、覆盖工作副本到 v4 并记 room_commits、认领 prod
    const ok = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod',
      url: prod.url,
      production: false,
      allowSameInstance: true,
      claim: true,
      confirmOverwrite: true,
      workingSeq: freshSeq,
    });
    expect(ok.status, JSON.stringify(ok.data)).toBe(201);
    const res = ok.data as unknown as AttachResult;
    expect(res).toMatchObject({
      attached: true,
      claimed: true,
      currentVersion: { number: 4 },
    });
    expect(res.aheadVersions.map((v) => v.number)).toEqual([3, 4]);
    const vsAfter = (await inst.call('GET', `/api/projects/${pid}/versions`))
      .data as unknown as VersionInfo[];
    expect(vsAfter.map((v) => [v.number, v.verifiedAt !== null, v.restoredAt !== null])).toEqual([
      [4, true, true],
      [3, true, true],
      [2, true, true],
      [1, true, true],
    ]);
    // 工作副本已覆盖到 v4（不再含 draft_col），且 room_commits 记下 attachAhead 操作
    expect(await modelOf(inst, pid)).toEqual(await versionModel(A, more[1]!.id));
    const [bRow] = await inst.db.query<{ id: string }>('select id from branches where project_id = $1', [
      pid,
    ]);
    const commits = await inst.db.query<{ op_name: string | null }>(
      'select op_name from room_commits where branch_id = $1 order by seq desc limit 1',
      [bRow!.id],
    );
    expect(commits[0]!.op_name).toBe('attachAhead');
    expect(
      (await prod.db.query<{ instance_id: string }>('select instance_id from dowel.projects'))[0]!
        .instance_id,
    ).toBe(inst.instanceId);

    // 6) 工作副本干净时接入领先环境：再让 A 发布 v5 并执行到 prod2，然后 inst（画布干净）直接接入 prod2（无需 confirmOverwrite）
    const v5 = (await publishN(A, pid, 1, 5))[0]!;
    expect((await exec(A, pid, ePro2, 'execute', v5.id)).last).toMatchObject({ stage: 'done' });
    const cleanAttach = await inst.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'prod2',
      url: prod2.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(cleanAttach.status, JSON.stringify(cleanAttach.data)).toBe(201);
    expect((cleanAttach.data as unknown as AttachResult).aheadVersions.map((v) => v.number)).toEqual([5]);
    expect(await modelOf(inst, pid)).toEqual(await versionModel(A, v5.id));
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

  const shadowNameOf = (url: string) => `${new URL(url).pathname.slice(1)}_dowel`;
  const shadowExists = async (name: string) => {
    const admin = connect(PG_URL);
    try {
      const [row] = await admin.db.query<{ n: number }>(
        'select count(*)::int as n from pg_database where datname = $1',
        [name],
      );
      return (row?.n ?? 0) > 0;
    } finally {
      await admin.close();
    }
  };
  const dropDb = async (name: string) => {
    const admin = connect(PG_URL);
    try {
      await admin.db.exec(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  };

  /** 仅匹配 routes/takeover.ts 的写事务，避免误拦截后台 webhooks / requests 巡检事务 */
  const isTakeoverTx = (fn: unknown) => typeof fn === 'function' && fn.toString().includes('restoreChain');

  /** 构造一个多请求屏障：指定数量的 takeover 请求都进入 db.transaction 后才放行，保证并发撞在 write 阶段 */
  const withTxBarrier = (db: PlatformDb, count: number) => {
    const orig = db.transaction.bind(db);
    let arrived = 0;
    const waiters: (() => void)[] = [];
    db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return orig(fn);
      arrived++;
      if (arrived <= count) {
        if (arrived === count) for (const w of waiters.splice(0)) w();
        else
          await new Promise<void>((resolve) => {
            waiters.push(resolve);
          });
      }
      return orig(fn);
    }) as PlatformDb['transaction'];
    return () => {
      for (const w of waiters.splice(0)) w();
      db.transaction = orig;
    };
  };

  test('并发接手同一项目：后提交一方返回结构化 project_exists（不可见项目不泄露名称与所属组），覆盖 isUniqueViolation 并清理新建同实例影子库', async () => {
    const inst = await newInstance('CC_SAME');
    // 新增第二个实例管理员，用于真实双管理员并发接手
    await makeUser(inst.db, 'admin2', { name: '管理员二', role: 'admin' });
    const loginRes = await inst.created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin2', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const admin2 = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

    // 1) 双管理员真实并发接手同一项目：一个 done，另一个在 write 阶段收到结构化 project_exists（非“服务器内部错误”）
    const dev1 = await newTarget();
    const pid1 = await project(A, '并发同一项目');
    const eid1 = await addEnv(A, pid1, 'dev', dev1.url);
    const chain1 = await publishN(A, pid1, 1);
    expect((await exec(A, pid1, eid1, 'execute', chain1[0]!.id)).last.stage).toBe('done');

    const restoreBarrier1 = withTxBarrier(inst.db, 2);
    let pair1: [Awaited<ReturnType<typeof takeover>>, Awaited<ReturnType<typeof takeover>>];
    try {
      pair1 = await Promise.all([
        takeover(inst, pid1, [{ name: 'dev', url: dev1.url }], { claim: true, name: '并发项目' }, inst.admin),
        takeover(inst, pid1, [{ name: 'dev', url: dev1.url }], { claim: true, name: '并发项目' }, admin2),
      ]);
    } finally {
      restoreBarrier1();
    }
    const ok1 = pair1.filter((r) => r.last.stage === 'done');
    const fail1 = pair1.filter((r) => r.last.stage !== 'done');
    expect(ok1).toHaveLength(1);
    expect(fail1).toHaveLength(1);
    expect(fail1[0]!.last).toMatchObject({ stage: 'write', code: 'project_exists' });
    expect(fail1[0]!.last.error).not.toContain('服务器内部错误');
    expect(fail1[0]!.last.error).toContain('g/');
    expect(await inst.db.query('select id from projects where id = $1', [pid1])).toHaveLength(1);

    // 2) 隐藏组权限可见性：管理员在隐藏组 h、pa 在公开组 g 并发接手同一个本实例历史项目；
    //    让 admin 先提交、pa 后提交 → pa 收到 project_exists 且不泄露隐藏组 h 与项目名/slug
    const dev2 = await newTarget();
    const pid2 = await project(inst, '本实例历史');
    const eid2 = await addEnv(inst, pid2, 'dev', dev2.url);
    const chain2 = await publishN(inst, pid2, 1);
    expect((await exec(inst, pid2, eid2, 'execute', chain2[0]!.id)).last.stage).toBe('done');
    const origSlug2 = (await inst.call('GET', `/api/projects/${pid2}`)).data.slug as string;
    expect((await inst.call('DELETE', `/api/projects/${pid2}`, { confirm: origSlug2 })).status).toBe(200);

    const hiddenGroup = await inst.call('POST', '/api/groups', { slug: 'secret-grp', name: '机密组' });
    expect(hiddenGroup.status).toBe(201);
    const hiddenGroupId = hiddenGroup.data.id as string;

    // 确定性顺序：等两个请求都通过 read+verify 到达 db.transaction 后，先让 admin 在隐藏组提交，再放行 pa
    const origTx2 = inst.db.transaction.bind(inst.db);
    let paArrived!: () => void;
    const waitPa = new Promise<void>((r) => {
      paArrived = r;
    });
    let allowPa!: () => void;
    const waitAdminDone = new Promise<void>((r) => {
      allowPa = r;
    });
    let txCalls2 = 0;
    inst.db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return origTx2(fn);
      txCalls2++;
      if (txCalls2 === 1) {
        // 第一个到达的是 pa（先启动），先通知 admin 启动并等待 admin 提交完成
        paArrived();
        await waitAdminDone;
        return origTx2(fn);
      }
      const res = await origTx2(fn);
      allowPa();
      return res;
    }) as PlatformDb['transaction'];
    let rPa: Awaited<ReturnType<typeof takeover>>;
    let rAdmin: Awaited<ReturnType<typeof takeover>>;
    try {
      const pPa = takeover(inst, pid2, [{ name: 'dev', url: dev2.url }], { name: '公开名称' }, inst.pa);
      await waitPa;
      rAdmin = await takeover(
        inst,
        pid2,
        [{ name: 'dev', url: dev2.url }],
        { name: '机密项目名', slug: 'top-secret', groupId: hiddenGroupId },
        inst.admin,
      );
      rPa = await pPa;
    } finally {
      allowPa();
      inst.db.transaction = origTx2;
    }
    expect(rAdmin.last, JSON.stringify(rAdmin.events)).toMatchObject({ stage: 'done' });
    expect(rPa.last, JSON.stringify(rPa.events)).toMatchObject({ stage: 'write', code: 'project_exists' });
    expect(rPa.last.error).toContain('联系管理员');
    expect(rPa.last.error).not.toContain('服务器内部错误');
    expect(rPa.last.error).not.toContain('secret-grp');
    expect(rPa.last.error).not.toContain('top-secret');
    expect(rPa.last.error).not.toContain('机密项目名');

    // 3) 模拟 PG 并发穿透事务内复查直接触发 isUniqueViolation(23505)：
    //    (a) projects.id 唯一冲突（落入隐藏组，对 pa 不可见）→ project_exists（不泄露名称/组）且清理本次新建同实例影子库
    const dev3 = await newTarget();
    const pid3 = await project(inst, '影子清理项目');
    const eid3 = await addEnv(inst, pid3, 'dev', dev3.url);
    const chain3 = await publishN(inst, pid3, 1);
    expect((await exec(inst, pid3, eid3, 'execute', chain3[0]!.id)).last.stage).toBe('done');
    const origSlug3 = (await inst.call('GET', `/api/projects/${pid3}`)).data.slug as string;
    expect((await inst.call('DELETE', `/api/projects/${pid3}`, { confirm: origSlug3 })).status).toBe(200);
    // 确保目标实例上不存在旧同实例影子库，让本次接手在 verify 阶段新建它
    const shadow3 = shadowNameOf(dev3.url);
    await dropDb(shadow3);
    expect(await shadowExists(shadow3)).toBe(false);

    const origTx3 = inst.db.transaction.bind(inst.db);
    let sawShadowCreated = false;
    inst.db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return origTx3(fn);
      sawShadowCreated = await shadowExists(shadow3);
      // 模拟并发一方在 PG 上刚好提交了同一 projectId 到隐藏组，并让当前事务抛 23505
      await origTx3(async (tx) => {
        await tx.query(
          'insert into projects (id, name, created_by, group_id, slug) values ($1, $2, null, $3, $4)',
          [pid3, '不可见冲突项目', hiddenGroupId, 'hidden-clash'],
        );
        await tx.query("insert into branches (id, project_id, name) values ($1, $2, 'main')", [
          `b-${pid3}`,
          pid3,
        ]);
      });
      throw Object.assign(new Error('duplicate key value violates unique constraint "projects_pkey"'), {
        code: '23505',
      });
    }) as PlatformDb['transaction'];
    let rPgProject: Awaited<ReturnType<typeof takeover>>;
    try {
      rPgProject = await takeover(
        inst,
        pid3,
        [{ name: 'dev', url: dev3.url }],
        { name: '冲突测试' },
        inst.pa,
      );
    } finally {
      inst.db.transaction = origTx3;
    }
    expect(sawShadowCreated).toBe(true);
    expect(rPgProject.last, JSON.stringify(rPgProject.events)).toMatchObject({
      stage: 'write',
      code: 'project_exists',
    });
    expect(rPgProject.last.error).toContain('联系管理员');
    expect(rPgProject.last.error).not.toContain('服务器内部错误');
    expect(rPgProject.last.error).not.toContain('secret-grp');
    expect(rPgProject.last.error).not.toContain('hidden-clash');
    expect(rPgProject.last.error).not.toContain('不可见冲突项目');
    // 提交前失败：本次新建的同实例影子库必须被 cleanupShadow 清理
    expect(await shadowExists(shadow3)).toBe(false);

    //    (b) versions.id 唯一冲突（不同 projectId 但同 versionId）通过 isUniqueViolation 转为 project_exists
    const dev4 = await newTarget();
    const pid4 = await project(A, '版本冲突项目');
    const eid4 = await addEnv(A, pid4, 'dev', dev4.url);
    const chain4 = await publishN(A, pid4, 1);
    expect((await exec(A, pid4, eid4, 'execute', chain4[0]!.id)).last.stage).toBe('done');
    const origTx4 = inst.db.transaction.bind(inst.db);
    inst.db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return origTx4(fn);
      // 在一个已存在项目中插入同 ID 的版本行，然后模拟 PG 23505
      await origTx4(async (tx) => {
        await tx.query(
          `insert into versions (id, project_id, branch_id, seq, name, model, number)
           values ($1, $2, $3, 99, 'dup', '{}'::text::jsonb, 99)`,
          [chain4[0]!.id, pid3, `b-${pid3}`],
        );
      });
      throw Object.assign(new Error('duplicate key value violates unique constraint "versions_pkey"'), {
        code: '23505',
      });
    }) as PlatformDb['transaction'];
    let rPgVersion: Awaited<ReturnType<typeof takeover>>;
    try {
      rPgVersion = await takeover(inst, pid4, [{ name: 'dev', url: dev4.url }], { claim: true });
    } finally {
      inst.db.transaction = origTx4;
    }
    expect(rPgVersion.last, JSON.stringify(rPgVersion.events)).toMatchObject({
      stage: 'write',
      code: 'project_exists',
    });
    expect(rPgVersion.last.error).toContain(chain4[0]!.id);
    expect(rPgVersion.last.error).not.toContain('服务器内部错误');
  });

  test('并发接手同组同 slug 的不同项目：自动 slug 自动重选重试成功；显式 slug 或重试耗尽返回结构化 slug_conflict 且清理影子库', async () => {
    const inst = await newInstance('CC_SLUG');

    // 准备 2 个不同项目，在同组用相同项目名（未显式指定 slug）真实并发接手
    const dev1 = await newTarget();
    const dev2 = await newTarget();
    const pid1 = await project(A, '同组项目一');
    const pid2 = await project(A, '同组项目二');
    const eid1 = await addEnv(A, pid1, 'dev', dev1.url);
    const eid2 = await addEnv(A, pid2, 'dev', dev2.url);
    const c1 = await publishN(A, pid1, 1);
    const c2 = await publishN(A, pid2, 1);
    expect((await exec(A, pid1, eid1, 'execute', c1[0]!.id)).last.stage).toBe('done');
    expect((await exec(A, pid2, eid2, 'execute', c2[0]!.id)).last.stage).toBe('done');

    const restoreBarrier1 = withTxBarrier(inst.db, 2);
    let pairAuto: [Awaited<ReturnType<typeof takeover>>, Awaited<ReturnType<typeof takeover>>];
    try {
      pairAuto = await Promise.all([
        takeover(inst, pid1, [{ name: 'dev', url: dev1.url }], { claim: true, name: 'dup-shop' }),
        takeover(inst, pid2, [{ name: 'dev', url: dev2.url }], { claim: true, name: 'dup-shop' }),
      ]);
    } finally {
      restoreBarrier1();
    }
    expect(pairAuto[0].last, JSON.stringify(pairAuto[0].events)).toMatchObject({ stage: 'done' });
    expect(pairAuto[1].last, JSON.stringify(pairAuto[1].events)).toMatchObject({ stage: 'done' });
    expect([pairAuto[0].last.project!.slug, pairAuto[1].last.project!.slug].sort()).toEqual([
      'dup-shop',
      'dup-shop-2',
    ]);

    // 2) 模拟 PG 并发触发 (group_id, slug) 唯一约束 23505：自动重选 slug 重试一次并成功
    const dev3 = await newTarget();
    const pid3 = await project(A, 'PG重选项目');
    const eid3 = await addEnv(A, pid3, 'dev', dev3.url);
    const c3 = await publishN(A, pid3, 1);
    expect((await exec(A, pid3, eid3, 'execute', c3[0]!.id)).last.stage).toBe('done');

    const origTx3 = inst.db.transaction.bind(inst.db);
    let firstSlugRace = true;
    inst.db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return origTx3(fn);
      if (firstSlugRace) {
        firstSlugRace = false;
        await origTx3(async (tx) => {
          await tx.query(
            'insert into projects (id, name, created_by, group_id, slug) values ($1, $2, null, $3, $4)',
            ['other-slug-holder', '占坑项目', inst.groupId, 'pg-race'],
          );
        });
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "projects_group_slug_key"'),
          { code: '23505' },
        );
      }
      return origTx3(fn);
    }) as PlatformDb['transaction'];
    let rRetryOk: Awaited<ReturnType<typeof takeover>>;
    try {
      rRetryOk = await takeover(inst, pid3, [{ name: 'dev', url: dev3.url }], {
        claim: true,
        name: 'pg-race',
      });
    } finally {
      inst.db.transaction = origTx3;
    }
    expect(rRetryOk.last, JSON.stringify(rRetryOk.events)).toMatchObject({ stage: 'done' });
    expect(rRetryOk.last.project!.slug).toBe('pg-race-2');

    // 3) 显式指定同一 slug 并发接手不同项目：一个 done，另一个返回结构化 slug_conflict（不返回“服务器内部错误”）
    const dev4 = await newTarget();
    const dev5 = await newTarget();
    const pid4 = await project(A, '显式标识一');
    const pid5 = await project(A, '显式标识二');
    const eid4 = await addEnv(A, pid4, 'dev', dev4.url);
    const eid5 = await addEnv(A, pid5, 'dev', dev5.url);
    const c4 = await publishN(A, pid4, 1);
    const c5 = await publishN(A, pid5, 1);
    expect((await exec(A, pid4, eid4, 'execute', c4[0]!.id)).last.stage).toBe('done');
    expect((await exec(A, pid5, eid5, 'execute', c5[0]!.id)).last.stage).toBe('done');

    const restoreBarrier2 = withTxBarrier(inst.db, 2);
    let pairExplicit: [Awaited<ReturnType<typeof takeover>>, Awaited<ReturnType<typeof takeover>>];
    try {
      pairExplicit = await Promise.all([
        takeover(inst, pid4, [{ name: 'dev', url: dev4.url }], {
          claim: true,
          name: '显式一',
          slug: 'fixed-slug',
        }),
        takeover(inst, pid5, [{ name: 'dev', url: dev5.url }], {
          claim: true,
          name: '显式二',
          slug: 'fixed-slug',
        }),
      ]);
    } finally {
      restoreBarrier2();
    }
    const okExp = pairExplicit.filter((r) => r.last.stage === 'done');
    const failExp = pairExplicit.filter((r) => r.last.stage !== 'done');
    expect(okExp).toHaveLength(1);
    expect(okExp[0]!.last.project!.slug).toBe('fixed-slug');
    expect(failExp).toHaveLength(1);
    expect(failExp[0]!.last).toMatchObject({ stage: 'write', code: 'slug_conflict' });
    expect(failExp[0]!.last.error).toContain('相同的标识');
    expect(failExp[0]!.last.error).not.toContain('服务器内部错误');

    // 4) 自动 slug 连续冲突达到重试上限 → 返回结构化 slug_conflict，且清理本次新建同实例影子库
    const dev6 = await newTarget();
    const pid6 = await project(A, '重试耗尽');
    const eid6 = await addEnv(A, pid6, 'dev', dev6.url);
    const c6 = await publishN(A, pid6, 1);
    expect((await exec(A, pid6, eid6, 'execute', c6[0]!.id)).last.stage).toBe('done');
    const shadow6 = shadowNameOf(dev6.url);
    await dropDb(shadow6);
    expect(await shadowExists(shadow6)).toBe(false);

    const origTx6 = inst.db.transaction.bind(inst.db);
    let attempts = 0;
    let sawShadow6 = false;
    inst.db.transaction = (async (fn) => {
      if (!isTakeoverTx(fn)) return origTx6(fn);
      attempts++;
      if (attempts === 1) sawShadow6 = await shadowExists(shadow6);
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "projects_group_slug_key"'),
        { code: '23505' },
      );
    }) as PlatformDb['transaction'];
    let rExhausted: Awaited<ReturnType<typeof takeover>>;
    try {
      rExhausted = await takeover(inst, pid6, [{ name: 'dev', url: dev6.url }], {
        claim: true,
        name: 'always-clash',
      });
    } finally {
      inst.db.transaction = origTx6;
    }
    expect(sawShadow6).toBe(true);
    expect(attempts).toBe(4); // 首次 + 最多 3 次重试
    expect(rExhausted.last, JSON.stringify(rExhausted.events)).toMatchObject({
      stage: 'write',
      code: 'slug_conflict',
    });
    expect(rExhausted.last.error).not.toContain('服务器内部错误');
    expect(await shadowExists(shadow6)).toBe(false);
  });

  test('ADR 0013 版本树接手与接入：作废岔路与活跃主链共存，自动写 retired_at 并保护活跃头', async () => {
    const dev = await newTarget('tree_dev');
    const prod = await newTarget('tree_prod');
    const ext = await newTarget('tree_ext');
    const pid = await project(A, '树接手');
    const eDev = await addEnv(A, pid, 'dev', dev.url);
    const eProd = await addEnv(A, pid, 'prod', prod.url);
    const eExt = await addEnv(A, pid, 'ext', ext.url);

    // 1. 先在源实例发布 v1 -> v2 -> v3，dev 停在 v3（即将成为作废岔路），ext 也走到 v3
    const [_v1, v2, v3] = await publishN(A, pid, 3);
    expect((await exec(A, pid, eDev, 'execute', v3!.id)).last.stage).toBe('done');
    expect((await exec(A, pid, eProd, 'execute', v2!.id)).last.stage).toBe('done');

    // 在源实例 A 构造延自 v2 的新活跃版本 v4（parent = v2），再把 v3 标成作废
    const [bRow] = await A.db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
    const m2 = await versionModel(A, v2!.id);
    const m4 = structuredClone(m2);
    addColumn(m4, all(m4, 'table').find((t) => t.name === 'orders')!.id, { name: 'c4', type: 'text' });
    const up4 = toScriptSteps(plan(m2, m4), 'pg');
    const down4 = toScriptSteps(plan(m4, m2), 'pg');
    const v4Id = newId();
    await A.db.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                             up_steps, down_steps, checksum, verified_at)
       values ($1, $2, $3, 3, 'v4', $4::text::jsonb, null, 4, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
      [
        v4Id,
        pid,
        bRow!.id,
        JSON.stringify(m4),
        v2!.id,
        JSON.stringify(up4),
        JSON.stringify(down4),
        stepsChecksum(up4, down4),
        new Date().toISOString(),
      ],
    );
    await recordVerifiedOnEnvs(A.db, pid, [v4Id]);
    await A.db.query('update versions set retired_at = $2 where id = $1', [v3!.id, new Date().toISOString()]);
    expect((await exec(A, pid, eProd, 'execute', v4Id)).last.stage).toBe('done');

    // 在 ext 上继续沿着已被作废的 v3 发布并执行 v5（模拟陈旧实例试图复活作废分支）
    const m3 = await versionModel(A, v3!.id);
    const m5 = structuredClone(m3);
    addColumn(m5, all(m5, 'table').find((t) => t.name === 'orders')!.id, { name: 'c5', type: 'text' });
    const up5 = toScriptSteps(plan(m3, m5), 'pg');
    const down5 = toScriptSteps(plan(m5, m3), 'pg');
    const v5Id = newId();
    // 暂时取消 retired_at，在 ext 上按 v1->v2->v3->v5 执行后再恢复
    await A.db.query('update versions set retired_at = null where id = $1', [v3!.id]);
    await A.db.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                             up_steps, down_steps, checksum, verified_at)
       values ($1, $2, $3, 4, 'v5', $4::text::jsonb, null, 5, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
      [
        v5Id,
        pid,
        bRow!.id,
        JSON.stringify(m5),
        v3!.id,
        JSON.stringify(up5),
        JSON.stringify(down5),
        stepsChecksum(up5, down5),
        new Date().toISOString(),
      ],
    );
    await recordVerifiedOnEnvs(A.db, pid, [v5Id]);
    expect((await exec(A, pid, eExt, 'execute', v5Id)).last.stage).toBe('done');
    await A.db.query('update versions set retired_at = $2 where id = $1', [v3!.id, new Date().toISOString()]);

    // 2. 新实例 B 从 [dev(停在 v3), prod(停在 v4)] 接手整个项目
    const B = await newInstance('TreeTakeover');
    const resB = await takeover(
      B,
      pid,
      [
        { name: 'dev', url: dev.url },
        { name: 'prod', url: prod.url },
      ],
      { claim: true },
    );
    expect(resB.last, JSON.stringify(resB.events)).toMatchObject({
      stage: 'done',
      retiredVersions: [{ id: v3!.id, number: 3 }],
    });
    const bVers = await B.db.query<{
      id: string;
      number: number;
      parentId: string | null;
      retiredAt: unknown;
      retiredBy: string | null;
    }>(
      'select id, number, parent_id as "parentId", retired_at as "retiredAt", retired_by as "retiredBy" from versions where project_id = $1 order by number',
      [pid],
    );
    expect(bVers.find((v) => v.id === v3!.id)?.retiredAt).not.toBeNull();
    expect(bVers.find((v) => v.id === v3!.id)?.retiredBy).toBeNull();
    expect(bVers.find((v) => v.id === v4Id)?.retiredAt).toBeNull();
    expect(bVers.find((v) => v.id === v4Id)?.parentId).toBe(v2!.id);
    // 工作副本停在活跃头 v4 的模型（不含 v3 的 c3）
    const bModel = await modelOf(B, pid);
    const bCols = all(bModel, 'column').map((c) => c.name);
    expect(bCols).toContain('c4');
    expect(bCols).not.toContain('c3');

    // 3. 新实例 C 先只接手 prod（链上是 v1->v2->v4），再 attach dev（带着作废岔路 v3）：
    //    应补齐 v3 且自动标成作废，返回 retiredVersions=[v3]，C 的工作副本保持 v4 不被覆盖
    const C = await newInstance('TreeAttach');
    const resC = await takeover(C, pid, [{ name: 'prod', url: prod.url }], { claim: true });
    expect(resC.last.stage).toBe('done');
    const attDev = await C.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'dev',
      url: dev.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(attDev.status, JSON.stringify(attDev.data)).toBe(201);
    expect(attDev.data as unknown as AttachResult).toMatchObject({
      claimed: true,
      aheadVersions: [{ id: v3!.id, number: 3 }],
      retiredVersions: [{ id: v3!.id, number: 3 }],
    });
    const [cV3] = await C.db.query<{ retiredAt: unknown; retiredBy: string | null }>(
      'select retired_at as "retiredAt", retired_by as "retiredBy" from versions where id = $1',
      [v3!.id],
    );
    expect(cV3!.retiredAt).not.toBeNull();
    expect(cV3!.retiredBy).toBeNull();
    expect(all(await modelOf(C, pid), 'column').map((c) => c.name)).toContain('c4');

    // 试图把沿着已作废 v3 继续延伸出 v5 的 ext 接入 C → 409 history_fork（绝不复活作废版本）
    const attExt = await C.call('POST', `/api/projects/${pid}/environments/attach`, {
      name: 'ext',
      url: ext.url,
      production: false,
      allowSameInstance: true,
      claim: true,
    });
    expect(attExt.status).toBe(409);
    expect(attExt.data.code).toBe('history_fork');
  }, 120_000);
});

describe.skipIf(!PG_URL)('只预演不执行（dry run）', () => {
  let A: Inst;
  beforeAll(async () => {
    A = await newInstance('R');
  });
  afterAll(drain);

  const dry = async (pid: string, eid: string, action: 'execute' | 'rollback', to?: string) => {
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

  test('检查没通过也是 200 + ok:false：漂移、未验证、锁被占用；都不写任何东西', async () => {
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
