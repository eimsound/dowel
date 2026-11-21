// MSSQL 服务端目标库驱动与全栈端到端测试：
// - URL 解析校验（mssql:// / sqlserver://、host\instance、默认 encrypt=true & trustServerCertificate=false）；
// - inspectTarget / pullSchema / 同实例影子库 claimShadow 扩展属性防误删业务库与清理；
// - 服务端项目创建、SQL 导入、验证、发布与执行端到端闭环。
import type { ProjectCreated, ProjectInfo, TargetInfo, VersionCreated, WizardEvent } from '@dowel/api';
import { addColumn, all, mssqlIdent, mssqlLiteral } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  connectTestMssql,
  createTestMssqlDb,
  getMssqlAdminUrl,
  MSSQL_VERSION,
  stopMssqlContainer,
} from '../../../test/mssql.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import { ShadowError } from '../src/shadow.ts';
import {
  claimMssqlShadow,
  dropMssqlSameInstanceShadow,
  ensureSameInstanceMssqlShadow,
  inspectMssqlTarget,
  mssqlShadowDbName,
  parseMssqlUrl,
  pullMssqlSchema,
  withMssqlDb,
} from '../src/targets/mssql.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

const parseSse = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as T);

describe('MSSQL URL parsing and shadow naming (pure unit)', () => {
  test('parses mssql:// and sqlserver:// with host:port, host\\instance, and strict default TLS', () => {
    const a = parseMssqlUrl('mssql://sa:P%40ss%21@db.internal:1434/appdb');
    expect(a).toMatchObject({
      user: 'sa',
      password: 'P@ss!',
      server: 'db.internal',
      port: 1434,
      database: 'appdb',
      encrypt: true,
      trustServerCertificate: false,
    });

    const inst = parseMssqlUrl(
      'sqlserver://admin:secret@10.0.0.5\\SQLEXPRESS/sales?encrypt=true&trustServerCertificate=true&appName=dowel',
    );
    expect(inst).toMatchObject({
      user: 'admin',
      password: 'secret',
      server: '10.0.0.5',
      instanceName: 'SQLEXPRESS',
      port: undefined,
      database: 'sales',
      encrypt: true,
      trustServerCertificate: true,
      appName: 'dowel',
    });

    expect(withMssqlDb('mssql://sa:pw@host\\INST1/app?trustServerCertificate=true', 'app_dowel')).toBe(
      'mssql://sa:pw@host\\INST1/app_dowel?trustServerCertificate=true',
    );

    const longDb = 'd'.repeat(125);
    const sh = mssqlShadowDbName(longDb);
    expect(sh.length).toBeLessThanOrEqual(128);
    expect(sh.endsWith('_dowel')).toBe(true);
  });
});

