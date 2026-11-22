import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { assertWithBoundedShrink } from './fc-helpers.ts';

describe('assertWithBoundedShrink', () => {
  test('通过的属性直接返回', async () => {
    await expect(
      assertWithBoundedShrink(
        fc.asyncProperty(fc.integer(), async (n) => {
          expect(Number.isInteger(n)).toBe(true);
        }),
        { numRuns: 20, seed: 1, timeLimitMs: 5_000, shrinkTimeLimitMs: 1_000 },
      ),
    ).resolves.toBeUndefined();
  });

  test('失败属性在预算内缩小并附带 seed、path 与 cause', async () => {
    let caught: unknown;
    try {
      await assertWithBoundedShrink(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 50 }),
          async (arr) => {
            if (arr.length >= 3 && arr.reduce((a, b) => a + b, 0) >= 20) {
              throw new Error(`boom sum=${arr.reduce((a, b) => a + b, 0)}`);
            }
          },
        ),
        { numRuns: 50, seed: 42, timeLimitMs: 5_000, shrinkTimeLimitMs: 5_000 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain('seed: 42');
    expect(err.message).toContain('path:');
    expect(err.message).toContain('Counterexample:');
    expect(err.message).toContain('Primary run failed at test #');
    expect(err.message).not.toContain('Shrinking interrupted');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('boom sum=');
  });

  test('慢缩小过程在 shrinkTimeLimitMs 处及时截断并保留最佳缩小结果', async () => {
    const t0 = performance.now();
    let caught: unknown;
    try {
      await assertWithBoundedShrink(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 80 }),
          async (arr) => {
            await new Promise((r) => setTimeout(r, 25));
            if (arr.length >= 3 && arr.reduce((a, b) => a + b, 0) >= 20) {
              throw new Error(`slow boom len=${arr.length}`);
            }
          },
        ),
        { numRuns: 50, seed: 42, timeLimitMs: 5_000, shrinkTimeLimitMs: 150 },
      );
    } catch (e) {
      caught = e;
    }
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(2_000);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain('Shrinking interrupted after 150ms budget (SHRINK_TIME_LIMIT)');
    expect(err.message).toContain('Primary run failed at test #');
    expect(err.message).toContain('Counterexample:');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('slow boom len=');
  });

  test('shrinkTimeLimitMs 为 0 时跳过缩小直接报告原始失败', async () => {
    let caught: unknown;
    try {
      await assertWithBoundedShrink(
        fc.asyncProperty(fc.integer({ min: 10, max: 100 }), async () => {
          throw new Error('no-shrink boom');
        }),
        { numRuns: 5, seed: 7, timeLimitMs: 5_000, shrinkTimeLimitMs: 0 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error;
    expect(err.message).toContain('seed: 7');
    expect(err.message).toContain('Shrunk 0 time(s)');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe('no-shrink boom');
  });

  test('主阶段超时中断时直接报错且不触发缩小阶段', async () => {
    let calls = 0;
    let caught: unknown;
    try {
      await assertWithBoundedShrink(
        fc.asyncProperty(fc.integer(), async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 40));
        }),
        { numRuns: 100, seed: 9, timeLimitMs: 60, shrinkTimeLimitMs: 5_000 },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Property interrupted');
    expect(calls).toBeLessThan(10);
  });
});
