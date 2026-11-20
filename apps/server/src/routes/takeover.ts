// 接手（P4c H5）：检查一个库里登记过哪些项目，以及向导里“接手现有项目”的执行流程。
//
// 接手相当于新建项目（权限用 group.create_project）；认领另一个实例写过的库需要实例管理员（instance.claim_project），
// 并且必须在请求里明确确认（content.claim），界面上有说明后果的确认对话框。
// 边界和新建项目向导一致：读目标库（只读）、合并、校验都在平台库事务之前；平台库的写入在一个事务里；
// 事务**提交之后**才写目标库（认领），所以认领失败不会留下“目标库被换手、平台上却没有项目”的状态——
// 项目已经建好，认领失败只作为警告返回，可以在环境页重试。
import {
  type ProjectCreated,
  type ProjectWizard,
  type TakeoverInspectResult,
  takeoverInspectSchema,
  type WizardEvent,
  type WizardStage,
} from '@dowel/api';
import { newId } from '@dowel/core';
import { HistoryError, listHistoryProjects, readHistoryFormat, ScopeError } from '@dowel/engines';
import {
  type ChainVersion,
  claimInstance,
  ExecutorError,
  type MergeSource,
  mergeHistories,
} from '@dowel/executor';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { audit } from '../audit.ts';
import { can, userActor } from '../authz.ts';
import { inList } from '../db.ts';
import { loadChain, loadEnv } from '../envs.ts';
import { checkEnvDrift, claimFailure } from '../executions.ts';
import { insertGrant } from '../grants.ts';
import { type GroupRow, pickProjectSlug } from '../groups.ts';
import { effectiveProjectRole, type RoleLookup } from '../roles.ts';
import { encrypt, SecretError, scrubSecrets } from '../secrets.ts';
import { readSettings } from '../settings.ts';
import { type Shadow, ShadowError } from '../shadow.ts';
import { sseSender } from '../sse.ts';
import {
  pickShadow,
  readSource,
  restoreChain,
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
  scrubUrl,
} from '../targets.ts';
import { type AppContext, body, connectionLimit, createProjectGroup, type Env } from './context.ts';

export const registerTakeover = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  /** 接手向导第一步：连上一个库，列出它登记过的项目（只读，兼容旧格式，不建任何东西） */
  app.post('/api/takeover/inspect', async (c) => {
    const b = await body(c, takeoverInspectSchema);
    // 接手相当于新建项目：和向导、连接检查同一个判断；服务端替用户连地址，共用限速
    await createProjectGroup(c, ctx, b.groupId);
    connectionLimit(c, ctx);
    const settings = await readSettings(db);
    const conn = connectPg(b.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
    try {
      const [dbName] = await conn.db.query<{ name: string }>('select current_database() as name');
      const format = await readHistoryFormat(conn.db);
      const rows = format === null ? [] : await listHistoryProjects(conn.db);
      // 本实例里有没有同一个项目 ID：**只查目标库列出的这几个 ID**（不扫全表）。
      // 看不到的项目（调用者没有权限）只说“已存在”并标 hidden，不给名字、归属：不能借接手检查探测别人看不到的项目，
      // 但也不能让接手悄悄覆盖已有的项目（UI 据此挡住并提示联系管理员）
      const ids = rows.map((r) => r.projectId);
      const existing = ids.length
        ? await db.query<{ id: string }>(`select id from projects where id in (${inList(ids)})`, ids)
        : [];
      const here = new Map<string, { hidden: boolean }>();
      const me = c.get('user');
      // 角色上下文（用户的组、授权）只读一次，所有项目共用（RoleLookup）
      const lookup: RoleLookup = { contexts: new Map(), projects: new Map() };
      for (const e of existing)
        here.set(e.id, { hidden: (await effectiveProjectRole(db, me, e.id, lookup)) === null });
      return c.json<TakeoverInspectResult>({
        database: dbName?.name ?? '',
        hasHistory: format !== null,
        instanceId: settings.instanceId,
        projects: rows.map((r) => ({
          projectId: r.projectId,
          name: r.name,
          claimedBy: r.instanceId,
          mine: r.instanceId === settings.instanceId,
          claimedAt: r.claimedAt,
          versions: r.versions,
          headNumber: r.headNumber,
          currentNumber: r.currentNumber,
          lastRunAt: r.lastRunAt,
          existsHere: here.has(r.projectId),
          hidden: here.get(r.projectId)?.hidden ?? false,
        })),
      });
    } catch (e) {
      if (e instanceof HTTPException || e instanceof HistoryError) throw e;
      throw new ShadowError(`连接失败：${scrubUrl(e instanceof Error ? e.message : String(e), b.url)}`);
    } finally {
      await conn.close().catch(() => {});
    }
  });
};

