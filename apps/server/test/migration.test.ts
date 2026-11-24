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
import { afterAll, describe, expect, test, vi } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { hashPassword } from '../src/auth.ts';
import {
  isEmailUniqueViolation,
  isUniqueViolation,
  MIGRATIONS,
  openPlatformDb,
  type PlatformDb,
} from '../src/db.ts';
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

  // 密码可为空，多个 null 邮箱允许，但非空邮箱大小写不敏感全实例唯一
  await db.query("update users set password_hash = null, email = null where id in ('u1', 'u2')");
  await db.query("update users set email = 'Unique@X.com' where id = 'u1'");
  await expect(db.query("update users set email = 'unique@x.com' where id = 'u2'")).rejects.toSatisfy(
    isEmailUniqueViolation,
  );

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
        await base.query('delete from dowel_migrations where version >= $1', [22]);
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

describe.each([
  { platform: 'sqlite', skip: false },
  { platform: 'pg', skip: !PG_URL },
])('平台库升级：迁移 24 为 room_rejections 增加单调游标列与索引（$platform）', ({ platform, skip }) => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of closers) await c();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test.skipIf(skip)(
    '从 v23（含存量 room_rejections）升到最新：自动回填递增 id、保留唯一约束与 ON CONFLICT、索引生效且重跑幂等',
    async () => {
      let url: string;
      if (platform === 'sqlite') {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-m24-'));
        dirs.push(dir);
        url = join(dir, 'm24.db');
      } else {
        const t = await createTestDb('m24');
        closers.push(t.close);
        url = t.url;
      }

      const base = await openPlatformDb(url);
      try {
        // 退回迁移 24，还原为 v23 的 room_rejections 表结构（无 id 列、无 room_rejections_branch_id_idx）
        await base.exec('drop index if exists room_rejections_branch_id_idx');
        if (platform === 'pg') {
          await base.exec('alter table room_rejections drop column if exists id');
        } else {
          await base.exec(`drop table room_rejections;
            create table room_rejections (
              branch_id text not null references branches on delete cascade,
              client text not null,
              n int not null,
              code text not null,
              message text not null,
              primary key (branch_id, client, n)
            );`);
        }
        await base.query('delete from dowel_migrations where version >= $1', [24]);

        await base.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
        await base.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
        await base.query("insert into branches (id, project_id, name) values ('b1', 'p1', 'main')");
        await base.query("insert into branches (id, project_id, name) values ('b2', 'p1', 'dev')");

        // 写入存量拒绝记录（跨多分支与多客户端）
        await base.query(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c1', 1, 'conflict', '旧拒绝1')",
        );
        await base.query(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b2', 'u2:c1', 1, 'invalid', '旧拒绝2')",
        );
        await base.query(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c1', 2, 'dependency', '旧拒绝3')",
        );
      } finally {
        await base.close();
      }

      const upgraded = await openPlatformDb(url);
      try {
        const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);

        // 存量行已回填严格单调递增的正整数 id
        const existing = await upgraded.query<{
          id: number;
          branch_id: string;
          client: string;
          n: number;
          message: string;
        }>('select id, branch_id, client, n, message from room_rejections order by id asc');
        expect(existing).toHaveLength(3);
        expect(existing.every((r) => typeof r.id === 'number' && Number.isInteger(r.id) && r.id > 0)).toBe(
          true,
        );
        expect(existing[0]!.id).toBeLessThan(existing[1]!.id);
        expect(existing[1]!.id).toBeLessThan(existing[2]!.id);
        const maxExistingId = existing[2]!.id;

        // 索引已创建
        if (platform === 'pg') {
          const idx = await upgraded.query<{ indexname: string }>(
            "select indexname from pg_indexes where tablename = 'room_rejections' and indexname = 'room_rejections_branch_id_idx'",
          );
          expect(idx).toHaveLength(1);
        } else {
          const idx = await upgraded.query<{ name: string }>(
            "select name from sqlite_master where type = 'index' and name = 'room_rejections_branch_id_idx'",
          );
          expect(idx).toHaveLength(1);
          expect(await upgraded.query('pragma foreign_key_check')).toEqual([]);
        }

        // 新插入记录自动分配大于存量最大值的单调递增 id（支持 RETURNING id）
        const [ins1] = await upgraded.query<{ id: number }>(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c1', 3, 'conflict', '新拒绝4') returning id",
        );
        const [ins2] = await upgraded.query<{ id: number }>(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c2', 1, 'invalid', '新拒绝5') returning id",
        );
        expect(Number(ins1!.id)).toBeGreaterThan(maxExistingId);
        expect(Number(ins2!.id)).toBeGreaterThan(Number(ins1!.id));

        // 唯一约束 (branch_id, client, n) 与 ON CONFLICT DO NOTHING 仍完整生效
        const dupErr = await upgraded
          .query(
            "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c1', 3, 'conflict', '重复')",
          )
          .catch((e: unknown) => e);
        expect(isUniqueViolation(dupErr)).toBe(true);

        const skipped = await upgraded.query<{ id: number }>(
          "insert into room_rejections (branch_id, client, n, code, message) values ('b1', 'u1:c1', 3, 'conflict', '覆盖尝试') on conflict do nothing returning id",
        );
        expect(skipped).toEqual([]);
        const [kept] = await upgraded.query<{ message: string }>(
          "select message from room_rejections where branch_id = 'b1' and client = 'u1:c1' and n = 3",
        );
        expect(kept!.message).toBe('新拒绝4');

        // 幂等重跑迁移 24：保留既有 id 与数据
        await upgraded.query('delete from dowel_migrations where version >= $1', [24]);
        await upgraded.close();
        const rerun = await openPlatformDb(url);
        try {
          const afterRerun = await rerun.query<{ id: number; n: number }>(
            "select id, n from room_rejections where branch_id = 'b1' and client = 'u1:c1' and n = 3",
          );
          expect(afterRerun).toEqual([{ id: Number(ins1!.id), n: 3 }]);
        } finally {
          await rerun.close();
        }
      } finally {
        await upgraded.close().catch(() => {});
      }
    },
  );
});

