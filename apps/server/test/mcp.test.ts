import {
  type CanvasSection,
  MCP_MAX_EXPANDED_OPS,
  MCP_SUMMARY_MAX,
  MCP_TOOLS,
  type McpScope,
  type McpToolName,
} from '@dowel/api';
import {
  addColumn,
  all,
  BATCH_OPS_LIMIT,
  BATCH_SUMMARY_MAX,
  createSchema,
  createTable,
  getDialect,
  newId,
} from '@dowel/core';
import type { Commit, ToClient } from '@dowel/sync';
// M3-C MCP 服务集成测试（ADR 0014）：
// 在 SQLite 与 PostgreSQL 两种平台库下通过真实 app.request 测试完整的 JSON-RPC 传输（2025-11-25 与 2026-07-28）、
// 12 个工具（含 manage_sections 增量板块）、6 个资源/模板、scope ∩ 生效角色 ∩ 白名单鉴权、Rooms.applyMcpOps（$ref / baseSeq / dryRun / 冲突回滚 / 历史 / 审计）、
// 影子库 verify_migration 与用户级限流、list_environments 仅读平台缓存以及 HTTP 安全守卫（405 / 415 / 413 / 403）。
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { newMcpToken } from '../src/mcp-tokens.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import type { Extra, Peer } from '../src/rooms.ts';
import { encrypt } from '../src/secrets.ts';
import { type Shadow, ShadowUnavailableError } from '../src/shadow.ts';
import { addTable, editModel, makeUser, PASSWORD } from './support.ts';

const SECTION_ID_RE = /^sec-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

process.env.DOWEL_SECRET ??= 'mcp-test-secret-key-0123456789abcdef';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const parseRpc = async (res: Response) => {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const lines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    const last = lines.at(-1);
    if (!last) throw new Error(`SSE 响应为空: ${text}`);
    return JSON.parse(last) as {
      jsonrpc: string;
      id: number | string | null;
      result?: Record<string, unknown>;
      error?: { code: number; message: string; data?: unknown };
    };
  }
  return JSON.parse(text) as {
    jsonrpc: string;
    id: number | string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
  };
};

interface ToolCallEnvelope {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  resultType?: string;
}

const makePeer = (user: User, role: Peer['role'] = 'editor') => {
  const sent: (ToClient | Extra)[] = [];
  const peer: Peer = {
    user,
    role,
    send: (msg) => sent.push(structuredClone(msg)),
    close: () => {},
  };
  return { peer, sent };
};

