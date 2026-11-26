// 多方言引擎层统一接口契约（EngineAdapter / HistoryStore / TargetSnapshot / Db）。
import type { Dialect, Model, PlanOptions, Step } from '@dowel/core';

import type { ScriptStep } from './steps.ts';

export interface AnalyzeOptions extends PlanOptions {
  /**
   * 紧接完整闭环验证（verify / verifyScripts 通过且已回滚到 from）后执行时，
   * 影子库已处于 from 状态，可跳过第 3 轮 resetShadow + createAll(from) 重建。
   */
  reuseShadowFrom?: boolean;
}

/** 访问目标库 / 影子库的最小抽象接口 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 执行一条或多条不返回结果的语句 */
  exec(sql: string): Promise<void>;
  /**
   * 从连接池里独占一个连接，用完必须调 release()。
   * 单连接的适配器（测试里的连接、SQLite）可以不实现，此时直接用 db 本身。
   */
  reserve?(): Promise<Db>;
  /** 归还 reserve() 独占的连接 */
  release?(): void;
}

export interface TargetSnapshot<TPayload = unknown> {
  dialect: Dialect;
  /** 可读版本字符串（如 "18.6" / "3.54.1"） */
  version: string;
  /** 数值版本号（如 PG 180006、SQLite 3054001） */
  versionNum: number;
  payload: TPayload;
}

export interface StepRisk {
  /** 对迁移前就存在的表 / 索引拿的锁 */
  locks: { relation: string; mode: string }[];
  /** 被重写的表（如 PG relfilenode 变化、SQLite 12 步重建表） */
  rewrites: string[];
  /** 被全表扫描的表 */
  scans: string[];
  /** 风险等级：high = 重写整表或长时间阻塞读写；medium = 全表扫描并阻塞、或阻塞写入；low = 短暂元数据锁 */
  level: 'low' | 'medium' | 'high';
  /** 非事务步骤未能测量锁和重写时的说明代码 */
  note?: 'nontransactional';
}

export const NON_TRANSACTIONAL_NOTE = 'nontransactional' as const;

export interface AppliedTimeouts {
  statementMs: number;
  lockMs: number;
}

export const NO_TIMEOUTS: AppliedTimeouts = { statementMs: 0, lockMs: 0 };

export interface TimeoutInfo {
  kind: 'statement' | 'lock';
  ms: number;
}

export interface TxHooks {
  beforeCommit?: () => void;
  afterCommit?: () => void;
}

export interface HistoryVersionRow {
  projectId: string;
  versionId: string;
  number: number;
  parentId: string | null;
  name: string;
  scope: string[] | null;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  checksum: string;
  model: Model;
  fingerprint: string;
  publishedAt: string;
  publishedBy: string | null;
}

export type RunDirection = 'baseline' | 'up' | 'down' | 'mark';
export type RunStatus = 'running' | 'done' | 'failed';
export type RunVia = 'web' | 'ci';

export interface RunRow {
  id: number;
  projectId: string;
  fromVersion: string | null;
  toVersion: string;
  direction: RunDirection;
  status: RunStatus;
  stepIndex: number | null;
  error: string | null;
  executedBy: string | null;
  via: RunVia;
  instanceId: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface HistoryState {
  currentVersion: string | null;
  versions: HistoryVersionRow[];
  history: RunRow[];
}

export interface ProjectRow {
  projectId: string;
  name: string | null;
  instanceId: string;
  claimedAt: string | null;
  claimedBy: string | null;
  previousInstanceId: string | null;
}

export interface ClaimRow {
  id: number;
  projectId: string;
  instanceId: string;
  previousInstanceId: string | null;
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: string;
  note: string | null;
}

export interface StartRunInput {
  projectId: string;
  fromVersion: string | null;
  toVersion: string;
  direction: RunDirection;
  executedBy: string | null;
  via: RunVia;
  instanceId: string;
}

export interface ClaimInput {
  projectId: string;
  instanceId: string;
  claimedBy: string | null;
  claimedByName: string | null;
  name: string | null;
  note?: string | null;
}

export interface HistoryProjectSummary {
  projectId: string;
  name: string | null;
  instanceId: string;
  claimedAt: string | null;
  versions: number;
  headNumber: number | null;
  currentNumber: number | null;
  lastRunAt: string | null;
}

export type HistoryErrorCode =
  | 'no_schema_privilege'
  | 'format_too_new'
  | 'checksum_mismatch'
  | 'number_conflict'
  | 'lock_timeout'
  | 'run_not_running'
  | 'invalid_steps'
  | 'claim_conflict';

export class HistoryError extends Error {
  code: HistoryErrorCode;
  constructor(code: HistoryErrorCode, message: string) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

export interface HistoryStore {
  readonly storage: 'schema' | 'prefix';
  historyExists(db: Db): Promise<boolean>;
  readHistoryFormat(db: Db): Promise<number | null>;
  historyWriteProblem(db: Db): Promise<HistoryError | null>;
  ensureHistory(db: Db): Promise<void>;
  readHistory(db: Db, projectId: string): Promise<HistoryState>;
  recordVersion(db: Db, row: HistoryVersionRow): Promise<void>;
  startRun(db: Db, run: StartRunInput): Promise<number>;
  markStep(db: Db, id: number, stepIndex: number): Promise<void>;
  finishRun(db: Db, id: number, status: Exclude<RunStatus, 'running'>, error?: string | null): Promise<void>;
  readProject(db: Db, projectId: string): Promise<ProjectRow | null>;
  writeProject(
    db: Db,
    row: Omit<ProjectRow, 'previousInstanceId'> & { previousInstanceId?: string | null },
  ): Promise<void>;
  claimProject(db: Db, input: ClaimInput): Promise<{ changed: boolean; previousInstanceId: string | null }>;
  readClaims(db: Db, projectId: string): Promise<ClaimRow[]>;
  listHistoryProjects(db: Db): Promise<HistoryProjectSummary[]>;
  withProjectLock<T>(db: Db, projectId: string, timeoutMs: number, fn: (conn: Db) => Promise<T>): Promise<T>;
}

/** 步骤执行失败错误（verifier 与 engine 风险分析共用） */
export class EngineStepError extends Error {
  step: Step;
  reason: string;
  elapsedMs: number;
  constructor(step: Step, cause: unknown, elapsedMs = 0) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`执行失败：${step.sql}\n  ${reason}`, { cause });
    this.step = step;
    this.reason = reason;
    this.elapsedMs = elapsedMs;
  }
}

