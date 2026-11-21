// 实例管理：实例设置、用户管理、邀请链接。整个 /api/admin/* 先经过 requireUser + requireInstanceAdmin。
import {
  type AdminUser,
  adminUserCreateSchema,
  adminUserPatchSchema,
  type GrantInfo,
  grantCreateSchema,
  type InstanceSettings,
  type InviteCreated,
  type InviteListItem,
  instanceSettingsPatchSchema,
  inviteCreateSchema,
  type Ok,
  type ResetLink,
} from '@dowel/api';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { parseAllowlist, validAllowlistEntry } from '../allowlist.ts';
import { audit } from '../audit.ts';
import { revokeSessions } from '../auth.ts';
import { isUniqueViolation } from '../db.ts';
import { deleteGrant, grantById, insertGrant, listGrants, subjectExists } from '../grants.ts';
import { createInvite, inviteById, listInvites, revokeInvite } from '../invites.ts';
import { hasOidcProvider, readSettings, writeSettings } from '../settings.ts';
import { userById, usernameTaken } from '../users.ts';
import { type AppContext, body, createUserOrConflict, type Env } from './context.ts';

/** 邀请默认 7 天，重置密码链接 24 小时 */
const INVITE_DAYS = 7;
const RESET_HOURS = 24;

const DAY_MS = 86400_000;

