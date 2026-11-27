// /api/ci OpenAPI 3.1 路由定义与响应 Schema（与 @dowel/api 中的 TS 接口保持编译期双向等价）。
// 只用于 7 个外部 CI 接口的契约描述、请求体校验与文档生成；业务接口认证和错误封装仍在 routes/ci.ts。
import {
  CI_ERROR_CODES,
  CI_ERROR_STATUS,
  type CiDriftItem,
  type CiDriftNeedsManual,
  type CiDriftResult,
  type CiEnvironment,
  type CiEnvironmentStatus,
  type CiEnvironmentVersion,
  type CiErrorBody,
  type CiErrorCode,
  type CiExecuteResult,
  type CiHistory,
  type CiHistoryRun,
  type CiMigration,
  type CiProject,
  type CiTokenSelf,
  type CiVersion,
  type CiVersionRef,
  ciExecuteSchema,
} from '@dowel/api';
import { createRoute, z } from '@hono/zod-openapi';

// ───── 共享响应与错误 Schema ─────

export const ciVersionRefOpenApiSchema = z
  .object({
    id: z.string().openapi({ description: '版本 ID', example: '01J00000000000000000000001' }),
    number: z.number().int().openapi({ description: '版本链序号', example: 5 }),
    name: z.string().openapi({ description: '版本名称', example: '订单表加备注' }),
  })
  .openapi('CiVersionRef');

export const ciErrorCodeOpenApiSchema = z
  .enum(CI_ERROR_CODES as [CiErrorCode, ...CiErrorCode[]])
  .openapi('CiErrorCode', {
    description: '机器可读的 CI 错误码（与 HTTP 状态码一一映射）',
  });

export const ciDriftItemOpenApiSchema = z
  .object({
    kind: z.string().openapi({ description: '差异类型', example: 'dropColumn' }),
    target: z.string().openapi({ description: '差异对象路径', example: 'public.orders.hotfix_col' }),
    sql: z.string().openapi({
      description: '对应差异的参考 SQL',
      example: 'ALTER TABLE public.orders DROP COLUMN hotfix_col',
    }),
  })
  .openapi('CiDriftItem');

export const ciErrorDetailsOpenApiSchema = z
  .object({
    reason: z.string().optional().openapi({ description: '执行器或系统给出的原始原因代码' }),
    diff: z
      .array(ciDriftItemOpenApiSchema)
      .optional()
      .openapi({ description: '漂移或读回校验差异（最多 100 项）' }),
    diffTotal: z.number().int().optional().openapi({ description: '差异总数（可能大于 diff 截断长度）' }),
    firstRun: z.boolean().optional().openapi({ description: '首次执行前目标库既非基线也非空库' }),
    version: ciVersionRefOpenApiSchema.nullable().optional().openapi({ description: '执行失败的迁移版本' }),
    step: z.number().int().optional().openapi({ description: '执行失败的步骤序号（从 1 开始）' }),
    partial: z
      .boolean()
      .optional()
      .openapi({ description: '失败时目标库是否已被部分改动（含非事务步骤停在中途）' }),
    timeout: z
      .object({
        kind: z.enum(['lock', 'statement']),
        ms: z.number(),
      })
      .optional()
      .openapi({ description: '超时类型与超时毫秒数' }),
    current: ciVersionRefOpenApiSchema
      .nullable()
      .optional()
      .openapi({ description: '回滚被拒或需要切换时环境当前的版本' }),
    lca: ciVersionRefOpenApiSchema
      .nullable()
      .optional()
      .openapi({ description: '环境停在已作废分支需要切换时的最近公共祖先版本' }),
    problems: z.array(z.string()).optional().openapi({ description: '预检拒绝的具体问题列表' }),
    engineVersion: z
      .string()
      .nullable()
      .optional()
      .openapi({ description: 'unverified 时目标库的数据库完整版本号（读不到为 null）' }),
    verifiedOn: z
      .array(z.string())
      .optional()
      .openapi({ description: 'unverified 时该版本已通过影子库验证的数据库完整版本号列表' }),
  })
  .openapi('CiErrorDetails');

