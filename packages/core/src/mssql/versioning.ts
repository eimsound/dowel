// MSSQL 版本语义：不按版本分组（单一代表影子库，能力由影子库实测主版本决定），不推导项目目标版本。
import type { DialectVersioning } from '../dialect.ts';

export const mssqlVersioning: DialectVersioning = {
  targetPlanOptions: () => undefined,
  // 数值版本号为 major * 10000 + minor（如 160000 → '16.0'）
  formatVersionNum: (versionNum) => `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`,
};
