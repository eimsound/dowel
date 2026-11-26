// SQLite 版本语义：内置内存影子库，不按版本分组，也不推导项目目标版本。
import type { DialectVersioning } from '../dialect.ts';

export const sqliteVersioning: DialectVersioning = {
  targetPlanOptions: () => undefined,
  formatVersionNum: (versionNum) =>
    `${Math.floor(versionNum / 1_000_000)}.${Math.floor((versionNum % 1_000_000) / 1000)}.${versionNum % 1000}`,
  // 内置内存影子库、不区分目标版本：没有可推导的目标版本与门控特性
  targetInfo: () => null,
};