export const ciErrorBodyOpenApiSchema = z
  .object({
    ok: z.literal(false),
    code: ciErrorCodeOpenApiSchema,
    error: z.string().openapi({ description: '给人看的脱敏错误说明' }),
    details: ciErrorDetailsOpenApiSchema.optional(),
    reached: ciVersionRefOpenApiSchema
      .nullable()
      .optional()
      .openapi({ description: '执行失败时环境停在的最后一个成功版本' }),
  })
  .openapi('CiErrorBody');

export const ciTokenSelfOpenApiSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().openapi({ example: 'dwl_AbCdEfGh' }),
    expiresAt: z.string().openapi({ format: 'date-time' }),
    project: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      owner: z.string(),
    }),
    createdBy: z.string().nullable(),
  })
  .openapi('CiTokenSelf');

export const ciEnvironmentOpenApiSchema = z
  .object({
    name: z.string(),
    production: z.boolean(),
    tokenExecution: z.boolean().openapi({ description: '环境生效执行策略是否允许 CI 令牌执行' }),
  })
  .openapi('CiEnvironment');

export const ciProjectOpenApiSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    owner: z.string(),
    latest: ciVersionRefOpenApiSchema.nullable(),
    environments: z.array(ciEnvironmentOpenApiSchema),
  })
  .openapi('CiProject');

export const ciVersionOpenApiSchema = ciVersionRefOpenApiSchema
  .extend({
    publishedAt: z.string().openapi({ format: 'date-time' }),
    verified: z.boolean(),
    checksum: z.string(),
  })
  .openapi('CiVersion');

export const ciVersionListOpenApiSchema = z.array(ciVersionOpenApiSchema).openapi('CiVersionList');

export const ciEnvironmentVersionOpenApiSchema = ciVersionRefOpenApiSchema
  .extend({
    state: z.enum(['applied', 'current', 'pending', 'retired']),
    verified: z.boolean(),
  })
  .openapi('CiEnvironmentVersion');

export const ciEnvironmentStatusOpenApiSchema = ciEnvironmentOpenApiSchema
  .extend({
    currentVersion: ciVersionRefOpenApiSchema.nullable(),
    unfinished: z.boolean(),
    versions: z.array(ciEnvironmentVersionOpenApiSchema),
    pending: z.array(z.number().int()),
  })
  .openapi('CiEnvironmentStatus');

export const ciDriftNeedsManualOpenApiSchema = z
  .object({
    direction: z.enum(['up', 'down', 'baseline']),
    versionId: z.string().nullable(),
    versionNumber: z.number().int().nullable(),
  })
  .openapi('CiDriftNeedsManual');

export const ciDriftResultOpenApiSchema = z
  .object({
    environment: z.string(),
    currentVersion: ciVersionRefOpenApiSchema.nullable(),
    status: z.enum(['clean', 'drifted', 'unknown']),
    checkedAt: z.string().openapi({ format: 'date-time' }),
    summary: z.string(),
    total: z.number().int().nonnegative(),
    items: z.array(ciDriftItemOpenApiSchema),
    unresolvable: z.array(ciDriftItemOpenApiSchema),
    firstRun: z.boolean(),
    needsManual: ciDriftNeedsManualOpenApiSchema.nullable(),
  })
  .openapi('CiDriftResult');

export const ciHistoryRunOpenApiSchema = z
  .object({
    from: ciVersionRefOpenApiSchema.nullable(),
    to: ciVersionRefOpenApiSchema,
    direction: z.enum(['up', 'down', 'baseline', 'mark']),
    status: z.enum(['running', 'done', 'failed']),
    error: z.string().nullable(),
    via: z.enum(['web', 'ci']),
    executedBy: z.string().nullable(),
    startedAt: z.string().openapi({ format: 'date-time' }),
    finishedAt: z.string().nullable().openapi({ format: 'date-time' }),
  })
  .openapi('CiHistoryRun');

export const ciHistoryOpenApiSchema = z
  .object({
    currentVersion: ciVersionRefOpenApiSchema.nullable(),
    unfinished: z.boolean(),
    runs: z.array(ciHistoryRunOpenApiSchema),
  })
  .openapi('CiHistory');

export const ciMigrationOpenApiSchema = z
  .object({
    number: z.number().int(),
    name: z.string(),
    direction: z.enum(['up', 'baseline']),
    steps: z.number().int().optional(),
    nonTransactional: z.number().int().optional(),
  })
  .openapi('CiMigration');

