// 前后端共享的接口契约：请求体 schema 和服务端响应类型。
// 只依赖 zod；服务端用这些 schema 校验请求、给响应标注类型，前端从类型里取形状。
import { z } from 'zod';

import {
  execPolicySchema,
  type LayerPolicy,
  layerPolicySchema,
  type PolicySettings,
  policySettingsSchema,
  type ResolvedPolicy,
} from './policy.ts';

export * from './policy.ts';
export * from './requests.ts';
export * from './sections.ts';
export * from './tokens.ts';
export * from './webhooks.ts';

// 项目角色：查看者 / 编辑者 / 项目管理员（GLOSSARY：项目角色）。旧的 owner 在迁移里映射成 admin。
export const roleSchema = z.enum(['viewer', 'editor', 'admin']);
export type Role = z.infer<typeof roleSchema>;

/** 默认权限：组成员自动拥有的项目角色，none 表示没有 */
export const defaultRoleSchema = z.enum(['none', 'viewer', 'editor', 'admin']);
export type DefaultRole = z.infer<typeof defaultRoleSchema>;

/** 组里的身份：组管理员 / 组成员 */
export const groupRoleSchema = z.enum(['admin', 'member']);
export type GroupRole = z.infer<typeof groupRoleSchema>;

/** 组的项目由谁创建：所有组成员 / 只有组管理员 */
export const projectCreationSchema = z.enum(['members', 'admins']);
export type ProjectCreation = z.infer<typeof projectCreationSchema>;

// ───── 账户与登录 ─────

/**
 * 用户名：小写字母、数字、`-`，1～39 位，不能以 `-` 开头或结尾（GLOSSARY 与 02-consensus 11.1）。
 * 库里只存小写，所以**格式校验之前**先去掉首尾空白并转成小写：输入 `ZhangSan` 得到 `zhangsan`，
 * 而不是报“只能用小写字母”。
 */
export const usernameSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z
    .string()
    .min(1, '用户名不能为空')
    .max(39, '用户名最多 39 位')
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, '用户名只能用小写字母、数字和 -，且不能以 - 开头或结尾'),
);

export const displayNameSchema = z.string().trim().min(1, '名字不能为空').max(100, '名字最多 100 个字符');

export const passwordSchema = z.string().min(8, '密码至少 8 位').max(200, '密码最多 200 个字符');

/** 邮箱选填、不唯一、不验证，只作为资料里的一个字段 */
export const emailFieldSchema = z.string().trim().max(200, '邮箱最多 200 个字符').nullable();

export const instanceRoleSchema = z.enum(['admin', 'member']);
export type InstanceRole = z.infer<typeof instanceRoleSchema>;

export const userStatusSchema = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof userStatusSchema>;

/** 登录用用户名 + 密码；不在登录接口上校验用户名格式，免得泄露规则 */
export const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});
export type Login = z.infer<typeof loginSchema>;

export const meSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: instanceRoleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  /** 是否已经有密码：纯 OIDC 用户第一次设置密码时不需要旧密码 */
  hasPassword: z.boolean(),
  /** 是否必须在登录后修改密码（首次随机密码 / 管理员创建或重置的临时密码） */
  mustChangePassword: z.boolean(),
});
export type Me = z.infer<typeof meSchema>;

// ───── 实例信息与设置 ─────

/** 登录页需要的信息；不需要登录就能读 */
export const instanceInfoSchema = z.object({
  name: z.string(),
  /** 实际是否可用（设置关闭但设了 DOWEL_ALLOW_PASSWORD_LOGIN=1 时仍然是 true） */
  passwordLogin: z.boolean(),
  /** 启用的 OIDC 提供方（登录页显示“使用 XX 登录”） */
  providers: z.array(z.object({ slug: z.string(), name: z.string() })),
});
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;

export const groupCreationSchema = z.enum(['all', 'admin']);
export type GroupCreation = z.infer<typeof groupCreationSchema>;

export const instanceSettingsSchema = z.object({
  name: z.string(),
  groupCreation: groupCreationSchema,
  passwordLogin: z.boolean(),
  /**
   * 服务端可以替用户连接哪些地址（CIDR 或主机名）。空数组表示不限制。
   * 服务端会主动去连用户给的数据库地址，所以这是防止 SSRF 的开关。
   */
  connectionAllowlist: z.array(z.string()),
  /**
   * 组级 Webhook 额外允许发往哪些地址（CIDR 或主机名）。和 connectionAllowlist 语义相反：
   * Webhook 默认只能发往公网地址（拒绝回环、私有、链路本地等），这里列出的内网地址额外放行。
   */
  webhookAllowlist: z.array(z.string()),
  /** 实例的唯一标识：首次启动时生成，之后不变，只读（写进目标库的历史里，用来识别由哪个实例执行） */
  instanceId: z.string(),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

export const instanceSettingsPatchSchema = z.object({
  name: z.string().trim().min(1, '实例名称不能为空').max(100).optional(),
  groupCreation: groupCreationSchema.optional(),
  passwordLogin: z.boolean().optional(),
  connectionAllowlist: z.array(z.string().trim().max(200)).max(200).optional(),
  webhookAllowlist: z.array(z.string().trim().max(200)).max(200).optional(),
});
export type InstanceSettingsPatch = z.infer<typeof instanceSettingsPatchSchema>;

// ───── 用户管理与邀请（只有实例管理员） ─────

export const adminUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: instanceRoleSchema,
  status: userStatusSchema,
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  mustChangePassword: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const adminUserCreateSchema = z.object({
  username: usernameSchema,
  name: displayNameSchema,
  email: emailFieldSchema.optional(),
  password: passwordSchema.optional(),
  role: instanceRoleSchema.optional(),
});
export type AdminUserCreate = z.infer<typeof adminUserCreateSchema>;

export const adminUserPatchSchema = z.object({
  name: displayNameSchema.optional(),
  role: instanceRoleSchema.optional(),
  status: userStatusSchema.optional(),
});
export type AdminUserPatch = z.infer<typeof adminUserPatchSchema>;

export const inviteCreateSchema = z.object({
  /** 有效期天数，默认 7 天 */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  /** 接受邀请后加入的组（组已经被删掉时跳过） */
  groupIds: z.array(z.string()).max(100).optional(),
});
export type InviteCreate = z.infer<typeof inviteCreateSchema>;

export const inviteCreatedSchema = z.object({
  id: z.string(),
  token: z.string(),
  url: z.string(),
  expiresAt: z.string(),
});
export type InviteCreated = z.infer<typeof inviteCreatedSchema>;

export const inviteListItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  createdBy: z.string().nullable(),
  usedBy: z.string().nullable(),
  usedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  state: z.enum(['ok', 'used', 'revoked', 'expired']),
});
export type InviteListItem = z.infer<typeof inviteListItemSchema>;

export const inviteInfoSchema = z.object({
  valid: z.boolean(),
  state: z.enum(['ok', 'used', 'revoked', 'expired', 'missing']),
  instanceName: z.string(),
  expiresAt: z.string().nullable(),
});
export type InviteInfo = z.infer<typeof inviteInfoSchema>;

export const inviteAcceptSchema = z.object({
  username: usernameSchema,
  name: displayNameSchema,
  password: passwordSchema,
  email: emailFieldSchema.optional(),
});
export type InviteAccept = z.infer<typeof inviteAcceptSchema>;

export const resetLinkSchema = z.object({ url: z.string(), token: z.string(), expiresAt: z.string() });
export type ResetLink = z.infer<typeof resetLinkSchema>;

export const resetPasswordSchema = z.object({ password: passwordSchema });
export type ResetPassword = z.infer<typeof resetPasswordSchema>;

export const adminResetPasswordSchema = z.object({
  password: z.preprocess((v) => (v === '' ? undefined : v), passwordSchema.optional()),
});
export type AdminResetPassword = z.infer<typeof adminResetPasswordSchema>;

export const adminResetPasswordResultSchema = z.object({
  password: z.string(),
  mustChangePassword: z.literal(true),
});
export type AdminResetPasswordResult = z.infer<typeof adminResetPasswordResultSchema>;

