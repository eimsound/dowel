// PostgreSQL serial 家族（serial / bigserial / smallserial）写入展开、IR 派生、规划器、宏、剪贴板与校验单测。
import { describe, expect, test } from 'vitest';

import {
  addColumn,
  type Column,
  copyTables,
  createSchema,
  createSequence,
  createTable,
  dropColumn,
  dropTable,
  EditError,
  emptyModel,
  isPgSerialArrayType,
  MacroError,
  macros,
  type Model,
  normalizeType,
  parseClipboard,
  parsePgSerialType,
  PG_SERIAL_BASE,
  PG_SERIAL_KINDS,
  pgSerialOf,
  plan,
  planPaste,
  renameColumn,
  renameTable,
  runMacro,
  runMutator,
  type Sequence,
  type SequenceOptions,
  serializeClipboard,
  setColumnType,
  setDefault,
  setIdentity,
  setNotNull,
  setSequenceOwnedBy,
  validate,
} from '../src/index.ts';

const col = (m: Model, id: string): Column => m.objects[id] as Column;
const seqsOf = (m: Model): Sequence[] =>
  Object.values(m.objects).filter((o): o is Sequence => o.kind === 'sequence');

const setupPg = (tableName = 't') => {
  const m = emptyModel('pg');
  const s = createSchema(m, 'public', 's1');
  const t = createTable(m, s, tableName, 't1');
  return { m, s, t };
};

const expandMacro = (m: Model, name: string, args: unknown, refs = new Map<string, string>()) => {
  const a = structuredClone(m);
  const b = structuredClone(m);
  const r = runMacro(a, name, args, refs);
  if (r.ops.length) runMutator(b, 'batch', { ops: r.ops });
  expect(a).toEqual(b);
  return { m: a, ops: r.ops, names: r.ops.map((o) => o.name), refs: r.refs };
};

const expectMacroErr = (
  m: Model,
  name: string,
  args: unknown,
  refs = new Map<string, string>(),
): MacroError => {
  try {
    runMacro(structuredClone(m), name, args, refs);
  } catch (e) {
    expect(e).toBeInstanceOf(MacroError);
    expect(e).toBeInstanceOf(EditError);
    return e as MacroError;
  }
  throw new Error('预期抛出 MacroError');
};

