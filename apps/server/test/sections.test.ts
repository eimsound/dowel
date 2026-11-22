// 画布板块（Section）的服务端验证、持久化与 HA 跨副本同步测试。
import { type CanvasSection, SECTION_COLORS } from '@dowel/api';
import { emptyModel, newId } from '@dowel/core';
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
  return { bus, emit };
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
});
