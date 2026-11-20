// 权限判断：所有“谁能做什么”的规则集中在这里，路由只负责取出角色再调用 can()。
// 角色来源：实例管理员（一切权限）、项目生效角色（viewer / editor / admin）、组里的身份（组管理员 / 组成员）。
// 生效角色由 roles.ts 算出：实例管理员、组管理员、组默认权限、授权四项取最高，详见 02-consensus.md 11.2。
import {
  type ExecPolicy,
  type GroupCreation,
  type GroupRole,
  POLICY_DEFAULTS,
  type ProjectCreation,
  type Role,
} from '@dowel/api';

/** 需要项目角色就能做的动作 */
export type ProjectAction =
  | 'project.read'
  | 'project.manage_grants'
  | 'project.transfer'
  | 'project.settings'
  | 'project.delete'
  /** 项目层的执行策略（P5a）：项目管理员；放宽另外要满足项目层改动前的“谁能执行”（routes/policy.ts） */
  | 'project.set_policy'
  | 'version.publish'
  | 'version.edit'
  | 'version.verify'
  | 'migration.read'
  | 'ddl.read'
  | 'model.verify'
  | 'model.import'
  | 'environment.read'
  | 'environment.manage'
  | 'environment.pull'
  | 'environment.check_drift'
  /**
   * 提交执行申请（P5b）：项目编辑者以上，或者这个环境的执行者。不是特权操作（不碰目标库，只读结构做预演），
   * 也不要求满足“谁能执行”——申请本来就是给没有权限直接执行的人用的。
   */
  | 'environment.request'
  | 'sync.connect'
  | 'sync.edit';

/**
 * 环境上的特权操作（02-consensus.md 11.3）：受环境生效的执行策略里“谁能执行”约束（P5a：四层合并，见 policy.ts）。
 * 模型的编辑和发布不在其中。
 * - environment.execute / rollback / baseline：执行、回滚、写入基线；
 * - environment.mark：标记为已执行（ADR 0004）——不执行 SQL，把环境记为已到达链上某个版本，前提是线上结构等于它的模型；
 *   取代 P4b 预留的 resolve_drift。**CI 令牌不能标记**（P6 接入令牌时，令牌的 Actor 不能通过这个动作）；
 * - environment.change_connection：改连接串、影子库、是否允许同实例影子库；
 * - environment.unmark_production：取消“生产”标记；
 * - environment.set_policy：**放宽**环境层的执行策略（含去掉 / 换掉前置环境）；收紧只要项目管理员（routes/policy.ts）；
 * - environment.delete：删除环境。
 */
export type EnvAction =
  /** 给已有项目添加环境并接入这个库里已有的历史（配置类：至少项目管理员，且满足执行档位） */
  | 'environment.attach_history'
  | 'environment.execute'
  | 'environment.rollback'
  | 'environment.baseline'
  | 'environment.mark'
  | 'environment.change_connection'
  | 'environment.unmark_production'
  | 'environment.set_policy'
  | 'environment.delete';

/** 组级动作：组对所有人可见，管理动作需要组管理员 */
export type GroupAction =
  | 'group.read'
  | 'group.manage'
  | 'group.manage_members'
  | 'group.manage_grants'
  | 'group.create_project'
  /** 组层的执行策略（P5a）：组管理员；放宽另外要满足组层改动前的“谁能执行” */
  | 'group.set_policy'
  /** 组级 Webhook 的配置、投递记录和发送测试（P5b）：组管理员 */
  | 'group.manage_webhooks'
  | 'group.delete';

/** 实例级动作（instance.create_group 的规则依赖实例设置，在 can() 里单独判断） */
export type InstanceAction =
  /** 认领：把目标库里一个项目的“当前认领实例”换成本实例（之后原实例的执行被拒绝）；只有实例管理员 */
  | 'instance.claim_project'
  | 'instance.manage_users'
  | 'instance.manage_settings'
  | 'instance.invite'
  | 'instance.manage_grants'
  /** 实例层的执行策略（P5a） */
  | 'instance.manage_policy'
  /** 紧急执行（P5b）：绕过审批流程（不绕过漂移、完整性、前置环境等检查），必填原因；只有实例管理员 */
  | 'instance.emergency_execute'
  | 'instance.create_group'
  | 'instance.view_audit';

