// 测试用的 MSSQL（SQL Server 2019 / 2022 / 2025）：
// - DOWEL_TEST_MSSQL=skip：显式跳过；
// - DOWEL_TEST_MSSQL=<url>：直接使用外部实例；
// - 未设 DOWEL_TEST_MSSQL 时，仅在显式设置 MSSQL_VERSION 或 DOWEL_MSSQL_IMAGE 时拉起单个共享容器，
//   避免普通 `pnpm test` 无故下载并启动 2GiB+ SQL Server 镜像。
import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import { getContainerRuntimeClient } from 'testcontainers';

export type MssqlTestVersion = '2019' | '2022' | '2025';

export const MSSQL_VERSION: MssqlTestVersion =
  process.env.MSSQL_VERSION === '2019' || process.env.MSSQL_VERSION === '2025'
    ? process.env.MSSQL_VERSION
    : '2022';

export const MSSQL_IMAGE =
  process.env.DOWEL_MSSQL_IMAGE ?? `mcr.microsoft.com/mssql/server:${MSSQL_VERSION}-latest`;

const TEST_PASSWORD = process.env.DOWEL_MSSQL_PASSWORD ?? 'DowelTest!2026';

export const startMssql = async (): Promise<{ url: string; stop: () => Promise<void> } | null> => {
  const given = process.env.DOWEL_TEST_MSSQL?.trim();
  if (given === 'skip') return null;
  if (given) return { url: given, stop: async () => {} };
  if (!process.env.MSSQL_VERSION && !process.env.DOWEL_MSSQL_IMAGE) return null;

  try {
    await getContainerRuntimeClient();
  } catch (e) {
    if (process.env.CI) throw e;
    console.warn(
      `\n⚠ 没有可用的 Docker（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）：跳过所有需要 MSSQL 的测试。\n`,
    );
    return null;
  }

  const container = await new MSSQLServerContainer(MSSQL_IMAGE)
    .acceptLicense()
    .withPassword(TEST_PASSWORD)
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const user = encodeURIComponent(container.getUsername());
  const pass = encodeURIComponent(container.getPassword());
  const url = `mssql://${user}:${pass}@${host}:${port}/master?encrypt=true&trustServerCertificate=true`;
  return { url, stop: async () => void (await container.stop().catch(() => {})) };
};
