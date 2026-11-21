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
  renameColumn,
  renameTable,
  setNotNull,
} from '@dowel/core';
import { diffSnapshots, importSnapshot, readSnapshot, toScriptSteps } from '@dowel/engines';
import { diffAgainst, importLive, planDiff } from '@dowel/executor';
import { describe, expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import {
  analyze,
  build,
  readShadowPgMajor,
  resetShadow,
  runSteps,
  verify,
  verifyScripts,
} from '../src/index.ts';

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

  test('按 PG 15 冻结含 renameTable / renameColumn（含 NOT NULL 列）的迁移脚本在 PG 15–19 验证通过且零漂移', async () => {
    const db = conn();
    const major = (await readShadowPgMajor(db))!;
    const { m: m1, pub } = baseModel();
    const t = createTable(m1, pub, 'legacy_orders');
    const id = addColumn(m1, t, { name: 'id', type: 'integer', notNull: true });
    addPrimaryKey(m1, t, [id]);
    const oldCol = addColumn(m1, t, { name: 'buyer_email', type: 'text', notNull: true });

    const m2 = structuredClone(m1);
    renameTable(m2, t, 'orders');
    renameColumn(m2, oldCol, 'customer_email');

    // 按 PG 15 冻结：不含 PG 18+ 的 RENAME CONSTRAINT ... NOT NULL
    const upSteps = plan(m1, m2, { pgMajor: 15 });
    const downSteps = plan(m2, m1, { pgMajor: 15 });
    expect(upSteps.some((s) => /RENAME CONSTRAINT .*not_null/i.test(s.sql))).toBe(false);

    // 1) verifyScripts 在 PG 15–19（尤其 PG 18/19）不得报 derived notNullName 假阴，且返回实测 shadowMajor
    const r = await verifyScripts(db, m1, m2, toScriptSteps(upSteps), toScriptSteps(downSteps));
    expect(r.shadowMajor).toBe(major);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);

    // 2) verify(db, m1, m2, { pgMajor: 15 }) 跨版本预览验证也必须通过
    const vr = await verify(db, m1, m2, { pgMajor: 15 });
    expect(vr.shadowMajor).toBe(major);
    expect(vr.upDiff).toEqual([]);
    expect(vr.downDiff).toEqual([]);

    // 3) 模拟线上执行按 PG 15 冻结的 up 脚本，执行器 diffAgainst 与 importLive（pull 链路）必须零漂移且不污染 explicit 约束名
    await build(db, m1);
    await runSteps(db, upSteps);
    const afterUpSnap = await readSnapshot(db);
    expect(diffAgainst(afterUpSnap, m2)).toEqual({ total: 0, items: [] });
    const pulled = importLive(afterUpSnap, m2);
    expect(planDiff(m2, pulled, { pgMajor: 15 })).toEqual({ total: 0, items: [] });

    // 4) 模拟从 PG 15–17 导入的模型（notNullName: null, notNullNameMode: 'explicit'）改表名/列名后在 PG 15–19 验证与拉取
    const imported15 = structuredClone(m1);
    for (const o of Object.values(imported15.objects)) {
      if (o.kind === 'column' && o.notNull) {
        o.notNullName = null;
        o.notNullNameMode = 'explicit';
      }
    }
    const imported15Next = structuredClone(imported15);
    renameTable(imported15Next, t, 'orders');
    renameColumn(imported15Next, oldCol, 'customer_email');
    const up15 = plan(imported15, imported15Next, { pgMajor: 15 });
    const down15 = plan(imported15Next, imported15, { pgMajor: 15 });
    const r15 = await verifyScripts(
      db,
      imported15,
      imported15Next,
      toScriptSteps(up15),
      toScriptSteps(down15),
    );
    expect(r15.upDiff).toEqual([]);
    expect(r15.downDiff).toEqual([]);
    const vr15 = await verify(db, imported15, imported15Next, { pgMajor: 15 });
    expect(vr15.upDiff).toEqual([]);
    expect(vr15.downDiff).toEqual([]);
    await build(db, imported15);
    await runSteps(db, up15);
    const after15Snap = await readSnapshot(db);
    expect(diffAgainst(after15Snap, imported15Next)).toEqual({ total: 0, items: [] });
    const pulled15 = importLive(after15Snap, imported15Next);
    expect(planDiff(imported15Next, pulled15, { pgMajor: 15 })).toEqual({ total: 0, items: [] });
  });

  test('CREATE DOMAIN ... NOT NULL 与 CHECK (VALUE IS NOT NULL) 在 PG 15–19 产出一致 DDL 且往返通过', async () => {
    const db = conn();
    await resetShadow(db);
    await db.exec('CREATE SCHEMA public');
    await db.exec(`
      SET search_path = public;
      CREATE DOMAIN pos_int AS integer NOT NULL;
      CREATE DOMAIN non_null_text AS text NOT NULL CHECK (VALUE IS NOT NULL);
      CREATE DOMAIN pos_amount AS numeric(12, 2) NOT NULL DEFAULT 0 CHECK (VALUE >= 0);
      CREATE TABLE invoices (
        id int PRIMARY KEY,
        qty pos_int,
        note non_null_text,
        amount pos_amount
      );
    `);
    const s1 = await readSnapshot(db);
    const posInt = Object.values(s1.opaques).find((o) => o.objType === 'domain' && o.name === 'pos_int');
    const nonNullText = Object.values(s1.opaques).find(
      (o) => o.objType === 'domain' && o.name === 'non_null_text',
    );
    const posAmount = Object.values(s1.opaques).find(
      (o) => o.objType === 'domain' && o.name === 'pos_amount',
    );
    expect(posInt?.ddl[0]).toBe('CREATE DOMAIN public.pos_int AS integer NOT NULL');
    expect(nonNullText?.ddl[0]).toBe(
      'CREATE DOMAIN public.non_null_text AS text NOT NULL CONSTRAINT non_null_text_check CHECK ((VALUE IS NOT NULL))',
    );
    expect(posAmount?.ddl[0]).toBe(
      'CREATE DOMAIN public.pos_amount AS numeric(12,2) DEFAULT 0 NOT NULL CONSTRAINT pos_amount_check CHECK ((VALUE >= (0)::numeric))',
    );

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
    const id = addColumn(target, t, { name: 'id', type: 'integer', notNull: true });
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
