// Issue #53：测试容器跳过标记（skip|0|false|none|off）、空白/带空格连接串与 e2e globalSetup 环境变量清理的纯单测（不依赖 Docker）。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getContainerRuntimeClient: vi.fn(),
  pgCtor: vi.fn(),
  pgStart: vi.fn(),
  mysqlCtor: vi.fn(),
  mysqlStart: vi.fn(),
  mssqlCtor: vi.fn(),
  mssqlStart: vi.fn(),
}));

vi.mock('testcontainers', () => ({
  getContainerRuntimeClient: mocks.getContainerRuntimeClient,
}));

vi.mock('@testcontainers/postgresql', () => ({
  PostgreSqlContainer: class {
    constructor() {
      mocks.pgCtor();
    }
    withUsername() {
      return this;
    }
    withPassword() {
      return this;
    }
    start() {
      return mocks.pgStart();
    }
  },
}));

vi.mock('@testcontainers/mysql', () => ({
  MySqlContainer: class {
    constructor() {
      mocks.mysqlCtor();
    }
    withDatabase() {
      return this;
    }
    withUsername() {
      return this;
    }
    withUserPassword() {
      return this;
    }
    withRootPassword() {
      return this;
    }
    start() {
      return mocks.mysqlStart();
    }
  },
}));

vi.mock('@testcontainers/mssqlserver', () => ({
  MSSQLServerContainer: class {
    constructor() {
      mocks.mssqlCtor();
    }
    acceptLicense() {
      return this;
    }
    withPassword() {
      return this;
    }
    start() {
      return mocks.mssqlStart();
    }
  },
}));

import globalSetup from '../../../e2e/global-setup.ts';
import { startMssql } from '../../../test/mssql-container.ts';
import { getMssqlAdminUrl } from '../../../test/mssql.ts';
import { startMysql } from '../../../test/mysql-container.ts';
import { startPg } from '../../../test/pg-container.ts';

const SKIP_VALUES = ['skip', 'SKIP', ' skip ', '0', 'false', 'none', 'off'] as const;

