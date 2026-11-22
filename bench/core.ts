import { createAll, plan, validate } from '@dowel/core';
import { emptyRoomState, memoryStore, Room, SyncClient, type ToClient, type ToServer } from '@dowel/sync';

import { createSmallChangeVariant, type GeneratedSchema, generateLargeSchema } from './generator.ts';
import {
  collectHostEnv,
  formatBytes,
  formatMs,
  measureAsync,
  measureSync,
  memorySnapshot,
  parseTablesArg,
  type StatsResult,
  summarizeSamples,
} from './utils.ts';

interface MutateBreakdown {
  op: 'setComment' | 'renameColumn';
  clientMutate: StatsResult;
  serverHandle: StatsResult;
  clientReceive: StatsResult;
  roundTrip: StatsResult;
}

interface CoreScaleResult {
  tableCount: number;
  stats: GeneratedSchema['stats'];
  generateMs: number;
  validateErrors: number;
  v2ValidateErrors: number;
  validateStats: StatsResult;
  planStepCount: number;
  planStats: StatsResult;
  createAllStepCount: number;
  createAllSqlBytes: number;
  createAllStats: StatsResult;
  mutateAll: StatsResult;
  mutateSetComment: MutateBreakdown;
  mutateRenameColumn: MutateBreakdown;
  memory: {
    baselineHeapBytes: number;
    afterGenHeapBytes: number;
    afterGenRssBytes: number;
    afterBenchHeapBytes: number;
    afterBenchRssBytes: number;
    genHeapDeltaBytes: number;
    peakOrEndHeapDeltaBytes: number;
    peakOrEndRssDeltaBytes: number;
  };
}

const benchMutateRoundTrip = async (gen: GeneratedSchema, pairs: number) => {
  const room = new Room(emptyRoomState(structuredClone(gen.model)), memoryStore());
  const client = new SyncClient('bench-client', structuredClone(gen.model));

  // 通过标准 hello 握手完成同步状态初始化
  let buffered: ToClient[] = [];
  client.send = (msg: ToServer) => {
    if (msg.t === 'hello') {
      void room.handle('bench-client', 'bench', msg).then((outs) => {
        buffered = outs.map((o) => o.msg);
      });
    }
  };
  client.connect();
  await new Promise((r) => setTimeout(r, 0));
  for (const m of buffered) client.receive(m);
  client.send = () => {};

  const runPair = async (
    iter: number,
    op: 'setComment' | 'renameColumn',
  ): Promise<{
    clientMutateMs: number;
    serverHandleMs: number;
    clientReceiveMs: number;
    roundTripMs: number;
  }> => {
    let outbound: ToServer | null = null;
    client.send = (m) => {
      outbound = m;
    };
    const args =
      op === 'setComment'
        ? { id: gen.mutateTargetTableId, comment: iter % 2 === 0 ? `bench-${iter}` : null }
        : { id: gen.mutateTargetColumnId, name: iter % 2 === 0 ? 'payload_v2' : 'payload' };

    const t0 = performance.now();
    client.mutate(op, args);
    const t1 = performance.now();

    const msg = outbound as ToServer | null;
    if (!msg) throw new Error(`mutate(${op}) 未产生待发送消息`);
    const outs = await room.handle('bench-client', 'bench', structuredClone(msg));
    const t2 = performance.now();

    for (const out of outs) {
      if (out.to === '*' || out.to === 'bench-client') {
        client.receive(structuredClone(out.msg));
      }
    }
    const t3 = performance.now();

    return {
      clientMutateMs: t1 - t0,
      serverHandleMs: t2 - t1,
      clientReceiveMs: t3 - t2,
      roundTripMs: t3 - t0,
    };
  };

  // 预热 1 轮（各 1 次）
  await runPair(-2, 'setComment');
  await runPair(-1, 'renameColumn');

  const collect = (
    op: 'setComment' | 'renameColumn',
    rows: Awaited<ReturnType<typeof runPair>>[],
  ): MutateBreakdown => ({
    op,
    clientMutate: summarizeSamples(rows.map((r) => r.clientMutateMs)),
    serverHandle: summarizeSamples(rows.map((r) => r.serverHandleMs)),
    clientReceive: summarizeSamples(rows.map((r) => r.clientReceiveMs)),
    roundTrip: summarizeSamples(rows.map((r) => r.roundTripMs)),
  });

  const commentRows: Awaited<ReturnType<typeof runPair>>[] = [];
  const renameRows: Awaited<ReturnType<typeof runPair>>[] = [];
  const startAll = performance.now();
  const minPairs = Math.min(pairs, 5);

  for (let i = 0; i < pairs; i++) {
    if (i >= minPairs && performance.now() - startAll > 30_000) break;
    commentRows.push(await runPair(i, 'setComment'));
    renameRows.push(await runPair(i, 'renameColumn'));
  }

  const allRounds = [...commentRows, ...renameRows].map((r) => r.roundTripMs);
  return {
    mutateAll: summarizeSamples(allRounds),
    mutateSetComment: collect('setComment', commentRows),
    mutateRenameColumn: collect('renameColumn', renameRows),
  };
};

