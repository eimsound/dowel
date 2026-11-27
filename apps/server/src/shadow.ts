// 影子库上的操作：导入 DDL、闭环验证、风险分析、派生数据的规范化。
// PG 使用真实 PostgreSQL 影子库实例；SQLite 使用进程内 `:memory:` 影子库。

import type { StepRisk, StoredVerifyReport, VerifyReport, VerifyTargetReport } from '@dowel/api';
import {
  deepEqual,
  type Dialect,
  findInstanceLevelStatement,
  ident,
  instanceLevelDescription,
  type Model,
  type Obj,
  PlanError,
  type PlanOptions,
  plan,
  type Step,
} from '@dowel/core';
import {
  type Db,
  getEngine,
  mssqlErrorCode,
  mssqlErrorNumber,
  reconcileIds,
  type ScriptStep,
} from '@dowel/engines';
import {
  analyze,
  type AnalyzeOptions,
  buildTarget,
  InstanceLevelStatementError,
  runSteps,
  StepError,
  type VerifyScriptsOptions,
  verify,
  verifyScripts,
} from '@dowel/verifier';

import { hasRenamedOpaqueDeps } from './derive-pending.ts';
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
   * 派生数据（04-ir-design.md 2.6）：建出 prev（已规范化的版本）并执行到 next 的迁移（若规划抛 `PlanError`，
   * 或非空 prev 建库遇非基础设施 `StepError` 且无依赖或父对象改名的不透明对象，则回退为从空库直接建出 next），
   * 读回引擎输出，返回 next 中与引擎规范形式不同的对象（已换成规范形式）。写回的字段：CHECK 的 `expr`；列表达式默认值的 `expr`；
   * 生成列的 `expr` 连同引擎推导的 `type`（MSSQL 持久化生成列还有 `notNull`）；索引表达式元素的 `expr` 与 `where`；
   * 表的分区键 `partitionBy.keys[].expr` 与分区边界 `partitionOf.bound`；不透明对象的 `ddl`。
   */
  canonicalize(prev: Model, next: Model): Promise<Obj[]>;
  close(): Promise<void>;
}

export interface ShadowErrorOptions {
  /** 为 true 表示在建立任何外部数据库连接之前就因配置前置条件失败（如未配置环境、生产环境未允许同实例影子库），不计入连库限速 */
  preConnect?: boolean;
}

export class ShadowError extends Error {
  readonly preConnect: boolean;
  constructor(message: string, options?: ShadowErrorOptions) {
    super(message);
    this.preConnect = Boolean(options?.preConnect);
  }
}

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
const errnoOf = (e: unknown): number | null => {
  const n = ((e instanceof StepError ? e.cause : e) as { errno?: unknown } | null)?.errno;
  return typeof n === 'number' ? n : null;
};
const messageOf = (e: unknown): string => {
  const cause = e instanceof StepError ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
};

/** 影子库会话的 statement_timeout（pgShadow 连接后 SET 的值，毫秒） */
export const SHADOW_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * 语句超时识别（PG 57014 query_canceled / MySQL 3024 ER_QUERY_TIMEOUT / 1969 / MSSQL ETIMEOUT & ECANCEL）：
 * - PG：错误消息含 "statement timeout"，或耗时 ≥ 会话 statement_timeout 的 90%；
 * - MySQL：errno === 3024 或 1969；
 * - MSSQL：code === 'ETIMEOUT' 或 'ECANCEL' 且消息含 timeout/超时或耗时 ≥ 90%。
 */
const isStatementTimeout = (e: unknown, timeoutMs: number) => {
  const errno = errnoOf(e);
  if (errno === 3024 || errno === 1969) return true;
  const cause = e instanceof StepError ? e.cause : e;
  const code = codeOf(e) ?? mssqlErrorCode(cause);
  if (code === '57014') {
    return (
      /statement timeout/i.test(messageOf(e)) || (e instanceof StepError && e.elapsedMs >= timeoutMs * 0.9)
    );
  }
  if (code === 'ETIMEOUT' || code === 'ECANCEL') {
    return e instanceof StepError && (/timeout|超时/i.test(messageOf(e)) || e.elapsedMs >= timeoutMs * 0.9);
  }
  return false;
};

