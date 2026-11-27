// PostgreSQL 15–19 多版本矩阵闭环验证测试。
// 通过环境变量 DOWEL_PG_IMAGE=pgvector/pgvector:pg15|pg16|pg17|pg18|pg19 在不同版本容器上运行，
// 验证版本探测、跨版本冻结脚本验证、域 NOT NULL 往返、NULLS NOT DISTINCT、生成列、风险分析与漂移比对。
import {
  addColumn,
  addPrimaryKey,
  addUnique,
  createEnum,
  createSchema,
  createTable,
  emptyModel,
  type Enum,
  MIN_PG_MAJOR,
  type Model,
  type Opaque,
  pgMajorOf,
  PlanError,
  plan,
  renameColumn,
  renameEnum,
  renameTable,
  setNotNull,
} from '@dowel/core';
import {
  type Db,
  diffSnapshots,
  getEngine,
  importSnapshot,
  readSnapshot,
  toScriptSteps,
} from '@dowel/engines';
import { diffAgainst, importLive, planDiff } from '@dowel/executor';
import { describe, expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { analyze, build, resetShadow, runSteps, verify, verifyScripts } from '../src/index.ts';

const conn = useTestDb('pg_matrix');

/** 从 PG 影子库读取 server_version_num 并提取大版本号（测试本地工具） */
const readTestPgMajor = async (db: Db): Promise<number | null> => {
  const vNum = await getEngine('pg').readVersionNum?.(db);
  return vNum !== null && vNum !== undefined ? pgMajorOf(vNum) : null;
};

const baseModel = () => {
  const m = emptyModel();
  const pub = createSchema(m, 'public');
  return { m, pub };
};

describe.skipIf(!PG_URL)('PG 15–19 多版本矩阵验证', () => {
  test('自动探测影子库 PG 大版本', async () => {
    const major = await readTestPgMajor(conn());
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(MIN_PG_MAJOR);
  });

  test('NOT NULL 建表、增删 NOT NULL 迁移与风险分析适配当前 PG 版本', async () => {
    const db = conn();
    const major = (await readTestPgMajor(db))!;

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
    const major = (await readTestPgMajor(db))!;
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
    const major = (await readTestPgMajor(db))!;
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
    const major = (await readTestPgMajor(db))!;

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

// #160：两个枚举对调名字、轮换、删后重建同名枚举时，引用它们的表达式对象要按新版本模型绑定（PG 按 OID 绑定类型）
describe.skipIf(!PG_URL)('PG 枚举换绑定时重建依赖对象（#160）', () => {
  const DDL = `
    SET search_path = public;
    CREATE TYPE mood AS ENUM ('ok', 'sad');
    CREATE TYPE tone AS ENUM ('ok', 'sad', 'meh');
    CREATE TABLE t (
      id int PRIMARY KEY,
      k text DEFAULT ('ok'::mood)::text,
      g boolean GENERATED ALWAYS AS ('ok'::mood < 'sad'::mood) STORED,
      CONSTRAINT t_mood_check CHECK ('ok'::mood IS NOT NULL)
    );
    CREATE INDEX t_part ON t (id) WHERE ('ok'::mood IS NOT NULL);
    CREATE INDEX t_expr ON t ((('ok'::mood < 'sad'::mood)));
    CREATE VIEW v AS SELECT 'ok'::mood AS x;
    RESET search_path;
  `;
  const load = async (db: Db): Promise<Model> => {
    await resetShadow(db);
    await db.exec('CREATE SCHEMA public');
    await db.exec(DDL);
    return importSnapshot(await readSnapshot(db));
  };
  const enumId = (m: Model, name: string) =>
    Object.values(m.objects).find((o): o is Enum => o.kind === 'enum' && o.name === name)!.id;
  const view = (m: Model) => Object.values(m.objects).find((o): o is Opaque => o.kind === 'opaque')!;
  /** 各依赖对象在库里实际绑定的枚举：名字与值（按 pg_depend 查 OID，不看表达式文本） */
  const boundEnums = async (db: Db) =>
    db.query<{ what: string; typ: string; labels: string }>(`
      SELECT CASE d.classid
               WHEN 'pg_constraint'::regclass THEN 'check'
               WHEN 'pg_attrdef'::regclass THEN 'default'
               WHEN 'pg_rewrite'::regclass THEN 'view'
               ELSE (SELECT relname FROM pg_class WHERE oid = d.objid) || ':' || d.objsubid
             END AS what,
             t.typname AS typ,
             (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = t.oid) AS labels
        FROM pg_depend d JOIN pg_type t ON t.oid = d.refobjid
       WHERE d.refclassid = 'pg_type'::regclass AND t.typtype = 'e' AND d.deptype = 'n'
       ORDER BY 1`);

  test('两个枚举对调名字：迁移后 CHECK / 默认值 / 部分索引 / 表达式索引 / 生成列 / 视图都绑定到模型所写的枚举，数据保留，回滚复原', async () => {
    const db = conn();
    const m1 = await load(db);
    const before = await boundEnums(db);
    expect(new Set(before.map((r) => `${r.typ}=${r.labels}`))).toEqual(new Set(['mood=ok,sad']));
    const m2 = structuredClone(m1);
    const e1 = enumId(m1, 'mood');
    const e2 = enumId(m1, 'tone');
    (m2.objects[e1] as Enum).name = 'tone';
    (m2.objects[e2] as Enum).name = 'mood';
    // 视图按依赖的 ID 表达绑定：新版本里它依赖的是现在叫 mood 的那个枚举
    view(m2).deps = view(m2).deps.map((d) => (d === e1 ? e2 : d));

    const r = await verify(db, m1, m2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);

    await build(db, m1);
    await db.exec(`INSERT INTO public.t (id) VALUES (1), (2)`);
    await runSteps(db, plan(m1, m2));
    const after = await boundEnums(db);
    expect(after.length).toBe(before.length);
    // 名字仍是 mood，但绑定的是原来的 tone（三个值）
    expect(new Set(after.map((r) => `${r.typ}=${r.labels}`))).toEqual(new Set(['mood=ok,sad,meh']));
    expect(await db.query(`SELECT id, k, g FROM public.t ORDER BY id`)).toEqual([
      { id: 1, k: 'ok', g: true },
      { id: 2, k: 'ok', g: true },
    ]);
    const def = await db.query<{ d: string }>(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 't_mood_check'`,
    );
    expect(def[0]!.d).toMatch(/'ok'::(public\.)?mood/);

    await runSteps(db, plan(m2, m1));
    expect(new Set((await boundEnums(db)).map((r) => `${r.typ}=${r.labels}`))).toEqual(
      new Set(['mood=ok,sad']),
    );
    expect((await db.query(`SELECT count(*)::int AS n FROM public.t`))[0]).toEqual({ n: 2 });
  });

  test('三个枚举轮换名字：闭环验证通过', async () => {
    const db = conn();
    const m1 = await load(db);
    createEnum(m1, Object.values(m1.objects).find((o) => o.kind === 'schema')!.id, 'hue', ['ok', 'sad']);
    const m2 = structuredClone(m1);
    const [e1, e2, e3] = [enumId(m1, 'mood'), enumId(m1, 'tone'), enumId(m1, 'hue')];
    (m2.objects[e1] as Enum).name = 'tone';
    (m2.objects[e2] as Enum).name = 'hue';
    (m2.objects[e3] as Enum).name = 'mood';
    view(m2).deps = view(m2).deps.map((d) => (d === e1 ? e3 : d));
    const r = await verify(db, m1, m2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('只是改名（表达式跟着改写）：不重建任何对象，闭环验证通过', async () => {
    const db = conn();
    const m1 = await load(db);
    const m2 = structuredClone(m1);
    renameEnum(m2, enumId(m1, 'mood'), 'feeling');
    // 视图 DDL 由规范化读回，这里手工写成改名后的样子
    view(m2).ddl = view(m2).ddl.map((x) => x.replaceAll('public.mood', 'public.feeling'));
    const r = await verify(db, m1, m2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
    expect(r.up.filter((s) => !/^(ALTER TYPE|DROP VIEW|CREATE VIEW)/.test(s.sql))).toEqual([]);
  });

  test('删掉枚举再建同名枚举（只被表达式引用）：迁移成功执行，依赖对象绑定到新类型，回滚复原', async () => {
    const db = conn();
    const m1 = await load(db);
    const m2 = structuredClone(m1);
    const e1 = enumId(m1, 'mood');
    const sch = (m1.objects[e1] as Enum).parent;
    delete m2.objects[e1];
    const e9 = createEnum(m2, sch, 'mood', ['ok', 'sad', 'new']);
    view(m2).deps = view(m2).deps.map((d) => (d === e1 ? e9 : d));

    const r = await verify(db, m1, m2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);

    await build(db, m1);
    await db.exec(`INSERT INTO public.t (id) VALUES (1)`);
    await runSteps(db, plan(m1, m2));
    expect(new Set((await boundEnums(db)).map((r) => `${r.typ}=${r.labels}`))).toEqual(
      new Set(['mood=ok,sad,new']),
    );
    expect(await db.query(`SELECT id, k, g FROM public.t`)).toEqual([{ id: 1, k: 'ok', g: true }]);
    await runSteps(db, plan(m2, m1));
    expect(new Set((await boundEnums(db)).map((r) => `${r.typ}=${r.labels}`))).toEqual(
      new Set(['mood=ok,sad']),
    );
  });
});
