// MSSQL 版本语义：不按版本分组（单一代表影子库，能力由影子库实测主版本决定），不推导项目规划目标版本；
// 写后静态诊断（compatibility）单独按环境最低主版本检查原生 json / vector。
import type { DialectTargetInfo, DialectVersioning } from '../dialect.ts';
import { checkMssqlCompatibility, mssqlCapabilities, mssqlMajorOf, mssqlReleaseYear } from './types.ts';

/** 一组环境数值版本号里的最低 SQL Server 主版本号（全部无效返回 null）；只用于静态诊断，不影响影子库规划 */
export const minMssqlMajor = (versionNums: readonly (number | null | undefined)[]): number | null => {
  const majors = versionNums.map(mssqlMajorOf).filter((v): v is number => v !== null);
  return majors.length ? Math.min(...majors) : null;
};

const mssqlTargetInfo = (versionNums: readonly (number | null | undefined)[]): DialectTargetInfo | null => {
  const major = minMssqlMajor(versionNums);
  if (major === null) return null;
  const cap = mssqlCapabilities(major);
  return {
    label: `SQL Server ${mssqlReleaseYear(major)}`,
    features: { nativeJson: cap.nativeJson, vectorType: cap.vectorType },
  };
};

export const mssqlVersioning: DialectVersioning = {
  targetPlanOptions: () => undefined,
  // 数值版本号为 major * 10000 + minor（如 160000 → '16.0'）
  formatVersionNum: (versionNum) => `${Math.floor(versionNum / 10000)}.${versionNum % 10000}`,
  // 完整版本号是构建号（SERVERPROPERTY('ProductVersion')），数值版本号只有主次版本，不够区分
  fullVersion: ({ version }) => version?.trim() || null,
  targetInfo: mssqlTargetInfo,
  compatibility: (model, versionNums) => {
    const major = minMssqlMajor(versionNums);
    const info = mssqlTargetInfo(versionNums);
    if (major === null || !info) return null;
    return {
      target: info.label,
      issues: checkMssqlCompatibility(model, major).map((i) => ({
        code: i.code,
        severity: i.severity,
        objectId: i.objectId,
        objectName: i.objectName,
        message: i.message,
        minVersion: `SQL Server ${mssqlReleaseYear(i.minMajor)}`,
      })),
    };
  },
};
