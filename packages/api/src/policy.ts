// 执行策略（P5a，02-consensus.md 11.3，ADR 0005）：四层（实例 → 组 → 项目 → 环境）× 生产 / 非生产。
//
// 这里只有纯函数和 schema，服务端（鉴权、执行时的超时、写入校验）和界面（配置页、确认对话框）共用同一份：
// - resolvePolicy：输入四层配置，输出每个字段的生效值、来源层、上级给出的下限（“锁定”）；
// - 严格程度比较（compareField / approvalAtLeast）、写入校验（validateLayer）、放宽检测（loosenedFields）；
// - 前置环境检查（checkPrerequisite）：界面、服务端执行接口、预演共用，P6 的令牌执行也用它。
//
// **合并规则 = 逐层取更严**。每个字段都有明确的严格程度：
// - 谁能执行：仅限执行者 > 项目管理员 > 项目编辑者（全序）；
// - 允许令牌执行：不允许 > 允许（全序）；
// - 语句超时 / 锁等待超时：越短越严，0 表示不限、是最宽的（全序）——超时保护的是目标库上的业务：
//   迁移等锁、跑长语句时排在它后面的业务语句都会被挡住，越早放弃对目标库越安全；
// - 审批流程：没有自然的全序，用“子序列”偏序——F ⪯ G 当且仅当 F 的环节按原顺序全部出现在 G 里。
//   每一层只能**追加**环节（存的是本层追加的环节），生效流程 = 各层环节按 实例 → 组 → 项目 → 环境 拼接，
//   所以上级的生效流程一定是下级生效流程的前缀（前缀 ⇒ 子序列），下级不可能删掉或改动上级的环节。
//   「最后一个审批人即执行者」不参与比较：它决定的是由谁按执行按钮，不是要几个人同意；拼接后只有最后一个环节的标记生效。
// 标量字段的“逐层取更严”就是取全序上的最大值（交换、结合、幂等），所以合并结果一定不弱于任何一层显式设置的值；
// 审批流程的拼接保持子序列关系。两条都由 packages/api/test/policy.test.ts 的随机测试验证。
//
// 未设置 = 继承；四层都没设置时用默认值（POLICY_DEFAULTS），默认值不是下限：没有上级设置时，下级可以设得比默认更宽
// （和 H6 一致：项目管理员可以把生产环境的执行档位设成“项目编辑者”）。要禁止这种放宽，在上级显式设置即可。
import { z } from 'zod';

/**
 * 谁能执行：
 * - editor：项目编辑者及以上，以及执行者；admin：项目管理员，以及执行者；
 * - executor：仅限执行者（被单独授予“执行者”的用户 / 组）。
 * 执行者在任何档位下都能在授权范围内的环境上执行（执行者本来就是为此单独授权的）；档位决定的是项目角色能不能执行。
 */
export const execPolicySchema = z.enum(['editor', 'admin', 'executor']);
export type ExecPolicy = z.infer<typeof execPolicySchema>;

export const POLICY_LAYERS = ['instance', 'group', 'project', 'environment'] as const;
export type PolicyLayer = (typeof POLICY_LAYERS)[number];
export type PolicySource = PolicyLayer | 'default';

/** 超时上限：24 小时（毫秒） */
export const MAX_TIMEOUT_MS = 24 * 3600 * 1000;

/**
 * 审批人范围（P5b 才有审批的运行逻辑，P5a 只存、校验、展示）：
 * 项目所属组的组管理员 / 项目管理员 / 执行者 / 指定组的成员 / 指定组的组管理员 / 指定用户。
 */
export const approverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group_admins') }),
  z.object({ kind: z.literal('project_admins') }),
  z.object({ kind: z.literal('executors') }),
  z.object({ kind: z.literal('group_members'), groupId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('group_admins_of'), groupId: z.string().min(1).max(100) }),
  z.object({ kind: z.literal('users'), userIds: z.array(z.string().min(1).max(100)).min(1).max(50) }),
]);
export type Approver = z.infer<typeof approverSchema>;

