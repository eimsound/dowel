// 个人设置（/api/me/*）和公开的邀请 / 重置密码接口。
// - 邀请接受、重置密码不需要登录：令牌本身就是凭据；
// - 个人设置需要登录（在 routes/index.ts 里统一要求）。
import {
  type InviteInfo,
  inviteAcceptSchema,
  type Me,
  mePatchSchema,
  type Ok,
  passwordChangeSchema,
  resetPasswordSchema,
  type SessionInfo,
} from '@dowel/api';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import {
  endSession,
  hashPassword,
  hashToken,
  markLogin,
  revokeSessions,
  sessionToken,
  startSession,
  verifyPassword,
} from '../auth.ts';
import { isEmailUniqueViolation, isUniqueViolation } from '../db.ts';
import {
  claimInvite,
  type InviteState,
  inviteByToken,
  inviteInfo,
  inviteState,
  setInviteUsedBy,
} from '../invites.ts';
import { revokeAllMcpTokens } from '../mcp-tokens.ts';
import { readSettings } from '../settings.ts';
import { removeInitialAdminPasswordFile } from '../setup.ts';
import { emailTaken, normalizeEmail, userById, usernameTaken } from '../users.ts';
import { type AppContext, body, createUserOrConflict, type Env } from './context.ts';
import { afterRevokeAllMcpTokens } from './mcp-tokens.ts';

/** 首次设置密码与临时密码强制改密（未传旧密码时）只允许最近 10 分钟内登录的会话（见 /api/me/password） */
const RECENT_LOGIN_WINDOW_MS = 10 * 60_000;

/** 校验当前请求持有最近 10 分钟内创建的有效会话 */
const requireRecentSession = async (
  db: AppContext['db'],
  c: Context<Env>,
  userId: string,
  expiredMessage: string,
) => {
  const token = sessionToken(c);
  const [session] = token
    ? await db.query<{ createdAt: string }>(
        'select created_at as "createdAt" from sessions where token_hash = $1 and user_id = $2',
        [hashToken(token), userId],
      )
    : [];
  if (!session) throw new HTTPException(401, { message: '会话已失效，请重新登录' });
  if (Date.now() - Date.parse(session.createdAt) > RECENT_LOGIN_WINDOW_MS) {
    throw new HTTPException(403, { message: expiredMessage });
  }
};

/** 邀请链接不可用：找不到 404，已用 / 已撤销 / 已过期 410 */
const inviteUnusable = (state: InviteState | 'missing') => {
  if (state === 'missing') return new HTTPException(404, { message: '邀请链接无效' });
  return new HTTPException(410, {
    message: {
      used: '这个邀请链接已经被使用过了',
      revoked: '这个邀请链接已被撤销',
      expired: '这个邀请链接已过期',
      ok: '',
    }[state],
  });
};

/** 重置密码链接不可用：找不到 404，已用 / 已撤销 / 已过期 410 */
const resetUnusable = (state: InviteState | 'missing') => {
  if (state === 'missing') return new HTTPException(404, { message: '重置链接无效' });
  return new HTTPException(410, {
    message: {
      used: '这个重置链接已经被使用过了',
      revoked: '这个重置链接已被撤销',
      expired: '这个重置链接已过期',
      ok: '',
    }[state],
  });
};

