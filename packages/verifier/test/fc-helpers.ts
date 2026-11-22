import fc from 'fast-check';

export interface BoundedShrinkOptions {
  numRuns: number;
  seed?: number;
  timeLimitMs: number;
  shrinkTimeLimitMs: number;
}

/**
 * 将模糊测试阶段（timeLimitMs）与缩小反例阶段（shrinkTimeLimitMs）的预算解耦：
 * 1) 主阶段开启 endOnFailure，遇到第一个反例立刻停止；
 * 2) 若捕获到属性失败且具备 counterexamplePath，再从该 exact { seed, path } 启动限时 shrink；
 * 3) shrink 即使被时限打断也保留已缩小的最小反例（或回退到原始反例），并附上可复现信息后抛出。
 */
export const assertWithBoundedShrink = async <Ts>(
  property: fc.IAsyncProperty<Ts>,
  opts: BoundedShrinkOptions,
): Promise<void> => {
  const primary = await fc.check(property, {
    numRuns: opts.numRuns,
    seed: opts.seed,
    endOnFailure: true,
    interruptAfterTimeLimit: opts.timeLimitMs,
    markInterruptAsFailure: true,
  });
  if (!primary.failed) return;

  if (primary.counterexamplePath === null || opts.shrinkTimeLimitMs <= 0) {
    const report = await fc.asyncDefaultReportMessage(primary);
    throw new Error(report, { cause: primary.errorInstance });
  }

  const shrunk = await fc.check(property, {
    numRuns: 1,
    seed: primary.seed,
    path: primary.counterexamplePath,
    endOnFailure: false,
    interruptAfterTimeLimit: opts.shrinkTimeLimitMs,
    markInterruptAsFailure: false,
  });

  const usedShrunk = shrunk.failed && shrunk.counterexamplePath !== null;
  const chosen = usedShrunk ? shrunk : primary;
  const report = await fc.asyncDefaultReportMessage(chosen);
  const notes: string[] = [];
  if (usedShrunk) {
    notes.push(
      `Primary run failed at test #${primary.numRuns} (seed: ${primary.seed}, path: "${primary.counterexamplePath}")`,
    );
    if (shrunk.interrupted) {
      notes.push(`Shrinking interrupted after ${opts.shrinkTimeLimitMs}ms budget (SHRINK_TIME_LIMIT)`);
    }
  } else {
    notes.push(
      `Shrinking did not produce a counterexample within ${opts.shrinkTimeLimitMs}ms budget; reporting primary failure at test #${primary.numRuns}`,
    );
  }
  throw new Error(`${report}\n${notes.join('\n')}`, { cause: chosen.errorInstance });
};
