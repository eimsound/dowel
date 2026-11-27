// Issue #132 路径 B：flush() 之后、冻结之前插进来的编辑（TOCTOU）不能混进“已验证”的冻结版本。
// 不变式：一个版本 verified = true，就必须能在空目标库上执行成功（执行器读回 diffAgainst 为 0）。
// 全部用 SQLite（:memory: 影子库 + 本地文件目标库），不依赖 Docker。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ExecEvent, ProjectCreated, ProjectInfo, VersionCreated } from '@dowel/api';
import { addCheck, addColumn, all, createTable, type Model } from '@dowel/core';
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

  test('路径 B：flush() 之后、冻结之前插进来的编辑（TOCTOU）不会混进已验证版本', async () => {
    const { pid, branch, envId } = await blankProject('B toctou');
    await edit(branch, (m) => {
      const t = createTable(m, schemaOf(m), 'items');
      addColumn(m, t, { name: 'id', type: 'INTEGER', notNull: true });
    });
    const realFlush = created.refresher.flush.bind(created.refresher);
    vi.spyOn(created.refresher, 'flush').mockImplementation(async (b) => {
      const out = await realFlush(b);
      // 锁已释放：另一个协作者此刻提交了一个带未规范化表达式的编辑
      await edit(b, (m) => {
        const t = all(m, 'table').find((x) => x.name === 'items')!;
        addCheck(m, t.id, '  id > 0  ');
      });
      return out;
    });
    const pub = await publish(pid, 'toctou');
    vi.restoreAllMocks();
    // 冻结的是 flush 判定过的那一份：插进来的 CHECK 不在版本里，仍留在工作副本等下次发布
    const [row] = await pdb.query<{ model: Model }>('select model from versions where id = $1', [pub.id]);
    expect(all(row!.model, 'check')).toHaveLength(0);
    expect(all((await created.rooms.model(branch)).model, 'check')).toHaveLength(1);
    expect(pub.verified).toBe(true);
    expectVerifiedImpliesExecutable(pub, await execute(pid, envId, pub.id));
  });
});