export const registerAdmin = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;
  const actorId = (c: Context<Env>) => c.get('user').id;

  // ───── 实例设置 ─────

  app.get('/api/admin/settings', async (c) => c.json<InstanceSettings>(await readSettings(db)));

  app.patch('/api/admin/settings', async (c) => {
    const b = await body(c, instanceSettingsPatchSchema);
    // 连接白名单写错一项就等于谁都连不上（或者拦不住）：保存前逐项校验
    if (b.connectionAllowlist) {
      const items = parseAllowlist(b.connectionAllowlist);
      const bad = items.filter((x) => !validAllowlistEntry(x));
      if (bad.length)
        throw new HTTPException(422, {
          message: `白名单里有不认识的写法：${bad.slice(0, 3).join('、')}（CIDR、IP 或主机名）`,
        });
      b.connectionAllowlist = items;
    }
    // Webhook 出站允许列表同样逐项校验（写错一项就放行不了想放行的内网接收端）
    if (b.webhookAllowlist) {
      const items = parseAllowlist(b.webhookAllowlist);
      const bad = items.filter((x) => !validAllowlistEntry(x));
      if (bad.length)
        throw new HTTPException(422, {
          message: `Webhook 出站允许列表里有不认识的写法：${bad.slice(0, 3).join('、')}（CIDR、IP 或主机名）`,
        });
      b.webhookAllowlist = items;
    }
    // 没有任何 OIDC 提供方时关闭密码登录会把所有人锁在外面，直接拒绝
    if (b.passwordLogin === false && !(await hasOidcProvider(db)))
      throw new HTTPException(422, {
        message: '还没有配置任何 OIDC 登录方式，不能关闭密码登录',
      });
    const next = await writeSettings(db, b);
    await audit(
      db,
      c,
      {
        action: 'instance.settings_update',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'instance',
        targetId: null,
        data: b,
      },
      ctx.security,
    );
    return c.json<InstanceSettings>(next);
  });

  // ───── 用户管理 ─────

  app.get('/api/admin/users', async (c) => {
    const q = c.req.query('q')?.trim().toLowerCase();
    // 两种方言都有 lower()；LIKE 在 SQLite 里对 ASCII 已经不区分大小写，统一小写更稳。
    // 搜索条件按 q 是否为空拼，避免 PG 推断不出 `$1 is null` 的参数类型。
    const where = q ? 'where lower(username) like $1 or lower(name) like $1 or lower(email) like $1' : '';
    const rows = await db.query<AdminUser>(
      `select id, username, name, email, role, status,
              created_at as "createdAt", last_login_at as "lastLoginAt"
         from users ${where} order by created_at, username`,
      q ? [`%${q}%`] : [],
    );
    return c.json<AdminUser[]>(rows);
  });

  app.post('/api/admin/users', async (c) => {
    const b = await body(c, adminUserCreateSchema);
    if (await usernameTaken(db, b.username)) throw new HTTPException(409, { message: '用户名已被使用' });
    const user = await createUserOrConflict(db, {
      username: b.username,
      name: b.name,
      email: b.email,
      password: b.password,
      role: b.role ?? 'member',
    });
    await audit(
      db,
      c,
      {
        action: 'user.create',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'user',
        targetId: user.id,
        data: { username: user.username, role: user.role, password: !!b.password },
      },
      ctx.security,
    );
    return c.json<AdminUser>(user, 201);
  });

  app.patch('/api/admin/users/:id', async (c) => {
    const id = c.req.param('id');
    const b = await body(c, adminUserPatchSchema);

    // 计数和更新必须在同一个事务里，否则两个管理员同时互相降级时会都以为自己不是最后一个。
    // PG 用 `for update` 锁住所有 active 管理员行（等锁的语句会重新判断行是否还符合条件）；
    // SQLite 不支持 for update，但适配器只有一个连接、事务串行，效果一样（见 db.ts 的注释）。
    const target = await db.transaction(async (tx) => {
      const current = await userById(tx, id);
      if (!current) throw new HTTPException(404, { message: '用户不存在' });
      // 不能把最后一个 active 的实例管理员停用或降级，否则没人能管理实例
      const demote = b.role === 'member' && current.role === 'admin';
      const disable = b.status === 'disabled' && current.status === 'active';
      if ((demote || disable) && current.role === 'admin' && current.status === 'active') {
        const admins = await tx.query<{ id: string }>(
          `select id from users where role = 'admin' and status = 'active' order by id${db.dialect === 'pg' ? ' for update' : ''}`,
        );
        if (admins.length <= 1)
          throw new HTTPException(422, {
            message: demote ? '不能降级最后一个实例管理员' : '不能停用最后一个实例管理员',
          });
      }
      await tx.query(
        'update users set name = coalesce($2, name), role = coalesce($3, role), status = coalesce($4, status) where id = $1',
        [id, b.name ?? null, b.role ?? null, b.status ?? null],
      );
      return current;
    });

    const disable = b.status === 'disabled' && target.status === 'active';

    // 停用：立即删掉他的会话
    if (disable) await revokeSessions(db, id);
    // 停用、降级 / 升级实例管理员都会改变生效角色：刷新所有已加载房间
    await ctx.rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'user.update',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'user',
        targetId: id,
        data: { ...b, username: target.username },
      },
      ctx.security,
    );
    return c.json<AdminUser>((await userById(db, id))!);
  });

  /** 一次性重置密码链接：24 小时有效，设完新密码会吊销该用户的所有会话 */
  app.post('/api/admin/users/:id/reset-link', async (c) => {
    const id = c.req.param('id');
    const target = await userById(db, id);
    if (!target) throw new HTTPException(404, { message: '用户不存在' });
    const { token, url, invite } = await createInvite(db, {
      kind: 'reset',
      createdBy: actorId(c),
      userId: id,
      expiresInMs: RESET_HOURS * 3600_000,
    });
    await audit(
      db,
      c,
      {
        action: 'user.reset_link',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'user',
        targetId: id,
        data: { username: target.username, expiresAt: invite.expiresAt },
      },
      ctx.security,
    );
    return c.json<ResetLink>({ url, token, expiresAt: invite.expiresAt });
  });

  // ───── 实例级授权（scope=instance，只有实例管理员能管） ─────

  app.get('/api/admin/grants', async (c) => c.json<GrantInfo[]>(await listGrants(db, 'instance', '')));

  app.post('/api/admin/grants', async (c) => {
    const b = await body(c, grantCreateSchema);
    if (b.environmentId) throw new HTTPException(400, { message: '实例级授权不能指定环境' });
    if (!(await subjectExists(db, b.subjectKind, b.subjectId)))
      throw new HTTPException(404, { message: '用户或组不存在' });
    let id: string;
    try {
      id = await insertGrant(db, {
        subjectKind: b.subjectKind,
        subjectId: b.subjectId,
        role: b.role,
        // 只有实例管理员能到这里
        byInstanceAdmin: true,
        // 实例范围的 scope_id 固定为空串：唯一约束里 NULL 在 PG 不算冲突，空串更简单
        scopeKind: 'instance',
        scopeId: '',
        createdBy: actorId(c),
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个对象已经有了相同的授权' });
      throw e;
    }
    // 实例级授权影响所有项目：重新算每个在线用户的生效角色
    await ctx.rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.create',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'instance',
        targetId: null,
        data: { subjectKind: b.subjectKind, subjectId: b.subjectId, role: b.role, scope: 'instance' },
      },
      ctx.security,
    );
    return c.json<GrantInfo>((await grantById(db, id))!, 201);
  });

  app.delete('/api/admin/grants/:id', async (c) => {
    const id = c.req.param('id')!;
    const grant = await grantById(db, id);
    if (grant?.scopeKind !== 'instance') throw new HTTPException(404, { message: '授权不存在' });
    await deleteGrant(db, id);
    await ctx.rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.delete',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'instance',
        targetId: null,
        data: {
          grantId: id,
          subjectKind: grant.subject.kind,
          subjectId: grant.subject.id,
          role: grant.role,
        },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  // ───── 邀请 ─────

  app.post('/api/admin/invites', async (c) => {
    const b = await body(c, inviteCreateSchema);
    const { invite, token, url } = await createInvite(db, {
      kind: 'invite',
      createdBy: actorId(c),
      expiresInMs: (b.expiresInDays ?? INVITE_DAYS) * DAY_MS,
      groupIds: b.groupIds,
    });
    await audit(
      db,
      c,
      {
        action: 'user.invite',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'invite',
        targetId: invite.id,
        data: { expiresAt: invite.expiresAt, groupIds: b.groupIds ?? [] },
      },
      ctx.security,
    );
    return c.json<InviteCreated>({ id: invite.id, token, url, expiresAt: invite.expiresAt }, 201);
  });

  app.get('/api/admin/invites', async (c) => c.json<InviteListItem[]>(await listInvites(db)));

  app.delete('/api/admin/invites/:id', async (c) => {
    const id = c.req.param('id');
    const invite = await inviteById(db, id);
    if (invite?.kind !== 'invite') throw new HTTPException(404, { message: '邀请不存在' });
    // 已经用掉的邀请不能撤销（它本来也失效了），撤销过的不重复撤销
    if (invite.usedAt) throw new HTTPException(409, { message: '这个邀请已经被使用，不能撤销' });
    if (invite.revokedAt) throw new HTTPException(404, { message: '邀请不存在或已撤销' });
    if (!(await revokeInvite(db, id)))
      throw new HTTPException(409, { message: '这个邀请已经被使用，不能撤销' });
    await audit(
      db,
      c,
      {
        action: 'invite.revoke',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'invite',
        targetId: id,
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });
};
