// CI 令牌（P6，T1～T3）的接口契约：令牌管理、“谁能创建令牌”的三层规则（纯函数，服务端和界面共用）、
// 面向 CI 的 HTTP API（/api/ci/…）的请求体、响应和错误码。规则见 ADR 0009 / 0010，实现在 apps/server/src/tokens.ts、
// routes/tokens.ts、routes/ci.ts；用户文档 docs/en/api.md 与 docs/zh/api.md。
import { z } from 'zod';

// ───── 令牌本身 ─────

/** 令牌明文的前缀：`dwl_` + 43 个 base64url 字符（32 字节随机数） */
export const TOKEN_PREFIX = 'dwl_';
/** 列表里用来辨认的前缀长度（含 `dwl_`）：后 8 个字符只占 256 位里的 48 位，不影响安全 */
export const TOKEN_DISPLAY_LENGTH = 12;
/** 令牌明文的格式（不合格式的直接拒绝，不查库） */
export const TOKEN_PATTERN = /^dwl_[A-Za-z0-9_-]{43}$/;
/** 默认有效期 90 天，最长 1 年（02-consensus.md 11.4） */
export const TOKEN_DEFAULT_DAYS = 90;
export const TOKEN_MAX_DAYS = 365;

export const ciTokenCreateSchema = z
  .object({
    name: z.string().trim().min(1, '请填写令牌名称').max(100, '名称最多 100 个字符'),
    description: z.string().trim().max(500, '说明最多 500 个字符').default(''),
    /** 有效天数：1～365，默认 90。令牌必须过期，没有“永不过期” */
    expiresInDays: z
      .number()
      .int('有效期必须是整数天')
      .min(1, '有效期至少 1 天')
      .max(TOKEN_MAX_DAYS, `有效期最长 ${TOKEN_MAX_DAYS} 天`)
      .default(TOKEN_DEFAULT_DAYS),
  })
  .strict();
export type CiTokenCreate = z.input<typeof ciTokenCreateSchema>;

export type CiTokenStatus = 'active' | 'expired' | 'revoked';

export interface CiTokenInfo {
  id: string;
  name: string;
  description: string;
  /** 明文的前几位（`dwl_` + 8 个字符），只用来辨认 */
  prefix: string;
  /** 创建者（用户被删除后为 null）；创建者离职 / 被停用不影响令牌 */
  createdBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** 最后一次使用的来源 IP（按 DOWEL_TRUST_PROXY 的规则取） */
  lastUsedIp: string | null;
  revokedAt: string | null;
  revokedBy: { id: string; name: string } | null;
  status: CiTokenStatus;
  /** 当前用户能不能吊销它（项目管理员 / 组管理员 / 实例管理员，或者令牌的创建者本人） */
  canRevoke: boolean;
}

export interface CiTokenList {
  tokens: CiTokenInfo[];
  /** 当前用户能不能创建令牌（三层规则，见 tokenCreatorAllows） */
  canCreate: boolean;
}

/** 创建结果：明文只在这一次响应里出现，服务端只存哈希 */
export interface CiTokenCreated {
  token: string;
  info: CiTokenInfo;
}

// ───── 谁能创建令牌：实例 / 组 / 项目三层，逐层只能收紧（ADR 0010） ─────

/** 项目角色条件：admin = 项目管理员；editor = 项目编辑者以上 */
export const tokenCreatorRoleSchema = z.enum(['admin', 'editor']);
export type TokenCreatorRole = z.infer<typeof tokenCreatorRoleSchema>;

/** 组条件：某个组的组管理员（admin）或成员（member，含组管理员） */
export const tokenCreatorGroupSchema = z
  .object({ groupId: z.string().min(1).max(100), role: z.enum(['admin', 'member']) })
  .strict();
export type TokenCreatorGroup = z.infer<typeof tokenCreatorGroupSchema>;

/**
 * 一层的规则：满足其中**任意一项**即可（角色条件或组条件）。两个数组都为空 = 这一层不允许任何人（实例管理员除外）。
 */
export const tokenCreatorRuleSchema = z
  .object({
    roles: z.array(tokenCreatorRoleSchema).max(2).default([]),
    groups: z.array(tokenCreatorGroupSchema).max(50, '最多 50 个组条件').default([]),
  })
  .strict();
export type TokenCreatorRule = z.infer<typeof tokenCreatorRuleSchema>;

