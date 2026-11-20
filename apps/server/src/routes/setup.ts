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
import { type AppContext, body, createUserOrConflict, type Env } from './context.ts';

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
    const b = await body(c, setupSchema);
    // 已经有用户之后，setup 一律 409（不管令牌对不对）
    if (!(await needsSetup(db))) throw new HTTPException(409, { message: '这个实例已经初始化过了' });

    // 多副本优先校验持久化在平台库的共享 setup_token；未持久化或单测显式传入自定义 setupToken 时兼容内存令牌
    const stored = ctx.setupTokenCustom ? { exists: false, token: null } : await readStoredSetupToken(db);
    const expected = stored.exists ? stored.token : ctx.setupToken;
    if (!setupTokenMatches(b.token, expected))
      throw new HTTPException(403, { message: '初始化令牌不正确，请查看服务启动时的日志' });

    // 使用本地内存令牌时同步认领，防止本进程内并发请求双写；持久化共享令牌则由下方数据库事务锁串行化
    let claimedLocalToken: string | null = null;
    if (!stored.exists) {
      claimedLocalToken = ctx.setupToken;
      ctx.setupToken = null;
    }

    let user: Awaited<ReturnType<typeof createUserOrConflict>>;
    try {
      user = await db.transaction(async (tx) => {
        if (db.dialect === 'pg') {
          await tx.query('select pg_advisory_xact_lock(hashtext($1))', [SETUP_LOCK_KEY]);
        }
        // 事务里再确认没有用户，防止多副本或本进程并发路径建出第二个“第一个管理员”
        if ((await countUsers(tx)) > 0) throw new HTTPException(409, { message: '这个实例已经初始化过了' });
        const created = await createUserOrConflict(tx, {
          username: b.username,
          name: b.name,
          password: b.password,
          role: 'admin',
        });
        await tx.query('delete from instance_settings where key = $1', [SETUP_TOKEN_KEY]);
        return created;
      });
    } catch (e) {
      // 失败（比如数据库写入出错）就把本地令牌还回去，让用户可以用同一个令牌重试；共享令牌随事务回滚自然保留
      if (claimedLocalToken !== null && ctx.setupToken === null) ctx.setupToken = claimedLocalToken;
      throw e;
    }
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
