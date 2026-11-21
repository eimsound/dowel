import { describe, expect, test } from 'vitest';

import {
  addCheck,
  addColumn,
  checkPgCompatibility,
  createAll,
  createTable,
  deriveTargetPgMajor,
  emptyModel,
  FORMAT,
  isNontransactionalSql,
  LATEST_PG_MAJOR,
  MIN_PG_MAJOR,
  Model,
  PartitionKey,
  PartitionSpec,
  PartitionStrategy,
  partitionBySql,
  PlanError,
  pgCapabilities,
  pgMajorOf,
  plan,
  renameColumn,
  renameKey,
  SUPPORTED_PG_MAJORS,
  setDefault,
  setNotNull,
  Table,
  type Column,
  type Opaque,
  type Schema,
  type Table as TableType,
} from '../src/index.ts';

const baseModel = () => {
  const m = emptyModel();
  const s: Schema = { id: 's1', kind: 'schema', name: 'public', comment: null };
  m.objects[s.id] = s;
  return m;
};

const makeCol = (overrides: Partial<Column> & Pick<Column, 'id' | 'parent' | 'name'>): Column => ({
  kind: 'column',
  pos: 'a0',
  type: 'integer',
  typeRef: null,
  notNull: false,
  notNullName: null,
  notNullNameMode: 'derived',
  default: null,
  identity: null,
  generated: null,
  collation: null,
  comment: null,
  ...overrides,
});

const makeTable = (overrides: Partial<TableType> & Pick<TableType, 'id' | 'parent' | 'name'>): TableType => ({
  kind: 'table',
  partitionBy: null,
  partitionOf: null,
  comment: null,
  ...overrides,
});

