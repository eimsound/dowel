// Vitest 全局准备：所有测试文件共用一个 PG 实例，每个文件在里面建自己的库（见 test/pg.ts）。
import type { TestProject } from 'vitest/node';

import { startPg } from './pg-container.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    /** 测试用 PG 的管理连接串；没有 Docker 时为空字符串 */
    pgUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const pg = await startPg();
  project.provide('pgUrl', pg?.url ?? '');
  return () => pg?.stop();
}
