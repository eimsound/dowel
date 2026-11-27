// 版本查询、模型引用解析、DDL 生成、迁移预览与跨版本影子库验证辅助函数。
// 供 HTTP 路由（routes/versions.ts）与 MCP 工具（mcp-server.ts）共同复用，避免两套实现分叉。
import type {
  StoredVerifyReport,
  UncoveredEnvironment,
  VerifyRecord,
  VerifyReport,
  VerifyResponse,
  VersionDetail,
  VersionInfo,
} from '@dowel/api';
import {
  createAll,
  type Dialect,
  formatScript,
  type Model,
  plan,
  type PlanOptions,
  type Step,
  validate,
  verifiedForEngine,
} from '@dowel/core';
import {
  type Db,
  getEngine,
  indexTree,
  isNontransactionalSql,
  maxNumberNode,
  type ScriptStep,
} from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { emptyBase, versionExecutedAnywhere } from './chain.ts';
import type { OpaqueRefresher } from './derive.ts';
import { iso, projectPlanOptions, verifiedOnOf } from './envs.ts';
import { scrubSecrets } from './secrets.ts';
import { recordOf, ShadowError, storedReport } from './shadow.ts';
import type { Shadows } from './shadows.ts';

/** 概要字段：版本列表用 */
export interface InfoRow {
  id: string;
  name: string;
  seq: number;
  number: number;
  parentId: string | null;
  verifiedAt: string | null;
  edited: boolean;
  createdAt: string;
  createdBy: string | null;
  retiredAt: unknown;
  retiredBy: string | null;
  executedAt: unknown;
  restoredAt: unknown;
  /** 验证报告（列表只用它的 records 算 verifiedOn） */
  verifyReport: StoredVerifyReport | null;
}

/** 详情字段：模型、冻结脚本和验证报告 */
export interface Detail {
  model: Model;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  checksum: string;
  /** 冻结时项目的 schema 范围（null 表示全部）：第一个版本的 from（空库模型）由它决定 */
  scope: string[] | null;
}

export type VersionRow = InfoRow & Detail;

/** 列表只要概要：不读模型和冻结脚本（模型可能很大，版本又多） */
export const INFO_COLUMNS = `v.id, v.name, v.seq, v.number, v.parent_id as "parentId", v.verified_at as "verifiedAt", v.edited,
  v.created_at as "createdAt", u.name as "createdBy", v.retired_at as "retiredAt", ru.name as "retiredBy",
  v.executed_at as "executedAt", v.restored_at as "restoredAt", v.verify_report as "verifyReport"`;
export const ROW_COLUMNS = `${INFO_COLUMNS}, v.model, v.up_steps as "upSteps", v.down_steps as "downSteps", v.checksum,
  v.scope`;

/** 取项目里的一个版本（带冻结脚本和验证报告）；不存在抛 404 */
export const loadVersion = async (db: Db, pid: string, vid: string): Promise<VersionRow> => {
  const [v] = await db.query<VersionRow>(
    `select ${ROW_COLUMNS}
       from versions v
       left join users u on u.id = v.created_by
       left join users ru on ru.id = v.retired_by
      where v.id = $1 and v.project_id = $2`,
    [vid, pid],
  );
  if (!v) throw new HTTPException(404, { message: '版本不存在' });
  return v;
};

/** 按版本号、'latest'（活跃链头）或 ID 查找版本；不存在返回 null */
export const findVersion = async (db: Db, pid: string, ref: string): Promise<VersionRow | null> => {
  if (ref === 'latest') {
    return (
      (
        await db.query<VersionRow>(
          `select ${ROW_COLUMNS}
             from versions v
             left join users u on u.id = v.created_by
             left join users ru on ru.id = v.retired_by
            where v.project_id = $1 and v.retired_at is null
            order by v.number desc limit 1`,
          [pid],
        )
      )[0] ?? null
    );
  }
  const numMatch = /^v(\d+)$/i.exec(ref);
  if (numMatch) {
    const num = Number(numMatch[1]);
    if (!Number.isSafeInteger(num)) return null;
    return (
      (
        await db.query<VersionRow>(
          `select ${ROW_COLUMNS}
             from versions v
             left join users u on u.id = v.created_by
             left join users ru on ru.id = v.retired_by
            where v.project_id = $1 and v.number = $2`,
          [pid, num],
        )
      )[0] ?? null
    );
  }
  return (
    (
      await db.query<VersionRow>(
        `select ${ROW_COLUMNS}
           from versions v
           left join users u on u.id = v.created_by
           left join users ru on ru.id = v.retired_by
          where v.id = $1 and v.project_id = $2`,
        [ref, pid],
      )
    )[0] ?? null
  );
};

