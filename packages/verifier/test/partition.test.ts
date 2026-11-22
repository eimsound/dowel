// 分区表专项 PG 闭环与往返测试：RANGE / LIST / HASH、多列/表达式键、DEFAULT、
// 父表列与默认值级联子分区、Attach/Detach、改边界、删除父表级联、多级分区往返、存量 string partitionBy 升级。
import * as E from '@dowel/core';
import { createAll, emptyModel, plan, validate } from '@dowel/core';
import { diffSnapshots, importSnapshot, readSnapshot, reconcileIds } from '@dowel/engines';
import { describe, expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, resetShadow, runSteps, verify } from '../src/index.ts';

const conn = useTestDb('partition');

test('importSnapshot：子分区在 snap.tables 中排在根父表之前时不崩溃且正确推导子分区索引名', () => {
  const m = importSnapshot({
    version: 180000,
    schemas: { public: { comment: null } },
    extensions: {},
    opaques: {},
    enums: {},
    sequences: {},
    tables: {
      'public.a_child': {
        schema: 'public',
        name: 'a_child',
        comment: null,
        columns: {
          day: {
            attnum: 1,
            type: 'integer',
            enumType: null,
            notNull: true,
            notNullName: 'z_parent_day_not_null',
            default: null,
            identity: null,
            generated: null,
            collation: null,
            comment: null,
            inherited: true,
          },
        },
        constraints: {},
        indexes: {
          a_child_day_idx: {
            unique: false,
            method: 'btree',
            elements: [
              { column: 'day', expr: null, desc: false, nullsFirst: false, opclass: null, collation: null },
            ],
            include: [],
            where: null,
            nullsNotDistinct: false,
            comment: null,
          },
        },
        partitionBy: null,
        partitionSpec: null,
        partitionOf: { parent: 'public.z_parent', bound: 'FOR VALUES FROM (0) TO (10)' },
      },
      'public.z_parent': {
        schema: 'public',
        name: 'z_parent',
        comment: null,
        columns: {
          day: {
            attnum: 1,
            type: 'integer',
            enumType: null,
            notNull: true,
            notNullName: 'z_parent_day_not_null',
            default: null,
            identity: null,
            generated: null,
            collation: null,
            comment: null,
            inherited: false,
          },
        },
        constraints: {},
        indexes: {},
        partitionBy: 'RANGE (day)',
        partitionSpec: {
          strategy: 'range',
          keys: [{ column: 'day', expr: null, opclass: null, collation: null }],
        },
        partitionOf: null,
      },
    },
  });
  expect(validate(m)).toEqual([]);
  const idx = E.all(m, 'index').find((i) => i.name === 'a_child_day_idx');
  expect(idx?.nameMode).toBe('derived');
});

const roundtrip = async (ddl: string) => {
  const db = conn();
  await resetShadow(db);
  await db.exec('CREATE SCHEMA public');
  await db.exec(`SET search_path = public; ${ddl}`);
  const s1 = await readSnapshot(db);
  const m = importSnapshot(s1);
  expect(validate(m)).toEqual([]);
  expect(plan(m, m)).toEqual([]);
  const s2 = await build(db, m);
  expect(diffSnapshots(s1, s2)).toEqual([]);
  return { m, s1 };
};

