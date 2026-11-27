// Issue #164：推导名增量化的差分测试与复杂度守卫。
// 参照实现是 main 上原样拷贝的四种方言 refreshDerivedNames（packages/core/test/support/legacy-derived-names.ts），
// 并关闭叠加索引的写入跟踪（等价于 main 的扫描判定）。随机修改序列分别走普通模型、逐个 execute（MCP 逐步预演）、
// 整批 execute('batch') 与 execute('paste')（含带基线对象的起始模型），新旧实现的模型与变更列表必须逐字节一致。
import {
  clonePlain,
  createSchema,
  type Dialect,
  derivedNameStats,
  EditError,
  emptyModel,
  getDialect,
  type Model,
  MutableModelIndex,
  type Obj,
  OverlayModelIndex,
  resetDerivedNameStats,
  runMutator,
  stableJson,
} from '@dowel/core';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { LEGACY_REFRESH } from '../../core/test/support/legacy-derived-names.ts';
import { execute } from '../src/index.ts';

const DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];
const INT: Record<Dialect, string> = { pg: 'integer', sqlite: 'INTEGER', mysql: 'int', mssql: 'int' };

interface Op {
  name: string;
  args: Record<string, unknown>;
}

/** 在参照实现下执行 fn：替换方言的 refreshDerivedNames，并关闭叠加索引写入跟踪 */
const withLegacy = <T>(dialect: Dialect, fn: () => T): T => {
  const refresh = vi
    .spyOn(getDialect(dialect), 'refreshDerivedNames')
    .mockImplementation(LEGACY_REFRESH[dialect]);
  const spy = vi.spyOn(OverlayModelIndex.prototype, 'trackWrites').mockImplementation(() => () => {});
  try {
    return fn();
  } finally {
    refresh.mockRestore();
    spy.mockRestore();
  }
};

afterEach(() => vi.restoreAllMocks());

const schemaOf = (m: Model) => Object.values(m.objects).find((o) => o.kind === 'schema')!.id;

const baseModel = (dialect: Dialect): Model => {
  const m = emptyModel(dialect);
  const sch = createSchema(m, getDialect(dialect).capabilities.defaultSchema, 's0');
  const ops: Op[] = [
    { name: 'createTable', args: { id: 't0', schema: sch, name: 'orders' } },
    { name: 'createTable', args: { id: 't1', schema: sch, name: 'orders_a' } },
  ];
  for (const [t, cols] of [
    ['t0', ['a', 'b', 'a_b']],
    ['t1', ['a', 'b']],
  ] as const) {
    for (const c of cols) {
      ops.push({
        name: 'addColumn',
        args: { table: t, column: { id: `${t}_${c}`, name: c, type: INT[dialect], notNull: c === 'a' } },
      });
    }
  }
  if (getDialect(dialect).capabilities.schemas) {
    const s1 = createSchema(m, 'other', 's1');
    ops.push({ name: 'createTable', args: { id: 't2', schema: s1, name: 'orders' } });
    for (const c of ['a', 'b'] as const) {
      ops.push({
        name: 'addColumn',
        args: { table: 't2', column: { id: `t2_${c}`, name: c, type: INT[dialect] } },
      });
    }
  }
  if (dialect === 'pg') {
    ops.push({ name: 'createTable', args: { id: 'tp', schema: sch, name: 'p' } });
    ops.push({
      name: 'addColumn',
      args: { table: 'tp', column: { id: 'tp_k', name: 'k', type: 'integer' } },
    });
    ops.push({
      name: 'addColumn',
      args: { table: 'tp', column: { id: 'tp_a', name: 'a', type: 'integer' } },
    });
    ops.push({
      name: 'setPartitionBy',
      args: {
        id: 'tp',
        partitionBy: {
          strategy: 'range',
          keys: [{ column: 'tp_k', expr: null, opclass: null, collation: null }],
        },
      },
    });
    ops.push({
      name: 'createPartition',
      args: { id: 'tp1', parent: 'tp', name: 'p_1', bound: 'FOR VALUES FROM (0) TO (10)' },
    });
  }
  for (const op of ops) runMutator(m, op.name, op.args);
  return m;
};

// ───── 随机操作 ─────

/** 抽象操作：kind 选择操作种类，其余数字按当前模型取模挑选对象 */
interface Abstract {
  kind: number;
  a: number;
  b: number;
  c: number;
  flag: boolean;
}

const abstractArb = fc.record<Abstract>({
  kind: fc.nat(99),
  a: fc.nat(1000),
  b: fc.nat(1000),
  c: fc.nat(1000),
  flag: fc.boolean(),
});

const BASE_COL_NAMES = ['a', 'b', 'c', 'a_b', 'x'];
const BASE_TABLE_NAMES = ['orders', 'orders_a', 't', 'orders_check', 'p_1'];

