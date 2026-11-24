import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  copyItems,
  copyTables,
  createEnum,
  createPartition,
  createSchema,
  createSequence,
  createTable,
  clonePlain,
  type Dialect,
  emptyModel,
  getDialect,
  type Model,
  MutableModelIndex,
  type Obj,
  planPaste,
  renameKey,
  runMutator,
  setComment,
  setPartitionBy,
  setSequenceOwnedBy,
  stableJson,
  validate,
} from '@dowel/core';
import { describe, expect, test } from 'vitest';

import { execute } from '../src/index.ts';

const SRC = { projectId: 'sync-test', projectName: 'SyncTest', origin: 'canvas' as const, seq: null };
const DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];

const verifySyncEquivalence = (model: Model, ops: unknown[]) => {
  const snapshot = JSON.stringify(model);
  const baseIdx = new MutableModelIndex(model);

  // 无索引的参照：在普通副本上直接执行（不经过写时复制代理与覆盖索引）
  const plain = clonePlain(model);
  runMutator(plain, 'paste', { ops });
  // execute 对 paste 在没有传入索引时会临时建索引，两条路径都要与参照一致
  const resAutoIdx = execute(model, 'paste', { ops });
  const resWithIdx = execute(model, 'paste', { ops }, baseIdx);

  expect(JSON.stringify(model)).toBe(snapshot);
  expect(validate(resWithIdx.next)).toEqual([]);
  expect(stableJson(resWithIdx.next)).toBe(stableJson(plain));
  expect(stableJson(resAutoIdx.next)).toBe(stableJson(plain));
  return { baseIdx, next: resWithIdx.next, changes: resWithIdx.changes };
};

