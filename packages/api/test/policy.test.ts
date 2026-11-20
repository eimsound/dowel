// 执行策略的纯函数（P5a）：严格程度比较、四层合并、写入校验、放宽检测、生产标记变化时的固定。
// 随机测试：任意四层配置合并后的结果不弱于任一上级（标量字段不弱于每一个显式设置的值；审批流程包含每一层的生效流程）。
// 轮数：POLICY_RUNS（默认 500，纯函数很快）。
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  type ApprovalStage,
  approvalAtLeast,
  approvalStageSchema,
  compareField,
  type ExecPolicy,
  layerPolicySchema,
  loosenedFields,
  MAX_REQUEST_TTL_HOURS,
  POLICY_DEFAULTS,
  POLICY_LAYERS,
  type PolicyInput,
  type PolicyLayer,
  type PolicySettings,
  pinLoosened,
  policySettingsSchema,
  resolvePolicy,
  SCALAR_FIELDS,
  validateLayer,
} from '../src/index.ts';

const RUNS = Number(process.env.POLICY_RUNS ?? 500);

const stage = (n: number, kind: ApprovalStage['approvers']['kind'] = 'project_admins'): ApprovalStage => ({
  approvers:
    kind === 'users'
      ? { kind, userIds: ['u1', 'u2', 'u3'] }
      : kind === 'group_members' || kind === 'group_admins_of'
        ? { kind, groupId: 'g1' }
        : { kind },
  count: n,
  lastApproverExecutes: false,
});

describe('严格程度比较', () => {
  test('谁能执行：仅限执行者 > 项目管理员 > 项目编辑者', () => {
    expect(compareField('whoCanExecute', 'executor', 'admin')).toBe(1);
    expect(compareField('whoCanExecute', 'admin', 'editor')).toBe(1);
    expect(compareField('whoCanExecute', 'editor', 'executor')).toBe(-1);
    expect(compareField('whoCanExecute', 'admin', 'admin')).toBe(0);
  });
  test('允许令牌执行：不允许 > 允许', () => {
    expect(compareField('allowTokens', false, true)).toBe(1);
    expect(compareField('allowTokens', true, false)).toBe(-1);
    expect(compareField('allowTokens', true, true)).toBe(0);
  });
  test.each(['statementTimeoutMs', 'lockTimeoutMs'] as const)('%s：越短越严，0 = 不限 = 最宽', (f) => {
    expect(compareField(f, 1000, 5000)).toBe(1);
    expect(compareField(f, 5000, 1000)).toBe(-1);
    expect(compareField(f, 0, 1)).toBe(-1);
    expect(compareField(f, 1, 0)).toBe(1);
    expect(compareField(f, 0, 0)).toBe(0);
  });
  test('申请有效期（P5b）：越短越严，没有“不限”；写入不能超过上级、超出范围的值被 schema 拒绝', () => {
    expect(compareField('requestTtlHours', 1, 24)).toBe(1);
    expect(compareField('requestTtlHours', 48, 24)).toBe(-1);
    expect(compareField('requestTtlHours', 24, 24)).toBe(0);
    const r = resolvePolicy({ group: { requestTtlHours: 8 }, environment: { requestTtlHours: 72 } }, true);
    expect(r.requestTtlHours).toMatchObject({ value: 8, source: 'group' });
    expect(
      validateLayer({ group: { requestTtlHours: 8 } }, { requestTtlHours: 72 }, true, 'environment').map(
        (p) => p.field,
      ),
    ).toEqual(['requestTtlHours']);
    expect(
      validateLayer({ group: { requestTtlHours: 8 } }, { requestTtlHours: 2 }, true, 'environment'),
    ).toEqual([]);
    expect(policySettingsSchema.safeParse({ requestTtlHours: 0 }).success).toBe(false);
    expect(policySettingsSchema.safeParse({ requestTtlHours: MAX_REQUEST_TTL_HOURS + 1 }).success).toBe(
      false,
    );
  });
  test('审批流程：子序列偏序，空流程最宽', () => {
    const a = stage(1);
    const b = stage(2, 'executors');
    const c = stage(1, 'users');
    expect(approvalAtLeast([a, b], [])).toBe(true);
    expect(approvalAtLeast([], [a])).toBe(false);
    expect(approvalAtLeast([a, b, c], [a, c])).toBe(true);
    expect(approvalAtLeast([b, a], [a, b])).toBe(false); // 顺序不同
    expect(approvalAtLeast([a], [stage(2)])).toBe(false); // 人数不同不是同一个环节
    // users 按集合比较
    const c2: ApprovalStage = { ...c, approvers: { kind: 'users', userIds: ['u3', 'u2', 'u1'] } };
    expect(approvalAtLeast([c2], [c])).toBe(true);
  });
});