describe('测试容器跳过标记与连接串规范化', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getContainerRuntimeClient.mockRejectedValue(new Error('docker disabled in unit test'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const key of [
      'CI',
      'DOWEL_TEST_PG',
      'DOWEL_TEST_MYSQL',
      'DOWEL_TEST_MSSQL',
      'MYSQL_VERSION',
      'DOWEL_MYSQL_IMAGE',
      'MSSQL_VERSION',
      'DOWEL_MSSQL_IMAGE',
    ]) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test.each(SKIP_VALUES)('startPg 对跳过值 %j 返回 null 且不触发 Docker', async (val) => {
    vi.stubEnv('DOWEL_TEST_PG', val);
    expect(await startPg()).toBeNull();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.pgCtor).not.toHaveBeenCalled();
    expect(mocks.pgStart).not.toHaveBeenCalled();
  });

  test.each(SKIP_VALUES)('startMysql 对跳过值 %j 返回 null 且不触发 Docker', async (val) => {
    vi.stubEnv('MYSQL_VERSION', '8.4');
    vi.stubEnv('DOWEL_TEST_MYSQL', val);
    expect(await startMysql()).toBeNull();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.mysqlCtor).not.toHaveBeenCalled();
    expect(mocks.mysqlStart).not.toHaveBeenCalled();
  });

  test.each(SKIP_VALUES)(
    'startMssql 与 getMssqlAdminUrl 对跳过值 %j 返回 null 且不触发 Docker',
    async (val) => {
      vi.stubEnv('MSSQL_VERSION', '2022');
      vi.stubEnv('DOWEL_TEST_MSSQL', val);
      expect(await startMssql()).toBeNull();
      expect(await getMssqlAdminUrl()).toBeNull();
      expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
      expect(mocks.mssqlCtor).not.toHaveBeenCalled();
      expect(mocks.mssqlStart).not.toHaveBeenCalled();
    },
  );

  test('纯空白值不会误当作连接串', async () => {
    vi.stubEnv('DOWEL_TEST_PG', '   ');
    expect(await startPg()).toBeNull();
    expect(mocks.getContainerRuntimeClient).toHaveBeenCalledTimes(1);
    expect(mocks.pgCtor).not.toHaveBeenCalled();
    expect(mocks.pgStart).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv('DOWEL_TEST_MYSQL', '   ');
    expect(await startMysql()).toBeNull();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();

    vi.stubEnv('MYSQL_VERSION', '8.4');
    expect(await startMysql()).toBeNull();
    expect(mocks.getContainerRuntimeClient).toHaveBeenCalledTimes(1);
    expect(mocks.mysqlCtor).not.toHaveBeenCalled();
    expect(mocks.mysqlStart).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv('DOWEL_TEST_MSSQL', '   ');
    expect(await startMssql()).toBeNull();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();

    vi.stubEnv('MSSQL_VERSION', '2022');
    expect(await startMssql()).toBeNull();
    expect(mocks.getContainerRuntimeClient).toHaveBeenCalledTimes(1);
    expect(mocks.mssqlCtor).not.toHaveBeenCalled();
    expect(mocks.mssqlStart).not.toHaveBeenCalled();
  });

  test('带首尾空格的连接串返回 trim 后的 { url, stop } 且不启动容器', async () => {
    const pgUrl = 'postgres://user:pass@127.0.0.1:5432/postgres';
    vi.stubEnv('DOWEL_TEST_PG', `  ${pgUrl}  `);
    const pg = await startPg();
    expect(pg?.url).toBe(pgUrl);
    await expect(pg?.stop()).resolves.toBeUndefined();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.pgCtor).not.toHaveBeenCalled();
    expect(mocks.pgStart).not.toHaveBeenCalled();

    const mysqlUrl = 'mysql://root:pass@127.0.0.1:3306/mysql';
    vi.stubEnv('DOWEL_TEST_MYSQL', `  ${mysqlUrl}  `);
    const mysql = await startMysql();
    expect(mysql?.url).toBe(mysqlUrl);
    await expect(mysql?.stop()).resolves.toBeUndefined();
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.mysqlCtor).not.toHaveBeenCalled();
    expect(mocks.mysqlStart).not.toHaveBeenCalled();

    const mssqlUrl = 'mssql://sa:pass@127.0.0.1:1433/master';
    vi.stubEnv('DOWEL_TEST_MSSQL', `  ${mssqlUrl}  `);
    const mssql = await startMssql();
    expect(mssql?.url).toBe(mssqlUrl);
    await expect(mssql?.stop()).resolves.toBeUndefined();
    expect(await getMssqlAdminUrl()).toBe(mssqlUrl);
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.mssqlCtor).not.toHaveBeenCalled();
    expect(mocks.mssqlStart).not.toHaveBeenCalled();
  });

  test('e2e globalSetup 在 DOWEL_TEST_PG=skip 时删除环境变量，在有效 URL 时写入 trim 后值', async () => {
    vi.stubEnv('DOWEL_TEST_PG', 'skip');
    const teardownSkip = await globalSetup();
    expect(process.env.DOWEL_TEST_PG).toBeUndefined();
    expect('DOWEL_TEST_PG' in process.env).toBe(false);
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.pgCtor).not.toHaveBeenCalled();
    expect(mocks.pgStart).not.toHaveBeenCalled();
    expect(teardownSkip()).toBeUndefined();

    const pgUrl = 'postgres://user:pass@127.0.0.1:5432/postgres';
    vi.stubEnv('DOWEL_TEST_PG', `  ${pgUrl}  `);
    const teardownUrl = await globalSetup();
    expect(process.env.DOWEL_TEST_PG).toBe(pgUrl);
    expect(mocks.getContainerRuntimeClient).not.toHaveBeenCalled();
    expect(mocks.pgCtor).not.toHaveBeenCalled();
    expect(mocks.pgStart).not.toHaveBeenCalled();
    await expect(teardownUrl()).resolves.toBeUndefined();
  });
});