const runScale = async (tableCount: number): Promise<CoreScaleResult> => {
  const isLarge = tableCount >= 500;
  const memBase = memorySnapshot(true);

  const tGen0 = performance.now();
  const gen = generateLargeSchema({ tableCount });
  const generateMs = performance.now() - tGen0;
  const memAfterGen = memorySnapshot(true);

  const v1Errs = validate(gen.model);
  if (v1Errs.length > 0) {
    throw new Error(`${tableCount} 表模型校验失败（${v1Errs.length} 条）：${v1Errs.slice(0, 5).join('; ')}`);
  }

  const variant = createSmallChangeVariant(gen);
  const v2Errs = validate(variant.v2);
  if (v2Errs.length > 0) {
    throw new Error(`${tableCount} 表 v2 校验失败：${v2Errs.slice(0, 5).join('; ')}`);
  }

  const validateRes = measureSync(() => validate(gen.model), {
    warmup: isLarge ? 1 : 2,
    iterations: isLarge ? 10 : 20,
    maxTotalMs: 30_000,
  });

  const planRes = measureSync(() => plan(gen.model, variant.v2, { pgMajor: 18 }), {
    warmup: isLarge ? 1 : 2,
    iterations: isLarge ? 10 : 20,
    maxTotalMs: 30_000,
  });

  const createAllRes = measureSync(() => createAll(gen.model, { pgMajor: 18 }), {
    warmup: 1,
    iterations: isLarge ? 5 : 10,
    maxTotalMs: 30_000,
  });
  const createAllSqlBytes = createAllRes.lastResult.reduce(
    (sum, s) => sum + Buffer.byteLength(s.sql, 'utf8') + 2,
    0,
  );

  // 为保证每组对比干净，单独用 measureAsync 包一层统计后也直接调用 benchMutateRoundTrip
  const { mutateAll, mutateSetComment, mutateRenameColumn } = await benchMutateRoundTrip(
    gen,
    isLarge ? 8 : 15,
  );
  // 让 measureAsync 保持引入被使用并在需要时可复测（此处直接使用分项测量）
  void measureAsync;

  const memEnd = memorySnapshot(true);

  return {
    tableCount,
    stats: gen.stats,
    generateMs,
    validateErrors: v1Errs.length,
    v2ValidateErrors: v2Errs.length,
    validateStats: validateRes.stats,
    planStepCount: planRes.lastResult.length,
    planStats: planRes.stats,
    createAllStepCount: createAllRes.lastResult.length,
    createAllSqlBytes,
    createAllStats: createAllRes.stats,
    mutateAll,
    mutateSetComment,
    mutateRenameColumn,
    memory: {
      baselineHeapBytes: memBase.heapUsedBytes,
      afterGenHeapBytes: memAfterGen.heapUsedBytes,
      afterGenRssBytes: memAfterGen.rssBytes,
      afterBenchHeapBytes: memEnd.heapUsedBytes,
      afterBenchRssBytes: memEnd.rssBytes,
      genHeapDeltaBytes: memAfterGen.heapUsedBytes - memBase.heapUsedBytes,
      peakOrEndHeapDeltaBytes: memEnd.heapUsedBytes - memBase.heapUsedBytes,
      peakOrEndRssDeltaBytes: memEnd.rssBytes - memBase.rssBytes,
    },
  };
};

