// Vitest 全局准备：所有测试文件共用一个 PG 实例（以及按需启用的单个 MSSQL 实例），每个文件在里面建自己的库。
import type { TestProject } from 'vitest/node';

import { startMssql } from './mssql-container.ts';
import { startPg } from './pg-container.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** 测试用 PG 的管理连接串；没有 Docker 时为空字符串 */
    pgUrl: string;
    /** 测试用 MSSQL 的管理连接串；未启用或无 Docker 时为空字符串 */
    mssqlUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, mssql] = await Promise.all([startPg(), startMssql()]);
  project.provide('pgUrl', pg?.url ?? '');
  project.provide('mssqlUrl', mssql?.url ?? '');
  return async () => {
    await Promise.all([pg?.stop(), mssql?.stop()]);
  };
}
