// 画布修改历史（C4）：多步编辑、跨 200 步快照边界重建、opDiff / diffToCurrent 准确性、
// 权限控制、workingSeq 乐观并发冲突、被 replace 覆盖后查看与恢复草稿且历史链不断裂。
import type {
  CanvasHistoryConflict,
  CanvasHistoryDetail,
  CanvasHistoryList,
  CanvasHistorySteps,
  ModelUpdate,
} from '@dowel/api';
import { addColumn, all, createSchema, createTable, emptyModel, type Model, newId } from '@dowel/core';
import { type HistoryVersionRow, stepsChecksum } from '@dowel/engines';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import type { Peer } from '../src/rooms.ts';
import { insertRestoredVersions } from '../src/takeover.ts';
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

/** 按用户名构造同步房间 Peer（编辑者） */
const peerOf = async (username: string): Promise<Peer> => {
  const [u] = await db.query<{ id: string; username: string; name: string; role: 'member' }>(
    'select id, username, name, role from users where username = $1',
    [username],
  );
  return {
    user: {
      id: u!.id,
      username: u!.username,
      name: u!.name,
      email: null,
      role: u!.role,
      status: 'active',
      createdAt: '',
      lastLoginAt: null,
      hasPassword: true,
      mustChangePassword: false,
    },
    role: 'editor',
    send: () => {},
  };
};

const listOf = async (query: string, cookie = viewerCookie) => {
  const r = await call('GET', `/api/projects/${pid}/history${query}`, undefined, cookie);
  expect(r.status).toBe(200);
  return r.data as CanvasHistoryList;
};

const rangesOf = (l: CanvasHistoryList) => l.entries.map((e) => [e.seqFrom, e.seq]);

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
      mustChangePassword: false,
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

  // 默认归组视图：#1–#3 为同一编辑会话（组尾 #3 是已发布 v1，可作组尾），#4 在 v1 之后硬断开另起一条
  const g1 = await listOf('?limit=2');
  expect(g1.grouped).toBe(true);
  expect(g1.currentSeq).toBe(4);
  expect(rangesOf(g1)).toEqual([
    [4, 4],
    [1, 3],
  ]);
  expect(g1.entries[0]).toMatchObject({
    seq: 4,
    seqFrom: 4,
    stepCount: 1,
    user: '张三',
    opName: 'renameColumn',
    isCurrent: true,
    version: null,
  });
  expect(g1.entries[0]!.ops).toBeUndefined();
  expect(g1.entries[1]).toMatchObject({
    seq: 3,
    seqFrom: 1,
    stepCount: 3,
    user: '张三',
    opName: 'editSession',
    changeCount: 3,
    isCurrent: false,
    version: { id: versionId, number: 1, name: '首个版本' },
    ops: [
      { name: 'addColumn', count: 2 },
      { name: 'createTable', count: 1 },
    ],
  });
  expect(g1.entries[1]!.summary).toEqual(['orders', 'orders.id', 'orders.total']);
  expect(g1.entries[1]!.startedAt <= g1.entries[1]!.at).toBe(true);
  // 满 limit 且末组从 #1 开始：游标为 1，下一页只剩初始状态
  expect(g1.nextBeforeSeq).toBe(1);
  const g2 = await listOf('?limit=2&beforeSeq=1');
  expect(g2.entries.map((e) => [e.seq, e.opName, e.seqFrom, e.stepCount])).toEqual([[0, 'init', 0, 0]]);
  expect(g2.nextBeforeSeq).toBeNull();
  expect(rangesOf(await listOf(''))).toEqual([
    [4, 4],
    [1, 3],
    [0, 0],
  ]);
  // grouped 参数非法
  expect(
    (await call('GET', `/api/projects/${pid}/history?grouped=yes`, undefined, viewerCookie)).status,
  ).toBe(400);

  // 原始单步视图（?grouped=false）：limit = 2 逐页拉取，验证游标直到 seq = 0
  const page1 = await call(
    'GET',
    `/api/projects/${pid}/history?limit=2&grouped=false`,
    undefined,
    viewerCookie,
  );
  expect(page1.status).toBe(200);
  const l1 = page1.data as CanvasHistoryList;
  expect(l1.grouped).toBe(false);
  expect(l1.currentSeq).toBe(4);
  expect(l1.entries.map((e) => e.seq)).toEqual([4, 3]);
  expect(l1.entries[0]).toMatchObject({
    seq: 4,
    seqFrom: 4,
    stepCount: 1,
    user: '张三',
    opName: 'renameColumn',
    isCurrent: true,
    version: null,
  });
  expect(l1.entries[1]).toMatchObject({
    seq: 3,
    seqFrom: 3,
    stepCount: 1,
    user: '张三',
    opName: 'addColumn',
    isCurrent: false,
    version: { id: versionId, number: 1, name: '首个版本' },
  });
  expect(l1.entries[0]!.startedAt).toBe(l1.entries[0]!.at);
  expect(l1.nextBeforeSeq).toBe(3);

  const page2 = await call(
    'GET',
    `/api/projects/${pid}/history?limit=2&grouped=0&beforeSeq=${l1.nextBeforeSeq}`,
    undefined,
    viewerCookie,
  );
  const l2 = page2.data as CanvasHistoryList;
  expect(l2.entries.map((e) => e.seq)).toEqual([2, 1]);
  expect(l2.nextBeforeSeq).toBe(1);

  const page3 = await call(
    'GET',
    `/api/projects/${pid}/history?limit=2&grouped=0&beforeSeq=${l2.nextBeforeSeq}`,
    undefined,
    viewerCookie,
  );
  const l3 = page3.data as CanvasHistoryList;
  expect(l3.entries.map((e) => e.seq)).toEqual([0]);
  expect(l3.entries[0]).toMatchObject({ seq: 0, seqFrom: 0, stepCount: 0, opName: 'init', isCurrent: false });
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
      mustChangePassword: false,
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