/** 活跃链头概要：未作废且 number 最大的版本。检查并发、判断“是不是活跃最新”只需要它，不读模型 */
export const activeHead = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number }>(
      'select id, number from versions where project_id = $1 and retired_at is null order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 活跃链头连同模型：只有发布时算 parent / from 才需要 */
export const activeHeadWithModel = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number; model: Model }>(
      'select id, number, model from versions where project_id = $1 and retired_at is null order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 全局最大版本号（包含已作废的版本，ADR 0013 版本号只增不重用） */
export const globalMaxNumber = async (db: Db, pid: string): Promise<number | null> => {
  const [row] = await db.query<{ max: number | string | null }>(
    'select max(number) as max from versions where project_id = $1',
    [pid],
  );
  return row?.max == null ? null : Number(row.max);
};

/** 项目内存在进行中执行（state = 'claimed'）的版本 ID 集合（集合查询，避免列表 N+1） */
export const claimedVersionIds = async (db: Db, pid: string): Promise<Set<string>> =>
  new Set(
    (
      await db.query<{ versionId: string }>(
        `select distinct ev.version_id as "versionId"
           from environment_versions ev
           join environments e on e.id = ev.environment_id
          where e.project_id = $1 and ev.state = 'claimed'`,
        [pid],
      )
    ).map((r) => r.versionId),
  );

export interface VersionTreeNode {
  id: string;
  number: number;
  parentId: string | null;
  retired: boolean;
}

export interface UnretireAnalysis<T extends VersionTreeNode> {
  globalMax: T | null;
  activeHead: T | null;
  /** (activeHead, globalMax] 沿 parent_id 的整条待恢复路径（编号升序）；不可恢复时为空 */
  path: T[];
  /** path 上所有版本的 id 集合 */
  ids: Set<string>;
}

/**
 * 计算当前项目唯一允许一键取消作废的路径 (activeHead, globalMax]（ADR 0013）：
 * 仅当全局最大编号版本已作废，且从它沿 parent_id 回溯能连续穿过已作废节点到达当前活跃链头时才成立。
 * 列表 / 详情的 `unretirable` 标记与 `POST .../unretire` 共用同一判定函数。
 */
export const analyzeUnretire = <T extends VersionTreeNode>(nodes: readonly T[]): UnretireAnalysis<T> => {
  const globalMax = maxNumberNode(nodes);
  let head: T | null = null;
  for (const n of nodes) if (!n.retired && (!head || n.number > head.number)) head = n;
  if (!globalMax || !head || !globalMax.retired) {
    return { globalMax, activeHead: head, path: [], ids: new Set() };
  }
  const byId = indexTree(nodes);
  const reversed: T[] = [];
  const seen = new Set<string>();
  let cur: T | undefined = globalMax;
  let reachedHead = false;
  while (cur) {
    if (cur.id === head.id) {
      reachedHead = true;
      break;
    }
    if (seen.has(cur.id) || !cur.retired) break;
    seen.add(cur.id);
    reversed.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const path = reachedHead ? reversed.reverse() : [];
  return { globalMax, activeHead: head, path, ids: new Set(path.map((n) => n.id)) };
};

export const loadVersionTree = async (db: Db, pid: string): Promise<VersionTreeNode[]> => {
  const rows = await db.query<{
    id: string;
    number: number;
    parentId: string | null;
    retiredAt: unknown;
  }>(
    'select id, number, parent_id as "parentId", retired_at as "retiredAt" from versions where project_id = $1',
    [pid],
  );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    parentId: r.parentId,
    retired: r.retiredAt !== null && r.retiredAt !== undefined,
  }));
};

export interface InfoFlags {
  latest: boolean;
  executed: boolean;
  unretirable: boolean;
}

export const toVersionInfo = (v: InfoRow, flags: InfoFlags): VersionInfo => ({
  id: v.id,
  name: v.name,
  seq: v.seq,
  number: v.number,
  parentId: v.parentId,
  createdAt: v.createdAt,
  createdBy: v.createdBy,
  verifiedAt: v.verifiedAt,
  verifiedOn: verifiedOnOf(v.verifyReport),
  edited: v.edited,
  latest: flags.latest,
  retiredAt: iso(v.retiredAt),
  retiredBy: v.retiredBy ?? null,
  executed: flags.executed,
  unretirable: flags.unretirable,
  restoredAt: iso(v.restoredAt),
});

