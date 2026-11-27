// 选影期间项目被并发删除（Issue #170）：请求已经通过鉴权，项目在 shadows.forProject* 读项目 / 环境行之前被删，
// 不能把“查不到项目行 / 环境行”误判为“活项目还没有配置环境”（422 shadow_unavailable / flush no_shadow），
// 而要和 accessIn 一致报“项目不存在”：HTTP 404、MCP project_not_found、OpaqueRefresher 的 shadowOf 'forgotten'。
// 活项目确实没有环境时仍是原来的 422 文案、限速退回规则不变。
//
// 删除时机完全由测试决定：在 shadows 读项目方言（SQLite）/ 环境列表（外部方言）/ 指定环境的那条 SQL 执行之前，
// 直接在平台库里删掉项目的全部行（模拟别的副本删的、derive.forget / shadows.forget 还没送达的窗口，
// 本副本内存里的 forgotten 标记、房间、缓存都还在，不会替我们兜底）。零 Docker：平台库 SQLite :memory:。
import { addCheck, addColumn, all, createSchema, createTable, getDialect, newId } from '@dowel/core';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { newMcpToken } from '../src/mcp-tokens.ts';
import { KeyedLimiter, LoginLimiter } from '../src/rate-limit.ts';
import { encrypt } from '../src/secrets.ts';
import { ShadowError } from '../src/shadow.ts';
import { ProjectGoneError } from '../src/shadows.ts';
import { editModel, makeUser, PASSWORD } from './support.ts';

process.env.DOWEL_SECRET ??= 'shadows-project-gone-0123456789';

const NO_ENV =
  '项目还没有配置环境。导入 SQL、验证迁移都需要一个真实的数据库实例作影子库，请先在“环境”里添加项目要部署到的数据库';

/** shadows.projectDialect 的 SQL（SQLite 项目在这里决定走内存影子库） */
const DIALECT_SQL = 'select dialect from projects where id = $1';
/** shadows.forProject（未指定环境）/ forProjectVersions 读环境列表的 SQL 共同片段 */
const ENV_LIST_SQL = 'from environments where project_id = $1 order by created_at';
/** shadows.env（指定环境）的 SQL 片段 */
const ENV_ONE_SQL = 'where e.id = $1 and e.project_id = $2';

let db: PlatformDb;
let created: ReturnType<typeof createApp>;
let limiter: KeyedLimiter;
let adminCookie = '';
let adminId = '';
let groupId = '';
/** 下一次执行包含 match 的平台库查询之前删掉项目 pid（只触发一次） */
let armed: { match: string; pid: string } | null = null;
let fired = 0;
let existingChecks = 0;

const call = async (method: string, path: string, json?: unknown, cookie = adminCookie) => {
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
  return { status: r.status, data: data as Record<string, unknown> };
};

/** 和删除路由同样的顺序删光项目的平台库行，但不碰内存（不 forget、不踢房间、不关影子库） */
const dropProjectRows = async (pid: string) => {
  await db.transaction(async (tx) => {
    for (const table of ['room_rejections', 'room_commits', 'room_snapshots'])
      await tx.query(
        `delete from ${table} where branch_id in (select id from branches where project_id = $1)`,
        [pid],
      );
    await tx.query('delete from versions where project_id = $1', [pid]);
    await tx.query('delete from environments where project_id = $1', [pid]);
    await tx.query('delete from branches where project_id = $1', [pid]);
    await tx.query("delete from grants where scope_kind = 'project' and scope_id = $1", [pid]);
    await tx.query('delete from project_redirects where project_id = $1', [pid]);
    await tx.query('delete from projects where id = $1', [pid]);
  });
};

const newProject = async (name: string, dialect: 'pg' | 'sqlite') => {
  const p = await call('POST', '/api/projects', { name, groupId, dialect });
  expect(p.status, JSON.stringify(p.data)).toBe(201);
  const pid = p.data.id as string;
  const [b] = await db.query<{ id: string }>(
    "select id from branches where project_id = $1 and name = 'main'",
    [pid],
  );
  return { pid, branch: b!.id };
};

