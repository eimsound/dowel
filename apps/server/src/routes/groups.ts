// 组：列表 / 创建 / 修改 / 删除，组成员，组级授权，组内项目列表。
// 组、组成员、组管理员对所有已登录用户可见；管理动作需要组管理员（规则在 authz.ts）。
import {
  type GrantInfo,
  type GroupInfo,
  type GroupList,
  type GroupMember,
  type GroupRole,
  grantCreateSchema,
  groupCreateSchema,
  groupMemberAddSchema,
  groupMemberPatchSchema,
  groupPatchSchema,
  type Ok,
  type ProjectListItem,
} from '@dowel/api';
import { newId } from '@dowel/core';
import type { Db } from '@dowel/engines';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { isUniqueViolation } from '../db.ts';
import { deleteGrant, grantById, insertGrant, listGrants, subjectExists } from '../grants.ts';
import { GROUP_COLUMNS, type GroupRow, groupById, groupCounts, groupRoleOf, slugTaken } from '../groups.ts';
import { deletePolicies } from '../policy.ts';
import { loadRoleContext, visibleProjects } from '../roles.ts';
import { readSettings } from '../settings.ts';
import { userByUsername } from '../users.ts';
import { type AppContext, body, type Env, groupAccess } from './context.ts';
import { deleteTokenPolicies } from './tokens.ts';

const info = async (db: Db, g: GroupRow, role: GroupRole | null): Promise<GroupInfo> => ({
  ...g,
  role,
  ...((await groupCounts(db, g.id)).get(g.id) ?? { memberCount: 0, projectCount: 0 }),
});