export const toVersionDetail = (v: VersionRow, flags: InfoFlags): VersionDetail => ({
  ...toVersionInfo(v, flags),
  upSteps: v.upSteps,
  downSteps: v.downSteps,
  checksum: v.checksum,
  verifyReport: v.verifyReport,
});

export const versionDetailOf = async (db: Db, pid: string, v: VersionRow): Promise<VersionDetail> => {
  const analysis = analyzeUnretire(await loadVersionTree(db, pid));
  const executed =
    (v.executedAt !== null && v.executedAt !== undefined) || (await versionExecutedAnywhere(db, v.id));
  return toVersionDetail(v, {
    latest: v.id === (analysis.activeHead?.id ?? null),
    executed,
    unretirable: analysis.ids.has(v.id),
  });
};

/** 列出项目的版本列表（按 number 倒序），可限制条数 */
export const listProjectVersions = async (db: Db, pid: string, limit?: number): Promise<VersionInfo[]> => {
  const rows =
    limit !== undefined
      ? await db.query<InfoRow>(
          `select ${INFO_COLUMNS}
             from versions v
             left join users u on u.id = v.created_by
             left join users ru on ru.id = v.retired_by
            where v.project_id = $1
            order by v.number desc limit $2`,
          [pid, limit],
        )
      : await db.query<InfoRow>(
          `select ${INFO_COLUMNS}
             from versions v
             left join users u on u.id = v.created_by
             left join users ru on ru.id = v.retired_by
            where v.project_id = $1
            order by v.number desc`,
          [pid],
        );
  const claimedIds = await claimedVersionIds(db, pid);
  const tree =
    limit === undefined
      ? rows.map((r) => ({
          id: r.id,
          number: r.number,
          parentId: r.parentId,
          retired: r.retiredAt !== null && r.retiredAt !== undefined,
        }))
      : await loadVersionTree(db, pid);
  const analysis = analyzeUnretire(tree);
  const activeHeadId = analysis.activeHead?.id ?? null;
  return rows.map((v) =>
    toVersionInfo(v, {
      latest: v.id === activeHeadId,
      executed: (v.executedAt !== null && v.executedAt !== undefined) || claimedIds.has(v.id),
      unretirable: analysis.ids.has(v.id),
    }),
  );
};

/** 合并验证记录（ADR 0017 决定 5）：同一个数据库完整版本号以新的为准，其余保留；读不到版本的记录不合并、只保留最新一批 */
export const mergeRecords = (
  previous: readonly VerifyRecord[],
  fresh: readonly VerifyRecord[],
): VerifyRecord[] => {
  const freshKeys = new Set(fresh.map((r) => r.engineVersion).filter((v): v is string => v !== null));
  return [...previous.filter((r) => r.engineVersion !== null && !freshKeys.has(r.engineVersion)), ...fresh];
};

export type ShadowVerifyOutcome =
  /** 通过：verifiedOn 是合并后通过的完整版本号，uncovered 是还没有覆盖到的环境 */
  | { kind: 'ok'; stored: StoredVerifyReport; verifiedOn: string[]; uncovered: UncoveredEnvironment[] }
  /** 某个可用影子库验证失败（脚本失败、结构不一致，或读回核对发现写法差异 readback = true） */
  | {
      kind: 'failed';
      report: VerifyResponse;
      stored: StoredVerifyReport;
      readback: boolean;
      engineVersion: string | null;
      verifiedOn: string[];
      uncovered: UncoveredEnvironment[];
    }
  /** 都通过了，但没有一个影子库与项目环境的数据库完整版本号一致（或环境的版本还未知） */
  | {
      kind: 'unmatched';
      stored: StoredVerifyReport;
      reason: string;
      verifiedOn: string[];
      uncovered: UncoveredEnvironment[];
    };

/** 读回核对发现的写法差异（不是脚本失败、也不是两份影子库快照不一致） */
const isReadbackOnly = (r: VerifyReport) =>
  !r.ok && !r.error && !r.upDiff.length && !r.downDiff.length && (r.readbackTotal ?? 0) > 0;

