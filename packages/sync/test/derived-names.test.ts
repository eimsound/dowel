// Issue #164：稳定推导名引擎的差分测试、不变式检查与复杂度守卫。
// 语义（见 packages/core/src/derived-names.ts）：推导名只在自身输入变化、撞名或 resetKeyName 时重算，
// 同表其他对象保留名字（不再级联压缩）；需要重算的取命名序列里最小的空位。
// 1. 随机修改序列分别走普通模型、逐个 execute（共享索引，MCP 逐步预演形态）、无索引 execute、整批 batch / paste
//    （含先提交一段前缀让对象进到基线），模型、变更列表与错误信息必须逐字节一致；
// 2. 普通模型每一步后检查不变式：推导名有效且不撞名、未受影响的对象名字不变、重算的对象取到最小空位；
// 3. 确定性计数守卫（不依赖墙钟）：大表单步 execute、交错 addColumn / addCheck、交错 renameKey / dropKey / addCheck、
//    MCP 500 步预演、batchReadsOf、分词缓存，以及工作量预算熔断（病态改表名 / 改列名循环抛 EditError 并原子回滚）。
import {
  clonePlain,
  createSchema,
  DERIVED_NAME_WORK_BUDGET,
  type Dialect,
  DerivedNameBudget,
  DerivedNameBudgetError,
  derivedNameStats,
  EditError,
  emptyModel,
  getDialect,
  type Model,
  MutableModelIndex,
  type Obj,
  partitionAncestors,
  partitionDescendants,
  readsOf,
  resetDerivedNameStats,
  rootTableId,
  runMutator,
  stableJson,
} from '@dowel/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  candIndex,
  dialectNaming,
  type NamingView,
  type NameSpec,
  SLOT_OBJ_KINDS,
  slotTableOf,
} from '../../core/src/derived-names.ts';
import { colNs, nameEntriesOf, type NsEntry } from '../../core/src/naming-ns.ts';
import { execute, indexedBatchStepper, opReads } from '../src/index.ts';

const DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];
const INT: Record<Dialect, string> = { pg: 'integer', sqlite: 'INTEGER', mysql: 'int', mssql: 'int' };

interface Op {
  name: string;
  args: Record<string, unknown>;
}

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

// ───── 独立的扫描视图（不复用引擎里的视图实现），供不变式检查计算规格与占用 ─────

class TestView implements NamingView {
  readonly owners = new Map<string, Map<string, Set<string>>>();
  private readonly m: Model;
  constructor(m: Model) {
    this.m = m;
    const tableOf = (id: string) => {
      const t = m.objects[id];
      return t?.kind === 'table' ? t : undefined;
    };
    for (const o of Object.values(m.objects)) {
      const es: NsEntry[] = [];
      nameEntriesOf(m.dialect, o, tableOf, es);
      for (const e of es) {
        let byName = this.owners.get(e.ns);
        if (!byName) this.owners.set(e.ns, (byName = new Map()));
        let set = byName.get(e.name);
        if (!set) byName.set(e.name, (set = new Set()));
        set.add(e.owner);
      }
    }
  }
  ownersOf(ns: string, name: string): ReadonlySet<string> {
    return this.owners.get(ns)?.get(name) ?? new Set();
  }
  hasOther(ns: string, name: string, self: string) {
    return [...this.ownersOf(ns, name)].some((o) => o !== self);
  }
  hasAny(ns: string, name: string) {
    return this.ownersOf(ns, name).size > 0;
  }
  columnIdByName(tableId: string, norm: string) {
    return [...this.ownersOf(colNs(tableId), norm)][0];
  }
  ancestors(tableId: string) {
    return partitionAncestors(this.m, tableId).map((t) => t.id);
  }
  descendants(tableId: string) {
    return partitionDescendants(this.m, tableId).map((t) => t.id);
  }
  rootOf(tableId: string) {
    return rootTableId(this.m, tableId);
  }
  written() {}
}

interface SlotInfo {
  obj: string;
  table: string;
  spec: NameSpec;
  cur: string;
  j: number;
  /** 当前名字被别的对象占用 */
  clash: boolean;
}

/** 模型里全部推导名槽位（含规格、序号与是否撞名） */
const slotInfos = (m: Model): Map<string, SlotInfo> => {
  const view = new TestView(m);
  const naming = dialectNaming(m.dialect);
  const out = new Map<string, SlotInfo>();
  const taken = (spec: NameSpec, norm: string, self: string) =>
    !!spec.extraTaken?.(norm) || spec.ns.some((ns) => view.hasOther(ns, norm, self));
  for (const o of Object.values(m.objects)) {
    if (!SLOT_OBJ_KINDS.has(o.kind)) continue;
    const slots = naming.slotsOf(m, view, o, new Map());
    if (typeof slots === 'symbol') continue;
    const table = slotTableOf((id) => m.objects[id], o)!;
    for (const s of slots) {
      if (!s.spec) continue;
      const cur = s.cur ?? '';
      out.set(s.self, {
        obj: o.id,
        table,
        spec: s.spec,
        cur,
        j: candIndex(s.spec, cur),
        clash: cur !== '' && taken(s.spec, s.spec.norm(cur), s.self),
      });
    }
  }
  return out;
};

/** 不变式：一步操作之后（普通模型） */
const checkInvariants = (before: Model, after: Model, op: Op) => {
  const b = slotInfos(before);
  const a = slotInfos(after);
  const view = new TestView(after);
  const label = `${op.name} ${JSON.stringify(op.args)}`;
  const reset = op.name === 'resetKeyName' ? (op.args.id as string) : null;
  for (const [self, s] of a) {
    const prev = b.get(self);
    if (prev && prev.cur === s.cur) continue;
    // 1. 稳定：输入没变（命名序列相同）、原来有效且不撞名的槽位不会改名（例如同表另一个对象被删除或改名）
    if (prev && prev.spec.key === s.spec.key && prev.j >= 0 && !prev.clash && s.obj !== reset)
      expect.fail(`${label}: ${self} 输入未变却改名 ${prev.cur} → ${s.cur}`);
    // 2. 新建或重算过的槽位：名字有效、不撞名，且取到的是最小空位（更小的候选名都被别的对象占用）
    expect(s.j, `${label}: ${self} = ${s.cur}`).toBeGreaterThanOrEqual(0);
    expect(s.clash, `${label}: ${self} = ${s.cur} 撞名`).toBe(false);
    for (let j = 0; j < s.j; j++) {
      const n = s.spec.norm(s.spec.cand(j));
      const occupied = !!s.spec.extraTaken?.(n) || s.spec.ns.some((ns) => view.hasOther(ns, n, self));
      expect(occupied, `${label}: ${self} = ${s.cur}，更小的 ${s.spec.cand(j)} 还空着`).toBe(true);
    }
  }
};

