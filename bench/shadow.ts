import { createAll, formatScript, pgMajorOf, plan } from '@dowel/core';
import { type Db, fromPostgres, pgEngine } from '@dowel/engines';
import { analyze, buildTarget, runSteps } from '@dowel/verifier';
import postgres from 'postgres';

import { assertImportable, SHADOW_STATEMENT_TIMEOUT_MS, shadowOps } from '../apps/server/src/shadow.ts';
import { PG_IMAGE, startPg } from '../test/pg-container.ts';
import { createSmallChangeVariant, generateLargeSchema } from './generator.ts';
import {
  collectHostEnv,
  formatBytes,
  formatMs,
  parseTablesArg,
  type StatsResult,
  summarizeSamples,
} from './utils.ts';

interface SqlTimingRecord {
  phase: string;
  op: 'query' | 'exec';
  elapsedMs: number;
  sqlBytes: number;
  sqlPreview: string;
}

interface ShadowScaleResult {
  tableCount: number;
  totalObjects: number;
  pgMajor: number | null;
  createAll: {
    stepCount: number;
    planMs: number;
    resetShadowMs: number;
    runStepsMs: number;
    stmtStats: StatsResult;
    slowestStmt: SqlTimingRecord | null;
  };
  snapshotRead: {
    iterations: number;
    readStats: StatsResult;
    importSnapshotMs: number;
    snapshotJsonBytes: number;
    slowestCatalogQuery: SqlTimingRecord | null;
  };
  importSql: {
    ddlBytes: number;
    totalMs: number;
    resetAndPrepareMs: number;
    singleExecMs: number;
    readAndImportMs: number;
    importedTables: number;
  };
  verify: {
    upSteps: number;
    downSteps: number;
    planMs: number;
    buildTargetV2Ms: number;
    buildTargetV1Ms: number;
    runUpMs: number;
    readAfterUpMs: number;
    diffUpMs: number;
    runDownMs: number;
    readAfterDownMs: number;
    diffDownMs: number;
    analyzeMs: number;
    totalShadowVerifyMs: number;
    upDiffCount: number;
    downDiffCount: number;
    riskCount: number;
  };
  slowestSingleSql: SqlTimingRecord | null;
  slowestResetDropSchema: SqlTimingRecord | null;
  statementTimeoutMs: number;
  maxSingleSqlRatioToTimeout: number;
}

const previewSql = (sql: string): string => sql.replace(/\s+/g, ' ').trim().slice(0, 140);

const createInstrumentedDb = (raw: Db) => {
  let phase = 'init';
  const records: SqlTimingRecord[] = [];
  const db: Db = {
    query: async <T>(q: string, params?: unknown[]) => {
      const t0 = performance.now();
      const rows = await raw.query<T>(q, params);
      records.push({
        phase,
        op: 'query',
        elapsedMs: performance.now() - t0,
        sqlBytes: Buffer.byteLength(q, 'utf8'),
        sqlPreview: previewSql(q),
      });
      return rows;
    },
    exec: async (q: string) => {
      const t0 = performance.now();
      await raw.exec(q);
      records.push({
        phase,
        op: 'exec',
        elapsedMs: performance.now() - t0,
        sqlBytes: Buffer.byteLength(q, 'utf8'),
        sqlPreview: previewSql(q),
      });
    },
  };
  return {
    db,
    records,
    setPhase: (next: string) => {
      phase = next;
    },
  };
};

