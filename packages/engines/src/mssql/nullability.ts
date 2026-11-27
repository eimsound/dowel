// SQL Server 持久化计算列的显式 / 推断非空（ADR 0019）：
// 系统目录（sys.columns.is_nullable、COLUMNPROPERTY AllowsNull、sys.computed_columns）分不出
// `AS (expr) PERSISTED NOT NULL` 与引擎从表达式推断出的非空，两者读回都是 is_nullable = 0。
// - alignMssqlImportedLive：读回线上结构时，从参考模型沿用同一列的显式 / 推断拆分（有效可空性一致且表达式未变时）；
// - probeMssqlInferredNotNull：只在可写的影子库里用，给同表加一个同表达式的临时计算列，读引擎对表达式本身推断的可空性。
import {
  type Column,
  deepEqual,
  type Model,
  mssqlEffectiveNotNull,
  mssqlIdent,
  mssqlLiteral,
  mssqlQualified,
  setMssqlInferredNotNull,
} from '@dowel/core';

import type { Db } from '../types.ts';

/**
 * 线上结构导入后的对齐（importLive 的 alignImportedLive 钩子；漂移检查、标记核对、拉取共用）：
 * 导入只能把非空的持久化计算列记成“推断”（notNull: false + inferredNotNull: true）。参考模型里同一列（按 ID）
 * 也是持久化计算列、表达式相同、有效可空性也一致时，沿用参考模型的 notNull / inferredNotNull，保住用户显式声明的
 * `PERSISTED NOT NULL`（拉取线上结构不会把它悄悄变成推断）。规划器与读回比较只比有效可空性，所以这不会遮蔽任何差异。
 */
export const alignMssqlImportedLive = (live: Model, reference: Model): Model => {
  let objects: Model['objects'] | null = null;
  for (const l of Object.values(live.objects)) {
    if (l.kind !== 'column') continue;
    const r = mssqlAlignableReference(l, reference);
    if (!r) continue;
    const want = Boolean(r.ext?.mssql?.inferredNotNull);
    if (r.notNull === l.notNull && want === Boolean(l.ext?.mssql?.inferredNotNull)) continue;
    const c = structuredClone(l) as Column;
    c.notNull = r.notNull;
    setMssqlInferredNotNull(c, want);
    objects ??= { ...live.objects };
    objects[c.id] = c;
  }
  return objects ? { ...live, objects } : live;
};

/**
 * 参考模型里能让线上列 l 沿用显式 / 推断拆分的同一列（按 ID）：两边都是持久化计算列、表达式相同、有效可空性一致；
 * 否则 null（拉取时这些列交给影子库探测重新拆分）
 */
export const mssqlAlignableReference = (l: Column, reference: Model): Column | null => {
  if (!l.generated?.stored) return null;
  const r = reference.objects[l.id];
  if (r?.kind !== 'column' || !r.generated?.stored) return null;
  if (!deepEqual(r.generated, l.generated)) return null;
  if (mssqlEffectiveNotNull(r) !== mssqlEffectiveNotNull(l)) return null;
  return r;
};

/** 模型里所有主键成员列的 ID */
const primaryKeyMembers = (m: Model): Set<string> => {
  const out = new Set<string>();
  for (const o of Object.values(m.objects))
    if (o.kind === 'primaryKey') for (const c of o.columns) out.add(c);
  return out;
};

/** 导入记成推断非空（notNull: false + inferredNotNull: true）的持久化计算列：系统目录分不出显式与推断的那些列 */
const isImportedInferred = (c: Column): boolean =>
  !!c.generated?.stored && !c.notNull && c.ext?.mssql?.inferredNotNull === true;

export interface MssqlNullabilitySplitPlan {
  /** 主键成员：一律记成显式 NOT NULL，不探测（建主键即视为显式声明，ADR 0019） */
  primaryKey: string[];
  /** 其余要在影子库里探测表达式本身推断的列（非主键、读回非空的持久化计算列） */
  probe: string[];
}

/**
 * 导入 / 拉取后要重新拆分显式与推断的列（ADR 0019 决定 4）：只看导入记成推断的持久化计算列；
 * keep 里的列（拉取时能沿用参考模型拆分的列）不动。没有 probe 项时调用方不必连影子库。
 */
export const mssqlNullabilitySplitPlan = (
  m: Model,
  keep: ReadonlySet<string> = new Set(),
): MssqlNullabilitySplitPlan => {
  const pk = primaryKeyMembers(m);
  const plan: MssqlNullabilitySplitPlan = { primaryKey: [], probe: [] };
  for (const o of Object.values(m.objects)) {
    if (o.kind !== 'column' || keep.has(o.id) || !isImportedInferred(o)) continue;
    (pk.has(o.id) ? plan.primaryKey : plan.probe).push(o.id);
  }
  return plan;
};

