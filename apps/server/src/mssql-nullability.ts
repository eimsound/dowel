import type { Model } from '@dowel/core';
// 从已有 SQL Server 数据库导入 / 拉取后，拆分持久化计算列的显式 NOT NULL 与推断非空（ADR 0019 决定 4）。
// 系统目录分不出两者，导入一律记成推断：
// - 主键成员：记成显式（建主键即视为显式声明），不探测；
// - 其余读回非空的持久化计算列：在影子库里按显式 NOT NULL 建库，再探测表达式本身的推断——推断为非空记成推断，
//   推断为可空记成显式；
// - 没有可用的影子库（或探测失败）：不拦导入 / 拉取，全部记成显式，并把受影响的列交给调用方提示用户。
// 模型里没有要探测的列时不连影子库（0 影子库 I/O）。
import { applyMssqlNullabilitySplit, mssqlColumnPath, mssqlNullabilitySplitPlan } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { SecretError, scrubSecrets } from './secrets.ts';
import { type Shadow, ShadowConfigChangedError } from './shadow.ts';

export interface MssqlNullabilitySplit {
  model: Model;
  /** 因没有可用的影子库、按显式非空记录的列（schema.table.column）；为空表示不需要提示 */
  fallback: string[];
}

/**
 * keep：能从参考模型沿用拆分的列（拉取时由 mssqlAlignedColumnIds 给出），不动；
 * shadowOf：需要探测时才调用，取不到影子库（ShadowError 等）就按显式兜底。
 * 白名单拒绝（HTTPException）与密钥解密失败（SecretError）和发布一致，继续抛出；影子库句柄因配置变更被关闭
 * （ShadowConfigChangedError）是可重试的暂时状态，也继续抛出，不按显式记录。
 */
export const splitImportedMssqlNullability = async (
  model: Model,
  shadowOf: () => Promise<Shadow>,
  keep?: ReadonlySet<string>,
): Promise<MssqlNullabilitySplit> => {
  if (model.dialect !== 'mssql') return { model, fallback: [] };
  const plan = mssqlNullabilitySplitPlan(model, keep);
  // 主键成员先记成显式：影子库按模型建库时主键要求成员列非空，导入形态（notNull: false + 推断）的成员列若表达式
  // 本身推断为可空，主键就建不出来，整次探测都会落到兜底
  const base = applyMssqlNullabilitySplit(model, { primaryKey: plan.primaryKey, probe: [] }, null).model;
  let inferred: Map<string, boolean> | null = null;
  if (plan.probe.length) {
    try {
      const shadow = await shadowOf();
      inferred = shadow.probeMssqlNotNull ? await shadow.probeMssqlNotNull(base, plan.probe) : null;
    } catch (e) {
      if (e instanceof HTTPException || e instanceof SecretError || e instanceof ShadowConfigChangedError)
        throw e;
      console.warn(
        'SQL Server 持久化计算列可空性探测没有完成，按显式非空记录',
        scrubSecrets(e instanceof Error ? e.message : String(e)),
      );
      inferred = null;
    }
  }
  const r = applyMssqlNullabilitySplit(base, { primaryKey: [], probe: plan.probe }, inferred);
  return { model: r.model, fallback: r.fallback.map((id) => mssqlColumnPath(r.model, id)) };
};