describe('pg/serial 纯函数契约', () => {
  test('PG_SERIAL_KINDS 与 PG_SERIAL_BASE 契约', () => {
    expect(PG_SERIAL_KINDS).toEqual(['serial', 'bigserial', 'smallserial']);
    expect(PG_SERIAL_BASE).toEqual({
      serial: 'integer',
      bigserial: 'bigint',
      smallserial: 'smallint',
    });
    expect(normalizeType('serial', 'pg')).toBe('serial');
    expect(normalizeType('BIGSERIAL', 'pg')).toBe('bigserial');
    expect(normalizeType('smallserial', 'pg')).toBe('smallserial');
  });

  test('parsePgSerialType 与 isPgSerialArrayType 正反例', () => {
    expect(parsePgSerialType('serial')).toBe('serial');
    expect(parsePgSerialType('SERIAL4')).toBe('serial');
    expect(parsePgSerialType('  SeRiAl  ')).toBe('serial');
    expect(parsePgSerialType('bigserial')).toBe('bigserial');
    expect(parsePgSerialType('  serial8\t')).toBe('bigserial');
    expect(parsePgSerialType('smallserial')).toBe('smallserial');
    expect(parsePgSerialType('Serial2')).toBe('smallserial');

    for (const neg of [
      '"serial"',
      '"BIGSERIAL"',
      'serial[]',
      'BIGSERIAL [ ]',
      'public.serial',
      'serial(4)',
      'integer',
      'bigint',
      'smallint',
      '',
      'constructor',
      '__proto__',
    ]) {
      expect(parsePgSerialType(neg), neg).toBeNull();
    }

    expect(isPgSerialArrayType('serial[]')).toBe(true);
    expect(isPgSerialArrayType('BIGSERIAL [ ]')).toBe(true);
    expect(isPgSerialArrayType('serial4[][]')).toBe(true);
    expect(isPgSerialArrayType('  smallserial [ ] [ ] ')).toBe(true);
    expect(isPgSerialArrayType('serial')).toBe(false);
    expect(isPgSerialArrayType('"serial"[]')).toBe(false);
    expect(isPgSerialArrayType('public.serial[]')).toBe(false);
    expect(isPgSerialArrayType('integer[]')).toBe(false);
  });

  test('pgSerialOf 三条件派生（正例、逐条反例与手建导入模型）', () => {
    const { m, s, t } = setupPg();
    const idCol = addColumn(m, t, { id: 'c_id', name: 'id', type: 'serial' });
    const bigCol = addColumn(m, t, { id: 'c_big', name: 'big', type: 'bigserial' });
    const smallCol = addColumn(m, t, { id: 'c_small', name: 'small', type: 'smallserial' });

    expect(pgSerialOf(m, col(m, idCol))?.kind).toBe('serial');
    expect(pgSerialOf(m, col(m, bigCol))?.kind).toBe('bigserial');
    expect(pgSerialOf(m, col(m, smallCol))?.kind).toBe('smallserial');

    // 不看 notNull
    setNotNull(m, idCol, false);
    expect(pgSerialOf(m, col(m, idCol))?.kind).toBe('serial');

    // kind 按列类型而非序列自己的 options.type
    const idSeq = pgSerialOf(m, col(m, idCol))!.sequence;
    idSeq.options.type = 'bigint';
    expect(pgSerialOf(m, col(m, idCol))?.kind).toBe('serial');

    // 非 pg 方言
    expect(pgSerialOf({ dialect: 'mysql', objects: m.objects }, col(m, idCol))).toBeNull();

    // 缺失任一条件均为 null
    expect(pgSerialOf(m, { ...col(m, idCol), type: 'text' })).toBeNull();
    expect(pgSerialOf(m, { ...col(m, idCol), typeRef: 'e1' })).toBeNull();
    expect(pgSerialOf(m, { ...col(m, idCol), default: null })).toBeNull();
    expect(pgSerialOf(m, { ...col(m, idCol), default: { expr: '0' } })).toBeNull();

    const otherCol = addColumn(m, t, { id: 'c_other', name: 'other', type: 'integer' });
    const unownedSeq = createSequence(m, s, 'free_seq', { type: 'integer' }, 'seq_free');
    expect(pgSerialOf(m, { ...col(m, idCol), default: { nextval: unownedSeq } })).toBeNull();
    setSequenceOwnedBy(m, unownedSeq, otherCol);
    expect(pgSerialOf(m, { ...col(m, idCol), default: { nextval: unownedSeq } })).toBeNull();

    // 手建“导入风格”模型：explicit 名序列 + ownedBy + nextval
    const imported = emptyModel('pg');
    const is = createSchema(imported, 'public', 'is1');
    const it = createTable(imported, is, 'legacy', 'it1');
    const ic = addColumn(imported, it, { id: 'ic1', name: 'lid', type: 'bigint' });
    const iSeq = createSequence(imported, is, 'custom_legacy_seq', { type: 'bigint' }, 'iseq1');
    setSequenceOwnedBy(imported, iSeq, ic);
    setDefault(imported, ic, { nextval: iSeq });
    const hit = pgSerialOf(imported, col(imported, ic));
    expect(hit?.kind).toBe('bigserial');
    expect(hit?.sequence.id).toBe(iSeq);
  });
});

