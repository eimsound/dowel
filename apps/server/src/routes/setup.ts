// 首次初始化与实例信息。
// - GET /api/setup：实例里有没有用户（没有就需要初始化）；
// - POST /api/setup：带启动时打印的一次性令牌，创建第一个实例管理员并登录；
// - GET /api/instance：登录页需要的公开信息（实例名称、能不能用密码登录、是否要初始化）。
import { type InstanceInfo, type Me, type SetupStatus, setupSchema } from '@dowel/api';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { markLogin, startSession } from '../auth.ts';
import { publicProviders } from '../oidc.ts';
import { readSettings } from '../settings.ts';
import { needsSetup, setupTokenMatches } from '../setup.ts';
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
    if (!setupTokenMatches(b.token, ctx.setupToken))
      throw new HTTPException(403, { message: '初始化令牌不正确，请查看服务启动时的日志' });

    // 同步认领令牌：这一行在任何 await 之前，两个并发请求里只有第一个能走到下面
    const token = ctx.setupToken!;
    ctx.setupToken = null;
    let user: Awaited<ReturnType<typeof createUserOrConflict>>;
    try {
      user = await db.transaction(async (tx) => {
        // 事务里再确认没有用户，防止并发路径建出第二个“第一个管理员”
        if ((await countUsers(tx)) > 0) throw new HTTPException(409, { message: '这个实例已经初始化过了' });
        return createUserOrConflict(tx, {
          username: b.username,
          name: b.name,
          password: b.password,
          role: 'admin',
        });
      });
    } catch (e) {
      // 失败（比如被并发的请求抢先）就把令牌还回去，让用户可以用同一个令牌重试
      if (ctx.setupToken === null) ctx.setupToken = token;
      throw e;
    }
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
