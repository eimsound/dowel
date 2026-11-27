// SQLite 目标库全栈端到端测试：
// - 空白 SQLite 项目创建与默认 main schema；
// - 零环境向导 SQL 导入 + `:memory:` 影子库自动基线验证 + ATTACH DATABASE 拦截；
// - 零环境模型编辑（含 12 步表重建）+ 自动验证发布 + SQL 导出；
// - DOWEL_SQLITE_ROOTS 安全边界（未配置、越界、符号链接逃逸、:memory:、query、..、指向平台库 DOWEL_DB、方言不匹配）；
// - 本地 SQLite 文件目标库：连接检查、从现有库导入、执行升级/回滚/重跑、漂移检测、CI 令牌执行与接手恢复。
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CiExecuteResult,
  DriftCheckResponse,
  ExecEvent,
  MarkDryRunResponse,
  MarkResult,
  ProjectCreated,
  ProjectInfo,
  TakeoverInspectResult,
  TargetInfo,
  VersionCreated,
  VersionDetail,
  WizardEvent,
} from '@dowel/api';
import { addColumn, all, createTable, type Model, newId, plan, setColumnType, setDefault } from '@dowel/core';
import { getEngine, openSqliteDb, stepsChecksum, toScriptSteps, verifyChain } from '@dowel/engines';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import { maskUrl } from '../src/secrets.ts';
import { connectSqlite } from '../src/targets/sqlite.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

const parseSse = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as T);