describe('addColumn serial 展开与边界', () => {
  test.each([
    ['serial', 'integer'],
    ['serial4', 'integer'],
    ['BIGSERIAL', 'bigint'],
    ['serial8', 'bigint'],
    ['  smallserial  ', 'smallint'],
    ['Serial2', 'smallint'],
  ] as const)('%s 展开为 %s + NOT NULL + 推导序列', (raw, expectedBase) => {
    const { m, t } = setupPg();
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: raw });
    const c = col(m, cid);
    expect(c.type).toBe(expectedBase);
    expect(c.notNull).toBe(true);
    expect(c.typeRef).toBeNull();
    const seqs = seqsOf(m);
    expect(seqs).toHaveLength(1);
    const seq = seqs[0]!;
    expect(c.default).toEqual({ nextval: seq.id });
    expect(seq.name).toBe('t_id_seq');
    expect(seq.nameMode).toBe('derived');
    expect(seq.ownedBy).toBe(cid);
    expect(seq.options).toEqual({
      type: expectedBase,
      increment: '1',
      min: null,
      max: null,
      start: null,
      cache: '1',
      cycle: false,
    });
    expect(validate(m)).toEqual([]);
  });

  test('命名冲突与长多字节名截断 ≤ 63 字节', () => {
    const { m, s, t } = setupPg();
    createTable(m, s, 't_id_seq', 't_conflict');
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'serial' });
    expect(pgSerialOf(m, col(m, cid))?.sequence.name).toBe('t_id_seq1');

    const longTbl = createTable(m, s, '表'.repeat(15), 't_long');
    const longCol = addColumn(m, longTbl, { id: 'c_long', name: '列'.repeat(15), type: 'bigserial' });
    const longSeqName = pgSerialOf(m, col(m, longCol))!.sequence.name;
    expect(new TextEncoder().encode(longSeqName).length).toBeLessThanOrEqual(63);
    expect(validate(m)).toEqual([]);
  });

  test('确定性：相同操作在两份克隆上生成完全一致的模型与序列 ID', () => {
    const { m: m1, t: t1 } = setupPg();
    const m2 = structuredClone(m1);
    addColumn(m1, t1, { id: 'col_det', name: 'id', type: 'serial' });
    addColumn(m2, t1, { id: 'col_det', name: 'id', type: 'serial' });
    expect(m1).toEqual(m2);
  });

  test('写入前拒绝不合法组合，失败时模型保持不变', () => {
    const { m, t } = setupPg();
    const before = structuredClone(m);
    expect(() => addColumn(m, t, { name: 'a', type: 'serial', identity: { always: true } })).toThrow(
      'IDENTITY 列不能同时是 serial',
    );
    expect(m).toEqual(before);

    expect(() =>
      addColumn(m, t, { name: 'a', type: 'serial', generated: { expr: '1', stored: true } }),
    ).toThrow('生成列不能改成 serial');
    expect(m).toEqual(before);

    expect(() => addColumn(m, t, { name: 'a', type: 'serial', default: { expr: '0' } })).toThrow(
      '列已有默认值，不能改成 serial，请先清空默认值',
    );
    expect(m).toEqual(before);

    expect(() => addColumn(m, t, { name: 'a', type: 'BIGSERIAL [ ]' })).toThrow('serial 不能用作数组类型');
    expect(m).toEqual(before);
  });

  test('非 PG 方言不展开序列', () => {
    for (const dialect of ['sqlite', 'mysql', 'mssql'] as const) {
      const m = emptyModel(dialect);
      const s = createSchema(m, dialect === 'sqlite' ? 'main' : dialect === 'mysql' ? 'default' : 'dbo', 's');
      const t = createTable(m, s, 'items', 't');
      const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'serial' });
      expect(seqsOf(m)).toEqual([]);
      expect(col(m, cid).default).toBeNull();
    }
  });
});

