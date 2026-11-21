// MySQL 目标库服务端全栈测试：
// - URL 校验、socketPath/SSRF/方言不匹配拦截、影子库名 64 字符截断；
// - inspectTarget、pullSchema、同实例影子库 claimShadow 防误删业务库与安全清理；
// - Hono 全栈：向导从现有 MySQL 库导入、SQL 导入拦截实例级语句、编辑模型、同实例影子库自动验证发布与升级/回滚。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ExecEvent,
  ProjectCreated,
  ProjectInfo,
  TargetInfo,
  VersionCreated,
  WizardEvent,
} from '@dowel/api';
import { addColumn, all, MYSQL_SHADOW_MARK_TABLE } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createMysqlTestDb, mysqlDbUrl, useMysqlTestDb } from '../../../test/mysql.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import {
  claimMysqlShadow,
  dropMysqlSameInstanceShadow,
  ensureSameInstanceMysqlShadow,
  mysqlShadowDbName,
  parseMysqlUrl,
  pullMysqlSchema,
} from '../src/targets/mysql.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

const parseSse = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as T);

describe('MySQL 目标库服务端驱动与全栈', () => {
  const getMysql = useMysqlTestDb('srv_mysql');

  let tmpDir = '';
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
    tmpDir = mkdtempSync(path.join(tmpdir(), 'dowel-mysql-target-'));
    pdb = await openPlatformDb(path.join(tmpDir, 'platform.sqlite'));
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
    const { groups } = (await groupsRes.json()) as { groups: { id: string }[] };
    if (groups[0]) {
      groupId = groups[0].id;
    } else {
      const createG = await req('POST', '/api/groups', { name: 'Team', slug: 'team' });
      groupId = ((await createG.json()) as { id: string }).id;
    }
  });

  afterAll(async () => {
    await shadows?.close();
    await pdb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('纯校验：parseMysqlUrl 拒绝 socketPath、TLS 默认不关证书校验、shadowDbName <= 64 字符、方言不匹配 422', async () => {
    expect(() => parseMysqlUrl('mysql://root:pw@127.0.0.1:3306/app?socketPath=/var/run/mysqld.sock')).toThrow(
      /socketPath/,
    );
    const tlsOpts = parseMysqlUrl('mysql://root:pw@db.example.com:3306/app?ssl=true');
    expect(tlsOpts.multipleStatements).toBe(false);
    expect(tlsOpts.ssl).toEqual({ rejectUnauthorized: true });

    const shortShadow = mysqlShadowDbName('app');
    expect(shortShadow).toBe('app_dowel');
    const longDb = 'a'.repeat(63);
    const longShadow = mysqlShadowDbName(longDb);
    expect(Array.from(longShadow).length).toBeLessThanOrEqual(64);
    expect(longShadow.endsWith('_dowel')).toBe(true);

    // 连接检查拒绝 socketPath 与方言不匹配
    const sockRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: 'mysql://root:pw@127.0.0.1:3306/app?socketPath=/tmp/mysql.sock',
    });
    expect(sockRes.status).toBe(422);

    const mismatch = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: 'postgres://user:pass@127.0.0.1:5432/app',
    });
    expect(mismatch.status).toBe(422);
  });

  test('真实 MySQL：inspectTarget、pullSchema、claimShadow 防误删非空业务库与同实例影子库生命周期', async () => {
    const handle = getMysql();
    if (!handle) return;

    // 1. 在业务库建表并测试 connection-check (inspectTarget) 与 pullSchema
    await handle.db.exec(`
      CREATE TABLE \`customers\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`email\` VARCHAR(191) NOT NULL,
        UNIQUE KEY \`customers_email_key\` (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const checkRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: handle.url,
    });
    expect(checkRes.status).toBe(200);
    const info = (await checkRes.json()) as TargetInfo;
    expect(info.database).toBe(handle.name);
    expect(info.versionNum).toBeGreaterThanOrEqual(80400);
    expect(info.canCreateDb).toBe(true);
    expect(info.schemas).toEqual([{ name: 'default', tables: 1 }]);
    expect(info.dowelSchema).toBe(false);

    const pulled = await pullMysqlSchema(handle.url);
    expect(pulled.dialect).toBe('mysql');
    expect(all(pulled, 'table').map((t) => t.name)).toEqual(['customers']);

    // 2. claimMysqlShadow 绝不允许认领非空业务库！
    await expect(claimMysqlShadow(handle.url)).rejects.toThrow(/不是空库/);

    // 3. 同实例影子库创建、写入哨兵表并安全删除
    const ensured = await ensureSameInstanceMysqlShadow(handle.url);
    expect(ensured.created).toBe(true);
    expect(ensured.shadow).toBe(mysqlShadowDbName(handle.name));

    // 验证哨兵表已写入且幂等认领通过
    await claimMysqlShadow(ensured.url);
    const shadowUrl = mysqlDbUrl(handle.adminUrl, ensured.shadow);
    expect(shadowUrl).toBe(ensured.url);

    // 清理同实例影子库
    await dropMysqlSameInstanceShadow(handle.url, ensured.shadow);
    const afterDropCheck = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: handle.url,
    });
    expect(((await afterDropCheck.json()) as TargetInfo).shadowExists).toBe(false);
  });

  test('真实 MySQL 全栈向导导入、模型编辑、同实例影子库验证发布与执行/回滚', async () => {
    const tdb = await createMysqlTestDb('srv_e2e');
    if (!tdb) return;

    const shadowName = mysqlShadowDbName(tdb.name);
    try {
      await tdb.db.exec(`
        CREATE TABLE \`notes\` (
          \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          \`title\` VARCHAR(120) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await tdb.db.query("INSERT INTO `notes` (`title`) VALUES ('hello')");

      // 1. 空白 MySQL 项目创建
      const blankRes = await req('POST', '/api/projects', {
        name: 'MySQL Blank',
        groupId,
        dialect: 'mysql',
      });
      expect(blankRes.status).toBe(201);
      const blank = (await blankRes.json()) as ProjectCreated;
      expect(blank.dialect).toBe('mysql');
      const blankInfo = (await (await req('GET', `/api/projects/${blank.id}`)).json()) as ProjectInfo;
      const { model: blankModel } = await rooms.model(blankInfo.branch);
      expect(all(blankModel, 'schema').map((s) => s.name)).toEqual(['default']);

      // 2. 向导 SQL 导入拦截 MySQL 实例级语句（含条件注释变体）
      const badWiz = await req('POST', '/api/projects/wizard', {
        groupId,
        name: 'Bad MySQL SQL',
        dialect: 'mysql',
        environments: [{ name: 'dev', url: tdb.url, production: false }],
        content: { kind: 'sql', sql: '/*!50000 DROP DATABASE mysql */; CREATE TABLE t (id INT);' },
      });
      expect(badWiz.status).toBe(422);

      // 3. 向导从现有 MySQL 目标库导入，自动使用同实例影子库验证 v0 基线
      const wizRes = await req('POST', '/api/projects/wizard', {
        groupId,
        name: 'MySQL Live App',
        dialect: 'mysql',
        environments: [{ name: 'dev', url: tdb.url, production: false }],
        content: { kind: 'database', env: 'dev' },
      });
      expect(wizRes.status).toBe(200);
      const wizEvents = parseSse<WizardEvent>(await wizRes.text());
      const pid = wizEvents.find((e) => e.stage === 'done')?.project?.id;
      expect(pid).toBeTruthy();

      const envs = (await (await req('GET', `/api/projects/${pid}/environments`)).json()) as {
        id: string;
        engineVersion: string | null;
      }[];
      const envId = envs[0]!.id;
      expect(envs[0]!.engineVersion).toMatch(/^[89]\./);

      // 4. 写基线
      const baseRes = await req('POST', `/api/projects/${pid}/environments/${envId}/baseline`, {});
      expect(baseRes.status).toBe(200);
      const baseEvents = parseSse<ExecEvent>(await baseRes.text());
      expect(baseEvents.some((e) => e.stage === 'done')).toBe(true);

      const vers0 = (await (await req('GET', `/api/projects/${pid}/versions`)).json()) as { id: string }[];
      const v0Id = vers0[0]!.id;

      // 5. 编辑模型加列并发布 v1（同实例影子库自动闭环验证 + 风险分析）
      await editModel(rooms, pdb, pid!, (m) => {
        const notes = all(m, 'table').find((t) => t.name === 'notes')!;
        addColumn(m, notes.id, { name: 'body', type: 'text', notNull: false });
      });
      const pubRes = await req('POST', `/api/projects/${pid}/versions`, { name: 'add body' });
      expect(pubRes.status).toBe(201);
      const v1 = (await pubRes.json()) as VersionCreated;
      expect(v1.verified).toBe(true);

      // 6. 执行升级到 v1 并验证数据保留
      const execRes = await req('POST', `/api/projects/${pid}/environments/${envId}/execute`, { to: v1.id });
      expect(execRes.status).toBe(200);
      expect(parseSse<ExecEvent>(await execRes.text()).some((e) => e.stage === 'done')).toBe(true);

      const rows = await tdb.db.query<{ title: string; body: string | null }>(
        'SELECT `title`, `body` FROM `notes`',
      );
      expect(rows).toEqual([{ title: 'hello', body: null }]);

      // 7. 回滚到 v0
      const rbRes = await req('POST', `/api/projects/${pid}/environments/${envId}/rollback`, { to: v0Id });
      expect(rbRes.status).toBe(200);
      expect(parseSse<ExecEvent>(await rbRes.text()).some((e) => e.stage === 'done')).toBe(true);

      expect(MYSQL_SHADOW_MARK_TABLE).toBe('__dowel_shadow_mark');
    } finally {
      await shadows.close();
      await dropMysqlSameInstanceShadow(tdb.url, shadowName).catch(() => {});
      await tdb.close();
    }
  }, 120_000);
});