/**
 * 闭环验证冻结脚本，发布、重新验证共用（ADR 0017 决定 1 / 4 / 5）：
 * - 按项目环境的**数据库完整版本号**分组选影子库（Shadows.forProjectEngineVersions），逐个验证（含读回核对），
 *   风险分析只在第一个可用的影子库上做一次；每个影子库按它实际读到的完整版本号记一条验证记录，与 previous 合并；
 * - 任何一个可用影子库验证失败 → failed（发布拒绝；重新验证如实记下）；
 * - 只有与某个环境的完整版本号一致、且通过的记录才算验证依据：一条都没有 → unmatched；SQLite 内置库视为恒等；
 * - 没有任何可用影子库（没有环境、全部连不上）→ 抛 ShadowError（发布拒绝、稍后重试）。
 * 原先“最低目标版本组必须有影子库”的规则已删除：每个环境由自己的数据库版本把关（执行器按目标库完整版本号检查）。
 */
export const verifyOnShadows = async (
  shadows: Shadows,
  pid: string,
  dialect: Dialect,
  o: {
    from: Model;
    to: Model;
    up: ScriptStep[];
    down: ScriptStep[];
    checkDown: boolean;
    planOpts?: PlanOptions;
    /** 冻结时的 schema 范围：读回核对只读范围内的 schema */
    scope: string[] | null;
    /** 已有的验证记录（重新验证时合并；发布为空） */
    previous?: readonly VerifyRecord[];
  },
): Promise<ShadowVerifyOutcome> => {
  const selection = await shadows.forProjectEngineVersions(pid);
  if (!selection.entries.length) {
    throw new ShadowError(selection.skipped[0]?.reason ?? '没有可用的影子库');
  }
  const at = new Date().toISOString();
  const fresh: VerifyRecord[] = [];
  const passed: { label: string; engineVersion: string | null }[] = [];
  const runtimeSkipped: string[] = [];
  let primary: { report: VerifyReport; label: string } | null = null;

  const coverage = (records: readonly VerifyRecord[]) => {
    const merged = mergeRecords(o.previous ?? [], records);
    const verifiedOn = verifiedOnOf({ records: merged });
    const uncovered = selection.environments.filter(
      (e) =>
        !(selection.identical
          ? verifiedOn.length > 0
          : verifiedForEngine(dialect, verifiedOn, e.engineVersion)),
    );
    return { merged, verifiedOn, uncovered };
  };

  for (const entry of selection.entries) {
    let report: VerifyReport;
    try {
      report = await entry.shadow.verifyScripts(o.from, o.to, o.up, o.down, {
        checkDown: o.checkDown,
        skipRisk: primary !== null,
        scope: o.scope,
        ...(o.planOpts?.mysqlVersionNum !== undefined ? { mysqlVersionNum: o.planOpts.mysqlVersionNum } : {}),
      });
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      runtimeSkipped.push(scrubSecrets(e.message));
      continue;
    }
    // 记录按影子库实际读到的完整版本号；读不到（测试替身等）时沿用选它时依据的环境版本
    const engineVersion = selection.identical
      ? (report.engineVersion ?? null)
      : (report.engineVersion ?? entry.engineVersion);
    report = { ...report, engineVersion };
    fresh.push(recordOf(report, entry.label, at));
    primary ??= { report, label: entry.label };
    const shadowLabel =
      engineVersion !== null && !selection.identical ? `${entry.label}（${engineVersion}）` : entry.label;
    if (!report.ok) {
      const cov = coverage(fresh);
      const withPrefix =
        engineVersion !== null && !selection.identical && report.error
          ? {
              ...report,
              error: { ...report.error, message: `${engineVersion} 验证失败：${report.error.message}` },
            }
          : report;
      return {
        kind: 'failed',
        readback: isReadbackOnly(report),
        engineVersion,
        report: { ...withPrefix, shadow: shadowLabel, records: cov.merged },
        stored: storedReport(withPrefix, shadowLabel, { records: cov.merged, at }),
        verifiedOn: cov.verifiedOn,
        uncovered: cov.uncovered,
      };
    }
    passed.push({ label: entry.label, engineVersion });
  }

  if (!primary) {
    throw new ShadowError(runtimeSkipped[0] ?? selection.skipped[0]?.reason ?? '影子库不可用');
  }
  const cov = coverage(fresh);
  const summary =
    passed.length === 1 && (selection.identical || passed[0]!.engineVersion === null)
      ? passed[0]!.label
      : passed
          .map((p) => (p.engineVersion !== null ? `${p.label}（${p.engineVersion}）` : p.label))
          .join(' · ');
  const stored = storedReport(primary.report, summary, { records: cov.merged, at });
  const matched = selection.identical
    ? cov.verifiedOn.length > 0
    : selection.environments.some(
        (e) => e.engineVersion !== null && cov.verifiedOn.includes(e.engineVersion),
      );
  if (!matched) {
    const envVersions = [...new Set(selection.environments.map((e) => e.engineVersion ?? '未知'))].join('、');
    const shadowVersions = passed.map((p) => p.engineVersion ?? '未知').join('、');
    const extra =
      runtimeSkipped.length || selection.skipped.length
        ? `（另有影子库不可用：${runtimeSkipped[0] ?? selection.skipped[0]!.reason}）`
        : '';
    return {
      kind: 'unmatched',
      reason:
        `通过验证的影子库版本（${shadowVersions}）与项目环境的数据库版本（${envVersions}）都不一致${extra}。` +
        '发布需要至少一个与环境数据库版本一致的影子库：请为环境配置版本相同的独立影子库，或允许使用同实例影子库',
      stored,
      verifiedOn: cov.verifiedOn,
      uncovered: cov.uncovered,
    };
  }
  return { kind: 'ok', stored, verifiedOn: cov.verifiedOn, uncovered: cov.uncovered };
};

