// 版本（发布 = 冻结迁移）、迁移脚本、DDL 导出和迁移验证。
// 版本是链上的不可变快照；发布时从上一个版本生成升级 / 回滚脚本，在影子库里闭环验证，通过后冻结（ADR 0002）。
// 之后只有“链上最新、还没在任何环境执行过”的版本可以人工改脚本，改完就回到未验证。
import {
  type CanvasHistoryConflict,
  type MigrationResult,
  type ModelUpdate,
  type PublishedTables,
  type PublishRejected,
  type RequestMigration,
  type StoredVerifyReport,
  stepsPatchSchema,
  type VerifyReport,
  type VerifyResponse,
  type VerifyTargetReport,
  versionApplySchema,
  type VersionCanvasDiff,
  type VersionCreated,
  versionCreateSchema,
  type VersionDetail,
  type VersionInfo,
  type VersionRef,
  type VersionRetireResult,
  versionRetireSchema,
  type VersionUnretireResult,
  versionUnretireSchema,
  type VersionVerifyResponse,
  verifyRequestSchema,
  type WorkingCopyOutcome,
} from '@dowel/api';
import {
  createAll,
  deepEqual,
  formatScript,
  type Model,
  newId,
  type PlanOptions,
  plan,
  validate,
} from '@dowel/core';
import {
  canonicalSteps,
  type Db,
  getEngine,
  indexTree,
  isNontransactionalSql,
  maxNumberNode,
  pathFromRoot,
  routeBetween,
  type ScriptStep,
  stepsChecksum,
} from '@dowel/engines';
import { planDiff } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import {
  chainFrom,
  emptyBase,
  freezeScripts,
  instanceLevelProblem,
  versionExecutedAnywhere,
} from '../chain.ts';
import { inList, isUniqueViolation } from '../db.ts';
import { iso, projectPlanOptions } from '../envs.ts';
import { sweepWhere } from '../requests.ts';
import { WorkingChangedError } from '../rooms.ts';
import { scrubSecrets } from '../secrets.ts';
import { ShadowError, storedReport } from '../shadow.ts';
import { mysqlMinorGroupOf, type Shadows } from '../shadows.ts';
import { type AppContext, access, body, CodedHTTPException, type Env } from './context.ts';

