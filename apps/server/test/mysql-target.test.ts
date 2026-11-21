// MySQL 目标库服务端全栈测试：
// - URL 校验、socketPath/SSRF/方言不匹配拦截、影子库名 64 字符截断；
// - inspectTarget、pullSchema、同实例影子库 claimShadow 防误删业务库与安全清理；
// - Hono 全栈：向导从现有 MySQL 库导入、SQL 导入拦截实例级语句、编辑模型、同实例影子库自动验证发布与升级/回滚。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  ExecEvent,
  ProjectCreated,
  ProjectInfo,
  TargetInfo,
  VersionCreated,
  VersionDetail,
  WizardEvent,
} from '@dowel/api';
import {
  addCheck,
  addColumn,
  addPrimaryKey,
  all,
  createSchema,
  createTable,
  emptyBase,
  emptyModel,
  MYSQL_SHADOW_MARK_TABLE,
  newId,
  PlanError,
} from '@dowel/core';
import {
  alignMysqlImportedLive,
  type Db,
  detectMysqlStepAlreadyApplied,
  fromMysql2,
  mysqlExprCanonEqual,
  mysqlGrantMatchesDb,
  mysqlHistory,
  updateExistingTablesAfterStep,
} from '@dowel/engines';
import { StepError, verifyScripts } from '@dowel/verifier';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createMysqlTestDb, mysqlDbUrl, useMysqlTestDb } from '../../../test/mysql.ts';
import { formatVersionNum } from '../src/envs.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { isConnectionFailure, isInfraFailure, type Shadow, shadowOps } from '../src/shadow.ts';
import { Shadows } from '../src/shadows.ts';
import {
  claimMysqlShadow,
  dropMysqlSameInstanceShadow,
  ensureSameInstanceMysqlShadow,
  mysqlShadowDbName,
  parseMysqlUrl,
  pullMysqlSchema,
} from '../src/targets/mysql.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

const parseSse = <T>(text: string): T[] =>
  text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5).trim()) as T);