/** 外部方言项目的一个环境（地址不可达；被删的场景里根本不会连库） */
const addEnv = async (pid: string) => {
  const id = newId();
  await db.query(
    `insert into environments (id, project_id, name, url_enc, production, allow_same_instance)
     values ($1, $2, $3, $4, false, false)`,
    [id, pid, `dev-${id.slice(-6)}`, encrypt('postgres://u:p@127.0.0.1:1/app')],
  );
  return id;
};

const projectRowCount = async (pid: string) =>
  (await db.query('select id from projects where id = $1', [pid])).length;

const verifyTool = async (token: string, project: string) => {
  const res = await created.app.request('/api/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verify_migration', arguments: { project, from: 'empty', to: 'head' } },
    }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const line = res.headers.get('content-type')?.includes('text/event-stream')
    ? text
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .at(-1)!
    : text;
  return (JSON.parse(line) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } })
    .result;
};

const issueToken = async () => {
  const t = newMcpToken();
  await db.query(
    `insert into mcp_tokens (id, user_id, kind, name, prefix, token_hash, scopes, project_ids, expires_at)
     values ($1, $2, 'personal', $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8)`,
    [
      newId(),
      adminId,
      'tok',
      t.prefix,
      t.hash,
      JSON.stringify(['read', 'verify']),
      null,
      new Date(Date.now() + 86_400_000).toISOString(),
    ],
  );
  return t.token;
};

/** 工作副本加一张表（按方言的默认 schema）；withCheck 时再加一条 CHECK，flush 一定要回影子库规范化（会走 shadowOf） */
const addPlainTable = (pid: string, withCheck = false) =>
  editModel(created.rooms, db, pid, (m) => {
    const schema =
      all(m, 'schema')[0]?.id ?? createSchema(m, getDialect(m.dialect).capabilities.defaultSchema);
    const t = createTable(m, schema, 'orders');
    addColumn(m, t, { name: 'total', type: 'integer' });
    if (withCheck) addCheck(m, t, 'total>0', 'ck_total');
  });

const seedCheck = (pid: string) => addPlainTable(pid, true);

beforeEach(async () => {
  db = await openPlatformDb(':memory:');
  limiter = new KeyedLimiter({ limit: 1, windowMs: 60_000 });
  created = createApp(db, {
    loginLimiter: new LoginLimiter({ limit: 10_000, ipLimit: 10_000 }),
    connectionLimiter: limiter,
    mailer: async () => {},
  });
  const admin = await makeUser(db, 'admin', { name: '管理员', role: 'admin' });
  adminId = admin.id;
  const login = await created.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  adminCookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const g = await call('POST', '/api/groups', { slug: 'gone-g', name: '并发删除组', defaultRole: 'none' });
  expect(g.status).toBe(201);
  groupId = g.data.id as string;

  armed = null;
  fired = 0;
  existingChecks = 0;
  const origQuery = db.query.bind(db);
  db.query = (async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
    if (sql.includes('from branches where id in')) existingChecks++;
    const a = armed;
    if (a && sql.includes(a.match)) {
      armed = null;
      fired++;
      await dropProjectRows(a.pid);
    }
    return origQuery<T>(sql, params);
  }) as typeof db.query;
});

afterEach(async () => {
  created.refresher.stop();
  await created.refresher.drain();
  created.requests.stop();
  await created.requests.drain();
  await created.rooms.flush();
  await created.shadows.close();
  await created.bus.close();
  await db.close();
});

test('ProjectGoneError 是 404 HTTPException、不是 ShadowError（不会被“影子库不可用”分支吞掉）', () => {
  const e = new ProjectGoneError();
  expect(e).toBeInstanceOf(HTTPException);
  expect(e).not.toBeInstanceOf(ShadowError);
  expect(e.status).toBe(404);
  expect(e.message).toBe('项目不存在');
});

