// M1a 验收：随机修改 IR，迁移在 PG 18 上必须 100% 闭环通过。
// 本地默认跑少量用例；CI 的 heavy 任务用 RUNS=5000 跑大量用例（.github/workflows/ci.yml）。

import { emptyBase, type Model, plan, validate } from '@dowel/core';
import {
  importSnapshot,
  readHistory,
  readSnapshot,
  reconcileIds,
  stepsChecksum,
  toScriptSteps,
} from '@dowel/engines';
import { type ChainVersion, claimInstance, execute, mergeHistories, readState } from '@dowel/executor';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { PG_URL, useTestDb } from '../../../test/pg.ts';
import { build, resetShadow, verify, verifyScripts } from '../src/index.ts';
import { makeVersions, versions } from './gen.ts';

const conn = useTestDb('random');
const target = useTestDb('random_target');

const RUNS = Number(process.env.RUNS ?? 100);
// 经由执行器的那条：默认最多 30 轮（每轮要建两个库），想深挖时用 EXEC_RUNS 单独调大
const EXEC_RUNS = Number(process.env.EXEC_RUNS ?? Math.min(RUNS, 30));

test.skipIf(!PG_URL)(
  '随机编辑后迁移闭环通过（up 与 down）',
  async () => {
    const db = conn();
    await fc.assert(
      fc.asyncProperty(versions, async (vs) => {
        const { v1, v2 } = makeVersions(vs);
        expect(validate(v1)).toEqual([]);
        expect(validate(v2)).toEqual([]);
        const t0 = performance.now();
        const r = await verify(db, v1, v2);
        if (process.env.TIMING)
          console.log(`${Object.keys(v2.objects).length} 个对象，${(performance.now() - t0).toFixed(0)}ms`);
        expect(r.upDiff).toEqual([]);
        expect(r.downDiff).toEqual([]);
      }),
      {
        numRuns: RUNS,
        seed: process.env.SEED ? Number(process.env.SEED) : undefined,
        // 整个属性测试（跑用例 + 缩小反例）的总时限，超时算失败；防止失败后的缩小过程卡住很久。
        // CI 上 5000 例正常要 8～10 分钟，时限要留够余量（见 ci.yml）
        interruptAfterTimeLimit: Number(process.env.TIME_LIMIT ?? 180_000),
        markInterruptAsFailure: true,
      },
    );
  },
  60_000 + RUNS * 1_000,
);

// 发布时冻结的脚本：plan() 的输出经 toScriptSteps 冻结，之后执行的是这份文本而不是重新规划。
// 用 verifyScripts 执行冻结脚本，同样必须闭环通过（H1）。数量固定上限 50 轮，不跟 RUNS 一起放大
test.skipIf(!PG_URL)(
  '随机编辑后，plan 产出的冻结脚本经 verifyScripts 闭环通过',
  async () => {
    const db = conn();
    await fc.assert(
      fc.asyncProperty(versions, async (vs) => {
        const { v1, v2 } = makeVersions(vs);
        const up = toScriptSteps(plan(v1, v2));
        const down = toScriptSteps(plan(v2, v1));
        const r = await verifyScripts(db, v1, v2, up, down);
        expect(r.upDiff).toEqual([]);
        expect(r.downDiff).toEqual([]);
        // 冻结的步骤与规划器的输出逐条一致
        expect(r.up.map((s) => s.sql)).toEqual(up.map((s) => s.sql));
      }),
      {
        numRuns: Math.min(RUNS, 50),
        seed: process.env.SEED ? Number(process.env.SEED) : undefined,
        interruptAfterTimeLimit: Number(process.env.TIME_LIMIT ?? 180_000),
        markInterruptAsFailure: true,
      },
    );
  },
  60_000 + 50 * 1_000,
);

