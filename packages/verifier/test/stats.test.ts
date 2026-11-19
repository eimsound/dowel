// 生成器覆盖面统计（仅在 STATS=1 时运行）：看看随机测试到底测到了什么。
import { plan } from '@dowel/core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { makeVersions, versions } from './gen.ts';

test.runIf(process.env.STATS)('生成器覆盖面', () => {
  const kinds = new Map<string, number>();
  const objs = new Map<string, number>();
  let n = 0;
  let totalObjs = 0;
  let totalSteps = 0;
  fc.assert(
    fc.property(versions, (vs) => {
      const { v1, v2 } = makeVersions(vs);
      const steps = plan(v1, v2);
      n++;
      totalObjs += Object.keys(v2.objects).length;
      totalSteps += steps.length;
      for (const s of steps) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
      for (const o of Object.values(v2.objects)) objs.set(o.kind, (objs.get(o.kind) ?? 0) + 1);
    }),
    { numRuns: 500 },
  );
  console.log(`平均对象数 ${(totalObjs / n).toFixed(1)}，平均迁移步数 ${(totalSteps / n).toFixed(1)}`);
  console.log('对象：', Object.fromEntries([...objs].sort((a, b) => b[1] - a[1])));
  console.log('步骤：', Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])));
  expect(n).toBe(500);
});
