// 删除项目（P2 遗留）：只有项目管理员能删，请求体必须原样带项目标识；
// 平台库里这个项目的数据在一个事务里全部删掉，审计记录保留；在线的连接用 4403 断开。
// SQLite 和 PG 各跑一遍（删除顺序、外键、事务行为都要在两种方言上一致）。
import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { addTable, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'delete-test-secret-0123456789';

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('删除项目（平台库：$platform）', ({ platform, skip }) => {
  let db: PlatformDb;
  let base = '';
  let stop: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  let platformDb: Awaited<ReturnType<typeof createTestDb>> | undefined;

  const call = async (cookie: string, method: string, path: string, json?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: r.status, data: data as Record<string, unknown> };
  };

  const login = async (username: string) => {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(r.status, username).toBe(200);
    return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  };

  beforeAll(async () => {
    if (skip) return;
    if (platform === 'pg') platformDb = await createTestDb('delete');
    db = await openPlatformDb(platformDb?.url ?? ':memory:');
    const created = createApp(db);
    app = created;
    const server = serve({ fetch: created.app.fetch, port: 0 });
    created.injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = async () => {
      await created.rooms.flush();
      await created.shadows.close();
      await new Promise((r) => server.close(r));
    };
  });

  afterAll(async () => {
    if (skip) return;
    await stop();
    await db.close();
    await platformDb?.close();
  });

  /** 建一个带组、项目、分支、版本、环境、授权、旧地址的项目 */
  const seed = async (mark: string) => {
    const admin = await makeUser(db, `admin-${mark}`, { role: 'admin' });
    const viewer = await makeUser(db, `viewer-${mark}`);
    const adminCookie = await login(admin.username);
    const viewerCookie = await login(viewer.username);

    const group = await call(adminCookie, 'POST', '/api/groups', {
      slug: `g-${mark}`,
      name: `组 ${mark}`,
    });
    expect(group.status).toBe(201);
    const gid = group.data.id as string;
    const p = await call(adminCookie, 'POST', '/api/projects', {
      name: `项目 ${mark}`,
      groupId: gid,
    });
    expect(p.status).toBe(201);
    const pid = p.data.id as string;
    const slug = p.data.slug as string;

    // 给查看者一个项目授权（删除项目时要一起清掉）
    expect(
      (
        await call(adminCookie, 'POST', `/api/projects/${pid}/grants`, {
          subjectKind: 'user',
          subjectId: viewer.id,
          role: 'viewer',
        })
      ).status,
    ).toBe(201);
    // 一个版本：让 versions 里有数据（空的工作副本发布会得到“没有变更”，先加一张表）
    await addTable(app.rooms, db, pid);
    expect((await call(adminCookie, 'POST', `/api/projects/${pid}/versions`, { name: 'v1' })).status).toBe(
      201,
    );
    // 一个环境：直接写库（走接口会真去连目标库，这里只关心删除时清不清数据）
    await db.query(
      `insert into environments (id, project_id, name, url_enc, production)
       values ($1, $2, 'dev', 'encrypted-placeholder', $3)`,
      [`env-${mark}`, pid, false],
    );
    // 一条旧地址跳转记录
    await db.query(
      `insert into project_redirects (owner_slug, project_slug, project_id) values ($1, $2, $3)`,
      [group.data.slug as string, 'old-name', pid],
    );
    // 一个 CI 令牌和一条项目层令牌创建规则（删除项目时一并清理）
    expect((await call(adminCookie, 'POST', `/api/projects/${pid}/tokens`, { name: 'ci' })).status).toBe(201);
    expect(
      (
        await call(adminCookie, 'PUT', `/api/projects/${pid}/token-policy`, {
          rule: { roles: ['admin'], groups: [] },
        })
      ).status,
    ).toBe(200);
    return { adminCookie, viewerCookie, pid, slug, gid, envId: `env-${mark}` };
  };

  const until = async (cond: () => boolean, ms = 5000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  test.skipIf(skip)('非项目管理员不能删除，确认文字不对也不行', async () => {
    const { adminCookie, viewerCookie, pid, slug } = await seed('guard');
    // 查看者：能看但不够权限 → 403
    expect((await call(viewerCookie, 'DELETE', `/api/projects/${pid}`, { confirm: slug })).status).toBe(403);
    // 无关用户：看不到项目 → 404
    await makeUser(db, 'outsider-guard');
    const outsiderCookie = await login('outsider-guard');
    expect((await call(outsiderCookie, 'DELETE', `/api/projects/${pid}`, { confirm: slug })).status).toBe(
      404,
    );
    // 确认文字不匹配 / 缺字段 → 400，项目还在
    expect((await call(adminCookie, 'DELETE', `/api/projects/${pid}`, { confirm: 'wrong' })).status).toBe(
      400,
    );
    expect((await call(adminCookie, 'DELETE', `/api/projects/${pid}`, {})).status).toBe(400);
    expect((await call(adminCookie, 'GET', `/api/projects/${pid}`)).status).toBe(200);
  });

  test.skipIf(skip)('删除后平台库里这个项目的数据全部消失，审计记录保留', async () => {
    const { adminCookie, pid, slug, envId } = await seed('wipe');
    const [branch] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
    // 在线连接：删除时应该收到 4403
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pid}/sync`, {
      headers: { cookie: adminCookie },
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((r) => ws.once('open', r));
    await until(() => app.rooms.has(branch!.id));

    // 内存里的三份缓存先都有东西：房间已加载、影子库连接（这里用 forget 的调用作为证据）、
    // 派生刷新的内存基线（按需规范化后没有后台定时器，ADR 0016）
    const forgetShadow = vi.spyOn(app.shadows, 'forget');
    await app.refresher.reset(branch!.id, (await app.rooms.model(branch!.id)).model);
    expect(app.refresher.tracked(branch!.id)).toBe(true);
    const published = vi.spyOn(app.bus, 'publish');

    const res = await call(adminCookie, 'DELETE', `/api/projects/${pid}`, { confirm: slug });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(await closed).toBe(4403);

    // 跨副本（Issue #153）：derive.forget 带上被删分支，且先于踢房间（room.refresh）与关影子库（shadows.forget）发出——
    // 其他副本按同样的先后处理，在途任务因房间被踢 / 影子库关闭抛错时已经看得到 forgotten
    const kinds = published.mock.calls.map(([e]) => e.t);
    expect(published.mock.calls.map(([e]) => e)).toContainEqual({
      t: 'derive.forget',
      branchIds: [branch!.id],
    });
    expect(kinds.indexOf('derive.forget')).toBeLessThan(kinds.indexOf('room.refresh'));
    expect(kinds.indexOf('derive.forget')).toBeLessThan(kinds.indexOf('shadows.forget'));
    published.mockRestore();

    // 内存状态在事务提交后清理：房间卸载、影子库缓存移除、派生刷新状态清空。
    // 房间这里等一下：连接关闭时 onClose 会再去加载一次已经不存在的分支，失败的加载会把自己从缓存里删掉。
    await until(() => !app.rooms.has(branch!.id));
    expect(app.rooms.has(branch!.id)).toBe(false);
    expect(forgetShadow).toHaveBeenCalledWith(envId);
    expect(app.shadows.has(envId)).toBe(false);
    expect(app.refresher.tracked(branch!.id)).toBe(false);
    forgetShadow.mockRestore();

    const count = async (sql: string, params: unknown[] = []) =>
      Number((await db.query<{ n: number }>(sql, params))[0]?.n ?? 0);
    expect(await count('select count(*) as n from projects where id = $1', [pid])).toBe(0);
    expect(await count('select count(*) as n from branches where project_id = $1', [pid])).toBe(0);
    expect(await count('select count(*) as n from room_snapshots where branch_id = $1', [branch!.id])).toBe(
      0,
    );
    expect(await count('select count(*) as n from room_commits where branch_id = $1', [branch!.id])).toBe(0);
    expect(await count('select count(*) as n from versions where project_id = $1', [pid])).toBe(0);
    expect(await count('select count(*) as n from environments where project_id = $1', [pid])).toBe(0);
    expect(
      await count("select count(*) as n from grants where scope_kind = 'project' and scope_id = $1", [pid]),
    ).toBe(0);
    expect(await count('select count(*) as n from project_redirects where project_id = $1', [pid])).toBe(0);
    expect(await count('select count(*) as n from ci_tokens where project_id = $1', [pid])).toBe(0);
    expect(
      await count("select count(*) as n from token_policies where scope_kind = 'project' and scope_id = $1", [
        pid,
      ]),
    ).toBe(0);
    // 审计记录保留，动作是 project.delete
    const audit = await db.query<{ action: string; projectId: string | null }>(
      `select action, project_id as "projectId" from audit_events
        where action = 'project.delete' and target_id = $1`,
      [pid],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.projectId).toBe(pid);
    // 删掉之后再访问：404（项目不存在）
    expect((await call(adminCookie, 'GET', `/api/projects/${pid}`)).status).toBe(404);
  });

  test.skipIf(skip)(
    '删除进行中排队的导出 DDL / 迁移预览 / MCP 读取统一返回 404 / project_not_found，不返回 200 空模型',
    async () => {
      const { adminCookie, pid, slug } = await seed('queued-flush');
      const [branch] = await db.query<{ id: string }>('select id from branches where project_id = $1', [pid]);
      const branchId = branch!.id;

      const tokRes = await call(adminCookie, 'POST', '/api/me/mcp-tokens', { name: 'del-race' });
      expect(tokRes.status, JSON.stringify(tokRes.data)).toBe(201);
      const mcpToken = tokRes.data.token as string;

      const mcpCall = async (method: string, params: Record<string, unknown>) => {
        const r = await fetch(`${base}/api/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${mcpToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const text = await r.text();
        const ct = r.headers.get('content-type') ?? '';
        const payload = ct.includes('text/event-stream')
          ? text
              .split(/\r?\n/)
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .filter(Boolean)
              .at(-1)!
          : text;
        return {
          status: r.status,
          rpc: JSON.parse(payload) as {
            result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
            error?: { code: number; message: string };
          },
        };
      };

      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        return { promise, resolve };
      };

      const gate = deferred();
      const allQueued = deferred();
      let queuedCount = 0;
      const origFlush = app.refresher.flush.bind(app.refresher);
      app.refresher.flush = (b) => {
        const p = origFlush(b);
        if (++queuedCount === 4) allQueued.resolve();
        return p;
      };

      const blocker = app.refresher.runWithoutReset(branchId, () => gate.promise);
      let ddlRes!: { status: number; data: unknown };
      let migRes!: { status: number; data: unknown };
      let mcpToolRes!: Awaited<ReturnType<typeof mcpCall>>;
      let mcpResourceRes!: Awaited<ReturnType<typeof mcpCall>>;
      try {
        const p1 = call(adminCookie, 'GET', `/api/projects/${pid}/ddl`);
        const p2 = call(adminCookie, 'GET', `/api/projects/${pid}/migration`);
        const p3 = mcpCall('tools/call', { name: 'get_ddl', arguments: { project: pid } });
        const p4 = mcpCall('resources/read', { uri: `dowel://projects/g-queued-flush/${slug}/ddl` });
        await allQueued.promise;

        const delRes = await call(adminCookie, 'DELETE', `/api/projects/${pid}`, { confirm: slug });
        expect(delRes.status, JSON.stringify(delRes.data)).toBe(200);

        gate.resolve();
        await blocker;
        [ddlRes, migRes, mcpToolRes, mcpResourceRes] = await Promise.all([p1, p2, p3, p4]);
      } finally {
        gate.resolve();
        app.refresher.flush = origFlush;
        await blocker.catch(() => {});
      }

      expect(ddlRes.status, JSON.stringify(ddlRes.data)).toBe(404);
      expect(ddlRes.data).toEqual({ error: '项目不存在' });
      expect(migRes.status, JSON.stringify(migRes.data)).toBe(404);
      expect(migRes.data).toEqual({ error: '项目不存在' });

      expect(mcpToolRes.status).toBe(200);
      expect(mcpToolRes.rpc.result?.isError).toBe(true);
      expect(mcpToolRes.rpc.result?.structuredContent).toMatchObject({
        code: 'project_not_found',
        message: '项目不存在',
      });

      expect(mcpResourceRes.rpc.error).toBeDefined();
      expect(mcpResourceRes.rpc.error?.code).toBe(-32602);
      expect(mcpResourceRes.rpc.error?.message).toContain('项目不存在');
    },
  );
});
