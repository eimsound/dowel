// POST /api/projects/:pid/environments/:eid/pull 的 workingSeq 原子并发保护测试（#42）：
// 覆盖 workingChanged() 预检通过后、在 ctx.replace 拿到房间锁（及 PG 分支行锁）前
// 有本地 WebSocket 协作者或另一副本推进 seq 时，pull 捕获 WorkingChangedError
// 返回与 workingChanged() 一致的 409 working_changed 与最新预览，不静默覆盖协作者修改。
import type { ModelUpdate, PullPreview } from '@dowel/api';
import { addColumn, all, type Model, newId } from '@dowel/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import type { LiveRead } from '../src/executions.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import type { Peer } from '../src/rooms.ts';
import { encrypt } from '../src/secrets.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'pull-concurrency-test-secret-0123456789';

const liveMock = vi.hoisted(() => ({
  fn: null as null | ((base: Model) => LiveRead),
}));

vi.mock('../src/executions.ts', async (orig) => {
  const m = await orig<typeof import('../src/executions.ts')>();
  return {
    ...m,
    readLive: async (
      x: Parameters<typeof m.readLive>[0],
      env: Parameters<typeof m.readLive>[1],
      scope: Parameters<typeof m.readLive>[2],
      base: Parameters<typeof m.readLive>[3],
    ) => {
      if (liveMock.fn) return liveMock.fn(base);
      return m.readLive(x, env, scope, base);
    },
  };
});

interface ConflictBody {
  error?: string;
  code?: string;
  preview?: PullPreview;
}

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