describe('PG version constants & helpers', () => {
  test('constants', () => {
    expect(MIN_PG_MAJOR).toBe(15);
    expect(LATEST_PG_MAJOR).toBe(19);
    expect(SUPPORTED_PG_MAJORS).toEqual([15, 16, 17, 18, 19]);
  });

  test('pgMajorOf parses server_version_num and rejects invalid values', () => {
    expect(pgMajorOf(150000)).toBe(15);
    expect(pgMajorOf(160004)).toBe(16);
    expect(pgMajorOf(170002)).toBe(17);
    expect(pgMajorOf(180000)).toBe(18);
    expect(pgMajorOf(190001)).toBe(19);
    expect(pgMajorOf(140012)).toBe(14);
    expect(pgMajorOf(null)).toBeNull();
    expect(pgMajorOf(undefined)).toBeNull();
    expect(pgMajorOf(0)).toBeNull();
    expect(pgMajorOf(-160000)).toBeNull();
    expect(pgMajorOf(Number.NaN)).toBeNull();
    expect(pgMajorOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(pgMajorOf(16)).toBeNull();
  });

  test('deriveTargetPgMajor picks minimum valid major or null', () => {
    expect(deriveTargetPgMajor([])).toBeNull();
    expect(deriveTargetPgMajor([null, undefined])).toBeNull();
    expect(deriveTargetPgMajor([0, -1, 16.5, Number.NaN])).toBeNull();
    expect(deriveTargetPgMajor([18, null, 15, undefined, 17])).toBe(15);
    expect(deriveTargetPgMajor([19, 18])).toBe(18);
    expect(deriveTargetPgMajor([16])).toBe(16);
  });

  test('pgCapabilities matrix across PG 15–19', () => {
    expect(pgCapabilities(15)).toEqual({
      major: 15,
      nullsNotDistinct: true,
      partitionedIdentity: false,
      partitionedExclusion: false,
      domainNotNullInConstraint: false,
      virtualGenerated: false,
      namedNotNull: false,
      notNullNotValid: false,
      partitionedNotValidConstraint: false,
      uuidv7: false,
      repack: false,
    });

    expect(pgCapabilities(16)).toEqual({
      major: 16,
      nullsNotDistinct: true,
      partitionedIdentity: false,
      partitionedExclusion: false,
      domainNotNullInConstraint: false,
      virtualGenerated: false,
      namedNotNull: false,
      notNullNotValid: false,
      partitionedNotValidConstraint: false,
      uuidv7: false,
      repack: false,
    });

    expect(pgCapabilities(17)).toEqual({
      major: 17,
      nullsNotDistinct: true,
      partitionedIdentity: true,
      partitionedExclusion: true,
      domainNotNullInConstraint: true,
      virtualGenerated: false,
      namedNotNull: false,
      notNullNotValid: false,
      partitionedNotValidConstraint: false,
      uuidv7: false,
      repack: false,
    });

    expect(pgCapabilities(18)).toEqual({
      major: 18,
      nullsNotDistinct: true,
      partitionedIdentity: true,
      partitionedExclusion: true,
      domainNotNullInConstraint: true,
      virtualGenerated: true,
      namedNotNull: true,
      notNullNotValid: true,
      partitionedNotValidConstraint: true,
      uuidv7: true,
      repack: false,
    });

    expect(pgCapabilities(19)).toEqual({
      major: 19,
      nullsNotDistinct: true,
      partitionedIdentity: true,
      partitionedExclusion: true,
      domainNotNullInConstraint: true,
      virtualGenerated: true,
      namedNotNull: true,
      notNullNotValid: true,
      partitionedNotValidConstraint: true,
      uuidv7: true,
      repack: true,
    });
  });
});

describe('checkPgCompatibility', () => {
  test('detects virtual generated, explicit named not null, partitioned identity/exclusion, and uuidv7()', () => {
    const m = baseModel();
    const tPart = makeTable({
      id: 't1',
      parent: 's1',
      name: 'events',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'c1', expr: null, opclass: null, collation: null }],
      },
    });
    m.objects[tPart.id] = tPart;
    m.objects.c1 = makeCol({
      id: 'c1',
      parent: 't1',
      name: 'id',
      notNull: true,
      notNullName: 'events_id_not_null',
      notNullNameMode: 'derived',
      identity: {
        always: false,
        sequenceName: 'events_id_seq',
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
    });
    m.objects.c2 = makeCol({
      id: 'c2',
      parent: 't1',
      name: 'v',
      generated: { expr: 'id + 1', stored: false },
    });
    m.objects.c3 = makeCol({
      id: 'c3',
      parent: 't1',
      name: 'code',
      type: 'text',
      notNull: true,
      notNullName: 'my_nn_constraint',
      notNullNameMode: 'explicit',
    });
    m.objects.c4 = makeCol({
      id: 'c4',
      parent: 't1',
      name: 'uid',
      type: 'uuid',
      default: { expr: 'uuidv7()' },
    });
    const excl: Opaque = {
      id: 'o1',
      kind: 'opaque',
      objType: 'exclusion',
      parent: 't1',
      name: 'events_excl',
      ddl: ['ALTER TABLE public.events ADD CONSTRAINT events_excl EXCLUDE USING gist (id WITH =)'],
      drop: 'ALTER TABLE public.events DROP CONSTRAINT events_excl',
      deps: ['t1', 'c1'],
      order: 1,
      comment: null,
    };
    m.objects[excl.id] = excl;

    // PG 15 & 16: all 5 issues reported
    for (const major of [15, 16]) {
      const issues = checkPgCompatibility(m, major);
      expect(issues.map((i) => [i.code, i.severity, i.minMajor])).toEqual([
        ['partitioned_identity', 'error', 17],
        ['virtual_generated', 'error', 18],
        ['named_not_null', 'error', 18],
        ['uuidv7_expr', 'warning', 18],
        ['partitioned_exclusion', 'error', 17],
      ]);
    }

    // PG 17: partitioned identity & exclusion are allowed; virtual/named_not_null/uuidv7 still reported
    const issues17 = checkPgCompatibility(m, 17);
    expect(issues17.map((i) => [i.code, i.severity, i.minMajor])).toEqual([
      ['virtual_generated', 'error', 18],
      ['named_not_null', 'error', 18],
      ['uuidv7_expr', 'warning', 18],
    ]);

    // PG 18 & 19: zero issues (no false positives)
    expect(checkPgCompatibility(m, 18)).toEqual([]);
    expect(checkPgCompatibility(m, 19)).toEqual([]);
  });

  test('does not false-positive on leaf partition exclusion/identity or similar uuidv7 identifiers', () => {
    const m = baseModel();
    m.objects.tParent = makeTable({ id: 'tParent', parent: 's1', name: 'p', partitionBy: 'RANGE (k)' });
    m.objects.tLeaf = makeTable({
      id: 'tLeaf',
      parent: 's1',
      name: 'p_1',
      partitionOf: { parent: 'tParent', bound: 'FOR VALUES FROM (0) TO (10)' },
    });
    m.objects.cLeaf = makeCol({
      id: 'cLeaf',
      parent: 'tLeaf',
      name: 'id',
      notNull: true,
      identity: {
        always: false,
        sequenceName: 'p_1_id_seq',
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
    });
    m.objects.exclLeaf = {
      id: 'exclLeaf',
      kind: 'opaque',
      objType: 'exclusion',
      parent: 'tLeaf',
      name: 'leaf_excl',
      ddl: ['ALTER TABLE public.p_1 ADD CONSTRAINT leaf_excl EXCLUDE USING gist (id WITH =)'],
      drop: 'ALTER TABLE public.p_1 DROP CONSTRAINT leaf_excl',
      deps: ['tLeaf'],
      order: 1,
      comment: null,
    };
    m.objects.tNorm = makeTable({ id: 'tNorm', parent: 's1', name: 'norm' });
    m.objects.cSafe1 = makeCol({
      id: 'cSafe1',
      parent: 'tNorm',
      name: 'a',
      type: 'text',
      default: { expr: "'uuidv7()'" },
    });
    m.objects.cSafe2 = makeCol({
      id: 'cSafe2',
      parent: 'tNorm',
      name: 'b',
      type: 'uuid',
      default: { expr: 'my_uuidv7()' },
    });
    m.objects.cSafe3 = makeCol({
      id: 'cSafe3',
      parent: 'tNorm',
      name: 'c',
      type: 'uuid',
      default: { expr: 'uuidv7_ext()' },
    });
    m.objects.cSafe4 = makeCol({
      id: 'cSafe4',
      parent: 'tNorm',
      name: 'd',
      type: 'uuid',
      default: { expr: 'public.uuidv7()' },
    });
    m.objects.cHitPgCatalog = makeCol({
      id: 'cHitPgCatalog',
      parent: 'tNorm',
      name: 'e',
      type: 'uuid',
      default: { expr: "pg_catalog.uuidv7('1 hour'::interval)" },
    });

    const issues = checkPgCompatibility(m, 15);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('uuidv7_expr');
    expect(issues[0]!.objectId).toBe('cHitPgCatalog');
  });
});

