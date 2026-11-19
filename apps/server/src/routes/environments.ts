// 环境：项目要部署到的数据库实例（连接信息加密存储）。
import {
  type EnvInfo,
  type EnvironmentCreated,
  environmentCreateSchema,
  environmentPatchSchema,
  importRequestSchema,
  type ModelUpdate,
  type Ok,
  type PullPreview,
  type TargetInfo,
} from '@dowel/api';
import { type Model, newId } from '@dowel/core';
import { planDiff } from '@dowel/executor';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { audit } from '../audit.ts';
import { can, type EnvAction, effectiveExecPolicy, isEnvAction, userActor } from '../authz.ts';
import { type EnvRow, envResource, loadEnv, loadVersionMetas, toEnvInfo, versionRef } from '../envs.ts';
import { lockEnvIdle, readLive, settleClaims } from '../executions.ts';
import { encrypt } from '../secrets.ts';
import { CHECK_CONNECT_TIMEOUT, claimShadow, inspectTarget } from '../targets.ts';
import { type AppContext, access, body, connectionLimit, type Env, envAccess } from './context.ts';

export const registerEnvironments = (app: Hono<Env>, ctx: AppContext) => {
  const { db, rooms, shadows, refresher } = ctx;

  app.get('/api/projects/:pid/environments', async (c) => {
    const a = await access(c, ctx, 'environment.read');
    const rows = await db.query<EnvRow>(
      'select * from environments where project_id = $1 order by created_at',
      [a.pid],
    );
    const versions = new Map((await loadVersionMetas(db, a.pid)).map((v) => [v.id, v]));
    const actor = userActor(c.get('user'));
    return c.json<EnvInfo[]>(rows.map((r) => toEnvInfo(r, actor, a.role, versions)));
  });

  app.post('/api/projects/:pid/environments', async (c) => {
    const a = await access(c, ctx, 'environment.manage');
    const b = await body(c, environmentCreateSchema);
    // 白名单在连接层检查（ctx.guard）：目标库和影子库都要过一遍
    const info = await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard); // 先确认能连上
    if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard);
    const id = newId();
    await db.query(
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
    // 有了真实的影子库，补做表达式和不透明对象 DDL 的规范化
    refresher.schedule(a.branch);
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

  // 修改环境：连接串 / 影子库 / 生产标记 / 执行档位都是特权操作（H6），按环境的执行档位检查
  app.patch('/api/projects/:pid/environments/:eid', async (c) => {
    const { env, ...a } = await envAccess(c, ctx, 'environment.read');
    const b = await body(c, environmentPatchSchema);
    const eid = env.id;
    const actor = userActor(c.get('user'));
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
    if (changed(b.allowSameInstance, env.allow_same_instance)) {
      need.add('environment.change_connection');
      fields.push('allowSameInstance');
    }
    if (changed(b.production, env.production)) {
      // 取消“生产”标记是特权操作；标成生产是收紧，项目管理员就能做
      need.add(b.production ? 'environment.manage' : 'environment.unmark_production');
      fields.push('production');
    }
    if (b.execPolicy !== undefined && b.execPolicy !== env.exec_policy) {
      need.add('environment.set_policy');
      fields.push('execPolicy');
    }
    if (!fields.length) throw new HTTPException(400, { message: '没有要修改的内容' });
    for (const action of need) {
      const ok = isEnvAction(action)
        ? can(actor, action, envResource(env, a.role))
        : can(actor, 'environment.manage', { kind: 'project', role: a.role });
      if (!ok)
        throw new HTTPException(403, {
          message:
            effectiveExecPolicy({ production: env.production, execPolicy: env.exec_policy }) === 'executor'
              ? '这个环境设置为“仅限执行者”：目前只有实例管理员可以修改它'
              : '修改这个环境需要项目管理员，并且要满足它的执行档位',
        });
    }
    // 连接配置（连接串 / 影子库 / 是否允许同实例）：本进程不能正在对这个环境执行。**先拿环境锁**（409 的请求不对任何数据库产生副作用），
    // 再做外部检查，最后在一个平台库事务里改。环境上残留的 claimed（崩溃留下的）保守处理，不会把环境锁死，见 settleClaims
    const connection = fields.some((f) => f === 'url' || f === 'shadowUrl' || f === 'allowSameInstance');
    const release = connection ? await lockEnvIdle(ctx.exec, eid) : null;
    try {
      // 外部检查在写库之前：新连接串要连得上（白名单在连接层检查），影子库要能认领
      if (b.url !== undefined) await inspectTarget(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
      if (b.shadowUrl) await claimShadow(b.shadowUrl, ctx.guard);
      // 取消生产标记时，没有显式设置过档位的环境把当前生效的档位固定下来：
      // 改标记不能悄悄把“项目管理员才能执行”放宽成“编辑者就能执行”
      const productionOff = b.production === false && env.production;
      const policy =
        b.execPolicy !== undefined
          ? b.execPolicy
          : productionOff && env.exec_policy === null
            ? effectiveExecPolicy({ production: env.production, execPolicy: null })
            : undefined;
      // 只写改动的列：不拿旧行的值回写没改的列（尤其是并发改了连接串时）
      const vals: unknown[] = [eid];
      const sets: string[] = [];
      const set = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (b.url !== undefined) set('url_enc', encrypt(b.url));
      if (b.shadowUrl !== undefined) set('shadow_url_enc', b.shadowUrl ? encrypt(b.shadowUrl) : null);
      if (b.allowSameInstance !== undefined) set('allow_same_instance', b.allowSameInstance);
      if (b.production !== undefined) set('production', b.production);
      if (policy !== undefined) set('exec_policy', policy);
      await db.transaction(async (tx) => {
        if (connection) await settleClaims(tx, eid);
        if (sets.length) await tx.query(`update environments set ${sets.join(', ')} where id = $1`, vals);
        // 连接串换了：缓存的当前版本和漂移结果属于旧的库，作废（版本“执行过”的永久事实记在 versions.executed_at，不受影响；镜像由之后的同步对齐）
        if (b.url !== undefined)
          await tx.query(
            "update environments set current_version_id = null, drift_status = 'unknown', drift_summary = null, last_drift_check = null where id = $1",
            [eid],
          );
      });
      await shadows.forget(eid);
    } finally {
      release?.();
    }
    await audit(
      db,
      c,
      {
        action: 'environment.update',
        actorKind: 'user',
        actorId: c.get('user').id,
        targetKind: 'environment',
        targetId: eid,
        projectId: a.pid,
        data: { projectId: a.pid, name: env.name, fields },
      },
      ctx.security,
    );
    const [row] = await db.query<EnvRow>('select * from environments where id = $1', [eid]);
    const versions = new Map((await loadVersionMetas(db, a.pid)).map((v) => [v.id, v]));
    return c.json<EnvInfo>(toEnvInfo(row!, actor, a.role, versions));
  });

  app.delete('/api/projects/:pid/environments/:eid', async (c) => {
    const a = await envAccess(c, ctx, 'environment.delete');
    const eid = a.env.id;
    // 本进程正在执行时不能删（409，见 lockEnvIdle）；残留的 claimed 保守处理（settleClaims）：版本算执行过，然后照常删
    const release = await lockEnvIdle(ctx.exec, eid);
    try {
      await db.transaction(async (tx) => {
        await settleClaims(tx, eid);
        await tx.query('delete from environments where id = $1 and project_id = $2', [eid, a.pid]);
      });
      await shadows.forget(eid);
    } finally {
      release();
    }
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
    const env = await shadows.env(a.pid, c.req.param('eid'));
    // 白名单在连接层检查，所以实例设置之后改严也会在这里生效
    return c.json<TargetInfo>(await inspectTarget(env.url, CHECK_CONNECT_TIMEOUT, ctx.guard));
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
    await refresher.flush(a.branch);
    const { model: working, seq: workingSeq } = await rooms.model(a.branch);
    const live = await readLive(ctx.exec, env, a.schemas, working);
    /** 预览：差异 + 指纹 + 三种只警告不拦截的情况 */
    const previewOf = async (w = working, sq = workingSeq): Promise<PullPreview> => {
      const metas = await loadVersionMetas(db, a.pid);
      const head = metas.at(-1);
      const cur = metas.find((m) => m.id === env.current_version_id);
      const [headModel] = head
        ? await db.query<{ model: Model }>('select model from versions where id = $1', [head.id])
        : [];
      const diff = planDiff(w, live.model);
      return {
        items: diff.items,
        total: diff.total,
        fingerprint: live.fingerprint,
        workingSeq: sq,
        warnings: {
          // 环境落后于链头；从来没有执行过（没有当前版本）但链上已经有版本也算——覆盖同样不会带上任何中间版本
          behindHead:
            head && (!cur || cur.number < head.number)
              ? { current: cur ? versionRef(cur) : null, head: versionRef(head) }
              : null,
          unfinished: live.state?.unfinished != null,
          readbackFailure: live.state?.readbackFailure != null,
          workingDirty: headModel ? planDiff(headModel.model, w).total > 0 : false,
        },
      };
    };
    if (preview) return c.json<PullPreview>(await previewOf());
    // 确认覆盖时带着预览时的工作副本 seq：工作副本在预览之后被改过（别人又编辑了模型）→ 409 working_changed，带新的预览，不覆盖
    const workingChanged = async () => {
      if (!b.success || b.data.workingSeq === undefined) return null;
      // 现在的工作副本（读线上结构要花时间，期间也可能被改）：和预览时的 seq 比
      const now = await rooms.model(a.branch);
      return now.seq === b.data.workingSeq
        ? null
        : c.json(
            {
              error: '工作副本在预览之后被改过，请重新确认差异',
              code: 'working_changed',
              preview: await previewOf(now.model, now.seq),
            },
            409,
          );
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
    // 覆盖之前再比一次（上面等线上结构的这段时间里工作副本也可能被改）；之后到 replace 之间没有 await 以外的窗口
    const changedLate = await workingChanged();
    if (changedLate) return changedLate;
    await ctx.replace(a.branch, c.get('user').name, live.model, 'pullSchema');
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