const colNamesFor = (dialect: Dialect): string[] => {
  if (dialect === 'pg') {
    return [...BASE_COL_NAMES, `c_${'y'.repeat(53)}`, `c_${'y'.repeat(52)}w`, '金额列_测试'];
  }
  if (dialect === 'mysql') {
    return [...BASE_COL_NAMES, `c_${'y'.repeat(54)}`, `c_${'y'.repeat(53)}w`];
  }
  return [...BASE_COL_NAMES, `c_${'y'.repeat(118)}`, `c_${'y'.repeat(117)}w`];
};

const tableNamesFor = (dialect: Dialect): string[] => {
  if (dialect === 'pg') {
    return [
      ...BASE_TABLE_NAMES,
      `t_${'x'.repeat(53)}`,
      `t_${'x'.repeat(52)}z`,
      '订单表_长名称_测试标识符名称示例',
    ];
  }
  if (dialect === 'mysql') {
    return [...BASE_TABLE_NAMES, `t_${'x'.repeat(54)}`, `t_${'x'.repeat(53)}z`];
  }
  return [...BASE_TABLE_NAMES, `t_${'x'.repeat(118)}`, `t_${'x'.repeat(117)}z`];
};

const keyNamePool = (dialect: Dialect, tables: string[]): string[] => {
  const out: string[] = ['x', 'PRIMARY_X'];
  if (dialect !== 'pg') out.push('Orders_A_Idx');
  for (const t of tables) {
    if (t.length > 32) continue;
    if (dialect === 'mssql') {
      out.push(
        `CK_${t}`,
        `CK_${t}_1`,
        `CK_${t}_a`,
        `UQ_${t}_a`,
        `PK_${t}`,
        `IX_${t}_a`,
        `DF_${t}_a`,
        `FK_${t}_a`,
        `CK_${t.toUpperCase()}`,
        `CK_${t.toUpperCase()}_1`,
        `CK_${t.toUpperCase()}_A`,
      );
    } else {
      out.push(
        `${t}_check`,
        `${t}_check1`,
        `${t}_a_check`,
        `${t}_a_key`,
        `${t}_pkey`,
        `${t}_a_idx`,
        `${t}_a_fkey`,
      );
      if (dialect === 'pg') out.push(`${t}_a_not_null`, `${t}_check2`);
      else out.push(`${t.toUpperCase()}_CHECK`, `${t.toUpperCase()}_CHECK1`, `${t.toUpperCase()}_A_IDX`);
    }
  }
  return out;
};

const pick = <T>(xs: readonly T[], n: number): T | undefined => (xs.length ? xs[n % xs.length] : undefined);

const KEY_KINDS: ReadonlySet<string> = new Set(['primaryKey', 'unique', 'check', 'foreignKey', 'index']);

