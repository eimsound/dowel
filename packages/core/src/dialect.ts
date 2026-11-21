// 多方言统一抽象契约（纯函数、无 I/O，前后端共用、浏览器轻量安全）。
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
}
