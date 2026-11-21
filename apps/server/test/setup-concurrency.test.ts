// POST /api/setup 并发初始化与共享令牌校验测试（#43）：
// 1. 双副本共享平台 PG（ensureSetupToken 初始化后），并发 POST /api/setup 携带共享令牌：严格 1 个 200 + 其余 409，绝不返回 403；
// 2. 确定性复现原竞态窗口（副本 A 持 SETUP_LOCK_KEY 锁完成建管理员并删 setup_token 期间，非主创副本 B 并发请求）：必返 409 而非 403；
// 3. 实例已初始化后，携带正确令牌、错误令牌或空令牌调用 POST /api/setup 一律返回 409 而非 403/400；
// 4. 未初始化时携带错误令牌返回 403、空令牌返回 400，且 sharedSetupToken 模式绝不回退随机内存令牌。
import { afterAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { ensureSetupToken, SETUP_LOCK_KEY, SETUP_TOKEN_KEY } from '../src/setup.ts';
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

const callSetup = async (app: CreatedApp['app'], body: Record<string, unknown>) => {
  const res = await app.request('/api/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, data: data as Record<string, unknown> };
};

describe.skipIf(!PG_URL)('POST /api/setup 双副本并发初始化（真实 PG）', () => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  test('双副本经 ensureSetupToken 同步 sharedSetupToken 后并发 POST /api/setup：严格 1 个 200 + 其余 409，绝不返 403', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'setup-concurrency-secret-16chars';
    const t = await createTestDb('setup_concurrent_shared');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);

    let appA: CreatedApp | undefined;
    let appB: CreatedApp | undefined;
    try {
      // 模拟 main.ts 冷启动顺序：双副本并发调用 ensureSetupToken，再同步传入 createApp
      const [tokenA, tokenB] = await Promise.all([ensureSetupToken(dbA), ensureSetupToken(dbB)]);
      expect(tokenA).toBeTruthy();
      expect(tokenB).toBe(tokenA);

      appA = createApp(dbA, { sharedSetupToken: tokenA });
      appB = createApp(dbB, { sharedSetupToken: tokenB });
      expect(appA.setupToken).toBe(tokenA);
      expect(appB.setupToken).toBe(tokenB);

      // 双副本各发起并发请求，携带同一个共享令牌
      const results = await Promise.all([
        callSetup(appA.app, { token: tokenA, username: 'admin-a1', name: '管理员 A1', password: PASSWORD }),
        callSetup(appB.app, { token: tokenB, username: 'admin-b1', name: '管理员 B1', password: PASSWORD }),
        callSetup(appA.app, { token: tokenA, username: 'admin-a2', name: '管理员 A2', password: PASSWORD }),
        callSetup(appB.app, { token: tokenB, username: 'admin-b2', name: '管理员 B2', password: PASSWORD }),
      ]);

      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect(results.some((r) => r.status === 403)).toBe(false);
      expect(await dbA.query('select id from users')).toHaveLength(1);
      expect(
        await dbA.query('select value from instance_settings where key = $1', [SETUP_TOKEN_KEY]),
      ).toEqual([]);
    } finally {
      if (appA) await closeApp(appA);
      if (appB) await closeApp(appB);
      await dbA.close();
      await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });

  test('确定性竞态：副本 A 在 SETUP_LOCK_KEY 锁内建管理员并删 setup_token 期间，非主创副本 B 并发请求必返 409 而非 403', async () => {
    const prevSecret = process.env.DOWEL_SECRET;
    process.env.DOWEL_SECRET = 'setup-race-window-secret-16chars';
    const t = await createTestDb('setup_concurrent_race');
    closers.push(t.close);
    const dbA = await openPlatformDb(t.url);
    const dbB = await openPlatformDb(t.url);

    // 刻意先构造未同步共享令牌的副本 B（ctx.setupToken 为另一随机值），复现原缺陷最坏前置条件
    const appB = createApp(dbB);
    try {
      const sharedToken = await ensureSetupToken(dbA);
      expect(sharedToken).toBeTruthy();
      expect(appB.setupToken).not.toBe(sharedToken);

      let lockEntered!: () => void;
      const inLock = new Promise<void>((r) => {
        lockEntered = r;
      });
      let finishSetup!: () => void;
      const releaseLock = new Promise<void>((r) => {
        finishSetup = r;
      });

      // 副本 A 先持有 SETUP_LOCK_KEY 事务锁
      const replicaATx = dbA.transaction(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
        lockEntered();
        await releaseLock;
        await createUser(tx, {
          username: 'admin-a',
          name: '主创管理员',
          password: PASSWORD,
          role: 'admin',
        });
        await tx.query('delete from instance_settings where key = $1', [SETUP_TOKEN_KEY]);
      });

      await inLock;

      // 在副本 A 持锁期间，副本 B 同时收到携带正确共享令牌、错误令牌与空令牌的请求
      let settled = 0;
      const reqGood = callSetup(appB.app, {
        token: sharedToken,
        username: 'admin-b',
        name: '副本 B 管理员',
        password: PASSWORD,
      }).finally(() => {
        settled++;
      });
      const reqWrong = callSetup(appB.app, {
        token: 'wrong-token',
        username: 'admin-b2',
        name: '副本 B 错令牌',
        password: PASSWORD,
      }).finally(() => {
        settled++;
      });
      const reqEmpty = callSetup(appB.app, {
        token: '',
        username: 'admin-b3',
        name: '副本 B 空令牌',
        password: PASSWORD,
      }).finally(() => {
        settled++;
      });

      // 确认全部请求都在等待事务锁，不会在锁外提前返回 403/400
      await new Promise((r) => setTimeout(r, 80));
      expect(settled).toBe(0);

      // 副本 A 完成建管理员并删除 setup_token 后提交放锁
      finishSetup();
      await replicaATx;

      const [resGood, resWrong, resEmpty] = await Promise.all([reqGood, reqWrong, reqEmpty]);
      expect(resGood.status).toBe(409);
      expect(resWrong.status).toBe(409);
      expect(resEmpty.status).toBe(409);
      expect(await dbA.query<{ username: string }>('select username from users')).toEqual([
        { username: 'admin-a' },
      ]);
    } finally {
      await closeApp(appB);
      await dbA.close();
      await dbB.close();
      if (prevSecret === undefined) delete process.env.DOWEL_SECRET;
      else process.env.DOWEL_SECRET = prevSecret;
    }
  });
});

