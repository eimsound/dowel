// 端到端测试的 PG：与单元测试相同（Testcontainers 或 DOWEL_TEST_PG），通过环境变量 DOWEL_TEST_PG 传给测试进程。
// 没有 Docker 时不设置，需要 PG 的用例跳过。
import { startPg } from '../test/pg-container.ts';

export default async function globalSetup() {
  const pg = await startPg();
  if (pg) process.env.DOWEL_TEST_PG = pg.url;
  return () => pg?.stop();
}
