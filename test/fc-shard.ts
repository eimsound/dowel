// fast-check 分片并行执行与有界 shrink 辅助：
// - 支持通过 HEAVY_WORKERS 在多个隔离测试库上并行运行属性测试；
// - 显式指定 SEED 时强制退回单 worker，保证与单机顺序复现完全一致；
// - 主搜索阶段使用 endOnFailure 抢占早停：任意分片失败即通过 AbortController 中止其余分片，
//   再对首个命中反例的分片单独做有界 shrink（受 shrinkTimeLimitMs 约束）；
// - 使用软时限插件（而非 Promise.race 强行丢弃在途查询），确保所有在途 DB 操作收敛后再进入 shrink 或清理。
import fc from 'fast-check';

export interface ShardDbHandle<TDb> {
  db: TDb;
  close: () => Promise<void>;
}

export interface ShardedPropertyOptions<TDb, Ts> {
  prefix: string;
  defaultDb: TDb;
  createDb?: (prefix: string) => Promise<ShardDbHandle<TDb>>;
  runs: number;
  workers: number;
  seed?: number;
  timeLimitMs: number;
  shrinkTimeLimitMs: number;
  makeProperty: (db: TDb, checkAbort: () => void) => fc.IAsyncProperty<Ts>;
}

/** 解析显式 SEED 环境变量；支持 0 与负整数，空白或非法值返回 undefined */
export const parseExplicitSeed = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

/** 解析正整数毫秒数；空白、非正数或非法值返回 fallback */
export const parsePositiveMs = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

/** 解析非负整数毫秒数（允许 0，例如 SHRINK_TIME_LIMIT=0 跳过缩小）；空白、负数或非法值返回 fallback */
export const parseNonNegativeMs = (raw: string | undefined, fallback: number): number => {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
};

/**
 * 解析分片并发度：
 * - 显式指定 SEED 时强制返回 1，保证单种子复现与单 worker 序列完全一致；
 * - 否则将 HEAVY_WORKERS 钳制在 [1, Math.min(8, runs)]（runs < 1 时为 1）。
 */
export const resolveHeavyWorkers = (
  runs: number,
  rawWorkers: string | undefined,
  explicitSeed: number | undefined,
): number => {
  if (explicitSeed !== undefined) return 1;
  const safeRuns = Number.isFinite(runs) ? Math.max(1, Math.trunc(runs)) : 1;
  const maxWorkers = Math.max(1, Math.min(8, safeRuns));
  const trimmed = rawWorkers?.trim();
  if (!trimmed) return 1;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(maxWorkers, Math.trunc(parsed));
};

/** 将 totalRuns 尽量均匀切分到 workers 个分片，各分片之和严格等于 totalRuns */
export const partitionRuns = (totalRuns: number, workers: number): number[] => {
  const w = Math.max(1, Math.trunc(workers));
  const total = Math.max(0, Math.trunc(totalRuns));
  const base = Math.floor(total / w);
  const rem = total % w;
  return Array.from({ length: w }, (_, i) => base + (i < rem ? 1 : 0));
};

/** 为各个分片生成互异且可由 SEED=<shardSeed> 单独复现的 32 位整数种子 */
export const deriveShardSeeds = (workers: number, explicitSeed: number | undefined): number[] => {
  const w = Math.max(1, Math.trunc(workers));
  if (explicitSeed !== undefined) {
    return Array.from({ length: w }, () => explicitSeed | 0);
  }
  const baseSeed = (Math.random() * 0x1_0000_0000) | 0;
  // 0x9e3779b1 为奇数，在 mod 2^32 下对 0..7 保证相邻分片种子完全分散且互不相同
  return Array.from({ length: w }, (_, i) => (baseSeed + Math.imul(i, 0x9e3779b1)) | 0);
};

const formatShardHeader = (index: number, workers: number, seed: number, runs: number): string =>
  workers > 1 ? `[shard ${index + 1}/${workers}, SEED=${seed}, shardRuns=${runs}] ` : '';

const HARD_WATCHDOG_GRACE_MS = 15_000;
const INFLIGHT_SETTLE_WAIT_MS = 5_000;

