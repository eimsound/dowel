// 认领与接入已有历史（P4c H5）：
// - POST …/environments/attach：给已有项目添加环境，并接入这个库里已有的迁移历史（特权操作）；
// - POST …/environments/:eid/claim：认领这个环境的库里这个项目的历史（实例管理员）。
// 认领 = 把目标库 dowel.projects 的“当前认领实例”换成本实例，并在 dowel.claims 追加一条事件；
// 之后原实例的执行在 foreign_instance 处被拒绝，只读的漂移检查和读历史不受影响。
//
// 顺序（和接手一致）：**先写平台库，提交之后再写目标库**——环境行（和审计）在一个平台事务里，认领在提交之后。
// 认领失败环境照样保留，作为 warnings 返回，可以在环境页重试认领；同步目标库状态失败只记日志并附 warning，
// 请求仍然成功（环境已经建好，不能让用户误以为接入失败）。认领在目标库的项目锁里重新比对版本链（claimInstance 的 chain）。
import { type AttachResult, type ClaimResult, environmentAttachSchema } from '@dowel/api';
import { newId } from '@dowel/core';
import { claimInstance, inspectAttach } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit, auditIn } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { isUniqueViolation } from '../db.ts';
import { type EnvRow, loadChain, loadEnv, versionRef } from '../envs.ts';
import { claimFailure, lockEnvIdle, readTargetState, toTargetError } from '../executions.ts';
import { decrypt, encrypt, scrubSecrets } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import { CHECK_CONNECT_TIMEOUT, claimShadow, connectPg, inspectTarget } from '../targets.ts';
import { type AppContext, access, body, connectionLimit, type Env } from './context.ts';

export const registerClaims = (app: Hono<Env>, ctx: AppContext) => {
  const { db, refresher } = ctx;

  app.post('/api/projects/:pid/environments/attach', async (c) => {
    // 先按项目权限挡一道（看不见 404、不是项目管理员 403），再看请求里的“是否生产”对应的执行档位
    const a = await access(c, ctx, 'environment.manage');
    const b = await body(c, environmentAttachSchema);
    const user = c.get('user');
    const actor = userActor(user);
    // 接入已有历史是特权操作：适用 P4b 的执行档位和项目管理员规则（配置类：至少项目管理员）。
    // 环境还不存在，用请求里的“是否生产”和默认档位构造一个环境资源
    if (
      !can(actor, 'environment.attach_history', {
        kind: 'environment',
        role: a.role,
        production: b.production,
        execPolicy: null,
      })
    )
      throw new HTTPException(403, {
        message: '接入已有历史需要项目管理员，并且要满足这个环境的执行档位',
      });
    connectionLimit(c, ctx);

    // 和添加环境同样的检查：连得上（白名单在连接层检查）、影子库能认领
    const info = await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
    if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard);

    const settings = await readSettings(db);
    const chain = await loadChain(db, a.pid);
    // ① 只读：这个库的历史能不能接入（和平台的链、模型对得上）、认领情况。连接故障 / 权限不足 → 带原因的 422
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

    // ② 平台事务：环境行 + 审计（重名在事务里检查，唯一约束再兜一层）。提交之前目标库一概不动
    const id = newId();
    try {
      await db.transaction(async (tx) => {
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
            data: { projectId: a.pid, name: b.name, claimRequested: needClaim },
          },
          ctx.security,
        );
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new HTTPException(409, { message: `环境“${b.name}”已经存在` });
      throw e;
    }
    refresher.schedule(a.branch);

    // ③ 提交之后：认领。失败环境照样保留，作为 warning，可以在环境页重试
    const warnings: string[] = [];
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
          chain,
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
        warnings.push(`环境“${b.name}”已经添加，但认领失败：${claimFailure(e, b.url)}。可以在环境页重试认领`);
      } finally {
        await conn.close().catch(() => {});
      }
    }

    // ④ 把目标库历史同步成平台库缓存（当前版本、执行过哪些版本，在目标库的项目锁里做）：失败只记日志 + warning
    let current: ReturnType<typeof versionRef> | null = null;
    if (hasHistory) {
      try {
        const state = await readTargetState(ctx.exec, await loadEnv(db, a.pid, id), true);
        const cur = state.current ? chain.find((v) => v.id === state.current) : undefined;
        current = cur ? versionRef(cur) : null;
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
      { id, ...info, attached: hasHistory, currentVersion: current, claimed, warnings },
      201,
    );
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
    } finally {
      release();
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
