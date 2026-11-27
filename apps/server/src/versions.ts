// 版本查询、模型引用解析、DDL 生成、迁移预览与跨版本影子库验证辅助函数。
// 供 HTTP 路由（routes/versions.ts）与 MCP 工具（mcp-server.ts）共同复用，避免两套实现分叉。
import type {
  StoredVerifyReport,
  VerifyReport,
  VerifyResponse,
  VerifyTargetReport,
  VersionDetail,
  VersionInfo,
} from '@dowel/api';
import {
  createAll,
  formatScript,
  getDialect,
  type Model,
  plan,
  type PlanOptions,
  type Step,
  validate,
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
import { iso, projectPlanOptions } from './envs.ts';
import { scrubSecrets } from './secrets.ts';
import { ShadowError, storedReport } from './shadow.ts';
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
}

/** 详情字段：模型、冻结脚本和验证报告 */
export interface Detail {
  model: Model;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  checksum: string;
  verifyReport: StoredVerifyReport | null;
  /** 冻结时项目的 schema 范围（null 表示全部）：第一个版本的 from（空库模型）由它决定 */
  scope: string[] | null;
}

export type VersionRow = InfoRow & Detail;

/** 列表只要概要：不读模型和冻结脚本（模型可能很大，版本又多） */
export const INFO_COLUMNS = `v.id, v.name, v.seq, v.number, v.parent_id as "parentId", v.verified_at as "verifiedAt", v.edited,
  v.created_at as "createdAt", u.name as "createdBy", v.retired_at as "retiredAt", ru.name as "retiredBy",
  v.executed_at as "executedAt", v.restored_at as "restoredAt"`;
export const ROW_COLUMNS = `${INFO_COLUMNS}, v.model, v.up_steps as "upSteps", v.down_steps as "downSteps", v.checksum,
  v.verify_report as "verifyReport", v.scope`;

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

export type MultiVersionVerifyOutcome =
  | { kind: 'ok'; stored: StoredVerifyReport }
  | {
      kind: 'failed';
      report: VerifyResponse;
      stored: StoredVerifyReport;
      failedMajor: number | null;
      failedVersionLabel: string | null;
    }
  | { kind: 'missing_target'; missingMajor: number | null; reason: string; stored: StoredVerifyReport };

/**
 * 跨版本影子库闭环验证冻结脚本（按版本组升序逐一执行，风险分析仅在首个可用影子库执行一次）。
 * 版本组、展示标签与对外大版本全部来自 DialectVersionMatrix（PG 按大版本、MySQL 按主次版本 8.4 / 9.7）；
 * 不提供矩阵策略的方言（MSSQL / SQLite）忽略一切组键：不打版本标签、不做最低目标门禁、不记录 targets：
 * - 任一版本组闭环验证失败 → 整体失败并指出具体版本（如“PG 16 验证失败”“MySQL 8.4 验证失败”）；
 * - 最低目标版本组（targetGroupKey）没有通过验证的影子库（缺失、运行时不可用或实测版本错配）→ missing_target；
 * - 项目最低目标版本的规划选项里的 mysqlVersionNum 透传给 verifyScripts，阻断高版本特有类型（如 9.7 dev + 8.4 prod 混部下的 VECTOR）；
 * - 只有 PG 的版本组是对外大版本：仅 PG 记录 targets[].major / missingTargetMajor；
 * - 全部可用影子库均遇到 ShadowError 或项目无任何可用影子库 → 抛出 ShadowError（按基础设施/配置不可用处理）。
 */
