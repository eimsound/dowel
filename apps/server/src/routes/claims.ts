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
} from '@dowel/api';
import { type Model, newId } from '@dowel/core';
import { claimInstance, inspectAttach, planDiff } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit, auditIn } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { emptyBase } from '../chain.ts';
import { inList, isUniqueViolation } from '../db.ts';
import { type EnvRow, loadChain, loadEnv, versionRef } from '../envs.ts';
import { claimFailure, lockEnvIdle, readTargetState, toTargetError } from '../executions.ts';
import { isExecutor, loadPolicies, upperInput } from '../policy.ts';
import { WorkingChangedError } from '../rooms.ts';
import { decrypt, encrypt, scrubSecrets } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import type { Shadow } from '../shadow.ts';
import type { ShadowSource } from '../shadows.ts';
import {
  insertRestoredVersions,
  pickShadow,
  TakeoverRejected,
  unionScopes,
  verifyVersionChain,
} from '../takeover.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  claimShadow,
  connectPg,
  dropSameInstanceShadow,
  inspectTarget,
} from '../targets.ts';
import { type AppContext, access, body, connectionLimit, type Env } from './context.ts';

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
    connectionLimit(c, ctx);

    if (b.confirmOverwrite && b.workingSeq === undefined)
      throw new HTTPException(400, { message: '确认覆盖工作副本时必须提供预览时的 workingSeq' });

    // 和添加环境同样的检查：连得上（白名单在连接层检查）、影子库能认领
    const info = await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
    if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard);

    const settings = await readSettings(db);
    const chain = await loadChain(db, a.pid);
    // ① 只读：这个库的历史能不能接入（和平台的链、模型对得上，或者严格无分叉领先）、认领情况。连接故障 / 权限不足 → 带原因的 422
    const probe = connectPg(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
    let ins: Awaited<ReturnType<typeof inspectAttach>>;
    try {
      ins = await inspectAttach(probe.db, a.pid, chain, settings.instanceId);
    } catch (e) {
      throw toTargetError(e, b.url);
    } finally {
      await probe.close().catch(() => {});
    }
    const hasHistory = ins.hasHistory;
    const aheadVersions = ins.hasHistory ? ins.aheadVersions : [];
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

    // ② 目标库严格领先于平台链（ADR 0012）：
    //    1) 先按顺序用影子库对全部领先版本做闭环验证（基线模型为原链头模型）；缺影子库或任一版本失败 → 422 拒绝
    //    2) 检查当前工作副本是否有未发布修改；有且未确认 → 409 working_dirty_confirm，已确认但 seq 变了 → 409 working_changed
    let verifiedReports = new Map<string, StoredVerifyReport>();
    let createdShadow: { targetUrl: string; name: string } | null = null;
    let committed = false;
    let expectedWorkingSeq: number | undefined;
    const newHead = aheadVersions.at(-1) ?? null;

    const cleanupShadow = async () => {
      if (!committed && createdShadow) {
        const s = createdShadow;
        createdShadow = null;
        await dropSameInstanceShadow(s.targetUrl, s.name, ctx.guard);
      }
    };

    try {
      if (aheadVersions.length && newHead) {
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
        let shadow: Shadow | null = null;
        try {
          const scope = unionScopes(aheadVersions, a.schemas);
          const prepared = await pickShadow(candidates, scope, ctx.guard);
          shadow = prepared.shadow;
          createdShadow = prepared.created;
          verifiedReports = await verifyVersionChain({
            shadow,
            shadowLabel: prepared.label,
            versions: aheadVersions,
            baseModel: chain.at(-1)?.model ?? null,
          });
        } catch (e) {
          if (e instanceof TakeoverRejected) {
            await cleanupShadow();
            return c.json({ error: scrubSecrets(e.message), code: e.code }, 422);
          }
          throw e;
        } finally {
          await shadow?.close();
        }

        // 检查工作副本是否相对原链头有未发布的修改（与 pull 相同的并发保护）
        await refresher.flush(a.branch);
        const { model: working, seq: workingSeq } = await rooms.model(a.branch);
        const baseHeadModel = chain.at(-1)?.model ?? emptyBase(working, a.schemas);
        const isDirty = (w: Model) => planDiff(baseHeadModel, w).total > 0;
        const previewOf = (w: Model, sq: number): AttachOverwritePreview => {
          const diff = planDiff(w, newHead.model);
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

      // ③ 平台事务：领先版本（若有）+ 环境行 + 审计（重名与链头并发在事务里检查）。提交之前目标库一概不动
      const id = newId();
      try {
        await db.transaction(async (tx) => {
          if (aheadVersions.length) {
            if (db.dialect === 'pg')
              await tx.query('select id from projects where id = $1 for update', [a.pid]);
            const [headNow] = await tx.query<{ id: string }>(
              'select id from versions where project_id = $1 order by number desc limit 1',
              [a.pid],
            );
            if ((headNow?.id ?? null) !== (chain.at(-1)?.id ?? null))
              throw new HTTPException(409, { message: '版本链刚刚发生了变化，请刷新后重试' });
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
            });
          }
          const [dup] = await tx.query<{ id: string }>(
            'select id from environments where project_id = $1 and name = $2',
            [a.pid, b.name],
          );
          if (dup) throw new HTTPException(409, { message: `环境“${b.name}”已经存在` });
          await tx.query(
            `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id,
              a.pid,
              b.name,
              encrypt(b.url),
              b.production,
              b.allowSameInstance,
              b.shadowUrl ? encrypt(b.shadowUrl) : null,
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

      // 提交之后：若有领先版本，尝试按期望 seq 覆盖工作副本到新链头（记入 room_commits 操作历史）并重新加载合并后的完整链。
      // 事务已提交，此处若发生并发编辑冲突或异常不能返回 500（否则环境与版本已入库且跳过认领），记作 warning 提示用户在模型页处理。
      const warnings: string[] = [];
      let mergedChain = chain;
      if (aheadVersions.length && newHead) {
        try {
          await ctx.replace(a.branch, user.name, newHead.model, 'attachAhead', expectedWorkingSeq);
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
        try {
          mergedChain = await loadChain(db, a.pid);
        } catch (e) {
          console.error('接入：重新加载版本链失败', e instanceof Error ? scrubSecrets(e.message) : e);
        }
      } else {
        refresher.schedule(a.branch);
      }

      // ④ 提交之后：认领（锁内拿最新合并后的链比对）。失败环境照样保留，作为 warning，可以在环境页重试
      let claimed = false;
      if (needClaim) {
        const conn = connectPg(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
        try {
          await claimInstance({
            db: conn.db,
            projectId: a.pid,
            projectName: a.name,
            instanceId: settings.instanceId,
            claimedBy: user.id,
            claimedByName: user.name,
            chain: mergedChain,
          });
          claimed = true;
          // 认领成功之后单独写审计（失败只记日志，不影响结果）
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
        } catch (e) {
          console.error('接入：认领失败（环境已经添加）', e instanceof Error ? scrubSecrets(e.message) : e);
          warnings.push(
            `环境“${b.name}”已经添加，但认领失败：${claimFailure(e, b.url)}。可以在环境页重试认领`,
          );
        } finally {
          await conn.close().catch(() => {});
        }
      }

      // ⑤ 把目标库历史同步成平台库缓存（当前版本、执行过哪些版本，在目标库的项目锁里做）：失败只记日志 + warning
      let current: ReturnType<typeof versionRef> | null = null;
      if (hasHistory) {
        try {
          const state = await readTargetState(ctx.exec, await loadEnv(db, a.pid, id), true);
          const cur = state.current ? mergedChain.find((v) => v.id === state.current) : undefined;
          current = cur ? versionRef(cur) : null;
          // P5b：同步改了这个环境的当前版本（新接入的环境上还没有申请，统一按“改了缓存就重检”处理）
          ctx.requests.kick({ envIds: [id] });
        } catch (e) {
          console.error(
            '接入：同步目标库状态失败（环境已经添加）',
            e instanceof Error ? scrubSecrets(e.message) : e,
          );
          warnings.push(
            `环境“${b.name}”已经添加，但同步目标库状态失败：${claimFailure(e, b.url)}。再读一次执行历史就会对齐`,
          );
        }
      }
      return c.json<AttachResult>(
        {
          id,
          ...info,
          attached: hasHistory,
          currentVersion: current,
          claimed,
          aheadVersions: aheadVersions.map((v) => ({ id: v.versionId, number: v.number, name: v.name })),
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
    connectionLimit(c, ctx);
    const settings = await readSettings(db);
    const release = await lockEnvIdle(ctx.exec, env.id);
    let result: ClaimResult;
    try {
      const chain = await loadChain(db, a.pid);
      const url = decrypt(env.url_enc);
      const conn = connectPg(url, CHECK_CONNECT_TIMEOUT, ctx.guard);
      try {
        const ins = await inspectAttach(conn.db, a.pid, chain, settings.instanceId);
        if (!ins.hasHistory)
          throw new HTTPException(422, { message: '目标库里没有这个项目的历史，没有什么可认领的' });
        result = await claimInstance({
          db: conn.db,
          projectId: a.pid,
          projectName: a.name,
          instanceId: settings.instanceId,
          claimedBy: user.id,
          claimedByName: user.name,
          chain,
        });
      } catch (e) {
        throw toTargetError(e, url);
      } finally {
        await conn.close().catch(() => {});
      }
      // 认领之后同步一次（当前版本、执行过哪些版本）：失败只记日志，不影响认领结果
      await readTargetState(ctx.exec, env, true).catch((e) =>
        console.error('认领后同步环境状态失败（忽略）', e instanceof Error ? e.message : e),
      );
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
