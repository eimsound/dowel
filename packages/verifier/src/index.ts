// 闭环验证：迁移后的结构必须等于直接按目标版本建出来的结构；反向迁移后必须回到原来的结构。
import {
  all,
  createAll,
  find,
  findInstanceLevelStep,
  INSTANCE_LEVEL_DESCRIPTION,
  isNontransactionalSql,
  type Model,
  pgMajorOf,
  type PlanOptions,
  plan,
  type Step,
} from '@dowel/core';
import {
  type Db,
  diffSnapshots,
  pinSession,
  readSnapshot,
  type ScriptStep,
  type Snapshot,
} from '@dowel/engines';

/** 清空影子库：删掉所有用户 schema（包括 public），让 IR 完整描述库里的一切 */
export const resetShadow = async (db: Db) => {
  await pinSession(db);
  const schemas = await db.query<{ n: string }>(
    `select quote_ident(nspname) as n from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema'`,
  );
  for (const { n } of schemas) await db.exec(`DROP SCHEMA ${n} CASCADE`);
};

export class StepError extends Error {
  step: Step;
  /** 数据库给出的错误原因 */
  reason: string;
  /** 这一步执行了多久（毫秒）：错误消息被本地化时，靠耗时判断是不是撞上了语句超时 */
  elapsedMs: number;
  constructor(step: Step, cause: unknown, elapsedMs = 0) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`执行失败：${step.sql}\n  ${reason}`, { cause });
    this.step = step;
    this.reason = reason;
    this.elapsedMs = elapsedMs;
  }
}

/**
 * 迁移脚本里出现了实例级语句（CREATE / DROP / ALTER DATABASE、TABLESPACE、ROLE | USER | GROUP，ALTER SYSTEM）。
 * 影子库常常和线上库在同一个实例上，执行它们会在整个实例上留下副作用，所以**执行之前**就拒绝，绝不执行。
 */
export class InstanceLevelStatementError extends Error {
  step: Step;
  constructor(step: Step) {
    super(`${INSTANCE_LEVEL_DESCRIPTION}。语句：${step.sql}`);
    this.step = step;
  }
}

/** 执行任何一步之前先检查：有实例级语句就抛 InstanceLevelStatementError，一条都不执行 */
export const assertNoInstanceLevel = (steps: Step[]) => {
  const i = findInstanceLevelStep(steps);
  if (i >= 0) throw new InstanceLevelStatementError(steps[i]!);
};

export const runSteps = async (db: Db, steps: Step[]) => {
  assertNoInstanceLevel(steps);
  await pinSession(db);
  for (const s of steps) {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new StepError(s, e, performance.now() - t0);
    }
  }
};

/** 从影子库读取 server_version_num 并提取大版本号（用于按影子库实际 PG 版本生成建库语句） */
export const readShadowPgMajor = async (db: Db): Promise<number | null> => {
  const rows = await db.query<{ v?: unknown; server_version_num?: unknown }>('SHOW server_version_num');
  const raw = rows[0]?.server_version_num ?? rows[0]?.v;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(num) ? pgMajorOf(num) : null;
};

/** 在影子库里从零建出模型，返回读到的快照 */
export const build = async (db: Db, m: Model, opts?: PlanOptions): Promise<Snapshot> => {
  await resetShadow(db);
  const pgMajor = opts?.pgMajor !== undefined ? opts.pgMajor : await readShadowPgMajor(db);
  await runSteps(db, createAll(m, pgMajor !== null ? { pgMajor } : undefined));
  return readSnapshot(db);
};

/**
 * 对模型中非显式命名的 NOT NULL 列（notNullNameMode !== 'explicit'），将快照里该列的 notNullName 归一为 null：
 * PG 15–17 冻结的 renameTable/renameColumn 脚本不含 PG 18+ 的 RENAME CONSTRAINT ... NOT NULL，
 * 在 PG 18/19 影子库重放后仅推导约束名会残留旧名；归一化后仍严格比对 notNull 布尔值与 explicit 显式约束名。
 */