/** 概要字段：版本列表用 */
interface InfoRow {
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
interface Detail {
  model: Model;
  upSteps: ScriptStep[];
  downSteps: ScriptStep[];
  checksum: string;
  verifyReport: StoredVerifyReport | null;
  /** 冻结时项目的 schema 范围（null 表示全部）：第一个版本的 from（空库模型）由它决定 */
  scope: string[] | null;
}

type VersionRow = InfoRow & Detail;

/** 列表只要概要：不读模型和冻结脚本（模型可能很大，版本又多） */
const INFO_COLUMNS = `v.id, v.name, v.seq, v.number, v.parent_id as "parentId", v.verified_at as "verifiedAt", v.edited,
  v.created_at as "createdAt", u.name as "createdBy", v.retired_at as "retiredAt", ru.name as "retiredBy",
  v.executed_at as "executedAt", v.restored_at as "restoredAt"`;
const ROW_COLUMNS = `${INFO_COLUMNS}, v.model, v.up_steps as "upSteps", v.down_steps as "downSteps", v.checksum,
  v.verify_report as "verifyReport", v.scope`;

/** 取项目里的一个版本（带冻结脚本和验证报告）；不存在抛 404 */
const loadVersion = async (db: Db, pid: string, vid: string): Promise<VersionRow> => {
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

/** 活跃链头概要：未作废且 number 最大的版本。检查并发、判断“是不是活跃最新”只需要它，不读模型 */
const activeHead = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number }>(
      'select id, number from versions where project_id = $1 and retired_at is null order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 活跃链头连同模型：只有发布时算 parent / from 才需要 */
const activeHeadWithModel = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number; model: Model }>(
      'select id, number, model from versions where project_id = $1 and retired_at is null order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 全局最大版本号（包含已作废的版本，ADR 0013 版本号只增不重用） */
const globalMaxNumber = async (db: Db, pid: string): Promise<number | null> => {
  const [row] = await db.query<{ max: number | string | null }>(
    'select max(number) as max from versions where project_id = $1',
    [pid],
  );
  return row?.max == null ? null : Number(row.max);
};

/** 项目内存在进行中执行（state = 'claimed'）的版本 ID 集合（集合查询，避免列表 N+1） */
const claimedVersionIds = async (db: Db, pid: string): Promise<Set<string>> =>
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

interface VersionTreeNode {
  id: string;
  number: number;
  parentId: string | null;
  retired: boolean;
}

interface UnretireAnalysis<T extends VersionTreeNode> {
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
const analyzeUnretire = <T extends VersionTreeNode>(nodes: readonly T[]): UnretireAnalysis<T> => {
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

const loadVersionTree = async (db: Db, pid: string): Promise<VersionTreeNode[]> => {
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

interface InfoFlags {
  latest: boolean;
  executed: boolean;
  unretirable: boolean;
}

const toInfo = (v: InfoRow, flags: InfoFlags): VersionInfo => ({
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

const toDetail = (v: VersionRow, flags: InfoFlags): VersionDetail => ({
  ...toInfo(v, flags),
  upSteps: v.upSteps,
  downSteps: v.downSteps,
  checksum: v.checksum,
  verifyReport: v.verifyReport,
});

const versionDetailOf = async (db: Db, pid: string, v: VersionRow): Promise<VersionDetail> => {
  const analysis = analyzeUnretire(await loadVersionTree(db, pid));
  const executed =
    (v.executedAt !== null && v.executedAt !== undefined) || (await versionExecutedAnywhere(db, v.id));
  return toDetail(v, {
    latest: v.id === (analysis.activeHead?.id ?? null),
    executed,
    unretirable: analysis.ids.has(v.id),
  });
};

const CHAIN_CHANGED = '版本链刚刚发生了变化（有人先发布了），请刷新后重试';

type MultiVersionVerifyOutcome =
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
const verifyAcrossVersions = async (
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

    // 仅 PG 与 MySQL 各自按对应影子库实测版本归档与校对；非 PG 方言（SQLite / MySQL / MSSQL）不按 PG 大版本归档或拼 PG 前缀
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

  // 所有候选影子库在运行期都遇到 ShadowError：回退为基础设施不可用
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

  // 严格安全规则：只要 PG 项目存在已记录版本的最低目标 targetPgMajor，且本次实测通过的影子库集合中未覆盖该大版本
  // （包括多版本缺低版本影子库、存在未探测版本环境、或独立 shadowUrl 与目标库大版本错配），均不得标记为已验证
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

  // MySQL 混部（如 9.7 dev + 8.4 prod）缺失最低目标版本影子库或实际版本错配时，不得仅凭高版本通过标为已验证
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

export const registerVersions = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, shadows, refresher } = ctx;

  /**
   * 串行化“检查链头 + 写入”：发布和编辑脚本都先锁住项目行，再看链头。
   * PG 用 select … for update；SQLite 只有一个连接，写事务（BEGIN IMMEDIATE）和其他语句排成一队，天然串行。
   */
  const lockChain = async (tx: Db, pid: string) => {
    if (db.dialect === 'pg') await tx.query('select id from projects where id = $1 for update', [pid]);
  };

  /** 在平台库事务外同步或回退工作副本，避免持有平台库锁期间等待房间 / 派生队列（#17） */
  const syncWorkingCopy = async (
    branch: string,
    userName: string,
    targetModel: Model,
    opName: string,
    requestedSeq: number | undefined,
  ): Promise<WorkingCopyOutcome> => {
    await refresher.flush(branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(branch);
    if (requestedSeq !== undefined && requestedSeq !== currentSeq) return 'changed';
    const expectedSeq = requestedSeq ?? currentSeq;
    if (deepEqual(currentModel, targetModel)) return 'unchanged';
    try {
      await ctx.replace(branch, userName, targetModel, opName, expectedSeq);
      return 'reverted';
    } catch (e) {
      if (e instanceof WorkingChangedError) return 'changed';
      throw e;
    }
  };

  app.get('/api/projects/:pid/versions', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const rows = await db.query<InfoRow>(
      `select ${INFO_COLUMNS}
         from versions v
         left join users u on u.id = v.created_by
         left join users ru on ru.id = v.retired_by
        where v.project_id = $1
        order by v.number desc`,
      [a.pid],
    );
    const claimedIds = await claimedVersionIds(db, a.pid);
    const analysis = analyzeUnretire(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        parentId: r.parentId,
        retired: r.retiredAt !== null && r.retiredAt !== undefined,
      })),
    );
    const activeHeadId = analysis.activeHead?.id ?? null;
    return c.json<VersionInfo[]>(
      rows.map((v) =>
        toInfo(v, {
          latest: v.id === activeHeadId,
          executed: (v.executedAt !== null && v.executedAt !== undefined) || claimedIds.has(v.id),
          unretirable: analysis.ids.has(v.id),
        }),
      ),
    );
  });

  app.get('/api/projects/:pid/published-tables', async (c) => {
    const a = await access(c, ctx, 'project.read');
    // 下推 JSON 键提取与去重到数据库侧，避免拉取并反序列化所有历史版本的完整模型；
    // 排除已作废且从未在任何环境执行过的版本，允许继续调整未落地目标库的表分区
    const rows =
      db.dialect === 'pg'
        ? await db.query<{ id: string }>(
            `select distinct e.key as id
               from versions v,
                    jsonb_each(
                      case when jsonb_typeof(v.model -> 'objects') = 'object' then v.model -> 'objects' end
                    ) as e(key, val)
              where v.project_id = $1
                and (v.retired_at is null or v.executed_at is not null)
                and e.val ->> 'kind' = 'table'`,
            [a.pid],
          )
        : await db.query<{ id: string }>(
            `select distinct e.key as id
               from versions v, json_each(v.model, '$.objects') as e
              where v.project_id = $1
                and (v.retired_at is null or v.executed_at is not null)
                and json_extract(e.value, '$.kind') = 'table'`,
            [a.pid],
          );
    return c.json<PublishedTables>({ tableIds: rows.map((r) => r.id) });
  });

  app.get('/api/projects/:pid/versions/:vid', async (c) => {
    const a = await access(c, ctx, 'migration.read');
    const v = await loadVersion(db, a.pid, c.req.param('vid'));
    return c.json<VersionDetail>(await versionDetailOf(db, a.pid, v));
  });

  /**
   * 发布 = 冻结迁移：from 是当前活跃链头（第一个版本是带 public 的空模型），to 是当前工作副本；
   * up = plan(from, to)，down = plan(to, from)。新版本号 = 全局最大编号 + 1（不重用已作废号段）。
   * 有影子库就先闭环验证，没通过不发布（422 + 报告）；没有影子库允许发布，但 verified_at 为空。
   */
  app.post('/api/projects/:pid/versions', async (c) => {
    const a = await access(c, ctx, 'version.publish');
    const b = await body(c, versionCreateSchema);
    await refresher.flush(a.branch);
    const { model, seq } = await rooms.model(a.branch);
    const modelErrs = validate(model);
    if (modelErrs.length > 0) {
      throw new HTTPException(422, { message: `模型校验未通过，无法发布：${modelErrs[0]}` });
    }
    const parent = await activeHeadWithModel(db, a.pid);
    const maxBefore = await globalMaxNumber(db, a.pid);
    const from = chainFrom(parent, model, a.schemas);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    const frozen = freezeScripts(from, model, planOpts);
    // 兜底：规划器正常不会生成实例/文件级语句，真出现了就不发布（验证会真的执行它们）
    const instanceLevel = instanceLevelProblem(frozen.up, frozen.down, a.dialect);
    if (instanceLevel) throw new HTTPException(422, { message: instanceLevel });
    if (!frozen.up.length)
      throw new HTTPException(422, {
        message: parent
          ? `没有变更：工作副本与当前活跃版本（v${parent.number}）之间没有需要执行的 SQL`
          : '没有变更：工作副本还是空的，没有需要执行的 SQL',
      });

    let verifiedAt: string | null = null;
    let verifyReport: StoredVerifyReport | null = null;
    let unverifiedReason: string | null = null;
    // 只放过预期的“没有影子库 / 影子库不可用”（ShadowError：没有环境、生产环境不让用同实例、连不上、被占用）；
    // 密钥解密失败（SecretError）、白名单拒绝（HTTPException）、平台库错误都继续抛出
    try {
      const outcome = await verifyAcrossVersions(
        shadows,
        a.pid,
        from,
        model,
        frozen.up,
        frozen.down,
        true,
        planOpts,
      );
      if (outcome.kind === 'failed') {
        const msg =
          outcome.failedVersionLabel !== null
            ? `${outcome.failedVersionLabel} 影子库闭环验证没有通过，版本没有发布。请先修正模型`
            : '闭环验证没有通过，版本没有发布。请先修正模型';
        return c.json<PublishRejected>({ error: msg, report: outcome.report }, 422);
      }
      if (outcome.kind === 'missing_target') {
        verifyReport = outcome.stored;
        unverifiedReason = outcome.reason;
      } else {
        verifiedAt = outcome.stored.at;
        verifyReport = outcome.stored;
      }
    } catch (e) {
      // 连接断开、超时、被占用这类基础设施故障（shadow.ts 统一抛 ShadowError）不是“脚本有问题”：
      // 和“没有影子库”同样处理，发布但标为未验证，原因写明
      if (!(e instanceof ShadowError)) throw e;
      unverifiedReason = scrubSecrets(e.message);
    }

    const id = newId();
    const number = (maxBefore ?? 0) + 1;
    try {
      await db.transaction(async (tx) => {
        // 验证在事务之外（很慢）：提交前锁住项目行（PG；SQLite 的写事务本来就是串行的），
        // 在锁里同时校验活跃链头与全局最大版本号都没变化（避免与并发发布/作废/取消作废撞车）
        await lockChain(tx, a.pid);
        const headNow = await activeHead(tx, a.pid);
        const maxNow = await globalMaxNumber(tx, a.pid);
        if ((headNow?.id ?? null) !== (parent?.id ?? null) || maxNow !== maxBefore)
          throw new HTTPException(409, { message: CHAIN_CHANGED });
        await tx.query(
          `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                                up_steps, down_steps, checksum, verified_at, verify_report, scope)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10::text::jsonb, $11::text::jsonb, $12,
                   $13, $14::text::jsonb, $15::text::jsonb)`,
          [
            id,
            a.pid,
            a.branch,
            seq,
            b.name,
            JSON.stringify(model),
            c.get('user').id,
            number,
            parent?.id ?? null,
            JSON.stringify(frozen.up),
            JSON.stringify(frozen.down),
            frozen.checksum,
            verifiedAt,
            verifyReport ? JSON.stringify(verifyReport) : null,
            a.schemas?.length ? JSON.stringify(a.schemas) : null,
          ],
        );
      });
    } catch (e) {
      // (project_id, number) 唯一索引兜底：两个发布同时通过了上面的检查
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: CHAIN_CHANGED });
      throw e;
    }
    await audit(
      db,
      c,
      {
        action: 'version.publish',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'version',
        targetId: id,
        projectId: a.pid,
        data: {
          projectId: a.pid,
          name: b.name,
          seq,
          number,
          verified: verifiedAt !== null,
          checksum: frozen.checksum,
        },
      },
      ctx.security,
    );
    return c.json<VersionCreated>(
      {
        id,
        name: b.name,
        seq,
        number,
        verified: verifiedAt !== null,
        unverifiedReason,
        // 验证通过但风险分析没有完成：界面要让用户看到，不能悄悄当成“没有风险”
        riskError: verifiedAt !== null ? (verifyReport?.riskError ?? null) : null,
      },
      201,
    );
  });

  /**
   * 人工编辑冻结的脚本（整体替换 up 和 down）。只能改活跃主链最新、且还没在任何环境执行过的版本：
   * 已作废版本及历史版本均不可改。改完 edited = true、清空验证结果、重算 checksum。
   * 内容没有变化时什么都不改（不会白白把已验证的版本打回未验证）。
   */
  app.patch('/api/projects/:pid/versions/:vid/steps', async (c) => {
    const a = await access(c, ctx, 'version.edit');
    const b = await body(c, stepsPatchSchema);
    const vid = c.req.param('vid');
    for (const [dir, steps] of [
      ['升级', b.up],
      ['回滚', b.down],
    ] as const)
      for (const [i, s] of steps.entries())
        if (!s.sql.trim()) throw new HTTPException(422, { message: `${dir}脚本第 ${i + 1} 步是空的` });
    // 检测到不能进事务的语句就强制 transactional = false；用户手动标 false 也保留
    const forceTx = (steps: ScriptStep[]) =>
      canonicalSteps(steps).map((x) => ({
        ...x,
        transactional: x.transactional && !isNontransactionalSql(x.sql, a.dialect),
      }));
    const up = forceTx(b.up);
    const down = forceTx(b.down);
    const instanceLevel = instanceLevelProblem(up, down, a.dialect);
    if (instanceLevel) throw new HTTPException(422, { message: instanceLevel });
    const checksum = stepsChecksum(up, down);

    // 检查和更新在同一个事务里：不会在检查“活跃最新”之后、更新之前被别人发布或作废
    const changed = await db.transaction(async (tx) => {
      await lockChain(tx, a.pid);
      const v = await loadVersion(tx, a.pid, vid);
      if (v.retiredAt !== null && v.retiredAt !== undefined)
        throw new HTTPException(409, { message: '已作废的版本不能编辑脚本' });
      if ((await activeHead(tx, a.pid))?.id !== v.id)
        throw new HTTPException(409, { message: '只有活跃主链最新的版本可以编辑脚本' });
      if (await versionExecutedAnywhere(tx, v.id))
        throw new HTTPException(409, { message: '这个版本已经在环境上执行过，不能再改脚本' });
      if (checksum === v.checksum) return false;
      await tx.query(
        `update versions set up_steps = $2::text::jsonb, down_steps = $3::text::jsonb, checksum = $4,
                edited = $5, verified_at = null, verify_report = null
          where id = $1`,
        [v.id, JSON.stringify(up), JSON.stringify(down), checksum, true],
      );
      return true;
    });
    if (changed)
      await audit(
        db,
        c,
        {
          action: 'version.edit_steps',
          actorKind: 'user',
          actorId: c.get('user').id,
          targetKind: 'version',
          targetId: vid,
          projectId: a.pid,
          data: { projectId: a.pid, checksum, upSteps: up.length, downSteps: down.length },
        },
        ctx.security,
      );
    const v = await loadVersion(db, a.pid, vid);
    // P5b：脚本变了（校验和变了），绑定了这个版本的执行申请会失效
    ctx.requests.kick({ projectIds: [a.pid] });
    return c.json<VersionDetail>(await versionDetailOf(db, a.pid, v));
  });

  /**
   * 重新验证：在影子库里建出 from，**执行冻结的 up 脚本**（不是重新 plan），结果必须等于这个版本的模型；
   * 再执行冻结的 down 脚本，必须回到 from。v0 基线没有回滚脚本，只验证建库那一半。
   */
  app.post('/api/projects/:pid/versions/:vid/verify', async (c) => {
    const a = await access(c, ctx, 'version.verify');
    const v = await loadVersion(db, a.pid, c.req.param('vid'));
    const parent = v.parentId
      ? ((
          await db.query<{ model: Model }>('select model from versions where id = $1 and project_id = $2', [
            v.parentId,
            a.pid,
          ])
        )[0] ?? null)
      : null;
    if (v.parentId && !parent) throw new HTTPException(422, { message: '上一个版本不存在，版本链已损坏' });
    // 第一个版本的 from 用冻结时记下的范围，不用项目当前的（范围之后可能改过）
    const from = chainFrom(parent, v.model, v.scope);
    const checkDown = !(v.number === 0 && v.downSteps.length === 0);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    // 影子库的故障（拿不到、连接断开、超时……）是 ShadowError，直接抛出（422），不写回任何验证状态
    const outcome = await verifyAcrossVersions(
      shadows,
      a.pid,
      from,
      v.model,
      v.upSteps,
      v.downSteps,
      checkDown,
      planOpts,
    );
    const report = outcome.stored;
    const verifiedAt = outcome.kind === 'ok' ? report.at : null;
    // 只在脚本没有被同时改动时写回（checksum 没变）；否则这份报告属于旧脚本，丢弃
    const written = await db.query<{ id: string }>(
      `update versions set verified_at = $3, verify_report = $4::text::jsonb
        where id = $1 and checksum = $2 returning id`,
      [v.id, v.checksum, verifiedAt, JSON.stringify(report)],
    );
    if (!written.length)
      throw new HTTPException(409, { message: '验证期间脚本被改动了，这次的结果作废，请重新验证' });
    await audit(
      db,
      c,
      {
        action: 'version.verify',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'version',
        targetId: v.id,
        projectId: a.pid,
        data: { projectId: a.pid, number: v.number, ok: verifiedAt !== null, checksum: v.checksum },
      },
      ctx.security,
    );
    return c.json<VersionVerifyResponse>({ report, verifiedAt });
  });

  /** 解析版本引用：`empty` 空模型，`head` 当前工作副本，其余是版本 ID */
  const resolve = async (
    pid: string,
    branch: string,
    ref: string | undefined,
    like?: Model,
    scope?: string[] | null,
  ): Promise<Model> => {
    await refresher.flush(branch); // 不透明对象的 DDL 先刷新到最新
    if (!ref || ref === 'head') return (await rooms.model(branch)).model;
    // 空库：由项目的 schema 范围决定带不带 public（见 emptyBase）；没给目标时参照当前工作副本
    if (ref === 'empty') return emptyBase(like ?? (await rooms.model(branch)).model, scope);
    const [v] = await db.query<{ model: Model }>(
      'select model from versions where id = $1 and project_id = $2',
      [ref, pid],
    );
    if (!v) throw new HTTPException(404, { message: `版本不存在：${ref}` });
    return v.model;
  };

  app.get('/api/projects/:pid/migration', async (c) => {
    const a = await access(c, ctx, 'migration.read');
    const to = await resolve(a.pid, a.branch, c.req.query('to'));
    const from = await resolve(a.pid, a.branch, c.req.query('from') ?? 'empty', to, a.schemas);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    const up = plan(from, to, planOpts);
    const down = plan(to, from, planOpts);
    if (c.req.query('format') === 'sql') {
      // 迁移脚本开头带上固定的会话设置（04-ir-design.md 1.6），保证在任何会话下执行结果相同
      const header = getEngine(a.dialect).sessionHeader();
      const body = formatScript(up, a.dialect);
      return c.text(`${header ? `${header}\n\n` : ''}${body}\n`, 200, {
        'content-type': 'application/sql; charset=utf-8',
      });
    }
    return c.json<MigrationResult>({ up, down });
  });

  app.get('/api/projects/:pid/ddl', async (c) => {
    const a = await access(c, ctx, 'ddl.read');
    const m = await resolve(a.pid, a.branch, c.req.query('version'));
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    return c.text(`${formatScript(createAll(m, planOpts), a.dialect)}\n`, 200, {
      'content-type': 'application/sql; charset=utf-8',
    });
  });

  /**
   * 作废活跃主链最末尾的连续一段版本（ADR 0013）：软作废（写 retired_at / retired_by），
   * 永远不允许作废首个版本；存在执行中登记（claimed）时拒绝；含已执行版本需项目管理员权限；
   * 事务提交后踢一轮申请巡检并按需把工作副本回退到该段父版本。
   */
  app.post('/api/projects/:pid/versions/:vid/retire', async (c) => {
    const a = await access(c, ctx, 'version.retire');
    const b = await body(c, versionRetireSchema);
    const vid = c.req.param('vid');
    const user = c.get('user');

    interface SpanRow {
      id: string;
      number: number;
      name: string;
      parentId: string | null;
      retiredAt: unknown;
      executedAt: unknown;
    }

    const done = await db.transaction(async (tx) => {
      await lockChain(tx, a.pid);
      const rows = await tx.query<SpanRow>(
        `select id, number, name, parent_id as "parentId", retired_at as "retiredAt", executed_at as "executedAt"
           from versions
          where project_id = $1
          order by number asc`,
        [a.pid],
      );
      const target = rows.find((r) => r.id === vid);
      if (!target) throw new HTTPException(404, { message: '版本不存在' });

      const active = rows.filter((r) => r.retiredAt === null || r.retiredAt === undefined);
      const head = active.at(-1) ?? null;
      if (!head || b.head !== head.id) {
        throw new CodedHTTPException(
          409,
          '活跃主链的最新版本已变化，请刷新后重新确认作废范围',
          'head_changed',
        );
      }
      if (target.retiredAt !== null && target.retiredAt !== undefined) {
        throw new HTTPException(422, { message: '该版本已经作废' });
      }
      if (target.parentId === null) {
        throw new HTTPException(422, { message: '首个版本不能作废' });
      }

      const activeChain = pathFromRoot(indexTree(rows), head.id);
      const idx = activeChain?.findIndex((v) => v.id === target.id) ?? -1;
      if (!activeChain || idx <= 0) {
        throw new HTTPException(422, { message: '该版本不在当前活跃主链上' });
      }
      const span = activeChain.slice(idx);
      const newHead = activeChain[idx - 1]!;
      const spanIds = span.map((v) => v.id);

      const claimed = (
        await tx.query<{ versionId: string; envName: string }>(
          `select ev.version_id as "versionId", e.name as "envName"
             from environment_versions ev
             join environments e on e.id = ev.environment_id
            where ev.version_id in (${inList(spanIds)}) and ev.state = 'claimed'
            order by e.name asc
            limit 1`,
          spanIds,
        )
      )[0];
      if (claimed) {
        const cv = span.find((v) => v.id === claimed.versionId)!;
        throw new CodedHTTPException(
          409,
          `版本 v${cv.number} 正在环境「${claimed.envName}」上执行中，无法作废`,
          'execution_in_progress',
        );
      }

      const anyExecuted = span.some((v) => v.executedAt !== null && v.executedAt !== undefined);
      if (
        anyExecuted &&
        !can(userActor(user), 'version.retire_executed', { kind: 'project', role: a.role })
      ) {
        throw new HTTPException(403, { message: '作废已在环境执行过的版本需要项目管理员权限' });
      }

      const openReqs = await tx.query<{
        id: string;
        direction: 'up' | 'down';
        to_version_id: string;
        migrations: RequestMigration[];
        created_at: unknown;
      }>(
        `select id, direction, to_version_id, migrations, created_at
           from exec_requests
          where project_id = $1 and ${sweepWhere(db.dialect)}`,
        [a.pid],
      );
      const spanSet = new Set(spanIds);
      const affected = openReqs.filter(
        (r) =>
          (r.direction !== 'down' && spanSet.has(r.to_version_id)) ||
          (Array.isArray(r.migrations) && r.migrations.some((m) => spanSet.has(m.versionId))),
      );

      const nowMs = Date.now();
      let maxReqCreatedMs = 0;
      for (const r of affected) {
        const ms = new Date(iso(r.created_at) ?? 0).getTime();
        if (ms > maxReqCreatedMs) maxReqCreatedMs = ms;
      }
      // 保证同毫秒内先创建申请、再作废时严格满足 retired_at > created_at（触发回滚绑定失效判定）
      const retiredAtMs = maxReqCreatedMs >= nowMs ? maxReqCreatedMs + 1 : nowMs;

      await tx.query(
        `update versions set retired_at = $1, retired_by = $2 where id in (${inList(spanIds, 3)})`,
        [new Date(retiredAtMs).toISOString(), user.id, ...spanIds],
      );

      let parentModel: Model | null = null;
      if (!b.keepWorkingCopy) {
        const [pRow] = await tx.query<{ model: Model }>('select model from versions where id = $1', [
          newHead.id,
        ]);
        parentModel = pRow?.model ?? null;
      }

      return {
        span,
        head,
        newHead,
        anyExecuted,
        invalidatedRequests: affected.length,
        retiredAtMs,
        parentModel,
      };
    });

    const lagMs = done.retiredAtMs - Date.now();
    if (lagMs >= 0) await new Promise((r) => setTimeout(r, lagMs + 1));

    ctx.requests.kick({ projectIds: [a.pid] });

    const workingCopy: WorkingCopyOutcome = b.keepWorkingCopy
      ? 'kept'
      : await syncWorkingCopy(a.branch, user.name, done.parentModel!, 'retireVersions', b.workingSeq);

    const toRef = (v: { id: string; number: number; name: string }): VersionRef => ({
      id: v.id,
      number: v.number,
      name: v.name,
    });
    const retired = done.span.map(toRef);
    const headRef = toRef(done.newHead);

    await audit(
      db,
      c,
      {
        action: 'version.retire',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'version',
        targetId: vid,
        projectId: a.pid,
        data: {
          projectId: a.pid,
          retired,
          headBefore: toRef(done.head),
          headAfter: headRef,
          executed: done.anyExecuted,
          invalidatedRequests: done.invalidatedRequests,
          workingCopy,
        },
      },
      ctx.security,
    );

    return c.json<VersionRetireResult>({
      retired,
      head: headRef,
      invalidatedRequests: done.invalidatedRequests,
      workingCopy,
    });
  });

  /**
   * 一键取消作废（ADR 0013）：仅当尚未发布更新版本时允许恢复整条连续已作废链尾
   * `(activeHead, globalMax]`；权限分级同 retire；不复活此前已失效的执行申请。
   */
  app.post('/api/projects/:pid/versions/:vid/unretire', async (c) => {
    const a = await access(c, ctx, 'version.retire');
    const b = await body(c, versionUnretireSchema);
    const vid = c.req.param('vid');
    const user = c.get('user');

    interface UnretireRow extends VersionTreeNode {
      name: string;
      retiredAt: unknown;
      executedAt: unknown;
    }

    const done = await db.transaction(async (tx) => {
      await lockChain(tx, a.pid);
      const raw = await tx.query<{
        id: string;
        number: number;
        name: string;
        parentId: string | null;
        retiredAt: unknown;
        executedAt: unknown;
      }>(
        `select id, number, name, parent_id as "parentId", retired_at as "retiredAt", executed_at as "executedAt"
           from versions
          where project_id = $1
          order by number asc`,
        [a.pid],
      );
      const target = raw.find((r) => r.id === vid);
      if (!target) throw new HTTPException(404, { message: '版本不存在' });

      const nodes: UnretireRow[] = raw.map((r) => ({
        ...r,
        retired: r.retiredAt !== null && r.retiredAt !== undefined,
      }));
      const analysis = analyzeUnretire(nodes);

      if (!analysis.ids.has(target.id)) {
        if (!target.retiredAt) {
          throw new CodedHTTPException(409, '该版本未作废，无需取消作废', 'not_unretirable');
        }
        if (analysis.globalMax && analysis.globalMax.id !== target.id) {
          const lca = routeBetween(indexTree(nodes), target.id, analysis.globalMax.id)?.lca;
          if (lca) {
            throw new CodedHTTPException(
              409,
              `已经基于 v${lca.number} 发布了更新的版本 v${analysis.globalMax.number}，无法取消作废 v${target.number}`,
              'not_unretirable',
            );
          }
          throw new CodedHTTPException(
            409,
            `无法取消作废 v${target.number}：它不在当前可恢复的链尾路径上`,
            'not_unretirable',
          );
        }
        throw new CodedHTTPException(409, '当前版本树状态下无法取消作废该版本', 'not_unretirable');
      }

      const span = analysis.path;
      const spanIds = span.map((v) => v.id);
      const headBefore = analysis.activeHead!;
      const newHead = analysis.globalMax!;

      const hasClaimed =
        (
          await tx.query<{ x: number }>(
            `select 1 as x from environment_versions where version_id in (${inList(spanIds)}) and state = 'claimed' limit 1`,
            spanIds,
          )
        ).length > 0;
      const anyExecuted = hasClaimed || span.some((v) => v.executedAt !== null && v.executedAt !== undefined);
      if (
        anyExecuted &&
        !can(userActor(user), 'version.retire_executed', { kind: 'project', role: a.role })
      ) {
        throw new HTTPException(403, { message: '取消作废已在环境执行过的版本需要项目管理员权限' });
      }

      await tx.query(
        `update versions set retired_at = null, retired_by = null where id in (${inList(spanIds)})`,
        spanIds,
      );

      let headModel: Model | null = null;
      if (b.syncWorkingCopy) {
        const [hRow] = await tx.query<{ model: Model }>('select model from versions where id = $1', [
          newHead.id,
        ]);
        headModel = hRow?.model ?? null;
      }

      return { span, headBefore, newHead, anyExecuted, headModel };
    });

    const workingCopy: WorkingCopyOutcome = b.syncWorkingCopy
      ? await syncWorkingCopy(a.branch, user.name, done.headModel!, 'unretireVersions', b.workingSeq)
      : 'kept';

    const toRef = (v: { id: string; number: number; name: string }): VersionRef => ({
      id: v.id,
      number: v.number,
      name: v.name,
    });
    const restored = done.span.map(toRef);
    const headRef = toRef(done.newHead);

    await audit(
      db,
      c,
      {
        action: 'version.unretire',
        actorKind: 'user',
        actorId: user.id,
        targetKind: 'version',
        targetId: vid,
        projectId: a.pid,
        data: {
          projectId: a.pid,
          restored,
          headBefore: toRef(done.headBefore),
          headAfter: headRef,
          executed: done.anyExecuted,
          workingCopy,
        },
      },
      ctx.security,
    );

    return c.json<VersionUnretireResult>({
      restored,
      head: headRef,
      workingCopy,
    });
  });

  /** 应用任意版本（含已作废版本）到画布前的差异预览 */
  app.get('/api/projects/:pid/versions/:vid/canvas-diff', async (c) => {
    const a = await access(c, ctx, 'project.read');
    const v = await loadVersion(db, a.pid, c.req.param('vid'));
    await refresher.flush(a.branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(a.branch);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    return c.json<VersionCanvasDiff>({
      diffToCurrent: planDiff(currentModel, v.model, planOpts),
      currentSeq,
    });
  });

  /** 应用任意版本（含已作废版本）的模型到画布工作副本（作为新提交记入画布历史） */
  app.post('/api/projects/:pid/versions/:vid/apply', async (c) => {
    const a = await access(c, ctx, 'sync.edit');
    const b = await body(c, versionApplySchema);
    const v = await loadVersion(db, a.pid, c.req.param('vid'));
    await refresher.flush(a.branch);
    const { model: currentModel, seq: currentSeq } = await rooms.model(a.branch);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    const conflictOf = (curSeq: number, curModel: Model) =>
      c.json<CanvasHistoryConflict>(
        {
          error: '工作副本在你查看期间已被修改，请确认最新差异后再应用',
          code: 'working_changed',
          currentSeq: curSeq,
          diffToCurrent: planDiff(curModel, v.model, planOpts),
        },
        409,
      );
    if (b.workingSeq !== currentSeq) return conflictOf(currentSeq, currentModel);
    const diffToCurrent = planDiff(currentModel, v.model, planOpts);
    if (diffToCurrent.total === 0 && deepEqual(currentModel, v.model)) {
      return c.json<ModelUpdate>({
        seq: currentSeq,
        objects: Object.keys(currentModel.objects).length,
      });
    }
    const fromSeq = currentSeq;
    try {
      await ctx.replace(a.branch, c.get('user').name, v.model, 'applyVersion', b.workingSeq);
    } catch (e) {
      if (e instanceof WorkingChangedError) return conflictOf(e.currentSeq, e.currentModel);
      throw e;
    }
    const next = await rooms.model(a.branch);
    await audit(
      db,
      c,
      {
        action: 'model.apply_version',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'project',
        targetId: a.pid,
        projectId: a.pid,
        data: { versionId: v.id, number: v.number, name: v.name, fromSeq, newSeq: next.seq },
      },
      ctx.security,
    );
    return c.json<ModelUpdate>({
      seq: next.seq,
      objects: Object.keys(next.model.objects).length,
    });
  });

  app.post('/api/projects/:pid/verify', async (c) => {
    const a = await access(c, ctx, 'model.verify');
    const b = await body(c, verifyRequestSchema);
    const to = await resolve(a.pid, a.branch, b.to);
    const from = await resolve(a.pid, a.branch, b.from, to, a.schemas);
    const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
    const s = await shadows.forProject(a.pid, b.env);
    return c.json<VerifyResponse>({
      ...(await s.shadow.verify(from, to, planOpts)),
      shadow: s.label,
    });
  });
};