export const registerGroups = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms } = ctx;

  app.get('/api/groups', async (c) => {
    const u = c.get('user');
    const rows = await db.query<GroupRow>(`select ${GROUP_COLUMNS} from groups g order by g.name, g.slug`);
    const totals = await groupCounts(db);
    const mine = new Map(
      (
        await db.query<{ groupId: string; role: GroupRole }>(
          'select group_id as "groupId", role from group_members where user_id = $1',
          [u.id],
        )
      ).map((r) => [r.groupId, r.role]),
    );
    const settings = await readSettings(db);
    return c.json<GroupList>({
      groups: rows.map((g) => ({
        ...g,
        role: mine.get(g.id) ?? null,
        memberCount: totals.get(g.id)?.memberCount ?? 0,
        projectCount: totals.get(g.id)?.projectCount ?? 0,
      })),
      // 建组看实例设置；实例管理员始终可以（can() 里先放行实例管理员）
      canCreate: can(userActor(u), 'instance.create_group', {
        kind: 'instance',
        groupCreation: settings.groupCreation,
      }),
    });
  });

  app.post('/api/groups', async (c) => {
    const b = await body(c, groupCreateSchema);
    const u = c.get('user');
    const settings = await readSettings(db);
    if (
      !can(userActor(u), 'instance.create_group', { kind: 'instance', groupCreation: settings.groupCreation })
    )
      throw new HTTPException(403, { message: '只有实例管理员能建组' });
    if (await slugTaken(db, b.slug)) throw new HTTPException(409, { message: '标识已被使用' });

    const id = newId();
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          `insert into groups (id, slug, name, description, default_role, project_creation)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, b.slug, b.name, b.description, b.defaultRole ?? 'editor', b.projectCreation ?? 'members'],
        );
        // 建组的人自动成为组管理员
        await tx.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'admin')", [
          id,
          u.id,
        ]);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '标识已被使用' });
      throw e;
    }
    await audit(
      db,
      c,
      {
        action: 'group.create',
        actorKind: 'user',
        actorId: u.id,
        targetKind: 'group',
        targetId: id,
        data: { slug: b.slug, name: b.name },
      },
      ctx.security,
    );
    return c.json<GroupInfo>(await info(db, (await groupById(db, id))!, 'admin'), 201);
  });

  app.get('/api/groups/:slug', async (c) => {
    const g = await groupAccess(c, ctx, 'group.read');
    return c.json<GroupInfo>(await info(db, g, g.groupRole));
  });

  app.patch('/api/groups/:slug', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage');
    const b = await body(c, groupPatchSchema);
    const sets: string[] = [];
    const params: unknown[] = [g.id];
    for (const [key, column] of [
      ['name', 'name'],
      ['description', 'description'],
      ['defaultRole', 'default_role'],
      ['projectCreation', 'project_creation'],
    ] as const) {
      const value = b[key];
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length) await db.query(`update groups set ${sets.join(', ')} where id = $1`, params);
    // 默认权限变了：组里所有项目的在线用户都要重算角色
    // 默认权限变了（也可能只是名字变了，刷新很便宜）：重算在线用户
    if (b.defaultRole !== undefined) await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'group.update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: b,
      },
      ctx.security,
    );
    return c.json<GroupInfo>(await info(db, (await groupById(db, g.id))!, g.groupRole));
  });

  app.delete('/api/groups/:slug', async (c) => {
    const g = await groupAccess(c, ctx, 'group.delete');
    const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
      'select count(*) as n from projects where group_id = $1',
      [g.id],
    );
    // 组里还有项目就不能删：先转组或删项目
    if (Number(n) > 0) throw new HTTPException(409, { message: '组里还有项目，不能删除' });
    await db.transaction(async (tx) => {
      // 授权表的 scope 是多态的，没有外键，手动清理（作为范围、作为对象两种都要删）
      await tx.query("delete from grants where scope_kind = 'group' and scope_id = $1", [g.id]);
      await tx.query("delete from grants where subject_kind = 'group' and subject_id = $1", [g.id]);
      // 组层的执行策略与令牌创建规则（范围是多态的，没有外键）
      await deletePolicies(tx, 'group', [g.id]);
      await deleteTokenPolicies(tx, 'group', [g.id]);
      await tx.query('delete from group_members where group_id = $1', [g.id]);
      await tx.query('delete from groups where id = $1', [g.id]);
    });
    // 删组会把“这个组作为授权对象”的授权一起删掉：成员可能因此失去别的组的项目权限
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'group.delete',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: { slug: g.slug, name: g.name },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  // 组内项目：只返回调用者看得见的
  app.get('/api/groups/:slug/projects', async (c) => {
    const g = await groupAccess(c, ctx, 'group.read');
    const rc = await loadRoleContext(db, c.get('user'));
    return c.json<ProjectListItem[]>(await visibleProjects(db, rc, { groupId: g.id }));
  });

  // ───── 组成员 ─────

  app.get('/api/groups/:slug/members', async (c) => {
    const g = await groupAccess(c, ctx, 'group.read');
    return c.json<GroupMember[]>(
      await db.query<GroupMember>(
        `select u.id, u.username, u.name, gm.role from group_members gm
           join users u on u.id = gm.user_id where gm.group_id = $1 order by u.name, u.username`,
        [g.id],
      ),
    );
  });

  app.post('/api/groups/:slug/members', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_members');
    const b = await body(c, groupMemberAddSchema);
    // 按用户名找人：邮箱选填且不唯一
    const u = await userByUsername(db, b.username);
    if (!u) throw new HTTPException(404, { message: '没有这个用户' });
    try {
      await db.query('insert into group_members (group_id, user_id, role) values ($1, $2, $3)', [
        g.id,
        u.id,
        b.role,
      ]);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个用户已经在组里' });
      throw e;
    }
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'group.member_add',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: { userId: u.id, username: u.username, role: b.role },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  app.patch('/api/groups/:slug/members/:userId', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_members');
    const userId = c.req.param('userId')!;
    const b = await body(c, groupMemberPatchSchema);
    const actor = userActor(c.get('user'));
    // 读当前身份、检查最后一个组管理员、更新都放在同一个事务里（PG 先锁组行，SQLite 事务串行）
    const current = await db.transaction(async (tx) => {
      await lockGroup(tx, g.id);
      const role = await groupRoleOf(tx, g.id, userId);
      if (!role) throw new HTTPException(404, { message: '这个用户不在组里' });
      if (role === 'admin' && b.role !== 'admin' && !actor.instanceAdmin)
        await assertNotLastGroupAdmin(tx, g.id);
      await tx.query('update group_members set role = $3 where group_id = $1 and user_id = $2', [
        g.id,
        userId,
        b.role,
      ]);
      return role;
    });
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'group.member_update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: { userId, from: current, to: b.role },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  app.delete('/api/groups/:slug/members/:userId', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_members');
    const userId = c.req.param('userId')!;
    const actor = userActor(c.get('user'));
    const current = await db.transaction(async (tx) => {
      await lockGroup(tx, g.id);
      const role = await groupRoleOf(tx, g.id, userId);
      if (!role) throw new HTTPException(404, { message: '这个用户不在组里' });
      // 最后一个组管理员不能被移除（实例管理员除外）
      if (role === 'admin' && !actor.instanceAdmin) await assertNotLastGroupAdmin(tx, g.id);
      await tx.query('delete from group_members where group_id = $1 and user_id = $2', [g.id, userId]);
      return role;
    });
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'group.member_remove',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: { userId, role: current },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  /** PG 上锁住组行；SQLite 只有一个连接，事务本身就是串行的 */
  const lockGroup = async (tx: Db, groupId: string) => {
    if (db.dialect === 'pg') await tx.query('select id from groups where id = $1 for update', [groupId]);
  };

  /** 组里至少还要剩下一个组管理员 */
  const assertNotLastGroupAdmin = async (tx: Db, groupId: string) => {
    const [row] = await tx.query<{ n: number }>(
      "select count(*) as n from group_members where group_id = $1 and role = 'admin'",
      [groupId],
    );
    if (Number(row?.n ?? 0) <= 1) throw new HTTPException(409, { message: '组里至少要有一个组管理员' });
  };

  // ───── 组级授权（scope=group） ─────

  app.get('/api/groups/:slug/grants', async (c) => {
    const g = await groupAccess(c, ctx, 'group.read');
    return c.json<GrantInfo[]>(await listGrants(db, 'group', g.id));
  });

  app.post('/api/groups/:slug/grants', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_grants');
    const b = await body(c, grantCreateSchema);
    if (b.environmentId) throw new HTTPException(400, { message: '组级授权不能指定环境' });
    if (!(await subjectExists(db, b.subjectKind, b.subjectId)))
      throw new HTTPException(404, { message: '用户或组不存在' });
    const instanceAdmin = userActor(c.get('user')).instanceAdmin === true;
    let id: string;
    try {
      id = await insertGrant(db, {
        subjectKind: b.subjectKind,
        subjectId: b.subjectId,
        role: b.role,
        scopeKind: 'group',
        scopeId: g.id,
        createdBy: c.get('user').id,
        byInstanceAdmin: instanceAdmin,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个对象已经有了相同的授权' });
      throw e;
    }
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.create',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
        data: {
          subjectKind: b.subjectKind,
          subjectId: b.subjectId,
          role: b.role,
          scope: 'group',
          byInstanceAdmin: instanceAdmin,
        },
      },
      ctx.security,
    );
    return c.json<GrantInfo>((await grantById(db, id))!, 201);
  });

  app.delete('/api/groups/:slug/grants/:id', async (c) => {
    const g = await groupAccess(c, ctx, 'group.manage_grants');
    const id = c.req.param('id')!;
    const grant = await grantById(db, id);
    if (grant?.scopeKind !== 'group' || grant.scopeId !== g.id)
      throw new HTTPException(404, { message: '授权不存在' });
    await deleteGrant(db, id);
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.delete',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'group',
        targetId: g.id,
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
};