/** PUT 的请求体：rule 为 null = 本层不设置（继承） */
export const tokenPolicyPutSchema = z.object({ rule: tokenCreatorRuleSchema.nullable() }).strict();
export type TokenPolicyPut = z.input<typeof tokenPolicyPutSchema>;

/** 三层都没设置时的默认规则：项目管理员可以创建 */
export const TOKEN_CREATOR_DEFAULT: TokenCreatorRule = { roles: ['admin'], groups: [] };

export const TOKEN_POLICY_LAYERS = ['instance', 'group', 'project'] as const;
export type TokenPolicyLayer = (typeof TOKEN_POLICY_LAYERS)[number];

export type TokenRuleLayers = Partial<Record<TokenPolicyLayer, TokenCreatorRule | null | undefined>>;

/** 判断规则用的主体：在项目里的角色（**不含**因为“能创建令牌”而得到的只读可见性）和组成员关系 */
export interface TokenCreatorSubject {
  role: 'viewer' | 'editor' | 'admin' | null;
  groups: ReadonlyMap<string, 'admin' | 'member'>;
}

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 } as const;

/** 一层规则是否满足：任一角色条件或任一组条件 */
export const ruleAllows = (rule: TokenCreatorRule, s: TokenCreatorSubject): boolean =>
  rule.roles.some((r) => s.role !== null && ROLE_RANK[s.role] >= ROLE_RANK[r]) ||
  rule.groups.some((g) => {
    const m = s.groups.get(g.groupId);
    return g.role === 'member' ? m !== undefined : m === 'admin';
  });

/** 生效的规则：设置了的各层（按实例 → 组 → 项目）；一层都没设置时是默认规则 */
export const effectiveTokenRules = (
  layers: TokenRuleLayers,
): { layer: TokenPolicyLayer | 'default'; rule: TokenCreatorRule }[] => {
  const set = TOKEN_POLICY_LAYERS.flatMap((l) => {
    const rule = layers[l];
    return rule ? [{ layer: l, rule }] : [];
  });
  return set.length ? set : [{ layer: 'default', rule: TOKEN_CREATOR_DEFAULT }];
};

/**
 * 能不能创建令牌：**每一个设置了的层都要满足**（逐层取与）。下级只能在上级允许的人里再收窄，结构上就放宽不了上级，
 * 不需要写入校验（和审批流程“只能追加”同一个思路，ADR 0005）。实例管理员由调用方另外放行。
 */
export const tokenCreatorAllows = (layers: TokenRuleLayers, s: TokenCreatorSubject): boolean =>
  effectiveTokenRules(layers).every((x) => ruleAllows(x.rule, s));

/** 规则里引用的组的显示名（id → 名字；组已删除的不在里面） */
export type TokenPolicyNames = Record<string, string>;

/** 某一层的配置页 */
export interface TokenPolicyView {
  layer: TokenPolicyLayer;
  /** 本层自己的规则；null = 继承 */
  rule: TokenCreatorRule | null;
  /** 上级设置了的层（界面灰显锁定：“另外还必须满足”） */
  upper: { layer: TokenPolicyLayer; rule: TokenCreatorRule }[];
  /** 合并后的生效规则（含本层；都没设置时是默认） */
  effective: { layer: TokenPolicyLayer | 'default'; rule: TokenCreatorRule }[];
  canEdit: boolean;
  names: TokenPolicyNames;
}

// ───── 面向 CI 的 HTTP API（/api/ci/…）：令牌认证，结构化的 JSON 错误 ─────

/**
 * 错误码 → HTTP 状态码（每个 code 固定对应一个状态码；一个状态码可以对应多个 code）。docs/en/api.md 与 docs/zh/api.md 有完整的表。
 */
