// 环境执行（P4b H3 / H4 / H7）：通过 HTTP 接口执行 / 回滚、环境状态与历史、漂移检查（手动 + 定时）、
// 生产确认、执行过的版本不能再编辑（409）、并发、错误脱敏。平台库在 SQLite 和 PostgreSQL 上各跑一遍；
// 目标库 / 影子库用测试 PG（Testcontainers 或 DOWEL_TEST_PG），没有 Docker 时跳过。
import type {
  DriftCheckResponse,
  DryRunResponse,
  EnvHistory,
  EnvInfo,
  EnvStatus,
  ExecEvent,
  MarkDryRunResponse,
  MarkResult,
  ProjectActivity,
  ProjectCreated,
  VersionDetail,
  VersionInfo,
  WizardEvent,
} from '@dowel/api';
import { addColumn, addIndex, addUnique, all, type Model, newId, plan } from '@dowel/core';
import { stepsChecksum, toScriptSteps } from '@dowel/engines';
import type { TargetState } from '@dowel/executor';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { versionExecutedAnywhere } from '../src/chain.ts';
import { type EnvRow, syncEnvCache } from '../src/envs.ts';
import { checkEnvDrift, runExecution, runMark } from '../src/executions.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { addTable, editModel, makeUser, PASSWORD, recordVerifiedOnEnvs } from './support.ts';

process.env.DOWEL_SECRET ??= 'executions-test-secret-0123456789';

const tableOf = (m: Model, name = 'orders') => all(m, 'table').find((t) => t.name === name)!.id;
const addNote = (m: Model, name = 'note') => void addColumn(m, tableOf(m), { name, type: 'text' });

