// 平台库 COLUMN_KINDS 覆盖守门：SQLite 模式靠手工登记的“表.列”还原 JSON / 布尔列，
// 新迁移加了 jsonb / boolean 列却忘了登记，SQLite 与 PG 的读出结果就会悄悄分叉。
// 这里跑完全部平台迁移，扫描 PG 真实表结构，要求：
// 1. 每个 jsonb / boolean 列都已登记且种类正确；
// 2. 登记表里没有指向已删除表 / 列（或类型已不是 jsonb / boolean）的过期条目。
// 不依赖 Docker 的部分：在 SQLite 上校验登记条目都存在、声明类型与种类相符。
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { BUILTIN_COLUMN_KINDS, type ColumnKind, openPlatformDb, type PlatformDb } from '../src/db.ts';

/** PG 列类型 → 应登记的种类；其他类型不需要登记 */
const pgKindOf = (type: string): ColumnKind | undefined =>
  type === 'jsonb' || type === 'json' ? 'json' : type === 'boolean' ? 'bool' : undefined;

/** SQLite 里 JSON 列声明为 text、布尔列声明为 integer（见 db.ts 的 types()） */
const SQLITE_DECLARED: Record<ColumnKind, string> = { json: 'text', bool: 'integer' };

interface CoverageReport {
  /** 是 jsonb / boolean 列但没登记 */
  missing: string[];
  /** 登记了但种类与实际列类型不符 */
  mismatched: string[];
  /** 登记了但表 / 列已不存在 */
  stale: string[];
}

/**
 * 对照实际列（`表.列` → 列类型）与登记表。
 * 不是 jsonb / boolean 的列不要求登记；登记了这种列算 mismatched。
 */
const checkColumnKinds = (
  columns: ReadonlyMap<string, string>,
  registered: ReadonlyMap<string, ColumnKind>,
): CoverageReport => {
  const report: CoverageReport = { missing: [], mismatched: [], stale: [] };
  for (const [key, type] of columns) {
    const want = pgKindOf(type);
    if (want && !registered.has(key)) report.missing.push(`${key}（${type} → 应登记为 '${want}'）`);
  }
  for (const [key, kind] of registered) {
    const type = columns.get(key);
    if (type === undefined) report.stale.push(key);
    else if (pgKindOf(type) !== kind) report.mismatched.push(`${key}（列类型 ${type}，登记为 '${kind}'）`);
  }
  for (const list of Object.values(report)) list.sort();
  return report;
};

const EMPTY: CoverageReport = { missing: [], mismatched: [], stale: [] };
const HINT =
  '平台库新增 / 修改 / 删除 jsonb 或 boolean 列时，须同步更新 apps/server/src/db.ts 的 BUILTIN_COLUMN_KINDS';

/** PG 当前 schema 下所有普通表的列：`表.列` → data_type */
const scanPg = async (db: PlatformDb): Promise<Map<string, string>> => {
  const rows = await db.query<{ t: string; c: string; type: string }>(
    `select c.table_name as t, c.column_name as c, c.data_type as type
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'`,
  );
  return new Map(rows.map((r) => [`${r.t}.${r.c}`, r.type]));
};

/** SQLite 所有表的列：`表.列` → 声明类型（小写） */
const scanSqlite = async (db: PlatformDb): Promise<Map<string, string>> => {
  const rows = await db.query<{ t: string; c: string; type: string }>(
    `select m.name as t, p.name as c, p.type as type
       from sqlite_master m join pragma_table_info(m.name) p
      where m.type = 'table'`,
  );
  return new Map(rows.map((r) => [`${r.t}.${r.c}`, r.type.toLowerCase()]));
};

/**
 * SQLite 侧：JSON 列和普通 text 列声明类型相同，无法判断 missing，
 * 只校验登记过的列存在（stale）且声明类型对得上（mismatched）。
 */
const checkSqlite = (
  columns: ReadonlyMap<string, string>,
  registered: ReadonlyMap<string, ColumnKind>,
): CoverageReport => {
  const report: CoverageReport = { missing: [], mismatched: [], stale: [] };
  for (const [key, kind] of registered) {
    const type = columns.get(key);
    if (type === undefined) report.stale.push(key);
    else if (type !== SQLITE_DECLARED[kind])
      report.mismatched.push(`${key}（列类型 ${type}，登记为 '${kind}'）`);
  }
  report.mismatched.sort();
  report.stale.sort();
  return report;
};

