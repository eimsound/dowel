// 执行策略（P5a）的接口场景：四层配置与“只能收紧”、放宽是特权操作、执行者授权、前置环境、语句超时与锁等待超时。
// 平台库用 SQLite；需要真正执行迁移的用例用测试 PG 当目标库 / 影子库（没有 Docker 时跳过这些用例）。
// 默认策略下的现有行为由 exec-policy.test.ts 覆盖（未改动断言）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DryRunResponse,
  EnvInfo,
  EnvPolicyView,
  ExecEvent,
  GrantInfo,
  PolicyLayerView,
  VersionDetail,
} from '@dowel/api';
import { addColumn, all, type Model } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { MIGRATIONS } from '../src/db.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'policy-routes-secret-0123456789';

interface Body extends Record<string, unknown> {
  error?: string;
  code?: string;
}

let db: PlatformDb;
let created: ReturnType<typeof createApp>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let groupSlug = '';
let groupId = '';
const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];

const call = async (method: string, path: string, json?: unknown, who = 'admin') => {
  const headers: Record<string, string> = { cookie: cookies[who]! };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await created.app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  let events: ExecEvent[] = [];
  if (res.headers.get('content-type')?.includes('text/event-stream'))
    events = text
      .split('\n\n')
      .filter((x) => x.trim())
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as ExecEvent);
  else
    try {
      data = JSON.parse(text);
    } catch {}
  return { status: res.status, data: data as Body, events };
};
const last = (events: ExecEvent[]) => events.at(-1)!;

/** 项目 + 给 pa / editor / viewer 的项目角色 */
const newProject = async (name: string) => {
  const p = await call('POST', '/api/projects', { name, groupId });
  expect(p.status).toBe(201);
  const pid = p.data.id as string;
  for (const [user, role] of [
    ['pa', 'admin'],
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ] as const)
    expect(
      (await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: ids[user], role }))
        .status,
    ).toBe(201);
  return pid;
};

/** 不连目标库的环境（只测鉴权：执行接口带不存在的版本，通过鉴权是 404） */
const fakeEnv = async (pid: string, name: string, production: boolean) => {
  const id = `${pid}-${name}`;
  await db.query(
    'insert into environments (id, project_id, name, url_enc, production) values ($1, $2, $3, $4, $5)',
    [id, pid, name, encrypt('postgres://u:p@127.0.0.1:1/x'), production],
  );
  return id;
};
const tryExecute = async (pid: string, eid: string, who: string) =>
  (await call('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to: 'nope' }, who)).status;

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
  });
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  for (const n of ['ga', 'pa', 'editor', 'viewer', 'dba', 'dba2', 'outsider'])
    ids[n] = (await makeUser(db, n, { name: n })).id;
  for (const n of ['admin', 'ga', 'pa', 'editor', 'viewer', 'dba', 'dba2', 'outsider']) {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: n, password: PASSWORD }),
    });
    cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  // 组：ga 是组管理员（组默认权限设为 none，避免组成员身份干扰）
  const g = await call('POST', '/api/groups', { slug: 'pol', name: '策略组', defaultRole: 'none' }, 'ga');
  expect(g.status).toBe(201);
  groupSlug = 'pol';
  groupId = g.data.id as string;
});

afterAll(async () => {
  await created.rooms.flush();
  await created.shadows.close();
  await db.close();
  if (!PG_URL) return;
  const adminConn = connect(PG_URL);
  for (const t of targets) {
    await adminConn.db
      .exec(`DROP DATABASE IF EXISTS ${new URL(t.url).pathname.slice(1)}_dowel WITH (FORCE)`)
      .catch(() => {});
    await t.close();
  }
  await adminConn.close();
});