test('Shadows 直接调用：项目行不存在时 forProject / forProjectVersions / forProjectTarget / configState 都抛 ProjectGoneError', async () => {
  const s = created.shadows;
  await expect(s.forProject('no-such-project')).rejects.toBeInstanceOf(ProjectGoneError);
  await expect(s.forProject('no-such-project', 'no-such-env')).rejects.toBeInstanceOf(ProjectGoneError);
  await expect(s.forProjectVersions('no-such-project')).rejects.toBeInstanceOf(ProjectGoneError);
  await expect(s.forProjectTarget('no-such-project')).rejects.toBeInstanceOf(ProjectGoneError);
  await expect(s.configState('no-such-project')).rejects.toBeInstanceOf(ProjectGoneError);
  // 活项目但环境不存在：仍是原来的“环境不存在”404（不是 ProjectGoneError）
  const { pid } = await newProject('活项目-环境不存在', 'pg');
  const err = await s.forProject(pid, 'no-such-env').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HTTPException);
  expect(err).not.toBeInstanceOf(ProjectGoneError);
  expect((err as HTTPException).message).toBe('环境不存在');
});

describe.each([
  { dialect: 'sqlite' as const, match: DIALECT_SQL },
  { dialect: 'pg' as const, match: ENV_LIST_SQL },
])('鉴权通过后、选影之前项目被删（$dialect）', ({ dialect, match }) => {
  const setup = async (name: string) => {
    const p = await newProject(name, dialect);
    if (dialect === 'pg') await addEnv(p.pid);
    return p;
  };

  test('POST /import → 404 项目不存在（不是 422 未配置环境）', async () => {
    const { pid } = await setup('导入');
    armed = { match, pid };
    const res = await call('POST', `/api/projects/${pid}/import`, { sql: 'create table t (id integer);' });
    expect(fired).toBe(1);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toEqual({ error: '项目不存在' });
    expect(await projectRowCount(pid)).toBe(0);
  });

  test('POST /verify → 404 项目不存在', async () => {
    const { pid } = await setup('临时验证');
    await addPlainTable(pid);
    armed = { match, pid };
    const res = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
    expect(fired).toBe(1);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toEqual({ error: '项目不存在' });
  });

  test('发布 POST /versions → 404，不会把“没有影子库”当成未验证继续发布', async () => {
    const { pid } = await setup('发布');
    await addPlainTable(pid);
    armed = { match, pid };
    const res = await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    expect(fired).toBe(1);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toEqual({ error: '项目不存在' });
    expect(await db.query('select id from versions where project_id = $1', [pid])).toHaveLength(0);
  });

  test('重新验证 POST /versions/:vid/verify → 404 项目不存在', async () => {
    const { pid } = await newProject('重新验证', dialect);
    await addPlainTable(pid);
    // 先在活项目上发布一个版本（PG 项目此时还没环境：未验证发布）
    const pub = await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    expect(pub.status, JSON.stringify(pub.data)).toBe(201);
    const [v] = await db.query<{ id: string }>(
      'select id from versions where project_id = $1 and number = 1',
      [pid],
    );
    if (dialect === 'pg') await addEnv(pid);
    armed = { match, pid };
    const res = await call('POST', `/api/projects/${pid}/versions/${v!.id}/verify`);
    expect(fired).toBe(1);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toEqual({ error: '项目不存在' });
  });

  test('MCP verify_migration → project_not_found，且退回连接限速额度', async () => {
    const { pid } = await setup('MCP 验证');
    await addPlainTable(pid);
    const token = await issueToken();
    armed = { match, pid };
    const res = await verifyTool(token, pid);
    expect(fired).toBe(1);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: 'project_not_found', message: '项目不存在' });
    // 限额 1：没连库就失败的必须精确退回，否则桶里会留下一条记录
    expect(limiter.keyCount).toBe(0);
  });

  test('OpaqueRefresher shadowOf：查完 branches 后项目被删 → flush skipped(forgotten)，不是 no_shadow、也不再复核 branches', async () => {
    const { pid, branch } = await setup('派生刷新');
    await seedCheck(pid);
    armed = { match, pid };
    const out = await created.refresher.flush(branch);
    expect(fired).toBe(1);
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'forgotten' });
    // shadowOf 直接报 forgotten：不走 null → gone() 的二次 branches 复核
    expect(existingChecks).toBe(0);
  });
});