// ───── 个人设置 ─────

export const mePatchSchema = z.object({
  username: usernameSchema.optional(),
  name: displayNameSchema.optional(),
  email: emailFieldSchema.optional(),
});
export type MePatch = z.infer<typeof mePatchSchema>;

export const passwordChangeSchema = z.object({
  /** 已经有密码时必填；纯 OIDC 用户第一次设置密码时不需要 */
  oldPassword: z.string().min(1, '请输入旧密码').optional(),
  newPassword: passwordSchema,
});
export type PasswordChange = z.infer<typeof passwordChangeSchema>;

export const sessionInfoSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

// ───── 组 ─────

/** 组的 slug 与用户名规则相同（小写、数字、-，1～39 位），全实例唯一 */
export const slugSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z
    .string()
    .min(1, '标识不能为空')
    .max(39, '标识最多 39 位')
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, '标识只能用小写字母、数字和 -，且不能以 - 开头或结尾'),
);

export const groupCreateSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1, '组名不能为空').max(100, '组名最多 100 个字符'),
  description: z.string().trim().max(1000).default(''),
  defaultRole: defaultRoleSchema.optional(),
  projectCreation: projectCreationSchema.optional(),
});
export type GroupCreate = z.infer<typeof groupCreateSchema>;

export const groupPatchSchema = z.object({
  name: z.string().trim().min(1, '组名不能为空').max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  defaultRole: defaultRoleSchema.optional(),
  projectCreation: projectCreationSchema.optional(),
});
export type GroupPatch = z.infer<typeof groupPatchSchema>;

export const groupInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  defaultRole: defaultRoleSchema,
  projectCreation: projectCreationSchema,
  createdAt: z.string(),
  /** 调用者在这个组里的身份；不是成员时为空 */
  role: groupRoleSchema.nullable(),
  memberCount: z.number(),
  projectCount: z.number(),
});
export type GroupInfo = z.infer<typeof groupInfoSchema>;

export const groupListSchema = z.object({
  groups: z.array(groupInfoSchema),
  /** 实例设置允许调用者建组（实例管理员始终可以） */
  canCreate: z.boolean(),
});
export type GroupList = z.infer<typeof groupListSchema>;

export const groupMemberSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  role: groupRoleSchema,
});
export type GroupMember = z.infer<typeof groupMemberSchema>;

export const groupMemberAddSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  role: groupRoleSchema.default('member'),
});
export type GroupMemberAdd = z.infer<typeof groupMemberAddSchema>;

export const groupMemberPatchSchema = z.object({ role: groupRoleSchema });
export type GroupMemberPatch = z.infer<typeof groupMemberPatchSchema>;

// ───── 项目 ─────

export const dialectSchema = z.enum(['pg', 'sqlite', 'mysql', 'mssql']);
export type Dialect = z.infer<typeof dialectSchema>;

/** schema 范围：导入、拉取、规范化只看这些 schema；空表示全部（dowel 永远排除） */
export const schemaScopeSchema = z.array(z.string().trim().min(1).max(128)).max(200);

/** 建项目必须指定组；slug 不给时由名字生成 */
export const projectCreateSchema = z.object({
  name: z.string().trim().min(1, '项目名不能为空').max(100),
  groupId: z.string().min(1, '请选择组'),
  slug: slugSchema.optional(),
  dialect: dialectSchema.default('pg'),
  /** 初始的 schema 范围（可空，空表示全部） */
  schemas: schemaScopeSchema.nullable().optional(),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

/** 项目的组信息（列表和详情里都带上，方便拼 /project/:owner/:project） */
export const projectGroupSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type ProjectGroup = z.infer<typeof projectGroupSchema>;

export const projectListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  dialect: dialectSchema,
  role: roleSchema,
  createdAt: z.string(),
  group: projectGroupSchema,
});
export type ProjectListItem = z.infer<typeof projectListItemSchema>;

export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  dialect: dialectSchema,
  role: roleSchema,
  branch: z.string(),
  group: projectGroupSchema,
  /** 项目自己的默认权限；null 表示沿用组的默认权限 */
  defaultRole: defaultRoleSchema.nullable(),
  groupDefaultRole: defaultRoleSchema,
  /** 调用者在这个项目的组里的身份；设置项目默认权限需要组管理员 */
  groupRole: groupRoleSchema.nullable(),
  /** schema 范围：null 表示全部（dowel 永远排除） */
  schemas: schemaScopeSchema.nullable(),
  /** 项目目标兼容的最低 PostgreSQL 大版本（所有已探测版本环境的最小值；尚无环境或均未探测为 null） */
  targetPgMajor: z.number().int().nullable(),
  /** 项目下所有环境已记录的 PostgreSQL 大版本列表（去重升序） */
  envPgMajors: z.array(z.number().int()),
  /** 当前用户能不能查看项目设置里的 CI 令牌列表（项目管理员或满足“谁能创建令牌”规则） */
  canListTokens: z.boolean().optional(),
});
export type ProjectInfo = z.infer<typeof projectInfoSchema>;

export const projectCreatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  dialect: dialectSchema,
  role: roleSchema,
  group: projectGroupSchema,
});
export type ProjectCreated = z.infer<typeof projectCreatedSchema>;

export const projectPatchSchema = z.object({
  name: z.string().trim().min(1, '项目名不能为空').max(100).optional(),
  slug: slugSchema.optional(),
  /** null 表示沿用组的默认权限（接口里要能显式传 null） */
  defaultRole: defaultRoleSchema.nullable().optional(),
  /** null 表示全部 schema（dowel 永远排除） */
  schemas: schemaScopeSchema.nullable().optional(),
});
export type ProjectPatch = z.infer<typeof projectPatchSchema>;

export const projectTransferSchema = z.object({ groupId: z.string().min(1, '请选择目标组') });
export type ProjectTransfer = z.infer<typeof projectTransferSchema>;

/** 删除项目：必须原样输入项目标识（slug），避免误删 */
export const projectDeleteSchema = z.object({ confirm: z.string().min(1, '请输入项目标识') });
export type ProjectDelete = z.infer<typeof projectDeleteSchema>;

/** 按 /project/:owner/:project 解析；走的是旧路径时 redirected 为 true，前端据此替换地址 */
export const resolvedProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  owner: z.string(),
  groupName: z.string(),
  redirected: z.boolean(),
});
export type ResolvedProject = z.infer<typeof resolvedProjectSchema>;

// ───── 授权 ─────

/** 授权对象：用户或组 */
export const grantSubjectKindSchema = z.enum(['user', 'group']);
export type GrantSubjectKind = z.infer<typeof grantSubjectKindSchema>;

/**
 * 授权范围：实例 / 组的全部项目 / 项目 / 环境。环境范围只用于“执行者”（项目角色只管模型，不按环境授）。
 */
export const grantScopeKindSchema = z.enum(['instance', 'group', 'project', 'environment']);
export type GrantScopeKind = z.infer<typeof grantScopeKindSchema>;

/**
 * 授权的角色：项目角色（查看者 / 编辑者 / 项目管理员），或“执行者”（P5a，GLOSSARY：执行者）。
 * 执行者能在授权范围内的环境上做特权操作，并且能只读查看这些项目；**不**因此获得模型的编辑权限。
 * 同一个对象在同一个范围上可以同时有一个项目角色和一个执行者授权。
 */
export const grantRoleSchema = z.enum(['viewer', 'editor', 'admin', 'executor']);
export type GrantRole = z.infer<typeof grantRoleSchema>;

export const grantCreateSchema = z.object({
  subjectKind: grantSubjectKindSchema,
  subjectId: z.string().min(1),
  role: grantRoleSchema,
  /** 只用于项目级的执行者授权：只授予这个环境（不填 = 整个项目） */
  environmentId: z.string().min(1).optional(),
});
export type GrantCreate = z.infer<typeof grantCreateSchema>;

/** 只能在项目角色之间改；执行者授权不能改成项目角色（反之亦然），删掉再授 */
export const grantPatchSchema = z.object({ role: roleSchema });
export type GrantPatch = z.infer<typeof grantPatchSchema>;