// ───── 各执行路径 ─────

const tryRun = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof EditError) return e.message;
    throw e;
  }
};

/** 普通模型逐步执行，每步检查不变式；返回成功的操作与每步的结果（模型或错误） */
const runPlain = (dialect: Dialect, abstracts: Abstract[]) => {
  const cur = baseModel(dialect);
  let n = 0;
  const nextId = () => `n${++n}`;
  const ops: Op[] = [];
  const trace: string[] = [];
  for (const a of abstracts) {
    const op = buildOp(cur, a, nextId);
    if (!op) continue;
    const before = clonePlain(cur);
    const err = tryRun(() => runMutator(cur, op.name, op.args));
    ops.push(op);
    if (err) {
      // 不合法的操作不能留下半截修改（runMutator 本身不回滚，这里只比较之后各路径的错误信息）
      trace.push(`error: ${err}`);
      Object.assign(cur, clonePlain(before));
      continue;
    }
    checkInvariants(before, cur, op);
    trace.push(stableJson(cur));
  }
  return { ops, trace, model: cur };
};

const commitTo = (idx: MutableModelIndex, m: Model, res: ReturnType<typeof execute>): Model => {
  idx.applyBatch(
    res.next,
    res.changes.map((c) => ({
      id: c.id,
      prev: m.objects[c.id],
      next: c.obj ? res.next.objects[c.id] : undefined,
    })),
  );
  return res.next;
};

/** 逐个 execute：shared 为真时共享 MutableModelIndex 并 applyBatch（MCP 逐步预演 / 服务端形态），否则不带索引 */
const runStepwise = (start: Model, ops: Op[], shared: boolean) => {
  let m = start;
  const idx = shared ? new MutableModelIndex(m) : undefined;
  const trace: string[] = [];
  for (const op of ops) {
    let res: ReturnType<typeof execute>;
    try {
      res = execute(m, op.name, op.args, idx);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      trace.push(`error: ${e.message}`);
      continue;
    }
    m = idx ? commitTo(idx, m, res) : res.next;
    trace.push(stableJson(m));
  }
  return { model: m, trace };
};

const runComposite = (start: Model, name: 'batch' | 'paste', ops: Op[], withIdx: boolean) => {
  try {
    const res = execute(start, name, { ops }, withIdx ? new MutableModelIndex(start) : undefined);
    return { model: stableJson(res.next), changes: stableJson(res.changes) };
  } catch (e) {
    if (e instanceof EditError) return { error: e.message };
    throw e;
  }
};

/** 整批执行与逐步执行的最终模型一致（整批失败时逐步也必有一步失败） */
const expectCompositeMatchesStepwise = (start: Model, name: 'batch' | 'paste', ops: Op[]) => {
  const withIdx = runComposite(start, name, ops, true);
  expect(runComposite(start, name, ops, false)).toEqual(withIdx);
  const step = runStepwise(start, ops, true);
  if ('error' in withIdx) expect(step.trace.some((t) => t.startsWith('error: '))).toBe(true);
  else if (!step.trace.some((t) => t.startsWith('error: ')))
    expect(withIdx.model).toBe(stableJson(step.model));
  return withIdx;
};