export const approvalStageSchema = z
  .object({
    approvers: approverSchema,
    /** 需要几个人批 */
    count: z.number().int().min(1).max(10),
    /** 最后一个审批人即执行者（“通过并执行”）；只有流程的最后一个环节上的标记生效 */
    lastApproverExecutes: z.boolean().default(false),
  })
  .refine((s) => s.approvers.kind !== 'users' || s.count <= new Set(s.approvers.userIds).size, {
    message: '需要的人数不能多于指定的用户数',
  });
export type ApprovalStage = z.infer<typeof approvalStageSchema>;

const timeoutSchema = z.number().int().min(0).max(MAX_TIMEOUT_MS);

/**
 * 一层的一套设置（生产或非生产；环境层只有它自己那一套）。字段不出现 = 未设置 = 继承上级。
 * approval 是**本层追加**的环节（空数组等同于未设置）。
 */
export const policySettingsSchema = z
  .object({
    whoCanExecute: execPolicySchema.optional(),
    approval: z.array(approvalStageSchema).max(10).optional(),
    /** 允许 CI 令牌执行（P6 才接入令牌，P5a 只存和合并） */
    allowTokens: z.boolean().optional(),
    /** 每个迁移会话的 statement_timeout（毫秒，0 = 不限） */
    statementTimeoutMs: timeoutSchema.optional(),
    /** 每个迁移会话的 lock_timeout（毫秒，0 = 不限） */
    lockTimeoutMs: timeoutSchema.optional(),
  })
  .strict()
  .refine(
    (s) => !s.approval || s.approval.every((st, i, a) => !st.lastApproverExecutes || i === a.length - 1),
    {
      message: '只有最后一个审批环节能设置“最后一个审批人即执行者”',
    },
  );
export type PolicySettings = z.infer<typeof policySettingsSchema>;

/** 实例 / 组 / 项目层：生产、非生产各一套 */
export const layerPolicySchema = z
  .object({
    production: policySettingsSchema.default({}),
    nonProduction: policySettingsSchema.default({}),
  })
  .strict();
export type LayerPolicy = z.infer<typeof layerPolicySchema>;

export const SCALAR_FIELDS = ['whoCanExecute', 'allowTokens', 'statementTimeoutMs', 'lockTimeoutMs'] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];
export type PolicyField = ScalarField | 'approval';

export interface EffectiveValues {
  whoCanExecute: ExecPolicy;
  allowTokens: boolean;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
}

/**
 * 默认值（四层都没设置时）：
 * - 谁能执行：非生产 = 项目编辑者，生产 = 项目管理员（H6，小公司开箱即用）；
 * - 允许令牌执行：非生产允许、生产不允许（02-consensus.md 11.4）；
 * - 锁等待超时 5 秒：DDL 要拿 ACCESS EXCLUSIVE 之类的强锁，拿不到时后面所有业务语句都排在它后面，
 *   等得越久业务停顿越久；5 秒对业务是可以容忍的停顿，又足以等过普通的短事务；失败可以直接重试（断点续跑语义不变）；
 * - 语句超时不限：建索引、改类型重写整表这类迁移在大表上本来就要很久，中途被杀既浪费也可能留下要清理的东西
 *   （例如无效索引），默认不限、需要时由上级显式收紧。
 */
export const POLICY_DEFAULTS = (production: boolean): EffectiveValues => ({
  whoCanExecute: production ? 'admin' : 'editor',
  allowTokens: !production,
  statementTimeoutMs: 0,
  lockTimeoutMs: 5000,
});

const WHO_RANK: Record<ExecPolicy, number> = { editor: 0, admin: 1, executor: 2 };
const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
/** 超时：0 = 不限 = 无穷大，越短越严 */
const timeoutRank = (ms: number) => (ms === 0 ? Number.POSITIVE_INFINITY : ms);

/**
 * 严格程度比较：> 0 表示 a 比 b 严，< 0 表示 a 比 b 宽，0 表示一样。标量字段都是全序。
 */