export const grantSubjectSchema = z.object({
  kind: grantSubjectKindSchema,
  id: z.string(),
  /** 用户是显示名，组是组名 */
  name: z.string(),
  /** 用户是用户名，组是 slug */
  slug: z.string(),
});
export type GrantSubject = z.infer<typeof grantSubjectSchema>;

export const grantInfoSchema = z.object({
  id: z.string(),
  subject: grantSubjectSchema,
  role: grantRoleSchema,
  scopeKind: grantScopeKindSchema,
  scopeId: z.string(),
  /** 环境范围的授权：环境名 */
  environmentName: z.string().nullable().optional(),
  /**
   * 授权时授予者是不是实例管理员。执行策略为“仅限执行者”的生产环境上，只有实例管理员授予的执行者才有效
   * （02-consensus.md 11.2 的例外），所以这个事实在授权时记下来，之后不随授予者的身份变化。
   */
  byInstanceAdmin: z.boolean(),
  createdAt: z.string(),
});
export type GrantInfo = z.infer<typeof grantInfoSchema>;

/** 通过组默认权限拿到角色的成员（只读，界面上单独列出来） */
export const defaultAccessSchema = z.object({
  userId: z.string(),
  username: z.string(),
  name: z.string(),
  /** none 表示是组成员但没有默认权限 */
  role: defaultRoleSchema,
  groupAdmin: z.boolean(),
});
export type DefaultAccess = z.infer<typeof defaultAccessSchema>;

/** 项目的成员与授权：直接授权 + 来自组默认权限的成员 */
export const projectAccessSchema = z.object({
  grants: z.array(grantInfoSchema),
  defaultMembers: z.array(defaultAccessSchema),
});
export type ProjectAccess = z.infer<typeof projectAccessSchema>;

// ───── 用户与组的选择器 ─────

export const directoryEntrySchema = z.object({ id: z.string(), name: z.string(), slug: z.string() });
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;

export const directorySchema = z.object({
  users: z.array(directoryEntrySchema),
  groups: z.array(directoryEntrySchema),
});
export type Directory = z.infer<typeof directorySchema>;

// ───── 版本、迁移与验证 ─────

export const versionCreateSchema = z.object({ name: z.string().min(1).max(200) });
export type VersionCreate = z.infer<typeof versionCreateSchema>;

/** 冻结迁移里的一步：transactional=false 表示这一步不能放进事务（例如 CREATE INDEX CONCURRENTLY） */
export const scriptStepSchema = z.object({ sql: z.string(), transactional: z.boolean() });
export type ScriptStepInfo = z.infer<typeof scriptStepSchema>;

export const versionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 房间操作序号（发布时工作副本的 seq），不是版本号 */
  seq: z.number(),
  /** 版本在链上的序号：v0 基线是 0，之后 1、2…，项目内唯一 */
  number: z.number(),
  /** 链上的上一个版本；第一个版本为空 */
  parentId: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  /** 在影子库里闭环验证通过的时间；null 表示未验证（没有影子库、或脚本被人工改过） */
  verifiedAt: z.string().nullable(),
  /** 冻结的脚本被人工改过 */
  edited: z.boolean(),
  /** 链上最新的版本：只有它的脚本可以编辑 */
  latest: z.boolean(),
  /**
   * 接手时从目标库的 dowel 历史恢复出来的时间（不是在本实例发布的）；null 表示本实例发布的。
   * 恢复的版本一律是“未验证”（见 05-implementation.md P4c）：要执行或回滚它需要先在影子库里重新验证。
   */
  restoredAt: z.string().nullable(),
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;

/** 项目所有已发布版本中出现过的表 ID 集合（用于锁定已发布表的不可变分区策略） */
export const publishedTablesSchema = z.object({
  tableIds: z.array(z.string()),
});
export type PublishedTables = z.infer<typeof publishedTablesSchema>;

export const versionCreatedSchema = z.object({
  id: z.string(),
  name: z.string(),
  seq: z.number(),
  number: z.number(),
  /** 风险分析没有完成时的原因，只存原因本身（例如“执行超时…”），“风险分析没有完成”这个前缀由界面的标题 / i18n 模板提供；不影响 ok，但界面要如实显示，不能当成“没有风险” */
  riskError: z.string().nullable(),
  /** 是否已在影子库里验证通过；没有影子库时发布成功但未验证 */
  verified: z.boolean(),
  /** 未验证的原因（例如项目还没有环境）；已验证时为 null */
  unverifiedReason: z.string().nullable(),
});
export type VersionCreated = z.infer<typeof versionCreatedSchema>;

export const migrationStepSchema = z.object({
  kind: z.string(),
  target: z.string(),
  sql: z.string(),
  /** 冻结脚本里这一步的 transactional 标记（验证 / 重新验证的报告里的步骤带着它；规划器的预览里没有） */
  transactional: z.boolean().optional(),
});
export type MigrationStep = z.infer<typeof migrationStepSchema>;

export const migrationResultSchema = z.object({
  up: z.array(migrationStepSchema),
  down: z.array(migrationStepSchema),
});
export type MigrationResult = z.infer<typeof migrationResultSchema>;

export const stepRiskSchema = z.object({
  locks: z.array(z.object({ relation: z.string(), mode: z.string() })),
  rewrites: z.array(z.string()),
  scans: z.array(z.string()),
  level: z.enum(['low', 'medium', 'high']),
  /** 这一步没有做锁和重写分析的原因，是一个代码（界面按代码显示本地化的说明）；有它时不显示风险等级 */
  note: z.enum(['nontransactional']).optional(),
});
export type StepRisk = z.infer<typeof stepRiskSchema>;

export const verifyReportSchema = z.object({
  ok: z.boolean(),
  up: z.array(migrationStepSchema),
  down: z.array(migrationStepSchema),
  upDiff: z.array(z.string()),
  downDiff: z.array(z.string()),
  risks: z.array(stepRiskSchema),
  /** 风险分析没有完成时的原因，只存原因本身（例如“执行超时…”），“风险分析没有完成”这个前缀由界面的标题 / i18n 模板提供；不影响 ok，但界面要如实显示，不能当成“没有风险” */
  riskError: z.string().optional(),
  error: z.object({ step: migrationStepSchema.nullable(), message: z.string() }).nullable(),
  /** 实测影子库的 PostgreSQL 大版本（由 verifier 读取 server_version_num 推导） */
  shadowMajor: z.number().int().nullable().optional(),
  /** 实测影子库的数据库数值版本号（PG / MySQL，由 verifier 读取） */
  shadowVersionNum: z.number().int().nullable().optional(),
});
export type VerifyReport = z.infer<typeof verifyReportSchema>;

export const verifyTargetReportSchema = z.object({
  major: z.number().int(),
  shadow: z.string(),
  ok: z.boolean(),
  error: z.string().nullable().optional(),
  upDiffCount: z.number().int(),
  downDiffCount: z.number().int(),
});
export type VerifyTargetReport = z.infer<typeof verifyTargetReportSchema>;

export const verifyResponseSchema = verifyReportSchema.extend({
  shadow: z.string(),
  targets: z.array(verifyTargetReportSchema).optional(),
  missingTargetMajor: z.number().int().nullable().optional(),
});
export type VerifyResponse = z.infer<typeof verifyResponseSchema>;

export const verifyRequestSchema = z.object({
  from: z.string().default('empty'),
  to: z.string().default('head'),
  env: z.string().optional(),
});
export type VerifyRequest = z.infer<typeof verifyRequestSchema>;

/** 存在版本里的验证报告：不含 up / down（它们就是冻结的脚本本身） */
export const storedVerifyReportSchema = z.object({
  ok: z.boolean(),
  upDiff: z.array(z.string()),
  downDiff: z.array(z.string()),
  risks: z.array(stepRiskSchema),
  /** 同上：只存原因本身，前缀由界面提供 */
  riskError: z.string().optional(),
  error: z.object({ step: migrationStepSchema.nullable(), message: z.string() }).nullable(),
  /** 实际用的影子库 */
  shadow: z.string(),
  at: z.string(),
  /** 多版本影子库验证时，各大版本分别的验证结果（按大版本升序） */
  targets: z.array(verifyTargetReportSchema).optional(),
  /** 存在多个 PG 大版本但最低目标版本缺少可用影子库时记录缺失的大版本号 */
  missingTargetMajor: z.number().int().nullable().optional(),
});
export type StoredVerifyReport = z.infer<typeof storedVerifyReportSchema>;

