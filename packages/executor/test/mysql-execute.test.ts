// MySQL 执行器端到端测试：
// - dowel_* 历史表与只追加触发器（禁删、禁改已结束行、禁改标识列、禁改删 dowel_claims）
// - baseline / up / down / 锁超时
// - 非事务 DDL 中途失败断点续跑
// - 模拟“DDL 已自动提交但 markStep 写入前进程崩溃（status='running'）”精确识别 detectStepAlreadyApplied 续跑
// - 不确定步骤（如 DML / MODIFY COLUMN）崩溃恢复保守拒绝不误跳过
import * as E from '@dowel/core';
import { emptyBase, emptyModel, plan } from '@dowel/core';
import { getEngine, HistoryError, stepsChecksum, toScriptSteps } from '@dowel/engines';
import { type ChainVersion, execute, ExecutorError } from '@dowel/executor';
import { describe, expect, it } from 'vitest';

import { createMysqlTestDb, useMysqlTestDb } from '../../../test/mysql.ts';

const buildChain = () => {
  const m1 = emptyModel('mysql');
  const s = E.createSchema(m1, 'default');
  const users = E.createTable(m1, s, 'users');
  const id = E.addColumn(m1, users, { name: 'id', type: 'int', notNull: true });
  E.addPrimaryKey(m1, users, [id]);

  const m2 = structuredClone(m1);
  const email = E.addColumn(m2, users, { name: 'email', type: 'varchar(191)', notNull: true });
  E.addIndex(m2, users, [{ column: email }]);

  const m0 = emptyBase(m1, null);
  const up1 = toScriptSteps(plan(m0, m1), 'mysql');
  const down1 = toScriptSteps(plan(m1, m0), 'mysql');
  const up2 = toScriptSteps(plan(m1, m2), 'mysql');
  const down2 = toScriptSteps(plan(m2, m1), 'mysql');

  const chain: ChainVersion[] = [
    {
      id: 'v1',
      number: 1,
      parentId: null,
      name: 'create users',
      model: m1,
      upSteps: up1,
      downSteps: down1,
      checksum: stepsChecksum(up1, down1),
      verified: true,
      publishedAt: new Date().toISOString(),
      publishedBy: 'u1',
      scope: null,
    },
    {
      id: 'v2',
      number: 2,
      parentId: 'v1',
      name: 'add email & idx',
      model: m2,
      upSteps: up2,
      downSteps: down2,
      checksum: stepsChecksum(up2, down2),
      verified: true,
      publishedAt: new Date().toISOString(),
      publishedBy: 'u1',
      scope: null,
    },
  ];
  return { m0, m1, m2, chain };
};