test('恢复版本不与画布提交序号撞号，遗留数据过滤 restored_at 且新发布版本仍准确标记（#13）', async () => {
  // 构造接手恢复的 v0..v3 版本链，并将 seq = 0 初始快照对齐到链头 v3.model（模拟 restoreChain 后的项目）
  const baseModel = emptyModel();
  const publicId = createSchema(baseModel, 'public');
  const legacyTable = createTable(baseModel, publicId, 'legacy_users');
  addColumn(baseModel, legacyTable, { name: 'id', type: 'bigint', notNull: true });

  const emptyChecksum = stepsChecksum([], []);
  const versionIds = [newId(), newId(), newId(), newId()];
  const restored: HistoryVersionRow[] = versionIds.map((versionId, i) => ({
    projectId: pid,
    versionId,
    number: i,
    parentId: i === 0 ? null : versionIds[i - 1]!,
    name: i === 0 ? '初始基线' : `恢复版本 v${i}`,
    scope: null,
    upSteps: [],
    downSteps: [],
    checksum: emptyChecksum,
    model: structuredClone(baseModel),
    fingerprint: `fp-${i}`,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    publishedBy: null,
  }));

  await db.query('update room_snapshots set model = $2::text::jsonb where branch_id = $1 and seq = 0', [
    branchId,
    JSON.stringify(baseModel),
  ]);
  await insertRestoredVersions(db, {
    pid,
    branch: branchId,
    versions: restored,
    verifiedReports: new Map(),
  });

  // 1. 验证 insertRestoredVersions 写入 seq = -1 且 restored_at 非空
  const storedRestored = await db.query<{
    id: string;
    number: number;
    seq: number;
    restored_at: string | null;
  }>('select id, number, seq, restored_at from versions where project_id = $1 order by number', [pid]);
  expect(storedRestored).toHaveLength(4);
  for (const row of storedRestored) {
    expect(Number(row.seq)).toBe(-1);
    expect(row.restored_at).not.toBeNull();
  }

  // 在接手后的画布上执行 3 次普通编辑（seq = 1, 2, 3）
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
      mustChangePassword: false,
    },
    role: 'editor',
    send: () => {},
  };
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'c-takeover', lastSeq: 0 });

  const ordersId = newId();
  await sendOp(peer, 'c-takeover', 1, 'createTable', { id: ordersId, schema: publicId, name: 'orders' });
  await sendOp(peer, 'c-takeover', 2, 'addColumn', {
    table: ordersId,
    column: { id: newId(), name: 'id', type: 'bigint', notNull: true },
  });
  await sendOp(peer, 'c-takeover', 3, 'addColumn', {
    table: ordersId,
    column: { id: newId(), name: 'status', type: 'text', notNull: false },
  });

  // listHistory 与 historyEntry 对 seq = 0, 1, 2, 3 均不应错标为已发布版本
  const listAfterTakeover = await rooms.listHistory(branchId, { limit: 10, grouped: false });
  expect(listAfterTakeover.entries.map((e) => [e.seq, e.version])).toEqual([
    [3, null],
    [2, null],
    [1, null],
    [0, null],
  ]);
  for (const seq of [0, 1, 2, 3]) {
    expect((await rooms.historyEntry(branchId, seq)).version).toBeNull();
  }

  // 2. 模拟历史遗留数据：restored_at 非空且旧 seq 被写成版本号 v.number（0, 1, 2, 3）
  await db.query('update versions set seq = number where project_id = $1 and restored_at is not null', [pid]);
  const legacySeqs = await db.query<{ number: number; seq: number }>(
    'select number, seq from versions where project_id = $1 order by number',
    [pid],
  );
  expect(legacySeqs.map((r) => [Number(r.number), Number(r.seq)])).toEqual([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
  ]);

  const listWithLegacy = await rooms.listHistory(branchId, { limit: 10, grouped: false });
  expect(listWithLegacy.entries.map((e) => [e.seq, e.version])).toEqual([
    [3, null],
    [2, null],
    [1, null],
    [0, null],
  ]);
  for (const seq of [0, 1, 2, 3]) {
    expect((await rooms.historyEntry(branchId, seq)).version).toBeNull();
  }

  // 3. 接手后正常发布新版本 v4（restored_at is null，对应 seq = 3），再继续一次普通编辑 seq = 4
  const pub = await call('POST', `/api/projects/${pid}/versions`, { name: '接手后新版本' }, editorCookie);
  expect(pub.status).toBe(201);
  const v4 = pub.data as { id: string; number: number; seq: number; name: string };
  expect(v4).toMatchObject({ number: 4, seq: 3, name: '接手后新版本' });

  await sendOp(peer, 'c-takeover', 4, 'addColumn', {
    table: ordersId,
    column: { id: newId(), name: 'note', type: 'text', notNull: false },
  });
  await rooms.leave(branchId, peer);

  const expectedV4 = { id: v4.id, number: 4, name: '接手后新版本' };
  const listAfterPublish = await rooms.listHistory(branchId, { limit: 10, grouped: false });
  expect(listAfterPublish.entries.map((e) => [e.seq, e.version])).toEqual([
    [4, null],
    [3, expectedV4],
    [2, null],
    [1, null],
    [0, null],
  ]);
  for (const seq of [0, 1, 2, 4]) {
    expect((await rooms.historyEntry(branchId, seq)).version).toBeNull();
  }
  expect((await rooms.historyEntry(branchId, 3)).version).toEqual(expectedV4);

  // 通过 HTTP 接口核对列表与单条详情
  // 归组视图：遗留 seq 撞号的恢复版本不会被当成硬断点；只有接手后真实发布的 v4（seq = 3）断开
  const groupedAfterPublish = await rooms.listHistory(branchId, { limit: 10 });
  expect(groupedAfterPublish.entries.map((e) => [e.seqFrom, e.seq, e.version])).toEqual([
    [4, 4, null],
    [1, 3, expectedV4],
    [0, 0, null],
  ]);

  const httpList = await call('GET', `/api/projects/${pid}/history?grouped=false`, undefined, viewerCookie);
  expect(httpList.status).toBe(200);
  expect((httpList.data as CanvasHistoryList).entries.map((e) => [e.seq, e.version])).toEqual([
    [4, null],
    [3, expectedV4],
    [2, null],
    [1, null],
    [0, null],
  ]);
  const httpDetail3 = await call('GET', `/api/projects/${pid}/history/3`, undefined, viewerCookie);
  expect(httpDetail3.status).toBe(200);
  expect((httpDetail3.data as CanvasHistoryDetail<Model>).entry.version).toEqual(expectedV4);
  const httpDetail0 = await call('GET', `/api/projects/${pid}/history/0`, undefined, viewerCookie);
  expect(httpDetail0.status).toBe(200);
  expect((httpDetail0.data as CanvasHistoryDetail<Model>).entry.version).toBeNull();
});