const normalizeDerivedNotNullNames = (snap: Snapshot, model: Model): Snapshot => {
  const explicitCols = new Set<string>();
  for (const col of all(model, 'column')) {
    if (!col.notNull || col.notNullNameMode !== 'explicit') continue;
    const table = find(model, col.parent);
    if (table?.kind !== 'table') continue;
    const schema = find(model, table.parent);
    if (schema?.kind !== 'schema') continue;
    explicitCols.add(`${schema.name}.${table.name}\0${col.name}`);
  }
  const tables: Snapshot['tables'] = {};
  for (const [tableKey, table] of Object.entries(snap.tables)) {
    const columns: Snapshot['tables'][string]['columns'] = {};
    for (const [colName, col] of Object.entries(table.columns)) {
      columns[colName] =
        col.notNullName !== null && !explicitCols.has(`${tableKey}\0${colName}`)
          ? { ...col, notNullName: null }
          : col;
    }
    tables[tableKey] = { ...table, columns };
  }
  return { ...snap, tables };
};

export interface VerifyResult {
  up: Step[];
  down: Step[];
  /** 迁移后与目标的差异 */
  upDiff: string[];
  /** 反向迁移后与原版本的差异 */
  downDiff: string[];
  /** 实际执行本次验证的影子库 PG 大版本（由 SHOW server_version_num 实测推导） */
  shadowMajor?: number | null;
}

/** 闭环验证（只用一个影子库，依次建目标版本、建原版本、执行迁移、执行反向迁移）。任一步执行失败抛出 StepError。 */
export const verify = async (db: Db, from: Model, to: Model, opts?: PlanOptions): Promise<VerifyResult> => {
  const shadowMajor = await readShadowPgMajor(db);
  const planMajor = opts?.pgMajor ?? shadowMajor;
  const planOpts: PlanOptions | undefined = planMajor !== null ? { pgMajor: planMajor } : undefined;
  const buildOpts: PlanOptions | undefined = shadowMajor !== null ? { pgMajor: shadowMajor } : undefined;
  const up = plan(from, to, planOpts);
  const down = plan(to, from, planOpts);
  assertNoInstanceLevel([...up, ...down]); // 规划器正常不会生成，兜底
  const toSnap = await build(db, to, buildOpts);
  const fromSnap = await build(db, from, buildOpts);
  await runSteps(db, up);
  const afterUp = await readSnapshot(db);
  await runSteps(db, down);
  const afterDown = await readSnapshot(db);
  return {
    up,
    down,
    upDiff: diffSnapshots(
      normalizeDerivedNotNullNames(afterUp, to),
      normalizeDerivedNotNullNames(toSnap, to),
    ),
    downDiff: diffSnapshots(
      normalizeDerivedNotNullNames(afterDown, from),
      normalizeDerivedNotNullNames(fromSnap, from),
    ),
    shadowMajor,
  };
};

/** 冻结脚本里的一步 → 带序号的 Step（kind 固定为 frozen，target 是“up#3”这样的位置，用于报错定位） */
const frozenSteps = (dir: 'up' | 'down', steps: ScriptStep[]): Step[] =>
  steps.map((s, i) => ({
    kind: 'frozen',
    target: `${dir}#${i + 1}`,
    sql: s.sql,
    transactional: s.transactional,
  }));

export interface VerifyScriptsOptions {
  /** 是否检查回滚。v0 基线没有回滚脚本（down 为空），只检查建库那一半 */
  checkDown?: boolean;
  /** 构建 from / to 基准结构时使用的 PG 大版本；缺省自动从影子库读取 server_version_num */
  pgMajor?: number | null;
}

/**
 * 闭环验证**给定的脚本**（发布后冻结下来的、或被人工改过的 up / down），而不是重新 plan：
 * 建出 from → 执行 up → 结构必须等于 to；再执行 down → 结构必须等于 from。
 * 每一步都是独立语句（不包事务），transactional 标记只影响真正执行时的包法，这里不关心。
 * 升级后的结构不对时不再执行 down（报告里只有 upDiff）。任一步执行失败抛出 StepError。
 */
