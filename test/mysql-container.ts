// 测试用 MySQL 全局单容器：
// - DOWEL_TEST_MYSQL=skip|0|false 时直接跳过；
// - DOWEL_TEST_MYSQL=mysql://... 时直接连外部实例；
// - 仅在显式设置 MYSQL_VERSION 或 DOWEL_MYSQL_IMAGE 时通过 Testcontainers 启动全局单容器，避免默认 pnpm test 拉起 MySQL 容器。
import { MySqlContainer } from '@testcontainers/mysql';
import { getContainerRuntimeClient } from 'testcontainers';

const SKIP_RE = /^(?:skip|0|false|none|off)$/i;

export const startMysql = async (): Promise<{ url: string; stop: () => Promise<void> } | null> => {
  const given = process.env.DOWEL_TEST_MYSQL?.trim();
  if (given) {
    if (SKIP_RE.test(given)) return null;
    return { url: given, stop: async () => {} };
  }

  const version = process.env.MYSQL_VERSION?.trim();
  const explicitImage = process.env.DOWEL_MYSQL_IMAGE?.trim();
  if (!version && !explicitImage) return null;

  const image = explicitImage || `mysql:${version}`;
  try {
    await getContainerRuntimeClient();
  } catch (e) {
    if (process.env.CI) throw e;
    console.warn(
      `\n⚠ 没有可用的 Docker（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）：跳过所有需要 MySQL 的测试。` +
        '\n  启动 Docker 或设置 DOWEL_TEST_MYSQL=mysql://root:pass@127.0.0.1:3306/mysql。\n',
    );
    return null;
  }

  const container = await new MySqlContainer(image)
    .withDatabase('mysql')
    .withUsername('dowel')
    .withUserPassword('dowel-test-secret')
    .withRootPassword('dowel-root-secret')
    .start();

  const url = `mysql://root:${encodeURIComponent(container.getRootPassword())}@${container.getHost()}:${container.getPort()}/mysql`;
  return { url, stop: async () => void (await container.stop().catch(() => {})) };
};
