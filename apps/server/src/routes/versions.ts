// 版本（发布 = 冻结迁移）、迁移脚本、DDL 导出和迁移验证。
// 版本是链上的不可变快照；发布时从上一个版本生成升级 / 回滚脚本，在影子库里闭环验证，通过后冻结（ADR 0002）。
// 之后只有“链上最新、还没在任何环境执行过”的版本可以人工改脚本，改完就回到未验证。
import {
  type MigrationResult,
  type PublishedTables,
  type PublishRejected,
  type StoredVerifyReport,
  stepsPatchSchema,
  type VerifyReport,
  type VerifyResponse,
  type VerifyTargetReport,
  type VersionCreated,
  type VersionDetail,
  type VersionInfo,
  type VersionVerifyResponse,
  verifyRequestSchema,
  versionCreateSchema,
} from '@dowel/api';
import { createAll, formatScript, type Model, newId, plan, validate } from '@dowel/core';
import {
  canonicalSteps,
  type Db,
  getEngine,
  isNontransactionalSql,
  type ScriptStep,
  stepsChecksum,
} from '@dowel/engines';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { audit } from '../audit.ts';
import {
  chainFrom,
  emptyBase,
  freezeScripts,
  instanceLevelProblem,
  versionExecutedAnywhere,
} from '../chain.ts';
import { isUniqueViolation } from '../db.ts';
import { projectTargetPgMajor } from '../envs.ts';
import { scrubSecrets } from '../secrets.ts';
import { ShadowError, storedReport } from '../shadow.ts';
import type { Shadows } from '../shadows.ts';
import { type AppContext, access, body, type Env } from './context.ts';

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
  restoredAt: string | null;
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
  v.created_at as "createdAt", u.name as "createdBy", v.restored_at as "restoredAt"`;
const ROW_COLUMNS = `${INFO_COLUMNS}, v.model, v.up_steps as "upSteps", v.down_steps as "downSteps", v.checksum,
  v.verify_report as "verifyReport", v.scope`;

/** 取项目里的一个版本（带冻结脚本和验证报告）；不存在抛 404 */
const loadVersion = async (db: Db, pid: string, vid: string): Promise<VersionRow> => {
  const [v] = await db.query<VersionRow>(
    `select ${ROW_COLUMNS} from versions v left join users u on u.id = v.created_by
      where v.id = $1 and v.project_id = $2`,
    [vid, pid],
  );
  if (!v) throw new HTTPException(404, { message: '版本不存在' });
  return v;
};

/** 链头概要：链上最新的版本（number 最大）的 id 和 number。检查并发、判断“是不是最新”只需要它，不读模型 */
const chainHead = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number }>(
      'select id, number from versions where project_id = $1 order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

/** 链头连同模型：只有发布时算 parent / from 才需要 */
const chainHeadWithModel = async (db: Db, pid: string) =>
  (
    await db.query<{ id: string; number: number; model: Model }>(
      'select id, number, model from versions where project_id = $1 order by number desc limit 1',
      [pid],
    )
  )[0] ?? null;

const toInfo = (v: InfoRow, latestId: string | null): VersionInfo => ({
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

const toDetail = (v: VersionRow, latestId: string | null): VersionDetail => ({
  ...toInfo(v, latestId),
  upSteps: v.upSteps,
  downSteps: v.downSteps,
  checksum: v.checksum,
  verifyReport: v.verifyReport,
});

const CHAIN_CHANGED = '版本链刚刚发生了变化（有人先发布了），请刷新后重试';

type MultiVersionVerifyOutcome =
  | { kind: 'ok'; stored: StoredVerifyReport }
  | { kind: 'failed'; report: VerifyResponse; stored: StoredVerifyReport; failedMajor: number | null }
  | { kind: 'missing_target'; missingMajor: number; reason: string; stored: StoredVerifyReport };

/**
 * 跨大版本影子库闭环验证冻结脚本（按大版本升序逐一执行，风险分析仅在首个可用影子库执行一次）：
 * - 任一大版本闭环验证失败 → 整体失败并指出具体 PG 版本；
 * - 存在多个 PG 大版本且最低目标版本 targetPgMajor 缺少可用影子库 → 不得标为已验证（missing_target），
 *   在报告与原因中明确写明缺少 PG <targetPgMajor> 影子库；
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
): Promise<MultiVersionVerifyOutcome> => {
  const selection = await shadows.forProjectVersions(pid);
  if (!selection.entries.length) {
    throw new ShadowError(selection.skippedMajors[0]?.reason ?? '没有可用的影子库');
  }

  const targets: VerifyTargetReport[] = [];
  const passedShadows: { major: number | null; label: string }[] = [];
  const runtimeSkipped = new Map<number | null, string>();
  const mismatchReasons = new Map<number, string>();
  let primaryReport: VerifyReport | null = null;
  let ranRisk = false;

  for (const entry of selection.entries) {
    let report: VerifyReport;
    try {
      report = await entry.shadow.verifyScripts(from, to, up, down, {
        checkDown,
        skipRisk: ranRisk,
      });
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      runtimeSkipped.set(entry.major, scrubSecrets(e.message));
      continue;
    }

    if (!ranRisk) {
      primaryReport = report;
      ranRisk = true;
    }

    // 以影子库实测大版本为准；若独立 shadowUrl 的实际 PG 大版本与环境声称的不一致，不得记作覆盖了目标大版本
    const actualMajor = report.shadowMajor !== undefined ? report.shadowMajor : entry.major;
    if (entry.major !== null && actualMajor !== null && actualMajor !== entry.major) {
      mismatchReasons.set(
        entry.major,
        `影子库实际版本为 PG ${actualMajor}（${entry.label}），与目标环境 PG ${entry.major} 不一致，不能作为 PG ${entry.major} 的验证依据`,
      );
    }

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
      const shadowLabel = actualMajor !== null ? `PG ${actualMajor}（${entry.label}）` : entry.label;
      const withPrefix =
        actualMajor !== null && report.error
          ? {
              ...report,
              error: {
                ...report.error,
                message: `PG ${actualMajor} 验证失败：${report.error.message}`,
              },
            }
          : report;
      const extra = targets.length ? { targets } : undefined;
      return {
        kind: 'failed',
        failedMajor: actualMajor,
        report: {
          ...withPrefix,
          shadow: shadowLabel,
          ...(targets.length ? { targets } : {}),
        },
        stored: storedReport(withPrefix, shadowLabel, extra),
      };
    }

    passedShadows.push({ major: actualMajor, label: entry.label });
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
      : passedShadows.map((s) => (s.major !== null ? `PG ${s.major}（${s.label}）` : s.label)).join(' · ');

  // 严格安全规则：只要项目存在已记录版本的最低目标 targetPgMajor，且本次实测通过的影子库集合中未覆盖该大版本
  // （包括多版本缺低版本影子库、存在未探测版本环境、或独立 shadowUrl 与目标库大版本错配），均不得标记为已验证
  if (selection.targetPgMajor !== null && !passedShadows.some((s) => s.major === selection.targetPgMajor)) {
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

  app.get('/api/projects/:pid/versions', async (c) => {
    const a = await access(c, ctx, 'project.read');
    // 按链上的序号倒序，第一行就是最新的版本
    const rows = await db.query<InfoRow>(
      `select ${INFO_COLUMNS} from versions v left join users u on u.id = v.created_by
        where v.project_id = $1 order by v.number desc`,
      [a.pid],
    );
    return c.json<VersionInfo[]>(rows.map((v) => toInfo(v, rows[0]?.id ?? null)));
  });

  app.get('/api/projects/:pid/published-tables', async (c) => {
    const a = await access(c, ctx, 'project.read');
    // 下推 JSON 键提取与去重到数据库侧，避免拉取并反序列化所有历史版本的完整模型
    const rows =
      db.dialect === 'pg'
        ? await db.query<{ id: string }>(
            `select distinct e.key as id
               from versions v,
                    jsonb_each(
                      case when jsonb_typeof(v.model -> 'objects') = 'object' then v.model -> 'objects' end
                    ) as e(key, val)
              where v.project_id = $1 and e.val ->> 'kind' = 'table'`,
            [a.pid],
          )
        : await db.query<{ id: string }>(
            `select distinct e.key as id
               from versions v, json_each(v.model, '$.objects') as e
              where v.project_id = $1 and json_extract(e.value, '$.kind') = 'table'`,
            [a.pid],
          );
    return c.json<PublishedTables>({ tableIds: rows.map((r) => r.id) });
  });

  app.get('/api/projects/:pid/versions/:vid', async (c) => {
    const a = await access(c, ctx, 'migration.read');
    const v = await loadVersion(db, a.pid, c.req.param('vid'));
    return c.json<VersionDetail>(toDetail(v, (await chainHead(db, a.pid))?.id ?? null));
  });

  /**
   * 发布 = 冻结迁移：from 是上一个版本（第一个版本是带 public 的空模型），to 是当前工作副本；
   * up = plan(from, to)，down = plan(to, from)。有影子库就先闭环验证，没通过不发布（422 + 报告）；
   * 没有影子库允许发布，但 verified_at 为空，界面标为“未验证”（以后执行器会拒绝执行未验证的迁移）。
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
    const parent = await chainHeadWithModel(db, a.pid);
    const from = chainFrom(parent, model, a.schemas);
    const targetPgMajor = await projectTargetPgMajor(db, a.pid);
    const frozen = freezeScripts(
      from,
      model,
      targetPgMajor !== null ? { pgMajor: targetPgMajor } : undefined,
    );
    // 兜底：规划器正常不会生成实例/文件级语句，真出现了就不发布（验证会真的执行它们）
    const instanceLevel = instanceLevelProblem(frozen.up, frozen.down, a.dialect);
    if (instanceLevel) throw new HTTPException(422, { message: instanceLevel });
    if (!frozen.up.length)
      throw new HTTPException(422, {
        message: parent
          ? `没有变更：工作副本与上一个版本（v${parent.number}）之间没有需要执行的 SQL`
          : '没有变更：工作副本还是空的，没有需要执行的 SQL',
      });

    let verifiedAt: string | null = null;
    let verifyReport: StoredVerifyReport | null = null;
    let unverifiedReason: string | null = null;
    // 只放过预期的“没有影子库 / 影子库不可用”（ShadowError：没有环境、生产环境不让用同实例、连不上、被占用）；
    // 密钥解密失败（SecretError）、白名单拒绝（HTTPException）、平台库错误都继续抛出
    try {
      const outcome = await verifyAcrossVersions(shadows, a.pid, from, model, frozen.up, frozen.down, true);
      if (outcome.kind === 'failed') {
        const msg =
          outcome.failedMajor !== null
            ? `PG ${outcome.failedMajor} 影子库闭环验证没有通过，版本没有发布。请先修正模型`
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
    const number = (parent?.number ?? 0) + 1;
    try {
      await db.transaction(async (tx) => {
        // 验证在事务之外（很慢）：提交前锁住项目行（PG；SQLite 的写事务本来就是串行的），
        // 在锁里确认链头没有被别人抢先发布或改动
        await lockChain(tx, a.pid);
        const head = await chainHead(tx, a.pid);
        if ((head?.id ?? null) !== (parent?.id ?? null))
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
   * 人工编辑冻结的脚本（整体替换 up 和 down）。只能改链上最新、且还没在任何环境执行过的版本：
   * 改旧版本会让已经执行过它的环境和链对不上。改完 edited = true、清空验证结果、重算 checksum。
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

    // 检查和更新在同一个事务里：不会在检查“最新”之后、更新之前被别人发布了下一个版本
    const changed = await db.transaction(async (tx) => {
      await lockChain(tx, a.pid);
      const v = await loadVersion(tx, a.pid, vid);
      if ((await chainHead(tx, a.pid))?.id !== v.id)
        throw new HTTPException(409, { message: '只有链上最新的版本可以编辑脚本' });
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
    return c.json<VersionDetail>(toDetail(v, (await chainHead(db, a.pid))?.id ?? null));
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
    // 影子库的故障（拿不到、连接断开、超时……）是 ShadowError，直接抛出（422），不写回任何验证状态
    const outcome = await verifyAcrossVersions(
      shadows,
      a.pid,
      from,
      v.model,
      v.upSteps,
      v.downSteps,
      checkDown,
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
    const targetPgMajor = await projectTargetPgMajor(db, a.pid);
    const planOpts = targetPgMajor !== null ? { pgMajor: targetPgMajor } : undefined;
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
    const targetPgMajor = await projectTargetPgMajor(db, a.pid);
    return c.text(
      `${formatScript(
        createAll(m, targetPgMajor !== null ? { pgMajor: targetPgMajor } : undefined),
        a.dialect,
      )}\n`,
      200,
      {
        'content-type': 'application/sql; charset=utf-8',
      },
    );
  });

  app.post('/api/projects/:pid/verify', async (c) => {
    const a = await access(c, ctx, 'model.verify');
    const b = await body(c, verifyRequestSchema);
    const to = await resolve(a.pid, a.branch, b.to);
    const from = await resolve(a.pid, a.branch, b.from, to, a.schemas);
    const targetPgMajor = await projectTargetPgMajor(db, a.pid);
    const s = await shadows.forProject(a.pid, b.env);
    return c.json<VerifyResponse>({
      ...(await s.shadow.verify(from, to, targetPgMajor !== null ? { pgMajor: targetPgMajor } : undefined)),
      shadow: s.label,
    });
  });
};