const errorOf = (e: unknown, timeoutMs: number, dialect: Dialect = 'pg') => {
  if (!(e instanceof StepError)) {
    return { step: null, message: scrubSecrets(e instanceof Error ? e.message : String(e)) };
  }
  let msg: string;
  if (isStatementTimeout(e, timeoutMs)) {
    msg = `执行超时（超过影子库的语句超时限制）：${e.reason}`;
  } else if (dialect === 'pg' && codeOf(e) === '42501') {
    msg = `影子库权限不足（${e.reason}）。请确认当前账号拥有影子库及 schema 所有权（如 ALTER DATABASE ... OWNER TO ...;）`;
  } else {
    msg = e.reason;
  }
  // 报告会存进版本、发给客户端：错误消息里可能带着连接串（含密码），先脱敏
  return {
    step: e.step,
    message: scrubSecrets(msg),
  };
};

const isPgPrivilegeError = (e: unknown, dialect: Dialect): boolean =>
  dialect === 'pg' && codeOf(e) === '42501';

const pgShadowPrivilegeError = async (e: unknown, d: Db): Promise<ShadowError> => {
  const msg = scrubSecrets(messageOf(e));
  let dbName: string | undefined;
  let currentUser: string | undefined;
  try {
    const [r] = await d.query<{ d?: unknown; u?: unknown }>(
      'select current_database() as d, current_user as u',
    );
    if (typeof r?.d === 'string' && r.d) dbName = r.d;
    if (typeof r?.u === 'string' && r.u) currentUser = r.u;
  } catch {
    // 连接不可查或测试桩返回空数组时回退通用 SQL 占位提示
  }
  const alterSql =
    dbName && currentUser
      ? `ALTER DATABASE ${ident(dbName)} OWNER TO ${ident(currentUser)};`
      : 'ALTER DATABASE <影子库> OWNER TO <当前账号>;';
  const ownerTarget = currentUser ? ident(currentUser) : '<当前账号>';
  return new ShadowError(
    `清理影子库失败：当前账号缺少清空或操作影子库及 schema 的权限（${msg}）。请将影子库及 schema 所有权授予当前账号，例如执行：${alterSql}（如存在其他角色创建的 schema，亦需执行 ALTER SCHEMA <schema> OWNER TO ${ownerTarget};）`,
  );
};

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
  /^(CONNECTION_|CONNECT_TIMEOUT|PROTOCOL_|HANDSHAKE_|ER_CON_COUNT_ERROR|ER_SERVER_SHUTDOWN|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ESOCKET|ELOGIN|EINSTLOOKUP|ENOTOPEN)/;
const MYSQL_CONNECTION_ERRNOS = new Set([1040, 1053, 1205, 2002, 2003, 2006, 2013]);
const MSSQL_INFRA_NUMBERS = new Set([1222, 18456, 4060]);

/** 连接类故障（任何地方出现都是影子库的问题；涵盖 PG / MySQL / MSSQL / Node 网络错误） */
export const isConnectionFailure = (e: unknown): boolean => {
  const cause = e instanceof StepError ? e.cause : e;
  if (cause instanceof ShadowError) return true;
  const code = codeOf(e) ?? mssqlErrorCode(cause);
  if (code !== null && (CONNECTION_SQLSTATE.test(code) || CONNECTION_CODE.test(code))) return true;
  const errno = errnoOf(e);
  if (errno !== null && MYSQL_CONNECTION_ERRNOS.has(errno)) return true;
  const num = mssqlErrorNumber(cause);
  return num !== null && MSSQL_INFRA_NUMBERS.has(num);
};

