// fast-check 分片并行、兄弟中止与有界 shrink 的纯单测（不依赖 Docker）。
import fc from 'fast-check';
import { describe, expect, test, vi } from 'vitest';

import {
  deriveShardSeeds,
  parseExplicitSeed,
  parseNonNegativeMs,
  parsePositiveMs,
  partitionRuns,
  resolveHeavyWorkers,
  runShardedProperty,
} from '../../../test/fc-shard.ts';

describe('fc-shard 参数解析与分片分配', () => {
  test('parseExplicitSeed 正确解析 0、负数、空白与非法值', () => {
    expect(parseExplicitSeed(undefined)).toBeUndefined();
    expect(parseExplicitSeed('   ')).toBeUndefined();
    expect(parseExplicitSeed('not-a-number')).toBeUndefined();
    expect(parseExplicitSeed('Infinity')).toBeUndefined();
    expect(parseExplicitSeed('0')).toBe(0);
    expect(parseExplicitSeed(' 12345 ')).toBe(12345);
    expect(parseExplicitSeed('-971207813')).toBe(-971207813);
  });

  test('parsePositiveMs 拒绝非正数与非法输入', () => {
    expect(parsePositiveMs(undefined, 60_000)).toBe(60_000);
    expect(parsePositiveMs(' ', 60_000)).toBe(60_000);
    expect(parsePositiveMs('0', 60_000)).toBe(60_000);
    expect(parsePositiveMs('-100', 60_000)).toBe(60_000);
    expect(parsePositiveMs('abc', 60_000)).toBe(60_000);
    expect(parsePositiveMs(' 45000 ', 60_000)).toBe(45_000);
  });

  test('parseNonNegativeMs 允许 0 且拒绝负数与非法输入', () => {
    expect(parseNonNegativeMs(undefined, 60_000)).toBe(60_000);
    expect(parseNonNegativeMs(' ', 60_000)).toBe(60_000);
    expect(parseNonNegativeMs('0', 60_000)).toBe(0);
    expect(parseNonNegativeMs('-100', 60_000)).toBe(60_000);
    expect(parseNonNegativeMs('abc', 60_000)).toBe(60_000);
    expect(parseNonNegativeMs(' 45000 ', 60_000)).toBe(45_000);
  });

  test('resolveHeavyWorkers 支持钳制与显式 SEED 退回单 worker', () => {
    expect(resolveHeavyWorkers(5000, undefined, undefined)).toBe(1);
    expect(resolveHeavyWorkers(5000, '4', undefined)).toBe(4);
    expect(resolveHeavyWorkers(5000, '99', undefined)).toBe(8);
    expect(resolveHeavyWorkers(3, '8', undefined)).toBe(3);
    expect(resolveHeavyWorkers(5000, '0', undefined)).toBe(1);
    expect(resolveHeavyWorkers(5000, '-2', undefined)).toBe(1);
    expect(resolveHeavyWorkers(5000, 'bad', undefined)).toBe(1);
    expect(resolveHeavyWorkers(5000, '4', 0)).toBe(1);
    expect(resolveHeavyWorkers(5000, '4', 12345)).toBe(1);
  });

  test('partitionRuns 严格均分且求和等于总轮次', () => {
    expect(partitionRuns(5000, 4)).toEqual([1250, 1250, 1250, 1250]);
    expect(partitionRuns(10, 4)).toEqual([3, 3, 2, 2]);
    expect(partitionRuns(10, 1)).toEqual([10]);
  });

  test('deriveShardSeeds 为多个分片生成互异的 32 位整数种子', () => {
    const seeds = deriveShardSeeds(4, undefined);
    expect(seeds).toHaveLength(4);
    expect(new Set(seeds).size).toBe(4);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(-0x8000_0000);
      expect(s).toBeLessThanOrEqual(0x7fff_ffff);
    }
    expect(deriveShardSeeds(1, 12345)).toEqual([12345]);
  });
});

