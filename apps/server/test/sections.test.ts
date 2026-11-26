// 画布板块（Section）的服务端验证、持久化与 HA 跨副本同步测试。
import { type CanvasSection, SECTION_COLORS } from '@dowel/api';
import { createSchema, createTable, emptyModel, type Model, newId } from '@dowel/core';
import type { ToClient } from '@dowel/sync';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import {
  type ClusterEvent,
  type ClusterEventHandler,
  type EventBus,
  MAX_EVENT_BYTES,
  type ReconnectHandler,
} from '../src/bus.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { effectiveProjectRole } from '../src/roles.ts';
import { type Extra, type Peer, Rooms, type RoomsOptions } from '../src/rooms.ts';
import { makeUser, PASSWORD } from './support.ts';

const waitFor = async (predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const makePeer = (user: User, role: Peer['role'] = 'editor') => {
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

describe('SQLite 单机画布板块同步与持久化', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let branchId: string;
  let adminUser: User;
  let editorUser: User;
  let viewerUser: User;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db);

    adminUser = await makeUser(db, 'sec-admin', { name: '项目管理员' });
    editorUser = await makeUser(db, 'sec-editor', { name: '编辑者' });
    viewerUser = await makeUser(db, 'sec-viewer', { name: '查看者' });

    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sec-admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const grp = await created.app.request('/api/groups', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'sections-g', name: '板块测试组', defaultRole: 'none' }),
    });
    const groupId = ((await grp.json()) as { id: string }).id;
    const proj = await created.app.request('/api/projects', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '板块项目', groupId }),
    });
    const pid = ((await proj.json()) as { id: string }).id;
    await db.query(
      `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
       values ($1, 'user', $2, 'editor', 'project', $3),
              ($4, 'user', $5, 'viewer', 'project', $3)`,
      [newId(), editorUser.id, pid, newId(), viewerUser.id],
    );

    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    branchId = b!.id;
  });

  afterAll(async () => {
    created.rooms.close();
    await created.rooms.flush();
    await created.shadows.close();
    await created.bus.close();
    await db.close();
  });

  test('viewer 被拒绝，同表多板块确定性清洗且不进入 IR/提交日志，持久化后重载一致', async () => {
    const pAdmin = makePeer(adminUser);
    const pEditor = makePeer(editorUser);
    const pViewer = makePeer(viewerUser);

    await created.rooms.join(branchId, pAdmin.peer);
    await created.rooms.join(branchId, pEditor.peer);
    await created.rooms.join(branchId, pViewer.peer);

    // 初始 join 收到空板块列表
    expect(pAdmin.sent.find((m) => m.t === 'sections')).toEqual({ t: 'sections', sections: [] });
    const initialModel = await created.rooms.model(branchId);

    // 1. viewer 尝试写板块被静默忽略，不落库也不广播
    const beforeCount = pAdmin.sent.length;
    await created.rooms.message(branchId, pViewer.peer, {
      t: 'sections',
      sections: [{ id: 's-bad', name: '非法', color: 'peer-1', tables: ['t1'] }],
    });
    expect(pAdmin.sent).toHaveLength(beforeCount);

    // 2. editor 发送含重复表归属与异常字段的板块：清洗后广播且每表最多归属 1 个板块
    const dirtySections = [
      { id: 's1', name: '  订单中心  ', color: 'peer-2', tables: ['t1', 't2', 't1'] },
      { id: 's2', name: '用户中心', color: 'invalid-color', tables: ['t2', 't3'] },
      { id: 's3', name: '   ', color: 'peer-3', tables: ['t4'] },
    ] as unknown as CanvasSection[];

    await created.rooms.message(branchId, pEditor.peer, { t: 'sections', sections: dirtySections });

    const expected: CanvasSection[] = [
      { id: 's1', name: '订单中心', color: 'peer-2', tables: ['t1', 't2'] },
      { id: 's2', name: '用户中心', color: SECTION_COLORS[1], tables: ['t3'] },
    ];
    expect(pAdmin.sent.at(-1)).toEqual({ t: 'sections', sections: expected });
    expect(pViewer.sent.at(-1)).toEqual({ t: 'sections', sections: expected });

    // 纯布局层保证：模型 seq 与 IR 毫无变化
    const afterModel = await created.rooms.model(branchId);
    expect(afterModel.seq).toBe(initialModel.seq);
    expect(afterModel.model).toEqual(initialModel.model);
    const commits = await db.query<{ seq: number }>('select seq from room_commits where branch_id = $1', [
      branchId,
    ]);
    expect(commits).toHaveLength(0);

    // 3. flush 后用全新 Rooms 实例加载，验证从 branches.sections 读回并推给新 peer
    await created.rooms.flush();
    const freshRooms = new Rooms(db, (u, pid, l) => effectiveProjectRole(db, u, pid, l));
    try {
      const pLate = makePeer(adminUser);
      await freshRooms.join(branchId, pLate.peer);
      expect(pLate.sent.find((m) => m.t === 'sections')).toEqual({ t: 'sections', sections: expected });

      // 清空板块同样持久化与同步
      await freshRooms.message(branchId, pLate.peer, { t: 'sections', sections: [] });
      await freshRooms.flush();
      const [row] = await db.query<{ sections: CanvasSection[] }>(
        'select sections from branches where id = $1',
        [branchId],
      );
      expect(row?.sections).toEqual([]);
    } finally {
      freshRooms.close();
      await freshRooms.flush();
    }
  });
});

