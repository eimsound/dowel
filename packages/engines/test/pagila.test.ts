// M1a 验收：导入一个真实的 schema（pagila，约 20 张业务表 + 55 个分区、视图、函数、触发器、域、聚合、pgvector），
// 从 IR 重建后结构必须与原库完全一致。
import { readFileSync } from 'node:fs';
import { all, plan, validate } from '@dowel/core';
import { expect, test } from 'vitest';
import { createTestDb, PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, verify } from '../../verifier/src/index.ts';
import { diffSnapshots, importSnapshot, readSnapshot } from '../src/index.ts';

const conn = useTestDb('pagila');

test.skipIf(!PG_URL)('pagila：导入 → 从 IR 重建，结构完全一致', async () => {
  const db = conn();
  await db.exec(readFileSync(new URL('./fixtures/pagila-schema.sql', import.meta.url), 'utf8'));
  const s1 = await readSnapshot(db);
  const m = importSnapshot(s1);
  expect(validate(m)).toEqual([]);
  expect(plan(m, m)).toEqual([]);

  const count = (k: Parameters<typeof all>[1]) => all(m, k).length;
  console.log(
    `表 ${count('table')}（其中分区 ${all(m, 'table').filter((t) => t.partitionOf).length}），列 ${count('column')}，` +
      `约束 ${count('primaryKey') + count('unique') + count('foreignKey') + count('check')}，索引 ${count('index')}，` +
      `序列 ${count('sequence')}，枚举 ${count('enum')}，扩展 ${count('extension')}，不透明对象 ${count('opaque')}：` +
      JSON.stringify(
        Object.groupBy(all(m, 'opaque'), (o) => o.objType),
        (k, v) =>
          k === '' ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, (b as unknown[]).length])) : v,
      ),
  );

  const s2 = await build(db, m);
  expect(diffSnapshots(s1, s2)).toEqual([]);

  // 从只有 public 的空库迁移到 pagila，再回滚：闭环验证（用全新的库，不依赖前面执行 pagila 脚本时设置的会话参数）
  const fresh = await createTestDb('pagila_fresh');
  try {
    const pub = all(m, 'schema').find((x) => x.name === 'public')!;
    const empty = { ...m, objects: { [pub.id]: { ...pub, comment: null } } };
    const r = await verify(fresh.db, empty, m);
    expect(r.upDiff).toEqual([]);
    expect(r.downDiff).toEqual([]);
  } finally {
    await fresh.close();
  }
});