const settleInFlight = async (activeRuns: Set<Promise<unknown>>): Promise<void> => {
  if (activeRuns.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...activeRuns]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, INFLIGHT_SETTLE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const runShardedProperty = async <TDb, Ts>(opts: ShardedPropertyOptions<TDb, Ts>): Promise<void> => {
  const workers = Math.max(1, Math.trunc(opts.workers));
  const shardRuns = partitionRuns(opts.runs, workers);
  const shardSeeds = deriveShardSeeds(workers, opts.seed);
  const createdHandles: ShardDbHandle<TDb>[] = [];
  const activeRuns = new Set<Promise<unknown>>();

  const trackPromise = (p: Promise<unknown>) => {
    activeRuns.add(p);
    void p.finally(() => {
      activeRuns.delete(p);
    });
  };

  const makeDeadlinePlugin = (
    deadlineMs: number,
    abortSignal?: AbortSignal,
    onCheck?: () => void,
  ): fc.Plugin<Ts> => {
    return () => ({
      decorateRun: (nestedRun) => (value) => {
        if (abortSignal?.aborted || Date.now() >= deadlineMs) {
          onCheck?.();
          return Promise.resolve(new fc.PreconditionFailure(true));
        }
        const out = nestedRun(value);
        if (out !== null && typeof out === 'object' && 'then' in out) {
          const p = Promise.resolve(out);
          trackPromise(p);
          return p;
        }
        return out;
      },
    });
  };

  try {
    const dbs: TDb[] = [];
    if (workers === 1) {
      dbs.push(opts.defaultDb);
    } else {
      const { createDb } = opts;
      if (!createDb) {
        throw new Error('runShardedProperty requires createDb when workers > 1');
      }
      // 顺序建库避免并发 CREATE DATABASE 争抢 template1；任一步失败仍由 finally 清理已建库
      for (let i = 0; i < workers; i++) {
        const handle = await createDb(`${opts.prefix}_s${i}`);
        createdHandles.push(handle);
        dbs.push(handle.db);
      }
    }

    const controller = new AbortController();
    const searchDeadline = Date.now() + opts.timeLimitMs;
    const checkAbort = () => {
      if (controller.signal.aborted || Date.now() >= searchDeadline) {
        throw new fc.PreconditionFailure(true);
      }
    };
    const searchPlugin = makeDeadlinePlugin(searchDeadline, controller.signal);

    interface ShardOutcome {
      index: number;
      db: TDb;
      runs: number;
      seed: number;
      details: fc.RunDetails<Ts>;
      abortedBySibling: boolean;
    }

    const outcomes: ShardOutcome[] = await Promise.all(
      dbs.map(async (db, index): Promise<ShardOutcome> => {
        const runs = shardRuns[index]!;
        const seed = shardSeeds[index]!;
        const details = await fc.check(opts.makeProperty(db, checkAbort), {
          numRuns: runs,
          seed,
          endOnFailure: true,
          interruptAfterTimeLimit: opts.timeLimitMs + HARD_WATCHDOG_GRACE_MS,
          markInterruptAsFailure: true,
          plugins: [searchPlugin],
        });
        const abortedBySibling = controller.signal.aborted;
        if (details.failed && !abortedBySibling) {
          controller.abort();
        }
        return { index, db, runs, seed, details, abortedBySibling };
      }),
    );

    await settleInFlight(activeRuns);

    const counterexampleWinner = outcomes.find(
      (o) => o.details.failed && o.details.counterexamplePath !== null,
    );
    if (counterexampleWinner) {
      let reportDetails: fc.RunDetails<Ts> = counterexampleWinner.details;
      let shrinkNote = '';
      if (opts.shrinkTimeLimitMs > 0) {
        const shrinkDeadline = Date.now() + opts.shrinkTimeLimitMs;
        let shrinkTimedOut = false;
        const shrinkPlugin = makeDeadlinePlugin(shrinkDeadline, undefined, () => {
          shrinkTimedOut = true;
        });
        // 独占失败分片对应的 DB，使用空 checkAbort 并移除 abort 信号约束执行有界 shrink 回放
        const shrunk = await fc.check(
          opts.makeProperty(counterexampleWinner.db, () => {}),
          {
            seed: counterexampleWinner.seed,
            path: counterexampleWinner.details.counterexamplePath!,
            numRuns: 1,
            endOnFailure: false,
            interruptAfterTimeLimit: opts.shrinkTimeLimitMs + HARD_WATCHDOG_GRACE_MS,
            markInterruptAsFailure: false,
            plugins: [shrinkPlugin],
          },
        );
        if (shrunk.failed && shrunk.counterexamplePath !== null) {
          reportDetails = { ...shrunk, numRuns: counterexampleWinner.details.numRuns };
          if (shrunk.interrupted || shrinkTimedOut) {
            shrinkNote = `\n(shrink interrupted after ${opts.shrinkTimeLimitMs}ms (SHRINK_TIME_LIMIT); best counterexample shown)`;
          }
        } else {
          shrinkNote =
            '\n(shrink replay did not reproduce failure; reporting original unshrunk counterexample)';
        }
      }
      const report = (await fc.asyncDefaultReportMessage(reportDetails)) ?? 'Property failed';
      const header = formatShardHeader(
        counterexampleWinner.index,
        workers,
        counterexampleWinner.seed,
        counterexampleWinner.runs,
      );
      throw new Error(`${header}${report}${shrinkNote}`, {
        cause: reportDetails.errorInstance ?? undefined,
      });
    }

    const otherFailure =
      outcomes.find((o) => o.details.failed && !o.abortedBySibling) ?? outcomes.find((o) => o.details.failed);
    if (otherFailure) {
      const report = (await fc.asyncDefaultReportMessage(otherFailure.details)) ?? 'Property failed';
      const header = formatShardHeader(otherFailure.index, workers, otherFailure.seed, otherFailure.runs);
      throw new Error(`${header}${report}`, {
        cause: otherFailure.details.errorInstance ?? undefined,
      });
    }
  } finally {
    await settleInFlight(activeRuns);
    if (createdHandles.length > 0) {
      await Promise.allSettled(createdHandles.map((h) => h.close()));
    }
  }
};