export const versionDetailSchema = versionInfoSchema.extend({
  upSteps: z.array(scriptStepSchema),
  downSteps: z.array(scriptStepSchema),
  checksum: z.string(),
  /** 最近一次验证的报告；从没验证过为 null */
  verifyReport: storedVerifyReportSchema.nullable(),
});
export type VersionDetail = z.infer<typeof versionDetailSchema>;

/** 人工编辑冻结的脚本：整体替换 up 和 down（每步一个元素） */
export const stepsPatchSchema = z.object({
  up: z.array(scriptStepSchema.extend({ sql: z.string().max(1_000_000) })).max(5000),
  down: z.array(scriptStepSchema.extend({ sql: z.string().max(1_000_000) })).max(5000),
});
export type StepsPatch = z.infer<typeof stepsPatchSchema>;

/** 发布被拒绝（422）时附带的验证报告 */
export const publishRejectedSchema = z.object({ error: z.string(), report: verifyResponseSchema.optional() });
export type PublishRejected = z.infer<typeof publishRejectedSchema>;

/** 重新验证的响应 */
export const versionVerifyResponseSchema = z.object({
  report: storedVerifyReportSchema,
  /** 本次验证后版本的验证时间（失败时为 null） */
  verifiedAt: z.string().nullable(),
});
export type VersionVerifyResponse = z.infer<typeof versionVerifyResponseSchema>;

// ───── 导入 / 拉取 ─────

export const importSchema = z.object({
  sql: z.string().min(1).max(5_000_000),
  env: z.string().optional(),
});
export type ImportRequest = z.infer<typeof importSchema>;

export const modelUpdateSchema = z.object({ seq: z.number(), objects: z.number() });
export type ModelUpdate = z.infer<typeof modelUpdateSchema>;

// ───── 环境 ─────

export const targetUrlSchema = z
  .string()
  .regex(
    /^(?:postgres(?:ql)?|sqlite|mysql|mssql|sqlserver):\/\//i,
    '连接串必须以 postgres://、sqlite://、mysql:// 或 mssql:// 开头',
  );

export const environmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: targetUrlSchema,
  production: z.boolean().default(true),
  allowSameInstance: z.boolean().default(false),
  shadowUrl: targetUrlSchema.nullable().default(null),
});
export type EnvironmentCreate = z.infer<typeof environmentCreateSchema>;

/** 漂移检测的结果：unknown 还没检查过，ok 没有漂移，drifted 线上结构与当前版本不一致，error 检查时连不上 / 读不出 */
export const driftStatusSchema = z.enum(['unknown', 'ok', 'drifted', 'error']);
export type DriftStatus = z.infer<typeof driftStatusSchema>;

/** 差异列表的一项：线上结构 → 当前版本模型，需要做什么才能回到这个版本（plan 的一步） */
export const driftItemSchema = z.object({ kind: z.string(), target: z.string(), sql: z.string() });
export type DriftItem = z.infer<typeof driftItemSchema>;

/**
 * “需要人工修正”：上一次执行的读回校验失败（所有步骤都做完了，结构却不等于目标版本）。
 * 方向和版本：升级是新版本，回滚是被回滚的版本；versionNumber 由服务端按版本链补上。
 * 注意旧数据里 drift_summary 的 needsManual 可能是 `true`（早期格式），服务端读出时会丢掉不合格式的值。
 */
export const needsManualSchema = z.object({
  direction: z.enum(['up', 'down', 'baseline']),
  versionId: z.string().nullable(),
  versionNumber: z.number().nullable().optional(),
});
export type NeedsManual = z.infer<typeof needsManualSchema>;

export const driftSummarySchema = z.object({
  /** 与哪个版本的模型比较（版本 ID 和序号；库里还没有历史时是链上第一个版本） */
  versionId: z.string().nullable(),
  versionNumber: z.number().nullable(),
  /** 差异总数（items 最多 100 项） */
  total: z.number(),
  items: z.array(driftItemSchema),
  /**
   * 检查失败（status = error）时的原因，或者 drifted 时的补充说明（例如“上一次执行的读回校验失败留下的差异，需要人工修正”）；已脱敏。
   * 文案已经说明真实原因，界面直接显示。
   */
  message: z.string().nullable(),
  /** 检查失败的类别：connect 连不上目标库、database 目标库返回错误（权限等）、integrity 历史与版本链对不上、scope schema 范围有问题、history 读不了 dowel 历史、unexpected 其他 */
  errorKind: z.enum(['connect', 'database', 'integrity', 'scope', 'history', 'unexpected']).optional(),
  /** 差异是上一次“读回校验失败”的执行留下的：不能续跑，需要人工修正；说明是哪次执行、哪个版本 */
  needsManual: needsManualSchema.optional(),
  /** 库里还没有 Dowel 的历史：比较的是“基线 / 空库” */
  firstRun: z.boolean().optional(),
});
export type DriftSummary = z.infer<typeof driftSummarySchema>;

export const driftInfoSchema = z.object({
  status: driftStatusSchema,
  /** 最近一次检查的时间；从没检查过为 null */
  checkedAt: z.string().nullable(),
  summary: driftSummarySchema.nullable(),
});
export type DriftInfo = z.infer<typeof driftInfoSchema>;

export const envVersionRefSchema = z.object({ id: z.string(), number: z.number(), name: z.string() });
export type EnvVersionRef = z.infer<typeof envVersionRefSchema>;

// ───── 执行策略（P5a） ─────

/** 实例 / 组 / 项目层的执行策略：PUT 的请求体就是 LayerPolicy（整层替换，字段不出现 = 继承） */
export const layerPolicyPutSchema = layerPolicySchema;

/** 环境层：环境自己的那一套设置 */
export const envPolicyPutSchema = z
  .object({
    settings: policySettingsSchema,
  })
  .strict();
export type EnvPolicyPut = z.infer<typeof envPolicyPutSchema>;

/** 审批人范围里引用的组 / 用户的显示名（id → 名字），配置页直接显示 */
export type PolicyNames = Record<string, string>;

/** 实例 / 组 / 项目层的执行策略配置页 */
export interface PolicyLayerView {
  layer: 'instance' | 'group' | 'project';
  settings: LayerPolicy;
  /** 从这一层看的生效策略（上级合并出来的下限 = 锁定） */
  resolved: { production: ResolvedPolicy; nonProduction: ResolvedPolicy };
  /** 能否修改这一层（实例管理员 / 组管理员 / 项目管理员）；放宽另有要求，见 canLoosen */
  canEdit: boolean;
  /** 能否放宽（放宽是特权操作：还要满足这一层当前生效的“谁能执行”）；不能时 loosenNote 说明原因 */
  canLoosen: { production: boolean; nonProduction: boolean };
  loosenNote: string | null;
  names: PolicyNames;
}

/** 环境层的执行策略配置页 */
export interface EnvPolicyView {
  production: boolean;
  settings: PolicySettings;
  resolved: ResolvedPolicy;
  canEdit: boolean;
  canLoosen: boolean;
  loosenNote: string | null;
  names: PolicyNames;
}

export const envPermissionsSchema = z.object({
  /** 能否执行 / 回滚 / 写基线（按环境的执行档位） */
  execute: z.boolean(),
  /** 能否改连接串、影子库、执行档位和删除环境 */
  configure: z.boolean(),
  /** 能否取消“生产”标记（environment.unmark_production：至少项目管理员，且满足当前生效的“谁能执行”） */
  unmarkProduction: z.boolean(),
  /** 生效的审批流程配置了环节（P5b）：执行 / 回滚要提交执行申请，谁都不能直接执行（execute 只表示满足“谁能执行”） */
  approvalRequired: z.boolean(),
  /** 能否提交执行申请（项目编辑者以上，或者执行者） */
  request: z.boolean(),
  /** 能否紧急执行（实例管理员；只在要求审批的环境上有意义） */
  emergency: z.boolean(),
});
export type EnvPermissions = z.infer<typeof envPermissionsSchema>;

