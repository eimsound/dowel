// MCP 令牌与 MCP 服务（M3-C，ADR 0014）的接口契约：个人 MCP 令牌的管理、scope、服务端 /api/mcp 的错误码与工具清单。
// 规则：
// - MCP 令牌属于**用户**（不是项目）：权限 = 用户当前生效角色 ∩ 令牌 scope ∩ 可选的项目白名单；修改和审计都记在本人名下（data.via = 'mcp'）。
// - scope 正交：read 是基线（总是包含）；verify 只授权影子库验证；write 只授权工作副本的整批原子修改与画布板块的增量调整（不开放像素坐标）。
// - MCP 永远不连目标库：环境状态 / 漂移只读平台缓存（带缓存时间）；不能发布版本、不能执行 / 申请执行 / 回滚 / 标记。
// - 令牌只能访问 POST /api/mcp；/api/mcp 只认 `Bearer dwm_…`（会话 cookie 与 CI 令牌一律拒绝）。
// 实现见 apps/server/src/mcp-tokens.ts、routes/mcp.ts、routes/mcp-tokens.ts；用户文档 docs/en/mcp.md 与 docs/zh/mcp.md。
import { z } from 'zod';

import {
  MAX_SECTION_ID_LENGTH,
  MAX_SECTION_NAME_LENGTH,
  MAX_SECTION_TABLE_ID_LENGTH,
  SECTION_REF_ALIAS_PATTERN,
  SECTION_REF_PATTERN,
  sectionColorSchema,
} from './sections.ts';

// ───── 令牌本身 ─────

/** MCP 令牌明文的前缀：`dwm_` + 43 个 base64url 字符（32 字节随机数） */
export const MCP_TOKEN_PREFIX = 'dwm_';
/** 列表里用来辨认的前缀长度（含 `dwm_`） */
export const MCP_TOKEN_DISPLAY_LENGTH = 12;
/** MCP 令牌明文的格式（不合格式的直接拒绝，不查库） */
export const MCP_TOKEN_PATTERN = /^dwm_[A-Za-z0-9_-]{43}$/;
/** 默认有效期 30 天，最长 1 年；没有“永不过期” */
export const MCP_TOKEN_DEFAULT_DAYS = 30;
export const MCP_TOKEN_MAX_DAYS = 365;
/** 项目白名单最多列多少个项目 */
export const MCP_TOKEN_MAX_PROJECTS = 50;
/** 每个用户最多同时持有多少个未吊销、未过期的 MCP 令牌 */
export const MCP_TOKEN_MAX_ACTIVE_PER_USER = 20;

/** 令牌种类：目前只有个人令牌；预留给以后的 OAuth 2.1 访问令牌（ADR 0014） */
export const mcpTokenKindSchema = z.enum(['personal']);
export type McpTokenKind = z.infer<typeof mcpTokenKindSchema>;

/**
 * scope：
 * - read：读项目、模型、DDL、版本链、迁移预览、环境的平台缓存状态与画布修改历史（只读，不能恢复；基线，总是包含）；
 * - verify：在影子库上验证迁移（等同界面的 model.verify，不连目标库）；
 * - write：在工作副本上整批原子执行 mutator（走同步层的冲突规则，需要项目编辑者以上），以及经 manage_sections 增量调整画布板块（纯布局层）。
 */
export const mcpScopeSchema = z.enum(['read', 'verify', 'write']);
export type McpScope = z.infer<typeof mcpScopeSchema>;
/** 创建时可额外勾选的 scope（read 总是包含） */
export const mcpExtraScopeSchema = z.enum(['verify', 'write']);
export type McpExtraScope = z.infer<typeof mcpExtraScopeSchema>;

/** 规范化 scope：总是包含 read，去重，按 read → verify → write 排序 */
export const normalizeMcpScopes = (scopes: readonly string[]): McpScope[] => {
  const set = new Set<string>(['read', ...scopes]);
  return mcpScopeSchema.options.filter((s) => set.has(s));
};

