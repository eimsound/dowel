// 执行申请与审批（P5b）的场景测试：平台库 SQLite，目标库 / 影子库用测试 PG（没有 Docker 时跳过）。
// 表驱动的场景：默认单环节、多环节（含人数 > 1）、驳回、撤回、过期、环境状态变化失效（直接执行、漂移、链变化）、紧急执行、
// 前置环境拒绝、“最后一个审批人即执行者”、同人多环节逐个确认、审批人资格被撤销、策略中途变化。
// 并发场景（平台库 PG）在 requests-concurrency.test.ts。
import type {
  DryRunResponse,
  ExecEvent,
  ExecRequestDetail,
  ExecRequestSummary,
  InboxList,
  PendingRequest,
  PolicySettings,
} from '@dowel/api';
import { addColumn, all, type Model } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'requests-test-secret-0123456789';

interface Body extends Record<string, unknown> {
  error?: string;
  code?: string;
}

const USERS = ['admin', 'ga', 'pa', 'dev', 'viewer', 'dba', 'dba2', 'outsider'] as const;
type Who = (typeof USERS)[number];

let db: PlatformDb;
let created: ReturnType<typeof createApp>;
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
let groupId = '';
let dbaGroupId = '';
const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];

const call = async (method: string, path: string, json?: unknown, who: Who = 'admin') => {
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
      .filter((x) => x.trim().startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as ExecEvent);
  else
    try {
      data = JSON.parse(text);
    } catch {}
  return { status: res.status, data: data as Body, events };
};
const last = (events: ExecEvent[]) => events.at(-1)!;

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
  });
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  for (const n of USERS.filter((u) => u !== 'admin')) ids[n] = (await makeUser(db, n, { name: n })).id;
  ids.admin = (await db.query<{ id: string }>("select id from users where username = 'admin'"))[0]!.id;
  for (const n of USERS) {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: n, password: PASSWORD }),
    });
    cookies[n] = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  // 组：ga 是组管理员（默认权限 none，成员身份不带项目角色）
  const g = await call('POST', '/api/groups', { slug: 'req', name: '申请组', defaultRole: 'none' }, 'ga');
  expect(g.status).toBe(201);
  groupId = g.data.id as string;
  // DBA 组：dba、dba2 是成员
  const d = await call('POST', '/api/groups', { slug: 'dba', name: 'DBA', defaultRole: 'none' }, 'admin');
  dbaGroupId = d.data.id as string;
  for (const u of ['dba', 'dba2'] as const)
    expect(
      (await call('POST', '/api/groups/dba/members', { username: u, role: 'member' }, 'admin')).status,
    ).toBe(200);
});

afterAll(async () => {
  created.requests.stop();
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

/** 项目 + pa 项目管理员 / dev 编辑者 / viewer 查看者 */
const newProject = async (name: string) => {
  const p = await call('POST', '/api/projects', { name, groupId }, 'ga');
  expect(p.status).toBe(201);
  const pid = p.data.id as string;
  for (const [user, role] of [
    ['pa', 'admin'],
    ['dev', 'editor'],
    ['viewer', 'viewer'],
  ] as const)
    expect(
      (await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: ids[user], role }))
        .status,
    ).toBe(201);
  return pid;
};