export const environmentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  production: z.boolean(),
  allowSameInstance: z.boolean(),
  shadowUrl: z.string().nullable(),
  /** 环境上设置的执行档位；null 表示用默认（非生产 editor，生产 admin） */
  execPolicy: execPolicySchema.nullable(),
  /** 实际生效的执行档位 */
  effectiveExecPolicy: execPolicySchema,
  /** 生效的执行策略（四层合并，P5a）：每个字段的生效值、来源层、上级下限 */
  policy: z.custom<ResolvedPolicy>(),
  /** 环境当前版本（平台库缓存：最近一次读目标库历史 / 执行后的结果）；还没执行过为 null */
  currentVersion: envVersionRefSchema.nullable(),
  /** 目标库 PostgreSQL 简洁版本串（如 "16.4"）；尚未探测过为 null */
  engineVersion: z.string().nullable(),
  /** 目标库 PostgreSQL server_version_num（如 160004）；尚未探测过为 null */
  engineVersionNum: z.number().int().nullable(),
  /** 目标库 PostgreSQL 大版本号（如 16）；尚未探测过为 null */
  engineMajor: z.number().int().nullable(),
  drift: driftInfoSchema,
  permissions: envPermissionsSchema,
});
export type EnvInfo = z.infer<typeof environmentInfoSchema>;

/** 修改环境：连接串 / 影子库 / 生产标记 / 执行档位都是特权操作，按环境的执行档位检查 */
export const environmentPatchSchema = z.object({
  url: targetUrlSchema.optional(),
  shadowUrl: targetUrlSchema.nullable().optional(),
  allowSameInstance: z.boolean().optional(),
  production: z.boolean().optional(),
  execPolicy: execPolicySchema.nullable().optional(),
});
export type EnvironmentPatch = z.infer<typeof environmentPatchSchema>;

/** 环境状态里的一个版本（版本链按序号升序，每个版本相对这个环境的当前版本是已执行 / 当前 / 待执行） */
export const envVersionSchema = z.object({
  id: z.string(),
  number: z.number(),
  name: z.string(),
  state: z.enum(['applied', 'current', 'pending']),
  verified: z.boolean(),
  edited: z.boolean(),
  /** 升级 / 回滚脚本的步数 */
  upSteps: z.number(),
  downSteps: z.number(),
  /** 升级脚本里有不能放进事务的步骤（CREATE INDEX CONCURRENTLY 等）：这个迁移不是原子的，失败后要从断点续跑 */
  nonTransactional: z.boolean(),
  /** 最近一次验证里升级脚本风险最高的一档；没有分析 / 没有验证为 null */
  risk: z.enum(['low', 'medium', 'high']).nullable(),
  /** 风险分析没有完成的原因 */
  riskError: z.string().nullable(),
  /** 这个版本在这个环境上执行过（目标库历史里有它） */
  executedHere: z.boolean(),
});
export type EnvVersion = z.infer<typeof envVersionSchema>;

export const envStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  production: z.boolean(),
  execPolicy: execPolicySchema.nullable(),
  effectiveExecPolicy: execPolicySchema,
  policy: z.custom<ResolvedPolicy>(),
  currentVersion: envVersionRefSchema.nullable(),
  /** 链上全部版本（升序） */
  versions: z.array(envVersionSchema),
  /** 待执行的版本 ID（升序）：执行到最新版本需要依次执行它们 */
  pending: z.array(z.string()),
  drift: driftInfoSchema,
  permissions: envPermissionsSchema,
});
export type EnvStatus = z.infer<typeof envStatusSchema>;

/** 执行 / 回滚到指定版本。生产环境必须在 confirm 里填环境名（服务端校验） */
export const executeRequestSchema = z.object({
  to: z.string().min(1),
  confirm: z.string().optional(),
  /** 只预演（见 DryRunResponse）：生产环境也不需要 confirm，因为什么都不会写 */
  dryRun: z.boolean().optional(),
});
export type ExecuteRequest = z.infer<typeof executeRequestSchema>;

/**
 * 标记为已执行（ADR 0004）：不执行任何 SQL，把环境记为已到达版本 `to`（链上任意版本，更新或更早都行）。
 * 前提：线上结构等于 to 的模型。生产环境必须带环境名（confirm）；向前标记要带 acknowledge（确认被跳过的版本里
 * 的脚本效果已经手工完成，或者不需要）。dryRun：只核对并返回计划，什么都不写。
 */
export const markExpectSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  skipped: z.array(z.string()),
  fingerprint: z.string(),
});
export type MarkExpect = z.infer<typeof markExpectSchema>;

export const markRequestSchema = z.object({
  to: z.string().min(1),
  confirm: z.string().optional(),
  acknowledge: z.boolean().optional(),
  /**
   * 预演时拿到的计划（from、to、跳过的版本、线上结构指纹）：向前标记的确认必须绑定到它。执行器在锁里重新算出 plan，
   * 任何一项不一致就拒绝（422，code = plan_changed，details.plan 是新的计划），什么都不写。
   * 向前标记不带 expect 直接拒绝（expect_required）；向后标记和标记到当前版本可以不带。
   */
  expect: markExpectSchema.optional(),
  dryRun: z.boolean().optional(),
});
export type MarkRequest = z.infer<typeof markRequestSchema>;

export const baselineRequestSchema = z.object({
  confirm: z.string().optional(),
  /** 只预演：做完全部执行前检查、列出要做的事，不写目标库、不写平台库的登记 */
  dryRun: z.boolean().optional(),
});
export type BaselineRequest = z.infer<typeof baselineRequestSchema>;

/** 执行进度的阶段：拿锁 → 完整性检查 → 漂移检查 → 计划 → 逐个迁移 → 完成 */
export const execStageSchema = z.enum(['lock', 'integrity', 'drift', 'plan', 'migration', 'done']);
export type ExecStage = z.infer<typeof execStageSchema>;

export const execMigrationRefSchema = z.object({
  versionId: z.string(),
  number: z.number(),
  name: z.string(),
  direction: z.enum(['up', 'down', 'baseline']),
  steps: z.number(),
});

/** 标记计划里的一个版本（向前标记被跳过的版本：脚本没有执行） */
export const markVersionSchema = envVersionRefSchema.extend({
  upSteps: z.array(scriptStepSchema),
  downSteps: z.array(scriptStepSchema),
});
export type MarkVersion = z.infer<typeof markVersionSchema>;

export const markPlanSchema = z.object({
  /** current：目标就是当前版本（上一次执行没有结束、手工改回当前版本之后放弃那次未完成的运行） */
  direction: z.enum(['forward', 'backward', 'current']),
  from: envVersionRefSchema.nullable(),
  to: envVersionRefSchema,
  /** 向前：被记为已执行、但脚本没有执行的版本（from 之后到 to，含 to）；向后为空 */
  skipped: z.array(markVersionSchema),
  /** 读到的线上结构指纹 */
  fingerprint: z.string(),
});
export type MarkPlanInfo = z.infer<typeof markPlanSchema>;

/** 出错时的细节：漂移 / 读回不一致的差异、失败的是第几步、目标库是否已被部分改动 */
export const execErrorDetailsSchema = z.object({
  diff: z.array(driftItemSchema).optional(),
  diffTotal: z.number().optional(),
  problems: z.array(z.string()).optional(),
  versionId: z.string().optional(),
  number: z.number().optional(),
  step: z.number().optional(),
  partial: z.boolean().optional(),
  needsManual: needsManualSchema.optional(),
  /** plan_changed：锁里重新算出的标记计划（预演之后目标库变了） */
  plan: markPlanSchema.optional(),
  /**
   * step_timeout：某一步因为执行策略的超时被取消。lock = 等锁超过 lock_timeout（表被别的会话占着），
   * statement = 语句执行超过 statement_timeout。ms 是当时的设置
   */
  timeout: z.object({ kind: z.enum(['lock', 'statement']), ms: z.number() }).optional(),
  /** foreign_instance：当前认领这个项目的实例 */
  claim: z
    .object({
      instanceId: z.string(),
      claimedAt: z.string().nullable(),
      previousInstanceId: z.string().nullable(),
    })
    .optional(),
});
export type ExecErrorDetails = z.infer<typeof execErrorDetailsSchema>;