export const mcpTokenCreateSchema = z
  .object({
    name: z.string().trim().min(1, '请填写令牌名称').max(100, '名称最多 100 个字符'),
    /** 额外的 scope（read 总是包含） */
    scopes: z.array(mcpExtraScopeSchema).max(2).default([]),
    /** 项目白名单：null / 不给 = 我能看到的全部项目；非空 = 只允许这些项目（仍然按我当前的角色判断） */
    projectIds: z
      .array(z.string().min(1).max(100))
      .min(1, '至少选择一个项目，或者选择“全部项目”')
      .max(MCP_TOKEN_MAX_PROJECTS, `最多选择 ${MCP_TOKEN_MAX_PROJECTS} 个项目`)
      .nullable()
      .default(null),
    /** 有效天数：1～365，默认 30 */
    expiresInDays: z
      .number()
      .int('有效期必须是整数天')
      .min(1, '有效期至少 1 天')
      .max(MCP_TOKEN_MAX_DAYS, `有效期最长 ${MCP_TOKEN_MAX_DAYS} 天`)
      .default(MCP_TOKEN_DEFAULT_DAYS),
  })
  .strict();
export type McpTokenCreate = z.input<typeof mcpTokenCreateSchema>;

export type McpTokenStatus = 'active' | 'expired' | 'revoked';

/**
 * 吊销原因：
 * - self：本人吊销；admin：实例管理员在“用户”页吊销；
 * - user_disabled：账号被停用；password_reset：管理员重置密码或使用了重置密码链接（自己改密码不吊销）。
 */
export const mcpRevokeReasonSchema = z.enum(['self', 'admin', 'user_disabled', 'password_reset']);
export type McpRevokeReason = z.infer<typeof mcpRevokeReasonSchema>;

export interface McpTokenProjectRef {
  id: string;
  /** `owner/project`；项目已删除或调用者已看不到时为 null */
  path: string | null;
  name: string | null;
}

export interface McpTokenInfo {
  id: string;
  kind: McpTokenKind;
  name: string;
  /** 明文的前几位（`dwm_` + 8 个字符），只用来辨认 */
  prefix: string;
  scopes: McpScope[];
  /** null = 全部项目 */
  projects: McpTokenProjectRef[] | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedBy: { id: string; name: string } | null;
  revokedReason: McpRevokeReason | null;
  status: McpTokenStatus;
}

/** GET /api/me/mcp-tokens */
export interface McpTokenList {
  tokens: McpTokenInfo[];
  /** 实例设置“允许 MCP 访问”；关闭时不能新建令牌，已有令牌的请求一律 403 mcp_disabled */
  allowed: boolean;
}

/** POST /api/me/mcp-tokens 的结果：明文只在这一次响应里出现，服务端只存 SHA-256 */
export interface McpTokenCreated {
  token: string;
  info: McpTokenInfo;
}

/** GET /api/admin/users/:id/mcp-tokens */
export interface AdminMcpTokenList {
  tokens: McpTokenInfo[];
}

// ───── /api/mcp 的 HTTP 层错误（JSON-RPC 之外；认证、限流、开关） ─────

export const MCP_HTTP_ERROR_STATUS = {
  /** 没带 Authorization 头 */
  token_missing: 401,
  /** 格式不对、不是 dwm_、不存在 */
  token_invalid: 401,
  token_expired: 401,
  token_revoked: 401,
  /** 令牌的主人被停用（停用时令牌会被吊销，这里是兜底） */
  user_disabled: 401,
  /** 令牌主人需要先修改密码（如首次启动的临时密码） */
  password_change_required: 403,
  /** 实例关闭了“允许 MCP 访问” */
  mcp_disabled: 403,
  /** 带了 CI 令牌或其他凭据访问 /api/mcp，或者 MCP 令牌访问 /api/mcp 之外的接口 */
  forbidden: 403,
  rate_limited: 429,
} as const;
export type McpHttpErrorCode = keyof typeof MCP_HTTP_ERROR_STATUS;

export interface McpHttpErrorBody {
  error: string;
  code: McpHttpErrorCode;
}

// ───── 工具清单（tools/list 的名字；输入 schema 由服务端用 zod 4 的 z.toJSONSchema() 生成） ─────

/**
 * 每个工具需要的 scope 与项目动作（authz.ts 的 ProjectAction）。
 * 红线（ADR 0015 第 6 节）：永远不注册恢复 / 回滚画布历史、发布版本或执行迁移之类的工具（如 restore_history、
 * revert_history、rollback、publish_version、execute_migration）；这些动作只能由人工在 Dowel 界面完成。
 */
