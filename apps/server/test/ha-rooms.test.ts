// P7 HA2 无状态实时协作房间测试（ADR 0011）：
// 覆盖真实 PostgreSQL 双副本下的实时提交同步、并发写入行锁串行化与冲突拒绝、
// 跨副本 replace(expectedSeq) 并发保护、跨副本停用踢人与角色即时降级、
// 跨副本 layout / presence 转发、断线重连追赶、无粘性客户端跨副本迁移以及事务回滚内存隔离。
import { all, emptyModel, type Model, newId, readsOf } from '@dowel/core';
import { type Commit, type RoomState, SyncClient, type ToClient } from '@dowel/sync';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { type Extra, type Peer, WorkingChangedError } from '../src/rooms.ts';
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

const createDualReplicas = async (tag: string, startBus = true): Promise<DualReplicaFixture> => {
  const safeTag = tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const pg = await createTestDb(safeTag);
  const dbA = await openPlatformDb(pg.url);
  const dbB = await openPlatformDb(pg.url);
  const suffix = newId()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  const channel = `dowel_ha_rooms_${safeTag}_${suffix}`;
  const appA = createApp(dbA, { bus: { replicaId: `replica-a-${safeTag}`, channel } });
  const appB = createApp(dbB, { bus: { replicaId: `replica-b-${safeTag}`, channel } });

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
  afterAll(async () => {
    for (const f of fixtures) await f.close();
  });

  const boot = async (tag: string, startBus = true) => {
    const f = await createDualReplicas(tag, startBus);
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
      const origSend = mp.peer.send;
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