describe('setColumnType serial 转换、复用、范围裁剪与生命周期', () => {
  test('普通列 → serial；变体切换复用同序列与 ID；切普通类型保留序列与默认值', () => {
    const { m, t } = setupPg();
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'integer' });
    setColumnType(m, cid, 'serial');
    const seq1 = pgSerialOf(m, col(m, cid))!.sequence;
    expect(col(m, cid).notNull).toBe(true);
    expect(seq1.options.type).toBe('integer');

    setColumnType(m, cid, 'bigserial');
    const seq2 = pgSerialOf(m, col(m, cid))!.sequence;
    expect(seq2.id).toBe(seq1.id);
    expect(col(m, cid).type).toBe('bigint');
    expect(seq2.options.type).toBe('bigint');

    setColumnType(m, cid, 'smallserial');
    expect(pgSerialOf(m, col(m, cid))!.sequence.id).toBe(seq1.id);
    expect(col(m, cid).type).toBe('smallint');
    expect(seq2.options.type).toBe('smallint');

    // 同种 serial 幂等：前后深度相等
    const snapBefore = structuredClone(m);
    setColumnType(m, cid, 'SERIAL2');
    expect(m).toEqual(snapBefore);

    // 切普通类型（包括 integer / bigint / text / "serial"）：仅改列类型，不动 default 和序列
    for (const plain of ['integer', 'bigint', 'text', '"serial"']) {
      setColumnType(m, cid, plain);
      expect(col(m, cid).type).toBe(plain);
      expect(col(m, cid).default).toEqual({ nextval: seq1.id });
      expect(seqsOf(m)).toHaveLength(1);
      expect(seqsOf(m)[0]!.options.type).toBe('smallint');
    }
  });

  test('序列缩窄时按 BigInt 裁剪超出新类型的 min/max/start', () => {
    const { m, t } = setupPg();
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'bigserial' });
    const seq = pgSerialOf(m, col(m, cid))!.sequence;

    // 升序：min/max 超出 smallint 范围归 null，且 start=-100 小于归 null 后的默认升序最小 1 → 也归 null
    seq.options.min = '-50000';
    seq.options.max = '9007199254740995'; // > Number.MAX_SAFE_INTEGER
    seq.options.start = '-100';
    setColumnType(m, cid, 'smallserial');
    expect(seq.options).toMatchObject({ type: 'smallint', min: null, max: null, start: null });

    // 降序：max 超范围归 null，start=100 大于归 null 后的默认降序最大 -1 → 归 null
    setColumnType(m, cid, 'bigserial');
    seq.options.increment = '-1';
    seq.options.min = '-30000';
    seq.options.max = '50000';
    seq.options.start = '100';
    setColumnType(m, cid, 'smallserial');
    expect(seq.options).toMatchObject({ type: 'smallint', min: '-30000', max: null, start: null });

    // 在新范围内且满足 [effectiveMin, effectiveMax] 的显式参数保留
    setColumnType(m, cid, 'serial');
    seq.options.increment = '1';
    seq.options.min = '10';
    seq.options.max = '1000';
    seq.options.start = '50';
    setColumnType(m, cid, 'smallserial');
    expect(seq.options).toMatchObject({ type: 'smallint', min: '10', max: '1000', start: '50' });
  });

  test('清空 default 后重新设 serial 复用孤儿归属序列（多序列时按最小 id 确定性选取）', () => {
    const { m, s, t } = setupPg();
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'serial' });
    const seqId = pgSerialOf(m, col(m, cid))!.sequence.id;
    setDefault(m, cid, null);
    expect(pgSerialOf(m, col(m, cid))).toBeNull();

    setColumnType(m, cid, 'bigserial');
    expect(seqsOf(m)).toHaveLength(1);
    expect(pgSerialOf(m, col(m, cid))?.sequence.id).toBe(seqId);
    expect(pgSerialOf(m, col(m, cid))?.sequence.name).toBe('t_id_seq');

    // 多个孤儿归属序列时选最小 id
    setDefault(m, cid, null);
    const zSeq = createSequence(m, s, 'z_extra', { type: 'integer' }, '00000000-0000-0000-0000-000000000001');
    setSequenceOwnedBy(m, zSeq, cid);
    setColumnType(m, cid, 'smallserial');
    expect(pgSerialOf(m, col(m, cid))?.sequence.id).toBe(zSeq);
  });

  test('setColumnType 拒绝已有非归属默认 / identity / generated / array', () => {
    const { m, s, t } = setupPg();
    const cExpr = addColumn(m, t, { id: 'c_expr', name: 'e', type: 'integer', default: { expr: '1' } });
    const sharedSeq = createSequence(m, s, 'shared_seq', { type: 'integer' }, 'shared');
    const cShared = addColumn(m, t, {
      id: 'c_sh',
      name: 'sh',
      type: 'integer',
      default: { nextval: sharedSeq },
    });
    const cId = addColumn(m, t, { id: 'c_id', name: 'id2', type: 'integer', identity: { always: true } });
    const cGen = addColumn(m, t, {
      id: 'c_gen',
      name: 'g',
      type: 'integer',
      generated: { expr: '1', stored: true },
    });

    const snap = structuredClone(m);
    expect(() => setColumnType(m, cExpr, 'serial')).toThrow('列已有默认值，不能改成 serial，请先清空默认值');
    expect(() => setColumnType(m, cShared, 'serial')).toThrow(
      '列已有默认值，不能改成 serial，请先清空默认值',
    );
    expect(() => setColumnType(m, cId, 'serial')).toThrow(
      'IDENTITY 列不能改成 serial，请先取消自增（IDENTITY）',
    );
    expect(() => setColumnType(m, cGen, 'serial')).toThrow('生成列不能改成 serial');
    expect(() => setColumnType(m, cExpr, 'serial[]')).toThrow('serial 不能用作数组类型');
    expect(m).toEqual(snap);
  });

  test('renameTable / renameColumn 同步重命名推导序列；dropColumn / dropTable 同步删序列', () => {
    const { m, t } = setupPg('users');
    const cid = addColumn(m, t, { id: 'c1', name: 'id', type: 'serial' });
    const seqId = pgSerialOf(m, col(m, cid))!.sequence.id;
    expect(col(m, cid)).toBeDefined();
    expect(m.objects[seqId]).toMatchObject({ name: 'users_id_seq' });

    renameColumn(m, cid, 'uid');
    expect(m.objects[seqId]).toMatchObject({ name: 'users_uid_seq' });

    renameTable(m, t, 'accounts');
    expect(m.objects[seqId]).toMatchObject({ name: 'accounts_uid_seq' });

    const mDropCol = structuredClone(m);
    dropColumn(mDropCol, cid);
    expect(mDropCol.objects[seqId]).toBeUndefined();

    dropTable(m, t);
    expect(m.objects[seqId]).toBeUndefined();
  });
});