export const MCP_TOOLS = {
  list_projects: { scope: 'read', action: null },
  get_model: { scope: 'read', action: 'project.read' },
  get_table: { scope: 'read', action: 'project.read' },
  /** 按 ID / 种类 / schema / 关键字读取枚举、序列、扩展与不透明对象（视图、函数、触发器等）的完整 IR（ADR 0015 第 6 节） */
  get_objects: { scope: 'read', action: 'project.read' },
  get_ddl: { scope: 'read', action: 'ddl.read' },
  list_versions: { scope: 'read', action: 'project.read' },
  get_version: { scope: 'read', action: 'migration.read' },
  preview_migration: { scope: 'read', action: 'migration.read' },
  list_environments: { scope: 'read', action: 'environment.read' },
  /** 只读浏览画布修改历史（默认按编辑会话归组；绝不恢复历史，恢复只在 Dowel 界面由人工操作） */
  list_history: { scope: 'read', action: 'project.read' },
  /** 只读查看单步或整组历史的净变化与迁移差异（不返回完整模型、不连影子库 / 目标库） */
  get_history_diff: { scope: 'read', action: 'project.read' },
  list_mutators: { scope: 'read', action: null },
  verify_migration: { scope: 'verify', action: 'model.verify' },
  apply_changes: { scope: 'write', action: 'sync.edit' },
  /** 增量调整画布板块（纯布局层；沿用 write scope 与编辑者以上角色，不新增 scope） */
  manage_sections: { scope: 'write', action: 'sync.edit' },
} as const satisfies Record<string, { scope: McpScope; action: string | null }>;
export type McpToolName = keyof typeof MCP_TOOLS;

/** 工具层的错误码（tools/call 返回 isError: true，structuredContent.code） */
export type McpToolErrorCode =
  | 'project_not_found'
  | 'forbidden'
  | 'scope_required'
  | 'invalid_arguments'
  | 'version_not_found'
  | 'table_not_found'
  | 'section_not_found'
  /** get_history_diff：历史序号超过当前 seq 或记录不存在（附带 currentSeq） */
  | 'history_not_found'
  | 'environment_not_found'
  | 'base_seq_ahead'
  | 'conflict'
  | 'invalid'
  | 'dependency'
  | 'shadow_unavailable'
  /** 影子库句柄因环境配置变更被关闭：可重试（与 HTTP 503 shadow_config_changed 一致） */
  | 'shadow_config_changed'
  | 'rate_limited'
  | 'internal';

/** apply_changes：一次最多多少个输入操作 */
export const MCP_MAX_OPS = 100;
/** apply_changes：展开后的底层子操作上限（与 @dowel/core 的 BATCH_OPS_LIMIT 一致；整批作为 1 个 batch op 提交） */
export const MCP_MAX_EXPANDED_OPS = 500;
/** apply_changes：可选意图说明 summary 的最大长度（与 @dowel/core 的 BATCH_SUMMARY_MAX 一致） */
export const MCP_SUMMARY_MAX = 500;

/**
 * apply_changes 失败时的错误定位（tools/call 的 structuredContent 里与 code / message / currentSeq 并列）：
 * - index：出错的输入操作下标（从 0 开始；整批级错误如 baseSeq 超前时没有）；
 * - path：仅复合宏（defineTable / alterColumn）给出，形如 `defineTable(orders).foreignKeys[0]`、`alterColumn(users.email).type`；
 * - mutator：仅复合宏展开后的底层步骤出错时给出（如 `addForeignKey`）；编译期参数错误没有。
 * 普通 mutator 出错只有 index，消息保持子操作的原始错误文本；宏错误消息以 `ops[i] <path> [mutator]：` 开头。
 */
export interface McpApplyErrorLocation {
  index?: number;
  path?: string;
  mutator?: string;
}

/** apply_changes 响应附带的单条静态兼容性问题（与 @dowel/core 的 ModelCompatibilityIssue 同构） */
export interface McpCompatibilityIssue {
  code: string;
  severity: 'error' | 'warning';
  objectId?: string;
  objectName?: string;
  message: string;
  minVersion?: string;
}

/**
 * apply_changes 响应（含 dryRun）附带的写后静态自检（ADR 0015 第 5 节）：完整 validate 错误 + 基于项目最低目标环境
 * （平台库缓存的环境版本，绝不连目标库）的静态兼容性 errors / warnings；每个列表最多 50 条，total 为完整条数。
 * 不阻塞提交：画布准入门槛与界面一致，允许工作副本处于多步草稿中间态。
 */