describe('四层配置：只能收紧、锁定显示、放宽是特权操作', () => {
  test('组层设“仅限执行者”：项目编辑者 / 项目管理员被拒，执行者能执行；下级放宽被拒（422）', async () => {
    const pid = await newProject('layers');
    const dev = await fakeEnv(pid, 'dev', false);
    // 默认：编辑者能执行非生产
    expect(await tryExecute(pid, dev, 'editor')).toBe(404);
    // 组管理员把组层非生产设为仅限执行者
    const put = await call(
      'PUT',
      `/api/groups/${groupSlug}/exec-policy`,
      { nonProduction: { whoCanExecute: 'executor' } },
      'ga',
    );
    expect(put.status, JSON.stringify(put.data)).toBe(200);
    const view = put.data as unknown as PolicyLayerView;
    expect(view.resolved.nonProduction.whoCanExecute).toMatchObject({ value: 'executor', source: 'group' });
    expect(await tryExecute(pid, dev, 'editor')).toBe(403);
    const denied = await call(
      'POST',
      `/api/projects/${pid}/environments/${dev}/execute`,
      { to: 'nope' },
      'pa',
    );
    expect(denied.status).toBe(403);
    expect(denied.data.error).toContain('仅限执行者');
    expect(denied.data.error).toContain('组');
    // 项目层 / 环境层想放宽：422，什么都没写
    const loosen = await call(
      'PUT',
      `/api/projects/${pid}/exec-policy`,
      { nonProduction: { whoCanExecute: 'editor' } },
      'pa',
    );
    expect(loosen.status).toBe(422);
    expect(loosen.data.error).toContain('组');
    expect(
      (await call('PATCH', `/api/projects/${pid}/environments/${dev}`, { execPolicy: 'admin' }, 'admin'))
        .status,
    ).toBe(422);
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${dev}/exec-policy`,
          { settings: { whoCanExecute: 'editor' }, prerequisiteId: null },
          'admin',
        )
      ).status,
    ).toBe(422);
    // 项目页看到的是锁定：下限来自组
    const pv = (await call('GET', `/api/projects/${pid}/exec-policy`, undefined, 'viewer'))
      .data as unknown as PolicyLayerView;
    expect(pv.resolved.nonProduction.whoCanExecute).toMatchObject({
      floor: 'executor',
      floorSource: 'group',
    });
    expect(pv.canEdit).toBe(false);
    // 授予 dba 这个环境的执行者（非生产：项目管理员就能授）
    const grant = await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.dba, role: 'executor', environmentId: dev },
      'pa',
    );
    expect(grant.status, JSON.stringify(grant.data)).toBe(201);
    expect(grant.data).toMatchObject({ role: 'executor', scopeKind: 'environment', byInstanceAdmin: false });
    expect(await tryExecute(pid, dev, 'dba')).toBe(404); // 通过鉴权
    // 执行者能只读看项目、能检查漂移（鉴权通过），但不能编辑模型 / 发布
    expect((await call('GET', `/api/projects/${pid}`, undefined, 'dba')).status).toBe(200);
    expect((await call('POST', `/api/projects/${pid}/versions`, { name: 'x' }, 'dba')).status).toBe(403);
    expect(
      (await call('PATCH', `/api/projects/${pid}/environments/${dev}`, { allowSameInstance: true }, 'dba'))
        .status,
    ).toBe(403);
    const envs = (await call('GET', `/api/projects/${pid}/environments`, undefined, 'dba'))
      .data as unknown as EnvInfo[];
    expect(envs.find((e) => e.id === dev)!.permissions.execute).toBe(true);
    // 组外的人仍然看不见
    expect((await call('GET', `/api/projects/${pid}`, undefined, 'outsider')).status).toBe(404);
    // 收尾：放宽组层是特权操作——组管理员不是执行者，不能撤掉“仅限执行者”（403）；实例管理员可以
    const back = await call('PUT', `/api/groups/${groupSlug}/exec-policy`, {}, 'ga');
    expect(back.status).toBe(403);
    expect(back.data.error).toContain('执行者');
    expect((await call('PUT', `/api/groups/${groupSlug}/exec-policy`, {}, 'admin')).status).toBe(200);
    expect(await tryExecute(pid, dev, 'editor')).toBe(404);
    // 审计：每次修改一条 exec_policy.update，带层、改动前后、放宽了哪些
    const audits = await db.query<{ target_kind: string; data: { layer: string; loosened?: unknown } }>(
      "select target_kind, data from audit_events where action = 'exec_policy.update' order by at",
    );
    expect(audits.map((a) => a.target_kind)).toEqual(['group', 'group']);
    expect(audits[1]!.data.loosened).toEqual({ nonProduction: ['whoCanExecute'] });
  });

  test('收紧只要这一层的管理员；放宽要满足改动前的“谁能执行”', async () => {
    const pid = await newProject('tighten');
    const prod = await fakeEnv(pid, 'prod', true);
    // 项目管理员把生产环境收紧成仅限执行者（收紧：只要项目管理员）
    const t = await call(
      'PUT',
      `/api/projects/${pid}/environments/${prod}/exec-policy`,
      { settings: { whoCanExecute: 'executor', lockTimeoutMs: 2000 }, prerequisiteId: null },
      'pa',
    );
    expect(t.status, JSON.stringify(t.data)).toBe(200);
    expect((t.data as unknown as EnvPolicyView).resolved.lockTimeoutMs).toMatchObject({
      value: 2000,
      source: 'environment',
    });
    // 编辑者不能改（不是项目管理员）
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${prod}/exec-policy`,
          { settings: { whoCanExecute: 'executor', lockTimeoutMs: 1000 }, prerequisiteId: null },
          'editor',
        )
      ).status,
    ).toBe(403);
    // 再收紧（锁等待更短）仍然可以；放宽（撤掉仅限执行者）项目管理员不行
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${prod}/exec-policy`,
          { settings: { whoCanExecute: 'executor', lockTimeoutMs: 1000 }, prerequisiteId: null },
          'pa',
        )
      ).status,
    ).toBe(200);
    const loosen = await call(
      'PUT',
      `/api/projects/${pid}/environments/${prod}/exec-policy`,
      { settings: { whoCanExecute: 'executor' }, prerequisiteId: null },
      'pa',
    );
    expect(loosen.status).toBe(403);
    expect(loosen.data.error).toContain('仅限执行者');
    // 项目层：项目管理员收紧生产到“仅限执行者”，之后自己撤不掉
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/exec-policy`,
          { production: { whoCanExecute: 'executor' } },
          'pa',
        )
      ).status,
    ).toBe(200);
    const view = (await call('GET', `/api/projects/${pid}/exec-policy`, undefined, 'pa'))
      .data as unknown as PolicyLayerView;
    expect(view.canLoosen).toEqual({ production: false, nonProduction: true });
    expect(view.loosenNote).toContain('仅限执行者');
    expect((await call('PUT', `/api/projects/${pid}/exec-policy`, {}, 'pa')).status).toBe(403);
    // 项目管理员授予的项目级执行者：对“仅限执行者”的生产环境不算；实例管理员授予的才算
    const g1 = await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.pa, role: 'executor' },
      'pa',
    );
    expect(g1.status).toBe(201);
    expect(await tryExecute(pid, prod, 'pa')).toBe(403);
    expect((await call('PUT', `/api/projects/${pid}/exec-policy`, {}, 'pa')).status).toBe(403);
    // 环境范围的执行者：“仅限执行者”的生产环境上非实例管理员不能授予
    const g2 = await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.dba2, role: 'executor', environmentId: prod },
      'pa',
    );
    expect(g2.status).toBe(403);
    expect(g2.data.error).toContain('实例管理员');
    // 只有执行者能授予到环境；项目角色不能
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/grants`,
          { subjectKind: 'user', subjectId: ids.dba2, role: 'editor', environmentId: prod },
          'admin',
        )
      ).status,
    ).toBe(400);
    const g3 = await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: ids.dba2, role: 'executor', environmentId: prod },
      'admin',
    );
    expect(g3.status).toBe(201);
    expect(g3.data).toMatchObject({ byInstanceAdmin: true, environmentName: 'prod' });
    expect(await tryExecute(pid, prod, 'dba2')).toBe(404);
    // dba2 是这个环境的执行者但不是项目管理员：配置类操作（改连接、删环境）仍然不行
    expect(
      (await call('DELETE', `/api/projects/${pid}/environments/${prod}`, undefined, 'dba2')).status,
    ).toBe(403);
    // 执行者授权不能改成项目角色；列表里能看到环境范围的授权
    expect(
      (await call('PATCH', `/api/projects/${pid}/grants/${g1.data.id as string}`, { role: 'editor' }, 'pa'))
        .status,
    ).toBe(400);
    const list = (await call('GET', `/api/projects/${pid}/grants`, undefined, 'viewer')).data as unknown as {
      grants: GrantInfo[];
    };
    expect(
      list.grants
        .filter((g) => g.role === 'executor')
        .map((g) => g.scopeKind)
        .sort(),
    ).toEqual(['environment', 'project']);
    // 同一个对象在同一个范围上可以同时有项目角色和执行者授权（pa：项目管理员 + 执行者），重复的执行者授权 409
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/grants`,
          { subjectKind: 'user', subjectId: ids.pa, role: 'executor' },
          'pa',
        )
      ).status,
    ).toBe(409);
    // 删除环境范围的授权
    expect(
      (await call('DELETE', `/api/projects/${pid}/grants/${g3.data.id as string}`, undefined, 'pa')).status,
    ).toBe(200);
    // 这是 dba2 在这个项目里唯一的授权：删掉之后连项目都看不见了（404）
    expect(await tryExecute(pid, prod, 'dba2')).toBe(404);
  });

  test('改生产标记不会悄悄放宽：变宽的字段固定在环境层', async () => {
    const pid = await newProject('pin');
    const e = await fakeEnv(pid, 'e', true);
    expect(
      (await call('PUT', `/api/projects/${pid}/exec-policy`, { production: { lockTimeoutMs: 1000 } }, 'pa'))
        .status,
    ).toBe(200);
    const r = await call('PATCH', `/api/projects/${pid}/environments/${e}`, { production: false }, 'pa');
    expect(r.status).toBe(200);
    const info = r.data as unknown as EnvInfo;
    expect(info.policy.whoCanExecute).toMatchObject({ value: 'admin', source: 'environment' });
    expect(info.policy.lockTimeoutMs.value).toBe(1000);
    expect(info.policy.allowTokens.value).toBe(false);
  });

  test('PATCH 同时改生产标记和“谁能执行”：按改动后的生产标记对应的上级校验；审批流程也会被固定', async () => {
    const pid = await newProject('patch-both');
    const e = await fakeEnv(pid, 'e', true);
    // 项目层：非生产要求项目管理员，并有一个审批环节；生产什么都没设
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/exec-policy`,
          { nonProduction: { whoCanExecute: 'admin' } },
          'pa',
        )
      ).status,
    ).toBe(200);
    // 同时取消生产标记、把档位设成编辑者：新的上级（非生产那一套）要求至少项目管理员 → 422，什么都没写
    const bad = await call(
      'PATCH',
      `/api/projects/${pid}/environments/${e}`,
      { production: false, execPolicy: 'editor' },
      'pa',
    );
    expect(bad.status).toBe(422);
    expect(bad.data.error).toContain('项目');
    const [row] = await db.query<{ production: boolean | number }>(
      'select production from environments where id = $1',
      [e],
    );
    expect(Boolean(row!.production)).toBe(true);
    // 反过来：项目层的生产那一套要求仅限执行者，把非生产环境标成生产并设“项目编辑者” → 422（以前按旧的非生产上级校验会放过）
    const e2 = await fakeEnv(pid, 'e2', false);
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/exec-policy`,
          { nonProduction: { whoCanExecute: 'admin' }, production: { whoCanExecute: 'executor' } },
          'pa',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'PATCH',
          `/api/projects/${pid}/environments/${e2}`,
          { production: true, execPolicy: 'admin' },
          'pa',
        )
      ).status,
    ).toBe(422);
    // 生产环境上设了审批环节（项目层生产那一套），取消生产标记：审批流程被固定进环境层，不会悄悄变短
    const p2 = await newProject('patch-approval');
    const e3 = await fakeEnv(p2, 'e3', true);
    const stage = { approvers: { kind: 'group_admins' }, count: 1 };
    expect(
      (await call('PUT', `/api/projects/${p2}/exec-policy`, { production: { approval: [stage] } }, 'pa'))
        .status,
    ).toBe(200);
    const r = await call('PATCH', `/api/projects/${p2}/environments/${e3}`, { production: false }, 'pa');
    expect(r.status).toBe(200);
    expect((r.data as unknown as EnvInfo).policy.approval.stages.map((s) => s.source)).toEqual([
      'environment',
    ]);
    const audit = await db.query<{ data: { policy?: { pinned?: string[] } } }>(
      "select data from audit_events where action = 'environment.update' and target_id = $1",
      [e3],
    );
    expect(audit.at(-1)!.data.policy!.pinned).toEqual(
      expect.arrayContaining(['whoCanExecute', 'allowTokens', 'approval']),
    );
  });

  test('转组不会悄悄放宽：新组层更宽的字段固定进环境层，审计记下来；组范围的执行者授权随转组失效', async () => {
    // 源组 pol：非生产要求项目管理员、锁等待 2 秒；目标组 pol2 什么都没设
    expect(
      (
        await call(
          'PUT',
          `/api/groups/${groupSlug}/exec-policy`,
          { nonProduction: { whoCanExecute: 'admin', lockTimeoutMs: 2000 } },
          'ga',
        )
      ).status,
    ).toBe(200);
    const g2 = await call('POST', '/api/groups', { slug: 'pol2', name: '目标组', defaultRole: 'none' }, 'ga');
    expect(g2.status).toBe(201);
    const pid = await newProject('transfer');
    const dev = await fakeEnv(pid, 'dev', false);
    // dba 是源组范围的执行者（组管理员授予）：转组前对 dev 有效
    expect(
      (
        await call(
          'POST',
          `/api/groups/${groupSlug}/grants`,
          { subjectKind: 'user', subjectId: ids.dba, role: 'executor' },
          'ga',
        )
      ).status,
    ).toBe(201);
    expect(await tryExecute(pid, dev, 'dba')).toBe(404);
    expect(await tryExecute(pid, dev, 'editor')).toBe(403);
    const t = await call('POST', `/api/projects/${pid}/transfer`, { groupId: g2.data.id }, 'ga');
    expect(t.status, JSON.stringify(t.data)).toBe(200);
    // 生效策略没有变宽：编辑者仍然被拒，锁等待仍是 2 秒，来源变成环境层（被固定）
    expect(await tryExecute(pid, dev, 'editor')).toBe(403);
    const envs = (await call('GET', `/api/projects/${pid}/environments`, undefined, 'pa'))
      .data as unknown as EnvInfo[];
    const info = envs.find((x) => x.id === dev)!;
    expect(info.policy.whoCanExecute).toMatchObject({ value: 'admin', source: 'environment' });
    expect(info.policy.lockTimeoutMs).toMatchObject({ value: 2000, source: 'environment' });
    // 源组范围的执行者授权对转走的项目不再有效（也看不见项目了）
    expect(await tryExecute(pid, dev, 'dba')).toBe(404);
    expect((await call('GET', `/api/projects/${pid}`, undefined, 'dba')).status).toBe(404);
    const [audit] = await db.query<{ data: { policyPinned?: { name: string; pinned: string[] }[] } }>(
      "select data from audit_events where action = 'project.transfer' and project_id = $1",
      [pid],
    );
    expect(audit!.data.policyPinned).toEqual([
      { environment: dev, name: 'dev', pinned: ['whoCanExecute', 'lockTimeoutMs'] },
    ]);
    // 收尾：组层改回（实例管理员；组管理员不是执行者但这里不是“仅限执行者”，也可以）
    expect((await call('PUT', `/api/groups/${groupSlug}/exec-policy`, {}, 'ga')).status).toBe(200);
  });

  test('审批流程（P5b 预留）：只存、校验、展示；上级的环节在下级锁定；引用不存在的组被拒', async () => {
    const pid = await newProject('approval');
    const e = await fakeEnv(pid, 'e', true);
    const stage = { approvers: { kind: 'group_admins' }, count: 1 };
    expect(
      (await call('PUT', `/api/projects/${pid}/exec-policy`, { production: { approval: [stage] } }, 'pa'))
        .status,
    ).toBe(200);
    const bad = await call(
      'PUT',
      `/api/projects/${pid}/environments/${e}/exec-policy`,
      {
        settings: { approval: [{ approvers: { kind: 'group_members', groupId: 'no-such' }, count: 1 }] },
        prerequisiteId: null,
      },
      'pa',
    );
    expect(bad.status).toBe(422);
    const ok = await call(
      'PUT',
      `/api/projects/${pid}/environments/${e}/exec-policy`,
      {
        settings: {
          approval: [{ approvers: { kind: 'group_members', groupId }, count: 2, lastApproverExecutes: true }],
        },
        prerequisiteId: null,
      },
      'pa',
    );
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const view = ok.data as unknown as EnvPolicyView;
    expect(view.resolved.approval.stages.map((s) => [s.source, s.locked])).toEqual([
      ['project', true],
      ['environment', false],
    ]);
    expect(view.names[groupId]).toBe('策略组');
    // 删掉自己追加的环节 = 放宽（审批流程不再包含原流程），生产默认档位是项目管理员，pa 满足
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${e}/exec-policy`,
          { settings: {}, prerequisiteId: null },
          'pa',
        )
      ).status,
    ).toBe(200);
  });
});

describe('前置环境', () => {
  test('同项目、不能是自己、不能成环；被引用的环境不能删', async () => {
    const pid = await newProject('prereq-rules');
    const dev = await fakeEnv(pid, 'dev', false);
    const stg = await fakeEnv(pid, 'stg', false);
    const prod = await fakeEnv(pid, 'prod', true);
    const set = (eid: string, prerequisiteId: string | null, who = 'pa') =>
      call(
        'PUT',
        `/api/projects/${pid}/environments/${eid}/exec-policy`,
        { settings: {}, prerequisiteId },
        who,
      );
    expect((await set(stg, dev)).status).toBe(200);
    expect((await set(prod, stg)).status).toBe(200);
    expect((await set(prod, prod)).status).toBe(422);
    const cyc = await set(dev, prod);
    expect(cyc.status).toBe(422);
    expect(cyc.data.error).toContain('循环');
    const other = await newProject('prereq-other');
    const foreign = await fakeEnv(other, 'x', false);
    expect((await set(prod, foreign)).status).toBe(422);
    // 候选列表里会成环的标为不可选
    const view = (
      await call('GET', `/api/projects/${pid}/environments/${dev}/exec-policy`, undefined, 'viewer')
    ).data as unknown as EnvPolicyView;
    expect(view.candidates.find((c) => c.id === prod)!.disabled).toContain('循环');
    expect(view.candidates.find((c) => c.id === stg)!.disabled).toContain('循环');
    // 被引用的环境不能删
    const del = await call('DELETE', `/api/projects/${pid}/environments/${stg}`, undefined, 'pa');
    expect(del.status).toBe(409);
    expect(del.data.error).toContain('prod');
    // 数据库层面也不会悬空：直接删被引用的环境、或者把前置环境设成不存在的环境，都被约束拒绝（SQLite 触发器 / PG 外键）
    await expect(db.query('delete from environments where id = $1', [stg])).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      db.query("update environments set prerequisite_id = 'no-such-env' where id = $1", [prod]),
    ).rejects.toThrow(/FOREIGN KEY/);
    // 去掉前置环境是放宽：生产环境默认要项目管理员，编辑者不行（也不是项目管理员），pa 可以
    expect((await set(prod, null, 'editor')).status).toBe(403);
    expect((await set(prod, null)).status).toBe(200);
    // 删项目时同一个项目里的环境互相引用也能整体删掉
    expect((await set(stg, dev)).status).toBe(200);
    const slug = (await call('GET', `/api/projects/${pid}`)).data.slug as string;
    expect((await call('DELETE', `/api/projects/${pid}`, { confirm: slug })).status).toBe(200);
  });
});

describe.skipIf(!PG_URL)('真实执行：执行者、前置环境、超时（目标库 PG）', () => {
  /** 指向新建测试库的环境 */
  const realEnv = async (pid: string, name: string, production = false) => {
    const target = await createTestDb('pol_tgt');
    targets.push(target);
    const e = await call('POST', `/api/projects/${pid}/environments`, {
      name,
      url: target.url,
      production,
      allowSameInstance: true,
    });
    expect(e.status, JSON.stringify(e.data)).toBe(201);
    return { eid: e.data.id as string, target };
  };
  const tableOf = (m: Model) => all(m, 'table').find((t) => t.name === 'orders')!.id;
  const publish = async (pid: string, name: string) => {
    const r = await call('POST', `/api/projects/${pid}/versions`, { name });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data as unknown as { id: string; number: number };
  };
  const publishChain = async (pid: string, n: number) => {
    const out: { id: string; number: number }[] = [];
    for (let i = 1; i <= n; i++) {
      if (i === 1) await addTable(created.rooms, db, pid);
      else
        await editModel(
          created.rooms,
          db,
          pid,
          (m) => void addColumn(m, tableOf(m), { name: `c${i}`, type: 'text' }),
        );
      out.push(await publish(pid, `v${i}`));
    }
    return out;
  };
  const exec = (
    pid: string,
    eid: string,
    action: 'execute' | 'rollback',
    to: string,
    who = 'admin',
    extra = {},
  ) => call('POST', `/api/projects/${pid}/environments/${eid}/${action}`, { to, ...extra }, who);

  test('仅限执行者：执行者真正执行成功；前置环境拒绝执行、预演给出同样的原因、回滚豁免', async () => {
    const pid = await newProject('real');
    const dev = await realEnv(pid, 'dev');
    const prod = await realEnv(pid, 'prod', true);
    const [v1, v2] = await publishChain(pid, 2);
    // prod：前置环境 dev，仅限执行者；dba 由实例管理员授予 prod 的执行者
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${prod.eid}/exec-policy`,
          { settings: { whoCanExecute: 'executor' }, prerequisiteId: dev.eid },
          'pa',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/grants`,
          { subjectKind: 'user', subjectId: ids.dba, role: 'executor', environmentId: prod.eid },
          'admin',
        )
      ).status,
    ).toBe(201);
    // dev 还没执行过：prod 执行 v1 被前置环境拒绝（422，code）；预演 200 + ok:false，同一个代码和说明
    const dry = await exec(pid, prod.eid, 'execute', v1!.id, 'dba', { dryRun: true });
    expect(dry.status).toBe(200);
    const d = dry.data as unknown as DryRunResponse;
    expect(d).toMatchObject({ ok: false, code: 'prerequisite_behind' });
    expect(d.prerequisite).toMatchObject({ ok: false, name: 'dev', currentNumber: null });
    const rejected = await exec(pid, prod.eid, 'execute', v1!.id, 'dba', { confirm: 'prod' });
    expect(rejected.status).toBe(422);
    expect(rejected.data.code).toBe('prerequisite_behind');
    expect(rejected.data.error).toContain('dev');
    // 目标库没被碰过
    expect((await prod.target.db.query("select 1 from pg_namespace where nspname = 'dowel'")).length).toBe(0);
    // dev 执行到 v1（编辑者，默认档位）→ prod 可以到 v1，不能到 v2
    expect(last((await exec(pid, dev.eid, 'execute', v1!.id, 'editor')).events)).toMatchObject({
      stage: 'done',
    });
    // 项目编辑者 / 项目管理员在 prod 上被拒（仅限执行者）；执行者成功
    expect((await exec(pid, prod.eid, 'execute', v1!.id, 'pa', { confirm: 'prod' })).status).toBe(403);
    const ok = await exec(pid, prod.eid, 'execute', v1!.id, 'dba', { confirm: 'prod' });
    expect(last(ok.events), JSON.stringify(last(ok.events))).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
    const toV2 = await exec(pid, prod.eid, 'execute', v2!.id, 'dba', { confirm: 'prod' });
    expect(toV2.status).toBe(422);
    const dry2 = (await exec(pid, prod.eid, 'execute', v2!.id, 'dba', { dryRun: true }))
      .data as unknown as DryRunResponse;
    expect(dry2.prerequisite).toMatchObject({ ok: false, currentNumber: 1 });
    // dev 到 v2 后 prod 也能到 v2；然后 dev 回滚到 v1，prod 回滚到 v1 不受约束（豁免记进审计）
    expect(last((await exec(pid, dev.eid, 'execute', v2!.id, 'editor')).events)).toMatchObject({
      stage: 'done',
    });
    expect(
      last((await exec(pid, prod.eid, 'execute', v2!.id, 'dba', { confirm: 'prod' })).events),
    ).toMatchObject({
      stage: 'done',
    });
    expect(last((await exec(pid, dev.eid, 'rollback', v1!.id, 'editor')).events)).toMatchObject({
      stage: 'done',
    });
    // 前置环境落后时，prod 再执行 v2 是空操作以外的事都会被拒——但回滚照常
    expect(
      last((await exec(pid, prod.eid, 'rollback', v1!.id, 'dba', { confirm: 'prod' })).events),
    ).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
    const audits = await db.query<{ action: string; data: Record<string, unknown> }>(
      "select action, data from audit_events where project_id = $1 and action in ('environment.execute', 'environment.rollback') order by at",
      [pid],
    );
    const prodRuns = audits.filter((a) => a.data.name === 'prod');
    expect(prodRuns.at(-1)).toMatchObject({
      action: 'environment.rollback',
      data: { ok: true, prerequisiteExempt: true, whoCanExecute: 'executor', viaExecutor: true },
    });
    expect(prodRuns[0]!.data).toMatchObject({ timeouts: { lockMs: 5000, statementMs: 0 } });
  });

  test('lock_timeout：另一个会话持锁时执行在超时后失败并提示是等锁超时，释放后重试成功', async () => {
    const pid = await newProject('locktimeout');
    const dev = await realEnv(pid, 'dev');
    const [v1, v2] = await publishChain(pid, 2);
    expect(last((await exec(pid, dev.eid, 'execute', v1!.id)).events)).toMatchObject({ stage: 'done' });
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${dev.eid}/exec-policy`,
          { settings: { lockTimeoutMs: 800 }, prerequisiteId: null },
          'pa',
        )
      ).status,
    ).toBe(200);
    // 另开一个会话，在事务里锁住 orders（ACCESS SHARE 就够挡住 ALTER TABLE 要的 ACCESS EXCLUSIVE）
    const holder = connect(dev.target.url);
    const reserved = await holder.db.reserve!();
    try {
      await reserved.exec('BEGIN');
      await reserved.exec('LOCK TABLE public.orders IN ACCESS SHARE MODE');
      const started = Date.now();
      const r = await exec(pid, dev.eid, 'execute', v2!.id);
      const ev = last(r.events);
      expect(ev.code, JSON.stringify(ev)).toBe('step_timeout');
      expect(ev.details?.timeout).toEqual({ kind: 'lock', ms: 800 });
      expect(ev.error).toContain('等锁');
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await reserved.exec('ROLLBACK').catch(() => {});
      reserved.release?.();
      await holder.close();
    }
    // 重试成功（纯事务迁移：整体回滚过，从头执行）
    const retry = await exec(pid, dev.eid, 'execute', v2!.id);
    expect(last(retry.events)).toMatchObject({ stage: 'done', current: { number: 2 } });
  });

  test('statement_timeout：慢语句超时失败并提示；放宽超时后重试成功', async () => {
    const pid = await newProject('stmttimeout');
    const dev = await realEnv(pid, 'dev');
    const [v1] = await publishChain(pid, 1);
    // 在 v1 的升级脚本最前面插一步慢语句，重新验证（影子库里照常跑完）
    const detail = (await call('GET', `/api/projects/${pid}/versions/${v1!.id}`))
      .data as unknown as VersionDetail;
    const patch = await call('PATCH', `/api/projects/${pid}/versions/${v1!.id}/steps`, {
      up: [{ sql: 'SELECT pg_sleep(2)', transactional: true }, ...detail.upSteps],
      down: detail.downSteps,
    });
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
    expect((await call('POST', `/api/projects/${pid}/versions/${v1!.id}/verify`)).status).toBe(200);
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${dev.eid}/exec-policy`,
          { settings: { statementTimeoutMs: 500 }, prerequisiteId: null },
          'pa',
        )
      ).status,
    ).toBe(200);
    const r = await exec(pid, dev.eid, 'execute', v1!.id);
    const ev = last(r.events);
    expect(ev.code, JSON.stringify(ev)).toBe('step_timeout');
    expect(ev.details).toMatchObject({ timeout: { kind: 'statement', ms: 500 }, step: 1 });
    expect(ev.error).toContain('语句超时');
    // 去掉语句超时（放宽：非生产默认档位是编辑者，pa 满足）→ 重试成功
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${dev.eid}/exec-policy`,
          { settings: {}, prerequisiteId: null },
          'pa',
        )
      ).status,
    ).toBe(200);
    expect(last((await exec(pid, dev.eid, 'execute', v1!.id)).events)).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
  });
});

