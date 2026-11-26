// 模型的写后静态自检（ADR 0015 第 5 节）：完整 validate 错误 + 按项目最低目标环境版本的静态兼容性问题。
// 纯函数、不连库：调用方只需传入平台库缓存的环境数值版本号（environments.engine_version_num）。
import type { DialectTargetInfo } from './dialect.ts';
import type { Dialect, Model } from './ir.ts';
import { validate, withModelIndex } from './model.ts';
import { getDialect } from './registry.ts';

/** 单条静态兼容性问题 */
export interface ModelCompatibilityIssue {
  code: string;
  /** error：目标版本不支持，规划 / 发布会失败；warning：仅提示（如 PG < 18 的 uuidv7() 内置函数） */
  severity: 'error' | 'warning';
  objectId?: string;
  objectName?: string;
  message: string;
  /** 最低需要的版本（如 'PG 18'、'MySQL 9.0'、'SQL Server 2025'） */
  minVersion?: string;
}

export interface ModelDiagnosticsList<T> {
  /** 完整条数（items 可能被截断） */
  total: number;
  items: T[];
}

export interface ModelDiagnostics {
  /** 推导出的项目最低目标版本（如 'PG 15'）；没有缓存的环境版本或方言不区分版本时为 null */
  target: string | null;
  validation: ModelDiagnosticsList<string>;
  compatibility: {
    errors: ModelDiagnosticsList<ModelCompatibilityIssue>;
    warnings: ModelDiagnosticsList<ModelCompatibilityIssue>;
  };
  /** 存在 validate 错误时为 true（发布版本会被拒绝） */
  blocksPublish: boolean;
}

/** 每个列表最多返回的条数（total 仍为完整条数） */
export const DIAGNOSTICS_ITEMS_LIMIT = 50;

const capped = <T>(items: T[]): ModelDiagnosticsList<T> => ({
  total: items.length,
  items: items.slice(0, DIAGNOSTICS_ITEMS_LIMIT),
});

/**
 * 诊断模型：validate 全部错误 + 方言静态兼容性（PG 最低大版本、MySQL 最低版本、SQL Server 最低主版本；SQLite 无）。
 * envVersionNums：项目各环境缓存的数值版本号；不给或全部无效时只做 validate。
 */
export const diagnoseModel = (
  model: Model,
  envVersionNums: readonly (number | null | undefined)[] = [],
): ModelDiagnostics =>
  withModelIndex(model, () => {
    const validationErrors = validate(model);
    const compat = getDialect(model.dialect).versioning.compatibility?.(model, envVersionNums) ?? null;
    const issues = compat?.issues ?? [];
    return {
      target: compat?.target ?? null,
      validation: capped(validationErrors),
      compatibility: {
        errors: capped(issues.filter((i) => i.severity === 'error')),
        warnings: capped(issues.filter((i) => i.severity === 'warning')),
      },
      blocksPublish: validationErrors.length > 0,
    };
  });

/**
 * 按项目各环境缓存的数值版本号推导最低目标版本的标签与门控特性（与 diagnoseModel 的 target 同源，纯函数、不连库）。
 * 没有可推导的版本（无环境、版本未缓存）或方言不区分版本（SQLite）时返回 null。
 */
export const describeTarget = (
  dialect: Dialect,
  envVersionNums: readonly (number | null | undefined)[] = [],
): DialectTargetInfo | null => getDialect(dialect).versioning.targetInfo?.(envVersionNums) ?? null;
