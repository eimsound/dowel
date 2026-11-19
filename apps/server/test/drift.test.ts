// 漂移的两个出口与“标记为已执行”（ADR 0004）：真实 PG 作目标库 / 影子库，没有 Docker 时跳过。
// - 保留线上的修改：导入预览（差异 + 三种警告）→ 覆盖工作副本（对象 ID 沿用）→ 发布（改名仍是 RENAME）→ 标记为已执行；
// - 放弃线上的修改：修复脚本（只显示、不执行）；
// - 标记：核对线上结构、向前 / 向后、生产环境要环境名、权限、审计、版本可编辑性。
import type {
  DriftCheckResponse,
  EnvHistory,
  EnvInfo,
  ExecEvent,
  MarkDryRunResponse,
  MarkPlanInfo,
  ModelUpdate,
  PullPreview,
  RepairScript,
} from '@dowel/api';
import { addColumn, all, dropColumn, type Model, renameColumn } from '@dowel/core';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { connect, createTestDb, PG_URL } from '../../../test/pg.ts';
import { versionExecutedAnywhere } from '../src/chain.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

// 读目标库结构（readSnapshot）可以按需失败：测“读到当前版本之后才出错”时审计 from 仍然是实际读到的版本
const flaky = vi.hoisted(() => ({ readSnapshot: false }));
vi.mock('@dowel/engines', async (orig) => {
  const m = await orig<typeof import('@dowel/engines')>();
  return {
    ...m,
    readSnapshot: (...a: Parameters<typeof m.readSnapshot>) => {
      if (flaky.readSnapshot) throw new Error('boom: connection reset by peer');
      return m.readSnapshot(...a);
    },
  };
});

process.env.DOWEL_SECRET ??= 'drift-test-secret-0123456789';

interface Body extends Record<string, unknown> {
  error?: string;
  code?: string;
  details?: { diff?: { sql: string }[]; diffTotal?: number };
}

const targets: Awaited<ReturnType<typeof createTestDb>>[] = [];
const tableOf = (m: Model, name = 'orders') => all(m, 'table').find((t) => t.name === name)!.id;
const colOf = (m: Model, name: string) =>
  all(m, 'column').find((c) => c.parent === tableOf(m) && c.name === name)!;