/** 影子库的问题：连接类故障，或者不是“用户的步骤自己造成的”超时 / 58 类 / MSSQL ETIMEOUT & ECANCEL */
export const isInfraFailure = (e: unknown, timeoutMs = SHADOW_STATEMENT_TIMEOUT_MS): boolean => {
  if (isConnectionFailure(e)) return true;
  const errno = errnoOf(e);
  if (errno === 3024 || errno === 1969) return !(e instanceof StepError);
  const cause = e instanceof StepError ? e.cause : e;
  const code = codeOf(e) ?? mssqlErrorCode(cause);
  if (code === null) return false;
  if (code === '57014' || code.startsWith('58')) {
    return !(e instanceof StepError && (code.startsWith('58') || isStatementTimeout(e, timeoutMs)));
  }
  if (code === 'ETIMEOUT' || code === 'ECANCEL') {
    return !(e instanceof StepError && isStatementTimeout(e, timeoutMs));
  }
  return false;
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
const failedReport = (e: unknown, timeoutMs: number, dialect: Dialect = 'pg'): VerifyReport => {
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
  return {
    ok: false,
    up: [],
    down: [],
    upDiff: [],
    downDiff: [],
    risks: [],
    error: errorOf(e, timeoutMs, dialect),
  };
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
  dialect: Dialect = 'pg',
  analyzeOpts?: AnalyzeOptions,
): Promise<{ risks: StepRisk[]; riskError?: string }> => {
  try {
    return { risks: await analyze(d, from, steps, analyzeOpts) };
  } catch (e) {
    if (isInfraFailure(e, timeoutMs)) throw toShadowError(e);
    if (!(e instanceof StepError) && isPgPrivilegeError(e, dialect)) {
      throw await pgShadowPrivilegeError(e, d);
    }
    // riskError 只存原因本身，不带“风险分析没有完成：”——这个前缀由界面的标题 / i18n 模板提供
    // errorOf 已经脱敏；其他错误的消息同样脱敏（riskError 会存进版本、发给客户端）
    const reason =
      e instanceof StepError
        ? errorOf(e, timeoutMs, dialect).message
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
export const assertImportable = (sql: string, dialect: Dialect = 'pg'): ImportableSql => {
  const checked = dialect === 'mssql' ? getEngine('mssql').stripImportNoise(sql) : sql;
  const hit = findInstanceLevelStatement(checked, dialect);
  if (hit !== null)
    throw new ShadowError(`导入的 SQL 含实例级语句（${hit}）。${instanceLevelDescription(dialect)}`);
  return checked as ImportableSql;
};

export const shadowOps = (
  db: () => Promise<Db>,
  schemas?: string[] | null,
  /** 影子库会话的 statement_timeout（毫秒），判断 57014 是不是语句超时时用；测试里可以调小 */
  {
    statementTimeoutMs = SHADOW_STATEMENT_TIMEOUT_MS,
    dialect = 'pg',
  }: { statementTimeoutMs?: number; dialect?: Dialect } = {},
) => ({
  importSql: async (sql: ImportableSql): Promise<Model> => {
    const d = await db();
    const engine = getEngine(dialect);
    try {
      await engine.resetShadow(d);
      await engine.prepareImportShadow(d);
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      if (isPgPrivilegeError(e, dialect)) throw await pgShadowPrivilegeError(e, d);
      throw e;
    }
    try {
      const cleaned = engine.stripImportNoise(sql);
      if (dialect === 'pg') {
        await d.exec(`SET search_path = public; ${cleaned}`);
      } else {
        await engine.execStepSql(d, cleaned);
      }
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      if (isPgPrivilegeError(e, dialect)) throw await pgShadowPrivilegeError(e, d);
      // 不在这里脱敏：错误只会走全局 onError（422）或 SSE 的 send，出口统一过 scrubSecrets
      throw new ShadowError(e instanceof Error ? e.message : String(e));
    }
    return engine.importSnapshot(await engine.readSnapshot(d, schemas));
  },
  canonicalize: async (prev: Model, next: Model): Promise<Obj[]> => {
    let d: Db;
    try {
      d = await db();
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      throw e;
    }
    const dDialect = next.dialect;
    const engine = getEngine(dDialect);
    let planOpts: PlanOptions | undefined;
    try {
      const vNum = await engine.readVersionNum?.(d);
      planOpts = vNum !== null && vNum !== undefined ? engine.planOptionsForVersion?.(vNum) : undefined;
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      throw e;
    }
    let steps: Step[] | null = null;
    try {
      steps = plan(prev, next, planOpts);
    } catch (e) {
      if (!(e instanceof PlanError)) throw e;
    }
    try {
      if (steps !== null) {
        let builtPrev = true;
        try {
          await buildTarget(d, prev, planOpts);
        } catch (e) {
          // 基线自己建不出来（旧版本遗留 / 升级后不再兼容的基线）：没有依赖改名的不透明对象时，
          // 直接从空库建出 next 与增量迁移等价，借此自愈；否则（需要引擎改写引用）只能如实报错
          const prevNonEmpty = Object.keys(prev.objects).length > 0;
          if (!(e instanceof StepError) || !prevNonEmpty || isInfraFailure(e, statementTimeoutMs)) throw e;
          if (hasRenamedOpaqueDeps(prev, next)) throw e;
          builtPrev = false;
        }
        if (builtPrev) await runSteps(d, steps, dDialect);
        else await buildTarget(d, next, planOpts);
      } else {
        // 未发布表发生普通表↔分区表互转或分区策略变更时无法增量规划：回退为从空库直接建出 next
        await buildTarget(d, next, planOpts);
      }
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      if (!(e instanceof StepError) && isPgPrivilegeError(e, dDialect)) {
        throw await pgShadowPrivilegeError(e, d);
      }
      throw e;
    }
    // 读回引擎里的结构，按名字对回 next 的 ID，取出规范形式
    let snapshot: Awaited<ReturnType<typeof engine.readSnapshot>>;
    try {
      snapshot = await engine.readSnapshot(d, schemas);
    } catch (e) {
      if (isInfraFailure(e, statementTimeoutMs)) throw toShadowError(e);
      throw e;
    }
    const imported = reconcileIds(next, engine.importSnapshot(snapshot));
    const out: Obj[] = [];
    for (const o of Object.values(next.objects)) {
      const e = imported.objects[o.id];
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
        if (c.generated && e.generated) {
          c.generated = { ...c.generated, expr: e.generated.expr };
          c.type = e.type;
          if (dDialect === 'mssql' && c.generated.stored) c.notNull = e.notNull;
        }
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
    const dDialect = to.dialect;
    try {
      const r = await verifyScripts(d, from, to, up, down, options);
      const risk = options?.skipRisk
        ? { risks: [] }
        : await risksOf(d, from, r.up, statementTimeoutMs, dDialect, {
            pgMajor: options?.pgMajor,
            mysqlVersionNum: options?.mysqlVersionNum,
            reuseShadowFrom: options?.checkDown !== false && r.upDiff.length === 0 && r.downDiff.length === 0,
          });
      return {
        ok: !r.upDiff.length && !r.downDiff.length,
        ...r,
        ...risk,
        error: null,
        shadowMajor: r.shadowMajor,
        shadowVersionNum: r.shadowVersionNum,
      };
    } catch (e) {
      if (e instanceof PlanError) {
        return {
          ok: false,
          up: [],
          down: [],
          upDiff: [],
          downDiff: [],
          risks: [],
          error: { step: null, message: scrubSecrets(e.message) },
        };
      }
      if (!(e instanceof StepError) && isPgPrivilegeError(e, dDialect)) {
        throw await pgShadowPrivilegeError(e, d);
      }
      return failedReport(e, statementTimeoutMs, dDialect);
    }
  },
  verify: async (from: Model, to: Model, opts?: PlanOptions): Promise<VerifyReport> => {
    const d = await db();
    const dDialect = to.dialect;
    try {
      const r = await verify(d, from, to, opts);
      const risk = await risksOf(d, from, r.up, statementTimeoutMs, dDialect, {
        ...opts,
        reuseShadowFrom: r.upDiff.length === 0 && r.downDiff.length === 0,
      });
      return {
        ok: !r.upDiff.length && !r.downDiff.length,
        ...r,
        ...risk,
        error: null,
        shadowMajor: r.shadowMajor,
        shadowVersionNum: r.shadowVersionNum,
      };
    } catch (e) {
      if (!(e instanceof StepError) && isPgPrivilegeError(e, dDialect)) {
        throw await pgShadowPrivilegeError(e, d);
      }
      return failedReport(e, statementTimeoutMs, dDialect);
    }
  },
});
