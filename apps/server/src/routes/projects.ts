// 项目：列表（只返回看得见的）、创建（必须指定组）、改名字 / slug / 默认权限、转组、按路径解析。
import {
  importSchema,
  type ModelUpdate,
  type Ok,
  type ProjectCreated,
  type ProjectInfo,
  type ProjectListItem,
  projectCreateSchema,
  projectDeleteSchema,
  projectPatchSchema,
  projectTransferSchema,
  type ResolvedProject,
} from '@dowel/api';
import { createSchema, emptyModel, FORMAT, newId } from '@dowel/core';
import { reconcileIds } from '@dowel/engines';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { inList, isUniqueViolation } from '../db.ts';
import { pinForTransfer } from '../env-policy.ts';
import { insertGrant } from '../grants.ts';
import { groupById, groupBySlug, groupRoleOf, pickProjectSlug, projectSlugTaken } from '../groups.ts';
import { deletePolicies, withPolicyLock } from '../policy.ts';
import { effectiveRole, loadRoleContext, projectRow, projectRows, visibleProjects } from '../roles.ts';
import { assertImportable } from '../shadow.ts';
import { type AppContext, access, body, type Env } from './context.ts';

export const registerProjects = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, shadows, refresher } = ctx;

  app.get('/api/projects', async (c) => {
    const rc = await loadRoleContext(db, c.get('user'));
    return c.json<ProjectListItem[]>(await visibleProjects(db, rc));
  });

  app.post('/api/projects', async (c) => {
    const b = await body(c, projectCreateSchema);
    const u = c.get('user');
    const g = await groupById(db, b.groupId);
    if (!g) throw new HTTPException(404, { message: '组不存在' });
    const groupRole = await groupRoleOf(db, g.id, u.id);
    if (
      !can(userActor(u), 'group.create_project', {
        kind: 'group',
        groupRole,
        projectCreation: g.projectCreation,
      })
    )
      throw new HTTPException(403, { message: '没有在这个组建项目的权限' });

    // slug：显式给出时要求组内唯一（409）；由名字生成时冲突自动加后缀
    const slug = await pickProjectSlug(db, g.id, b.name, b.slug);
    const scope = b.schemas?.length ? b.schemas : null;

    const pid = newId();
    const branch = newId();
    const model = emptyModel();
    createSchema(model, 'public');
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          'insert into projects (id, name, created_by, group_id, slug, schemas) values ($1, $2, $3, $4, $5, $6::text::jsonb)',
          [pid, b.name, u.id, g.id, slug, scope ? JSON.stringify(scope) : null],
        );
        // 建项目的人自动获得这个项目的 admin 授权
        await insertGrant(tx, {
          subjectKind: 'user',
          subjectId: u.id,
          role: 'admin',
          scopeKind: 'project',
          scopeId: pid,
          createdBy: u.id,
        });
        await tx.query("insert into branches (id, project_id, name) values ($1, $2, 'main')", [branch, pid]);
        await tx.query(
          'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
          [branch, JSON.stringify(model), '{}'],
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个组里已经有相同的标识' });
      throw e;
    }
    await audit(
      db,
      c,
      {
        action: 'project.create',
        actorKind: 'user',
        actorId: u.id,
        targetKind: 'project',
        targetId: pid,
        projectId: pid,
        data: { name: b.name, slug, groupId: g.id, content: 'blank', schemas: scope },
      },
      ctx.security,
    );
    return c.json<ProjectCreated>(
      {
        id: pid,
        name: b.name,
        slug,
        role: 'admin',
        group: { id: g.id, slug: g.slug, name: g.name },
      },
      201,
    );
  });

  const info = async (c: Parameters<typeof access>[0], a: Awaited<ReturnType<typeof access>>) =>
    ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      role: a.role,
      branch: a.branch,
      group: { id: a.groupId, slug: a.groupSlug, name: a.groupName },
      defaultRole: a.projectDefaultRole,
      groupDefaultRole: a.groupDefaultRole,
      groupRole: await groupRoleOf(db, a.groupId, c.get('user').id),
      schemas: a.schemas ?? null,
    }) satisfies ProjectInfo;

  app.get('/api/projects/:pid', async (c) => {
    const a = await access(c, ctx, 'project.read');
    return c.json<ProjectInfo>(await info(c, a));
  });

  // 改名字、slug、默认权限、schema 范围（项目自己的默认权限，null 表示沿用组的）
  app.patch('/api/projects/:pid', async (c) => {
    const a = await access(c, ctx, 'project.settings');
    const b = await body(c, projectPatchSchema);
    // 项目自己的默认权限只能由组管理员（或实例管理员）设置，项目管理员不一定能改
    if (b.defaultRole !== undefined) {
      const groupRole = await groupRoleOf(db, a.groupId, c.get('user').id);
      if (!can(userActor(c.get('user')), 'group.manage', { kind: 'group', groupRole }))
        throw new HTTPException(403, { message: '只有组管理员能设置项目的默认权限' });
    }
    const slugChanged = b.slug !== undefined && b.slug !== a.slug;
    if (slugChanged && (await projectSlugTaken(db, a.groupId, b.slug!, a.id)))
      throw new HTTPException(409, { message: '这个组里已经有相同的标识' });
    // schema 范围：空数组视为全部（和建项目时一致）；变了要重建影子库的读过滤
    const scope = b.schemas === undefined ? undefined : b.schemas?.length ? b.schemas : null;
    const scopeChanged = scope !== undefined && JSON.stringify(scope) !== JSON.stringify(a.schemas ?? null);

    try {
      await db.transaction(async (tx) => {
        if (slugChanged) {
          // 旧路径要能跳过来：先记下旧地址，再改
          await tx.query(
            `insert into project_redirects (owner_slug, project_slug, project_id) values ($1, $2, $3)
             on conflict (owner_slug, project_slug) do update set project_id = excluded.project_id`,
            [a.groupSlug, a.slug, a.id],
          );
        }
        // 动态拼接：default_role 传 null 是一个有意义的值（沿用组），不能用 coalesce
        const sets: string[] = [];
        const params: unknown[] = [a.id];
        if (b.name !== undefined) {
          params.push(b.name);
          sets.push(`name = $${params.length}`);
        }
        if (b.slug !== undefined) {
          params.push(b.slug);
          sets.push(`slug = $${params.length}`);
        }
        if (b.defaultRole !== undefined) {
          params.push(b.defaultRole);
          sets.push(`default_role = $${params.length}`);
        }
        if (scope !== undefined) {
          params.push(scope ? JSON.stringify(scope) : null);
          sets.push(`schemas = $${params.length}::text::jsonb`);
        }
        if (sets.length) await tx.query(`update projects set ${sets.join(', ')} where id = $1`, params);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '这个组里已经有相同的标识' });
      throw e;
    }

    // 默认权限变了：重新算在线用户的生效角色
    if (b.defaultRole !== undefined) await rooms.refreshLoaded();
    // schema 范围变了：影子库读结构时的过滤条件要重建（下次用到时按新范围重连）
    if (scopeChanged) await shadows.forgetProject(a.id);
    await audit(
      db,
      c,
      {
        // 改 slug、改默认权限、改 schema 范围都单独记一个动作，便于审计里一眼看出来
        action: slugChanged
          ? 'project.slug'
          : b.defaultRole !== undefined
            ? 'project.default_role'
            : 'project.update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: { ...b, oldSlug: slugChanged ? a.slug : undefined },
      },
      ctx.security,
    );
    const after = await access(c, ctx, 'project.read');
    return c.json<ProjectInfo>(await info(c, after));
  });

  // 转组：需要同时是源组和目标组的组管理员，或者实例管理员；旧路径写跳转。
  // 转组会换掉组层的执行策略：每个环境按新的组层重新合并，变宽的字段固定成原来的生效值写进环境层
  // （和改生产标记同一条规则，pinForTransfer），在执行策略锁的事务里和改 group_id 一起做；审计记下被固定的字段。
  // 注意：原组范围的执行者授权（scope = 原组）对这个项目不再有效，目标组范围的开始有效——授权本来就跟着范围走。
  app.post('/api/projects/:pid/transfer', async (c) => {
    const a = await access(c, ctx, 'project.transfer');
    const b = await body(c, projectTransferSchema);
    const u = c.get('user');
    const actor = userActor(u);
    const target = await groupById(db, b.groupId);
    if (!target) throw new HTTPException(404, { message: '组不存在' });
    if (target.id === a.groupId) throw new HTTPException(422, { message: '项目已经在这个组里' });

    const sourceRole = await groupRoleOf(db, a.groupId, u.id);
    const targetRole = await groupRoleOf(db, target.id, u.id);
    if (!actor.instanceAdmin && !(sourceRole === 'admin' && targetRole === 'admin'))
      throw new HTTPException(403, { message: '需要同时是源组和目标组的组管理员' });
    if (await projectSlugTaken(db, target.id, a.slug))
      throw new HTTPException(409, { message: '目标组里已经有相同的标识' });

    let pinned: Awaited<ReturnType<typeof pinForTransfer>> = [];
    try {
      await withPolicyLock(db, async (tx) => {
        // 锁内重新读项目当前所属的组：锁外检查的“源组管理员”、固定用的源组层、旧地址跳转都以它为前提。
        // 等锁期间项目已经被别人转走了（组变了）就 409，让用户刷新后重来，不在新的源组上沿用旧组的检查结果
        const [cur] = await tx.query<{ groupId: string; groupSlug: string; slug: string }>(
          `select p.group_id as "groupId", g.slug as "groupSlug", p.slug
             from projects p join groups g on g.id = p.group_id where p.id = $1`,
          [a.id],
        );
        if (!cur) throw new HTTPException(404, { message: '项目不存在' });
        if (cur.groupId !== a.groupId)
          throw new HTTPException(409, { message: '项目在你提交期间已经被转到了别的组，请刷新后重试' });
        pinned = await pinForTransfer(tx, { id: a.id, groupId: cur.groupId }, target.id, u.id);
        // 旧地址跳转用锁内读到的组 slug 和项目 slug
        await tx.query(
          `insert into project_redirects (owner_slug, project_slug, project_id) values ($1, $2, $3)
           on conflict (owner_slug, project_slug) do update set project_id = excluded.project_id`,
          [cur.groupSlug, cur.slug, a.id],
        );
        await tx.query('update projects set group_id = $2 where id = $1', [a.id, target.id]);
      });
    } catch (e) {
      // 上面的预检查可能和并发转组撞车：唯一约束（组内 slug）兜底，仍然返回 409
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: '目标组里已经有相同的标识' });
      throw e;
    }
    // 组的默认权限换了，在线用户的项目角色要重算
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'project.transfer',
        actorKind: 'user',
        actorId: u.id,
        targetKind: 'project',
        targetId: a.id,
        projectId: a.id,
        data: {
          from: a.groupId,
          to: target.id,
          slug: a.slug,
          // 执行策略：换了组层后会变宽、因此被固定进环境层的字段（环境 → 字段）
          ...(pinned.length ? { policyPinned: pinned } : {}),
        },
      },
      ctx.security,
    );
    const after = await access(c, ctx, 'project.read');
    return c.json<ProjectInfo>(await info(c, after));
  });

  /**
   * 删除项目（只有项目管理员能做）：请求体必须原样带上项目标识（slug），避免误删。
   * 分支 / 快照 / 操作日志 / 版本 / 环境 / 授权 / 跳转记录都在一个事务里删掉；
   * 审计记录不跟着删（它本来就是留档用的），在线的人用 4403 断开（和“没有权限了”同一个约定）。
   */
  app.delete('/api/projects/:pid', async (c) => {
    const a = await access(c, ctx, 'project.delete');
    const b = await body(c, projectDeleteSchema);
    if (b.confirm !== a.slug) throw new HTTPException(400, { message: '确认文字不匹配，请输入项目的标识' });
    const deleted = await db.transaction(async (tx) => {
      const branchIds = (
        await tx.query<{ id: string }>('select id from branches where project_id = $1', [a.pid])
      ).map((r) => r.id);
      const envIds = (
        await tx.query<{ id: string }>('select id from environments where project_id = $1', [a.pid])
      ).map((r) => r.id);
      // 删除顺序从叶子往根：显式删掉每一项，不依赖级联规则在两种方言里一致
      for (const table of ['room_rejections', 'room_commits', 'room_snapshots'])
        await tx.query(
          `delete from ${table} where branch_id in (select id from branches where project_id = $1)`,
          [a.pid],
        );
      await tx.query('delete from versions where project_id = $1', [a.pid]);
      // 前置环境有约束（PG 外键 / SQLite 触发器）：同一个项目里的环境互相引用，先清掉再整体删除
      await tx.query('update environments set prerequisite_id = null where project_id = $1', [a.pid]);
      await tx.query('delete from environments where project_id = $1', [a.pid]);
      await tx.query('delete from branches where project_id = $1', [a.pid]);
      await tx.query("delete from grants where scope_kind = 'project' and scope_id = $1", [a.pid]);
      // 环境上的执行者授权、项目层和环境层的执行策略（范围是多态的，没有外键）
      if (envIds.length)
        await tx.query(
          `delete from grants where scope_kind = 'environment' and scope_id in (${inList(envIds)})`,
          envIds,
        );
      await deletePolicies(tx, 'environment', envIds);
      await deletePolicies(tx, 'project', [a.pid]);
      await tx.query('delete from project_redirects where project_id = $1', [a.pid]);
      await tx.query('delete from projects where id = $1', [a.pid]);
      return { branchIds, envIds };
    });
    // 事务提交之后才能动内存里的缓存：提交失败的话项目还在，不能提前把连接 / 基线丢掉。
    // 1. 房间：断开在线的人，并从 rooms 缓存里卸载（4403 和“没有权限了”同一个约定）；
    // 2. 影子库：每个被删掉的环境一个连接，关掉并从 Shadows 缓存里移除；
    // 3. 派生数据：取消挂起的刷新，丢掉已规范化的基线和重试计数。
    await rooms.kickBranches(deleted.branchIds, '项目已被删除');
    for (const eid of deleted.envIds) await shadows.forget(eid);
    for (const branchId of deleted.branchIds) refresher.forget(branchId);
    await audit(
      db,
      c,
      {
        action: 'project.delete',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'project',
        targetId: a.pid,
        projectId: a.pid,
        data: { name: a.name, slug: a.slug, groupId: a.groupId },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  // 按 /project/:owner/:project 解析。旧路径（project_redirects）也能解析，返回当前路径。
  app.get('/api/resolve/:owner/:project', async (c) => {
    const owner = c.req.param('owner')!.trim().toLowerCase();
    const projectSlug = c.req.param('project')!.trim().toLowerCase();
    const u = c.get('user');
    const rc = await loadRoleContext(db, u);

    const group = await groupBySlug(db, owner);
    let p = group
      ? (await projectRows(db, { groupId: group.id })).find((x) => x.slug === projectSlug)
      : undefined;
    let redirected = false;
    if (!p) {
      const [old] = await db.query<{ projectId: string }>(
        'select project_id as "projectId" from project_redirects where owner_slug = $1 and project_slug = $2',
        [owner, projectSlug],
      );
      if (old) {
        p = (await projectRow(db, old.projectId)) ?? undefined;
        redirected = true;
      }
    }
    // 看不到的项目一律当作不存在（G4）
    const role = p ? effectiveRole(rc, p) : null;
    if (!p || !role) throw new HTTPException(404, { message: '项目不存在' });
    return c.json<ResolvedProject>({
      id: p.id,
      name: p.name,
      slug: p.slug,
      owner: p.groupSlug,
      groupName: p.groupName,
      redirected,
    });
  });

  // 导入 DDL 文本：在影子库里执行，读出结构，替换当前工作副本（作为一次普通提交广播给所有人）
  app.post('/api/projects/:pid/import', async (c) => {
    const a = await access(c, ctx, 'model.import');
    const b = await body(c, importSchema);
    // 实例级语句在准备影子库之前就拒绝：不建库、不拿锁、不执行；只在这里扫一遍（见 assertImportable）
    const sql = assertImportable(b.sql);
    const s = await shadows.forProject(a.pid, b.env);
    // 按名字沿用已有对象的 ID：重新导入不会把一切当成先删后加，画布布局也能保留
    const imported = reconcileIds((await rooms.model(a.branch)).model, await s.shadow.importSql(sql));
    if (imported.format !== FORMAT) throw new HTTPException(500);
    await ctx.replace(a.branch, c.get('user').name, imported, 'importSql');
    const { seq } = await rooms.model(a.branch);
    await audit(
      db,
      c,
      {
        action: 'model.import',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'project',
        targetId: a.pid,
        projectId: a.pid,
        data: { seq, objects: Object.keys(imported.objects).length },
      },
      ctx.security,
    );
    return c.json<ModelUpdate>({ seq, objects: Object.keys(imported.objects).length });
  });
};
