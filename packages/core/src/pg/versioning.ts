// PostgreSQL 版本语义：按大版本分组验证、取最低大版本为项目目标、对外暴露大版本字段。
import type { DialectVersioning } from '../dialect.ts';
import { checkPgCompatibility, deriveTargetPgMajor, pgMajorOf } from './capabilities.ts';

export const pgVersioning: DialectVersioning = {
  matrix: {
    groupKeyOf: pgMajorOf,
    groupLabel: (major) => `PG ${major}`,
    groupGranularity: '大版本',
    publicMajorOfGroup: (major) => major,
  },
  targetPlanOptions: (versionNums) => {
    const pgMajor = deriveTargetPgMajor(versionNums.map(pgMajorOf));
    return pgMajor !== null ? { pgMajor } : undefined;
  },
  formatVersionNum: (versionNum) => `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`,
  compatibility: (model, versionNums) => {
    const pgMajor = deriveTargetPgMajor(versionNums.map(pgMajorOf));
    if (pgMajor === null) return null;
    return {
      target: `PG ${pgMajor}`,
      issues: checkPgCompatibility(model, pgMajor).map((i) => ({
        code: i.code,
        severity: i.severity,
        objectId: i.objectId,
        objectName: i.objectName,
        message: i.message,
        minVersion: `PG ${i.minMajor}`,
      })),
    };
  },
};