describe('从 v27 升级迁移 28：must_change_password 与清理历史 setup_token', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  test.each([
    { platform: 'sqlite' as const, skip: false },
    { platform: 'pg' as const, skip: !PG_URL },
  ])(
    '新增 users.must_change_password 默认 false、清理 setup_token 且重跑幂等（$platform）',
    async ({ platform, skip }) => {
      if (skip) return;
      let url = '';
      if (platform === 'pg') {
        const pg = await createTestDb('mig28');
        cleanups.push(pg.close);
        url = pg.url;
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-mig28-'));
        cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
        url = join(dir, 'dowel.db');
      }

      const db = await openPlatformDb(url);
      try {
        await db.query('insert into users (id, username, name, role, status) values ($1, $2, $3, $4, $5)', [
          'u1',
          'legacy-admin',
          '旧管理员',
          'admin',
          'active',
        ]);
        await db.query(
          platform === 'pg'
            ? 'insert into instance_settings (key, value) values ($1, $2::text::jsonb)'
            : 'insert into instance_settings (key, value) values ($1, $2)',
          ['setup_token', JSON.stringify({ plain: 'stale-token' })],
        );
        // 模拟停在 v27：删掉 v28+ 迁移记录并移回旧列，以真实测试迁移 28（含重复运行幂等）
        await db.query('delete from dowel_migrations where version >= $1', [28]);
      } finally {
        await db.close();
      }

      // 首次升级再重跑
      const upgraded = await openPlatformDb(url);
      try {
        const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);
        expect(
          await upgraded.query('select key from instance_settings where key = $1', ['setup_token']),
        ).toEqual([]);
        const [u] = await upgraded.query<{ mustChangePassword: boolean | number }>(
          'select must_change_password as "mustChangePassword" from users where id = $1',
          ['u1'],
        );
        expect(Boolean(u!.mustChangePassword)).toBe(false);

        // 幂等重跑迁移 28+
        await upgraded.query('delete from dowel_migrations where version >= $1', [28]);
      } finally {
        await upgraded.close();
      }

      const rerun = await openPlatformDb(url);
      try {
        const [ver] = await rerun.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);
        const [u] = await rerun.query<{ mustChangePassword: boolean | number }>(
          'select must_change_password as "mustChangePassword" from users where id = $1',
          ['u1'],
        );
        expect(Boolean(u!.mustChangePassword)).toBe(false);
      } finally {
        await rerun.close();
      }
    },
  );
});