export const compareField = <F extends ScalarField>(
  field: F,
  a: EffectiveValues[F],
  b: EffectiveValues[F],
) => {
  switch (field) {
    case 'whoCanExecute':
      return sign(WHO_RANK[a as ExecPolicy] - WHO_RANK[b as ExecPolicy]);
    case 'allowTokens':
      return a === b ? 0 : a === false ? 1 : -1;
    default: {
      const x = timeoutRank(a as number);
      const y = timeoutRank(b as number);
      return x === y ? 0 : x < y ? 1 : -1;
    }
  }
};

/** 两个值里更严的那个 */
export const stricterOf = <F extends ScalarField>(
  field: F,
  a: EffectiveValues[F],
  b: EffectiveValues[F],
): EffectiveValues[F] => (compareField(field, a, b) >= 0 ? a : b);

/** 审批环节相等（结构相等；users 按集合比较） */
export const sameStage = (a: ApprovalStage, b: ApprovalStage): boolean => {
  if (a.count !== b.count || a.approvers.kind !== b.approvers.kind) return false;
  const x = a.approvers;
  const y = b.approvers;
  if (x.kind === 'users' && y.kind === 'users') {
    const s = new Set(x.userIds);
    const t = new Set(y.userIds);
    return s.size === t.size && [...s].every((id) => t.has(id));
  }
  if ('groupId' in x && 'groupId' in y) return x.groupId === y.groupId;
  return true;
};

/**
 * 审批流程的严格程度（偏序）：a 至少和 b 一样严 ⇔ b 的环节按原顺序全部出现在 a 里（b 是 a 的子序列）。
 * 空流程（默认：有执行权限的人直接执行）是最宽的。
 */
export const approvalAtLeast = (a: ApprovalStage[], b: ApprovalStage[]): boolean => {
  let i = 0;
  for (const st of a) if (i < b.length && sameStage(st, b[i]!)) i++;
  return i === b.length;
};

export interface ResolvedField<T> {
  /** 生效值 */
  value: T;
  /** 生效值来自哪一层（都没设置是 default） */
  source: PolicySource;
  /** 本层（查看 / 编辑的那一层）自己的设置；没有设置为 null */
  own: T | null;
  /** 上级给出的下限（上级各层显式设置合并的结果）：本层不能设得比它宽；没有为 null */
  floor: T | null;
  /** 下限来自哪一层（界面显示“由组锁定”） */
  floorSource: PolicyLayer | null;
}

export interface ResolvedStage {
  stage: ApprovalStage;
  source: PolicyLayer;
  /** 来自上级：本层不能删改（显示为锁定） */
  locked: boolean;
}

export interface ResolvedPolicy {
  /** 按哪一套算的（环境层按环境的生产标记） */
  production: boolean;
  /** 查看 / 编辑的是哪一层：它以下的层不参与 */
  at: PolicyLayer;
  whoCanExecute: ResolvedField<ExecPolicy>;
  allowTokens: ResolvedField<boolean>;
  statementTimeoutMs: ResolvedField<number>;
  lockTimeoutMs: ResolvedField<number>;
  /** 生效的审批流程（各层追加的环节拼接）；空表示默认：单环节，有执行权限的人直接执行 */
  approval: { stages: ResolvedStage[]; own: ApprovalStage[] };
}

/** resolvePolicy 的输入：各层**已经按生产 / 非生产选好**的那一套设置 */
export type PolicyInput = Partial<Record<PolicyLayer, PolicySettings | null | undefined>>;

const layerIndex = (l: PolicyLayer) => POLICY_LAYERS.indexOf(l);

/**
 * 计算生效策略（纯函数，服务端和界面共用）。
 * - production：用哪一套的默认值（输入的各层设置应该已经按它选好）；
 * - at：从哪一层看——它以下的层不参与；`floor` 是它上面各层合并出来的下限（显示为锁定），`own` 是它自己的设置。
 */