const runScale = async (
  adminSql: ReturnType<typeof postgres>,
  baseUrl: string,
  tableCount: number,
): Promise<ShadowScaleResult> => {
  const dbName = `dowel_bench_${tableCount}_${Date.now().toString(36)}`;
  await adminSql.unsafe(`CREATE DATABASE "${dbName}"`);

  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = `/${dbName}`;
  const sessionSql = postgres(targetUrl.toString(), { max: 1, onnotice: () => {} });

  try {
    const rawDb = fromPostgres(sessionSql);
    await rawDb.exec(
      `SET lock_timeout = '10s'; SET statement_timeout = '${SHADOW_STATEMENT_TIMEOUT_MS / 1000}s'`,
    );
    const vNum = await pgEngine.readVersionNum!(rawDb);
    const pgMajor = vNum !== null ? pgMajorOf(vNum) : null;
    const opts = pgMajor !== null ? { pgMajor } : undefined;

    const gen = generateLargeSchema({ tableCount });
    const { v2 } = createSmallChangeVariant(gen);

    const inst = createInstrumentedDb(rawDb);
    const db = inst.db;

    // 1. 全量建表（resetShadow + createAll + runSteps）
    inst.setPhase('createAll:reset');
    const tReset0 = performance.now();
    await pgEngine.resetShadow(db);
    const resetShadowMs = performance.now() - tReset0;

    const tCreatePlan0 = performance.now();
    const createSteps = createAll(gen.model, opts);
    const createPlanMs = performance.now() - tCreatePlan0;

    inst.setPhase('createAll:runSteps');
    const tRunCreate0 = performance.now();
    await runSteps(db, createSteps, 'pg');
    const runCreateMs = performance.now() - tRunCreate0;

    const createExecRecs = inst.records.filter(
      (r) => r.phase === 'createAll:runSteps' && !r.sqlPreview.startsWith('SET '),
    );
    const createStmtStats = summarizeSamples(createExecRecs.map((r) => r.elapsedMs));
    const slowestCreateStmt = [...createExecRecs].sort((a, b) => b.elapsedMs - a.elapsedMs)[0] ?? null;

    // 2. readSnapshot(db) + importSnapshot(snap)（测 3 次）
    const snapTimes: number[] = [];
    let lastSnap!: Awaited<ReturnType<typeof pgEngine.readSnapshot>>;
    inst.setPhase('readSnapshot');
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      lastSnap = await pgEngine.readSnapshot(db);
      snapTimes.push(performance.now() - t0);
    }
    const snapReadStats = summarizeSamples(snapTimes);
    const snapshotJsonBytes = Buffer.byteLength(JSON.stringify(lastSnap.payload), 'utf8');
    const tImp0 = performance.now();
    const importedFromSnap = pgEngine.importSnapshot(lastSnap);
    const importSnapshotMs = performance.now() - tImp0;
    void importedFromSnap;
    const slowestCatalogQuery =
      [...inst.records.filter((r) => r.phase === 'readSnapshot')].sort(
        (a, b) => b.elapsedMs - a.elapsedMs,
      )[0] ?? null;

    // 3. 全量 SQL 脚本导入路径（shadowOps.importSql，使用单条复合 SQL 执行）
    const importableSteps = createSteps.filter(
      (s) => !/^CREATE SCHEMA\s+(?:"public"|public)\s*;?$/i.test(s.sql.trim()),
    );
    const ddlText = formatScript(importableSteps, 'pg');
    const ops = shadowOps(() => Promise.resolve(db), null, {
      statementTimeoutMs: SHADOW_STATEMENT_TIMEOUT_MS,
      dialect: 'pg',
    });
    const recStartImport = inst.records.length;
    inst.setPhase('importSql');
    const tImportSql0 = performance.now();
    const importedModel = await ops.importSql(assertImportable(ddlText, 'pg'));
    const importSqlTotalMs = performance.now() - tImportSql0;
    const importRecs = inst.records.slice(recStartImport);
    const importSingleExecRec = importRecs.find((r) => r.sqlPreview.startsWith('SET search_path = public;'));
    const singleExecMs = importSingleExecRec?.elapsedMs ?? 0;
    const importResetRecs = importRecs.filter(
      (r) => r.op === 'exec' && r.sqlPreview.startsWith('DROP SCHEMA '),
    );
    const resetAndPrepareMs = importResetRecs.reduce((s, r) => s + r.elapsedMs, 0);
    const readAndImportMs = Math.max(0, importSqlTotalMs - singleExecMs - resetAndPrepareMs);
    const importedTables = Object.values(importedModel.objects).filter(
      (o) => o.kind === 'table' && !o.partitionOf,
    ).length;
    if (importedTables !== tableCount) {
      throw new Error(`importSql 读回顶层表数量 ${importedTables} !== 预期 ${tableCount}`);
    }

    // 4. 小改动闭环验证（拆分计测 shadowOps.verify + analyze 真实执行各阶段）
    const engine = pgEngine;
    const tVerifyStart = performance.now();
    const tPlan0 = performance.now();
    const up = plan(gen.model, v2, opts);
    const down = plan(v2, gen.model, opts);
    const verifyPlanMs = performance.now() - tPlan0;

    inst.setPhase('verify:buildTo');
    const tBuildTo0 = performance.now();
    const toSnap = await buildTarget(db, v2, opts);
    const buildTargetV2Ms = performance.now() - tBuildTo0;

    inst.setPhase('verify:buildFrom');
    const tBuildFrom0 = performance.now();
    const fromSnap = await buildTarget(db, gen.model, opts);
    const buildTargetV1Ms = performance.now() - tBuildFrom0;

    inst.setPhase('verify:runUp');
    const tUp0 = performance.now();
    await runSteps(db, up, 'pg');
    const runUpMs = performance.now() - tUp0;

    inst.setPhase('verify:readUp');
    const tReadUp0 = performance.now();
    const afterUp = await engine.readSnapshot(db);
    const readAfterUpMs = performance.now() - tReadUp0;

    const tDiffUp0 = performance.now();
    const upDiff = engine.diffSnapshots(
      engine.normalizeForVerify!(afterUp, v2),
      engine.normalizeForVerify!(toSnap, v2),
    );
    const diffUpMs = performance.now() - tDiffUp0;

    inst.setPhase('verify:runDown');
    const tDown0 = performance.now();
    await runSteps(db, down, 'pg');
    const runDownMs = performance.now() - tDown0;

    inst.setPhase('verify:readDown');
    const tReadDown0 = performance.now();
    const afterDown = await engine.readSnapshot(db);
    const readAfterDownMs = performance.now() - tReadDown0;

    const tDiffDown0 = performance.now();
    const downDiff = engine.diffSnapshots(
      engine.normalizeForVerify!(afterDown, gen.model),
      engine.normalizeForVerify!(fromSnap, gen.model),
    );
    const diffDownMs = performance.now() - tDiffDown0;

    if (upDiff.length > 0 || downDiff.length > 0) {
      throw new Error(
        `PG 闭环验证存在差异：upDiff=${upDiff.slice(0, 3).join('; ')} | downDiff=${downDiff.slice(0, 3).join('; ')}`,
      );
    }

    inst.setPhase('verify:analyze');
    const tAnalyze0 = performance.now();
    const risks = await analyze(db, gen.model, up, opts);
    const analyzeMs = performance.now() - tAnalyze0;

    const totalShadowVerifyMs = performance.now() - tVerifyStart;

    const slowestSingleSql = [...inst.records].sort((a, b) => b.elapsedMs - a.elapsedMs)[0] ?? null;
    const slowestResetDropSchema =
      [...inst.records.filter((r) => r.sqlPreview.startsWith('DROP SCHEMA '))].sort(
        (a, b) => b.elapsedMs - a.elapsedMs,
      )[0] ?? null;

    return {
      tableCount,
      totalObjects: gen.stats.totalObjects,
      pgMajor,
      createAll: {
        stepCount: createSteps.length,
        planMs: createPlanMs,
        resetShadowMs,
        runStepsMs: runCreateMs,
        stmtStats: createStmtStats,
        slowestStmt: slowestCreateStmt,
      },
      snapshotRead: {
        iterations: snapTimes.length,
        readStats: snapReadStats,
        importSnapshotMs,
        snapshotJsonBytes,
        slowestCatalogQuery,
      },
      importSql: {
        ddlBytes: Buffer.byteLength(ddlText, 'utf8'),
        totalMs: importSqlTotalMs,
        resetAndPrepareMs,
        singleExecMs,
        readAndImportMs,
        importedTables,
      },
      verify: {
        upSteps: up.length,
        downSteps: down.length,
        planMs: verifyPlanMs,
        buildTargetV2Ms,
        buildTargetV1Ms,
        runUpMs,
        readAfterUpMs,
        diffUpMs,
        runDownMs,
        readAfterDownMs,
        diffDownMs,
        analyzeMs,
        totalShadowVerifyMs,
        upDiffCount: upDiff.length,
        downDiffCount: downDiff.length,
        riskCount: risks.length,
      },
      slowestSingleSql,
      slowestResetDropSchema,
      statementTimeoutMs: SHADOW_STATEMENT_TIMEOUT_MS,
      maxSingleSqlRatioToTimeout: slowestSingleSql
        ? slowestSingleSql.elapsedMs / SHADOW_STATEMENT_TIMEOUT_MS
        : 0,
    };
  } finally {
    await sessionSql.end({ timeout: 2 }).catch(() => {});
    await adminSql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
  }
};