/** SSE 每条消息的负载（`data:` 后面是它的 JSON）；出错时最后一条带 error（HTTP 状态仍是 200） */
export const execEventSchema = z.object({
  stage: execStageSchema,
  /** plan 阶段：先写基线 + 要执行的迁移 */
  baseline: z.boolean().optional(),
  migrations: z.array(execMigrationRefSchema).optional(),
  /** migration 阶段 */
  status: z.enum(['start', 'step', 'done']).optional(),
  index: z.number().optional(),
  total: z.number().optional(),
  versionId: z.string().optional(),
  number: z.number().optional(),
  name: z.string().optional(),
  direction: z.enum(['up', 'down', 'baseline']).optional(),
  step: z.number().optional(),
  steps: z.number().optional(),
  resumed: z.boolean().optional(),
  /** done 阶段：结束时的当前版本和本次执行的迁移数 */
  current: envVersionRefSchema.nullable().optional(),
  ran: z.number().optional(),
  /** 出错：已脱敏的说明、错误代码和细节 */
  error: z.string().optional(),
  code: z.string().optional(),
  details: execErrorDetailsSchema.optional(),
});
export type ExecEvent = z.infer<typeof execEventSchema>;

/** 标记的预演（核对线上结构、列出被跳过的版本，不写任何东西）；核对没通过也是 200，ok = false，带差异 */
export const markDryRunResponseSchema = z.object({
  ok: z.boolean(),
  plan: markPlanSchema.optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: execErrorDetailsSchema.optional(),
});
export type MarkDryRunResponse = z.infer<typeof markDryRunResponseSchema>;

export const markResultSchema = z.object({
  plan: markPlanSchema,
  current: envVersionRefSchema,
});
export type MarkResult = z.infer<typeof markResultSchema>;