export const resolvePolicy = (
  input: PolicyInput,
  production: boolean,
  at: PolicyLayer = 'environment',
): ResolvedPolicy => {
  const top = layerIndex(at);
  const defaults = POLICY_DEFAULTS(production);
  const scalar = <F extends ScalarField>(field: F): ResolvedField<EffectiveValues[F]> => {
    let floor: EffectiveValues[F] | null = null;
    let floorSource: PolicyLayer | null = null;
    let value: EffectiveValues[F] | null = null;
    let source: PolicySource = 'default';
    let own: EffectiveValues[F] | null = null;
    for (const layer of POLICY_LAYERS.slice(0, top + 1)) {
      const v = input[layer]?.[field] as EffectiveValues[F] | undefined;
      if (v === undefined) continue;
      if (layer === at) own = v;
      else if (floor === null || compareField(field, v, floor) > 0) {
        floor = v;
        floorSource = layer;
      }
      // 相等时保留上面那一层作为来源：下级重复设置同样的值，生效值仍然是上级定的（锁定）
      if (value === null || compareField(field, v, value) > 0) {
        value = v;
        source = layer;
      }
    }
    return { value: value ?? defaults[field], source, own, floor, floorSource };
  };
  const stages: ResolvedStage[] = [];
  for (const layer of POLICY_LAYERS.slice(0, top + 1))
    for (const stage of input[layer]?.approval ?? [])
      stages.push({ stage, source: layer, locked: layer !== at });
  return {
    production,
    at,
    whoCanExecute: scalar('whoCanExecute'),
    allowTokens: scalar('allowTokens'),
    statementTimeoutMs: scalar('statementTimeoutMs'),
    lockTimeoutMs: scalar('lockTimeoutMs'),
    approval: {
      // 拼接后只有最后一个环节的「最后一个审批人即执行者」生效
      stages: stages.map((s, i) =>
        i < stages.length - 1 && s.stage.lastApproverExecutes
          ? { ...s, stage: { ...s.stage, lastApproverExecutes: false } }
          : s,
      ),
      own: input[at]?.approval ?? [],
    },
  };
};

/** 生效值（不带来源） */
export const effectiveValues = (r: ResolvedPolicy): EffectiveValues => ({
  whoCanExecute: r.whoCanExecute.value,
  allowTokens: r.allowTokens.value,
  statementTimeoutMs: r.statementTimeoutMs.value,
  lockTimeoutMs: r.lockTimeoutMs.value,
});

export interface PolicyProblem {
  field: PolicyField;
  /** 中文说明（界面直接显示） */
  message: string;
}

const LAYER_LABEL: Record<PolicySource, string> = {
  instance: '实例',
  group: '组',
  project: '项目',
  environment: '环境',
  default: '默认',
};
export const layerLabel = (l: PolicySource) => LAYER_LABEL[l];

const WHO_LABEL: Record<ExecPolicy, string> = {
  editor: '项目编辑者',
  admin: '项目管理员',
  executor: '仅限执行者',
};
export const whoLabel = (w: ExecPolicy) => WHO_LABEL[w];

/** 超时的显示：0 = 不限；整秒显示秒，否则毫秒 */
export const timeoutLabel = (ms: number) =>
  ms === 0 ? '不限' : ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;

const FIELD_LABEL: Record<PolicyField, string> = {
  whoCanExecute: '谁能执行',
  allowTokens: '允许令牌执行',
  statementTimeoutMs: '语句超时',
  lockTimeoutMs: '锁等待超时',
  approval: '审批流程',
};
export const fieldLabel = (f: PolicyField) => FIELD_LABEL[f];

export const valueLabel = <F extends ScalarField>(field: F, v: EffectiveValues[F]): string =>
  field === 'whoCanExecute'
    ? whoLabel(v as ExecPolicy)
    : field === 'allowTokens'
      ? v
        ? '允许'
        : '不允许'
      : timeoutLabel(v as number);

/**
 * 写入校验：本层的设置不能比上级合并出来的下限更宽（下级只能收紧）。审批流程只能追加，天然满足，不在这里检查。
 * upper：上级各层（同一套，生产或非生产）的设置。返回所有问题（空数组 = 通过）。
 */
