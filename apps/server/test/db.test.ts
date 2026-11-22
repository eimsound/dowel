// SQLite 平台库适配器：JSON / 布尔列按“表.列”识别，同名列在不同表里互不影响。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { inList, isUniqueViolation, MIGRATIONS, openPlatformDb, registerColumnKind } from '../src/db.ts';

test('同名列在不同表里可以一个是 JSON、一个是布尔、一个是普通值', async () => {
  const db = await openPlatformDb(':memory:');
  try {
    registerColumnKind('kind_test_json', 'payload', 'json');
    registerColumnKind('kind_test_bool', 'payload', 'bool');
    await db.exec(`
      create table kind_test_json (payload text);
      create table kind_test_bool (payload integer);
      create table kind_test_text (payload text);
    `);
    await db.query('insert into kind_test_json (payload) values ($1)', [JSON.stringify({ a: 1 })]);
    await db.query('insert into kind_test_bool (payload) values ($1)', [true]);
    await db.query('insert into kind_test_text (payload) values ($1)', [JSON.stringify({ a: 1 })]);
    await db.query('insert into kind_test_text (payload) values ($1)', ['plain']);

    const [json] = await db.query<{ payload: unknown }>('select payload from kind_test_json');
    expect(json!.payload).toEqual({ a: 1 });
    const [bool] = await db.query<{ payload: unknown }>('select payload from kind_test_bool');
    expect(bool!.payload).toBe(true);
    const text = await db.query<{ payload: unknown }>('select payload from kind_test_text order by rowid');
    expect(text[0]!.payload).toBe('{"a":1}');
    expect(text[1]!.payload).toBe('plain');

    // 别名不影响识别（按原始表.列判断，结果键用别名）
    const [alias] = await db.query<{ p: unknown }>('select payload as p from kind_test_json');
    expect(alias!.p).toEqual({ a: 1 });
  } finally {
    await db.close();
  }
});

test('真实表的 JSON 列（审计 data）读出为对象', async () => {
  const db = await openPlatformDb(':memory:');
  try {
    await db.query(
      `insert into audit_events (id, actor_kind, action, data)
       values ($1, 'system', 'test', $2::text::jsonb)`,
      ['a1', JSON.stringify({ hello: '世界' })],
    );
    const [row] = await db.query<{ data: unknown }>('select data from audit_events where id = $1', ['a1']);
    expect(row!.data).toEqual({ hello: '世界' });
  } finally {
    await db.close();
  }
});

test('唯一约束冲突的识别：SQLite 和 PG 的错误形状都能认出来', async () => {
  // PG（postgres.js）：code = 23505
  expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(true);
  // SQLite（node:sqlite）：errcode = 2067 / 1555
  expect(isUniqueViolation(Object.assign(new Error('constraint failed'), { errcode: 2067 }))).toBe(true);
  expect(isUniqueViolation(Object.assign(new Error('constraint failed'), { errcode: 1555 }))).toBe(true);
  // 兜底：只看错误信息
  expect(isUniqueViolation(new Error('UNIQUE constraint failed: users.username'))).toBe(true);
  // 包了一层的错误
  expect(isUniqueViolation(Object.assign(new Error('outer'), { cause: { code: '23505' } }))).toBe(true);
  // 其他错误不误判
  expect(isUniqueViolation(new Error('syntax error'))).toBe(false);
  expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
  expect(isUniqueViolation(null)).toBe(false);

  // 真的触发一次 SQLite 的唯一约束错误
  const db = await openPlatformDb(':memory:');
  try {
    await db.query("insert into users (id, username, name) values ('u1', 'dup', 'a')");
    const err = await db
      .query("insert into users (id, username, name) values ('u2', 'dup', 'b')")
      .catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  } finally {
    await db.close();
  }
});

test('inList：in (…) 列表的占位符，可以指定起始序号', () => {
  expect(inList(['a'])).toBe('$1');
  expect(inList(['a', 'b', 'c'])).toBe('$1, $2, $3');
  expect(inList(['a', 'b'], 3)).toBe('$3, $4');
});

