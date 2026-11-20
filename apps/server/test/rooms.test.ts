// 房间的“踢人”语义：角色 / 状态在 join 之后变了（refreshLoaded）或被停用时，
// 遗留连接上的消息一律丢弃；join 时也要再确认一次账号状态和生效角色。
import { all, emptyModel, type Model, readsOf } from '@dowel/core';
import { type Commit, SyncClient, type ToClient } from '@dowel/sync';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { User } from '../src/auth.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { effectiveProjectRole } from '../src/roles.ts';
import { type Peer, Rooms } from '../src/rooms.ts';
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

  const origVictimSend = victimPeer.peer.send;
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
