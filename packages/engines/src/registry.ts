// 引擎注册表：按方言获取 EngineAdapter（Wave 4 MySQL / MSSQL 在此注册）。
import type { Dialect } from '@dowel/core';

import { mssqlEngine } from './mssql/engine.ts';
import { mysqlEngine } from './mysql/engine.ts';
import { pgEngine } from './pg/engine.ts';
import { sqliteEngine } from './sqlite/engine.ts';
import type { EngineAdapter } from './types.ts';

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
