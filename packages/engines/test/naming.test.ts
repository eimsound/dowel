// 自动命名规则的复现必须与 PG 实际结果一致（包括超长名字的截断、多字节字符）。

import { chooseName, ident, joinNames } from '@dowel/core';
import fc from 'fast-check';
import { expect, test } from 'vitest';

import {
  parseExplicitSeed,
  parsePositiveMs,
  resolveHeavyWorkers,
  runShardedProperty,
} from '../../../test/fc-shard.ts';
import { createTestDb, PG_URL, useTestDb } from '../../../test/pg.ts';
import { resetShadow } from '../../verifier/src/index.ts';
import { readSnapshot } from '../src/index.ts';

const conn = useTestDb('naming');

const part = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/),
  fc.constantFrom('名字', 'größe', 'x'.repeat(40), 'y'.repeat(62), 'Mixed Case', 'ab字cd'),
);
/** 名字最长 63 字节：截断时不能切开多字节字符 */
const fit = (s: string) => {
  let out = '';
  for (const ch of s) {
    if (new TextEncoder().encode(out + ch).length > 63) break;
    out += ch;
  }
  return out;
};
const nameArb = fc.tuple(part, part).map(([a, b]) => fit(a + b));

/** 本地默认少量用例；CI 的 heavy 任务用 RUNS=5000 */
const RUNS = Number(process.env.RUNS ?? 150);
const EXPLICIT_SEED = parseExplicitSeed(process.env.SEED);
const WORKERS = resolveHeavyWorkers(RUNS, process.env.HEAVY_WORKERS, EXPLICIT_SEED);
const TIME_LIMIT = parsePositiveMs(process.env.TIME_LIMIT, 180_000);
const SHRINK_TIME_LIMIT = parsePositiveMs(process.env.SHRINK_TIME_LIMIT, 60_000);

test.skipIf(!PG_URL)(
  '推导名与 PG 实际起的名字一致',
  async () => {
    const db = conn();
    await runShardedProperty({
      prefix: 'naming',
      defaultDb: db,
      createDb: createTestDb,
      runs: RUNS,
      workers: WORKERS,
      seed: EXPLICIT_SEED,
      timeLimitMs: TIME_LIMIT,
      shrinkTimeLimitMs: SHRINK_TIME_LIMIT,
      makeProperty: (shardDb, checkAbort) =>
        fc.asyncProperty(
          nameArb,
          fc.uniqueArray(nameArb, { minLength: 2, maxLength: 3 }),
          async (table, cols) => {
            checkAbort();
            fc.pre(!cols.includes(table));
            checkAbort();
            await resetShadow(shardDb);
            await shardDb.exec('CREATE SCHEMA s');
            const [a, b] = [cols[0]!, cols[1]!];
            const t = `s.${ident(table)}`;
            await shardDb.exec(
              `CREATE TABLE ${t} (${cols.map((c) => `${ident(c)} text NOT NULL`).join(', ')})`,
            );
            await shardDb.exec(`ALTER TABLE ${t} ADD PRIMARY KEY (${ident(a)})`);
            await shardDb.exec(`ALTER TABLE ${t} ADD UNIQUE (${ident(a)}, ${ident(b)})`);
            await shardDb.exec(`ALTER TABLE ${t} ADD CHECK (${ident(b)} <> '')`);
            await shardDb.exec(`ALTER TABLE ${t} ADD CHECK (${ident(a)} <> ${ident(b)})`);
            await shardDb.exec(
              `ALTER TABLE ${t} ADD FOREIGN KEY (${ident(b)}) REFERENCES ${t} (${ident(a)})`,
            );
            await shardDb.exec(`CREATE INDEX ON ${t} (${ident(b)}, lower(${ident(a)}))`);
            // 按 PG 的创建顺序模拟起名：约束名在整个 schema 内避免重名，索引名在关系命名空间内避免重名
            const con = new Set<string>();
            const rel = new Set<string>([table]);
            const take = (set: Set<string>[], n1: string, n2: string | null, label: string) => {
              const n = chooseName(n1, n2, label, (x) => set.some((s) => s.has(x)));
              for (const s of set) s.add(n);
              return n;
            };
            const notNull = cols.map((c) => take([con], table, c, 'not_null'));
            const expected = [
              take([rel, con], table, null, 'pkey'),
              take([rel, con], table, joinNames([a, b]), 'key'),
              take([con], table, b, 'check'),
              take([con], table, null, 'check'),
              take([con], table, joinNames([b]), 'fkey'),
            ];
            const idx = take([rel], table, joinNames([b, 'lower']), 'idx');
            const s = (await readSnapshot(shardDb)).tables[`s.${table}`]!;
            expect(Object.keys(s.constraints).sort()).toEqual(expected.sort());
            expect(Object.keys(s.indexes)).toEqual([idx]);
            for (const [i, c] of cols.entries()) expect(s.columns[c]!.notNullName).toBe(notNull[i]);
          },
        ),
    });
  },
  Math.max(60_000 + RUNS * 200, TIME_LIMIT + SHRINK_TIME_LIMIT + 60_000),
);