export interface McpDiagnostics {
  /** 推导出的项目最低目标版本（如 'PG 15'）；没有缓存的环境版本或方言不区分版本时为 null */
  target: string | null;
  validation: { total: number; items: string[] };
  compatibility: {
    errors: { total: number; items: McpCompatibilityIssue[] };
    warnings: { total: number; items: McpCompatibilityIssue[] };
  };
  /** 存在 validate 错误：发布版本会被拒绝 */
  blocksPublish: boolean;
}
/** apply_changes：参数里 `$ref:<alias>` 占位符由服务端换成新的 UUIDv7 */
export const MCP_REF_PATTERN = /^\$ref:[A-Za-z0-9_.-]{1,64}$/;

// ───── 只读画布历史（ADR 0015 第 6 节：list_history / get_history_diff） ─────

/** list_history：一页最多多少条（归组视图按组计数） */
export const MCP_HISTORY_MAX_LIMIT = 50;
/** get_history_diff：迁移差异 diff.items 最多返回多少条（maxItems 的上限） */
export const MCP_HISTORY_DIFF_MAX_ITEMS = 100;
/** get_history_diff：单条差异 SQL 超过这个字符数时截断并标记 sqlTruncated */
export const MCP_HISTORY_SQL_MAX_CHARS = 2000;
/** list_history：列表里每条 opSummary 最多保留多少字符（超出截断并以 `…` 结尾；完整文本用 get_history_diff 查看） */
export const MCP_HISTORY_OP_SUMMARY_MAX_CHARS = 200;
/** get_history_diff：净变化对象列表 objects.items 最多返回多少条 */
export const MCP_HISTORY_OBJECTS_MAX_ITEMS = 200;
/** get_objects：单页返回对象的 DDL 字符总预算；超出后的对象省略 ddl 并标记 ddlOmitted */
export const MCP_OBJECTS_DDL_BUDGET = 200_000;

// ───── MCP Prompts（ADR 0015 第 6 节：引导 AI 按推荐工作流调用工具；渲染时零数据库查询） ─────

/** Prompt 参数（MCP prompts 的参数一律是字符串） */
export interface McpPromptArgumentMeta {
  name: string;
  description: string;
  required: boolean;
  /** 字符串最大长度 */
  maxLength: number;
  /** 只接受十进制非负整数字符串（如 `20`） */
  numeric?: boolean;
}

export interface McpPromptMeta {
  name: string;
  /** 注册该 Prompt 需要的 scope：write 类 Prompt 只对带 write scope 的令牌可见 */
  requiredScope: 'read' | 'write';
  description: string;
  arguments: readonly McpPromptArgumentMeta[];
}

const PROJECT_PROMPT_ARG: McpPromptArgumentMeta = {
  name: 'project',
  description: 'Project ID or `owner/project` path',
  required: true,
  maxLength: 200,
};

/** 服务端注册的 MCP Prompts（服务端与契约测试共用） */
export const MCP_PROMPTS = [
  {
    name: 'design_tables',
    requiredScope: 'write',
    description:
      'Design new tables from natural-language requirements: inspect the model, then create them in ONE atomic apply_changes call with defineTable / addForeignKey and check diagnostics.',
    arguments: [
      PROJECT_PROMPT_ARG,
      {
        name: 'requirements',
        description: 'What the new tables should model (entities, fields, relations, constraints)',
        required: true,
        maxLength: 4000,
      },
      {
        name: 'section',
        description: 'Optional canvas section (ID or name) to place the new tables in',
        required: false,
        maxLength: 100,
      },
    ],
  },
  {
    name: 'refactor_column',
    requiredScope: 'write',
    description:
      'Safely rename / retype / alter one existing column by column ID with alterColumn, after checking dependent views, checks, indexes and foreign keys via get_table.',
    arguments: [
      PROJECT_PROMPT_ARG,
      {
        name: 'table',
        description: 'Table ID, `schema.name`, or unique name',
        required: true,
        maxLength: 200,
      },
      { name: 'column', description: 'Column name or ID inside that table', required: true, maxLength: 200 },
      {
        name: 'change',
        description: 'The intended change (e.g. rename to `email_address`, widen to varchar(320))',
        required: true,
        maxLength: 1000,
      },
    ],
  },
  {
    name: 'review_unpublished_changes',
    requiredScope: 'read',
    description:
      'Review working-copy changes not yet published as a version: migration SQL risks, silent data-loss issues and the canvas history behind them.',
    arguments: [PROJECT_PROMPT_ARG],
  },
  {
    name: 'review_canvas_history',
    requiredScope: 'read',
    description:
      'Browse the grouped canvas history (edit sessions) and summarize the net change of each group, read-only.',
    arguments: [
      PROJECT_PROMPT_ARG,
      {
        name: 'beforeSeq',
        description: 'Optional cursor: only entries with seq below this value (decimal integer)',
        required: false,
        maxLength: 16,
        numeric: true,
      },
      {
        name: 'limit',
        description: `Optional page size 1..${MCP_HISTORY_MAX_LIMIT} (decimal integer)`,
        required: false,
        maxLength: 4,
        numeric: true,
      },
    ],
  },
] as const satisfies readonly McpPromptMeta[];
export type McpPromptName = (typeof MCP_PROMPTS)[number]['name'];

