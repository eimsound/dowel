// MSSQL 服务端目标库驱动与全栈端到端测试：
// - URL 解析校验（mssql:// / sqlserver://、host\instance、默认 encrypt=true & trustServerCertificate=false）；
// - inspectTarget / pullSchema / 同实例影子库 claimShadow 扩展属性防误删业务库与清理；
// - 服务端项目创建、SQL 导入、验证、发布与执行端到端闭环。
import type { ProjectCreated, ProjectInfo, TargetInfo, VersionCreated, WizardEvent } from '@dowel/api';
import { addColumn, all, createSchema, createTable, emptyModel, mssqlIdent, mssqlLiteral } from '@dowel/core';
import {
  type Db,
  isMetadataOnlyMssqlSql,
  mssqlErrorNumber,
  resetMssqlShadow,
  stripMssqlImportNoise,
} from '@dowel/engines';
import { StepError } from '@dowel/verifier';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { connectTestMssql, createTestMssqlDb, getMssqlAdminUrl, MSSQL_VERSION } from '../../../test/mssql.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import {
  assertImportable,
  isConnectionFailure,
  isInfraFailure,
  ShadowError,
  shadowOps,
} from '../src/shadow.ts';
import { scrubUrl } from '../src/targets.ts';
import {
  claimMssqlShadow,
  claimMssqlShadowOn,
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

    // 严格校验端口、超时参数与 IPv6 尾随垃圾字符
    expect(() => parseMssqlUrl('mssql://sa:pw@db.internal:1433abc/app')).toThrow();
    expect(() => parseMssqlUrl('mssql://sa:pw@db.internal:1433/app?connectTimeout=5000ms')).toThrow();
    expect(() => parseMssqlUrl('mssql://sa:pw@db.internal:1433/app?requestTimeout=10s')).toThrow();
    expect(() => parseMssqlUrl('mssql://sa:pw@[::1]garbage/app')).toThrow();
    expect(() => parseMssqlUrl('mssql://sa:pw@[::1]:1433x/app')).toThrow();
    expect(parseMssqlUrl('mssql://sa:pw@[::1]:1434/app')).toMatchObject({ server: '::1', port: 1434 });

    // 跨方言 scrubUrl 脱敏 host\instance 连接串与编码/明文密码
    const instUrl = 'mssql://sa:P%40ssWord!@10.0.0.5\\SQLEXPRESS/appdb';
    const scrubbed = scrubUrl(`connect ${instUrl} failed for P@ssWord! and P%40ssWord!`, instUrl);
    expect(scrubbed).not.toContain('P@ssWord!');
    expect(scrubbed).not.toContain('P%40ssWord!');

    // shadow.ts 识别 tedious/mssql 连接与基础设施故障
    expect(isConnectionFailure(Object.assign(new Error('socket'), { code: 'ESOCKET' }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('login'), { code: 'ELOGIN' }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('lock'), { number: 1222 }))).toBe(true);
    expect(isConnectionFailure(Object.assign(new Error('auth'), { number: 18456 }))).toBe(true);
    expect(isInfraFailure(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }))).toBe(true);
    // 步骤内因语句超时取消按用户 DDL 超时（非基础设施故障）归类
    const userTimeoutStep = new StepError(
      { kind: 'frozen', target: 'up#1', sql: 'CREATE INDEX ...' },
      Object.assign(new Error('MSSQL 语句执行超过 1000ms（已取消）'), { code: 'ETIMEOUT' }),
      1050,
    );
    expect(isInfraFailure(userTimeoutStep, 1000)).toBe(false);

    // 词法级 stripMssqlImportNoise 支持同行 USE 与普通语句共存
    expect(stripMssqlImportNoise('USE [app]; CREATE TABLE [dbo].[t] ([id] int);').trim()).toBe(
      'CREATE TABLE [dbo].[t] ([id] int);',
    );
    expect(stripMssqlImportNoise("CREATE TABLE [dbo].[t] ([note] nvarchar(50) DEFAULT N'USE master')")).toBe(
      "CREATE TABLE [dbo].[t] ([note] nvarchar(50) DEFAULT N'USE master')",
    );

    // 词法级风险分类不依赖 Step.kind（兼容 frozen）
    expect(
      isMetadataOnlyMssqlSql(
        "EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = N'x', @level0type = N'SCHEMA', @level0name = N'dbo'",
      ),
    ).toBe(true);
    expect(isMetadataOnlyMssqlSql('ALTER TABLE [dbo].[users] DROP CONSTRAINT [DF_users_code]')).toBe(true);
    expect(
      isMetadataOnlyMssqlSql('ALTER TABLE [dbo].[users] ALTER COLUMN [code] nvarchar(64) NOT NULL'),
    ).toBe(false);
    expect(isMetadataOnlyMssqlSql('CREATE INDEX [IX_u] ON [dbo].[users] ([code])')).toBe(false);
  });

  test('stripMssqlImportNoise & assertImportable strip consecutive/inline USE while preserving query hints and blocking instance-level bypasses', () => {
    // 连续无分号 USE、SET 语句后跟 USE、GO 2 后跟 USE 均应完整剥离
    const multiUse = stripMssqlImportNoise(
      'USE [app]\nUSE [master]\nCREATE TABLE [dbo].[t] ([id] int);\nSET ANSI_NULLS ON\nUSE [app]\nGO 2\nUSE [app]\nSELECT 1;',
    );
    expect(multiUse).not.toMatch(/\bUSE\s+\[/i);
    expect(multiUse).toContain('CREATE TABLE [dbo].[t] ([id] int);');
    expect(multiUse).toContain('SET ANSI_NULLS ON');
    expect(multiUse).toContain('GO 2');

    // 查询提示 USE HINT / USE PLAN 必须原样保留
    const withHints = [
      "SELECT 1 OPTION (USE HINT ('FORCE_LEGACY_CARDINALITY_ESTIMATION'));",
      "SELECT 1 OPTION (RECOMPILE, USE PLAN N'<ShowPlanXML/>');",
    ].join('\n');
    expect(stripMssqlImportNoise(withHints)).toBe(withHints);

    // 导入入口 assertImportable 允许 SSMS 带 USE [MyDb]\nGO 的建表脚本并已剥离 USE
    const clean = assertImportable('USE [MyDb]\nGO\nCREATE TABLE [dbo].[t] ([id] int);', 'mssql');
    expect(clean).not.toMatch(/\bUSE\b/i);
    expect(clean).toContain('CREATE TABLE [dbo].[t] ([id] int);');

    // 不可借 USE 夹带或绕过实例级语句拦截
    for (const bad of [
      'USE [MyDb]\nGO\nDROP DATABASE [prod];',
      "EXEC USE [x] xp_cmdshell 'whoami'",
      'USE hint (SELECT 1)',
    ]) {
      expect(() => assertImportable(bad, 'mssql'), `expected block: ${bad}`).toThrow(ShadowError);
    }
  });

  test('resetMssqlShadow retries remaining routines after DROP TABLE and fails loudly if routines remain undeletable', async () => {
    const makeFakeResetDb = (stillFailAfterDropTable: boolean): { db: Db; execs: string[] } => {
      const execs: string[] = [];
      let tableDropped = false;
      const db: Db = {
        query: async <T>(q: string): Promise<T[]> => {
          if (q.includes('SELECT DB_NAME()')) return [{ dbName: 'app_dowel' }] as T[];
          if (q.includes('FROM sys.objects o')) {
            return [{ schema: 'app', name: 'fn_check', type: 'FN' }] as T[];
          }
          if (q.includes('FROM sys.tables t')) {
            return [{ schema: 'app', name: 'orders' }] as T[];
          }
          if (q.includes('FROM sys.schemas s')) {
            return [{ name: 'app' }] as T[];
          }
          return [] as T[];
        },
        exec: async (q: string) => {
          execs.push(q);
          if (q === 'DROP FUNCTION IF EXISTS [app].[fn_check]') {
            if (!tableDropped || stillFailAfterDropTable) {
              throw Object.assign(
                new Error(
                  "Cannot DROP FUNCTION 'app.fn_check' because it is being referenced by object 'orders'.",
                ),
                { number: 3729 },
              );
            }
          }
          if (q === 'DROP TABLE [app].[orders]') {
            tableDropped = true;
          }
          if (q === 'DROP SCHEMA [app]' && !execs.includes('DROP FUNCTION IF EXISTS [app].[fn_check]')) {
            throw new Error('schema still has objects');
          }
        },
      };
      return { db, execs };
    };

    // 1. 表依赖函数在 Step 3 报 3729，Step 4 删表后 Step 4b 补删函数成功，然后正常 DROP SCHEMA
    const okCase = makeFakeResetDb(false);
    await expect(resetMssqlShadow(okCase.db)).resolves.toBeUndefined();
    const dropTableIdx = okCase.execs.indexOf('DROP TABLE [app].[orders]');
    const dropSchemaIdx = okCase.execs.indexOf('DROP SCHEMA [app]');
    const lastDropFnIdx = okCase.execs.lastIndexOf('DROP FUNCTION IF EXISTS [app].[fn_check]');
    expect(dropTableIdx).toBeGreaterThan(-1);
    expect(lastDropFnIdx).toBeGreaterThan(dropTableIdx);
    expect(dropSchemaIdx).toBeGreaterThan(lastDropFnIdx);

    // 2. Step 4 删表后若例程仍无法删除，必须显式抛错并保留底层错误号（不静默忽略）
    const failCase = makeFakeResetDb(true);
    const err = await resetMssqlShadow(failCase.db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('app.fn_check');
    expect(mssqlErrorNumber(err)).toBe(3729);
  });

  test('claimMssqlShadow and claimMssqlShadowOn reject system databases and empty DB_NAME()', async () => {
    await expect(claimMssqlShadow('mssql://sa:pw@127.0.0.1:1433/master')).rejects.toThrow(ShadowError);
    await expect(claimMssqlShadow('mssql://sa:pw@127.0.0.1:1433/MSDB')).rejects.toThrow(ShadowError);

    for (const dbName of ['master', 'tempdb', 'model', 'msdb', 'Master', '', null]) {
      const execs: string[] = [];
      const fakeDb: Db = {
        query: async <T>(q: string): Promise<T[]> => {
          if (q.includes('SELECT DB_NAME()')) return [{ dbName }] as T[];
          throw new Error(`unexpected query for ${String(dbName)}: ${q}`);
        },
        exec: async (q: string) => {
          execs.push(q);
        },
      };
      await expect(claimMssqlShadowOn(fakeDb), `expected reject for ${String(dbName)}`).rejects.toThrow(
        ShadowError,
      );
      expect(execs).toEqual([]);
    }
  });

  test('shadowOps.canonicalize syncs notNull for MSSQL PERSISTED computed columns without touching virtual computed columns', async () => {
    const prev = emptyModel('mssql');
    createSchema(prev, 'dbo', 's-dbo');
    const next = structuredClone(prev);
    const tbl = createTable(next, 's-dbo', 'items', 't-items');
    addColumn(next, tbl, { id: 'c-code', name: 'code', type: 'nvarchar(32)', notNull: false });
    addColumn(next, tbl, {
      id: 'c-persisted',
      name: 'display_code',
      type: 'nvarchar(32)',
      notNull: false,
      generated: { expr: "(isnull([code],N''))", stored: true },
    });
    addColumn(next, tbl, {
      id: 'c-virtual',
      name: 'virt_code',
      type: 'nvarchar(32)',
      notNull: true,
      generated: { expr: "(isnull([code],N''))", stored: false },
    });

    let tableBuilt = false;
    const fakeDb: Db = {
      query: async <T>(q: string): Promise<T[]> => {
        if (q.includes('SELECT DB_NAME()')) return [{ dbName: 'app_dowel' }] as T[];
        if (q.includes('ProductMajorVersion') && q.includes('dbCollation')) {
          return [
            {
              version: '16.0.1000.6',
              major: 16,
              minor: 0,
              dbCollation: 'SQL_Latin1_General_CP1_CI_AS',
            },
          ] as T[];
        }
        if (q.includes('ProductMajorVersion')) {
          return [{ major: 16, minor: 0 }] as T[];
        }
        if (q.includes('FROM sys.schemas s') && q.includes('MS_Description')) {
          return [{ name: 'dbo', comment: null }] as T[];
        }
        if (q.includes('FROM sys.tables t') && q.includes('MS_Description')) {
          return (tableBuilt ? [{ objectId: 100, schema: 'dbo', name: 'items', comment: null }] : []) as T[];
        }
        if (q.includes('FROM sys.columns c') && q.includes('sys.computed_columns')) {
          return (
            tableBuilt
              ? [
                  {
                    objectId: 100,
                    columnId: 1,
                    name: 'code',
                    typeName: 'nvarchar',
                    maxLength: 64,
                    precision: 0,
                    scale: 0,
                    isNullable: true,
                    collationName: 'SQL_Latin1_General_CP1_CI_AS',
                    isSparse: false,
                    isRowguidcol: false,
                    isIdentity: false,
                    seedValue: null,
                    incrementValue: null,
                    defaultName: null,
                    defaultDef: null,
                    isComputed: false,
                    computedDef: null,
                    isPersisted: null,
                    comment: null,
                  },
                  {
                    objectId: 100,
                    columnId: 2,
                    name: 'display_code',
                    typeName: 'nvarchar',
                    maxLength: 64,
                    precision: 0,
                    scale: 0,
                    isNullable: false,
                    collationName: 'SQL_Latin1_General_CP1_CI_AS',
                    isSparse: false,
                    isRowguidcol: false,
                    isIdentity: false,
                    seedValue: null,
                    incrementValue: null,
                    defaultName: null,
                    defaultDef: null,
                    isComputed: true,
                    computedDef: "(isnull([code],N''))",
                    isPersisted: true,
                    comment: null,
                  },
                  {
                    objectId: 100,
                    columnId: 3,
                    name: 'virt_code',
                    typeName: 'nvarchar',
                    maxLength: 64,
                    precision: 0,
                    scale: 0,
                    isNullable: false,
                    collationName: 'SQL_Latin1_General_CP1_CI_AS',
                    isSparse: false,
                    isRowguidcol: false,
                    isIdentity: false,
                    seedValue: null,
                    incrementValue: null,
                    defaultName: null,
                    defaultDef: null,
                    isComputed: true,
                    computedDef: "(isnull([code],N''))",
                    isPersisted: false,
                    comment: null,
                  },
                ]
              : []
          ) as T[];
        }
        return [] as T[];
      },
      exec: async (q: string) => {
        if (q.includes('CREATE TABLE [dbo].[items]')) tableBuilt = true;
      },
    };

    const changed = await shadowOps(async () => fakeDb, null, { dialect: 'mssql' }).canonicalize(prev, next);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      id: 'c-persisted',
      kind: 'column',
      notNull: true,
    });
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
