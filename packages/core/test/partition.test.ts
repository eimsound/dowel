import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addUnique,
  attachPartition,
  type Check,
  type Column,
  childrenOf,
  columnsOf,
  createAll,
  createPartition,
  createSchema,
  createTable,
  detachPartition,
  dropColumn,
  dropKey,
  dropTable,
  EditError,
  emptyModel,
  formatPartitionBound,
  type Index,
  isPartitionChild,
  isPartitionParent,
  type Model,
  type Opaque,
  parsePartitionBound,
  partitionDepth,
  partitionDescendants,
  partitionKeyColumns,
  partitionsOf,
  PlanError,
  plan,
  readsOf,
  renameColumn,
  renameKey,
  renameTable,
  resetKeyName,
  resolvePartitionBy,
  rootTableId,
  runMutator,
  type Sequence,
  setCheckExpr,
  setColumnType,
  setNotNull,
  setPartitionBound,
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

  test('High #2: editing or detaching legacy string partitionBy + child redundant columns upgrades idempotently', () => {
    const buildLegacy = () => {
      const m = emptyModel();
      const s = createSchema(m, 'public', 's1');
      m.objects.lp = {
        id: 'lp',
        kind: 'table',
        parent: s,
        name: 'sales',
        partitionBy: 'RANGE (day)',
        partitionOf: null,
        comment: null,
      };
      m.objects.lp_day = {
        id: 'lp_day',
        kind: 'column',
        parent: 'lp',
        name: 'day',
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
      m.objects.lc = {
        id: 'lc',
        kind: 'table',
        parent: s,
        name: 'sales_1',
        partitionBy: null,
        partitionOf: { parent: 'lp', bound: 'FOR VALUES FROM (0) TO (10)' },
        comment: null,
      };
      m.objects.lc_day = {
        id: 'lc_day',
        kind: 'column',
        parent: 'lc',
        name: 'day',
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
      m.objects.lc_idx = {
        id: 'lc_idx',
        kind: 'index',
        parent: 'lc',
        name: 'sales_1_day_idx',
        nameMode: 'derived',
        unique: false,
        method: 'btree',
        elements: [
          { column: 'lc_day', expr: null, desc: false, nullsFirst: null, opclass: null, collation: null },
        ],
        include: [],
        where: null,
        nullsNotDistinct: false,
        comment: null,
      };
      m.objects.lc_seq = {
        id: 'lc_seq',
        kind: 'sequence',
        parent: s,
        name: 'sales_1_day_seq',
        nameMode: 'explicit',
        ownedBy: 'lc_day',
        options: {
          type: 'bigint',
          increment: '1',
          min: null,
          max: null,
          start: null,
          cache: '1',
          cycle: false,
        },
        comment: null,
      };
      m.objects.lc_view = {
        id: 'lc_view',
        kind: 'opaque',
        parent: s,
        objType: 'view',
        name: 'v_sales_1',
        ddl: ['CREATE VIEW public.v_sales_1 AS SELECT day FROM public.sales_1'],
        drop: 'DROP VIEW public.v_sales_1',
        deps: ['lc', 'lc_day'],
        order: 1,
        comment: null,
      };
      return m;
    };

    // 1. addColumn + renameColumn upgrades legacy model cleanly
    const m1 = buildLegacy();
    addColumn(m1, 'lp', { id: 'lp_note', name: 'note', type: 'text' });
    expect(typeof (m1.objects.lp as Table).partitionBy).toBe('object');
    expect(columnsOf(m1, 'lc')).toEqual([]);
    expect((m1.objects.lc_idx as Index).elements[0]?.column).toBe('lp_day');
    expect((m1.objects.lc_seq as Sequence).ownedBy).toBe('lp_day');
    expect((m1.objects.lc_view as Opaque).deps).toContain('lp_day');
    expect((m1.objects.lc_view as Opaque).deps).not.toContain('lc_day');
    renameColumn(m1, 'lp_day', 'biz_day');
    expect(() => dropColumn(m1, 'lp_day')).toThrow(EditError);
    expect(() => setColumnType(m1, 'lp_day', 'bigint')).toThrow(EditError);
    expect(validate(m1)).toEqual([]);
    expect(createAll(m1).some((st) => st.sql.includes('PARTITION OF'))).toBe(true);

    // 2. detachPartition on legacy model does not create duplicate columns
    const m2 = buildLegacy();
    detachPartition(m2, 'lc');
    expect(columnsOf(m2, 'lc').map((c) => c.name)).toEqual(['day']);
    expect(validate(m2)).toEqual([]);
  });

  test('Medium #5: multi-level unique rules, parent PK vs child PK conflict, and attach CHECK mismatch', () => {
    const { m, s } = base();
    const p = createTable(m, s, 'metrics', 'p');
    const cYr = addColumn(m, p, { id: 'cYr', name: 'yr', type: 'integer', notNull: true });
    const cReg = addColumn(m, p, { id: 'cReg', name: 'region', type: 'text', notNull: true });
    const cVal = addColumn(m, p, { id: 'cVal', name: 'val', type: 'integer', notNull: true });
    setPartitionBy(m, p, {
      strategy: 'range',
      keys: [{ column: cYr, expr: null, opclass: null, collation: null }],
    });
    const c1 = createPartition(m, p, 'metrics_2025', 'FOR VALUES FROM (2025) TO (2026)', 'c1');
    setPartitionBy(m, c1, {
      strategy: 'list',
      keys: [{ column: cReg, expr: null, opclass: null, collation: null }],
    });

    // Root PK/UNIQUE/UNIQUE INDEX must include descendant partition key (cReg)
    expect(() => addPrimaryKey(m, p, [cYr])).toThrow(EditError);
    expect(() => addUnique(m, p, [cYr])).toThrow(EditError);
    expect(() => addIndex(m, p, [{ column: cYr }], { unique: true })).toThrow(EditError);
    addPrimaryKey(m, p, [cYr, cReg], 'pk_root');
    expect(validate(m)).toEqual([]);

    // Changing sub-partition key to an expression breaks ancestor PK
    expect(() =>
      setPartitionBy(m, c1, {
        strategy: 'list',
        keys: [{ column: null, expr: 'lower(region)', opclass: null, collation: null }],
      }),
    ).toThrow(EditError);

    // validate(m) catches invalid multi-level PK directly
    const badMulti = structuredClone(m);
    (badMulti.objects.pk_root as { columns: string[] }).columns = [cYr];
    expect(validate(badMulti).some((e) => e.includes('全部分区键列'))).toBe(true);

    // Parent addPrimaryKey rejects when child already has a local PK
    const { m: mPk, s: sPk } = base();
    const pp = createTable(mPk, sPk, 'orders', 'pp');
    const pId = addColumn(mPk, pp, { id: 'pId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(mPk, pp, {
      strategy: 'range',
      keys: [{ column: pId, expr: null, opclass: null, collation: null }],
    });
    const plainWithPk = createTable(mPk, sPk, 'orders_1', 'plainWithPk');
    const plId = addColumn(mPk, plainWithPk, { id: 'plId', name: 'id', type: 'integer', notNull: true });
    addPrimaryKey(mPk, plainWithPk, [plId], 'pl_pk');
    attachPartition(mPk, pp, plainWithPk, 'FOR VALUES FROM (0) TO (10)');
    expect(() => addPrimaryKey(mPk, pp, [pId])).toThrow(EditError);

    // attachPartition rejects same-name different-expression CHECK
    const { m: mCk, s: sCk } = base();
    const pc = createTable(mCk, sCk, 'items', 'pc');
    const pcId = addColumn(mCk, pc, { id: 'pcId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(mCk, pc, {
      strategy: 'range',
      keys: [{ column: pcId, expr: null, opclass: null, collation: null }],
    });
    const ckParent = addCheck(mCk, pc, '(id > 0)', 'ck_p');
    (mCk.objects[ckParent] as { name: string }).name = 'chk_id';

    const cand = createTable(mCk, sCk, 'items_1', 'cand');
    addColumn(mCk, cand, { id: 'candId', name: 'id', type: 'integer', notNull: true });
    const ckCand = addCheck(mCk, cand, '(id > 10)', 'ck_c');
    (mCk.objects[ckCand] as { name: string }).name = 'chk_id';
    expect(() => attachPartition(mCk, pc, cand, 'FOR VALUES FROM (0) TO (10)')).toThrow(EditError);

    // attachPartition rejects attaching a sub-partitioned table whose key breaks ancestor PK
    const { m: mSub, s: sSub } = base();
    const gp = createTable(mSub, sSub, 'gp', 'gp');
    const gpYr = addColumn(mSub, gp, { id: 'gpYr', name: 'yr', type: 'integer', notNull: true });
    addColumn(mSub, gp, { id: 'gpReg', name: 'region', type: 'text', notNull: true });
    setPartitionBy(mSub, gp, {
      strategy: 'range',
      keys: [{ column: gpYr, expr: null, opclass: null, collation: null }],
    });
    addPrimaryKey(mSub, gp, [gpYr]);
    const sub = createTable(mSub, sSub, 'gp_2025', 'sub');
    addColumn(mSub, sub, { id: 'subYr', name: 'yr', type: 'integer', notNull: true });
    const subReg = addColumn(mSub, sub, { id: 'subReg', name: 'region', type: 'text', notNull: true });
    setPartitionBy(mSub, sub, {
      strategy: 'list',
      keys: [{ column: subReg, expr: null, opclass: null, collation: null }],
    });
    expect(() => attachPartition(mSub, gp, sub, 'FOR VALUES FROM (2025) TO (2026)')).toThrow(EditError);
    void cVal;
  });

  test('Medium #6: plan blocks deleting & re-creating column referenced by expr or legacy string partitionBy', () => {
    // Expression partition key
    const { m: from1, s: s1 } = base();
    const t1 = createTable(from1, s1, 'tags', 't1');
    const c1 = addColumn(from1, t1, { id: 'c1', name: 'code', type: 'text', notNull: true });
    setPartitionBy(from1, t1, {
      strategy: 'list',
      keys: [{ column: null, expr: 'lower(code)', opclass: null, collation: null }],
    });
    const to1 = structuredClone(from1);
    delete to1.objects[c1];
    addColumn(to1, t1, { id: 'c2', name: 'code', type: 'text', notNull: true });
    expect(() => plan(from1, to1)).toThrow(PlanError);

    // Legacy string partitionBy
    const { m: from2, s: s2 } = base();
    const t2 = createTable(from2, s2, 'tags2', 't2');
    const d1 = addColumn(from2, t2, { id: 'd1', name: 'code', type: 'text', notNull: true });
    (from2.objects[t2] as Table).partitionBy = 'LIST (lower(code))';
    const to2 = structuredClone(from2);
    delete to2.objects[d1];
    to2.objects.d2 = { ...structuredClone(from2.objects[d1]!), id: 'd2' };
    expect(() => plan(from2, to2)).toThrow(PlanError);
  });

  test('Low #9: detachPartition remaps schema-level opaque view deps referencing detached child', () => {
    const { m, s } = base();
    const p = createTable(m, s, 'events', 'p');
    const cId = addColumn(m, p, { id: 'cId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(m, p, {
      strategy: 'range',
      keys: [{ column: cId, expr: null, opclass: null, collation: null }],
    });
    const ch = createPartition(m, p, 'events_1', 'FOR VALUES FROM (0) TO (10)', 'ch');
    m.objects.v1 = {
      id: 'v1',
      kind: 'opaque',
      parent: s,
      objType: 'view',
      name: 'v_events_1',
      ddl: ['CREATE VIEW public.v_events_1 AS SELECT id FROM public.events_1'],
      drop: 'DROP VIEW public.v_events_1',
      deps: [ch, cId],
      order: 1,
      comment: null,
    };

    detachPartition(m, ch);
    const detCol = columnsOf(m, ch)[0]!;
    expect((m.objects.v1 as Opaque).deps).toContain(detCol.id);
    expect((m.objects.v1 as Opaque).deps).not.toContain(cId);

    // Dropping root table must NOT delete view that depends only on the detached table
    dropTable(m, p);
    expect(m.objects.v1).toBeDefined();

    // Dropping the detached column DOES cascade-delete the view
    dropColumn(m, detCol.id);
    expect(m.objects.v1).toBeUndefined();
  });

  test('R2 Low #1-#4: duplicate ID guard, dropTable cycle guard, legacy key ops, sibling shared view, and NO INHERIT check attach', () => {
    // Low #1: duplicate ID in createTable / createPartition & cycle guard in dropTable
    const { m, s } = base();
    const p = createTable(m, s, 'p', 'p');
    const cId = addColumn(m, p, { id: 'cId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(m, p, {
      strategy: 'range',
      keys: [{ column: cId, expr: null, opclass: null, collation: null }],
    });
    expect(() => createTable(m, s, 'p2', 'p')).toThrow(EditError);
    expect(() => createPartition(m, p, 'p_self', 'DEFAULT', p)).toThrow(EditError);
    const ch1 = createPartition(m, p, 'p_1', 'FOR VALUES FROM (0) TO (10)', 'ch1');
    const ch2 = createPartition(m, p, 'p_2', 'FOR VALUES FROM (10) TO (20)', 'ch2');

    // Low #3: view shared by ch1 and sibling ch2 retains root col dep after detaching ch1
    m.objects.vShared = {
      id: 'vShared',
      kind: 'opaque',
      parent: s,
      objType: 'view',
      name: 'v_shared',
      ddl: ['CREATE VIEW public.v_shared AS SELECT id FROM public.p_1 UNION ALL SELECT id FROM public.p_2'],
      drop: 'DROP VIEW public.v_shared',
      deps: [ch1, ch2, cId],
      order: 1,
      comment: null,
    };
    detachPartition(m, ch1);
    const detCol = columnsOf(m, ch1)[0]!;
    expect((m.objects.vShared as Opaque).deps).toContain(cId);
    expect((m.objects.vShared as Opaque).deps).toContain(detCol.id);

    // dropTable cycle guard does not stack-overflow
    const mCycle = emptyModel();
    const sc = createSchema(mCycle, 'public', 'sc');
    const a = createTable(mCycle, sc, 'a', 'a');
    const b = createTable(mCycle, sc, 'b', 'b');
    (mCycle.objects[a] as Table).partitionOf = { parent: b, bound: 'DEFAULT' };
    (mCycle.objects[b] as Table).partitionOf = { parent: a, bound: 'DEFAULT' };
    expect(() => dropTable(mCycle, a)).not.toThrow();

    // Low #2: setCheckExpr / renameKey / resetKeyName / dropKey upgrade legacy model
    const mLeg = emptyModel();
    const sl = createSchema(mLeg, 'public', 'sl');
    mLeg.objects.lp = {
      id: 'lp',
      kind: 'table',
      parent: sl,
      name: 'leg',
      partitionBy: 'RANGE (day)',
      partitionOf: null,
      comment: null,
    };
    mLeg.objects.lp_day = {
      id: 'lp_day',
      kind: 'column',
      parent: 'lp',
      name: 'day',
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
    mLeg.objects.lc = {
      id: 'lc',
      kind: 'table',
      parent: sl,
      name: 'leg_1',
      partitionBy: null,
      partitionOf: { parent: 'lp', bound: 'FOR VALUES FROM (0) TO (10)' },
      comment: null,
    };
    mLeg.objects.lc_day = {
      ...structuredClone(mLeg.objects.lp_day),
      id: 'lc_day',
      parent: 'lc',
    };
    mLeg.objects.lc_ck = {
      id: 'lc_ck',
      kind: 'check',
      parent: 'lc',
      name: 'leg_1_day_check',
      nameMode: 'derived',
      expr: '(day > 0)',
      noInherit: false,
      comment: null,
    };
    setCheckExpr(mLeg, 'lc_ck', '(day >= 0)');
    expect(typeof (mLeg.objects.lp as Table).partitionBy).toBe('object');
    expect(columnsOf(mLeg, 'lc')).toEqual([]);
    renameKey(mLeg, 'lc_ck', 'custom_ck');
    resetKeyName(mLeg, 'lc_ck');
    dropKey(mLeg, 'lc_ck');
    expect(validate(mLeg)).toEqual([]);

    // Low #4: attachPartition rejects same-name CHECK with noInherit: true
    const { m: mNi, s: sNi } = base();
    const pNi = createTable(mNi, sNi, 'ni_p', 'pNi');
    const pNiId = addColumn(mNi, pNi, { id: 'pNiId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(mNi, pNi, {
      strategy: 'range',
      keys: [{ column: pNiId, expr: null, opclass: null, collation: null }],
    });
    const pCk = addCheck(mNi, pNi, '(id > 0)', 'pCk');
    (mNi.objects[pCk] as { name: string }).name = 'chk_pos';
    const cNi = createTable(mNi, sNi, 'ni_c', 'cNi');
    addColumn(mNi, cNi, { id: 'cNiId', name: 'id', type: 'integer', notNull: true });
    const cCk = addCheck(mNi, cNi, '(id > 0)', 'cCk', true);
    (mNi.objects[cCk] as { name: string }).name = 'chk_pos';
    expect(() => attachPartition(mNi, pNi, cNi, 'FOR VALUES FROM (0) TO (10)')).toThrow(EditError);
  });

  test('Issue #65 exact reproduction: detach, rename ck1, rename table, re-attach, resetKeyName avoids collision', () => {
    const { m: v1, s } = base();
    const ptA = createTable(v1, s, 'pt_a', 'pt_a');
    const cPk = addColumn(v1, ptA, { id: 'cPk', name: 'pk_key', type: 'integer', notNull: true });
    setPartitionBy(v1, ptA, {
      strategy: 'range',
      keys: [{ column: cPk, expr: null, opclass: null, collation: null }],
    });
    const ck1 = addCheck(v1, ptA, '(pk_key > 0)', 'ck1');
    const ck2 = addCheck(v1, ptA, '(pk_key > 1)', 'ck2');
    const ch = createPartition(v1, ptA, 'pt_a_p_39', 'DEFAULT', 'ch');
    expect((v1.objects[ck1] as Check).name).toBe('pt_a_pk_key_check');
    expect((v1.objects[ck2] as Check).name).toBe('pt_a_pk_key_check1');

    const v2 = structuredClone(v1);
    detachPartition(v2, ch);
    renameKey(v2, ck1, 'k_yyyy');
    renameTable(v2, ch, 'b');
    attachPartition(v2, ptA, ch, 'DEFAULT');
    resetKeyName(v2, ck2);

    expect((v2.objects[ck2] as Check).name).toBe('pt_a_pk_key_check1');
    const childLocalCk = childrenOf(v2, ch, 'check');
    expect(childLocalCk.map((c) => c.name)).toEqual(['pt_a_pk_key_check']);
    expect(validate(v2)).toEqual([]);

    const up = plan(v1, v2);
    const down = plan(v2, v1);
    expect(up.length).toBeGreaterThan(0);
    expect(down.length).toBeGreaterThan(0);
  });

  test('Issue #65 cross-level constraint namespace: renameKey, derived names, attachPartition, and validate', () => {
    const { m, s } = base();
    const ref = createTable(m, s, 'ref', 'ref');
    const refId = addColumn(m, ref, { id: 'refId', name: 'id', type: 'integer', notNull: true });
    addPrimaryKey(m, ref, [refId], 'ref_pk');

    const gp = createTable(m, s, 'gp', 'gp');
    const gpA = addColumn(m, gp, { id: 'gpA', name: 'a', type: 'integer', notNull: true });
    const gpB = addColumn(m, gp, { id: 'gpB', name: 'b', type: 'integer', notNull: true });
    addColumn(m, gp, { id: 'gpC', name: 'c', type: 'integer' });
    setPartitionBy(m, gp, {
      strategy: 'range',
      keys: [{ column: gpA, expr: null, opclass: null, collation: null }],
    });
    const gpPk = addPrimaryKey(m, gp, [gpA, gpB], 'gp_pk');
    const gpCk = addCheck(m, gp, '(c > 0)', 'gp_ck');
    renameKey(m, gpCk, 'anc_ck');
    const gpFk = addForeignKey(m, gp, [gpA], ref, [refId], {}, 'gp_fk');
    renameKey(m, gpFk, 'anc_fk');

    const sub = createPartition(m, gp, 'sub', 'FOR VALUES FROM (0) TO (100)', 'sub');
    setPartitionBy(m, sub, {
      strategy: 'range',
      keys: [{ column: gpB, expr: null, opclass: null, collation: null }],
    });
    const leaf = createPartition(m, sub, 'leaf', 'FOR VALUES FROM (0) TO (100)', 'leaf');

    // Derived CHECK / FK on descendant avoids ancestor CHECK, FK, and root notNullName
    const childCk = addCheck(m, leaf, '(c > 0)', 'leaf_ck');
    renameKey(m, childCk, 'leaf_local_ck');
    const childFk = addForeignKey(m, leaf, [gpB], ref, [refId], {}, 'leaf_fk');
    renameKey(m, childFk, 'leaf_local_fk');
    const childUq = addUnique(m, leaf, [gpA, gpB], false, 'leaf_uq');
    renameKey(m, childUq, 'leaf_local_uq');

    // Child local constraint cannot be renamed to ancestor CHECK, FK, or root notNullName
    const rootNn = (m.objects[gpA] as Column).notNullName!;
    expect(rootNn).toBe('gp_a_not_null');
    for (const target of ['anc_ck', 'anc_fk', rootNn]) {
      expect(() => renameKey(m, childCk, target)).toThrow(EditError);
      expect(() => renameKey(m, childFk, target)).toThrow(EditError);
      expect(() => renameKey(m, childUq, target)).toThrow(EditError);
    }

    // Ancestor CHECK / FK cannot be renamed to grandchild local constraint names
    for (const childTarget of ['leaf_local_ck', 'leaf_local_fk', 'leaf_local_uq']) {
      expect(() => renameKey(m, gpCk, childTarget)).toThrow(EditError);
      expect(() => renameKey(m, gpFk, childTarget)).toThrow(EditError);
    }

    // Parent PK/UNIQUE CAN share name with child local CHECK (PG does not inherit parent PK/UNIQUE conname)
    const mPkOk = structuredClone(m);
    renameKey(mPkOk, gpPk, 'leaf_local_ck');
    expect(validate(mPkOk)).toEqual([]);

    // Derived names automatically avoid cross-level collisions
    const autoCk = addCheck(m, gp, '(b > 0)', 'auto_ck');
    renameKey(m, autoCk, 'leaf_b_check');
    const leafAutoCk = addCheck(m, leaf, '(b >= 0)', 'leaf_auto_ck');
    expect((m.objects[leafAutoCk] as Check).name).toBe('leaf_b_check1');

    const rootCol = addColumn(m, gp, { id: 'gpD', name: 'd', type: 'integer' });
    const leafPreCk = addCheck(m, leaf, '(d IS NULL OR d > 0)', 'leaf_pre_ck');
    renameKey(m, leafPreCk, 'gp_d_not_null');
    setNotNull(m, rootCol, true);
    expect((m.objects[rootCol] as Column).notNullName).toBe('gp_d_not_null1');
    expect(validate(m)).toEqual([]);

    // validate(m) catches manually crafted cross-level collisions (CHECK, FK, root notNullName)
    for (const [label, corrupt] of [
      ['CHECK collision', (c: Model) => ((c.objects[childCk] as Check).name = 'anc_ck')],
      ['FK collision', (c: Model) => ((c.objects[childCk] as Check).name = 'anc_fk')],
      ['notNullName collision', (c: Model) => ((c.objects[childCk] as Check).name = rootNn)],
    ] as const) {
      const bad = structuredClone(m);
      corrupt(bad);
      expect(
        validate(bad).some((e) => e.includes('名字冲突')),
        label,
      ).toBe(true);
    }

    // attachPartition rejects collisions across child and grandchild without mutating model
    const mkSubtree = (kind: 'none' | 'diff_ck' | 'fk_vs_ck' | 'ck_vs_fk' | 'ck_vs_nn') => {
      const m2 = structuredClone(m);
      const cand = createTable(m2, s, 'sub2', 'sub2');
      addColumn(m2, cand, { id: 'ca', name: 'a', type: 'integer', notNull: true });
      const cb = addColumn(m2, cand, { id: 'cb', name: 'b', type: 'integer', notNull: true });
      addColumn(m2, cand, { id: 'cc', name: 'c', type: 'integer' });
      addColumn(m2, cand, { id: 'cd', name: 'd', type: 'integer', notNull: true });
      setPartitionBy(m2, cand, {
        strategy: 'range',
        keys: [{ column: cb, expr: null, opclass: null, collation: null }],
      });
      const gch = createPartition(m2, cand, 'leaf2', 'FOR VALUES FROM (0) TO (10)', 'leaf2');
      const mkCheck = (tid: string, id: string, name: string, expr: string) => {
        const ckId = addCheck(m2, tid, expr, id);
        renameKey(m2, ckId, name);
      };
      mkCheck(cand, 'm_ck1', 'anc_ck', '(c > 0)');
      if (kind !== 'diff_ck' && kind !== 'fk_vs_ck') {
        mkCheck(cand, 'm_ck2', 'leaf_b_check', '(b > 0)');
      }
      mkCheck(gch, 'g_local', 'g_local_ck', '(c < 100)');

      if (kind === 'diff_ck') {
        mkCheck(cand, 'bad_ck', 'leaf_b_check', '(b > 99)');
      } else if (kind === 'fk_vs_ck') {
        const badFk = addForeignKey(m2, cand, [cb], ref, [refId], {}, 'bad_cand_fk');
        renameKey(m2, badFk, 'leaf_b_check');
      } else if (kind === 'ck_vs_fk') {
        mkCheck(gch, 'bad_gch_ck', 'anc_fk', '(c > 5)');
      } else if (kind === 'ck_vs_nn') {
        mkCheck(gch, 'bad_gch_nn', rootNn, '(c > 5)');
      }
      return { m2, cand, gch };
    };

    for (const kind of ['diff_ck', 'fk_vs_ck', 'ck_vs_fk', 'ck_vs_nn'] as const) {
      const { m2, cand } = mkSubtree(kind);
      const snapBefore = structuredClone(m2);
      expect(() => attachPartition(m2, gp, cand, 'FOR VALUES FROM (100) TO (200)'), kind).toThrow(EditError);
      expect(m2, `${kind} leaves model unmutated`).toEqual(snapBefore);
    }

    const { m2: mAttachOk, cand: candOk, gch: gchOk } = mkSubtree('none');
    attachPartition(mAttachOk, gp, candOk, 'FOR VALUES FROM (100) TO (200)');
    expect(childrenOf(mAttachOk, candOk, 'check')).toEqual([]);
    expect(childrenOf(mAttachOk, gchOk, 'check').map((c) => c.name)).toEqual(['g_local_ck']);
    expect(validate(mAttachOk)).toEqual([]);
  });

  test('Issue #71: PG 18+ explicit notNullName collisions in P12h (ancestor FK) and P11/P12d/P12g (child implicit PK/UNIQUE)', () => {
    // 1. P12h ATTACH PARTITION vs ancestor FOREIGN KEY
    const { m: fkFrom, s: fkS } = base();
    const ref = createTable(fkFrom, fkS, 'ref', 'ref');
    const refId = addColumn(fkFrom, ref, { id: 'refId', name: 'id', type: 'integer', notNull: true });
    addPrimaryKey(fkFrom, ref, [refId], 'ref_pk');

    const pFk = createTable(fkFrom, fkS, 'p', 'p');
    const pId = addColumn(fkFrom, pFk, { id: 'pId', name: 'id', type: 'integer', notNull: true });
    addColumn(fkFrom, pFk, { id: 'pVal', name: 'val', type: 'integer', notNull: true });
    setPartitionBy(fkFrom, pFk, {
      strategy: 'range',
      keys: [{ column: pId, expr: null, opclass: null, collation: null }],
    });
    addPrimaryKey(fkFrom, pFk, [pId], 'p_pk');
    const fkObj = addForeignKey(fkFrom, pFk, [pId], ref, [refId], {}, 'p_fk');
    renameKey(fkFrom, fkObj, 'fk_p_ref');

    const plain = createTable(fkFrom, fkS, 'plain', 'plain');
    const plId = addColumn(fkFrom, plain, { id: 'plId', name: 'id', type: 'integer', notNull: true });
    const plVal = addColumn(fkFrom, plain, { id: 'plVal', name: 'val', type: 'integer', notNull: true });
    (fkFrom.objects[plId] as Column).notNullName = 'fk_p_ref';
    (fkFrom.objects[plId] as Column).notNullNameMode = 'explicit';
    (fkFrom.objects[plVal] as Column).notNullName = 'p_id_not_null';
    (fkFrom.objects[plVal] as Column).notNullNameMode = 'explicit';

    const fkTo = structuredClone(fkFrom);
    attachPartition(fkTo, pFk, plain, 'FOR VALUES FROM (0) TO (100)');
    expect(validate(fkFrom)).toEqual([]);
    expect(validate(fkTo)).toEqual([]);

    const fkUp = plan(fkFrom, fkTo, { pgMajor: 18 });
    const fkDown = plan(fkTo, fkFrom, { pgMajor: 18 });
    const attachIdx = fkUp.findIndex((st) => st.kind === 'attachPartition');
    expect(attachIdx).toBeGreaterThanOrEqual(0);
    const preAttach = fkUp.slice(0, attachIdx);
    expect(
      preAttach.some(
        (st) =>
          st.kind === 'rename' &&
          /^ALTER TABLE public\.plain RENAME CONSTRAINT fk_p_ref TO _dowel_tmp_\d+$/.test(st.sql),
      ),
    ).toBe(true);
    expect(preAttach.some((st) => st.kind === 'rename' && st.sql.includes('TO p_id_not_null'))).toBe(true);
    expect(preAttach.some((st) => st.kind === 'rename' && st.sql.includes('TO p_val_not_null'))).toBe(true);
    expect(fkDown.length).toBeGreaterThan(0);

    // 1b. Manual IR where p.id has derived null notNullName (cannot directly rename to rc.notNullName)
    const manualFrom = structuredClone(fkFrom);
    (manualFrom.objects[pId] as Column).notNullName = null;
    (manualFrom.objects[pId] as Column).notNullNameMode = 'derived';
    (manualFrom.objects[plVal] as Column).notNullName = 'plain_val_not_null';
    (manualFrom.objects[plVal] as Column).notNullNameMode = 'derived';
    const manualTo = structuredClone(manualFrom);
    attachPartition(manualTo, pFk, plain, 'FOR VALUES FROM (0) TO (100)');
    expect(validate(manualFrom)).toEqual([]);
    expect(validate(manualTo)).toEqual([]);
    const manualUp = plan(manualFrom, manualTo, { pgMajor: 18 });
    const manualAttachIdx = manualUp.findIndex((st) => st.kind === 'attachPartition');
    expect(manualAttachIdx).toBeGreaterThanOrEqual(0);
    expect(
      manualUp
        .slice(0, manualAttachIdx)
        .some(
          (st) =>
            st.kind === 'rename' &&
            /^ALTER TABLE public\.plain RENAME CONSTRAINT fk_p_ref TO _dowel_tmp_\d+$/.test(st.sql),
        ),
    ).toBe(true);

    // 1c. PG < 18 sanity check: derived notNullNames emit no NOT NULL RENAME CONSTRAINT
    const pg17From = structuredClone(fkFrom);
    (pg17From.objects[plId] as Column).notNullName = 'plain_id_not_null';
    (pg17From.objects[plId] as Column).notNullNameMode = 'derived';
    (pg17From.objects[plVal] as Column).notNullName = 'plain_val_not_null';
    (pg17From.objects[plVal] as Column).notNullNameMode = 'derived';
    const pg17To = structuredClone(pg17From);
    attachPartition(pg17To, pFk, plain, 'FOR VALUES FROM (0) TO (100)');
    expect(plan(pg17From, pg17To, { pgMajor: 17 }).some((st) => st.sql.includes('RENAME CONSTRAINT'))).toBe(
      false,
    );

    // 2A. P11 + P10 new partition vs implicit PK, and P12d + P10 new partition vs implicit UNIQUE
    const { m: impFromA, s: impSA } = base();
    const pA = createTable(impFromA, impSA, 'p', 'pA');
    const aId = addColumn(impFromA, pA, { id: 'aId', name: 'id', type: 'integer', notNull: true });
    const aTag = addColumn(impFromA, pA, { id: 'aTag', name: 'tag', type: 'integer', notNull: true });
    const aVal = addColumn(impFromA, pA, { id: 'aVal', name: 'val', type: 'integer', notNull: false });
    setPartitionBy(impFromA, pA, {
      strategy: 'range',
      keys: [{ column: aId, expr: null, opclass: null, collation: null }],
    });
    addPrimaryKey(impFromA, pA, [aId], 'a_pk');
    addUnique(impFromA, pA, [aId, aTag], false, 'a_uq');

    const impToA = structuredClone(impFromA);
    createPartition(impToA, pA, 'ch', 'DEFAULT', 'ch');
    const aExtra = addColumn(impToA, pA, { id: 'aExtra', name: 'extra', type: 'integer', notNull: true });
    (impToA.objects[aExtra] as Column).notNullName = 'ch_pkey';
    (impToA.objects[aExtra] as Column).notNullNameMode = 'explicit';
    setNotNull(impToA, aVal, true);
    (impToA.objects[aVal] as Column).notNullName = 'ch_id_tag_key';
    (impToA.objects[aVal] as Column).notNullNameMode = 'explicit';
    expect(validate(impFromA)).toEqual([]);
    expect(validate(impToA)).toEqual([]);

    const upA = plan(impFromA, impToA, { pgMajor: 18 });
    const downA = plan(impToA, impFromA, { pgMajor: 18 });
    const createChIdx = upA.findIndex(
      (st) => st.kind === 'createTable' && st.sql.includes('CREATE TABLE public.ch PARTITION OF public.p'),
    );
    const renamePkIdx = upA.findIndex(
      (st) =>
        st.kind === 'rename' && st.sql === 'ALTER TABLE public.ch RENAME CONSTRAINT ch_pkey TO ch_pkey1',
    );
    const addExtraIdx = upA.findIndex(
      (st) =>
        st.kind === 'addColumn' && st.sql.includes('ADD COLUMN extra integer CONSTRAINT ch_pkey NOT NULL'),
    );
    const renameUqIdx = upA.findIndex(
      (st) =>
        st.kind === 'rename' &&
        st.sql === 'ALTER TABLE public.ch RENAME CONSTRAINT ch_id_tag_key TO ch_id_tag_key1',
    );
    const setValNnIdx = upA.findIndex(
      (st) =>
        st.kind === 'setNotNull' &&
        st.sql === 'ALTER TABLE public.p ADD CONSTRAINT ch_id_tag_key NOT NULL val',
    );
    expect(createChIdx).toBeGreaterThanOrEqual(0);
    expect(renamePkIdx).toBeGreaterThan(createChIdx);
    expect(addExtraIdx).toBeGreaterThan(renamePkIdx);
    expect(renameUqIdx).toBeGreaterThan(createChIdx);
    expect(setValNnIdx).toBeGreaterThan(renameUqIdx);
    expect(downA.length).toBeGreaterThan(0);

    // 2B. P12g generated column + P10 new partition vs implicit PK
    const { m: impFromB, s: impSB } = base();
    const pB = createTable(impFromB, impSB, 'p', 'pB');
    const bId = addColumn(impFromB, pB, { id: 'bId', name: 'id', type: 'integer', notNull: true });
    setPartitionBy(impFromB, pB, {
      strategy: 'range',
      keys: [{ column: bId, expr: null, opclass: null, collation: null }],
    });
    addPrimaryKey(impFromB, pB, [bId], 'b_pk');

    const impToB = structuredClone(impFromB);
    createPartition(impToB, pB, 'ch', 'DEFAULT', 'ch');
    const bGen = addColumn(impToB, pB, {
      id: 'bGen',
      name: 'g',
      type: 'integer',
      notNull: true,
      generated: { expr: '(id * 2)', stored: true },
    });
    (impToB.objects[bGen] as Column).notNullName = 'ch_pkey';
    (impToB.objects[bGen] as Column).notNullNameMode = 'explicit';
    expect(validate(impFromB)).toEqual([]);
    expect(validate(impToB)).toEqual([]);

    const upB = plan(impFromB, impToB, { pgMajor: 18 });
    const renamePkB = upB.findIndex(
      (st) =>
        st.kind === 'rename' && st.sql === 'ALTER TABLE public.ch RENAME CONSTRAINT ch_pkey TO ch_pkey1',
    );
    const addGenB = upB.findIndex(
      (st) =>
        st.kind === 'addColumn' &&
        st.sql.includes(
          'ADD COLUMN g integer GENERATED ALWAYS AS ((id * 2)) STORED CONSTRAINT ch_pkey NOT NULL',
        ),
    );
    expect(renamePkB).toBeGreaterThanOrEqual(0);
    expect(addGenB).toBeGreaterThan(renamePkB);

    // 2C. Existing attached child ch in from -> P11 ch_pkey + P12d ch_id_tag_key
    const impFromC = structuredClone(impFromA);
    createPartition(impFromC, pA, 'ch', 'DEFAULT', 'ch');
    const impToC = structuredClone(impFromC);
    const cExtra = addColumn(impToC, pA, { id: 'cExtra', name: 'extra', type: 'integer', notNull: true });
    (impToC.objects[cExtra] as Column).notNullName = 'ch_pkey';
    (impToC.objects[cExtra] as Column).notNullNameMode = 'explicit';
    setNotNull(impToC, aVal, true);
    (impToC.objects[aVal] as Column).notNullName = 'ch_id_tag_key';
    (impToC.objects[aVal] as Column).notNullNameMode = 'explicit';
    expect(validate(impFromC)).toEqual([]);
    expect(validate(impToC)).toEqual([]);

    const upC = plan(impFromC, impToC, { pgMajor: 18 });
    const downC = plan(impToC, impFromC, { pgMajor: 18 });
    const renamePkC = upC.findIndex(
      (st) =>
        st.kind === 'rename' && st.sql === 'ALTER TABLE public.ch RENAME CONSTRAINT ch_pkey TO ch_pkey1',
    );
    const addExtraC = upC.findIndex(
      (st) =>
        st.kind === 'addColumn' && st.sql.includes('ADD COLUMN extra integer CONSTRAINT ch_pkey NOT NULL'),
    );
    const renameUqC = upC.findIndex(
      (st) =>
        st.kind === 'rename' &&
        st.sql === 'ALTER TABLE public.ch RENAME CONSTRAINT ch_id_tag_key TO ch_id_tag_key1',
    );
    const setValNnC = upC.findIndex(
      (st) =>
        st.kind === 'setNotNull' &&
        st.sql === 'ALTER TABLE public.p ADD CONSTRAINT ch_id_tag_key NOT NULL val',
    );
    expect(renamePkC).toBeGreaterThanOrEqual(0);
    expect(addExtraC).toBeGreaterThan(renamePkC);
    expect(renameUqC).toBeGreaterThanOrEqual(0);
    expect(setValNnC).toBeGreaterThan(renameUqC);
    expect(downC.length).toBeGreaterThan(0);

    // 2D. Multi-level gp -> sub -> leaf: rebind sub + P12d gp.val.notNullName = 'leaf_pkey'
    const { m: mlFrom, s: mlS } = base();
    const gpMl = createTable(mlFrom, mlS, 'gp', 'gpMl');
    const gpId = addColumn(mlFrom, gpMl, { id: 'gpId', name: 'id', type: 'integer', notNull: true });
    const gpReg = addColumn(mlFrom, gpMl, { id: 'gpReg', name: 'region', type: 'text', notNull: true });
    const gpVal = addColumn(mlFrom, gpMl, { id: 'gpVal', name: 'val', type: 'integer', notNull: false });
    setPartitionBy(mlFrom, gpMl, {
      strategy: 'range',
      keys: [{ column: gpId, expr: null, opclass: null, collation: null }],
    });
    addPrimaryKey(mlFrom, gpMl, [gpId, gpReg], 'gp_pk');
    const subMl = createPartition(mlFrom, gpMl, 'sub', 'FOR VALUES FROM (0) TO (10)', 'subMl');
    setPartitionBy(mlFrom, subMl, {
      strategy: 'list',
      keys: [{ column: gpReg, expr: null, opclass: null, collation: null }],
    });
    createPartition(mlFrom, subMl, 'leaf', "FOR VALUES IN ('us')", 'leafMl');

    const mlTo = structuredClone(mlFrom);
    setPartitionBound(mlTo, subMl, 'FOR VALUES FROM (0) TO (20)');
    setNotNull(mlTo, gpVal, true);
    (mlTo.objects[gpVal] as Column).notNullName = 'leaf_pkey';
    (mlTo.objects[gpVal] as Column).notNullNameMode = 'explicit';
    expect(validate(mlFrom)).toEqual([]);
    expect(validate(mlTo)).toEqual([]);

    const upD = plan(mlFrom, mlTo, { pgMajor: 18 });
    const dropSubPkIdx = upD.findIndex(
      (st) => st.kind === 'dropPrimaryKey' && st.sql === 'ALTER TABLE public.sub DROP CONSTRAINT sub_pkey',
    );
    const attachSubIdx = upD.findIndex(
      (st) => st.kind === 'attachPartition' && st.sql.includes('ATTACH PARTITION public.sub'),
    );
    expect(dropSubPkIdx).toBeGreaterThanOrEqual(0);
    expect(attachSubIdx).toBeGreaterThan(dropSubPkIdx);
  });
});