export const validateLayer = (
  upper: PolicyInput,
  own: PolicySettings,
  production: boolean,
  at: PolicyLayer,
): PolicyProblem[] => {
  const r = resolvePolicy({ ...upper, [at]: own }, production, at);
  const out: PolicyProblem[] = [];
  for (const f of SCALAR_FIELDS) {
    const field = r[f] as ResolvedField<EffectiveValues[typeof f]>;
    if (field.own === null || field.floor === null) continue;
    if (compareField(f, field.own, field.floor) < 0)
      out.push({
        field: f,
        message: `${fieldLabel(f)}不能比${layerLabel(field.floorSource!)}的设置（${valueLabel(f, field.floor)}）更宽：下级只能收紧`,
      });
  }
  return out;
};

/**
 * 改动是不是放宽了：比较同一层改动前后的生效结果，任何一个字段变宽（审批流程不再包含原来的流程）就算放宽。
 * 放宽削弱了环境保护，属于特权操作（见服务端 policy.ts）；收紧只需要这一层的管理权限。
 */
export const loosenedFields = (before: ResolvedPolicy, after: ResolvedPolicy): PolicyField[] => {
  const out: PolicyField[] = [];
  for (const f of SCALAR_FIELDS)
    if (compareField(f, after[f].value as never, before[f].value as never) < 0) out.push(f);
  if (
    !approvalAtLeast(
      after.approval.stages.map((s) => s.stage),
      before.approval.stages.map((s) => s.stage),
    )
  )
    out.push('approval');
  return out;
};

/**
 * 通用的“换了上级不能悄悄放宽”：环境的上级换了（生产标记变了、项目转了组），或者同一次请求里环境层也在改。
 * before 是改动前的生效策略；upperAfter / own / productionAfter 是改动后的上级、环境层设置和生产标记。
 * 不在 explicit 里的字段，改动后比原来宽的，把原来的生效值固定成环境层的显式设置（只会收紧）：
 * - 环境层自己设置过的也要看：它原来可能被上级盖住（例如原来生产的上级要求项目管理员、环境层写的是编辑者），
 *   换成另一套上级之后不能因此变宽；
 * - 审批流程不再包含原来的流程时，把原来的整个生效流程写进环境层：之后的生效流程 = 新上级的环节 + 原来的流程，一定包含它。
 * explicit 里的字段是这次请求明确要改的：它们变宽算“放宽”（特权操作，由调用方检查），这里不替它们固定。
 * 返回新的环境层设置和被固定的字段（审计用）。
 */
export const pinLoosened = (
  before: ResolvedPolicy,
  upperAfter: PolicyInput,
  own: PolicySettings,
  productionAfter: boolean,
  explicit: ReadonlySet<PolicyField> = new Set(),
): { settings: PolicySettings; pinned: PolicyField[] } => {
  const after = resolvePolicy({ ...upperAfter, environment: own }, productionAfter);
  const next: PolicySettings = { ...own };
  const pinned: PolicyField[] = [];
  for (const f of SCALAR_FIELDS)
    if (!explicit.has(f) && compareField(f, after[f].value as never, before[f].value as never) < 0) {
      (next as Record<string, unknown>)[f] = before[f].value;
      pinned.push(f);
    }
  const b = before.approval.stages.map((s) => s.stage);
  if (
    !explicit.has('approval') &&
    !approvalAtLeast(
      after.approval.stages.map((s) => s.stage),
      b,
    )
  ) {
    next.approval = b.map((s) => ({ ...s }));
    pinned.push('approval');
  }
  return { settings: next, pinned };
};

/** 去掉未设置的字段，空审批列表视为未设置（存储和比较前统一形状） */
export const normalizeSettings = (s: PolicySettings | null | undefined): PolicySettings => {
  const out: PolicySettings = {};
  if (!s) return out;
  if (s.whoCanExecute !== undefined) out.whoCanExecute = s.whoCanExecute;
  if (s.approval?.length) out.approval = s.approval;
  if (s.allowTokens !== undefined) out.allowTokens = s.allowTokens;
  if (s.statementTimeoutMs !== undefined) out.statementTimeoutMs = s.statementTimeoutMs;
  if (s.lockTimeoutMs !== undefined) out.lockTimeoutMs = s.lockTimeoutMs;
  return out;
};

