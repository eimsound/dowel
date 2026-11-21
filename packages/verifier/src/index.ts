// 闭环验证：迁移后的结构必须等于直接按目标版本建出来的结构；反向迁移后必须回到原来的结构。
// 全面通过 @dowel/engines 的 getEngine(dialect) 驱动，支持 PG / SQLite / MySQL / MSSQL。
import {
  createAll,
  type Dialect,
  findInstanceLevelStep,
  instanceLevelDescription,
  type Model,
  pgMajorOf,
  type PlanOptions,
  plan,
  type Step,
} from '@dowel/core';
import {
  type Db,
  EngineStepError,
  getEngine,
  NON_TRANSACTIONAL_NOTE,
  type ScriptStep,
  type Snapshot,
  type StepRisk,
  type TargetSnapshot,
} from '@dowel/engines';

export { EngineStepError as StepError, NON_TRANSACTIONAL_NOTE, type StepRisk };

/** 清空影子库（按方言委托给 EngineAdapter.resetShadow） */
export const resetShadow = async (db: Db, dialect: Dialect = 'pg'): Promise<void> =>
  getEngine(dialect).resetShadow(db);

/**
 * 迁移脚本里出现了实例/文件级语句（PG：DATABASE/TABLESPACE/ROLE/ALTER SYSTEM；SQLite：ATTACH/DETACH/VACUUM INTO）。
 * 执行之前就拒绝，绝不执行。
 */
export class InstanceLevelStatementError extends Error {
  step: Step;
  constructor(step: Step, dialect: Dialect = 'pg') {
    super(`${instanceLevelDescription(dialect)}。语句：${step.sql}`);
    this.step = step;
  }
}

/** 执行任何一步之前先检查：有实例/文件级语句就抛 InstanceLevelStatementError，一条都不执行 */
export const assertNoInstanceLevel = (steps: Step[], dialect: Dialect = 'pg') => {
  const i = findInstanceLevelStep(steps, dialect);
  if (i >= 0) throw new InstanceLevelStatementError(steps[i]!, dialect);
};

export const runSteps = async (db: Db, steps: Step[], dialect: Dialect = 'pg') => {
  assertNoInstanceLevel(steps, dialect);
  const engine = getEngine(dialect);
  await engine.pinSession(db);
  for (const s of steps) {
    const t0 = performance.now();
    try {
      await engine.execStepSql(db, s.sql);
    } catch (e) {
      throw new EngineStepError(s, e, performance.now() - t0);
    }
  }
};

/** 从 PG 影子库读取 server_version_num 并提取大版本号 */
export const readShadowPgMajor = async (db: Db): Promise<number | null> => {
  const vNum = await getEngine('pg').readVersionNum?.(db);
  return vNum !== null && vNum !== undefined ? pgMajorOf(vNum) : null;
};

/** 多方言：在影子库里从零建出模型，返回统一的 TargetSnapshot */
export const buildTarget = async (db: Db, m: Model, opts?: PlanOptions): Promise<TargetSnapshot> => {
  const engine = getEngine(m.dialect);
  await engine.resetShadow(db);
  let buildOpts: PlanOptions | undefined = opts;
  if (m.dialect === 'pg' && opts?.pgMajor === undefined) {
    const vNum = await engine.readVersionNum?.(db);
    buildOpts = vNum !== null && vNum !== undefined ? engine.planOptionsForVersion?.(vNum) : undefined;
  }
  await runSteps(db, createAll(m, buildOpts), m.dialect);
  return engine.readSnapshot(db);
};

/** 在影子库里从零建出模型，返回底层快照 payload（保持既有 PG 调用点向后兼容） */
export const build = async (db: Db, m: Model, opts?: PlanOptions): Promise<Snapshot> =>
  (await buildTarget(db, m, opts)).payload as Snapshot;

export interface VerifyResult {
  up: Step[];
  down: Step[];
  /** 迁移后与目标的差异 */
  upDiff: string[];
  /** 反向迁移后与原版本的差异 */
  downDiff: string[];
  /** 实际执行本次验证的影子库 PG 大版本（仅 PG，其他方言为 null） */
  shadowMajor?: number | null;
}