const printReport = (env: ReturnType<typeof collectHostEnv>, results: CoreScaleResult[]) => {
  console.log('\n=== Q17 Layer 1 Benchmark: @dowel/core & @dowel/sync ===');
  console.log(
    `Host: ${env.cpuModel} (${env.cpuCores} cores) | RAM: ${formatBytes(env.totalMemoryBytes)} | Node ${env.nodeVersion}`,
  );

  for (const r of results) {
    console.log(`\n--- Scale: ${r.tableCount} top-level tables ---`);
    console.log(
      `IR Objects: ${r.stats.totalObjects} (schemas=${r.stats.schemas}, enums=${r.stats.enums}, seqs=${r.stats.sequences}, partParents=${r.stats.partitionParents}, partChildren=${r.stats.partitionChildren}, cols=${r.stats.columns}, pk=${r.stats.primaryKeys}, uq=${r.stats.uniques}, fk=${r.stats.foreignKeys}, chk=${r.stats.checks}, idx=${r.stats.indexes}) | JSON: ${formatBytes(r.stats.jsonBytes)} | gen: ${formatMs(r.generateMs)}`,
    );
    const rows = [
      {
        metric: 'validate(model)',
        n: r.validateStats.count,
        p50: formatMs(r.validateStats.p50Ms),
        p95: formatMs(r.validateStats.p95Ms),
        max: formatMs(r.validateStats.maxMs),
        extra: `errs=${r.validateErrors}`,
      },
      {
        metric: 'plan(v1, v2) [small]',
        n: r.planStats.count,
        p50: formatMs(r.planStats.p50Ms),
        p95: formatMs(r.planStats.p95Ms),
        max: formatMs(r.planStats.maxMs),
        extra: `steps=${r.planStepCount}`,
      },
      {
        metric: 'createAll(model)',
        n: r.createAllStats.count,
        p50: formatMs(r.createAllStats.p50Ms),
        p95: formatMs(r.createAllStats.p95Ms),
        max: formatMs(r.createAllStats.maxMs),
        extra: `steps=${r.createAllStepCount}, sql=${formatBytes(r.createAllSqlBytes)}`,
      },
      {
        metric: 'sync mutate round-trip (all)',
        n: r.mutateAll.count,
        p50: formatMs(r.mutateAll.p50Ms),
        p95: formatMs(r.mutateAll.p95Ms),
        max: formatMs(r.mutateAll.maxMs),
        extra: 'client+room+receive',
      },
      {
        metric: '  └─ setComment round-trip',
        n: r.mutateSetComment.roundTrip.count,
        p50: formatMs(r.mutateSetComment.roundTrip.p50Ms),
        p95: formatMs(r.mutateSetComment.roundTrip.p95Ms),
        max: formatMs(r.mutateSetComment.roundTrip.maxMs),
        extra: `cli=${formatMs(r.mutateSetComment.clientMutate.p50Ms)} srv=${formatMs(r.mutateSetComment.serverHandle.p50Ms)} rcv=${formatMs(r.mutateSetComment.clientReceive.p50Ms)}`,
      },
      {
        metric: '  └─ renameColumn round-trip',
        n: r.mutateRenameColumn.roundTrip.count,
        p50: formatMs(r.mutateRenameColumn.roundTrip.p50Ms),
        p95: formatMs(r.mutateRenameColumn.roundTrip.p95Ms),
        max: formatMs(r.mutateRenameColumn.roundTrip.maxMs),
        extra: `cli=${formatMs(r.mutateRenameColumn.clientMutate.p50Ms)} srv=${formatMs(r.mutateRenameColumn.serverHandle.p50Ms)} rcv=${formatMs(r.mutateRenameColumn.clientReceive.p50Ms)}`,
      },
    ];
    console.table(rows);
    console.log(
      `Memory: baseHeap=${formatBytes(r.memory.baselineHeapBytes)} | afterGenHeap=${formatBytes(r.memory.afterGenHeapBytes)} (+${formatBytes(r.memory.genHeapDeltaBytes)}) | endHeap=${formatBytes(r.memory.afterBenchHeapBytes)} (RSS=${formatBytes(r.memory.afterBenchRssBytes)}, ΔRSS=${formatBytes(r.memory.peakOrEndRssDeltaBytes)})`,
    );
  }
  console.log('\nBENCH_CORE_JSON=' + JSON.stringify({ env, results }));
};

const main = async () => {
  const scales = parseTablesArg(process.argv.slice(2), [100, 1000]);
  const env = collectHostEnv();
  const results: CoreScaleResult[] = [];
  for (const n of scales) {
    results.push(await runScale(n));
  }
  printReport(env, results);
};

await main();
