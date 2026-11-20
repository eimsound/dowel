// 平台库迁移：先按旧结构（v4）建库、造数据，再走升级，检查
// 用户名生成、重名后缀、第一个用户成为实例管理员，以及 SQLite 重建 users 表后外键仍然完整。
// SQLite 和 PostgreSQL 各跑一遍；PG 需要 Docker（或 DOWEL_TEST_PG），没有时跳过。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BASELINE_VERSION_NAME } from '@dowel/api';
import { addColumn, createSchema, createTable, emptyModel, type Model } from '@dowel/core';
import { type ScriptStep, stepsChecksum } from '@dowel/engines';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { hashPassword } from '../src/auth.ts';
import { isUniqueViolation, MIGRATIONS, openPlatformDb, type PlatformDb } from '../src/db.ts';
import { effectiveRole, loadRoleContext, type ProjectRoleInput } from '../src/roles.ts';
import { readSettings } from '../src/settings.ts';

/** 旧结构停留在第 4 版（邮箱登录，users 没有 username / role / status） */
const OLD_VERSION = 4;

/** 旧数据：按创建时间排第一的用户要变成实例管理员 */
const OLD_USERS = [
  { id: 'u1', email: 'zhang@x.com', name: '张三', at: '2026-01-01T00:00:00.000Z' },
  { id: 'u2', email: 'Zhang@x.com', name: '另一个张三', at: '2026-01-02T00:00:00.000Z' },
  { id: 'u3', email: 'Foo.Bar+baz@y.com', name: 'Foo', at: '2026-01-03T00:00:00.000Z' },
  { id: 'u4', email: '@y.com', name: '只有邮箱符号', at: '2026-01-04T00:00:00.000Z' },
  { id: 'u5', email: 'Wang@x.com', name: '王五', at: '2026-01-05T00:00:00.000Z' },
];

/** 期望生成的用户名和角色：重名加 -2，非法字符变 -，什么都没有时给 user */
const EXPECTED = [
  { id: 'u1', username: 'zhang', role: 'admin' },
  { id: 'u2', username: 'zhang-2', role: 'member' },
  { id: 'u3', username: 'foo-bar-baz', role: 'member' },
  { id: 'u4', username: 'user', role: 'member' },
  { id: 'u5', username: 'wang', role: 'member' },
];

const oldSql = (d: 'sqlite' | 'pg', i: number) => {
  const step = MIGRATIONS[i]!;
  const sql = typeof step === 'function' ? step(d) : step.sql?.(d);
  if (!sql) throw new Error(`第 ${i + 1} 条迁移没有 SQL`);
  return sql;
};

/** 往旧结构里写数据：5 个用户、6 个项目、几条成员关系和一条旧会话 */
const insertOldRows = async (query: (sql: string, params?: unknown[]) => Promise<unknown>, hash: string) => {
  for (const u of OLD_USERS)
    await query(
      'insert into users (id, email, name, password_hash, created_at) values ($1, $2, $3, $4, $5)',
      [u.id, u.email, u.name, hash, u.at],
    );
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p1', '商城', 'u2', '2026-01-05T00:00:00.000Z')",
  );
  // 没有创建者的项目归到 default 组
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p2', 'My Shop', null, '2026-01-06T00:00:00.000Z')",
  );
  // 同一个组里重名的项目：slug 加后缀
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p3', 'My Shop', 'u3', '2026-01-07T00:00:00.000Z')",
  );
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p4', 'My Shop', 'u3', '2026-01-08T00:00:00.000Z')",
  );
  // 创建者被降为 viewer：升级后仍然是 viewer
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p5', 'Only View', 'u4', '2026-01-09T00:00:00.000Z')",
  );
  // 创建者在自己名下的所有项目里都是 owner：升级后成为组管理员
  await query(
    "insert into projects (id, name, created_by, created_at) values ('p6', 'All Owner', 'u5', '2026-01-10T00:00:00.000Z')",
  );
  await query("insert into project_members (project_id, user_id, role) values ('p1', 'u3', 'editor')");
  await query("insert into project_members (project_id, user_id, role) values ('p1', 'u4', 'owner')");
  await query("insert into project_members (project_id, user_id, role) values ('p5', 'u4', 'viewer')");
  await query("insert into project_members (project_id, user_id, role) values ('p6', 'u5', 'owner')");
  await query(
    `insert into sessions (token_hash, user_id, expires_at) values ('old-token-hash', 'u1', '2099-01-01T00:00:00.000Z')`,
  );
};

