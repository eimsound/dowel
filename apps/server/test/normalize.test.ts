// 按需规范化（ADR 0016）HTTP 端到端：编辑不触发后台影子库刷新；GET /normalize 只读状态（0 影子库 I/O）；
// POST /normalize 显式规范化（SQLite :memory: 影子库 + 桩影子库）、权限、请求体校验、错误码映射与连接限速退回（零 Docker）。
import type { NormalizeResult, NormalizeStatus } from '@dowel/api';
import { addCheck, addColumn, all, createSchema, createTable, type Model, type Obj } from '@dowel/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { type Shadow, ShadowError } from '../src/shadow.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'normalize-test-secret-0123456789';

let db: PlatformDb;
let created: ReturnType<typeof createApp>;
let adminCookie = '';
let editorCookie = '';
let viewerCookie = '';
let groupId = '';

const call = async (method: string, path: string, json?: unknown, cookie = '') => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const r = await created.app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: r.status, data };
};

const login = async (username: string) => {
  const res = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')?.split(';')[0] ?? '';
};

const newProject = async (name: string, dialect: 'pg' | 'sqlite') => {
  const p = await call('POST', '/api/projects', { name, groupId, dialect }, adminCookie);
  expect(p.status, JSON.stringify(p.data)).toBe(201);
  const pid = (p.data as { id: string }).id;
  const [b] = await db.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  for (const [cookieUser, role] of [
    ['editor', 'editor'],
    ['viewer', 'viewer'],
  ] as const) {
    const [u] = await db.query<{ id: string }>('select id from users where username = $1', [cookieUser]);
    const g = await call(
      'POST',
      `/api/projects/${pid}/grants`,
      { subjectKind: 'user', subjectId: u!.id, role },
      adminCookie,
    );
    expect(g.status, JSON.stringify(g.data)).toBeLessThan(300);
  }
  return { pid, branch: b!.id };
};

/** 工作副本加一张表和一条 CHECK（直接替换房间，不经过 ctx.replace，因此不会改写黄金基线） */
const seedCheck = (pid: string, expr = 'total>0') => {
  let checkId = '';
  return editModel(created.rooms, db, pid, (m) => {
    const schema = all(m, 'schema')[0]?.id ?? createSchema(m, 'main');
    const t = createTable(m, schema, 'orders');
    addColumn(m, t, { name: 'total', type: 'integer' });
    checkId = addCheck(m, t, 'total>0', 'ck_total');
    // 绕过编辑器的列名检查，直接写入表达式原文（模拟导入 / 旧数据里的坏表达式）
    (m.objects[checkId] as { expr: string }).expr = expr;
  }).then(() => checkId);
};

const exprOf = (m: Model, id: string) => (m.objects[id] as { expr: string } | undefined)?.expr;

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    // 限额 1：被精确退回的失败不应占用额度
    connectionLimiter: new KeyedLimiter({ limit: 1, windowMs: 60_000 }),
  });
  await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  await makeUser(db, 'editor', { name: '张三' });
  await makeUser(db, 'viewer', { name: '李四' });
  adminCookie = await login('admin');
  editorCookie = await login('editor');
  viewerCookie = await login('viewer');
  const g = await call(
    'POST',
    '/api/groups',
    { slug: 'norm-g', name: '规范化组', defaultRole: 'none' },
    adminCookie,
  );
  expect(g.status).toBe(201);
  groupId = (g.data as { id: string }).id;
});

afterEach(async () => {
  created.refresher.stop();
  await created.refresher.drain();
  await created.rooms.flush();
  await created.shadows.close();
  await db.close();
});