/** 当前服务端实际用到的动作；新增端点时先在这里加动作，再到规则表登记 */
export type Action = ProjectAction | EnvAction | GroupAction | InstanceAction;

/** 发起操作的主体：用户、CI 令牌或服务器自己（导入、派生数据刷新等） */
export interface Actor {
  kind: 'user' | 'token' | 'system';
  /** 用户 ID 或令牌 ID；系统操作为 null */
  id: string | null;
  /** 实例管理员：拥有一切权限 */
  instanceAdmin?: boolean;
}

/**
 * 操作对象。
 * - role：在项目里的生效角色（环境属于项目，用同一个角色）；不是成员时为 null；
 * - groupRole：在组里的身份；
 * - groupCreation / projectCreation：由调用方读出来的设置，can() 保持纯函数。
 */
export interface Resource {
  kind: 'instance' | 'group' | 'project' | 'environment';
  role?: Role | null;
  groupRole?: GroupRole | null;
  /** 实例设置：谁能建组 */
  groupCreation?: GroupCreation;
  /** 组的设置：谁能在本组建项目 */
  projectCreation?: ProjectCreation;
  /** 环境是否生产：决定没有显式设置执行档位时的默认档位 */
  production?: boolean;
  /**
   * 环境**生效的**“谁能执行”（四层合并之后，policy.ts 的 resolveEnv）；null / 未给出表示用默认（非生产 editor，生产 admin）。
   */
  execPolicy?: ExecPolicy | null;
  /**
   * 调用者是不是这个环境的“执行者”（P5a：执行者授权覆盖这个环境；“仅限执行者”的生产环境只认实例管理员授予的，
   * 见 policy.ts 的 isExecutor）。can() 保持纯函数，由调用方算好放进来。
   */
  isExecutor?: boolean;
}

/**
 * Resource 里没给生效档位时（调用方没算执行策略）用的档位：默认值只有一处来源，@dowel/api 的 POLICY_DEFAULTS；
 * 不知道是不是生产时按生产算（更严）。正常的路由都会先用 resolvePolicy 算好生效档位放进 execPolicy。
 */
const policyOf = (r: Resource): ExecPolicy =>
  r.execPolicy ?? POLICY_DEFAULTS(r.production !== false).whoCanExecute;

/**
 * 这一档谁能执行：
 * - 执行者在任何档位下都能执行（执行者本来就是为这个环境单独授权的；执行者授权自带项目的只读可见性，role 至少是 viewer）；
 * - 项目编辑者 / 项目管理员档位看项目角色；“仅限执行者”档位只有执行者（和实例管理员，can() 里先放行）。
 */
const meetsPolicy = (r: Resource, policy: ExecPolicy): boolean => {
  if (r.isExecutor === true && r.role != null) return true;
  if (policy === 'executor') return false;
  return hasProjectRole(r.role, policy);
};

/**
 * 配置类特权操作：除了满足执行档位，还至少要项目管理员——它们原来就是管理员的权限（environment.manage），
 * 档位只会收紧、不会放宽（非生产环境档位是 editor，也不能让编辑者去改连接串或删环境）。
 */
const ENV_CONFIG_ACTIONS = new Set<EnvAction>([
  'environment.attach_history',
  'environment.change_connection',
  'environment.unmark_production',
  'environment.set_policy',
  'environment.delete',
]);

export const ENV_ACTIONS: EnvAction[] = [
  'environment.attach_history',
  'environment.execute',
  'environment.rollback',
  'environment.baseline',
  'environment.mark',
  'environment.change_connection',
  'environment.unmark_production',
  'environment.set_policy',
  'environment.delete',
];
const ENV_ACTION_SET = new Set<string>(ENV_ACTIONS);
export const isEnvAction = (action: string): action is EnvAction => ENV_ACTION_SET.has(action);

/** 要求项目管理员才能做的配置类特权操作（测试、界面提示用） */
export const isEnvConfigAction = (action: EnvAction): boolean => ENV_CONFIG_ACTIONS.has(action);

/** 由登录用户构造 actor：角色直接来自 users.role */
export const userActor = (user: { id: string; role: string }): Actor => ({
  kind: 'user',
  id: user.id,
  instanceAdmin: user.role === 'admin',
});

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

