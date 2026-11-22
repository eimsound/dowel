import { describe, expect, test } from 'vitest';

import {
  all,
  buildModelIndex,
  clonePlain,
  columnsOf,
  deepEqual,
  emptyModel,
  getActiveModelIndex,
  MutableModelIndex,
  OverlayModelIndex,
  partitionsOf,
  pgDialect,
  runMutator,
  stableJson,
  validate,
  withModelIndex,
  type Column,
  type Model,
  type Obj,
  type Table,
} from '../src/index.ts';

const buildSamplePgModel = (): Model => {
  const m = emptyModel('pg');
  runMutator(m, 'createSchema', { id: 's_app', name: 'app' });
  runMutator(m, 'createTable', { id: 't_users', schema: 's_app', name: 'users' });
  runMutator(m, 'addColumn', {
    table: 't_users',
    column: { id: 'c_uid', name: 'id', type: 'bigint', notNull: true },
  });
  runMutator(m, 'addColumn', {
    table: 't_users',
    column: { id: 'c_uemail', name: 'email', type: 'text', notNull: true },
  });
  runMutator(m, 'setPrimaryKey', { id: 'pk_users', table: 't_users', columns: ['c_uid'] });

  runMutator(m, 'createTable', { id: 't_events', schema: 's_app', name: 'events' });
  runMutator(m, 'addColumn', {
    table: 't_events',
    column: { id: 'c_eid', name: 'id', type: 'bigint', notNull: true },
  });
  runMutator(m, 'addColumn', {
    table: 't_events',
    column: { id: 'c_euid', name: 'user_id', type: 'bigint', notNull: false },
  });
  runMutator(m, 'setPrimaryKey', { id: 'pk_events', table: 't_events', columns: ['c_eid'] });
  runMutator(m, 'setPartitionBy', {
    id: 't_events',
    partitionBy: { strategy: 'range', keys: [{ column: 'c_eid', expr: null }] },
  });
  runMutator(m, 'createPartition', {
    id: 't_events_p1',
    parent: 't_events',
    name: 'events_p1',
    bound: 'FOR VALUES FROM (0) TO (1000)',
  });
  runMutator(m, 'createTable', { id: 't_events_p2', schema: 's_app', name: 'events_p2' });
  runMutator(m, 'addColumn', {
    table: 't_events_p2',
    column: { id: 'c_p2_id', name: 'id', type: 'bigint', notNull: true },
  });
  runMutator(m, 'addForeignKey', {
    id: 'fk_events_user',
    table: 't_events',
    columns: ['c_euid'],
    refTable: 't_users',
    refColumns: ['c_uid'],
  });
  return m;
};

