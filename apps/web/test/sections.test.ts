import type { CanvasSection } from '@dowel/api';
import { emptyModel, type Model, runMutator } from '@dowel/core';
import { describe, expect, test } from 'vitest';

import {
  buildCanvasGroups,
  canvasViewStorageKey,
  collectNeighborhood,
  effectiveCanvasMode,
  LARGE_SCHEMA_THRESHOLD,
  readCanvasViewPrefs,
  suggestSectionsByPrefix,
  UNASSIGNED_GROUP_ID,
  writeCanvasViewPrefs,
} from '../src/sections.ts';

const createModel = () => {
  const m = emptyModel('pg');
  runMutator(m, 'createSchema', { id: 's_public', name: 'public' });
  return m;
};

const addTable = (
  m: Model,
  schemaId: string,
  id: string,
  name: string,
  partitionOf: string | null = null,
) => {
  if (partitionOf) {
    runMutator(m, 'createPartition', {
      id,
      parent: partitionOf,
      name,
      bound: "FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
    });
    return;
  }
  runMutator(m, 'createTable', { id, schema: schemaId, name });
  runMutator(m, 'addColumn', {
    table: id,
    column: { id: `${id}_id`, name: 'id', type: 'bigint', notNull: true },
  });
  runMutator(m, 'addPrimaryKey', { id: `${id}_pk`, table: id, columns: [`${id}_id`] });
};

const addFk = (m: Model, fromTable: string, toTable: string, id: string) => {
  const colId = `${fromTable}_to_${toTable}_col`;
  runMutator(m, 'addColumn', {
    table: fromTable,
    column: { id: colId, name: `ref_${toTable}`, type: 'bigint' },
  });
  runMutator(m, 'addForeignKey', {
    id,
    table: fromTable,
    columns: [colId],
    refTable: toTable,
    refColumns: [`${toTable}_id`],
  });
};

describe('suggestSectionsByPrefix', () => {
  test('按前缀聚合、跳过噪声前缀、单复数合并、排除分区子表和已归属表', () => {
    const m = createModel();
    const pub = 's_public';

    // 应合并为 user（users + user_profiles）
    addTable(m, pub, 't_users', 'users');
    addTable(m, pub, 't_user_profiles', 'user_profiles');
    // 跳过 tbl_ 噪声前缀后归入 order（tbl_orders + order_items）
    addTable(m, pub, 't_orders', 'tbl_orders');
    addTable(m, pub, 't_order_items', 'order_items');
    // 分区父表应参与，分区子表应跳过（否则 t_events_p1 会与 events 同组）
    addTable(m, pub, 't_events', 'events');
    runMutator(m, 'setPartitionBy', {
      id: 't_events',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 't_events_id', expr: null, collation: null, opclass: null }],
      },
    });
    addTable(m, pub, 't_events_p1', 'events_p1', 't_events');
    // 孤立表和纯数字前缀不形成建议板块
    addTable(m, pub, 't_audit', 'audit_log');
    addTable(m, pub, 't_num1', '2025_metrics');
    addTable(m, pub, 't_num2', '2025_events');

    // 已存在的板块覆盖 t_orders：order_items 落单不再成组
    const existing: CanvasSection[] = [
      { id: 'sec-custom', name: '核心交易', color: 'peer-1', tables: ['t_orders'] },
    ];
    const existingSnap = structuredClone(existing);
    const suggested = suggestSectionsByPrefix(m, existing);

    expect(existing).toEqual(existingSnap);
    expect(suggested).toEqual([
      {
        id: 'sec-user',
        name: 'user',
        color: 'peer-2',
        tables: ['t_user_profiles', 't_users'],
      },
    ]);

    // 若 existing 为空，order 和 user 都应出现并按名称排序
    const allSuggested = suggestSectionsByPrefix(m, []);
    expect(allSuggested.map((s) => ({ name: s.name, color: s.color, tables: s.tables }))).toEqual([
      { name: 'order', color: 'peer-1', tables: ['t_order_items', 't_orders'] },
      { name: 'user', color: 'peer-2', tables: ['t_user_profiles', 't_users'] },
    ]);
  });

  test('已有同名 ID 时自动追加数字后缀避免冲突', () => {
    const m = createModel();
    const pub = 's_public';
    addTable(m, pub, 't1', 'billing_invoices');
    addTable(m, pub, 't2', 'billing_payments');
    const existing: CanvasSection[] = [{ id: 'sec-billing', name: '旧账单', color: 'peer-3', tables: [] }];
    const suggested = suggestSectionsByPrefix(m, existing);
    expect(suggested).toHaveLength(1);
    expect(suggested[0]!.id).toBe('sec-billing-2');
    expect(suggested[0]!.color).toBe('peer-2');
  });
});