describe.skipIf(!PG_URL)('PG HA 双副本画布板块同步与大负载 reload 兜底', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!().catch(() => {});
    }
  });

  const boot = async (
    tag: string,
    roomsOpts?: RoomsOptions | { roomsA?: RoomsOptions; roomsB?: RoomsOptions },
    replicaIds?: { a?: string; b?: string },
  ) => {
    const safeTag = tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const pg = await createTestDb(safeTag);
    const dbA = await openPlatformDb(pg.url);
    const dbB = await openPlatformDb(pg.url);
    const suffix = newId()
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase();
    const channel = `dowel_ha_sec_${safeTag}_${suffix}`;
    const splitOpts =
      roomsOpts && ('roomsA' in roomsOpts || 'roomsB' in roomsOpts)
        ? (roomsOpts as { roomsA?: RoomsOptions; roomsB?: RoomsOptions })
        : undefined;
    const roomsAOpts = splitOpts ? splitOpts.roomsA : (roomsOpts as RoomsOptions | undefined);
    const roomsBOpts = splitOpts ? splitOpts.roomsB : (roomsOpts as RoomsOptions | undefined);
    const appA = createApp(dbA, {
      bus: { replicaId: replicaIds?.a ?? `sec-a-${safeTag}`, channel },
      rooms: roomsAOpts,
    });
    const appB = createApp(dbB, {
      bus: { replicaId: replicaIds?.b ?? `sec-b-${safeTag}`, channel },
      rooms: roomsBOpts,
    });
    await appA.bus.start();
    await appB.bus.start();

    cleanups.push(async () => {
      appA.rooms.close();
      appB.rooms.close();
      await Promise.all([appA.rooms.flush(), appB.rooms.flush()]);
      await Promise.all([appA.shadows.close(), appB.shadows.close()]);
      await Promise.all([appA.bus.close(), appB.bus.close()]);
      await Promise.all([appA.ha.stop().catch(() => {}), appB.ha.stop().catch(() => {})]);
      await Promise.all([dbA.close(), dbB.close()]);
      await pg.close();
    });

    const admin = await makeUser(dbA, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(dbA, 'alice', { name: '张三' });
    const bob = await makeUser(dbA, 'bob', { name: '李四' });
    const login = await appA.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const grp = await appA.app.request('/api/groups', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'ha-sec', name: 'HA 板块组', defaultRole: 'editor' }),
    });
    const groupId = ((await grp.json()) as { id: string }).id;
    const proj = await appA.app.request('/api/projects', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'HA 板块项目', groupId }),
    });
    const pid = ((await proj.json()) as { id: string }).id;
    for (const u of [alice, bob]) {
      const g = await appA.app.request(`/api/projects/${pid}/grants`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ subjectKind: 'user', subjectId: u.id, role: 'editor' }),
      });
      expect(g.status).toBe(201);
    }
    const [b] = await dbA.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    return { dbA, dbB, appA, appB, projectId: pid, branchId: b!.id, admin, alice, bob };
  };

  test('小负载板块经 room.sections 跨副本同步，大负载（> 7500B）立即落库经 room.sections.reload 同步且不被旧 pending 覆写', async () => {
    const f = await boot('ha-sections', { layoutDebounceMs: 250 });
    const peerA = makePeer(f.alice);
    const peerB = makePeer(f.bob);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    expect(peerA.closed()).toBeNull();
    expect(peerB.closed()).toBeNull();

    // 1. 常规大小板块同步
    const small: CanvasSection[] = [
      { id: 'sec-core', name: '核心交易', color: 'peer-1', tables: ['t1', 't2'] },
    ];
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'sections', sections: small });
    await waitFor(() =>
      peerB.sent.some(
        (m) => m.t === 'sections' && m.sections.length === 1 && m.sections[0]?.id === 'sec-core',
      ),
    );

    // 2. 构造超过 MAX_EVENT_BYTES (7500B) 的板块定义
    const large: CanvasSection[] = Array.from({ length: 160 }, (_, i) => ({
      id: `sec_large_${String(i).padStart(3, '0')}`,
      name: `业务板块_${String(i).padStart(3, '0')}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length]!,
      tables: [`tbl_domain_${i}_a`, `tbl_domain_${i}_b`],
    }));
    expect(Buffer.byteLength(JSON.stringify(large), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);

    let reloadEvents = 0;
    const off = f.appB.bus.onEvent((ev) => {
      if (ev.t === 'room.sections.reload' && ev.branchId === f.branchId) reloadEvents += 1;
    });

    try {
      // 先让副本 B 有一个待落盘旧修改（在防抖期内），随后副本 A 发超大板块
      await f.appB.rooms.message(f.branchId, peerB.peer, {
        t: 'sections',
        sections: [{ id: 'stale-b', name: '旧板块', color: 'peer-5', tables: ['t999'] }],
      });
      await waitFor(() =>
        peerA.sent.some((m) => m.t === 'sections' && m.sections.some((s) => s.id === 'stale-b')),
      );

      await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'sections', sections: large });

      // 副本 A 超限时已立即落库
      const [dbRow] = await f.dbA.query<{ sections: CanvasSection[] }>(
        'select sections from branches where id = $1',
        [f.branchId],
      );
      expect(dbRow?.sections).toHaveLength(160);

      // 副本 B 收到 room.sections.reload 并从库重读后推送 160 个板块给 peerB
      await waitFor(() =>
        peerB.sent.some(
          (m) => m.t === 'sections' && m.sections.length === 160 && m.sections[0]?.id === 'sec_large_000',
        ),
      );
      expect(reloadEvents).toBeGreaterThanOrEqual(1);

      // 副本 B flush() 绝不拿旧 pending 覆写 DB
      await f.appB.rooms.flush();
      const [afterFlushB] = await f.dbA.query<{ sections: CanvasSection[] }>(
        'select sections from branches where id = $1',
        [f.branchId],
      );
      expect(afterFlushB?.sections).toHaveLength(160);
      expect(afterFlushB?.sections[0]?.id).toBe('sec_large_000');
    } finally {
      off();
    }
  });

  test('冷启动副本（含 N > 1 与 N = 1 字典序落败场景）从 DB 恢复 sections_ver 后首批 sections 更新被热副本接收且收敛（#63）', async () => {
    const f = await boot(
      'cold-sections-clock',
      { layoutDebounceMs: 250 },
      { a: 'sec-z-cold', b: 'sec-a-cold' },
    );
    expect(f.appB.rooms.has(f.branchId)).toBe(false);

    const peerA = makePeer(f.alice);
    await f.appA.rooms.join(f.branchId, peerA.peer);

    // 1. 热副本 A 连续推进 sectionsClock 至 N = 3 并落库
    for (let step = 1; step <= 3; step++) {
      await f.appA.rooms.message(f.branchId, peerA.peer, {
        t: 'sections',
        sections: [{ id: `sec-a-${step}`, name: `热副本-${step}`, color: 'peer-1', tables: ['t1'] }],
      });
    }
    await f.appA.rooms.flush();
    const [afterHotA] = await f.dbA.query<{ sections_ver: number }>(
      'select sections_ver from branches where id = $1',
      [f.branchId],
    );
    expect(Number(afterHotA?.sections_ver)).toBe(3);

    // 2. 冷副本 B 首次加载分支并提交首笔 sections 编辑，热副本 A 必须接收而不静默丢弃
    const peerB = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    expect(peerB.sent.find((m) => m.t === 'sections')).toEqual({
      t: 'sections',
      sections: [{ id: 'sec-a-3', name: '热副本-3', color: 'peer-1', tables: ['t1'] }],
    });

    const bCold: CanvasSection[] = [
      { id: 'sec-b-cold', name: '冷启动首笔', color: 'peer-2', tables: ['t1', 't2'] },
    ];
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'sections', sections: bCold });
    await waitFor(() => peerA.sent.some((m) => m.t === 'sections' && m.sections[0]?.id === 'sec-b-cold'));

    await f.appB.rooms.flush();
    const [dbAfterB] = await f.dbA.query<{ sections: CanvasSection[]; sections_ver: number }>(
      'select sections, sections_ver from branches where id = $1',
      [f.branchId],
    );
    expect(dbAfterB?.sections).toEqual(bCold);
    expect(Number(dbAfterB?.sections_ver)).toBe(4);

    // 3. 字典序平局场景：N = 1 且 'sec-z-cold' > 'sec-a-cold'
    const branchTie = `${f.branchId}-tie`;
    await f.dbA.query("insert into branches (id, project_id, name) values ($1, $2, 'tie')", [
      branchTie,
      f.projectId,
    ]);
    await f.appA.rooms.init(branchTie, emptyModel());

    const peerATie = makePeer(f.alice);
    await f.appA.rooms.join(branchTie, peerATie.peer);
    await f.appA.rooms.message(branchTie, peerATie.peer, {
      t: 'sections',
      sections: [{ id: 'sec-tie-a1', name: '热副本-1', color: 'peer-3', tables: ['t1'] }],
    });
    await f.appA.rooms.flush();
    const [tieDbA] = await f.dbA.query<{ sections_ver: number }>(
      'select sections_ver from branches where id = $1',
      [branchTie],
    );
    expect(Number(tieDbA?.sections_ver)).toBe(1);

    const peerBTie = makePeer(f.bob);
    await f.appB.rooms.join(branchTie, peerBTie.peer);
    const bTie: CanvasSection[] = [{ id: 'sec-tie-b', name: '冷副本反超', color: 'peer-4', tables: ['t2'] }];
    await f.appB.rooms.message(branchTie, peerBTie.peer, { t: 'sections', sections: bTie });
    await waitFor(() => peerATie.sent.some((m) => m.t === 'sections' && m.sections[0]?.id === 'sec-tie-b'));

    await f.appB.rooms.flush();
    const [tieDbFinal] = await f.dbA.query<{ sections: CanvasSection[]; sections_ver: number }>(
      'select sections, sections_ver from branches where id = $1',
      [branchTie],
    );
    expect(tieDbFinal?.sections).toEqual(bTie);
    expect(Number(tieDbFinal?.sections_ver)).toBe(2);
  });

  test('空闲卸载后重载副本的首批小负载与大负载（room.sections.reload）更新均被热副本接收且收敛（#63）', async () => {
    const f = await boot(
      'evict-sections-clock',
      {
        roomsA: { layoutDebounceMs: 250 },
        roomsB: { idleEvictMs: 60, layoutDebounceMs: 250 },
      },
      { a: 'sec-z-evict', b: 'sec-a-evict' },
    );

    // 1. 副本 B 先加载并离开，等待其通过 evictIfIdle() 卸载
    const peerB1 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB1.peer);
    await f.appB.rooms.leave(f.branchId, peerB1.peer);
    await waitFor(() => !f.appB.rooms.has(f.branchId), 3000);
    expect(f.appB.rooms.has(f.branchId)).toBe(false);

    // 2. 热副本 A 推进 sectionsClock（含 1 次 > 7500B room.sections.reload 立即落库）
    const peerA = makePeer(f.alice);
    await f.appA.rooms.join(f.branchId, peerA.peer);
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'sections',
      sections: [{ id: 'sec-a-s1', name: 'A1', color: 'peer-1', tables: ['t1'] }],
    });
    const largeA: CanvasSection[] = Array.from({ length: 160 }, (_, i) => ({
      id: `sec_a_big_${String(i).padStart(3, '0')}`,
      name: `A大板块_${i}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length]!,
      tables: [`tbl_a_${i}_1`, `tbl_a_${i}_2`],
    }));
    expect(Buffer.byteLength(JSON.stringify(largeA), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);
    await f.appA.rooms.message(f.branchId, peerA.peer, { t: 'sections', sections: largeA });
    await f.appA.rooms.flush();

    const [afterHotA] = await f.dbA.query<{ sections_ver: number }>(
      'select sections_ver from branches where id = $1',
      [f.branchId],
    );
    const verAfterHotA = Number(afterHotA?.sections_ver);
    expect(verAfterHotA).toBe(2);

    // 3. 副本 B 重载后提交首批小负载 sections 编辑：热副本 A 接收且 DB 收敛
    const peerB2 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB2.peer);
    const smallB: CanvasSection[] = [
      { id: 'sec-b-after-evict', name: '重载后小板块', color: 'peer-3', tables: ['t1'] },
    ];
    await f.appB.rooms.message(f.branchId, peerB2.peer, { t: 'sections', sections: smallB });
    await waitFor(() =>
      peerA.sent.some((m) => m.t === 'sections' && m.sections[0]?.id === 'sec-b-after-evict'),
    );

    await f.appB.rooms.flush();
    const [dbAfterSmallB] = await f.dbA.query<{ sections: CanvasSection[]; sections_ver: number }>(
      'select sections, sections_ver from branches where id = $1',
      [f.branchId],
    );
    expect(dbAfterSmallB?.sections).toEqual(smallB);
    expect(Number(dbAfterSmallB?.sections_ver)).toBe(verAfterHotA + 1);

    // 4. 副本 B 再次空闲卸载，热副本 A 继续推进时钟；副本 B 重载后直接发 > 7500B（room.sections.reload 路径）
    await f.appB.rooms.leave(f.branchId, peerB2.peer);
    await waitFor(() => !f.appB.rooms.has(f.branchId), 3000);
    await f.appA.rooms.message(f.branchId, peerA.peer, {
      t: 'sections',
      sections: [{ id: 'sec-a-s3', name: 'A3', color: 'peer-4', tables: ['t2'] }],
    });
    await f.appA.rooms.flush();

    const [beforeLargeB] = await f.dbA.query<{ sections_ver: number }>(
      'select sections_ver from branches where id = $1',
      [f.branchId],
    );
    expect(Number(beforeLargeB?.sections_ver)).toBe(verAfterHotA + 2);

    const peerB3 = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB3.peer);
    const largeB: CanvasSection[] = Array.from({ length: 160 }, (_, i) => ({
      id: `sec_b_big_${String(i).padStart(3, '0')}`,
      name: `B大板块_${i}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length]!,
      tables: [`tbl_b_${i}_1`, `tbl_b_${i}_2`],
    }));
    expect(Buffer.byteLength(JSON.stringify(largeB), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);
    await f.appB.rooms.message(f.branchId, peerB3.peer, { t: 'sections', sections: largeB });

    const [dbAfterLargeB] = await f.dbA.query<{ sections: CanvasSection[]; sections_ver: number }>(
      'select sections, sections_ver from branches where id = $1',
      [f.branchId],
    );
    expect(dbAfterLargeB?.sections).toHaveLength(160);
    expect(dbAfterLargeB?.sections[0]?.id).toBe('sec_b_big_000');
    expect(Number(dbAfterLargeB?.sections_ver)).toBe(verAfterHotA + 3);

    await waitFor(() =>
      peerA.sent.some(
        (m) => m.t === 'sections' && m.sections.length === 160 && m.sections[0]?.id === 'sec_b_big_000',
      ),
    );
  });
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const makeFakeBus = (replicaId: string) => {
  const eventHandlers = new Set<ClusterEventHandler>();
  const reconnectHandlers = new Set<ReconnectHandler>();
  const bus = {
    replicaId,
    channel: 'sections_race_test',
    onEvent: (handler: ClusterEventHandler) => {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    onReconnect: (handler: ReconnectHandler) => {
      reconnectHandlers.add(handler);
      return () => {
        reconnectHandlers.delete(handler);
      };
    },
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
    publish: () => Promise.resolve(),
  } as unknown as EventBus;
  const emit = async (event: ClusterEvent) => {
    for (const handler of [...eventHandlers]) {
      await handler(event);
    }
  };
  const emitReconnect = async () => {
    for (const handler of [...reconnectHandlers]) {
      await handler();
    }
  };
  return { bus, emit, emitReconnect };
};

describe('画布板块在途落库与重载竞态回归', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let projectId: string;
  let editorUser: User;
  let branchCounter = 0;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db);

    await makeUser(db, 'sec-race-admin', { name: '竞态测试管理员' });
    editorUser = await makeUser(db, 'sec-race-editor', { name: '竞态测试编辑者' });

    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sec-race-admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const grp = await created.app.request('/api/groups', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'sections-race-g', name: '板块竞态测试组', defaultRole: 'none' }),
    });
    const groupId = ((await grp.json()) as { id: string }).id;
    const proj = await created.app.request('/api/projects', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '板块竞态项目', groupId }),
    });
    projectId = ((await proj.json()) as { id: string }).id;
    await db.query(
      `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
       values ($1, 'user', $2, 'editor', 'project', $3)`,
      [newId(), editorUser.id, projectId],
    );
  });

  afterAll(async () => {
    created.rooms.close();
    await created.rooms.flush();
    await created.shadows.close();
    await created.bus.close();
    await db.close();
  });

  const setupRaceRoom = async () => {
    branchCounter += 1;
    const branchId = `sec-race-${branchCounter}-${newId()}`;
    await db.query('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId,
      projectId,
      `race-${branchCounter}`,
    ]);
    const fakeBus = makeFakeBus('replica-b');
    const rooms = new Rooms(
      db,
      (u, pid, lookup) => effectiveProjectRole(db, u, pid, lookup),
      fakeBus.bus,
      undefined,
      { layoutDebounceMs: 5000 },
    );
    await rooms.init(branchId, emptyModel());
    const peerB = makePeer(editorUser);
    await rooms.join(branchId, peerB.peer);
    return { branchId, fakeBus, rooms, peerB };
  };

  test('在途旧 flushSections(B1) 与更新远端 room.sections(A2) 并发时，DB 自动幂等自愈为 A2 且无多余循环', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredFirstUpdate = deferred();
    const releaseFirstUpdate = deferred();
    let updateCount = 0;

    const b1: CanvasSection[] = [{ id: 'sec-b1', name: '本地旧板块', color: 'peer-1', tables: ['t1'] }];
    const a2: CanvasSection[] = [{ id: 'sec-a2', name: '远端新板块', color: 'peer-2', tables: ['t2'] }];

    try {
      await rooms.message(branchId, peerB.peer, { t: 'sections', sections: b1 });

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('update branches set sections')) {
          updateCount += 1;
          if (updateCount === 1) {
            enteredFirstUpdate.resolve();
            await releaseFirstUpdate.promise;
          }
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const flushPromise = rooms.flush();
      await enteredFirstUpdate.promise;

      // 在途 B1 尚未落库时，副本 A 已将 A2 写入 DB 并广播 room.sections
      await origQuery('update branches set sections = $2::text::jsonb where id = $1', [
        branchId,
        JSON.stringify(a2),
      ]);
      await fakeBus.emit({ t: 'room.sections', origin: 'replica-a', branchId, sections: a2, ver: 2 });
      expect(peerB.sent.at(-1)).toEqual({ t: 'sections', sections: a2 });

      // 放行在途旧 SQL B1（后落盘覆写 DB 为 B1），flushSections 应感知版本变更并自愈回写 A2
      releaseFirstUpdate.resolve();
      await flushPromise;

      expect(updateCount).toBe(2);
      const [row] = await origQuery<{ sections: CanvasSection[] }>(
        'select sections from branches where id = $1',
        [branchId],
      );
      expect(row?.sections).toEqual(a2);

      // 再次 flush 不再触发额外写库（无无限循环）
      await rooms.flush();
      expect(updateCount).toBe(2);
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadSectionsFromDb 严格等待在途 sectionsFlushing 排空后再查询 DB', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredUpdate = deferred();
    const releaseUpdate = deferred();
    const events: string[] = [];

    const b1: CanvasSection[] = [{ id: 'sec-b1', name: '本地先刷板块', color: 'peer-3', tables: ['t1'] }];
    const a2: CanvasSection[] = [
      { id: 'sec-a2', name: '远端重载板块', color: 'peer-4', tables: ['t2', 't3'] },
    ];

    try {
      await rooms.message(branchId, peerB.peer, { t: 'sections', sections: b1 });

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('update branches set sections')) {
          events.push('update:start');
          enteredUpdate.resolve();
          await releaseUpdate.promise;
          const res = await origQuery<T>(sql, params);
          // 模拟 B1 写完后远端 A2 落库（reload 应当在 sectionsFlushing 完成后再读取到此结果）
          await origQuery('update branches set sections = $2::text::jsonb where id = $1', [
            branchId,
            JSON.stringify(a2),
          ]);
          events.push('update:end');
          return res;
        }
        if (sql.includes('select sections') && sql.includes('from branches')) {
          events.push('select:start');
          const res = await origQuery<T>(sql, params);
          events.push('select:end');
          return res;
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const flushPromise = rooms.flush();
      await enteredUpdate.promise;

      const reloadPromise = fakeBus.emit({
        t: 'room.sections.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual(['update:start']);

      releaseUpdate.resolve();
      await Promise.all([flushPromise, reloadPromise]);

      expect(events).toEqual(['update:start', 'update:end', 'select:start', 'select:end']);
      expect(peerB.sent.at(-1)).toEqual({ t: 'sections', sections: a2 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadSectionsFromDb 查库挂起期间出现更新的本地写入（sectionsWriteSeq 递增）时，跳过旧重载不覆盖新状态', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const peerObserver = makePeer(editorUser);
    await rooms.join(branchId, peerObserver.peer);

    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();

    const a2: CanvasSection[] = [{ id: 'sec-a2', name: '过时远端重载', color: 'peer-5', tables: ['t1'] }];
    const b3: CanvasSection[] = [{ id: 'sec-b3', name: '最新本地写入', color: 'peer-6', tables: ['t9'] }];

    try {
      await origQuery('update branches set sections = $2::text::jsonb where id = $1', [
        branchId,
        JSON.stringify(a2),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select sections') && sql.includes('from branches')) {
          enteredSelect.resolve();
          await releaseSelect.promise;
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const reloadPromise = fakeBus.emit({
        t: 'room.sections.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await enteredSelect.promise;

      // 查库挂起期间本地收到更新的板块写入 B3
      await rooms.message(branchId, peerB.peer, { t: 'sections', sections: b3 });

      releaseSelect.resolve();
      await reloadPromise;

      // 旧重载被拦截，不会向节点推送过时的 A2，也不会清掉待刷的 B3
      expect(peerB.sent.some((m) => m.t === 'sections' && m.sections.some((s) => s.id === 'sec-a2'))).toBe(
        false,
      );
      expect(
        peerObserver.sent.some((m) => m.t === 'sections' && m.sections.some((s) => s.id === 'sec-a2')),
      ).toBe(false);
      expect(peerObserver.sent.at(-1)).toEqual({ t: 'sections', sections: b3 });

      db.query = origQuery;
      await rooms.flush();
      const [row] = await origQuery<{ sections: CanvasSection[] }>(
        'select sections from branches where id = $1',
        [branchId],
      );
      expect(row?.sections).toEqual(b3);
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('flushLayout / flushSections 写入较小版本号时绝不降级已持久化的 layout_ver / sections_ver，且回传后推进内存时钟（#63）', async () => {
    const { branchId, rooms, peerB } = await setupRaceRoom();
    try {
      // 模拟外部已将 DB 时钟推进到 10，而本地房间早先载入时时钟为 0
      await db.query('update branches set layout_ver = 10, sections_ver = 10 where id = $1', [branchId]);

      await rooms.message(branchId, peerB.peer, { t: 'layout', positions: { tbl_mono: { x: 1, y: 2 } } });
      await rooms.message(branchId, peerB.peer, {
        t: 'sections',
        sections: [{ id: 'sec-mono', name: '单调性', color: 'peer-1', tables: ['tbl_mono'] }],
      });
      await rooms.flush();

      // 第 1 轮本地时钟为 1：DB 保持 10 不被降级
      const [afterFirst] = await db.query<{ layout_ver: number; sections_ver: number }>(
        'select layout_ver, sections_ver from branches where id = $1',
        [branchId],
      );
      expect(afterFirst).toEqual({ layout_ver: 10, sections_ver: 10 });

      // RETURNING 已将内存时钟追齐到 10：下一次编辑直接推进到 11
      await rooms.message(branchId, peerB.peer, { t: 'layout', positions: { tbl_mono: { x: 3, y: 4 } } });
      await rooms.message(branchId, peerB.peer, {
        t: 'sections',
        sections: [{ id: 'sec-mono-2', name: '单调性-2', color: 'peer-2', tables: ['tbl_mono'] }],
      });
      await rooms.flush();

      const [afterSecond] = await db.query<{ layout_ver: number; sections_ver: number }>(
        'select layout_ver, sections_ver from branches where id = $1',
        [branchId],
      );
      expect(afterSecond).toEqual({ layout_ver: 11, sections_ver: 11 });
    } finally {
      rooms.close();
      await rooms.flush();
    }
  });

  test('handleBusReconnect 绝不用 ver = 0 或较旧 DB 快照回退较新内存 layout / sections，且防护 await 期间并发 >7500B 写入（#63）', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const s1: CanvasSection[] = [{ id: 'sec-r1', name: '内存新版板块', color: 'peer-1', tables: ['tbl_1'] }];
    const s2: CanvasSection[] = [{ id: 'sec-r2', name: 'DB追赶板块', color: 'peer-2', tables: ['tbl_1'] }];
    try {
      // 1. DB 仍停留在初始 layout_ver = 0 / sections_ver = 0，内存收到远端 ver = 1 更新
      await db.query(
        'update branches set layout = $2::text::jsonb, layout_ver = 0, sections = $3::text::jsonb, sections_ver = 0 where id = $1',
        [branchId, JSON.stringify({ tbl_1: { x: 10, y: 10 } }), JSON.stringify([])],
      );
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 500, y: 500 }, tbl_mem_only: { x: 77, y: 88 } },
        ver: 1,
      });
      await fakeBus.emit({
        t: 'room.sections',
        origin: 'replica-a',
        branchId,
        sections: s1,
        ver: 1,
      });

      const sentAfterRemote = peerB.sent.length;
      await fakeBus.emitReconnect();
      expect(peerB.sent.slice(sentAfterRemote).some((m) => m.t === 'layout' || m.t === 'sections')).toBe(
        false,
      );

      const peerCheck1 = makePeer(editorUser);
      await rooms.join(branchId, peerCheck1.peer);
      expect(peerCheck1.sent).toContainEqual({
        t: 'layout',
        positions: { tbl_1: { x: 500, y: 500 }, tbl_mem_only: { x: 77, y: 88 } },
      });
      expect(peerCheck1.sent).toContainEqual({ t: 'sections', sections: s1 });
      await rooms.leave(branchId, peerCheck1.peer);

      // 2. DB 停留在 layout_ver = 1（含 tbl_db_only），内存 tbl_1 已在 ver = 2：只合入缺失表，绝不回退 tbl_1
      await db.query('update branches set layout = $2::text::jsonb, layout_ver = 1 where id = $1', [
        branchId,
        JSON.stringify({ tbl_1: { x: 100, y: 100 }, tbl_db_only: { x: 200, y: 200 } }),
      ]);
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 600, y: 600 } },
        ver: 2,
      });

      const sentBeforeSub2 = peerB.sent.length;
      await fakeBus.emitReconnect();
      const layoutMsgsSub2 = peerB.sent
        .slice(sentBeforeSub2)
        .filter((m): m is Extract<ToClient | Extra, { t: 'layout' }> => m.t === 'layout');
      expect(layoutMsgsSub2).toHaveLength(1);
      expect(layoutMsgsSub2[0]?.positions).toEqual({
        tbl_1: { x: 600, y: 600 },
        tbl_mem_only: { x: 77, y: 88 },
        tbl_db_only: { x: 200, y: 200 },
      });

      // 3. DB 真正领先（layout_ver = 3, sections_ver = 2）时，重连正常追赶到 DB 最新状态
      await db.query(
        'update branches set layout = $2::text::jsonb, layout_ver = 3, sections = $3::text::jsonb, sections_ver = 2 where id = $1',
        [branchId, JSON.stringify({ tbl_1: { x: 900, y: 900 } }), JSON.stringify(s2)],
      );
      const sentBeforeSub3 = peerB.sent.length;
      await fakeBus.emitReconnect();
      const msgsSub3 = peerB.sent.slice(sentBeforeSub3);
      expect(msgsSub3).toContainEqual({
        t: 'layout',
        positions: {
          tbl_1: { x: 900, y: 900 },
          tbl_mem_only: { x: 77, y: 88 },
          tbl_db_only: { x: 200, y: 200 },
        },
      });
      expect(msgsSub3).toContainEqual({ t: 'sections', sections: s2 });
    } finally {
      rooms.close();
      await rooms.flush();
    }

    // 4. 跨 await 并发竞态：handleBusReconnect 查库刚读完 ver = 0 旧快照并挂起时，本机完成 >7500B 编辑并排空，恢复后绝不回退
    const race2 = await setupRaceRoom();
    const peerObs = makePeer(editorUser);
    await race2.rooms.join(race2.branchId, peerObs.peer);
    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();
    let pausedOnce = false;

    const bigPositions: Record<string, { x: number; y: number }> = { tbl_0: { x: 777, y: 888 } };
    for (let i = 0; i < 200; i++) {
      bigPositions[`tbl_recon_big_${String(i).padStart(4, '0')}`] = { x: i * 10, y: i * 20 };
    }
    const largeSections: CanvasSection[] = Array.from({ length: 160 }, (_, i) => ({
      id: `sec_recon_big_${String(i).padStart(3, '0')}`,
      name: `重连大板块_${i}`,
      color: SECTION_COLORS[i % SECTION_COLORS.length]!,
      tables: [`tbl_recon_big_${String(i).padStart(4, '0')}`],
    }));
    expect(Buffer.byteLength(JSON.stringify(bigPositions), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(largeSections), 'utf8')).toBeGreaterThan(MAX_EVENT_BYTES);

    try {
      await origQuery(
        'update branches set layout = $2::text::jsonb, layout_ver = 0, sections = $3::text::jsonb, sections_ver = 0 where id = $1',
        [race2.branchId, JSON.stringify({ tbl_0: { x: 1, y: 1 } }), JSON.stringify([])],
      );

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const res = await origQuery<T>(sql, params);
        if (!pausedOnce && sql.includes('select layout, sections, layout_ver, sections_ver from branches')) {
          pausedOnce = true;
          enteredSelect.resolve();
          await releaseSelect.promise;
        }
        return res;
      }) as typeof db.query;

      const reconnectPromise = race2.fakeBus.emitReconnect();
      await enteredSelect.promise;

      await race2.rooms.message(race2.branchId, race2.peerB.peer, { t: 'layout', positions: bigPositions });
      await race2.rooms.message(race2.branchId, race2.peerB.peer, { t: 'sections', sections: largeSections });
      const sentBeforeResume = peerObs.sent.length;

      releaseSelect.resolve();
      await reconnectPromise;

      expect(peerObs.sent.slice(sentBeforeResume).some((m) => m.t === 'layout' || m.t === 'sections')).toBe(
        false,
      );

      db.query = origQuery;
      const peerAfter = makePeer(editorUser);
      await race2.rooms.join(race2.branchId, peerAfter.peer);
      const layoutAfter = peerAfter.sent.find(
        (m): m is Extract<ToClient | Extra, { t: 'layout' }> => m.t === 'layout',
      );
      const sectionsAfter = peerAfter.sent.find(
        (m): m is Extract<ToClient | Extra, { t: 'sections' }> => m.t === 'sections',
      );
      expect(layoutAfter?.positions.tbl_0).toEqual({ x: 777, y: 888 });
      expect(layoutAfter?.positions.tbl_recon_big_0199).toEqual({ x: 1990, y: 3980 });
      expect(sectionsAfter?.sections).toHaveLength(160);
      expect(sectionsAfter?.sections[0]?.id).toBe('sec_recon_big_000');
    } finally {
      db.query = origQuery;
      race2.rooms.close();
      await race2.rooms.flush();
    }
  });

  test('Rooms.load() 与 evictIfIdle() 重载为 DB 已有表预填 layoutVersions，拒绝迟到 N - 1 事件且接受新表与 N + 1（#63）', async () => {
    branchCounter += 1;
    const branchId = `sec-race-${branchCounter}-${newId()}`;
    await db.query('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId,
      projectId,
      `race-${branchCounter}`,
    ]);
    const fakeBus = makeFakeBus('replica-b');
    const rooms = new Rooms(
      db,
      (u, pid, lookup) => effectiveProjectRole(db, u, pid, lookup),
      fakeBus.bus,
      undefined,
      { idleEvictMs: 25, layoutDebounceMs: 5000 },
    );
    await rooms.init(branchId, emptyModel());
    try {
      await db.query('update branches set layout = $2::text::jsonb, layout_ver = 3 where id = $1', [
        branchId,
        JSON.stringify({ tbl_1: { x: 300, y: 300 } }),
      ]);

      // 1. 冷加载预填 layoutVersions：拒绝 N - 1 的 room.layout 与 room.layout.reload
      const peer1 = makePeer(editorUser);
      await rooms.join(branchId, peer1.peer);
      expect(peer1.sent).toContainEqual({ t: 'layout', positions: { tbl_1: { x: 300, y: 300 } } });
      const count0 = peer1.sent.length;

      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 11, y: 22 } },
        ver: 2,
      });
      expect(peer1.sent).toHaveLength(count0);

      // 即使 DB 被篡改，迟到 ver = 2 的 room.layout.reload 也不得覆盖已载入 tbl_1，且无多余广播
      await db.query('update branches set layout = $2::text::jsonb, layout_ver = 3 where id = $1', [
        branchId,
        JSON.stringify({ tbl_1: { x: 99, y: 99 } }),
      ]);
      await fakeBus.emit({ t: 'room.layout.reload', origin: 'replica-a', branchId, ver: 2 });
      expect(peer1.sent).toHaveLength(count0);

      // 2. DB 加载时不存在的新表不设基线版本，ver = 2 合法新表事件可被正常接收
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_new: { x: 44, y: 55 } },
        ver: 2,
      });
      expect(peer1.sent.at(-1)).toEqual({ t: 'layout', positions: { tbl_new: { x: 44, y: 55 } } });

      // 3. ver = N + 1 对已有表正常生效
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 400, y: 400 } },
        ver: 4,
      });
      expect(peer1.sent.at(-1)).toEqual({ t: 'layout', positions: { tbl_1: { x: 400, y: 400 } } });

      // 4. 空闲卸载后重载同样预填 layoutVersions，拒绝 ver = 3 并接受 ver = 5
      await db.query('update branches set layout = $2::text::jsonb, layout_ver = 4 where id = $1', [
        branchId,
        JSON.stringify({ tbl_1: { x: 400, y: 400 }, tbl_new: { x: 44, y: 55 } }),
      ]);
      await rooms.leave(branchId, peer1.peer);
      await waitFor(() => !rooms.has(branchId), 3000);

      const peer2 = makePeer(editorUser);
      await rooms.join(branchId, peer2.peer);
      expect(peer2.sent).toContainEqual({
        t: 'layout',
        positions: { tbl_1: { x: 400, y: 400 }, tbl_new: { x: 44, y: 55 } },
      });
      const countB2 = peer2.sent.length;

      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 1, y: 2 } },
        ver: 3,
      });
      await db.query('update branches set layout = $2::text::jsonb, layout_ver = 4 where id = $1', [
        branchId,
        JSON.stringify({ tbl_1: { x: 77, y: 77 }, tbl_new: { x: 44, y: 55 } }),
      ]);
      await fakeBus.emit({ t: 'room.layout.reload', origin: 'replica-a', branchId, ver: 3 });
      expect(peer2.sent).toHaveLength(countB2);

      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-a',
        branchId,
        positions: { tbl_1: { x: 500, y: 500 } },
        ver: 5,
      });
      expect(peer2.sent.at(-1)).toEqual({ t: 'layout', positions: { tbl_1: { x: 500, y: 500 } } });
    } finally {
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadLayoutFromDb 严格等待在途 layoutFlushing 排空后再查询 DB（#63）', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredUpdate = deferred();
    const releaseUpdate = deferred();
    const events: string[] = [];

    const a2 = { tbl_1: { x: 222, y: 222 } };

    try {
      await rooms.message(branchId, peerB.peer, { t: 'layout', positions: { tbl_1: { x: 111, y: 111 } } });

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('update branches set layout')) {
          events.push('update:start');
          enteredUpdate.resolve();
          await releaseUpdate.promise;
          const res = await origQuery<T>(sql, params);
          await origQuery('update branches set layout = $2::text::jsonb, layout_ver = 2 where id = $1', [
            branchId,
            JSON.stringify(a2),
          ]);
          events.push('update:end');
          return res;
        }
        if (sql.includes('select layout') && sql.includes('from branches')) {
          events.push('select:start');
          const res = await origQuery<T>(sql, params);
          events.push('select:end');
          return res;
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const flushPromise = rooms.flush();
      await enteredUpdate.promise;

      const reloadPromise = fakeBus.emit({
        t: 'room.layout.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual(['update:start']);

      releaseUpdate.resolve();
      await Promise.all([flushPromise, reloadPromise]);

      expect(events).toEqual(['update:start', 'update:end', 'select:start', 'select:end']);
      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: a2 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('在途旧 flushLayout(B1) 与更新远端 room.layout(A2) 并发时，DB 自动幂等自愈为 A2 且无多余循环（#63）', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredFirstUpdate = deferred();
    const releaseFirstUpdate = deferred();
    let updateCount = 0;

    const b1 = { tbl_1: { x: 111, y: 111 } };
    const a2 = { tbl_1: { x: 222, y: 222 } };

    try {
      await rooms.message(branchId, peerB.peer, { t: 'layout', positions: b1 });

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('update branches set layout')) {
          updateCount += 1;
          if (updateCount === 1) {
            enteredFirstUpdate.resolve();
            await releaseFirstUpdate.promise;
          }
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const flushPromise = rooms.flush();
      await enteredFirstUpdate.promise;

      // 在途 B1 尚未落库时，副本 A 已将 A2 写入 DB 并广播 room.layout(ver = 2)
      await origQuery('update branches set layout = $2::text::jsonb, layout_ver = 2 where id = $1', [
        branchId,
        JSON.stringify(a2),
      ]);
      await fakeBus.emit({ t: 'room.layout', origin: 'replica-a', branchId, positions: a2, ver: 2 });
      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: a2 });

      // 放行在途旧 SQL B1（后落盘将 DB 覆写回 B1），flushLayout 应感知版本变更并自愈回写 A2
      releaseFirstUpdate.resolve();
      await flushPromise;

      expect(updateCount).toBe(2);
      const [row] = await origQuery<{ layout: Record<string, { x: number; y: number }>; layout_ver: number }>(
        'select layout, layout_ver from branches where id = $1',
        [branchId],
      );
      expect(row?.layout).toEqual(a2);
      expect(Number(row?.layout_ver)).toBe(2);

      // 再次 flush 不再触发额外写库（无无限循环）
      await rooms.flush();
      expect(updateCount).toBe(2);
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadSectionsFromDb 当 DB 持久化版本高于事件版本时以 effectiveIncoming 胜出（#63）', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();

    const s5: CanvasSection[] = [{ id: 'sec-s5', name: 'DB高版本', color: 'peer-5', tables: ['t5'] }];
    const s3: CanvasSection[] = [{ id: 'sec-s3', name: '并发中间版', color: 'peer-3', tables: ['t3'] }];

    try {
      await origQuery('update branches set sections = $2::text::jsonb, sections_ver = 5 where id = $1', [
        branchId,
        JSON.stringify(s5),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const res = await origQuery<T>(sql, params);
        if (sql.includes('select sections') && sql.includes('from branches')) {
          enteredSelect.resolve();
          await releaseSelect.promise;
        }
        return res;
      }) as typeof db.query;

      const reloadPromise = fakeBus.emit({
        t: 'room.sections.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await enteredSelect.promise;

      // 查库返回前收到 ver = 3 的内存事件，但 DB 持久化的是 ver = 5，effectiveIncoming 应以 ver = 5 胜出
      await fakeBus.emit({
        t: 'room.sections',
        origin: 'replica-c',
        branchId,
        sections: s3,
        ver: 3,
      });
      expect(peerB.sent.at(-1)).toEqual({ t: 'sections', sections: s3 });

      releaseSelect.resolve();
      await reloadPromise;

      expect(peerB.sent.at(-1)).toEqual({ t: 'sections', sections: s5 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadLayoutFromDb 当 DB 持久化版本高于事件版本时以 effectiveIncoming 胜出并写回 layoutVersions（#63）', async () => {
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();

    const l5 = { tbl_1: { x: 500, y: 500 }, tbl_2: { x: 520, y: 520 } };
    const l3 = { tbl_1: { x: 300, y: 300 } };

    try {
      await origQuery('update branches set layout = $2::text::jsonb, layout_ver = 5 where id = $1', [
        branchId,
        JSON.stringify(l5),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const res = await origQuery<T>(sql, params);
        if (sql.includes('select layout, layout_ver from branches')) {
          enteredSelect.resolve();
          await releaseSelect.promise;
        }
        return res;
      }) as typeof db.query;

      const reloadPromise = fakeBus.emit({
        t: 'room.layout.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await enteredSelect.promise;

      // 查库返回前收到 ver = 3 的并发事件，但 DB 持久化的是 ver = 5，effectiveIncoming 应以 ver = 5 胜出
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-c',
        branchId,
        positions: l3,
        ver: 3,
      });
      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: l3 });

      releaseSelect.resolve();
      await reloadPromise;

      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: l5 });

      // 后续迟到的 ver = 3 / ver = 4 room.layout 必须被已写回的 ver = 5 版本号拦截
      const countAtVer5 = peerB.sent.length;
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-c',
        branchId,
        positions: { tbl_1: { x: 333, y: 333 }, tbl_2: { x: 344, y: 344 } },
        ver: 3,
      });
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-c',
        branchId,
        positions: { tbl_1: { x: 444, y: 444 }, tbl_2: { x: 455, y: 455 } },
        ver: 4,
      });
      expect(peerB.sent).toHaveLength(countAtVer5);

      const observer = makePeer(editorUser);
      await rooms.join(branchId, observer.peer);
      expect(observer.sent).toContainEqual({ t: 'layout', positions: l5 });
      await rooms.leave(branchId, observer.peer);

      // ver = 6 更新正常生效
      const l6 = { tbl_1: { x: 600, y: 600 }, tbl_2: { x: 620, y: 620 } };
      await fakeBus.emit({
        t: 'room.layout',
        origin: 'replica-c',
        branchId,
        positions: l6,
        ver: 6,
      });
      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: l6 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }
  });

  test('reloadLayoutFromDb 查库挂起期间，rooms.flush() 与防抖定时器等待重载完成且不写入陈旧 ver = 1（#63）', async () => {
    // 1. rooms.flush() 场景
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();
    const events: string[] = [];
    let updateCount = 0;

    const b1 = { tbl_1: { x: 111, y: 111 } };
    const a2 = { tbl_1: { x: 222, y: 222 } };

    try {
      await rooms.message(branchId, peerB.peer, { t: 'layout', positions: b1 });
      await origQuery('update branches set layout = $2::text::jsonb, layout_ver = 2 where id = $1', [
        branchId,
        JSON.stringify(a2),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select layout, layout_ver from branches')) {
          events.push('select:start');
          enteredSelect.resolve();
          await releaseSelect.promise;
          const res = await origQuery<T>(sql, params);
          events.push('select:end');
          return res;
        }
        if (sql.includes('update branches set layout')) {
          updateCount += 1;
          events.push('update');
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const reloadPromise = fakeBus.emit({
        t: 'room.layout.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await enteredSelect.promise;

      const flushPromise = rooms.flush();
      await new Promise((r) => setTimeout(r, 20));
      expect(updateCount).toBe(0);
      expect(events).toEqual(['select:start']);

      releaseSelect.resolve();
      await Promise.all([reloadPromise, flushPromise]);

      expect(events).toEqual(['select:start', 'select:end']);
      expect(updateCount).toBe(0);
      expect(peerB.sent.at(-1)).toEqual({ t: 'layout', positions: a2 });

      const [row1] = await origQuery<{
        layout: Record<string, { x: number; y: number }>;
        layout_ver: number;
      }>('select layout, layout_ver from branches where id = $1', [branchId]);
      expect(row1?.layout).toEqual(a2);
      expect(Number(row1?.layout_ver)).toBe(2);

      db.query = origQuery;
      const obs1 = makePeer(editorUser);
      await rooms.join(branchId, obs1.peer);
      expect(obs1.sent).toContainEqual({ t: 'layout', positions: a2 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }

    // 2. 真实防抖定时器到期场景
    branchCounter += 1;
    const branchId2 = `sec-race-${branchCounter}-${newId()}`;
    await origQuery('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId2,
      projectId,
      `race-${branchCounter}`,
    ]);
    const fakeBus2 = makeFakeBus('replica-b');
    const rooms2 = new Rooms(
      db,
      (u, pid, lookup) => effectiveProjectRole(db, u, pid, lookup),
      fakeBus2.bus,
      undefined,
      { layoutDebounceMs: 40 },
    );
    await rooms2.init(branchId2, emptyModel());
    const peerB2 = makePeer(editorUser);
    await rooms2.join(branchId2, peerB2.peer);

    const enteredSelect2 = deferred();
    const releaseSelect2 = deferred();
    let updateCount2 = 0;

    try {
      await origQuery('update branches set layout = $2::text::jsonb, layout_ver = 2 where id = $1', [
        branchId2,
        JSON.stringify(a2),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select layout, layout_ver from branches')) {
          enteredSelect2.resolve();
          await releaseSelect2.promise;
        }
        if (sql.includes('update branches set layout')) {
          updateCount2 += 1;
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      await rooms2.message(branchId2, peerB2.peer, { t: 'layout', positions: b1 });
      const reloadPromise2 = fakeBus2.emit({
        t: 'room.layout.reload',
        origin: 'replica-a',
        branchId: branchId2,
        ver: 2,
      });
      await enteredSelect2.promise;

      // 等待超过 40ms 防抖延迟，确认定时器触发时被 IO 锁阻塞等待而不会在 SELECT 期间写库
      await new Promise((r) => setTimeout(r, 100));
      expect(updateCount2).toBe(0);

      releaseSelect2.resolve();
      await reloadPromise2;
      await rooms2.flush();

      expect(updateCount2).toBe(0);
      expect(peerB2.sent.at(-1)).toEqual({ t: 'layout', positions: a2 });
      const [row2] = await origQuery<{
        layout: Record<string, { x: number; y: number }>;
        layout_ver: number;
      }>('select layout, layout_ver from branches where id = $1', [branchId2]);
      expect(row2?.layout).toEqual(a2);
      expect(Number(row2?.layout_ver)).toBe(2);
    } finally {
      db.query = origQuery;
      rooms2.close();
      await rooms2.flush();
    }
  });

  test('reloadSectionsFromDb 查库挂起期间，rooms.flush() 与防抖定时器等待重载完成且不写入陈旧 ver = 1（#63）', async () => {
    // 1. rooms.flush() 场景
    const { branchId, fakeBus, rooms, peerB } = await setupRaceRoom();
    const origQuery = db.query.bind(db);
    const enteredSelect = deferred();
    const releaseSelect = deferred();
    const events: string[] = [];
    let updateCount = 0;

    const s1: CanvasSection[] = [{ id: 'sec-b1', name: '本地旧板块', color: 'peer-1', tables: ['t1'] }];
    const s2: CanvasSection[] = [{ id: 'sec-a2', name: '远端新板块', color: 'peer-2', tables: ['t2'] }];

    try {
      await rooms.message(branchId, peerB.peer, { t: 'sections', sections: s1 });
      await origQuery('update branches set sections = $2::text::jsonb, sections_ver = 2 where id = $1', [
        branchId,
        JSON.stringify(s2),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select sections, sections_ver from branches')) {
          events.push('select:start');
          enteredSelect.resolve();
          await releaseSelect.promise;
          const res = await origQuery<T>(sql, params);
          events.push('select:end');
          return res;
        }
        if (sql.includes('update branches set sections')) {
          updateCount += 1;
          events.push('update');
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      const reloadPromise = fakeBus.emit({
        t: 'room.sections.reload',
        origin: 'replica-a',
        branchId,
        ver: 2,
      });
      await enteredSelect.promise;

      const flushPromise = rooms.flush();
      await new Promise((r) => setTimeout(r, 20));
      expect(updateCount).toBe(0);
      expect(events).toEqual(['select:start']);

      releaseSelect.resolve();
      await Promise.all([reloadPromise, flushPromise]);

      expect(events).toEqual(['select:start', 'select:end']);
      expect(updateCount).toBe(0);
      expect(peerB.sent.at(-1)).toEqual({ t: 'sections', sections: s2 });

      const [row1] = await origQuery<{ sections: CanvasSection[]; sections_ver: number }>(
        'select sections, sections_ver from branches where id = $1',
        [branchId],
      );
      expect(row1?.sections).toEqual(s2);
      expect(Number(row1?.sections_ver)).toBe(2);

      db.query = origQuery;
      const obs1 = makePeer(editorUser);
      await rooms.join(branchId, obs1.peer);
      expect(obs1.sent).toContainEqual({ t: 'sections', sections: s2 });
    } finally {
      db.query = origQuery;
      rooms.close();
      await rooms.flush();
    }

    // 2. 真实防抖定时器到期场景
    branchCounter += 1;
    const branchId2 = `sec-race-${branchCounter}-${newId()}`;
    await origQuery('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId2,
      projectId,
      `race-${branchCounter}`,
    ]);
    const fakeBus2 = makeFakeBus('replica-b');
    const rooms2 = new Rooms(
      db,
      (u, pid, lookup) => effectiveProjectRole(db, u, pid, lookup),
      fakeBus2.bus,
      undefined,
      { layoutDebounceMs: 40 },
    );
    await rooms2.init(branchId2, emptyModel());
    const peerB2 = makePeer(editorUser);
    await rooms2.join(branchId2, peerB2.peer);

    const enteredSelect2 = deferred();
    const releaseSelect2 = deferred();
    let updateCount2 = 0;

    try {
      await origQuery('update branches set sections = $2::text::jsonb, sections_ver = 2 where id = $1', [
        branchId2,
        JSON.stringify(s2),
      ]);

      db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        if (sql.includes('select sections, sections_ver from branches')) {
          enteredSelect2.resolve();
          await releaseSelect2.promise;
        }
        if (sql.includes('update branches set sections')) {
          updateCount2 += 1;
        }
        return origQuery<T>(sql, params);
      }) as typeof db.query;

      await rooms2.message(branchId2, peerB2.peer, { t: 'sections', sections: s1 });
      const reloadPromise2 = fakeBus2.emit({
        t: 'room.sections.reload',
        origin: 'replica-a',
        branchId: branchId2,
        ver: 2,
      });
      await enteredSelect2.promise;

      await new Promise((r) => setTimeout(r, 100));
      expect(updateCount2).toBe(0);

      releaseSelect2.resolve();
      await reloadPromise2;
      await rooms2.flush();

      expect(updateCount2).toBe(0);
      expect(peerB2.sent.at(-1)).toEqual({ t: 'sections', sections: s2 });
      const [row2] = await origQuery<{ sections: CanvasSection[]; sections_ver: number }>(
        'select sections, sections_ver from branches where id = $1',
        [branchId2],
      );
      expect(row2?.sections).toEqual(s2);
      expect(Number(row2?.sections_ver)).toBe(2);
    } finally {
      db.query = origQuery;
      rooms2.close();
      await rooms2.flush();
    }
  });
});

// ───── MCP manage_sections：锁内增量合并、并发重放与条件写（ADR 0015 第 1 节） ─────

const makeRecordingBus = (replicaId: string) => {
  const fake = makeFakeBus(replicaId);
  const published: ClusterEvent[] = [];
  (fake.bus as unknown as { publish: (e: object) => Promise<void> }).publish = async (e) => {
    published.push({ origin: replicaId, ...e } as ClusterEvent);
  };
  return { ...fake, published };
};

describe('manage_sections：房间锁内增量板块写入（SQLite）', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let projectId: string;
  let editorUser: User;
  let counter = 0;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db);
    await makeUser(db, 'msec-admin', { name: '板块管理员' });
    editorUser = await makeUser(db, 'msec-editor', { name: '板块编辑者' });
    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'msec-admin', password: PASSWORD }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const grp = await created.app.request('/api/groups', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'msec-g', name: '增量板块组', defaultRole: 'none' }),
    });
    const groupId = ((await grp.json()) as { id: string }).id;
    const proj = await created.app.request('/api/projects', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '增量板块项目', groupId }),
    });
    projectId = ((await proj.json()) as { id: string }).id;
    await db.query(
      `insert into grants (id, subject_kind, subject_id, role, scope_kind, scope_id)
       values ($1, 'user', $2, 'editor', 'project', $3)`,
      [newId(), editorUser.id, projectId],
    );
  });

  afterAll(async () => {
    created.rooms.close();
    await created.rooms.flush();
    await created.shadows.close();
    await created.bus.close();
    await db.close();
  });

  const setup = async (tableCount = 3) => {
    counter += 1;
    const branchId = `msec-${counter}-${newId()}`;
    await db.query('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId,
      projectId,
      `msec-${counter}`,
    ]);
    const model: Model = emptyModel();
    const schema = createSchema(model, 'public');
    const tables = Array.from({ length: tableCount }, (_, i) => createTable(model, schema, `t${i + 1}`));
    const part = createTable(model, schema, 'p1');
    const partObj = model.objects[part]!;
    if (partObj.kind === 'table') partObj.partitionOf = { parent: tables[0]!, bound: 'DEFAULT' };
    const bus = makeRecordingBus('replica-m');
    const rooms = new Rooms(
      db,
      (u, pid, lookup) => effectiveProjectRole(db, u, pid, lookup),
      bus.bus,
      undefined,
      { layoutDebounceMs: 5000 },
    );
    await rooms.init(branchId, model);
    const peer = makePeer(editorUser);
    await rooms.join(branchId, peer.peer);
    const dbRow = async () => {
      const [row] = await db.query<{ sections: CanvasSection[]; sections_ver: number | string }>(
        'select sections, sections_ver from branches where id = $1',
        [branchId],
      );
      return { sections: row!.sections, ver: Number(row!.sections_ver) };
    };
    return { branchId, rooms, bus, peer, tables, part, schema, dbRow };
  };

  test('合并尚未落盘的 WS 防抖编辑，落库后清 pending，并广播给本地 peers 与其他副本；不进 IR / seq', async () => {
    const f = await setup();
    try {
      const human: CanvasSection[] = [{ id: 'sec-h', name: '人工', color: 'peer-1', tables: [f.tables[0]!] }];
      await f.rooms.message(f.branchId, f.peer.peer, { t: 'sections', sections: human });
      const r = await f.rooms.get(f.branchId);
      expect(r.sectionsPending).toBe(true);
      expect((await f.dbRow()).sections).toEqual([]);
      const before = await f.rooms.model(f.branchId);

      const res = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'create', id: 'sec-ai', name: 'AI 板块', tables: [f.tables[1]!, f.tables[0]!] }],
      });
      expect(res).toMatchObject({ ok: true, dryRun: false, sectionsVer: 2 });
      const expected: CanvasSection[] = [
        { id: 'sec-h', name: '人工', color: 'peer-1', tables: [] },
        { id: 'sec-ai', name: 'AI 板块', color: SECTION_COLORS[1], tables: [f.tables[1]!, f.tables[0]!] },
      ];
      expect(res.ok && res.sections).toEqual(expected);
      expect(res.ok && res.moved).toEqual([{ tableId: f.tables[0]!, from: 'sec-h', to: 'sec-ai' }]);
      expect(await f.dbRow()).toEqual({ sections: expected, ver: 2 });
      expect(r.sectionsPending).toBe(false);
      expect(r.sectionsTimer).toBeUndefined();
      expect(r.sections).toEqual(expected);
      expect(f.peer.sent.at(-1)).toEqual({ t: 'sections', sections: expected });
      expect(f.bus.published.at(-1)).toMatchObject({ t: 'room.sections', sections: expected, ver: 2 });

      const after = await f.rooms.model(f.branchId);
      expect(after.seq).toBe(before.seq);
      expect(after.model).toEqual(before.model);
      expect(await db.query('select seq from room_commits where branch_id = $1', [f.branchId])).toEqual([]);

      const state = await f.rooms.canvasState(f.branchId);
      expect(state.sections).toEqual(expected);
      expect(state.sectionsVer).toBe(2);
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('校验失败 / noop / dryRun：零写库、零回调、零广播', async () => {
    const f = await setup();
    try {
      const first = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'create', id: 'sec-1', name: '一', tables: [f.tables[0]!] }],
      });
      expect(first.ok).toBe(true);
      const snapshot = await f.dbRow();
      const sentBefore = f.peer.sent.length;
      const publishedBefore = f.bus.published.length;
      let calls = 0;
      const onBeforeCommit = async () => {
        calls += 1;
      };

      const missing = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'add_tables', section: 'sec-1', tables: ['no-such-table', f.schema] }],
        onBeforeCommit,
      });
      expect(missing).toMatchObject({
        ok: false,
        code: 'table_not_found',
        index: 0,
        tableIds: ['no-such-table', f.schema],
      });
      const partition = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'add_tables', section: 'sec-1', tables: [f.part] }],
        onBeforeCommit,
      });
      expect(partition).toMatchObject({ ok: false, code: 'invalid', index: 0 });
      const notFound = await f.rooms.manageSections(f.branchId, {
        actions: [
          { action: 'rename', section: 'sec-1', name: '改名' },
          { action: 'delete', section: 'sec-x' },
        ],
        onBeforeCommit,
      });
      expect(notFound).toMatchObject({ ok: false, code: 'section_not_found', index: 1 });

      const noop = await f.rooms.manageSections(f.branchId, {
        actions: [
          { action: 'rename', section: 'sec-1', name: '一' },
          { action: 'remove_tables', section: 'sec-1', tables: ['never-there'] },
        ],
        onBeforeCommit,
      });
      expect(noop).toMatchObject({ ok: true, noop: true, sectionsVer: snapshot.ver });

      const dry = await f.rooms.manageSections(f.branchId, {
        dryRun: true,
        actions: [{ action: 'create', id: 'sec-dry', name: '预演' }],
        onBeforeCommit,
      });
      expect(dry).toMatchObject({ ok: true, dryRun: true, sectionsVer: snapshot.ver + 1 });
      expect(dry.ok && dry.sections.map((x) => x.id)).toEqual(['sec-1', 'sec-dry']);
      expect(dry.ok && dry.noop).toBeUndefined();

      expect(calls).toBe(0);
      expect(await f.dbRow()).toEqual(snapshot);
      expect(f.peer.sent).toHaveLength(sentBefore);
      expect(f.bus.published).toHaveLength(publishedBefore);
      expect((await f.rooms.get(f.branchId)).sections.map((x) => x.id)).toEqual(['sec-1']);
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('onBeforeCommit 抛错：整次板块写入原子回滚，内存与 DB 均不变且不广播', async () => {
    const f = await setup();
    try {
      const sentBefore = f.peer.sent.length;
      await expect(
        f.rooms.manageSections(f.branchId, {
          actions: [{ action: 'create', id: 'sec-boom', name: '回滚' }],
          onBeforeCommit: async (tx) => {
            await tx.query("update branches set name = 'renamed-in-tx' where id = $1", [f.branchId]);
            throw new Error('审计写入失败');
          },
        }),
      ).rejects.toThrow('审计写入失败');
      expect(await f.dbRow()).toEqual({ sections: [], ver: 0 });
      const [b] = await db.query<{ name: string }>('select name from branches where id = $1', [f.branchId]);
      expect(b!.name).not.toBe('renamed-in-tx');
      const r = await f.rooms.get(f.branchId);
      expect(r.sections).toEqual([]);
      expect(r.sectionsPending).toBe(false);
      expect(f.peer.sent).toHaveLength(sentBefore);
      expect(f.bus.published.filter((e) => e.t.startsWith('room.sections'))).toEqual([]);
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('事务等待期间穿插 WS 编辑：用同一批动作（复用生成的 ID）在人的最新编辑上重放并排期落盘', async () => {
    const f = await setup();
    try {
      const human: CanvasSection[] = [
        { id: 'sec-human', name: '人工新建', color: 'peer-4', tables: [f.tables[2]!] },
      ];
      const res = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'create', id: 'sec-ai', name: 'AI', tables: [f.tables[0]!] }],
        onBeforeCommit: async () => {
          // 事务挂起期间同副本到达了人的 WS 全量板块（基于不含本批的旧状态）
          await f.rooms.message(f.branchId, f.peer.peer, { t: 'sections', sections: human });
        },
      });
      const merged: CanvasSection[] = [
        ...human,
        { id: 'sec-ai', name: 'AI', color: SECTION_COLORS[1], tables: [f.tables[0]!] },
      ];
      expect(res).toMatchObject({ ok: true, sections: merged });
      expect(res.ok && res.superseded).toBeUndefined();
      const r = await f.rooms.get(f.branchId);
      expect(r.sections).toEqual(merged);
      expect(r.sectionsPending).toBe(true);
      expect(res.ok && res.sectionsVer).toBe(r.sectionsVersion?.ver);
      expect(res.ok && res.sectionsVer).toBeGreaterThan(2);
      expect(f.peer.sent.at(-1)).toEqual({ t: 'sections', sections: merged });
      await f.rooms.flush();
      expect((await f.dbRow()).sections).toEqual(merged);
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('事务等待期间人删掉了目标板块：重放失败时人的编辑胜出并返回 superseded', async () => {
    const f = await setup();
    try {
      await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'create', id: 'sec-a', name: 'A' }],
      });
      const res = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'add_tables', section: 'sec-a', tables: [f.tables[0]!] }],
        onBeforeCommit: async () => {
          await f.rooms.message(f.branchId, f.peer.peer, { t: 'sections', sections: [] });
        },
      });
      expect(res).toMatchObject({ ok: true, superseded: true, sections: [] });
      const r = await f.rooms.get(f.branchId);
      expect(r.sections).toEqual([]);
      await f.rooms.flush();
      expect((await f.dbRow()).sections).toEqual([]);
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('结果超 7000B 时发布 room.sections.reload（DB 已先落库）', async () => {
    const f = await setup(60);
    try {
      const actions = Array.from({ length: 50 }, (_, i) => ({
        action: 'create' as const,
        id: `sec-big-${String(i).padStart(3, '0')}-${'x'.repeat(80)}`,
        name: `大板块 ${i} ${'名'.repeat(40)}`,
        tables: [f.tables[i]!],
      }));
      const res = await f.rooms.manageSections(f.branchId, { actions });
      expect(res.ok).toBe(true);
      const last = f.bus.published.at(-1);
      expect(last).toMatchObject({ t: 'room.sections.reload', branchId: f.branchId, ver: 1 });
      expect(f.bus.published.some((e) => e.t === 'room.sections')).toBe(false);
      expect((await f.dbRow()).sections).toHaveLength(50);
      expect(f.peer.sent.at(-1)).toMatchObject({ t: 'sections' });
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('flushSections 条件写：DB 已有更高版本时旧副本防抖落盘绝不覆盖，转而重载获胜版本推给 peers', async () => {
    const f = await setup();
    try {
      const stale: CanvasSection[] = [{ id: 'sec-stale', name: '旧副本', color: 'peer-1', tables: [] }];
      await f.rooms.message(f.branchId, f.peer.peer, { t: 'sections', sections: stale });
      const winner: CanvasSection[] = [{ id: 'sec-mcp', name: 'MCP 新提交', color: 'peer-2', tables: [] }];
      // 模拟其他副本经 manage_sections 已提交 ver = 7（本副本尚未收到事件）
      await db.query('update branches set sections = $2::text::jsonb, sections_ver = 7 where id = $1', [
        f.branchId,
        JSON.stringify(winner),
      ]);
      await f.rooms.flush();
      expect(await f.dbRow()).toEqual({ sections: winner, ver: 7 });
      await waitFor(() => {
        const m = f.peer.sent.at(-1);
        return m?.t === 'sections' && m.sections[0]?.id === 'sec-mcp';
      });
      const r = await f.rooms.get(f.branchId);
      expect(r.sectionsPending).toBe(false);
      expect(r.sections).toEqual(winner);
      expect(r.sectionsClock).toBeGreaterThanOrEqual(7);

      // 之后的本地编辑版本已推进到 DB 之上，可正常落库
      const next: CanvasSection[] = [
        ...winner,
        { id: 'sec-next', name: '之后', color: 'peer-3', tables: [] },
      ];
      await f.rooms.message(f.branchId, f.peer.peer, { t: 'sections', sections: next });
      await f.rooms.flush();
      expect(await f.dbRow()).toEqual({ sections: next, ver: 8 });
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });

  test('canvasState：DB 更热（跨副本已提交）且本副本无待刷写入时同步追齐内存并补发本地 peers', async () => {
    const f = await setup();
    try {
      const remote: CanvasSection[] = [
        { id: 'sec-remote', name: '远端', color: 'peer-6', tables: [f.tables[0]!] },
      ];
      await db.query('update branches set sections = $2::text::jsonb, sections_ver = 3 where id = $1', [
        f.branchId,
        JSON.stringify(remote),
      ]);
      const state = await f.rooms.canvasState(f.branchId);
      expect(state.sections).toEqual(remote);
      expect(state.sectionsVer).toBe(3);
      const r = await f.rooms.get(f.branchId);
      expect(r.sections).toEqual(remote);
      expect(r.sectionsVersion).toEqual({ ver: 3, origin: '' });
      expect(f.peer.sent.at(-1)).toEqual({ t: 'sections', sections: remote });
      // 后续增量写入基于追齐后的版本
      const res = await f.rooms.manageSections(f.branchId, {
        actions: [{ action: 'rename', section: 'sec-remote', name: '远端改名' }],
      });
      expect(res).toMatchObject({ ok: true, sectionsVer: 4 });
    } finally {
      f.rooms.close();
      await f.rooms.flush();
    }
  });
});

describe.skipIf(!PG_URL)('manage_sections：PG HA 双副本并发', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!().catch(() => {});
  });

  test('双副本并发增量创建互不抹除，且跨副本 canvasState 立即可见；冷副本 WS 旧落盘不覆盖', async () => {
    const pg = await createTestDb('msec_ha');
    const dbA = await openPlatformDb(pg.url);
    const dbB = await openPlatformDb(pg.url);
    const channel = `dowel_msec_${newId()
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase()}`;
    const appA = createApp(dbA, { bus: { replicaId: 'msec-a', channel }, rooms: { layoutDebounceMs: 5000 } });
    const appB = createApp(dbB, { bus: { replicaId: 'msec-b', channel }, rooms: { layoutDebounceMs: 5000 } });
    await appA.bus.start();
    await appB.bus.start();
    cleanups.push(async () => {
      appA.rooms.close();
      appB.rooms.close();
      await Promise.all([appA.rooms.flush(), appB.rooms.flush()]);
      await Promise.all([appA.shadows.close(), appB.shadows.close()]);
      await Promise.all([appA.bus.close(), appB.bus.close()]);
      await Promise.all([appA.ha.stop().catch(() => {}), appB.ha.stop().catch(() => {})]);
      await Promise.all([dbA.close(), dbB.close()]);
      await pg.close();
    });
    const branchId = `msec-ha-${newId()}`;
    const [pr] = await dbA.query<{ id: string }>('select id from projects limit 1');
    let projectId = pr?.id;
    if (!projectId) {
      await makeUser(dbA, 'msec-ha-admin', { name: '管理员', role: 'admin' });
      const login = await appA.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'msec-ha-admin', password: PASSWORD }),
      });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const grp = await appA.app.request('/api/groups', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ slug: 'msec-ha', name: 'HA 增量板块', defaultRole: 'editor' }),
      });
      const groupId = ((await grp.json()) as { id: string }).id;
      const proj = await appA.app.request('/api/projects', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'HA 增量板块项目', groupId }),
      });
      projectId = ((await proj.json()) as { id: string }).id;
    }
    await dbA.query('insert into branches (id, project_id, name) values ($1, $2, $3)', [
      branchId,
      projectId,
      'msec-ha',
    ]);
    const model: Model = emptyModel();
    const schema = createSchema(model, 'public');
    const t1 = createTable(model, schema, 't1');
    const t2 = createTable(model, schema, 't2');
    await appA.rooms.init(branchId, model);

    // 副本 B 预先加载房间（冷副本：内存板块版本为 0）
    await appB.rooms.canvasState(branchId);

    const results = await Promise.all([
      appA.rooms.manageSections(branchId, {
        actions: [{ action: 'create', id: 'sec-a', name: 'A', tables: [t1] }],
      }),
      appB.rooms.manageSections(branchId, {
        actions: [{ action: 'create', id: 'sec-b', name: 'B', tables: [t2] }],
      }),
    ]);
    expect(results.every((x) => x.ok)).toBe(true);
    const [row] = await dbA.query<{ sections: CanvasSection[]; sections_ver: string | number }>(
      'select sections, sections_ver from branches where id = $1',
      [branchId],
    );
    expect(row!.sections.map((x) => x.id).sort()).toEqual(['sec-a', 'sec-b']);
    expect(Number(row!.sections_ver)).toBe(2);
    for (const app of [appA, appB]) {
      const st = await app.rooms.canvasState(branchId);
      expect(st.sections.map((x) => x.id).sort()).toEqual(['sec-a', 'sec-b']);
    }
  });
});
