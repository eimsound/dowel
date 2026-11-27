// MSSQL 服务端目标库驱动与全栈端到端测试：
// - URL 解析校验（mssql:// / sqlserver://、host\instance、默认 encrypt=true & trustServerCertificate=false）；
// - inspectTarget / pullSchema / 同实例影子库 claimShadow 扩展属性防误删业务库与清理；
// - 服务端项目创建、SQL 导入、验证、发布与执行端到端闭环。
import type {
  ProjectCreated,
  ProjectInfo,
  PublishRejected,
  TargetInfo,
  VersionCreated,
  VersionDetail,
  WizardEvent,
} from '@dowel/api';
import {
  addColumn,
  all,
  type Column,
  createSchema,
  createTable,
  emptyBase,
  emptyModel,
  type Model,
  mssqlIdent,
  mssqlLiteral,
  plan,
  PlanError,
  runMutator,
} from '@dowel/core';
import {
  type Db,
  getEngine,
  isMetadataOnlyMssqlSql,
  mssqlErrorNumber,
  resetMssqlShadow,
  stripMssqlImportNoise,
} from '@dowel/engines';
import { diffAgainst } from '@dowel/executor';
import { runSteps, StepError, verify, verifyScripts } from '@dowel/verifier';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { connectTestMssql, createTestMssqlDb, getMssqlAdminUrl, MSSQL_VERSION } from '../../../test/mssql.ts';
import { pendingRefreshIds } from '../src/derive.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import {
  assertImportable,
  isConnectionFailure,
  isInfraFailure,
  type Shadow,
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
  mssqlShadow,
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

  test.each([
    { explicit: false, probeNullable: null, want: { notNull: false, inferred: true } },
    { explicit: true, probeNullable: true, want: { notNull: true, inferred: false } },
    { explicit: true, probeNullable: false, want: { notNull: true, inferred: true } },
  ])(
    'shadowOps.canonicalize writes ext.mssql.inferredNotNull (never the explicit notNull) for MSSQL PERSISTED computed columns, probing explicit ones (%o, #161)',
    async ({ explicit, probeNullable, want }) => {
      const prev = emptyModel('mssql');
      createSchema(prev, 'dbo', 's-dbo');
      const next = structuredClone(prev);
      const tbl = createTable(next, 's-dbo', 'items', 't-items');
      addColumn(next, tbl, { id: 'c-code', name: 'code', type: 'nvarchar(32)', notNull: false });
      addColumn(next, tbl, {
        id: 'c-persisted',
        name: 'display_code',
        type: 'nvarchar(32)',
        notNull: explicit,
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
      const probes: string[] = [];
      const fakeDb: Db = {
        query: async <T>(q: string): Promise<T[]> => {
          if (q.includes('SELECT DB_NAME()')) return [{ dbName: 'app_dowel' }] as T[];
          if (q.includes('c.is_nullable AS isNullable FROM sys.columns c')) {
            return [{ name: '__dowel_nn_probe_0', isNullable: probeNullable }] as T[];
          }
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
            return (
              tableBuilt ? [{ objectId: 100, schema: 'dbo', name: 'items', comment: null }] : []
            ) as T[];
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
          if (q.includes('__dowel_nn_probe_')) probes.push(q);
        },
      };

      const changed = await shadowOps(async () => fakeDb, null, { dialect: 'mssql' }).canonicalize(
        prev,
        next,
      );
      // 显式 NOT NULL 的列才在影子库里探测表达式本身的推断（加临时计算列 → 读 is_nullable → 删掉）
      expect(probes).toEqual(
        explicit
          ? [
              "ALTER TABLE [dbo].[items] ADD [__dowel_nn_probe_0] AS ((isnull([code],N'')))",
              'ALTER TABLE [dbo].[items] DROP COLUMN [__dowel_nn_probe_0]',
            ]
          : [],
      );
      const out = changed.find((o) => o.id === 'c-persisted') ?? next.objects['c-persisted'];
      expect(out).toMatchObject({ kind: 'column', notNull: want.notNull });
      expect(Boolean((out as Column).ext?.mssql?.inferredNotNull)).toBe(want.inferred);
      // 非持久化计算列不受影响
      expect(changed.some((o) => o.id === 'c-virtual')).toBe(false);
    },
  );

  test('verifier keeps shadowMajor=null for mssql while preserving 2019/2022/2025 capability checks', async () => {
    const makeFakeMssqlVerifyDb = (major: number): Db => {
      const tables = new Set<string>();
      return {
        query: async <T>(q: string): Promise<T[]> => {
          if (q.includes('SELECT DB_NAME()')) return [{ dbName: 'app_dowel' }] as T[];
          if (q.includes('ProductMajorVersion') && q.includes('dbCollation')) {
            return [
              {
                version: `${major}.0.1000.6`,
                major,
                minor: 0,
                dbCollation: 'SQL_Latin1_General_CP1_CI_AS',
              },
            ] as T[];
          }
          if (q.includes('ProductMajorVersion')) return [{ major, minor: 0 }] as T[];
          if (q.includes('FROM sys.schemas s') && q.includes('MS_Description')) {
            return [{ name: 'dbo', comment: null }] as T[];
          }
          if (q.includes('FROM sys.tables t') && q.includes('MS_Description')) {
            return [...tables].map((name, i) => ({
              objectId: 100 + i,
              schema: 'dbo',
              name,
              comment: null,
            })) as T[];
          }
          if (q.includes('FROM sys.tables t')) {
            return [...tables].map((name) => ({ schema: 'dbo', name })) as T[];
          }
          if (q.includes('FROM sys.columns c') && q.includes('sys.computed_columns')) {
            const rows: Record<string, unknown>[] = [];
            let oid = 100;
            for (const name of tables) {
              if (name === 'items') {
                rows.push({
                  objectId: oid,
                  columnId: 1,
                  name: 'id',
                  typeName: 'int',
                  maxLength: 4,
                  precision: 10,
                  scale: 0,
                  isNullable: false,
                  collationName: null,
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
                });
              } else if (name === 'embeddings') {
                rows.push(
                  {
                    objectId: oid,
                    columnId: 1,
                    name: 'id',
                    typeName: 'int',
                    maxLength: 4,
                    precision: 10,
                    scale: 0,
                    isNullable: false,
                    collationName: null,
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
                    objectId: oid,
                    columnId: 2,
                    name: 'payload',
                    typeName: 'json',
                    maxLength: -1,
                    precision: 0,
                    scale: 0,
                    isNullable: true,
                    collationName: null,
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
                    objectId: oid,
                    columnId: 3,
                    name: 'vec',
                    typeName: 'vector',
                    maxLength: 20, // 8 + 4 * 3 => vector(3)
                    precision: 0,
                    scale: 0,
                    isNullable: true,
                    collationName: null,
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
                );
              }
              oid++;
            }
            return rows as T[];
          }
          return [] as T[];
        },
        exec: async (q: string) => {
          const createMatch = /CREATE TABLE \[dbo\]\.\[([^\]]+)\]/.exec(q);
          if (createMatch) tables.add(createMatch[1]!);
          const dropMatch = /DROP TABLE \[dbo\]\.\[([^\]]+)\]/.exec(q);
          if (dropMatch) tables.delete(dropMatch[1]!);
        },
      };
    };

    const mBasicTo = emptyModel('mssql');
    const dBasic = createSchema(mBasicTo, 'dbo', 's-dbo');
    const tItems = createTable(mBasicTo, dBasic, 'items', 't-items');
    addColumn(mBasicTo, tItems, { id: 'c-id', name: 'id', type: 'int', notNull: true });
    const mBasicFrom = emptyBase(mBasicTo, null);

    const basicUp = [{ sql: 'CREATE TABLE [dbo].[items] (\n  [id] int NOT NULL\n)', transactional: true }];
    const basicDown = [{ sql: 'DROP TABLE [dbo].[items]', transactional: true }];

    for (const major of [15, 16, 17]) {
      const rVerify = await verify(makeFakeMssqlVerifyDb(major), mBasicFrom, mBasicTo);
      expect(rVerify.shadowMajor, `verify major=${major}`).toBeNull();
      expect(rVerify.upDiff).toEqual([]);
      expect(rVerify.downDiff).toEqual([]);

      const rScripts = await verifyScripts(
        makeFakeMssqlVerifyDb(major),
        mBasicFrom,
        mBasicTo,
        basicUp,
        basicDown,
      );
      expect(rScripts.shadowMajor, `verifyScripts major=${major}`).toBeNull();
      expect(rScripts.upDiff).toEqual([]);
      expect(rScripts.downDiff).toEqual([]);
    }

    // 2025 (17) 原生 json / vector(3)：2019 (15) 与 2022 (16) 拒绝，2025 (17) 放行且 shadowMajor 仍为 null
    const m2025To = emptyModel('mssql');
    const d25 = createSchema(m2025To, 'dbo', 's-dbo');
    const tEmb = createTable(m2025To, d25, 'embeddings', 't-emb');
    addColumn(m2025To, tEmb, { id: 'c-e-id', name: 'id', type: 'int', notNull: true });
    addColumn(m2025To, tEmb, { id: 'c-e-json', name: 'payload', type: 'json' });
    addColumn(m2025To, tEmb, { id: 'c-e-vec', name: 'vec', type: 'vector(3)' });
    const m2025From = emptyBase(m2025To, null);
    const up2025 = [
      {
        sql: 'CREATE TABLE [dbo].[embeddings] (\n  [id] int NOT NULL,\n  [payload] json NULL,\n  [vec] vector(3) NULL\n)',
        transactional: true,
      },
    ];
    const down2025 = [{ sql: 'DROP TABLE [dbo].[embeddings]', transactional: true }];

    for (const oldMajor of [15, 16]) {
      await expect(verify(makeFakeMssqlVerifyDb(oldMajor), m2025From, m2025To)).rejects.toThrow(PlanError);
      await expect(verify(makeFakeMssqlVerifyDb(oldMajor), m2025From, m2025To)).rejects.toThrow(/2025/);
      await expect(
        verifyScripts(makeFakeMssqlVerifyDb(oldMajor), m2025From, m2025To, up2025, down2025),
      ).rejects.toThrow(PlanError);
      await expect(
        verifyScripts(makeFakeMssqlVerifyDb(oldMajor), m2025From, m2025To, up2025, down2025),
      ).rejects.toThrow(/2025/);
    }

    const ok25Verify = await verify(makeFakeMssqlVerifyDb(17), m2025From, m2025To);
    expect(ok25Verify.shadowMajor).toBeNull();
    expect(ok25Verify.upDiff).toEqual([]);
    expect(ok25Verify.downDiff).toEqual([]);

    const ok25Scripts = await verifyScripts(makeFakeMssqlVerifyDb(17), m2025From, m2025To, up2025, down2025);
    expect(ok25Scripts.shadowMajor).toBeNull();
    expect(ok25Scripts.upDiff).toEqual([]);
    expect(ok25Scripts.downDiff).toEqual([]);
  });

  test('versions.ts guards non-PG dialects from PG major targets, mismatch tracking, and PG error prefixes', async () => {
    const pdb = await openPlatformDb(':memory:');
    const created = createApp(pdb, { loginLimiter: new LoginLimiter({ limit: 1000, windowMs: 60_000 }) });
    try {
      await makeUser(pdb, 'mssql-guard-admin', { role: 'admin' });
      const loginRes = await created.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'mssql-guard-admin', password: PASSWORD }),
      });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

      const gRes = await created.app.request('/api/groups', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'MSSQL Guard Team', slug: 'mssql-guard-team' }),
      });
      expect(gRes.status).toBe(201);
      const { id: groupId } = (await gRes.json()) as { id: string };

      const pRes = await created.app.request('/api/projects', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'MSSQL Guard Proj', groupId, dialect: 'mssql' }),
      });
      expect(pRes.status).toBe(201);
      const { id: pid } = (await pRes.json()) as ProjectCreated;

      const addMssqlTable = async (name: string) => {
        await editModel(created.rooms, pdb, pid, (m: Model) => {
          const dbo = all(m, 'schema').find((s) => s.name === 'dbo')?.id ?? createSchema(m, 'dbo');
          const t = createTable(m, dbo, name);
          addColumn(m, t, { name: 'id', type: 'int', notNull: true });
        });
      };
      await addMssqlTable('items');

      const stubShadow = (verifyScriptsFn: Shadow['verifyScripts']): Shadow =>
        ({
          verifyScripts: verifyScriptsFn,
          importSql: async () => {
            throw new Error('unused');
          },
          verify: async () => {
            throw new Error('unused');
          },
          canonicalize: async () => [],
          close: async () => {},
        }) as Shadow;

      // 即使上游 mock 传入了版本组键 / 目标组 / shadowMajor，不按版本分组的方言也不能记录 targets 或版本标签文案
      created.shadows.forProjectVersions = async () => ({
        targetGroupKey: 16,
        skippedGroups: [],
        entries: [
          {
            groupKey: 16,
            envId: 'e-mssql-16',
            label: 'dev：app_dowel',
            shadow: stubShadow(async () => ({
              ok: true,
              up: [],
              down: [],
              upDiff: [],
              downDiff: [],
              risks: [],
              error: null,
              shadowMajor: 16,
            })),
          },
        ],
      });

      const okRes = await created.app.request(`/api/projects/${pid}/versions`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'v1' }),
      });
      expect(okRes.status).toBe(201);
      const okData = (await okRes.json()) as VersionCreated;
      expect(okData.verified).toBe(true);

      const detRes = await created.app.request(`/api/projects/${pid}/versions/${okData.id}`, {
        headers: { cookie },
      });
      expect(detRes.status).toBe(200);
      const det = (await detRes.json()) as VersionDetail;
      expect(det.verifyReport?.targets).toBeUndefined();
      expect(det.verifyReport?.missingTargetMajor).toBeUndefined();
      expect(det.verifyReport?.shadow).toBe('dev：app_dowel');
      expect(det.verifyReport?.shadow).not.toContain('PG');

      // 失败场景：错误文案与 shadow 标签不能带 "PG ..." 前缀，且不返回 targets
      await addMssqlTable('orders');
      created.shadows.forProjectVersions = async () => ({
        targetGroupKey: 16,
        skippedGroups: [],
        entries: [
          {
            groupKey: 16,
            envId: 'e-mssql-16',
            label: 'dev：app_dowel',
            shadow: stubShadow(async () => ({
              ok: false,
              up: [],
              down: [],
              upDiff: [],
              downDiff: [],
              risks: [],
              error: { step: null, message: 'ddl failed' },
              shadowMajor: 16,
            })),
          },
        ],
      });

      const failRes = await created.app.request(`/api/projects/${pid}/versions`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'v2' }),
      });
      expect(failRes.status).toBe(422);
      const failBody = (await failRes.json()) as PublishRejected;
      expect(failBody.error).toBe('闭环验证没有通过，版本没有发布。请先修正模型');
      expect(failBody.error).not.toContain('PG');
      expect(failBody.report).toBeDefined();
      expect(failBody.report?.error?.message).toBe('ddl failed');
      expect(failBody.report?.shadow).toBe('dev：app_dowel');
      expect(failBody.report?.targets).toBeUndefined();
    } finally {
      created.drift.stop();
      created.requests.stop();
      await created.webhooks.close();
      await created.refresher.drain();
      await created.shadows.close();
      created.rooms.close();
      await created.bus.close();
      await created.ha.stop();
      await pdb.close();
    }
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

  test('PERSISTED computed column nullability follows the referenced column on real SQL Server, and pendingRefreshIds flags it (#145)', async () => {
    if (!adminUrl) return;
    const t = await createTestMssqlDb('mssql_nn');
    const shadow = mssqlShadow(t.url);
    try {
      await claimMssqlShadow(t.url);
      const m = emptyModel('mssql');
      runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
      runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
      runMutator(m, 'addColumn', { table: 't', column: { id: 'c', name: 'code', type: 'nvarchar(32)' } });
      // 不显式声明 NOT NULL 的持久化计算列：SQL Server 按表达式与被引用列推断 is_nullable
      runMutator(m, 'addColumn', {
        table: 't',
        column: {
          id: 'g',
          name: 'code_p',
          type: 'nvarchar(32)',
          generated: { expr: '([code])', stored: true },
        },
      });
      // upper() 的结果总被视为可空：被引用列改 NOT NULL 后读回仍可空（只会多验一次，不会改写）
      runMutator(m, 'addColumn', {
        table: 't',
        column: {
          id: 'u',
          name: 'code_u',
          type: 'nvarchar(32)',
          generated: { expr: '(upper([code]))', stored: true },
        },
      });
      runMutator(m, 'addColumn', {
        table: 't',
        column: {
          id: 'v',
          name: 'code_v',
          type: 'nvarchar(32)',
          generated: { expr: '([code])', stored: false },
        },
      });
      const canon = async (prev: Model, next: Model) => {
        const out = structuredClone(next);
        const changed = await shadow.canonicalize(prev, next);
        for (const o of changed) out.objects[o.id] = o;
        return { out, changed };
      };
      const inferredOf = (x: Model, id: string) =>
        Boolean((x.objects[id] as Column).ext?.mssql?.inferredNotNull);
      const { out: good } = await canon(emptyModel('mssql'), m);
      expect((good.objects.g as { notNull: boolean }).notNull).toBe(false);
      expect(inferredOf(good, 'g')).toBe(false);
      expect(pendingRefreshIds(good, structuredClone(good))).toEqual([]);

      // 只把被引用列改成 NOT NULL：表达式与类型都没变
      const cur = structuredClone(good);
      runMutator(cur, 'setNotNull', { id: 'c', notNull: true });
      expect(pendingRefreshIds(good, cur)).toEqual(['g', 'u']);
      const { out: after, changed } = await canon(good, cur);
      // 实测：读回的 is_nullable 确实变了（漏判时过期的推断值会留在模型里）；写回的是推断值，显式 notNull 不动（#161）
      expect(changed.map((o) => o.id)).toEqual(['g']);
      expect((after.objects.g as { notNull: boolean }).notNull).toBe(false);
      expect(inferredOf(after, 'g')).toBe(true);
      expect(inferredOf(after, 'u')).toBe(false);
      // 稳态：写回之后不再待规范化
      expect(pendingRefreshIds(after, structuredClone(after))).toEqual([]);

      // 计算列自己勾上显式 NOT NULL：待规范化；影子库探测表达式本身仍推断非空，显式声明原样保留
      const own = structuredClone(after);
      runMutator(own, 'setNotNull', { id: 'g', notNull: true });
      expect(pendingRefreshIds(after, own)).toEqual(['g']);
      const { changed: ownChanged } = await canon(after, own);
      expect(ownChanged).toEqual([]);
    } finally {
      await shadow.close();
      await t.close();
    }
  }, 120_000);

  test('explicit PERSISTED NOT NULL vs inferred non-null on real SQL Server: DDL, normalization, read-back, issue scenario and import (#161)', async () => {
    if (!adminUrl) return;
    const target = await createTestMssqlDb('mssql_nn161');
    const shadowDb = await createTestMssqlDb('mssql_nn161s');
    const shadow = mssqlShadow(shadowDb.url);
    const engine = getEngine('mssql');
    const col = (x: Model, id: string) => x.objects[id] as Column;
    const inferredOf = (x: Model, id: string) => Boolean(col(x, id).ext?.mssql?.inferredNotNull);
    const canon = async (prev: Model, next: Model) => {
      const out = structuredClone(next);
      for (const o of await shadow.canonicalize(prev, next)) out.objects[o.id] = o;
      return out;
    };
    /** 在目标库上执行 from → to，并按执行器的读回比较核对结构 */
    const apply = async (from: Model, to: Model) => {
      const steps = plan(from, to);
      await runSteps(target.db, steps, 'mssql');
      const diff = diffAgainst(await engine.readSnapshot(target.db, null), to);
      expect(diff).toEqual({ total: 0, items: [] });
      return steps.map((s) => s.sql).join('\n');
    };
    try {
      await claimMssqlShadow(shadowDb.url);
      // dbo.items(code NOT NULL, cp AS ([code]) PERSISTED 推断非空, cu AS (upper([code])) PERSISTED NOT NULL 显式)
      const m = emptyModel('mssql');
      runMutator(m, 'createSchema', { id: 's', name: 'dbo' });
      runMutator(m, 'createTable', { id: 't', schema: 's', name: 'items' });
      runMutator(m, 'addColumn', {
        table: 't',
        column: { id: 'id', name: 'id', type: 'int', notNull: true },
      });
      runMutator(m, 'addColumn', {
        table: 't',
        column: { id: 'c', name: 'code', type: 'nvarchar(32)', notNull: true },
      });
      runMutator(m, 'addColumn', {
        table: 't',
        column: { id: 'cp', name: 'cp', type: 'nvarchar(32)', generated: { expr: '([code])', stored: true } },
      });
      runMutator(m, 'addColumn', {
        table: 't',
        column: {
          id: 'cu',
          name: 'cu',
          type: 'nvarchar(32)',
          notNull: true,
          generated: { expr: '(upper([code]))', stored: true },
        },
      });

      // 1. 规范化：cp 推断非空（只写 inferredNotNull）；cu 显式声明、表达式本身推断可空（影子库探测），显式不动
      const v1 = await canon(emptyModel('mssql'), m);
      expect(col(v1, 'cp').notNull).toBe(false);
      expect(inferredOf(v1, 'cp')).toBe(true);
      expect(col(v1, 'cu').notNull).toBe(true);
      expect(inferredOf(v1, 'cu')).toBe(false);
      expect(pendingRefreshIds(v1, structuredClone(v1))).toEqual([]);

      // 2. 建到目标库：推断非空不渲染 NOT NULL，显式声明保留；读回比较一致
      const ddl1 = await apply(emptyModel('mssql'), v1);
      expect(ddl1).toContain('[cp] AS (([code])) PERSISTED,');
      expect(ddl1).toContain('[cu] AS ((upper([code]))) PERSISTED NOT NULL');

      // 3. Issue 场景：code 改回可空 → 规范化写回推断可空 → 迁移不带 NOT NULL，目标库能插入 code 为 NULL 的行
      const v2edit = structuredClone(v1);
      runMutator(v2edit, 'setNotNull', { id: 'c', notNull: false });
      expect(pendingRefreshIds(v1, v2edit)).toEqual(['cp', 'cu']);
      const v2 = await canon(v1, v2edit);
      expect(inferredOf(v2, 'cp')).toBe(false);
      expect(col(v2, 'cu').notNull).toBe(true);
      // cu 显式 NOT NULL、表达式随 code 可空：先把它改成可空，才能插入 code 为 NULL 的行
      runMutator(v2, 'setNotNull', { id: 'cu', notNull: false });
      const ddl2 = await apply(v1, v2);
      expect(ddl2).toContain('ADD [cp] AS (([code])) PERSISTED');
      expect(ddl2).not.toMatch(/\[cp\][^\n]*NOT NULL/);
      await target.db.exec('INSERT INTO [dbo].[items] ([id], [code]) VALUES (1, NULL)');
      await target.db.exec('DELETE FROM [dbo].[items]');

      // 4. 从已有数据库导入：系统目录分不出显式与推断，一律记成推断；有参考模型时（拉取 / 漂移）沿用它的显式声明
      await target.db.exec('ALTER TABLE [dbo].[items] DROP COLUMN [cp], [cu]');
      await target.db.exec('ALTER TABLE [dbo].[items] ALTER COLUMN [code] nvarchar(32) NOT NULL');
      await target.db.exec(
        'ALTER TABLE [dbo].[items] ADD [cp] AS ([code]) PERSISTED, [ce] AS ([code]) PERSISTED NOT NULL, [cu] AS (upper([code])) PERSISTED NOT NULL',
      );
      const pulled = await pullMssqlSchema(target.url);
      for (const name of ['cp', 'ce', 'cu']) {
        const c = Object.values(pulled.objects).find(
          (o): o is Column => o.kind === 'column' && o.name === name,
        )!;
        expect({ name, notNull: c.notNull, inferred: c.ext?.mssql?.inferredNotNull }).toEqual({
          name,
          notNull: false,
          inferred: true,
        });
      }
      // 影子库导入 SQL：表达式本身推断可空、读回却非空的，只能是显式声明，还原成显式
      const imported = await shadow.importSql(
        assertImportable(
          'CREATE TABLE [dbo].[items] ([code] nvarchar(32) NOT NULL, [cp] AS ([code]) PERSISTED, [cu] AS (upper([code])) PERSISTED NOT NULL)',
          'mssql',
        ),
      );
      const byName = (n: string) =>
        Object.values(imported.objects).find((o): o is Column => o.kind === 'column' && o.name === n)!;
      expect({ notNull: byName('cp').notNull, inferred: byName('cp').ext?.mssql?.inferredNotNull }).toEqual({
        notNull: false,
        inferred: true,
      });
      expect(byName('cu').notNull).toBe(true);
      expect(byName('cu').ext?.mssql?.inferredNotNull).toBeUndefined();
    } finally {
      await shadow.close();
      await shadowDb.close();
      await target.close();
    }
  }, 180_000);

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