export interface ResolveModelRefOptions {
  pid: string;
  branch: string;
  schemas: string[] | null;
  ref: string | undefined;
  like?: Model;
  defaultRef?: 'head' | 'empty' | 'latest_or_empty';
}

export type ResolvedModelRef =
  | { ok: true; model: Model; label: string; version?: VersionRow; seq?: number }
  | { ok: false; code: 'version_not_found'; message: string };

/** 解析模型引用：支持 `'head'`、`'empty'`、`'latest'`、`'vN'` 与版本 ID（含 pitfall #17 预刷新） */
export const resolveModelRef = async (
  db: Db,
  refresher: OpaqueRefresher,
  opts: ResolveModelRefOptions,
): Promise<ResolvedModelRef> => {
  const effective = opts.ref ?? opts.defaultRef ?? 'head';
  if (effective === 'head') {
    const { model, seq } = await refresher.flush(opts.branch);
    return { ok: true, model, label: 'head', seq };
  }
  if (effective === 'empty') {
    const like = opts.like ?? (await refresher.flush(opts.branch)).model;
    return { ok: true, model: emptyBase(like, opts.schemas), label: 'empty' };
  }
  if (effective === 'latest_or_empty') {
    const headVer = await findVersion(db, opts.pid, 'latest');
    if (headVer) return { ok: true, model: headVer.model, label: `v${headVer.number}`, version: headVer };
    const like = opts.like ?? (await refresher.flush(opts.branch)).model;
    return { ok: true, model: emptyBase(like, opts.schemas), label: 'empty' };
  }
  const v = await findVersion(db, opts.pid, effective);
  if (!v) return { ok: false, code: 'version_not_found', message: `版本不存在：${effective}` };
  return { ok: true, model: v.model, label: `v${v.number}`, version: v };
};

/** 生成完整建库 DDL SQL */
export const buildDdlSql = async (
  db: Db,
  opts: { pid: string; dialect: Model['dialect']; model: Model },
): Promise<string> => {
  const planOpts = await projectPlanOptions(db, opts.pid, opts.dialect);
  return `${formatScript(createAll(opts.model, planOpts), opts.dialect)}\n`;
};

/** 规划两个模型之间的升级/回滚脚本，生成完整 SQL 与安全提示 */
export const buildMigrationPreview = async (
  db: Db,
  opts: { pid: string; dialect: Model['dialect']; from: Model; to: Model },
): Promise<{
  up: Step[];
  down: Step[];
  upSql: string;
  downSql: string;
  warnings: string[];
}> => {
  const planOpts = await projectPlanOptions(db, opts.pid, opts.dialect);
  const up = plan(opts.from, opts.to, planOpts);
  const down = plan(opts.to, opts.from, planOpts);
  const header = getEngine(opts.dialect).sessionHeader();
  const formatSql = (steps: Step[]) => {
    const body = formatScript(steps, opts.dialect);
    return `${header ? `${header}\n\n` : ''}${body}\n`;
  };
  const warnings: string[] = [];
  for (const msg of validate(opts.to)) {
    warnings.push(`model validation: ${msg}`);
  }
  for (const step of up) {
    const nontx =
      step.transactional !== undefined ? !step.transactional : isNontransactionalSql(step.sql, opts.dialect);
    if (nontx) warnings.push(`nontransactional step (${step.kind}): ${step.target}`);
    if (step.kind === 'dropTable' || step.kind === 'dropColumn' || step.kind === 'dropSchema') {
      warnings.push(`destructive step (${step.kind}): ${step.target}`);
    }
  }
  return { up, down, upSql: formatSql(up), downSql: formatSql(down), warnings };
};