describe('PG 规划器：serial DDL 与 alterSequence START WITH 修复', () => {
  test('从空 schema 建表与 serial → bigserial 迁移 SQL', () => {
    const empty = emptyModel('pg');
    createSchema(empty, 'public', 's1');

    const m1 = structuredClone(empty);
    const t = createTable(m1, 's1', 't', 't1');
    const cid = addColumn(m1, t, { id: 'c1', name: 'id', type: 'serial' });

    const createSteps = plan(empty, m1);
    const createSeqSql = createSteps.find((s) => s.kind === 'createSequence')?.sql;
    const createTblSql = createSteps.find((s) => s.kind === 'createTable')?.sql;
    const ownedSql = createSteps.find((s) => s.kind === 'sequenceOwnedBy')?.sql;
    expect(createSeqSql).toContain('CREATE SEQUENCE public.t_id_seq AS integer');
    expect(createTblSql).toContain("DEFAULT nextval('public.t_id_seq'::regclass)");
    expect(createTblSql).toContain('NOT NULL');
    expect(ownedSql).toContain('ALTER SEQUENCE public.t_id_seq OWNED BY public.t.id');

    const m2 = structuredClone(m1);
    setColumnType(m2, cid, 'bigserial');
    const migSteps = plan(m1, m2);
    expect(migSteps.find((s) => s.kind === 'alterSequence')?.sql).toContain(
      'ALTER SEQUENCE public.t_id_seq AS bigint',
    );
    expect(migSteps.find((s) => s.kind === 'alterType')?.sql).toContain('TYPE bigint');
  });

  test('alterSequence 当目标 start 为 null 且原 start 非空或类型变化时输出 START WITH', () => {
    const base = emptyModel('pg');
    const s = createSchema(base, 'public', 's1');
    createSequence(
      base,
      s,
      'big_s',
      { type: 'bigint', start: '1000000000000', increment: '1', min: null, max: null },
      'q1',
    );

    // 缩窄 bigint → integer 且 start 归 null：必须发射 START WITH 1，否则 PG 保留超大 seqstart 报错
    const shrunk = structuredClone(base);
    const qs = shrunk.objects.q1 as Sequence;
    qs.options.type = 'integer';
    qs.options.start = null;
    expect(plan(base, shrunk).map((st) => st.sql)).toEqual([
      'ALTER SEQUENCE public.big_s AS integer INCREMENT BY 1 NO MINVALUE NO MAXVALUE START WITH 1 CACHE 1 NO CYCLE',
    ]);

    // 同类型仅清空 start：有 min 时输出 START WITH <min>
    const sameTypeWithMin = emptyModel('pg');
    const s2 = createSchema(sameTypeWithMin, 'public', 's1');
    createSequence(sameTypeWithMin, s2, 'min_s', { type: 'integer', min: '10', start: '50' }, 'q2');
    const clearedStart = structuredClone(sameTypeWithMin);
    (clearedStart.objects.q2 as Sequence).options.start = null;
    expect(plan(sameTypeWithMin, clearedStart)[0]!.sql).toContain('MINVALUE 10 NO MAXVALUE START WITH 10');

    // 降序序列：输出 START WITH -1（或有 max 时 START WITH <max>）
    const descFrom = emptyModel('pg');
    const s3 = createSchema(descFrom, 'public', 's1');
    createSequence(descFrom, s3, 'desc_s', { type: 'bigint', increment: '-1', start: '-100' }, 'q3');
    const descTo = structuredClone(descFrom);
    (descTo.objects.q3 as Sequence).options.type = 'integer';
    (descTo.objects.q3 as Sequence).options.start = null;
    expect(plan(descFrom, descTo)[0]!.sql).toContain('START WITH -1');

    const descMaxFrom = emptyModel('pg');
    const s3b = createSchema(descMaxFrom, 'public', 's1');
    createSequence(
      descMaxFrom,
      s3b,
      'desc_max_s',
      { type: 'integer', increment: '-1', max: '-10', start: '-100' },
      'q3b',
    );
    const descMaxTo = structuredClone(descMaxFrom);
    (descMaxTo.objects.q3b as Sequence).options.start = null;
    expect(plan(descMaxFrom, descMaxTo)[0]!.sql).toContain('MAXVALUE -10 START WITH -10');

    // 类型不变且前后 start 均为 null，只改 cache 时不额外输出 START WITH
    const cacheFrom = emptyModel('pg');
    const s4 = createSchema(cacheFrom, 'public', 's1');
    createSequence(cacheFrom, s4, 'cache_s', { type: 'integer', start: null, cache: '1' }, 'q4');
    const cacheTo = structuredClone(cacheFrom);
    (cacheTo.objects.q4 as Sequence).options.cache = '10';
    expect(plan(cacheFrom, cacheTo)[0]!.sql).not.toContain('START WITH');
  });

  // PG 省略 START WITH 会保留旧 seqstart：前后 start 都为 null 时，min/max/递增方向改变默认起始值也必须补发
  const alterSeqSql = (opts: Partial<SequenceOptions>, patch: Partial<SequenceOptions>): string => {
    const from = emptyModel('pg');
    createSequence(from, createSchema(from, 'public', 's1'), 'x', { type: 'integer', ...opts }, 'q');
    const to = structuredClone(from);
    Object.assign((to.objects.q as Sequence).options, patch);
    const steps = plan(from, to);
    expect(steps.map((st) => st.kind)).toEqual(['alterSequence']);
    return steps[0]!.sql;
  };

  test.each<[string, Partial<SequenceOptions>, Partial<SequenceOptions>, string | null]>([
    ['升序 min null → 10', {}, { min: '10' }, '10'],
    ['升序 min 10 → null', { min: '10' }, { min: null }, '1'],
    ['递增方向 1 → -1', {}, { increment: '-1' }, '-1'],
    ['递增方向 -1 → 1', { increment: '-1' }, { increment: '1' }, '1'],
    ['递增方向翻转且有显式 min/max', { min: '-100', max: '100' }, { increment: '-1' }, '100'],
    ['降序 max -5 → -20', { increment: '-1', max: '-5' }, { max: '-20' }, '-20'],
    ['降序 max -5 → null', { increment: '-1', max: '-5' }, { max: null }, '-1'],
    ['显式 start 清空为 null', { min: '10', start: '50' }, { start: null }, '10'],
    ['显式 start 清空且恰好等于默认值', { start: '1' }, { start: null, cache: '5' }, null],
    [
      'bigint → integer 缩窄且显式 start 清空',
      { type: 'bigint', start: '5000000000' },
      { type: 'integer', start: null },
      '1',
    ],
    ['仅类型缩窄，有效起始值不变', { type: 'bigint' }, { type: 'integer' }, null],
    ['升序 max 变化不影响默认起始值', {}, { max: '1000' }, null],
    ['降序 min 变化不影响默认起始值', { increment: '-1' }, { min: '-1000' }, null],
    ['同方向改步长', {}, { increment: '5' }, null],
    ['目标显式 start 原样输出', {}, { min: '10', start: '20' }, '20'],
  ])('alterSequence START WITH：%s', (_, opts, patch, start) => {
    const sql = alterSeqSql(opts, patch);
    if (start === null) expect(sql).not.toContain('START WITH');
    else expect(sql).toContain(` START WITH ${start} CACHE`);
  });

  test('identity 列改选项同样按有效起始值补发 SET START WITH', () => {
    const { m: from, t } = setupPg();
    const cid = addColumn(from, t, { id: 'c1', name: 'id', type: 'integer', notNull: true });
    setIdentity(from, cid, { always: false });
    const alterIdentity = (patch: Partial<SequenceOptions>) => {
      const to = structuredClone(from);
      Object.assign(col(to, cid).identity!.options, patch);
      return plan(from, to).find((st) => st.kind === 'alterIdentity')!.sql;
    };
    expect(alterIdentity({ min: '10' })).toContain('SET MINVALUE 10');
    expect(alterIdentity({ min: '10' })).toContain('SET START WITH 10');
    expect(alterIdentity({ increment: '-1' })).toContain('SET START WITH -1');
    expect(alterIdentity({ cache: '10' })).not.toContain('START WITH');
  });
});

