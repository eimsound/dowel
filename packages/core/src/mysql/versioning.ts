// MySQL 版本语义：按主次版本（8.4 / 9.7）分组验证、取最低数值版本号为项目目标；对外不暴露 PG 式大版本字段。
import type { DialectVersioning } from '../dialect.ts';
import { checkMysqlCompatibility } from './plan.ts';

const isVersionNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** MySQL 主次版本分组键（如 80413 → 804、90700 → 907）；非法或未知返回 null */
export const mysqlMinorGroupOf = (versionNum: number | null | undefined): number | null =>
  typeof versionNum === 'number' && Number.isInteger(versionNum) && versionNum >= 10000
    ? Math.floor(versionNum / 100)
    : null;

/** 一组 MySQL 数值版本号里的最低有效值（全部无效返回 null） */
export const minMysqlVersionNum = (versionNums: readonly (number | null | undefined)[]): number | null => {
  const valid = versionNums.filter(isVersionNum);
  return valid.length ? Math.min(...valid) : null;
};

export const mysqlVersioning: DialectVersioning = {
  matrix: {
    groupKeyOf: mysqlMinorGroupOf,
    groupLabel: (group) => `MySQL ${Math.floor(group / 100)}.${group % 100}`,
    groupGranularity: '版本',
    publicMajorOfGroup: () => null,
  },
  targetPlanOptions: (versionNums) => {
    const mysqlVersionNum = minMysqlVersionNum(versionNums);
    return mysqlVersionNum !== null ? { mysqlVersionNum } : undefined;
  },
  formatVersionNum: (versionNum) =>
    `${Math.floor(versionNum / 10000)}.${Math.floor((versionNum % 10000) / 100)}.${versionNum % 100}`,
  compatibility: (model, versionNums) => {
    const versionNum = minMysqlVersionNum(versionNums);
    if (versionNum === null) return null;
    const major = Math.floor(versionNum / 10000);
    const minor = Math.floor((versionNum % 10000) / 100);
    return {
      target: `MySQL ${major}.${minor}`,
      issues: checkMysqlCompatibility(model, versionNum).map((i) => ({
        code: i.code,
        severity: i.severity,
        objectId: i.objectId,
        objectName: i.objectName,
        message: i.message,
        minVersion: `MySQL ${i.minVersion}`,
      })),
    };
  },
};