const loginAs = async (app: ReturnType<typeof createApp>['app'], username: string) => {
  const res = await callJson(app, 'POST', '/api/auth/login', { username, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.cookie;
};

const tableOf = (m: Model, name = 'orders') => all(m, 'table').find((t) => t.name === name)!;
const colsOf = (m: Model, tableName = 'orders') => {
  const t = tableOf(m, tableName);
  return all(m, 'column')
    .filter((c) => c.parent === t.id)
    .map((c) => c.name);
};

/** 构造模拟线上模型：沿用基础工作副本对象 ID，并附带一列线上热修列 hot */
const makeLiveReader =
  (fingerprint: string) =>
  (base: Model): LiveRead => {
    const model = structuredClone(base);
    const t = tableOf(model);
    if (!all(model, 'column').some((c) => c.parent === t.id && c.name === 'hot')) {
      addColumn(model, t.id, { name: 'hot', type: 'integer' });
    }
    return { model, fingerprint, state: null };
  };

/** 直接在平台库写入一条环境行（避免非 PG 场景下 inspectTarget 外连真实目标库） */
const insertEnv = async (db: PlatformDb, pid: string, name = 'dev') => {
  const eid = newId();
  await db.query(
    `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
     values ($1, $2, $3, $4, false, true, null)`,
    [eid, pid, name, encrypt('postgres://user:pass@127.0.0.1:5432/mock_target')],
  );
  return eid;
};

describe('POST /api/projects/:pid/environments/:eid/pull 并发 workingSeq 保护', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let adminCookie = '';
  let pid = '';
  let eid = '';
  let branchId = '';
  let editorUser: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    liveMock.fn = null;
    db = await openPlatformDb(':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    editorUser = await makeUser(db, 'editor', { name: '协作者' });
    adminCookie = await loginAs(created.app, 'admin');

    const g = await callJson(
      created.app,
      'POST',
      '/api/groups',
      { slug: 'pull-g', name: '拉取组' },
      adminCookie,
    );
    expect(g.status).toBe(201);
    const p = await callJson(
      created.app,
      'POST',
      '/api/projects',
      { name: '拉取并发项目', groupId: g.data.id },
      adminCookie,
    );
    expect(p.status).toBe(201);
    pid = p.data.id as string;
    await callJson(
      created.app,
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: editorUser.id, role: 'editor' },
      adminCookie,
    );

    const [branch] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    branchId = branch!.id;

    // 建表并发布 v1 作为基线版本，便于验证 workingDirty 警告
    await addTable(created.rooms, db, pid, 'orders');
    const pub = await callJson(
      created.app,
      'POST',
      `/api/projects/${pid}/versions`,
      { name: 'v1' },
      adminCookie,
    );
    expect(pub.status).toBe(201);

    eid = await insertEnv(db, pid, 'dev');
  });

  afterEach(async () => {
    liveMock.fn = null;
    vi.restoreAllMocks();
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
  });

  test('预检通过后、ctx.replace 拿锁前协作者推进 seq → 捕获 WorkingChangedError 返回 409 working_changed 与最新预览，不覆盖修改', async () => {
    const fp = 'a'.repeat(64);
    const baseline = (await created.rooms.model(branchId)).model;
    const liveSnapshot = makeLiveReader(fp)(baseline);
    liveMock.fn = () => structuredClone(liveSnapshot);

    const url = `/api/projects/${pid}/environments/${eid}/pull`;
    const pvRes = await callJson(created.app, 'POST', url, { preview: true }, adminCookie);
    expect(pvRes.status).toBe(200);
    const preview = pvRes.data as unknown as PullPreview;
    expect(preview.fingerprint).toBe(fp);
    expect(preview.warnings.workingDirty).toBe(false);
    const expectedSeq = preview.workingSeq;

    // 准备一个真实 WebSocket 协作者连接，用于在预检通过后、rooms.replace 拿锁前提交并发修改
    const peer: Peer = {
      user: editorUser,
      role: 'editor',
      send: () => {},
    };
    await created.rooms.join(branchId, peer);
    await created.rooms.message(branchId, peer, { t: 'hello', client: 'collab-c1', lastSeq: expectedSeq });

    const tableId = tableOf((await created.rooms.model(branchId)).model).id;
    const origRunWithReset = created.refresher.runWithReset.bind(created.refresher);
    let injected = false;
    vi.spyOn(created.refresher, 'runWithReset').mockImplementation(async (bId, model, fn) => {
      if (!injected) {
        injected = true;
        // 此时 workingChanged() 两次预检已全部通过，马上进入 rooms.replace；
        // 在拿房间锁前由协作者提交一列 collab_col，将 seq 推进 1
        await created.rooms.message(branchId, peer, {
          t: 'op',
          op: {
            client: 'collab-c1',
            n: 1,
            name: 'addColumn',
            args: {
              table: tableId,
              column: { id: newId(), name: 'collab_col', type: 'text', notNull: false },
            },
            reads: [],
          },
        });
      }
      return origRunWithReset(bId, model, fn);
    });
    const replaceSpy = vi.spyOn(created.rooms, 'replace');

    const conflictRes = await callJson(
      created.app,
      'POST',
      url,
      { fingerprint: fp, workingSeq: expectedSeq },
      adminCookie,
    );

    // 1. 确实越过了预检进入 ctx.replace，且传入了第 5 个参数 expectedSeq
    expect(injected).toBe(true);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy.mock.calls[0]?.[4]).toBe(expectedSeq);

    // 2. 返回与 workingChanged() 完全一致的 409 JSON 响应与最新预览
    expect(conflictRes.status).toBe(409);
    const body = conflictRes.data as ConflictBody;
    expect(body.error).toBe('工作副本在预览之后被改过，请重新确认差异');
    expect(body.code).toBe('working_changed');
    expect(body.preview).toBeDefined();
    expect(body.preview!.fingerprint).toBe(fp);
    expect(body.preview!.workingSeq).toBe(expectedSeq + 1);
    expect(body.preview!.warnings.workingDirty).toBe(true);
    expect(JSON.stringify(body.preview!.items)).toContain('collab_col');
    expect(JSON.stringify(body.preview!.items)).toContain('hot');

    // 3. 工作副本未被覆盖：协作者新增的 collab_col 完好保留，线上 hot 列未写入
    const afterConflict = await created.rooms.model(branchId);
    expect(afterConflict.seq).toBe(expectedSeq + 1);
    expect(colsOf(afterConflict.model)).toContain('collab_col');
    expect(colsOf(afterConflict.model)).not.toContain('hot');

    // 4. 冲突拒绝不写 environment.pull 审计
    const auditsBefore = await db.query<{ id: string }>(
      "select id from audit_events where action = 'environment.pull' and project_id = $1",
      [pid],
    );
    expect(auditsBefore).toHaveLength(0);

    // 5. 客户端使用 409 返回的最新 preview.workingSeq 重试确认，覆盖成功
    const okRes = await callJson(
      created.app,
      'POST',
      url,
      { fingerprint: body.preview!.fingerprint, workingSeq: body.preview!.workingSeq },
      adminCookie,
    );
    expect(okRes.status, JSON.stringify(okRes.data)).toBe(200);
    const updated = okRes.data as unknown as ModelUpdate;
    expect(updated.seq).toBe(expectedSeq + 2);
    const afterPull = await created.rooms.model(branchId);
    expect(colsOf(afterPull.model)).toContain('hot');
    expect(colsOf(afterPull.model)).not.toContain('collab_col');

    const auditsAfter = await db.query<{ id: string }>(
      "select id from audit_events where action = 'environment.pull' and project_id = $1",
      [pid],
    );
    expect(auditsAfter).toHaveLength(1);

    await created.rooms.leave(branchId, peer);
  });

  test('不传 workingSeq 时 expectedSeq 为 undefined，兼容旧调用方式正常覆盖', async () => {
    const fp = 'b'.repeat(64);
    const baseline = (await created.rooms.model(branchId)).model;
    const liveSnapshot = makeLiveReader(fp)(baseline);
    liveMock.fn = () => structuredClone(liveSnapshot);

    const peer: Peer = { user: editorUser, role: 'editor', send: () => {} };
    await created.rooms.join(branchId, peer);
    await created.rooms.message(branchId, peer, { t: 'hello', client: 'collab-c2', lastSeq: 0 });
    const tableId = tableOf((await created.rooms.model(branchId)).model).id;

    const origRunWithReset = created.refresher.runWithReset.bind(created.refresher);
    vi.spyOn(created.refresher, 'runWithReset').mockImplementationOnce(async (bId, model, fn) => {
      await created.rooms.message(branchId, peer, {
        t: 'op',
        op: {
          client: 'collab-c2',
          n: 1,
          name: 'addColumn',
          args: {
            table: tableId,
            column: { id: newId(), name: 'unpinned_col', type: 'text', notNull: false },
          },
          reads: [],
        },
      });
      return origRunWithReset(bId, model, fn);
    });
    const replaceSpy = vi.spyOn(created.rooms, 'replace');

    const res = await callJson(
      created.app,
      'POST',
      `/api/projects/${pid}/environments/${eid}/pull`,
      {},
      adminCookie,
    );
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(replaceSpy.mock.calls[0]?.[4]).toBeUndefined();
    expect(colsOf((await created.rooms.model(branchId)).model)).toContain('hot');

    await created.rooms.leave(branchId, peer);
  });

  test('ctx.replace 抛出非 WorkingChangedError 异常时不误转为 409', async () => {
    const fp = 'c'.repeat(64);
    const baseline = (await created.rooms.model(branchId)).model;
    liveMock.fn = () => structuredClone(makeLiveReader(fp)(baseline));

    const url = `/api/projects/${pid}/environments/${eid}/pull`;
    const pv = (await callJson(created.app, 'POST', url, { preview: true }, adminCookie))
      .data as unknown as PullPreview;
    vi.spyOn(created.rooms, 'replace').mockRejectedValueOnce(new Error('unexpected db failure'));

    const res = await callJson(
      created.app,
      'POST',
      url,
      { fingerprint: fp, workingSeq: pv.workingSeq },
      adminCookie,
    );
    expect(res.status).toBe(500);
  });
});