export const verifyScripts = async (
  db: Db,
  from: Model,
  to: Model,
  up: ScriptStep[],
  down: ScriptStep[],
  options: VerifyScriptsOptions = {},
): Promise<VerifyResult> => {
  const upSteps = frozenSteps('up', up);
  const downSteps = frozenSteps('down', down);
  // 任何一步（包括建 from / to）执行之前先检查整份脚本：有实例级语句就一条都不执行
  assertNoInstanceLevel([...upSteps, ...downSteps]);
  const shadowMajor = await readShadowPgMajor(db);
  const pgMajor = options.pgMajor !== undefined ? options.pgMajor : shadowMajor;
  const buildOpts: PlanOptions | undefined = pgMajor !== null ? { pgMajor } : undefined;
  const toSnap = await build(db, to, buildOpts);
  const fromSnap = await build(db, from, buildOpts);
  await runSteps(db, upSteps);
  const afterUp = await readSnapshot(db);
  const upDiff = diffSnapshots(
    normalizeDerivedNotNullNames(afterUp, to),
    normalizeDerivedNotNullNames(toSnap, to),
  );
  // 升级没有到达目标结构时，回滚的检查没有意义（起点就不对，回滚脚本还可能因此报错、盖住升级的差异），先把升级的差异报出来
  if (options.checkDown === false || upDiff.length)
    return { up: upSteps, down: downSteps, upDiff, downDiff: [], shadowMajor };
  await runSteps(db, downSteps);
  const afterDown = await readSnapshot(db);
  return {
    up: upSteps,
    down: downSteps,
    upDiff,
    downDiff: diffSnapshots(
      normalizeDerivedNotNullNames(afterDown, from),
      normalizeDerivedNotNullNames(fromSnap, from),
    ),
    shadowMajor,
  };
};

// ───── 锁和重写分析（01-research.md 2.4 的方法） ─────

export interface StepRisk {
  /** 对迁移前就存在的表 / 索引拿的锁 */
  locks: { relation: string; mode: string }[];
  /** 被重写的表（relfilenode 变了） */
  rewrites: string[];
  /** 被全表扫描的表 */
  scans: string[];
  /** 风险等级：high = 重写整表或长时间阻塞读写；medium = 全表扫描并阻塞、或阻塞写入；low = 只是短暂的元数据锁 */
  level: 'low' | 'medium' | 'high';
  /**
   * 这一步没有做锁和重写分析的原因，是一个代码（界面按代码显示本地化的说明）：
   * `nontransactional` = 非事务步骤（CREATE INDEX CONCURRENTLY 之类），不能包进 BEGIN，没法测量锁和重写。
   * 有它时 locks / rewrites / scans 都是空的，界面显示这条说明而不是“低风险”。
   */
  note?: 'nontransactional';
}

/** StepRisk.note 的代码：非事务步骤没有分析锁和重写 */
export const NON_TRANSACTIONAL_NOTE = 'nontransactional' as const;

const BLOCKS_READS = new Set(['AccessExclusiveLock']);
const BLOCKS_WRITES = new Set(['ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock']);

/**
 * 在影子库里建出原版本，逐步执行迁移，每一步单独放在事务里测量：拿了什么锁、是否重写、是否全表扫描。
 * 只关心迁移前就存在的关系（新建的表上的锁不影响线上）。
 */