describe('SQLite :memory: 影子库', () => {
  test('编辑不自动规范化；状态栏显示待规范化；显式规范化后清零，再次点击为 clean', async () => {
    const { pid, branch } = await newProject('SQLite 规范化', 'sqlite');
    const st0 = await call('GET', `/api/projects/${pid}/normalize`, undefined, viewerCookie);
    expect(st0.status).toBe(200);
    expect(st0.data).toMatchObject({ pending: false, pendingCount: 0, shadow: 'memory', baseline: false });

    const checkId = await seedCheck(pid);
    // 没有后台刷新：稍等之后工作副本里仍是用户写的原文
    await new Promise((r) => setTimeout(r, 30));
    expect(exprOf((await created.rooms.model(branch)).model, checkId)).toBe('total>0');

    const st1 = (await call('GET', `/api/projects/${pid}/normalize`, undefined, viewerCookie))
      .data as NormalizeStatus;
    expect(st1.pending).toBe(true);
    expect(st1.pendingCount).toBe(1);
    expect(st1.objects.map((o) => o.id)).toEqual([checkId]);
    expect(st1.truncated).toBe(false);

    // 查看者不能规范化
    expect((await call('POST', `/api/projects/${pid}/normalize`, {}, viewerCookie)).status).toBe(403);
    // 请求体严格校验
    expect((await call('POST', `/api/projects/${pid}/normalize`, { foo: 1 }, editorCookie)).status).toBe(400);

    const res = await call('POST', `/api/projects/${pid}/normalize`, undefined, editorCookie);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const out = res.data as NormalizeResult;
    expect(out.ok).toBe(true);
    expect(['normalized', 'verified']).toContain(out.outcome);
    expect(out.checkedInShadow).toBe(true);
    expect(out.shadow).toBe('SQLite :memory:');

    const st2 = (await call('GET', `/api/projects/${pid}/normalize`, undefined, viewerCookie))
      .data as NormalizeStatus;
    expect(st2).toMatchObject({ pending: false, pendingCount: 0, baseline: true, seq: out.seq });

    const again = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(again.data).toMatchObject({ outcome: 'clean', normalizedCount: 0, checkedInShadow: false });
  });

  test('影子库里建不出来的表达式：422 canonicalize_failed，工作副本与基线保持原样', async () => {
    const { pid, branch } = await newProject('SQLite 坏表达式', 'sqlite');
    const checkId = await seedCheck(pid, 'no_such_column > 0');
    const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(res.status, JSON.stringify(res.data)).toBe(422);
    expect(res.data).toMatchObject({ code: 'canonicalize_failed' });
    expect(exprOf((await created.rooms.model(branch)).model, checkId)).toBe('no_such_column > 0');
    const [row] = await db.query<{ baseline: Model | null }>('select baseline from branches where id = $1', [
      branch,
    ]);
    expect(row?.baseline ?? null).toBeNull();
    // 关键出口 flush 安静跳过：导出 DDL 照常可用
    expect((await call('GET', `/api/projects/${pid}/ddl`, undefined, viewerCookie)).status).toBe(200);
  });
});

describe('桩影子库', () => {
  test('normalized：写回规范形式（op_name = derive）、推进基线，关键出口 flush 之后 0 影子库 I/O', async () => {
    const { pid, branch } = await newProject('桩规范化', 'pg');
    let calls = 0;
    const fake = {
      canonicalize: async (_prev: Model, next: Model) => {
        calls++;
        return Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj);
      },
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    // 项目没有环境：影子库配置状态为 none，但显式规范化用的是桩
    const checkId = await seedCheck(pid);
    const st = (await call('GET', `/api/projects/${pid}/normalize`, undefined, editorCookie))
      .data as NormalizeStatus;
    expect(st).toMatchObject({ pendingCount: 1, shadow: 'none' });
    expect(calls).toBe(0);

    const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ outcome: 'normalized', normalizedCount: 1, shadow: 'fake-shadow' });
    expect(exprOf((await created.rooms.model(branch)).model, checkId)).toBe('(total>0)');
    const commits = await db.query<{ op_name: string }>(
      'select op_name from room_commits where branch_id = $1 order by seq desc limit 1',
      [branch],
    );
    expect(commits[0]?.op_name).toBe('derive');
    // 规范化不写 audit_events
    const audits = await db.query<{ action: string }>(
      "select action from audit_events where action like 'model.normalize%'",
    );
    expect(audits).toHaveLength(0);

    // 之后的关键出口（迁移预览）没有待规范化对象：不再调影子库
    expect((await call('GET', `/api/projects/${pid}/migration`, undefined, viewerCookie)).status).toBe(200);
    expect(calls).toBe(1);
  });

  test('restore 历史不改写黄金基线，也不在确认阶段 flush（不会自冲突 409）', async () => {
    const { pid, branch } = await newProject('恢复历史', 'pg');
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    expect((await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie)).status).toBe(200);
    const baselineBefore = (
      await db.query<{ baseline: Model }>('select baseline from branches where id = $1', [branch])
    )[0]!.baseline;

    // 恢复到加 CHECK 之前的某个历史点（seq 1 = seed 之后、规范化之前，含未规范化的 CHECK）
    const detail = await call('GET', `/api/projects/${pid}/history/1`, undefined, editorCookie);
    expect(detail.status).toBe(200);
    const currentSeq = (detail.data as { currentSeq: number }).currentSeq;
    const restored = await call(
      'POST',
      `/api/projects/${pid}/history/1/restore`,
      { workingSeq: currentSeq },
      editorCookie,
    );
    expect(restored.status, JSON.stringify(restored.data)).toBe(200);
    const baselineAfter = (
      await db.query<{ baseline: Model }>('select baseline from branches where id = $1', [branch])
    )[0]!.baseline;
    expect(baselineAfter).toEqual(baselineBefore);
    const st = (await call('GET', `/api/projects/${pid}/normalize`, undefined, editorCookie))
      .data as NormalizeStatus;
    expect(st.pendingCount).toBe(1);
  });
});

