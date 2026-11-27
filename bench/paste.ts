// 大规模粘贴基准（Issue #165）：同步层 execute('paste') 的执行耗时（与服务端、网页端执行粘贴的路径相同）。
// 用法：pnpm bench:paste [pg|sqlite|mysql|mssql ...]；BENCH_ONLY=200|200x1000|680|checks 只跑其中一种规模。
// 场景：空项目 / 1000 张既有表 × 粘贴 200 张表（12 列、PK、索引、FK）；空项目粘贴 680 张表（接近粘贴上限）；粘贴一张带 1 万条 CHECK 的表。
import {
  copyTables,
  createSchema,
  type Dialect,
  emptyModel,
  getDialect,
  MutableModelIndex,
  planPaste,
} from '@dowel/core';
import { execute } from '@dowel/sync';

const SRC = { projectId: 'bench', projectName: 'Bench', origin: 'canvas' as const, seq: null };

const buildLarge = (
  dialect: Dialect,
  prefix: string,
  tables: number,
  cols: number,
  withFk: boolean,
  checks = 0,
) => {
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
    for (let k = 0; k < checks; k++) {
      m.objects[`${t}_ck${k}`] = {
        ...base,
        id: `${t}_ck${k}`,
        kind: 'check',
        expr: `col_2 > ${k}`,
        noInherit: false,
      };
    }
    prev = { t, pk: cs[0]! };
  }
  for (const t of ids) getDialect(dialect).refreshDerivedNames(m, t);
  return { m, ids };
};

const time = (fn: () => void, reps = 1) => {
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};

const run = (dialect: Dialect, existing: number, pasted: number, checks = 0, reps = 2) => {
  const target = buildLarge(dialect, 'existing', existing, 4, false).m;
  const src = buildLarge(dialect, 'copied', pasted, checks ? 3 : 12, !checks, checks);
  const payload = copyTables(src.m, src.ids, { source: SRC });
  const plan = planPaste(target, payload);
  const idx = new MutableModelIndex(target);
  const ms = time(() => execute(target, 'paste', { ops: plan.ops }, idx), reps);
  const label = checks ? `${pasted} table(s) × ${checks} CHECK` : `${pasted} tables × 12 cols`;
  console.log(
    `${dialect.padEnd(6)} existing=${String(existing).padStart(4)} paste ${label.padEnd(22)} ops=${String(plan.ops.length).padStart(5)} execute=${ms.toFixed(0)}ms`,
  );
};

const only = process.env.BENCH_ONLY;
const dialects = process.argv.slice(2).filter((a) => !a.startsWith('-')) as Dialect[];
for (const d of dialects.length ? dialects : (['pg', 'sqlite', 'mysql', 'mssql'] as Dialect[])) {
  if (!only || only === '200') run(d, 0, 200);
  if (!only || only === '200x1000') run(d, 1000, 200);
  if (!only || only === '680') run(d, 0, 680, 0, 1);
  if (!only || only === 'checks') run(d, 0, 1, 10_000, 1);
}
