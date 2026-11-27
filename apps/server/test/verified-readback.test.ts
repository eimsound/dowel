// Issue #132：“已验证”的冻结版本必须能通过执行器读回校验（readback_mismatch）。
// 不变式：一个版本 verified = true，就必须能在空目标库上执行成功（执行器读回 diffAgainst 为 0）。
// 规范化只在写入这一层（ADR 0017 决定 6）：经 mutator 写入的模型与读回零差异；绕过规范化的原文不被规划器容忍。
// 全部用 SQLite（:memory: 影子库 + 本地文件目标库），不依赖 Docker。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExecEvent, ProjectCreated, ProjectInfo, VersionCreated } from '@dowel/api';
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
import { openSqliteDb } from '@dowel/engines';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
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
    '绕过规范化直接写入原文（%s，模拟写入入口漏了规范化）：规划器不容忍，缺陷暴露为 readback_mismatch',
    async (_label, kind) => {
      const { pid, branch, envId } = await blankProject(`C raw ${kind}`);
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
      expect((await created.refresher.flush(branch)).kind).toBe('clean');
      // 发布流水线在验证前拦下这类模型由 ADR 0017 决定 1 负责；这里只钉住规划器不再容忍：
      // 读回的大写写法与模型原文之间有差异，执行器读回核对把缺陷报成 readback_mismatch，而不是静默通过
      const pub = await publish(pid, 'raw');
      const run = await execute(pid, envId, pub.id);
      expect(run).toMatchObject({ done: false, code: 'readback_mismatch' });
      expect((run.details as { diff: { kind: string; target: string }[] }).diff).toEqual([
        expect.objectContaining({ kind: 'rebuildTable', target: 'notes' }),
      ]);
    },
  );

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
