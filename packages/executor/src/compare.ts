// 结构比较：把目标库读出来的快照和版本模型比（全面按 model.dialect 派发到 EngineAdapter）。
import { deepEqual, type Dialect, type Model, type Obj, type PlanOptions, plan } from '@dowel/core';
import {
  getEngine,
  ignoreDefaultPublicCommentSnap,
  reconcileIds,
  type Snapshot,
  type TargetSnapshot,
} from '@dowel/engines';

import type { ChainVersion, DiffItem } from './types.ts';

/** 差异列表最多保留多少项（完整数量另给 total） */
export const MAX_DIFF = 100;

export interface DiffResult {
  total: number;
  items: DiffItem[];
}

const SAME: DiffResult = { total: 0, items: [] };

/** 兼容直接传 PG Snapshot 或统一 TargetSnapshot */
const asTargetSnapshot = (snap: TargetSnapshot | Snapshot, dialect: Dialect): TargetSnapshot => {
  if ('dialect' in snap && 'payload' in snap) return snap;
  return {
    dialect,
    version: String(snap.version),
    versionNum: snap.version,
    payload: snap,
  };
};

/** 保留旧导出兼容既有 PG 单测 */
export const ignoreDefaultPublicComment = (snapshot: Snapshot, model: Model): Snapshot =>
  ignoreDefaultPublicCommentSnap(snapshot, model);

/**
 * 线上结构导入成模型，对象 ID 按名字沿用 `reference` 里的（reconcileIds），并做方言专属归一化。
 * 漂移检查、标记核对、拉取线上结构共用同一套规则。
 */
export const importLive = (snapshot: TargetSnapshot | Snapshot, reference: Model): Model => {
  const engine = getEngine(reference.dialect);
  const wrapped = asTargetSnapshot(snapshot, reference.dialect);
  const normalized = engine.normalizeLiveSnapshot(wrapped, reference);
  const imported = reconcileIds(reference, engine.importSnapshot(normalized));
  return engine.alignImportedLive ? engine.alignImportedLive(imported, reference) : imported;
};

/**
 * plan(from, to) 的差异（最多 MAX_DIFF 项，另给总数）；规划器报错时作为一项 `unresolvable`，不让调用方崩溃。
 */
export const planDiff = (from: Model, to: Model, opts?: PlanOptions): DiffResult => {
  try {
    const steps = plan(from, to, opts);
    if (!steps.length) return SAME;
    return {
      total: steps.length,
      items: steps.slice(0, MAX_DIFF).map((s) => ({ kind: s.kind, target: s.target, sql: s.sql })),
    };
  } catch (e) {
    return unresolvable(e);
  }
};

const unresolvable = (e: unknown): DiffResult => ({
  total: 1,
  items: [{ kind: 'unresolvable', target: '', sql: e instanceof Error ? e.message : String(e) }],
});

/** 读回比较的核心：线上结构导入成模型（importLive），再规划到版本模型（planDiff）。执行读回、漂移与闭环验证的读回核对共用 */
const compareLive = (
  snapshot: TargetSnapshot | Snapshot,
  model: Model,
): { diff: DiffResult; live: Model | null } => {
  try {
    const engine = getEngine(model.dialect);
    const wrapped = asTargetSnapshot(snapshot, model.dialect);
    const planOpts = engine.planOptionsForVersion?.(wrapped.versionNum);
    const live = importLive(wrapped, model);
    return { diff: planDiff(live, model, planOpts), live };
  } catch (e) {
    return { diff: unresolvable(e), live: null };
  }
};

/** 线上结构 → 版本模型的差异；total = 0 表示相等 */
export const diffAgainst = (snapshot: TargetSnapshot | Snapshot, model: Model): DiffResult =>
  compareLive(snapshot, model).diff;

/** 读回核对里的一处写法差异：哪个对象的哪个属性，模型里存的值与数据库读回的值（非字符串按 JSON 显示；不存在为 null） */
export interface ReadbackDetail {
  object: string;
  property: string;
  modelValue: string | null;
  liveValue: string | null;
}

/** 读回核对的结果：和执行读回校验同一个比较（diffAgainst），差异时另给对象 / 属性级的明细（最多 MAX_DIFF 项） */
export interface ReadbackDiff extends DiffResult {
  details: ReadbackDetail[];
}

const objectName = (m: Model, id: string): string => {
  const parts: string[] = [];
  for (let o: Obj | undefined = m.objects[id], i = 0; o && i < 5; i++) {
    parts.unshift(o.name);
    o = 'parent' in o ? m.objects[o.parent] : undefined;
  }
  return parts.join('.') || id;
};

const shown = (v: unknown): string | null =>
  v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v);

