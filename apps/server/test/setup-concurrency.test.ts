// 首次启动管理员引导并发与幂等测试：
// 1. 双副本共享平台 PG，并发执行 bootstrapAdmin（生成临时密码模式）：严格 1 个创建管理员并写入 0600 密码文件，
//    另一副本返回 created: null；该文件密码可正常登录且标注 mustChangePassword: true；
// 2. 确定性 PG advisory-lock 竞态：副本 A 持 SETUP_LOCK_KEY 锁插入管理员期间，副本 B 并发调用 bootstrapAdmin
//    在锁释放后读到 countUsers > 0，返回 created: null 且绝不创建或覆盖密码文件；
// 3. DOWEL_ADMIN_PASSWORD_FILE / DOWEL_ADMIN_PASSWORD 并发冷启动：严格 1 个创建（mustChangePassword: false），
//    initialAdminPasswordFile 为 null 且运维文件保持原样不被改写。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { bootstrapAdmin, DEFAULT_ADMIN_USERNAME, SETUP_LOCK_KEY } from '../src/setup.ts';
import { createUser } from '../src/users.ts';
import { PASSWORD } from './support.ts';

type CreatedApp = ReturnType<typeof createApp>;

const closeApp = async (created: CreatedApp) => {
  await created.webhooks.close();
  await created.rooms.flush();
  await created.shadows.close();
  await created.bus.close();
  await created.ha.stop();
};

