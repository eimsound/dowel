// 新建项目向导（P3）：一次请求建好项目、环境、schema 范围和初始内容，导入完成后自动发布 v0 基线。
//
// 边界（见 05-implementation.md 的 P3 一节）：
// - 连环境、给影子库打标记、读目标库、在影子库里执行 SQL、规范化都在平台库事务**之前**完成；
//   这些外部操作失败就什么都不写；平台库事务失败则整体回滚，并清理本次新建的影子库。
// - 平台库的写入（项目、授权、分支 / 快照 / 基线、环境、v0 版本）在同一个事务里，要么全部成功要么全部回滚。
// - 事务**提交之后**的失败（写审计、进度发不出去）不影响已经建好的项目：只记日志，
//   不回滚、不删影子库、不发 error 事件。
// - 只写 Dowel 平台库：**绝不写目标库**（影子库里执行完就扔，目标库只读）。
//
// 进度用 SSE（text/event-stream），阶段粒度：连接 → 读取结构 → 规范化 → 写入 → 完成。
// 选 SSE 而不是“先返回任务 ID 再轮询”：不需要在服务端保存任务状态、不用清理过期任务，
// 建好的项目和最终进度在同一个请求里返回，测试里读一次响应体就能看到全部阶段。
import {
  BASELINE_VERSION_NAME,
  type ProjectCreated,
  projectWizardSchema,
  type StoredVerifyReport,
  type WizardEvent,
  type WizardStage,
} from '@dowel/api';
import { createSchema, emptyModel, type Model, newId } from '@dowel/core';
import { ScopeError } from '@dowel/engines';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { audit } from '../audit.ts';
import { freezeBaseline } from '../chain.ts';
import { insertGrant } from '../grants.ts';
import { pickProjectSlug } from '../groups.ts';
import { encrypt, SecretError, scrubSecrets } from '../secrets.ts';
import { assertImportable, type Shadow, ShadowError, storedReport } from '../shadow.ts';
import { prepareShadow } from '../shadows.ts';
import { sseSender } from '../sse.ts';
import {
  CHECK_CONNECT_TIMEOUT,
  claimShadow,
  dropSameInstanceShadow,
  inspectTarget,
  pullSchema,
} from '../targets.ts';
import { type AppContext, body, connectionLimit, createProjectGroup, type Env } from './context.ts';
import { runTakeover } from './takeover.ts';