describe('从 v28 升级迁移 29：邮箱规范化、安全去重、大小写不敏感部分唯一索引与 invites.email', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  test.each([
    { platform: 'sqlite' as const, skip: false },
    { platform: 'pg' as const, skip: !PG_URL },
  ])(
    '历史重复邮箱安全去重（活跃管理员优先/最早优先）、告警不泄邮箱、索引拦截重邮箱并允许多个 null（$platform）',
    async ({ platform, skip }) => {
      if (skip) return;
      let url = '';
      if (platform === 'pg') {
        const pg = await createTestDb('mig29');
        cleanups.push(pg.close);
        url = pg.url;
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-mig29-'));
        cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
        url = join(dir, 'dowel.db');
      }

      const base = await openPlatformDb(url);
      try {
        await base.exec('drop index if exists users_email_unique');
        await base.exec('alter table invites drop column email');
        await base.query('delete from dowel_migrations where version >= $1', [29]);

        // 组1：重复邮箱，含一个较早的普通成员、一个停用管理员、一个活跃管理员 → 保留活跃管理员
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-m', 'member1', '成员', '  Dup@Example.com \n', 'member', 'active', '2026-01-01T00:00:00.000Z'],
        );
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-da', 'disadmin', '停用管', 'DUP@example.com', 'admin', 'disabled', '2026-01-01T00:00:00.000Z'],
        );
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-aa', 'actadmin', '活跃管', 'dup@example.com', 'admin', 'active', '2026-01-02T00:00:00.000Z'],
        );

        // 组2：均非活跃管理员，按 created_at asc, id asc 保留最早一位
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-e1', 'early', '早', '  Same@Y.com ', 'member', 'active', '2026-01-01T00:00:00.000Z'],
        );
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-e2', 'late', '晚', 'same@y.com', 'member', 'active', '2026-01-03T00:00:00.000Z'],
        );

        // 空串与纯空白规范化为 null，且允许多个 null
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-b1', 'blank1', '空1', ' \t\n ', 'member', 'active', '2026-01-04T00:00:00.000Z'],
        );
        await base.query(
          `insert into users (id, username, name, email, role, status, created_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          ['u-b2', 'blank2', '空2', null, 'member', 'active', '2026-01-05T00:00:00.000Z'],
        );
      } finally {
        await base.close();
      }

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let upgraded: PlatformDb;
      try {
        upgraded = await openPlatformDb(url);
      } finally {
        const logs = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
        warnSpy.mockRestore();
        expect(logs).toContain('u-m(member1)');
        expect(logs).toContain('u-da(disadmin)');
        expect(logs).toContain('u-e2(late)');
        // 告警日志不泄露邮箱地址
        expect(logs.toLowerCase()).not.toContain('dup@example.com');
        expect(logs.toLowerCase()).not.toContain('same@y.com');
      }

      try {
        const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);

        const rows = await upgraded.query<{ id: string; email: string | null }>(
          'select id, email from users order by id',
        );
        const byId = new Map(rows.map((r) => [r.id, r.email]));
        expect(byId.get('u-aa')).toBe('dup@example.com');
        expect(byId.get('u-m')).toBeNull();
        expect(byId.get('u-da')).toBeNull();
        expect(byId.get('u-e1')).toBe('same@y.com');
        expect(byId.get('u-e2')).toBeNull();
        expect(byId.get('u-b1')).toBeNull();
        expect(byId.get('u-b2')).toBeNull();

        // 唯一索引大小写不敏感拦截重邮箱，同时允许多条 null
        await expect(
          upgraded.query(
            "insert into users (id, username, name, email) values ('u-dup', 'dupnew', 'Dup', 'DUP@EXAMPLE.COM')",
          ),
        ).rejects.toSatisfy(isEmailUniqueViolation);
        await upgraded.query(
          "insert into users (id, username, name, email) values ('u-null2', 'null2', 'Null2', null)",
        );

        // invites.email 可写入与查询
        await upgraded.query(
          "insert into invites (id, kind, token_hash, email, expires_at) values ('inv1', 'invite', 'th1', 'inv@x.com', '2099-01-01T00:00:00.000Z')",
        );
        const [inv] = await upgraded.query<{ email: string | null }>(
          "select email from invites where id = 'inv1'",
        );
        expect(inv!.email).toBe('inv@x.com');

        // 幂等重跑迁移 29
        await upgraded.query('delete from dowel_migrations where version >= $1', [29]);
        await upgraded.close();
        const rerun = await openPlatformDb(url);
        try {
          const [ver2] = await rerun.query<{ v: number }>('select max(version) as v from dowel_migrations');
          expect(ver2!.v).toBe(MIGRATIONS.length);
        } finally {
          await rerun.close();
        }
      } finally {
        await upgraded.close().catch(() => {});
      }
    },
  );
});

const MCP_MIGRATION = MIGRATIONS.findIndex(
  (m) => typeof m === 'function' && m('sqlite').includes('create table if not exists mcp_tokens'),
);

describe('M3-C 迁移：mcp_tokens 表结构、JSON 往返、外键与幂等性', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  test.each([
    { platform: 'sqlite' as const, skip: false },
    { platform: 'pg' as const, skip: !PG_URL },
  ])(
    'mcp_tokens 列齐全、索引生效、scopes/project_ids JSON 往返、级联/置空与幂等重跑（$platform）',
    async ({ platform, skip }) => {
      if (skip) return;
      expect(MCP_MIGRATION).toBeGreaterThan(0);
      const mcpVersion = MCP_MIGRATION + 1;

      let url = '';
      if (platform === 'pg') {
        const pg = await createTestDb('mig_mcp');
        cleanups.push(pg.close);
        url = pg.url;
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-mig-mcp-'));
        cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
        url = join(dir, 'dowel.db');
      }

      const db = await openPlatformDb(url);
      try {
        const [ver] = await db.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);

        const expectedCols = [
          'id',
          'user_id',
          'kind',
          'name',
          'prefix',
          'token_hash',
          'scopes',
          'project_ids',
          'created_at',
          'expires_at',
          'revoked_at',
          'revoked_by',
          'revoked_reason',
          'last_used_at',
          'last_used_ip',
        ];
        if (platform === 'pg') {
          const cols = await db.query<{ name: string }>(
            "select column_name as name from information_schema.columns where table_schema = current_schema() and table_name = 'mcp_tokens'",
          );
          expect(cols.map((c) => c.name).sort()).toEqual([...expectedCols].sort());
          const idx = await db.query<{ indexname: string }>(
            "select indexname from pg_indexes where tablename = 'mcp_tokens' and indexname = 'mcp_tokens_user'",
          );
          expect(idx).toHaveLength(1);
        } else {
          const cols = await db.query<{ name: string }>('pragma table_info(mcp_tokens)');
          expect(cols.map((c) => c.name).sort()).toEqual([...expectedCols].sort());
          const idx = await db.query<{ name: string }>(
            "select name from sqlite_master where type = 'index' and name = 'mcp_tokens_user'",
          );
          expect(idx).toHaveLength(1);
        }

        await db.query(
          "insert into users (id, username, name) values ('u1', 'u1', '用户1'), ('u2', 'u2', '管理员')",
        );
        await db.query(
          `insert into mcp_tokens
             (id, user_id, name, prefix, token_hash, scopes, project_ids, expires_at, revoked_at, revoked_by, revoked_reason)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8, $9, $10, $11)`,
          [
            't1',
            'u1',
            '工作区令牌',
            'dwm_12345678',
            'hash-1',
            JSON.stringify(['read', 'verify']),
            JSON.stringify(['p1', 'p2']),
            '2099-01-01T00:00:00.000Z',
            '2026-06-01T00:00:00.000Z',
            'u2',
            'admin',
          ],
        );
        await db.query(
          `insert into mcp_tokens
             (id, user_id, name, prefix, token_hash, scopes, project_ids, expires_at)
           values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8)`,
          [
            't2',
            'u1',
            '全项目令牌',
            'dwm_abcdefgh',
            'hash-2',
            JSON.stringify(['read']),
            null,
            '2099-01-01T00:00:00.000Z',
          ],
        );

        const rows = await db.query<{
          id: string;
          kind: string;
          scopes: unknown;
          project_ids: unknown;
          revoked_by: string | null;
        }>('select id, kind, scopes, project_ids, revoked_by from mcp_tokens order by id');
        expect(rows).toEqual([
          {
            id: 't1',
            kind: 'personal',
            scopes: ['read', 'verify'],
            project_ids: ['p1', 'p2'],
            revoked_by: 'u2',
          },
          {
            id: 't2',
            kind: 'personal',
            scopes: ['read'],
            project_ids: null,
            revoked_by: null,
          },
        ]);

        // token_hash 唯一约束生效
        const dup = await db
          .query(
            `insert into mcp_tokens (id, user_id, name, prefix, token_hash, scopes, expires_at)
             values ('t-dup', 'u1', '重复', 'dwm_00000000', 'hash-1', $1::text::jsonb, '2099-01-01T00:00:00.000Z')`,
            [JSON.stringify(['read'])],
          )
          .catch((e: unknown) => e);
        expect(isUniqueViolation(dup)).toBe(true);

        // revoked_by 删除置空（on delete set null），user_id 级联删除（on delete cascade）
        await db.query("delete from users where id = 'u2'");
        const [afterRevokerDelete] = await db.query<{ revoked_by: string | null }>(
          "select revoked_by from mcp_tokens where id = 't1'",
        );
        expect(afterRevokerDelete!.revoked_by).toBeNull();

        await db.query("delete from users where id = 'u1'");
        expect(await db.query('select id from mcp_tokens')).toEqual([]);

        // 幂等重跑该条迁移，已有数据保持完好
        await db.query("insert into users (id, username, name) values ('u3', 'u3', '用户3')");
        await db.query(
          `insert into mcp_tokens (id, user_id, name, prefix, token_hash, scopes, project_ids, expires_at)
           values ('t3', 'u3', '保留令牌', 'dwm_keep1234', 'hash-3', $1::text::jsonb, $2::text::jsonb, '2099-01-01T00:00:00.000Z')`,
          [JSON.stringify(['read', 'write']), JSON.stringify(['p9'])],
        );
        await db.query('delete from dowel_migrations where version >= $1', [mcpVersion]);
      } finally {
        await db.close();
      }

      const rerun = await openPlatformDb(url);
      try {
        const [ver2] = await rerun.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver2!.v).toBe(MIGRATIONS.length);
        const rows = await rerun.query<{ id: string; scopes: unknown; project_ids: unknown }>(
          "select id, scopes, project_ids from mcp_tokens where id = 't3'",
        );
        expect(rows).toEqual([{ id: 't3', scopes: ['read', 'write'], project_ids: ['p9'] }]);
      } finally {
        await rerun.close();
      }
    },
  );
});

describe('从上一个迁移升级到最新：versions.retired_at 与 retired_by（ADR 0013）', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const c of cleanups) await c();
  });

  test.each([
    { platform: 'sqlite' as const, skip: false },
    { platform: 'pg' as const, skip: !PG_URL },
  ])(
    '存量版本 retired_at/retired_by 默认为 null、外键 on delete set null 生效且重跑幂等（$platform）',
    async ({ platform, skip }) => {
      if (skip) return;
      let url = '';
      if (platform === 'pg') {
        const pg = await createTestDb('mig31');
        cleanups.push(pg.close);
        url = pg.url;
      } else {
        const dir = mkdtempSync(join(tmpdir(), 'dowel-mig31-'));
        cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
        url = join(dir, 'dowel.db');
      }

      const targetMigration = MIGRATIONS.length;
      const base = await openPlatformDb(url);
      try {
        await base.query('insert into users (id, username, name, role, status) values ($1, $2, $3, $4, $5)', [
          'u1',
          'retirer1',
          '作废人1',
          'admin',
          'active',
        ]);
        await base.query('insert into users (id, username, name, role, status) values ($1, $2, $3, $4, $5)', [
          'u2',
          'retirer2',
          '作废人2',
          'member',
          'active',
        ]);
        await base.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
        await base.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
        await base.query("insert into branches (id, project_id, name) values ('b1', 'p1', 'main')");

        if (platform === 'pg') {
          await base.exec('alter table versions drop column if exists retired_at');
          await base.exec('alter table versions drop column if exists retired_by');
          await base.query('delete from dowel_migrations where version >= $1', [targetMigration]);
        } else {
          await base.query('delete from dowel_migrations where version >= $1', [targetMigration]);
        }
      } finally {
        await base.close();
      }

      if (platform === 'sqlite') {
        const conn = new DatabaseSync(url);
        try {
          conn.exec('pragma foreign_keys = off; pragma legacy_alter_table = on;');
          conn.exec(`create table versions_pre_retire (
            id text primary key,
            project_id text not null references projects on delete cascade,
            branch_id text not null references branches on delete cascade,
            seq bigint not null,
            name text not null,
            model text not null,
            created_by text references users on delete set null,
            created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
            number int,
            parent_id text,
            up_steps text,
            down_steps text,
            checksum text,
            verified_at text,
            verify_report text,
            edited integer not null default 0,
            scope text,
            executed_at text,
            restored_at text
          )`);
          conn.exec('drop table versions');
          conn.exec('alter table versions_pre_retire rename to versions');
          conn.exec('create unique index versions_project_number on versions (project_id, number)');
          expect(conn.prepare('pragma foreign_key_check').all()).toEqual([]);
        } finally {
          conn.close();
        }
      }

      // 在“升级前（无 retired_at / retired_by 列）”的库里写入存量版本行
      if (platform === 'sqlite') {
        const conn = new DatabaseSync(url);
        try {
          conn
            .prepare(
              `insert into versions (id, project_id, branch_id, seq, name, model, number, parent_id, up_steps, down_steps, checksum)
               values ('v1', 'p1', 'b1', 1, 'v1', ?, 1, null, '[]', '[]', ?)`,
            )
            .run(JSON.stringify(emptyModel()), stepsChecksum([], []));
        } finally {
          conn.close();
        }
      } else {
        const { connect } = await import('../../../test/pg.ts');
        const c = connect(url);
        try {
          await c.db.query(
            `insert into versions (id, project_id, branch_id, seq, name, model, number, parent_id, up_steps, down_steps, checksum)
             values ('v1', 'p1', 'b1', 1, 'v1', $1::text::jsonb, 1, null, '[]'::text::jsonb, '[]'::text::jsonb, $2)`,
            [JSON.stringify(emptyModel()), stepsChecksum([], [])],
          );
        } finally {
          await c.close();
        }
      }

      const upgraded = await openPlatformDb(url);
      try {
        const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
        expect(ver!.v).toBe(MIGRATIONS.length);

        const [v1] = await upgraded.query<{ retiredAt: unknown; retiredBy: string | null }>(
          'select retired_at as "retiredAt", retired_by as "retiredBy" from versions where id = $1',
          ['v1'],
        );
        expect(v1).toEqual({ retiredAt: null, retiredBy: null });

        // 写入 retired_at / retired_by 并验证 users 删除时 on delete set null 生效
        const retiredIso = '2026-11-24T12:00:00.000Z';
        await upgraded.query(
          `insert into versions (id, project_id, branch_id, seq, name, model, number, parent_id, up_steps, down_steps, checksum, retired_at, retired_by)
           values ('v2', 'p1', 'b1', 2, 'v2', $1::text::jsonb, 2, 'v1', '[]'::text::jsonb, '[]'::text::jsonb, $2, $3, 'u1'),
                  ('v3', 'p1', 'b1', 3, 'v3', $1::text::jsonb, 3, 'v2', '[]'::text::jsonb, '[]'::text::jsonb, $2, $3, 'u2')`,
          [JSON.stringify(emptyModel()), stepsChecksum([], []), retiredIso],
        );
        await upgraded.query("delete from users where id = 'u2'");
        const rows = await upgraded.query<{ id: string; retiredAt: unknown; retiredBy: string | null }>(
          'select id, retired_at as "retiredAt", retired_by as "retiredBy" from versions order by number asc',
        );
        expect(rows[1]!.retiredBy).toBe('u1');
        expect(rows[1]!.retiredAt).toBeTruthy();
        expect(rows[2]!.retiredBy).toBeNull();
        if (platform === 'sqlite') expect(await upgraded.query('pragma foreign_key_check')).toEqual([]);

        // 幂等重跑迁移：保留存量与既有作废标记
        await upgraded.query('delete from dowel_migrations where version >= $1', [targetMigration]);
        await upgraded.close();
        const rerun = await openPlatformDb(url);
        try {
          const [ver2] = await rerun.query<{ v: number }>('select max(version) as v from dowel_migrations');
          expect(ver2!.v).toBe(MIGRATIONS.length);
          const afterRerun = await rerun.query<{ id: string; retiredBy: string | null }>(
            'select id, retired_by as "retiredBy" from versions order by number asc',
          );
          expect(afterRerun).toEqual([
            { id: 'v1', retiredBy: null },
            { id: 'v2', retiredBy: 'u1' },
            { id: 'v3', retiredBy: null },
          ]);
        } finally {
          await rerun.close();
        }
      } finally {
        await upgraded.close().catch(() => {});
      }
    },
  );
});
