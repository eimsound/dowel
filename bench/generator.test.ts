import { deepEqual, Model as ModelSchema, plan, validate } from '@dowel/core';
import { describe, expect, test } from 'vitest';

import { createSmallChangeVariant, generateLargeSchema } from './generator.ts';

describe('bench/generator', () => {
  test('100 表模型：确定性生成、全量校验通过、对象多样且板块与小改动计划有效', () => {
    const g1 = generateLargeSchema({ tableCount: 100 });
    const g2 = generateLargeSchema({ tableCount: 100 });

    expect(deepEqual(g1.model, g2.model)).toBe(true);
    expect(g1.sections).toEqual(g2.sections);

    expect(() => ModelSchema.parse(g1.model)).not.toThrow();
    expect(validate(g1.model)).toEqual([]);

    expect(g1.stats.schemas).toBe(5);
    expect(g1.stats.enums).toBe(20);
    expect(g1.stats.sequences).toBeGreaterThanOrEqual(10);
    expect(g1.stats.topLevelTables).toBe(100);
    expect(g1.stats.partitionParents).toBeGreaterThanOrEqual(2);
    expect(g1.stats.partitionChildren).toBeGreaterThanOrEqual(6);
    expect(g1.stats.foreignKeys).toBeGreaterThanOrEqual(120);
    expect(g1.stats.indexes).toBeGreaterThanOrEqual(180);
    expect(g1.stats.uniques).toBeGreaterThanOrEqual(40);
    expect(g1.stats.checks).toBeGreaterThanOrEqual(50);

    // 10 个域前缀板块应全覆盖 100 张顶层表且互不重复
    expect(g1.sections).toHaveLength(10);
    const covered = g1.sections.flatMap((s) => s.tables);
    expect(new Set(covered).size).toBe(100);
    expect(covered).toHaveLength(100);

    const variant = createSmallChangeVariant(g1);
    expect(validate(variant.v2)).toEqual([]);
    const steps = plan(g1.model, variant.v2, { pgMajor: 18 });
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  test('1,000 表规模：结构规模命中 Q17 基准区间且邻域聚焦/板块分布合理', () => {
    const g = generateLargeSchema({ tableCount: 1000 });

    expect(g.stats.topLevelTables).toBe(1000);
    expect(g.stats.totalObjects).toBeGreaterThanOrEqual(15_000);
    expect(g.stats.totalObjects).toBeLessThanOrEqual(20_000);
    expect(g.stats.foreignKeys).toBeGreaterThanOrEqual(1_350);
    expect(g.stats.foreignKeys).toBeLessThanOrEqual(1_650);
    expect(g.stats.partitionParents).toBe(20);
    expect(g.stats.partitionChildren).toBe(60);

    expect(g.sections).toHaveLength(10);
    for (const sec of g.sections) {
      expect(sec.tables).toHaveLength(100);
    }

    expect(g.focus1HopCount).toBeGreaterThanOrEqual(3);
    expect(g.focus1HopCount).toBeLessThanOrEqual(25);
    expect(g.focus2HopCount).toBeGreaterThanOrEqual(g.focus1HopCount);
    expect(g.focus2HopCount).toBeLessThanOrEqual(120);
  });
});
