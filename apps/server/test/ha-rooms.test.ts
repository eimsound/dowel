// P7 HA2 无状态实时协作房间测试（ADR 0011）：
// 覆盖真实 PostgreSQL 双副本下的实时提交同步、并发写入行锁串行化与冲突拒绝、
// 跨副本 replace(expectedSeq) 并发保护、跨副本停用踢人与角色即时降级、
// 跨副本 layout / presence 转发、断线重连追赶、无粘性客户端跨副本迁移以及事务回滚内存隔离。
import { all, emptyModel, type Model, newId, readsOf } from '@dowel/core';
import { type Commit, type RoomState, SyncClient, type ToClient } from '@dowel/sync';
import { afterEach, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { type Extra, type Peer, type RoomsOptions, WorkingChangedError } from '../src/rooms.ts';
import { makeUser, PASSWORD } from './support.ts';

const waitFor = async (predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const sortKeys = (x: unknown): unknown =>
  Array.isArray(x)
    ? x.map(sortKeys)
    : x && typeof x === 'object'
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]),
        )
      : x;

const sameModel = (a: Model, b: Model) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

const callJson = async (
  app: ReturnType<typeof createApp>['app'],
  method: string,
  path: string,
  json?: unknown,
  cookie = '',
) => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data: data as Record<string, unknown>,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

interface MockPeer {
  peer: Peer;
  sent: (ToClient | Extra)[];
  closed: () => { code: number; reason: string } | null;
}

const makePeer = (user: User, role: Peer['role'] = 'editor'): MockPeer => {
  const sent: (ToClient | Extra)[] = [];
  let closeInfo: { code: number; reason: string } | null = null;
  const peer: Peer = {
    user,
    role,
    send: (msg) => sent.push(structuredClone(msg)),
    close: (code, reason) => {
      closeInfo = { code, reason };
    },
  };
  return { peer, sent, closed: () => closeInfo };
};

interface DualReplicaFixture {
  dbA: PlatformDb;
  dbB: PlatformDb;
  appA: ReturnType<typeof createApp>;
  appB: ReturnType<typeof createApp>;
  admin: User;
  alice: User;
  bob: User;
  groupId: string;
  projectId: string;
  branchId: string;
  schemaId: string;
  adminCookie: string;
  close: () => Promise<void>;
}

const createDualReplicas = async (
  tag: string,
  startBus = true,
  roomOpts?: { roomsA?: RoomsOptions; roomsB?: RoomsOptions },
  replicaIds?: { a?: string; b?: string },
): Promise<DualReplicaFixture> => {
  const safeTag = tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const pg = await createTestDb(safeTag);
  const dbA = await openPlatformDb(pg.url);
  const dbB = await openPlatformDb(pg.url);
  const suffix = newId()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  const channel = `dowel_ha_rooms_${safeTag}_${suffix}`;
  const appA = createApp(dbA, {
    bus: { replicaId: replicaIds?.a ?? `replica-a-${safeTag}`, channel },
    rooms: roomOpts?.roomsA,
  });
  const appB = createApp(dbB, {
    bus: { replicaId: replicaIds?.b ?? `replica-b-${safeTag}`, channel },
    rooms: roomOpts?.roomsB,
  });

  try {
    if (startBus) {
      await appA.bus.start();
      await appB.bus.start();
    }

    const admin = await makeUser(dbA, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(dbA, 'alice', { name: '张三' });
    const bob = await makeUser(dbA, 'bob', { name: '李四' });

    const loginRes = await callJson(appA.app, 'POST', '/api/auth/login', {
      username: 'admin',
      password: PASSWORD,
    });
    expect(loginRes.status).toBe(200);
    const adminCookie = loginRes.cookie;

    const grp = await callJson(
      appA.app,
      'POST',
      '/api/groups',
      { slug: 'ha-rooms', name: 'HA 协作组', defaultRole: 'none' },
      adminCookie,
    );
    expect(grp.status).toBe(201);
    const groupId = grp.data.id as string;

    const proj = await callJson(
      appA.app,
      'POST',
      '/api/projects',
      { name: 'HA 房间项目', groupId },
      adminCookie,
    );
    expect(proj.status).toBe(201);
    const projectId = proj.data.id as string;

    // 赋予张三和李四项目编辑者权限
    for (const u of [alice, bob]) {
      const g = await callJson(
        appA.app,
        'POST',
        `/api/projects/${projectId}/grants`,
        { subjectKind: 'user', subjectId: u.id, role: 'editor' },
        adminCookie,
      );
      expect(g.status).toBe(201);
    }

    const [b] = await dbA.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [projectId],
    );
    const branchId = b!.id;
    const { model } = await appA.rooms.model(branchId);
    const schemaId = all(model, 'schema')[0]!.id;

    return {
      dbA,
      dbB,
      appA,
      appB,
      admin,
      alice,
      bob,
      groupId,
      projectId,
      branchId,
      schemaId,
      adminCookie,
      close: async () => {
        appA.refresher.stop();
        appB.refresher.stop();
        await appA.refresher.drain();
        await appB.refresher.drain();
        appA.rooms.close();
        appB.rooms.close();
        await appA.rooms.flush();
        await appB.rooms.flush();
        await appA.shadows.close();
        await appB.shadows.close();
        await appA.bus.close();
        await appB.bus.close();
        await dbA.close();
        await dbB.close();
        await pg.close();
      },
    };
  } catch (e) {
    appA.rooms.close();
    appB.rooms.close();
    await appA.bus.close().catch(() => {});
    await appB.bus.close().catch(() => {});
    await dbA.close().catch(() => {});
    await dbB.close().catch(() => {});
    await pg.close().catch(() => {});
    throw e;
  }
};