describe('ModelIndex 变更加安全与正确性', () => {
  test('外部直接原地修改 m.objects、删除对象与改属性后，绝无脏索引残留', () => {
    const m = buildSamplePgModel();
    const tables = Object.fromEntries(all(m, 'table').map((t) => [t.name, t])) as Record<string, Table>;
    const events = tables.events!;
    const p1 = tables.events_p1!;
    const p2 = tables.events_p2!;
    const users = tables.users!;

    expect(partitionsOf(m, events.id).map((t) => t.id)).toEqual([p1.id]);

    // 在 withModelIndex 作用域内读取，同时验证离开作用域（含抛错）后立即释放
    expect(() =>
      withModelIndex(m, () => {
        expect(getActiveModelIndex(m)).toBeDefined();
        expect(partitionsOf(m, events.id).map((t) => t.id)).toEqual([p1.id]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(getActiveModelIndex(m)).toBeUndefined();

    // 1. 直接原地修改 table.partitionOf
    (m.objects[p2.id] as Table).partitionOf = {
      parent: events.id,
      bound: 'FOR VALUES FROM (1000) TO (2000)',
    };
    expect(
      partitionsOf(m, events.id)
        .map((t) => t.id)
        .sort(),
    ).toEqual([p1.id, p2.id].sort());

    // 2. 直接原地往 m.objects 插入新对象
    const directColId = 'direct_col_1';
    m.objects[directColId] = {
      id: directColId,
      kind: 'column',
      parent: users.id,
      name: 'nickname',
      pos: 'z0',
      type: 'text',
      typeRef: null,
      notNull: false,
      notNullName: null,
      notNullNameMode: 'derived',
      default: null,
      generated: null,
      identity: null,
      collation: null,
      comment: null,
    };
    expect(columnsOf(m, users.id).map((c) => c.id)).toContain(directColId);

    // 3. 直接原地修改 column.parent（跨表搬家）
    (m.objects[directColId] as Column).parent = events.id;
    expect(columnsOf(m, users.id).map((c) => c.id)).not.toContain(directColId);
    expect(columnsOf(m, events.id).map((c) => c.id)).toContain(directColId);

    // 4. 直接 delete m.objects[id]
    delete m.objects[p1.id];
    expect(partitionsOf(m, events.id).map((t) => t.id)).toEqual([p2.id]);
    expect(all(m, 'table').map((t) => t.id)).not.toContain(p1.id);

    // 5. 直接替换 m.objects 后 validate 必须识别缺失外键目标等破坏
    delete m.objects[users.id];
    expect(validate(m).length).toBeGreaterThan(0);
  });

  test('MutableModelIndex.applyObjectChange 与全量 buildModelIndex 严格一致', () => {
    const m = buildSamplePgModel();
    const idx = new MutableModelIndex(m);
    const tables = Object.fromEntries(all(m, 'table').map((t) => [t.name, t])) as Record<string, Table>;
    const events = tables.events!;
    const p2 = tables.events_p2!;
    const users = tables.users!;

    const assertMatchesFresh = () => {
      const fresh = buildModelIndex(m);
      for (const k of [
        'schema',
        'table',
        'column',
        'primaryKey',
        'unique',
        'foreignKey',
        'index',
        'sequence',
      ] as const) {
        expect(
          idx
            .all(k)
            .map((o) => o.id)
            .sort(),
        ).toEqual(
          fresh
            .all(k)
            .map((o) => o.id)
            .sort(),
        );
      }
      for (const t of fresh.all('table')) {
        expect(idx.columnsOf(t.id).map((c) => c.id)).toEqual(fresh.columnsOf(t.id).map((c) => c.id));
        expect(
          idx
            .partitionsOf(t.id)
            .map((p) => p.id)
            .sort(),
        ).toEqual(
          fresh
            .partitionsOf(t.id)
            .map((p) => p.id)
            .sort(),
        );
        expect(
          idx
            .partitionDescendants(t.id)
            .map((p) => p.id)
            .sort(),
        ).toEqual(
          fresh
            .partitionDescendants(t.id)
            .map((p) => p.id)
            .sort(),
        );
        expect(
          idx
            .childrenOf(t.id, 'foreignKey')
            .map((f) => f.id)
            .sort(),
        ).toEqual(
          fresh
            .childrenOf(t.id, 'foreignKey')
            .map((f) => f.id)
            .sort(),
        );
        expect(
          idx
            .allChildrenOf(t.id)
            .map((c) => c.id)
            .sort(),
        ).toEqual(
          fresh
            .allChildrenOf(t.id)
            .map((c) => c.id)
            .sort(),
        );
      }
      for (const sch of fresh.all('schema')) {
        for (const name of ['events', 'events_p1', 'events_p2', 'users', 'users_pkey', 'nonexistent']) {
          expect(idx.isPgRelTaken(sch.id, name, '')).toBe(fresh.isPgRelTaken(sch.id, name, ''));
          expect(idx.isPgTypeTaken(sch.id, name, '')).toBe(fresh.isPgTypeTaken(sch.id, name, ''));
        }
      }
      for (const t of fresh.all('table')) {
        for (const name of ['users_pkey', 'events_user_id_fkey', 'email_nn']) {
          expect(idx.isPgConTaken(t.id, name, '')).toBe(fresh.isPgConTaken(t.id, name, ''));
        }
      }
    };

    assertMatchesFresh();

    // 增量更新：挂载分区 p2 + 给 users.email 设 identity & notNullName
    const emailCol = columnsOf(m, users.id).find((c) => c.name === 'email')!;
    const prevEmail = clonePlain(emailCol);
    const nextEmail: Column = {
      ...prevEmail,
      notNullName: 'email_nn',
      identity: {
        always: false,
        sequenceName: 'email_seq',
        sequenceNameMode: 'explicit',
        options: {
          type: 'bigint',
          increment: '1',
          min: null,
          max: null,
          start: null,
          cache: '1',
          cycle: false,
        },
      },
    };
    m.objects[emailCol.id] = nextEmail;
    idx.applyObjectChange(emailCol.id, prevEmail, nextEmail);
    assertMatchesFresh();

    const prevP2 = clonePlain(p2);
    const nextP2: Table = {
      ...prevP2,
      partitionOf: { parent: events.id, bound: 'FOR VALUES FROM (1000) TO (2000)' },
    };
    m.objects[p2.id] = nextP2;
    idx.applyObjectChange(p2.id, prevP2, nextP2);
    assertMatchesFresh();

    // 增量删除 p2 与 email
    delete m.objects[p2.id];
    idx.applyObjectChange(p2.id, nextP2, undefined);
    delete m.objects[emailCol.id];
    idx.applyObjectChange(emailCol.id, nextEmail, undefined);
    assertMatchesFresh();
  });

  test('OverlayModelIndex 能正确叠加新增/修改/删除而不修改底层 MutableModelIndex', () => {
    const m = buildSamplePgModel();
    const base = new MutableModelIndex(m);
    const users = all(m, 'table').find((t) => t.name === 'users')!;
    const events = all(m, 'table').find((t) => t.name === 'events')!;
    const p1 = all(m, 'table').find((t) => t.name === 'events_p1')!;
    const draftObjects: Record<string, Obj> = { ...m.objects };
    delete draftObjects[p1.id];
    const extraTable: Table = {
      id: 't_extra',
      kind: 'table',
      parent: users.parent,
      name: 'audit_log',
      partitionBy: null,
      partitionOf: null,
      comment: null,
    };
    draftObjects[extraTable.id] = extraTable;
    const overlayMap = new Map<string, Obj | undefined>([
      [p1.id, undefined],
      [extraTable.id, extraTable],
    ]);
    const overlayIdx = new OverlayModelIndex(base, overlayMap, { ...m, objects: draftObjects });

    expect(overlayIdx.all('table').map((t) => t.id)).toContain('t_extra');
    expect(overlayIdx.all('table').map((t) => t.id)).not.toContain(p1.id);
    expect(overlayIdx.partitionsOf(events.id)).toEqual([]);
    // 底层索引完全未变
    expect(base.partitionsOf(events.id).map((t) => t.id)).toEqual([p1.id]);
    expect(base.all('table').map((t) => t.id)).not.toContain('t_extra');
  });

  test('deepEqual 与 stableJson 语义等价且 clonePlain 可克隆 Proxy', () => {
    const a = { z: 1, a: [1, undefined, { y: 2, x: undefined }] };
    const b = { a: [1, null, { y: 2 }], z: 1, ignored: undefined };
    expect(deepEqual(a, b)).toBe(stableJson(a) === stableJson(b));
    expect(deepEqual({ x: 1 }, { x: 2 })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual({ a: 1 }, [1])).toBe(false);
    expect(deepEqual(NaN, NaN)).toBe(true);

    const proxied = new Proxy({ k: [1, { nested: 'ok' }] }, {});
    const cloned = clonePlain(proxied);
    expect(cloned).toEqual({ k: [1, { nested: 'ok' }] });
    expect(() => structuredClone(cloned)).not.toThrow();
  });

  test('pgDialect validate 与 plan 在 withModelIndex 下前后向规划闭环一致', () => {
    const v1 = buildSamplePgModel();
    expect(() => validate(v1)).not.toThrow();
    const createSteps = pgDialect.plan(emptyModel('pg'), v1);
    expect(createSteps.length).toBeGreaterThan(0);

    const v2 = clonePlain(v1);
    const events = all(v2, 'table').find((t) => t.name === 'events')!;
    runMutator(v2, 'addColumn', {
      table: events.id,
      column: { id: 'c_payload', name: 'payload', type: 'jsonb', notNull: false },
    });
    const diffSteps = pgDialect.plan(v1, v2);
    expect(diffSteps.some((s) => s.sql.includes('ADD COLUMN payload'))).toBe(true);
  });

  test('applyBatch 在 m.objects 原地删表及跨 schema 迁表后绝不残留脏 PG 命名空间索引', () => {
    const m = emptyModel('pg');
    runMutator(m, 'createSchema', { id: 's1', name: 'public' });
    runMutator(m, 'createSchema', { id: 's2', name: 'archive' });
    runMutator(m, 'createTable', { id: 't1', schema: 's1', name: 'orders' });
    runMutator(m, 'addColumn', {
      table: 't1',
      column: {
        id: 'c1',
        name: 'id',
        type: 'bigint',
        notNull: true,
        identity: {
          always: false,
          sequenceName: 'orders_id_seq',
          sequenceNameMode: 'derived',
          options: {
            type: 'bigint',
            increment: '1',
            min: null,
            max: null,
            start: null,
            cache: '1',
            cycle: false,
          },
        },
      },
    });
    runMutator(m, 'setPrimaryKey', { id: 'pk1', table: 't1', columns: ['c1'] });
    runMutator(m, 'addIndex', {
      id: 'idx1',
      table: 't1',
      elements: [{ column: 'c1', expr: null, opclass: null, order: null, nulls: null }],
    });

    const idx = new MutableModelIndex(m);
    // 预热 pgNamespacesReady
    expect(idx.isPgRelTaken('s1', 'orders', '')).toBe(true);
    expect(idx.isPgRelTaken('s1', 'orders_pkey', '')).toBe(true);
    expect(idx.isPgRelTaken('s1', 'orders_id_idx', '')).toBe(true);
    expect(idx.isPgRelTaken('s1', 'orders_id_seq', '')).toBe(true);

    // 1. 先跨 schema 移动表（t1 -> s2）
    const prevT1 = clonePlain(m.objects.t1!);
    const movedT1: Table = { ...(prevT1 as Table), parent: 's2' };
    m.objects.t1 = movedT1;
    idx.applyBatch(m, [{ id: 't1', prev: prevT1, next: movedT1 }]);
    expect(idx.isPgRelTaken('s1', 'orders_pkey', '')).toBe(false);
    expect(idx.isPgRelTaken('s2', 'orders_pkey', '')).toBe(true);
    expect(idx.isPgRelTaken('s2', 'orders_id_idx', '')).toBe(true);
    expect(idx.isPgRelTaken('s2', 'orders_id_seq', '')).toBe(true);

    // 2. 模拟 SyncClient.receive：先原地从 m.objects 删除表与全部子对象（且表 ID 在子对象前面），再调 applyBatch
    const dropIds = ['t1', 'c1', 'pk1', 'idx1'] as const;
    const dropBatch = dropIds.map((id) => {
      const prev = m.objects[id]!;
      delete m.objects[id];
      return { id, prev, next: undefined };
    });
    idx.applyBatch(m, dropBatch);
    expect(idx.isPgRelTaken('s2', 'orders', '')).toBe(false);
    expect(idx.isPgRelTaken('s2', 'orders_pkey', '')).toBe(false);
    expect(idx.isPgRelTaken('s2', 'orders_id_idx', '')).toBe(false);
    expect(idx.isPgRelTaken('s2', 'orders_id_seq', '')).toBe(false);
  });
});
