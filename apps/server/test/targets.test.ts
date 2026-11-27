// M1b 验收：在真实 PG 实例上跑通“导入 → 修改 → 生成迁移 → 验证（同实例影子库）→ 执行 → 再导入一致”。
// 用测试 PG 实例（Testcontainers 或 DOWEL_TEST_PG，见 test/pg-container.ts），没有 Docker 时跳过。
import type { AddressInfo } from 'node:net';

import { all, plan } from '@dowel/core';
import { SyncClient, type ToClient } from '@dowel/sync';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';

import { dbUrl, PG_URL } from '../../../test/pg.ts';
import { createApp, openPlatformDb, type PlatformDb } from '../src/index.ts';
import { decrypt, encrypt, maskUrl } from '../src/secrets.ts';
import { stripOwnership } from '../src/shadow.ts';
import { connectPg, pullSchema, SHADOW_MARK, shadowDbName } from '../src/targets.ts';
import { makeUser, PASSWORD } from './support.ts';

const ADMIN = PG_URL;
process.env.DOWEL_SECRET ??= 'test-secret-0123456789';

test('连接信息加密、脱敏；影子库名截断；过滤所有者语句', () => {
  const url = 'postgres://u:p%40ss@h:5432/db';
  expect(decrypt(encrypt(url))).toBe(url);
  expect(maskUrl(url)).toBe('postgres://u:***@h:5432/db');
  expect(shadowDbName('shop')).toBe('shop_dowel');
  const long = shadowDbName('x'.repeat(60));
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(63);
  expect(long.endsWith('_dowel')).toBe(true);
  expect(
    stripOwnership('CREATE TABLE t (a int);\nALTER TABLE public.t OWNER TO postgres;\nGRANT ALL ON t TO x;'),
  ).toBe('CREATE TABLE t (a int);');
});

