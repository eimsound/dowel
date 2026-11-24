// 房间的“踢人”语义：角色 / 状态在 join 之后变了（refreshLoaded）或被停用时，
// 遗留连接上的消息一律丢弃；join 时也要再确认一次账号状态和生效角色。
import { all, emptyModel, type Model, readsOf } from '@dowel/core';
import { type Commit, SyncClient, type ToClient } from '@dowel/sync';
import { afterAll, beforeAll, expect, test } from 'vitest';

import type { User } from '../src/auth.ts';
import {
  type ClusterEvent,
  type ClusterEventHandler,
  type ClusterEventPayload,
  type EventBus,
  MAX_EVENT_BYTES,
  type ReconnectHandler,
  truncateRoomPeersForEvent,
} from '../src/bus.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { effectiveProjectRole } from '../src/roles.ts';
import { type Peer, Rooms, SNAPSHOT_EVERY } from '../src/rooms.ts';
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

test('只读 viewer 冒用 editor 的 client 抢发 op：被拒绝且不推进 editor 的 processed，editor 后续同序号 op 正常生效', async () => {
  const editorUser = await makeUser(db, 'sec-editor', { name: '编辑者' });
  const viewerUser = await makeUser(db, 'sec-viewer', { name: '只读者' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-sec-editor', pid, editorUser.id],
  );
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'viewer')",
    ['g-sec-viewer', pid, viewerUser.id],
  );

  const branchSec = `${branchId}-sec-viewer`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'sec-viewer')", [
    branchSec,
    pid,
  ]);
  await rooms.init(branchSec, model);

  const editor = peerOf(editorUser);
  const viewer = peerOf(viewerUser);
  await rooms.join(branchSec, editor.peer);
  await rooms.join(branchSec, viewer.peer);
  expect(viewer.peer.role).toBe('viewer');

  const victimClient = 'tab-victim-1';
  await rooms.message(branchSec, editor.peer, { t: 'hello', client: victimClient, lastSeq: 0 });
  // editor 先提交 n=1
  await rooms.message(branchSec, editor.peer, {
    t: 'op',
    op: {
      client: victimClient,
      n: 1,
      name: 'createTable',
      args: { id: 'tv_1', schema: schemaId, name: 'v_first' },
      reads: [[schemaId, 0]],
    },
  });

  // viewer 冒用同一个 client 握手并抢先发送 n=2
  await rooms.message(branchSec, viewer.peer, { t: 'hello', client: victimClient, lastSeq: 0 });
  const viewerWelcome = viewer.sent.find((m) => (m as { t: string }).t === 'welcome') as {
    t: 'welcome';
    lastProcessed: number;
    rejected: unknown[];
  };
  // viewer 拿不到 editor 的 lastProcessed=1
  expect(viewerWelcome.lastProcessed).toBe(0);

  await rooms.message(branchSec, viewer.peer, {
    t: 'op',
    op: {
      client: victimClient,
      n: 2,
      name: 'createTable',
      args: { id: 'tv_spoof', schema: schemaId, name: 'spoofed' },
      reads: [[schemaId, 0]],
    },
  });
  expect(
    viewer.sent.some((m) => {
      const msg = m as { t: string; n?: number; code?: string };
      return msg.t === 'reject' && msg.n === 2 && msg.code === 'invalid';
    }),
  ).toBe(true);
  // room_rejections 不应落库
  const rejRows = await db.query<{ client: string }>(
    'select client from room_rejections where branch_id = $1',
    [branchSec],
  );
  expect(rejRows).toHaveLength(0);

  // editor 随后提交合法 n=2，不能被静默丢弃
  await rooms.message(branchSec, editor.peer, {
    t: 'op',
    op: {
      client: victimClient,
      n: 2,
      name: 'createTable',
      args: { id: 'tv_2', schema: schemaId, name: 'v_second' },
      reads: [[schemaId, 0]],
    },
  });
  const latest = await rooms.model(branchSec);
  expect(
    all(latest.model, 'table')
      .map((t) => t.name)
      .sort(),
  ).toEqual(['v_first', 'v_second']);
});

test('同项目另一名 editor 冒用受害者 client：不窃取 lastProcessed/rejected，不静默丢弃受害者编辑，且 SyncClient 确认互不干扰', async () => {
  const victimUser = await makeUser(db, 'sec-victim', { name: '受害者' });
  const attackerUser = await makeUser(db, 'sec-attacker', { name: '攻击者' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-sec-victim', pid, victimUser.id],
  );
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-sec-attacker', pid, attackerUser.id],
  );

  const branchSpoof = `${branchId}-sec-spoof`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'sec-spoof')", [
    branchSpoof,
    pid,
  ]);
  await rooms.init(branchSpoof, model);

  const sharedClientId = 'tab-shared-id';
  const victimClient = new SyncClient(sharedClientId, emptyModel());
  const victimPeer = peerOf(victimUser);
  const attackerPeer = peerOf(attackerUser);

  const origVictimSend = victimPeer.peer.send.bind(victimPeer.peer);
  victimPeer.peer.send = (m) => {
    origVictimSend(m);
    if (m.t === 'welcome' || m.t === 'snapshot' || m.t === 'commit' || m.t === 'reject') {
      victimClient.receive(m as ToClient);
    }
  };
  let victimChain = Promise.resolve();
  victimClient.send = (m) => {
    victimChain = victimChain.then(() => rooms.message(branchSpoof, victimPeer.peer, m));
  };

  await rooms.join(branchSpoof, victimPeer.peer);
  await rooms.join(branchSpoof, attackerPeer.peer);

  victimClient.connect();
  await victimChain;
  expect(victimClient.ready).toBe(true);

  // 受害者连续发出两条带依赖关系的 op（测试 p:<client>:<n> 改写）
  victimClient.mutate('createTable', { id: 'ts_1', schema: schemaId, name: 'victim_tbl' });
  victimClient.mutate('addColumn', {
    table: 'ts_1',
    column: { id: 'cs_1', name: 'title', type: 'text' },
  });
  await victimChain;
  expect(victimClient.pending).toHaveLength(0);

  // 受害者产生一条被拒绝的 op（n=3，过期版本触发冲突），以便检验攻击者无法窃取 rejected
  await rooms.message(branchSpoof, victimPeer.peer, {
    t: 'op',
    op: {
      client: sharedClientId,
      n: 3,
      name: 'renameTable',
      args: { id: 'ts_1', name: 'stale_name' },
      reads: [['ts_1', 0]],
    },
  });

  // 攻击者用相同 client ID 握手：必须看到自己的 lastProcessed=0、rejected=[]
  await rooms.message(branchSpoof, attackerPeer.peer, {
    t: 'hello',
    client: sharedClientId,
    lastSeq: 0,
  });
  const attackerWelcome = attackerPeer.sent.find((m) => (m as { t: string }).t === 'welcome') as {
    t: 'welcome';
    lastProcessed: number;
    rejected: unknown[];
  };
  expect(attackerWelcome).toEqual({ t: 'welcome', lastProcessed: 0, rejected: [] });

  // 攻击者抢发多条 op（覆盖 n=1..4），企图推高受害者的 processed
  for (let n = 1; n <= 4; n++) {
    await rooms.message(branchSpoof, attackerPeer.peer, {
      t: 'op',
      op: {
        client: sharedClientId,
        n,
        name: 'createTable',
        args: { id: `ta_${n}`, schema: schemaId, name: `attacker_${n}` },
        reads: [[schemaId, 0]],
      },
    });
  }

  // 受害者收到的攻击者 commit 的 client 不能等于 sharedClientId，避免污染 pending
  const attackerCommitsOnVictim = victimPeer.sent.filter(
    (m): m is Commit => (m as { t: string }).t === 'commit' && (m as Commit).user === '攻击者',
  );
  expect(attackerCommitsOnVictim.length).toBe(4);
  for (const c of attackerCommitsOnVictim) expect(c.client).not.toBe(sharedClientId);

  // 受害者继续提交 n=4，正常提交生效（没有被攻击者的 n=4 静默丢弃）
  await rooms.message(branchSpoof, victimPeer.peer, {
    t: 'op',
    op: {
      client: sharedClientId,
      n: 4,
      name: 'addColumn',
      args: { table: 'ts_1', column: { id: 'cs_2', name: 'after_attack', type: 'text' } },
      reads: [['ts_1', 1]],
    },
  });
  const latest = await rooms.model(branchSpoof);
  expect(
    all(latest.model, 'column')
      .map((c) => c.name)
      .sort(),
  ).toEqual(['after_attack', 'title']);

  // 同用户带相同 client 重连时踢掉旧连接，且保留自己的 lastProcessed=4
  const victimReconn = peerOf(victimUser);
  await rooms.join(branchSpoof, victimReconn.peer);
  await rooms.message(branchSpoof, victimReconn.peer, {
    t: 'hello',
    client: sharedClientId,
    lastSeq: 0,
  });
  expect(victimPeer.closed()).toBe(4409);
  const reconnWelcome = victimReconn.sent.find((m) => (m as { t: string }).t === 'welcome') as {
    t: 'welcome';
    lastProcessed: number;
    rejected: { n: number }[];
  };
  expect(reconnWelcome.lastProcessed).toBe(4);
  expect(reconnWelcome.rejected.map((r) => r.n)).toEqual([3]);
});