const check = async (db: PlatformDb) => {
  const users = await db.query<{ id: string; username: string; role: string; status: string }>(
    'select id, username, role, status from users order by created_at',
  );
  expect(users.map((u) => ({ id: u.id, username: u.username, role: u.role }))).toEqual(EXPECTED);
  expect(users.every((u) => u.status === 'active')).toBe(true);

  // 邮箱不再唯一、密码可为空
  await db.query("update users set password_hash = null, email = 'same@x.com' where id in ('u1', 'u2')");

  // 组：每个创建者一个组（用他的用户名），默认权限是 none；没有创建者的项目归 default 组，
  // default 组的管理员只取启用的实例管理员。创建者只有在自己名下所有项目都是 owner 时才是组管理员。
  expect(
    await db.query(
      `select g.slug, g.name, g.default_role as "defaultRole", g.project_creation as "projectCreation",
              gm.user_id as "userId", gm.role
         from groups g join group_members gm on gm.group_id = g.id order by g.slug, gm.user_id`,
    ),
  ).toEqual([
    {
      slug: 'default',
      name: 'default',
      defaultRole: 'none',
      projectCreation: 'members',
      userId: 'u1',
      role: 'admin',
    },
    {
      slug: 'foo-bar-baz',
      name: 'foo-bar-baz',
      defaultRole: 'none',
      projectCreation: 'members',
      userId: 'u3',
      role: 'member',
    },
    {
      slug: 'user',
      name: 'user',
      defaultRole: 'none',
      projectCreation: 'members',
      userId: 'u4',
      role: 'member',
    },
    {
      slug: 'wang',
      name: 'wang',
      defaultRole: 'none',
      projectCreation: 'members',
      userId: 'u5',
      role: 'admin',
    },
    {
      slug: 'zhang-2',
      name: 'zhang-2',
      defaultRole: 'none',
      projectCreation: 'members',
      userId: 'u2',
      role: 'member',
    },
  ]);

  // 项目：归属组、slug 由名字生成、组内重名加后缀
  expect(
    await db.query(
      `select p.id, p.name, p.slug, g.slug as owner from projects p
         join groups g on g.id = p.group_id order by p.id`,
    ),
  ).toEqual([
    { id: 'p1', name: '商城', slug: 'project', owner: 'zhang-2' },
    { id: 'p2', name: 'My Shop', slug: 'my-shop', owner: 'default' },
    { id: 'p3', name: 'My Shop', slug: 'my-shop', owner: 'foo-bar-baz' },
    { id: 'p4', name: 'My Shop', slug: 'my-shop-2', owner: 'foo-bar-baz' },
    { id: 'p5', name: 'Only View', slug: 'only-view', owner: 'user' },
    { id: 'p6', name: 'All Owner', slug: 'all-owner', owner: 'wang' },
  ]);
  expect(await db.query<{ created_by: string }>("select created_by from projects where id = 'p1'")).toEqual([
    { created_by: 'u2' },
  ]);

  // 旧的 project_members 变成项目级授权：owner 映射成 admin，表已删除
  expect(
    await db.query(
      `select subject_kind as "subjectKind", subject_id as "subjectId", role, scope_kind as "scopeKind",
              scope_id as "scopeId"
         from grants order by subject_id, scope_id`,
    ),
  ).toEqual([
    { subjectKind: 'user', subjectId: 'u3', role: 'editor', scopeKind: 'project', scopeId: 'p1' },
    { subjectKind: 'user', subjectId: 'u4', role: 'admin', scopeKind: 'project', scopeId: 'p1' },
    { subjectKind: 'user', subjectId: 'u4', role: 'viewer', scopeKind: 'project', scopeId: 'p5' },
    { subjectKind: 'user', subjectId: 'u5', role: 'admin', scopeKind: 'project', scopeId: 'p6' },
  ]);

  // 升级后每个人的生效权限与升级前一致（角色只由迁移过来的授权决定）
  const roleOf = async (userId: string, pid: string) => {
    const [user] = await db.query<{ role: string }>('select role from users where id = $1', [userId]);
    const [p] = await db.query<ProjectRoleInput>(
      `select p.id, p.group_id as "groupId",
              cast(g.default_role as text) as "groupDefaultRole",
              cast(p.default_role as text) as "projectDefaultRole"
         from projects p join groups g on g.id = p.group_id where p.id = $1`,
      [pid],
    );
    if (!user || !p) throw new Error('迁移后的数据不完整');
    return effectiveRole(await loadRoleContext(db, { id: userId, role: user.role }), p);
  };
  // 创建者被降为 viewer：升级后仍然是 viewer
  expect(await roleOf('u4', 'p5')).toBe('viewer');
  // 创建者被移出项目：升级后看不到这个项目
  expect(await roleOf('u2', 'p1')).toBeNull();
  // 普通成员按旧角色
  expect(await roleOf('u3', 'p1')).toBe('editor');
  // 创建者是自己名下所有项目的 owner：升级后是组管理员
  expect(await roleOf('u5', 'p6')).toBe('admin');

  // 旧会话不保留（登录方式改了），新表带会话元信息
  expect(await db.query('select id from sessions')).toEqual([]);
  await db.query(
    `insert into sessions (id, token_hash, user_id, expires_at, user_agent, ip)
     values ('s1', 'new-token-hash', 'u1', '2099-01-01T00:00:00.000Z', 'test', '127.0.0.1')`,
  );

  // 新表都在；实例设置的 JSON 值能正确读回
  await db.query(`insert into instance_settings (key, value) values ('password_login', $1::text::jsonb)`, [
    JSON.stringify(false),
  ]);
  expect(await db.query('select value from instance_settings where key = $1', ['password_login'])).toEqual([
    { value: false },
  ]);
  await db.query(
    `insert into invites (id, kind, token_hash, created_by, expires_at)
     values ('i1', 'invite', 'h1', 'u1', '2099-01-01T00:00:00.000Z')`,
  );
  expect(await db.query<{ group_ids: unknown }>('select group_ids from invites')).toEqual([
    { group_ids: [] },
  ]);
};

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('平台库升级（$platform）', ({ platform, skip }) => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test.skipIf(skip)('旧库升级：生成用户名、第一个用户成为实例管理员、外键完整', async () => {
    const hash = await hashPassword('password1');
    let db: PlatformDb;
    if (platform === 'sqlite') {
      const dir = mkdtempSync(join(tmpdir(), 'dowel-migrate-'));
      dirs.push(dir);
      const file = join(dir, 'old.db');
      // 按旧结构手工建库：与 openPlatformDb 打出来的完全一样，迁移记录停在 v4
      const conn = new DatabaseSync(file);
      conn.exec('pragma journal_mode = WAL; pragma foreign_keys = on');
      for (let i = 0; i < OLD_VERSION; i++) conn.exec(oldSql('sqlite', i));
      conn.exec(
        "create table dowel_migrations (version int primary key, applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
      );
      const inserted = conn.prepare('insert into dowel_migrations (version) values (?)');
      for (let v = 1; v <= OLD_VERSION; v++) inserted.run(v);
      await insertOldRows(async (sql, params = []) => {
        conn.prepare(sql.replace(/\$(\d+)/g, '?$1')).run(...(params as never[]));
      }, hash);
      conn.close();
      db = await openPlatformDb(file);
    } else {
      const t = await createTestDb('migrate');
      closers.push(t.close);
      for (let i = 0; i < OLD_VERSION; i++) await t.db.exec(oldSql('pg', i));
      await t.db.exec(
        'create table dowel_migrations (version int primary key, applied_at timestamptz not null default now())',
      );
      for (let v = 1; v <= OLD_VERSION; v++)
        await t.db.query('insert into dowel_migrations (version) values ($1)', [v]);
      await insertOldRows((sql, params) => t.db.query(sql, params), hash);
      db = await openPlatformDb(t.url);
    }

    try {
      await check(db);
      // SQLite：重建 users 之后外键检查必须干干净净
      if (platform === 'sqlite') expect(await db.query('pragma foreign_key_check')).toEqual([]);
      const [row] = await db.query<{ v: number }>('select max(version) as v from dowel_migrations');
      expect(row!.v).toBe(MIGRATIONS.length);
    } finally {
      await db.close();
    }
  });
});