describe.skipIf(!PG_URL)('漂移的两个出口与标记为已执行', () => {
  let db: PlatformDb;
  let created: ReturnType<typeof createApp>;
  let admin = '';
  let editor = '';
  let viewer = '';
  let groupId = '';
  let editorId = '';
  let viewerId = '';

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
    return { status: res.status, data: data as Body, events };
  };
  const login = async (username: string) => {
    const r = await created.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  const newProject = async (name: string, production = false) => {
    const p = await call('POST', '/api/projects', { name, groupId });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    for (const [user, role] of [
      [editorId, 'editor'],
      [viewerId, 'viewer'],
    ] as const)
      await call('POST', `/api/projects/${pid}/grants`, { subjectKind: 'user', subjectId: user, role });
    const target = await createTestDb('drift_srv');
    targets.push(target);
    const e = await call('POST', `/api/projects/${pid}/environments`, {
      name: production ? 'prod' : 'dev',
      url: target.url,
      production,
      allowSameInstance: true,
    });
    expect(e.status).toBe(201);
    return { pid, eid: e.data.id as string, target };
  };
  /** 发布 n 个版本：v1 建 orders，之后每个版本加一列 c<i> */
  const publishChain = async (pid: string, n: number) => {
    const out: { id: string; number: number }[] = [];
    for (let i = 1; i <= n; i++) {
      if (i === 1) await addTable(created.rooms, db, pid);
      else
        await editModel(created.rooms, db, pid, (m) => {
          addColumn(m, tableOf(m), { name: `c${i}`, type: 'text' });
        });
      const r = await call('POST', `/api/projects/${pid}/versions`, { name: `v${i}` });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      expect(r.data.verified).toBe(true);
      out.push({ id: r.data.id as string, number: r.data.number as number });
    }
    return out;
  };
  const execTo = async (pid: string, eid: string, to: string, confirm?: string) => {
    const r = await call('POST', `/api/projects/${pid}/environments/${eid}/execute`, { to, confirm });
    expect(r.events.at(-1), JSON.stringify(r.events)).toMatchObject({ stage: 'done' });
  };
  const mark = (pid: string, eid: string, body: Record<string, unknown>, cookie = admin) =>
    call('POST', `/api/projects/${pid}/environments/${eid}/mark`, body, cookie);
  /**
   * 标记并确认：先预演，再带着预演拿到的计划（expect）和确认（acknowledge）真正标记——向前标记的确认必须绑定到预演结果。
   * 预演不通过（线上结构对不上、noop、没有权限……）就原样发出请求，让服务端给出同样的拒绝。
   */
  const markConfirmed = async (pid: string, eid: string, body: Record<string, unknown>, cookie = admin) => {
    const d = await mark(pid, eid, { to: body.to, dryRun: true }, cookie);
    const dry = d.data as unknown as MarkDryRunResponse;
    if (d.status !== 200 || !dry.ok || !dry.plan) return mark(pid, eid, body, cookie);
    const p = dry.plan;
    return mark(
      pid,
      eid,
      {
        acknowledge: true,
        expect: {
          from: p.from?.id ?? null,
          to: p.to.id,
          skipped: p.skipped.map((v) => v.id),
          fingerprint: p.fingerprint,
        },
        ...body,
      },
      cookie,
    );
  };
  const driftCheck = async (pid: string, eid: string) =>
    (await call('POST', `/api/projects/${pid}/environments/${eid}/drift-check`))
      .data as unknown as DriftCheckResponse;
  const modelOf = async (pid: string): Promise<Model> => {
    const [b] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
    return (await created.rooms.model(b!.id)).model;
  };
  const envInfo = async (pid: string) =>
    ((await call('GET', `/api/projects/${pid}/environments`)).data as unknown as EnvInfo[])[0]!;

  beforeAll(async () => {
    db = await openPlatformDb(':memory:');
    created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: new KeyedLimiter({ limit: 10_000, windowMs: 60_000 }),
    });
    await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    editorId = (await makeUser(db, 'editor', { name: '编辑者' })).id;
    viewerId = (await makeUser(db, 'viewer', { name: '查看者' })).id;
    admin = await login('admin');
    editor = await login('editor');
    viewer = await login('viewer');
    const g = await call('POST', '/api/groups', { slug: 'g', name: '组' });
    groupId = g.data.id as string;
  });

  afterAll(async () => {
    await created.rooms.flush();
    await created.shadows.close();
    await db.close();
    for (const t of targets) await t.close();
  });

  test('放弃线上的修改：修复脚本 = plan(线上结构, 当前版本的模型)，带会话设置和风险提示；执行它之后漂移消失；模型表达不了的差异单独列出', async () => {
    const { pid, eid, target } = await newProject('修复脚本');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[1]!.id);
    // 没有漂移时没有脚本
    const none = (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`))
      .data as unknown as RepairScript;
    expect(none).toMatchObject({ script: null, steps: [], manual: [], total: 0 });

    await target.db.exec(
      'alter table public.orders add column hot int; alter table public.orders drop column c2',
    );
    expect((await driftCheck(pid, eid)).status).toBe('drifted');
    const r = (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`))
      .data as unknown as RepairScript;
    expect(r.versionNumber).toBe(2);
    expect(r.steps.length).toBe(2);
    expect(r.script).toContain("SET search_path = ''");
    expect(r.script).toMatch(/DROP COLUMN[^;]*hot/i); // 把线上多出来的列删掉
    expect(r.script).toMatch(/ADD COLUMN[^;]*c2/i); // 把被删掉的列加回来
    expect(r.risks.drops).toBe(1);
    expect(r.truncated).toBe(false);
    // 只显示、不执行：目标库仍然是漂移的结构
    expect(
      (
        await target.db.query<{ c: string }>(
          "select column_name::text as c from information_schema.columns where table_name = 'orders' and column_name in ('hot', 'c2')",
        )
      ).map((x) => x.c),
    ).toEqual(['hot']);
    // 用户自己执行脚本，然后重新检查漂移
    await target.db.exec(r.script!);
    expect((await driftCheck(pid, eid)).status).toBe('ok');
    expect(
      (
        (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`))
          .data as unknown as RepairScript
      ).script,
    ).toBeNull();

    // 模型表达不了的差异（unresolvable）列为“需要手工处理”，不进脚本
    await db.query(
      'update environments set drift_status = $2, drift_summary = $3::text::jsonb where id = $1',
      [
        eid,
        'drifted',
        JSON.stringify({
          versionId: chain[1]!.id,
          versionNumber: 2,
          total: 2,
          items: [
            {
              kind: 'dropColumn',
              target: 'public.orders.hot',
              sql: 'ALTER TABLE public.orders DROP COLUMN hot',
            },
            { kind: 'unresolvable', target: '', sql: '线上结构怪到无法规划' },
          ],
          message: null,
        }),
      ],
    );
    const m = (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`))
      .data as unknown as RepairScript;
    expect(m.steps.map((s) => s.kind)).toEqual(['dropColumn']);
    expect(m.manual.map((s) => s.sql)).toEqual(['线上结构怪到无法规划']);
    expect(m.script).not.toContain('无法规划');
    // 查看者就能看（只读平台库里缓存的漂移摘要）
    expect(
      (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`, undefined, viewer)).status,
    ).toBe(200);
  });

  test('保留线上的修改：导入预览 → 覆盖（对象 ID 沿用）→ 改名发布是 RENAME → 标记为已执行；版本冻结、审计、历史', async () => {
    const { pid, eid, target } = await newProject('保留修改');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[1]!.id);
    const v2 = await modelOf(pid);
    const ids = { id: colOf(v2, 'id').id, c2: colOf(v2, 'c2').id, table: tableOf(v2) };

    // 线上热修：加一列 hot，顺手把 c2 改名成 c2_hot（手工做的）
    await target.db.exec(
      'alter table public.orders add column hot int; alter table public.orders rename column c2 to c2_hot',
    );
    expect((await driftCheck(pid, eid)).status).toBe('drifted');

    // 导入预览：只读，给出差异和指纹；环境在链头、没有半途失败、工作副本没动 → 没有警告
    const pv = await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, { preview: true });
    expect(pv.status, JSON.stringify(pv.data)).toBe(200);
    const preview = pv.data as unknown as PullPreview;
    expect(preview.total).toBeGreaterThan(0);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.warnings).toEqual({
      behindHead: null,
      unfinished: false,
      readbackFailure: false,
      workingDirty: false,
    });
    expect(await modelOf(pid)).toEqual(v2); // 预览没有改工作副本

    // 覆盖：线上的结构进了工作副本，表和 id 列的对象 ID 沿用；c2 被手工改名，按名字对不上（识别成删一列加一列）
    const up = await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, {});
    expect(up.status).toBe(200);
    expect((up.data as unknown as ModelUpdate).objects).toBeGreaterThan(0);
    const imported = await modelOf(pid);
    expect(tableOf(imported)).toBe(ids.table);
    expect(colOf(imported, 'id').id).toBe(ids.id);
    expect(colOf(imported, 'hot')).toBeTruthy();
    expect(colOf(imported, 'c2_hot').id).not.toBe(ids.c2);

    // 用户检查后修正：把“删 c2、加 c2_hot”改回改名——把 c2_hot 换成原来的 c2 对象再改名（保住对象 ID，冻结出 RENAME）
    await editModel(created.rooms, db, pid, (m) => {
      dropColumn(m, colOf(m, 'c2_hot').id);
      addColumnWithId(m, ids.c2, 'c2');
      renameColumn(m, ids.c2, 'c2_hot');
    });
    const v3 = await call('POST', `/api/projects/${pid}/versions`, { name: 'v3 保留热修' });
    expect(v3.status, JSON.stringify(v3.data)).toBe(201);
    expect(v3.data.verified).toBe(true);
    const detail = (await call('GET', `/api/projects/${pid}/versions/${v3.data.id as string}`))
      .data as unknown as {
      upSteps: { sql: string }[];
    };
    const sqls = detail.upSteps.map((s) => s.sql).join('\n');
    expect(sqls).toMatch(/RENAME COLUMN "?c2"? TO "?c2_hot"?/i);
    expect(sqls).toMatch(/ADD COLUMN "?hot"?/i);
    expect(sqls).not.toMatch(/DROP COLUMN/i); // 改名没有退化成先删后加

    // 标记为已执行：先预演（核对线上结构，列出被跳过的版本和脚本，不写任何东西）
    const histBefore = (await target.db.query('select * from dowel.history')).length;
    const dry = (await mark(pid, eid, { to: v3.data.id, dryRun: true }))
      .data as unknown as MarkDryRunResponse;
    expect(dry.ok, JSON.stringify(dry)).toBe(true);
    expect(dry.plan!.direction).toBe('forward');
    expect(dry.plan!.skipped.map((v) => v.number)).toEqual([3]);
    expect(dry.plan!.skipped[0]!.upSteps.length).toBeGreaterThan(0);
    expect(dry.plan!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await target.db.query('select * from dowel.history')).length).toBe(histBefore);
    // 向前标记必须确认被跳过的版本
    const noAck = await mark(pid, eid, { to: v3.data.id });
    expect(noAck.status).toBe(422);
    expect(noAck.data.error).toContain('确认');
    expect(noAck.data.code).toBe('ack_required');
    expect(await versionExecutedAnywhere(db, v3.data.id as string)).toBe(false);
    expect((await target.db.query('select * from dowel.history')).length).toBe(histBefore);
    // 确认后标记成功
    // 带 ack 不带 expect：同样拒绝（确认必须绑定到预演结果）
    const noExpect = await mark(pid, eid, { to: v3.data.id, acknowledge: true });
    expect(noExpect.status).toBe(422);
    expect(noExpect.data.code).toBe('expect_required');
    expect((await target.db.query('select * from dowel.history')).length).toBe(histBefore);
    const ok = await markConfirmed(pid, eid, { to: v3.data.id });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect((await envInfo(pid)).currentVersion).toMatchObject({ number: 3 });
    expect((await envInfo(pid)).drift.status).toBe('ok');
    expect((await driftCheck(pid, eid)).status).toBe('ok');
    // 没有执行任何 SQL：目标库历史里只多了一条 mark 记录，版本行补上了 v3
    const hist = await target.db.query<{ direction: string; from_version: string; to_version: string }>(
      'select direction, from_version, to_version from dowel.history order by id desc limit 1',
    );
    expect(hist[0]).toEqual({ direction: 'mark', from_version: chain[1]!.id, to_version: v3.data.id });
    expect((await target.db.query('select 1 from dowel.versions')).length).toBe(3);
    // 向前标记的版本算“执行过”：脚本不能再编辑（409）；环境页历史里有“标记”
    expect(await versionExecutedAnywhere(db, v3.data.id as string)).toBe(true);
    expect(
      (
        await call('PATCH', `/api/projects/${pid}/versions/${v3.data.id as string}/steps`, {
          up: [{ sql: 'SELECT 1', transactional: true }],
          down: [],
        })
      ).status,
    ).toBe(409);
    const h = (await call('GET', `/api/projects/${pid}/environments/${eid}/history`))
      .data as unknown as EnvHistory;
    expect(h.runs[0]).toMatchObject({ direction: 'mark', status: 'done' });
    expect(h.runs[0]!.fromVersion!.number).toBe(2);
    expect(h.runs[0]!.toVersion.number).toBe(3);
    // 审计：from、to、跳过的版本、线上结构指纹
    const audits = await db.query<{ data: Record<string, unknown> }>(
      "select data from audit_events where action = 'environment.mark' and project_id = $1 order by at",
      [pid],
    );
    const succeeded = audits.map((a) => a.data).filter((d) => d.ok === true);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({
      from: chain[1]!.id,
      to: v3.data.id,
      direction: 'forward',
      skipped: [3],
      prerequisiteExempt: true,
    });
    expect(succeeded[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 失败也记审计：线上结构不等于目标版本（标记回 v1，库其实是 v3 的样子）
    const bad = await mark(pid, eid, { to: chain[0]!.id });
    expect(bad.status).toBe(422);
    expect(bad.data.code).toBe('mark_mismatch');
    expect(bad.data.details?.diffTotal).toBeGreaterThan(0);
    const failed = (
      await db.query<{ data: Record<string, unknown> }>(
        "select data from audit_events where action = 'environment.mark' and project_id = $1 order by at",
        [pid],
      )
    )
      .map((a) => a.data)
      .filter((d) => d.ok === false);
    // 失败的尝试各记一条：前面没确认被跳过的版本（ack_required）、这次线上结构对不上（mark_mismatch）
    expect(failed.map((d) => d.code)).toEqual(['ack_required', 'expect_required', 'mark_mismatch']);
    expect(failed[2]).toMatchObject({ to: chain[0]!.id });
    // 之后改名仍然是 RENAME（对象 ID 一路沿用）：在 v3 上再改 hot
    await editModel(created.rooms, db, pid, (m) => renameColumn(m, colOf(m, 'hot').id, 'hot2'));
    const v4 = await call('POST', `/api/projects/${pid}/versions`, { name: 'v4' });
    const d4 = (await call('GET', `/api/projects/${pid}/versions/${v4.data.id as string}`))
      .data as unknown as {
      upSteps: { sql: string }[];
    };
    expect(d4.upSteps.map((s) => s.sql).join('\n')).toMatch(/RENAME COLUMN "?hot"? TO "?hot2"?/i);
  });

  test('向后标记：手工回退了发布 → 标记到 v1；不写 executed_at，版本的可编辑性不变', async () => {
    const { pid, eid, target } = await newProject('向后标记');
    const chain = await publishChain(pid, 3);
    await execTo(pid, eid, chain[1]!.id);
    // v3 只发布、没在任何环境执行过：链头，可以编辑
    const patchV3 = () =>
      call('PATCH', `/api/projects/${pid}/versions/${chain[2]!.id}/steps`, {
        up: [{ sql: 'SELECT 1', transactional: true }],
        down: [],
      });
    expect(await versionExecutedAnywhere(db, chain[1]!.id)).toBe(true);
    expect(await versionExecutedAnywhere(db, chain[2]!.id)).toBe(false);

    await target.db.exec('alter table public.orders drop column c2'); // 手工回退 v2
    // 线上结构不等于 v2：先报漂移；标记到 v1 就对得上了
    expect((await driftCheck(pid, eid)).status).toBe('drifted');
    const r = await mark(pid, eid, { to: chain[0]!.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect((await envInfo(pid)).currentVersion).toMatchObject({ number: 1 });
    expect((await driftCheck(pid, eid)).status).toBe('ok');
    // 向后标记不需要确认被跳过的版本（没有跳过）；v2 仍然是“执行过”，v3 仍然可以编辑
    expect(await versionExecutedAnywhere(db, chain[1]!.id)).toBe(true);
    expect(await versionExecutedAnywhere(db, chain[2]!.id)).toBe(false);
    expect((await patchV3()).status).toBe(200);
    // 之后可以正常执行（从 v1 往前）
    await execTo(pid, eid, chain[1]!.id);
    expect((await envInfo(pid)).currentVersion).toMatchObject({ number: 2 });
  });

  test('导入预览的三种警告（只警告、不拦截）：环境落后于链头、工作副本有未发布的修改', async () => {
    const { pid, eid, target } = await newProject('导入警告');
    const chain = await publishChain(pid, 3);
    await execTo(pid, eid, chain[1]!.id); // 环境停在 v2，链头 v3
    await target.db.exec('alter table public.orders add column hot int');
    const p1 = (await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, { preview: true }))
      .data as unknown as PullPreview;
    expect(p1.warnings.behindHead).toMatchObject({ current: { number: 2 }, head: { number: 3 } });
    expect(p1.warnings.workingDirty).toBe(false);
    // 工作副本有未发布的修改
    await editModel(created.rooms, db, pid, (m) => {
      addColumn(m, tableOf(m), { name: 'draft', type: 'text' });
    });
    const p2 = (await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, { preview: true }))
      .data as unknown as PullPreview;
    expect(p2.warnings.workingDirty).toBe(true);
    // 警告不拦截：照样能覆盖
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, {})).status).toBe(200);
    // 没有 preview 字段 / 没有请求体的旧调用方式仍然是覆盖
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(200);
    // 审计里有来源环境和线上结构指纹
    const [a] = await db.query<{ data: Record<string, unknown> }>(
      "select data from audit_events where action = 'environment.pull' and project_id = $1 order by at desc limit 1",
      [pid],
    );
    expect(a!.data.environment).toBe('dev');
    expect(a!.data.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test('权限与确认：编辑者 / 查看者的权限；生产环境标记要环境名；预演不需要；核对不通过 422 带差异', async () => {
    const { pid, eid, target } = await newProject('标记权限', true);
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[0]!.id, 'prod');
    await target.db.exec('alter table public.orders add column c2 text'); // 手工热修，等于 v2
    // 生产环境默认档位是项目管理员：项目编辑者 403，查看者 403
    expect((await mark(pid, eid, { to: chain[1]!.id, dryRun: true }, editor)).status).toBe(403);
    expect((await mark(pid, eid, { to: chain[1]!.id }, viewer)).status).toBe(403);
    // 预演不需要环境名（什么都不写）
    const dry = (await mark(pid, eid, { to: chain[1]!.id, dryRun: true }))
      .data as unknown as MarkDryRunResponse;
    expect(dry.ok).toBe(true);
    // 真正标记：缺环境名 / 写错 → 422，什么都没写
    const histBefore = (await target.db.query('select * from dowel.history')).length;
    const miss = await markConfirmed(pid, eid, { to: chain[1]!.id });
    expect(miss.status).toBe(422);
    expect(miss.data.error).toContain('prod');
    expect((await markConfirmed(pid, eid, { to: chain[1]!.id, confirm: 'prd' })).status).toBe(422);
    expect((await target.db.query('select * from dowel.history')).length).toBe(histBefore);
    const done = await markConfirmed(pid, eid, { to: chain[1]!.id, confirm: 'prod' });
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect((await envInfo(pid)).currentVersion).toMatchObject({ number: 2 });

    // 核对不通过：预演是 200 + ok:false；真正标记是 422，都带差异和 code
    await target.db.exec('alter table public.orders add column oops int');
    const dry2 = (await mark(pid, eid, { to: chain[0]!.id, dryRun: true }))
      .data as unknown as MarkDryRunResponse;
    expect(dry2).toMatchObject({ ok: false, code: 'mark_mismatch' });
    expect(dry2.details!.diff!.length).toBeGreaterThan(0);
    const real = await mark(pid, eid, { to: chain[0]!.id, confirm: 'prod' });
    expect(real.status).toBe(422);
    expect(real.data.code).toBe('mark_mismatch');
    // 已经在这个版本：mark_noop
    expect((await mark(pid, eid, { to: chain[1]!.id, confirm: 'prod' })).data.code).toBe('mark_noop');
    // 不存在的版本 404
    expect((await mark(pid, eid, { to: 'nope', dryRun: true })).status).toBe(404);
  });

  test('导入预览：环境从来没有执行过、链上已经有版本 → 也给“落后于链头”的警告（current 为 null）', async () => {
    const { pid, eid } = await newProject('从未执行');
    await publishChain(pid, 2);
    const pv = (await call('POST', `/api/projects/${pid}/environments/${eid}/pull`, { preview: true }))
      .data as unknown as PullPreview;
    expect(pv.warnings.behindHead).toMatchObject({ current: null, head: { number: 2 } });
    // 链上没有任何版本：没有这个警告
    const empty = await newProject('没有版本');
    const pe = (
      await call('POST', `/api/projects/${empty.pid}/environments/${empty.eid}/pull`, { preview: true })
    ).data as unknown as PullPreview;
    expect(pe.warnings.behindHead).toBeNull();
  });

  test('导入确认绑定预览时的线上结构指纹：预览之后线上又变了 → 409 live_changed 带新的差异，工作副本不动；用新指纹确认成功', async () => {
    const { pid, eid, target } = await newProject('指纹绑定');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[1]!.id);
    await target.db.exec('alter table public.orders add column hot int');
    const url = `/api/projects/${pid}/environments/${eid}/pull`;
    const pv = (await call('POST', url, { preview: true })).data as unknown as PullPreview;
    const before = await modelOf(pid);
    // 预览之后又有人改了库
    await target.db.exec('alter table public.orders add column hot2 int');
    const stale = await call('POST', url, { fingerprint: pv.fingerprint });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('live_changed');
    const fresh = stale.data.preview as unknown as PullPreview;
    expect(fresh.fingerprint).not.toBe(pv.fingerprint);
    expect(JSON.stringify(fresh.items)).toContain('hot2');
    expect(await modelOf(pid)).toEqual(before); // 没有覆盖
    // 用新的指纹确认：覆盖成功
    const ok = await call('POST', url, { fingerprint: fresh.fingerprint });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(colOf(await modelOf(pid), 'hot2')).toBeTruthy();
    // 审计里的指纹是真正覆盖的那一份
    const [a] = await db.query<{ data: Record<string, unknown> }>(
      "select data from audit_events where action = 'environment.pull' and project_id = $1 order by at desc limit 1",
      [pid],
    );
    expect(a!.data.fingerprint).toBe(fresh.fingerprint);
  });

  test('修复脚本的风险按 kind 分类：去掉默认值 / 非空不算，去掉约束单独一类，删列算删除，改类型算重写', async () => {
    const { pid, eid, target } = await newProject('修复风险');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[1]!.id);
    const risks = async () => {
      expect((await driftCheck(pid, eid)).status).toBe('drifted');
      return (await call('GET', `/api/projects/${pid}/environments/${eid}/repair-script`))
        .data as unknown as RepairScript;
    };
    // 线上多了 NOT NULL 和默认值：修复脚本是 DROP NOT NULL / DROP DEFAULT，不算删除
    await target.db.exec(
      "alter table public.orders alter column c2 set not null; alter table public.orders alter column c2 set default 'x'",
    );
    let r = await risks();
    expect(r.steps.map((x) => x.kind).sort()).toEqual(['dropDefault', 'dropNotNull']);
    expect(r.risks).toEqual({ drops: 0, constraints: 0, rewrites: 0, rebuilds: 0 });
    await target.db.exec(
      'alter table public.orders alter column c2 drop not null; alter table public.orders alter column c2 drop default',
    );
    // 线上多了一个检查约束：修复是 DROP CONSTRAINT，单独计一类
    await target.db.exec('alter table public.orders add constraint orders_chk check (id > 0)');
    r = await risks();
    expect(r.risks).toEqual({ drops: 0, constraints: 1, rewrites: 0, rebuilds: 0 });
    await target.db.exec('alter table public.orders drop constraint orders_chk');
    // 线上多了一列：修复是 DROP COLUMN
    await target.db.exec('alter table public.orders add column hot int');
    r = await risks();
    expect(r.risks).toEqual({ drops: 1, constraints: 0, rewrites: 0, rebuilds: 0 });
    await target.db.exec('alter table public.orders drop column hot');
    // 线上改了列类型：修复是改回类型，算重写
    await target.db.exec('alter table public.orders alter column c2 type varchar(10)');
    r = await risks();
    expect(r.risks).toEqual({ drops: 0, constraints: 0, rewrites: 1, rebuilds: 0 });
  });

  test('标记的审计 from 用执行器读到的当前版本（不用平台缓存）；锁被占用 → lock_timeout，审计里 code 正确', async () => {
    const { pid, eid, target } = await newProject('审计来源');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[0]!.id);
    await target.db.exec('alter table public.orders add column c2 text'); // 手工热修 = v2
    // 平台缓存说环境没有当前版本（过期了），实际是 v1
    await db.query('update environments set current_version_id = null where id = $1', [eid]);
    const ok = await markConfirmed(pid, eid, { to: chain[1]!.id });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    const audits = async () =>
      (
        await db.query<{ data: Record<string, unknown> }>(
          "select data from audit_events where action = 'environment.mark' and project_id = $1 order by at",
          [pid],
        )
      ).map((a) => a.data);
    expect((await audits())[0]).toMatchObject({ ok: true, from: chain[0]!.id, to: chain[1]!.id });
    // 失败的审计也一样：线上结构不等于 v1（标记回 v1，库其实是 v2 的样子）；缓存再弄成过期的
    await db.query('update environments set current_version_id = $2 where id = $1', [eid, chain[0]!.id]);
    const bad = await mark(pid, eid, { to: chain[0]!.id });
    expect(bad.status).toBe(422);
    expect((await audits())[1]).toMatchObject({ ok: false, code: 'mark_mismatch', from: chain[1]!.id });

    // 锁被占用：另一个连接持有目标库的项目锁（项目锁等待调到 400ms）
    created.exec.lockTimeoutMs = 400;
    const holder = connect(target.url);
    try {
      await holder.db.query('select pg_advisory_lock(hashtext($1))', [`dowel:${pid}`]);
      const locked = await mark(pid, eid, { to: chain[0]!.id, confirm: '' });
      expect(locked.status).toBe(422);
      expect(locked.data.code).toBe('lock_timeout');
      const last = (await audits()).at(-1)!;
      expect(last).toMatchObject({ ok: false, code: 'lock_timeout' });
      // 读历史之前就失败了：from 记 null（不用平台缓存）
      expect(last.from).toBeNull();
      // 预演同样报 lock_timeout（200 + ok:false，带 code）
      const dry = (await mark(pid, eid, { to: chain[0]!.id, dryRun: true }))
        .data as unknown as MarkDryRunResponse;
      expect(dry).toMatchObject({ ok: false, code: 'lock_timeout' });
      await holder.db.query('select pg_advisory_unlock(hashtext($1))', [`dowel:${pid}`]);
    } finally {
      await holder.close();
      created.exec.lockTimeoutMs = undefined;
    }
  });

  test('标记到当前版本（上一次执行没结束时）：手工改回之后标记到 v2 → direction current；之后环境不再是半途状态', async () => {
    const { pid, eid, target } = await newProject('标记当前');
    const chain = await publishChain(pid, 3);
    await execTo(pid, eid, chain[1]!.id);
    const instance = (
      await target.db.query<{ instance_id: string }>('select instance_id from dowel.projects')
    )[0]!.instance_id;
    // 没有未完成的运行：标记到当前版本是 mark_noop
    expect((await mark(pid, eid, { to: chain[1]!.id })).data.code).toBe('mark_noop');
    // 造一条“停在中途”的失败记录（已经有断点）
    await target.db.query(
      `insert into dowel.history (project_id, from_version, to_version, direction, status, step_index, error, via, instance_id)
       values ($1, $2, $3, 'up', 'failed', 0, 'boom', 'web', $4)`,
      [pid, chain[1]!.id, chain[2]!.id, instance],
    );
    const h = (await call('GET', `/api/projects/${pid}/environments/${eid}/history`))
      .data as unknown as EnvHistory;
    expect(h.unfinished).not.toBeNull();
    const dry = (await mark(pid, eid, { to: chain[1]!.id, dryRun: true }))
      .data as unknown as MarkDryRunResponse;
    expect(dry.plan).toMatchObject({ direction: 'current', skipped: [] });
    const r = await mark(pid, eid, { to: chain[1]!.id });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const h2 = (await call('GET', `/api/projects/${pid}/environments/${eid}/history`))
      .data as unknown as EnvHistory;
    expect(h2.unfinished).toBeNull();
    expect(h2.runs[0]).toMatchObject({ direction: 'mark', status: 'done' });
    expect(h2.runs[0]!.fromVersion!.number).toBe(2);
    expect(h2.runs[0]!.toVersion.number).toBe(2);
    // 标记到当前版本不改版本的可编辑性：半途失败的那次执行碰过目标库，v3 早就算“执行过”（读历史时同步），标记不会把它变回可编辑
    expect(await versionExecutedAnywhere(db, chain[2]!.id)).toBe(true);
    // 之后可以从头重新执行 v3
    await execTo(pid, eid, chain[2]!.id);
    expect((await envInfo(pid)).currentVersion).toMatchObject({ number: 3 });
  });

  test('确认绑定预演结果：预演之后别人把环境标记回了更早的版本 → 422 plan_changed 带新计划，什么都没写；用新计划确认才成功', async () => {
    const { pid, eid, target } = await newProject('计划变了');
    const chain = await publishChain(pid, 3);
    await execTo(pid, eid, chain[1]!.id); // v2
    await target.db.exec('alter table public.orders add column c3 text'); // 手工热修 = v3
    const dry = (await mark(pid, eid, { to: chain[2]!.id, dryRun: true }))
      .data as unknown as MarkDryRunResponse;
    expect(dry.plan!.skipped.map((v) => v.number)).toEqual([3]);
    const p = dry.plan!;
    const expect1 = {
      from: p.from!.id,
      to: p.to.id,
      skipped: p.skipped.map((v) => v.id),
      fingerprint: p.fingerprint,
    };
    // 预演之后有人向后标记回了 v1（目标库历史里多一条 mark 记录，当前版本变成 v1）
    const instance = (
      await target.db.query<{ instance_id: string }>('select instance_id from dowel.projects')
    )[0]!.instance_id;
    await target.db.query(
      `insert into dowel.history (project_id, from_version, to_version, direction, status, via, instance_id)
       values ($1, $2, $3, 'mark', 'done', 'web', $4)`,
      [pid, chain[1]!.id, chain[0]!.id, instance],
    );
    const histBefore = (await target.db.query('select * from dowel.history')).length;
    const r = await mark(pid, eid, { to: chain[2]!.id, acknowledge: true, expect: expect1 });
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('plan_changed');
    const np = (r.data.details as unknown as { plan: MarkPlanInfo }).plan;
    expect(np.from!.number).toBe(1);
    expect(np.skipped.map((v) => v.number)).toEqual([2, 3]);
    expect(np.fingerprint).toBe(p.fingerprint); // 结构没变，变的是当前版本
    // 什么都没写：历史没多记录，v3 没有 executed_at
    expect((await target.db.query('select * from dowel.history')).length).toBe(histBefore);
    expect(await versionExecutedAnywhere(db, chain[2]!.id)).toBe(false);
    // 失败也记审计，code 是 plan_changed
    const [a] = await db.query<{ data: Record<string, unknown> }>(
      "select data from audit_events where action = 'environment.mark' and project_id = $1 order by at desc limit 1",
      [pid],
    );
    expect(a!.data).toMatchObject({ ok: false, code: 'plan_changed' });
    // 用新的计划确认：成功
    const ok = await mark(pid, eid, {
      to: chain[2]!.id,
      acknowledge: true,
      expect: {
        from: np.from!.id,
        to: np.to.id,
        skipped: np.skipped.map((v) => v.id),
        fingerprint: np.fingerprint,
      },
    });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(await versionExecutedAnywhere(db, chain[2]!.id)).toBe(true);
  });

  test('导入确认也绑定预览时的工作副本 seq：预览之后别人又改了模型 → 409 working_changed 带新预览，不覆盖；用新 seq 确认成功', async () => {
    const { pid, eid, target } = await newProject('工作副本变了');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[1]!.id);
    await target.db.exec('alter table public.orders add column hot int');
    const url = `/api/projects/${pid}/environments/${eid}/pull`;
    const pv = (await call('POST', url, { preview: true })).data as unknown as PullPreview;
    expect(pv.workingSeq).toBeGreaterThanOrEqual(0);
    // 预览之后有人改了工作副本（线上结构没变，指纹还对得上）
    await editModel(created.rooms, db, pid, (m) => {
      addColumn(m, tableOf(m), { name: 'draft', type: 'text' });
    });
    const before = await modelOf(pid);
    const stale = await call('POST', url, { fingerprint: pv.fingerprint, workingSeq: pv.workingSeq });
    expect(stale.status).toBe(409);
    expect(stale.data.code).toBe('working_changed');
    const fresh = stale.data.preview as unknown as PullPreview;
    expect(fresh.workingSeq).toBeGreaterThan(pv.workingSeq);
    expect(fresh.warnings.workingDirty).toBe(true);
    expect(await modelOf(pid)).toEqual(before); // 没有覆盖：别人的 draft 列还在
    expect(colOf(before, 'draft')).toBeTruthy();
    // 用新的 seq 确认：覆盖成功（draft 列被线上结构取代）
    const ok = await call('POST', url, { fingerprint: fresh.fingerprint, workingSeq: fresh.workingSeq });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(all(await modelOf(pid), 'column').some((c) => c.name === 'draft')).toBe(false);
  });

  test('导入预览的警告：上一次执行停在中途 / 读回校验失败各有各的警告；历史接口直接返回 readbackFailure', async () => {
    const { pid, eid, target } = await newProject('预览警告');
    const chain = await publishChain(pid, 3);
    await execTo(pid, eid, chain[1]!.id);
    await target.db.exec('alter table public.orders add column hot int');
    const instance = (
      await target.db.query<{ instance_id: string }>('select instance_id from dowel.projects')
    )[0]!.instance_id;
    const url = `/api/projects/${pid}/environments/${eid}/pull`;
    const hist = async () =>
      (await call('GET', `/api/projects/${pid}/environments/${eid}/history`)).data as unknown as EnvHistory;
    const fail = (error: string, step: number | null) =>
      target.db.query(
        `insert into dowel.history (project_id, from_version, to_version, direction, status, step_index, error, via, instance_id)
         values ($1, $2, $3, 'up', 'failed', $4, $5, 'web', $6)`,
        [pid, chain[1]!.id, chain[2]!.id, step, error, instance],
      );
    // 停在中途
    await fail('boom', 0);
    const w1 = ((await call('POST', url, { preview: true })).data as unknown as PullPreview).warnings;
    expect(w1).toMatchObject({ unfinished: true, readbackFailure: false });
    const h1 = await hist();
    expect(h1.unfinished).not.toBeNull();
    expect(h1.readbackFailure).toBe(false);
    // 读回校验失败（所有步骤做完了，结构却不对）
    await fail('[readback_mismatch] 读回不一致', null);
    const w2 = ((await call('POST', url, { preview: true })).data as unknown as PullPreview).warnings;
    expect(w2).toMatchObject({ unfinished: false, readbackFailure: true });
    const h2 = await hist();
    expect(h2.unfinished).toBeNull();
    expect(h2.readbackFailure).toBe(true);
    // 内部标记不泄漏到界面上的错误文本
    expect(h2.runs[0]!.error).toBe('读回不一致');
  });

  test('标记在读到当前版本之后才出错（读结构失败）：审计 from 仍然是目标库里实际的当前版本', async () => {
    const { pid, eid, target } = await newProject('读结构失败');
    const chain = await publishChain(pid, 2);
    await execTo(pid, eid, chain[0]!.id);
    await target.db.exec('alter table public.orders add column c2 text'); // 手工热修 = v2
    await db.query('update environments set current_version_id = null where id = $1', [eid]); // 平台缓存过期
    flaky.readSnapshot = true;
    try {
      const r = await mark(pid, eid, { to: chain[1]!.id, dryRun: true });
      expect(r.data).toMatchObject({ ok: false, code: 'internal' }); // 预演：200 + ok:false
      const bad = await mark(pid, eid, { to: chain[1]!.id, confirm: '' });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).not.toBe(404);
    } finally {
      flaky.readSnapshot = false;
    }
    const audits = (
      await db.query<{ data: Record<string, unknown> }>(
        "select data from audit_events where action = 'environment.mark' and project_id = $1 order by at",
        [pid],
      )
    ).map((a) => a.data);
    expect(audits.at(-1)).toMatchObject({ ok: false, from: chain[0]!.id });
    expect(audits.at(-1)!.code).not.toBe('lock_timeout');
  });
});

/** 在工作副本里按指定的对象 ID 给 orders 加一列（保住原来的对象 ID） */
const addColumnWithId = (m: Model, id: string, name: string) => {
  addColumn(m, tableOf(m), { name, type: 'text', id });
};
