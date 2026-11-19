// 授权：项目级（这里）、组级和实例级（routes/groups.ts、routes/admin.ts）。
// 谁能管：项目管理员管项目级授权，组管理员管组级授权，实例管理员管实例级授权。
import { type GrantInfo, grantCreateSchema, grantPatchSchema, type Ok, type ProjectAccess } from '@dowel/api';
import type { Db } from '@dowel/engines';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { isUniqueViolation } from '../db.ts';
import {
  defaultMembers,
  deleteGrant,
  grantById,
  insertGrant,
  listGrants,
  projectHasAdmin,
  subjectExists,
  updateGrantRole,
} from '../grants.ts';
import { type AppContext, access, body, type Env } from './context.ts';

export const registerGrants = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms } = ctx;
  const actorId = (c: Context<Env>) => c.get('user').id;
  /** PG 上锁住项目行，避免两个并发操作都以为“还有一个管理员”（SQLite 的事务本来就串行） */
  const lockProject = async (tx: Db, pid: string) => {
    if (db.dialect === 'pg') await tx.query('select id from projects where id = $1 for update', [pid]);
  };

  // 授权和组默认权限的成员都对能看项目的人可见（组、组成员本来就对所有人可见）
  app.get('/api/projects/:pid/grants', async (c) => {
    const a = await access(c, ctx, 'project.read');
    return c.json<ProjectAccess>({
      grants: await listGrants(db, 'project', a.id),
      defaultMembers: await defaultMembers(db, a),
    });
  });

  app.post('/api/projects/:pid/grants', async (c) => {
    const a = await access(c, ctx, 'project.manage_grants');
    const b = await body(c, grantCreateSchema);
    if (!(await subjectExists(db, b.subjectKind, b.subjectId)))
      throw new HTTPException(404, { message: '用户或组不存在' });
    let id: string;
    try {
      id = await insertGrant(db, {
        ...b,
        scopeKind: 'project',
        scopeId: a.id,
        createdBy: c.get('user').id,
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
        actorId: actorId(c),
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: { subjectKind: b.subjectKind, subjectId: b.subjectId, role: b.role, scope: 'project' },
      },
      ctx.security,
    );
    return c.json<GrantInfo>((await grantById(db, id))!, 201);
  });

  /** 项目级授权必须属于这个项目（不能借别的项目的 id 改角色） */
  const grantForProject = async (a: { id: string }, id: string) => {
    const g = await grantById(db, id);
    if (g?.scopeKind !== 'project' || g.scopeId !== a.id)
      throw new HTTPException(404, { message: '授权不存在' });
    return g;
  };

  app.patch('/api/projects/:pid/grants/:id', async (c) => {
    const a = await access(c, ctx, 'project.manage_grants');
    const id = c.req.param('id')!;
    await grantForProject(a, id);
    const b = await body(c, grantPatchSchema);
    await db.transaction(async (tx) => {
      await lockProject(tx, a.id);
      await updateGrantRole(tx, id, b.role);
      // 保护最后一个项目管理员：组管理员和实例管理员也算，所以一般不会触发
      if (!(await projectHasAdmin(tx, a)))
        throw new HTTPException(409, { message: '项目至少要有一个项目管理员' });
    });
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.update',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: { grantId: id, role: b.role },
      },
      ctx.security,
    );
    return c.json<GrantInfo>((await grantById(db, id))!);
  });

  app.delete('/api/projects/:pid/grants/:id', async (c) => {
    const a = await access(c, ctx, 'project.manage_grants');
    const id = c.req.param('id')!;
    const g = await grantForProject(a, id);
    await db.transaction(async (tx) => {
      await lockProject(tx, a.id);
      await deleteGrant(tx, id);
      if (!(await projectHasAdmin(tx, a)))
        throw new HTTPException(409, { message: '项目至少要有一个项目管理员' });
    });
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'grant.delete',
        actorKind: 'user',
        actorId: actorId(c),
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: { grantId: id, subjectKind: g.subject.kind, subjectId: g.subject.id, role: g.role },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });
};