const realEnv = async (pid: string, name: string, production = true) => {
  const target = await createTestDb('req_tgt');
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
const publishChain = async (pid: string, n: number, start = 1) => {
  const out: { id: string; number: number }[] = [];
  for (let i = start; i < start + n; i++) {
    if (i === 1) await addTable(created.rooms, db, pid);
    else
      await editModel(
        created.rooms,
        db,
        pid,
        (m) => void addColumn(m, tableOf(m), { name: `c${i}`, type: 'text' }),
      );
    const r = await call('POST', `/api/projects/${pid}/versions`, { name: `v${i}` });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    out.push(r.data as unknown as { id: string; number: number });
  }
  return out;
};

const setProjectPolicy = async (pid: string, production: PolicySettings) => {
  const r = await call('PUT', `/api/projects/${pid}/exec-policy`, { production }, 'admin');
  expect(r.status, JSON.stringify(r.data)).toBe(200);
};

const grantExecutor = async (pid: string, eid: string, who: Who) =>
  expect(
    (
      await call(
        'POST',
        `/api/projects/${pid}/grants`,
        { subjectKind: 'user', subjectId: ids[who], role: 'executor', environmentId: eid },
        'admin',
      )
    ).status,
  ).toBe(201);

const submit = (pid: string, eid: string, to: string, who: Who, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/projects/${pid}/environments/${eid}/requests`, { kind: 'execute', to, ...extra }, who);

const detail = async (pid: string, rid: string, who: Who = 'admin') => {
  const r = await call('GET', `/api/projects/${pid}/requests/${rid}`, undefined, who);
  expect(r.status).toBe(200);
  return r.data as unknown as ExecRequestDetail;
};
const approve = (pid: string, rid: string, stage: number, who: Who, comment = '') =>
  call('POST', `/api/projects/${pid}/requests/${rid}/approve`, { stage, comment }, who);
const approveAndExecute = (pid: string, rid: string, stage: number, who: Who, confirm = 'prod') =>
  call(
    'POST',
    `/api/projects/${pid}/requests/${rid}/execute`,
    { approve: { stage, comment: '' }, confirm },
    who,
  );
const executeReq = (pid: string, rid: string, who: Who, confirm = 'prod') =>
  call('POST', `/api/projects/${pid}/requests/${rid}/execute`, { confirm }, who);
const inbox = async (who: Who) =>
  (await call('GET', '/api/me/inbox', undefined, who)).data as unknown as InboxList;
describe.skipIf(!PG_URL)('执行申请：表驱动场景（目标库 PG）', () => {
  test('默认单环节：有权者直接执行；无权者提交申请，有权者“通过并执行”；申请人不能自批；查看者不能提交', async () => {
    const pid = await newProject('default');
    const prod = await realEnv(pid, 'prod');
    const [v1, v2] = await publishChain(pid, 2);
    // 生产默认“谁能执行” = 项目管理员：dev 直接执行 403，可以提交申请；查看者连申请也不能提交
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/environments/${prod.eid}/execute`,
          { to: v1!.id, confirm: 'prod' },
          'dev',
        )
      ).status,
    ).toBe(403);
    expect((await submit(pid, prod.eid, v1!.id, 'viewer')).status).toBe(403);
    // 预演（只看，不提交）
    const dry = await submit(pid, prod.eid, v1!.id, 'dev', { dryRun: true });
    expect((dry.data as unknown as DryRunResponse).ok).toBe(true);
    expect((await call('GET', `/api/projects/${pid}/requests`, undefined, 'dev')).data).toEqual([]);
    const sub = await submit(pid, prod.eid, v1!.id, 'dev', { reason: '上线订单表' });
    expect(sub.status, JSON.stringify(sub.data)).toBe(201);
    const req = sub.data as unknown as ExecRequestDetail;
    expect(req).toMatchObject({
      status: 'pending',
      stage: 0,
      stageCount: 1,
      implicit: true,
      kind: 'execute',
      from: null,
      to: { id: v1!.id, number: 1 },
      reason: '上线订单表',
    });
    expect(req.migrations.map((m) => [m.number, m.direction])).toEqual([[1, 'up']]);
    expect(req.stages[0]).toMatchObject({
      approvers: { kind: 'can_execute' },
      count: 1,
      lastApproverExecutes: true,
    });
    // 默认 24 小时过期
    const ttl = new Date(req.expiresAt).getTime() - new Date(req.createdAt).getTime();
    expect(Math.round(ttl / 3600_000)).toBe(24);
    // 有执行权限的人（pa、ga、实例管理员）收到“待我审批”
    for (const who of ['pa', 'ga', 'admin'] as const) {
      const box = await inbox(who);
      expect(box.unread, who).toBeGreaterThan(0);
      expect(box.items[0]).toMatchObject({
        kind: 'approval_needed',
        requestId: req.id,
        data: { action: 'approve' },
      });
    }
    // dev 自己不能批；看到说明
    expect((await detail(pid, req.id, 'dev')).actions).toMatchObject({
      approve: false,
      approveAndExecute: false,
      withdraw: true,
      note: '申请人不能审批自己的申请',
    });
    expect((await approveAndExecute(pid, req.id, 0, 'dev')).status).toBe(403);
    // pa：通过并执行（默认流程的最后一个审批人即执行者）；单独“通过”被拒（必须同时执行）
    expect((await detail(pid, req.id, 'pa')).actions).toMatchObject({
      approve: false,
      approveAndExecute: true,
    });
    expect((await approve(pid, req.id, 0, 'pa')).status).toBe(422);
    // 生产环境要输入环境名
    expect((await approveAndExecute(pid, req.id, 0, 'pa', 'wrong')).status).toBe(422);
    const run = await approveAndExecute(pid, req.id, 0, 'pa');
    expect(last(run.events), JSON.stringify(last(run.events))).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
    const done = await detail(pid, req.id, 'dev');
    expect(done).toMatchObject({ status: 'executed', executedBy: { id: ids.pa }, result: { ok: true } });
    expect(done.timeline.map((t) => t.kind)).toEqual(['created', 'approve', 'execute', 'executed']);
    // 申请人收到执行结果
    expect((await inbox('dev')).items[0]).toMatchObject({
      kind: 'request_result',
      data: { status: 'executed' },
    });
    // 有权者直接执行（不需要申请）；审计里能看到申请执行的那一条带 requestId
    const direct = await call(
      'POST',
      `/api/projects/${pid}/environments/${prod.eid}/execute`,
      { to: v2!.id, confirm: 'prod' },
      'pa',
    );
    expect(last(direct.events)).toMatchObject({ stage: 'done', current: { number: 2 } });
    const audits = await db.query<{ action: string; data: Record<string, unknown> }>(
      "select action, data from audit_events where project_id = $1 and action = 'environment.execute' order by at",
      [pid],
    );
    expect(audits[0]!.data).toMatchObject({ requestId: req.id, ok: true });
    expect(audits[1]!.data.requestId).toBeUndefined();
  });

  test('多环节（人数 > 1）+ 最后一个审批人即执行者：组管理员 → 两个 DBA，第二个 DBA“通过并执行”', async () => {
    const pid = await newProject('multi');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await grantExecutor(pid, prod.eid, 'dba');
    await grantExecutor(pid, prod.eid, 'dba2');
    await setProjectPolicy(pid, {
      whoCanExecute: 'executor',
      approval: [
        { approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: false },
        { approvers: { kind: 'group_members', groupId: dbaGroupId }, count: 2, lastApproverExecutes: true },
      ],
    });
    // 配置了审批环节：谁都不能直接执行，实例管理员也不行
    for (const who of ['dba', 'admin'] as const) {
      const r = await call(
        'POST',
        `/api/projects/${pid}/environments/${prod.eid}/execute`,
        { to: v1!.id, confirm: 'prod' },
        who,
      );
      expect(r.status, who).toBe(403);
      expect(r.data.code).toBe('approval_required');
    }
    const req = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect(req.stageCount).toBe(2);
    // 有资格的：dba、dba2，以及建 DBA 组的实例管理员（组管理员也是组成员）
    expect(req.stages[1]).toMatchObject({ count: 2, eligible: 3, label: '组“DBA”的成员' });
    // 第一个环节的人收到通知，第二个环节的人还没有
    expect((await inbox('ga')).items.some((i) => i.requestId === req.id)).toBe(true);
    expect((await inbox('dba')).items.some((i) => i.requestId === req.id)).toBe(false);
    // DBA 不能越级批第二个环节
    expect((await approve(pid, req.id, 1, 'dba')).status).toBe(409);
    expect((await approve(pid, req.id, 0, 'dba')).status).toBe(403);
    expect((await approve(pid, req.id, 0, 'ga', '可以')).status).toBe(200);
    // 进入第二个环节，DBA 们收到通知；“待我审批”里有它
    expect((await inbox('dba')).items[0]).toMatchObject({ requestId: req.id, data: { action: 'approve' } });
    const pending = (await call('GET', '/api/me/inbox/pending', undefined, 'dba'))
      .data as unknown as PendingRequest[];
    expect(pending.map((p) => [p.id, p.myAction])).toEqual([[req.id, 'approve']]);
    // 第二个环节要两个人：第一个 DBA 只能“通过”（还没凑够），第二个 DBA 才能“通过并执行”
    expect((await detail(pid, req.id, 'dba')).actions).toMatchObject({
      approve: true,
      approveAndExecute: false,
    });
    expect((await approve(pid, req.id, 1, 'dba')).status).toBe(200);
    expect((await approve(pid, req.id, 1, 'dba')).status).toBe(409); // 同一个人不能在同一环节批两次
    const d2 = await detail(pid, req.id, 'dba2');
    expect(d2.actions).toMatchObject({ approve: false, approveAndExecute: true });
    expect(d2.stages[1]!.approvals.map((a) => a.userName)).toEqual(['dba']);
    const run = await approveAndExecute(pid, req.id, 1, 'dba2');
    expect(last(run.events), JSON.stringify(last(run.events))).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
    const done = await detail(pid, req.id);
    expect(done.status).toBe('executed');
    expect(done.timeline.map((t) => [t.kind, t.userName])).toEqual([
      ['created', 'dev'],
      ['approve', 'ga'],
      ['approve', 'dba'],
      ['approve', 'dba2'],
      ['execute', 'dba2'],
      ['executed', 'dba2'],
    ]);
    expect(done.timeline[1]!.comment).toBe('可以');
  });

  test('没有设置“最后一个审批人即执行者”：全部通过后由有执行权限的人执行（申请人有执行权限时可以自己执行，没有时不行）', async () => {
    const pid = await newProject('noflag');
    const prod = await realEnv(pid, 'prod');
    const [v1, v2] = await publishChain(pid, 2);
    await setProjectPolicy(pid, {
      approval: [{ approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: false }],
    });
    // dev（编辑者，生产默认要项目管理员）提交，ga 通过；dev 不能执行，pa 可以
    const r1 = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect((await approve(pid, r1.id, 0, 'ga')).status).toBe(200);
    const d1 = await detail(pid, r1.id, 'dev');
    expect(d1).toMatchObject({ status: 'approved', actions: { execute: false } });
    // 有执行权限的人收到“待执行”
    expect((await inbox('pa')).items[0]).toMatchObject({ requestId: r1.id, data: { action: 'execute' } });
    expect((await executeReq(pid, r1.id, 'dev')).status).toBe(403);
    const run1 = await executeReq(pid, r1.id, 'pa');
    expect(last(run1.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
    // pa（项目管理员，有执行权限）自己提交，ga 通过后 pa 自己执行
    const r2 = (await submit(pid, prod.eid, v2!.id, 'pa')).data as unknown as ExecRequestDetail;
    expect((await approve(pid, r2.id, 0, 'pa')).status).toBe(403);
    expect((await approve(pid, r2.id, 0, 'ga')).status).toBe(200);
    expect((await detail(pid, r2.id, 'pa')).actions.execute).toBe(true);
    const run2 = await executeReq(pid, r2.id, 'pa');
    expect(last(run2.events)).toMatchObject({ stage: 'done', current: { number: 2 } });
  });

  test('驳回即结束；撤回只能申请人；终态之后的操作 409', async () => {
    const pid = await newProject('reject');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [
        { approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: false },
        { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: true },
      ],
    });
    const r1 = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    // 驳回必须写意见
    expect(
      (await call('POST', `/api/projects/${pid}/requests/${r1.id}/reject`, { stage: 0, comment: '' }, 'ga'))
        .status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          `/api/projects/${pid}/requests/${r1.id}/reject`,
          { stage: 0, comment: '先在测试库验证' },
          'ga',
        )
      ).status,
    ).toBe(200);
    const d1 = await detail(pid, r1.id, 'dev');
    expect(d1).toMatchObject({ status: 'rejected', statusReason: '先在测试库验证' });
    expect(d1.stages[0]!.approvals[0]).toMatchObject({
      decision: 'reject',
      comment: '先在测试库验证',
      userName: 'ga',
    });
    expect((await inbox('dev')).items[0]).toMatchObject({
      kind: 'request_result',
      data: { status: 'rejected' },
    });
    expect((await approve(pid, r1.id, 0, 'ga')).status).toBe(409);
    // 撤回
    const r2 = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect((await call('POST', `/api/projects/${pid}/requests/${r2.id}/withdraw`, {}, 'pa')).status).toBe(
      403,
    );
    expect((await call('POST', `/api/projects/${pid}/requests/${r2.id}/withdraw`, {}, 'dev')).status).toBe(
      200,
    );
    expect((await detail(pid, r2.id)).status).toBe('withdrawn');
    expect((await call('POST', `/api/projects/${pid}/requests/${r2.id}/withdraw`, {}, 'dev')).status).toBe(
      409,
    );
    // 审计：每一步都有
    const actions = (
      await db.query<{ action: string }>(
        "select action from audit_events where target_kind = 'exec_request' and project_id = $1 order by at",
        [pid],
      )
    ).map((a) => a.action);
    expect(actions).toEqual([
      'exec_request.create',
      'exec_request.reject',
      'exec_request.create',
      'exec_request.withdraw',
    ]);
  });

  test('过期：默认 24 小时、可以在执行策略里设得更短；过期后审批 409，定时检查转成“已过期”并通知申请人', async () => {
    const pid = await newProject('expire');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, { requestTtlHours: 2 });
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect(Math.round((new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime()) / 3600_000)).toBe(
      2,
    );
    // 时间到了（直接改到期时间）
    await db.query("update exec_requests set expires_at = '2000-01-01T00:00:00.000Z' where id = $1", [r.id]);
    const a = await approveAndExecute(pid, r.id, 0, 'pa');
    expect(a.status).toBe(409);
    expect(a.data.code).toBe('request_expired');
    expect((await detail(pid, r.id)).status).toBe('expired');
    // 另一个申请：由定时检查发现过期
    const r2 = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    await db.query("update exec_requests set expires_at = '2000-01-01T00:00:00.000Z' where id = $1", [r2.id]);
    expect(await created.requests.sweep()).toBeGreaterThanOrEqual(1);
    const row = (
      await db.query<{ status: string }>('select status from exec_requests where id = $1', [r2.id])
    )[0]!;
    expect(row.status).toBe('expired');
    expect((await inbox('dev')).items[0]).toMatchObject({ requestId: r2.id, data: { status: 'expired' } });
  });

  test('环境状态变化即失效：别人直接执行、漂移、链上相关版本的脚本被改', async () => {
    const pid = await newProject('stale');
    const prod = await realEnv(pid, 'prod');
    const [v1, v2] = await publishChain(pid, 2);
    // ① 申请执行到 v2（v1、v2 两个迁移），pa 直接执行到 v1：起点变了 → 失效
    const r1 = (await submit(pid, prod.eid, v2!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect(r1.migrations.map((m) => m.number)).toEqual([1, 2]);
    const direct = await call(
      'POST',
      `/api/projects/${pid}/environments/${prod.eid}/execute`,
      { to: v1!.id, confirm: 'prod' },
      'pa',
    );
    expect(last(direct.events)).toMatchObject({ stage: 'done' });
    await created.requests.sweep();
    const d1 = await detail(pid, r1.id, 'dev');
    expect(d1.status).toBe('invalid');
    expect(d1.statusReason).toContain('当前版本变了');
    expect((await inbox('dev')).items[0]).toMatchObject({ requestId: r1.id, data: { status: 'invalid' } });
    expect((await approveAndExecute(pid, r1.id, 0, 'pa')).status).toBe(409);

    // ② 漂移：申请之后有人手工改了库，漂移检查发现 → 失效
    const r2 = (await submit(pid, prod.eid, v2!.id, 'dev')).data as unknown as ExecRequestDetail;
    await prod.target.db.exec('alter table public.orders add column hack text');
    const dc = await call('POST', `/api/projects/${pid}/environments/${prod.eid}/drift-check`, {}, 'pa');
    expect(dc.data.status).toBe('drifted');
    const a2 = await approveAndExecute(pid, r2.id, 0, 'pa');
    expect(a2.status).toBe(409);
    expect((await detail(pid, r2.id)).statusReason).toContain('漂移');
    // 漂移时连申请都提交不了（预演不通过）
    const s2 = await submit(pid, prod.eid, v2!.id, 'dev');
    expect(s2.status).toBe(422);
    await prod.target.db.exec('alter table public.orders drop column hack');
    expect(
      (await call('POST', `/api/projects/${pid}/environments/${prod.eid}/drift-check`, {}, 'pa')).data.status,
    ).toBe('ok');

    // ③ 链变化：申请之后 v2 的脚本被修改（还没在任何环境执行过，可以改）→ 失效
    const r3 = (await submit(pid, prod.eid, v2!.id, 'dev')).data as unknown as ExecRequestDetail;
    const v2d = (await call('GET', `/api/projects/${pid}/versions/${v2!.id}`)).data as unknown as {
      upSteps: { sql: string; transactional: boolean }[];
      downSteps: { sql: string; transactional: boolean }[];
    };
    const edit = await call('PATCH', `/api/projects/${pid}/versions/${v2!.id}/steps`, {
      up: [...v2d.upSteps, { sql: 'SELECT 1', transactional: true }],
      down: v2d.downSteps,
    });
    expect(edit.status, JSON.stringify(edit.data)).toBe(200);
    await created.requests.sweep();
    const d3 = await detail(pid, r3.id);
    expect(d3.status).toBe('invalid');
    expect(d3.statusReason).toContain('v2 的脚本');
  });

  test('紧急执行：只有实例管理员、必填原因；绕过审批但不绕过前置环境；通知审批人、审计', async () => {
    const pid = await newProject('emergency');
    const dev = await realEnv(pid, 'dev', false);
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [{ approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: true }],
    });
    // 前置环境：dev
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${prod.eid}/exec-policy`,
          { settings: {}, prerequisiteId: dev.eid },
          'pa',
        )
      ).status,
    ).toBe(200);
    const path = `/api/projects/${pid}/environments/${prod.eid}/emergency`;
    expect(
      (await call('POST', path, { kind: 'execute', to: v1!.id, reason: '线上故障', confirm: 'prod' }, 'pa'))
        .status,
    ).toBe(403);
    expect(
      (await call('POST', path, { kind: 'execute', to: v1!.id, reason: '', confirm: 'prod' }, 'admin'))
        .status,
    ).toBe(400);
    // 前置环境不满足：紧急执行也拒绝（不绕过）
    const blocked = await call(
      'POST',
      path,
      { kind: 'execute', to: v1!.id, reason: '线上故障', confirm: 'prod' },
      'admin',
    );
    expect(blocked.status).toBe(422);
    expect(blocked.data.code).toBe('prerequisite_behind');
    expect(
      last(
        (await call('POST', `/api/projects/${pid}/environments/${dev.eid}/execute`, { to: v1!.id }, 'dev'))
          .events,
      ),
    ).toMatchObject({ stage: 'done' });
    // 生产要环境名
    expect(
      (await call('POST', path, { kind: 'execute', to: v1!.id, reason: '线上故障' }, 'admin')).status,
    ).toBe(422);
    const run = await call(
      'POST',
      path,
      { kind: 'execute', to: v1!.id, reason: '线上故障，紧急加表', confirm: 'prod' },
      'admin',
    );
    expect(last(run.events), JSON.stringify(last(run.events))).toMatchObject({
      stage: 'done',
      current: { number: 1 },
    });
    // 审批人（ga）收到紧急执行通知
    expect((await inbox('ga')).items[0]).toMatchObject({
      kind: 'emergency_execution',
      data: { body: expect.stringContaining('线上故障，紧急加表') },
    });
    const list = (await call('GET', `/api/projects/${pid}/requests`)).data as unknown as ExecRequestSummary[];
    expect(list[0]).toMatchObject({ emergency: true, status: 'executed', reason: '线上故障，紧急加表' });
    const [audit] = await db.query<{ data: Record<string, unknown> }>(
      "select data from audit_events where action = 'environment.emergency' and project_id = $1",
      [pid],
    );
    expect(audit!.data).toMatchObject({ reason: '线上故障，紧急加表', name: 'prod' });
  });

  test('前置环境拒绝：前置环境还没到目标版本时提交申请被拒（预演不通过）', async () => {
    const pid = await newProject('prereq');
    const dev = await realEnv(pid, 'dev', false);
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    expect(
      (
        await call(
          'PUT',
          `/api/projects/${pid}/environments/${prod.eid}/exec-policy`,
          { settings: {}, prerequisiteId: dev.eid },
          'pa',
        )
      ).status,
    ).toBe(200);
    const s = await submit(pid, prod.eid, v1!.id, 'dev');
    expect(s.status).toBe(422);
    expect(s.data.code).toBe('prerequisite_behind');
    // 申请提交之后前置环境回滚了：执行时再次检查，422，申请保持原状态
    expect(
      last(
        (await call('POST', `/api/projects/${pid}/environments/${dev.eid}/execute`, { to: v1!.id }, 'dev'))
          .events,
      ),
    ).toMatchObject({ stage: 'done' });
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    await db.query('update environments set current_version_id = null where id = $1', [dev.eid]);
    const a = await approveAndExecute(pid, r.id, 0, 'pa');
    expect(a.status).toBe(422);
    expect((await detail(pid, r.id)).status).toBe('pending');
  });

  test('同一个人可以批多个环节，但每个环节单独确认', async () => {
    const pid = await newProject('samep');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [
        { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: false },
        { approvers: { kind: 'project_admins' }, count: 1, lastApproverExecutes: true },
      ],
    });
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    // 一次只能推进一个环节：批第 0 个环节后，旧的环节号再批 409
    expect((await approve(pid, r.id, 0, 'pa')).status).toBe(200);
    expect((await approve(pid, r.id, 0, 'pa')).status).toBe(409);
    expect((await detail(pid, r.id)).stage).toBe(1);
    // 第二个环节同一个人再确认一次（通过并执行）
    const run = await approveAndExecute(pid, r.id, 1, 'pa');
    expect(last(run.events)).toMatchObject({ stage: 'done' });
    const d = await detail(pid, r.id);
    expect(d.stages.map((s) => s.approvals.map((a) => a.userName))).toEqual([['pa'], ['pa']]);
  });

  test('审批人资格按审批时的成员关系：提交后被移出 DBA 组的人不能再批', async () => {
    const pid = await newProject('revoke');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    // dba2 要能看到项目（查看者授权），审批人范围是 DBA 组成员
    await call('POST', `/api/projects/${pid}/grants`, {
      subjectKind: 'user',
      subjectId: ids.dba2,
      role: 'viewer',
    });
    await call('POST', `/api/projects/${pid}/grants`, {
      subjectKind: 'user',
      subjectId: ids.outsider,
      role: 'viewer',
    });
    await setProjectPolicy(pid, {
      approval: [
        { approvers: { kind: 'group_members', groupId: dbaGroupId }, count: 1, lastApproverExecutes: false },
      ],
    });
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    expect((await detail(pid, r.id, 'dba2')).actions.approve).toBe(true);
    // 看不到项目的 DBA（dba 没有授权）不算审批人：既不通知也不能批
    // （建 DBA 组的实例管理员也是成员、能看到项目：一共 2 人）
    expect((await detail(pid, r.id)).stages[0]!.eligible).toBe(2);
    // 把 dba2 移出 DBA 组
    const del = await call('DELETE', `/api/groups/dba/members/${ids.dba2}`, undefined, 'admin');
    expect(del.status).toBe(200);
    expect((await approve(pid, r.id, 0, 'dba2')).status).toBe(403);
    // 加回来后可以批；outsider 不在组里，403
    await call('POST', '/api/groups/dba/members', { username: 'dba2', role: 'member' }, 'admin');
    expect((await approve(pid, r.id, 0, 'outsider')).status).toBe(403);
    expect((await approve(pid, r.id, 0, 'dba2')).status).toBe(200);
  });

  test('策略在审批中途变化：变严（加环节）→ 失效；变宽（去掉环节）→ 按提交时的快照继续', async () => {
    const pid = await newProject('midway');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const ga = { approvers: { kind: 'group_admins' as const }, count: 1, lastApproverExecutes: false };
    const pa = { approvers: { kind: 'project_admins' as const }, count: 1, lastApproverExecutes: true };
    await setProjectPolicy(pid, { approval: [ga, pa] });
    const r1 = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    // 变宽：去掉第一个环节。申请仍按快照（两个环节）走：pa 不能跳过 ga 的环节
    await setProjectPolicy(pid, { approval: [pa] });
    expect((await approve(pid, r1.id, 1, 'pa')).status).toBe(409);
    expect((await approve(pid, r1.id, 0, 'ga')).status).toBe(200);
    expect((await detail(pid, r1.id)).status).toBe('pending');
    // 变严：在上级（组层）加一个环节 → 当前流程 [组层环节, pa] 不被快照 [ga, pa] 包含 → 失效
    const g = await call(
      'PUT',
      '/api/groups/req/exec-policy',
      {
        production: {
          approval: [{ approvers: { kind: 'executors' }, count: 1, lastApproverExecutes: false }],
        },
        nonProduction: {},
      },
      'ga',
    );
    expect(g.status, JSON.stringify(g.data)).toBe(200);
    const a = await approveAndExecute(pid, r1.id, 1, 'pa');
    expect(a.status).toBe(409);
    expect(a.data.code).toBe('request_invalid');
    expect((await detail(pid, r1.id)).statusReason).toContain('审批流程变严');
    await call('PUT', '/api/groups/req/exec-policy', { production: {}, nonProduction: {} }, 'ga');
  });
});

// ───── 第一轮审查的修复 ─────

describe.skipIf(!PG_URL)('第一轮审查的修复（目标库 PG）', () => {
  /** 让下一次执行在拿环境锁时失败（模拟执行开始之后、碰目标库之前的意外错误） */
  const failNextRun = () => {
    const locks = created.exec.locks;
    const orig = locks.acquire.bind(locks);
    locks.acquire = async () => {
      locks.acquire = orig;
      throw new Error('模拟：执行没能开始');
    };
  };
  const statusOf = async (rid: string) =>
    (
      await db.query<{ status: string; result: { code: string | null } | null }>(
        'select status, result from exec_requests where id = $1',
        [rid],
      )
    )[0]!;

  test('紧急执行失败后不能经普通路径重试或撤回；成功、失败的结果都通知审批人', async () => {
    const pid = await newProject('em-retry');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [{ approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: true }],
    });
    const path = `/api/projects/${pid}/environments/${prod.eid}/emergency`;
    failNextRun();
    const run = await call('POST', path, { kind: 'execute', to: v1!.id, reason: '演练', confirm: 'prod' });
    // 意外错误对外只说“服务器内部错误”（code = internal）
    expect(last(run.events)).toMatchObject({ code: 'internal' });
    const list = (await call('GET', `/api/projects/${pid}/requests`)).data as unknown as ExecRequestSummary[];
    const em = list.find((r) => r.emergency)!;
    expect(em.status).toBe('failed');
    // 有执行权的项目管理员、实例管理员都不能经 /execute 重试（那等于绕过全部审批），也不能撤回
    for (const who of ['pa', 'admin'] as const) {
      const retry = await executeReq(pid, em.id, who);
      expect(retry.status, who).toBe(409);
      expect(retry.data.error).toContain('紧急执行');
    }
    expect((await call('POST', `/api/projects/${pid}/requests/${em.id}/withdraw`, {})).status).toBe(409);
    const d = await detail(pid, em.id, 'pa');
    expect(d.actions).toMatchObject({ execute: false, approve: false, withdraw: false });
    expect(d.actions.note).toContain('紧急执行');
    expect((await statusOf(em.id)).status).toBe('failed');
    // 审批人（组管理员）收到开始和失败两条
    const failed = (await inbox('ga')).items.filter((i) => i.requestId === em.id);
    expect(failed.map((i) => i.data.event).sort()).toEqual(['emergency', 'emergency_failed']);
    // 重新发起紧急执行（新记录）成功，审批人收到“紧急执行完成”
    const ok = await call('POST', path, { kind: 'execute', to: v1!.id, reason: '再来一次', confirm: 'prod' });
    expect(last(ok.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
    const done = (await inbox('ga')).items.find((i) => i.data.event === 'emergency_executed')!;
    expect(done.requestId).not.toBe(em.id);
    expect(done.data.body).toContain('再来一次');
  });

  test('转成“执行中”之后执行没能开始：申请转成执行失败，不会停在执行中；之后可以重试', async () => {
    const pid = await newProject('stuck');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    failNextRun();
    const run = await approveAndExecute(pid, r.id, 0, 'pa');
    expect(run.status).toBe(200);
    // 意外错误对外只说“服务器内部错误”（code = internal）
    expect(last(run.events)).toMatchObject({ code: 'internal' });
    expect((await statusOf(r.id)).status).toBe('failed');
    // 绑定仍然成立：有执行权的人可以重试
    const retry = await executeReq(pid, r.id, 'pa');
    expect(last(retry.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
    expect((await statusOf(r.id)).status).toBe('executed');
  });

  test('启动恢复只处理本进程启动前就在执行中的申请（条件更新）；被误记为中断的，真实结果仍能写回', async () => {
    const pid = await newProject('recover');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const old = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    const fresh = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    // old：重启前就在执行中；fresh：本进程里刚开始执行
    await db.query("update exec_requests set status = 'executing', updated_at = $2 where id = $1", [
      old.id,
      '2000-01-01T00:00:00.000Z',
    ]);
    await db.query("update exec_requests set status = 'executing', updated_at = $2 where id = $1", [
      fresh.id,
      new Date().toISOString(),
    ]);
    expect(await created.requests.recoverInterrupted()).toBe(1);
    expect(await statusOf(old.id)).toMatchObject({ status: 'failed', result: { code: 'interrupted' } });
    expect((await statusOf(fresh.id)).status).toBe('executing');
    // 被记为中断的那个，真实结果送到时仍然写回
    const me = { id: ids.pa!, name: 'pa' };
    await created.requests.finish(null, old.id, me, {
      ok: true,
      current: { id: v1!.id, number: 1, name: 'v1' },
      error: null,
    });
    expect((await statusOf(old.id)).status).toBe('executed');
    // 不是 executing / 中断的申请不会被 finish 改动
    await created.requests.finish(null, old.id, me, { ok: false, current: null, error: { error: 'x' } });
    expect((await statusOf(old.id)).status).toBe('executed');
    await created.requests.finish(null, fresh.id, me, { ok: false, current: null, error: { error: 'x' } });
    expect((await statusOf(fresh.id)).status).toBe('failed');
  });

  test('连接串指纹是带密钥的 HMAC，不是连接串的普通哈希', async () => {
    const pid = await newProject('hmac');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    const [row] = await db.query<{ conn_hash: string }>('select conn_hash from exec_requests where id = $1', [
      r.id,
    ]);
    const { createHash, createHmac } = await import('node:crypto');
    expect(row!.conn_hash).not.toBe(createHash('sha256').update(prod.target.url).digest('hex'));
    const key = createHmac('sha256', createHash('sha256').update(process.env.DOWEL_SECRET!).digest())
      .update('dowel:exec-request.conn')
      .digest();
    expect(row!.conn_hash).toBe(createHmac('sha256', key).update(prod.target.url).digest('hex'));
  });

  test('未读数和全部已读只看现在看得到的项目：被移出组后不含那个项目的通知，重新加入后仍是未读', async () => {
    const pid = await newProject('visible');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    // DBA 组整体是这个项目的查看者；审批人是 DBA 组成员
    expect(
      (
        await call('POST', `/api/projects/${pid}/grants`, {
          subjectKind: 'group',
          subjectId: dbaGroupId,
          role: 'viewer',
        })
      ).status,
    ).toBe(201);
    await setProjectPolicy(pid, {
      approval: [
        { approvers: { kind: 'group_members', groupId: dbaGroupId }, count: 1, lastApproverExecutes: false },
      ],
    });
    await call('POST', '/api/me/inbox/read-all', {}, 'dba');
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    const box = await inbox('dba');
    expect(box.unread).toBe(1);
    expect(box.items[0]!.requestId).toBe(r.id);
    // 移出 DBA 组：看不到项目了，未读数和列表都不含它
    expect((await call('DELETE', `/api/groups/dba/members/${ids.dba}`, undefined, 'admin')).status).toBe(200);
    const hidden = await inbox('dba');
    expect(hidden.unread).toBe(0);
    expect(hidden.items.some((i) => i.requestId === r.id)).toBe(false);
    const stream = await created.app.request('/api/me/inbox/stream?once=1', {
      headers: { cookie: cookies.dba! },
    });
    expect(await stream.text()).toContain('"unread":0');
    // 这时“全部已读”不碰看不到的通知；重新加入后它仍是未读
    expect((await call('POST', '/api/me/inbox/read-all', {}, 'dba')).data).toMatchObject({ unread: 0 });
    expect(
      (await call('POST', '/api/groups/dba/members', { username: 'dba', role: 'member' }, 'admin')).status,
    ).toBe(200);
    expect((await inbox('dba')).unread).toBe(1);
  });

  test('重检按范围进行：只检查受影响的环境；同时到达的两次重检都会处理', async () => {
    const pid = await newProject('scoped');
    const a = await realEnv(pid, 'a');
    const b = await realEnv(pid, 'b');
    const [v1] = await publishChain(pid, 1);
    const ra = (await submit(pid, a.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    const rb = (await submit(pid, b.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    await db.query("update exec_requests set expires_at = '2000-01-01T00:00:00.000Z' where id in ($1, $2)", [
      ra.id,
      rb.id,
    ]);
    // 只检查 b 所在的另一个范围：a 不动
    expect(await created.requests.sweep({ envIds: ['no-such-env'] })).toBe(0);
    expect((await statusOf(ra.id)).status).toBe('pending');
    const [na, nb] = await Promise.all([
      created.requests.sweep({ envIds: [a.eid] }),
      created.requests.sweep({ envIds: [b.eid] }),
    ]);
    expect(na + nb).toBeGreaterThanOrEqual(1);
    expect((await statusOf(ra.id)).status).toBe('expired');
    expect((await statusOf(rb.id)).status).toBe('expired');
  });

  test('第二轮：失败的紧急执行记录是终态——之后的重检不改它、审批人不收到额外通知、Webhook 不重复', async () => {
    const pid = await newProject('em-terminal');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [{ approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: true }],
    });
    // 记下这个项目发出的 Webhook 事件
    const hooks: { type: string; requestId: unknown }[] = [];
    const emit = created.webhooks.emit.bind(created.webhooks);
    created.webhooks.emit = (groupId, event) => {
      hooks.push({ type: event.type, requestId: event.data.requestId });
      emit(groupId, event);
    };
    try {
      const path = `/api/projects/${pid}/environments/${prod.eid}/emergency`;
      failNextRun();
      await call('POST', path, { kind: 'execute', to: v1!.id, reason: '第一次', confirm: 'prod' });
      const a = (
        (await call('GET', `/api/projects/${pid}/requests`)).data as unknown as ExecRequestSummary[]
      ).find((r) => r.emergency)!;
      expect(a.status).toBe('failed');
      const ok = await call('POST', path, { kind: 'execute', to: v1!.id, reason: '第二次', confirm: 'prod' });
      expect(last(ok.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
      // 环境当前版本变了：A 的绑定已经不成立，但它是终态，全量重检和按环境重检都不能再动它
      await created.requests.sweep();
      await created.requests.sweep({ envIds: [prod.eid] });
      await created.requests.recheck(a.id);
      expect((await statusOf(a.id)).status).toBe('failed');
      // 审批人对 A 只收到开始和失败两条
      const forA = (await inbox('ga')).items.filter((i) => i.requestId === a.id).map((i) => i.data.event);
      expect(forA.sort()).toEqual(['emergency', 'emergency_failed']);
      // A 的 Webhook 只有失败那一次
      expect(hooks.filter((h) => h.requestId === a.id).map((h) => h.type)).toEqual(['emergency.executed']);
    } finally {
      created.webhooks.emit = emit;
    }
  });

  test('第二轮：执行成功后写审计失败，申请仍记为已执行（结果以执行器为准，结束处理恰好一次）', async () => {
    const pid = await newProject('audit-fail');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
    // 让执行结束后那条 environment.execute 审计写不进去（execStream 里锁外的那一次写入）
    const query = db.query.bind(db);
    let failed = 0;
    db.query = (async (q: string, params?: unknown[]) => {
      if (
        q.includes('insert into audit_events') &&
        JSON.stringify(params ?? []).includes('"environment.execute"')
      ) {
        failed++;
        throw new Error('模拟：审计表写不进去');
      }
      return query(q, params);
    }) as typeof db.query;
    try {
      const run = await approveAndExecute(pid, r.id, 0, 'pa');
      expect(last(run.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
    } finally {
      db.query = query;
    }
    expect(failed).toBe(1);
    expect((await statusOf(r.id)).status).toBe('executed');
    // 结束处理只做了一次：时间线里只有一条“执行成功”，申请人只收到一条结果
    const d = await detail(pid, r.id);
    expect(d.timeline.filter((t) => t.kind === 'executed')).toHaveLength(1);
    expect(
      (await inbox('dev')).items.filter((i) => i.requestId === r.id && i.kind === 'request_result'),
    ).toHaveLength(1);
  });
});