describe('plan & createAll across PG 15–19', () => {
  test('PG < 18 degrades derived NOT NULL to plain NOT NULL, SET NOT NULL, and skips RENAME CONSTRAINT', () => {
    const from = baseModel();
    const t1 = createTable(from, 's1', 'users', 't1');
    const c1 = addColumn(from, t1, { id: 'c1', name: 'email', type: 'text', notNull: true });
    const c2 = addColumn(from, t1, { id: 'c2', name: 'bio', type: 'text', notNull: false });

    // createAll on PG 16 omits CONSTRAINT "..." NOT NULL
    const create16 = createAll(from, { pgMajor: 16 });
    const createSql16 = create16.find((s) => s.kind === 'createTable')!.sql;
    expect(createSql16).toContain('email text NOT NULL');
    expect(createSql16).not.toContain('CONSTRAINT');

    // createAll on PG 18 & default keeps CONSTRAINT "..." NOT NULL
    const create18 = createAll(from, { pgMajor: 18 });
    const createDefault = createAll(from);
    expect(create18.find((s) => s.kind === 'createTable')!.sql).toContain(
      'email text CONSTRAINT users_email_not_null NOT NULL',
    );
    expect(createDefault).toEqual(create18);

    // Adding NOT NULL + renaming existing NOT NULL column
    const to = structuredClone(from);
    setNotNull(to, c2, true);
    renameColumn(to, c1, 'mail');

    const steps16 = plan(from, to, { pgMajor: 16 });
    expect(steps16.map((s) => s.sql)).toContain('ALTER TABLE public.users ALTER COLUMN bio SET NOT NULL');
    expect(steps16.some((s) => s.sql.includes('ADD CONSTRAINT'))).toBe(false);
    expect(steps16.some((s) => s.sql.includes('RENAME CONSTRAINT'))).toBe(false);

    const steps18 = plan(from, to, { pgMajor: 18 });
    expect(steps18.map((s) => s.sql)).toContain(
      'ALTER TABLE public.users ADD CONSTRAINT users_bio_not_null NOT NULL bio',
    );
    expect(
      steps18.some((s) => s.sql.includes('RENAME CONSTRAINT users_email_not_null TO users_mail_not_null')),
    ).toBe(true);

    // Renaming a check constraint to the old derived notNullName does not hit phantom conflict on PG < 18
    const fromWithCk = structuredClone(from);
    const ck = addCheck(fromWithCk, t1, 'length(email) > 0', 'ck1');
    const toConflict = structuredClone(fromWithCk);
    renameColumn(toConflict, c1, 'mail');
    renameKey(toConflict, ck, 'users_email_not_null');
    const conflictSteps16 = plan(fromWithCk, toConflict, { pgMajor: 16 });
    expect(conflictSteps16.some((s) => s.sql.includes('TO users_email_not_null'))).toBe(true);
    expect(conflictSteps16.some((s) => s.sql.includes('users_mail_not_null'))).toBe(false);
  });

  test('generated columns always emit explicit STORED or VIRTUAL', () => {
    const m = baseModel();
    const t1 = createTable(m, 's1', 'items', 't1');
    addColumn(m, t1, { id: 'c1', name: 'price', type: 'integer' });
    addColumn(m, t1, {
      id: 'c2',
      name: 'total',
      type: 'integer',
      generated: { expr: 'price * 2', stored: true },
    });

    for (const major of SUPPORTED_PG_MAJORS) {
      const sql = createAll(m, { pgMajor: major }).find((s) => s.kind === 'createTable')!.sql;
      expect(sql).toContain('GENERATED ALWAYS AS (price * 2) STORED');
    }

    const mVirt = structuredClone(m);
    (mVirt.objects.c2 as Column).generated = { expr: 'price * 2', stored: false };
    expect(() => createAll(mVirt, { pgMajor: 15 })).toThrow(PlanError);
    expect(() => createAll(mVirt, { pgMajor: 17 })).toThrow(PlanError);
    expect(createAll(mVirt, { pgMajor: 18 }).find((s) => s.kind === 'createTable')!.sql).toContain(
      'GENERATED ALWAYS AS (price * 2) VIRTUAL',
    );
    expect(createAll(mVirt).find((s) => s.kind === 'createTable')!.sql).toContain(
      'GENERATED ALWAYS AS (price * 2) VIRTUAL',
    );
  });

  test('blocks hard-incompatible features with PlanError but allows uuidv7() warning', () => {
    const m = baseModel();
    m.objects.t1 = makeTable({
      id: 't1',
      parent: 's1',
      name: 'orders',
      partitionBy: {
        strategy: 'range',
        keys: [{ column: 'c1', expr: null, opclass: null, collation: null }],
      },
    });
    m.objects.c1 = makeCol({
      id: 'c1',
      parent: 't1',
      name: 'id',
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
    });
    expect(() => createAll(m, { pgMajor: 16 })).toThrow(PlanError);
    expect(() => createAll(m, { pgMajor: 17 })).not.toThrow();

    // Explicit named NOT NULL throws on PG < 18
    const mNamed = baseModel();
    mNamed.objects.t1 = makeTable({ id: 't1', parent: 's1', name: 't' });
    mNamed.objects.c1 = makeCol({
      id: 'c1',
      parent: 't1',
      name: 'x',
      notNull: true,
      notNullName: 'custom_x_nn',
      notNullNameMode: 'explicit',
    });
    expect(() => createAll(mNamed, { pgMajor: 17 })).toThrow(PlanError);
    expect(() => createAll(mNamed, { pgMajor: 18 })).not.toThrow();

    // uuidv7() warning does NOT block plan / createAll
    const mUuid = baseModel();
    const tu = createTable(mUuid, 's1', 'docs', 't1');
    const cu = addColumn(mUuid, tu, { id: 'c1', name: 'id', type: 'uuid' });
    setDefault(mUuid, cu, { expr: 'uuidv7()' });
    expect(() => createAll(mUuid, { pgMajor: 16 })).not.toThrow();
    expect(checkPgCompatibility(mUuid, 16)[0]?.severity).toBe('warning');
  });
});

