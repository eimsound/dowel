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
