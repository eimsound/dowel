// 方言静态注册表与跨方言派发入口（零动态 import，浏览器轻量安全）。
import type { DialectSpec } from './dialect.ts';
import type { Dialect, Model } from './ir.ts';
import type { PlanOptions } from './pg/capabilities.ts';
import { pgDialect } from './pg/dialect.ts';
import { PlanError, type Step } from './plan-types.ts';
import { sqliteDialect } from './sqlite/dialect.ts';

export const SUPPORTED_DIALECTS: readonly Dialect[] = ['pg', 'sqlite', 'mysql', 'mssql'];

const dialects = new Map<Dialect, DialectSpec>([
  ['pg', pgDialect],
  ['sqlite', sqliteDialect],
]);

export const registerDialect = (spec: DialectSpec): void => {
  dialects.set(spec.id, spec);
};

export const hasDialect = (d: Dialect): boolean => dialects.has(d);

export const registeredDialects = (): Dialect[] => [...dialects.keys()];

export const getDialect = (d: Dialect): DialectSpec => {
  const spec = dialects.get(d);
  if (!spec) throw new PlanError(`方言 ${d} 尚未启用或未注册`);
  return spec;
};

// ───── 跨方言统一派发函数（默认 dialect = 'pg' 保持 100% 向后兼容） ─────

export const plan = (from: Model, to: Model, opts?: PlanOptions): Step[] => {
  if (from.dialect !== to.dialect) {
    throw new PlanError(`无法跨方言规划迁移：${from.dialect} → ${to.dialect}`);
  }
  return getDialect(to.dialect).plan(from, to, opts);
};

export const createAll = (m: Model, opts?: PlanOptions): Step[] => getDialect(m.dialect).createAll(m, opts);

export const isNontransactionalSql = (sql: string, dialect: Dialect = 'pg'): boolean =>
  getDialect(dialect).isNontransactionalSql(sql);

export const isConcurrentDdlSql = (sql: string, dialect: Dialect = 'pg'): boolean =>
  getDialect(dialect).isConcurrentDdlSql(sql);

export const findInstanceLevelStatement = (sql: string, dialect: Dialect = 'pg'): string | null =>
  getDialect(dialect).findInstanceLevelStatement(sql);

export const isInstanceLevelSql = (sql: string, dialect: Dialect = 'pg'): boolean =>
  findInstanceLevelStatement(sql, dialect) !== null;

export const findInstanceLevelStep = (steps: { sql: string }[], dialect: Dialect = 'pg'): number =>
  steps.findIndex((s) => isInstanceLevelSql(s.sql, dialect));

export const instanceLevelDescription = (dialect: Dialect = 'pg'): string =>
  getDialect(dialect).instanceLevelDescription;

export const normalizeType = (input: string, dialect: Dialect = 'pg'): string =>
  getDialect(dialect).normalizeType(input);

export const commonTypes = (dialect: Dialect = 'pg'): readonly string[] => getDialect(dialect).commonTypes;

export const formatScript = (steps: readonly { sql: string }[], dialect: Dialect = 'pg'): string =>
  getDialect(dialect).formatScript(steps);