export const runInfoSchema = z.object({
  id: z.number(),
  fromVersion: envVersionRefSchema.nullable(),
  toVersion: envVersionRefSchema,
  direction: z.enum(['baseline', 'up', 'down', 'mark']),
  status: z.enum(['running', 'done', 'failed']),
  /** 已完成的最后一步（0 起）；null 表示没有断点 */
  stepIndex: z.number().nullable(),
  /** 已去掉内部标记的错误文本 */
  error: z.string().nullable(),
  /** 这次失败是“读回校验失败”（所有步骤都做完了，结构却不等于目标版本）：不能续跑，需要人工修正 */
  readbackFailure: z.boolean(),
  executedBy: z.string().nullable(),
  /** 执行者的显示名（用户已被删除时为 null，界面回退到 id） */
  executedByName: z.string().nullable(),
  via: z.enum(['web', 'ci']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunInfo = z.infer<typeof runInfoSchema>;

/**
 * 目标库里这个项目的认领情况（dowel.projects）。mine = 当前认领它的就是本实例；
 * 不是的话执行会被拒绝（foreign_instance），要由实例管理员“认领”；只读的漂移检查和读历史不受影响。
 */
export const claimInfoSchema = z.object({
  mine: z.boolean(),
  instanceId: z.string().nullable(),
  claimedAt: z.string().nullable(),
  previousInstanceId: z.string().nullable(),
});
export type ClaimInfo = z.infer<typeof claimInfoSchema>;

/** 目标库里的一条认领事件（dowel.claims，只追加） */
export const claimEventSchema = z.object({
  id: z.number(),
  instanceId: z.string(),
  previousInstanceId: z.string().nullable(),
  claimedByName: z.string().nullable(),
  claimedAt: z.string(),
});
export type ClaimEvent = z.infer<typeof claimEventSchema>;

export const envHistorySchema = z.object({
  /** 目标库里有没有这个项目的 Dowel 历史 */
  initialized: z.boolean(),
  /** 认领情况；目标库还没有项目行（没执行过）时为 null */
  claim: claimInfoSchema.nullable(),
  /** 认领事件，新的在后 */
  claims: z.array(claimEventSchema),
  currentVersion: envVersionRefSchema.nullable(),
  /** 上一次执行停在中途（目标库处于半途状态，必须先继续执行）；没有为 null */
  unfinished: runInfoSchema.nullable(),
  /** 上一次执行读回校验失败（所有步骤做完了结构却不对，需要人工修正）：执行器读目标库历史得到的，界面不要从 runs 里推 */
  readbackFailure: z.boolean(),
  /** 最近的执行记录，新的在前（最多 100 条） */
  runs: z.array(runInfoSchema),
});
export type EnvHistory = z.infer<typeof envHistorySchema>;

// ───── 漂移的两个出口（ADR 0004） ─────

/** 保留线上的修改：导入前的预览。覆盖工作副本前先给差异，并在三种情况下警告（不拦截） */
export const importRequestSchema = z.object({
  preview: z.boolean().optional(),
  /**
   * 确认覆盖时带上预览时拿到的线上结构指纹：服务端重新读线上结构，指纹不一致就 409（code = live_changed，带新的预览），
   * 让用户重新确认差异。不带则不绑定（接口的旧用法）。
   */
  fingerprint: z.string().optional(),
  /**
   * 确认覆盖时带上预览时工作副本的 seq：覆盖之前在 rooms 里比对，工作副本在预览之后被改过就 409
   * （code = working_changed，带新的预览），不覆盖。不带则不绑定。
   */
  workingSeq: z.number().optional(),
});
export type PullRequest = z.infer<typeof importRequestSchema>;

export const pullPreviewSchema = z.object({
  /** 线上结构 → 工作副本会变成的样子：plan(工作副本, 导入后) 的步骤 */
  items: z.array(driftItemSchema),
  total: z.number(),
  /** 线上结构的指纹（也记进审计） */
  fingerprint: z.string(),
  /** 预览时工作副本的 seq：确认时带回来，绑定“覆盖的是我看过差异的那一份工作副本” */
  workingSeq: z.number(),
  warnings: z.object({
    /** 环境落后于链头：覆盖会撤销中间版本的修改（导入的是它现在的结构） */
    behindHead: z.object({ current: envVersionRefSchema.nullable(), head: envVersionRefSchema }).nullable(),
    /** 环境有半途失败的迁移（停在中途） */
    unfinished: z.boolean(),
    /** 环境上一次执行读回校验失败（所有步骤做完了结构却不对） */
    readbackFailure: z.boolean(),
    /** 工作副本有未发布的修改（会被覆盖） */
    workingDirty: z.boolean(),
  }),
});
export type PullPreview = z.infer<typeof pullPreviewSchema>;

/** 放弃线上的修改：修复脚本 plan(线上结构, 当前版本的模型)。只显示、可复制，Dowel 不代为执行 */
export const repairScriptSchema = z.object({
  versionNumber: z.number().nullable(),
  /** 带会话设置的完整脚本（可以直接复制去执行）；没有可执行的步骤时为 null */
  script: z.string().nullable(),
  steps: z.array(driftItemSchema),
  /** 模型表达不了的差异（unresolvable）：需要手工处理 */
  manual: z.array(driftItemSchema),
  total: z.number(),
  /** 漂移摘要只保存前 100 项：脚本不完整，修完再检查一次 */
  truncated: z.boolean(),
  /** 风险提示（按规划器 step 的 kind 分类）：会删掉对象或数据的步骤数、去掉约束的步骤数、改列类型（可能重写整表）的步骤数 */
  risks: z.object({
    drops: z.number(),
    constraints: z.number(),
    rewrites: z.number(),
    /** 重建（先 drop 再 create 同一个对象）的数量：不算删除 */
    rebuilds: z.number(),
  }),
});
export type RepairScript = z.infer<typeof repairScriptSchema>;

/** 手动检查漂移的响应：skipped 有值表示这次没有检查（busy 正在执行、unfinished 上次停在中途、no_versions 项目还没有版本） */
export const driftCheckResponseSchema = driftInfoSchema.extend({
  skipped: z.enum(['busy', 'unfinished', 'no_versions']).nullable(),
});
export type DriftCheckResponse = z.infer<typeof driftCheckResponseSchema>;

// ───── 预演（dryRun） ─────

/** 预演里的一个迁移：要执行的步骤、哪些不在事务里、验证时的风险摘要 */
export const dryRunMigrationSchema = z.object({
  versionId: z.string(),
  number: z.number(),
  name: z.string(),
  direction: z.enum(['up', 'down', 'baseline']),
  steps: z.array(scriptStepSchema),
  /** 不在事务里的步骤数：含这些步骤的迁移不是原子的，中途失败要从断点续跑 */
  nonTransactional: z.number(),
  /** 预演时这个版本的校验和：执行申请绑定的就是它（P5b） */
  checksum: z.string(),
  /** 发布 / 重新验证时影子库里分析的最高风险（只有升级脚本有）；没有分析为 null */
  risk: z.enum(['low', 'medium', 'high']).nullable(),
  riskError: z.string().nullable(),
  verified: z.boolean(),
});
export type DryRunMigration = z.infer<typeof dryRunMigrationSchema>;

export const dryRunPlanSchema = z.object({
  mode: z.enum(['migrate', 'baseline']),
  direction: z.enum(['up', 'down', 'none']),
  /** 目标库还没有历史：baseline 只写基线，empty 在空库上建库；已有历史为 null */
  firstRun: z.enum(['baseline', 'empty']).nullable(),
  baseline: z.boolean(),
  from: envVersionRefSchema.nullable(),
  to: envVersionRefSchema.nullable(),
  migrations: z.array(dryRunMigrationSchema),
  /** 上一次停在中途：会从这个迁移的第 afterStep + 2 步接着跑 */
  resume: z
    .object({ versionId: z.string(), direction: z.enum(['up', 'down', 'baseline']), afterStep: z.number() })
    .nullable(),
  /** 会在目标库里新建 dowel schema */
  createsHistory: z.boolean(),
  /** 通过了的检查 */
  checks: z.array(
    z.enum(['lock', 'integrity', 'claim', 'drift', 'verified', 'instance_level', 'history_writable']),
  ),
});
export type DryRunPlan = z.infer<typeof dryRunPlanSchema>;

/**
 * 预演的响应。检查没通过（漂移、未验证、被别的实例认领……）也是 200：ok = false，带原因，和执行时的错误事件同一个形状，
 * 界面把它当作“如果现在执行会怎样”显示。**没有写目标库，也没有写平台库的登记。**
 */
export const dryRunResponseSchema = z.object({
  ok: z.boolean(),
  plan: dryRunPlanSchema.optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  details: execErrorDetailsSchema.optional(),
});
export type DryRunResponse = z.infer<typeof dryRunResponseSchema>;

/** 目标库里的一个 schema：名字 + 表数（向导的勾选列表、schema 范围设置都用它） */
export const schemaInfoSchema = z.object({ name: z.string(), tables: z.number() });
export type SchemaInfo = z.infer<typeof schemaInfoSchema>;

/**
 * 检查目标库的结果（环境创建 / 测试连接 / 连接检查共用）。
 * 只读：`inspectTarget` 不执行任何写语句。
 */
export const targetInfoSchema = z.object({
  version: z.string(),
  versionNum: z.number(),
  database: z.string(),
  canCreateDb: z.boolean(),
  shadow: z.string(),
  shadowExists: z.boolean(),
  /** 当前连接使用的用户名 */
  currentUser: z.string(),
  superuser: z.boolean(),
  /** 能否在当前库建 schema（`has_database_privilege(current_database(), 'CREATE')`） */
  canCreateSchema: z.boolean(),
  /** 非系统 schema（不含 dowel），每个带表数 */
  schemas: z.array(schemaInfoSchema),
  /** 已经有 dowel schema（P4 起 Dowel 在里面写迁移历史） */
  dowelSchema: z.boolean(),
  /** dowel schema 里有 meta 表（Dowel 自己的历史表） */
  dowelMeta: z.boolean(),
});
export type TargetInfo = z.infer<typeof targetInfoSchema>;

export const environmentCreatedSchema = targetInfoSchema.extend({ id: z.string() });
export type EnvironmentCreated = z.infer<typeof environmentCreatedSchema>;

// ───── 接入已有历史与认领（P4c） ─────

/**
 * 给已有项目添加环境，并接入这个库里已有的迁移历史。属于特权操作：适用环境的执行档位，且至少要项目管理员。
 * claim：这个库里的项目由另一个实例认领时，确认认领（要实例管理员）；之后原实例的执行被拒绝。
 * confirmOverwrite / workingSeq：目标库历史领先于平台链且当前工作副本有未发布修改时，确认覆盖工作副本到新链头并绑定预览时的 seq。
 */
export const environmentAttachSchema = environmentCreateSchema.extend({
  claim: z.boolean().default(false),
  confirmOverwrite: z.boolean().default(false),
  workingSeq: z.number().int().min(0).optional(),
});
export type EnvironmentAttach = z.infer<typeof environmentAttachSchema>;

/** 接入领先环境时工作副本有未发布修改：409（working_dirty_confirm / working_changed）附带的预览 */
export const attachOverwritePreviewSchema = z.object({
  aheadVersions: z.array(envVersionRefSchema),
  items: z.array(driftItemSchema),
  total: z.number(),
  workingSeq: z.number(),
});
export type AttachOverwritePreview = z.infer<typeof attachOverwritePreviewSchema>;

export const attachResultSchema = environmentCreatedSchema.extend({
  /** 这个库里有这个项目的历史并已接入；false 表示它只是一个新环境 */
  attached: z.boolean(),
  currentVersion: envVersionRefSchema.nullable(),
  /** 这次是否认领了（换手） */
  claimed: z.boolean(),
  /** 目标库领先于平台链时本次补齐并验证通过的版本列表 */
  aheadVersions: z.array(envVersionRefSchema).default([]),
  /** 环境已经建好，但有没做完的事（认领失败、同步目标库状态失败）：可以在环境页重试认领 / 读历史 */
  warnings: z.array(z.string()).default([]),
});
export type AttachResult = z.infer<typeof attachResultSchema>;

export const claimResultSchema = z.object({
  /** false：本来就是本实例认领的，什么都没写 */
  changed: z.boolean(),
  previousInstanceId: z.string().nullable(),
});
export type ClaimResult = z.infer<typeof claimResultSchema>;

// ───── 接手（P4c） ─────

/** 接手向导第一步：连上一个库，看它登记过哪些项目 */
export const takeoverInspectSchema = z.object({
  url: targetUrlSchema,
  dialect: dialectSchema.default('pg'),
  /** 用这个组判断调用者有没有建项目的权限（接手相当于新建项目） */
  groupId: z.string().min(1, '请选择组'),
});
export type TakeoverInspect = z.infer<typeof takeoverInspectSchema>;

export const takeoverProjectSchema = z.object({
  projectId: z.string(),
  name: z.string().nullable(),
  /** 当前认领它的实例；mine = 就是本实例（比如平台库没丢，只是项目被删了） */
  claimedBy: z.string(),
  mine: z.boolean(),
  claimedAt: z.string().nullable(),
  versions: z.number(),
  headNumber: z.number().nullable(),
  currentNumber: z.number().nullable(),
  lastRunAt: z.string().nullable(),
  /** 本实例里已经有同一个项目 ID 的项目：不能再接手（要接入新环境请用“添加环境”） */
  existsHere: z.boolean(),
  /** 已存在的那个项目调用者看不到：界面不给名字 / 归属，只说“已存在，请联系管理员” */
  hidden: z.boolean(),
});
export type TakeoverProject = z.infer<typeof takeoverProjectSchema>;

export const takeoverInspectResultSchema = z.object({
  database: z.string(),
  /** 这个库有没有 dowel 历史表 */
  hasHistory: z.boolean(),
  projects: z.array(takeoverProjectSchema),
  /** 本实例的标识 */
  instanceId: z.string(),
});
export type TakeoverInspectResult = z.infer<typeof takeoverInspectResultSchema>;

/** 连接检查（向导第 2 步）：建项目之前检查一个连接串 */
export const connectionCheckSchema = z.object({
  url: targetUrlSchema,
  dialect: dialectSchema.default('pg'),
  /** 用这个组判断调用者有没有建项目的权限（复用 group.create_project） */
  groupId: z.string().min(1, '请选择组'),
});
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;

// ───── 新建项目向导（P3） ─────

/** 初始内容：空白 / 从数据库导入 / 从 SQL 导入 / 接手（P4 才实现，现在返回 422） */
export const projectContentKindSchema = z.enum(['blank', 'database', 'sql', 'takeover']);
export type ProjectContentKind = z.infer<typeof projectContentKindSchema>;

/** 基线版本的名称：导入完成后自动发布 v0（按 GLOSSARY 的“基线”） */
export const BASELINE_VERSION_NAME = 'v0 · 基线';

export const projectWizardSchema = z.object({
  name: z.string().trim().min(1, '项目名不能为空').max(100),
  groupId: z.string().min(1, '请选择组'),
  slug: slugSchema.optional(),
  dialect: dialectSchema.default('pg'),
  /** 关联的数据库（可空）；和现有环境接口的字段一致 */
  environments: z.array(environmentCreateSchema).max(20).default([]),
  /** schema 范围（null / 空表示全部，dowel 永远排除） */
  schemas: schemaScopeSchema.nullable().optional(),
  content: z.object({
    kind: projectContentKindSchema,
    /** kind=database：从 environments 里的哪个环境导入（按名字） */
    env: z.string().max(100).optional(),
    /** kind=sql：要在影子库里执行的 DDL */
    sql: z.string().min(1).max(5_000_000).optional(),
    /** kind=takeover：要接手的项目（目标库 dowel.projects 里的 project_id）；`environments` 里每个库都必须有它的历史 */
    projectId: z.string().min(1).max(200).optional(),
    /**
     * kind=takeover：确认认领。这些库里的项目由另一个实例认领时必须为 true，并且调用者是实例管理员；
     * 后果：原实例之后执行会被拒绝，只读的漂移检查和读历史不受影响。
     */
    claim: z.boolean().optional(),
  }),
});
export type ProjectWizard = z.infer<typeof projectWizardSchema>;

/** 进度阶段：连接 → 读取结构 → 验证 / 规范化 → 写入 → 认领 → 完成 */
export const wizardStageSchema = z.enum([
  'connect',
  'read',
  'verify',
  'canonicalize',
  'write',
  'claim',
  'done',
]);
export type WizardStage = z.infer<typeof wizardStageSchema>;

/** SSE 每条消息的负载（`data:` 后面是它的 JSON） */
export const wizardEventSchema = z.object({
  stage: wizardStageSchema,
  /** 可选进度详情（例如接手验证阶段当前正在验证的版本） */
  detail: z.string().optional(),
  /** 出错时的信息；这时不会建出项目 */
  error: z.string().optional(),
  /** 出错时的代码（接手：claim_required 需要确认认领、claim_forbidden 需要实例管理员、shadow_unavailable、verify_failed、history_* 历史有问题、project_exists） */
  code: z.string().optional(),
  /** 成功时给出建好的项目 */
  project: projectCreatedSchema.optional(),
  /** 接手成功但有没做完的事（例如某个库认领失败：项目已经建好，可以在环境页重试认领） */
  warnings: z.array(z.string()).optional(),
});
export type WizardEvent = z.infer<typeof wizardEventSchema>;

// ───── OIDC（A7） ─────

/** 登录页 / 邀请页只需要提供方的标识和显示名；管理接口另有 oidcProviderInfoSchema */
export const oidcProviderPresetSchema = z.object({
  key: z.string(),
  name: z.string(),
  issuer: z.string(),
  /** 提供方的配置文档 */
  docUrl: z.string(),
  scopes: z.string(),
});
export type OidcProviderPreset = z.infer<typeof oidcProviderPresetSchema>;

export const oidcProviderInfoSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  issuer: z.string(),
  clientId: z.string(),
  scopes: z.string(),
  enabled: z.boolean(),
  autoProvision: z.boolean(),
  /** 只说明是否已设置，绝不返回 secret 本身 */
  hasSecret: z.boolean(),
  /** 提供方后台里要填的回调地址（规则同 /api/auth/oidc/:slug/callback）；拿不到对外地址时为 null */
  callbackUrl: z.string().nullable(),
  createdAt: z.string(),
});
export type OidcProviderInfo = z.infer<typeof oidcProviderInfoSchema>;

const oidcScopes = z.string().trim().min(1).max(500);
const oidcIssuer = z.string().trim().min(1).max(500);

export const oidcProviderCreateSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1, '显示名不能为空').max(100),
  issuer: oidcIssuer,
  clientId: z.string().trim().min(1, 'client_id 不能为空').max(500),
  clientSecret: z.string().min(1, 'client_secret 不能为空').max(1000),
  scopes: oidcScopes.default('openid profile email'),
  enabled: z.boolean().default(true),
  autoProvision: z.boolean().default(false),
});
export type OidcProviderCreate = z.infer<typeof oidcProviderCreateSchema>;

