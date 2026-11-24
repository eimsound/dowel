// P7 HA2 MCP 双副本一致性测试（ADR 0011 + ADR 0014，PG 平台库）：
// 验证双副本间通过 MCP apply_changes 修改工作副本后：
// 1. 副本 A 提交，副本 B 立即通过 MCP get_model 读到最新 seq 与模型；
// 2. 双副本同时基于同一 baseSeq 修改同一对象，行锁串行化后仅一方提交、另一方收到 conflict；
// 3. 副本 B 上在线的 WS 协作者实时收到副本 A 上 MCP 提交的 commit 广播。
import { all, type Model, newId } from '@dowel/core';
import type { Commit, ToClient } from '@dowel/sync';
import { afterEach, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { createApp } from '../src/app.ts';
import type { User } from '../src/auth.ts';
import { openPlatformDb, type PlatformDb } from '../src/db.ts';
import { newMcpToken } from '../src/mcp-tokens.ts';
import type { Extra, Peer } from '../src/rooms.ts';
import { makeUser, PASSWORD } from './support.ts';

const waitFor = async (predicate: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
};

const callJson = async (
  app: ReturnType<typeof createApp>['app'],
  method: string,
  path: string,
  json?: unknown,
  cookie = '',
) => {
  const headers: Record<string, string> = {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await app.request(path, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return {
    status: res.status,
    data: data as Record<string, unknown>,
    cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '',
  };
};

const parseMcpResponse = async (res: Response) => {
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
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      error?: { code: number; message: string };
    };
  }
  return JSON.parse(text) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: { code: number; message: string };
  };
};

