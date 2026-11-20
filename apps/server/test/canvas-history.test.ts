// 画布修改历史（C4）：多步编辑、跨 200 步快照边界重建、opDiff / diffToCurrent 准确性、
// 权限控制、workingSeq 乐观并发冲突、被 replace 覆盖后查看与恢复草稿且历史链不断裂。
import type { CanvasHistoryConflict, CanvasHistoryDetail, CanvasHistoryList, ModelUpdate } from '@dowel/api';
import { addColumn, all, createSchema, createTable, emptyModel, type Model, newId } from '@dowel/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import type { Peer } from '../src/rooms.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'canvas-history-test-secret-0123456789';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let rooms: ReturnType<typeof createApp>['rooms'];
let stop: () => Promise<void>;
let adminCookie = '';
let editorCookie = '';
let viewerCookie = '';
let outsiderCookie = '';
let pid = '';
let branchId = '';

const call = async (method: string, path: string, json?: unknown, cookie = '') => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const r = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data };
};

const login = async (username: string) => {
  const r = await call('POST', '/api/auth/login', { username, password: PASSWORD });
  expect(r.status).toBe(200);
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
};

/** 通过同步房间发送单步 op，精确模拟多人实时画布操作 */
const sendOp = async (peer: Peer, client: string, n: number, name: string, args: unknown) => {
  await rooms.message(branchId, peer, {
    t: 'op',
    op: { client, n, name, args, reads: [] },
  });
};

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
  app = created.app;
  rooms = created.rooms;
  stop = async () => {
    await created.rooms.flush();
    await created.shadows.close();
  };

  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  const editor = await makeUser(db, 'editor', { name: '张三' });
  const viewer = await makeUser(db, 'viewer', { name: '李四' });
  await makeUser(db, 'outsider', { name: '外部人员' });

  adminCookie = await login('admin');
  editorCookie = await login('editor');
  viewerCookie = await login('viewer');
  outsiderCookie = await login('outsider');

  const g = await call(
    'POST',
    '/api/groups',
    { slug: 'hist-g', name: '历史组', defaultRole: 'none' },
    adminCookie,
  );
  expect(g.status).toBe(201);
  const groupId = (g.data as { id: string }).id;

  const p = await call('POST', '/api/projects', { name: '画布历史项目', groupId }, adminCookie);
  expect(p.status).toBe(201);
  pid = (p.data as { id: string }).id;
  const [b] = await db.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  branchId = b!.id;

  await call(
    'POST',
    `/api/projects/${pid}/grants`,
    { subjectKind: 'user', subjectId: editor.id, role: 'editor' },
    adminCookie,
  );
  await call(
    'POST',
    `/api/projects/${pid}/grants`,
    { subjectKind: 'user', subjectId: viewer.id, role: 'viewer' },
    adminCookie,
  );
});

afterEach(async () => {
  await stop();
  await db.close();
});