test('禁止保留标识 system 与非法 client，无法干扰 replace / patch', async () => {
  const user = await makeUser(db, 'sec-sys', { name: '系统测试' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-sec-sys', pid, user.id],
  );
  const branchSys = `${branchId}-sec-sys`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'sec-sys')", [branchSys, pid]);
  await rooms.init(branchSys, model);

  for (const badClient of ['system', 'SYSTEM', '', 'a'.repeat(129), 'a:b', 'bad\nclient']) {
    const p = peerOf(user);
    await rooms.join(branchSys, p.peer);
    await rooms.message(branchSys, p.peer, { t: 'hello', client: badClient, lastSeq: 0 });
    expect(p.closed()).toBe(4400);
    expect(p.sent.some((m) => (m as { t: string }).t === 'welcome')).toBe(false);
    // 后续 op 也被丢弃
    await rooms.message(branchSys, p.peer, {
      t: 'op',
      op: {
        client: badClient,
        n: 1,
        name: 'createTable',
        args: { id: 't_sys_spoof', schema: schemaId, name: 'sys_spoof' },
        reads: [[schemaId, 0]],
      },
    });
  }

  expect((await rooms.model(branchSys)).seq).toBe(0);
  // 系统 replace 仍正常工作
  await rooms.replace(branchSys, '系统测试', model, 'replaceModel', 0);
  expect((await rooms.model(branchSys)).seq).toBe(1);
});

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('实例管理员在升级与 join 之间被降级为普通 member：join 按最新 users.role 拒绝或降级', async () => {
  // 1. 无项目授权的实例管理员被降级为 member 后，join 必须按最新 users.role 拒绝（4403）
  const demoted = await makeUser(db, 'demoted-admin', { name: '前管理员', role: 'admin' });
  const stalePeer = peerOf(demoted);
  stalePeer.peer.role = 'admin'; // 升级瞬间快照仍是 admin

  await db.query("update users set role = 'member' where id = $1", [demoted.id]);
  await rooms.join(branchId, stalePeer.peer);

  expect(stalePeer.closed()).toBe(4403);
  expect(stalePeer.sent).toHaveLength(0);
  expect(stalePeer.peer.user.role).toBe('member');
  // 拒绝后的连接继续发 op 必须被丢弃
  const commitsBefore = (await commits()).length;
  await rooms.message(branchId, stalePeer.peer, nextOp());
  expect((await commits()).length).toBe(commitsBefore);

  // 2. 若被降级的管理员仍拥有项目 viewer 授权，join 按最新 users.role 降级为 viewer（而非沿用 admin）
  const demotedViewer = await makeUser(db, 'demoted-admin-viewer', { name: '降级只读', role: 'admin' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'viewer')",
    ['g-demoted-viewer', pid, demotedViewer.id],
  );
  const viewerPeer = peerOf(demotedViewer);
  viewerPeer.peer.role = 'admin';

  await db.query("update users set role = 'member' where id = $1", [demotedViewer.id]);
  await rooms.join(branchId, viewerPeer.peer);

  expect(viewerPeer.closed()).toBeNull();
  expect(viewerPeer.peer.user.role).toBe('member');
  expect(viewerPeer.peer.role).toBe('viewer');
  expect(viewerPeer.sent[0]).toEqual({ t: 'role', role: 'viewer' });
});

test('编辑者 join 在 resolveRole 挂起期间被降级并 refreshLoaded：最终收敛为 viewer 且不能发 op', async () => {
  const raceUser = await makeUser(db, 'race-join-editor', { name: '竞态编辑者' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-race-join', pid, raceUser.id],
  );
  const branchRace = `${branchId}-race-join`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'race-join')", [
    branchRace,
    pid,
  ]);
  await rooms.init(branchRace, model);

  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const raceRooms = new Rooms(db, async (user, projectId, lookup) => {
    const idx = ++calls;
    const role = await effectiveProjectRole(db, user, projectId, lookup);
    if (idx === 1) {
      // 第一次（join）已查出旧的 editor，随后挂起
      entered.resolve();
      await release.promise;
    }
    return role;
  });

  const p = peerOf(raceUser);
  const joinPromise = raceRooms.join(branchRace, p.peer);
  await entered.promise;

  // join 挂起期间降级为 viewer 并触发刷新
  await db.query("update grants set role = 'viewer' where id = 'g-race-join'");
  await raceRooms.refreshLoaded();
  expect(p.peer.role).toBe('viewer');

  // 放行旧的 join resolveRole（其返回值为过期的 editor），绝不能覆盖回 editor
  release.resolve();
  await joinPromise;

  expect(p.closed()).toBeNull();
  expect(p.peer.role).toBe('viewer');
  const roleMsgs = p.sent.filter((m): m is { t: 'role'; role: string } => (m as { t: string }).t === 'role');
  expect(roleMsgs.length).toBeGreaterThan(0);
  expect(roleMsgs.every((m) => m.role === 'viewer')).toBe(true);
  expect(p.sent.some((m) => (m as { t: string }).t === 'layout')).toBe(true);

  // 作为 viewer 发 op 必须被拒绝，不能修改模型
  await raceRooms.message(branchRace, p.peer, { t: 'hello', client: 'c-race', lastSeq: 0 });
  await raceRooms.message(branchRace, p.peer, {
    t: 'op',
    op: {
      client: 'c-race',
      n: 1,
      name: 'createTable',
      args: { id: 't_race_denied', schema: schemaId, name: 'race_denied' },
      reads: [[schemaId, 0]],
    },
  });
  expect(
    p.sent.some((m) => {
      const msg = m as { t: string; code?: string };
      return msg.t === 'reject' && msg.code === 'invalid';
    }),
  ).toBe(true);
  expect((await raceRooms.model(branchRace)).seq).toBe(0);
  await raceRooms.flush();
});

