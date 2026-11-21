// MySQL 8.4 / 9.7 真实容器随机闭环验证 + InnoDB 隐式索引/AUTO_INCREMENT/生成列/视图触发器/VECTOR 测试。
import * as E from '@dowel/core';
import { emptyBase, emptyModel, plan, validate } from '@dowel/core';
import { getEngine, stepsChecksum, toScriptSteps } from '@dowel/engines';
import { type ChainVersion, checkDrift, execute, expectOf, markApplied } from '@dowel/executor';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { useMysqlTestDb } from '../../../test/mysql.ts';
import { analyze, verify, verifyScripts } from '../src/index.ts';
import { buildMysqlPair } from './mysql-gen.ts';

describe('MySQL verifier & random roundtrip (8.4 / 9.7)', () => {
  const getDb = useMysqlTestDb('ver_mysql');

  it('verifies up/down closure and frozen verifyScripts across 40 random MySQL schema transitions', async () => {
    const handle = getDb();
    if (!handle) return;

    let totalSteps = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 4, max: 9 }),
        fc.integer({ min: 2, max: 7 }),
        async (seed, initOps, diffOps) => {
          const { from, to } = buildMysqlPair(seed, initOps, diffOps);
          expect(validate(from)).toEqual([]);
          expect(validate(to)).toEqual([]);

          const res = await verify(handle.db, from, to);
          expect(res.upDiff).toEqual([]);
          expect(res.downDiff).toEqual([]);
          totalSteps += res.up.length;

          const upFrozen = toScriptSteps(res.up, 'mysql');
          const downFrozen = toScriptSteps(res.down, 'mysql');
          const frozen = await verifyScripts(handle.db, from, to, upFrozen, downFrozen);
          expect(frozen.upDiff).toEqual([]);
          expect(frozen.downDiff).toEqual([]);
        },
      ),
      { numRuns: 40, seed: 20261121 },
    );
    expect(totalSteps).toBeGreaterThan(20);
  }, 180_000);

  it('closes InnoDB implicit FK index loop across add/drop FK, explicit covering index, and multi-FK scenarios', async () => {
    const handle = getDb();
    if (!handle) return;

    const m0 = emptyModel('mysql');
    const s = E.createSchema(m0, 'default');
    const parent = E.createTable(m0, s, 'parents');
    const pid = E.addColumn(m0, parent, { name: 'id', type: 'bigint', notNull: true });
    E.addPrimaryKey(m0, parent, [pid]);

    const child = E.createTable(m0, s, 'children');
    const cid = E.addColumn(m0, child, { name: 'id', type: 'bigint', notNull: true });
    const pRef = E.addColumn(m0, child, { name: 'parent_id', type: 'bigint', notNull: true });
    E.addPrimaryKey(m0, child, [cid]);

    // 1. 建 FK（无显式索引）-> 删 FK 闭环
    const m1 = structuredClone(m0);
    const fk1 = E.addForeignKey(m1, child, [pRef], parent, [pid], { onDelete: 'cascade' });
    const r01 = await verify(handle.db, m0, m1);
    expect(r01.upDiff).toEqual([]);
    expect(r01.downDiff).toEqual([]);

    // 2. 在已有 FK 上新增显式覆盖索引 -> 撤销索引 闭环
    const m2 = structuredClone(m1);
    const idx = E.addIndex(m2, child, [{ column: pRef }]);
    const r12 = await verify(handle.db, m1, m2);
    expect(r12.upDiff).toEqual([]);
    expect(r12.downDiff).toEqual([]);

    // 3. 在显式索引存在的情况下删 FK -> 恢复 FK 闭环
    const m3 = structuredClone(m2);
    E.dropKey(m3, fk1);
    const r23 = await verify(handle.db, m2, m3);
    expect(r23.upDiff).toEqual([]);
    expect(r23.downDiff).toEqual([]);

    // 4. 在保留 FK 的情况下删掉唯一覆盖显式索引 -> 恢复 闭环
    const m4 = structuredClone(m2);
    E.dropKey(m4, idx);
    const r24 = await verify(handle.db, m2, m4);
    expect(r24.upDiff).toEqual([]);
    expect(r24.downDiff).toEqual([]);

    // 5. 多 FK 演进：v1(fk_z(parent_id)) -> v2(+fk_a(parent_id)) -> v3(-fk_a(parent_id)) 闭环
    const v1 = structuredClone(m0);
    const fkZ = E.addForeignKey(v1, child, [pRef], parent, [pid]);
    E.renameKey(v1, fkZ, 'fk_z');

    const v2 = structuredClone(v1);
    const fkA = E.addForeignKey(v2, child, [pRef], parent, [pid]);
    E.renameKey(v2, fkA, 'fk_a');

    const v3 = structuredClone(v2);
    E.dropKey(v3, fkA);

    const rv12 = await verify(handle.db, v1, v2);
    expect(rv12.upDiff).toEqual([]);
    expect(rv12.downDiff).toEqual([]);
    const rv23 = await verify(handle.db, v2, v3);
    expect(rv23.upDiff).toEqual([]);
    expect(rv23.downDiff).toEqual([]);

    // 6. 前缀重叠多 FK 演进：v1(fk_z(a, b)) -> v2(+fk_a(a)) -> v3(-fk_z(a, b)) 闭环
    const p2Tbl = E.createTable(m0, s, 'p_comp');
    const pa = E.addColumn(m0, p2Tbl, { name: 'a', type: 'bigint', notNull: true });
    const pb = E.addColumn(m0, p2Tbl, { name: 'b', type: 'bigint', notNull: true });
    E.addPrimaryKey(m0, p2Tbl, [pa, pb]);
    E.addUnique(m0, p2Tbl, [pa]);

    const c2Tbl = E.createTable(m0, s, 'c_comp');
    const c2id = E.addColumn(m0, c2Tbl, { name: 'id', type: 'bigint', notNull: true });
    const ca = E.addColumn(m0, c2Tbl, { name: 'a', type: 'bigint', notNull: true });
    const cb = E.addColumn(m0, c2Tbl, { name: 'b', type: 'bigint', notNull: true });
    E.addPrimaryKey(m0, c2Tbl, [c2id]);

    const o1 = structuredClone(m0);
    const oFkZ = E.addForeignKey(o1, c2Tbl, [ca, cb], p2Tbl, [pa, pb]);
    E.renameKey(o1, oFkZ, 'fk_z');
    const o2 = structuredClone(o1);
    const oFkA = E.addForeignKey(o2, c2Tbl, [ca], p2Tbl, [pa]);
    E.renameKey(o2, oFkA, 'fk_a');
    const o3 = structuredClone(o2);
    E.dropKey(o3, oFkZ);

    const ro12 = await verify(handle.db, o1, o2);
    expect(ro12.upDiff).toEqual([]);
    expect(ro12.downDiff).toEqual([]);
    const ro23 = await verify(handle.db, o2, o3);
    expect(ro23.upDiff).toEqual([]);
    expect(ro23.downDiff).toEqual([]);

    // 7. 表级 charset/collation 迁移闭环（保留显式列级 collation，转换继承字符列）
    const cs0 = emptyModel('mysql');
    const sc = E.createSchema(cs0, 'default');
    const tcs = E.createTable(cs0, sc, 'i18n_docs');
    E.setTableExt(cs0, tcs, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' },
    });
    const dId = E.addColumn(cs0, tcs, { name: 'id', type: 'int', notNull: true });
    E.addColumn(cs0, tcs, { name: 'title', type: 'varchar(120)', notNull: true });
    E.addColumn(cs0, tcs, { name: 'code', type: 'varchar(32)', notNull: true, collation: 'utf8mb4_bin' });
    E.addPrimaryKey(cs0, tcs, [dId]);

    const cs1 = structuredClone(cs0);
    E.setTableExt(cs1, tcs, {
      mysql: { engine: 'InnoDB', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci' },
    });
    const rcs = await verify(handle.db, cs0, cs1);
    expect(rcs.upDiff).toEqual([]);
    expect(rcs.downDiff).toEqual([]);
  });

  it('analyzes MySQL ALTER TABLE risk (INSTANT / INPLACE / COPY) and handles VECTOR by version', async () => {
    const handle = getDb();
    if (!handle) return;

    const m0 = emptyModel('mysql');
    const s = E.createSchema(m0, 'default');
    const t = E.createTable(m0, s, 'articles');
    const id = E.addColumn(m0, t, { name: 'id', type: 'int', notNull: true });
    const title = E.addColumn(m0, t, { name: 'title', type: 'varchar(50)', notNull: true });
    E.addPrimaryKey(m0, t, [id]);

    const m1 = structuredClone(m0);
    E.addColumn(m1, t, { name: 'summary', type: 'varchar(200)', notNull: false }); // INSTANT -> low
    E.setColumnType(m1, title, 'bigint'); // COPY -> high
    const steps = plan(m0, m1);
    const risks = await analyze(handle.db, m0, steps);
    expect(risks).toHaveLength(steps.length);
    expect(risks.some((r) => r.level === 'low')).toBe(true);
    expect(risks.some((r) => r.level === 'high' && r.rewrites.includes('articles'))).toBe(true);

    // VECTOR(3)：9.0+ 容器闭环通过，8.4 规划器直接抛出清晰错误
    const mVec = emptyModel('mysql');
    const sv = E.createSchema(mVec, 'default');
    const emb = E.createTable(mVec, sv, 'vectors');
    const eid = E.addColumn(mVec, emb, { name: 'id', type: 'int', notNull: true });
    E.addColumn(mVec, emb, { name: 'embedding', type: 'vector(3)', notNull: true });
    E.addPrimaryKey(mVec, emb, [eid]);
    if (handle.versionNum >= 90000) {
      const rv = await verify(handle.db, emptyBase(mVec, null), mVec);
      expect(rv.upDiff).toEqual([]);
      expect(rv.downDiff).toEqual([]);
    } else {
      expect(() =>
        plan(emptyBase(mVec, null), mVec, getEngine('mysql').planOptionsForVersion?.(handle.versionNum)),
      ).toThrow(/VECTOR/);
    }
  });

  it('executes, rolls back, detects drift, and marks versions end-to-end on MySQL', async () => {
    const handle = getDb();
    if (!handle) return;

    const m1 = emptyModel('mysql');
    const s = E.createSchema(m1, 'default');
    const users = E.createTable(m1, s, 'users');
    const id = E.addColumn(m1, users, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      ext: { mysql: { unsigned: true, autoIncrement: true } },
    });
    const email = E.addColumn(m1, users, { name: 'email', type: 'varchar(191)', notNull: true });
    E.addPrimaryKey(m1, users, [id]);
    E.addUnique(m1, users, [email]);

    const m2 = structuredClone(m1);
    const bio = E.addColumn(m2, users, { name: 'bio', type: 'varchar(255)', notNull: false });
    E.addIndex(m2, users, [{ column: bio }]);

    const m0 = emptyBase(m1, null);
    const up1 = toScriptSteps(plan(m0, m1), 'mysql');
    const down1 = toScriptSteps(plan(m1, m0), 'mysql');
    const up2 = toScriptSteps(plan(m1, m2), 'mysql');
    const down2 = toScriptSteps(plan(m2, m1), 'mysql');

    const chain: ChainVersion[] = [
      {
        id: 'ver-1',
        number: 1,
        parentId: null,
        name: 'init',
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
        name: 'add bio',
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

    await getEngine('mysql').resetShadow(handle.db);
    const rUp = await execute({
      db: handle.db,
      dialect: 'mysql',
      projectId: 'proj-mysql',
      projectName: 'MySQL App',
      instanceId: 'inst-1',
      chain,
      to: 'ver-2',
      executedBy: 'u1',
    });
    expect(rUp.current).toBe('ver-2');
    expect(rUp.ran).toHaveLength(2);

    expect(await checkDrift({ db: handle.db, dialect: 'mysql', projectId: 'proj-mysql', chain })).toEqual({
      status: 'ok',
      version: 'ver-2',
    });

    const rDown = await execute({
      db: handle.db,
      dialect: 'mysql',
      projectId: 'proj-mysql',
      projectName: 'MySQL App',
      instanceId: 'inst-1',
      chain,
      to: 'ver-1',
      direction: 'down',
      executedBy: 'u1',
    });
    expect(rDown.current).toBe('ver-1');

    await handle.db.exec('CREATE TABLE `rogue_tbl` (`id` INT PRIMARY KEY)');
    const drifted = await checkDrift({ db: handle.db, dialect: 'mysql', projectId: 'proj-mysql', chain });
    expect(drifted.status).toBe('drifted');
    await handle.db.exec('DROP TABLE `rogue_tbl`');

    for (const st of up2) await handle.db.exec(st.sql);
    const preview = await markApplied({
      db: handle.db,
      dialect: 'mysql',
      projectId: 'proj-mysql',
      projectName: 'MySQL App',
      instanceId: 'inst-1',
      chain,
      to: 'ver-2',
      dryRun: true,
      executedBy: 'u1',
    });
    const marked = await markApplied({
      db: handle.db,
      dialect: 'mysql',
      projectId: 'proj-mysql',
      projectName: 'MySQL App',
      instanceId: 'inst-1',
      chain,
      to: 'ver-2',
      acknowledge: true,
      expect: expectOf(preview.plan),
      executedBy: 'u1',
    });
    expect(marked.plan.direction).toBe('forward');
    expect(marked.runId).not.toBeNull();
  });
});