describe('规范化期间项目被删除（Issue #144）', () => {
  test('影子库规范化期间项目被删：404（同项目不存在），不报 200 / 409，删除照常成功', async () => {
    const { pid } = await newProject('删除中', 'pg');
    const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
    let deleted: { status: number; data: unknown } | undefined;
    const fake = {
      canonicalize: async (_prev: Model, next: Model) => {
        // 规范化还在影子库里时，管理员删掉了项目（踢房间、forget 分支）
        deleted = await call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
        return Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj);
      },
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(deleted?.status, JSON.stringify(deleted?.data)).toBe(200);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toMatchObject({ error: '项目不存在' });
    expect((await call('GET', `/api/projects/${pid}/normalize`, undefined, editorCookie)).status).toBe(404);
  });
});

describe('PG 预连接失败（无 Docker）', () => {
  test('没有环境：GET 显示 none；POST 422 shadow_unavailable 且精确退回连接限速', async () => {
    const { pid } = await newProject('无影子库', 'pg');
    const st = await call('GET', `/api/projects/${pid}/normalize`, undefined, viewerCookie);
    expect(st.data).toMatchObject({ shadow: 'none', pendingCount: 0 });
    await seedCheck(pid);
    for (let i = 0; i < 3; i++) {
      const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
      expect(res.status, JSON.stringify(res.data)).toBe(422);
      expect(res.data).toMatchObject({ code: 'shadow_unavailable' });
    }
  });

  test('模型静态校验不通过：422 model_invalid 且退回限速', async () => {
    const { pid } = await newProject('坏模型', 'pg');
    await editModel(created.rooms, db, pid, (m) => {
      const schema = all(m, 'schema')[0]?.id ?? createSchema(m, 'public');
      const t = createTable(m, schema, 'orders');
      addColumn(m, t, { name: 'total', type: 'integer' });
      // 指向不存在的枚举：validate 报错
      const col = all(m, 'column')[0]!;
      (m.objects[col.id] as { typeRef: string | null }).typeRef = 'missing-enum';
    });
    for (let i = 0; i < 2; i++) {
      const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
      expect(res.status, JSON.stringify(res.data)).toBe(422);
      expect(res.data).toMatchObject({ code: 'model_invalid' });
    }
  });

  test('影子库连接期失败（非 preConnect）：映射 422 shadow_unavailable，不退回限速', async () => {
    const { pid } = await newProject('连不上', 'pg');
    await seedCheck(pid);
    created.shadows.forProjectTarget = async () => {
      throw new ShadowError('影子库不可用：连接被拒绝');
    };
    const first = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(first.status).toBe(422);
    expect(first.data).toMatchObject({ code: 'shadow_unavailable' });
    const second = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(second.status).toBe(429);
  });

  test('精确退回限速：指定的环境不存在（404）、clean 未解析影子库时都不占额度', async () => {
    const { pid, branch } = await newProject('退回额度', 'pg');
    for (let i = 0; i < 3; i++) {
      const res = await call('POST', `/api/projects/${pid}/normalize`, { env: 'no-such-env' }, editorCookie);
      expect(res.status, JSON.stringify(res.data)).toBe(404);
    }
    // 基线就是当前模型：clean，不解析影子库（桩如果被调用就抛错）
    await created.refresher.reset(branch, (await created.rooms.model(branch)).model);
    created.shadows.forProjectTarget = async () => {
      throw new Error('clean 时不应解析影子库');
    };
    for (let i = 0; i < 3; i++) {
      const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
      expect(res.status, JSON.stringify(res.data)).toBe(200);
      expect(res.data).toMatchObject({ outcome: 'clean', shadow: null, checkedInShadow: false });
    }
  });
});
