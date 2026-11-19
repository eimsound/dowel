// 权限判断：所有“谁能做什么”的规则集中在这里，路由只负责取出角色再调用 can()。
// 角色来源：实例管理员（一切权限）、项目生效角色（viewer / editor / admin）、组里的身份（组管理员 / 组成员）。
// 生效角色由 roles.ts 算出：实例管理员、组管理员、组默认权限、授权四项取最高，详见 02-consensus.md 11.2。
import type { ExecPolicy, GroupCreation, GroupRole, ProjectCreation, Role } from '@dowel/api';

/** 需要项目角色就能做的动作 */
export type ProjectAction =
  | 'project.read'
  | 'project.manage_grants'
  | 'project.transfer'
  | 'project.settings'
  | 'project.delete'
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
  | 'sync.connect'
  | 'sync.edit';

/**
 * 环境上的特权操作（02-consensus.md 11.3）：受环境的“谁能执行”档位约束（H6，P5 之前的过渡方案）。
 * 模型的编辑和发布不在其中。
 * - environment.execute / rollback / baseline：执行、回滚、写入基线；
 * - environment.resolve_drift：处理漂移（预留：“接受线上结构”还没做，先把动作和档位占住）；
 * - environment.change_connection：改连接串、影子库、是否允许同实例影子库；
 * - environment.unmark_production：取消“生产”标记；
 * - environment.set_policy：改执行档位本身；
 * - environment.delete：删除环境。
 */
export type EnvAction =
  | 'environment.execute'
  | 'environment.rollback'
  | 'environment.baseline'
  | 'environment.resolve_drift'
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
  | 'group.delete';

/** 实例级动作（instance.create_group 的规则依赖实例设置，在 can() 里单独判断） */
export type InstanceAction =
  | 'instance.manage_users'
  | 'instance.manage_settings'
  | 'instance.invite'
  | 'instance.manage_grants'
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
  /** 环境上设置的执行档位；null / 未给出表示用默认（非生产 editor，生产 admin） */
  execPolicy?: ExecPolicy | null;
  /**
   * 调用者是不是这个环境的“执行者”。P5 引入执行者授权之前一律为空（false）：
   * “仅限执行者”档位等同于只有实例管理员。P5 在这里接上授权查询即可，can() 的规则不用改。
   */
  isExecutor?: boolean;
}

/** 没有显式设置时的执行档位：非生产由项目编辑者执行，生产由项目管理员执行（小公司开箱即用） */
export const defaultExecPolicy = (production: boolean | undefined): ExecPolicy =>
  production === false ? 'editor' : 'admin';

export const effectiveExecPolicy = (r: Pick<Resource, 'production' | 'execPolicy'>): ExecPolicy =>
  r.execPolicy ?? defaultExecPolicy(r.production);

/** 这一档谁能执行：角色够不够（executor 档看 isExecutor，P5 之前恒为 false） */
const meetsPolicy = (r: Resource, policy: ExecPolicy): boolean => {
  if (policy === 'executor') return r.isExecutor === true && hasProjectRole(r.role, 'editor');
  return hasProjectRole(r.role, policy);
};

/**
 * 配置类特权操作：除了满足执行档位，还至少要项目管理员——它们原来就是管理员的权限（environment.manage），
 * 档位只会收紧、不会放宽（非生产环境档位是 editor，也不能让编辑者去改连接串或删环境）。
 */
const ENV_CONFIG_ACTIONS = new Set<EnvAction>([
  'environment.change_connection',
  'environment.unmark_production',
  'environment.set_policy',
  'environment.delete',
]);

export const ENV_ACTIONS: EnvAction[] = [
  'environment.execute',
  'environment.rollback',
  'environment.baseline',
  'environment.resolve_drift',
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
  'sync.connect': 'viewer',
  'sync.edit': 'editor',
};

/** 组级动作：默认需要组管理员；group.read 和 group.create_project 另有规则 */
export const GROUP_ADMIN_ACTIONS: GroupAction[] = [
  'group.manage',
  'group.manage_members',
  'group.manage_grants',
  'group.delete',
];

/** 实例级动作：实例管理员能做；instance.create_group 还要看实例设置 */
export const INSTANCE_ACTIONS: InstanceAction[] = [
  'instance.manage_users',
  'instance.manage_settings',
  'instance.invite',
  'instance.manage_grants',
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
    if (!meetsPolicy(resource, effectiveExecPolicy(resource))) return false;
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
  if (resource.kind === 'project' || resource.kind === 'environment')
    return hasProjectRole(resource.role, ACTION_MIN_ROLE[action as ProjectAction]);
  return false;
};
