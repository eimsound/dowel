// 多方言统一抽象契约（纯函数、无 I/O，前后端共用、浏览器轻量安全）。
import type { ClipboardDialect } from './clipboard-dialect.ts';
import type { ModelCompatibilityIssue } from './diagnostics.ts';
import type { Dialect, Model } from './ir.ts';
import type { PlanOptions } from './pg/capabilities.ts';
import type { Step, Token } from './plan-types.ts';

export interface DialectCapabilities {
  /** 是否支持多 schema（PG / MSSQL: true；SQLite / MySQL: false） */
  schemas: boolean;
  /** 默认 schema 名（PG: 'public', MSSQL: 'dbo', SQLite: 'main', MySQL: 'default'） */
  defaultSchema: string;
  /** 标识符长度上限 */
  maxIdentLength: number;
  /** 标识符长度计量单位 */
  maxIdentUnit: 'bytes' | 'chars';
  /** 是否支持独立 Enum 对象（PG: true；SQLite / MySQL / MSSQL: false） */
  enums: boolean;
  /** 是否支持独立 Sequence 对象（PG / MSSQL: true；SQLite / MySQL: false） */
  sequences: boolean;
  /** 是否支持声明式分区表编辑（PG: true） */
  partitioning: boolean;
  /** DDL 是否默认支持事务原子回滚（PG / SQLite / MSSQL: true；MySQL: false） */
  transactionalDdl: boolean;
  /** 是否存在需要表重建的 DDL（SQLite: true） */
  requiresTableRebuild: boolean;
  /** 是否支持列顺序调整（MySQL / SQLite: true） */
  supportsColumnOrder: boolean;
  /** 是否需要外部目标库/影子库才能验证与导入 SQL（SQLite: false，内置内存影子库） */
  requiresExternalShadow: boolean;
  /** 目标库迁移历史表存储方式（PG / MSSQL: 'schema'；SQLite / MySQL: 'prefix'） */
  historyStorage: 'schema' | 'prefix';
  /** UNIQUE / 索引是否支持 NULLS NOT DISTINCT（PG: true） */
  nullsNotDistinct: boolean;
  /** 是否支持对象级 COMMENT（SQLite: false） */
  comments: boolean;
}

/**
 * 多版本影子库矩阵策略：项目环境按版本组分组，每组 1 个代表影子库，组间按键升序逐一验证，最小键即项目最低目标版本组。
 * 只有按版本分组验证的方言（PG / MySQL）提供；不分组的方言（MSSQL / SQLite）不提供，上层把全部环境视为同一 null 组，
 * 不打版本标签、不做最低目标门禁，也忽略任何上游传入的组键。
 */
export interface DialectVersionMatrix {
  /** 数值版本号 → 版本组键（PG 大版本 160004 → 16；MySQL 主次版本 80413 → 804）；未知或非法返回 null */
  groupKeyOf(versionNum: number | null | undefined): number | null;
  /** 版本组展示标签（PG 16 → 'PG 16'；MySQL 804 → 'MySQL 8.4'），用于验证报告前缀与缺失目标提示 */
  groupLabel(groupKey: number): string;
  /** 最低目标版本组影子库实测错配时“请为 … 环境配置同{粒度}的独立影子库”里的粒度词（PG '大版本'；MySQL '版本'） */
  readonly groupGranularity: string;
  /**
   * 版本组对应的对外“大版本”：对外 API 的历史字段（engineMajor / shadowMajor / targetPgMajor / envPgMajors /
   * targets[].major / missingTargetMajor）只对 PG 有值，其余方言返回 null。
   */
  publicMajorOfGroup(groupKey: number): number | null;
}

/**
 * 方言的版本语义（纯函数、无 I/O）：多版本矩阵分组、项目最低目标版本推导与版本串格式化。
 * 上层编排（Shadows / envs / 多版本验证）只经由这些钩子处理版本，不再按方言名分支。
 */
export interface DialectVersioning {
  /** 多版本影子库矩阵策略；不按版本分组验证的方言不提供 */
  readonly matrix?: DialectVersionMatrix;
  /** 由项目全部环境的数值版本号推导项目最低目标版本的规划选项（PG `{ pgMajor }`、MySQL `{ mysqlVersionNum }`）；无可推导时返回 undefined */
  targetPlanOptions(versionNums: readonly (number | null | undefined)[]): PlanOptions | undefined;
  /** 数值版本号 → 简洁版本串（PG 160004 → '16.4'；MySQL 80413 → '8.4.13'；SQLite 3054001 → '3.54.1'） */
  formatVersionNum(versionNum: number): string;
  /**
   * 按项目全部环境的数值版本号推导最低目标版本，静态检查模型在该版本下的兼容性问题（不抛错、不连库）。
   * 无可推导的目标版本或方言不区分版本时返回 null（不提供即视为 null）。
   */
  compatibility?(
    model: Model,
    versionNums: readonly (number | null | undefined)[],
  ): DialectCompatibility | null;
}

/** 静态兼容性检查结果：target 为人类可读的目标版本（如 'PG 15'、'MySQL 8.4'、'SQL Server 2022'） */
export interface DialectCompatibility {
  target: string;
  issues: ModelCompatibilityIssue[];
}

export type IdentKind = 'schema' | 'table' | 'column' | 'enum' | 'sequence' | 'constraint' | 'index';

export interface DialectSpec {
  readonly id: Dialect;
  readonly capabilities: DialectCapabilities;
  quoteIdent(name: string): string;
  quoteQualified(schema: string, name: string): string;
  literal(s: string): string;
  keywords: ReadonlySet<string>;
  tokenize(expr: string): Token[];
  columnRefs(expr: string): Token[];
  exprReferences(expr: string, name: string): boolean;
  renameInExpr(expr: string, from: string, to: string): string;
  renameQualifiedInExpr(
    expr: string,
    schema: string,
    name: string | null,
    to: { schema: string; name: string | null },
  ): string;
  normalizeType(input: string): string;
  commonTypes: readonly string[];
  emptyBase(like: Model, scope: string[] | null | undefined): Model;
  /** 校验单个标识符是否符合方言长度上限与保留前缀规则（合法返回 null，否则返回错误说明） */
  validateIdent(name: string, kind: IdentKind): string | null;
  /** 将步骤列表格式化为可导出/复制的完整 SQL 脚本文本（为 MSSQL GO 批次等方言预留扩展点） */
  formatScript(steps: readonly { sql: string }[]): string;
  /** 方言专属的一致性校验（标识符上限、命名空间规则、能力限制等） */
  validateModel(m: Model): string[];
  /** 重新计算一张表上所有推导名（改表名、改列名、改约束列后调用） */
  refreshDerivedNames(m: Model, tableId: string): void;
  /** 判定某个名字在对应命名空间是否被别的对象占用 */
  isNameTaken(
    m: Model,
    space: 'rel' | 'con' | 'type',
    containerId: string,
    name: string,
    selfId: string,
  ): boolean;
  plan(from: Model, to: Model, opts?: PlanOptions): Step[];
  createAll(m: Model, opts?: PlanOptions): Step[];
  isNontransactionalSql(sql: string): boolean;
  isConcurrentDdlSql(sql: string): boolean;
  findInstanceLevelStatement(sql: string): string | null;
  instanceLevelDescription: string;
  /** 画布复制粘贴的方言适配器（命名空间、推导名、类型 / 自增 / 聚集索引兼容性、分区等） */
  readonly clipboard: ClipboardDialect;
  /** 版本语义钩子（分组、目标版本、对外大版本、格式化） */
  readonly versioning: DialectVersioning;
}
