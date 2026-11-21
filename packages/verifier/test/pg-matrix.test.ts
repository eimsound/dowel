// PostgreSQL 15–19 多版本矩阵闭环验证测试。
// 通过环境变量 DOWEL_PG_IMAGE=pgvector/pgvector:pg15|pg16|pg17|pg18|pg19 在不同版本容器上运行，
// 验证版本探测、跨版本冻结脚本验证、域 NOT NULL 往返、NULLS NOT DISTINCT、生成列、风险分析与漂移比对。
import {
  addColumn,
  addPrimaryKey,
  addUnique,
  createSchema,
  createTable,
  emptyModel,
  MIN_PG_MAJOR,
  PlanError,
  plan,
  setNotNull,
} from '@dowel/core';
import { diffSnapshots, importSnapshot, readSnapshot, toScriptSteps } from '@dowel/engines';
import { diffAgainst } from '@dowel/executor';
import { describe, expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { analyze, build, readShadowPgMajor, resetShadow, verify, verifyScripts } from '../src/index.ts';

const conn = useTestDb('pg_matrix');

const baseModel = () => {
  const m = emptyModel();
  const pub = createSchema(m, 'public');
  return { m, pub };
};

describe.skipIf(!PG_URL)('PG 15–19 多版本矩阵验证', () => {
  test('自动探测影子库 PG 大版本', async () => {
    const major = await readShadowPgMajor(conn());
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(MIN_PG_MAJOR);
  });

  test('NOT NULL 建表、增删 NOT NULL 迁移与风险分析适配当前 PG 版本', async () => {
    const db = conn();
    const major = (await readShadowPgMajor(db))!;

    const { m: m1, pub } = baseModel();
    const t = createTable(m1, pub, 'orders');
    const id = addColumn(m1, t, { name: 'id', type: 'bigint', notNull: true, identity: { always: false } });
    addPrimaryKey(m1, t, [id]);
    const code = addColumn(m1, t, { name: 'code', type: 'text', notNull: false });

    const m2 = structuredClone(m1);
    setNotNull(m2, code, true);
    addUnique(m2, t, [code], true);
    addColumn(m2, t, {
      name: 'code_upper',
      type: 'text',
      generated: { expr: 'upper(code)', stored: true },
    });

    const r = await verify(db, m1, m2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);

    if (major < 18) {
      expect(r.up.some((s) => /ADD CONSTRAINT .* NOT NULL/i.test(s.sql))).toBe(false);
      expect(r.up.some((s) => /ALTER COLUMN .* SET NOT NULL/i.test(s.sql))).toBe(true);
    }

    const risks = await analyze(db, m1, r.up);
    expect(risks).toHaveLength(r.up.length);
  });

  test('按 PG 15 冻结的迁移脚本可在 PG 15–19 任意容器闭环验证通过', async () => {
    const db = conn();
    const { m: m1, pub } = baseModel();
    const t = createTable(m1, pub, 'users');
    const id = addColumn(m1, t, { name: 'id', type: 'int', notNull: true });
    addPrimaryKey(m1, t, [id]);

    const m2 = structuredClone(m1);
    const email = addColumn(m2, t, { name: 'email', type: 'text', notNull: true });
    addUnique(m2, t, [email], true);

    // 模拟项目最低环境为 PG 15：冻结脚本严格按 PG 15 规划（不发 CONSTRAINT ... NOT NULL）
    const up = toScriptSteps(plan(m1, m2, { pgMajor: 15 }));
    const down = toScriptSteps(plan(m2, m1, { pgMajor: 15 }));
    expect(up.some((s) => /CONSTRAINT .* NOT NULL/i.test(s.sql))).toBe(false);

    // verifyScripts 建 from/to 基准库自动适配当前容器 PG 版本，执行冻结脚本本身
    const r = await verifyScripts(db, m1, m2, up, down);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('CREATE DOMAIN ... NOT NULL 在 PG 15/16 与 PG 17+ 均往返一致', async () => {
    const db = conn();
    await resetShadow(db);
    await db.exec('CREATE SCHEMA public');
    await db.exec(`
      SET search_path = public;
      CREATE DOMAIN pos_amount AS numeric(12, 2) NOT NULL DEFAULT 0 CHECK (VALUE >= 0);
      CREATE TABLE invoices (
        id int PRIMARY KEY,
        amount pos_amount
      );
    `);
    const s1 = await readSnapshot(db);
    const domain = Object.values(s1.opaques).find((o) => o.objType === 'domain' && o.name === 'pos_amount');
    expect(domain).toBeDefined();
    expect(domain!.ddl[0]).toMatch(/\bNOT\s+NULL\b/i);

    const m = importSnapshot(s1);
    const s2 = await build(db, m);
    expect(diffSnapshots(s1, s2)).toEqual([]);
  });

  test('VIRTUAL 生成列在 PG 18+ 往返通过，且对 PG < 18 目标被静态拦截', async () => {
    const db = conn();
    const major = (await readShadowPgMajor(db))!;
    const { m: m1, pub } = baseModel();
    const t = createTable(m1, pub, 'products');
    const id = addColumn(m1, t, { name: 'id', type: 'int', notNull: true });
    addPrimaryKey(m1, t, [id]);
    addColumn(m1, t, { name: 'price', type: 'int', notNull: true });

    const m2 = structuredClone(m1);
    addColumn(m2, t, {
      name: 'double_price',
      type: 'int',
      generated: { expr: 'price * 2', stored: false },
    });

    // 目标 PG 17 / 16 / 15 必须直接抛 PlanError
    expect(() => plan(m1, m2, { pgMajor: 17 })).toThrow(PlanError);
    expect(() => plan(m1, m2, { pgMajor: 15 })).toThrow(PlanError);

    if (major >= 18) {
      const r = await verify(db, m1, m2);
      expect(r.upDiff).toEqual([]);
      expect(r.downDiff).toEqual([]);
    }
  });

  test('executor diffAgainst 从 snapshot.version 推导 PG 大版本生成贴合版本的修复脚本', async () => {
    const db = conn();
    const major = (await readShadowPgMajor(db))!;

    const { m: target, pub } = baseModel();
    const t = createTable(target, pub, 'items');
    const id = addColumn(target, t, { name: 'id', type: 'int', notNull: true });
    addPrimaryKey(target, t, [id]);
    addColumn(target, t, { name: 'title', type: 'text', notNull: true });

    // 线上库少一个 not null 约束
    const live = structuredClone(target);
    const titleCol = Object.values(live.objects).find((o) => o.kind === 'column' && o.name === 'title')!;
    setNotNull(live, titleCol.id, false);

    const liveSnap = await build(db, live);
    const diff = diffAgainst(liveSnap, target);
    expect(diff.total).toBeGreaterThan(0);
    if (major < 18) {
      expect(diff.items.some((s) => /ADD CONSTRAINT .* NOT NULL/i.test(s.sql))).toBe(false);
      expect(diff.items.some((s) => /SET NOT NULL/i.test(s.sql))).toBe(true);
    }
  });
});
