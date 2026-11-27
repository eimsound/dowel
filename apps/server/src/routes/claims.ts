// 认领与接入已有历史（P4c H5）：
// - POST …/environments/attach：给已有项目添加环境，并接入这个库里已有的迁移历史（特权操作）；
// - POST …/environments/:eid/claim：认领这个环境的库里这个项目的历史（实例管理员）。
// 认领 = 把目标库 dowel.projects 的“当前认领实例”换成本实例，并在 dowel.claims 追加一条事件；
// 之后原实例的执行在 foreign_instance 处被拒绝，只读的漂移检查和读历史不受影响。
//
// 顺序（和接手一致）：**先写平台库，提交之后再写目标库**——环境行（和审计）在一个平台事务里，认领在提交之后。
// 认领失败环境照样保留，作为 warnings 返回，可以在环境页重试认领；同步目标库状态失败只记日志并附 warning，
// 请求仍然成功（环境已经建好，不能让用户误以为接入失败）。认领在目标库的项目锁里重新比对版本链（claimInstance 的 chain）。
import {
  type AttachOverwritePreview,
  type AttachResult,
  type ClaimResult,
  environmentAttachSchema,
  resolvePolicy,
  type StoredVerifyReport,
  type TargetInfo,
} from '@dowel/api';
import { type Dialect, getDialect, type Model, newId } from '@dowel/core';
import { type Db, getEngine, HistoryError, maxNumberNode } from '@dowel/engines';
import {
  claimInstance,
  ExecutorError,
  inspectAttach,
  planDiff,
  readState,
  type TargetState,
} from '@dowel/executor';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { assertUrlMatchesDialect } from '../allowlist.ts';
import { audit, auditIn } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { emptyBase } from '../chain.ts';
import { inList, isUniqueViolation } from '../db.ts';
import { type EnvRow, loadChain, loadEnv, syncEnvCache, versionRef } from '../envs.ts';
import { claimFailure, lockEnvIdle, toTargetError } from '../executions.ts';
import { isExecutor, loadPolicies, upperInput } from '../policy.ts';
import { WorkingChangedError } from '../rooms.ts';
import { decrypt, encrypt, scrubSecrets } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import { type Shadow, ShadowError } from '../shadow.ts';
import { prepareShadow, type ShadowSource } from '../shadows.ts';
import {
  insertRestoredVersions,
  type PreparedShadow,
  TakeoverRejected,
  unionScopes,
  verifyVersionChain,
} from '../takeover.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  claimShadow,
  connectTarget,
  dropSameInstanceShadow,
  inspectTargetOn,
} from '../targets.ts';
import { type AppContext, access, body, CodedHTTPException, connectionLimit, type Env } from './context.ts';

/** 在已有目标库连接上读取历史并同步到平台库缓存（在目标库项目锁里做，拿不到锁就只读不同步） */
const syncTargetOn = async (
  x: AppContext['exec'],
  env: EnvRow,
  tdb: Db,
  dialect: Dialect = 'pg',
): Promise<TargetState> => {
  const sync =
    x.syncTarget ??
    (async (db, e, c, d = dialect) => {
      try {
        return await getEngine(d).history.withProjectLock(c, e.project_id, 0, async (locked) => {
          const state = await readState(locked, e.project_id, d);
          try {
            await syncEnvCache(db, e.id, state);
          } catch (err) {
            console.error('同步环境状态到平台库失败（已跳过，下次会重新同步）', err);
          }
          return state;
        });
      } catch (err) {
        if (err instanceof HistoryError && err.code === 'lock_timeout') return null;
        throw err;
      }
    });
  return (await sync(x.db, env, tdb, dialect)) ?? (await readState(tdb, env.project_id, dialect));
};

/**
 * 挑选可用影子库并按本次候选实际将建立的外部连接数扣减连库限速：
 * - SQLite（不需要外部影子库）：直接用内存影子库（0 个连接）；
 * - 显式 shadowUrl：prepareShadow 不建连，verifyVersionChain 内建 1 个连接 → 扣 1；
 * - 同实例影子库（!production || allowSameInstance）：ensureSameInstanceShadow 建 3 个连接 + shadow 建 1 个 → 扣 4；
 * - 生产且不允许同实例：纯内存拒绝（0 个连接），不扣减配额。
 */