describe('resolvePolicy：表驱动', () => {
  const D = (production: boolean) => POLICY_DEFAULTS(production);
  test('默认值：非生产 = 项目编辑者 / 允许令牌；生产 = 项目管理员 / 不允许令牌；锁等待 5 秒；语句不限', () => {
    expect(D(false)).toEqual({
      whoCanExecute: 'editor',
      allowTokens: true,
      statementTimeoutMs: 0,
      lockTimeoutMs: 5000,
      requestTtlHours: 24,
    });
    expect(D(true)).toEqual({
      whoCanExecute: 'admin',
      allowTokens: false,
      statementTimeoutMs: 0,
      lockTimeoutMs: 5000,
      requestTtlHours: 24,
    });
    const r = resolvePolicy({}, true);
    expect(r.whoCanExecute).toEqual({
      value: 'admin',
      source: 'default',
      own: null,
      floor: null,
      floorSource: null,
    });
    expect(r.approval.stages).toEqual([]);
  });

  const cases: {
    name: string;
    input: PolicyInput;
    production?: boolean;
    at?: PolicyLayer;
    want: Partial<
      Record<'who' | 'whoSource' | 'floor' | 'floorSource' | 'lock' | 'lockSource' | 'tokens', unknown>
    >;
  }[] = [
    {
      name: '只有环境层：就是环境层的值',
      input: { environment: { whoCanExecute: 'editor' } },
      production: true,
      want: { who: 'editor', whoSource: 'environment', floor: null },
    },
    {
      name: '组设了仅限执行者，项目想放宽到编辑者：取更严',
      input: { group: { whoCanExecute: 'executor' }, project: { whoCanExecute: 'editor' } },
      want: { who: 'executor', whoSource: 'group', floor: 'executor', floorSource: 'group' },
    },
    {
      name: '实例项目管理员 + 环境仅限执行者：环境更严',
      input: { instance: { whoCanExecute: 'admin' }, environment: { whoCanExecute: 'executor' } },
      want: { who: 'executor', whoSource: 'environment', floor: 'admin', floorSource: 'instance' },
    },
    {
      name: '下级重复设置同样的值：来源仍是上级（锁定）',
      input: { instance: { whoCanExecute: 'admin' }, project: { whoCanExecute: 'admin' } },
      want: { who: 'admin', whoSource: 'instance' },
    },
    {
      name: '锁等待：取最短；0（不限）最宽',
      input: {
        instance: { lockTimeoutMs: 0 },
        group: { lockTimeoutMs: 8000 },
        environment: { lockTimeoutMs: 3000 },
      },
      want: { lock: 3000, lockSource: 'environment', floor: null },
    },
    {
      name: '令牌：任一层不允许就不允许',
      input: {
        instance: { allowTokens: true },
        project: { allowTokens: false },
        environment: { allowTokens: true },
      },
      production: false,
      want: { tokens: false },
    },
    {
      name: '从组层看：项目和环境层不参与',
      input: {
        instance: { whoCanExecute: 'admin' },
        group: { whoCanExecute: 'editor' },
        project: { whoCanExecute: 'executor' },
      },
      at: 'group',
      want: { who: 'admin', whoSource: 'instance', floor: 'admin', floorSource: 'instance' },
    },
  ];
  test.each(cases)('$name', ({ input, production = true, at = 'environment', want }) => {
    const r = resolvePolicy(input, production, at);
    if ('who' in want) expect(r.whoCanExecute.value).toBe(want.who);
    if ('whoSource' in want) expect(r.whoCanExecute.source).toBe(want.whoSource);
    if ('floor' in want) expect(r.whoCanExecute.floor).toBe(want.floor);
    if ('floorSource' in want) expect(r.whoCanExecute.floorSource).toBe(want.floorSource);
    if ('lock' in want) expect(r.lockTimeoutMs.value).toBe(want.lock);
    if ('lockSource' in want) expect(r.lockTimeoutMs.source).toBe(want.lockSource);
    if ('tokens' in want) expect(r.allowTokens.value).toBe(want.tokens);
  });

  test('审批流程按层拼接，上级的环节锁定；只有最后一个环节的“最后一个审批人即执行者”生效', () => {
    const a = { ...stage(1), lastApproverExecutes: true };
    const b = stage(2, 'executors');
    const r = resolvePolicy({ group: { approval: [a] }, environment: { approval: [b] } }, true);
    expect(r.approval.stages.map((s) => [s.source, s.locked, s.stage.lastApproverExecutes])).toEqual([
      ['group', true, false],
      ['environment', false, false],
    ]);
    expect(r.approval.own).toEqual([b]);
    const only = resolvePolicy({ group: { approval: [a] } }, true);
    expect(only.approval.stages[0]!.stage.lastApproverExecutes).toBe(true);
  });
});

