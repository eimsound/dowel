// 执行策略的配置接口（P5a，E1 / E9）：实例、组、项目、环境四层，每层 GET 看（含生效值、来源、上级锁定）、PUT 整层替换。
//
// 谁能改：实例层 = 实例管理员；组层 = 组管理员；项目层 = 项目管理员；环境层 = 项目管理员。
// 写入规则（都在写之前检查，拒绝时什么都不写）：
// 1. 下级只能收紧：本层每个字段不能比上级合并出来的下限更宽（422，validateLayer）；审批流程只能在上级之后追加环节；
// 2. **放宽是特权操作**：改动让本层的生效策略变宽（任一字段变宽、审批流程不再包含原流程）时，
//    操作者还要满足本层**改动前**生效的“谁能执行”（403）。理由见 policy.ts 开头：否则“仅限执行者”可以被非执行者自己撤掉；
// 3. 审批流程里引用的组 / 用户必须存在（422）。
// 所有修改写审计 exec_policy.update（层、范围、改动前后的设置、是否放宽、被固定的字段）。
// **原子性**（审查后）：每次写入都在 withPolicyLock 的事务里重新读当前值 → 校验 / 放宽检测 → 写 → 严格审计（auditIn），
// 一次收紧不会被另一个基于旧状态、没经过放宽检查的写入覆盖。环境层和 PATCH …/environments/:eid 共用 applyEnvPolicy。
import {
  type EnvPolicyView,
  type ExecPolicy,
  envPolicyPutSchema,
  type GroupRole,
  type LayerPolicy,
  layerPolicyPutSchema,
  loosenedFields,
  normalizeSettings,
  type PolicyInput,
  type PolicyLayerView,
  type PolicySettings,
  pickSet,
  type ResolvedPolicy,
  resolvePolicy,
  validateLayer,
  whoLabel,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { auditIn } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { applyEnvPolicy } from '../env-policy.ts';
import { type EnvRow, envResource } from '../envs.ts';
import {
  accessIn,
  assertApproversExist,
  deniedMessage,
  envAuthOf,
  isExecutor,
  loadLayer,
  loadPolicies,
  type PolicyStore,
  policyNames,
  saveLayer,
  upperInput,
  withPolicyLock,
} from '../policy.ts';
import { loadRoleContext, type RoleContext } from '../roles.ts';
import type { Role } from '../rooms.ts';
import {
  type AppContext,
  access,
  body,
  type Env,
  envAccess,
  groupAccess,
  type ProjectAccessRow,
} from './context.ts';

type Layer = 'instance' | 'group' | 'project';
const SETS = [
  ['production', true],
  ['nonProduction', false],
] as const;

/** 上级各层（不含 at）的输入，按生产 / 非生产选好那一套 */
const upperOf = (
  at: Layer,
  layers: { instance: LayerPolicy; group?: LayerPolicy; project?: LayerPolicy },
  production: boolean,
): PolicyInput => {
  const out: PolicyInput = {};
  if (at !== 'instance') out.instance = pickSet(layers.instance, production);
  if (at === 'project') out.group = pickSet(layers.group, production);
  return out;
};

const resolveAt = (
  at: Layer,
  layers: { instance: LayerPolicy; group?: LayerPolicy; project?: LayerPolicy },
  own: LayerPolicy,
  production: boolean,
): ResolvedPolicy =>
  resolvePolicy({ ...upperOf(at, layers, production), [at]: pickSet(own, production) }, production, at);

/**
 * 放宽时操作者要满足本层改动前生效的“谁能执行”：项目编辑者 / 项目管理员看操作者在这一层的身份（组层是组管理员，
 * 已经是这一层的管理员，一定满足），“仅限执行者”要求操作者是这一层范围的执行者（生产那一套只认实例管理员授予的）。
 */
const satisfies = (
  who: ExecPolicy,
  production: boolean,
  rc: RoleContext,
  scope: { groupId: string; projectId?: string },
  layerAdmin: boolean,
): boolean => {
  if (rc.instanceAdmin) return true;
  if (who === 'executor') return isExecutor(rc, scope, production);
  return layerAdmin;
};

const loosenNoteOf = (who: ExecPolicy) =>
  who === 'executor'
    ? '当前生效的是“仅限执行者”：放宽（任一项变宽、删掉审批环节）是特权操作，只有这一层范围的执行者或实例管理员可以做；收紧不受限制'
    : `放宽是特权操作：需要满足当前生效的“${whoLabel(who)}”`;

export const registerPolicy = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  /** 严格审计：在策略写入的同一个事务里，写不进去就整体回滚 */
  const auditPolicy = (
    tx: Db,
    c: Context<Env>,
    target: { kind: 'instance' | 'group' | 'project' | 'environment'; id: string | null; projectId?: string },
    data: Record<string, unknown>,
  ) =>
    auditIn(
      tx,
      c,
      {
        action: 'exec_policy.update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: target.kind,
        targetId: target.id,
        projectId: target.projectId ?? null,
        data: { layer: target.kind, ...data },
      },
      ctx.security,
    );

  /** 实例 / 组 / 项目层的视图 */
  const layerView = async (
    at: Layer,
    layers: { instance: LayerPolicy; group?: LayerPolicy; project?: LayerPolicy },
    own: LayerPolicy,
    canEdit: boolean,
    canLoosenOf: (who: ExecPolicy, production: boolean) => boolean,
  ): Promise<PolicyLayerView> => {
    const production = resolveAt(at, layers, own, true);
    const nonProduction = resolveAt(at, layers, own, false);
    const canLoosen = {
      production: canEdit && canLoosenOf(production.whoCanExecute.value, true),
      nonProduction: canEdit && canLoosenOf(nonProduction.whoCanExecute.value, false),
    };
    const blocked = !canLoosen.production
      ? production.whoCanExecute.value
      : !canLoosen.nonProduction
        ? nonProduction.whoCanExecute.value
        : null;
    return {
      layer: at,
      settings: own,
      resolved: { production, nonProduction },
      canEdit,
      canLoosen,
      loosenNote: canEdit && blocked ? loosenNoteOf(blocked) : null,
      names: await policyNames(db, [
        own.production,
        own.nonProduction,
        ...Object.values(layers).flatMap((l) => (l ? [l.production, l.nonProduction] : [])),
      ]),
    };
  };

  /** 在事务里读某一层和它的上级。groupId：组层是组本身，项目层是锁内读到的项目当前所属的组（由 authorize 给出） */
  const layersIn = async (tx: Db, at: Layer, scopeId: string, groupId: string | null) => {
    const instance = await loadLayer(tx, 'instance', '');
    const group =
      at === 'instance' ? undefined : await loadLayer(tx, 'group', at === 'group' ? scopeId : groupId!);
    const own =
      at === 'instance' ? instance : at === 'group' ? group! : await loadLayer(tx, 'project', scopeId);
    return { layers: { instance, ...(at === 'project' ? { group } : {}) }, own };
  };

  type CanLoosen = (who: ExecPolicy, production: boolean) => boolean;

  /**
   * 实例 / 组 / 项目层的写入（原子）：执行策略锁的事务里读当前值 → 校验（只能收紧、引用存在）
   * → 放宽要满足改动前的“谁能执行” → 写 → 严格审计。返回写入后的上级和本层（直接用来生成视图，不再读一次）。
   */
  const putLayer = async (
    c: Context<Env>,
    at: Layer,
    scopeId: string,
    /**
     * 锁内鉴权：重新读调用者的角色上下文（组成员关系、授权）和项目当前所属的组，再检查这一层的管理身份（不够就 403），
     * 返回放宽判断和锁内读到的组。不能用锁外读的：转组、改成员都可能在等锁期间发生
     */
    authorize: (tx: Db) => Promise<{ canLoosenOf: CanLoosen; groupId: string | null }>,
    projectId?: string,
  ) => {
    const next = await body(c, layerPolicyPutSchema);
    const after: LayerPolicy = {
      production: normalizeSettings(next.production),
      nonProduction: normalizeSettings(next.nonProduction),
    };
    return withPolicyLock(db, async (tx) => {
      const { canLoosenOf, groupId } = await authorize(tx);
      const { layers, own: before } = await layersIn(tx, at, scopeId, groupId);
      const loosened: Record<string, string[]> = {};
      for (const [key, production] of SETS) {
        const problems = validateLayer(upperOf(at, layers, production), after[key], production, at);
        if (problems.length)
          throw new HTTPException(422, {
            message: `${production ? '生产' : '非生产'}环境：${problems[0]!.message}`,
          });
        const b = resolveAt(at, layers, before, production);
        const fields = loosenedFields(b, resolveAt(at, layers, after, production));
        if (fields.length) {
          if (!canLoosenOf(b.whoCanExecute.value, production))
            throw new HTTPException(403, {
              message: `${production ? '生产' : '非生产'}环境：${loosenNoteOf(b.whoCanExecute.value)}`,
            });
          loosened[key] = fields;
        }
      }
      await assertApproversExist(tx, [after.production, after.nonProduction]);
      await saveLayer(tx, at, scopeId, after, c.get('user').id);
      await auditPolicy(
        tx,
        c,
        { kind: at, id: at === 'instance' ? null : scopeId, projectId },
        { before, after, loosened },
      );
      return { layers: at === 'instance' ? { instance: after } : layers, own: after, canLoosenOf };
    });
  };

  // ───── 实例层（/api/admin/* 已要求实例管理员，见 routes/index.ts） ─────

  app.get('/api/admin/exec-policy', async (c) => {
    const own = await loadLayer(db, 'instance', '');
    return c.json<PolicyLayerView>(await layerView('instance', { instance: own }, own, true, () => true));
  });

  app.put('/api/admin/exec-policy', async (c) => {
    const r = await putLayer(c, 'instance', '', async () => ({ canLoosenOf: () => true, groupId: null }));
    // P5b：策略变了，受影响范围里还没结束的执行申请重新检查（流程变严的会失效）
    ctx.requests.kick({ all: true });
    return c.json<PolicyLayerView>(await layerView('instance', r.layers, r.own, true, () => true));
  });

  // ───── 组层 ─────

  /** 放宽组层要满足的“谁能执行”：组管理员身份，或组 / 实例范围的执行者（GET 和锁内的 PUT 共用） */
  const groupCanLoosen =
    (rc: RoleContext, groupId: string, groupRole: GroupRole | null): CanLoosen =>
    (who, production) =>
      satisfies(who, production, rc, { groupId }, groupRole === 'admin');

  const groupLayers = async (c: Context<Env>, write: boolean) => {
    const g = write ? await groupAccess(c, ctx, 'group.set_policy') : await groupAccess(c, ctx, 'group.read');
    const user = c.get('user');
    const rc = await loadRoleContext(db, user);
    const canEdit = can(userActor(user), 'group.set_policy', { kind: 'group', groupRole: g.groupRole });
    const instance = await loadLayer(db, 'instance', '');
    const own = await loadLayer(db, 'group', g.id);
    return { g, instance, own, canEdit, canLoosenOf: groupCanLoosen(rc, g.id, g.groupRole) };
  };

  app.get('/api/groups/:slug/exec-policy', async (c) => {
    const { instance, own, canEdit, canLoosenOf } = await groupLayers(c, false);
    return c.json<PolicyLayerView>(await layerView('group', { instance }, own, canEdit, canLoosenOf));
  });

  app.put('/api/groups/:slug/exec-policy', async (c) => {
    // 锁外先挡一道（不是组管理员 403）；锁内按重新读到的组成员关系再判断一次
    const g = await groupAccess(c, ctx, 'group.set_policy');
    const user = c.get('user');
    const r = await putLayer(c, 'group', g.id, async (tx) => {
      const rc = await loadRoleContext(tx, user);
      const groupRole = rc.groups.get(g.id) ?? null;
      if (!can(userActor(user), 'group.set_policy', { kind: 'group', groupRole }))
        throw new HTTPException(403, { message: '需要组管理员' });
      return { groupId: g.id, canLoosenOf: groupCanLoosen(rc, g.id, groupRole) };
    });
    // P5b：策略变了，受影响范围里还没结束的执行申请重新检查（流程变严的会失效）
    ctx.requests.kick({ groupIds: [g.id] });
    return c.json<PolicyLayerView>(await layerView('group', r.layers, r.own, true, r.canLoosenOf));
  });

  // ───── 项目层 ─────

  /** 放宽项目层要满足的“谁能执行”：按调用者在这个项目里的角色和执行者身份（范围是项目当前所属的组） */
  const projectCanLoosen =
    (rc: RoleContext, groupId: string, pid: string, role: Role): CanLoosen =>
    (who, production) =>
      satisfies(
        who,
        production,
        rc,
        { groupId, projectId: pid },
        who === 'editor' ? role !== 'viewer' : role === 'admin',
      );

  /** GET 用：四层一次读出（视图要显示上级） */
  const projectLayers = async (a: ProjectAccessRow) => {
    const store = await loadPolicies(db, a);
    const instance = store.instance ?? { production: {}, nonProduction: {} };
    const group = store.group ?? { production: {}, nonProduction: {} };
    const own = store.project ?? { production: {}, nonProduction: {} };
    const canEdit = can(
      { kind: 'user', id: a.rc.userId, instanceAdmin: a.rc.instanceAdmin },
      'project.set_policy',
      { kind: 'project', role: a.role },
    );
    return { instance, group, own, canEdit, canLoosenOf: projectCanLoosen(a.rc, a.groupId, a.pid, a.role) };
  };

  app.get('/api/projects/:pid/exec-policy', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const { instance, group, own, canEdit, canLoosenOf } = await projectLayers(a);
    return c.json<PolicyLayerView>(
      await layerView('project', { instance, group }, own, canEdit, canLoosenOf),
    );
  });

  app.put('/api/projects/:pid/exec-policy', async (c) => {
    // 锁外先挡一道（看不见 404、不是项目管理员 403），不读策略；锁内重新读项目当前的组和调用者的角色再判断
    const a = await access(c, ctx, 'project.set_policy');
    const user = c.get('user');
    const r = await putLayer(
      c,
      'project',
      a.pid,
      async (tx) => {
        const now = await accessIn(tx, user, a.pid);
        if (!can(userActor(user), 'project.set_policy', { kind: 'project', role: now.role }))
          throw new HTTPException(403, { message: '没有权限' });
        return {
          groupId: now.project.groupId,
          canLoosenOf: projectCanLoosen(now.rc, now.project.groupId, a.pid, now.role),
        };
      },
      a.pid,
    );
    // P5b：策略变了，受影响范围里还没结束的执行申请重新检查（流程变严的会失效）
    ctx.requests.kick({ projectIds: [a.pid] });
    return c.json<PolicyLayerView>(await layerView('project', r.layers, r.own, true, r.canLoosenOf));
  });

  // ───── 环境层 ─────

  /**
   * 环境层的视图：store 由调用方给（GET 用 envAccess 读到的，PUT 用事务里写完的）。
   */
  const envView = async (
    actorUser: { id: string; role: string },
    a: { pid: string; groupId: string; role: Role; rc: RoleContext },
    env: EnvRow,
    store: PolicyStore,
  ): Promise<EnvPolicyView> => {
    const auth = envAuthOf(store, a.rc, { id: a.pid, groupId: a.groupId }, env);
    const actor = userActor(actorUser);
    const canEdit = can(actor, 'environment.manage', { kind: 'project', role: a.role });
    const canLoosen = canEdit && can(actor, 'environment.set_policy', envResource(env, a.role, auth));
    const settings = store.environments.get(env.id) ?? {};
    const upper = upperInput(store, env.production);
    return {
      production: env.production,
      settings,
      resolved: auth.resolved,
      canEdit,
      canLoosen,
      loosenNote: canEdit && !canLoosen ? deniedMessage('environment.set_policy', auth) : null,
      names: await policyNames(db, [
        settings,
        ...Object.values(upper).filter((s): s is PolicySettings => !!s),
      ]),
    };
  };

  app.get('/api/projects/:pid/environments/:eid/exec-policy', async (c) => {
    const a = await envAccess(c, ctx, 'environment.read');
    return c.json<EnvPolicyView>(await envView(c.get('user'), a, a.env, a.store));
  });

  /**
   * 环境层：整套设置。和 PATCH …/environments/:eid 共用 applyEnvPolicy（校验、放宽检测、固定、写入），
   * 在执行策略锁的事务里读、校验、写，审计同事务。写完直接用事务里的结果生成视图，不再跑一遍 envAccess。
   */
  app.put('/api/projects/:pid/environments/:eid/exec-policy', async (c) => {
    const a = await access(c, ctx, 'environment.read');
    const user = c.get('user');
    const actor = userActor(user);
    if (!can(actor, 'environment.manage', { kind: 'project', role: a.role }))
      throw new HTTPException(403, { message: '修改环境的执行策略需要项目管理员' });
    const b = await body(c, envPolicyPutSchema);
    const eid = c.req.param('eid')!;
    const r = await withPolicyLock(db, async (tx) => {
      // 项目当前的组、调用者的角色都在锁内重新读（applyEnvPolicy 里）；项目管理员的要求也按锁内的角色再检查一次
      const r = await applyEnvPolicy(tx, {
        pid: a.pid,
        eid,
        user,
        change: { settings: b.settings },
        write: true,
      });
      if (!can(actor, 'environment.manage', { kind: 'project', role: r.role }))
        throw new HTTPException(403, { message: '修改环境的执行策略需要项目管理员' });
      if (r.changed)
        await auditPolicy(
          tx,
          c,
          { kind: 'environment', id: r.env.id, projectId: a.pid },
          {
            name: r.env.name,
            production: r.env.production,
            before: { settings: r.ownBefore },
            after: { settings: r.ownAfter },
            loosened: r.loosened,
          },
        );
      return r;
    });
    const environments = new Map(r.store.environments);
    environments.set(r.env.id, r.ownAfter);
    // P5b：策略变了，受影响范围里还没结束的执行申请重新检查（流程变严的会失效）
    ctx.requests.kick({ envIds: [r.env.id] });
    return c.json<EnvPolicyView>(
      await envView(user, { pid: a.pid, groupId: r.project.groupId, role: r.role, rc: r.rc }, r.env, {
        ...r.store,
        environments,
      }),
    );
  });
};