describe(`MSSQL (${MSSQL_VERSION}) target driver & server E2E`, () => {
  let adminUrl: string | null = null;
  let pdb: PlatformDb | null = null;
  let app: ReturnType<typeof createApp>['app'] | null = null;
  let rooms: ReturnType<typeof createApp>['rooms'] | null = null;
  let shadows: ReturnType<typeof createApp>['shadows'] | null = null;
  let cookie = '';
  let groupId = '';

  const req = (method: string, url: string, body?: unknown) =>
    app!.request(url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    adminUrl = await getMssqlAdminUrl();
    if (!adminUrl) return;

    pdb = await openPlatformDb(':memory:');
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
      const gRes = await req('POST', '/api/groups', { name: 'Team', slug: 'team' });
      groupId = ((await gRes.json()) as { id: string }).id;
    }
  }, 120_000);

  afterAll(async () => {
    await shadows?.close();
    await pdb?.close();
    await stopMssqlContainer();
  }, 60_000);

  test('inspectTarget, pullSchema, claimShadow safety guard, and same-instance shadow lifecycle', async () => {
    if (!adminUrl) return;
    const t = await createTestMssqlDb('mssql_drv');
    const shadowName = mssqlShadowDbName(t.name);
    try {
      await t.db.exec(`
        CREATE TABLE [dbo].[accounts] (
          [id] bigint IDENTITY(1,1) NOT NULL,
          [email] nvarchar(128) NOT NULL CONSTRAINT [DF_accounts_email] DEFAULT (N''),
          CONSTRAINT [PK_accounts] PRIMARY KEY CLUSTERED ([id])
        );
      `);

      // 1. inspectTarget
      const info = await inspectMssqlTarget(t.url);
      expect(info.database).toBe(t.name);
      expect(info.canCreateDb).toBe(true);
      expect(info.shadow).toBe(shadowName);
      expect(info.shadowExists).toBe(false);
      expect(info.schemas.some((s) => s.name === 'dbo' && s.tables === 1)).toBe(true);

      // 2. pullSchema
      const pulled = await pullMssqlSchema(t.url);
      expect(pulled.dialect).toBe('mssql');
      expect(all(pulled, 'table').map((x) => x.name)).toEqual(['accounts']);

      // 3. claimShadow MUST reject non-empty business database without dowel_shadow extended property
      await expect(claimMssqlShadow(t.url)).rejects.toThrow(ShadowError);

      // 4. ensureSameInstanceMssqlShadow creates & marks shadow db; dropMssqlSameInstanceShadow cleans it up
      const ensured = await ensureSameInstanceMssqlShadow(t.url);
      expect(ensured.created).toBe(true);
      expect(ensured.shadow).toBe(shadowName);

      const infoAfter = await inspectMssqlTarget(t.url);
      expect(infoAfter.shadowExists).toBe(true);

      await dropMssqlSameInstanceShadow(t.url, shadowName);
      const infoDropped = await inspectMssqlTarget(t.url);
      expect(infoDropped.shadowExists).toBe(false);
    } finally {
      await dropMssqlSameInstanceShadow(t.url, shadowName).catch(() => {});
      await t.close();
    }
  }, 120_000);

  test('server wizard SQL import, model edit, verify & publish end-to-end on MSSQL', async () => {
    if (!adminUrl || !app || !rooms || !pdb) return;
    const t = await createTestMssqlDb('mssql_srv');
    const shadowName = mssqlShadowDbName(t.name);
    try {
      // connection-check route
      const chkRes = await req('POST', '/api/connection-check', {
        groupId,
        dialect: 'mssql',
        url: t.url,
      });
      expect(chkRes.status).toBe(200);
      const targetInfo = (await chkRes.json()) as TargetInfo;
      expect(targetInfo.database).toBe(t.name);

      // blank mssql project creation
      const blankRes = await req('POST', '/api/projects', {
        name: 'MSSQL Blank',
        groupId,
        dialect: 'mssql',
      });
      expect(blankRes.status).toBe(201);
      const blank = (await blankRes.json()) as ProjectCreated;
      expect(blank.dialect).toBe('mssql');
      const blankInfo = (await (await req('GET', `/api/projects/${blank.id}`)).json()) as ProjectInfo;
      expect(blankInfo.dialect).toBe('mssql');
      const { model: blankModel } = await rooms.model(blankInfo.branch);
      expect(all(blankModel, 'schema').map((s) => s.name)).toEqual(['dbo']);

      // wizard SQL import + auto verify on same-instance shadow db
      const wizRes = await req('POST', '/api/projects/wizard', {
        groupId,
        name: 'MSSQL Wizard App',
        dialect: 'mssql',
        environments: [{ name: 'dev', url: t.url, production: false }],
        content: {
          kind: 'sql',
          sql: `
            CREATE SCHEMA [app]
            GO
            CREATE TABLE [app].[products] (
              [id] int IDENTITY(1,1) NOT NULL,
              [sku] nvarchar(64) NOT NULL CONSTRAINT [DF_products_sku] DEFAULT (N'SKU-0'),
              CONSTRAINT [PK_products] PRIMARY KEY CLUSTERED ([id])
            );
          `,
        },
      });
      expect(wizRes.status).toBe(200);
      const events = parseSse<WizardEvent>(await wizRes.text());
      const done = events.find((e) => e.stage === 'done');
      expect(done?.project?.dialect).toBe('mssql');
      const pid = done!.project!.id;

      // edit model & publish verified v1
      await editModel(rooms, pdb, pid, (m) => {
        const products = all(m, 'table').find((x) => x.name === 'products')!;
        addColumn(m, products.id, {
          name: 'price',
          type: 'decimal(10,2)',
          notNull: true,
          default: { expr: '0.00' },
        });
      });
      const pubRes = await req('POST', `/api/projects/${pid}/versions`, { name: 'add price' });
      expect(pubRes.status).toBe(201);
      const pub = (await pubRes.json()) as VersionCreated;
      expect(pub.verified).toBe(true);
    } finally {
      await shadows?.close();
      await dropMssqlSameInstanceShadow(t.url, shadowName).catch(() => {});
      // 确保影子库清理干净
      const admin = await connectTestMssql(adminUrl);
      try {
        const q = mssqlIdent(shadowName);
        await admin.db.exec(
          `IF DB_ID(${mssqlLiteral(shadowName)}) IS NOT NULL
           BEGIN
             ALTER DATABASE ${q} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
             DROP DATABASE ${q};
           END`,
        );
      } finally {
        await admin.close();
      }
      await t.close();
    }
  }, 180_000);
});