test('外部方言项目指定环境：env 查询之前项目被删 → 404 项目不存在（不是“环境不存在”）', async () => {
  const { pid } = await newProject('指定环境', 'pg');
  const eid = await addEnv(pid);
  armed = { match: ENV_ONE_SQL, pid };
  const res = await call('POST', `/api/projects/${pid}/import`, {
    sql: 'create table t (id integer);',
    env: eid,
  });
  expect(fired).toBe(1);
  expect(res.status, JSON.stringify(res.data)).toBe(404);
  expect(res.data).toEqual({ error: '项目不存在' });
});

describe('活项目回归：没有环境仍是原来的 422 / no_shadow，限速退回不变', () => {
  test('POST /import 与 POST /verify → 422 原文案', async () => {
    const { pid } = await newProject('活项目-无环境', 'pg');
    const imp = await call('POST', `/api/projects/${pid}/import`, { sql: 'create table t (id integer);' });
    expect(imp.status, JSON.stringify(imp.data)).toBe(422);
    expect(imp.data).toEqual({ error: NO_ENV });
    await addPlainTable(pid);
    const ver = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
    expect(ver.status, JSON.stringify(ver.data)).toBe(422);
    expect(ver.data).toEqual({ error: NO_ENV });
  });

  test('发布：没有环境时照旧发布为未验证并写明原因', async () => {
    const { pid } = await newProject('活项目-发布', 'pg');
    await addPlainTable(pid);
    const pub = await call('POST', `/api/projects/${pid}/versions`, { name: 'v1' });
    expect(pub.status, JSON.stringify(pub.data)).toBe(201);
    const [v] = await db.query<{ verified_at: string | null }>(
      'select verified_at from versions where project_id = $1 and number = 1',
      [pid],
    );
    expect(v!.verified_at).toBeNull();
    expect(JSON.stringify(pub.data)).toContain(NO_ENV);
  });

  test('MCP verify_migration → shadow_unavailable 原文案，退回限速额度', async () => {
    const { pid } = await newProject('活项目-MCP', 'pg');
    await addPlainTable(pid);
    const token = await issueToken();
    for (let i = 0; i < 3; i++) {
      const res = await verifyTool(token, pid);
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({ code: 'shadow_unavailable', message: NO_ENV });
    }
    expect(limiter.keyCount).toBe(0);
  });

  test('POST /normalize → 422 shadow_unavailable 并退回限速；flush → skipped(no_shadow)', async () => {
    const { pid, branch } = await newProject('活项目-规范化', 'pg');
    await seedCheck(pid);
    for (let i = 0; i < 3; i++) {
      const res = await call('POST', `/api/projects/${pid}/normalize`, {});
      expect(res.status, JSON.stringify(res.data)).toBe(422);
      expect(res.data).toEqual({ error: NO_ENV, code: 'shadow_unavailable' });
    }
    expect(limiter.keyCount).toBe(0);
    const out = await created.refresher.flush(branch);
    expect(out).toMatchObject({ kind: 'skipped', skippedReason: 'no_shadow' });
  });

  test('POST /normalize：选影之前项目被删 → 404 并退回限速（#147 契约不变）', async () => {
    const { pid } = await newProject('规范化-被删', 'pg');
    await addEnv(pid);
    await seedCheck(pid);
    armed = { match: ENV_LIST_SQL, pid };
    const res = await call('POST', `/api/projects/${pid}/normalize`, {});
    expect(fired).toBe(1);
    expect(res.status, JSON.stringify(res.data)).toBe(404);
    expect(res.data).toEqual({ error: '项目不存在' });
    expect(limiter.keyCount).toBe(0);
  });
});