describe.skipIf(!PG_URL)('POST .../pull 跨副本 PostgreSQL 并发保护（#42）', () => {
  afterEach(() => {
    liveMock.fn = null;
    vi.restoreAllMocks();
  });

  test('副本 A 预检通过后、拿到 PG 分支行锁前副本 B 提交修改 → 副本 A 追赶后捕获 WorkingChangedError 返回 409，不覆盖副本 B 修改', async () => {
    const pg = await createTestDb('pull_ha_race');
    const dbA = await openPlatformDb(pg.url);
    const dbB = await openPlatformDb(pg.url);
    const channel = `dowel_pull_race_${newId()
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 8)
      .toLowerCase()}`;
    // 故意不启动 EventBus，模拟跨副本通知延迟的最坏并发窗口
    const appA = createApp(dbA, {
      bus: { replicaId: 'replica-a-pull', channel },
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    const appB = createApp(dbB, {
      bus: { replicaId: 'replica-b-pull', channel },
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });

    try {
      await makeUser(dbA, 'admin', { name: '管理员', role: 'admin' });
      const remoteEditor = await makeUser(dbA, 'remote_editor', { name: '远程协作者' });
      const adminCookie = await loginAs(appA.app, 'admin');

      const g = await callJson(
        appA.app,
        'POST',
        '/api/groups',
        { slug: 'ha-pull', name: '多副本拉取组' },
        adminCookie,
      );
      expect(g.status).toBe(201);
      const p = await callJson(
        appA.app,
        'POST',
        '/api/projects',
        { name: '跨副本拉取项目', groupId: g.data.id },
        adminCookie,
      );
      expect(p.status).toBe(201);
      const pid = p.data.id as string;
      await callJson(
        appA.app,
        'POST',
        `/api/projects/${pid}/grants`,
        { subjectKind: 'user', subjectId: remoteEditor.id, role: 'editor' },
        adminCookie,
      );

      const [branch] = await dbA.query<{ id: string }>(
        "select id from branches where project_id = $1 and name = 'main'",
        [pid],
      );
      const branchId = branch!.id;

      await addTable(appA.rooms, dbA, pid, 'orders');
      const pub = await callJson(
        appA.app,
        'POST',
        `/api/projects/${pid}/versions`,
        { name: 'v1' },
        adminCookie,
      );
      expect(pub.status).toBe(201);
      const eid = await insertEnv(dbA, pid, 'prod');

      const fp = 'd'.repeat(64);
      const baseline = (await appA.rooms.model(branchId)).model;
      const liveSnapshot = makeLiveReader(fp)(baseline);
      liveMock.fn = () => structuredClone(liveSnapshot);

      const url = `/api/projects/${pid}/environments/${eid}/pull`;
      const pvRes = await callJson(appA.app, 'POST', url, { preview: true }, adminCookie);
      expect(pvRes.status).toBe(200);
      const preview = pvRes.data as unknown as PullPreview;
      const expectedSeq = preview.workingSeq;

      // 在副本 B 建立协作者连接
      const remotePeer: Peer = { user: remoteEditor, role: 'editor', send: () => {} };
      await appB.rooms.join(branchId, remotePeer);
      await appB.rooms.message(branchId, remotePeer, {
        t: 'hello',
        client: 'remote-c1',
        lastSeq: expectedSeq,
      });
      const tableId = tableOf((await appB.rooms.model(branchId)).model).id;

      // 在副本 A 的 workingChanged() 预检通过后、rooms.replace 拿 PG 行锁前，由副本 B 提交并发修改
      const origRunWithReset = appA.refresher.runWithReset.bind(appA.refresher);
      let remoteCommitted = false;
      vi.spyOn(appA.refresher, 'runWithReset').mockImplementationOnce(async (bId, model, fn) => {
        await appB.rooms.message(branchId, remotePeer, {
          t: 'op',
          op: {
            client: 'remote-c1',
            n: 1,
            name: 'addColumn',
            args: {
              table: tableId,
              column: { id: newId(), name: 'remote_collab', type: 'text', notNull: false },
            },
            reads: [],
          },
        });
        remoteCommitted = true;
        return origRunWithReset(bId, model, fn);
      });

      const res = await callJson(
        appA.app,
        'POST',
        url,
        { fingerprint: fp, workingSeq: expectedSeq },
        adminCookie,
      );
      expect(remoteCommitted).toBe(true);
      expect(res.status).toBe(409);
      const body = res.data as ConflictBody;
      expect(body.error).toBe('工作副本在预览之后被改过，请重新确认差异');
      expect(body.code).toBe('working_changed');
      expect(body.preview!.workingSeq).toBe(expectedSeq + 1);
      expect(body.preview!.warnings.workingDirty).toBe(true);
      expect(JSON.stringify(body.preview!.items)).toContain('remote_collab');

      // 副本 A 与副本 B 读取的工作副本均完整保留副本 B 的修改，未被静默覆盖
      const stateA = await appA.rooms.model(branchId);
      const stateB = await appB.rooms.model(branchId);
      expect(stateA.seq).toBe(expectedSeq + 1);
      expect(stateB.seq).toBe(expectedSeq + 1);
      expect(colsOf(stateA.model)).toContain('remote_collab');
      expect(colsOf(stateA.model)).not.toContain('hot');
      expect(colsOf(stateB.model)).toContain('remote_collab');

      const audits = await dbA.query<{ id: string }>(
        "select id from audit_events where action = 'environment.pull' and project_id = $1",
        [pid],
      );
      expect(audits).toHaveLength(0);

      await appB.rooms.leave(branchId, remotePeer);
    } finally {
      await appA.rooms.flush();
      await appB.rooms.flush();
      appA.rooms.close();
      appB.rooms.close();
      await appA.shadows.close();
      await appB.shadows.close();
      await appA.bus.close();
      await appB.bus.close();
      await dbA.close();
      await dbB.close();
      await pg.close();
    }
  });
});
