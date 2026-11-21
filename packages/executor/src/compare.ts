// 结构比较：把目标库读出来的快照和版本模型比。
//
// 做法：快照导入成 IR，按名字沿用版本模型里的对象 ID（reconcileIds），然后 `plan(线上结构, 版本模型)`——
// 迁移规划器本来就只比较“定义”（不比展示顺序、不比 ID），空数组就是相等；非空就是“线上结构要怎么改才能回到
// 这个版本”，直接拿来作差异列表。版本模型是发布时规范化过的（表达式、不透明对象 DDL 是引擎的规范形式），
// 所以不会因为写法不同误报。
import { type Model, plan } from '@dowel/core';
import { importSnapshot, reconcileIds, type Snapshot } from '@dowel/engines';

import type { ChainVersion, DiffItem } from './types.ts';

/** 差异列表最多保留多少项（完整数量另给 total） */
export const MAX_DIFF = 100;

export interface DiffResult {
  total: number;
  items: DiffItem[];
}

const SAME: DiffResult = { total: 0, items: [] };

/** 全新的 PG 库里 public schema 自带的注释 */
const PG_DEFAULT_PUBLIC_COMMENT = 'standard public schema';

/**
 * 全新的 PG 库里 public 带着默认注释（`standard public schema`），而 Dowel 的模型（空白项目、空库模型）里 public 没有注释：
 * 模型里 public 没有注释时，把库里这条默认注释当成没有——否则任何全新的库都会被判成“结构不符”，
 * 第一次执行到它、以及执行完读回校验，都会因为这一条注释失败。模型里写了注释的（导入自真实库的 v0 就带着它）照常比较。
 */
export const ignoreDefaultPublicComment = (snapshot: Snapshot, model: Model): Snapshot => {
  const pub = snapshot.schemas.public;
  if (pub?.comment !== PG_DEFAULT_PUBLIC_COMMENT) return snapshot;
  const inModel = Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === 'public');
  if (inModel?.comment) return snapshot;
  return { ...snapshot, schemas: { ...snapshot.schemas, public: { ...pub, comment: null } } };
};

/**
 * 线上结构导入成模型，对象 ID 按名字沿用 `reference` 里的（reconcileIds），全新库里 public 自带的默认注释按 reference 的规则忽略。
 * **漂移检查、标记的核对、导入线上结构（保留线上的修改）都用它**——同一套规则，导入预览和漂移检查看到的是同一份结构。
 */
export const importLive = (snapshot: Snapshot, reference: Model): Model =>
  reconcileIds(reference, importSnapshot(ignoreDefaultPublicComment(snapshot, reference)));

/**
 * plan(from, to) 的差异（最多 MAX_DIFF 项，另给总数）；规划器对这对模型报错时作为一项 `unresolvable`，不让调用方崩溃。
 * 漂移差异、导入预览、修复脚本用同一个函数。
 */