export const oidcProviderPatchSchema = z.object({
  slug: slugSchema.optional(),
  name: z.string().trim().min(1, '显示名不能为空').max(100).optional(),
  issuer: oidcIssuer.optional(),
  clientId: z.string().trim().min(1, 'client_id 不能为空').max(500).optional(),
  /** 不传表示不修改；传空字符串表示清除（不推荐） */
  clientSecret: z.string().max(1000).optional(),
  scopes: oidcScopes.optional(),
  enabled: z.boolean().optional(),
  autoProvision: z.boolean().optional(),
});
export type OidcProviderPatch = z.infer<typeof oidcProviderPatchSchema>;

/** 用户名确认页（OIDC 首次开户时 preferred_username 冲突或不合法） */
export const oidcConfirmInfoSchema = z.object({
  providerName: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().nullable(),
});
export type OidcConfirmInfo = z.infer<typeof oidcConfirmInfoSchema>;

export const oidcConfirmSchema = z.object({ username: usernameSchema });
export type OidcConfirm = z.infer<typeof oidcConfirmSchema>;

export const meIdentitySchema = z.object({
  id: z.string(),
  providerId: z.string(),
  providerSlug: z.string(),
  providerName: z.string(),
  subject: z.string(),
  createdAt: z.string(),
  lastLoginAt: z.string(),
});
export type MeIdentity = z.infer<typeof meIdentitySchema>;

// ───── 项目动态（操作日志） ─────

/**
 * 项目动态：谁、什么时候、做了什么。来自审计日志，只返回与这个项目有关的记录
 * （项目本身、它的版本、它的环境）。权限是项目查看者。
 */
export const projectActivityEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  action: z.string(),
  /** 操作者显示名；系统操作或用户已被删除时为空 */
  actorName: z.string().nullable(),
  actorUsername: z.string().nullable(),
  data: z.unknown().nullable(),
});
export type ProjectActivityEvent = z.infer<typeof projectActivityEventSchema>;

export const projectActivitySchema = z.object({ events: z.array(projectActivityEventSchema) });
export type ProjectActivity = z.infer<typeof projectActivitySchema>;

// ───── 审计查询（G7） ─────

export const auditEventSchema = z.object({
  id: z.string(),
  at: z.string(),
  actorKind: z.enum(['user', 'token', 'system']),
  actorId: z.string().nullable(),
  actorUsername: z.string().nullable(),
  action: z.string(),
  targetKind: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  data: z.unknown().nullable(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditPageSchema = z.object({
  events: z.array(auditEventSchema),
  /** 传给下一次请求的 cursor；没有更多记录时为 null */
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditPageSchema>;

// ───── 通用 ─────

export const okSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof okSchema>;

export const apiErrorSchema = z.object({ error: z.string(), code: z.string().optional() });
export type ApiErrorBody = z.infer<typeof apiErrorSchema>;

export * from './canvas-history.ts';