const pickShadowWithLimit = async (
  c: Context<Env>,
  ctx: AppContext,
  sources: ShadowSource[],
  schemas: string[] | null,
  dialect: Dialect = 'pg',
): Promise<PreparedShadow> => {
  if (!getDialect(dialect).capabilities.requiresExternalShadow) {
    return prepareShadow(null, schemas, ctx.guard, dialect);
  }
  if (!sources.length)
    throw new TakeoverRejected(
      'shadow_unavailable',
      '没有可用的影子库：请先为至少一个环境配置独立影子库连接串，或允许使用同实例影子库',
    );
  const ordered = [...sources.filter((s) => !!s.shadowUrl), ...sources.filter((s) => !s.shadowUrl)];
  const reasons: string[] = [];
  for (const env of ordered) {
    const cost = env.shadowUrl ? 1 : env.production && !env.allowSameInstance ? 0 : 4;
    if (cost > 0) connectionLimit(c, ctx, cost);
    try {
      return await prepareShadow(env, schemas, ctx.guard, dialect);
    } catch (e) {
      if (!(e instanceof ShadowError)) throw e;
      reasons.push(scrubSecrets(e.message));
    }
  }
  throw new TakeoverRejected(
    'shadow_unavailable',
    `找不到可用的影子库，无法验证迁移版本链：${reasons[0] ?? '没有配置影子库'}`,
  );
};

