// 版本链：发布时把相邻两个版本之间的迁移冻结成脚本（ADR 0002）。
// 冻结逻辑是纯函数，发布、编辑、平台库迁移（db.ts）都用同一份。
import {
  type Dialect,
  emptyBase,
  findInstanceLevelStep,
  instanceLevelDescription,
  type Model,
  type PlanOptions,
  plan,
  scopeCoversPublic,
  type Step,
} from '@dowel/core';
import { type Db, type ScriptStep, stepsChecksum, toScriptSteps } from '@dowel/engines';

// 空库模型（emptyBase）和 scopeCoversPublic 在 @dowel/core：执行器判断“这个库是不是空库”要用同一份
export { emptyBase, scopeCoversPublic };

export interface FrozenScripts {
  up: ScriptStep[];
  down: ScriptStep[];
  checksum: string;
}

/**
 * 冻结 from → to 的迁移：up = plan(from, to, opts)，down = plan(to, from, opts)。
 * planned 是规划器原始的步骤（带 kind / target，与 up / down 一一对应），迁移预览验证的报告用它
 */
export const freezeScripts = (
  from: Model,
  to: Model,
  opts?: PlanOptions,
): FrozenScripts & { planned: { up: Step[]; down: Step[] } } => {
  const planned = { up: plan(from, to, opts), down: plan(to, from, opts) };
  const up = toScriptSteps(planned.up, to.dialect);
  const down = toScriptSteps(planned.down, from.dialect);
  return { up, down, checksum: stepsChecksum(up, down), planned };
};

/**
 * v0 基线的脚本：up 是在空库上建出这个模型（空库模型见 emptyBase，所以执行时不会去 CREATE 一个已经存在的
 * public schema，也不会碰范围之外的 public）；基线没有回滚，down 为空。
 */
export const freezeBaseline = (
  model: Model,
  scope: string[] | null | undefined,
  opts?: PlanOptions,
): FrozenScripts & { /** 基线的 from（空库模型）：验证时直接用，不用再构建一遍 */ from: Model } => {
  const from = emptyBase(model, scope);
  const up = toScriptSteps(plan(from, model, opts), model.dialect);
  return { up, down: [], checksum: stepsChecksum(up, []), from };
};

/** 验证用的 from：基线从空库开始，其余版本从上一个版本开始 */
export const chainFrom = (
  parent: { model: Model } | null,
  to: Model,
  scope: string[] | null | undefined,
): Model => (parent ? parent.model : emptyBase(to, scope));

/**
 * 迁移脚本里不允许出现实例/文件级语句（PG：DATABASE/TABLESPACE/ROLE/ALTER SYSTEM；SQLite：ATTACH/DETACH/VACUUM INTO）：
 * 它们作用于整个数据库实例或本地文件系统，验证会真的执行它们。
 * 有就返回说明（哪一边、第几步），没有返回 null。发布（兜底，规划器正常不会生成）和编辑脚本都用它。
 */
export const instanceLevelProblem = (
  up: ScriptStep[],
  down: ScriptStep[],
  dialect: Dialect = 'pg',
): string | null => {
  for (const [dir, steps] of [
    ['升级', up],
    ['回滚', down],
  ] as const) {
    // 和验证前的拒绝检查是同一个函数、同一份说明
    const i = findInstanceLevelStep(steps, dialect);
    if (i >= 0) return `${dir}脚本第 ${i + 1} 步含实例级语句。${instanceLevelDescription(dialect)}`;
  }
  return null;
};

/**
 * 这个版本有没有在任何环境上执行过。编辑冻结脚本前检查：执行过的脚本再改，
 * 已经跑过它的环境和目标库里记下的校验和就对不上了。看平台库，不用每次都连目标库，只认两种情况：
 * - `versions.executed_at` 非空：**永久**的事实——执行成功、或执行中途失败且目标库已经被改动（`touched`）、
 *   或读目标库历史时发现它在历史里，第一次确认时写入，只写一次、永不清除。换连接串、目标库被清空、历史被手工删掉、
 *   环境被删除，都不能让版本重新变成可编辑；
 * - `environment_versions` 里有一条 `claimed`（执行已经开始、还没确认）：执行进行中，脚本不能被改。
 *   目标库没有被改动的失败会撤销登记，进程崩溃留下的登记由下一次在目标库项目锁里的同步清掉——那种版本还能修脚本。
 */
export const versionExecutedAnywhere = async (db: Db, versionId: string): Promise<boolean> =>
  (
    await db.query<{ x: number }>(
      `select 1 as x from versions where id = $1 and executed_at is not null
       union all select 1 as x from environment_versions where version_id = $1 and state = 'claimed' limit 1`,
      [versionId],
    )
  ).length > 0;