export const ciExecuteResultOpenApiSchema = z
  .object({
    ok: z.literal(true),
    dryRun: z.boolean(),
    project: z.string(),
    environment: z.string(),
    from: ciVersionRefOpenApiSchema.nullable(),
    to: ciVersionRefOpenApiSchema,
    reached: ciVersionRefOpenApiSchema.nullable(),
    migrations: z.array(ciMigrationOpenApiSchema),
    noop: z.boolean(),
    durationMs: z.number(),
  })
  .openapi('CiExecuteResult');

// ───── 编译期双向赋值校验：防止 OpenAPI Schema 与 @dowel/api 接口发生漂移 ─────

type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertAllTrue<T extends readonly true[]> = T;

export type CiOpenApiSchemaParityCheck = AssertAllTrue<
  [
    AssertMutuallyAssignable<z.infer<typeof ciVersionRefOpenApiSchema>, CiVersionRef>,
    AssertMutuallyAssignable<z.infer<typeof ciErrorBodyOpenApiSchema>, CiErrorBody>,
    AssertMutuallyAssignable<z.infer<typeof ciTokenSelfOpenApiSchema>, CiTokenSelf>,
    AssertMutuallyAssignable<z.infer<typeof ciEnvironmentOpenApiSchema>, CiEnvironment>,
    AssertMutuallyAssignable<z.infer<typeof ciProjectOpenApiSchema>, CiProject>,
    AssertMutuallyAssignable<z.infer<typeof ciVersionOpenApiSchema>, CiVersion>,
    AssertMutuallyAssignable<z.infer<typeof ciEnvironmentVersionOpenApiSchema>, CiEnvironmentVersion>,
    AssertMutuallyAssignable<z.infer<typeof ciEnvironmentStatusOpenApiSchema>, CiEnvironmentStatus>,
    AssertMutuallyAssignable<z.infer<typeof ciDriftItemOpenApiSchema>, CiDriftItem>,
    AssertMutuallyAssignable<z.infer<typeof ciDriftNeedsManualOpenApiSchema>, CiDriftNeedsManual>,
    AssertMutuallyAssignable<z.infer<typeof ciDriftResultOpenApiSchema>, CiDriftResult>,
    AssertMutuallyAssignable<z.infer<typeof ciHistoryRunOpenApiSchema>, CiHistoryRun>,
    AssertMutuallyAssignable<z.infer<typeof ciHistoryOpenApiSchema>, CiHistory>,
    AssertMutuallyAssignable<z.infer<typeof ciMigrationOpenApiSchema>, CiMigration>,
    AssertMutuallyAssignable<z.infer<typeof ciExecuteResultOpenApiSchema>, CiExecuteResult>,
  ]
>;

// ───── 路径参数与错误响应构造 ─────

export const ciProjectParamsSchema = z.object({
  owner: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'owner', in: 'path' },
      description: '项目所属组的标识（slug）',
      example: 'acme',
    }),
  project: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'project', in: 'path' },
      description: '项目标识（slug）',
      example: 'shop',
    }),
});

export const ciEnvParamsSchema = ciProjectParamsSchema.extend({
  env: z
    .string()
    .min(1)
    .openapi({
      param: { name: 'env', in: 'path' },
      description: '环境名称',
      example: 'staging',
    }),
});

type CiHttpErrorStatus = (typeof CI_ERROR_STATUS)[CiErrorCode];

const codesByStatus = (status: CiHttpErrorStatus): CiErrorCode[] =>
  CI_ERROR_CODES.filter((code) => CI_ERROR_STATUS[code] === status);

const ciErrorResponses = <const S extends readonly CiHttpErrorStatus[]>(statuses: S) => {
  const out: Record<
    number,
    {
      description: string;
      content: { 'application/json': { schema: typeof ciErrorBodyOpenApiSchema } };
    }
  > = {};
  for (const status of statuses) {
    const codes = codesByStatus(status);
    out[status] = {
      description: `CI 错误响应（code: ${codes.join(' | ')}）`,
      content: { 'application/json': { schema: ciErrorBodyOpenApiSchema } },
    };
  }
  return out;
};

const SECURITY = [{ ciToken: [] }];

// ───── 7 个外部 CI 业务路由的 OpenAPI 定义 ─────