describe('写入校验、放宽检测', () => {
  test('下级比上级宽被拒，相等或更严通过；审批流程只能追加，不检查', () => {
    const upper: PolicyInput = {
      instance: { whoCanExecute: 'admin', lockTimeoutMs: 3000, allowTokens: false },
    };
    expect(validateLayer(upper, { whoCanExecute: 'editor' }, true, 'group').map((p) => p.field)).toEqual([
      'whoCanExecute',
    ]);
    expect(validateLayer(upper, { lockTimeoutMs: 10_000 }, true, 'group').map((p) => p.field)).toEqual([
      'lockTimeoutMs',
    ]);
    expect(validateLayer(upper, { lockTimeoutMs: 0 }, true, 'group').map((p) => p.field)).toEqual([
      'lockTimeoutMs',
    ]);
    expect(validateLayer(upper, { allowTokens: true }, true, 'group')[0]?.message).toContain('实例');
    expect(
      validateLayer(
        upper,
        { whoCanExecute: 'admin', lockTimeoutMs: 1000, allowTokens: false, approval: [stage(1)] },
        true,
        'group',
      ),
    ).toEqual([]);
    // 上级没设置：下级可以比默认值更宽（默认值不是下限，和 H6 一致）
    expect(validateLayer({}, { whoCanExecute: 'editor' }, true, 'environment')).toEqual([]);
  });

  test('loosenedFields：变宽的字段，审批流程不再包含原流程也算', () => {
    const before = resolvePolicy(
      { project: { whoCanExecute: 'executor', approval: [stage(1)] } },
      true,
      'project',
    );
    const after = resolvePolicy(
      { project: { whoCanExecute: 'admin', approval: [stage(2)] } },
      true,
      'project',
    );
    expect(loosenedFields(before, after)).toEqual(['whoCanExecute', 'approval']);
    const tighter = resolvePolicy(
      { project: { whoCanExecute: 'executor', approval: [stage(1), stage(2)], lockTimeoutMs: 1000 } },
      true,
      'project',
    );
    expect(loosenedFields(before, tighter)).toEqual([]);
  });

  /** 改生产标记：原来那一套上级下的生效值 → 换成另一套上级后用 pinLoosened 固定（服务端 applyEnvPolicy 就是这样用的） */
  const pinProduction = (
    own: PolicySettings,
    before: PolicyInput,
    after: PolicyInput,
    pb: boolean,
    pa: boolean,
  ) => pinLoosened(resolvePolicy({ ...before, environment: own }, pb), after, own, pa).settings;

  test('改生产标记（pinLoosened）：取消生产标记时，变宽的字段固定成原来的生效值（环境层自己设置过的不动）', () => {
    const upper: PolicyInput = { group: {} };
    const next = pinProduction({}, upper, upper, true, false);
    // 生产默认：项目管理员、不允许令牌；非生产默认更宽 → 固定
    expect(next).toEqual({ whoCanExecute: 'admin', allowTokens: false });
    const after = resolvePolicy({ ...upper, environment: next }, false);
    expect(after.whoCanExecute.value).toBe('admin');
    expect(after.allowTokens.value).toBe(false);
    // 自己设置过、且原来就是生效值的不动
    expect(pinProduction({ whoCanExecute: 'editor' }, upper, upper, true, false).whoCanExecute).toBe(
      'editor',
    );
    // 自己设置过、但原来被生产那一套的上级盖住：固定成原来的生效值
    const prodUpper: PolicyInput = { instance: { whoCanExecute: 'executor' } };
    expect(pinProduction({ whoCanExecute: 'editor' }, prodUpper, upper, true, false).whoCanExecute).toBe(
      'executor',
    );
    // 标成生产：新的一套更严，什么都不用固定
    expect(pinProduction({}, upper, upper, false, true)).toEqual({});
  });

  test('pinLoosened：换了上级（转组 / 改生产标记）时没明确改的字段变宽就固定；明确改的字段不替它固定（那是放宽，另行检查）', () => {
    const before = resolvePolicy({ group: { whoCanExecute: 'executor', lockTimeoutMs: 2000 } }, false);
    // 转组：新组什么都没设
    const r = pinLoosened(before, {}, {}, false);
    expect(r.pinned).toEqual(['whoCanExecute', 'lockTimeoutMs']);
    expect(r.settings).toEqual({ whoCanExecute: 'executor', lockTimeoutMs: 2000 });
    // 新上级一样严：什么都不用固定
    expect(
      pinLoosened(before, { group: { whoCanExecute: 'executor', lockTimeoutMs: 1000 } }, {}, false).pinned,
    ).toEqual([]);
    // 同一次请求明确改了 lockTimeoutMs：不替它固定
    const own = { lockTimeoutMs: 8000 };
    const r2 = pinLoosened(before, {}, own, false, new Set(['lockTimeoutMs']));
    expect(r2.pinned).toEqual(['whoCanExecute']);
    expect(r2.settings.lockTimeoutMs).toBe(8000);
  });

  test('schema：只有最后一个环节能设“最后一个审批人即执行者”、人数不能多于指定用户、不认识的字段被拒', () => {
    expect(
      policySettingsSchema.safeParse({ approval: [{ ...stage(1), lastApproverExecutes: true }, stage(1)] })
        .success,
    ).toBe(false);
    expect(
      policySettingsSchema.safeParse({ approval: [stage(1), { ...stage(1), lastApproverExecutes: true }] })
        .success,
    ).toBe(true);
    expect(
      approvalStageSchema.safeParse({ approvers: { kind: 'users', userIds: ['a'] }, count: 2 }).success,
    ).toBe(false);
    expect(policySettingsSchema.safeParse({ who: 'admin' }).success).toBe(false);
    expect(policySettingsSchema.safeParse({ lockTimeoutMs: -1 }).success).toBe(false);
    expect(layerPolicySchema.parse({})).toEqual({ production: {}, nonProduction: {} });
  });
});