const verifyClockMigrationAndMonotonicity = async (platform: 'sqlite' | 'pg') => {
  let dir: string | null = null;
  let closePg: (() => Promise<void>) | null = null;
  let url: string;
  if (platform === 'sqlite') {
    dir = mkdtempSync(join(tmpdir(), 'dowel-clock-mig-'));
    url = join(dir, 'clock.db');
  } else {
    const pg = await createTestDb('clock_mig');
    closePg = pg.close;
    url = pg.url;
  }

  try {
    // 1. 建到最新版本后回退迁移 27（layout_ver / sections_ver）并插入存量数据
    const base = await openPlatformDb(url);
    try {
      await base.exec(
        'alter table branches drop column layout_ver; alter table branches drop column sections_ver;',
      );
      await base.query('delete from dowel_migrations where version >= $1', [27]);
      await base.query("insert into groups (id, slug, name) values ('g1', 'g1', '组')");
      await base.query("insert into projects (id, name, group_id, slug) values ('p1', 'p1', 'g1', 'p1')");
      await base.query(
        `insert into branches (id, project_id, name, layout, sections)
         values ('b1', 'p1', 'main', $1::text::jsonb, $2::text::jsonb)`,
        [
          JSON.stringify({ tbl_existing: { x: 12, y: 34 } }),
          JSON.stringify([{ id: 's-existing', name: '存量板块', color: 'peer-1', tables: ['tbl_existing'] }]),
        ],
      );
    } finally {
      await base.close();
    }

    // 2. 重开升级：既有行获得默认值 0，且保留既有 layout / sections 数据
    const upgraded = await openPlatformDb(url);
    try {
      const [ver] = await upgraded.query<{ v: number }>('select max(version) as v from dowel_migrations');
      expect(Number(ver?.v)).toBe(MIGRATIONS.length);

      const [row] = await upgraded.query<{
        layout: Record<string, { x: number; y: number }>;
        sections: { id: string; name: string; color: string; tables: string[] }[];
        layout_ver: number;
        sections_ver: number;
      }>('select layout, sections, layout_ver, sections_ver from branches where id = $1', ['b1']);
      expect(row?.layout).toEqual({ tbl_existing: { x: 12, y: 34 } });
      expect(row?.sections).toEqual([
        { id: 's-existing', name: '存量板块', color: 'peer-1', tables: ['tbl_existing'] },
      ]);
      expect(Number(row?.layout_ver)).toBe(0);
      expect(Number(row?.sections_ver)).toBe(0);

      // 3. 设更高时钟并重跑迁移 27：验证幂等性，不覆盖既有值
      await upgraded.query('update branches set layout_ver = 7, sections_ver = 9 where id = $1', ['b1']);
      await upgraded.query('delete from dowel_migrations where version >= $1', [27]);
    } finally {
      await upgraded.close();
    }

    const rerun = await openPlatformDb(url);
    try {
      const [afterRerun] = await rerun.query<{ layout_ver: number; sections_ver: number }>(
        'select layout_ver, sections_ver from branches where id = $1',
        ['b1'],
      );
      expect(Number(afterRerun?.layout_ver)).toBe(7);
      expect(Number(afterRerun?.sections_ver)).toBe(9);

      // 4. 单调性 SQL（PG greatest / SQLite max）用较低版本（3）更新绝不降级
      const [afterLower] =
        platform === 'pg'
          ? await rerun.query<{ layout_ver: number; sections_ver: number }>(
              'update branches set layout_ver = greatest(layout_ver, $2::bigint), sections_ver = greatest(sections_ver, $2::bigint) where id = $1 returning layout_ver, sections_ver',
              ['b1', 3],
            )
          : await rerun.query<{ layout_ver: number; sections_ver: number }>(
              'update branches set layout_ver = max(layout_ver, $2), sections_ver = max(sections_ver, $2) where id = $1 returning layout_ver, sections_ver',
              ['b1', 3],
            );
      expect(Number(afterLower?.layout_ver)).toBe(7);
      expect(Number(afterLower?.sections_ver)).toBe(9);
    } finally {
      await rerun.close();
    }
  } finally {
    if (closePg) await closePg().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
};

test('SQLite 存量分支升级补齐 layout_ver/sections_ver = 0，重跑幂等且单调更新不降级', async () => {
  await verifyClockMigrationAndMonotonicity('sqlite');
});

describe.skipIf(!PG_URL)('PG 存量分支时钟迁移与单调性', () => {
  test('PG 存量分支升级补齐 layout_ver/sections_ver = 0，重跑幂等且单调更新不降级', async () => {
    await verifyClockMigrationAndMonotonicity('pg');
  });
});
