import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addIndex,
  addPrimaryKey,
  addUnique,
  createPartition,
  createSchema,
  createTable,
  dropColumn,
  dropTable,
  EditError,
  emptyModel,
  formatPartitionBound,
  isPartitionChild,
  isPartitionParent,
  type Model,
  parsePartitionBound,
  partitionDepth,
  partitionDescendants,
  partitionKeyColumns,
  partitionsOf,
  PlanError,
  plan,
  readsOf,
  renameColumn,
  resolvePartitionBy,
  rootTableId,
  runMutator,
  setColumnType,
  setPartitionBy,
  type Table,
  validate,
  validatePartitionBound,
} from '../src/index.ts';

const base = () => {
  const m = emptyModel();
  const s = createSchema(m, 'public', 's1');
  return { m, s };
};

describe('partition bound parse / format / validate', () => {
  test('parses and formats DEFAULT, RANGE, LIST, HASH', () => {
    expect(parsePartitionBound('default')).toEqual({ kind: 'default' });
    expect(formatPartitionBound({ kind: 'default' })).toBe('DEFAULT');

    const r = parsePartitionBound("FOR VALUES FROM ('2025-01-01', MINVALUE) TO ('2025-02-01', MAXVALUE)");
    expect(r).toEqual({
      kind: 'range',
      from: ["'2025-01-01'", 'MINVALUE'],
      to: ["'2025-02-01'", 'MAXVALUE'],
    });
    expect(formatPartitionBound(r!)).toBe(
      "FOR VALUES FROM ('2025-01-01', MINVALUE) TO ('2025-02-01', MAXVALUE)",
    );

    const l = parsePartitionBound("for values in ('a,b', 'c''d', 'e(1)')");
    expect(l).toEqual({ kind: 'list', values: ["'a,b'", "'c''d'", "'e(1)'"] });
    expect(formatPartitionBound(l!)).toBe("FOR VALUES IN ('a,b', 'c''d', 'e(1)')");

    const h = parsePartitionBound('FOR VALUES WITH (remainder 2, modulus 4)');
    expect(h).toEqual({ kind: 'hash', modulus: 4, remainder: 2 });
    expect(formatPartitionBound(h!)).toBe('FOR VALUES WITH (modulus 4, remainder 2)');
  });

  test('rejects invalid syntax and strategy mismatches', () => {
    expect(parsePartitionBound('')).toBeNull();
    expect(parsePartitionBound('FOR VALUES FROM (1)')).toBeNull();
    expect(parsePartitionBound('FOR VALUES IN ()')).toBeNull();
    expect(parsePartitionBound('FOR VALUES WITH (modulus 4)')).toBeNull();

    expect(validatePartitionBound('range', 'DEFAULT', 1)).toBeNull();
    expect(validatePartitionBound('list', 'DEFAULT', 1)).toBeNull();
    expect(validatePartitionBound('hash', 'DEFAULT', 1)).not.toBeNull();

    expect(validatePartitionBound('range', 'FOR VALUES FROM (0) TO (10)', 1)).toBeNull();
    expect(validatePartitionBound('range', 'FOR VALUES FROM (0) TO (10)', 2)).not.toBeNull();
    expect(validatePartitionBound('range', 'FOR VALUES FROM (0, 1) TO (10)', 2)).not.toBeNull();
    expect(validatePartitionBound('range', "FOR VALUES IN ('a')", 1)).not.toBeNull();

    expect(validatePartitionBound('list', "FOR VALUES IN ('us', 'eu')", 1)).toBeNull();
    expect(validatePartitionBound('list', 'FOR VALUES FROM (0) TO (10)', 1)).not.toBeNull();

    expect(validatePartitionBound('hash', 'FOR VALUES WITH (modulus 4, remainder 0)', 1)).toBeNull();
    expect(validatePartitionBound('hash', 'FOR VALUES WITH (modulus 0, remainder 0)', 1)).not.toBeNull();
    expect(validatePartitionBound('hash', 'FOR VALUES WITH (modulus 4, remainder 4)', 1)).not.toBeNull();
    expect(validatePartitionBound('hash', 'FOR VALUES WITH (modulus 4, remainder -1)', 1)).not.toBeNull();
  });
});