test('MCP batch 提交：1 条历史记录，opSummary 单独返回（脱敏），整批 opDiff 可查看，普通提交没有 opSummary', async () => {
  const [editorUser] = await db.query<{ id: string; name: string }>(
    "select id, name from users where username = 'editor'",
  );
  const initial = (await rooms.model(branchId)).model;
  const publicId = all(initial, 'schema').find((s) => s.name === 'public')!.id;

  const res = await rooms.applyMcpOps(branchId, {
    userId: editorUser!.id,
    tokenId: 'tok-hist',
    user: editorUser!.name,
    baseSeq: 0,
    summary: '  新增 orders 表 password=hunter2-secret  ',
    ops: [
      { name: 'createTable', args: { id: '$ref:t', schema: publicId, name: 'orders' } },
      {
        name: 'addColumn',
        args: { table: '$ref:t', column: { id: '$ref:c1', name: 'id', type: 'bigint', notNull: true } },
      },
      {
        name: 'addColumn',
        args: { table: '$ref:t', column: { id: '$ref:c2', name: 'note', type: 'text' } },
      },
    ],
  });
  expect(res).toMatchObject({ ok: true, seq: 1, opCount: 3 });
  if (!res.ok) return;

  const [row] = await db.query<{ op_name: string; op_summary: string | null }>(
    'select op_name, op_summary from room_commits where branch_id = $1 and seq = 1',
    [branchId],
  );
  expect(row!.op_name).toBe('batch');
  expect(row!.op_summary).toContain('新增 orders 表');
  expect(row!.op_summary).not.toContain('hunter2-secret');

  const list = await call('GET', `/api/projects/${pid}/history?limit=10`, undefined, viewerCookie);
  expect(list.status).toBe(200);
  const entries = (list.data as CanvasHistoryList).entries;
  expect(entries.map((e) => e.seq)).toEqual([1, 0]);
  expect(entries[0]).toMatchObject({ opName: 'batch', changeCount: 3, via: 'mcp', seqFrom: 1, stepCount: 1 });
  expect(entries[0]!.ops).toBeUndefined();
  expect(entries[0]!.opSummary).toBe(row!.op_summary);
  expect(entries[1]!.opSummary).toBeUndefined();

  const detail = await call('GET', `/api/projects/${pid}/history/1`, undefined, viewerCookie);
  expect(detail.status).toBe(200);
  const d = detail.data as CanvasHistoryDetail;
  expect(d.entry.opSummary).toBe(row!.op_summary);
  expect(d.opDiff.total).toBeGreaterThan(0);
  expect(d.opDiff.items.some((i) => i.sql.includes('orders'))).toBe(true);

  // 不带 summary 的批提交没有 opSummary
  const plain = await rooms.applyMcpOps(branchId, {
    userId: editorUser!.id,
    tokenId: 'tok-hist',
    user: editorUser!.name,
    baseSeq: 1,
    ops: [{ name: 'setComment', args: { id: res.refs.t!, comment: '订单' } }],
  });
  expect(plain).toMatchObject({ ok: true, seq: 2, opCount: 1 });
  const e2 = await rooms.historyEntry(branchId, 2);
  expect(e2.opName).toBe('batch');
  expect(e2.opSummary).toBeUndefined();
});

