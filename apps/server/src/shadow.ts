// 影子库上的操作：导入 DDL、闭环验证、风险分析、派生数据的规范化。
// 影子库只能是真实的 PostgreSQL 实例（targets.ts 的 pgShadow），没有兜底。

import type { StepRisk, StoredVerifyReport, VerifyReport, VerifyTargetReport } from '@dowel/api';
import {
  deepEqual,
  findInstanceLevelStatement,
  INSTANCE_LEVEL_DESCRIPTION,
  type Model,
  type Obj,
  PlanError,
  type PlanOptions,
  plan,
  type Step,
} from '@dowel/core';
import { type Db, importSnapshot, readSnapshot, reconcileIds, type ScriptStep } from '@dowel/engines';
import {
  analyze,
  build,
  InstanceLevelStatementError,
  readShadowPgMajor,
  resetShadow,
  runSteps,
  StepError,
  type VerifyScriptsOptions,
  verify,
  verifyScripts,
} from '@dowel/verifier';

import { scrubSecrets } from './secrets.ts';

/**
 * 已经通过 assertImportable 检查的导入 SQL（品牌类型）：shadowOps.importSql 只接受它，
 * 所以检查只在入口做一次，下游不用（也不能）再扫一遍，也不可能漏掉检查。
 */
export type ImportableSql = string & { readonly __importable: unique symbol };

export interface ShadowVerifyScriptsOptions extends VerifyScriptsOptions {
  /** 跳过锁和重写风险分析（多版本影子库验证时，只在首个/最低版本影子库分析一次） */
  skipRisk?: boolean;
}

export interface Shadow {
  /** 在空的影子库里执行一段已检查过的 DDL（assertImportable），读出结构并导入成 IR（只读 schema 范围内的） */
  importSql(sql: ImportableSql): Promise<Model>;
  /** 闭环验证 from → to，并分析每一步的锁和重写 */
  verify(from: Model, to: Model, opts?: PlanOptions): Promise<VerifyReport>;
  /**
   * 闭环验证**给定的脚本**（冻结的 up / down，可能被人工改过），不重新 plan：建 from → 执行 up → 必须等于 to →
   * 执行 down → 必须等于 from，并分析 up 每一步的锁和重写。
   */
  verifyScripts(
    from: Model,
    to: Model,
    up: ScriptStep[],
    down: ScriptStep[],
    options?: ShadowVerifyScriptsOptions,
  ): Promise<VerifyReport>;
  /**
   * 派生数据（04-ir-design.md 2.6）：建出 prev（已规范化的版本），执行到 next 的迁移，读回引擎输出，
   * 返回 next 中表达式（CHECK、默认值、生成列、索引）或不透明对象 DDL 与引擎规范形式不同的对象（已换成规范形式）。
   */
  canonicalize(prev: Model, next: Model): Promise<Obj[]>;
  close(): Promise<void>;
}

export class ShadowError extends Error {}

/**
 * 影子库的基础设施故障（连不上、被占用、超时、连接断开……）：消息统一带“影子库不可用：”前缀，**只在这里加一次**。
 * 各路由直接用 e.message，走全局 422 映射的地方（/verify、canonicalize 等）也带着它。
 * “没有环境 / 生产环境禁止 / 拒绝使用这个库”这类配置性的 ShadowError 保持原来的文案，不用这个类。
 */
export class ShadowUnavailableError extends ShadowError {
  constructor(reason: string) {
    super(`影子库不可用：${reason}`);
  }
}

/**
 * 去掉 pg_dump 输出里的所有者和权限语句：所有者、权限不在 IR 的范围内，
 * 而且对应的角色在影子库所在实例上往往不存在。pg_dump 中这些语句都是单行的。
 */
export const stripOwnership = (sql: string): string =>
  sql
    .split('\n')
    .filter((l) => !/^\s*(ALTER\s.+\sOWNER TO\s.+;|GRANT\s.+;|REVOKE\s.+;)\s*$/i.test(l))
    .join('\n');