const main = async () => {
  const scales = parseTablesArg(process.argv.slice(2), [100, 1000]);
  const pg = await startPg();
  if (!pg) {
    throw new Error('需要可用 Docker 或 DOWEL_TEST_PG（PostgreSQL 18 实例）才能执行 Layer 3 影子库压测');
  }

  const adminSql = postgres(pg.url, { max: 1, onnotice: () => {} });
  try {
    const verRows = await adminSql.unsafe<{ v: string }[]>('select version() as v');
    const v = verRows[0]?.v ?? 'unknown';
    const env = { ...collectHostEnv(), pgImage: PG_IMAGE, pgVersion: v };
    const results: ShadowScaleResult[] = [];
    for (const n of scales) {
      results.push(await runScale(adminSql, pg.url, n));
    }

    console.log('\n=== Q17 Layer 3 Benchmark: Real PostgreSQL Shadow DB ===');
    console.log(
      `Host: ${env.cpuModel} (${env.cpuCores} cores) | PG: ${env.pgVersion} (${env.pgImage}) | SHADOW_STATEMENT_TIMEOUT_MS=${SHADOW_STATEMENT_TIMEOUT_MS}`,
    );

    for (const r of results) {
      console.log(`\n--- Scale: ${r.tableCount} top-level tables (${r.totalObjects} IR objects) ---`);
      console.table([
        {
          phase: 'createAll plan()',
          ms: formatMs(r.createAll.planMs),
          detail: `${r.createAll.stepCount} steps`,
        },
        {
          phase: 'createAll runSteps()',
          ms: formatMs(r.createAll.runStepsMs),
          detail: `p50/stmt=${formatMs(r.createAll.stmtStats.p50Ms)} max/stmt=${formatMs(r.createAll.stmtStats.maxMs)}`,
        },
        {
          phase: 'readSnapshot(db)',
          ms: formatMs(r.snapshotRead.readStats.p50Ms),
          detail: `max=${formatMs(r.snapshotRead.readStats.maxMs)} json=${formatBytes(r.snapshotRead.snapshotJsonBytes)}`,
        },
        {
          phase: 'importSnapshot(snap)',
          ms: formatMs(r.snapshotRead.importSnapshotMs),
          detail: `${r.totalObjects} objs`,
        },
        {
          phase: 'importSql total',
          ms: formatMs(r.importSql.totalMs),
          detail: `ddl=${formatBytes(r.importSql.ddlBytes)} singleExec=${formatMs(r.importSql.singleExecMs)}`,
        },
        {
          phase: 'verify: plan(up+down)',
          ms: formatMs(r.verify.planMs),
          detail: `up=${r.verify.upSteps} down=${r.verify.downSteps}`,
        },
        {
          phase: 'verify: buildTarget(v2)',
          ms: formatMs(r.verify.buildTargetV2Ms),
          detail: 'reset+create+snap',
        },
        {
          phase: 'verify: buildTarget(v1)',
          ms: formatMs(r.verify.buildTargetV1Ms),
          detail: 'reset+create+snap',
        },
        {
          phase: 'verify: run up + snap + diff',
          ms: formatMs(r.verify.runUpMs + r.verify.readAfterUpMs + r.verify.diffUpMs),
          detail: `upDiff=${r.verify.upDiffCount}`,
        },
        {
          phase: 'verify: run down + snap + diff',
          ms: formatMs(r.verify.runDownMs + r.verify.readAfterDownMs + r.verify.diffDownMs),
          detail: `downDiff=${r.verify.downDiffCount}`,
        },
        {
          phase: 'verify: analyze() [3rd rebuild]',
          ms: formatMs(r.verify.analyzeMs),
          detail: `risks=${r.verify.riskCount}`,
        },
        {
          phase: 'TOTAL shadowOps.verify()',
          ms: formatMs(r.verify.totalShadowVerifyMs),
          detail: 'end-to-end',
        },
      ]);
      if (r.slowestSingleSql) {
        console.log(
          `Slowest single SQL (${(r.maxSingleSqlRatioToTimeout * 100).toFixed(2)}% of 120s timeout): [${r.slowestSingleSql.phase}] ${formatMs(r.slowestSingleSql.elapsedMs)} -> ${r.slowestSingleSql.sqlPreview}`,
        );
      }
      if (r.slowestResetDropSchema) {
        console.log(
          `Slowest DROP SCHEMA CASCADE: ${formatMs(r.slowestResetDropSchema.elapsedMs)} -> ${r.slowestResetDropSchema.sqlPreview}`,
        );
      }
    }
    console.log('\nBENCH_SHADOW_JSON=' + JSON.stringify({ env, results }));
  } finally {
    await adminSql.end({ timeout: 2 }).catch(() => {});
    await pg.stop();
  }
};

await main();