export interface EngineAdapter {
  readonly dialect: Dialect;
  readonly history: HistoryStore;
  readonly sessionSettings: readonly string[];

  /** 离线 SQL 导出文件头的会话固定语句 */
  sessionHeader(): string;

  // 会话与事务控制
  pinSession(db: Db): Promise<void>;
  resetSession(db: Db): Promise<void>;
  inTransaction<T>(conn: Db, fn: () => Promise<T>, hooks?: TxHooks): Promise<T>;
  /** 执行一步迁移 SQL（MSSQL 在此按 GO 切批；SQLite 在此检查 PRAGMA foreign_key_check 并兜底恢复 foreign_keys） */
  execStepSql(conn: Db, sql: string): Promise<void>;

  // 快照与导入
  readSnapshot(db: Db, only?: string[] | null): Promise<TargetSnapshot>;
  importSnapshot(snap: TargetSnapshot): Model;
  normalizeSnapshot(snap: TargetSnapshot): unknown;
  normalizeLiveSnapshot(snap: TargetSnapshot, reference: Model): TargetSnapshot;
  /** 验证比对前对快照做模型相关的归一化（如 PG 15–17 衍生非空约束名归一化） */
  normalizeForVerify?(snap: TargetSnapshot, model: Model): TargetSnapshot;
  /** 导入线上结构后的方言对齐（如 PG 衍生非空约束名对齐） */
  alignImportedLive?(live: Model, reference: Model): Model;
  diffSnapshots(a: TargetSnapshot, b: TargetSnapshot): string[];
  fingerprint(snap: TargetSnapshot): string;

  // 影子库版本与操作钩子（verifier & shadow.ts 共用）
  readVersionNum?(db: Db): Promise<number | null>;
  planOptionsForVersion?(versionNum: number): PlanOptions | undefined;
  /**
   * 调用方的 PlanOptions 是否已显式给出本方言的目标版本（显式时 buildTarget 不再探测影子库版本）。
   * 未实现时视为“给了选项就算显式”。
   */
  hasExplicitVersionOpt?(opts: PlanOptions): boolean;
  /**
   * verifier.verify()（重新规划）：由影子库实测数值版本号与调用方选项解析规划选项与建库选项。
   * 未实现时：规划用“显式 ? 调用方选项 : 影子库版本选项”，建库用“影子库版本选项 ?? 调用方选项”。
   */
  resolveVerifyOptions?(
    shadowVersionNum: number | null,
    opts: PlanOptions | undefined,
  ): { plan: PlanOptions | undefined; build: PlanOptions | undefined };
  /**
   * verifier.verifyScripts()（冻结脚本）：由影子库实测数值版本号与调用方选项解析建库选项，
   * 并在此做目标版本兼容性检查（不兼容抛 PlanError）。未实现时直接用影子库版本选项。
   */
  resolveScriptsBuildOptions?(
    to: Model,
    shadowVersionNum: number | null,
    opts: PlanOptions,
  ): PlanOptions | undefined;
  resetShadow(db: Db): Promise<void>;
  prepareImportShadow(db: Db): Promise<void>;
  stripImportNoise(sql: string): string;
  analyzeStepRisk(db: Db, from: Model, steps: Step[], opts?: AnalyzeOptions): Promise<StepRisk[]>;

  // 执行器钩子（executor 共用）
  applyTimeouts(
    conn: Db,
    timeouts: { statementMs: number; lockMs: number } | undefined,
    opts?: { concurrent?: boolean },
  ): Promise<AppliedTimeouts>;
  restoreTimeouts(conn: Db, applied: AppliedTimeouts): Promise<void>;
  classifyTimeout(err: unknown, applied: AppliedTimeouts): TimeoutInfo | undefined;
  beforeNonTxStep?(conn: Db, sql: string, isResume: boolean): Promise<{ sql?: string; hint?: string }>;
  afterNonTxStep?(conn: Db, sql: string): Promise<void>;
  /** DDL 自动提交方言（MySQL）：断点续跑前结合错误码与目录状态判断该步是否已生效 */
  detectStepAlreadyApplied?(conn: Db, step: ScriptStep, stepErr?: unknown): Promise<boolean>;
}
