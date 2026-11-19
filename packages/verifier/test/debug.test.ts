// 调试：CASE='<fast-check 反例 JSON>' 时，打印两个版本和迁移语句，并执行验证

import { createAll, plan } from '@dowel/core';
import { test } from 'vitest';
import { createTestDb, PG_URL } from '../../../test/pg.ts';
import { verify } from '../src/index.ts';
import { makeVersions } from './gen.ts';

test.runIf(process.env.CASE && PG_URL)('调试反例', async () => {
  const [vs] = JSON.parse(process.env.CASE!);
  const { v1, v2 } = makeVersions(vs);
  const show = (m: typeof v1) =>
    createAll(m)
      .map((s) => `  ${s.sql.replaceAll('\n', ' ')}`)
      .join('\n');
  console.log(`版本 1：\n${show(v1)}\n版本 2：\n${show(v2)}`);
  console.log(
    `up：\n${plan(v1, v2)
      .map((s) => `  ${s.sql}`)
      .join('\n')}`,
  );
  console.log(
    `down：\n${plan(v2, v1)
      .map((s) => `  ${s.sql}`)
      .join('\n')}`,
  );
  const t = await createTestDb('debug');
  try {
    const r = await verify(t.db, v1, v2);
    console.log('upDiff', r.upDiff, 'downDiff', r.downDiff);
  } catch (e) {
    console.log(String(e));
  }
  await t.close();
});