const buildOp = (m: Model, a: Abstract, nextId: () => string): Op | null => {
  const dialect = m.dialect;
  const objs = Object.values(m.objects);
  const schemas = objs.filter((o) => o.kind === 'schema');
  const tables = objs.filter((o): o is Extract<Obj, { kind: 'table' }> => o.kind === 'table');
  const cols = objs.filter((o): o is Extract<Obj, { kind: 'column' }> => o.kind === 'column');
  const keys = objs.filter((o) => KEY_KINDS.has(o.kind));
  const checks = keys.filter((o) => o.kind === 'check');
  // 偏向第一张表，让同一张表上积累多个同名序列的约束（删除 / 改名腾出更小后缀的场景）
  const t = a.a % 3 === 0 ? tables[0] : pick(tables, a.a);
  const colsOf = (tid: string) => cols.filter((c) => c.parent === tid);
  const tcols = t ? colsOf(t.id) : [];
  const c1 = pick(tcols, a.b);
  const c2 = pick(tcols, a.c);
  const colNames = colNamesFor(dialect);
  const tableNames = tableNamesFor(dialect);
  const exprFor = (n: number): string | null => {
    if (!c1) return null;
    switch (n % 5) {
      case 0:
        return `${c1.name} > 0`;
      case 1:
        return `${c1.name} > ${c2?.name ?? c1.name}`;
      case 2:
        return `1 = 1`;
      case 3:
        return `${c1.name} + ${c2?.name ?? c1.name} > 1 AND ${c1.name} < 5`;
      default:
        return `${c2?.name ?? c1.name} < 100`;
    }
  };
  const k = a.kind;
  if (k < 22) {
    if (!t) return null;
    const expr = exprFor(a.c);
    return expr ? { name: 'addCheck', args: { id: nextId(), table: t.id, expr } } : null;
  }
  if (k < 28) {
    const ck = pick(checks, a.a);
    if (!ck || !('parent' in ck)) return null;
    const pt = colsOf(ck.parent);
    const x = pick(pt, a.b);
    const y = pick(pt, a.c);
    if (!x) return null;
    const expr = a.flag ? `${x.name} > ${y?.name ?? x.name}` : `${x.name} <> 3`;
    return { name: 'setCheckExpr', args: { id: ck.id, expr } };
  }
  if (k < 36) {
    if (!t || !c1) return null;
    const columns = a.flag && c2 && c2.id !== c1.id ? [c1.id, c2.id] : [c1.id];
    return { name: 'addUnique', args: { id: nextId(), table: t.id, columns } };
  }
  if (k < 42) {
    if (!t || !c1) return null;
    const elements = a.flag ? [{ column: c1.id }] : [{ expr: `lower(${c1.name})` }];
    return { name: 'addIndex', args: { id: nextId(), table: t.id, elements } };
  }
  if (k < 47) {
    if (!t || !c1) return null;
    const ref = pick(tables, a.c);
    if (!ref) return null;
    const rc = pick(colsOf(ref.id), a.b);
    if (!rc) return null;
    return {
      name: 'addForeignKey',
      args: { id: nextId(), table: t.id, columns: [c1.id], refTable: ref.id, refColumns: [rc.id] },
    };
  }
  if (k < 50) {
    if (!t || !c1) return null;
    return a.flag
      ? { name: 'addPrimaryKey', args: { id: nextId(), table: t.id, columns: [c1.id] } }
      : { name: 'setPrimaryKey', args: { id: nextId(), table: t.id, columns: [c1.id] } };
  }
  if (k < 57) {
    const key = pick(keys, a.a);
    return key ? { name: 'dropKey', args: { id: key.id } } : null;
  }
  if (k < 64) {
    const key = pick(keys, a.a);
    const name = pick(
      keyNamePool(
        dialect,
        tables.map((x) => x.name),
      ),
      a.b,
    );
    return key && name ? { name: 'renameKey', args: { id: key.id, name } } : null;
  }
  if (k < 68) {
    const key = pick(keys, a.a);
    return key ? { name: 'resetKeyName', args: { id: key.id } } : null;
  }
  if (k < 73) {
    const c = pick(cols, a.a);
    const name = pick(colNames, a.b)!;
    return c ? { name: 'renameColumn', args: { id: c.id, name } } : null;
  }
  if (k < 77) {
    if (!t) return null;
    const column: Record<string, unknown> = {
      id: nextId(),
      name: pick(colNames, a.b)!,
      type: INT[dialect],
      notNull: a.flag,
    };
    if (dialect === 'mssql' && a.c % 2 === 0) column.default = { expr: '((0))' };
    if (dialect === 'pg' && a.c % 3 === 0) column.identity = { always: false };
    // serial 展开成归属序列（推导名 <表>_<列>_seq）
    if (dialect === 'pg' && a.c % 3 === 1) column.type = 'serial';
    return { name: 'addColumn', args: { table: t.id, column } };
  }
  if (k < 80) {
    const c = pick(cols, a.a);
    return c ? { name: 'dropColumn', args: { id: c.id } } : null;
  }
  if (k < 84) {
    const c = pick(cols, a.a);
    return c ? { name: 'setNotNull', args: { id: c.id, notNull: !c.notNull } } : null;
  }
  if (k < 87) {
    const c = pick(cols, a.a);
    if (!c) return null;
    if (dialect === 'pg' && a.flag) {
      return { name: 'setIdentity', args: { id: c.id, identity: c.identity ? null : { always: false } } };
    }
    return { name: 'setDefault', args: { id: c.id, default: c.default ? null : { expr: '((1))' } } };
  }
  if (k < 91) {
    if (!t) return null;
    return { name: 'renameTable', args: { id: t.id, name: pick(tableNames, a.b)! } };
  }
  if (k < 94) {
    return {
      name: 'createTable',
      args: { id: nextId(), schema: pick(schemas, a.c)?.id ?? schemaOf(m), name: pick(tableNames, a.b)! },
    };
  }
  if (k < 96) {
    const victim = pick(
      tables.filter((x) => x.id !== 'tp'),
      a.a,
    );
    return victim ? { name: 'dropTable', args: { id: victim.id } } : null;
  }
  if (k === 99) {
    const c = pick(cols, a.a);
    if (!c) return null;
    const other = pick(colsOf(c.parent), a.b);
    return { name: 'moveColumn', args: { id: c.id, before: a.flag && other ? other.id : null } };
  }
  if (k === 98 && dialect === 'pg') {
    const child = pick(
      tables.filter((x) => x.id !== 'tp'),
      a.a,
    );
    if (!child) return null;
    const lo = (a.b % 50) * 10 + 600;
    return child.partitionOf
      ? { name: 'detachPartition', args: { id: child.id } }
      : {
          name: 'attachPartition',
          args: { parent: 'tp', child: child.id, bound: `FOR VALUES FROM (${lo}) TO (${lo + 10})` },
        };
  }
  if (dialect === 'pg' && Object.hasOwn(m.objects, 'tp')) {
    const lo = (a.b % 50) * 10 + 10;
    return {
      name: 'createPartition',
      args: {
        id: nextId(),
        parent: 'tp',
        name: pick(tableNames, a.c)!,
        bound: `FOR VALUES FROM (${lo}) TO (${lo + 10})`,
      },
    };
  }
  return null;
};