const codeOf = (e: unknown): string | null => {
  const code = ((e instanceof StepError ? e.cause : e) as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};
const messageOf = (e: unknown): string => {
  const cause = e instanceof StepError ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
};

/** 影子库会话的 statement_timeout（pgShadow 连接后 SET 的值，毫秒） */
export const SHADOW_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * 57014（query_canceled）里**语句超时**这一种：影子库设了 statement_timeout，用户模型里的 DDL（很慢的物化视图、
 * 死循环的函数）也会走到这里。满足下面任一条就算语句超时：
 * - 错误消息里有 "statement timeout"（PG 的消息是 "canceling statement due to statement timeout"）；
 * - 这一步的耗时 ≥ 会话 statement_timeout 的 90%——lc_messages 可能是本地化的，消息里不一定有英文，
 *   而我们自己 SET 了超时的值、执行时又计了时。
 * 其他 57014，例如被管理员 pg_cancel_backend（很快就被取消）不是用户造成的。
 * 按耗时判断可能误判：脚本里自己 SET statement_timeout 把超时改短 / 改长，或者管理员拖了很久才取消。这两种可以接受——
 * 误判的最坏结果只是把基础设施问题记成“验证失败”，或者把用户的超时当成“影子库不可用 → 未验证”，
 * 都不会把版本误判成“已验证”。
 */
const isStatementTimeout = (e: unknown, timeoutMs: number) =>
  codeOf(e) === '57014' &&
  (/statement timeout/i.test(messageOf(e)) || (e instanceof StepError && e.elapsedMs >= timeoutMs * 0.9));

const errorOf = (e: unknown, timeoutMs: number) =>
  e instanceof StepError
    ? {
        step: e.step,
        // 报告会存进版本、发给客户端：错误消息里可能带着连接串（含密码），先脱敏
        message: scrubSecrets(
          isStatementTimeout(e, timeoutMs) ? `执行超时（超过影子库的语句超时限制）：${e.reason}` : e.reason,
        ),
      }
    : { step: null, message: scrubSecrets(e instanceof Error ? e.message : String(e)) };

/** 影子库给的完整报告 → 存进版本里的报告（up / down 就是冻结的脚本本身，不重复存） */
export const storedReport = (
  r: VerifyReport,
  shadow: string,
  extra?: { targets?: VerifyTargetReport[]; missingTargetMajor?: number | null },
): StoredVerifyReport => ({
  ok: r.ok,
  upDiff: r.upDiff,
  downDiff: r.downDiff,
  risks: r.risks,
  riskError: r.riskError,
  error: r.error,
  shadow,
  at: new Date().toISOString(),
  ...(extra?.targets?.length ? { targets: extra.targets } : {}),
  ...(extra?.missingTargetMajor !== undefined ? { missingTargetMajor: extra.missingTargetMajor } : {}),
});

/**
 * 基础设施故障 vs 用户的脚本 / 模型问题：
 * - 连接类：08 连接异常、53 资源不足、57P 管理员关闭 / 崩溃、55P03 拿不到锁（lock_timeout）、58030 io_error、
 *   postgres.js 和 Node 的连接 / 网络错误（字符串 code）、ShadowError：**出现在任何地方**都是影子库的问题
 *   （isConnectionFailure）；
 * - 执行步骤时抛出的 StepError（建 from / 建 to / 执行被验证的脚本）里，下面两种算用户的 DDL 自己造成的——
 *   用户模型里的不透明对象（C 函数、很慢的物化视图）和迁移脚本同样可能触发——按验证失败（ok:false 带报告）处理：
 *   · 58 类里 58030 以外的（58P01 文件不存在、58P02 文件无法创建，例如 `LANGUAGE C` 引用不存在的库）；
 *   · 57014 且原因是语句超时（见 isStatementTimeout，报告写“执行超时”）；
 * - 其余的 57014（例如管理员 pg_cancel_backend）、以及出现在步骤之外的操作里（readSnapshot、重置、pinSession）
 *   的 57014 / 58 类，都是影子库的问题。
 */
const CONNECTION_SQLSTATE = /^(08|53|57P)|^(55P03|58030)$/;
const CONNECTION_CODE =
  /^(CONNECTION_|CONNECT_TIMEOUT|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/;

/** 连接类故障（任何地方出现都是影子库的问题） */
export const isConnectionFailure = (e: unknown): boolean => {
  if ((e instanceof StepError ? e.cause : e) instanceof ShadowError) return true;
  const code = codeOf(e);
  return code !== null && (CONNECTION_SQLSTATE.test(code) || CONNECTION_CODE.test(code));
};

/** 影子库的问题：连接类故障，或者不是“用户的步骤自己造成的” 57014 / 58 类 */
export const isInfraFailure = (e: unknown, timeoutMs = SHADOW_STATEMENT_TIMEOUT_MS): boolean => {
  if (isConnectionFailure(e)) return true;
  const code = codeOf(e);
  if (code === null || !(code === '57014' || code.startsWith('58'))) return false;
  return !(e instanceof StepError && (code.startsWith('58') || isStatementTimeout(e, timeoutMs)));
};

/**
 * 基础设施故障 → ShadowError（带“影子库不可用：”前缀，见 ShadowUnavailableError）；
 * 已经是 ShadowError 的（包括配置性的、以及已经带前缀的）原样用，不重复加。
 */
export const toShadowError = (e: unknown): ShadowError => {
  const cause = e instanceof StepError ? e.cause : e;
  if (cause instanceof ShadowError) return cause;
  // 驱动错误里可能带着连接串（含密码），发给客户端之前遮掉
  return new ShadowUnavailableError(scrubSecrets(cause instanceof Error ? cause.message : String(cause)));
};

/**
 * 验证里出的错分两类：
 * - 用户的脚本 / 模型有问题（执行某一步 SQL 报错，包括 57014 超时和 58 类、结构对不上）→ ok:false 的报告；
 * - 影子库的问题（见 isInfraFailure）→ 抛 ShadowError，调用方保持原有的验证状态，
 *   不能把“影子库出了问题”记成“脚本没通过”。
 * 既不是 StepError、也不是已知的基础设施故障的异常（读结构时出了意外等）原样抛出。
 */
const failedReport = (e: unknown, timeoutMs: number): VerifyReport => {
  // 脚本里有实例级语句：一条都没有执行，直接判验证失败并说明原因
  if (e instanceof InstanceLevelStatementError)
    return {
      ok: false,
      up: [],
      down: [],
      upDiff: [],
      downDiff: [],
      risks: [],
      error: { step: e.step, message: scrubSecrets(e.message) },
    };
  if (isInfraFailure(e, timeoutMs)) throw toShadowError(e);
  if (!(e instanceof StepError)) throw e;
  return { ok: false, up: [], down: [], upDiff: [], downDiff: [], risks: [], error: errorOf(e, timeoutMs) };
};

/**
 * 风险分析是附带信息，不能影响验证结论，也不能掩盖失败：
 * - 影子库的问题（isInfraFailure：连接类故障、管理员取消等）→ 抛 ShadowError；
 * - 其他任何错误（语句超时、58P01、事务里不能执行的语句……）→ ok 不变，风险为空，**如实写进 riskError**
 *   （“风险分析没有完成：…”），界面在风险列表的位置显示它，不会显示成“没有风险”。
 */
const risksOf = async (
  d: Db,
  from: Model,
  steps: Step[],
  timeoutMs: number,
): Promise<{ risks: StepRisk[]; riskError?: string }> => {
  try {
    return { risks: await analyze(d, from, steps) };
  } catch (e) {
    if (isInfraFailure(e, timeoutMs)) throw toShadowError(e);
    // riskError 只存原因本身，不带“风险分析没有完成：”——这个前缀由界面的标题 / i18n 模板提供
    // errorOf 已经脱敏；其他错误的消息同样脱敏（riskError 会存进版本、发给客户端）
    const reason =
      e instanceof StepError
        ? errorOf(e, timeoutMs).message
        : scrubSecrets(e instanceof Error ? e.message : String(e));
    return { risks: [], riskError: reason };
  }
};

/**
 * 导入 SQL 的入口检查（向导、POST /import 共用，**只在入口扫一遍**）：含实例级语句就抛 ShadowError（HTTP 422），
 * 通过则返回品牌类型 ImportableSql，shadowOps.importSql 只接受它。要在准备影子库**之前**调用
 * （命中就不建 {库名}_dowel、不拿影子库的检查锁、不执行任何东西），向导里还要在连接限速**之后**。
 * 这只是防误操作，不是安全边界（挡不住 DO 块里 EXECUTE 的动态 SQL）；
 * 真正的边界是影子库的账号权限和“生产环境默认不在同一实例上建影子库”。
 */
export const assertImportable = (sql: string): ImportableSql => {
  const hit = findInstanceLevelStatement(sql);
  if (hit !== null) throw new ShadowError(`导入的 SQL 含实例级语句（${hit}）。${INSTANCE_LEVEL_DESCRIPTION}`);
  return sql as ImportableSql;
};

export const shadowOps = (
  db: () => Promise<Db>,
  schemas?: string[] | null,
  /** 影子库会话的 statement_timeout（毫秒），判断 57014 是不是语句超时时用；测试里可以调小 */
  { statementTimeoutMs = SHADOW_STATEMENT_TIMEOUT_MS }: { statementTimeoutMs?: number } = {},
) => ({
  importSql: async (sql: ImportableSql): Promise<Model> => {
    const d = await db();
    await resetShadow(d);
    await d.exec('CREATE SCHEMA public');
    try {
      await d.exec(`SET search_path = public; ${stripOwnership(sql)}`);
    } catch (e) {
      // 不在这里脱敏：错误只会走全局 onError（422）或 SSE 的 send，出口统一过 scrubSecrets
      throw new ShadowError(e instanceof Error ? e.message : String(e));
    }
    return importSnapshot(await readSnapshot(d, schemas));
  },
  canonicalize: async (prev: Model, next: Model): Promise<Obj[]> => {
    const d = await db();
    const pgMajor = await readShadowPgMajor(d);
    const planOpts = pgMajor !== null ? { pgMajor } : undefined;
    let steps: Step[] | null = null;
    try {
      steps = plan(prev, next, planOpts);
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
    }
    if (steps !== null) {
      await build(d, prev, planOpts);
      await runSteps(d, steps);
    } else {
      // 未发布表发生普通表↔分区表互转或分区策略变更时无法增量规划：回退为从空库直接建出 next
      await build(d, next, planOpts);
    }
    // 读回引擎里的结构，按名字对回 next 的 ID，取出规范形式
    const engine = reconcileIds(next, importSnapshot(await readSnapshot(d, schemas)));
    const out: Obj[] = [];
    for (const o of Object.values(next.objects)) {
      const e = engine.objects[o.id];
      if (!e || e.kind !== o.kind) continue;
      const c = structuredClone(o) as Obj;
      if (c.kind === 'table' && e.kind === 'table') {
        if (
          c.partitionBy &&
          typeof c.partitionBy !== 'string' &&
          e.partitionBy &&
          typeof e.partitionBy !== 'string' &&
          c.partitionBy.keys.length === e.partitionBy.keys.length
        ) {
          const eKeys = e.partitionBy.keys;
          c.partitionBy = {
            ...c.partitionBy,
            keys: c.partitionBy.keys.map((k, i) => (k.expr ? { ...k, expr: eKeys[i]!.expr } : k)),
          };
        }
        if (c.partitionOf && e.partitionOf && c.partitionOf.parent === e.partitionOf.parent) {
          c.partitionOf = { ...c.partitionOf, bound: e.partitionOf.bound };
        }
      }
      if (c.kind === 'check' && e.kind === 'check') c.expr = e.expr;
      if (c.kind === 'opaque' && e.kind === 'opaque') c.ddl = e.ddl;
      if (c.kind === 'index' && e.kind === 'index' && c.elements.length === e.elements.length) {
        c.elements = c.elements.map((el, i) => (el.expr ? { ...el, expr: e.elements[i]!.expr } : el));
        c.where = e.where;
      }
      if (c.kind === 'column' && e.kind === 'column') {
        if (c.generated && e.generated) c.generated = { ...c.generated, expr: e.generated.expr };
        if (c.default && 'expr' in c.default && e.default && 'expr' in e.default)
          c.default = { expr: e.default.expr };
      }
      if (!deepEqual(c, o)) out.push(c);
    }
    return out;
  },
  verifyScripts: async (
    from: Model,
    to: Model,
    up: ScriptStep[],
    down: ScriptStep[],
    options?: ShadowVerifyScriptsOptions,
  ): Promise<VerifyReport> => {
    const d = await db();
    try {
      const r = await verifyScripts(d, from, to, up, down, options);
      const risk = options?.skipRisk ? { risks: [] } : await risksOf(d, from, r.up, statementTimeoutMs);
      return {
        ok: !r.upDiff.length && !r.downDiff.length,
        ...r,
        ...risk,
        error: null,
        shadowMajor: r.shadowMajor,
      };
    } catch (e) {
      return failedReport(e, statementTimeoutMs);
    }
  },
  verify: async (from: Model, to: Model, opts?: PlanOptions): Promise<VerifyReport> => {
    const d = await db();
    try {
      const r = await verify(d, from, to, opts);
      const risk = await risksOf(d, from, r.up, statementTimeoutMs);
      return {
        ok: !r.upDiff.length && !r.downDiff.length,
        ...r,
        ...risk,
        error: null,
        shadowMajor: r.shadowMajor,
      };
    } catch (e) {
      return failedReport(e, statementTimeoutMs);
    }
  },
});
