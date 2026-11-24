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
  type Model,
  plan,
  type PlanOptions,
  type Step,
  validate,
} from '@dowel/core';
import { type Db, getEngine, isNontransactionalSql, type ScriptStep } from '@dowel/engines';
import { HTTPException } from 'hono/http-exception';

import { emptyBase } from './chain.ts';
import type { OpaqueRefresher } from './derive.ts';
import { projectPlanOptions } from './envs.ts';
import type { Rooms } from './rooms.ts';
import { scrubSecrets } from './secrets.ts';
import { ShadowError, storedReport } from './shadow.ts';
import { mysqlMinorGroupOf, type Shadows } from './shadows.ts';

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
  restoredAt: string | null;
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
  v.created_at as "createdAt", u.name as "createdBy", v.restored_at as "restoredAt"`;
export const ROW_COLUMNS = `${INFO_COLUMNS}, v.model, v.up_steps as "upSteps", v.down_steps as "downSteps", v.checksum,
  v.verify_report as "verifyReport", v.scope`;

/** 取项目里的一个版本（带冻结脚本和验证报告）；不存在抛 404 */
export const loadVersion = async (db: Db, pid: string, vid: string): Promise<VersionRow> => {
  const [v] = await db.query<VersionRow>(
    `select ${ROW_COLUMNS} from versions v left join users u on u.id = v.created_by
      where v.id = $1 and v.project_id = $2`,
    [vid, pid],
  );
  if (!v) throw new HTTPException(404, { message: '版本不存在' });
  return v;
};

/** 按版本号、'latest' 或 ID 查找版本；不存在返回 null */
export const findVersion = async (db: Db, pid: string, ref: string): Promise<VersionRow | null> => {
  if (ref === 'latest') {
    return (
      (
        await db.query<VersionRow>(
          `select ${ROW_COLUMNS} from versions v left join users u on u.id = v.created_by
            where v.project_id = $1 order by v.number desc limit 1`,
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
          `select ${ROW_COLUMNS} from versions v left join users u on u.id = v.created_by
            where v.project_id = $1 and v.number = $2`,
          [pid, num],
        )
      )[0] ?? null
    );
  }
  return (
    (
      await db.query<VersionRow>(
        `select ${ROW_COLUMNS} from versions v left join users u on u.id = v.created_by
          where v.id = $1 and v.project_id = $2`,
        [ref, pid],
      )
    )[0] ?? null
  );
};

/** 链头概要：链上最新的版本（number 最大）的 id 和 number。检查并发、判断“是不是最新”只需要它，不读模型 */
export const chainHead = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number }>(
      'select id, number from versions where project_id = $1 order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 链头连同模型：只有发布时算 parent / from 才需要 */
export const chainHeadWithModel = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number; model: Model }>(
      'select id, number, model from versions where project_id = $1 order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

export const toVersionInfo = (v: InfoRow, latestId: string | null): VersionInfo => ({
  id: v.id,
  name: v.name,
  seq: v.seq,
  number: v.number,
  parentId: v.parentId,
  createdAt: v.createdAt,
  createdBy: v.createdBy,
  verifiedAt: v.verifiedAt,
  edited: v.edited,
  latest: v.id === latestId,
  restoredAt: v.restoredAt ? new Date(v.restoredAt).toISOString() : null,
});

export const toVersionDetail = (v: VersionRow, latestId: string | null): VersionDetail => ({
  ...toVersionInfo(v, latestId),
  upSteps: v.upSteps,
  downSteps: v.downSteps,
  checksum: v.checksum,
  verifyReport: v.verifyReport,
});

/** 列出项目的版本列表（按 number 倒序），可限制条数 */
export const listProjectVersions = async (db: Db, pid: string, limit?: number): Promise<VersionInfo[]> => {
  const rows =
    limit !== undefined
      ? await db.query<InfoRow>(
          `select ${INFO_COLUMNS} from versions v left join users u on u.id = v.created_by
            where v.project_id = $1 order by v.number desc limit $2`,
          [pid, limit],
        )
      : await db.query<InfoRow>(
          `select ${INFO_COLUMNS} from versions v left join users u on u.id = v.created_by
            where v.project_id = $1 order by v.number desc`,
          [pid],
        );
  const latestId = rows[0]?.id ?? null;
  return rows.map((v) => toVersionInfo(v, latestId));
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

const formatMysqlGroup = (group: number): string => `${Math.floor(group / 100)}.${group % 100}`;

/**
 * 跨版本影子库闭环验证冻结脚本（按版本升序逐一执行，风险分析仅在首个可用影子库执行一次）：
 * - PG：任一大版本闭环验证失败 → 整体失败并指出具体 PG 版本；存在多个 PG 大版本且最低目标 targetPgMajor 缺少可用影子库 → missing_target；
 * - MySQL：按主次版本（如 8.4 / 9.7）分组逐一实测，并透传项目最低目标 mysqlVersionNum 阻断高版本特有类型（如 9.7 dev + 8.4 prod 混部下的 VECTOR）；
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
    throw new ShadowError(selection.skippedMajors[0]?.reason ?? '没有可用的影子库');
  }

  const isPg = to.dialect === 'pg';
  const isMysql = to.dialect === 'mysql';
  const targets: VerifyTargetReport[] = [];
  const passedShadows: {
    major: number | null;
    mysqlGroup: number | null;
    versionLabel: string | null;
    label: string;
  }[] = [];
  const runtimeSkipped = new Map<number | null, string>();
  const mismatchReasons = new Map<number, string>();
  let primaryReport: VerifyReport | null = null;
  let ranRisk = false;

  for (const entry of selection.entries) {
    const groupKey = isPg ? entry.major : isMysql ? (entry.mysqlGroup ?? null) : null;
    let report: VerifyReport;
    try {
      report = await entry.shadow.verifyScripts(from, to, up, down, {
        checkDown,
        skipRisk: ranRisk,
        ...(planOpts?.mysqlVersionNum !== undefined ? { mysqlVersionNum: planOpts.mysqlVersionNum } : {}),
      });
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      runtimeSkipped.set(groupKey, scrubSecrets(e.message));
      continue;
    }

    if (!ranRisk) {
      primaryReport = report;
      ranRisk = true;
    }

    const actualMajor = isPg ? (report.shadowMajor !== undefined ? report.shadowMajor : entry.major) : null;
    if (isPg && entry.major !== null && actualMajor !== null && actualMajor !== entry.major) {
      mismatchReasons.set(
        entry.major,
        `影子库实际版本为 PG ${actualMajor}（${entry.label}），与目标环境 PG ${entry.major} 不一致，不能作为 PG ${entry.major} 的验证依据`,
      );
    }
    const actualMysqlGroup = isMysql
      ? report.shadowVersionNum !== undefined
        ? mysqlMinorGroupOf(report.shadowVersionNum)
        : (entry.mysqlGroup ?? null)
      : null;
    if (
      isMysql &&
      entry.mysqlGroup != null &&
      actualMysqlGroup !== null &&
      actualMysqlGroup !== entry.mysqlGroup
    ) {
      mismatchReasons.set(
        entry.mysqlGroup,
        `影子库实际版本为 MySQL ${formatMysqlGroup(actualMysqlGroup)}（${entry.label}），与目标环境 MySQL ${formatMysqlGroup(entry.mysqlGroup)} 不一致，不能作为 MySQL ${formatMysqlGroup(entry.mysqlGroup)} 的验证依据`,
      );
    }

    const displayMysqlGroup = actualMysqlGroup ?? entry.mysqlGroup ?? null;
    const versionLabel =
      isPg && actualMajor !== null
        ? `PG ${actualMajor}`
        : isMysql && displayMysqlGroup !== null
          ? `MySQL ${formatMysqlGroup(displayMysqlGroup)}`
          : null;

    if (isPg && actualMajor !== null) {
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

    passedShadows.push({
      major: actualMajor,
      mysqlGroup: actualMysqlGroup,
      versionLabel,
      label: entry.label,
    });
  }

  if (!passedShadows.length || !primaryReport) {
    const firstErr =
      runtimeSkipped.values().next().value ?? selection.skippedMajors[0]?.reason ?? '影子库不可用';
    throw new ShadowError(firstErr);
  }

  const shadowSummary =
    passedShadows.length === 1
      ? passedShadows[0]!.label
      : passedShadows
          .map((s) => (s.versionLabel !== null ? `${s.versionLabel}（${s.label}）` : s.label))
          .join(' · ');

  if (
    isPg &&
    selection.targetPgMajor !== null &&
    !passedShadows.some((s) => s.major === selection.targetPgMajor)
  ) {
    const mismatch = mismatchReasons.get(selection.targetPgMajor);
    const skippedReason =
      runtimeSkipped.get(selection.targetPgMajor) ??
      selection.skippedMajors.find((s) => s.major === selection.targetPgMajor)?.reason;
    const reason = mismatch
      ? `${mismatch}。请为 PG ${selection.targetPgMajor} 环境配置同大版本的独立影子库或允许使用同实例影子库`
      : skippedReason
        ? `缺少 PG ${selection.targetPgMajor} 影子库，无法验证最低目标版本兼容性（${skippedReason}）。请为 PG ${selection.targetPgMajor} 环境配置独立影子库或允许使用同实例影子库`
        : `缺少 PG ${selection.targetPgMajor} 影子库，无法验证最低目标版本兼容性。请为 PG ${selection.targetPgMajor} 环境配置独立影子库或允许使用同实例影子库`;
    const incompleteReport: VerifyReport = {
      ...primaryReport,
      ok: false,
      error: { step: null, message: reason },
    };
    return {
      kind: 'missing_target',
      missingMajor: selection.targetPgMajor,
      reason,
      stored: storedReport(incompleteReport, shadowSummary, {
        targets: targets.length ? targets : undefined,
        missingTargetMajor: selection.targetPgMajor,
      }),
    };
  }

  if (
    isMysql &&
    selection.targetMysqlGroup != null &&
    !passedShadows.some((s) => s.mysqlGroup === selection.targetMysqlGroup)
  ) {
    const targetLabel = `MySQL ${formatMysqlGroup(selection.targetMysqlGroup)}`;
    const mismatch = mismatchReasons.get(selection.targetMysqlGroup);
    const skippedReason =
      runtimeSkipped.get(selection.targetMysqlGroup) ??
      selection.skippedMajors.find((s) => s.mysqlGroup === selection.targetMysqlGroup)?.reason;
    const reason = mismatch
      ? `${mismatch}。请为 ${targetLabel} 环境配置同版本的独立影子库或允许使用同实例影子库`
      : skippedReason
        ? `缺少 ${targetLabel} 影子库，无法验证最低目标版本兼容性（${skippedReason}）。请为 ${targetLabel} 环境配置独立影子库或允许使用同实例影子库`
        : `缺少 ${targetLabel} 影子库，无法验证最低目标版本兼容性。请为 ${targetLabel} 环境配置独立影子库或允许使用同实例影子库`;
    const incompleteReport: VerifyReport = {
      ...primaryReport,
      ok: false,
      error: { step: null, message: reason },
    };
    return {
      kind: 'missing_target',
      missingMajor: null,
      reason,
      stored: storedReport(incompleteReport, shadowSummary),
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
  rooms: Rooms,
  refresher: OpaqueRefresher,
  opts: ResolveModelRefOptions,
): Promise<ResolvedModelRef> => {
  const effective = opts.ref ?? opts.defaultRef ?? 'head';
  if (effective === 'head') {
    await refresher.flush(opts.branch);
    const { model, seq } = await rooms.model(opts.branch);
    return { ok: true, model, label: 'head', seq };
  }
  if (effective === 'empty') {
    let like = opts.like;
    if (!like) {
      await refresher.flush(opts.branch);
      like = (await rooms.model(opts.branch)).model;
    }
    return { ok: true, model: emptyBase(like, opts.schemas), label: 'empty' };
  }
  if (effective === 'latest_or_empty') {
    const headVer = await findVersion(db, opts.pid, 'latest');
    if (headVer) return { ok: true, model: headVer.model, label: `v${headVer.number}`, version: headVer };
    let like = opts.like;
    if (!like) {
      await refresher.flush(opts.branch);
      like = (await rooms.model(opts.branch)).model;
    }
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
