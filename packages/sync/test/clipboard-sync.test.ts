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
  modelIndexStats,
  MutableModelIndex,
  type Obj,
  planPaste,
  renameKey,
  resetModelIndexStats,
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
  const buildTarget = (dialect: Dialect, tables: number) => {
    const target = buildLarge(dialect, 'existing', tables, 4, false).m;
    expect(validate(target)).toEqual([]);
    return target;
  };
  const buildPayload = (dialect: Dialect, copied: number) => {
    const src = buildLarge(dialect, 'copied', copied, 12, true);
    expect(validate(src.m)).toEqual([]);
    return copyTables(src.m, src.ids, { source: SRC });
  };

  // 不断言“多少毫秒内完成”：共享的 CI 机器忙时，同一份代码的墙钟耗时能差出 3 倍以上（Issue #143），绝对阈值只会误报。
  // 改用两个确定性计数（不受机器负载影响）：
  // 1. execute 读基线 m.objects 的次数：粘贴的内容不变、只让既有表变多，多出来的读取摊到每个既有对象、再摊到每个子操作上。
  //    基线索引的命名状态先建好（服务端常驻索引只建一次），四种方言现值都是 0.009：剩下的只是 execute 末尾一次
  //    `{ ...m.objects }` 拷贝（每个既有对象约 3 次读取，与子操作数无关）。重名判定走命名空间分桶后（Issue #165），
  //    SQL Server 不再按 schema 扫描全部约束 / 带默认值列（原先 0.331）。每个子操作经写时复制代理枚举整个模型时为 2.7–8.0；
  //    即使只是每建一张表（占 1/16 子操作）枚举一次整个模型，也会多出约 0.25（`Object.keys` / `for…in`）到 0.44
  //    （`Object.values`，SQL Server 约 0.77），统一阈值 0.1 同时拦住这两类退化。
  // 2. 叠加索引查询访问的元素数（modelIndexStats）：Proxy 只包住基线 m.objects，经索引分桶或叠加层的遍历看不见；
  //    这里固定既有模型、把粘贴规模从 20 张表放大到 80 张，每个子操作访问的元素数应保持不变（叠加层全量扫描时约翻 4 倍）。
  // 计时比值分不开这些：按粘贴规模求耗时比，即使交替测量、取多次最快值，忙机器上也会大幅抖动。另留一个只拦数量级恶化的宽松绝对上限。
  type PasteOps = ReturnType<typeof planPaste>['ops'];
  /** 带现成索引执行一次 paste，返回期间读基线 m.objects 的次数（取值 / in / 属性描述各算一次，枚举按键数算） */
  const countBaseReads = (target: Model, ops: PasteOps) => {
    let reads = 0;
    const objects = new Proxy(target.objects, {
      get: (t, p, r) => (reads++, Reflect.get(t, p, r)),
      has: (t, p) => (reads++, Reflect.has(t, p)),
      getOwnPropertyDescriptor: (t, p) => (reads++, Reflect.getOwnPropertyDescriptor(t, p)),
      ownKeys: (t) => {
        const keys = Reflect.ownKeys(t);
        reads += keys.length;
        return keys;
      },
    });
    const counted: Model = { ...target, objects };
    const idx = new MutableModelIndex(counted);
    // 服务端的基线索引跨提交常驻，命名状态只在首次使用时 O(模型) 构建一次（Issue #164）：先建好，只数每次 paste 的读取
    idx.namingState();
    reads = 0;
    execute(counted, 'paste', { ops }, idx);
    return reads;
  };
  /** 带现成索引（命名状态已建好）执行一次 paste，返回每个子操作平均访问的叠加索引元素数 */
  const indexElemsPerOp = (target: Model, ops: PasteOps) => {
    const idx = new MutableModelIndex(target);
    idx.namingState();
    resetModelIndexStats();
    execute(target, 'paste', { ops }, idx);
    return modelIndexStats.elems / ops.length;
  };
  // 既有表 125 → 1000，粘贴 20 张表（320 个子操作）。计数为确定性数值，无机器波动误报风险：
  // 四种方言现值 0.009，远低于每表全量枚举（约 0.25–0.77）与每子操作全量枚举（2.7–8.0）
  const EXISTING_SMALL = 125;
  const EXISTING_BIG = 1000;
  const COUNTED_PASTE_TABLES = 20;
  const MAX_READS_PER_EXISTING_OBJECT_PER_OP = 0.1;
  // 粘贴 20 → 80 张表时，每个子操作访问的索引元素数之比：现值约 1.0，叠加层全量扫描时约 4（随粘贴规模线性增长）
  const SCALED_PASTE_TABLES = 80;
  const MAX_INDEX_ELEMS_PER_OP_GROWTH = 1.5;
  // 兜底的绝对上限，比常见耗时（200 张表 planPaste 0.03–0.6 s、execute 1–8 s，视机器负载）高一个数量级，
  // 只拦数量级的恶化（例如对粘贴规模比现在更差的复杂度），不是性能指标。用例超时也放宽：构造 1000 张表的模型
  // 和 validate 本身就重，机器严重超载时整个用例能超过 5 分钟
  const BACKSTOP_PLAN_MS = 10_000;
  const BACKSTOP_EXEC_MS = 60_000;

  for (const dialect of DIALECTS) {
    test(`${dialect}: 粘贴 200 张表结果正确，执行时对既有模型的读取不随子操作数放大`, () => {
      const target = buildTarget(dialect, EXISTING_BIG);
      const payload = buildPayload(dialect, 200);
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

      expect(plan.newTables).toHaveLength(200);
      expect(validate(execRes.next)).toEqual([]);
      expect(stableJson(execAuto.next)).toBe(stableJson(execRes.next));

      const smallTarget = buildTarget(dialect, EXISTING_SMALL);
      const countedPayload = buildPayload(dialect, COUNTED_PASTE_TABLES);
      const opsIntoSmall = planPaste(smallTarget, countedPayload).ops;
      const opsIntoBig = planPaste(target, countedPayload).ops;
      expect(opsIntoBig).toHaveLength(opsIntoSmall.length);
      const readsSmall = countBaseReads(smallTarget, opsIntoSmall);
      const readsBig = countBaseReads(target, opsIntoBig);
      const existingDelta = Object.keys(target.objects).length - Object.keys(smallTarget.objects).length;
      const readsPerExistingPerOp = (readsBig - readsSmall) / existingDelta / opsIntoBig.length;

      const elemsSmall = indexElemsPerOp(smallTarget, opsIntoSmall);
      const opsScaled = planPaste(smallTarget, buildPayload(dialect, SCALED_PASTE_TABLES)).ops;
      expect(opsScaled.length).toBe((opsIntoSmall.length / COUNTED_PASTE_TABLES) * SCALED_PASTE_TABLES);
      const elemsScaled = indexElemsPerOp(smallTarget, opsScaled);
      const elemsGrowth = elemsScaled / elemsSmall;

      const ms = (x: number) => `${x.toFixed(1)}ms`;
      console.info(
        `[perf:${dialect}] 200 tables: planPaste=${ms(planMs)} execute(baseIdx)=${ms(execMs)} execute(auto)=${ms(execAutoMs)} ops=${plan.ops.length}; ` +
          `existing ${EXISTING_SMALL}→${EXISTING_BIG} tables, ${opsIntoBig.length} ops: base reads ${readsSmall}→${readsBig} (${readsPerExistingPerOp.toFixed(3)}/existing object/op); ` +
          `paste ${COUNTED_PASTE_TABLES}→${SCALED_PASTE_TABLES} tables: index elems/op ${elemsSmall.toFixed(1)}→${elemsScaled.toFixed(1)} (×${elemsGrowth.toFixed(2)})`,
      );
      expect(elemsGrowth).toBeLessThan(MAX_INDEX_ELEMS_PER_OP_GROWTH);

      expect(readsPerExistingPerOp).toBeLessThan(MAX_READS_PER_EXISTING_OBJECT_PER_OP);
      expect(planMs).toBeLessThan(BACKSTOP_PLAN_MS);
      expect(execMs).toBeLessThan(BACKSTOP_EXEC_MS);
      expect(execAutoMs).toBeLessThan(BACKSTOP_EXEC_MS);
    }, 600_000);
  }
});