export const verifyAcrossVersions = async (
  shadows: Shadows,
  pid: string,
  from: Model,
  to: Model,
  up: ScriptStep[],
  down: ScriptStep[],
  checkDown = true,
  planOpts?: PlanOptions,
): Promise<MultiVersionVerifyOutcome> => {
  const selection = await shadows.forProjectVersions(pid);
  if (!selection.entries.length) {
    throw new ShadowError(selection.skippedGroups[0]?.reason ?? '没有可用的影子库');
  }

  const matrix = getDialect(to.dialect).versioning.matrix;
  const groupLabel = (key: number | null): string | null =>
    matrix && key !== null ? matrix.groupLabel(key) : null;
  const publicMajor = (key: number | null): number | null =>
    matrix && key !== null ? matrix.publicMajorOfGroup(key) : null;
  const targets: VerifyTargetReport[] = [];
  const passedShadows: { groupKey: number | null; versionLabel: string | null; label: string }[] = [];
  const runtimeSkipped = new Map<number | null, string>();
  const mismatchReasons = new Map<number, string>();
  let primaryReport: VerifyReport | null = null;
  let ranRisk = false;

  for (const entry of selection.entries) {
    const entryKey = matrix ? entry.groupKey : null;
    let report: VerifyReport;
    try {
      report = await entry.shadow.verifyScripts(from, to, up, down, {
        checkDown,
        skipRisk: ranRisk,
        ...(planOpts?.mysqlVersionNum !== undefined ? { mysqlVersionNum: planOpts.mysqlVersionNum } : {}),
      });
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      runtimeSkipped.set(entryKey, scrubSecrets(e.message));
      continue;
    }

    if (!ranRisk) {
      primaryReport = report;
      ranRisk = true;
    }

    // 影子库实测版本组：报告带了实测数值版本号就按它分组，否则沿用选影时的版本组
    const actualKey = !matrix
      ? null
      : report.shadowVersionNum !== undefined
        ? matrix.groupKeyOf(report.shadowVersionNum)
        : entryKey;
    if (matrix && entryKey !== null && actualKey !== null && actualKey !== entryKey) {
      const target = matrix.groupLabel(entryKey);
      mismatchReasons.set(
        entryKey,
        `影子库实际版本为 ${matrix.groupLabel(actualKey)}（${entry.label}），与目标环境 ${target} 不一致，不能作为 ${target} 的验证依据`,
      );
    }
    const versionLabel = groupLabel(actualKey ?? entryKey);
    const actualMajor = publicMajor(actualKey);

    if (actualMajor !== null) {
      targets.push({
        major: actualMajor,
        shadow: entry.label,
        ok: report.ok,
        error: report.error?.message ?? null,
        upDiffCount: report.upDiff.length,
        downDiffCount: report.downDiff.length,
      });
    }

    if (!report.ok) {
      const shadowLabel = versionLabel !== null ? `${versionLabel}（${entry.label}）` : entry.label;
      const withPrefix =
        versionLabel !== null && report.error
          ? {
              ...report,
              error: {
                ...report.error,
                message: `${versionLabel} 验证失败：${report.error.message}`,
              },
            }
          : report;
      const extra = targets.length ? { targets } : undefined;
      return {
        kind: 'failed',
        failedMajor: actualMajor,
        failedVersionLabel: versionLabel,
        report: {
          ...withPrefix,
          shadow: shadowLabel,
          ...(targets.length ? { targets } : {}),
        },
        stored: storedReport(withPrefix, shadowLabel, extra),
      };
    }

    passedShadows.push({ groupKey: actualKey, versionLabel, label: entry.label });
  }

  if (!passedShadows.length || !primaryReport) {
    const firstErr =
      runtimeSkipped.values().next().value ?? selection.skippedGroups[0]?.reason ?? '影子库不可用';
    throw new ShadowError(firstErr);
  }

  const shadowSummary =
    passedShadows.length === 1
      ? passedShadows[0]!.label
      : passedShadows
          .map((s) => (s.versionLabel !== null ? `${s.versionLabel}（${s.label}）` : s.label))
          .join(' · ');

  const targetKey = matrix ? selection.targetGroupKey : null;
  if (matrix && targetKey !== null && !passedShadows.some((s) => s.groupKey === targetKey)) {
    const targetLabel = matrix.groupLabel(targetKey);
    const mismatch = mismatchReasons.get(targetKey);
    const skippedReason =
      runtimeSkipped.get(targetKey) ?? selection.skippedGroups.find((s) => s.groupKey === targetKey)?.reason;
    const reason = mismatch
      ? `${mismatch}。请为 ${targetLabel} 环境配置同${matrix.groupGranularity}的独立影子库或允许使用同实例影子库`
      : skippedReason
        ? `缺少 ${targetLabel} 影子库，无法验证最低目标版本兼容性（${skippedReason}）。请为 ${targetLabel} 环境配置独立影子库或允许使用同实例影子库`
        : `缺少 ${targetLabel} 影子库，无法验证最低目标版本兼容性。请为 ${targetLabel} 环境配置独立影子库或允许使用同实例影子库`;
    const incompleteReport: VerifyReport = {
      ...primaryReport,
      ok: false,
      error: { step: null, message: reason },
    };
    const missingMajor = publicMajor(targetKey);
    return {
      kind: 'missing_target',
      missingMajor,
      reason,
      stored: storedReport(incompleteReport, shadowSummary, {
        targets: targets.length ? targets : undefined,
        ...(missingMajor !== null ? { missingTargetMajor: missingMajor } : {}),
      }),
    };
  }

  return {
    kind: 'ok',
    stored: storedReport(primaryReport, shadowSummary, {
      targets: targets.length ? targets : undefined,
    }),
  };
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