// ───── 随机测试：只能收紧 ─────

const who = fc.constantFrom<ExecPolicy>('editor', 'admin', 'executor');
const timeout = fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 120_000 }));
const stageArb: fc.Arbitrary<ApprovalStage> = fc.record({
  approvers: fc.oneof(
    fc.constant({ kind: 'group_admins' as const }),
    fc.constant({ kind: 'project_admins' as const }),
    fc.constant({ kind: 'executors' as const }),
    fc.constantFrom('g1', 'g2').map((groupId) => ({ kind: 'group_members' as const, groupId })),
  ),
  count: fc.integer({ min: 1, max: 3 }),
  lastApproverExecutes: fc.boolean(),
});
const settings: fc.Arbitrary<PolicySettings> = fc.record(
  {
    whoCanExecute: who,
    approval: fc.array(stageArb, { maxLength: 3 }),
    allowTokens: fc.boolean(),
    statementTimeoutMs: timeout,
    lockTimeoutMs: timeout,
    // P5b：申请有效期（越短越严，没有“不限”）
    requestTtlHours: fc.integer({ min: 1, max: MAX_REQUEST_TTL_HOURS }),
  },
  { requiredKeys: [] },
);
const layers = fc.record(
  { instance: settings, group: settings, project: settings, environment: settings },
  { requiredKeys: [] },
);