export const CI_ERROR_STATUS = {
  /** 请求体 / 参数不合法 */
  invalid_request: 400,
  /** 没带 Authorization: Bearer dwl_… */
  token_missing: 401,
  /** 令牌格式不对或不存在 */
  token_invalid: 401,
  token_expired: 401,
  token_revoked: 401,
  /** 令牌不能访问这个接口（编辑、发布、改策略、标记为已执行、令牌管理……一切 /api/ci 之外的接口） */
  forbidden: 403,
  /** 环境生效的执行策略不允许令牌执行（生产默认不允许） */
  token_execution_disabled: 403,
  /** 项目不存在，或不是这个令牌所属的项目（不区分，避免探测） */
  project_not_found: 404,
  environment_not_found: 404,
  /** 目标版本不在版本链上（或项目还没有发布任何版本） */
  version_not_found: 422,
  /** 目标版本早于环境的当前版本：令牌不能回滚 */
  rollback_not_allowed: 409,
  /**
   * ADR 0013：环境停在已作废的岔路上，到目标版本要先回滚到最近公共祖先再升级。令牌不自动回滚：
   * 要在 Web 端人工确认切换（details.current 是环境当前版本）
   */
  switch_requires_web: 409,
  /** ADR 0013：目标版本已作废，不能执行到它 */
  version_retired: 409,
  /** 目标库的历史和平台的版本链对不上（当前版本不在链上、校验和不同、链被篡改……），details.reason 是具体原因 */
  version_mismatch: 409,
  /** 要执行的迁移还没有通过影子库验证 */
  unverified: 409,
  /** 目标库结构和环境当前版本的模型不一致（含第一次执行时既不是基线也不是空库，details.firstRun） */
  drift: 409,
  /** 上一次执行停在中途（含非事务步骤的迁移），要先在界面上处理 */
  unfinished_run: 409,
  /** 目标库里的这个项目由别的 Dowel 实例认领 */
  foreign_instance: 409,
  /** 其他执行前检查没通过（实例级语句等），details.reason 是执行器的原因代码 */
  rejected: 409,
  /** 等执行锁超时（另一个执行正在进行） */
  lock_timeout: 423,
  /** 执行失败（某一步 SQL 报错、语句 / 锁等待超时、读回校验不一致），环境停在 reached（最后一个成功的版本） */
  execution_failed: 422,
  /** 连不上目标库、目标库拒绝（权限不足等） */
  target_unreachable: 502,
  rate_limited: 429,
  internal: 500,
} as const;
export type CiErrorCode = keyof typeof CI_ERROR_STATUS;
export const CI_ERROR_CODES = Object.keys(CI_ERROR_STATUS) as CiErrorCode[];

export const ciVersionRefSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  name: z.string(),
});
export type CiVersionRef = z.infer<typeof ciVersionRefSchema>;

export interface CiErrorBody {
  ok: false;
  code: CiErrorCode;
  /** 给人看的说明（已脱敏） */
  error: string;
  details?: {
    /** 执行器给出的原始原因代码 */
    reason?: string;
    /** 漂移 / 读回不一致的差异（最多 100 项）和总数 */
    diff?: { kind: string; target: string; sql: string }[];
    diffTotal?: number;
    firstRun?: boolean;
    /** 执行失败的迁移和第几步 */
    version?: CiVersionRef | null;
    step?: number;
    /** 失败时目标库已被部分改动（含非事务步骤的迁移停在中途） */
    partial?: boolean;
    timeout?: { kind: 'lock' | 'statement'; ms: number };
    /** 回滚被拒绝 / 需要切换时：环境的当前版本与最近公共祖先 */
    current?: CiVersionRef | null;
    lca?: CiVersionRef | null;
    problems?: string[];
  };
  /** 执行失败时：环境停在的版本（最后一个成功的版本）；其他错误没有这一项 */
  reached?: CiVersionRef | null;
}

/** `to`：`latest`、`v5`、`5`（不区分大小写） */
export const ciTargetSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^(latest|v?\d{1,9})$/i, 'to 必须是 latest、v<序号> 或 <序号>'),
  z.number().int().nonnegative(),
]);

export const ciExecuteSchema = z
  .object({
    /** 目标版本，必须显式指定 */
    to: ciTargetSchema,
    /** 只预演：做完全部检查、列出要执行的迁移，不写目标库 */
    dryRun: z.boolean().default(false),
    /** 等执行锁的秒数（0～30，默认 30）；超时返回 lock_timeout */
    lockTimeoutSeconds: z.number().int().min(0).max(30).default(30),
  })
  .strict();
export type CiExecuteRequest = z.input<typeof ciExecuteSchema>;

export interface CiMigration {
  number: number;
  name: string;
  direction: 'up' | 'baseline';
  /** 预演时：步骤数和不在事务里的步骤数 */
  steps?: number;
  nonTransactional?: number;
}