export const planDiff = (from: Model, to: Model): DiffResult => {
  try {
    const steps = plan(from, to);
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
export const diffAgainst = (snapshot: Snapshot, model: Model): DiffResult => {
  try {
    return planDiff(importLive(snapshot, model), model);
  } catch (e) {
    // 线上结构怪到连导入都做不了：也算不一致，把原因当作一项差异
    return unresolvable(e);
  }
};

export type FirstRunKind = 'baseline' | 'empty' | 'drift';

/**
 * 第一次执行到某个库（库里还没有这个项目的历史）：
 * - 结构等于链上第一个版本的模型 → `baseline`（只写入基线，不执行 SQL）；
 * - 范围内没有任何对象（全新的库）→ `empty`（执行第一个版本的 up 完整建库）；
 * - 其他 → `drift`，带着“线上结构 → 第一个版本”的差异。
 * 空库用 emptyBase 比：全新的 PG 库本来就有 public，是否带 public 由 schema 范围决定。
 */
export const classifyFirstRun = (
  snapshot: Snapshot,
  first: ChainVersion,
  emptyModel: Model,
): { kind: FirstRunKind; diff: DiffResult } => {
  const diff = diffAgainst(snapshot, first.model);
  if (diff.total === 0) return { kind: 'baseline', diff };
  if (diffAgainst(snapshot, emptyModel).total === 0) return { kind: 'empty', diff };
  return { kind: 'drift', diff };
};

// ───── 修复脚本的风险提示 ─────

/** 会真正删掉对象或数据的步骤种类（规划器 step 的 kind）：删表、删列、删 schema、序列、类型、扩展、不透明对象（视图 / 函数 / 触发器……）、索引 */
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
/** 去掉约束的步骤种类（规划器 `drop${Kind}`，Kind 是 foreignKey / primaryKey / unique / check）：不丢数据，但会放开保护 */
const CONSTRAINT_KINDS = new Set(['dropForeignKey', 'dropPrimaryKey', 'dropUnique', 'dropCheck']);
/** 只是去掉一个属性 / 默认值 / 非空，不删对象也不删数据 */
const BENIGN_KINDS = new Set(['dropDefault', 'dropNotNull', 'dropIdentity']);
/** 创建 / 加回对象的步骤种类：同一个对象先 drop 再 create 是**重建**（索引定义变了、约束重建、视图重建、枚举改值），不是删除 */
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
/** 规划器重建对象时用的临时名（把旧的改名成 _dowel_tmp_N、建新的、再删掉旧的）：删的是自己的临时副本，不是用户的对象 */
const TEMP_NAME = /\b_dowel_tmp_\d+\b/;

/** 拿不到 kind 时的退路：精确的语句模式（语句开头锚定，不是随便含 drop 的文本） */
const DESTRUCTIVE_SQL =
  /^\s*(?:DROP\s+(?:TABLE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|TYPE|FUNCTION|PROCEDURE|AGGREGATE|DOMAIN|TRIGGER|POLICY|INDEX|EXTENSION)\b|ALTER\s+TABLE\b[^;]*?\bDROP\s+COLUMN\b)/i;
const CONSTRAINT_SQL = /^\s*ALTER\s+TABLE\b[^;]*?\bDROP\s+CONSTRAINT\b/i;
const REWRITE_SQL = /^\s*ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b[^;]*?\bTYPE\b/i;

export interface RepairRisks {
  /** 会删掉线上对象或其中数据的步骤数（DROP TABLE / COLUMN / SCHEMA / VIEW / SEQUENCE / TYPE / FUNCTION / INDEX……） */
  drops: number;
  /** 去掉约束的步骤数（外键、主键、唯一、检查）：不丢数据，但会放开保护 */
  constraints: number;
  /** 改列类型的步骤数：可能重写整张表、长时间持锁 */
  rewrites: number;
  /** 重建的对象数：同一个对象先 drop 再 create（索引定义变了、约束 / 视图重建、枚举改值）。对象会短暂不存在，但最后还在，不算删除 */
  rebuilds: number;
}

/**
 * 修复脚本（漂移差异里的步骤）的风险分类。**按规划器 step 的 kind 和 target 判断**，不靠文本里有没有 “drop” 这个词：
 * - 同一个 target 在步骤里还有 create / add（索引重建、约束重建、视图重建、枚举改值）→ `rebuilds`，不算删除；
 * - 规划器重建时产生的临时副本（`_dowel_tmp_N`，比如枚举重建最后那条 DROP TYPE）不算；
 * - `DROP DEFAULT` / `DROP NOT NULL` / `DROP IDENTITY` 不算；去掉约束（`CONSTRAINT_KINDS`）单独一类；
 * - kind 不认识（不是规划器给的）时才退回精确的语句模式。
 */
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
    } else if (s.kind === 'alterType') r.rewrites++;
    else if (DESTRUCTIVE_SQL.test(s.sql)) r.drops++;
    else if (CONSTRAINT_SQL.test(s.sql)) r.constraints++;
    else if (REWRITE_SQL.test(s.sql)) r.rewrites++;
  }
  return r;
};
