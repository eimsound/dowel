// PG serial 的界面派生显示（ADR 0017 决定 6）：只看模型里的三个条件，导入的模型同样显示；
// 类型候选、切换 serial 写法、重新选普通整数类型时的提示（不动默认值与序列）。不依赖任何数据库。
import {
  addColumn,
  type Column,
  createSchema,
  createTable,
  emptyModel,
  type Model,
  normalizeType,
  runMutator,
  type Sequence,
} from '@dowel/core';
import { afterEach, describe, expect, test } from 'vitest';

import i18n from '../src/i18n.ts';
import {
  columnSerial,
  keepsSerialOnPlainInteger,
  PG_SERIAL_TYPE_OPTIONS,
  unwrapSerialLabel,
} from '../src/pg-serial.ts';

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

/** 与 Inspector 的 parseType 对普通类型的处理一致：显示写法换回 serial，再按方言规范化 */
const parseTypeInput = (m: Model, v: string) => ({
  type: normalizeType(m.dialect === 'pg' ? unwrapSerialLabel(v) : v, m.dialect),
  typeRef: null,
});

const col = (m: Model, id: string) => m.objects[id] as Column;
const seq = (m: Model, id: string) => m.objects[id] as Sequence;

/** 按 importSnapshot 的形状手工构造“从数据库导入”的模型：显式命名的序列 + ownedBy + { nextval } 默认值 */
const importedModel = (type: string, opts: { ownedBy?: 'self' | null; def?: 'nextval' | 'expr' } = {}) => {
  const m = emptyModel('pg');
  m.objects.s = { id: 's', kind: 'schema', name: 'public', comment: null };
  m.objects.t = {
    id: 't',
    kind: 'table',
    parent: 's',
    name: 'users',
    partitionBy: null,
    partitionOf: null,
    comment: null,
  };
  m.objects.q = {
    id: 'q',
    kind: 'sequence',
    parent: 's',
    name: 'legacy_users_id_seq',
    nameMode: 'explicit',
    ownedBy: opts.ownedBy === null ? null : 'c',
    options: { type: 'integer', increment: '1', min: null, max: null, start: null, cache: '1', cycle: false },
    comment: null,
  };
  m.objects.c = {
    id: 'c',
    kind: 'column',
    parent: 't',
    name: 'id',
    pos: 'a0',
    type,
    typeRef: null,
    notNull: true,
    notNullName: null,
    notNullNameMode: 'derived',
    default: opts.def === 'expr' ? { expr: "nextval('legacy_users_id_seq'::regclass)" } : { nextval: 'q' },
    identity: null,
    generated: null,
    collation: null,
    comment: null,
  };
  return m;
};

describe('serial 显示：三个条件派生，导入的模型同样显示', () => {
  test.each([
    ['integer', 'serial', 'serial (integer)'],
    ['bigint', 'bigserial', 'bigserial (bigint)'],
    ['smallint', 'smallserial', 'smallserial (smallint)'],
  ])('导入的 %s 列 + 归属序列 + nextval 默认值 → %s', (type, kind, label) => {
    const m = importedModel(type);
    expect(columnSerial(m, col(m, 'c'))).toEqual({ kind, label, sequenceId: 'q' });
  });

  test('缺任一条件都不显示 serial', () => {
    expect(columnSerial(importedModel('text'), col(importedModel('text'), 'c'))).toBeNull();
    const notOwned = importedModel('integer', { ownedBy: null });
    expect(columnSerial(notOwned, col(notOwned, 'c'))).toBeNull();
    const exprDefault = importedModel('integer', { def: 'expr' });
    expect(columnSerial(exprDefault, col(exprDefault, 'c'))).toBeNull();
    const noDefault = importedModel('integer');
    col(noDefault, 'c').default = null;
    expect(columnSerial(noDefault, col(noDefault, 'c'))).toBeNull();
  });

  test('不看 notNull：取消非空后仍显示 serial', () => {
    const m = importedModel('integer');
    col(m, 'c').notNull = false;
    expect(columnSerial(m, col(m, 'c'))?.label).toBe('serial (integer)');
  });

  test('非 PG 项目不显示 serial', () => {
    const m = { ...importedModel('integer'), dialect: 'mysql' as const };
    expect(columnSerial(m, col(m, 'c'))).toBeNull();
  });
});

