// 闭环验证的读回核对（ADR 0017 决定 2，路径 C 的非 SQLite 部分）：真实 PG / MySQL / SQL Server。
// 模型里写的是没规范化的原文（模拟写入入口漏了规范化），影子库读回的是数据库自己的写法：
// 升级后的读回按执行读回校验的同一个比较（diffAgainst）对 to，不一致即验证失败，并给出对象 / 属性级明细；
// 模型换成数据库的写法（规范形式）后验证通过。没有对应数据库时跳过（本地 DOWEL_TEST_PG/MYSQL/MSSQL=skip）。
import {
  addCheck,
  addColumn,
  createSchema,
  createTable,
  emptyModel,
  type Dialect,
  type Model,
} from '@dowel/core';
import { type Db, getEngine } from '@dowel/engines';
import { importLive } from '@dowel/executor';
import { describe, expect, test } from 'vitest';

import { createTestMssqlDb, getMssqlAdminUrl } from '../../../test/mssql.ts';
import { useMysqlTestDb } from '../../../test/mysql.ts';
import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, verify, verifyPassed } from '../src/index.ts';

const SCHEMA: Record<Exclude<Dialect, 'sqlite'>, string> = { pg: 'public', mysql: 'default', mssql: 'dbo' };

/** from：只有 schema；to：一张带 CHECK 的表，CHECK 写的是原文 */
const pair = (dialect: Exclude<Dialect, 'sqlite'>, rawCheck: string): { from: Model; to: Model } => {
  const from = emptyModel(dialect);
  createSchema(from, SCHEMA[dialect], 's');
  const to = structuredClone(from);
  const t = createTable(to, 's', 'items', 't-items');
  addColumn(to, t, { name: 'id', type: dialect === 'mssql' ? 'int' : 'integer', notNull: true, id: 'c-id' });
  addColumn(to, t, { name: 'qty', type: dialect === 'mssql' ? 'int' : 'integer', id: 'c-qty' });
  addCheck(to, t, rawCheck, 'k-qty');
  return { from, to };
};

/** 在影子库里建一遍再读回：数据库的写法，沿用原来的 ID（发布时 flush 写回的就是这个） */
const canonical = async (db: Db, m: Model): Promise<Model> => {
  await build(db, m);
  return importLive(await getEngine(m.dialect).readSnapshot(db), m);
};

const expectRawRejectedThenCanonicalPasses = async (db: Db, dialect: Exclude<Dialect, 'sqlite'>) => {
  const raw = 'qty>0';
  const { from, to } = pair(dialect, raw);
  const r = await verify(db, from, to);
  expect(verifyPassed(r)).toBe(false);
  expect(r.readback?.up.total).toBeGreaterThan(0);
  const check = r.readback?.up.details.find((d) => d.property === 'expr');
  expect(check, JSON.stringify(r.readback?.up.details)).toBeDefined();
  expect(check!.modelValue).toBe(raw);
  expect(check!.liveValue).not.toBe(raw);
  // 回滚后回到 from（只有 schema），与原文无关：down 方向的读回没有差异
  expect(r.readback?.down.total).toBe(0);

  const fixed = await canonical(db, to);
  expect((Object.values(fixed.objects).find((o) => o.kind === 'check') as { expr: string }).expr).toBe(
    check!.liveValue,
  );
  const ok = await verify(db, from, fixed);
  expect(ok.readback?.up.details).toEqual([]);
  expect(verifyPassed(ok)).toBe(true);
  expect(ok.engineVersion).toMatch(/^\d+\.\d+/);
};

describe.skipIf(!PG_URL)('PG：读回核对', () => {
  const conn = useTestDb('ver_readback');
  test('原文 CHECK 验证不通过并给出明细，规范形式通过', async () => {
    await expectRawRejectedThenCanonicalPasses(conn(), 'pg');
  });
});

describe('MySQL：读回核对', () => {
  const getDb = useMysqlTestDb('ver_readback');
  test('原文 CHECK 验证不通过并给出明细，规范形式通过', async () => {
    const handle = getDb();
    if (!handle) return;
    await expectRawRejectedThenCanonicalPasses(handle.db, 'mysql');
  });
});

describe('SQL Server：读回核对', () => {
  test('原文 CHECK 验证不通过并给出明细，规范形式通过', { timeout: 120_000 }, async () => {
    if (!(await getMssqlAdminUrl())) return;
    const shadow = await createTestMssqlDb('ver_readback');
    try {
      await expectRawRejectedThenCanonicalPasses(shadow.db, 'mssql');
    } finally {
      await shadow.close();
    }
  });
});