describe('MySQL 目标库服务端驱动与全栈', () => {
  const getMysql = useMysqlTestDb('srv_mysql');

  let tmpDir = '';
  let pdb: PlatformDb;
  let createdApp: ReturnType<typeof createApp>;
  let app: ReturnType<typeof createApp>['app'];
  let rooms: ReturnType<typeof createApp>['rooms'];
  let shadows: ReturnType<typeof createApp>['shadows'];
  let cookie = '';
  let groupId = '';

  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'dowel-mysql-target-'));
    pdb = await openPlatformDb(path.join(tmpDir, 'platform.sqlite'));
    createdApp = createApp(pdb, {
      connectionLimiter: new KeyedLimiter({ limit: 1000, windowMs: 60_000 }),
    });
    app = createdApp.app;
    rooms = createdApp.rooms;
    shadows = createdApp.shadows;

    await makeUser(pdb, 'alice', { role: 'admin' });
    const loginRes = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: PASSWORD }),
    });
    expect(loginRes.status).toBe(200);
    cookie = loginRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const groupsRes = await req('GET', '/api/groups');
    const { groups } = (await groupsRes.json()) as { groups: { id: string }[] };
    if (groups[0]) {
      groupId = groups[0].id;
    } else {
      const createG = await req('POST', '/api/groups', { name: 'Team', slug: 'team' });
      groupId = ((await createG.json()) as { id: string }).id;
    }
  });

  afterAll(async () => {
    createdApp?.requests.stop();
    createdApp?.refresher.stop();
    await Promise.all([createdApp?.requests.drain(), createdApp?.refresher.drain()]);
    await createdApp?.webhooks.close();
    await createdApp?.rooms.flush();
    await createdApp?.shadows.close();
    await createdApp?.bus.close();
    await createdApp?.ha.stop();
    await pdb?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('纯校验：parseMysqlUrl 拒绝 socketPath、TLS 默认不关证书校验、shadowDbName <= 64 字符、方言不匹配 422', async () => {
    expect(() => parseMysqlUrl('mysql://root:pw@127.0.0.1:3306/app?socketPath=/var/run/mysqld.sock')).toThrow(
      /socketPath/,
    );
    const tlsOpts = parseMysqlUrl('mysql://root:pw@db.example.com:3306/app?ssl=true');
    expect(tlsOpts.multipleStatements).toBe(false);
    expect(tlsOpts.ssl).toEqual({ rejectUnauthorized: true });

    const shortShadow = mysqlShadowDbName('app');
    expect(shortShadow).toBe('app_dowel');
    const longDb = 'a'.repeat(63);
    const longShadow = mysqlShadowDbName(longDb);
    expect(Array.from(longShadow).length).toBeLessThanOrEqual(64);
    expect(longShadow.endsWith('_dowel')).toBe(true);

    // 连接检查拒绝 socketPath 与方言不匹配
    const sockRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: 'mysql://root:pw@127.0.0.1:3306/app?socketPath=/tmp/mysql.sock',
    });
    expect(sockRes.status).toBe(422);

    const mismatch = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: 'postgres://user:pass@127.0.0.1:5432/app',
    });
    expect(mismatch.status).toBe(422);

    // M2: IPv6 去括号、ssl-mode 别名兼容、非法 ssl-mode 严格 422
    const ipv6Opts = parseMysqlUrl('mysql://root:pw@[::1]:3307/app?ssl-mode=VERIFY-FULL');
    expect(ipv6Opts.host).toBe('::1');
    expect(ipv6Opts.port).toBe(3307);
    expect(ipv6Opts.ssl).toEqual({ rejectUnauthorized: true });
    expect(parseMysqlUrl('mysql://root:pw@db.example.com/app?sslmode=require').ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(parseMysqlUrl('mysql://root:pw@db.example.com/app?ssl-mode=verify-ca').ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(parseMysqlUrl('mysql://root:pw@db.example.com/app?ssl-mode=DISABLED').ssl).toBeUndefined();
    expect(() => parseMysqlUrl('mysql://root:pw@db.example.com/app?ssl-mode=TYPO_MODE')).toThrow(
      /不支持的 MySQL ssl-mode/,
    );

    // H5: MySQL 基础设施错误分类与版本号格式化
    expect(isConnectionFailure({ code: 'PROTOCOL_CONNECTION_LOST' })).toBe(true);
    expect(isConnectionFailure({ code: 'HANDSHAKE_NO_SSL_SUPPORT' })).toBe(true);
    expect(isConnectionFailure({ errno: 2006 })).toBe(true);
    expect(isConnectionFailure({ errno: 1205 })).toBe(true);
    expect(isInfraFailure({ errno: 2013 })).toBe(true);
    expect(isInfraFailure({ errno: 3024 })).toBe(true);
    expect(
      isInfraFailure(
        new StepError({ kind: 'frozen', target: 'up#1', sql: 'SELECT 1' }, { errno: 3024 }, 500),
      ),
    ).toBe(false);
    expect(formatVersionNum(80413, 'mysql')).toBe('8.4.13');
    expect(formatVersionNum(90700, 'mysql')).toBe('9.7.0');

    // M1: SHOW GRANTS 的 LIKE 转义与通配符匹配
    expect(mysqlGrantMatchesDb('GRANT CREATE ON `my\\_app`.* TO `u`@`%`', 'my_app')).toBe(true);
    expect(mysqlGrantMatchesDb('GRANT CREATE ON `my\\_app`.* TO `u`@`%`', 'myXapp')).toBe(false);
    expect(mysqlGrantMatchesDb('GRANT CREATE ON `app\\_%`.* TO `u`@`%`', 'app_dowel')).toBe(true);
    expect(mysqlGrantMatchesDb('GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`', 'anydb')).toBe(true);

    // M5: MySQL 表达式规范化等价与 alignMysqlImportedLive
    expect(
      mysqlExprCanonEqual(
        "((`status` in (_utf8mb4'open',_utf8mb4'closed')))",
        "status IN ('open', 'closed')",
      ),
    ).toBe(true);
    expect(mysqlExprCanonEqual('((`age` >= 18) and (`score` <> 0))', 'age >= 18 AND score != 0')).toBe(true);
    expect(mysqlExprCanonEqual("(_utf8mb4'it\\'s')", "'it''s'")).toBe(true);
    expect(mysqlExprCanonEqual('(a + b) * 2', 'a + b * 2')).toBe(false);

    const refM = emptyModel('mysql');
    const rs = createSchema(refM, 'default');
    const rt = createTable(refM, rs, 'users');
    const rid = addColumn(refM, rt, { name: 'id', type: 'int', notNull: true });
    const rst = addColumn(refM, rt, {
      name: 'status',
      type: 'varchar(20)',
      notNull: true,
      default: { expr: "'open'" },
    });
    addPrimaryKey(refM, rt, [rid]);
    const rck = addCheck(refM, rt, "status IN ('open', 'closed')");

    const liveM = structuredClone(refM);
    (liveM.objects[rck] as { expr: string }).expr = "(`status` in (_utf8mb4'open',_utf8mb4'closed'))";
    (liveM.objects[rst] as { default: { expr: string } }).default = { expr: "(_utf8mb4'open')" };
    const aligned = alignMysqlImportedLive(liveM, refM);
    expect((aligned.objects[rck] as { expr: string }).expr).toBe("status IN ('open', 'closed')");
    expect((aligned.objects[rst] as { default: { expr: string } }).default).toEqual({ expr: "'open'" });

    // M4: detectMysqlStepAlreadyApplied 错误码过滤、拒绝跨库限定与 KEY_COLUMN_USAGE 列序核对
    const mockConn: Db = {
      query: async <T>(sql: string) => {
        if (sql.includes('TABLE_CONSTRAINTS')) return [{ n: 1 }] as T[];
        if (sql.includes('KEY_COLUMN_USAGE')) {
          return [{ columnName: 'b' }, { columnName: 'a' }] as T[];
        }
        return [{ n: 1 }] as T[];
      },
      exec: async () => {},
    };
    // 非幂等错误码（如 1064 语法错误 / 1142 权限错误）必须拒绝跳过
    expect(
      await detectMysqlStepAlreadyApplied(
        mockConn,
        { sql: 'CREATE TABLE `users` (`id` INT)', transactional: false },
        { errno: 1142 },
      ),
    ).toBe(false);
    // 跨库限定 db.tbl 必须拒绝跳过
    expect(
      await detectMysqlStepAlreadyApplied(
        mockConn,
        { sql: 'CREATE TABLE `otherdb`.`users` (`id` INT)', transactional: false },
        { errno: 1050 },
      ),
    ).toBe(false);
    // PRIMARY KEY 列序不匹配 (a, b) vs (b, a) 必须返回 false；匹配 (b, a) 返回 true
    expect(
      await detectMysqlStepAlreadyApplied(
        mockConn,
        { sql: 'ALTER TABLE `users` ADD PRIMARY KEY (`a`, `b`)', transactional: false },
        { errno: 1068 },
      ),
    ).toBe(false);
    expect(
      await detectMysqlStepAlreadyApplied(
        mockConn,
        { sql: 'ALTER TABLE `users` ADD PRIMARY KEY (`b`, `a`)', transactional: false },
        { errno: 1068 },
      ),
    ).toBe(true);

    // R2-2: 9.7 dev + 8.4 prod 混部下 verifyScripts 与 shadowOps.verifyScripts 阻断 VECTOR(3)
    const mVec = emptyModel('mysql');
    const sv = createSchema(mVec, 'default');
    const emb = createTable(mVec, sv, 'embeddings');
    const eid = addColumn(mVec, emb, { name: 'id', type: 'int', notNull: true });
    addColumn(mVec, emb, { name: 'vec', type: 'vector(3)', notNull: true });
    addPrimaryKey(mVec, emb, [eid]);
    const vecFrom = emptyBase(mVec, null);
    const mockMysql97Db: Db = {
      query: async <T>(sql: string) => {
        if (/SELECT\s+VERSION\(\)/i.test(sql)) return [{ v: '9.7.0' }] as T[];
        return [] as T[];
      },
      exec: async () => {},
    };
    await expect(
      verifyScripts(
        mockMysql97Db,
        vecFrom,
        mVec,
        [
          {
            sql: 'CREATE TABLE `embeddings` (`id` int PRIMARY KEY, `vec` vector(3) NOT NULL)',
            transactional: false,
          },
        ],
        [{ sql: 'DROP TABLE `embeddings`', transactional: false }],
        { mysqlVersionNum: 80400 },
      ),
    ).rejects.toThrow(PlanError);
    const ops97 = shadowOps(async () => mockMysql97Db, null, { dialect: 'mysql' });
    const vecReport = await ops97.verifyScripts(
      vecFrom,
      mVec,
      [
        {
          sql: 'CREATE TABLE `embeddings` (`id` int PRIMARY KEY, `vec` vector(3) NOT NULL)',
          transactional: false,
        },
      ],
      [{ sql: 'DROP TABLE `embeddings`', transactional: false }],
      { mysqlVersionNum: 80400 },
    );
    expect(vecReport.ok).toBe(false);
    expect(vecReport.error?.message).toMatch(/VECTOR.*8\.4/);

    // R2-2: Shadows.forProjectVersions 对 MySQL 8.4 + 9.7 混部按主次版本分组（804 / 907），同时保持 PG 字段为空
    const mixPid = newId();
    await pdb.query(
      `insert into projects (id, group_id, name, slug, dialect) values ($1, $2, 'MySQL Mix', $3, 'mysql')`,
      [mixPid, groupId, `mysql-mix-${mixPid.slice(0, 6)}`],
    );
    await pdb.query(
      `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc, engine_version, engine_version_num)
       values ($1, $2, 'dev97', $3, false, true, $4, '9.7.0', 90700),
              ($5, $2, 'prod84', $6, true, false, $7, '8.4.13', 80413)`,
      [
        newId(),
        mixPid,
        encrypt('mysql://root:pw@127.0.0.1:3307/app97'),
        encrypt('mysql://root:pw@127.0.0.1:3307/shadow97'),
        newId(),
        encrypt('mysql://root:pw@127.0.0.1:3306/app84'),
        encrypt('mysql://root:pw@127.0.0.1:3306/shadow84'),
      ],
    );
    const mixShadows = new Shadows(pdb, async () => {});
    try {
      const sel = await mixShadows.forProjectVersions(mixPid);
      expect(sel.targetPgMajor).toBeNull();
      expect(sel.envPgMajors).toEqual([]);
      expect(sel.targetMysqlGroup).toBe(804);
      expect(sel.entries.map((e) => e.mysqlGroup)).toEqual([804, 907]);
      expect(sel.entries.every((e) => e.major === null)).toBe(true);
    } finally {
      await mixShadows.close();
    }

    // R2-2: MySQL 9.7 dev + 8.4 prod 混部缺失 8.4 影子库与版本错配门禁（不误标 verified，也不误拼 PG 804）
    const mixVerProjRes = await req('POST', '/api/projects', {
      name: 'MySQL Mix Gate',
      groupId,
      dialect: 'mysql',
    });
    expect(mixVerProjRes.status).toBe(201);
    const mixVerPid = ((await mixVerProjRes.json()) as ProjectCreated).id;
    await editModel(rooms, pdb, mixVerPid, (m) => {
      const s = all(m, 'schema')[0]!.id;
      const t = createTable(m, s, 'items');
      const cid = addColumn(m, t, { name: 'id', type: 'int', notNull: true });
      addPrimaryKey(m, t, [cid]);
    });

    const stubShadow = (verifyScriptsFn: Shadow['verifyScripts']): Shadow =>
      ({
        verifyScripts: verifyScriptsFn,
        importSql: async () => {
          throw new Error('unused');
        },
        verify: async () => {
          throw new Error('unused');
        },
        canonicalize: async () => [],
        close: async () => {},
      }) as Shadow;

    const origForProjectVersions = shadows.forProjectVersions.bind(shadows);
    try {
      // 场景 A：缺失 8.4 影子库（仅有 9.7 影子库通过）
      shadows.forProjectVersions = async () => ({
        entries: [
          {
            major: null,
            mysqlGroup: 907,
            envId: 'e-dev-97',
            label: 'dev97：shadow97',
            shadow: stubShadow(async () => ({
              ok: true,
              up: [],
              down: [],
              upDiff: [],
              downDiff: [],
              risks: [],
              error: null,
              shadowMajor: null,
              shadowVersionNum: 90700,
            })),
          },
        ],
        skippedMajors: [
          {
            major: null,
            mysqlGroup: 804,
            reason: '环境“prod84”是生产环境，默认不在同一实例上建影子库',
          },
        ],
        targetPgMajor: null,
        envPgMajors: [],
        targetMysqlGroup: 804,
      });

      const missingRes = await req('POST', `/api/projects/${mixVerPid}/versions`, { name: 'v1-missing-84' });
      expect(missingRes.status).toBe(201);
      const vMissing = (await missingRes.json()) as VersionCreated;
      expect(vMissing.verified).toBe(false);
      expect(vMissing.unverifiedReason).toContain('MySQL 8.4');
      expect(vMissing.unverifiedReason).not.toMatch(/PG\s*804/);

      const missingDetailRes = await req('GET', `/api/projects/${mixVerPid}/versions/${vMissing.id}`);
      expect(missingDetailRes.status).toBe(200);
      const missingDetail = (await missingDetailRes.json()) as VersionDetail;
      expect(missingDetail.verifiedAt).toBeNull();
      expect(missingDetail.verifyReport?.ok).toBe(false);
      expect(missingDetail.verifyReport?.missingTargetMajor ?? null).toBeNull();
      expect(missingDetail.verifyReport?.error?.message).toContain('MySQL 8.4');
      expect(missingDetail.verifyReport?.error?.message).not.toMatch(/PG\s*804/);

      // 场景 B：声明 8.4 影子库但实测返回 shadowVersionNum: 90700（版本错配）
      await editModel(rooms, pdb, mixVerPid, (m) => {
        const items = all(m, 'table').find((t) => t.name === 'items')!;
        addColumn(m, items.id, { name: 'label', type: 'varchar(64)', notNull: true });
      });
      shadows.forProjectVersions = async () => ({
        entries: [
          {
            major: null,
            mysqlGroup: 804,
            envId: 'e-prod-84',
            label: 'prod84：shadow84',
            shadow: stubShadow(async () => ({
              ok: true,
              up: [],
              down: [],
              upDiff: [],
              downDiff: [],
              risks: [],
              error: null,
              shadowMajor: null,
              shadowVersionNum: 90700,
            })),
          },
        ],
        skippedMajors: [],
        targetPgMajor: null,
        envPgMajors: [],
        targetMysqlGroup: 804,
      });

      const mismatchRes = await req('POST', `/api/projects/${mixVerPid}/versions`, {
        name: 'v2-mismatch-84',
      });
      expect(mismatchRes.status).toBe(201);
      const vMismatch = (await mismatchRes.json()) as VersionCreated;
      expect(vMismatch.verified).toBe(false);
      expect(vMismatch.unverifiedReason).toContain('MySQL 8.4');
      expect(vMismatch.unverifiedReason).toContain('MySQL 9.7');
      expect(vMismatch.unverifiedReason).not.toMatch(/PG\s*804/);

      const mismatchDetailRes = await req('GET', `/api/projects/${mixVerPid}/versions/${vMismatch.id}`);
      expect(mismatchDetailRes.status).toBe(200);
      const mismatchDetail = (await mismatchDetailRes.json()) as VersionDetail;
      expect(mismatchDetail.verifiedAt).toBeNull();
      expect(mismatchDetail.verifyReport?.ok).toBe(false);
      expect(mismatchDetail.verifyReport?.missingTargetMajor ?? null).toBeNull();
    } finally {
      shadows.forProjectVersions = origForProjectVersions;
    }

    // R2-4: ensureHistory 在 SELECT DATABASE() 抛错时必须销毁预留连接而非泄漏
    let releasedCount = 0;
    let destroyedCount = 0;
    const leakTestDb = fromMysql2({
      query: async () => [[], []],
      getConnection: async () =>
        ({
          query: async () => {
            throw new Error('connection lost before lock');
          },
          release: () => {
            releasedCount++;
          },
          destroy: () => {
            destroyedCount++;
          },
        }) as never,
    });
    await expect(mysqlHistory.ensureHistory(leakTestDb)).rejects.toThrow(/connection lost/);
    expect(destroyedCount).toBe(1);
    expect(releasedCount).toBe(0);

    // R2-4: risk.ts 链式 RENAME TABLE 与省略 TO/AS 的 ALTER TABLE RENAME
    const swapSet = new Set(['a', 'b']);
    updateExistingTablesAfterStep('RENAME TABLE `a` TO `tmp`, `b` TO `a`, `tmp` TO `b`', swapSet);
    expect([...swapSet].sort()).toEqual(['a', 'b']);

    const chainSet = new Set(['a']);
    updateExistingTablesAfterStep('RENAME TABLE `a` TO `tmp`, `tmp` TO `c`', chainSet);
    expect([...chainSet]).toEqual(['c']);

    updateExistingTablesAfterStep('ALTER TABLE `c` RENAME `d`', chainSet);
    expect([...chainSet]).toEqual(['d']);

    updateExistingTablesAfterStep('ALTER TABLE `d` RENAME COLUMN `x` TO `y`', chainSet);
    expect([...chainSet]).toEqual(['d']);
  });

  test('真实 MySQL：inspectTarget、pullSchema、claimShadow 防误删非空业务库与同实例影子库生命周期', async () => {
    const handle = getMysql();
    if (!handle) return;

    // 1. 在业务库建表并测试 connection-check (inspectTarget) 与 pullSchema
    await handle.db.exec(`
      CREATE TABLE \`customers\` (
        \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`email\` VARCHAR(191) NOT NULL,
        UNIQUE KEY \`customers_email_key\` (\`email\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const checkRes = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: handle.url,
    });
    expect(checkRes.status).toBe(200);
    const info = (await checkRes.json()) as TargetInfo;
    expect(info.database).toBe(handle.name);
    expect(info.versionNum).toBeGreaterThanOrEqual(80400);
    expect(info.canCreateDb).toBe(true);
    expect(info.schemas).toEqual([{ name: 'default', tables: 1 }]);
    expect(info.dowelSchema).toBe(false);

    const pulled = await pullMysqlSchema(handle.url);
    expect(pulled.dialect).toBe('mysql');
    expect(all(pulled, 'table').map((t) => t.name)).toEqual(['customers']);

    // 2. claimMysqlShadow 绝不允许认领非空业务库！
    await expect(claimMysqlShadow(handle.url)).rejects.toThrow(/不是空库/);

    // 3. 同实例影子库创建、写入哨兵表并安全删除
    const ensured = await ensureSameInstanceMysqlShadow(handle.url);
    expect(ensured.created).toBe(true);
    expect(ensured.shadow).toBe(mysqlShadowDbName(handle.name));

    // 验证哨兵表已写入且幂等认领通过
    await claimMysqlShadow(ensured.url);
    const shadowUrl = mysqlDbUrl(handle.adminUrl, ensured.shadow);
    expect(shadowUrl).toBe(ensured.url);

    // 清理同实例影子库
    await dropMysqlSameInstanceShadow(handle.url, ensured.shadow);
    const afterDropCheck = await req('POST', '/api/connection-check', {
      groupId,
      dialect: 'mysql',
      url: handle.url,
    });
    expect(((await afterDropCheck.json()) as TargetInfo).shadowExists).toBe(false);
  });

  test('真实 MySQL 全栈向导导入、模型编辑、同实例影子库验证发布与执行/回滚', async () => {
    const tdb = await createMysqlTestDb('srv_e2e');
    if (!tdb) return;

    const shadowName = mysqlShadowDbName(tdb.name);
    let pid: string | undefined;
    try {
      await tdb.db.exec(`
        CREATE TABLE \`notes\` (
          \`id\` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          \`title\` VARCHAR(120) NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await tdb.db.query("INSERT INTO `notes` (`title`) VALUES ('hello')");

      // 1. 空白 MySQL 项目创建
      const blankRes = await req('POST', '/api/projects', {
        name: 'MySQL Blank',
        groupId,
        dialect: 'mysql',
      });
      expect(blankRes.status).toBe(201);
      const blank = (await blankRes.json()) as ProjectCreated;
      expect(blank.dialect).toBe('mysql');
      const blankInfo = (await (await req('GET', `/api/projects/${blank.id}`)).json()) as ProjectInfo;
      const { model: blankModel } = await rooms.model(blankInfo.branch);
      expect(all(blankModel, 'schema').map((s) => s.name)).toEqual(['default']);

      // 2. 向导 SQL 导入拦截 MySQL 实例级语句（含条件注释变体）
      const badWiz = await req('POST', '/api/projects/wizard', {
        groupId,
        name: 'Bad MySQL SQL',
        dialect: 'mysql',
        environments: [{ name: 'dev', url: tdb.url, production: false }],
        content: { kind: 'sql', sql: '/*!50000 DROP DATABASE mysql */; CREATE TABLE t (id INT);' },
      });
      expect(badWiz.status).toBe(422);

      // 3. 向导从现有 MySQL 目标库导入，自动使用同实例影子库验证 v0 基线
      const wizRes = await req('POST', '/api/projects/wizard', {
        groupId,
        name: 'MySQL Live App',
        dialect: 'mysql',
        environments: [{ name: 'dev', url: tdb.url, production: false }],
        content: { kind: 'database', env: 'dev' },
      });
      expect(wizRes.status).toBe(200);
      const wizEvents = parseSse<WizardEvent>(await wizRes.text());
      pid = wizEvents.find((e) => e.stage === 'done')?.project?.id;
      expect(pid).toBeTruthy();

      const envs = (await (await req('GET', `/api/projects/${pid}/environments`)).json()) as {
        id: string;
        engineVersion: string | null;
      }[];
      const envId = envs[0]!.id;
      expect(envs[0]!.engineVersion).toMatch(/^[89]\./);

      // 4. 写基线
      const baseRes = await req('POST', `/api/projects/${pid}/environments/${envId}/baseline`, {});
      expect(baseRes.status).toBe(200);
      const baseEvents = parseSse<ExecEvent>(await baseRes.text());
      expect(baseEvents.some((e) => e.stage === 'done')).toBe(true);

      const vers0 = (await (await req('GET', `/api/projects/${pid}/versions`)).json()) as { id: string }[];
      const v0Id = vers0[0]!.id;

      // 5. 编辑模型加列并发布 v1（同实例影子库自动闭环验证 + 风险分析）
      await editModel(rooms, pdb, pid!, (m) => {
        const notes = all(m, 'table').find((t) => t.name === 'notes')!;
        addColumn(m, notes.id, { name: 'body', type: 'text', notNull: false });
      });
      const pubRes = await req('POST', `/api/projects/${pid}/versions`, { name: 'add body' });
      expect(pubRes.status).toBe(201);
      const v1 = (await pubRes.json()) as VersionCreated;
      expect(v1.verified).toBe(true);

      // 6. 执行升级到 v1 并验证数据保留
      const execRes = await req('POST', `/api/projects/${pid}/environments/${envId}/execute`, { to: v1.id });
      expect(execRes.status).toBe(200);
      expect(parseSse<ExecEvent>(await execRes.text()).some((e) => e.stage === 'done')).toBe(true);

      const rows = await tdb.db.query<{ title: string; body: string | null }>(
        'SELECT `title`, `body` FROM `notes`',
      );
      expect(rows).toEqual([{ title: 'hello', body: null }]);

      // 7. 回滚到 v0
      const rbRes = await req('POST', `/api/projects/${pid}/environments/${envId}/rollback`, { to: v0Id });
      expect(rbRes.status).toBe(200);
      expect(parseSse<ExecEvent>(await rbRes.text()).some((e) => e.stage === 'done')).toBe(true);

      expect(MYSQL_SHADOW_MARK_TABLE).toBe('__dowel_shadow_mark');
    } finally {
      if (pid) await shadows.forgetProject(pid);
      await dropMysqlSameInstanceShadow(tdb.url, shadowName).catch(() => {});
      await tdb.close();
    }
  }, 120_000);
});
