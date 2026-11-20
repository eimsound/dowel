// 环境层执行策略的**唯一**写入路径（P5a 审查后）：PUT …/exec-policy（整套设置）和
// PATCH …/environments/:eid（只改“谁能执行”、改生产标记）都调用 applyEnvPolicy，校验、放宽检测、固定、写入是同一套。
//
// 必须在 withPolicyLock 的事务里调用（tx）：环境行、四层配置都在事务里重新读，读、校验、写之间不会插进别的写入。
//
// 规则：
// 1. 以**改动后的生产标记**对应的上级为准校验：这次明确改的字段不能比新下限宽（422）；
// 2. 这次没改的字段，如果因为生产标记变了（换了一套上级）而变宽，把原来的生效值固定进环境层（pinLoosened）；
// 3. 这次明确改的字段变宽、审批流程不再包含原流程 = 放宽，是特权操作：
//    要满足改动**前**生效的执行策略（environment.set_policy）；
// 4. 审批人范围里引用的组 / 用户必须存在。
import {
  type ExecPolicy,
  loosenedFields,
  normalizeSettings,
  type PolicyField,
  type PolicySettings,
  pinLoosened,
  resolvePolicy,
  SCALAR_FIELDS,
  validateLayer,
} from '@dowel/api';
import type { Db } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';
import { can, userActor } from './authz.ts';
import { type EnvRow, envResource } from './envs.ts';
import {
  accessIn,
  assertApproversExist,
  deniedMessage,
  type EnvAuth,
  envAuthOf,
  loadPolicies,
  type PolicyStore,
  saveLayer,
  upperInput,
} from './policy.ts';
import type { ProjectRow, RoleContext } from './roles.ts';
import type { Role } from './rooms.ts';

export interface EnvPolicyChange {
  /** 整套替换环境层的设置（PUT） */
  settings?: PolicySettings;
  /** 只改“谁能执行”（PATCH 的 execPolicy）；null = 改回继承 */
  whoCanExecute?: ExecPolicy | null;
  /** 生产标记改成什么（PATCH）；undefined = 不改。生产标记这一列由调用方自己写 */
  production?: boolean;
}

export interface EnvPolicyResult {
  /** 事务里读到的项目（当前所属的组）、调用者的角色上下文和项目角色 */
  project: ProjectRow;
  rc: RoleContext;
  role: Role;
  /** 事务里读到的环境行（改动前） */
  env: EnvRow;
  /** 事务里读到的四层配置（改动前） */
  store: PolicyStore;
  /** 改动前的鉴权输入（调用方用它检查别的特权操作，例如取消生产标记、改连接串） */
  authBefore: EnvAuth;
  ownBefore: PolicySettings;
  ownAfter: PolicySettings;
  /** 放宽了哪些；非空时已经检查过 environment.set_policy */
  loosened: string[];
  /** 因为换了一套上级而被固定进环境层的字段 */
  pinned: PolicyField[];
  /** 环境层的设置有没有变 */
  changed: boolean;
}

const same = (a: PolicySettings, b: PolicySettings) =>
  JSON.stringify(normalizeSettings(a)) === JSON.stringify(normalizeSettings(b));

