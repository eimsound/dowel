import { createAll, normalizeType, plan, validate } from '@dowel/core';
import { describe, expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, resetShadow, runSteps } from '../../verifier/src/index.ts';
import { diffSnapshots, importSnapshot, readSnapshot } from '../src/index.ts';

const db = useTestDb('roundtrip');

/** 执行一段 DDL → 读快照 → 导入成 IR → 从 IR 重新建库 → 读快照，两份快照必须相同 */
const roundtrip = async (ddl: string) => {
  await resetShadow(db());
  await db().exec('CREATE SCHEMA public');
  await db().exec(`SET search_path = public; ${ddl}`);
  const s1 = await readSnapshot(db());
  const m = importSnapshot(s1);
  expect(validate(m)).toEqual([]);
  expect(plan(m, m)).toEqual([]); // 同一个模型和自己比较，没有任何迁移
  const s2 = await build(db(), m);
  expect(diffSnapshots(s1, s2)).toEqual([]);
  return { m, s1 };
};

describe.skipIf(!PG_URL)('导入 → 重建 往返一致', () => {
  test('基础对象', async () => {
    await roundtrip(`
      create type mood as enum ('ok', 'sad');
      create table users (
        id serial primary key,
        email varchar(255) not null unique,
        name text default 'anon',
        age int check (age > 0),
        m mood default 'ok',
        tags text[],
        created timestamptz not null default now()
      );
      comment on table users is '用户';
      comment on column users.email is '邮箱';
      create table posts (
        id bigint generated always as identity primary key,
        uid int not null references users on delete cascade,
        title text not null,
        body text,
        slug text generated always as (lower(title)) stored,
        unique nulls not distinct (uid, title),
        check (length(title) < 200 and title <> '')
      );
      create index on posts (uid, id desc nulls last);
      create index posts_lower on posts (lower(title)) include (body) where body is not null;
      create sequence counter as integer increment by 5 start with 100 cycle;
    `);
  });

  test('多 schema、引号名字、关键字名字', async () => {
    await roundtrip(`
      create schema "My App";
      create table "My App"."Order" ("select" int, "Group" text, primary key ("select"));
      create table "My App".items (id int primary key, ord int references "My App"."Order" ("select") deferrable initially deferred);
    `);
  });

  test('域与 NOT NULL（PG 15/16 typnotnull 与 PG 17+ pg_constraint 跨版本往返）', async () => {
    await roundtrip(`
      create domain pos_int as int not null check (value > 0);
      create domain non_empty_email as text not null default 'a@b.c' check (length(value) > 0);
      create table accounts (
        id int primary key,
        score pos_int,
        email non_empty_email
      );
    `);
  });

  test('PG normalizeType 与真实 PG format_type 读回一致', async () => {
    await resetShadow(db());
    await db().exec('CREATE SCHEMA public');
    await db().exec(`
      SET search_path = public;
      CREATE DOMAIN "MyDomain" AS integer;
      CREATE DOMAIN "My  Domain" AS text;
    `);
    const hasVector =
      (await db().query<{ ok: number }>("SELECT 1 AS ok FROM pg_available_extensions WHERE name = 'vector'"))
        .length > 0;
    if (hasVector) {
      await db().exec('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    }

    // CI 镜像为 pgvector/pgvector:pg15..19（不含 PostGIS），因此 geometry(Point,4326) 的保留逻辑由 packages/core/test/column-normalization.test.ts 覆盖
    const cases: string[] = [
      'int',
      'INT4',
      'int2',
      'int8',
      'bool',
      'varchar',
      'varchar(255)',
      'CHARACTER   VARYING ( 64 )',
      'char',
      'character',
      'char(4)',
      '"char"',
      'decimal',
      'decimal(10, 2)',
      'numeric(12, 4)',
      'bit',
      'bit(8)',
      'bit[]',
      'varbit',
      'varbit(16)',
      'bit varying(16)',
      'float',
      'float(1)',
      'float(10)',
      'float(24)',
      'float(25)',
      'float(53)',
      'float(10)[]',
      'float4',
      'float8',
      'double   precision',
      'timestamp',
      'timestamptz',
      'timestamp(3)',
      'TIMESTAMP(3) WITH TIME ZONE',
      'TIMESTAMPTZ(3)[]',
      'time',
      'timetz',
      'time(3)',
      'TIME(3) WITH TIME ZONE',
      'interval',
      'interval(3)',
      'interval year to month',
      'INTERVAL YEAR TO MONTH',
      'INTERVAL DAY TO SECOND(3)',
      '  Text  ',
      'text [ ]',
      'public."MyDomain"',
      'PUBLIC."My  Domain"[]',
    ];
    if (hasVector) cases.push('PUBLIC.VECTOR( 3 )');

    const cols = cases.map((t, i) => `c${i} ${t}`).join(', ');
    await db().exec(`SET search_path = public; CREATE TABLE norm_check (${cols})`);
    const snap = await readSnapshot(db());
    const table = snap.tables['public.norm_check']!;
    for (const [i, raw] of cases.entries()) {
      expect(table.columns[`c${i}`]!.type, raw).toBe(normalizeType(raw, 'pg'));
    }
  });
});

test.skipIf(!PG_URL)('从空模型建库再删光', async () => {
  const { m, s1 } = await roundtrip(`create table t (a int primary key, b text unique)`);
  const pgMajor = Math.floor(s1.version / 10000);
  await resetShadow(db());
  await runSteps(db(), createAll(m, { pgMajor }));
  const empty = { ...m, objects: {} };
  await runSteps(db(), plan(m, empty, { pgMajor }));
  const s = await readSnapshot(db());
  expect(Object.keys(s.tables)).toEqual([]);
  expect(Object.keys(s.schemas)).toEqual([]);
});
