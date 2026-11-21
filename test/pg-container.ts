// 测试用的 PostgreSQL：
// - DOWEL_TEST_PG=skip|0|false|none|off：显式跳过；
// - DOWEL_TEST_PG=<url>：直接使用外部实例；
// - 否则用 Testcontainers 起一个容器（带 pgvector 的 PG 18）；没有 Docker 时返回 null 并给出警告，CI 上直接报错避免悄悄跳过。
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';

const SKIP_RE = /^(?:skip|0|false|none|off)$/i;

export const PG_IMAGE = process.env.DOWEL_PG_IMAGE ?? 'pgvector/pgvector:pg18';

export const startPg = async (): Promise<{ url: string; stop: () => Promise<void> } | null> => {
  const given = process.env.DOWEL_TEST_PG?.trim();
  if (given) {
    if (SKIP_RE.test(given)) return null;
    return { url: given, stop: async () => {} };
  }
  try {
    await getContainerRuntimeClient();
  } catch (e) {
    if (process.env.CI) throw e;
    console.warn(
      `\n⚠ 没有可用的 Docker（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）：跳过所有需要 PostgreSQL 的测试。` +
        '\n  安装并启动 Docker，或设置 DOWEL_TEST_PG=postgres://user:pass@host:port/postgres（需要建库权限）。\n',
    );
    return null;
  }
  // 用 postgres 账号：导入的 schema（如 pagila）里常有 OWNER TO postgres
  const c = await new PostgreSqlContainer(PG_IMAGE)
    .withUsername('postgres')
    .withPassword('dowel-test-secret')
    .start();
  return { url: c.getConnectionUri(), stop: async () => void (await c.stop()) };
};