describe('同步层 execute(OverlayModelIndex) 与无索引等价性', () => {
  test('PG: 分区表 + 枚举 + 归属/非归属序列 + items 粘贴与连续二次 paste', () => {
    const m = emptyModel('pg');
    const pub = createSchema(m, 'public');
    const mood = createEnum(m, pub, 'mood', ['ok', 'bad']);
    const ownedSeq = createSequence(m, pub, 'orders_id_seq');
    const sharedSeq = createSequence(m, pub, 'global_seq');

    const users = createTable(m, pub, 'users');
    const uid = addColumn(m, users, { name: 'id', type: 'bigint', notNull: true });
    addPrimaryKey(m, users, [uid]);

    const orders = createTable(m, pub, 'orders');
    const oid = addColumn(m, orders, {
      name: 'id',
      type: 'bigint',
      notNull: true,
      default: { nextval: ownedSeq },
    });
    setSequenceOwnedBy(m, ownedSeq, oid);
    const oUser = addColumn(m, orders, { name: 'user_id', type: 'bigint', notNull: true });
    const oMood = addColumn(m, orders, { name: 'mood', type: '', typeRef: mood, notNull: true });
    addColumn(m, orders, { name: 'ticket', type: 'bigint', default: { nextval: sharedSeq } });
    addPrimaryKey(m, orders, [oid]);
    addUnique(m, orders, [oid, oMood]);
    const ck = addCheck(m, orders, 'user_id > 0');
    renameKey(m, ck, 'orders_user_pos');
    addForeignKey(m, orders, [oUser], users, [uid]);
    setPartitionBy(m, orders, {
      strategy: 'range',
      keys: [{ column: oid, expr: null, opclass: null, collation: null }],
    });
    createPartition(m, orders, 'orders_p1', 'FOR VALUES FROM (0) TO (1000)');
    setComment(m, orders, '订单');

    const payload = copyTables(m, [orders], { source: SRC });
    const p1 = planPaste(m, payload);
    const { baseIdx, next, changes } = verifySyncEquivalence(m, p1.ops);

    // 验证 applyBatch 后第二次粘贴同样完全等价
    baseIdx.applyBatch(
      next,
      changes.map((c) => ({ id: c.id, prev: m.objects[c.id] as Obj | undefined, next: c.obj ?? undefined })),
    );
    const p2 = planPaste(next, payload);
    verifySyncEquivalence(next, p2.ops);

    // items 模式同步等价
    const tgt = createTable(next, pub, 'extra');
    addColumn(next, tgt, { name: 'user_id', type: 'bigint', notNull: true });
    const itemsPlan = planPaste(next, copyItems(m, orders, [oMood, ck], { source: SRC }), {
      targetTable: tgt,
    });
    verifySyncEquivalence(next, itemsPlan.ops);
  });

  test('SQLite / MySQL / MSSQL: 表粒度与表内粒度同步等价性', () => {
    // SQLite
    {
      const sq = emptyModel('sqlite');
      const main = createSchema(sq, 'main');
      const t = createTable(sq, main, 'docs', undefined, null, {
        sqlite: { strict: true, withoutRowid: true },
      });
      const id = addColumn(sq, t, { name: 'id', type: 'INTEGER', notNull: true });
      const title = addColumn(sq, t, { name: 'title', type: 'TEXT', notNull: true });
      addPrimaryKey(sq, t, [id]);
      addIndex(sq, t, [{ column: title }]);
      const plan = planPaste(sq, copyTables(sq, [t], { source: SRC }));
      verifySyncEquivalence(sq, plan.ops);
    }

    // MySQL
    {
      const my = emptyModel('mysql');
      const def = createSchema(my, 'default');
      const t = createTable(my, def, 'items', undefined, null, { mysql: { engine: 'InnoDB' } });
      const id = addColumn(my, t, {
        name: 'id',
        type: 'bigint',
        notNull: true,
        ext: { mysql: { unsigned: true, autoIncrement: true } },
      });
      const code = addColumn(my, t, { name: 'code', type: 'varchar(32)', notNull: true });
      addPrimaryKey(my, t, [id]);
      addUnique(my, t, [code]);
      const plan = planPaste(my, copyTables(my, [t], { source: SRC }));
      verifySyncEquivalence(my, plan.ops);
    }

    // MSSQL
    {
      const ms = emptyModel('mssql');
      const dbo = createSchema(ms, 'dbo');
      const t = createTable(ms, dbo, 'events');
      const id = addColumn(ms, t, {
        name: 'id',
        type: 'bigint',
        notNull: true,
        ext: { mssql: { identity: { seed: '1', increment: '1' } } },
      });
      addColumn(ms, t, {
        name: 'flag',
        type: 'bit',
        notNull: true,
        default: { expr: '((0))' },
        ext: { mssql: { defaultName: 'DF_events_flag_custom', defaultNameMode: 'explicit' } },
      });
      addPrimaryKey(ms, t, [id]);
      const plan = planPaste(ms, copyTables(ms, [t], { source: SRC }));
      verifySyncEquivalence(ms, plan.ops);
    }
  });
});