const callMcpTool = async (
  app: ReturnType<typeof createApp>['app'],
  token: string,
  name: string,
  args: Record<string, unknown>,
) => {
  const res = await app.request('/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1_000_000) + 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  return parseMcpResponse(res);
};

interface MockPeer {
  peer: Peer;
  sent: (ToClient | Extra)[];
}

const makePeer = (user: User, role: Peer['role'] = 'editor'): MockPeer => {
  const sent: (ToClient | Extra)[] = [];
  const peer: Peer = {
    user,
    role,
    send: (msg) => sent.push(structuredClone(msg)),
    close: () => {},
  };
  return { peer, sent };
};

interface DualReplicaFixture {
  dbA: PlatformDb;
  dbB: PlatformDb;
  appA: ReturnType<typeof createApp>;
  appB: ReturnType<typeof createApp>;
  alice: User;
  bob: User;
  projectId: string;
  branchId: string;
  schemaId: string;
  tokenAlice: string;
  tokenBob: string;
  close: () => Promise<void>;
}

const createDualReplicas = async (tag: string): Promise<DualReplicaFixture> => {
  const safeTag = tag.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const pg = await createTestDb(safeTag);
  const dbA = await openPlatformDb(pg.url);
  const dbB = await openPlatformDb(pg.url);
  const channel = `dowel_ha_mcp_${safeTag}_${newId()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)}`;
  const appA = createApp(dbA, { bus: { replicaId: `replica-a-${safeTag}`, channel } });
  const appB = createApp(dbB, { bus: { replicaId: `replica-b-${safeTag}`, channel } });

  try {
    await appA.bus.start();
    await appB.bus.start();

    const admin = await makeUser(dbA, 'admin', { name: '管理员', role: 'admin' });
    const alice = await makeUser(dbA, 'alice', { name: '张三' });
    const bob = await makeUser(dbA, 'bob', { name: '李四' });

    const loginRes = await callJson(appA.app, 'POST', '/api/auth/login', {
      username: 'admin',
      password: PASSWORD,
    });
    expect(loginRes.status).toBe(200);

    const grp = await callJson(
      appA.app,
      'POST',
      '/api/groups',
      { slug: 'ha-mcp', name: 'HA MCP 组', defaultRole: 'none' },
      loginRes.cookie,
    );
    expect(grp.status).toBe(201);

    const proj = await callJson(
      appA.app,
      'POST',
      '/api/projects',
      { name: 'HA MCP 项目', slug: 'ha-mcp', groupId: grp.data.id },
      loginRes.cookie,
    );
    expect(proj.status).toBe(201);
    const projectId = proj.data.id as string;

    for (const u of [alice, bob]) {
      const grant = await callJson(
        appA.app,
        'POST',
        `/api/projects/${projectId}/grants`,
        { subjectKind: 'user', subjectId: u.id, role: 'editor' },
        loginRes.cookie,
      );
      expect(grant.status).toBe(201);
    }

    const [b] = await dbA.query<{ id: string }>(
      "select id from branches where project_id = $1 and name = 'main'",
      [projectId],
    );
    const branchId = b!.id;
    const { model } = await appA.rooms.model(branchId);
    const schemaId = all(model, 'schema')[0]!.id;

    const insertTok = async (userId: string, name: string) => {
      const t = newMcpToken();
      await dbA.query(
        `insert into mcp_tokens (id, user_id, kind, name, prefix, token_hash, scopes, project_ids, expires_at)
         values ($1, $2, 'personal', $3, $4, $5, $6::text::jsonb, null, $7)`,
        [
          newId(),
          userId,
          name,
          t.prefix,
          t.hash,
          JSON.stringify(['read', 'verify', 'write']),
          new Date(Date.now() + 86_400_000).toISOString(),
        ],
      );
      return t.token;
    };

    const tokenAlice = await insertTok(alice.id, 'alice-ha-tok');
    const tokenBob = await insertTok(bob.id, 'bob-ha-tok');
    expect(admin.id).toBeTruthy();

    return {
      dbA,
      dbB,
      appA,
      appB,
      alice,
      bob,
      projectId,
      branchId,
      schemaId,
      tokenAlice,
      tokenBob,
      close: async () => {
        appA.refresher.stop();
        appB.refresher.stop();
        await appA.refresher.drain();
        await appB.refresher.drain();
        appA.rooms.close();
        appB.rooms.close();
        await appA.rooms.flush();
        await appB.rooms.flush();
        await appA.shadows.close();
        await appB.shadows.close();
        await appA.bus.close();
        await appB.bus.close();
        await dbA.close();
        await dbB.close();
        await pg.close();
      },
    };
  } catch (e) {
    appA.rooms.close();
    appB.rooms.close();
    await appA.bus.close().catch(() => {});
    await appB.bus.close().catch(() => {});
    await dbA.close().catch(() => {});
    await dbB.close().catch(() => {});
    await pg.close().catch(() => {});
    throw e;
  }
};

describe.skipIf(!PG_URL)('HA2 MCP 服务跨副本一致性（真实 PG 双副本）', () => {
  const fixtures: DualReplicaFixture[] = [];

  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()!.close();
    }
  });

  const boot = async (tag: string) => {
    const f = await createDualReplicas(tag);
    fixtures.push(f);
    return f;
  };

  test('副本 A 通过 MCP 提交变更 → 副本 B 立即在 get_model 读到最新 seq 且副本 B 上的 WS peer 收到提交广播', async () => {
    const f = await boot('sync_and_ws');
    const peerB = makePeer(f.bob);
    await f.appB.rooms.join(f.branchId, peerB.peer);
    await f.appB.rooms.message(f.branchId, peerB.peer, { t: 'hello', client: 'ws-bob', lastSeq: 0 });

    const applyRes = await callMcpTool(f.appA.app, f.tokenAlice, 'apply_changes', {
      project: f.projectId,
      baseSeq: 0,
      ops: [
        { name: 'createTable', args: { id: '$ref:tbl', schema: f.schemaId, name: 'invoices' } },
        {
          name: 'addColumn',
          args: {
            table: '$ref:tbl',
            column: { id: '$ref:col', name: 'total', type: 'numeric', notNull: true },
          },
        },
      ],
    });
    expect(applyRes.result?.isError).toBeFalsy();
    const scApply = applyRes.result?.structuredContent as { seq: number; refs: Record<string, string> };
    expect(scApply.seq).toBe(2);
    expect(scApply.refs.tbl).toBeTruthy();

    // 副本 B 立即通过 MCP get_model 读取最新模型与 seq
    const getRes = await callMcpTool(f.appB.app, f.tokenBob, 'get_model', {
      project: 'ha-mcp/ha-mcp',
      detail: 'full',
    });
    expect(getRes.result?.isError).toBeFalsy();
    const scGet = getRes.result?.structuredContent as {
      seq: number;
      objects: Model['objects'];
    };
    expect(scGet.seq).toBe(2);
    expect(Object.values(scGet.objects).some((o) => o.kind === 'table' && o.name === 'invoices')).toBe(true);

    // 副本 B 上连接的 WS peer 实时收到副本 A 的 MCP 提交
    await waitFor(() => peerB.sent.filter((m) => m.t === 'commit').length >= 2);
    const commitsB = peerB.sent.filter((m): m is Commit => m.t === 'commit');
    expect(commitsB.map((c) => c.seq)).toEqual([1, 2]);
    expect(commitsB.every((c) => c.user === '张三')).toBe(true);
  });

  test('双副本同时基于同一 baseSeq 经 MCP 修改同一对象 → 仅一方成功提交，另一方返回 conflict', async () => {
    const f = await boot('concurrent_conflict');

    // 先建一张共享表与列（seq = 2）
    const tblId = newId();
    const colId = newId();
    const seedRes = await callMcpTool(f.appA.app, f.tokenAlice, 'apply_changes', {
      project: f.projectId,
      baseSeq: 0,
      ops: [
        { name: 'createTable', args: { id: tblId, schema: f.schemaId, name: 'accounts' } },
        { name: 'addColumn', args: { table: tblId, column: { id: colId, name: 'status', type: 'text' } } },
      ],
    });
    expect(seedRes.result?.isError).toBeFalsy();

    // 两副本并发修改同一个列 colId（均基于 baseSeq = 2）
    const [resA, resB] = await Promise.all([
      callMcpTool(f.appA.app, f.tokenAlice, 'apply_changes', {
        project: f.projectId,
        baseSeq: 2,
        ops: [{ name: 'renameColumn', args: { id: colId, name: 'state_a' } }],
      }),
      callMcpTool(f.appB.app, f.tokenBob, 'apply_changes', {
        project: f.projectId,
        baseSeq: 2,
        ops: [{ name: 'renameColumn', args: { id: colId, name: 'state_b' } }],
      }),
    ]);

    const results = [resA.result!, resB.result!];
    const okOnes = results.filter((r) => !r.isError);
    const errOnes = results.filter((r) => r.isError);
    expect(okOnes).toHaveLength(1);
    expect(errOnes).toHaveLength(1);
    expect(errOnes[0]!.structuredContent?.code).toBe('conflict');
    expect(errOnes[0]!.structuredContent?.currentSeq).toBe(3);

    // 确认最终两副本读到的列一致且无 room_rejections 残留
    const [modelA, modelB] = await Promise.all([
      callMcpTool(f.appA.app, f.tokenAlice, 'get_table', { project: f.projectId, table: 'accounts' }),
      callMcpTool(f.appB.app, f.tokenBob, 'get_table', { project: f.projectId, table: 'accounts' }),
    ]);
    expect(modelA.result?.structuredContent).toEqual(modelB.result?.structuredContent);
    const rejRows = await f.dbA.query('select * from room_rejections where branch_id = $1', [f.branchId]);
    expect(rejRows).toEqual([]);
  });
});
