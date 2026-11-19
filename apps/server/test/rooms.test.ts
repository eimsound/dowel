// 房间的“踢人”语义：角色 / 状态在 join 之后变了（refreshLoaded）或被停用时，
// 遗留连接上的消息一律丢弃；join 时也要再确认一次账号状态和生效角色。
import { all, type Model, readsOf } from '@dowel/core';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { User } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import type { Peer, Rooms } from '../src/rooms.ts';
import { makeUser, PASSWORD } from './support.ts';

let db: PlatformDb;
let app: ReturnType<typeof createApp>['app'];
let rooms: Rooms;
let close: () => Promise<void>;
let branchId: string;
let branch2: string;
let model: Model;
let schemaId: string;
let member: User;
let watcher: User;
let removed: User;
let pid: string;
let groupId: string;

beforeAll(async () => {
  db = await openPlatformDb(':memory:');
  const created = createApp(db);
  app = created.app;
  rooms = created.rooms;
  close = async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
  };

  member = await makeUser(db, 'member', { name: '张三' });
  watcher = await makeUser(db, 'watcher', { name: '李四' });
  removed = await makeUser(db, 'removed', { name: '被移除' });

  const login = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  // 项目必须属于一个组：先建组，再在这个组建项目
  const groupRes = await app.request('/api/groups', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'rooms', name: '房间测试组' }),
  });
  groupId = ((await groupRes.json()) as { id: string }).id;
  const res = await app.request('/api/projects', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '房间测试', groupId }),
  });
  pid = ((await res.json()) as { id: string }).id;
  const [b] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
  branchId = b!.id;
  model = (await rooms.state(branchId)).model;
  schemaId = all(model, 'schema')[0]!.id;

  // 组员：李四通过组默认权限（编辑者）能看到项目；被移除的用户也一样
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member')", [
    groupId,
    watcher.id,
  ]);
  await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member')", [
    groupId,
    removed.id,
  ]);

  // 第二个分支，用来验证刷新不会给“没人被踢”的房间广播
  branch2 = `${branchId}-b2`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'other')", [branch2, pid]);
  await rooms.init(branch2, model);
});

afterAll(async () => {
  await close();
});

const peerOf = (user: User) => {
  const sent: unknown[] = [];
  let closedCode: number | null = null;
  const peer: Peer = {
    user,
    role: 'editor',
    send: (m) => sent.push(m),
    close: (code) => {
      closedCode = code;
    },
  };
  return { peer, sent, closed: () => closedCode };
};

let seq = 0;
const nextOp = () => {
  const n = ++seq;
  const args = { id: `t${n}`, schema: schemaId, name: `t${n}` };
  const reads = readsOf(model, args).map((id) => [id, 0] as [string, number]);
  return { t: 'op' as const, op: { client: 'c1', n, name: 'createTable', args, reads } };
};

const commits = () =>
  db.query<{ seq: number }>('select seq from room_commits where branch_id = $1', [branchId]);

test('被移出组之后，遗留连接的消息被丢弃（不提交、不广播）', async () => {
  const { peer, sent, closed } = peerOf(removed);
  await rooms.join(branchId, peer);
  await rooms.message(branchId, peer, { t: 'hello', client: 'c1', lastSeq: 0 });
  // 正常通道先确认能用：一条修改会写进操作日志
  await rooms.message(branchId, peer, nextOp());
  expect(await commits()).toHaveLength(1);
  expect(sent.some((m) => (m as { t: string }).t === 'welcome')).toBe(true);

  // 移出组：组默认权限没有了，也没有别的授权 → 生效角色为空
  await db.query('delete from group_members where group_id = $1 and user_id = $2', [groupId, removed.id]);
  await rooms.refreshLoaded();
  expect(closed()).toBe(4403);

  // 同一个 peer 继续发消息：hello、修改都不会被处理
  const before = sent.length;
  await rooms.message(branchId, peer, { t: 'hello', client: 'c1', lastSeq: 0 });
  await rooms.message(branchId, peer, nextOp());
  expect(await commits()).toHaveLength(1);
  expect(sent.length).toBe(before);
});

test('升级之后被停用：join 时再确认一次状态，直接关掉', async () => {
  const disabled = await makeUser(db, 'disabled', { name: '已停用' });
  await db.query("update users set status = 'disabled' where id = $1", [disabled.id]);

  const { peer, sent, closed } = peerOf(disabled);
  await rooms.join(branchId, peer);
  expect(closed()).toBe(4403);
  expect(sent).toHaveLength(0); // 连布局都不发

  await rooms.message(branchId, peer, nextOp());
  expect(await commits()).toHaveLength(1);
});

test('join 时重新计算生效角色：没有权限的直接关掉', async () => {
  const outsider = await makeUser(db, 'outsider', { name: '组外' });
  const { peer, sent, closed } = peerOf(outsider);
  await rooms.join(branchId, peer);
  expect(closed()).toBe(4403);
  expect(sent).toHaveLength(0);
});

test('join 成功时总会发 role，并把升级时算到的过期角色校正过来', async () => {
  const { peer, sent } = peerOf(member);
  peer.role = 'viewer'; // 升级时算到的旧角色
  await rooms.join(branchId, peer);
  expect(sent[0]).toEqual({ t: 'role', role: 'admin' });
  expect(peer.role).toBe('admin');
});

test('refreshLoaded 只给真正踢掉了人的房间广播在线列表', async () => {
  const a = peerOf(member);
  const b = peerOf(watcher);
  const c = peerOf(watcher);
  await rooms.join(branchId, a.peer);
  await rooms.join(branchId, b.peer);
  await rooms.join(branch2, c.peer);
  const beforeB = b.sent.length;
  const beforeC = c.sent.length;

  // 把张三从组里移除并删掉他在项目上的授权：他没有任何生效角色了，李四不受影响
  await db.query('delete from group_members where group_id = $1 and user_id = $2', [groupId, member.id]);
  await db.query(
    "delete from grants where scope_kind = 'project' and scope_id = $1 and subject_kind = 'user' and subject_id = $2",
    [pid, member.id],
  );
  await rooms.refreshLoaded();

  expect(a.closed()).toBe(4403);
  // 同一个房间里剩下的人收到新的在线列表
  expect(b.sent.length).toBeGreaterThan(beforeB);
  expect((b.sent.at(-1) as { t: string }).t).toBe('peers');
  // 另一个房间没人被踢：什么都不发
  expect(c.sent.length).toBe(beforeC);
});
