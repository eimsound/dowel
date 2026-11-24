// 版本（发布 = 冻结迁移）、迁移脚本、DDL 导出和迁移验证。
// 版本是链上的不可变快照；发布时从上一个版本生成升级 / 回滚脚本，在影子库里闭环验证，通过后冻结（ADR 0002）。
// 之后只有“链上最新、还没在任何环境执行过”的版本可以人工改脚本，改完就回到未验证。
import {
  type CanvasHistoryConflict,
  type MigrationResult,
  type ModelUpdate,
  type PublishedTables,
  type PublishRejected,
  type StoredVerifyReport,
  stepsPatchSchema,
  type VerifyResponse,
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
import { deepEqual, type Model, newId, validate } from '@dowel/core';
import {
  canonicalSteps,
  type Db,
  indexTree,
  isNontransactionalSql,
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
import { chainFrom, freezeScripts, instanceLevelProblem, versionExecutedAnywhere } from '../chain.ts';
import { dbNowSql, inList, isUniqueViolation, readDbNow } from '../db.ts';
import { projectPlanOptions } from '../envs.ts';
import { withPolicyLock } from '../policy.ts';
import {
  bindingProblem,
  Effects,
  isInterrupted,
  newBindingCache,
  type RequestRow,
  retireInvalidReason,
  sweepWhere,
} from '../requests.ts';
import { WorkingChangedError } from '../rooms.ts';
import { scrubSecrets } from '../secrets.ts';
import { ShadowError } from '../shadow.ts';
import {
  activeHead,
  activeHeadWithModel,
  analyzeUnretire,
  buildDdlSql,
  buildMigrationPreview,
  globalMaxNumber,
  listProjectVersions,
  loadVersion,
  resolveModelRef,
  verifyAcrossVersions,
  versionDetailOf,
  type VersionTreeNode,
} from '../versions.ts';
import { type AppContext, access, body, CodedHTTPException, type Env } from './context.ts';
const CHAIN_CHANGED = '版本链刚刚发生了变化（有人先发布了），请刷新后重试';

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
    try {
      await refresher.flush(branch);
      const { model: currentModel, seq: currentSeq } = await rooms.model(branch);
      if (requestedSeq !== undefined && requestedSeq !== currentSeq) return 'changed';
      const expectedSeq = requestedSeq ?? currentSeq;
      if (deepEqual(currentModel, targetModel)) return 'unchanged';
      await ctx.replace(branch, userName, targetModel, opName, expectedSeq);
      return 'reverted';
    } catch (e) {
      if (e instanceof WorkingChangedError) return 'changed';
      console.error(
        `同步工作副本失败（${opName}，版本状态已提交）`,
        e instanceof Error ? scrubSecrets(e.message) : e,
      );
      return 'failed';
    }
  };

  app.get('/api/projects/:pid/versions', async (c) => {
    const a = await access(c, ctx, 'project.read');
    return c.json<VersionInfo[]>(await listProjectVersions(db, a.pid));
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

  /** 解析版本引用：`empty` 空模型，`head` 当前工作副本，其余按版本引用查找 */
  const resolve = async (
    pid: string,
    branch: string,
    ref: string | undefined,
    like?: Model,
    scope?: string[] | null,
  ): Promise<Model> => {
    const r = await resolveModelRef(db, rooms, refresher, {
      pid,
      branch,
      schemas: scope ?? null,
      ref,
      like,
      defaultRef: 'head',
    });
    if (!r.ok) throw new HTTPException(404, { message: r.message });
    return r.model;
  };

  app.get('/api/projects/:pid/migration', async (c) => {
    const a = await access(c, ctx, 'migration.read');
    const to = await resolve(a.pid, a.branch, c.req.query('to'));
    const from = await resolve(a.pid, a.branch, c.req.query('from') ?? 'empty', to, a.schemas);
    const preview = await buildMigrationPreview(db, { pid: a.pid, dialect: a.dialect, from, to });
    if (c.req.query('format') === 'sql') {
      return c.text(preview.upSql, 200, {
        'content-type': 'application/sql; charset=utf-8',
      });
    }
    return c.json<MigrationResult>({ up: preview.up, down: preview.down });
  });

  app.get('/api/projects/:pid/ddl', async (c) => {
    const a = await access(c, ctx, 'ddl.read');
    const m = await resolve(a.pid, a.branch, c.req.query('version'));
    const sql = await buildDdlSql(db, { pid: a.pid, dialect: a.dialect, model: m });
    return c.text(sql, 200, {
      'content-type': 'application/sql; charset=utf-8',
    });
  });

  /**
   * 作废活跃主链最末尾的连续一段版本（ADR 0013）：软作废（写 retired_at / retired_by），
   * 永远不允许作废首个版本；存在执行中登记（claimed）时拒绝；含已执行版本需项目管理员权限；
   * 事务内同步将受影响执行申请置为失效（防未巡检即 unretire 复活），提交后推送通知与 Webhook 并按需回退工作副本。
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

    const fx = new Effects();
    const done = await withPolicyLock(db, async (tx) => {
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

      await tx.query(
        `update versions set retired_at = ${dbNowSql(db.dialect)}, retired_by = $1 where id in (${inList(spanIds, 2)})`,
        [user.id, ...spanIds],
      );

      // 事务内同步失效所有受影响开放申请（写入审计、收件箱与 webhook_jobs），消除 retire → 立即 unretire 的复活窗口
      const openReqs = await tx.query<RequestRow>(
        `select * from exec_requests where project_id = $1 and ${sweepWhere(db.dialect)} order by created_at asc, id asc`,
        [a.pid],
      );
      const spanById = new Map(span.map((v) => [v.id, v]));
      let invalidatedRequests = 0;
      for (const r of openReqs) {
        if (isInterrupted(r)) continue;
        const reason = retireInvalidReason(r, spanById);
        if (!reason) continue;
        if (await ctx.requests.setStatus(tx, null, r, 'invalid', reason, null, fx, { onlyIf: r.status })) {
          invalidatedRequests++;
        }
      }

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
        invalidatedRequests,
        parentModel,
      };
    });

    await ctx.requests.flushEffects(fx);

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

    const fx = new Effects();
    const done = await withPolicyLock(db, async (tx) => {
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

      // 清空 retired_at 前防御性兜底：若存在尚未落库失效的历史/直改库残留开放申请，按当前绑定先原子置为失效再恢复
      const openReqs = await tx.query<RequestRow>(
        `select * from exec_requests where project_id = $1 and ${sweepWhere(db.dialect)} order by created_at asc, id asc`,
        [a.pid],
      );
      if (openReqs.length) {
        const spanSet = new Set(spanIds);
        const dbNow = await readDbNow(tx, db.dialect);
        const cache = newBindingCache();
        for (const r of openReqs) {
          if (isInterrupted(r)) continue;
          const touchesSpan =
            (r.direction !== 'down' && spanSet.has(r.to_version_id)) ||
            (Array.isArray(r.migrations) && r.migrations.some((m) => spanSet.has(m.versionId)));
          if (!touchesSpan) continue;
          const p = await bindingProblem(tx, r, dbNow, cache);
          if (p) {
            await ctx.requests.setStatus(tx, null, r, p.status, p.reason, null, fx, { onlyIf: r.status });
          }
        }
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

    await ctx.requests.flushEffects(fx);

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