test('多步编辑时间线、分页、版本徽章、opDiff 与 diffToCurrent 准确无误', async () => {
  const [editorUser] = await db.query<{ id: string; username: string; name: string; role: 'member' }>(
    "select id, username, name, role from users where username = 'editor'",
  );
  const peer: Peer = {
    user: {
      id: editorUser!.id,
      username: editorUser!.username,
      name: editorUser!.name,
      email: null,
      role: editorUser!.role,
      status: 'active',
      createdAt: '',
      lastLoginAt: null,
      hasPassword: true,
    },
    role: 'editor',
    send: () => {},
  };
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'c1', lastSeq: 0 });

  const initial = (await rooms.model(branchId)).model;
  const publicId = all(initial, 'schema').find((s) => s.name === 'public')!.id;

  const ordersId = newId();
  const idCol = newId();
  const totalCol = newId();
  await sendOp(peer, 'c1', 1, 'createTable', { id: ordersId, schema: publicId, name: 'orders' });
  await sendOp(peer, 'c1', 2, 'addColumn', {
    table: ordersId,
    column: { id: idCol, name: 'id', type: 'bigint', notNull: true },
  });
  await sendOp(peer, 'c1', 3, 'addColumn', {
    table: ordersId,
    column: { id: totalCol, name: 'total', type: 'integer', notNull: false },
  });

  // 在 seq = 3 发布版本 v1
  const pub = await call('POST', `/api/projects/${pid}/versions`, { name: '首个版本' }, editorCookie);
  expect(pub.status).toBe(201);
  const versionId = (pub.data as { id: string }).id;

  // seq = 4：重命名 total -> amount
  await sendOp(peer, 'c1', 4, 'renameColumn', { id: totalCol, name: 'amount' });
  await rooms.leave(branchId, peer);

  // 分页：limit = 2 逐页拉取，验证游标直到 seq = 0
  const page1 = await call('GET', `/api/projects/${pid}/history?limit=2`, undefined, viewerCookie);
  expect(page1.status).toBe(200);
  const l1 = page1.data as CanvasHistoryList;
  expect(l1.currentSeq).toBe(4);
  expect(l1.entries.map((e) => e.seq)).toEqual([4, 3]);
  expect(l1.entries[0]).toMatchObject({
    seq: 4,
    user: '张三',
    opName: 'renameColumn',
    isCurrent: true,
    version: null,
  });
  expect(l1.entries[1]).toMatchObject({
    seq: 3,
    user: '张三',
    opName: 'addColumn',
    isCurrent: false,
    version: { id: versionId, number: 1, name: '首个版本' },
  });
  expect(l1.nextBeforeSeq).toBe(3);

  const page2 = await call(
    'GET',
    `/api/projects/${pid}/history?limit=2&beforeSeq=${l1.nextBeforeSeq}`,
    undefined,
    viewerCookie,
  );
  const l2 = page2.data as CanvasHistoryList;
  expect(l2.entries.map((e) => e.seq)).toEqual([2, 1]);
  expect(l2.nextBeforeSeq).toBe(1);

  const page3 = await call(
    'GET',
    `/api/projects/${pid}/history?limit=2&beforeSeq=${l2.nextBeforeSeq}`,
    undefined,
    viewerCookie,
  );
  const l3 = page3.data as CanvasHistoryList;
  expect(l3.entries.map((e) => e.seq)).toEqual([0]);
  expect(l3.entries[0]).toMatchObject({ seq: 0, opName: 'init', isCurrent: false });
  expect(l3.nextBeforeSeq).toBeNull();

  // 检查 seq = 4 详情：opDiff 为 RENAME COLUMN total TO amount，diffToCurrent 为空
  const d4Res = await call('GET', `/api/projects/${pid}/history/4`, undefined, viewerCookie);
  expect(d4Res.status).toBe(200);
  const d4 = d4Res.data as CanvasHistoryDetail<Model>;
  expect(d4.opDiff.total).toBe(1);
  expect(d4.opDiff.items[0]!.sql).toContain('RENAME COLUMN total TO amount');
  expect(d4.diffToCurrent.total).toBe(0);

  // 检查 seq = 3 详情：opDiff 为 ADD COLUMN total，model 里是 total，diffToCurrent 为 RENAME COLUMN amount TO total
  const d3Res = await call('GET', `/api/projects/${pid}/history/3`, undefined, viewerCookie);
  expect(d3Res.status).toBe(200);
  const d3 = d3Res.data as CanvasHistoryDetail<Model>;
  expect(d3.entry.version).toEqual({ id: versionId, number: 1, name: '首个版本' });
  expect(d3.opDiff.items.some((i) => i.sql.includes('ADD COLUMN total'))).toBe(true);
  expect(all(d3.model, 'column').map((c) => c.name)).toContain('total');
  expect(all(d3.model, 'column').map((c) => c.name)).not.toContain('amount');
  expect(d3.diffToCurrent.total).toBe(1);
  expect(d3.diffToCurrent.items[0]!.sql).toContain('RENAME COLUMN amount TO total');

  // 检查 seq = 0 详情：opDiff 为空，model 无表，diffToCurrent 为 DROP TABLE orders
  const d0Res = await call('GET', `/api/projects/${pid}/history/0`, undefined, viewerCookie);
  expect(d0Res.status).toBe(200);
  const d0 = d0Res.data as CanvasHistoryDetail<Model>;
  expect(d0.opDiff).toEqual({ total: 0, items: [] });
  expect(all(d0.model, 'table')).toHaveLength(0);
  expect(d0.diffToCurrent.items.some((i) => i.sql.includes('DROP TABLE'))).toBe(true);

  // 越界与非法 seq
  expect((await call('GET', `/api/projects/${pid}/history/5`, undefined, viewerCookie)).status).toBe(404);
  expect((await call('GET', `/api/projects/${pid}/history/abc`, undefined, viewerCookie)).status).toBe(400);
});