/** 每个项目动作需要的最低项目角色（02-consensus.md 11.2：项目角色只管模型） */
export const ACTION_MIN_ROLE: Record<ProjectAction, Role> = {
  'project.read': 'viewer',
  'project.manage_grants': 'admin',
  'project.transfer': 'admin',
  'project.settings': 'admin',
  'project.delete': 'admin',
  'project.set_policy': 'admin',
  'version.publish': 'editor',
  // 编辑冻结脚本、重新验证：沿用发布的权限（编辑者）
  'version.edit': 'editor',
  'version.verify': 'editor',
  'migration.read': 'viewer',
  'ddl.read': 'viewer',
  'model.verify': 'viewer',
  'model.import': 'editor',
  'environment.read': 'viewer',
  'environment.manage': 'admin',
  'environment.pull': 'editor',
  // 手动检查漂移：只读目标库的结构，但要连生产库，编辑者以上
  'environment.check_drift': 'editor',
  'environment.request': 'editor',
  'sync.connect': 'viewer',
  'sync.edit': 'editor',
};

/** 组级动作：默认需要组管理员；group.read 和 group.create_project 另有规则 */
export const GROUP_ADMIN_ACTIONS: GroupAction[] = [
  'group.manage',
  'group.manage_members',
  'group.manage_grants',
  'group.set_policy',
  'group.manage_webhooks',
  'group.delete',
];

/** 实例级动作：实例管理员能做；instance.create_group 还要看实例设置 */
export const INSTANCE_ACTIONS: InstanceAction[] = [
  'instance.claim_project',
  'instance.manage_users',
  'instance.manage_settings',
  'instance.invite',
  'instance.manage_grants',
  'instance.manage_policy',
  'instance.emergency_execute',
  'instance.create_group',
  'instance.view_audit',
];

export const INSTANCE_ACTION_SET = new Set<string>(INSTANCE_ACTIONS);
export const GROUP_ACTION_SET = new Set<string>([
  'group.read',
  'group.create_project',
  ...GROUP_ADMIN_ACTIONS,
]);

const isInstanceAction = (action: Action): action is InstanceAction =>
  INSTANCE_ACTION_SET.has(action as InstanceAction);

const isGroupAction = (action: Action): action is GroupAction => GROUP_ACTION_SET.has(action as GroupAction);

const hasProjectRole = (role: Role | null | undefined, need: Role): boolean =>
  role != null && ROLE_RANK[role] >= ROLE_RANK[need];

/**
 * 纯函数：actor 能否对 resource 执行 action。
 * - 系统身份直接允许（服务器自己的导入、派生刷新）；
 * - 实例管理员拥有一切权限，包括所有项目动作和组的管理动作；
 * - 环境上的特权操作（EnvAction）看环境的执行档位，见上面；
 * - 建组看实例设置 groupCreation（all 时所有登录用户都能建）；
 * - 组级动作看组里的身份，建项目还要看组的 projectCreation；
 * - 其余动作按项目生效角色判断。
 */
export const can = (actor: Actor, action: Action, resource: Resource): boolean => {
  if (actor.kind === 'system') return true;
  if (actor.instanceAdmin) return true;
  // 建组是实例级动作，但规则取决于实例设置，由调用方把设置放进 resource
  if (action === 'instance.create_group')
    return resource.kind === 'instance' && resource.groupCreation === 'all';
  if (isInstanceAction(action)) return false;
  if (isEnvAction(action)) {
    if (resource.kind !== 'environment') return false;
    if (!meetsPolicy(resource, policyOf(resource))) return false;
    return !ENV_CONFIG_ACTIONS.has(action) || hasProjectRole(resource.role, 'admin');
  }
  if (isGroupAction(action)) {
    if (resource.kind !== 'group') return false;
    // 组本身对所有人可见
    if (action === 'group.read') return true;
    const admin = resource.groupRole === 'admin';
    if (action === 'group.create_project')
      return admin || (resource.groupRole === 'member' && resource.projectCreation === 'members');
    return admin;
  }
  // 手动检查漂移只读目标库的结构；执行者本来就被信任去连这个库（他能执行），所以也能检查
  // 执行者也能提交执行申请（多环节流程里执行者自己执行也要先申请）
  if (
    (action === 'environment.check_drift' || action === 'environment.request') &&
    resource.kind === 'environment' &&
    resource.isExecutor === true
  )
    return resource.role != null;
  if (resource.kind === 'project' || resource.kind === 'environment')
    return hasProjectRole(resource.role, ACTION_MIN_ROLE[action as ProjectAction]);
  return false;
};
