import { cpus, totalmem } from 'node:os';

export interface StatsResult {
  count: number;
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  samples: number[];
}

export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

export interface MeasureOptions {
  warmup?: number;
  iterations: number;
  maxTotalMs?: number;
}

/** 计算有序数组的百分位数（线性插值，p ∈ [0, 100]） */
export const percentile = (sorted: readonly number[], p: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
};

/** 汇总样本耗时统计（min / mean / p50 / p95 / max） */
export const summarizeSamples = (samples: readonly number[]): StatsResult => {
  if (samples.length === 0) {
    return { count: 0, minMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, samples: [] };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    meanMs: sum / sorted.length,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
    samples: [...samples],
  };
};

/** 同步函数耗时采样（支持预热与超长耗时保护） */
export const measureSync = <T>(
  fn: (iter: number) => T,
  opts: MeasureOptions,
): { stats: StatsResult; lastResult: T } => {
  const warmup = opts.warmup ?? 1;
  const maxTotalMs = opts.maxTotalMs ?? Number.POSITIVE_INFINITY;
  let lastResult!: T;
  for (let i = 0; i < warmup; i++) {
    lastResult = fn(-1 - i);
  }
  const samples: number[] = [];
  const startAll = performance.now();
  const minSamples = Math.min(opts.iterations, 5);
  for (let i = 0; i < opts.iterations; i++) {
    if (i >= minSamples && performance.now() - startAll > maxTotalMs) break;
    const t0 = performance.now();
    lastResult = fn(i);
    samples.push(performance.now() - t0);
  }
  return { stats: summarizeSamples(samples), lastResult };
};

/** 异步函数耗时采样（支持预热与超长耗时保护） */
export const measureAsync = async <T>(
  fn: (iter: number) => Promise<T>,
  opts: MeasureOptions,
): Promise<{ stats: StatsResult; lastResult: T }> => {
  const warmup = opts.warmup ?? 1;
  const maxTotalMs = opts.maxTotalMs ?? Number.POSITIVE_INFINITY;
  let lastResult!: T;
  for (let i = 0; i < warmup; i++) {
    lastResult = await fn(-1 - i);
  }
  const samples: number[] = [];
  const startAll = performance.now();
  const minSamples = Math.min(opts.iterations, 5);
  for (let i = 0; i < opts.iterations; i++) {
    if (i >= minSamples && performance.now() - startAll > maxTotalMs) break;
    const t0 = performance.now();
    lastResult = await fn(i);
    samples.push(performance.now() - t0);
  }
  return { stats: summarizeSamples(samples), lastResult };
};

/** 采集当前 Node 进程内存快照（可用 --expose-gc 时先做一次 GC 以减少噪声） */
export const memorySnapshot = (runGc = true): MemorySnapshot => {
  if (runGc) {
    (globalThis as { gc?: () => void }).gc?.();
  }
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
  };
};

export const formatMs = (ms: number): string =>
  ms >= 1000 ? `${ms.toFixed(1)} ms (${(ms / 1000).toFixed(2)} s)` : `${ms.toFixed(2)} ms`;

export const formatBytes = (bytes: number): string => {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024 * 1024) return `${sign}${(abs / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (abs >= 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MiB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} KiB`;
  return `${sign}${abs} B`;
};

/** 解析 CLI `--tables=100,1000` / `--tables 100` 或环境变量 `BENCH_TABLES` */
export const parseTablesArg = (
  argv: readonly string[],
  fallback: readonly number[] = [100, 1000],
): number[] => {
  let raw: string | undefined = process.env.BENCH_TABLES;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--tables=')) {
      raw = arg.slice('--tables='.length);
    } else if (arg === '--tables' && i + 1 < argv.length) {
      raw = argv[i + 1];
    }
  }
  if (!raw?.trim()) return [...fallback];
  const parsed = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return parsed.length > 0 ? parsed : [...fallback];
};

/** 采集基准运行宿主机的 CPU / 内存 / Node 环境信息 */
export const collectHostEnv = () => {
  const cpuList = cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCores: cpuList.length,
    totalMemoryBytes: totalmem(),
  };
};