describe('稳定推导名：普通模型 / 逐个 execute / 无索引 execute / 整批 batch / paste 逐字节一致（Issue #164）', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 随机修改序列（含先提交前缀让对象进到基线）`, () => {
      fc.assert(
        fc.property(
          fc.array(abstractArb, { minLength: 5, maxLength: 45 }),
          fc.nat(100),
          (abstracts, split) => {
            const plain = runPlain(dialect, abstracts);
            const shared = runStepwise(baseModel(dialect), plain.ops, true);
            expect(shared.trace).toEqual(plain.trace);
            const bare = runStepwise(baseModel(dialect), plain.ops, false);
            expect(bare.trace).toEqual(plain.trace);
            const okOps = plain.ops.filter((_, i) => !plain.trace[i]!.startsWith('error: '));
            if (okOps.length) {
              const got = expectCompositeMatchesStepwise(baseModel(dialect), 'batch', okOps);
              expect('error' in got ? got.error : got.model).toBe(stableJson(plain.model));
            }
            if (okOps.length >= 2) {
              const prefixLen = 1 + (split % (okOps.length - 1));
              const seeded = runStepwise(baseModel(dialect), okOps.slice(0, prefixLen), true).model;
              const got = expectCompositeMatchesStepwise(seeded, 'batch', okOps.slice(prefixLen));
              expect('error' in got ? got.error : got.model).toBe(stableJson(plain.model));
            }
          },
        ),
        { numRuns: Number(process.env.RUNS164 ?? 200), seed: Number(process.env.SEED164 ?? 164) },
      );
    });

    test(`${dialect}: 粘贴同一张表的大量约束（显式名 / 推导名交错、撞名，含基线表与新建表）`, () => {
      const seedOps: Op[] = [
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
      fc.assert(
        fc.property(
          fc.array(fc.record({ kind: fc.nat(9), a: fc.nat(100), b: fc.nat(100), named: fc.nat(3) }), {
            minLength: 1,
            maxLength: 60,
          }),
          fc.boolean(),
          (items, ontoExisting) => {
            const seeded = runStepwise(baseModel(dialect), seedOps, true).model;
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
              // 给更早建的对象起显式名：腾出的推导名之后被新对象复用（不再让同序列的其他对象级联下移）
              if (it.named === 2 && n > 1)
                ops.push({
                  name: 'renameKey',
                  args: { id: `pk${1 + ((it.a + it.b) % (n - 1))}`, name: `explicit_${n}` },
                });
            }
            expectCompositeMatchesStepwise(seeded, 'paste', ops);
          },
        ),
        { numRuns: Number(process.env.RUNS164 ?? 120), seed: Number(process.env.SEED164 ?? 1640) },
      );
    });
  }
});

// ───── 固定回归用例 ─────

const nameOf = (m: Model, id: string): string | undefined => {
  const o = m.objects[id];
  return o && 'name' in o ? o.name : undefined;
};

/** 同一组操作在普通模型、逐个 execute、整批 batch 下结果相同，返回普通模型的结果 */
const runAllPaths = (start: Model, ops: Op[]): Model => {
  const plain = clonePlain(start);
  for (const op of ops) {
    const before = clonePlain(plain);
    runMutator(plain, op.name, op.args);
    checkInvariants(before, plain, op);
  }
  expect(stableJson(runStepwise(start, ops, true).model)).toBe(stableJson(plain));
  expect(stableJson(runStepwise(start, ops, false).model)).toBe(stableJson(plain));
  const batch = runComposite(start, 'batch', ops, true);
  expect('error' in batch ? batch.error : batch.model).toBe(stableJson(plain));
  return plain;
};

const CK = (dialect: Dialect, table: string, j: number) =>
  dialect === 'mssql' ? `CK_${table}${j ? `_${j}` : ''}` : `${table}_check${j || ''}`;

describe('回归用例：稳定推导名', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 删除不级联下移，新对象复用最小空位；改表名只重算受影响对象`, () => {
      const start = baseModel(dialect);
      const m1 = runAllPaths(start, [
        { name: 'addCheck', args: { id: 'c1', table: 't0', expr: '1 = 1' } },
        { name: 'addCheck', args: { id: 'c2', table: 't0', expr: '2 = 2' } },
      ]);
      expect([nameOf(m1, 'c1'), nameOf(m1, 'c2')]).toEqual([
        CK(dialect, 'orders', 0),
        CK(dialect, 'orders', 1),
      ]);
      // 删 c1：c2 保持 orders_check1；新建 c3 取最小空位 orders_check
      const m2 = runAllPaths(m1, [
        { name: 'dropKey', args: { id: 'c1' } },
        { name: 'addCheck', args: { id: 'c3', table: 't0', expr: '3 = 3' } },
      ]);
      expect([nameOf(m2, 'c2'), nameOf(m2, 'c3')]).toEqual([
        CK(dialect, 'orders', 1),
        CK(dialect, 'orders', 0),
      ]);
      // 删 c1 后改表名：c2 自己的输入（表名）变了，重算为 invoices_check
      const m3 = runAllPaths(m1, [
        { name: 'dropKey', args: { id: 'c1' } },
        { name: 'renameTable', args: { id: 't0', name: 'invoices' } },
      ]);
      expect(nameOf(m3, 'c2')).toBe(CK(dialect, 'invoices', 0));
      // 改表名时多个对象按原后缀顺序依次取最小空位
      const m4 = runAllPaths(m1, [{ name: 'renameTable', args: { id: 't0', name: 'invoices' } }]);
      expect([nameOf(m4, 'c1'), nameOf(m4, 'c2')]).toEqual([
        CK(dialect, 'invoices', 0),
        CK(dialect, 'invoices', 1),
      ]);
      // resetKeyName：显式名恢复为推导名时取最小空位
      const m5 = runAllPaths(m1, [
        { name: 'renameKey', args: { id: 'c1', name: 'my_ck' } },
        { name: 'addCheck', args: { id: 'c4', table: 't0', expr: '4 = 4' } },
        { name: 'dropKey', args: { id: 'c2' } },
        { name: 'resetKeyName', args: { id: 'c1' } },
      ]);
      expect([nameOf(m5, 'c4'), nameOf(m5, 'c1')]).toEqual([
        CK(dialect, 'orders', 0),
        CK(dialect, 'orders', 1),
      ]);
      // 改被引用的列名：引用它的 CHECK 重算，其他 CHECK 不动
      const m6 = runAllPaths(m1, [
        { name: 'addCheck', args: { id: 'c5', table: 't0', expr: 'b > 0' } },
        { name: 'renameColumn', args: { id: 't0_b', name: 'bb' } },
      ]);
      expect(nameOf(m6, 'c5')).toBe(dialect === 'mssql' ? 'CK_orders_bb' : 'orders_bb_check');
      expect([nameOf(m6, 'c1'), nameOf(m6, 'c2')]).toEqual([
        CK(dialect, 'orders', 0),
        CK(dialect, 'orders', 1),
      ]);
    });
  }

  test('pg: 同一次 execute 内 dropTable 腾出跨表推导名：之后新建的对象复用，既有对象不动', () => {
    const seeded = runStepwise(
      baseModel('pg'),
      [
        { name: 'addIndex', args: { id: 'k0', table: 't0', elements: [{ column: 't0_a_b' }] } },
        { name: 'addIndex', args: { id: 'k1', table: 't1', elements: [{ column: 't1_b' }] } },
        { name: 'setIdentity', args: { id: 't0_a_b', identity: { always: false } } },
        { name: 'setIdentity', args: { id: 't1_b', identity: { always: false } } },
      ],
      true,
    ).model;
    expect(nameOf(seeded, 'k1')).toBe('orders_a_b_idx1');
    const after = runAllPaths(seeded, [
      { name: 'addCheck', args: { id: 'ck_a', table: 't1', expr: '1 = 1' } },
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addIndex', args: { id: 'k2', table: 't1', elements: [{ column: 't1_b' }] } },
      { name: 'addCheck', args: { id: 'ck_b', table: 't1', expr: '2 = 2' } },
    ]);
    expect(nameOf(after, 'k1')).toBe('orders_a_b_idx1');
    expect(nameOf(after, 'k2')).toBe('orders_a_b_idx');
    const col = after.objects.t1_b;
    expect(col?.kind === 'column' && col.identity?.sequenceName).toBe('orders_a_b_seq1');
  });

  test('mssql: 同一次 execute 内 dropTable 腾出 schema 级 CHECK / DEFAULT 推导名并被复用', () => {
    const seeded = runStepwise(
      baseModel('mssql'),
      [
        { name: 'addCheck', args: { id: 'ck0', table: 't0', expr: 'a_b > 0' } },
        { name: 'addCheck', args: { id: 'ck1', table: 't1', expr: 'b > 0' } },
        { name: 'setDefault', args: { id: 't0_a_b', default: { expr: '((0))' } } },
      ],
      true,
    ).model;
    expect(nameOf(seeded, 'ck1')).toBe('CK_orders_a_b_1');
    const after = runAllPaths(seeded, [
      { name: 'dropTable', args: { id: 't0' } },
      { name: 'addCheck', args: { id: 'ck2', table: 't1', expr: 'b < 9' } },
      { name: 'setDefault', args: { id: 't1_b', default: { expr: '((0))' } } },
    ]);
    expect(nameOf(after, 'ck1')).toBe('CK_orders_a_b_1');
    expect(nameOf(after, 'ck2')).toBe('CK_orders_a_b');
    const col = after.objects.t1_b;
    expect(col?.kind === 'column' && col.ext?.mssql?.defaultName).toBe('DF_orders_a_b');
  });

  test('mssql: setColumnExt 写入与他表推导名冲突的显式 defaultName，下次刷新那张表时让出名字', () => {
    const seeded = runStepwise(
      baseModel('mssql'),
      [
        { name: 'setDefault', args: { id: 't0_a', default: { expr: '((0))' } } },
        { name: 'addCheck', args: { id: 'ck1', table: 't1', expr: 'a > 0' } },
      ],
      true,
    ).model;
    expect(nameOf(seeded, 'ck1')).toBe('CK_orders_a_a');
    const after = runAllPaths(seeded, [
      {
        name: 'setColumnExt',
        args: { id: 't0_a', ext: { mssql: { defaultName: 'CK_orders_a_a', defaultNameMode: 'explicit' } } },
      },
      { name: 'addCheck', args: { id: 'ck2', table: 't1', expr: '2 = 2' } },
    ]);
    expect(nameOf(after, 'ck1')).toBe('CK_orders_a_a_1');
  });

  test('mssql: 新列的隐式 DEFAULT 名截断后与已有名字相同时，已有列保留名字、新列取下一个空位', () => {
    const dfOf = (m: Model, id: string) => {
      const c = m.objects[id];
      return c?.kind === 'column' ? c.ext?.mssql?.defaultName : undefined;
    };
    const col = (id: string, name: string) => ({
      name: 'addColumn',
      args: { table: 't1', column: { id, name, type: 'int', notNull: false, default: { expr: '((0))' } } },
    });
    const seeded = runStepwise(baseModel('mssql'), [col('n3', `c_${'y'.repeat(118)}`)], true).model;
    const before = dfOf(seeded, 'n3');
    expect(before).toBeTruthy();
    const after = runAllPaths(seeded, [col('n10', `c_${'y'.repeat(117)}w`)]);
    expect(dfOf(after, 'n3')).toBe(before);
    expect(dfOf(after, 'n10')).toBe(`${before!.slice(0, 126)}_1`);
    expect(dfOf(after, 'n10')).not.toBe(before);
  });

  test('mssql: 去掉默认值后清理遗留的推导 DEFAULT 名', () => {
    const after = runAllPaths(baseModel('mssql'), [
      { name: 'setDefault', args: { id: 't0_b', default: { expr: '((0))' } } },
      { name: 'setDefault', args: { id: 't0_b', default: null } },
    ]);
    const col = after.objects.t0_b;
    expect(col?.kind === 'column' && col.ext?.mssql?.defaultName).toBeFalsy();
  });

  test('pg: 分区家族：子分区 CHECK 沿用根表列，attach 后与父表继承约束避让', () => {
    const after = runAllPaths(baseModel('pg'), [
      { name: 'addCheck', args: { id: 'pc', table: 'tp', expr: 'a > 0' } },
      { name: 'addCheck', args: { id: 'cc', table: 'tp1', expr: 'a > 1' } },
      { name: 'renameColumn', args: { id: 'tp_a', name: 'aa' } },
      { name: 'addCheck', args: { id: 'cc2', table: 'tp1', expr: 'aa > 2' } },
    ]);
    expect(nameOf(after, 'pc')).toBe('p_aa_check');
    expect(nameOf(after, 'cc2')).toMatch(/^p_1_aa_check\d*$/);
  });
});

