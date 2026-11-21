// MSSQL fast-check 随机闭环验证（支持 MSSQL_VERSION=2019|2022|2025）：
// 覆盖多 schema、建删改表/列、带名 DEFAULT 约束、计算列、外键、CHECK、CLUSTERED & filtered & INCLUDE 索引、
// 序列、MS_Description 注释、verifyScripts 冻结脚本闭环及执行器端到端闭环。
import * as E from '@dowel/core';
import { emptyBase, emptyModel, plan, validate } from '@dowel/core';
import { stepsChecksum, toScriptSteps } from '@dowel/engines';
import { type ChainVersion, checkDrift, execute, markApplied } from '@dowel/executor';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTestMssqlDb, getMssqlAdminUrl, MSSQL_VERSION } from '../../../test/mssql.ts';
import { analyze, verify, verifyScripts } from '../src/index.ts';
import { buildMssqlPair } from './mssql-gen.ts';

describe(`MSSQL (${MSSQL_VERSION}) fast-check random roundtrip`, () => {
  let adminUrl: string | null = null;

  beforeAll(async () => {
    adminUrl = await getMssqlAdminUrl();
  }, 120_000);

  it('verifies up/down closure and frozen verifyScripts over random MSSQL schema transitions', async () => {
    if (!adminUrl) return;
    const shadow = await createTestMssqlDb('mssql_rnd');
    let totalSteps = 0;
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 3, max: 8 }),
          fc.integer({ min: 2, max: 6 }),
          async (seed, initOps, diffOps) => {
            const { from, to } = buildMssqlPair(seed, initOps, diffOps);
            expect(validate(from)).toEqual([]);
            expect(validate(to)).toEqual([]);

            const res = await verify(shadow.db, from, to);
            expect(res.upDiff).toEqual([]);
            expect(res.downDiff).toEqual([]);
            totalSteps += res.up.length;

            const upFrozen = toScriptSteps(res.up, 'mssql');
            const downFrozen = toScriptSteps(res.down, 'mssql');
            const frozenRes = await verifyScripts(shadow.db, from, to, upFrozen, downFrozen);
            expect(frozenRes.upDiff).toEqual([]);
            expect(frozenRes.downDiff).toEqual([]);
          },
        ),
        { numRuns: 25, seed: 20261121 },
      );
      expect(totalSteps).toBeGreaterThan(20);
    } finally {
      await shadow.close();
    }
  }, 240_000);

  it('executes, rolls back, re-executes, detects drift, and marks versions end-to-end on MSSQL', async () => {
    if (!adminUrl) return;
    const { from: m1, to: m2 } = buildMssqlPair(98765, 6, 5);
    const m0 = emptyBase(m1, null);

    const up1 = toScriptSteps(plan(m0, m1), 'mssql');
    const down1 = toScriptSteps(plan(m1, m0), 'mssql');
    const up2 = toScriptSteps(plan(m1, m2), 'mssql');
    const down2 = toScriptSteps(plan(m2, m1), 'mssql');

    const chain: ChainVersion[] = [
      {
        id: 'ver-1',
        number: 1,
        parentId: null,
        name: 'initial',
        model: m1,
        upSteps: up1,
        downSteps: down1,
        checksum: stepsChecksum(up1, down1),
        verified: true,
        publishedAt: new Date().toISOString(),
        publishedBy: 'tester',
        scope: null,
      },
      {
        id: 'ver-2',
        number: 2,
        parentId: 'ver-1',
        name: 'evolve',
        model: m2,
        upSteps: up2,
        downSteps: down2,
        checksum: stepsChecksum(up2, down2),
        verified: true,
        publishedAt: new Date().toISOString(),
        publishedBy: 'tester',
        scope: null,
      },
    ];

    const shadow = await createTestMssqlDb('mssql_risk');
    try {
      const risks = await analyze(shadow.db, m1, plan(m1, m2));
      expect(risks).toHaveLength(up2.length);
    } finally {
      await shadow.close();
    }

    const target = await createTestMssqlDb('mssql_exec_e2e');
    try {
      const rUp = await execute({
        db: target.db,
        dialect: 'mssql',
        projectId: 'proj-mssql',
        projectName: 'MSSQL App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-2',
        executedBy: 'u1',
      });
      expect(rUp.current).toBe('ver-2');
      expect(rUp.ran).toHaveLength(2);

      expect(await checkDrift({ db: target.db, dialect: 'mssql', projectId: 'proj-mssql', chain })).toEqual({
        status: 'ok',
        version: 'ver-2',
      });

      const rDown = await execute({
        db: target.db,
        dialect: 'mssql',
        projectId: 'proj-mssql',
        projectName: 'MSSQL App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-1',
        direction: 'down',
        executedBy: 'u1',
      });
      expect(rDown.current).toBe('ver-1');

      const rUpAgain = await execute({
        db: target.db,
        dialect: 'mssql',
        projectId: 'proj-mssql',
        projectName: 'MSSQL App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-2',
        executedBy: 'u1',
      });
      expect(rUpAgain.current).toBe('ver-2');

      // 人为制造漂移
      await target.db.exec('CREATE TABLE [dbo].[rogue_table] ([x] int NOT NULL PRIMARY KEY)');
      const drifted = await checkDrift({ db: target.db, dialect: 'mssql', projectId: 'proj-mssql', chain });
      expect(drifted.status).toBe('drifted');

      await target.db.exec('DROP TABLE [dbo].[rogue_table]');
      for (const s of down2) await target.db.exec(s.sql);

      const marked = await markApplied({
        db: target.db,
        dialect: 'mssql',
        projectId: 'proj-mssql',
        projectName: 'MSSQL App',
        instanceId: 'inst-1',
        chain,
        to: 'ver-1',
        executedBy: 'u1',
      });
      expect(marked.plan.direction).toBe('backward');
      expect(marked.runId).not.toBeNull();
    } finally {
      await target.close();
    }
  }, 180_000);

  it('supports SQL Server 2025 native json and vector(n) roundtrip when MSSQL_VERSION=2025', async () => {
    if (!adminUrl || MSSQL_VERSION !== '2025') return;
    const shadow = await createTestMssqlDb('mssql_2025');
    try {
      const m0 = emptyModel('mssql');
      const dbo = E.createSchema(m0, 'dbo');
      const t = E.createTable(m0, dbo, 'docs');
      const id = E.addColumn(m0, t, { name: 'id', type: 'int', notNull: true });
      E.addPrimaryKey(m0, t, [id]);

      const m1 = structuredClone(m0);
      E.addColumn(m1, t, { name: 'meta', type: 'json' });
      E.addColumn(m1, t, { name: 'embedding', type: 'vector(3)' });

      const res = await verify(shadow.db, m0, m1);
      expect(res.upDiff).toEqual([]);
      expect(res.downDiff).toEqual([]);
    } finally {
      await shadow.close();
    }
  }, 120_000);
});
