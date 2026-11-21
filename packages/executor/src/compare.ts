// 结构比较：把目标库读出来的快照和版本模型比（全面按 model.dialect 派发到 EngineAdapter）。
import { type Dialect, type Model, type PlanOptions, plan } from '@dowel/core';
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

/** 线上结构 → 版本模型的差异；total = 0 表示相等 */
export const diffAgainst = (snapshot: TargetSnapshot | Snapshot, model: Model): DiffResult => {
  try {
    const engine = getEngine(model.dialect);
    const wrapped = asTargetSnapshot(snapshot, model.dialect);
    const planOpts = engine.planOptionsForVersion?.(wrapped.versionNum);
    const live = importLive(wrapped, model);
    return planDiff(live, model, planOpts);
  } catch (e) {
    return unresolvable(e);
  }
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
