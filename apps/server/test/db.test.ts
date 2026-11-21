// SQLite 平台库适配器：JSON / 布尔列按“表.列”识别，同名列在不同表里互不影响。
import { expect, test } from 'vitest';

import { inList, isUniqueViolation, openPlatformDb, registerColumnKind } from '../src/db.ts';

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