describe.skipIf(!PG_URL)('PG 分区表闭环与往返验证', () => {
  test('RANGE / LIST / HASH + 多列键 + 表达式键 + collation/opclass + DEFAULT 往返一致', async () => {
    const { m } = await roundtrip(`
      CREATE TABLE r_multi (
        tenant_id integer NOT NULL,
        created_at date NOT NULL,
        note text DEFAULT 'init',
        PRIMARY KEY (tenant_id, created_at)
      ) PARTITION BY RANGE (tenant_id, created_at);
      CREATE TABLE r_multi_1 PARTITION OF r_multi FOR VALUES FROM (1, MINVALUE) TO (100, '2025-01-01');
      CREATE TABLE r_multi_2 PARTITION OF r_multi FOR VALUES FROM (100, '2025-01-01') TO (MAXVALUE, MAXVALUE);
      CREATE TABLE r_multi_def PARTITION OF r_multi DEFAULT;

      CREATE TABLE l_region (
        code text NOT NULL,
        payload text
      ) PARTITION BY LIST (lower(code) COLLATE "C");
      CREATE INDEX l_region_idx ON l_region ((lower(code)));
      CREATE TABLE l_region_us PARTITION OF l_region FOR VALUES IN ('us', 'ca');
      CREATE TABLE l_region_def PARTITION OF l_region DEFAULT;

      CREATE TABLE h_items (
        id bigint NOT NULL,
        val integer NOT NULL DEFAULT 0,
        PRIMARY KEY (id)
      ) PARTITION BY HASH (id);
      CREATE TABLE h_items_0 PARTITION OF h_items FOR VALUES WITH (modulus 2, remainder 0);
      CREATE TABLE h_items_1 PARTITION OF h_items FOR VALUES WITH (modulus 2, remainder 1);
    `);

    // 子分区在 IR 中不再存储冗余列
    const children = E.all(m, 'table').filter((t) => t.partitionOf !== null);
    expect(children.length).toBe(7);
    for (const ch of children) {
      expect(E.columnsOf(m, ch.id)).toEqual([]);
    }
    // 父表均导入为结构化 PartitionSpec
    const parents = E.all(m, 'table').filter((t) => t.partitionBy !== null);
    expect(parents.length).toBe(3);
    for (const p of parents) {
      expect(typeof p.partitionBy).toBe('object');
    }
  });

  test('父表增删改列与 SET/DROP DEFAULT 级联子分区闭环通过', async () => {
    const db = conn();
    const from = emptyModel();
    const s = E.createSchema(from, 'public');
    const p = E.createTable(from, s, 'events');
    const cId = E.addColumn(from, p, { name: 'id', type: 'bigint', notNull: true });
    const cDay = E.addColumn(from, p, { name: 'day', type: 'integer', notNull: true });
    const cStatus = E.addColumn(from, p, {
      name: 'status',
      type: 'text',
      notNull: true,
      default: { expr: "'open'::text" },
    });
    const cScore = E.addColumn(from, p, { name: 'score', type: 'integer' });
    E.setPartitionBy(from, p, {
      strategy: 'range',
      keys: [{ column: cDay, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(from, p, [cId, cDay]);
    E.addCheck(from, p, '(day >= 0)');
    E.addIndex(from, p, [{ column: cStatus }]);
    const ch1 = E.createPartition(from, p, 'events_1', 'FOR VALUES FROM (0) TO (100)');
    const ch2 = E.createPartition(from, p, 'events_2', 'FOR VALUES FROM (100) TO (200)');

    const to = structuredClone(from);
    // 1. 改父表默认值（须级联子分区）
    E.setDefault(to, cStatus, { expr: "'pending'::text" });
    E.setDefault(to, cScore, { expr: '10' });
    // 2. 改非分区键列类型、重命名、新增列
    E.setColumnType(to, cScore, 'bigint');
    E.renameColumn(to, cStatus, 'state');
    E.addColumn(to, p, { name: 'tag', type: 'text', default: { expr: "'v1'::text" } });
    // 3. 子分区重命名、加注释、新增 DEFAULT 子分区
    E.renameTable(to, ch1, 'events_p1');
    E.setComment(to, ch2, '第二分区');
    E.createPartition(to, p, 'events_default', 'DEFAULT');

    expect(validate(to)).toEqual([]);
    const r = await verify(db, from, to);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);

    // 反向测试 DROP DEFAULT 级联子分区
    const to2 = structuredClone(to);
    E.setDefault(to2, cStatus, null);
    E.setDefault(to2, cScore, null);
    const r2 = await verify(db, to, to2);
    expect(r2.upDiff).toEqual([]);
    expect(r2.downDiff).toEqual([]);
  });

  test('Attach / Detach / 改边界 / 互换边界 / 删父表级联全闭环通过', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const ref = E.createTable(v1, s, 'accounts');
    const rId = E.addColumn(v1, ref, { name: 'id', type: 'integer', notNull: true });
    E.addPrimaryKey(v1, ref, [rId]);

    const p = E.createTable(v1, s, 'ledger');
    const cId = E.addColumn(v1, p, { name: 'id', type: 'integer', notNull: true });
    const cAcct = E.addColumn(v1, p, { name: 'account_id', type: 'integer', notNull: true });
    E.addColumn(v1, p, { name: 'amount', type: 'integer', default: { expr: '0' } });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cId, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cId]);
    E.addCheck(v1, p, '(amount >= 0)');
    E.addForeignKey(v1, p, [cAcct], ref, [rId]);
    E.addIndex(v1, p, [{ column: cAcct }]);
    const ch1 = E.createPartition(v1, p, 'ledger_1', 'FOR VALUES FROM (0) TO (100)');
    const ch2 = E.createPartition(v1, p, 'ledger_2', 'FOR VALUES FROM (100) TO (200)');

    // 独立普通表（结构兼容，待 Attach）
    const plain = E.createTable(v1, s, 'ledger_archive');
    E.addColumn(v1, plain, { name: 'id', type: 'integer', notNull: true });
    E.addColumn(v1, plain, { name: 'account_id', type: 'integer', notNull: true });
    E.addColumn(v1, plain, { name: 'amount', type: 'integer', default: { expr: '0' } });

    // v1 → v2: Attach plain + Detach ch2 + 修改 ch1 边界
    const v2 = structuredClone(v1);
    E.attachPartition(v2, p, plain, 'FOR VALUES FROM (200) TO (300)');
    E.detachPartition(v2, ch2);
    E.setPartitionBound(v2, ch1, 'FOR VALUES FROM (0) TO (150)');
    expect(validate(v2)).toEqual([]);
    const r12 = await verify(db, v1, v2);
    expect(r12.upDiff).toEqual([]);
    expect(r12.downDiff).toEqual([]);

    // v2 → v3: 互换 ch1 与 plain 边界
    const v3 = structuredClone(v2);
    E.setPartitionBound(v3, ch1, 'FOR VALUES FROM (200) TO (300)');
    E.setPartitionBound(v3, plain, 'FOR VALUES FROM (0) TO (150)');
    expect(validate(v3)).toEqual([]);
    const r23 = await verify(db, v2, v3);
    expect(r23.upDiff).toEqual([]);
    expect(r23.downDiff).toEqual([]);

    // v3 → v4: 删除父表（级联删除全部子分区）
    const v4 = structuredClone(v3);
    E.dropTable(v4, p);
    expect(validate(v4)).toEqual([]);
    const r34 = await verify(db, v3, v4);
    expect(r34.upDiff).toEqual([]);
    expect(r34.downDiff).toEqual([]);
  });

  test('多级子分区导入、往返与闭环验证通过', async () => {
    const db = conn();
    const { m } = await roundtrip(`
      CREATE TABLE metrics (
        yr integer NOT NULL,
        region text NOT NULL,
        val bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (yr, region)
      ) PARTITION BY RANGE (yr);
      CREATE TABLE metrics_2025 PARTITION OF metrics
        FOR VALUES FROM (2025) TO (2026)
        PARTITION BY LIST (region);
      CREATE TABLE metrics_2025_us PARTITION OF metrics_2025 FOR VALUES IN ('us');
      CREATE TABLE metrics_2025_eu PARTITION OF metrics_2025 FOR VALUES IN ('eu');
      CREATE TABLE metrics_2026 PARTITION OF metrics
        FOR VALUES FROM (2026) TO (2027)
        PARTITION BY HASH (region);
      CREATE TABLE metrics_2026_0 PARTITION OF metrics_2026 FOR VALUES WITH (modulus 2, remainder 0);
      CREATE TABLE metrics_2026_1 PARTITION OF metrics_2026 FOR VALUES WITH (modulus 2, remainder 1);
    `);

    const pub = E.all(m, 'schema').find((s) => s.name === 'public')!;
    const empty = { ...m, objects: { [pub.id]: { ...pub, comment: null } } };
    const r = await verify(db, empty, m);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('存量旧格式 string partitionBy + 子分区冗余列升级到结构化 PartitionSpec 零冗余 SQL', async () => {
    const db = conn();
    const legacy = emptyModel();
    const s = E.createSchema(legacy, 'public', 's1');
    legacy.objects.p = {
      id: 'p',
      kind: 'table',
      parent: s,
      name: 'sales',
      partitionBy: 'RANGE (day)',
      partitionOf: null,
      comment: null,
    };
    legacy.objects.p_day = {
      id: 'p_day',
      kind: 'column',
      parent: 'p',
      name: 'day',
      pos: 'a0',
      type: 'integer',
      typeRef: null,
      notNull: true,
      notNullName: 'sales_day_not_null',
      notNullNameMode: 'derived',
      default: null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    };
    legacy.objects.c1 = {
      id: 'c1',
      kind: 'table',
      parent: s,
      name: 'sales_1',
      partitionBy: null,
      partitionOf: { parent: 'p', bound: 'FOR VALUES FROM (0) TO (10)' },
      comment: null,
    };
    legacy.objects.c1_day = {
      id: 'c1_day',
      kind: 'column',
      parent: 'c1',
      name: 'day',
      pos: 'a0',
      type: 'integer',
      typeRef: null,
      notNull: true,
      notNullName: 'sales_1_day_not_null',
      notNullNameMode: 'derived',
      default: null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    };
    legacy.objects.c1_idx = {
      id: 'c1_idx',
      kind: 'index',
      parent: 'c1',
      name: 'sales_1_day_idx',
      nameMode: 'derived',
      unique: false,
      method: 'btree',
      elements: [
        { column: 'c1_day', expr: null, desc: false, nullsFirst: null, opclass: null, collation: null },
      ],
      include: [],
      where: null,
      nullsNotDistinct: false,
      comment: null,
    };

    // 建出旧格式库并重新导入得到新格式模型
    await resetShadow(db);
    await runSteps(db, createAll(legacy));
    const upgraded = reconcileIds(legacy, importSnapshot(await readSnapshot(db)));
    expect(validate(upgraded)).toEqual([]);
    expect(E.columnsOf(upgraded, 'c1')).toEqual([]);
    expect(typeof (upgraded.objects.p as E.Table).partitionBy).toBe('object');

    // 从旧格式模型迁移到新格式模型：不产生多余 DROP COLUMN 或重建索引 SQL
    const steps = plan(legacy, upgraded);
    expect(steps).toEqual([]);
    // 反向迁移（新格式 → 旧格式）同样不产生非法 ALTER TABLE <child> ADD COLUMN
    expect(plan(upgraded, legacy)).toEqual([]);

    // 存量旧格式直接画布编辑（增列、改分区键列名、改子分区边界、脱离子分区、改父表名）双向闭环全绿
    const cases: [string, (m: E.Model) => void][] = [
      ['addColumn', (m) => void E.addColumn(m, 'p', { name: 'note', type: 'text' })],
      ['renameColumn', (m) => E.renameColumn(m, 'p_day', 'day_num')],
      ['setPartitionBound', (m) => E.setPartitionBound(m, 'c1', 'FOR VALUES FROM (0) TO (20)')],
      ['detachPartition', (m) => E.detachPartition(m, 'c1')],
      ['renameTable', (m) => E.renameTable(m, 'p', 'sales_v2')],
    ];
    for (const [label, edit] of cases) {
      const legacyCopy = structuredClone(legacy);
      const edited = structuredClone(legacy);
      edit(edited);
      expect(validate(edited), label).toEqual([]);
      const rLegacy = await verify(db, legacy, edited);
      expect(rLegacy.upDiff, `${label} upDiff`).toEqual([]);
      expect(rLegacy.downDiff, `${label} downDiff`).toEqual([]);
      // 确认 plan 入口归一化未修改调用方传入的 legacy 入参
      expect(legacy).toEqual(legacyCopy);
    }
  });

  test('R2 High #6: 多级子分区表挂载（attachPartition）与脱离闭环通过', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const gp = E.createTable(v1, s, 'gp');
    const gpYr = E.addColumn(v1, gp, { name: 'yr', type: 'integer', notNull: true });
    const gpReg = E.addColumn(v1, gp, { name: 'region', type: 'text', notNull: true });
    E.setPartitionBy(v1, gp, {
      strategy: 'range',
      keys: [{ column: gpYr, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, gp, [gpYr, gpReg]);

    // 独立的多级分区表 sub（自带 PARTITION BY LIST (region) 和叶分区 sub_us）
    const sub = E.createTable(v1, s, 'gp_2025');
    E.addColumn(v1, sub, { name: 'yr', type: 'integer', notNull: true });
    const subReg = E.addColumn(v1, sub, { name: 'region', type: 'text', notNull: true });
    E.setPartitionBy(v1, sub, {
      strategy: 'list',
      keys: [{ column: subReg, expr: null, opclass: null, collation: null }],
    });
    E.createPartition(v1, sub, 'gp_2025_us', "FOR VALUES IN ('us')");

    const v2 = structuredClone(v1);
    E.attachPartition(v2, gp, sub, 'FOR VALUES FROM (2025) TO (2026)');
    expect(validate(v2)).toEqual([]);
    const r = await verify(db, v1, v2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('Fuzz seed 1444353190 回归：分区父表重命名列 + 子分区重绑边界与后续新建/脱离闭环一致', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const p = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, p, { name: 'pk_key', type: 'integer', notNull: true });
    const cVal = E.addColumn(v1, p, { name: 'val', type: 'integer', default: { expr: '0' } });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cPk]);
    E.addUnique(v1, p, [cPk, cVal]);
    E.addUnique(v1, p, [cPk]);
    E.addIndex(v1, p, [{ column: cVal }]);
    const ch0 = E.createPartition(v1, p, 'pt_a_p_0', 'DEFAULT');

    // v1 → v2：同时重命名父表列 pk_key → user、val → amount 并重绑 DEFAULT 子分区边界
    const v2 = structuredClone(v1);
    E.renameColumn(v2, cPk, 'user');
    E.renameColumn(v2, cVal, 'amount');
    E.setPartitionBound(v2, ch0, 'FOR VALUES FROM (1400) TO (1500)');
    expect(validate(v2)).toEqual([]);
    const r12 = await verify(db, v1, v2);
    expect(r12.upDiff).toEqual([]);
    expect(r12.downDiff).toEqual([]);

    // v2 → v3：在改名后的父表上新建子分区
    const v3 = structuredClone(v2);
    const ch1 = E.createPartition(v3, p, 'pt_a_p_1', 'FOR VALUES FROM (1500) TO (1600)');
    expect(validate(v3)).toEqual([]);
    const r23 = await verify(db, v2, v3);
    expect(r23.upDiff).toEqual([]);
    expect(r23.downDiff).toEqual([]);

    // v3 → v4：脱离新建的子分区并删掉其脱离后的 UNIQUE 约束（验证 PG 约束名已按新列名生成）
    const v4 = structuredClone(v3);
    E.detachPartition(v4, ch1);
    for (const u of E.childrenOf(v4, ch1, 'unique')) E.dropKey(v4, u.id);
    expect(validate(v4)).toEqual([]);
    const r34 = await verify(db, v3, v4);
    expect(r34.upDiff).toEqual([]);
    expect(r34.downDiff).toEqual([]);
  });

  test('High #3: 子分区改名与父表列改名同步重命名 PG 隐式继承约束/索引（同迁移占名新建 + 跨版本 Detach 闭环）', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const p = E.createTable(v1, s, 'events');
    const cId = E.addColumn(v1, p, { name: 'id', type: 'integer', notNull: true });
    const cAcct = E.addColumn(v1, p, { name: 'acct', type: 'integer', notNull: true });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cId, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cId]);
    E.addUnique(v1, p, [cId, cAcct]);
    E.addIndex(v1, p, [{ column: cAcct }]);
    const ch1 = E.createPartition(v1, p, 'events_1', 'FOR VALUES FROM (0) TO (100)');

    // v1 → v2: 重命名子分区 events_1 → events_h1、重命名列 acct → account_id，且同迁移新建同名分区 events_1
    const v2 = structuredClone(v1);
    E.renameTable(v2, ch1, 'events_h1');
    E.renameColumn(v2, cAcct, 'account_id');
    E.createPartition(v2, p, 'events_1', 'FOR VALUES FROM (100) TO (200)');
    expect(validate(v2)).toEqual([]);
    const r12 = await verify(db, v1, v2);
    expect(r12.upDiff).toEqual([]);
    expect(r12.downDiff).toEqual([]);

    // v2 → v3: 跨版本脱离已改名的 events_h1 并删除其脱离后的主键与索引（验证 PG 中隐式约束/索引名已与 v2 一致）
    const v3 = structuredClone(v2);
    E.detachPartition(v3, ch1);
    const detPk = E.childrenOf(v3, ch1, 'primaryKey')[0]!;
    E.dropKey(v3, detPk.id);
    expect(validate(v3)).toEqual([]);
    const r23 = await verify(db, v2, v3);
    expect(r23.upDiff).toEqual([]);
    expect(r23.downDiff).toEqual([]);

    // 同迁移内子分区改名 + 改边界（sameParentRebind）+ 占旧名新建分区
    const v2b = structuredClone(v1);
    E.renameTable(v2b, ch1, 'events_old');
    E.setPartitionBound(v2b, ch1, 'FOR VALUES FROM (0) TO (50)');
    E.createPartition(v2b, p, 'events_1', 'FOR VALUES FROM (50) TO (100)');
    expect(validate(v2b)).toEqual([]);
    const rRebind = await verify(db, v1, v2b);
    expect(rRebind.upDiff).toEqual([]);
    expect(rRebind.downDiff).toEqual([]);
  });

  test('High #4: 分区父表 FOR EACH ROW 触发器不重复导入子分区克隆记录（tgparentid = 0）', async () => {
    const db = conn();
    const { m } = await roundtrip(`
      CREATE FUNCTION public.touch_noop() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
      CREATE TABLE audit_events (
        id integer NOT NULL,
        day integer NOT NULL,
        PRIMARY KEY (id, day)
      ) PARTITION BY RANGE (day);
      CREATE TABLE audit_events_1 PARTITION OF audit_events FOR VALUES FROM (0) TO (10);
      CREATE TABLE audit_events_2 PARTITION OF audit_events FOR VALUES FROM (10) TO (20);
      CREATE TRIGGER trg_audit_noop BEFORE INSERT ON public.audit_events
        FOR EACH ROW EXECUTE FUNCTION public.touch_noop();
    `);

    const triggers = E.all(m, 'opaque').filter((o) => o.objType === 'trigger');
    expect(triggers.length).toBe(1);
    expect(triggers[0]!.name).toBe('trg_audit_noop');

    const pub = E.all(m, 'schema').find((s) => s.name === 'public')!;
    const empty = { ...m, objects: { [pub.id]: { ...pub, comment: null } } };
    const r = await verify(db, empty, m);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('回归（缺陷 1）：脱离分区并删除父表或父表列时保留独立 CHECK 与表达式/部分索引', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const p = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, p, { name: 'pk_key', type: 'integer', notNull: true });
    const cVal = E.addColumn(v1, p, { name: 'val', type: 'integer', default: { expr: '0' } });
    const cTag = E.addColumn(v1, p, { name: 'tag', type: 'text' });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cPk]);
    E.addCheck(v1, p, '(pk_key > 0)');
    E.addCheck(v1, p, '(val >= 0)');
    E.addIndex(v1, p, [{ expr: 'lower(tag)' }]);
    E.addIndex(v1, p, [{ column: cPk }], { where: '(val > 0)' });
    const ch0 = E.createPartition(v1, p, 'pt_a_p_0', 'DEFAULT');

    // 场景 A：脱离后同迁移删除父表
    const v2a = structuredClone(v1);
    E.detachPartition(v2a, ch0);
    E.dropTable(v2a, p);
    expect(validate(v2a)).toEqual([]);
    const upStepsA = plan(v1, v2a);
    expect(
      upStepsA.some((st) => st.target === ch0 && (st.kind === 'addCheck' || st.kind === 'createIndex')),
    ).toBe(false);
    const rA = await verify(db, v1, v2a);
    expect(rA.upDiff).toEqual([]);
    expect(rA.downDiff).toEqual([]);

    // 场景 B：脱离后同迁移删除父表列（关联 CHECK 与部分索引随之从父表删除，但脱离表仍独立保留）
    const v2b = structuredClone(v1);
    E.detachPartition(v2b, ch0);
    E.dropColumn(v2b, cVal);
    E.dropColumn(v2b, cTag);
    expect(validate(v2b)).toEqual([]);
    const upStepsB = plan(v1, v2b);
    expect(
      upStepsB.some((st) => st.target === ch0 && (st.kind === 'addCheck' || st.kind === 'createIndex')),
    ).toBe(false);
    const rB = await verify(db, v1, v2b);
    expect(rB.upDiff).toEqual([]);
    expect(rB.downDiff).toEqual([]);
  });

  test('回归（缺陷 2）：改边界重挂分区时父表生成列增删 NOT NULL、改类型与约束名冲突回退', async () => {
    const db = conn();
    const [{ v: pgVer }] = (await db.query<{ v: number }>(
      `select current_setting('server_version_num')::int as v`,
    )) as [{ v: number }];
    const pgMajor = E.pgMajorOf(pgVer) ?? E.LATEST_PG_MAJOR;

    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const p = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, p, { name: 'pk_key', type: 'integer', notNull: true });
    E.addColumn(v1, p, { name: 'val', type: 'integer' });
    const cGenStored = E.addColumn(v1, p, {
      name: 'g_stored',
      type: 'integer',
      generated: { expr: '(pk_key * 2)', stored: true },
    });
    const cGenVirt =
      pgMajor >= 18
        ? E.addColumn(v1, p, {
            name: 'g_virt',
            type: 'integer',
            generated: { expr: '(val + 1)', stored: false },
          })
        : null;
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cPk]);
    const ch0 = E.createPartition(v1, p, 'pt_a_p_0', 'DEFAULT');

    // v1 → v2：父表生成列加 NOT NULL（down 测删 NOT NULL）+ 子分区改边界重挂
    const v2 = structuredClone(v1);
    E.setNotNull(v2, cGenStored, true);
    if (cGenVirt) E.setNotNull(v2, cGenVirt, true);
    E.setPartitionBound(v2, ch0, 'FOR VALUES FROM (0) TO (100)');
    expect(validate(v2)).toEqual([]);
    const r12 = await verify(db, v1, v2, { pgMajor });
    expect(r12.upDiff).toEqual([]);
    expect(r12.downDiff).toEqual([]);

    // v2 → v3：父表生成列改类型 + 子分区改边界重挂
    const v3 = structuredClone(v2);
    E.setColumnType(v3, cGenStored, 'bigint');
    if (cGenVirt) E.setColumnType(v3, cGenVirt, 'bigint');
    E.setPartitionBound(v3, ch0, 'FOR VALUES FROM (0) TO (200)');
    expect(validate(v3)).toEqual([]);
    const r23 = await verify(db, v2, v3, { pgMajor });
    expect(r23.upDiff).toEqual([]);
    expect(r23.downDiff).toEqual([]);

    // 约束名冲突回退（PG 18+ 命名 NOT NULL）：待挂载表原有列占用目标父表 NOT NULL 约束名时回退为无名 NOT NULL
    if (pgMajor >= 18) {
      const vA = emptyModel();
      const sA = E.createSchema(vA, 'public');
      const p2 = E.createTable(vA, sA, 'p2');
      const p2Pk = E.addColumn(vA, p2, { name: 'pk_key', type: 'integer', notNull: true });
      const p2A = E.addColumn(vA, p2, { name: 'a_col', type: 'integer', notNull: false });
      E.addColumn(vA, p2, { name: 'd_col', type: 'integer', notNull: true });
      E.setPartitionBy(vA, p2, {
        strategy: 'range',
        keys: [{ column: p2Pk, expr: null, opclass: null, collation: null }],
      });
      E.addPrimaryKey(vA, p2, [p2Pk]);
      const plain = E.createTable(vA, sA, 'p2_plain');
      E.addColumn(vA, plain, { name: 'pk_key', type: 'integer', notNull: true });
      E.addColumn(vA, plain, { name: 'a_col', type: 'integer', notNull: false });
      const plD = E.addColumn(vA, plain, { name: 'd_col', type: 'integer', notNull: true });
      // d_col 排在 a_col 与新列 new_col 之后，先占着 p2_a_col_not_null（触发 setNotNull 回退）；
      // 另加 e_col 占着 p2_new_col_not_null（触发 addColumn 回退）
      E.addColumn(vA, p2, { name: 'e_col', type: 'integer', notNull: true });
      const plE = E.addColumn(vA, plain, { name: 'e_col', type: 'integer', notNull: true });
      (vA.objects[plD] as E.Column).notNullName = 'p2_a_col_not_null';
      (vA.objects[plD] as E.Column).notNullNameMode = 'explicit';
      (vA.objects[plE] as E.Column).notNullName = 'p2_new_col_not_null';
      (vA.objects[plE] as E.Column).notNullNameMode = 'explicit';

      const vB = structuredClone(vA);
      E.attachPartition(vB, p2, plain, 'FOR VALUES FROM (0) TO (100)');
      E.setNotNull(vB, p2A, true);
      const p2New = E.addColumn(vB, p2, { name: 'new_col', type: 'integer', notNull: true });
      // 把 new_col 排在 d_col/e_col 之前，确保 P12h 处理 new_col 时 e_col 尚未改名
      E.moveColumn(vB, p2New, p2A);
      expect(validate(vB)).toEqual([]);
      const rConflict = await verify(db, vA, vB, { pgMajor });
      expect(rConflict.upDiff).toEqual([]);
      expect(rConflict.downDiff).toEqual([]);
    }
  });

  test('回归（缺陷 3）：独立表带列注释挂载及脱离后加列注释再反向挂载闭环通过', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const p = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, p, { name: 'pk_key', type: 'integer', notNull: true });
    E.addColumn(v1, p, { name: 'val', type: 'integer', default: { expr: '0' } });
    E.addColumn(v1, p, {
      name: 'g',
      type: 'integer',
      generated: { expr: '(pk_key * 2)', stored: true },
    });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cPk]);
    const ch0 = E.createPartition(v1, p, 'pt_a_p_0', 'DEFAULT');

    // 场景 A：脱离后给列加注释（含单引号与生成列），down 反向挂载回父表时须清注释
    const v2 = structuredClone(v1);
    E.detachPartition(v2, ch0);
    for (const col of E.columnsOf(v2, ch0)) {
      E.setComment(v2, col.id, col.name === 'pk_key' ? "注释 0 it's" : `列 ${col.name} 注释`);
    }
    expect(validate(v2)).toEqual([]);
    const rDetach = await verify(db, v1, v2);
    expect(rDetach.upDiff).toEqual([]);
    expect(rDetach.downDiff).toEqual([]);

    // 场景 B：原本带列注释的普通表直接挂载到父表
    const v3 = structuredClone(v1);
    const plain = E.createTable(v3, s, 'pt_a_plain');
    const plPk = E.addColumn(v3, plain, { name: 'pk_key', type: 'integer', notNull: true });
    const plVal = E.addColumn(v3, plain, { name: 'val', type: 'integer', default: { expr: '0' } });
    const plGen = E.addColumn(v3, plain, {
      name: 'g',
      type: 'integer',
      generated: { expr: '(pk_key * 2)', stored: true },
    });
    E.setComment(v3, plPk, "挂载前主键注释 it's");
    E.setComment(v3, plVal, '挂载前普通列注释');
    E.setComment(v3, plGen, '挂载前生成列注释');

    const v4 = structuredClone(v3);
    E.attachPartition(v4, p, plain, 'FOR VALUES FROM (0) TO (100)');
    expect(validate(v4)).toEqual([]);
    const rAttach = await verify(db, v3, v4);
    expect(rAttach.upDiff).toEqual([]);
    expect(rAttach.downDiff).toEqual([]);
  });

  test('回归（缺陷 4）：父表含同列重复 UNIQUE/INDEX 时删第一个并重命名子分区双向闭环通过', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 's1');
    const p = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, p, { name: 'pk_key', type: 'integer', notNull: true });
    const cVal = E.addColumn(v1, p, { name: 'val', type: 'integer', default: { expr: '0' } });
    E.setPartitionBy(v1, p, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, p, [cPk]);
    const u1 = E.addUnique(v1, p, [cPk, cVal], true);
    const u2 = E.addUnique(v1, p, [cPk, cVal], true);
    const i1 = E.addIndex(v1, p, [{ column: cVal }]);
    const i2 = E.addIndex(v1, p, [{ column: cVal }]);
    const ch0 = E.createPartition(v1, p, 'pt_a_p_0', 'DEFAULT');
    const ch32 = E.createPartition(v1, p, 'pt_a_p_32', 'FOR VALUES FROM (1900) TO (2000)');

    // 场景 A：删第一个 UNIQUE/INDEX + 删兄弟子分区 + schema 改名 + 重命名保留子分区
    const v2 = structuredClone(v1);
    E.dropKey(v2, u1);
    E.dropKey(v2, i1);
    E.dropTable(v2, ch0);
    E.renameSchema(v2, s, 'user');
    E.renameTable(v2, ch32, 'ch_user_5');
    expect(validate(v2)).toEqual([]);
    const rA = await verify(db, v1, v2);
    expect(rA.upDiff).toEqual([]);
    expect(rA.downDiff).toEqual([]);

    // 场景 B：仅删第一个 UNIQUE/INDEX 后直接脱离剩余子分区并删除脱离后的第二个 UNIQUE/INDEX（验证 PG 隐式名已从 key1/idx1 同步为 key/idx）
    const v2b = structuredClone(v1);
    E.dropKey(v2b, u1);
    E.dropKey(v2b, i1);
    expect(validate(v2b)).toEqual([]);
    const rB1 = await verify(db, v1, v2b);
    expect(rB1.upDiff).toEqual([]);
    expect(rB1.downDiff).toEqual([]);

    const v3b = structuredClone(v2b);
    E.detachPartition(v3b, ch32);
    for (const u of E.childrenOf(v3b, ch32, 'unique')) E.dropKey(v3b, u.id);
    for (const x of E.childrenOf(v3b, ch32, 'index')) E.dropKey(v3b, x.id);
    expect(validate(v3b)).toEqual([]);
    const rB2 = await verify(db, v2b, v3b);
    expect(rB2.upDiff).toEqual([]);
    expect(rB2.downDiff).toEqual([]);
    expect(u2).toBeTruthy();
    expect(i2).toBeTruthy();
  });

  test('回归（缺陷 5）：objects 键序反转零规划差异及多级分区同列索引/唯一约束双向闭环通过', async () => {
    const db = conn();

    // 1. 键序无关性与实库 readSnapshot/importSnapshot/reconcileIds 零多余步骤
    const m1 = emptyModel();
    const s1 = E.createSchema(m1, 'public');
    const ptC = E.createTable(m1, s1, 'pt_c');
    const cPk = E.addColumn(m1, ptC, { name: 'pk_key', type: 'integer', notNull: true });
    const cVal = E.addColumn(m1, ptC, { name: 'val', type: 'integer', default: { expr: '0' } });
    E.setPartitionBy(m1, ptC, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(m1, ptC, [cPk]);
    E.addUnique(m1, ptC, [cPk, cVal], true);
    E.addUnique(m1, ptC, [cPk, cVal], true);
    E.addIndex(m1, ptC, [{ column: cVal }]);
    E.addIndex(m1, ptC, [{ column: cVal }]);
    E.createPartition(m1, ptC, 'pt_c_p_50', 'FOR VALUES FROM (0) TO (100)');
    E.createPartition(m1, ptC, 'pt_c_p_87', 'FOR VALUES FROM (100) TO (200)');

    const m2: E.Model = {
      ...structuredClone(m1),
      objects: Object.fromEntries(Object.entries(structuredClone(m1.objects)).reverse()),
    };
    expect(validate(m1)).toEqual([]);
    expect(validate(m2)).toEqual([]);
    expect(plan(m1, m2)).toEqual([]);
    expect(plan(m2, m1)).toEqual([]);

    await build(db, m1);
    const live = reconcileIds(m1, importSnapshot(await readSnapshot(db)));
    expect(plan(live, m1)).toEqual([]);
    expect(plan(m1, live)).toEqual([]);

    // 2. 两级分区：根父表与二级子父表均建同列 UNIQUE 与 INDEX，删根父表对象 + 子表改名 + 脱离全闭环
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const gp = E.createTable(v1, s, 'gp');
    const gpYr = E.addColumn(v1, gp, { name: 'yr', type: 'integer', notNull: true });
    const gpReg = E.addColumn(v1, gp, { name: 'region', type: 'text', notNull: true });
    const gpVal = E.addColumn(v1, gp, { name: 'val', type: 'integer', notNull: true });
    const gpExtra = E.addColumn(v1, gp, { name: 'extra', type: 'integer', notNull: true });
    E.setPartitionBy(v1, gp, {
      strategy: 'range',
      keys: [{ column: gpYr, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, gp, [gpYr, gpReg]);
    const gu1 = E.addUnique(v1, gp, [gpYr, gpReg, gpVal]);
    E.addUnique(v1, gp, [gpYr, gpReg, gpVal]);
    const gi1 = E.addIndex(v1, gp, [{ column: gpVal }]);
    E.addIndex(v1, gp, [{ column: gpVal }]);

    const sub = E.createPartition(v1, gp, 'gp_2025', 'FOR VALUES FROM (2025) TO (2026)');
    E.setPartitionBy(v1, sub, {
      strategy: 'list',
      keys: [{ column: gpReg, expr: null, opclass: null, collation: null }],
    });
    // sub 上建局部唯一约束（含 extra 列）与局部部分索引（与 gp 同在 val 列，令 leaf 上发生同名竞争但不被 PG 吸收）
    const su1 = E.addUnique(v1, sub, [gpYr, gpReg, gpExtra]);
    E.renameKey(v1, su1, 'sub_local_uniq');
    const si1 = E.addIndex(v1, sub, [{ column: gpVal }], { where: '(yr >= 2025)' });
    E.renameKey(v1, si1, 'sub_local_idx');
    const leaf = E.createPartition(v1, sub, 'gp_2025_us', "FOR VALUES IN ('us')");

    // 场景 A：删根父表第一条 UNIQUE 与 INDEX，同时重命名叶子分区（down 反向测试向两级分区新增）
    const v2 = structuredClone(v1);
    E.dropKey(v2, gu1);
    E.dropKey(v2, gi1);
    E.renameTable(v2, leaf, 'gp_2025_us_v2');
    expect(validate(v2)).toEqual([]);
    const rA = await verify(db, v1, v2);
    expect(rA.upDiff).toEqual([]);
    expect(rA.downDiff).toEqual([]);

    // 场景 B：脱离叶子分区并删除其脱离后的全部 UNIQUE 与 INDEX
    const v3 = structuredClone(v2);
    E.detachPartition(v3, leaf);
    for (const u of E.childrenOf(v3, leaf, 'unique')) E.dropKey(v3, u.id);
    for (const x of E.childrenOf(v3, leaf, 'index')) E.dropKey(v3, x.id);
    expect(validate(v3)).toEqual([]);
    const rB = await verify(db, v2, v3);
    expect(rB.upDiff).toEqual([]);
    expect(rB.downDiff).toEqual([]);
  });

  test('Issue #65 exact CI reproduction: detach -> rename check -> rename table -> attach -> resetKeyName roundtrips on PG', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const ptA = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, ptA, { name: 'pk_key', type: 'integer', notNull: true });
    E.setPartitionBy(v1, ptA, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    const ck1 = E.addCheck(v1, ptA, '(pk_key > 0)');
    const ck2 = E.addCheck(v1, ptA, '(pk_key > 1)');
    const ch = E.createPartition(v1, ptA, 'pt_a_p_39', 'DEFAULT');

    const v2 = structuredClone(v1);
    E.detachPartition(v2, ch);
    E.renameKey(v2, ck1, 'k_yyyy');
    E.renameTable(v2, ch, 'b');
    E.attachPartition(v2, ptA, ch, 'DEFAULT');
    E.resetKeyName(v2, ck2);

    expect(validate(v2)).toEqual([]);
    const r = await verify(db, v1, v2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });

  test('Issue #65: cross-level constraint rename swaps, parent CHECK named child_pkey, and multi-level attach roundtrip on PG', async () => {
    const db = conn();
    const pgMajor = E.pgMajorOf(
      (
        (await db.query<{ v: number }>(`select current_setting('server_version_num')::int as v`)) as [
          { v: number },
        ]
      )[0].v,
    )!;

    // 1. Parent CHECK <-> child local CHECK swap + parent FK <-> child local CHECK swap + subsequent DETACH
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const ref = E.createTable(v1, s, 'ref_t');
    const rId = E.addColumn(v1, ref, { name: 'id', type: 'integer', notNull: true });
    E.addPrimaryKey(v1, ref, [rId]);

    const pt = E.createTable(v1, s, 'pt_swap');
    const pId = E.addColumn(v1, pt, { name: 'id', type: 'integer', notNull: true });
    E.addColumn(v1, pt, { name: 'val', type: 'integer', notNull: true });
    E.setPartitionBy(v1, pt, {
      strategy: 'range',
      keys: [{ column: pId, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, pt, [pId]);
    const pCk = E.addCheck(v1, pt, '(val > 0)');
    E.renameKey(v1, pCk, 'ck_alpha');
    const pFk = E.addForeignKey(v1, pt, [pId], ref, [rId]);
    E.renameKey(v1, pFk, 'fk_alpha');

    const ch = E.createPartition(v1, pt, 'pt_swap_1', 'FOR VALUES FROM (0) TO (10)');
    const cCk1 = E.addCheck(v1, ch, '(val < 100)');
    E.renameKey(v1, cCk1, 'ck_beta');
    const cCk2 = E.addCheck(v1, ch, '(val < 200)');
    E.renameKey(v1, cCk2, 'ck_gamma');

    const v2 = structuredClone(v1);
    E.renameKey(v2, pCk, 'tmp_ck');
    E.renameKey(v2, cCk1, 'ck_alpha');
    E.renameKey(v2, pCk, 'ck_beta');
    E.renameKey(v2, pFk, 'tmp_fk');
    E.renameKey(v2, cCk2, 'fk_alpha');
    E.renameKey(v2, pFk, 'ck_gamma');

    expect(validate(v2)).toEqual([]);
    const rSwap = await verify(db, v1, v2);
    expect(rSwap.upDiff).toEqual([]);
    expect(rSwap.downDiff).toEqual([]);

    // Detach after cross-level FK rename ensures child's cloned FK matches renamed parent FK in PG
    const v3 = structuredClone(v2);
    E.detachPartition(v3, ch);
    expect(validate(v3)).toEqual([]);
    const rDetach = await verify(db, v2, v3);
    expect(rDetach.upDiff).toEqual([]);
    expect(rDetach.downDiff).toEqual([]);

    // 2. PG 18+: root column notNullName swap with child local CHECK via renameColumn + renameKey
    if (pgMajor >= 18) {
      const mNn1 = emptyModel();
      const sNn = E.createSchema(mNn1, 'public');
      const pNn = E.createTable(mNn1, sNn, 'pt_nn');
      const nnId = E.addColumn(mNn1, pNn, { name: 'id', type: 'integer', notNull: true });
      const nnVal = E.addColumn(mNn1, pNn, { name: 'old_col', type: 'integer', notNull: true });
      E.setPartitionBy(mNn1, pNn, {
        strategy: 'range',
        keys: [{ column: nnId, expr: null, opclass: null, collation: null }],
      });
      const chNn = E.createPartition(mNn1, pNn, 'pt_nn_1', 'DEFAULT');
      const chNnCk = E.addCheck(mNn1, chNn, '(id > 0)');
      E.renameKey(mNn1, chNnCk, 'pt_nn_new_col_not_null');

      const mNn2 = structuredClone(mNn1);
      E.renameKey(mNn2, chNnCk, 'tmp_ck_nn');
      E.renameColumn(mNn2, nnVal, 'new_col');
      E.renameKey(mNn2, chNnCk, 'pt_nn_old_col_not_null');

      expect(validate(mNn2)).toEqual([]);
      const rNn = await verify(db, mNn1, mNn2, { pgMajor });
      expect(rNn.upDiff).toEqual([]);
      expect(rNn.downDiff).toEqual([]);
    }

    // 3. Parent CHECK explicitly named child_pkey alongside parent PRIMARY KEY (createAll + incremental add + down)
    const mPk1 = emptyModel();
    const sPk = E.createSchema(mPk1, 'public');
    const pPk = E.createTable(mPk1, sPk, 'pt_pk');
    const pkId = E.addColumn(mPk1, pPk, { name: 'id', type: 'integer', notNull: true });
    E.addColumn(mPk1, pPk, { name: 'v', type: 'integer' });
    E.setPartitionBy(mPk1, pPk, {
      strategy: 'range',
      keys: [{ column: pkId, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(mPk1, pPk, [pkId]);
    E.createPartition(mPk1, pPk, 'pt_pk_1', 'DEFAULT');

    const mPk2 = structuredClone(mPk1);
    const ckPkey = E.addCheck(mPk2, pPk, '(v > 0)');
    E.renameKey(mPk2, ckPkey, 'pt_pk_1_pkey');

    expect(validate(mPk2)).toEqual([]);
    const rPk = await verify(db, mPk1, mPk2);
    expect(rPk.upDiff).toEqual([]);
    expect(rPk.downDiff).toEqual([]);

    // 4. Multi-level gp -> sub -> leaf attach with grandchild matching CHECK absorption + cross-level rename
    const mMl1 = emptyModel();
    const sMl = E.createSchema(mMl1, 'public');
    const gpMl = E.createTable(mMl1, sMl, 'ml_gp');
    const mlA = E.addColumn(mMl1, gpMl, { name: 'a', type: 'integer', notNull: true });
    const mlB = E.addColumn(mMl1, gpMl, { name: 'b', type: 'integer', notNull: true });
    E.addColumn(mMl1, gpMl, { name: 'c', type: 'integer' });
    E.setPartitionBy(mMl1, gpMl, {
      strategy: 'range',
      keys: [{ column: mlA, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(mMl1, gpMl, [mlA, mlB]);
    const gpMlCk = E.addCheck(mMl1, gpMl, '(c > 0)');
    E.renameKey(mMl1, gpMlCk, 'shared_ml_ck');

    const subMl = E.createTable(mMl1, sMl, 'ml_sub');
    E.addColumn(mMl1, subMl, { name: 'a', type: 'integer', notNull: true });
    const subB = E.addColumn(mMl1, subMl, { name: 'b', type: 'integer', notNull: true });
    E.addColumn(mMl1, subMl, { name: 'c', type: 'integer' });
    E.setPartitionBy(mMl1, subMl, {
      strategy: 'range',
      keys: [{ column: subB, expr: null, opclass: null, collation: null }],
    });
    const subCk = E.addCheck(mMl1, subMl, '(c > 0)');
    E.renameKey(mMl1, subCk, 'shared_ml_ck');
    const leafMl = E.createPartition(mMl1, subMl, 'ml_leaf', 'FOR VALUES FROM (0) TO (10)');
    const leafLocal = E.addCheck(mMl1, leafMl, '(c < 100)');
    E.renameKey(mMl1, leafLocal, 'leaf_only_ck');

    const mMl2 = structuredClone(mMl1);
    E.attachPartition(mMl2, gpMl, subMl, 'FOR VALUES FROM (0) TO (10)');
    E.renameKey(mMl2, gpMlCk, 'shared_ml_ck_v2');

    expect(validate(mMl2)).toEqual([]);
    const rMl = await verify(db, mMl1, mMl2);
    expect(rMl.upDiff).toEqual([]);
    expect(rMl.downDiff).toEqual([]);
  });

  test('Issue #65 fuzz #365 regression: sameParentRebind with duplicate-definition FKs and partial FK rename roundtrips on PG', async () => {
    const db = conn();
    const v1 = emptyModel();
    const s = E.createSchema(v1, 'public');
    const ptA = E.createTable(v1, s, 'pt_a');
    const cPk = E.addColumn(v1, ptA, { name: 'pk_key', type: 'integer', notNull: true });
    const cVal = E.addColumn(v1, ptA, { name: 'val', type: 'integer', default: { expr: '0' } });
    E.setPartitionBy(v1, ptA, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    E.addPrimaryKey(v1, ptA, [cPk, cVal]);
    E.addUnique(v1, ptA, [cPk, cVal]);
    const fk1 = E.addForeignKey(v1, ptA, [cVal, cPk], ptA, [cPk, cVal], {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    });
    E.addForeignKey(v1, ptA, [cVal, cPk], ptA, [cPk, cVal], {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    });
    E.createPartition(v1, ptA, 'pt_a_p_46', 'FOR VALUES FROM (1000) TO (1100)');
    const chDef = E.createPartition(v1, ptA, 'pt_a_p_52', 'DEFAULT');

    const v2 = structuredClone(v1);
    E.renameKey(v2, fk1, 'k_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy');
    E.renameTable(v2, chDef, 'b');
    E.setPartitionBound(v2, chDef, 'FOR VALUES FROM (200) TO (300)');

    expect(validate(v2)).toEqual([]);
    const r = await verify(db, v1, v2);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  });
});