test('跨 200 步快照边界精确重建任意 seq', async () => {
  const [editorUser] = await db.query<{ id: string; username: string; name: string; role: 'member' }>(
    "select id, username, name, role from users where username = 'editor'",
  );
  const peer: Peer = {
    user: {
      id: editorUser!.id,
      username: editorUser!.username,
      name: editorUser!.name,
      email: null,
      role: editorUser!.role,
      status: 'active',
      createdAt: '',
      lastLoginAt: null,
      hasPassword: true,
    },
    role: 'editor',
    send: () => {},
  };
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'snap', lastSeq: 0 });

  const publicId = all((await rooms.model(branchId)).model, 'schema').find((s) => s.name === 'public')!.id;
  const totalOps = 205;
  for (let i = 1; i <= totalOps; i++) {
    await sendOp(peer, 'snap', i, 'createTable', {
      id: `tb_${i}`,
      schema: publicId,
      name: `t_${i}`,
    });
  }
  await rooms.leave(branchId, peer);

  // 确认 200 步时确实写了快照
  const snaps = await db.query<{ seq: string | number }>(
    'select seq from room_snapshots where branch_id = $1 order by seq',
    [branchId],
  );
  expect(snaps.map((s) => Number(s.seq))).toEqual([0, 200]);

  // 校验边界点：0、1、199、200、201、205
  for (const seq of [0, 1, 199, 200, 201, 205]) {
    const m = await rooms.modelAt(branchId, seq);
    const tables = all(m, 'table');
    expect(tables).toHaveLength(seq);
    if (seq > 0) {
      expect(tables.some((t) => t.name === `t_${seq}`)).toBe(true);
      expect(tables.some((t) => t.name === `t_${seq + 1}`)).toBe(false);
    }
  }

  // 通过 HTTP 接口读取跨快照点 #201 的 opDiff（只新增 t_201）
  const d201 = await call('GET', `/api/projects/${pid}/history/201`, undefined, viewerCookie);
  expect(d201.status).toBe(200);
  const body201 = d201.data as CanvasHistoryDetail<Model>;
  expect(body201.opDiff.total).toBe(1);
  expect(body201.opDiff.items[0]!.target).toBe('tb_201');
  expect(body201.opDiff.items[0]!.sql).toContain('CREATE TABLE public.t_201');
  expect(all(body201.model, 'table')).toHaveLength(201);
});