// ───── manage_sections（ADR 0015 第 1 节：板块是纯布局层，只开放增量语义写入，不开放像素坐标） ─────

/** manage_sections：一次最多多少个动作 */
export const MCP_MAX_SECTION_ACTIONS = 50;
/** manage_sections：单个动作最多列多少张表 */
export const MCP_MAX_SECTION_TABLES_PER_ACTION = 500;

const sectionTableIdsSchema = z
  .array(z.string().min(1).max(MAX_SECTION_TABLE_ID_LENGTH))
  .max(MCP_MAX_SECTION_TABLES_PER_ACTION);
const sectionNameSchema = z.string().trim().min(1).max(MAX_SECTION_NAME_LENGTH);
/** 板块引用：真实板块 ID，或本批更早 `create.ref` 定义的 `$ref:<alias>`；绝不按名称猜测板块 */
const sectionRefSchema = z
  .string()
  .min(1)
  .max(MAX_SECTION_ID_LENGTH)
  .refine((v) => !v.startsWith('$ref:') || SECTION_REF_PATTERN.test(v), {
    message: '板块引用必须是板块 ID 或 `$ref:<alias>`（alias 为 1–64 位字母、数字、`_`、`.`、`-`）',
  });

/** manage_sections 的单个动作；全部分支 strict，拒绝 x / y / width / height / positions 等任何坐标字段 */
export const mcpSectionActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      /** 本批内的别名：响应 refs[ref] 返回服务端生成的板块 ID，后续动作可写 `$ref:<ref>` */
      ref: z.string().regex(SECTION_REF_ALIAS_PATTERN).optional(),
      name: sectionNameSchema,
      color: sectionColorSchema.optional(),
      tables: sectionTableIdsSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('rename'), section: sectionRefSchema, name: sectionNameSchema }).strict(),
  z.object({ action: z.literal('recolor'), section: sectionRefSchema, color: sectionColorSchema }).strict(),
  z.object({ action: z.literal('delete'), section: sectionRefSchema }).strict(),
  z
    .object({
      action: z.literal('add_tables'),
      section: sectionRefSchema,
      tables: sectionTableIdsSchema.min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('remove_tables'),
      section: sectionRefSchema,
      tables: sectionTableIdsSchema.min(1),
    })
    .strict(),
]);
export type McpSectionAction = z.infer<typeof mcpSectionActionSchema>;

/** manage_sections 的输入 */
export const mcpManageSectionsInputSchema = z
  .object({
    project: z.string().min(1),
    actions: z.array(mcpSectionActionSchema).min(1).max(MCP_MAX_SECTION_ACTIONS),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type McpManageSectionsInput = z.input<typeof mcpManageSectionsInputSchema>;

// ───── 审计动作 ─────

export const MCP_AUDIT_ACTIONS = [
  'mcp_token.create',
  'mcp_token.revoke',
  /** 停用 / 重置密码时批量吊销某个用户的全部 MCP 令牌 */
  'mcp_token.revoke_all',
  /** apply_changes 成功提交（dryRun 与无净变化的 noop 不记） */
  'model.mutate',
  /** verify_migration（影子库验证） */
  'model.verify',
  /** manage_sections 成功调整画布板块（dryRun 与无净变化的 noop 不记） */
  'sections.update',
] as const;
export type McpAuditAction = (typeof MCP_AUDIT_ACTIONS)[number];