describe.skipIf(!PG_URL)('bootstrapAdmin 双副本并发引导（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('双副本并发 bootstrapAdmin（自动生成临时密码）：严格 1 个创建 + 1 个返回 null + 文件 0600 可登录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dowel-bootstrap-pg-'));
    const pwFile = join(dir, 'initial-admin-password');
    const t = await createTestDb('bootstrap_concurrent_gen');
    closers.push(async () => {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);
    let createdApp: CreatedApp | undefined;

    try {
      const [resA, resB] = await Promise.all([
        bootstrapAdmin(dbA, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } }),
        bootstrapAdmin(dbB, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } }),
      ]);

      const winners = [resA, resB].filter((r) => r.created !== null);
      const losers = [resA, resB].filter((r) => r.created === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]!.source).toBe('generated');
      expect(winners[0]!.created).toMatchObject({
        username: DEFAULT_ADMIN_USERNAME,
        role: 'admin',
        mustChangePassword: true,
      });
      expect(losers[0]).toMatchObject({
        created: null,
        source: null,
        bootstrapUsername: DEFAULT_ADMIN_USERNAME,
        initialAdminPasswordFile: pwFile,
      });

      expect(await dbA.query('select id from users')).toHaveLength(1);
      expect(existsSync(pwFile)).toBe(true);
      expect(statSync(pwFile).mode & 0o777).toBe(0o600);
      const tempPassword = readFileSync(pwFile, 'utf8').trim();
      expect(tempPassword.length).toBeGreaterThanOrEqual(8);

      createdApp = createApp(dbB, {
        initialAdminPasswordFile: losers[0]!.initialAdminPasswordFile,
        bootstrapUsername: losers[0]!.bootstrapUsername,
      });
      const loginRes = await createdApp.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: DEFAULT_ADMIN_USERNAME, password: tempPassword }),
      });
      expect(loginRes.status).toBe(200);
      expect(await loginRes.json()).toMatchObject({
        username: DEFAULT_ADMIN_USERNAME,
        role: 'admin',
        mustChangePassword: true,
      });
    } finally {
      if (createdApp) await closeApp(createdApp);
      await dbA.close();
      await dbB.close();
    }
  });

  test('确定性 advisory lock 竞态：副本 A 持锁创建管理员期间，副本 B 并发调用返回 null 且不写密码文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dowel-bootstrap-race-'));
    const pwFile = join(dir, 'initial-admin-password');
    const t = await createTestDb('bootstrap_concurrent_race');
    closers.push(async () => {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);

    try {
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => {
        locked = r;
      });
      let release!: () => void;
      const allowCommit = new Promise<void>((r) => {
        release = r;
      });

      const txA = dbA.transaction(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
        locked();
        await allowCommit;
        await createUser(tx, {
          username: 'admin',
          name: 'admin',
          password: PASSWORD,
          role: 'admin',
          mustChangePassword: false,
        });
      });

      await gotLock;
      const bootB = bootstrapAdmin(dbB, { env: { DOWEL_INITIAL_PASSWORD_FILE: pwFile } });
      // 等待一会儿确认副本 B 阻塞在 SETUP_LOCK_KEY 上，尚未写文件也未返回
      await new Promise((r) => setTimeout(r, 80));
      expect(existsSync(pwFile)).toBe(false);

      release();
      await txA;
      const resB = await bootB;

      expect(resB).toEqual({
        created: null,
        source: null,
        bootstrapUsername: 'admin',
        initialAdminPasswordFile: pwFile,
      });
      expect(existsSync(pwFile)).toBe(false);
      expect(await dbA.query('select username from users')).toEqual([{ username: 'admin' }]);
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });
});

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('bootstrapAdmin 并发与预设密码文件契约（$platform）', ({ platform, skip }) => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  const openPair = async (name: string): Promise<{ dbA: PlatformDb; dbB: PlatformDb }> => {
    if (platform === 'sqlite') {
      const dbA = await openPlatformDb(':memory:');
      return { dbA, dbB: dbA };
    }
    const t = await createTestDb(name);
    closers.push(t.close);
    return { dbA: await openPlatformDb(t.url), dbB: await openPlatformDb(t.url) };
  };

  test.skipIf(skip)(
    '并发 DOWEL_ADMIN_PASSWORD_FILE：仅创建 1 个管理员（mustChangePassword=false）且不改动文件',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), `dowel-bootstrap-file-${platform}-`));
      const opFile = join(dir, 'admin-pass');
      writeFileSync(opFile, `  ${PASSWORD}-from-file  \n`, { mode: 0o600 });
      closers.push(async () => rmSync(dir, { recursive: true, force: true }));

      const { dbA, dbB } = await openPair('bootstrap_file');
      try {
        const env = { DOWEL_ADMIN_USERNAME: 'OpsAdmin', DOWEL_ADMIN_PASSWORD_FILE: opFile };
        const [r1, r2] = await Promise.all([bootstrapAdmin(dbA, { env }), bootstrapAdmin(dbB, { env })]);
        const winners = [r1, r2].filter((r) => r.created !== null);
        expect(winners).toHaveLength(1);
        expect(winners[0]!.source).toBe('file');
        expect(winners[0]!.initialAdminPasswordFile).toBeNull();
        expect(winners[0]!.created).toMatchObject({
          username: 'opsadmin',
          role: 'admin',
          mustChangePassword: false,
        });
        expect(readFileSync(opFile, 'utf8')).toBe(`  ${PASSWORD}-from-file  \n`);
      } finally {
        await dbA.close();
        if (dbB !== dbA) await dbB.close();
      }
    },
  );

  test.skipIf(skip)('并发 DOWEL_ADMIN_PASSWORD：仅创建 1 个管理员且不生成临时密码文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), `dowel-bootstrap-env-${platform}-`));
    const unusedTempFile = join(dir, 'should-not-exist');
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));

    const { dbA, dbB } = await openPair('bootstrap_env');
    try {
      const env = { DOWEL_ADMIN_PASSWORD: PASSWORD, DOWEL_INITIAL_PASSWORD_FILE: unusedTempFile };
      const [r1, r2] = await Promise.all([bootstrapAdmin(dbA, { env }), bootstrapAdmin(dbB, { env })]);
      const winners = [r1, r2].filter((r) => r.created !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.source).toBe('env');
      expect(winners[0]!.initialAdminPasswordFile).toBeNull();
      expect(winners[0]!.created).toMatchObject({
        username: 'admin',
        role: 'admin',
        mustChangePassword: false,
      });
      expect(existsSync(unusedTempFile)).toBe(false);
    } finally {
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
    }
  });
});