describe('大规模粘贴性能守卫（1000 张既有表 + 粘贴 200 张表 × 12 列）', () => {
  // 直接写入对象构造大模型：逐个调 addColumn 每次都会全表重算推导名，构造本身就要很久
  const buildLarge = (dialect: Dialect, prefix: string, tables: number, cols: number, withFk: boolean) => {
    const intType = dialect === 'sqlite' ? 'INTEGER' : dialect === 'pg' ? 'integer' : 'int';
    const m = emptyModel(dialect);
    const sch = createSchema(m, getDialect(dialect).capabilities.defaultSchema);
    const ids: string[] = [];
    let prev: { t: string; pk: string } | null = null;
    for (let i = 0; i < tables; i++) {
      const t = `${prefix}_t_${i}`;
      ids.push(t);
      m.objects[t] = {
        id: t,
        kind: 'table',
        parent: sch,
        name: `${prefix}_${i}`,
        partitionBy: null,
        partitionOf: null,
        comment: null,
      };
      const cs: string[] = [];
      for (let j = 0; j < cols; j++) {
        const c = `${prefix}_c_${i}_${j}`;
        cs.push(c);
        m.objects[c] = {
          id: c,
          kind: 'column',
          parent: t,
          name: j === 0 ? 'id' : j === 1 ? 'ref_id' : `col_${j}`,
          pos: `a${String(j).padStart(3, '0')}`,
          type: intType,
          typeRef: null,
          notNull: j < 2,
          notNullName: null,
          notNullNameMode: 'derived',
          default: null,
          identity: null,
          generated: null,
          collation: null,
          comment: null,
        };
      }
      const base = { parent: t, name: '', nameMode: 'derived' as const, comment: null };
      m.objects[`${t}_pk`] = { ...base, id: `${t}_pk`, kind: 'primaryKey', columns: [cs[0]!] };
      m.objects[`${t}_ix`] = {
        ...base,
        id: `${t}_ix`,
        kind: 'index',
        unique: false,
        method: 'btree',
        elements: [
          { column: cs[1]!, expr: null, desc: false, nullsFirst: null, opclass: null, collation: null },
        ],
        include: [],
        where: null,
        nullsNotDistinct: false,
      };
      if (withFk) {
        m.objects[`${t}_fk`] = {
          ...base,
          id: `${t}_fk`,
          kind: 'foreignKey',
          columns: [cs[1]!],
          refTable: prev?.t ?? t,
          refColumns: [prev?.pk ?? cs[0]!],
          onDelete: 'noAction',
          onUpdate: 'noAction',
          match: 'simple',
          deferrable: false,
          initiallyDeferred: false,
        };
      }
      prev = { t, pk: cs[0]! };
    }
    for (const t of ids) getDialect(dialect).refreshDerivedNames(m, t);
    return { m, ids };
  };
  const buildLargeTargetAndSource = (dialect: Dialect, copied = 200) => {
    const target = buildLarge(dialect, 'existing', 1000, 4, false).m;
    const src = buildLarge(dialect, 'copied', copied, 12, true);
    expect(validate(target)).toEqual([]);
    expect(validate(src.m)).toEqual([]);
    return { target, payload: copyTables(src.m, src.ids, { source: SRC }) };
  };

  for (const dialect of DIALECTS) {
    test(`${dialect}: 粘贴 200 张表 planPaste / execute 耗时 < 5000ms，粘贴 20 张表 execute < 1000ms`, () => {
      const { target, payload } = buildLargeTargetAndSource(dialect);
      const baseIdx = new MutableModelIndex(target);

      const t0 = performance.now();
      const plan = planPaste(target, payload);
      const planMs = performance.now() - t0;

      const t1 = performance.now();
      const execRes = execute(target, 'paste', { ops: plan.ops }, baseIdx);
      const execMs = performance.now() - t1;

      // 客户端还有待确认修改时 execute 不带索引：paste 会临时建索引
      const t2 = performance.now();
      const execAuto = execute(target, 'paste', { ops: plan.ops });
      const execAutoMs = performance.now() - t2;

      const small = buildLargeTargetAndSource(dialect, 20);
      const smallPlan = planPaste(small.target, small.payload);
      const t3 = performance.now();
      execute(small.target, 'paste', { ops: smallPlan.ops }, new MutableModelIndex(small.target));
      const smallMs = performance.now() - t3;

      console.info(
        `[perf:${dialect}] 200 tables: planPaste=${planMs.toFixed(1)}ms execute(baseIdx)=${execMs.toFixed(1)}ms execute(auto)=${execAutoMs.toFixed(1)}ms ops=${plan.ops.length}; 20 tables: execute=${smallMs.toFixed(1)}ms`,
      );

      expect(plan.newTables).toHaveLength(200);
      expect(validate(execRes.next)).toEqual([]);
      expect(stableJson(execAuto.next)).toBe(stableJson(execRes.next));
      expect(planMs).toBeLessThan(5000);
      expect(execMs).toBeLessThan(5000);
      expect(execAutoMs).toBeLessThan(5000);
      expect(smallMs).toBeLessThan(1000);
    }, 60_000);
  }
});