// ───── P4a：版本链回填、实例标识 ─────

/** 版本链迁移是 MIGRATIONS 里第一个往 versions 加 number 列的迁移（之后紧跟实例标识迁移） */
const CHAIN_MIGRATION = MIGRATIONS.findIndex(
  (m) => typeof m === 'object' && m.sql?.('sqlite').includes('versions add column number'),
);

/** 没有 public、只有 app.orders 的模型 */
const appModel = (extras: string[] = []): Model => {
  const m = emptyModel();
  const app = createSchema(m, 'app', 'schema-app');
  const t = createTable(m, app, 'orders', 'table-orders');
  addColumn(m, t, { name: 'id', type: 'bigint', id: 'col-id' });
  for (const x of extras) addColumn(m, t, { name: x, type: 'text', id: `col-${x}` });
  return m;
};

/** 一个只有 public schema 和一张 orders 表的模型；extra 在表上再加一列 */
const modelWith = (opts: { extras?: string[]; tableSchema?: 'public' | 's2' } = {}): Model => {
  const m = emptyModel();
  const pub = createSchema(m, 'public', 'schema-public');
  const home = opts.tableSchema === 's2' ? createSchema(m, 's2', 'schema-s2') : pub;
  const t = createTable(m, home, 'orders', 'table-orders');
  addColumn(m, t, { name: 'id', type: 'bigint', id: 'col-id' });
  for (const x of opts.extras ?? []) addColumn(m, t, { name: x, type: 'text', id: `col-${x}` });
  return m;
};

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('平台库升级：版本链与实例标识（$platform）', ({ platform, skip }) => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** 新库：先升到最新，再手工退回到版本链迁移之前（删掉新列、迁移记录和实例标识），然后写旧结构的数据 */
  const openOld = async (): Promise<{ url: string; db: PlatformDb }> => {
    let url: string;
    if (platform === 'sqlite') {
      const dir = mkdtempSync(join(tmpdir(), 'dowel-chain-'));
      dirs.push(dir);
      url = join(dir, 'chain.db');
    } else {
      const t = await createTestDb('chain');
      closers.push(t.close);
      url = t.url;
    }
    const db = await openPlatformDb(url);
    expect(CHAIN_MIGRATION).toBeGreaterThan(0);
    await db.exec('drop index versions_project_number');
    for (const col of [
      'number',
      'parent_id',
      'up_steps',
      'down_steps',
      'checksum',
      'verified_at',
      'verify_report',
      'edited',
      'scope',
    ])
      await db.exec(`alter table versions drop column ${col}`);
    // P4b 的迁移（环境执行状态、versions.executed_at）也退回去：之后升级时会重新应用
    await db.exec('alter table versions drop column executed_at');
    // P4c 的迁移（versions.restored_at）也退回去
    await db.exec('alter table versions drop column restored_at');
    await db.exec('drop table environment_versions');
    // P5b / P6 / P7 HA 的迁移（执行申请、审批、收件箱、Webhook、队列、租约、CI 令牌）也退回去
    for (const t of [
      'ha_leases',
      'webhook_jobs',
      'ci_tokens',
      'token_policies',
      'inbox_items',
      'exec_approvals',
      'exec_requests',
      'webhook_deliveries',
      'webhooks',
    ])
      await db.exec(`drop table ${t}`);
    // P5a 的迁移（执行策略表；exec_policy 已在 P5a 删掉，environments 上的外键/触发器与旧列也已在最新迁移 22 清理）也退回去
    await db.exec('drop table exec_policies');
    for (const col of ['current_version_id', 'last_drift_check', 'drift_status', 'drift_summary'])
      await db.exec(`alter table environments drop column ${col}`);
    await db.query('delete from dowel_migrations where version > $1', [CHAIN_MIGRATION]);
    await db.exec("delete from instance_settings where key = 'instance_id'");
    return { url, db };
  };

  const seed = async (db: PlatformDb) => {
    await db.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
    for (const p of ['p1', 'p2', 'p3', 'p4'])
      await db.query('insert into projects (id, name, group_id, slug) values ($1, $1, $2, $1)', [p, 'g1']);
    // p5：schema 范围是 ['app']（public 在范围之外）；p6：范围是全部，但模型里没有 public（用户把它删了）
    await db.query(
      "insert into projects (id, name, group_id, slug, schemas) values ('p5', 'p5', 'g1', 'p5', $1::text::jsonb)",
      [JSON.stringify(['app'])],
    );
    await db.query("insert into projects (id, name, group_id, slug) values ('p6', 'p6', 'g1', 'p6')");
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
      await db.query("insert into branches (id, project_id, name) values ($1, $2, 'main')", [`b-${p}`, p]);
    const put = (id: string, p: string, seq: number, name: string, at: string, model: Model) =>
      db.query(
        `insert into versions (id, project_id, branch_id, seq, name, model, created_at)
         values ($1, $2, $3, $4, $5, $6::text::jsonb, $7)`,
        [id, p, `b-${p}`, seq, name, JSON.stringify(model), at],
      );
    // p1：空白项目，没有基线。故意先插后面的版本（按 created_at 排序，不是插入顺序）
    await put('p1-b', 'p1', 9, '加备注', '2026-02-02T00:00:00.000Z', modelWith({ extras: ['note'] }));
    await put('p1-a', 'p1', 4, '首个', '2026-02-01T00:00:00.000Z', modelWith());
    // p2：向导导入的 v0 基线 + 一次发布；created_at 相同时按 seq
    await put('p2-0', 'p2', 0, BASELINE_VERSION_NAME, '2026-02-01T00:00:00.000Z', modelWith());
    await put('p2-1', 'p2', 3, '加备注', '2026-02-02T00:00:00.000Z', modelWith({ extras: ['note'] }));
    await put('p2-2', 'p2', 5, '加备忘', '2026-02-02T00:00:00.000Z', modelWith({ extras: ['note', 'memo'] }));
    // p3：规划器不支持的变化（表移到其他 schema）：脚本留空，错误写进验证报告
    await put('p3-a', 'p3', 1, '建表', '2026-02-01T00:00:00.000Z', modelWith());
    await put('p3-b', 'p3', 2, '换 schema', '2026-02-02T00:00:00.000Z', modelWith({ tableSchema: 's2' }));
    await put(
      'p3-c',
      'p3',
      3,
      '再改',
      '2026-02-03T00:00:00.000Z',
      modelWith({ tableSchema: 's2', extras: ['x'] }),
    );
    // p4：没有任何版本
    await put('p5-0', 'p5', 0, BASELINE_VERSION_NAME, '2026-02-01T00:00:00.000Z', appModel());
    await put('p5-1', 'p5', 2, '加备注', '2026-02-02T00:00:00.000Z', appModel(['note']));
    await put('p6-a', 'p6', 1, '首个', '2026-02-01T00:00:00.000Z', appModel());
  };

  test.skipIf(skip)(
    '旧版本补齐 number / parent / steps / checksum，verified_at 留空，实例标识生成且不变',
    async () => {
      const old = await openOld();
      await seed(old.db);
      await old.db.close();
      const db = await openPlatformDb(old.url);
      try {
        const rows = await db.query<{
          id: string;
          project_id: string;
          number: number;
          parent_id: string | null;
          up_steps: ScriptStep[];
          down_steps: ScriptStep[];
          checksum: string;
          verified_at: string | null;
          verify_report: { ok: boolean; error: { message: string } } | null;
          edited: boolean;
          seq: number;
          scope: string[] | null;
        }>(
          `select id, project_id, number, parent_id, up_steps, down_steps, checksum, verified_at, verify_report,
                  edited, seq, scope
           from versions order by project_id, number`,
        );
        const byId = new Map(rows.map((r) => [r.id, r]));
        expect(rows.map((r) => [r.id, r.number, r.parent_id])).toEqual([
          ['p1-a', 1, null], // 没有基线：第一个版本是 v1，parent 为空
          ['p1-b', 2, 'p1-a'],
          ['p2-0', 0, null], // 向导的基线是 v0
          ['p2-1', 1, 'p2-0'],
          ['p2-2', 2, 'p2-1'],
          ['p3-a', 1, null],
          ['p3-b', 2, 'p3-a'],
          ['p3-c', 3, 'p3-b'],
          ['p5-0', 0, null],
          ['p5-1', 1, 'p5-0'],
          ['p6-a', 1, null],
        ]);
        // 空库模型由项目的 schema 范围决定：范围是 ['app'] 的 p5，基线和后面的版本都不碰 public；
        // 范围是全部、模型里没有 public 的 p6，第一个版本要 DROP SCHEMA public（全新的库本来就有它）
        const stepsSql = (id: string) =>
          [...byId.get(id)!.up_steps, ...byId.get(id)!.down_steps].map((x) => x.sql);
        expect(byId.get('p5-0')!.up_steps.map((x) => x.sql)[0]).toBe('CREATE SCHEMA app');
        expect(stepsSql('p5-0').join('\n')).not.toMatch(/public/);
        expect(stepsSql('p5-1').join('\n')).not.toMatch(/public/);
        expect(byId.get('p6-a')!.up_steps.map((x) => x.sql)).toContain('DROP SCHEMA public');
        // 版本记下冻结时项目的 schema 范围（回填成项目行当前的范围；null 表示全部）
        expect(Object.fromEntries(rows.map((r) => [r.id, r.scope]))).toMatchObject({
          'p1-a': null,
          'p2-0': null,
          'p5-0': ['app'],
          'p5-1': ['app'],
          'p6-a': null,
        });
        // seq 原样保留（它是房间操作序号，不是版本号）
        expect(byId.get('p1-b')!.seq).toBe(9);
        // 验证状态：一律未验证，没有被人工编辑过
        expect(rows.every((r) => r.verified_at === null && r.edited === false)).toBe(true);

        // 脚本：由相邻两个版本重新生成
        const sql = (s: ScriptStep[]) => s.map((x) => x.sql);
        expect(sql(byId.get('p1-a')!.up_steps)).toEqual([
          expect.stringMatching(/^CREATE TABLE public\.orders/),
        ]);
        expect(sql(byId.get('p1-a')!.down_steps)).toEqual(['DROP TABLE public.orders']);
        expect(sql(byId.get('p1-b')!.up_steps)).toEqual(['ALTER TABLE public.orders ADD COLUMN note text']);
        expect(sql(byId.get('p1-b')!.down_steps)).toEqual(['ALTER TABLE public.orders DROP COLUMN note']);
        // 基线：在空库上建库，没有回滚
        expect(sql(byId.get('p2-0')!.up_steps)).toEqual([
          expect.stringMatching(/^CREATE TABLE public\.orders/),
        ]);
        expect(byId.get('p2-0')!.down_steps).toEqual([]);
        expect(sql(byId.get('p2-0')!.up_steps).join('\n')).not.toContain('CREATE SCHEMA public');
        // seq 相同的两个同时发布的版本按 created_at、seq 排序
        expect(sql(byId.get('p2-2')!.up_steps)).toEqual(['ALTER TABLE public.orders ADD COLUMN memo text']);
        expect(sql(byId.get('p2-2')!.down_steps)).toEqual(['ALTER TABLE public.orders DROP COLUMN memo']);
        // 所有行：steps 里是 { sql, transactional }，checksum 与步骤内容一致
        for (const r of rows) {
          expect(r.up_steps.every((s) => s.transactional === true && typeof s.sql === 'string')).toBe(true);
          expect(r.checksum).toBe(stepsChecksum(r.up_steps, r.down_steps));
        }
        expect(rows.filter((r) => r.verify_report === null).map((r) => r.id)).toEqual(
          expect.arrayContaining(['p1-a', 'p1-b', 'p2-0', 'p2-1', 'p2-2', 'p3-a']),
        );

        // 规划器报错的版本：脚本留空，原因写进验证报告（界面显示未验证，执行器也不会放行）
        expect(byId.get('p3-b')!.up_steps).toEqual([]);
        expect(byId.get('p3-b')!.verify_report).toMatchObject({ ok: false });
        expect(byId.get('p3-b')!.verify_report!.error.message).toContain('移到其他 schema');
        // 只影响出错的那一个版本：后面的版本照常生成
        expect(byId.get('p3-c')!.verify_report).toBeNull();
        expect(sql(byId.get('p3-c')!.up_steps)).toEqual(['ALTER TABLE s2.orders ADD COLUMN x text']);
        expect(byId.get('p3-a')!.verify_report).toBeNull();

        // (project_id, number) 唯一
        await expect(
          db.query(
            `insert into versions (id, project_id, branch_id, seq, name, model, number)
           values ('dup', 'p1', 'b-p1', 1, 'dup', $1::text::jsonb, 1)`,
            [JSON.stringify(modelWith())],
          ),
        ).rejects.toSatisfy(isUniqueViolation);

        // 实例标识：首次启动（升级）时生成，之后不变
        const [id1] = await db.query<{ value: string }>(
          "select value from instance_settings where key = 'instance_id'",
        );
        expect(id1!.value).toMatch(/^[0-9a-f-]{36}$/);
        expect((await readSettings(db)).instanceId).toBe(id1!.value);
        await db.close();
        const again = await openPlatformDb(old.url);
        try {
          expect((await readSettings(again)).instanceId).toBe(id1!.value);
          const [v] = await again.query<{ v: number }>('select max(version) as v from dowel_migrations');
          expect(v!.v).toBe(MIGRATIONS.length);
        } finally {
          await again.close();
        }
      } finally {
        await db.close().catch(() => {});
      }
    },
  );
});

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('平台库升级：迁移 22 清理前置环境列与约束（$platform）', ({ platform, skip }) => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test.skipIf(skip)(
    '从 v21（含已引用的环境行与外键/触发器）升到最新后删列、删约束且可自由删环境',
    async () => {
      let url: string;
      if (platform === 'sqlite') {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-m22-'));
        dirs.push(dir);
        url = join(dir, 'm22.db');
      } else {
        const t = await createTestDb('m22');
        closers.push(t.close);
        url = t.url;
      }
      const base = await openPlatformDb(url);
      try {
        // 回退迁移 22 与迁移 23：删掉 HA 表与 worker_id，加回旧列、旧外键/触发器，并写入互相引用的环境行模拟 v21 库
        await base.exec('drop table ha_leases');
        await base.exec('drop table webhook_jobs');
        await base.exec('alter table exec_requests drop column worker_id');
        await base.exec('alter table environments add column prerequisite_id text');
        if (platform === 'pg') {
          await base.exec(
            'alter table environments add constraint environments_prerequisite_fk foreign key (prerequisite_id) references environments (id)',
          );
        } else {
          await base.exec(`create trigger environments_prerequisite_delete before delete on environments
           when exists (select 1 from environments e where e.prerequisite_id = old.id and e.id <> old.id)
           begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;
         create trigger environments_prerequisite_insert before insert on environments
           when new.prerequisite_id is not null
            and not exists (select 1 from environments e where e.id = new.prerequisite_id)
           begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;
         create trigger environments_prerequisite_update before update of prerequisite_id on environments
           when new.prerequisite_id is not null
            and not exists (select 1 from environments e where e.id = new.prerequisite_id)
           begin select raise(abort, 'FOREIGN KEY constraint failed: environments.prerequisite_id'); end;`);
        }
        await base.query('delete from dowel_migrations where version >= $1', [MIGRATIONS.length - 1]);
        await base.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
        await base.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
        await base.query(
          "insert into environments (id, project_id, name, url_enc, production) values ('e-dev', 'p1', 'dev', 'x', $1)",
          [false],
        );
        await base.query(
          "insert into environments (id, project_id, name, url_enc, production, prerequisite_id) values ('e-prod', 'p1', 'prod', 'x', $1, 'e-dev')",
          [true],
        );
        // 升级前：删除被引用的 e-dev 会被外键 / 触发器拦住
        await expect(base.query("delete from environments where id = 'e-dev'")).rejects.toThrow();
      } finally {
        await base.close();
      }
      const upgraded = await openPlatformDb(url);
      try {
        const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);
        if (platform === 'pg') {
          const cols = await upgraded.query<{ c: string }>(
            "select column_name as c from information_schema.columns where table_name = 'environments' and column_name = 'prerequisite_id'",
          );
          expect(cols).toEqual([]);
        } else {
          const cols = (await upgraded.query<{ name: string }>('pragma table_info(environments)')).filter(
            (r) => r.name === 'prerequisite_id',
          );
          expect(cols).toEqual([]);
          const triggers = await upgraded.query<{ name: string }>(
            "select name from sqlite_master where type = 'trigger' and name like 'environments_prerequisite_%'",
          );
          expect(triggers).toEqual([]);
        }
        // 升级后：删除原被引用的环境畅通无阻
        await upgraded.query("delete from environments where id = 'e-dev'");
      } finally {
        await upgraded.close();
      }
    },
  );
});