describe.skipIf(!PG_URL)('前置环境悬空时拒绝执行（目标库 PG）', () => {
  test('前置环境行没了（绕过约束删掉）：执行 422 prerequisite_missing，预演同样拒绝，回滚不受影响', async () => {
    const pid = await newProject('dangling');
    const target = await createTestDb('pol_dangle');
    targets.push(target);
    const e = await call('POST', `/api/projects/${pid}/environments`, {
      name: 'stg',
      url: target.url,
      production: false,
      allowSameInstance: true,
    });
    expect(e.status).toBe(201);
    const stg = e.data.id as string;
    const dev = await fakeEnv(pid, 'dev', false);
    await addTable(created.rooms, db, pid);
    const v1 = (await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' })).data as unknown as {
      id: string;
    };
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${stg}/exec-policy`,
          { settings: {}, prerequisiteId: dev },
          'pa',
        )
      ).status,
    ).toBe(200);
    // 模拟悬空：绕过约束（这个测试文件的平台库是 SQLite：先删掉触发器）直接删掉前置环境
    for (const t of ['delete', 'insert', 'update'])
      await db.exec(`drop trigger if exists environments_prerequisite_${t}`);
    await db.query('delete from environments where id = $1', [dev]);
    const r = await call('POST', `/api/projects/${pid}/environments/${stg}/execute`, { to: v1.id }, 'pa');
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('prerequisite_missing');
    expect(r.data.error).toContain('不存在');
    const dry = (
      await call(
        'POST',
        `/api/projects/${pid}/environments/${stg}/execute`,
        { to: v1.id, dryRun: true },
        'pa',
      )
    ).data as unknown as DryRunResponse;
    expect(dry).toMatchObject({ ok: false, code: 'prerequisite_missing' });
    // 环境状态里如实标出来（界面据此拒绝）
    const st = (await call('GET', `/api/projects/${pid}/environments/${stg}/status`, undefined, 'pa'))
      .data as unknown as {
      prerequisite: { missing?: boolean } | null;
    };
    expect(st.prerequisite).toMatchObject({ missing: true });
    // 目标库没被碰
    expect((await target.db.query("select 1 from pg_namespace where nspname = 'dowel'")).length).toBe(0);
  });
});

describe('平台库迁移：H6 的档位搬进执行策略的环境层', () => {
  test.each([
    { platform: 'sqlite', skip: false },
    { platform: 'pg', skip: !PG_URL },
  ])('$platform', async ({ platform, skip }) => {
    if (skip) return;
    const pg = platform === 'pg' ? await createTestDb('pol_mig') : null;
    const dir = pg ? null : mkdtempSync(join(tmpdir(), 'dowel-pol-'));
    const url = pg?.url ?? join(dir!, 'p.db');
    const fresh = await openPlatformDb(url);
    try {
      // 退回到 P5a 之前：删掉新表 / 新列，加回 exec_policy，grants 的执行者授权先清掉（旧约束不认识它）
      // P5b 的迁移（执行申请、审批、收件箱、Webhook）在 P5a 之后，一起退回去
      for (const t of ['inbox_items', 'exec_approvals', 'exec_requests', 'webhook_deliveries', 'webhooks'])
        await fresh.exec(`drop table ${t}`);
      await fresh.exec('drop table exec_policies');
      if (platform === 'sqlite')
        for (const t of ['delete', 'insert', 'update'])
          await fresh.exec(`drop trigger if exists environments_prerequisite_${t}`);
      await fresh.exec('alter table environments drop column prerequisite_id');
      await fresh.exec('alter table environments add column exec_policy text');
      // P5a 的两条迁移（策略表 / 执行者 / 前置环境，和前置环境的约束）和之后 P5b 的一条都退回去
      await fresh.query('delete from dowel_migrations where version > $1', [MIGRATIONS.length - 3]);
      await fresh.query("insert into groups (id, slug, name) values ('g1', 'g1', 'g')");
      await fresh.query("insert into projects (id, name, group_id, slug) values ('p1', 'p', 'g1', 'p')");
      for (const [id, pol] of [
        ['e1', 'executor'],
        ['e2', null],
        ['e3', 'editor'],
      ] as const)
        await fresh.query(
          'insert into environments (id, project_id, name, url_enc, production, exec_policy) values ($1, $2, $1, $3, $4, $5)',
          [id, 'p1', 'x', true, pol],
        );
    } finally {
      await fresh.close();
    }
    const upgraded = await openPlatformDb(url);
    try {
      const rows = await upgraded.query<{ scope_id: string; policy: { whoCanExecute?: string } }>(
        "select scope_id, policy from exec_policies where scope_kind = 'environment' order by scope_id",
      );
      expect(rows.map((r) => [r.scope_id, r.policy.whoCanExecute])).toEqual([
        ['e1', 'executor'],
        ['e3', 'editor'],
      ]);
      const cols =
        platform === 'pg'
          ? await upgraded.query<{ c: string }>(
              "select column_name as c from information_schema.columns where table_name = 'environments' and column_name in ('exec_policy', 'prerequisite_id')",
            )
          : (await upgraded.query<{ name: string }>('pragma table_info(environments)'))
              .filter((r) => r.name === 'exec_policy' || r.name === 'prerequisite_id')
              .map((r) => ({ c: r.name }));
      expect(cols.map((c) => c.c)).toEqual(['prerequisite_id']);
    } finally {
      await upgraded.close();
      await pg?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });
});
