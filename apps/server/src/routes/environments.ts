// 环境：项目要部署到的数据库实例（连接信息加密存储）。
import {
  type EnvInfo,
  type EnvironmentCreated,
  environmentCreateSchema,
  environmentPatchSchema,
  importRequestSchema,
  type ModelUpdate,
  type Ok,
  type PolicySettings,
  type PullPreview,
  type TargetInfo,
} from '@dowel/api';
import { type Model, newId } from '@dowel/core';
import { planDiff } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { assertUrlMatchesDialect } from '../allowlist.ts';
import { audit, auditIn } from '../audit.ts';
import { can, type EnvAction, isEnvAction, userActor } from '../authz.ts';
import { applyEnvPolicy, type EnvPolicyResult } from '../env-policy.ts';
import {
  type EnvRow,
  envResource,
  loadEnv,
  loadVersionMetas,
  loadVersionRefs,
  projectPlanOptions,
  toEnvInfo,
  updateEnvVersion,
  type VersionRefRow,
  versionRef,
} from '../envs.ts';
import { lockEnvIdle, readLive, settleClaims } from '../executions.ts';
import {
  accessIn,
  deletePolicies,
  deniedMessage,
  envAuthOf,
  loadPolicies,
  withPolicyLock,
} from '../policy.ts';
import { WorkingChangedError } from '../rooms.ts';
import { decrypt, encrypt } from '../secrets.ts';
import { CHECK_CONNECT_TIMEOUT, claimShadow, inspectTarget } from '../targets.ts';
import { type AppContext, access, body, connectionLimit, type Env } from './context.ts';