test('权限控制、workingSeq 并发冲突 409 与 replace 覆盖后找回草稿且历史链不断裂', async () => {
  // 1. 构造草稿（seq 1：draft_orders）
  const draft = structuredClone((await rooms.model(branchId)).model);
  const pubId = all(draft, 'schema').find((s) => s.name === 'public')!.id;
  const draftTable = createTable(draft, pubId, 'draft_orders');
  addColumn(draft, draftTable, { name: 'id', type: 'bigint', notNull: true });
  await rooms.replace(branchId, '张三', draft, 'createTable');
  expect((await rooms.model(branchId)).seq).toBe(1);

  // 2. 模拟 attachAhead 覆盖工作副本（seq 2：prod_users，覆盖掉了 draft_orders）
  const ahead = emptyModel();
  const aheadPub = createSchema(ahead, 'public');
  const prodTable = createTable(ahead, aheadPub, 'prod_users');
  addColumn(ahead, prodTable, { name: 'id', type: 'bigint', notNull: true });
  await rooms.replace(branchId, '管理员', ahead, 'attachAhead');
  expect((await rooms.model(branchId)).seq).toBe(2);

  // 权限检查：outsider 全部 404；viewer 可读 200 但恢复 403
  expect((await call('GET', `/api/projects/${pid}/history`, undefined, outsiderCookie)).status).toBe(404);
  expect((await call('GET', `/api/projects/${pid}/history/1`, undefined, outsiderCookie)).status).toBe(404);
  expect((await call('POST', `/api/projects/${pid}/history/1/restore`, {}, outsiderCookie)).status).toBe(404);

  expect((await call('GET', `/api/projects/${pid}/history`, undefined, viewerCookie)).status).toBe(200);
  expect((await call('GET', `/api/projects/${pid}/history/1`, undefined, viewerCookie)).status).toBe(200);
  expect((await call('POST', `/api/projects/${pid}/history/1/restore`, {}, viewerCookie)).status).toBe(403);

  // 查看被覆盖前的草稿（seq = 1）
  const draftDetailRes = await call('GET', `/api/projects/${pid}/history/1`, undefined, editorCookie);
  expect(draftDetailRes.status).toBe(200);
  const draftDetail = draftDetailRes.data as CanvasHistoryDetail<Model>;
  expect(all(draftDetail.model, 'table').map((t) => t.name)).toEqual(['draft_orders']);
  // diffToCurrent：把当前 prod_users 恢复到 draft_orders
  expect(
    draftDetail.diffToCurrent.items.some((i) => i.sql.includes('CREATE TABLE public.draft_orders')),
  ).toBe(true);
  expect(draftDetail.diffToCurrent.items.some((i) => i.sql.includes('DROP TABLE public.prod_users'))).toBe(
    true,
  );

  // 缺少 workingSeq 被 400 拒绝（必须携带乐观并发校验序号）
  expect((await call('POST', `/api/projects/${pid}/history/1/restore`, {}, editorCookie)).status).toBe(400);

  // 并发冲突：传入过期的 workingSeq = 1（当前已是 2），返回 409 working_changed + 最新 currentSeq + diffToCurrent
  const conflictRes = await call(
    'POST',
    `/api/projects/${pid}/history/1/restore`,
    { workingSeq: 1 },
    editorCookie,
  );
  expect(conflictRes.status).toBe(409);
  const conflict = conflictRes.data as CanvasHistoryConflict;
  expect(conflict.code).toBe('working_changed');
  expect(conflict.currentSeq).toBe(2);
  expect(conflict.diffToCurrent.total).toBeGreaterThan(0);

  // 带最新 workingSeq = 2 恢复原草稿成功，生成新提交 seq = 3，原历史完整保留
  const restoreRes = await call(
    'POST',
    `/api/projects/${pid}/history/1/restore`,
    { workingSeq: 2 },
    editorCookie,
  );
  expect(restoreRes.status).toBe(200);
  const updated = restoreRes.data as ModelUpdate;
  expect(updated.seq).toBe(3);

  const now = await rooms.model(branchId);
  expect(now.seq).toBe(3);
  expect(all(now.model, 'table').map((t) => t.name)).toEqual(['draft_orders']);

  // 历史链不断裂：seq 3 (restoreHistory) → seq 2 (attachAhead) → seq 1 (createTable) → seq 0 (init)
  const listAfter = (await call('GET', `/api/projects/${pid}/history`, undefined, editorCookie))
    .data as CanvasHistoryList;
  expect(listAfter.entries.map((e) => [e.seq, e.opName])).toEqual([
    [3, 'restoreHistory'],
    [2, 'attachAhead'],
    [1, 'createTable'],
    [0, 'init'],
  ]);

  // 恢复到当前相同状态：安全返回当前 seq，不写空提交
  const noopRes = await call(
    'POST',
    `/api/projects/${pid}/history/3/restore`,
    { workingSeq: 3 },
    editorCookie,
  );
  expect(noopRes.status).toBe(200);
  expect((noopRes.data as ModelUpdate).seq).toBe(3);

  // 审计日志已记录 model.restore
  const audits = await db.query<{ action: string; target_kind: string; target_id: string; data: unknown }>(
    "select action, target_kind, target_id, data from audit_events where action = 'model.restore'",
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    action: 'model.restore',
    target_kind: 'project',
    target_id: pid,
    data: { fromSeq: 2, restoredSeq: 1, newSeq: 3 },
  });
});