describe.skipIf(!PG_URL)('P7 HA2：无状态实时协作房间（真实 PG 双副本）', () => {
  const fixtures: DualReplicaFixture[] = [];
  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()!.close();
    }
  });

  const boot = async (
    tag: string,
    startBus = true,
    roomOpts?: { roomsA?: RoomsOptions; roomsB?: RoomsOptions },
    replicaIds?: { a?: string; b?: string },
  ) => {
    const f = await createDualReplicas(tag, startBus, roomOpts, replicaIds);
    fixtures.push(f);
    return f;
  };

  test('1. 跨副本实时同步：副本 A 提交表与列修改 → 副本 B 的 peer 实时收到 commit 且两副本模型一致', async () => {
    const f = await boot('sync');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);

    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    const { model: base } = await f.appA.rooms.model(f.branchId);
    const tId = 'tbl_users';
    const createTableArgs = { id: tId, schema: f.schemaId, name: 'users' };
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: 'c-a',
        n: 1,
        name: 'createTable',
        args: createTableArgs,
        reads: readsOf(base, createTableArgs).map((id) => [id, 0] as [string, number]),
      },
    });
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: 'c-a',
        n: 2,
        name: 'addColumn',
        args: { table: tId, column: { id: 'col_email', name: 'email', type: 'text' } },
        reads: [[tId, 1]],
      },
    });

    await waitFor(() => peerB.sent.filter((m) => m.t === 'commit').length >= 2);

    const commitsB = peerB.sent.filter((m): m is Commit => m.t === 'commit');
    expect(commitsB.map((c) => c.seq)).toEqual([1, 2]);
    expect(commitsB.map((c) => c.user)).toEqual(['张三', '张三']);

    const stateA = await f.appA.rooms.model(f.branchId);
    const stateB = await f.appB.rooms.model(f.branchId);
    expect(stateA.seq).toBe(2);
    expect(stateB.seq).toBe(2);
    expect(sameModel(stateA.model, stateB.model)).toBe(true);
    expect(all(stateB.model, 'table').map((t) => t.name)).toEqual(['users']);
    expect(all(stateB.model, 'column').map((c) => c.name)).toEqual(['email']);

    // modelAt 与 listHistory 在另一副本同样可立即读到最新历史
    const at1 = await f.appB.rooms.modelAt(f.branchId, 1);
    expect(all(at1, 'table').map((t) => t.name)).toEqual(['users']);
    expect(all(at1, 'column')).toEqual([]);
    const hist = await f.appB.rooms.listHistory(f.branchId);
    expect(hist.currentSeq).toBe(2);
  });

  test('2. 跨副本并发写入串行化：含同表并发冲突改名与并发加列，无重复 seq、冲突方收 rejection、最终模型一致', async () => {
    const f = await boot('concurrent');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);

    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 先建一张公共表并等副本 B 同步到 seq=1
    const tId = 'tbl_shared';
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: 'c-a',
        n: 1,
        name: 'createTable',
        args: { id: tId, schema: f.schemaId, name: 'orders' },
        reads: [[f.schemaId, 0]],
      },
    });
    await waitFor(() => peerB.sent.some((m) => m.t === 'commit' && m.seq === 1));

    // 2a. 两副本同时基于版本 1 对同一张表改名（必有一方成功、一方收到 conflict rejection）
    await Promise.all([
      f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n: 2,
          name: 'renameTable',
          args: { id: tId, name: 'orders_from_a' },
          reads: [[tId, 1]],
        },
      }),
      f.appB.rooms.message(f.branchId, peerB.peer, {
        t: 'op',
        op: {
          client: 'c-b',
          n: 1,
          name: 'renameTable',
          args: { id: tId, name: 'orders_from_b' },
          reads: [[tId, 1]],
        },
      }),
    ]);

    const rejectsA = peerA.sent.filter((m) => m.t === 'reject');
    const rejectsB = peerB.sent.filter((m) => m.t === 'reject');
    expect(rejectsA.length + rejectsB.length).toBe(1);
    const rej = (rejectsA[0] ?? rejectsB[0]) as { t: 'reject'; code: string; message: string };
    expect(rej.code).toBe('conflict');

    // 2b. 两副本同时并发提交多条不冲突的建表操作
    const countPerReplica = 5;
    await Promise.all([
      (async () => {
        for (let i = 0; i < countPerReplica; i++) {
          await f.appA.rooms.message(f.branchId, peerA.peer, {
            t: 'op',
            op: {
              client: 'c-a',
              n: 3 + i,
              name: 'createTable',
              args: { id: `ta_${i}`, schema: f.schemaId, name: `table_a_${i}` },
              reads: [[f.schemaId, 0]],
            },
          });
        }
      })(),
      (async () => {
        for (let i = 0; i < countPerReplica; i++) {
          await f.appB.rooms.message(f.branchId, peerB.peer, {
            t: 'op',
            op: {
              client: 'c-b',
              n: 2 + i,
              name: 'createTable',
              args: { id: `tb_${i}`, schema: f.schemaId, name: `table_b_${i}` },
              reads: [[f.schemaId, 0]],
            },
          });
        }
      })(),
    ]);

    const expectedFinalSeq = 2 + countPerReplica * 2;
    await waitFor(
      () =>
        new Set(peerA.sent.filter((m): m is Commit => m.t === 'commit').map((c) => c.seq)).size ===
          expectedFinalSeq &&
        new Set(peerB.sent.filter((m): m is Commit => m.t === 'commit').map((c) => c.seq)).size ===
          expectedFinalSeq,
    );

    // 验证数据库中 seq 严格从 1 连续递增到 expectedFinalSeq，无重复、无空洞
    const rows = await f.dbA.query<{ seq: number }>(
      'select seq from room_commits where branch_id = $1 order by seq',
      [f.branchId],
    );
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: expectedFinalSeq }, (_, i) => i + 1));

    const modelA = await f.appA.rooms.model(f.branchId);
    const modelB = await f.appB.rooms.model(f.branchId);
    expect(modelA.seq).toBe(expectedFinalSeq);
    expect(modelB.seq).toBe(expectedFinalSeq);
    expect(sameModel(modelA.model, modelB.model)).toBe(true);

    // 最终表名一定是其中一方的改名结果，加上 10 张并发新建表
    const names = all(modelA.model, 'table').map((t) => t.name);
    expect(names).toHaveLength(1 + countPerReplica * 2);
    expect(names.includes('orders_from_a') || names.includes('orders_from_b')).toBe(true);
    expect(names.includes('orders_from_a') && names.includes('orders_from_b')).toBe(false);
  });

  test('3. 跨副本 replace(expectedSeq) 并发保护与无通知下读取保鲜', async () => {
    // 故意不启动 EventBus，验证 PG 行锁内追赶与读前追赶不依赖 NOTIFY 时序
    const f = await boot('replace', false);
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 副本 B 先记下 seq = 0
    const beforeB = await f.appB.rooms.model(f.branchId);
    expect(beforeB.seq).toBe(0);

    // 副本 A 提交一条修改（seq = 1），副本 B 尚未收到任何 NOTIFY
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: 'c-a',
        n: 1,
        name: 'createTable',
        args: { id: 't_from_a', schema: f.schemaId, name: 'from_a' },
        reads: [[f.schemaId, 0]],
      },
    });

    // 副本 B 携带旧 expectedSeq=0 调用 replace，必须精确抛 WorkingChangedError(1, ...)
    const next = structuredClone(beforeB.model);
    let caught: unknown;
    try {
      await f.appB.rooms.replace(f.branchId, '李四', next, 'restore', 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkingChangedError);
    const err = caught as WorkingChangedError;
    expect(err.currentSeq).toBe(1);
    expect(all(err.currentModel, 'table').map((t) => t.name)).toEqual(['from_a']);

    // 携带最新 expectedSeq=1 后 replace 成功，副本 A 通过 rooms.model() 立即读到新状态
    await f.appB.rooms.replace(f.branchId, '李四', next, 'restore', 1);
    const afterA = await f.appA.rooms.model(f.branchId);
    expect(afterA.seq).toBe(2);
    expect(all(afterA.model, 'table')).toEqual([]);
  });

  test('4. 跨副本停用踢人（kickUser）与角色即时降级（refreshLoaded）', async () => {
    const f = await boot('kick-refresh');
    // 只有副本 B 上有在线连接（副本 A 甚至没有加载该分支房间），验证副本 A 触发事件也能送达副本 B
    const peerBob = makePeer(f.bob);
    const peerAlice = makePeer(f.alice);
    await f.appB.rooms.join(f.branchId, peerBob.peer);
    await f.appB.rooms.join(f.branchId, peerAlice.peer);
    await f.appB.rooms.message(f.branchId, peerBob.peer, { t: 'hello', client: 'c-bob', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerAlice.peer, { t: 'hello', client: 'c-alice', lastSeq: 0 });
    expect(peerBob.peer.role).toBe('editor');
    expect(peerAlice.peer.role).toBe('editor');

    // 4a. 副本 A 调用 kickUser 踢出李四 → 副本 B 上李四立即 close(4403, ...) 且张三收到更新后的 peers
    const aliceMsgsBeforeKick = peerAlice.sent.length;
    await f.appA.rooms.kickUser(f.bob.id, '账号已被停用');
    await waitFor(() => peerBob.closed() !== null);
    expect(peerBob.closed()).toEqual({ code: 4403, reason: '账号已被停用' });
    await waitFor(() =>
      peerAlice.sent.slice(aliceMsgsBeforeKick).some((m) => m.t === 'peers' && m.peers.length === 1),
    );

    // 4b. 副本 A 将张三项目角色降级为 viewer 并调用 refreshLoaded → 副本 B 上张三立即收到 { t: 'role', role: 'viewer' }
    await f.dbA.query(
      "update grants set role = 'viewer' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
      [f.alice.id, f.projectId],
    );
    const aliceMsgsBeforeRole = peerAlice.sent.length;
    await f.appA.rooms.refreshLoaded();
    await waitFor(() =>
      peerAlice.sent.slice(aliceMsgsBeforeRole).some((m) => m.t === 'role' && m.role === 'viewer'),
    );
    expect(peerAlice.peer.role).toBe('viewer');

    // 降级为 viewer 后，张三再发 op 会被立即拒绝
    await f.appB.rooms.message(f.branchId, peerAlice.peer, {
      t: 'op',
      op: {
        client: 'c-alice',
        n: 1,
        name: 'createTable',
        args: { id: 't_denied', schema: f.schemaId, name: 'denied' },
        reads: [[f.schemaId, 0]],
      },
    });
    expect(peerAlice.sent.some((m) => m.t === 'reject' && m.code === 'invalid')).toBe(true);
  });

  test('5. 跨副本 layout 与 presence 转发，及 layout 落库互不覆盖', async () => {
    const f = await boot('layout-presence');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 副本 A 发 layout → 副本 B 收到并合并进本地 layout
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 100, y: 200 } },
    });
    await waitFor(() =>
      peerB.sent.some(
        (m) => m.t === 'layout' && m.positions.tbl_1?.x === 100 && m.positions.tbl_1?.y === 200,
      ),
    );

    // 副本 B 同时拖动另一张表
    await f.appB.rooms.message(f.branchId, peerB.peer, {
      t: 'layout',
      positions: { tbl_2: { x: 300, y: 400 } },
    });
    await waitFor(() =>
      peerA.sent.some(
        (m) => m.t === 'layout' && m.positions.tbl_2?.x === 300 && m.positions.tbl_2?.y === 400,
      ),
    );

    // 两副本各自 flush 后，数据库里同时保留两张表的布局坐标（PG jsonb || 增量合并）
    await f.appA.rooms.flush();
    await f.appB.rooms.flush();
    const [row] = await f.dbA.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [f.branchId],
    );
    expect(row?.layout).toEqual({
      tbl_1: { x: 100, y: 200 },
      tbl_2: { x: 300, y: 400 },
    });

    // 副本 A 发 presence → 副本 B 收到转发
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'presence',
      data: { cursor: { x: 12, y: 34 }, selected: 'tbl_1' },
    });
    await waitFor(() =>
      peerB.sent.some(
        (m) =>
          m.t === 'presence' &&
          m.client === 'c-a' &&
          m.user === '张三' &&
          (m.data as { selected?: string })?.selected === 'tbl_1',
      ),
    );
  });

  test('6. 无粘性客户端跨副本迁移、PG LISTEN 断线重连追赶与事务回滚内存隔离', async () => {
    const f = await boot('reconnect-rollback');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 6a. 使用真实 SyncClient 先连副本 A 提交有效与被拒绝的 op，再迁移到副本 B 继续协作
    const client = new SyncClient('migrating-client', emptyModel());
    let activeReplica = f.appA.rooms;
    let activePeer = makePeer(f.alice);
    await activeReplica.join(f.branchId, activePeer.peer);
    let sendChain = Promise.resolve();
    const attach = (replica: typeof f.appA.rooms, mp: MockPeer) => {
      activeReplica = replica;
      activePeer = mp;
      const origSend = mp.peer.send.bind(mp.peer);
      mp.peer.send = (msg) => {
        origSend(msg);
        if (msg.t === 'welcome' || msg.t === 'snapshot' || msg.t === 'commit' || msg.t === 'reject') {
          client.receive(msg);
        }
      };
      client.send = (msg) => {
        sendChain = sendChain.then(() => activeReplica.message(f.branchId, activePeer.peer, msg));
      };
    };

    attach(f.appA.rooms, activePeer);
    client.connect();
    await sendChain;
    await waitFor(() => client.ready);

    // 在副本 A 上提交 n=1
    client.mutate('createTable', { id: 't_mig', schema: f.schemaId, name: 'migrated' });
    await sendChain;
    await waitFor(() => client.seq === 1 && client.pending.length === 0);

    // 在副本 A 上制造一条 rejection（n=2 故意以过期的 reads 触发冲突拒绝）
    await f.appA.rooms.message(f.branchId, activePeer.peer, {
      t: 'op',
      op: {
        client: 'migrating-client',
        n: 2,
        name: 'renameTable',
        args: { id: 't_mig', name: 'stale_rename' },
        reads: [['t_mig', 0]],
      },
    });

    // 断开副本 A，无粘性重连到副本 B：hello 必须同步到 lastProcessed=2 和被拒绝的 n=2
    await f.appA.rooms.leave(f.branchId, activePeer.peer);
    const peerOnB = makePeer(f.alice);
    await f.appB.rooms.join(f.branchId, peerOnB.peer);
    attach(f.appB.rooms, peerOnB);
    await f.appB.rooms.message(f.branchId, peerOnB.peer, {
      t: 'hello',
      client: 'migrating-client',
      lastSeq: 1,
    });
    const welcome = peerOnB.sent.find((m) => m.t === 'welcome') as
      | { t: 'welcome'; lastProcessed: number; rejected: { n: number; code: string }[] }
      | undefined;
    expect(welcome?.lastProcessed).toBe(2);
    expect(welcome?.rejected.map((r) => r.n)).toContain(2);

    // 在副本 B 上继续发 n=3（验证 processed 与 seq 无缝衔接）
    await f.appB.rooms.message(f.branchId, peerOnB.peer, {
      t: 'op',
      op: {
        client: 'migrating-client',
        n: 3,
        name: 'addColumn',
        args: { table: 't_mig', column: { id: 'c_mig', name: 'title', type: 'text' } },
        reads: [['t_mig', 1]],
      },
    });
    expect((await f.appB.rooms.model(f.branchId)).seq).toBe(2);

    // 6b. 模拟事务回滚：破坏一次提交事务，验证内存态不会残留未提交脏修改
    const beforeRollback = await f.appB.rooms.model(f.branchId);
    const origTx = f.dbB.transaction.bind(f.dbB);
    let failOnce = true;
    f.dbB.transaction = (async (fn) =>
      origTx(async (tx) => {
        const res = await fn(tx);
        if (failOnce) {
          failOnce = false;
          throw new Error('模拟提交阶段事务回滚');
        }
        return res;
      })) as typeof f.dbB.transaction;

    await expect(
      f.appB.rooms.replace(f.branchId, '李四', emptyModel(), 'will-rollback', beforeRollback.seq),
    ).rejects.toThrow('模拟提交阶段事务回滚');
    f.dbB.transaction = origTx;

    const afterRollback = await f.appB.rooms.model(f.branchId);
    expect(afterRollback.seq).toBe(beforeRollback.seq);
    expect(sameModel(afterRollback.model, beforeRollback.model)).toBe(true);

    // 6c. 主动踢掉 PG LISTEN 连接触发 busB.onReconnect，验证断线重连后自动补齐错过的提交与权限变更
    let reconnected = false;
    const off = f.appB.bus.onReconnect(() => {
      reconnected = true;
    });
    try {
      await f.dbA.query(
        `select pg_terminate_backend(pid)
         from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and query ilike 'listen%'`,
      );
      // 立即在副本 A 写入一条提交并降级李四（模拟断线期间错过的通知）
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n: 1,
          name: 'createTable',
          args: { id: 't_after_disc', schema: f.schemaId, name: 'missed_during_disconnect' },
          reads: [[f.schemaId, 0]],
        },
      });
      await f.dbA.query(
        "update grants set role = 'viewer' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
        [f.bob.id, f.projectId],
      );

      await waitFor(() => reconnected, 10_000);
      await waitFor(
        () => peerB.sent.some((m) => m.t === 'commit' && m.seq === 3) && peerB.peer.role === 'viewer',
        10_000,
      );
      expect(all((await f.appB.rooms.model(f.branchId)).model, 'table').map((t) => t.name)).toContain(
        'missed_during_disconnect',
      );
    } finally {
      off();
    }
  });

  test('7. 跨副本客户端标识隔离：不同用户在不同副本使用相同 client 互不干扰，且 system 被拒绝', async () => {
    const f = await boot('client-isolation');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    const sharedClient = 'tab-same-across-replicas';

    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);

    // 保留字 system 被拒绝关闭
    const peerSys = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerSys.peer);
    await f.appB.rooms.message(f.branchId, peerSys.peer, { t: 'hello', client: 'system', lastSeq: 0 });
    expect(peerSys.closed()?.code).toBe(4400);

    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: sharedClient, lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: sharedClient, lastSeq: 0 });

    // 李四（副本 B）抢先用相同 client 提交 n=1
    await f.appB.rooms.message(f.branchId, peerB.peer, {
      t: 'op',
      op: {
        client: sharedClient,
        n: 1,
        name: 'createTable',
        args: { id: 't_bob_iso', schema: f.schemaId, name: 'bob_iso' },
        reads: [[f.schemaId, 0]],
      },
    });
    await waitFor(() => peerA.sent.some((m) => m.t === 'commit' && m.seq === 1));

    // 张三（副本 A）随后用相同 client 提交 n=1：绝不能被静默丢弃
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: sharedClient,
        n: 1,
        name: 'createTable',
        args: { id: 't_alice_iso', schema: f.schemaId, name: 'alice_iso' },
        reads: [[f.schemaId, 0]],
      },
    });
    await waitFor(() => peerB.sent.some((m) => m.t === 'commit' && m.seq === 2));

    const modelA = await f.appA.rooms.model(f.branchId);
    const modelB = await f.appB.rooms.model(f.branchId);
    expect(modelA.seq).toBe(2);
    expect(modelB.seq).toBe(2);
    expect(
      all(modelA.model, 'table')
        .map((t) => t.name)
        .sort(),
    ).toEqual(['alice_iso', 'bob_iso']);
    expect(sameModel(modelA.model, modelB.model)).toBe(true);
  });

  test('8. 跨副本实例管理员降级后 join：副本 A 降级为 member，副本 B 携带旧升级快照 join 时按最新 users.role 拒绝（4403）', async () => {
    const f = await boot('admin-demote-join');
    // 新建一名无任何项目/组授权的实例管理员（仅凭 users.role='admin' 可访问私有项目）
    const admin2 = await makeUser(f.dbA, 'admin2', { name: '副管理员', role: 'admin' });
    // 模拟 WS 升级瞬间在副本 B 捕获到的旧快照（user.role='admin', role='admin'）
    const peerAdmin2 = makePeer(admin2, 'admin');

    // 副本 A 在升级与 join 之间将其降级为普通 member
    const patch = await callJson(
      f.appA.app,
      'PATCH',
      `/api/admin/users/${admin2.id}`,
      { role: 'member' },
      f.adminCookie,
    );
    expect(patch.status).toBe(200);

    // 副本 B 执行 join 时必须重查 users.role，发现已降级为 member 且无项目权限 → 4403 拒绝
    await f.appB.rooms.join(f.branchId, peerAdmin2.peer);
    expect(peerAdmin2.closed()?.code).toBe(4403);
    expect(peerAdmin2.sent).toHaveLength(0);
    expect(peerAdmin2.peer.user.role).toBe('member');
  });

  test('9. 跨副本 join 挂起期间权限降级 + room.refresh 广播：副本 B 最终收敛为 viewer 且拒绝 op', async () => {
    const f = await boot('join-refresh-race');
    // 预加载副本 B 房间
    const bobPeer = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, bobPeer.peer);

    let enteredResolve!: () => void;
    const entered = new Promise<void>((r) => {
      enteredResolve = r;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((r) => {
      releaseResolve = r;
    });

    // 人为拉慢副本 B 上第一次对张三的 grants 查询（join 的 resolveRole），在读出旧 editor 结果后挂起
    const origQuery = f.dbB.query.bind(f.dbB);
    let intercepted = false;
    f.dbB.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const rows = await origQuery<T>(sql, params);
      if (!intercepted && sql.includes('from grants gr') && params?.[0] === f.alice.id) {
        intercepted = true;
        enteredResolve();
        await release;
      }
      return rows;
    }) as typeof f.dbB.query;

    const alicePeer = makePeer(f.alice, 'editor');
    try {
      const joinPromise = f.appB.rooms.join(f.branchId, alicePeer.peer);
      await entered;

      // 在副本 A 上将张三降级为 viewer 并通过 PG NOTIFY 广播 room.refresh 到副本 B
      await f.dbA.query(
        "update grants set role = 'viewer' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
        [f.alice.id, f.projectId],
      );
      await f.appA.rooms.refreshLoaded();

      // 等待副本 B 收到跨副本 room.refresh 并把挂起中的 alicePeer 降级为 viewer
      await waitFor(() => alicePeer.peer.role === 'viewer');

      // 放行旧 join 的 resolveRole（返回过期的 editor），恢复后绝不能覆盖回 editor
      releaseResolve();
      await joinPromise;
    } finally {
      f.dbB.query = origQuery;
    }

    expect(alicePeer.closed()).toBeNull();
    expect(alicePeer.peer.role).toBe('viewer');
    const roleMsgs = alicePeer.sent.filter((m): m is { t: 'role'; role: Peer['role'] } => m.t === 'role');
    expect(roleMsgs.length).toBeGreaterThan(0);
    expect(roleMsgs.every((m) => m.role === 'viewer')).toBe(true);

    // 确认张三后续发 op 被只读拒绝，模型保持 seq=0
    await f.appB.rooms.message(f.branchId, alicePeer.peer, {
      t: 'hello',
      client: 'c-alice-race',
      lastSeq: 0,
    });
    await f.appB.rooms.message(f.branchId, alicePeer.peer, {
      t: 'op',
      op: {
        client: 'c-alice-race',
        n: 1,
        name: 'createTable',
        args: { id: 't_ha_race_denied', schema: f.schemaId, name: 'ha_race_denied' },
        reads: [[f.schemaId, 0]],
      },
    });
    expect(alicePeer.sent.some((m) => m.t === 'reject' && m.code === 'invalid')).toBe(true);
    expect((await f.appB.rooms.model(f.branchId)).seq).toBe(0);
  });

  test('10. 跨副本连续两次 room.refresh 并发到达（先慢后快）：串行合并收敛到最新角色，不被慢查询倒挂覆盖', async () => {
    const f = await boot('concurrent-refresh');
    const alicePeer = makePeer(f.alice);
    await f.appB.rooms.join(f.branchId, alicePeer.peer);
    await f.appB.rooms.message(f.branchId, alicePeer.peer, { t: 'hello', client: 'c-alice-seq', lastSeq: 0 });

    // 先将张三降为 viewer 作为基线
    await f.dbA.query(
      "update grants set role = 'viewer' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
      [f.alice.id, f.projectId],
    );
    await f.appA.rooms.refreshLoaded();
    await waitFor(() => alicePeer.peer.role === 'viewer');

    let enteredResolve!: () => void;
    const entered = new Promise<void>((r) => {
      enteredResolve = r;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((r) => {
      releaseResolve = r;
    });

    const origQuery = f.dbB.query.bind(f.dbB);
    let intercepted = false;
    f.dbB.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const rows = await origQuery<T>(sql, params);
      if (!intercepted && sql.includes('from grants gr') && params?.[0] === f.alice.id) {
        intercepted = true;
        enteredResolve();
        await release;
      }
      return rows;
    }) as typeof f.dbB.query;

    let refreshEvents = 0;
    const off = f.appB.bus.onEvent((event) => {
      if (event.t === 'room.refresh' && event.origin !== f.appB.bus.replicaId) refreshEvents += 1;
    });

    try {
      // 第一次：副本 A 升级张三为 editor 并广播（副本 B 读出 editor 后挂起）
      await f.dbA.query(
        "update grants set role = 'editor' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
        [f.alice.id, f.projectId],
      );
      await f.appA.rooms.refreshLoaded();
      await entered;

      // 第二次：第一次尚未返回时，副本 A 将张三降回 viewer 并再次广播
      await f.dbA.query(
        "update grants set role = 'viewer' where subject_kind = 'user' and subject_id = $1 and scope_kind = 'project' and scope_id = $2",
        [f.alice.id, f.projectId],
      );
      await f.appA.rooms.refreshLoaded();
      // 等第二次 room.refresh 确实已送达副本 B 并进入排队合并
      await waitFor(() => refreshEvents >= 2);

      // 放行第一次慢查询，验证串行重跑后最终收敛为 viewer（不被第一次的 editor 倒挂覆盖）
      releaseResolve();
      await f.appB.rooms.flush();
    } finally {
      off();
      f.dbB.query = origQuery;
    }

    expect(alicePeer.peer.role).toBe('viewer');
    const roleMsgs = alicePeer.sent.filter((m): m is { t: 'role'; role: Peer['role'] } => m.t === 'role');
    expect(roleMsgs.at(-1)?.role).toBe('viewer');

    await f.appB.rooms.message(f.branchId, alicePeer.peer, {
      t: 'op',
      op: {
        client: 'c-alice-seq',
        n: 1,
        name: 'createTable',
        args: { id: 't_ha_seq_denied', schema: f.schemaId, name: 'ha_seq_denied' },
        reads: [[f.schemaId, 0]],
      },
    });
    expect(alicePeer.sent.some((m) => m.t === 'reject' && m.code === 'invalid')).toBe(true);
    expect((await f.appB.rooms.model(f.branchId)).seq).toBe(0);
  });

  test('11. 跨副本在线成员列表（peers）实时同步、离房/断开更新与 HA 离线副本残留清理', async () => {
    const f = await boot('cross-replica-peers');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);

    // 11a. 协作者 A 先在副本 A 入房并完成 hello，随后协作者 B 才在副本 B 加载房间并完成 hello
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-alice', lastSeq: 0 });

    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-bob', lastSeq: 0 });

    const lastPeersOf = (mp: MockPeer) => {
      const msg = [...mp.sent]
        .reverse()
        .find((m): m is { t: 'peers'; peers: { client: string; user: string }[] } => m.t === 'peers');
      return msg?.peers ?? [];
    };
    const sortedClients = (mp: MockPeer) =>
      lastPeersOf(mp)
        .map((p) => `${p.client}:${p.user}`)
        .sort();

    // 双方均在 peers 消息中看到彼此（协议格式与单机完全一致）
    await waitFor(
      () =>
        JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三', 'c-bob:李四']) &&
        JSON.stringify(sortedClients(peerB)) === JSON.stringify(['c-alice:张三', 'c-bob:李四']),
    );

    // 11b. 协作者 B 在副本 B 离房后，副本 A 上的协作者 A 实时收到更新后的 peers
    await f.appB.rooms.leave(f.branchId, peerB.peer);
    await waitFor(() => JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三']));

    // 11c. 协作者 B 重新连接副本 B 后，副本 B 执行 disconnectAll()（停机断连），副本 A 立即收到移除通知
    const peerB2 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB2.peer);
    await f.appB.rooms.message(f.branchId, peerB2.peer, { t: 'hello', client: 'c-bob-2', lastSeq: 0 });
    await waitFor(
      () => JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三', 'c-bob-2:李四']),
    );
    await f.appB.rooms.disconnectAll();
    await waitFor(() => JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三']));

    // 11d. 启用 HA 租约后模拟副本 B 异常崩溃（未发离房事件仅租约消失），副本 A 结合 aliveNodes 清理残留 remotePeers
    await f.appA.ha.start();
    await f.appB.ha.start();
    try {
      const peerB3 = makePeer(f.bob);
      await f.appB.rooms.join(f.branchId, peerB3.peer);
      await f.appB.rooms.message(f.branchId, peerB3.peer, { t: 'hello', client: 'c-bob-3', lastSeq: 0 });
      await waitFor(
        () => JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三', 'c-bob-3:李四']),
      );

      // 直接停掉副本 B 的 HA 租约而不调 leave/disconnectAll，模拟节点崩溃后租约失效
      await f.appB.ha.stop();
      await f.appA.rooms.pruneDeadRemotePeers();
      await waitFor(() => JSON.stringify(sortedClients(peerA)) === JSON.stringify(['c-alice:张三']));
    } finally {
      await f.appA.ha.stop().catch(() => {});
      await f.appB.ha.stop().catch(() => {});
    }
  });

  test('12. 大画布自动布局（200 张表 > 7500B）立即落库并通过 room.layout.reload 同步到副本 B 在线客户端', async () => {
    const f = await boot('large-layout-reload');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);

    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    let reloadEvents = 0;
    const off = f.appB.bus.onEvent((event) => {
      if (event.t === 'room.layout.reload' && event.branchId === f.branchId) reloadEvents += 1;
    });

    try {
      const positions: Record<string, { x: number; y: number }> = {};
      for (let i = 0; i < 200; i++) {
        positions[`tbl_auto_layout_${String(i).padStart(4, '0')}`] = { x: i * 16, y: i * 24 };
      }
      expect(Buffer.byteLength(JSON.stringify(positions), 'utf8')).toBeGreaterThan(7500);

      // 副本 B 先留一个旧的 tbl_auto_layout_0000 待落库坐标，验证重载时会清掉被远端覆盖的旧 pendingLayout
      await f.appB.rooms.message(f.branchId, peerB.peer, {
        t: 'layout',
        positions: { tbl_auto_layout_0000: { x: 9999, y: 9999 } },
      });
      await waitFor(() =>
        peerA.sent.some((m) => m.t === 'layout' && m.positions.tbl_auto_layout_0000?.x === 9999),
      );

      await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'layout', positions });

      // 发出超大布局后已立即落库
      const [dbRow] = await f.dbA.query<{ layout: Record<string, { x: number; y: number }> }>(
        'select layout from branches where id = $1',
        [f.branchId],
      );
      expect(Object.keys(dbRow?.layout ?? {})).toHaveLength(200);
      expect(dbRow?.layout.tbl_auto_layout_0199).toEqual({ x: 199 * 16, y: 199 * 24 });

      // 副本 B 收到 room.layout.reload 并向在线 peerB 推送全部 200 张表
      await waitFor(() =>
        peerB.sent.some(
          (m) =>
            m.t === 'layout' &&
            Object.keys(m.positions).length === 200 &&
            m.positions.tbl_auto_layout_0000?.x === 0 &&
            m.positions.tbl_auto_layout_0199?.x === 199 * 16,
        ),
      );
      expect(reloadEvents).toBeGreaterThanOrEqual(1);

      // 副本 B 随后 flush() 绝不把旧的 (9999, 9999) 写回数据库覆盖远端自动布局
      await f.appB.rooms.flush();
      const [afterFlushB] = await f.dbA.query<{ layout: Record<string, { x: number; y: number }> }>(
        'select layout from branches where id = $1',
        [f.branchId],
      );
      expect(afterFlushB?.layout.tbl_auto_layout_0000).toEqual({ x: 0, y: 0 });
    } finally {
      off();
    }
  });

  test('13. pendingLayout 防抖期内收到远端 room.layout 不被旧坐标回写覆盖，且 flush() 等待在途 flushLayout 完成', async () => {
    const f = await boot('pending-layout-flush');
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);

    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 13a. 副本 A 拖动 tbl_1=(10,10) 与 tbl_keep=(5,6) 处于防抖期，副本 B 拖动 tbl_1=(99,99) 并广播 + 落库
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 10, y: 10 }, tbl_keep: { x: 5, y: 6 } },
    });
    await waitFor(() =>
      peerB.sent.some((m) => m.t === 'layout' && m.positions.tbl_1?.x === 10 && m.positions.tbl_1?.y === 10),
    );
    await f.appB.rooms.message(f.branchId, peerB.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 99, y: 99 } },
    });
    await f.appB.rooms.flush();

    // 等待副本 A 收到远端 room.layout（同时应清掉本地 pendingLayout.tbl_1）
    await waitFor(() =>
      peerA.sent.some((m) => m.t === 'layout' && m.positions.tbl_1?.x === 99 && m.positions.tbl_1?.y === 99),
    );

    // 副本 A flush()：不得覆盖 tbl_1=(99,99)，且仍正确落库未冲突的 tbl_keep=(5,6)
    await f.appA.rooms.flush();
    const [rowAfterA] = await f.dbA.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [f.branchId],
    );
    expect(rowAfterA?.layout).toEqual({
      tbl_1: { x: 99, y: 99 },
      tbl_keep: { x: 5, y: 6 },
    });

    // 13b. 验证 flush() 正确等待已在途执行的异步 flushLayout 完成
    let enteredResolve!: () => void;
    const entered = new Promise<void>((r) => {
      enteredResolve = r;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((r) => {
      releaseResolve = r;
    });

    const origQuery = f.dbA.query.bind(f.dbA);
    let intercepted = false;
    f.dbA.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!intercepted && sql.includes('update branches set layout')) {
        intercepted = true;
        enteredResolve();
        await release;
      }
      return origQuery<T>(sql, params);
    }) as typeof f.dbA.query;

    try {
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'layout',
        positions: { tbl_inflight: { x: 42, y: 84 } },
      });
      // 等防抖定时器触发进入在途 flushLayout
      await entered;

      let flushFinished = false;
      const flushPromise = f.appA.rooms.flush().then(() => {
        flushFinished = true;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(flushFinished).toBe(false);

      releaseResolve();
      await flushPromise;
      expect(flushFinished).toBe(true);
    } finally {
      f.dbA.query = origQuery;
    }

    const [rowFinal] = await f.dbA.query<{ layout: Record<string, { x: number; y: number }> }>(
      'select layout from branches where id = $1',
      [f.branchId],
    );
    expect(rowFinal?.layout.tbl_inflight).toEqual({ x: 42, y: 84 });
  });

  test('14. PG REPEATABLE READ READ ONLY 快照读消除 loadRoom 与无锁 catchUpFrom 读撕裂（#40）', async () => {
    // 禁用 EventBus，完全由本测试精确编排跨副本并发提交与读暂停窗口
    const f = await boot('rr-snapshot', false);

    // 14a. 先验证无锁 catchUpFrom（hello 路径）在 REPEATABLE READ READ ONLY 事务中执行，且不会发生“旧 seq + 新 lastProcessed”读撕裂
    // 预加载副本 B 房间到 seq=0
    expect((await f.appB.rooms.model(f.branchId)).seq).toBe(0);

    const peerA = makePeer(f.alice);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-tear', lastSeq: 0 });

    const origTxB = f.dbB.transaction.bind(f.dbB);
    let catchUpPausedResolve!: () => void;
    const catchUpPaused = new Promise<void>((r) => {
      catchUpPausedResolve = r;
    });
    let releaseCatchUp!: () => void;
    const catchUpGate = new Promise<void>((r) => {
      releaseCatchUp = r;
    });

    const observedTxModes: { isolation: string; readOnly: string }[] = [];
    let pauseNextCatchUp = true;

    f.dbB.transaction = (async (fn, opts) =>
      origTxB(async (tx) => {
        if (opts?.readOnly) {
          const [meta] = await tx.query<{ iso: string; ro: string }>(
            "select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro",
          );
          if (meta) observedTxModes.push({ isolation: meta.iso, readOnly: meta.ro });
        }
        const wrappedTx: typeof tx = {
          exec: (q) => tx.exec(q),
          query: async <T>(q: string, params?: unknown[]) => {
            const rows = await tx.query<T>(q, params);
            if (
              pauseNextCatchUp &&
              opts?.readOnly &&
              q.includes('from room_commits where branch_id = $1 and seq > $2')
            ) {
              pauseNextCatchUp = false;
              catchUpPausedResolve();
              await catchUpGate;
            }
            return rows;
          },
        };
        return fn(wrappedTx);
      }, opts)) as typeof f.dbB.transaction;

    // 模拟断线重连到副本 B 的 SyncClient：待确认队列里已有 n=1（将由副本 A 提交）与 n=2（将由副本 A 拒绝）
    const client = new SyncClient('c-tear', (await f.appA.rooms.model(f.branchId)).model);
    const createArgs = { id: 'tbl_tear_1', schema: f.schemaId, name: 'tear_ok' };
    client.mutate('createTable', createArgs); // n = 1
    // 手工压入 n = 2（过期版本冲突，将会被副本 A 拒绝）
    client.pending.push({
      client: 'c-tear',
      n: 2,
      name: 'renameTable',
      args: { id: 'tbl_tear_1', name: 'stale_rename' },
      reads: [['tbl_tear_1', 0]],
    });

    const peerB = makePeer(f.alice);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    let sendChain = Promise.resolve();
    const origSend = peerB.peer.send.bind(peerB.peer);
    peerB.peer.send = (msg) => {
      origSend(msg);
      if (msg.t === 'welcome' || msg.t === 'snapshot' || msg.t === 'commit' || msg.t === 'reject') {
        client.receive(msg);
      }
    };
    client.send = (msg) => {
      sendChain = sendChain.then(() => f.appB.rooms.message(f.branchId, peerB.peer, msg));
    };

    try {
      // 触发 hello → 副本 B 进入无锁 catchUpReadOnly 并在读完 room_commits（seq=0）后暂停
      client.connect();
      await catchUpPaused;

      // 在两次查询之间：副本 A 提交 c-tear 的 n=1（seq=1），并拒绝 c-tear 的 n=2（写 room_rejections）
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-tear',
          n: 1,
          name: 'createTable',
          args: createArgs,
          reads: [[f.schemaId, 0]],
        },
      });
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-tear',
          n: 2,
          name: 'renameTable',
          args: { id: 'tbl_tear_1', name: 'stale_rename' },
          reads: [['tbl_tear_1', 0]],
        },
      });
      expect((await f.appA.rooms.model(f.branchId)).seq).toBe(1);

      // 放行副本 B 的 room_rejections 查询
      releaseCatchUp();
      await sendChain;
    } finally {
      f.dbB.transaction = origTxB;
    }

    // 确认副本 B 确实在 REPEATABLE READ + READ ONLY 快照事务中执行
    expect(observedTxModes.length).toBeGreaterThanOrEqual(1);
    expect(observedTxModes[0]).toEqual({ isolation: 'repeatable read', readOnly: 'on' });

    // hello 返回的 welcome 与 snapshot 必须来自同一快照：绝不能出现 seq=0 却配 lastProcessed=2 的读撕裂
    const welcome = peerB.sent.find((m) => m.t === 'welcome') as {
      t: 'welcome';
      lastProcessed: number;
      rejected: { n: number }[];
    };
    const snapshot = peerB.sent.find((m) => m.t === 'snapshot') as {
      t: 'snapshot';
      seq: number;
      lastProcessed: number;
    };
    expect(welcome).toBeDefined();
    expect(snapshot).toBeDefined();
    expect(snapshot.seq).toBe(0);
    expect(snapshot.lastProcessed).toBe(0);
    expect(welcome.lastProcessed).toBe(0);
    expect(welcome.rejected).toEqual([]);

    // 因为没有读撕裂，客户端在收到 snapshot(seq=0, lastProcessed=0) 时不会误丢待确认的 n=1，
    // 并正常触发副本 B 追赶回 commit(seq=1)；confirmed 已包含 n=1 建的表
    await f.appB.rooms.catchUp(f.branchId);
    expect(client.seq).toBe(1);
    expect(all(client.confirmed, 'table').map((t) => t.name)).toEqual(['tear_ok']);
    // 再次握手对齐最新拒绝记录后，n=2 收到拒绝通知，pending 清空，view 与 confirmed 完全一致
    client.connect();
    await sendChain;
    expect(client.pending).toHaveLength(0);
    expect(client.notices.some((x) => x.n === 2)).toBe(true);
    expect(all(client.view, 'table').map((t) => t.name)).toEqual(['tear_ok']);

    // 14b. 再验证 loadRoom 首次冷加载也在 REPEATABLE READ READ ONLY 事务中执行，并发提交 commit + rejection 不撕裂
    const branch2 = `${f.branchId}-cold-rr`;
    await f.dbA.query("insert into branches (id, project_id, name) values ($1, $2, 'cold-rr')", [
      branch2,
      f.projectId,
    ]);
    await f.appA.rooms.init(branch2, (await f.appA.rooms.model(f.branchId)).model);
    const peerA2 = makePeer(f.alice);
    await f.appA.rooms.join(branch2, peerA2.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-tear', lastSeq: 1 });
    await f.appA.rooms.message(branch2, peerA2.peer, { t: 'hello', client: 'c-cold', lastSeq: 0 });

    let loadPausedResolve!: () => void;
    const loadPaused = new Promise<void>((r) => {
      loadPausedResolve = r;
    });
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((r) => {
      releaseLoad = r;
    });
    const loadTxModes: { isolation: string; readOnly: string }[] = [];
    let pauseNextLoad = true;

    f.dbB.transaction = (async (fn, opts) =>
      origTxB(async (tx) => {
        if (opts?.readOnly) {
          const [meta] = await tx.query<{ iso: string; ro: string }>(
            "select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro",
          );
          if (meta) loadTxModes.push({ isolation: meta.iso, readOnly: meta.ro });
        }
        const wrappedTx: typeof tx = {
          exec: (q) => tx.exec(q),
          query: async <T>(q: string, params?: unknown[]) => {
            const rows = await tx.query<T>(q, params);
            if (
              pauseNextLoad &&
              opts?.readOnly &&
              q.includes('from room_commits where branch_id = $1 and seq > $2')
            ) {
              pauseNextLoad = false;
              loadPausedResolve();
              await loadGate;
            }
            return rows;
          },
        };
        return fn(wrappedTx);
      }, opts)) as typeof f.dbB.transaction;

    try {
      // 副本 B 首次冷加载 branch2（在读完 room_commits 后暂停）
      const loadPromise = f.appB.rooms.get(branch2);
      await loadPaused;

      // 并发期间副本 A 提交 c-cold 的 n=1 并拒绝 n=2
      await f.appA.rooms.message(branch2, peerA2.peer, {
        t: 'op',
        op: {
          client: 'c-cold',
          n: 1,
          name: 'createTable',
          args: { id: 'tbl_cold_1', schema: f.schemaId, name: 'cold_ok' },
          reads: [[f.schemaId, 0]],
        },
      });
      await f.appA.rooms.message(branch2, peerA2.peer, {
        t: 'op',
        op: {
          client: 'c-cold',
          n: 2,
          name: 'renameTable',
          args: { id: 'tbl_cold_1', name: 'cold_stale' },
          reads: [['tbl_cold_1', 0]],
        },
      });

      releaseLoad();
      const loadedB = await loadPromise;
      // 首次冷加载在同一 MVCC 快照内完成：seq 与 processed 严格一致（均为 0），绝无撕裂
      expect(loadedB.room.seq).toBe(0);
      expect(loadedB.lastRejectionId).toBe(0);
    } finally {
      f.dbB.transaction = origTxB;
    }

    expect(loadTxModes[0]).toEqual({ isolation: 'repeatable read', readOnly: 'on' });

    // 追赶后立即对齐到 seq=1, lastProcessed=2
    const peerB2 = makePeer(f.alice);
    await f.appB.rooms.join(branch2, peerB2.peer);
    await f.appB.rooms.message(branch2, peerB2.peer, { t: 'hello', client: 'c-cold', lastSeq: 0 });
    const welcomeB2 = peerB2.sent.find((m) => m.t === 'welcome') as {
      t: 'welcome';
      lastProcessed: number;
      rejected: { n: number }[];
    };
    const snapB2 = peerB2.sent.find((m) => m.t === 'snapshot') as {
      t: 'snapshot';
      seq: number;
      lastProcessed: number;
    };
    expect(snapB2.seq).toBe(1);
    expect(snapB2.lastProcessed).toBe(2);
    expect(welcomeB2.lastProcessed).toBe(2);
    expect(welcomeB2.rejected.map((r) => r.n)).toEqual([2]);
  });

  test('15. PG 双副本 catchUpFrom 仅按游标增量拉取 room_rejections，且写事务内复用 tx 不嵌套新事务（#40）', async () => {
    const f = await boot('rej-cursor-pg', false);
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });

    // 副本 A 先建一张表（seq=1），再连续制造 5 条历史冲突拒绝（n=2..6）
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'op',
      op: {
        client: 'c-a',
        n: 1,
        name: 'createTable',
        args: { id: 'tbl_cur', schema: f.schemaId, name: 'cur_base' },
        reads: [[f.schemaId, 0]],
      },
    });
    for (let n = 2; n <= 6; n++) {
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n,
          name: 'renameTable',
          args: { id: 'tbl_cur', name: `stale_${n}` },
          reads: [['tbl_cur', 0]],
        },
      });
    }

    const dbRejIds = (
      await f.dbA.query<{ id: number }>(
        'select id from room_rejections where branch_id = $1 order by id asc',
        [f.branchId],
      )
    ).map((r) => Number(r.id));
    expect(dbRejIds).toHaveLength(5);
    const fifthId = dbRejIds[4]!;

    // 追踪副本 B 上所有事务调用与 room_rejections 查询
    const origTxB = f.dbB.transaction.bind(f.dbB);
    let txDepth = 0;
    let maxTxDepth = 0;
    const rejQueries: { sql: string; params: unknown[]; returned: number; readOnly: boolean }[] = [];

    f.dbB.transaction = (async (fn, opts) => {
      txDepth += 1;
      if (txDepth > maxTxDepth) maxTxDepth = txDepth;
      try {
        return await origTxB(async (tx) => {
          const tracedTx: typeof tx = {
            exec: (q) => tx.exec(q),
            query: async <T>(q: string, params?: unknown[]) => {
              const rows = await tx.query<T>(q, params);
              if (q.includes('from room_rejections')) {
                rejQueries.push({
                  sql: q,
                  params: params ? [...params] : [],
                  returned: rows.length,
                  readOnly: opts?.readOnly === true,
                });
              }
              return rows;
            },
          };
          return fn(tracedTx);
        }, opts);
      } finally {
        txDepth -= 1;
      }
    }) as typeof f.dbB.transaction;

    try {
      // 1. 副本 B 首次追赶（getFresh）：仅拉取 5 条，游标推进到 fifthId
      await f.appB.rooms.model(f.branchId);
      expect(rejQueries).toHaveLength(1);
      expect(rejQueries[0]!.sql).toContain('id > $2');
      expect(rejQueries[0]!.params).toEqual([f.branchId, 0]);
      expect(rejQueries[0]!.returned).toBe(5);
      expect(rejQueries[0]!.readOnly).toBe(true);

      // 2. 副本 B 上在行锁写事务内连续提交 op：catchUpFrom 复用写事务 tx（不嵌套）、带 id > fifthId、返回 0 行
      rejQueries.length = 0;
      await f.appB.rooms.message(f.branchId, peerB.peer, {
        t: 'op',
        op: {
          client: 'c-b',
          n: 1,
          name: 'createTable',
          args: { id: 'tbl_b_1', schema: f.schemaId, name: 'from_b_1' },
          reads: [[f.schemaId, 0]],
        },
      });
      expect(maxTxDepth).toBe(1);
      expect(rejQueries).toHaveLength(1);
      expect(rejQueries[0]!.readOnly).toBe(false);
      expect(rejQueries[0]!.params).toEqual([f.branchId, fifthId]);
      expect(rejQueries[0]!.returned).toBe(0);

      // 3. 副本 A 再新增 1 条拒绝（n=7）：副本 B 追赶时仅拉取新增的 1 行
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n: 7,
          name: 'renameTable',
          args: { id: 'tbl_cur', name: 'stale_7' },
          reads: [['tbl_cur', 0]],
        },
      });
      const [row7] = await f.dbA.query<{ id: number }>(
        'select id from room_rejections where branch_id = $1 and n = 7',
        [f.branchId],
      );
      const seventhId = Number(row7!.id);
      expect(seventhId).toBeGreaterThan(fifthId);

      rejQueries.length = 0;
      await f.appB.rooms.catchUp(f.branchId);
      expect(rejQueries).toHaveLength(1);
      expect(rejQueries[0]!.readOnly).toBe(true);
      expect(rejQueries[0]!.params).toEqual([f.branchId, fifthId]);
      expect(rejQueries[0]!.returned).toBe(1);

      // 4. 张三无粘性迁移到副本 B，hello 验证 lastProcessed=7 与全部 6 条拒绝完整保留，且依赖 n=7 的 op(n=8) 被拒绝（outcome 完整）
      const peerAMigrated = makePeer(f.alice);
      await f.appB.rooms.join(f.branchId, peerAMigrated.peer);
      rejQueries.length = 0;
      await f.appB.rooms.message(f.branchId, peerAMigrated.peer, {
        t: 'hello',
        client: 'c-a',
        lastSeq: 0,
      });
      expect(rejQueries).toHaveLength(1);
      expect(rejQueries[0]!.params).toEqual([f.branchId, seventhId]);
      expect(rejQueries[0]!.returned).toBe(0);

      const welcome = peerAMigrated.sent.find((m) => m.t === 'welcome') as {
        t: 'welcome';
        lastProcessed: number;
        rejected: { n: number }[];
      };
      expect(welcome.lastProcessed).toBe(7);
      expect(welcome.rejected.map((r) => r.n)).toEqual([2, 3, 4, 5, 6, 7]);

      // 发送依赖已被拒绝的 n=7 的 n=8，验证 outcome 已完整同步并按 dependency 拒绝
      await f.appB.rooms.message(f.branchId, peerAMigrated.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n: 8,
          name: 'renameTable',
          args: { id: 'tbl_cur', name: 'dep_on_7' },
          reads: [['tbl_cur', 'p:c-a:7']],
        },
      });
      expect(peerAMigrated.sent.some((m) => m.t === 'reject' && m.n === 8 && m.code === 'dependency')).toBe(
        true,
      );
    } finally {
      f.dbB.transaction = origTxB;
    }
  });

  test('16. PG 双副本空闲房间超时卸载后不再响应 room.commit 查库追赶，再次访问透明重载（#45）', async () => {
    const f = await boot('idle-evict-pg', true, { roomsB: { idleEvictMs: 60 } });
    // 副本 B 仅通过只读 model() 加载房间，无任何在线 peer
    expect((await f.appB.rooms.model(f.branchId)).seq).toBe(0);
    expect(f.appB.rooms.has(f.branchId)).toBe(true);

    // 超过 idleEvictMs 后副本 B 自动卸载该房间
    await waitFor(() => !f.appB.rooms.has(f.branchId), 3000);
    expect(f.appB.rooms.has(f.branchId)).toBe(false);

    // 拦截副本 B 上对 room_commits 的查询计数，并记录是否确实收到了 room.commit 总线事件
    let bCommitQueries = 0;
    const origTxB = f.dbB.transaction.bind(f.dbB);
    f.dbB.transaction = (async (fn, opts) =>
      origTxB(async (tx) => {
        const tracedTx: typeof tx = {
          exec: (q) => tx.exec(q),
          query: async <T>(q: string, params?: unknown[]) => {
            if (q.includes('from room_commits')) bCommitQueries += 1;
            return tx.query<T>(q, params);
          },
        };
        return fn(tracedTx);
      }, opts)) as typeof f.dbB.transaction;

    let commitEventReceived = false;
    const offEvent = f.appB.bus.onEvent((ev) => {
      if (ev.t === 'room.commit' && ev.branchId === f.branchId) commitEventReceived = true;
    });

    try {
      const peerA = makePeer(f.alice);
      await f.appA.rooms.join(f.branchId, peerA.peer);
      await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'op',
        op: {
          client: 'c-a',
          n: 1,
          name: 'createTable',
          args: { id: 'tbl_after_evict', schema: f.schemaId, name: 'after_evict_pg' },
          reads: [[f.schemaId, 0]],
        },
      });

      // 确认副本 B 确实收到了 room.commit，但因已卸载未触发任何 room_commits 查询，也未重新加载
      await waitFor(() => commitEventReceived, 5000);
      await new Promise((r) => setTimeout(r, 80));
      expect(f.appB.rooms.has(f.branchId)).toBe(false);
      expect(bCommitQueries).toBe(0);

      // 再次访问副本 B，透明重载并读到副本 A 的最新提交
      const reloaded = await f.appB.rooms.model(f.branchId);
      expect(reloaded.seq).toBe(1);
      expect(all(reloaded.model, 'table').map((t) => t.name)).toEqual(['after_evict_pg']);
      expect(f.appB.rooms.has(f.branchId)).toBe(true);
    } finally {
      offEvent();
      f.dbB.transaction = origTxB;
    }
  });

  test('17. 冷启动副本（含 N > 1 与 N = 1 字典序落败场景）从 DB 恢复 layout_ver 后首批 layout 更新被热副本接收且收敛（#63）', async () => {
    const f = await boot(
      'cold-layout-clock',
      true,
      { roomsA: { layoutDebounceMs: 250 }, roomsB: { layoutDebounceMs: 250 } },
      { a: 'replica-z-cold-layout', b: 'replica-a-cold-layout' },
    );
    expect(f.appB.rooms.has(f.branchId)).toBe(false);

    const peerA = makePeer(f.alice);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'hello', client: 'c-a', lastSeq: 0 });

    // 1. 热副本 A 连续拖动同一张表 3 次（layoutClock = 3）并落库
    for (let step = 1; step <= 3; step++) {
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'layout',
        positions: { tbl_1: { x: step * 100, y: step * 100 } },
      });
    }
    await f.appA.rooms.flush();
    const [afterHotA] = await f.dbA.query<{ layout_ver: number }>(
      'select layout_ver from branches where id = $1',
      [f.branchId],
    );
    expect(Number(afterHotA?.layout_ver)).toBe(3);

    // 2. 冷副本 B 首次加载分支并提交首笔 layout 编辑：热副本 A 必须接收而不静默丢弃
    const peerB = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'c-b', lastSeq: 0 });
    await f.appB.rooms.message(f.branchId, peerB.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 888, y: 999 } },
    });

    await waitFor(() =>
      peerA.sent.some(
        (m) => m.t === 'layout' && m.positions.tbl_1?.x === 888 && m.positions.tbl_1?.y === 999,
      ),
    );
    await f.appB.rooms.flush();
    const [dbAfterB] = await f.dbA.query<{
      layout: Record<string, { x: number; y: number }>;
      layout_ver: number;
    }>('select layout, layout_ver from branches where id = $1', [f.branchId]);
    expect(dbAfterB?.layout.tbl_1).toEqual({ x: 888, y: 999 });
    expect(Number(dbAfterB?.layout_ver)).toBe(4);

    // 3. 字典序平局场景：N = 1 且 'replica-z-cold-layout' > 'replica-a-cold-layout'
    const branchTie = `${f.branchId}-tie`;
    await f.dbA.query("insert into branches (id, project_id, name) values ($1, $2, 'tie-break')", [
      branchTie,
      f.projectId,
    ]);
    await f.appA.rooms.init(branchTie, emptyModel());

    const peerATie = makePeer(f.alice);
    await f.appA.rooms.join(branchTie, peerATie.peer);
    await f.appA.rooms.message(branchTie, peerATie.peer, {
      t: 'layout',
      positions: { tbl_tie: { x: 10, y: 20 } },
    });
    await f.appA.rooms.flush();
    const [tieDbA] = await f.dbA.query<{ layout_ver: number }>(
      'select layout_ver from branches where id = $1',
      [branchTie],
    );
    expect(Number(tieDbA?.layout_ver)).toBe(1);

    const peerBTie = makePeer(f.bob);
    await f.appB.rooms.join(branchTie, peerBTie.peer);
    await f.appB.rooms.message(branchTie, peerBTie.peer, {
      t: 'layout',
      positions: { tbl_tie: { x: 77, y: 88 } },
    });
    await waitFor(() =>
      peerATie.sent.some(
        (m) => m.t === 'layout' && m.positions.tbl_tie?.x === 77 && m.positions.tbl_tie?.y === 88,
      ),
    );

    await f.appB.rooms.flush();
    const [tieDbFinal] = await f.dbA.query<{
      layout: Record<string, { x: number; y: number }>;
      layout_ver: number;
    }>('select layout, layout_ver from branches where id = $1', [branchTie]);
    expect(tieDbFinal?.layout.tbl_tie).toEqual({ x: 77, y: 88 });
    expect(Number(tieDbFinal?.layout_ver)).toBe(2);
  });

  test('18. 空闲卸载后重载副本的首批小负载与大负载（room.layout.reload）更新均被热副本接收且收敛（#63）', async () => {
    const f = await boot(
      'evict-layout-clock',
      true,
      {
        roomsA: { layoutDebounceMs: 250 },
        roomsB: { idleEvictMs: 60, layoutDebounceMs: 250 },
      },
      { a: 'replica-z-evict-layout', b: 'replica-a-evict-layout' },
    );

    // 1. 副本 B 先加载并离开，等待通过 evictIfIdle() 卸载
    const peerB1 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB1.peer);
    await f.appB.rooms.leave(f.branchId, peerB1.peer);
    await waitFor(() => !f.appB.rooms.has(f.branchId), 3000);
    expect(f.appB.rooms.has(f.branchId)).toBe(false);

    // 2. 热副本 A 编辑 3 次并落库（layout_ver = 3）
    const peerA = makePeer(f.alice);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    for (let step = 1; step <= 3; step++) {
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'layout',
        positions: { tbl_1: { x: step * 10, y: step * 20 } },
      });
    }
    await f.appA.rooms.flush();
    const [afterHotA] = await f.dbA.query<{ layout_ver: number }>(
      'select layout_ver from branches where id = $1',
      [f.branchId],
    );
    expect(Number(afterHotA?.layout_ver)).toBe(3);

    // 3. 副本 B 重载后提交首批小负载 layout 编辑：热副本 A 接收且 DB 收敛
    const peerB2 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB2.peer);
    await f.appB.rooms.message(f.branchId, peerB2.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 555, y: 666 } },
    });
    await waitFor(() =>
      peerA.sent.some(
        (m) => m.t === 'layout' && m.positions.tbl_1?.x === 555 && m.positions.tbl_1?.y === 666,
      ),
    );

    await f.appB.rooms.flush();
    const [dbAfterB2] = await f.dbA.query<{
      layout: Record<string, { x: number; y: number }>;
      layout_ver: number;
    }>('select layout, layout_ver from branches where id = $1', [f.branchId]);
    expect(dbAfterB2?.layout.tbl_1).toEqual({ x: 555, y: 666 });
    expect(Number(dbAfterB2?.layout_ver)).toBe(4);

    // 4. 副本 B 再次空闲卸载，热副本 A 继续编辑（layout_ver = 5）；副本 B 重载后直接发 > 7500B（room.layout.reload 路径）
    await f.appB.rooms.leave(f.branchId, peerB2.peer);
    await waitFor(() => !f.appB.rooms.has(f.branchId), 3000);
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'layout',
      positions: { tbl_1: { x: 700, y: 800 } },
    });
    await f.appA.rooms.flush();
    const [beforeBigB] = await f.dbA.query<{ layout_ver: number }>(
      'select layout_ver from branches where id = $1',
      [f.branchId],
    );
    expect(Number(beforeBigB?.layout_ver)).toBe(5);

    const peerB3 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB3.peer);
    const bigPositions: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 200; i++) {
      bigPositions[`tbl_evict_big_${String(i).padStart(4, '0')}`] = { x: i * 12, y: i * 18 };
    }
    expect(Buffer.byteLength(JSON.stringify(bigPositions), 'utf8')).toBeGreaterThan(7500);
    await f.appB.rooms.message(f.branchId, peerB3.peer, { t: 'layout', positions: bigPositions });

    const [dbAfterBigB] = await f.dbA.query<{
      layout: Record<string, { x: number; y: number }>;
      layout_ver: number;
    }>('select layout, layout_ver from branches where id = $1', [f.branchId]);
    expect(Object.keys(dbAfterBigB?.layout ?? {})).toContain('tbl_evict_big_0199');
    expect(dbAfterBigB?.layout.tbl_evict_big_0199).toEqual({ x: 199 * 12, y: 199 * 18 });
    expect(Number(dbAfterBigB?.layout_ver)).toBe(6);

    await waitFor(() =>
      peerA.sent.some(
        (m) =>
          m.t === 'layout' &&
          Object.keys(m.positions).length >= 200 &&
          m.positions.tbl_evict_big_0199?.x === 199 * 12,
      ),
    );
  });
});

