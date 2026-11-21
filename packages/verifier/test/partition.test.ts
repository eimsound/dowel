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
});