test('编辑会话归组：3×50 步跨页不劈断，游标与 limit 无关，非边界 beforeSeq 截断在 < beforeSeq', async () => {
  const peer = await peerOf('editor');
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'bulk', lastSeq: 0 });
  const publicId = all((await rooms.model(branchId)).model, 'schema').find((s) => s.name === 'public')!.id;
  for (let i = 1; i <= 150; i++) {
    await sendOp(peer, 'bulk', i, 'createTable', { id: `tb_${i}`, schema: publicId, name: `t_${i}` });
  }
  await rooms.leave(branchId, peer);

  const walk = async (limit: number) => {
    const pages: number[][][] = [];
    const cursors: (number | null)[] = [];
    let before: number | null | undefined;
    for (let guard = 0; guard < 10 && before !== null; guard++) {
      const l = await listOf(`?limit=${limit}${before === undefined ? '' : `&beforeSeq=${before}`}`);
      pages.push(rangesOf(l));
      cursors.push(l.nextBeforeSeq);
      before = l.nextBeforeSeq;
    }
    return { pages, cursors, all: pages.flat() };
  };

  const expected = [
    [101, 150],
    [51, 100],
    [1, 50],
    [0, 0],
  ];
  const w1 = await walk(1);
  expect(w1.pages).toEqual([[[101, 150]], [[51, 100]], [[1, 50]], [[0, 0]]]);
  expect(w1.cursors).toEqual([101, 51, 1, null]);
  const w2 = await walk(2);
  expect(w2.all).toEqual(expected);
  expect(w2.cursors).toEqual([51, null]);
  const w3 = await walk(3);
  expect(w3.all).toEqual(expected);
  expect(w3.cursors).toEqual([1, null]);
  expect((await walk(30)).all).toEqual(expected);

  const top = (await listOf('?limit=1')).entries[0]!;
  expect(top).toMatchObject({
    seq: 150,
    seqFrom: 101,
    stepCount: 50,
    opName: 'editSession',
    isCurrent: true,
  });
  expect(top.changeCount).toBe(50);
  expect(top.summary).toHaveLength(5);
  expect(top.summary[0]).toBe('t_101');
  expect(top.ops).toEqual([{ name: 'createTable', count: 50 }]);

  // 非组边界的 beforeSeq：顶组截断为 #101–#119，下面的组边界不变
  const mid = await listOf('?limit=2&beforeSeq=120');
  expect(rangesOf(mid)).toEqual([
    [101, 119],
    [51, 100],
  ]);
  expect(mid.entries[0]).toMatchObject({ stepCount: 19, isCurrent: false });
  expect(mid.nextBeforeSeq).toBe(51);

  // 第 151 步只延长 / 续开末尾组，旧组与游标不变
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'bulk', lastSeq: 150 });
  await sendOp(peer, 'bulk', 151, 'createTable', { id: 'tb_151', schema: publicId, name: 't_151' });
  await rooms.leave(branchId, peer);
  expect(rangesOf(await listOf(''))).toEqual([[151, 151], ...expected]);
});

