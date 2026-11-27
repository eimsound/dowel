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
    if (l.kind !== 'column' || !l.generated?.stored) continue;
    const r = reference.objects[l.id];
    if (r?.kind !== 'column' || !r.generated?.stored) continue;
    if (!deepEqual(r.generated, l.generated)) continue;
    if (mssqlEffectiveNotNull(r) !== mssqlEffectiveNotNull(l)) continue;
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