export const registerWizard = (app: Hono<Env>, ctx: AppContext) => {
  const { db } = ctx;

  app.post('/api/projects/wizard', async (c) => {
    const u = c.get('user');
    const b = await body(c, projectWizardSchema);

    const g = await createProjectGroup(c, ctx, b.groupId);

    const kind = b.content.kind;
    // 接手：从目标库的 dowel 历史恢复整个项目（routes/takeover.ts）
    if (kind === 'takeover') return runTakeover(c, ctx, b, g);

    // 环境名统一去首尾空白（界面上也 trim；这里兜底），去完不能为空、不能重复
    const environments = b.environments.map((e) => ({ ...e, name: e.name.trim() }));
    for (const e of environments) if (!e.name) throw new HTTPException(400, { message: '环境名不能为空' });
    const names = new Set<string>();
    for (const e of environments) {
      if (names.has(e.name)) throw new HTTPException(422, { message: `环境名“${e.name}”重复` });
      names.add(e.name);
    }

    // schema 范围：空数组视为全部（dowel 永远排除，引擎层写死）
    const scope = b.schemas?.length ? b.schemas : null;

    // 初始内容引用的环境：database 显式指定；sql 用第一个环境（影子库只能来自真实实例）
    const wantEnv = b.content.env?.trim();
    let source = kind === 'database' || kind === 'sql' ? environments[0] : undefined;
    if (kind === 'database') {
      source = wantEnv ? environments.find((e) => e.name === wantEnv) : undefined;
      if (!source) throw new HTTPException(400, { message: '请选择要从哪个环境导入' });
    }
    if (kind === 'sql' && !b.content.sql)
      throw new HTTPException(400, { message: '请粘贴或选择要导入的 SQL' });
    if ((kind === 'database' || kind === 'sql') && !source)
      throw new HTTPException(422, {
        message:
          '导入结构需要至少一个环境：Dowel 只用真实的 PostgreSQL 实例作影子库，请先在向导第 2 步添加环境',
      });

    // 限速（服务端替用户去连地址）：每个环境算一次，导入再算一次；超限时还没有开始任何写入
    const needed = environments.length + (kind === 'database' || kind === 'sql' ? 1 : 0);
    connectionLimit(c, ctx, needed);

    // 导入的 SQL 里有实例级语句就拒绝：在限速之后（扫描 SQL 也要花 CPU）、连接任何数据库和准备影子库之前，
    // 不建 {库名}_dowel、不拿锁、不执行；只在这里扫一遍，下游的 importSql 只接受检查过的类型（见 assertImportable）
    const importable = kind === 'sql' ? assertImportable(b.content.sql!) : null;

    // 和环境创建同样的检查：每个环境都要连得上（白名单在连接层检查）；配置了影子库的还要能认领
    for (const e of environments) {
      await inspectTarget(e.url, CHECK_CONNECT_TIMEOUT, ctx.guard);
      if (e.shadowUrl) await claimShadow(e.shadowUrl, ctx.guard);
    }

    const slug = await pickProjectSlug(db, g.id, b.name, b.slug);
    const envRows = environments.map((e) => ({ ...e, id: newId() }));
    const project: ProjectCreated = {
      id: newId(),
      name: b.name,
      slug,
      role: 'admin',
      group: { id: g.id, slug: g.slug, name: g.name },
    };
    const branch = newId();

    // 反向代理（nginx）默认会缓冲响应：明确关掉，进度才能一条条到达浏览器
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let stage: WizardStage = 'connect';
      // 客户端断开（send 失败）只丢掉后续进度，不影响正在做的写入；提交之后不再发任何 error 事件。
      // 要发的文本统一在 sseSender 里脱敏，这里不再逐处 scrubSecrets
      const send = sseSender<WizardEvent>(stream);
      // 本次请求新建的影子库：失败时清理（显式配置的影子库不删，那是用户的库）
      let createdShadow: { targetUrl: string; name: string } | null = null;
      let shadow: Shadow | null = null;
      /** 验证报告里显示的影子库（与环境页的写法一致：环境名：库名） */
      let shadowLabel = '';
      let committed = false;
      try {
        // ── 外部操作：读目标库 / 在影子库里执行 SQL，都在平台库事务之前 ──
        let model: Model;
        if (kind === 'blank') {
          model = emptyModel();
          createSchema(model, 'public');
        } else if (kind === 'database') {
          // 环境在上面已经连过了（inspectTarget），这里只读结构
          stage = 'connect';
          await send({ stage });
          stage = 'read';
          await send({ stage });
          // 从线上库读结构：只执行 SET 和 SELECT，按 schema 范围过滤；跨范围引用会抛 ScopeError
          model = await pullSchema(source!.url, scope, ctx.guard);
        } else {
          stage = 'connect';
          await send({ stage });
          // 影子库：环境显式配置的用它（环境阶段已经 claimShadow 过）；否则用目标实例上的 {原库名}_dowel
          const prepared = await prepareShadow(source!, scope, ctx.guard);
          shadow = prepared.shadow;
          shadowLabel = prepared.label;
          createdShadow = prepared.created;
          stage = 'read';
          await send({ stage });
          model = await shadow.importSql(importable!);
          stage = 'canonicalize';
          await send({ stage });
        }

        // ── 平台库：一个事务写入项目、授权、分支 / 快照 / 基线、环境、v0 基线版本 ──
        stage = 'write';
        await send({ stage });
        const imported = kind !== 'blank';

        // v0 基线的冻结脚本，以及它是否“已验证”（同样在平台库事务之前，是外部操作）。
        // 已验证的含义是：**执行了这份冻结的 up 脚本**，在影子库里从空库建出来，读回的结构与模型一致。
        // 验证是可选的，不能挡住项目创建：
        // - 没有可用的影子库（ShadowError：生产环境不让用同实例、没有建库权限、连不上、被占用）：基线未验证；
        // - 脚本执行失败 / 结构对不上：基线未验证，带着失败报告；
        // - 其他任何意外错误：记日志，基线未验证，报告里写明原因。
        const baseline = imported ? freezeBaseline(model, scope) : null;
        let baselineReport: StoredVerifyReport | null = null;
        if (baseline) {
          try {
            if (!shadow) {
              // database 路径本来没有用到影子库：和 sql 路径、forProject 用同一份选择逻辑
              const prepared = await prepareShadow(source!, scope, ctx.guard);
              shadow = prepared.shadow;
              shadowLabel = prepared.label;
              createdShadow = prepared.created;
            }
            baselineReport = storedReport(
              await shadow.verifyScripts(baseline.from, model, baseline.up, [], { checkDown: false }),
              shadowLabel,
            );
          } catch (e) {
            // 白名单拒绝（HTTPException）和密钥解密失败（SecretError）与发布一致：继续抛出，向导以 error 事件结束
            // （已经新建的影子库走下面原来的 pre-commit 清理）
            if (e instanceof HTTPException || e instanceof SecretError) throw e;
            if (!(e instanceof ShadowError)) {
              console.error('新建项目向导：基线验证出错（基线标为未验证，项目照常创建）', e);
              baselineReport = {
                ok: false,
                upDiff: [],
                downDiff: [],
                risks: [],
                error: {
                  step: null,
                  // 报告会存进版本、发给客户端：错误消息里可能带着连接串（含密码），先脱敏
                  message: `基线验证没有完成：${scrubSecrets(e instanceof Error ? e.message : String(e))}`,
                },
                shadow: shadowLabel,
                at: new Date().toISOString(),
              };
            }
          }
        }
        await db.transaction(async (tx) => {
          await tx.query(
            'insert into projects (id, name, created_by, group_id, slug, schemas) values ($1, $2, $3, $4, $5, $6::text::jsonb)',
            [project.id, project.name, u.id, g.id, slug, scope ? JSON.stringify(scope) : null],
          );
          // 建项目的人自动获得这个项目的 admin 授权
          await insertGrant(tx, {
            subjectKind: 'user',
            subjectId: u.id,
            role: 'admin',
            scopeKind: 'project',
            scopeId: project.id,
            createdBy: u.id,
          });
          // 导入的模型就是引擎读出的规范形式：直接作为派生数据的基线，不用再跑一次规范化
          await tx.query(
            "insert into branches (id, project_id, name, baseline) values ($1, $2, 'main', $3::text::jsonb)",
            [branch, project.id, imported ? JSON.stringify(model) : null],
          );
          await tx.query(
            'insert into room_snapshots (branch_id, seq, model, versions) values ($1, 0, $2::text::jsonb, $3::text::jsonb)',
            [branch, JSON.stringify(model), '{}'],
          );
          for (const e of envRows)
            await tx.query(
              `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, shadow_url_enc)
               values ($1, $2, $3, $4, $5, $6, $7)`,
              [
                e.id,
                project.id,
                e.name,
                encrypt(e.url),
                e.production,
                e.allowSameInstance,
                e.shadowUrl ? encrypt(e.shadowUrl) : null,
              ],
            );
          // v0 基线：number 0、没有 parent；up 是在空库上建出这个模型，down 为空（基线没有回滚）。
          // verified_at 只有在上面真的执行了冻结的 up 脚本、读回的结构与模型一致时才设置；
          // 没有影子库或验证失败就留空（“未验证”），失败的报告存进 verify_report。只写平台库，绝不写目标库
          if (baseline) {
            const frozen = baseline;
            const now = baselineReport?.ok ? baselineReport.at : null;
            await tx.query(
              `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                                    up_steps, down_steps, checksum, verified_at, verify_report, scope)
               values ($1, $2, $3, 0, $4, $5::text::jsonb, $6, 0, null, $7::text::jsonb, $8::text::jsonb, $9, $10,
                       $11::text::jsonb, $12::text::jsonb)`,
              [
                newId(),
                project.id,
                branch,
                BASELINE_VERSION_NAME,
                JSON.stringify(model),
                u.id,
                JSON.stringify(frozen.up),
                JSON.stringify(frozen.down),
                frozen.checksum,
                now,
                baselineReport ? JSON.stringify(baselineReport) : null,
                scope ? JSON.stringify(scope) : null,
              ],
            );
          }
        });

        // ── 到这里为止平台库还没动过；提交之前出问题才回滚 + 清理影子库 ──
        committed = true;

        // ── 提交之后：项目已经建好。写审计只记日志（audit 内部已经吞掉错误，这里再兜一层），
        //    进度发不出去也忽略 —— 两种情况都不回滚、不删影子库、不发 error 事件。 ──
        try {
          await audit(
            db,
            c,
            {
              action: 'project.create',
              actorKind: 'user',
              actorId: u.id,
              targetKind: 'project',
              targetId: project.id,
              projectId: project.id,
              data: {
                name: project.name,
                slug,
                groupId: g.id,
                content: kind,
                schemas: scope,
                environments: envRows.map((e) => e.name),
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
                projectId: project.id,
                data: { projectId: project.id, name: e.name },
              },
              ctx.security,
            );
        } catch (e) {
          console.error('新建项目向导：写审计失败（项目已经建好）', e);
        }

        await send({ stage: 'done', project });
      } catch (e) {
        if (committed) {
          // 提交之后的意外（理论上只有发放进度）：项目已经建好，不回滚、不删影子库、不发 error
          console.error('新建项目向导：提交之后的步骤失败', e);
          await send({ stage: 'done', project });
          return;
        }
        // 提交之前失败：这次新建的影子库一并清理
        if (createdShadow)
          await dropSameInstanceShadow(createdShadow.targetUrl, createdShadow.name, ctx.guard);
        // 进度事件会发给客户端：预期的错误（校验、影子库、范围、密钥）给原因，先脱敏；
        // 意外错误（平台库约束冲突、代码错误）只记日志，和全局 onError 一样只告诉客户端“服务器内部错误”
        const expected =
          e instanceof HTTPException ||
          e instanceof ShadowError ||
          e instanceof ScopeError ||
          e instanceof SecretError;
        if (!expected) console.error('新建项目向导：提交之前失败', e);
        const message = expected ? e.message : '服务器内部错误';
        await send({ stage, error: message });
      } finally {
        await shadow?.close();
      }
    });
  });
};