// 经由执行器 + 历史表（P4b）：发布时冻结的脚本放进版本链，在一个真正的“目标库”上由执行器逐个执行（v1 → v2）、
// 回滚（v2 → v1）、再执行；执行器每个迁移后读回结构并与目标版本的模型比较（失败就回滚），历史表记下每次执行。
// 模型先在另一个库里建一遍再读回（模拟发布时的规范化：表达式、默认值是引擎的规范形式）。数量固定上限 30 轮：
// 每轮要在两个库里建库，比单纯 verifyScripts 慢，不跟 RUNS 一起放大
test.skipIf(!PG_URL)(
  '随机编辑后，冻结脚本经执行器 + 历史表执行 / 回滚 / 再执行，每一步读回的结构都等于版本模型',
  async () => {
    const scratch = conn();
    const tdb = target();
    const canon = async (m: Model): Promise<Model> => {
      await build(scratch, m);
      return reconcileIds(m, importSnapshot(await readSnapshot(scratch)));
    };
    const version = (models: Model[], i: number): ChainVersion => {
      const model = models[i]!;
      const from = i === 0 ? emptyBase(model, null) : models[i - 1]!;
      const up = toScriptSteps(plan(from, model));
      const down = toScriptSteps(plan(model, from));
      return {
        id: `v${i + 1}`,
        number: i + 1,
        parentId: i === 0 ? null : `v${i}`,
        name: `版本 ${i + 1}`,
        model,
        upSteps: up,
        downSteps: down,
        checksum: stepsChecksum(up, down),
        verified: true,
        publishedAt: new Date().toISOString(),
        publishedBy: null,
        scope: null,
      };
    };
    await fc.assert(
      fc.asyncProperty(versions, async (vs) => {
        const { v1, v2 } = makeVersions(vs);
        const models = [await canon(v1), await canon(v2)];
        const chain = [version(models, 0), version(models, 1)];
        // 全新的目标库：清空（包括上一轮留下的 dowel schema），再建一个干净的 public
        await resetShadow(tdb);
        await tdb.exec('CREATE SCHEMA public');
        const base = {
          db: tdb,
          projectId: 'random',
          projectName: null,
          instanceId: 'random-instance',
          chain,
          executedBy: null,
        };
        const up = await execute({ ...base, to: 'v2' });
        // v1 本来就等于全新的库（模型里几乎什么都没有）时，库的结构已经是 v1：只写基线，不执行 SQL
        const first = up.ran[0]!.direction;
        expect(['up', 'baseline']).toContain(first);
        expect(up.ran.map((r) => [r.number, r.direction])).toEqual([
          [1, first],
          [2, 'up'],
        ]);
        const down = await execute({ ...base, to: 'v1' });
        expect(down.ran.map((r) => [r.number, r.direction])).toEqual([[2, 'down']]);
        const again = await execute({ ...base, to: 'v2' });
        expect(again.ran.map((r) => [r.number, r.direction])).toEqual([[2, 'up']]);
        const h = await readHistory(tdb, 'random');
        expect(h.currentVersion).toBe('v2');
        expect(h.history.map((x) => [x.direction, x.status])).toEqual([
          [first, 'done'],
          ['up', 'done'],
          ['down', 'done'],
          ['up', 'done'],
        ]);

        // 新实例接手（P4c）：只靠目标库里的 dowel 历史恢复版本链——模型（含对象 ID）、冻结脚本、checksum 与原来的完全一致；
        // 认领之后原实例被拒绝；新实例用恢复出来的链继续执行 / 回滚，每一步读回的结构仍然等于恢复出来的模型
        const merged = mergeHistories([{ name: 'target', state: await readState(tdb, 'random') }]);
        expect(merged.versions.map((r) => [r.versionId, r.number, r.parentId, r.checksum])).toEqual(
          chain.map((v) => [v.id, v.number, v.parentId, v.checksum]),
        );
        for (const [i, r] of merged.versions.entries()) {
          expect(r.model, `v${i + 1} 的模型（含对象 ID）`).toEqual(chain[i]!.model);
          expect(r.upSteps).toEqual(chain[i]!.upSteps);
          expect(r.downSteps).toEqual(chain[i]!.downSteps);
        }
        expect(merged.envs[0]).toMatchObject({ current: 'v2', behind: 0 });
        const restored: ChainVersion[] = merged.versions.map((r) => ({
          id: r.versionId,
          number: r.number,
          parentId: r.parentId,
          name: r.name,
          model: r.model,
          upSteps: r.upSteps,
          downSteps: r.downSteps,
          checksum: r.checksum,
          // 接手恢复的版本在平台上是“未验证”的；这里模拟用户在影子库里重新验证过
          verified: true,
          publishedAt: r.publishedAt,
          publishedBy: r.publishedBy,
          scope: r.scope?.length ? r.scope : null,
        }));
        const claimed = await claimInstance({
          chain: restored,
          db: tdb,
          projectId: 'random',
          projectName: null,
          instanceId: 'random-instance-2',
          claimedBy: null,
          claimedByName: null,
        });
        expect(claimed).toEqual({ changed: true, previousInstanceId: 'random-instance' });
        await expect(execute({ ...base, to: 'v1' })).rejects.toMatchObject({ code: 'foreign_instance' });
        const b2 = { ...base, chain: restored, instanceId: 'random-instance-2' };
        expect((await execute({ ...b2, to: 'v1' })).ran.map((r) => [r.number, r.direction])).toEqual([
          [2, 'down'],
        ]);
        expect((await execute({ ...b2, to: 'v2' })).ran.map((r) => [r.number, r.direction])).toEqual([
          [2, 'up'],
        ]);
      }),
      {
        numRuns: EXEC_RUNS,
        seed: process.env.SEED ? Number(process.env.SEED) : undefined,
        interruptAfterTimeLimit: Number(process.env.TIME_LIMIT ?? 180_000),
        markInterruptAsFailure: true,
      },
    );
  },
  120_000 + EXEC_RUNS * 2_000,
);
