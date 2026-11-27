// 发布 = 冻结迁移（P4a H1）：版本链（number / parent）、steps 与 checksum、空迁移、影子库验证、
// 人工编辑冻结脚本、重新验证（执行的是冻结脚本而不是重新 plan）。
// 平台库在 SQLite 和 PostgreSQL 上各跑一遍；影子库验证需要测试 PG（没有 Docker 时跳过）。
import type {
  CanvasHistoryConflict,
  CanvasHistoryList,
  ModelUpdate,
  PublishedTables,
  StoredVerifyReport,
  VersionCanvasDiff,
  VersionCreated,
  VersionDetail,
  VersionInfo,
  VersionRetireResult,
  VersionUnretireResult,
} from '@dowel/api';
import {
  addColumn,
  all,
  createSchema,
  createTable,
  dropTable,
  emptyModel,
  type Model,
  newId,
} from '@dowel/core';
import { type Db, type ScriptStep, stepsChecksum } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// 假影子库连接（shadowOps 套一个假 Db）读回的结构永远是空的：读回核对（ADR 0017 决定 2）必然“不一致”。
// 只关心基础设施分类 / 风险分析的测试打开 readbackStub.on，把读回核对换成“一致”；读回核对本身由 verified-readback.test.ts 与真实 PG 测试覆盖
const readbackStub = vi.hoisted(() => ({ on: false }));
vi.mock('@dowel/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dowel/executor')>();
  return {
    ...actual,
    readbackDiff: (...args: Parameters<typeof actual.readbackDiff>) =>
      readbackStub.on ? { total: 0, items: [], details: [] } : actual.readbackDiff(...args),
  };
});

import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { LoginLimiter } from '../src/rate-limit.ts';
import { connHash } from '../src/requests.ts';
import { encrypt, SecretError } from '../src/secrets.ts';
import { type Shadow, ShadowError, shadowOps } from '../src/shadow.ts';
import { shadowSetupError } from '../src/targets.ts';
import { addTable, editModel, makeUser, PASSWORD, stubPassingShadow } from './support.ts';

process.env.DOWEL_SECRET ??= 'versions-test-secret-0123456789';

const addNote = (m: Model, name = 'note', type = 'text') =>
  addColumn(m, all(m, 'table').find((t) => t.name === 'orders')!.id, { name, type });

const step = (sql: string): ScriptStep => ({ sql, transactional: true });