describe('类型候选与输入解析', () => {
  test('候选依次是 serial (integer)、bigserial (bigint)、smallserial (smallint)', () => {
    expect(PG_SERIAL_TYPE_OPTIONS).toEqual([
      'serial (integer)',
      'bigserial (bigint)',
      'smallserial (smallint)',
    ]);
  });

  test('显示写法换回 serial 写法；不配对或不是显示写法的输入原样返回', () => {
    expect(unwrapSerialLabel('serial (integer)')).toBe('serial');
    expect(unwrapSerialLabel(' BIGSERIAL(BIGINT) ')).toBe('bigserial');
    expect(unwrapSerialLabel('smallserial (smallint)')).toBe('smallserial');
    expect(unwrapSerialLabel('serial (bigint)')).toBe('serial (bigint)');
    expect(unwrapSerialLabel('serial')).toBe('serial');
    expect(unwrapSerialLabel('"serial"')).toBe('"serial"');
    expect(unwrapSerialLabel('integer')).toBe('integer');
  });
});

describe('在类型框里选择 serial 写法（经 setColumnType 写入，核心展开）', () => {
  const base = () => {
    const m = emptyModel('pg');
    const s = createSchema(m, 'public');
    const t = createTable(m, s, 'users');
    const c = addColumn(m, t, { name: 'id', type: 'integer' });
    return { m, c };
  };
  const commit = (m: Model, c: string, v: string) => {
    const target = parseTypeInput(m, v);
    const hint = keepsSerialOnPlainInteger(m, col(m, c), target);
    const cur = col(m, c);
    if (target.type !== cur.type || target.typeRef !== cur.typeRef)
      runMutator(m, 'setColumnType', { id: c, ...target });
    return hint;
  };

  test('选 serial (integer) → 显示 serial (integer)，非空 + 归属序列 + nextval 默认值', () => {
    const { m, c } = base();
    expect(commit(m, c, 'serial (integer)')).toBe(false);
    const s = columnSerial(m, col(m, c))!;
    expect(s.label).toBe('serial (integer)');
    expect(col(m, c).type).toBe('integer');
    expect(col(m, c).notNull).toBe(true);
    expect(col(m, c).default).toEqual({ nextval: s.sequenceId });
    expect(seq(m, s.sequenceId).name).toBe('users_id_seq');
    expect(seq(m, s.sequenceId).ownedBy).toBe(c);
  });

  test('切换到 bigserial (bigint)：同一个序列改成 bigint，不新建序列', () => {
    const { m, c } = base();
    commit(m, c, 'serial (integer)');
    const first = columnSerial(m, col(m, c))!.sequenceId;
    expect(commit(m, c, 'bigserial (bigint)')).toBe(false);
    const s = columnSerial(m, col(m, c))!;
    expect(s.label).toBe('bigserial (bigint)');
    expect(s.sequenceId).toBe(first);
    expect(seq(m, first).options.type).toBe('bigint');
    expect(Object.values(m.objects).filter((o) => o.kind === 'sequence')).toHaveLength(1);
  });

  test('重新选普通 integer：给出提示，默认值与序列都不动', () => {
    const { m, c } = base();
    commit(m, c, 'serial (integer)');
    const before = structuredClone(m.objects);
    expect(commit(m, c, 'integer')).toBe(true);
    expect(m.objects).toEqual(before);
    expect(columnSerial(m, col(m, c))?.label).toBe('serial (integer)');
  });

  test('bigserial (bigint) 改成普通 integer：只改列类型，仍显示 serial (integer) 并提示', () => {
    const { m, c } = base();
    commit(m, c, 'bigserial (bigint)');
    const s = columnSerial(m, col(m, c))!;
    expect(commit(m, c, 'integer')).toBe(true);
    expect(col(m, c).type).toBe('integer');
    expect(col(m, c).default).toEqual({ nextval: s.sequenceId });
    expect(seq(m, s.sequenceId).options.type).toBe('bigint');
    expect(columnSerial(m, col(m, c))?.label).toBe('serial (integer)');
  });

  test('改成 text 不提示；清空默认值后不再是 serial', () => {
    const { m, c } = base();
    commit(m, c, 'serial (integer)');
    expect(commit(m, c, 'text')).toBe(false);
    expect(columnSerial(m, col(m, c))).toBeNull();
    const again = base();
    commit(again.m, again.c, 'serial (integer)');
    runMutator(again.m, 'setDefault', { id: again.c, default: null });
    expect(columnSerial(again.m, col(again.m, again.c))).toBeNull();
    expect(
      keepsSerialOnPlainInteger(again.m, col(again.m, again.c), { type: 'integer', typeRef: null }),
    ).toBe(false);
  });
});

test('提示文案：中英文都有，不带占位符', async () => {
  const zh = i18n.t('insp.serialKeptHint');
  expect(zh).toContain('清空默认值');
  await i18n.changeLanguage('en');
  const en = i18n.t('insp.serialKeptHint');
  expect(en).toContain('Clear the default');
  expect(en).not.toBe(zh);
  expect(`${zh}${en}`).not.toMatch(/\{\{/);
});
