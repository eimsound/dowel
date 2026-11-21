// PostgreSQL 15–19 版本能力表、目标版本推导与静态兼容性检查。
import type { Model, Table } from '../ir.ts';
import { all, find } from '../model.ts';

export const MIN_PG_MAJOR = 15;
export const LATEST_PG_MAJOR = 19;
export const SUPPORTED_PG_MAJORS = [15, 16, 17, 18, 19] as const;
export type SupportedPgMajor = (typeof SUPPORTED_PG_MAJORS)[number];

/** 从 PG `server_version_num`（如 160004、180000）提取大版本号；非正数或非法值返回 null */
export const pgMajorOf = (versionNum: number | null | undefined): number | null =>
  typeof versionNum === 'number' && Number.isFinite(versionNum) && versionNum >= 100000
    ? Math.floor(versionNum / 10000)
    : null;

/** 从一组环境大版本号中推导项目目标 PG 大版本（取非空有效值的最小值；全空返回 null） */
export const deriveTargetPgMajor = (majors: readonly (number | null | undefined)[]): number | null => {
  const valid = majors.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
  return valid.length ? Math.min(...valid) : null;
};

export interface PgCapabilities {
  major: number;
  nullsNotDistinct: boolean;
  partitionedIdentity: boolean;
  partitionedExclusion: boolean;
  domainNotNullInConstraint: boolean;
  virtualGenerated: boolean;
  namedNotNull: boolean;
  notNullNotValid: boolean;
  partitionedNotValidConstraint: boolean;
  uuidv7: boolean;
  repack: boolean;
}

export const pgCapabilities = (major: number): PgCapabilities => ({
  major,
  nullsNotDistinct: major >= 15,
  partitionedIdentity: major >= 17,
  partitionedExclusion: major >= 17,
  domainNotNullInConstraint: major >= 17,
  virtualGenerated: major >= 18,
  namedNotNull: major >= 18,
  notNullNotValid: major >= 18,
  partitionedNotValidConstraint: major >= 18,
  uuidv7: major >= 18,
  repack: major >= 19,
});

export interface PlanOptions {
  pgMajor?: number | null;
}

export type CompatibilityCode =
  | 'virtual_generated'
  | 'named_not_null'
  | 'partitioned_identity'
  | 'partitioned_exclusion'
  | 'uuidv7_expr';

export type CompatibilitySeverity = 'error' | 'warning';

export interface CompatibilityIssue {
  code: CompatibilityCode;
  severity: CompatibilitySeverity;
  objectId: string;
  objectName: string;
  minMajor: number;
  message: string;
}