/** 向导里 kind = takeover：由 wizard.ts 在检查完组权限之后调用 */
export const runTakeover = (c: Context<Env>, ctx: AppContext, b: ProjectWizard, g: GroupRow) => {
  const { db } = ctx;
  const u = c.get('user');
  const projectId = b.content.projectId;
  if (!projectId) throw new HTTPException(400, { message: '请选择要接手的项目' });
  const environments = b.environments.map((e) => ({ ...e, name: e.name.trim() }));
  if (!environments.length)
    throw new HTTPException(422, {
      message:
        '接手需要至少一个环境：Dowel 要从目标库的 dowel 历史里恢复项目，请先在向导里添加它所在的数据库',
    });
  const names = new Set<string>();
  for (const e of environments) {
    if (!e.name) throw new HTTPException(400, { message: '环境名不能为空' });
    if (names.has(e.name)) throw new HTTPException(422, { message: `环境名“${e.name}”重复` });
    names.add(e.name);
  }
  connectionLimit(c, ctx, environments.length);

  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const send = sseSender<WizardEvent>(stream);
    let stage: WizardStage = 'connect';
    let committed = false;
    let shadow: Shadow | null = null;
    let createdShadow: { targetUrl: string; name: string } | null = null;
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
        await dropSameInstanceShadow(s.targetUrl, s.name, ctx.guard);
      }
    };
    const project: ProjectCreated = {
      id: projectId,
      name: b.name,
      slug: '',
      role: 'admin',
      group: { id: g.id, slug: g.slug, name: g.name },
    };
    try {
      project.slug = await pickProjectSlug(db, g.id, b.name, b.slug);
      await send({ stage });
      // 和环境创建同样的检查：连得上（白名单在连接层检查）、影子库能认领
      for (const e of environments) {
        await inspectTarget(e.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
        if (e.shadowUrl) await claimShadow(e.shadowUrl, ctx.guard);
      }

      stage = 'read';
      await send({ stage });
      // 读每个环境的目标库历史（只读）→ 每个环境的链完整性（verifyChain，按内容重算 checksum）→ 合并
      const sources: MergeSource[] = [];
      for (const e of environments)
        sources.push({
          name: e.name,
          state: await readSource(e.name, e.url, projectId, ctx.guard),
        });
      const merged = mergeHistories(sources);

      const [exists] = await db.query<{ slug: string; group_slug: string }>(
        'select p.slug, g.slug as group_slug from projects p join groups g on g.id = p.group_id where p.id = $1',
        [projectId],
      );
      if (exists) {
        // 调用者看不到的项目不透露名字 / 归属
        const visible = (await effectiveProjectRole(db, u, projectId)) !== null;
        throw new TakeoverRejected(
          'project_exists',
          visible
            ? `本实例里已经有这个项目（${exists.group_slug}/${exists.slug}）。要给它添加环境并接入已有历史，请用项目的“添加环境”`
            : '这个项目已在本实例上存在，请联系管理员',
        );
      }
      const ids = merged.versions.map((v) => v.versionId);
      const clash = await db.query<{ id: string }>(
        `select id from versions where id in (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
        ids,
      );
      if (clash.length)
        throw new TakeoverRejected(
          'project_exists',
          `本实例里已经有同一个版本（${clash[0]!.id}），不能重复接手`,
        );

      // 认领：目标库里这个项目的当前认领实例不是本实例，必须由实例管理员明确确认
      const settings = await readSettings(db);
      const foreign = sources.filter(
        (s) => s.state.project && s.state.project.instanceId !== settings.instanceId,
      );
      if (foreign.length) {
        const list = foreign.map((s) => `“${s.name}”`).join('、');
        if (!can(userActor(u), 'instance.claim_project', { kind: 'instance' }))
          throw new TakeoverRejected(
            'claim_forbidden',
            `环境 ${list} 的项目由另一个 Dowel 实例认领，接手需要“认领”它，只有实例管理员可以确认`,
          );
        if (!b.content.claim)
          throw new TakeoverRejected(
            'claim_required',
            `环境 ${list} 的项目由另一个 Dowel 实例认领，接手需要确认认领：之后原实例对这些库的执行会被拒绝`,
          );
      }

      // 强制全链影子库闭环验证（ADR 0012）：写入平台库事务之前，按版本顺序（v0 → v1 → … → vN）逐个验证。
      // 找不到可用影子库或任一版本验证失败，直接拒绝接手（不写平台库，也不认领目标库）。
      const head = merged.versions.at(-1)!;
      stage = 'verify';
      await send({ stage });
      const prepared = await pickShadow(environments, unionScopes(merged.versions), ctx.guard);
      shadow = prepared.shadow;
      createdShadow = prepared.created;
      const verifiedReports = await verifyVersionChain({
        shadow,
        shadowLabel: prepared.label,
        versions: merged.versions,
        baseModel: null,
        onVersion: async (v, i, total) => {
          await send({ stage: 'verify', detail: `v${v.number} (${i + 1}/${total})` });
        },
      });

      stage = 'write';
      await send({ stage });
      const branch = newId();
      const envRows = environments.map((e) => ({
        id: newId(),
        name: e.name,
        url_enc: encrypt(e.url),
        production: e.production,
        allowSameInstance: e.allowSameInstance,
        shadow_url_enc: e.shadowUrl ? encrypt(e.shadowUrl) : null,
        state: sources.find((s) => s.name === e.name)!.state,
      }));
      await db.transaction(async (tx) => {
        await tx.query(
          'insert into projects (id, name, created_by, group_id, slug, schemas) values ($1, $2, $3, $4, $5, $6::text::jsonb)',
          [
            projectId,
            b.name,
            u.id,
            g.id,
            project.slug,
            head.scope?.length ? JSON.stringify(head.scope) : null,
          ],
        );
        await insertGrant(tx, {
          subjectKind: 'user',
          subjectId: u.id,
          role: 'admin',
          scopeKind: 'project',
          scopeId: projectId,
          createdBy: u.id,
        });
        await restoreChain(tx, { pid: projectId, branch, merged, envs: envRows, verifiedReports });
      });
      committed = true;

      try {
        await audit(
          db,
          c,
          {
            action: 'project.takeover',
            actorKind: 'user',
            actorId: u.id,
            targetKind: 'project',
            targetId: projectId,
            projectId,
            data: {
              name: b.name,
              slug: project.slug,
              groupId: g.id,
              environments: envRows.map((e) => e.name),
              versions: merged.versions.length,
              head: head.number,
              claimed: foreign.map((s) => s.name),
            },
          },
          ctx.security,
        );
        for (const e of envRows)
          await audit(
            db,
            c,
            {
              action: 'environment.create',
              actorKind: 'user',
              actorId: u.id,
              targetKind: 'environment',
              targetId: e.id,
              projectId,
              data: { projectId, name: e.name, takeover: true },
            },
            ctx.security,
          );
      } catch (e) {
        console.error('接手：写审计失败（项目已经建好）', e);
      }

      // 认领：提交之后才写目标库。失败不回滚项目（已经建好），作为警告返回，可以在环境页重试认领
      const warnings: string[] = [];
      if (foreign.length) {
        stage = 'claim';
        await send({ stage });
      }
      // 平台刚恢复的链：加载一次，所有需要认领的环境共用。**项目已经建好**：读失败不能让整个接手失败，
      // 每个需要认领的环境各记一条 warning（可以在环境页重试认领），后面的初始漂移检查照常尝试
      let chain: ChainVersion[] = [];
      let chainFailed = false;
      if (foreign.length)
        try {
          chain = await loadChain(db, projectId);
        } catch (e) {
          chainFailed = true;
          console.error(
            '接手：读取版本链失败（项目已经建好，认领没有做）',
            e instanceof Error ? scrubSecrets(e.message) : e,
          );
        }
      for (const s of foreign) {
        if (chainFailed) {
          warnings.push(`环境“${s.name}”认领失败：读取版本链出错，可以在环境页重试认领`);
          continue;
        }
        const url = environments.find((e) => e.name === s.name)!.url;
        const conn = connectPg(url, CHECK_CONNECT_TIMEOUT, ctx.guard);
        let claim: Awaited<ReturnType<typeof claimInstance>> | null = null;
        try {
          // 在目标库的项目锁里和平台刚恢复的链重新比对：读取之后原实例又执行了新版本，就拒绝认领
          claim = await claimInstance({
            db: conn.db,
            projectId,
            projectName: b.name,
            instanceId: settings.instanceId,
            claimedBy: u.id,
            claimedByName: u.name,
            chain,
          });
        } catch (e) {
          console.error('接手：认领失败（项目已经建好）', e instanceof Error ? scrubSecrets(e.message) : e);
          const why = claimFailure(e, url);
          const ahead =
            e instanceof ExecutorError && (e.code === 'history_mismatch' || e.code === 'history_conflict');
          warnings.push(
            ahead
              ? `环境“${s.name}”没有认领：${why}。项目已经建好；要把读取之后的新版本也接过来，请删除这个项目后重新接手`
              : `环境“${s.name}”认领失败：${why}。项目已经建好，可以在环境页重试认领`,
          );
        } finally {
          await conn.close().catch(() => {});
        }
        // 认领已经成功：审计单独写，写失败只记日志（audit 内部已经吞掉），不能算成认领失败
        if (claim)
          await audit(
            db,
            c,
            {
              action: 'project.claim',
              actorKind: 'user',
              actorId: u.id,
              targetKind: 'environment',
              targetId: envRows.find((e) => e.name === s.name)!.id,
              projectId,
              data: {
                projectId,
                environment: s.name,
                previousInstanceId: claim.previousInstanceId,
                via: 'takeover',
              },
            },
            ctx.security,
          );
      }
      // 初始化各环境的漂移状态（尽力而为：失败只记日志）
      for (const e of envRows)
        try {
          await checkEnvDrift(ctx.exec, await loadEnv(db, projectId, e.id));
        } catch (x) {
          console.error('接手：初始漂移检查失败（忽略）', x instanceof Error ? x.message : x);
        }
      await send({ stage: 'done', project, ...(warnings.length ? { warnings } : {}) });
    } catch (e) {
      if (committed) {
        console.error('接手：提交之后的步骤失败', e);
        await send({ stage: 'done', project });
        return;
      }
      // 提交之前失败：清理本次新建的同实例影子库
      await cleanupShadow();
      let code: string | undefined;
      let message: string;
      if (e instanceof TakeoverRejected || (e instanceof ExecutorError && e.code !== 'unexpected')) {
        code = e.code;
        message = e.message;
      } else if (
        e instanceof HTTPException ||
        e instanceof ShadowError ||
        e instanceof ScopeError ||
        e instanceof SecretError ||
        e instanceof HistoryError
      ) {
        message = e.message;
        if (e instanceof HistoryError) code = e.code;
      } else {
        console.error('接手：提交之前失败', e);
        message = '服务器内部错误';
      }
      await send({ stage, error: message, ...(code ? { code } : {}) });
    } finally {
      await closeShadow();
    }
  });
};