export const registerClaims = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, refresher } = ctx;

  app.post('/api/projects/:pid/environments/attach', async (c) => {
    // 先按项目权限挡一道（看不见 404、不是项目管理员 403），再看请求里的“是否生产”对应的执行档位
    const a = await access(c, ctx, 'environment.manage');
    const b = await body(c, environmentAttachSchema);
    const user = c.get('user');
    const actor = userActor(user);
    // 接入已有历史是特权操作：适用执行策略和项目管理员规则（配置类：至少项目管理员）。
    // 环境还不存在：按请求里的“是否生产”取上级三层合并出来的策略；执行者只看项目及以上范围的授权
    const store = await loadPolicies(db, a);
    const resolved = resolvePolicy(upperInput(store, b.production), b.production);
    if (
      !can(actor, 'environment.attach_history', {
        kind: 'environment',
        role: a.role,
        production: b.production,
        execPolicy: resolved.whoCanExecute.value,
        isExecutor: isExecutor(
          a.rc,
          { groupId: a.groupId, projectId: a.pid },
          b.production && resolved.whoCanExecute.value === 'executor',
        ),
      })
    )
      throw new HTTPException(403, {
        message: '接入已有历史需要项目管理员，并且要满足这个环境的执行策略',
      });

    if (b.confirmOverwrite && b.workingSeq === undefined)
      throw new HTTPException(400, { message: '确认覆盖工作副本时必须提供预览时的 workingSeq' });

    assertUrlMatchesDialect(b.url, a.dialect);
    if (b.shadowUrl) assertUrlMatchesDialect(b.shadowUrl, a.dialect);

    // 入口按本阶段实际要建立的外部连接数扣减：目标库探测+历史检查复用 1 条连接，可选独立影子库认领另占 1 条
    connectionLimit(c, ctx, b.shadowUrl ? 2 : 1);

    const settings = await readSettings(db);
    const chain = await loadChain(db, a.pid);
    // ① 只读：复用同一条目标库短连接依次完成基础检查（inspectTargetOn）与历史接入检查（inspectAttach），用完即关，不跨影子库或平台事务持连接
    const probe = connectTarget(a.dialect, b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
    let info: TargetInfo;
    let ins: Awaited<ReturnType<typeof inspectAttach>>;
    try {
      info = await inspectTargetOn(probe.db, b.url, a.dialect);
      try {
        ins = await inspectAttach(probe.db, a.pid, chain, settings.instanceId, a.dialect);
      } catch (e) {
        if (e instanceof ExecutorError && e.code === 'history_fork')
          throw new CodedHTTPException(409, e.message, 'history_fork');
        throw toTargetError(e, b.url, a.dialect);
      }
    } finally {
      await probe.close().catch(() => {});
    }
    // 和添加环境同样的检查：配置了独立影子库时确认其可认领（白名单在连接层检查）
    if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard, a.dialect);
    const hasHistory = ins.hasHistory;
    const aheadVersions = ins.hasHistory ? ins.aheadVersions : [];
    const retiredAheadIds = ins.hasHistory ? ins.retiredAheadIds : [];
    const retiredAheadSet = new Set(retiredAheadIds);
    const newActiveHead = ins.hasHistory ? ins.newActiveHead : null;
    const retiredAheadRefs = aheadVersions
      .filter((v) => retiredAheadSet.has(v.versionId))
      .map((v) => ({ id: v.versionId, number: v.number, name: v.name }));
    const platActiveHead = maxNumberNode(chain.filter((v) => !v.retired));
    const needClaim = ins.hasHistory && !ins.claim.mine;
    if (needClaim) {
      if (!can(actor, 'instance.claim_project', { kind: 'instance' }))
        throw new HTTPException(403, {
          message: '这个库里的项目由另一个 Dowel 实例认领，接入需要“认领”它，只有实例管理员可以确认',
        });
      if (!b.claim)
        return c.json(
          {
            error:
              '这个库里的项目由另一个 Dowel 实例认领。接入需要确认认领：之后原实例对这个库的执行会被拒绝（只读的漂移检查和读历史不受影响）',
            code: 'claim_required',
            claim: ins.hasHistory ? ins.claim : undefined,
          },
          409,
        );
    }

    // ② 目标库存在平台缺失的版本（ADR 0012 / 0013）：
    //    1) 按 parentId 追溯父模型用影子库对全部缺失版本做闭环验证；缺影子库或任一版本失败 → 422 拒绝
    //    2) 若产生了新的活跃链头，检查当前工作副本是否有未发布修改；有且未确认 → 409 working_dirty_confirm，已确认但 seq 变了 → 409 working_changed
    let verifiedReports = new Map<string, StoredVerifyReport>();
    let shadow: Shadow | null = null;
    let createdShadow: { targetUrl: string; name: string } | null = null;
    let committed = false;
    let expectedWorkingSeq: number | undefined;

    const closeShadow = async () => {
      const s = shadow;
      shadow = null;
      await s?.close();
    };
    const cleanupShadow = async () => {
      // 先关闭本请求自己的影子库连接，再尝试删库（不带 WITH (FORCE)，避免被自身连接阻塞）
      await closeShadow();
      if (!committed && createdShadow) {
        const s = createdShadow;
        createdShadow = null;
        await dropSameInstanceShadow(s.targetUrl, s.name, ctx.guard, a.dialect);
      }
    };

    try {
      if (aheadVersions.length) {
        const existingEnvs = await db.query<
          Pick<EnvRow, 'name' | 'url_enc' | 'production' | 'allow_same_instance' | 'shadow_url_enc'>
        >(
          'select name, url_enc, production, allow_same_instance, shadow_url_enc from environments where project_id = $1 order by created_at',
          [a.pid],
        );
        const candidates: ShadowSource[] = [
          {
            name: b.name,
            url: b.url,
            production: b.production,
            allowSameInstance: b.allowSameInstance,
            shadowUrl: b.shadowUrl,
          },
          ...existingEnvs.map((e) => ({
            name: e.name,
            url: decrypt(e.url_enc),
            production: e.production,
            allowSameInstance: e.allow_same_instance,
            shadowUrl: e.shadow_url_enc ? decrypt(e.shadow_url_enc) : null,
          })),
        ];
        try {
          const scope = unionScopes(aheadVersions, a.schemas);
          const prepared = await pickShadowWithLimit(c, ctx, candidates, scope, a.dialect);
          shadow = prepared.shadow;
          createdShadow = prepared.created;
          verifiedReports = await verifyVersionChain({
            shadow,
            shadowLabel: prepared.label,
            versions: aheadVersions,
            existingModels: new Map(chain.map((v) => [v.id, v.model])),
          });
        } catch (e) {
          if (e instanceof TakeoverRejected) {
            await cleanupShadow();
            return c.json({ error: scrubSecrets(e.message), code: e.code }, 422);
          }
          throw e;
        } finally {
          await closeShadow();
        }

        if (newActiveHead) {
          // 检查工作副本是否相对原活跃链头有未发布的修改（与 pull 相同的并发保护）
          // 预览阶段是关键出口（先规范化，返回的 workingSeq 是规范后的）；确认覆盖阶段带着预览时的 seq，不再 flush 以免自冲突
          const { model: working, seq: workingSeq } = b.confirmOverwrite
            ? await rooms.model(a.branch)
            : await refresher.flush(a.branch);
          const baseHeadModel = platActiveHead?.model ?? emptyBase(working, a.schemas);
          const isDirty = (w: Model) => planDiff(baseHeadModel, w).total > 0;
          const previewOf = (w: Model, sq: number): AttachOverwritePreview => {
            const diff = planDiff(w, newActiveHead.model);
            return {
              aheadVersions: aheadVersions.map((v) => ({ id: v.versionId, number: v.number, name: v.name })),
              items: diff.items,
              total: diff.total,
              workingSeq: sq,
            };
          };
          if (isDirty(working)) {
            if (!b.confirmOverwrite) {
              await cleanupShadow();
              return c.json(
                {
                  error: '工作副本有未发布的修改，接入领先环境会将其覆盖到新链头，请先查看差异并确认',
                  code: 'working_dirty_confirm',
                  ...previewOf(working, workingSeq),
                },
                409,
              );
            }
            if (b.workingSeq !== undefined && b.workingSeq !== workingSeq) {
              await cleanupShadow();
              return c.json(
                {
                  error: '工作副本在预览之后被改过，请重新确认差异',
                  code: 'working_changed',
                  ...previewOf(working, workingSeq),
                },
                409,
              );
            }
          } else if (b.confirmOverwrite && b.workingSeq !== undefined && b.workingSeq !== workingSeq) {
            await cleanupShadow();
            return c.json(
              {
                error: '工作副本在预览之后被改过，请重新确认差异',
                code: 'working_changed',
                ...previewOf(working, workingSeq),
              },
              409,
            );
          }
          expectedWorkingSeq = b.confirmOverwrite ? b.workingSeq : workingSeq;
        }
      }

      // 若目标库有历史，提交后还需建立 1 条短连接复用完成认领（若需）与状态同步；必须在写平台库之前扣减限速配额
      if (hasHistory) connectionLimit(c, ctx, 1);

      // ③ 平台事务：缺失版本（若有）+ 环境行 + 审计（重名与版本树并发在事务里检查）。提交之前目标库一概不动
      const id = newId();
      try {
        await db.transaction(async (tx) => {
          if (aheadVersions.length) {
            if (db.dialect === 'pg')
              await tx.query('select id from projects where id = $1 for update', [a.pid]);
            const curRows = await tx.query<{ id: string; number: number; retired_at: unknown }>(
              'select id, number, retired_at from versions where project_id = $1 order by number',
              [a.pid],
            );
            const treeChanged =
              curRows.length !== chain.length ||
              curRows.some(
                (r, i) =>
                  r.id !== chain[i]!.id ||
                  (r.retired_at !== null && r.retired_at !== undefined) !== Boolean(chain[i]!.retired),
              );
            if (treeChanged) throw new HTTPException(409, { message: '版本链刚刚发生了变化，请刷新后重试' });
            const aheadIds = aheadVersions.map((v) => v.versionId);
            const clash = await tx.query<{ id: string }>(
              `select id from versions where id in (${inList(aheadIds)})`,
              aheadIds,
            );
            if (clash.length)
              throw new HTTPException(409, {
                message: `本实例里已经有同一个版本（${clash[0]!.id}），不能重复接入`,
              });
            await insertRestoredVersions(tx, {
              pid: a.pid,
              branch: a.branch,
              versions: aheadVersions,
              verifiedReports,
              retiredIds: retiredAheadSet,
            });
          }
          const [dup] = await tx.query<{ id: string }>(
            'select id from environments where project_id = $1 and name = $2',
            [a.pid, b.name],
          );
          if (dup) throw new HTTPException(409, { message: `环境“${b.name}”已经存在` });
          await tx.query(
            `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc,
                                       engine_version, engine_version_num)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id,
              a.pid,
              b.name,
              encrypt(b.url),
              b.production,
              b.allowSameInstance,
              b.shadowUrl ? encrypt(b.shadowUrl) : null,
              info.version,
              info.versionNum,
            ],
          );
          await auditIn(
            tx,
            c,
            {
              action: hasHistory ? 'environment.attach_history' : 'environment.create',
              actorKind: 'user',
              actorId: user.id,
              targetKind: 'environment',
              targetId: id,
              projectId: a.pid,
              data: {
                projectId: a.pid,
                name: b.name,
                claimRequested: needClaim,
                ...(aheadVersions.length ? { aheadVersions: aheadVersions.map((v) => v.number) } : {}),
                ...(retiredAheadRefs.length
                  ? { retiredVersions: retiredAheadRefs.map((v) => v.number) }
                  : {}),
              },
            },
            ctx.security,
          );
        });
      } catch (e) {
        if (isUniqueViolation(e)) throw new HTTPException(409, { message: `环境“${b.name}”已经存在` });
        throw e;
      }
      committed = true;

      // 提交之后：若产生了新的活跃链头，尝试按期望 seq 覆盖工作副本到新链头（记入 room_commits 操作历史）并重新加载合并后的完整链。
      // 事务已提交，此处若发生并发编辑冲突或异常不能返回 500（否则环境与版本已入库且跳过认领），记作 warning 提示用户在模型页处理。
      const warnings: string[] = [];
      let mergedChain = chain;
      if (aheadVersions.length) {
        if (newActiveHead) {
          try {
            await ctx.replace(a.branch, user.name, newActiveHead.model, 'attachAhead', expectedWorkingSeq);
          } catch (e) {
            if (e instanceof WorkingChangedError) {
              warnings.push(
                `环境“${b.name}”与领先版本已接入，但接入期间工作副本被他人修改，未自动覆盖工作副本；请在模型页核对并在需要时通过修改历史或从环境导入同步`,
              );
            } else {
              console.error(
                '接入：同步工作副本失败（环境与领先版本已入库）',
                e instanceof Error ? scrubSecrets(e.message) : e,
              );
              warnings.push(
                `环境“${b.name}”与领先版本已接入，但自动同步工作副本失败；请在模型页手动核对或从环境导入`,
              );
            }
          }
        }
        try {
          mergedChain = await loadChain(db, a.pid);
        } catch (e) {
          console.error('接入：重新加载版本链失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      }

      // ④+⑤ 提交之后：若有历史，复用同一条目标库短连接依次完成认领（若需）与目标库状态同步；失败环境照样保留，作为 warning
      let claimed = false;
      let current: ReturnType<typeof versionRef> | null = null;
      if (hasHistory) {
        let synced = false;
        const conn = connectTarget(a.dialect, b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
        try {
          if (needClaim) {
            try {
              await claimInstance({
                db: conn.db,
                dialect: a.dialect,
                projectId: a.pid,
                projectName: a.name,
                instanceId: settings.instanceId,
                claimedBy: user.id,
                claimedByName: user.name,
                chain: mergedChain,
              });
              claimed = true;
            } catch (e) {
              console.error(
                '接入：认领失败（环境已经添加）',
                e instanceof Error ? scrubSecrets(e.message) : e,
              );
              warnings.push(
                `环境“${b.name}”已经添加，但认领失败：${claimFailure(e, b.url, a.dialect)}。可以在环境页重试认领`,
              );
            }
          }
          try {
            const savedEnv = await loadEnv(db, a.pid, id);
            const state = await syncTargetOn(ctx.exec, savedEnv, conn.db, a.dialect);
            const cur = state.current ? mergedChain.find((v) => v.id === state.current) : undefined;
            current = cur ? versionRef(cur) : null;
            synced = true;
          } catch (e) {
            console.error(
              '接入：同步目标库状态失败（环境已经添加）',
              e instanceof Error ? scrubSecrets(e.message) : e,
            );
            warnings.push(
              `环境“${b.name}”已经添加，但同步目标库状态失败：${claimFailure(e, b.url, a.dialect)}。再读一次执行历史就会对齐`,
            );
          }
        } finally {
          await conn.close().catch(() => {});
        }
        if (claimed) {
          // 认领成功之后单独写审计（关闭目标库连接后再写平台库，失败只记日志，不影响结果）
          await audit(
            db,
            c,
            {
              action: 'project.claim',
              actorKind: 'user',
              actorId: user.id,
              targetKind: 'environment',
              targetId: id,
              projectId: a.pid,
              data: { projectId: a.pid, name: b.name, environment: b.name, via: 'attach' },
            },
            ctx.security,
          );
        }
        // P5b：同步改了这个环境的当前版本（新接入的环境上还没有申请，统一按“改了缓存就重检”处理）
        if (synced) ctx.requests.kick({ envIds: [id] });
      }
      return c.json<AttachResult>(
        {
          id,
          ...info,
          attached: hasHistory,
          currentVersion: current,
          claimed,
          aheadVersions: aheadVersions.map((v) => ({ id: v.versionId, number: v.number, name: v.name })),
          retiredVersions: retiredAheadRefs,
          warnings,
        },
        201,
      );
    } catch (e) {
      await cleanupShadow();
      throw e;
    }
  });

  /**
   * 认领：这个环境的库里这个项目的历史由另一个实例认领（执行被拒绝，foreign_instance）时，由实例管理员确认认领。
   * 先确认历史和平台的版本链对得上（接入检查），再在目标库的项目锁里**重新比对**后换手；正在执行时不能认领（先占环境锁）。
   */
  app.post('/api/projects/:pid/environments/:eid/claim', async (c) => {
    const a = await access(c, ctx, 'environment.read');
    const user = c.get('user');
    if (!can(userActor(user), 'instance.claim_project', { kind: 'instance' }))
      throw new HTTPException(403, { message: '认领需要实例管理员' });
    const env: EnvRow = await loadEnv(db, a.pid, c.req.param('eid')!);
    // 复用同一条目标库连接完成接入检查、认领与状态同步，实际仅建立 1 个外部连接
    connectionLimit(c, ctx, 1);
    const settings = await readSettings(db);
    const release = await lockEnvIdle(ctx.exec, env.id);
    let result: ClaimResult;
    try {
      const chain = await loadChain(db, a.pid);
      const url = decrypt(env.url_enc);
      const conn = connectTarget(a.dialect, url, CHECK_CONNECT_TIMEOUT, ctx.guard);
      try {
        try {
          const ins = await inspectAttach(conn.db, a.pid, chain, settings.instanceId, a.dialect);
          if (!ins.hasHistory)
            throw new HTTPException(422, { message: '目标库里没有这个项目的历史，没有什么可认领的' });
          result = await claimInstance({
            db: conn.db,
            dialect: a.dialect,
            projectId: a.pid,
            projectName: a.name,
            instanceId: settings.instanceId,
            claimedBy: user.id,
            claimedByName: user.name,
            chain,
          });
        } catch (e) {
          if (e instanceof ExecutorError && e.code === 'history_fork')
            throw new CodedHTTPException(409, e.message, 'history_fork');
          throw toTargetError(e, url, a.dialect);
        }
        // 认领之后复用同一连接同步一次（当前版本、执行过哪些版本）：失败只记日志，不影响认领结果
        await syncTargetOn(ctx.exec, env, conn.db, a.dialect).catch((e) =>
          console.error('认领后同步环境状态失败（忽略）', e instanceof Error ? scrubSecrets(e.message) : e),
        );
      } finally {
        await conn.close().catch(() => {});
      }
      // P5b：认领后的同步可能改了环境的当前版本，这个环境上还没结束的执行申请重新检查
      ctx.requests.kick({ envIds: [env.id] });
    } finally {
      await release();
    }
    if (result.changed)
      await audit(
        db,
        c,
        {
          action: 'project.claim',
          actorKind: 'user',
          actorId: user.id,
          targetKind: 'environment',
          targetId: env.id,
          projectId: a.pid,
          data: {
            projectId: a.pid,
            environment: env.name,
            previousInstanceId: result.previousInstanceId,
            via: 'claim',
          },
        },
        ctx.security,
      );
    return c.json<ClaimResult>(result);
  });
};