describe('SQLite 目标库全栈', () => {
  let rootDir = '';
  let allowedDir = '';
  let outsideDir = '';
  let platformDbPath = '';
  let prevRoots: string | undefined;
  let prevDowelDb: string | undefined;

  let pdb: PlatformDb;
  let app: ReturnType<typeof createApp>['app'];
  let rooms: ReturnType<typeof createApp>['rooms'];
  let shadows: ReturnType<typeof createApp>['shadows'];
  let cookie = '';
  let groupId = '';

  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'dowel-sqlite-target-'));
    allowedDir = path.join(rootDir, 'allowed');
    outsideDir = path.join(rootDir, 'outside');
    const fs = await import('node:fs');
    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    platformDbPath = path.join(allowedDir, 'platform.sqlite');

    prevRoots = process.env.DOWEL_SQLITE_ROOTS;
    prevDowelDb = process.env.DOWEL_DB;
    process.env.DOWEL_SQLITE_ROOTS = allowedDir;
    process.env.DOWEL_DB = platformDbPath;

    pdb = await openPlatformDb(platformDbPath);
    const created = createApp(pdb, {
      connectionLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    app = created.app;
    rooms = created.rooms;
    shadows = created.shadows;

    await makeUser(pdb, 'alice', { role: 'admin' });
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const groupsRes = await req('GET', '/api/groups');
    expect(groupsRes.status).toBe(200);
    const { groups } = (await groupsRes.json()) as { groups: { id: string }[] };
    if (groups[0]) {
      groupId = groups[0].id;
    } else {
      const createG = await req('POST', '/api/groups', { name: 'Team', slug: 'team' });
      expect(createG.status).toBe(201);
      groupId = ((await createG.json()) as { id: string }).id;
    }
  });

  afterAll(async () => {
    await shadows?.close();
    await pdb?.close();
    if (prevRoots === undefined) delete process.env.DOWEL_SQLITE_ROOTS;
    else process.env.DOWEL_SQLITE_ROOTS = prevRoots;
    if (prevDowelDb === undefined) delete process.env.DOWEL_DB;
    else process.env.DOWEL_DB = prevDowelDb;
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('空白 SQLite 项目创建：dialect=sqlite、默认 main schema、targetPgMajor=null', async () => {
    const res = await req('POST', '/api/projects', {
      name: 'SQLite Blank',
      groupId,
      dialect: 'sqlite',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ProjectCreated;
    expect(created.dialect).toBe('sqlite');

    const infoRes = await req('GET', `/api/projects/${created.id}`);
    expect(infoRes.status).toBe(200);
    const info = (await infoRes.json()) as ProjectInfo;
    expect(info.dialect).toBe('sqlite');
    expect(info.targetPgMajor).toBeNull();
    expect(info.envPgMajors).toEqual([]);

    const { model } = await rooms.model(info.branch);
    expect(model.dialect).toBe('sqlite');
    const schemas = all(model, 'schema').map((s) => s.name);
    expect(schemas).toEqual(['main']);
  });

  test('零环境向导 SQL 导入 + :memory: 自动验证发布（含 12 步表重建）+ ATTACH 拦截', async () => {
    // 1. 含 ATTACH DATABASE 的导入被安全拦截
    const badRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'Bad Attach',
      dialect: 'sqlite',
      environments: [],
      content: {
        kind: 'sql',
        sql: "ATTACH DATABASE '/tmp/evil.db' AS evil; CREATE TABLE t (id INTEGER PRIMARY KEY);",
      },
    });
    expect(badRes.status).toBe(422);

    // 2. 零环境 SQL 导入，自动在 :memory: 影子库导入并发布已验证 v0 基线
    const wizRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'SQLite SQL Import',
      dialect: 'sqlite',
      environments: [],
      content: {
        kind: 'sql',
        sql: `
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            age INTEGER NOT NULL DEFAULT 0
          ) STRICT;
          CREATE INDEX users_email_idx ON users (email);
        `,
      },
    });
    expect(wizRes.status).toBe(200);
    const events = parseSse<WizardEvent>(await wizRes.text());
    const done = events.find((e) => e.stage === 'done');
    expect(done?.project?.dialect).toBe('sqlite');
    const pid = done!.project!.id;

    const vers0 = (await (await req('GET', `/api/projects/${pid}/versions`)).json()) as {
      id: string;
      number: number;
      verifiedAt: string | null;
    }[];
    expect(vers0).toHaveLength(1);
    expect(vers0[0]!.number).toBe(0);
    expect(vers0[0]!.verifiedAt).not.toBeNull();

    // 3. 修改列类型（age INTEGER -> TEXT）触发 12 步表重建 + 新增列，零环境自动验证发布 v1
    await editModel(rooms, pdb, pid, (m) => {
      const users = all(m, 'table').find((t) => t.name === 'users')!;
      const age = all(m, 'column').find((c) => c.parent === users.id && c.name === 'age')!;
      setColumnType(m, age.id, 'TEXT');
      setDefault(m, age.id, { expr: "'0'" });
      addColumn(m, users.id, { name: 'bio', type: 'TEXT', notNull: false });
    });

    const pubRes = await req('POST', `/api/projects/${pid}/versions`, { name: 'rebuild users' });
    expect(pubRes.status).toBe(201);
    const pub = (await pubRes.json()) as VersionCreated;
    expect(pub.verified).toBe(true);
    expect(pub.unverifiedReason).toBeNull();

    const detail = (await (
      await req('GET', `/api/projects/${pid}/versions/${pub.id}`)
    ).json()) as VersionDetail;
    expect(detail.upSteps.some((s) => s.sql.includes('PRAGMA foreign_keys = OFF') && !s.transactional)).toBe(
      true,
    );
    expect(detail.verifyReport?.shadow).toBe('SQLite :memory:');
    expect(detail.verifyReport?.risks.some((r) => r.level === 'high')).toBe(true);

    // 4. 离线导出迁移 SQL 带 SQLite PRAGMA 会话头
    const sqlRes = await req('GET', `/api/projects/${pid}/migration?format=sql`);
    expect(sqlRes.status).toBe(200);
    const exportedSql = await sqlRes.text();
    expect(exportedSql).toContain('PRAGMA foreign_keys = ON;');
    expect(exportedSql).toContain('CREATE TABLE users');
  });

  test('DOWEL_SQLITE_ROOTS 安全边界与方言不匹配拦截', async () => {
    const validDb = path.join(allowedDir, 'check.sqlite');
    const h = openSqliteDb(validDb);
    await h.db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    h.close();

    const outsideDb = path.join(outsideDir, 'secret.sqlite');
    writeFileSync(outsideDb, '');
    const escapeLink = path.join(allowedDir, 'escape.sqlite');
    symlinkSync(outsideDb, escapeLink);

    // 合法路径
    const okRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'sqlite',
      url: `sqlite://${validDb}`,
    });
    expect(okRes.status).toBe(200);
    const info = (await okRes.json()) as TargetInfo;
    expect(info.database).toBe('check.sqlite');
    expect(info.schemas).toEqual([{ name: 'main', tables: 1 }]);

    // 越界 / 逃逸 / 危险路径一律拒绝
    for (const badUrl of [
      `sqlite://${outsideDb}`,
      `sqlite://${escapeLink}`,
      `sqlite://${allowedDir}/../outside/secret.sqlite`,
      'sqlite://:memory:',
      `sqlite://${validDb}?mode=ro`,
      `sqlite://${platformDbPath}`,
    ]) {
      const r = await req('POST', '/api/connection-check', {
        groupId,
        dialect: 'sqlite',
        url: badUrl,
      });
      expect(r.status, `expected reject for ${badUrl}`).toBe(422);
    }

    // 方言不匹配拒绝
    const mismatch1 = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'sqlite',
      url: 'postgres://user:pass@localhost:5432/db',
    });
    expect(mismatch1.status).toBe(422);

    const mismatch2 = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'pg',
      url: `sqlite://${validDb}`,
    });
    expect(mismatch2.status).toBe(422);

    // 未配置 DOWEL_SQLITE_ROOTS 时拒绝
    delete process.env.DOWEL_SQLITE_ROOTS;
    try {
      const noRootRes = await req('POST', '/api/connection-check', {
        groupId,
        dialect: 'sqlite',
        url: `sqlite://${validDb}`,
      });
      expect(noRootRes.status).toBe(422);
    } finally {
      process.env.DOWEL_SQLITE_ROOTS = allowedDir;
    }
  });

  test('本地 SQLite 文件目标库全生命周期：导入、基线、升级（含重建）、回滚、漂移检测、CI 令牌与接手', async () => {
    const targetFile = path.join(allowedDir, 'app-prod.sqlite');
    const targetUrl = `sqlite://${targetFile}`;
    const seed = openSqliteDb(targetFile);
    await seed.db.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL
      );
      INSERT INTO notes (title) VALUES ('hello');
    `);
    seed.close();

    // 1. 向导从现有 SQLite 文件导入
    const wizRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'SQLite Live App',
      dialect: 'sqlite',
      environments: [{ name: 'local', url: targetUrl, production: false }],
      content: { kind: 'database', env: 'local' },
    });
    expect(wizRes.status).toBe(200);
    const wizEvents = parseSse<WizardEvent>(await wizRes.text());
    const pid = wizEvents.find((e) => e.stage === 'done')?.project?.id;
    expect(pid).toBeTruthy();

    const envs = (await (await req('GET', `/api/projects/${pid}/environments`)).json()) as {
      id: string;
      name: string;
      engineMajor: number | null;
      engineVersion: string | null;
    }[];
    expect(envs).toHaveLength(1);
    const envId = envs[0]!.id;
    expect(envs[0]!.engineMajor).toBeNull();
    expect(envs[0]!.engineVersion).toMatch(/^3\./);

    const vers0 = (await (await req('GET', `/api/projects/${pid}/versions`)).json()) as {
      id: string;
      number: number;
    }[];
    const v0Id = vers0[0]!.id;

    // 2. 直接执行到 v0 被拒绝（mark_required，不写入历史）；CI 接口返回 409 rejected (details.reason = 'mark_required')
    const dryV0Res = await req('POST', `/api/projects/${pid}/environments/${envId}/execute`, {
      to: v0Id,
      dryRun: true,
    });
    expect(dryV0Res.status).toBe(200);
    expect(await dryV0Res.json()).toMatchObject({ ok: false, code: 'mark_required' });

    const tokRes = await req('POST', `/api/projects/${pid}/tokens`, {
      name: 'ci-sqlite',
      expiresInDays: 7,
    });
    expect(tokRes.status).toBe(201);
    const { token } = (await tokRes.json()) as { token: string };
    const pInfo = (await (await req('GET', `/api/projects/${pid}`)).json()) as ProjectInfo;
    const ciExecPath = `/api/ci/projects/${pInfo.group.slug}/${pInfo.slug}/environments/local/execute`;

    for (const payload of [{ to: 'v0', dryRun: true }, { to: 'latest' }]) {
      const ciMarkRes = await app.request(ciExecPath, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      expect(ciMarkRes.status).toBe(409);
      expect(await ciMarkRes.json()).toMatchObject({
        ok: false,
        code: 'rejected',
        details: { reason: 'mark_required' },
        reached: null,
      });
    }

    const checkNoHistory = openSqliteDb(targetFile, { readOnly: true });
    const dowelTables = await checkNoHistory.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dowel_%'",
    );
    checkNoHistory.close();
    expect(dowelTables).toEqual([]);

    // 3. 编辑模型：新增列并修改 title 类型触发 12 步重建，发布 v1
    await editModel(rooms, pdb, pid!, (m) => {
      const notes = all(m, 'table').find((t) => t.name === 'notes')!;
      addColumn(m, notes.id, { name: 'body', type: 'TEXT', notNull: false });
      const title = all(m, 'column').find((c) => c.parent === notes.id && c.name === 'title')!;
      setDefault(m, title.id, { expr: "''" });
    });
    const pub1Res = await req('POST', `/api/projects/${pid}/versions`, { name: 'add body & default' });
    expect(pub1Res.status).toBe(201);
    const v1 = (await pub1Res.json()) as VersionCreated;
    expect(v1.verified).toBe(true);

    // 4. 通过 UI SSE 接口执行升级到 v1（自动先写 v0 基线再跑 v1），验证历史数据保留
    const execRes = await req('POST', `/api/projects/${pid}/environments/${envId}/execute`, {
      to: v1.id,
    });
    expect(execRes.status).toBe(200);
    const execEvents = parseSse<ExecEvent>(await execRes.text());
    expect(execEvents.find((e) => e.stage === 'plan')).toMatchObject({ baseline: true });
    expect(execEvents.some((e) => e.stage === 'done')).toBe(true);

    const checkAfterUp = openSqliteDb(targetFile, { readOnly: true });
    const rowsAfterUp = await checkAfterUp.db.query<{ title: string; body: string | null }>(
      'SELECT title, body FROM notes',
    );
    checkAfterUp.close();
    expect(rowsAfterUp).toEqual([{ title: 'hello', body: null }]);

    // 5. 回滚到 v0，验证回滚成功且数据仍在
    const rbRes = await req('POST', `/api/projects/${pid}/environments/${envId}/rollback`, {
      to: v0Id,
    });
    expect(rbRes.status).toBe(200);
    const rbEvents = parseSse<ExecEvent>(await rbRes.text());
    expect(rbEvents.some((e) => e.stage === 'done')).toBe(true);

    // 6. 使用 CI 令牌重新升级到 latest (v1)
    const ciRes = await app.request(ciExecPath, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ to: 'latest' }),
    });
    expect(ciRes.status).toBe(200);
    const ciOut = (await ciRes.json()) as CiExecuteResult;
    expect(ciOut.ok).toBe(true);
    expect(ciOut.reached?.number).toBe(1);

    // 7. 漂移检测：线外直接建表 -> drifted，删掉后 -> ok
    const driftEdit = openSqliteDb(targetFile);
    await driftEdit.db.exec('CREATE TABLE out_of_band (id INTEGER PRIMARY KEY)');
    driftEdit.close();

    const drift1 = (await (
      await req('POST', `/api/projects/${pid}/environments/${envId}/drift-check`, {})
    ).json()) as DriftCheckResponse;
    expect(drift1.status).toBe('drifted');

    const driftFix = openSqliteDb(targetFile);
    await driftFix.db.exec('DROP TABLE out_of_band');
    driftFix.close();

    const drift2 = (await (
      await req('POST', `/api/projects/${pid}/environments/${envId}/drift-check`, {})
    ).json()) as DriftCheckResponse;
    expect(drift2.status).toBe('ok');

    // 8. 接手检查：能发现目标库里登记的 SQLite 项目
    const inspectRes = await req('POST', '/api/takeover/inspect', {
      groupId,
      dialect: 'sqlite',
      url: targetUrl,
    });
    expect(inspectRes.status).toBe(200);
    const inspected = (await inspectRes.json()) as TakeoverInspectResult;
    expect(inspected.hasHistory).toBe(true);
    expect(inspected.projects.some((p) => p.projectId === pid && p.headNumber === 1)).toBe(true);

    // 9. 删除原项目后走 takeover 向导完整恢复（经 :memory: 影子库全链闭环验证）
    const delRes = await req('DELETE', `/api/projects/${pid}`, { confirm: pInfo.slug });
    expect(delRes.status).toBe(200);

    const takeoverRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'SQLite Restored',
      dialect: 'sqlite',
      environments: [{ name: 'local', url: targetUrl, production: false }],
      content: { kind: 'takeover', projectId: pid, claim: true },
    });
    expect(takeoverRes.status).toBe(200);
    const takeoverEvents = parseSse<WizardEvent>(await takeoverRes.text());
    const takeoverDone = takeoverEvents.find((e) => e.stage === 'done');
    expect(takeoverDone?.project?.id).toBe(pid);
    expect(takeoverDone?.project?.dialect).toBe('sqlite');
  });

  test('R1 审查回归：悬空符号链接逃逸、默认 DOWEL_DB 保护、无空白 ATTACH、发布前 validate()、connectSqlite 竞态、单 schema 清理与 MSSQL maskUrl', async () => {
    // C1: 无空白 ATTACH 变体在零环境 :memory: 向导导入中被 422 拦截
    const bypassRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'Compact Attach',
      dialect: 'sqlite',
      environments: [],
      content: { kind: 'sql', sql: "ATTACH'/etc/passwd'AS pwn; CREATE TABLE t (id INTEGER PRIMARY KEY);" },
    });
    expect(bypassRes.status).toBe(422);

    // C2: 悬空符号链接与中间目录悬空符号链接不可越界创建文件
    const escapedTarget = path.join(outsideDir, 'dangling-escaped.sqlite');
    const danglingLink = path.join(allowedDir, 'innocent-dangling.sqlite');
    symlinkSync(escapedTarget, danglingLink);
    const danglingRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'sqlite',
      url: `sqlite://${danglingLink}`,
    });
    expect(danglingRes.status).toBe(422);
    expect(existsSync(escapedTarget)).toBe(false);

    const escapedDir = path.join(outsideDir, 'dangling-dir');
    const dirLink = path.join(allowedDir, 'dir-link');
    symlinkSync(escapedDir, dirLink);
    const dirLinkRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'sqlite',
      url: `sqlite://${path.join(dirLink, 'app.sqlite')}`,
    });
    expect(dirLinkRes.status).toBe(422);

    // C2: 即使未设置 DOWEL_DB 环境变量，平台库实际路径（db.filePath）依然受保护
    const savedDowelDb = process.env.DOWEL_DB;
    delete process.env.DOWEL_DB;
    try {
      const selfRes = await req('POST', '/api/connection-check', {
        groupId,
        dialect: 'sqlite',
        url: `sqlite://${platformDbPath}`,
      });
      expect(selfRes.status).toBe(422);
    } finally {
      if (savedDowelDb !== undefined) process.env.DOWEL_DB = savedDowelDb;
    }

    // M5 + H1: SQLite 项目创建/PATCH 忽略 schemas 字段；空列表模型发布前被 validate(model) 以 422 拒绝
    const pRes = await req('POST', '/api/projects', {
      name: 'SQLite Single Schema',
      groupId,
      dialect: 'sqlite',
      schemas: ['custom_ignored'],
    });
    expect(pRes.status).toBe(201);
    const pCreated = (await pRes.json()) as ProjectCreated;
    const pInfo1 = (await (await req('GET', `/api/projects/${pCreated.id}`)).json()) as ProjectInfo;
    expect(pInfo1.schemas).toBeNull();

    const patchRes = await req('PATCH', `/api/projects/${pCreated.id}`, { schemas: ['still_ignored'] });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as ProjectInfo).schemas).toBeNull();

    // 建一张 0 列空表（非法 SQLite 模型）-> 发布被 validate(model) 422 拦截
    await editModel(rooms, pdb, pCreated.id, (m) => {
      const main = all(m, 'schema')[0]!;
      createTable(m, main.id, 'empty_table');
    });
    const invalidPub = await req('POST', `/api/projects/${pCreated.id}/versions`, { name: 'invalid' });
    expect(invalidPub.status).toBe(422);
    expect(((await invalidPub.json()) as { error: string }).error).toContain('至少需要一列');

    // M3: connectSqlite 异步 guard 进行中调用 close() 不会泄漏句柄
    const raceDb = path.join(allowedDir, 'race-close.sqlite');
    let releaseGuard!: () => void;
    const guardGate = new Promise<void>((r) => {
      releaseGuard = r;
    });
    const conn = connectSqlite(`sqlite://${raceDb}`, 5, async () => {
      await guardGate;
    });
    const pendingQuery = conn.db.query('SELECT 1');
    const closing = conn.close();
    releaseGuard();
    await expect(pendingQuery).rejects.toThrow(/已关闭/);
    await closing;

    // L1: maskUrl 支持 MSSQL 命名实例 host\instance
    expect(maskUrl('mssql://sa:Secr3t!@dbhost\\SQLEXPRESS/mydb')).toBe(
      'mssql://sa:***@dbhost\\SQLEXPRESS/mydb',
    );
    expect(maskUrl('sqlserver://sa:p@ss@10.0.0.1\\INST1:1433/app')).toBe(
      'sqlserver://sa:***@10.0.0.1\\INST1:1433/app',
    );
  });

  test('ADR 0013 SQLite 目标全栈切换（switch）与跨岔路标记（cross mark）', async () => {
    const mkFile = async (name: string) => {
      const f = path.join(allowedDir, name);
      const seed = openSqliteDb(f);
      await seed.db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL
        ) STRICT;
      `);
      seed.close();
      return { file: f, url: `sqlite://${f}` };
    };
    const tSw = await mkFile('tree-switch.sqlite');
    const tMk = await mkFile('tree-mark.sqlite');

    const wizRes = await req('POST', '/api/projects/wizard', {
      groupId,
      name: 'SQLite Tree App',
      dialect: 'sqlite',
      environments: [{ name: 'local-sw', url: tSw.url, production: false }],
      content: { kind: 'database', env: 'local-sw' },
    });
    expect(wizRes.status).toBe(200);
    const pid = parseSse<WizardEvent>(await wizRes.text()).find((e) => e.stage === 'done')!.project!.id;
    const envsList = (await (await req('GET', `/api/projects/${pid}/environments`)).json()) as {
      id: string;
    }[];
    const eidSw = envsList[0]!.id;

    // 创建第二个同样库结构（仅 users(id, email)）的 SQLite 环境用于测试 cross mark
    const envMkRes = await req('POST', `/api/projects/${pid}/environments`, {
      name: 'local-mk',
      url: tMk.url,
      production: false,
    });
    expect(envMkRes.status).toBe(201);
    const eidMk = ((await envMkRes.json()) as { id: string }).id;

    // 发布 v1（添加 legacy_tag 列）并直接执行两个环境到 v1（首次执行自动先写 v0 基线再跑 v1）
    const [v0] = (await (await req('GET', `/api/projects/${pid}/versions`)).json()) as {
      id: string;
      number: number;
    }[];

    await editModel(rooms, pdb, pid, (m) => {
      const users = all(m, 'table').find((t) => t.name === 'users')!;
      addColumn(m, users.id, { name: 'legacy_tag', type: 'TEXT', notNull: false });
    });
    const v1 = (await (
      await req('POST', `/api/projects/${pid}/versions`, { name: 'v1-legacy' })
    ).json()) as VersionCreated;

    for (const eid of [eidSw, eidMk]) {
      const r = await req('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to: v1.id });
      expect(parseSse<ExecEvent>(await r.text()).some((e) => e.stage === 'done')).toBe(true);
    }

    // 在 v0 之下新增：v2(active, 加 main_tag 列) 与 v3(active, 与 v1 结构完全等价：有 legacy_tag 列)
    const [bRow] = await pdb.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
    const [v0Row] = await pdb.query<{ model: Model }>('select model from versions where id = $1', [v0!.id]);
    const [v1Row] = await pdb.query<{ model: Model }>('select model from versions where id = $1', [v1.id]);
    const m0 = v0Row!.model;
    const m2 = structuredClone(m0);
    const m2Users = all(m2, 'table').find((t) => t.name === 'users')!;
    addColumn(m2, m2Users.id, { name: 'main_tag', type: 'TEXT', notNull: false });
    const up2 = toScriptSteps(plan(m0, m2), 'sqlite');
    const down2 = toScriptSteps(plan(m2, m0), 'sqlite');
    const v2Id = newId();
    await pdb.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                             up_steps, down_steps, checksum, verified_at)
       values ($1, $2, $3, 2, 'v2-main', $4::text::jsonb, null, 2, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
      [
        v2Id,
        pid,
        bRow!.id,
        JSON.stringify(m2),
        v0!.id,
        JSON.stringify(up2),
        JSON.stringify(down2),
        stepsChecksum(up2, down2),
        new Date().toISOString(),
      ],
    );
    await pdb.query('update versions set retired_at = $2 where id = $1', [v1.id, new Date().toISOString()]);

    // 1. tSw 通过 /switch 切换到 v2（先 down v1 删 legacy_tag，再 up v2 加 main_tag）
    const swRes = await req('POST', `/api/projects/${pid}/environments/${eidSw}/switch`, {
      to: v2Id,
      acknowledgeRollback: true,
    });
    expect(swRes.status).toBe(200);
    const swEvents = parseSse<ExecEvent>(await swRes.text());
    expect(swEvents.at(-1)).toMatchObject({ stage: 'done', current: { id: v2Id } });

    const eng = getEngine('sqlite');
    const chkSw = openSqliteDb(tSw.file, { readOnly: true });
    try {
      const h = await eng.history.readHistory(chkSw.db, pid);
      expect(h.currentVersion).toBe(v2Id);
      expect(verifyChain(h.versions)).toEqual([]);
    } finally {
      chkSw.close();
    }
    const swDrift = (await (
      await req('POST', `/api/projects/${pid}/environments/${eidSw}/drift-check`, {})
    ).json()) as DriftCheckResponse;
    expect(swDrift.status).toBe('ok');

    // 2. 用与 v1 等价的模型在 v0 下新增 v3，在停在 v1 的 tMk 上执行跨岔路 zero-SQL mark → v3
    const up3 = toScriptSteps(plan(m0, v1Row!.model), 'sqlite');
    const down3 = toScriptSteps(plan(v1Row!.model, m0), 'sqlite');
    const v3Id = newId();
    await pdb.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                             up_steps, down_steps, checksum, verified_at)
       values ($1, $2, $3, 3, 'v3-cross', $4::text::jsonb, null, 3, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
      [
        v3Id,
        pid,
        bRow!.id,
        JSON.stringify(v1Row!.model),
        v0!.id,
        JSON.stringify(up3),
        JSON.stringify(down3),
        stepsChecksum(up3, down3),
        new Date().toISOString(),
      ],
    );
    const mkDry = (await (
      await req('POST', `/api/projects/${pid}/environments/${eidMk}/mark`, { to: v3Id, dryRun: true })
    ).json()) as MarkDryRunResponse;
    expect(mkDry.ok).toBe(true);
    expect(mkDry.plan!.direction).toBe('cross');
    expect(mkDry.plan!.skipped.map((v) => v.id)).toEqual([v3Id]);

    const mkGoRes = await req('POST', `/api/projects/${pid}/environments/${eidMk}/mark`, {
      to: v3Id,
      acknowledge: true,
      expect: {
        from: mkDry.plan!.from?.id ?? null,
        to: mkDry.plan!.to.id,
        skipped: mkDry.plan!.skipped.map((v) => v.id),
        fingerprint: mkDry.plan!.fingerprint,
      },
    });
    expect(mkGoRes.status).toBe(200);
    expect(((await mkGoRes.json()) as MarkResult).current.id).toBe(v3Id);
    const mkDrift = (await (
      await req('POST', `/api/projects/${pid}/environments/${eidMk}/drift-check`, {})
    ).json()) as DriftCheckResponse;
    expect(mkDrift.status).toBe('ok');
  });
});