test('join 挂起期间被 kickUserLocal 踢出：恢复后直接中止，不留连接也不发消息', async () => {
  const kickUser = await makeUser(db, 'race-join-kick', { name: '入房被踢' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-race-kick', pid, kickUser.id],
  );
  const branchKick = `${branchId}-race-kick`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'race-kick')", [
    branchKick,
    pid,
  ]);
  await rooms.init(branchKick, model);

  const entered = deferred();
  const release = deferred();
  const raceRooms = new Rooms(db, async (user, projectId, lookup) => {
    const role = await effectiveProjectRole(db, user, projectId, lookup);
    entered.resolve();
    await release.promise;
    return role;
  });

  const sent: unknown[] = [];
  const closes: number[] = [];
  const peer: Peer = {
    user: kickUser,
    role: 'editor',
    send: (m) => sent.push(m),
    close: (code) => closes.push(code),
  };

  const joinPromise = raceRooms.join(branchKick, peer);
  await entered.promise;

  // join 挂起期间停用并踢出该用户
  await db.query("update users set status = 'disabled' where id = $1", [kickUser.id]);
  await raceRooms.kickUserLocal(kickUser.id, '账号已被停用');
  expect(closes).toEqual([4403]);

  release.resolve();
  await joinPromise;

  // 绝不能再发 role / layout，也不能重复 close 或把连接留在房间里
  expect(sent).toHaveLength(0);
  expect(closes).toEqual([4403]);
  await raceRooms.message(branchKick, peer, { t: 'hello', client: 'c-kicked', lastSeq: 0 });
  await raceRooms.message(branchKick, peer, {
    t: 'op',
    op: {
      client: 'c-kicked',
      n: 1,
      name: 'createTable',
      args: { id: 't_kick_denied', schema: schemaId, name: 'kick_denied' },
      reads: [[schemaId, 0]],
    },
  });
  expect(sent).toHaveLength(0);
  expect((await raceRooms.model(branchKick)).seq).toBe(0);
  await raceRooms.flush();
});

test('连续并发 refreshLoaded（先升级后降级 & 先降级后升级合并重跑）：串行收敛到最新角色，不被慢查询倒挂覆盖', async () => {
  const user = await makeUser(db, 'race-refresh-user', { name: '并发刷新用户' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'viewer')",
    ['g-race-refresh', pid, user.id],
  );
  const branchRefresh = `${branchId}-race-refresh`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'race-refresh')", [
    branchRefresh,
    pid,
  ]);
  await rooms.init(branchRefresh, model);

  let blockNext = false;
  let entered = deferred();
  let release = deferred();
  let resolveCalls = 0;

  const raceRooms = new Rooms(db, async (u, projectId, lookup) => {
    resolveCalls += 1;
    const role = await effectiveProjectRole(db, u, projectId, lookup);
    if (blockNext) {
      blockNext = false;
      entered.resolve();
      await release.promise;
    }
    return role;
  });

  const p = peerOf(user);
  await raceRooms.join(branchRefresh, p.peer);
  expect(p.peer.role).toBe('viewer');

  // 场景 1：先升级到 editor（慢查询挂起），期间降级回 viewer 并再次触发 refreshLoaded
  resolveCalls = 0;
  blockNext = true;
  entered = deferred();
  release = deferred();

  await db.query("update grants set role = 'editor' where id = 'g-race-refresh'");
  const firstRefresh = raceRooms.refreshLoaded();
  await entered.promise;
  expect(resolveCalls).toBe(1);

  await db.query("update grants set role = 'viewer' where id = 'g-race-refresh'");
  const secondRefresh = raceRooms.refreshLoaded();
  // 单飞互斥：第一轮未结束前第二轮不会并发进入 resolveRole
  await Promise.resolve();
  expect(resolveCalls).toBe(1);

  release.resolve();
  await Promise.all([firstRefresh, secondRefresh]);

  expect(resolveCalls).toBe(2);
  expect(p.peer.role).toBe('viewer');
  const lastRole1 = [...p.sent]
    .reverse()
    .find((m): m is { t: 'role'; role: string } => (m as { t: string }).t === 'role');
  expect(lastRole1?.role).toBe('viewer');

  // 场景 2：先降级/变更（慢查询挂起），期间连续到来定向与全量两次刷新（合并为下一轮单次重跑），最终收敛到 admin
  await db.query("update grants set role = 'editor' where id = 'g-race-refresh'");
  await raceRooms.refreshLoaded();
  expect(p.peer.role).toBe('editor');

  resolveCalls = 0;
  blockNext = true;
  entered = deferred();
  release = deferred();

  await db.query("update grants set role = 'viewer' where id = 'g-race-refresh'");
  const r1 = raceRooms.refreshLoaded([branchRefresh]);
  await entered.promise;

  await db.query("update grants set role = 'admin' where id = 'g-race-refresh'");
  const r2 = raceRooms.refreshLoaded([branchRefresh]);
  const r3 = raceRooms.refreshLoaded();
  await Promise.resolve();
  expect(resolveCalls).toBe(1);

  release.resolve();
  await Promise.all([r1, r2, r3]);

  // r2 与 r3 被合并成同一轮重跑，总计只执行 2 轮，最终收敛为 admin
  expect(resolveCalls).toBe(2);
  expect(p.peer.role).toBe('admin');
  const lastRole2 = [...p.sent]
    .reverse()
    .find((m): m is { t: 'role'; role: string } => (m as { t: string }).t === 'role');
  expect(lastRole2?.role).toBe('admin');

  await raceRooms.flush();
});

const makeFakeBus = (replicaId: string) => {
  const eventHandlers = new Set<ClusterEventHandler>();
  const reconnectHandlers = new Set<ReconnectHandler>();
  const published: ClusterEventPayload[] = [];
  let publishHook: ((event: ClusterEventPayload) => Promise<void> | void) | null = null;

  const bus = {
    replicaId,
    channel: 'test_events',
    onEvent: (handler: ClusterEventHandler) => {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onReconnect: (handler: ReconnectHandler) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    },
    publish: async (event: ClusterEventPayload) => {
      published.push(event);
      if (publishHook) await publishHook(event);
    },
  } as unknown as EventBus;

  const emit = async (event: ClusterEvent) => {
    for (const h of [...eventHandlers]) {
      await h(event);
    }
  };

  const triggerReconnect = async () => {
    for (const h of [...reconnectHandlers]) {
      await h();
    }
  };

  const setPublishHook = (fn: ((event: ClusterEventPayload) => Promise<void> | void) | null) => {
    publishHook = fn;
  };

  return { bus, published, emit, triggerReconnect, setPublishHook };
};

test('远端 room.layout 清理本地 pendingLayout 冲突键；flush() 既覆盖 publish 挂起窗口也等待在途 flushLayout 完成', async () => {
  const u = await makeUser(db, 'layout-unit-user', { name: '布局单测' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-layout-unit', pid, u.id],
  );
  const branchLayout = `${branchId}-layout-unit`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'layout-unit')", [
    branchLayout,
    pid,
  ]);
  await rooms.init(branchLayout, model);

  const fake = makeFakeBus('replica-local');
  const testRooms = new Rooms(
    db,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    fake.bus,
  );
  try {
    const p = peerOf(u);
    await testRooms.join(branchLayout, p.peer);
    await testRooms.message(branchLayout, p.peer, { t: 'hello', client: 'c-layout', lastSeq: 0 });

    // 1. publish 挂起窗口内调用 flush()，不能漏刷 pendingLayout
    const pubEntered = deferred();
    const pubRelease = deferred();
    fake.setPublishHook(async (ev) => {
      if (ev.t === 'room.layout') {
        pubEntered.resolve();
        await pubRelease.promise;
      }
    });
    const msgPromise = testRooms.message(branchLayout, p.peer, {
      t: 'layout',
      positions: { tbl_win: { x: 11, y: 22 } },
    });
    await pubEntered.promise;
    await testRooms.flush();
    const [rowWin] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchLayout],
    );
    expect(rowWin?.layout.tbl_win).toEqual({ x: 11, y: 22 });
    pubRelease.resolve();
    await msgPromise;
    fake.setPublishHook(null);

    // 2. 本地拖动 tbl_1=(10,10)、tbl_2=(20,20) 处于防抖期，远端广播 tbl_1=(99,99) 必须清掉本地 tbl_1 的 pendingLayout
    await testRooms.message(branchLayout, p.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 10, y: 10 }, tbl_2: { x: 20, y: 20 } },
    });
    await fake.emit({
      t: 'room.layout',
      origin: 'replica-remote',
      branchId: branchLayout,
      positions: { tbl_1: { x: 99, y: 99 } },
    });
    await testRooms.flush();
    const [rowConflict] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchLayout],
    );
    expect(rowConflict?.layout.tbl_1).toEqual({ x: 99, y: 99 });
    expect(rowConflict?.layout.tbl_2).toEqual({ x: 20, y: 20 });

    // 3. 在途 flushLayout 进行期间，flush() 必须等待 SQL 完成，且期间新写入的坐标不会被旧快照误删
    const sqlEntered = deferred();
    const sqlRelease = deferred();
    let intercepted = false;
    const origQuery = db.query.bind(db);
    db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!intercepted && sql.includes('update branches set layout')) {
        intercepted = true;
        sqlEntered.resolve();
        await sqlRelease.promise;
      }
      return origQuery<T>(sql, params);
    }) as typeof db.query;

    try {
      await testRooms.message(branchLayout, p.peer, {
        t: 'layout',
        positions: { tbl_fly: { x: 1, y: 2 } },
      });
      // 先手动触发一次 flush 进入在途 SQL，并在 SQL 挂起期间再写入新坐标、同时发起第二次 flush()
      const firstFlush = testRooms.flush();
      await sqlEntered.promise;

      await testRooms.message(branchLayout, p.peer, {
        t: 'layout',
        positions: { tbl_fly: { x: 33, y: 44 } },
      });
      let secondDone = false;
      const secondFlush = testRooms.flush().then(() => {
        secondDone = true;
      });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
      expect(secondDone).toBe(false);

      sqlRelease.resolve();
      await Promise.all([firstFlush, secondFlush]);
      expect(secondDone).toBe(true);
    } finally {
      db.query = origQuery;
    }

    const [rowFinal] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchLayout],
    );
    expect(rowFinal?.layout.tbl_fly).toEqual({ x: 33, y: 44 });
  } finally {
    testRooms.close();
    await testRooms.flush();
  }
});