describe('resolvePartitionBy & partitionKeyColumns', () => {
  test('resolves structured PartitionSpec and legacy string partitionBy', () => {
    const { m, s } = base();
    const t = createTable(m, s, 'events', 't1');
    const c1 = addColumn(m, t, { id: 'c1', name: 'OrderCode', type: 'text', notNull: true });
    const c2 = addColumn(m, t, { id: 'c2', name: 'created_at', type: 'date', notNull: true });
    (m.objects[t] as Table).partitionBy =
      `RANGE ("OrderCode" COLLATE "C" text_pattern_ops, (date_trunc('day', created_at)))`;

    const resolved = resolvePartitionBy(m, m.objects[t] as Table);
    expect(resolved).toEqual({
      strategy: 'range',
      keys: [
        { column: c1, expr: null, collation: '"C"', opclass: 'text_pattern_ops' },
        { column: null, expr: "date_trunc('day', created_at)", collation: null, opclass: null },
      ],
    });
    expect(partitionKeyColumns(m, m.objects[t] as Table)).toEqual({
      direct: [c1],
      expr: [c2],
      all: [c1, c2],
      hasExprKey: true,
    });
  });
});

describe('model helpers & validate(m) partition rules', () => {
  test('helpers: rootTableId, partitionsOf, partitionDescendants, partitionDepth, flags', () => {
    const { m, s } = base();
    const p = createTable(m, s, 'orders', 'p');
    const k1 = addColumn(m, p, { id: 'k1', name: 'yr', type: 'integer', notNull: true });
    const k2 = addColumn(m, p, { id: 'k2', name: 'region', type: 'text', notNull: true });
    setPartitionBy(m, p, {
      strategy: 'range',
      keys: [{ column: k1, expr: null, opclass: null, collation: null }],
    });
    const c1 = createPartition(m, p, 'orders_2025', 'FOR VALUES FROM (2025) TO (2026)', 'c1');
    setPartitionBy(m, c1, {
      strategy: 'list',
      keys: [{ column: k2, expr: null, opclass: null, collation: null }],
    });
    const c11 = createPartition(m, c1, 'orders_2025_us', "FOR VALUES IN ('us')", 'c11');

    expect(isPartitionParent(m.objects[p] as Table)).toBe(true);
    expect(isPartitionChild(m.objects[p] as Table)).toBe(false);
    expect(isPartitionParent(m.objects[c1] as Table)).toBe(true);
    expect(isPartitionChild(m.objects[c1] as Table)).toBe(true);
    expect(isPartitionParent(m.objects[c11] as Table)).toBe(false);
    expect(isPartitionChild(m.objects[c11] as Table)).toBe(true);

    expect(rootTableId(m, p)).toBe(p);
    expect(rootTableId(m, c1)).toBe(p);
    expect(rootTableId(m, c11)).toBe(p);
    expect(partitionDepth(m, p)).toBe(0);
    expect(partitionDepth(m, c1)).toBe(1);
    expect(partitionDepth(m, c11)).toBe(2);
    expect(partitionsOf(m, p).map((t) => t.id)).toEqual([c1]);
    expect(partitionDescendants(m, p).map((t) => t.id)).toEqual([c1, c11]);
    expect(validate(m)).toEqual([]);
  });

  test('validate(m) catches invalid partition structures', () => {
    const { m, s } = base();
    const p = createTable(m, s, 'p', 'p');
    const c1 = addColumn(m, p, { id: 'c1', name: 'a', type: 'integer', notNull: true });
    const c2 = addColumn(m, p, { id: 'c2', name: 'b', type: 'text', notNull: true });
    setPartitionBy(m, p, {
      strategy: 'range',
      keys: [{ column: c1, expr: null, opclass: null, collation: null }],
    });
    const ch = createPartition(m, p, 'p_1', 'FOR VALUES FROM (0) TO (10)', 'ch');

    // Child owning a column is rejected
    const mChildCol: Model = structuredClone(m);
    mChildCol.objects.badCol = {
      id: 'badCol',
      kind: 'column',
      parent: ch,
      name: 'a',
      pos: 'a0',
      type: 'integer',
      typeRef: null,
      notNull: true,
      notNullName: null,
      notNullNameMode: 'derived',
      default: null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    };
    expect(validate(mChildCol).some((e) => e.includes('不能直接拥有列'))).toBe(true);

    // LIST with 2 keys rejected
    const mList2: Model = structuredClone(m);
    (mList2.objects[p] as Table).partitionBy = {
      strategy: 'list',
      keys: [
        { column: c1, expr: null, opclass: null, collation: null },
        { column: c2, expr: null, opclass: null, collation: null },
      ],
    };
    expect(validate(mList2).some((e) => e.includes('LIST'))).toBe(true);

    // Duplicate DEFAULT rejected
    const mDupDef: Model = structuredClone(m);
    createPartition(mDupDef, p, 'p_def1', 'DEFAULT', 'd1');
    mDupDef.objects.d2 = {
      id: 'd2',
      kind: 'table',
      parent: s,
      name: 'p_def2',
      partitionBy: null,
      partitionOf: { parent: p, bound: 'DEFAULT' },
      comment: null,
    };
    expect(validate(mDupDef).some((e) => e.includes('DEFAULT'))).toBe(true);

    // HASH + DEFAULT rejected
    const mHashDef: Model = structuredClone(m);
    (mHashDef.objects[p] as Table).partitionBy = {
      strategy: 'hash',
      keys: [{ column: c1, expr: null, opclass: null, collation: null }],
    };
    (mHashDef.objects[ch] as Table).partitionOf = { parent: p, bound: 'DEFAULT' };
    expect(validate(mHashDef).some((e) => e.includes('HASH'))).toBe(true);

    // Cycle rejected & non-partitioned parent rejected
    const mCycle: Model = structuredClone(m);
    (mCycle.objects[p] as Table).partitionOf = { parent: ch, bound: 'FOR VALUES FROM (0) TO (10)' };
    expect(validate(mCycle).some((e) => e.includes('环引用'))).toBe(true);
    expect(validate(mCycle).some((e) => e.includes('不是分区父表'))).toBe(true);

    // Parent PK missing partition key & CHECK noInherit rejected
    const mBadKey: Model = structuredClone(m);
    mBadKey.objects.pk1 = {
      id: 'pk1',
      kind: 'primaryKey',
      parent: p,
      name: 'p_pkey',
      nameMode: 'derived',
      columns: [c2],
      comment: null,
    };
    mBadKey.objects.ck1 = {
      id: 'ck1',
      kind: 'check',
      parent: p,
      name: 'p_ck',
      nameMode: 'explicit',
      expr: '(a > 0)',
      noInherit: true,
      comment: null,
    };
    const errs = validate(mBadKey);
    expect(errs.some((e) => e.includes('全部分区键列'))).toBe(true);
    expect(errs.some((e) => e.includes('NO INHERIT'))).toBe(true);

    // Legacy string partitionBy model remains valid without false errors
    const mLegacy = emptyModel();
    createSchema(mLegacy, 'public', 's1');
    mLegacy.objects.lp = {
      id: 'lp',
      kind: 'table',
      parent: 's1',
      name: 'legacy_p',
      partitionBy: 'RANGE (k)',
      partitionOf: null,
      comment: null,
    };
    mLegacy.objects.lc = {
      id: 'lc',
      kind: 'column',
      parent: 'lp',
      name: 'k',
      pos: 'a0',
      type: 'integer',
      typeRef: null,
      notNull: true,
      notNullName: null,
      notNullNameMode: 'derived',
      default: null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    };
    mLegacy.objects.lch = {
      id: 'lch',
      kind: 'table',
      parent: 's1',
      name: 'legacy_p_1',
      partitionBy: null,
      partitionOf: { parent: 'lp', bound: 'FOR VALUES FROM (0) TO (10)' },
      comment: null,
    };
    mLegacy.objects.lchCol = {
      id: 'lchCol',
      kind: 'column',
      parent: 'lch',
      name: 'k',
      pos: 'a0',
      type: 'integer',
      typeRef: null,
      notNull: true,
      notNullName: null,
      notNullNameMode: 'derived',
      default: null,
      identity: null,
      generated: null,
      collation: null,
      comment: null,
    };
    expect(validate(mLegacy)).toEqual([]);
  });
});