// ───── 复杂度守卫：确定性计数，不依赖墙钟 ─────

const bigModel = (dialect: Dialect, n: number) => {
  const m = emptyModel(dialect);
  createSchema(m, getDialect(dialect).capabilities.defaultSchema, 's0');
  runMutator(m, 'createTable', { id: 'big', schema: 's0', name: 'big' });
  for (const c of ['a', 'b', 'c', 'd'])
    runMutator(m, 'addColumn', { table: 'big', column: { id: `big_${c}`, name: c, type: INT[dialect] } });
  const idx = new MutableModelIndex(m);
  const ops: Op[] = [];
  for (let i = 0; i < n; i++)
    ops.push({ name: 'addCheck', args: { id: `k${i}`, table: 'big', expr: `a + b > ${i} AND c < ${i}` } });
  const res = execute(m, 'paste', { ops }, idx);
  return { m: commitTo(idx, m, res), idx };
};

const stats = () => ({ ...derivedNameStats });
const work = (s: ReturnType<typeof stats>) => s.validations + s.probes + s.marks;

describe('复杂度守卫：推导名工作量只与变化量有关，与表大小无关', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 粘贴 N 条 CHECK 线性（400 → 1600）`, () => {
      resetDerivedNameStats();
      bigModel(dialect, 400);
      const small = stats();
      resetDerivedNameStats();
      bigModel(dialect, 1600);
      const large = stats();
      expect(work(large)).toBeLessThanOrEqual(5 * work(small));
      expect(large.exprLexes).toBeLessThanOrEqual(1600 + 10);
    });

    test(`${dialect}: 大表上单步 execute（500 / 2000 条 CHECK 时计数相同且为常数）`, () => {
      const per = (n: number) => {
        let { m, idx } = bigModel(dialect, n);
        resetDerivedNameStats();
        for (let i = 0; i < 20; i++)
          m = commitTo(idx, m, execute(m, 'addCheck', { id: `x${i}`, table: 'big', expr: `d > ${i}` }, idx));
        expect(derivedNameStats.stateBuilds).toBe(0);
        return stats();
      };
      const small = per(500);
      const large = per(2000);
      expect(work(large)).toBe(work(small));
      expect(work(large)).toBeLessThanOrEqual(20 * 10);
    });

    test(`${dialect}: 交错 addColumn + addCheck、renameKey / dropKey + addCheck 每步常数`, () => {
      const run = (n: number, k: number) => {
        let { m, idx } = bigModel(dialect, n);
        resetDerivedNameStats();
        for (let i = 0; i < k; i++) {
          m = commitTo(
            idx,
            m,
            execute(
              m,
              'addColumn',
              { table: 'big', column: { id: `nc${i}`, name: `col${i}`, type: INT[dialect] } },
              idx,
            ),
          );
          m = commitTo(
            idx,
            m,
            execute(m, 'addCheck', { id: `s${i}`, table: 'big', expr: `col${i} > 0 AND a > 1` }, idx),
          );
          const op: Op =
            i % 2
              ? { name: 'dropKey', args: { id: `k${i}` } }
              : { name: 'renameKey', args: { id: `k${i}`, name: `ex_${i}` } };
          m = commitTo(idx, m, execute(m, op.name, op.args, idx));
          m = commitTo(
            idx,
            m,
            execute(m, 'addCheck', { id: `r${i}`, table: 'big', expr: `a + b > ${i} AND c < 0` }, idx),
          );
        }
        // 腾出的最小空位被复用：r0 取到 k0 让出的 big_check
        expect(nameOf(m, 'r0')).toBe(CK(dialect, 'big', 0));
        return stats();
      };
      const small = run(400, 50);
      const large = run(1600, 200);
      expect(work(large)).toBeLessThanOrEqual(5 * work(small));
      expect(work(large)).toBeLessThanOrEqual(200 * 4 * 8);
    });

    test(`${dialect}: MCP 500 步预演（共享索引与预算）在大表上每步常数，只构建一次基线状态`, () => {
      const { m: big } = bigModel(dialect, 2000);
      let m = clonePlain(big);
      const idx = new MutableModelIndex(m);
      const budget = new DerivedNameBudget();
      resetDerivedNameStats();
      for (let i = 0; i < 500; i++)
        m = commitTo(
          idx,
          m,
          execute(m, 'addCheck', { id: `p${i}`, table: 'big', expr: `d > ${i}` }, idx, { budget }),
        );
      const s = stats();
      expect(s.stateBuilds).toBe(1);
      // 基线首次构建（只读校验 2000 条）之外，每步只有常数次校验 / 试探 / 标脏
      expect(budget.used).toBeLessThanOrEqual(500 * 6);
      expect(s.validations).toBeLessThanOrEqual(2000 + 4 + 500 * 3);
    });

    test(`${dialect}: batchReadsOf 在大表上逐步执行 500 步，推导名工作量与表大小无关`, () => {
      const run = (n: number) => {
        const { m } = bigModel(dialect, n);
        const ops = Array.from({ length: 500 }, (_, i) => ({
          name: 'addCheck',
          args: { id: `q${i}`, table: 'big', expr: `d > ${i}` },
        }));
        resetDerivedNameStats();
        const reads = opReads(m, {}, { ops }, [], 'batch');
        expect(reads.map(([id]) => id)).toContain('big');
        const s = stats();
        expect(s.stateBuilds).toBe(1);
        return s.validations - (n + 4) + s.marks + s.recomputes;
      };
      expect(run(2000)).toBe(run(500));
    });
  }
});

describe('分词缓存守卫：普通模型逐条 addCheck 与 >4096 条 CHECK 均不重复分词', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 普通模型逐条 addCheck × 100 的 exprLexes ≤ 100`, () => {
      const m = emptyModel(dialect);
      const sch = createSchema(m, getDialect(dialect).capabilities.defaultSchema, 's0');
      runMutator(m, 'createTable', { id: 'big', schema: sch, name: 'big' });
      for (const c of ['a', 'b', 'c', 'd'])
        runMutator(m, 'addColumn', { table: 'big', column: { id: `big_${c}`, name: c, type: INT[dialect] } });
      resetDerivedNameStats();
      for (let i = 0; i < 100; i++)
        runMutator(m, 'addCheck', {
          id: `ck${i}`,
          table: 'big',
          expr: `a + b + ${i} > ${10000 + i} AND c + d > ${i}`,
        });
      expect(derivedNameStats.exprLexes).toBeLessThanOrEqual(100);
    });
  }

  test('pg: 表上超过 4096 条不同 CHECK 时续加不再触发全表重分词', () => {
    let { m, idx } = bigModel('pg', 4500);
    resetDerivedNameStats();
    for (let k = 0; k < 3; k++)
      m = commitTo(
        idx,
        m,
        execute(m, 'addCheck', { id: `extra_${k}`, table: 'big', expr: `a + b > ${60000 + k}` }, idx),
      );
    expect(derivedNameStats.exprLexes).toBeLessThanOrEqual(3);
  });
});