test('超大 layout（200 张表）立即落库并改发 room.layout.reload，超大 room.peers 自动截断且 HA 离线副本清理生效', async () => {
  const u = await makeUser(db, 'layout-big-user', { name: '大画布用户' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-layout-big', pid, u.id],
  );
  const branchBig = `${branchId}-layout-big`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'layout-big')", [
    branchBig,
    pid,
  ]);
  await rooms.init(branchBig, model);

  const aliveSet = new Set(['replica-a', 'replica-b']);
  const fakeA = makeFakeBus('replica-a');
  const fakeB = makeFakeBus('replica-b');
  const roomsA = new Rooms(
    db,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    fakeA.bus,
    { replicaId: 'replica-a', aliveNodes: async () => new Set(aliveSet) },
  );
  const roomsB = new Rooms(
    db,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    fakeB.bus,
    { replicaId: 'replica-b', aliveNodes: async () => new Set(aliveSet) },
  );

  try {
    const peerA = peerOf(u);
    const peerB = peerOf(u);
    await roomsA.join(branchBig, peerA.peer);
    await roomsB.join(branchBig, peerB.peer);
    await roomsA.message(branchBig, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await roomsB.message(branchBig, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 1. 200 张表自动布局（> 7500B）在副本 A 上立即落库并广播 room.layout.reload（而不是 room.layout）
    const bigPositions: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 200; i++) {
      bigPositions[`table_long_identifier_${String(i).padStart(4, '0')}`] = { x: i * 10, y: i * 20 };
    }
    expect(Buffer.byteLength(JSON.stringify(bigPositions), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);

    fakeA.published.length = 0;
    await roomsA.message(branchBig, peerA.peer, { t: 'layout', positions: bigPositions });
    expect(fakeA.published.some((e) => e.t === 'room.layout.reload' && e.branchId === branchBig)).toBe(true);
    expect(fakeA.published.some((e) => e.t === 'room.layout')).toBe(false);

    // 副本 B 收到 room.layout.reload 后从数据库读取并向本地 peerB 推送全部 200 张表
    await fakeB.emit({ t: 'room.layout.reload', origin: 'replica-a', branchId: branchBig });
    const lastLayoutB = [...peerB.sent]
      .reverse()
      .find(
        (m): m is { t: 'layout'; positions: Record<string, { x: number; y: number }> } =>
          (m as { t: string }).t === 'layout',
      );
    expect(Object.keys(lastLayoutB?.positions ?? {})).toHaveLength(200);
    expect(lastLayoutB?.positions.table_long_identifier_0199).toEqual({ x: 1990, y: 3980 });

    // 2. 跨副本 peers 同步与 HA 离线节点清理
    await fakeA.emit({
      t: 'room.peers',
      origin: 'replica-b',
      branchId: branchBig,
      peers: [{ client: 'c-b', user: '大画布用户' }],
    });
    const peersBeforeCrash = [...peerA.sent]
      .reverse()
      .find(
        (m): m is { t: 'peers'; peers: { client: string; user: string }[] } =>
          (m as { t: string }).t === 'peers',
      );
    expect(peersBeforeCrash?.peers.map((item) => item.client).sort()).toEqual(['c-a', 'c-b']);

    // 模拟 replica-b 租约过期离线
    aliveSet.delete('replica-b');
    await roomsA.pruneDeadRemotePeers();
    const peersAfterCrash = [...peerA.sent]
      .reverse()
      .find(
        (m): m is { t: 'peers'; peers: { client: string; user: string }[] } =>
          (m as { t: string }).t === 'peers',
      );
    expect(peersAfterCrash?.peers).toEqual([{ client: 'c-a', user: '大画布用户' }]);

    // 3. 超大 room.peers 截断保护（保证 JSON 字节严格 <= MAX_EVENT_BYTES）
    const manyPeers = Array.from({ length: 400 }, (_, i) => ({
      client: `tab-very-long-client-id-${String(i).padStart(4, '0')}`,
      user: `协作成员_${i}`,
    }));
    const { peers: kept, truncated } = truncateRoomPeersForEvent('replica-a', branchBig, manyPeers);
    expect(truncated).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(manyPeers.length);
    const bytes = Buffer.byteLength(
      JSON.stringify({ t: 'room.peers', origin: 'replica-a', branchId: branchBig, peers: kept }),
      'utf8',
    );
    expect(bytes).toBeLessThanOrEqual(MAX_EVENT_BYTES);
  } finally {
    roomsA.close();
    roomsB.close();
    await roomsA.flush();
    await roomsB.flush();
  }
});

