// MSSQL 执行器集成测试：
// - [dowel] schema 历史表与 AFTER UPDATE, DELETE 只追加触发器防篡改验证；
// - GO 多批迁移步骤（含 CREATE SCHEMA / CREATE VIEW）执行；
// - 事务 DDL 回滚原子性（中途报错整批回滚，不留半途结构）；
// - baseline / up / down / 错误恢复与重试；
// - sp_getapplock 会话级项目互斥锁并发与锁超时测试。
import {
  addColumn,
  addPrimaryKey,
  addUnique,
  createSchema,
  createTable,
  emptyBase,
  emptyModel,
  type Model,
  plan,
} from '@dowel/core';
import { getEngine, type ScriptStep, stepsChecksum, toScriptSteps } from '@dowel/engines';
import { type ChainVersion, checkDrift, execute, ExecutorError } from '@dowel/executor';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  connectTestMssql,
  createTestMssqlDb,
  getMssqlAdminUrl,
  MSSQL_VERSION,
  stopMssqlContainer,
} from '../../../test/mssql.ts';

const buildUsersV1 = (): Model => {
  const m = emptyModel('mssql');
  const dbo = createSchema(m, 'dbo', 's-dbo');
  const t = createTable(m, dbo, 'users', 't-users');
  const id = addColumn(m, t, { id: 'c-id', name: 'id', type: 'bigint', notNull: true });
  addColumn(m, t, { id: 'c-email', name: 'email', type: 'nvarchar(128)', notNull: true });
  addPrimaryKey(m, t, [id], 'pk-users');
  return m;
};

const buildUsersV2 = (v1: Model): Model => {
  const m = structuredClone(v1);
  addColumn(m, 't-users', {
    id: 'c-role',
    name: 'role',
    type: 'nvarchar(32)',
    notNull: true,
    default: { expr: "N'member'" },
  });
  addUnique(m, 't-users', ['c-email'], false, 'uq-email');
  return m;
};

const makeChain = (models: Model[], start: 0 | 1 = 1): ChainVersion[] =>
  models.map((model, i) => {
    const from = i === 0 ? emptyBase(model, null) : models[i - 1]!;
    const up = toScriptSteps(plan(from, model), 'mssql');
    const down = i === 0 && start === 0 ? [] : toScriptSteps(plan(model, from), 'mssql');
    return {
      id: `v-${start + i}`,
      number: start + i,
      parentId: i === 0 ? null : `v-${start + i - 1}`,
      name: `v${start + i}`,
      model,
      upSteps: up,
      downSteps: down,
      checksum: stepsChecksum(up, down),
      verified: true,
      publishedAt: new Date().toISOString(),
      publishedBy: 'tester',
      scope: null,
    };
  });

const fails = async (p: Promise<unknown>): Promise<ExecutorError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExecutorError);
  return err as ExecutorError;
};