export const ciTokenSelfRoute = createRoute({
  method: 'get',
  path: '/api/ci/token',
  tags: ['Token'],
  summary: '校验当前 CI 令牌并获取元数据',
  description: '供流水线自检当前令牌是否有效、所属项目以及过期时间。',
  security: SECURITY,
  responses: {
    200: {
      description: '令牌信息',
      content: { 'application/json': { schema: ciTokenSelfOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 429, 500]),
  },
});

export const ciProjectGetRoute = createRoute({
  method: 'get',
  path: '/api/ci/projects/{owner}/{project}',
  tags: ['Projects'],
  summary: '获取项目与环境列表（纯平台配置）',
  description: '返回项目基本配置、最新版本以及各环境的平台策略，不连接目标数据库。',
  security: SECURITY,
  request: { params: ciProjectParamsSchema },
  responses: {
    200: {
      description: '项目与环境配置列表',
      content: { 'application/json': { schema: ciProjectOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 429, 500]),
  },
});

export const ciVersionsListRoute = createRoute({
  method: 'get',
  path: '/api/ci/projects/{owner}/{project}/versions',
  tags: ['Projects'],
  summary: '获取项目版本链',
  description: '按版本号升序返回项目所有已发布版本及验证状态、校验和。',
  security: SECURITY,
  request: { params: ciProjectParamsSchema },
  responses: {
    200: {
      description: '按序号升序的版本列表',
      content: { 'application/json': { schema: ciVersionListOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 429, 500]),
  },
});

export const ciEnvironmentGetRoute = createRoute({
  method: 'get',
  path: '/api/ci/projects/{owner}/{project}/environments/{env}',
  tags: ['Environments'],
  summary: '获取单环境实时状态',
  description:
    '直连目标库读取迁移历史并同步平台缓存，返回实时当前版本、unfinished、版本状态与待执行列表。受连接限速约束。',
  security: SECURITY,
  request: { params: ciEnvParamsSchema },
  responses: {
    200: {
      description: '环境实时状态',
      content: { 'application/json': { schema: ciEnvironmentStatusOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 409, 429, 500, 502]),
  },
});

export const ciEnvironmentDriftRoute = createRoute({
  method: 'post',
  path: '/api/ci/projects/{owner}/{project}/environments/{env}/drift',
  tags: ['Environments'],
  summary: '执行实时漂移检测',
  description: '只读连接目标库提取完整结构快照并与当前版本模型比对，同时更新平台侧漂移状态。受连接限速约束。',
  security: SECURITY,
  request: { params: ciEnvParamsSchema },
  responses: {
    200: {
      description: '实时漂移检测结果',
      content: { 'application/json': { schema: ciDriftResultOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 409, 423, 429, 500, 502]),
  },
});

export const ciEnvironmentHistoryRoute = createRoute({
  method: 'get',
  path: '/api/ci/projects/{owner}/{project}/environments/{env}/history',
  tags: ['Environments'],
  summary: '获取目标库执行历史',
  description: '直连目标库读取最近 100 条迁移历史（新的在前）并同步平台缓存。受连接限速约束。',
  security: SECURITY,
  request: { params: ciEnvParamsSchema },
  responses: {
    200: {
      description: '目标库执行历史',
      content: { 'application/json': { schema: ciHistoryOpenApiSchema } },
    },
    ...ciErrorResponses([401, 404, 409, 429, 500, 502]),
  },
});

export const ciEnvironmentExecuteRoute = createRoute({
  method: 'post',
  path: '/api/ci/projects/{owner}/{project}/environments/{env}/execute',
  tags: ['Execution'],
  summary: '执行或预演向前迁移',
  description:
    '同步等待检查与向前迁移完成并返回结构化结果；不允许回滚。受环境生效策略“允许 CI 令牌执行”约束，绕过审批流程。',
  security: SECURITY,
  request: {
    params: ciEnvParamsSchema,
    body: {
      required: true,
      description: '执行参数（必须显式指定目标版本 to）',
      content: { 'application/json': { schema: ciExecuteSchema } },
    },
  },
  responses: {
    200: {
      description: '预演计划或实际执行结果',
      content: { 'application/json': { schema: ciExecuteResultOpenApiSchema } },
    },
    ...ciErrorResponses([400, 401, 403, 404, 409, 413, 422, 423, 429, 500, 502]),
  },
});