/** 从一层（实例 / 组 / 项目）的配置里取出某一套 */
export const pickSet = (
  l: LayerPolicy | null | undefined,
  production: boolean,
): PolicySettings | undefined => (l ? (production ? l.production : l.nonProduction) : undefined);

// ───── 前置环境（E6） ─────

export interface PrerequisiteInput {
  /** 要做的事：up = 执行（向前），down = 回滚，mark / baseline 不跑脚本 */
  direction: 'up' | 'down' | 'mark' | 'baseline';
  /** 目标版本的链上序号 */
  targetNumber: number;
  /**
   * 前置环境；没有设置为 null。missing：设置了，但找不到那个环境（不应该发生——有外键——但发生了也宁可拒绝，不当作没设置）
   */
  prerequisite: { id: string; name: string; currentNumber: number | null; missing?: boolean } | null;
}

export type PrerequisiteCheck =
  | { ok: true; exempt: false; prerequisite: PrerequisiteInput['prerequisite'] }
  /** 回滚 / 标记 / 写基线不受约束（豁免，写进审计） */
  | { ok: true; exempt: true; prerequisite: NonNullable<PrerequisiteInput['prerequisite']> }
  | {
      ok: false;
      code: 'prerequisite_behind' | 'prerequisite_missing';
      message: string;
      prerequisite: NonNullable<PrerequisiteInput['prerequisite']>;
    };

/**
 * 前置环境检查：执行到本环境时，目标版本的序号不得高于前置环境的当前版本（前置环境还没执行过任何版本时，一律不能执行）。
 * 回滚不受约束：回滚是事故时的出口，回到的是本环境之前已经到过的版本（当时它已经满足了这条规则），
 * 不应该被“前置环境也得先回滚”卡住；标记为已执行和写入基线不执行脚本（ADR 0004），同样豁免。
 * 服务端执行接口、预演、确认对话框和以后的令牌执行（P6）都用这一个函数。
 */
export const checkPrerequisite = (i: PrerequisiteInput): PrerequisiteCheck => {
  const p = i.prerequisite;
  if (!p) return { ok: true, exempt: false, prerequisite: null };
  if (i.direction !== 'up') return { ok: true, exempt: true, prerequisite: p };
  if (p.missing)
    return {
      ok: false,
      code: 'prerequisite_missing',
      prerequisite: p,
      message:
        '这个环境设置的前置环境已经不存在：无法确认目标版本已经在前置环境执行过，已拒绝执行。请在执行策略里重新设置前置环境',
    };
  if (p.currentNumber !== null && i.targetNumber <= p.currentNumber)
    return { ok: true, exempt: false, prerequisite: p };
  return {
    ok: false,
    code: 'prerequisite_behind',
    prerequisite: p,
    message:
      p.currentNumber === null
        ? `前置环境“${p.name}”还没有执行过任何版本：要执行到 v${i.targetNumber}，请先在“${p.name}”上执行它`
        : `前置环境“${p.name}”当前是 v${p.currentNumber}，目标版本 v${i.targetNumber} 比它新：请先在“${p.name}”上执行到 v${i.targetNumber}`,
  };
};

/**
 * 前置环境不能成环、不能是自己：从候选的前置环境沿着各环境的前置环境往上走，走回自己就是环。
 * links：同一个项目里每个环境当前的前置环境（id → 前置环境 id）。
 */
export const prerequisiteCycle = (
  envId: string,
  candidate: string,
  links: Map<string, string | null>,
): boolean => {
  const seen = new Set<string>();
  let cur: string | null | undefined = candidate;
  while (cur) {
    if (cur === envId) return true;
    if (seen.has(cur)) return false; // 别处已有的环（不应出现），不算本次造成的
    seen.add(cur);
    cur = links.get(cur) ?? null;
  }
  return false;
};