// ───── 工作量预算熔断 ─────

describe('工作量预算：病态改表名 / 改列名循环抛 EditError 并原子回滚，正常大编辑不受影响', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: batch 里反复改大表的表名 / 列名被拒绝，索引状态不受影响`, () => {
      let { m, idx } = bigModel(dialect, 1500);
      const before = stableJson(m);
      const renameTables: Op[] = Array.from({ length: 200 }, (_, i) => ({
        name: 'renameTable',
        args: { id: 'big', name: `big${i}` },
      }));
      const renameCols: Op[] = Array.from({ length: 200 }, (_, i) => ({
        name: 'renameColumn',
        args: { id: 'big_a', name: i % 2 ? 'a' : 'z' },
      }));
      for (const ops of [renameTables, renameCols]) {
        let err: unknown;
        try {
          execute(m, 'batch', { ops }, idx);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(EditError);
        expect(String((err as Error).message)).toContain('推导名重算工作量超出上限');
        expect(stableJson(m)).toBe(before);
      }
      // 回滚后基线状态仍然正确：继续执行的结果与全新索引一致
      const fresh = execute(
        m,
        'addCheck',
        { id: 'after', table: 'big', expr: 'b > 0' },
        new MutableModelIndex(m),
      );
      const reused = execute(m, 'addCheck', { id: 'after', table: 'big', expr: 'b > 0' }, idx);
      expect(stableJson(reused.changes)).toBe(stableJson(fresh.changes));
      m = commitTo(idx, m, reused);
      // 单次改大表的表名在预算内
      const once = execute(m, 'renameTable', { id: 'big', name: 'big_renamed' }, idx);
      expect(nameOf(once.next, 'k0')).toBe(CK(dialect, 'big_renamed', 0));
    });

    test(`${dialect}: MCP 预演共享一份预算：逐步改表名的循环在预算耗尽时被拒绝`, () => {
      let { m, idx } = bigModel(dialect, 1500);
      const budget = new DerivedNameBudget();
      let failedAt = -1;
      for (let i = 0; i < 200; i++) {
        try {
          m = commitTo(idx, m, execute(m, 'renameTable', { id: 'big', name: `big${i}` }, idx, { budget }));
        } catch (e) {
          expect(e).toBeInstanceOf(DerivedNameBudgetError);
          failedAt = i;
          break;
        }
      }
      expect(failedAt).toBeGreaterThan(0);
      expect(budget.used).toBeGreaterThan(DERIVED_NAME_WORK_BUDGET);
    });
  }

  test('pg: 正常的大规模粘贴每个子操作只消耗常数预算（按 2 万个子操作折算低于一半）', () => {
    const m = emptyModel('pg');
    createSchema(m, 'public', 's0');
    const ops: Op[] = [];
    for (let t = 0; t < 120; t++) {
      ops.push({ name: 'createTable', args: { id: `t${t}`, schema: 's0', name: `t${t}` } });
      for (const c of ['id', 'a', 'b'])
        ops.push({
          name: 'addColumn',
          args: {
            table: `t${t}`,
            column: { id: `t${t}_${c}`, name: c, type: 'integer', notNull: c === 'id' },
          },
        });
      ops.push({ name: 'addPrimaryKey', args: { id: `t${t}_pk`, table: `t${t}`, columns: [`t${t}_id`] } });
      for (let k = 0; k < 40; k++)
        ops.push({ name: 'addCheck', args: { id: `t${t}_ck${k}`, table: `t${t}`, expr: `a > ${k}` } });
    }
    const budget = new DerivedNameBudget();
    const res = execute(m, 'paste', { ops }, new MutableModelIndex(m), { budget });
    expect(res.changes.length).toBe(120 * 45);
    // 每个子操作只有常数步（校验 + 试探 + 标脏），2 万个子操作也在预算的一半以内
    expect(budget.used).toBeLessThan((120 * 45 * DERIVED_NAME_WORK_BUDGET) / 2 / 20000);
  });
});

describe('回归用例：失败（回滚）的 execute 不能吞掉基线命名序列的空位', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 取用了腾出的空位后整批失败，之后仍取到同一个最小空位`, () => {
      let { m, idx } = bigModel(dialect, 50);
      // 腾出中间的 big_check5（基线空位堆里有 5）
      m = commitTo(idx, m, execute(m, 'dropKey', { id: 'k5' }, idx));
      // 整批：先加一条（取用空位 5），再失败 → 回滚
      expect(() =>
        execute(
          m,
          'batch',
          {
            ops: [
              { name: 'addCheck', args: { id: 'tmp', table: 'big', expr: 'a + b > 1' } },
              { name: 'addCheck', args: { id: 'bad', table: 'missing', expr: 'a > 1' } },
            ],
          },
          idx,
        ),
      ).toThrow(EditError);
      const reused = execute(m, 'addCheck', { id: 'after', table: 'big', expr: 'a + b > 2' }, idx);
      const fresh = execute(
        m,
        'addCheck',
        { id: 'after', table: 'big', expr: 'a + b > 2' },
        new MutableModelIndex(m),
      );
      expect(nameOf(reused.next, 'after')).toBe(CK(dialect, 'big', 5));
      expect(stableJson(reused.changes)).toBe(stableJson(fresh.changes));
    });
  }
});