describe('edit mutators & plan Stage 0 review regression', () => {
  test('mutators enforce PG rules, cascade dropTable, and support attach/detach/rebind', () => {
    const { m, s } = base();
    const p = createTable(m, s, 'logs', 'p');
    const cId = addColumn(m, p, { id: 'cId', name: 'id', type: 'bigint', notNull: true });
    const cDay = addColumn(m, p, { id: 'cDay', name: 'day', type: 'integer', notNull: true });
    const cMsg = addColumn(m, p, { id: 'cMsg', name: 'msg', type: 'text' });

    runMutator(m, 'setPartitionBy', {
      id: p,
      partitionBy: {
        strategy: 'range',
        keys: [{ column: cDay, expr: null, opclass: null, collation: null }],
      },
    });
    expect(() => addPrimaryKey(m, p, [cId])).toThrow(EditError);
    addPrimaryKey(m, p, [cId, cDay], 'pk1');
    expect(() => addUnique(m, p, [cMsg])).toThrow(EditError);
    expect(() => addIndex(m, p, [{ column: cMsg }], { unique: true })).toThrow(EditError);
    addIndex(m, p, [{ column: cMsg }], { unique: false }, 'idx1');
    expect(() => addCheck(m, p, '(day > 0)', 'ckBad', true)).toThrow(EditError);
    addCheck(m, p, '(day > 0)', 'ck1');

    expect(() => setColumnType(m, cDay, 'bigint')).toThrow(EditError);
    expect(() => dropColumn(m, cDay)).toThrow(EditError);

    runMutator(m, 'createPartition', {
      id: 'ch1',
      parent: p,
      name: 'logs_1',
      bound: 'FOR VALUES FROM (0) TO (10)',
    });
    expect(() => addColumn(m, 'ch1', { name: 'extra', type: 'text' })).toThrow(EditError);
    expect(() => setPartitionBy(m, p, null)).toThrow(EditError);
    runMutator(m, 'setPartitionBound', { id: 'ch1', bound: 'FOR VALUES FROM (0) TO (20)' });

    // readsOf includes parent and root columns
    const reads = readsOf(m, { id: 'ch1', bound: 'FOR VALUES FROM (0) TO (30)' });
    expect(reads).toContain('ch1');
    expect(reads).toContain(p);
    expect(reads).toContain(cDay);

    // detach materializes columns & inherited constraints deterministically
    runMutator(m, 'detachPartition', { id: 'ch1' });
    expect((m.objects.ch1 as Table).partitionOf).toBeNull();
    expect(validate(m)).toEqual([]);

    // re-attach cleans up materialized columns & duplicate constraints
    runMutator(m, 'attachPartition', {
      parent: p,
      child: 'ch1',
      bound: 'FOR VALUES FROM (0) TO (20)',
    });
    expect((m.objects.ch1 as Table).partitionOf).toEqual({
      parent: p,
      bound: 'FOR VALUES FROM (0) TO (20)',
    });
    expect(validate(m)).toEqual([]);

    // dropTable cascades child partitions
    dropTable(m, p);
    expect(m.objects[p]).toBeUndefined();
    expect(m.objects.ch1).toBeUndefined();
    expect(validate(m)).toEqual([]);
  });

  test('Stage 0 memo: replacing partition key column with renamed new column still throws PlanError', () => {
    const { m: from, s } = base();
    const p = createTable(from, s, 'events', 'p');
    const c1 = addColumn(from, p, { id: 'c1', name: 'k', type: 'integer', notNull: true });
    const c2 = addColumn(from, p, { id: 'c2', name: 'other', type: 'integer', notNull: true });
    setPartitionBy(from, p, {
      strategy: 'range',
      keys: [{ column: c1, expr: null, opclass: null, collation: null }],
    });

    const to = structuredClone(from);
    // Simulate deleting old column c1 and renaming c2 -> 'k' while rebinding partitionBy to c2
    delete to.objects[c1];
    renameColumn(to, c2, 'k');
    (to.objects[p] as Table).partitionBy = {
      strategy: 'range',
      keys: [{ column: c2, expr: null, opclass: null, collation: null }],
    };

    expect(() => plan(from, to)).toThrow(PlanError);
  });
});