describe.each([
  { platform: 'sqlite' as const, skip: false },
  { platform: 'pg' as const, skip: !PG_URL },
])('POST /api/setup 令牌校验与已初始化契约（$platform）', ({ platform, skip }) => {
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
  });

  const openPair = async (tag: string): Promise<{ dbA: PlatformDb; dbB: PlatformDb }> => {
    if (platform === 'sqlite') {
      const db = await openPlatformDb(':memory:');
      return { dbA: db, dbB: db };
    }
    const t = await createTestDb(tag);
    closers.push(t.close);
    return { dbA: await openPlatformDb(t.url), dbB: await openPlatformDb(t.url) };
  };

  test.skipIf(skip)(
    '未初始化时错令牌返回 403、空令牌返回 400；初始化后错令牌与空令牌一律返回 409',
    async () => {
      const { dbA, dbB } = await openPair('setup_contract');
      let appA: CreatedApp | undefined;
      let appB: CreatedApp | undefined;
      try {
        const sharedToken = await ensureSetupToken(dbA);
        expect(sharedToken).toBeTruthy();

        appA = createApp(dbA, { sharedSetupToken: sharedToken });
        appB = createApp(dbB, { sharedSetupToken: sharedToken });

        // 未初始化：错误令牌返回 403，空令牌返回 400，且不会消费共享令牌
        const wrongBefore = await callSetup(appA.app, {
          token: 'definitely-wrong-token',
          username: 'admin',
          name: '管理员',
          password: PASSWORD,
        });
        expect(wrongBefore.status).toBe(403);

        const emptyBefore = await callSetup(appA.app, {
          token: '',
          username: 'admin',
          name: '管理员',
          password: PASSWORD,
        });
        expect(emptyBefore.status).toBe(400);

        // 正确共享令牌完成初始化
        const ok = await callSetup(appA.app, {
          token: sharedToken,
          username: 'admin',
          name: '管理员',
          password: PASSWORD,
        });
        expect(ok.status).toBe(200);

        // 实例已初始化后：无论原令牌、错误令牌还是空令牌，在任一副本上都一律返回 409 而非 403/400
        for (const target of [appA.app, appB.app]) {
          expect(
            (
              await callSetup(target, {
                token: sharedToken,
                username: 'admin2',
                name: '管理员二',
                password: PASSWORD,
              })
            ).status,
          ).toBe(409);

          expect(
            (
              await callSetup(target, {
                token: 'wrong-token-after-init',
                username: 'admin2',
                name: '管理员二',
                password: PASSWORD,
              })
            ).status,
          ).toBe(409);

          expect(
            (
              await callSetup(target, {
                token: '',
                username: 'admin2',
                name: '管理员二',
                password: PASSWORD,
              })
            ).status,
          ).toBe(409);
        }
      } finally {
        if (appA) await closeApp(appA);
        if (appB) await closeApp(appB);
        await dbA.close();
        if (dbB !== dbA) await dbB.close();
      }
    },
  );

  test.skipIf(skip)('sharedSetupToken 模式下严格以持久化令牌为准，绝不回退本机内存值', async () => {
    const { dbA, dbB } = await openPair('setup_shared_strict');
    let appShared: CreatedApp | undefined;
    let appInitialized: CreatedApp | undefined;
    try {
      const sharedToken = await ensureSetupToken(dbA);
      expect(sharedToken).toBeTruthy();

      appShared = createApp(dbA, { sharedSetupToken: sharedToken });
      appInitialized = createApp(dbB, { sharedSetupToken: null });
      expect(appShared.setupToken).toBe(sharedToken);
      expect(appInitialized.setupToken).toBeNull();

      // 模拟外部移除数据库中的 setup_token 行（实例仍未初始化）：shared 模式不得回落比对内存中的旧令牌
      await dbA.query('delete from instance_settings where key = $1', [SETUP_TOKEN_KEY]);
      const revoked = await callSetup(appShared.app, {
        token: sharedToken,
        username: 'admin',
        name: '管理员',
        password: PASSWORD,
      });
      expect(revoked.status).toBe(403);
      expect(await dbA.query('select id from users')).toEqual([]);
    } finally {
      if (appShared) await closeApp(appShared);
      if (appInitialized) await closeApp(appInitialized);
      await dbA.close();
      if (dbB !== dbA) await dbB.close();
    }
  });
});