describe('PartitionSpec IR backwards compatibility & SQL rendering', () => {
  test('parses legacy string, null, and structured PartitionSpec in format 1 Model', () => {
    expect(PartitionStrategy.parse('range')).toBe('range');
    expect(PartitionStrategy.parse('list')).toBe('list');
    expect(PartitionStrategy.parse('hash')).toBe('hash');
    expect(PartitionKey.parse({ column: 'c1' })).toEqual({
      column: 'c1',
      expr: null,
      opclass: null,
      collation: null,
    });
    expect(() => PartitionSpec.parse({ strategy: 'range', keys: [] })).toThrow();

    const legacyTable = Table.parse({
      id: 't1',
      kind: 'table',
      parent: 's1',
      name: 'payment',
      partitionBy: 'RANGE (payment_date)',
    });
    expect(legacyTable.partitionBy).toBe('RANGE (payment_date)');

    const nullTable = Table.parse({ id: 't2', kind: 'table', parent: 's1', name: 'plain' });
    expect(nullTable.partitionBy).toBeNull();

    const structuredModel = Model.parse({
      format: FORMAT,
      dialect: 'pg',
      objects: {
        s1: { id: 's1', kind: 'schema', name: 'public' },
        t1: {
          id: 't1',
          kind: 'table',
          parent: 's1',
          name: 'logs',
          partitionBy: {
            strategy: 'range',
            keys: [
              { column: 'c1', collation: '"C"', opclass: 'text_pattern_ops' },
              { expr: "date_trunc('day', created_at)" },
            ],
          },
        },
        c1: { id: 'c1', kind: 'column', parent: 't1', name: 'OrderCode', pos: 'a0', type: 'text' },
      },
    });

    const t1 = structuredModel.objects.t1 as TableType;
    expect(partitionBySql(structuredModel, t1)).toBe(
      `RANGE ("OrderCode" COLLATE "C" text_pattern_ops, (date_trunc('day', created_at)))`,
    );
    expect(partitionBySql(structuredModel, legacyTable)).toBe('RANGE (payment_date)');
    expect(partitionBySql(structuredModel, nullTable)).toBeNull();

    const createSql = createAll(structuredModel, { pgMajor: 18 }).find((s) => s.kind === 'createTable')!.sql;
    expect(createSql).toContain(
      `PARTITION BY RANGE ("OrderCode" COLLATE "C" text_pattern_ops, (date_trunc('day', created_at)))`,
    );
  });
});

describe('PG 19 REPACK nontransactional detection', () => {
  test.each([
    'REPACK',
    'repack',
    'REPACK (VERBOSE)',
    'REPACK (ANALYZE, VERBOSE)',
    'REPACK (CONCURRENTLY) public.t',
    'REPACK (CONCURRENTLY, VERBOSE) public.t USING INDEX t_pkey',
    'UPDATE t SET a = 1; REPACK',
  ])('%s → 非事务', (sql) => {
    expect(isNontransactionalSql(sql)).toBe(true);
  });

  test.each([
    'REPACK public.t',
    'REPACK public.t USING INDEX t_pkey',
    'REPACK (VERBOSE) public.t',
    "COMMENT ON TABLE t IS 'REPACK'",
    'CREATE TABLE "repack" (id int)',
  ])('%s → 事务内可执行', (sql) => {
    expect(isNontransactionalSql(sql)).toBe(false);
  });
});
