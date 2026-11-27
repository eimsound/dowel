// 引擎注册表：按方言获取 EngineAdapter（Wave 4 MySQL / MSSQL 在此注册）。
import { type Dialect, engineFullVersion } from '@dowel/core';

import { mssqlEngine } from './mssql/engine.ts';
import { mysqlEngine } from './mysql/engine.ts';
import { pgEngine } from './pg/engine.ts';
import { sqliteEngine } from './sqlite/engine.ts';
import type { Db, EngineAdapter } from './types.ts';

const engines = new Map<Dialect, EngineAdapter>([
  ['pg', pgEngine],
  ['sqlite', sqliteEngine],
  ['mysql', mysqlEngine],
  ['mssql', mssqlEngine],
]);

export const registerEngine = (adapter: EngineAdapter): void => {
  engines.set(adapter.dialect, adapter);
};

export const hasEngine = (dialect: Dialect): boolean => engines.has(dialect);

export const registeredEngines = (): Dialect[] => [...engines.keys()];

export const getEngine = (dialect: Dialect): EngineAdapter => {
  const adapter = engines.get(dialect);
  if (!adapter) throw new Error(`方言引擎 ${dialect} 尚未启用或未注册`);
  return adapter;
};

/**
 * 读数据库完整版本号（ADR 0017 决定 5）：引擎实现了 readFullVersion 就用它，否则由 readVersionNum 推导
 * （PG 两段、MySQL 三段、SQLite 内置库版本）。读不到返回 null。
 */
export const readEngineFullVersion = async (dialect: Dialect, db: Db): Promise<string | null> => {
  const engine = getEngine(dialect);
  if (engine.readFullVersion) return engine.readFullVersion(db);
  const versionNum = (await engine.readVersionNum?.(db)) ?? null;
  return engineFullVersion(dialect, { versionNum });
};
