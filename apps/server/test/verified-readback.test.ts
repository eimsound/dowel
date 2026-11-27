// Issue #132 / ADR 0017：“已验证”的冻结版本必须能通过执行器读回校验（readback_mismatch）。
// 不变式：一个版本 verified = true，就必须能在空目标库上执行成功（执行器读回 diffAgainst 为 0）。
// - 规范化只在写入这一层（ADR 0017 决定 6）：经 mutator 写入的模型与读回零差异；
// - 发布是一条流水线（决定 1）：没有影子库拒绝（路径 A）、flush 被跳过且仍有待规范化对象拒绝（路径 B），
//   闭环验证的读回核对（决定 2）把绕过规范化的原文在发布时就拦下，不会产生“已验证却执行不了”的版本（路径 C）；
// - 所有验证入口共用同一套验证（决定 4）：重新验证同样做读回核对。
// 路径 B 的 TOCTOU（flush 之后、冻结之前插进来的编辑）见 verified-readback-race.test.ts。
// 全部用 SQLite（:memory: 影子库 + 本地文件目标库），不依赖 Docker；PG / MySQL / MSSQL 的读回核对见 packages/verifier/test/readback.test.ts。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ExecEvent,
  ProjectCreated,
  ProjectInfo,
  PublishRejected,
  VersionCreated,
  VersionVerifyResponse,
} from '@dowel/api';
import {
  addCheck,
  addColumn,
  addPrimaryKey,
  all,
  createTable,
  type Model,
  setColumnType,
  setNotNull,
} from '@dowel/core';
import { openSqliteDb, stepsChecksum } from '@dowel/engines';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import { ShadowError } from '../src/shadow.ts';
import { makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

const parseSse = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as T);