test('同名不同账号绝不合并；?from= 整组净差异、/steps 倒序单步与越界校验；恢复中间单步与组尾', async () => {
  // 与 editor 同名（张三）的另一个账号
  const twin = await makeUser(db, 'editor-twin', { name: '张三' });
  await call(
    'POST',
    `/api/projects/${pid}/grants`,
    { subjectKind: 'user', subjectId: twin.id, role: 'editor' },
    adminCookie,
  );

  const peer = await peerOf('editor');
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'tab-a', lastSeq: 0 });
  const publicId = all((await rooms.model(branchId)).model, 'schema').find((s) => s.name === 'public')!.id;
  const ordersId = newId();
  const idCol = newId();
  const totalCol = newId();
  const tmpCol = newId();
  await sendOp(peer, 'tab-a', 1, 'createTable', { id: ordersId, schema: publicId, name: 'orders' });
  await sendOp(peer, 'tab-a', 2, 'addColumn', {
    table: ordersId,
    column: { id: idCol, name: 'id', type: 'bigint', notNull: true },
  });
  // 同一账号另一个标签页继续编辑：合并进同一会话
  const tabB = await peerOf('editor');
  await rooms.join(branchId, tabB);
  await rooms.message(branchId, tabB, { t: 'hello', client: 'tab-b', lastSeq: 2 });
  await sendOp(tabB, 'tab-b', 1, 'addColumn', {
    table: ordersId,
    column: { id: totalCol, name: 'total', type: 'integer', notNull: false },
  });
  await sendOp(tabB, 'tab-b', 2, 'addColumn', {
    table: ordersId,
    column: { id: tmpCol, name: 'tmp', type: 'text', notNull: false },
  });
  await sendOp(tabB, 'tab-b', 3, 'dropColumn', { id: tmpCol });
  await rooms.leave(branchId, tabB);
  await rooms.leave(branchId, peer);

  // 同名不同账号紧接着编辑：另起一组
  const twinPeer = await peerOf('editor-twin');
  await rooms.join(branchId, twinPeer);
  await rooms.message(branchId, twinPeer, { t: 'hello', client: 'tab-a', lastSeq: 5 });
  await sendOp(twinPeer, 'tab-a', 1, 'renameColumn', { id: totalCol, name: 'amount' });
  await sendOp(twinPeer, 'tab-a', 2, 'setComment', { id: ordersId, comment: '订单' });
  await rooms.leave(branchId, twinPeer);

  const list = await listOf('');
  expect(list.entries.map((e) => [e.seqFrom, e.seq, e.user, e.opName])).toEqual([
    [6, 7, '张三', 'editSession'],
    [1, 5, '张三', 'editSession'],
    [0, 0, '', 'init'],
  ]);
  const session = list.entries[1]!;
  expect(session.stepCount).toBe(5);
  // 去重后涉及 orders、id、total、tmp 四个对象
  expect(session.changeCount).toBe(4);
  expect(session.summary).toEqual(['orders', 'orders.id', 'orders.total', 'orders.tmp']);
  expect(session.ops).toEqual([
    { name: 'addColumn', count: 3 },
    { name: 'createTable', count: 1 },
    { name: 'dropColumn', count: 1 },
  ]);

  // 整组净差异 #0 → #5：建 orders(id, total)，tmp 加了又删不出现
  const dRes = await call('GET', `/api/projects/${pid}/history/5?from=1`, undefined, viewerCookie);
  expect(dRes.status).toBe(200);
  const d = dRes.data as CanvasHistoryDetail<Model>;
  expect(d.entry).toMatchObject({ seq: 5, seqFrom: 1, stepCount: 5, opName: 'editSession', changeCount: 4 });
  expect(d.entry.summary).toEqual(session.summary);
  expect(d.opDiff.items.some((i) => i.sql.includes('CREATE TABLE public.orders'))).toBe(true);
  expect(d.opDiff.items.some((i) => i.sql.includes('tmp'))).toBe(false);
  expect(
    all(d.model, 'column')
      .map((c) => c.name)
      .sort(),
  ).toEqual(['id', 'total']);
  expect(d.diffToCurrent.items.some((i) => i.sql.includes('RENAME COLUMN amount TO total'))).toBe(true);
  expect(d.currentSeq).toBe(7);
  // 与组尾单步详情的模型一致
  const tail = (await call('GET', `/api/projects/${pid}/history/5`, undefined, viewerCookie))
    .data as CanvasHistoryDetail<Model>;
  expect(tail.entry).toMatchObject({ seq: 5, seqFrom: 5, stepCount: 1, opName: 'dropColumn' });
  expect(tail.model).toEqual(d.model);
  // from === seq 等同单步
  const same = (await call('GET', `/api/projects/${pid}/history/5?from=5`, undefined, viewerCookie))
    .data as CanvasHistoryDetail<Model>;
  expect(same.entry.opName).toBe('dropColumn');

  // ?from= 越界 400 / 404
  for (const q of ['5?from=0', '5?from=6', '60?from=1', '0?from=1', '5?from=x']) {
    expect((await call('GET', `/api/projects/${pid}/history/${q}`, undefined, viewerCookie)).status, q).toBe(
      400,
    );
  }
  expect((await call('GET', `/api/projects/${pid}/history/8?from=2`, undefined, viewerCookie)).status).toBe(
    404,
  );

  // /steps：倒序单步，组内被删的 tmp 列名精确解析
  const sRes = await call('GET', `/api/projects/${pid}/history/5/steps?from=1`, undefined, viewerCookie);
  expect(sRes.status).toBe(200);
  const steps = sRes.data as CanvasHistorySteps;
  expect(steps.currentSeq).toBe(7);
  expect(steps.steps.map((e) => [e.seq, e.seqFrom, e.stepCount, e.opName])).toEqual([
    [5, 5, 1, 'dropColumn'],
    [4, 4, 1, 'addColumn'],
    [3, 3, 1, 'addColumn'],
    [2, 2, 1, 'addColumn'],
    [1, 1, 1, 'createTable'],
  ]);
  expect(steps.steps[0]!.summary).toEqual(['orders.tmp']);
  expect(steps.steps[1]!.summary).toEqual(['orders.tmp']);
  expect(steps.steps.every((e) => e.ops === undefined)).toBe(true);
  for (const q of ['5/steps', '5/steps?from=0', '5/steps?from=6', '0/steps?from=0', '60/steps?from=1']) {
    expect((await call('GET', `/api/projects/${pid}/history/${q}`, undefined, viewerCookie)).status, q).toBe(
      400,
    );
  }
  expect(
    (await call('GET', `/api/projects/${pid}/history/8/steps?from=6`, undefined, viewerCookie)).status,
  ).toBe(404);
  expect(
    (await call('GET', `/api/projects/${pid}/history/5/steps?from=1`, undefined, outsiderCookie)).status,
  ).toBe(404);

  // 恢复到组内中间单步 #3：生成独立的 restoreHistory（system）记录
  const r1 = await call('POST', `/api/projects/${pid}/history/3/restore`, { workingSeq: 7 }, editorCookie);
  expect(r1.status).toBe(200);
  expect((r1.data as ModelUpdate).seq).toBe(8);
  expect(
    all((await rooms.model(branchId)).model, 'column')
      .map((c) => c.name)
      .sort(),
  ).toEqual(['id', 'total']);

  // 恢复后新的手工编辑另起一组，不跨 restoreHistory 合并
  const tabC = await peerOf('editor');
  await rooms.join(branchId, tabC);
  await rooms.message(branchId, tabC, { t: 'hello', client: 'tab-c', lastSeq: 8 });
  await sendOp(tabC, 'tab-c', 1, 'setComment', { id: ordersId, comment: '恢复后' });
  await sendOp(tabC, 'tab-c', 2, 'setComment', { id: ordersId, comment: '恢复后 2' });
  await rooms.leave(branchId, tabC);
  expect(rangesOf(await listOf(''))).toEqual([
    [9, 10],
    [8, 8],
    [6, 7],
    [1, 5],
    [0, 0],
  ]);

  // 再恢复到组尾 #5
  const r2 = await call('POST', `/api/projects/${pid}/history/5/restore`, { workingSeq: 10 }, editorCookie);
  expect(r2.status).toBe(200);
  expect((r2.data as ModelUpdate).seq).toBe(11);
  const after = await listOf('');
  expect(after.entries[0]).toMatchObject({
    seq: 11,
    seqFrom: 11,
    stepCount: 1,
    opName: 'restoreHistory',
    isCurrent: true,
  });
  expect(rangesOf(after).slice(1)).toEqual([
    [9, 10],
    [8, 8],
    [6, 7],
    [1, 5],
    [0, 0],
  ]);
});