/** 去掉单引号字面量（含 E'...' 转义字符串），避免把字符串中的 uuidv7() 误判为函数调用 */
const stripStringLiterals = (expr: string): string =>
  expr.replace(/[eE]'(?:\\.|''|[^'\\])*'|'(?:''|[^'])*'/g, ' ');

/** 词边界匹配内置 uuidv7(...) / pg_catalog.uuidv7(...) 调用，排除 my_uuidv7()、uuidv7_ext()、自定义 schema.uuidv7() */
const UUIDV7_CALL = /(?:^|[^A-Za-z0-9_$.])(?:pg_catalog\.)?uuidv7\s*\(/i;

const hasUuidv7Call = (expr: string | null | undefined): boolean =>
  !!expr && UUIDV7_CALL.test(stripStringLiterals(expr));

const tableDisplayName = (m: Model, table: Table): string => {
  const schema = find(m, table.parent);
  return schema?.kind === 'schema' ? `${schema.name}.${table.name}` : table.name;
};

const colDisplayName = (m: Model, tableId: string, colName: string): string => {
  const table = find(m, tableId);
  return table?.kind === 'table' ? `${tableDisplayName(m, table)}.${colName}` : colName;
};

/**
 * 静态检查模型在指定目标 PG 大版本下的兼容性问题：
 * - severity === 'error'：硬不兼容 DDL 特性，规划器（plan / createAll）将直接抛出 PlanError；
 * - severity === 'warning'：运行时内置函数提示（如 uuidv7()），不阻断用户自定义同名函数的规划。
 */
export const checkPgCompatibility = (m: Model, targetMajor: number): CompatibilityIssue[] => {
  const cap = pgCapabilities(targetMajor);
  const issues: CompatibilityIssue[] = [];

  for (const c of all(m, 'column')) {
    const parentTable = find(m, c.parent);
    const isPartitionedParent = parentTable?.kind === 'table' && parentTable.partitionBy !== null;
    const name = colDisplayName(m, c.parent, c.name);

    if (!cap.virtualGenerated && c.generated && !c.generated.stored) {
      issues.push({
        code: 'virtual_generated',
        severity: 'error',
        objectId: c.id,
        objectName: name,
        minMajor: 18,
        message: `列 ${name} 使用了虚拟生成列（VIRTUAL），需要 PostgreSQL 18+（当前目标 PG ${targetMajor}），请改为 STORED`,
      });
    }

    if (!cap.namedNotNull && c.notNull && c.notNullNameMode === 'explicit') {
      issues.push({
        code: 'named_not_null',
        severity: 'error',
        objectId: c.id,
        objectName: name,
        minMajor: 18,
        message: `列 ${name} 显式命名了 NOT NULL 约束${c.notNullName ? `（${c.notNullName}）` : ''}，需要 PostgreSQL 18+（当前目标 PG ${targetMajor}）`,
      });
    }

    if (!cap.partitionedIdentity && c.identity && isPartitionedParent) {
      issues.push({
        code: 'partitioned_identity',
        severity: 'error',
        objectId: c.id,
        objectName: name,
        minMajor: 17,
        message: `分区表列 ${name} 使用了 IDENTITY，需要 PostgreSQL 17+（当前目标 PG ${targetMajor}），请改用独立序列`,
      });
    }

    if (!cap.uuidv7) {
      const defExpr = c.default && 'expr' in c.default ? c.default.expr : null;
      if (hasUuidv7Call(defExpr) || hasUuidv7Call(c.generated?.expr)) {
        issues.push({
          code: 'uuidv7_expr',
          severity: 'warning',
          objectId: c.id,
          objectName: name,
          minMajor: 18,
          message: `列 ${name} 的表达式调用了 uuidv7()，内置函数需要 PostgreSQL 18+（当前目标 PG ${targetMajor}）`,
        });
      }
    }
  }

  if (!cap.partitionedExclusion) {
    for (const o of all(m, 'opaque')) {
      if (o.objType !== 'exclusion') continue;
      const parentTable = find(m, o.parent);
      if (parentTable?.kind === 'table' && parentTable.partitionBy !== null) {
        const name = `${tableDisplayName(m, parentTable)}.${o.name}`;
        issues.push({
          code: 'partitioned_exclusion',
          severity: 'error',
          objectId: o.id,
          objectName: name,
          minMajor: 17,
          message: `分区表排他约束 ${name}（EXCLUDE）需要 PostgreSQL 17+（当前目标 PG ${targetMajor}）`,
        });
      }
    }
  }

  if (!cap.uuidv7) {
    for (const k of all(m, 'check')) {
      if (!hasUuidv7Call(k.expr)) continue;
      const name = colDisplayName(m, k.parent, k.name);
      issues.push({
        code: 'uuidv7_expr',
        severity: 'warning',
        objectId: k.id,
        objectName: name,
        minMajor: 18,
        message: `检查约束 ${name} 调用了 uuidv7()，内置函数需要 PostgreSQL 18+（当前目标 PG ${targetMajor}）`,
      });
    }

    for (const x of all(m, 'index')) {
      if (!x.elements.some((e) => hasUuidv7Call(e.expr)) && !hasUuidv7Call(x.where)) continue;
      const name = colDisplayName(m, x.parent, x.name);
      issues.push({
        code: 'uuidv7_expr',
        severity: 'warning',
        objectId: x.id,
        objectName: name,
        minMajor: 18,
        message: `索引 ${name} 的表达式调用了 uuidv7()，内置函数需要 PostgreSQL 18+（当前目标 PG ${targetMajor}）`,
      });
    }

    for (const t of all(m, 'table')) {
      const p = t.partitionBy;
      const hit =
        typeof p === 'string' ? hasUuidv7Call(p) : p !== null && p.keys.some((k) => hasUuidv7Call(k.expr));
      if (!hit) continue;
      const name = tableDisplayName(m, t);
      issues.push({
        code: 'uuidv7_expr',
        severity: 'warning',
        objectId: t.id,
        objectName: name,
        minMajor: 18,
        message: `分区表 ${name} 的分区键表达式调用了 uuidv7()，内置函数需要 PostgreSQL 18+（当前目标 PG ${targetMajor}）`,
      });
    }
  }

  return issues;
};