test('MCP 批量上限与 core batch 上限保持一致', () => {
  expect(MCP_MAX_EXPANDED_OPS).toBe(BATCH_OPS_LIMIT);
  expect(MCP_SUMMARY_MAX).toBe(BATCH_SUMMARY_MAX);
});

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('MCP 服务端集成（平台库：$platform）', ({ platform, skip }) => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  const setupEnv = async (opts?: { connectionLimiter?: KeyedLimiter }) => {
    let pg: Awaited<ReturnType<typeof createTestDb>> | undefined;
    let db: PlatformDb;
    if (platform === 'pg') {
      pg = await createTestDb('mcp_srv');
      db = await openPlatformDb(pg.url);
    } else {
      db = await openPlatformDb(':memory:');
    }
    const created = createApp(db, {
      loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
      connectionLimiter: opts?.connectionLimiter,
      mailer: async () => {},
    });
    const close = async () => {
      created.refresher.stop();
      await created.refresher.drain();
      created.rooms.close();
      await created.rooms.flush();
      await created.shadows.close();
      await created.bus.close();
      await db.close();
      await pg?.close();
    };
    cleanups.push(close);

    const callHttp = async (method: string, path: string, json?: unknown, cookie = '') => {
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
      return {
        status: r.status,
        data: data as Record<string, unknown>,
        cookie: r.headers.get('set-cookie')?.split(';')[0] ?? '',
      };
    };

    const admin = await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(db, 'alice', { name: '爱丽丝' });
    const bob = await makeUser(db, 'bob', { name: '鲍勃' });
    const outsider = await makeUser(db, 'outsider', { name: '局外人' });

    const adminLogin = await callHttp('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    expect(adminLogin.status).toBe(200);
    const adminCookie = adminLogin.cookie;

    const grp = await callHttp(
      'POST',
      '/api/groups',
      { slug: 'acme', name: 'Acme', defaultRole: 'none' },
      adminCookie,
    );
    expect(grp.status).toBe(201);
    const groupId = grp.data.id as string;

    const p1Res = await callHttp(
      'POST',
      '/api/projects',
      { name: 'Orders', groupId, dialect: 'pg' },
      adminCookie,
    );
    expect(p1Res.status).toBe(201);
    const p1Id = p1Res.data.id as string;

    const p2Res = await callHttp(
      'POST',
      '/api/projects',
      { name: 'Billing', groupId, dialect: 'sqlite' },
      adminCookie,
    );
    expect(p2Res.status).toBe(201);
    const p2Id = p2Res.data.id as string;

    // 爱丽丝是 p1/p2 编辑者；鲍勃是 p1/p2 查看者；局外人没有任何项目权限
    for (const pid of [p1Id, p2Id]) {
      expect(
        (
          await callHttp(
            'POST',
            `/api/projects/${pid}/grants`,
            { subjectKind: 'user', subjectId: alice.id, role: 'editor' },
            adminCookie,
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await callHttp(
            'POST',
            `/api/projects/${pid}/grants`,
            { subjectKind: 'user', subjectId: bob.id, role: 'viewer' },
            adminCookie,
          )
        ).status,
      ).toBe(201);
    }

    const [b1] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [p1Id],
    );
    const [b2] = await db.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [p2Id],
    );
    const branch1 = b1!.id;
    const branch2 = b2!.id;

    const issueToken = async (
      userId: string,
      scopes: McpScope[],
      projectIds: string[] | null = null,
      name = 'tok',
    ) => {
      const t = newMcpToken();
      const id = newId();
      await db.query(
        `insert into mcp_tokens (id, user_id, kind, name, prefix, token_hash, scopes, project_ids, expires_at)
         values ($1, $2, 'personal', $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8)`,
        [
          id,
          userId,
          name,
          t.prefix,
          t.hash,
          JSON.stringify(scopes),
          projectIds ? JSON.stringify(projectIds) : null,
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
      );
      return { id, name, ...t };
    };

    const mcpPost = (token: string, body: unknown, headers: Record<string, string> = {}) =>
      created.app.request('/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    const callTool = async (
      token: string,
      name: string,
      args: Record<string, unknown> = {},
      era: '2025' | '2026' = '2025',
    ) => {
      const params: Record<string, unknown> = { name, arguments: args };
      const extraHeaders: Record<string, string> = {};
      if (era === '2026') {
        params._meta = {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'test-2026', version: '1.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        };
        extraHeaders['MCP-Protocol-Version'] = '2026-07-28';
        extraHeaders['Mcp-Method'] = 'tools/call';
        extraHeaders['Mcp-Name'] = name;
      }
      const res = await mcpPost(
        token,
        {
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1_000_000) + 1,
          method: 'tools/call',
          params,
        },
        extraHeaders,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      const parsed = await parseRpc(res);
      return parsed.result as ToolCallEnvelope;
    };

    return {
      db,
      created,
      admin,
      alice,
      bob,
      outsider,
      adminCookie,
      groupId,
      p1Id,
      p2Id,
      branch1,
      branch2,
      callHttp,
      issueToken,
      mcpPost,
      callTool,
    };
  };

  test.skipIf(skip)('协议握手（2025-11-25 与 2026-07-28）、HTTP 守卫与 tools/list scope 过滤', async () => {
    const f = await setupEnv();
    const tokRead = await f.issueToken(f.alice.id, ['read']);
    const tokVerify = await f.issueToken(f.alice.id, ['read', 'verify']);
    const tokAll = await f.issueToken(f.alice.id, ['read', 'verify', 'write']);

    // 1. 2025-11-25 initialize / notifications/initialized / ping
    const initRes = await f.mcpPost(tokRead.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'vitest', version: '1.0' },
      },
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('mcp-session-id')).toBeNull();
    const initBody = await parseRpc(initRes);
    expect(initBody.result?.serverInfo).toMatchObject({ name: 'dowel' });
    expect(initBody.result?.instructions as string).toContain('get_model');
    expect(initBody.result?.instructions as string).toContain('apply_changes');

    const notifRes = await f.mcpPost(tokRead.token, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notifRes.status).toBe(202);

    const pingRes = await f.mcpPost(tokRead.token, { jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(pingRes.status).toBe(200);
    expect((await parseRpc(pingRes)).result).toEqual({});

    // 2. 2026-07-28 风格请求：tools/list 与 tools/call
    const list2026Res = await f.mcpPost(
      tokRead.token,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'test-2026', version: '1.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      },
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
    );
    expect(list2026Res.status).toBe(200);
    expect(list2026Res.headers.get('content-type')).toContain('application/json');
    expect(list2026Res.headers.get('mcp-session-id')).toBeNull();
    const list2026 = await parseRpc(list2026Res);
    const readToolNames = ((list2026.result?.tools as { name: string }[]) ?? []).map((t) => t.name).sort();
    expect(readToolNames).toEqual(
      (Object.keys(MCP_TOOLS) as McpToolName[]).filter((n) => MCP_TOOLS[n].scope === 'read').sort(),
    );

    // 2026-07-28 tools/call 返回 resultType: 'complete'
    const call2026 = await f.callTool(tokRead.token, 'list_projects', {}, '2026');
    expect(call2026.resultType).toBe('complete');
    expect((call2026.structuredContent!.projects as unknown[]).length).toBe(2);

    // 3. scope 过滤 + annotations 校验
    const listVerify = await parseRpc(
      await f.mcpPost(tokVerify.token, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    );
    expect(((listVerify.result?.tools as { name: string }[]) ?? []).map((t) => t.name)).toContain(
      'verify_migration',
    );
    expect(((listVerify.result?.tools as { name: string }[]) ?? []).map((t) => t.name)).not.toContain(
      'apply_changes',
    );

    const listAll = await parseRpc(
      await f.mcpPost(tokAll.token, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} }),
    );
    const toolsAll = listAll.result?.tools as {
      name: string;
      inputSchema: { type: string };
      annotations: { openWorldHint: boolean; readOnlyHint: boolean };
    }[];
    expect(toolsAll.map((t) => t.name).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
    for (const t of toolsAll) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations.openWorldHint).toBe(false);
    }

    // 缺少 scope 时 tools/call 返回结构化 scope_required 错误
    const deniedWrite = await f.callTool(tokRead.token, 'apply_changes', {
      project: f.p1Id,
      baseSeq: 0,
      ops: [{ name: 'createSchema', args: { id: newId(), name: 'x' } }],
    });
    expect(deniedWrite.isError).toBe(true);
    expect(deniedWrite.structuredContent?.code).toBe('scope_required');

    // 4. HTTP 守卫：405 / 415 / 413 / 403
    const getRes = await f.created.app.request('/api/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${tokRead.token}` },
    });
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get('allow')).toBe('POST');

    const delRes = await f.created.app.request('/api/mcp', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokRead.token}` },
    });
    expect(delRes.status).toBe(405);
    expect(delRes.headers.get('allow')).toBe('POST');

    const ctRes = await f.created.app.request('/api/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokRead.token}`,
        'content-type': 'text/plain',
      },
      body: 'hello',
    });
    expect(ctRes.status).toBe(415);

    const bigBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'ping',
      pad: 'x'.repeat(1024 * 1024 + 32),
    });
    const bigRes = await f.mcpPost(tokRead.token, bigBody);
    expect(bigRes.status).toBe(413);

    const originRes = await f.mcpPost(
      tokRead.token,
      { jsonrpc: '2.0', id: 10, method: 'ping' },
      { origin: 'https://evil.example' },
    );
    expect(originRes.status).toBe(403);
  });

  test.skipIf(skip)('只读工具、重定向路径、项目白名单、角色鉴权、资源模板与 >200 表截断', async () => {
    const f = await setupEnv();
    await addTable(f.created.rooms, f.db, f.p1Id, 'orders');

    // 发布 v1
    const pub = await f.callHttp(
      'POST',
      `/api/projects/${f.p1Id}/versions`,
      { name: 'init orders' },
      f.adminCookie,
    );
    expect(pub.status).toBe(201);
    const v1Id = pub.data.id as string;

    // 制造工作副本未发布变更（再加一张 items 表）
    await addTable(f.created.rooms, f.db, f.p1Id, 'items');

    // 给 p1 加一条 project_redirect（模拟曾经改过 slug: old-acme/legacy-orders -> p1）
    await f.db.query(
      'insert into project_redirects (owner_slug, project_slug, project_id) values ($1, $2, $3)',
      ['old-acme', 'legacy-orders', f.p1Id],
    );

    const tokAlice = await f.issueToken(f.alice.id, ['read', 'verify', 'write']);
    const tokAliceOnlyP1 = await f.issueToken(f.alice.id, ['read', 'write'], [f.p1Id], 'p1-only');
    const tokBobViewer = await f.issueToken(f.bob.id, ['read', 'write']);
    const tokOutsider = await f.issueToken(f.outsider.id, ['read']);

    // list_projects（含白名单与 group 过滤）
    const lp = await f.callTool(tokAliceOnlyP1.token, 'list_projects', { group: 'acme' });
    expect(lp.isError).toBeFalsy();
    const lpProjects = lp.structuredContent?.projects as {
      id: string;
      latestVersion: { number: number } | null;
    }[];
    expect(lpProjects.map((p) => p.id)).toEqual([f.p1Id]);
    expect(lpProjects[0]!.latestVersion?.number).toBe(1);

    // 白名单拦截 p2（返回 project_not_found，不泄露存在性）
    const p2Denied = await f.callTool(tokAliceOnlyP1.token, 'get_model', { project: 'acme/billing' });
    expect(p2Denied.isError).toBe(true);
    expect(p2Denied.structuredContent?.code).toBe('project_not_found');

    // 局外人不可见（project_not_found）
    const outsiderDenied = await f.callTool(tokOutsider.token, 'get_model', { project: f.p1Id });
    expect(outsiderDenied.isError).toBe(true);
    expect(outsiderDenied.structuredContent?.code).toBe('project_not_found');

    // 查看者鲍勃无法 apply_changes（forbidden）
    const viewerDenied = await f.callTool(tokBobViewer.token, 'apply_changes', {
      project: f.p1Id,
      baseSeq: 2,
      ops: [{ name: 'createSchema', args: { id: newId(), name: 'nope' } }],
    });
    expect(viewerDenied.isError).toBe(true);
    expect(viewerDenied.structuredContent?.code).toBe('forbidden');

    // 通过旧重定向路径与 full detail 读模型
    const gmRedirect = await f.callTool(tokAlice.token, 'get_model', {
      project: 'old-acme/legacy-orders',
      detail: 'full',
    });
    expect(gmRedirect.isError).toBeFalsy();
    expect(gmRedirect.structuredContent?.seq).toBe(2);
    expect(gmRedirect.structuredContent?.truncated).toBe(false);
    const gmObjs = gmRedirect.structuredContent?.objects as Record<
      string,
      { kind: string; name: string; ver: number }
    >;
    expect(
      Object.values(gmObjs)
        .filter((o) => o.kind === 'table')
        .map((o) => o.name)
        .sort(),
    ).toEqual(['items', 'orders']);

    // get_table 支持 name / schema.name / id
    const gt = await f.callTool(tokAlice.token, 'get_table', {
      project: 'acme/orders',
      table: 'public.orders',
    });
    expect(gt.isError).toBeFalsy();
    expect(gt.structuredContent?.seq).toBe(2);
    expect((gt.structuredContent!.table as { id: string; ver: number }).id).toBeTruthy();
    expect((gt.structuredContent!.columns as { name: string }[]).map((c) => c.name)).toEqual(['id']);

    const gtMiss = await f.callTool(tokAlice.token, 'get_table', { project: f.p1Id, table: 'no_such_table' });
    expect(gtMiss.isError).toBe(true);
    expect(gtMiss.structuredContent?.code).toBe('table_not_found');

    // get_ddl 支持 head / v1 / id
    const ddlV1 = await f.callTool(tokAlice.token, 'get_ddl', { project: f.p1Id, version: 'v1' });
    expect(ddlV1.isError).toBeFalsy();
    expect(ddlV1.structuredContent?.sql as string).toContain('public.orders');
    expect(ddlV1.structuredContent?.sql as string).not.toContain('public.items');

    const ddlHead = await f.callTool(tokAlice.token, 'get_ddl', { project: f.p1Id, version: 'head' });
    expect(ddlHead.isError).toBeFalsy();
    expect(ddlHead.structuredContent?.sql as string).toContain('public.items');

    // list_versions & get_version
    const lv = await f.callTool(tokAlice.token, 'list_versions', { project: f.p1Id, limit: 10 });
    expect((lv.structuredContent!.versions as { id: string }[]).map((v) => v.id)).toEqual([v1Id]);

    const gv = await f.callTool(tokAlice.token, 'get_version', { project: f.p1Id, version: 'latest' });
    expect(gv.isError).toBeFalsy();
    expect((gv.structuredContent!.version as { checksum: string; upSteps: unknown[] }).checksum).toBeTruthy();

    // preview_migration（默认 latest -> head：只建 items 表）
    const pm = await f.callTool(tokAlice.token, 'preview_migration', { project: f.p1Id });
    expect(pm.isError).toBeFalsy();
    expect(pm.structuredContent?.from).toBe('v1');
    expect(pm.structuredContent?.to).toBe('head');
    expect(pm.structuredContent?.upSql as string).toContain('public.items');
    expect(pm.structuredContent?.downSql as string).toContain('DROP TABLE');

    // list_mutators
    const lm = await f.callTool(tokAlice.token, 'list_mutators', { names: ['createTable', 'addColumn'] });
    expect(lm.isError).toBeFalsy();
    expect((lm.structuredContent!.mutators as { name: string }[]).map((m) => m.name)).toEqual([
      'createTable',
      'addColumn',
    ]);

    // >200 表截断保护：在 p2 插入 205 张表后不传 schema 请求 detail='full'
    await editModel(f.created.rooms, f.db, f.p2Id, (m) => {
      const schemaId = all(m, 'schema')[0]?.id;
      const sid = schemaId ?? newId();
      if (!schemaId) m.objects[sid] = { id: sid, kind: 'schema', name: 'main', comment: null };
      for (let i = 0; i < 205; i++) {
        const tid = newId();
        m.objects[tid] = {
          id: tid,
          kind: 'table',
          parent: sid,
          name: `tbl_${i}`,
          partitionBy: null,
          partitionOf: null,
          comment: null,
        };
      }
    });
    const fullLarge = await f.callTool(tokAlice.token, 'get_model', { project: f.p2Id, detail: 'full' });
    expect(fullLarge.isError).toBeFalsy();
    expect(fullLarge.structuredContent?.truncated).toBe(true);
    expect(fullLarge.structuredContent?.totalTables).toBe(205);

    // 传入 schema 过滤仍按 205 判断？不，单 schema 也超过 200 时若未过滤才截断，传了 schema 则返回完整 objects
    const fullScoped = await f.callTool(tokAlice.token, 'get_model', {
      project: f.p2Id,
      schema: 'main',
      detail: 'full',
    });
    expect(fullScoped.isError).toBeFalsy();
    expect(fullScoped.structuredContent?.truncated).toBe(false);

    // MCP Resources & Templates
    const resList = await parseRpc(
      await f.mcpPost(tokAlice.token, { jsonrpc: '2.0', id: 20, method: 'resources/list', params: {} }),
    );
    expect(((resList.result?.resources as { uri: string }[]) ?? []).map((r) => r.uri).sort()).toEqual([
      'dowel://mutators',
      'dowel://projects',
    ]);

    const tplList = await parseRpc(
      await f.mcpPost(tokAlice.token, {
        jsonrpc: '2.0',
        id: 21,
        method: 'resources/templates/list',
        params: {},
      }),
    );
    expect(
      ((tplList.result?.resourceTemplates as { uriTemplate: string }[]) ?? [])
        .map((r) => r.uriTemplate)
        .sort(),
    ).toEqual([
      'dowel://projects/{owner}/{project}/ddl',
      'dowel://projects/{owner}/{project}/environments',
      'dowel://projects/{owner}/{project}/model',
      'dowel://projects/{owner}/{project}/versions',
    ]);

    for (const uri of [
      'dowel://projects',
      'dowel://mutators',
      'dowel://projects/acme/orders/model',
      'dowel://projects/acme/orders/ddl',
      'dowel://projects/acme/orders/versions',
      'dowel://projects/acme/orders/environments',
    ]) {
      const readRes = await parseRpc(
        await f.mcpPost(tokAlice.token, {
          jsonrpc: '2.0',
          id: 22,
          method: 'resources/read',
          params: { uri },
        }),
      );
      expect(readRes.error).toBeUndefined();
      const contents = readRes.result?.contents as { text: string; mimeType: string }[];
      expect(contents.length).toBe(1);
      expect(contents[0]!.text.length).toBeGreaterThan(0);
    }

    // 局外人读取受限资源返回 JSON-RPC 错误
    const deniedRead = await parseRpc(
      await f.mcpPost(tokOutsider.token, {
        jsonrpc: '2.0',
        id: 23,
        method: 'resources/read',
        params: { uri: 'dowel://projects/acme/orders/model' },
      }),
    );
    expect(deniedRead.error).toBeDefined();
  });

  test.skipIf(skip)(
    'apply_changes 原子批处理、$ref 展开、dryRun、并发冲突/删除不污染拒绝表、WS 广播与画布历史标记 via=mcp',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'verify', 'write'], null, 'cursor-dev');
      const peerHuman = makePeer(f.admin, 'admin');
      await f.created.rooms.join(f.branch1, peerHuman.peer);
      await f.created.rooms.message(f.branch1, peerHuman.peer, {
        t: 'hello',
        client: 'ws-admin',
        lastSeq: 0,
      });

      const baseModel = (await f.created.rooms.model(f.branch1)).model;
      const publicSchemaId = all(baseModel, 'schema')[0]!.id;

      // 1. dryRun: true 不修改 seq，不写审计，返回 refs 和 changed
      const dryRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 0,
        dryRun: true,
        ops: [
          { name: 'createSchema', args: { id: '$ref:s_dry', name: 'dry_schema' } },
          { name: 'createTable', args: { id: '$ref:t_dry', schema: '$ref:s_dry', name: 'dry_tbl' } },
        ],
      });
      expect(dryRes.isError).toBeFalsy();
      expect(dryRes.structuredContent?.dryRun).toBe(true);
      expect(dryRes.structuredContent?.seq).toBe(1);
      expect(dryRes.structuredContent?.opCount).toBe(2);
      expect(dryRes.structuredContent?.diagnostics).toMatchObject({
        target: null,
        validation: { total: 0, items: [] },
        compatibility: { errors: { total: 0 }, warnings: { total: 0 } },
        blocksPublish: false,
      });
      expect(dryRes.structuredContent?.refs).toMatchObject({
        s_dry: expect.stringMatching(UUID_RE),
        t_dry: expect.stringMatching(UUID_RE),
      });
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(0);
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toEqual([]);

      // 2. baseSeq 超过当前 seq -> base_seq_ahead
      const aheadRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 99,
        ops: [{ name: 'createSchema', args: { id: '$ref:s', name: 'x' } }],
      });
      expect(aheadRes.isError).toBe(true);
      expect(aheadRes.structuredContent?.code).toBe('base_seq_ahead');
      expect(aheadRes.structuredContent?.currentSeq).toBe(0);

      // 3. $ref 一批建表 + 多列 + 主键 + 外键：整批 1 个 seq / 1 次 WS 广播 / 1 条画布历史（via='mcp' + opSummary）
      const batchRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: 'acme/orders',
        baseSeq: 0,
        summary: '  新增 users / orders 表与外键  ',
        ops: [
          { name: 'createTable', args: { id: '$ref:users', schema: publicSchemaId, name: 'users' } },
          {
            name: 'addColumn',
            args: {
              table: '$ref:users',
              column: { id: '$ref:u_id', name: 'id', type: 'bigint', notNull: true },
            },
          },
          { name: 'setPrimaryKey', args: { id: '$ref:u_pk', table: '$ref:users', columns: ['$ref:u_id'] } },
          { name: 'createTable', args: { id: '$ref:orders', schema: publicSchemaId, name: 'orders' } },
          {
            name: 'addColumn',
            args: {
              table: '$ref:orders',
              column: { id: '$ref:o_id', name: 'id', type: 'bigint', notNull: true },
            },
          },
          {
            name: 'addColumn',
            args: {
              table: '$ref:orders',
              column: { id: '$ref:o_uid', name: 'user_id', type: 'bigint', notNull: true },
            },
          },
          { name: 'setPrimaryKey', args: { id: '$ref:o_pk', table: '$ref:orders', columns: ['$ref:o_id'] } },
          {
            name: 'addForeignKey',
            args: {
              id: '$ref:o_fk',
              table: '$ref:orders',
              columns: ['$ref:o_uid'],
              refTable: '$ref:users',
              refColumns: ['$ref:u_id'],
            },
          },
        ],
      });
      expect(batchRes.isError).toBeFalsy();
      expect(batchRes.structuredContent?.dryRun).toBe(false);
      expect(batchRes.structuredContent?.seq).toBe(1);
      expect(batchRes.structuredContent?.opCount).toBe(8);
      expect(batchRes.structuredContent).not.toHaveProperty('committed');
      expect(batchRes.structuredContent?.noop).toBeUndefined();
      expect(batchRes.structuredContent?.diagnostics).toMatchObject({ blocksPublish: false });
      const refs = batchRes.structuredContent?.refs as Record<string, string>;
      expect(Object.keys(refs).sort()).toEqual([
        'o_fk',
        'o_id',
        'o_pk',
        'o_uid',
        'orders',
        'u_id',
        'u_pk',
        'users',
      ]);
      for (const v of Object.values(refs)) expect(v).toMatch(UUID_RE);

      // WS peer 只收到 1 个 commit 广播（含整批净变化），且署名人为人类用户名“爱丽丝”
      const wsCommits = peerHuman.sent.filter((m): m is Commit => m.t === 'commit');
      expect(wsCommits.map((c) => c.seq)).toEqual([1]);
      expect(wsCommits[0]!.changes.map((c) => c.id).sort()).toEqual(Object.values(refs).sort());
      expect(wsCommits.every((c) => c.user === f.alice.name)).toBe(true);

      // 画布历史条目（含 HTTP 接口）包含 via: 'mcp' 与 mcpTokenPrefix
      const hist = await f.created.rooms.listHistory(f.branch1, { limit: 20 });
      const mcpEntries = hist.entries.filter((e) => e.seq > 0);
      expect(mcpEntries).toHaveLength(1);
      for (const e of mcpEntries) {
        expect(e.user).toBe(f.alice.name);
        expect(e.via).toBe('mcp');
        expect(e.mcpTokenPrefix).toBe(tokAlice.prefix);
        expect(e.opName).toBe('batch');
        expect(e.opSummary).toBe('新增 users / orders 表与外键');
        expect(e.changeCount).toBe(8);
      }
      const detailEntry = await f.created.rooms.historyEntry(f.branch1, 1);
      expect(detailEntry.opSummary).toBe('新增 users / orders 表与外键');
      const histHttp = await f.callHttp(
        'GET',
        `/api/projects/${f.p1Id}/history?limit=20`,
        undefined,
        f.adminCookie,
      );
      expect(histHttp.status).toBe(200);
      const httpEntries = histHttp.data.entries as {
        seq: number;
        via?: string;
        mcpTokenPrefix?: string;
        opSummary?: string;
      }[];
      const httpEntry1 = httpEntries.find((e) => e.seq === 1);
      expect(httpEntry1?.via).toBe('mcp');
      expect(httpEntry1?.mcpTokenPrefix).toBe(tokAlice.prefix);
      expect(httpEntry1?.opSummary).toBe('新增 users / orders 表与外键');

      // 审计表写入 model.mutate，包含 via='mcp' 与 mcpToken
      const mutateAudits = await f.db.query<{
        actor_kind: string;
        actor_id: string;
        data: Record<string, unknown>;
      }>("select actor_kind, actor_id, data from audit_events where action = 'model.mutate'");
      expect(mutateAudits).toHaveLength(1);
      expect(mutateAudits[0]!.actor_kind).toBe('user');
      expect(mutateAudits[0]!.actor_id).toBe(f.alice.id);
      expect(mutateAudits[0]!.data).toMatchObject({
        via: 'mcp',
        mcpToken: { id: tokAlice.id, name: tokAlice.name, prefix: tokAlice.prefix },
        projectId: f.p1Id,
        seq: 1,
        opCount: 8,
        summary: '新增 users / orders 表与外键',
      });
      expect(mutateAudits[0]!.data.ops).toHaveLength(8);

      // 4. 批内中途非法操作：第 0 步有效 createTable，第 1 步重复列名失败 -> 整批回滚，0 提交
      const badMidRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [
          { name: 'createTable', args: { id: '$ref:tmp', schema: publicSchemaId, name: 'should_rollback' } },
          {
            name: 'addColumn',
            args: { table: refs.users, column: { id: '$ref:dup', name: 'id', type: 'text' } },
          },
        ],
      });
      expect(badMidRes.isError).toBe(true);
      expect(badMidRes.structuredContent?.code).toBe('invalid');
      expect(badMidRes.structuredContent?.index).toBe(1);
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(1);
      expect(all((await f.created.rooms.model(f.branch1)).model, 'table').map((t) => t.name)).not.toContain(
        'should_rollback',
      );

      // 5. 人类通过 WS 修改 users.id（seq 1 -> 2），AI 用旧 baseSeq=1 修改同一列 -> 报告最早冲突的子操作，且不写 room_rejections
      const seqBeforeHuman = (await f.created.rooms.model(f.branch1)).seq;
      await f.created.rooms.message(f.branch1, peerHuman.peer, {
        t: 'op',
        op: {
          client: 'ws-admin',
          n: 1,
          name: 'renameColumn',
          args: { id: refs.u_id, name: 'uid' },
          reads: [[refs.u_id!, seqBeforeHuman]],
        },
      });
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(2);

      const conflictEditRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [
          {
            name: 'createTable',
            args: { id: '$ref:unrelated', schema: publicSchemaId, name: 'not_committed' },
          },
          { name: 'setComment', args: { id: refs.u_id, comment: 'stale edit' } },
        ],
      });
      expect(conflictEditRes.isError).toBe(true);
      expect(conflictEditRes.structuredContent?.code).toBe('conflict');
      expect(conflictEditRes.structuredContent?.index).toBe(1);
      expect(conflictEditRes.structuredContent?.message).toContain('已被');
      expect(conflictEditRes.structuredContent?.currentSeq).toBe(2);
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(2);

      // 6. 人类通过 WS 删除 orders 表（seq 2 -> 3），AI 用 baseSeq=1 给 orders 加列 -> conflict
      await f.created.rooms.message(f.branch1, peerHuman.peer, {
        t: 'op',
        op: {
          client: 'ws-admin',
          n: 2,
          name: 'dropTable',
          args: { id: refs.orders },
          reads: [[refs.orders!, 1]],
        },
      });
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(3);

      const conflictDelRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [
          {
            name: 'addColumn',
            args: { table: refs.orders, column: { id: '$ref:newc', name: 'note', type: 'text' } },
          },
        ],
      });
      expect(conflictDelRes.isError).toBe(true);
      expect(conflictDelRes.structuredContent?.code).toBe('conflict');
      expect(conflictDelRes.structuredContent?.index).toBe(0);
      expect(conflictDelRes.structuredContent?.currentSeq).toBe(3);

      // 7. 无净变化（建表后又删掉）：noop，不产生提交、不记审计、不广播
      const wsBeforeNoop = peerHuman.sent.length;
      const noopRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 3,
        ops: [
          { name: 'createTable', args: { id: '$ref:tmp_noop', schema: publicSchemaId, name: 'tmp_noop' } },
          { name: 'dropTable', args: { id: '$ref:tmp_noop' } },
        ],
      });
      expect(noopRes.isError).toBeFalsy();
      expect(noopRes.structuredContent).toMatchObject({ noop: true, seq: 3, opCount: 2, changed: [] });
      expect(noopRes.structuredContent?.diagnostics).toBeDefined();
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(3);
      expect(peerHuman.sent.length).toBe(wsBeforeNoop);
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toHaveLength(1);

      // 8. batch / paste 不能经 apply_changes 直接调用
      for (const name of ['batch', 'paste']) {
        const nested = await f.callTool(tokAlice.token, 'apply_changes', {
          project: f.p1Id,
          baseSeq: 3,
          ops: [{ name, args: { ops: [{ name: 'createSchema', args: { id: '$ref:x', name: 'x' } }] } }],
        });
        expect(nested.isError).toBe(true);
        expect(nested.structuredContent).toMatchObject({ code: 'invalid', index: 0 });
      }

      // 确保冲突与中途回滚均未污染 room_rejections 表
      const rejRows = await f.db.query('select * from room_rejections where branch_id = $1', [f.branch1]);
      expect(rejRows).toEqual([]);
    },
  );

  test.skipIf(skip)(
    'list_environments 仅读平台缓存（目标库不可达仍成功且含缓存时间戳与脱敏）与 verify_migration',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'verify', 'write']);

      // 在 PG 项目下插入一个目标库 URL 完全不可达（端口 1 + 含高危密码）的缓存环境
      const secretUrl = 'postgres://dbadmin:UltraSecretPassword999@127.0.0.1:1/unreachable_db';
      const envId = newId();
      const checkedAt = '2026-10-01T12:00:00.000Z';
      await f.db.query(
        `insert into environments (id, project_id, name, url_enc, production, allow_same_instance,
                                 drift_status, drift_summary, last_drift_check, engine_version, engine_version_num)
       values ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10, $11)`,
        [
          envId,
          f.p1Id,
          'prod-unreachable',
          encrypt(secretUrl),
          true,
          false,
          'drifted',
          JSON.stringify({ extras: ['legacy_table'] }),
          checkedAt,
          'PostgreSQL 16.4',
          160004,
        ],
      );

      // list_environments 必须不连目标库、返回 source: 'platform_cache' 与缓存时间戳，且绝不泄露密码/URL
      const envsRes = await f.callTool(tokAlice.token, 'list_environments', { project: f.p1Id });
      expect(envsRes.isError).toBeFalsy();
      expect(envsRes.structuredContent?.source).toBe('platform_cache');
      const envList = envsRes.structuredContent?.environments as {
        id: string;
        name: string;
        lastDriftCheck: string | null;
        createdAt: string | null;
        drift: { status: string; checkedAt: string | null; summary: unknown };
      }[];
      expect(envList).toHaveLength(1);
      expect(envList[0]!.name).toBe('prod-unreachable');
      expect(envList[0]!.lastDriftCheck).toBeTruthy();
      expect(envList[0]!.drift.checkedAt).toBeTruthy();
      expect(envList[0]!.drift.status).toBe('drifted');
      expect(envList[0]!.createdAt).toBeTruthy();
      const rawJson = JSON.stringify(envsRes);
      expect(rawJson).not.toContain('UltraSecretPassword999');
      expect(rawJson).not.toContain('127.0.0.1:1');

      // verify_migration：p2 是 SQLite 方言项目（内置内存影子库可闭环验证，固定 schema 为 main）
      await editModel(f.created.rooms, f.db, f.p2Id, (m) => {
        const sid = all(m, 'schema')[0]?.id ?? createSchema(m, 'main');
        const tid = createTable(m, sid, 'billing_items');
        addColumn(m, tid, { name: 'id', type: 'integer', notNull: true });
      });
      const verifySqlite = await f.callTool(tokAlice.token, 'verify_migration', {
        project: f.p2Id,
        from: 'empty',
        to: 'head',
      });
      expect(verifySqlite.isError).toBeFalsy();
      expect(verifySqlite.structuredContent?.ok).toBe(true);
      expect(verifySqlite.structuredContent?.from).toBe('empty');
      expect(verifySqlite.structuredContent?.to).toBe('head');

      // verify_migration：p1 是 PG 方言项目且未配置独立影子库 → 返回 shadow_unavailable，并记录 ok: false 的 model.verify 审计
      await addTable(f.created.rooms, f.db, f.p1Id, 'pg_orders');
      const verifyPg = await f.callTool(tokAlice.token, 'verify_migration', {
        project: f.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(verifyPg.isError).toBe(true);
      expect(verifyPg.structuredContent?.code).toBe('shadow_unavailable');

      const verifyAudits = await f.db.query<{
        actor_kind: string;
        actor_id: string;
        data: { via: string; ok: boolean };
      }>("select actor_kind, actor_id, data from audit_events where action = 'model.verify' order by at asc");
      expect(verifyAudits.length).toBeGreaterThanOrEqual(2);
      expect(verifyAudits.some((a) => a.data.via === 'mcp' && a.data.ok === true)).toBe(true);
      expect(verifyAudits.some((a) => a.data.via === 'mcp' && a.data.ok === false)).toBe(true);
    },
  );

  test.skipIf(platform !== 'sqlite')(
    'verify_migration 对 SQLite 与前置配置类 ShadowError 不消耗配额，外部验证与界面共用用户限流桶',
    async () => {
      // 1. SQLite（内存影子库）与未配置环境 / 生产禁止同实例等 preConnect ShadowError 不消耗连接配额
      const limiter = new KeyedLimiter({ limit: 2, windowMs: 60_000 });
      const f = await setupEnv({ connectionLimiter: limiter });
      const tok = await f.issueToken(f.admin.id, ['read', 'verify'], null, 'tok-pre');
      await editModel(f.created.rooms, f.db, f.p2Id, (m) => {
        const sid = all(m, 'schema')[0]?.id ?? createSchema(m, 'main');
        const tid = createTable(m, sid, 'rate_sqlite_tbl');
        addColumn(m, tid, { name: 'id', type: 'integer', notNull: true });
      });
      await addTable(f.created.rooms, f.db, f.p1Id, 'rate_pg_tbl');

      for (let i = 0; i < 4; i++) {
        const res = await f.callTool(tok.token, 'verify_migration', {
          project: f.p2Id,
          from: 'empty',
          to: 'head',
        });
        expect(res.isError).toBeFalsy();
      }
      expect(limiter.keyCount).toBe(0);

      for (let i = 0; i < 4; i++) {
        const res = await f.callTool(tok.token, 'verify_migration', {
          project: f.p1Id,
          from: 'empty',
          to: 'head',
        });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('shadow_unavailable');
      }
      expect(limiter.keyCount).toBe(0);

      await f.db.query(
        `insert into environments (id, project_id, name, url_enc, production, allow_same_instance)
         values ($1, $2, $3, $4, $5, $6)`,
        [newId(), f.p1Id, 'prod-no-same', encrypt('postgres://u:p@127.0.0.1:5432/prod'), true, false],
      );
      for (let i = 0; i < 4; i++) {
        const res = await f.callTool(tok.token, 'verify_migration', {
          project: f.p1Id,
          from: 'empty',
          to: 'head',
        });
        expect(res.isError).toBe(true);
        expect(res.structuredContent?.code).toBe('shadow_unavailable');
      }
      expect(limiter.keyCount).toBe(0);

      // 2. 外部影子库验证按同一用户（跨 MCP 令牌 + 与界面 connectionLimit 共用桶）扣减配额
      const sharedLimiter = new KeyedLimiter({ limit: 2, windowMs: 60_000 });
      const fShared = await setupEnv({ connectionLimiter: sharedLimiter });
      const tok1 = await fShared.issueToken(fShared.admin.id, ['read', 'verify'], null, 'tok-1');
      const tok2 = await fShared.issueToken(fShared.admin.id, ['read', 'verify'], null, 'tok-2');
      await addTable(fShared.created.rooms, fShared.db, fShared.p1Id, 'shared_rate_tbl');

      const fakeShadow: Shadow = {
        importSql: async () => {
          throw new Error('not used');
        },
        verify: async () => ({
          ok: true,
          up: [],
          down: [],
          upDiff: [],
          downDiff: [],
          risks: [],
          error: null,
        }),
        verifyScripts: async () => {
          throw new Error('not used');
        },
        canonicalize: async () => [],
        close: async () => {},
      };
      fShared.created.shadows.forProject = async () => ({ shadow: fakeShadow, label: 'pg-shadow' });

      const r1 = await fShared.callTool(tok1.token, 'verify_migration', {
        project: fShared.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(r1.isError).toBeFalsy();

      const r2 = await fShared.callTool(tok2.token, 'verify_migration', {
        project: fShared.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(r2.isError).toBeFalsy();

      const r3 = await fShared.callTool(tok1.token, 'verify_migration', {
        project: fShared.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(r3.isError).toBe(true);
      expect(r3.structuredContent?.code).toBe('rate_limited');

      const uiCheck = await fShared.callHttp(
        'POST',
        '/api/connection-check',
        { groupId: fShared.groupId, dialect: 'pg', url: 'postgres://u:p@127.0.0.1:1/db' },
        fShared.adminCookie,
      );
      expect(uiCheck.status).toBe(429);

      // 3. 真实连库类的 ShadowUnavailableError（非 preConnect）仍消耗配额
      const errLimiter = new KeyedLimiter({ limit: 1, windowMs: 60_000 });
      const fErr = await setupEnv({ connectionLimiter: errLimiter });
      const tokErr = await fErr.issueToken(fErr.admin.id, ['read', 'verify'], null, 'tok-err');
      await addTable(fErr.created.rooms, fErr.db, fErr.p1Id, 'err_rate_tbl');
      fErr.created.shadows.forProject = async () => {
        throw new ShadowUnavailableError('连接被拒绝');
      };

      const e1 = await fErr.callTool(tokErr.token, 'verify_migration', {
        project: fErr.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(e1.isError).toBe(true);
      expect(e1.structuredContent?.code).toBe('shadow_unavailable');

      const e2 = await fErr.callTool(tokErr.token, 'verify_migration', {
        project: fErr.p1Id,
        from: 'empty',
        to: 'head',
      });
      expect(e2.isError).toBe(true);
      expect(e2.structuredContent?.code).toBe('rate_limited');
    },
  );

  test.skipIf(platform !== 'sqlite')(
    'apply_changes 审计写入失败时与提交原子回滚，不广播且重试不会重复创建对象',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
      const { peer, sent } = makePeer(f.alice);
      await f.created.rooms.join(f.branch1, peer);

      const publicSchemaId = all((await f.created.rooms.model(f.branch1)).model, 'schema')[0]!.id;
      const ops = [
        {
          name: 'createTable',
          args: { id: '$ref:t1', schema: publicSchemaId, name: 'audit_rollback_tbl' },
        },
      ];

      await f.db.exec(`
        create trigger fail_mcp_mutate_audit
        before insert on audit_events
        when new.action = 'model.mutate'
        begin
          select raise(abort, 'simulated audit failure');
        end
      `);
      try {
        const failRes = await f.callTool(tokAlice.token, 'apply_changes', {
          project: f.p1Id,
          baseSeq: 0,
          ops,
        });
        expect(failRes.isError).toBe(true);
        expect(failRes.structuredContent?.code).toBe('internal');

        const commitsAfterFail = await f.db.query<{ seq: number }>(
          'select seq from room_commits where branch_id = $1',
          [f.branch1],
        );
        expect(commitsAfterFail).toHaveLength(0);

        const stateAfterFail = await f.created.rooms.model(f.branch1);
        expect(stateAfterFail.seq).toBe(0);
        expect(all(stateAfterFail.model, 'table').map((t) => t.name)).not.toContain('audit_rollback_tbl');

        expect(sent.filter((m) => m.t === 'commit')).toHaveLength(0);

        const auditsAfterFail = await f.db.query<{ id: string }>(
          "select id from audit_events where action = 'model.mutate'",
        );
        expect(auditsAfterFail).toHaveLength(0);
      } finally {
        await f.db.exec('drop trigger if exists fail_mcp_mutate_audit');
      }

      // 审计恢复后重试同批操作：仅提交一次、仅生成一张表、审计写入一条
      const okRes = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 0,
        ops,
      });
      expect(okRes.isError).toBeFalsy();
      expect(okRes.structuredContent?.seq).toBe(1);

      const stateAfterRetry = await f.created.rooms.model(f.branch1);
      expect(stateAfterRetry.seq).toBe(1);
      expect(all(stateAfterRetry.model, 'table').filter((t) => t.name === 'audit_rollback_tbl')).toHaveLength(
        1,
      );

      const commitsAfterRetry = await f.db.query<{ seq: number }>(
        'select seq from room_commits where branch_id = $1',
        [f.branch1],
      );
      expect(commitsAfterRetry).toHaveLength(1);

      const auditsAfterRetry = await f.db.query<{ id: string }>(
        "select id from audit_events where action = 'model.mutate'",
      );
      expect(auditsAfterRetry).toHaveLength(1);
    },
  );

  // #90：mutator 名恰好是 Object.prototype 上的属性名时按未知 mutator 处理
  test.skipIf(skip)('list_mutators / apply_changes 把原型属性名当作未知 mutator', async () => {
    const f = await setupEnv();
    const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
    const protoNames = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

    const lm = await f.callTool(tokAlice.token, 'list_mutators', { names: [...protoNames, 'createTable'] });
    expect(lm.isError).toBeFalsy();
    expect((lm.structuredContent!.mutators as { name: string }[]).map((m) => m.name)).toEqual([
      'createTable',
    ]);
    expect(lm.structuredContent!.unknown).toEqual(protoNames);

    const publicSchemaId = all((await f.created.rooms.model(f.branch1)).model, 'schema')[0]!.id;
    for (const name of protoNames) {
      const res = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 0,
        ops: [
          { name: 'createTable', args: { id: '$ref:t', schema: publicSchemaId, name: 'should_rollback' } },
          { name, args: {} },
        ],
      });
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        code: 'invalid',
        message: `未知的操作：${name}`,
        index: 1,
        currentSeq: 0,
      });
    }
    const state = await f.created.rooms.model(f.branch1);
    expect(state.seq).toBe(0);
    expect(all(state.model, 'table').map((t) => t.name)).not.toContain('should_rollback');
  });

  test.skipIf(skip)(
    'apply_changes 响应附带 diagnostics：按缓存的最低环境版本做静态兼容性检查（dryRun 与提交一致，不连目标库）',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
      // 两个环境：PG 15 与 PG 17（目标库不可达，确保诊断只读平台缓存）
      for (const [name, num] of [
        ['diag-15', 150004],
        ['diag-17', 170002],
      ] as const) {
        await f.db.query(
          `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, engine_version_num)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), f.p1Id, name, encrypt('postgres://u:p@127.0.0.1:1/db'), false, false, num],
        );
      }
      const publicSchemaId = all((await f.created.rooms.model(f.branch1)).model, 'schema')[0]!.id;
      const ops = [
        { name: 'createTable', args: { id: '$ref:t', schema: publicSchemaId, name: 'diag_t' } },
        {
          name: 'addColumn',
          args: {
            table: '$ref:t',
            column: { id: '$ref:v', name: 'v', type: 'integer', generated: { expr: '1 + 1', stored: false } },
          },
        },
        {
          name: 'addColumn',
          args: {
            table: '$ref:t',
            column: { id: '$ref:u', name: 'u', type: 'uuid', default: { expr: 'uuidv7()' } },
          },
        },
      ];
      for (const dryRun of [true, false]) {
        const res = await f.callTool(tokAlice.token, 'apply_changes', {
          project: f.p1Id,
          baseSeq: 0,
          dryRun,
          ops,
        });
        expect(res.isError).toBeFalsy();
        const diag = res.structuredContent?.diagnostics as {
          target: string | null;
          blocksPublish: boolean;
          compatibility: {
            errors: { total: number; items: { code: string; objectId?: string; minVersion?: string }[] };
            warnings: { total: number; items: { code: string }[] };
          };
        };
        const refs = res.structuredContent?.refs as Record<string, string>;
        expect(diag.target).toBe('PG 15');
        expect(diag.compatibility.errors.total).toBe(1);
        expect(diag.compatibility.errors.items[0]).toMatchObject({
          code: 'virtual_generated',
          objectId: refs.v,
          minVersion: 'PG 18',
        });
        expect(diag.compatibility.warnings.items.map((w) => w.code)).toEqual(['uuidv7_expr']);
        // 兼容性问题不阻塞提交，也不阻塞发布判断（只有 validate 错误才算 blocksPublish）
        expect(diag.blocksPublish).toBe(false);
      }
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(1);
    },
  );

  test.skipIf(skip)(
    'list_mutators 排除 paste / batch 且 apply_changes 拒绝 paste 以防止绕过批量上限',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);

      const lmAll = await f.callTool(tokAlice.token, 'list_mutators', {});
      expect(lmAll.isError).toBeFalsy();
      const allNames = (lmAll.structuredContent!.mutators as { name: string }[]).map((m) => m.name);
      expect(allNames).not.toContain('paste');
      expect(allNames).not.toContain('batch');

      const lmFilter = await f.callTool(tokAlice.token, 'list_mutators', {
        names: ['paste', 'batch', 'createTable'],
      });
      expect(lmFilter.isError).toBeFalsy();
      expect((lmFilter.structuredContent!.mutators as { name: string }[]).map((m) => m.name)).toEqual([
        'createTable',
      ]);
      expect(lmFilter.structuredContent!.unknown).toEqual(['paste', 'batch']);

      const resList = await parseRpc(
        await f.mcpPost(tokAlice.token, {
          jsonrpc: '2.0',
          id: 90,
          method: 'resources/read',
          params: { uri: 'dowel://mutators' },
        }),
      );
      const catalog = JSON.parse(((resList.result?.contents as { text: string }[]) ?? [])[0]!.text) as {
        mutators: { name: string }[];
      };
      expect(catalog.mutators.map((m) => m.name)).not.toContain('paste');
      expect(catalog.mutators.map((m) => m.name)).not.toContain('batch');

      const publicSchemaId = all((await f.created.rooms.model(f.branch1)).model, 'schema')[0]!.id;
      for (const dryRun of [true, false]) {
        const res = await f.callTool(tokAlice.token, 'apply_changes', {
          project: f.p1Id,
          baseSeq: 0,
          dryRun,
          ops: [
            { name: 'createTable', args: { id: '$ref:t', schema: publicSchemaId, name: 'should_rollback' } },
            {
              name: 'paste',
              args: {
                ops: [
                  {
                    name: 'createTable',
                    args: { id: '$ref:p_tbl', schema: publicSchemaId, name: 'via_paste' },
                  },
                ],
              },
            },
          ],
        });
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toMatchObject({
          code: 'invalid',
          index: 1,
          currentSeq: 0,
        });
        expect(res.structuredContent?.message).toContain('paste');
      }

      const state = await f.created.rooms.model(f.branch1);
      expect(state.seq).toBe(0);
      expect(all(state.model, 'table').map((t) => t.name)).toEqual([]);
      expect(await f.db.query('select * from room_rejections where branch_id = $1', [f.branch1])).toEqual([]);
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toEqual([]);
    },
  );
  test.skipIf(skip)(
    '复合宏：list_mutators / dowel://mutators 暴露宏在前，apply_changes 错误透传 path / mutator，审计记外层 op 名',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);

      const lm = await f.callTool(tokAlice.token, 'list_mutators', {});
      expect(lm.isError).toBeFalsy();
      const items = lm.structuredContent!.mutators as {
        name: string;
        kind: string;
        description: string;
        argsSchema: { properties?: Record<string, unknown> };
      }[];
      expect(items.slice(0, 2).map((m) => [m.name, m.kind])).toEqual([
        ['defineTable', 'macro'],
        ['alterColumn', 'macro'],
      ]);
      expect(items.slice(2).every((m) => m.kind === 'mutator' && m.description.length > 0)).toBe(true);
      expect(items[0]!.description).toContain('addForeignKey');
      expect(Object.keys(items[0]!.argsSchema.properties ?? {})).toContain('foreignKeys');
      expect(items.map((m) => m.name)).not.toContain('batch');
      const filtered = await f.callTool(tokAlice.token, 'list_mutators', {
        names: ['alterColumn', 'createTable'],
      });
      expect((filtered.structuredContent!.mutators as { name: string }[]).map((m) => m.name)).toEqual([
        'alterColumn',
        'createTable',
      ]);

      const resList = await parseRpc(
        await f.mcpPost(tokAlice.token, {
          jsonrpc: '2.0',
          id: 91,
          method: 'resources/read',
          params: { uri: 'dowel://mutators' },
        }),
      );
      const catalog = JSON.parse(((resList.result?.contents as { text: string }[]) ?? [])[0]!.text) as {
        mutators: { name: string; kind: string }[];
      };
      expect(catalog.mutators.slice(0, 2).map((m) => m.name)).toEqual(['defineTable', 'alterColumn']);

      const ops = [
        {
          name: 'defineTable',
          args: {
            name: 'mac_users',
            columns: [
              { id: '$ref:uid', name: 'id', type: 'bigint' },
              { id: '$ref:email', name: 'email', type: 'text' },
            ],
            primaryKey: { columns: ['id'] },
          },
        },
        { name: 'alterColumn', args: { id: '$ref:email', notNull: true, comment: '邮箱' } },
      ];
      const dry = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 0,
        dryRun: true,
        ops,
      });
      expect(dry.isError).toBeFalsy();
      expect(dry.structuredContent).toMatchObject({ dryRun: true, opCount: 6 });
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toEqual([]);

      const res = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 0,
        summary: '宏建表',
        ops,
      });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ dryRun: false, seq: 1, opCount: 6 });
      const refs = res.structuredContent!.refs as Record<string, string>;
      expect(Object.keys(refs).sort()).toEqual(['email', 'uid']);
      const audits = await f.db.query<{ data: Record<string, unknown> }>(
        "select data from audit_events where action = 'model.mutate'",
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.data).toMatchObject({ seq: 1, opCount: 6, ops: ['defineTable', 'alterColumn'] });

      // 再次执行同一个 alterColumn：全幂等 → noop，不提交、不审计
      const again = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [{ name: 'alterColumn', args: { id: refs.email, notNull: true, comment: '邮箱' } }],
      });
      expect(again.isError).toBeFalsy();
      expect(again.structuredContent).toMatchObject({ noop: true, opCount: 0, seq: 1 });
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toHaveLength(1);

      // 错误：structuredContent 透传 code / index / path / mutator / currentSeq
      const bad = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [
          { name: 'alterColumn', args: { id: 'email', comment: 'x' } },
          {
            name: 'defineTable',
            args: { name: 'mac_t', columns: [{ name: 'a', type: 'int' }], checks: [{ expr: 'nope > 0' }] },
          },
        ],
      });
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent).toMatchObject({
        code: 'invalid',
        index: 0,
        path: 'alterColumn(email).id',
        currentSeq: 1,
      });
      expect(bad.structuredContent).not.toHaveProperty('mutator');
      const bad2 = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: 1,
        ops: [
          {
            name: 'defineTable',
            args: { name: 'mac_t', columns: [{ name: 'a', type: 'int' }], checks: [{ expr: 'nope > 0' }] },
          },
        ],
      });
      expect(bad2.structuredContent).toMatchObject({
        code: 'invalid',
        index: 0,
        path: 'defineTable(mac_t).checks[0]',
        mutator: 'addCheck',
        currentSeq: 1,
      });
      expect(
        String(bad2.structuredContent!.message).startsWith('ops[0] defineTable(mac_t).checks[0] addCheck：'),
      ).toBe(true);
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(1);
    },
  );
  test.skipIf(skip)(
    'manage_sections：scope / 角色鉴权、6 种动作与 $ref、错误码、坐标拒绝、审计与 noop / dryRun',
    async () => {
      const f = await setupEnv();
      await addTable(f.created.rooms, f.db, f.p1Id, 'orders');
      await addTable(f.created.rooms, f.db, f.p1Id, 'items');
      await addTable(f.created.rooms, f.db, f.p1Id, 'users');
      const { model, seq } = await f.created.rooms.model(f.branch1);
      const idOf = (name: string) => all(model, 'table').find((t) => t.name === name)!.id;
      const [orders, items, users] = [idOf('orders'), idOf('items'), idOf('users')];
      const tokRead = await f.issueToken(f.alice.id, ['read']);
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
      const tokBob = await f.issueToken(f.bob.id, ['read', 'write']);
      const peer = makePeer(f.alice);
      await f.created.rooms.join(f.branch1, peer.peer);

      // tools/list：write scope 可见，annotations 与 apply_changes 同为破坏性写入
      const list = await parseRpc(
        await f.mcpPost(tokAlice.token, { jsonrpc: '2.0', id: 70, method: 'tools/list', params: {} }),
      );
      const tool = (list.result!.tools as { name: string; annotations: Record<string, boolean> }[]).find(
        (t) => t.name === 'manage_sections',
      );
      expect(tool?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });

      const deniedScope = await f.callTool(tokRead.token, 'manage_sections', {
        project: f.p1Id,
        actions: [{ action: 'create', name: 'x' }],
      });
      expect(deniedScope.structuredContent?.code).toBe('scope_required');
      const deniedRole = await f.callTool(tokBob.token, 'manage_sections', {
        project: f.p1Id,
        actions: [{ action: 'create', name: 'x' }],
      });
      expect(deniedRole.structuredContent?.code).toBe('forbidden');

      // 坐标 / 未知字段一律 invalid_arguments
      for (const action of [
        { action: 'create', name: 'x', x: 1, y: 2 },
        { action: 'add_tables', section: 'sec-x', tables: [orders], positions: { [orders]: { x: 1, y: 1 } } },
        { action: 'rename', section: 'sec-x', name: 'n', width: 100, height: 50 },
      ]) {
        const res = await f.callTool(tokAlice.token, 'manage_sections', {
          project: f.p1Id,
          actions: [action],
        });
        expect(res.structuredContent?.code, JSON.stringify(action)).toBe('invalid_arguments');
      }

      // 6 种动作 + $ref（同批创建后引用）
      const created = await f.callTool(tokAlice.token, 'manage_sections', {
        project: 'acme/orders',
        actions: [
          { action: 'create', ref: 'sales', name: '销售', tables: [orders, items] },
          { action: 'create', ref: 'crm', name: '客户', color: 'peer-5' },
          { action: 'add_tables', section: '$ref:crm', tables: [users, items] },
          { action: 'rename', section: '$ref:sales', name: '订单中心' },
          { action: 'recolor', section: '$ref:sales', color: 'peer-7' },
        ],
      });
      expect(created.isError).toBeFalsy();
      const refs = created.structuredContent?.refs as Record<string, string>;
      expect(refs.sales).toMatch(SECTION_ID_RE);
      expect(refs.crm).toMatch(SECTION_ID_RE);
      expect(created.structuredContent).toMatchObject({
        dryRun: false,
        sectionsVer: 1,
        moved: [{ tableId: items, from: refs.sales, to: refs.crm }],
        sections: [
          { id: refs.sales, name: '订单中心', color: 'peer-7', tables: [orders] },
          { id: refs.crm, name: '客户', color: 'peer-5', tables: [users, items] },
        ],
      });
      expect(created.structuredContent?.noop).toBeUndefined();
      // 纯布局层：不产生画布修改历史 / seq；在线 peer 实时收到
      expect((await f.created.rooms.model(f.branch1)).seq).toBe(seq);
      expect(peer.sent.at(-1)).toEqual({
        t: 'sections',
        sections: created.structuredContent?.sections as CanvasSection[],
      });

      const removed = await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p1Id,
        actions: [
          { action: 'remove_tables', section: refs.crm, tables: [users] },
          { action: 'delete', section: refs.sales },
        ],
      });
      expect(removed.structuredContent).toMatchObject({
        sectionsVer: 2,
        sections: [{ id: refs.crm, tables: [items] }],
      });

      // 错误码与 index
      const errCases: [Record<string, unknown>[], Record<string, unknown>][] = [
        [[{ action: 'rename', section: 'sec-missing', name: 'n' }], { code: 'section_not_found', index: 0 }],
        [
          [
            { action: 'create', ref: 'a', name: 'A' },
            { action: 'delete', section: '$ref:undefined_alias' },
          ],
          { code: 'section_not_found', index: 1 },
        ],
        [
          [{ action: 'add_tables', section: refs.crm, tables: [orders, 'no-such-table'] }],
          { code: 'table_not_found', index: 0, tableIds: ['no-such-table'] },
        ],
        [
          [
            { action: 'create', ref: 'dup', name: 'A' },
            { action: 'create', ref: 'dup', name: 'B' },
          ],
          { code: 'invalid', index: 1 },
        ],
      ];
      for (const [actions, expected] of errCases) {
        const res = await f.callTool(tokAlice.token, 'manage_sections', { project: f.p1Id, actions });
        expect(res.isError, JSON.stringify(actions)).toBe(true);
        expect(res.structuredContent).toMatchObject(expected);
      }

      // noop 与 dryRun：不写库、不记审计
      const noop = await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p1Id,
        actions: [{ action: 'remove_tables', section: refs.crm, tables: [users] }],
      });
      expect(noop.structuredContent).toMatchObject({ noop: true, sectionsVer: 2 });
      const dry = await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p1Id,
        dryRun: true,
        actions: [{ action: 'create', ref: 'preview', name: '预演' }],
      });
      expect(dry.structuredContent).toMatchObject({ dryRun: true, sectionsVer: 3 });
      expect((dry.structuredContent!.sections as CanvasSection[]).map((x) => x.name)).toEqual([
        '客户',
        '预演',
      ]);
      const [b] = await f.db.query<{ sections: CanvasSection[]; sections_ver: number | string }>(
        'select sections, sections_ver from branches where id = $1',
        [f.branch1],
      );
      expect(Number(b!.sections_ver)).toBe(2);
      expect(b!.sections.map((x) => x.id)).toEqual([refs.crm]);

      // 审计：仅两次真实提交各 1 条（via: 'mcp'），dryRun / noop / 失败不记
      const auditRows = await f.db.query<{ actor_id: string; data: Record<string, unknown> | string }>(
        "select actor_id, data from audit_events where action = 'sections.update'",
      );
      expect(auditRows).toHaveLength(2);
      expect(auditRows.every((row) => row.actor_id === f.alice.id)).toBe(true);
      const datas = auditRows
        .map(
          (row) =>
            (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>,
        )
        .sort((a, b) => Number(a.sectionsVer) - Number(b.sectionsVer));
      expect(datas[0]).toMatchObject({
        via: 'mcp',
        mcpToken: { id: tokAlice.id, name: tokAlice.name },
        projectId: f.p1Id,
        sectionsVer: 1,
        opCount: 5,
        actions: ['create', 'create', 'add_tables', 'rename', 'recolor'],
        created: 2,
        deleted: 0,
        moved: 1,
      });
      expect(datas[1]).toMatchObject({ sectionsVer: 2, opCount: 2, created: 0, deleted: 1, moved: 0 });
      expect(await f.db.query("select id from audit_events where action = 'model.mutate'")).toEqual([]);
    },
  );

  test.skipIf(skip)('manage_sections：审计写入失败时整次板块写入原子回滚', async () => {
    const f = await setupEnv();
    const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
    await f.db.query('alter table audit_events rename to audit_events_off');
    let res: ToolCallEnvelope;
    try {
      res = await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p1Id,
        actions: [{ action: 'create', name: '会回滚' }],
      });
    } finally {
      await f.db.query('alter table audit_events_off rename to audit_events');
    }
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.code).toBe('internal');
    const [b] = await f.db.query<{ sections: CanvasSection[]; sections_ver: number | string }>(
      'select sections, sections_ver from branches where id = $1',
      [f.branch1],
    );
    expect(b!.sections).toEqual([]);
    expect(Number(b!.sections_ver)).toBe(0);
    expect((await f.created.rooms.canvasState(f.branch1)).sections).toEqual([]);
  });

  test.skipIf(skip)(
    'get_model 全分支附带 sections / sectionId / capabilities / target（只读平台缓存，环境 URL 不可达也成功）',
    async () => {
      const f = await setupEnv();
      const tokAlice = await f.issueToken(f.alice.id, ['read', 'write']);
      let parent = '';
      let child = '';
      let loose = '';
      let ghostless = '';
      await editModel(f.created.rooms, f.db, f.p1Id, (m) => {
        const schema = all(m, 'schema').find((x) => x.name === 'public')?.id ?? createSchema(m, 'public');
        parent = createTable(m, schema, 'events');
        const p = m.objects[parent]!;
        if (p.kind === 'table') p.partitionBy = 'RANGE (id)';
        child = createTable(m, schema, 'events_2026');
        const c = m.objects[child]!;
        if (c.kind === 'table') c.partitionOf = { parent, bound: 'DEFAULT' };
        loose = createTable(m, schema, 'loose');
        ghostless = createTable(m, schema, 'to_drop');
      });
      const created = await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p1Id,
        actions: [
          { action: 'create', ref: 'ev', name: '事件', color: 'peer-2', tables: [parent, ghostless] },
        ],
      });
      const secId = (created.structuredContent!.refs as Record<string, string>).ev;
      // 删表后板块里留下孤儿 ID：get_model 只展示存活的顶层表
      await editModel(f.created.rooms, f.db, f.p1Id, (m) => {
        delete m.objects[ghostless];
      });

      // 无环境：target 全为 null
      const none = await f.callTool(tokAlice.token, 'get_model', { project: f.p1Id });
      expect(none.structuredContent).toMatchObject({
        dialect: 'pg',
        capabilities: getDialect('pg').capabilities,
        target: {
          label: null,
          features: null,
          source: 'platform_cache',
          environments: { total: 0, withCachedVersion: 0 },
        },
      });

      // 环境 URL 指向不可达地址：只读平台缓存的数值版本，绝不连目标库
      for (const [name, num] of [
        ['ctx-16', 160004],
        ['ctx-17', 170002],
        ['ctx-unknown', null],
      ] as const) {
        await f.db.query(
          `insert into environments (id, project_id, name, url_enc, production, allow_same_instance, engine_version_num)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), f.p1Id, name, encrypt('postgres://u:p@127.0.0.1:1/unreachable'), false, false, num],
        );
      }

      const summary = await f.callTool(tokAlice.token, 'get_model', { project: f.p1Id });
      expect(summary.isError).toBeFalsy();
      const sc = summary.structuredContent!;
      expect(sc.dialect).toBe('pg');
      expect(sc.capabilities).toEqual(getDialect('pg').capabilities);
      expect(sc.target).toMatchObject({
        label: 'PG 16',
        source: 'platform_cache',
        environments: { total: 3, withCachedVersion: 2 },
      });
      expect((sc.target as { features: Record<string, boolean> }).features).toMatchObject({
        nullsNotDistinct: true,
        virtualGenerated: false,
      });
      expect(sc.sections).toEqual([{ id: secId, name: '事件', color: 'peer-2', tableCount: 1 }]);
      const sectionIdOf = (name: string) =>
        (sc.tables as { name: string; sectionId: string | null }[]).find((t) => t.name === name)?.sectionId;
      expect(sectionIdOf('events')).toBe(secId);
      expect(sectionIdOf('events_2026')).toBe(secId);
      expect(sectionIdOf('loose')).toBeNull();
      expect(loose).not.toBe('');

      // 与 apply_changes.diagnostics.target 完全一致
      const dry = await f.callTool(tokAlice.token, 'apply_changes', {
        project: f.p1Id,
        baseSeq: sc.seq as number,
        dryRun: true,
        ops: [{ name: 'createSchema', args: { id: '$ref:s', name: 'ctx_s' } }],
      });
      expect((dry.structuredContent!.diagnostics as { target: string }).target).toBe('PG 16');

      // full：sections 带存活表列表，objects 仍是纯 IR 对象
      const full = await f.callTool(tokAlice.token, 'get_model', { project: f.p1Id, detail: 'full' });
      expect(full.structuredContent).toMatchObject({
        truncated: false,
        target: { label: 'PG 16' },
        capabilities: getDialect('pg').capabilities,
        sections: [{ id: secId, name: '事件', color: 'peer-2', tables: [parent] }],
      });
      const objects = full.structuredContent?.objects as Record<string, Record<string, unknown>>;
      expect(objects[parent]).not.toHaveProperty('sectionId');
      expect(Object.values(objects).some((o) => o.kind === 'section')).toBe(false);

      // schema 过滤不存在：sections 为空数组，但上下文字段仍在
      const missing = await f.callTool(tokAlice.token, 'get_model', { project: f.p1Id, schema: 'nope' });
      expect(missing.structuredContent).toMatchObject({
        sections: [],
        target: { label: 'PG 16' },
        capabilities: getDialect('pg').capabilities,
      });

      // truncated（> 200 表且未过滤 schema）：sections 为摘要，表摘要带 sectionId；SQLite 项目 target 为 null
      let firstBig = '';
      await editModel(f.created.rooms, f.db, f.p2Id, (m) => {
        const schemaId = all(m, 'schema')[0]?.id ?? createSchema(m, 'main');
        for (let i = 0; i < 205; i++) {
          const tid = createTable(m, schemaId, `big_${i}`);
          if (i === 0) firstBig = tid;
        }
      });
      await f.callTool(tokAlice.token, 'manage_sections', {
        project: f.p2Id,
        actions: [{ action: 'create', ref: 'big', name: '大', tables: [firstBig] }],
      });
      const truncated = await f.callTool(tokAlice.token, 'get_model', { project: f.p2Id, detail: 'full' });
      expect(truncated.structuredContent).toMatchObject({
        truncated: true,
        dialect: 'sqlite',
        capabilities: getDialect('sqlite').capabilities,
        target: { label: null, features: null, source: 'platform_cache' },
      });
      expect((truncated.structuredContent!.sections as { tableCount: number }[])[0]!.tableCount).toBe(1);
      expect(
        (truncated.structuredContent!.tables as { id: string; sectionId: string | null }[]).find(
          (t) => t.id === firstBig,
        )?.sectionId,
      ).toMatch(SECTION_ID_RE);

      // 资源模板同样附带
      const resModel = await parseRpc(
        await f.mcpPost(tokAlice.token, {
          jsonrpc: '2.0',
          id: 71,
          method: 'resources/read',
          params: { uri: 'dowel://projects/acme/orders/model' },
        }),
      );
      const resData = JSON.parse(((resModel.result?.contents as { text: string }[]) ?? [])[0]!.text) as {
        sections: unknown[];
        target: { label: string | null };
        capabilities: unknown;
      };
      expect(resData.sections).toEqual([{ id: secId, name: '事件', color: 'peer-2', tableCount: 1 }]);
      expect(resData.target.label).toBe('PG 16');
      expect(resData.capabilities).toEqual(getDialect('pg').capabilities);
    },
  );
});
