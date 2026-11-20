// 授权：项目级（这里，含项目里各环境上的执行者授权）、组级和实例级（routes/groups.ts、routes/admin.ts）。
// 谁能管：项目管理员管项目级授权，组管理员管组级授权，实例管理员管实例级授权。
// 执行者授权（P5a）的例外：“仅限执行者”的生产环境上只认实例管理员授予的执行者（见 checkExecutorGrant）。
import { type GrantInfo, grantCreateSchema, grantPatchSchema, type Ok, type ProjectAccess } from '@dowel/api';
import type { Db } from '@dowel/engines';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { userActor } from '../authz.ts';
import { isUniqueViolation } from '../db.ts';
import { type EnvRow, loadEnv } from '../envs.ts';
import {
  defaultMembers,
  deleteGrant,
  grantById,
  insertGrant,
  listProjectGrants,
  projectHasAdmin,
  subjectExists,
  updateGrantRole,
} from '../grants.ts';
import { loadPolicies, resolveEnv } from '../policy.ts';
import { type AppContext, access, body, type Env } from './context.ts';

/**
 * 执行者授权的规则（项目、组、实例三个入口共用）：
 * - 只有执行者授权能落在单个环境上（项目角色只管模型，不按环境授）；
 * - 授予者是实例管理员时记下 byInstanceAdmin；
 * - 环境范围：这个环境是“仅限执行者”的生产环境时，只有实例管理员能授予（02-consensus.md 11.2）。项目 / 组 / 实例范围的
 *   执行者授权不拦：它对其他环境有效，只是对“仅限执行者”的生产环境不算（isExecutor 只认实例管理员授予的），界面上说明。
 */
export const checkExecutorGrant = (
  role: string,
  environment: { env: EnvRow; executorOnlyProduction: boolean } | null,
  instanceAdmin: boolean,
) => {
  if (environment && role !== 'executor')
    throw new HTTPException(400, { message: '只有“执行者”可以授予到单个环境；项目角色请授予整个项目' });
  if (environment?.executorOnlyProduction && !instanceAdmin)
    throw new HTTPException(403, {
      message: `“${environment.env.name}”是“仅限执行者”的生产环境：它的执行者只能由实例管理员授予`,
    });
};

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
      grants: await listProjectGrants(db, a.id),
      defaultMembers: await defaultMembers(db, a),
    });
  });

  app.post('/api/projects/:pid/grants', async (c) => {
    const a = await access(c, ctx, 'project.manage_grants');
    const b = await body(c, grantCreateSchema);
    if (!(await subjectExists(db, b.subjectKind, b.subjectId)))
      throw new HTTPException(404, { message: '用户或组不存在' });
    const instanceAdmin = userActor(c.get('user')).instanceAdmin === true;
    let target: { env: EnvRow; executorOnlyProduction: boolean } | null = null;
    if (b.environmentId) {
      const env = await loadEnv(db, a.id, b.environmentId);
      const resolved = resolveEnv(await loadPolicies(db, a), env);
      target = { env, executorOnlyProduction: env.production && resolved.whoCanExecute.value === 'executor' };
    }
    checkExecutorGrant(b.role, target, instanceAdmin);
    let id: string;
    try {
      id = await insertGrant(db, {
        subjectKind: b.subjectKind,
        subjectId: b.subjectId,
        role: b.role,
        scopeKind: target ? 'environment' : 'project',
        scopeId: target ? target.env.id : a.id,
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
        actorId: actorId(c),
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: {
          subjectKind: b.subjectKind,
          subjectId: b.subjectId,
          role: b.role,
          scope: target ? 'environment' : 'project',
          ...(target ? { environmentId: target.env.id, environment: target.env.name } : {}),
          byInstanceAdmin: instanceAdmin,
        },
      },
      ctx.security,
    );
    return c.json<GrantInfo>((await grantById(db, id))!, 201);
  });

  /** 项目级授权必须属于这个项目（不能借别的项目的 id 改角色）；envOk：这个项目某个环境上的执行者授权也算（删除用） */
  const grantForProject = async (a: { id: string }, id: string, envOk = false) => {
    const g = await grantById(db, id);
    if (g?.scopeKind === 'project' && g.scopeId === a.id) return g;
    if (envOk && g?.scopeKind === 'environment') {
      const [e] = await db.query('select 1 from environments where id = $1 and project_id = $2', [
        g.scopeId,
        a.id,
      ]);
      if (e) return g;
    }
    throw new HTTPException(404, { message: '授权不存在' });
  };

  app.patch('/api/projects/:pid/grants/:id', async (c) => {
    const a = await access(c, ctx, 'project.manage_grants');
    const id = c.req.param('id')!;
    const g = await grantForProject(a, id);
    const b = await body(c, grantPatchSchema);
    if (g.role === 'executor')
      throw new HTTPException(400, { message: '执行者授权不能改成项目角色：请删除后重新授权' });
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
    const g = await grantForProject(a, id, true);
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
