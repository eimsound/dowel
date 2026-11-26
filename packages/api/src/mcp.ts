// MCP 令牌与 MCP 服务（M3-C，ADR 0014）的接口契约：个人 MCP 令牌的管理、scope、服务端 /api/mcp 的错误码与工具清单。
// 规则：
// - MCP 令牌属于**用户**（不是项目）：权限 = 用户当前生效角色 ∩ 令牌 scope ∩ 可选的项目白名单；修改和审计都记在本人名下（data.via = 'mcp'）。
// - scope 正交：read 是基线（总是包含）；verify 只授权影子库验证；write 只授权工作副本的整批原子修改。
// - MCP 永远不连目标库：环境状态 / 漂移只读平台缓存（带缓存时间）；不能发布版本、不能执行 / 申请执行 / 回滚 / 标记 / 写基线。
// - 令牌只能访问 POST /api/mcp；/api/mcp 只认 `Bearer dwm_…`（会话 cookie 与 CI 令牌一律拒绝）。
// 实现见 apps/server/src/mcp-tokens.ts、routes/mcp.ts、routes/mcp-tokens.ts；用户文档 docs/en/mcp.md 与 docs/zh/mcp.md。
import { z } from 'zod';

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
 * - read：读项目、模型、DDL、版本链、迁移预览、环境的平台缓存状态（基线，总是包含）；
 * - verify：在影子库上验证迁移（等同界面的 model.verify，不连目标库）；
 * - write：在工作副本上整批原子执行 mutator（走同步层的冲突规则，需要项目编辑者以上）。
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

/** 每个工具需要的 scope 与项目动作（authz.ts 的 ProjectAction） */
export const MCP_TOOLS = {
  list_projects: { scope: 'read', action: null },
  get_model: { scope: 'read', action: 'project.read' },
  get_table: { scope: 'read', action: 'project.read' },
  get_ddl: { scope: 'read', action: 'ddl.read' },
  list_versions: { scope: 'read', action: 'project.read' },
  get_version: { scope: 'read', action: 'migration.read' },
  preview_migration: { scope: 'read', action: 'migration.read' },
  list_environments: { scope: 'read', action: 'environment.read' },
  list_mutators: { scope: 'read', action: null },
  verify_migration: { scope: 'verify', action: 'model.verify' },
  apply_changes: { scope: 'write', action: 'sync.edit' },
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
  | 'environment_not_found'
  | 'base_seq_ahead'
  | 'conflict'
  | 'invalid'
  | 'dependency'
  | 'shadow_unavailable'
  | 'rate_limited'
  | 'internal';

/** apply_changes：一次最多多少个输入操作 */
export const MCP_MAX_OPS = 100;
/** apply_changes：展开后的底层子操作上限（与 @dowel/core 的 BATCH_OPS_LIMIT 一致；整批作为 1 个 batch op 提交） */
export const MCP_MAX_EXPANDED_OPS = 500;
/** apply_changes：可选意图说明 summary 的最大长度（与 @dowel/core 的 BATCH_SUMMARY_MAX 一致） */
export const MCP_SUMMARY_MAX = 500;

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
] as const;
export type McpAuditAction = (typeof MCP_AUDIT_ACTIONS)[number];