describe('Issue #132：已验证版本必须能通过执行器读回校验（SQLite）', () => {
  let rootDir = '';
  let prevRoots: string | undefined;
  let prevDowelDb: string | undefined;
  let pdb: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let cookie = '';
  let groupId = '';
  let fileNo = 0;

  const req = (method: string, url: string, body?: unknown) =>
    created.app.request(url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'dowel-issue132-'));
    prevRoots = process.env.DOWEL_SQLITE_ROOTS;
    prevDowelDb = process.env.DOWEL_DB;
    const platformDbPath = path.join(rootDir, 'platform.sqlite');
    process.env.DOWEL_SQLITE_ROOTS = rootDir;
    process.env.DOWEL_DB = platformDbPath;
    pdb = await openPlatformDb(platformDbPath);
    created = createApp(pdb, { connectionLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }) });
    await makeUser(pdb, 'alice', { role: 'admin' });
    const login = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const { groups } = (await (await req('GET', '/api/groups')).json()) as { groups: { id: string }[] };
    if (groups[0]) groupId = groups[0].id;
    else {
      const g = await req('POST', '/api/groups', { name: 'Team', slug: 'team' });
      groupId = ((await g.json()) as { id: string }).id;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await created?.shadows.close();
    await pdb?.close();
    if (prevRoots === undefined) delete process.env.DOWEL_SQLITE_ROOTS;
    else process.env.DOWEL_SQLITE_ROOTS = prevRoots;
    if (prevDowelDb === undefined) delete process.env.DOWEL_DB;
    else process.env.DOWEL_DB = prevDowelDb;
    rmSync(rootDir, { recursive: true, force: true });
  });

  /** 空白 SQLite 项目 + 一个指向空 SQLite 文件的环境 */
  const blankProject = async (name: string) => {
    const res = await req('POST', '/api/projects', { name, groupId, dialect: 'sqlite' });
    expect(res.status).toBe(201);
    const pid = ((await res.json()) as ProjectCreated).id;
    const info = (await (await req('GET', `/api/projects/${pid}`)).json()) as ProjectInfo;
    const file = path.join(rootDir, `target-${++fileNo}.sqlite`);
    openSqliteDb(file).close();
    const env = await req('POST', `/api/projects/${pid}/environments`, {
      name: 'local',
      url: `sqlite://${file}`,
      production: false,
    });
    expect(env.status).toBe(201);
    const envId = ((await env.json()) as { id: string }).id;
    return { pid, branch: info.branch, envId };
  };

  const edit = async (branch: string, fn: (m: Model) => void) => {
    const m = structuredClone((await created.rooms.model(branch)).model);
    fn(m);
    await created.rooms.replace(branch, 'test', m, 'seed');
  };

  const schemaOf = (m: Model) => all(m, 'schema')[0]!.id;

  const publish = async (pid: string, name: string) => {
    const res = await req('POST', `/api/projects/${pid}/versions`, { name });
    expect(res.status).toBe(201);
    return (await res.json()) as VersionCreated;
  };

  /** 发布被拒绝：返回 422 的响应体 */
  const rejected = async (pid: string, name: string) => {
    const res = await req('POST', `/api/projects/${pid}/versions`, { name });
    expect(res.status).toBe(422);
    return (await res.json()) as PublishRejected;
  };

  const versionCount = async (pid: string) =>
    ((await (await req('GET', `/api/projects/${pid}/versions`)).json()) as unknown[]).length;

  const execute = async (pid: string, envId: string, to: string) => {
    const res = await req('POST', `/api/projects/${pid}/environments/${envId}/execute`, { to });
    expect(res.status).toBe(200);
    const events = parseSse<ExecEvent>(await res.text());
    const err = events.find((e) => e.error);
    return { done: events.some((e) => e.stage === 'done'), code: err?.code ?? null, details: err?.details };
  };

  /** 不变式：verified ⇒ 执行成功。失败时把执行器的差异带出来便于定位 */
  const expectVerifiedImpliesExecutable = (
    pub: VersionCreated,
    run: { done: boolean; code: string | null; details: unknown },
  ) => {
    expect({
      verified: pub.verified,
      executed: run.done,
      code: run.code,
      details: run.details,
    }).toMatchObject(pub.verified ? { executed: true, code: null } : { verified: false });
  };

  /** 列的 [名称, 类型, 排序规则] */
  const columnsOf = (m: Model) => all(m, 'column').map((c) => [c.name, c.type, c.collation]);

  test('路径 C：经 mutator 写入的小写类型 integer / text 与排序规则 nocase 存为规范写法，发布 verified 且执行零读回差异', async () => {
    const { pid, branch, envId } = await blankProject('C canonical');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'users');
      addColumn(m, t, { name: 'id', type: 'integer', notNull: true });
      addColumn(m, t, { name: 'title', type: 'text' });
      addColumn(m, t, { name: 'email', type: 'text', collation: 'nocase' });
    });
    const { model } = await created.rooms.model(branch);
    expect(columnsOf(model)).toEqual([
      ['id', 'INTEGER', null],
      ['title', 'TEXT', null],
      ['email', 'TEXT', 'NOCASE'],
    ]);
    expect((await created.refresher.flush(branch)).kind).toBe('clean');
    const pub = await publish(pid, 'canonical');
    expect(pub.verified).toBe(true);
    const run = await execute(pid, envId, pub.id);
    expectVerifiedImpliesExecutable(pub, run);
    expect(run).toMatchObject({ done: true, code: null });
  });

  test.each([
    ['类型 integer / text', 'types'],
    ['排序规则 nocase', 'collation'],
  ] as const)(
    '路径 C：绕过规范化直接写入原文（%s，模拟写入入口漏了规范化）：发布时读回核对拒绝（readback_mismatch），不会产生已验证却执行不了的版本',
    async (_label, kind) => {
      const { pid, branch } = await blankProject(`C raw ${kind}`);
      await edit(branch, (m) => {
        const t = createTable(m, schemaOf(m), 'notes');
        const id = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
        const title = addColumn(m, t, {
          name: 'title',
          type: 'TEXT',
          collation: kind === 'collation' ? 'NOCASE' : null,
        });
        if (kind === 'types') {
          (m.objects[id] as { type: string }).type = 'integer';
          (m.objects[title] as { type: string }).type = 'text';
        } else {
          (m.objects[title] as { collation: string | null }).collation = 'nocase';
        }
      });
      const { model } = await created.rooms.model(branch);
      expect(columnsOf(model)).toEqual(
        kind === 'types'
          ? [
              ['id', 'integer', null],
              ['title', 'text', null],
            ]
          : [
              ['id', 'INTEGER', null],
              ['title', 'TEXT', 'nocase'],
            ],
      );
      // 列类型 / 排序规则不在按需规范化的范围里：flush 为 clean，交给发布时的读回核对把关
      expect((await created.refresher.flush(branch)).kind).toBe('clean');
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const rej = await rejected(pid, 'raw');
      expect(rej.code).toBe('readback_mismatch');
      expect(rej.error).toContain('写法');
      expect(rej.report?.ok).toBe(false);
      expect(rej.report?.upDiff).toEqual([]);
      expect(rej.report?.readbackDiff).toEqual(
        kind === 'types'
          ? [
              {
                direction: 'up',
                object: 'main.notes.id',
                property: 'type',
                modelValue: 'integer',
                liveValue: 'INTEGER',
              },
              {
                direction: 'up',
                object: 'main.notes.title',
                property: 'type',
                modelValue: 'text',
                liveValue: 'TEXT',
              },
            ]
          : [
              {
                direction: 'up',
                object: 'main.notes.title',
                property: 'collation',
                modelValue: 'nocase',
                liveValue: 'NOCASE',
              },
            ],
      );
      // 出现这种拒绝说明规范化有缺陷：服务端记日志以便定位（ADR 0017 决定 3）
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('读回核对'), expect.any(String));
      expect(await versionCount(pid)).toBe(0);

      // 按报告把模型改成数据库的写法：发布通过且能执行
      await edit(branch, (m) => {
        for (const c of all(m, 'column')) {
          (c as { type: string }).type = c.type.toUpperCase();
          if (c.collation) (c as { collation: string }).collation = c.collation.toUpperCase();
        }
      });
      const pub = await publish(pid, 'fixed');
      expect(pub.verified).toBe(true);
    },
  );

  test('路径 B：发布时 flush() 被跳过且仍有待规范化对象：在验证之前就拒绝（normalize_pending），并列出待处理对象', async () => {
    const { pid, branch, envId } = await blankProject('B skipped');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'items');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
      addColumn(m, t, { name: 'qty', type: 'INTEGER', default: { expr: '(1 + 1)' } });
      addCheck(m, t, '  qty > 0  ');
    });
    const verifyScripts = vi.fn();
    vi.spyOn(created.refresher, 'flush').mockImplementation(async (b) => {
      const { model, seq } = await created.rooms.model(b);
      return { kind: 'skipped', skippedReason: 'canonicalize_failed', seq, model };
    });
    vi.spyOn(created.shadows, 'forProjectEngineVersions').mockImplementation(async () => {
      verifyScripts();
      throw new Error('验证之前就应该拒绝，不该走到选影子库');
    });
    const rej = await rejected(pid, 'flush skipped');
    expect(rej.code).toBe('normalize_pending');
    expect(rej.error).toContain('规范化');
    expect(rej.pendingCount).toBe(2);
    expect(rej.pending?.map((o) => [o.kind, o.name]).sort()).toEqual([
      ['check', expect.stringContaining('items')],
      ['column', 'main.items.qty'],
    ]);
    expect(verifyScripts).not.toHaveBeenCalled();
    expect(await versionCount(pid)).toBe(0);
    vi.restoreAllMocks();

    // flush 正常时：规范化写回、验证通过，发布的版本能执行
    const pub = await publish(pid, 'normalized');
    expectVerifiedImpliesExecutable(pub, await execute(pid, envId, pub.id));
  });

  test('路径 B：flush() 被跳过但没有待规范化对象（模型已是规范形式）：照常验证并发布', async () => {
    const { pid, branch, envId } = await blankProject('B skipped clean');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'items');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    });
    vi.spyOn(created.refresher, 'flush').mockImplementation(async (b) => {
      const { model, seq } = await created.rooms.model(b);
      return { kind: 'skipped', skippedReason: 'write_conflict', seq, model };
    });
    const pub = await publish(pid, 'clean model');
    vi.restoreAllMocks();
    expectVerifiedImpliesExecutable(pub, await execute(pid, envId, pub.id));
  });

  test('路径 A：没有可用的影子库时拒绝发布（shadow_unavailable），不再有“发布为未验证”', async () => {
    const { pid, branch } = await blankProject('A no shadow');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'items');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
      addCheck(m, t, '  id > 0  ');
    });
    // SQLite 永远有 :memory: 影子库；这里模拟外部影子库方言“发布时没有影子库”：flush 跳过、选不到影子库
    vi.spyOn(created.refresher, 'flush').mockImplementation(async (b) => {
      const { model, seq } = await created.rooms.model(b);
      return { kind: 'skipped', skippedReason: 'no_shadow', seq, model };
    });
    const pendingRej = await rejected(pid, 'no shadow yet');
    expect(pendingRej.code).toBe('shadow_unavailable');
    expect(pendingRej.pendingCount).toBeGreaterThan(0);
    vi.restoreAllMocks();
    // 没有待规范化对象、但验证时拿不到影子库（影子库暂时连不上）：同样拒绝，请稍后重试
    expect((await created.refresher.flush(branch)).kind).not.toBe('skipped');
    vi.spyOn(created.shadows, 'forProjectEngineVersions').mockRejectedValue(
      new ShadowError('影子库不可用：连接失败：ECONNREFUSED'),
    );
    const rej = await rejected(pid, 'shadow down');
    expect(rej.code).toBe('shadow_unavailable');
    expect(rej.error).toContain('稍后重试');
    expect(await versionCount(pid)).toBe(0);
  });

  test('重新验证与发布同一把尺子（ADR 0017 决定 4）：绕过接口写进来的原文版本，重新验证读回核对不通过、不标为已验证，执行被拒绝', async () => {
    const { pid, branch, envId } = await blankProject('reverify readback');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'notes');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    });
    const { model } = await created.rooms.model(branch);
    const raw = structuredClone(model);
    (all(raw, 'column')[0] as { type: string }).type = 'integer';
    const up = [{ sql: 'CREATE TABLE "notes" (\n  "id" integer NOT NULL\n)', transactional: true }];
    const down = [{ sql: 'DROP TABLE "notes"', transactional: true }];
    // 模拟旧数据：一个没验证过、模型里存着原文的版本（接口不会产生它）
    await pdb.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
       values ('raw-v1', $1, $2, 1, 'raw', $3::text::jsonb, 1, $4::text::jsonb, $5::text::jsonb, $6)`,
      [pid, branch, JSON.stringify(raw), JSON.stringify(up), JSON.stringify(down), stepsChecksum(up, down)],
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rv = await req('POST', `/api/projects/${pid}/versions/raw-v1/verify`, {});
    expect(rv.status).toBe(200);
    const body = (await rv.json()) as VersionVerifyResponse;
    expect(body.verifiedAt).toBeNull();
    expect(body.verifiedOn).toEqual([]);
    expect(body.report.ok).toBe(false);
    expect(body.report.readbackDiff).toEqual([
      {
        direction: 'up',
        object: 'main.notes.id',
        property: 'type',
        modelValue: 'integer',
        liveValue: 'INTEGER',
      },
    ]);
    expect(body.report.records).toEqual([expect.objectContaining({ ok: false })]);
    expect(logged).toHaveBeenCalled();
    // 没有通过的验证记录：执行器在动库之前就拒绝（unverified），而不是执行后才 readback_mismatch
    const run = await execute(pid, envId, 'raw-v1');
    expect(run).toMatchObject({ done: false, code: 'unverified' });
  });

  test('首个版本不变式：坏的首个版本在发布时就被拒绝（不会出现“已验证却执行不了、又不能作废”的死局），修正后发布并执行', async () => {
    const { pid, branch, envId } = await blankProject('first version');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'notes');
      const id = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
      (m.objects[id] as { type: string }).type = 'integer';
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await rejected(pid, 'first')).code).toBe('readback_mismatch');
    expect(await versionCount(pid)).toBe(0);
    await edit(branch, (m) => {
      (all(m, 'column')[0] as { type: string }).type = 'INTEGER';
    });
    const pub = await publish(pid, 'first');
    expect(pub.number).toBe(1);
    const run = await execute(pid, envId, pub.id);
    expectVerifiedImpliesExecutable(pub, run);
    expect(run).toMatchObject({ done: true, code: null });
  });

  test('恢复：后续版本的坏写法同样在发布时被拦下，版本链不会卡在坏版本上；修正后的版本能执行，目标库不漂移', async () => {
    const { pid, branch, envId } = await blankProject('recovery');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'base');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    });
    const v1 = await publish(pid, 'good v1');
    expect((await execute(pid, envId, v1.id)).done).toBe(true);
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'extra');
      const id = addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
      (m.objects[id] as { type: string }).type = 'integer';
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await rejected(pid, 'bad v2')).code).toBe('readback_mismatch');
    await edit(branch, (m) => {
      const c = all(m, 'column').find((x) => x.type === 'integer')!;
      c.type = 'INTEGER';
    });
    const v2 = await publish(pid, 'fixed v2');
    expect(v2.number).toBe(2);
    const run2 = await execute(pid, envId, v2.id);
    expectVerifiedImpliesExecutable(v2, run2);
    expect(run2).toMatchObject({ done: true, code: null });
    const drift = (await (
      await req('POST', `/api/projects/${pid}/environments/${envId}/drift-check`, {})
    ).json()) as { status: string };
    expect(drift.status).toBe('ok');
  });

  test('Issues #140 & #141：无类型列、BIGINT/INT 单列主键与 BOOLEAN 经发布与 12 步重建后执行零读回差异', async () => {
    const { pid, branch, envId } = await blankProject('SQLite type fidelity');
    let bigTblId = '';
    let untypedId = '';
    await edit(branch, (m) => {
      bigTblId = createTable(m, schemaOf(m), 'big_items');
      const bigPk = addColumn(m, bigTblId, { name: 'id', type: 'bigint', notNull: true });
      addPrimaryKey(m, bigTblId, [bigPk]);
      untypedId = addColumn(m, bigTblId, { name: 'raw_col', type: '' });
      addColumn(m, bigTblId, { name: 'flag', type: 'boolean' });

      const intTbl = createTable(m, schemaOf(m), 'int_items');
      const intPk = addColumn(m, intTbl, { name: 'id', type: 'int', notNull: true });
      addPrimaryKey(m, intTbl, [intPk]);
      addColumn(m, intTbl, { name: 'note', type: '', notNull: true, default: { expr: "'x'" } });
    });

    const v1Model = (await created.rooms.model(branch)).model;
    expect(columnsOf(v1Model)).toEqual([
      ['id', 'BIGINT', null],
      ['raw_col', '', null],
      ['flag', 'BOOLEAN', null],
      ['id', 'INT', null],
      ['note', '', null],
    ]);
    const f1 = await created.refresher.flush(branch);
    expect(f1.kind).not.toBe('skipped');
    expect(columnsOf(f1.model)).toEqual([
      ['id', 'BIGINT', null],
      ['raw_col', '', null],
      ['flag', 'BOOLEAN', null],
      ['id', 'INT', null],
      ['note', '', null],
    ]);
    expect((await created.refresher.flush(branch)).kind).toBe('clean');
    const pub1 = await publish(pid, 'v1');
    expect(pub1.verified).toBe(true);
    const run1 = await execute(pid, envId, pub1.id);
    expectVerifiedImpliesExecutable(pub1, run1);
    expect(run1).toMatchObject({ done: true, code: null });

    // 触发 12 步重建（改非空 + 加 CHECK + 切换列类型后再改回），再次发布与执行仍零读回差异且类型保留
    await edit(branch, (m) => {
      setNotNull(m, untypedId, true);
      addCheck(m, bigTblId, 'length(id) > 0');
      setColumnType(m, untypedId, 'TEXT');
      setColumnType(m, untypedId, '');
    });
    const v2Model = (await created.rooms.model(branch)).model;
    expect(columnsOf(v2Model)).toEqual([
      ['id', 'BIGINT', null],
      ['raw_col', '', null],
      ['flag', 'BOOLEAN', null],
      ['id', 'INT', null],
      ['note', '', null],
    ]);
    const f2 = await created.refresher.flush(branch);
    expect(f2.kind).not.toBe('skipped');
    expect(columnsOf(f2.model)).toEqual([
      ['id', 'BIGINT', null],
      ['raw_col', '', null],
      ['flag', 'BOOLEAN', null],
      ['id', 'INT', null],
      ['note', '', null],
    ]);
    expect((await created.refresher.flush(branch)).kind).toBe('clean');
    const pub2 = await publish(pid, 'v2');
    expect(pub2.verified).toBe(true);
    const run2 = await execute(pid, envId, pub2.id);
    expectVerifiedImpliesExecutable(pub2, run2);
    expect(run2).toMatchObject({ done: true, code: null });
  });
});