describe('MySQL executor: history guards, crash recovery & resume', () => {
  const getDb = useMysqlTestDb('exec_mysql');

  it('enforces append-only triggers on dowel_history and dowel_claims and project lock mutual exclusion', async () => {
    const handle = getDb();
    if (!handle) return;

    const history = getEngine('mysql').history;
    await history.ensureHistory(handle.db);
    expect(await history.historyExists(handle.db)).toBe(true);
    expect(await history.readHistoryFormat(handle.db)).toBe(1);

    const runId = await history.startRun(handle.db, {
      projectId: 'p1',
      fromVersion: null,
      toVersion: 'v1',
      direction: 'up',
      executedBy: 'alice',
      via: 'web',
      instanceId: 'inst-a',
    });

    // 允许 running 状态下推进 step_index（含幂等写入同值）
    await history.markStep(handle.db, runId, 0);
    await history.markStep(handle.db, runId, 0);

    // 禁止篡改标识字段
    await expect(
      handle.db.query('UPDATE `dowel_history` SET `to_version` = ? WHERE `id` = ?', ['v999', runId]),
    ).rejects.toThrow(/只追加/);

    // 正常结束
    await history.finishRun(handle.db, runId, 'done');

    // 禁止再次修改已结束记录或删除记录
    await expect(history.finishRun(handle.db, runId, 'failed', 'tamper')).rejects.toThrow(HistoryError);
    await expect(
      handle.db.query("UPDATE `dowel_history` SET `status` = 'failed' WHERE `id` = ?", [runId]),
    ).rejects.toThrow(/只追加/);
    await expect(handle.db.query('DELETE FROM `dowel_history` WHERE `id` = ?', [runId])).rejects.toThrow(
      /只追加/,
    );

    // dowel_claims 只追加
    await history.claimProject(handle.db, {
      projectId: 'p1',
      instanceId: 'inst-a',
      claimedBy: 'alice',
      claimedByName: 'Alice',
      name: 'P1',
    });
    await expect(handle.db.query("UPDATE `dowel_claims` SET `note` = 'x'")).rejects.toThrow(/只追加/);
    await expect(handle.db.query('DELETE FROM `dowel_claims`')).rejects.toThrow(/只追加/);

    // 项目锁互斥与超时
    let releaseHolder!: () => void;
    const holderReady = new Promise<void>((r) => {
      releaseHolder = r;
    });
    let acquired!: () => void;
    const waitAcquired = new Promise<void>((r) => {
      acquired = r;
    });
    const hold = history.withProjectLock(handle.db, 'lock-proj', 5000, async () => {
      acquired();
      await holderReady;
    });
    await waitAcquired;
    await expect(history.withProjectLock(handle.db, 'lock-proj', 250, async () => {})).rejects.toMatchObject({
      code: 'lock_timeout',
    });
    releaseHolder();
    await hold;
  });

  it('resumes cleanly after a simulated crash where DDL auto-committed before markStep was written', async () => {
    const tdb = await createMysqlTestDb('exec_crash');
    if (!tdb) return;

    try {
      const { chain } = buildChain();
      const history = getEngine('mysql').history;

      // 1. 先正常执行到 v1
      const r1 = await execute({
        db: tdb.db,
        dialect: 'mysql',
        projectId: 'proj-crash',
        projectName: 'Crash Test',
        instanceId: 'inst-1',
        chain,
        to: 'v1',
        executedBy: 'u1',
      });
      expect(r1.current).toBe('v1');

      // 2. 模拟执行 v2 期间：step 0 (ADD COLUMN email) 已在 MySQL 隐式提交，但进程在 markStep(runId, 0) 前崩溃！
      const runId = await history.startRun(tdb.db, {
        projectId: 'proj-crash',
        fromVersion: 'v1',
        toVersion: 'v2',
        direction: 'up',
        executedBy: 'u1',
        via: 'web',
        instanceId: 'inst-1',
      });
      await history.markStep(tdb.db, runId, -1);
      await tdb.db.exec(chain[1]!.upSteps[0]!.sql); // ADD COLUMN email 已生效，但 step_index 仍为 -1，status='running'

      // 3. 重新调用 execute -> resumeFromCrash=true -> detectStepAlreadyApplied 识别 email 列已存在 -> 跳过第 1 步并继续建索引完成 v2
      const r2 = await execute({
        db: tdb.db,
        dialect: 'mysql',
        projectId: 'proj-crash',
        projectName: 'Crash Test',
        instanceId: 'inst-1',
        chain,
        to: 'v2',
        executedBy: 'u1',
      });
      expect(r2.current).toBe('v2');
    } finally {
      await tdb.close();
    }
  });

  it('conservatively refuses to auto-skip non-deterministic steps during crash recovery', async () => {
    const tdb = await createMysqlTestDb('exec_cons');
    if (!tdb) return;

    try {
      const engine = getEngine('mysql');
      await tdb.db.exec('CREATE TABLE `items` (`id` INT PRIMARY KEY)');
      // DML 与 MODIFY COLUMN 必须保守返回 false，绝不误跳过
      expect(
        await engine.detectStepAlreadyApplied!(tdb.db, {
          sql: 'INSERT INTO `items` VALUES (1)',
          transactional: false,
        }),
      ).toBe(false);
      expect(
        await engine.detectStepAlreadyApplied!(tdb.db, {
          sql: 'ALTER TABLE `items` MODIFY COLUMN `id` BIGINT NOT NULL',
          transactional: false,
        }),
      ).toBe(false);
      // 多语句同样保守返回 false
      expect(
        await engine.detectStepAlreadyApplied!(tdb.db, {
          sql: 'CREATE TABLE `items` (`id` INT); CREATE TABLE `other` (`id` INT)',
          transactional: false,
        }),
      ).toBe(false);

      // 真实执行失败断点续跑：构造含坏步骤的迁移，先失败在 step 2，验证 status=failed 且 stepIndex=0
      const m1 = emptyModel('mysql');
      const s = E.createSchema(m1, 'default');
      const t1 = E.createTable(m1, s, 'a');
      const id = E.addColumn(m1, t1, { name: 'id', type: 'int', notNull: true });
      E.addPrimaryKey(m1, t1, [id]);

      const badUp = [
        {
          sql: 'CREATE TABLE `a` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB',
          transactional: false,
        },
        { sql: 'ALTER TABLE `nonexistent_table` ADD COLUMN `x` int', transactional: false },
      ];
      const badDown = [{ sql: 'DROP TABLE `a`', transactional: false }];
      const badChain: ChainVersion[] = [
        {
          id: 'v-bad',
          number: 1,
          parentId: null,
          name: 'bad step',
          model: m1,
          upSteps: badUp,
          downSteps: badDown,
          checksum: stepsChecksum(badUp, badDown),
          verified: true,
          publishedAt: new Date().toISOString(),
          publishedBy: 'u1',
          scope: null,
        },
      ];

      await tdb.db.exec('DROP TABLE `items`');
      await expect(
        execute({
          db: tdb.db,
          dialect: 'mysql',
          projectId: 'proj-fail',
          projectName: 'Fail Test',
          instanceId: 'inst-1',
          chain: badChain,
          to: 'v-bad',
          executedBy: 'u1',
        }),
      ).rejects.toThrow(ExecutorError);

      const state = await engine.history.readHistory(tdb.db, 'proj-fail');
      expect(state.history[0]?.status).toBe('failed');
      expect(state.history[0]?.stepIndex).toBe(0);
    } finally {
      await tdb.close();
    }
  });
});