describe('随机测试：任意四层配置合并后的结果不弱于任一上级', () => {
  test('标量字段不弱于每一层显式设置的值；也不弱于每个上级的生效值（上级有显式设置时）', () => {
    fc.assert(
      fc.property(layers, fc.boolean(), (input, production) => {
        const env = resolvePolicy(input, production);
        for (const [i, layer] of POLICY_LAYERS.entries()) {
          const up = resolvePolicy(input, production, layer);
          for (const f of SCALAR_FIELDS) {
            const v = input[layer]?.[f];
            if (v !== undefined)
              expect(compareField(f, env[f].value as never, v as never)).toBeGreaterThanOrEqual(0);
            if (up[f].source !== 'default')
              expect(compareField(f, env[f].value as never, up[f].value as never)).toBeGreaterThanOrEqual(0);
            // 下限：上面各层显式值合并的结果，本层的生效值不会比它宽
            if (up[f].floor !== null)
              expect(compareField(f, up[f].value as never, up[f].floor as never)).toBeGreaterThanOrEqual(0);
          }
          // 审批流程：每个上级的生效流程都包含在下级的生效流程里（前缀，因而是子序列）
          const upStages = up.approval.stages.map((s) => s.stage);
          const envStages = env.approval.stages.map((s) => s.stage);
          expect(approvalAtLeast(envStages, upStages)).toBe(true);
          expect(envStages.slice(0, upStages.length).map((s) => s.count)).toEqual(
            upStages.map((s) => s.count),
          );
          // 锁定的环节就是上级追加的那些
          expect(
            up.approval.stages.filter((s) => s.locked).every((s) => POLICY_LAYERS.indexOf(s.source) < i),
          ).toBe(true);
        }
        // 都没设置时就是默认值
        for (const f of SCALAR_FIELDS)
          if (POLICY_LAYERS.every((l) => input[l]?.[f] === undefined))
            expect(env[f].value).toBe(POLICY_DEFAULTS(production)[f]);
      }),
      { numRuns: RUNS },
    );
  });

  test('通过写入校验的下级设置不会让生效值比上级宽；没通过的字段在合并里也被上级盖住', () => {
    fc.assert(
      fc.property(
        layers,
        fc.boolean(),
        fc.constantFrom<PolicyLayer>('group', 'project', 'environment'),
        (input, production, at) => {
          const upper: PolicyInput = {};
          for (const l of POLICY_LAYERS.slice(0, POLICY_LAYERS.indexOf(at))) upper[l] = input[l];
          const own = input[at] ?? {};
          const problems = validateLayer(upper, own, production, at);
          const r = resolvePolicy({ ...upper, [at]: own }, production, at);
          for (const f of SCALAR_FIELDS) {
            const bad = problems.some((p) => p.field === f);
            if (bad) expect(r[f].source).not.toBe(at);
            if (r[f].floor !== null)
              expect(compareField(f, r[f].value as never, r[f].floor as never)).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  test('换一套上级（转组）后固定的设置不会让任何字段变宽；明确改的字段之外都不变宽', () => {
    fc.assert(
      fc.property(
        layers,
        layers,
        fc.boolean(),
        fc.subarray([
          'whoCanExecute',
          'allowTokens',
          'statementTimeoutMs',
          'lockTimeoutMs',
          'requestTtlHours',
          'approval',
        ] as const),
        (a, b, production, explicitList) => {
          const { environment, ...upperBefore } = a;
          const { environment: requested, ...upperAfter } = b;
          const own = environment ?? {};
          const before = resolvePolicy({ ...upperBefore, environment: own }, production);
          const explicit = new Set(explicitList);
          const next = pinLoosened(before, upperAfter, requested ?? own, production, explicit);
          const after = resolvePolicy({ ...upperAfter, environment: next.settings }, production);
          for (const f of loosenedFields(before, after)) expect(explicit.has(f), f).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  test('改生产标记后固定的设置不会让任何字段变宽', () => {
    fc.assert(
      // 两套上级（生产 / 非生产）各自随机：换一套之后什么都不能变宽
      fc.property(layers, layers, fc.boolean(), (a, b, productionBefore) => {
        const { environment, ...upperBefore } = a;
        const { environment: _ignored, ...upperAfter } = b;
        const own = environment ?? {};
        const before = resolvePolicy({ ...upperBefore, environment: own }, productionBefore);
        const next = pinLoosened(before, upperAfter, own, !productionBefore).settings;
        const after = resolvePolicy({ ...upperAfter, environment: next }, !productionBefore);
        expect(loosenedFields(before, after)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
