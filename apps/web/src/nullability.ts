// 列的可空性显示（ADR 0019）：SQL Server 持久化计算列区分“显式 NOT NULL”（notNull，复选框绑定它）与
// “引擎按表达式推断为非空”（ext.mssql.inferredNotNull，只读，影子库规范化写回）。徽标与画布按有效可空性显示。
import { type Column, effectiveNotNull, type Model, mssqlInferredNotNull } from '@dowel/core';

export interface ColumnNullability {
  /** “非空”复选框的勾选状态：只有显式声明 */
  explicit: boolean;
  /** 实际是否非空（显式或推断）：列表 NN 徽标、画布上的 `?` 用它 */
  effective: boolean;
  /** 没有显式声明、由引擎推断为非空：复选框不勾，下面显示只读提示 */
  inferredOnly: boolean;
}

export const columnNullability = (m: Model, c: Column): ColumnNullability => {
  const inferredOnly = m.dialect === 'mssql' && !c.notNull && mssqlInferredNotNull(c);
  return { explicit: c.notNull, effective: effectiveNotNull(m.dialect, c), inferredOnly };
};

/** 画布 / 历史快照里的列非空标记：按有效可空性或主键决定是否隐藏 `?` */
export const canvasColumnNotNull = (m: Model, c: Column, isPk: boolean): boolean =>
  effectiveNotNull(m.dialect, c) || isPk;

/** Inspector 里“非空”复选框的禁用条件 */
export const notNullCheckboxDisabled = (m: Model, c: Column): boolean =>
  c.identity !== null ||
  !!c.ext?.mssql?.identity ||
  !!c.ext?.mysql?.autoIncrement ||
  (m.dialect === 'mssql' && c.generated !== null && !c.generated.stored) ||
  (m.dialect === 'mssql' && !c.notNull && !!c.ext?.mssql?.sparse);

/** 列行（非主键）是否附带读屏用“由表达式推断为非空”说明 */
export const showRowInferredDescription = (m: Model, c: Column, isPk: boolean): boolean =>
  !isPk && columnNullability(m, c).inferredOnly;

/** 没有影子库、按显式非空记录的列提示：最多列出 limit 个，其余只给数量（ADR 0019） */
export const NULLABILITY_FALLBACK_LIMIT = 20;
export const fallbackListing = (
  columns: readonly string[],
  limit = NULLABILITY_FALLBACK_LIMIT,
): { shown: string[]; more: number; total: number; bodyKey: 'nnFallback.bodyOne' | 'nnFallback.body' } => ({
  shown: columns.slice(0, limit),
  more: Math.max(0, columns.length - limit),
  total: columns.length,
  bodyKey: columns.length === 1 ? 'nnFallback.bodyOne' : 'nnFallback.body',
});