test('catchUp 按游标增量拉取 room_rejections（不反复全表扫描历史拒绝），本地拒绝与脏重载后游标保持同步', async () => {
  const u = await makeUser(db, 'rej-cursor-user', { name: '游标测试' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-rej-cursor', pid, u.id],
  );
  const branchRej = `${branchId}-rej-cursor`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'rej-cursor')", [
    branchRej,
    pid,
  ]);
  await rooms.init(branchRej, model);

  // 预置 3 条历史拒绝记录，模拟加载前已有历史拒绝
  const scopedClient = `${u.id}:c-cursor`;
  for (let n = 1; n <= 3; n++) {
    await db.query(
      'insert into room_rejections (branch_id, client, n, code, message) values ($1, $2, $3, $4, $5)',
      [branchRej, scopedClient, n, 'conflict', `历史拒绝-${n}`],
    );
  }
  const existingRows = await db.query<{ id: number }>(
    'select id from room_rejections where branch_id = $1 order by id asc',
    [branchRej],
  );
  expect(existingRows).toHaveLength(3);
  const maxExistingId = Number(existingRows.at(-1)!.id);

  // 包装 db.transaction，记录每一次针对 room_rejections 的查询参数与返回行数
  const rejectionQueries: { sql: string; params: unknown[]; returned: number; readOnly?: boolean }[] = [];
  const wrappedDb: PlatformDb = {
    ...db,
    transaction: (fn, opts) =>
      db.transaction(async (tx) => {
        const tracedTx: typeof tx = {
          exec: (q) => tx.exec(q),
          query: async <T>(q: string, params?: unknown[]) => {
            const rows = await tx.query<T>(q, params);
            if (q.includes('from room_rejections')) {
              rejectionQueries.push({
                sql: q,
                params: params ? [...params] : [],
                returned: rows.length,
                readOnly: opts?.readOnly,
              });
            }
            return rows;
          },
        };
        return fn(tracedTx);
      }, opts),
  };

  const testRooms = new Rooms(wrappedDb, (user, projectId, lookup) =>
    effectiveProjectRole(db, user, projectId, lookup),
  );
  try {
    const p = peerOf(u);
    await testRooms.join(branchRej, p.peer);
    await testRooms.message(branchRej, p.peer, { t: 'hello', client: 'c-cursor', lastSeq: 0 });
    const welcome1 = p.sent.find((m) => (m as { t: string }).t === 'welcome') as {
      t: 'welcome';
      lastProcessed: number;
      rejected: { n: number }[];
    };
    expect(welcome1.lastProcessed).toBe(3);
    expect(welcome1.rejected.map((r) => r.n)).toEqual([1, 2, 3]);
    // 首次 loadRoom 在只读快照事务中读取了 3 条历史拒绝
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.readOnly).toBe(true);
    expect(rejectionQueries[0]!.returned).toBe(3);

    // 1. 无新增拒绝时调用 catchUp：仅按 id > maxExistingId 增量查询，返回 0 行
    rejectionQueries.length = 0;
    await testRooms.catchUp(branchRej);
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.sql).toContain('id > $2');
    expect(rejectionQueries[0]!.params).toEqual([branchRej, maxExistingId]);
    expect(rejectionQueries[0]!.returned).toBe(0);
    expect(rejectionQueries[0]!.readOnly).toBe(true);

    // 2. 外部新增 1 条拒绝记录（n=4）：catchUp 仅查回这 1 条并推进游标
    const [ins4] = await db.query<{ id: number }>(
      'insert into room_rejections (branch_id, client, n, code, message) values ($1, $2, 4, $3, $4) returning id',
      [branchRej, scopedClient, 'conflict', '外部拒绝-4'],
    );
    const id4 = Number(ins4!.id);
    rejectionQueries.length = 0;
    await testRooms.catchUp(branchRej);
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.params).toEqual([branchRej, maxExistingId]);
    expect(rejectionQueries[0]!.returned).toBe(1);

    // 再次 catchUp：游标已推进到 id4，返回 0 行
    rejectionQueries.length = 0;
    await testRooms.catchUp(branchRej);
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.params).toEqual([branchRej, id4]);
    expect(rejectionQueries[0]!.returned).toBe(0);

    // 3. 本地触发一次 op 拒绝（n=5，引用不存在的表触发 invalid）：通过 RETURNING id 同步推进游标，后续 catchUp 不重复回扫
    await testRooms.message(branchRej, p.peer, {
      t: 'op',
      op: {
        client: 'c-cursor',
        n: 5,
        name: 'renameTable',
        args: { id: 'nonexistent_table', name: 'x' },
        reads: [],
      },
    });
    const [row5] = await db.query<{ id: number }>(
      'select id from room_rejections where branch_id = $1 and client = $2 and n = 5',
      [branchRej, scopedClient],
    );
    const id5 = Number(row5!.id);
    expect(id5).toBeGreaterThan(id4);

    rejectionQueries.length = 0;
    await testRooms.catchUp(branchRej);
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.params).toEqual([branchRej, id5]);
    expect(rejectionQueries[0]!.returned).toBe(0);

    // 4. 事务回滚触发 reloadLocked 后游标重新对齐：模拟一次本地 op 写入后事务回滚，同时数据库写入新外部拒绝 n=6
    let failWriteOnce = true;
    const prevWrapTx = wrappedDb.transaction.bind(wrappedDb);
    wrappedDb.transaction = (async (fn, opts) =>
      prevWrapTx(async (tx) => {
        const res = await fn(tx);
        if (!opts?.readOnly && failWriteOnce) {
          failWriteOnce = false;
          throw new Error('模拟提交阶段回滚');
        }
        return res;
      }, opts)) as PlatformDb['transaction'];

    await expect(
      testRooms.message(branchRej, p.peer, {
        t: 'op',
        op: {
          client: 'c-cursor',
          n: 6,
          name: 'renameTable',
          args: { id: 'nonexistent_table', name: 'rollback_rej' },
          reads: [],
        },
      }),
    ).rejects.toThrow('模拟提交阶段回滚');
    wrappedDb.transaction = prevWrapTx;

    // 事务回滚后 reloadLocked 已重新对齐游标到 id5（n=6 未落库），随后 catchUp 仅查 id > id5 且返回 0 行
    rejectionQueries.length = 0;
    await testRooms.catchUp(branchRej);
    expect(rejectionQueries).toHaveLength(1);
    expect(rejectionQueries[0]!.params).toEqual([branchRej, id5]);
    expect(rejectionQueries[0]!.returned).toBe(0);

    // 验证重连后 welcome 中 lastProcessed=5 且全部 5 条拒绝记录状态完整一致
    const pReconn = peerOf(u);
    await testRooms.join(branchRej, pReconn.peer);
    await testRooms.message(branchRej, pReconn.peer, { t: 'hello', client: 'c-cursor', lastSeq: 0 });
    const welcome2 = pReconn.sent.find((m) => (m as { t: string }).t === 'welcome') as {
      t: 'welcome';
      lastProcessed: number;
      rejected: { n: number }[];
    };
    expect(welcome2.lastProcessed).toBe(5);
    expect(welcome2.rejected.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
  } finally {
    testRooms.close();
    await testRooms.flush();
  }
});

const waitForCond = async (predicate: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

test('空闲房间在 HTTP 访问或所有 peer 离开后自动卸载，卸载后忽略总线事件不查库并支持透明重载（#45）', async () => {
  const u = await makeUser(db, 'idle-evict-user', { name: '空闲淘汰测试' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-idle-evict', pid, u.id],
  );
  const branchIdle = `${branchId}-idle-evict`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'idle-evict')", [
    branchIdle,
    pid,
  ]);
  await rooms.init(branchIdle, model);

  let commitQueries = 0;
  const countedDb: PlatformDb = {
    ...db,
    query: async <T>(sql: string, params?: unknown[]) => {
      if (sql.includes('from room_commits')) commitQueries += 1;
      return db.query<T>(sql, params);
    },
    transaction: (fn, opts) =>
      db.transaction(async (tx) => {
        const wrappedTx: typeof tx = {
          exec: (q) => tx.exec(q),
          query: async <T>(q: string, params?: unknown[]) => {
            if (q.includes('from room_commits')) commitQueries += 1;
            return tx.query<T>(q, params);
          },
        };
        return fn(wrappedTx);
      }, opts),
  };

  const fake = makeFakeBus('replica-idle');
  const idleRooms = new Rooms(
    countedDb,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    fake.bus,
    undefined,
    { idleEvictMs: 40 },
  );
  const noEvictZero = new Rooms(
    db,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    undefined,
    undefined,
    { idleEvictMs: 0 },
  );
  const noEvictInf = new Rooms(
    db,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    undefined,
    undefined,
    { idleEvictMs: Number.POSITIVE_INFINITY },
  );

  try {
    // 1. 仅 HTTP 只读接口加载房间（无 peer），超过 idleEvictMs 后自动卸载
    const initial = await idleRooms.model(branchIdle);
    expect(initial.seq).toBe(0);
    expect(idleRooms.has(branchIdle)).toBe(true);
    await waitForCond(() => !idleRooms.has(branchIdle));
    expect(idleRooms.has(branchIdle)).toBe(false);

    // 2. 卸载后收到外部 room.commit / room.layout 广播：直接忽略，不重载也不查库
    const nextModel = structuredClone(model);
    nextModel.objects.tbl_ext = {
      kind: 'table',
      id: 'tbl_ext',
      parent: schemaId,
      name: 'after_evict',
      partitionBy: null,
      partitionOf: null,
      comment: null,
    };
    await rooms.replace(branchIdle, '外部副本', nextModel, 'externalReplace', 0);

    commitQueries = 0;
    await fake.emit({ t: 'room.commit', origin: 'replica-other', branchId: branchIdle, seq: 1 });
    await fake.emit({
      t: 'room.layout',
      origin: 'replica-other',
      branchId: branchIdle,
      positions: { tbl_ext: { x: 10, y: 20 } },
    });
    expect(idleRooms.has(branchIdle)).toBe(false);
    expect(commitQueries).toBe(0);

    // 3. 再次访问时透明重新加载，并读到最新已提交模型
    const reloaded = await idleRooms.state(branchIdle);
    expect(reloaded.seq).toBe(1);
    expect(all(reloaded.model, 'table').map((t) => t.name)).toEqual(['after_evict']);
    expect(idleRooms.has(branchIdle)).toBe(true);

    // 4. peer 加入后取消空闲卸载：保持在线超过 2 * idleEvictMs 仍常驻；离开后重新进入空闲淘汰
    const p = peerOf(u);
    await idleRooms.join(branchIdle, p.peer);
    await new Promise((r) => setTimeout(r, 100));
    expect(idleRooms.has(branchIdle)).toBe(true);

    await idleRooms.leave(branchIdle, p.peer);
    await waitForCond(() => !idleRooms.has(branchIdle));
    expect(idleRooms.has(branchIdle)).toBe(false);

    // 5. 被 kickUserLocal 踢掉最后一个 peer 后同样触发空闲卸载
    const p2 = peerOf(u);
    await idleRooms.join(branchIdle, p2.peer);
    expect(idleRooms.has(branchIdle)).toBe(true);
    await idleRooms.kickUserLocal(u.id, '测试踢出');
    expect(p2.closed()).toBe(4403);
    await waitForCond(() => !idleRooms.has(branchIdle));
    expect(idleRooms.has(branchIdle)).toBe(false);

    // 6. idleEvictMs = 0 / Infinity 时禁用空闲卸载
    await noEvictZero.model(branchIdle);
    await noEvictInf.model(branchIdle);
    await new Promise((r) => setTimeout(r, 80));
    expect(noEvictZero.has(branchIdle)).toBe(true);
    expect(noEvictInf.has(branchIdle)).toBe(true);
  } finally {
    idleRooms.close();
    noEvictZero.close();
    noEvictInf.close();
    await Promise.all([idleRooms.flush(), noEvictZero.flush(), noEvictInf.flush()]);
  }
});