export const registerEnvironments = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, shadows, refresher } = ctx;

  app.get('/api/projects/:pid/environments', async (c) => {
    const a = await access(c, ctx, 'environment.read');
    const rows = await db.query<EnvRow>(
      'select * from environments where project_id = $1 order by created_at',
      [a.pid],
    );
    const versions = await loadVersionRefs(db, a.pid);
    const actor = userActor(c.get('user'));
    // 四层配置一次读出，每个环境按自己的生产标记合并
    const store = await loadPolicies(db, a);
    return c.json<EnvInfo[]>(
      rows.map((r) => {
        const cur = r.current_version_id ? versions.get(r.current_version_id) : undefined;
        return toEnvInfo(
          r,
          actor,
          a.role,
          envAuthOf(store, a.rc, a, r),
          {
            currentVersion: cur ? versionRef(cur) : null,
          },
          a.dialect,
        );
      }),
    );
  });

  app.post('/api/projects/:pid/environments', async (c) => {
    const a = await access(c, ctx, 'environment.manage');
    const b = await body(c, environmentCreateSchema);
    assertUrlMatchesDialect(b.url, a.dialect);
    if (b.shadowUrl) assertUrlMatchesDialect(b.shadowUrl, a.dialect);
    // 白名单在连接层检查（ctx.guard）：目标库和影子库都要过一遍
    const info = await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard, a.dialect); // 先确认能连上
    if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard, a.dialect);
    const id = newId();
    await db.query(
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
    // 按需规范化（ADR 0016）：有了影子库也不在后台补做规范化；模型页状态栏会显示待规范化数量，由用户点“规范化”或关键出口触发
    await audit(
      db,
      c,
      {
        action: 'environment.create',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'environment',
        targetId: id,
        projectId: a.pid,
        data: { projectId: a.pid, name: b.name },
      },
      ctx.security,
    );
    return c.json<EnvironmentCreated>({ id, ...info }, 201);
  });

  // 修改环境：连接串 / 影子库 / 取消生产标记是特权操作（按环境生效的执行策略检查）。
  // execPolicy（环境层的“谁能执行”）和生产标记都会改环境层的执行策略：和 PUT …/exec-policy 走同一个 applyEnvPolicy
  // （按改动后的生产标记校验、没改的字段变宽时固定、放宽是特权操作），在执行策略锁的事务里读、校验、写。
  // **这次改了什么、要哪些权限，都以锁内读到的环境行、策略和角色为准**（decide）：锁外只做一次预检（在连外部库之前拒绝），
  // 等锁期间别人改了生产标记、转了组、改了策略，锁内会按新状态重新判断——例如请求带着 production: false，而锁内的行已经被
  // 别人标成了生产，这次就是“取消生产标记”，要 environment.unmark_production 并走固定；锁内值和请求相同时不写这一列。
  app.patch('/api/projects/:pid/environments/:eid', async (c) => {
    // 先按项目权限挡一道（看不见项目 404）；环境存不存在、权限够不够由下面的预检（applyEnvPolicy）判断
    const a = await access(c, ctx, 'environment.read');
    const b = await body(c, environmentPatchSchema);
    const eid = c.req.param('eid')!;
    const pid = a.pid;
    const user = c.get('user');
    const actor = userActor(user);
    /** 按某个时刻的环境行和环境层设置，算出这次请求实际要改的字段和需要的权限 */
    const decide = (row: EnvRow, own: PolicySettings) => {
      const need = new Set<EnvAction | 'environment.manage'>();
      const fields: string[] = [];
      const changed = <T>(next: T | undefined, cur: T) => next !== undefined && next !== cur;
      if (b.url !== undefined) {
        need.add('environment.change_connection');
        fields.push('url');
      }
      if (b.shadowUrl !== undefined) {
        need.add('environment.change_connection');
        fields.push('shadowUrl');
      }
      if (changed(b.allowSameInstance, row.allow_same_instance)) {
        need.add('environment.change_connection');
        fields.push('allowSameInstance');
      }
      if (changed(b.production, row.production)) {
        // 取消“生产”标记是特权操作；标成生产是收紧，项目管理员就能做
        need.add(b.production ? 'environment.manage' : 'environment.unmark_production');
        fields.push('production');
      }
      if (b.execPolicy !== undefined && b.execPolicy !== (own.whoCanExecute ?? null)) {
        // 收紧要项目管理员；放宽另外要满足改动前的执行策略（applyEnvPolicy 里检查）
        need.add('environment.manage');
        fields.push('execPolicy');
      }
      return { need, fields };
    };
    const checkNeed = (need: Set<EnvAction | 'environment.manage'>, r: EnvPolicyResult) => {
      for (const action of need) {
        const ok = isEnvAction(action)
          ? can(actor, action, envResource(r.env, r.role, r.authBefore))
          : can(actor, 'environment.manage', { kind: 'project', role: r.role });
        if (!ok)
          throw new HTTPException(403, {
            message: isEnvAction(action) ? deniedMessage(action, r.authBefore) : '修改这个环境需要项目管理员',
          });
      }
    };
    // 生产标记总是交给 applyEnvPolicy：它拿锁内的行比较，没变就不算改动，变了就走固定
    const policyInput = (write: boolean) => ({
      pid,
      eid,
      user,
      change: {
        ...(b.execPolicy !== undefined ? { whoCanExecute: b.execPolicy } : {}),
        ...(b.production !== undefined ? { production: b.production } : {}),
      },
      write,
    });
    // 预检：在连任何外部库、拿环境锁之前就拒绝没权限 / 不合法 / 没有改动的请求（真正的判断在锁里再做一次）
    const pre = await applyEnvPolicy(db, policyInput(false));
    const preDecision = decide(pre.env, pre.ownBefore);
    if (!preDecision.fields.length) throw new HTTPException(400, { message: '没有要修改的内容' });
    checkNeed(preDecision.need, pre);
    // 连接配置（连接串 / 影子库 / 是否允许同实例）：本进程不能正在对这个环境执行。**先拿环境锁**（409 的请求不对任何数据库产生副作用），
    // 再做外部检查，最后在一个平台库事务里改。环境上残留的 claimed（崩溃留下的）保守处理，不会把环境锁死，见 settleClaims
    const isConnection = (f: string) => f === 'url' || f === 'shadowUrl' || f === 'allowSameInstance';
    const connection = preDecision.fields.some(isConnection);
    const release = connection ? await lockEnvIdle(ctx.exec, eid) : null;
    let done: { r: EnvPolicyResult; row: EnvRow };
    try {
      if (b.url !== undefined) assertUrlMatchesDialect(b.url, a.dialect);
      if (b.shadowUrl) assertUrlMatchesDialect(b.shadowUrl, a.dialect);
      // 外部检查在写库之前：新连接串要连得上（白名单在连接层检查），影子库要能认领
      const inspected =
        b.url !== undefined ? await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard, a.dialect) : null;
      if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard, a.dialect);
      done = await withPolicyLock(db, async (tx) => {
        // 锁内重新读环境行、四层配置、项目当前的组和调用者的角色，按它们重新决定改什么、重新检查权限
        const r = await applyEnvPolicy(tx, policyInput(true));
        const { need, fields } = decide(r.env, r.ownBefore);
        // 连接类的改动要先占住环境锁（不能在执行进行中改连接配置），而环境锁是按预检的结果拿的：锁内才出现的连接类改动
        // （例如等锁期间别人改了“允许同实例影子库”，请求里的值和锁内的值不一样了）这次没有环境锁保护，拒绝，让用户刷新后重试
        if (!connection && fields.some(isConnection))
          throw new HTTPException(409, {
            message: '环境的连接设置在你提交期间被别人修改了，请刷新后重试',
          });
        checkNeed(need, r);
        // 只写改动的列：不拿旧行的值回写没改的列（尤其是并发改了连接串时）；生产标记和锁内值相同时不写
        const vals: unknown[] = [eid];
        const sets: string[] = [];
        const set = (col: string, v: unknown) => {
          vals.push(v);
          sets.push(`${col} = $${vals.length}`);
        };
        if (b.url !== undefined) {
          set('url_enc', encrypt(b.url));
          set('engine_version', inspected?.version ?? null);
          set('engine_version_num', inspected?.versionNum ?? null);
        }
        if (b.shadowUrl !== undefined) set('shadow_url_enc', b.shadowUrl ? encrypt(b.shadowUrl) : null);
        if (fields.includes('allowSameInstance')) set('allow_same_instance', b.allowSameInstance);
        if (fields.includes('production')) set('production', b.production);
        if (connection) await settleClaims(tx, eid);
        if (sets.length) await tx.query(`update environments set ${sets.join(', ')} where id = $1`, vals);
        // 连接串换了：缓存的当前版本和漂移结果属于旧的库，作废（版本“执行过”的永久事实记在 versions.executed_at，不受影响；镜像由之后的同步对齐）
        if (b.url !== undefined)
          await tx.query(
            "update environments set current_version_id = null, drift_status = 'unknown', drift_summary = null, last_drift_check = null where id = $1",
            [eid],
          );
        // 等锁期间别人已经改成了一样的值：什么都没变，不写审计
        if (fields.length)
          await auditIn(
            tx,
            c,
            {
              action: 'environment.update',
              actorKind: 'user',
              actorId: user.id,
              targetKind: 'environment',
              targetId: eid,
              projectId: pid,
              data: {
                projectId: pid,
                name: r.env.name,
                fields,
                ...(r.changed
                  ? {
                      policy: {
                        before: r.ownBefore,
                        after: r.ownAfter,
                        pinned: r.pinned,
                        loosened: r.loosened,
                      },
                    }
                  : {}),
              },
            },
            ctx.security,
          );
        const [row] = await tx.query<EnvRow>('select * from environments where id = $1', [eid]);
        return { r, row: row! };
      });
      await shadows.forget(eid);
    } finally {
      await release?.();
    }
    // 响应直接用锁内的结果：策略只换掉环境层（不再读四层），当前版本一条轻量查询
    const { r, row } = done;
    const environments = new Map(r.store.environments);
    environments.set(eid, r.ownAfter);
    const auth = envAuthOf({ ...r.store, environments }, r.rc, r.project, row);
    const [cur] = row.current_version_id
      ? await db.query<VersionRefRow>('select id, number, name from versions where id = $1', [
          row.current_version_id,
        ])
      : [];
    // P5b：连接串 / 生产标记 / 档位变了，这个环境上还没结束的执行申请重新检查
    ctx.requests.kick({ envIds: [row.id] });
    return c.json<EnvInfo>(
      toEnvInfo(
        row,
        actor,
        r.role,
        auth,
        {
          currentVersion: cur ? versionRef(cur) : null,
        },
        a.dialect,
      ),
    );
  });

  app.delete('/api/projects/:pid/environments/:eid', async (c) => {
    // 锁外只做轻量检查（看不见项目 / 环境不存在 404），不读执行策略；删除受执行策略约束，权限只在执行策略锁里判断一次（和 PATCH 一致）
    const a = await access(c, ctx, 'environment.read');
    const eid = (await loadEnv(db, a.pid, c.req.param('eid')!)).id;
    const user = c.get('user');
    // 本进程正在执行时不能删（409，见 lockEnvIdle）；残留的 claimed 保守处理（settleClaims）：版本算执行过，然后照常删
    const release = await lockEnvIdle(ctx.exec, eid);
    try {
      await withPolicyLock(db, async (tx) => {
        // 删除环境受执行策略约束：锁内重新读项目当前的组、调用者的角色、环境行和四层策略再判断
        // （等锁期间别人可能把它收紧成了“仅限执行者”，或者转了组）
        const now = await accessIn(tx, user, a.pid);
        const [row] = await tx.query<EnvRow>('select * from environments where id = $1 and project_id = $2', [
          eid,
          a.pid,
        ]);
        if (!row) throw new HTTPException(404, { message: '环境不存在' });
        const auth = envAuthOf(await loadPolicies(tx, now.project), now.rc, now.project, row);
        if (!can(userActor(user), 'environment.delete', envResource(row, now.role, auth)))
          throw new HTTPException(403, { message: deniedMessage('environment.delete', auth) });
        await settleClaims(tx, eid);
        // 环境层的策略和环境上的执行者授权（范围是多态的，没有外键）
        await deletePolicies(tx, 'environment', [eid]);
        await tx.query("delete from grants where scope_kind = 'environment' and scope_id = $1", [eid]);
        await tx.query('delete from environments where id = $1 and project_id = $2', [eid, a.pid]);
      });
      await shadows.forget(eid);
    } finally {
      await release();
    }
    // 环境上的执行者授权跟着删了：可能有人因此看不到这个项目
    await rooms.refreshLoaded();
    await audit(
      db,
      c,
      {
        action: 'environment.delete',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'environment',
        targetId: eid,
        projectId: a.pid,
        data: { projectId: a.pid },
      },
      ctx.security,
    );
    return c.json<Ok>({ ok: true });
  });

  app.post('/api/projects/:pid/environments/:eid/test', async (c) => {
    const a = await access(c, ctx, 'environment.read');
    const row = await loadEnv(db, a.pid, c.req.param('eid')!);
    const url = decrypt(row.url_enc);
    // 白名单在连接层检查，所以实例设置之后改严也会在这里生效
    const info = await inspectTarget(url, CHECK_CONNECT_TIMEOUT, ctx.guard, a.dialect);
    // 探测成功后按 url_enc 条件原子回写最新版本（防与并发 PATCH 改连接串发生倒挂）
    if (row.engine_version !== info.version || row.engine_version_num !== info.versionNum) {
      const updated = await updateEnvVersion(db, row.id, info.version, info.versionNum, row.url_enc);
      if (updated) await shadows.forget(row.id);
    }
    return c.json<TargetInfo>(info);
  });

  /**
   * 保留线上的修改（ADR 0004 的出口一）：从环境读线上结构，按名字沿用工作副本里的对象 ID（reconcileIds），**覆盖**工作副本。
   * 这是普通的模型编辑（项目编辑者即可），之后由用户检查、修改，按普通流程发布，再把环境“标记为已执行”到新版本。
   * - 和检查漂移共用连接限速；
   * - `{ preview: true }`：只读，返回覆盖会带来的差异（plan(工作副本, 线上结构)）、线上结构指纹，以及三种只警告、不拦截的情况：
   *   环境落后于链头（覆盖会撤销中间版本的修改）、环境有半途失败的迁移、工作副本有未发布的修改（会被覆盖）；
   * - 审计记来源环境和线上结构指纹。
   */
  app.post('/api/projects/:pid/environments/:eid/pull', async (c) => {
    const a = await access(c, ctx, 'environment.pull');
    const b = importRequestSchema.safeParse(await c.req.json().catch(() => ({})));
    const preview = b.success && b.data.preview === true;
    connectionLimit(c, ctx);
    const env = await loadEnv(db, a.pid, c.req.param('eid')!);
    const expectedSeq = b.success ? b.data.workingSeq : undefined;
    // 预览（以及不带预览 seq 的直接覆盖）是关键出口：先规范化，让差异与返回的 workingSeq 都基于规范后的工作副本；
    // 确认覆盖阶段带着预览时的 seq，不能再 flush（写回会推进 seq，造成自己跟自己冲突的 409 working_changed）
    if (preview || expectedSeq === undefined) await refresher.flush(a.branch);
    const { model: working, seq: workingSeq } = await rooms.model(a.branch);
    const live = await readLive(ctx.exec, env, a.schemas, working);
    /** 预览：差异 + 指纹 + 三种只警告不拦截的情况 */
    const previewOf = async (w = working, sq = workingSeq): Promise<PullPreview> => {
      const metas = await loadVersionMetas(db, a.pid);
      let head: (typeof metas)[number] | undefined;
      for (let i = metas.length - 1; i >= 0; i--) {
        if (!metas[i]!.retired) {
          head = metas[i];
          break;
        }
      }
      const cur = metas.find((m) => m.id === env.current_version_id);
      const [headModel] = head
        ? await db.query<{ model: Model }>('select model from versions where id = $1', [head.id])
        : [];
      const planOpts = await projectPlanOptions(db, a.pid, a.dialect);
      const diff = planDiff(w, live.model, planOpts);
      return {
        items: diff.items,
        total: diff.total,
        fingerprint: live.fingerprint,
        workingSeq: sq,
        warnings: {
          // 环境未到达当前活跃链头（落后或停在已作废岔路）；从来没有执行过但链上已经有活跃版本也算
          behindHead:
            head && (!cur || cur.id !== head.id)
              ? { current: cur ? versionRef(cur) : null, head: versionRef(head) }
              : null,
          unfinished: live.state?.unfinished != null,
          readbackFailure: live.state?.readbackFailure != null,
          workingDirty: headModel ? planDiff(headModel.model, w, planOpts).total > 0 : false,
        },
      };
    };
    if (preview) return c.json<PullPreview>(await previewOf());
    const workingChangedResponse = async (model: Model, seq: number) =>
      c.json(
        {
          error: '工作副本在预览之后被改过，请重新确认差异',
          code: 'working_changed',
          preview: await previewOf(model, seq),
        },
        409,
      );
    // 确认覆盖时带着预览时的工作副本 seq：工作副本在预览之后被改过（别人又编辑了模型）→ 409 working_changed，带新的预览，不覆盖
    const workingChanged = async () => {
      if (expectedSeq === undefined) return null;
      // 现在的工作副本（读线上结构要花时间，期间也可能被改）：和预览时的 seq 比
      const now = await rooms.model(a.branch);
      return now.seq === expectedSeq ? null : workingChangedResponse(now.model, now.seq);
    };
    const changedEarly = await workingChanged();
    if (changedEarly) return changedEarly;
    // 带着预览时的指纹：线上结构在预览之后变了（又有人改了库）就 409，带新的预览，让用户重新确认差异
    if (b.success && b.data.fingerprint && b.data.fingerprint !== live.fingerprint)
      return c.json(
        {
          error: '线上结构在预览之后变了，请重新确认差异',
          code: 'live_changed',
          preview: await previewOf(),
        },
        409,
      );
    // 覆盖之前再比一次（上面等线上结构的这段时间里工作副本也可能被改）；
    // 最终由 replace 在房间锁与 PG 行锁内原子校验 expectedSeq，消除跨副本与本地并发窗口
    const changedLate = await workingChanged();
    if (changedLate) return changedLate;
    try {
      await ctx.replace(a.branch, c.get('user').name, live.model, 'pullSchema', expectedSeq);
    } catch (err) {
      if (err instanceof WorkingChangedError) return workingChangedResponse(err.currentModel, err.currentSeq);
      throw err;
    }
    const { seq } = await rooms.model(a.branch);
    await audit(
      db,
      c,
      {
        action: 'environment.pull',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'environment',
        targetId: env.id,
        projectId: a.pid,
        data: {
          projectId: a.pid,
          environment: env.name,
          fingerprint: live.fingerprint,
          seq,
          objects: Object.keys(live.model.objects).length,
        },
      },
      ctx.security,
    );
    return c.json<ModelUpdate>({ seq, objects: Object.keys(live.model.objects).length });
  });
};