export const registerMe = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.patch('/api/me', async (c) => {
    const me = c.get('user');
    const b = await body(c, mePatchSchema);
    if (b.username && (await usernameTaken(db, b.username, me.id)))
      throw new HTTPException(409, { message: '用户名已被使用' });
    const nextEmail = b.email === undefined ? me.email : normalizeEmail(b.email);
    if (b.email !== undefined && nextEmail && (await emailTaken(db, nextEmail, me.id)))
      throw new HTTPException(409, { message: '邮箱已被使用' });
    try {
      await db.query(
        'update users set username = coalesce($2, username), name = coalesce($3, name), email = $4 where id = $1',
        [
          me.id,
          b.username ?? null,
          b.name ?? null,
          // email 不传表示不改，传空字符串表示清空
          nextEmail,
        ],
      );
    } catch (e) {
      // 并发改用户名/邮箱时预检可能都没查到，唯一约束兜底
      if (isEmailUniqueViolation(e)) throw new HTTPException(409, { message: '邮箱已被使用' });
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '用户名已被使用' });
      throw e;
    }
    await audit(
      db,
      c,
      {
        action: 'user.update_self',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'user',
        targetId: me.id,
        data: b,
      },
      ctx.security,
    );
    return c.json<Me>((await userById(db, me.id))!);
  });

  app.post('/api/me/password', async (c) => {
    const me = c.get('user');
    const b = await body(c, passwordChangeSchema);
    const [row] = await db.query<{ password_hash: string | null; mustChangePassword: boolean | number }>(
      'select password_hash, must_change_password as "mustChangePassword" from users where id = $1',
      [me.id],
    );
    if (!row) throw new HTTPException(404, { message: '用户不存在' });
    const firstSet = !row.password_hash;
    const forced = Boolean(row.mustChangePassword);

    if (firstSet) {
      // 纯 OIDC 用户第一次“设置密码”不需要旧密码，但必须证明这个人刚刚登录过：
      // 只允许最近 10 分钟内新建的会话设置第一个密码（旧 cookie 被 XSS / 共享浏览器捡到时，
      // 不能让对方直接给账户装上密码）。
      await requireRecentSession(
        db,
        c,
        me.id,
        '设置密码需要最近 10 分钟内登录的会话，请重新登录后再设置密码',
      );
      const hash = await hashPassword(b.newPassword);
      // 条件更新：并发请求里只有一个能把 password_hash 从 null 改成值，另一个拿到 409。
      const updated = await db.query<{ id: string }>(
        'update users set password_hash = $2, must_change_password = $3 where id = $1 and password_hash is null returning id',
        [me.id, hash, false],
      );
      if (!updated.length) throw new HTTPException(409, { message: '密码已经被设置，请刷新后重试' });
    } else if (forced) {
      // 临时密码强制改密默认免填旧密码，要求最近 10 分钟内登录的会话；
      // 若调用方显式传入 oldPassword，则继续校验以兼容旧客户端并避免静默忽略错密码。
      if (b.oldPassword !== undefined) {
        if (!(await verifyPassword(b.oldPassword, row.password_hash!))) {
          throw new HTTPException(403, { message: '旧密码不正确' });
        }
      } else {
        await requireRecentSession(
          db,
          c,
          me.id,
          '修改密码需要最近 10 分钟内登录的会话，请重新登录后再修改密码',
        );
      }
      if (await verifyPassword(b.newPassword, row.password_hash!)) {
        throw new HTTPException(400, { message: '新密码不能与临时密码相同' });
      }
      const hash = await hashPassword(b.newPassword);
      // 条件更新：防止并发改密请求覆写刚设好的新密码
      const updated = await db.query<{ id: string }>(
        'update users set password_hash = $2, must_change_password = $3 where id = $1 and must_change_password = $4 returning id',
        [me.id, hash, false, true],
      );
      if (!updated.length) throw new HTTPException(409, { message: '密码已经被修改，请刷新后重试' });
      await revokeSessions(db, me.id, sessionToken(c));
    } else {
      // 已经有密码时必须验证旧密码，否则拿到会话的人可以直接改掉密码
      if (!b.oldPassword) throw new HTTPException(400, { message: '请输入旧密码' });
      if (!(await verifyPassword(b.oldPassword, row.password_hash!)))
        throw new HTTPException(403, { message: '旧密码不正确' });
      const hash = await hashPassword(b.newPassword);
      await db.query('update users set password_hash = $2, must_change_password = $3 where id = $1', [
        me.id,
        hash,
        false,
      ]);
      // 修改密码才吊销其他会话；首次设置不吊销（那样只会帮攻击者把主人踢下线）
      await revokeSessions(db, me.id, sessionToken(c));
    }

    if (me.username === ctx.bootstrapUsername) {
      await removeInitialAdminPasswordFile(ctx.initialAdminPasswordFile);
    }

    await audit(
      db,
      c,
      {
        // 第一次设置密码和修改密码分开记，审计里能看出来
        action: firstSet ? 'user.password_set' : 'user.password_change',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'user',
        targetId: me.id,
        data: firstSet ? { firstSet: true } : { firstSet: false, forced },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  app.get('/api/me/sessions', async (c) => {
    const me = c.get('user');
    const current = sessionToken(c);
    const rows = await db.query<{
      id: string;
      createdAt: string;
      lastSeenAt: string;
      userAgent: string | null;
      ip: string | null;
      token_hash: string;
    }>(
      `select id, created_at as "createdAt", last_seen_at as "lastSeenAt",
              user_agent as "userAgent", ip, token_hash
         from sessions where user_id = $1 order by created_at desc`,
      [me.id],
    );
    const hash = current ? hashToken(current) : null;
    return c.json<SessionInfo[]>(
      rows.map(({ token_hash, ...s }) => ({ ...s, current: token_hash === hash })),
    );
  });

  app.delete('/api/me/sessions/:id', async (c) => {
    const me = c.get('user');
    const id = c.req.param('id');
    const [row] = await db.query<{ token_hash: string }>(
      'select token_hash from sessions where id = $1 and user_id = $2',
      [id, me.id],
    );
    if (!row) throw new HTTPException(404, { message: '会话不存在' });
    await db.query('delete from sessions where id = $1 and user_id = $2', [id, me.id]);
    // 删掉的是当前会话就把 cookie 也清掉，浏览器下次请求就知道自己退了
    if (row.token_hash === hashToken(sessionToken(c) ?? '')) await endSession(db, c);
    await audit(
      db,
      c,
      {
        action: 'session.revoke',
        actorKind: 'user',
        actorId: me.id,
        targetKind: 'session',
        targetId: id,
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });
};

/** 公开的邀请与重置密码接口（不需要登录） */
export const registerInvites = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.get('/api/invites/:token', async (c) => {
    const invite = await inviteByToken(db, c.req.param('token'));
    const { name } = await readSettings(db);
    return c.json<InviteInfo>(inviteInfo(invite, name));
  });

  app.post('/api/invites/:token/accept', async (c) => {
    const token = c.req.param('token')!;
    const b = await body(c, inviteAcceptSchema);
    // 先查一次只是为了给出准确的 404 / 410；真正的一次性靠下面事务里的“认领”
    const invite = await inviteByToken(db, token);
    if (invite?.kind !== 'invite') throw new HTTPException(404, { message: '邀请链接无效' });
    const state = inviteState(invite);
    if (state !== 'ok') throw inviteUnusable(state);
    if (await usernameTaken(db, b.username)) throw new HTTPException(409, { message: '用户名已被使用' });
    if (b.email && (await emailTaken(db, b.email))) throw new HTTPException(409, { message: '邮箱已被使用' });

    const user = await db.transaction(async (tx) => {
      // 认领和建用户在同一个事务里：并发接受同一个邀请时只有一个能认领到；
      // 建用户失败（例如用户名冲突）整体回滚，令牌保持可用。
      const claimed = await claimInvite(tx, { token, kind: 'invite' });
      if (!claimed) {
        const current = await inviteByToken(tx, token);
        throw inviteUnusable(current ? inviteState(current) : 'missing');
      }
      const created = await createUserOrConflict(tx, {
        username: b.username,
        name: b.name,
        email: b.email,
        password: b.password,
        role: 'member',
      });
      await setInviteUsedBy(tx, claimed.id, created.id);
      // 邀请里带的组：接受后成为组成员（管理员建邀请时可以传 groupIds）。
      // 组已经被删掉就跳过，不影响接受邀请。group_ids 是 JSON 列，用查询读回来（returning 里不一定能解析）。
      const [full] = await tx.query<{ groupIds: string[] }>(
        'select group_ids as "groupIds" from invites where id = $1',
        [claimed.id],
      );
      for (const groupId of full?.groupIds ?? []) {
        const [group] = await tx.query<{ id: string }>('select id from groups where id = $1', [groupId]);
        if (!group) continue;
        await tx.query(
          `insert into group_members (group_id, user_id, role) values ($1, $2, 'member')
           on conflict (group_id, user_id) do nothing`,
          [groupId, created.id],
        );
      }
      return created;
    });
    // 事务提交之后再开会话，避免会话里出现一个回滚掉的用户
    const me = { ...user, lastLoginAt: await markLogin(db, user.id) };
    await startSession(db, c, me, ctx.security);
    await audit(
      db,
      c,
      {
        action: 'invite.accept',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'invite',
        targetId: invite.id,
        data: { username: user.username },
      },
      ctx.security,
    );
    return c.json<Me>(me);
  });

  app.post('/api/reset/:token', async (c) => {
    const token = c.req.param('token')!;
    const b = await body(c, resetPasswordSchema);
    const invite = await inviteByToken(db, token);
    if (invite?.kind !== 'reset' || !invite.userId) throw new HTTPException(404, { message: '重置链接无效' });
    const state = inviteState(invite);
    if (state !== 'ok') throw resetUnusable(state);
    // 先把哈希算好，让事务尽量短
    const hash = await hashPassword(b.password);
    let revokedMcpTokens = 0;
    const user = await db.transaction(async (tx) => {
      // 认领不到就不改密码（并发时只有一个请求能拿到令牌）
      const claimed = await claimInvite(tx, { token, kind: 'reset' });
      if (!claimed?.userId) {
        const current = await inviteByToken(tx, token);
        throw resetUnusable(current ? inviteState(current) : 'missing');
      }
      const target = await userById(tx, claimed.userId);
      if (!target) throw new HTTPException(404, { message: '用户不存在' });
      await tx.query('update users set password_hash = $2, must_change_password = $3 where id = $1', [
        target.id,
        hash,
        false,
      ]);
      // 设完新密码，这个用户的所有会话和 MCP 令牌都失效
      await tx.query('delete from sessions where user_id = $1', [target.id]);
      revokedMcpTokens = await revokeAllMcpTokens(tx, target.id, 'password_reset', null);
      return target;
    });
    await ctx.rooms.kickUser(user.id, '密码已重置，请重新登录');
    if (user.username === ctx.bootstrapUsername) {
      await removeInitialAdminPasswordFile(ctx.initialAdminPasswordFile);
    }
    await audit(
      db,
      c,
      {
        action: 'user.password_reset',
        actorKind: 'user',
        actorId: invite.createdBy,
        targetKind: 'user',
        targetId: user.id,
        data: { username: user.username },
      },
      ctx.security,
    );
    await afterRevokeAllMcpTokens(c, ctx, {
      userId: user.id,
      username: user.username,
      actorId: invite.createdBy ?? user.id,
      reason: 'password_reset',
      count: revokedMcpTokens,
    });
    return c.json<Ok>({ ok: true });
  });
};
