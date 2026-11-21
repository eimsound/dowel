// 空库模型：表示“项目 schema 范围内的一个全新数据库”。按方言派发，纯函数。
import type { Model } from './ir.ts';
import { getDialect } from './registry.ts';

/** PG 项目的 schema 范围是否覆盖 public（null / 空表示全部） */
export const scopeCoversPublic = (scope: string[] | null | undefined): boolean =>
  !scope?.length || scope.includes('public');

/**
 * 空库的模型：表示“范围内的一个全新数据库”。
 * - PG：由 schema 范围决定是否包含 public（沿用目标模型里 public 的 ID 或固定 ID）；
 * - SQLite：单逻辑 schema `main`（沿用目标模型里 main 的 ID 或固定 ID）；
 * - MySQL / MSSQL：由各自 DialectSpec.emptyBase 决定。
 */
export const emptyBase = (like: Model, scope: string[] | null | undefined): Model =>
  getDialect(like.dialect).emptyBase(like, scope);