test('有待落盘布局或在途 flushLayout 时不被误卸载，落盘后自动淘汰；close() 清理全部空闲定时器（#45）', async () => {
  const u = await makeUser(db, 'idle-layout-user', { name: '空闲布局保护' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-idle-layout', pid, u.id],
  );
  const branchIdleLayout = `${branchId}-idle-layout`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'idle-layout')", [
    branchIdleLayout,
    pid,
  ]);
  await rooms.init(branchIdleLayout, model);

  let holdLayoutUpdate = false;
  const layoutUpdateEntered = deferred();
  const layoutUpdateRelease = deferred();
  const hookedDb: PlatformDb = {
    ...db,
    query: async <T>(sql: string, params?: unknown[]) => {
      if (holdLayoutUpdate && sql.includes('update branches set layout')) {
        holdLayoutUpdate = false;
        layoutUpdateEntered.resolve();
        await layoutUpdateRelease.promise;
      }
      return db.query<T>(sql, params);
    },
  };

  const idleRooms = new Rooms(
    hookedDb,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    undefined,
    undefined,
    { idleEvictMs: 40 },
  );

  try {
    const p = peerOf(u);
    await idleRooms.join(branchIdleLayout, p.peer);
    await idleRooms.message(branchIdleLayout, p.peer, { t: 'hello', client: 'c-idle-layout', lastSeq: 0 });

    // 发送 layout 后立即离开：此时 peers.size === 0，但有 pendingLayout + layoutTimer（500ms）
    holdLayoutUpdate = true;
    await idleRooms.message(branchIdleLayout, p.peer, {
      t: 'layout',
      positions: { tbl_keep: { x: 77, y: 88 } },
    });
    await idleRooms.leave(branchIdleLayout, p.peer);

    // 等待超过 idleEvictMs（40ms），防抖落盘尚未触发，房间绝不能被误卸载
    await new Promise((r) => setTimeout(r, 120));
    expect(idleRooms.has(branchIdleLayout)).toBe(true);

    // 等 500ms 防抖触发进入 flushLayout SQL（在途 layoutFlushing 期间同样不能卸载）
    await layoutUpdateEntered.promise;
    await new Promise((r) => setTimeout(r, 100));
    expect(idleRooms.has(branchIdleLayout)).toBe(true);

    // 放行落盘：布局完整持久化，且 flushLayout 完成后自动重新调度空闲卸载
    layoutUpdateRelease.resolve();
    await waitForCond(() => !idleRooms.has(branchIdleLayout));
    expect(idleRooms.has(branchIdleLayout)).toBe(false);

    const [saved] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchIdleLayout],
    );
    expect(saved?.layout.tbl_keep).toEqual({ x: 77, y: 88 });

    // close() 必须同步清理全部空闲卸载定时器，不再触发卸载
    await idleRooms.model(branchIdleLayout);
    expect(idleRooms.has(branchIdleLayout)).toBe(true);
    idleRooms.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(idleRooms.has(branchIdleLayout)).toBe(true);
  } finally {
    idleRooms.close();
    await idleRooms.flush();
  }
});

