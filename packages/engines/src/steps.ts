// 冻结的迁移步骤：发布版本时生成，之后所有环境执行的都是同一份（ADR 0002）。
//
// 步骤格式 { sql, transactional }：
// - sql 是引擎输出的原始 SQL（不带结尾分号，由执行方决定怎么拼）；
// - transactional = false 表示这一步不能放进外层事务里（例如 PG CONCURRENTLY、SQLite 12 步表重建、MySQL DDL）。
//   若规划器已显式给出 Step.transactional，优先采用；否则按 isNontransactionalSql(s.sql, dialect) 推断。
import { createHash } from 'node:crypto';

import { type Dialect, isNontransactionalSql, type Step, stableJson } from '@dowel/core';

export interface ScriptStep {
  sql: string;
  transactional: boolean;
}

export { isNontransactionalSql };

/** plan() 的输出 → 冻结步骤。保留顺序，其它字段（kind / target）只用于界面展示，不进冻结脚本 */
export const toScriptSteps = (steps: Step[], dialect: Dialect = 'pg'): ScriptStep[] =>
  steps.map((s) => ({
    sql: s.sql,
    transactional: s.transactional !== undefined ? s.transactional : !isNontransactionalSql(s.sql, dialect),
  }));

/** 规范化：只保留两个字段、固定顺序；SQL 文本本身不做任何改写（冻结的就是原文） */
export const canonicalSteps = (steps: ScriptStep[]): ScriptStep[] =>
  steps.map((s) => ({ sql: String(s.sql), transactional: s.transactional !== false }));

/**
 * up / down 的校验和：对规范化后的 JSON 算 sha256。
 * 用 stableJson（键排序）保证同一份步骤无论怎么序列化都得到同一个值；
 * 不比较空白、大小写或 SQL 内容之外的东西。
 */
export const stepsChecksum = (up: ScriptStep[], down: ScriptStep[]): string =>
  createHash('sha256')
    .update(stableJson({ up: canonicalSteps(up), down: canonicalSteps(down) }))
    .digest('hex');