/** 闭环验证（只用一个影子库，依次建目标版本、建原版本、执行迁移、执行反向迁移）。任一步执行失败抛出 StepError。 */
export const verify = async (db: Db, from: Model, to: Model, opts?: PlanOptions): Promise<VerifyResult> => {
  const dialect = to.dialect;
  const engine = getEngine(dialect);
  let shadowMajor: number | null = null;
  let planOpts: PlanOptions | undefined = opts;
  let buildOpts: PlanOptions | undefined = opts;
  if (dialect === 'pg') {
    shadowMajor = await readShadowPgMajor(db);
    const planMajor = opts?.pgMajor ?? shadowMajor;
    planOpts = planMajor !== null ? { pgMajor: planMajor } : undefined;
    buildOpts = shadowMajor !== null ? { pgMajor: shadowMajor } : undefined;
  }
  const up = plan(from, to, planOpts);
  const down = plan(to, from, planOpts);
  assertNoInstanceLevel([...up, ...down], dialect);
  const toSnap = await buildTarget(db, to, buildOpts);
  const fromSnap = await buildTarget(db, from, buildOpts);
  await runSteps(db, up, dialect);
  const afterUp = await engine.readSnapshot(db);
  await runSteps(db, down, dialect);
  const afterDown = await engine.readSnapshot(db);
  const norm = (snap: TargetSnapshot, model: Model) =>
    engine.normalizeForVerify ? engine.normalizeForVerify(snap, model) : snap;
  return {
    up,
    down,
    upDiff: engine.diffSnapshots(norm(afterUp, to), norm(toSnap, to)),
    downDiff: engine.diffSnapshots(norm(afterDown, from), norm(fromSnap, from)),
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
 */
export const verifyScripts = async (
  db: Db,
  from: Model,
  to: Model,
  up: ScriptStep[],
  down: ScriptStep[],
  options: VerifyScriptsOptions = {},
): Promise<VerifyResult> => {
  const dialect = to.dialect;
  const engine = getEngine(dialect);
  const upSteps = frozenSteps('up', up);
  const downSteps = frozenSteps('down', down);
  assertNoInstanceLevel([...upSteps, ...downSteps], dialect);
  let shadowMajor: number | null = null;
  let buildOpts: PlanOptions | undefined;
  if (dialect === 'pg') {
    shadowMajor = await readShadowPgMajor(db);
    const pgMajor = options.pgMajor !== undefined ? options.pgMajor : shadowMajor;
    buildOpts = pgMajor !== null ? { pgMajor } : undefined;
  }
  const toSnap = await buildTarget(db, to, buildOpts);
  const fromSnap = await buildTarget(db, from, buildOpts);
  await runSteps(db, upSteps, dialect);
  const afterUp = await engine.readSnapshot(db);
  const norm = (snap: TargetSnapshot, model: Model) =>
    engine.normalizeForVerify ? engine.normalizeForVerify(snap, model) : snap;
  const upDiff = engine.diffSnapshots(norm(afterUp, to), norm(toSnap, to));
  if (options.checkDown === false || upDiff.length)
    return { up: upSteps, down: downSteps, upDiff, downDiff: [], shadowMajor };
  await runSteps(db, downSteps, dialect);
  const afterDown = await engine.readSnapshot(db);
  return {
    up: upSteps,
    down: downSteps,
    upDiff,
    downDiff: engine.diffSnapshots(norm(afterDown, from), norm(fromSnap, from)),
    shadowMajor,
  };
};

/** 在影子库里建出原版本，逐步分析迁移步骤的风险（锁、重写、全表扫描） */
export const analyze = async (
  db: Db,
  from: Model,
  steps: Step[],
  opts?: PlanOptions,
): Promise<StepRisk[]> => {
  assertNoInstanceLevel(steps, from.dialect);
  return getEngine(from.dialect).analyzeStepRisk(db, from, steps, opts);
};