// ───── 提交级写入（历史恢复 / 导入 / 其他副本的提交，不经 mutator 校验）之后的增量维护 ─────

/**
 * start 上先应用一次不经 mutator 的提交 raw（基线索引经 applyBatch 增量维护，事先已构建推导名状态），
 * 再执行 ops：普通模型与共享索引的逐个 execute 结果必须一致，且普通模型每步满足不变式。
 */
const runAfterRawCommit = (start: Model, raw: (m: Model) => void, ops: Op[]): Model => {
  const idx = new MutableModelIndex(start);
  idx.namingState();
  const next = clonePlain(start);
  raw(next);
  const ids = new Set([...Object.keys(start.objects), ...Object.keys(next.objects)]);
  const batch = [...ids]
    .filter((id) => stableJson(start.objects[id] ?? null) !== stableJson(next.objects[id] ?? null))
    .map((id) => ({ id, prev: start.objects[id], next: next.objects[id] }));
  idx.applyBatch(next, batch);
  let m = next;
  for (const op of ops) m = commitTo(idx, m, execute(m, op.name, op.args, idx));
  const plain = clonePlain(next);
  for (const op of ops) {
    const before = clonePlain(plain);
    runMutator(plain, op.name, op.args);
    checkInvariants(before, plain, op);
  }
  expect(stableJson(m)).toBe(stableJson(plain));
  return plain;
};