describe('runShardedProperty 执行与错误控制', () => {
  test('workers=1 时复用 defaultDb、不调用 createDb，且同种子输出完全一致', async () => {
    const createDb = vi.fn();
    const seenA: number[] = [];
    const seenB: number[] = [];

    const runOnce = async (sink: number[]) => {
      await runShardedProperty({
        prefix: 'unit',
        defaultDb: { tag: 'default', sink },
        createDb,
        runs: 12,
        workers: 1,
        seed: 424242,
        timeLimitMs: 10_000,
        shrinkTimeLimitMs: 5_000,
        makeProperty: (db) =>
          fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), async (n) => {
            db.sink.push(n);
          }),
      });
    };

    await runOnce(seenA);
    await runOnce(seenB);
    expect(createDb).not.toHaveBeenCalled();
    expect(seenA).toHaveLength(12);
    expect(seenA).toEqual(seenB);
  });

  test('workers=4 成功路径创建并清理 4 个隔离 DB，总执行次数严格等于 runs', async () => {
    const counts = new Map<string, number>();
    const closed: string[] = [];
    let seq = 0;

    await runShardedProperty({
      prefix: 'ok',
      defaultDb: { id: 'default' },
      createDb: async (prefix) => {
        const id = `${prefix}_${seq++}`;
        counts.set(id, 0);
        return {
          db: { id },
          close: async () => {
            closed.push(id);
          },
        };
      },
      runs: 25,
      workers: 4,
      timeLimitMs: 10_000,
      shrinkTimeLimitMs: 5_000,
      makeProperty: (db) =>
        fc.asyncProperty(fc.nat(100), async () => {
          counts.set(db.id, (counts.get(db.id) ?? 0) + 1);
        }),
    });

    expect(counts.size).toBe(4);
    expect(closed).toHaveLength(4);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(25);
  });

  test('任一分片失败后中止兄弟分片、有界 shrink 输出最小反例并关闭全部 DB', async () => {
    const perShardRuns = new Map<number, number>();
    const closed: number[] = [];
    let seq = 0;

    const promise = runShardedProperty({
      prefix: 'fail',
      defaultDb: { idx: -1 },
      createDb: async () => {
        const idx = seq++;
        perShardRuns.set(idx, 0);
        return {
          db: { idx },
          close: async () => {
            closed.push(idx);
          },
        };
      },
      runs: 400,
      workers: 4,
      timeLimitMs: 30_000,
      shrinkTimeLimitMs: 15_000,
      makeProperty: (db, checkAbort) =>
        fc.asyncProperty(fc.integer({ min: 0, max: 100 }), async (n) => {
          checkAbort();
          perShardRuns.set(db.idx, (perShardRuns.get(db.idx) ?? 0) + 1);
          await new Promise((r) => setTimeout(r, 2));
          // 仅 shard 0 在 >= 50 时失败，便于 shrink 收缩到 50 且校验兄弟分片被提前中止
          if (db.idx === 0 && n >= 50) {
            throw new Error(`boom:${n}`);
          }
        }),
    });

    let err: unknown;
    try {
      await promise;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/\[shard 1\/4, SEED=-?\d+, shardRuns=100\]/);
    expect(msg).toContain('seed:');
    expect(msg).toContain('Counterexample: [50]');
    expect(msg).toContain('path: "');
    expect(msg).not.toContain('shrink interrupted');
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(((err as Error).cause as Error).message).toBe('boom:50');
    expect(closed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // 兄弟分片应该显著少于 100 轮就被中止
    const siblingTotal = (perShardRuns.get(1) ?? 0) + (perShardRuns.get(2) ?? 0) + (perShardRuns.get(3) ?? 0);
    expect(siblingTotal).toBeLessThan(300);
  });

  test('shrinkTimeLimitMs 到期后立即停止 shrink、保留当前最优反例且无在途任务泄漏', async () => {
    const close = vi.fn(async () => {});
    const t0 = performance.now();
    let inFlight = 0;

    let err: unknown;
    try {
      await runShardedProperty({
        prefix: 'shrink_limit',
        defaultDb: { ok: true },
        createDb: async () => ({ db: { ok: true }, close }),
        runs: 20,
        workers: 1,
        seed: 7,
        timeLimitMs: 10_000,
        shrinkTimeLimitMs: 60,
        makeProperty: () =>
          fc.asyncProperty(
            fc.array(fc.integer({ min: 10, max: 1000 }), { minLength: 10, maxLength: 20 }),
            async (xs) => {
              inFlight += 1;
              try {
                await new Promise((r) => setTimeout(r, 15));
                if (xs.length >= 1) throw new Error('slow fail');
              } finally {
                inFlight -= 1;
              }
            },
          ),
      });
    } catch (e) {
      err = e;
    }

    const elapsed = performance.now() - t0;
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toContain(
      '(shrink interrupted after 60ms (SHRINK_TIME_LIMIT); best counterexample shown)',
    );
    expect(e.message).toContain('Counterexample:');
    expect(e.cause).toBeInstanceOf(Error);
    expect((e.cause as Error).message).toBe('slow fail');
    expect(elapsed).toBeLessThan(2_000);
    expect(inFlight).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  test('shrink 回放未复现失败时回退报告原始反例并清理全部 DB', async () => {
    let calls = 0;
    const closed: string[] = [];
    let idx = 0;

    let err: unknown;
    try {
      await runShardedProperty({
        prefix: 'flaky',
        defaultDb: { idx: -1 },
        createDb: async () => {
          const name = `db_${idx++}`;
          return {
            db: { idx },
            close: async () => {
              closed.push(name);
            },
          };
        },
        runs: 20,
        workers: 2,
        timeLimitMs: 10_000,
        shrinkTimeLimitMs: 2_000,
        makeProperty: (db, checkAbort) =>
          fc.asyncProperty(fc.nat(100), async () => {
            checkAbort();
            calls += 1;
            if (db.idx === 1 && calls === 1) {
              throw new Error('transient');
            }
          }),
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toContain(
      '(shrink replay did not reproduce failure; reporting original unshrunk counterexample)',
    );
    expect(e.message).toContain('Counterexample:');
    expect(e.cause).toBeInstanceOf(Error);
    expect((e.cause as Error).message).toBe('transient');
    expect(closed).toEqual(['db_0', 'db_1']);
  });

  test('shrinkTimeLimitMs 为 0 时跳过缩小直接报告原始失败', async () => {
    let calls = 0;
    let err: unknown;
    try {
      await runShardedProperty({
        prefix: 'no_shrink',
        defaultDb: { ok: true },
        runs: 5,
        workers: 1,
        seed: 7,
        timeLimitMs: 5_000,
        shrinkTimeLimitMs: 0,
        makeProperty: () =>
          fc.asyncProperty(fc.integer({ min: 10, max: 100 }), async () => {
            calls += 1;
            throw new Error('no-shrink boom');
          }),
      });
    } catch (e) {
      err = e;
    }

    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toContain('seed: 7');
    expect(e.message).toContain('Shrunk 0 time(s)');
    expect(e.message).toContain('Counterexample:');
    expect(e.cause).toBeInstanceOf(Error);
    expect((e.cause as Error).message).toBe('no-shrink boom');
  });

  test('主阶段超时中断时直接报错且不触发缩小阶段', async () => {
    let calls = 0;
    let err: unknown;
    try {
      await runShardedProperty({
        prefix: 'primary_timeout',
        defaultDb: { ok: true },
        runs: 100,
        workers: 1,
        seed: 9,
        timeLimitMs: 60,
        shrinkTimeLimitMs: 5_000,
        makeProperty: () =>
          fc.asyncProperty(fc.integer(), async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 40));
          }),
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Property interrupted');
    expect(calls).toBeLessThan(10);

    const closed: string[] = [];
    let idx = 0;
    let multiErr: unknown;
    try {
      await runShardedProperty({
        prefix: 'primary_timeout_multi',
        defaultDb: { id: 'default' },
        createDb: async () => {
          const name = `db_${idx++}`;
          return {
            db: { id: name },
            close: async () => {
              closed.push(name);
            },
          };
        },
        runs: 100,
        workers: 2,
        timeLimitMs: 60,
        shrinkTimeLimitMs: 5_000,
        makeProperty: () =>
          fc.asyncProperty(fc.integer(), async () => {
            await new Promise((r) => setTimeout(r, 40));
          }),
      });
    } catch (e) {
      multiErr = e;
    }

    expect(multiErr).toBeInstanceOf(Error);
    expect((multiErr as Error).message).toContain('Property interrupted');
    expect(closed).toEqual(['db_0', 'db_1']);
  });

  test('workers > 1 且未提供 createDb 时立即报错', async () => {
    await expect(
      runShardedProperty({
        prefix: 'missing_create_db',
        defaultDb: { id: 'default' },
        runs: 10,
        workers: 2,
        timeLimitMs: 5_000,
        shrinkTimeLimitMs: 1_000,
        makeProperty: () => fc.asyncProperty(fc.boolean(), async () => {}),
      }),
    ).rejects.toThrow('createDb');
  });

  test('createDb 中途失败时仍会关闭此前已创建的 DB', async () => {
    const closed: string[] = [];
    let count = 0;

    await expect(
      runShardedProperty({
        prefix: 'create_fail',
        defaultDb: { id: 'default' },
        createDb: async () => {
          const i = count++;
          if (i === 2) throw new Error('create failed');
          return {
            db: { id: `db_${i}` },
            close: async () => {
              closed.push(`db_${i}`);
            },
          };
        },
        runs: 10,
        workers: 4,
        timeLimitMs: 10_000,
        shrinkTimeLimitMs: 1_000,
        makeProperty: () => fc.asyncProperty(fc.boolean(), async () => {}),
      }),
    ).rejects.toThrow('create failed');

    expect(closed).toEqual(['db_0', 'db_1']);
  });
});