export const analyze = async (
  db: Db,
  from: Model,
  /** step.transactional 是用户 / 冻结脚本给的标记：只用于“从文本看不出来的非事务步骤”的兜底（见下），不决定要不要放进事务 */
  steps: Step[],
  opts?: PlanOptions,
): Promise<StepRisk[]> => {
  assertNoInstanceLevel(steps); // 重放也会真的执行这些步骤：有实例级语句就一条都不执行
  await build(db, from, opts);
  const existing = new Set(
    (
      await db.query<{ oid: number }>(
        `select c.oid::int as oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'i', 'm') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'`,
      )
    ).map((r) => r.oid),
  );
  const nodes = async () =>
    new Map(
      (
        await db.query<{ oid: number; node: number; name: string }>(
          `select c.oid::int as oid, c.relfilenode::int as node, c.oid::regclass::text as name from pg_class c
            where c.relkind in ('r', 'm') and c.relnamespace not in (select oid from pg_namespace where nspname ~ '^pg_' or nspname = 'information_schema')`,
        )
      ).map((r) => [r.oid, r]),
    );
  // pg_stat_xact_user_tables 在 PG 15+ 里是本连接尚未刷新的累计值，不只是当前事务（前面步骤的扫描会残留），
  // 所以每一步前后各读一次，取增量
  const seqScans = async () =>
    new Map(
      (
        await db.query<{ oid: number; name: string; n: number }>(
          `select relid::int as oid, relid::regclass::text as name, seq_scan::int as n from pg_stat_xact_user_tables`,
        )
      ).map((r) => [r.oid, r]),
    );
  /** 在事务外直接执行一步（非事务步骤）：不做锁和重写分析，在风险列表里给一条说明 */
  const runOutsideTransaction = async (s: Step): Promise<StepRisk> => {
    const t0 = performance.now();
    try {
      await db.exec(s.sql);
    } catch (e) {
      throw new StepError(s, e, performance.now() - t0);
    }
    return { locks: [], rewrites: [], scans: [], level: 'low', note: NON_TRANSACTIONAL_NOTE };
  };

  /** 放进 BEGIN 里执行一步并测量；不管哪里出错都要把这个事务结束掉 */
  const measureInTransaction = async (s: Step): Promise<StepRisk> => {
    const before = await nodes();
    await db.exec('BEGIN');
    // 不管哪里出错（步骤本身、读 pg_locks、连接被取消……）都要把这个事务结束掉：
    // 否则连接停在“事务已中止”状态，后面的 SET、解锁都会失败，advisory lock 还会一直挂在这条连接上
    let finished = false;
    let locks: { oid: number; relation: string; mode: string }[];
    let scans: { oid: number; name: string; n: number }[];
    let after: Awaited<ReturnType<typeof nodes>>;
    try {
      const scansBefore = await seqScans();
      const t0 = performance.now();
      try {
        await db.exec(s.sql);
      } catch (e) {
        throw new StepError(s, e, performance.now() - t0);
      }
      locks = await db.query<{ oid: number; relation: string; mode: string }>(
        `select l.relation::int as oid, l.relation::regclass::text as relation, l.mode
           from pg_locks l where l.pid = pg_backend_pid() and l.locktype = 'relation' and l.granted`,
      );
      scans = [...(await seqScans()).values()].filter((r) => r.n > (scansBefore.get(r.oid)?.n ?? 0));
      after = await nodes();
      await db.exec('COMMIT');
      finished = true;
    } finally {
      if (!finished) await db.exec('ROLLBACK').catch(() => {});
    }
    const risk: StepRisk = {
      locks: locks.filter((l) => existing.has(l.oid)).map(({ relation, mode }) => ({ relation, mode })),
      rewrites: [...before]
        .filter(([oid, b]) => existing.has(oid) && after.get(oid) && after.get(oid)!.node !== b.node)
        .map(([, b]) => b.name),
      scans: scans.filter((x) => existing.has(x.oid)).map((x) => x.name),
      level: 'low',
    };
    const strongest = risk.locks.map((l) => l.mode);
    if (risk.rewrites.length || (risk.scans.length && strongest.some((m) => BLOCKS_READS.has(m))))
      risk.level = 'high';
    else if (risk.scans.length || strongest.some((m) => BLOCKS_WRITES.has(m) && m !== 'AccessExclusiveLock'))
      risk.level = 'medium';
    return risk;
  };

  const out: StepRisk[] = [];
  for (const s of steps) {
    // 是否放进事务看语句文本（isNontransactionalSql）：文本判断为非事务的（CONCURRENTLY 之类，即使标记写成 true）
    // 在事务外直接执行，保证后面的步骤还能接着分析；其余的一律放进 BEGIN 测量——
    // 即使用户把它手动标成 transactional:false，这样高风险的步骤（重写整表、长时间的锁）藏不住
    if (isNontransactionalSql(s.sql)) {
      out.push(await runOutsideTransaction(s));
      continue;
    }
    try {
      out.push(await measureInTransaction(s));
    } catch (e) {
      // 用户标了 transactional:false、但从文本看不出来的步骤（例如 CLUSTER、REINDEX DATABASE）：先照常测量，
      // 如果失败的原因是“不能在事务里执行”，事务已经 ROLLBACK，改在事务外执行并给 note，后面的步骤继续分析。
      // 标记为 true 的（文本也判断为事务内的），失败了就是失败，照旧往上抛（调用方写 riskError）
      if (s.transactional === false && e instanceof StepError && cannotRunInTransaction(e)) {
        out.push(await runOutsideTransaction(s));
        continue;
      }
      throw e;
    }
  }
  return out;
};

/** 失败原因是“这条语句不能在事务块里执行”：SQLSTATE 25001（active_sql_transaction），或者消息里这么说 */
const cannotRunInTransaction = (e: StepError): boolean =>
  (e.cause as { code?: unknown } | null)?.code === '25001' ||
  /cannot run inside a transaction block|cannot be executed from a function|cannot be executed within a transaction|cannot run inside a subtransaction/i.test(
    e.reason,
  );
