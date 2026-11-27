// 按需规范化（ADR 0016）HTTP 端到端：编辑不触发后台影子库刷新；GET /normalize 只读状态（0 影子库 I/O）；
// POST /normalize 显式规范化（SQLite :memory: 影子库 + 桩影子库）、权限、请求体校验、错误码映射与连接限速退回（零 Docker）。
import type { NormalizeResult, NormalizeStatus } from '@dowel/api';
import { addCheck, addColumn, all, createSchema, createTable, type Model, type Obj } from '@dowel/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BranchForgottenError } from '../src/derive.ts';
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
  created.requests.stop();
  await created.requests.drain();
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

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('规范化期间项目被删除（Issue #144）', () => {
  const deleteBranchRows = async (branchId: string) => {
    await db.transaction(async (tx) => {
      await tx.query('delete from room_rejections where branch_id = $1', [branchId]);
      await tx.query('delete from room_commits where branch_id = $1', [branchId]);
      await tx.query('delete from room_snapshots where branch_id = $1', [branchId]);
      await tx.query('delete from branches where id = $1', [branchId]);
    });
  };

  test('A1 真实删除顺序：canonicalize 期间删除事务提交（停在 kickBranches 前）→ 404，不写回房间', async () => {
    const { pid } = await newProject('删除中-A1', 'pg');
    const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
    const kickEntered = deferred();
    const kickGate = deferred();
    const origKick = created.rooms.kickBranches.bind(created.rooms);
    created.rooms.kickBranches = async (branchIds, reason) => {
      kickEntered.resolve();
      await kickGate.promise;
      return origKick(branchIds, reason);
    };
    const patchSpy = vi.spyOn(created.rooms, 'patch');
    let delP: Promise<{ status: number; data: unknown }> | undefined;
    const fake = {
      canonicalize: async (_prev: Model, next: Model) => {
        // 发起 DELETE 后停在事务已提交、kickBranches 之前（模拟真实流程里还没踢房间时的时刻）
        delP = call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
        await kickEntered.promise;
        return Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj);
      },
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    let res!: { status: number; data: unknown };
    try {
      res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    } finally {
      kickGate.resolve();
    }
    const deleted = await delP!;
    expect(deleted.status, JSON.stringify(deleted.data)).toBe(200);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toMatchObject({ error: '项目不存在' });
    expect(patchSpy).not.toHaveBeenCalled();
    expect((await call('GET', `/api/projects/${pid}/normalize`, undefined, editorCookie)).status).toBe(404);
  });

  test('A2 真实删除顺序：rooms.patch 期间删除事务提交（停在 kickBranches 前），patch 抛外键错 → BranchForgottenError → 404', async () => {
    const { pid } = await newProject('删除中-A2', 'pg');
    const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
    const kickEntered = deferred();
    const kickGate = deferred();
    const origKick = created.rooms.kickBranches.bind(created.rooms);
    created.rooms.kickBranches = async (branchIds, reason) => {
      kickEntered.resolve();
      await kickGate.promise;
      return origKick(branchIds, reason);
    };
    let refresherErr: unknown;
    const origNormalize = created.refresher.normalize.bind(created.refresher);
    created.refresher.normalize = async (...args) => {
      try {
        return await origNormalize(...args);
      } catch (e) {
        refresherErr = e;
        throw e;
      }
    };
    let delP: Promise<{ status: number; data: unknown }> | undefined;
    const origPatch = created.rooms.patch.bind(created.rooms);
    created.rooms.patch = async (...args) => {
      delP = call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
      await kickEntered.promise;
      return origPatch(...args);
    };
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    let res!: { status: number; data: unknown };
    try {
      res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    } finally {
      kickGate.resolve();
    }
    const deleted = await delP!;
    expect(deleted.status, JSON.stringify(deleted.data)).toBe(200);
    expect(refresherErr).toBeInstanceOf(BranchForgottenError);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toMatchObject({ error: '项目不存在' });
  });

  test('C 真实删除顺序：shadows.forgetProject 关闭影子库导致 canonicalize 抛 ShadowError → BranchForgottenError → 404（不报 422）', async () => {
    const { pid } = await newProject('删除中-C', 'pg');
    const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
    const shadowClosed = deferred();
    const forgetGate = deferred();
    const origForgetProject = created.shadows.forgetProject.bind(created.shadows);
    created.shadows.forgetProject = async (targetPid) => {
      shadowClosed.resolve();
      await forgetGate.promise;
      return origForgetProject(targetPid);
    };
    let refresherErr: unknown;
    const origNormalize = created.refresher.normalize.bind(created.refresher);
    created.refresher.normalize = async (...args) => {
      try {
        return await origNormalize(...args);
      } catch (e) {
        refresherErr = e;
        throw e;
      }
    };
    let delP: Promise<{ status: number; data: unknown }> | undefined;
    const fake = {
      canonicalize: async () => {
        delP = call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
        await shadowClosed.promise;
        throw new ShadowError('影子库连接已关闭');
      },
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    let res!: { status: number; data: unknown };
    try {
      res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    } finally {
      forgetGate.resolve();
    }
    const deleted = await delP!;
    expect(deleted.status, JSON.stringify(deleted.data)).toBe(200);
    expect(refresherErr).toBeInstanceOf(BranchForgottenError);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toMatchObject({ error: '项目不存在' });
  });

  test('PG 残留窗口兜底：rooms.patch 抛错早于 refresher.forget 时仍回 404；活分支真实错误仍回 500', async () => {
    const { pid, branch } = await newProject('PG兜底-已删', 'pg');
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    const origPatch = created.rooms.patch.bind(created.rooms);
    created.rooms.patch = async (...args) => {
      // 模拟 PG FOR UPDATE 唤醒先于路由调 refresher.forget：库行已删但尚未标记 forgotten
      await deleteBranchRows(branch);
      return origPatch(...args);
    };
    const res1 = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
    expect(res1.status, JSON.stringify(res1.data)).toBe(404);
    expect(res1.data).toMatchObject({ error: '项目不存在' });

    // 对照：活分支上的真实数据库错误仍回 500（不误吞成 404）
    const { pid: pid2 } = await newProject('PG兜底-活分支', 'pg');
    await seedCheck(pid2);
    created.rooms.patch = async () => {
      throw new Error('unexpected db failure');
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res2 = await call('POST', `/api/projects/${pid2}/normalize`, {}, adminCookie);
      expect(res2.status, JSON.stringify(res2.data)).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });

  test('限速精确退回：未解析影子库前项目被删（排队中）→ 404、零解析且退回限速；已解析后被删不退回', async () => {
    const p1Info = await newProject('排队限速-1', 'pg');
    const p2Info = await newProject('排队限速-2', 'pg');
    const p3Info = await newProject('排队限速-3', 'pg');
    const p4Info = await newProject('排队限速-4', 'pg');
    const [row1] = await db.query<{ slug: string }>('select slug from projects where id = $1', [p1Info.pid]);
    const [row3] = await db.query<{ slug: string }>('select slug from projects where id = $1', [p3Info.pid]);
    await seedCheck(p1Info.pid);
    await seedCheck(p2Info.pid);
    await seedCheck(p3Info.pid);
    await seedCheck(p4Info.pid);

    let resolveCalls = 0;
    const okShadow = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => {
      resolveCalls++;
      return { shadow: okShadow, label: 'fake-shadow' };
    };

    // 情况 1（editorCookie）：排队等待期间项目被删，根本没解析影子库 → 404 且退回限速额度
    const blockerGate = deferred();
    const blocker = created.refresher.runWithoutReset(p1Info.branch, () => blockerGate.promise);
    const queued = deferred();
    const origNorm = created.refresher.normalize.bind(created.refresher);
    created.refresher.normalize = (b, h) => {
      const p = origNorm(b, h);
      queued.resolve();
      return p;
    };
    const norm1P = call('POST', `/api/projects/${p1Info.pid}/normalize`, {}, editorCookie);
    await queued.promise;
    let res1!: { status: number; data: unknown };
    try {
      const del1 = await call('DELETE', `/api/projects/${p1Info.pid}`, { confirm: row1!.slug }, adminCookie);
      expect(del1.status).toBe(200);
    } finally {
      blockerGate.resolve();
      await blocker;
      res1 = await norm1P;
    }
    expect(res1.status, JSON.stringify(res1.data)).toBe(404);
    expect(res1.data).toMatchObject({ error: '项目不存在' });
    expect(resolveCalls).toBe(0);

    // 额度已退回：同一个 editorCookie 紧接着规范化另一个项目仍可成功（limit = 1 不会 429）
    const res2 = await call('POST', `/api/projects/${p2Info.pid}/normalize`, {}, editorCookie);
    expect(res2.status, JSON.stringify(res2.data)).toBe(200);
    expect(resolveCalls).toBe(1);

    // 情况 2（adminCookie）：已经解析了影子库之后在 canonicalize 期间被删 → 404 且不退回限速额度
    const kickEntered = deferred();
    const kickGate = deferred();
    const origKick = created.rooms.kickBranches.bind(created.rooms);
    created.rooms.kickBranches = async (branchIds, reason) => {
      kickEntered.resolve();
      await kickGate.promise;
      return origKick(branchIds, reason);
    };
    let del3P: Promise<{ status: number; data: unknown }> | undefined;
    created.shadows.forProjectTarget = async () => {
      resolveCalls++;
      return {
        shadow: {
          canonicalize: async (_prev: Model, next: Model) => {
            del3P = call('DELETE', `/api/projects/${p3Info.pid}`, { confirm: row3!.slug }, adminCookie);
            await kickEntered.promise;
            return okShadow.canonicalize(_prev, next);
          },
          close: async () => {},
        } as unknown as Shadow,
        label: 'fake-shadow',
      };
    };
    let res3!: { status: number; data: unknown };
    try {
      res3 = await call('POST', `/api/projects/${p3Info.pid}/normalize`, {}, adminCookie);
    } finally {
      kickGate.resolve();
    }
    expect((await del3P!).status).toBe(200);
    expect(res3.status, JSON.stringify(res3.data)).toBe(404);
    // 已连过影子库，没有退回：紧接着再发起一次命中 429
    const res4 = await call('POST', `/api/projects/${p4Info.pid}/normalize`, {}, adminCookie);
    expect(res4.status).toBe(429);
  });

  test('flush() 在真实删除顺序下（rooms.patch 期间删除事务提交）返回 skipped(forgotten) 且不打告警', async () => {
    const { pid, branch } = await newProject('flush真实顺序', 'pg');
    const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);

    const kickEntered = deferred();
    const kickGate = deferred();
    const origKick = created.rooms.kickBranches.bind(created.rooms);
    created.rooms.kickBranches = async (branchIds, reason) => {
      kickEntered.resolve();
      await kickGate.promise;
      return origKick(branchIds, reason);
    };
    let delP: Promise<{ status: number; data: unknown }> | undefined;
    const origPatch = created.rooms.patch.bind(created.rooms);
    created.rooms.patch = async (...args) => {
      delP = call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
      await kickEntered.promise;
      return origPatch(...args);
    };

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let out!: Awaited<ReturnType<typeof created.refresher.flush>>;
    try {
      out = await created.refresher.flush(branch);
    } finally {
      kickGate.resolve();
      warn.mockRestore();
    }
    const deleted = await delP!;
    expect(deleted.status, JSON.stringify(deleted.data)).toBe(200);
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['pg', 'sqlite'] as const)(
    '兜底覆盖类型化错误（ShadowError，%s）：rooms.model 后项目被删且未打 forgotten 标记 → 404（不报 422）',
    async (dialect) => {
      const { pid } = await newProject(`兜底-ShadowError-${dialect}`, dialect);
      const [row] = await db.query<{ slug: string }>('select slug from projects where id = $1', [pid]);
      await seedCheck(pid);

      const kickEntered = deferred();
      const kickGate = deferred();
      const origKick = created.rooms.kickBranches.bind(created.rooms);
      created.rooms.kickBranches = async (branchIds, reason) => {
        kickEntered.resolve();
        await kickGate.promise;
        return origKick(branchIds, reason);
      };

      const origModel = created.rooms.model.bind(created.rooms);
      let delP: Promise<{ status: number; data: unknown }> | undefined;
      created.rooms.model = async (branchId) => {
        const res = await origModel(branchId);
        // 停在 rooms.model 返回前完成 DELETE 事务与 refresher.forget（此时无在途任务，不打 forgotten 标记），
        // 并在 kickBranches 卸载缓存前挂起，让随后的 normalize 走到 forProjectTarget 抛 ShadowError
        delP = call('DELETE', `/api/projects/${pid}`, { confirm: row!.slug }, adminCookie);
        await kickEntered.promise;
        return res;
      };

      let res!: { status: number; data: unknown };
      try {
        res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
      } finally {
        kickGate.resolve();
      }
      expect((await delP!).status).toBe(200);
      expect(res.status, JSON.stringify(res.data)).toBe(404);
      expect(res.data).toEqual({ error: '项目不存在' });
    },
  );

  test('兜底覆盖其他类型化错误（StepError）：canonicalize 期间库行被删且未打 forgotten 标记 → 404；活分支仍回 422 canonicalize_failed', async () => {
    const { pid: pid1, branch: branch1 } = await newProject('兜底-StepError-已删', 'sqlite');
    await seedCheck(pid1, 'no_such_column > 0');

    const origForProjectTarget = created.shadows.forProjectTarget.bind(created.shadows);
    created.shadows.forProjectTarget = async (targetPid) => {
      const h = await origForProjectTarget(targetPid);
      return {
        label: h.label,
        shadow: {
          ...h.shadow,
          canonicalize: async (prev: Model, next: Model) => {
            await deleteBranchRows(branch1);
            return h.shadow.canonicalize(prev, next);
          },
        } as unknown as Shadow,
      };
    };

    try {
      const res1 = await call('POST', `/api/projects/${pid1}/normalize`, {}, editorCookie);
      expect(res1.status, JSON.stringify(res1.data)).toBe(404);
      expect(res1.data).toEqual({ error: '项目不存在' });
    } finally {
      created.shadows.forProjectTarget = origForProjectTarget;
    }

    // 对照：活分支遇到 StepError 仍返回 422 canonicalize_failed
    const { pid: pid2 } = await newProject('兜底-StepError-活分支', 'sqlite');
    await seedCheck(pid2, 'no_such_column > 0');
    const res2 = await call('POST', `/api/projects/${pid2}/normalize`, {}, editorCookie);
    expect(res2.status, JSON.stringify(res2.data)).toBe(422);
    expect(res2.data).toMatchObject({ code: 'canonicalize_failed' });
    expect((res2.data as { error: string }).error).toContain('规范化失败（工作副本保持原样）：');
  });

  test('兜底覆盖其他类型化错误（NormalizeConflictError）：rooms.patch 被拒期间库行被删且未打 forgotten 标记 → 404；活分支仍回 409 working_changed', async () => {
    const { pid: pid1, branch: branch1 } = await newProject('兜底-Conflict-已删', 'pg');
    await seedCheck(pid1);
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });

    const origPatch = created.rooms.patch.bind(created.rooms);
    created.rooms.patch = async () => {
      await deleteBranchRows(branch1);
      return { committed: false, rejected: true, seq: 1 };
    };
    try {
      const res1 = await call('POST', `/api/projects/${pid1}/normalize`, {}, editorCookie);
      expect(res1.status, JSON.stringify(res1.data)).toBe(404);
      expect(res1.data).toEqual({ error: '项目不存在' });
    } finally {
      created.rooms.patch = origPatch;
    }

    // 对照：活分支遇到 NormalizeConflictError 仍返回 409 working_changed
    const { pid: pid2 } = await newProject('兜底-Conflict-活分支', 'pg');
    await seedCheck(pid2);
    created.rooms.patch = async () => ({ committed: false, rejected: true, seq: 1 });
    try {
      const res2 = await call('POST', `/api/projects/${pid2}/normalize`, {}, adminCookie);
      expect(res2.status, JSON.stringify(res2.data)).toBe(409);
      expect(res2.data).toEqual({
        error: '规范化期间工作副本被修改了，请重试',
        code: 'working_changed',
        currentSeq: 1,
      });
    } finally {
      created.rooms.patch = origPatch;
    }
  });

  test('兜底查库失败时保守保留原错：rooms.patch 与 branches 复查同时失败 → 500（不误吞成 404）', async () => {
    const { pid } = await newProject('兜底-查库失败保留500', 'pg');
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => ({ shadow: fake, label: 'fake-shadow' });
    await seedCheck(pid);
    created.rooms.patch = async () => {
      throw new Error('unexpected db failure');
    };

    const origQuery = db.query.bind(db);
    let branchLookupCalls = 0;
    db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes('select id from branches where id = $1')) {
        branchLookupCalls++;
        throw new Error('platform db down');
      }
      return origQuery<T>(sql, params);
    }) as typeof db.query;

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await call('POST', `/api/projects/${pid}/normalize`, {}, editorCookie);
      expect(branchLookupCalls).toBe(1);
      expect(res.status, JSON.stringify(res.data)).toBe(500);
      expect(res.data).toEqual({ error: '服务器内部错误' });
    } finally {
      db.query = origQuery;
      errSpy.mockRestore();
    }
  });

  test('兜底 404 限速退回：未解析影子库时退回额度，已解析影子库后不退回', async () => {
    const p1 = await newProject('兜底限速-未解析', 'pg');
    const p2 = await newProject('兜底限速-未解析后续', 'pg');
    const p3 = await newProject('兜底限速-已解析', 'pg');
    const p4 = await newProject('兜底限速-已解析后续', 'pg');
    await seedCheck(p1.pid);
    await seedCheck(p2.pid);
    await seedCheck(p3.pid);
    await seedCheck(p4.pid);

    let resolveCalls = 0;
    const fake = {
      canonicalize: async (_prev: Model, next: Model) =>
        Object.values(next.objects)
          .filter((o) => o.kind === 'check' && !o.expr.startsWith('('))
          .map((o) => ({ ...o, expr: `(${(o as { expr: string }).expr})` }) as Obj),
      close: async () => {},
    } as unknown as Shadow;
    created.shadows.forProjectTarget = async () => {
      resolveCalls++;
      return { shadow: fake, label: 'fake-shadow' };
    };

    // 情况 1（editorCookie）：尚未解析影子库时在锁内抛错且分支行已删（未标记 forgotten）→ 兜底 404 并退回额度
    const origState = created.rooms.state.bind(created.rooms);
    created.rooms.state = async (branchId) => {
      if (branchId === p1.branch) {
        await deleteBranchRows(p1.branch);
        throw new Error('分支不存在');
      }
      return origState(branchId);
    };
    let res1!: { status: number; data: unknown };
    try {
      res1 = await call('POST', `/api/projects/${p1.pid}/normalize`, {}, editorCookie);
    } finally {
      created.rooms.state = origState;
    }
    expect(res1.status, JSON.stringify(res1.data)).toBe(404);
    expect(res1.data).toEqual({ error: '项目不存在' });
    expect(resolveCalls).toBe(0);

    // 额度已退回：同一用户紧接着规范化另一个项目仍可成功（limit = 1 不会 429）
    const res2 = await call('POST', `/api/projects/${p2.pid}/normalize`, {}, editorCookie);
    expect(res2.status, JSON.stringify(res2.data)).toBe(200);
    expect(resolveCalls).toBe(1);

    // 情况 2（adminCookie）：已经解析影子库之后抛错走兜底 404 → 不退回限速额度
    const origPatch = created.rooms.patch.bind(created.rooms);
    created.rooms.patch = async (...args) => {
      await deleteBranchRows(p3.branch);
      return origPatch(...args);
    };
    let res3!: { status: number; data: unknown };
    try {
      res3 = await call('POST', `/api/projects/${p3.pid}/normalize`, {}, adminCookie);
    } finally {
      created.rooms.patch = origPatch;
    }
    expect(res3.status, JSON.stringify(res3.data)).toBe(404);
    expect(res3.data).toEqual({ error: '项目不存在' });
    expect(resolveCalls).toBe(2);

    // 已解析影子库，没有退回：紧接着再发起一次命中 429
    const res4 = await call('POST', `/api/projects/${p4.pid}/normalize`, {}, adminCookie);
    expect(res4.status).toBe(429);
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
      expect(res.data).toEqual({
        error:
          '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的数据库实例作影子库，请先在“环境”里添加项目要部署到的数据库',
        code: 'shadow_unavailable',
      });
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
    expect(first.data).toEqual({ error: '影子库不可用：连接被拒绝', code: 'shadow_unavailable' });
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

  test('无环境项目带待规范化对象 flush → skipped(no_shadow) 且不触发二次 branches 复核查询', async () => {
    const { pid, branch } = await newProject('无环境不重查branches', 'pg');
    await seedCheck(pid);
    const origQuery = db.query.bind(db);
    let shadowLookupQueries = 0;
    let existingCheckQueries = 0;
    db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes('select project_id from branches where id = $1')) shadowLookupQueries++;
      if (sql.includes('from branches where id in')) existingCheckQueries++;
      return origQuery<T>(sql, params);
    }) as typeof db.query;
    try {
      const out = await created.refresher.flush(branch);
      expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'no_shadow' });
      expect(shadowLookupQueries).toBe(1);
      expect(existingCheckQueries).toBe(0);
    } finally {
      db.query = origQuery;
    }
  });
});