test('MCP batch 与人类单步相邻时互不合并', async () => {
  const peer = await peerOf('editor');
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'c1', lastSeq: 0 });
  const publicId = all((await rooms.model(branchId)).model, 'schema').find((s) => s.name === 'public')!.id;
  const t1 = newId();
  await sendOp(peer, 'c1', 1, 'createTable', { id: t1, schema: publicId, name: 'a' });
  const res = await rooms.applyMcpOps(branchId, {
    userId: peer.user.id,
    tokenId: 'tok-mix',
    user: peer.user.name,
    baseSeq: 1,
    ops: [{ name: 'setComment', args: { id: t1, comment: 'x' } }],
  });
  expect(res).toMatchObject({ ok: true, seq: 2 });
  await rooms.message(branchId, peer, { t: 'hello', client: 'c1', lastSeq: 2 });
  await sendOp(peer, 'c1', 2, 'renameTable', { id: t1, name: 'b' });
  await sendOp(peer, 'c1', 3, 'setComment', { id: t1, comment: 'y' });
  await rooms.leave(branchId, peer);

  const l = await listOf('');
  expect(l.entries.map((e) => [e.seqFrom, e.seq, e.opName, e.stepCount])).toEqual([
    [3, 4, 'editSession', 2],
    [2, 2, 'batch', 1],
    [1, 1, 'createTable', 1],
    [0, 0, 'init', 0],
  ]);
  expect(l.entries[1]).toMatchObject({ via: 'mcp' });
  expect(l.entries[1]!.ops).toBeUndefined();
});