test('SQLite 模式下并发写入在 COMMIT 前挂起并最终回滚：并发 state / model / modelAt / listHistory 严格等锁且绝不脏读（#45）', async () => {
  const u = await makeUser(db, 'sqlite-dirty-user', { name: '脏读防护测试' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-sqlite-dirty', pid, u.id],
  );
  const branchDirty = `${branchId}-sqlite-dirty`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'sqlite-dirty')", [
    branchDirty,
    pid,
  ]);
  await rooms.init(branchDirty, model);

  let holdWrite = false;
  let txEntered = deferred();
  let txRelease = deferred();
  const hookedDb: PlatformDb = {
    ...db,
    transaction: (fn, opts) =>
      db.transaction(async (tx) => {
        const res = await fn(tx);
        if (!opts?.readOnly && holdWrite) {
          holdWrite = false;
          txEntered.resolve();
          await txRelease.promise;
          throw new Error('模拟提交前事务回滚');
        }
        return res;
      }, opts),
  };

  const testRooms = new Rooms(hookedDb, (user, projectId, lookup) =>
    effectiveProjectRole(db, user, projectId, lookup),
  );

  try {
    // 预热加载房间，使 !r.dirty（历史上 SQLite 模式此时会绕过 withRoomLock 直接读内存）
    const base = await testRooms.state(branchDirty);
    expect(base.seq).toBe(0);
    expect(all(base.model, 'table')).toEqual([]);

    // 1. replace 路径：在事务 COMMIT 前已就地改写内存态，并发只读必须阻塞等锁，回滚后读到干净态
    const dirtyModel = structuredClone(base.model);
    dirtyModel.objects.tbl_dirty = {
      kind: 'table',
      id: 'tbl_dirty',
      parent: schemaId,
      name: 'uncommitted_replace',
      partitionBy: null,
      partitionOf: null,
      comment: null,
    };

    holdWrite = true;
    txEntered = deferred();
    txRelease = deferred();
    const writePromise = testRooms.replace(branchDirty, '脏写', dirtyModel, 'replaceModel', 0);
    await txEntered.promise;

    let stateDone = false;
    let modelDone = false;
    let modelAt0Done = false;
    let modelAt1Done = false;
    let histDone = false;
    let entry0Done = false;
    let entry1Done = false;

    const pState = testRooms.state(branchDirty).then((r) => {
      stateDone = true;
      return r;
    });
    const pModel = testRooms.model(branchDirty).then((r) => {
      modelDone = true;
      return r;
    });
    const pModelAt0 = testRooms.modelAt(branchDirty, 0).then((r) => {
      modelAt0Done = true;
      return r;
    });
    const pModelAt1 = testRooms.modelAt(branchDirty, 1).then(
      () => {
        modelAt1Done = true;
        return 'ok';
      },
      (err) => {
        modelAt1Done = true;
        return err;
      },
    );
    const pHist = testRooms.listHistory(branchDirty).then((r) => {
      histDone = true;
      return r;
    });
    const pEntry0 = testRooms.historyEntry(branchDirty, 0).then((r) => {
      entry0Done = true;
      return r;
    });
    const pEntry1 = testRooms.historyEntry(branchDirty, 1).then(
      () => {
        entry1Done = true;
        return 'ok';
      },
      (err) => {
        entry1Done = true;
        return err;
      },
    );

    // 写事务挂起期间，所有并发只读查询均必须阻塞等待房间锁
    await new Promise((r) => setTimeout(r, 40));
    expect(stateDone).toBe(false);
    expect(modelDone).toBe(false);
    expect(modelAt0Done).toBe(false);
    expect(modelAt1Done).toBe(false);
    expect(histDone).toBe(false);
    expect(entry0Done).toBe(false);
    expect(entry1Done).toBe(false);

    // 放行并触发事务回滚
    txRelease.resolve();
    await expect(writePromise).rejects.toThrow('模拟提交前事务回滚');

    const [st, md, at0, at1Err, hist, entry0, entry1Err] = await Promise.all([
      pState,
      pModel,
      pModelAt0,
      pModelAt1,
      pHist,
      pEntry0,
      pEntry1,
    ]);
    expect(st.seq).toBe(0);
    expect(all(st.model, 'table')).toEqual([]);
    expect(md.seq).toBe(0);
    expect(all(md.model, 'table')).toEqual([]);
    expect(all(at0, 'table')).toEqual([]);
    expect((at1Err as { status?: number })?.status).toBe(404);
    expect(hist.currentSeq).toBe(0);
    expect(entry0.seq).toBe(0);
    expect(entry0.isCurrent).toBe(true);
    expect((entry1Err as { status?: number })?.status).toBe(404);

    // 2. WS op 路径同样受锁保护，绝不读到未提交的 op 建表态
    const p = peerOf(u);
    await testRooms.join(branchDirty, p.peer);
    await testRooms.message(branchDirty, p.peer, { t: 'hello', client: 'c-dirty-op', lastSeq: 0 });

    holdWrite = true;
    txEntered = deferred();
    txRelease = deferred();
    const opPromise = testRooms.message(branchDirty, p.peer, {
      t: 'op',
      op: {
        client: 'c-dirty-op',
        n: 1,
        name: 'createTable',
        args: { id: 'tbl_dirty_op', schema: schemaId, name: 'uncommitted_op' },
        reads: [[schemaId, 0]],
      },
    });
    await txEntered.promise;

    let opReadDone = false;
    const pOpRead = testRooms.model(branchDirty).then((r) => {
      opReadDone = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(opReadDone).toBe(false);

    txRelease.resolve();
    await expect(opPromise).rejects.toThrow('模拟提交前事务回滚');
    const afterOpRollback = await pOpRead;
    expect(afterOpRollback.seq).toBe(0);
    expect(all(afterOpRollback.model, 'table')).toEqual([]);

    // 3. 返回值必须为独立快照副本：调用方修改返回对象不影响房间内部态
    afterOpRollback.model.objects.mutated_by_caller = {
      kind: 'table',
      id: 'mutated_by_caller',
      parent: schemaId,
      name: 'should_not_leak',
      partitionBy: null,
      partitionOf: null,
      comment: null,
    };
    const freshCheck = await testRooms.state(branchDirty);
    expect(freshCheck.model.objects.mutated_by_caller).toBeUndefined();
    freshCheck.versions[schemaId] = 999;
    expect((await testRooms.state(branchDirty)).versions[schemaId]).toBeUndefined();
  } finally {
    testRooms.close();
    await testRooms.flush();
  }
});

test('防抖 flushLayout 首次 SQL 失败自动重试落盘；持续失败达上限清理 pendingLayout 恢复空闲卸载；close() 清理残余 layoutTimer（#45）', async () => {
  const u = await makeUser(db, 'layout-retry-user', { name: '布局重试测试' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-layout-retry', pid, u.id],
  );
  const branchRetry = `${branchId}-layout-retry`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'layout-retry')", [
    branchRetry,
    pid,
  ]);
  await rooms.init(branchRetry, model);

  let failRemaining = 0;
  let updateCalls = 0;
  const flakyDb: PlatformDb = {
    ...db,
    query: async <T>(sql: string, params?: unknown[]) => {
      if (sql.includes('update branches set layout')) {
        updateCalls += 1;
        if (failRemaining > 0) {
          failRemaining -= 1;
          throw new Error('模拟布局写库瞬时失败');
        }
      }
      return db.query<T>(sql, params);
    },
  };

  const retryRooms = new Rooms(
    flakyDb,
    (user, projectId, lookup) => effectiveProjectRole(db, user, projectId, lookup),
    undefined,
    undefined,
    {
      idleEvictMs: 40,
      layoutDebounceMs: 25,
      layoutMaxRetries: 2,
      layoutRetryBaseMs: 20,
    },
  );

  try {
    // 1. 首次防抖落盘抛错后自动退避重试并成功持久化，随后空闲房间正常卸载
    const p1 = peerOf(u);
    await retryRooms.join(branchRetry, p1.peer);
    await retryRooms.message(branchRetry, p1.peer, { t: 'hello', client: 'c-retry-1', lastSeq: 0 });
    failRemaining = 1;
    updateCalls = 0;
    await retryRooms.message(branchRetry, p1.peer, {
      t: 'layout',
      positions: { tbl_retry_ok: { x: 12, y: 34 } },
    });
    await retryRooms.leave(branchRetry, p1.peer);

    await waitForCond(() => !retryRooms.has(branchRetry));
    expect(updateCalls).toBe(2);
    const [saved1] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchRetry],
    );
    expect(saved1?.layout.tbl_retry_ok).toEqual({ x: 12, y: 34 });

    // 2. 持续性写库失败达重试上限（1 次初始 + 2 次重试 = 3 次）后，清理失败快照并恢复空闲卸载
    const p2 = peerOf(u);
    await retryRooms.join(branchRetry, p2.peer);
    await retryRooms.message(branchRetry, p2.peer, { t: 'hello', client: 'c-retry-2', lastSeq: 0 });
    failRemaining = 99;
    updateCalls = 0;
    await retryRooms.message(branchRetry, p2.peer, {
      t: 'layout',
      positions: { tbl_retry_fail: { x: 56, y: 78 } },
    });
    await retryRooms.leave(branchRetry, p2.peer);

    await waitForCond(() => !retryRooms.has(branchRetry));
    expect(updateCalls).toBe(3);

    // 3. close() 同步清理残余 layoutTimer，不再后台触发自动写库，但 flush() 仍可将待落盘布局刷库
    failRemaining = 0;
    const p3 = peerOf(u);
    await retryRooms.join(branchRetry, p3.peer);
    await retryRooms.message(branchRetry, p3.peer, { t: 'hello', client: 'c-retry-3', lastSeq: 0 });
    updateCalls = 0;
    await retryRooms.message(branchRetry, p3.peer, {
      t: 'layout',
      positions: { tbl_close_flush: { x: 90, y: 100 } },
    });
    retryRooms.close();
    await new Promise((r) => setTimeout(r, 80));
    expect(updateCalls).toBe(0);

    await retryRooms.flush();
    expect(updateCalls).toBe(1);
    const [saved3] = await db.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [branchRetry],
    );
    expect(saved3?.layout.tbl_close_flush).toEqual({ x: 90, y: 100 });
  } finally {
    retryRooms.close();
    await retryRooms.flush();
  }
});

