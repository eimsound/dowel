// 首次初始化与实例信息。
// - GET /api/setup：实例里有没有用户（没有就需要初始化）；
// - POST /api/setup：带启动时打印的一次性令牌（多副本共享持久化在 instance_settings），创建第一个实例管理员并登录；
// - GET /api/instance：登录页需要的公开信息（实例名称、能不能用密码登录、是否要初始化）。
import { type InstanceInfo, type Me, type SetupStatus, setupSchema } from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { markLogin, startSession } from '../auth.ts';
import { publicProviders } from '../oidc.ts';
import { readSettings } from '../settings.ts';
import {
  needsSetup,
  readStoredSetupToken,
  SETUP_LOCK_KEY,
  SETUP_TOKEN_KEY,
  setupTokenMatches,
} from '../setup.ts';
import { countUsers } from '../users.ts';
import { type AppContext, createUserOrConflict, type Env } from './context.ts';

export const registerSetup = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/setup', async (c) => c.json<SetupStatus>({ needsSetup: await needsSetup(db) }));

  app.get('/api/instance', async (c) => {
    const settings = await readSettings(db);
    return c.json<InstanceInfo>({
      name: settings.name,
      // 应急变量打开时，即使设置里关了也算可用（登录接口也是这么判断的）
      passwordLogin: settings.passwordLogin || ctx.allowPasswordLogin,
      needsSetup: await needsSetup(db),
      providers: await publicProviders(db),
    });
  });

  app.post('/api/setup', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const user = await db.transaction(async (tx) => {
      if (db.dialect === 'pg') {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
      }
      // 事务锁内优先判断是否已有用户：实例一旦初始化，无论令牌正确、错误还是为空一律返回 409
      if ((await countUsers(tx)) > 0) throw new HTTPException(409, { message: '这个实例已经初始化过了' });

      const parsed = setupSchema.safeParse(raw);
      if (!parsed.success)
        throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? '请求不合法' });
      const b = parsed.data;

      // 事务锁内校验令牌：
      // - custom：单测显式注入的内存令牌优先；
      // - shared：生产多副本共享令牌，只认持久化在平台库的 setup_token，绝不回落随机内存值；
      // - local：单测默认模式，优先读持久化令牌，未持久化时兼容本进程内存令牌。
      const stored =
        ctx.setupTokenMode === 'custom' ? { exists: false, token: null } : await readStoredSetupToken(tx);
      const expected =
        ctx.setupTokenMode === 'shared'
          ? stored.exists
            ? stored.token
            : null
          : stored.exists
            ? stored.token
            : ctx.setupToken;
      if (!setupTokenMatches(b.token, expected))
        throw new HTTPException(403, { message: '初始化令牌不正确，请查看服务启动时的日志' });

      const created = await createUserOrConflict(tx, {
        username: b.username,
        name: b.name,
        password: b.password,
        role: 'admin',
      });
      await tx.query('delete from instance_settings where key = $1', [SETUP_TOKEN_KEY]);
      return created;
    });
    ctx.setupToken = null;
    // 初始化完直接登录：和登录接口一样更新 last_login_at
    const me = { ...user, lastLoginAt: await markLogin(db, user.id) };
    await startSession(db, c, me, ctx.security);
    await audit(
      db,
      c,
      {
        action: 'instance.setup',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'user',
        targetId: user.id,
        data: { username: user.username },
      },
      ctx.security,
    );
    return c.json<Me>(me);
  });
};
