// Vitest 全局准备：所有测试文件共用全局 PG / MySQL / MSSQL 实例，每个文件在里面建自己的库（见 test/pg.ts、test/mysql.ts、test/mssql.ts）。
import type { TestProject } from 'vitest/node';

import { startMssql } from './mssql-container.ts';
import { startMysql } from './mysql-container.ts';
import { startPg } from './pg-container.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** 测试用 PG 的管理连接串；没有 Docker 时为空字符串 */
    pgUrl: string;
    /** 测试用 MySQL 的管理连接串；未启用或没有 Docker 时为空字符串 */
    mysqlUrl: string;
    /** 测试用 MSSQL 的管理连接串；未启用或无 Docker 时为空字符串 */
    mssqlUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, mysql, mssql] = await Promise.all([startPg(), startMysql(), startMssql()]);
  project.provide('pgUrl', pg?.url ?? '');
  project.provide('mysqlUrl', mysql?.url ?? '');
  project.provide('mssqlUrl', mssql?.url ?? '');
  return async () => {
    await Promise.all([pg?.stop(), mysql?.stop(), mssql?.stop()]);
  };
}
