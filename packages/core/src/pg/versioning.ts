// PostgreSQL 版本语义：按大版本分组验证、取最低大版本为项目目标、对外暴露大版本字段。
import type { DialectTargetInfo, DialectVersioning } from '../dialect.ts';
import { checkPgCompatibility, deriveTargetPgMajor, pgCapabilities, pgMajorOf } from './capabilities.ts';

/** 项目全部环境的数值版本号 → 最低目标 PG 大版本（全部无效返回 null） */
const targetPgMajorOf = (versionNums: readonly (number | null | undefined)[]): number | null =>
  deriveTargetPgMajor(versionNums.map(pgMajorOf));

const pgTargetInfo = (versionNums: readonly (number | null | undefined)[]): DialectTargetInfo | null => {
  const pgMajor = targetPgMajorOf(versionNums);
  if (pgMajor === null) return null;
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(pgCapabilities(pgMajor))) {
    if (typeof value === 'boolean') features[key] = value;
  }
  return { label: `PG ${pgMajor}`, features };
};

export const pgVersioning: DialectVersioning = {
  matrix: {
    groupKeyOf: pgMajorOf,
    groupLabel: (major) => `PG ${major}`,
    groupGranularity: '大版本',
    publicMajorOfGroup: (major) => major,
  },
  targetPlanOptions: (versionNums) => {
    const pgMajor = targetPgMajorOf(versionNums);
    return pgMajor !== null ? { pgMajor } : undefined;
  },
  formatVersionNum: (versionNum) => `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`,
  fullVersion: ({ versionNum }) =>
    typeof versionNum === 'number' && Number.isInteger(versionNum) && versionNum > 0
      ? `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`
      : null,
  targetInfo: pgTargetInfo,
  compatibility: (model, versionNums) => {
    const pgMajor = targetPgMajorOf(versionNums);
    const info = pgTargetInfo(versionNums);
    if (pgMajor === null || !info) return null;
    return {
      target: info.label,
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