describe('回归用例：提交级写入后，标脏规则覆盖倒排索引、分区拓扑与撞名', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: CHECK 引用的标识符后来成了列（倒排索引标脏）`, () => {
      const seeded = runStepwise(
        baseModel(dialect),
        [{ name: 'addCheck', args: { id: 'ck', table: 't0', expr: 'a > 0' } }],
        true,
      ).model;
      const after = runAfterRawCommit(
        seeded,
        (m) => {
          // 导入的模型里 CHECK 可能引用当时不存在的列名
          const ck = m.objects.ck;
          if (ck?.kind === 'check') ck.expr = 'a > 0 AND zz > 0';
        },
        [
          {
            name: 'addColumn',
            args: { table: 't0', column: { id: 't0_zz', name: 'zz', type: INT[dialect] } },
          },
        ],
      );
      expect(nameOf(after, 'ck')).toBe(CK(dialect, 'orders', 0));
    });

    test(`${dialect}: 两个推导名撞名时一起重算，最小空位按确定顺序分配`, () => {
      const seeded = runStepwise(
        baseModel(dialect),
        [
          { name: 'addCheck', args: { id: 'c1', table: 't0', expr: '1 = 1' } },
          { name: 'addCheck', args: { id: 'c2', table: 't0', expr: '2 = 2' } },
        ],
        true,
      ).model;
      const after = runAfterRawCommit(
        seeded,
        (m) => {
          const c2 = m.objects.c2;
          if (c2?.kind === 'check') c2.name = CK(dialect, 'orders', 0);
        },
        [{ name: 'addCheck', args: { id: 'c3', table: 't0', expr: '3 = 3' } }],
      );
      expect([nameOf(after, 'c3'), nameOf(after, 'c1'), nameOf(after, 'c2')]).toEqual([
        CK(dialect, 'orders', 0),
        CK(dialect, 'orders', 1),
        CK(dialect, 'orders', 2),
      ]);
    });
  }

  test('pg: 表被并入分区家族后，与父表继承约束撞名的 CHECK 重算（分区拓扑标脏）', () => {
    const start = baseModel('pg');
    const seeded = runStepwise(
      start,
      [
        { name: 'addCheck', args: { id: 'pck', table: 'tp', expr: 'a > 0' } },
        { name: 'createTable', args: { id: 'tc', schema: schemaOf(start), name: 'p_a' } },
        { name: 'addColumn', args: { table: 'tc', column: { id: 'tc_x', name: 'x', type: 'integer' } } },
        { name: 'addCheck', args: { id: 'cck', table: 'tc', expr: '1 = 1' } },
      ],
      true,
    ).model;
    expect([nameOf(seeded, 'pck'), nameOf(seeded, 'cck')]).toEqual(['p_a_check', 'p_a_check']);
    const after = runAfterRawCommit(
      seeded,
      (m) => {
        // 历史恢复 / 导入直接把表挂到分区父表下（子分区不带自己的列）
        delete m.objects.tc_x;
        const t = m.objects.tc;
        if (t?.kind === 'table') t.partitionOf = { parent: 'tp', bound: 'FOR VALUES FROM (100) TO (200)' };
      },
      [{ name: 'addCheck', args: { id: 'pck2', table: 'tp', expr: '2 = 2' } }],
    );
    // 父表的 CHECK 现在要避让子分区的全部约束名：刷新父表时它让出名字（子分区自己的 CHECK 等子分区刷新时再处理）
    expect([nameOf(after, 'pck'), nameOf(after, 'cck')]).toEqual(['p_a_check1', 'p_a_check']);
  });
});

// ───── 跨表同名列倒排索引隔离、分区族遍历计费与 indexedBatchStepper 共享预算 ─────

describe('跨表 CHECK 倒排索引隔离与分区族预算守卫', () => {
  for (const dialect of DIALECTS) {
    test(`${dialect}: 其他表有 N 条同名列 CHECK 时，小表 renameColumn 的 refScans 与工作量与 N 无关`, () => {
      const setup = (n: number, withSmCheck: boolean) => {
        let { m, idx } = bigModel(dialect, n);
        const s0 = schemaOf(m);
        m = commitTo(idx, m, execute(m, 'createTable', { id: 'sm', schema: s0, name: 'sm' }, idx));
        m = commitTo(
          idx,
          m,
          execute(
            m,
            'addColumn',
            { table: 'sm', column: { id: 'sm_a', name: 'a', type: INT[dialect] } },
            idx,
          ),
        );
        if (withSmCheck) {
          m = commitTo(idx, m, execute(m, 'addCheck', { id: 'sm_ck', table: 'sm', expr: 'a > 0' }, idx));
        }
        return { m, idx };
      };

      const runRename = (n: number, count: number, withSmCheck: boolean) => {
        const { m, idx } = setup(n, withSmCheck);
        const ops: Op[] = Array.from({ length: count }, (_, i) => ({
          name: 'renameColumn',
          args: { id: 'sm_a', name: i % 2 === 0 ? 'z' : 'a' },
        }));
        const budget = new DerivedNameBudget();
        resetDerivedNameStats();
        const res = execute(m, 'batch', { ops }, idx, { budget });
        return { res, budgetUsed: budget.used, refScans: derivedNameStats.refScans };
      };

      // 无约束小表：完全不扫描 big 表引用 'a' 的 N 条 CHECK
      const noCkSmall = runRename(500, 100, false);
      const noCkLarge = runRename(2000, 100, false);
      expect(noCkSmall.refScans).toBe(0);
      expect(noCkLarge.refScans).toBe(0);
      expect(noCkLarge.budgetUsed).toBe(noCkSmall.budgetUsed);
      expect(noCkLarge.budgetUsed).toBeLessThanOrEqual(100 * 3);

      // 小表有 1 条引用 'a' 的 CHECK：每次 renameColumn 命中旧名(已遮蔽基线/上一步)与新名(叠加层)各 1 次，与 big 表 N 无关
      const withCkSmall = runRename(500, 50, true);
      const withCkLarge = runRename(2000, 50, true);
      expect(withCkLarge.refScans).toBe(withCkSmall.refScans);
      expect(withCkLarge.refScans).toBeLessThanOrEqual(100);
      expect(withCkLarge.budgetUsed).toBe(withCkSmall.budgetUsed);
    });
  }

  test('pg: 分区家族改列名只查同家族 CHECK（不扫无关大表）并正确重命名子分区 CHECK', () => {
    let { m, idx } = bigModel('pg', 2000);
    const s0 = schemaOf(m);
    for (const op of [
      { name: 'createTable', args: { id: 'p', schema: s0, name: 'p' } },
      { name: 'addColumn', args: { table: 'p', column: { id: 'p_k', name: 'k', type: 'integer' } } },
      { name: 'addColumn', args: { table: 'p', column: { id: 'p_a', name: 'a', type: 'integer' } } },
      {
        name: 'setPartitionBy',
        args: {
          id: 'p',
          partitionBy: {
            strategy: 'range',
            keys: [{ column: 'p_k', expr: null, opclass: null, collation: null }],
          },
        },
      },
      {
        name: 'createPartition',
        args: { id: 'p1', parent: 'p', name: 'p_1', bound: 'FOR VALUES FROM (0) TO (10)' },
      },
      { name: 'addCheck', args: { id: 'p1_ck', table: 'p1', expr: 'a > 0' } },
    ] satisfies Op[]) {
      m = commitTo(idx, m, execute(m, op.name, op.args, idx));
    }
    resetDerivedNameStats();
    const res = execute(m, 'renameColumn', { id: 'p_a', name: 'b' }, idx);
    expect(nameOf(res.next, 'p1_ck')).toBe('p_1_b_check');
    expect(derivedNameStats.refScans).toBe(2);
  });

  test('pg: 空分区家族反复 renameColumn 计入遍历子分区的工作量预算并在超限时熔断', () => {
    const m0 = emptyModel('pg');
    const s0 = createSchema(m0, 'public', 's0');
    runMutator(m0, 'createTable', { id: 'p', schema: s0, name: 'p' });
    runMutator(m0, 'addColumn', { table: 'p', column: { id: 'p_k', name: 'k', type: 'integer' } });
    runMutator(m0, 'addColumn', { table: 'p', column: { id: 'p_a', name: 'a', type: 'integer' } });
    runMutator(m0, 'setPartitionBy', {
      id: 'p',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'p_k', expr: null, opclass: null, collation: null }],
      },
    });
    for (let i = 0; i < 50; i++) {
      runMutator(m0, 'createPartition', {
        id: `p_${i}`,
        parent: 'p',
        name: `p_${i}`,
        bound: `FOR VALUES FROM (${i * 10}) TO (${(i + 1) * 10})`,
      });
    }
    const idx = new MutableModelIndex(m0);
    const ops: Op[] = Array.from({ length: 20 }, (_, i) => ({
      name: 'renameColumn',
      args: { id: 'p_a', name: i % 2 === 0 ? 'z' : 'a' },
    }));
    const budget = new DerivedNameBudget(1000);
    let err: unknown;
    try {
      execute(m0, 'batch', { ops }, idx, { budget });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EditError);
    expect(String((err as Error).message)).toContain('推导名重算工作量超出上限');
    expect(budget.used).toBeGreaterThan(budget.limit);
  });
});

describe('indexedBatchStepper 共享预算与 batchReadsOf 超限保守回退', () => {
  test('indexedBatchStepper 在多步之间累计同一份 DerivedNameBudget 并在超限时抛 DerivedNameBudgetError', () => {
    const { m } = bigModel('pg', 1500);
    const budget = new DerivedNameBudget(10_000);
    const step = indexedBatchStepper(m, budget);
    let cur = m;
    let failedAt = -1;
    for (let i = 0; i < 20; i++) {
      try {
        cur = step(cur, 'renameTable', { id: 'big', name: `big_${i}` });
      } catch (e) {
        expect(e).toBeInstanceOf(DerivedNameBudgetError);
        failedAt = i;
        break;
      }
    }
    expect(failedAt).toBeGreaterThan(0);
    expect(failedAt).toBeLessThan(10);
    expect(budget.used).toBeGreaterThan(budget.limit);
  });

  test('pg: batchReadsOf 遇到 DerivedNameBudgetError 时对后续子操作退回保守依据收集而不截断', () => {
    const m = emptyModel('pg');
    const s0 = createSchema(m, 'public', 's0');
    runMutator(m, 'createTable', { id: 't0', schema: s0, name: 't0' });
    runMutator(m, 'addColumn', { table: 't0', column: { id: 'c0_a', name: 'a', type: 'integer' } });
    runMutator(m, 'addColumn', { table: 't0', column: { id: 'c0_b', name: 'b', type: 'integer' } });
    for (let i = 0; i < 10; i++) {
      runMutator(m, 'addCheck', { id: `ck_${i}`, table: 't0', expr: `a > ${i}` });
    }
    runMutator(m, 'createTable', { id: 't1', schema: s0, name: 't1' });
    runMutator(m, 'addColumn', { table: 't1', column: { id: 'c1_a', name: 'a', type: 'integer' } });
    runMutator(m, 'createTable', { id: 't2', schema: s0, name: 't2' });
    runMutator(m, 'addColumn', { table: 't2', column: { id: 'c2_x', name: 'x', type: 'integer' } });

    const ops: Op[] = [
      ...Array.from({ length: 40 }, (_, i) => ({
        name: 'renameColumn',
        args: { id: 'c0_a', name: i % 2 === 0 ? 'z' : 'a' },
      })),
      // 以下操作在极小预算耗尽之后出现，必须仍被保守收集进依据
      { name: 'renameColumn', args: { id: 'c1_a', name: 'c1_renamed' } },
      { name: 'addCheck', args: { id: 'new_ck', table: 't0', expr: 'b > 0' } },
      { name: 'createTable', args: { id: 'new_t', schema: s0, name: 'brand_new' } },
      { name: 'addColumn', args: { table: 'new_t', column: { id: 'new_col', name: 'x', type: 'integer' } } },
    ];

    const reads = readsOf(
      m,
      { ops, summary: 'c2_x' },
      'batch',
      indexedBatchStepper(m, new DerivedNameBudget(50)),
    );
    expect(reads).toEqual(expect.arrayContaining(['t0', 'c0_a', 'c0_b', 'c1_a']));
    expect(reads).not.toContain('new_t');
    expect(reads).not.toContain('new_col');
    expect(reads).not.toContain('c2_x');
  });
});
