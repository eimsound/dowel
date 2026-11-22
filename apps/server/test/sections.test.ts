// 画布板块（Section）的服务端验证、持久化与 HA 跨副本同步测试。
import { type CanvasSection, SECTION_COLORS } from '@dowel/api';
import { newId } from '@dowel/core';
import type { ToClient } from '@dowel/sync';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import { MAX_EVENT_BYTES } from '../src/bus.ts';
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

  const boot = async (tag: string, roomsOpts?: RoomsOptions) => {
    const safeTag = tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const pg = await createTestDb(safeTag);
    const dbA = await openPlatformDb(pg.url);
    const dbB = await openPlatformDb(pg.url);
    const suffix = newId()
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase();
    const channel = `dowel_ha_sec_${safeTag}_${suffix}`;
    const appA = createApp(dbA, { bus: { replicaId: `sec-a-${safeTag}`, channel }, rooms: roomsOpts });
    const appB = createApp(dbB, { bus: { replicaId: `sec-b-${safeTag}`, channel }, rooms: roomsOpts });
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
    return { dbA, dbB, appA, appB, branchId: b!.id, admin, alice, bob };
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
});