const tryRun = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof EditError) return e.message;
    throw e;
  }
};

/** 普通模型逐步执行：新旧实现每一步的模型（或错误）都相同；返回成功执行的操作 */
const runPlainDifferential = (dialect: Dialect, abstracts: Abstract[]): Op[] => {
  const cur = baseModel(dialect);
  const ref = clonePlain(cur);
  let n = 0;
  const nextId = () => `n${++n}`;
  const ok: Op[] = [];
  for (const a of abstracts) {
    const op = buildOp(cur, a, nextId);
    if (!op) continue;
    const errNew = tryRun(() => runMutator(cur, op.name, op.args));
    const errOld = withLegacy(dialect, () => tryRun(() => runMutator(ref, op.name, op.args)));
    expect(errNew, `${op.name} ${JSON.stringify(op.args)}`).toBe(errOld);
    expect(stableJson(cur), `${op.name} ${JSON.stringify(op.args)}`).toBe(stableJson(ref));
    if (!errNew) ok.push(op);
  }
  return ok;
};

/** 同步层逐个 execute（共享 MutableModelIndex，MCP 逐步预演的形态） */
const runStepwiseFrom = (start: Model, ops: Op[], legacy: boolean) => {
  let m = start;
  const idx = new MutableModelIndex(m);
  const trace: string[] = [];
  for (const op of ops) {
    let res: ReturnType<typeof execute>;
    try {
      res = legacy
        ? withLegacy(m.dialect, () => execute(m, op.name, op.args, idx))
        : execute(m, op.name, op.args, idx);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      trace.push(`error: ${e.message}`);
      continue;
    }
    trace.push(stableJson(res.changes));
    idx.applyBatch(
      res.next,
      res.changes.map((c) => ({
        id: c.id,
        prev: m.objects[c.id],
        next: c.obj ? res.next.objects[c.id] : undefined,
      })),
    );
    m = res.next;
  }
  return { model: m, modelJson: stableJson(m), trace };
};

const runCompositeFrom = (
  start: Model,
  name: 'batch' | 'paste',
  ops: Op[],
  legacy: boolean,
  withIdx: boolean,
) => {
  const run = () => {
    try {
      const res = execute(start, name, { ops }, withIdx ? new MutableModelIndex(start) : undefined);
      return { model: stableJson(res.next), changes: stableJson(res.changes) };
    } catch (e) {
      if (e instanceof EditError) return { error: e.message };
      throw e;
    }
  };
  return legacy ? withLegacy(start.dialect, run) : run();
};

const pasteSeedOps = (dialect: Dialect): Op[] => [
  { name: 'addCheck', args: { id: 'seed_ck0', table: 't0', expr: '1 = 1' } },
  { name: 'addCheck', args: { id: 'seed_ck1', table: 't0', expr: 'a > 0' } },
  { name: 'addUnique', args: { id: 'seed_uq0', table: 't0', columns: ['t0_a'] } },
  { name: 'addIndex', args: { id: 'seed_ix0', table: 't1', elements: [{ column: 't1_b' }] } },
  { name: 'addCheck', args: { id: 'seed_ck_exp', table: 't0', expr: 'b > 0' } },
  {
    name: 'renameKey',
    args: { id: 'seed_ck_exp', name: dialect === 'mssql' ? 'CK_orders_1' : 'orders_check1' },
  },
];