interface Body extends Record<string, unknown> {
  error?: string;
}

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('环境执行（平台库：$platform）', ({ platform, skip }) => {
  let platformDb: Awaited<ReturnType<typeof createTestDb>> | undefined;
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let admin = '';
  let pa = '';
  let editor = '';
  let viewer = '';
  let groupId = '';
  const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];

  const call = async (method: string, path: string, json?: unknown, cookie = admin) => {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await created.app.request(path, {
      method,
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown = text;
    let events: ExecEvent[] = [];
    if (res.headers.get('content-type')?.includes('text/event-stream'))
      events = text
        .split('\n\n')
        .filter((x) => x.trim())
        .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as ExecEvent);
    else
      try {
        data = JSON.parse(text);
      } catch {}
    return { status: res.status, data: data as Body, events, text };
  };

  const login = async (username: string) => {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status, username).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  let paId = '';
  let editorId = '';
  let viewerId = '';

  /** 新项目 + 一个环境（指向新建的目标库）；返回项目、环境 ID 和目标库 */
  const newProject = async (name: string, env: { production?: boolean; name?: string } = {}) => {
    const p = await call('POST', '/api/projects', { name, groupId });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    for (const [user, role] of [
      [paId, 'admin'],
      [editorId, 'editor'],
      [viewerId, 'viewer'],
    ] as const)
      expect(
        (await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: user, role }))
          .status,
      ).toBe(201);
    const target = await createTestDb('exec_srv');
    targets.push(target);
    const e = await call('POST', `/api/projects/${pid}/environments`, {
      name: env.name ?? 'dev',
      url: target.url,
      production: env.production ?? false,
      // 生产环境默认不在同一实例上建影子库：测试里明确允许
      allowSameInstance: true,
    });
    expect(e.status).toBe(201);
    return { pid, eid: e.data.id as string, target };
  };

  const publish = async (pid: string, name: string) => {
    const r = await call('POST', `/api/projects/${pid}/versions`, { name });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    expect(r.data.verified, '版本需要在影子库里验证通过').toBe(true);
    return r.data as unknown as { id: string; number: number };
  };

  /** 发布 n 个版本：v1 建 orders，之后每个版本加一列 */
  const publishChain = async (pid: string, n: number) => {
    const out: { id: string; number: number }[] = [];
    for (let i = 1; i <= n; i++) {
      if (i === 1) await addTable(created.rooms, db, pid);
      else await editModel(created.rooms, db, pid, (m) => addNote(m, `c${i}`));
      out.push(await publish(pid, `v${i}`));
    }
    return out;
  };

  const exec = (
    pid: string,
    eid: string,
    action: 'execute' | 'rollback',
    to: string,
    extra = {},
    ck = admin,
  ) => call('POST', `/api/projects/${pid}/environments/${eid}/${action}`, { to, ...extra }, ck);
  const status = async (pid: string, eid: string, ck = admin) =>
    (await call('GET', `/api/projects/${pid}/environments/${eid}/status`, undefined, ck))
      .data as unknown as EnvStatus;
  const history = async (pid: string, eid: string) =>
    (await call('GET', `/api/projects/${pid}/environments/${eid}/history`)).data as unknown as EnvHistory;
  const columnsOf = async (t: { db: { query: <T>(q: string) => Promise<T[]> } }) =>
    (
      await t.db.query<{ c: string }>(
        `select column_name::text as c from information_schema.columns where table_schema = 'public' and table_name = 'orders' order by ordinal_position`,
      )
    ).map((r) => r.c);
  const last = (events: ExecEvent[]) => events.at(-1)!;

  beforeAll(async () => {
    if (skip) return;
    if (platform === 'pg') platformDb = await createTestDb('exec_platform');
    db = await openPlatformDb(platformDb?.url ?? ':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      // 历史和漂移检查共用连接限速（每人每分钟 10 次）：测试里放宽
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    paId = (await makeUser(db, 'pa', { name: '项目管理员' })).id;
    editorId = (await makeUser(db, 'editor', { name: '编辑者' })).id;
    viewerId = (await makeUser(db, 'viewer', { name: '查看者' })).id;
    admin = await login('admin');
    pa = await login('pa');
    editor = await login('editor');
    viewer = await login('viewer');
    const g = await call('POST', '/api/groups', { slug: 'g', name: '组' });
    expect(g.status).toBe(201);
    groupId = g.data.id as string;
  });

  afterAll(async () => {
    if (skip) return;
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    await platformDb?.close();
    const adminConn = connect(PG_URL);
    for (const t of targets) {
      await adminConn.db.exec(
        `DROP DATABASE IF EXISTS ${new URL(t.url).pathname.slice(1)}_dowel WITH (FORCE)`,
      );
      await t.close();
    }
    await adminConn.close();
  });

  test.skipIf(skip || !PG_URL)(
    '执行 v1→v3、状态与历史、回滚到 v1；执行过的版本不能再编辑（409）',
    async () => {
      const { pid, eid, target } = await newProject('flow');
      const [v1, v2, v3] = await publishChain(pid, 3);

      // 执行前：当前版本为空，三个版本都待执行
      let st = await status(pid, eid);
      expect(st.currentVersion).toBeNull();
      expect(st.pending).toEqual([v1!.id, v2!.id, v3!.id]);
      expect(st.versions.map((v) => [v.number, v.state, v.verified, v.executedHere])).toEqual([
        [1, 'pending', true, false],
        [2, 'pending', true, false],
        [3, 'pending', true, false],
      ]);
      // 没执行过的最新版本可以编辑（内容不变，只验证“没被执行记录挡住”）
      const d3 = (await call('GET', `/api/projects/${pid}/versions/${v3!.id}`))
        .data as unknown as VersionDetail;
      expect(
        (
          await call('PATCH', `/api/projects/${pid}/versions/${v3!.id}/steps`, {
            up: d3.upSteps,
            down: d3.downSteps,
          })
        ).status,
      ).toBe(200);

      const r = await exec(pid, eid, 'execute', v3!.id);
      expect(r.status).toBe(200);
      expect(r.events.map((e) => e.stage)).toContain('plan');
      expect(r.events.find((e) => e.stage === 'plan')!.migrations!.map((m) => m.number)).toEqual([1, 2, 3]);
      const done = last(r.events);
      expect(done).toMatchObject({ stage: 'done', ran: 3, current: { id: v3!.id, number: 3 } });
      expect(r.events.some((e) => e.error)).toBe(false);
      expect(await columnsOf(target)).toEqual(['id', 'c2', 'c3']);

      // 状态（平台库缓存）：当前版本 v3，没有待执行；每个版本在这个环境上执行过
      st = await status(pid, eid);
      expect(st.currentVersion?.number).toBe(3);
      expect(st.pending).toEqual([]);
      expect(st.versions.map((v) => [v.state, v.executedHere])).toEqual([
        ['applied', true],
        ['applied', true],
        ['current', true],
      ]);
      expect(st.drift.status).toBe('ok');
      const envs = (await call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
      expect(envs[0]).toMatchObject({ currentVersion: { number: 3 }, drift: { status: 'ok' } });
      expect(envs[0]!.permissions).toEqual({
        execute: true,
        configure: true,
        unmarkProduction: true,
        approvalRequired: false,
        request: true,
        emergency: false,
      });

      // 历史：读目标库的 dowel.history
      const h = await history(pid, eid);
      expect(h.initialized).toBe(true);
      expect(h.currentVersion?.number).toBe(3);
      expect(h.runs.map((x) => [x.toVersion.number, x.direction, x.status])).toEqual([
        [3, 'up', 'done'],
        [2, 'up', 'done'],
        [1, 'up', 'done'],
      ]);
      expect(h.runs[0]!.executedBy).toBeTruthy();

      // 执行过的版本不能再编辑：用平台库里的执行记录判断，409
      const patch = await call('PATCH', `/api/projects/${pid}/versions/${v3!.id}/steps`, {
        up: d3.upSteps,
        down: d3.downSteps,
      });
      expect(patch.status).toBe(409);
      expect(patch.data.error).toContain('已经在环境上执行过');

      // 审计：执行写一条，带环境名、起止版本和执行的迁移
      const audits = await db.query<{
        action: string;
        data: { ok: boolean; ran?: unknown[]; production: boolean };
      }>(
        "select action, data from audit_events where action like 'environment.%' and project_id = $1 order by at",
        [pid],
      );
      expect(audits.filter((a) => a.action === 'environment.execute').at(-1)!.data).toMatchObject({
        ok: true,
        production: false,
        ran: [{ number: 1 }, { number: 2 }, { number: 3 }],
      });

      // “执行”接口不能用来回滚；回滚到 v1
      expect(last((await exec(pid, eid, 'execute', v1!.id)).events).code).toBe('wrong_direction');
      const back = await exec(pid, eid, 'rollback', v1!.id);
      expect(last(back.events)).toMatchObject({ stage: 'done', ran: 2, current: { number: 1 } });
      expect(await columnsOf(target)).toEqual(['id']);
      st = await status(pid, eid);
      expect(st.currentVersion?.number).toBe(1);
      expect(st.pending).toEqual([v2!.id, v3!.id]);
      // 回滚后版本仍然算“执行过”：目标库历史里记着它们的校验和
      expect(st.versions.every((v) => v.executedHere)).toBe(true);
      expect((await call('GET', `/api/projects/${pid}/versions`)).data).toBeTruthy();
      const versions = (await call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[];
      expect(versions[0]!.number).toBe(3);
      expect(
        (
          await call('PATCH', `/api/projects/${pid}/versions/${v3!.id}/steps`, {
            up: d3.upSteps,
            down: d3.downSteps,
          })
        ).status,
      ).toBe(409);
    },
  );

  test.skipIf(skip || !PG_URL)(
    '生产环境：默认只有项目管理员能执行，必须输入环境名确认（服务端校验）',
    async () => {
      const { pid, eid } = await newProject('prod-confirm', { production: true, name: 'prod' });
      const [v1] = await publishChain(pid, 1);
      // 编辑者：生产环境默认档位是项目管理员 → 403
      const denied = await exec(pid, eid, 'execute', v1!.id, { confirm: 'prod' }, editor);
      expect(denied.status).toBe(403);
      expect(denied.data.error).toContain('项目管理员');
      expect((await status(pid, eid, editor)).permissions.execute).toBe(false);
      // 项目管理员：没填 / 填错环境名 → 422，什么都没执行
      for (const confirm of [undefined, '', 'dev', 'PROD']) {
        const r = await exec(pid, eid, 'execute', v1!.id, confirm === undefined ? {} : { confirm }, pa);
        expect(r.status, String(confirm)).toBe(422);
        expect(r.data.error).toContain('prod');
      }
      expect((await status(pid, eid)).currentVersion).toBeNull();
      const ok = await exec(pid, eid, 'execute', v1!.id, { confirm: 'prod' }, pa);
      expect(last(ok.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
      // 回滚同样要确认
      expect((await exec(pid, eid, 'rollback', v1!.id, {}, pa)).status).toBe(422);
    },
  );

  test.skipIf(skip || !PG_URL)('漂移：手动检查写进缓存，拦住执行；还原后恢复', async () => {
    const { pid, eid, target } = await newProject('drift');
    const [v1, v2] = await publishChain(pid, 2);
    expect(last((await exec(pid, eid, 'execute', v1!.id)).events).stage).toBe('done');
    // 没有漂移
    let d = (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
      .data as unknown as DriftCheckResponse;
    expect(d).toMatchObject({ status: 'ok', skipped: null });
    expect(d.checkedAt).toBeTruthy();

    await target.db.exec('ALTER TABLE public.orders ADD COLUMN sneaky int');
    d = (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
      .data as unknown as DriftCheckResponse;
    expect(d.status).toBe('drifted');
    expect(d.summary!.versionNumber).toBe(1);
    expect(d.summary!.total).toBeGreaterThan(0);
    expect(d.summary!.items.some((i) => i.sql.includes('sneaky'))).toBe(true);
    // 缓存：环境列表和状态里都能看到（图标栏、概览的警告用它）
    const envs = (await call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
    expect(envs[0]!.drift.status).toBe('drifted');
    expect((await status(pid, eid)).drift.summary!.items.length).toBeGreaterThan(0);

    // 执行被拦住，错误事件带差异
    const blocked = await exec(pid, eid, 'execute', v2!.id);
    expect(last(blocked.events)).toMatchObject({ stage: 'drift', code: 'drift' });
    expect(last(blocked.events).details!.diff!.some((i) => i.sql.includes('sneaky'))).toBe(true);
    expect((await status(pid, eid)).currentVersion?.number).toBe(1);

    // 查看者不能手动检查（要连生产库）
    expect(
      (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`, undefined, viewer)).status,
    ).toBe(403);

    await target.db.exec('ALTER TABLE public.orders DROP COLUMN sneaky');
    d = (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
      .data as unknown as DriftCheckResponse;
    expect(d.status).toBe('ok');
    expect(last((await exec(pid, eid, 'execute', v2!.id)).events).stage).toBe('done');
  });

  test.skipIf(skip || !PG_URL)('并发：同一个环境同时执行两次，只真正执行一次', async () => {
    const { pid, eid } = await newProject('concurrent');
    const [, , v3] = await publishChain(pid, 3);
    const [a, b] = await Promise.all([exec(pid, eid, 'execute', v3!.id), exec(pid, eid, 'execute', v3!.id)]);
    const results = [last(a.events), last(b.events)];
    expect(results.every((e) => e.stage === 'done')).toBe(true);
    expect(results.map((e) => e.ran).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([0, 3]); // 一个执行了 3 个迁移，另一个等到之后什么都没做
    const h = await history(pid, eid);
    expect(h.runs.filter((r) => r.status === 'done').length).toBe(3);
    expect(h.runs.length).toBe(3);
  });

  test.skipIf(skip || !PG_URL)('干净回滚的失败不算“执行过”（还能修脚本）；修好数据后重试成功', async () => {
    const { pid, eid, target } = await newProject('fail-retry');
    await editModel(created.rooms, db, pid, () => {});
    await addTable(created.rooms, db, pid);
    await editModel(created.rooms, db, pid, (m) => addNote(m, 'email'));
    const v1 = await publish(pid, 'v1');
    await editModel(
      created.rooms,
      db,
      pid,
      (m) => void addUnique(m, tableOf(m), [all(m, 'column').find((c) => c.name === 'email')!.id]),
    );
    const v2 = await publish(pid, 'v2');
    expect(last((await exec(pid, eid, 'execute', v1.id)).events).stage).toBe('done');
    await target.db.exec(`insert into public.orders (id, email) values (1, 'a@x.com'), (2, 'a@x.com')`);
    const r = await exec(pid, eid, 'execute', v2.id);
    expect(last(r.events)).toMatchObject({ code: 'step_failed', details: { number: 2, partial: false } });
    const st = await status(pid, eid);
    expect(st.currentVersion?.number).toBe(1);
    // v2 的事务整体回滚：目标库里没留下任何东西，平台库的登记被清掉，还能改脚本
    expect(st.versions.find((v) => v.id === v2.id)!.executedHere).toBe(false);
    const d2 = (await call('GET', `/api/projects/${pid}/versions/${v2.id}`)).data as unknown as VersionDetail;
    expect(
      (
        await call('PATCH', `/api/projects/${pid}/versions/${v2.id}/steps`, {
          up: d2.upSteps,
          down: d2.downSteps,
        })
      ).status,
    ).toBe(200);
    // 历史里有一条失败记录，当前版本还是 v1
    const h = await history(pid, eid);
    expect(h.runs[0]).toMatchObject({ status: 'failed', direction: 'up' });
    expect(h.runs[0]!.error).toContain('步执行失败');
    // 修好数据，重试
    await target.db.exec('delete from public.orders where id = 2');
    expect(last((await exec(pid, eid, 'execute', v2.id)).events)).toMatchObject({
      stage: 'done',
      current: { number: 2 },
    });
  });

  test.skipIf(skip)('连不上目标库：error 事件只给原因，不含连接串里的密码', async () => {
    const p = await call('POST', '/api/projects', { name: 'unreachable', groupId });
    const pid = p.data.id as string;
    await addTable(created.rooms, db, pid);
    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    await db.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum, verified_at)
       values ('unreach-v1', $1, $2, 1, 'v1', $3::text::jsonb, 1, '[]'::text::jsonb, '[]'::text::jsonb, $4, $5)`,
      [
        pid,
        b!.id,
        JSON.stringify((await created.rooms.model(b!.id)).model),
        stepsChecksum([], []),
        new Date().toISOString(),
      ],
    );
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production) values ('unreach-env', $1, 'dev', $2, false)`,
      [pid, encrypt('postgres://app:s3cr3tpw@127.0.0.1:1/shop')],
    );
    const r = await exec(pid, 'unreach-env', 'execute', 'unreach-v1');
    expect(r.status).toBe(200);
    expect(last(r.events).error).toBeTruthy();
    expect(last(r.events).code).toBe('connect');
    expect(r.text).not.toContain('s3cr3tpw');
    const d = (await call('POST', `/api/projects/${pid}/environments/unreach-env/drift-check`))
      .data as unknown as DriftCheckResponse;
    expect(d.status).toBe('error');
    expect(JSON.stringify(d)).not.toContain('s3cr3tpw');
    const h = await call('GET', `/api/projects/${pid}/environments/unreach-env/history`);
    expect(h.status).toBe(422);
    expect(JSON.stringify(h.data)).not.toContain('s3cr3tpw');
  });

  test.skipIf(skip || !PG_URL)(
    '首次执行命中基线：单独入口已移除，直接执行到 v0 报 mark_required，执行 v1 时先写基线再升级',
    async () => {
      const src = await createTestDb('exec_import');
      targets.push(src);
      await src.db.exec(
        'create table public.legacy (id int primary key, name text); insert into public.legacy values (1, $$keep$$)',
      );
      const w = await created.app.request('/api/projects/wizard', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: admin },
        body: JSON.stringify({
          groupId,
          name: 'imported',
          environments: [{ name: 'dev', url: src.url, production: false, allowSameInstance: true }],
          content: { kind: 'database', env: 'dev' },
        }),
      });
      const events = (await w.text())
        .split('\n\n')
        .filter((x) => x.trim())
        .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as WizardEvent);
      const project = events.at(-1)!.project as ProjectCreated;
      expect(project, JSON.stringify(events)).toBeTruthy();
      const pid = project.id;
      const [env] = (await call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
      // 没有历史时的漂移检查：结构等于基线 → ok
      const d = (await call('POST', `/api/projects/${pid}/environments/${env!.id}/drift-check`))
        .data as unknown as DriftCheckResponse;
      expect(d.status).toBe('ok');
      const v0 = ((await call('GET', `/api/projects/${pid}/versions`)).data as unknown as VersionInfo[]).at(
        -1,
      )!;
      expect(v0.number).toBe(0);

      // 单独的 /baseline 接口已移除
      expect((await call('POST', `/api/projects/${pid}/environments/${env!.id}/baseline`, {})).status).toBe(
        404,
      );

      // 库结构已等于 v0 且没有后续迁移：预演与执行 v0 均以 mark_required 拒绝（不建 dowel 历史，不锁定 v0）
      const dryV0 = (await exec(pid, env!.id, 'execute', v0.id, { dryRun: true }))
        .data as unknown as DryRunResponse;
      expect(dryV0).toMatchObject({ ok: false, code: 'mark_required' });
      expect(last((await exec(pid, env!.id, 'execute', v0.id)).events).code).toBe('mark_required');
      expect(await src.db.query("select 1 from pg_namespace where nspname = 'dowel'")).toEqual([]);
      const d0Before = (await call('GET', `/api/projects/${pid}/versions/${v0.id}`))
        .data as unknown as VersionDetail;
      expect(
        (
          await call('PATCH', `/api/projects/${pid}/versions/${v0.id}/steps`, {
            up: d0Before.upSteps,
            down: d0Before.downSteps,
          })
        ).status,
      ).toBe(200);

      // 发布 v1（给 legacy 表新增列）并执行到 v1：自动先写 v0 基线再跑 v1 迁移
      await editModel(created.rooms, db, pid, (m) => {
        addColumn(m, tableOf(m, 'legacy'), { name: 'note', type: 'text' });
      });
      const v1 = await publish(pid, 'v1');
      const r = await exec(pid, env!.id, 'execute', v1.id);
      expect(last(r.events)).toMatchObject({ stage: 'done', current: { number: 1 } });
      expect(r.events.find((e) => e.stage === 'plan')).toMatchObject({ baseline: true });
      const h = await history(pid, env!.id);
      expect(h.runs.map((x) => [x.direction, x.status])).toEqual([
        ['up', 'done'],
        ['baseline', 'done'],
      ]);
      expect((await src.db.query<{ name: string }>('select name from public.legacy'))[0]!.name).toBe('keep');
      // v0 已经写进目标库历史：不能再编辑它的脚本
      const d0 = (await call('GET', `/api/projects/${pid}/versions/${v0.id}`))
        .data as unknown as VersionDetail;
      expect(
        (
          await call('PATCH', `/api/projects/${pid}/versions/${v0.id}/steps`, {
            up: d0.upSteps,
            down: d0.downSteps,
          })
        ).status,
      ).toBe(409);
    },
  );

  test.skipIf(skip || !PG_URL)('定时漂移检查：runOnce 逐个环境检查并写进缓存；间隔可配、可关', async () => {
    const { pid, eid, target } = await newProject('scheduler');
    const [v1] = await publishChain(pid, 1);
    await exec(pid, eid, 'execute', v1!.id);
    expect(created.drift.started).toBe(false); // 测试里默认不启动
    expect(await created.drift.runOnce()).toBeGreaterThanOrEqual(1);
    expect((await status(pid, eid)).drift.status).toBe('ok');
    await target.db.exec('ALTER TABLE public.orders ADD COLUMN sneaky int');
    await created.drift.runOnce();
    expect((await status(pid, eid)).drift).toMatchObject({ status: 'drifted' });
    created.drift.start(0); // 0 = 关闭
    expect(created.drift.started).toBe(false);
    created.drift.start(50); // 调短间隔
    expect(created.drift.started).toBe(true);
    created.drift.stop();
    expect(created.drift.started).toBe(false);
  });

  test.skipIf(skip)('同步缓存完全对齐目标库历史；“执行过”记在版本上，永久；claimed 残留被清掉', async () => {
    const p = await call('POST', '/api/projects', { name: 'sync-cache', groupId });
    const pid = p.data.id as string;
    await addTable(created.rooms, db, pid);
    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    for (const n of [1, 2])
      await db.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
         values ($1, $2, $3, $4, 'v', '{"format":1,"dialect":"pg","objects":{}}'::text::jsonb, $5, '[]'::text::jsonb, '[]'::text::jsonb, 'x')`,
        [`sc-v${n}`, pid, b!.id, n, n],
      );
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production) values ('sc-env', $1, 'dev', $2, false)`,
      [pid, encrypt('postgres://u:p@127.0.0.1:1/x')],
    );
    const run = (over: Partial<TargetState>): TargetState => ({
      historyExists: true,
      current: null,
      versions: [],
      runs: [],
      project: null,
      claims: [],
      unfinished: null,
      readbackFailure: null,
      ...over,
    });
    const inHistory = (...ids: string[]) =>
      ids.map((versionId) => ({ versionId })) as unknown as TargetState['versions'];
    const rows = async () =>
      (
        await db.query<{ version_id: string; state: string }>(
          "select version_id, state from environment_versions where environment_id = 'sc-env' order by version_id",
        )
      ).map((r) => `${r.version_id}:${r.state}`);
    const executedAt = async (id: string) =>
      (await db.query<{ executed_at: unknown }>('select executed_at from versions where id = $1', [id]))[0]!
        .executed_at;
    const frozen = (id: string) => versionExecutedAnywhere(db, id);

    // 进程崩溃留下的 claimed 残留：执行进行中的登记会挡住编辑……
    await db.query(
      "insert into environment_versions (environment_id, version_id, state) values ('sc-env', 'sc-v1', 'claimed')",
    );
    expect(await frozen('sc-v1')).toBe(true);
    // ……在目标库项目锁里的同步（此时不可能有执行在进行）把它清掉：v1 又可以编辑了
    await syncEnvCache(db, 'sc-env', run({}));
    expect(await rows()).toEqual([]);
    expect(await executedAt('sc-v1')).toBeNull();
    expect(await frozen('sc-v1')).toBe(false);

    // 目标库历史里有 v1：confirmed，并永久写下 executed_at
    await syncEnvCache(db, 'sc-env', run({ versions: inHistory('sc-v1'), current: 'sc-v1' }));
    expect(await rows()).toEqual(['sc-v1:confirmed']);
    const at = await executedAt('sc-v1');
    expect(at).not.toBeNull();
    expect(await frozen('sc-v1')).toBe(true);

    // v2 的升级停在中途：算执行过；回滚停在中途时被回滚的是 fromVersion。镜像对齐：历史里没有 v1 了 → 镜像里删掉 v1，
    // 但 v1 的 executed_at 还在，仍然不能编辑
    const unfinished = {
      direction: 'up',
      fromVersion: 'sc-v1',
      toVersion: 'sc-v2',
      stepIndex: 0,
      status: 'failed',
      error: null,
    } as TargetState['unfinished'];
    // 同步看全部执行记录里碰过目标库的（这里是一条做了一部分的失败记录）
    await syncEnvCache(db, 'sc-env', run({ unfinished, runs: [unfinished!] }));
    expect(await rows()).toEqual(['sc-v2:confirmed']);
    expect(await frozen('sc-v1')).toBe(true);
    expect(await frozen('sc-v2')).toBe(true);
    const down = { ...unfinished!, direction: 'down' as const };
    await syncEnvCache(db, 'sc-env', run({ unfinished: down, runs: [down] }));
    expect(await rows()).toEqual(['sc-v1:confirmed']);
    expect(String(await executedAt('sc-v1'))).toBe(String(at)); // 只写一次，不改

    // status=running 且 stepIndex=null 的非 mark 迁移同样算碰过（保护运行中版本不被作废）
    await db.query(
      "update environment_versions set state = 'claimed' where environment_id = 'sc-env' and version_id = 'sc-v2'",
    );
    await syncEnvCache(
      db,
      'sc-env',
      run({
        unfinished: null,
        runs: [down, { ...unfinished!, status: 'running', stepIndex: null, direction: 'up' }],
      }),
    );
    expect(await rows()).toEqual(['sc-v1:confirmed', 'sc-v2:confirmed']);

    // 而 status=running 且 stepIndex=null 的 mark 记录不算碰过，同步会清理残留 claimed
    await db.query(
      "update environment_versions set state = 'claimed' where environment_id = 'sc-env' and version_id = 'sc-v2'",
    );
    await syncEnvCache(
      db,
      'sc-env',
      run({
        unfinished: null,
        runs: [down, { ...unfinished!, status: 'running', stepIndex: null, direction: 'mark' }],
      }),
    );
    expect(await rows()).toEqual(['sc-v1:confirmed']);

    // 换了连接串 / 目标库被清空：镜像清空，缓存的当前版本回到空；版本仍然不能编辑
    await db.query("update environments set current_version_id = 'sc-v2' where id = 'sc-env'");
    await syncEnvCache(db, 'sc-env', run({ historyExists: false }));
    expect(await rows()).toEqual([]);
    expect(
      (
        await db.query<{ c: string | null }>(
          "select current_version_id as c from environments where id = 'sc-env'",
        )
      )[0]!.c,
    ).toBeNull();
    expect(await frozen('sc-v1')).toBe(true);
    expect(await frozen('sc-v2')).toBe(true);

    // 删除环境：版本上的 executed_at 还在，仍然不能编辑
    await db.query("delete from environments where id = 'sc-env'");
    expect(await frozen('sc-v1')).toBe(true);
    expect(await frozen('sc-v2')).toBe(true);
  });

  test.skipIf(skip)('同步只写需要变化的行：已经对齐时第二次同步没有任何写入', async () => {
    const p = await call('POST', '/api/projects', { name: 'sync-writes', groupId });
    const pid = p.data.id as string;
    await addTable(created.rooms, db, pid);
    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    for (const n of [1, 2, 3])
      await db.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum)
         values ($1, $2, $3, $4, 'v', '{"format":1,"dialect":"pg","objects":{}}'::text::jsonb, $5, '[]'::text::jsonb, '[]'::text::jsonb, 'x')`,
        [`sw-v${n}`, pid, b!.id, n, n],
      );
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production) values ('sw-env', $1, 'dev', $2, false)`,
      [pid, encrypt('postgres://u:p@127.0.0.1:1/x')],
    );
    let writes = 0;
    const counting = {
      query: async (q: string, params?: unknown[]) => {
        if (/^\s*(insert|update|delete)\b/i.test(q)) writes++;
        return db.query(q, params);
      },
      exec: async (q: string) => db.exec(q),
    };
    const state = {
      historyExists: true,
      current: 'sw-v3',
      versions: ['sw-v1', 'sw-v2', 'sw-v3'].map((versionId) => ({ versionId })),
      runs: [],
      project: null,
      unfinished: null,
      readbackFailure: null,
    } as unknown as TargetState;
    await syncEnvCache(counting as never, 'sw-env', state);
    expect(writes).toBeGreaterThan(0);
    writes = 0;
    await syncEnvCache(counting as never, 'sw-env', state);
    expect(writes).toBe(0);
  });

  test.skipIf(skip || !PG_URL)(
    '执行账号没有建 schema 的权限：ensureHistory 失败，目标库没动，v1 仍然可以编辑',
    async () => {
      const { pid, eid, target } = await newProject('no-create');
      const [v1] = await publishChain(pid, 1);
      const role = `exec_noc_${Math.random().toString(36).slice(2, 8)}`;
      const adminConn = connect(PG_URL);
      try {
        await adminConn.db.exec(`create role ${role} login password 'pw'`);
        const u = new URL(target.url);
        u.username = role;
        u.password = 'pw';
        const patched = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, {
          url: u.toString(),
        });
        expect(patched.status, JSON.stringify(patched.data)).toBe(200);
        const r = await exec(pid, eid, 'execute', v1!.id);
        expect(last(r.events).code).toBe('no_schema_privilege');
        // 什么都没动：没有 dowel schema，登记被撤销，版本没有执行过，还能改脚本
        expect(
          (await target.db.query<{ n: string | null }>("select to_regnamespace('dowel')::text as n"))[0]!.n,
        ).toBeNull();
        expect((await status(pid, eid)).versions[0]!.executedHere).toBe(false);
        const d1 = (await call('GET', `/api/projects/${pid}/versions/${v1!.id}`))
          .data as unknown as VersionDetail;
        expect(
          (
            await call('PATCH', `/api/projects/${pid}/versions/${v1!.id}/steps`, {
              up: d1.upSteps,
              down: d1.downSteps,
            })
          ).status,
        ).toBe(200);
      } finally {
        await adminConn.db.exec(`drop role if exists ${role}`).catch(() => {});
        await adminConn.close();
      }
    },
  );

  test.skipIf(skip || !PG_URL)('平台库同步失败只记日志，历史照常返回（不被当成目标库的错误）', async () => {
    const { pid, eid } = await newProject('sync-fail');
    const [v1] = await publishChain(pid, 1);
    expect(last((await exec(pid, eid, 'execute', v1!.id)).events).stage).toBe('done');
    // 把平台库里同步要读写的表改名，让 syncEnvCache 出错
    await db.exec('alter table environment_versions rename to environment_versions_tmp');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await call('GET', `/api/projects/${pid}/environments/${eid}/history`);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      const h = r.data as unknown as EnvHistory;
      expect(h.runs.map((x) => x.status)).toEqual(['done']);
      expect(h.currentVersion?.number).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await db.exec('alter table environment_versions_tmp rename to environment_versions');
    }
  });

  test.skipIf(skip || !PG_URL)(
    '执行过的版本永远不能编辑：换连接串到空库、读历史、删除环境之后都一样（409）',
    async () => {
      const { pid, eid } = await newProject('frozen-forever');
      const [v1] = await publishChain(pid, 1);
      expect(last((await exec(pid, eid, 'execute', v1!.id)).events).stage).toBe('done');
      const d1 = (await call('GET', `/api/projects/${pid}/versions/${v1!.id}`))
        .data as unknown as VersionDetail;
      const edit = () =>
        call('PATCH', `/api/projects/${pid}/versions/${v1!.id}/steps`, {
          up: d1.upSteps,
          down: d1.downSteps,
        });
      expect((await edit()).status).toBe(409);

      // 换连接串到一个空库
      const empty = await createTestDb('exec_empty');
      targets.push(empty);
      const patched = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { url: empty.url });
      expect(patched.status, JSON.stringify(patched.data)).toBe(200);
      expect((await status(pid, eid)).currentVersion).toBeNull(); // 缓存的当前版本作废
      // 读历史（目标库是空的，同步不会撤销任何东西）
      const h = await history(pid, eid);
      expect(h.initialized).toBe(false);
      expect((await edit()).status).toBe(409);
      // 环境上的镜像已经对齐到（空的）目标库：executedHere 是准确的；但版本“执行过”的事实永久保留，仍然不能编辑
      expect((await status(pid, eid)).versions[0]!.executedHere).toBe(false);
      expect((await edit()).status).toBe(409);

      // 删除环境之后仍然不能编辑
      expect((await call('DELETE', `/api/projects/${pid}/environments/${eid}`)).status).toBe(200);
      expect((await edit()).status).toBe(409);
    },
  );

  test.skipIf(skip)('解密失败 / 连接串写错：环境锁不会泄漏，下一次执行立即拿到锁', async () => {
    const p = await call('POST', '/api/projects', { name: 'lock-leak', groupId });
    const pid = p.data.id as string;
    await addTable(created.rooms, db, pid);
    const [b] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [pid],
    );
    await db.query(
      `insert into versions (id, project_id, branch_id, seq, name, model, number, up_steps, down_steps, checksum, verified_at)
       values ('leak-v1', $1, $2, 1, 'v1', $3::text::jsonb, 1, '[]'::text::jsonb, '[]'::text::jsonb, $4, $5)`,
      [
        pid,
        b!.id,
        JSON.stringify((await created.rooms.model(b!.id)).model),
        stepsChecksum([], []),
        new Date().toISOString(),
      ],
    );
    for (const [id, enc] of [
      ['leak-bad-cipher', 'garbage'],
      ['leak-bad-url', encrypt('postgres://u:p@[bad/db')],
    ] as const)
      await db.query(
        `insert into environments (id, project_id, name, url_enc, production) values ($1, $2, $1, $3, false)`,
        [id, pid, enc],
      );
    for (const id of ['leak-bad-cipher', 'leak-bad-url'])
      for (const round of [1, 2, 3]) {
        const t0 = Date.now();
        const r = await exec(pid, id, 'execute', 'leak-v1');
        expect(r.status).toBe(200);
        expect(last(r.events).error, `${id} #${round}`).toBeTruthy();
        // 不是“环境正在执行另一个操作”的 409 超时：锁每次都释放了（白名单 / 解密的拒绝是另一回事）
        expect(last(r.events).error, `${id} #${round}`).not.toContain('正在执行另一个操作');
        expect(Date.now() - t0, `${id} #${round} 不应该等锁`).toBeLessThan(5_000);
        // 漂移检查也不会一直 busy
        const d = (await call('POST', `/api/projects/${pid}/environments/${id}/drift-check`))
          .data as unknown as DriftCheckResponse;
        expect(d.skipped ?? null).not.toBe('busy');
        // 解密失败记为 error；连接串被白名单拒绝（422）是另一条路径，不写缓存
        if (id === 'leak-bad-cipher') expect(d.status).toBe('error');
      }
  });

  test.skipIf(skip || !PG_URL)(
    '漂移检查的错误按真实原因分类：历史与版本链对不上、schema 范围有问题、连不上，各给准确的文案',
    async () => {
      const { pid, eid, target } = await newProject('drift-errors');
      const [v1] = await publishChain(pid, 1);
      expect(last((await exec(pid, eid, 'execute', v1!.id)).events).stage).toBe('done');
      const check = async () =>
        (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
          .data as unknown as DriftCheckResponse;
      expect((await check()).status).toBe('ok');

      // 1. 范围：版本冻结的范围里有跨范围的引用 → 范围错误，不是“连接失败”
      await target.db.exec(
        'create schema app; create table app.x (id int); alter table public.orders add primary key (id); alter table app.x add foreign key (id) references public.orders (id)',
      );
      await db.query('update versions set scope = $2::text::jsonb where id = $1', [
        v1!.id,
        JSON.stringify(['app']),
      ]);
      let d = await check();
      expect(d).toMatchObject({ status: 'error', summary: { errorKind: 'scope' } });
      expect(d.summary!.message).toContain('schema 范围');
      expect(d.summary!.message).not.toContain('连接目标库失败');
      await db.query('update versions set scope = null where id = $1', [v1!.id]);
      await target.db.exec('drop schema app cascade; alter table public.orders drop constraint orders_pkey');
      expect((await check()).status).toBe('ok');

      // 2. 完整性：目标库历史里的当前版本不在平台的版本链上
      await target.db.exec(
        "alter table dowel.history disable trigger history_guard; update dowel.history set to_version = 'ghost'; alter table dowel.history enable trigger history_guard",
      );
      d = await check();
      expect(d).toMatchObject({ status: 'error', summary: { errorKind: 'integrity' } });
      expect(d.summary!.message).toContain('完整性检查失败');
      expect(d.summary!.message).toContain('不在平台库的版本链上');
      expect(d.summary!.message).not.toContain('连接目标库失败');

      // 3. 连不上：才是“连接目标库失败”
      await db.query('update environments set url_enc = $2 where id = $1', [
        eid,
        encrypt('postgres://u:p@127.0.0.1:1/x'),
      ]);
      d = await check();
      expect(d).toMatchObject({ status: 'error', summary: { errorKind: 'connect' } });
      expect(d.summary!.message).toContain('连接目标库失败');
    },
  );

  test.skipIf(skip || !PG_URL)('历史接口给出执行者的显示名', async () => {
    const { pid, eid } = await newProject('executor-name');
    const [v1] = await publishChain(pid, 1);
    await exec(pid, eid, 'execute', v1!.id);
    const h = await history(pid, eid);
    expect(h.runs[0]!.executedByName).toBe('管理员');
    expect(h.runs[0]!.readbackFailure).toBe(false);
  });

  // ───── 第三轮审查补充 ─────

  /** 把版本的脚本改成指定的（PATCH 会清掉验证状态），再直接标为已验证：测试需要“已验证、但结果不对”的脚本 */
  const forceSteps = async (
    pid: string,
    vid: string,
    up: { sql: string; transactional: boolean }[],
    down: { sql: string; transactional: boolean }[] = [],
  ) => {
    const r = await call('PATCH', `/api/projects/${pid}/versions/${vid}/steps`, { up, down });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    // PATCH 清空了验证记录：按环境的数据库完整版本号补上通过的记录（ADR 0017 决定 5）
    await recordVerifiedOnEnvs(db, pid, [vid]);
  };
  const executedAt = async (vid: string) =>
    (await db.query<{ executed_at: unknown }>('select executed_at from versions where id = $1', [vid]))[0]!
      .executed_at;
  const mirror = async (eid: string, vid: string) =>
    (
      await db.query<{ state: string }>(
        'select state from environment_versions where environment_id = $1 and version_id = $2',
        [eid, vid],
      )
    )[0]?.state ?? null;
  const plant = (eid: string, vid: string) =>
    db.query(
      "insert into environment_versions (environment_id, version_id, state) values ($1, $2, 'claimed')",
      [eid, vid],
    );

  test.skipIf(skip || !PG_URL)(
    'claim 接管崩溃留下的 claimed 残留：执行在 touched 之后失败，executed_at 已写入，不依赖结尾的 syncTarget',
    async () => {
      const { pid, eid, target } = await newProject('adopt');
      await addTable(created.rooms, db, pid);
      await editModel(created.rooms, db, pid, (m) => addNote(m, 'email'));
      const v1 = await publish(pid, 'v1');
      await editModel(created.rooms, db, pid, (m) => {
        const email = all(m, 'column').find((c) => c.name === 'email')!.id;
        addIndex(m, tableOf(m), [{ column: email }], { unique: true });
      });
      const v2 = await publish(pid, 'v2');
      // v2 的升级脚本改成 CREATE UNIQUE INDEX CONCURRENTLY（非事务步骤），重新验证
      const d2 = (await call('GET', `/api/projects/${pid}/versions/${v2.id}`))
        .data as unknown as VersionDetail;
      expect(d2.upSteps).toHaveLength(1);
      const patched = await call('PATCH', `/api/projects/${pid}/versions/${v2.id}/steps`, {
        up: [
          {
            sql: d2.upSteps[0]!.sql.replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX CONCURRENTLY'),
            transactional: false,
          },
        ],
        down: d2.downSteps,
      });
      expect(patched.status).toBe(200);
      const verified = await call('POST', `/api/projects/${pid}/versions/${v2.id}/verify`);
      expect(verified.data.verifiedAt, JSON.stringify(verified.data)).toBeTruthy();

      expect(last((await exec(pid, eid, 'execute', v1.id)).events).stage).toBe('done');
      await target.db.exec("insert into public.orders (id, email) values (1, 'a@x.com'), (2, 'a@x.com')");
      // 进程崩溃留下的 claimed 残留（执行器没跑完、也没人撤销）
      await plant(eid, v2.id);
      expect(await executedAt(v2.id)).toBeNull();

      // 结尾的同步打桩成什么都不做：确认必须在 finally 里完成，不能靠同步
      created.exec.syncTarget = async () => null;
      try {
        const r = await exec(pid, eid, 'execute', v2.id);
        expect(last(r.events)).toMatchObject({ code: 'step_failed', details: { partial: true } });
      } finally {
        created.exec.syncTarget = undefined;
      }
      // 第一个非事务步骤已经开始执行（touched）：版本永久算执行过，登记改成 confirmed
      expect(await executedAt(v2.id)).not.toBeNull();
      expect(await mirror(eid, v2.id)).toBe('confirmed');
    },
  );

  test.skipIf(skip || !PG_URL)(
    'claimed 残留不会把环境锁死：目标库连不上，PATCH 连接串仍然成功，版本变成不可编辑；claimed 不算 executedHere',
    async () => {
      const { pid, eid, target } = await newProject('stale-claim');
      const [v1] = await publishChain(pid, 1);
      // 目标库连不上（读历史清不掉残留），本进程没有在执行
      await db.query('update environments set url_enc = $2 where id = $1', [
        eid,
        encrypt('postgres://u:p@127.0.0.1:1/x'),
      ]);
      await plant(eid, v1!.id);
      expect((await status(pid, eid)).versions[0]!.executedHere).toBe(false); // 只算 confirmed
      expect(await executedAt(v1!.id)).toBeNull();
      const patch = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { url: target.url });
      expect(patch.status, JSON.stringify(patch.data)).toBe(200);
      // 保守处理：残留的版本当作执行过（最坏是一个其实没碰过库的版本不能再编辑），claimed 行删掉
      expect(await executedAt(v1!.id)).not.toBeNull();
      expect(await mirror(eid, v1!.id)).toBeNull();
      const d1 = (await call('GET', `/api/projects/${pid}/versions/${v1!.id}`))
        .data as unknown as VersionDetail;
      expect(
        (
          await call('PATCH', `/api/projects/${pid}/versions/${v1!.id}/steps`, {
            up: d1.upSteps,
            down: d1.downSteps,
          })
        ).status,
      ).toBe(409);
    },
  );

  test.skipIf(skip || !PG_URL)('claimed 残留不会让环境删不掉：删除时版本当作执行过', async () => {
    const { pid, eid } = await newProject('stale-claim-delete');
    const [v1] = await publishChain(pid, 1);
    await plant(eid, v1!.id);
    expect((await call('DELETE', `/api/projects/${pid}/environments/${eid}`)).status).toBe(200);
    expect(await executedAt(v1!.id)).not.toBeNull();
    expect(await versionExecutedAnywhere(db, v1!.id)).toBe(true);
  });

  test.skipIf(skip || !PG_URL)(
    '本进程正在使用环境（持有环境锁）：连接配置的修改（含 allowSameInstance）和删除是 409，且不产生任何副作用；非连接配置不受影响',
    async () => {
      const { pid, eid } = await newProject('lock-held');
      const [v1] = await publishChain(pid, 1);
      await plant(eid, v1!.id);
      const release = await created.exec.locks.acquire(eid);
      try {
        // 先拿锁、再做外部检查：409 的请求没有碰任何数据库（连接串根本连不上，如果先做检查会是别的错误）
        const unreachable = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, {
          url: 'postgres://u:p@127.0.0.1:1/x',
        });
        expect(unreachable.status).toBe(409);
        expect(unreachable.data.error).toContain('环境正在执行');
        expect(
          (await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { allowSameInstance: false }))
            .status,
        ).toBe(409);
        expect((await call('DELETE', `/api/projects/${pid}/environments/${eid}`)).status).toBe(409);
        // 没有副作用：残留的 claimed 还在，版本没有被当作执行过
        expect(await mirror(eid, v1!.id)).toBe('claimed');
        expect(await executedAt(v1!.id)).toBeNull();
        // 不是连接配置的修改不需要锁
        expect(
          (await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { execPolicy: 'admin' })).status,
        ).toBe(200);
      } finally {
        await release();
      }
    },
  );

  test.skipIf(skip || !PG_URL)('PATCH 只写改动的列：改档位 / 生产标记时不拿旧行回写连接串', async () => {
    const { pid, eid } = await newProject('patch-columns');
    const sqls: string[] = [];
    const orig = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
      orig((tx) =>
        fn({
          query: (q: string, p?: unknown[]) => {
            sqls.push(q);
            return tx.query(q, p);
          },
          exec: (q: string) => tx.exec(q),
        }),
      )) as never);
    try {
      const r = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { execPolicy: 'admin' });
      expect(r.status).toBe(200);
      // P5a：档位存在执行策略的环境层（exec_policies），改档位根本不写 environments 行（更不会回写连接串）
      expect(sqls.some((q) => /insert into exec_policies/i.test(q))).toBe(true);
      expect(sqls.find((q) => /^\s*update environments set/i.test(q))).toBeUndefined();
      sqls.length = 0;
      const r2 = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { production: true });
      expect(r2.status).toBe(200);
      const update2 = sqls.find((q) => /^\s*update environments set/i.test(q))!;
      expect(update2).toContain('production');
      expect(update2).not.toContain('url_enc');
      expect(update2).not.toContain('shadow_url_enc');
    } finally {
      spy.mockRestore();
    }
  });

  test.skipIf(skip || !PG_URL)(
    '拿到环境锁之后重新读环境行：等锁期间连接串被改了就用新 URL，环境被删了就拒绝；漂移检查也一样',
    async () => {
      const { pid, eid, target } = await newProject('reload-env');
      const [v1] = await publishChain(pid, 1);
      const other = await createTestDb('exec_other');
      targets.push(other);
      // 模拟“PATCH 持有环境锁”：执行在等锁，期间连接串被改成另一个库
      const release = await created.exec.locks.acquire(eid);
      const running = exec(pid, eid, 'execute', v1!.id);
      await new Promise((r) => setTimeout(r, 200));
      await db.query('update environments set url_enc = $2 where id = $1', [eid, encrypt(other.url)]);
      await release();
      expect(last((await running).events).stage).toBe('done');
      const has = async (d: { db: typeof target.db }) =>
        (await d.db.query<{ n: string | null }>("select to_regnamespace('dowel')::text as n"))[0]!.n !== null;
      expect(await has(other)).toBe(true); // 执行用的是新 URL
      expect(await has(target)).toBe(false); // 旧库什么都没动

      // 环境在等锁期间被删：执行被拒绝（404），不会拿旧的连接串去连
      const { pid: pid2, eid: eid2 } = await newProject('reload-env-deleted');
      const [w1] = await publishChain(pid2, 1);
      const release2 = await created.exec.locks.acquire(eid2);
      const running2 = exec(pid2, eid2, 'execute', w1!.id);
      await new Promise((r) => setTimeout(r, 200));
      await db.query('delete from environments where id = $1', [eid2]);
      await release2();
      const r2 = await running2;
      expect(last(r2.events)).toMatchObject({ code: 'rejected' });
      expect(last(r2.events).error).toContain('环境不存在');

      // 漂移检查：手里拿着过期的环境行（连接串已经换成连不上的），检查用的是最新的
      const [stale] = await db.query<EnvRow>('select * from environments where id = $1', [eid]);
      await db.query('update environments set url_enc = $2 where id = $1', [
        eid,
        encrypt('postgres://u:p@127.0.0.1:1/x'),
      ]);
      const d = await checkEnvDrift(created.exec, stale as never);
      expect(d.status).toBe('error');
      expect(d.summary?.errorKind).toBe('connect');
    },
  );

  test.skipIf(skip || !PG_URL)(
    '接管来的 claimed 残留：这次没有 touched 就保持 claimed（不撤销），之后在锁内的同步按目标库历史决定',
    async () => {
      const { pid, eid, target } = await newProject('adopt-keep');
      await addTable(created.rooms, db, pid);
      await editModel(created.rooms, db, pid, (m) => addNote(m, 'email'));
      const v1 = await publish(pid, 'v1');
      await editModel(created.rooms, db, pid, (m) => {
        const email = all(m, 'column').find((c) => c.name === 'email')!.id;
        addUnique(m, tableOf(m), [email]);
      });
      const v2 = await publish(pid, 'v2');
      expect(last((await exec(pid, eid, 'execute', v1.id)).events).stage).toBe('done');
      await target.db.exec("insert into public.orders (id, email) values (1, 'a@x.com'), (2, 'a@x.com')");
      await plant(eid, v2.id);
      created.exec.syncTarget = async () => null;
      try {
        // v2 的唯一约束在事务里失败、整体回滚：这次没有 touched
        const r = await exec(pid, eid, 'execute', v2.id);
        expect(last(r.events)).toMatchObject({ code: 'step_failed', details: { partial: false } });
        expect(await mirror(eid, v2.id)).toBe('claimed'); // 接管来的，不撤销
        expect(await executedAt(v2.id)).toBeNull();
        expect(await versionExecutedAnywhere(db, v2.id)).toBe(true);
      } finally {
        created.exec.syncTarget = undefined;
      }
      // 之后在锁内的同步：目标库历史里没有碰过 v2 的记录 → 清掉，v2 又可以编辑
      expect((await call('GET', `/api/projects/${pid}/environments/${eid}/history`)).status).toBe(200);
      expect(await mirror(eid, v2.id)).toBeNull();
      expect(await versionExecutedAnywhere(db, v2.id)).toBe(false);
    },
  );

  test.skipIf(skip || !PG_URL)('执行进行中：改连接串和删环境都是 409，执行结束之后可以', async () => {
    const { pid, eid, target } = await newProject('busy-guard');
    const [v1] = await publishChain(pid, 1);
    const d1 = (await call('GET', `/api/projects/${pid}/versions/${v1!.id}`))
      .data as unknown as VersionDetail;
    await forceSteps(
      pid,
      v1!.id,
      [...d1.upSteps, { sql: 'SELECT pg_sleep(3)', transactional: true }],
      d1.downSteps,
    );
    const running = exec(pid, eid, 'execute', v1!.id);
    const t0 = Date.now();
    while (!created.exec.locks.busy(eid)) {
      if (Date.now() - t0 > 10_000) throw new Error('执行没有开始');
      await new Promise((r) => setTimeout(r, 20));
    }
    const patch = await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { url: target.url });
    expect(patch.status).toBe(409);
    expect(patch.data.error).toContain('环境正在执行');
    expect((await call('DELETE', `/api/projects/${pid}/environments/${eid}`)).status).toBe(409);
    expect(last((await running).events).stage).toBe('done');
    expect(
      (await call('PATCH', `/api/projects/${pid}/environments/${eid}`, { url: target.url })).status,
    ).toBe(200);
  });

  /** v1 建 orders，v2 加一列；v2 的脚本改成“数据相关的事务步骤 + 多建一个索引”：库里没有数据时执行完读回对不上 */
  const readbackProject = async (name: string) => {
    const proj = await newProject(name);
    const [v1, v2] = await publishChain(proj.pid, 2);
    await forceSteps(proj.pid, v2!.id, [
      {
        sql: "DO $$ BEGIN IF (SELECT count(*) FROM public.orders) > 0 THEN RAISE EXCEPTION 'has rows'; END IF; END $$",
        transactional: true,
      },
      { sql: 'CREATE INDEX CONCURRENTLY "ix_extra" ON "public"."orders" ("id")', transactional: false },
    ]);
    return { ...proj, v1: v1!, v2: v2! };
  };

  test.skipIf(skip || !PG_URL)(
    '读回校验失败：同一次请求里漂移状态就带上 needsManual；之后被漂移拒绝时格式不变；手工修好后横幅消失',
    async () => {
      const { pid, eid, target, v1, v2 } = await readbackProject('readback-drift');
      expect(last((await exec(pid, eid, 'execute', v1.id)).events).stage).toBe('done');
      expect((await status(pid, eid)).drift.status).toBe('ok'); // 前一个迁移设下的 ok

      const r = await exec(pid, eid, 'execute', v2.id);
      expect(last(r.events)).toMatchObject({ code: 'readback_mismatch', details: { partial: true } });
      // 失败之后 status 接口立刻是 drifted，带 needsManual（方向、版本、版本号）和差异
      let st = await status(pid, eid);
      expect(st.drift.status).toBe('drifted');
      const manual = { direction: 'up', versionId: v2.id, versionNumber: 2 };
      expect(st.drift.summary!.needsManual).toEqual(manual);
      expect(st.drift.summary!.items.some((i) => i.sql.includes('ix_extra'))).toBe(true);
      // 差异是执行器读回时带出来的（线上结构 → 目标版本 v2 的模型），不是再连一次目标库检查出来的
      expect(st.drift.summary).toMatchObject({ versionId: v2.id, versionNumber: 2 });
      expect(st.drift.summary!.message).toBe('这些差异是上一次执行留下的，需要手工修正');

      // 历史里这次失败带 readbackFailure，文本里没有内部标记
      const h = await history(pid, eid);
      expect(h.runs[0]).toMatchObject({ status: 'failed', readbackFailure: true });
      expect(h.runs[0]!.error).not.toContain('[readback_mismatch]');
      expect(h.runs.slice(1).every((x) => !x.readbackFailure)).toBe(true);

      // 再执行：被漂移拒绝，缓存里的格式和上面一致
      const again = await exec(pid, eid, 'execute', v2.id);
      expect(last(again.events)).toMatchObject({
        code: 'drift',
        details: { needsManual: { direction: 'up', versionId: v2.id } },
      });
      st = await status(pid, eid);
      expect(st.drift.summary!.needsManual).toEqual(manual);

      // 手工修回当前版本的样子：漂移检查 ok，needsManual 消失
      await target.db.exec('DROP INDEX public.ix_extra');
      const d = (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
        .data as unknown as DriftCheckResponse;
      expect(d.status).toBe('ok');
      expect((await status(pid, eid)).drift.summary).toBeNull();
    },
  );

  test.skipIf(skip || !PG_URL)(
    '版本在目标库历史里有过碰过库的执行就算执行过，不能只看最后一次：读回失败、手工修好、再来一次干净的失败，同步之后仍是 executedHere',
    async () => {
      const { pid, eid, target, v1, v2 } = await readbackProject('history-all');
      await exec(pid, eid, 'execute', v1.id);
      expect(last((await exec(pid, eid, 'execute', v2.id)).events).code).toBe('readback_mismatch');
      await target.db.exec('DROP INDEX public.ix_extra');
      // 现在表里有数据：v2 的第一个事务步骤会报错，在碰目标库之前就失败（干净的失败，step_index 为空）
      await target.db.exec('insert into public.orders (id) values (1)');
      const second = await exec(pid, eid, 'execute', v2.id);
      expect(last(second.events)).toMatchObject({ code: 'step_failed', details: { partial: false } });
      const h = await history(pid, eid); // 读历史并同步
      expect(h.runs[0]).toMatchObject({ status: 'failed', stepIndex: null, readbackFailure: false });
      expect(h.runs[1]).toMatchObject({ status: 'failed', readbackFailure: true });
      // 第一次失败碰过库：镜像里 v2 仍是 confirmed，executed_at 在
      expect((await status(pid, eid)).versions.find((v) => v.id === v2.id)!.executedHere).toBe(true);
      expect(await mirror(eid, v2.id)).toBe('confirmed');
      expect(await executedAt(v2.id)).not.toBeNull();
    },
  );

  test.skipIf(skip)(
    '旧格式的 drift_summary（needsManual: true）：服务端读出时丢掉，不会渲染出空方向',
    async () => {
      const p = await call('POST', '/api/projects', { name: 'old-drift', groupId });
      const pid = p.data.id as string;
      const old = {
        versionId: 'x',
        versionNumber: 2,
        total: 1,
        items: [{ kind: 'k', target: 't', sql: 'ALTER TABLE x' }],
        message: '旧文案',
        needsManual: true,
      };
      for (const [id, summary] of [
        ['old-env', old],
        ['bad-env', { ...old, needsManual: { direction: 'sideways' } }],
        ['new-env', { ...old, needsManual: { direction: 'down', versionId: 'x', versionNumber: 2 } }],
      ] as const)
        await db.query(
          `insert into environments (id, project_id, name, url_enc, production, drift_status, drift_summary)
         values ($1, $2, $1, $3, false, 'drifted', $4::text::jsonb)`,
          [id, pid, encrypt('postgres://u:p@127.0.0.1:1/x'), JSON.stringify(summary)],
        );
      const envs = (await call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[];
      const by = (id: string) => envs.find((e) => e.id === id)!;
      expect(by('old-env').drift.summary).toMatchObject({ total: 1, message: '旧文案' });
      expect(by('old-env').drift.summary).not.toHaveProperty('needsManual');
      expect(by('bad-env').drift.summary).not.toHaveProperty('needsManual');
      expect(by('new-env').drift.summary!.needsManual).toEqual({
        direction: 'down',
        versionId: 'x',
        versionNumber: 2,
      });
      const st = await status(pid, 'old-env');
      expect(st.drift.summary).not.toHaveProperty('needsManual');
      expect(st.drift.status).toBe('drifted');
      // 手动检查返回的缓存信息（这里环境被占用，返回缓存）也经过清洗
      const release = await created.exec.locks.acquire('old-env');
      try {
        const busy = (await call('POST', `/api/projects/${pid}/environments/old-env/drift-check`))
          .data as unknown as DriftCheckResponse;
        expect(busy.skipped).toBe('busy');
        expect(busy.summary).toMatchObject({ total: 1, message: '旧文案' });
        expect(busy.summary).not.toHaveProperty('needsManual');
      } finally {
        await release();
      }
    },
  );

  test.skipIf(skip || !PG_URL)(
    'ADR 0013 switch / retired_target / status.pending 树计算 / claim 并发复核 / 跨岔路 mark',
    async () => {
      const { pid, eid, target } = await newProject('adr13-switch');
      const [v1, v2] = await publishChain(pid, 2);
      // 先在 dev 环境走到 v2
      expect(last((await exec(pid, eid, 'execute', v2!.id)).events).stage).toBe('done');

      // 在 v1 下构造分叉活跃版本 v3（添加 main_c3），再把 v2 标为作废
      const [bRow] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
      const [v1Row] = await db.query<{ model: Model }>('select model from versions where id = $1', [v1!.id]);
      const m1 = v1Row!.model;
      const m3 = structuredClone(m1);
      addNote(m3, 'main_c3');
      const up3 = toScriptSteps(plan(m1, m3), 'pg');
      const down3 = toScriptSteps(plan(m3, m1), 'pg');
      const v3Id = newId();
      await db.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                               up_steps, down_steps, checksum, verified_at)
         values ($1, $2, $3, 2, 'v3', $4::text::jsonb, null, 3, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
        [
          v3Id,
          pid,
          bRow!.id,
          JSON.stringify(m3),
          v1!.id,
          JSON.stringify(up3),
          JSON.stringify(down3),
          stepsChecksum(up3, down3),
          new Date().toISOString(),
        ],
      );
      await recordVerifiedOnEnvs(db, pid, [v3Id]);
      await db.query('update versions set retired_at = $2 where id = $1', [v2!.id, new Date().toISOString()]);

      // 1. 直接 execute 到已作废版本 v2 → 409 retired_target；去 v3 → SSE switch_required
      const execRet = await call('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to: v2!.id });
      expect(execRet.status).toBe(409);
      expect(execRet.data.code).toBe('retired_target');
      const execWrong = await exec(pid, eid, 'execute', v3Id);
      expect(last(execWrong.events)).toMatchObject({
        code: 'switch_required',
        details: { lca: { id: v1!.id } },
      });

      // 2. status.pending 沿着版本树计算到活跃头 v3（停在 v2 时 pending=[v3]）
      expect((await status(pid, eid)).pending).toEqual([v3Id]);

      // 3. /switch：缺 rollback 权限（viewer / 生产未授权 editor）403；预演返回 direction=switch + lca；真实无 ack → 422
      expect(
        (await call('POST', `/api/projects/${pid}/environments/${eid}/switch`, { to: v3Id }, viewer)).status,
      ).toBe(403);
      const dry = await call('POST', `/api/projects/${pid}/environments/${eid}/switch`, {
        to: v3Id,
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect((dry.data as unknown as DryRunResponse).plan).toMatchObject({
        direction: 'switch',
        lca: { id: v1!.id, number: 1 },
      });

      const noAck = await call('POST', `/api/projects/${pid}/environments/${eid}/switch`, { to: v3Id });
      expect(noAck.status).toBe(422);
      expect(noAck.data.code).toBe('rollback_ack_required');

      // 4. 真实 switch 执行成功，审计记录 environment.switch 写入动态
      const sw = await call('POST', `/api/projects/${pid}/environments/${eid}/switch`, {
        to: v3Id,
        acknowledgeRollback: true,
      });
      expect(sw.status).toBe(200);
      expect(last(sw.events)).toMatchObject({ stage: 'done', current: { id: v3Id } });
      expect(await columnsOf(target)).toEqual(['id', 'main_c3']);
      expect((await status(pid, eid)).pending).toEqual([]);

      const act = (await call('GET', `/api/projects/${pid}/activity`)).data as unknown as ProjectActivity;
      const swAudit = act.events.find((e) => e.action === 'environment.switch');
      expect(swAudit).toBeDefined();
      expect(swAudit!.data).toMatchObject({
        direction: 'switch',
        lca: { id: v1!.id, number: 1 },
        rolledBack: [2],
        upgraded: [3],
        ok: true,
      });

      // 5. 生产环境 switch 还受 approvalRequired (403) 与 confirm (422) 约束
      const prodTgt = await createTestDb('exec_prod_sw');
      targets.push(prodTgt);
      const prodRes = await call('POST', `/api/projects/${pid}/environments`, {
        name: 'prod-sw',
        url: prodTgt.url,
        production: true,
        allowSameInstance: true,
      });
      const prodEid = prodRes.data.id as string;
      const noConf = await call('POST', `/api/projects/${pid}/environments/${prodEid}/switch`, {
        to: v3Id,
        acknowledgeRollback: true,
      });
      expect(noConf.status).toBe(422);
      expect(
        (
          await call('PUT', `/api/projects/${pid}/environments/${prodEid}/exec-policy`, {
            settings: { approval: [{ approvers: { kind: 'project_admins' }, count: 1 }] },
          })
        ).status,
      ).toBe(200);
      const needApp = await call('POST', `/api/projects/${pid}/environments/${prodEid}/switch`, {
        to: v3Id,
        acknowledgeRollback: true,
        confirm: 'prod-sw',
      });
      expect(needApp.status).toBe(403);
      expect(needApp.data.code).toBe('approval_required');

      // 6. claim 并发复核竞态：先停在 v1，在执行 v3 的 plan 事件发出后瞬间把 v3 标为已作废 → claim 拦成 retired_target
      expect(last((await exec(pid, eid, 'rollback', v1!.id)).events).stage).toBe('done');
      const [envRow] = await db.query<EnvRow>('select * from environments where id = $1', [eid]);
      await expect(
        runExecution(created.exec, {
          pid,
          projectName: 'adr13-switch',
          env: envRow!,
          to: v3Id,
          direction: 'up',
          userId: 'admin',
          timeouts: { statementMs: 0, lockMs: 0 },
          onEvent: async (e) => {
            if (e.stage === 'plan') {
              await db.query('update versions set retired_at = $2 where id = $1', [
                v3Id,
                new Date().toISOString(),
              ]);
            }
          },
        }),
      ).rejects.toMatchObject({ code: 'retired_target' });
      await db.query('update versions set retired_at = null where id = $1', [v3Id]);

      // 7. 跨岔路 mark（另一个等价模型的项目）与禁止 mark 到已作废版本
      const markProj = await newProject('adr13-mark');
      const [mv1, mv2] = await publishChain(markProj.pid, 2);
      expect(last((await exec(markProj.pid, markProj.eid, 'execute', mv2!.id)).events).stage).toBe('done');
      const [mbRow] = await db.query<{ id: string }>('select id from branches where project_id = $1', [
        markProj.pid,
      ]);
      const [mv2Row] = await db.query<{ model: Model }>('select model from versions where id = $1', [
        mv2!.id,
      ]);
      const [mv1Row] = await db.query<{ model: Model }>('select model from versions where id = $1', [
        mv1!.id,
      ]);
      const mSame = mv2Row!.model;
      const upSame = toScriptSteps(plan(mv1Row!.model, mSame), 'pg');
      const downSame = toScriptSteps(plan(mSame, mv1Row!.model), 'pg');
      const mv3Id = newId();
      await db.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, created_by, number, parent_id,
                               up_steps, down_steps, checksum, verified_at)
         values ($1, $2, $3, 2, 'v3-same', $4::text::jsonb, null, 3, $5, $6::text::jsonb, $7::text::jsonb, $8, $9)`,
        [
          mv3Id,
          markProj.pid,
          mbRow!.id,
          JSON.stringify(mSame),
          mv1!.id,
          JSON.stringify(upSame),
          JSON.stringify(downSame),
          stepsChecksum(upSame, downSame),
          new Date().toISOString(),
        ],
      );
      await recordVerifiedOnEnvs(db, markProj.pid, [mv3Id]);
      await db.query('update versions set retired_at = $2 where id = $1', [
        mv2!.id,
        new Date().toISOString(),
      ]);

      const markRetDry = await call(
        'POST',
        `/api/projects/${markProj.pid}/environments/${markProj.eid}/mark`,
        {
          to: mv2!.id,
          dryRun: true,
        },
      );
      expect(markRetDry.status).toBe(200);
      expect(markRetDry.data).toMatchObject({ ok: false, code: 'retired_target' });

      const markRet = await call('POST', `/api/projects/${markProj.pid}/environments/${markProj.eid}/mark`, {
        to: mv2!.id,
      });
      expect(markRet.status).toBe(422);
      expect(markRet.data.code).toBe('retired_target');

      const markDry = await call('POST', `/api/projects/${markProj.pid}/environments/${markProj.eid}/mark`, {
        to: mv3Id,
        dryRun: true,
      });
      expect(markDry.status).toBe(200);
      const dryRes = markDry.data as unknown as MarkDryRunResponse;
      expect(dryRes.ok).toBe(true);
      expect(dryRes.plan!.direction).toBe('cross');
      expect(dryRes.plan!.skipped.map((v) => v.id)).toEqual([mv3Id]);

      const markGo = await call('POST', `/api/projects/${markProj.pid}/environments/${markProj.eid}/mark`, {
        to: mv3Id,
        acknowledge: true,
        expect: {
          from: dryRes.plan!.from?.id ?? null,
          to: dryRes.plan!.to.id,
          skipped: dryRes.plan!.skipped.map((v) => v.id),
          fingerprint: dryRes.plan!.fingerprint,
        },
      });
      expect(markGo.status).toBe(200);
      expect((markGo.data as unknown as MarkResult).current.id).toBe(mv3Id);

      // 8. 向后标记（skipped 为空）锁内复核竞态：在 loadChain 与 beforeMark 之间并发作废目标版本 → retired_target
      const backProj = await newProject('adr13-back-mark-race');
      const [bv1, bv2, bv3] = await publishChain(backProj.pid, 3);
      expect(last((await exec(backProj.pid, backProj.eid, 'execute', bv3!.id)).events).stage).toBe('done');
      // 把目标库结构还原到 v2（去掉 c3 列），构造向后标记 v3 → v2（skipped 为空）
      await backProj.target.db.exec('alter table orders drop column c3');
      const [backEnvRow] = await db.query<EnvRow>('select * from environments where id = $1', [backProj.eid]);
      const origQuery = db.query.bind(db);
      let retiredDuringMark = false;
      const querySpy = vi.spyOn(db, 'query').mockImplementation((async (sql: string, params?: unknown[]) => {
        const res = await origQuery(sql, params);
        // loadChain 之后、markApplied -> beforeMark 之前（读取 instance_settings 时）并发作废 bv2
        if (!retiredDuringMark && sql.includes('from instance_settings')) {
          retiredDuringMark = true;
          await origQuery('update versions set retired_at = $2 where id = $1', [
            bv2!.id,
            new Date().toISOString(),
          ]);
        }
        return res;
      }) as typeof db.query);
      try {
        await expect(
          runMark(created.exec, {
            pid: backProj.pid,
            projectName: 'adr13-back-mark-race',
            env: backEnvRow!,
            to: bv2!.id,
            userId: 'admin',
          }),
        ).rejects.toMatchObject({ code: 'retired_target' });
      } finally {
        querySpy.mockRestore();
      }
      expect(retiredDuringMark).toBe(true);
      expect((await status(backProj.pid, backProj.eid)).currentVersion?.id).toBe(bv3!.id);
      expect(bv1!.number).toBe(1);
    },
  );
});