describe.runIf(ADMIN)('真实 PG 实例', () => {
  const db = dbUrl;
  const admin = ADMIN ? connectPg(ADMIN) : (null as never);
  let base = '';
  let cookie = '';
  let stop: () => Promise<void>;
  let pdb: PlatformDb;

  beforeAll(async () => {
    for (const d of ['shop', 'shop_dowel', 'prod', 'prod_dowel', 'other'])
      await admin.db.exec(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    await admin.db.exec('CREATE DATABASE shop');
    await admin.db.exec('CREATE DATABASE prod');
    await admin.db.exec('CREATE DATABASE other');
    const shop = connectPg(db('shop'));
    await shop.db.exec(`
      create type status as enum ('new', 'paid');
      create table customers (id bigint generated always as identity primary key, email text not null unique);
      create table orders (
        id serial primary key,
        customer_id bigint not null references customers,
        status status not null default 'new',
        total numeric(12,2) check (total >= 0)
      );
      create index on orders (customer_id);
      create view paid_orders as select id, total from orders where status = 'paid';
      insert into customers (email) values ('a@x.com');
      insert into orders (customer_id, total) values (1, 10);`);
    await shop.close();
    const other = connectPg(db('other'));
    await other.db.exec('create table important (id int)');
    await other.close();

    pdb = await openPlatformDb(':memory:');
    const { app, injectWebSocket, rooms, shadows } = createApp(pdb);
    const server = serve({ fetch: app.fetch, port: 0 });
    injectWebSocket(server);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = async () => {
      await rooms.flush();
      await shadows.close();
      (server as import('node:http').Server).closeAllConnections();
      await new Promise((r) => server.close(r));
      await pdb.close();
    };
    await makeUser(pdb, 'zhang', { name: '张三' });
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhang', password: PASSWORD }),
    });
    cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    // 项目必须属于一个组：这个文件里的项目都放在同一个组里
    const g = await fetch(`${base}/api/groups`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'targets', name: '目标库测试' }),
    });
    groupId = ((await g.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await stop?.();
    await admin.close();
  });

  let groupId = '';
  const call = async (method: string, path: string, json?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await r.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { text };
    }
    return { status: r.status, data };
  };

  test('导入 → 修改 → 生成迁移 → 在同实例影子库验证 → 执行 → 再导入一致', async () => {
    const pid = (await call('POST', '/api/projects', { name: 'shop', groupId })).data.id as string;
    const env = await call('POST', `/api/projects/${pid}/environments`, {
      name: 'dev',
      url: db('shop'),
      production: false,
    });
    expect(env.status).toBe(201);
    expect(env.data.versionNum as number).toBeGreaterThanOrEqual(180000);
    const eid = env.data.id as string;
    const [envAudit] = await pdb.query<{ target_id: string }>(
      'select target_id from audit_events where action = $1',
      ['environment.create'],
    );
    expect(envAudit!.target_id).toBe(eid);
    const list = await call('GET', `/api/projects/${pid}/environments`);
    expect(JSON.stringify(list.data)).not.toContain(new URL(ADMIN).password); // 密码不外泄

    // 从线上库导入
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(200);
    const v1 = (await call('POST', `/api/projects/${pid}/versions`, { name: 'pulled' })).data.id as string;

    // 通过同步层修改：列改名、加列、加 CHECK、枚举加值
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/projects/${pid}/sync`, {
      headers: { cookie },
    });
    const client = new SyncClient('t', { format: 1, dialect: 'pg', objects: {} });
    client.send = (m) => ws.send(JSON.stringify(m));
    ws.on('message', (d) => {
      const text = Buffer.isBuffer(d)
        ? d.toString('utf8')
        : Array.isArray(d)
          ? Buffer.concat(d).toString('utf8')
          : new TextDecoder().decode(d);
      const m = JSON.parse(text) as ToClient;
      if (['welcome', 'snapshot', 'commit', 'reject'].includes(m.t)) client.receive(m);
    });
    await new Promise((r) => ws.once('open', r));
    client.connect();
    const until = async (f: () => boolean) => {
      for (let i = 0; i < 500 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(f()).toBe(true);
    };
    await until(() => all(client.view, 'table').length === 2);
    const m = client.view;
    const orders = all(m, 'table').find((t) => t.name === 'orders')!;
    const total = all(m, 'column').find((c) => c.name === 'total')!;
    const status = all(m, 'enum')[0]!;
    client.mutate('renameColumn', { id: total.id, name: 'amount' });
    client.mutate('addColumn', { table: orders.id, column: { id: 'note', name: 'note', type: 'text' } });
    client.mutate('addCheck', { id: 'k', table: orders.id, expr: "(note <> '')" });
    client.mutate('addEnumValue', { id: status.id, value: 'refunded' });
    await until(() => client.pending.length === 0 && client.notices.length === 0);
    ws.close();

    // 验证：自动在目标实例上建 shop_dowel 并执行
    const r = await call('POST', `/api/projects/${pid}/verify`, { from: v1, to: 'head' });
    expect(r.data.error).toBeNull();
    expect(r.data.ok).toBe(true);
    // 与发布同一套验证（Issue #199）：影子库名后带它的数据库完整版本号
    expect(r.data.shadow).toMatch(/^dev：shop_dowel(（[^）]+）)?$/);
    expect(r.data.code).toBeNull();
    const [mark] = await admin.db.query<{ c: string }>(
      "select shobj_description(oid, 'pg_database') as c from pg_database where datname = 'shop_dowel'",
    );
    expect(mark!.c).toBe(SHADOW_MARK);
    const up = (r.data.up as { sql: string }[]).map((s) => s.sql);
    expect(up).toContain('ALTER TABLE public.orders RENAME COLUMN total TO amount');

    // 把迁移真正执行到 shop 上（带上固定的会话设置），再导入：必须与工作副本一致，且业务数据还在
    const sql = (await call('GET', `/api/projects/${pid}/migration?from=${v1}&to=head&format=sql`)).data
      .text as string;
    const shop = connectPg(db('shop'));
    await shop.db.exec(sql);
    const [row] = await shop.db.query<{ amount: string }>('select amount from public.orders');
    expect(row!.amount).toBe('10.00');
    await shop.close();
    const head = (await call('GET', `/api/projects/${pid}/migration?from=head&to=head`)).data;
    expect(head.up).toEqual([]);
    const live = await pullSchema(db('shop'));
    const ws2Model = await (async () => {
      const res = await call('POST', `/api/projects/${pid}/versions`, { name: 'after' });
      return res.data.id as string;
    })();
    const diff = await call('GET', `/api/projects/${pid}/migration?from=${ws2Model}&to=head`);
    expect(diff.data.up).toEqual([]);
    // 线上库读出的结构与工作副本相同：用重新导入（沿用 ID）后的模型比较
    expect((await call('POST', `/api/projects/${pid}/environments/${eid}/pull`)).status).toBe(200);
    const afterPull = await call('GET', `/api/projects/${pid}/migration?from=${ws2Model}&to=head`);
    expect(afterPull.data.up).toEqual([]);
    expect(all(live, 'table').length).toBe(2);
  });

  test('重新导入沿用已有对象的 ID（画布布局、改名识别不丢）', async () => {
    const pid = (await call('POST', '/api/projects', { name: 'reimport', groupId })).data.id as string;
    const eid = (
      await call('POST', `/api/projects/${pid}/environments`, {
        name: 'dev',
        url: db('shop'),
        production: false,
      })
    ).data.id as string;
    await call('POST', `/api/projects/${pid}/environments/${eid}/pull`);
    const v1 = (await call('POST', `/api/projects/${pid}/versions`, { name: 'a' })).data.id as string;
    await call('POST', `/api/projects/${pid}/environments/${eid}/pull`);
    const d = await call('GET', `/api/projects/${pid}/migration?from=${v1}&to=head`);
    expect(d.data.up).toEqual([]); // ID 都沿用了，重新导入不产生任何变化
  });

  test('生产环境默认不用同一实例；非空且无标记的库拒绝作影子库', async () => {
    const pid = (await call('POST', '/api/projects', { name: 'prod', groupId })).data.id as string;
    await call('POST', `/api/projects/${pid}/environments`, { name: 'prod', url: db('prod') });
    const r = await call('POST', `/api/projects/${pid}/verify`, { from: 'empty', to: 'head' });
    expect(r.status).toBe(422);
    expect(r.data.error as string).toContain('生产环境');

    const bad = await call('POST', `/api/projects/${pid}/environments`, {
      name: 'x',
      url: db('prod'),
      shadowUrl: db('other'),
    });
    expect(bad.status).toBe(422);
    expect(bad.data.error as string).toContain('不是空库');
    const [n] = await admin.db.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname = 'prod_dowel'",
    );
    expect(n!.n).toBe(0);
  });

  test('删除环境写入审计', async () => {
    const pid = (await call('POST', '/api/projects', { name: 'audit-delete', groupId })).data.id as string;
    const eid = (
      await call('POST', `/api/projects/${pid}/environments`, {
        name: 'dev',
        url: db('shop'),
        production: false,
      })
    ).data.id as string;
    expect((await call('DELETE', `/api/projects/${pid}/environments/${eid}`)).status).toBe(200);
    const [row] = await pdb.query<{ target_kind: string; data: unknown }>(
      'select target_kind, data from audit_events where action = $1 and target_id = $2',
      ['environment.delete', eid],
    );
    expect(row).toMatchObject({ target_kind: 'environment', data: { projectId: pid } });
  });

  test('导入 SQL 时用环境的影子库（真实实例的扩展可用）', async () => {
    const pid = (await call('POST', '/api/projects', { name: 'sqlimport', groupId })).data.id as string;
    await call('POST', `/api/projects/${pid}/environments`, {
      name: 'dev',
      url: db('shop'),
      production: false,
    });
    const r = await call('POST', `/api/projects/${pid}/import`, {
      sql: 'create extension if not exists pgcrypto; create table t (id uuid primary key default gen_random_uuid());\nALTER TABLE public.t OWNER TO nobody_role;',
    });
    expect(r.status).toBe(200);
    // shop 本身没有被动过
    const [n] = await connectPg(db('shop')).db.query<{ n: number }>(
      "select count(*)::int as n from pg_tables where schemaname = 'public' and tablename = 't'",
    );
    expect(n!.n).toBe(0);
  });
});

void plan;