describe('checkColumnKinds：用合成表结构验证报错能指出具体的 表.列', () => {
  const registered = new Map<string, ColumnKind>([
    ['users.flag', 'bool'],
    ['users.meta', 'json'],
  ]);

  test('全部登记、无过期条目时报告为空', () => {
    const columns = new Map([
      ['users.id', 'text'],
      ['users.flag', 'boolean'],
      ['users.meta', 'jsonb'],
    ]);
    expect(checkColumnKinds(columns, registered)).toEqual(EMPTY);
  });

  test('新增未登记的 jsonb / boolean 列会被点名', () => {
    const columns = new Map([
      ['users.flag', 'boolean'],
      ['users.meta', 'jsonb'],
      ['orders.payload', 'jsonb'],
      ['orders.paid', 'boolean'],
      ['orders.note', 'text'],
    ]);
    expect(checkColumnKinds(columns, registered)).toEqual({
      missing: ["orders.paid（boolean → 应登记为 'bool'）", "orders.payload（jsonb → 应登记为 'json'）"],
      mismatched: [],
      stale: [],
    });
  });

  test('删掉的表 / 列与种类登记错误都会被点名', () => {
    const columns = new Map([
      ['users.flag', 'jsonb'],
      ['projects.meta', 'jsonb'],
    ]);
    expect(checkColumnKinds(columns, new Map([...registered, ['projects.meta', 'json']]))).toEqual({
      missing: [],
      mismatched: ["users.flag（列类型 jsonb，登记为 'bool'）"],
      stale: ['users.meta'],
    });
    // 列还在但类型改成了普通类型：登记已过时
    expect(checkColumnKinds(new Map([['users.flag', 'text']]), new Map([['users.flag', 'bool']]))).toEqual({
      missing: [],
      mismatched: ["users.flag（列类型 text，登记为 'bool'）"],
      stale: [],
    });
  });
});

describe('SQLite 平台库：登记条目都对应真实列且声明类型相符', () => {
  test('内置登记表与迁移后的 SQLite 表结构一致', async () => {
    const db = await openPlatformDb(':memory:');
    try {
      const columns = await scanSqlite(db);
      expect(checkSqlite(columns, BUILTIN_COLUMN_KINDS), HINT).toEqual(EMPTY);
    } finally {
      await db.close();
    }
  });

  test('删掉一个已登记的列、或把它改成别的类型时会被点名', async () => {
    const db = await openPlatformDb(':memory:');
    try {
      await db.exec('alter table webhooks drop column enabled');
      const columns = await scanSqlite(db);
      columns.set('inbox_items.data', 'integer');
      expect(checkSqlite(columns, BUILTIN_COLUMN_KINDS)).toEqual({
        missing: [],
        mismatched: ["inbox_items.data（列类型 integer，登记为 'json'）"],
        stale: ['webhooks.enabled'],
      });
    } finally {
      await db.close();
    }
  });
});

describe.skipIf(!PG_URL)('PG 平台库：jsonb / boolean 列 100% 登记且无过期条目', () => {
  let pg: Awaited<ReturnType<typeof createTestDb>>;
  let db: PlatformDb;

  beforeAll(async () => {
    pg = await createTestDb('column_kinds');
    db = await openPlatformDb(pg.url);
  });

  afterAll(async () => {
    await db?.close();
    await pg?.close();
  });

  test('跑完全部迁移后的表结构与 BUILTIN_COLUMN_KINDS 完全对得上', async () => {
    const columns = await scanPg(db);
    // 防止扫描本身失效（schema 不对、查询改坏）导致守门形同虚设
    expect(columns.size).toBeGreaterThan(BUILTIN_COLUMN_KINDS.size);
    expect([...columns.values()].filter((t) => pgKindOf(t)).length).toBeGreaterThan(0);
    expect(checkColumnKinds(columns, BUILTIN_COLUMN_KINDS), HINT).toEqual(EMPTY);
  });

  test('迁移后新增未登记列 / 删除已登记的表或列时，报告点名对应的 表.列', async () => {
    await db.exec(`
      alter table users add column coverage_probe_json jsonb, add column coverage_probe_flag boolean;
      alter table webhooks drop column enabled;
      drop table token_policies cascade;
    `);
    expect(checkColumnKinds(await scanPg(db), BUILTIN_COLUMN_KINDS)).toEqual({
      missing: [
        "users.coverage_probe_flag（boolean → 应登记为 'bool'）",
        "users.coverage_probe_json（jsonb → 应登记为 'json'）",
      ],
      mismatched: [],
      stale: ['token_policies.rule', 'webhooks.enabled'],
    });
  });
});