export interface CiExecuteResult {
  ok: true;
  dryRun: boolean;
  project: string;
  environment: string;
  /** 执行前环境的当前版本（目标库历史里的；没有执行过为 null） */
  from: CiVersionRef | null;
  /** 目标版本 */
  to: CiVersionRef;
  /** 结束时环境的当前版本（预演时等于目标版本） */
  reached: CiVersionRef | null;
  /** 执行了（预演时：将要执行）的迁移，按顺序；写入基线是 direction = baseline */
  migrations: CiMigration[];
  /** 已经在目标版本，什么都没做 */
  noop: boolean;
  durationMs: number;
}

export interface CiTokenSelf {
  id: string;
  name: string;
  prefix: string;
  expiresAt: string;
  project: { id: string; name: string; slug: string; owner: string };
  createdBy: string | null;
}

export const ciEnvironmentSchema = z.object({
  name: z.string(),
  production: z.boolean(),
  /** 环境生效的执行策略是否允许令牌执行 */
  tokenExecution: z.boolean(),
});
export type CiEnvironment = z.infer<typeof ciEnvironmentSchema>;

export const ciProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  owner: z.string(),
  latest: ciVersionRefSchema.nullable(),
  environments: z.array(ciEnvironmentSchema),
});
export type CiProject = z.infer<typeof ciProjectSchema>;

export interface CiVersion extends CiVersionRef {
  publishedAt: string;
  verified: boolean;
  checksum: string;
}

export const ciEnvironmentVersionSchema = ciVersionRefSchema.extend({
  state: z.enum(['applied', 'current', 'pending', 'retired']),
  verified: z.boolean(),
});
export type CiEnvironmentVersion = z.infer<typeof ciEnvironmentVersionSchema>;

export const ciEnvironmentStatusSchema = ciEnvironmentSchema.extend({
  /** 实时读取的目标库当前版本；目标库尚无历史时为 null */
  currentVersion: ciVersionRefSchema.nullable(),
  /** 上一次执行是否停在中途（含非事务步骤的迁移） */
  unfinished: z.boolean(),
  /** 链上每个版本相对当前版本的状态 */
  versions: z.array(ciEnvironmentVersionSchema),
  /** 待执行的版本号列表（升序） */
  pending: z.array(z.number().int()),
});
export type CiEnvironmentStatus = z.infer<typeof ciEnvironmentStatusSchema>;

export const ciDriftStatusSchema = z.enum(['clean', 'drifted', 'unknown']);
export type CiDriftStatus = z.infer<typeof ciDriftStatusSchema>;

export const ciDriftItemSchema = z.object({
  kind: z.string(),
  target: z.string(),
  sql: z.string(),
});
export type CiDriftItem = z.infer<typeof ciDriftItemSchema>;

export const ciDriftNeedsManualSchema = z.object({
  direction: z.enum(['up', 'down', 'baseline']),
  versionId: z.string().nullable(),
  versionNumber: z.number().int().nullable(),
});
export type CiDriftNeedsManual = z.infer<typeof ciDriftNeedsManualSchema>;

export const ciDriftResultSchema = z.object({
  /** 环境名 */
  environment: z.string(),
  /** 实时读取的目标库当前版本；目标库尚无历史或项目尚无版本时为 null */
  currentVersion: ciVersionRefSchema.nullable(),
  /** 漂移检测结果：clean 无漂移；drifted 存在漂移；unknown 项目尚未发布任何版本、无法比对 */
  status: ciDriftStatusSchema,
  /** 本次检测完成时间（ISO 8601） */
  checkedAt: z.string(),
  /** 简明摘要说明 */
  summary: z.string(),
  /** 差异总数（可能大于 items 返回上限 100） */
  total: z.number().int().nonnegative(),
  /** 差异项列表（最多 100 项） */
  items: z.array(ciDriftItemSchema),
  /** 模型无法表达、需要人工核对的差异项（kind = unresolvable） */
  unresolvable: z.array(ciDriftItemSchema),
  /** 首次执行前目标库既非基线也非空库 */
  firstRun: z.boolean(),
  /** 差异是否来自上一次读回校验失败（需要手工修正）；否则为 null */
  needsManual: ciDriftNeedsManualSchema.nullable(),
});
export type CiDriftResult = z.infer<typeof ciDriftResultSchema>;

export interface CiHistoryRun {
  from: CiVersionRef | null;
  to: CiVersionRef;
  direction: 'up' | 'down' | 'baseline' | 'mark';
  status: 'running' | 'done' | 'failed';
  error: string | null;
  via: 'web' | 'ci';
  executedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CiHistory {
  currentVersion: CiVersionRef | null;
  unfinished: boolean;
  runs: CiHistoryRun[];
}