export const applyEnvPolicy = async (
  tx: Db,
  input: {
    pid: string;
    eid: string;
    user: { id: string; role: string };
    change: EnvPolicyChange;
    /** false：只校验和检查权限，不写（PATCH 在连外部库之前先预检一次） */
    write: boolean;
  },
): Promise<EnvPolicyResult> => {
  const { eid, change } = input;
  // 项目当前的组、调用者的角色上下文和项目角色都在事务里重新读（转组也在同一把锁里，不会交错）
  const { project, rc, role } = await accessIn(tx, input.user, input.pid);
  const actor = userActor(input.user);
  const [env] = await tx.query<EnvRow>('select * from environments where id = $1 and project_id = $2', [
    eid,
    project.id,
  ]);
  if (!env) throw new HTTPException(404, { message: '环境不存在' });
  const store = await loadPolicies(tx, project);
  const authBefore = envAuthOf(store, rc, project, env);
  const productionBefore = env.production;
  const productionAfter = change.production ?? productionBefore;
  const ownBefore = store.environments.get(env.id) ?? {};

  // 这次请求要的环境层设置，以及明确改了哪些字段
  let requested: PolicySettings = ownBefore;
  if (change.settings !== undefined) requested = normalizeSettings(change.settings);
  else if (change.whoCanExecute !== undefined && change.whoCanExecute !== (ownBefore.whoCanExecute ?? null)) {
    requested = { ...ownBefore };
    if (change.whoCanExecute === null) delete requested.whoCanExecute;
    else requested.whoCanExecute = change.whoCanExecute;
  }
  const explicit = new Set<PolicyField>();
  for (const f of SCALAR_FIELDS) if (requested[f] !== ownBefore[f]) explicit.add(f);
  if (JSON.stringify(requested.approval ?? []) !== JSON.stringify(ownBefore.approval ?? []))
    explicit.add('approval');

  // 1. 明确改的字段按改动后的上级校验（没改的旧值即使已经比新下限宽也不拦——合并时上级会盖住它，下面还会固定）
  const upperAfter = upperInput(store, productionAfter);
  const problems = validateLayer(upperAfter, requested, productionAfter, 'environment').filter((p) =>
    explicit.has(p.field),
  );
  if (problems.length) throw new HTTPException(422, { message: problems[0]!.message });
  if (explicit.has('approval')) await assertApproversExist(tx, [requested]);

  // 2. 没改的字段：换了一套上级而变宽的，固定成原来的生效值
  const before = resolvePolicy(
    { ...upperInput(store, productionBefore), environment: ownBefore },
    productionBefore,
  );
  const { settings: ownAfter, pinned } = pinLoosened(
    before,
    upperAfter,
    requested,
    productionAfter,
    explicit,
  );

  // 3. 放宽：明确改的字段变宽、审批流程不再包含原流程
  const after = resolvePolicy({ ...upperAfter, environment: ownAfter }, productionAfter);
  const loosened: string[] = loosenedFields(before, after);
  if (loosened.length && !can(actor, 'environment.set_policy', envResource(env, role, authBefore)))
    throw new HTTPException(403, { message: deniedMessage('environment.set_policy', authBefore) });

  const changed = !same(ownAfter, ownBefore);
  if (input.write && changed) await saveLayer(tx, 'environment', env.id, ownAfter, input.user.id);
  return {
    project,
    rc,
    role,
    env,
    store,
    authBefore,
    ownBefore,
    ownAfter: normalizeSettings(ownAfter),
    loosened,
    pinned,
    changed,
  };
};

/**
 * 项目转组：组层换成目标组的，项目里每个环境用新的上级重新合并；变宽的字段固定成原来的生效值写进环境层
 * （和改生产标记同一条规则，转组不能悄悄放宽）。必须在 withPolicyLock 的事务里、改 projects.group_id 之前调用。
 * 返回每个被固定了字段的环境（审计用）。
 */
export const pinForTransfer = async (
  tx: Db,
  project: { id: string; groupId: string },
  targetGroupId: string,
  userId: string,
): Promise<{ environment: string; name: string; pinned: PolicyField[] }[]> => {
  // project.groupId 是调用方在同一个锁内事务里读到的当前组（转组路由已确认它没被并发的转组改掉）
  const store = await loadPolicies(tx, project);
  const next = await loadPolicies(tx, { id: project.id, groupId: targetGroupId });
  const envs = await tx.query<{ id: string; name: string; production: boolean }>(
    'select id, name, production from environments where project_id = $1 order by created_at',
    [project.id],
  );
  const out: { environment: string; name: string; pinned: PolicyField[] }[] = [];
  for (const e of envs) {
    const own = store.environments.get(e.id) ?? {};
    const before = resolvePolicy({ ...upperInput(store, e.production), environment: own }, e.production);
    const { settings, pinned } = pinLoosened(before, upperInput(next, e.production), own, e.production);
    if (!pinned.length) continue;
    await saveLayer(tx, 'environment', e.id, settings, userId);
    out.push({ environment: e.id, name: e.name, pinned });
  }
  return out;
};