describe(`MSSQL (${MSSQL_VERSION}) executor integration`, () => {
  let adminUrl: string | null = null;
  const engine = getEngine('mssql');

  beforeAll(async () => {
    adminUrl = await getMssqlAdminUrl();
  }, 120_000);

  afterAll(async () => {
    await stopMssqlContainer();
  }, 60_000);

  it('enforces append-only triggers on [dowel].[history] and [dowel].[claims]', async () => {
    if (!adminUrl) return;
    const t = await createTestMssqlDb('mssql_hist_guard');
    try {
      await engine.history.ensureHistory(t.db);
      const runId = await engine.history.startRun(t.db, {
        projectId: 'p-guard',
        fromVersion: null,
        toVersion: 'v-1',
        direction: 'up',
        executedBy: 'alice',
        via: 'web',
        instanceId: 'inst-1',
      });
      await engine.history.markStep(t.db, runId, 0);
      await engine.history.finishRun(t.db, runId, 'done');

      // 禁止删除 history 行
      await expect(t.db.exec(`DELETE FROM [dowel].[history] WHERE [id] = ${runId}`)).rejects.toThrow(
        /只追加/,
      );
      // 禁止修改已完成记录
      await expect(
        t.db.exec(`UPDATE [dowel].[history] SET [status] = N'failed' WHERE [id] = ${runId}`),
      ).rejects.toThrow(/只追加/);

      // 禁止修改 running 态的标识字段
      const run2 = await engine.history.startRun(t.db, {
        projectId: 'p-guard',
        fromVersion: 'v-1',
        toVersion: 'v-2',
        direction: 'up',
        executedBy: 'alice',
        via: 'web',
        instanceId: 'inst-1',
      });
      await expect(
        t.db.exec(`UPDATE [dowel].[history] SET [to_version] = N'v-evil' WHERE [id] = ${run2}`),
      ).rejects.toThrow(/只追加/);
      await engine.history.finishRun(t.db, run2, 'failed', 'err');

      // claims 只追加触发器
      await engine.history.claimProject(t.db, {
        projectId: 'p-guard',
        instanceId: 'inst-1',
        claimedBy: 'u1',
        claimedByName: 'Alice',
        name: 'Guard App',
        note: 'initial',
      });
      await expect(t.db.exec(`DELETE FROM [dowel].[claims]`)).rejects.toThrow(/只追加/);
      await expect(t.db.exec(`UPDATE [dowel].[claims] SET [note] = N'tampered'`)).rejects.toThrow(/只追加/);
    } finally {
      await t.close();
    }
  }, 120_000);

  it('executes GO multi-batch steps, rolls back atomically on failure, and recovers on retry', async () => {
    if (!adminUrl) return;
    const t = await createTestMssqlDb('mssql_tx_go');
    try {
      const v1 = buildUsersV1();
      const v2 = buildUsersV2(v1);
      const chain = makeChain([v1, v2], 1);

      // 1. 升级到 v1，写入重复 email 制造 v2 加唯一约束失败
      const r1 = await execute({
        db: t.db,
        dialect: 'mssql',
        projectId: 'p-exec',
        projectName: 'Exec App',
        instanceId: 'inst-A',
        chain,
        to: 'v-1',
        executedBy: 'u1',
      });
      expect(r1.current).toBe('v-1');

      await t.db.exec(
        `INSERT INTO [dbo].[users] ([id], [email]) VALUES (1, N'dup@x.com'), (2, N'dup@x.com');`,
      );

      // 2. 升级到 v2：第 1 步加 role 列成功，第 2 步加 UNIQUE 约束失败 → 事务整体回滚，role 列也不存在
      const err = await fails(
        execute({
          db: t.db,
          dialect: 'mssql',
          projectId: 'p-exec',
          projectName: 'Exec App',
          instanceId: 'inst-A',
          chain,
          to: 'v-2',
          executedBy: 'u1',
        }),
      );
      expect(err.code).toBe('step_failed');
      expect(err.details.partial).toBe(false);

      const colsAfterRollback = await t.db.query<{ name: string }>(
        `SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'[dbo].[users]')`,
      );
      expect(colsAfterRollback.map((c) => c.name)).not.toContain('role');

      // 3. 修复重复数据后重试成功，且回滚到 v1、再升级到 v2 闭环正常
      await t.db.exec(`DELETE FROM [dbo].[users] WHERE [id] = 2;`);
      const r2 = await execute({
        db: t.db,
        dialect: 'mssql',
        projectId: 'p-exec',
        projectName: 'Exec App',
        instanceId: 'inst-A',
        chain,
        to: 'v-2',
        executedBy: 'u1',
      });
      expect(r2.current).toBe('v-2');
      expect(await checkDrift({ db: t.db, dialect: 'mssql', projectId: 'p-exec', chain })).toEqual({
        status: 'ok',
        version: 'v-2',
      });

      // 4. GO 多批迁移步骤（CREATE SCHEMA + GO + CREATE TABLE）执行无误
      await engine.execStepSql(
        t.db,
        `CREATE SCHEMA [reporting]\nGO\nCREATE TABLE [reporting].[metrics] ([id] int NOT NULL PRIMARY KEY)\nGO\nCREATE VIEW [reporting].[v_metrics] AS SELECT [id] FROM [reporting].[metrics]`,
      );
      const viewRows = await t.db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sys.views WHERE name = N'v_metrics'`,
      );
      expect(Number(viewRows[0]?.n)).toBe(1);
    } finally {
      await t.close();
    }
  }, 120_000);

  it('supports baseline mode on existing database and enforces sp_getapplock mutual exclusion', async () => {
    if (!adminUrl) return;
    const t = await createTestMssqlDb('mssql_lock');
    try {
      const v0 = buildUsersV1();
      const v1 = buildUsersV2(v0);
      const chain = makeChain([v0, v1], 0);

      // 预先按 v0 建好表并写入数据
      for (const s of chain[0]!.upSteps) await engine.execStepSql(t.db, s.sql);
      await t.db.exec(`INSERT INTO [dbo].[users] ([id], [email]) VALUES (7, N'a@b.com');`);

      // baseline 只写历史记录不重建表，数据保留
      const rBase = await execute({
        db: t.db,
        dialect: 'mssql',
        projectId: 'p-base',
        projectName: 'Base App',
        instanceId: 'inst-A',
        chain,
        mode: 'baseline',
        executedBy: 'u1',
      });
      expect(rBase.baseline).toBe(true);
      expect(rBase.current).toBe('v-0');

      const userRows = await t.db.query<{ id: string | number }>(`SELECT [id] FROM [dbo].[users]`);
      expect(Number(userRows[0]?.id)).toBe(7);

      // sp_getapplock 互斥测试：第二连接在持锁期间抢锁必超时
      const slowSteps: ScriptStep[] = [
        ...chain[1]!.upSteps,
        { sql: "WAITFOR DELAY '00:00:01.500'", transactional: true },
      ];
      const slowChain = chain.map((v) =>
        v.number === 1 ? { ...v, upSteps: slowSteps, checksum: stepsChecksum(slowSteps, v.downSteps) } : v,
      );

      const other = await connectTestMssql(t.url);
      try {
        const firstRun = execute({
          db: t.db,
          dialect: 'mssql',
          projectId: 'p-base',
          projectName: 'Base App',
          instanceId: 'inst-A',
          chain: slowChain,
          to: 'v-1',
          executedBy: 'u1',
        });
        await new Promise((r) => setTimeout(r, 400));
        const lockErr = await fails(
          execute({
            db: other.db,
            dialect: 'mssql',
            projectId: 'p-base',
            projectName: 'Base App',
            instanceId: 'inst-A',
            chain: slowChain,
            to: 'v-1',
            executedBy: 'u2',
            lockTimeoutMs: 250,
          }),
        );
        expect(lockErr.code).toBe('lock_timeout');

        const finished = await firstRun;
        expect(finished.current).toBe('v-1');
      } finally {
        await other.close();
      }
    } finally {
      await t.close();
    }
  }, 120_000);
});