describe('collectNeighborhood', () => {
  test('无向 1 跳 / 2 跳 BFS（含反向外键、孤立表、分区子表解析、环路与自引用）', () => {
    const m = createModel();
    const pub = 's_public';
    addTable(m, pub, 'a', 'a');
    addTable(m, pub, 'b', 'b');
    addTable(m, pub, 'c', 'c');
    addTable(m, pub, 'd', 'd');
    addTable(m, pub, 'iso', 'iso');

    // 链条：b -> a（反向入边）、b -> c -> d，及 a 自引用
    addFk(m, 'b', 'a', 'fk_ba');
    addFk(m, 'b', 'c', 'fk_bc');
    addFk(m, 'c', 'd', 'fk_cd');
    addFk(m, 'a', 'a', 'fk_aa');

    // 给 c 加分区并建子分区，d 引用该子分区测试分区解析
    runMutator(m, 'setPartitionBy', {
      id: 'c',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'c_id', expr: null, collation: null, opclass: null }],
      },
    });
    addTable(m, pub, 'c_p1', 'c_p1', 'c');

    expect(collectNeighborhood(m, 'a', 1)).toEqual(new Set(['a', 'b']));
    expect(collectNeighborhood(m, 'a', 2)).toEqual(new Set(['a', 'b', 'c']));
    expect(collectNeighborhood(m, 'c_p1', 1)).toEqual(new Set(['b', 'c', 'd']));
    expect(collectNeighborhood(m, 'iso', 2)).toEqual(new Set(['iso']));
    expect(collectNeighborhood(m, 'missing', 1)).toEqual(new Set());
  });
});

describe('buildCanvasGroups & effectiveCanvasMode & viewPrefs', () => {
  test('threshold 边界：<= 100 为 flat，> 100 为 sections', () => {
    expect(LARGE_SCHEMA_THRESHOLD).toBe(100);
    expect(effectiveCanvasMode('auto', 100)).toBe('flat');
    expect(effectiveCanvasMode('auto', 101)).toBe('sections');
    expect(effectiveCanvasMode('sections', 2)).toBe('sections');
    expect(effectiveCanvasMode('flat', 150)).toBe('flat');
  });

  test('有板块时含未归类并计算跨板块外键；无板块时按 Schema 兜底分组', () => {
    const m = createModel();
    const pub = 's_public';
    runMutator(m, 'createSchema', { id: 's_billing', name: 'billing' });
    addTable(m, pub, 't_users', 'users');
    addTable(m, 's_billing', 't_orders', 'orders');
    addTable(m, pub, 't_logs', 'logs');
    addFk(m, 't_orders', 't_users', 'fk_ou');
    addFk(m, 't_logs', 't_orders', 'fk_lo');

    // 无板块：按 Schema 兜底
    const bySchema = buildCanvasGroups(m, []);
    expect(
      bySchema.groups.map((g) => ({ name: g.name, count: g.tableIds.length, fk: g.crossGroupFkCount })),
    ).toEqual([
      { name: 'billing', count: 1, fk: 2 },
      { name: 'public', count: 2, fk: 2 },
    ]);
    expect(bySchema.summaryEdges).toEqual([
      {
        id: `sum-edge:schema:s_billing->schema:${pub}`,
        sourceGroupId: 'schema:s_billing',
        targetGroupId: `schema:${pub}`,
        count: 1,
      },
      {
        id: `sum-edge:schema:${pub}->schema:s_billing`,
        sourceGroupId: `schema:${pub}`,
        targetGroupId: 'schema:s_billing',
        count: 1,
      },
    ]);

    // 有板块：过滤已删表并生成未归类组
    const bySections = buildCanvasGroups(m, [
      { id: 'sec1', name: '核心', color: 'peer-1', tables: ['t_users', 't_deleted'] },
    ]);
    expect(bySections.groups.map((g) => ({ id: g.id, tables: g.tableIds, fk: g.crossGroupFkCount }))).toEqual(
      [
        { id: 'sec1', tables: ['t_users'], fk: 1 },
        { id: UNASSIGNED_GROUP_ID, tables: ['t_logs', 't_orders'], fk: 1 },
      ],
    );
    expect(bySections.summaryEdges).toEqual([
      {
        id: `sum-edge:${UNASSIGNED_GROUP_ID}->sec1`,
        sourceGroupId: UNASSIGNED_GROUP_ID,
        targetGroupId: 'sec1',
        count: 1,
      },
    ]);
  });

  test('localStorage 视图偏好读写与坏数据回退', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    expect(readCanvasViewPrefs('p1', storage)).toEqual({
      sidebarGrouping: 'schema',
      viewMode: 'auto',
      expandedGroups: [],
      focus: null,
    });

    writeCanvasViewPrefs(
      'p1',
      {
        sidebarGrouping: 'section',
        viewMode: 'sections',
        expandedGroups: ['sec1', 'sec2'],
        focus: { tableId: 't1', hops: 2 },
      },
      storage,
    );
    expect(readCanvasViewPrefs('p1', storage)).toEqual({
      sidebarGrouping: 'section',
      viewMode: 'sections',
      expandedGroups: ['sec1', 'sec2'],
      focus: { tableId: 't1', hops: 2 },
    });

    store.set(canvasViewStorageKey('p1'), '{broken json');
    expect(readCanvasViewPrefs('p1', storage)).toEqual({
      sidebarGrouping: 'schema',
      viewMode: 'auto',
      expandedGroups: [],
      focus: null,
    });
  });
});