test('远端 room.layout 不重置本地空闲倒计时；join 异步核验抛异常时回滚 peers 并恢复空闲卸载（#45）', async () => {
  const u = await makeUser(db, 'idle-remote-layout-user', { name: '远端布局不续命' });
  await db.query(
    "insert into grants (id, scope_kind, scope_id, subject_kind, subject_id, role) values ($1, 'project', $2, 'user', $3, 'editor')",
    ['g-idle-remote-layout', pid, u.id],
  );
  const branchRemote = `${branchId}-idle-remote-layout`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'idle-remote-layout')", [
    branchRemote,
    pid,
  ]);
  await rooms.init(branchRemote, model);

  let failResolveOnce = false;
  const fake = makeFakeBus('replica-local-idle');
  const testRooms = new Rooms(
    db,
    async (user, projectId, lookup) => {
      if (failResolveOnce) {
        failResolveOnce = false;
        throw new Error('模拟 join 角色查询异常');
      }
      return effectiveProjectRole(db, user, projectId, lookup);
    },
    fake.bus,
    undefined,
    { idleEvictMs: 120 },
  );

  try {
    // 1. 加载空闲房间后每 30ms 收到一次远端 room.layout（远短于 idleEvictMs=120ms），仍必须在原倒计时附近卸载
    await testRooms.model(branchRemote);
    expect(testRooms.has(branchRemote)).toBe(true);
    const startedAt = Date.now();
    let ticks = 0;
    const emitter = setInterval(() => {
      ticks += 1;
      void fake.emit({
        t: 'room.layout',
        origin: 'replica-remote-idle',
        branchId: branchRemote,
        positions: { tbl_remote: { x: ticks, y: ticks } },
        ver: ticks,
      });
    }, 30);
    try {
      await waitForCond(() => !testRooms.has(branchRemote), 600);
    } finally {
      clearInterval(emitter);
    }
    const elapsed = Date.now() - startedAt;
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(350);
    expect(testRooms.has(branchRemote)).toBe(false);

    // 2. join 异步核验抛异常时，必须回滚 r.peers 且正常触发空闲卸载（后续幂等 leave 也安全）
    failResolveOnce = true;
    const p = peerOf(u);
    await expect(testRooms.join(branchRemote, p.peer)).rejects.toThrow('模拟 join 角色查询异常');
    expect(testRooms.has(branchRemote)).toBe(true);
    await waitForCond(() => !testRooms.has(branchRemote), 600);
    expect(testRooms.has(branchRemote)).toBe(false);
    await testRooms.leave(branchRemote, p.peer);
    expect(testRooms.has(branchRemote)).toBe(false);
  } finally {
    testRooms.close();
    await testRooms.flush();
  }
});

test('applyMcpOps 批量跨越 SNAPSHOT_EVERY 时写入该点位快照', async () => {
  const branchSnap = `${branchId}-mcp-snapshot`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'mcp-snapshot')", [
    branchSnap,
    pid,
  ]);
  await rooms.init(branchSnap, model);

  let currentSeq = 0;
  let nextIdx = 1;
  const targetBeforeCross = SNAPSHOT_EVERY - 5;
  while (currentSeq < targetBeforeCross) {
    const count = Math.min(100, targetBeforeCross - currentSeq);
    const ops = Array.from({ length: count }, () => {
      const idx = nextIdx++;
      return {
        name: 'createTable',
        args: { id: `$ref:t_${idx}`, schema: schemaId, name: `snap_t_${idx}` },
      };
    });
    const r = await rooms.applyMcpOps(branchSnap, {
      userId: member.id,
      tokenId: 'tok-snap',
      user: member.name,
      baseSeq: currentSeq,
      ops,
    });
    expect(r.ok).toBe(true);
    if (r.ok) currentSeq = r.seq;
  }

  expect(currentSeq).toBe(SNAPSHOT_EVERY - 5);
  const snapsBefore = await db.query<{ seq: string | number }>(
    'select seq from room_snapshots where branch_id = $1 order by seq',
    [branchSnap],
  );
  expect(snapsBefore.map((s) => Number(s.seq))).toEqual([0]);

  const crossOps = Array.from({ length: 10 }, () => {
    const idx = nextIdx++;
    return {
      name: 'createTable',
      args: { id: `$ref:t_${idx}`, schema: schemaId, name: `snap_t_${idx}` },
    };
  });
  const crossRes = await rooms.applyMcpOps(branchSnap, {
    userId: member.id,
    tokenId: 'tok-snap',
    user: member.name,
    baseSeq: currentSeq,
    ops: crossOps,
  });
  expect(crossRes.ok).toBe(true);
  if (crossRes.ok) expect(crossRes.seq).toBe(SNAPSHOT_EVERY + 5);

  const snapsAfter = await db.query<{ seq: string | number; model: Model }>(
    'select seq, model from room_snapshots where branch_id = $1 order by seq',
    [branchSnap],
  );
  expect(snapsAfter.map((s) => Number(s.seq))).toEqual([0, SNAPSHOT_EVERY]);
  const snapAtEvery = snapsAfter.find((s) => Number(s.seq) === SNAPSHOT_EVERY)!;
  const snapTableNames = new Set(all(snapAtEvery.model, 'table').map((t) => t.name));
  expect(snapTableNames.has(`snap_t_${SNAPSHOT_EVERY}`)).toBe(true);
  expect(snapTableNames.has(`snap_t_${SNAPSHOT_EVERY + 1}`)).toBe(false);
  expect(snapTableNames.has(`snap_t_${SNAPSHOT_EVERY + 5}`)).toBe(false);

  const atEvery = await rooms.modelAt(branchSnap, SNAPSHOT_EVERY);
  const atEveryNames = new Set(all(atEvery, 'table').map((t) => t.name));
  expect(atEveryNames.has(`snap_t_${SNAPSHOT_EVERY}`)).toBe(true);
  expect(atEveryNames.has(`snap_t_${SNAPSHOT_EVERY + 1}`)).toBe(false);

  const atMid = await rooms.modelAt(branchSnap, SNAPSHOT_EVERY + 3);
  const atMidNames = new Set(all(atMid, 'table').map((t) => t.name));
  expect(atMidNames.has(`snap_t_${SNAPSHOT_EVERY + 3}`)).toBe(true);
  expect(atMidNames.has(`snap_t_${SNAPSHOT_EVERY + 4}`)).toBe(false);
});

test('applyMcpOps / Room.simulate：表名 constructor、列名 valueOf、注释 toString、枚举值 hasOwnProperty 不误报冲突（#87）', async () => {
  const branchProto = `${branchId}-mcp-proto`;
  await db.query("insert into branches (id, project_id, name) values ($1, $2, 'mcp-proto')", [
    branchProto,
    pid,
  ]);
  await rooms.init(branchProto, model);

  const first = await rooms.applyMcpOps(branchProto, {
    userId: member.id,
    tokenId: 'tok-proto',
    user: member.name,
    ops: [{ name: 'createTable', args: { id: '$ref:t', schema: schemaId, name: 'users' } }],
  });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const tableId = first.refs.t!;

  const ops = [
    { name: 'renameTable', args: { id: tableId, name: 'constructor' } },
    { name: 'setComment', args: { id: tableId, comment: 'toString' } },
    { name: 'addColumn', args: { table: tableId, column: { id: '$ref:c', name: 'valueOf', type: 'text' } } },
    {
      name: 'createEnum',
      args: { id: '$ref:e', schema: schemaId, name: 'status', values: ['hasOwnProperty'] },
    },
  ];
  // 先 dry-run（只走 Room.simulate），再真正提交；两次都基于同一个 baseSeq
  const dry = await rooms.applyMcpOps(branchProto, {
    userId: member.id,
    tokenId: 'tok-proto',
    user: member.name,
    baseSeq: first.seq,
    dryRun: true,
    ops,
  });
  expect(dry).toMatchObject({ ok: true, dryRun: true });

  const res = await rooms.applyMcpOps(branchProto, {
    userId: member.id,
    tokenId: 'tok-proto',
    user: member.name,
    baseSeq: first.seq,
    ops,
  });
  expect(res).toMatchObject({ ok: true, dryRun: false, seq: first.seq + ops.length });
  if (!res.ok) return;
  const t = res.model.objects[tableId];
  expect(t).toMatchObject({ kind: 'table', name: 'constructor', comment: 'toString' });
  expect(res.model.objects[res.refs.c!]).toMatchObject({ kind: 'column', name: 'valueOf' });
  expect(res.model.objects[res.refs.e!]).toMatchObject({ kind: 'enum', values: ['hasOwnProperty'] });
});