/** 模型与读回模型（对象 ID 已按名字对齐）逐对象、逐属性的差异 */
const propertyDiffs = (model: Model, live: Model): ReadbackDetail[] => {
  const out: ReadbackDetail[] = [];
  const ids = [...new Set([...Object.keys(model.objects), ...Object.keys(live.objects)])];
  for (const id of ids) {
    if (out.length >= MAX_DIFF) break;
    const a = model.objects[id] as Record<string, unknown> | undefined;
    const b = live.objects[id] as Record<string, unknown> | undefined;
    if (!a || !b) {
      out.push({
        object: objectName(a ? model : live, id),
        property: 'kind',
        modelValue: shown(a?.kind),
        liveValue: shown(b?.kind),
      });
      continue;
    }
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
      if (key === 'id' || deepEqual(a[key], b[key])) continue;
      out.push({
        object: objectName(model, id),
        property: key,
        modelValue: shown(a[key]),
        liveValue: shown(b[key]),
      });
      if (out.length >= MAX_DIFF) break;
    }
  }
  return out;
};

/**
 * 闭环验证的读回核对（ADR 0017 决定 2）：用执行读回校验的**同一个比较**（diffAgainst）判断读回的结构是否等于模型，
 * 不一致时附上对象 / 属性级明细（模型里的值 vs 数据库读回的值），便于用户把模型改成数据库的写法。不做任何容忍或自动修复。
 */
export const readbackDiff = (snapshot: TargetSnapshot | Snapshot, model: Model): ReadbackDiff => {
  const { diff, live } = compareLive(snapshot, model);
  if (!diff.total || !live) return { ...diff, details: [] };
  return { ...diff, details: propertyDiffs(model, live) };
};

export type FirstRunKind = 'baseline' | 'empty' | 'drift';

/** 第一次执行到某个库：判断它是基线、空库还是漂移 */
export const classifyFirstRun = (
  snapshot: TargetSnapshot | Snapshot,
  first: ChainVersion,
  emptyModel: Model,
): { kind: FirstRunKind; diff: DiffResult } => {
  const diff = diffAgainst(snapshot, first.model);
  if (diff.total === 0) return { kind: 'baseline', diff };
  if (diffAgainst(snapshot, emptyModel).total === 0) return { kind: 'empty', diff };
  return { kind: 'drift', diff };
};

// ───── 修复脚本的风险提示 ─────

const DESTRUCTIVE_KINDS = new Set([
  'dropTable',
  'dropColumn',
  'dropSchema',
  'dropSequence',
  'dropEnum',
  'dropExtension',
  'dropOpaque',
  'dropIndex',
]);
const CONSTRAINT_KINDS = new Set(['dropForeignKey', 'dropPrimaryKey', 'dropUnique', 'dropCheck']);
const BENIGN_KINDS = new Set(['dropDefault', 'dropNotNull', 'dropIdentity']);
const CREATE_KINDS = new Set([
  'createTable',
  'createSchema',
  'createSequence',
  'createEnum',
  'createExtension',
  'createIndex',
  'createOpaque',
  'addColumn',
  'addPrimaryKey',
  'addUnique',
  'addCheck',
  'addForeignKey',
]);
const REWRITE_KINDS = new Set(['alterType', 'rebuildTable']);
const TEMP_NAME = /\b_dowel_tmp_\d+\b/;

const DESTRUCTIVE_SQL =
  /^\s*(?:DROP\s+(?:TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|FUNCTION|PROCEDURE|AGGREGATE|DOMAIN|TRIGGER|POLICY|INDEX|EXTENSION)\b|ALTER\s+TABLE\b[^;]*?\bDROP\s+COLUMN\b)/i;
const CONSTRAINT_SQL = /^\s*ALTER\s+TABLE\b[^;]*?\bDROP\s+CONSTRAINT\b/i;
const REWRITE_SQL =
  /^\s*ALTER\s+TABLE\b[^;]*?\b(?:ALTER\s+COLUMN\b[^;]*?\bTYPE\b|(?:MODIFY|CHANGE)\s+COLUMN\b)/i;

export interface RepairRisks {
  drops: number;
  constraints: number;
  rewrites: number;
  rebuilds: number;
}

export const repairRisks = (items: DiffItem[]): RepairRisks => {
  const r: RepairRisks = { drops: 0, constraints: 0, rewrites: 0, rebuilds: 0 };
  const created = new Set(items.filter((s) => CREATE_KINDS.has(s.kind)).map((s) => s.target));
  for (const s of items) {
    if (s.kind === 'unresolvable' || BENIGN_KINDS.has(s.kind) || CREATE_KINDS.has(s.kind)) continue;
    const dropLike = DESTRUCTIVE_KINDS.has(s.kind) || CONSTRAINT_KINDS.has(s.kind);
    if (dropLike) {
      if (TEMP_NAME.test(s.sql)) continue;
      if (created.has(s.target)) r.rebuilds++;
      else if (CONSTRAINT_KINDS.has(s.kind)) r.constraints++;
      else r.drops++;
    } else if (REWRITE_KINDS.has(s.kind)) r.rewrites++;
    else if (DESTRUCTIVE_SQL.test(s.sql)) r.drops++;
    else if (CONSTRAINT_SQL.test(s.sql)) r.constraints++;
    else if (REWRITE_SQL.test(s.sql)) r.rewrites++;
  }
  return r;
};
