// 风险分析：每一步的全表扫描只算这一步自己的（PG 15+ 的 pg_stat_xact_* 会残留前面步骤的计数）。
import { emptyModel, type Model, plan, runMutator } from '@dowel/core';
import { expect, test } from 'vitest';

import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { analyze } from '../src/index.ts';

const conn = useTestDb('analyze');

/** 用真实的编辑操作构造模型：orders(id, total)，可选改名、加 CHECK */
const m = (withCheck: boolean, colName: string): Model => {
  const x = emptyModel();
  runMutator(x, 'createSchema', { id: 's', name: 'public' });
  runMutator(x, 'createTable', { id: 't', schema: 's', name: 'orders' });
  runMutator(x, 'addColumn', {
    table: 't',
    column: { id: 'c1', name: 'id', type: 'integer', notNull: true },
  });
  runMutator(x, 'addColumn', { table: 't', column: { id: 'c2', name: 'total', type: 'integer' } });
  if (colName !== 'total') runMutator(x, 'renameColumn', { id: 'c2', name: colName });
  if (withCheck) runMutator(x, 'addCheck', { id: 'k', table: 't', expr: '(id > 0)' });
  return x;
};

test.skipIf(!PG_URL)('加 CHECK 全表扫描；之后的改名不算扫描、也不是高风险', async () => {
  const from = m(false, 'total');
  const to = m(true, 'amount');
  const steps = plan(from, to);
  const risks = await analyze(conn(), from, steps);
  const check = steps.findIndex((s) => s.sql.includes('ADD CONSTRAINT'));
  const rename = steps.findIndex((s) => s.sql.includes('RENAME COLUMN'));
  expect(check).toBeGreaterThanOrEqual(0);
  expect(rename).toBeGreaterThanOrEqual(0);
  expect(risks[check]!.scans).toEqual(['public.orders']);
  expect(risks[rename]!.scans).toEqual([]);
  expect(risks[rename]!.level).toBe('low');
  // CHECK 在后面执行时也只有自己的扫描
  const both = [...steps.filter((_, i) => i !== check), steps[check]!];
  const r2 = await analyze(conn(), from, both);
  expect(r2.slice(0, -1).every((r) => r.scans.length === 0)).toBe(true);
});
