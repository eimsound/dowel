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
const ignoreDefaultPublicComment = (snapshot: Snapshot, model: Model): Snapshot => {
  const pub = snapshot.schemas.public;
  if (pub?.comment !== PG_DEFAULT_PUBLIC_COMMENT) return snapshot;
  const inModel = Object.values(model.objects).find((o) => o.kind === 'schema' && o.name === 'public');
  if (inModel?.comment) return snapshot;
  return { ...snapshot, schemas: { ...snapshot.schemas, public: { ...pub, comment: null } } };
};

/** 线上结构 → 版本模型的差异；total = 0 表示相等 */
export const diffAgainst = (snapshot: Snapshot, model: Model): DiffResult => {
  try {
    const live = reconcileIds(model, importSnapshot(ignoreDefaultPublicComment(snapshot, model)));
    const steps = plan(live, model);
    if (!steps.length) return SAME;
    return {
      total: steps.length,
      items: steps.slice(0, MAX_DIFF).map((s) => ({ kind: s.kind, target: s.target, sql: s.sql })),
    };
  } catch (e) {
    // 线上结构怪到连规划都做不了（例如导入 / 规划报错）：也算不一致，把原因当作一项差异
    return {
      total: 1,
      items: [{ kind: 'unresolvable', target: '', sql: e instanceof Error ? e.message : String(e) }],
    };
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
