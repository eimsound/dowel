// 哪些语句不能放进事务：每一类各一条（前后端共用，服务端冻结迁移和界面编辑脚本都按这个判断）
import { describe, expect, test } from 'vitest';
import {
  findInstanceLevelStatement,
  INSTANCE_LEVEL_DESCRIPTION,
  isConcurrentDdlSql,
  isInstanceLevelSql,
  isNontransactionalSql,
} from '../src/index.ts';

describe('isNontransactionalSql', () => {
  // 线性度：输入放大 4 倍，耗时不能放大到 8 倍以上（二次方会放大 16 倍）；再加一个宽松的绝对上限。
  // 不用“多少毫秒内完成”这种墙钟断言，机器忙的时候会误报。取 3 次里最快的一次，先预热
  const timeOf = (sql: string) => {
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      isNontransactionalSql(sql);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  const expectLinear = (make: (n: number) => string, expected: boolean) => {
    expect(isNontransactionalSql(make(1_000))).toBe(expected); // 预热
    const small = Math.max(timeOf(make(10_000)), 0.5);
    const big = timeOf(make(40_000));
    expect(big / small).toBeLessThan(8);
    expect(big).toBeLessThan(2_000);
  };

  test('长输入是线性的：大量 $1 参数（每个 $ 都不能复制一遍后缀）', () => {
    expectLinear((n) => `SELECT ${Array.from({ length: n }, () => '$1').join(', ')}; VACUUM t`, true);
  });

  test('长输入是线性的：开头一个没有闭合的 $a$，后面是不含 $a$ 的大量内容（indexOf 找不到闭合，直接跳到结尾）', () => {
    // 没闭合的美元引号一直吃到末尾：后面的 VACUUM 也在“字符串”里，不算
    expectLinear((n) => `SELECT $a$ ${'x $b$ '.repeat(n / 6)}; VACUUM t`, false);
  });

  test.each([
    ['CREATE INDEX CONCURRENTLY i ON public.t (a)', 'CREATE INDEX CONCURRENTLY'],
    ['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS i ON public.t (a)', 'CREATE UNIQUE INDEX CONCURRENTLY'],
    ['DROP INDEX CONCURRENTLY public.i', 'DROP INDEX CONCURRENTLY'],
    ['REINDEX INDEX CONCURRENTLY public.i', 'REINDEX … CONCURRENTLY'],
    ['REINDEX (VERBOSE) TABLE CONCURRENTLY public.t', 'REINDEX (选项) … CONCURRENTLY'],
    ['ALTER TABLE public.t DETACH PARTITION public.t_2026 CONCURRENTLY', 'DETACH PARTITION … CONCURRENTLY'],
    ['VACUUM public.t', 'VACUUM'],
    ['  vacuum (analyze) public.t', 'VACUUM（小写、前导空白、带选项）'],
    ['ALTER SYSTEM SET work_mem = 65536', 'ALTER SYSTEM'],
    ['CREATE DATABASE shop', 'CREATE DATABASE'],
    ['DROP DATABASE IF EXISTS shop', 'DROP DATABASE'],
    ["CREATE TABLESPACE fast LOCATION '/ssd'", 'CREATE TABLESPACE'],
    ['DROP TABLESPACE IF EXISTS fast', 'DROP TABLESPACE'],
    ["ALTER TYPE public.status ADD VALUE 'archived'", 'ALTER TYPE … ADD VALUE'],
    [
      "ALTER TYPE public.status ADD VALUE IF NOT EXISTS 'archived' BEFORE 'done'",
      'ADD VALUE IF NOT EXISTS … BEFORE',
    ],
    ['DISCARD ALL', 'DISCARD ALL'],
    // 一步里有多条语句：任何一条命中就算
    ['UPDATE public.t SET x = 1; VACUUM public.t', '多语句：后面是 VACUUM'],
    ["SELECT 1; ALTER TYPE mood ADD VALUE 'x'", '多语句：后面是 ALTER TYPE … ADD VALUE'],
    [
      'CREATE TABLE a (i int);\nCREATE INDEX CONCURRENTLY a_i ON a (i);',
      '多语句：换行分隔，后面是 CONCURRENTLY',
    ],
    ['VACUUM public.t; SELECT 1', '多语句：前面是 VACUUM'],
    // 字符串 / 标识符里的 -- 和 /* 不是注释：不能把后面的语句一起吃掉
    [
      "COMMENT ON TABLE t IS 'a -- b'; CREATE INDEX CONCURRENTLY i ON t (x)",
      '字符串里有 --，后面还有 CONCURRENTLY',
    ],
    ["SELECT '/*'; VACUUM t", '字符串里有 /*，后面是 VACUUM'],
    ['SELECT "a--b"; VACUUM t', '带引号标识符里有 --'],
    ["SELECT '$$'; VACUUM t", '字符串里有 $$，后面是 VACUUM'],
    ["SELECT E'\\\\'; VACUUM t", "E'' 字符串里的反斜杠转义了反斜杠本身，字符串到这里就结束"],
    ["SELECT 'it''s'; VACUUM t", "'' 转义的引号"],
    ['/* a /* b */ c */ VACUUM t', '嵌套块注释之后是 VACUUM'],
    ['SELECT 1 /* ; */; VACUUM t', '块注释里的分号'],
    ['SELECT 1; -- 注释\nVACUUM t', '行注释之后换行是 VACUUM'],
    ['REINDEX DATABASE shop', 'REINDEX DATABASE'],
    ['REINDEX SYSTEM shop', 'REINDEX SYSTEM'],
    ['REINDEX (VERBOSE) DATABASE shop', 'REINDEX (选项) DATABASE'],
    ['CLUSTER', '不带表名的 CLUSTER'],
    ['cluster verbose', '老写法 CLUSTER VERBOSE'],
    ['CLUSTER (VERBOSE)', 'CLUSTER (选项)，不带表名'],
    ['UPDATE t SET x = 1; CLUSTER', '多语句：后面是不带表名的 CLUSTER'],
    [
      "COMMENT ON TABLE t IS 'a;b'; DROP TABLESPACE fast",
      '多语句：前面字符串里有分号，后面是 DROP TABLESPACE',
    ],
  ])('%s → 非事务（%s）', (sql) => {
    expect(isNontransactionalSql(sql)).toBe(true);
  });

  test.each([
    'CREATE TABLE public.t (id int)',
    'CREATE INDEX i ON public.t (a)',
    'ALTER TABLE public.t ADD COLUMN c text',
    'REINDEX TABLE public.t',
    'REINDEX INDEX public.i',
    'REINDEX SCHEMA public',
    'CLUSTER public.t USING t_pkey',
    'CLUSTER (VERBOSE) public.t',
    "COMMENT ON TABLE t IS 'reindex database x; cluster'",
    'ALTER TYPE public.status RENAME TO state',
    "ALTER TYPE public.status RENAME VALUE 'a' TO 'b'",
    'DROP TYPE public.status',
    'CREATE SCHEMA app',
    // 关键字出现在字符串、注释、标识符、函数体里不算
    "COMMENT ON TABLE public.t IS 'create index concurrently; vacuum; alter type x add value'",
    'CREATE TABLE "concurrently" (a int)',
    'CREATE TABLE public.t (a int) -- concurrently',
    '/* VACUUM */ CREATE TABLE public.t (a int)',
    'CREATE FUNCTION f() RETURNS void AS $$ VACUUM t $$ LANGUAGE sql',
    "CREATE FUNCTION f() RETURNS void AS $f$ ALTER TYPE x ADD VALUE 'y' $f$ LANGUAGE sql",
    // 多语句但都能进事务；分号在字符串 / 函数体 / 标识符 / 注释里不会把语句切开
    'UPDATE public.t SET x = 1; UPDATE public.t SET y = 2;',
    'SELECT 1; SELECT 2;',
    "SELECT 'a; VACUUM t'",
    "COMMENT ON TABLE t IS 'x; ALTER SYSTEM SET a = 1; CREATE DATABASE d'",
    'CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; VACUUM t; END $$ LANGUAGE plpgsql; SELECT 1',
    'CREATE TABLE "a;vacuum" (i int); CREATE TABLE b (i int)',
    '-- ; VACUUM t\nSELECT 1',
    // 注释 / 字符串互相包含：注释里的引号不会让字符串配对错位，字符串里的注释符号也不会吞掉后面
    "SELECT 1 -- it's\n; SELECT 2",
    "SELECT 'a -- b'; SELECT 2",
    "SELECT E'it\\'s; VACUUM t'",
    '/* a /* VACUUM t */ ; ALTER SYSTEM SET a = 1 */ SELECT 1',
    "SELECT 'a $$ b'; SELECT 1",
    'SELECT $1; SELECT a$b$c',
  ])('%s → 事务内可以执行', (sql) => {
    expect(isNontransactionalSql(sql)).toBe(false);
  });
});

describe('isInstanceLevelSql', () => {
  test.each([
    'CREATE DATABASE shop',
    'DROP DATABASE IF EXISTS shop',
    "ALTER DATABASE shop SET timezone = 'UTC'",
    "CREATE TABLESPACE fast LOCATION '/ssd'",
    'DROP TABLESPACE fast',
    'ALTER TABLESPACE fast RENAME TO slow',
    'ALTER SYSTEM SET work_mem = 65536',
    'CREATE ROLE app LOGIN',
    'DROP ROLE app',
    'ALTER ROLE app SET search_path = x',
    'CREATE USER app',
    'DROP USER IF EXISTS app',
    "ALTER USER app PASSWORD 'x'",
    'CREATE GROUP g',
    'ALTER GROUP g ADD USER app',
    '  create   database shop',
    // 一个叫 mapping 的角色不是 USER MAPPING：只有 USER 后面跟 MAPPING [IF [NOT] EXISTS] FOR 才排除
    'CREATE USER mapping SUPERUSER',
    'ALTER USER mapping SET search_path = x',
    'DROP USER mapping',
    'CREATE USER mapping_user',
    'CREATE USER MAPPING SUPERUSER',
    "ALTER USER mapping PASSWORD 'x'",
    // 多条语句里任何一条
    'UPDATE t SET a = 1; CREATE DATABASE x',
    "COMMENT ON TABLE t IS 'a; b'; ALTER SYSTEM SET a = 1",
    "SELECT '--'; DROP ROLE app",
  ])('%s → 实例级语句', (sql) => {
    expect(isInstanceLevelSql(sql)).toBe(true);
  });

  test.each([
    'CREATE TABLE public.t (id int)',
    'CREATE USER MAPPING FOR current_user SERVER s',
    'CREATE USER MAPPING IF NOT EXISTS FOR current_user SERVER s',
    'DROP USER MAPPING IF EXISTS FOR current_user SERVER s',
    'DROP USER MAPPING FOR current_user SERVER s',
    "ALTER USER MAPPING FOR current_user SERVER s OPTIONS (SET user 'x')",
    '  create   user   mapping   for   public server s',
    'ALTER TABLE public.t OWNER TO app',
    'GRANT SELECT ON t TO app',
    'CREATE SCHEMA app AUTHORIZATION app',
    "COMMENT ON TABLE t IS 'CREATE DATABASE x'",
    'CREATE FUNCTION f() RETURNS void AS $$ BEGIN ALTER SYSTEM SET a = 1; END $$ LANGUAGE plpgsql',
    'CREATE TABLE "create database" (a int)',
    '-- CREATE DATABASE x\nSELECT 1',
    '/* DROP ROLE app */ SELECT 1',
    'VACUUM public.t',
    'CREATE INDEX CONCURRENTLY i ON t (a)',
  ])('%s → 不是实例级语句', (sql) => {
    expect(isInstanceLevelSql(sql)).toBe(false);
  });
});

test('findInstanceLevelStatement 返回第一条实例级语句（压成一行），说明文字只有一份', () => {
  expect(findInstanceLevelStatement('UPDATE t SET a = 1;\n  CREATE   DATABASE\n evil -- x')).toBe(
    'CREATE DATABASE evil',
  );
  expect(findInstanceLevelStatement('SELECT 1')).toBeNull();
  expect(findInstanceLevelStatement(`ALTER SYSTEM SET a = '${'x'.repeat(200)}'`)).toBe(
    "ALTER SYSTEM SET a = ''",
  );
  expect(INSTANCE_LEVEL_DESCRIPTION).toContain('实例级语句不能放进迁移');
});

// 执行器据此不给 CONCURRENTLY 类的索引操作设 lock_timeout（它们不阻塞读写，等的是旧事务结束）；
// DETACH PARTITION … CONCURRENTLY 不豁免（第二阶段要对分区拿 ACCESS EXCLUSIVE）
describe('isConcurrentDdlSql', () => {
  test.each([
    'CREATE UNIQUE INDEX CONCURRENTLY "ix" ON "public"."t" ("x")',
    '  create index concurrently if not exists ix on t (x)',
    'DROP INDEX CONCURRENTLY IF EXISTS "public"."ix"',
    'REINDEX INDEX CONCURRENTLY "public"."ix"',
    'REINDEX (VERBOSE) TABLE CONCURRENTLY public.t',
    // PG 14 起的括号选项写法
    'REINDEX (CONCURRENTLY) TABLE t',
    'reindex (concurrently, verbose) index public.ix',
    'REINDEX (VERBOSE, CONCURRENTLY true) TABLE t',
    'REINDEX (CONCURRENTLY ON) SCHEMA app',
    'REINDEX (TABLESPACE fast, CONCURRENTLY 1) INDEX ix',
    // 前导注释、末尾分号不影响识别
    '-- 建索引，不锁表\nCREATE INDEX CONCURRENTLY ix ON t (x);',
    '/* 说明 */ DROP INDEX CONCURRENTLY ix',
  ])('是：%s', (sql) => expect(isConcurrentDdlSql(sql)).toBe(true));

  test.each([
    'CREATE INDEX "ix" ON "public"."t" ("x")',
    // 注释、字符串、带引号的标识符里提到 concurrently 的普通语句不算
    'CREATE INDEX ix ON t (x) -- 以后改成 concurrently',
    '/* concurrently */ CREATE INDEX ix ON t (x)',
    'CREATE INDEX "concurrently" ON t (x)',
    "COMMENT ON TABLE t IS 'create index concurrently'",
    'ALTER TABLE p DETACH PARTITION p1',
    'ALTER TABLE p DETACH PARTITION p1 FINALIZE',
    // DETACH PARTITION … CONCURRENTLY 的第二个事务要对分区拿 ACCESS EXCLUSIVE：照常受锁等待超时约束
    'ALTER TABLE public.p DETACH PARTITION public.p1 CONCURRENTLY',
    'alter table only "p" detach partition "p 2" concurrently;',
    // 括号选项里明确关掉的不算；只有别的选项的也不算
    'REINDEX (CONCURRENTLY false) TABLE t',
    'REINDEX (VERBOSE, CONCURRENTLY off) INDEX ix',
    'REINDEX (CONCURRENTLY 0) SCHEMA app',
    'REINDEX (VERBOSE) TABLE t',
    'REINDEX TABLE t',
    'REFRESH MATERIALIZED VIEW CONCURRENTLY v',
    // 和别的语句在同一步里：别的语句仍然要受锁等待超时约束
    'CREATE INDEX CONCURRENTLY ix ON t (x); ALTER TABLE t ADD COLUMN y int',
    '',
  ])('不是：%s', (sql) => expect(isConcurrentDdlSql(sql)).toBe(false));

  test('CONCURRENTLY 类（含 DETACH PARTITION … CONCURRENTLY）都被判成非事务步骤（执行器在事务外执行）', () => {
    expect(isNontransactionalSql('ALTER TABLE public.p DETACH PARTITION public.p1 CONCURRENTLY')).toBe(true);
    expect(isNontransactionalSql('REINDEX TABLE CONCURRENTLY public.t')).toBe(true);
    expect(isNontransactionalSql('REINDEX (CONCURRENTLY) TABLE t')).toBe(true);
  });
});
