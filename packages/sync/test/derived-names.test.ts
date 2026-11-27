// Issue #164：推导名增量化的差分测试与复杂度守卫。
// 参照实现是 main 上原样拷贝的四种方言 refreshDerivedNames（packages/core/test/support/legacy-derived-names.ts），
// 并关闭叠加索引的写入跟踪（等价于 main 的扫描判定）。随机修改序列分别走普通模型、逐个 execute（MCP 逐步预演）、
// 整批 execute('batch') 与 execute('paste')，新旧实现的模型与变更列表必须逐字节一致。
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

const COL_NAMES = ['a', 'b', 'c', 'a_b', 'x'];
const TABLE_NAMES = ['orders', 'orders_a', 't', 'orders_check', 'p_1'];

const keyNamePool = (dialect: Dialect, tables: string[]): string[] => {
  const out: string[] = ['x', 'PRIMARY_X'];
  for (const t of tables) {
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
    }
  }
  return out;
};

const pick = <T>(xs: readonly T[], n: number): T | undefined => (xs.length ? xs[n % xs.length] : undefined);

const KEY_KINDS: ReadonlySet<string> = new Set(['primaryKey', 'unique', 'check', 'foreignKey', 'index']);

const buildOp = (m: Model, a: Abstract, nextId: () => string): Op | null => {
  const dialect = m.dialect;
  const objs = Object.values(m.objects);
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
    const name = pick(COL_NAMES, a.b)!;
    return c ? { name: 'renameColumn', args: { id: c.id, name } } : null;
  }
  if (k < 77) {
    if (!t) return null;
    const column: Record<string, unknown> = {
      id: nextId(),
      name: pick(COL_NAMES, a.b)!,
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
    return { name: 'renameTable', args: { id: t.id, name: pick(TABLE_NAMES, a.b)! } };
  }
  if (k < 94) {
    return {
      name: 'createTable',
      args: { id: nextId(), schema: schemaOf(m), name: pick(TABLE_NAMES, a.b)! },
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
        name: pick(TABLE_NAMES, a.c)!,
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
const runStepwise = (dialect: Dialect, ops: Op[], legacy: boolean) => {
  let m = baseModel(dialect);
  const idx = new MutableModelIndex(m);
  const trace: string[] = [];
  for (const op of ops) {
    let res: ReturnType<typeof execute>;
    try {
      res = legacy
        ? withLegacy(dialect, () => execute(m, op.name, op.args, idx))
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
  return { model: stableJson(m), trace };
};

const runComposite = (
  dialect: Dialect,
  name: 'batch' | 'paste',
  ops: Op[],
  legacy: boolean,
  withIdx: boolean,
) => {
  const m = baseModel(dialect);
  const run = () => {
    try {
      const res = execute(m, name, { ops }, withIdx ? new MutableModelIndex(m) : undefined);
      return { model: stableJson(res.next), changes: stableJson(res.changes) };
    } catch (e) {
      if (e instanceof EditError) return { error: e.message };
      throw e;
    }
  };
  return legacy ? withLegacy(dialect, run) : run();
};

describe('推导名增量化与 main 参照实现逐字节一致（Issue #164）', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 随机修改序列（普通模型 / 逐个 execute / 整批 batch）`, () => {
      fc.assert(
        fc.property(fc.array(abstractArb, { minLength: 5, maxLength: 45 }), (abstracts) => {
          const ops = runPlainDifferential(dialect, abstracts);
          expect(runStepwise(dialect, ops, false)).toEqual(runStepwise(dialect, ops, true));
          if (ops.length) {
            expect(runComposite(dialect, 'batch', ops, false, true)).toEqual(
              runComposite(dialect, 'batch', ops, true, true),
            );
          }
        }),
        { numRuns: Number(process.env.RUNS164 ?? 250), seed: Number(process.env.SEED164 ?? 164) },
      );
    });

    test(`${dialect}: 粘贴同一张表的大量约束（显式名 / 推导名交错、撞名）`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.record({ kind: fc.nat(9), a: fc.nat(100), b: fc.nat(100), named: fc.nat(3) }), {
            minLength: 1,
            maxLength: 60,
          }),
          (items) => {
            const m = baseModel(dialect);
            const sch = schemaOf(m);
            const ops: Op[] = [{ name: 'createTable', args: { id: 'pt', schema: sch, name: 'orders_b' } }];
            const colIds: string[] = [];
            for (const c of ['a', 'b', 'a_b']) {
              const id = `pt_${c}`;
              colIds.push(id);
              ops.push({
                name: 'addColumn',
                args: { table: 'pt', column: { id, name: c, type: INT[dialect] } },
              });
            }
            const names = keyNamePool(dialect, ['orders_b', 'orders']);
            let n = 0;
            for (const it of items) {
              const id = `pk${++n}`;
              const ca = colIds[it.a % 3]!;
              const cb = colIds[it.b % 3]!;
              const cn = ['a', 'b', 'a_b'];
              if (it.kind < 5) {
                const expr =
                  it.a % 3 === 0 ? `${cn[it.a % 3]} > 0` : `${cn[it.a % 3]} > ${cn[it.b % 3]} AND b < 9`;
                ops.push({ name: 'addCheck', args: { id, table: 'pt', expr } });
              } else if (it.kind < 7) {
                ops.push({
                  name: 'addUnique',
                  args: { id, table: 'pt', columns: ca === cb ? [ca] : [ca, cb] },
                });
              } else if (it.kind < 9) {
                ops.push({ name: 'addIndex', args: { id, table: 'pt', elements: [{ column: ca }] } });
              } else {
                ops.push({
                  name: 'addForeignKey',
                  args: { id, table: 'pt', columns: [ca], refTable: 't0', refColumns: ['t0_a'] },
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
            // 撞名的 renameKey 会让整批失败：新旧实现必须给出同样的错误
            const outcome = (legacy: boolean, withIdx: boolean) => {
              try {
                return runComposite(dialect, 'paste', ops, legacy, withIdx);
              } catch (e) {
                if (e instanceof EditError) return { error: e.message };
                throw e;
              }
            };
            const want = outcome(true, true);
            expect(outcome(false, true)).toEqual(want);
            expect(outcome(false, false)).toEqual(outcome(true, false));
          },
        ),
        { numRuns: Number(process.env.RUNS164 ?? 150), seed: Number(process.env.SEED164 ?? 1640) },
      );
    });
  }
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