describe('Room.applyExternalCommit / applyExternalRejection 单元测试', () => {
  test('幂等合并外部提交与拒绝记录，校验序号连续性', async () => {
    const { emptyRoomState, memoryStore, Room } = await import('@dowel/sync');
    const state: RoomState = emptyRoomState(emptyModel());
    const room = new Room(state, memoryStore());

    const commit1: Commit = {
      t: 'commit',
      seq: 1,
      client: 'c1',
      n: 1,
      user: '张三',
      changes: [{ id: 's1', obj: { kind: 'schema', id: 's1', name: 'public', comment: null } }],
    };
    expect(room.applyExternalCommit(commit1)).toBe(true);
    expect(room.applyExternalCommit(commit1)).toBe(false); // 幂等
    expect(room.seq).toBe(1);
    expect(room.versions.s1).toBe(1);

    // 序号跳跃报错
    expect(() => room.applyExternalCommit({ ...commit1, seq: 3, n: 2 })).toThrow('外部提交序号不连续');

    // 外部拒绝记录合入后，welcome 包含该拒绝，且重复合入幂等
    expect(room.applyExternalRejection('c1', { n: 2, code: 'conflict', message: '冲突' })).toBe(true);
    expect(room.applyExternalRejection('c1', { n: 2, code: 'conflict', message: '冲突' })).toBe(false);
    const outs = await room.handle('c1', '张三', { t: 'hello', client: 'c1', lastSeq: 1 });
    expect(outs[0]?.msg).toEqual({
      t: 'welcome',
      lastProcessed: 2,
      rejected: [{ n: 2, code: 'conflict', message: '冲突' }],
    });
  });
});