/** 拉取：线上模型里能从参考模型（工作副本）沿用拆分的列 ID */
export const mssqlAlignedColumnIds = (live: Model, reference: Model): Set<string> => {
  const out = new Set<string>();
  for (const o of Object.values(live.objects))
    if (o.kind === 'column' && mssqlAlignableReference(o, reference)) out.add(o.id);
  return out;
};

/**
 * 按拆分计划改写模型（返回新模型，不改入参）：
 * - 主键成员记成显式；
 * - probe 里的列：inferred 给出探测结果时，推断为非空的记成推断（notNull: false + inferredNotNull），推断为可空的记成显式；
 *   inferred 为 null（没有可用的影子库）或缺了某列的结果时，记成显式，并在 fallback 里列出这些列。
 */
export const applyMssqlNullabilitySplit = (
  m: Model,
  plan: MssqlNullabilitySplitPlan,
  inferred: ReadonlyMap<string, boolean> | null,
): { model: Model; fallback: string[] } => {
  const ids = [...plan.primaryKey, ...plan.probe];
  if (!ids.length) return { model: m, fallback: [] };
  const objects = { ...m.objects };
  const fallback: string[] = [];
  const explicit = (id: string) => {
    const c = structuredClone(objects[id]) as Column;
    c.notNull = true;
    setMssqlInferredNotNull(c, false);
    objects[id] = c;
  };
  for (const id of plan.primaryKey) explicit(id);
  for (const id of plan.probe) {
    const v = inferred?.get(id);
    if (v === undefined) {
      explicit(id);
      fallback.push(id);
    } else if (!v) explicit(id);
  }
  return { model: { ...m, objects }, fallback };
};

/** 列的完整限定名 schema.table.column（提示里列出受影响的列） */
export const mssqlColumnPath = (m: Model, id: string): string => {
  const c = m.objects[id];
  if (c?.kind !== 'column') return id;
  const t = m.objects[c.parent];
  const s = t && 'parent' in t ? m.objects[t.parent] : undefined;
  return [s?.name, t?.name, c.name].filter(Boolean).join('.');
};

export interface MssqlNullabilityProbe {
  schema: string;
  table: string;
  /** 表达式（影子库里读回的规范形式），与该表现有计算列在同一上下文里解析 */
  expr: string;
  /** 表上已有的列名（避开临时列重名，大小写不敏感） */
  columns: readonly string[];
}

/**
 * 在**影子库**里探测每个表达式本身是否被引擎推断为非空：按表一次 `ALTER TABLE … ADD` 若干临时的非持久化计算列
 * （可空性推断与持久化与否无关；非持久化列只改元数据，不受行大小与确定性限制）→ 读 sys.columns.is_nullable →
 * 删掉临时列。返回与 probes 一一对应的“推断为非空”。只能用于可随意改写的影子库，绝不对目标库调用。
 */
export const probeMssqlInferredNotNull = async (
  db: Db,
  probes: readonly MssqlNullabilityProbe[],
): Promise<boolean[]> => {
  const out: boolean[] = Array.from({ length: probes.length }, () => false);
  const byTable = new Map<string, number[]>();
  for (const [i, p] of probes.entries()) {
    const k = `${p.schema}\0${p.table}`;
    const list = byTable.get(k);
    if (list) list.push(i);
    else byTable.set(k, [i]);
  }
  for (const idxs of byTable.values()) {
    const first = probes[idxs[0]!]!;
    const qualified = mssqlQualified(first.schema, first.table);
    const taken = new Set(first.columns.map((n) => n.toLowerCase()));
    const names: string[] = [];
    let seq = 0;
    for (const _ of idxs) {
      let n: string;
      do n = `__dowel_nn_probe_${seq++}`;
      while (taken.has(n));
      taken.add(n);
      names.push(n);
    }
    const adds = idxs.map((i, k) => `${mssqlIdent(names[k]!)} AS (${probes[i]!.expr})`).join(', ');
    await db.exec(`ALTER TABLE ${qualified} ADD ${adds}`);
    try {
      const rows = await db.query<{ name: string; isNullable: boolean | number }>(
        `SELECT c.name AS name, c.is_nullable AS isNullable FROM sys.columns c
          WHERE c.object_id = OBJECT_ID(${mssqlLiteral(qualified)})
            AND c.name IN (${names.map((n) => mssqlLiteral(n)).join(', ')})`,
      );
      const nullable = new Map(rows.map((r) => [r.name.toLowerCase(), Boolean(r.isNullable)]));
      idxs.forEach((i, k) => {
        const v = nullable.get(names[k]!);
        if (v === undefined) throw new Error(`读不到可空性探测列 ${names[k]}（${qualified}）`);
        out[i] = !v;
      });
    } finally {
      await db.exec(`ALTER TABLE ${qualified} DROP COLUMN ${names.map((n) => mssqlIdent(n)).join(', ')}`);
    }
  }
  return out;
};