/** 响应体：错误信息、验证报告（发布被拒绝和重新验证都带 report）、验证时间；其余字段按需读取 */
interface Body extends Record<string, unknown> {
  error?: string;
  report?: StoredVerifyReport & { shadow: string };
  verifiedAt?: string | null;
}

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('版本链（平台库：$platform）', ({ platform, skip }) => {
  let platformDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let targetDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let admin = '';
  let editor = '';
  let viewer = '';
  let groupId = '';

  const call = async (method: string, path: string, json?: unknown, cookie = admin) => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await created.app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data: data as Body };
  };

  const login = async (username: string) => {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status, username).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  /**
   * 新项目。withEnv：加一个指向测试 PG 的真实环境（同实例影子库）；否则默认装影子库替身（发布必须经影子库验证，ADR 0017），
   * shadow: false 时什么影子库都没有
   */
  const newProject = async (name: string, withEnv = false, { shadow = true }: { shadow?: boolean } = {}) => {
    const p = await call('POST', '/api/projects', { name, groupId });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    for (const [user, role] of [
      [editorId, 'editor'],
      [viewerId, 'viewer'],
    ] as const)
      expect(
        (await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: user, role }))
          .status,
      ).toBe(201);
    if (withEnv)
      expect(
        (
          await call('POST', `/api/projects/${pid}/environments`, {
            name: 'dev',
            url: targetDb!.url,
            production: false,
          })
        ).status,
      ).toBe(201);
    else if (shadow) stubPassingShadow(created.shadows, { pids: [pid] });
    return pid;
  };

  let editorId = '';
  let viewerId = '';

  const publish = (pid: string, name: string, cookie = admin) =>
    call('POST', `/api/projects/${pid}/versions`, { name }, cookie);
  const list = async (pid: string) =>
    (await call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
  const detail = async (pid: string, vid: string) =>
    (await call('GET', `/api/projects/${pid}/versions/${vid}`)).data as unknown as VersionDetail;
  const patchSteps = (pid: string, vid: string, up: ScriptStep[], down: ScriptStep[], cookie = admin) =>
    call('PATCH', `/api/projects/${pid}/versions/${vid}/steps`, { up, down }, cookie);
  const reverify = (pid: string, vid: string, cookie = admin) =>
    call('POST', `/api/projects/${pid}/versions/${vid}/verify`, undefined, cookie);
  const retire = (
    pid: string,
    vid: string,
    body: { head: string; keepWorkingCopy?: boolean; workingSeq?: number },
    cookie = editor,
  ) => call('POST', `/api/projects/${pid}/versions/${vid}/retire`, body, cookie);
  const unretire = (
    pid: string,
    vid: string,
    body: { syncWorkingCopy?: boolean; workingSeq?: number } = {},
    cookie = editor,
  ) => call('POST', `/api/projects/${pid}/versions/${vid}/unretire`, body, cookie);
  const canvasDiff = (pid: string, vid: string, cookie = viewer) =>
    call('GET', `/api/projects/${pid}/versions/${vid}/canvas-diff`, undefined, cookie);
  const applyVersion = (pid: string, vid: string, workingSeq: number, cookie = editor) =>
    call('POST', `/api/projects/${pid}/versions/${vid}/apply`, { workingSeq }, cookie);

  beforeAll(async () => {
    if (skip) return;
    if (platform === 'pg') platformDb = await createTestDb('versions');
    if (PG_URL) targetDb = await createTestDb('vtarget');
    db = await openPlatformDb(platformDb?.url ?? ':memory:');
    created = createApp(db, { loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }) });
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    editorId = (await makeUser(db, 'editor', { name: '编辑者' })).id;
    viewerId = (await makeUser(db, 'viewer', { name: '查看者' })).id;
    admin = await login('admin');
    editor = await login('editor');
    viewer = await login('viewer');
    const g = await call('POST', '/api/groups', { slug: 'g', name: '组' });
    expect(g.status).toBe(201);
    groupId = g.data.id as string;
  });

  afterAll(async () => {
    if (skip) return;
    created.requests.stop();
    await created.webhooks.close();
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    await platformDb?.close();
    if (targetDb) {
      // 同实例影子库 {原库名}_dowel 是自动建的，测试结束时清掉
      const name = new URL(targetDb.url).pathname.slice(1);
      const adminConn = connect(PG_URL);
      await adminConn.db.exec(`DROP DATABASE IF EXISTS ${name}_dowel WITH (FORCE)`);
      await adminConn.close();
      await targetDb.close();
    }
  });

  test.skipIf(skip)(
    '发布后 number 和 parent 连成链，写入 steps 和 checksum；没有影子库时拒绝发布（不再有“发布为未验证”）',
    async () => {
      const pid = await newProject('chain', false, { shadow: false });
      await addTable(created.rooms, db, pid);
      // ADR 0017 决定 1：没有可用的影子库不能发布，指路去配置影子库
      const none = await publish(pid, '首个版本');
      expect(none.status).toBe(422);
      expect(none.data).toMatchObject({ code: 'shadow_unavailable' });
      expect(String(none.data.error)).toContain('环境');
      expect(await list(pid)).toEqual([]);

      stubPassingShadow(created.shadows, { pids: [pid] });
      const r1 = await publish(pid, '首个版本');
      expect(r1.status).toBe(201);
      const v1 = r1.data as unknown as VersionCreated;
      expect(v1).toMatchObject({
        number: 1,
        verified: true,
        name: '首个版本',
        verifiedOn: ['16.4'],
        uncovered: [],
      });

      await editModel(created.rooms, db, pid, (m) => void addNote(m));
      const v2 = (await publish(pid, '加备注')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'memo'));
      const v3 = (await publish(pid, '加备忘')).data as unknown as VersionCreated;
      expect([v2.number, v3.number]).toEqual([2, 3]);

      const versions = await list(pid);
      expect(versions.map((v) => [v.number, v.id, v.parentId, v.latest])).toEqual([
        [3, v3.id, v2.id, true],
        [2, v2.id, v1.id, false],
        [1, v1.id, null, false],
      ]);
      // number 是链上的序号；seq 是发布时房间的操作序号（只增不减），两者不是一回事
      expect(versions.map((v) => v.seq)).toEqual([...versions.map((v) => v.seq)].sort((a, b) => b - a));
      expect(new Set(versions.map((v) => v.seq)).size).toBe(3);
      expect(versions.every((v) => v.verifiedAt !== null && v.edited === false)).toBe(true);
      expect(versions.map((v) => v.verifiedOn)).toEqual([['16.4'], ['16.4'], ['16.4']]);

      const d1 = await detail(pid, v1.id);
      // 第一个版本从空库（带 public）迁移：建表，不会再 CREATE SCHEMA public
      expect(d1.upSteps.map((s) => s.sql)).toEqual([expect.stringMatching(/^CREATE TABLE public\.orders/)]);
      expect(d1.downSteps.map((s) => s.sql)).toEqual(['DROP TABLE public.orders']);
      expect([...d1.upSteps, ...d1.downSteps].every((s) => s.transactional === true)).toBe(true);
      expect(d1.checksum).toBe(stepsChecksum(d1.upSteps, d1.downSteps));
      // 发布成功的版本一定带着至少一条通过的验证记录（按影子库的数据库完整版本号）
      expect(d1.verifyReport).toMatchObject({
        ok: true,
        records: [expect.objectContaining({ engineVersion: '16.4', ok: true, shadow: 'stub shadow' })],
      });

      // 后面的版本是相邻两个版本之间的迁移
      const d2 = await detail(pid, v2.id);
      expect(d2.upSteps.map((s) => s.sql)).toEqual(['ALTER TABLE public.orders ADD COLUMN note text']);
      expect(d2.downSteps.map((s) => s.sql)).toEqual(['ALTER TABLE public.orders DROP COLUMN note']);
      expect(d2.checksum).toBe(stepsChecksum(d2.upSteps, d2.downSteps));
      expect(d2.checksum).not.toBe(d1.checksum);

      expect((await call('GET', `/api/projects/${pid}/versions/nope`)).status).toBe(404);
      // 别的项目的版本 ID 也读不到
      const other = await newProject('chain-other');
      expect((await call('GET', `/api/projects/${other}/versions/${v1.id}`)).status).toBe(404);
    },
  );

  test.skipIf(skip)('空迁移返回 422：没有变更不能发布', async () => {
    const blank = await newProject('empty');
    const r0 = await publish(blank, 'v1');
    expect(r0.status).toBe(422);
    expect(String(r0.data.error)).toContain('没有变更');

    await addTable(created.rooms, db, blank);
    expect((await publish(blank, 'v1')).status).toBe(201);
    const again = await publish(blank, 'v2');
    expect(again.status).toBe(422);
    expect(String(again.data.error)).toContain('没有变更');
    expect(await list(blank)).toHaveLength(1);
  });

  test.skipIf(skip)('编辑冻结脚本：只能编辑最新版本；编辑后 edited、未验证、checksum 重算', async () => {
    const pid = await newProject('edit');
    await addTable(created.rooms, db, pid);
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    await editModel(created.rooms, db, pid, (m) => void addNote(m));
    const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
    const d1 = await detail(pid, v1.id);
    const d2 = await detail(pid, v2.id);

    // 不是最新版本
    const old = await patchSteps(pid, v1.id, d1.upSteps, d1.downSteps);
    expect(old.status).toBe(409);
    expect(String(old.data.error)).toContain('最新');
    expect((await detail(pid, v1.id)).edited).toBe(false);

    // 内容没变：什么都不发生
    const same = await patchSteps(pid, v2.id, d2.upSteps, d2.downSteps);
    expect(same.status).toBe(200);
    expect(same.data).toMatchObject({ edited: false, checksum: d2.checksum });

    // 编辑：多加一步数据迁移，并把第二步标为非事务
    const up: ScriptStep[] = [
      ...d2.upSteps,
      { sql: "UPDATE public.orders SET note = 'n/a' WHERE note IS NULL", transactional: true },
      { sql: 'CREATE INDEX CONCURRENTLY orders_note ON public.orders (note)', transactional: false },
    ];
    const edited = await patchSteps(pid, v2.id, up, d2.downSteps);
    expect(edited.status).toBe(200);
    const e = edited.data as unknown as VersionDetail;
    expect(e.edited).toBe(true);
    expect(e.verifiedAt).toBeNull();
    expect(e.verifyReport).toBeNull();
    expect(e.upSteps).toEqual(up);
    expect(e.checksum).toBe(stepsChecksum(up, d2.downSteps));
    expect(e.checksum).not.toBe(d2.checksum);
    // 读回来一致；列表里标为人工编辑
    expect(await detail(pid, v2.id)).toMatchObject({ upSteps: up, edited: true, checksum: e.checksum });
    expect((await list(pid))[0]).toMatchObject({ id: v2.id, edited: true, verifiedAt: null });
    // 没有多余字段被存进去
    const noisy = [{ sql: 'SELECT 1', transactional: true, kind: 'x' }] as unknown as ScriptStep[];
    expect((await patchSteps(pid, v2.id, noisy, [])).status).toBe(200);
    expect((await detail(pid, v2.id)).upSteps).toEqual([{ sql: 'SELECT 1', transactional: true }]);

    // 空的一步、不合法的请求体
    expect((await patchSteps(pid, v2.id, [{ sql: '  ', transactional: true }], [])).status).toBe(422);
    expect((await call('PATCH', `/api/projects/${pid}/versions/${v2.id}/steps`, { up: 'x' })).status).toBe(
      400,
    );

    // 权限：查看者不行，编辑者可以
    expect((await patchSteps(pid, v2.id, up, d2.downSteps, viewer)).status).toBe(403);
    expect((await patchSteps(pid, v2.id, up, d2.downSteps, editor)).status).toBe(200);

    // 发布了下一个版本之后，v2 就不再是最新版本
    await editModel(created.rooms, db, pid, (m) => void addNote(m, 'memo'));
    const v3 = (await publish(pid, 'v3')).data as unknown as VersionCreated;
    expect((await patchSteps(pid, v2.id, up, d2.downSteps)).status).toBe(409);
    const d3 = await detail(pid, v3.id);
    expect((await patchSteps(pid, v3.id, d3.upSteps, [])).status).toBe(200);
    expect((await detail(pid, v3.id)).downSteps).toEqual([]);
  });

  test.skipIf(skip || !PG_URL)('影子库验证：通过则记录已验证；失败拒绝发布并附报告', async () => {
    const pid = await newProject('shadow', true);
    await addTable(created.rooms, db, pid);
    const r1 = await publish(pid, 'v1');
    expect(r1.status).toBe(201);
    const v1 = r1.data as unknown as VersionCreated;
    expect(v1).toMatchObject({ number: 1, verified: true, uncovered: [] });
    // 同实例影子库与目标库是同一个实例：验证记录的数据库完整版本号就是环境的版本（ADR 0017 决定 5）
    const envs = (await call('GET', `/api/projects/${pid}/environments`)).data as unknown as {
      engineFullVersion: string | null;
    }[];
    expect(v1.verifiedOn).toEqual([envs[0]!.engineFullVersion]);
    const d1 = await detail(pid, v1.id);
    expect(d1.verifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d1.verifyReport).toMatchObject({ ok: true, upDiff: [], downDiff: [], error: null });
    expect(d1.verifyReport!.shadow).toContain('dev：');
    expect(d1.verifyReport!.risks).toHaveLength(d1.upSteps.length);

    // plan 生成得出来、但数据库建不出来的模型：验证失败，拒绝发布
    await editModel(created.rooms, db, pid, (m) => void addNote(m, 'bad', 'nosuchtype'));
    const bad = await publish(pid, 'v2');
    expect(bad.status).toBe(422);
    expect(String(bad.data.error)).toContain('验证');
    expect(bad.data.report).toMatchObject({ ok: false });
    expect(bad.data.report!.error!.message).toContain('nosuchtype');
    expect(bad.data.report!.error!.step!.sql).toContain('nosuchtype');
    expect(bad.data.report!.shadow).toContain('dev：');
    expect(await list(pid)).toHaveLength(1); // 没有发布

    // 修好之后可以发布，parent 仍然是 v1
    await editModel(created.rooms, db, pid, (m) => {
      const col = all(m, 'column').find((c) => c.name === 'bad')!;
      delete m.objects[col.id];
    });
    await editModel(created.rooms, db, pid, (m) => void addNote(m));
    const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
    expect(v2).toMatchObject({ number: 2, verified: true });
    expect((await list(pid)).map((v) => [v.number, v.parentId])).toEqual([
      [2, v1.id],
      [1, null],
    ]);
  });

  test.skipIf(skip || !PG_URL)('重新验证执行的是冻结脚本：改坏的脚本验证失败，恢复后通过', async () => {
    const pid = await newProject('reverify', true);
    await addTable(created.rooms, db, pid);
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    await editModel(created.rooms, db, pid, (m) => void addNote(m));
    const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
    const good = await detail(pid, v2.id);
    expect(good.verifiedAt).not.toBeNull();

    // 重新验证未改动的版本：通过；旧版本也可以重新验证
    const ok = await reverify(pid, v2.id);
    expect(ok.status).toBe(200);
    expect(ok.data.report).toMatchObject({ ok: true, upDiff: [], downDiff: [], error: null });
    expect(ok.data.verifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect((await reverify(pid, v1.id)).data.report?.ok).toBe(true);

    // a. 脚本执行出错（plan 重新生成的话本来是对的）：报告里是冻结脚本的原文和位置
    const broken = good.upSteps.map((s) => ({ ...s, sql: s.sql.replace('note text', 'note nosuchtype') }));
    expect((await patchSteps(pid, v2.id, broken, good.downSteps)).status).toBe(200);
    expect((await detail(pid, v2.id)).verifiedAt).toBeNull();
    const failed = await reverify(pid, v2.id);
    expect(failed.status).toBe(200);
    expect(failed.data.verifiedAt).toBeNull();
    const rep = failed.data.report as StoredVerifyReport;
    expect(rep.ok).toBe(false);
    expect(rep.error!.message).toContain('nosuchtype');
    // 报告里的步骤带着冻结脚本的 transactional 标记（migrationStepSchema 里声明了这个可选字段）
    expect(rep.error!.step).toMatchObject({ kind: 'frozen', target: 'up#1', transactional: true });
    const afterFail = await detail(pid, v2.id);
    expect(afterFail.verifiedAt).toBeNull();
    expect(afterFail.verifyReport).toMatchObject({ ok: false });
    expect(afterFail.edited).toBe(true);

    // b. 能执行但结果不对：升级脚本什么都不做 → 结构与这个版本不一致
    expect(
      (await patchSteps(pid, v2.id, [{ sql: 'SELECT 1', transactional: true }], good.downSteps)).status,
    ).toBe(200);
    const noop = (await reverify(pid, v2.id)).data.report as StoredVerifyReport;
    expect(noop.ok).toBe(false);
    expect(noop.upDiff.join('\n')).toContain('note');

    // c. 回滚脚本不对：升级对、回滚后没有回到上一个版本
    expect(
      (await patchSteps(pid, v2.id, good.upSteps, [{ sql: 'SELECT 1', transactional: true }])).status,
    ).toBe(200);
    const badDown = (await reverify(pid, v2.id)).data.report as StoredVerifyReport;
    expect(badDown.ok).toBe(false);
    expect(badDown.upDiff).toEqual([]);
    expect(badDown.downDiff.join('\n')).toContain('note');

    // 恢复成原来的脚本（编辑标记保留），重新验证通过，验证时间写回
    expect((await patchSteps(pid, v2.id, good.upSteps, good.downSteps)).status).toBe(200);
    const fixed = await reverify(pid, v2.id);
    expect(fixed.data.report?.ok).toBe(true);
    const after = await detail(pid, v2.id);
    expect(after).toMatchObject({ edited: true, checksum: good.checksum });
    expect(after.verifiedAt).toBe(fixed.data.verifiedAt);
    expect((await list(pid))[0]!.verifiedAt).toBe(fixed.data.verifiedAt);
    // 内容没变的“编辑”不会把已验证的版本打回未验证
    expect((await patchSteps(pid, v2.id, good.upSteps, good.downSteps)).status).toBe(200);
    expect((await detail(pid, v2.id)).verifiedAt).toBe(fixed.data.verifiedAt);

    // 权限：查看者不能重新验证
    expect((await reverify(pid, v2.id, viewer)).status).toBe(403);
    expect((await reverify(pid, v2.id, editor)).status).toBe(200);
  });

  test.skipIf(skip || !PG_URL)(
    '冻结的旧版本里带实例级语句（绕过接口直接写库）：重新验证 ok:false，真实 PG 上库没有被建出来',
    async () => {
      const pid = await newProject('legacy-instance', true);
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      const d1 = await detail(pid, v1.id);
      expect(d1.verifiedAt).not.toBeNull();
      const dbName = `dowel_legacy_probe_${Math.random().toString(36).slice(2, 8)}`;
      const admin = connect(PG_URL);
      try {
        // 模拟“以前冻结下来的脚本里就有”：直接改库（接口会拒绝）
        await db.query('update versions set up_steps = $2::text::jsonb where id = $1', [
          v1.id,
          JSON.stringify([...d1.upSteps, step(`CREATE DATABASE ${dbName}`)]),
        ]);
        const r = await reverify(pid, v1.id);
        expect(r.status).toBe(200);
        expect(r.data.report).toMatchObject({ ok: false });
        expect(r.data.report!.error!.message).toContain('实例级语句不能放进迁移');
        expect(r.data.report!.error!.step).toMatchObject({
          kind: 'frozen',
          target: `up#${d1.upSteps.length + 1}`,
        });
        expect((await detail(pid, v1.id)).verifiedAt).toBeNull();
        const [row] = await admin.db.query<{ n: number }>(
          'select count(*)::int as n from pg_database where datname = $1',
          [dbName],
        );
        expect(row!.n).toBe(0); // 影子库所在的实例上没有被建出这个库
      } finally {
        await admin.db.exec(`DROP DATABASE IF EXISTS ${dbName}`);
        await admin.close();
      }
    },
  );

  test.skipIf(skip)('没有环境时重新验证返回 422；不存在的版本 404', async () => {
    const pid = await newProject('noenv-verify', false, { shadow: false });
    await addTable(created.rooms, db, pid);
    // 发布时有影子库（替身），之后影子库没了：重新验证拿不到影子库
    const restore = stubPassingShadow(created.shadows, { pids: [pid] });
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    restore();
    const r = await reverify(pid, v1.id);
    expect(r.status).toBe(422);
    expect(String(r.data.error)).toContain('环境');
    expect((await reverify(pid, 'nope')).status).toBe(404);
  });

  // ───── P4a 审查后补的测试 ─────

  /** 把 Shadows.forProject 换成固定的实现（测试里模拟各种影子库状态）；返回恢复函数 */
  const stubShadows = (impl: () => Promise<{ shadow: Partial<Shadow>; label: string }>) => {
    const original = created.shadows.forProject.bind(created.shadows);
    const originalByVersion = created.shadows.forProjectEngineVersions.bind(created.shadows);
    created.shadows.forProject = impl as unknown as typeof created.shadows.forProject;
    // 发布 / 重新验证按环境的数据库完整版本号选影（ADR 0017 决定 5）：同一个替身当作唯一环境 18.0 的影子库
    // （假 Db 报的 server_version_num 是 180000）
    created.shadows.forProjectEngineVersions = async () => {
      const s = await impl();
      return {
        entries: [{ engineVersion: '18.0', envId: '', shadow: s.shadow as Shadow, label: s.label }],
        skipped: [],
        environments: [{ id: 'stub-env', name: 'stub', engineVersion: '18.0' }],
        identical: false,
      };
    };
    return () => {
      created.shadows.forProject = original;
      created.shadows.forProjectEngineVersions = originalByVersion;
    };
  };
  /** 执行 CREATE TABLE 时连接断开的假影子库连接（走真实的 shadowOps，看错误是怎么被分类和加前缀的） */
  const droppedDb = (): Db => ({
    query: async () => [] as never,
    exec: async (sql) => {
      if (sql.startsWith('CREATE TABLE'))
        throw Object.assign(new Error('连接断开了'), { code: 'CONNECTION_CLOSED' });
    },
  });
  const okReport = {
    ok: true,
    up: [],
    down: [],
    upDiff: [],
    downDiff: [],
    risks: [],
    error: null,
  };

  test.skipIf(skip)('发布验证的就是要冻结的那一份脚本（verifyScripts），不是重新 plan', async () => {
    const pid = await newProject('verify-frozen');
    await addTable(created.rooms, db, pid);
    const seen: { up: ScriptStep[]; down: ScriptStep[] }[] = [];
    let planned = false;
    const restore = stubShadows(async () => ({
      label: 'stub：shadow',
      shadow: {
        verify: async () => {
          planned = true;
          return okReport;
        },
        verifyScripts: async (_from, _to, up, down) => {
          seen.push({ up, down });
          return okReport;
        },
      },
    }));
    try {
      const r = await publish(pid, 'v1');
      expect(r.status).toBe(201);
      expect(r.data).toMatchObject({ verified: true, verifiedOn: ['18.0'], uncovered: [] });
      const d = await detail(pid, (r.data as unknown as VersionCreated).id);
      expect(planned).toBe(false);
      expect(seen).toHaveLength(1);
      // 被验证的脚本与写进版本里的完全一致
      expect(seen[0]).toEqual({ up: d.upSteps, down: d.downSteps });
      expect(d.verifiedAt).not.toBeNull();
    } finally {
      restore();
    }
  });

  test.skipIf(skip)(
    '发布时：影子库不可用 → 拒绝发布并写明原因（稍后重试）；其他错误继续抛出，不会悄悄发布',
    async () => {
      const pid = await newProject('publish-infra');
      await addTable(created.rooms, db, pid);

      // 拿影子库时报 ShadowError（没有环境、生产环境不让用同实例、连不上……）：ADR 0017 决定 1，不再“发布为未验证”
      let restore = stubShadows(async () => {
        throw new ShadowError('连接失败：ECONNREFUSED');
      });
      const unavailable = await publish(pid, 'v1');
      restore();
      expect(unavailable.status).toBe(422);
      expect(unavailable.data).toMatchObject({ code: 'shadow_unavailable' });
      // 配置性 / 已经成型的 ShadowError 保持原来的文案，不再额外加前缀
      expect(String(unavailable.data.error)).toContain('连接失败：ECONNREFUSED');
      expect(String(unavailable.data.error)).not.toContain('影子库不可用：');
      expect(await list(pid)).toHaveLength(0);

      // 验证过程中基础设施故障（连接断开）：同样拒绝；前缀在转成 ShadowError 的那一处加，只出现一次
      restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: shadowOps(async () => droppedDb()),
      }));
      const dropped = await publish(pid, 'v1');
      restore();
      expect(dropped.status).toBe(422);
      expect(dropped.data).toMatchObject({ code: 'shadow_unavailable' });
      expect(String(dropped.data.error)).toContain('影子库不可用：连接断开了');
      expect(String(dropped.data.error).split('影子库不可用：')).toHaveLength(2);
      expect(await list(pid)).toHaveLength(0);

      // 不是“影子库不可用”的错误：白名单拒绝（HTTPException）、密钥解密失败（SecretError）、平台库错误，
      // 都不能被当成“没有影子库”而发布
      const before = (await list(pid)).length;
      for (const [err, status] of [
        [new HTTPException(403, { message: '连接地址不在白名单里' }), 403],
        [new SecretError('无法解密'), 422],
        [new Error('平台库挂了'), 500],
      ] as const) {
        restore = stubShadows(async () => {
          throw err;
        });
        const r = await publish(pid, 'v3');
        restore();
        expect(r.status, String(err)).toBe(status);
        expect(await list(pid)).toHaveLength(before);
      }
    },
  );

  test.skipIf(skip)('重新验证遇到影子库故障：返回错误，原有的验证状态和报告保持不变', async () => {
    const pid = await newProject('reverify-infra');
    await addTable(created.rooms, db, pid);
    // 先让这个版本处于“已验证”（用桩影子库）
    let restore = stubShadows(async () => ({
      label: 'stub：shadow',
      shadow: { verifyScripts: async () => okReport },
    }));
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    expect((await reverify(pid, v1.id)).status).toBe(200);
    restore();
    const before = await detail(pid, v1.id);
    expect(before.verifiedAt).not.toBeNull();
    expect(before.verifyReport).toMatchObject({ ok: true });

    // 影子库拿不到 / 验证中连接断开：不是“脚本没通过”
    for (const [fail, message] of [
      [
        async (): Promise<never> => {
          throw new ShadowError('影子库不可用：正被其他检查占用，请稍后再试');
        },
        '影子库不可用：正被其他检查占用，请稍后再试',
      ],
      [
        async () => ({ label: 'stub：shadow', shadow: shadowOps(async () => droppedDb()) }),
        '影子库不可用：连接断开了',
      ],
    ] as const) {
      restore = stubShadows(fail as never);
      const r = await reverify(pid, v1.id);
      restore();
      expect(r.status).toBe(422);
      expect(r.data.error).toBe(message);
      expect(String(r.data.error).split('影子库不可用：')).toHaveLength(2); // 前缀只出现一次
      expect(await detail(pid, v1.id)).toEqual(before);
    }

    // 对照：脚本真的验证失败时，状态才会改变
    restore = stubShadows(async () => ({
      label: 'stub：shadow',
      shadow: {
        verifyScripts: async () => ({ ...okReport, ok: false, upDiff: ['tables.public.orders: 缺少'] }),
      },
    }));
    const failed = await reverify(pid, v1.id);
    restore();
    expect(failed.status).toBe(200);
    expect(failed.data.report).toMatchObject({ ok: false });
    expect((await detail(pid, v1.id)).verifiedAt).toBeNull();
  });

  /** 风险分析（analyze）阶段出错的假影子库连接：仅 analyze 阶段的 measureInTransaction 会进入 BEGIN，在分析首步事务开启时报错 */
  const analysisFailsDb = (code: string): Db => ({
    query: async (q) => (q.includes('server_version_num') ? ([{ v: 180000 }] as never) : ([] as never)),
    exec: async (sql) => {
      if (sql === 'BEGIN') throw Object.assign(new Error('分析时出事了'), { code });
    },
  });

  test.skipIf(skip)(
    '风险分析没有完成：验证结论不变，如实写进报告（riskError），发布路径和 /verify 路径都一样',
    async () => {
      const pid = await newProject('risk-error');
      await addTable(created.rooms, db, pid);
      readbackStub.on = true;
      const restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: shadowOps(async () => analysisFailsDb('25001')),
      }));
      try {
        // 发布：验证通过（脚本没问题），报告里有 riskError，风险为空——界面不能把它显示成“没有风险”
        const r = await publish(pid, 'v1');
        expect(r.status, JSON.stringify(r.data)).toBe(201);
        expect(r.data).toMatchObject({ verified: true });
        // 发布响应带着 riskError，界面据此提示（不能悄悄当成“没有风险”）
        // riskError 只存原因本身，不带“风险分析没有完成：”前缀（由界面标题提供）
        expect(r.data.riskError).toBe('分析时出事了');
        const d = await detail(pid, (r.data as unknown as VersionCreated).id);
        expect(d.verifiedAt).not.toBeNull();
        expect(d.verifyReport).toMatchObject({ ok: true, risks: [] });
        expect(d.verifyReport!.riskError).toBe('分析时出事了');

        // /verify 预览：同样 ok:true 且带 riskError
        const v = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
        expect(v.status).toBe(200);
        expect(v.data).toMatchObject({ ok: true, risks: [] });
        expect(v.data.riskError).toBe('分析时出事了');

        // 重新验证：同上，写回的报告里有 riskError
        const re = await reverify(pid, (r.data as unknown as VersionCreated).id);
        expect(re.status).toBe(200);
        expect(re.data.report!.ok).toBe(true);
        expect(re.data.report!.riskError).toBe('分析时出事了');
      } finally {
        restore();
      }

      // 分析时连接断开不是“没分析完”，而是影子库故障：发布 → 拒绝（稍后重试）；/verify → 422，前缀只出现一次
      const restore2 = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: shadowOps(async () => analysisFailsDb('08006')),
      }));
      try {
        await editModel(created.rooms, db, pid, (m) => void addNote(m));
        const r2 = await publish(pid, 'v2');
        expect(r2.status).toBe(422);
        expect(r2.data).toMatchObject({ code: 'shadow_unavailable' });
        expect(String(r2.data.error)).toContain('影子库不可用：分析时出事了');
        expect(String(r2.data.error).split('影子库不可用：')).toHaveLength(2);
        const v2 = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
        expect(v2.status).toBe(422);
        expect(v2.data.error).toBe('影子库不可用：分析时出事了');
      } finally {
        restore2();
        readbackStub.on = false;
      }
    },
  );

  test.skipIf(skip)(
    '项目的第一个环境连不上：发布被拒绝（shadow_unavailable）与 /verify 的 422 都只带一次“影子库不可用：”前缀',
    async () => {
      const pid = await newProject('env-unreachable', false, { shadow: false });
      await db.query(
        `insert into environments (id, project_id, name, url_enc, production) values ('env-bad', $1, 'dev', $2, $3)`,
        [pid, encrypt('postgres://u:p@127.0.0.1:1/nodb'), false],
      );
      await addTable(created.rooms, db, pid);
      const r = await publish(pid, 'v1');
      expect(r.status).toBe(422);
      expect(r.data).toMatchObject({ code: 'shadow_unavailable' });
      const reason = String(r.data.error);
      expect(reason).toContain('影子库不可用：连接失败：');
      expect(reason.split('影子库不可用：')).toHaveLength(2);
      expect(reason).not.toContain('p@'); // 连接串里的密码不会出现在原因里

      const v = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
      expect(v.status).toBe(422);
      expect(String(v.data.error)).toMatch(/^影子库不可用：连接失败：/);
      expect(String(v.data.error).split('影子库不可用：')).toHaveLength(2);
    },
  );

  test.skipIf(skip)(
    '建 / 认领影子库时的数据库错误：连接类 → 带前缀的拒绝发布；其他（权限不足等）→ 不带前缀的拒绝发布，不是 500',
    async () => {
      const pid = await newProject('setup-errors');
      await addTable(created.rooms, db, pid);
      const cases = [
        [
          'create',
          Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
          '影子库不可用：sorry, too many clients already',
        ],
        [
          'create',
          Object.assign(new Error('permission denied to create database'), { code: '42501' }),
          '建影子库失败：permission denied to create database',
        ],
        [
          'create',
          Object.assign(new Error('database "x_dowel" already exists'), { code: '42P04' }),
          '建影子库失败：database "x_dowel" already exists',
        ],
        [
          'claim',
          Object.assign(new Error('must be owner of database x_dowel'), { code: '42501' }),
          '认领影子库失败：当前账号不是该库的所有者，没法给它打 Dowel 影子库标记（must be owner of database x_dowel）。请用库的所有者账号，或让 DBA 先建好并标记这个库',
        ],
        [
          'check',
          Object.assign(new Error('permission denied for table pg_database'), { code: '42501' }),
          '检查影子库失败：permission denied for table pg_database',
        ],
        [
          'check',
          Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
          '影子库不可用：canceling statement due to user request',
        ],
      ] as const;
      for (const [step, err, reason] of cases) {
        const restore = stubShadows(async () => {
          throw shadowSetupError(err, step);
        });
        const r = await publish(pid, `v-${step}-${err.code}`);
        restore();
        expect(r.status, `${step} ${err.code}`).toBe(422);
        expect(r.data, `${step} ${err.code}`).toMatchObject({ code: 'shadow_unavailable' });
        expect(String(r.data.error), `${step} ${err.code}`).toContain(`版本没有发布：${reason}。`);
        await editModel(created.rooms, db, pid, (m) => void addNote(m, `n${step}${err.code}`));
      }
    },
  );

  test.skipIf(skip)(
    '错误消息里的连接串密码不会出现在发给客户端的响应里（发布被拒绝的原因和 /verify 的 422）',
    async () => {
      const pid = await newProject('leak');
      await addTable(created.rooms, db, pid);
      const leaky = Object.assign(
        new Error('connection to postgres://dowel:secret@db.internal:5432/shop failed'),
        {
          code: 'ECONNREFUSED',
        },
      );
      // 建 / 认领影子库时的原始错误
      let restore = stubShadows(async () => {
        throw shadowSetupError(leaky, 'claim');
      });
      const r = await publish(pid, 'v1');
      const v = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
      restore();
      expect(JSON.stringify(r.data)).not.toContain('secret');
      expect(r.status).toBe(422);
      expect(r.data.error).toContain('postgres://dowel:***@db.internal:5432/shop');
      expect(v.status).toBe(422);
      expect(JSON.stringify(v.data)).not.toContain('secret');
      // 验证过程里的连接故障（toShadowError）
      const dropped: Db = {
        query: async () => [] as never,
        exec: async (sql) => {
          if (sql.startsWith('CREATE TABLE')) throw Object.assign(leaky, { code: 'CONNECTION_CLOSED' });
        },
      };
      restore = stubShadows(async () => ({ label: 'stub：shadow', shadow: shadowOps(async () => dropped) }));
      const v2 = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
      restore();
      expect(v2.status).toBe(422);
      expect(JSON.stringify(v2.data)).not.toContain('secret');
      expect(v2.data.error).toContain('postgres://dowel:***@db.internal:5432/shop');
    },
  );

  test.skipIf(skip)(
    '导入 SQL（POST /import）里有实例级语句：在准备影子库之前就 422（不调用 forProject，不建库、不拿锁），提示和编辑脚本一致，模型不变',
    async () => {
      const pid = await newProject('import-instance-level');
      await addTable(created.rooms, db, pid);
      const executed: string[] = [];
      const recording: Db = {
        query: async (q) => {
          executed.push(q);
          return (q.includes('server_version_num') ? [{ v: 180000 }] : []) as never;
        },
        exec: async (q) => {
          executed.push(q);
        },
      };
      let forProjectCalls = 0;
      const restore = stubShadows(async () => {
        forProjectCalls++;
        return { label: 'stub：shadow', shadow: shadowOps(async () => recording) };
      });
      try {
        const before = (await call('GET', `/api/projects/${pid}/ddl`)).data;
        for (const sql of [
          'CREATE DATABASE evil',
          'create table t (a int); CREATE ROLE evil LOGIN',
          'ALTER SYSTEM SET fsync = off',
        ]) {
          const r = await call('POST', `/api/projects/${pid}/import`, { sql });
          expect(r.status, sql).toBe(422);
          expect(String(r.data.error)).toMatch(/^导入的 SQL 含实例级语句（.+）。实例级语句不能放进迁移/);
          expect(executed, sql).toEqual([]);
          // 路由层在准备影子库（forProject：可能建 {库名}_dowel、拿检查锁）之前就拒绝了
          expect(forProjectCalls, sql).toBe(0);
        }
        expect((await call('GET', `/api/projects/${pid}/ddl`)).data).toEqual(before);
        // 对照：没有实例级语句的导入照常走到 forProject
        await call('POST', `/api/projects/${pid}/import`, { sql: 'create table ok (a int)' });
        expect(forProjectCalls).toBe(1);
      } finally {
        restore();
      }
    },
  );

  test.skipIf(skip)(
    '步骤报错的消息里有连接串密码：响应、存下来的 verify_report 里都不会出现密码',
    async () => {
      const pid = await newProject('scrub-report');
      await addTable(created.rooms, db, pid);
      // 发布时验证失败：422 响应里的报告
      const leaky = (code: string, msg: string) =>
        Object.assign(new Error(`${msg} postgres://u:pw@h/db`), { code });
      const failingDb = (sqlStart: string, nth: number, err: Error): Db => {
        let n = 0;
        return {
          query: async (q) => (q.includes('server_version_num') ? ([{ v: 180000 }] as never) : ([] as never)),
          exec: async (sql) => {
            if (sql.startsWith(sqlStart) && ++n === nth) throw err;
          },
        };
      };
      let restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: shadowOps(async () =>
          failingDb('CREATE TABLE', 1, leaky('42704', 'type "x" does not exist')),
        ),
      }));
      const rejected = await publish(pid, 'v1');
      restore();
      expect(rejected.status).toBe(422);
      expect(JSON.stringify(rejected.data)).not.toContain('pw');
      expect(rejected.data.report!.error!.message).toContain('postgres://u:***@h/db');

      // 发布成功后重新验证，脚本在影子库里执行失败：写进 verify_report 的报告和响应里都没有密码
      restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: { verifyScripts: async () => okReport },
      }));
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      restore();
      restore = stubShadows(async () => ({
        label: 'stub：shadow',
        // 建 to 是第 1 次 CREATE TABLE，被验证的 up 是第 2 次
        shadow: shadowOps(async () =>
          failingDb('CREATE TABLE', 2, leaky('42704', 'type "x" does not exist')),
        ),
      }));
      const re = await reverify(pid, v1.id);
      restore();
      expect(re.status).toBe(200);
      expect(re.data.report!.ok).toBe(false);
      expect(JSON.stringify(re.data)).not.toContain('pw');
      const stored = await detail(pid, v1.id);
      expect(JSON.stringify(stored.verifyReport)).not.toContain('pw');
      expect(stored.verifyReport!.error!.message).toContain('postgres://u:***@h/db');
      const [row] = await db.query<{ verify_report: unknown }>(
        'select verify_report from versions where id = $1',
        [v1.id],
      );
      expect(JSON.stringify(row!.verify_report)).not.toContain('pw');
    },
  );

  test.skipIf(skip)('编辑脚本：实例级语句返回 422，说明哪一边第几步；不会保存', async () => {
    const pid = await newProject('instance-level');
    await addTable(created.rooms, db, pid);
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    const d1 = await detail(pid, v1.id);
    for (const sql of [
      'CREATE DATABASE evil',
      'DROP DATABASE shop',
      'ALTER SYSTEM SET fsync = off',
      'CREATE ROLE evil SUPERUSER',
      "ALTER USER app PASSWORD 'x'",
      "CREATE TABLESPACE t LOCATION '/tmp'",
      'UPDATE t SET a = 1; CREATE DATABASE evil',
    ]) {
      const up = await patchSteps(pid, v1.id, [...d1.upSteps, step(sql)], d1.downSteps);
      expect(up.status, sql).toBe(422);
      expect(String(up.data.error)).toContain(`升级脚本第 ${d1.upSteps.length + 1} 步`);
      expect(String(up.data.error)).toContain('实例级语句不能放进迁移');
      const down = await patchSteps(pid, v1.id, d1.upSteps, [step(sql), ...d1.downSteps]);
      expect(down.status, sql).toBe(422);
      expect(String(down.data.error)).toContain('回滚脚本第 1 步');
    }
    // 没有保存任何东西
    expect(await detail(pid, v1.id)).toMatchObject({ edited: false, checksum: d1.checksum });
    // 注释和字符串里提到这些词不算
    const ok = await patchSteps(
      pid,
      v1.id,
      [...d1.upSteps, step("COMMENT ON TABLE public.orders IS 'CREATE DATABASE x'")],
      d1.downSteps,
    );
    expect(ok.status).toBe(200);
  });

  test.skipIf(skip)('/verify（预览验证）遇到连接断开：422，前缀只出现一次', async () => {
    const pid = await newProject('verify-preview');
    await addTable(created.rooms, db, pid);
    const restore = stubShadows(async () => ({
      label: 'stub：shadow',
      shadow: shadowOps(async () => droppedDb()),
    }));
    const r = await call('POST', `/api/projects/${pid}/verify`, {});
    restore();
    expect(r.status).toBe(422);
    expect(r.data.error).toBe('影子库不可用：连接断开了');
  });

  test.skipIf(skip)(
    '版本记下冻结时的 schema 范围：之后改了项目范围，重新验证第一个版本的结果不变',
    async () => {
      const pid = await newProject('scope-recorded');
      await addTable(created.rooms, db, pid);
      // 记录重新验证时拿到的 from（第一个版本的 from 就是空库模型）
      const froms: Model[] = [];
      const restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: {
          verifyScripts: async (from) => {
            froms.push(from);
            return okReport;
          },
        },
      }));
      try {
        const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated; // 范围是全部（null）
        const [row] = await db.query<{ scope: string[] | null }>('select scope from versions where id = $1', [
          v1.id,
        ]);
        expect(row!.scope).toBeNull();
        expect((await reverify(pid, v1.id)).status).toBe(200);
        const before = froms.at(-1)!;
        expect(Object.values(before.objects).map((o) => o.kind === 'schema' && o.name)).toEqual(['public']);

        // 项目范围之后改成 ['app']：重新验证 v1 仍然用冻结时的范围（带 public 的空库），结果一样
        expect((await call('PATCH', `/api/projects/${pid}`, { schemas: ['app'] })).status).toBe(200);
        expect((await reverify(pid, v1.id)).status).toBe(200);
        expect(froms.at(-1)).toEqual(before);

        // 新发布的版本记下的是发布时的范围
        await editModel(created.rooms, db, pid, (m) => void addNote(m));
        const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
        const [row2] = await db.query<{ scope: string[] | null }>(
          'select scope from versions where id = $1',
          [v2.id],
        );
        expect(row2!.scope).toEqual(['app']);
      } finally {
        restore();
      }
    },
  );

  test.skipIf(skip)('保存脚本时，不能进事务的语句强制标为非事务（用户手动标的也保留）', async () => {
    const pid = await newProject('force-nontx');
    await addTable(created.rooms, db, pid);
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    const up: ScriptStep[] = [
      // 客户端说可以进事务，但语句不行
      { sql: 'CREATE INDEX CONCURRENTLY orders_id ON public.orders (id)', transactional: true },
      { sql: "ALTER TYPE public.status ADD VALUE 'archived'", transactional: true },
      // 语句本身可以进事务，但用户手动标成非事务：保留
      { sql: 'ALTER TABLE public.orders ADD COLUMN c text', transactional: false },
      { sql: 'ALTER TABLE public.orders ADD COLUMN d text', transactional: true },
    ];
    const down: ScriptStep[] = [
      { sql: 'DROP INDEX CONCURRENTLY public.orders_id', transactional: true },
      { sql: 'VACUUM public.orders', transactional: true },
    ];
    const r = await patchSteps(pid, v1.id, up, down);
    expect(r.status).toBe(200);
    const d = await detail(pid, v1.id);
    expect(d.upSteps.map((s) => s.transactional)).toEqual([false, false, false, true]);
    expect(d.downSteps.map((s) => s.transactional)).toEqual([false, false]);
    // checksum 按存下来的（强制之后的）步骤算
    expect(d.checksum).toBe(stepsChecksum(d.upSteps, d.downSteps));
  });

  /** 把工作副本换成只有 app.orders 的模型（public 被删掉） */
  const dropPublic = (pid: string) =>
    editModel(created.rooms, db, pid, (m) => {
      for (const o of Object.values(m.objects))
        if (o.kind === 'schema' && o.name === 'public') delete m.objects[o.id];
      const app = createSchema(m, 'app');
      addColumn(m, createTable(m, app, 'orders'), { name: 'id', type: 'bigint' });
    });

  test.skipIf(skip)('schema 范围是 [app]（不含 public）：第一个版本和后面的版本都不碰 public', async () => {
    const pid = await newProject('no-public');
    expect((await call('PATCH', `/api/projects/${pid}`, { schemas: ['app'] })).status).toBe(200);
    await dropPublic(pid);
    const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
    const d1 = await detail(pid, v1.id);
    expect(d1.upSteps.map((s) => s.sql)[0]).toBe('CREATE SCHEMA app');
    expect([...d1.upSteps, ...d1.downSteps].map((s) => s.sql).join('\n')).not.toMatch(/public/);
    await editModel(created.rooms, db, pid, (m) => void addNote(m));
    const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
    expect([...(await detail(pid, v2.id)).upSteps].map((s) => s.sql)).toEqual([
      'ALTER TABLE app.orders ADD COLUMN note text',
    ]);
    // 预览接口的“从空库”同样不碰 public
    const mig = await call('GET', `/api/projects/${pid}/migration?from=empty&to=${v1.id}`);
    expect((mig.data.up as unknown as { sql: string }[]).map((s) => s.sql).join('\n')).not.toMatch(/public/);
  });

  test.skipIf(skip)(
    '范围是全部（null），用户把 public 删了：第一个版本要 DROP SCHEMA public（全新的库本来就有它）',
    async () => {
      const pid = await newProject('drop-public');
      await dropPublic(pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      const d1 = await detail(pid, v1.id);
      expect(d1.upSteps.map((s) => s.sql)).toContain('DROP SCHEMA public');
      expect(d1.downSteps.map((s) => s.sql)).toContain('CREATE SCHEMA public');
      const mig = await call('GET', `/api/projects/${pid}/migration?from=empty&to=${v1.id}`);
      expect((mig.data.up as unknown as { sql: string }[]).map((s) => s.sql)).toContain('DROP SCHEMA public');
    },
  );

  test.skipIf(skip || platform !== 'pg')(
    'PG：发布和编辑脚本锁同一行（项目行），检查链头和写入串行化',
    async () => {
      const pid = await newProject('chain-lock');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      const d1 = await detail(pid, v1.id);
      await editModel(created.rooms, db, pid, (m) => void addNote(m));
      const [branch] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);

      // 在另一个事务里先锁住项目行，模拟“别人正在发布 v2”：这时发来的 PATCH 和发布都必须等着
      let patchDone = false;
      let publishDone = false;
      let pending: Promise<[Awaited<ReturnType<typeof patchSteps>>, Awaited<ReturnType<typeof publish>>]>;
      await db.transaction(async (tx) => {
        await tx.query('select id from projects where id = $1 for update', [pid]);
        const p = patchSteps(pid, v1.id, [{ sql: 'SELECT 1', transactional: true }], d1.downSteps).then(
          (r) => {
            patchDone = true;
            return r;
          },
        );
        const q = publish(pid, 'v2').then((r) => {
          publishDone = true;
          return r;
        });
        pending = Promise.all([p, q]);
        await new Promise((r) => setTimeout(r, 600));
        expect(patchDone, 'PATCH 应该在项目行的锁上等待').toBe(false);
        expect(publishDone, '发布应该在项目行的锁上等待').toBe(false);
        // 别人的发布提交了 v2
        await tx.query(
          `insert into versions (id, project_id, branch_id, seq, name, model, number, parent_id, up_steps, down_steps, checksum)
           values ('lock-v2', $1, $2, 99, 'v2', $3::text::jsonb, 2, $4, '[]'::text::jsonb, '[]'::text::jsonb, $5)`,
          [pid, branch!.id, JSON.stringify(emptyModel()), v1.id, stepsChecksum([], [])],
        );
      });
      const [patched, published] = await pending!;
      // 锁释放后重新检查链头：v1 已经不是最新，发布的 parent 也过期了
      expect(patched.status).toBe(409);
      expect(String(patched.data.error)).toContain('最新');
      expect(published.status).toBe(409);
      expect(await detail(pid, v1.id)).toMatchObject({ edited: false, checksum: d1.checksum });
      expect((await list(pid)).map((v) => v.number)).toEqual([2, 1]);
    },
  );

  test.skipIf(skip)(
    'Medium #7: /published-tables 覆盖所有历史已发布版本中出现过的表 ID（含 v1 发布、v2 删除的表）',
    async () => {
      const pid = await newProject('pub-tables');
      const r0 = await call('GET', `/api/projects/${pid}/published-tables`);
      expect(r0.status).toBe(200);
      expect((r0.data as unknown as PublishedTables).tableIds).toEqual([]);

      let t1Id = '';
      let t2Id = '';
      await editModel(created.rooms, db, pid, (m) => {
        const pub = all(m, 'schema').find((s) => s.name === 'public')!;
        t1Id = createTable(m, pub.id, 't_one');
        addColumn(m, t1Id, { name: 'id', type: 'integer', notNull: true });
      });
      expect((await publish(pid, 'v1')).status).toBe(201);

      await editModel(created.rooms, db, pid, (m) => {
        const pub = all(m, 'schema').find((s) => s.name === 'public')!;
        dropTable(m, t1Id);
        t2Id = createTable(m, pub.id, 't_two');
        addColumn(m, t2Id, { name: 'id', type: 'integer', notNull: true });
      });
      expect((await publish(pid, 'v2')).status).toBe(201);

      const r2 = await call('GET', `/api/projects/${pid}/published-tables`, undefined, viewer);
      expect(r2.status).toBe(200);
      const ids = (r2.data as unknown as PublishedTables).tableIds;
      expect(ids).toContain(t1Id);
      expect(ids).toContain(t2Id);
    },
  );

  // ───── ADR 0013：链尾版本作废 / 取消作废 / 应用到画布 ─────

  test.skipIf(skip)(
    '作废后发布编号只增不重用，latest/列表字段正确，已作废版本禁编辑但可按 parent_id 重新验证',
    async () => {
      const pid = await newProject('adr13-numbering');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c2'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c3'));
      const v3 = (await publish(pid, 'v3')).data as unknown as VersionCreated;

      // 作废 v3（默认回退工作副本到 v2）
      const ret3 = await retire(pid, v3.id, { head: v3.id }, editor);
      expect(ret3.status).toBe(200);
      const ret3Data = ret3.data as unknown as VersionRetireResult;
      expect(ret3Data).toMatchObject({
        retired: [{ id: v3.id, number: 3, name: 'v3' }],
        head: { id: v2.id, number: 2, name: 'v2' },
        invalidatedRequests: 0,
        workingCopy: 'reverted',
      });

      // 工作副本已回到 v2，直接点发布应报“与当前活跃版本（v2）没有变更”
      const noChange = await publish(pid, 'dup');
      expect(noChange.status).toBe(422);
      expect(String(noChange.data.error)).toContain('v2');

      // 修改工作副本并发布：编号必须是全局 max + 1 = 4，parent 是活跃链头 v2
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c4'));
      const v4 = (await publish(pid, 'v4')).data as unknown as VersionCreated;
      expect(v4.number).toBe(4);

      // 再次作废 v4 并发布，编号跳到 5，parent 仍为 v2
      expect((await retire(pid, v4.id, { head: v4.id })).status).toBe(200);
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c5'));
      const v5 = (await publish(pid, 'v5')).data as unknown as VersionCreated;
      expect(v5.number).toBe(5);

      const items = await list(pid);
      expect(
        items.map((x) => ({
          n: x.number,
          parentId: x.parentId,
          latest: x.latest,
          retired: x.retiredAt !== null,
          retiredBy: x.retiredBy,
          executed: x.executed,
          unretirable: x.unretirable,
        })),
      ).toEqual([
        {
          n: 5,
          parentId: v2.id,
          latest: true,
          retired: false,
          retiredBy: null,
          executed: false,
          unretirable: false,
        },
        {
          n: 4,
          parentId: v2.id,
          latest: false,
          retired: true,
          retiredBy: '编辑者',
          executed: false,
          unretirable: false,
        },
        {
          n: 3,
          parentId: v2.id,
          latest: false,
          retired: true,
          retiredBy: '编辑者',
          executed: false,
          unretirable: false,
        },
        {
          n: 2,
          parentId: v1.id,
          latest: false,
          retired: false,
          retiredBy: null,
          executed: false,
          unretirable: false,
        },
        {
          n: 1,
          parentId: null,
          latest: false,
          retired: false,
          retiredBy: null,
          executed: false,
          unretirable: false,
        },
      ]);

      // 详情也携带一致的新字段
      const d3 = await detail(pid, v3.id);
      expect(d3.latest).toBe(false);
      expect(d3.retiredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(d3.retiredBy).toBe('编辑者');
      expect(d3.executed).toBe(false);
      expect(d3.unretirable).toBe(false);

      // 已作废版本禁止编辑脚本（409），新活跃链头 v5 允许编辑脚本
      expect((await patchSteps(pid, v3.id, d3.upSteps, d3.downSteps)).status).toBe(409);
      const d5 = await detail(pid, v5.id);
      expect((await patchSteps(pid, v5.id, [...d5.upSteps, step('SELECT 1')], d5.downSteps)).status).toBe(
        200,
      );

      // 重新验证：已作废版本 v4 和跳号版本 v5 都必须按 parent_id (v2) 而非 number - 1 作为 from
      const d2 = await detail(pid, v2.id);
      const seenFromCols: string[][] = [];
      const restore = stubShadows(async () => ({
        label: 'stub：shadow',
        shadow: {
          verifyScripts: async (from) => {
            seenFromCols.push(all(from, 'column').map((c) => c.name));
            return okReport;
          },
        },
      }));
      try {
        expect((await reverify(pid, v4.id)).status).toBe(200);
        expect((await reverify(pid, v5.id)).status).toBe(200);
        expect(seenFromCols).toEqual([
          ['id', 'c2'],
          ['id', 'c2'],
        ]);
        expect(d2.number).toBe(2);
      } finally {
        restore();
      }
    },
  );

  test.skipIf(skip)(
    'GET /published-tables 排除已作废且从未执行过的版本，但保留已作废且已执行过的版本',
    async () => {
      const pid = await newProject('adr13-pub-tables');
      let tKeep = '';
      let tRetiredExec = '';
      let tRetiredUnexec = '';
      await editModel(created.rooms, db, pid, (m) => {
        const pub = all(m, 'schema').find((s) => s.name === 'public')!;
        tKeep = createTable(m, pub.id, 't_keep');
        addColumn(m, tKeep, { name: 'id', type: 'integer', notNull: true });
      });
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;

      await editModel(created.rooms, db, pid, (m) => {
        const pub = all(m, 'schema').find((s) => s.name === 'public')!;
        tRetiredExec = createTable(m, pub.id, 't_retired_exec');
        addColumn(m, tRetiredExec, { name: 'id', type: 'integer', notNull: true });
      });
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
      await db.query('update versions set executed_at = $2 where id = $1', [v2.id, new Date().toISOString()]);

      await editModel(created.rooms, db, pid, (m) => {
        const pub = all(m, 'schema').find((s) => s.name === 'public')!;
        tRetiredUnexec = createTable(m, pub.id, 't_retired_unexec');
        addColumn(m, tRetiredUnexec, { name: 'id', type: 'integer', notNull: true });
      });
      const v3 = (await publish(pid, 'v3')).data as unknown as VersionCreated;

      // 作废 v2 与 v3（含已执行的 v2，需 admin）
      expect((await retire(pid, v2.id, { head: v3.id }, admin)).status).toBe(200);

      const res = await call('GET', `/api/projects/${pid}/published-tables`, undefined, viewer);
      expect(res.status).toBe(200);
      const ids = (res.data as unknown as PublishedTables).tableIds;
      expect(ids).toContain(tKeep);
      expect(ids).toContain(tRetiredExec);
      expect(ids).not.toContain(tRetiredUnexec);
      expect(v1.number).toBe(1);
    },
  );

  test.skipIf(skip)(
    'retire 校验与权限分级：首版本422 / 已作废422 / head过期409 / claimed 409 / 已执行需admin / 工作副本四种结果',
    async () => {
      const pid = await newProject('adr13-retire-rules');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c2'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c3'));
      const v3 = (await publish(pid, 'v3')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c4'));
      const v4 = (await publish(pid, 'v4')).data as unknown as VersionCreated;

      // 1. 不存在 404，首版本 422，head 不匹配 409 head_changed，viewer 403
      expect((await retire(pid, 'nope', { head: v4.id })).status).toBe(404);
      expect((await retire(pid, v4.id, { head: v4.id }, viewer)).status).toBe(403);
      expect((await retire(pid, v1.id, { head: v4.id })).status).toBe(422);
      const badHead = await retire(pid, v3.id, { head: v3.id });
      expect(badHead.status).toBe(409);
      expect(badHead.data.code).toBe('head_changed');

      // 2. 存在 claimed 进行中执行 → 409 execution_in_progress，且列表 executed=true
      const envId = newId();
      await db.query(
        `insert into environments (id, project_id, name, url_enc, production)
         values ($1, $2, 'staging', $3, false)`,
        [envId, pid, encrypt('postgres://127.0.0.1:1/stg')],
      );
      await db.query(
        `insert into environment_versions (environment_id, version_id, state)
         values ($1, $2, 'claimed')`,
        [envId, v4.id],
      );
      expect((await list(pid)).find((x) => x.id === v4.id)!.executed).toBe(true);
      const claimedRes = await retire(pid, v3.id, { head: v4.id }, admin);
      expect(claimedRes.status).toBe(409);
      expect(claimedRes.data.code).toBe('execution_in_progress');
      expect(String(claimedRes.data.error)).toContain('v4');
      expect(String(claimedRes.data.error)).toContain('staging');
      await db.query('delete from environment_versions where environment_id = $1', [envId]);

      // 3. 含 executed_at：editor 403，admin 200；同时测试 keepWorkingCopy = true（outcome = 'kept'）
      await db.query('update versions set executed_at = $2 where id = $1', [v3.id, new Date().toISOString()]);
      expect((await retire(pid, v3.id, { head: v4.id, keepWorkingCopy: true }, editor)).status).toBe(403);
      const ret34 = await retire(pid, v3.id, { head: v4.id, keepWorkingCopy: true }, admin);
      expect(ret34.status).toBe(200);
      expect(ret34.data as unknown as VersionRetireResult).toMatchObject({
        retired: [
          { id: v3.id, number: 3, name: 'v3' },
          { id: v4.id, number: 4, name: 'v4' },
        ],
        head: { id: v2.id, number: 2, name: 'v2' },
        workingCopy: 'kept',
      });

      // 已作废版本再次 retire → 422
      const alreadyRetired = await retire(pid, v4.id, { head: v2.id }, admin);
      expect(alreadyRetired.status).toBe(422);

      // 4. 取消作废 [v3, v4] 权限分级：editor 403（因 v3 executed_at 非空），admin 200（顺便测 syncWorkingCopy: true）
      expect((await unretire(pid, v4.id, { syncWorkingCopy: false }, editor)).status).toBe(403);
      const unret = await unretire(pid, v3.id, { syncWorkingCopy: true }, admin);
      expect(unret.status).toBe(200);
      expect(unret.data as unknown as VersionUnretireResult).toMatchObject({
        restored: [
          { id: v3.id, number: 3, name: 'v3' },
          { id: v4.id, number: 4, name: 'v4' },
        ],
        head: { id: v4.id, number: 4, name: 'v4' },
        // 工作副本之前保留了 v4 的模型，因此本来就一致
        workingCopy: 'unchanged',
      });

      // 5. 工作副本回退 outcome = 'reverted' 与画布历史 opName='retireVersions'，以及 workingSeq 过时 → 'changed'
      const ret4Reverted = await retire(pid, v4.id, { head: v4.id, keepWorkingCopy: false }, editor);
      expect(ret4Reverted.status).toBe(200);
      expect((ret4Reverted.data as unknown as VersionRetireResult).workingCopy).toBe('reverted');
      const histAfterRetire = (await call('GET', `/api/projects/${pid}/history`))
        .data as unknown as CanvasHistoryList;
      expect(histAfterRetire.entries[0]!.opName).toBe('retireVersions');

      // 同步回 v4（带着正确 workingSeq）→ reverted，并记为 unretireVersions
      const unretSync = await unretire(
        pid,
        v4.id,
        { syncWorkingCopy: true, workingSeq: histAfterRetire.currentSeq },
        editor,
      );
      expect(unretSync.status).toBe(200);
      expect((unretSync.data as unknown as VersionUnretireResult).workingCopy).toBe('reverted');
      const histAfterUnretire = (await call('GET', `/api/projects/${pid}/history`))
        .data as unknown as CanvasHistoryList;
      expect(histAfterUnretire.entries[0]!.opName).toBe('unretireVersions');

      // 过时 workingSeq：作废仍然成功，workingCopy = 'changed' 且工作副本 seq 不变
      const retChanged = await retire(pid, v4.id, { head: v4.id, workingSeq: 0 }, editor);
      expect(retChanged.status).toBe(200);
      expect((retChanged.data as unknown as VersionRetireResult).workingCopy).toBe('changed');
      const histNoChange = (await call('GET', `/api/projects/${pid}/history`))
        .data as unknown as CanvasHistoryList;
      expect(histNoChange.currentSeq).toBe(histAfterUnretire.currentSeq);
    },
  );

  test.skipIf(skip)(
    'unretire 严格路径语义：复杂分叉仅恢复 (activeHead, globalMax]，旧岔路永久作废；对活跃版本返 409',
    async () => {
      const pid = await newProject('adr13-unretire-tree');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      for (let i = 2; i <= 5; i++) {
        await editModel(created.rooms, db, pid, (m) => void addNote(m, `c${i}`));
        const v = (await publish(pid, `v${i}`)).data as unknown as VersionCreated;
        expect(v.number).toBe(i);
      }
      const initialList = await list(pid);
      const idOf = (n: number) => initialList.find((x) => x.number === n)!.id;

      // 对活跃版本调 unretire → 409 not_unretirable
      const activeUnretire = await unretire(pid, idOf(5));
      expect(activeUnretire.status).toBe(409);
      expect(activeUnretire.data.code).toBe('not_unretirable');

      // 复现 ADR 0013 示例：retire v5 → publish v6(parent v4) → retire v6 → retire v4
      expect((await retire(pid, idOf(5), { head: idOf(5) })).status).toBe(200);
      // 此时 v5.unretirable = true
      expect((await list(pid)).find((x) => x.number === 5)!.unretirable).toBe(true);

      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c6'));
      const v6 = (await publish(pid, 'v6')).data as unknown as VersionCreated;
      expect(v6.number).toBe(6);

      // 一旦基于 v4 发布 v6，v5 永久不可取消作废（unretirable = false）
      expect((await list(pid)).find((x) => x.number === 5)!.unretirable).toBe(false);
      const denyV5 = await unretire(pid, idOf(5));
      expect(denyV5.status).toBe(409);
      expect(denyV5.data.code).toBe('not_unretirable');
      expect(String(denyV5.data.error)).toContain('v4');
      expect(String(denyV5.data.error)).toContain('v6');

      // 再依次 retire v6 和 v4：此时 activeHead = v3，globalMax = v6，路径 (v3, v6] = [v4, v6]
      expect((await retire(pid, v6.id, { head: v6.id })).status).toBe(200);
      expect((await retire(pid, idOf(4), { head: idOf(4) })).status).toBe(200);

      const beforeRestore = await list(pid);
      expect(beforeRestore.map((x) => ({ n: x.number, unretirable: x.unretirable }))).toEqual([
        { n: 6, unretirable: true },
        { n: 5, unretirable: false },
        { n: 4, unretirable: true },
        { n: 3, unretirable: false },
        { n: 2, unretirable: false },
        { n: 1, unretirable: false },
      ]);

      // v5 仍然 409
      expect((await unretire(pid, idOf(5))).status).toBe(409);

      // 从 v4（或 v6）取消作废：只恢复 [v4, v6]，v5 永久保持作废
      const restored = await unretire(pid, idOf(4), { syncWorkingCopy: false });
      expect(restored.status).toBe(200);
      expect(restored.data as unknown as VersionUnretireResult).toMatchObject({
        restored: [
          { id: idOf(4), number: 4, name: 'v4' },
          { id: v6.id, number: 6, name: 'v6' },
        ],
        head: { id: v6.id, number: 6, name: 'v6' },
        workingCopy: 'kept',
      });
      const afterRestore = await list(pid);
      expect(afterRestore.find((x) => x.number === 5)!.retiredAt).not.toBeNull();
      expect(afterRestore.find((x) => x.number === 4)!.retiredAt).toBeNull();
      expect(afterRestore.find((x) => x.number === 6)!.retiredAt).toBeNull();
      expect(afterRestore.find((x) => x.number === 6)!.latest).toBe(true);
      expect(v1.number).toBe(1);
    },
  );

  test.skipIf(skip)(
    '应用到画布（canvas-diff / apply）：含已作废版本、working_changed 409、no-op、applyVersion 历史与审计',
    async () => {
      const pid = await newProject('adr13-apply-canvas');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'extra_col'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;

      // 作废 v2 后工作副本回到 v1
      expect((await retire(pid, v2.id, { head: v2.id })).status).toBe(200);

      // 预览应用已作废版本 v2 的差异
      const diffRes = await canvasDiff(pid, v2.id, viewer);
      expect(diffRes.status).toBe(200);
      const diff = diffRes.data as unknown as VersionCanvasDiff;
      expect(diff.diffToCurrent.total).toBeGreaterThan(0);
      expect(diff.diffToCurrent.items.some((i) => i.sql.includes('extra_col'))).toBe(true);

      // 权限：viewer 不能 apply
      expect((await applyVersion(pid, v2.id, diff.currentSeq, viewer)).status).toBe(403);

      // workingSeq 不匹配 → 409 CanvasHistoryConflict (working_changed)
      const conflictRes = await applyVersion(pid, v2.id, diff.currentSeq + 1, editor);
      expect(conflictRes.status).toBe(409);
      const conflict = conflictRes.data as unknown as CanvasHistoryConflict;
      expect(conflict.code).toBe('working_changed');
      expect(conflict.currentSeq).toBe(diff.currentSeq);
      expect(conflict.diffToCurrent.total).toBe(diff.diffToCurrent.total);

      // 正确 seq 应用已作废的 v2 → 200，生成新画布提交 opName='applyVersion' 及审计 model.apply_version
      const applied = await applyVersion(pid, v2.id, diff.currentSeq, editor);
      expect(applied.status).toBe(200);
      const updated = applied.data as unknown as ModelUpdate;
      expect(updated.seq).toBe(diff.currentSeq + 1);

      const hist = (await call('GET', `/api/projects/${pid}/history`)).data as unknown as CanvasHistoryList;
      expect(hist.entries[0]!.opName).toBe('applyVersion');
      const [auditRow] = await db.query<{ data: { versionId: string; number: number } }>(
        "select data from audit_events where project_id = $1 and action = 'model.apply_version'",
        [pid],
      );
      expect(auditRow!.data).toMatchObject({ versionId: v2.id, number: 2 });

      // 再次应用同一版本（工作副本已与 v2 一致）→ 200 no-op，不增加历史 seq
      const noop = await applyVersion(pid, v2.id, updated.seq, editor);
      expect(noop.status).toBe(200);
      expect((noop.data as unknown as ModelUpdate).seq).toBe(updated.seq);
      expect(v1.number).toBe(1);
    },
  );

  test.skipIf(skip)(
    '作废使关联开放执行申请按方向规则失效（排除 interrupted/executing），且 unretire 不复活已失效申请',
    async () => {
      const pid = await newProject('adr13-req-invalidation');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c2'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c3'));
      const v3 = (await publish(pid, 'v3')).data as unknown as VersionCreated;

      const d2 = await detail(pid, v2.id);
      const d3 = await detail(pid, v3.id);

      const urlEnc = encrypt('postgres://u:p@127.0.0.1:5432/reqinv');
      const hash = connHash({ url_enc: urlEnc });
      await db.query(
        `insert into environments (id, project_id, name, url_enc, production, current_version_id)
         values ('env-up', $1, 'env-up', $2, true, $3),
                ('env-down', $1, 'env-down', $2, true, $4),
                ('env-safe', $1, 'env-safe', $2, true, $5)`,
        [pid, urlEnc, v2.id, v3.id, v1.id],
      );
      const flow = JSON.stringify({ implicit: true, stages: [] });
      const future = new Date(Date.now() + 3600_000).toISOString();
      const createdBefore = new Date().toISOString();
      const insertReq = (opts: {
        id: string;
        envId: string;
        direction: 'up' | 'down';
        fromId: string | null;
        toId: string;
        migrations: unknown[];
        status: string;
        result?: unknown;
        createdAt?: string;
      }) =>
        db.query(
          `insert into exec_requests
             (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
              migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at, result)
           values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, null, '测试', $9::text::jsonb, $10, true, $11, 0, $12, $13, $13, $14::text::jsonb)`,
          [
            opts.id,
            pid,
            opts.envId,
            editorId,
            opts.direction,
            opts.fromId,
            opts.toId,
            JSON.stringify(opts.migrations),
            flow,
            hash,
            opts.status,
            future,
            opts.createdAt ?? createdBefore,
            opts.result ? JSON.stringify(opts.result) : null,
          ],
        );

      const migV3Up = [
        {
          versionId: v3.id,
          number: 3,
          name: 'v3',
          direction: 'up',
          checksum: d3.checksum,
          steps: 1,
          nonTransactional: 0,
        },
      ];
      const migV3Down = [
        {
          versionId: v3.id,
          number: 3,
          name: 'v3',
          direction: 'down',
          checksum: d3.checksum,
          steps: 1,
          nonTransactional: 0,
        },
      ];
      const migV2Up = [
        {
          versionId: v2.id,
          number: 2,
          name: 'v2',
          direction: 'up',
          checksum: d2.checksum,
          steps: 1,
          nonTransactional: 0,
        },
      ];

      await insertReq({
        id: 'r-up-pending',
        envId: 'env-up',
        direction: 'up',
        fromId: v2.id,
        toId: v3.id,
        migrations: migV3Up,
        status: 'pending',
      });
      await insertReq({
        id: 'r-up-failed',
        envId: 'env-up',
        direction: 'up',
        fromId: v2.id,
        toId: v3.id,
        migrations: migV3Up,
        status: 'failed',
      });
      await insertReq({
        id: 'r-up-int',
        envId: 'env-up',
        direction: 'up',
        fromId: v2.id,
        toId: v3.id,
        migrations: migV3Up,
        status: 'failed',
        result: { ok: false, code: 'interrupted', error: '断线', current: null },
      });
      await insertReq({
        id: 'r-up-exec',
        envId: 'env-up',
        direction: 'up',
        fromId: v2.id,
        toId: v3.id,
        migrations: migV3Up,
        status: 'executing',
      });
      // 作废前提交的普通回滚（v3 → v2）必须在作废后失效
      await insertReq({
        id: 'r-down-pre',
        envId: 'env-down',
        direction: 'down',
        fromId: v3.id,
        toId: v2.id,
        migrations: migV3Down,
        status: 'approved',
      });
      // 未涉及 v3 的申请不受影响
      await insertReq({
        id: 'r-safe',
        envId: 'env-safe',
        direction: 'up',
        fromId: v1.id,
        toId: v2.id,
        migrations: migV2Up,
        status: 'pending',
      });

      const ret = await retire(pid, v3.id, { head: v3.id });
      expect(ret.status).toBe(200);
      expect((ret.data as unknown as VersionRetireResult).invalidatedRequests).toBe(3);

      const statusMap = async () =>
        new Map(
          (
            await db.query<{ id: string; status: string; status_reason: string | null }>(
              'select id, status, status_reason from exec_requests where project_id = $1',
              [pid],
            )
          ).map((r) => [r.id, r]),
        );
      // 事务提交瞬间（无需先跑 sweep），受影响开放申请已持久化为 invalid，且写好收件箱通知与失效审计
      const immediateAfterRetire = await statusMap();
      expect(immediateAfterRetire.get('r-up-pending')!.status).toBe('invalid');
      expect(immediateAfterRetire.get('r-up-failed')!.status).toBe('invalid');
      expect(immediateAfterRetire.get('r-down-pre')!.status).toBe('invalid');
      expect(immediateAfterRetire.get('r-down-pre')!.status_reason).toContain('作废');
      expect(immediateAfterRetire.get('r-up-int')!.status).toBe('failed');
      expect(immediateAfterRetire.get('r-up-exec')!.status).toBe('executing');
      expect(immediateAfterRetire.get('r-safe')!.status).toBe('pending');
      const invInbox = await db.query<{ request_id: string }>(
        "select request_id from inbox_items where project_id = $1 and kind = 'request_result' and user_id = $2",
        [pid, editorId],
      );
      expect(invInbox.map((r) => r.request_id).sort()).toEqual(['r-down-pre', 'r-up-failed', 'r-up-pending']);
      const invAudits = await db.query<{ target_id: string }>(
        "select target_id from audit_events where project_id = $1 and action = 'exec_request.invalidate'",
        [pid],
      );
      expect(invAudits).toHaveLength(3);

      expect(await created.requests.sweep({ projectIds: [pid] })).toBe(0);
      const afterRetire = await statusMap();
      expect(afterRetire.get('r-up-pending')!.status).toBe('invalid');
      expect(afterRetire.get('r-up-failed')!.status).toBe('invalid');
      expect(afterRetire.get('r-down-pre')!.status).toBe('invalid');
      expect(afterRetire.get('r-down-pre')!.status_reason).toContain('作废');
      expect(afterRetire.get('r-up-int')!.status).toBe('failed');
      expect(afterRetire.get('r-up-exec')!.status).toBe('executing');
      expect(afterRetire.get('r-safe')!.status).toBe('pending');

      // 作废之后新建的 switch（先 down v3 再 up v4）在 sweep 后保持有效；再作废 v4 才失效
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c4'));
      const v4 = (await publish(pid, 'v4')).data as unknown as VersionCreated;
      const d4 = await detail(pid, v4.id);
      await insertReq({
        id: 'r-switch-post',
        envId: 'env-down',
        direction: 'up',
        fromId: v3.id,
        toId: v4.id,
        migrations: [
          ...migV3Down,
          {
            versionId: v4.id,
            number: 4,
            name: 'v4',
            direction: 'up',
            checksum: d4.checksum,
            steps: 1,
            nonTransactional: 0,
          },
        ],
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      await created.requests.sweep({ projectIds: [pid] });
      expect((await statusMap()).get('r-switch-post')!.status).toBe('pending');

      // 作废 v4 后 switch 申请立即失效；之后再 unretire v4，已失效申请不会复活
      expect((await retire(pid, v4.id, { head: v4.id })).status).toBe(200);
      expect((await statusMap()).get('r-switch-post')!.status).toBe('invalid');

      expect((await unretire(pid, v4.id)).status).toBe(200);
      const finalMap = await statusMap();
      expect(finalMap.get('r-switch-post')!.status).toBe('invalid');
      expect(finalMap.get('r-up-pending')!.status).toBe('invalid');
    },
  );

  test.skipIf(skip)(
    'retire 后不先 sweep 立即 unretire：作废前开放申请永久保持失效且不可审批或执行，直接写库后 unretire 也能防御性失效',
    async () => {
      const pid = await newProject('adr13-no-sweep-unretire');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c2'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;
      const d2 = await detail(pid, v2.id);

      const urlEnc = encrypt('postgres://u:p@127.0.0.1:5432/nosweep');
      const hash = connHash({ url_enc: urlEnc });
      await db.query(
        `insert into environments (id, project_id, name, url_enc, production, current_version_id)
         values ('env-ns-up', $1, 'env-ns-up', $2, true, $3),
                ('env-ns-down', $1, 'env-ns-down', $2, true, $4)`,
        [pid, urlEnc, v1.id, v2.id],
      );
      const flow = JSON.stringify({ implicit: true, stages: [] });
      const future = new Date(Date.now() + 3600_000).toISOString();
      const createdBefore = new Date(Date.now() - 10_000).toISOString();
      const insertReq = (opts: {
        id: string;
        envId: string;
        direction: 'up' | 'down';
        fromId: string;
        toId: string;
        migrations: unknown[];
        status: string;
      }) =>
        db.query(
          `insert into exec_requests
             (id, project_id, environment_id, requested_by, direction, from_version_id, to_version_id,
              migrations, dry_run, reason, flow, conn_hash, production, status, stage, expires_at, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, null, '竞态回归', $9::text::jsonb, $10, true, $11, 0, $12, $13, $13)`,
          [
            opts.id,
            pid,
            opts.envId,
            editorId,
            opts.direction,
            opts.fromId,
            opts.toId,
            JSON.stringify(opts.migrations),
            flow,
            hash,
            opts.status,
            future,
            createdBefore,
          ],
        );

      const reqUpId = newId();
      const reqDownId = newId();
      await insertReq({
        id: reqUpId,
        envId: 'env-ns-up',
        direction: 'up',
        fromId: v1.id,
        toId: v2.id,
        migrations: [
          {
            versionId: v2.id,
            number: 2,
            name: 'v2',
            direction: 'up',
            checksum: d2.checksum,
            steps: 1,
            nonTransactional: 0,
          },
        ],
        status: 'pending',
      });
      await insertReq({
        id: reqDownId,
        envId: 'env-ns-down',
        direction: 'down',
        fromId: v2.id,
        toId: v1.id,
        migrations: [
          {
            versionId: v2.id,
            number: 2,
            name: 'v2',
            direction: 'down',
            checksum: d2.checksum,
            steps: 1,
            nonTransactional: 0,
          },
        ],
        status: 'approved',
      });

      // 作废后完全不调用 sweep()，立刻 unretire
      const ret = await retire(pid, v2.id, { head: v2.id, keepWorkingCopy: true }, editor);
      expect(ret.status).toBe(200);
      expect((ret.data as unknown as VersionRetireResult).invalidatedRequests).toBe(2);

      const unret = await unretire(pid, v2.id, { syncWorkingCopy: false }, editor);
      expect(unret.status).toBe(200);

      for (const rid of [reqUpId, reqDownId]) {
        const [row] = await db.query<{ status: string }>('select status from exec_requests where id = $1', [
          rid,
        ]);
        expect(row!.status).toBe('invalid');
      }
      expect(
        (
          await call(
            'POST',
            `/api/projects/${pid}/requests/${reqUpId}/approve`,
            { stage: 0, comment: 'try' },
            admin,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await call(
            'POST',
            `/api/projects/${pid}/requests/${reqDownId}/execute`,
            { confirm: 'env-ns-down' },
            admin,
          )
        ).status,
      ).toBe(409);

      // 防御性路径：绕过 retire 路由直接改库置 retired_at 后，不跑 sweep 直接 unretire，仍会在清空前原子失效残留开放申请
      const reqDirectId = newId();
      await insertReq({
        id: reqDirectId,
        envId: 'env-ns-up',
        direction: 'up',
        fromId: v1.id,
        toId: v2.id,
        migrations: [
          {
            versionId: v2.id,
            number: 2,
            name: 'v2',
            direction: 'up',
            checksum: d2.checksum,
            steps: 1,
            nonTransactional: 0,
          },
        ],
        status: 'pending',
      });
      await db.query('update versions set retired_at = $2 where id = $1', [v2.id, new Date().toISOString()]);

      const unretDef = await unretire(pid, v2.id, { syncWorkingCopy: false }, editor);
      expect(unretDef.status).toBe(200);
      const [directRow] = await db.query<{ status: string }>(
        'select status from exec_requests where id = $1',
        [reqDirectId],
      );
      expect(directRow!.status).toBe('invalid');
      expect(
        (
          await call(
            'POST',
            `/api/projects/${pid}/requests/${reqDirectId}/approve`,
            { stage: 0, comment: 'try' },
            admin,
          )
        ).status,
      ).toBe(409);
    },
  );

  test.skipIf(skip)(
    'syncWorkingCopy 抛出非 WorkingChangedError 异常时：retire 与 unretire 均返回 200 (workingCopy=failed) 且正常写入审计',
    async () => {
      const pid = await newProject('adr13-sync-wc-failed');
      await addTable(created.rooms, db, pid);
      const v1 = (await publish(pid, 'v1')).data as unknown as VersionCreated;
      await editModel(created.rooms, db, pid, (m) => void addNote(m, 'c2'));
      const v2 = (await publish(pid, 'v2')).data as unknown as VersionCreated;

      const origReplace = created.rooms.replace.bind(created.rooms);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        created.rooms.replace = (async () => {
          throw new Error('模拟房间替换故障');
        }) as typeof created.rooms.replace;

        const ret = await retire(pid, v2.id, { head: v2.id, keepWorkingCopy: false }, editor);
        expect(ret.status).toBe(200);
        expect(ret.data as unknown as VersionRetireResult).toMatchObject({
          retired: [{ id: v2.id, number: 2, name: 'v2' }],
          head: { id: v1.id, number: 1, name: 'v1' },
          workingCopy: 'failed',
        });

        // 因上次同步失败工作副本仍停在 v2，先还原 replace 在画布做一次编辑使工作副本偏离 v2，再测 unretire 同步失败分支
        created.rooms.replace = origReplace;
        await editModel(created.rooms, db, pid, (m) => void addNote(m, 'dirty_before_unretire'));
        created.rooms.replace = (async () => {
          throw new Error('模拟房间替换故障');
        }) as typeof created.rooms.replace;

        const unret = await unretire(pid, v2.id, { syncWorkingCopy: true }, editor);
        expect(unret.status).toBe(200);
        expect(unret.data as unknown as VersionUnretireResult).toMatchObject({
          restored: [{ id: v2.id, number: 2, name: 'v2' }],
          head: { id: v2.id, number: 2, name: 'v2' },
          workingCopy: 'failed',
        });
      } finally {
        created.rooms.replace = origReplace;
        errSpy.mockRestore();
      }

      const [v2Row] = await db.query<{ retired_at: unknown }>(
        'select retired_at from versions where id = $1',
        [v2.id],
      );
      expect(v2Row!.retired_at).toBeNull();

      const audits = await db.query<{ action: string; data: { workingCopy?: string } }>(
        "select action, data from audit_events where project_id = $1 and action in ('version.retire', 'version.unretire') order by at asc",
        [pid],
      );
      expect(audits).toHaveLength(2);
      expect(audits.map((a) => ({ action: a.action, workingCopy: a.data.workingCopy }))).toEqual([
        { action: 'version.retire', workingCopy: 'failed' },
        { action: 'version.unretire', workingCopy: 'failed' },
      ]);
    },
  );
});