describe('推导名增量化与 main 参照实现逐字节一致（Issue #164）', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 随机修改序列（普通模型 / 逐个 execute / 整批 batch，含基线预置）`, () => {
      fc.assert(
        fc.property(
          fc.array(abstractArb, { minLength: 5, maxLength: 45 }),
          fc.nat(100),
          (abstracts, split) => {
            const ops = runPlainDifferential(dialect, abstracts);
            const fullNew = runStepwiseFrom(baseModel(dialect), ops, false);
            const fullRef = runStepwiseFrom(baseModel(dialect), ops, true);
            expect(fullNew.modelJson).toBe(fullRef.modelJson);
            expect(fullNew.trace).toEqual(fullRef.trace);
            if (ops.length) {
              expect(runCompositeFrom(baseModel(dialect), 'batch', ops, false, true)).toEqual(
                runCompositeFrom(baseModel(dialect), 'batch', ops, true, true),
              );
            }
            if (ops.length >= 2) {
              const prefixLen = 1 + (split % (ops.length - 1));
              const prefix = ops.slice(0, prefixLen);
              const rest = ops.slice(prefixLen);
              const seeded = runStepwiseFrom(baseModel(dialect), prefix, false).model;
              const batchNew = runCompositeFrom(seeded, 'batch', rest, false, true);
              const batchRef = runCompositeFrom(seeded, 'batch', rest, true, true);
              const stepNew = runStepwiseFrom(seeded, rest, false);
              const stepRef = runStepwiseFrom(seeded, rest, true);
              expect(batchNew).toEqual(batchRef);
              expect(stepNew.modelJson).toBe(stepRef.modelJson);
              expect(stepNew.trace).toEqual(stepRef.trace);
              // 少数序列里同一张表上两个既有对象在叠加层被逆序改写后又触发压缩时，OverlayModelIndex.allChildrenOf 的
              // 插入顺序会使参照实现本身的 batch 也与逐步不同（既有遍历顺序差异）；其余情况 batch 与逐步一致。
              if (!('error' in batchRef) && batchRef.model === stepRef.modelJson) {
                expect('error' in batchNew ? '' : batchNew.model).toBe(stepNew.modelJson);
              }
            }
          },
        ),
        { numRuns: Number(process.env.RUNS164 ?? 250), seed: Number(process.env.SEED164 ?? 164) },
      );
    });

    test(`${dialect}: 粘贴同一张表的大量约束（显式名 / 推导名交错、撞名，含基线表与新建表）`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ kind: fc.nat(9), a: fc.nat(100), b: fc.nat(100), named: fc.nat(3) }), {
            minLength: 1,
            maxLength: 60,
          }),
          fc.boolean(),
          (items, ontoExisting) => {
            const seeded = runStepwiseFrom(baseModel(dialect), pasteSeedOps(dialect), false).model;
            const sch = schemaOf(seeded);
            const targetTable = ontoExisting ? 't0' : 'pt';
            const targetTableName = ontoExisting ? 'orders' : 'orders_b';
            const ops: Op[] = ontoExisting
              ? []
              : [{ name: 'createTable', args: { id: 'pt', schema: sch, name: 'orders_b' } }];
            const colIds = ontoExisting ? ['t0_a', 't0_b', 't0_a_b'] : ['pt_a', 'pt_b', 'pt_a_b'];
            if (!ontoExisting) {
              for (const c of ['a', 'b', 'a_b']) {
                ops.push({
                  name: 'addColumn',
                  args: { table: 'pt', column: { id: `pt_${c}`, name: c, type: INT[dialect] } },
                });
              }
            }
            const names = keyNamePool(dialect, [targetTableName, 'orders', 'orders_a']);
            const cn = ['a', 'b', 'a_b'];
            let n = 0;
            for (const it of items) {
              const id = `pk${++n}`;
              const ca = colIds[it.a % 3]!;
              const cb = colIds[it.b % 3]!;
              if (it.kind < 5) {
                const expr =
                  it.a % 3 === 0 ? `${cn[it.a % 3]} > 0` : `${cn[it.a % 3]} > ${cn[it.b % 3]} AND b < 9`;
                ops.push({ name: 'addCheck', args: { id, table: targetTable, expr } });
              } else if (it.kind < 7) {
                ops.push({
                  name: 'addUnique',
                  args: { id, table: targetTable, columns: ca === cb ? [ca] : [ca, cb] },
                });
              } else if (it.kind < 9) {
                ops.push({ name: 'addIndex', args: { id, table: targetTable, elements: [{ column: ca }] } });
              } else {
                ops.push({
                  name: 'addForeignKey',
                  args: {
                    id,
                    table: targetTable,
                    columns: [ca],
                    refTable: ontoExisting ? 't1' : 't0',
                    refColumns: [ontoExisting ? 't1_a' : 't0_a'],
                  },
                });
              }
              if (it.named === 0)
                ops.push({
                  name: 'renameKey',
                  args: { id, name: `${names[(it.a + it.b) % names.length]}_${n}` },
                });
              if (it.named === 1)
                ops.push({ name: 'renameKey', args: { id, name: names[(it.a * 7 + it.b) % names.length]! } });
              // 给更早建的对象起显式名：腾出的推导名会让后面同序列的对象在下一趟里改用更小的后缀
              if (it.named === 2 && n > 1)
                ops.push({
                  name: 'renameKey',
                  args: { id: `pk${1 + ((it.a + it.b) % (n - 1))}`, name: `explicit_${n}` },
                });
            }
            const got = runCompositeFrom(seeded, 'paste', ops, false, true);
            const want = runCompositeFrom(seeded, 'paste', ops, true, true);
            expect(got).toEqual(want);
            expect(runCompositeFrom(seeded, 'paste', ops, false, false)).toEqual(
              runCompositeFrom(seeded, 'paste', ops, true, false),
            );
            if (!('error' in want)) {
              const stepNew = runStepwiseFrom(seeded, ops, false);
              const stepRef = runStepwiseFrom(seeded, ops, true);
              expect(stepNew.modelJson).toBe(stepRef.modelJson);
              if (want.model === stepRef.modelJson) {
                expect('error' in got ? '' : got.model).toBe(stepNew.modelJson);
              }
            }
          },
        ),
        { numRuns: Number(process.env.RUNS164 ?? 150), seed: Number(process.env.SEED164 ?? 1640) },
      );
    });
  }
});

// ───── 固定回归用例 ─────

const assertBatchMatchesLegacyAndStepwise = (seeded: Model, batchOps: Op[]): Model => {
  const batchNew = runCompositeFrom(seeded, 'batch', batchOps, false, true);
  const batchRef = runCompositeFrom(seeded, 'batch', batchOps, true, true);
  const stepNew = runStepwiseFrom(seeded, batchOps, false);
  const stepRef = runStepwiseFrom(seeded, batchOps, true);
  expect(batchNew).toEqual(batchRef);
  expect(runCompositeFrom(seeded, 'batch', batchOps, false, false)).toEqual(
    runCompositeFrom(seeded, 'batch', batchOps, true, false),
  );
  expect(stepNew.modelJson).toBe(stepRef.modelJson);
  expect(stepNew.trace).toEqual(stepRef.trace);
  expect('error' in batchNew ? '' : batchNew.model).toBe(stepNew.modelJson);
  return stepNew.model;
};

describe('回归用例：跨表删表腾名、认证不动点与重名失效', () => {
  test('pg: 同一次 execute 内 dropTable 腾出跨表 index 推导名并压缩他表索引', () => {
    const seeded = runStepwiseFrom(
      baseModel('pg'),
      [
        { name: 'addIndex', args: { id: 'k0', table: 't0', elements: [{ column: 't0_a_b' }] } },
        { name: 'addIndex', args: { id: 'k1', table: 't1', elements: [{ column: 't1_b' }] } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const k1 = after.objects.k1;
    expect(k1?.kind === 'index' && k1.name).toBe('orders_a_b_idx');
  });

  test('pg: 同一次 execute 内 dropTable 腾出跨表 unique 推导名', () => {
    const seeded = runStepwiseFrom(
      baseModel('pg'),
      [
        { name: 'addUnique', args: { id: 'u0', table: 't0', columns: ['t0_a_b'] } },
        { name: 'addUnique', args: { id: 'u1', table: 't1', columns: ['t1_b'] } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const u1 = after.objects.u1;
    expect(u1?.kind === 'unique' && u1.name).toBe('orders_a_b_key');
  });

  test('pg: 同一次 execute 内 dropTable 腾出跨表 identity 序列推导名', () => {
    const seeded = runStepwiseFrom(
      baseModel('pg'),
      [
        { name: 'setIdentity', args: { id: 't0_a_b', identity: { always: false } } },
        { name: 'setIdentity', args: { id: 't1_b', identity: { always: false } } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const col = after.objects.t1_b;
    expect(col?.kind === 'column' && col.identity?.sequenceName).toBe('orders_a_b_seq');
  });

  test('pg: 同一次 execute 内 dropTable / dropColumn 腾出 serial 归属序列推导名', () => {
    const seeded = runStepwiseFrom(
      baseModel('pg'),
      [
        { name: 'dropColumn', args: { id: 't0_a_b' } },
        { name: 'dropColumn', args: { id: 't1_b' } },
        { name: 'addColumn', args: { table: 't0', column: { id: 't0_ser', name: 'a_b', type: 'serial' } } },
        { name: 'addColumn', args: { table: 't1', column: { id: 't1_ser', name: 'b', type: 'serial' } } },
      ],
      false,
    ).model;
    const seqIdOf = (m: Model, colId: string) =>
      Object.values(m.objects).find((o) => o.kind === 'sequence' && o.ownedBy === colId)?.id;
    const t1SeqId = seqIdOf(seeded, 't1_ser')!;
    expect(t1SeqId).toBeTruthy();

    const afterDropTable = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const seqAfterTable = afterDropTable.objects[t1SeqId];
    expect(seqAfterTable?.kind === 'sequence' && seqAfterTable.name).toBe('orders_a_b_seq');

    const afterDropCol = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropColumn', args: { id: 't0_ser' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const seqAfterCol = afterDropCol.objects[t1SeqId];
    expect(seqAfterCol?.kind === 'sequence' && seqAfterCol.name).toBe('orders_a_b_seq');
  });

  test('mssql: 同一次 execute 内 dropTable 腾出跨表 schema 级 CHECK 推导名', () => {
    const seeded = runStepwiseFrom(
      baseModel('mssql'),
      [
        { name: 'addCheck', args: { id: 'ck0', table: 't0', expr: 'a_b > 0' } },
        { name: 'addCheck', args: { id: 'ck1', table: 't1', expr: 'b > 0' } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const ck1 = after.objects.ck1;
    expect(ck1?.kind === 'check' && ck1.name).toBe('CK_orders_a_b');
  });

  test('mssql: 同一次 execute 内 dropTable 腾出跨表带名 DEFAULT 推导名', () => {
    const seeded = runStepwiseFrom(
      baseModel('mssql'),
      [
        { name: 'setDefault', args: { id: 't0_a_b', default: { expr: '((0))' } } },
        { name: 'setDefault', args: { id: 't1_b', default: { expr: '((0))' } } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    const col = after.objects.t1_b;
    expect(col?.kind === 'column' && col.ext?.mssql?.defaultName).toBe('DF_orders_a_b');
  });

  for (const dialect of DIALECTS) {
    test(`${dialect}: 未过不动点认证时不得走快路径（杀死 certified 恒真变异体）`, () => {
      const seeded = runStepwiseFrom(
        baseModel(dialect),
        [
          { name: 'addCheck', args: { id: 'ckB', table: 't0', expr: '1 = 1' } },
          { name: 'addCheck', args: { id: 'ckA', table: 't0', expr: '2 = 2' } },
        ],
        false,
      ).model;
      const after = assertBatchMatchesLegacyAndStepwise(seeded, [
        { name: 'setCheckExpr', args: { id: 'ckB', expr: 'a > 0' } },
        { name: 'addCheck', args: { id: 'ckC', table: 't0', expr: '3 = 3' } },
      ]);
      const ckA = after.objects.ckA;
      const ckC = after.objects.ckC;
      expect(ckA?.kind === 'check' && ckA.name).toBe(dialect === 'mssql' ? 'CK_orders' : 'orders_check');
      expect(ckC?.kind === 'check' && ckC.name).toBe(dialect === 'mssql' ? 'CK_orders_1' : 'orders_check1');
    });
  }

  test('mssql: setColumnExt 写入与他表推导名冲突的显式 defaultName 时触发 noteDup 取消认证', () => {
    const seeded = runStepwiseFrom(
      baseModel('mssql'),
      [
        { name: 'setDefault', args: { id: 't0_a', default: { expr: '((0))' } } },
        { name: 'addCheck', args: { id: 'ck1', table: 't1', expr: '1 = 1' } },
      ],
      false,
    ).model;
    const after = assertBatchMatchesLegacyAndStepwise(seeded, [
      { name: 'addCheck', args: { id: 'ck2', table: 't1', expr: '2 = 2' } },
      {
        name: 'setColumnExt',
        args: { id: 't0_a', ext: { mssql: { defaultName: 'CK_orders_a', defaultNameMode: 'explicit' } } },
      },
      { name: 'addCheck', args: { id: 'ck3', table: 't1', expr: '3 = 3' } },
    ]);
    const ck1 = after.objects.ck1;
    expect(ck1?.kind === 'check' && ck1.name).not.toBe('CK_orders_a');
  });
});

// ───── 复杂度守卫：确定性计数，不依赖墙钟 ─────

const pasteOps = (dialect: Dialect, n: number, kind: 'check' | 'unique' | 'index' | 'foreignKey'): Op[] => {
  const ops: Op[] = [{ name: 'createTable', args: { id: 'big', schema: 's0', name: 'big' } }];
  const cols = ['a', 'b', 'c', 'd'];
  for (const c of cols) {
    ops.push({
      name: 'addColumn',
      args: { table: 'big', column: { id: `big_${c}`, name: c, type: INT[dialect] } },
    });
  }
  for (let i = 0; i < n; i++) {
    const id = `k${i}`;
    if (kind === 'check') {
      // 约 400 字节、引用多列的表达式：推导名都是 big_check、big_check1……（同一命名序列，最坏情况）
      let e = '';
      for (let j = 0; e.length < 380; j++) e += `${e ? ' AND ' : ''}${cols[j % 4]} + ${i} > ${j}`;
      ops.push({ name: 'addCheck', args: { id, table: 'big', expr: e } });
    } else if (kind === 'unique') {
      ops.push({ name: 'addUnique', args: { id, table: 'big', columns: ['big_a', 'big_b'] } });
    } else if (kind === 'index') {
      ops.push({ name: 'addIndex', args: { id, table: 'big', elements: [{ column: 'big_a' }] } });
    } else {
      ops.push({
        name: 'addForeignKey',
        args: { id, table: 'big', columns: ['big_a'], refTable: 'ref', refColumns: ['ref_id'] },
      });
    }
  }
  return ops;
};

const countPaste = (dialect: Dialect, n: number, kind: 'check' | 'unique' | 'index' | 'foreignKey') => {
  const m = emptyModel(dialect);
  createSchema(m, getDialect(dialect).capabilities.defaultSchema, 's0');
  runMutator(m, 'createTable', { id: 'ref', schema: 's0', name: 'ref' });
  runMutator(m, 'addColumn', {
    table: 'ref',
    column: { id: 'ref_id', name: 'id', type: INT[dialect], notNull: true },
  });
  runMutator(m, 'addPrimaryKey', { id: 'ref_pk', table: 'ref', columns: ['ref_id'] });
  resetDerivedNameStats();
  const res = execute(m, 'paste', { ops: pasteOps(dialect, n, kind) }, new MutableModelIndex(m));
  expect(res.changes.length).toBeGreaterThan(n);
  return { ...derivedNameStats };
};

describe('复杂度守卫：同一张表上粘贴 N 个约束 / 索引，推导名工作量近似线性', () => {
  for (const dialect of DIALECTS) {
    for (const kind of ['check', 'unique', 'index', 'foreignKey'] as const) {
      test(`${dialect}: ${kind} × 100 → × 400`, () => {
        const small = countPaste(dialect, 100, kind);
        const large = countPaste(dialect, 400, kind);
        // 线性时 4 倍；原实现（每加一个全表重算 + 逐个后缀试探）约 16～64 倍
        for (const k of ['slotVisits', 'probes', 'exprLexes'] as const) {
          expect(large[k], `${k}: ${small[k]} → ${large[k]}`).toBeLessThanOrEqual(Math.max(5 * small[k], 50));
        }
        expect(large.fullPasses).toBeLessThanOrEqual(small.fullPasses + 2);
        expect(large.probes).toBeLessThan(20 * 400);
      });
    }
  }
});

describe('分词缓存守卫：普通模型逐条 addCheck 与 >4096 条 CHECK 均不重复分词', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 普通模型逐条 addCheck × 100 的 exprLexes ≤ 100`, () => {
      const m = emptyModel(dialect);
      const sch = createSchema(m, getDialect(dialect).capabilities.defaultSchema, 's0');
      runMutator(m, 'createTable', { id: 'big', schema: sch, name: 'big' });
      for (const c of ['a', 'b', 'c', 'd']) {
        runMutator(m, 'addColumn', {
          table: 'big',
          column: { id: `big_${c}`, name: c, type: INT[dialect] },
        });
      }
      resetDerivedNameStats();
      for (let i = 0; i < 100; i++) {
        runMutator(m, 'addCheck', {
          id: `ck${i}`,
          table: 'big',
          expr: `a + b + ${i} > ${10000 + i} AND c + d > ${i}`,
        });
      }
      expect(derivedNameStats.exprLexes).toBeLessThanOrEqual(100);
    });
  }

  test('pg: 表上超过 4096 条不同 CHECK 时续加不再触发全表重分词', () => {
    const m0 = emptyModel('pg');
    const sch = createSchema(m0, 'public', 's0');
    runMutator(m0, 'createTable', { id: 'big', schema: sch, name: 'big' });
    runMutator(m0, 'addColumn', { table: 'big', column: { id: 'big_a', name: 'a', type: 'integer' } });
    runMutator(m0, 'addColumn', { table: 'big', column: { id: 'big_b', name: 'b', type: 'integer' } });
    const ops: Op[] = [];
    for (let i = 0; i < 4500; i++) {
      ops.push({ name: 'addCheck', args: { id: `ck${i}`, table: 'big', expr: `a + b > ${50000 + i}` } });
    }
    const idx = new MutableModelIndex(m0);
    const init = execute(m0, 'paste', { ops }, idx);
    idx.applyBatch(
      init.next,
      init.changes.map((c) => ({
        id: c.id,
        prev: m0.objects[c.id],
        next: c.obj ? init.next.objects[c.id] : undefined,
      })),
    );
    let cur = init.next;
    resetDerivedNameStats();
    for (let k = 0; k < 3; k++) {
      const res = execute(
        cur,
        'addCheck',
        { id: `extra_${k}`, table: 'big', expr: `a + b > ${60000 + k}` },
        idx,
      );
      idx.applyBatch(
        res.next,
        res.changes.map((c) => ({
          id: c.id,
          prev: cur.objects[c.id],
          next: c.obj ? res.next.objects[c.id] : undefined,
        })),
      );
      cur = res.next;
    }
    expect(derivedNameStats.exprLexes).toBeLessThanOrEqual(3);
  });
});
