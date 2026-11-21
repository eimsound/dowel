// 执行申请与审批（P5b）的场景测试：平台库 SQLite，目标库 / 影子库用测试 PG（没有 Docker 时跳过）。
// 表驱动的场景：默认单环节、多环节（含人数 > 1）、驳回、撤回、过期、环境状态变化失效（直接执行、漂移、链变化）、紧急执行、
// “最后一个审批人即执行者”、同人多环节逐个确认、审批人资格被撤销、策略中途变化。
// 并发场景（平台库 PG）在 requests-concurrency.test.ts。
import type {
  DryRunResponse,
  ExecEvent,
  ExecRequestDetail,
  ExecRequestSummary,
  InboxEvent,
  InboxList,
  PendingRequest,
  PolicySettings,
} from '@dowel/api';
import { addColumn, all, emptyModel, type Model } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import type { EnvRow } from '../src/envs.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { withPolicyLock } from '../src/policy.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { connHash, Effects, type RequestRow } from '../src/requests.ts';
import { encrypt } from '../src/secrets.ts';
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

  test('紧急执行：只有实例管理员、必填原因；绕过审批、通知审批人、审计', async () => {
    const pid = await newProject('emergency');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    await setProjectPolicy(pid, {
      approval: [{ approvers: { kind: 'group_admins' }, count: 1, lastApproverExecutes: true }],
    });
    const path = `/api/projects/${pid}/environments/${prod.eid}/emergency`;
    expect(
      (await call('POST', path, { kind: 'execute', to: v1!.id, reason: '线上故障', confirm: 'prod' }, 'pa'))
        .status,
    ).toBe(403);
    expect(
      (await call('POST', path, { kind: 'execute', to: v1!.id, reason: '', confirm: 'prod' }, 'admin'))
        .status,
    ).toBe(400);
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
    const enqueueIn = created.webhooks.enqueueIn.bind(created.webhooks);
    created.webhooks.enqueueIn = async (tx, groupId, event) => {
      hooks.push({ type: event.type, requestId: event.data.requestId });
      return enqueueIn(tx, groupId, event);
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
      created.webhooks.enqueueIn = enqueueIn;
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

// ───── 中断申请巡检保护与重试限制（#18） ─────

describe.skipIf(!PG_URL)('中断申请巡检保护与重试限制（#18）', () => {
  const rowOf = async (rid: string) =>
    (
      await db.query<{
        status: string;
        status_reason: string | null;
        result: { ok: boolean; code: string | null; current: { number: number } | null } | null;
      }>('select status, status_reason, result from exec_requests where id = $1', [rid])
    )[0]!;

  test('多步迁移中途节点离线（环境当前版本已推进）后全量 sweep / recheck 保持 failed+interrupted，不发重复通知/Webhook，禁止误重试，且 finish() 兜底仍生效', async () => {
    const pid = await newProject('interrupted-env-changed');
    const prod = await realEnv(pid, 'prod');
    const [v1, v2] = await publishChain(pid, 2);

    const hooks: { type: string; requestId: unknown; status: unknown }[] = [];
    const enqueueIn = created.webhooks.enqueueIn.bind(created.webhooks);
    created.webhooks.enqueueIn = async (tx, gid, event) => {
      hooks.push({ type: event.type, requestId: event.data.requestId, status: event.data.status });
      return enqueueIn(tx, gid, event);
    };

    try {
      const r = (await submit(pid, prod.eid, v2!.id, 'dev')).data as unknown as ExecRequestDetail;
      expect(r.migrations.map((m) => m.number)).toEqual([1, 2]);
      // 模拟：申请在重启前正在执行中，且第一步已完成推进了 environments.current_version_id = v1
      await db.query('update environments set current_version_id = $2 where id = $1', [prod.eid, v1!.id]);
      await db.query("update exec_requests set status = 'executing', updated_at = $2 where id = $1", [
        r.id,
        '2000-01-01T00:00:00.000Z',
      ]);

      // 全量巡检（runSweep({ all: true })）：先 recoverInterrupted 置为 failed/interrupted，紧接着的绑定巡检绝不能二次改写为 invalid
      expect(await created.requests.sweep()).toBe(1);
      expect(await rowOf(r.id)).toMatchObject({
        status: 'failed',
        status_reason: expect.stringContaining('结果未知'),
        result: { ok: false, code: 'interrupted' },
      });

      // 再次全量巡检、按环境巡检、详情页 recheck 与详情接口均保持 failed/interrupted
      expect(await created.requests.sweep()).toBe(0);
      expect(await created.requests.sweep({ envIds: [prod.eid] })).toBe(0);
      await created.requests.recheck(r.id);
      const d = await detail(pid, r.id, 'pa');
      expect(d.status).toBe('failed');
      expect(d.result).toMatchObject({ ok: false, code: 'interrupted' });

      // 仅 1 条执行失败通知与 1 条 request.executed Webhook（无 request.invalidated）
      const notices = (await inbox('dev')).items.filter(
        (i) => i.requestId === r.id && i.kind === 'request_result',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.data).toMatchObject({ event: 'failed', status: 'failed' });
      expect(hooks.filter((h) => h.requestId === r.id).map((h) => h.type)).toEqual([
        'request.created',
        'request.executed',
      ]);

      // 环境已变化的 interrupted 申请不可直接重试或撤回（actionsFor 与重试/撤回接口均拒绝，且不改写状态）
      expect(d.actions).toMatchObject({
        approve: false,
        reject: false,
        approveAndExecute: false,
        execute: false,
        withdraw: false,
        note: expect.stringContaining('不能直接重试'),
      });
      expect((await detail(pid, r.id, 'dev')).actions).toMatchObject({
        execute: false,
        withdraw: false,
      });
      const retry = await executeReq(pid, r.id, 'pa');
      expect(retry.status).toBe(409);
      expect(retry.data.error).toContain('不能直接重试');
      const withdraw = await call('POST', `/api/projects/${pid}/requests/${r.id}/withdraw`, {}, 'dev');
      expect(withdraw.status).toBe(409);
      expect(await rowOf(r.id)).toMatchObject({
        status: 'failed',
        result: { ok: false, code: 'interrupted' },
      });

      // 原副本只是心跳短暂超时恢复后调用 finish()：仍能成功覆盖回写为 executed 终态
      await created.requests.finish(
        null,
        r.id,
        { id: ids.pa!, name: 'pa' },
        { ok: true, current: { id: v2!.id, number: 2, name: 'v2' }, error: null },
      );
      expect(await rowOf(r.id)).toMatchObject({
        status: 'executed',
        status_reason: null,
        result: { ok: true, current: { number: 2 } },
      });
    } finally {
      created.webhooks.enqueueIn = enqueueIn;
    }
  });

  test('执行期间跨过 expires_at 后离线：sweep 与详情页 recheck 保持 failed+interrupted，不被改为 expired，且 finish() 仍可覆盖', async () => {
    const pid = await newProject('interrupted-expired');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);

    const hooks: { type: string; requestId: unknown }[] = [];
    const enqueueIn = created.webhooks.enqueueIn.bind(created.webhooks);
    created.webhooks.enqueueIn = async (tx, gid, event) => {
      hooks.push({ type: event.type, requestId: event.data.requestId });
      return enqueueIn(tx, gid, event);
    };

    try {
      const r = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
      // 同时满足：执行期间已跨过 expires_at，且原执行节点已离线/重启
      await db.query(
        "update exec_requests set status = 'executing', expires_at = $2, updated_at = $2 where id = $1",
        [r.id, '2000-01-01T00:00:00.000Z'],
      );

      expect(await created.requests.sweep()).toBe(1);
      expect(await rowOf(r.id)).toMatchObject({
        status: 'failed',
        result: { ok: false, code: 'interrupted' },
      });

      // 详情页 recheck 与再次 sweep 均不改写为 expired
      await created.requests.recheck(r.id);
      const d = await detail(pid, r.id, 'pa');
      expect(d.status).toBe('failed');
      expect(d.result).toMatchObject({ ok: false, code: 'interrupted' });
      expect(d.actions.execute).toBe(false);

      const notices = (await inbox('dev')).items.filter(
        (i) => i.requestId === r.id && i.kind === 'request_result',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]!.data).toMatchObject({ event: 'failed', status: 'failed' });
      expect(hooks.filter((h) => h.requestId === r.id).map((h) => h.type)).toEqual([
        'request.created',
        'request.executed',
      ]);

      // 重试接口拒绝且不把状态改成 expired
      expect((await executeReq(pid, r.id, 'pa')).status).toBe(409);
      expect(await rowOf(r.id)).toMatchObject({
        status: 'failed',
        result: { ok: false, code: 'interrupted' },
      });

      // 原节点恢复后 finish() 兜底回写仍生效
      await created.requests.finish(
        null,
        r.id,
        { id: ids.pa!, name: 'pa' },
        { ok: true, current: { id: v1!.id, number: 1, name: 'v1' }, error: null },
      );
      expect(await rowOf(r.id)).toMatchObject({
        status: 'executed',
        result: { ok: true, current: { number: 1 } },
      });

      // 对照：普通执行失败（非 interrupted）在环境变化后仍正常由 sweep 转为 invalid
      const rNormal = (await submit(pid, prod.eid, v1!.id, 'dev')).data as unknown as ExecRequestDetail;
      await db.query("update exec_requests set status = 'failed', result = $2 where id = $1", [
        rNormal.id,
        JSON.stringify({ ok: false, code: 'internal', error: '执行失败', current: null }),
      ]);
      await db.query('update environments set current_version_id = $2 where id = $1', [prod.eid, v1!.id]);
      expect(await created.requests.sweep()).toBe(1);
      expect((await rowOf(rNormal.id)).status).toBe('invalid');
    } finally {
      created.webhooks.enqueueIn = enqueueIn;
    }
  });

  test('创建执行申请返回瞬间 webhook_jobs 已同步持久化落库（不依赖异步 emit）', async () => {
    const pid = await newProject('wh-create-sync');
    const prod = await realEnv(pid, 'prod');
    const [v1] = await publishChain(pid, 1);
    const hookId = `wh-create-${Date.now()}`;
    await db.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ($1, $2, 'sync-create', 'json', $3, $4::text::jsonb, true)`,
      [hookId, groupId, encrypt('https://example.invalid/hook'), JSON.stringify(['request.created'])],
    );
    const wakeCalls: boolean[] = [];
    const emitCalls: unknown[] = [];
    const origWake = created.webhooks.wake.bind(created.webhooks);
    const origEmit = created.webhooks.emit.bind(created.webhooks);
    // 拦截 wake 阻止立即拉取消费，同时拦截 emit 断言全路径零调用
    created.webhooks.wake = (broadcast = true) => {
      wakeCalls.push(broadcast);
    };
    created.webhooks.emit = (gid, ev) => {
      emitCalls.push({ gid, ev });
      origEmit(gid, ev);
    };
    try {
      const res = await submit(pid, prod.eid, v1!.id, 'dev');
      expect(res.status).toBe(201);
      const rid = (res.data as unknown as ExecRequestDetail).id;
      const jobs = await db.query<{ event_type: string; payload: { data: { requestId?: string } } }>(
        'select event_type, payload from webhook_jobs where webhook_id = $1',
        [hookId],
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.event_type).toBe('request.created');
      expect(jobs[0]!.payload.data.requestId).toBe(rid);
      expect(wakeCalls).toEqual([true]);
      expect(emitCalls).toHaveLength(0);
    } finally {
      created.webhooks.wake = origWake;
      created.webhooks.emit = origEmit;
      await db.query('delete from webhooks where id = $1', [hookId]);
    }
  });
});

// ───── 收件箱 SSE 实时流（#26） ─────

describe('收件箱 SSE 实时流（#26）', () => {
  const createStreamEnv = async () => {
    const memDb = await openPlatformDb(':memory:');
    const appObj = createApp(memDb, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    const user = await makeUser(memDb, 'sse_user', { name: 'SSE 用户', role: 'admin' });
    const loginRes = await appObj.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sse_user', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
    const cleanup = async () => {
      appObj.requests.stop();
      await appObj.rooms.flush();
      await appObj.shadows.close();
      await memDb.close();
    };
    return { memDb, appObj, user, cookie, cleanup };
  };

  const openSseReader = (res: Response) => {
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const events: InboxEvent[] = [];

    const readNextChunk = async () => {
      const { done, value } = await reader.read();
      if (done) return true;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop()!;
      for (const part of parts) {
        const line = part
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('data:'));
        if (line) events.push(JSON.parse(line.replace(/^data:\s*/, '')) as InboxEvent);
      }
      return false;
    };

    const waitEvents = async (predicate: (list: InboxEvent[]) => boolean, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(events)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`等待 SSE 事件超时，当前已收到: ${JSON.stringify(events)}`);
        const done = await Promise.race([
          readNextChunk(),
          new Promise<never>((_, rej) =>
            setTimeout(
              () => rej(new Error(`等待 SSE 事件超时，当前已收到: ${JSON.stringify(events)}`)),
              left,
            ),
          ),
        ]);
        if (done) break;
      }
      return events;
    };

    const waitDone = async (timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('等待 SSE 流关闭超时');
        const done = await Promise.race([
          readNextChunk(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('等待 SSE 流关闭超时')), left)),
        ]);
        if (done) return;
      }
    };

    return { reader, events, waitEvents, waitDone };
  };

  test('建连瞬间初始 unread 查询返回前并发产生新通知时，SSE 流缓冲并推送最新未读数，不丢事件', async () => {
    const { memDb, appObj, user, cookie, cleanup } = await createStreamEnv();
    try {
      const origUnread = appObj.requests.unread.bind(appObj.requests);
      let intercepted = false;
      let enteredInitial!: () => void;
      const inInitial = new Promise<void>((r) => {
        enteredInitial = r;
      });
      let releaseInitial!: () => void;
      const holdInitial = new Promise<void>((r) => {
        releaseInitial = r;
      });

      appObj.requests.unread = async (queryDb, uid, rc) => {
        const count = await origUnread(queryDb, uid, rc);
        if (!intercepted && uid === user.id) {
          intercepted = true;
          enteredInitial();
          await holdInitial;
        }
        return count;
      };

      const res = await appObj.app.request('/api/me/inbox/stream', { headers: { cookie } });
      await inInitial;

      // 初始 unread 尚未返回/发送时并发写入新通知并推送未读数与申请变更
      await memDb.query(
        `insert into inbox_items (id, user_id, kind, data, created_at)
         values ('inbox-race-1', $1, 'approval_needed', '{}', $2)`,
        [user.id, new Date().toISOString()],
      );
      await appObj.requests.publishUnread(user.id);
      appObj.requests.broadcast({ requests: true });

      // 放行初始 unread（旧值 0），后续应立即消费缓冲队列里的 unread: 1 与 requests: true
      releaseInitial();
      const sse = openSseReader(res);
      await sse.waitEvents(
        (list) => list.some((e) => e.unread === 1) && list.some((e) => e.requests === true),
      );
      expect(sse.events).toEqual([{ unread: 0 }, { unread: 1 }, { requests: true }]);

      appObj.requests.stop();
      await sse.waitDone();
    } finally {
      await cleanup();
    }
  });

  test('活跃 SSE 连接在服务端调用 requests.stop() 后立刻优雅结束，心跳定时器 unref 并在关闭时清理，重启后可重新订阅', async () => {
    const { appObj, user, cookie, cleanup } = await createStreamEnv();
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let unrefCalled = false;
    let heartbeatCleared = false;
    let heartbeatScheduled!: () => void;
    const onHeartbeatScheduled = new Promise<void>((r) => {
      heartbeatScheduled = r;
    });

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const t = origSetTimeout(fn, ms, ...args);
      if (ms === 25_000 && !heartbeatTimer) {
        heartbeatTimer = t;
        const origUnref = t.unref?.bind(t);
        t.unref = () => {
          unrefCalled = true;
          return origUnref ? origUnref() : t;
        };
        heartbeatScheduled();
      }
      return t;
    }) as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: ReturnType<typeof setTimeout>) => {
      if (heartbeatTimer && id === heartbeatTimer) heartbeatCleared = true;
      return origClearTimeout(id);
    }) as typeof clearTimeout);

    try {
      const res = await appObj.app.request('/api/me/inbox/stream', { headers: { cookie } });
      const sse = openSseReader(res);
      await sse.waitEvents((list) => list.some((e) => e.unread === 0));
      await onHeartbeatScheduled;
      expect(unrefCalled).toBe(true);

      // 调用 stop() 后，活跃流应立刻结束并清理心跳定时器，而不是挂起等待 25s 心跳
      appObj.requests.stop();
      expect(appObj.requests.isStopped()).toBe(true);
      await sse.waitDone(1000);
      expect(heartbeatCleared).toBe(true);

      // 停机后新连上的流也应立即优雅结束
      const afterStopRes = await appObj.app.request('/api/me/inbox/stream', { headers: { cookie } });
      const afterStopSse = openSseReader(afterStopRes);
      await afterStopSse.waitDone(1000);

      // 重新 start() 后复位 stopped 状态，新建立的流可正常接收推送
      await appObj.requests.start(0);
      expect(appObj.requests.isStopped()).toBe(false);
      const restartedRes = await appObj.app.request('/api/me/inbox/stream', { headers: { cookie } });
      const restartedSse = openSseReader(restartedRes);
      await restartedSse.waitEvents((list) => list.some((e) => e.unread === 0));
      await appObj.requests.publishUnread(user.id, 3);
      await restartedSse.waitEvents((list) => list.some((e) => e.unread === 3));
      expect(restartedSse.events).toEqual([{ unread: 0 }, { unread: 3 }]);

      appObj.requests.stop();
      await restartedSse.waitDone(1000);
    } finally {
      vi.restoreAllMocks();
      await cleanup();
    }
  });
});

// ───── Webhook 事务内持久化入队（#20） ─────

describe('Webhook 事务内持久化入队（#20）', () => {
  const setupTxEnv = async () => {
    const memDb = await openPlatformDb(':memory:');
    const appObj = createApp(memDb, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
      // 调长 pollIntervalMs，配合拦截 wake 精确验证业务返回瞬间的 webhook_jobs 持久化状态
      webhooks: { pollIntervalMs: 60_000, retryBaseMs: 60_000 },
    });
    const admin = await makeUser(memDb, 'wh_admin', { name: '管理员', role: 'admin' });
    const dev = await makeUser(memDb, 'wh_dev', { name: '开发者' });
    const login = async (username: string) => {
      const r = await appObj.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD }),
      });
      expect(r.status).toBe(200);
      return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    };
    const adminCookie = await login('wh_admin');
    const devCookie = await login('wh_dev');

    await memDb.query("insert into groups (id, slug, name) values ('g-wh-tx', 'g-wh-tx', '事务钩子组')");
    await memDb.query("insert into group_members (group_id, user_id, role) values ('g-wh-tx', $1, 'admin')", [
      admin.id,
    ]);
    await memDb.query(
      "insert into group_members (group_id, user_id, role) values ('g-wh-tx', $1, 'member')",
      [dev.id],
    );
    await memDb.query(
      "insert into projects (id, name, group_id, slug) values ('p-wh-tx', '事务项目', 'g-wh-tx', 'p-wh-tx')",
    );
    await memDb.query("insert into branches (id, project_id, name) values ('b-wh-tx', 'p-wh-tx', 'main')");
    const prodUrlEnc = encrypt('postgres://u:p@127.0.0.1:5432/prod');
    const stgUrlEnc = encrypt('postgres://u:p@127.0.0.1:5432/stg');
    await memDb.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ('e-prod', 'p-wh-tx', 'prod', $1, true), ('e-stg', 'p-wh-tx', 'staging', $2, false)`,
      [prodUrlEnc, stgUrlEnc],
    );
    await memDb.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
       values ('v-wh-1', 'p-wh-tx', 'b-wh-tx', 1, 'init', $1::text::jsonb, 1, '[]', '[]', 'chk-wh-1')`,
      [JSON.stringify(emptyModel())],
    );
    const allEvents = [
      'request.created',
      'request.approved',
      'request.rejected',
      'request.withdrawn',
      'request.invalidated',
      'request.executed',
      'execution.finished',
      'emergency.executed',
      'token.executed',
    ];
    await memDb.query(
      `insert into webhooks (id, group_id, name, format, url_enc, events, enabled)
       values ('w-tx', 'g-wh-tx', 'tx-hook', 'json', $1, $2::text::jsonb, true)`,
      [encrypt('https://example.invalid/hook'), JSON.stringify(allEvents)],
    );

    const prodConnHash = connHash({ url_enc: prodUrlEnc });
    const insertReq = async (
      id: string,
      opts: { status?: string; expiresAt?: string; lastApproverExecutes?: boolean } = {},
    ) => {
      const flow = {
        implicit: false,
        stages: [
          {
            approvers: { kind: 'project_admins' },
            count: 1,
            lastApproverExecutes: opts.lastApproverExecutes ?? false,
          },
        ],
      };
      await memDb.query(
        `insert into exec_requests
           (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
            migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at)
         values ($1, 'p-wh-tx', 'e-prod', $2, 'up', null, 'v-wh-1', $3::text::jsonb, null, '发布', $4::text::jsonb, $5, true, $6, 0, $7, $8, $8)`,
        [
          id,
          dev.id,
          JSON.stringify([
            { versionId: 'v-wh-1', number: 1, name: 'init', direction: 'up', checksum: 'chk-wh-1', steps: 1 },
          ]),
          JSON.stringify(flow),
          prodConnHash,
          opts.status ?? 'pending',
          opts.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
          new Date().toISOString(),
        ],
      );
    };

    const jobsOf = () =>
      memDb.query<{
        id: string;
        webhook_id: string;
        event_type: string;
        attempts: number;
        locked_by: string | null;
        payload: { type: string; data: Record<string, unknown> };
      }>(
        'select id, webhook_id, event_type, attempts, locked_by, payload from webhook_jobs order by created_at, rowid',
      );

    const cleanup = async () => {
      appObj.requests.stop();
      await appObj.requests.drain();
      await appObj.webhooks.close();
      await appObj.rooms.flush();
      await appObj.shadows.close();
      await memDb.close();
    };

    return { memDb, appObj, admin, dev, adminCookie, devCookie, insertReq, jobsOf, cleanup };
  };

  test('业务事务回滚时，同事务内 enqueueIn(tx) 写入的 webhook_jobs 一并回滚不残留且不唤醒队列', async () => {
    const { memDb, appObj, admin, adminCookie, insertReq, jobsOf, cleanup } = await setupTxEnv();
    const wakeCalls: boolean[] = [];
    const origWake = appObj.webhooks.wake.bind(appObj.webhooks);
    appObj.webhooks.wake = (broadcast = true) => {
      wakeCalls.push(broadcast);
    };
    try {
      // 1. 审批接口事务中：queueHook(tx) 写完 webhook_jobs 后，随后的 inbox_items 写库抛错 → 整个事务回滚
      await insertReq('req-rb-approve');
      const origTx = memDb.transaction.bind(memDb);
      let injectedApproveFail = false;
      memDb.transaction = (async <T>(fn: (tx: Parameters<Parameters<typeof origTx>[0]>[0]) => Promise<T>) =>
        origTx(async (tx) => {
          const origQuery = tx.query.bind(tx);
          tx.query = (async (sql: string, params?: unknown[]) => {
            if (!injectedApproveFail && sql.includes('insert into inbox_items')) {
              injectedApproveFail = true;
              throw new Error('模拟：审批通知落库失败触发事务回滚');
            }
            return origQuery(sql, params);
          }) as typeof tx.query;
          return fn(tx);
        })) as typeof memDb.transaction;

      try {
        const res = await appObj.app.request('/api/projects/p-wh-tx/requests/req-rb-approve/approve', {
          method: 'POST',
          headers: { cookie: adminCookie, 'content-type': 'application/json' },
          body: JSON.stringify({ stage: 0, comment: 'ok' }),
        });
        expect(res.status).toBe(500);
      } finally {
        memDb.transaction = origTx;
      }
      expect(injectedApproveFail).toBe(true);
      // 审批状态与 webhook_jobs 一并回滚，且未唤醒队列
      const [reqRow] = await memDb.query<{ status: string }>(
        "select status from exec_requests where id = 'req-rb-approve'",
      );
      expect(reqRow!.status).toBe('pending');
      expect(await jobsOf()).toEqual([]);
      expect(wakeCalls).toEqual([]);

      // 2. withPolicyLock 事务内 queueHook(tx) 后抛错 → webhook_jobs 同样完整回滚
      const [row] = await memDb.query<RequestRow>("select * from exec_requests where id = 'req-rb-approve'");
      const scope = (await appObj.requests.scopeOf(memDb, row!))!;
      const fx = new Effects();
      await expect(
        withPolicyLock(memDb, async (tx) => {
          const inserted = await appObj.requests.queueHook(tx, fx, 'request.created', row!, scope, {
            actor: admin.name,
            status: 'pending',
          });
          expect(inserted).toBe(1);
          throw new Error('模拟：业务事务后续失败');
        }),
      ).rejects.toThrow('模拟：业务事务后续失败');
      expect(await jobsOf()).toEqual([]);
      expect(wakeCalls).toEqual([]);

      // 3. 生产环境 afterTokenRun 事务内 enqueueIn(tx) 后 inbox_items 失败 → 两者同事务回滚且不阻断主响应
      const [prodEnv] = await memDb.query<EnvRow>("select * from environments where id = 'e-prod'");
      let injectedTokenFail = false;
      memDb.transaction = (async <T>(fn: (tx: Parameters<Parameters<typeof origTx>[0]>[0]) => Promise<T>) =>
        origTx(async (tx) => {
          const origQuery = tx.query.bind(tx);
          tx.query = (async (sql: string, params?: unknown[]) => {
            if (!injectedTokenFail && sql.includes('insert into inbox_items')) {
              injectedTokenFail = true;
              throw new Error('模拟：令牌生产通知写库失败');
            }
            return origQuery(sql, params);
          }) as typeof tx.query;
          return fn(tx);
        })) as typeof memDb.transaction;
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await appObj.requests.afterTokenRun(
          { id: 'tok-1', name: 'deploy', prefix: 'dwl_abc', createdByName: admin.name },
          { pid: 'p-wh-tx', env: prodEnv! },
          { id: 'v-wh-1', number: 1, name: 'init' },
          {
            ok: true,
            noop: false,
            current: { id: 'v-wh-1', number: 1, name: 'init' },
            ran: [1],
            error: null,
          },
        );
      } finally {
        memDb.transaction = origTx;
        errSpy.mockRestore();
      }
      expect(injectedTokenFail).toBe(true);
      expect(await jobsOf()).toEqual([]);
      expect(await memDb.query('select id from inbox_items')).toEqual([]);
      expect(wakeCalls).toEqual([]);
    } finally {
      appObj.webhooks.wake = origWake;
      await cleanup();
    }
  });

  test('审批 / 过期 / finish / afterDirectRun / afterTokenRun 返回瞬间 webhook_jobs 已同步落库且不经过异步 emit', async () => {
    const { memDb, appObj, admin, adminCookie, insertReq, jobsOf, cleanup } = await setupTxEnv();
    const wakeCalls: boolean[] = [];
    const emitCalls: unknown[] = [];
    const origWake = appObj.webhooks.wake.bind(appObj.webhooks);
    const origEmit = appObj.webhooks.emit.bind(appObj.webhooks);
    appObj.webhooks.wake = (broadcast = true) => {
      wakeCalls.push(broadcast);
    };
    appObj.webhooks.emit = (gid, ev) => {
      emitCalls.push({ gid, ev });
      origEmit(gid, ev);
    };
    try {
      // 1. 审批通过（POST /approve）
      await insertReq('req-ok-approve');
      const approveRes = await appObj.app.request('/api/projects/p-wh-tx/requests/req-ok-approve/approve', {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 0, comment: '同意' }),
      });
      expect(approveRes.status).toBe(200);
      let jobs = await jobsOf();
      expect(jobs.map((j) => j.event_type)).toEqual(['request.approved']);
      expect(jobs[0]!.payload.data.requestId).toBe('req-ok-approve');
      expect(jobs[0]!.attempts).toBe(0);
      expect(jobs[0]!.locked_by).toBeNull();
      expect(wakeCalls).toEqual([true]);

      // 2. 过期巡检（sweep -> closeStale）
      await insertReq('req-ok-expire', { expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(await appObj.requests.sweep()).toBe(1);
      jobs = await jobsOf();
      expect(jobs.map((j) => j.event_type)).toEqual(['request.approved', 'request.invalidated']);
      expect(jobs[1]!.payload.data).toMatchObject({ requestId: 'req-ok-expire', status: 'expired' });
      expect(wakeCalls).toEqual([true, true]);

      // 3. 执行收尾（finish）
      await insertReq('req-ok-finish', { status: 'executing' });
      await appObj.requests.finish(
        null,
        'req-ok-finish',
        { id: admin.id, name: admin.name },
        { ok: true, current: { id: 'v-wh-1', number: 1, name: 'init' }, error: null },
      );
      jobs = await jobsOf();
      expect(jobs.map((j) => j.event_type)).toEqual([
        'request.approved',
        'request.invalidated',
        'request.executed',
      ]);
      expect(jobs[2]!.payload.data).toMatchObject({ requestId: 'req-ok-finish', status: 'executed' });
      expect(wakeCalls).toEqual([true, true, true]);

      // 4. 直接执行收尾（afterDirectRun）
      const [stgEnv] = await memDb.query<EnvRow>("select * from environments where id = 'e-stg'");
      const [prodEnv] = await memDb.query<EnvRow>("select * from environments where id = 'e-prod'");
      await appObj.requests.afterDirectRun(
        { id: admin.id, name: admin.name },
        { pid: 'p-wh-tx', env: stgEnv! },
        { mode: 'migrate', to: 'v-wh-1', direction: 'up' },
        { ok: true, current: { id: 'v-wh-1', number: 1, name: 'init' }, ran: 1, error: null },
      );
      jobs = await jobsOf();
      expect(jobs.map((j) => j.event_type)).toEqual([
        'request.approved',
        'request.invalidated',
        'request.executed',
        'execution.finished',
      ]);
      expect(wakeCalls).toEqual([true, true, true, true]);

      // 5. CI 令牌执行收尾（afterTokenRun：非生产环境 + 生产环境同事务写收件箱）
      await appObj.requests.afterTokenRun(
        { id: 'tok-stg', name: 'ci-stg', prefix: 'dwl_stg', createdByName: admin.name },
        { pid: 'p-wh-tx', env: stgEnv! },
        { id: 'v-wh-1', number: 1, name: 'init' },
        { ok: true, noop: false, current: { id: 'v-wh-1', number: 1, name: 'init' }, ran: [1], error: null },
      );
      jobs = await jobsOf();
      expect(jobs.at(-1)!.event_type).toBe('token.executed');
      expect(jobs.at(-1)!.payload.data).toMatchObject({
        environment: { id: 'e-stg', name: 'staging', production: false },
      });

      await appObj.requests.afterTokenRun(
        { id: 'tok-prod', name: 'ci-prod', prefix: 'dwl_prd', createdByName: admin.name },
        { pid: 'p-wh-tx', env: prodEnv! },
        { id: 'v-wh-1', number: 1, name: 'init' },
        { ok: true, noop: false, current: { id: 'v-wh-1', number: 1, name: 'init' }, ran: [1], error: null },
      );
      jobs = await jobsOf();
      expect(jobs.map((j) => j.event_type)).toEqual([
        'request.approved',
        'request.invalidated',
        'request.executed',
        'execution.finished',
        'token.executed',
        'token.executed',
      ]);
      const tokenInbox = await memDb.query<{ id: string }>(
        "select id from inbox_items where kind = 'token_execution' and environment_id = 'e-prod'",
      );
      expect(tokenInbox.length).toBeGreaterThanOrEqual(1);
      expect(wakeCalls).toEqual([true, true, true, true, true, true]);

      // 全程没有经过异步 emit()
      expect(emitCalls).toHaveLength(0);
    } finally {
      appObj.webhooks.wake = origWake;
      appObj.webhooks.emit = origEmit;
      await cleanup();
    }
  });
});