describe('全部写入入口：runMutator / paste / batch / 剪贴板 / MCP 宏', () => {
  test('runMutator / paste / batch 均正确展开 serial', () => {
    const { m, t } = setupPg();
    runMutator(m, 'addColumn', { table: t, column: { id: 'c1', name: 'id', type: 'serial' } });
    expect(pgSerialOf(m, col(m, 'c1'))?.kind).toBe('serial');
    runMutator(m, 'setColumnType', { id: 'c1', type: 'bigserial', typeRef: null });
    expect(pgSerialOf(m, col(m, 'c1'))?.kind).toBe('bigserial');

    const mPaste = emptyModel('pg');
    createSchema(mPaste, 'public', 's1');
    runMutator(mPaste, 'paste', {
      ops: [
        { name: 'createTable', args: { id: 't_p', schema: 's1', name: 'orders' } },
        { name: 'addColumn', args: { table: 't_p', column: { id: 'c_p', name: 'id', type: 'smallserial' } } },
      ],
    });
    expect(pgSerialOf(mPaste, col(mPaste, 'c_p'))?.kind).toBe('smallserial');

    const mBatch = emptyModel('pg');
    createSchema(mBatch, 'public', 's1');
    runMutator(mBatch, 'batch', {
      ops: [
        { name: 'createTable', args: { id: 't_b', schema: 's1', name: 'logs' } },
        { name: 'addColumn', args: { table: 't_b', column: { id: 'c_b', name: 'id', type: 'serial4' } } },
      ],
    });
    expect(pgSerialOf(mBatch, col(mBatch, 'c_b'))?.kind).toBe('serial');
  });

  test('剪贴板载荷手造 type: serial 时预占 <table>_<col>_seq，避免与同批表重名冲突', () => {
    const src = emptyModel('pg');
    const s = createSchema(src, 'public', 's');
    const t = createTable(src, s, 'items', 't');
    addColumn(src, t, { id: 'c1', name: 'id', type: 'integer' });
    const conflictTbl = createTable(src, s, 'items_id_seq', 't_seq_name');
    addColumn(src, conflictTbl, { id: 'c2', name: 'v', type: 'text' });

    const payload = parseClipboard(
      serializeClipboard(
        copyTables(src, [t, conflictTbl], {
          source: { projectId: null, projectName: null, origin: 'canvas', seq: null },
        }),
      ),
    )!;
    // 模拟外部/手写载荷中携带 serial 原文
    for (const o of Object.values(payload.fragment)) {
      if (o.kind === 'column' && o.name === 'id') o.type = 'serial';
    }

    const target = emptyModel('pg');
    createSchema(target, 'public', 's_tgt');
    const planRes = planPaste(target, payload);
    runMutator(target, 'paste', { ops: planRes.ops });
    expect(validate(target)).toEqual([]);
    const names = Object.values(target.objects)
      .filter((o) => o.kind === 'table' || o.kind === 'sequence')
      .map((o) => `${o.kind}:${o.name}`)
      .sort();
    expect(names).toEqual(['sequence:items_id_seq', 'table:items', 'table:items_id_seq_copy']);
  });

  test('MCP defineTable 与 serial 主键列、与 batch 等价及校验错误', () => {
    const { m } = setupPg('existing');
    const res = expandMacro(m, 'defineTable', {
      name: 'users',
      columns: [
        { id: '$ref:uid', name: 'id', type: 'SERIAL4' },
        { name: 'email', type: 'text' },
      ],
      primaryKey: { columns: ['id'] },
    });
    const uid = res.refs.get('uid')!;
    expect(pgSerialOf(res.m, col(res.m, uid))?.kind).toBe('serial');
    expect(pgSerialOf(res.m, col(res.m, uid))?.sequence.name).toBe('users_id_seq');
    expect(validate(res.m)).toEqual([]);

    expect(
      expectMacroErr(m, 'defineTable', {
        name: 'bad',
        columns: [{ name: 'id', type: 'serial', default: { expr: '1' } }],
      }),
    ).toMatchObject({ path: 'columns[0]', rawMessage: 'serial 列不能有默认值' });
    expect(
      expectMacroErr(m, 'defineTable', {
        name: 'bad',
        columns: [{ name: 'id', type: 'serial', notNull: false }],
      }),
    ).toMatchObject({ path: 'columns[0]', rawMessage: 'serial 列必须 NOT NULL' });
    expect(
      expectMacroErr(m, 'defineTable', {
        name: 'bad',
        columns: [{ name: 'id', type: 'serial', identity: { always: true } }],
      }),
    ).toMatchObject({ path: 'columns[0]', rawMessage: 'serial 列不能同时是 identity' });
    expect(
      expectMacroErr(m, 'defineTable', {
        name: 'bad',
        columns: [{ name: 'id', type: 'serial', generated: { expr: '1', stored: true } }],
      }),
    ).toMatchObject({ path: 'columns[0]', rawMessage: 'serial 列不能同时是生成列' });
    expect(
      expectMacroErr(m, 'defineTable', {
        name: 'bad',
        columns: [{ name: 'id', type: 'serial[]' }],
      }),
    ).toMatchObject({ path: 'columns[0].type', rawMessage: 'serial 不能用作数组类型' });
  });

  test('MCP alterColumn：幂等跳过、变体切换、清除 identity/default 后转 serial 及错误拦截', () => {
    const { m, t } = setupPg();
    const cPlain = addColumn(m, t, { id: 'c_plain', name: 'p', type: 'integer' });
    const cId = addColumn(m, t, { id: 'c_id', name: 'ident', type: 'integer', identity: { always: true } });

    // 普通列 → serial
    const r1 = expandMacro(m, 'alterColumn', { id: cPlain, type: 'serial' });
    expect(r1.names).toEqual(['setColumnType']);
    expect(pgSerialOf(r1.m, col(r1.m, cPlain))?.kind).toBe('serial');

    // 同种 serial 幂等跳过（0 展开）
    expect(expandMacro(r1.m, 'alterColumn', { id: cPlain, type: 'SERIAL4' }).ops).toEqual([]);

    // 非完全一致的 serial（如 notNull 为 false）仍需发射 setColumnType 修复
    const needsFix = structuredClone(r1.m);
    setNotNull(needsFix, cPlain, false);
    const fixed = expandMacro(needsFix, 'alterColumn', { id: cPlain, type: 'serial' });
    expect(fixed.names).toEqual(['setColumnType']);
    expect(col(fixed.m, cPlain).notNull).toBe(true);

    // 切换变体 → bigserial，再切回普通 integer（只改列类型，不动 default 和 sequence）
    const r2 = expandMacro(r1.m, 'alterColumn', { id: cPlain, type: 'bigserial' });
    expect(r2.names).toEqual(['setColumnType']);
    expect(pgSerialOf(r2.m, col(r2.m, cPlain))?.kind).toBe('bigserial');

    const r3 = expandMacro(r2.m, 'alterColumn', { id: cPlain, type: 'integer' });
    expect(r3.names).toEqual(['setColumnType']);
    expect(col(r3.m, cPlain).type).toBe('integer');
    expect(col(r3.m, cPlain).default).not.toBeNull();

    // { identity: null, type: 'serial' } 在单次调用内先清 identity 再转 serial
    const rId = expandMacro(r1.m, 'alterColumn', { id: cId, identity: null, type: 'serial' });
    expect(rId.names).toEqual(['setIdentity', 'setColumnType']);
    expect(pgSerialOf(rId.m, col(rId.m, cId))?.kind).toBe('serial');

    // { default: null, type: 'bigserial' } 先清 default 再复用归属序列
    const seqBefore = pgSerialOf(r1.m, col(r1.m, cPlain))!.sequence.id;
    const rDef = expandMacro(r1.m, 'alterColumn', { id: cPlain, default: null, type: 'bigserial' });
    expect(rDef.names).toEqual(['setDefault', 'setColumnType']);
    expect(pgSerialOf(rDef.m, col(rDef.m, cPlain))?.sequence.id).toBe(seqBefore);

    // 枚举列名为 serial 且仅调整数组维度时不被误判
    const s = Object.values(m.objects).find((o) => o.kind === 'schema')!.id;
    m.objects.enum_ser = {
      id: 'enum_ser',
      kind: 'enum',
      parent: s,
      name: 'serial',
      values: ['a'],
      comment: null,
    };
    const cEnum = addColumn(m, t, { id: 'c_enum', name: 'en', type: '', typeRef: 'enum_ser' });
    const rEnum = expandMacro(m, 'alterColumn', { id: cEnum, type: 'serial[]' });
    expect(col(rEnum.m, cEnum)).toMatchObject({ type: '[]', typeRef: 'enum_ser' });

    // MacroErrors
    expect(
      expectMacroErr(m, 'alterColumn', { id: cPlain, type: 'serial', default: { expr: '1' } }),
    ).toMatchObject({ rawMessage: 'serial 列不能有默认值' });
    expect(
      expectMacroErr(m, 'alterColumn', { id: cPlain, type: 'serial', identity: { always: true } }),
    ).toMatchObject({ rawMessage: 'serial 列不能同时是 identity' });
    expect(expectMacroErr(m, 'alterColumn', { id: cPlain, type: 'serial', notNull: false })).toMatchObject({
      rawMessage: 'serial 列必须 NOT NULL',
    });
    expect(expectMacroErr(m, 'alterColumn', { id: cPlain, type: 'serial[]' })).toMatchObject({
      path: 'type',
      rawMessage: 'serial 不能用作数组类型',
    });
  });

  test('defineTable 与 alterColumn 的 description 包含 PG serial 说明与原有关键字', () => {
    expect(macros.defineTable.description).toContain('addForeignKey');
    expect(macros.defineTable.description).toContain('serial4 / serial8 / serial2');
    expect(macros.alterColumn.description).toContain('serial4 / serial8 / serial2');
    expect(macros.alterColumn.description).toContain('setColumnType');
  });
});
