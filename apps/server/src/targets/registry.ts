// 服务端目标库驱动注册表（Wave 4 MySQL / MSSQL 在此追加注册）。
import type { TargetInfo } from '@dowel/api';
import type { Dialect, Model } from '@dowel/core';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { detectUrlDialect } from '../allowlist.ts';
import { mssqlTargetDriver } from './mssql.ts';
import { pgTargetDriver } from './pg.ts';
import { sqliteTargetDriver } from './sqlite.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  type ConnectionGuard,
  type TargetConnection,
  type TargetDriver,
} from './types.ts';

const drivers = new Map<Dialect, TargetDriver>([
  ['pg', pgTargetDriver],
  ['sqlite', sqliteTargetDriver],
  ['mssql', mssqlTargetDriver],
]);

export const registerTargetDriver = (driver: TargetDriver): void => {
  drivers.set(driver.dialect, driver);
};

export const hasTargetDriver = (dialect: Dialect): boolean => drivers.has(dialect);

export const getTargetDriver = (dialect: Dialect): TargetDriver => {
  const driver = drivers.get(dialect);
  if (!driver) throw new HTTPException(422, { message: `方言 ${dialect} 暂未支持目标库连接` });
  return driver;
};

const dialectFor = (url: string, explicit?: Dialect): Dialect => explicit ?? detectUrlDialect(url) ?? 'pg';

export const connectTarget = (
  dialect: Dialect,
  url: string,
  connectTimeout = 10,
  guard?: ConnectionGuard,
): TargetConnection => getTargetDriver(dialect).connect(url, connectTimeout, guard);

export const inspectTarget = (
  url: string,
  connectTimeout = CHECK_CONNECT_TIMEOUT,
  guard?: ConnectionGuard,
  dialect?: Dialect,
): Promise<TargetInfo> => getTargetDriver(dialectFor(url, dialect)).inspectTarget(url, connectTimeout, guard);

export const inspectTargetOn = (tdb: Db, url: string, dialect?: Dialect): Promise<TargetInfo> =>
  getTargetDriver(dialectFor(url, dialect)).inspectTargetOn(tdb, url);

export const pullSchema = (
  url: string,
  schemas?: string[] | null,
  guard?: ConnectionGuard,
  dialect?: Dialect,
): Promise<Model> => getTargetDriver(dialectFor(url, dialect)).pullSchema(url, schemas, guard);

export const claimShadow = async (url: string, guard?: ConnectionGuard, dialect?: Dialect): Promise<void> => {
  await getTargetDriver(dialectFor(url, dialect)).claimShadow?.(url, guard);
};

export const dropSameInstanceShadow = async (
  targetUrl: string,
  name: string,
  guard?: ConnectionGuard,
  dialect?: Dialect,
): Promise<void> => {
  await getTargetDriver(dialectFor(targetUrl, dialect)).dropSameInstanceShadow?.(targetUrl, name, guard);
};

export const classifyTargetDriverError = (err: unknown, dialect?: Dialect): 'connect' | 'database' | null => {
  if (dialect) return getTargetDriver(dialect).classifyDriverError(err);
  for (const d of drivers.values()) {
    const res = d.classifyDriverError(err);
    if (res) return res;
  }
  return null;
};
